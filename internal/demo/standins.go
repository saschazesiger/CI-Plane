package demo

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/github"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// --- workers -------------------------------------------------------------------

// Workers stands in for the SSH side: Check finds believable facts, Prepare
// takes a few seconds per step, and afterwards the simulated host answers.
type Workers struct{ d *Demo }

const demoKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyOfThisInstallationNotRealButShapedLikeOne ci-plane"

// PublicKey implements api.Workers.
func (w *Workers) PublicKey() string { return demoKey }

// SetupCommand implements api.Workers.
func (w *Workers) SetupCommand() string {
	return `curl -fsSL https://get.docker.com | sh -s -- --version 28 && useradd -m -s /bin/sh -G docker ci-plane && ` +
		`install -d -m 700 -o ci-plane -g ci-plane /home/ci-plane/.ssh && echo '` + demoKey + `' > /home/ci-plane/.ssh/authorized_keys && ` +
		`chown ci-plane: /home/ci-plane/.ssh/authorized_keys && chmod 600 /home/ci-plane/.ssh/authorized_keys`
}

// RemoveCommand implements api.Workers.
func (w *Workers) RemoveCommand() string {
	return `docker ps -aq --filter label=ci-plane.runner | xargs -r docker rm -f; docker volume ls -q --filter label=ci-plane.runner | xargs -r docker volume rm; ` +
		`docker network ls -q --filter label=ci-plane.runner | xargs -r docker network rm; docker rm -f ci-plane-mirror; userdel -r ci-plane`
}

// Check implements api.Workers. Hosts whose name contains "fail" or
// "offline" do not answer, so the error path can be tried.
func (w *Workers) Check(ctx context.Context, host string, port int, user string) (api.WorkerFacts, error) {
	if err := w.d.sleep(ctx, 1500*time.Millisecond); err != nil {
		return api.WorkerFacts{}, err
	}
	if strings.Contains(host, "fail") || strings.Contains(host, "offline") {
		return api.WorkerFacts{}, fmt.Errorf("Could not connect to %s:%d: connection refused. Check that the server is on and that the setup command ran on it as root", host, port)
	}
	h := fnv(host)
	cpus := []int{8, 12, 16, 24, 32}[h%5]
	mem := []int{32, 64, 64, 128}[h/7%4]
	disk := []int{480, 960, 1900}[h/11%3]
	key, fp := hostKeyOf(host)
	return api.WorkerFacts{HostKey: key, Fingerprint: fp, CPUs: cpus, MemMB: mem * 1024, DiskMB: disk * 1024,
		DiskFreeMB: disk * 1024 * 3 / 4, Docker: "28.3.2", OS: "Ubuntu 24.04.3 LTS", Arch: "x86_64"}, nil
}

// Prepare implements api.Workers.
func (w *Workers) Prepare(ctx context.Context, wk model.Worker, progress func(string)) error {
	set := model.DefaultSettings()
	_ = w.d.Store.View(func(tx *store.Tx) error {
		var err error
		set, err = tx.Settings()
		return err
	})
	for _, step := range []string{
		fmt.Sprintf("Connecting to %s:%d as %s and checking the host key", wk.Host, wk.Port, wk.User),
		"Checking Docker " + orElse(wk.Docker, "28.3.2") + " and the free disk",
		"Pulling the runner image " + set.RunnerImage,
		"Pulling " + set.DindImage,
		"Starting the registry mirror ci-plane-mirror (" + set.MirrorImage + ")",
		"Running a test container",
	} {
		progress(step)
		if err := w.d.sleep(ctx, time.Duration(1100+w.d.intn(900))*time.Millisecond); err != nil {
			return err
		}
	}
	if strings.Contains(wk.Host, "slowdisk") {
		return errors.New("the test container did not start: Docker reports \"no space left on device\". Free some disk on the server and try again")
	}
	w.d.mu.Lock()
	if w.d.hosts[wk.ID] == nil {
		w.d.hosts[wk.ID] = newHostState(wk, 0.3)
	}
	w.d.mu.Unlock()
	w.d.updateLive()
	w.d.Engine.Kick()
	return nil
}

