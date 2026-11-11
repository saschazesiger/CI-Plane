package github

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// relayFake is the relay repository on GitHub and the issuer of Actions
// tokens; everything else goes to the fake GitHub of the env.
type relayFake struct {
	t   *testing.T
	srv *httptest.Server
	key *rsa.PrivateKey

	mu           sync.Mutex
	nextRun      int64
	runs         []*relayRun // newest last
	dispatches   []map[string]any
	cancels      int
	noWorkflow   bool
	readOnly     bool
	disabled     bool
	failDispatch int
}

func newRelayFake(t *testing.T, e *env) *relayFake {
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &relayFake{t: t, key: k, nextRun: 9000}
	target, _ := url.Parse(e.gh.srv.URL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	const repo = "/repos/acme/relay"
	const wf = repo + "/actions/workflows/ci-plane-relay.yml"
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		p := r.URL.Path
		switch {
		case p == "/.well-known/jwks":
			n := base64.RawURLEncoding.EncodeToString(k.PublicKey.N.Bytes())
			eb := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.PublicKey.E)).Bytes())
			json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{"kty": "RSA", "kid": "k1", "n": n, "e": eb, "alg": "RS256"}}})
		case p == repo+"/installation" && r.Method == "GET":
			perm := "write"
			if f.readOnly {
				perm = "read"
			}
			json.NewEncoder(w).Encode(map[string]any{"id": 77, "permissions": map[string]string{"actions": perm, "metadata": "read"}})
		case p == wf+"/dispatches" && r.Method == "POST" && f.readOnly:
			apiErr(w, 403, "Resource not accessible by integration")
		case p == repo && r.Method == "GET":
			json.NewEncoder(w).Encode(map[string]any{"default_branch": "main"})
		case p == wf && r.Method == "GET":
			if f.noWorkflow {
				apiErr(w, 404, "Not Found")
				return
			}
			state := "active"
			if f.disabled {
				state = "disabled_manually"
			}
			json.NewEncoder(w).Encode(map[string]any{"state": state, "path": ".github/workflows/ci-plane-relay.yml"})
		case p == wf+"/dispatches" && r.Method == "POST":
			if f.noWorkflow {
				apiErr(w, 404, "Not Found")
				return
			}
			if f.failDispatch > 0 {
				f.failDispatch--
				apiErr(w, 422, "Workflow does not have 'workflow_dispatch' trigger")
				return
			}
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			f.dispatches = append(f.dispatches, body)
			inputs, _ := body["inputs"].(map[string]any)
			f.nextRun++
			f.runs = append(f.runs, &relayRun{ID: f.nextRun, Title: fmt.Sprint(inputs["runner"]), Status: "queued", CreatedAt: e.clock().UTC().Format(time.RFC3339)})
			w.WriteHeader(204)
		case p == wf+"/runs" && r.Method == "GET":
			if f.noWorkflow {
				apiErr(w, 404, "Not Found")
				return
			}
			out := []relayRun{}
			for i := len(f.runs) - 1; i >= 0; i-- {
				out = append(out, *f.runs[i])
			}
			json.NewEncoder(w).Encode(map[string]any{"total_count": len(out), "workflow_runs": out})
		case strings.HasPrefix(p, repo+"/actions/runs/"):
			rest := strings.TrimPrefix(p, repo+"/actions/runs/")
			id, _ := strconv.ParseInt(strings.TrimSuffix(rest, "/cancel"), 10, 64)
			for _, run := range f.runs {
				if run.ID != id {
					continue
				}
				if strings.HasSuffix(rest, "/cancel") {
					if run.Status == "completed" {
						apiErr(w, 409, "Cannot cancel a workflow run that is completed.")
						return
					}
					run.Status, run.Conclusion = "completed", "cancelled"
					f.cancels++
					w.WriteHeader(202)
					return
				}
				json.NewEncoder(w).Encode(run)
				return
			}
			apiErr(w, 404, "Not Found")
		default:
			f.mu.Unlock()
			proxy.ServeHTTP(w, r)
			f.mu.Lock()
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

