package github

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// RelayWorkflowYAML is the relay workflow the person adds to the relay
// repository as .github/workflows/ci-plane-relay.yml.
//
//go:embed relay-workflow.yml
var RelayWorkflowYAML string

var _ engine.Hosts = (*Relay)(nil)

// Relay runs runners on GitHub-hosted machines: it is the worker
// model.RelayWorkerID of the engine. Starting a runner dispatches the relay
// workflow in the relay repository with the runner's name; the run proves
// with its OIDC token who it is and collects the runner's configuration
// (ServeHTTP). Its runs are what containers are on a worker.
type Relay struct {
	s *Service
	// PublicURL returns the address under which GitHub reaches CI-Plane,
	// or "" while there is none (no tunnel, or it is down).
	PublicURL func() string

	oidc *oidcVerifier

	mu       sync.Mutex
	recent   map[string]time.Time // dispatched, by runner name, until its run shows
	branches map[string]string    // default branch, by repository
}

const (
	// relayRecent is how long a dispatched run counts as running while
	// GitHub does not list it yet.
	relayRecent = 2 * time.Minute
	// relayWindow is how far back the runs of the relay workflow are
	// looked at. A run is queued for at most a day and runs for at most
	// six hours (timeout-minutes of the workflow).
	relayWindow = 31 * time.Hour
	// relayRecollect is how long the run that collected a runner may
	// collect it again, in case the answer was lost on the way.
	relayRecollect = 5 * time.Minute
	// relayIdleMinutes is how long the runner on GitHub waits for a job
	// before it stops by itself, so that a runner nobody needs does not
	// use minutes for hours while CI-Plane is away.
	relayIdleMinutes = 20
)

// NewRelay creates the relay on top of the service.
func NewRelay(s *Service, publicURL func() string) *Relay {
	return &Relay{
		s: s, PublicURL: publicURL,
		oidc:     newOIDCVerifier(actionsIssuer, s.HTTP, s.now),
		recent:   map[string]time.Time{},
		branches: map[string]string{},
	}
}

func pendingName(runner string) string { return "relay:" + runner }

// relayPending is a runner of the relay, stored sealed from its dispatch
// until it is removed.
type relayPending struct {
	JITConfig   string `json:"jitconfig"`
	At          int64  `json:"at"`          // when the workflow was dispatched, Unix ms
	Repo        string `json:"repo"`        // the relay repository it was dispatched in
	CollectedBy string `json:"collectedBy"` // run id that collected it
	CollectedAt int64  `json:"collectedAt"`
}

// relayRepo is the relay repository as CI-Plane knows it.
type relayRepo struct {
	model.Repo
	account model.Account
}

// find looks a repository up among those the apps are installed on.
// name empty means the relay repository of the settings.
func (r *Relay) find(name string) (relayRepo, error) {
	var out relayRepo
	err := r.s.st.View(func(tx *store.Tx) error {
		if name == "" {
			set, err := tx.Settings()
			if err != nil {
				return err
			}
			if name = set.RelayRepo; name == "" {
				return errors.New("no relay repository is chosen; choose one under Settings → Failover to GitHub")
			}
		}
		repos, err := tx.Repos(0)
		if err != nil {
			return err
		}
		for _, p := range repos {
			if strings.EqualFold(p.FullName, name) {
				out.Repo = p
				break
			}
		}
		if out.ID == 0 {
			return fmt.Errorf("CI-Plane does not see the relay repository %s: install the GitHub App of %s on it", name, ownerOf(name))
		}
		if out.account, err = tx.Account(out.AccountID); err != nil {
			return fmt.Errorf("the account of the relay repository %s is not connected: %w", name, err)
		}
		return nil
	})
	return out, err
}

// repo is the relay repository of the settings, checked for starting
// runners in it. Its errors say what the person has to do.
func (r *Relay) repo() (relayRepo, error) {
	out, err := r.find("")
	if err != nil {
		return out, err
	}
	switch {
	case !out.Private:
		return out, fmt.Errorf("the relay repository %s is public; use a private repository, because its runs show the names of your runners", out.FullName)
	case out.account.InstallationID == 0:
		return out, fmt.Errorf("the GitHub App of %s is not installed any more; install it again under Repositories", out.account.Owner)
	}
	return out, nil
}

