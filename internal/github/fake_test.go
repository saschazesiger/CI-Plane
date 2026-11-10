package github

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

var (
	testKeyOnce sync.Once
	testKey     *rsa.PrivateKey
	testKeyPEM  string
)

func key(t *testing.T) (*rsa.PrivateKey, string) {
	testKeyOnce.Do(func() {
		k, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			panic(err)
		}
		testKey = k
		testKeyPEM = string(pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)}))
	})
	return testKey, testKeyPEM
}

type fakeRunner struct {
	ID     int64    `json:"id"`
	Name   string   `json:"name"`
	Status string   `json:"status"`
	Busy   bool     `json:"busy"`
	Labels []string `json:"-"`
}

type fakeRun struct {
	ghRun
	jobs []ghJob
}

// fakeGH is GitHub's REST API, as far as CI-Plane uses it.
type fakeGH struct {
	t   *testing.T
	srv *httptest.Server
	pub *rsa.PublicKey

	mu            sync.Mutex
	calls         map[string]int // "METHOD path" without query
	notModified   atomic.Int64   // 304 answers; not under mu, handlers hold mu while answering
	tokens        int            // installation tokens issued
	tokenTTL      time.Duration
	tokenDelay    time.Duration
	now           func() time.Time
	installations map[int64]int64 // app id -> installation id; 0 = not installed
	instOwner     map[int64]string
	repos         []ghRepo // of the installation
	runners       map[string][]*fakeRunner
	nextRunner    int64
	runs          map[string][]*fakeRun // by owner/repo
	deliveries    []delivery            // newest first
	attempts      []int64               // redelivery requests
	hookConfig    map[int64]map[string]any
	conversions   map[string]map[string]any
	fail          map[string][]int // "METHOD path" -> status codes to answer first
	lastJIT       map[string]any
}

func newFake(t *testing.T) *fakeGH {
	k, _ := key(t)
	f := &fakeGH{
		t: t, pub: &k.PublicKey, calls: map[string]int{}, tokenTTL: time.Hour, now: time.Now,
		installations: map[int64]int64{}, instOwner: map[int64]string{}, runners: map[string][]*fakeRunner{},
		nextRunner: 100, runs: map[string][]*fakeRun{}, hookConfig: map[int64]map[string]any{},
		conversions: map[string]map[string]any{}, fail: map[string][]int{},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /app-manifests/{code}/conversions", f.conversion)
	mux.HandleFunc("POST /app/installations/{id}/access_tokens", f.accessToken)
	mux.HandleFunc("GET /app/installations", f.listInstallations)
	mux.HandleFunc("GET /installation/repositories", f.installationRepos)
	mux.HandleFunc("PATCH /app/hook/config", f.patchHook)
	mux.HandleFunc("GET /app/hook/deliveries", f.listDeliveries)
	mux.HandleFunc("POST /app/hook/deliveries/{id}/attempts", f.redeliver)
	for _, p := range []string{"/orgs/{org}", "/repos/{owner}/{repo}"} {
		mux.HandleFunc("POST "+p+"/actions/runners/generate-jitconfig", f.jit)
		mux.HandleFunc("GET "+p+"/actions/runners", f.listRunners)
		mux.HandleFunc("DELETE "+p+"/actions/runners/{id}", f.deleteRunner)
	}
	mux.HandleFunc("GET /repos/{owner}/{repo}/actions/runs", f.listRuns)
	mux.HandleFunc("GET /repos/{owner}/{repo}/actions/runs/{id}/jobs", f.listJobs)
	mux.HandleFunc("GET /repos/{owner}/{repo}/actions/jobs/{id}", f.getJob)
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.Method + " " + r.URL.Path
		f.mu.Lock()
		f.calls[key]++
		var code int
		if q := f.fail[key]; len(q) > 0 {
			code, f.fail[key] = q[0], q[1:]
		}
		f.mu.Unlock()
		if r.Header.Get("X-GitHub-Api-Version") != apiVersion || r.Header.Get("User-Agent") == "" {
			http.Error(w, `{"message":"missing headers"}`, 400)
			return
		}
		if code != 0 {
			if code == 403 {
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(f.now().Add(20*time.Minute).Unix(), 10))
			}
			w.WriteHeader(code)
			io.WriteString(w, `{"message":"injected failure"}`)
			return
		}
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGH) count(key string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[key]
}

