package engine_test

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// newPoolRig is a rig with the two sizes of today and the pools run by the
// simulated world.
func newPoolRig(t *testing.T) *rig {
	r := newRig(t)
	r.settings(func(s *model.Settings) {
		def := model.DefaultSettings()
		s.Sizes, s.DefaultSize = def.Sizes, def.DefaultSize
	})
	r.eng.Relay = r.world
	return r
}

// pool adds a pool of GitHub-hosted runners in the given tier.
func (r *rig) pool(name string, tier int, change ...func(*model.Pool)) model.Pool {
	r.t.Helper()
	p := model.Pool{Name: name, Kind: model.PoolGitHub, AccountID: 77, Repo: "acme/relay", Tier: tier, Enabled: true, Max: 5, Standard: "ubuntu-latest"}
	for _, c := range change {
		c(&p)
	}
	must(r.t, r.st.Tx(func(tx *store.Tx) error {
		var err error
		p, err = tx.AddPool(p)
		return err
	}))
	r.world.Connect(p.WorkerID())
	return p
}

func (r *rig) poolRow(id int64) model.Pool {
	r.t.Helper()
	var p model.Pool
	must(r.t, r.st.View(func(tx *store.Tx) error {
		var err error
		p, err = tx.Pool(id)
		return err
	}))
	return p
}

func (r *rig) settings(change func(*model.Settings)) model.Settings {
	r.t.Helper()
	var set model.Settings
	must(r.t, r.st.Tx(func(tx *store.Tx) error {
		var err error
		if set, err = tx.Settings(); err != nil {
			return err
		}
		if change != nil {
			change(&set)
			return tx.SaveSettings(set)
		}
		return nil
	}))
	return set
}

// on returns the runners that are on a pool and not gone.
func (r *rig) on(p model.Pool) []model.Runner {
	var out []model.Runner
	for _, x := range r.active() {
		if x.WorkerID == p.WorkerID() {
			out = append(out, x)
		}
	}
	return out
}

func (r *rig) events(kind string) []string {
	var out []string
	_ = r.st.View(func(tx *store.Tx) error {
		evs, _ := tx.Events(store.EventFilter{})
		for _, e := range evs {
			if e.Kind == kind {
				out = append(out, e.Message)
			}
		}
		return nil
	})
	return out
}

func TestPoolTakesAJobThatWaitedLongEnough(t *testing.T) {
	r := newPoolRig(t)
	w := r.worker("alpha", 1)
	r.world.SetLoad(w.ID, 100) // busy with other work
	p := r.pool("GitHub", 9, func(p *model.Pool) { p.AfterSec = 180 })
	id := r.queue("acme/api", 2)

	r.pass(2)
	j := r.job(id)
	if j.State != model.JobQueued || !strings.Contains(j.Reason, "it goes to GitHub once it has waited 3 minutes") {
		t.Fatalf("before the wait: %s %q", j.State, j.Reason)
	}
	r.advance(120)
	r.pass(2)
	if j = r.job(id); j.State != model.JobQueued {
		t.Fatalf("went to the pool before the wait was over: %s", j.State)
	}
	r.advance(61)
	r.pass(1)
	if j = r.job(id); j.State != model.JobAssigned {
		t.Fatalf("after the wait: %s %q", j.State, j.Reason)
	}
	x := r.runner(j.RunnerID)
	if x.WorkerID != p.WorkerID() || !strings.Contains(x.Name, "-github-") {
		t.Fatalf("runner: %+v", x)
	}
	if got := strings.Join(x.Labels, ","); got != "self-hosted,linux,x64,ci-plane,standard,size-s,size-m" {
		t.Fatalf("labels: %s", got)
	}
	r.pass(1)
	if spec := r.world.Specs[x.Name]; spec.Machine != "ubuntu-latest" || spec.Repo != "acme/relay" || spec.RelayAccount != 77 || spec.MemMB != 0 {
		t.Fatalf("spec: %+v", spec)
	}

	r.run(10)
	if j = r.job(id); j.State != model.JobCompleted || j.Conclusion != "success" {
		t.Fatalf("job: %s %s\n%s", j.State, j.Conclusion, r.timeline(id))
	}
	if x = r.runner(x.ID); x.State != model.RunnerRemoved || x.Failed {
		t.Fatalf("runner: %+v\n%s", x, r.timeline(id))
	}
	if c := r.world.Containers(p.WorkerID()); len(c) != 0 {
		t.Errorf("runs left: %v", c)
	}
	r.clean(w)
	if tl := r.timeline(id); !strings.Contains(tl, "Pool GitHub chosen (tier 9") || !strings.Contains(tl, "ubuntu-latest machine through acme/relay") {
		t.Errorf("timeline does not say where the job went:\n%s", tl)
	}
	// Its time counts against the month, in whole minutes.
	if got := r.poolRow(p.ID); got.UsedSec != 60 || got.Month == "" {
		t.Errorf("used: %+v", got)
	}
}