// Cleanup implements api.Workers.
func (w *Workers) Cleanup(ctx context.Context, wk model.Worker) (string, error) {
	if err := w.d.sleep(ctx, 1800*time.Millisecond); err != nil {
		return "", err
	}
	w.d.mu.Lock()
	h := w.d.hosts[wk.ID]
	freed := 0
	if h != nil {
		freed = h.diskUsed / 5
		h.diskUsed -= freed
		h.diskLowUntil = time.Time{}
	}
	w.d.mu.Unlock()
	if h == nil || !w.d.World.Status(wk.ID).Connected {
		return "", fmt.Errorf("%s does not answer, so nothing could be cleaned up. It is cleaned up as soon as it is back", wk.Name)
	}
	w.d.updateLive()
	return fmt.Sprintf("removed 4 stopped containers, 6 unused volumes and 2 old images; %.1f GB freed", float64(freed)/1024), nil
}

// Changed implements api.Workers.
func (w *Workers) Changed() { w.d.updateLive() }

// Status implements api.Workers.
func (w *Workers) Status(id int64) engine.WorkerStatus { return w.d.World.Status(id) }

func orElse(s, def string) string {
	if s == "" {
		return def
	}
	return s
}

// --- GitHub --------------------------------------------------------------------

// GitHub stands in for the GitHub Apps. The browser is sent to pages under
// /demo/github/ that play GitHub's part.
type GitHub struct {
	d         *Demo
	mu        sync.Mutex
	states    map[string]manifestState
	installed map[int64]bool
	webhooks  map[int64]int64 // last webhook per account, Unix ms
	nextApp   int64
	publicURL string
}

