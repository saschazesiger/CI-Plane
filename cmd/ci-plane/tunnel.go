package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/saschazesiger/Z-Dash/server"

	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// migrateTunnel moves a tunnel that CI-Plane set up before it ran on the
// Z-Dash server into the server's format, once, so the running tunnel, its
// Access applications and its token carry over without a new setup.
//
// Before, the state was JSON under "cloudflare" (camelCase) and the two
// tokens were sealed by CI-Plane's box under "secret:cloudflare-api-token"
// and "secret:cloudflare-tunnel-token". The server keeps the state under
// "cloudflare:state" (snake_case) and seals its secrets bound to their key,
// hex-encoded, under "cloudflare:api_token" and "cloudflare:tunnel_token".
// The old keys are deleted once the new ones are written; a run that stops
// in between starts over on the next start.
func migrateTunnel(st *store.Store, old *secret.Box, sealer server.Sealer, origin string) (bool, error) {
	var raw []byte
	var have bool
	err := st.View(func(tx *store.Tx) error {
		if _, err := tx.Get("cloudflare:state"); err == nil {
			have = true
			return nil
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		var err error
		raw, err = tx.Get("cloudflare")
		if errors.Is(err, store.ErrNotFound) {
			return nil
		}
		return err
	})
	if err != nil || have || raw == nil {
		return false, err
	}
	var before struct {
		AccountID      string   `json:"accountId"`
		ZoneID         string   `json:"zoneId"`
		Zone           string   `json:"zone"`
		Hostname       string   `json:"hostname"`
		Emails         []string `json:"emails"`
		TeamDomain     string   `json:"teamDomain"`
		TunnelID       string   `json:"tunnelId"`
		RecordID       string   `json:"recordId"`
		RecordZoneID   string   `json:"recordZoneId"`
		AllowPolicyID  string   `json:"allowPolicyId"`
		BypassPolicyID string   `json:"bypassPolicyId"`
		AppID          string   `json:"appId"`
		AppAUD         string   `json:"appAud"`
		WebhookAppID   string   `json:"webhookAppId"`
		Ready          bool     `json:"ready"`
	}
	if err := json.Unmarshal(raw, &before); err != nil {
		return false, fmt.Errorf("the stored tunnel settings are damaged: %w", err)
	}
	// The server's state; Origin is what the routing pointed at, so the
	// server does not route the tunnel anew.
	after := map[string]any{
		"account_id": before.AccountID, "account_name": "", "zone_id": before.ZoneID, "zone": before.Zone,
		"hostname": before.Hostname, "emails": before.Emails, "team_domain": before.TeamDomain,
		"tunnel_id": before.TunnelID, "origin": origin, "record_id": before.RecordID,
		"record_zone_id": before.RecordZoneID, "allow_policy_id": before.AllowPolicyID,
		"bypass_policy_id": before.BypassPolicyID, "app_id": before.AppID, "app_aud": before.AppAUD,
		"bypass_app_id": before.WebhookAppID, "ready": before.Ready,
	}
	state, err := json.Marshal(after)
	if err != nil {
		return false, err
	}
	err = st.Tx(func(tx *store.Tx) error {
		for oldName, newKey := range map[string]string{
			"cloudflare-api-token":    "cloudflare:api_token",
			"cloudflare-tunnel-token": "cloudflare:tunnel_token",
		} {
			plain, err := old.Get(tx, oldName)
			if errors.Is(err, store.ErrNotFound) {
				continue
			}
			if err != nil {
				return fmt.Errorf("the stored %s cannot be read: %w", oldName, err)
			}
			sealed, err := sealer.Seal(newKey, plain)
			if err != nil {
				return err
			}
			if err := tx.Set(newKey, []byte(hex.EncodeToString(sealed))); err != nil {
				return err
			}
			if err := old.Drop(tx, oldName); err != nil {
				return err
			}
		}
		if err := tx.Set("cloudflare:state", state); err != nil {
			return err
		}
		return tx.Delete("cloudflare")
	})
	return err == nil, err
}
