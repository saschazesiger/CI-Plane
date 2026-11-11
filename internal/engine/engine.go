// Package engine is the heart of CI-Plane: it turns queued jobs into
// runners on workers and removes them again.
//
// It is level-triggered. Every pass (Tick) reads the state from the store,
// compares it with what should be, and takes the next small step for each
// runner. Every step is idempotent and its intent is stored before it is
// carried out, so a pass can be interrupted anywhere, even by a crash of the
// process, and the next pass continues.
//
// GitHub does not bind a runner to a job: a queued job goes to any idle
// runner that has all of its labels. The engine therefore designates a runner
// for each waiting job (Runner.JobID, Job.RunnerID) and corrects the pairing
// when GitHub reports which runner really took which job.
package engine

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// NamePrefix starts the name of every runner and container of CI-Plane. It
// is followed by the id of the installation, so two installations that share
// a worker or an organisation leave each other's runners alone.
const NamePrefix = "ci-plane-"

// Errors a Forge returns for the engine to act on.
var (
	ErrRunnerBusy   = errors.New("runner is running a job")
	ErrRunnerExists = errors.New("a runner with that name exists")
	ErrGone         = errors.New("does not exist on GitHub")
	// ErrThisRunner marks a refusal that concerns one runner or repository
	// (an archived repository, a bad label), not the account as a whole.
	ErrThisRunner = errors.New("GitHub refused this runner")
)

// How long things may take before the engine stops waiting for them.
const (
	// downGrace is how long a worker must be unreachable before what was
	// starting on it is given up, and before a job that failed on it counts
	// as lost with it. Shorter interruptions are a network that blinks.
	downGrace = 30 * time.Second
	// verdictAfter is how long a worker may stay away before a job that
	// GitHub failed meanwhile counts as lost with it. A worker that returns
	// earlier can say whether the runner had finished normally.
	verdictAfter = 5 * time.Minute
	// rerunWindow is how long GitHub is asked to run a lost job again. It
	// refuses while other jobs of the same run are still running.
	rerunWindow = 6 * time.Hour
	// queuedLimit is how long a job may wait on GitHub; GitHub itself gives
	// up a job no self-hosted runner took within a day.
	queuedLimit = 25 * time.Hour
	// silentLimit is how long a job that has no runner any more may stay
	// "running" while GitHub cannot be asked how it ended.
	silentLimit = time.Hour
)

// Target says where a runner is registered: on the organisation of an
// account (Repo empty) or on one repository.
type Target struct {
	AccountID int64
	Owner     string
	Repo      string // owner/name, or empty for the organisation
}

// Registration is a freshly registered just-in-time runner.
type Registration struct {
	ID        int64  // runner id on GitHub
	JITConfig string // passed to run.sh --jitconfig; valid for one job
}

// ForgeRunner is a runner as GitHub lists it.
type ForgeRunner struct {
	ID     int64
	Name   string
	Online bool
	Busy   bool
}

// JobEvent is a workflow job as reported by a webhook or by the API.
type JobEvent struct {
	Action     string // queued, in_progress, completed; others are ignored
	ID         int64
	RunID      int64
	AccountID  int64 // the GitHub App that reported it
	RepoID     int64
	Repo       string // owner/name
	Private    bool
	Name       string
	Workflow   string
	Branch     string
	HTMLURL    string
	Labels     []string
	RunnerName string // set from in_progress on
	Conclusion string // set on completed
	At         int64  // time of the state on GitHub, Unix ms; 0 = now
	RunAttempt int    // attempt of the run: 1, then 2 after a re-run; 0 = not known
}

// Forge is GitHub as the engine needs it. Implementations retry transient
// errors themselves; an error returned here means "try again later".
type Forge interface {
	// CreateRunner registers a just-in-time runner. ErrRunnerExists if the
	// name is taken.
	CreateRunner(ctx context.Context, t Target, name string, labels []string) (Registration, error)
	// DeleteRunner removes a runner registration. nil if it is already gone,
	// ErrRunnerBusy if it runs a job.
	DeleteRunner(ctx context.Context, t Target, id int64) error
	// ListRunners lists the runners registered on the target.
	ListRunners(ctx context.Context, t Target) ([]ForgeRunner, error)
	// QueuedJobs lists the jobs of a repository that wait for a runner.
	QueuedJobs(ctx context.Context, accountID int64, repo string) ([]JobEvent, error)
	// Job returns the current state of one job. ErrGone if it was deleted.
	Job(ctx context.Context, accountID int64, repo string, jobID int64) (JobEvent, error)
	// RerunJob asks GitHub to run a completed job of a run again; it then
	// appears as a new job. attempt is the attempt of the run the job
	// belongs to (0 = not known): if the run is past it, the job was run
	// again already and nil is returned, so the call can be repeated.
	// GitHub refuses while the run is still going on. ErrGone if the job
	// was deleted.
	RerunJob(ctx context.Context, accountID int64, repo string, runID, jobID int64, attempt int) error
}