func TestTiersOrderWorkersAndPools(t *testing.T) {
	r := newPoolRig(t)
	first := r.pool("Free minutes", 1, func(p *model.Pool) { p.Max = 1 })
	w := r.worker("alpha", 2)
	same := r.pool("Same tier", 2)
	last := r.pool("Overflow", 3)

	a := r.queue("acme/api", 50)
	b := r.queue("acme/api", 50)
	r.pass(1)
	// The pool of the lowest tier first, although the worker has room.
	if x := r.runner(r.job(a).RunnerID); x.WorkerID != first.WorkerID() {
		t.Fatalf("first job: %+v", x)
	}
	// It is full: the worker next. Inside a tier the worker goes first.
	if x := r.runner(r.job(b).RunnerID); x.WorkerID != w.ID {
		t.Fatalf("second job: %+v", x)
	}
	// The worker is busy with other work: the pool of its tier, then the last.
	r.world.SetLoad(w.ID, 100)
	c := r.queue("acme/api", 50)
	r.pass(1)
	if x := r.runner(r.job(c).RunnerID); x.WorkerID != same.WorkerID() {
		t.Fatalf("third job: %+v", x)
	}
	must(t, r.st.Tx(func(tx *store.Tx) error {
		p, _ := tx.Pool(same.ID)
		p.Enabled = false
		return tx.SavePool(p)
	}))
	d := r.queue("acme/api", 50)
	r.pass(1)
	if x := r.runner(r.job(d).RunnerID); x.WorkerID != last.WorkerID() {
		t.Fatalf("fourth job: %+v", x)
	}
	// One listing follows the runs of all pools.
	r.run(60)
	for _, id := range []int64{a, b, c, d} {
		if j := r.job(id); j.State != model.JobCompleted {
			t.Fatalf("job %d: %s\n%s", id, j.State, r.timeline(id))
		}
	}
	if n := len(r.active()); n != 0 {
		t.Fatalf("%d runners left", n)
	}
}

func TestPoolLimitAndLargeJobs(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1, func(p *model.Pool) { p.Max = 1 })
	a := r.queue("acme/api", 3)
	b := r.queue("acme/api", 3)
	large := r.queue("acme/web", 3, "large")
	old := r.queue("acme/web", 3, "size-xl") // a label of earlier versions that means large
	r.pass(2)

	if j := r.job(a); j.State != model.JobAssigned {
		t.Fatalf("first job: %s %q", j.State, j.Reason)
	}
	if j := r.job(b); j.State != model.JobQueued || !strings.Contains(j.Reason, "the 1 runner of GitHub is in use") {
		t.Fatalf("second job: %s %q", j.State, j.Reason)
	}
	// The pool has no machine for large jobs.
	for _, id := range []int64{large, old} {
		if j := r.job(id); j.State != model.JobQueued || j.Size != model.SizeLarge || strings.Contains(j.Reason, "GitHub") {
			t.Fatalf("large job: %s %s %q", j.State, j.Size, j.Reason)
		}
	}
	r.run(20)
	if r.job(a).State != model.JobCompleted || r.job(b).State != model.JobCompleted {
		t.Fatalf("jobs: %s %s\n%s", r.job(a).State, r.job(b).State, r.timeline(b))
	}
	// With a machine for them, large jobs go there, on that machine.
	must(t, r.st.Tx(func(tx *store.Tx) error {
		cur, _ := tx.Pool(p.ID)
		cur.Large, cur.Max = "ubuntu-latest-8-cores", 2
		return tx.SavePool(cur)
	}))
	r.pass(2)
	for _, id := range []int64{large, old} {
		j := r.job(id)
		if j.State != model.JobAssigned {
			t.Fatalf("large job with a machine: %s %q", j.State, j.Reason)
		}
		if spec := r.world.Specs[r.runner(j.RunnerID).Name]; spec.Machine != "ubuntu-latest-8-cores" {
			t.Fatalf("machine: %+v", spec)
		}
	}
}

