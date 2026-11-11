// Package model holds the domain types shared by every other package.
// Times are Unix milliseconds; zero means "not set".
package model

import (
	"sort"
	"strings"
)

// Job states.
const (
	JobQueued    = "queued"    // waiting for a runner
	JobAssigned  = "assigned"  // a runner is being started for it
	JobRunning   = "running"   // a runner took it
	JobCompleted = "completed" // finished on GitHub
	JobIgnored   = "ignored"   // labels do not match; Reason says why
)

// Runner states.
const (
	RunnerProvisioning = "provisioning" // registering at GitHub and starting containers
	RunnerStarting     = "starting"     // containers run, runner not online yet
	RunnerIdle         = "idle"         // online, waiting for a job
	RunnerBusy         = "busy"         // runs a job
	RunnerCleaning     = "cleaning"     // being removed from the worker and from GitHub
	RunnerRemoved      = "removed"      // gone; kept as history
)

// Worker states (derived by the engine; Enabled and Draining are set by the user).
const (
	WorkerSetup       = "setup"       // added, never connected
	WorkerOnline      = "online"      // connected and healthy
	WorkerUnreachable = "unreachable" // SSH connection lost
	WorkerUnhealthy   = "unhealthy"   // too many failed starts in a row
	WorkerDiskFull    = "disk-full"   // free disk under the threshold
)

// CPU priorities of a worker: how the runners on it compete for CPU with
// everything else on the server.
const (
	PriorityNormal     = "normal"     // like any other container
	PriorityLow        = "low"        // a quarter of the weight of everything else on the server
	PriorityBackground = "background" // only the CPU nothing else on the server wants
)

// CPUPriorities lists the priorities, highest first.
var CPUPriorities = []string{PriorityNormal, PriorityLow, PriorityBackground}

// ValidPriority reports whether p is one of CPUPriorities.
func ValidPriority(p string) bool {
	return p == PriorityNormal || p == PriorityLow || p == PriorityBackground
}

// CPUShares is the Docker --cpu-shares value of a priority; 0 leaves
// Docker's default (1024). The weight only matters while the CPUs are
// contended: it is never a limit.
func CPUShares(priority string) int {
	switch priority {
	case PriorityLow:
		return 256
	case PriorityBackground:
		return 2
	}
	return 0
}

// What happens to a job whose runner was lost while it ran (Job.Rerun).
const (
	RerunLost   = "lost"   // its runner disappeared; GitHub has not said yet how the job ended
	RerunCheck  = "check"  // GitHub failed it while its worker was unreachable: lost, or failed by itself?
	RerunWanted = "wanted" // GitHub failed it because of that: ask GitHub to run it again
	RerunDone   = "done"   // GitHub runs it again, as a new job
	RerunFailed = "failed" // GitHub could not be made to run it again
)

// MaxRunAttempts is how often a job is run at most when its worker is lost
// again and again: the first run and two more.
const MaxRunAttempts = 3

// Event levels.
const (
	LevelInfo  = "info"
	LevelWarn  = "warn"
	LevelError = "error"
)

// Account is one GitHub App, owned by and installed on one user or organisation.
type Account struct {
	ID             int64  `json:"id"` // GitHub App id
	Slug           string `json:"slug"`
	Owner          string `json:"owner"`
	OwnerType      string `json:"ownerType"` // "User" or "Organization"
	HTMLURL        string `json:"htmlUrl"`
	InstallationID int64  `json:"installationId"` // 0 until the app is installed
	Enabled        bool   `json:"enabled"`
	MaxParallel    int    `json:"maxParallel"` // 0 = unlimited
	CreatedAt      int64  `json:"createdAt"`
}

// IsOrg reports whether runners are registered on the organisation.
func (a Account) IsOrg() bool { return a.OwnerType == "Organization" }

// Repo is a repository the app of an account is installed on.
type Repo struct {
	ID          int64  `json:"id"` // GitHub repository id
	AccountID   int64  `json:"accountId"`
	FullName    string `json:"fullName"` // owner/name
	Private     bool   `json:"private"`
	Enabled     bool   `json:"enabled"`
	MaxParallel int    `json:"maxParallel"` // 0 = unlimited
	LastJobAt   int64  `json:"lastJobAt"`
}

