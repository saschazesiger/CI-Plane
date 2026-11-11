package node

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"github.com/saschazesiger/CI-Plane/internal/api"
	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

func TestKeyIsCreatedOnceAndKept(t *testing.T) {
	m := newTestManager(t)
	if !strings.HasPrefix(m.PublicKey(), "ssh-ed25519 ") {
		t.Fatalf("public key %q", m.PublicKey())
	}
	again, err := New(m.st, m.box, nil)
	if err != nil {
		t.Fatal(err)
	}
	if again.PublicKey() != m.PublicKey() {
		t.Fatal("a second manager on the same store made a new key")
	}
	var raw []byte
	_ = m.st.View(func(tx *store.Tx) (err error) { raw, err = tx.Get("secret:" + keyName); return })
	if strings.Contains(string(raw), "PRIVATE KEY") {
		t.Fatal("the private key is stored in the clear")
	}
}

func TestCheckTrustsOnFirstUseAndReadsFacts(t *testing.T) {
	m := newTestManager(t)
	s := newTestServer(t, m.signer.PublicKey())
	f, err := m.Check(context.Background(), "127.0.0.1", s.port(), "")
	if f.HostKey != s.hostKeyLine() || !strings.HasPrefix(f.Fingerprint, "SHA256:") {
		t.Fatalf("host key %q, fingerprint %q", f.HostKey, f.Fingerprint)
	}
	if f.CPUs < 1 || f.MemMB < 1 || f.Arch == "" || f.OS == "" {
		t.Fatalf("facts %+v", f)
	}
	// The machine running the tests may or may not have Docker.
	if err != nil && !strings.Contains(err.Error(), "Docker") {
		t.Fatalf("Check: %v", err)
	}
	if err == nil && (f.Docker == "" || f.DiskMB < 1) {
		t.Fatalf("facts without Docker or disk: %+v", f)
	}
}

func TestRefusedKey(t *testing.T) {
	m := newTestManager(t)
	s := newTestServer(t, nil)
	_, err := m.Check(context.Background(), "127.0.0.1", s.port(), "ci-plane")
	if err == nil || err.Error() != refusedKey {
		t.Fatalf("got %v", err)
	}
}

func TestUnreachableHost(t *testing.T) {
	m := newTestManager(t)
	s := newTestServer(t, nil)
	port := s.port()
	s.stop()
	_, err := m.Check(context.Background(), "127.0.0.1", port, "")
	if err == nil || !strings.Contains(err.Error(), "refused the connection") {
		t.Fatalf("got %v", err)
	}
}

func TestPinnedHostKey(t *testing.T) {
	m := newTestManager(t)
	s := newTestServer(t, m.signer.PublicKey())
	w := model.Worker{ID: 1, Name: "w", Host: "127.0.0.1", Port: s.port(), User: "ci-plane", HostKey: s.hostKeyLine()}
	ctx := context.Background()
	if out, err := m.sh(ctx, w, "echo hello", ""); err != nil || strings.TrimSpace(out) != "hello" {
		t.Fatalf("pinned key: %q %v", out, err)
	}
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	op, _ := ssh.NewPublicKey(other.Public())
	w.HostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(op)))
	_, err := m.sh(ctx, w, "echo hello", "")
	if err == nil || !strings.Contains(err.Error(), "different host key") || !strings.Contains(err.Error(), ssh.FingerprintSHA256(op)) {
		t.Fatalf("changed key: %v", err)
	}
	w.HostKey = ""
	if _, err := m.sh(ctx, w, "echo hello", ""); err == nil || !strings.Contains(err.Error(), "add it again") {
		t.Fatalf("no key: %v", err)
	}
}

