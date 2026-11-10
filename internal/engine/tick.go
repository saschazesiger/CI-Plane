package engine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// snapshot is the state one pass works on.
type snapshot struct {
	now      int64
	set      model.Settings
	accounts map[int64]model.Account
	repos    map[int64]model.Repo
	workers  []model.Worker
	worker   map[int64]model.Worker
	status   map[int64]WorkerStatus
	runners  []model.Runner
	jobs     []model.Job
	job      map[int64]model.Job
}

func (e *Engine) load() (*snapshot, error) {
	s := &snapshot{now: e.now(), accounts: map[int64]model.Account{}, repos: map[int64]model.Repo{},
		worker: map[int64]model.Worker{}, status: map[int64]WorkerStatus{}, job: map[int64]model.Job{}}
	err := e.st.View(func(tx *store.Tx) error {
		var err error
		if s.set, err = tx.Settings(); err != nil {
			return err
		}
		accs, err := tx.Accounts()
		if err != nil {
			return err
		}
		for _, a := range accs {
			s.accounts[a.ID] = a
		}
		repos, err := tx.Repos(0)
		if err != nil {
			return err
		}
		for _, r := range repos {
			s.repos[r.ID] = r
		}
		if s.workers, err = tx.Workers(); err != nil {
			return err
		}
		if s.runners, err = tx.ActiveRunners(); err != nil {
			return err
		}
		s.jobs, err = tx.OpenJobs()
		return err
	})
	if err != nil {
		return nil, err
	}
	for _, w := range s.workers {
		s.worker[w.ID] = w
		s.status[w.ID] = e.fleet.Status(w.ID)
	}
	for _, j := range s.jobs {
		s.job[j.ID] = j
	}
	return s, nil
}

// Tick makes one pass. Slow work (SSH, GitHub) runs in the background; Tick
// itself only reads and writes the store.
func (e *Engine) Tick(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	s, err := e.load()
	if err != nil {
		e.logf("engine: load state: %v", err)
		return
	}
	dirty := e.workerStates(ctx, s)
	dirty = e.superviseRunners(ctx, s) || dirty
	e.watchContainers(ctx, s)
	if dirty {
		// Supervision changed runners and jobs; schedule on fresh state.
		if s, err = e.load(); err != nil {
			e.logf("engine: load state: %v", err)
			return
		}
	}
	dirty = e.schedule(s) || dirty
	e.reconcileForge(ctx, s)
	e.housekeeping(s)
	if dirty {
		e.changed()
		e.Kick()
	}
}

// --- workers ---------------------------------------------------------------

// workerStates derives the state of every worker from its live status.
func (e *Engine) workerStates(ctx context.Context, s *snapshot) bool {
	dirty := false
	for i, w := range s.workers {
		st := s.status[w.ID]
		state, reason := w.State, w.StateReason
		switch {
		case !st.Connected && w.LastSeenAt == 0:
			state, reason = model.WorkerSetup, st.Error
		case !st.Connected:
			state, reason = model.WorkerUnreachable, st.Error
		case w.Failures >= s.set.FailureThreshold:
			state = model.WorkerUnhealthy
			reason = fmt.Sprintf("%d runners in a row failed to start; checking again every 30 seconds", w.Failures)
		case st.At > 0 && st.DiskFreeMB < s.set.MinDiskFreeMB:
			state = model.WorkerDiskFull
			reason = fmt.Sprintf("%.1f GB of disk free, %.1f GB are needed", float64(st.DiskFreeMB)/1024, float64(s.set.MinDiskFreeMB)/1024)
		default:
			state, reason = model.WorkerOnline, ""
		}
		if state == model.WorkerUnhealthy {
			e.probe(ctx, w)
		}
		e.mu.Lock()
		stale := st.Connected && s.now-e.seen[w.ID] > 60_000
		e.mu.Unlock()
		if state == w.State && reason == w.StateReason && !stale {
			continue
		}
		was := w.State
		err := e.st.Tx(func(tx *store.Tx) error {
			cur, err := tx.Worker(w.ID)
			if err != nil {
				return err
			}
			cur.State, cur.StateReason = state, reason
			if st.Connected {
				cur.LastSeenAt = s.now
			}
			if state != was {
				level := model.LevelInfo
				if state != model.WorkerOnline {
					level = model.LevelWarn
				}
				msg := "Worker is " + state
				if reason != "" {
					msg += ": " + reason
				}
				event(tx, level, "worker."+state, msg, 0, "", w.ID)
			}
			w = cur
			return tx.SaveWorker(cur)
		})
		if err != nil {
			e.logf("engine: save worker %s: %v", w.Name, err)
			continue
		}
		e.mu.Lock()
		e.seen[w.ID] = s.now
		e.mu.Unlock()
		s.workers[i], s.worker[w.ID] = w, w
		if state != was {
			dirty = true
		}
	}
	return dirty
}