func TestPoolPausesLongerAfterEveryFailedStart(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1)
	r.world.FailStart[p.WorkerID()] = 100 // the workflow does not run
	id := r.queue("acme/api", 1)
	tried := func() int { return 100 - r.world.FailStart[p.WorkerID()] }

	r.pass(3)
	got := r.poolRow(p.ID)
	if tried() != 1 || got.Fails != 1 || got.PausedUntil != r.clock.Load()+60_000 || got.PauseReason == "" {
		t.Fatalf("after the first failure: %d tries, %+v", tried(), got)
	}
	if j := r.job(id); j.State != model.JobQueued {
		t.Fatalf("job: %s", j.State)
	}
	// While it pauses nothing is tried, and the job says why it waits.
	r.advance(30)
	r.pass(3)
	if j := r.job(id); tried() != 1 || !strings.Contains(j.Reason, "GitHub pauses until") || !strings.Contains(j.Reason, "a failed start") {
		t.Fatalf("during the pause: %d tries, %q", tried(), j.Reason)
	}
	// Each further failure: 5 minutes, 15 minutes, 1 hour, ... up to 12 hours.
	want := []int{300, 900, 3600, 3 * 3600, 6 * 3600, 12 * 3600, 12 * 3600}
	for i, pause := range want {
		r.advance(int((r.poolRow(p.ID).PausedUntil-r.clock.Load())/1000) + 1)
		r.pass(3)
		got = r.poolRow(p.ID)
		if tried() != i+2 || got.Fails != i+2 || got.PausedUntil != r.clock.Load()+int64(pause)*1000 {
			t.Fatalf("failure %d: %d tries, fails %d, pause %d s, want %d s", i+2, tried(), got.Fails, (got.PausedUntil-r.clock.Load())/1000, pause)
		}
	}
	if n := len(r.events("pool.paused")); n != 8 {
		t.Errorf("%d pause events", n)
	}
	// It works again: the next try succeeds, and the count starts anew.
	r.world.FailStart[p.WorkerID()] = 0
	r.advance(12*3600 + 1)
	r.run(10)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(id))
	}
	if got = r.poolRow(p.ID); got.Fails != 0 || got.PausedUntil != 0 || got.PauseReason != "" {
		t.Fatalf("after it worked: %+v", got)
	}
	if n := len(r.events("pool.works")); n != 1 {
		t.Errorf("%d works events", n)
	}
}

func TestJobsGoElsewhereWhileAPoolPauses(t *testing.T) {
	r := newPoolRig(t)
	bad := r.pool("Broken", 1)
	good := r.pool("Other", 2)
	r.world.FailStart[bad.WorkerID()] = 100
	// Three jobs placed together fail together: one failure, not three.
	var ids []int64
	for i := 0; i < 3; i++ {
		ids = append(ids, r.queue("acme/api", 1))
	}
	r.pass(2)
	if got := r.poolRow(bad.ID); got.Fails != 1 {
		t.Fatalf("fails: %d", got.Fails)
	}
	r.run(20)
	for _, id := range ids {
		j := r.job(id)
		if j.State != model.JobCompleted {
			t.Fatalf("job %d: %s %q\n%s", id, j.State, j.Reason, r.timeline(id))
		}
		if x := r.runner(j.RunnerID); x.WorkerID != good.WorkerID() {
			t.Fatalf("job %d ran on %d", id, x.WorkerID)
		}
	}
}

// passingRelay fails starts for reasons that say nothing about the pool,
// like GitHub's rate limit.
type passingRelay struct {
	engine.Hosts
	fails int
}

func (p *passingRelay) Start(ctx context.Context, w model.Worker, spec engine.RunnerSpec) error {
	if p.fails > 0 {
		p.fails--
		return fmt.Errorf("%w: GitHub's API limit is used up", engine.ErrPassing)
	}
	return p.Hosts.Start(ctx, w, spec)
}