func writeJSON(w http.ResponseWriter, r *http.Request, f *fakeGH, status int, v any) {
	b, _ := json.Marshal(v)
	if r.Method == http.MethodGet && status == 200 {
		sum := sha256.Sum256(b)
		etag := `W/"` + hex.EncodeToString(sum[:8]) + `"`
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			f.notModified.Add(1)
			w.WriteHeader(http.StatusNotModified)
			return
		}
	}
	w.Header().Set("X-RateLimit-Remaining", "4999")
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(time.Now().Add(time.Hour).Unix(), 10))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	w.Write(b)
}

func apiErr(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"message":%q}`, msg)
}

// appOf verifies the JWT of a request and returns the app id.
func (f *fakeGH) appOf(w http.ResponseWriter, r *http.Request) (int64, bool) {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	parts := strings.Split(tok, ".")
	if !ok || len(parts) != 3 {
		apiErr(w, 401, "A JSON web token could not be decoded")
		return 0, false
	}
	var hdr map[string]string
	hb, _ := base64.RawURLEncoding.DecodeString(parts[0])
	if json.Unmarshal(hb, &hdr) != nil || hdr["alg"] != "RS256" {
		apiErr(w, 401, "bad alg")
		return 0, false
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if rsa.VerifyPKCS1v15(f.pub, crypto.SHA256, sum[:], sig) != nil {
		apiErr(w, 401, "bad signature")
		return 0, false
	}
	var c struct {
		Iat, Exp int64
		Iss      string
	}
	cb, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if json.Unmarshal(cb, &c) != nil || c.Exp-c.Iat > 600 || c.Exp <= f.now().Unix() || c.Iat > f.now().Unix() {
		apiErr(w, 401, "'Expiration time' claim ('exp') is too far in the future")
		return 0, false
	}
	id, err := strconv.ParseInt(c.Iss, 10, 64)
	if err != nil {
		apiErr(w, 401, "bad iss")
		return 0, false
	}
	return id, true
}

// installed checks an installation token.
func (f *fakeGH) installed(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ghs_") {
		apiErr(w, 401, "Bad credentials")
		return false
	}
	return true
}

func (f *fakeGH) conversion(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	out, ok := f.conversions[r.PathValue("code")]
	delete(f.conversions, r.PathValue("code"))
	f.mu.Unlock()
	if !ok {
		apiErr(w, 404, "Not Found")
		return
	}
	writeJSON(w, r, f, 201, out)
}

func (f *fakeGH) accessToken(w http.ResponseWriter, r *http.Request) {
	app, ok := f.appOf(w, r)
	if !ok {
		return
	}
	f.mu.Lock()
	inst := f.installations[app]
	delay := f.tokenDelay
	f.mu.Unlock()
	if strconv.FormatInt(inst, 10) != r.PathValue("id") || inst == 0 {
		apiErr(w, 404, "Not Found")
		return
	}
	time.Sleep(delay)
	f.mu.Lock()
	f.tokens++
	n := f.tokens
	exp := f.now().Add(f.tokenTTL)
	f.mu.Unlock()
	writeJSON(w, r, f, 201, map[string]any{"token": fmt.Sprintf("ghs_token%d", n), "expires_at": exp.UTC().Format(time.RFC3339)})
}

func (f *fakeGH) listInstallations(w http.ResponseWriter, r *http.Request) {
	app, ok := f.appOf(w, r)
	if !ok {
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []map[string]any{}
	if id := f.installations[app]; id != 0 {
		out = append(out, map[string]any{"id": id, "app_id": app, "account": map[string]any{"login": f.instOwner[app], "type": "Organization"}, "suspended_at": nil})
	}
	writeJSON(w, r, f, 200, out)
}

func page(r *http.Request) (int, int) {
	p, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if p < 1 {
		p = 1
	}
	per, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
	if per < 1 {
		per = 30
	}
	return p, per
}

func slice[T any](all []T, p, per int) []T {
	lo, hi := (p-1)*per, p*per
	if lo > len(all) {
		lo = len(all)
	}
	if hi > len(all) {
		hi = len(all)
	}
	return all[lo:hi]
}

func (f *fakeGH) installationRepos(w http.ResponseWriter, r *http.Request) {
	if !f.installed(w, r) {
		return
	}
	p, per := page(r)
	f.mu.Lock()
	defer f.mu.Unlock()
	writeJSON(w, r, f, 200, map[string]any{"total_count": len(f.repos), "repositories": slice(f.repos, p, per)})
}

func (f *fakeGH) patchHook(w http.ResponseWriter, r *http.Request) {
	app, ok := f.appOf(w, r)
	if !ok {
		return
	}
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	f.hookConfig[app] = body
	f.mu.Unlock()
	writeJSON(w, r, f, 200, body)
}

func (f *fakeGH) listDeliveries(w http.ResponseWriter, r *http.Request) {
	if _, ok := f.appOf(w, r); !ok {
		return
	}
	per, _ := strconv.Atoi(r.URL.Query().Get("per_page"))
	start, _ := strconv.Atoi(r.URL.Query().Get("cursor"))
	f.mu.Lock()
	all := append([]delivery(nil), f.deliveries...)
	f.mu.Unlock()
	end := min(start+per, len(all))
	if end < len(all) {
		w.Header().Set("Link", fmt.Sprintf(`<%s/app/hook/deliveries?per_page=%d&cursor=%d>; rel="next"`, f.srv.URL, per, end))
	}
	writeJSON(w, r, f, 200, all[start:end])
}

func (f *fakeGH) redeliver(w http.ResponseWriter, r *http.Request) {
	if _, ok := f.appOf(w, r); !ok {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	f.mu.Lock()
	f.attempts = append(f.attempts, id)
	f.mu.Unlock()
	writeJSON(w, r, f, 202, map[string]any{})
}

func targetKey(r *http.Request) string {
	if org := r.PathValue("org"); org != "" {
		return "org:" + org
	}
	return "repo:" + r.PathValue("owner") + "/" + r.PathValue("repo")
}

func (f *fakeGH) jit(w http.ResponseWriter, r *http.Request) {
	if !f.installed(w, r) {
		return
	}
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	name, _ := body["name"].(string)
	k := targetKey(r)
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lastJIT = body
	for _, x := range f.runners[k] {
		if x.Name == name {
			apiErr(w, 409, "Already exists - A runner with the name "+name+" already exists.")
			return
		}
	}
	f.nextRunner++
	x := &fakeRunner{ID: f.nextRunner, Name: name, Status: "offline"}
	f.runners[k] = append(f.runners[k], x)
	writeJSON(w, r, f, 201, map[string]any{"runner": x, "encoded_jit_config": "SECRETJIT" + name})
}

func (f *fakeGH) listRunners(w http.ResponseWriter, r *http.Request) {
	if !f.installed(w, r) {
		return
	}
	p, per := page(r)
	f.mu.Lock()
	defer f.mu.Unlock()
	all := f.runners[targetKey(r)]
	writeJSON(w, r, f, 200, map[string]any{"total_count": len(all), "runners": slice(all, p, per)})
}

func (f *fakeGH) deleteRunner(w http.ResponseWriter, r *http.Request) {
	if !f.installed(w, r) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	k := targetKey(r)
	f.mu.Lock()
	defer f.mu.Unlock()
	for i, x := range f.runners[k] {
		if x.ID == id {
			if x.Busy {
				apiErr(w, 422, `Bad request - Runner "`+x.Name+`" is still running a job"`)
				return
			}
			f.runners[k] = append(f.runners[k][:i], f.runners[k][i+1:]...)
			w.WriteHeader(204)
			return
		}
	}
	apiErr(w, 404, "Not Found")
}

