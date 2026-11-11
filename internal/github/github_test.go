package github

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

var ctx = context.Background()

func TestManifestRoundTripAcrossRestart(t *testing.T) {
	e := newEnv(t)
	form, err := e.s.Manifest("acme-corporation-with-a-long-name", "https://ci.example.com/", "https://ci.example.com/setup/github")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(form.Action)
	if u.Host != "github.example" || u.Path != "/organizations/acme-corporation-with-a-long-name/settings/apps/new" || u.Query().Get("state") != form.State {
		t.Fatalf("action = %s", form.Action)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(form.Manifest), &m); err != nil {
		t.Fatal(err)
	}
	name := m["name"].(string)
	if len(name) > 34 || !strings.HasPrefix(name, "CI-Plane acme") {
		t.Fatalf("name %q", name)
	}
	hook := m["hook_attributes"].(map[string]any)
	if hook["url"] != "https://ci.example.com/webhook" || hook["active"] != true {
		t.Fatalf("hook %v", hook)
	}
	if m["public"] != false || m["redirect_url"] != "https://ci.example.com/setup/github" || m["setup_url"] != "https://ci.example.com/setup/github" {
		t.Fatalf("manifest %v", m)
	}
	if ev := m["default_events"].([]any); len(ev) != 1 || ev[0] != "workflow_job" {
		t.Fatalf("events %v", ev)
	}
	perms := m["default_permissions"].(map[string]any)
	want := map[string]any{"organization_self_hosted_runners": "write", "actions": "write", "metadata": "read"}
	if fmt.Sprint(perms) != fmt.Sprint(want) {
		t.Fatalf("permissions %v", perms)
	}

	// A user app: other URL, other permission.
	uform, err := e.s.Manifest("", "https://ci.example.com", "https://ci.example.com/setup/github")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(uform.Action, "https://github.example/settings/apps/new?state=") || uform.State == form.State {
		t.Fatalf("user action %s", uform.Action)
	}
	json.Unmarshal([]byte(uform.Manifest), &m)
	if p := m["default_permissions"].(map[string]any); p["administration"] != "write" || p["organization_self_hosted_runners"] != nil {
		t.Fatalf("user permissions %v", p)
	}
	if _, err := e.s.Manifest("", "http://insecure.example", "https://x.example/"); err == nil {
		t.Fatal("http webhook accepted")
	}

	// Restart between Manifest and Complete.
	_, pemKey := key(t)
	e.gh.conversions["code1"] = map[string]any{
		"id": 4242, "slug": "ci-plane-acme-1a2b3c", "html_url": "https://github.example/apps/ci-plane-acme-1a2b3c",
		"owner": map[string]any{"login": "acme-corporation-with-a-long-name", "type": "Organization"},
		"pem":   pemKey, "webhook_secret": "whsec", "client_secret": "clsec", "client_id": "Iv1.x",
	}
	s2 := e.service()
	if _, err := s2.Complete(ctx, "code1", "forged"); err == nil {
		t.Fatal("unknown state accepted")
	}
	acc, err := s2.Complete(ctx, "code1", form.State)
	if err != nil {
		t.Fatal(err)
	}
	if acc.ID != 4242 || !acc.IsOrg() || acc.Owner != "acme-corporation-with-a-long-name" || !acc.Enabled || acc.InstallationID != 0 {
		t.Fatalf("account %+v", acc)
	}
	stored := e.account(4242)
	if stored.Slug != "ci-plane-acme-1a2b3c" {
		t.Fatalf("stored %+v", stored)
	}
	e.st.View(func(tx *store.Tx) error {
		for name, want := range map[string]string{keyName(4242): pemKey, hookName(4242): "whsec", clientName(4242): "clsec"} {
			got, err := e.box.Get(tx, name)
			if err != nil || string(got) != want {
				t.Errorf("secret %s: %v", name, err)
			}
		}
		return nil
	})
	if _, err := s2.Complete(ctx, "code1", form.State); err == nil {
		t.Fatal("state used twice")
	}
	if got := s2.InstallURL(acc); got != "https://github.example/apps/ci-plane-acme-1a2b3c/installations/new" {
		t.Fatal(got)
	}

	// The pending user app expires after an hour.
	e.advance(2 * time.Hour)
	if _, err := s2.Complete(ctx, "code2", uform.State); err == nil || !strings.Contains(err.Error(), "expired") {
		t.Fatalf("expired state: %v", err)
	}
}

func TestAppNameFits(t *testing.T) {
	for _, org := range []string{"", "a", strings.Repeat("x", 39)} {
		if n := appName(org, "abcdef"); len(n) > maxAppName {
			t.Errorf("%q is %d long", n, len(n))
		}
	}
}

