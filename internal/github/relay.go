package github

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// RelayWorkflowYAML is the relay workflow the person adds to the repository
// of a pool, as .github/workflows/ci-plane-relay.yml. It only calls the
// relay runner workflow of CI-Plane's own repository.
//
//go:embed relay-workflow.yml
var RelayWorkflowYAML string

// relayRunnerRefs are the versions of the relay runner workflow whose runs
// may collect a runner, as the OIDC claim job_workflow_ref names them. The
// workflow is pinned by a tag of CI-Plane's repository, so whoever may change
// ci-plane-relay.yml in a repository can call it, but cannot change what
// runs: a run of anything else is refused.
var relayRunnerRefs = []string{
	"saschazesiger/CI-Plane/.github/workflows/ci-plane-relay-runner.yml@refs/tags/relay-v2",
}

var _ engine.Hosts = (*Relay)(nil)

// Relay runs the runners of the pools (model.Pool) on machines of GitHub
// and of other providers of GitHub Actions runners. Starting a runner
// dispatches the relay workflow in the pool's repository with the runner's
// name and the label of the machine; the run proves with its OIDC token who
// it is and collects the runner's configuration and the script that starts
// its containers (ServeHTTP). Its runs are what containers are on a worker.
type Relay struct {
	s *Service
	// PublicURL returns the address under which GitHub reaches CI-Plane,
	// or "" while there is none (no tunnel, or it is down).
	PublicURL func() string
	// Script returns the shell script that starts the containers of a
	// runner, the same one a worker gets. It reads the runner's
	// configuration as the first line of its input.
	Script func(engine.RunnerSpec) string

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
	At          int64  `json:"at"`        // when the workflow was dispatched, Unix ms
	Machine     string `json:"machine"`   // runs-on label of the machine it was dispatched for
	Hosted      bool   `json:"hosted"`    // the machine must be one of GitHub's own
	Image       string `json:"image"`     // of the runner
	DindImage   string `json:"dindImage"` // of its Docker daemon
	RepoID      int64  `json:"repoId"`    // the repository of the pool it was dispatched in
	Repo        string `json:"repo"`
	CollectedBy string `json:"collectedBy"` // run id that collected it
	CollectedAt int64  `json:"collectedAt"`
}

// relayRepo is a repository with its account, as CI-Plane knows them.
type relayRepo struct {
	model.Repo
	account model.Account
}

// find looks a repository up among those the apps are installed on: by
// id, or by name if id is 0. Its errors say what the person has to do.
func (r *Relay) find(id int64, name string) (relayRepo, error) {
	var out relayRepo
	err := r.s.st.View(func(tx *store.Tx) error {
		repos, err := tx.Repos(0)
		if err != nil {
			return err
		}
		for _, p := range repos {
			if (id != 0 && p.ID == id) || (id == 0 && strings.EqualFold(p.FullName, name)) {
				out.Repo = p
				break
			}
		}
		if out.ID == 0 {
			if name == "" {
				return errors.New("CI-Plane does not see this repository any more: install the GitHub App on it again")
			}
			return fmt.Errorf("CI-Plane does not see the repository %s any more: install the GitHub App of %s on it", name, ownerOf(name))
		}
		if out.account, err = tx.Account(out.AccountID); err != nil {
			return fmt.Errorf("the account of %s is not connected: %w", out.FullName, err)
		}
		if out.account.InstallationID == 0 {
			return fmt.Errorf("the GitHub App of %s is not installed any more; install it again under Repositories", out.account.Owner)
		}
		return nil
	})
	return out, err
}

