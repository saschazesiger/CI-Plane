// Package node runs runners on workers: Linux servers with Docker that
// CI-Plane reaches over SSH. It implements engine.Fleet and api.Workers.
//
// Every worker has one persistent SSH connection. A long-running command on
// it streams the live values; Docker commands run as plain shell scripts in
// their own sessions, so nothing but Docker is installed on the worker.
package node

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

var (
	_ engine.Fleet = (*Manager)(nil)
	_ api.Workers  = (*Manager)(nil)
)

const (
	defaultUser = "ci-plane"
	keyName     = "ssh-key"
)

// Manager keeps the connections to the workers and runs Docker on them.
type Manager struct {
	st   *store.Store
	box  *secret.Box
	logf func(string, ...any)

	signer ssh.Signer
	pub    string // authorized_keys line

	// Replaced in tests.
	dial         func(ctx context.Context, w model.Worker) (transport, error)
	every        time.Duration // between two lines of live values
	staleAfter   time.Duration // no line for this long: reconnect
	janitorEvery time.Duration

	kick chan struct{}

	mu    sync.Mutex
	ctx   context.Context // of Run; nil before
	set   model.Settings
	conns map[int64]*conn
	jan   map[int64]*janitor
}

// conn is the connection to one worker and its live values.
type conn struct {
	w      model.Worker
	cancel context.CancelFunc
	done   chan struct{}
	wake   chan struct{}

	mu     sync.Mutex
	t      transport // nil while disconnected
	status engine.WorkerStatus
}

// New loads the SSH key of the installation, creating it on first use.
func New(st *store.Store, box *secret.Box, logf func(string, ...any)) (*Manager, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	m := &Manager{
		st: st, box: box, logf: logf,
		every: 5 * time.Second, staleAfter: 15 * time.Second, janitorEvery: 10 * time.Minute,
		kick: make(chan struct{}, 1), conns: map[int64]*conn{}, jan: map[int64]*janitor{},
		set: model.DefaultSettings(),
	}
	m.dial = m.dialWorker
	var pemKey []byte
	err := st.Tx(func(tx *store.Tx) error {
		b, err := box.Get(tx, keyName)
		if err == nil {
			pemKey = b
			return nil
		}
		if !errors.Is(err, store.ErrNotFound) {
			return err
		}
		_, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return err
		}
		blk, err := ssh.MarshalPrivateKey(priv, "ci-plane")
		if err != nil {
			return err
		}
		pemKey = pem.EncodeToMemory(blk)
		return box.Put(tx, keyName, pemKey)
	})
	if err != nil {
		return nil, fmt.Errorf("load the SSH key: %w", err)
	}
	if m.signer, err = ssh.ParsePrivateKey(pemKey); err != nil {
		return nil, fmt.Errorf("the stored SSH key is damaged: %w", err)
	}
	m.pub = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(m.signer.PublicKey()))) + " ci-plane"
	if err := m.loadSettings(); err != nil {
		return nil, err
	}
	return m, nil
}

// PublicKey implements api.Workers.
func (m *Manager) PublicKey() string { return m.pub }

func (m *Manager) loadSettings() error {
	var set model.Settings
	err := m.st.View(func(tx *store.Tx) (err error) { set, err = tx.Settings(); return })
	if err != nil {
		return fmt.Errorf("read settings: %w", err)
	}
	m.mu.Lock()
	m.set = set
	m.mu.Unlock()
	return nil
}

func (m *Manager) settings() model.Settings {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.set
}

// Changed implements api.Workers.
func (m *Manager) Changed() {
	select {
	case m.kick <- struct{}{}:
	default:
	}
}

// Run keeps the connections, the live values and the janitor going until
// ctx ends.
func (m *Manager) Run(ctx context.Context) {
	m.mu.Lock()
	m.ctx = ctx
	m.mu.Unlock()
	m.reload()
	for {
		select {
		case <-ctx.Done():
			m.mu.Lock()
			conns := m.conns
			m.conns = map[int64]*conn{}
			m.mu.Unlock()
			for _, c := range conns {
				c.cancel()
				<-c.done
			}
			return
		case <-m.kick:
			m.reload()
		}
	}
}

