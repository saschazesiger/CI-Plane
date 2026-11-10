package engine_test

import (
	"context"
	"fmt"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/sim"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

const (
	orgID  = int64(1)
	userID = int64(2)
)

// rig is an engine on an in-memory store and a simulated world, with a
// clock the test moves.
type rig struct {
	t     *testing.T
	st    *store.Store
	world *sim.World
	eng   *engine.Engine
	clock atomic.Int64
	jobID int64
}

func newRig(t *testing.T) *rig {
	t.Helper()
	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	r := &rig{t: t, st: st, world: sim.New(), jobID: 100}
	r.clock.Store(1_700_000_000_000)
	st.SetClock(r.clock.Load)
	r.boot()
	must(t, st.Tx(func(tx *store.Tx) error {
		if err := tx.SaveAccount(model.Account{ID: orgID, Slug: "ci-plane-acme", Owner: "acme", OwnerType: "Organization", InstallationID: 11, Enabled: true}); err != nil {
			return err
		}
		if err := tx.SaveAccount(model.Account{ID: userID, Slug: "ci-plane-jo", Owner: "jo", OwnerType: "User", InstallationID: 12, Enabled: true}); err != nil {
			return err
		}
		for _, p := range []model.Repo{
			{ID: 1, AccountID: orgID, FullName: "acme/api", Enabled: true},
			{ID: 2, AccountID: orgID, FullName: "acme/web", Enabled: true},
			{ID: 3, AccountID: userID, FullName: "jo/site", Enabled: true},
		} {
			if err := tx.UpsertRepo(p); err != nil {
				return err
			}
		}
		return nil
	}))
	return r
}

// boot creates a fresh engine on the same store and world, like a restart
// of the process.
func (r *rig) boot() {
	r.eng = engine.New(r.st, r.world, r.world)
	r.eng.SetClock(r.clock.Load)
	r.eng.Logf = r.t.Logf
	eng := r.eng
	r.world.Deliver = func(ev engine.JobEvent) {
		if err := eng.HandleJob(ev); err != nil {
			r.t.Errorf("HandleJob: %v", err)
		}
	}
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// worker adds a connected worker with 16 CPUs and 64 GB.
func (r *rig) worker(name string, tier int) model.Worker {
	return r.workerSized(name, tier, 16, 64*1024)
}

func (r *rig) workerSized(name string, tier, cpus, memMB int) model.Worker {
	r.t.Helper()
	var w model.Worker
	must(r.t, r.st.Tx(func(tx *store.Tx) error {
		var err error
		w, err = tx.AddWorker(model.Worker{Name: name, Host: name + ".test", Port: 22, User: "ci-plane", Tier: tier, Enabled: true, CPUs: cpus, MemMB: memMB})
		return err
	}))
	r.world.Connect(w.ID)
	return w
}

// queue adds a job on the simulated GitHub.
func (r *rig) queue(repo string, steps int, labels ...string) int64 {
	r.jobID++
	ev := engine.JobEvent{ID: r.jobID, RunID: r.jobID, Repo: repo, Name: "build", Workflow: "CI", Labels: append([]string{"self-hosted", "ci-plane"}, labels...)}
	switch repo {
	case "acme/api":
		ev.AccountID, ev.RepoID = orgID, 1
	case "acme/web":
		ev.AccountID, ev.RepoID = orgID, 2
	case "jo/site":
		ev.AccountID, ev.RepoID = userID, 3
	}
	r.world.Queue(ev, steps)
	return ev.ID
}

// pass makes n passes of the engine, waiting for the background steps.
func (r *rig) pass(n int) {
	for i := 0; i < n; i++ {
		r.eng.Tick(context.Background())
		r.eng.Wait()
	}
}

// advance moves the clock.
func (r *rig) advance(sec int) { r.clock.Add(int64(sec) * 1000) }

// run lets the world and the engine work until nothing changes, moving the
// clock five seconds per round.
func (r *rig) run(rounds int) {
	for i := 0; i < rounds; i++ {
		r.pass(2)
		r.world.Step()
		r.advance(5)
	}
	r.pass(3)
}

func (r *rig) job(id int64) model.Job {
	r.t.Helper()
	var j model.Job
	must(r.t, r.st.View(func(tx *store.Tx) error {
		var err error
		j, err = tx.Job(id)
		return err
	}))
	return j
}

func (r *rig) runner(id string) model.Runner {
	r.t.Helper()
	var x model.Runner
	must(r.t, r.st.View(func(tx *store.Tx) error {
		var err error
		x, err = tx.Runner(id)
		return err
	}))
	return x
}

func (r *rig) active() []model.Runner {
	r.t.Helper()
	var out []model.Runner
	must(r.t, r.st.View(func(tx *store.Tx) error {
		var err error
		out, err = tx.ActiveRunners()
		return err
	}))
	return out
}

func (r *rig) workerRow(id int64) model.Worker {
	r.t.Helper()
	var w model.Worker
	must(r.t, r.st.View(func(tx *store.Tx) error {
		var err error
		w, err = tx.Worker(id)
		return err
	}))
	return w
}

func (r *rig) timeline(jobID int64) string {
	var b strings.Builder
	_ = r.st.View(func(tx *store.Tx) error {
		evs, _ := tx.Events(store.EventFilter{JobID: jobID})
		for _, e := range evs {
			fmt.Fprintf(&b, "  [%s] %s: %s\n", e.Level, e.Kind, e.Message)
		}
		return nil
	})
	return b.String()
}

// clean asserts that nothing is left anywhere: no active runner, no
// container, no registration.
func (r *rig) clean(workers ...model.Worker) {
	r.t.Helper()
	if a := r.active(); len(a) != 0 {
		r.t.Errorf("active runners left: %+v", a)
	}
	for _, w := range workers {
		if c := r.world.Containers(w.ID); len(c) != 0 {
			r.t.Errorf("containers left on %s: %v", w.Name, c)
		}
	}
	if reg := r.world.Registered(); len(reg) != 0 {
		r.t.Errorf("registrations left on GitHub: %v", reg)
	}
}

func TestHappyPath(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 2)

	r.pass(1)
	j := r.job(id)
	if j.State != model.JobAssigned || j.Size != "size-m" {
		t.Fatalf("after one pass: state %s size %s", j.State, j.Size)
	}
	x := r.runner(j.RunnerID)
	if x.WorkerID != w.ID || x.CPUs != 4 || x.MemMB != 8192 {
		t.Fatalf("runner: %+v", x)
	}
	if got := x.Labels; strings.Join(got, ",") != "self-hosted,linux,x64,ci-plane,size-m" {
		t.Fatalf("labels: %v", got)
	}

	r.run(8)
	j = r.job(id)
	if j.State != model.JobCompleted || j.Conclusion != "success" {
		t.Fatalf("job: state %s conclusion %s\n%s", j.State, j.Conclusion, r.timeline(id))
	}
	if x = r.runner(x.ID); x.State != model.RunnerRemoved || x.Failed {
		t.Fatalf("runner: %+v", x)
	}
	r.clean(w)
	for _, want := range []string{"job.queued", "job.assigned", "runner.started", "runner.online", "job.started", "job.completed", "runner.removed"} {
		if !strings.Contains(r.timeline(id), want) {
			t.Errorf("timeline lacks %s:\n%s", want, r.timeline(id))
		}
	}
}

func TestIgnoredJobs(t *testing.T) {
	r := newRig(t)
	r.worker("alpha", 1)

	// Not ours: no ci-plane label. Nothing is stored.
	r.world.Queue(engine.JobEvent{ID: 1, AccountID: orgID, RepoID: 1, Repo: "acme/api", Labels: []string{"ubuntu-latest"}}, 1)
	// Ours, but with a label nobody can serve.
	gpu := r.queue("acme/api", 1, "gpu")
	// Two sizes.
	two := r.queue("acme/api", 1, "size-s", "size-l")
	r.pass(2)

	must(t, r.st.View(func(tx *store.Tx) error {
		if _, err := tx.Job(1); err == nil {
			t.Error("a job without the base label was stored")
		}
		return nil
	}))
	if j := r.job(gpu); j.State != model.JobIgnored || !strings.Contains(j.Reason, "gpu") {
		t.Errorf("gpu job: %s %q", j.State, j.Reason)
	}
	if j := r.job(two); j.State != model.JobIgnored || !strings.Contains(j.Reason, "two sizes") {
		t.Errorf("two sizes: %s %q", j.State, j.Reason)
	}
	if a := r.active(); len(a) != 0 {
		t.Errorf("runners started for ignored jobs: %+v", a)
	}
}

func TestJobWaitingForApprovalGetsNoRunner(t *testing.T) {
	r := newRig(t)
	r.worker("alpha", 1)
	ev := engine.JobEvent{ID: 900, AccountID: orgID, RepoID: 1, Repo: "acme/api", Labels: []string{"self-hosted", "ci-plane"}}
	for _, action := range []string{"", "waiting"} {
		ev.Action = action
		must(t, r.eng.HandleJob(ev))
	}
	r.pass(2)
	if a := r.active(); len(a) != 0 {
		t.Fatalf("runner started for a job that is not queued: %+v", a)
	}
	ev.Action = "queued"
	must(t, r.eng.HandleJob(ev))
	r.pass(2)
	if j := r.job(900); j.State != model.JobAssigned {
		t.Fatalf("job after it was queued: %s", j.State)
	}
}

func TestLostWebhooks(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	r.world.DropWebhooks = true
	id := r.queue("acme/api", 2)

	// Nothing arrived; the first reconcile finds the job.
	r.pass(2)
	if j := r.job(id); j.State != model.JobAssigned {
		t.Fatalf("reconcile did not find the job: %s", j.State)
	}
	// in_progress and completed are lost too.
	for i := 0; i < 60; i++ {
		r.pass(2)
		r.world.Step()
		r.advance(10)
	}
	r.pass(3)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(id))
	}
	r.clean(w)
}

