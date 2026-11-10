package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

const (
	syncEvery     = 30 * time.Minute // backstop for missed installation events
	redeliverScan = 5 * time.Minute  // how often failed deliveries are looked for
	// firstLookback is how far back the first scan after a start looks:
	// what failed while the manager was down. GitHub keeps three days.
	firstLookback = 24 * time.Hour
	scanOverlap   = 15 * time.Minute // later scans overlap the previous one
)

// Sync implements api.GitHub: it reads the installation of the app and its
// repositories into the store.
func (s *Service) Sync(ctx context.Context, accountID int64) error {
	err := s.sync(ctx, accountID)
	s.noteAPI(accountID, err)
	return err
}

func (s *Service) sync(ctx context.Context, accountID int64) error {
	acc, err := s.account(accountID)
	if err != nil {
		return err
	}
	var insts []struct {
		ghInstallation
		SuspendedAt *string `json:"suspended_at"`
	}
	if _, err := s.getJSON(ctx, call{method: http.MethodGet, path: "/app/installations?per_page=100", auth: authApp, account: accountID}, &insts); err != nil {
		return err
	}
	// Only the installation on the owner counts, even if the app was made
	// public and installed elsewhere.
	var inst *ghInstallation
	suspended := false
	for i := range insts {
		if strings.EqualFold(insts[i].Account.Login, acc.Owner) {
			inst = &insts[i].ghInstallation
			suspended = insts[i].SuspendedAt != nil
		}
	}

	if inst == nil {
		s.dropToken(accountID)
		return s.st.Tx(func(tx *store.Tx) error {
			cur, err := tx.Account(accountID)
			if err != nil {
				return ignoreNotFound(err)
			}
			cur.InstallationID = 0
			if err := tx.SaveAccount(cur); err != nil {
				return err
			}
			return keepRepos(tx, accountID, nil)
		})
	}
	if acc.InstallationID != inst.ID {
		s.dropToken(accountID)
		if err := s.st.Tx(func(tx *store.Tx) error {
			cur, err := tx.Account(accountID)
			if err != nil {
				return err
			}
			cur.InstallationID = inst.ID
			return tx.SaveAccount(cur)
		}); err != nil {
			return err
		}
	}
	if suspended {
		return fmt.Errorf("the app %s is suspended on GitHub; unsuspend its installation to get jobs again", acc.Slug)
	}

	var repos []ghRepo
	for page := 1; page <= 100; page++ {
		var res struct {
			TotalCount   int      `json:"total_count"`
			Repositories []ghRepo `json:"repositories"`
		}
		if _, err := s.getJSON(ctx, call{
			method: http.MethodGet, path: "/installation/repositories?per_page=100&page=" + strconv.Itoa(page),
			auth: authInstallation, account: accountID,
		}, &res); err != nil {
			return err
		}
		repos = append(repos, res.Repositories...)
		if len(res.Repositories) < 100 || len(repos) >= res.TotalCount {
			break
		}
	}
	return s.st.Tx(func(tx *store.Tx) error {
		if _, err := tx.Account(accountID); err != nil {
			return ignoreNotFound(err) // removed meanwhile
		}
		if err := upsertRepos(tx, accountID, repos); err != nil {
			return err
		}
		return keepRepos(tx, accountID, repos)
	})
}

