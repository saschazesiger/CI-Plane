package node

import (
	"context"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// TestSetupOnFreshServer pastes the setup command into a clean Debian and
// Ubuntu (privileged containers with a real sshd), then connects over SSH
// like CI-Plane does, and finally removes everything with RemoveCommand. It
// installs Docker from get.docker.com and is skipped unless
// CI_PLANE_SETUP_TEST=1.
func TestSetupOnFreshServer(t *testing.T) {
	if os.Getenv("CI_PLANE_SETUP_TEST") != "1" {
		t.Skip("set CI_PLANE_SETUP_TEST=1 to install Docker in clean containers and test the setup command")
	}
	for _, image := range []string{"ubuntu:24.04", "debian:trixie-slim"} {
		t.Run(image, func(t *testing.T) { testSetupOn(t, image) })
	}
}

func testSetupOn(t *testing.T, image string) {
	m := newTestManager(t)
	m.every, m.staleAfter = time.Second, 4*time.Second
	set := model.DefaultSettings()
	set.DindImage = "alpine:3.22" // what Probe runs; small to pull
	if err := m.st.Tx(func(tx *store.Tx) error { return tx.SaveSettings(set) }); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	// The "server". Its Docker keeps its data on a volume, as nested Docker
	// cannot use overlayfs on overlayfs.
	name := randName("ci-plane-test-server-")
	dockerOut(t, "run", "-d", "--privileged", "--name", name, "-v", "/var/lib/docker", image, "sleep", "infinity")
	defer exec.Command("docker", "rm", "-f", "-v", name).Run()
	// Only for the container: systemd would do the cgroup delegation and
	// start sshd on a real server.
	dockerOut(t, "exec", name, "sh", "-c", `set -e
mkdir -p /sys/fs/cgroup/init
xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || :
sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq openssh-server >/dev/null
mkdir -p /run/sshd && /usr/sbin/sshd`)
	ip := strings.TrimSpace(dockerOut(t, "inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name))

	if _, err := m.Check(ctx, ip, 22, ""); err == nil || err.Error() != refusedKey {
		t.Fatalf("before setup: %v", err)
	}
	paste := func(cmd string) string {
		out, err := exec.Command("docker", "exec", name, "bash", "-c", cmd).CombinedOutput()
		if err != nil {
			t.Fatalf("pasting the command failed: %v\n%s", err, out)
		}
		return string(out)
	}
	begin := time.Now()
	out := paste(m.SetupCommand())
	t.Logf("setup took %v; last line: %s", time.Since(begin).Round(time.Second), lastLines(out, 1))
	if !strings.Contains(out, "this server is ready") {
		t.Fatalf("setup output: %s", out)
	}
	if out := paste(m.SetupCommand()); !strings.Contains(out, "this server is ready") || strings.Contains(out, "Installing Docker") {
		t.Fatalf("second run: %s", out)
	}
	if keys := dockerOut(t, "exec", name, "cat", "/home/ci-plane/.ssh/authorized_keys"); strings.Count(keys, "\n") != 1 || !strings.HasPrefix(keys, "restrict ") {
		t.Fatalf("authorized_keys: %q", keys)
	}

	f, err := m.Check(ctx, ip, 22, "")
	if err != nil {
		t.Fatalf("Check: %v", err)
	}
	t.Logf("facts: %+v", f)
	if f.Docker == "" || f.DiskMB == 0 || f.HostKey == "" || !strings.HasPrefix(f.HostKey, "ssh-ed25519 ") {
		t.Fatalf("facts %+v", f)
	}

	w := addWorker(t, m, model.Worker{Name: "fresh", Host: ip, Port: 22, User: "ci-plane", HostKey: f.HostKey, Enabled: true})
	rctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go m.Run(rctx)
	waitFor(t, 20*time.Second, "live values", func() bool { st := m.Status(w.ID); return st.Connected && st.At > 0 })
	t.Logf("live: %+v", m.Status(w.ID))
	if err := m.Probe(ctx, w); err != nil {
		t.Fatalf("Probe: %v", err)
	}
	if list, err := m.List(ctx, w); err != nil || len(list) != 0 {
		t.Fatalf("List: %v %v", list, err)
	}
	if err := m.Remove(ctx, w, "ci-plane-fresh-1"); err != nil {
		t.Fatalf("Remove of nothing: %v", err)
	}

	out = paste(m.RemoveCommand())
	t.Logf("remove: %s", lastLines(out, 1))
	if !strings.Contains(out, "Docker and its images stay installed") {
		t.Fatalf("remove output: %s", out)
	}
	waitFor(t, 20*time.Second, "disconnected", func() bool { return !m.Status(w.ID).Connected })
	t.Logf("after removal: %s", m.Status(w.ID).Error)
	if _, err := m.Check(ctx, ip, 22, ""); err == nil || err.Error() != refusedKey {
		t.Fatalf("after removal: %v", err)
	}
	if out := dockerOut(t, "exec", name, "sh", "-c", "docker ps -aq; docker volume ls -q --filter label=ci-plane.role; id ci-plane 2>&1 || :"); !strings.Contains(out, "no such user") || strings.Count(strings.TrimSpace(out), "\n") != 0 {
		t.Fatalf("left after RemoveCommand: %s", out)
	}
}
