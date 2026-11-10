package demo

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// hostState is the simulated machine behind a worker: its live values and
// the incident it is in, if any.
type hostState struct {
	cpus, memMB, diskMB int
	diskUsed            int // MB used by images, caches and the mirror
	phase               float64
	downUntil           time.Time
	diskLowUntil        time.Time
}

func newHostState(w model.Worker, r float64) *hostState {
	disk := w.DiskMB
	if disk == 0 {
		disk = 500 * 1024
	}
	return &hostState{cpus: w.CPUs, memMB: w.MemMB, diskMB: disk, diskUsed: int(float64(disk) * (0.18 + 0.2*r)), phase: r * 6}
}

// status derives the live values from the reservations of the runners on
// the worker, with a little noise so the meters breathe.
func (h *hostState) status(runners []model.Runner, set model.Settings) engine.WorkerStatus {
	now := time.Now()
	if now.Before(h.downUntil) {
		return engine.WorkerStatus{Error: "ssh: connection to " + "the worker timed out after 15 s; it may be off or its network down"}
	}
	var cpu float64
	mem := 0
	for _, r := range runners {
		cpu += r.CPUs
		mem += r.MemMB
	}
	wave := (math.Sin(float64(now.UnixMilli())/9000+h.phase) + 1) / 2 // 0..1
	busy := 0.45 + 0.35*wave
	cpuPct := 3 + 100*cpu*busy/float64(max(h.cpus, 1))
	if cpuPct > 99 {
		cpuPct = 99
	}
	used := 1400 + int(float64(mem)*(0.35+0.3*wave))
	free := h.diskMB - h.diskUsed - len(runners)*2400
	if now.Before(h.diskLowUntil) {
		free = set.MinDiskFreeMB - 3200
	}
	if free < 0 {
		free = 0
	}
	return engine.WorkerStatus{
		Connected: true, At: now.UnixMilli(), Load1: round1(cpu*busy + 0.2 + wave*0.3), CPUPct: round1(cpuPct),
		MemTotalMB: h.memMB, MemAvailMB: max(h.memMB-used, 256), DiskMB: h.diskMB, DiskFreeMB: free,
	}
}

func round1(v float64) float64 { return float64(int(v*10+0.5)) / 10 }

// drive moves the demo: one simulated second per tick.
func (d *Demo) drive(ctx context.Context) {
	tick := time.NewTicker(d.scaled(time.Second))
	defer tick.Stop()
	started := time.Now()
	nextPush := time.Now().Add(d.scaled(2 * time.Second))
	nextIncident := time.Now().Add(d.scaled(time.Duration(150+d.intn(120)) * time.Second))
	n := 0
	if d.opts.Freeze {
		// A busy moment, then stillness.
		for i := 0; i < 3; i++ {
			d.push()
		}
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		n++
		d.World.Step()
		if n%2 == 0 || n < 3 {
			d.updateLive()
		}
		if d.opts.Freeze {
			if time.Since(started) > 10*time.Second {
				d.updateLive()
				return
			}
			continue
		}
		now := time.Now()
		if now.After(nextPush) {
			d.push()
			nextPush = now.Add(d.scaled(time.Duration(12+d.intn(40)) * time.Second))
		}
		if now.After(nextIncident) {
			d.incident()
			nextIncident = now.Add(d.scaled(time.Duration(180+d.intn(240)) * time.Second))
		}
	}
}

// push is a commit: the jobs of one workflow run are queued together.
func (d *Demo) push() {
	var repos []model.Repo
	accounts := map[int64]model.Account{}
	_ = d.Store.View(func(tx *store.Tx) error {
		accs, err := tx.Accounts()
		if err != nil {
			return err
		}
		for _, a := range accs {
			accounts[a.ID] = a
		}
		all, err := tx.Repos(0)
		for _, p := range all {
			if a, ok := accounts[p.AccountID]; ok && a.InstallationID != 0 && a.Enabled && p.Enabled {
				repos = append(repos, p)
			}
		}
		return err
	})
	if len(repos) == 0 {
		return
	}
	acc, repo := d.pickRepo(repos)
	branch := branches[d.intn(len(branches))]
	d.mu.Lock()
	d.runID++
	run := d.runID
	d.mu.Unlock()
	for _, name := range repo.jobs {
		d.mu.Lock()
		d.jobID++
		id := d.jobID
		d.mu.Unlock()
		size := []string{"size-s", "size-m", "size-m", "size-m", "size-l", "size-xl"}[d.intn(6)]
		labels := []string{"self-hosted", "ci-plane", size}
		if d.intn(10) == 0 {
			labels = []string{"self-hosted", "ci-plane"} // the default size
		}
		if d.intn(60) == 0 {
			labels = []string{"self-hosted", "ci-plane", "macos"}
		}
		ev := engine.JobEvent{ID: id, RunID: run, AccountID: acc.id, RepoID: repo.id, Repo: repo.name, Private: true,
			Name: name, Workflow: repo.workflow, Branch: branch, Labels: labels,
			HTMLURL: fmt.Sprintf("https://github.com/%s/actions/runs/%d/job/%d", repo.name, run, id)}
		d.World.Queue(ev, 20+d.intn(200))
	}
}

// updateLive writes the live values of every prepared worker.
func (d *Demo) updateLive() {
	var workers []model.Worker
	var runners []model.Runner
	set := model.DefaultSettings()
	_ = d.Store.View(func(tx *store.Tx) error {
		var err error
		if set, err = tx.Settings(); err != nil {
			return err
		}
		if workers, err = tx.Workers(); err != nil {
			return err
		}
		runners, err = tx.ActiveRunners()
		return err
	})
	for _, w := range workers {
		d.mu.Lock()
		h := d.hosts[w.ID]
		d.mu.Unlock()
		if h == nil {
			continue // not prepared yet: it stays unreachable
		}
		var mine []model.Runner
		for _, r := range runners {
			if r.WorkerID == w.ID {
				mine = append(mine, r)
			}
		}
		d.World.SetStatus(w.ID, h.status(mine, set))
	}
}

// incident lets one thing go wrong for a while: a failed start, a worker
// that drops off the network, or a disk that fills up.
func (d *Demo) incident() {
	var candidates []model.Worker
	_ = d.Store.View(func(tx *store.Tx) error {
		ws, err := tx.Workers()
		for _, w := range ws {
			if w.Enabled && w.State == model.WorkerOnline {
				candidates = append(candidates, w)
			}
		}
		return err
	})
	if len(candidates) < 2 {
		return
	}
	w := candidates[d.intn(len(candidates))]
	d.mu.Lock()
	h := d.hosts[w.ID]
	busy := false
	for _, o := range d.hosts {
		if time.Now().Before(o.downUntil) || time.Now().Before(o.diskLowUntil) {
			busy = true
		}
	}
	d.mu.Unlock()
	if h == nil || busy {
		return
	}
	switch d.intn(3) {
	case 0:
		d.fleet.failOnce(w.ID)
		d.opts.Logf("demo: the next runner start on %s fails", w.Name)
	case 1:
		d.mu.Lock()
		h.downUntil = time.Now().Add(d.scaled(time.Duration(70+d.rnd.Intn(80)) * time.Second))
		d.mu.Unlock()
		d.opts.Logf("demo: %s drops off the network for a while", w.Name)
	case 2:
		d.mu.Lock()
		h.diskLowUntil = time.Now().Add(d.scaled(90 * time.Second))
		d.mu.Unlock()
		d.opts.Logf("demo: the disk of %s fills up for a while", w.Name)
	}
	d.updateLive()
}