func TestDuplicateAndOutOfOrderEvents(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 1)
	ev := engine.JobEvent{Action: "queued", ID: id, AccountID: orgID, RepoID: 1, Repo: "acme/api", Labels: []string{"self-hosted", "ci-plane"}}
	for i := 0; i < 3; i++ {
		must(t, r.eng.HandleJob(ev))
	}
	r.pass(2)
	if n := len(r.active()); n != 1 {
		t.Fatalf("%d runners for one job", n)
	}
	r.run(8)
	// Late repeats must not bring the job back.
	must(t, r.eng.HandleJob(ev))
	ev.Action, ev.RunnerName = "in_progress", "ci-plane-alpha-zzz"
	must(t, r.eng.HandleJob(ev))
	r.pass(2)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job came back: %s", j.State)
	}
	r.clean(w)
}

func TestFailedStartMovesToAnotherWorker(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	b := r.worker("beta", 2)
	r.world.FailStart[a.ID] = 1
	id := r.queue("acme/api", 1)

	r.pass(2)
	j := r.job(id)
	if j.State != model.JobQueued || j.Attempts != 1 || j.AvoidWorker != a.ID {
		t.Fatalf("after failed start: %+v", j)
	}
	if got := r.workerRow(a.ID).Failures; got != 1 {
		t.Fatalf("failures of alpha: %d", got)
	}
	r.pass(1)
	if j = r.job(id); j.State != model.JobQueued {
		t.Fatalf("retried before the backoff: %s", j.State)
	}
	r.advance(3)
	r.pass(2)
	j = r.job(id)
	if j.State != model.JobAssigned || r.runner(j.RunnerID).WorkerID != b.ID {
		t.Fatalf("not retried on beta: %+v", j)
	}
	r.run(8)
	if j = r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(id))
	}
	r.clean(a, b)
}

