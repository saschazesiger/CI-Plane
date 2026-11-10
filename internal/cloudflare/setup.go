package cloudflare

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// sessionDuration is how long an Access login lasts.
const sessionDuration = "24h"

// errZeroTrust is shown when the account has no Zero Trust organisation.
var errZeroTrust = errors.New("Cloudflare Zero Trust is not enabled on this Cloudflare account yet, and CI-Plane needs it " +
	"for the login (Cloudflare Access). Open https://one.dash.cloudflare.com/ once, pick this account, choose a team " +
	"name and the Free plan (no payment details are needed for it), then come back and press \"Try again\"")

func normHost(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	h = strings.TrimPrefix(strings.TrimPrefix(h, "https://"), "http://")
	if i := strings.IndexAny(h, "/?#"); i >= 0 {
		h = h[:i]
	}
	return strings.TrimSuffix(h, ".")
}

// normEmails checks the addresses and drops duplicates.
func normEmails(in []string) ([]string, error) {
	seen := map[string]bool{}
	var out []string
	for _, e := range in {
		e = strings.ToLower(strings.TrimSpace(e))
		if e == "" || seen[e] {
			continue
		}
		a, err := mail.ParseAddress(e)
		if err != nil || a.Address != e || !strings.Contains(e[strings.IndexByte(e, '@')+1:], ".") {
			return nil, fmt.Errorf("%q is not an e-mail address. Enter one address per entry, like name@example.com", e)
		}
		seen[e] = true
		out = append(out, e)
	}
	if len(out) == 0 {
		return nil, errors.New("enter at least one e-mail address that may sign in")
	}
	return out, nil
}

func tunnelName(host string) string { return "ci-plane-" + host }

