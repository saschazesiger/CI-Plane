package engine_test

import (
	"strings"
	"testing"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// running queues a job and lets it start; it returns the job and its runner.
func (r *rig) running(repo string, steps int, labels ...string) (int64, model.Runner) {
	r.t.Helper()
	id := r.queue(repo, steps, labels...)
	for i := 0; i < 3; i++ {
		r.pass(2)
		r.world.Step()
	}
	r.pass(2)
	j := r.job(id)
	if j.State != model.JobRunning {
		r.t.Fatalf("job %d did not start: %s %q", id, j.State, j.Reason)
	}
	return id, r.runner(j.RunnerID)
}

// A worker that goes away while a job runs: GitHub fails the job, CI-Plane
// has it run again, and the new attempt starts on a worker that is there.
func TestJobOfALostWorkerRunsAgainElsewhere(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	b := r.worker("beta", 2)
	id, run := r.running("acme/api", 1000)
	if run.WorkerID != a.ID {
		t.Fatalf("job on worker %d, want %d", run.WorkerID, a.ID)
	}

	r.world.Disconnect(a.ID)
	r.pass(2)
	r.advance(120)
	r.pass(2)
	// CI-Plane cannot reach the worker, but the worker may still reach
	// GitHub and finish: nothing is decided before GitHub has spoken.
	if j := r.job(id); j.State != model.JobRunning || j.Rerun != "" {
		t.Fatalf("while GitHub has not spoken: %s rerun=%q", j.State, j.Rerun)
	}

	r.world.FailRerun = 2 // other jobs of the run are still going on
	r.world.Lose(run.Name)
	r.pass(2)
	// Lost, or failed by itself while only the way to the worker was down?
	// That is open until the worker is back or has stayed away long enough.
	if j := r.job(id); j.State != model.JobCompleted || j.Rerun != model.RerunCheck || len(r.world.Reruns) != 0 {
		t.Fatalf("after GitHub failed it: %s rerun=%q\n%s", j.State, j.Rerun, r.timeline(id))
	}
	r.advance(301)
	r.pass(2)
	if j := r.job(id); j.Rerun != model.RerunWanted {
		t.Fatalf("after the worker stayed away: rerun=%q\n%s", j.Rerun, r.timeline(id))
	}
	for i := 0; i < 6 && r.job(id).Rerun == model.RerunWanted; i++ {
		r.advance(60)
		r.pass(2)
	}
	if j := r.job(id); j.Rerun != model.RerunDone {
		t.Fatalf("rerun=%q\n%s", j.Rerun, r.timeline(id))
	}
	again := r.world.Reruns[id]
	if again == 0 {
		t.Fatal("GitHub was not asked to run the job again")
	}
	r.pass(2)
	j := r.job(again)
	if j.State != model.JobAssigned || j.RunAttempt != 2 || r.runner(j.RunnerID).WorkerID != b.ID {
		t.Fatalf("new attempt: %s attempt %d %q", j.State, j.RunAttempt, j.Reason)
	}
	if !strings.Contains(r.timeline(id), "went offline while it ran and did not come back") {
		t.Fatalf("timeline does not say why:\n%s", r.timeline(id))
	}
	// A restart in between changes nothing: the intent is stored.
	r.boot()
	r.pass(2)
	if len(r.world.Reruns) != 1 {
		t.Fatalf("run again %d times", len(r.world.Reruns))
	}
}

// Only the way to the worker was down: it still reached GitHub and the job
// failed by itself. When the worker is back, the runner turns out to have
// ended normally, and the job is not run again.
func TestFailedJobBehindABrokenConnectionIsNotRunAgain(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id, run := r.running("acme/api", 1000)
	r.world.Disconnect(w.ID)
	r.pass(1)
	r.advance(60)
	r.world.Lose(run.Name)    // GitHub: failure
	r.world.Kill(run.Name, 0) // the runner reported it and exited
	r.pass(2)
	if j := r.job(id); j.Rerun != model.RerunCheck {
		t.Fatalf("rerun=%q", j.Rerun)
	}
	r.advance(60)
	r.pass(2)
	// The containers are the evidence: they stay until the verdict.
	if len(r.world.Containers(w.ID)) != 1 {
		t.Fatal("the containers were removed before the verdict")
	}
	r.world.Connect(w.ID)
	for i := 0; i < 6; i++ {
		r.pass(2)
		r.advance(6)
	}
	if j := r.job(id); j.Rerun != "" || len(r.world.Reruns) != 0 || !strings.Contains(r.timeline(id), "failed by itself") {
		t.Fatalf("rerun=%q reruns=%v\n%s", j.Rerun, r.world.Reruns, r.timeline(id))
	}
	r.clean(w)
}

// The worker comes back, but the runner did not end normally (it lost
// GitHub, or was killed with a reboot): the job is run again.
func TestJobLostBehindABrokenConnectionRunsAgain(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id, run := r.running("acme/api", 1000)
	r.world.Disconnect(w.ID)
	r.pass(1)
	r.advance(60)
	r.world.Lose(run.Name)
	r.world.Kill(run.Name, 137)
	r.pass(2)
	r.world.Connect(w.ID)
	for i := 0; i < 4; i++ {
		r.pass(2)
		r.advance(6)
	}
	if j := r.job(id); j.Rerun != model.RerunDone || r.world.Reruns[id] == 0 {
		t.Fatalf("rerun=%q\n%s", j.Rerun, r.timeline(id))
	}
}

// The runner came online and took a job just while its worker could not be
// reached. It is not given up as "still starting": that would remove its
// containers in the middle of the job once the worker is back.
func TestRunnerThatTookAJobBehindABrokenConnectionStays(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 1000)
	r.pass(2)
	run := r.runner(r.job(id).RunnerID)
	r.world.Disconnect(w.ID)
	r.world.DropWebhooks = true
	r.world.Step() // online
	r.world.Step() // takes the job; CI-Plane hears nothing
	r.world.DropWebhooks = false
	r.pass(1)
	r.advance(40)
	for i := 0; i < 4; i++ {
		r.pass(2)
		r.advance(16)
	}
	if got, j := r.runner(run.ID), r.job(id); got.State != model.RunnerBusy || j.State != model.JobRunning {
		t.Fatalf("runner %s, job %s\n%s", got.State, j.State, r.timeline(id))
	}
	r.world.Connect(w.ID)
	r.pass(3)
	if len(r.world.Containers(w.ID)) != 1 || r.world.JobState(id) != "in_progress" {
		t.Fatal("the running job was removed")
	}
}

