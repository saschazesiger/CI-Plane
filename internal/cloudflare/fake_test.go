package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

const (
	testToken  = "cf-api-token-0123456789"
	testAcct   = "acct1"
	testZone   = "zone1"
	testTeam   = "team.cloudflareaccess.com"
	testHost   = "ci.example.com"
	testOrigin = "http://127.0.0.1:8081"
)

// TestMain lets the test binary act as cloudflared.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_CLOUDFLARED") == "1" {
		fakeCloudflared()
		return
	}
	os.Exit(m.Run())
}

// fakeCloudflared writes its arguments and whether it got a token to
// FAKE_CLOUDFLARED_LOG, then either serves /ready like a connected
// cloudflared or exits at once (FAKE_CLOUDFLARED_EXIT=1).
func fakeCloudflared() {
	tok := os.Getenv("TUNNEL_TOKEN")
	if f, err := os.OpenFile(os.Getenv("FAKE_CLOUDFLARED_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600); err == nil {
		fmt.Fprintf(f, "%d args=%q token=%v secretkey=%v\n", time.Now().UnixMilli(), os.Args[1:], tok != "", os.Getenv("CI_PLANE_SECRET_KEY") != "")
		f.Close()
	}
	// Print the token so the test can see that it is redacted.
	fmt.Fprintf(os.Stderr, "2026-11-10T00:00:00Z INF token is %s\n", tok)
	if os.Getenv("FAKE_CLOUDFLARED_EXIT") == "1" {
		fmt.Fprintln(os.Stderr, "2026-11-10T00:00:00Z ERR Register tunnel error from server side error=\"Unauthorized\"")
		os.Exit(1)
	}
	addr := ""
	for i, a := range os.Args {
		if a == "--metrics" && i+1 < len(os.Args) {
			addr = os.Args[i+1]
		}
	}
	l, err := net.Listen("tcp", addr)
	if err != nil {
		os.Exit(2)
	}
	http.Serve(l, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"status":200,"readyConnections":4,"connectorId":"x"}`)
	}))
}

// --- fake Cloudflare API -----------------------------------------------------

type fakeCF struct {
	mu       sync.Mutex
	t        *testing.T
	noOrg    bool
	failAt   int  // fail the n-th request (1-based) with a 500; 0 = never
	lose     bool // carry out the failing request, then answer 500 (a lost reply)
	calls    int
	log      []string
	creates  map[string]int
	nextID   int
	idps     []idpObj
	tunnels  map[string]*tunnelObj
	ingress  map[string][]ingressRule
	records  map[string]*recordObj
	policies map[string]*policyObj
	apps     map[string]*appObj
}

func newFakeCF(t *testing.T) *fakeCF {
	return &fakeCF{t: t, creates: map[string]int{}, tunnels: map[string]*tunnelObj{},
		ingress: map[string][]ingressRule{}, records: map[string]*recordObj{},
		policies: map[string]*policyObj{}, apps: map[string]*appObj{}}
}

func (f *fakeCF) id(kind string) string {
	f.nextID++
	f.creates[kind]++
	return fmt.Sprintf("%s-%d", kind, f.nextID)
}

func reply(w http.ResponseWriter, status int, result any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if status >= 300 {
		json.NewEncoder(w).Encode(map[string]any{"success": false, "errors": []cfMessage{{Code: 7003, Message: fmt.Sprint(result)}}, "result": nil})
		return
	}
	json.NewEncoder(w).Encode(map[string]any{"success": true, "errors": []any{}, "result": result})
}

func values[T any](m map[string]*T) []T {
	out := []T{}
	for _, v := range m {
		out = append(out, *v)
	}
	return out
}

func (f *fakeCF) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.log = append(f.log, r.Method+" "+r.URL.Path)
	if r.Header.Get("Authorization") != "Bearer "+testToken {
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"success":false,"errors":[{"code":6003,"message":"Invalid request headers"}]}`))
		return
	}
	if f.failAt != 0 && f.calls == f.failAt {
		if f.lose {
			f.serve(httptest.NewRecorder(), r)
		}
		reply(w, 500, "injected failure")
		return
	}
	f.serve(w, r)
}