// reload brings the connections in line with the workers in the store.
func (m *Manager) reload() {
	if err := m.loadSettings(); err != nil {
		m.logf("node: %v", err)
	}
	var workers []model.Worker
	if err := m.st.View(func(tx *store.Tx) (err error) { workers, err = tx.Workers(); return }); err != nil {
		m.logf("node: read workers: %v", err)
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.ctx == nil || m.ctx.Err() != nil {
		return
	}
	keep := map[int64]bool{}
	for _, w := range workers {
		keep[w.ID] = true
		if c, ok := m.conns[w.ID]; ok {
			if sameAddr(c.w, w) {
				c.mu.Lock()
				c.w = w
				c.mu.Unlock()
				continue
			}
			c.cancel() // its goroutine ends by itself; a new one takes over
		}
		m.conns[w.ID] = m.connect(w)
	}
	for id, c := range m.conns {
		if !keep[id] {
			c.cancel()
			delete(m.conns, id)
			delete(m.jan, id)
			go m.forgetImages(id)
		}
	}
}

func sameAddr(a, b model.Worker) bool {
	return a.Host == b.Host && a.Port == b.Port && a.User == b.User && a.HostKey == b.HostKey
}

func (m *Manager) connect(w model.Worker) *conn {
	ctx, cancel := context.WithCancel(m.ctx)
	c := &conn{w: w, cancel: cancel, done: make(chan struct{}), wake: make(chan struct{}, 1),
		status: engine.WorkerStatus{Error: "Connecting"}}
	go m.keep(ctx, c)
	go m.janitorLoop(ctx, c)
	return c
}

// keep holds the connection open and reconnects with backoff.
func (m *Manager) keep(ctx context.Context, c *conn) {
	defer close(c.done)
	fails := 0
	for ctx.Err() == nil {
		w := c.worker()
		t, err := m.dial(ctx, w)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			if fails == 0 {
				m.logf("node: worker %s: %v", w.Name, err)
			}
			c.down(err.Error())
		} else {
			c.up(t)
			healthy := m.stream(ctx, c, t)
			t.close()
			c.mu.Lock()
			c.t = nil
			c.mu.Unlock()
			if ctx.Err() != nil {
				return
			}
			if healthy {
				fails = 0
				m.logf("node: worker %s: %s", w.Name, c.Status().Error)
			}
		}
		fails++
		select {
		case <-ctx.Done():
			return
		case <-c.wake:
		case <-time.After(backoff(fails)):
		}
	}
}

// backoff is 1 s, 2 s, 4 s ... up to 30 s.
func backoff(n int) time.Duration {
	d := time.Second
	for i := 1; i < n && d < 30*time.Second; i++ {
		d *= 2
	}
	return min(d, 30*time.Second)
}

func (c *conn) worker() model.Worker {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.w
}

func (c *conn) up(t transport) {
	c.mu.Lock()
	c.t = t
	c.status = engine.WorkerStatus{Connected: true}
	c.mu.Unlock()
}

func (c *conn) down(reason string) {
	c.mu.Lock()
	c.status.Connected, c.status.Error = false, reason
	c.mu.Unlock()
}

// Status implements engine.Fleet and api.Workers.
func (m *Manager) Status(workerID int64) engine.WorkerStatus {
	m.mu.Lock()
	c := m.conns[workerID]
	m.mu.Unlock()
	if c == nil {
		return engine.WorkerStatus{Error: "Not connected yet"}
	}
	return c.Status()
}

func (c *conn) Status() engine.WorkerStatus {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.status
}

// --- live values -------------------------------------------------------------