func (f *fakeGH) listRuns(w http.ResponseWriter, r *http.Request) {
	if !f.installed(w, r) {
		return
	}
	status := r.URL.Query().Get("status")
	p, per := page(r)
	f.mu.Lock()
	defer f.mu.Unlock()
	out := []ghRun{}
	for _, run := range f.runs[r.PathValue("owner")+"/"+r.PathValue("repo")] {
		if status == "" || run.Status == status {
			out = append(out, run.ghRun)
		}
	}
	writeJSON(w, r, f, 200, map[string]any{"total_count": len(out), "workflow_runs": slice(out, p, per)})
}

func (f *fakeGH) listJobs(w http.ResponseWriter, r *http.Request) {
	if !f.installed(w, r) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	p, per := page(r)
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, run := range f.runs[r.PathValue("owner")+"/"+r.PathValue("repo")] {
		if run.ID == id {
			writeJSON(w, r, f, 200, map[string]any{"total_count": len(run.jobs), "jobs": slice(run.jobs, p, per)})
			return
		}
	}
	apiErr(w, 404, "Not Found")
}

func (f *fakeGH) getJob(w http.ResponseWriter, r *http.Request) {
	if !f.installed(w, r) {
		return
	}
	id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, run := range f.runs[r.PathValue("owner")+"/"+r.PathValue("repo")] {
		for _, j := range run.jobs {
			if j.ID == id {
				writeJSON(w, r, f, 200, j)
				return
			}
		}
	}
	apiErr(w, 404, "Not Found")
}

