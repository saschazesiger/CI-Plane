package engine

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// reconcileForge compares the store with GitHub once a minute. Webhooks are
// the fast path; this is what makes a lost webhook harmless.
func (e *Engine) reconcileForge(ctx context.Context, s *snapshot) {
	e.spawn(ctx, "reconcile", 10*time.Minute, func(ctx context.Context) time.Duration {
		e.mu.Lock()
		e.fails["reconcile"]++
		pass := e.fails["reconcile"]
		e.mu.Unlock()

		e.findQueued(ctx, s)
		e.refreshOpen(ctx, s)
		if pass%5 == 1 {
			e.sweepRunners(ctx, s)
		}
		return time.Minute
	})
}

// findQueued asks GitHub for waiting jobs the webhook did not announce.
func (e *Engine) findQueued(ctx context.Context, s *snapshot) {
	perAccount := map[int64]int{}
	for _, r := range s.repos {
		perAccount[r.AccountID]++
	}
	for _, r := range s.repos {
		acc, ok := s.accounts[r.AccountID]
		if !ok || !acc.Enabled || !r.Enabled || acc.InstallationID == 0 {
			continue
		}
		// With many repositories only the recently active ones are asked,
		// to stay inside GitHub's rate limit.
		if perAccount[r.AccountID] > 30 && s.now-r.LastJobAt > 48*3600*1000 {
			continue
		}
		jobs, err := e.forge.QueuedJobs(ctx, acc.ID, r.FullName)
		if err != nil {
			e.logf("reconcile: queued jobs of %s: %v", r.FullName, err)
			continue
		}
		for _, ev := range jobs {
			if _, known := s.job[ev.ID]; known {
				continue
			}
			ev.Action, ev.AccountID = "queued", acc.ID
			if ev.RepoID == 0 {
				ev.RepoID = r.ID
			}
			if err := e.HandleJob(ev); err != nil {
				e.logf("reconcile: job %d: %v", ev.ID, err)
			}
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// refreshOpen asks GitHub about open jobs that were not heard of for a
// while: a missed "in_progress" or "completed".
func (e *Engine) refreshOpen(ctx context.Context, s *snapshot) {
	checked := 0
	for _, j := range s.jobs {
		every := int64(60_000)
		if j.State == model.JobRunning {
			every = 180_000
		}
		key := "job:" + j.Repo + ":" + itoa(j.ID)
		e.mu.Lock()
		due := s.now-j.UpdatedAt > every && e.notBefore[key] <= s.now
		if due {
			e.notBefore[key] = s.now + every
		}
		e.mu.Unlock()
		if !due {
			continue
		}
		if checked++; checked > 30 {
			return
		}
		e.refreshJob(ctx, j)
		if ctx.Err() != nil {
			return
		}
		e.mu.Lock()
		delete(e.notBefore, key)
		e.mu.Unlock()
	}
}

// refreshJob asks GitHub for the state of one job and applies it.
func (e *Engine) refreshJob(ctx context.Context, j model.Job) {
	ev, err := e.forge.Job(ctx, j.AccountID, j.Repo, j.ID)
	switch {
	case errors.Is(err, ErrGone):
		ev = JobEvent{Action: "completed", Conclusion: "deleted"}
	case err != nil:
		e.logf("reconcile: job %d of %s: %v", j.ID, j.Repo, err)
		return
	}
	if ev.Action != "in_progress" && ev.Action != "completed" {
		return
	}
	ev.ID, ev.AccountID, ev.RepoID, ev.Repo = j.ID, j.AccountID, j.RepoID, j.Repo
	if err := e.HandleJob(ev); err != nil {
		e.logf("reconcile: job %d: %v", j.ID, err)
	}
}

// refreshAccount asks GitHub about every open job of an account (at most
// 30), used when a runner ended and the store does not know why.
func (e *Engine) refreshAccount(ctx context.Context, accountID int64) {
	var jobs []model.Job
	if err := e.st.View(func(tx *store.Tx) error {
		var err error
		jobs, err = tx.OpenJobs()
		return err
	}); err != nil {
		return
	}
	n := 0
	for _, j := range jobs {
		if j.AccountID != accountID || ctx.Err() != nil {
			continue
		}
		if n++; n > 30 {
			return
		}
		e.refreshJob(ctx, j)
	}
}

// sweepRunners deletes registrations on GitHub that no runner belongs to.
func (e *Engine) sweepRunners(ctx context.Context, s *snapshot) {
	targets := map[Target]bool{}
	for _, r := range s.repos {
		acc, ok := s.accounts[r.AccountID]
		if !ok || acc.InstallationID == 0 {
			continue
		}
		if !acc.IsOrg() && s.now-r.LastJobAt > 48*3600*1000 {
			continue
		}
		targets[targetOf(acc, r.FullName)] = true
	}
	for t := range targets {
		list, err := e.forge.ListRunners(ctx, t)
		if err != nil {
			e.logf("reconcile: runners of %s %s: %v", t.Owner, t.Repo, err)
			continue
		}
		for _, fr := range list {
			if !strings.HasPrefix(fr.Name, NamePrefix) || fr.Busy {
				continue
			}
			active := false
			_ = e.st.View(func(tx *store.Tx) error {
				if r, err := tx.RunnerByName(fr.Name); err == nil && r.Active() {
					active = true
				}
				return nil
			})
			if active {
				continue
			}
			if err := e.forge.DeleteRunner(ctx, t, fr.ID); err == nil {
				_ = e.st.Tx(func(tx *store.Tx) error {
					event(tx, model.LevelWarn, "forge.orphan", "Deleted the registration of "+fr.Name+" on GitHub, which no runner belongs to", 0, "", 0)
					return nil
				})
			}
		}
		if ctx.Err() != nil {
			return
		}
	}
}

// housekeeping deletes old history a few times a day.
func (e *Engine) housekeeping(s *snapshot) {
	e.spawn(context.Background(), "prune", time.Minute, func(context.Context) time.Duration {
		days := s.set.HistoryDays
		if days < 1 {
			days = 1
		}
		if err := e.st.Tx(func(tx *store.Tx) error { return tx.Prune(s.now - int64(days)*24*3600*1000) }); err != nil {
			e.logf("housekeeping: %v", err)
		}
		return 6 * time.Hour
	})
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }
