package node

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
	"github.com/saschazesiger/CI-Plane/internal/store"
)

// These tests run the real recipes against the Docker daemon of this
// machine, locally and through the in-process SSH server. They are skipped
// unless CI_PLANE_DOCKER_TEST=1; they leave nothing behind but pulled images.

const stubImage = "ci-plane-test-runner:latest"

func dockerOut(t *testing.T, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return string(out)
}

func dockerTest(t *testing.T) (*Manager, model.Settings) {
	if os.Getenv("CI_PLANE_DOCKER_TEST") != "1" {
		t.Skip("set CI_PLANE_DOCKER_TEST=1 to run against the local Docker daemon")
	}
	m := newTestManager(t)
	set := model.DefaultSettings()
	set.MirrorCapMB = 1 << 20
	if err := m.st.Tx(func(tx *store.Tx) error { return tx.SaveSettings(set) }); err != nil {
		t.Fatal(err)
	}
	if err := m.loadSettings(); err != nil {
		t.Fatal(err)
	}
	// A runner image whose run.sh reports whether the JIT config arrived and
	// then stays up, so the containers can be inspected. The real run.sh
	// would exit at once with a fake configuration.
	build := exec.Command("docker", "build", "-q", "-t", stubImage, "-")
	build.Stdin = strings.NewReader("FROM " + set.RunnerImage + "\n" +
		`RUN printf '#!/bin/sh\nif [ -n "$ACTIONS_RUNNER_INPUT_JITCONFIG" ]; then echo jit-received; fi\nexec sleep 3600\n' > run.sh && chmod +x run.sh` + "\n")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build the stub runner image: %v\n%s", err, out)
	}
	t.Cleanup(func() {
		// What Prepare and Start share per worker; on a real worker it stays.
		exec.Command("docker", "rm", "-f", mirrorName).Run()
		exec.Command("systemctl", "revert", cgroupSlice).Run() // the priority of the slice
		exec.Command("docker", "volume", "rm", mirrorName).Run()
		vols, _ := exec.Command("docker", "volume", "ls", "-q", "--filter", "label="+labelRole+"=externals").Output()
		for _, v := range strings.Fields(string(vols)) {
			exec.Command("docker", "volume", "rm", v).Run()
		}
		exec.Command("docker", "rmi", stubImage).Run()
	})
	return m, set
}