func TestTokenCachingAndRenewal(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	tgt := engine.Target{AccountID: 1, Owner: "acme"}
	for i := 0; i < 3; i++ {
		if _, err := e.s.ListRunners(ctx, tgt); err != nil {
			t.Fatal(err)
		}
	}
	if e.gh.tokens != 1 {
		t.Fatalf("%d tokens for three calls", e.gh.tokens)
	}
	e.advance(50 * time.Minute) // still 10 min left: reused
	e.s.ListRunners(ctx, tgt)
	if e.gh.tokens != 1 {
		t.Fatalf("renewed too early: %d", e.gh.tokens)
	}
	e.advance(6 * time.Minute) // 4 min left: renewed
	e.s.ListRunners(ctx, tgt)
	if e.gh.tokens != 2 {
		t.Fatalf("not renewed: %d", e.gh.tokens)
	}

	// Many callers at once on a fresh service fetch one token.
	s := e.service()
	e.gh.tokenDelay = 50 * time.Millisecond
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := s.ListRunners(ctx, tgt); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if e.gh.tokens != 3 {
		t.Fatalf("stampede: %d tokens", e.gh.tokens)
	}

	// Not installed: a clear error, no request.
	e.addApp(2, "solo", "User", 0, "s")
	_, err := e.s.ListRunners(ctx, engine.Target{AccountID: 2, Owner: "solo", Repo: "solo/app"})
	if err == nil || !strings.Contains(err.Error(), "not installed") {
		t.Fatalf("err = %v", err)
	}
}

func TestRunnersOrgAndRepo(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	e.addApp(2, "solo", "User", 78, "s")
	org := engine.Target{AccountID: 1, Owner: "acme"}
	repo := engine.Target{AccountID: 2, Owner: "solo", Repo: "solo/app"}
	labels := []string{"self-hosted", "linux", "x64", "ci-plane", "size-m"}

	reg, err := e.s.CreateRunner(ctx, org, "ci-plane-w1-a", labels)
	if err != nil || reg.ID == 0 || reg.JITConfig != "SECRETJITci-plane-w1-a" {
		t.Fatalf("%+v %v", reg, err)
	}
	if e.gh.count("POST /orgs/acme/actions/runners/generate-jitconfig") != 1 {
		t.Fatal("org endpoint not used")
	}
	if e.gh.lastJIT["runner_group_id"] != float64(1) || fmt.Sprint(e.gh.lastJIT["labels"]) != fmt.Sprint(labels) {
		t.Fatalf("jit body %v", e.gh.lastJIT)
	}
	if _, err := e.s.CreateRunner(ctx, org, "ci-plane-w1-a", labels); !errors.Is(err, engine.ErrRunnerExists) {
		t.Fatalf("taken name: %v", err)
	}
	rreg, err := e.s.CreateRunner(ctx, repo, "ci-plane-w1-b", labels)
	if err != nil || e.gh.count("POST /repos/solo/app/actions/runners/generate-jitconfig") != 1 {
		t.Fatalf("repo runner: %v", err)
	}

	list, err := e.s.ListRunners(ctx, repo)
	if err != nil || len(list) != 1 || list[0].Name != "ci-plane-w1-b" || list[0].Online {
		t.Fatalf("%+v %v", list, err)
	}

	e.gh.runners["repo:solo/app"][0].Busy = true
	if err := e.s.DeleteRunner(ctx, repo, rreg.ID); !errors.Is(err, engine.ErrRunnerBusy) {
		t.Fatalf("busy: %v", err)
	}
	e.gh.runners["repo:solo/app"][0].Busy = false
	if err := e.s.DeleteRunner(ctx, repo, rreg.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.s.DeleteRunner(ctx, repo, rreg.ID); err != nil {
		t.Fatalf("missing runner: %v", err)
	}
	if err := e.s.DeleteRunner(ctx, org, reg.ID); err != nil || len(e.gh.runners["org:acme"]) != 0 {
		t.Fatalf("org delete: %v", err)
	}
	if h := e.s.Health(1); h.LastError != "" || h.RateRemaining != 4999 {
		t.Fatalf("health %+v", h)
	}
}

func TestListRunnersPaginates(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	for i := 0; i < 250; i++ {
		e.gh.runners["org:acme"] = append(e.gh.runners["org:acme"], &fakeRunner{ID: int64(i + 1), Name: fmt.Sprintf("r%d", i), Status: "online", Busy: i%2 == 0})
	}
	list, err := e.s.ListRunners(ctx, engine.Target{AccountID: 1, Owner: "acme"})
	if err != nil || len(list) != 250 || !list[0].Online || !list[0].Busy || list[1].Busy {
		t.Fatalf("%d %v", len(list), err)
	}
	if n := e.gh.count("GET /orgs/acme/actions/runners"); n != 3 {
		t.Fatalf("%d pages", n)
	}
}

func job(id, run int64, status string, labels ...string) ghJob {
	return ghJob{
		ID: id, RunID: run, Status: status, Name: fmt.Sprintf("job-%d", id), WorkflowName: "CI", HeadBranch: "main",
		HTMLURL: fmt.Sprintf("https://github.example/acme/app/actions/runs/%d/job/%d", run, id), Labels: labels,
		CreatedAt: "2026-11-10T10:00:00Z", StartedAt: "2026-11-10T10:01:00Z",
	}
}

func TestQueuedJobs(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	repo := ghRepo{ID: 555, FullName: "acme/app", Private: true}
	done := job(12, 2, "completed", "ci-plane")
	done.Conclusion = "success"
	e.gh.runs["acme/app"] = []*fakeRun{
		{ghRun: ghRun{ID: 1, Status: "queued", UpdatedAt: "2026-11-10T10:00:00Z", RunAttempt: 1, Repository: repo},
			jobs: []ghJob{job(11, 1, "queued", "self-hosted", "ci-plane")}},
		// An in-progress run with a job that waits for its needs to finish.
		{ghRun: ghRun{ID: 2, Status: "in_progress", UpdatedAt: "2026-11-10T10:05:00Z", RunAttempt: 1, Repository: repo},
			jobs: []ghJob{done, job(13, 2, "queued", "ci-plane", "size-l")}},
		{ghRun: ghRun{ID: 3, Status: "completed", UpdatedAt: "2026-11-10T09:00:00Z", Repository: repo},
			jobs: []ghJob{job(14, 3, "queued", "ci-plane")}},
	}
	got, err := e.s.QueuedJobs(ctx, 1, "acme/app")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ID != 11 || got[1].ID != 13 {
		t.Fatalf("%+v", got)
	}
	ev := got[1]
	want := engine.JobEvent{
		Action: "queued", ID: 13, RunID: 2, AccountID: 1, RepoID: 555, Repo: "acme/app", Private: true, Name: "job-13",
		Workflow: "CI", Branch: "main", HTMLURL: "https://github.example/acme/app/actions/runs/2/job/13",
		Labels: []string{"ci-plane", "size-l"}, At: time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC).UnixMilli(),
	}
	if fmt.Sprint(ev) != fmt.Sprint(want) {
		t.Fatalf("event\n got %+v\nwant %+v", ev, want)
	}
	jobCalls := func() int {
		return e.gh.count("GET /repos/acme/app/actions/runs/1/jobs") + e.gh.count("GET /repos/acme/app/actions/runs/2/jobs")
	}
	if jobCalls() != 2 || e.gh.count("GET /repos/acme/app/actions/runs/3/jobs") != 0 {
		t.Fatalf("jobs fetched %d times", jobCalls())
	}

	// Nothing changed: lists answer 304, jobs are not asked for.
	e.gh.notModified.Store(0)
	got, err = e.s.QueuedJobs(ctx, 1, "acme/app")
	if err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
	if e.gh.notModified.Load() != int64(len(openRunStates)) || jobCalls() != 2 {
		t.Fatalf("304s %d, job calls %d", e.gh.notModified.Load(), jobCalls())
	}

	// Run 2 changes: only its jobs are fetched again.
	e.gh.mu.Lock()
	r2 := e.gh.runs["acme/app"][1]
	r2.UpdatedAt = "2026-11-10T10:06:00Z"
	r2.jobs[1].Status = "in_progress"
	r2.jobs = append(r2.jobs, job(15, 2, "queued", "ci-plane"))
	e.gh.mu.Unlock()
	got, err = e.s.QueuedJobs(ctx, 1, "acme/app")
	if err != nil || len(got) != 2 || got[1].ID != 15 {
		t.Fatalf("%+v %v", got, err)
	}
	if e.gh.count("GET /repos/acme/app/actions/runs/1/jobs") != 1 || e.gh.count("GET /repos/acme/app/actions/runs/2/jobs") != 2 {
		t.Fatal("unchanged run fetched again")
	}

	// After a while unchanged runs are checked again, cheaply.
	e.advance(runReuse + time.Second)
	e.gh.notModified.Store(0)
	if _, err := e.s.QueuedJobs(ctx, 1, "acme/app"); err != nil {
		t.Fatal(err)
	}
	if e.gh.notModified.Load() != int64(len(openRunStates)+2) {
		t.Fatalf("%d 304s", e.gh.notModified.Load())
	}
}

