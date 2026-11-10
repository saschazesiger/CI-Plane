package engine

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

type usage struct {
	cpus  float64
	memMB int
}

// Capacity is what a worker can give to runners and what is reserved.
type Capacity struct {
	CPUs      float64 `json:"cpus"`      // allocatable
	MemMB     int     `json:"memMb"`     // allocatable
	UsedCPUs  float64 `json:"usedCpus"`  // reserved by runners
	UsedMemMB int     `json:"usedMemMb"` // reserved by runners
	Runners   int     `json:"runners"`
}

// FreeShare is the smaller of the free shares of CPU and memory, 0..1.
func (c Capacity) FreeShare() float64 {
	if c.CPUs <= 0 || c.MemMB <= 0 {
		return 0
	}
	cpu := (c.CPUs - c.UsedCPUs) / c.CPUs
	mem := float64(c.MemMB-c.UsedMemMB) / float64(c.MemMB)
	if mem < cpu {
		cpu = mem
	}
	if cpu < 0 {
		cpu = 0
	}
	return cpu
}

// Fits reports whether a size still fits.
func (c Capacity) Fits(z model.Size) bool {
	return c.CPUs-c.UsedCPUs >= z.CPUs && c.MemMB-c.UsedMemMB >= z.MemMB
}

// Allocatable is the capacity of an empty worker: what was detected minus
// the reserve for the system.
func Allocatable(set model.Settings, w model.Worker) Capacity {
	keep := float64(100-set.ReservePct) / 100
	c := Capacity{CPUs: float64(w.CPUs) * keep, MemMB: int(float64(w.MemMB)*keep) - set.ReserveMemMB}
	if c.MemMB < 0 {
		c.MemMB = 0
	}
	return c
}

// CapacityOf returns the capacity of a worker with the reservations of the
// given runners.
func CapacityOf(set model.Settings, w model.Worker, runners []model.Runner) Capacity {
	c := Allocatable(set, w)
	for _, r := range runners {
		if r.WorkerID == w.ID && r.Active() {
			c.UsedCPUs += r.CPUs
			c.UsedMemMB += r.MemMB
			c.Runners++
		}
	}
	return c
}

// available reports whether a worker takes new jobs at all.
func (s *snapshot) available(w model.Worker) bool {
	return w.Enabled && !w.Draining && w.State == model.WorkerOnline && s.status[w.ID].Connected
}

// pick chooses the worker for a job of a size: the lowest tier that has
// room, and in it the worker with the largest free share. Workers in skip
// are left out. Without a worker it says why.
func (s *snapshot) pick(z model.Size, caps map[int64]Capacity, skip map[int64]bool) (model.Worker, bool, string) {
	var best model.Worker
	found, bestShare := false, -1.0
	anyAvailable, anyLargeEnough := false, false
	for _, w := range s.workers { // ordered by tier, then position
		if !s.available(w) {
			continue
		}
		anyAvailable = true
		c := caps[w.ID]
		if !(Capacity{CPUs: c.CPUs, MemMB: c.MemMB}).Fits(z) {
			continue
		}
		anyLargeEnough = true
		if skip[w.ID] || !c.Fits(z) {
			continue
		}
		// Guard against load CI-Plane does not know about.
		if st := s.status[w.ID]; st.At > 0 && st.MemAvailMB < z.MemMB/2 {
			continue
		}
		if found && w.Tier > best.Tier {
			break
		}
		if share := c.FreeShare(); share > bestShare {
			best, bestShare, found = w, share, true
		}
	}
	switch {
	case found:
		return best, true, ""
	case len(s.workers) == 0:
		return best, false, "No worker has been added yet"
	case !anyAvailable:
		return best, false, "No worker is available: all are switched off, draining or offline"
	case !anyLargeEnough:
		return best, false, fmt.Sprintf("No worker is large enough for %s (%g CPU, %g GB)", z.Name, z.CPUs, float64(z.MemMB)/1024)
	}
	return best, false, "All workers are full; the job starts when a slot is free"
}