func TestForgeFailureIsRetriedWithoutBlamingTheWorker(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	r.world.FailCreate = 2
	id := r.queue("acme/api", 1)
	for i := 0; i < 6; i++ {
		r.pass(2)
		r.advance(10)
	}
	if j := r.job(id); j.State != model.JobAssigned || j.Attempts != 2 {
		t.Fatalf("job: %+v", j)
	}
	if w := r.workerRow(a.ID); w.Failures != 0 || w.State != model.WorkerOnline {
		t.Fatalf("worker was blamed: %+v", w)
	}
	r.run(8)
	r.clean(a)
}

func TestRunnerNeverConnects(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	b := r.worker("beta", 2)
	r.world.NeverConnect[a.ID] = true
	id := r.queue("acme/api", 1)
	r.pass(2)
	first := r.job(id).RunnerID
	r.advance(121)
	r.pass(3)
	x := r.runner(first)
	if !x.Failed || !strings.Contains(x.Error, "did not connect") {
		t.Fatalf("runner: %+v", x)
	}
	r.advance(5)
	r.run(8)
	j := r.job(id)
	if j.State != model.JobCompleted || r.runner(j.RunnerID).WorkerID != b.ID {
		t.Fatalf("job: %+v\n%s", j, r.timeline(id))
	}
	r.clean(a, b)
}