func (f *fakeCF) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("page") != "" && r.URL.Query().Get("page") != "1" {
		reply(w, 200, []any{})
		return
	}
	var body map[string]json.RawMessage
	json.NewDecoder(r.Body).Decode(&body)
	raw, _ := json.Marshal(body)
	decode := func(v any) { json.Unmarshal(raw, v) }

	p := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	m := r.Method
	at := func(pattern string) bool { // pattern with * for one segment
		q := strings.Split(pattern, "/")
		if len(q) != len(p) {
			return false
		}
		for i := range q {
			if q[i] != "*" && q[i] != p[i] {
				return false
			}
		}
		return true
	}
	zone := map[string]any{"id": testZone, "name": "example.com", "account": map[string]string{"id": testAcct, "name": "Acme"}}
	switch {
	case m == "GET" && at("zones"):
		reply(w, 200, []any{zone})
	case m == "GET" && at("zones/"+testZone):
		reply(w, 200, zone)
	case at("zones/*/dns_records"):
		if m == "POST" {
			var rec recordObj
			decode(&rec)
			rec.ID = f.id("record")
			f.records[rec.ID] = &rec
			reply(w, 200, rec)
			return
		}
		name := r.URL.Query().Get("name.exact")
		out := []recordObj{}
		for _, rec := range f.records {
			if name == "" || rec.Name == name {
				out = append(out, *rec)
			}
		}
		reply(w, 200, out)
	case at("zones/*/dns_records/*"):
		rec, ok := f.records[p[3]]
		if !ok {
			reply(w, 404, "record not found")
			return
		}
		if m == "DELETE" {
			delete(f.records, p[3])
			reply(w, 200, map[string]string{"id": p[3]})
			return
		}
		var nr recordObj
		decode(&nr)
		nr.ID = rec.ID
		*rec = nr
		reply(w, 200, nr)
	case at("accounts/" + testAcct + "/access/organizations"):
		if f.noOrg {
			reply(w, 404, "access.api.error.not_found")
			return
		}
		reply(w, 200, map[string]string{"auth_domain": testTeam, "name": "team"})
	case at("accounts/" + testAcct + "/access/identity_providers"):
		if m == "POST" {
			var idp idpObj
			decode(&idp)
			idp.ID = f.id("idp")
			f.idps = append(f.idps, idp)
			reply(w, 200, idp)
			return
		}
		reply(w, 200, append([]idpObj{}, f.idps...))
	case at("accounts/" + testAcct + "/cfd_tunnel"):
		if m == "POST" {
			var t tunnelObj
			decode(&t)
			t.ID = f.id("tunnel")
			f.tunnels[t.ID] = &t
			reply(w, 200, t)
			return
		}
		out := []tunnelObj{}
		for _, t := range f.tunnels {
			if n := r.URL.Query().Get("name"); n == "" || n == t.Name {
				out = append(out, *t)
			}
		}
		reply(w, 200, out)
	case at("accounts/"+testAcct+"/cfd_tunnel/*") || at("accounts/"+testAcct+"/cfd_tunnel/*/*"):
		t, ok := f.tunnels[p[3]]
		if !ok {
			reply(w, 404, "tunnel not found")
			return
		}
		switch {
		case len(p) == 5 && p[4] == "token":
			reply(w, 200, "tunnel-token-"+t.ID)
		case len(p) == 5 && p[4] == "configurations":
			var c struct {
				Config struct {
					Ingress []ingressRule `json:"ingress"`
				} `json:"config"`
			}
			decode(&c)
			f.ingress[t.ID] = c.Config.Ingress
			reply(w, 200, map[string]any{})
		case len(p) == 5 && p[4] == "connections":
			reply(w, 200, nil)
		case m == "DELETE":
			delete(f.tunnels, t.ID)
			reply(w, 200, t)
		default:
			reply(w, 200, t)
		}
	case at("accounts/" + testAcct + "/access/policies"):
		if m == "POST" {
			var pol policyObj
			decode(&pol)
			pol.ID = f.id("policy")
			f.policies[pol.ID] = &pol
			reply(w, 200, pol)
			return
		}
		reply(w, 200, values(f.policies))
	case at("accounts/" + testAcct + "/access/policies/*"):
		pol, ok := f.policies[p[4]]
		if !ok {
			reply(w, 404, "policy not found")
			return
		}
		switch m {
		case "DELETE":
			for _, a := range f.apps {
				if appUses(a, pol.ID) {
					reply(w, 400, "policy is in use")
					return
				}
			}
			delete(f.policies, pol.ID)
			reply(w, 200, map[string]string{"id": pol.ID})
		case "PUT":
			var np policyObj
			decode(&np)
			np.ID = pol.ID
			*pol = np
			reply(w, 200, np)
		default:
			reply(w, 200, pol)
		}
	case at("accounts/" + testAcct + "/access/apps"):
		if m == "POST" {
			var a appObj
			decode(&a)
			a.ID = f.id("app")
			a.AUD = "aud-" + a.ID
			f.apps[a.ID] = &a
			reply(w, 200, a)
			return
		}
		reply(w, 200, values(f.apps))
	case at("accounts/" + testAcct + "/access/apps/*"):
		a, ok := f.apps[p[4]]
		if !ok {
			reply(w, 404, "app not found")
			return
		}
		switch m {
		case "DELETE":
			delete(f.apps, a.ID)
			reply(w, 200, map[string]string{"id": a.ID})
		case "PUT":
			var na appObj
			decode(&na)
			na.ID, na.AUD = a.ID, a.AUD
			*a = na
			reply(w, 200, na)
		default:
			reply(w, 200, a)
		}
	default:
		f.t.Errorf("fake Cloudflare: unexpected %s %s", m, r.URL.Path)
		reply(w, 404, "no such endpoint")
	}
}

