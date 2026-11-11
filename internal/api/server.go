package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
	"github.com/saschazesiger/CI-Plane/web"
)

// Deps is what the server is built from.
type Deps struct {
	Store      *store.Store
	Engine     *engine.Engine
	Workers    Workers
	GitHub     GitHub
	Cloudflare Cloudflare
	Relay      Relay       // the failover to GitHub-hosted runners; may be nil
	Box        *secret.Box // reserved for secrets the API itself may store later; may be nil
	Version    string

	// Demo skips the login: every visitor is signed in.
	Demo bool
	// ResetPassword, if set, becomes the admin password at start
	// (CI_PLANE_ADMIN_PASSWORD) and signs everybody out.
	ResetPassword string
	// Hosts are extra names the local listener answers to (CI_PLANE_HOSTS).
	Hosts []string
	// Assets is the web interface; nil means the embedded one.
	Assets fs.FS
	// Extra is mounted under /demo/ on both listeners (the pages that stand
	// in for GitHub in demo mode); nil in production.
	Extra http.Handler
	// Logf receives diagnostics; nil discards them.
	Logf func(format string, args ...any)
}

// Server serves the interface and its API.
type Server struct {
	d      Deps
	auth   *auth
	hub    *hub
	tasks  *tasks
	assets *assets
	ctx    context.Context // lives as long as the server; tasks run in it
	cancel context.CancelFunc

	syncMu sync.Mutex // one GitHub sync at a time
}

// New builds a server. It hooks itself to the engine's OnChange (keeping
// a handler that was set before) for live updates.
func New(d Deps) *Server {
	if d.Logf == nil {
		d.Logf = func(string, ...any) {}
	}
	if d.Assets == nil {
		d.Assets = web.FS
	}
	if d.Version == "" {
		d.Version = "dev"
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := &Server{d: d, hub: newHub(), ctx: ctx, cancel: cancel}
	s.tasks = newTasks(ctx, func() { s.hub.notify("tasks") })
	s.auth = newAuth(d.Store, d.Logf)
	if d.ResetPassword != "" {
		if err := s.auth.setPassword(d.ResetPassword); err != nil {
			d.Logf("CI_PLANE_ADMIN_PASSWORD: %v", err)
		} else {
			s.auth.dropSessions("")
			d.Logf("The admin password was set from CI_PLANE_ADMIN_PASSWORD; everybody was signed out")
		}
	}
	a, err := loadAssets(d.Assets)
	if err != nil {
		d.Logf("web interface: %v", err)
	}
	s.assets = a
	if d.Engine != nil {
		prev := d.Engine.OnChange
		d.Engine.OnChange = func() {
			if prev != nil {
				prev()
			}
			s.hub.notify("state")
		}
	}
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
			s.hub.notify("live")
		}
	}
}

// Close stops running tasks and live streams.
func (s *Server) Close() {
	s.cancel()
	s.hub.close()
}

// Changed tells the interface that something it shows changed.
func (s *Server) Changed() { s.hub.notify("state") }

// identity says who sent a request.
type identity struct {
	Via   string // "local" or "tunnel"
	Email string // from Cloudflare Access; empty on the local listener
}

type ctxKey int

const identityKey ctxKey = 1

func via(r *http.Request) identity {
	if id, ok := r.Context().Value(identityKey).(identity); ok {
		return id
	}
	return identity{Via: "local"}
}

// Local is the handler of the listener on the local network: interface, API,
// first-run password, health check.
func (s *Server) Local() http.Handler {
	mux := http.NewServeMux()
	s.routes(mux)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("POST /api/login", s.guard(s.login))
	mux.HandleFunc("POST /api/setup/password", s.guard(s.firstPassword))
	return s.localHost(s.headers(mux))
}

