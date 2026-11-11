package api

import (
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// live is the JSON form of engine.WorkerStatus.
type live struct {
	Connected  bool    `json:"connected"`
	Error      string  `json:"error"`
	At         int64   `json:"at"`
	Load1      float64 `json:"load1"`
	CPUPct     float64 `json:"cpuPct"`
	CPUAvgPct  float64 `json:"cpuAvgPct"`
	MemAvailMB int     `json:"memAvailMb"`
	MemTotalMB int     `json:"memTotalMb"`
	DiskFreeMB int     `json:"diskFreeMb"`
	DiskMB     int     `json:"diskMb"`
}

func liveOf(st engine.WorkerStatus) live {
	return live{Connected: st.Connected, Error: st.Error, At: st.At, Load1: st.Load1, CPUPct: st.CPUPct, CPUAvgPct: st.CPUAvgPct,
		MemAvailMB: st.MemAvailMB, MemTotalMB: st.MemTotalMB, DiskFreeMB: st.DiskFreeMB, DiskMB: st.DiskMB}
}

// workerView is a worker with what the interface shows next to it.
type workerView struct {
	model.Worker
	Capacity engine.Capacity `json:"capacity"`
	Live     live            `json:"live"`
	Task     *Task           `json:"task"` // the latest preparation, if any is remembered
}

// snapshot is what most pages are built from, read in one transaction.
type snapshot struct {
	now      int64
	set      model.Settings
	workers  []model.Worker
	runners  []model.Runner // active ones
	accounts []model.Account
	repos    []model.Repo
	counts   map[string]int
	open     []model.Job
}

func (s *Server) snapshot() (*snapshot, error) {
	sn := &snapshot{now: time.Now().UnixMilli()}
	err := s.d.Store.View(func(tx *store.Tx) error {
		var err error
		if sn.set, err = tx.Settings(); err != nil {
			return err
		}
		if sn.workers, err = tx.Workers(); err != nil {
			return err
		}
		if sn.runners, err = tx.ActiveRunners(); err != nil {
			return err
		}
		if sn.accounts, err = tx.Accounts(); err != nil {
			return err
		}
		if sn.repos, err = tx.Repos(0); err != nil {
			return err
		}
		if sn.counts, err = tx.JobCounts(); err != nil {
			return err
		}
		sn.open, err = tx.OpenJobs()
		return err
	})
	return sn, err
}

func (s *Server) status(id int64) engine.WorkerStatus {
	if s.d.Workers == nil {
		return engine.WorkerStatus{}
	}
	return s.d.Workers.Status(id)
}

func (s *Server) workerViews(sn *snapshot) []workerView {
	out := make([]workerView, 0, len(sn.workers))
	for _, w := range sn.workers {
		w.HostKey = strings.TrimSpace(w.HostKey)
		st := s.status(w.ID)
		out = append(out, workerView{
			Worker:   w,
			Capacity: engine.CapacityOf(sn.set, w, sn.runners, st, sn.now),
			Live:     liveOf(st),
			Task:     s.tasks.latest("prepare", workerTarget(w.ID)),
		})
	}
	return out
}

func workerTarget(id int64) string { return "worker:" + strconv.FormatInt(id, 10) }

// --- overview ----------------------------------------------------------------

type link struct {
	Label    string `json:"label"`
	Href     string `json:"href"`
	External bool   `json:"external,omitempty"`
}

// alert is something that needs attention, with what to do about it.
type alert struct {
	Key    string `json:"key"`
	Level  string `json:"level"` // error, warning, info
	Title  string `json:"title"`
	Text   string `json:"text"`
	Action *link  `json:"action,omitempty"`
}

type activity struct {
	model.Event
	Subject string `json:"subject"` // the job or worker the event is about
	Href    string `json:"href"`
}

type overviewResp struct {
	Running       int          `json:"running"`  // jobs on a runner
	Starting      int          `json:"starting"` // jobs whose runner is starting
	Queued        int          `json:"queued"`
	OldestQueued  int64        `json:"oldestQueued"` // Unix ms, 0 = none
	WorkersOnline int          `json:"workersOnline"`
	WorkersTotal  int          `json:"workersTotal"`
	WorkersOff    int          `json:"workersOff"`
	MedianWaitMs  int64        `json:"medianWaitMs"`
	WaitSamples   int          `json:"waitSamples"`
	Completed24h  int          `json:"completed24h"`
	Workers       []workerView `json:"workers"`
	Open          []jobView    `json:"open"` // running first, then the longest waiting; at most 8
	Alerts        []alert      `json:"alerts"`
	Activity      []activity   `json:"activity"`
	Tunnel        TunnelStatus `json:"tunnel"`
	Accounts      int          `json:"accounts"`
	Repos         int          `json:"repos"`
}

func (s *Server) overview(w http.ResponseWriter, r *http.Request) {
	sn, err := s.snapshot()
	if err != nil {
		s.fail(w, err)
		return
	}
	resp := overviewResp{Workers: s.workerViews(sn), Accounts: len(sn.accounts), Repos: len(sn.repos)}
	for _, j := range sn.open {
		switch j.State {
		case model.JobQueued:
			resp.Queued++
			if resp.OldestQueued == 0 || j.WaitingSince < resp.OldestQueued {
				resp.OldestQueued = j.WaitingSince
			}
		case model.JobAssigned:
			resp.Starting++
		case model.JobRunning:
			resp.Running++
		}
	}
	for _, wv := range resp.Workers {
		resp.WorkersTotal++
		if !wv.Enabled {
			resp.WorkersOff++
		}
		if wv.State == model.WorkerOnline && wv.Live.Connected {
			resp.WorkersOnline++
		}
	}
	since := sn.now - 24*3600*1000
	err = s.d.Store.View(func(tx *store.Tx) error {
		var err error
		if resp.MedianWaitMs, resp.WaitSamples, err = tx.WaitStats(since); err != nil {
			return err
		}
		_, resp.Completed24h, err = tx.ListJobs(store.JobFilter{States: []string{model.JobCompleted}, Limit: 1})
		if err != nil {
			return err
		}
		resp.Activity, err = s.activity(tx, sn, 12)
		if err != nil {
			return err
		}
		open := append([]model.Job{}, sn.open...)
		rank := map[string]int{model.JobRunning: 0, model.JobAssigned: 1, model.JobQueued: 2}
		sort.SliceStable(open, func(a, b int) bool { return rank[open[a].State] < rank[open[b].State] })
		if len(open) > 8 {
			open = open[:8]
		}
		resp.Open = make([]jobView, 0, len(open))
		for _, j := range open {
			resp.Open = append(resp.Open, jobWithRunner(tx, j, sn.workers))
		}
		return nil
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	if s.d.Cloudflare != nil {
		resp.Tunnel = s.d.Cloudflare.Status()
	}
	resp.Alerts = s.alerts(sn, resp.Workers, resp.Tunnel)
	writeJSON(w, http.StatusOK, resp)
}

// activity is the latest events, each named after what it is about.
func (s *Server) activity(tx *store.Tx, sn *snapshot, n int) ([]activity, error) {
	evs, err := tx.Events(store.EventFilter{Limit: n, Newest: true})
	if err != nil {
		return nil, err
	}
	names := map[int64]string{}
	for _, w := range sn.workers {
		names[w.ID] = w.Name
	}
	out := make([]activity, 0, len(evs))
	for _, e := range evs {
		a := activity{Event: e}
		switch {
		case e.JobID != 0:
			if j, err := tx.Job(e.JobID); err == nil {
				a.Subject = j.Repo + " · " + j.Name
			}
			a.Href = fmt.Sprintf("#/jobs?open=%d", e.JobID)
		case model.IsPool(e.WorkerID):
			a.Subject = poolName(tx, e.WorkerID)
			a.Href = fmt.Sprintf("#/workers?pool=%d", -e.WorkerID)
		case e.WorkerID != 0:
			a.Subject = names[e.WorkerID]
			a.Href = fmt.Sprintf("#/workers?open=%d", e.WorkerID)
		}
		out = append(out, a)
	}
	return out, nil
}

// alerts lists what needs attention, most urgent first.
func (s *Server) alerts(sn *snapshot, workers []workerView, tunnel TunnelStatus) []alert {
	out := []alert{}
	add := func(a alert) { out = append(out, a) }
	if tunnel.Configured && (!tunnel.Running || !tunnel.Connected || tunnel.Error != "") {
		text := "GitHub cannot deliver new jobs and nobody can sign in from outside. CI-Plane restarts the tunnel by itself; if this stays, repair it in the settings."
		if tunnel.Error != "" {
			text = tunnel.Error + ". " + text
		}
		add(alert{Key: "tunnel", Level: "error", Title: "The tunnel to Cloudflare is down", Text: text,
			Action: &link{Label: "Open settings", Href: "#/settings?section=cloudflare"}})
	}
	for _, w := range workers {
		open := &link{Label: "Open " + w.Name, Href: fmt.Sprintf("#/workers?open=%d", w.ID)}
		if !w.Enabled {
			continue
		}
		switch w.State {
		case model.WorkerUnreachable:
			add(alert{Key: fmt.Sprintf("w%d-unreachable", w.ID), Level: "error", Title: w.Name + " is unreachable",
				Text: orDefault(w.StateReason, "The SSH connection is lost") + ". Jobs go to other workers meanwhile. Check that the server is on and reachable; CI-Plane reconnects by itself.", Action: open})
		case model.WorkerUnhealthy:
			add(alert{Key: fmt.Sprintf("w%d-unhealthy", w.ID), Level: "error", Title: w.Name + " takes no jobs",
				Text: orDefault(w.StateReason, "Runners failed to start") + ". Look at its recent events for the cause.", Action: open})
		case model.WorkerDiskFull:
			add(alert{Key: fmt.Sprintf("w%d-disk", w.ID), Level: "warning", Title: w.Name + " is low on disk space",
				Text: orDefault(w.StateReason, "Free disk is under the threshold") + ". It takes no jobs until space is back. Clean it up or free space on the server.", Action: open})
		case model.WorkerSetup:
			if w.Task != nil && w.Task.State == TaskRunning {
				continue
			}
			text := "CI-Plane could not connect to it yet."
			if w.Task != nil && w.Task.State == TaskFailed {
				text = "Its preparation failed: " + w.Task.Error
			} else if w.StateReason != "" {
				text = w.StateReason + "."
			}
			add(alert{Key: fmt.Sprintf("w%d-setup", w.ID), Level: "warning", Title: w.Name + " is not ready yet", Text: text, Action: open})
		}
	}
	for _, a := range sn.accounts {
		if a.InstallationID == 0 {
			l := &link{Label: "Install the app", Href: "#/repositories"}
			if s.d.GitHub != nil {
				l = &link{Label: "Install on GitHub", Href: s.d.GitHub.InstallURL(a), External: true}
			}
			add(alert{Key: fmt.Sprintf("a%d-install", a.ID), Level: "warning", Title: "The GitHub App of " + a.Owner + " is not installed",
				Text: "It was created, but no repository uses it yet, so no jobs arrive from " + a.Owner + ". Install it on the repositories that should use CI-Plane.", Action: l})
		} else if s.d.GitHub != nil && a.Enabled {
			if h := s.d.GitHub.Health(a.ID); h.LastError != "" {
				add(alert{Key: fmt.Sprintf("a%d-error", a.ID), Level: "warning", Title: "GitHub reports a problem for " + a.Owner, Text: h.LastError,
					Action: &link{Label: "Open repositories", Href: "#/repositories"}})
			}
		}
	}
	// Jobs that wait long, with the reason of the oldest.
	var long []model.Job
	for _, j := range sn.open {
		if j.State == model.JobQueued && j.WaitingSince > 0 && sn.now-j.WaitingSince > 5*60*1000 {
			long = append(long, j)
		}
	}
	if len(long) > 0 {
		sort.Slice(long, func(a, b int) bool { return long[a].WaitingSince < long[b].WaitingSince })
		title := "1 job has waited more than 5 minutes"
		if len(long) > 1 {
			title = fmt.Sprintf("%d jobs have waited more than 5 minutes", len(long))
		}
		why := orDefault(long[0].Reason, "No runner could be started for it yet")
		add(alert{Key: "jobs-waiting", Level: "warning", Title: title,
			Text: why + ". Add a worker, switch one on, or raise the limits of the repository.", Action: &link{Label: "Show waiting jobs", Href: "#/jobs?state=queued"}})
	}
	if len(sn.workers) == 0 {
		add(alert{Key: "no-workers", Level: "info", Title: "No worker yet", Text: "Jobs wait until a server is added that can run them.",
			Action: &link{Label: "Add a worker", Href: "#/workers/add"}})
	}
	if len(sn.accounts) == 0 {
		add(alert{Key: "no-accounts", Level: "info", Title: "No GitHub account connected", Text: "Connect a personal account or an organisation, so its jobs come to CI-Plane.",
			Action: &link{Label: "Connect GitHub", Href: "#/repositories/add"}})
	}
	rank := map[string]int{"error": 0, "warning": 1, "info": 2}
	sort.SliceStable(out, func(a, b int) bool { return rank[out[a].Level] < rank[out[b].Level] })
	return out
}

func orDefault(s, def string) string {
	s = strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(s), "."))
	if s == "" {
		return def
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// --- jobs --------------------------------------------------------------------

type jobView struct {
	model.Job
	Worker   string `json:"worker"`   // name of the worker of its runner
	WorkerID int64  `json:"workerId"` // 0 = none
	Runner   string `json:"runner"`   // runner name
}

// jobStates maps the filter chips of the interface to job states.
var jobStates = map[string][]string{
	"queued":    {model.JobQueued},
	"running":   {model.JobAssigned, model.JobRunning},
	"completed": {model.JobCompleted},
	"ignored":   {model.JobIgnored},
}

func (s *Server) listJobs(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	f := store.JobFilter{Search: strings.TrimSpace(q.Get("q"))}
	for _, part := range strings.Split(q.Get("state"), ",") {
		if states, ok := jobStates[strings.TrimSpace(part)]; ok {
			f.States = append(f.States, states...)
		}
	}
	f.Limit, _ = strconv.Atoi(q.Get("limit"))
	if f.Limit <= 0 || f.Limit > 200 {
		f.Limit = 25
	}
	f.Offset, _ = strconv.Atoi(q.Get("offset"))
	if f.Offset < 0 {
		f.Offset = 0
	}
	var resp struct {
		Jobs   []jobView      `json:"jobs"`
		Total  int            `json:"total"`
		Counts map[string]int `json:"counts"`
	}
	err := s.d.Store.View(func(tx *store.Tx) error {
		jobs, total, err := tx.ListJobs(f)
		if err != nil {
			return err
		}
		resp.Total = total
		raw, err := tx.JobCounts()
		if err != nil {
			return err
		}
		resp.Counts = map[string]int{}
		for chip, states := range jobStates {
			for _, st := range states {
				resp.Counts[chip] += raw[st]
			}
		}
		workers, err := tx.Workers()
		if err != nil {
			return err
		}
		resp.Jobs = make([]jobView, 0, len(jobs))
		for _, j := range jobs {
			resp.Jobs = append(resp.Jobs, jobWithRunner(tx, j, workers))
		}
		return nil
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func jobWithRunner(tx *store.Tx, j model.Job, workers []model.Worker) jobView {
	v := jobView{Job: j}
	if j.Labels == nil {
		v.Labels = []string{}
	}
	if j.RunnerID == "" {
		return v
	}
	if rn, err := tx.Runner(j.RunnerID); err == nil {
		v.Runner, v.WorkerID = rn.Name, rn.WorkerID
		if model.IsPool(rn.WorkerID) {
			v.Worker = poolName(tx, rn.WorkerID)
		}
		for _, w := range workers {
			if w.ID == rn.WorkerID {
				v.Worker = w.Name
			}
		}
	}
	return v
}

func (s *Server) getJob(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var resp struct {
		Job     jobView       `json:"job"`
		Events  []model.Event `json:"events"`
		Account string        `json:"account"`
	}
	err := s.d.Store.View(func(tx *store.Tx) error {
		j, err := tx.Job(id)
		if err != nil {
			return err
		}
		workers, err := tx.Workers()
		if err != nil {
			return err
		}
		resp.Job = jobWithRunner(tx, j, workers)
		if a, err := tx.Account(j.AccountID); err == nil {
			resp.Account = a.Owner
		}
		resp.Events, err = tx.Events(store.EventFilter{JobID: id, Limit: 500})
		return err
	})
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "This job is not known (any more): finished jobs are kept for the days set under Settings.")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, resp)
}