func TestRerunJob(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	j := job(21, 5, "completed", "ci-plane")
	j.Conclusion, j.RunAttempt = "failure", 2
	run := &fakeRun{ghRun: ghRun{ID: 5, Status: "in_progress", RunAttempt: 2}, jobs: []ghJob{j}}
	e.gh.runs["acme/app"] = []*fakeRun{run}
	rerun := func(job int64) error { return e.s.RerunJob(ctx, 1, "acme/app", 5, job, 2) }

	if ev, err := e.s.Job(ctx, 1, "acme/app", 21); err != nil || ev.RunAttempt != 2 {
		t.Fatalf("run attempt: %+v %v", ev, err)
	}
	// While other jobs of the run are going on, GitHub refuses; the engine
	// asks again. The text is GitHub's reason, not a guess about permissions.
	if err := rerun(21); err == nil || !strings.Contains(err.Error(), "already running") || strings.Contains(err.Error(), "permission") {
		t.Fatalf("run still going on: %v", err)
	}
	e.gh.mu.Lock()
	run.Status = "completed"
	e.gh.mu.Unlock()
	if err := rerun(21); err != nil {
		t.Fatal(err)
	}
	// Asked again, as after a lost answer: the run is in its next attempt,
	// so nothing is started a second time.
	if err := rerun(21); err != nil {
		t.Fatal(err)
	}
	if len(e.gh.reruns) != 1 || e.gh.reruns[0] != 21 {
		t.Fatalf("reruns: %v", e.gh.reruns)
	}
	if err := e.s.RerunJob(ctx, 1, "acme/app", 0, 99, 0); !errors.Is(err, engine.ErrGone) {
		t.Fatalf("deleted job: %v", err)
	}
	// An app from before this feature says what to change.
	e.gh.mu.Lock()
	e.gh.readOnlyActions = true
	run.RunAttempt = 2
	e.gh.mu.Unlock()
	if err := rerun(21); err == nil || !strings.Contains(err.Error(), "Read and write") {
		t.Fatalf("read-only app: %v", err)
	}
}