func TestTiersAndCapacity(t *testing.T) {
	r := newRig(t)
	// Allocatable: 8 CPUs minus 10 % = 7.2, so one size-m (4 CPUs) each.
	a := r.workerSized("alpha", 1, 8, 32*1024)
	b := r.workerSized("beta", 1, 8, 32*1024)
	c := r.workerSized("gamma", 2, 8, 32*1024)

	j1 := r.queue("acme/api", 50)
	j2 := r.queue("acme/api", 50)
	j3 := r.queue("acme/web", 50)
	j4 := r.queue("acme/web", 50)
	r.pass(2)

	on := func(id int64) int64 {
		j := r.job(id)
		if j.RunnerID == "" {
			return 0
		}
		return r.runner(j.RunnerID).WorkerID
	}
	tier1 := map[int64]bool{on(j1): true, on(j2): true}
	if !tier1[a.ID] || !tier1[b.ID] {
		t.Fatalf("first two jobs not spread over tier 1: %v", tier1)
	}
	if on(j3) != c.ID {
		t.Fatalf("third job not on tier 2: worker %d", on(j3))
	}
	if j := r.job(j4); j.State != model.JobQueued || !strings.Contains(j.Reason, "full") {
		t.Fatalf("fourth job: %s %q", j.State, j.Reason)
	}

	// A small job still fits next to a medium one on tier 1.
	small := r.queue("acme/api", 50, "size-s")
	r.pass(2)
	if w := on(small); w != a.ID && w != b.ID {
		t.Fatalf("small job on worker %d", w)
	}

	// When slots are freed, the waiting job runs too.
	r.run(120)
	for _, id := range []int64{j1, j2, j3, j4, small} {
		if j := r.job(id); j.State != model.JobCompleted {
			t.Fatalf("job %d: %s %q\n%s", id, j.State, j.Reason, r.timeline(id))
		}
	}
	r.clean(a, b, c)
}

func TestDisabledDrainingAndUnreachableWorkersGetNoJobs(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	b := r.worker("beta", 1)
	c := r.worker("gamma", 1)
	d := r.worker("delta", 2)
	must(t, r.st.Tx(func(tx *store.Tx) error {
		w, _ := tx.Worker(a.ID)
		w.Enabled = false
		if err := tx.SaveWorker(w); err != nil {
			return err
		}
		w, _ = tx.Worker(b.ID)
		w.Draining = true
		return tx.SaveWorker(w)
	}))
	r.world.Disconnect(c.ID)
	r.pass(1)
	for i := 0; i < 3; i++ {
		id := r.queue("acme/api", 50)
		r.pass(2)
		j := r.job(id)
		if j.State != model.JobAssigned || r.runner(j.RunnerID).WorkerID != d.ID {
			t.Fatalf("job %d: %s on %d", i, j.State, r.runner(j.RunnerID).WorkerID)
		}
	}
	if st := r.workerRow(c.ID).State; st != model.WorkerSetup {
		t.Fatalf("never-seen worker: %s", st)
	}
}