// RunnerSpec is what a worker needs to start a runner.
type RunnerSpec struct {
	Name      string // also the prefix of every Docker object of the runner
	JITConfig string
	Image     string
	DindImage string
	MemMB     int // memory limit of each container; 0 = none
	// CPUPriority is one of model.CPUPriorities; empty means normal. CPU is
	// never limited: a job may use every CPU nobody else wants, and the
	// priority decides who gets it when the CPUs are contended.
	CPUPriority string
}

// Container is the runner container of one runner on a worker.
type Container struct {
	Runner   string // runner name
	Running  bool
	ExitCode int
}

// WorkerStatus is the live view of a worker.
type WorkerStatus struct {
	Connected  bool
	Error      string  // why it is not connected
	At         int64   // time of the values below; 0 = none yet
	Load1      float64 // load average over one minute
	CPUPct     float64 // CPU in use, 0..100, over the last few seconds
	CPUAvgPct  float64 // the same, smoothed over about a minute; 0 = not measured
	MemAvailMB int
	MemTotalMB int
	DiskFreeMB int
	DiskMB     int
}

// BusyCPUs is how many of n CPUs are in use by anything on the server: the
// higher of the current and the smoothed value, so that neither a short
// pause of a busy server nor load that has only just begun is missed.
func (st WorkerStatus) BusyCPUs(n int) float64 {
	if st.At == 0 {
		return 0
	}
	return float64(n) * min(max(st.CPUPct, st.CPUAvgPct, 0), 100) / 100
}

// Fleet is the set of workers as the engine needs it.
type Fleet interface {
	// Start starts the containers of a runner. It first removes anything
	// left under the same name, so it can be repeated.
	Start(ctx context.Context, w model.Worker, spec RunnerSpec) error
	// Remove removes every Docker object of a runner. nil if nothing is left.
	Remove(ctx context.Context, w model.Worker, runner string) error
	// List lists the runner containers on a worker, running or exited,
	// including ones the engine does not know.
	List(ctx context.Context, w model.Worker) ([]Container, error)
	// Status returns the live view of a worker; it never blocks.
	Status(workerID int64) WorkerStatus
	// Probe checks that the worker can run a container.
	Probe(ctx context.Context, w model.Worker) error
}

// Engine schedules and supervises runners.
type Engine struct {
	st     *store.Store
	forge  Forge
	fleet  Fleet
	prefix string // NamePrefix + installation id + "-"

	// OnChange, if set, is called after state changed (for live updates).
	OnChange func()
	// Logf, if set, receives diagnostics.
	Logf func(format string, args ...any)

	now  func() int64
	kick chan struct{}
	wg   sync.WaitGroup

	mu        sync.Mutex
	inflight  map[string]bool  // step running, by runner id or task name
	notBefore map[string]int64 // earliest next step, by runner id or task name
	fails     map[string]int   // consecutive failed steps, by runner id
	absent    map[string]int   // consecutive listings without its container, by runner id
	seen      map[int64]int64  // last time a worker's LastSeenAt was stored
	downSince map[int64]int64  // since when a worker is unreachable, by worker id
	silent    map[int64]int64  // since when GitHub cannot be asked about a job, by job id
	forgeErr  map[int64]string // why GitHub registers no runner for an account right now
	pressure  bool             // the last pass left a job waiting for room
}

// New creates an engine.
func New(st *store.Store, forge Forge, fleet Fleet) *Engine {
	var id string
	_ = st.Tx(func(tx *store.Tx) error {
		if b, err := tx.Get("instance"); err == nil && len(b) > 0 {
			id = string(b)
			return nil
		}
		id = newID()[:6]
		return tx.Set("instance", []byte(id))
	})
	return &Engine{
		prefix: NamePrefix + id + "-",
		st:     st, forge: forge, fleet: fleet,
		now:       store.Now,
		kick:      make(chan struct{}, 1),
		inflight:  map[string]bool{},
		notBefore: map[string]int64{},
		fails:     map[string]int{},
		absent:    map[string]int{},
		seen:      map[int64]int64{},
		downSince: map[int64]int64{},
		silent:    map[int64]int64{},
		forgeErr:  map[int64]string{},
	}
}

// Prefix starts the names of this installation's runners and containers.
func (e *Engine) Prefix() string { return e.prefix }

// SetClock replaces the clock, for tests.
func (e *Engine) SetClock(now func() int64) { e.now = now }

// Kick asks for a pass soon. It never blocks.
func (e *Engine) Kick() {
	select {
	case e.kick <- struct{}{}:
	default:
	}
}

