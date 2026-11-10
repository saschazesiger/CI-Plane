package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"sync"
	"time"
)

// coalesce is how long a stream waits after the first change before it
// writes, so a burst of changes is one message.
const coalesce = 250 * time.Millisecond

// hub fans change notices out to the open event streams. A notice carries
// only topics ("state", "tasks", "live"); the interface refetches what it
// shows.
type hub struct {
	mu      sync.Mutex
	clients map[*streamClient]struct{}
	closed  bool
}

type streamClient struct {
	wake   chan struct{}
	mu     sync.Mutex
	topics map[string]bool
	done   chan struct{}
}

func newHub() *hub { return &hub{clients: map[*streamClient]struct{}{}} }

func (h *hub) notify(topics ...string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		c.mu.Lock()
		for _, t := range topics {
			c.topics[t] = true
		}
		c.mu.Unlock()
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
}

func (h *hub) add() *streamClient {
	c := &streamClient{wake: make(chan struct{}, 1), topics: map[string]bool{}, done: make(chan struct{})}
	h.mu.Lock()
	if h.closed {
		close(c.done)
	} else {
		h.clients[c] = struct{}{}
	}
	h.mu.Unlock()
	return c
}

func (h *hub) remove(c *streamClient) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
	}
	h.mu.Unlock()
}

func (h *hub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	for c := range h.clients {
		close(c.done)
		delete(h.clients, c)
	}
}

func (c *streamClient) take() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]string, 0, len(c.topics))
	for t := range c.topics {
		out = append(out, t)
	}
	c.topics = map[string]bool{}
	sort.Strings(out)
	return out
}

// events is the server-sent event stream of the interface.
func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "Live updates are not supported by this connection.")
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Accel-Buffering", "no") // proxies must not hold the stream back
	w.WriteHeader(http.StatusOK)
	fmt.Fprint(w, "retry: 3000\n\n")
	flusher.Flush()

	c := s.hub.add()
	defer s.hub.remove(c)
	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return
		case <-c.done:
			return
		case <-ping.C:
			// A comment keeps proxies and the tunnel from closing an idle stream.
			if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
				return
			}
			flusher.Flush()
		case <-c.wake:
			select {
			case <-time.After(coalesce):
			case <-ctx.Done():
				return
			case <-c.done:
				return
			}
			topics := c.take()
			if len(topics) == 0 {
				continue
			}
			b, _ := json.Marshal(map[string]any{"topics": topics})
			if _, err := fmt.Fprintf(w, "event: change\ndata: %s\n\n", b); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}