// --- test setup ----------------------------------------------------------

type env struct {
	t   *testing.T
	gh  *fakeGH
	st  *store.Store
	box *secret.Box
	s   *Service
	now time.Time
	mu  sync.Mutex
}

func newEnv(t *testing.T) *env {
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
	e := &env{t: t, gh: newFake(t), st: st, box: box, now: time.Now()}
	e.gh.now = e.clock
	e.s = e.service()
	return e
}

// service creates a Service on the env's store, as after a restart.
func (e *env) service() *Service {
	s := New(e.st, e.box, e.t.Logf)
	s.APIURL = e.gh.srv.URL
	s.WebURL = "https://github.example"
	s.retryBase = time.Millisecond
	s.now = e.clock
	return s
}

func (e *env) clock() time.Time {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.now
}

func (e *env) advance(d time.Duration) {
	e.mu.Lock()
	e.now = e.now.Add(d)
	e.mu.Unlock()
}

// addApp stores an app as Complete would and installs it on the fake.
func (e *env) addApp(id int64, owner, ownerType string, installation int64, hookSecret string) model.Account {
	e.t.Helper()
	_, pemKey := key(e.t)
	acc := model.Account{ID: id, Slug: "ci-plane-" + strings.ToLower(owner), Owner: owner, OwnerType: ownerType, InstallationID: installation, Enabled: true}
	err := e.st.Tx(func(tx *store.Tx) error {
		if err := tx.SaveAccount(acc); err != nil {
			return err
		}
		if err := e.box.Put(tx, keyName(id), []byte(pemKey)); err != nil {
			return err
		}
		return e.box.Put(tx, hookName(id), []byte(hookSecret))
	})
	if err != nil {
		e.t.Fatal(err)
	}
	e.gh.mu.Lock()
	e.gh.installations[id] = installation
	e.gh.instOwner[id] = owner
	e.gh.mu.Unlock()
	return acc
}

func (e *env) repos(accountID int64) []model.Repo {
	e.t.Helper()
	var out []model.Repo
	if err := e.st.View(func(tx *store.Tx) error {
		var err error
		out, err = tx.Repos(accountID)
		return err
	}); err != nil {
		e.t.Fatal(err)
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	return out
}

func (e *env) account(id int64) model.Account {
	e.t.Helper()
	var a model.Account
	if err := e.st.View(func(tx *store.Tx) error {
		var err error
		a, err = tx.Account(id)
		return err
	}); err != nil {
		e.t.Fatal(err)
	}
	return a
}