// statsScript prints one line of live values every interval. CPU use comes
// from the difference of two samples of /proc/stat; disk is the filesystem
// that holds Docker's data.
func statsScript(every time.Duration) string {
	sec := max(1, int(every.Seconds()))
	return `r=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || :
[ -n "$r" ] && [ -e "$r" ] || r=/var/lib/docker
[ -e "$r" ] || r=/
s() { awk '/^cpu /{print $2+$3+$4+$5+$6+$7+$8+$9, $5+$6}' /proc/stat; }
p=$(s); sleep 1
while :; do
  c=$(s)
  cpu=$(echo "$p $c" | awk '{t=$3-$1; i=$4-$2; printf "%.1f", (t > 0 ? 100*(t-i)/t : 0)}')
  mem=$(awk '/^MemAvailable:/{a=$2} /^MemTotal:/{t=$2} END{print int(a/1024), int(t/1024)}' /proc/meminfo)
  disk=$(df -Pm "$r" | awk 'NR==2{print $4, $2}')
  echo "stats $(cut -d' ' -f1 /proc/loadavg) $cpu $mem $disk"
  p=$c
  sleep ` + strconv.Itoa(sec) + `
done`
}

// parseStats reads "stats load1 cpu memAvail memTotal diskFree disk".
func parseStats(line string) (engine.WorkerStatus, bool) {
	f := strings.Fields(line)
	if len(f) != 7 || f[0] != "stats" {
		return engine.WorkerStatus{}, false
	}
	load, err1 := strconv.ParseFloat(f[1], 64)
	cpu, err2 := strconv.ParseFloat(f[2], 64)
	var n [4]int
	for i := range n {
		v, err := strconv.Atoi(f[3+i])
		if err != nil {
			return engine.WorkerStatus{}, false
		}
		n[i] = v
	}
	if err1 != nil || err2 != nil {
		return engine.WorkerStatus{}, false
	}
	return engine.WorkerStatus{Connected: true, At: store.Now(), Load1: load, CPUPct: cpu,
		MemAvailMB: n[0], MemTotalMB: n[1], DiskFreeMB: n[2], DiskMB: n[3]}, true
}

// stream runs the live values on t until they stop or go stale. It reports
// whether at least one line arrived.
func (m *Manager) stream(ctx context.Context, c *conn, t transport) bool {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	lines := make(chan string, 4)
	ended := make(chan error, 1)
	go func() {
		var errb bytes.Buffer
		err := t.run(sctx, statsScript(m.every), nil, &lineWriter{ctx: sctx, ch: lines}, &limited{b: &errb, n: 2048})
		if err != nil && errb.Len() > 0 {
			err = fmt.Errorf("%w: %s", err, lastLines(errb.String(), 2))
		}
		ended <- err
	}()
	stale := time.NewTimer(m.staleAfter)
	defer stale.Stop()
	got := false
	for {
		select {
		case <-ctx.Done():
			return got
		case l := <-lines:
			if st, ok := parseStats(l); ok {
				got = true
				c.mu.Lock()
				c.status = st
				c.mu.Unlock()
			}
			stale.Reset(m.staleAfter)
		case err := <-ended:
			if err == nil {
				err = errors.New("it ended")
			}
			c.down(fmt.Sprintf("The live values of the worker stopped (%v); reconnecting", err))
			return got
		case <-t.lost():
			c.down("The SSH connection to the worker was lost; reconnecting")
			return got
		case <-stale.C:
			c.down(fmt.Sprintf("The worker sent no live values for %d seconds; reconnecting", int(m.staleAfter.Seconds())))
			return got
		}
	}
}

// lineWriter hands complete lines to a channel.
type lineWriter struct {
	ctx context.Context
	ch  chan<- string
	buf []byte
}

func (w *lineWriter) Write(p []byte) (int, error) {
	w.buf = append(w.buf, p...)
	for {
		i := bytes.IndexByte(w.buf, '\n')
		if i < 0 {
			break
		}
		line := string(w.buf[:i])
		w.buf = w.buf[i+1:]
		select {
		case w.ch <- line:
		case <-w.ctx.Done():
			return 0, w.ctx.Err()
		}
	}
	if len(w.buf) > 4096 {
		w.buf = nil
	}
	return len(p), nil
}

