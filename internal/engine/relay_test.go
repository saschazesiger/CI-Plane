package engine_test

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// withRelay gives the rig a relay on the simulated world and switches the
// failover on with the given wait.
func (r *rig) withRelay(afterSec int, change ...func(*model.Settings)) {
	r.t.Helper()
	r.eng.Relay = r.world
	r.world.Connect(model.RelayWorkerID)
	r.settings(func(s *model.Settings) {
		s.RelayEnabled, s.RelayRepo, s.RelayAfterSec = true, "acme/relay", afterSec
		for _, c := range change {
			c(s)
		}
	})
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

func onRelay(runners []model.Runner) []model.Runner {
	var out []model.Runner
	for _, x := range runners {
		if x.WorkerID == model.RelayWorkerID {
			out = append(out, x)
		}
	}
	return out
}

func TestRelayTakesAJobThatWaitedLongEnough(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	r.world.SetLoad(w.ID, 100) // busy with other work
	r.withRelay(180)
	id := r.queue("acme/api", 2)

	r.pass(2)
	j := r.job(id)
	if j.State != model.JobQueued || !strings.Contains(j.Reason, "GitHub-hosted runner once it has waited 3 minutes") {
		t.Fatalf("before the wait: %s %q", j.State, j.Reason)
	}
	r.advance(120)
	r.pass(2)
	if j = r.job(id); j.State != model.JobQueued {
		t.Fatalf("went to GitHub before the wait was over: %s", j.State)
	}
	r.advance(61)
	r.pass(1)
	j = r.job(id)
	if j.State != model.JobAssigned {
		t.Fatalf("after the wait: %s %q", j.State, j.Reason)
	}
	x := r.runner(j.RunnerID)
	if x.WorkerID != model.RelayWorkerID || !strings.Contains(x.Name, "-github-hosted-") {
		t.Fatalf("runner: %+v", x)
	}
	if got := strings.Join(x.Labels, ","); got != "self-hosted,linux,x64,ci-plane,size-m" {
		t.Fatalf("labels: %s", got)
	}

	r.run(10)
	if j = r.job(id); j.State != model.JobCompleted || j.Conclusion != "success" {
		t.Fatalf("job: %s %s\n%s", j.State, j.Conclusion, r.timeline(id))
	}
	if x = r.runner(x.ID); x.State != model.RunnerRemoved || x.Failed {
		t.Fatalf("runner: %+v\n%s", x, r.timeline(id))
	}
	if c := r.world.Containers(model.RelayWorkerID); len(c) != 0 {
		t.Errorf("relay runs left: %v", c)
	}
	r.clean(w)
	if tl := r.timeline(id); !strings.Contains(tl, "GitHub-hosted machine through acme/relay") {
		t.Errorf("timeline does not say the job went to GitHub:\n%s", tl)
	}
}

func TestRelayIsOffByDefault(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	r.world.SetLoad(w.ID, 100)
	r.eng.Relay = r.world
	r.world.Connect(model.RelayWorkerID)
	id := r.queue("acme/api", 1)
	r.pass(2)
	r.advance(3600)
	r.pass(2)
	if j := r.job(id); j.State != model.JobQueued || strings.Contains(j.Reason, "GitHub-hosted") {
		t.Fatalf("job: %s %q", j.State, j.Reason)
	}
	if n := len(onRelay(r.active())); n != 0 {
		t.Fatalf("%d runners on the relay while it is off", n)
	}
}

func TestOwnWorkersComeFirst(t *testing.T) {
	r := newRig(t)
	w := r.worker("alpha", 1)
	r.withRelay(0)
	id := r.queue("acme/api", 1)
	r.pass(1)
	if x := r.runner(r.job(id).RunnerID); x.WorkerID != w.ID {
		t.Fatalf("a job went to GitHub although a worker had room: %+v", x)
	}
}

func TestRelayLimitAndLargestSize(t *testing.T) {
	r := newRig(t)
	// No worker at all: everything waits for the relay.
	r.withRelay(0, func(s *model.Settings) { s.RelayMax = 1 })
	a := r.queue("acme/api", 3)
	b := r.queue("acme/api", 3)
	large := r.queue("acme/web", 3, "size-l")
	r.pass(2)

	if j := r.job(a); j.State != model.JobAssigned {
		t.Fatalf("first job: %s %q", j.State, j.Reason)
	}
	if j := r.job(b); j.State != model.JobQueued || !strings.Contains(j.Reason, "all 1 GitHub-hosted runners") {
		t.Fatalf("second job: %s %q", j.State, j.Reason)
	}
	if j := r.job(large); j.State != model.JobQueued || strings.Contains(j.Reason, "GitHub-hosted") {
		t.Fatalf("size-l went to GitHub or says it will: %s %q", j.State, j.Reason)
	}
	r.run(20)
	if j := r.job(a); j.State != model.JobCompleted {
		t.Fatalf("first job: %s", j.State)
	}
	if j := r.job(b); j.State != model.JobCompleted {
		t.Fatalf("second job after the first: %s\n%s", j.State, r.timeline(b))
	}
	if j := r.job(large); j.State != model.JobQueued {
		t.Fatalf("size-l: %s", j.State)
	}
}

func TestRelaySwitchesItselfOffAfterFailedStarts(t *testing.T) {
	r := newRig(t)
	r.withRelay(0)
	r.world.FailStart[model.RelayWorkerID] = 10 // GitHub does not run the workflow
	id := r.queue("acme/api", 1)
	for i := 0; i < 30; i++ {
		r.pass(2)
		r.advance(30)
	}
	set := r.settings(nil)
	if set.RelayEnabled {
		t.Fatalf("still on after %d failed starts\n%s", 10-r.world.FailStart[model.RelayWorkerID], r.timeline(id))
	}
	if n := 10 - r.world.FailStart[model.RelayWorkerID]; n != set.FailureThreshold {
		t.Errorf("%d starts were tried, want %d", n, set.FailureThreshold)
	}
	var off model.RelayOff
	must(t, r.st.View(func(tx *store.Tx) error { return tx.GetJSON(model.RelayOffKey, &off) }))
	if off.At == 0 || !strings.Contains(off.Reason, "spending limit") {
		t.Errorf("no reason stored: %+v", off)
	}
	j := r.job(id)
	if j.State != model.JobQueued {
		t.Fatalf("job: %s", j.State)
	}
	// It waits for a worker now, quietly.
	r.pass(3)
	if j = r.job(id); strings.Contains(j.Reason, "GitHub-hosted") {
		t.Errorf("reason still mentions the failover: %q", j.Reason)
	}
	if n := len(onRelay(r.active())); n != 0 {
		t.Errorf("%d runners on the relay after it switched off", n)
	}
	// A worker arrives: the job runs there.
	w := r.worker("alpha", 1)
	r.run(10)
	if j = r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job after a worker came: %s\n%s", j.State, r.timeline(id))
	}
	r.clean(w)
}