func appUses(a *appObj, policyID string) bool {
	b, _ := json.Marshal(a.Policies)
	return strings.Contains(string(b), `"`+policyID+`"`)
}

// edge plays Cloudflare's edge for the check from outside.
type edge struct {
	mu          sync.Mutex
	loginOK     bool // / redirects to the Access login
	webhookOK   bool // /webhook reaches CI-Plane
	requestsFor []string
}

func (e *edge) RoundTrip(r *http.Request) (*http.Response, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.requestsFor = append(e.requestsFor, r.URL.String())
	rec := httptest.NewRecorder()
	switch {
	case r.URL.Path == "/" && e.loginOK:
		rec.Header().Set("Location", "https://"+testTeam+"/cdn-cgi/access/login/"+r.URL.Host)
		rec.WriteHeader(http.StatusFound)
	case r.URL.Path == "/webhook" && e.webhookOK:
		rec.Header().Set("X-CI-Plane", "webhook")
		rec.WriteHeader(http.StatusOK)
	case r.URL.Path == "/webhook":
		rec.Header().Set("Location", "https://"+testTeam+"/cdn-cgi/access/login/"+r.URL.Host)
		rec.WriteHeader(http.StatusFound)
	default:
		rec.Header().Set("X-CI-Plane", "ui")
		rec.WriteHeader(http.StatusOK)
	}
	return rec.Result(), nil
}

type harness struct {
	t      *testing.T
	cf     *fakeCF
	edge   *edge
	svc    *Service
	st     *store.Store
	box    *secret.Box
	logs   *logBuf
	cancel context.CancelFunc
	done   chan struct{}
	cfdLog string
}

type logBuf struct {
	mu    sync.Mutex
	lines []string
}

func (l *logBuf) logf(f string, a ...any) {
	l.mu.Lock()
	l.lines = append(l.lines, fmt.Sprintf(f, a...))
	l.mu.Unlock()
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

// newHarness builds a service against the fakes; run starts the supervisor
// with the test binary as cloudflared.
func newHarness(t *testing.T, run bool) *harness {
	t.Helper()
	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	box, err := secret.New(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{t: t, cf: newFakeCF(t), edge: &edge{loginOK: true, webhookOK: true}, st: st, box: box, logs: &logBuf{}}
	srv := httptest.NewServer(h.cf)
	t.Cleanup(srv.Close)
	h.cfdLog = t.TempDir() + "/cloudflared.log"
	t.Setenv("FAKE_CLOUDFLARED", "1")
	t.Setenv("FAKE_CLOUDFLARED_LOG", h.cfdLog)
	t.Setenv("CI_PLANE_SECRET_KEY", "must-not-reach-cloudflared")
	h.svc = h.newService()
	h.svc.API = srv.URL
	if run {
		h.startRun()
	}
	return h
}

func (h *harness) newService() *Service {
	s := New(h.st, h.box, testOrigin, h.logs.logf)
	s.Cloudflared = os.Args[0]
	s.Outside = &http.Client{Transport: h.edge, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	s.VerifyFor, s.VerifyPause = 300*time.Millisecond, 20*time.Millisecond
	s.ConnectFor = 10 * time.Second
	s.MinBackoff, s.MaxBackoff = 50*time.Millisecond, 400*time.Millisecond
	s.ReadyPoll = 20 * time.Millisecond
	if h.svc != nil {
		s.API = h.svc.API
	}
	return s
}

func (h *harness) startRun() {
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel, h.done = cancel, make(chan struct{})
	go func() { h.svc.Run(ctx); close(h.done) }()
	h.t.Cleanup(h.stopRun)
}

func (h *harness) stopRun() {
	if h.cancel != nil {
		h.cancel()
		<-h.done
		h.cancel = nil
	}
}

func setupReq() api.TunnelSetup {
	return api.TunnelSetup{APIToken: testToken, ZoneID: testZone, Hostname: "CI.example.com", Emails: []string{"Alice@Example.com", "bob@example.com"}}
}

func (h *harness) counts() (tunnels, records, policies, apps int) {
	h.cf.mu.Lock()
	defer h.cf.mu.Unlock()
	return len(h.cf.tunnels), len(h.cf.records), len(h.cf.policies), len(h.cf.apps)
}