func TestJob(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	j := job(21, 5, "completed", "ci-plane")
	j.Conclusion, j.RunnerName, j.CompletedAt = "failure", "ci-plane-w1-x", "2026-11-10T10:09:00Z"
	w := job(22, 5, "waiting", "ci-plane")
	p := job(23, 5, "in_progress", "ci-plane")
	p.RunnerName = "ci-plane-w2-y"
	e.gh.runs["acme/app"] = []*fakeRun{{ghRun: ghRun{ID: 5, Status: "in_progress"}, jobs: []ghJob{j, w, p}}}

	ev, err := e.s.Job(ctx, 1, "acme/app", 21)
	if err != nil || ev.Action != "completed" || ev.Conclusion != "failure" || ev.RunnerName != "ci-plane-w1-x" ||
		ev.At != time.Date(2026, 11, 10, 10, 9, 0, 0, time.UTC).UnixMilli() || ev.Repo != "acme/app" || ev.AccountID != 1 {
		t.Fatalf("%+v %v", ev, err)
	}
	if ev, _ := e.s.Job(ctx, 1, "acme/app", 22); ev.Action != "" {
		t.Fatalf("waiting: %q", ev.Action)
	}
	if ev, _ := e.s.Job(ctx, 1, "acme/app", 23); ev.Action != "in_progress" || ev.Conclusion != "" ||
		ev.At != time.Date(2026, 11, 10, 10, 1, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("in progress: %+v", ev)
	}
	if _, err := e.s.Job(ctx, 1, "acme/app", 99); !errors.Is(err, engine.ErrGone) {
		t.Fatalf("gone: %v", err)
	}
}

func TestRetriesAndRateLimit(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	tgt := engine.Target{AccountID: 1, Owner: "acme"}
	e.gh.fail["GET /orgs/acme/actions/runners"] = []int{502, 503}
	if _, err := e.s.ListRunners(ctx, tgt); err != nil {
		t.Fatalf("not retried: %v", err)
	}
	e.gh.fail["GET /orgs/acme/actions/runners"] = []int{500, 500, 500, 500}
	if _, err := e.s.ListRunners(ctx, tgt); err == nil || statusOf(err) != 500 {
		t.Fatalf("gave up with %v", err)
	}
	if h := e.s.Health(1); !strings.Contains(h.LastError, "500") {
		t.Fatalf("health %+v", h)
	}

	e.gh.fail["GET /orgs/acme/actions/runners"] = []int{403}
	_, err := e.s.ListRunners(ctx, tgt)
	var rl *RateLimitError
	if !errors.As(err, &rl) || !strings.Contains(err.Error(), "until") {
		t.Fatalf("rate limit: %v", err)
	}
	before := e.gh.count("GET /orgs/acme/actions/runners")
	if _, err := e.s.ListRunners(ctx, tgt); !errors.As(err, &rl) || e.gh.count("GET /orgs/acme/actions/runners") != before {
		t.Fatalf("asked GitHub although the limit is used up: %v", err)
	}
	e.advance(21 * time.Minute)
	if _, err := e.s.ListRunners(ctx, tgt); err != nil {
		t.Fatalf("after the reset: %v", err)
	}
}

// --- webhooks ------------------------------------------------------------

func sign(secret string, body []byte) string {
	m := hmac.New(sha256.New, []byte(secret))
	m.Write(body)
	return "sha256=" + hex.EncodeToString(m.Sum(nil))
}

type hookClient struct {
	t   *testing.T
	srv *httptest.Server
}

