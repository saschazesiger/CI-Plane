package cloudflare

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/saschazesiger/CI-Plane/internal/store"
)

func TestSetupFull(t *testing.T) {
	h := newHarness(t, true)
	var steps []string
	if err := h.svc.Setup(context.Background(), setupReq(), func(s string) { steps = append(steps, s) }); err != nil {
		t.Fatal(err)
	}
	if len(steps) != 8 {
		t.Errorf("progress steps = %q", steps)
	}
	st := h.svc.Status()
	if !st.Configured || !st.Running || !st.Connected || !st.Verified || st.Error != "" || !st.HasToken {
		t.Errorf("status = %+v", st)
	}
	if st.Hostname != testHost || st.PublicURL != "https://"+testHost || strings.Join(st.Emails, ",") != "alice@example.com,bob@example.com" {
		t.Errorf("status = %+v", st)
	}

	cf := h.cf
	cf.mu.Lock()
	defer cf.mu.Unlock()
	if len(cf.tunnels) != 1 || len(cf.records) != 1 || len(cf.policies) != 2 || len(cf.apps) != 2 || len(cf.idps) != 1 {
		t.Fatalf("objects: %d tunnels, %d records, %d policies, %d apps, %d idps", len(cf.tunnels), len(cf.records), len(cf.policies), len(cf.apps), len(cf.idps))
	}
	if cf.idps[0].Type != "onetimepin" {
		t.Errorf("idp = %+v", cf.idps[0])
	}
	var tun tunnelObj
	for _, x := range cf.tunnels {
		tun = *x
	}
	if tun.Name != "ci-plane-"+testHost || tun.ConfigSrc != "cloudflare" {
		t.Errorf("tunnel = %+v", tun)
	}
	ing := cf.ingress[tun.ID]
	if len(ing) != 2 || ing[0].Hostname != testHost || ing[0].Service != testOrigin || ing[1].Service != "http_status:404" || ing[1].Hostname != "" {
		t.Errorf("ingress = %+v", ing)
	}
	for _, r := range cf.records {
		if r.Type != "CNAME" || r.Name != testHost || r.Content != tun.ID+".cfargotunnel.com" || !r.Proxied || r.TTL != 1 {
			t.Errorf("record = %+v", r)
		}
	}
	byDomain := map[string]appObj{}
	for _, a := range cf.apps {
		byDomain[a.Domain] = *a
	}
	main, hook := byDomain[testHost], byDomain[testHost+"/webhook"]
	if main.Type != "self_hosted" || hook.Type != "self_hosted" || main.SessionDuration != "24h" {
		t.Errorf("apps = %+v", byDomain)
	}
	pol := func(a appObj) policyObj {
		b, _ := json.Marshal(a.Policies)
		var refs []policyRef
		json.Unmarshal(b, &refs)
		if len(refs) != 1 {
			t.Fatalf("app %s has policies %s", a.Domain, b)
		}
		return *cf.policies[refs[0].ID]
	}
	allow, bypass := pol(main), pol(hook)
	b, _ := json.Marshal(allow.Include)
	if allow.Decision != "allow" || string(b) != `[{"email":{"email":"alice@example.com"}},{"email":{"email":"bob@example.com"}}]` {
		t.Errorf("allow policy = %+v %s", allow, b)
	}
	b, _ = json.Marshal(bypass.Include)
	if bypass.Decision != "bypass" || string(b) != `[{"everyone":{}}]` {
		t.Errorf("bypass policy = %+v %s", bypass, b)
	}

	// Secrets are encrypted in the store, the token reached cloudflared
	// only through the environment, our own secret key not at all.
	h.st.View(func(tx *store.Tx) error {
		raw, _ := tx.Get("secret:" + secretAPIToken)
		if len(raw) == 0 || strings.Contains(string(raw), testToken) {
			t.Error("API token not stored encrypted")
		}
		return nil
	})
	log, _ := os.ReadFile(h.cfdLog)
	if !strings.Contains(string(log), `args=["tunnel" "--no-autoupdate" "--metrics"`) || !strings.Contains(string(log), "token=true secretkey=false") {
		t.Errorf("cloudflared log: %s", log)
	}
	if strings.Contains(string(log), "tunnel-token-") || strings.Contains(h.logs.String(), "tunnel-token-") {
		t.Error("tunnel token leaked into arguments or logs")
	}
}