// probe tests an unhealthy worker; success takes it back into rotation.
func (e *Engine) probe(ctx context.Context, w model.Worker) {
	e.spawn(ctx, fmt.Sprintf("probe:%d", w.ID), 2*time.Minute, func(ctx context.Context) time.Duration {
		if err := e.fleet.Probe(ctx, w); err != nil {
			return 30 * time.Second
		}
		_ = e.st.Tx(func(tx *store.Tx) error {
			cur, err := tx.Worker(w.ID)
			if err != nil {
				return err
			}
			cur.Failures = 0
			event(tx, model.LevelInfo, "worker.recovered", "A test container ran; the worker takes jobs again", 0, "", w.ID)
			return tx.SaveWorker(cur)
		})
		e.changed()
		return 30 * time.Second
	})
}

// --- runners ---------------------------------------------------------------

// superviseRunners applies timeouts and starts the next step of each runner.
func (e *Engine) superviseRunners(ctx context.Context, s *snapshot) bool {
	dirty := false
	sec := func(n int) int64 { return int64(n) * 1000 }
	// A job waits for room: spare runners give up their slot at once.
	e.mu.Lock()
	pressure := e.pressure
	e.mu.Unlock()
	for _, r := range s.runners {
		r := r
		switch r.State {
		case model.RunnerProvisioning:
			e.spawn(ctx, r.ID, 10*time.Minute, func(ctx context.Context) time.Duration { return e.provision(ctx, r) })

		case model.RunnerStarting:
			if s.now-r.StartedAt > sec(s.set.StartTimeoutSec) {
				e.failStart(r.ID, fmt.Sprintf("the runner did not connect to GitHub within %d seconds", s.set.StartTimeoutSec), true)
				dirty = true
			} else if r.JobID == 0 && (pressure || s.now-r.SpareAt > sec(s.set.SpareGraceSec)) {
				e.retire(ctx, r, "no job is waiting for it")
			} else {
				e.spawn(ctx, r.ID, time.Minute, func(ctx context.Context) time.Duration { return e.checkOnline(ctx, r) })
			}

		case model.RunnerIdle:
			switch {
			case r.JobID == 0 && (pressure || s.now-r.SpareAt > sec(s.set.SpareGraceSec)):
				e.retire(ctx, r, "no job is waiting for it")
			case s.now-r.OnlineAt > sec(s.set.IdleTimeoutSec):
				e.retire(ctx, r, fmt.Sprintf("no job arrived within %d minutes", s.set.IdleTimeoutSec/60))
			}

		case model.RunnerBusy:
			job, open := s.job[r.JobID]
			switch {
			case !open || job.State == model.JobCompleted:
				// The job is over; the container normally exits by itself.
				done := e.jobCompletedAt(r.JobID)
				if done == 0 || s.now-done > 30_000 {
					e.toCleaning(r.ID, "", "The job is over; removing the runner")
					dirty = true
				}
			case s.now-r.BusyAt > sec(s.set.JobTimeoutSec):
				e.toCleaning(r.ID, fmt.Sprintf("the job ran longer than the limit of %d hours", s.set.JobTimeoutSec/3600),
					"Job exceeded the time limit; removing the runner")
				dirty = true
			}

		case model.RunnerCleaning:
			e.spawn(ctx, r.ID, 5*time.Minute, func(ctx context.Context) time.Duration { return e.clean(ctx, r) })
		}
	}
	return dirty
}

func (e *Engine) jobCompletedAt(id int64) int64 {
	var at int64
	_ = e.st.View(func(tx *store.Tx) error {
		j, err := tx.Job(id)
		if err == nil {
			at = j.CompletedAt
		}
		return nil
	})
	return at
}