func TestPassingFailuresDoNotPauseAPool(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1)
	r.eng.Relay = &passingRelay{Hosts: r.world, fails: 6}
	id := r.queue("acme/api", 1)
	r.run(60)
	if got := r.poolRow(p.ID); got.Fails != 0 || got.PausedUntil != 0 {
		t.Fatalf("paused by passing failures: %+v\n%s", got, r.timeline(id))
	}
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(id))
	}
}

func TestPoolBudgetOfTheMonth(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1, func(p *model.Pool) { p.BudgetMin = 3 })
	a := r.queue("acme/api", 30) // about two and a half minutes
	r.run(40)
	if j := r.job(a); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(a))
	}
	got := r.poolRow(p.ID)
	if got.UsedSec < 180 || got.UsedSec > 240 {
		t.Fatalf("used %d s", got.UsedSec)
	}
	if ev := r.events("pool.budget"); len(ev) != 1 || !strings.Contains(ev[0], "3 minutes") {
		t.Fatalf("budget events: %v", ev)
	}
	b := r.queue("acme/api", 1)
	r.pass(2)
	if j := r.job(b); j.State != model.JobQueued || !strings.Contains(j.Reason, "GitHub has used its 3 minutes of this month") {
		t.Fatalf("over budget: %s %q", j.State, j.Reason)
	}
	// A new month: it takes jobs again.
	now := time.UnixMilli(r.clock.Load()).UTC()
	next := time.Date(now.Year(), now.Month()+1, 1, 0, 0, 1, 0, time.UTC)
	r.clock.Store(next.UnixMilli())
	r.run(10)
	if j := r.job(b); j.State != model.JobCompleted {
		t.Fatalf("next month: %s %q", j.State, j.Reason)
	}
	if got = r.poolRow(p.ID); got.UsedSec != 60 || got.Month != next.Format("2006-01") {
		t.Fatalf("next month: %+v", got)
	}
}

func TestBudgetCountsRunnersThatStillRun(t *testing.T) {
	r := newPoolRig(t)
	r.pool("GitHub", 1, func(p *model.Pool) { p.BudgetMin = 1 })
	r.queue("acme/api", 1000)
	r.run(15) // more than a minute
	b := r.queue("acme/api", 1)
	r.pass(2)
	if j := r.job(b); j.State != model.JobQueued || !strings.Contains(j.Reason, "has used its 1 minute of this month") {
		t.Fatalf("second job: %s %q", j.State, j.Reason)
	}
}

func TestPoolRunnerHasLongerToComeOnline(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1)
	r.world.NeverConnect[p.WorkerID()] = true
	id := r.queue("acme/api", 1)
	r.pass(2)
	x := r.runner(r.job(id).RunnerID)
	if x.State != model.RunnerStarting {
		t.Fatalf("runner: %s", x.State)
	}
	// Longer than the start timeout of a worker, shorter than the pool's.
	for i := 0; i < 10; i++ {
		r.advance(30)
		r.pass(2)
	}
	if x = r.runner(x.ID); x.State != model.RunnerStarting {
		t.Fatalf("given up after 5 minutes: %s %q", x.State, x.Error)
	}
	for i := 0; i < 12; i++ {
		r.advance(30)
		r.pass(2)
	}
	if x = r.runner(x.ID); !x.Failed {
		t.Fatalf("not given up after 11 minutes: %+v", x)
	}
	if got := r.poolRow(p.ID); got.Fails != 1 {
		t.Fatalf("pool: %+v", got)
	}
}

