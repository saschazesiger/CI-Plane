package api

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

const maxTier = 9

// changedWorkers tells the services and the engine that workers or settings
// changed, and the interface that it should refetch.
func (s *Server) changedWorkers() {
	if s.d.Workers != nil {
		s.d.Workers.Changed()
	}
	if s.d.Engine != nil {
		s.d.Engine.Kick()
	}
	s.hub.notify("state")
}

func (s *Server) listWorkers(w http.ResponseWriter, r *http.Request) {
	sn, err := s.snapshot()
	if err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workers": s.workerViews(sn)})
}

func (s *Server) workerCommands(w http.ResponseWriter, r *http.Request) {
	if s.d.Workers == nil {
		writeError(w, http.StatusServiceUnavailable, "Workers are not available.")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{
		"setup":     s.d.Workers.SetupCommand(),
		"remove":    s.d.Workers.RemoveCommand(),
		"publicKey": s.d.Workers.PublicKey(),
	})
}

func (s *Server) getWorker(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	sn, err := s.snapshot()
	if err != nil {
		s.fail(w, err)
		return
	}
	var resp struct {
		Worker  workerView     `json:"worker"`
		Runners []model.Runner `json:"runners"`
		Events  []model.Event  `json:"events"`
		Remove  string         `json:"removeCommand"`
	}
	found := false
	for _, v := range s.workerViews(sn) {
		if v.ID == id {
			resp.Worker, found = v, true
		}
	}
	if !found {
		writeError(w, http.StatusNotFound, "This worker does not exist any more.")
		return
	}
	err = s.d.Store.View(func(tx *store.Tx) error {
		var err error
		if resp.Runners, err = tx.RunnersOfWorker(id, 8); err != nil {
			return err
		}
		resp.Events, err = tx.Events(store.EventFilter{WorkerID: id, Limit: 15, Newest: true})
		return err
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	if s.d.Workers != nil {
		resp.Remove = s.d.Workers.RemoveCommand()
	}
	writeJSON(w, http.StatusOK, resp)
}

type hostReq struct {
	Host string `json:"host"`
	Port int    `json:"port"`
	User string `json:"user"`
}

var hostRe = regexp.MustCompile(`^[A-Za-z0-9]([A-Za-z0-9.\-:]*[A-Za-z0-9])?$`)

// clean checks an address and fills in the defaults.
func (h *hostReq) clean() map[string]string {
	errs := map[string]string{}
	h.Host = strings.TrimSpace(h.Host)
	h.User = strings.TrimSpace(h.User)
	// People paste "user@host:port" or "ssh://..."; take it apart.
	h.Host = strings.TrimPrefix(h.Host, "ssh://")
	if at := strings.LastIndex(h.Host, "@"); at > 0 {
		if h.User == "" {
			h.User = h.Host[:at]
		}
		h.Host = h.Host[at+1:]
	}
	if host, port, err := net.SplitHostPort(h.Host); err == nil && h.Port == 0 {
		h.Host = host
		fmt.Sscan(port, &h.Port)
	}
	h.Host = strings.Trim(h.Host, "[]")
	if h.Port == 0 {
		h.Port = 22
	}
	if h.User == "" {
		h.User = "ci-plane"
	}
	switch {
	case h.Host == "":
		errs["host"] = "Enter the address of the server: a name like build-1.lan or an IP address."
	case !hostRe.MatchString(h.Host):
		errs["host"] = "This is not an address. Use a host name like build-1.lan or an IP address like 192.168.1.20."
	}
	if h.Port < 1 || h.Port > 65535 {
		errs["port"] = "The SSH port is a number from 1 to 65535, usually 22."
	}
	if !regexp.MustCompile(`^[a-z_][a-z0-9_.-]{0,31}$`).MatchString(h.User) {
		errs["user"] = "Use the user the setup command created: ci-plane."
	}
	return errs
}

func (s *Server) checkWorker(w http.ResponseWriter, r *http.Request) {
	var req hostReq
	if !decode(w, r, &req) {
		return
	}
	if errs := req.clean(); len(errs) > 0 {
		writeJSON(w, http.StatusBadRequest, apiError{Error: firstOf(errs), Fields: errs})
		return
	}
	if name := s.workerAt(req.Host, req.Port); name != "" {
		msg := "This server is added already, as " + name + "."
		writeJSON(w, http.StatusConflict, apiError{Error: msg, Fields: map[string]string{"host": msg}})
		return
	}
	if s.d.Workers == nil {
		writeError(w, http.StatusServiceUnavailable, "Workers are not available.")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	facts, err := s.d.Workers.Check(ctx, req.Host, req.Port, req.User)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"host": req.Host, "port": req.Port, "user": req.User, "facts": facts})
}

// workerAt returns the name of the worker at an address, if there is one.
func (s *Server) workerAt(host string, port int) string {
	name := ""
	_ = s.d.Store.View(func(tx *store.Tx) error {
		ws, err := tx.Workers()
		for _, w := range ws {
			if strings.EqualFold(w.Host, host) && w.Port == port {
				name = w.Name
			}
		}
		return err
	})
	return name
}

type addWorkerReq struct {
	hostReq
	Name  string      `json:"name"`
	Tier  int         `json:"tier"`
	Facts WorkerFacts `json:"facts"`
}

func (s *Server) addWorker(w http.ResponseWriter, r *http.Request) {
	var req addWorkerReq
	if !decode(w, r, &req) {
		return
	}
	errs := req.clean()
	req.Name = strings.TrimSpace(req.Name)
	if req.Name == "" {
		req.Name = defaultName(req.Host)
	}
	if req.Tier == 0 {
		req.Tier = 1
	}
	if msg := s.checkName(req.Name, 0); msg != "" {
		errs["name"] = msg
	}
	if req.Tier < 1 || req.Tier > maxTier {
		errs["tier"] = fmt.Sprintf("The tier is a number from 1 to %d; 1 is filled first.", maxTier)
	}
	if strings.TrimSpace(req.Facts.HostKey) == "" {
		errs["host"] = "Connect to the server first, so its host key can be pinned."
	}
	if len(errs) > 0 {
		writeJSON(w, http.StatusBadRequest, apiError{Error: firstOf(errs), Fields: errs})
		return
	}
	if name := s.workerAt(req.Host, req.Port); name != "" {
		writeError(w, http.StatusConflict, "This server is added already, as "+name+".")
		return
	}
	var wk model.Worker
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		ws, err := tx.Workers()
		if err != nil {
			return err
		}
		pos := 0
		for _, o := range ws {
			if o.Tier == req.Tier && o.Position >= pos {
				pos = o.Position + 1
			}
		}
		wk, err = tx.AddWorker(model.Worker{
			Name: req.Name, Host: req.Host, Port: req.Port, User: req.User, HostKey: strings.TrimSpace(req.Facts.HostKey),
			Tier: req.Tier, Position: pos, Enabled: true, State: model.WorkerSetup,
			CPUs: req.Facts.CPUs, MemMB: req.Facts.MemMB, DiskMB: req.Facts.DiskMB, Docker: req.Facts.Docker,
		})
		if err != nil {
			return err
		}
		_, err = tx.AddEvent(model.Event{Kind: "worker.added", WorkerID: wk.ID,
			Message: fmt.Sprintf("Added with host key %s; %d CPUs, %s memory", req.Facts.Fingerprint, req.Facts.CPUs, gb(req.Facts.MemMB))})
		return err
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	task := s.startPrepare(wk)
	writeJSON(w, http.StatusCreated, map[string]any{"worker": wk, "task": task})
}

// startPrepare runs Workers.Prepare as a task, once per worker at a time.
func (s *Server) startPrepare(wk model.Worker) Task {
	task, _ := s.tasks.start("prepare", workerTarget(wk.ID), "Prepare "+wk.Name, 30*time.Minute,
		func(ctx context.Context, progress func(string)) (string, error) {
			err := s.d.Workers.Prepare(ctx, wk, progress)
			_ = s.d.Store.Tx(func(tx *store.Tx) error {
				e := model.Event{Kind: "worker.prepared", WorkerID: wk.ID, Message: "Prepared: images pulled, mirror running, test container passed"}
				if err != nil {
					e = model.Event{Kind: "worker.prepare-failed", Level: model.LevelWarn, WorkerID: wk.ID, Message: "Preparation failed: " + err.Error()}
				}
				_, aerr := tx.AddEvent(e)
				return aerr
			})
			s.changedWorkers()
			if err != nil {
				return "", err
			}
			return wk.Name + " is ready for jobs.", nil
		})
	return task
}

func (s *Server) prepareWorker(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var wk model.Worker
	if err := s.d.Store.View(func(tx *store.Tx) error {
		var err error
		wk, err = tx.Worker(id)
		return err
	}); err != nil {
		s.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"task": s.startPrepare(wk)})
}

