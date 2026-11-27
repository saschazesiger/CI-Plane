package engine

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// A pool is a source of runners that CI-Plane does not run itself: machines
// of GitHub, or of another provider of GitHub Actions runners. To start a
// runner there, CI-Plane registers it as usual and asks GitHub to run the
// relay workflow in the pool's repository on a machine of the pool. That
// workflow collects the runner's configuration from CI-Plane and starts the
// same containers a worker would. GitHub then gives the job to the runner
// like to any runner with the job's labels: the job's workflow does not
// change.
//
// To the engine a pool is one more worker (its id below zero, see
// model.Pool.WorkerID) with its own Hosts (Engine.Relay) and a tier. It has
// no CPUs to measure: it has room while fewer runners than its limit are on
// it, its budget of the month is not used up, and it is not pausing after
// failed starts.

// Hosts runs runners: the workers (a Fleet does) or the pools.
type Hosts interface {
	// Start starts a runner. It first removes anything left under the same
	// name, so it can be repeated.
	Start(ctx context.Context, w model.Worker, spec RunnerSpec) error
	// Remove removes everything of a runner. nil if nothing is left.
	Remove(ctx context.Context, w model.Worker, runner string) error
	// List lists the runners, running or ended, including ones the engine
	// does not know.
	List(ctx context.Context, w model.Worker) ([]Container, error)
	// Status returns the live view of a worker; it never blocks.
	Status(workerID int64) WorkerStatus
}

// Billing reads what GitHub bills for the Actions minutes of a pool.
type Billing interface {
	// PoolUsage reads the usage of a month (UTC). The error says what to do.
	PoolUsage(ctx context.Context, p model.Pool, year int, month time.Month) (model.PoolUsage, error)
}

// How often GitHub's billing is read. GitHub updates it a few times an
// hour at most, so more often would show nothing new.
const (
	usageEvery = 15 * time.Minute
	usageRetry = 5 * time.Minute
	// usageStale is how old the last reading may be before a budget that
	// rests on GitHub's billing stops the pool: long enough for an outage
	// of GitHub to pass, short enough not to run far past a budget.
	usageStale = 3 * time.Hour
)

// ErrPassing marks a failed start that says nothing about where it was
// tried: a rate limit, a network error, an error of GitHub's own. It is not
// counted against the host.
var ErrPassing = errors.New("a passing failure")

// poolStartLimit is how long a runner on a pool may take to come online.
// The provider may take minutes to hand out a machine, and the images of
// the runner are pulled on it first.
const poolStartLimit = 10 * time.Minute

// allPools stands for the pools as one host where their runs are compared
// with the runners: one listing covers the runs of all of them.
var allPools = model.Worker{ID: -1 << 62, Name: "pools"}

// poolRunLimit is how long a runner may live on a pool: a little less than
// the six hours after which the relay workflow ends its run.
const poolRunLimit = 350 * time.Minute

// poolWorker is the stand-in worker of a pool.
func poolWorker(p model.Pool) model.Worker {
	return model.Worker{ID: p.WorkerID(), Name: p.Name, Tier: p.Tier, Position: p.Position, Enabled: p.Enabled, State: model.WorkerOnline}
}

// sameHost reports whether a runner is on the host w stands for.
func sameHost(r model.Runner, w model.Worker) bool {
	if w.ID == allPools.ID {
		return model.IsPool(r.WorkerID)
	}
	return r.WorkerID == w.ID
}

// fleetOf returns what runs the runners of a worker.
func (e *Engine) fleetOf(workerID int64) Hosts {
	if !model.IsPool(workerID) {
		return e.fleet
	}
	if e.Relay == nil {
		return noRelay{}
	}
	return e.Relay
}

// workerOf reads a worker, or the stand-in of a pool.
func workerOf(tx *store.Tx, id int64) (model.Worker, error) {
	if !model.IsPool(id) {
		return tx.Worker(id)
	}
	p, err := tx.Pool(-id)
	if err != nil {
		return model.Worker{}, err
	}
	return poolWorker(p), nil
}

// poolRunners are the runners on a pool that are not gone.
func poolRunners(runners []model.Runner, p model.Pool) []model.Runner {
	var out []model.Runner
	for _, r := range runners {
		if r.WorkerID == p.WorkerID() && r.Active() {
			out = append(out, r)
		}
	}
	return out
}

// monthOf is the calendar month of a time, in UTC: budgets start anew with it.
func monthOf(ms int64) string { return time.UnixMilli(ms).UTC().Format("2006-01") }

