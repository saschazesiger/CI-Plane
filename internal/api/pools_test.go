package api

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

type fakeRelay struct {
	hits  int
	check RelayCheck
	asked string
}

func (f *fakeRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.hits++
	io.WriteString(w, `{"jitconfig":"x"}`)
}
func (f *fakeRelay) Check(_ context.Context, _ int64, repo string) RelayCheck {
	f.asked = repo
	return f.check
}
func (f *fakeRelay) Workflow() string { return "name: CI-Plane relay\n" }

func TestRelayPathPassesTheTunnelWithoutAccess(t *testing.T) {
	r := newRig(t, false)
	relay := &fakeRelay{}
	r.srv.d.Relay = relay
	tun := r.srv.Tunnel(http.NotFoundHandler())
	// No Access token: only the relay path is let through, and only to the relay.
	if got := r.do(tun, "POST", "/webhook/relay", nil); got.code != 200 || relay.hits != 1 {
		t.Fatalf("relay path: %d %s, %d hits", got.code, got.raw, relay.hits)
	}
	for _, p := range []string{"/webhook/relay/", "/webhook/relayx", "/api/pools"} {
		if got := r.do(tun, "POST", p, nil); got.code == 200 || relay.hits != 1 {
			t.Errorf("%s: %d, %d hits", p, got.code, relay.hits)
		}
	}
	// Not on the local listener.
	r.signIn()
	if got := r.local_("POST", "/webhook/relay", nil); got.code == 200 || relay.hits != 1 {
		t.Errorf("local listener served the relay: %d", got.code)
	}
}