func TestSetupAgainChangesNothing(t *testing.T) {
	h := newHarness(t, true)
	ctx := context.Background()
	if err := h.svc.Setup(ctx, setupReq(), nil); err != nil {
		t.Fatal(err)
	}
	h.cf.mu.Lock()
	before := fmt.Sprint(h.cf.creates)
	n := len(h.cf.log)
	h.cf.mu.Unlock()
	if err := h.svc.Setup(ctx, setupReq(), nil); err != nil {
		t.Fatal(err)
	}
	h.cf.mu.Lock()
	after := fmt.Sprint(h.cf.creates)
	for _, c := range h.cf.log[n:] {
		if strings.HasPrefix(c, "POST") || strings.HasPrefix(c, "DELETE") || strings.Contains(c, "dns_records/") {
			t.Errorf("second Setup sent %s", c)
		}
	}
	h.cf.mu.Unlock()
	if before != after {
		t.Errorf("creates %s, then %s", before, after)
	}
	if !h.svc.Status().Verified {
		t.Error("not verified after second setup")
	}

	// A new hostname reuses tunnel, policies and applications and replaces
	// the DNS record.
	req := setupReq()
	req.Hostname = "build.example.com"
	if err := h.svc.Setup(ctx, req, nil); err != nil {
		t.Fatal(err)
	}
	tun, rec, pol, apps := h.counts()
	if tun != 1 || rec != 1 || pol != 2 || apps != 2 {
		t.Errorf("after new hostname: %d tunnels, %d records, %d policies, %d apps", tun, rec, pol, apps)
	}
	h.cf.mu.Lock()
	for _, r := range h.cf.records {
		if r.Name != "build.example.com" {
			t.Errorf("record = %+v", r)
		}
	}
	for _, a := range h.cf.apps {
		if !strings.HasPrefix(a.Domain, "build.example.com") {
			t.Errorf("app = %+v", a)
		}
	}
	h.cf.mu.Unlock()
}

// TestSetupResume fails each API call of a Setup once, both before and
// after Cloudflare carried it out, and checks that running Setup again ends
// with exactly one of everything.
func TestSetupResume(t *testing.T) {
	probe := newHarness(t, true)
	if err := probe.svc.Setup(context.Background(), setupReq(), nil); err != nil {
		t.Fatal(err)
	}
	total := probe.cf.calls
	probe.stopRun()
	for _, lose := range []bool{false, true} {
		for n := 1; n <= total; n++ {
			t.Run(fmt.Sprintf("lose=%v/call=%d", lose, n), func(t *testing.T) {
				h := newHarness(t, true)
				h.cf.failAt, h.cf.lose = n, lose
				if err := h.svc.Setup(context.Background(), setupReq(), nil); err == nil {
					t.Fatalf("Setup passed although call %d failed", n)
				} else if h.svc.Status().Error == "" {
					t.Error("Status shows no error after a failed Setup")
				}
				h.cf.mu.Lock()
				h.cf.failAt = 0
				h.cf.mu.Unlock()
				// A restart in between: a new service reads what was stored.
				h.stopRun()
				h.svc = h.newService()
				h.startRun()
				if err := h.svc.Setup(context.Background(), setupReq(), nil); err != nil {
					t.Fatal(err)
				}
				tun, rec, pol, apps := h.counts()
				if tun != 1 || rec != 1 || pol != 2 || apps != 2 || len(h.cf.idps) != 1 {
					t.Errorf("%d tunnels, %d records, %d policies, %d apps, %d idps", tun, rec, pol, apps, len(h.cf.idps))
				}
				if st := h.svc.Status(); !st.Verified || st.Error != "" {
					t.Errorf("status = %+v", st)
				}
			})
		}
	}
}

func TestSetupWithoutZeroTrust(t *testing.T) {
	h := newHarness(t, false)
	h.cf.noOrg = true
	err := h.svc.Setup(context.Background(), setupReq(), nil)
	if err == nil || !strings.Contains(err.Error(), "Zero Trust is not enabled") || !strings.Contains(err.Error(), "Free plan") ||
		!strings.Contains(err.Error(), "run the setup again") {
		t.Fatalf("err = %v", err)
	}
	if tun, _, _, _ := h.counts(); tun != 0 {
		t.Error("a tunnel was created without Zero Trust")
	}
	if !strings.Contains(h.svc.Status().Error, "Zero Trust") {
		t.Errorf("status = %+v", h.svc.Status())
	}
}

func TestSetupDNSConflict(t *testing.T) {
	h := newHarness(t, false)
	h.cf.records["rec-x"] = &recordObj{ID: "rec-x", Type: "A", Name: testHost, Content: "192.0.2.1", TTL: 1}
	err := h.svc.Setup(context.Background(), setupReq(), nil)
	if err == nil || !strings.Contains(err.Error(), "already exists") || !strings.Contains(err.Error(), "192.0.2.1") {
		t.Fatalf("err = %v", err)
	}
	if r := h.cf.records["rec-x"]; r.Type != "A" || r.Content != "192.0.2.1" || len(h.cf.records) != 1 {
		t.Errorf("foreign record touched: %+v", h.cf.records)
	}
}

