// Package sim is a small world without GitHub and without servers: it
// implements engine.Forge and engine.Fleet in memory. Tests drive it step by
// step and inject failures; the demo mode lets it run by itself.
package sim

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
)

type runner struct {
	id     int64
	name   string
	labels []string
	target engine.Target
	online bool
	jobID  int64 // 0 = idle
}

type job struct {
	ev    engine.JobEvent // Action is the state on "GitHub"
	steps int             // steps left once it runs
	total int             // steps it runs in all
}

type container struct {
	running  bool
	exitCode int
}

// World is the simulated GitHub and the simulated workers.
type World struct {
	mu         sync.Mutex
	nextID     int64
	runners    map[int64]*runner
	jobs       map[int64]*job
	containers map[int64]map[string]*container // by worker id, runner name
	status     map[int64]engine.WorkerStatus

	// Deliver receives webhooks. nil or DropWebhooks loses them.
	Deliver      func(engine.JobEvent)
	DropWebhooks bool

	// Failure injection. Counters count down with each failure.
	FailDelete   int            // DeleteRunner calls that fail
	FailList     int            // ListRunners calls that fail
	FailCreate   int            // CreateRunner calls that fail
	FailStart    map[int64]int  // Start calls that fail, by worker id
	FailRemove   map[int64]int  // Remove calls that fail, by worker id
	NeverConnect map[int64]bool // runners on these workers start but never come online
	FailProbe    map[int64]bool
	FailRerun    int                          // RerunJob calls that fail, as while the run is still going on
	Reruns       map[int64]int64              // the job that replaced a job that was run again
	FailJobs     bool                         // Job calls fail, as for an app that was uninstalled
	JobCalls     map[int64]int                // Job calls, by job id
	Starts       map[int64]int                // successful starts, by worker id
	Specs        map[string]engine.RunnerSpec // what each runner was started with, by name
}

// New creates an empty world.
func New() *World {
	return &World{
		nextID: 1000, runners: map[int64]*runner{}, jobs: map[int64]*job{},
		containers: map[int64]map[string]*container{}, status: map[int64]engine.WorkerStatus{},
		FailStart: map[int64]int{}, FailRemove: map[int64]int{}, NeverConnect: map[int64]bool{},
		FailProbe: map[int64]bool{}, Starts: map[int64]int{}, Specs: map[string]engine.RunnerSpec{}, Reruns: map[int64]int64{}, JobCalls: map[int64]int{},
	}
}

// --- control ---------------------------------------------------------------

// SetStatus sets the live view of a worker.
func (w *World) SetStatus(workerID int64, st engine.WorkerStatus) {
	w.mu.Lock()
	w.status[workerID] = st
	w.mu.Unlock()
}

// Connect marks a worker as connected with plenty of memory and disk.
func (w *World) Connect(workerID int64) {
	w.SetStatus(workerID, engine.WorkerStatus{Connected: true, At: 1, MemAvailMB: 1 << 20, MemTotalMB: 1 << 20, DiskFreeMB: 1 << 20, DiskMB: 1 << 20})
}

// SetLoad sets the measured CPU use of a connected worker, 0..100: the load
// of everything on the server, whether CI-Plane started it or not.
func (w *World) SetLoad(workerID int64, pct float64) {
	w.mu.Lock()
	st := w.status[workerID]
	st.CPUPct, st.CPUAvgPct = pct, pct
	w.status[workerID] = st
	w.mu.Unlock()
}

// Disconnect marks a worker as unreachable.
func (w *World) Disconnect(workerID int64) {
	w.SetStatus(workerID, engine.WorkerStatus{Error: "connection refused"})
}

// Queue adds a waiting job on "GitHub" and sends the webhook. steps is how
// many Steps it runs once a runner took it.
func (w *World) Queue(ev engine.JobEvent, steps int) {
	if steps < 1 {
		steps = 1
	}
	ev.Action = "queued"
	w.mu.Lock()
	if ev.RunAttempt == 0 {
		ev.RunAttempt = 1
	}
	w.jobs[ev.ID] = &job{ev: ev, steps: steps, total: steps}
	w.mu.Unlock()
	w.deliver(ev)
}

