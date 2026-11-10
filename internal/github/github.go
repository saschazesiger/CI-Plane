// Package github connects CI-Plane to GitHub: one private GitHub App per
// account or organisation, created with the manifest flow. It registers
// just-in-time runners, finds queued jobs, receives webhooks and asks GitHub
// to redeliver the ones that failed.
package github

import (
	"crypto/rsa"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

var (
	_ engine.Forge = (*Service)(nil)
	_ api.GitHub   = (*Service)(nil)
)

// apiVersion is the REST API version CI-Plane is written against. None of
// its breaking changes touch the endpoints used here.
const apiVersion = "2026-03-10"

// Service talks to GitHub on behalf of every app.
type Service struct {
	// APIURL and WebURL are GitHub's addresses; tests point them elsewhere.
	APIURL string
	WebURL string
	// HTTP is the client for every request to GitHub.
	HTTP *http.Client
	// Homepage is the "homepage" of created apps.
	Homepage string

	st   *store.Store
	box  *secret.Box
	logf func(string, ...any)
	now  func() time.Time

	// retryBase is the first wait between attempts; tests shorten it.
	retryBase time.Duration

	mu        sync.Mutex
	keys      map[int64]*rsa.PrivateKey
	hookKeys  map[int64][]byte
	tokens    map[int64]*tokenSlot
	health    map[int64]*health
	cond      map[string]condEntry // conditional GET cache by account and URL
	runs      map[string]runCache  // jobs of a run by account, repo and run id
	seen      *guidSet             // webhook deliveries handled successfully
	requested map[string]int64     // redeliveries asked for, by guid; Unix ms
	lastScan  map[int64]time.Time  // last delivery scan, by app
}

type health struct {
	lastWebhook int64
	apiErr      string
	hookErr     string
	rateLeft    int
	rateReset   time.Time
}

// New creates the service.
func New(st *store.Store, box *secret.Box, logf func(string, ...any)) *Service {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Service{
		APIURL:    "https://api.github.com",
		WebURL:    "https://github.com",
		HTTP:      &http.Client{Timeout: 30 * time.Second},
		Homepage:  "https://github.com/saschazesiger/CI-Plane",
		st:        st,
		box:       box,
		logf:      logf,
		now:       time.Now,
		retryBase: time.Second,
		keys:      map[int64]*rsa.PrivateKey{},
		hookKeys:  map[int64][]byte{},
		tokens:    map[int64]*tokenSlot{},
		health:    map[int64]*health{},
		cond:      map[string]condEntry{},
		runs:      map[string]runCache{},
		seen:      newGUIDSet(20000),
		requested: map[string]int64{},
		lastScan:  map[int64]time.Time{},
	}
}

// Health implements api.GitHub. It never blocks on the network.
func (s *Service) Health(accountID int64) api.AccountHealth {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.health[accountID]
	if h == nil {
		return api.AccountHealth{RateRemaining: -1}
	}
	out := api.AccountHealth{LastWebhookAt: h.lastWebhook, LastError: h.apiErr, RateRemaining: h.rateLeft}
	if out.LastError == "" {
		out.LastError = h.hookErr
	}
	return out
}

// healthOf returns the entry of an account; s.mu must be held.
func (s *Service) healthOf(id int64) *health {
	h := s.health[id]
	if h == nil {
		h = &health{rateLeft: -1}
		s.health[id] = h
	}
	return h
}

func (s *Service) noteAPI(id int64, err error) {
	if id == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.healthOf(id)
	if err == nil {
		h.apiErr = ""
		return
	}
	if !errors.Is(err, engine.ErrGone) && !errors.Is(err, engine.ErrRunnerBusy) && !errors.Is(err, engine.ErrRunnerExists) {
		h.apiErr = err.Error()
	}
}

func (s *Service) noteHook(id int64, problem string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := s.healthOf(id)
	if problem == "" {
		h.lastWebhook = s.now().UnixMilli()
	}
	h.hookErr = problem
}

// account reads one account from the store.
func (s *Service) account(id int64) (model.Account, error) {
	var a model.Account
	err := s.st.View(func(tx *store.Tx) error {
		var err error
		a, err = tx.Account(id)
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		return a, fmt.Errorf("the GitHub App %d is not known to CI-Plane; add the account again", id)
	}
	return a, err
}

// Secret names in the store.
func keyName(id int64) string    { return "github:" + strconv.FormatInt(id, 10) + ":private-key" }
func hookName(id int64) string   { return "github:" + strconv.FormatInt(id, 10) + ":webhook-secret" }
func clientName(id int64) string { return "github:" + strconv.FormatInt(id, 10) + ":client-secret" }

// webhookSecret returns the webhook secret of an app, or nil if the app is
// unknown.
func (s *Service) webhookSecret(id int64) []byte {
	s.mu.Lock()
	k := s.hookKeys[id]
	s.mu.Unlock()
	if k != nil {
		return k
	}
	_ = s.st.View(func(tx *store.Tx) error {
		if _, err := tx.Account(id); err != nil {
			return nil
		}
		k, _ = s.box.Get(tx, hookName(id))
		return nil
	})
	if len(k) == 0 {
		return nil
	}
	s.mu.Lock()
	s.hookKeys[id] = k
	s.mu.Unlock()
	return k
}

// forget drops everything cached about an app.
func (s *Service) forget(id int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.keys, id)
	delete(s.hookKeys, id)
	delete(s.tokens, id)
	delete(s.health, id)
	delete(s.lastScan, id)
	prefix := strconv.FormatInt(id, 10) + "|"
	for k := range s.cond {
		if len(k) > len(prefix) && k[:len(prefix)] == prefix {
			delete(s.cond, k)
		}
	}
	for k := range s.runs {
		if len(k) > len(prefix) && k[:len(prefix)] == prefix {
			delete(s.runs, k)
		}
	}
}