func TestPoolRunLostWhileItsJobRuns(t *testing.T) {
	r := newPoolRig(t)
	r.pool("GitHub", 1)
	id := r.queue("acme/api", 50)
	for i := 0; i < 6 && r.job(id).State != model.JobRunning; i++ {
		r.pass(2)
		r.world.Step()
		r.advance(5)
	}
	j := r.job(id)
	if j.State != model.JobRunning {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(id))
	}
	x := r.runner(j.RunnerID)
	// GitHub cancels the run of the relay workflow, or the machine dies.
	r.world.Kill(x.Name, 1)
	for i := 0; i < 4; i++ {
		r.pass(2)
		r.advance(11)
	}
	if j = r.job(id); j.State != model.JobRunning || j.Rerun != model.RerunLost {
		t.Fatalf("after the run ended: %s rerun %q\n%s", j.State, j.Rerun, r.timeline(id))
	}
	r.world.Lose(x.Name)
	r.pass(4)
	if j = r.job(id); j.State != model.JobCompleted || j.Rerun != model.RerunDone {
		t.Fatalf("lost job: %s rerun %q\n%s", j.State, j.Rerun, r.timeline(id))
	}
}

func TestRunsNobodyKnowsAreStopped(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1)
	other := r.pool("Other", 2)
	// Runs are only looked at while a runner is on a pool.
	r.queue("acme/api", 1000)
	r.pass(2)
	name := r.eng.Prefix() + "other-0123456789"
	r.world.AddContainer(other.WorkerID(), name)
	r.advance(15)
	r.pass(3)
	if c := r.world.Containers(other.WorkerID()); len(c) != 0 {
		t.Fatalf("unknown run left: %v", c)
	}
	if n := len(r.on(p)); n != 1 {
		t.Fatalf("%d runners on the pool", n)
	}
}

func TestPoolsWithoutARelayAreLeftAlone(t *testing.T) {
	r := newPoolRig(t)
	r.eng.Relay = nil
	r.pool("GitHub", 1)
	w := r.worker("alpha", 2)
	id := r.queue("acme/api", 1)
	r.run(8)
	if j := r.job(id); j.State != model.JobCompleted || r.runner(j.RunnerID).WorkerID != w.ID {
		t.Fatalf("job: %s", j.State)
	}
}

func TestRemovedPoolLeavesNothingBehind(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1)
	id := r.queue("acme/api", 1000)
	r.run(3)
	if j := r.job(id); j.State != model.JobRunning {
		t.Fatalf("job: %s", j.State)
	}
	must(t, r.st.Tx(func(tx *store.Tx) error { return tx.DeletePool(p.ID) }))
	r.world.Cancel(id)
	must(t, r.eng.HandleJob(engine.JobEvent{Action: "completed", ID: id, AccountID: orgID, RepoID: 1, Repo: "acme/api", Conclusion: "cancelled"}))
	r.advance(40)
	r.run(6)
	if n := len(r.active()); n != 0 {
		t.Fatalf("%d runners left", n)
	}
	if c := r.world.Containers(p.WorkerID()); len(c) != 0 {
		t.Fatalf("runs left: %v", c)
	}
}

func TestDatabaseOfAnEarlierVersionIsMovedOn(t *testing.T) {
	r := newRig(t)
	must(t, r.st.Tx(func(tx *store.Tx) error {
		if err := tx.Delete("version"); err != nil {
			return err
		}
		if err := tx.Set("relay.off", []byte(`{"at":1,"reason":"x"}`)); err != nil {
			return err
		}
		return tx.Set("settings", []byte(`{"baseLabel":"ci-plane","sizes":[{"name":"size-s","cpus":1,"memMb":4096},{"name":"size-m","cpus":2,"memMb":6144},`+
			`{"name":"size-l","cpus":3,"memMb":8192},{"name":"size-xl","cpus":6,"memMb":16384}],"defaultSize":"size-m","relayEnabled":true,"relayAfterSec":180,"historyDays":7}`))
	}))
	// A job of the earlier version waits across the upgrade.
	id := r.queue("acme/api", 1, "size-l")
	r.boot()
	r.boot() // a second start changes nothing more
	set := r.settings(nil)
	if len(set.Sizes) != 2 || set.Sizes[0].MemMB != 6144 || set.Sizes[1].MemMB != 16384 || set.HistoryDays != 7 {
		t.Fatalf("settings: %+v", set)
	}
	must(t, r.st.View(func(tx *store.Tx) error {
		if b, err := tx.Get("settings"); err != nil || strings.Contains(string(b), "relay") {
			t.Errorf("settings still carry the failover: %s %v", b, err)
		}
		if _, err := tx.Get("relay.off"); err == nil {
			t.Error("relay.off is still there")
		}
		return nil
	}))
	if n, m := len(r.events("pool.moved")), len(r.events("settings.sizes")); n != 1 || m != 1 {
		t.Fatalf("%d and %d notes", n, m)
	}
	w := r.workerSized("alpha", 1, 16, 64*1024)
	r.run(8)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job of the earlier version: %s %q", j.State, j.Reason)
	}
	r.clean(w)
}