// PoolMinutes is how many runner minutes a pool has used this month: the
// higher of CI-Plane's own count and GitHub's. GitHub's count lags by up
// to a few hours but also has what CI-Plane does not see, like the time a
// machine takes to start.
func PoolMinutes(p model.Pool, runners []model.Runner, now int64) float64 {
	own := float64(poolUsedSec(p, runners, now)) / 60
	if u := p.Usage; u.Month == monthOf(now) && u.At > 0 {
		return max(own, u.Minutes)
	}
	return own
}

// PoolSpent is what a pool has cost this month in US dollars: what GitHub
// bills for its relay repository, and, for the minutes CI-Plane counted
// that GitHub does not show yet, their price as GitHub listed it so far
// (before included minutes: better a little early than a little late).
func PoolSpent(p model.Pool, runners []model.Runner, now int64) float64 {
	u := p.Usage
	if u.Month != monthOf(now) || u.At == 0 {
		return 0
	}
	spent := u.NetUSD
	if own := float64(poolUsedSec(p, runners, now)) / 60; own > u.Minutes && u.Minutes > 0 {
		spent += (own - u.Minutes) * u.GrossUSD / u.Minutes
	}
	return spent
}

// PoolBudget says why the budget of a pool lets it take no jobs now, or ""
// if it does. A budget that rests on GitHub's billing also stops the pool
// while CI-Plane has no recent reading of it: better a pool that waits
// than a bill nobody wanted.
func PoolBudget(p model.Pool, runners []model.Runner, now int64) string {
	u := p.Usage
	if UsageMissing(p, now) {
		why := "it has not been read this month yet"
		if u.Error != "" {
			why = "CI-Plane cannot read it: " + strings.TrimRight(u.Error, ".")
		}
		return fmt.Sprintf("%s waits for its usage from GitHub, as its budget rests on it; %s", p.Name, why)
	}
	switch p.Budget() {
	case model.BudgetMinutes:
		if p.BudgetMin > 0 && PoolMinutes(p, runners, now) >= float64(p.BudgetMin) {
			return fmt.Sprintf("%s has used its %s of this month", p.Name, count(p.BudgetMin, "minute"))
		}
	case model.BudgetDollars:
		if spent := PoolSpent(p, runners, now); spent >= float64(p.BudgetUSD) {
			return fmt.Sprintf("%s has cost %s of its %s this month", p.Name, dollars(spent), dollars(float64(p.BudgetUSD)))
		}
	case model.BudgetFree:
		if u.AccountNetUSD >= 0.005 {
			owner, _, _ := strings.Cut(p.Repo, "/")
			return fmt.Sprintf("%s only uses included minutes, and those of %s are used up this month (%s billed)", p.Name, owner, dollars(u.AccountNetUSD))
		}
	case model.BudgetGitHub:
		for _, b := range u.Budgets {
			if b.UsedUp() {
				return fmt.Sprintf("%s follows the budgets on GitHub, and the budget of %s for %s is used up (%s of %s)",
					p.Name, b.Entity, b.SKU, dollars(b.ConsumedUSD), dollars(float64(b.AmountUSD)))
			}
		}
	}
	return ""
}

// UsageMissing reports whether a pool's budget rests on GitHub's billing
// and CI-Plane has no recent reading of it.
func UsageMissing(p model.Pool, now int64) bool {
	u := p.Usage
	return p.UsesBilling() && (u.Month != monthOf(now) || u.At == 0 || now-u.At > usageStale.Milliseconds())
}

// dollars says an amount of US dollars.
func dollars(v float64) string {
	if v == float64(int64(v)) {
		return fmt.Sprintf("$%d", int64(v))
	}
	return fmt.Sprintf("$%.2f", v)
}