// A job that fails by itself is the job's business.
func TestFailedJobOnAHealthyWorkerIsNotRunAgain(t *testing.T) {
	r := newRig(t)
	r.worker("alpha", 1)
	id, run := r.running("acme/api", 1000)
	r.world.Lose(run.Name) // GitHub reports "failure" while the worker is fine
	r.pass(3)
	if j := r.job(id); j.State != model.JobCompleted || j.Rerun != "" || len(r.world.Reruns) != 0 {
		t.Fatalf("%s rerun=%q, reruns %v", j.State, j.Rerun, r.world.Reruns)
	}
}

// A worker that reboots is back within a minute, but the job is gone with
// its containers all the same.
func TestJobKilledWithItsRunnerRunsAgain(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id, run := r.running("acme/api", 1000)
	r.world.Kill(run.Name, 137)
	for i := 0; i < 4; i++ {
		r.pass(2)
		r.advance(6)
	}
	if j := r.job(id); j.State != model.JobRunning || j.Rerun != model.RerunLost {
		t.Fatalf("after the runner was killed: %s rerun=%q\n%s", j.State, j.Rerun, r.timeline(id))
	}
	r.world.Lose(run.Name)
	r.pass(4)
	if j := r.job(id); j.Rerun != model.RerunDone || r.world.Reruns[id] == 0 {
		t.Fatalf("rerun=%q\n%s", j.Rerun, r.timeline(id))
	}
	_ = w
}

// A worker that keeps dying must not run the same job for ever.
func TestLostJobIsRunAgainOnlyTwice(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id, run := r.running("acme/api", 1000)
	must(t, r.st.Tx(func(tx *store.Tx) error {
		j, err := tx.Job(id)
		if err != nil {
			return err
		}
		j.RunAttempt = model.MaxRunAttempts
		return tx.SaveJob(j)
	}))
	r.world.Disconnect(w.ID)
	r.pass(1)
	r.advance(60)
	r.world.Lose(run.Name)
	r.pass(2)
	r.advance(301)
	r.pass(3)
	if j := r.job(id); j.Rerun != model.RerunFailed || len(r.world.Reruns) != 0 || !strings.Contains(r.timeline(id), "not run again") {
		t.Fatalf("rerun=%q\n%s", j.Rerun, r.timeline(id))
	}
}