func TestPools(t *testing.T) {
	r := newRig(t, false)
	relay := &fakeRelay{check: RelayCheck{Problems: []string{"The relay workflow is not in acme/relay."}, AddURL: "https://github.com/acme/relay/new/main"}}
	r.srv.d.Relay = relay
	r.signIn()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(r.st.Tx(func(tx *store.Tx) error {
		if err := tx.SaveAccount(model.Account{ID: 1, Owner: "acme", OwnerType: "Organization", InstallationID: 5, Enabled: true}); err != nil {
			return err
		}
		if err := tx.UpsertRepo(model.Repo{ID: 7, AccountID: 1, FullName: "acme/relay", Private: true}); err != nil {
			return err
		}
		if err := tx.UpsertRepo(model.Repo{ID: 8, AccountID: 1, FullName: "acme/site", Private: false}); err != nil {
			return err
		}
		_, err := tx.AddWorker(model.Worker{Name: "alpha", Host: "alpha.test", Port: 22, User: "ci-plane", Tier: 1, Enabled: true})
		return err
	}))

	// What the page starts with: presets, the workflow, the repositories.
	list := r.expect(r.local_("GET", "/api/pools", nil), 200)
	if presets, _ := list.body["presets"].([]any); len(presets) != 3 || list.body["workflow"] == "" || len(list.body["repos"].([]any)) != 2 {
		t.Fatalf("list: %s", list.raw)
	}

	// Field errors say what to do.
	bad := r.expect(r.local_("POST", "/api/pools", map[string]any{"name": "alpha", "repo": "acme/site", "tier": 12, "max": 0, "standard": "not a label", "budgetMin": -1}), 400)
	fields := bad.body["fields"].(map[string]any)
	for k, want := range map[string]string{"name": "worker has this name", "repo": "public", "tier": "1 to 9", "max": "1 to 100", "standard": "runs-on label", "budgetMin": "minutes"} {
		if got, _ := fields[k].(string); !strings.Contains(got, want) {
			t.Errorf("%s: %q, want %q", k, got, want)
		}
	}
	bad = r.expect(r.local_("POST", "/api/pools", map[string]any{"name": "GitHub", "repo": "acme/other", "standard": "ci-plane", "large": "size-l"}), 400)
	if !strings.Contains(bad.raw, "does not see this repository") || strings.Count(bad.raw, "CI-Plane's own runners") < 2 {
		t.Fatalf("unknown repository, own labels: %s", bad.raw)
	}

	// Add one: the last tier and a waiting time unless said otherwise.
	added := r.expect(r.local_("POST", "/api/pools", map[string]any{"name": "GitHub", "kind": "github", "repo": "acme/relay", "standard": "ubuntu-latest"}), 200)
	pool := added.body["pool"].(map[string]any)
	if pool["tier"] != float64(9) || pool["afterSec"] != float64(180) || pool["max"] != float64(5) || pool["enabled"] != true {
		t.Fatalf("added: %s", added.raw)
	}
	bad = r.expect(r.local_("POST", "/api/pools", map[string]any{"name": "github", "repo": "acme/relay", "standard": "ubuntu-latest"}), 400)
	if !strings.Contains(bad.raw, "Another pool has this name") {
		t.Fatalf("same name: %s", bad.raw)
	}

	// The engine paused it and counted its time; a change keeps the time
	// and ends the pause.
	must(r.st.Tx(func(tx *store.Tx) error {
		p, err := tx.Pool(1)
		if err != nil {
			return err
		}
		p.Fails, p.PausedUntil, p.PauseReason, p.Month, p.UsedSec = 3, 1<<60, "no minutes left", "2026-11", 600
		return tx.SavePool(p)
	}))
	list = r.expect(r.local_("GET", "/api/pools", nil), 200)
	if v := list.body["pools"].([]any)[0].(map[string]any); v["paused"] != true || v["nextPauseSec"] != float64(3600) {
		t.Fatalf("paused view: %s", list.raw)
	}
	changed := r.expect(r.local_("PATCH", "/api/pools/1", map[string]any{"tier": 1, "afterSec": 0, "large": "ubuntu-latest-8-cores", "budgetMin": 2000}), 200)
	pool = changed.body["pool"].(map[string]any)
	if pool["tier"] != float64(1) || pool["large"] != "ubuntu-latest-8-cores" || pool["fails"] != float64(0) || pool["pausedUntil"] != float64(0) ||
		pool["usedSec"] != float64(600) || pool["name"] != "GitHub" {
		t.Fatalf("changed: %s", changed.raw)
	}

	// Try again now.
	must(r.st.Tx(func(tx *store.Tx) error {
		p, _ := tx.Pool(1)
		p.Fails, p.PausedUntil = 2, 1<<60
		return tx.SavePool(p)
	}))
	resumed := r.expect(r.local_("POST", "/api/pools/1/resume", nil), 200)
	if p := resumed.body["pool"].(map[string]any); p["fails"] != float64(0) || p["pausedUntil"] != float64(0) {
		t.Fatalf("resumed: %s", resumed.raw)
	}

	check := r.expect(r.local_("POST", "/api/pools/1/check", nil), 200)
	if relay.asked != "acme/relay" || !strings.Contains(check.raw, "not in acme/relay") || check.body["addUrl"] == "" {
		t.Fatalf("check: %s", check.raw)
	}

	// A pool with runners on it stays; then it goes.
	must(r.st.Tx(func(tx *store.Tx) error {
		return tx.SaveRunner(model.Runner{ID: "r1", Name: "ci-plane-x-github-r1", WorkerID: -1, AccountID: 1, State: model.RunnerBusy, StartedAt: 1})
	}))
	if got := r.expect(r.local_("DELETE", "/api/pools/1", nil), 409); !strings.Contains(got.raw, "1 runner is on this pool") {
		t.Fatalf("delete with runners: %s", got.raw)
	}
	// A job on it names the pool as its worker.
	must(r.st.Tx(func(tx *store.Tx) error {
		return tx.SaveJob(model.Job{ID: 50, AccountID: 1, RepoID: 7, Repo: "acme/relay", State: model.JobRunning, RunnerID: "r1", Size: "standard"})
	}))
	if job := r.expect(r.local_("GET", "/api/jobs/50", nil), 200); !strings.Contains(job.raw, `"worker":"GitHub"`) || !strings.Contains(job.raw, `"workerId":-1`) {
		t.Fatalf("job: %s", job.raw)
	}
	must(r.st.Tx(func(tx *store.Tx) error {
		x, _ := tx.Runner("r1")
		x.State = model.RunnerRemoved
		return tx.SaveRunner(x)
	}))
	r.expect(r.local_("DELETE", "/api/pools/1", nil), 200)
	r.expect(r.local_("PATCH", "/api/pools/1", map[string]any{"tier": 2}), 404)
}