// Setup creates or repairs tunnel, DNS record, routing and the Access
// applications, starts cloudflared and checks from outside. Every step finds
// what an earlier run made, so running it again repairs or updates.
func (s *Service) Setup(ctx context.Context, req api.TunnelSetup, progress func(step string)) (err error) {
	s.op.Lock()
	defer s.op.Unlock()
	if progress == nil {
		progress = func(string) {}
	}
	s.mu.Lock()
	s.setupErr, s.verified, s.verifyErr = "", false, ""
	s.mu.Unlock()
	defer func() {
		if err != nil {
			s.mu.Lock()
			s.setupErr = err.Error()
			s.mu.Unlock()
		}
	}()

	token := strings.TrimSpace(req.APIToken)
	if token == "" {
		// The interface may leave the field empty to reuse the stored token.
		if token, err = s.secret(secretAPIToken); err != nil {
			return errors.New("paste the Cloudflare API token")
		}
	}
	host := normHost(req.Hostname)
	emails, err := normEmails(req.Emails)
	if err != nil {
		return err
	}
	if req.ZoneID == "" || host == "" {
		return errors.New("choose a domain and enter a subdomain")
	}

	s.mu.Lock()
	cur := s.cur
	s.mu.Unlock()

	progress("Checking the API token and the domain")
	var zone zoneObj
	if err := s.call(ctx, token, http.MethodGet, "/zones/"+url.PathEscape(req.ZoneID), nil, nil, &zone); err != nil {
		if isDenied(err) || isNotFound(err) {
			return fmt.Errorf("the API token cannot read the chosen domain. It needs %q for that domain. Details: %w", permZone, err)
		}
		return err
	}
	if host != zone.Name && !strings.HasSuffix(host, "."+zone.Name) {
		return fmt.Errorf("%s is not part of the domain %s. Enter a name like ci.%s", host, zone.Name, zone.Name)
	}
	if cur.AccountID != "" && cur.AccountID != zone.Account.ID {
		// Another account: the stored IDs mean nothing there.
		s.logf("cloudflare: the domain is in another account than before; objects in the old account are left as they are")
		cur = state{}
	}
	cur.AccountID, cur.ZoneID, cur.Zone = zone.Account.ID, zone.ID, zone.Name
	acct := "/accounts/" + cur.AccountID
	if err := s.save(cur, map[string]string{secretAPIToken: token}); err != nil {
		return err
	}

	progress("Checking Cloudflare Zero Trust")
	team, err := s.teamDomain(ctx, token, acct)
	if err != nil {
		return err
	}
	if err := s.ensureOTP(ctx, token, acct); err != nil {
		return err
	}
	cur.TeamDomain = team

	progress("Creating the tunnel")
	tunnelID, err := s.ensureTunnel(ctx, token, acct, cur.TunnelID, host)
	if err != nil {
		return err
	}
	cur.TunnelID = tunnelID
	if err := s.save(cur, nil); err != nil {
		return err
	}
	var tunnelTok string
	if err := s.call(ctx, token, http.MethodGet, acct+"/cfd_tunnel/"+tunnelID+"/token", nil, nil, &tunnelTok); err != nil {
		return missing(err, permTunnel)
	}
	if tunnelTok == "" {
		return errors.New("Cloudflare did not return a token for the tunnel. Press \"Try again\"")
	}
	if err := s.save(cur, map[string]string{secretTunnelTok: tunnelTok}); err != nil {
		return err
	}

	progress("Routing " + host + " to CI-Plane")
	cfg := map[string]any{"config": map[string]any{"ingress": []ingressRule{
		{Hostname: host, Service: s.origin},
		{Service: "http_status:404"}, // cloudflared requires a catch-all last rule
	}}}
	if err := s.call(ctx, token, http.MethodPut, acct+"/cfd_tunnel/"+tunnelID+"/configurations", nil, cfg, nil); err != nil {
		return missing(err, permTunnel)
	}

	progress("Pointing " + host + " at the tunnel")
	recID, err := s.ensureRecord(ctx, token, cur, host, tunnelID+".cfargotunnel.com")
	if err != nil {
		return err
	}
	if cur.RecordID != "" && cur.RecordID != recID {
		// The hostname changed: the old record pointed at our tunnel.
		err := s.call(ctx, token, http.MethodDelete, "/zones/"+cur.RecordZoneID+"/dns_records/"+cur.RecordID, nil, nil, nil)
		if err != nil && !isNotFound(err) {
			s.logf("cloudflare: could not delete the old DNS record: %v", err)
		}
	}
	cur.RecordID, cur.RecordZoneID = recID, cur.ZoneID
	if err := s.save(cur, nil); err != nil {
		return err
	}

	progress("Protecting " + host + " with Cloudflare Access")
	if err := s.ensureAccess(ctx, token, &cur, host, emails); err != nil {
		return err
	}

	progress("Starting cloudflared")
	cur.Hostname, cur.Emails, cur.Ready = host, emails, true
	if err := s.save(cur, nil); err != nil {
		return err
	}
	s.changed()
	if err := s.waitConnected(ctx); err != nil {
		return err
	}

	progress("Checking from outside that " + host + " asks for a login and /webhook answers")
	if err := s.verifyRetry(ctx, host); err != nil {
		return err
	}
	return nil
}

// teamDomain returns the Access team domain, or a clear error if Zero Trust
// was never enabled on the account.
func (s *Service) teamDomain(ctx context.Context, token, acct string) (string, error) {
	var org orgObj
	err := s.call(ctx, token, http.MethodGet, acct+"/access/organizations", nil, nil, &org)
	switch {
	case err == nil && org.AuthDomain != "":
		return strings.TrimPrefix(strings.ToLower(org.AuthDomain), "https://"), nil
	case err == nil, isNotFound(err):
		return "", errZeroTrust
	case isDenied(err):
		// A missing organisation can also come back as 403, so say both.
		return "", fmt.Errorf("Cloudflare refused to show the Zero Trust organisation. Either the API token lacks %q "+
			"(create a new token with the link on this page), or Zero Trust is not enabled yet: open "+
			"https://one.dash.cloudflare.com/ once, choose a team name and the Free plan, then press \"Try again\". Details: %w", permOrg, err)
	default:
		var e *apiError
		if errors.As(err, &e) && e.Status < 500 {
			return "", fmt.Errorf("%w. Details: %v", errZeroTrust, err)
		}
		return "", err
	}
}