// readUsage reads GitHub's billing of the pools of GitHub-hosted runners
// now and then, and at once for a pool that is new, was changed, or
// begins a month. A reading is only shown and compared: nothing on GitHub
// changes, so it needs no intent.
func (e *Engine) readUsage(ctx context.Context, s *snapshot) {
	if e.Billing == nil {
		return
	}
	month := monthOf(s.now)
	for _, p := range s.pools {
		if p.Kind != model.PoolGitHub || (p.AccountID == 0 && !p.UsesBilling()) {
			continue
		}
		// The key changes with what the reading depends on, so that a
		// changed pool and a new month are read at once.
		base := fmt.Sprintf("usage:%d:%d:%s:%s:%s", p.ID, p.AccountID, p.Repo, p.Budget(), month)
		key, fresh := base, p.Usage.At == 0 && p.Usage.Error == ""
		if fresh {
			key += ":new" // the reading was dropped, as when a token was entered
		}
		e.spawn(ctx, key, time.Minute, func(ctx context.Context) time.Duration {
			at := e.now()
			t := time.UnixMilli(at).UTC()
			u, err := e.Billing.PoolUsage(ctx, p, t.Year(), t.Month())
			e.saveUsage(p, u, err, at)
			next := usageEvery
			if err != nil {
				next = usageRetry
			}
			if !fresh {
				return next
			}
			// The next reading is the regular one; a reading that is
			// dropped again is due at once.
			e.mu.Lock()
			e.notBefore[base] = at + next.Milliseconds()
			e.mu.Unlock()
			return 0
		})
	}
}

// saveUsage stores a reading of a pool's usage, unless the pool changed
// meanwhile in what the reading depends on, and says when it changes
// whether the pool takes jobs.
func (e *Engine) saveUsage(read model.Pool, u model.PoolUsage, readErr error, at int64) {
	err := e.st.Tx(func(tx *store.Tx) error {
		p, err := tx.Pool(read.ID)
		if err != nil {
			return ignoreMissing(err)
		}
		if p.AccountID != read.AccountID || p.Repo != read.Repo || p.Budget() != read.Budget() {
			return nil
		}
		runners, err := tx.ActiveRunners()
		if err != nil {
			return err
		}
		// Only the budget itself is told: a missing reading has an event
		// of its own.
		before := ""
		if !UsageMissing(p, at) {
			before = PoolBudget(p, runners, at)
		}
		if readErr != nil {
			if p.Usage.Error == "" && p.UsesBilling() {
				event(tx, model.LevelWarn, "pool.usage", fmt.Sprintf("CI-Plane cannot read the usage of %s from GitHub: %s. "+
					"Its budget rests on it, so it takes no jobs once the last reading is %s old", p.Name, strings.TrimRight(readErr.Error(), "."), span(int(usageStale.Seconds()))), 0, "", p.WorkerID())
			}
			if p.Usage.FailingSince == 0 {
				p.Usage.FailingSince = at
			}
			p.Usage.Error = readErr.Error()
		} else {
			u.At, u.Error, u.FailingSince = at, "", 0
			p.Usage = u
		}
		after := ""
		if !UsageMissing(p, at) {
			after = PoolBudget(p, runners, at)
		}
		switch {
		case before == "" && after != "":
			event(tx, model.LevelWarn, "pool.budget", after+"; it takes jobs again next month, or when its budget allows it", 0, "", p.WorkerID())
		case before != "" && after == "":
			event(tx, model.LevelInfo, "pool.budget", p.Name+" takes jobs again: its budget allows it", 0, "", p.WorkerID())
		}
		return tx.SavePool(p)
	})
	if err != nil {
		e.logf("engine: usage of pool %d: %v", read.ID, err)
	}
	e.changed()
}

// poolUsedSec is the runner time a pool has used this month: what its
// finished runners took, and what the given ones on it have taken so far.
// Time counts from the moment a runner is online: one that never came
// online ran on no machine, or failed before it cost anything worth counting.
func poolUsedSec(p model.Pool, runners []model.Runner, now int64) int64 {
	used := int64(0)
	if p.Month == monthOf(now) {
		used = p.UsedSec
	}
	for _, r := range runners {
		if r.WorkerID == p.WorkerID() && r.Active() && r.OnlineAt > 0 && now > r.OnlineAt {
			used += (now - r.OnlineAt) / 1000
		}
	}
	return used
}