// Run makes passes until ctx ends: after every Kick and at least every two
// seconds.
func (e *Engine) Run(ctx context.Context) {
	t := time.NewTicker(2 * time.Second)
	defer t.Stop()
	for {
		e.Tick(ctx)
		select {
		case <-ctx.Done():
			e.wg.Wait()
			return
		case <-e.kick:
		case <-t.C:
		}
	}
}

// Wait blocks until the steps started by earlier passes are done. Tests use
// it between passes.
func (e *Engine) Wait() { e.wg.Wait() }

func (e *Engine) logf(format string, args ...any) {
	if e.Logf != nil {
		e.Logf(format, args...)
	}
}

func (e *Engine) changed() {
	if e.OnChange != nil {
		e.OnChange()
	}
}

// begin claims a step; it reports false if the step runs already or is not
// due yet.
func (e *Engine) begin(key string) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.inflight[key] || e.notBefore[key] > e.now() {
		return false
	}
	e.inflight[key] = true
	return true
}

// end releases a step; the next one may start after delay.
func (e *Engine) end(key string, delay time.Duration) {
	e.mu.Lock()
	delete(e.inflight, key)
	if delay > 0 {
		e.notBefore[key] = e.now() + delay.Milliseconds()
	} else {
		delete(e.notBefore, key)
	}
	e.mu.Unlock()
	e.Kick()
}

// down reports whether a worker has been unreachable for longer than grace.
func (e *Engine) down(workerID int64, grace time.Duration) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	since, ok := e.downSince[workerID]
	return ok && e.now()-since >= grace.Milliseconds()
}

func accountKey(id int64) string { return "account:" + itoa(id) }

// forgeFailed notes that GitHub did not register a runner for an account
// (app suspended or uninstalled, an outage, the rate limit). Until the wait
// is over no runner is started for it: each would only fail the same way.
func (e *Engine) forgeFailed(accountID int64, err error) {
	key := accountKey(accountID)
	e.mu.Lock()
	e.fails[key]++
	e.notBefore[key] = e.now() + backoff(e.fails[key]).Milliseconds()
	e.forgeErr[accountID] = err.Error()
	e.mu.Unlock()
}

func (e *Engine) forgeWorks(accountID int64) {
	key := accountKey(accountID)
	e.mu.Lock()
	delete(e.fails, key)
	delete(e.notBefore, key)
	delete(e.forgeErr, accountID)
	e.mu.Unlock()
}

// forgeBlocked says why no runner is started for an account right now, or "".
func (e *Engine) forgeBlocked(accountID int64) string {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.notBefore[accountKey(accountID)] > e.now() {
		return e.forgeErr[accountID]
	}
	return ""
}

// forget drops the bookkeeping of a runner that is gone.
func (e *Engine) forget(id string) {
	e.mu.Lock()
	delete(e.notBefore, id)
	delete(e.fails, id)
	delete(e.absent, id)
	delete(e.fails, "retire:"+id)
	delete(e.fails, "adopt:"+id)
	delete(e.notBefore, "giveup:"+id)
	delete(e.fails, "forge:"+id)
	e.mu.Unlock()
}

// spawn runs a step in the background if it is due and not running.
func (e *Engine) spawn(ctx context.Context, key string, timeout time.Duration, step func(ctx context.Context) time.Duration) {
	if !e.begin(key) {
		return
	}
	e.wg.Add(1)
	go func() {
		defer e.wg.Done()
		c, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		delay := time.Duration(0)
		defer func() {
			if p := recover(); p != nil {
				e.logf("step %s panicked: %v", key, p)
				delay = 10 * time.Second
			}
			e.end(key, delay)
		}()
		delay = step(c)
	}()
}

// backoff is the wait before attempt n+1: 2 s, 4 s, ... up to 5 min.
func backoff(n int) time.Duration {
	if n < 1 {
		n = 1
	}
	d := 2 * time.Second
	for i := 1; i < n && d < 5*time.Minute; i++ {
		d *= 2
	}
	if d > 5*time.Minute {
		d = 5 * time.Minute
	}
	return d
}

// event stores a timeline entry inside a transaction.
func event(tx *store.Tx, level, kind, msg string, jobID int64, runnerID string, workerID int64) {
	_, _ = tx.AddEvent(model.Event{Level: level, Kind: kind, Message: msg, JobID: jobID, RunnerID: runnerID, WorkerID: workerID})
}

// targetOf says where the runners of a job in repo are registered.
func targetOf(a model.Account, repo string) Target {
	if a.IsOrg() {
		return Target{AccountID: a.ID, Owner: a.Owner}
	}
	return Target{AccountID: a.ID, Owner: a.Owner, Repo: repo}
}

// inScope reports whether a runner may be given jobs of a repository.
func inScope(a model.Account, r model.Runner, j model.Job) bool {
	if r.AccountID != j.AccountID {
		return false
	}
	return a.IsOrg() || r.RepoID == j.RepoID
}