// schedule gives every queued job a runner: a spare one if there is one,
// otherwise a new one on the best worker.
func (e *Engine) schedule(s *snapshot) bool {
	caps := map[int64]Capacity{}
	for _, w := range s.workers {
		caps[w.ID] = CapacityOf(s.set, w, s.runners)
	}
	perRepo, perAcc := map[int64]int{}, map[int64]int{}
	for _, j := range s.jobs {
		if j.State == model.JobAssigned || j.State == model.JobRunning {
			perRepo[j.RepoID]++
			perAcc[j.AccountID]++
		}
	}
	var spares []model.Runner
	for _, r := range s.runners {
		if r.JobID == 0 && r.Waiting() {
			spares = append(spares, r)
		}
	}
	held := map[int64]bool{} // workers kept free for a job that waits long
	dirty, full := false, false
	defer func() {
		e.mu.Lock()
		e.pressure = full && len(spares) > 0
		e.mu.Unlock()
	}()

	for _, j := range s.jobs {
		acc, ok := s.accounts[j.AccountID]
		if !ok {
			// Its GitHub account was removed from CI-Plane: nothing can
			// start a runner for it or learn how it ended.
			_ = e.HandleJob(JobEvent{Action: "completed", ID: j.ID, Conclusion: "account removed"})
			continue
		}
		if j.State != model.JobQueued {
			continue
		}
		if j.NextTryAt > s.now {
			e.setReason(j, "Waiting to try again after a failed start")
			continue
		}
		if acc.MaxParallel > 0 && perAcc[j.AccountID] >= acc.MaxParallel {
			e.setReason(j, fmt.Sprintf("Waiting: %s is limited to %d parallel jobs", acc.Owner, acc.MaxParallel))
			continue
		}
		if repo := s.repos[j.RepoID]; repo.MaxParallel > 0 && perRepo[j.RepoID] >= repo.MaxParallel {
			e.setReason(j, fmt.Sprintf("Waiting: %s is limited to %d parallel jobs", j.Repo, repo.MaxParallel))
			continue
		}

		// A spare runner that fits?
		adopted := false
		for i, r := range spares {
			if !inScope(acc, r, j) || !model.Serves(r.Labels, j.Labels) {
				continue
			}
			if e.designate(j.ID, r.ID) {
				spares = append(spares[:i], spares[i+1:]...)
				adopted = true
			}
			break
		}
		if adopted {
			perRepo[j.RepoID]++
			perAcc[j.AccountID]++
			dirty = true
			continue
		}

		z, ok := s.set.SizeByName(j.Size)
		if !ok {
			e.setReason(j, "The size "+j.Size+" no longer exists in the settings")
			continue
		}
		skip := map[int64]bool{}
		for id := range held {
			skip[id] = true
		}
		w, found, why := model.Worker{}, false, ""
		if j.AvoidWorker != 0 && !skip[j.AvoidWorker] {
			// After a failed start, try another worker first.
			skip[j.AvoidWorker] = true
			w, found, _ = s.pick(z, caps, skip)
			delete(skip, j.AvoidWorker)
		}
		if !found {
			w, found, why = s.pick(z, caps, skip)
		}
		if !found {
			e.setReason(j, why)
			full = true
			if s.now-j.WaitingSince > int64(s.set.NoOvertakeSec)*1000 {
				// Nothing overtakes it on a worker that could hold it.
				for _, c := range s.workers {
					if s.available(c) && Allocatable(s.set, c).Fits(z) {
						held[c.ID] = true
					}
				}
			}
			continue
		}
		if e.place(s, j, w, z) {
			c := caps[w.ID]
			c.UsedCPUs += z.CPUs
			c.UsedMemMB += z.MemMB
			c.Runners++
			caps[w.ID] = c
			perRepo[j.RepoID]++
			perAcc[j.AccountID]++
			dirty = true
		}
	}
	return dirty
}

// setReason stores why a job waits, if that changed.
func (e *Engine) setReason(j model.Job, reason string) {
	if j.Reason == reason {
		return
	}
	_ = e.st.Tx(func(tx *store.Tx) error {
		cur, err := tx.Job(j.ID)
		if err != nil || cur.State != model.JobQueued || cur.Reason == reason {
			return err
		}
		cur.Reason = reason
		return tx.SaveJob(cur)
	})
	e.changed()
}

// designate gives a spare runner to a queued job.
func (e *Engine) designate(jobID int64, runnerID string) bool {
	ok := false
	err := e.st.Tx(func(tx *store.Tx) error {
		job, err := tx.Job(jobID)
		if err != nil || job.State != model.JobQueued {
			return err
		}
		r, err := tx.Runner(runnerID)
		if err != nil || r.JobID != 0 || !r.Waiting() {
			return err
		}
		r.JobID, r.SpareAt = job.ID, 0
		job.State, job.RunnerID, job.Reason = model.JobAssigned, r.ID, ""
		if err := tx.SaveRunner(r); err != nil {
			return err
		}
		event(tx, model.LevelInfo, "job.assigned", "Uses the runner "+r.Name+", which was already starting", job.ID, r.ID, r.WorkerID)
		ok = true
		return tx.SaveJob(job)
	})
	return ok && err == nil
}

// place creates a runner for a job on a worker. Only the intent is stored
// here; the next pass carries it out.
func (e *Engine) place(s *snapshot, j model.Job, w model.Worker, z model.Size) bool {
	id := newID()
	r := model.Runner{
		ID: id, Name: NamePrefix + slug(w.Name) + "-" + id, WorkerID: w.ID, AccountID: j.AccountID, RepoID: j.RepoID, Repo: j.Repo,
		JobID: j.ID, Labels: s.set.RunnerLabels(z.Name), Size: z.Name, CPUs: z.CPUs, MemMB: z.MemMB,
		State: model.RunnerProvisioning, CreatedAt: s.now,
	}
	ok := false
	err := e.st.Tx(func(tx *store.Tx) error {
		job, err := tx.Job(j.ID)
		if err != nil || job.State != model.JobQueued {
			return err
		}
		job.State, job.RunnerID, job.Reason = model.JobAssigned, r.ID, ""
		if err := tx.SaveRunner(r); err != nil {
			return err
		}
		c := CapacityOf(s.set, w, s.runners)
		event(tx, model.LevelInfo, "job.assigned",
			fmt.Sprintf("Worker %s chosen (tier %d, %d %% free); starting the runner %s", w.Name, w.Tier, int(c.FreeShare()*100), r.Name),
			job.ID, r.ID, w.ID)
		ok = true
		return tx.SaveJob(job)
	})
	if err != nil {
		e.logf("engine: place job %d: %v", j.ID, err)
	}
	return ok && err == nil
}

func newID() string {
	b := make([]byte, 5)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// slug makes a worker name safe for runner and container names.
func slug(name string) string {
	var b strings.Builder
	for _, c := range strings.ToLower(name) {
		switch {
		case c >= 'a' && c <= 'z', c >= '0' && c <= '9':
			b.WriteRune(c)
		case b.Len() > 0 && !strings.HasSuffix(b.String(), "-"):
			b.WriteByte('-')
		}
		if b.Len() >= 24 {
			break
		}
	}
	out := strings.Trim(b.String(), "-")
	if out == "" {
		out = "worker"
	}
	return out
}