// pickPool chooses the pool for a job of size z: the first one in the order
// of tiers that has a machine for the size and room. If a worker was found
// (workerTier > 0), only a pool of a lower tier goes first; workers win
// inside a tier, because their capacity is there anyway. Without a pool,
// note says what the job waits for there, to be added to its reason.
func (s *snapshot) pickPool(j model.Job, z model.Size, active map[int64]int, workerTier int) (model.Pool, bool, string) {
	note := ""
	say := func(text string) {
		if note == "" {
			note = "; " + text
		}
	}
	var avoided *model.Pool
	for i, p := range s.pools {
		if !p.Enabled || p.Machine(z.Name) == "" {
			continue
		}
		if workerTier > 0 && p.Tier >= workerTier {
			break // ordered by tier: the worker goes first from here on
		}
		switch {
		case !s.status[p.WorkerID()].Connected:
			say(p.Name + " cannot be used while the Cloudflare tunnel is not connected")
		case p.PausedUntil > s.now:
			say(fmt.Sprintf("%s pauses until %s after %s", p.Name, clock(p.PausedUntil), failedStarts(p.Fails)))
		case PoolBudget(p, s.runners, s.now) != "":
			say(PoolBudget(p, s.runners, s.now))
		case active[p.ID] >= p.Max:
			say(inUse(p.Max, p.Name))
		case p.Fails > 0 && active[p.ID] > 0:
			// After failed starts one runner shows whether the pool works
			// again; the others wait for it instead of failing with it.
			say(p.Name + " is being tried again after " + failedStarts(p.Fails))
		case s.now-j.WaitingSince < int64(p.AfterSec)*1000:
			say(fmt.Sprintf("it goes to %s once it has waited %s", p.Name, span(p.AfterSec)))
		case j.AvoidWorker == p.WorkerID() && avoided == nil:
			// Its last start failed there: anything else goes first.
			avoided = &s.pools[i]
		default:
			return p, true, ""
		}
	}
	if avoided != nil && workerTier == 0 {
		return *avoided, true, ""
	}
	return model.Pool{}, false, note
}

// count says a number of things: 1 minute, 3 minutes.
func count(n int, thing string) string {
	if n == 1 {
		return "1 " + thing
	}
	return fmt.Sprintf("%d %ss", n, thing)
}

// inUse says that every runner of a pool is taken.
func inUse(n int, pool string) string {
	if n == 1 {
		return "the 1 runner of " + pool + " is in use"
	}
	return fmt.Sprintf("all %d runners of %s are in use", n, pool)
}

func failedStarts(n int) string {
	if n == 1 {
		return "a failed start"
	}
	return fmt.Sprintf("%d failed starts in a row", n)
}

// clock says a time of day in UTC.
func clock(ms int64) string { return time.UnixMilli(ms).UTC().Format("15:04 UTC") }

// span says a number of seconds in words.
func span(sec int) string {
	switch {
	case sec < 60 || sec%60 != 0 && sec < 600:
		return fmt.Sprintf("%d seconds", sec)
	case sec < 120:
		return "1 minute"
	case sec < 2*3600:
		return fmt.Sprintf("%d minutes", (sec+30)/60)
	}
	return fmt.Sprintf("%d hours", (sec+1800)/3600)
}

// poolFailed counts a start on a pool that failed because of the pool: its
// workflow did not run, or its runner did not come online. The pool then
// pauses, longer after every failure in a row (model.PoolPauseSec), and is
// tried again by itself: jobs go to the other workers and pools meanwhile.
// created is when the failed runner was placed: a runner that was placed
// before the last failure became known belongs to that failure.
func (e *Engine) poolFailed(poolID int64, created int64, reason string) {
	err := e.st.Tx(func(tx *store.Tx) error {
		p, err := tx.Pool(poolID)
		if err != nil {
			return ignoreMissing(err)
		}
		if p.Fails > 0 && created <= p.PausedUntil-int64(model.PoolPauseSec(p.Fails))*1000 {
			return nil
		}
		p.Fails++
		pause := model.PoolPauseSec(p.Fails)
		p.PausedUntil, p.PauseReason = e.now()+int64(pause)*1000, reason
		event(tx, model.LevelWarn, "pool.paused", fmt.Sprintf("%s pauses for %s after %s: %s. Jobs go to the other workers and pools meanwhile; then it is tried again. "+
			"The latest runs of %s in %s show what happened there",
			p.Name, span(pause), failedStarts(p.Fails), reason, model.RelayWorkflow, p.Repo), 0, "", p.WorkerID())
		return tx.SavePool(p)
	})
	if err != nil {
		e.logf("engine: failed start on pool %d: %v", poolID, err)
	}
	e.changed()
}

// poolWorks ends the pause of a pool: one of its runners came online.
func poolWorks(tx *store.Tx, workerID int64) error {
	if !model.IsPool(workerID) {
		return nil
	}
	p, err := tx.Pool(-workerID)
	if err != nil || (p.Fails == 0 && p.PausedUntil == 0) {
		return ignoreMissing(err)
	}
	p.Fails, p.PausedUntil, p.PauseReason = 0, 0, ""
	event(tx, model.LevelInfo, "pool.works", p.Name+" works again", 0, "", p.WorkerID())
	return tx.SavePool(p)
}