// keepRepos deletes the repositories of an account that are not in keep.
func keepRepos(tx *store.Tx, accountID int64, keep []ghRepo) error {
	ids := map[int64]bool{}
	for _, r := range keep {
		ids[r.ID] = true
	}
	old, err := tx.Repos(accountID)
	if err != nil {
		return err
	}
	for _, r := range old {
		if !ids[r.ID] {
			if err := tx.DeleteRepo(r.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

func ignoreNotFound(err error) error {
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	return err
}

// Run keeps installations in sync and asks GitHub to redeliver failed
// webhooks, until ctx ends.
func (s *Service) Run(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	lastSync := map[int64]time.Time{}
	for {
		var accs []model.Account
		if err := s.st.View(func(tx *store.Tx) error {
			var err error
			accs, err = tx.Accounts()
			return err
		}); err != nil {
			s.logf("github: list accounts: %v", err)
		}
		for _, a := range accs {
			if ctx.Err() != nil {
				return
			}
			if s.now().Sub(lastSync[a.ID]) >= syncEvery {
				lastSync[a.ID] = s.now()
				if err := s.Sync(ctx, a.ID); err != nil && ctx.Err() == nil {
					s.logf("github: sync %s: %v", a.Slug, err)
				}
			}
			s.mu.Lock()
			due := s.now().Sub(s.lastScan[a.ID]) >= redeliverScan
			s.mu.Unlock()
			if due && a.InstallationID != 0 {
				if n, err := s.Redeliver(ctx, a.ID); err != nil && ctx.Err() == nil {
					s.logf("github: redeliveries of %s: %v", a.Slug, err)
				} else if n > 0 {
					s.logf("github: asked GitHub to redeliver %d failed workflow_job webhooks of %s", n, a.Slug)
				}
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

type delivery struct {
	ID          int64  `json:"id"`
	GUID        string `json:"guid"`
	DeliveredAt string `json:"delivered_at"`
	Redelivery  bool   `json:"redelivery"`
	StatusCode  int    `json:"status_code"`
	Event       string `json:"event"`
}

func (d delivery) ok() bool { return d.StatusCode >= 200 && d.StatusCode < 400 }

// Redeliver asks GitHub to deliver again the workflow_job webhooks of an app
// that failed and never succeeded since. Each delivery is asked for once:
// one that has a redelivery attempt already is left alone, so a webhook that
// keeps failing does not loop; the minute-by-minute reconciliation covers
// it. It returns how many redeliveries it requested.
func (s *Service) Redeliver(ctx context.Context, appID int64) (int, error) {
	start := s.now()
	s.mu.Lock()
	since := s.lastScan[appID].Add(-scanOverlap)
	if s.lastScan[appID].IsZero() || start.Sub(since) > firstLookback {
		since = start.Add(-firstLookback)
	}
	s.mu.Unlock()

	type group struct {
		latest            delivery
		succeeded, redone bool
		job               bool
	}
	groups := map[string]*group{}
	var order []string
	cursor := ""
scan:
	for page := 0; page < 20; page++ {
		path := "/app/hook/deliveries?per_page=100"
		if cursor != "" {
			path += "&cursor=" + url.QueryEscape(cursor)
		}
		var list []delivery
		r, err := s.getJSON(ctx, call{method: http.MethodGet, path: path, auth: authApp, account: appID}, &list)
		if err != nil {
			return 0, err
		}
		for _, d := range list {
			at := time.UnixMilli(millis(d.DeliveredAt))
			if millis(d.DeliveredAt) > 0 && at.Before(since) {
				break scan // the list is newest first
			}
			g := groups[d.GUID]
			if g == nil {
				g = &group{latest: d}
				groups[d.GUID] = g
				order = append(order, d.GUID)
			}
			if d.ID > g.latest.ID {
				g.latest = d
			}
			g.succeeded = g.succeeded || d.ok()
			g.redone = g.redone || d.Redelivery
			g.job = g.job || d.Event == "workflow_job"
		}
		if cursor = nextCursor(r.header); cursor == "" || len(list) == 0 {
			break
		}
	}

	n := 0
	var firstErr error
	for _, guid := range order {
		g := groups[guid]
		if guid == "" || !g.job || g.succeeded || g.redone {
			continue
		}
		s.mu.Lock()
		_, asked := s.requested[guid]
		s.mu.Unlock()
		if asked {
			continue
		}
		_, err := s.do(ctx, call{
			method: http.MethodPost, path: "/app/hook/deliveries/" + strconv.FormatInt(g.latest.ID, 10) + "/attempts",
			auth: authApp, account: appID,
		})
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			if st := statusOf(err); st < 400 || st >= 500 || st == http.StatusTooManyRequests {
				continue // transient: the next scan tries again
			}
		} else {
			n++
		}
		s.mu.Lock()
		s.requested[guid] = start.UnixMilli()
		s.mu.Unlock()
	}

	s.mu.Lock()
	s.lastScan[appID] = start
	for guid, at := range s.requested {
		if start.UnixMilli()-at > 4*24*3600*1000 {
			delete(s.requested, guid)
		}
	}
	s.mu.Unlock()
	return n, firstErr
}