func TestRelayCountResetsWhenARunnerComesOnline(t *testing.T) {
	r := newRig(t)
	r.withRelay(0)
	set := r.settings(nil)
	r.world.FailStart[model.RelayWorkerID] = set.FailureThreshold - 1
	a := r.queue("acme/api", 1)
	r.run(30)
	if j := r.job(a); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(a))
	}
	// As many failures again: still below the threshold, because the
	// runner that came online reset the count.
	r.world.FailStart[model.RelayWorkerID] = set.FailureThreshold - 1
	b := r.queue("acme/api", 1)
	r.run(30)
	if j := r.job(b); j.State != model.JobCompleted {
		t.Fatalf("second job: %s\n%s", j.State, r.timeline(b))
	}
	if !r.settings(nil).RelayEnabled {
		t.Fatal("the failover switched off although runners came online in between")
	}
}

func TestRelayRunnerHasLongerToComeOnline(t *testing.T) {
	r := newRig(t)
	r.withRelay(0)
	r.world.NeverConnect[model.RelayWorkerID] = true
	id := r.queue("acme/api", 1)
	r.pass(2)
	x := r.runner(r.job(id).RunnerID)
	if x.State != model.RunnerStarting {
		t.Fatalf("runner: %s", x.State)
	}
	// Longer than the start timeout of a worker, shorter than the relay's.
	for i := 0; i < 10; i++ {
		r.advance(30)
		r.pass(2)
	}
	if x = r.runner(x.ID); x.State != model.RunnerStarting {
		t.Fatalf("relay runner given up after 5 minutes: %s %q", x.State, x.Error)
	}
	for i := 0; i < 12; i++ {
		r.advance(30)
		r.pass(2)
	}
	if x = r.runner(x.ID); !x.Failed {
		t.Fatalf("relay runner not given up after 11 minutes: %+v", x)
	}
}

func TestRelayRunLostWhileItsJobRuns(t *testing.T) {
	r := newRig(t)
	r.withRelay(0)
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
		r.advance(6)
	}
	if j = r.job(id); j.State != model.JobRunning || j.Rerun != model.RerunLost {
		t.Fatalf("after the run ended: %s rerun %q\n%s", j.State, j.Rerun, r.timeline(id))
	}
	r.world.Lose(x.Name)
	r.pass(4)
	if j = r.job(id); j.State != model.JobCompleted || j.Rerun != model.RerunDone {
		t.Fatalf("lost job: %s rerun %q\n%s", j.State, j.Rerun, r.timeline(id))
	}
	if x = r.runner(x.ID); x.State != model.RunnerRemoved {
		t.Fatalf("runner: %s", x.State)
	}
}

func TestRelayRunNobodyKnowsIsStopped(t *testing.T) {
	r := newRig(t)
	r.withRelay(0)
	name := r.eng.Prefix() + "github-hosted-0123456789"
	r.world.AddContainer(model.RelayWorkerID, name)
	r.pass(2)
	if c := r.world.Containers(model.RelayWorkerID); len(c) != 0 {
		t.Fatalf("unknown relay run left: %v", c)
	}
}

// passingRelay is a relay whose starts fail for reasons that say nothing
// about it, like GitHub's rate limit.
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

func TestPassingFailuresDoNotSwitchTheRelayOff(t *testing.T) {
	r := newRig(t)
	r.withRelay(0)
	r.eng.Relay = &passingRelay{Hosts: r.world, fails: 6}
	id := r.queue("acme/api", 1)
	r.run(60)
	if !r.settings(nil).RelayEnabled {
		t.Fatalf("switched off by passing failures\n%s", r.timeline(id))
	}
	if j := r.job(id); j.State != model.JobCompleted {
		t.Fatalf("job: %s\n%s", j.State, r.timeline(id))
	}
}

func TestFailuresOfJobsPlacedTogetherCountOnce(t *testing.T) {
	r := newRig(t)
	r.withRelay(0)
	r.world.FailStart[model.RelayWorkerID] = 3
	for i := 0; i < 3; i++ {
		r.queue("acme/api", 1)
	}
	r.pass(2)
	if n := 3 - r.world.FailStart[model.RelayWorkerID]; n != 3 {
		t.Fatalf("%d starts tried", n)
	}
	if !r.settings(nil).RelayEnabled {
		t.Fatal("three jobs that failed together switched the failover off")
	}
}