// localHost refuses requests whose Host header is a public-looking name.
// That is what a DNS rebinding attack looks like: a website the admin has
// open points its own name at this address to talk to CI-Plane as if it were
// the same site. Addresses, single-label and private names are fine; other
// names are listed in CI_PLANE_HOSTS.
func (s *Server) localHost(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !s.d.Demo && !localName(r.Host, s.d.Hosts) {
			http.Error(w, "CI-Plane does not know the name "+strconv.Quote(r.Host)+". Open it by its IP address, or add the name to the environment variable CI_PLANE_HOSTS.", http.StatusForbidden)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func localName(hostport string, extra []string) bool {
	host := hostport
	if h, _, err := net.SplitHostPort(hostport); err == nil {
		host = h
	}
	host = strings.ToLower(strings.TrimSuffix(strings.Trim(host, "[]"), "."))
	if host == "" || net.ParseIP(host) != nil || !strings.Contains(host, ".") {
		return host != ""
	}
	for _, suffix := range []string{".localhost", ".local", ".lan", ".internal", ".home.arpa", ".home", ".intranet", ".ts.net"} {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	for _, e := range extra {
		if strings.EqualFold(strings.TrimSpace(e), host) {
			return true
		}
	}
	return false
}

// Tunnel is the handler of the listener that only cloudflared reaches.
// /webhook goes to the webhook handler and nowhere else; every other request
// needs a valid Cloudflare Access identity, which signs the user in.
func (s *Server) Tunnel(webhook http.Handler) http.Handler {
	mux := http.NewServeMux()
	s.routes(mux)
	inner := s.headers(mux)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/webhook" {
			if webhook == nil {
				http.Error(w, "webhooks are not set up", http.StatusServiceUnavailable)
				return
			}
			webhook.ServeHTTP(w, r)
			return
		}
		// Runs of the relay workflow collect their runner here. It lives
		// below /webhook because Cloudflare Access lets that path through
		// without a login; the run's OIDC token is its proof.
		if r.URL.Path == "/webhook/relay" {
			if s.d.Relay == nil {
				http.Error(w, "the failover to GitHub-hosted runners is not available", http.StatusServiceUnavailable)
				return
			}
			s.d.Relay.ServeHTTP(w, r)
			return
		}
		var email string
		var err error
		if s.d.Cloudflare != nil {
			email, err = s.d.Cloudflare.Authenticate(r)
		} else {
			err = errors.New("Cloudflare is not set up")
		}
		if err != nil || email == "" {
			s.d.Logf("tunnel: refused %s %q: %v", r.Method, r.URL.Path, err)
			setSecurityHeaders(w)
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusForbidden)
			io.WriteString(w, "Forbidden: sign in through Cloudflare Access with an allowed e-mail address.\n")
			return
		}
		ctx := context.WithValue(r.Context(), identityKey, identity{Via: "tunnel", Email: email})
		inner.ServeHTTP(w, r.WithContext(ctx))
	})
}