// ensureOTP adds "One-time PIN" as a login method. New Zero Trust
// organisations only get the Cloudflare identity provider, which admits
// members of the Cloudflare account, not arbitrary e-mail addresses.
func (s *Service) ensureOTP(ctx context.Context, token, acct string) error {
	idps, err := list[idpObj](ctx, s, token, acct+"/access/identity_providers", nil)
	if err != nil {
		return missing(err, permOrg)
	}
	for _, p := range idps {
		if p.Type == "onetimepin" {
			return nil
		}
	}
	body := map[string]any{"name": "One-time PIN", "type": "onetimepin", "config": map[string]any{}}
	return missing(s.call(ctx, token, http.MethodPost, acct+"/access/identity_providers", nil, body, nil), permOrg)
}

func (s *Service) ensureTunnel(ctx context.Context, token, acct, known, host string) (string, error) {
	if known != "" {
		var t tunnelObj
		err := s.call(ctx, token, http.MethodGet, acct+"/cfd_tunnel/"+known, nil, nil, &t)
		switch {
		case err == nil && t.DeletedAt == nil && t.ConfigSrc == "cloudflare":
			return t.ID, nil
		case err != nil && !isNotFound(err):
			return "", missing(err, permTunnel)
		}
	}
	name := tunnelName(host)
	found, err := list[tunnelObj](ctx, s, token, acct+"/cfd_tunnel", url.Values{"name": {name}, "is_deleted": {"false"}})
	if err != nil {
		return "", missing(err, permTunnel)
	}
	for _, t := range found {
		if t.Name == name && t.DeletedAt == nil && t.ConfigSrc == "cloudflare" {
			return t.ID, nil
		}
	}
	var t tunnelObj
	body := map[string]any{"name": name, "config_src": "cloudflare"}
	if err := s.call(ctx, token, http.MethodPost, acct+"/cfd_tunnel", nil, body, &t); err != nil {
		var e *apiError
		if errors.As(err, &e) && e.Status == http.StatusConflict {
			return "", fmt.Errorf("a tunnel named %s exists in Cloudflare but is managed by a configuration file, "+
				"not by CI-Plane. Delete it under Zero Trust > Networks > Tunnels, then press \"Try again\"", name)
		}
		return "", missing(err, permTunnel)
	}
	if t.ID == "" {
		return "", errors.New("Cloudflare created the tunnel but did not say its ID. Press \"Try again\"")
	}
	return t.ID, nil
}

// ensureRecord creates or updates the proxied CNAME. A record of that name
// that is not ours is left alone.
func (s *Service) ensureRecord(ctx context.Context, token string, cur state, host, target string) (string, error) {
	zone := "/zones/" + cur.ZoneID + "/dns_records"
	recs, err := list[recordObj](ctx, s, token, zone, url.Values{"name.exact": {host}})
	if err != nil {
		return "", missing(err, permDNS)
	}
	want := recordObj{Type: "CNAME", Name: host, Content: target, Proxied: true, TTL: 1, Comment: recordComment}
	var ours *recordObj
	for i, r := range recs {
		if !strings.EqualFold(strings.TrimSuffix(r.Name, "."), host) {
			continue
		}
		mine := r.Type == "CNAME" && (strings.EqualFold(r.Content, target) ||
			(r.ID == cur.RecordID && cur.RecordID != "") ||
			(r.Comment == recordComment && strings.HasSuffix(strings.ToLower(r.Content), ".cfargotunnel.com")))
		if !mine {
			return "", fmt.Errorf("the DNS record %s already exists (%s %s) and was not made by CI-Plane, so it is "+
				"left alone. Choose another subdomain, or delete that record in the Cloudflare dashboard under DNS and press \"Try again\"",
				host, r.Type, r.Content)
		}
		ours = &recs[i]
	}
	if ours == nil {
		var r recordObj
		if err := s.call(ctx, token, http.MethodPost, zone, nil, want, &r); err != nil {
			return "", missing(err, permDNS)
		}
		return r.ID, nil
	}
	if ours.Content == target && ours.Proxied && ours.Comment == recordComment {
		return ours.ID, nil
	}
	if err := s.call(ctx, token, http.MethodPut, zone+"/"+ours.ID, nil, want, nil); err != nil {
		return "", missing(err, permDNS)
	}
	return ours.ID, nil
}

