package main

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/saschazesiger/Z-Dash/server"
	zsecret "github.com/saschazesiger/Z-Dash/server/secret"

	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// A tunnel set up before CI-Plane ran on the Z-Dash server carries over:
// the server reads its state and both tokens, nothing is set up anew, and a
// second start changes nothing.
func TestMigrateTunnel(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	old, err := secret.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	before := map[string]any{
		"accountId": "acct1", "zoneId": "zone1", "zone": "example.com", "hostname": "ci.example.com",
		"emails": []string{"ada@example.com"}, "teamDomain": "team.cloudflareaccess.com", "tunnelId": "tun1",
		"recordId": "rec1", "recordZoneId": "zone1", "allowPolicyId": "pol1", "bypassPolicyId": "pol2",
		"appId": "app1", "appAud": "aud1", "webhookAppId": "app2", "ready": true,
	}
	raw, _ := json.Marshal(before)
	if err := st.Tx(func(tx *store.Tx) error {
		if err := tx.Set("cloudflare", raw); err != nil {
			return err
		}
		if err := old.Put(tx, "cloudflare-api-token", []byte("api-token-123")); err != nil {
			return err
		}
		return old.Put(tx, "cloudflare-tunnel-token", []byte("tunnel-token-456"))
	}); err != nil {
		t.Fatal(err)
	}

	sealer, err := zsecret.Load(dir, "")
	if err != nil {
		t.Fatal(err)
	}
	moved, err := migrateTunnel(st, old, sealer, "http://127.0.0.1:8081")
	if err != nil || !moved {
		t.Fatalf("moved = %v, %v", moved, err)
	}
	if again, err := migrateTunnel(st, old, sealer, "http://127.0.0.1:8081"); err != nil || again {
		t.Fatalf("a second run moved again: %v, %v", again, err)
	}
	_ = st.View(func(tx *store.Tx) error {
		for _, k := range []string{"cloudflare", "secret:cloudflare-api-token", "secret:cloudflare-tunnel-token"} {
			if _, err := tx.Get(k); err == nil {
				t.Errorf("the old key %s is still there", k)
			}
		}
		return nil
	})

	app, err := server.New(server.Config{Name: "CI-Plane", Slug: "ci-plane", DataDir: dir, TunnelListen: "127.0.0.1:8081",
		KV: store.ServerKV{St: st}, Sealer: sealer, Bypass: map[string]http.Handler{"/webhook": http.NotFoundHandler()},
		Logf: t.Logf})
	if err != nil {
		t.Fatal(err)
	}
	s := app.Tunnel().Status()
	if !s.Configured || s.Hostname != "ci.example.com" || !s.HasToken || s.Partial || s.Error != "" ||
		len(s.Emails) != 1 || s.Emails[0] != "ada@example.com" {
		t.Fatalf("status after the move = %+v", s)
	}
	if app.Tunnel().PublicURL() != "https://ci.example.com" {
		t.Errorf("public URL = %q", app.Tunnel().PublicURL())
	}
	var state map[string]any
	_ = st.View(func(tx *store.Tx) error {
		b, err := tx.Get("cloudflare:state")
		if err == nil {
			err = json.Unmarshal(b, &state)
		}
		return err
	})
	if state["bypass_app_id"] != "app2" || state["origin"] != "http://127.0.0.1:8081" || state["app_aud"] != "aud1" {
		t.Errorf("state = %v", state)
	}
}