func TestDiskFullAndMemoryGuard(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	b := r.worker("beta", 2)
	r.world.SetStatus(a.ID, engine.WorkerStatus{Connected: true, At: 1, MemAvailMB: 1 << 20, DiskFreeMB: 2000})
	id := r.queue("acme/api", 50)
	r.pass(2)
	if st := r.workerRow(a.ID).State; st != model.WorkerDiskFull {
		t.Fatalf("alpha: %s", st)
	}
	if w := r.runner(r.job(id).RunnerID).WorkerID; w != b.ID {
		t.Fatalf("job on worker %d", w)
	}
	// Disk is back, but something else eats the memory.
	r.world.SetStatus(a.ID, engine.WorkerStatus{Connected: true, At: 1, MemAvailMB: 1000, DiskFreeMB: 1 << 20})
	id = r.queue("acme/api", 50)
	r.pass(2)
	if st := r.workerRow(a.ID).State; st != model.WorkerOnline {
		t.Fatalf("alpha: %s", st)
	}
	if w := r.runner(r.job(id).RunnerID).WorkerID; w != b.ID {
		t.Fatalf("job on worker %d despite no free memory", w)
	}
}

func TestUnhealthyWorkerIsProbedAndComesBack(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	r.world.FailStart[a.ID] = 3
	r.world.FailProbe[a.ID] = true
	id := r.queue("acme/api", 1)
	for i := 0; i < 8; i++ {
		r.pass(2)
		r.advance(20)
	}
	w := r.workerRow(a.ID)
	if w.State != model.WorkerUnhealthy || w.Failures != 3 {
		t.Fatalf("worker: %s, %d failures", w.State, w.Failures)
	}
	if j := r.job(id); j.State != model.JobQueued || !strings.Contains(j.Reason, "No worker is available") {
		t.Fatalf("job: %s %q", j.State, j.Reason)
	}
	r.world.FailProbe[a.ID] = false
	r.advance(31)
	r.pass(3)
	if w = r.workerRow(a.ID); w.State != model.WorkerOnline || w.Failures != 0 {
		t.Fatalf("worker after probe: %s, %d failures", w.State, w.Failures)
	}
	r.run(8)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(id))
	}
	r.clean(a)
}

func TestLimitsPerRepositoryAndAccount(t *testing.T) {
	r := newRig(t)
	r.worker("alpha", 1)
	must(t, r.st.Tx(func(tx *store.Tx) error {
		p, _ := tx.Repo(1)
		p.MaxParallel = 1
		return tx.SaveRepo(p)
	}))
	a1 := r.queue("acme/api", 50, "size-s")
	a2 := r.queue("acme/api", 50, "size-s")
	w1 := r.queue("acme/web", 50, "size-s")
	r.pass(2)
	if s := r.job(a1).State; s != model.JobAssigned {
		t.Fatalf("first job: %s", s)
	}
	if j := r.job(a2); j.State != model.JobQueued || !strings.Contains(j.Reason, "limited to 1") {
		t.Fatalf("second job of the limited repository: %s %q", j.State, j.Reason)
	}
	if s := r.job(w1).State; s != model.JobAssigned {
		t.Fatalf("job of the other repository: %s", s)
	}

	must(t, r.st.Tx(func(tx *store.Tx) error {
		a, _ := tx.Account(orgID)
		a.MaxParallel = 2
		return tx.SaveAccount(a)
	}))
	w2 := r.queue("acme/web", 50, "size-s")
	r.pass(2)
	if j := r.job(w2); j.State != model.JobQueued || !strings.Contains(j.Reason, "acme is limited to 2") {
		t.Fatalf("job over the account limit: %s %q", j.State, j.Reason)
	}
}