// Cancel ends a job that has not started.
func (w *World) Cancel(jobID int64) {
	w.mu.Lock()
	j, ok := w.jobs[jobID]
	if !ok || j.ev.Action != "queued" {
		w.mu.Unlock()
		return
	}
	j.ev.Action, j.ev.Conclusion = "completed", "cancelled"
	ev := j.ev
	w.mu.Unlock()
	w.deliver(ev)
}

func (w *World) deliver(ev engine.JobEvent) {
	if w.Deliver != nil && !w.DropWebhooks {
		w.Deliver(ev)
	}
}

func serves(r *runner, j *job) bool {
	if r.target.AccountID != j.ev.AccountID {
		return false
	}
	if r.target.Repo != "" && r.target.Repo != j.ev.Repo {
		return false
	}
	return model.Serves(r.labels, j.ev.Labels)
}

func (w *World) containerOf(name string) (*container, int64) {
	for wid, m := range w.containers {
		if c, ok := m[name]; ok {
			return c, wid
		}
	}
	return nil, 0
}

// Step advances the world like GitHub and the runners would: started
// runners come online, idle runners take the oldest job they may serve,
// running jobs get one step closer to their end. It returns whether anything
// happened.
func (w *World) Step() bool {
	var out []engine.JobEvent
	w.mu.Lock()
	changed := false

	ids := make([]int64, 0, len(w.runners))
	for id := range w.runners {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
	jobIDs := make([]int64, 0, len(w.jobs))
	for id := range w.jobs {
		jobIDs = append(jobIDs, id)
	}
	sort.Slice(jobIDs, func(a, b int) bool { return jobIDs[a] < jobIDs[b] })

	// Running jobs progress.
	for _, id := range jobIDs {
		j := w.jobs[id]
		if j.ev.Action != "in_progress" {
			continue
		}
		changed = true
		if j.steps--; j.steps > 0 {
			continue
		}
		j.ev.Action, j.ev.Conclusion = "completed", "success"
		out = append(out, j.ev)
		for rid, r := range w.runners {
			if r.jobID == id {
				if c, _ := w.containerOf(r.name); c != nil {
					c.running, c.exitCode = false, 0
				}
				delete(w.runners, rid) // ephemeral: gone after one job
			}
		}
	}
	// Idle runners take jobs.
	for _, rid := range ids {
		r, ok := w.runners[rid]
		if !ok || !r.online || r.jobID != 0 {
			continue
		}
		for _, id := range jobIDs {
			j := w.jobs[id]
			if j.ev.Action != "queued" || !serves(r, j) {
				continue
			}
			r.jobID = id
			j.ev.Action, j.ev.RunnerName = "in_progress", r.name
			out = append(out, j.ev)
			changed = true
			break
		}
	}
	// Started runners come online.
	for _, rid := range ids {
		r, ok := w.runners[rid]
		if !ok || r.online {
			continue
		}
		c, wid := w.containerOf(r.name)
		if c != nil && c.running && !w.NeverConnect[wid] {
			r.online, changed = true, true
		}
	}
	w.mu.Unlock()
	for _, ev := range out {
		w.deliver(ev)
	}
	return changed
}

// Take lets GitHub give a job to a specific runner, as it may do with any
// runner that has the job's labels.
func (w *World) Take(runnerName string, jobID int64) error {
	w.mu.Lock()
	var r *runner
	for _, c := range w.runners {
		if c.name == runnerName {
			r = c
		}
	}
	j := w.jobs[jobID]
	if r == nil || j == nil || !r.online || r.jobID != 0 || j.ev.Action != "queued" || !serves(r, j) {
		w.mu.Unlock()
		return fmt.Errorf("runner %s cannot take job %d", runnerName, jobID)
	}
	r.jobID = jobID
	j.ev.Action, j.ev.RunnerName = "in_progress", r.name
	ev := j.ev
	w.mu.Unlock()
	w.deliver(ev)
	return nil
}

// Kill stops the containers of a runner without removing them, as a crash
// of the runner would.
func (w *World) Kill(runnerName string, code int) {
	w.mu.Lock()
	if c, _ := w.containerOf(runnerName); c != nil {
		c.running, c.exitCode = false, code
	}
	w.mu.Unlock()
}

// Lose is what GitHub does some minutes after it last heard of a runner
// that ran a job: it fails the job and drops the runner. The containers
// stay as they are; whether they still exist is the worker's business.
func (w *World) Lose(runnerName string) {
	w.mu.Lock()
	var ev engine.JobEvent
	for rid, r := range w.runners {
		if r.name != runnerName {
			continue
		}
		if j, ok := w.jobs[r.jobID]; ok && j.ev.Action == "in_progress" {
			j.ev.Action, j.ev.Conclusion = "completed", "failure"
			ev = j.ev
		}
		delete(w.runners, rid)
	}
	w.mu.Unlock()
	if ev.ID != 0 {
		w.deliver(ev)
	}
}

// AddContainer puts a container on a worker that nobody asked for.
func (w *World) AddContainer(workerID int64, name string) {
	w.mu.Lock()
	if w.containers[workerID] == nil {
		w.containers[workerID] = map[string]*container{}
	}
	w.containers[workerID][name] = &container{running: true}
	w.mu.Unlock()
}

// AddRunner registers a runner on "GitHub" that nobody asked for.
func (w *World) AddRunner(t engine.Target, name string) int64 {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.nextID++
	w.runners[w.nextID] = &runner{id: w.nextID, name: name, target: t}
	return w.nextID
}

// Containers returns the names of the containers on a worker.
func (w *World) Containers(workerID int64) []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := []string{}
	for name := range w.containers[workerID] {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Registered returns the names of the runners registered on "GitHub".
func (w *World) Registered() []string {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := []string{}
	for _, r := range w.runners {
		out = append(out, r.name)
	}
	sort.Strings(out)
	return out
}

// JobState returns the state of a job on "GitHub".
func (w *World) JobState(id int64) string {
	w.mu.Lock()
	defer w.mu.Unlock()
	if j, ok := w.jobs[id]; ok {
		return j.ev.Action
	}
	return ""
}

// --- engine.Forge ----------------------------------------------------------

// CreateRunner implements engine.Forge.
func (w *World) CreateRunner(_ context.Context, t engine.Target, name string, labels []string) (engine.Registration, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.FailCreate > 0 {
		w.FailCreate--
		return engine.Registration{}, errors.New("simulated: GitHub answered 502")
	}
	for _, r := range w.runners {
		if r.name == name {
			return engine.Registration{}, engine.ErrRunnerExists
		}
	}
	w.nextID++
	w.runners[w.nextID] = &runner{id: w.nextID, name: name, labels: labels, target: t}
	return engine.Registration{ID: w.nextID, JITConfig: fmt.Sprintf("jit-%d", w.nextID)}, nil
}

// DeleteRunner implements engine.Forge.
func (w *World) DeleteRunner(_ context.Context, _ engine.Target, id int64) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	r, ok := w.runners[id]
	if !ok {
		return nil
	}
	if r.jobID != 0 {
		return engine.ErrRunnerBusy
	}
	if w.FailDelete > 0 {
		w.FailDelete--
		return errors.New("simulated: GitHub answered 403")
	}
	delete(w.runners, id)
	return nil
}

// ListRunners implements engine.Forge.
func (w *World) ListRunners(_ context.Context, t engine.Target) ([]engine.ForgeRunner, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.FailList > 0 {
		w.FailList--
		return nil, errors.New("simulated: GitHub answered 503")
	}
	out := []engine.ForgeRunner{}
	for _, r := range w.runners {
		if r.target == t {
			out = append(out, engine.ForgeRunner{ID: r.id, Name: r.name, Online: r.online, Busy: r.jobID != 0})
		}
	}
	return out, nil
}

// QueuedJobs implements engine.Forge.
func (w *World) QueuedJobs(_ context.Context, accountID int64, repo string) ([]engine.JobEvent, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	out := []engine.JobEvent{}
	for _, j := range w.jobs {
		if j.ev.Action == "queued" && j.ev.AccountID == accountID && j.ev.Repo == repo {
			out = append(out, j.ev)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	return out, nil
}

// Job implements engine.Forge.
func (w *World) Job(_ context.Context, _ int64, _ string, jobID int64) (engine.JobEvent, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.JobCalls[jobID]++
	if w.FailJobs {
		return engine.JobEvent{}, errors.New("simulated: GitHub answered 401: the app is not installed")
	}
	j, ok := w.jobs[jobID]
	if !ok {
		return engine.JobEvent{}, engine.ErrGone
	}
	return j.ev, nil
}

// RerunJob implements engine.Forge: the job comes back as a new job of the
// next attempt of its run.
func (w *World) RerunJob(_ context.Context, _ int64, _ string, _, jobID int64, _ int) error {
	w.mu.Lock()
	if w.FailRerun > 0 {
		w.FailRerun--
		w.mu.Unlock()
		return errors.New("simulated: GitHub answered 403: the workflow run containing this job is already running")
	}
	j, ok := w.jobs[jobID]
	if !ok {
		w.mu.Unlock()
		return engine.ErrGone
	}
	if j.ev.Action != "completed" {
		w.mu.Unlock()
		return errors.New("simulated: GitHub answered 403: the job is not completed")
	}
	if _, again := w.Reruns[jobID]; again {
		w.mu.Unlock()
		return nil
	}
	ev := j.ev
	ev.ID = jobID + 1_000_000
	ev.Action, ev.RunnerName, ev.Conclusion, ev.At = "queued", "", "", 0
	ev.RunAttempt = j.ev.RunAttempt + 1
	w.jobs[ev.ID] = &job{ev: ev, steps: j.total, total: j.total}
	w.Reruns[jobID] = ev.ID
	w.mu.Unlock()
	w.deliver(ev)
	return nil
}

// --- engine.Fleet ----------------------------------------------------------

// Start implements engine.Fleet.
func (w *World) Start(_ context.Context, wk model.Worker, spec engine.RunnerSpec) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.status[wk.ID].Connected {
		return errors.New("simulated: ssh: connection refused")
	}
	if w.FailStart[wk.ID] > 0 {
		w.FailStart[wk.ID]--
		return errors.New("simulated: docker: no space left on device")
	}
	if !strings.HasPrefix(spec.JITConfig, "jit-") {
		return errors.New("simulated: empty runner configuration")
	}
	if w.containers[wk.ID] == nil {
		w.containers[wk.ID] = map[string]*container{}
	}
	w.containers[wk.ID][spec.Name] = &container{running: true}
	w.Starts[wk.ID]++
	w.Specs[spec.Name] = spec
	return nil
}

// Remove implements engine.Fleet.
func (w *World) Remove(_ context.Context, wk model.Worker, name string) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.status[wk.ID].Connected {
		return errors.New("simulated: ssh: connection refused")
	}
	if w.FailRemove[wk.ID] > 0 {
		w.FailRemove[wk.ID]--
		return errors.New("simulated: docker daemon is not responding")
	}
	delete(w.containers[wk.ID], name)
	return nil
}

// List implements engine.Fleet.
func (w *World) List(_ context.Context, wk model.Worker) ([]engine.Container, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.status[wk.ID].Connected {
		return nil, errors.New("simulated: ssh: connection refused")
	}
	out := []engine.Container{}
	for name, c := range w.containers[wk.ID] {
		out = append(out, engine.Container{Runner: name, Running: c.running, ExitCode: c.exitCode})
	}
	return out, nil
}

// Status implements engine.Fleet.
func (w *World) Status(workerID int64) engine.WorkerStatus {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.status[workerID]
}

// Probe implements engine.Fleet.
func (w *World) Probe(_ context.Context, wk model.Worker) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.status[wk.ID].Connected || w.FailProbe[wk.ID] {
		return errors.New("simulated: test container failed")
	}
	return nil
}

var (
	_ engine.Forge = (*World)(nil)
	_ engine.Fleet = (*World)(nil)
)
