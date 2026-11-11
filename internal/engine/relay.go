package engine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// The relay is the failover to GitHub-hosted runners. When no worker has had
// room for a job for a while, CI-Plane registers the job's runner as usual
// and asks GitHub to run the relay workflow in a private repository of the
// person's. That workflow collects the runner's configuration from CI-Plane
// and runs the runner on the GitHub-hosted machine. GitHub then gives the
// job to it like to any runner with the job's labels: the workflows of the
// repositories do not change, and nothing on GitHub is used unless a job
// really waits.
//
// To the engine the relay is one more worker, model.RelayWorkerID, with its
// own Fleet (Engine.Relay). It is not stored with the other workers: it has
// no CPUs to measure, no connection to watch, and it only takes jobs that
// have waited long enough.

// Hosts runs runners: the workers (a Fleet does) or the relay.
type Hosts interface {
	// Start starts a runner. It first removes anything left under the same
	// name, so it can be repeated.
	Start(ctx context.Context, w model.Worker, spec RunnerSpec) error
	// Remove removes everything of a runner. nil if nothing is left.
	Remove(ctx context.Context, w model.Worker, runner string) error
	// List lists the runners, running or ended, including ones the engine
	// does not know.
	List(ctx context.Context, w model.Worker) ([]Container, error)
	// Status returns the live view of a worker; it never blocks.
	Status(workerID int64) WorkerStatus
}

// ErrPassing marks a failed start that says nothing about where it was
// tried: a rate limit, a network error, an error of GitHub's own. It is not
// counted against the host.
var ErrPassing = errors.New("a passing failure")

// relayFailGap is the least time between two failed starts on the relay
// that count separately: jobs that were placed together and failed for the
// same reason are one failure, not several.
const relayFailGap = 30 * time.Second

// relayStartLimit is how long a runner on the relay may take to come online.
// GitHub may take minutes to hand out a machine, and the runner is
// downloaded on it first.
const relayStartLimit = 10 * time.Minute

// relayWorker is the stand-in worker of the relay.
func relayWorker(set model.Settings) model.Worker {
	return model.Worker{ID: model.RelayWorkerID, Name: model.RelayWorkerName, Enabled: set.RelayEnabled, State: model.WorkerOnline}
}

// fleetOf returns the fleet that runs the runners of a worker.
func (e *Engine) fleetOf(workerID int64) Hosts {
	if workerID != model.RelayWorkerID {
		return e.fleet
	}
	if e.Relay == nil {
		return noRelay{}
	}
	return e.Relay
}

// workerOf reads a worker, the relay included.
func workerOf(tx *store.Tx, id int64) (model.Worker, error) {
	if id != model.RelayWorkerID {
		return tx.Worker(id)
	}
	set, err := tx.Settings()
	if err != nil {
		return model.Worker{}, err
	}
	return relayWorker(set), nil
}

// relayChoice says whether a job of size z that found no worker goes to the
// relay now. If it does not, note is added to the reason why the job waits.
func (s *snapshot) relayChoice(j model.Job, z model.Size, active int, enabled bool) (now bool, note string) {
	set := s.set
	if !enabled || !set.RelayEnabled || set.RelayRepo == "" || !set.RelayFits(z) || !s.status[model.RelayWorkerID].Connected {
		return false, ""
	}
	if active >= set.RelayMax {
		return false, fmt.Sprintf("; all %d GitHub-hosted runners of the failover are in use", set.RelayMax)
	}
	if wait := int64(set.RelayAfterSec) * 1000; s.now-j.WaitingSince < wait {
		return false, "; it goes to a GitHub-hosted runner once it has waited " + span(set.RelayAfterSec)
	}
	return true, ""
}

// span says a number of seconds in words.
func span(sec int) string {
	switch {
	case sec == 60:
		return "1 minute"
	case sec%60 == 0:
		return fmt.Sprintf("%d minutes", sec/60)
	}
	return fmt.Sprintf("%d seconds", sec)
}