// NewRepo is a repository seen for the first time. A private one takes jobs
// at once. A public one is off until it is switched on: anyone can open a
// pull request against it, and its workflows would then run that person's
// code on the workers.
func NewRepo(id, accountID int64, fullName string, private bool) Repo {
	return Repo{ID: id, AccountID: accountID, FullName: fullName, Private: private, Enabled: private}
}

// Worker is a host that runs runners.
type Worker struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	User        string `json:"user"`
	HostKey     string `json:"hostKey"` // authorized_keys format, pinned at first contact
	Tier        int    `json:"tier"`    // 1 is filled first
	Position    int    `json:"position"`
	Enabled     bool   `json:"enabled"`
	Draining    bool   `json:"draining"`
	CPUPriority string `json:"cpuPriority"` // one of CPUPriorities
	State       string `json:"state"`
	StateReason string `json:"stateReason"`
	CPUs        int    `json:"cpus"`
	MemMB       int    `json:"memMb"`
	DiskMB      int    `json:"diskMb"`
	Docker      string `json:"docker"` // Docker version
	Failures    int    `json:"failures"`
	LastSeenAt  int64  `json:"lastSeenAt"`
	CreatedAt   int64  `json:"createdAt"`
}

// Job is a workflow job seen on GitHub.
type Job struct {
	ID           int64    `json:"id"` // GitHub job id
	RunID        int64    `json:"runId"`
	AccountID    int64    `json:"accountId"`
	RepoID       int64    `json:"repoId"`
	Repo         string   `json:"repo"` // owner/name
	Name         string   `json:"name"`
	Workflow     string   `json:"workflow"`
	Branch       string   `json:"branch"`
	HTMLURL      string   `json:"htmlUrl"`
	Labels       []string `json:"labels"`
	Size         string   `json:"size"`
	State        string   `json:"state"`
	Reason       string   `json:"reason"`
	Conclusion   string   `json:"conclusion"`
	RunnerID     string   `json:"runnerId"` // designated or bound runner
	Attempts     int      `json:"attempts"`
	NextTryAt    int64    `json:"nextTryAt"`
	AvoidWorker  int64    `json:"avoidWorker"` // worker of the last failed start
	QueuedAt     int64    `json:"queuedAt"`
	StartedAt    int64    `json:"startedAt"`
	CompletedAt  int64    `json:"completedAt"`
	UpdatedAt    int64    `json:"updatedAt"`
	WaitingSince int64    `json:"waitingSince"` // when it last became queued in CI-Plane
	RunAttempt   int      `json:"runAttempt"`   // attempt of its run on GitHub; 0 = not known
	Rerun        string   `json:"rerun"`        // one of the Rerun constants, or empty
}

// Runner is one ephemeral runner on a worker.
type Runner struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"` // name on GitHub and prefix of its containers
	WorkerID  int64    `json:"workerId"`
	AccountID int64    `json:"accountId"`
	RepoID    int64    `json:"repoId"`
	Repo      string   `json:"repo"`
	JobID     int64    `json:"jobId"`   // job it serves (designated, later bound); 0 = none
	ForgeID   int64    `json:"forgeId"` // runner id on GitHub; 0 = not registered
	Labels    []string `json:"labels"`
	Size      string   `json:"size"`
	CPUs      float64  `json:"cpus"`  // free CPUs its size asked for; held until its real load shows
	MemMB     int      `json:"memMb"` // reserved, and the limit of its containers
	State     string   `json:"state"`
	Error     string   `json:"error"`
	Failed    bool     `json:"failed"` // the start failed (as opposed to a normal end)
	CreatedAt int64    `json:"createdAt"`
	StartedAt int64    `json:"startedAt"` // containers started
	OnlineAt  int64    `json:"onlineAt"`
	BusyAt    int64    `json:"busyAt"`
	SpareAt   int64    `json:"spareAt"` // since when it has no job to serve
	EndedAt   int64    `json:"endedAt"` // cleaning began
	RemovedAt int64    `json:"removedAt"`
}

