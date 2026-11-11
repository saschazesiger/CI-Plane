package node

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/saschazesiger/CI-Plane/internal/model"
)

// transport runs shell scripts on a worker. The same Docker recipes run over
// SSH in production and on the local machine in tests.
type transport interface {
	// run runs script with sh and returns when it exits; a non-zero exit is
	// an error.
	run(ctx context.Context, script string, stdin io.Reader, stdout, stderr io.Writer) error
	// lost is closed when the connection is gone.
	lost() <-chan struct{}
	close() error
}

// local runs scripts on this machine.
type local struct{}

func (local) run(ctx context.Context, script string, stdin io.Reader, stdout, stderr io.Writer) error {
	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
	cmd.WaitDelay = time.Second
	return cmd.Run()
}
func (local) lost() <-chan struct{} { return nil }
func (local) close() error          { return nil }

// sshConn is one SSH connection; every script runs in its own session.
type sshConn struct {
	c    *ssh.Client
	gone chan struct{}
}

const (
	dialTimeout      = 10 * time.Second
	handshakeTimeout = 15 * time.Second
	keepaliveEvery   = 10 * time.Second
)

// tofuAlgos is the order in which a new host is asked for its key: the
// strongest common type first, so the pinned key is usually Ed25519.
var tofuAlgos = []string{
	ssh.KeyAlgoED25519, ssh.KeyAlgoECDSA256, ssh.KeyAlgoECDSA384, ssh.KeyAlgoECDSA521,
	ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256,
}

func dialSSH(ctx context.Context, addr, user string, signer ssh.Signer, check ssh.HostKeyCallback, algos []string) (*sshConn, error) {
	d := net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}
	nc, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, explainDial(addr, err)
	}
	stop := context.AfterFunc(ctx, func() { nc.Close() })
	defer stop()
	_ = nc.SetDeadline(time.Now().Add(handshakeTimeout))
	cfg := &ssh.ClientConfig{
		User:              user,
		Auth:              []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback:   check,
		HostKeyAlgorithms: algos,
		Timeout:           dialTimeout,
	}
	cc, chans, reqs, err := ssh.NewClientConn(nc, addr, cfg)
	if err != nil {
		nc.Close()
		return nil, explainDial(addr, err)
	}
	_ = nc.SetDeadline(time.Time{})
	t := &sshConn{c: ssh.NewClient(cc, chans, reqs), gone: make(chan struct{})}
	go func() { _ = t.c.Wait(); close(t.gone) }()
	go t.keepalive()
	return t, nil
}

// keepalive notices a dead peer that TCP would only notice much later.
func (t *sshConn) keepalive() {
	tick := time.NewTicker(keepaliveEvery)
	defer tick.Stop()
	for {
		select {
		case <-t.gone:
			return
		case <-tick.C:
		}
		ok := make(chan error, 1)
		go func() { _, _, err := t.c.SendRequest("keepalive@openssh.com", true, nil); ok <- err }()
		select {
		case err := <-ok:
			if err != nil {
				t.c.Close()
				return
			}
		case <-time.After(2 * keepaliveEvery):
			t.c.Close()
			return
		case <-t.gone:
			return
		}
	}
}

func (t *sshConn) run(ctx context.Context, script string, stdin io.Reader, stdout, stderr io.Writer) error {
	s, err := t.c.NewSession()
	if err != nil {
		return fmt.Errorf("the SSH connection to the worker failed: %w", err)
	}
	defer s.Close()
	s.Stdin, s.Stdout, s.Stderr = stdin, stdout, stderr
	if err := s.Start(script); err != nil {
		return err
	}
	done := make(chan error, 1)
	go func() { done <- s.Wait() }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		_ = s.Signal(ssh.SIGKILL)
		s.Close()
		return ctx.Err()
	case <-t.gone:
		return errors.New("the SSH connection to the worker was lost")
	}
}

func (t *sshConn) lost() <-chan struct{} { return t.gone }
func (t *sshConn) close() error          { return t.c.Close() }