func ownerOf(full string) string {
	owner, _, _ := strings.Cut(full, "/")
	return owner
}

func (r *Relay) workflowPath(repo string) (string, error) {
	p, err := repoPath(repo)
	if err != nil {
		return "", err
	}
	return p + "/actions/workflows/" + url.PathEscape(model.RelayWorkflow), nil
}

// defaultBranch is the branch the workflow is dispatched on.
func (r *Relay) defaultBranch(ctx context.Context, rr relayRepo) (string, error) {
	r.mu.Lock()
	b := r.branches[rr.FullName]
	r.mu.Unlock()
	if b != "" {
		return b, nil
	}
	p, err := repoPath(rr.FullName)
	if err != nil {
		return "", err
	}
	var out struct {
		DefaultBranch string `json:"default_branch"`
	}
	if _, err := r.s.getJSON(ctx, call{method: http.MethodGet, path: p, auth: authInstallation, account: rr.AccountID}, &out); err != nil {
		return "", passing(err)
	}
	if out.DefaultBranch == "" {
		return "", fmt.Errorf("the relay repository %s has no default branch; push the relay workflow to it first", rr.FullName)
	}
	r.mu.Lock()
	r.branches[rr.FullName] = out.DefaultBranch
	r.mu.Unlock()
	return out.DefaultBranch, nil
}

// passingErr is a failure that says nothing about the relay: GitHub's rate
// limit, a network error, an error of GitHub's own.
type passingErr struct{ error }

func (p passingErr) Unwrap() error        { return p.error }
func (p passingErr) Is(target error) bool { return target == engine.ErrPassing }

// passing marks err as passing if it is one.
func passing(err error) error {
	var rl *RateLimitError
	if err == nil || errors.As(err, &rl) || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		if err != nil {
			return passingErr{err}
		}
		return nil
	}
	if st := statusOf(err); st == 0 || st >= 500 || st == http.StatusTooManyRequests {
		return passingErr{err}
	}
	return err
}

// Start implements engine.Hosts: it dispatches the relay workflow for the
// runner. A run left of an earlier start under the same name is stopped
// first, so it can be repeated.
func (r *Relay) Start(ctx context.Context, _ model.Worker, spec engine.RunnerSpec) error {
	rr, err := r.repo()
	if err != nil {
		return err
	}
	base := ""
	if r.PublicURL != nil {
		base = strings.TrimRight(r.PublicURL(), "/")
	}
	if !strings.HasPrefix(base, "https://") {
		return passingErr{errors.New("the Cloudflare tunnel is not connected, so the relay workflow could not reach CI-Plane; check it under Settings")}
	}
	if err := r.stop(ctx, rr, spec.Name, time.Time{}); err != nil {
		return err
	}
	branch, err := r.defaultBranch(ctx, rr)
	if err != nil {
		return err
	}
	now := r.s.now()
	b, _ := json.Marshal(relayPending{JITConfig: spec.JITConfig, At: now.UnixMilli(), Repo: rr.FullName})
	if err := r.s.st.Tx(func(tx *store.Tx) error { return r.s.box.Put(tx, pendingName(spec.Name), b) }); err != nil {
		return err
	}
	wf, err := r.workflowPath(rr.FullName)
	if err != nil {
		return err
	}
	// Once: a dispatch that is repeated starts two runs. If the answer is
	// lost, the engine starts again, which stops what this one started.
	_, err = r.s.do(ctx, call{
		method: http.MethodPost, path: wf + "/dispatches", auth: authInstallation, account: rr.AccountID, once: true,
		body: map[string]any{"ref": branch, "inputs": map[string]string{"runner": spec.Name, "url": base}},
	})
	if err != nil {
		r.drop(spec.Name)
		switch statusOf(err) {
		case http.StatusNotFound:
			return fmt.Errorf("the relay workflow .github/workflows/%s is not on the branch %s of %s: add it as shown under Settings → Failover to GitHub", model.RelayWorkflow, branch, rr.FullName)
		case http.StatusUnprocessableEntity:
			return fmt.Errorf("GitHub did not start the relay workflow in %s: %w. Replace the workflow with the one shown under Settings → Failover to GitHub", rr.FullName, err)
		case http.StatusForbidden:
			if strings.Contains(strings.ToLower(err.Error()), "not accessible by integration") {
				return fmt.Errorf("the GitHub App of %s may not start workflows: give it \"Actions: Read and write\" at %s and accept the new permission on its installation", rr.account.Owner, appPermissionsURL(rr.account))
			}
		}
		return passing(fmt.Errorf("GitHub did not start the relay workflow in %s: %w", rr.FullName, err))
	}
	r.mu.Lock()
	r.recent[spec.Name] = now
	r.mu.Unlock()
	return nil
}

