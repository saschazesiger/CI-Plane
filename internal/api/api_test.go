package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/sim"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// --- stand-ins for the services --------------------------------------------------

type fakeWorkers struct {
	mu       sync.Mutex
	changed  int
	checkErr error
	gate     chan struct{} // Prepare waits for it when set
	prepared int
	cleaned  int
	status   map[int64]engine.WorkerStatus
}

func (f *fakeWorkers) PublicKey() string     { return "ssh-ed25519 AAAA test" }
func (f *fakeWorkers) SetupCommand() string  { return "setup-command" }
func (f *fakeWorkers) RemoveCommand() string { return "remove-command" }
func (f *fakeWorkers) Check(ctx context.Context, host string, port int, user string) (WorkerFacts, error) {
	if f.checkErr != nil {
		return WorkerFacts{}, f.checkErr
	}
	return WorkerFacts{HostKey: "ssh-ed25519 AAAAkey", Fingerprint: "SHA256:abc", CPUs: 8, MemMB: 32768, DiskMB: 500000, DiskFreeMB: 400000, Docker: "28.0"}, nil
}
func (f *fakeWorkers) Prepare(ctx context.Context, w model.Worker, progress func(string)) error {
	progress("Pulling the runner image")
	if f.gate != nil {
		select {
		case <-f.gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	progress("Running a test container")
	f.mu.Lock()
	f.prepared++
	f.mu.Unlock()
	return nil
}
func (f *fakeWorkers) Cleanup(ctx context.Context, w model.Worker) (string, error) {
	f.mu.Lock()
	f.cleaned++
	f.mu.Unlock()
	return "1 GB freed", nil
}
func (f *fakeWorkers) Changed() {
	f.mu.Lock()
	f.changed++
	f.mu.Unlock()
}
func (f *fakeWorkers) Status(id int64) engine.WorkerStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status[id]
}
func (f *fakeWorkers) changes() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.changed
}

type fakeGitHub struct {
	mu        sync.Mutex
	st        *store.Store
	synced    []int64
	publicURL string
	returnURL string
}

func (g *fakeGitHub) Manifest(org, publicURL, returnURL string) (ManifestForm, error) {
	g.mu.Lock()
	g.returnURL = returnURL
	g.mu.Unlock()
	return ManifestForm{Action: "https://github.com/settings/apps/new", Manifest: `{"name":"CI-Plane"}`, State: "st-1"}, nil
}
func (g *fakeGitHub) Complete(ctx context.Context, code, state string) (model.Account, error) {
	if state != "st-1" {
		return model.Account{}, errors.New("unknown state")
	}
	a := model.Account{ID: 77, Slug: "ci-plane-x", Owner: "x", OwnerType: "User", Enabled: true}
	return a, g.st.Tx(func(tx *store.Tx) error { return tx.SaveAccount(a) })
}
func (g *fakeGitHub) InstallURL(a model.Account) string {
	return "https://github.com/apps/" + a.Slug + "/installations/new"
}
func (g *fakeGitHub) Sync(ctx context.Context, id int64) error {
	g.mu.Lock()
	g.synced = append(g.synced, id)
	g.mu.Unlock()
	return nil
}
func (g *fakeGitHub) Remove(ctx context.Context, id int64) (string, error) {
	return "https://github.com/settings/apps/x", g.st.Tx(func(tx *store.Tx) error { return tx.DeleteAccount(id) })
}
func (g *fakeGitHub) SetPublicURL(ctx context.Context, u string) error {
	g.mu.Lock()
	g.publicURL = u
	g.mu.Unlock()
	return nil
}
func (g *fakeGitHub) Health(id int64) AccountHealth { return AccountHealth{RateRemaining: 5000} }

type fakeCloudflare struct {
	mu     sync.Mutex
	st     TunnelStatus
	emails []string
}

func (c *fakeCloudflare) TokenURL() string { return "https://dash.cloudflare.com/profile/api-tokens" }
func (c *fakeCloudflare) Zones(ctx context.Context, token string) ([]Zone, error) {
	if token != "good-token" {
		return nil, errors.New("Cloudflare did not accept this token")
	}
	return []Zone{{ID: "z1", Name: "example.com"}}, nil
}
func (c *fakeCloudflare) Setup(ctx context.Context, req TunnelSetup, progress func(string)) error {
	progress("Creating the tunnel")
	c.mu.Lock()
	c.st = TunnelStatus{Configured: true, Hostname: req.Hostname, PublicURL: "https://" + req.Hostname, Emails: req.Emails, Running: true, Connected: true, Verified: true}
	c.mu.Unlock()
	return nil
}
func (c *fakeCloudflare) Status() TunnelStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.st
}
func (c *fakeCloudflare) SetEmails(ctx context.Context, emails []string) error {
	c.mu.Lock()
	c.emails = emails
	c.mu.Unlock()
	return nil
}
func (c *fakeCloudflare) Remove(ctx context.Context) error {
	c.mu.Lock()
	c.st = TunnelStatus{}
	c.mu.Unlock()
	return nil
}
func (c *fakeCloudflare) Authenticate(r *http.Request) (string, error) {
	if r.Header.Get("Cf-Access-Jwt-Assertion") == "valid" {
		return "ada@example.com", nil
	}
	return "", errors.New("no valid Access token")
}