// poolUsed adds the time of a runner that is gone to what its pool has used
// this month.
func poolUsed(tx *store.Tx, r model.Runner, now int64) error {
	if !model.IsPool(r.WorkerID) || r.OnlineAt == 0 {
		return nil // it never ran on a machine
	}
	p, err := tx.Pool(-r.WorkerID)
	if err != nil {
		return ignoreMissing(err)
	}
	end := r.EndedAt
	if end == 0 {
		end = now
	}
	// Providers bill every started minute.
	sec := max((end-r.OnlineAt+59_999)/60_000, 1) * 60
	if month := monthOf(now); p.Month != month {
		p.Month, p.UsedSec = month, 0
	}
	before := PoolBudget(p, nil, now)
	p.UsedSec += sec
	if after := PoolBudget(p, nil, now); before == "" && after != "" {
		event(tx, model.LevelWarn, "pool.budget", after+"; it takes jobs again next month, or when you raise its budget", 0, "", p.WorkerID())
	}
	return tx.SavePool(p)
}

// noRelay stands in for the pools where nothing runs them, as in a test
// without them: it starts nothing and has nothing left to remove.
type noRelay struct{}

var errNoRelay = errors.New("pools of other providers are not available here")

func (noRelay) Start(context.Context, model.Worker, RunnerSpec) error { return errNoRelay }
func (noRelay) Remove(context.Context, model.Worker, string) error    { return nil }
func (noRelay) List(context.Context, model.Worker) ([]Container, error) {
	return nil, errNoRelay
}
func (noRelay) Status(int64) WorkerStatus { return WorkerStatus{Error: errNoRelay.Error()} }

// watchPools lists the runs of the relay workflows, like the containers of
// a worker: a runner whose run ended has ended. Only while runners are on a
// pool: each listing is a request to GitHub per repository.
func (e *Engine) watchPools(ctx context.Context, s *snapshot) {
	if e.Relay == nil {
		return
	}
	busy := false
	for _, r := range s.runners {
		if model.IsPool(r.WorkerID) {
			busy = true
		}
	}
	if !busy {
		return
	}
	e.spawn(ctx, "list:pools", time.Minute, func(ctx context.Context) time.Duration {
		started := e.now()
		list, err := e.Relay.List(ctx, allPools)
		if err != nil {
			return 15 * time.Second
		}
		e.compareContainers(ctx, allPools, list, started)
		return 10 * time.Second
	})
}

// migrate moves a database of an earlier version on: the sizes become the
// two there are now, and the failover of earlier versions (one relay
// repository, then a switch per repository) gives way to the pools, with a
// note that says where they are.
func migrate(tx *store.Tx) error {
	const version = 2
	if b, err := tx.Get("version"); err == nil {
		if have, err := strconv.Atoi(string(b)); err == nil && have >= version {
			return nil
		}
	}
	if err := tx.Set("version", []byte(strconv.Itoa(version))); err != nil {
		return err
	}
	var old struct {
		RelayEnabled bool   `json:"relayEnabled"`
		RelayRepo    string `json:"relayRepo"`
	}
	if err := tx.GetJSON("settings", &old); err != nil {
		return nil // a fresh database
	}
	set, err := tx.Settings()
	if err != nil {
		return err
	}
	set, sized := set.TwoSizes()
	if sized {
		std, large := set.Sizes[0], set.Sizes[1]
		event(tx, model.LevelInfo, "settings.sizes", fmt.Sprintf("There are two sizes now: standard (%g CPUs, %g GB) and large (%g CPUs, %g GB, label \"large\"). "+
			"The labels of the earlier sizes keep working. Change the values under Settings", std.CPUs, float64(std.MemMB)/1024, large.CPUs, float64(large.MemMB)/1024), 0, "", 0)
	}
	if old.RelayEnabled || old.RelayRepo != "" {
		event(tx, model.LevelWarn, "pool.moved", "The failover to GitHub-hosted runners is now a pool on the Workers page, with a repository and a tier of its own. "+
			"Add one there to use GitHub-hosted runners again", 0, "", 0)
	}
	if !sized && !old.RelayEnabled && old.RelayRepo == "" {
		return nil
	}
	if err := tx.Delete("relay.off"); err != nil {
		return err
	}
	return tx.SaveSettings(set) // also drops the fields that are gone
}
