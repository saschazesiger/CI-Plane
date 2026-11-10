package cloudflare

import (
	"os"
	"strconv"
	"strings"
	"testing"
	"time"
)

// starts returns the start times the fake cloudflared logged.
func starts(t *testing.T, path string) []time.Time {
	b, _ := os.ReadFile(path)
	var out []time.Time
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "" {
			continue
		}
		ms, err := strconv.ParseInt(strings.Fields(line)[0], 10, 64)
		if err != nil {
			t.Fatalf("log line %q", line)
		}
		out = append(out, time.UnixMilli(ms))
	}
	return out
}

func TestSupervisorRestartsWithBackoff(t *testing.T) {
	t.Setenv("FAKE_CLOUDFLARED_EXIT", "1")
	h := newHarness(t, false)
	tunnelTok := "eyJhIjoiYWNjdCIsInQiOiJ0dW4iLCJzIjoic2VjcmV0In0="
	err := h.svc.save(state{Ready: true, Hostname: testHost, TunnelID: "tun"},
		map[string]string{secretTunnelTok: tunnelTok, secretAPIToken: testToken})
	if err != nil {
		t.Fatal(err)
	}
	h.startRun()

	deadline := time.Now().Add(10 * time.Second)
	for len(starts(t, h.cfdLog)) < 5 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	ts := starts(t, h.cfdLog)
	if len(ts) < 5 {
		t.Fatalf("cloudflared started %d times, want at least 5", len(ts))
	}
	// Backoff 50, 100, 200, 400 ms (MaxBackoff 400): gaps grow.
	g1, g4 := ts[1].Sub(ts[0]), ts[4].Sub(ts[3])
	if g4 < 300*time.Millisecond || g4 <= g1 {
		t.Errorf("gaps between starts did not grow: first %v, fourth %v", g1, g4)
	}
	// The process may be up for a moment between two exits; wait for the
	// state after an exit.
	st := h.svc.Status()
	for until := time.Now().Add(3 * time.Second); !strings.Contains(st.Error, "cloudflared stopped") && time.Now().Before(until); st = h.svc.Status() {
		time.Sleep(10 * time.Millisecond)
	}
	if !st.Configured || st.Connected || !strings.Contains(st.Error, "cloudflared stopped") {
		t.Errorf("status = %+v", st)
	}

	// Remove the configuration: the supervisor stops starting it.
	h.svc.save(state{}, nil)
	h.svc.changed()
	time.Sleep(600 * time.Millisecond)
	n := len(starts(t, h.cfdLog))
	time.Sleep(800 * time.Millisecond)
	if m := len(starts(t, h.cfdLog)); m != n {
		t.Errorf("cloudflared started %d more times after the tunnel was removed", m-n)
	}
	h.stopRun()

	logs := h.logs.String()
	args, _ := os.ReadFile(h.cfdLog)
	if strings.Contains(logs, tunnelTok) || strings.Contains(string(args), tunnelTok) {
		t.Error("the tunnel token appears in the logs or the arguments")
	}
	if !strings.Contains(logs, "token is [redacted]") || !strings.Contains(logs, "Register tunnel error") {
		t.Errorf("cloudflared output not logged as expected:\n%s", logs)
	}
	if !strings.Contains(string(args), "token=true secretkey=false") {
		t.Errorf("environment of cloudflared: %s", args)
	}
}

func TestSupervisorStopsAndRestartsOnNewTunnel(t *testing.T) {
	h := newHarness(t, true)
	h.svc.save(state{Ready: true, Hostname: testHost, TunnelID: "a"}, map[string]string{secretTunnelTok: "token-a"})
	h.svc.changed()
	waitFor(t, "connected", func() bool { return h.svc.Status().Connected })
	h.svc.save(state{Ready: true, Hostname: testHost, TunnelID: "b"}, map[string]string{secretTunnelTok: "token-b"})
	h.svc.changed()
	waitFor(t, "second start", func() bool { return len(starts(t, h.cfdLog)) == 2 })
	waitFor(t, "connected again", func() bool { return h.svc.Status().Connected })
	h.stopRun()
	if st := h.svc.Status(); st.Running || st.Connected {
		t.Errorf("status after stop = %+v", st)
	}
}

func waitFor(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
