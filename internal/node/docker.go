package node

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/saschazesiger/CI-Plane/internal/engine"
	"github.com/saschazesiger/CI-Plane/internal/model"
)

// Labels. Everything of one runner carries labelRunner, which is what List
// and Remove go by. Shared objects carry labelRole instead, so the engine
// never sees them as runners and never removes them.
const (
	labelRunner = "ci-plane.runner"
	labelRole   = "ci-plane.role" // mirror, externals, probe
	mirrorName  = "ci-plane-mirror"
	// dockerGID owns the socket of the inner daemon. It is the group docker
	// of the official runner image; the runner container also gets it with
	// --group-add, so custom images work as well.
	dockerGID = "123"
)

var nameRe = regexp.MustCompile(`^ci-plane-[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

func checkName(name string) error {
	if !nameRe.MatchString(name) || len(name) > 100 {
		return fmt.Errorf("refusing to touch %q: CI-Plane only manages Docker objects named ci-plane-...", name)
	}
	return nil
}

// removeScript removes every Docker object of runner $n and fails if any is
// left. Containers go first (with their anonymous volumes), then the network
// (after the mirror left it), then the named volumes.
const removeScript = `l="` + labelRunner + `=$n"
ids=$(docker ps -aq --filter "label=$l")
[ -z "$ids" ] || docker rm -f -v $ids >/dev/null
docker rm -f -v "$n-runner" "$n-dind" >/dev/null 2>&1 || :
for x in $(docker network ls -q --filter "label=$l"); do
  docker network disconnect -f "$x" ` + mirrorName + ` >/dev/null 2>&1 || :
  docker network rm "$x" >/dev/null
done
vols=$(docker volume ls -q --filter "label=$l")
[ -z "$vols" ] || docker volume rm -f $vols >/dev/null
left=$(docker ps -aq --filter "label=$l"; docker volume ls -q --filter "label=$l"; docker network ls -q --filter "label=$l")
if [ -n "$left" ]; then echo "Docker objects of $n are still there after removing them: $(echo $left)" >&2; exit 1; fi
`

// externalsScript sets $ext to the volume that holds the runner tools of
// image $img. Container jobs mount <runner>/externals from the daemon that
// runs them, so the inner daemon needs them at the same path. Copying 600 MB
// per job would take seconds; one read-only copy per image version is shared
// by all runners instead.
const externalsScript = `ext=ci-plane-externals-$(docker image inspect -f '{{.Id}}' "$img" | sed 's/^sha256://' | cut -c1-12)
docker volume create --label ` + labelRole + `=externals "$ext" >/dev/null
`

// fillExternals copies the runner tools into $ext unless that was finished
// before; the marker is written last, so an interrupted copy is redone.
const fillExternals = `docker run --rm --network none -u 0 -v "$ext:/e" --entrypoint sh "$img" -c 'test -f /e/.ci-plane-ready || { cp -a /home/runner/externals/. /e/ && touch /e/.ci-plane-ready; }'
`

func limits(spec engine.RunnerSpec) string {
	var b strings.Builder
	if spec.CPUs > 0 {
		b.WriteString(" --cpus " + strconv.FormatFloat(spec.CPUs, 'f', -1, 64))
	}
	if spec.MemMB > 0 {
		b.WriteString(" --memory " + strconv.Itoa(spec.MemMB) + "m")
	}
	return b.String()
}

// startScript starts the two containers of a runner. The JIT config arrives
// as the first line of stdin and only ever passes through printf, a shell
// builtin, into the env file of the runner container, so it is never part
// of a command line.
//
// Layout (the "dind" mode of actions-runner-controller):
//
//	<n>-net        network of the runner; the mirror joins it
//	<n>-dind       docker:dind, privileged; its data on <n>-docker
//	<n>-runner     the runner, in the network namespace of <n>-dind so that
//	               ports of service containers answer on localhost
//	<n>-work       /home/runner/_work in both: container jobs bind-mount it
//	<n>-run        /var/run in both: the socket of the inner daemon
//	externals      /home/runner/externals, read-only in <n>-dind
func startScript(spec engine.RunnerSpec) string {
	lim := limits(spec)
	return `set -e
IFS= read -r jit || :
n=` + q(spec.Name) + `
img=` + q(spec.Image) + `
dind=` + q(spec.DindImage) + `
l="` + labelRunner + `=$n"
` + removeScript + `
for i in "$img" "$dind"; do
  docker image inspect "$i" >/dev/null 2>&1 || docker pull -q "$i" >/dev/null || { echo "Could not pull the image $i; check its name in the settings." >&2; exit 1; }
done
` + externalsScript + `
docker network create --label "$l" "$n-net" >/dev/null
for v in docker work run; do docker volume create --label "$l" "$n-$v" >/dev/null; done
docker network connect "$n-net" ` + mirrorName + ` >/dev/null 2>&1 || echo "The registry mirror is not running; Docker Hub is used directly." >&2
docker run -d --name "$n-dind" --label "$l" --privileged` + lim + ` --network "$n-net" \
  -e DOCKER_TLS_CERTDIR= \
  -v "$n-docker:/var/lib/docker" -v "$n-work:/home/runner/_work" -v "$n-run:/var/run" \
  -v "$ext:/home/runner/externals:ro" \
  --entrypoint sh "$dind" -c 'chmod 0777 /home/runner/_work && exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --group=` + dockerGID + ` --registry-mirror=http://` + mirrorName + `:5000' >/dev/null
i=0
until docker exec "$n-dind" docker version >/dev/null 2>&1; do
  i=$((i+1))
  if [ "$i" -gt 300 ] || [ "$(docker inspect -f '{{.State.Running}}' "$n-dind")" != true ]; then
    echo "The Docker daemon of the runner did not start:" >&2
    docker logs --tail 10 "$n-dind" >&2 2>&1 || :
    exit 1
  fi
  sleep 0.2
done
docker exec "$n-dind" test -f /home/runner/externals/.ci-plane-ready || ` + fillExternals + `
printf 'ACTIONS_RUNNER_INPUT_JITCONFIG=%s\n' "$jit" | docker create --name "$n-runner" --label "$l"` + lim + ` \
  --network "container:$n-dind" --group-add ` + dockerGID + ` \
  -v "$n-work:/home/runner/_work" -v "$n-run:/var/run" \
  --env-file /dev/stdin "$img" ./run.sh >/dev/null
docker start "$n-runner" >/dev/null
`
}

// Start implements engine.Fleet.
func (m *Manager) Start(ctx context.Context, w model.Worker, spec engine.RunnerSpec) error {
	if err := checkName(spec.Name); err != nil {
		return err
	}
	if spec.JITConfig == "" || strings.ContainsAny(spec.JITConfig, "\r\n") {
		return errors.New("the runner configuration from GitHub is empty or malformed")
	}
	if spec.Image == "" || spec.DindImage == "" {
		return errors.New("the runner image or the Docker-in-Docker image is not set in the settings")
	}
	_, err := m.sh(ctx, w, startScript(spec), spec.JITConfig+"\n")
	if err == nil {
		return nil
	}
	// A real JIT config is kilobytes long; replacing a short test value
	// would only mangle the text.
	if len(spec.JITConfig) >= 8 {
		err = errors.New(strings.ReplaceAll(err.Error(), spec.JITConfig, "[runner configuration]"))
	}
	// Undo the half start even when ctx has ended.
	cctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
	defer cancel()
	if rerr := m.Remove(cctx, w, spec.Name); rerr != nil {
		return fmt.Errorf("%w (removing what was started also failed: %v)", err, rerr)
	}
	return err
}

// Remove implements engine.Fleet.
func (m *Manager) Remove(ctx context.Context, w model.Worker, runner string) error {
	if err := checkName(runner); err != nil {
		return err
	}
	_, err := m.sh(ctx, w, "set -e\nn="+q(runner)+"\n"+removeScript, "")
	return err
}

const listScript = `set -e
docker ps -a --filter label=` + labelRunner + ` --format 'c	{{.Label "` + labelRunner + `"}}	{{.Names}}	{{.State}}	{{.Status}}'
docker volume ls --filter label=` + labelRunner + ` --format 'v	{{.Label "` + labelRunner + `"}}'
docker network ls --filter label=` + labelRunner + ` --format 'n	{{.Label "` + labelRunner + `"}}'
`

var exitRe = regexp.MustCompile(`^Exited \((-?\d+)\)`)

// List implements engine.Fleet.
func (m *Manager) List(ctx context.Context, w model.Worker) ([]engine.Container, error) {
	out, err := m.sh(ctx, w, listScript, "")
	if err != nil {
		return nil, err
	}
	return parseList(out), nil
}

func parseList(out string) []engine.Container {
	byName := map[string]*engine.Container{}
	var order []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 2 || nameRe.FindString(f[1]) == "" {
			continue
		}
		c := byName[f[1]]
		if c == nil {
			c = &engine.Container{Runner: f[1]}
			byName[f[1]] = c
			order = append(order, f[1])
		}
		if f[0] == "c" && len(f) == 5 && f[2] == f[1]+"-runner" {
			c.Running = f[3] == "running"
			if m := exitRe.FindStringSubmatch(f[4]); m != nil {
				c.ExitCode, _ = strconv.Atoi(m[1])
			}
		}
	}
	list := make([]engine.Container, 0, len(order))
	for _, n := range order {
		list = append(list, *byName[n])
	}
	return list
}

// Probe implements engine.Fleet: it runs a tiny container.
func (m *Manager) Probe(ctx context.Context, w model.Worker) error {
	return m.probe(ctx, w, m.settings().DindImage)
}

func (m *Manager) probe(ctx context.Context, w model.Worker, image string) error {
	id := make([]byte, 4)
	_, _ = rand.Read(id)
	name := "ci-plane-probe-" + hex.EncodeToString(id)
	_, err := m.sh(ctx, w, "set -e\ndocker run --rm --network none --label "+labelRole+"=probe --name "+name+
		" --entrypoint true "+q(image)+" >/dev/null", "")
	if err != nil {
		return fmt.Errorf("The worker could not run a test container: %v", err)
	}
	return nil
}

// mirrorScript makes sure the registry mirror runs the current image of
// $mimg. A new mirror joins the networks of running runners again.
const mirrorScript = `want=$(docker image inspect -f '{{.Id}}' "$mimg")
have=$(docker inspect -f '{{.Image}} {{.State.Running}}' ` + mirrorName + ` 2>/dev/null) || :
if [ "$have" != "$want true" ]; then
  docker rm -f ` + mirrorName + ` >/dev/null 2>&1 || :
  docker volume create --label ` + labelRole + `=mirror ` + mirrorName + ` >/dev/null
  docker run -d --name ` + mirrorName + ` --label ` + labelRole + `=mirror --restart always \
    -v ` + mirrorName + `:/var/lib/registry -e REGISTRY_PROXY_REMOTEURL=https://registry-1.docker.io "$mimg" >/dev/null
  for x in $(docker network ls -q --filter label=` + labelRunner + `); do docker network connect "$x" ` + mirrorName + ` >/dev/null 2>&1 || :; done
  echo started
fi
`

// Prepare implements api.Workers.
func (m *Manager) Prepare(ctx context.Context, w model.Worker, progress func(step string)) error {
	if progress == nil {
		progress = func(string) {}
	}
	set := m.settings()
	progress("Checking Docker")
	if _, err := m.sh(ctx, w, "docker version --format '{{.Server.Version}}'", ""); err != nil {
		return err
	}
	for _, p := range []struct{ what, image string }{
		{"the runner image", set.RunnerImage},
		{"the Docker-in-Docker image", set.DindImage},
		{"the registry mirror image", set.MirrorImage},
	} {
		progress("Pulling " + p.what)
		if _, err := m.pull(ctx, w, p.image); err != nil {
			return fmt.Errorf("Pulling %s %s failed: %v", p.what, p.image, err)
		}
	}
	progress("Preparing the runner tools")
	if _, err := m.sh(ctx, w, "set -e\nimg="+q(set.RunnerImage)+"\n"+externalsScript+fillExternals, ""); err != nil {
		return fmt.Errorf("Copying the runner tools failed: %v", err)
	}
	progress("Starting the registry mirror")
	if _, err := m.sh(ctx, w, "set -e\nmimg="+q(set.MirrorImage)+"\n"+mirrorScript, ""); err != nil {
		return fmt.Errorf("Starting the registry mirror failed: %v", err)
	}
	progress("Running a test container")
	return m.probe(ctx, w, set.DindImage)
}

// pull pulls an image and returns its id before and after; both are
// remembered as ours, so the janitor may remove them once superseded.
func (m *Manager) pull(ctx context.Context, w model.Worker, image string) ([2]string, error) {
	out, err := m.sh(ctx, w, `set -e
i=`+q(image)+`
docker image inspect -f '{{.Id}}' "$i" 2>/dev/null || echo none
docker pull -q "$i" >/dev/null
docker image inspect -f '{{.Id}}' "$i"`, "")
	if err != nil {
		return [2]string{}, err
	}
	f := strings.Fields(out)
	if len(f) != 2 {
		return [2]string{}, fmt.Errorf("unexpected answer from docker: %q", out)
	}
	ids := [2]string{f[0], f[1]}
	m.rememberImages(w.ID, ids[:]...)
	return ids, nil
}