// Active reports whether the runner still holds capacity on its worker.
func (r Runner) Active() bool { return r.State != RunnerRemoved }

// Waiting reports whether the runner could still take a job.
func (r Runner) Waiting() bool {
	return r.State == RunnerProvisioning || r.State == RunnerStarting || r.State == RunnerIdle
}

// Event is one line of a timeline.
type Event struct {
	ID       int64  `json:"id"`
	At       int64  `json:"at"`
	Level    string `json:"level"`
	Kind     string `json:"kind"`
	Message  string `json:"message"`
	JobID    int64  `json:"jobId,omitempty"`
	RunnerID string `json:"runnerId,omitempty"`
	WorkerID int64  `json:"workerId,omitempty"`
}

// The two sizes. A job is standard unless its runs-on names the large one.
const (
	SizeStandard = "standard"
	SizeLarge    = "large"
)

// Size is what a job of that size needs on a worker: CPUs that must be free
// for it to start there (never a limit), and memory that is reserved for it
// and is the limit of its containers. On a pool it chooses the machine.
type Size struct {
	Name  string  `json:"name"`
	CPUs  float64 `json:"cpus"`
	MemMB int     `json:"memMb"`
	// Aliases are other labels that mean this size, kept so that workflows
	// written for earlier versions (size-s, size-m, ...) keep running.
	Aliases []string `json:"aliases,omitempty"`
}

// Is reports whether a label means this size.
func (z Size) Is(label string) bool {
	if z.Name == label {
		return true
	}
	for _, a := range z.Aliases {
		if a == label {
			return true
		}
	}
	return false
}

// Settings are the values editable in the interface.
type Settings struct {
	BaseLabel        string `json:"baseLabel"`
	Sizes            []Size `json:"sizes"` // standard and large
	DefaultSize      string `json:"defaultSize"`
	RunnerImage      string `json:"runnerImage"`
	DindImage        string `json:"dindImage"`
	MirrorImage      string `json:"mirrorImage"`
	ReservePct       int    `json:"reservePct"`       // share of CPU and memory kept for the system
	CPUSettleSec     int    `json:"cpuSettleSec"`     // a new runner holds its CPUs until it worked this long
	ReserveMemMB     int    `json:"reserveMemMb"`     // memory kept for the system on top
	MinDiskFreeMB    int    `json:"minDiskFreeMb"`    // below: worker is disk-full
	MirrorCapMB      int    `json:"mirrorCapMb"`      // registry mirror is emptied above
	StartTimeoutSec  int    `json:"startTimeoutSec"`  // runner must be online within
	IdleTimeoutSec   int    `json:"idleTimeoutSec"`   // idle runner is removed after
	SpareGraceSec    int    `json:"spareGraceSec"`    // runner without a job to serve is removed after
	JobTimeoutSec    int    `json:"jobTimeoutSec"`    // hard limit of a job
	FailureThreshold int    `json:"failureThreshold"` // failed starts in a row until unhealthy
	NoOvertakeSec    int    `json:"noOvertakeSec"`    // a job waiting this long is not overtaken
	HistoryDays      int    `json:"historyDays"`      // finished jobs and events are kept for
}

// DefaultSettings returns the values of a fresh installation.
func DefaultSettings() Settings {
	return Settings{
		BaseLabel: "ci-plane",
		Sizes: []Size{
			{Name: SizeStandard, CPUs: 4, MemMB: 8192, Aliases: []string{"size-s", "size-m"}},
			{Name: SizeLarge, CPUs: 8, MemMB: 16384, Aliases: []string{"size-l", "size-xl"}},
		},
		DefaultSize:      SizeStandard,
		RunnerImage:      "ghcr.io/actions/actions-runner:latest",
		DindImage:        "docker:dind",
		MirrorImage:      "registry:2",
		ReservePct:       10,
		ReserveMemMB:     1024,
		CPUSettleSec:     120,
		MinDiskFreeMB:    15000,
		MirrorCapMB:      20000,
		StartTimeoutSec:  120,
		IdleTimeoutSec:   600,
		SpareGraceSec:    60,
		JobTimeoutSec:    6 * 3600,
		FailureThreshold: 3,
		NoOvertakeSec:    300,
		HistoryDays:      30,
	}
}