func (h hookClient) post(app, event, guid, secret string, body []byte) int {
	h.t.Helper()
	req, _ := http.NewRequest(http.MethodPost, h.srv.URL, strings.NewReader(string(body)))
	if app != "" {
		req.Header.Set("X-GitHub-Hook-Installation-Target-ID", app)
		req.Header.Set("X-GitHub-Hook-Installation-Target-Type", "integration")
	}
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", guid)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Hub-Signature-256", sign(secret, body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	resp.Body.Close()
	return resp.StatusCode
}

func jobPayload(action string, j ghJob) []byte {
	b, _ := json.Marshal(map[string]any{
		"action": action, "workflow_job": j,
		"repository":   map[string]any{"id": 555, "full_name": "acme/app", "private": true},
		"installation": map[string]any{"id": 77},
	})
	return b
}

func TestWebhook(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "right")
	var mu sync.Mutex
	var got []engine.JobEvent
	failNext := false
	srv := httptest.NewServer(e.s.WebhookHandler(func(ev engine.JobEvent) error {
		mu.Lock()
		defer mu.Unlock()
		if failNext {
			failNext = false
			return errors.New("database is locked")
		}
		got = append(got, ev)
		return nil
	}))
	defer srv.Close()
	h := hookClient{t, srv}

	// The tunnel check.
	resp, err := http.Get(srv.URL)
	if err != nil || resp.StatusCode != 200 || resp.Header.Get("X-CI-Plane") != "webhook" {
		t.Fatalf("GET: %v %v", resp, err)
	}

	j := job(31, 9, "in_progress", "self-hosted", "ci-plane")
	j.CreatedAt = e.clock().Add(-time.Minute).UTC().Format(time.RFC3339)
	j.StartedAt = e.clock().UTC().Format(time.RFC3339)
	j.RunnerName = "ci-plane-w1-z"
	body := jobPayload("in_progress", j)

	if c := h.post("1", "workflow_job", "g1", "right", body); c != 200 {
		t.Fatalf("valid: %d", c)
	}
	if len(got) != 1 {
		t.Fatal("onJob not called")
	}
	ev := got[0]
	if ev.Action != "in_progress" || ev.AccountID != 1 || ev.ID != 31 || ev.RunID != 9 || ev.RepoID != 555 || ev.Repo != "acme/app" ||
		!ev.Private || ev.RunnerName != "ci-plane-w1-z" || ev.At != millis(j.StartedAt) || len(ev.Labels) != 2 {
		t.Fatalf("event %+v", ev)
	}
	if h := e.s.Health(1); h.LastWebhookAt == 0 || h.LastError != "" {
		t.Fatalf("health %+v", h)
	}

	if c := h.post("1", "workflow_job", "g2", "wrong", body); c != 401 {
		t.Fatalf("wrong secret: %d", c)
	}
	if c := h.post("2", "workflow_job", "g3", "right", body); c != 401 {
		t.Fatalf("unknown app: %d", c)
	}
	if c := h.post("", "workflow_job", "g4", "right", body); c != 401 {
		t.Fatalf("no app: %d", c)
	}
	big := make([]byte, maxBody+1)
	if c := h.post("1", "workflow_job", "g5", "right", big); c != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized: %d", c)
	}
	if c := h.post("1", "workflow_job", "g1", "right", body); c != 200 || len(got) != 1 {
		t.Fatalf("replay: %d, %d events", c, len(got))
	}
	if !strings.Contains(e.s.Health(1).LastError, "wrong signature") {
		t.Fatalf("health %+v", e.s.Health(1))
	}

	// A failure is a 500, and the redelivery (same guid) is handled.
	failNext = true
	done := j
	done.Status, done.Conclusion, done.CompletedAt = "completed", "success", e.clock().UTC().Format(time.RFC3339)
	cbody := jobPayload("completed", done)
	if c := h.post("1", "workflow_job", "g6", "right", cbody); c != 500 {
		t.Fatalf("failing onJob: %d", c)
	}
	if c := h.post("1", "workflow_job", "g6", "right", cbody); c != 200 || len(got) != 2 || got[1].Conclusion != "success" || got[1].Action != "completed" {
		t.Fatalf("redelivery: %d %+v", c, got)
	}

	// waiting: passed on without an action.
	wj := j
	wj.Status = "waiting"
	h.post("1", "workflow_job", "g7", "right", jobPayload("waiting", wj))
	if len(got) != 3 || got[2].Action != "" {
		t.Fatalf("waiting: %+v", got)
	}

	// A captured event from long ago is not acted on.
	old := j
	old.CreatedAt = e.clock().Add(-10 * 24 * time.Hour).UTC().Format(time.RFC3339)
	if c := h.post("1", "workflow_job", "g8", "right", jobPayload("queued", old)); c != 200 || len(got) != 3 {
		t.Fatalf("old event: %d %d", c, len(got))
	}

	if c := h.post("1", "ping", "g9", "right", []byte(`{"zen":"Keep it logically awesome.","hook_id":1}`)); c != 200 {
		t.Fatalf("ping: %d", c)
	}
}

func TestInstallationEvents(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 0, "sec")
	srv := httptest.NewServer(e.s.WebhookHandler(func(engine.JobEvent) error { return nil }))
	defer srv.Close()
	h := hookClient{t, srv}
	post := func(event, guid string, v any) {
		t.Helper()
		b, _ := json.Marshal(v)
		if c := h.post("1", event, guid, "sec", b); c != 200 {
			t.Fatalf("%s: %d", event, c)
		}
	}
	inst := map[string]any{"id": 88, "account": map[string]any{"login": "acme", "type": "Organization"}}
	post("installation", "i1", map[string]any{"action": "created", "installation": inst, "repositories": []ghRepo{
		{ID: 1, FullName: "acme/a", Private: true}, {ID: 2, FullName: "acme/b", Private: true}}})
	if a := e.account(1); a.InstallationID != 88 {
		t.Fatalf("installation %d", a.InstallationID)
	}
	if r := e.repos(1); len(r) != 2 || !r[0].Enabled {
		t.Fatalf("repos %+v", r)
	}

	// The user's choice survives later events.
	e.st.Tx(func(tx *store.Tx) error {
		r, _ := tx.Repo(1)
		r.Enabled, r.MaxParallel = false, 3
		return tx.SaveRepo(r)
	})
	post("installation_repositories", "i2", map[string]any{"action": "added", "installation": inst,
		"repositories_added": []ghRepo{{ID: 3, FullName: "acme/c"}, {ID: 1, FullName: "acme/a-renamed", Private: true}}, "repositories_removed": []ghRepo{}})
	post("installation_repositories", "i3", map[string]any{"action": "removed", "installation": inst,
		"repositories_added": []ghRepo{}, "repositories_removed": []ghRepo{{ID: 2, FullName: "acme/b"}}})
	r := e.repos(1)
	if len(r) != 2 || r[0].FullName != "acme/a-renamed" || r[0].Enabled || r[0].MaxParallel != 3 || r[1].ID != 3 {
		t.Fatalf("repos %+v", r)
	}

	post("installation", "i4", map[string]any{"action": "deleted", "installation": inst})
	if a := e.account(1); a.InstallationID != 0 || len(e.repos(1)) != 0 {
		t.Fatalf("after uninstall: %+v %+v", a, e.repos(1))
	}
}