func allowPolicy(host string, emails []string) policyObj {
	inc := make([]any, 0, len(emails))
	for _, e := range emails {
		var r ruleEmail
		r.Email.Email = e
		inc = append(inc, r)
	}
	return policyObj{Name: appPrefix + " " + host + ": allowed e-mails", Decision: "allow", Include: inc, SessionDuration: sessionDuration}
}

func bypassPolicy(host string) policyObj {
	// GitHub cannot sign in; the webhook handler checks GitHub's signature.
	return policyObj{Name: appPrefix + " " + host + ": webhook for everyone", Decision: "bypass",
		Include: []any{map[string]any{"everyone": map[string]any{}}}}
}

// ensurePolicy creates or updates a reusable Access policy. Reusable
// (account-level) policies are what Cloudflare offers today; legacy
// per-application policies cannot be added to new applications.
func (s *Service) ensurePolicy(ctx context.Context, token, acct, known string, p policyObj) (string, error) {
	base := acct + "/access/policies"
	id := ""
	if known != "" {
		var got policyObj
		err := s.call(ctx, token, http.MethodGet, base+"/"+known, nil, nil, &got)
		if err == nil {
			id = got.ID
		} else if !isNotFound(err) {
			return "", missing(err, permApps)
		}
	}
	if id == "" {
		all, err := list[policyObj](ctx, s, token, base, nil)
		if err != nil {
			return "", missing(err, permApps)
		}
		for _, x := range all {
			if x.Name == p.Name {
				id = x.ID
				break
			}
		}
	}
	if id == "" {
		var got policyObj
		if err := s.call(ctx, token, http.MethodPost, base, nil, p, &got); err != nil {
			return "", missing(err, permApps)
		}
		return got.ID, nil
	}
	if err := s.call(ctx, token, http.MethodPut, base+"/"+id, nil, p, nil); err != nil {
		return "", missing(err, permApps)
	}
	return id, nil
}

// ensureApp creates or updates a self-hosted Access application. An
// application on that domain that CI-Plane did not create is an error.
func (s *Service) ensureApp(ctx context.Context, token, acct, known string, want appObj) (appObj, error) {
	base := acct + "/access/apps"
	var have appObj
	if known != "" {
		err := s.call(ctx, token, http.MethodGet, base+"/"+known, nil, nil, &have)
		if err != nil && !isNotFound(err) {
			return appObj{}, missing(err, permApps)
		}
	}
	if have.ID == "" {
		all, err := list[appObj](ctx, s, token, base, nil)
		if err != nil {
			return appObj{}, missing(err, permApps)
		}
		for _, a := range all {
			if !strings.EqualFold(a.Domain, want.Domain) {
				continue
			}
			if !strings.HasPrefix(a.Name, appPrefix) {
				return appObj{}, fmt.Errorf("Cloudflare Access already has an application %q for %s that CI-Plane did not "+
					"create. Delete it under Zero Trust > Access > Applications, or choose another subdomain, then press \"Try again\"",
					a.Name, want.Domain)
			}
			have = a
			break
		}
	}
	var got appObj
	if have.ID == "" {
		if err := s.call(ctx, token, http.MethodPost, base, nil, want, &got); err != nil {
			return appObj{}, missing(err, permApps)
		}
	} else if err := s.call(ctx, token, http.MethodPut, base+"/"+have.ID, nil, want, &got); err != nil {
		return appObj{}, missing(err, permApps)
	}
	if got.ID == "" {
		got.ID = have.ID
	}
	if got.AUD == "" {
		got.AUD = have.AUD
	}
	return got, nil
}