// TwoSizes turns the sizes of an earlier version, any number of them with
// names of the person's choice, into the two there are now. Standard is what
// the default size was; large is the largest one, so no job gets less memory
// than before. The old names stay as aliases of the size they became part
// of. It reports whether anything changed.
func (s Settings) TwoSizes() (Settings, bool) {
	if len(s.Sizes) == 2 && s.Sizes[0].Name == SizeStandard && s.Sizes[1].Name == SizeLarge && s.DefaultSize == SizeStandard {
		return s, false
	}
	def := DefaultSettings()
	std, large := def.Sizes[0], def.Sizes[1]
	std.Aliases, large.Aliases = nil, nil
	if len(s.Sizes) > 0 {
		base := s.Sizes[0]
		for _, z := range s.Sizes {
			if z.Is(s.DefaultSize) {
				base = z
			}
		}
		std.CPUs, std.MemMB = base.CPUs, base.MemMB
		large.CPUs, large.MemMB = base.CPUs*2, base.MemMB*2
		bigger := false
		for _, z := range s.Sizes {
			names := append([]string{z.Name}, z.Aliases...)
			if z.MemMB > base.MemMB || (z.MemMB == base.MemMB && z.CPUs > base.CPUs) {
				if !bigger || z.MemMB > large.MemMB {
					large.CPUs, large.MemMB = z.CPUs, z.MemMB
				}
				bigger = true
				large.Aliases = append(large.Aliases, names...)
			} else {
				std.Aliases = append(std.Aliases, names...)
			}
		}
	}
	drop := func(list []string) []string {
		var out []string
		for _, a := range list {
			if a != SizeStandard && a != SizeLarge {
				out = append(out, a)
			}
		}
		return out
	}
	std.Aliases, large.Aliases = drop(std.Aliases), drop(large.Aliases)
	s.Sizes, s.DefaultSize = []Size{std, large}, SizeStandard
	return s, true
}

// RelayWorkflow is the file name of the relay workflow, in .github/workflows
// of the relay repository of a pool.
const RelayWorkflow = "ci-plane-relay.yml"

// SizeByName returns the size that a name or an alias means.
func (s Settings) SizeByName(name string) (Size, bool) {
	for _, z := range s.Sizes {
		if z.Is(name) {
			return z, true
		}
	}
	return Size{}, false
}

// Match decides whether a job with these runs-on labels is handled. It
// returns the size name, or a reason why the job is ignored.
func (s Settings) Match(labels []string) (size string, reason string) {
	hasBase := false
	for _, raw := range labels {
		l := strings.ToLower(strings.TrimSpace(raw))
		switch {
		case l == strings.ToLower(s.BaseLabel):
			hasBase = true
		case l == "self-hosted" || l == "linux" || l == "x64":
		default:
			if z, ok := s.SizeByName(l); ok {
				if size != "" && size != z.Name {
					return "", "runs-on names two sizes: " + size + " and " + l
				}
				size = z.Name
				continue
			}
			return "", "unknown label \"" + raw + "\" in runs-on"
		}
	}
	if !hasBase {
		return "", "runs-on does not contain the label \"" + s.BaseLabel + "\""
	}
	if size == "" {
		size = s.DefaultSize
	}
	z, ok := s.SizeByName(size)
	if !ok {
		return "", "the default size \"" + size + "\" does not exist"
	}
	return z.Name, ""
}

// RunnerLabels are the labels a runner of that size registers with. GitHub
// gives a job to any idle runner that has all of the job's labels, so a job
// without a size label may land on a runner of any size.
func (s Settings) RunnerLabels(size string) []string {
	out := []string{"self-hosted", "linux", "x64", s.BaseLabel, size}
	if z, ok := s.SizeByName(size); ok {
		out = append(out[:4], z.Name)
		out = append(out, z.Aliases...)
	}
	return out
}

