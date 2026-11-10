package engine

import (
	"errors"
	"fmt"
	"strings"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// HandleJob records what GitHub reported about a job. It is safe to call
// with the same event many times and with events out of order.
func (e *Engine) HandleJob(ev JobEvent) error {
	if ev.At == 0 {
		ev.At = e.now()
	}
	err := e.st.Tx(func(tx *store.Tx) error {
		job, err := tx.Job(ev.ID)
		known := err == nil
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		if !known {
			job, err = e.admit(tx, ev)
			if err != nil || job.ID == 0 {
				return err
			}
		}
		switch ev.Action {
		case "queued":
			// A known job stays as it is; a new one was stored by admit.
			return nil
		case "in_progress":
			return e.started(tx, job, ev)
		case "completed":
			return e.completed(tx, job, ev)
		}
		return nil
	})
	if err == nil {
		e.changed()
		e.Kick()
	}
	return err
}

// admit decides whether a job that is seen for the first time is handled and
// stores it. A zero job means: not ours, nothing stored.
func (e *Engine) admit(tx *store.Tx, ev JobEvent) (model.Job, error) {
	set, err := tx.Settings()
	if err != nil {
		return model.Job{}, err
	}
	if !hasLabel(ev.Labels, set.BaseLabel) {
		return model.Job{}, nil // a job for GitHub's or someone else's runners
	}
	acc, err := tx.Account(ev.AccountID)
	if errors.Is(err, store.ErrNotFound) {
		return model.Job{}, nil
	}
	if err != nil {
		return model.Job{}, err
	}
	repo, err := tx.Repo(ev.RepoID)
	if errors.Is(err, store.ErrNotFound) {
		repo = model.Repo{ID: ev.RepoID, AccountID: acc.ID, FullName: ev.Repo, Private: ev.Private, Enabled: true}
		err = tx.UpsertRepo(repo)
	}
	if err != nil {
		return model.Job{}, err
	}
	repo.LastJobAt = e.now()
	if err := tx.SaveRepo(repo); err != nil {
		return model.Job{}, err
	}

	job := model.Job{
		ID: ev.ID, RunID: ev.RunID, AccountID: acc.ID, RepoID: ev.RepoID, Repo: ev.Repo, Name: ev.Name,
		Workflow: ev.Workflow, Branch: ev.Branch, HTMLURL: ev.HTMLURL, Labels: ev.Labels,
		State: model.JobQueued, QueuedAt: ev.At, WaitingSince: e.now(),
	}
	size, reason := set.Match(ev.Labels)
	switch {
	case !acc.Enabled:
		reason = "the account " + acc.Owner + " is switched off"
	case !repo.Enabled:
		reason = "the repository is switched off"
	}
	if reason != "" {
		job.State, job.Reason = model.JobIgnored, reason
		if err := tx.SaveJob(job); err != nil {
			return model.Job{}, err
		}
		event(tx, model.LevelWarn, "job.ignored", "Ignored: "+reason, job.ID, "", 0)
		return model.Job{}, nil
	}
	job.Size = size
	if err := tx.SaveJob(job); err != nil {
		return model.Job{}, err
	}
	event(tx, model.LevelInfo, "job.queued", "Queued on GitHub ("+size+")", job.ID, "", 0)
	return job, nil
}

func hasLabel(labels []string, want string) bool {
	for _, l := range labels {
		if strings.EqualFold(strings.TrimSpace(l), want) {
			return true
		}
	}
	return false
}

// started handles "in_progress": a runner took the job.
func (e *Engine) started(tx *store.Tx, job model.Job, ev JobEvent) error {
	if job.State == model.JobCompleted || job.State == model.JobIgnored {
		return nil
	}
	if job.State == model.JobRunning && job.RunnerID != "" {
		return nil // a repeated event
	}
	runner, err := tx.RunnerByName(ev.RunnerName)
	if errors.Is(err, store.ErrNotFound) || (err == nil && runner.State == model.RunnerRemoved) {
		// A runner CI-Plane does not manage took the job.
		if err := e.release(tx, job, "the job was taken by another runner"); err != nil {
			return err
		}
		job.State, job.RunnerID, job.StartedAt = model.JobRunning, "", ev.At
		job.Reason = "runs on " + ev.RunnerName + ", a runner CI-Plane does not manage"
		event(tx, model.LevelWarn, "job.foreign", "Taken by the runner "+ev.RunnerName+", which CI-Plane does not manage", job.ID, "", 0)
		return tx.SaveJob(job)
	}
	if err != nil {
		return err
	}
	return e.bind(tx, job, runner, ev.At)
}

// bind records that runner took job, and repairs the pairing of the job the
// runner was started for.
func (e *Engine) bind(tx *store.Tx, job model.Job, runner model.Runner, at int64) error {
	now := e.now()
	// The runner the job was waiting for, if it is another one.
	var own *model.Runner
	if job.RunnerID != "" && job.RunnerID != runner.ID {
		if r, err := tx.Runner(job.RunnerID); err == nil && r.Active() && r.JobID == job.ID {
			own = &r
		}
	}
	// The job the runner was started for, if it is another one.
	if runner.JobID != 0 && runner.JobID != job.ID {
		other, err := tx.Job(runner.JobID)
		if err == nil && other.State == model.JobAssigned && other.RunnerID == runner.ID {
			if own != nil && own.Waiting() && model.Serves(own.Labels, other.Labels) {
				// Swap: the other job waits for this job's runner instead.
				own.JobID, own.SpareAt = other.ID, 0
				other.RunnerID = own.ID
				if err := tx.SaveRunner(*own); err != nil {
					return err
				}
				event(tx, model.LevelInfo, "job.swapped", fmt.Sprintf("GitHub gave its runner to another job; now waiting for %s", own.Name), other.ID, own.ID, own.WorkerID)
				own = nil
			} else {
				other.State, other.RunnerID = model.JobQueued, ""
				event(tx, model.LevelInfo, "job.requeued", "GitHub gave its runner to another job; a new runner will be started", other.ID, "", 0)
			}
			if err := tx.SaveJob(other); err != nil {
				return err
			}
		}
	}
	if own != nil {
		own.JobID, own.SpareAt = 0, now
		if err := tx.SaveRunner(*own); err != nil {
			return err
		}
	}

	runner.JobID, runner.SpareAt = job.ID, 0
	if runner.State != model.RunnerCleaning {
		runner.State = model.RunnerBusy
	}
	runner.BusyAt = now
	if runner.OnlineAt == 0 {
		runner.OnlineAt = now
	}
	if err := tx.SaveRunner(runner); err != nil {
		return err
	}
	job.State, job.RunnerID, job.StartedAt, job.Reason = model.JobRunning, runner.ID, at, ""
	if err := tx.SaveJob(job); err != nil {
		return err
	}
	// A job that starts proves the worker is fine.
	if w, err := tx.Worker(runner.WorkerID); err == nil && w.Failures > 0 {
		w.Failures = 0
		if err := tx.SaveWorker(w); err != nil {
			return err
		}
	}
	wait := (at - job.QueuedAt) / 1000
	if wait < 0 {
		wait = 0
	}
	event(tx, model.LevelInfo, "job.started", fmt.Sprintf("Started on %s after %d s", runner.Name, wait), job.ID, runner.ID, runner.WorkerID)
	return nil
}

// release frees the runner a job was waiting for; it becomes a spare.
func (e *Engine) release(tx *store.Tx, job model.Job, why string) error {
	if job.RunnerID == "" {
		return nil
	}
	r, err := tx.Runner(job.RunnerID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !r.Active() || r.JobID != job.ID || r.State == model.RunnerBusy {
		return nil
	}
	r.JobID, r.SpareAt = 0, e.now()
	event(tx, model.LevelInfo, "runner.spare", "No longer needed: "+why, 0, r.ID, r.WorkerID)
	return tx.SaveRunner(r)
}

// completed handles "completed": the job ended, or was cancelled before it
// started.
func (e *Engine) completed(tx *store.Tx, job model.Job, ev JobEvent) error {
	if job.State == model.JobCompleted || job.State == model.JobIgnored {
		return nil
	}
	if job.State == model.JobQueued || job.State == model.JobAssigned {
		// It may have run on one of our runners without us seeing in_progress.
		if ev.RunnerName != "" {
			if r, err := tx.RunnerByName(ev.RunnerName); err == nil && r.Active() {
				if err := e.bind(tx, job, r, ev.At); err != nil {
					return err
				}
				if job, err = tx.Job(job.ID); err != nil {
					return err
				}
			}
		}
		if job.State != model.JobRunning {
			if err := e.release(tx, job, "the job ended before it started ("+ev.Conclusion+")"); err != nil {
				return err
			}
			job.RunnerID = ""
		}
	}
	job.State, job.Conclusion, job.CompletedAt, job.Reason = model.JobCompleted, ev.Conclusion, ev.At, ""
	level := model.LevelInfo
	if ev.Conclusion == "failure" || ev.Conclusion == "timed_out" {
		level = model.LevelWarn
	}
	event(tx, level, "job.completed", "Completed on GitHub: "+ev.Conclusion, job.ID, job.RunnerID, 0)
	return tx.SaveJob(job)
}
