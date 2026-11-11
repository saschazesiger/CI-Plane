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
	hits     int
	problems []string
}

func (f *fakeRelay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.hits++
	io.WriteString(w, `{"jitconfig":"x"}`)
}
func (f *fakeRelay) Check(context.Context) []string { return f.problems }
func (f *fakeRelay) Workflow() string               { return "name: CI-Plane relay\n" }

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

func TestRelaySettings(t *testing.T) {
	r := newRig(t, false)
	relay := &fakeRelay{problems: []string{"The relay workflow is not in acme/relay."}}
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
		return tx.UpsertRepo(model.Repo{ID: 8, AccountID: 1, FullName: "acme/site", Private: false})
	}))

	set := model.DefaultSettings()
	set.RelayEnabled = true
	got := r.expect(r.local_("PUT", "/api/settings", set), 400)
	if !strings.Contains(got.raw, "relayRepo") {
		t.Fatalf("on without a repository: %s", got.raw)
	}
	for repo, want := range map[string]string{"acme/site": "public", "acme/other": "does not see", "not a repo": "owner/name"} {
		set.RelayRepo = repo
		got = r.expect(r.local_("POST", "/api/settings/validate", set), 200)
		if !strings.Contains(got.raw, want) {
			t.Errorf("%s: %s, want %q", repo, got.raw, want)
		}
	}
	set.RelayRepo, set.RelayMaxSize = "acme/relay", "size-q"
	if got = r.expect(r.local_("PUT", "/api/settings", set), 400); !strings.Contains(got.raw, "relayMaxSize") {
		t.Fatalf("unknown size: %s", got.raw)
	}

	// It switched itself off; switching it on again clears that.
	must(r.st.Tx(func(tx *store.Tx) error {
		return tx.SetJSON(model.RelayOffKey, model.RelayOff{At: 1, Reason: "minutes used up"})
	}))
	state := r.expect(r.local_("GET", "/api/relay", nil), 200)
	if off, _ := state.body["off"].(map[string]any); off["reason"] != "minutes used up" || state.body["workflow"] == "" {
		t.Fatalf("state: %s", state.raw)
	}
	set.RelayMaxSize = "size-m"
	r.expect(r.local_("PUT", "/api/settings", set), 200)
	if state = r.expect(r.local_("GET", "/api/relay", nil), 200); state.body["off"] != nil {
		t.Fatalf("still off after switching on: %s", state.raw)
	}
	repos, _ := state.body["repos"].([]any)
	if len(repos) != 2 {
		t.Fatalf("repos: %v", repos)
	}

	check := r.expect(r.local_("POST", "/api/relay/check", nil), 200)
	if !strings.Contains(check.raw, "not in acme/relay") {
		t.Fatalf("check: %s", check.raw)
	}
}

func TestRelayRepositoryStaysWhileRunnersUseIt(t *testing.T) {
	r := newRig(t, false)
	r.signIn()
	if err := r.st.Tx(func(tx *store.Tx) error {
		if err := tx.SaveAccount(model.Account{ID: 1, Owner: "acme", OwnerType: "Organization", InstallationID: 5, Enabled: true}); err != nil {
			return err
		}
		for _, p := range []model.Repo{{ID: 7, AccountID: 1, FullName: "acme/relay", Private: true}, {ID: 9, AccountID: 1, FullName: "acme/relay2", Private: true}} {
			if err := tx.UpsertRepo(p); err != nil {
				return err
			}
		}
		set := model.DefaultSettings()
		set.RelayEnabled, set.RelayRepo = true, "acme/relay"
		if err := tx.SaveSettings(set); err != nil {
			return err
		}
		return tx.SaveRunner(model.Runner{ID: "r1", Name: "ci-plane-x-github-hosted-r1", WorkerID: model.RelayWorkerID, AccountID: 1, State: model.RunnerBusy})
	}); err != nil {
		t.Fatal(err)
	}
	set := model.DefaultSettings()
	set.RelayEnabled, set.RelayRepo = true, "acme/relay2"
	if got := r.expect(r.local_("PUT", "/api/settings", set), 400); !strings.Contains(got.raw, "1 runners run through acme/relay") {
		t.Fatalf("changed under a running runner: %s", got.raw)
	}
	set.RelayRepo, set.RelayAfterSec = "acme/relay", 60
	r.expect(r.local_("PUT", "/api/settings", set), 200)
}