// routes registers what both listeners serve.
func (s *Server) routes(mux *http.ServeMux) {
	mux.Handle("/", s.assets) // GET and HEAD only, checked by the handler
	mux.HandleFunc("GET /github/return", s.githubReturn)
	if s.d.Extra != nil {
		mux.Handle("/demo/", s.d.Extra)
	}

	mux.HandleFunc("GET /api/session", s.session)
	mux.HandleFunc("POST /api/logout", s.guard(s.logout))
	mux.HandleFunc("GET /api/events", s.private(s.events))
	mux.HandleFunc("POST /api/password", s.private(s.changePassword))

	mux.HandleFunc("GET /api/setup", s.private(s.setupState))
	mux.HandleFunc("POST /api/setup/finish", s.private(s.setupFinish))

	mux.HandleFunc("GET /api/overview", s.private(s.overview))
	mux.HandleFunc("GET /api/relay", s.private(s.relayState))
	mux.HandleFunc("POST /api/relay/check", s.private(s.relayCheck))
	mux.HandleFunc("GET /api/jobs", s.private(s.listJobs))
	mux.HandleFunc("GET /api/jobs/{id}", s.private(s.getJob))

	mux.HandleFunc("GET /api/workers", s.private(s.listWorkers))
	mux.HandleFunc("GET /api/workers/commands", s.private(s.workerCommands))
	mux.HandleFunc("POST /api/workers/check", s.private(s.checkWorker))
	mux.HandleFunc("POST /api/workers", s.private(s.addWorker))
	mux.HandleFunc("POST /api/workers/order", s.private(s.orderWorkers))
	mux.HandleFunc("GET /api/workers/{id}", s.private(s.getWorker))
	mux.HandleFunc("PATCH /api/workers/{id}", s.private(s.editWorker))
	mux.HandleFunc("DELETE /api/workers/{id}", s.private(s.removeWorker))
	mux.HandleFunc("POST /api/workers/{id}/cleanup", s.private(s.cleanupWorker))
	mux.HandleFunc("POST /api/workers/{id}/prepare", s.private(s.prepareWorker))

	mux.HandleFunc("GET /api/accounts", s.private(s.listAccounts))
	mux.HandleFunc("PATCH /api/accounts/{id}", s.private(s.editAccount))
	mux.HandleFunc("DELETE /api/accounts/{id}", s.private(s.removeAccount))
	mux.HandleFunc("POST /api/accounts/{id}/sync", s.private(s.syncAccount))
	mux.HandleFunc("PATCH /api/repos/{id}", s.private(s.editRepo))
	mux.HandleFunc("DELETE /api/repos/{id}", s.private(s.removeRepo))

	mux.HandleFunc("GET /api/settings", s.private(s.getSettings))
	mux.HandleFunc("POST /api/settings/validate", s.private(s.validateSettings))
	mux.HandleFunc("PUT /api/settings", s.private(s.saveSettings))

	mux.HandleFunc("GET /api/cloudflare", s.private(s.cloudflareStatus))
	mux.HandleFunc("POST /api/cloudflare/zones", s.private(s.cloudflareZones))
	mux.HandleFunc("POST /api/cloudflare/setup", s.private(s.cloudflareSetup))
	mux.HandleFunc("PUT /api/cloudflare/emails", s.private(s.cloudflareEmails))
	mux.HandleFunc("DELETE /api/cloudflare", s.private(s.cloudflareRemove))

	mux.HandleFunc("POST /api/github/manifest", s.private(s.githubManifest))
	mux.HandleFunc("POST /api/github/complete", s.private(s.githubComplete))
	mux.HandleFunc("POST /api/github/installed", s.private(s.githubInstalled))
	mux.HandleFunc("POST /api/github/sync", s.private(s.githubSync))

	mux.HandleFunc("GET /api/tasks", s.private(s.listTasks))
	mux.HandleFunc("GET /api/tasks/{id}", s.private(s.getTask))

	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "This API address does not exist.")
	})
}

// --- middleware --------------------------------------------------------------

const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; " +
	"connect-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"

func setSecurityHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Security-Policy", csp)
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	h.Set("X-Frame-Options", "DENY")
	h.Set("Cross-Origin-Opener-Policy", "same-origin")
	h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
}

func (s *Server) headers(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		setSecurityHeaders(w)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, r)
	})
}

// guard refuses state-changing requests that may come from another site:
// they must carry the header X-CI-Plane, which a cross-site form cannot set
// and a cross-site script cannot send without a CORS approval we never give,
// and an Origin, when the browser sends one, must be this host.
func (s *Server) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if r.Header.Get("X-CI-Plane") != "1" {
				writeError(w, http.StatusForbidden, "This request was refused: it did not come from the CI-Plane interface. Reload the page and try again.")
				return
			}
			if o := r.Header.Get("Origin"); o != "" {
				u, err := url.Parse(o)
				if err != nil || !strings.EqualFold(u.Host, r.Host) {
					writeError(w, http.StatusForbidden, "This request was refused: it came from another website.")
					return
				}
			}
		}
		h(w, r)
	}
}

// private is guard plus a signed-in user.
func (s *Server) private(h http.HandlerFunc) http.HandlerFunc {
	return s.guard(func(w http.ResponseWriter, r *http.Request) {
		if !s.signedIn(r) {
			writeError(w, http.StatusUnauthorized, "You are not signed in. Reload the page and sign in.")
			return
		}
		h(w, r)
	})
}

func (s *Server) signedIn(r *http.Request) bool {
	if s.d.Demo || via(r).Via == "tunnel" {
		return true
	}
	return s.auth.check(r)
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

// origin is the address the browser uses for this server: the tunnel's
// public https address, or the local one.
func origin(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || via(r).Via == "tunnel" {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

// clientIP is the address a request came from, for rate limits.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