// provision registers the runner at GitHub and starts it on its worker.
func (e *Engine) provision(ctx context.Context, r model.Runner) time.Duration {
	var acc model.Account
	var w model.Worker
	var set model.Settings
	err := e.st.View(func(tx *store.Tx) error {
		var err error
		if set, err = tx.Settings(); err != nil {
			return err
		}
		if acc, err = tx.Account(r.AccountID); err != nil {
			return fmt.Errorf("account: %w", err)
		}
		if w, err = tx.Worker(r.WorkerID); err != nil {
			return fmt.Errorf("worker: %w", err)
		}
		return nil
	})
	if errors.Is(err, store.ErrNotFound) {
		e.failStart(r.ID, "its worker or account was removed", false)
		return 0
	}
	if err != nil {
		return 5 * time.Second
	}
	target := targetOf(acc, r.Repo)

	reg, err := e.forge.CreateRunner(ctx, target, r.Name, r.Labels)
	if errors.Is(err, ErrRunnerExists) {
		// Left over from a start that was interrupted: its configuration is
		// lost, so register again.
		if err = e.deleteByName(ctx, target, r.Name); err == nil {
			reg, err = e.forge.CreateRunner(ctx, target, r.Name, r.Labels)
		}
	}
	if err != nil {
		e.failStart(r.ID, "GitHub did not register the runner: "+err.Error(), false)
		return 0
	}
	if err := e.st.Tx(func(tx *store.Tx) error {
		cur, err := tx.Runner(r.ID)
		if err != nil {
			return err
		}
		cur.ForgeID = reg.ID
		return tx.SaveRunner(cur)
	}); err != nil {
		e.failStart(r.ID, "could not store the registration: "+err.Error(), false)
		return 0
	}

	spec := RunnerSpec{Name: r.Name, JITConfig: reg.JITConfig, Image: set.RunnerImage, DindImage: set.DindImage, CPUs: r.CPUs, MemMB: r.MemMB}
	if err := e.fleet.Start(ctx, w, spec); err != nil {
		e.failStart(r.ID, "the worker could not start the runner: "+err.Error(), true)
		return 0
	}
	_ = e.st.Tx(func(tx *store.Tx) error {
		cur, err := tx.Runner(r.ID)
		if err != nil || cur.State != model.RunnerProvisioning {
			return err
		}
		cur.State, cur.StartedAt = model.RunnerStarting, e.now()
		event(tx, model.LevelInfo, "runner.started", "Runner "+cur.Name+" started on "+w.Name, cur.JobID, cur.ID, cur.WorkerID)
		return tx.SaveRunner(cur)
	})
	e.changed()
	return 0
}

func (e *Engine) deleteByName(ctx context.Context, t Target, name string) error {
	list, err := e.forge.ListRunners(ctx, t)
	if err != nil {
		return err
	}
	for _, fr := range list {
		if fr.Name == name {
			return e.forge.DeleteRunner(ctx, t, fr.ID)
		}
	}
	return nil
}

// checkOnline moves a starting runner to idle once GitHub sees it.
func (e *Engine) checkOnline(ctx context.Context, r model.Runner) time.Duration {
	var acc model.Account
	if err := e.st.View(func(tx *store.Tx) error {
		var err error
		acc, err = tx.Account(r.AccountID)
		return err
	}); err != nil {
		return 5 * time.Second
	}
	list, err := e.forge.ListRunners(ctx, targetOf(acc, r.Repo))
	if err != nil {
		return 5 * time.Second
	}
	for _, fr := range list {
		if fr.ID != r.ForgeID || !fr.Online {
			continue
		}
		_ = e.st.Tx(func(tx *store.Tx) error {
			cur, err := tx.Runner(r.ID)
			if err != nil || cur.State != model.RunnerStarting {
				return err
			}
			cur.State, cur.OnlineAt = model.RunnerIdle, e.now()
			event(tx, model.LevelInfo, "runner.online", "Runner "+cur.Name+" is online and waits for the job", cur.JobID, cur.ID, cur.WorkerID)
			return tx.SaveRunner(cur)
		})
		e.changed()
		return 0
	}
	return 3 * time.Second
}