// A failure that is not the pool's fault (GitHub's rate limit) does not
// pause it, but a worker that has room goes first afterwards: the job must
// not keep trying the pool while a worker is free.
func TestJobLeavesAPoolThatCannotStartItForAWorker(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("Free minutes", 1)
	w := r.worker("alpha", 2)
	r.eng.Relay = &passingRelay{Hosts: r.world, fails: 1000}
	id := r.queue("acme/api", 1)
	r.run(12)
	j := r.job(id)
	if j.State != model.JobCompleted {
		t.Fatalf("job: %s %q\n%s", j.State, j.Reason, r.timeline(id))
	}
	if x := r.runner(j.RunnerID); x.WorkerID != w.ID {
		t.Fatalf("ran on %d", x.WorkerID)
	}
	if got := r.poolRow(p.ID); got.Fails != 0 {
		t.Fatalf("pool: %+v", got)
	}
}

// After failed starts one runner shows whether the pool works again; the
// other jobs do not fail with it.
func TestOneRunnerTriesAPoolAgain(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1)
	w := r.worker("alpha", 2)
	r.world.NeverConnect[p.WorkerID()] = true
	must(t, r.st.Tx(func(tx *store.Tx) error {
		cur, _ := tx.Pool(p.ID)
		cur.Fails, cur.PausedUntil, cur.PauseReason = 2, r.clock.Load()-1, "the runner did not connect"
		return tx.SavePool(cur)
	}))
	var ids []int64
	for i := 0; i < 4; i++ {
		ids = append(ids, r.queue("acme/api", 1))
	}
	r.pass(2)
	if n := len(r.on(p)); n != 1 {
		t.Fatalf("%d runners try the pool again", n)
	}
	onWorker := 0
	for _, id := range ids {
		if j := r.job(id); j.State == model.JobAssigned && r.runner(j.RunnerID).WorkerID == w.ID {
			onWorker++
		}
	}
	if onWorker != 3 {
		t.Fatalf("%d jobs went to the worker", onWorker)
	}
}

// A runner that never came online ran on no machine: it uses no budget.
func TestBudgetLeavesOutRunnersThatNeverRan(t *testing.T) {
	r := newPoolRig(t)
	p := r.pool("GitHub", 1, func(p *model.Pool) { p.BudgetMin = 100 })
	r.world.NeverConnect[p.WorkerID()] = true
	r.queue("acme/api", 1)
	for i := 0; i < 30; i++ {
		r.pass(2)
		r.advance(30)
	}
	if got := r.poolRow(p.ID); got.UsedSec != 0 || got.Fails == 0 {
		t.Fatalf("pool: %+v", got)
	}
}

// The relay workflow ends its run after six hours. CI-Plane ends the
// runner a little earlier, as a job that ran too long: the end of the run
// would look like a lost machine and have the job run again.
func TestJobOnAPoolEndsBeforeItsRunDoes(t *testing.T) {
	r := newPoolRig(t)
	r.pool("GitHub", 1)
	r.settings(func(s *model.Settings) { s.JobTimeoutSec = 24 * 3600 })
	id := r.queue("acme/api", 1_000_000)
	r.run(3)
	j := r.job(id)
	if j.State != model.JobRunning {
		t.Fatalf("job: %s", j.State)
	}
	x := r.runner(j.RunnerID)
	r.advance(349 * 60)
	r.pass(2)
	if x = r.runner(x.ID); x.State != model.RunnerBusy {
		t.Fatalf("ended too early: %s", x.State)
	}
	r.advance(2 * 60)
	r.pass(2)
	if x = r.runner(x.ID); x.State == model.RunnerBusy || !strings.Contains(x.Error, "limit of a run on a pool") {
		t.Fatalf("not ended: %s %q", x.State, x.Error)
	}
	if j = r.job(id); j.Rerun != "" {
		t.Fatalf("marked to run again: %q", j.Rerun)
	}
}
