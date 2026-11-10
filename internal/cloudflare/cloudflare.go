// Package cloudflare makes CI-Plane reachable from the internet: it creates
// a Cloudflare Tunnel, its DNS record and two Cloudflare Access applications,
// runs cloudflared, and checks the Access token of every request that comes
// through the tunnel.
package cloudflare

import (
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

var _ api.Cloudflare = (*Service)(nil)

const (
	stateKey        = "cloudflare"
	secretAPIToken  = "cloudflare-api-token"
	secretTunnelTok = "cloudflare-tunnel-token"
	// recordComment marks the DNS record as ours, so a later Setup may
	// update it and Remove may delete it.
	recordComment = "Managed by CI-Plane (Cloudflare Tunnel)"
	appPrefix     = "CI-Plane"
)

// Permission names as the dashboard shows them; the interface lists them
// next to the token link.
const (
	permTunnel = "Account > Cloudflare Tunnel > Edit"
	permApps   = "Account > Access: Apps and Policies > Edit"
	permOrg    = "Account > Access: Organizations, Identity Providers, and Groups > Edit"
	permDNS    = "Zone > DNS > Edit"
	permZone   = "Zone > Zone > Read"
)

// Permissions lists what the API token needs, in words.
func Permissions() []string {
	return []string{permTunnel, permApps, permOrg, permDNS, permZone}
}

// state is what CI-Plane remembers about its Cloudflare objects. IDs are
// written as soon as an object exists, so a Setup that stopped in the middle
// finds and reuses them.
type state struct {
	AccountID      string   `json:"accountId"`
	ZoneID         string   `json:"zoneId"`
	Zone           string   `json:"zone"`
	Hostname       string   `json:"hostname"`
	Emails         []string `json:"emails"`
	TeamDomain     string   `json:"teamDomain"` // team.cloudflareaccess.com
	TunnelID       string   `json:"tunnelId"`
	RecordID       string   `json:"recordId"`
	RecordZoneID   string   `json:"recordZoneId"`
	AllowPolicyID  string   `json:"allowPolicyId"`
	BypassPolicyID string   `json:"bypassPolicyId"`
	AppID          string   `json:"appId"`
	AppAUD         string   `json:"appAud"`
	WebhookAppID   string   `json:"webhookAppId"`
	// Ready is set once every object exists; only then runs cloudflared.
	Ready bool `json:"ready"`
}

// Service implements api.Cloudflare.
type Service struct {
	st     *store.Store
	box    *secret.Box
	origin string
	logf   func(string, ...any)

	// API is the base URL of the Cloudflare API.
	API string
	// Cloudflared is the path of the cloudflared binary.
	Cloudflared string
	// HTTP talks to the Cloudflare API and fetches the Access keys.
	HTTP *http.Client
	// Outside checks the public hostname; it must not follow redirects.
	Outside *http.Client
	// CertsURL is where the Access signing keys of a team domain are.
	CertsURL func(teamDomain string) string

	// Timings; tests shorten them.
	VerifyFor      time.Duration // how long Setup retries the check from outside
	VerifyPause    time.Duration // between two attempts
	ReverifyEvery  time.Duration // how often Run checks again
	ConnectFor     time.Duration // how long Setup waits for cloudflared to connect
	MinBackoff     time.Duration
	MaxBackoff     time.Duration
	ReadyPoll      time.Duration // how often the metrics endpoint is asked
	KeysMinRefresh time.Duration // the fastest the Access keys are fetched again
	KeysMaxAge     time.Duration // after this the keys are fetched again anyway
	now            func() time.Time

	op   sync.Mutex    // one Setup, SetEmails or Remove at a time
	wake chan struct{} // the configuration changed

	mu        sync.Mutex
	cur       state
	hasToken  bool
	running   bool
	connected bool
	verified  bool
	setupErr  string
	procErr   string
	verifyErr string

	keyMu     sync.Mutex // serialises fetching of the Access keys
	keys      map[string]*rsa.PublicKey
	keysTeam  string
	keysAt    time.Time
	keysTryAt time.Time
}

// New returns the service. origin is where cloudflared sends requests, e.g.
// "http://127.0.0.1:8081".
func New(st *store.Store, box *secret.Box, origin string, logf func(string, ...any)) *Service {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	bin := os.Getenv("CI_PLANE_CLOUDFLARED")
	if bin == "" {
		bin = "cloudflared"
	}
	s := &Service{
		st: st, box: box, origin: origin, logf: logf,
		API:         "https://api.cloudflare.com/client/v4",
		Cloudflared: bin,
		HTTP:        &http.Client{Timeout: 30 * time.Second},
		Outside: &http.Client{
			Timeout:       15 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		CertsURL:       func(team string) string { return "https://" + team + "/cdn-cgi/access/certs" },
		VerifyFor:      2 * time.Minute,
		VerifyPause:    5 * time.Second,
		ReverifyEvery:  10 * time.Minute,
		ConnectFor:     time.Minute,
		MinBackoff:     time.Second,
		MaxBackoff:     time.Minute,
		ReadyPoll:      2 * time.Second,
		KeysMinRefresh: 30 * time.Second,
		KeysMaxAge:     time.Hour,
		now:            time.Now,
		wake:           make(chan struct{}, 1),
	}
	s.load()
	return s
}

// load reads the stored state into memory; Status must not touch the store.
func (s *Service) load() {
	var cur state
	hasToken := false
	err := s.st.View(func(tx *store.Tx) error {
		if err := tx.GetJSON(stateKey, &cur); err != nil && !errors.Is(err, store.ErrNotFound) {
			return err
		}
		_, err := s.box.Get(tx, secretAPIToken)
		hasToken = err == nil
		return nil
	})
	if err != nil {
		s.logf("cloudflare: cannot read the stored tunnel settings: %v", err)
	}
	s.mu.Lock()
	s.cur, s.hasToken = cur, hasToken
	s.mu.Unlock()
}

// save stores the state and, if given, secrets in one transaction.
func (s *Service) save(cur state, secrets map[string]string) error {
	err := s.st.Tx(func(tx *store.Tx) error {
		if err := tx.SetJSON(stateKey, cur); err != nil {
			return err
		}
		for name, v := range secrets {
			if err := s.box.Put(tx, name, []byte(v)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("cannot save the tunnel settings in the database: %w", err)
	}
	s.mu.Lock()
	s.cur = cur
	if _, ok := secrets[secretAPIToken]; ok {
		s.hasToken = true
	}
	s.mu.Unlock()
	return nil
}

func (s *Service) secret(name string) (string, error) {
	var v []byte
	err := s.st.View(func(tx *store.Tx) error {
		var err error
		v, err = s.box.Get(tx, name)
		return err
	})
	return string(v), err
}

// changed tells the supervisor to look at the configuration again.
func (s *Service) changed() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// Status never blocks.
func (s *Service) Status() api.TunnelStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := api.TunnelStatus{
		Configured: s.cur.Ready,
		Hostname:   s.cur.Hostname,
		Emails:     append([]string{}, s.cur.Emails...),
		Running:    s.running,
		Connected:  s.connected,
		Verified:   s.verified,
		HasToken:   s.hasToken,
	}
	if st.Hostname != "" {
		st.PublicURL = "https://" + st.Hostname
	}
	switch {
	case s.setupErr != "":
		st.Error = s.setupErr
	case s.cur.Ready && s.procErr != "" && !s.connected:
		st.Error = s.procErr
	case s.cur.Ready && s.verifyErr != "":
		st.Error = s.verifyErr
	}
	return st
}

// TokenURL opens the dashboard's "create user API token" form with the
// permissions filled in. The keys are the short permission group keys of the
// dashboard's template links; "argotunnel" (Cloudflare Tunnel) is not in
// Cloudflare's key table but is what the dashboard accepts. Unknown keys are
// dropped silently, which is why the interface also shows Permissions().
func (s *Service) TokenURL() string {
	type key struct {
		Key  string `json:"key"`
		Type string `json:"type"`
	}
	keys, _ := json.Marshal([]key{
		{"argotunnel", "edit"},
		{"access", "edit"},
		{"access_acct", "edit"},
		{"dns", "edit"},
		{"zone", "read"},
	})
	q := url.Values{}
	q.Set("permissionGroupKeys", string(keys))
	q.Set("accountId", "*")
	q.Set("zoneId", "all")
	q.Set("name", "CI-Plane")
	return "https://dash.cloudflare.com/profile/api-tokens?" + q.Encode()
}

// Zones validates a token and lists the zones it may use.
func (s *Service) Zones(ctx context.Context, token string) ([]api.Zone, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return nil, errors.New("paste the API token first")
	}
	zones, err := list[zoneObj](ctx, s, token, "/zones", nil)
	if err != nil {
		if isDenied(err) {
			return nil, fmt.Errorf("Cloudflare does not accept this API token. Check that you copied all of it, "+
				"that it is an API token (not the Global API Key) and that it is active and includes %q. Details: %w", permZone, err)
		}
		return nil, err
	}
	if len(zones) == 0 {
		return nil, errors.New("the token may not use any domain. When you create it, choose your domain " +
			"(or \"All zones\") under \"Zone Resources\"")
	}
	// Edit includes read, so a read of each kind tells whether a permission
	// is there at all. Organisations are checked in Setup: their endpoint
	// also fails while Zero Trust is not enabled, which needs another answer.
	accounts := map[string]bool{}
	for _, z := range zones {
		if accounts[z.Account.ID] {
			continue
		}
		accounts[z.Account.ID] = true
		one := url.Values{"per_page": {"1"}}
		if err := s.call(ctx, token, http.MethodGet, "/accounts/"+z.Account.ID+"/cfd_tunnel", one, nil, nil); err != nil {
			return nil, missing(err, permTunnel)
		}
		if err := s.call(ctx, token, http.MethodGet, "/accounts/"+z.Account.ID+"/access/apps", one, nil, nil); err != nil && isDenied(err) {
			return nil, missing(err, permApps)
		}
	}
	if err := s.call(ctx, token, http.MethodGet, "/zones/"+zones[0].ID+"/dns_records", url.Values{"per_page": {"1"}}, nil, nil); err != nil {
		return nil, missing(err, permDNS)
	}
	out := make([]api.Zone, 0, len(zones))
	for _, z := range zones {
		out = append(out, api.Zone{ID: z.ID, Name: z.Name, AccountID: z.Account.ID, AccountName: z.Account.Name})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}