// repo is the repository of a pool, checked for starting runners in it.
func (r *Relay) repo(name string) (relayRepo, error) {
	if name == "" {
		return relayRepo{}, errors.New("the pool has no repository; choose one on the Workers page")
	}
	rr, err := r.find(0, name)
	if err != nil {
		return rr, err
	}
	if !rr.Private {
		return rr, fmt.Errorf("the repository %s is public; use a private one for a pool, because its runs show the names of your runners", rr.FullName)
	}
	return rr, nil
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
		return "", fmt.Errorf("the repository %s has no default branch; push the relay workflow to it first", rr.FullName)
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
	rr, err := r.repo(spec.Repo)
	if err != nil {
		return err
	}
	if spec.Machine == "" {
		return errors.New("the pool has no machine for a job of this size; enter one on the Workers page")
	}
	base := ""
	if r.PublicURL != nil {
		base = strings.TrimRight(r.PublicURL(), "/")
	}
	if !strings.HasPrefix(base, "https://") {
		return passingErr{errors.New("the Cloudflare tunnel is not connected, so the relay workflow could not reach CI-Plane; check it under Settings")}
	}
	// A run left of an earlier start of this runner is stopped first.
	if old, ok := r.pending(spec.Name); ok {
		if err := r.stop(ctx, rr, spec.Name, time.UnixMilli(old.At), false); err != nil {
			return err
		}
	}
	branch, err := r.defaultBranch(ctx, rr)
	if err != nil {
		return err
	}
	now := r.s.now()
	b, _ := json.Marshal(relayPending{JITConfig: spec.JITConfig, At: now.UnixMilli(), Machine: spec.Machine, Hosted: spec.GitHubHosted,
		Image: spec.Image, DindImage: spec.DindImage, RepoID: rr.ID, Repo: rr.FullName})
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
		body: map[string]any{"ref": branch, "inputs": map[string]string{"runner": spec.Name, "url": base, "machine": spec.Machine}},
	})
	if err != nil {
		r.drop(spec.Name)
		switch statusOf(err) {
		case http.StatusNotFound:
			return fmt.Errorf("the relay workflow .github/workflows/%s is not on the branch %s of %s: add it as the pool shows on the Workers page", model.RelayWorkflow, branch, rr.FullName)
		case http.StatusUnprocessableEntity:
			return fmt.Errorf("GitHub did not start the relay workflow in %s: %w. Replace the workflow with the one the pool shows on the Workers page", rr.FullName, err)
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
	p, ok := r.pending(name)
	if !ok {
		// Never dispatched, removed already, or a run nobody knows: look
		// for it where the pools run theirs.
		return r.stopAnywhere(ctx, name)
	}
	rr, err := r.find(p.RepoID, p.Repo)
	if err != nil {
		// Neither repository is known any more: there is no run CI-Plane
		// could stop. The runner's registration is gone, so a run that
		// still starts has nothing to run, and it stops by itself.
		r.drop(name)
		return nil
	}
	if err := r.stop(ctx, rr, name, time.UnixMilli(p.At), true); err != nil {
		return err
	}
	r.drop(name)
	r.mu.Lock()
	delete(r.recent, name)
	r.mu.Unlock()
	return nil
}

// stopAnywhere cancels the runs of a name in the repositories of all pools.
func (r *Relay) stopAnywhere(ctx context.Context, name string) error {
	var pools []model.Pool
	if err := r.s.st.View(func(tx *store.Tx) error {
		var err error
		pools, err = tx.Pools()
		return err
	}); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, p := range pools {
		key := strings.ToLower(p.Repo)
		if p.Repo == "" || seen[key] {
			continue
		}
		seen[key] = true
		rr, err := r.find(0, p.Repo)
		if err != nil {
			continue
		}
		if err := r.stop(ctx, rr, name, r.s.now().Add(-relayWindow), false); err != nil {
			return err
		}
	}
	return nil
}

// stop cancels the runs of a runner since a time that have not ended. With
// wait, a run dispatched at since that GitHub does not list yet makes stop
// fail, so that it is tried again: such a run cannot be cancelled yet.
func (r *Relay) stop(ctx context.Context, rr relayRepo, name string, since time.Time, wait bool) error {
	runs, err := r.runs(ctx, rr, since)
	if errors.Is(err, errNoWorkflow) {
		return nil // without the workflow there is no run of it
	}
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
		if !run.created().Before(since.Add(-time.Minute)) {
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
	if wait && !seen && r.s.now().Sub(since) < relayRecent {
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
func (r *Relay) runs(ctx context.Context, rr relayRepo, from time.Time) ([]relayRun, error) {
	wf, err := r.workflowPath(rr.FullName)
	if err != nil {
		return nil, err
	}
	since := r.s.now().Add(-relayWindow)
	// Only runs since the oldest runner that is still there, rounded down to
	// the hour: the address stays the same between listings, so an
	// unchanged answer costs nothing of the rate limit, and the listing
	// stays short in a repository with many runs.
	if !from.IsZero() && from.After(since) {
		since = from.Add(-2 * time.Minute).Truncate(time.Hour)
	}
	created := ">=" + since.UTC().Format("2006-01-02T15:04:05Z")
	r.s.dropConditional(rr.AccountID, wf+"/runs?", "created="+url.QueryEscape(created))
	var all []relayRun
	for page := 1; page <= 20; page++ {
		var out struct {
			Runs []relayRun `json:"workflow_runs"`
		}
		q := url.Values{"event": {"workflow_dispatch"}, "per_page": {"100"}, "page": {strconv.Itoa(page)}, "created": {created}}
		_, err := r.s.getJSON(ctx, call{method: http.MethodGet, path: wf + "/runs?" + q.Encode(), auth: authInstallation, account: rr.AccountID, conditional: true}, &out)
		if err != nil {
			if statusOf(err) == http.StatusNotFound {
				return nil, fmt.Errorf("%w: .github/workflows/%s is not in %s", errNoWorkflow, model.RelayWorkflow, rr.FullName)
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
	// The repositories with runners of the relay: those of the runners
	// that were dispatched and not removed yet.
	type group struct {
		id     int64
		name   string
		oldest int64 // the earliest dispatch, Unix ms
		names  []string
	}
	groups := map[string]*group{}
	var keys []string
	if err := r.s.st.View(func(tx *store.Tx) error {
		var err error
		keys, err = tx.Keys("secret:" + pendingName(""))
		return err
	}); err != nil {
		return nil, err
	}
	for _, k := range keys {
		name := strings.TrimPrefix(k, "secret:"+pendingName(""))
		p, ok := r.pending(name)
		if !ok {
			continue
		}
		key := strings.ToLower(p.Repo)
		if p.RepoID != 0 {
			key = strconv.FormatInt(p.RepoID, 10)
		}
		g := groups[key]
		if g == nil {
			g = &group{id: p.RepoID, name: p.Repo, oldest: p.At}
			groups[key] = g
		}
		g.oldest = min(g.oldest, p.At)
		g.names = append(g.names, name)
	}
	var runs []relayRun
	unknown := map[string]bool{} // runners whose runs cannot be seen right now
	for _, g := range groups {
		rr, err := r.find(g.id, g.name)
		var more []relayRun
		if err == nil {
			more, err = r.runs(ctx, rr, time.UnixMilli(g.oldest))
		}
		if err != nil {
			// One repository that cannot be asked must neither hide the
			// runs of the others nor have its own runners judged gone:
			// their state is unknown, and they end like any runner whose
			// job is over, or by the timeouts of the engine.
			r.s.logf("relay: runs of %s: %v", g.name, err)
			for _, n := range g.names {
				unknown[n] = true
			}
			continue
		}
		runs = append(runs, more...)
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
	for n := range unknown {
		by[n] = engine.Container{Runner: n, Running: true}
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

// Check says what keeps a pool with that repository from working, in words
// for the person, and where the relay workflow can be added if it is
// missing.
func (r *Relay) Check(ctx context.Context, repo string) api.RelayCheck {
	out := api.RelayCheck{Problems: []string{}}
	if r.PublicURL == nil || !strings.HasPrefix(r.PublicURL(), "https://") {
		out.Problems = append(out.Problems, "The Cloudflare tunnel is not set up or not connected, so the relay workflow could not reach CI-Plane. Check it under Settings.")
	}
	rr, err := r.repo(repo)
	if err != nil {
		out.Problems = append(out.Problems, upper(err.Error())+".")
		return out
	}
	// The app must be allowed to start workflows; apps created by early
	// versions of CI-Plane may only read Actions.
	var inst struct {
		Permissions map[string]string `json:"permissions"`
	}
	ip, _ := repoPath(rr.FullName)
	if _, err := r.s.getJSON(ctx, call{method: http.MethodGet, path: ip + "/installation", auth: authApp, account: rr.AccountID}, &inst); err == nil && inst.Permissions["actions"] != "write" {
		out.Problems = append(out.Problems, fmt.Sprintf("The GitHub App of %s may not start workflows. Give it \"Actions: Read and write\" at %s and accept the new permission on its installation.", rr.account.Owner, appPermissionsURL(rr.account)))
	}
	wf, err := r.workflowPath(rr.FullName)
	if err != nil {
		out.Problems = append(out.Problems, upper(err.Error())+".")
		return out
	}
	var info struct {
		State string `json:"state"`
	}
	_, err = r.s.getJSON(ctx, call{method: http.MethodGet, path: wf, auth: authInstallation, account: rr.AccountID}, &info)
	switch {
	case statusOf(err) == http.StatusNotFound:
		out.Problems = append(out.Problems, fmt.Sprintf("The relay workflow is not in %s. Add it as .github/workflows/%s on the default branch.", rr.FullName, model.RelayWorkflow))
		if branch, err := r.defaultBranch(ctx, rr); err == nil {
			segs := strings.Split(branch, "/")
			for i := range segs {
				segs[i] = url.PathEscape(segs[i])
			}
			out.AddURL = r.s.WebURL + "/" + rr.FullName + "/new/" + strings.Join(segs, "/") + "?" + url.Values{
				"filename": {".github/workflows/" + model.RelayWorkflow}, "value": {workflowBody()},
			}.Encode()
		}
	case err != nil:
		out.Problems = append(out.Problems, "GitHub could not be asked about the relay workflow: "+err.Error()+".")
	case info.State != "active":
		out.Problems = append(out.Problems, fmt.Sprintf("The relay workflow in %s is disabled (%s). Enable it under Actions in the repository.", rr.FullName, info.State))
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

// workflowBody is the relay workflow without its leading comment, short
// enough to travel in an address.
func workflowBody() string {
	lines := strings.SplitAfter(RelayWorkflowYAML, "\n")
	i := 0
	for i < len(lines) && strings.HasPrefix(lines[i], "#") {
		i++
	}
	return strings.Join(lines[i:], "")
}

// Workflow returns the relay workflow.
func (r *Relay) Workflow() string { return RelayWorkflowYAML }

// ServeHTTP hands the configuration of its runner to a run of the relay
// workflow: POST with the run's OIDC token as bearer token. It is reachable
// from the internet, so it trusts nothing but the token: it must come from
// the relay workflow on the default branch of the repository the runner was
// started for, started by its GitHub App, and the run's title names the
// runner. Only that run
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
	// The token must be made for this address: a token a run made for
	// another address (given to it by a changed workflow) is no good here.
	base := ""
	if r.PublicURL != nil {
		base = strings.TrimRight(r.PublicURL(), "/")
	}
	if base == "" {
		fail(http.StatusServiceUnavailable, "CI-Plane does not know its public address right now; try again")
		return
	}
	claims, err := r.oidc.verify(ctx, strings.TrimSpace(token), base)
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
	// Anybody can show a token of some repository: say nothing about ours.
	repoID, _ := strconv.ParseInt(claims.RepositoryID, 10, 64)
	rr, err := r.find(repoID, "")
	if repoID == 0 || err != nil {
		r.s.logf("relay: run %s of %s (%s) asked for a runner: %v", claims.RunID, claims.Repository, claims.RepositoryID, err)
		fail(http.StatusForbidden, "CI-Plane hands out no runners to this repository")
		return
	}
	if !strings.EqualFold(claims.Repository, rr.FullName) {
		r.s.logf("relay: refused a token of %s (%s)", claims.Repository, claims.RepositoryID)
		fail(http.StatusForbidden, "CI-Plane hands out no runners to this repository")
		return
	}
	branch, err := r.defaultBranch(ctx, rr)
	if err != nil {
		r.s.logf("relay: default branch of %s: %v", rr.FullName, err)
		fail(http.StatusServiceUnavailable, "CI-Plane cannot ask GitHub about the repository right now; try again")
		return
	}
	switch {
	case !strings.EqualFold(claims.WorkflowRef, rr.FullName+"/.github/workflows/"+model.RelayWorkflow+"@refs/heads/"+branch):
		fail(http.StatusForbidden, "only the workflow "+model.RelayWorkflow+" on the branch "+branch+" may collect runners")
		return
	case claims.EventName != "workflow_dispatch" || !strings.EqualFold(claims.Actor, rr.account.Slug+"[bot]"):
		fail(http.StatusForbidden, "only runs that CI-Plane started may collect runners")
		return
	case !slices.Contains(relayRunnerRefs, claims.JobWorkflowRef):
		r.s.logf("relay: refused a run of %s from %s", rr.FullName, claims.JobWorkflowRef)
		fail(http.StatusForbidden, "only the relay runner workflow of CI-Plane may collect runners; replace "+model.RelayWorkflow+" with the one CI-Plane shows")
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
	// The machine is an input of the run, so whoever may change the
	// calling workflow could name another one: the job must run on the
	// machine the runner was dispatched for.
	var jobs struct {
		Jobs []struct {
			Labels []string `json:"labels"`
		} `json:"jobs"`
	}
	if _, err := r.s.getJSON(ctx, call{method: http.MethodGet, path: p + "/actions/runs/" + url.PathEscape(claims.RunID) + "/jobs?per_page=30", auth: authInstallation, account: rr.AccountID}, &jobs); err != nil {
		r.s.logf("relay: jobs of run %s of %s: %v", claims.RunID, rr.FullName, err)
		fail(http.StatusServiceUnavailable, "CI-Plane cannot ask GitHub about this run right now; try again")
		return
	}
	now := r.s.now()
	// A re-run of the run (by a person, with the same run id) is another
	// attempt and gets nothing.
	by := claims.RunID + "/" + claims.RunAttempt
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
		case cfg.RepoID != rr.ID && !(cfg.RepoID == 0 && strings.EqualFold(cfg.Repo, rr.FullName)):
			return store.ErrNotFound // a runner of another repository
		case !onMachine(jobs.Jobs, cfg.Machine) || (cfg.Hosted && claims.RunnerEnvironment != "github-hosted"):
			return errMachine
		case cfg.CollectedBy == by && now.UnixMilli()-cfg.CollectedAt < relayRecollect.Milliseconds():
			return nil // the same run again: its first answer was lost
		case cfg.CollectedBy != "" || cfg.JITConfig == "":
			return store.ErrNotFound
		case !run.created().IsZero() && run.created().UnixMilli() < cfg.At-5*60_000:
			// Older than the dispatch: not the run CI-Plane started, but a
			// re-run of an earlier one, for instance.
			return errStale
		}
		cfg.CollectedBy, cfg.CollectedAt = by, now.UnixMilli()
		b, _ = json.Marshal(cfg)
		return r.s.box.Put(tx, pendingName(name), b)
	})
	switch {
	case errors.Is(err, store.ErrNotFound):
		fail(http.StatusNotFound, "no runner waits for this run: it was handed out already, or CI-Plane gave it up")
		return
	case errors.Is(err, errMachine):
		r.s.logf("relay: run %s of %s does not run on %s", claims.RunID, rr.FullName, cfg.Machine)
		fail(http.StatusForbidden, "this run is not on the machine CI-Plane started it for")
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
	script := ""
	if r.Script != nil {
		script = r.Script(engine.RunnerSpec{Name: name, Image: cfg.Image, DindImage: cfg.DindImage})
	}
	_ = json.NewEncoder(w).Encode(map[string]string{"runner": name, "jitconfig": cfg.JITConfig, "script": script})
}

var (
	errStale      = errors.New("stale run")
	errMachine    = errors.New("another machine")
	errNoWorkflow = errors.New("the relay workflow is missing")
)

// onMachine reports whether the jobs of a run ask for the machine with that
// runs-on label and nothing else. A runner dispatched by an earlier
// version has no machine on record and passes.
func onMachine(jobs []struct {
	Labels []string `json:"labels"`
}, machine string) bool {
	if machine == "" {
		return true
	}
	if len(jobs) == 0 {
		return false
	}
	for _, j := range jobs {
		if len(j.Labels) != 1 || j.Labels[0] != machine {
			return false
		}
	}
	return true
}