// A runner that was still starting on a worker that goes away moves at
// once, and the worker is not blamed for it.
func TestStartingRunnerMovesWhenItsWorkerGoesOffline(t *testing.T) {
	r := newRig(t)
	a := r.worker("alpha", 1)
	b := r.worker("beta", 2)
	r.world.NeverConnect[a.ID] = true
	id := r.queue("acme/api", 5)
	r.pass(2)
	if got := r.runner(r.job(id).RunnerID); got.WorkerID != a.ID || got.State != model.RunnerStarting {
		t.Fatalf("runner on %d in %s", got.WorkerID, got.State)
	}
	r.world.Disconnect(a.ID)
	r.pass(1)
	r.advance(10)
	r.pass(2)
	if j := r.job(id); j.State != model.JobAssigned || r.runner(j.RunnerID).WorkerID != a.ID {
		t.Fatalf("a short interruption moved the job: %s", j.State)
	}
	r.advance(25)
	for i := 0; i < 4; i++ {
		r.pass(2)
		r.advance(3)
	}
	j := r.job(id)
	if j.State != model.JobAssigned || r.runner(j.RunnerID).WorkerID != b.ID {
		t.Fatalf("job did not move to the other worker: %s %q\n%s", j.State, j.Reason, r.timeline(id))
	}
	if w := r.workerRow(a.ID); w.Failures != 0 {
		t.Fatalf("the unreachable worker was blamed: %d failures", w.Failures)
	}
}

// CI-Plane restarts right after the containers of a runner came up, before
// it could store that. The runner is kept as it is: starting it again would
// remove its containers, perhaps in the middle of a job.
func TestInterruptedStartKeepsTheRunner(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 3)
	r.pass(2)
	run := r.runner(r.job(id).RunnerID)
	if run.State != model.RunnerStarting || run.ForgeID == 0 {
		t.Fatalf("runner: %s forge %d", run.State, run.ForgeID)
	}
	// The state as it was just before the last write.
	must(t, r.st.Tx(func(tx *store.Tx) error {
		run.State, run.StartedAt = model.RunnerProvisioning, 0
		return tx.SaveRunner(run)
	}))
	r.world.Step() // the runner is online ...
	r.world.Step() // ... and has taken the job; the webhook is lost in the restart
	r.boot()
	r.pass(3)
	if r.world.Starts[w.ID] != 1 {
		t.Fatalf("the runner was started %d times", r.world.Starts[w.ID])
	}
	if got := r.runner(run.ID); got.State == model.RunnerProvisioning || got.State == model.RunnerCleaning || got.Failed {
		t.Fatalf("runner after the restart: %s failed=%v error=%q", got.State, got.Failed, got.Error)
	}
	r.run(8)
	if j := r.job(id); j.State != model.JobCompleted || j.Conclusion != "success" {
		t.Fatalf("job: %s %s\n%s", j.State, j.Conclusion, r.timeline(id))
	}
	r.clean(w)
}

// A runner that connects and then exits without a job must not start over
// and over: the job waits longer each time and prefers another worker.
func TestRunnerThatExitsIdleBacksOff(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	id := r.queue("acme/api", 5)
	r.pass(2)
	name := r.runner(r.job(id).RunnerID).Name
	r.world.Kill(name, 1)
	// Online on GitHub for a moment, then gone.
	must(t, r.st.Tx(func(tx *store.Tx) error {
		run, err := tx.RunnerByName(name)
		if err != nil {
			return err
		}
		run.State, run.OnlineAt = model.RunnerIdle, r.clock.Load()
		return tx.SaveRunner(run)
	}))
	for i := 0; i < 3 && r.job(id).Attempts == 0; i++ {
		r.advance(6)
		r.pass(1)
	}
	j := r.job(id)
	if j.State != model.JobQueued || j.Attempts != 1 || j.NextTryAt <= r.clock.Load() || j.AvoidWorker != w.ID {
		t.Fatalf("job: %s attempts %d avoid %d\n%s", j.State, j.Attempts, j.AvoidWorker, r.timeline(id))
	}
	if got := r.workerRow(w.ID); got.Failures != 1 {
		t.Fatalf("worker failures: %d", got.Failures)
	}
}

