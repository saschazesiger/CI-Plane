package node

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"io"
	"net"
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/secret"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// testServer is an SSH server in the test process. By default it runs every
// command with the local sh, like sshd would.
type testServer struct {
	t       *testing.T
	ln      net.Listener
	addr    string
	hostKey ssh.Signer

	mu         sync.Mutex
	authorized ssh.PublicKey // nil refuses every key
	exec       func(cmd string, stdin io.Reader, stdout, stderr io.Writer) int
	cmds       []string
	conns      []net.Conn
}

func newTestServer(t *testing.T, authorized ssh.PublicKey) *testServer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	hk, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	s := &testServer{t: t, hostKey: hk, authorized: authorized}
	s.listen("127.0.0.1:0")
	t.Cleanup(s.stop)
	return s
}

func (s *testServer) listen(addr string) {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		s.t.Fatal(err)
	}
	s.mu.Lock()
	s.ln, s.addr = ln, ln.Addr().String()
	s.mu.Unlock()
	go s.serve(ln)
}

func (s *testServer) port() int { return s.ln.Addr().(*net.TCPAddr).Port }

// hostKeyLine is the server's key in authorized_keys format.
func (s *testServer) hostKeyLine() string {
	return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(s.hostKey.PublicKey())))
}

func (s *testServer) stop() {
	s.mu.Lock()
	ln, conns := s.ln, s.conns
	s.conns = nil
	s.mu.Unlock()
	ln.Close()
	for _, c := range conns {
		c.Close()
	}
}

// dropAll cuts every open connection but keeps listening.
func (s *testServer) dropAll() {
	s.mu.Lock()
	conns := s.conns
	s.conns = nil
	s.mu.Unlock()
	for _, c := range conns {
		c.Close()
	}
}

func (s *testServer) commands() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.cmds...)
}

func (s *testServer) serve(ln net.Listener) {
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(_ ssh.ConnMetadata, k ssh.PublicKey) (*ssh.Permissions, error) {
			s.mu.Lock()
			ok := s.authorized != nil && string(s.authorized.Marshal()) == string(k.Marshal())
			s.mu.Unlock()
			if !ok {
				return nil, io.EOF
			}
			return nil, nil
		},
	}
	cfg.AddHostKey(s.hostKey)
	for {
		nc, err := ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns = append(s.conns, nc)
		s.mu.Unlock()
		go func() {
			_, chans, reqs, err := ssh.NewServerConn(nc, cfg)
			if err != nil {
				nc.Close()
				return
			}
			go ssh.DiscardRequests(reqs) // answers keepalives
			for nch := range chans {
				if nch.ChannelType() != "session" {
					nch.Reject(ssh.UnknownChannelType, "no")
					continue
				}
				ch, creqs, err := nch.Accept()
				if err != nil {
					continue
				}
				go s.session(ch, creqs)
			}
		}()
	}
}

func (s *testServer) session(ch ssh.Channel, reqs <-chan *ssh.Request) {
	defer ch.Close()
	var kill func()
	for req := range reqs {
		switch req.Type {
		case "exec":
			n := binary.BigEndian.Uint32(req.Payload)
			cmd := string(req.Payload[4 : 4+n])
			req.Reply(true, nil)
			s.mu.Lock()
			s.cmds = append(s.cmds, cmd)
			fn := s.exec
			s.mu.Unlock()
			done := make(chan int, 1)
			if fn != nil {
				go func() { done <- fn(cmd, ch, ch, ch.Stderr()) }()
			} else {
				c := exec.Command("sh", "-c", cmd)
				c.Stdin, c.Stdout, c.Stderr = ch, ch, ch.Stderr()
				c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
				if err := c.Start(); err != nil {
					done <- 127
				} else {
					kill = func() { syscall.Kill(-c.Process.Pid, syscall.SIGKILL) }
					go func() {
						code := 0
						if err := c.Wait(); err != nil {
							code = 1
							if ee, ok := err.(*exec.ExitError); ok && ee.ExitCode() > 0 {
								code = ee.ExitCode()
							}
						}
						done <- code
					}()
				}
			}
			go func() {
				code := <-done
				status := make([]byte, 4)
				binary.BigEndian.PutUint32(status, uint32(code))
				ch.SendRequest("exit-status", false, status)
				ch.Close()
			}()
		case "signal":
			if kill != nil {
				kill()
			}
		default:
			if req.WantReply {
				req.Reply(false, nil)
			}
		}
	}
	if kill != nil {
		kill() // the client went away
	}
}

// newTestManager returns a manager on an in-memory store.
func newTestManager(t *testing.T) *Manager {
	t.Helper()
	st, err := store.Open("")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	key := make([]byte, 32)
	rand.Read(key)
	box, err := secret.New(key)
	if err != nil {
		t.Fatal(err)
	}
	m, err := New(st, box, t.Logf)
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func addWorker(t *testing.T, m *Manager, w model.Worker) model.Worker {
	t.Helper()
	err := m.st.Tx(func(tx *store.Tx) (err error) { w, err = tx.AddWorker(w); return })
	if err != nil {
		t.Fatal(err)
	}
	return w
}

// waitFor polls cond until it holds or the time is up.
func waitFor(t *testing.T, d time.Duration, what string, cond func() bool) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	for !cond() {
		select {
		case <-ctx.Done():
			t.Fatalf("timed out waiting for %s", what)
		case <-time.After(50 * time.Millisecond):
		}
	}
}