func (r *Relay) pending(name string) (relayPending, bool) {
	var p relayPending
	ok := false
	_ = r.s.st.View(func(tx *store.Tx) error {
		b, err := r.s.box.Get(tx, pendingName(name))
		if err == nil && json.Unmarshal(b, &p) == nil {
			ok = true
		}
		return nil
	})
	return p, ok
}

// drop forgets a runner.
func (r *Relay) drop(name string) {
	_ = r.s.st.Tx(func(tx *store.Tx) error { return r.s.box.Drop(tx, pendingName(name)) })
}

// Remove implements engine.Hosts: the run of the runner is cancelled if it
// still runs, in the repository it was started in, and the runner is
// forgotten.
func (r *Relay) Remove(ctx context.Context, _ model.Worker, name string) error {
	p, _ := r.pending(name)
	rr, err := r.find(p.Repo)
	if err != nil {
		// Neither repository is known any more: there is no run CI-Plane
		// could stop. The runner's registration is gone, so a run that
		// still starts has nothing to run, and it stops by itself.
		r.drop(name)
		return nil
	}
	r.mu.Lock()
	since := r.recent[name]
	r.mu.Unlock()
	if err := r.stop(ctx, rr, name, since); err != nil {
		return err
	}
	r.drop(name)
	r.mu.Lock()
	delete(r.recent, name)
	r.mu.Unlock()
	return nil
}

// stop cancels the runs of a runner that have not ended. A run dispatched
// at since that GitHub does not list yet cannot be cancelled: then stop
// fails, and is tried again.
func (r *Relay) stop(ctx context.Context, rr relayRepo, name string, since time.Time) error {
	runs, err := r.runs(ctx, rr)
	if err != nil {
		return err
	}
	p, err := repoPath(rr.FullName)
	if err != nil {
		return err
	}
	seen := false
	for _, run := range runs {
		if run.Title != name {
			continue
		}
		if !since.IsZero() && !run.created().Before(since.Add(-time.Minute)) {
			seen = true
		}
		if run.Status == "completed" {
			continue
		}
		_, err := r.s.do(ctx, call{method: http.MethodPost, path: p + "/actions/runs/" + strconv.FormatInt(run.ID, 10) + "/cancel", auth: authInstallation, account: rr.AccountID})
		if err != nil && statusOf(err) != http.StatusConflict { // 409: it ended meanwhile
			return passing(fmt.Errorf("cannot stop the run of %s in %s: %w", name, rr.FullName, err))
		}
	}
	if !since.IsZero() && !seen && r.s.now().Sub(since) < relayRecent {
		return passingErr{fmt.Errorf("the run of %s in %s does not show on GitHub yet", name, rr.FullName)}
	}
	return nil
}