func TestSetupVerifyFails(t *testing.T) {
	h := newHarness(t, true)
	h.edge.webhookOK = false
	err := h.svc.Setup(context.Background(), setupReq(), nil)
	if err == nil || !strings.Contains(err.Error(), "/webhook asks for a login") {
		t.Fatalf("err = %v", err)
	}
	h.edge.mu.Lock()
	h.edge.webhookOK, h.edge.loginOK = true, false
	h.edge.mu.Unlock()
	err = h.svc.Setup(context.Background(), setupReq(), nil)
	if err == nil || !strings.Contains(err.Error(), "without asking for a login") {
		t.Fatalf("err = %v", err)
	}
	if st := h.svc.Status(); st.Verified || st.Error == "" {
		t.Errorf("status = %+v", st)
	}
}

func TestSetEmails(t *testing.T) {
	h := newHarness(t, true)
	if err := h.svc.Setup(context.Background(), setupReq(), nil); err != nil {
		t.Fatal(err)
	}
	if err := h.svc.SetEmails(context.Background(), []string{"not an address"}); err == nil {
		t.Error("bad address accepted")
	}
	if err := h.svc.SetEmails(context.Background(), []string{" Carol@Example.org "}); err != nil {
		t.Fatal(err)
	}
	if got := h.svc.Status().Emails; len(got) != 1 || got[0] != "carol@example.org" {
		t.Errorf("emails = %q", got)
	}
	h.cf.mu.Lock()
	defer h.cf.mu.Unlock()
	pol := h.cf.policies[h.cur().AllowPolicyID]
	b, _ := json.Marshal(pol.Include)
	if string(b) != `[{"email":{"email":"carol@example.org"}}]` {
		t.Errorf("include = %s", b)
	}
	if len(h.cf.policies) != 2 {
		t.Errorf("%d policies", len(h.cf.policies))
	}
}

func TestRemovePartlyGone(t *testing.T) {
	h := newHarness(t, true)
	if err := h.svc.Setup(context.Background(), setupReq(), nil); err != nil {
		t.Fatal(err)
	}
	// Someone already deleted the main application and the DNS record.
	h.cf.mu.Lock()
	delete(h.cf.apps, h.cur().AppID)
	delete(h.cf.records, h.cur().RecordID)
	h.cf.mu.Unlock()
	if err := h.svc.Remove(context.Background()); err != nil {
		t.Fatal(err)
	}
	tun, rec, pol, apps := h.counts()
	if tun+rec+pol+apps != 0 {
		t.Errorf("left: %d tunnels, %d records, %d policies, %d apps", tun, rec, pol, apps)
	}
	st := h.svc.Status()
	if st.Configured || st.Running || st.HasToken || st.Hostname != "" {
		t.Errorf("status = %+v", st)
	}
	h.st.View(func(tx *store.Tx) error {
		for _, k := range []string{stateKey, "secret:" + secretAPIToken, "secret:" + secretTunnelTok} {
			if _, err := tx.Get(k); err != store.ErrNotFound {
				t.Errorf("%s still stored", k)
			}
		}
		return nil
	})
	// Removing again is harmless.
	if err := h.svc.Remove(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestZones(t *testing.T) {
	h := newHarness(t, false)
	zs, err := h.svc.Zones(context.Background(), testToken)
	if err != nil || len(zs) != 1 || zs[0].Name != "example.com" || zs[0].AccountID != testAcct || zs[0].AccountName != "Acme" {
		t.Fatalf("zones = %+v, %v", zs, err)
	}
	if _, err := h.svc.Zones(context.Background(), "wrong"); err == nil || !strings.Contains(err.Error(), "does not accept this API token") {
		t.Fatalf("err = %v", err)
	}
}

func TestTokenURL(t *testing.T) {
	u, err := url.Parse((&Service{}).TokenURL())
	if err != nil || u.Host != "dash.cloudflare.com" || u.Path != "/profile/api-tokens" {
		t.Fatalf("url = %v", u)
	}
	var keys []struct{ Key, Type string }
	if err := json.Unmarshal([]byte(u.Query().Get("permissionGroupKeys")), &keys); err != nil || len(keys) != 5 {
		t.Fatalf("keys = %+v, %v", keys, err)
	}
	if u.Query().Get("accountId") != "*" || u.Query().Get("zoneId") != "all" {
		t.Errorf("url = %v", u)
	}
	if len(Permissions()) != 5 {
		t.Error("permissions")
	}
}

func (h *harness) cur() state {
	h.svc.mu.Lock()
	defer h.svc.mu.Unlock()
	return h.svc.cur
}