// --- rig -------------------------------------------------------------------------

type rig struct {
	t       *testing.T
	st      *store.Store
	srv     *Server
	local   http.Handler
	workers *fakeWorkers
	gh      *fakeGitHub
	cf      *fakeCloudflare
	cookie  *http.Cookie
}

func newRig(t *testing.T, demo bool) *rig {
	t.Helper()
	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	return newRigOn(t, st, demo, "")
}

func newRigOn(t *testing.T, st *store.Store, demo bool, reset string) *rig {
	t.Helper()
	world := sim.New()
	r := &rig{t: t, st: st, workers: &fakeWorkers{status: map[int64]engine.WorkerStatus{}}, gh: &fakeGitHub{st: st}, cf: &fakeCloudflare{}}
	r.srv = New(Deps{Store: st, Engine: engine.New(st, world, world), Workers: r.workers, GitHub: r.gh, Cloudflare: r.cf,
		Version: "test", Demo: demo, ResetPassword: reset, Logf: t.Logf})
	t.Cleanup(r.srv.Close)
	r.local = r.srv.Local()
	return r
}

type resp struct {
	code   int
	body   map[string]any
	raw    string
	header http.Header
}

// do sends a request as the interface would: with the header against
// cross-site requests and the session cookie, if any.
func (r *rig) do(h http.Handler, method, path string, body any, mod ...func(*http.Request)) resp {
	r.t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = strings.NewReader(string(b))
	}
	req := httptest.NewRequest(method, path, rd)
	req.Host = "ci.local:8080"
	req.RemoteAddr = "192.168.1.5:5555"
	if method != http.MethodGet {
		req.Header.Set("X-CI-Plane", "1")
	}
	if r.cookie != nil {
		req.AddCookie(r.cookie)
	}
	for _, m := range mod {
		m(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	out := resp{code: rec.Code, raw: rec.Body.String(), header: rec.Header()}
	_ = json.Unmarshal(rec.Body.Bytes(), &out.body)
	for _, c := range rec.Result().Cookies() {
		if c.Name == cookieName {
			if c.MaxAge < 0 {
				r.cookie = nil
			} else {
				r.cookie = c
			}
		}
	}
	return out
}

func (r *rig) local_(method, path string, body any, mod ...func(*http.Request)) resp {
	r.t.Helper()
	return r.do(r.local, method, path, body, mod...)
}

func (r *rig) expect(got resp, code int) resp {
	r.t.Helper()
	if got.code != code {
		r.t.Fatalf("status %d, want %d: %s", got.code, code, got.raw)
	}
	return got
}

// signIn sets the first password and keeps the session.
func (r *rig) signIn() {
	r.t.Helper()
	r.expect(r.local_("POST", "/api/setup/password", map[string]string{"password": "correct horse battery"}), 200)
}

func noHeader(req *http.Request) { req.Header.Del("X-CI-Plane") }

// --- login -----------------------------------------------------------------------

func TestFirstPasswordAndLogin(t *testing.T) {
	r := newRig(t, false)
	s := r.expect(r.local_("GET", "/api/session", nil), 200)
	if s.body["needsPassword"] != true || s.body["signedIn"] != false {
		t.Fatalf("fresh installation: %v", s.body)
	}
	r.expect(r.local_("GET", "/api/overview", nil), 401)
	// Too short, then right; a second first password is refused.
	r.expect(r.local_("POST", "/api/setup/password", map[string]string{"password": "short"}), 400)
	r.signIn()
	if r.cookie == nil || !r.cookie.HttpOnly || r.cookie.SameSite != http.SameSiteStrictMode {
		t.Fatalf("session cookie: %+v", r.cookie)
	}
	r.expect(r.local_("POST", "/api/setup/password", map[string]string{"password": "another password"}), 409)
	s = r.expect(r.local_("GET", "/api/session", nil), 200)
	if s.body["signedIn"] != true || s.body["needsPassword"] != false {
		t.Fatalf("after the first password: %v", s.body)
	}
	r.expect(r.local_("GET", "/api/overview", nil), 200)

	// Sign out: the session is gone, also for a copy of the cookie.
	old := r.cookie
	r.expect(r.local_("POST", "/api/logout", nil), 200)
	r.cookie = old
	r.expect(r.local_("GET", "/api/overview", nil), 401)
	r.cookie = nil

	r.expect(r.local_("POST", "/api/login", map[string]string{"password": "wrong password"}), 401)
	r.expect(r.local_("POST", "/api/login", map[string]string{"password": "correct horse battery"}), 200)
	r.expect(r.local_("GET", "/api/overview", nil), 200)

	// Changing the password signs out other sessions, keeps this one.
	mine := r.cookie
	r.cookie = nil
	r.expect(r.local_("POST", "/api/login", map[string]string{"password": "correct horse battery"}), 200)
	other := r.cookie
	r.cookie = mine
	r.expect(r.local_("POST", "/api/password", map[string]string{"current": "nope nope nope", "password": "a new password!"}), 400)
	r.expect(r.local_("POST", "/api/password", map[string]string{"current": "correct horse battery", "password": "a new password!"}), 200)
	r.expect(r.local_("GET", "/api/overview", nil), 200)
	r.cookie = other
	r.expect(r.local_("GET", "/api/overview", nil), 401)
}

func TestSessionsSurviveARestart(t *testing.T) {
	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	r := newRigOn(t, st, false, "")
	r.signIn()
	r2 := newRigOn(t, st, false, "")
	r2.cookie = r.cookie
	r2.expect(r2.local_("GET", "/api/overview", nil), 200)
}

func TestLoginRateLimit(t *testing.T) {
	r := newRig(t, false)
	r.signIn()
	r.cookie = nil
	now := time.Now()
	r.srv.auth.now = func() time.Time { return now }
	for i := 0; i < 5; i++ {
		r.expect(r.local_("POST", "/api/login", map[string]string{"password": "wrong password"}), 401)
	}
	// Locked: even the right password waits.
	got := r.expect(r.local_("POST", "/api/login", map[string]string{"password": "correct horse battery"}), 429)
	if !strings.Contains(got.body["error"].(string), "Wait") {
		t.Fatalf("message: %v", got.body)
	}
	// Another client is not affected.
	r.expect(r.local_("POST", "/api/login", map[string]string{"password": "correct horse battery"}, func(req *http.Request) { req.RemoteAddr = "192.168.1.6:1" }), 200)
	r.cookie = nil
	now = now.Add(31 * time.Second)
	r.expect(r.local_("POST", "/api/login", map[string]string{"password": "correct horse battery"}), 200)
}

func TestPasswordResetFromEnvironment(t *testing.T) {
	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	r := newRigOn(t, st, false, "")
	r.signIn()
	old := r.cookie

	r2 := newRigOn(t, st, false, "a password from the env")
	r2.cookie = old
	r2.expect(r2.local_("GET", "/api/overview", nil), 401) // everybody signed out
	r2.cookie = nil
	r2.expect(r2.local_("POST", "/api/login", map[string]string{"password": "correct horse battery"}), 401)
	r2.expect(r2.local_("POST", "/api/login", map[string]string{"password": "a password from the env"}), 200)
	if s := r2.expect(r2.local_("GET", "/api/session", nil), 200); s.body["needsPassword"] != false {
		t.Fatal("a reset password must count as set")
	}
}

func TestCrossSiteRequestsAreRefused(t *testing.T) {
	r := newRig(t, false)
	r.expect(r.local_("POST", "/api/setup/password", map[string]string{"password": "correct horse battery"}, noHeader), 403)
	r.signIn()
	r.expect(r.local_("PUT", "/api/settings", model.DefaultSettings(), noHeader), 403)
	evil := func(req *http.Request) { req.Header.Set("Origin", "https://evil.example") }
	r.expect(r.local_("PUT", "/api/settings", model.DefaultSettings(), evil), 403)
	r.expect(r.local_("POST", "/api/logout", nil, evil), 403)
	same := func(req *http.Request) { req.Header.Set("Origin", "http://ci.local:8080") }
	r.expect(r.local_("PUT", "/api/settings", model.DefaultSettings(), same), 200)
}

func TestSecurityHeadersAndAssets(t *testing.T) {
	r := newRig(t, false)
	got := r.expect(r.local_("GET", "/", nil), 200)
	for _, h := range []string{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "X-Frame-Options"} {
		if got.header.Get(h) == "" {
			t.Errorf("missing %s", h)
		}
	}
	if !strings.Contains(got.header.Get("Content-Security-Policy"), "script-src 'self'") || strings.Contains(got.header.Get("Content-Security-Policy"), "unsafe-inline") {
		t.Errorf("CSP: %s", got.header.Get("Content-Security-Policy"))
	}
	if !strings.Contains(got.raw, `type="module" src="app/main.js"`) {
		t.Fatal("index.html does not load the app")
	}
	js := r.expect(r.local_("GET", "/app/main.js", nil), 200)
	etag := js.header.Get("ETag")
	if etag == "" || !strings.Contains(js.header.Get("Cache-Control"), "max-age") || !strings.HasPrefix(js.header.Get("Content-Type"), "text/javascript") {
		t.Fatalf("asset headers: %v", js.header)
	}
	r.expect(r.local_("GET", "/app/main.js", nil, func(req *http.Request) { req.Header.Set("If-None-Match", etag) }), 304)
	r.expect(r.local_("GET", "/vendor/dashboard-style/ds.js", nil), 200)
	r.expect(r.local_("GET", "/vendor/dashboard-style/tools/verify.mjs", nil), 404)
	r.expect(r.local_("GET", "/healthz", nil), 200)
	r.expect(r.local_("GET", "/api/nothing", nil), 404)
}

// --- the tunnel listener ----------------------------------------------------------

func TestTunnelListener(t *testing.T) {
	r := newRig(t, false)
	var hooks []string
	webhook := http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hooks = append(hooks, req.Method+" "+req.URL.Path)
		w.WriteHeader(http.StatusAccepted)
	})
	tun := r.srv.Tunnel(webhook)
	call := func(method, path string, valid bool, body any) resp {
		return r.do(tun, method, path, body, func(req *http.Request) {
			req.Host = "ci.example.com"
			req.RemoteAddr = "127.0.0.1:4000"
			if valid {
				req.Header.Set("Cf-Access-Jwt-Assertion", "valid")
			}
		})
	}
	// /webhook reaches the webhook handler only, whatever the method, without Access.
	r.expect(call("POST", "/webhook", false, map[string]string{"x": "y"}), 202)
	r.expect(call("GET", "/webhook", false, nil), 202)
	if len(hooks) != 2 {
		t.Fatalf("webhook calls: %v", hooks)
	}
	// Everything else needs a valid Access identity.
	for _, p := range []string{"/", "/api/session", "/api/overview", "/app/main.js", "/webhook/x", "/healthz"} {
		if got := call("GET", p, false, nil); got.code != 403 {
			t.Errorf("%s without Access: %d", p, got.code)
		}
	}
	if len(hooks) != 2 {
		t.Fatalf("the webhook handler saw other requests: %v", hooks)
	}
	// With Access: signed in as that e-mail, without a password.
	s := r.expect(call("GET", "/api/session", true, nil), 200)
	if s.body["signedIn"] != true || s.body["email"] != "ada@example.com" || s.body["via"] != "tunnel" || s.body["needsPassword"] != false {
		t.Fatalf("session through the tunnel: %v", s.body)
	}
	r.expect(call("GET", "/api/overview", true, nil), 200)
	r.expect(call("GET", "/", true, nil), 200)
	// The first-password and login endpoints are never served here.
	r.expect(call("POST", "/api/setup/password", true, map[string]string{"password": "correct horse battery"}), 404)
	r.expect(call("POST", "/api/login", true, map[string]string{"password": "correct horse battery"}), 404)
	if r.srv.auth.hasPassword() {
		t.Fatal("a password was set through the tunnel")
	}
	// The manifest's return URL is the tunnel's own https address.
	r.cf.st = TunnelStatus{Configured: true, PublicURL: "https://ci.example.com"}
	r.expect(call("POST", "/api/github/manifest", true, map[string]string{"org": ""}), 200)
	if r.gh.returnURL != "https://ci.example.com/github/return" {
		t.Fatalf("return URL: %s", r.gh.returnURL)
	}
}

