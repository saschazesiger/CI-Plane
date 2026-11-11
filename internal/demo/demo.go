// Package demo runs CI-Plane without GitHub, Cloudflare or servers: the
// real engine on the simulator (sim.World), an in-memory store with a few
// accounts, repositories and workers, a driver that queues jobs at a natural
// rhythm and now and then lets something go wrong, and stand-ins for the
// services of the interface, so every assistant can be clicked through.
package demo

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"sync"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/sim"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// Options shape a demo.
type Options struct {
	Seed   int64   // the same seed gives the same accounts, workers, history and rhythm
	Speed  float64 // 1 is real time; 4 runs jobs and incidents four times as fast
	Freeze bool    // after a short warm-up nothing moves: for screenshots
	Fresh  bool    // start empty, as on a first run (the setup assistant)
	Logf   func(format string, args ...any)
}

// Demo is a running demo installation.
type Demo struct {
	Store      *store.Store
	Engine     *engine.Engine
	World      *sim.World
	Workers    *Workers
	GitHub     *GitHub
	Cloudflare *Cloudflare
	Relay      *Relay
	Pages      http.Handler // the stand-in GitHub pages, mounted under /demo/

	opts  Options
	fleet *fleet
	mu    sync.Mutex
	rnd   *rand.Rand
	jobID int64
	runID int64
	hosts map[int64]*hostState // live values per worker, by worker id
}

// New builds a demo on an in-memory store.
func New(opts Options) (*Demo, error) {
	if opts.Speed <= 0 {
		opts.Speed = 1
	}
	if opts.Logf == nil {
		opts.Logf = func(string, ...any) {}
	}
	st, err := store.Open("")
	if err != nil {
		return nil, err
	}
	d := &Demo{
		Store: st, World: sim.New(), opts: opts,
		rnd: rand.New(rand.NewSource(opts.Seed)), jobID: 7_400_000_000, runID: 15_000_000_000,
		hosts: map[int64]*hostState{},
	}
	d.fleet = &fleet{World: d.World, d: d, failNext: map[int64]int{}}
	d.Engine = engine.New(st, d.World, d.fleet)
	d.Engine.Logf = opts.Logf
	// The runners of pools are simulated like those of workers.
	d.Engine.Relay = poolHosts{d.World}
	d.Relay = &Relay{}
	d.Workers = &Workers{d: d}
	d.GitHub = &GitHub{d: d, states: map[string]manifestState{}, installed: map[int64]bool{}, webhooks: map[int64]int64{}}
	d.Cloudflare = &Cloudflare{d: d}
	d.Pages = d.pages()
	eng := d.Engine
	d.World.Deliver = func(ev engine.JobEvent) {
		d.GitHub.sawWebhook(ev.AccountID)
		if err := eng.HandleJob(ev); err != nil {
			opts.Logf("demo: deliver job %d: %v", ev.ID, err)
		}
	}
	if !opts.Fresh {
		if err := d.seed(); err != nil {
			st.Close()
			return nil, err
		}
	}
	return d, nil
}

// Run runs the engine and the driver until ctx ends.
func (d *Demo) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); d.Engine.Run(ctx) }()
	go func() { defer wg.Done(); d.drive(ctx) }()
	wg.Wait()
}

// Close closes the store.
func (d *Demo) Close() error { return d.Store.Close() }

// scaled is a demo duration at the chosen speed.
func (d *Demo) scaled(dur time.Duration) time.Duration {
	return time.Duration(float64(dur) / d.opts.Speed)
}

