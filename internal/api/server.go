package api

import (
	"github.com/saschazesiger/Z-Dash/server"

	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// Deps is what the server is built from.
type Deps struct {
	// App is the Z-Dash server CI-Plane runs on: it serves the interface,
	// signs people in (the password locally, Cloudflare Access through the
	// tunnel), sets up the tunnel and carries the live updates. New
	// registers CI-Plane's routes on it.
	App     *server.App
	Store   *store.Store
	Engine  *engine.Engine
	Workers Workers
	GitHub  GitHub
	Relay   Relay       // runs the runners of the pools; may be nil
	Box     *secret.Box // the tokens that read the billing of personal accounts; may be nil
	Version string

	// Demo marks the demo: the setup assistant counts the password as done.
	Demo bool
	// Extra is mounted under /demo/ (the pages that stand in for GitHub in
	// demo mode); nil in production.
	Extra http.Handler
	// Logf receives diagnostics; nil discards them.
	Logf func(format string, args ...any)
}

// Server is CI-Plane's API on the Z-Dash server.
type Server struct {
	d      Deps
	tasks  *tasks
	ctx    context.Context // lives as long as the server; tasks run in it
	cancel context.CancelFunc

	syncMu sync.Mutex // one GitHub sync at a time

	webhooksTried time.Time // the last time followTunnel asked GitHub; it waits a minute between tries
}

// New registers CI-Plane's routes on d.App. It hooks itself to the
// engine's OnChange (keeping a handler that was set before) for live
// updates.
func New(d Deps) *Server {
	if d.Logf == nil {
		d.Logf = func(string, ...any) {}
	}
	if d.Version == "" {
		d.Version = "dev"
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{d: d, ctx: ctx, cancel: cancel}
	s.tasks = newTasks(ctx, func() { d.App.Notify("tasks") })
	if d.Engine != nil {
		prev := d.Engine.OnChange
		d.Engine.OnChange = func() {
			if prev != nil {
				prev()
			}
			d.App.Notify("state")
		}
	}
	s.routes()
	return s
}

// Run does the periodic work of the server until ctx ends: it tells the
// interface every few seconds that live values (load, memory, disk) moved.
func (s *Server) Run(ctx context.Context) {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-s.ctx.Done():
			return
		case <-t.C:
			s.d.App.Notify("live")
			s.followTunnel(ctx)
		}
	}
}

// followTunnel points the webhooks of the GitHub Apps at the tunnel's
// address when it changed: the Z-Dash server sets the tunnel up (and
// repairs or moves it) on its own, so CI-Plane follows what it reports
// rather than a step of its own setup. The address the webhooks point at is
// kept, so a restart does not ask GitHub again.
func (s *Server) followTunnel(ctx context.Context) {
	st := s.d.App.Tunnel().Status()
	if s.d.GitHub == nil || !st.Configured || !st.Verified || st.PublicURL == "" || st.Job.Running {
		return
	}
	var have string
	_ = s.d.Store.View(func(tx *store.Tx) error {
		b, err := tx.Get("github.webhookBase")
		have = string(b)
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		return err
	})
	if have == st.PublicURL {
		return
	}
	if !s.hasAccounts() {
		_ = s.d.Store.Tx(func(tx *store.Tx) error { return tx.Set("github.webhookBase", []byte(st.PublicURL)) })
		return
	}
	if time.Since(s.webhooksTried) < time.Minute {
		return
	}
	s.webhooksTried = time.Now()
	pub := st.PublicURL
	s.tasks.start("github", "webhooks", "Point the webhooks of the GitHub Apps to "+pub+"/webhook", 5*time.Minute,
		func(ctx context.Context, progress func(string)) (string, error) {
			progress("Pointing the webhooks of the GitHub Apps to " + pub + "/webhook")
			if err := s.d.GitHub.SetPublicURL(ctx, pub); err != nil {
				return "", fmt.Errorf("the GitHub Apps still send their webhooks to the old address: %v. CI-Plane tries again in a moment", err)
			}
			if err := s.d.Store.Tx(func(tx *store.Tx) error { return tx.Set("github.webhookBase", []byte(pub)) }); err != nil {
				return "", err
			}
			return "The GitHub Apps send their webhooks to " + pub + "/webhook.", nil
		})
}

// Close stops running tasks.
func (s *Server) Close() { s.cancel() }

// Changed tells the interface that something it shows changed.
func (s *Server) Changed() { s.d.App.Notify("state") }