// failStart gives up a runner that did not start and puts its job back in
// the queue. blame counts the failure against the worker.
func (e *Engine) failStart(runnerID, reason string, blame bool) {
	err := e.st.Tx(func(tx *store.Tx) error {
		r, err := tx.Runner(runnerID)
		if err != nil {
			return err
		}
		if r.State != model.RunnerProvisioning && r.State != model.RunnerStarting {
			return nil
		}
		r.State, r.Failed, r.Error, r.EndedAt = model.RunnerCleaning, true, reason, e.now()
		if err := tx.SaveRunner(r); err != nil {
			return err
		}
		if blame {
			if w, err := tx.Worker(r.WorkerID); err == nil {
				w.Failures++
				if err := tx.SaveWorker(w); err != nil {
					return err
				}
			}
		}
		job, err := tx.Job(r.JobID)
		if err != nil || job.State != model.JobAssigned || job.RunnerID != r.ID {
			event(tx, model.LevelError, "runner.failed", "Start failed: "+reason, 0, r.ID, r.WorkerID)
			return nil
		}
		job.State, job.RunnerID = model.JobQueued, ""
		job.Attempts++
		wait := backoff(job.Attempts)
		job.NextTryAt = e.now() + wait.Milliseconds()
		if blame {
			job.AvoidWorker = r.WorkerID
		}
		event(tx, model.LevelError, "runner.failed",
			fmt.Sprintf("Attempt %d failed: %s. Trying again in %d s", job.Attempts, reason, int(wait.Seconds())), job.ID, r.ID, r.WorkerID)
		return tx.SaveJob(job)
	})
	if err != nil {
		e.logf("engine: fail start of %s: %v", runnerID, err)
	}
	e.changed()
}

// toCleaning ends a runner normally (errMsg empty) or because of a problem.
func (e *Engine) toCleaning(runnerID, errMsg, note string) {
	err := e.st.Tx(func(tx *store.Tx) error {
		r, err := tx.Runner(runnerID)
		if err != nil || r.State == model.RunnerCleaning || r.State == model.RunnerRemoved {
			return err
		}
		r.State, r.EndedAt = model.RunnerCleaning, e.now()
		level := model.LevelInfo
		if errMsg != "" {
			r.Error, level = errMsg, model.LevelWarn
		}
		// A job that was still waiting for this runner needs a new one.
		if job, err := tx.Job(r.JobID); err == nil && job.State == model.JobAssigned && job.RunnerID == r.ID {
			job.State, job.RunnerID = model.JobQueued, ""
			if err := tx.SaveJob(job); err != nil {
				return err
			}
		}
		event(tx, level, "runner.ending", note, r.JobID, r.ID, r.WorkerID)
		return tx.SaveRunner(r)
	})
	if err != nil {
		e.logf("engine: end runner %s: %v", runnerID, err)
	}
	e.changed()
}

// retire removes a waiting runner that is not needed. The registration is
// deleted first: GitHub refuses that when the runner has just taken a job,
// and then the runner stays.
func (e *Engine) retire(ctx context.Context, r model.Runner, why string) {
	e.spawn(ctx, r.ID, time.Minute, func(ctx context.Context) time.Duration {
		if r.ForgeID != 0 {
			var acc model.Account
			if err := e.st.View(func(tx *store.Tx) error {
				var err error
				acc, err = tx.Account(r.AccountID)
				return err
			}); err == nil {
				err := e.forge.DeleteRunner(ctx, targetOf(acc, r.Repo), r.ForgeID)
				if errors.Is(err, ErrRunnerBusy) {
					return 15 * time.Second // GitHub will tell us which job it took
				}
				if err != nil {
					return 10 * time.Second
				}
			}
		}
		// The registration is gone, so the runner is useless now, even if a
		// job was designated to it meanwhile (toCleaning queues that again).
		e.toCleaning(r.ID, "", "Removing the runner: "+why)
		return 0
	})
}

// clean removes the runner from its worker and from GitHub.
func (e *Engine) clean(ctx context.Context, r model.Runner) time.Duration {
	var acc model.Account
	var w model.Worker
	haveAcc, haveWorker := false, false
	_ = e.st.View(func(tx *store.Tx) error {
		var err error
		if acc, err = tx.Account(r.AccountID); err == nil {
			haveAcc = true
		}
		if w, err = tx.Worker(r.WorkerID); err == nil {
			haveWorker = true
		}
		return nil
	})
	retry := func(what string, err error) time.Duration {
		e.mu.Lock()
		e.fails[r.ID]++
		n := e.fails[r.ID]
		e.mu.Unlock()
		if n == 3 {
			_ = e.st.Tx(func(tx *store.Tx) error {
				event(tx, model.LevelWarn, "runner.cleanup", "Cleanup is delayed ("+what+"): "+err.Error()+". It is retried until it succeeds", r.JobID, r.ID, r.WorkerID)
				return nil
			})
		}
		d := backoff(n)
		if d > time.Minute {
			d = time.Minute
		}
		return d
	}
	if haveWorker {
		if err := e.fleet.Remove(ctx, w, r.Name); err != nil {
			return retry("worker", err)
		}
	}
	if haveAcc && r.ForgeID != 0 {
		err := e.forge.DeleteRunner(ctx, targetOf(acc, r.Repo), r.ForgeID)
		// Busy: GitHub has not noticed yet that the runner is gone. It drops
		// the registration itself; the sweep in reconcile is the backstop.
		if err != nil && !errors.Is(err, ErrRunnerBusy) {
			return retry("GitHub", err)
		}
	}
	err := e.st.Tx(func(tx *store.Tx) error {
		cur, err := tx.Runner(r.ID)
		if err != nil {
			return err
		}
		cur.State, cur.RemovedAt = model.RunnerRemoved, e.now()
		event(tx, model.LevelInfo, "runner.removed", "Runner "+cur.Name+" and everything it created were removed", cur.JobID, cur.ID, cur.WorkerID)
		return tx.SaveRunner(cur)
	})
	if err != nil {
		return 5 * time.Second
	}
	e.forget(r.ID)
	e.changed()
	return 0
}