type manifestState struct {
	org, returnURL, publicURL string
	code                      string
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// Manifest implements api.GitHub.
func (g *GitHub) Manifest(org, publicURL, returnURL string) (api.ManifestForm, error) {
	state := randomHex(12)
	name := "CI-Plane"
	if org != "" {
		name += " (" + org + ")"
	}
	manifest, _ := json.Marshal(map[string]any{
		"name": name, "url": publicURL, "public": false,
		"hook_attributes": map[string]any{"url": publicURL + "/webhook"},
		"redirect_url":    returnURL, "setup_url": returnURL,
		"default_events": []string{"workflow_job"},
		"default_permissions": map[string]string{
			"actions": "read", "metadata": "read", "administration": "write", "organization_self_hosted_runners": "write"},
	})
	g.mu.Lock()
	g.states[state] = manifestState{org: org, returnURL: returnURL, publicURL: publicURL, code: "demo-" + randomHex(8)}
	g.mu.Unlock()
	return api.ManifestForm{Action: "/demo/github/new?state=" + state, Manifest: string(manifest), State: state}, nil
}

// Complete implements api.GitHub.
func (g *GitHub) Complete(ctx context.Context, code, state string) (model.Account, error) {
	g.mu.Lock()
	ms, ok := g.states[state]
	if ok && ms.code == code {
		delete(g.states, state)
	}
	if g.nextApp == 0 {
		g.nextApp = 1012400
	}
	g.nextApp++
	id := g.nextApp
	g.mu.Unlock()
	if !ok || ms.code != code {
		return model.Account{}, errors.New("GitHub sent back a code this installation did not ask for. Start again with \"Add repository or organisation\"")
	}
	if err := g.d.sleep(ctx, 900*time.Millisecond); err != nil {
		return model.Account{}, err
	}
	owner, kind := ms.org, "Organization"
	if owner == "" {
		owner, kind = "demo-user", "User"
	}
	a := model.Account{ID: id, Slug: "ci-plane-" + strings.ToLower(owner), Owner: owner, OwnerType: kind,
		HTMLURL: "https://github.com/apps/ci-plane-" + strings.ToLower(owner), Enabled: true, CreatedAt: time.Now().UnixMilli()}
	err := g.d.Store.Tx(func(tx *store.Tx) error { return tx.SaveAccount(a) })
	return a, err
}

// InstallURL implements api.GitHub.
func (g *GitHub) InstallURL(a model.Account) string {
	return fmt.Sprintf("/demo/github/install?app=%d", a.ID)
}

// returnURLFor is where the install page sends the browser back to.
func (g *GitHub) returnURLFor() string {
	g.mu.Lock()
	defer g.mu.Unlock()
	return "/github/return"
}

// Sync implements api.GitHub: an installed account gets two repositories.
func (g *GitHub) Sync(ctx context.Context, accountID int64) error {
	if err := g.d.sleep(ctx, 700*time.Millisecond); err != nil {
		return err
	}
	g.mu.Lock()
	installed := g.installed[accountID]
	g.mu.Unlock()
	return g.d.Store.Tx(func(tx *store.Tx) error {
		a, err := tx.Account(accountID)
		if err != nil {
			return err
		}
		if a.InstallationID != 0 || !installed {
			return nil
		}
		a.InstallationID = 61_000_000 + accountID%1000
		if err := tx.SaveAccount(a); err != nil {
			return err
		}
		for i, name := range []string{"service", "website"} {
			if err := tx.UpsertRepo(model.Repo{ID: accountID*10 + int64(i), AccountID: accountID, FullName: a.Owner + "/" + name, Private: true, Enabled: true}); err != nil {
				return err
			}
		}
		return nil
	})
}

// Remove implements api.GitHub.
func (g *GitHub) Remove(ctx context.Context, accountID int64) (string, error) {
	var slug string
	err := g.d.Store.Tx(func(tx *store.Tx) error {
		a, err := tx.Account(accountID)
		if err != nil {
			return err
		}
		slug = a.Slug
		return tx.DeleteAccount(accountID)
	})
	if err != nil {
		return "", err
	}
	return "/demo/github/app?slug=" + slug, nil
}

// SetPublicURL implements api.GitHub.
func (g *GitHub) SetPublicURL(ctx context.Context, publicURL string) error {
	g.mu.Lock()
	g.publicURL = publicURL
	g.mu.Unlock()
	return g.d.sleep(ctx, 600*time.Millisecond)
}

// Health implements api.GitHub.
func (g *GitHub) Health(accountID int64) api.AccountHealth {
	g.mu.Lock()
	defer g.mu.Unlock()
	return api.AccountHealth{LastWebhookAt: g.webhooks[accountID], RateRemaining: 4600 + int(accountID%300)}
}

func (g *GitHub) sawWebhook(accountID int64) {
	g.mu.Lock()
	g.webhooks[accountID] = time.Now().UnixMilli()
	g.mu.Unlock()
}

func (g *GitHub) markInstalled(id int64) {
	g.mu.Lock()
	g.installed[id] = true
	g.mu.Unlock()
}

// --- Cloudflare ----------------------------------------------------------------

// Cloudflare stands in for the tunnel and Access. A hostname that contains
// "broken" fails at the DNS step, so the error path can be tried.
type Cloudflare struct {
	d  *Demo
	mu sync.Mutex
	st api.TunnelStatus
}

func (c *Cloudflare) seedConfigured() {
	c.mu.Lock()
	c.st = api.TunnelStatus{Configured: true, Hostname: "ci.acme-labs.dev", PublicURL: "https://ci.acme-labs.dev",
		Emails: []string{"ada@acme-labs.dev", "ops@acme-labs.dev"}, Running: true, Connected: true, Verified: true, HasToken: true}
	c.mu.Unlock()
}

// TokenURL implements api.Cloudflare.
func (c *Cloudflare) TokenURL() string { return "https://dash.cloudflare.com/profile/api-tokens" }

// Zones implements api.Cloudflare.
func (c *Cloudflare) Zones(ctx context.Context, token string) ([]api.Zone, error) {
	if err := c.d.sleep(ctx, 900*time.Millisecond); err != nil {
		return nil, err
	}
	if len(strings.TrimSpace(token)) < 20 {
		return nil, errors.New("Cloudflare did not accept this token: it is too short. Copy the whole token from Cloudflare and paste it again")
	}
	return []api.Zone{
		{ID: "zone-acme", Name: "acme-labs.dev", AccountID: "cf-1", AccountName: "Acme Labs"},
		{ID: "zone-example", Name: "example.org", AccountID: "cf-1", AccountName: "Acme Labs"},
	}, nil
}

// Setup implements api.Cloudflare.
func (c *Cloudflare) Setup(ctx context.Context, req api.TunnelSetup, progress func(string)) error {
	steps := []string{
		"Checking the token and its permissions",
		"Creating the tunnel ci-plane",
		"Creating the DNS record " + req.Hostname,
		"Routing " + req.Hostname + " through the tunnel to CI-Plane",
		"Creating the Access application for " + req.Hostname + " (" + fmt.Sprint(len(req.Emails)) + " allowed e-mail addresses)",
		"Letting " + req.Hostname + "/webhook through for GitHub",
		"Starting cloudflared",
		"Waiting for the tunnel to connect",
		"Checking from outside that " + req.Hostname + " asks for a login",
		"Checking from outside that " + req.Hostname + "/webhook answers",
	}
	for i, step := range steps {
		progress(step)
		if err := c.d.sleep(ctx, time.Duration(700+c.d.intn(900))*time.Millisecond); err != nil {
			return err
		}
		if i == 2 && strings.Contains(req.Hostname, "broken") {
			return fmt.Errorf("Cloudflare refused to create the DNS record %s: a record with this name exists already. Delete it on Cloudflare or choose another subdomain", req.Hostname)
		}
	}
	c.mu.Lock()
	c.st = api.TunnelStatus{Configured: true, Hostname: req.Hostname, PublicURL: "https://" + req.Hostname, Emails: req.Emails,
		Running: true, Connected: true, Verified: true, HasToken: true}
	c.mu.Unlock()
	return nil
}

// Status implements api.Cloudflare.
func (c *Cloudflare) Status() api.TunnelStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	st := c.st
	st.Emails = append([]string{}, c.st.Emails...)
	return st
}