// defaultName makes a short name from an address: "build-1" from
// "build-1.lan", the address itself for an IP.
func defaultName(host string) string {
	if net.ParseIP(host) != nil {
		return host
	}
	if i := strings.Index(host, "."); i > 0 {
		return host[:i]
	}
	return host
}

func (s *Server) checkName(name string, self int64) string {
	if name == "" {
		return "Give the worker a name."
	}
	if len([]rune(name)) > 40 {
		return "Use at most 40 characters."
	}
	taken := ""
	_ = s.d.Store.View(func(tx *store.Tx) error {
		ws, err := tx.Workers()
		for _, w := range ws {
			if w.ID != self && strings.EqualFold(w.Name, name) {
				taken = "Another worker is called " + w.Name + " already. Pick another name."
			}
		}
		return err
	})
	return taken
}

type editWorkerReq struct {
	Name     *string `json:"name"`
	Tier     *int    `json:"tier"`
	Enabled  *bool   `json:"enabled"`
	Draining *bool   `json:"draining"`
}

func (s *Server) editWorker(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var req editWorkerReq
	if !decode(w, r, &req) {
		return
	}
	errs := map[string]string{}
	if req.Name != nil {
		*req.Name = strings.TrimSpace(*req.Name)
		if msg := s.checkName(*req.Name, id); msg != "" {
			errs["name"] = msg
		}
	}
	if req.Tier != nil && (*req.Tier < 1 || *req.Tier > maxTier) {
		errs["tier"] = fmt.Sprintf("The tier is a number from 1 to %d; 1 is filled first.", maxTier)
	}
	if len(errs) > 0 {
		writeJSON(w, http.StatusBadRequest, apiError{Error: firstOf(errs), Fields: errs})
		return
	}
	var wk model.Worker
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		var err error
		if wk, err = tx.Worker(id); err != nil {
			return err
		}
		note := func(msg string) {
			_, _ = tx.AddEvent(model.Event{Kind: "worker.changed", WorkerID: id, Message: msg})
		}
		if req.Name != nil && *req.Name != wk.Name {
			note("Renamed from " + wk.Name + " to " + *req.Name)
			wk.Name = *req.Name
		}
		if req.Tier != nil && *req.Tier != wk.Tier {
			ws, err := tx.Workers()
			if err != nil {
				return err
			}
			pos := 0
			for _, o := range ws {
				if o.Tier == *req.Tier && o.Position >= pos {
					pos = o.Position + 1
				}
			}
			note(fmt.Sprintf("Moved from tier %d to tier %d", wk.Tier, *req.Tier))
			wk.Tier, wk.Position = *req.Tier, pos
		}
		if req.Enabled != nil && *req.Enabled != wk.Enabled {
			wk.Enabled = *req.Enabled
			if wk.Enabled {
				note("Switched on: takes jobs again")
			} else {
				note("Switched off: takes no new jobs; running jobs finish")
			}
		}
		if req.Draining != nil && *req.Draining != wk.Draining {
			wk.Draining = *req.Draining
			if wk.Draining {
				note("Draining: takes no new jobs; running jobs finish")
			} else {
				note("Draining stopped: takes jobs again")
			}
		}
		return tx.SaveWorker(wk)
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]any{"worker": wk})
}