// token mints an Actions OIDC token for a run of the relay workflow.
func (f *relayFake) token(change func(map[string]any)) string {
	now := time.Now().Unix()
	claims := map[string]any{
		"iss": f.srv.URL, "aud": model.RelayAudience, "exp": now + 300, "nbf": now - 5, "iat": now - 5,
		"repository": "acme/relay", "repository_id": "555", "run_id": "9001",
		"workflow_ref": "acme/relay/.github/workflows/ci-plane-relay.yml@refs/heads/main", "event_name": "workflow_dispatch",
		"actor": "ci-plane-acme[bot]",
	}
	if change != nil {
		change(claims)
	}
	return f.sign(map[string]any{"alg": "RS256", "kid": "k1", "typ": "JWT"}, claims, f.key)
}

func (f *relayFake) sign(head, claims map[string]any, k *rsa.PrivateKey) string {
	h, _ := json.Marshal(head)
	c, _ := json.Marshal(claims)
	in := base64.RawURLEncoding.EncodeToString(h) + "." + base64.RawURLEncoding.EncodeToString(c)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, k, crypto.SHA256, sum[:])
	if err != nil {
		f.t.Fatal(err)
	}
	return in + "." + base64.RawURLEncoding.EncodeToString(sig)
}

func (f *relayFake) run(id int64) *relayRun {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, r := range f.runs {
		if r.ID == id {
			return r
		}
	}
	return nil
}

type relayEnv struct {
	*env
	fake  *relayFake
	relay *Relay
	url   string
}

func newRelayEnv(t *testing.T, private bool) *relayEnv {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	f := newRelayFake(t, e)
	if err := e.st.Tx(func(tx *store.Tx) error {
		if err := tx.UpsertRepo(model.Repo{ID: 555, AccountID: 1, FullName: "acme/relay", Private: private, Enabled: true}); err != nil {
			return err
		}
		set, err := tx.Settings()
		if err != nil {
			return err
		}
		set.RelayEnabled, set.RelayRepo = true, "acme/relay"
		return tx.SaveSettings(set)
	}); err != nil {
		t.Fatal(err)
	}
	e.s.APIURL = f.srv.URL
	re := &relayEnv{env: e, fake: f, url: "https://ci.example"}
	re.relay = NewRelay(e.s, func() string { return re.url })
	re.relay.oidc = newOIDCVerifier(f.srv.URL, http.DefaultClient, time.Now)
	return re
}

