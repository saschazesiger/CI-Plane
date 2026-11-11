package engine

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// A job whose worker is lost while it runs is not the job's fault. GitHub
// notices that the runner is gone and fails the job; CI-Plane then asks
// GitHub to run that job again. The new attempt arrives as a new job and is
// placed like any other, on a worker that is there.
//
// CI-Plane cannot move a running job, and cannot end it early either: only
// GitHub decides that a runner is lost, a few minutes after it last heard
// of it. A worker that CI-Plane cannot reach may still reach GitHub and
// finish its job, so nothing is done until GitHub has spoken. And a job
// that fails by itself is never run again: for that there must be evidence
// that the runner died, or the worker must stay away.

// lost notes that the runner of a running job disappeared (its container
// crashed or is gone, as after a reboot of the worker) while GitHub still
// shows the job as running.
func (e *Engine) lost(r model.Runner, what string) {
	_ = e.st.Tx(func(tx *store.Tx) error {
		job, err := tx.Job(r.JobID)
		if err != nil || job.State != model.JobRunning || job.RunnerID != r.ID || job.Rerun != "" {
			return ignoreMissing(err)
		}
		job.Rerun = model.RerunLost
		event(tx, model.LevelWarn, "job.lost", "The runner stopped while the job ran: "+what+". If GitHub fails the job for that, it is run again", job.ID, r.ID, r.WorkerID)
		return tx.SaveJob(job)
	})
}

func ignoreMissing(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	return err
}

// failedOnRunner decides what a "failure" of a running job means. Only the
// decision is stored here; rerunLost carries it out.
func (e *Engine) failedOnRunner(tx *store.Tx, job *model.Job) {
	if job.Rerun == model.RerunLost {
		e.wantRerun(tx, job, "its runner stopped while it ran")
		return
	}
	job.Rerun = ""
	r, err := tx.Runner(job.RunnerID)
	if err != nil || !e.down(r.WorkerID, downGrace) {
		return // the worker is fine: the job failed by itself
	}
	// The worker cannot be reached. It may be gone, and the job with it. Or
	// only the way to it is: then it still reached GitHub and the job
	// failed by itself. The exit code of the runner tells, once the worker
	// is back; a worker that stays away took the job with it.
	job.Rerun = model.RerunCheck
	event(tx, model.LevelWarn, "job.rerun", fmt.Sprintf("Failed while %s was unreachable. If the worker is not back within %d minutes, or the runner did not end normally, the job is run again",
		e.workerName(tx, r.WorkerID), int(verdictAfter.Minutes())), job.ID, r.ID, r.WorkerID)
}

func (e *Engine) workerName(tx *store.Tx, id int64) string {
	if id == model.RelayWorkerID {
		return "the GitHub-hosted machine"
	}
	if w, err := tx.Worker(id); err == nil {
		return "the worker " + w.Name
	}
	return "its worker"
}

// wantRerun marks a job that was lost with its runner to be run again,
// unless it was run often enough.
func (e *Engine) wantRerun(tx *store.Tx, job *model.Job, why string) {
	attempt := max(job.RunAttempt, 1)
	if attempt >= model.MaxRunAttempts {
		job.Rerun = model.RerunFailed
		event(tx, model.LevelError, "job.rerun", fmt.Sprintf("Failed because %s. It is not run again: this was attempt %d already", why, attempt), job.ID, job.RunnerID, 0)
		return
	}
	job.Rerun = model.RerunWanted
	event(tx, model.LevelWarn, "job.rerun", "Failed because "+why+", not because of the job. Asking GitHub to run it again on another worker", job.ID, job.RunnerID, 0)
}

// awaitsVerdict reports whether it is still open if a job was lost.
func (e *Engine) awaitsVerdict(jobID int64) bool {
	open := false
	_ = e.st.View(func(tx *store.Tx) error {
		if j, err := tx.Job(jobID); err == nil && j.Rerun == model.RerunCheck {
			open = true
		}
		return nil
	})
	return open
}

