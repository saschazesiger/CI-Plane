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
	asked int64
}

func (f *fakeRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.hits++
	io.WriteString(w, `{"jitconfig":"x"}`)
}
func (f *fakeRelay) Check(_ context.Context, repo int64) RelayCheck { f.asked = repo; return f.check }
func (f *fakeRelay) Workflow() string                               { return "name: CI-Plane relay\n" }

func TestRelayPathPassesTheTunnelWithoutAccess(t *testing.T) {
	r := newRig(t, false)
	relay := &fakeRelay{}
	r.srv.d.Relay = relay
	tun := r.srv.Tunnel(http.NotFoundHandler())
	// No Access token: only the relay path is let through, and only to the relay.
	if got := r.do(tun, "POST", "/webhook/relay", nil); got.code != 200 || relay.hits != 1 {
		t.Fatalf("relay path: %d %s, %d hits", got.code, got.raw, relay.hits)
	}
	for _, p := range []string{"/webhook/relay/", "/webhook/relayx", "/api/relay"} {
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

func TestRelayPerRepository(t *testing.T) {
	r := newRig(t, false)
	relay := &fakeRelay{check: RelayCheck{Problems: []string{"The relay workflow is not in acme/site."}, AddURL: "https://github.com/acme/site/new/main"}}
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
		if err := tx.UpsertRepo(model.Repo{ID: 7, AccountID: 1, FullName: "acme/site", Private: true, Enabled: true}); err != nil {
			return err
		}
		// It switched itself off earlier.
		p, err := tx.Repo(7)
		if err != nil {
			return err
		}
		p.RelayOff, p.RelayOffAt = "minutes used up", 1
		return tx.SaveRepo(p)
	}))

	set := model.DefaultSettings()
	set.RelayEnabled, set.RelayMaxSize = true, "size-q"
	if got := r.expect(r.local_("PUT", "/api/settings", set), 400); !strings.Contains(got.raw, "relayMaxSize") {
		t.Fatalf("unknown size: %s", got.raw)
	}
	set.RelayMaxSize = "size-m"
	r.expect(r.local_("PUT", "/api/settings", set), 200)

	state := r.expect(r.local_("GET", "/api/relay", nil), 200)
	if repos, _ := state.body["repos"].([]any); len(repos) != 1 || state.body["workflow"] == "" {
		t.Fatalf("state: %s", state.raw)
	}

	// Switching it on for the repository clears why it went off.
	got := r.expect(r.local_("PATCH", "/api/repos/7", map[string]any{"relay": true}), 200)
	if repo, _ := got.body["repo"].(map[string]any); repo["relay"] != true || repo["relayOff"] != "" {
		t.Fatalf("repo: %s", got.raw)
	}
	// Other changes leave it on.
	got = r.expect(r.local_("PATCH", "/api/repos/7", map[string]any{"maxParallel": 2}), 200)
	if repo, _ := got.body["repo"].(map[string]any); repo["relay"] != true {
		t.Fatalf("repo after another change: %s", got.raw)
	}

	check := r.expect(r.local_("POST", "/api/relay/check", map[string]any{"repo": 7}), 200)
	if relay.asked != 7 || !strings.Contains(check.raw, "not in acme/site") || check.body["addUrl"] == "" {
		t.Fatalf("check: %s", check.raw)
	}
	r.expect(r.local_("POST", "/api/relay/check", map[string]any{"repo": 99}), 404)
}