func TestCancelledBeforeStartRemovesTheRunner(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 1)
	r.pass(3)
	runner := r.job(id).RunnerID
	r.world.Cancel(id)
	r.pass(2)
	if j := r.job(id); j.State != model.JobCompleted || j.Conclusion != "cancelled" {
		t.Fatalf("job: %+v", j)
	}
	if x := r.runner(runner); x.JobID != 0 || !x.Active() {
		t.Fatalf("runner should be a spare: %+v", x)
	}
	// Within the grace period a new job takes it over instead of a new runner.
	id2 := r.queue("acme/web", 1)
	r.pass(2)
	if j := r.job(id2); j.RunnerID != runner {
		t.Fatalf("the spare runner was not reused: %+v", j)
	}
	r.run(8)
	r.clean(w)

	// Without a new job it is removed after the grace period.
	id3 := r.queue("acme/api", 1)
	r.pass(3)
	runner = r.job(id3).RunnerID
	r.world.Cancel(id3)
	r.pass(2)
	r.advance(61)
	r.pass(4)
	if x := r.runner(runner); x.State != model.RunnerRemoved {
		t.Fatalf("spare runner not removed: %+v", x)
	}
	r.clean(w)
}

func TestGitHubGivesTheRunnerToAnotherJob(t *testing.T) {
	r := newRig(t)
	// Allocatable 18 CPUs: two large runners fit, but not with a medium one.
	w := r.workerSized("alpha", 1, 20, 64*1024)
	// A needs a large runner; B has no size label, so any runner serves it.
	a := r.queue("acme/api", 3, "size-l")
	b := r.queue("acme/api", 3)
	r.pass(2)
	r.world.Step() // both runners online
	r.pass(2)
	ra, rb := r.runner(r.job(a).RunnerID), r.runner(r.job(b).RunnerID)
	if ra.State != model.RunnerIdle || rb.State != model.RunnerIdle {
		t.Fatalf("runners not idle: %s %s", ra.State, rb.State)
	}
	// GitHub hands B to the large runner.
	must(t, r.world.Take(ra.Name, b))
	r.pass(2)
	if j := r.job(b); j.State != model.JobRunning || j.RunnerID != ra.ID {
		t.Fatalf("B: %+v", j)
	}
	// A cannot use B's medium runner: it is queued again. B's runner is a
	// spare that blocks the room A needs, so it is removed at once and A
	// gets a new large runner.
	if x := r.runner(rb.ID); x.JobID != 0 {
		t.Fatalf("B's old runner should be a spare: %+v", x)
	}
	r.pass(4)
	ja := r.job(a)
	if ja.State != model.JobAssigned || ja.RunnerID == ra.ID || ja.RunnerID == rb.ID {
		t.Fatalf("A: %+v\n%s", ja, r.timeline(a))
	}
	if x := r.runner(rb.ID); x.Active() {
		t.Fatalf("B's old runner should be gone: %+v", x)
	}
	r.run(20)
	r.advance(61)
	r.run(6)
	for _, id := range []int64{a, b} {
		if j := r.job(id); j.State != model.JobCompleted {
			t.Fatalf("job %d: %s\n%s", id, j.State, r.timeline(id))
		}
	}
	r.clean(w)
}

func TestSwapWhenRunnersAreInterchangeable(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	a := r.queue("acme/api", 2)
	b := r.queue("acme/api", 2)
	r.pass(2)
	r.world.Step()
	r.pass(2)
	ra, rb := r.job(a).RunnerID, r.job(b).RunnerID
	must(t, r.world.Take(r.runner(ra).Name, b))
	r.pass(1)
	if j := r.job(a); j.State != model.JobAssigned || j.RunnerID != rb {
		t.Fatalf("A should now wait for B's runner: %+v", j)
	}
	if n := len(r.active()); n != 2 {
		t.Fatalf("%d runners, want 2", n)
	}
	r.run(10)
	r.clean(w)
}

func TestPersonalAccountRunnersAreBoundToTheRepository(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("jo/site", 1)
	r.pass(2)
	list, _ := r.world.ListRunners(context.Background(), engine.Target{AccountID: userID, Owner: "jo", Repo: "jo/site"})
	if len(list) != 1 {
		t.Fatalf("runner not registered on the repository: %v", list)
	}
	r.run(8)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s", j.State)
	}
	r.clean(w)
}