// limited keeps the first n bytes and drops the rest.
type limited struct {
	b *bytes.Buffer
	n int
}

func (l *limited) Write(p []byte) (int, error) {
	if room := l.n - l.b.Len(); room > 0 {
		l.b.Write(p[:min(room, len(p))])
	}
	return len(p), nil
}

// --- running scripts -----------------------------------------------------------

func (m *Manager) dialWorker(ctx context.Context, w model.Worker) (transport, error) {
	cb, algos, err := pinned(w)
	if err != nil {
		return nil, err
	}
	t, err := dialSSH(ctx, addrOf(w), userOf(w), m.signer, cb, algos)
	if err != nil {
		return nil, err
	}
	return t, nil
}

// transport returns the open connection to w, or a one-off connection when
// there is none (before Run, or while it reconnects).
func (m *Manager) transport(ctx context.Context, w model.Worker) (transport, func(), error) {
	m.mu.Lock()
	c := m.conns[w.ID]
	m.mu.Unlock()
	if c != nil {
		c.mu.Lock()
		t, same := c.t, sameAddr(c.w, w)
		c.mu.Unlock()
		if t != nil && same {
			return t, func() {}, nil
		}
		select {
		case c.wake <- struct{}{}:
		default:
		}
	}
	t, err := m.dial(ctx, w)
	if err != nil {
		return nil, nil, err
	}
	return t, func() { t.close() }, nil
}

// sh runs a script on a worker and returns its output. The error says what
// went wrong in words for the user.
func (m *Manager) sh(ctx context.Context, w model.Worker, script, stdin string) (string, error) {
	t, release, err := m.transport(ctx, w)
	if err != nil {
		return "", err
	}
	defer release()
	return runOn(ctx, t, script, stdin)
}

func runOn(ctx context.Context, t transport, script, stdin string) (string, error) {
	var out, errb bytes.Buffer
	var in io.Reader
	if stdin != "" {
		in = strings.NewReader(stdin)
	}
	err := t.run(ctx, script, in, &limited{b: &out, n: 4 << 20}, &limited{b: &errb, n: 64 << 10})
	if err != nil {
		if ctx.Err() != nil {
			return out.String(), errors.New("the worker did not finish in time")
		}
		return out.String(), explainDocker(errb.String(), err)
	}
	return out.String(), nil
}

// explainDocker turns the error output of a script into a text for the user.
func explainDocker(stderr string, err error) error {
	s := strings.TrimSpace(stderr)
	low := strings.ToLower(s)
	switch {
	case strings.Contains(low, "docker: not found") || strings.Contains(low, "docker: command not found"):
		return errors.New("Docker is not installed. Paste the setup command on the server as root, then try again.")
	case strings.Contains(low, "permission denied") && (strings.Contains(low, "docker.sock") || strings.Contains(low, "daemon socket")):
		return fmt.Errorf("permission denied on the Docker socket: %s. The user must be in the group docker: paste the setup command on the server as root, then try again.", firstLine(s))
	case strings.Contains(low, "cannot connect to the docker daemon"):
		return errors.New("Docker is not running on the worker. Start it as root with \"systemctl enable --now docker\".")
	case strings.Contains(low, "no space left on device"):
		return fmt.Errorf("the disk of the worker is full: %s", firstLine(s))
	case s == "":
		return err
	}
	return errors.New(lastLines(s, 6))
}

func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(s)
}

// lastLines joins the last n non-empty lines of s.
func lastLines(s string, n int) string {
	var out []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			out = append(out, l)
		}
	}
	if len(out) > n {
		out = out[len(out)-n:]
	}
	return strings.Join(out, "; ")
}

// q quotes s for sh.
func q(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
