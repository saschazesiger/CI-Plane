// Package api serves the web interface and its JSON API.
package api

import (
	"context"
	"net/http"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
)

// The three services below are what the interface needs from the packages
// node, github and cloudflare. The demo mode has stand-ins for all of them.

// WorkerFacts is what a first connection to a host finds.
type WorkerFacts struct {
	HostKey     string `json:"hostKey"`     // authorized_keys format; pinned when the worker is added
	Fingerprint string `json:"fingerprint"` // SHA256:... of the host key, to show
	CPUs        int    `json:"cpus"`
	MemMB       int    `json:"memMb"`
	DiskMB      int    `json:"diskMb"`     // size of the filesystem Docker stores its data on
	DiskFreeMB  int    `json:"diskFreeMb"` // free on that filesystem
	Docker      string `json:"docker"`     // Docker version
	OS          string `json:"os"`         // e.g. "Ubuntu 24.04"
	Arch        string `json:"arch"`       // e.g. "x86_64"
}

// Workers manages the hosts that run runners.
type Workers interface {
	// PublicKey is the SSH public key of this installation.
	PublicKey() string
	// SetupCommand is the one line to paste on a new worker as root.
	SetupCommand() string
	// RemoveCommand is the one line that undoes SetupCommand.
	RemoveCommand() string
	// Check connects once to a host that is not stored yet. The error text
	// is shown to the user as it is and should say what to do.
	Check(ctx context.Context, host string, port int, user string) (WorkerFacts, error)
	// Prepare makes a stored worker ready for jobs: pulls the images, starts
	// the registry mirror, runs a test container. progress receives one
	// short line per step as it begins.
	Prepare(ctx context.Context, w model.Worker, progress func(step string)) error
	// Cleanup removes leftovers on a worker now and says what it freed.
	Cleanup(ctx context.Context, w model.Worker) (string, error)
	// Changed tells the service that workers were added, edited or removed
	// in the store, or that settings changed.
	Changed()
	// Status is the live view of a worker; it never blocks.
	Status(workerID int64) engine.WorkerStatus
}

// ManifestForm is the form the browser posts to GitHub to create an app.
type ManifestForm struct {
	Action   string `json:"action"`   // URL on github.com
	Manifest string `json:"manifest"` // JSON, sent as the form field "manifest"
	State    string `json:"state"`    // returned by GitHub, checked by Complete
}

// AccountHealth is the live view of a GitHub account.
type AccountHealth struct {
	LastWebhookAt int64  `json:"lastWebhookAt"` // Unix ms; 0 = none since start
	LastError     string `json:"lastError"`     // last API or webhook problem, empty if fine
	RateRemaining int    `json:"rateRemaining"` // API requests left this hour; -1 = unknown
}

// GitHub manages the GitHub Apps.
type GitHub interface {
	// Manifest prepares the creation of an app owned by the signed-in user
	// (org empty) or by an organisation. publicURL is where GitHub reaches
	// CI-Plane (the webhook is publicURL + "/webhook"); returnURL is where
	// the browser comes back to with ?code=...&state=...
	Manifest(org, publicURL, returnURL string) (ManifestForm, error)
	// Complete finishes the creation with the code GitHub passed back and
	// stores the account.
	Complete(ctx context.Context, code, state string) (model.Account, error)
	// InstallURL is the page on GitHub where the app is installed on
	// repositories.
	InstallURL(a model.Account) string
	// Sync reads the installation and its repositories into the store.
	Sync(ctx context.Context, accountID int64) error
	// Remove forgets an account and returns the page on GitHub where the
	// app itself can be deleted.
	Remove(ctx context.Context, accountID int64) (settingsURL string, err error)
	// SetPublicURL points the webhooks of all apps to a new public URL.
	SetPublicURL(ctx context.Context, publicURL string) error
	// Health is the live view of an account; it never blocks.
	Health(accountID int64) AccountHealth
}

// Zone is a domain in a Cloudflare account the token may use.
type Zone struct {
	ID          string `json:"id"`
	Name        string `json:"name"` // example.com
	AccountID   string `json:"accountId"`
	AccountName string `json:"accountName"`
}

// TunnelSetup is what the assistant collects.
type TunnelSetup struct {
	APIToken string   `json:"apiToken"`
	ZoneID   string   `json:"zoneId"`
	Hostname string   `json:"hostname"` // ci.example.com
	Emails   []string `json:"emails"`   // who may sign in through Cloudflare Access
}

// TunnelStatus is the live view of the tunnel.
type TunnelStatus struct {
	Configured bool     `json:"configured"`
	Hostname   string   `json:"hostname"`
	PublicURL  string   `json:"publicUrl"` // https://hostname
	Emails     []string `json:"emails"`
	Running    bool     `json:"running"`   // cloudflared process is up
	Connected  bool     `json:"connected"` // it has connections to Cloudflare
	Verified   bool     `json:"verified"`  // seen from outside: / asks for a login, /webhook answers
	Error      string   `json:"error"`     // what is wrong, empty if fine
	HasToken   bool     `json:"hasToken"`  // the API token is still stored
}

// Cloudflare manages the tunnel and the login through Cloudflare Access.
type Cloudflare interface {
	// TokenURL opens Cloudflare's "create token" page with the needed
	// permissions filled in.
	TokenURL() string
	// Zones lists the domains a token may use; it also validates the token.
	Zones(ctx context.Context, apiToken string) ([]Zone, error)
	// Setup creates tunnel, DNS record, routing and the Access
	// applications, starts cloudflared and verifies from outside. progress
	// receives one short line per step as it begins.
	Setup(ctx context.Context, req TunnelSetup, progress func(step string)) error
	// Status never blocks.
	Status() TunnelStatus
	// SetEmails replaces who may sign in.
	SetEmails(ctx context.Context, emails []string) error
	// Remove deletes tunnel, DNS record and Access applications and stops
	// cloudflared.
	Remove(ctx context.Context) error
	// Authenticate checks the Cloudflare Access token of a request that came
	// through the tunnel and returns the e-mail of the user.
	Authenticate(r *http.Request) (email string, err error)
}

// Relay is the failover to GitHub-hosted runners.
type Relay interface {
	// ServeHTTP hands runs of the relay workflow their runner
	// (/webhook/relay on the tunnel).
	http.Handler
	// Check says what keeps the failover from working, one sentence per
	// problem; nothing if it is ready.
	Check(ctx context.Context) []string
	// Workflow is the relay workflow to add to the relay repository.
	Workflow() string
}