func (s *Service) ensureAccess(ctx context.Context, token string, cur *state, host string, emails []string) error {
	acct := "/accounts/" + cur.AccountID
	var err error
	if cur.AllowPolicyID, err = s.ensurePolicy(ctx, token, acct, cur.AllowPolicyID, allowPolicy(host, emails)); err != nil {
		return err
	}
	if cur.BypassPolicyID, err = s.ensurePolicy(ctx, token, acct, cur.BypassPolicyID, bypassPolicy(host)); err != nil {
		return err
	}
	if err := s.save(*cur, nil); err != nil {
		return err
	}
	// Access picks the application with the most specific path, so
	// host/webhook wins over host for /webhook and everything below it.
	hook, err := s.ensureApp(ctx, token, acct, cur.WebhookAppID, appObj{
		Name: appPrefix + " " + host + " webhook", Domain: host + "/webhook", Type: "self_hosted",
		Destinations:    []destination{{Type: "public", URI: host + "/webhook"}},
		SessionDuration: sessionDuration,
		Policies:        []any{policyRef{ID: cur.BypassPolicyID, Precedence: 1}},
	})
	if err != nil {
		return err
	}
	cur.WebhookAppID = hook.ID
	if err := s.save(*cur, nil); err != nil {
		return err
	}
	app, err := s.ensureApp(ctx, token, acct, cur.AppID, appObj{
		Name: appPrefix + " " + host, Domain: host, Type: "self_hosted",
		Destinations:    []destination{{Type: "public", URI: host}},
		SessionDuration: sessionDuration,
		Policies:        []any{policyRef{ID: cur.AllowPolicyID, Precedence: 1}},
		AppLauncher:     true,
	})
	if err != nil {
		return err
	}
	if app.AUD == "" {
		return errors.New("Cloudflare created the Access application but did not return its AUD tag. Press \"Try again\"")
	}
	cur.AppID, cur.AppAUD = app.ID, app.AUD
	return s.save(*cur, nil)
}