// routes registers CI-Plane's API. Every /api/ route is for signed-in people
// and passes the server's CSRF guard; /github/return and /demo/ are pages a
// browser reaches by a navigation, without a session.
func (s *Server) routes() {
	app := s.d.App
	app.Public("GET /github/return", s.githubReturn)
	if s.d.Extra != nil {
		app.Unguarded("/demo/", s.d.Extra.ServeHTTP)
	}

	app.HandleFunc("GET /api/setup", s.setupState)
	app.HandleFunc("POST /api/setup/finish", s.setupFinish)

	app.HandleFunc("GET /api/overview", s.overview)
	app.HandleFunc("GET /api/pools", s.listPools)
	app.HandleFunc("POST /api/pools", s.addPool)
	app.HandleFunc("PATCH /api/pools/{id}", s.editPool)
	app.HandleFunc("DELETE /api/pools/{id}", s.removePool)
	app.HandleFunc("POST /api/pools/{id}/check", s.checkPool)
	app.HandleFunc("POST /api/pools/{id}/resume", s.resumePool)
	app.HandleFunc("GET /api/jobs", s.listJobs)
	app.HandleFunc("GET /api/jobs/{id}", s.getJob)

	app.HandleFunc("GET /api/workers", s.listWorkers)
	app.HandleFunc("GET /api/workers/commands", s.workerCommands)
	app.HandleFunc("POST /api/workers/check", s.checkWorker)
	app.HandleFunc("POST /api/workers", s.addWorker)
	app.HandleFunc("POST /api/workers/order", s.orderWorkers)
	app.HandleFunc("GET /api/workers/{id}", s.getWorker)
	app.HandleFunc("PATCH /api/workers/{id}", s.editWorker)
	app.HandleFunc("DELETE /api/workers/{id}", s.removeWorker)
	app.HandleFunc("POST /api/workers/{id}/cleanup", s.cleanupWorker)
	app.HandleFunc("POST /api/workers/{id}/prepare", s.prepareWorker)

	app.HandleFunc("GET /api/accounts", s.listAccounts)
	app.HandleFunc("PATCH /api/accounts/{id}", s.editAccount)
	app.HandleFunc("DELETE /api/accounts/{id}", s.removeAccount)
	app.HandleFunc("POST /api/accounts/{id}/sync", s.syncAccount)
	app.HandleFunc("GET /api/runner-accounts", s.listRunnerAccounts)
	app.HandleFunc("POST /api/runner-accounts/manifest", s.runnerManifest)
	app.HandleFunc("DELETE /api/runner-accounts/{id}", s.removeRunnerAccount)
	app.HandleFunc("POST /api/runner-accounts/{id}/sync", s.syncRunnerAccount)
	app.HandleFunc("PATCH /api/repos/{id}", s.editRepo)
	app.HandleFunc("DELETE /api/repos/{id}", s.removeRepo)

	app.HandleFunc("GET /api/settings", s.getSettings)
	app.HandleFunc("POST /api/settings/validate", s.validateSettings)
	app.HandleFunc("PUT /api/settings", s.saveSettings)

	app.HandleFunc("POST /api/github/manifest", s.githubManifest)
	app.HandleFunc("POST /api/github/complete", s.githubComplete)
	app.HandleFunc("POST /api/github/installed", s.githubInstalled)
	app.HandleFunc("POST /api/github/sync", s.githubSync)

	app.HandleFunc("GET /api/tasks", s.listTasks)
	app.HandleFunc("GET /api/tasks/{id}", s.getTask)
}

// githubReturn is where GitHub sends the browser back to, after creating an
// app (?code&state) and after installing it (?installation_id). The page
// finishes the step itself, with a signed-in request, so this answer needs
// no session (the SameSite=Strict cookie is not sent on a navigation that
// comes from github.com).
func (s *Server) githubReturn(w http.ResponseWriter, r *http.Request) {
	q := url.Values{}
	for _, k := range []string{"code", "state", "installation_id", "setup_action"} {
		if v := r.URL.Query().Get(k); v != "" {
			q.Set(k, v)
		}
	}
	http.Redirect(w, r, "/#/github?"+q.Encode(), http.StatusSeeOther)
}

// --- JSON helpers ------------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(true)
	_ = enc.Encode(v)
}

// apiError is the body of every failed request: one sentence for the user,
// and field errors where a form was checked.
type apiError struct {
	Error  string            `json:"error"`
	Fields map[string]string `json:"fields,omitempty"`
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, apiError{Error: msg})
}

func (s *Server) fail(w http.ResponseWriter, err error) {
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "This item does not exist any more. Reload the page.")
		return
	}
	s.d.Logf("api: %v", err)
	writeError(w, http.StatusInternalServerError, "Something went wrong on the server: "+err.Error())
}

// decode reads a JSON body; on failure it has answered already.
func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil && !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "The request could not be read: "+err.Error())
		return false
	}
	return true
}

func pathID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	var id int64
	if _, err := fmt.Sscan(r.PathValue("id"), &id); err != nil || id <= 0 {
		writeError(w, http.StatusNotFound, "This item does not exist.")
		return 0, false
	}
	return id, true
}

// Webhooks answers the paths Cloudflare Access lets through without a login
// (the server's bypass path /webhook): GitHub's webhooks, checked by their
// signature, and below them /webhook/relay, where runs of the relay
// workflow collect their runner with the run's OIDC token as proof.
func Webhooks(webhook http.Handler, relay Relay) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/webhook":
			if webhook == nil {
				http.Error(w, "webhooks are not set up", http.StatusServiceUnavailable)
				return
			}
			webhook.ServeHTTP(w, r)
		case "/webhook/relay":
			if relay == nil {
				http.Error(w, "pools of other providers are not available here", http.StatusServiceUnavailable)
				return
			}
			relay.ServeHTTP(w, r)
		default:
			http.NotFound(w, r)
		}
	})
}

func (s *Server) hasAccounts() bool {
	n := 0
	_ = s.d.Store.View(func(tx *store.Tx) error {
		as, err := tx.Accounts()
		n = len(as)
		return err
	})
	return n > 0
}
