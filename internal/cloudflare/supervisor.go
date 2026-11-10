package cloudflare

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

// runConfig is what cloudflared is started with; a change restarts it.
type runConfig struct {
	tunnelToken string
	apiToken    string // only to redact it from the output
	host        string
}

func (s *Service) runConfig() (runConfig, bool) {
	s.mu.Lock()
	cur := s.cur
	s.mu.Unlock()
	if !cur.Ready {
		return runConfig{}, false
	}
	tok, err := s.secret(secretTunnelTok)
	if err != nil || tok == "" {
		return runConfig{}, false
	}
	api, _ := s.secret(secretAPIToken)
	return runConfig{tunnelToken: tok, apiToken: api, host: cur.Hostname}, true
}

// Run supervises cloudflared whenever a tunnel is configured, until ctx
// ends: restarts it with backoff, stops it when the tunnel is removed,
// restarts it when Setup made a new tunnel, and checks from outside every
// ReverifyEvery so Status stays true to reality.
func (s *Service) Run(ctx context.Context) {
	backoff := s.MinBackoff
	tick := time.NewTicker(s.ReverifyEvery)
	defer tick.Stop()
	var verifying atomic.Bool
	reverify := func(host string) {
		s.mu.Lock()
		ok := s.connected
		s.mu.Unlock()
		if !ok || !verifying.CompareAndSwap(false, true) {
			return
		}
		go func() {
			defer verifying.Store(false)
			c, cancel := context.WithTimeout(ctx, time.Minute)
			defer cancel()
			s.setVerified(s.verifyOnce(c, host))
		}()
	}
	// pause waits, but a configuration change or the end cuts it short.
	pause := func(d time.Duration) bool {
		t := time.NewTimer(d)
		defer t.Stop()
		select {
		case <-ctx.Done():
			return false
		case <-s.wake:
			s.changed() // let the main loop see it too
			return true
		case <-t.C:
			return true
		}
	}

	for ctx.Err() == nil {
		cfg, ok := s.runConfig()
		if !ok {
			select {
			case <-ctx.Done():
				return
			case <-s.wake:
			case <-tick.C:
			}
			continue
		}
		p, err := s.start(cfg)
		if err != nil {
			s.setProc(false, fmt.Sprintf("cloudflared could not be started: %v. Check that the program %s exists", err, s.Cloudflared))
			s.logf("cloudflare: %v", err)
			if !pause(backoff) {
				return
			}
			backoff = min(backoff*2, s.MaxBackoff)
			continue
		}
		started := time.Now()
		stopped := false
	wait:
		for {
			select {
			case <-ctx.Done():
				p.stop()
				return
			case <-s.wake:
				if next, ok := s.runConfig(); !ok || next != cfg {
					p.stop()
					stopped = true
					break wait
				}
			case <-tick.C:
				reverify(cfg.host)
			case <-p.done:
				break wait
			}
		}
		if stopped {
			backoff = s.MinBackoff
			continue
		}
		if time.Since(started) > 2*s.MaxBackoff {
			backoff = s.MinBackoff // it ran fine for a while; this is a fresh failure
		}
		why := p.lastErr.Load()
		msg := "cloudflared stopped"
		if why != nil && *why != "" {
			msg += ": " + *why
		}
		s.logf("cloudflare: %s; starting it again in %s", msg, backoff)
		s.setProc(false, msg+". CI-Plane starts it again by itself.")
		if !pause(backoff) {
			return
		}
		backoff = min(backoff*2, s.MaxBackoff)
	}
}

func (s *Service) setProc(running bool, errText string) {
	s.mu.Lock()
	s.running = running
	if !running {
		s.connected = false
	}
	if errText != "" || running {
		s.procErr = errText
	}
	s.mu.Unlock()
}

type proc struct {
	cmd     *exec.Cmd
	done    chan struct{}
	lastErr atomic.Pointer[string]
}

// childEnv is our environment for cloudflared, without our own secrets and
// with the tunnel token: the environment is not visible to other users the
// way a command line is.
func childEnv(tunnelToken string) []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "TUNNEL_") || strings.HasPrefix(k, "CI_PLANE_") {
			continue
		}
		env = append(env, kv)
	}
	return append(env, "TUNNEL_TOKEN="+tunnelToken)
}

func freeLoopbackAddr() (string, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer l.Close()
	return l.Addr().String(), nil
}

func (s *Service) start(cfg runConfig) (*proc, error) {
	metrics, err := freeLoopbackAddr()
	if err != nil {
		return nil, err
	}
	cmd := exec.Command(s.Cloudflared, "tunnel", "--no-autoupdate", "--metrics", metrics, "run")
	cmd.Env = childEnv(cfg.tunnelToken)
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		pw.Close()
		return nil, err
	}
	p := &proc{cmd: cmd, done: make(chan struct{})}
	s.setProc(true, "")
	s.logf("cloudflare: cloudflared started (pid %d)", cmd.Process.Pid)

	redact := strings.NewReplacer(cfg.tunnelToken, "[redacted]")
	if cfg.apiToken != "" {
		redact = strings.NewReplacer(cfg.tunnelToken, "[redacted]", cfg.apiToken, "[redacted]")
	}
	logged := make(chan struct{})
	go func() {
		defer close(logged)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			line := redact.Replace(sc.Text())
			s.logf("cloudflared: %s", line)
			if strings.Contains(line, " ERR ") || strings.Contains(line, "error") || strings.Contains(line, "not valid") {
				l := line
				p.lastErr.Store(&l)
			}
		}
		io.Copy(io.Discard, pr)
	}()

	stopReady := make(chan struct{})
	go s.pollReady(metrics, stopReady)

	go func() {
		err := cmd.Wait()
		pw.Close()
		<-logged
		close(stopReady)
		if err != nil {
			s.logf("cloudflare: cloudflared exited: %v", err)
		}
		s.setProc(false, "")
		close(p.done)
	}()
	return p, nil
}

// stop asks cloudflared to finish its requests and kills it if it takes
// too long.
func (p *proc) stop() {
	_ = p.cmd.Process.Signal(syscall.SIGTERM)
	select {
	case <-p.done:
	case <-time.After(10 * time.Second):
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}

// pollReady asks cloudflared's /ready endpoint, which answers 200 with
// readyConnections > 0 once it has connections to the edge, 503 otherwise.
func (s *Service) pollReady(addr string, stop <-chan struct{}) {
	c := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	defer c.CloseIdleConnections()
	t := time.NewTicker(s.ReadyPoll)
	defer t.Stop()
	for {
		ok := false
		if resp, err := c.Get("http://" + addr + "/ready"); err == nil {
			var r struct {
				ReadyConnections int `json:"readyConnections"`
			}
			_ = json.NewDecoder(io.LimitReader(resp.Body, 4096)).Decode(&r)
			resp.Body.Close()
			ok = resp.StatusCode == http.StatusOK && r.ReadyConnections > 0
		}
		select {
		case <-stop:
			return
		default:
		}
		s.mu.Lock()
		if s.running {
			if ok && !s.connected {
				s.procErr = ""
			}
			s.connected = ok
		}
		s.mu.Unlock()
		select {
		case <-stop:
			return
		case <-t.C:
		}
	}
}