// waitConnected waits until the supervisor reports edge connections.
func (s *Service) waitConnected(ctx context.Context) error {
	deadline := s.now().Add(s.ConnectFor)
	for {
		s.mu.Lock()
		ok, running, perr := s.connected, s.running, s.procErr
		s.mu.Unlock()
		if ok {
			return nil
		}
		if s.now().After(deadline) {
			msg := "cloudflared did not connect to Cloudflare within " + s.ConnectFor.String() + "."
			switch {
			case perr != "":
				msg += " " + perr
			case !running:
				msg += " It is not running; check that the cloudflared program is installed (" + s.Cloudflared + ")."
			default:
				msg += " Check that this machine may open outgoing connections on port 7844 (UDP and TCP)."
			}
			return errors.New(msg + " Then press \"Try again\"")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// SetEmails replaces who may sign in.
func (s *Service) SetEmails(ctx context.Context, emails []string) error {
	s.op.Lock()
	defer s.op.Unlock()
	emails, err := normEmails(emails)
	if err != nil {
		return err
	}
	s.mu.Lock()
	cur := s.cur
	s.mu.Unlock()
	if !cur.Ready {
		return errors.New("the tunnel is not set up yet")
	}
	token, err := s.secret(secretAPIToken)
	if err != nil {
		return errors.New("the Cloudflare API token is no longer stored. Run the Cloudflare setup again with a token")
	}
	id, err := s.ensurePolicy(ctx, token, "/accounts/"+cur.AccountID, cur.AllowPolicyID, allowPolicy(cur.Hostname, emails))
	if err != nil {
		return err
	}
	if id != cur.AllowPolicyID {
		// The policy was gone and is new: attach it again.
		cur.AllowPolicyID = id
		if err := s.ensureAccess(ctx, token, &cur, cur.Hostname, emails); err != nil {
			return err
		}
	}
	cur.Emails = emails
	return s.save(cur, nil)
}

// Remove stops cloudflared and deletes what Setup created. Anything that is
// already gone is skipped; if a deletion fails, the rest stays recorded so
// Remove can be pressed again.
func (s *Service) Remove(ctx context.Context) error {
	s.op.Lock()
	defer s.op.Unlock()
	s.mu.Lock()
	cur := s.cur
	s.mu.Unlock()

	// Stop cloudflared first: Cloudflare refuses to delete a connected tunnel.
	cur.Ready = false
	if err := s.save(cur, nil); err != nil {
		return err
	}
	s.changed()
	s.waitStopped(ctx, 20*time.Second)

	token, terr := s.secret(secretAPIToken)
	if terr == nil {
		acct := "/accounts/" + cur.AccountID
		gone := func(err error) bool { return err == nil || isNotFound(err) }
		del := func(path string, perm string, clear *string) error {
			if *clear == "" {
				return nil
			}
			err := s.call(ctx, token, http.MethodDelete, path, nil, nil, nil)
			if !gone(err) {
				return missing(err, perm)
			}
			*clear = ""
			return s.save(cur, nil)
		}
		steps := []func() error{
			// Applications before policies: a policy in use cannot be deleted.
			func() error { return del(acct+"/access/apps/"+cur.AppID, permApps, &cur.AppID) },
			func() error { return del(acct+"/access/apps/"+cur.WebhookAppID, permApps, &cur.WebhookAppID) },
			func() error { return del(acct+"/access/policies/"+cur.AllowPolicyID, permApps, &cur.AllowPolicyID) },
			func() error { return del(acct+"/access/policies/"+cur.BypassPolicyID, permApps, &cur.BypassPolicyID) },
			func() error {
				return del("/zones/"+cur.RecordZoneID+"/dns_records/"+cur.RecordID, permDNS, &cur.RecordID)
			},
			func() error { return s.deleteTunnel(ctx, token, acct, &cur) },
		}
		for _, step := range steps {
			if err := step(); err != nil {
				return fmt.Errorf("could not remove everything in Cloudflare: %w. Press \"Remove\" again to retry", err)
			}
		}
	} else {
		s.logf("cloudflare: the API token is no longer stored; delete the tunnel %s, the DNS record %s and the Access "+
			"applications by hand in the Cloudflare dashboard", tunnelName(cur.Hostname), cur.Hostname)
	}
	err := s.st.Tx(func(tx *store.Tx) error {
		for _, k := range []string{secretAPIToken, secretTunnelTok} {
			if err := s.box.Drop(tx, k); err != nil {
				return err
			}
		}
		return tx.Delete(stateKey)
	})
	if err != nil {
		return fmt.Errorf("cannot forget the tunnel settings in the database: %w", err)
	}
	s.mu.Lock()
	s.cur, s.hasToken = state{}, false
	s.setupErr, s.procErr, s.verifyErr, s.verified = "", "", "", false
	s.mu.Unlock()
	s.changed()
	return nil
}

func (s *Service) deleteTunnel(ctx context.Context, token, acct string, cur *state) error {
	if cur.TunnelID == "" {
		return nil
	}
	path := acct + "/cfd_tunnel/" + cur.TunnelID
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		// Cloudflare keeps a stopped connector listed for a while; clearing
		// the connections lets the deletion go through.
		_ = s.call(ctx, token, http.MethodDelete, path+"/connections", nil, nil, nil)
		err = s.call(ctx, token, http.MethodDelete, path, nil, nil, nil)
		if err == nil || isNotFound(err) {
			cur.TunnelID = ""
			return s.save(*cur, nil)
		}
		if isDenied(err) {
			return missing(err, permTunnel)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(s.MinBackoff * 2):
		}
	}
	return err
}

func (s *Service) waitStopped(ctx context.Context, max time.Duration) {
	deadline := time.Now().Add(max)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		r := s.running
		s.mu.Unlock()
		if !r {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(50 * time.Millisecond):
		}
	}
}