// relayFailed counts a start on the relay that failed because of the relay:
// the workflow did not run, or its runner did not come online. After
// FailureThreshold of them in a row the failover switches itself off. Most
// likely the minutes for GitHub-hosted runners are used up, and every
// further try would fail the same way, so it waits for the person.
func (e *Engine) relayFailed(reason string) {
	e.mu.Lock()
	if last := e.notBefore["relay-failed"]; last != 0 && e.now()-last < relayFailGap.Milliseconds() {
		e.mu.Unlock()
		return
	}
	e.notBefore["relay-failed"] = e.now()
	e.fails["relay"]++
	n := e.fails["relay"]
	e.mu.Unlock()
	off := false
	err := e.st.Tx(func(tx *store.Tx) error {
		set, err := tx.Settings()
		if err != nil || !set.RelayEnabled || n < set.FailureThreshold {
			return err
		}
		set.RelayEnabled = false
		if err := tx.SaveSettings(set); err != nil {
			return err
		}
		why := fmt.Sprintf("%d starts on GitHub-hosted runners failed in a row, the last because %s. "+
			"Look at the latest runs of %s in %s: GitHub may refuse to run it because the Actions minutes or the "+
			"spending limit of %s are used up, or its runs cannot reach CI-Plane. Switch the failover on again once that is fixed",
			n, reason, model.RelayWorkflow, set.RelayRepo, ownerOf(set.RelayRepo))
		if err := tx.SetJSON(model.RelayOffKey, model.RelayOff{At: e.now(), Reason: why}); err != nil {
			return err
		}
		event(tx, model.LevelError, "relay.off", "The failover to GitHub-hosted runners switched itself off: "+why, 0, "", model.RelayWorkerID)
		off = true
		return nil
	})
	if err != nil {
		e.logf("engine: relay failure: %v", err)
	}
	if off {
		e.relayWorks()
		e.changed()
	}
}

// relayWorks resets the count of failed starts on the relay.
func (e *Engine) relayWorks() {
	e.mu.Lock()
	delete(e.fails, "relay")
	delete(e.notBefore, "relay-failed")
	e.mu.Unlock()
}

func ownerOf(repo string) string {
	for i := 0; i < len(repo); i++ {
		if repo[i] == '/' {
			return repo[:i]
		}
	}
	return repo
}

// noRelay stands in for a relay where there is none, as in a test without
// one: it starts nothing and has nothing left to remove.
type noRelay struct{}

var errNoRelay = errors.New("the failover to GitHub-hosted runners is not available here")

func (noRelay) Start(context.Context, model.Worker, RunnerSpec) error { return errNoRelay }
func (noRelay) Remove(context.Context, model.Worker, string) error    { return nil }
func (noRelay) List(context.Context, model.Worker) ([]Container, error) {
	return nil, errNoRelay
}
func (noRelay) Status(int64) WorkerStatus { return WorkerStatus{Error: errNoRelay.Error()} }

// watchRelay lists the runs of the relay workflow, like the containers of a
// worker: a runner whose run ended has ended. While no runner is on the
// relay it looks only once a minute, for runs nobody knows.
func (e *Engine) watchRelay(ctx context.Context, s *snapshot) {
	if e.Relay == nil {
		return
	}
	w, ok := s.worker[model.RelayWorkerID]
	if !ok || !s.status[w.ID].Connected {
		return
	}
	busy := false
	for _, r := range s.runners {
		if r.WorkerID == model.RelayWorkerID {
			busy = true
		}
	}
	if !busy && (!s.set.RelayEnabled || s.set.RelayRepo == "") {
		return // nothing runs there, and nothing will
	}
	e.spawn(ctx, "list:relay", time.Minute, func(ctx context.Context) time.Duration {
		started := e.now()
		list, err := e.Relay.List(ctx, w)
		if err != nil {
			return 15 * time.Second
		}
		e.compareContainers(ctx, w, list, started)
		busy = false
		_ = e.st.View(func(tx *store.Tx) error {
			runners, err := tx.ActiveRunners()
			for _, r := range runners {
				if r.WorkerID == model.RelayWorkerID {
					busy = true
				}
			}
			return err
		})
		if busy {
			return 5 * time.Second
		}
		return time.Minute
	})
}