// --- containers ------------------------------------------------------------

// watchContainers looks at the containers of each worker: a runner whose
// container is gone has ended, and a container without a runner is removed.
func (e *Engine) watchContainers(ctx context.Context, s *snapshot) {
	for _, w := range s.workers {
		w := w
		if !s.status[w.ID].Connected {
			continue
		}
		e.spawn(ctx, fmt.Sprintf("list:%d", w.ID), time.Minute, func(ctx context.Context) time.Duration {
			started := e.now()
			list, err := e.fleet.List(ctx, w)
			if err != nil {
				return 10 * time.Second
			}
			e.compareContainers(ctx, w, list, started)
			return 5 * time.Second
		})
	}
}

func (e *Engine) compareContainers(ctx context.Context, w model.Worker, list []Container, listedAt int64) {
	have := map[string]Container{}
	for _, c := range list {
		have[c.Runner] = c
	}
	var runners []model.Runner
	if err := e.st.View(func(tx *store.Tx) error {
		var err error
		runners, err = tx.ActiveRunners()
		return err
	}); err != nil {
		return
	}
	known := map[string]bool{}
	for _, r := range runners {
		if r.WorkerID != w.ID {
			continue
		}
		known[r.Name] = true
		if r.State != model.RunnerStarting && r.State != model.RunnerIdle && r.State != model.RunnerBusy {
			continue
		}
		c, ok := have[r.Name]
		if ok && c.Running {
			e.mu.Lock()
			delete(e.absent, r.ID)
			e.mu.Unlock()
			continue
		}
		if r.StartedAt >= listedAt {
			continue // started after this listing
		}
		// Two listings in a row must agree before a runner is given up.
		e.mu.Lock()
		e.absent[r.ID]++
		n := e.absent[r.ID]
		e.mu.Unlock()
		if n < 2 {
			continue
		}
		what := "its container is gone"
		if ok {
			what = fmt.Sprintf("its container exited with code %d", c.ExitCode)
		}
		// A runner exits after its one job. If the webhooks about that job
		// were late or lost, GitHub knows more than the store: ask first.
		e.refreshAccount(ctx, r.AccountID)
		_ = e.st.View(func(tx *store.Tx) error {
			if cur, err := tx.Runner(r.ID); err == nil {
				r = cur
			}
			return nil
		})
		switch r.State {
		case model.RunnerStarting:
			e.failStart(r.ID, "the runner stopped before it was online: "+what, true)
		case model.RunnerIdle:
			e.toCleaning(r.ID, "the runner stopped without a job: "+what, "Runner stopped without taking a job")
		case model.RunnerBusy:
			e.toCleaning(r.ID, "", "The runner finished its job and exited")
		}
	}
	// Containers nobody knows: left over from a lost database or a bug.
	for name := range have {
		if known[name] {
			continue
		}
		name := name
		e.spawn(ctx, "orphan:"+name, 5*time.Minute, func(ctx context.Context) time.Duration {
			// Decide again on fresh state: a runner may have been created meanwhile.
			fresh := false
			_ = e.st.View(func(tx *store.Tx) error {
				if r, err := tx.RunnerByName(name); err == nil && r.Active() {
					fresh = true
				}
				return nil
			})
			if fresh {
				return 0
			}
			if err := e.fleet.Remove(ctx, w, name); err != nil {
				return time.Minute
			}
			_ = e.st.Tx(func(tx *store.Tx) error {
				event(tx, model.LevelWarn, "worker.orphan", "Removed leftover containers of "+name+", which no runner belongs to", 0, "", w.ID)
				return nil
			})
			return 0
		})
	}
}