func TestLiveValuesReconnectAndStale(t *testing.T) {
	m := newTestManager(t)
	m.every, m.staleAfter = time.Second, 3*time.Second
	s := newTestServer(t, m.signer.PublicKey())
	w := addWorker(t, m, model.Worker{Name: "w", Host: "127.0.0.1", Port: s.port(), User: "ci-plane", HostKey: s.hostKeyLine(), Enabled: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go m.Run(ctx)

	live := func() bool { st := m.Status(w.ID); return st.Connected && st.At > 0 }
	waitFor(t, 10*time.Second, "live values", live)
	st := m.Status(w.ID)
	if st.MemTotalMB < 1 || st.MemAvailMB < 1 || st.DiskMB < 1 || st.CPUPct < 0 || st.CPUPct > 100 {
		t.Fatalf("implausible values %+v", st)
	}
	n := len(s.commands())

	// The connection drops: the worker shows as disconnected, then comes back.
	s.dropAll()
	waitFor(t, 5*time.Second, "disconnected", func() bool { return !m.Status(w.ID).Connected })
	waitFor(t, 10*time.Second, "reconnected", func() bool { return live() && len(s.commands()) > n })

	// The stream goes silent but the connection stays: stale after 3 s.
	s.mu.Lock()
	s.exec = func(cmd string, stdin io.Reader, stdout, stderr io.Writer) int {
		time.Sleep(time.Hour)
		return 0
	}
	s.mu.Unlock()
	s.dropAll()
	waitFor(t, 15*time.Second, "stale", func() bool {
		st := m.Status(w.ID)
		return !st.Connected && strings.Contains(st.Error, "no live values for 3 seconds")
	})

	// Removing the worker from the store ends its connection.
	_ = m.st.Tx(func(tx *store.Tx) error { return tx.DeleteWorker(w.ID) })
	m.Changed()
	waitFor(t, 5*time.Second, "forgotten", func() bool { return m.Status(w.ID).Error == "Not connected yet" })
}

// The JIT config must reach the worker on stdin only, and must not come back
// in error texts.
func TestJITConfigStaysSecret(t *testing.T) {
	m := newTestManager(t)
	s := newTestServer(t, m.signer.PublicKey())
	var stdins []string
	fail := false
	s.exec = func(cmd string, stdin io.Reader, stdout, stderr io.Writer) int {
		b, _ := io.ReadAll(stdin)
		s.mu.Lock()
		stdins = append(stdins, string(b))
		s.mu.Unlock()
		if fail {
			io.WriteString(stderr, "docker: something failed near "+string(b)+"\n")
			return 1
		}
		return 0
	}
	w := model.Worker{ID: 1, Host: "127.0.0.1", Port: s.port(), User: "ci-plane", HostKey: s.hostKeyLine()}
	jit := "eyJzZWNyZXQiOiJ0b3Atc2VjcmV0LWppdC1jb25maWcifQ=="
	spec := engine.RunnerSpec{Name: "ci-plane-w-1", JITConfig: jit, Image: "runner:1", DindImage: "docker:dind", MemMB: 4096, CPUPriority: model.PriorityBackground}
	if err := m.Start(context.Background(), w, spec); err != nil {
		t.Fatal(err)
	}
	fail = true
	err := m.Start(context.Background(), w, spec)
	if err == nil || strings.Contains(err.Error(), jit) || !strings.Contains(err.Error(), "[runner configuration]") {
		t.Fatalf("error leaks or hides the failure: %v", err)
	}
	for _, c := range s.commands() {
		if strings.Contains(c, jit) {
			t.Fatal("the JIT config is part of a command line")
		}
	}
	if !strings.Contains(stdins[0], jit) {
		t.Fatal("the JIT config did not arrive on stdin")
	}
}

func TestStartRefusesForeignNames(t *testing.T) {
	m := newTestManager(t)
	w := model.Worker{ID: 1}
	for _, n := range []string{"postgres", "ci-plane-", "ci-plane-x;rm -rf /", "ci-plane-$(id)"} {
		if err := m.Remove(context.Background(), w, n); err == nil || !strings.Contains(err.Error(), "refusing") {
			t.Fatalf("%q: %v", n, err)
		}
	}
}

func TestParseList(t *testing.T) {
	out := "c\tci-plane-a-1\tci-plane-a-1-runner\texited\tExited (137) 2 minutes ago\n" +
		"c\tci-plane-a-1\tci-plane-a-1-dind\trunning\tUp 3 minutes\n" +
		"c\tci-plane-a-2\tci-plane-a-2-runner\trunning\tUp 1 second\n" +
		"v\tci-plane-a-3\n" +
		"n\tci-plane-a-3\n" +
		"c\tsomething-else\tx\trunning\tUp\n"
	got := parseList(out)
	want := []engine.Container{
		{Runner: "ci-plane-a-1", Running: false, ExitCode: 137},
		{Runner: "ci-plane-a-2", Running: true},
		{Runner: "ci-plane-a-3"},
	}
	if len(got) != len(want) {
		t.Fatalf("got %+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %+v, want %+v", got[i], want[i])
		}
	}
}

func TestParseStats(t *testing.T) {
	st, ok := parseStats("stats 0.52 12.5 2048 8192 30000 100000")
	if !ok || st.Load1 != 0.52 || st.CPUPct != 12.5 || st.MemAvailMB != 2048 || st.MemTotalMB != 8192 ||
		st.DiskFreeMB != 30000 || st.DiskMB != 100000 || !st.Connected || st.At == 0 {
		t.Fatalf("%+v %v", st, ok)
	}
	if _, ok := parseStats("stats 1 2 3"); ok {
		t.Fatal("short line accepted")
	}
}

func TestCommandsArePasteable(t *testing.T) {
	m := newTestManager(t)
	for _, c := range []string{m.SetupCommand(), m.RemoveCommand()} {
		inner := strings.TrimSuffix(strings.TrimPrefix(c, "sh -c '"), "'")
		if strings.ContainsAny(inner, "'\n") {
			t.Fatalf("not one line or breaks the quoting: %s", c)
		}
	}
	if !strings.Contains(m.SetupCommand(), "restrict "+m.PublicKey()) {
		t.Fatal("setup does not authorise the key with restrict")
	}
}

func TestParseFacts(t *testing.T) {
	cases := map[string]string{
		"arch x86_64\ndocker-missing\n": "Docker is not installed",
		"arch x86_64\ndocker-error permission denied while trying to connect to the Docker daemon socket\n": "permission denied on the Docker socket",
		"arch aarch64\ndocker 29.0.0\n": "x86_64",
	}
	for out, want := range cases {
		var f api.WorkerFacts
		if err := parseFacts(out, "ci-plane", &f); err == nil || !strings.Contains(err.Error(), want) {
			t.Fatalf("%q: got %v, want %q", out, err, want)
		}
	}
	var f api.WorkerFacts
	err := parseFacts("cpus 8\nmem 15900\nos Ubuntu 24.04\narch x86_64\ndocker 29.5.1\ndisk 100000 60000\n", "ci-plane", &f)
	if err != nil || f.CPUs != 8 || f.MemMB != 15900 || f.OS != "Ubuntu 24.04" || f.Docker != "29.5.1" || f.DiskMB != 100000 || f.DiskFreeMB != 60000 {
		t.Fatalf("%+v %v", f, err)
	}
}