func randName(prefix string) string {
	b := make([]byte, 4)
	rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

// assertGone checks that nothing of the runner is left, by label and by name.
func assertGone(t *testing.T, name string) {
	t.Helper()
	for _, kind := range [][]string{{"ps", "-a"}, {"volume", "ls"}, {"network", "ls"}} {
		for _, f := range []string{"label=" + labelRunner + "=" + name, "name=" + name} {
			args := append(append([]string{}, kind...), "-q", "--filter", f)
			if out := strings.TrimSpace(dockerOut(t, args...)); out != "" {
				t.Fatalf("left after Remove (%s %s): %s", strings.Join(kind, " "), f, out)
			}
		}
	}
}

func TestDockerRecipe(t *testing.T) {
	m, set := dockerTest(t)
	ctx := context.Background()
	w := model.Worker{ID: 1, Name: "local"}
	m.dial = func(context.Context, model.Worker) (transport, error) { return local{}, nil }

	var steps []string
	start := time.Now()
	if err := m.Prepare(ctx, w, func(s string) { steps = append(steps, s) }); err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	t.Logf("Prepare took %v: %s", time.Since(start).Round(time.Millisecond), strings.Join(steps, " / "))
	if len(steps) != 7 || steps[1] != "Pulling the runner image" {
		t.Fatalf("progress %q", steps)
	}
	if err := m.Prepare(ctx, w, nil); err != nil {
		t.Fatalf("Prepare again: %v", err)
	}

	// Over the in-process SSH server as well: same scripts, real Docker.
	s := newTestServer(t, m.signer.PublicKey())
	sw := model.Worker{ID: 2, Name: "ssh", Host: "127.0.0.1", Port: s.port(), User: "ci-plane", HostKey: s.hostKeyLine()}
	viaSSH := func(ctx context.Context, w model.Worker) (transport, error) {
		if w.ID == 2 {
			return m.dialWorker(ctx, w)
		}
		return local{}, nil
	}
	m.dial = viaSSH

	for _, wk := range []model.Worker{w, sw} {
		t.Run(wk.Name, func(t *testing.T) {
			name := randName("ci-plane-test-")
			jit := randName("fake-jit-config-")
			// One worker at each priority that uses the slice.
			prio := model.PriorityBackground
			if wk.ID == 2 {
				prio = model.PriorityLow
			}
			spec := engine.RunnerSpec{Name: name, JITConfig: jit, Image: stubImage, DindImage: set.DindImage, MemMB: 2048, CPUPriority: prio}
			defer m.Remove(context.Background(), wk, name)

			// Leftovers under the same name are removed first.
			dockerOut(t, "volume", "create", "--label", labelRunner+"="+name, name+"-work")
			dockerOut(t, "run", "-d", "--name", name+"-runner", "--label", labelRunner+"="+name, "alpine:3.22", "sleep", "60")

			begin := time.Now()
			if err := m.Start(ctx, wk, spec); err != nil {
				t.Fatalf("Start: %v", err)
			}
			t.Logf("Start took %v", time.Since(begin).Round(time.Millisecond))
			if ps, _ := exec.Command("ps", "-eo", "args").Output(); strings.Contains(string(ps), jit) {
				t.Fatal("the JIT config shows in ps")
			}

			list, err := m.List(ctx, wk)
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, c := range list {
				if c.Runner == name {
					found = c.Running
				}
			}
			if !found {
				t.Fatalf("List does not show %s running: %+v", name, list)
			}

			exec1 := func(script string) string { return dockerOut(t, "exec", name+"-runner", "sh", "-c", script) }
			waitFor(t, 10*time.Second, "runner log", func() bool {
				out, _ := exec.Command("docker", "logs", name+"-runner").CombinedOutput()
				return strings.Contains(string(out), "jit-received")
			})
			if out := exec1("id -un; docker run --rm hello-world 2>&1"); !strings.Contains(out, "runner") || !strings.Contains(out, "Hello from Docker") {
				t.Fatalf("inner daemon: %s", out)
			}
			// What a container job does: bind-mount the work directory and the
			// externals by their paths in the runner.
			out := exec1(`mkdir -p /home/runner/_work/repo && echo from-the-runner > /home/runner/_work/repo/f &&
				docker run --rm -v /home/runner/_work:/__w -v /home/runner/externals:/__e:ro alpine:3.22 sh -c 'cat /__w/repo/f; ls /__e; echo w > /__w/repo/g' &&
				cat /home/runner/_work/repo/g`)
			if !strings.Contains(out, "from-the-runner") || !strings.Contains(out, "node20") || !strings.HasSuffix(strings.TrimSpace(out), "w") {
				t.Fatalf("shared paths: %s", out)
			}
			// A service container's port answers on localhost of the runner.
			out = exec1(`docker run -d -p 18080:80 nginx:alpine >/dev/null 2>&1 &&
				for i in $(seq 50); do curl -fs -o /dev/null http://localhost:18080 && echo answered && exit 0; sleep 0.2; done; exit 1`)
			if out != "answered\n" {
				t.Fatalf("service port: %q", out)
			}
			// The inner daemon pulls Docker Hub images through the mirror.
			if out := dockerOut(t, "exec", name+"-dind", "docker", "info", "--format", "{{.RegistryConfig.Mirrors}}"); !strings.Contains(out, mirrorName) {
				t.Fatalf("mirror not configured: %s", out)
			}
			if out := dockerOut(t, "exec", mirrorName, "wget", "-qO-", "http://localhost:5000/v2/_catalog"); !strings.Contains(out, "library/hello-world") {
				t.Fatalf("mirror not used: %s", out)
			}
			// Memory is limited, CPU is not: it only has a priority.
			shares := map[string]string{model.PriorityBackground: "2", model.PriorityLow: "256"}[prio]
			lim := dockerOut(t, "inspect", "-f", "{{.HostConfig.NanoCpus}} {{.HostConfig.CpuShares}} {{.HostConfig.Memory}} {{.HostConfig.Privileged}}", name+"-dind", name+"-runner")
			if lim != "0 "+shares+" 2147483648 true\n0 "+shares+" 2147483648 false\n" {
				t.Fatalf("limits: %q", lim)
			}
			if driver := dockerOut(t, "info", "--format", "{{.CgroupDriver}} {{.CgroupVersion}}"); driver == "systemd 2\n" {
				parents := dockerOut(t, "inspect", "-f", "{{.HostConfig.CgroupParent}}", name+"-dind", name+"-runner")
				if parents != cgroupSlice+"\n"+cgroupSlice+"\n" {
					t.Fatalf("cgroup parents: %q", parents)
				}
				idle, _ := os.ReadFile("/sys/fs/cgroup/" + cgroupSlice + "/cpu.idle")
				weight, _ := os.ReadFile("/sys/fs/cgroup/" + cgroupSlice + "/cpu.weight")
				got := strings.TrimSpace(string(idle)) + " " + strings.TrimSpace(string(weight))
				if want := map[string]string{model.PriorityBackground: "1 1", model.PriorityLow: "0 " + lowWeight}[prio]; got != want {
					t.Fatalf("priority %s: cpu.idle and cpu.weight of the slice are %q, want %q", prio, got, want)
				}
			}

			// A second Start under the same name replaces the first.
			if err := m.Start(ctx, wk, spec); err != nil {
				t.Fatalf("Start again: %v", err)
			}
			if err := m.Remove(ctx, wk, name); err != nil {
				t.Fatalf("Remove: %v", err)
			}
			assertGone(t, name)
			if err := m.Remove(ctx, wk, name); err != nil {
				t.Fatalf("Remove again: %v", err)
			}
		})
	}

	t.Run("real runner exits", func(t *testing.T) {
		name := randName("ci-plane-test-")
		jit := base64.StdEncoding.EncodeToString([]byte(`{"fake":"` + randName("") + `"}`))
		spec := engine.RunnerSpec{Name: name, JITConfig: jit, Image: set.RunnerImage, DindImage: set.DindImage, MemMB: 2048}
		defer m.Remove(context.Background(), w, name)
		begin := time.Now()
		if err := m.Start(ctx, w, spec); err != nil {
			t.Fatalf("Start: %v", err)
		}
		t.Logf("Start with the real runner image took %v", time.Since(begin).Round(time.Millisecond))
		var c engine.Container
		waitFor(t, 60*time.Second, "the runner to give up on the fake configuration", func() bool {
			list, err := m.List(ctx, w)
			for _, x := range list {
				if x.Runner == name {
					c = x
				}
			}
			return err == nil && c.Runner == name && !c.Running
		})
		logs, _ := exec.Command("docker", "logs", name+"-runner").CombinedOutput()
		if strings.Contains(string(logs), jit) {
			t.Fatal("the runner logged the JIT config")
		}
		t.Logf("exit code %d; last log line: %s", c.ExitCode, lastLines(string(logs), 1))
		if err := m.Remove(ctx, w, name); err != nil {
			t.Fatal(err)
		}
		assertGone(t, name)
	})

	t.Run("failed start cleans up", func(t *testing.T) {
		name := randName("ci-plane-test-")
		spec := engine.RunnerSpec{Name: name, JITConfig: randName("fake-jit-"), Image: stubImage, DindImage: "ci-plane-no-such-image:0", MemMB: 512}
		err := m.Start(ctx, w, spec)
		if err == nil {
			t.Fatal("Start with a missing image succeeded")
		}
		t.Logf("error shown: %v", err)
		assertGone(t, name)
	})

	t.Run("probe and cleanup", func(t *testing.T) {
		if err := m.Probe(ctx, w); err != nil {
			t.Fatal(err)
		}
		if out := strings.TrimSpace(dockerOut(t, "ps", "-aq", "--filter", "label="+labelRole+"=probe")); out != "" {
			t.Fatalf("probe container left: %s", out)
		}
		// An externals volume of an old runner image goes; the mirror is
		// emptied once over its cap and runs again afterwards.
		dockerOut(t, "volume", "create", "--label", labelRole+"=externals", "ci-plane-externals-000000000000")
		dockerOut(t, "exec", mirrorName, "sh", "-c", "dd if=/dev/zero of=/var/lib/registry/filler bs=1M count=3 2>/dev/null")
		small := set
		small.MirrorCapMB = 1
		_ = m.st.Tx(func(tx *store.Tx) error { return tx.SaveSettings(small) })
		if err := m.loadSettings(); err != nil {
			t.Fatal(err)
		}
		sum, err := m.Cleanup(ctx, w)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("Cleanup: %s", sum)
		if !strings.Contains(sum, "volume") || !strings.Contains(sum, "emptied the registry mirror") {
			t.Fatalf("summary %q", sum)
		}
		if out := dockerOut(t, "inspect", "-f", "{{.State.Running}}", mirrorName); out != "true\n" {
			t.Fatal("mirror not running after cleanup")
		}
		sum, err = m.Cleanup(ctx, w)
		if err != nil || sum != nothingFreed {
			t.Fatalf("second cleanup: %q %v", sum, err)
		}
	})
}

// Superseded versions of our images go; images that are not ours stay.
// A local registry makes the tag move by a pull, as on a real worker.
func TestJanitorRemovesOnlyOurOldImages(t *testing.T) {
	m, _ := dockerTest(t)
	ctx := context.Background()
	w := model.Worker{ID: 1, Name: "local"}
	m.dial = func(context.Context, model.Worker) (transport, error) { return local{}, nil }

	reg := randName("ci-plane-test-registry-")
	dockerOut(t, "run", "-d", "--name", reg, "-p", "127.0.0.1::5000", "registry:2")
	defer exec.Command("docker", "rm", "-f", "-v", reg).Run()
	port := strings.TrimSpace(strings.Split(strings.Split(dockerOut(t, "port", reg, "5000"), "\n")[0], ":")[1])
	img := "127.0.0.1:" + port + "/ci-plane-test-janitor:latest"
	alias := "localhost:" + port + "/ci-plane-test-janitor:latest" // same repository, another local name
	publish := func(content string) {
		b := exec.Command("docker", "build", "-q", "-t", alias, "-")
		b.Stdin = strings.NewReader("FROM alpine:3.22\nRUN echo " + content + " > /x\n")
		if out, err := b.CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
		waitFor(t, 20*time.Second, "push", func() bool { return exec.Command("docker", "push", "-q", alias).Run() == nil })
		dockerOut(t, "rmi", alias)
	}
	foreign := randName("ci-plane-test-foreign:")
	b := exec.Command("docker", "build", "-q", "-t", foreign, "-")
	b.Stdin = strings.NewReader("FROM alpine:3.22\nRUN echo " + randName("f") + " > /x\n")
	if out, err := b.CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	defer exec.Command("docker", "rmi", foreign).Run()

	publish(randName("v1-"))
	v1, err := m.pull(ctx, w, img)
	if err != nil {
		t.Fatal(err)
	}
	publish(randName("v2-"))
	v2, err := m.pull(ctx, w, img)
	if err != nil {
		t.Fatal(err)
	}
	defer exec.Command("docker", "rmi", "-f", img, v1[1], v2[1]).Run()
	if v1[1] == v2[1] || exec.Command("docker", "image", "inspect", v1[1]).Run() != nil {
		t.Fatal("setup: the old version should be there, untagged")
	}

	set := m.settings()
	set.RunnerImage = img
	m.mu.Lock()
	m.set = set
	m.mu.Unlock()
	sum, err := m.Cleanup(ctx, w)
	t.Logf("Cleanup: %s (%v)", sum, err) // the stub image has no runner tools: that step fails
	if !strings.Contains(sum, "1 old image") {
		t.Fatalf("summary %q", sum)
	}
	if exec.Command("docker", "image", "inspect", v1[1]).Run() == nil {
		t.Fatal("superseded image still there")
	}
	for _, keep := range []string{img, foreign} {
		if exec.Command("docker", "image", "inspect", keep).Run() != nil {
			t.Fatalf("%s was removed", keep)
		}
	}
}