// LabelKey is a canonical form of a label set.
func LabelKey(labels []string) string {
	c := make([]string, 0, len(labels))
	for _, l := range labels {
		c = append(c, strings.ToLower(strings.TrimSpace(l)))
	}
	sort.Strings(c)
	return strings.Join(c, ",")
}

// Serves reports whether a runner with runnerLabels may take a job with
// jobLabels: GitHub requires every job label on the runner.
func Serves(runnerLabels, jobLabels []string) bool {
	have := map[string]bool{}
	for _, l := range runnerLabels {
		have[strings.ToLower(strings.TrimSpace(l))] = true
	}
	for _, l := range jobLabels {
		if !have[strings.ToLower(strings.TrimSpace(l))] {
			return false
		}
	}
	return true
}

// Pool kinds: who runs the machines of a pool. All of them run GitHub
// Actions jobs, so a pool differs from another only in the machine labels of
// its relay workflow; the kind is the preset the person started from.
const (
	PoolGitHub     = "github"     // GitHub-hosted runners, standard or larger
	PoolBlacksmith = "blacksmith" // Blacksmith runners
	PoolCustom     = "custom"     // any other provider with a runs-on label
)

// ValidPoolKind reports whether k is one of the pool kinds.
func ValidPoolKind(k string) bool { return k == PoolGitHub || k == PoolBlacksmith || k == PoolCustom }

// Pool is a source of runners that CI-Plane does not run itself: machines of
// GitHub or of another provider of GitHub Actions runners. CI-Plane starts a
// runner there by running the relay workflow in the pool's repository on a
// machine of the pool. To the scheduler a pool is one more worker with a
// tier: it is used when no worker or pool of a lower tier has room.
type Pool struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`     // one of the pool kinds
	Repo     string `json:"repo"`     // owner/name of the private repository with the relay workflow
	Tier     int    `json:"tier"`     // 1 is used first; workers of the same tier go first
	Position int    `json:"position"` // order inside a tier
	Enabled  bool   `json:"enabled"`
	AfterSec int    `json:"afterSec"` // only for jobs that have waited this long; 0 = at once
	Max      int    `json:"max"`      // runners at the same time
	Standard string `json:"standard"` // runs-on label of the machine for standard jobs
	Large    string `json:"large"`    // the same for large jobs; empty = they do not go here
	// BudgetMin is how many minutes of runner time the pool may use per
	// calendar month (UTC); 0 = no limit. CI-Plane counts them itself.
	BudgetMin int `json:"budgetMin"`

	// Kept by the engine.
	Month       string `json:"month"`       // the month UsedSec belongs to, like 2026-11
	UsedSec     int64  `json:"usedSec"`     // runner time used in Month by runners that are gone
	Fails       int    `json:"fails"`       // failed starts in a row
	PausedUntil int64  `json:"pausedUntil"` // no runner is started before; 0 = not paused
	PauseReason string `json:"pauseReason"` // why the last start failed
	CreatedAt   int64  `json:"createdAt"`
}

// WorkerID is the id the runners of the pool carry as their worker: pools
// share the numbers below zero, workers the ones above.
func (p Pool) WorkerID() int64 { return -p.ID }

// IsPool reports whether a worker id is that of a pool.
func IsPool(workerID int64) bool { return workerID < 0 }

// Machine is the runs-on label of the machine for a job of that size, or ""
// if the pool has none for it.
func (p Pool) Machine(size string) string {
	if size == SizeLarge {
		return p.Large
	}
	return p.Standard
}

// poolPauses are the waits after the first, second, ... failed start in a
// row on a pool. Short at first: most failures are a hiccup of the provider
// that is over in minutes. Long in the end: a pool that fails for hours
// (workflow removed, minutes used up) waits for the person or the next
// month, and trying twice a day costs nothing while it notices the fix.
var poolPauses = []int{60, 5 * 60, 15 * 60, 3600, 3 * 3600, 6 * 3600, 12 * 3600}

// PoolPauseSec is how long a pool pauses after its n-th failed start in a row.
func PoolPauseSec(n int) int {
	if n < 1 {
		return 0
	}
	if n > len(poolPauses) {
		n = len(poolPauses)
	}
	return poolPauses[n-1]
}