func TestRunnerAccountsAndTheirPools(t *testing.T) {
	r := newRig(t, false)
	r.srv.d.Relay = &fakeRelay{}
	r.signIn()
	if err := r.st.Tx(func(tx *store.Tx) error {
		// The integration sees acme/site; the runner app of acme sees acme/relay.
		if err := tx.SaveAccount(model.Account{ID: 1, Slug: "ci-plane-acme", Owner: "acme", OwnerType: "Organization", InstallationID: 5, Enabled: true}); err != nil {
			return err
		}
		if err := tx.UpsertRepo(model.Repo{ID: 8, AccountID: 1, FullName: "acme/site", Private: true}); err != nil {
			return err
		}
		if err := tx.SaveRunnerAccount(model.Account{ID: 2, Slug: "ci-plane-runners-acme", Owner: "acme", OwnerType: "Organization", InstallationID: 6}); err != nil {
			return err
		}
		return tx.SetRunnerRepos(2, []model.Repo{{ID: 7, FullName: "acme/relay", Private: true}})
	}); err != nil {
		t.Fatal(err)
	}

	// A repository the runner app does not see: the integration does, but
	// the pool would be started by the runner app.
	bad := r.expect(r.local_("POST", "/api/pools", map[string]any{"name": "Minutes", "kind": "github", "accountId": 2, "repo": "acme/site", "standard": "ubuntu-latest"}), 400)
	if got, _ := bad.body["fields"].(map[string]any)["repo"].(string); !strings.Contains(got, "The app of acme does not see this repository") {
		t.Fatalf("repo the app does not see: %s", bad.raw)
	}
	bad = r.expect(r.local_("POST", "/api/pools", map[string]any{"name": "Minutes", "kind": "github", "accountId": 2, "repo": "acme/unknown", "standard": "ubuntu-latest"}), 400)
	if _, ok := bad.body["fields"].(map[string]any)["repo"]; !ok {
		t.Fatalf("unknown repository: %s", bad.raw)
	}
	added := r.expect(r.local_("POST", "/api/pools", map[string]any{"name": "Minutes", "kind": "github", "accountId": 2, "repo": "acme/relay", "standard": "ubuntu-latest"}), 200)
	if p := added.body["pool"].(map[string]any); p["accountId"] != float64(2) || p["repo"] != "acme/relay" {
		t.Fatalf("added: %s", added.raw)
	}

	// The runner account with its repositories and the pools it starts;
	// the integration account is not among them.
	list := r.expect(r.local_("GET", "/api/runner-accounts", nil), 200)
	accs := list.body["accounts"].([]any)
	if len(accs) != 1 {
		t.Fatalf("runner accounts: %s", list.raw)
	}
	a := accs[0].(map[string]any)
	repos, _ := a["repos"].([]any)
	pools, _ := a["pools"].([]any)
	if a["id"] != float64(2) || a["runners"] != true || a["installUrl"] != "https://github.com/apps/ci-plane-runners-acme/installations/new" ||
		len(repos) != 1 || repos[0].(map[string]any)["fullName"] != "acme/relay" || repos[0].(map[string]any)["accountId"] != float64(2) ||
		len(pools) != 1 || pools[0] != "Minutes" {
		t.Fatalf("runner account: %s", list.raw)
	}
	// The pools page offers the repositories of both, each with its app.
	pl := r.expect(r.local_("GET", "/api/pools", nil), 200)
	if rs := pl.body["repos"].([]any); len(rs) != 2 || rs[0].(map[string]any)["runners"] != true || rs[1].(map[string]any)["accountId"] != float64(1) {
		t.Fatalf("pool repos: %s", pl.raw)
	}

	// The runner-accounts routes are not a way to remove an account of the integration.
	r.expect(r.local_("DELETE", "/api/runner-accounts/1", nil), 404)
	r.expect(r.local_("POST", "/api/runner-accounts/1/sync", nil), 404)
	if err := r.st.View(func(tx *store.Tx) error { _, err := tx.Account(1); return err }); err != nil {
		t.Fatalf("integration account after DELETE on runner-accounts: %v", err)
	}
	r.expect(r.local_("DELETE", "/api/runner-accounts/99", nil), 404)
}
