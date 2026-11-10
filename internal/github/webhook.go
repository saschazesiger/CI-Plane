package github

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// maxBody limits a webhook. workflow_job payloads are a few kilobytes; an
// installation event lists repositories and can be larger. GitHub itself
// caps payloads at 25 MB.
const maxBody = 5 << 20

// maxEventAge is how old a job may be for its event to be handled. GitHub
// keeps deliveries for three days and self-hosted jobs run at most five, so
// anything older is a replay of a captured delivery.
const maxEventAge = 7 * 24 * time.Hour

// WebhookHandler serves POST /webhook. onJob receives every workflow_job
// event (engine.HandleJob). GET answers so the tunnel can be checked from
// outside.
func (s *Service) WebhookHandler(onJob func(engine.JobEvent) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			w.Header().Set("X-CI-Plane", "webhook")
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			io.WriteString(w, "CI-Plane receives GitHub webhooks here.\n")
			return
		case http.MethodPost:
		default:
			w.Header().Set("Allow", "GET, HEAD, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		id, _ := strconv.ParseInt(r.Header.Get("X-GitHub-Hook-Installation-Target-ID"), 10, 64)
		var key []byte
		if id > 0 {
			key = s.webhookSecret(id)
		}
		if key == nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
		if err != nil {
			var mbe *http.MaxBytesError
			if errors.As(err, &mbe) {
				http.Error(w, "payload too large", http.StatusRequestEntityTooLarge)
				return
			}
			http.Error(w, "could not read the request", http.StatusBadRequest)
			return
		}
		if !validSignature(key, body, r.Header.Get("X-Hub-Signature-256")) {
			s.noteHook(id, "a webhook with a wrong signature arrived; if the app's webhook secret was changed on GitHub, remove the account and add it again")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		guid := r.Header.Get("X-GitHub-Delivery")
		if guid != "" && s.seen.has(guid) {
			// Handled before: a replay, or a redelivery that crossed with
			// the original.
			io.WriteString(w, "already handled\n")
			return
		}
		payload := body
		if ct, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type")); ct == "application/x-www-form-urlencoded" {
			v, err := url.ParseQuery(string(body))
			if err != nil {
				http.Error(w, "bad form payload", http.StatusBadRequest)
				return
			}
			payload = []byte(v.Get("payload"))
		}

		if err := s.handleEvent(id, r.Header.Get("X-GitHub-Event"), payload, onJob); err != nil {
			var bad badPayload
			if errors.As(err, &bad) {
				s.noteHook(id, "GitHub sent a webhook CI-Plane does not understand: "+err.Error())
				http.Error(w, "bad payload", http.StatusBadRequest)
				return
			}
			s.logf("github: webhook %s of app %d: %v", r.Header.Get("X-GitHub-Event"), id, err)
			s.noteHook(id, "a webhook could not be recorded ("+err.Error()+"); GitHub will deliver it again")
			// 500 makes it a failed delivery that Run asks GitHub to repeat.
			http.Error(w, "could not record the event", http.StatusInternalServerError)
			return
		}
		if guid != "" {
			s.seen.add(guid)
		}
		s.noteHook(id, "")
		io.WriteString(w, "ok\n")
	})
}

func validSignature(key, body []byte, header string) bool {
	hexSig, ok := strings.CutPrefix(header, "sha256=")
	if !ok {
		return false
	}
	got, err := hex.DecodeString(hexSig)
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(body)
	return hmac.Equal(got, mac.Sum(nil))
}

type badPayload struct{ err error }

func (b badPayload) Error() string { return b.err.Error() }

type ghInstallation struct {
	ID      int64 `json:"id"`
	Account struct {
		Login string `json:"login"`
		Type  string `json:"type"`
	} `json:"account"`
}

// foreign reports whether an installation belongs to someone other than
// the owner of the app. That only happens if the app was made public on
// GitHub; such installations must never count as ours.
func (s *Service) foreign(id int64, login string) bool {
	if login == "" {
		return false
	}
	acc, err := s.account(id)
	if err != nil {
		return false
	}
	if !strings.EqualFold(acc.Owner, login) {
		s.logf("github: ignored an installation of %s on %s; the app belongs to %s", acc.Slug, login, acc.Owner)
		return true
	}
	return false
}