type orderReq struct {
	Order []struct {
		ID   int64 `json:"id"`
		Tier int   `json:"tier"`
	} `json:"order"`
}

// orderWorkers sets tiers and positions of many workers in one go: the
// order of the list is the order in each tier.
func (s *Server) orderWorkers(w http.ResponseWriter, r *http.Request) {
	var req orderReq
	if !decode(w, r, &req) {
		return
	}
	seen := map[int64]bool{}
	for _, o := range req.Order {
		if o.Tier < 1 || o.Tier > maxTier {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("A tier is a number from 1 to %d.", maxTier))
			return
		}
		if seen[o.ID] {
			writeError(w, http.StatusBadRequest, "A worker appears twice in the new order. Reload the page and try again.")
			return
		}
		seen[o.ID] = true
	}
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		pos := map[int]int{}
		for _, o := range req.Order {
			wk, err := tx.Worker(o.ID)
			if err != nil {
				return err
			}
			if wk.Tier != o.Tier {
				_, _ = tx.AddEvent(model.Event{Kind: "worker.changed", WorkerID: wk.ID, Message: fmt.Sprintf("Moved from tier %d to tier %d", wk.Tier, o.Tier)})
			}
			wk.Tier, wk.Position = o.Tier, pos[o.Tier]
			pos[o.Tier]++
			if err := tx.SaveWorker(wk); err != nil {
				return err
			}
		}
		return nil
	})
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusConflict, "One of these workers was removed meanwhile. Reload the page and try again.")
		return
	}
	if err != nil {
		s.fail(w, err)
		return
	}
	s.changedWorkers()
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) removeWorker(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	force := r.URL.Query().Get("force") == "true" || r.URL.Query().Get("force") == "1"
	var wk model.Worker
	active := 0
	refused := false
	err := s.d.Store.Tx(func(tx *store.Tx) error {
		var err error
		if wk, err = tx.Worker(id); err != nil {
			return err
		}
		runners, err := tx.ActiveRunners()
		if err != nil {
			return err
		}
		var mine []model.Runner
		for _, rn := range runners {
			if rn.WorkerID == id {
				mine = append(mine, rn)
			}
		}
		active = len(mine)
		if active > 0 && !force {
			refused = true
			return nil
		}
		// Removed with runners on it: they are ended the way the engine ends
		// them (cleaning; a job still waiting for one is queued again), so
		// their registrations on GitHub go and their jobs start elsewhere.
		// Their containers stay on the server, which the remove command
		// cleans up.
		now := time.Now().UnixMilli()
		for _, rn := range mine {
			if rn.State != model.RunnerCleaning {
				rn.State, rn.EndedAt = model.RunnerCleaning, now
				rn.Error = "the worker was removed"
				if err := tx.SaveRunner(rn); err != nil {
					return err
				}
			}
			if j, err := tx.Job(rn.JobID); err == nil && j.State == model.JobAssigned && j.RunnerID == rn.ID {
				j.State, j.RunnerID = model.JobQueued, ""
				if err := tx.SaveJob(j); err != nil {
					return err
				}
				_, _ = tx.AddEvent(model.Event{Kind: "job.requeued", JobID: j.ID, Message: "Its worker " + wk.Name + " was removed; a new runner will be started elsewhere"})
			}
		}
		if err := tx.DeleteWorker(id); err != nil {
			return err
		}
		_, err = tx.AddEvent(model.Event{Kind: "worker.removed", Level: model.LevelWarn, Message: "Worker " + wk.Name + " (" + wk.Host + ") was removed"})
		return err
	})
	if err != nil {
		s.fail(w, err)
		return
	}
	if refused {
		msg := fmt.Sprintf("%s still runs %d runner%s. Drain it and wait until they are done, or remove it anyway: waiting jobs then start on another worker, and running ones are lost.", wk.Name, active, plural(active))
		writeJSON(w, http.StatusConflict, map[string]any{"error": msg, "runners": active})
		return
	}
	s.changedWorkers()
	cmd := ""
	if s.d.Workers != nil {
		cmd = s.d.Workers.RemoveCommand()
	}
	writeJSON(w, http.StatusOK, map[string]string{"removeCommand": cmd, "message": wk.Name + " was removed."})
}

func (s *Server) cleanupWorker(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r)
	if !ok {
		return
	}
	var wk model.Worker
	if err := s.d.Store.View(func(tx *store.Tx) error {
		var err error
		wk, err = tx.Worker(id)
		return err
	}); err != nil {
		s.fail(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 3*time.Minute)
	defer cancel()
	msg, err := s.d.Workers.Cleanup(ctx, wk)
	_ = s.d.Store.Tx(func(tx *store.Tx) error {
		e := model.Event{Kind: "worker.cleanup", WorkerID: id, Message: "Cleaned up: " + msg}
		if err != nil {
			e = model.Event{Kind: "worker.cleanup", Level: model.LevelWarn, WorkerID: id, Message: "Cleanup failed: " + err.Error()}
		}
		_, aerr := tx.AddEvent(e)
		return aerr
	})
	s.changedWorkers()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, apiError{Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"message": msg})
}

func firstOf(errs map[string]string) string {
	keys := make([]string, 0, len(errs))
	for k := range errs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	if len(keys) == 0 {
		return ""
	}
	return errs[keys[0]]
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func gb(mb int) string {
	return fmt.Sprintf("%.0f GB", float64(mb)/1024)
}