func (d *Demo) sleep(ctx context.Context, dur time.Duration) error {
	t := time.NewTimer(d.scaled(dur))
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// intn is the seeded random source, safe for the goroutines of the demo.
func (d *Demo) intn(n int) int {
	d.mu.Lock()
	defer d.mu.Unlock()
	if n <= 0 {
		return 0
	}
	return d.rnd.Intn(n)
}

func (d *Demo) float() float64 {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.rnd.Float64()
}

// fleet is the simulated fleet with a start delay and injected failures.
type fleet struct {
	*sim.World
	d        *Demo
	mu       sync.Mutex
	failNext map[int64]int
}

func (f *fleet) Start(ctx context.Context, w model.Worker, spec engine.RunnerSpec) error {
	// A real start takes a few seconds: images are local, two containers start.
	if err := f.d.sleep(ctx, time.Duration(800+f.d.intn(2200))*time.Millisecond); err != nil {
		return err
	}
	f.mu.Lock()
	fail := f.failNext[w.ID] > 0
	if fail {
		f.failNext[w.ID]--
	}
	f.mu.Unlock()
	if fail {
		return errors.New("docker: Error response from daemon: failed to create task for container: OCI runtime create failed: cgroup memory limit could not be set")
	}
	return f.World.Start(ctx, w, spec)
}

func (f *fleet) failOnce(workerID int64) {
	f.mu.Lock()
	f.failNext[workerID]++
	f.mu.Unlock()
}

// --- seed ----------------------------------------------------------------------

type seedWorker struct {
	name, host string
	tier       int
	cpus, memG int
	diskG      int
	enabled    bool
	priority   string
	other      float64 // CPU share of the server's other work at its peak
}

var seedWorkers = []seedWorker{
	{"rack-01", "10.0.10.11", 1, 32, 128, 1800, true, model.PriorityNormal, 0},
	{"rack-02", "10.0.10.12", 1, 32, 128, 1800, true, model.PriorityNormal, 0},
	// A server that does other work as well: jobs run in the background
	// there and only start while it has CPUs to spare.
	{"db-replica", "10.0.10.13", 1, 16, 64, 900, true, model.PriorityBackground, 0.7},
	{"office-mini", "office-mini.lan", 2, 8, 32, 450, true, model.PriorityLow, 0.25},
	{"old-laptop", "192.168.1.44", 2, 4, 16, 230, false, model.PriorityNormal, 0},
}

type seedRepo struct {
	id       int64
	name     string
	private  bool
	enabled  bool
	limit    int
	weight   int
	workflow string
	jobs     []string
}

// demoRunnerAccount is the app of the runner account of the demo.
const demoRunnerAccount = 1_012_399

type seedAccount struct {
	id      int64
	slug    string
	owner   string
	kind    string
	install int64
	repos   []seedRepo
}

var seedAccounts = []seedAccount{
	{1012345, "ci-plane-acme-labs", "acme-labs", "Organization", 51_200_001, []seedRepo{
		{720_001, "acme-labs/api", true, true, 0, 5, "CI", []string{"lint", "unit (go 1.27)", "integration", "build image"}},
		{720_002, "acme-labs/web", true, true, 0, 4, "CI", []string{"lint", "test", "e2e (chromium)", "build"}},
		{720_003, "acme-labs/mobile", true, true, 2, 2, "Android", []string{"assemble", "unit tests"}},
		{720_004, "acme-labs/infra", true, false, 0, 0, "Terraform", []string{"plan"}},
		{720_005, "acme-labs/docs", false, true, 0, 1, "Pages", []string{"build"}},
	}},
	{1012346, "ci-plane-ada-lovelace", "ada-lovelace", "User", 51_200_002, []seedRepo{
		{730_001, "ada-lovelace/analytical-engine", true, true, 0, 2, "CI", []string{"test", "bench"}},
		{730_002, "ada-lovelace/dotfiles", true, true, 0, 1, "Check", []string{"shellcheck"}},
	}},
}

var branches = []string{"main", "main", "main", "feature/billing-export", "fix/flaky-login", "renovate/go-1.x", "release/2.4"}

func hostKeyOf(host string) (key, fingerprint string) {
	sum := sha256.Sum256([]byte("demo host key " + host))
	key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI" + base64.RawStdEncoding.EncodeToString(sum[:])
	fp := sha256.Sum256([]byte(key))
	return key, "SHA256:" + base64.RawStdEncoding.EncodeToString(fp[:])
}

func fnv(s string) uint64 {
	h := uint64(1469598103934665603)
	for i := 0; i < len(s); i++ {
		h ^= uint64(s[i])
		h *= 1099511628211
	}
	return h
}

// seed fills the store with an installation that has been in use for a
// few hours.
func (d *Demo) seed() error {
	now := time.Now()
	nowMs := now.UnixMilli()
	set := model.DefaultSettings()
	var workers []model.Worker
	err := d.Store.Tx(func(tx *store.Tx) error {
		if err := tx.Set("setup.done", []byte("1")); err != nil {
			return err
		}
		for _, a := range seedAccounts {
			if err := tx.SaveAccount(model.Account{ID: a.id, Slug: a.slug, Owner: a.owner, OwnerType: a.kind,
				HTMLURL: "https://github.com/apps/" + a.slug, InstallationID: a.install, Enabled: true,
				CreatedAt: nowMs - 40*24*3600*1000}); err != nil {
				return err
			}
			for _, p := range a.repos {
				r := model.Repo{ID: p.id, AccountID: a.id, FullName: p.name, Private: p.private, Enabled: true, MaxParallel: p.limit}
				if err := tx.UpsertRepo(r); err != nil {
					return err
				}
				r.Enabled = p.enabled
				if err := tx.SaveRepo(r); err != nil {
					return err
				}
			}
		}
		for i, sw := range seedWorkers {
			key, _ := hostKeyOf(sw.host)
			w, err := tx.AddWorker(model.Worker{Name: sw.name, Host: sw.host, Port: 22, User: "ci-plane", HostKey: key,
				Tier: sw.tier, Position: i, Enabled: sw.enabled, State: model.WorkerOnline, CPUs: sw.cpus, MemMB: sw.memG * 1024,
				CPUPriority: sw.priority, DiskMB: sw.diskG * 1024, Docker: "28.3.2", LastSeenAt: nowMs, CreatedAt: nowMs - int64(30-i)*24*3600*1000})
			if err != nil {
				return err
			}
			workers = append(workers, w)
			if _, err := tx.AddEvent(model.Event{At: nowMs - 9*3600*1000, Kind: "worker.online", WorkerID: w.ID, Message: "Worker is online"}); err != nil {
				return err
			}
		}
		// A runner account, whose minutes a pool uses for the hours when
		// the workers are full.
		if err := tx.SaveRunnerAccount(model.Account{ID: demoRunnerAccount, Slug: "ci-plane-runners-mia", Owner: "mia-dev", OwnerType: "User",
			HTMLURL: "https://github.com/apps/ci-plane-runners-mia", InstallationID: 61_000_999, CreatedAt: nowMs - 12*24*3600*1000}); err != nil {
			return err
		}
		if err := tx.SetRunnerRepos(demoRunnerAccount, []model.Repo{{ID: 9_400_001, FullName: "mia-dev/ci-plane-relay", Private: true}}); err != nil {
			return err
		}
		if _, err := tx.AddPool(model.Pool{Name: "GitHub", Kind: model.PoolGitHub, AccountID: demoRunnerAccount, Repo: "mia-dev/ci-plane-relay", Tier: 9, Enabled: true,
			AfterSec: 180, Max: 5, Standard: "ubuntu-latest", BudgetMin: 2000, Month: now.UTC().Format("2006-01"), UsedSec: 412 * 60,
			CreatedAt: nowMs - 12*24*3600*1000}); err != nil {
			return err
		}
		return d.seedHistory(tx, set, workers, now)
	})
	if err != nil {
		return err
	}
	for i, w := range workers {
		d.hosts[w.ID] = newHostState(w, d.float())
		d.hosts[w.ID].other = seedWorkers[i].other
		d.World.SetStatus(w.ID, d.hosts[w.ID].status(nil, set))
	}
	d.Cloudflare.seedConfigured()
	return nil
}

// seedHistory writes the finished jobs of the last eight hours, with their
// timelines, as the engine would have.
func (d *Demo) seedHistory(tx *store.Tx, set model.Settings, workers []model.Worker, now time.Time) error {
	start := now.Add(-8 * time.Hour).UnixMilli()
	t := start
	active := workers[:4]
	for t < now.Add(-4*time.Minute).UnixMilli() {
		t += int64(60_000 + d.intn(9*60_000))
		acc, repo := d.pickRepo(nil)
		if repo.name == "" {
			continue
		}
		d.runID++
		branch := branches[d.intn(len(branches))]
		for _, name := range repo.jobs {
			d.jobID++
			size := []string{model.SizeStandard, model.SizeStandard, model.SizeStandard, model.SizeLarge}[d.intn(4)]
			labels := []string{"self-hosted", "ci-plane"}
			if size == model.SizeLarge {
				labels = append(labels, size)
			}
			queued := t + int64(d.intn(4000))
			j := model.Job{ID: d.jobID, RunID: d.runID, AccountID: acc.id, RepoID: repo.id, Repo: repo.name, Name: name,
				Workflow: repo.workflow, Branch: branch, Labels: labels, Size: size,
				HTMLURL:  fmt.Sprintf("https://github.com/%s/actions/runs/%d/job/%d", repo.name, d.runID, d.jobID),
				QueuedAt: queued, WaitingSince: queued}
			if d.intn(40) == 0 {
				j.Labels = []string{"self-hosted", "ci-plane", "gpu"}
				j.State, j.Reason, j.Size = model.JobIgnored, `unknown label "gpu" in runs-on`, ""
				if err := tx.SaveJob(j); err != nil {
					return err
				}
				if _, err := tx.AddEvent(model.Event{At: queued, Level: model.LevelWarn, Kind: "job.ignored", Message: "Ignored: " + j.Reason, JobID: j.ID}); err != nil {
					return err
				}
				continue
			}
			w := active[d.intn(len(active))]
			wait := int64(2500 + d.intn(9000))
			if d.intn(12) == 0 {
				wait += int64(30_000 + d.intn(120_000)) // waited for a free slot
			}
			dur := int64(40_000 + d.intn(9*60_000))
			j.StartedAt = queued + wait
			j.CompletedAt = j.StartedAt + dur
			if j.CompletedAt > now.UnixMilli() {
				continue
			}
			j.State, j.Conclusion, j.Attempts = model.JobCompleted, "success", 1
			if d.intn(9) == 0 {
				j.Conclusion = "failure"
			}
			id := fmt.Sprintf("%010x", d.jobID)
			rn := model.Runner{ID: id, Name: engine.NamePrefix + w.Name + "-" + id, WorkerID: w.ID, AccountID: acc.id, RepoID: repo.id,
				Repo: repo.name, JobID: j.ID, ForgeID: d.jobID, Labels: set.RunnerLabels(size), Size: size, State: model.RunnerRemoved,
				CreatedAt: queued + 300, StartedAt: queued + 1500, OnlineAt: j.StartedAt - 400, BusyAt: j.StartedAt,
				EndedAt: j.CompletedAt + 2000, RemovedAt: j.CompletedAt + 6000}
			if z, ok := set.SizeByName(size); ok {
				rn.CPUs, rn.MemMB = z.CPUs, z.MemMB
			}
			j.RunnerID = rn.ID
			if err := tx.SaveRunner(rn); err != nil {
				return err
			}
			if err := tx.SaveJob(j); err != nil {
				return err
			}
			if p, err := tx.Repo(repo.id); err == nil && p.LastJobAt < queued {
				p.LastJobAt = queued
				if err := tx.SaveRepo(p); err != nil {
					return err
				}
			}
			level := model.LevelInfo
			if j.Conclusion == "failure" {
				level = model.LevelWarn
			}
			for _, e := range []model.Event{
				{At: queued, Kind: "job.queued", Message: "Queued on GitHub (" + size + ")", JobID: j.ID},
				{At: queued + 300, Kind: "job.assigned", Message: fmt.Sprintf("Worker %s chosen (tier %d, %.1f CPUs and %d GB free); starting the runner %s", w.Name, w.Tier, float64(40+d.intn(55))/10, 8+d.intn(40), rn.Name), JobID: j.ID, RunnerID: rn.ID, WorkerID: w.ID},
				{At: queued + 1500, Kind: "runner.started", Message: "Containers started; waiting for the runner to connect to GitHub", JobID: j.ID, RunnerID: rn.ID, WorkerID: w.ID},
				{At: j.StartedAt, Kind: "job.started", Message: fmt.Sprintf("Started on %s after %d s", rn.Name, (j.StartedAt-queued)/1000), JobID: j.ID, RunnerID: rn.ID, WorkerID: w.ID},
				{At: j.CompletedAt, Level: level, Kind: "job.completed", Message: "Completed on GitHub: " + j.Conclusion, JobID: j.ID, RunnerID: rn.ID},
				{At: rn.RemovedAt, Kind: "runner.removed", Message: "Runner " + rn.Name + " and everything it created were removed", JobID: j.ID, RunnerID: rn.ID, WorkerID: w.ID},
			} {
				if _, err := tx.AddEvent(e); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// pickRepo chooses a repository by weight among the enabled ones of
// installed accounts; known limits the choice to what is in the store.
func (d *Demo) pickRepo(known []model.Repo) (seedAccount, seedRepo) {
	type cand struct {
		a seedAccount
		r seedRepo
	}
	var all []cand
	total := 0
	if known == nil {
		for _, a := range seedAccounts {
			for _, r := range a.repos {
				if r.enabled && r.weight > 0 {
					all = append(all, cand{a, r})
					total += r.weight
				}
			}
		}
	} else {
		for _, p := range known {
			r := seedRepo{id: p.ID, name: p.FullName, weight: 1, workflow: "CI", jobs: []string{"build", "test"}}
			for _, a := range seedAccounts {
				for _, sr := range a.repos {
					if sr.id == p.ID {
						r = sr
					}
				}
			}
			if r.weight == 0 {
				r.weight = 1
			}
			all = append(all, cand{seedAccount{id: p.AccountID}, r})
			total += r.weight
		}
	}
	if total == 0 {
		return seedAccount{}, seedRepo{}
	}
	n := d.intn(total)
	for _, c := range all {
		if n < c.r.weight {
			return c.a, c.r
		}
		n -= c.r.weight
	}
	return all[0].a, all[0].r
}