// handleEvent applies one verified event of the app id.
func (s *Service) handleEvent(id int64, event string, payload []byte, onJob func(engine.JobEvent) error) error {
	switch event {
	case "workflow_job":
		var p struct {
			Action      string `json:"action"`
			WorkflowJob ghJob  `json:"workflow_job"`
			Repository  ghRepo `json:"repository"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return badPayload{err}
		}
		if p.WorkflowJob.ID == 0 {
			return badPayload{errors.New("workflow_job without a job id")}
		}
		if created := millis(p.WorkflowJob.CreatedAt); created > 0 && s.now().Sub(time.UnixMilli(created)) > maxEventAge {
			return nil
		}
		ev := toEvent(p.WorkflowJob, p.Repository)
		ev.AccountID = id
		// The action is what happened; status may already be ahead of it.
		switch p.Action {
		case "queued":
			ev.Action, ev.At, ev.Conclusion = "queued", millis(p.WorkflowJob.CreatedAt), ""
		case "in_progress":
			ev.Action, ev.At, ev.Conclusion = "in_progress", millis(p.WorkflowJob.StartedAt), ""
		case "completed":
			ev.Action, ev.At, ev.Conclusion = "completed", millis(p.WorkflowJob.CompletedAt), p.WorkflowJob.Conclusion
		default:
			ev.Action, ev.At = "", 0
		}
		return onJob(ev)

	case "installation":
		var p struct {
			Action       string         `json:"action"`
			Installation ghInstallation `json:"installation"`
			Repositories []ghRepo       `json:"repositories"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return badPayload{err}
		}
		if s.foreign(id, p.Installation.Account.Login) {
			return nil
		}
		return s.applyInstallation(id, p.Action, p.Installation.ID, p.Repositories)

	case "installation_repositories":
		var p struct {
			Action       string         `json:"action"`
			Installation ghInstallation `json:"installation"`
			Added        []ghRepo       `json:"repositories_added"`
			Removed      []ghRepo       `json:"repositories_removed"`
		}
		if err := json.Unmarshal(payload, &p); err != nil {
			return badPayload{err}
		}
		if s.foreign(id, p.Installation.Account.Login) {
			return nil
		}
		return s.st.Tx(func(tx *store.Tx) error {
			acc, err := tx.Account(id)
			if errors.Is(err, store.ErrNotFound) {
				return nil // removed in between
			}
			if err != nil {
				return err
			}
			if p.Installation.ID != 0 && acc.InstallationID != p.Installation.ID {
				acc.InstallationID = p.Installation.ID
				if err := tx.SaveAccount(acc); err != nil {
					return err
				}
				s.dropToken(id)
			}
			if err := upsertRepos(tx, id, p.Added); err != nil {
				return err
			}
			return deleteRepos(tx, id, p.Removed)
		})
	}
	return nil // ping and anything else the app is not subscribed to
}

// applyInstallation records an installation event.
func (s *Service) applyInstallation(id int64, action string, installationID int64, repos []ghRepo) error {
	switch action {
	case "created", "deleted", "suspend", "unsuspend", "new_permissions_accepted":
	default:
		return nil
	}
	// A new installation, new permissions or a suspension invalidate the
	// cached token.
	s.dropToken(id)
	if action == "suspend" {
		s.noteAPI(id, errors.New("the app was suspended on GitHub; unsuspend its installation to get jobs again"))
		return nil
	}
	return s.st.Tx(func(tx *store.Tx) error {
		acc, err := tx.Account(id)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if action == "deleted" {
			acc.InstallationID = 0
			if err := tx.SaveAccount(acc); err != nil {
				return err
			}
			// The app sees none of its repositories any more.
			old, err := tx.Repos(id)
			if err != nil {
				return err
			}
			for _, r := range old {
				if err := tx.DeleteRepo(r.ID); err != nil {
					return err
				}
			}
			return nil
		}
		if installationID != 0 && acc.InstallationID != installationID {
			acc.InstallationID = installationID
			if err := tx.SaveAccount(acc); err != nil {
				return err
			}
		}
		if action == "unsuspend" {
			s.noteAPI(id, nil)
		}
		return upsertRepos(tx, id, repos)
	})
}

func upsertRepos(tx *store.Tx, accountID int64, repos []ghRepo) error {
	for _, r := range repos {
		if r.ID == 0 || r.FullName == "" {
			continue
		}
		if err := tx.UpsertRepo(model.Repo{ID: r.ID, AccountID: accountID, FullName: r.FullName, Private: r.Private, Enabled: true}); err != nil {
			return fmt.Errorf("store repository %s: %w", r.FullName, err)
		}
	}
	return nil
}

func deleteRepos(tx *store.Tx, accountID int64, repos []ghRepo) error {
	for _, r := range repos {
		cur, err := tx.Repo(r.ID)
		if errors.Is(err, store.ErrNotFound) {
			continue
		}
		if err != nil {
			return err
		}
		if cur.AccountID != accountID {
			continue
		}
		if err := tx.DeleteRepo(r.ID); err != nil {
			return err
		}
	}
	return nil
}

// guidSet remembers the last n delivery ids.
type guidSet struct {
	mu    sync.Mutex
	n     int
	set   map[string]bool
	order []string
}

func newGUIDSet(n int) *guidSet { return &guidSet{n: n, set: map[string]bool{}} }

func (g *guidSet) has(id string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.set[id]
}

func (g *guidSet) add(id string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.set[id] {
		return
	}
	g.set[id] = true
	g.order = append(g.order, id)
	if len(g.order) > g.n {
		delete(g.set, g.order[0])
		g.order = g.order[1:]
	}
}