// verdict decides for a job that failed while its worker was unreachable
// whether it was lost with the worker.
func (e *Engine) verdict(ctx context.Context, j model.Job) time.Duration {
	var r model.Runner
	var w model.Worker
	known := false
	_ = e.st.View(func(tx *store.Tx) error {
		var err error
		if r, err = tx.Runner(j.RunnerID); err != nil {
			return nil
		}
		if w, err = workerOf(tx, r.WorkerID); err == nil {
			known = true
		}
		return nil
	})
	lost, why := false, ""
	switch {
	case !known:
		lost, why = true, "its worker was removed while it ran"
	case e.fleetOf(w.ID).Status(w.ID).Connected:
		list, err := e.fleetOf(w.ID).List(ctx, w)
		if err != nil {
			return 5 * time.Second
		}
		lost, why = true, "its runner on "+w.Name+" did not end normally while the worker was unreachable"
		for _, c := range list {
			if c.Runner == r.Name && !c.Running && c.ExitCode == 0 {
				lost = false // the runner reported the result and left
			}
		}
	case e.now()-j.CompletedAt >= verdictAfter.Milliseconds():
		lost, why = true, "the worker "+w.Name+" went offline while it ran and did not come back"
	default:
		return 10 * time.Second
	}
	_ = e.st.Tx(func(tx *store.Tx) error {
		cur, err := tx.Job(j.ID)
		if err != nil || cur.Rerun != model.RerunCheck {
			return ignoreMissing(err)
		}
		if lost {
			e.wantRerun(tx, &cur, why)
		} else {
			cur.Rerun = ""
			event(tx, model.LevelInfo, "job.rerun", "The worker is back and the runner had ended normally: the job failed by itself and is not run again", cur.ID, r.ID, r.WorkerID)
		}
		return tx.SaveJob(cur)
	})
	e.changed()
	return 0
}

// rerunLost asks GitHub to run again every job that is marked for it, and
// keeps asking until GitHub agrees.
func (e *Engine) rerunLost(ctx context.Context) {
	var jobs []model.Job
	if err := e.st.View(func(tx *store.Tx) error {
		var err error
		jobs, err = tx.JobsToRerun()
		return err
	}); err != nil {
		return
	}
	for _, j := range jobs {
		j := j
		if j.Rerun == model.RerunCheck {
			e.spawn(ctx, "verdict:"+itoa(j.ID), time.Minute, func(ctx context.Context) time.Duration { return e.verdict(ctx, j) })
			continue
		}
		key := "rerun:" + itoa(j.ID)
		e.spawn(ctx, key, time.Minute, func(ctx context.Context) time.Duration {
			err := e.forge.RerunJob(ctx, j.AccountID, j.Repo, j.RunID, j.ID, j.RunAttempt)
			settle := func(state, level, msg string) time.Duration {
				if e.st.Tx(func(tx *store.Tx) error {
					cur, err := tx.Job(j.ID)
					if err != nil || cur.Rerun != model.RerunWanted {
						return ignoreMissing(err)
					}
					cur.Rerun = state
					event(tx, level, "job.rerun", msg, j.ID, "", 0)
					return tx.SaveJob(cur)
				}) != nil {
					return 5 * time.Second
				}
				e.mu.Lock()
				delete(e.fails, key)
				e.mu.Unlock()
				e.changed()
				return 0
			}
			switch {
			case err == nil:
				return settle(model.RerunDone, model.LevelInfo, "GitHub runs the job again; the new attempt appears as a new job")
			case errors.Is(err, ErrGone):
				return settle(model.RerunFailed, model.LevelWarn, "The job was deleted on GitHub; it is not run again")
			case e.now()-j.CompletedAt > rerunWindow.Milliseconds():
				return settle(model.RerunFailed, model.LevelError,
					fmt.Sprintf("GitHub did not run the job again within %d hours: %v. Re-run it on GitHub yourself", int(rerunWindow.Hours()), err))
			}
			e.mu.Lock()
			e.fails[key]++
			n := e.fails[key]
			e.mu.Unlock()
			if n == 1 {
				_ = e.st.Tx(func(tx *store.Tx) error {
					event(tx, model.LevelWarn, "job.rerun", "GitHub does not run the job again yet: "+err.Error()+". It is asked again until it does", j.ID, "", 0)
					return nil
				})
				e.changed()
			}
			return min(backoff(n+2), 2*time.Minute)
		})
	}
}