// --- mutations -------------------------------------------------------------------

func waitTask(t *testing.T, r *rig, id string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		got := r.expect(r.local_("GET", "/api/tasks/"+id, nil), 200)
		if got.body["state"] != TaskRunning {
			return got.body
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("task did not end")
	return nil
}

func TestAddWorkerAndPrepareOnce(t *testing.T) {
	r := newRig(t, false)
	r.signIn()
	r.workers.gate = make(chan struct{})

	r.expect(r.local_("POST", "/api/workers/check", map[string]any{"host": ""}), 400)
	r.workers.checkErr = errors.New("Could not connect: connection refused")
	bad := r.expect(r.local_("POST", "/api/workers/check", map[string]any{"host": "build-1.lan"}), 502)
	if !strings.Contains(bad.body["error"].(string), "connection refused") {
		t.Fatalf("error: %v", bad.body)
	}
	r.workers.checkErr = nil
	got := r.expect(r.local_("POST", "/api/workers/check", map[string]any{"host": "ci-plane@build-1.lan:2222"}), 200)
	if got.body["host"] != "build-1.lan" || got.body["port"].(float64) != 2222 || got.body["user"] != "ci-plane" {
		t.Fatalf("address not taken apart: %v", got.body)
	}
	facts := got.body["facts"]

	before := r.workers.changes()
	added := r.expect(r.local_("POST", "/api/workers", map[string]any{"host": "build-1.lan", "port": 2222, "tier": 1, "facts": facts}), 201)
	w := added.body["worker"].(map[string]any)
	if w["name"] != "build-1" || w["hostKey"] != "ssh-ed25519 AAAAkey" || w["cpus"].(float64) != 8 {
		t.Fatalf("stored worker: %v", w)
	}
	if r.workers.changes() <= before {
		t.Fatal("Workers.Changed was not called")
	}
	task := added.body["task"].(map[string]any)
	id := task["id"].(string)

	// The same server twice is refused.
	r.expect(r.local_("POST", "/api/workers/check", map[string]any{"host": "build-1.lan", "port": 2222}), 409)

	// While it runs, a second start returns the same task.
	again := r.expect(r.local_("POST", "/api/workers/1/prepare", nil), 200)
	if again.body["task"].(map[string]any)["id"] != id {
		t.Fatalf("prepare ran twice: %v", again.body)
	}
	var running resp
	for i := 0; i < 200; i++ {
		running = r.expect(r.local_("GET", "/api/tasks/"+id, nil), 200)
		if len(running.body["steps"].([]any)) > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if running.body["state"] != TaskRunning || len(running.body["steps"].([]any)) != 1 {
		t.Fatalf("progress while running: %v", running.body)
	}
	close(r.workers.gate)
	done := waitTask(t, r, id)
	if done["state"] != TaskDone || len(done["steps"].([]any)) != 2 {
		t.Fatalf("task: %v", done)
	}
	if r.workers.prepared != 1 {
		t.Fatalf("prepared %d times", r.workers.prepared)
	}
	// The worker list remembers its task, for a reload.
	list := r.expect(r.local_("GET", "/api/workers", nil), 200)
	if list.body["workers"].([]any)[0].(map[string]any)["task"].(map[string]any)["id"] != id {
		t.Fatal("the task is not shown with its worker")
	}
}

func addWorker(t *testing.T, r *rig, name string, tier int) int64 {
	t.Helper()
	var w model.Worker
	if err := r.st.Tx(func(tx *store.Tx) error {
		var err error
		w, err = tx.AddWorker(model.Worker{Name: name, Host: name + ".lan", Port: 22, User: "ci-plane", Tier: tier, Enabled: true, CPUs: 8, MemMB: 16384})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return w.ID
}

func TestEditOrderAndRemoveWorkers(t *testing.T) {
	r := newRig(t, false)
	r.signIn()
	a := addWorker(t, r, "a", 1)
	b := addWorker(t, r, "b", 1)
	c := addWorker(t, r, "c", 2)

	r.expect(r.local_("PATCH", "/api/workers/1", map[string]any{"name": "B"}), 400) // taken, case-insensitively
	r.expect(r.local_("PATCH", "/api/workers/1", map[string]any{"tier": 12}), 400)
	r.expect(r.local_("PATCH", "/api/workers/99", map[string]any{"enabled": false}), 404)
	before := r.workers.changes()
	r.expect(r.local_("PATCH", "/api/workers/1", map[string]any{"name": "alpha", "enabled": false, "draining": true}), 200)
	if r.workers.changes() == before {
		t.Fatal("Workers.Changed was not called")
	}
	var wa model.Worker
	_ = r.st.View(func(tx *store.Tx) error { wa, _ = tx.Worker(a); return nil })
	if wa.Name != "alpha" || wa.Enabled || !wa.Draining {
		t.Fatalf("edit: %+v", wa)
	}

	// One call moves c to the top of tier 1 and b down to tier 2.
	r.expect(r.local_("POST", "/api/workers/order", map[string]any{"order": []map[string]int64{{"id": c, "tier": 1}, {"id": a, "tier": 1}, {"id": b, "tier": 2}}}), 200)
	var ws []model.Worker
	_ = r.st.View(func(tx *store.Tx) error { ws, _ = tx.Workers(); return nil })
	got := []string{}
	for _, w := range ws {
		got = append(got, w.Name+":"+string(rune('0'+w.Tier)))
	}
	if strings.Join(got, ",") != "c:1,alpha:1,b:2" {
		t.Fatalf("order: %v", got)
	}
	r.expect(r.local_("POST", "/api/workers/order", map[string]any{"order": []map[string]int64{{"id": a, "tier": 1}, {"id": a, "tier": 2}}}), 400)

	// Removal is refused while runners are active, unless forced.
	_ = r.st.Tx(func(tx *store.Tx) error {
		if err := tx.SaveJob(model.Job{ID: 5, AccountID: 1, RepoID: 1, Repo: "x/y", State: model.JobAssigned, RunnerID: "r1"}); err != nil {
			return err
		}
		return tx.SaveRunner(model.Runner{ID: "r1", Name: "ci-plane-b-r1", WorkerID: b, JobID: 5, State: model.RunnerStarting, CPUs: 2, MemMB: 4096})
	})
	refused := r.expect(r.local_("DELETE", "/api/workers/"+itoa(b), nil), 409)
	if refused.body["runners"].(float64) != 1 {
		t.Fatalf("refusal: %v", refused.body)
	}
	done := r.expect(r.local_("DELETE", "/api/workers/"+itoa(b)+"?force=true", nil), 200)
	if done.body["removeCommand"] != "remove-command" {
		t.Fatalf("remove: %v", done.body)
	}
	_ = r.st.View(func(tx *store.Tx) error {
		if _, err := tx.Worker(b); !errors.Is(err, store.ErrNotFound) {
			t.Error("worker still stored")
		}
		rn, _ := tx.Runner("r1")
		j, _ := tx.Job(5)
		if rn.State != model.RunnerCleaning || j.State != model.JobQueued || j.RunnerID != "" {
			t.Errorf("runner %s, job %s %q", rn.State, j.State, j.RunnerID)
		}
		return nil
	})
	r.expect(r.local_("POST", "/api/workers/"+itoa(a)+"/cleanup", nil), 200)
	if r.workers.cleaned != 1 {
		t.Fatal("cleanup not called")
	}
	// The detail lists events of the worker.
	detail := r.expect(r.local_("GET", "/api/workers/"+itoa(a), nil), 200)
	if len(detail.body["events"].([]any)) == 0 {
		t.Fatal("no events of the worker")
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func TestAccountsReposAndSettings(t *testing.T) {
	r := newRig(t, false)
	r.signIn()
	_ = r.st.Tx(func(tx *store.Tx) error {
		_ = tx.SaveAccount(model.Account{ID: 9, Owner: "acme", OwnerType: "Organization", InstallationID: 1, Enabled: true})
		return tx.UpsertRepo(model.Repo{ID: 3, AccountID: 9, FullName: "acme/api", Enabled: true, Private: true})
	})
	list := r.expect(r.local_("GET", "/api/accounts", nil), 200)
	acc := list.body["accounts"].([]any)[0].(map[string]any)
	if acc["owner"] != "acme" || len(acc["repos"].([]any)) != 1 || acc["installUrl"] == "" {
		t.Fatalf("accounts: %v", acc)
	}
	r.expect(r.local_("PATCH", "/api/accounts/9", map[string]any{"maxParallel": -1}), 400)
	r.expect(r.local_("PATCH", "/api/accounts/9", map[string]any{"maxParallel": 4, "enabled": false}), 200)
	r.expect(r.local_("PATCH", "/api/repos/3", map[string]any{"maxParallel": 2, "enabled": false}), 200)
	_ = r.st.View(func(tx *store.Tx) error {
		a, _ := tx.Account(9)
		p, _ := tx.Repo(3)
		if a.MaxParallel != 4 || a.Enabled || p.MaxParallel != 2 || p.Enabled {
			t.Errorf("limits: %+v %+v", a, p)
		}
		return nil
	})
	r.expect(r.local_("POST", "/api/accounts/9/sync", nil), 200)
	r.expect(r.local_("DELETE", "/api/repos/3", nil), 200)
	gone := r.expect(r.local_("DELETE", "/api/accounts/9", nil), 200)
	if gone.body["settingsUrl"] == "" {
		t.Fatal("no settings URL")
	}

	// Settings: field errors, then a save.
	set := model.DefaultSettings()
	set.Sizes = append(set.Sizes, model.Size{Name: "size-s", CPUs: 0, MemMB: 100})
	set.DefaultSize = "huge"
	set.IdleTimeoutSec = 5
	bad := r.expect(r.local_("PUT", "/api/settings", set), 400)
	fields := bad.body["fields"].(map[string]any)
	for _, k := range []string{"sizes.4.name", "sizes.4.cpus", "sizes.4.memMb", "defaultSize", "idleTimeoutSec"} {
		if fields[k] == nil {
			t.Errorf("no error for %s: %v", k, fields)
		}
	}
	if !strings.Contains(fields["idleTimeoutSec"].(string), "minutes") {
		t.Errorf("unit in the message: %v", fields["idleTimeoutSec"])
	}
	v := r.expect(r.local_("POST", "/api/settings/validate", set), 200)
	if len(v.body["fields"].(map[string]any)) == 0 {
		t.Fatal("validate found nothing")
	}
	set = model.DefaultSettings()
	set.Sizes[0].Name = " Size-Tiny "
	set.DefaultSize = "size-m"
	r.expect(r.local_("PUT", "/api/settings", set), 200)
	got := r.expect(r.local_("GET", "/api/settings", nil), 200)
	if got.body["settings"].(map[string]any)["sizes"].([]any)[0].(map[string]any)["name"] != "size-tiny" {
		t.Fatalf("saved: %v", got.body)
	}
}

func TestCloudflareAndGitHub(t *testing.T) {
	r := newRig(t, false)
	r.signIn()
	// GitHub needs the public address of the tunnel.
	r.expect(r.local_("POST", "/api/github/manifest", map[string]string{"org": ""}), 409)

	r.expect(r.local_("POST", "/api/cloudflare/zones", map[string]string{"apiToken": "bad"}), 502)
	zones := r.expect(r.local_("POST", "/api/cloudflare/zones", map[string]string{"apiToken": "good-token"}), 200)
	if len(zones.body["zones"].([]any)) != 1 {
		t.Fatal("zones")
	}
	bad := r.expect(r.local_("POST", "/api/cloudflare/setup", map[string]any{"apiToken": "good-token", "zoneId": "z1", "hostname": "ci..x", "emails": []string{"nope"}}), 400)
	if bad.body["fields"].(map[string]any)["emails"] == nil || bad.body["fields"].(map[string]any)["hostname"] == nil {
		t.Fatalf("fields: %v", bad.body)
	}
	// An account exists, so its webhooks move to the new address.
	_ = r.st.Tx(func(tx *store.Tx) error {
		return tx.SaveAccount(model.Account{ID: 1, Owner: "o", OwnerType: "User", Enabled: true})
	})
	started := r.expect(r.local_("POST", "/api/cloudflare/setup", map[string]any{"apiToken": "good-token", "zoneId": "z1", "hostname": "ci.example.com", "emails": []string{"Ada@Example.com, bob@example.com"}}), 200)
	done := waitTask(t, r, started.body["task"].(map[string]any)["id"].(string))
	if done["state"] != TaskDone {
		t.Fatalf("setup: %v", done)
	}
	if r.gh.publicURL != "https://ci.example.com" {
		t.Fatalf("SetPublicURL: %q", r.gh.publicURL)
	}
	if got := r.cf.Status().Emails; strings.Join(got, ",") != "ada@example.com,bob@example.com" {
		t.Fatalf("emails: %v", got)
	}
	r.expect(r.local_("PUT", "/api/cloudflare/emails", map[string]any{"emails": []string{}}), 400)
	r.expect(r.local_("PUT", "/api/cloudflare/emails", map[string]any{"emails": []string{"x@example.com"}}), 200)

	// The manifest's return URL is the address in use; GitHub's way back is a redirect into the page.
	r.expect(r.local_("POST", "/api/github/manifest", map[string]string{"org": "not a name"}), 400)
	r.expect(r.local_("POST", "/api/github/manifest", map[string]string{"org": "acme-labs"}), 200)
	if r.gh.returnURL != "http://ci.local:8080/github/return" {
		t.Fatalf("return URL: %s", r.gh.returnURL)
	}
	back := r.local_("GET", "/github/return?code=c1&state=st-1&evil=1", nil)
	if back.code != http.StatusSeeOther || back.header.Get("Location") != "/#/github?code=c1&state=st-1" {
		t.Fatalf("return: %d %s", back.code, back.header.Get("Location"))
	}
	r.expect(r.local_("POST", "/api/github/complete", map[string]string{"code": "c1", "state": "wrong"}), 502)
	comp := r.expect(r.local_("POST", "/api/github/complete", map[string]string{"code": "c1", "state": "st-1"}), 200)
	if !strings.Contains(comp.body["installUrl"].(string), "installations/new") {
		t.Fatalf("complete: %v", comp.body)
	}
	r.expect(r.local_("POST", "/api/github/installed", map[string]any{"installationId": 5}), 200)
	if len(r.gh.synced) != 2 {
		t.Fatalf("every account is synced after an installation: %v", r.gh.synced)
	}

	setup := r.expect(r.local_("GET", "/api/setup", nil), 200)
	steps := setup.body["steps"].(map[string]any)
	if steps["password"] != true || steps["cloudflare"] != true || steps["github"] != false || setup.body["done"] != false {
		t.Fatalf("setup state: %v", setup.body)
	}
	r.expect(r.local_("POST", "/api/setup/finish", nil), 200)
	if s := r.expect(r.local_("GET", "/api/session", nil), 200); s.body["setupDone"] != true {
		t.Fatal("setup not marked done")
	}
	r.expect(r.local_("DELETE", "/api/cloudflare", nil), 200)
}

func TestDemoNeedsNoLogin(t *testing.T) {
	r := newRig(t, true)
	s := r.expect(r.local_("GET", "/api/session", nil), 200)
	if s.body["signedIn"] != true || s.body["demo"] != true || s.body["needsPassword"] != false {
		t.Fatalf("demo session: %v", s.body)
	}
	r.expect(r.local_("GET", "/api/overview", nil), 200)
}

func TestOverviewAndJobs(t *testing.T) {
	r := newRig(t, false)
	r.signIn()
	w := addWorker(t, r, "w1", 1)
	now := time.Now().UnixMilli()
	_ = r.st.Tx(func(tx *store.Tx) error {
		_ = tx.SaveAccount(model.Account{ID: 1, Owner: "o", OwnerType: "User", Enabled: true})
		_ = tx.SaveJob(model.Job{ID: 1, AccountID: 1, RepoID: 1, Repo: "o/a", Name: "build", State: model.JobQueued, Reason: "All workers are full", QueuedAt: now - 600_000, WaitingSince: now - 600_000})
		_ = tx.SaveJob(model.Job{ID: 2, AccountID: 1, RepoID: 1, Repo: "o/a", Name: "test", State: model.JobRunning, RunnerID: "r", QueuedAt: now - 60_000, StartedAt: now - 50_000})
		_ = tx.SaveJob(model.Job{ID: 3, AccountID: 1, RepoID: 1, Repo: "o/b", Name: "lint", State: model.JobIgnored, Reason: `unknown label "gpu" in runs-on`, QueuedAt: now})
		_ = tx.SaveRunner(model.Runner{ID: "r", Name: "ci-plane-w1-r", WorkerID: w, JobID: 2, State: model.RunnerBusy, CPUs: 4, MemMB: 8192})
		_, _ = tx.AddEvent(model.Event{Kind: "job.queued", Message: "Queued", JobID: 1})
		return nil
	})
	r.workers.status[w] = engine.WorkerStatus{Connected: true, At: now, CPUPct: 40}
	ov := r.expect(r.local_("GET", "/api/overview", nil), 200)
	if ov.body["queued"].(float64) != 1 || ov.body["running"].(float64) != 1 {
		t.Fatalf("counts: %v", ov.body)
	}
	keys := []string{}
	for _, a := range ov.body["alerts"].([]any) {
		keys = append(keys, a.(map[string]any)["key"].(string))
	}
	if !strings.Contains(strings.Join(keys, ","), "jobs-waiting") || !strings.Contains(strings.Join(keys, ","), "a1-install") {
		t.Fatalf("alerts: %v", keys)
	}
	capacity := ov.body["workers"].([]any)[0].(map[string]any)["capacity"].(map[string]any)
	// 40 % of 8 CPUs are busy; the runner's job has not begun to count by its load.
	if capacity["busyCpus"].(float64) != 3.2 || capacity["heldCpus"].(float64) != 4 || capacity["runners"].(float64) != 1 {
		t.Fatalf("capacity: %v", capacity)
	}
	jobs := r.expect(r.local_("GET", "/api/jobs?state=running,queued&limit=10", nil), 200)
	if jobs.body["total"].(float64) != 2 || jobs.body["counts"].(map[string]any)["ignored"].(float64) != 1 {
		t.Fatalf("jobs: %v", jobs.body)
	}
	search := r.expect(r.local_("GET", "/api/jobs?q=o/b", nil), 200)
	if search.body["total"].(float64) != 1 {
		t.Fatalf("search: %v", search.body)
	}
	one := r.expect(r.local_("GET", "/api/jobs/2", nil), 200)
	if one.body["job"].(map[string]any)["worker"] != "w1" {
		t.Fatalf("job detail: %v", one.body)
	}
	r.expect(r.local_("GET", "/api/jobs/42", nil), 404)
}

// --- live updates ----------------------------------------------------------------

func TestEventsAreCoalesced(t *testing.T) {
	r := newRig(t, true)
	ts := httptest.NewServer(r.local)
	defer ts.Close()
	res, err := http.Get(ts.URL + "/api/events")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.Header.Get("Content-Type") != "text/event-stream" {
		t.Fatalf("content type %s", res.Header.Get("Content-Type"))
	}
	lines := make(chan string, 100)
	go func() {
		sc := bufio.NewScanner(res.Body)
		for sc.Scan() {
			lines <- sc.Text()
		}
		close(lines)
	}()
	// Wait until the stream is registered, then send a burst.
	deadline := time.Now().Add(2 * time.Second)
	for {
		r.srv.hub.mu.Lock()
		n := len(r.srv.hub.clients)
		r.srv.hub.mu.Unlock()
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("stream not registered")
		}
		time.Sleep(5 * time.Millisecond)
	}
	for i := 0; i < 20; i++ {
		r.srv.Changed()
	}
	r.srv.hub.notify("tasks")
	var events []string
	timeout := time.After(coalesce*3 + 500*time.Millisecond)
loop:
	for {
		select {
		case l, ok := <-lines:
			if !ok {
				break loop
			}
			if strings.HasPrefix(l, "data: ") {
				events = append(events, strings.TrimPrefix(l, "data: "))
			}
		case <-timeout:
			break loop
		}
	}
	if len(events) != 1 || events[0] != `{"topics":["state","tasks"]}` {
		t.Fatalf("a burst should be one message: %v", events)
	}
	// The engine's changes reach the stream too.
	r.srv.d.Engine.OnChange()
	select {
	case l := <-lines:
		for !strings.HasPrefix(l, "data: ") {
			l = <-lines
		}
		if !strings.Contains(l, "state") {
			t.Fatalf("engine change: %s", l)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no message after an engine change")
	}
}

func TestEventsNeedASession(t *testing.T) {
	r := newRig(t, false)
	r.expect(r.local_("GET", "/api/events", nil), 401)
}