// collect asks for a runner like the relay workflow does.
func (re *relayEnv) collect(token string) (int, map[string]string) {
	req := httptest.NewRequest("POST", "/webhook/relay", nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	re.relay.ServeHTTP(rec, req)
	out := map[string]string{}
	body, _ := io.ReadAll(rec.Body)
	_ = json.Unmarshal(body, &out)
	return rec.Code, out
}

func TestRelayStartCollectAndEnd(t *testing.T) {
	re := newRelayEnv(t, true)
	name := "ci-plane-abc123-github-hosted-01"
	spec := engine.RunnerSpec{Name: name, JITConfig: "SECRETJIT-1"}
	if err := re.relay.Start(ctx, model.Worker{ID: model.RelayWorkerID}, spec); err != nil {
		t.Fatal(err)
	}
	if n := len(re.fake.dispatches); n != 1 {
		t.Fatalf("%d dispatches", n)
	}
	d := re.fake.dispatches[0]
	inputs := d["inputs"].(map[string]any)
	if d["ref"] != "main" || inputs["runner"] != name || inputs["url"] != "https://ci.example" {
		t.Fatalf("dispatch: %v", d)
	}
	if strings.Contains(fmt.Sprint(d), "SECRETJIT") {
		t.Fatal("the configuration went to GitHub with the dispatch")
	}
	// Not stored in the clear.
	_ = re.st.View(func(tx *store.Tx) error {
		b, err := tx.Get("secret:" + pendingName(name))
		if err != nil || strings.Contains(string(b), "SECRETJIT") {
			t.Errorf("stored configuration: %q %v", b, err)
		}
		return nil
	})

	list, err := re.relay.List(ctx, model.Worker{})
	if err != nil || len(list) != 1 || list[0].Runner != name || !list[0].Running {
		t.Fatalf("list: %+v %v", list, err)
	}

	// The run collects its runner, once.
	code, out := re.collect(re.fake.token(nil))
	if code != 200 || out["jitconfig"] != "SECRETJIT-1" || out["runner"] != name {
		t.Fatalf("collect: %d %v", code, out)
	}
	// The same run may ask again (its answer may have been lost), another may not.
	if code, out = re.collect(re.fake.token(nil)); code != 200 || out["jitconfig"] != "SECRETJIT-1" {
		t.Fatalf("second collect of the same run: %d %v", code, out)
	}
	re.fake.mu.Lock()
	re.fake.runs = append(re.fake.runs, &relayRun{ID: 9050, Title: name, Status: "queued", CreatedAt: re.clock().UTC().Format(time.RFC3339)})
	re.fake.mu.Unlock()
	if code, out = re.collect(re.fake.token(func(c map[string]any) { c["run_id"] = "9050" })); code != 404 {
		t.Fatalf("collect by another run of the same name: %d %v", code, out)
	}
	if code, out = re.collect(re.fake.token(func(c map[string]any) { c["run_id"] = "9999" })); code != 404 {
		t.Fatalf("collect by a run GitHub does not know: %d %v", code, out)
	}
	re.fake.mu.Lock()
	re.fake.runs = re.fake.runs[:1]
	re.fake.mu.Unlock()
	re.advance(6 * time.Minute)
	if code, out = re.collect(re.fake.token(nil)); code != 404 {
		t.Fatalf("collect of the same run much later: %d %v", code, out)
	}

	// The run ends after its job: the runner exited normally.
	run := re.fake.run(9001)
	re.fake.mu.Lock()
	run.Status, run.Conclusion = "completed", "success"
	re.fake.mu.Unlock()
	list, _ = re.relay.List(ctx, model.Worker{})
	if len(list) != 1 || list[0].Running || list[0].ExitCode != 0 {
		t.Fatalf("after the run: %+v", list)
	}
	if err := re.relay.Remove(ctx, model.Worker{}, name); err != nil || re.fake.cancels != 0 {
		t.Fatalf("remove of an ended run: %v, %d cancels", err, re.fake.cancels)
	}
}

func TestRelayRemoveCancelsTheRunAndForgetsTheRunner(t *testing.T) {
	re := newRelayEnv(t, true)
	name := "ci-plane-abc123-github-hosted-02"
	if err := re.relay.Start(ctx, model.Worker{}, engine.RunnerSpec{Name: name, JITConfig: "SECRETJIT-2"}); err != nil {
		t.Fatal(err)
	}
	if err := re.relay.Remove(ctx, model.Worker{}, name); err != nil {
		t.Fatal(err)
	}
	if re.fake.cancels != 1 {
		t.Fatalf("%d cancels", re.fake.cancels)
	}
	if code, _ := re.collect(re.fake.token(nil)); code != 404 {
		t.Fatalf("a removed runner was handed out: %d", code)
	}
	list, _ := re.relay.List(ctx, model.Worker{})
	if len(list) != 1 || list[0].Running || list[0].ExitCode == 0 {
		t.Fatalf("a cancelled run: %+v", list)
	}
}

func TestRelayStartAgainStopsTheEarlierRun(t *testing.T) {
	re := newRelayEnv(t, true)
	name := "ci-plane-abc123-github-hosted-03"
	for i := 0; i < 2; i++ {
		if err := re.relay.Start(ctx, model.Worker{}, engine.RunnerSpec{Name: name, JITConfig: fmt.Sprint("SECRETJIT-", i)}); err != nil {
			t.Fatal(err)
		}
	}
	if re.fake.cancels != 1 || len(re.fake.dispatches) != 2 {
		t.Fatalf("%d cancels, %d dispatches", re.fake.cancels, len(re.fake.dispatches))
	}
	list, _ := re.relay.List(ctx, model.Worker{})
	if len(list) != 1 || !list[0].Running {
		t.Fatalf("the newer run must count: %+v", list)
	}
	code, out := re.collect(re.fake.token(func(c map[string]any) { c["run_id"] = "9002" }))
	if code != 200 || out["jitconfig"] != "SECRETJIT-1" {
		t.Fatalf("collect: %d %v", code, out)
	}
}

func TestRelayRefusesTokensThatAreNotTheRelayRun(t *testing.T) {
	re := newRelayEnv(t, true)
	name := "ci-plane-abc123-github-hosted-04"
	if err := re.relay.Start(ctx, model.Worker{}, engine.RunnerSpec{Name: name, JITConfig: "SECRETJIT-4"}); err != nil {
		t.Fatal(err)
	}
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	now := time.Now().Unix()
	cases := []struct {
		name  string
		token string
		code  int
	}{
		{"none", "", 401},
		{"garbage", "a.b.c", 401},
		{"other repository", re.fake.token(func(c map[string]any) { c["repository"], c["repository_id"] = "evil/fork", "666" }), 403},
		{"same name, other id", re.fake.token(func(c map[string]any) { c["repository_id"] = "666" }), 403},
		{"other workflow", re.fake.token(func(c map[string]any) {
			c["workflow_ref"] = "acme/relay/.github/workflows/other.yml@refs/heads/main"
		}), 403},
		{"push event", re.fake.token(func(c map[string]any) { c["event_name"] = "push" }), 403},
		{"dispatched by a person", re.fake.token(func(c map[string]any) { c["actor"] = "mallory" }), 403},
		{"other branch", re.fake.token(func(c map[string]any) {
			c["workflow_ref"] = "acme/relay/.github/workflows/ci-plane-relay.yml@refs/heads/evil"
		}), 403},
		{"other audience", re.fake.token(func(c map[string]any) { c["aud"] = "sts.amazonaws.com" }), 401},
		{"expired", re.fake.token(func(c map[string]any) { c["exp"] = now - 600 }), 401},
		{"other issuer", re.fake.token(func(c map[string]any) { c["iss"] = "https://evil.example" }), 401},
		{"wrong key", re.fake.sign(map[string]any{"alg": "RS256", "kid": "k1"}, map[string]any{
			"iss": re.fake.srv.URL, "aud": model.RelayAudience, "exp": now + 300, "repository": "acme/relay", "repository_id": "555",
			"run_id": "9001", "workflow_ref": "acme/relay/.github/workflows/ci-plane-relay.yml@refs/heads/main", "event_name": "workflow_dispatch",
		}, other), 401},
		{"unknown key", re.fake.sign(map[string]any{"alg": "RS256", "kid": "k9"}, map[string]any{"iss": re.fake.srv.URL}, re.fake.key), 401},
		{"alg none", base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","kid":"k1"}`)) + "." +
			base64.RawURLEncoding.EncodeToString([]byte(`{"iss":"x"}`)) + ".", 401},
	}
	for _, c := range cases {
		if code, out := re.collect(c.token); code != c.code {
			t.Errorf("%s: %d %v, want %d", c.name, code, out, c.code)
		}
	}
	// None of them used it up.
	if code, out := re.collect(re.fake.token(nil)); code != 200 || out["jitconfig"] != "SECRETJIT-4" {
		t.Fatalf("the real run: %d %v", code, out)
	}
}

func TestRelayErrorsSayWhatToDo(t *testing.T) {
	re := newRelayEnv(t, true)
	spec := engine.RunnerSpec{Name: "ci-plane-abc123-github-hosted-05", JITConfig: "SECRETJIT-5"}

	re.url = ""
	if err := re.relay.Start(ctx, model.Worker{}, spec); err == nil || !strings.Contains(err.Error(), "Cloudflare") {
		t.Errorf("no public address: %v", err)
	}
	if st := re.relay.Status(model.RelayWorkerID); st.Connected {
		t.Error("connected without a public address")
	}
	re.url = "https://ci.example"

	re.fake.noWorkflow = true
	if err := re.relay.Start(ctx, model.Worker{}, spec); err == nil || !strings.Contains(err.Error(), "ci-plane-relay.yml") {
		t.Errorf("no workflow: %v", err)
	}
	if p := re.relay.Check(ctx); len(p) != 1 || !strings.Contains(p[0], "not in acme/relay") {
		t.Errorf("check without workflow: %v", p)
	}
	re.fake.noWorkflow = false

	re.fake.failDispatch = 1
	if err := re.relay.Start(ctx, model.Worker{}, spec); err == nil || !strings.Contains(err.Error(), "Replace the workflow") {
		t.Errorf("no workflow_dispatch: %v", err)
	}
	_ = re.st.View(func(tx *store.Tx) error {
		if _, err := tx.Get("secret:" + pendingName(spec.Name)); err == nil {
			t.Error("the configuration of a failed dispatch was kept")
		}
		return nil
	})

	re.fake.readOnly = true
	if err := re.relay.Start(ctx, model.Worker{}, spec); err == nil || !strings.Contains(err.Error(), "Actions: Read and write") ||
		!strings.Contains(err.Error(), "github.com/organizations/acme/settings/apps/ci-plane-acme/permissions") {
		t.Errorf("app without Actions write: %v", err)
	}
	if p := re.relay.Check(ctx); len(p) != 1 || !strings.Contains(p[0], "may not start workflows") {
		t.Errorf("check of an app without Actions write: %v", p)
	}
	re.fake.readOnly = false

	re.fake.disabled = true
	if p := re.relay.Check(ctx); len(p) != 1 || !strings.Contains(p[0], "disabled") {
		t.Errorf("check of a disabled workflow: %v", p)
	}
	re.fake.disabled = false
	if p := re.relay.Check(ctx); len(p) != 0 {
		t.Errorf("check when ready: %v", p)
	}

	public := newRelayEnv(t, false)
	if err := public.relay.Start(ctx, model.Worker{}, spec); err == nil || !strings.Contains(err.Error(), "public") {
		t.Errorf("public repository: %v", err)
	}

	_ = re.st.Tx(func(tx *store.Tx) error {
		set, _ := tx.Settings()
		set.RelayRepo = "acme/unknown"
		return tx.SaveSettings(set)
	})
	if p := re.relay.Check(ctx); len(p) != 1 || !strings.Contains(p[0], "install the GitHub App of acme") {
		t.Errorf("check of an unknown repository: %v", p)
	}
}

func TestRelayListsAJustDispatchedRunUntilGitHubShowsIt(t *testing.T) {
	re := newRelayEnv(t, true)
	name := "ci-plane-abc123-github-hosted-06"
	if err := re.relay.Start(ctx, model.Worker{}, engine.RunnerSpec{Name: name, JITConfig: "x"}); err != nil {
		t.Fatal(err)
	}
	// GitHub has not listed the run yet.
	re.fake.mu.Lock()
	hidden := re.fake.runs
	re.fake.runs = nil
	re.fake.mu.Unlock()
	list, _ := re.relay.List(ctx, model.Worker{})
	if len(list) != 1 || !list[0].Running {
		t.Fatalf("just dispatched: %+v", list)
	}
	re.advance(3 * time.Minute)
	if list, _ = re.relay.List(ctx, model.Worker{}); len(list) != 0 {
		t.Fatalf("a run GitHub never showed still counts: %+v", list)
	}
	_ = hidden
}