func TestRestartInTheMiddleOfAStart(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 1)

	// The process dies after the runner was registered on GitHub and a
	// container was created, but before that was recorded.
	r.pass(2) // stores the intent, then registers and starts
	x := r.runner(r.job(id).RunnerID)
	must(t, r.st.Tx(func(tx *store.Tx) error {
		x.State, x.StartedAt, x.ForgeID = model.RunnerProvisioning, 0, 0
		return tx.SaveRunner(x)
	}))

	r.boot() // restart
	r.run(8)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(id))
	}
	if n := r.world.Starts[w.ID]; n != 2 {
		t.Fatalf("starts: %d, want 2 (the second replaces the first)", n)
	}
	r.clean(w)
}

func TestRestartInTheMiddleOfACleanup(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 1)
	r.world.FailRemove[w.ID] = 1000 // cleanup cannot finish
	r.run(8)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s", j.State)
	}
	x := r.runner(r.job(id).RunnerID)
	if x.State != model.RunnerCleaning {
		t.Fatalf("runner: %s", x.State)
	}
	// Capacity stays reserved while the containers may still be there.
	if c := engine.CapacityOf(model.DefaultSettings(), w, r.active()); c.Runners != 1 {
		t.Fatalf("capacity released too early: %+v", c)
	}

	r.boot()
	r.world.FailRemove[w.ID] = 0
	r.advance(120)
	r.pass(3)
	r.clean(w)
}

func TestOrphansAreRemoved(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	r.world.AddContainer(w.ID, "ci-plane-alpha-dead1")
	r.world.AddRunner(engine.Target{AccountID: orgID, Owner: "acme"}, "ci-plane-alpha-dead2")
	r.world.AddRunner(engine.Target{AccountID: orgID, Owner: "acme"}, "somebody-elses-runner")
	r.pass(3)
	if c := r.world.Containers(w.ID); len(c) != 0 {
		t.Errorf("orphan container left: %v", c)
	}
	if reg := r.world.Registered(); len(reg) != 1 || reg[0] != "somebody-elses-runner" {
		t.Errorf("registrations: %v", reg)
	}
}

func TestWorkerLostDuringAJob(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	b := r.worker("beta", 2)
	id := r.queue("acme/api", 3)
	r.pass(2)
	r.world.Step()
	r.pass(2)
	r.world.Step() // job runs on alpha
	r.pass(2)
	if j := r.job(id); j.State != model.JobRunning {
		t.Fatalf("job: %s", j.State)
	}
	r.world.Disconnect(a.ID)
	r.pass(2)
	if st := r.workerRow(a.ID).State; st != model.WorkerUnreachable {
		t.Fatalf("alpha: %s", st)
	}
	// New jobs go elsewhere at once.
	id2 := r.queue("acme/api", 1)
	r.pass(2)
	if w := r.runner(r.job(id2).RunnerID).WorkerID; w != b.ID {
		t.Fatalf("new job on worker %d", w)
	}
	// The running job ends on GitHub (it keeps running or GitHub fails it).
	r.run(10)
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s", j.State)
	}
	// Its leftovers are removed when the worker is back.
	if x := r.runner(r.job(id).RunnerID); x.State != model.RunnerCleaning {
		t.Fatalf("runner on the lost worker: %s", x.State)
	}
	r.world.Connect(a.ID)
	r.advance(120)
	r.pass(4)
	r.clean(a, b)
}

func TestLongWaitingJobIsNotOvertaken(t *testing.T) {
	r := newRig(t)
	// Allocatable 14.4 CPUs: one size-l (8) and one size-m (4), or three size-m.
	w := r.workerSized("alpha", 1, 16, 64*1024)
	m1 := r.queue("acme/api", 1000)
	m2 := r.queue("acme/api", 1000)
	r.pass(2)
	r.world.Step()
	r.pass(2)
	r.world.Step() // both run
	r.pass(2)
	large := r.queue("acme/api", 5, "size-l") // needs 8, only 6.4 free
	r.pass(2)
	if j := r.job(large); j.State != model.JobQueued {
		t.Fatalf("large job: %s", j.State)
	}
	// Young: a small job may overtake.
	early := r.queue("acme/web", 1000, "size-s")
	r.pass(2)
	r.world.Step()
	r.pass(2)
	r.world.Step()
	r.pass(2)
	if j := r.job(early); j.State != model.JobRunning {
		t.Fatalf("small job while the large one is young: %s", j.State)
	}
	// Old: nothing overtakes on a worker that could hold it.
	r.advance(301)
	late := r.queue("acme/web", 1, "size-s")
	r.pass(2)
	if j := r.job(late); j.State != model.JobQueued {
		t.Fatalf("small job overtook a job that waits for five minutes: %s", j.State)
	}
	// Room appears: the large job goes first.
	r.world.Kill(r.runner(r.job(m1).RunnerID).Name, 0)
	r.world.Kill(r.runner(r.job(m2).RunnerID).Name, 0)
	for i := 0; i < 4; i++ {
		r.pass(3)
		r.advance(6)
	}
	if j := r.job(large); j.State != model.JobAssigned {
		t.Fatalf("large job after room appeared: %s %q", j.State, j.Reason)
	}
	_ = w
}

