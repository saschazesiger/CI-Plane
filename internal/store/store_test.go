package store

import (
	"errors"
	"reflect"
	"testing"

	"github.com/saschazesiger/CI-Plane/internal/model"
)

func open(t *testing.T, dir string) *Store {
	t.Helper()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestRoundTripAndReopen(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	job := model.Job{ID: 7, RunID: 1, AccountID: 2, RepoID: 3, Repo: "a/b", Name: "build", Labels: []string{"self-hosted", "ci-plane"},
		Size: "size-m", State: model.JobQueued, QueuedAt: 10, WaitingSince: 11}
	runner := model.Runner{ID: "r1", Name: "ci-plane-x-r1", WorkerID: 1, AccountID: 2, RepoID: 3, Repo: "a/b", JobID: 7,
		Labels: []string{"ci-plane", "size-m"}, Size: "size-m", CPUs: 4, MemMB: 8192, State: model.RunnerProvisioning, CreatedAt: 12}
	var worker model.Worker
	err := s.Tx(func(tx *Tx) error {
		if err := tx.SaveAccount(model.Account{ID: 2, Slug: "s", Owner: "a", OwnerType: "Organization", Enabled: true, CreatedAt: 1}); err != nil {
			return err
		}
		if err := tx.UpsertRepo(model.Repo{ID: 3, AccountID: 2, FullName: "a/b", Enabled: true, Private: true}); err != nil {
			return err
		}
		var err error
		if worker, err = tx.AddWorker(model.Worker{Name: "alpha", Host: "10.0.0.1", Port: 22, User: "ci-plane", Tier: 1, Enabled: true, CPUs: 8, MemMB: 1000}); err != nil {
			return err
		}
		if err := tx.SaveJob(job); err != nil {
			return err
		}
		if err := tx.SaveRunner(runner); err != nil {
			return err
		}
		set := model.DefaultSettings()
		set.DefaultSize = "size-s"
		return tx.SaveSettings(set)
	})
	if err != nil {
		t.Fatal(err)
	}
	s.Close()

	s = open(t, dir)
	err = s.View(func(tx *Tx) error {
		j, err := tx.Job(7)
		if err != nil {
			return err
		}
		job.UpdatedAt = j.UpdatedAt
		if !reflect.DeepEqual(j, job) {
			t.Errorf("job\n got %+v\nwant %+v", j, job)
		}
		r, err := tx.RunnerByName("ci-plane-x-r1")
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(r, runner) {
			t.Errorf("runner\n got %+v\nwant %+v", r, runner)
		}
		w, err := tx.Worker(worker.ID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(w, worker) || w.State != model.WorkerSetup {
			t.Errorf("worker\n got %+v\nwant %+v", w, worker)
		}
		set, err := tx.Settings()
		if err != nil || set.DefaultSize != "size-s" || len(set.Sizes) != 4 {
			t.Errorf("settings: %+v %v", set, err)
		}
		if _, err := tx.Job(8); !errors.Is(err, ErrNotFound) {
			t.Errorf("missing job: %v", err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestUpsertRepoKeepsTheUsersChoices(t *testing.T) {
	s := open(t, "")
	err := s.Tx(func(tx *Tx) error {
		if err := tx.UpsertRepo(model.Repo{ID: 1, AccountID: 1, FullName: "a/old", Enabled: true}); err != nil {
			return err
		}
		p, _ := tx.Repo(1)
		p.Enabled, p.MaxParallel = false, 3
		if err := tx.SaveRepo(p); err != nil {
			return err
		}
		if err := tx.UpsertRepo(model.Repo{ID: 1, AccountID: 1, FullName: "a/new", Enabled: true, Private: true}); err != nil {
			return err
		}
		p, _ = tx.Repo(1)
		if p.FullName != "a/new" || !p.Private || p.Enabled || p.MaxParallel != 3 {
			t.Errorf("repo: %+v", p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestTxRollsBack(t *testing.T) {
	s := open(t, "")
	boom := errors.New("boom")
	err := s.Tx(func(tx *Tx) error {
		if err := tx.SaveJob(model.Job{ID: 1, State: model.JobQueued}); err != nil {
			return err
		}
		return boom
	})
	if !errors.Is(err, boom) {
		t.Fatal(err)
	}
	_ = s.View(func(tx *Tx) error {
		if _, err := tx.Job(1); !errors.Is(err, ErrNotFound) {
			t.Errorf("job survived a rollback: %v", err)
		}
		return nil
	})
}

func TestListJobsEventsAndPrune(t *testing.T) {
	s := open(t, "")
	clock := int64(1000)
	s.SetClock(func() int64 { return clock })
	err := s.Tx(func(tx *Tx) error {
		for i := int64(1); i <= 5; i++ {
			state := model.JobCompleted
			if i > 3 {
				state = model.JobQueued
			}
			if err := tx.SaveJob(model.Job{ID: i, Repo: "a/b", Name: "job", State: state, QueuedAt: i, StartedAt: i + 10*i}); err != nil {
				return err
			}
			if _, err := tx.AddEvent(model.Event{Kind: "k", Message: "m", JobID: i, Level: model.LevelWarn}); err != nil {
				return err
			}
		}
		jobs, total, err := tx.ListJobs(JobFilter{States: []string{model.JobCompleted}, Limit: 2})
		if err != nil || total != 3 || len(jobs) != 2 || jobs[0].ID != 3 {
			t.Errorf("list: total %d jobs %+v err %v", total, jobs, err)
		}
		if _, total, _ := tx.ListJobs(JobFilter{Search: "a/b"}); total != 5 {
			t.Errorf("search: %d", total)
		}
		counts, _ := tx.JobCounts()
		if counts[model.JobQueued] != 2 || counts[model.JobCompleted] != 3 {
			t.Errorf("counts: %v", counts)
		}
		if med, n, _ := tx.WaitStats(0); n != 5 || med != 30 {
			t.Errorf("wait: median %d of %d", med, n)
		}
		if evs, _ := tx.Events(EventFilter{JobID: 2}); len(evs) != 1 || evs[0].At != 1000 {
			t.Errorf("events: %+v", evs)
		}
		clock = 5000
		if err := tx.SaveJob(model.Job{ID: 5, State: model.JobCompleted}); err != nil {
			return err
		}
		if err := tx.Prune(2000); err != nil {
			return err
		}
		// Finished before the cut: gone. Open or finished later: kept.
		for id, want := range map[int64]bool{1: false, 2: false, 3: false, 4: true, 5: true} {
			_, err := tx.Job(id)
			if (err == nil) != want {
				t.Errorf("job %d after prune: %v", id, err)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

// A database of an earlier version gets the columns added since, and its
// workers the default of each.
func TestOpenUpgradesAnOlderDatabase(t *testing.T) {
	dir := t.TempDir()
	st, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var w model.Worker
	if err := st.Tx(func(tx *Tx) error {
		w, err = tx.AddWorker(model.Worker{Name: "alpha", Host: "10.0.0.1", Port: 22, User: "ci-plane", Tier: 1, Enabled: true, CPUPriority: model.PriorityLow})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	// Back to the table as it was before the column existed.
	if _, err := st.db.Exec(`ALTER TABLE workers DROP COLUMN cpu_priority`); err != nil {
		t.Fatal(err)
	}
	st.Close()
	for i := 0; i < 2; i++ { // the second time there is nothing to add
		if st, err = Open(dir); err != nil {
			t.Fatal(err)
		}
		if err := st.View(func(tx *Tx) error {
			got, err := tx.Worker(w.ID)
			if err == nil && got.CPUPriority != model.PriorityNormal {
				t.Fatalf("priority after the upgrade: %q", got.CPUPriority)
			}
			return err
		}); err != nil {
			t.Fatal(err)
		}
		st.Close()
	}
}

// A repository that becomes public stops taking jobs until it is switched
// on again; every other choice of the user survives a refresh.
func TestRepoThatBecomesPublicIsSwitchedOff(t *testing.T) {
	st, err := Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	get := func() model.Repo {
		var p model.Repo
		if err := st.View(func(tx *Tx) error {
			var err error
			p, err = tx.Repo(1)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		return p
	}
	up := func(private bool) {
		if err := st.Tx(func(tx *Tx) error { return tx.UpsertRepo(model.NewRepo(1, 1, "a/b", private)) }); err != nil {
			t.Fatal(err)
		}
	}
	up(true)
	if !get().Enabled {
		t.Fatal("a new private repository is off")
	}
	up(false)
	if p := get(); p.Enabled || p.Private {
		t.Fatalf("after it became public: %+v", p)
	}
	// Switched on by the user: stays on, public or not.
	if err := st.Tx(func(tx *Tx) error { p := get2(tx); p.Enabled = true; return tx.SaveRepo(p) }); err != nil {
		t.Fatal(err)
	}
	up(false)
	if !get().Enabled {
		t.Fatal("the user's choice for a public repository was undone")
	}
	if p := model.NewRepo(2, 1, "a/c", false); p.Enabled {
		t.Fatal("a new public repository is on")
	}
}

func get2(tx *Tx) model.Repo { p, _ := tx.Repo(1); return p }