// SetEmails implements api.Cloudflare.
func (c *Cloudflare) SetEmails(ctx context.Context, emails []string) error {
	if err := c.d.sleep(ctx, 700*time.Millisecond); err != nil {
		return err
	}
	c.mu.Lock()
	c.st.Emails = append([]string{}, emails...)
	c.mu.Unlock()
	return nil
}

// Remove implements api.Cloudflare.
func (c *Cloudflare) Remove(ctx context.Context) error {
	if err := c.d.sleep(ctx, 1200*time.Millisecond); err != nil {
		return err
	}
	c.mu.Lock()
	c.st = api.TunnelStatus{}
	c.mu.Unlock()
	return nil
}

// Authenticate implements api.Cloudflare. The demo has no tunnel.
func (c *Cloudflare) Authenticate(r *http.Request) (string, error) {
	return "", errors.New("the demo has no tunnel")
}

var (
	_ api.Workers    = (*Workers)(nil)
	_ api.GitHub     = (*GitHub)(nil)
	_ api.Cloudflare = (*Cloudflare)(nil)
)

// Relay stands in for the failover to GitHub-hosted runners: the simulated
// world runs them, so there is nothing to check.
type Relay struct{}

func (*Relay) ServeHTTP(w http.ResponseWriter, _ *http.Request) {
	http.Error(w, "not in demo mode", http.StatusNotFound)
}

// Check implements api.Relay.
func (*Relay) Check(context.Context, int64) api.RelayCheck {
	return api.RelayCheck{Problems: []string{}}
}

// Workflow implements api.Relay.
func (*Relay) Workflow() string { return github.RelayWorkflowYAML }