func TestRemovedAccountLeavesNothingBehind(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	running := r.queue("jo/site", 1000)
	r.pass(2)
	r.world.Step()
	r.pass(2)
	r.world.Step()
	r.pass(2)
	waiting := r.queue("jo/site", 1, "size-xl") // does not fit: stays queued
	r.pass(2)
	if a, b := r.job(running).State, r.job(waiting).State; a != model.JobRunning || b != model.JobQueued {
		t.Fatalf("before: %s %s", a, b)
	}
	must(t, r.st.Tx(func(tx *store.Tx) error { return tx.DeleteAccount(userID) }))
	r.pass(3)
	r.advance(31)
	r.pass(4)
	for _, id := range []int64{running, waiting} {
		if j := r.job(id); j.State != model.JobCompleted || j.Conclusion != "account removed" {
			t.Errorf("job %d: %s %q", id, j.State, j.Conclusion)
		}
	}
	if a := r.active(); len(a) != 0 {
		t.Errorf("active runners left: %+v", a)
	}
	if c := r.world.Containers(w.ID); len(c) != 0 {
		t.Errorf("containers left: %v", c)
	}
}

func TestJobTimeLimit(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 1_000_000)
	r.pass(2)
	r.world.Step()
	r.pass(2)
	r.world.Step()
	r.pass(2)
	x := r.runner(r.job(id).RunnerID)
	if x.State != model.RunnerBusy {
		t.Fatalf("runner: %s", x.State)
	}
	r.advance(6*3600 + 1)
	r.pass(4)
	if x = r.runner(x.ID); x.State != model.RunnerRemoved || !strings.Contains(x.Error, "limit") {
		t.Fatalf("runner after the limit: %+v", x)
	}
	if c := r.world.Containers(w.ID); len(c) != 0 {
		t.Fatalf("containers left: %v", c)
	}
}

func TestManyJobsEndClean(t *testing.T) {
	r := newRig(t)
	a := r.workerSized("alpha", 1, 8, 32*1024)
	b := r.workerSized("beta", 1, 16, 64*1024)
	c := r.workerSized("gamma", 2, 32, 128*1024)
	r.world.FailStart[a.ID] = 2
	r.world.FailCreate = 3
	r.world.FailRemove[b.ID] = 4
	var ids []int64
	repos := []string{"acme/api", "acme/web", "jo/site"}
	sizes := [][]string{nil, {"size-s"}, {"size-l"}, {"size-m"}}
	for i := 0; i < 60; i++ {
		ids = append(ids, r.queue(repos[i%3], 1+i%4, sizes[i%4]...))
		if i%7 == 0 {
			r.pass(1)
			r.world.Step()
		}
		if i == 30 {
			r.world.DropWebhooks = true
		}
		if i == 45 {
			r.world.DropWebhooks = false
		}
	}
	for i := 0; i < 400; i++ {
		r.pass(2)
		r.world.Step()
		r.advance(10)
	}
	r.advance(700)
	r.run(10)
	for _, id := range ids {
		if j := r.job(id); j.State != model.JobCompleted {
			t.Errorf("job %d: %s %q\n%s", id, j.State, j.Reason, r.timeline(id))
		}
	}
	r.clean(a, b, c)
}