// With more open jobs than one pass may ask about, every job gets its turn,
// and none is asked more often than it is due.
func TestEveryOpenJobIsRefreshedInTurn(t *testing.T) {
	r := newRig(t)
	var ids []int64
	for i := 0; i < 45; i++ { // no worker: they stay queued
		ids = append(ids, r.queue("acme/api", 5))
	}
	r.pass(1)
	for i := 0; i < 4; i++ {
		r.advance(61)
		r.pass(1)
	}
	for _, id := range ids {
		if n := r.world.JobCalls[id]; n < 2 || n > 4 {
			t.Fatalf("job %d was asked about %d times in four passes; calls: %v", id, n, r.world.JobCalls)
		}
	}
}

// GitHub registers no runners for an account (app suspended, outage). The
// first failure is enough: no further runner is started for that account
// until the wait is over, and afterwards everything continues by itself.
func TestNoRunnersAreStartedWhileGitHubRefuses(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	r.world.FailCreate = 1
	j1 := r.queue("acme/api", 3)
	r.pass(2)
	j2 := r.queue("acme/web", 3)
	r.pass(2)
	if j := r.job(j2); j.State != model.JobQueued || !strings.Contains(j.Reason, "does not register runners") {
		t.Fatalf("second job: %s %q", j.State, j.Reason)
	}
	if n := len(r.active()); n > 1 {
		t.Fatalf("%d runners while GitHub refuses", n)
	}
	r.advance(10)
	r.run(12)
	for _, id := range []int64{j1, j2} {
		if j := r.job(id); j.State != model.JobCompleted {
			t.Fatalf("job %d after GitHub answered again: %s %q", id, j.State, j.Reason)
		}
	}
	r.clean(w)
}

// The app was uninstalled: its jobs wait without a runner being tried, and
// are closed once GitHub itself would have given them up.
func TestJobsOfAnUninstalledAppWaitAndExpire(t *testing.T) {
	r := newRig(t)
	r.worker("alpha", 1)
	must(t, r.st.Tx(func(tx *store.Tx) error {
		a, err := tx.Account(orgID)
		if err != nil {
			return err
		}
		a.InstallationID = 0
		return tx.SaveAccount(a)
	}))
	r.world.FailJobs = true
	id := r.queue("acme/api", 3)
	r.pass(3)
	if j := r.job(id); j.State != model.JobQueued || !strings.Contains(j.Reason, "not installed") || len(r.active()) != 0 {
		t.Fatalf("%s %q, %d runners", j.State, j.Reason, len(r.active()))
	}
	r.advance(26 * 3600)
	r.pass(2) // GitHub does not answer: noted, nothing closed on one failure
	if j := r.job(id); j.State != model.JobQueued {
		t.Fatalf("closed after one failed request: %s", j.State)
	}
	r.advance(3700)
	r.pass(2)
	if j := r.job(id); j.State != model.JobCompleted || j.Conclusion != "expired" {
		t.Fatalf("after a day: %s %s", j.State, j.Conclusion)
	}
}

// A public repository takes no jobs until it is switched on.
func TestPublicRepositoryIsOffByDefault(t *testing.T) {
	r := newRig(t)
	r.worker("alpha", 1)
	ev := engine.JobEvent{Action: "queued", ID: 9001, RunID: 9001, AccountID: orgID, RepoID: 77, Repo: "acme/open", Name: "build",
		Labels: []string{"self-hosted", "ci-plane"}}
	must(t, r.eng.HandleJob(ev))
	if j := r.job(9001); j.State != model.JobIgnored || !strings.Contains(j.Reason, "public") {
		t.Fatalf("job of a new public repository: %s %q", j.State, j.Reason)
	}
	ev.ID, ev.RepoID, ev.Repo, ev.Private = 9002, 78, "acme/closed", true
	must(t, r.eng.HandleJob(ev))
	if j := r.job(9002); j.State != model.JobQueued {
		t.Fatalf("job of a new private repository: %s %q", j.State, j.Reason)
	}
}