func TestSync(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 0, "s")
	e.gh.installations[1] = 91 // installed on GitHub, the event was missed
	for i := 1; i <= 150; i++ {
		e.gh.repos = append(e.gh.repos, ghRepo{ID: int64(i), FullName: fmt.Sprintf("acme/r%d", i), Private: true})
	}
	if err := e.s.Sync(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if a := e.account(1); a.InstallationID != 91 {
		t.Fatalf("installation %d", a.InstallationID)
	}
	if n := len(e.repos(1)); n != 150 {
		t.Fatalf("%d repos", n)
	}
	e.st.Tx(func(tx *store.Tx) error {
		r, _ := tx.Repo(7)
		r.Enabled = false
		return tx.SaveRepo(r)
	})
	e.gh.repos = e.gh.repos[:10]
	if err := e.s.Sync(ctx, 1); err != nil {
		t.Fatal(err)
	}
	r := e.repos(1)
	if len(r) != 10 || r[6].Enabled {
		t.Fatalf("%d repos, %+v", len(r), r[6])
	}
	e.gh.installations[1] = 0
	if err := e.s.Sync(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if a := e.account(1); a.InstallationID != 0 || len(e.repos(1)) != 0 {
		t.Fatal("uninstall not seen")
	}
}

func TestRedeliver(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	at := func(ago time.Duration) string { return e.clock().Add(-ago).UTC().Format(time.RFC3339) }
	// Newest first, as GitHub lists them.
	e.gh.deliveries = []delivery{
		{ID: 110, GUID: "A", DeliveredAt: at(1 * time.Minute), Redelivery: true, StatusCode: 200, Event: "workflow_job"},
		{ID: 109, GUID: "B", DeliveredAt: at(2 * time.Minute), StatusCode: 502, Event: "workflow_job"},
		{ID: 108, GUID: "C", DeliveredAt: at(3 * time.Minute), StatusCode: 0, Event: "installation"},
		{ID: 107, GUID: "D", DeliveredAt: at(4 * time.Minute), Redelivery: true, StatusCode: 500, Event: "workflow_job"},
		{ID: 106, GUID: "E", DeliveredAt: at(5 * time.Minute), StatusCode: 200, Event: "workflow_job"},
	}
	for i := 0; i < 150; i++ { // older successes, to make it page
		e.gh.deliveries = append(e.gh.deliveries, delivery{ID: int64(105 - i), GUID: fmt.Sprintf("ok%d", i), DeliveredAt: at(6 * time.Minute), StatusCode: 202, Event: "workflow_job"})
	}
	e.gh.deliveries = append(e.gh.deliveries,
		delivery{ID: 5, GUID: "D", DeliveredAt: at(20 * time.Minute), StatusCode: 500, Event: "workflow_job"},
		delivery{ID: 4, GUID: "A", DeliveredAt: at(30 * time.Minute), StatusCode: 500, Event: "workflow_job"},
		delivery{ID: 3, GUID: "F", DeliveredAt: at(40 * time.Minute), StatusCode: 503, Event: "workflow_job"},
		delivery{ID: 2, GUID: "OLD", DeliveredAt: at(30 * time.Hour), StatusCode: 500, Event: "workflow_job"},
	)

	n, err := e.s.Redeliver(ctx, 1)
	if err != nil || n != 2 {
		t.Fatalf("%d %v", n, err)
	}
	if fmt.Sprint(e.gh.attempts) != "[109 3]" {
		t.Fatalf("redelivered %v", e.gh.attempts)
	}
	if e.gh.count("GET /app/hook/deliveries") < 2 {
		t.Fatal("did not page")
	}

	// GitHub has not listed the new attempt yet: still asked only once.
	e.advance(redeliverScan)
	if n, err := e.s.Redeliver(ctx, 1); err != nil || n != 0 || len(e.gh.attempts) != 2 {
		t.Fatalf("again: %d %v %v", n, err, e.gh.attempts)
	}
}

func TestSetPublicURLAndRemove(t *testing.T) {
	e := newEnv(t)
	e.addApp(1, "acme", "Organization", 77, "s")
	e.addApp(2, "solo", "User", 78, "s")
	if err := e.s.SetPublicURL(ctx, "https://new.example.com/"); err != nil {
		t.Fatal(err)
	}
	for _, id := range []int64{1, 2} {
		if e.gh.hookConfig[id]["url"] != "https://new.example.com/webhook" {
			t.Fatalf("app %d: %v", id, e.gh.hookConfig[id])
		}
	}
	e.st.Tx(func(tx *store.Tx) error {
		return tx.UpsertRepo(model.Repo{ID: 9, AccountID: 1, FullName: "acme/x", Enabled: true})
	})
	u, err := e.s.Remove(ctx, 1)
	if err != nil || u != "https://github.example/organizations/acme/settings/apps/ci-plane-acme/advanced" {
		t.Fatalf("%s %v", u, err)
	}
	if u, _ := e.s.Remove(ctx, 2); u != "https://github.example/settings/apps/ci-plane-solo/advanced" {
		t.Fatal(u)
	}
	e.st.View(func(tx *store.Tx) error {
		if _, err := tx.Account(1); !errors.Is(err, store.ErrNotFound) {
			t.Error("account kept")
		}
		if _, err := e.box.Get(tx, keyName(1)); !errors.Is(err, store.ErrNotFound) {
			t.Error("key kept")
		}
		return nil
	})
	if len(e.repos(1)) != 0 {
		t.Fatal("repos kept")
	}
	// Its webhooks are no longer accepted.
	srv := httptest.NewServer(e.s.WebhookHandler(func(engine.JobEvent) error { return nil }))
	defer srv.Close()
	if c := (hookClient{t, srv}).post("1", "ping", "x", "s", []byte(`{}`)); c != 401 {
		t.Fatalf("removed app: %d", c)
	}
}

// --- runner accounts -------------------------------------------------------

// addRunnerApp stores a runner account as Complete would and installs it on
// the fake.
func (e *env) addRunnerApp(id int64, owner, slug string, installation int64, repos ...model.Repo) model.Account {
	e.t.Helper()
	_, pemKey := key(e.t)
	acc := model.Account{ID: id, Slug: slug, Owner: owner, OwnerType: "Organization", InstallationID: installation, Runners: true}
	err := e.st.Tx(func(tx *store.Tx) error {
		if err := tx.SaveRunnerAccount(acc); err != nil {
			return err
		}
		if err := tx.SetRunnerRepos(id, repos); err != nil {
			return err
		}
		return e.box.Put(tx, keyName(id), []byte(pemKey))
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

func (e *env) runnerRepos(accountID int64) []model.Repo {
	e.t.Helper()
	var out []model.Repo
	if err := e.st.View(func(tx *store.Tx) error {
		var err error
		out, err = tx.RunnerRepos(accountID)
		return err
	}); err != nil {
		e.t.Fatal(err)
	}
	return out
}

func TestRunnerManifestAndComplete(t *testing.T) {
	e := newEnv(t)
	org := strings.Repeat("acme-corporation-", 2) + "long" // 38 characters
	form, err := e.s.RunnerManifest(org, "https://ci.example.com/github/return")
	if err != nil {
		t.Fatal(err)
	}
	u, _ := url.Parse(form.Action)
	if u.Path != "/organizations/"+org+"/settings/apps/new" || u.Query().Get("state") != form.State {
		t.Fatalf("action = %s", form.Action)
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(form.Manifest), &m); err != nil {
		t.Fatal(err)
	}
	if name, _ := m["name"].(string); len(name) > maxAppName || !strings.HasPrefix(name, "CI-Plane runners") {
		t.Fatalf("name %q (%d)", name, len(name))
	}
	// It may start workflows and nothing else, and hears nothing from GitHub.
	if perms := m["default_permissions"]; fmt.Sprint(perms) != fmt.Sprint(map[string]any{"actions": "write", "metadata": "read"}) {
		t.Fatalf("permissions %v", perms)
	}
	for _, k := range []string{"hook_attributes", "default_events"} {
		if v, ok := m[k]; ok {
			t.Errorf("%s in the manifest: %v", k, v)
		}
	}
	if m["public"] != false || m["redirect_url"] != "https://ci.example.com/github/return" {
		t.Fatalf("manifest %v", m)
	}
	for _, o := range []string{"", "a", strings.Repeat("x", 39)} {
		if n := runnerAppName(o, "abcdef"); len(n) > maxAppName || !strings.HasPrefix(n, "CI-Plane runners") {
			t.Errorf("%q is %d long", n, len(n))
		}
	}
	if _, err := e.s.RunnerManifest("not/an/org", "https://ci.example.com/github/return"); err == nil {
		t.Error("invalid organisation accepted")
	}

	// GitHub returns no webhook secret for an app without a webhook.
	_, pemKey := key(t)
	e.gh.conversions["code-r"] = map[string]any{
		"id": 5151, "slug": "ci-plane-runners-acme", "html_url": "https://github.example/apps/ci-plane-runners-acme",
		"owner": map[string]any{"login": org, "type": "Organization"}, "pem": pemKey, "client_secret": "clsec",
	}
	acc, err := e.service().Complete(ctx, "code-r", form.State)
	if err != nil {
		t.Fatal(err)
	}
	if acc.ID != 5151 || !acc.Runners || acc.Owner != org || !acc.IsOrg() {
		t.Fatalf("account %+v", acc)
	}
	e.st.View(func(tx *store.Tx) error {
		if a, err := tx.RunnerAccount(5151); err != nil || a.Slug != "ci-plane-runners-acme" || !a.Runners {
			t.Errorf("runner account %+v %v", a, err)
		}
		if accs, err := tx.Accounts(); err != nil || len(accs) != 0 {
			t.Errorf("stored as an account of the integration: %+v %v", accs, err)
		}
		if got, err := e.box.Get(tx, keyName(5151)); err != nil || string(got) != pemKey {
			t.Errorf("private key: %v", err)
		}
		if _, err := e.box.Get(tx, hookName(5151)); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("webhook secret stored: %v", err)
		}
		return nil
	})

	// Should GitHub return a webhook secret anyway, it is not kept, and
	// nothing signed with it is accepted.
	form2, err := e.s.RunnerManifest("", "https://ci.example.com/github/return")
	if err != nil {
		t.Fatal(err)
	}
	e.gh.conversions["code-r2"] = map[string]any{
		"id": 5252, "slug": "ci-plane-runners-solo", "owner": map[string]any{"login": "solo", "type": "User"},
		"pem": pemKey, "webhook_secret": "whsec",
	}
	if _, err := e.s.Complete(ctx, "code-r2", form2.State); err != nil {
		t.Fatal(err)
	}
	e.st.View(func(tx *store.Tx) error {
		if _, err := e.box.Get(tx, hookName(5252)); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("webhook secret of a runner account stored: %v", err)
		}
		return nil
	})
	srv := httptest.NewServer(e.s.WebhookHandler(func(engine.JobEvent) error {
		t.Error("a job of a runner account was passed on")
		return nil
	}))
	defer srv.Close()
	h := hookClient{t, srv}
	j := job(31, 9, "queued", "ci-plane")
	j.CreatedAt = e.clock().UTC().Format(time.RFC3339)
	for _, id := range []string{"5151", "5252"} {
		if c := h.post(id, "workflow_job", "r-"+id, "whsec", jobPayload("queued", j)); c != 401 {
			t.Errorf("webhook of runner app %s: %d", id, c)
		}
	}
}

func TestSyncOfARunnerAccount(t *testing.T) {
	e := newEnv(t)
	e.addRunnerApp(5, "acme", "ci-plane-runners-acme", 0)
	e.gh.installations[5] = 95 // installed on GitHub; a runner account hears of it only by asking
	e.gh.repos = []ghRepo{{ID: 1, FullName: "acme/relay", Private: true}, {ID: 2, FullName: "acme/site"}}
	if err := e.s.Sync(ctx, 5); err != nil {
		t.Fatal(err)
	}
	e.st.View(func(tx *store.Tx) error {
		if a, err := tx.RunnerAccount(5); err != nil || a.InstallationID != 95 {
			t.Errorf("installation: %+v %v", a, err)
		}
		if accs, _ := tx.Accounts(); len(accs) != 0 {
			t.Errorf("became an account of the integration: %+v", accs)
		}
		return nil
	})
	got := e.runnerRepos(5)
	if len(got) != 2 || got[0].FullName != "acme/relay" || !got[0].Private || got[0].AccountID != 5 || got[1].ID != 2 || got[1].Private {
		t.Fatalf("runner repos %+v", got)
	}
	if r := e.repos(0); len(r) != 0 {
		t.Fatalf("repositories of the integration: %+v", r)
	}

	e.gh.repos = e.gh.repos[1:]
	if err := e.s.Sync(ctx, 5); err != nil {
		t.Fatal(err)
	}
	if got := e.runnerRepos(5); len(got) != 1 || got[0].ID != 2 {
		t.Fatalf("after a repository was taken away: %+v", got)
	}
	e.gh.installations[5] = 0
	if err := e.s.Sync(ctx, 5); err != nil {
		t.Fatal(err)
	}
	e.st.View(func(tx *store.Tx) error {
		if a, _ := tx.RunnerAccount(5); a.InstallationID != 0 {
			t.Errorf("uninstall not seen: %+v", a)
		}
		return nil
	})
	if got := e.runnerRepos(5); len(got) != 0 || len(e.repos(0)) != 0 {
		t.Fatalf("after uninstall: %+v", got)
	}
}

func TestRemoveRunnerAccountInUse(t *testing.T) {
	e := newEnv(t)
	e.addRunnerApp(5, "acme", "ci-plane-runners-acme", 95, model.Repo{ID: 1, FullName: "acme/relay", Private: true})
	var pool model.Pool
	if err := e.st.Tx(func(tx *store.Tx) error {
		var err error
		pool, err = tx.AddPool(model.Pool{Name: "GitHub minutes", Kind: model.PoolGitHub, AccountID: 5, Repo: "acme/relay", Tier: 9, Max: 1, Enabled: true, Standard: "ubuntu-latest"})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.s.Remove(ctx, 5); err == nil || !strings.Contains(err.Error(), "GitHub minutes") {
		t.Fatalf("removed while a pool uses it: %v", err)
	}
	e.st.View(func(tx *store.Tx) error {
		if _, err := tx.RunnerAccount(5); err != nil {
			t.Errorf("account gone after the refusal: %v", err)
		}
		if _, err := e.box.Get(tx, keyName(5)); err != nil {
			t.Errorf("key gone after the refusal: %v", err)
		}
		return nil
	})

	if err := e.st.Tx(func(tx *store.Tx) error { return tx.DeletePool(pool.ID) }); err != nil {
		t.Fatal(err)
	}
	u, err := e.s.Remove(ctx, 5)
	if err != nil || u != "https://github.example/organizations/acme/settings/apps/ci-plane-runners-acme/advanced" {
		t.Fatalf("%s %v", u, err)
	}
	e.st.View(func(tx *store.Tx) error {
		if _, err := tx.RunnerAccount(5); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("account kept: %v", err)
		}
		if _, err := e.box.Get(tx, keyName(5)); !errors.Is(err, store.ErrNotFound) {
			t.Errorf("key kept: %v", err)
		}
		return nil
	})
	if got := e.runnerRepos(5); len(got) != 0 {
		t.Fatalf("repos kept: %+v", got)
	}
	if _, err := e.s.Remove(ctx, 5); err == nil || !strings.Contains(err.Error(), "already removed") {
		t.Fatalf("removed twice: %v", err)
	}
}
