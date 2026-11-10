package api

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

// Task states.
const (
	TaskRunning = "running"
	TaskDone    = "done"
	TaskFailed  = "failed"
)

// TaskStep is one progress line of a task.
type TaskStep struct {
	At   int64  `json:"at"`
	Text string `json:"text"`
}

// Task is a long operation that runs in the background (preparing a worker,
// setting up the tunnel). It lives in memory: a page reload finds it again,
// a restart of CI-Plane ends it.
type Task struct {
	ID        string     `json:"id"`
	Kind      string     `json:"kind"`   // prepare, cloudflare
	Target    string     `json:"target"` // worker:3, tunnel
	Title     string     `json:"title"`
	State     string     `json:"state"`
	Steps     []TaskStep `json:"steps"`
	Error     string     `json:"error"`
	Message   string     `json:"message"` // what to say on success
	StartedAt int64      `json:"startedAt"`
	EndedAt   int64      `json:"endedAt"`
}

type tasks struct {
	ctx    context.Context
	notify func()
	mu     sync.Mutex
	all    map[string]*Task
}

func newTasks(ctx context.Context, notify func()) *tasks {
	return &tasks{ctx: ctx, notify: notify, all: map[string]*Task{}}
}

func newTaskID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// start runs fn in the background unless a task of the same kind runs for
// the same target already; then that one is returned and started is false.
// fn's error text is shown to the user as it is.
func (t *tasks) start(kind, target, title string, timeout time.Duration, fn func(ctx context.Context, progress func(string)) (string, error)) (task Task, started bool) {
	t.mu.Lock()
	for _, x := range t.all {
		if x.Kind == kind && x.Target == target && x.State == TaskRunning {
			cp := x.copy()
			t.mu.Unlock()
			return cp, false
		}
	}
	x := &Task{ID: newTaskID(), Kind: kind, Target: target, Title: title, State: TaskRunning, Steps: []TaskStep{}, StartedAt: time.Now().UnixMilli()}
	t.all[x.ID] = x
	t.pruneLocked()
	cp := x.copy()
	t.mu.Unlock()
	t.notify()

	go func() {
		ctx, cancel := context.WithTimeout(t.ctx, timeout)
		defer cancel()
		progress := func(step string) {
			t.mu.Lock()
			x.Steps = append(x.Steps, TaskStep{At: time.Now().UnixMilli(), Text: step})
			t.mu.Unlock()
			t.notify()
		}
		var msg string
		var err error
		func() {
			defer func() {
				if p := recover(); p != nil {
					err = fmt.Errorf("an internal error stopped this step (%v); try again", p)
				}
			}()
			msg, err = fn(ctx, progress)
		}()
		if err == nil && ctx.Err() == context.DeadlineExceeded {
			err = fmt.Errorf("this took longer than %s and was stopped; try again", timeout)
		}
		t.mu.Lock()
		x.EndedAt = time.Now().UnixMilli()
		if err != nil {
			x.State, x.Error = TaskFailed, err.Error()
		} else {
			x.State, x.Message = TaskDone, msg
		}
		t.mu.Unlock()
		t.notify()
	}()
	return cp, true
}

func (x *Task) copy() Task {
	cp := *x
	cp.Steps = append([]TaskStep{}, x.Steps...)
	return cp
}

// pruneLocked forgets finished tasks after an hour, keeping at most 50.
func (t *tasks) pruneLocked() {
	cutoff := time.Now().Add(-time.Hour).UnixMilli()
	var ended []*Task
	for id, x := range t.all {
		if x.State != TaskRunning {
			if x.EndedAt < cutoff {
				delete(t.all, id)
				continue
			}
			ended = append(ended, x)
		}
	}
	if len(ended) > 50 {
		sort.Slice(ended, func(a, b int) bool { return ended[a].EndedAt < ended[b].EndedAt })
		for _, x := range ended[:len(ended)-50] {
			delete(t.all, x.ID)
		}
	}
}

func (t *tasks) get(id string) (Task, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	x, ok := t.all[id]
	if !ok {
		return Task{}, false
	}
	return x.copy(), true
}

// list returns the tasks, newest first.
func (t *tasks) list() []Task {
	t.mu.Lock()
	defer t.mu.Unlock()
	out := make([]Task, 0, len(t.all))
	for _, x := range t.all {
		out = append(out, x.copy())
	}
	sort.Slice(out, func(a, b int) bool { return out[a].StartedAt > out[b].StartedAt })
	return out
}

// latest returns the newest task for a target, running or not.
func (t *tasks) latest(kind, target string) *Task {
	for _, x := range t.list() {
		if x.Kind == kind && x.Target == target {
			x := x
			return &x
		}
	}
	return nil
}

func (s *Server) listTasks(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"tasks": s.tasks.list()})
}

func (s *Server) getTask(w http.ResponseWriter, r *http.Request) {
	x, ok := s.tasks.get(r.PathValue("id"))
	if !ok {
		writeError(w, http.StatusNotFound, "This task is over and was forgotten, or CI-Plane restarted meanwhile.")
		return
	}
	writeJSON(w, http.StatusOK, x)
}