// relayRun is a run of the relay workflow.
type relayRun struct {
	ID         int64  `json:"id"`
	Title      string `json:"display_title"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	CreatedAt  string `json:"created_at"`
}

func (x relayRun) created() time.Time {
	t, _ := time.Parse(time.RFC3339, x.CreatedAt)
	return t
}

// runs lists the runs of the relay workflow of the last relayWindow,
// newest first. The address stays the same from call to call, so an
// unchanged first page costs nothing of the rate limit.
func (r *Relay) runs(ctx context.Context, rr relayRepo) ([]relayRun, error) {
	wf, err := r.workflowPath(rr.FullName)
	if err != nil {
		return nil, err
	}
	since := r.s.now().Add(-relayWindow)
	var all []relayRun
	for page := 1; page <= 20; page++ {
		var out struct {
			Runs []relayRun `json:"workflow_runs"`
		}
		q := url.Values{"event": {"workflow_dispatch"}, "per_page": {"100"}, "page": {strconv.Itoa(page)}}
		_, err := r.s.getJSON(ctx, call{method: http.MethodGet, path: wf + "/runs?" + q.Encode(), auth: authInstallation, account: rr.AccountID, conditional: true}, &out)
		if err != nil {
			if statusOf(err) == http.StatusNotFound {
				return nil, fmt.Errorf("the relay workflow .github/workflows/%s is not in %s", model.RelayWorkflow, rr.FullName)
			}
			return nil, passing(err)
		}
		all = append(all, out.Runs...)
		if len(out.Runs) < 100 {
			return all, nil
		}
		if c := out.Runs[len(out.Runs)-1].created(); !c.IsZero() && c.Before(since) {
			return all, nil
		}
	}
	return nil, fmt.Errorf("the relay workflow in %s has more than 2000 runs in %d hours; CI-Plane cannot follow them all", rr.FullName, int(relayWindow.Hours()))
}

// List implements engine.Hosts: the runs of the relay workflow, as the
// runners they run. A run that ended successfully is a runner that exited
// by itself.
func (r *Relay) List(ctx context.Context, _ model.Worker) ([]engine.Container, error) {
	rr, err := r.repo()
	if err != nil {
		return nil, err
	}
	runs, err := r.runs(ctx, rr)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	recent := make(map[string]time.Time, len(r.recent))
	for k, v := range r.recent {
		recent[k] = v
	}
	r.mu.Unlock()
	by := map[string]engine.Container{}
	for _, run := range runs {
		if !strings.HasPrefix(run.Title, engine.NamePrefix) {
			continue
		}
		// A run older than the latest dispatch of its name was stopped by
		// that dispatch; it says nothing about the runner.
		if at, ok := recent[run.Title]; ok && run.created().Before(at.Add(-time.Minute)) {
			continue
		}
		c := engine.Container{Runner: run.Title, Running: run.Status != "completed"}
		if !c.Running && run.Conclusion != "success" {
			c.ExitCode = 1
		}
		// The run that still runs counts; of ended ones, a successful one.
		if old, ok := by[run.Title]; ok && (old.Running || (!c.Running && old.ExitCode == 0)) {
			continue
		}
		by[run.Title] = c
	}
	// A run GitHub does not list yet was only just dispatched.
	now := r.s.now()
	r.mu.Lock()
	for name, at := range r.recent {
		_, listed := by[name]
		switch {
		case listed || now.Sub(at) > relayRecent:
			delete(r.recent, name)
		default:
			by[name] = engine.Container{Runner: name, Running: true}
		}
	}
	r.mu.Unlock()
	out := make([]engine.Container, 0, len(by))
	for _, c := range by {
		out = append(out, c)
	}
	return out, nil
}

// Status implements engine.Hosts. The relay is there while CI-Plane can be
// reached from outside; whether GitHub runs the workflow shows when it is
// tried.
func (r *Relay) Status(int64) engine.WorkerStatus {
	if r.PublicURL == nil || !strings.HasPrefix(r.PublicURL(), "https://") {
		return engine.WorkerStatus{Error: "the Cloudflare tunnel is not connected, so the relay workflow could not reach CI-Plane"}
	}
	return engine.WorkerStatus{Connected: true, At: r.s.now().UnixMilli()}
}

// Check says what keeps the failover from working, in words for the
// person: nothing if it is ready.
func (r *Relay) Check(ctx context.Context) []string {
	var out []string
	if r.PublicURL == nil || !strings.HasPrefix(r.PublicURL(), "https://") {
		out = append(out, "The Cloudflare tunnel is not set up or not connected, so the relay workflow could not reach CI-Plane. Check it under Settings.")
	}
	rr, err := r.repo()
	if err != nil {
		return append(out, upper(err.Error())+".")
	}
	wf, err := r.workflowPath(rr.FullName)
	if err != nil {
		return append(out, upper(err.Error())+".")
	}
	// The app must be allowed to start workflows; apps created by early
	// versions of CI-Plane may only read Actions.
	var inst struct {
		Permissions map[string]string `json:"permissions"`
	}
	ip, _ := repoPath(rr.FullName)
	if _, err := r.s.getJSON(ctx, call{method: http.MethodGet, path: ip + "/installation", auth: authApp, account: rr.AccountID}, &inst); err == nil && inst.Permissions["actions"] != "write" {
		out = append(out, fmt.Sprintf("The GitHub App of %s may not start workflows. Give it \"Actions: Read and write\" at %s and accept the new permission on its installation.", rr.account.Owner, appPermissionsURL(rr.account)))
	}
	var info struct {
		State string `json:"state"`
	}
	_, err = r.s.getJSON(ctx, call{method: http.MethodGet, path: wf, auth: authInstallation, account: rr.AccountID}, &info)
	switch {
	case statusOf(err) == http.StatusNotFound:
		out = append(out, fmt.Sprintf("The relay workflow is not in %s. Add it as .github/workflows/%s on the default branch.", rr.FullName, model.RelayWorkflow))
	case err != nil:
		out = append(out, "GitHub could not be asked about the relay workflow: "+err.Error()+".")
	case info.State != "active":
		out = append(out, fmt.Sprintf("The relay workflow in %s is disabled (%s). Enable it under Actions in the repository.", rr.FullName, info.State))
	}
	return out
}

// appPermissionsURL is the page where the permissions of an app are edited.
func appPermissionsURL(a model.Account) string {
	if a.IsOrg() {
		return "https://github.com/organizations/" + url.PathEscape(a.Owner) + "/settings/apps/" + url.PathEscape(a.Slug) + "/permissions"
	}
	return "https://github.com/settings/apps/" + url.PathEscape(a.Slug) + "/permissions"
}

func upper(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// Workflow returns the relay workflow.
func (r *Relay) Workflow() string { return RelayWorkflowYAML }

// ServeHTTP hands the configuration of its runner to a run of the relay
// workflow: POST with the run's OIDC token as bearer token. It is reachable
// from the internet, so it trusts nothing but the token: it must come from
// the relay workflow on the default branch of the relay repository, started
// by the GitHub App, and the run's title names the runner. Only that run
// gets the configuration, and it may ask again for a few minutes in case
// the answer was lost.
func (r *Relay) ServeHTTP(w http.ResponseWriter, req *http.Request) {
	fail := func(status int, msg string) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
	}
	if req.Method != http.MethodPost {
		fail(http.StatusMethodNotAllowed, "use POST")
		return
	}
	token, ok := strings.CutPrefix(req.Header.Get("Authorization"), "Bearer ")
	if !ok || strings.TrimSpace(token) == "" {
		fail(http.StatusUnauthorized, "send the OIDC token of the run as bearer token")
		return
	}
	ctx := req.Context()
	claims, err := r.oidc.verify(ctx, strings.TrimSpace(token), model.RelayAudience)
	if err != nil {
		var bad errToken
		if errors.As(err, &bad) {
			fail(http.StatusUnauthorized, bad.msg)
			return
		}
		r.s.logf("relay: verify a token: %v", err)
		fail(http.StatusServiceUnavailable, "CI-Plane cannot check the token right now; try again")
		return
	}
	rr, err := r.repo()
	if err != nil {
		// Anybody can show a token of some repository: say nothing about ours.
		r.s.logf("relay: run %s of %s asked for its runner: %v", claims.RunID, claims.Repository, err)
		fail(http.StatusForbidden, "CI-Plane hands out no runners to this repository")
		return
	}
	if claims.RepositoryID != strconv.FormatInt(rr.ID, 10) || !strings.EqualFold(claims.Repository, rr.FullName) {
		r.s.logf("relay: refused a token of %s (%s)", claims.Repository, claims.RepositoryID)
		fail(http.StatusForbidden, "CI-Plane hands out no runners to this repository")
		return
	}
	branch, err := r.defaultBranch(ctx, rr)
	if err != nil {
		r.s.logf("relay: default branch of %s: %v", rr.FullName, err)
		fail(http.StatusServiceUnavailable, "CI-Plane cannot ask GitHub about the relay repository right now; try again")
		return
	}
	switch {
	case !strings.EqualFold(claims.WorkflowRef, rr.FullName+"/.github/workflows/"+model.RelayWorkflow+"@refs/heads/"+branch):
		fail(http.StatusForbidden, "only the workflow "+model.RelayWorkflow+" on the branch "+branch+" may collect runners")
		return
	case claims.EventName != "workflow_dispatch" || !strings.EqualFold(claims.Actor, rr.account.Slug+"[bot]"):
		fail(http.StatusForbidden, "only runs that CI-Plane started may collect runners")
		return
	}
	// The run's title is the runner's name: GitHub says which run this is.
	p, _ := repoPath(rr.FullName)
	var run relayRun
	if _, err := r.s.getJSON(ctx, call{method: http.MethodGet, path: p + "/actions/runs/" + url.PathEscape(claims.RunID), auth: authInstallation, account: rr.AccountID}, &run); err != nil {
		if statusOf(err) == http.StatusNotFound {
			fail(http.StatusNotFound, "GitHub does not know this run")
			return
		}
		r.s.logf("relay: run %s of %s: %v", claims.RunID, rr.FullName, err)
		fail(http.StatusServiceUnavailable, "CI-Plane cannot ask GitHub about this run right now; try again")
		return
	}
	name := run.Title
	if !strings.HasPrefix(name, engine.NamePrefix) {
		fail(http.StatusNotFound, "no runner waits for this run")
		return
	}
	now := r.s.now()
	var cfg relayPending
	err = r.s.st.Tx(func(tx *store.Tx) error {
		b, err := r.s.box.Get(tx, pendingName(name))
		if err != nil {
			return err
		}
		if err := json.Unmarshal(b, &cfg); err != nil {
			return err
		}
		switch {
		case cfg.CollectedBy == claims.RunID && now.UnixMilli()-cfg.CollectedAt < relayRecollect.Milliseconds():
			return nil // the same run again: its first answer was lost
		case cfg.CollectedBy != "" || cfg.JITConfig == "":
			return store.ErrNotFound
		case !run.created().IsZero() && run.created().UnixMilli() < cfg.At-5*60_000:
			// Older than the dispatch: not the run CI-Plane started, but a
			// re-run of an earlier one, for instance.
			return errStale
		}
		cfg.CollectedBy, cfg.CollectedAt = claims.RunID, now.UnixMilli()
		b, _ = json.Marshal(cfg)
		return r.s.box.Put(tx, pendingName(name), b)
	})
	switch {
	case errors.Is(err, store.ErrNotFound):
		fail(http.StatusNotFound, "no runner waits for this run: it was handed out already, or CI-Plane gave it up")
		return
	case errors.Is(err, errStale):
		fail(http.StatusConflict, "this run is older than the runner it names; CI-Plane started another run for it")
		return
	case err != nil:
		r.s.logf("relay: hand out %s: %v", name, err)
		fail(http.StatusInternalServerError, "CI-Plane could not read the runner's configuration")
		return
	}
	r.s.logf("relay: run %s of %s collected the runner %s", claims.RunID, rr.FullName, name)
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(map[string]string{"runner": name, "jitconfig": cfg.JITConfig})
}

var errStale = errors.New("stale run")