// hostKeyError is a pinned host key that does not match.
type hostKeyError struct{ addr, want, got string }

func (e *hostKeyError) Error() string {
	return fmt.Sprintf("The server at %s presented a different host key (%s) than the one stored when the worker was added (%s). "+
		"If the server was reinstalled, remove the worker and add it again; otherwise someone may be intercepting the connection.", e.addr, e.got, e.want)
}

// pinned accepts only the host key stored for the worker.
func pinned(w model.Worker) (ssh.HostKeyCallback, []string, error) {
	want, _, _, _, err := ssh.ParseAuthorizedKey([]byte(w.HostKey))
	if err != nil {
		return nil, nil, errors.New("No valid host key is stored for this worker. Remove the worker and add it again.")
	}
	cb := func(_ string, _ net.Addr, got ssh.PublicKey) error {
		if !bytes.Equal(got.Marshal(), want.Marshal()) {
			return &hostKeyError{addr: addrOf(w), want: ssh.FingerprintSHA256(want), got: ssh.FingerprintSHA256(got)}
		}
		return nil
	}
	// Ask for the pinned type only: a server with several host keys would
	// otherwise present another one and look like an attack.
	algos := []string{want.Type()}
	if want.Type() == ssh.KeyAlgoRSA {
		algos = []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA}
	}
	return cb, algos, nil
}

func addrOf(w model.Worker) string {
	port := w.Port
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(w.Host, strconv.Itoa(port))
}

func userOf(w model.Worker) string {
	if w.User == "" {
		return defaultUser
	}
	return w.User
}

const refusedKey = "The server refused the key. Paste the setup command on the server as root, then try again."

// explainDial turns a connection error into a text for the person adding or
// watching the worker.
func explainDial(addr string, err error) error {
	var hk *hostKeyError
	if errors.As(err, &hk) {
		return hk
	}
	var dns *net.DNSError
	var op *net.OpError
	msg := err.Error()
	switch {
	case errors.As(err, &dns):
		return fmt.Errorf("The name %q could not be resolved. Check the address of the worker.", dns.Name)
	case strings.Contains(msg, "unable to authenticate"):
		return errors.New(refusedKey)
	case strings.Contains(msg, "no common algorithm for host key"):
		return fmt.Errorf("The server at %s no longer offers the host key stored when the worker was added. "+
			"If the server was reinstalled, remove the worker and add it again.", addr)
	case (errors.Is(err, context.DeadlineExceeded) || isTimeout(err)) && isCGNAT(addr):
		return fmt.Errorf("%s did not answer within %d seconds. This is a Tailscale (or other CGNAT) address: "+
			"the machine running CI-Plane must be in the same tailnet as the server, and the tailnet's access rules must allow SSH between them.",
			addr, int(dialTimeout.Seconds()))
	case errors.Is(err, context.DeadlineExceeded) || isTimeout(err):
		return fmt.Errorf("%s did not answer within %d seconds. Check the address, the port and any firewall between CI-Plane and the server.", addr, int(dialTimeout.Seconds()))
	case strings.Contains(msg, "connection refused"):
		return fmt.Errorf("%s refused the connection. Check the port and that the SSH server is running.", addr)
	case errors.As(err, &op):
		return fmt.Errorf("Could not connect to %s: %v. Check the address and the port.", addr, op.Err)
	case strings.Contains(msg, "handshake failed"):
		return fmt.Errorf("The SSH handshake with %s failed (%v). Check that the port belongs to an SSH server.", addr, err)
	}
	return fmt.Errorf("Could not connect to %s: %v", addr, err)
}

// cgnat is 100.64.0.0/10, where Tailscale hands out its addresses; such an
// address only answers from inside the same tailnet.
var cgnat = netip.MustParsePrefix("100.64.0.0/10")

func isCGNAT(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr
	}
	ip, err := netip.ParseAddr(host)
	return err == nil && cgnat.Contains(ip)
}

func isTimeout(err error) bool {
	var ne net.Error
	return errors.As(err, &ne) && ne.Timeout()
}
