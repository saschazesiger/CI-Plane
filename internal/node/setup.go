package node

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"

	"golang.org/x/crypto/ssh"

	"github.com/saschazesiger/CI-Plane/internal/api"
)

// SetupCommand implements api.Workers. The line is self-contained: it
// carries the public key and downloads nothing from CI-Plane, only Docker
// from get.docker.com when it is missing. Every step may run twice.
func (m *Manager) SetupCommand() string {
	steps := []string{
		`set -e`,
		`[ "$(id -u)" = 0 ] || { echo "Run this command as root, for example after sudo -i" >&2; exit 1; }`,
		`if ! command -v docker >/dev/null 2>&1; then echo "Installing Docker from https://get.docker.com"; ` +
			`if command -v curl >/dev/null 2>&1; then :; elif command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl ca-certificates >/dev/null; ` +
			`elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl; else yum install -y -q curl; fi; ` +
			`curl -fsSL https://get.docker.com -o /tmp/get-docker.sh; sh /tmp/get-docker.sh; rm -f /tmp/get-docker.sh; fi`,
		`if [ -d /run/systemd/system ]; then systemctl enable --now docker; else service docker start >/dev/null 2>&1 || :; fi`,
		`i=0; until docker info >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 30 ] || { echo "Docker is installed but does not start; see journalctl -u docker" >&2; exit 1; }; sleep 1; done`,
		`getent group docker >/dev/null || groupadd docker`,
		`id ` + defaultUser + ` >/dev/null 2>&1 || useradd -m -s /bin/sh ` + defaultUser,
		// "*" instead of the locked "!": no password works, but sshd does not
		// treat the account as locked when UsePAM is off.
		`usermod -aG docker -p "*" ` + defaultUser,
		`h=$(getent passwd ` + defaultUser + ` | cut -d: -f6); mkdir -p "$h/.ssh"; touch "$h/.ssh/authorized_keys"`,
		`k="restrict ` + m.pub + `"; grep -qxF "$k" "$h/.ssh/authorized_keys" || echo "$k" >> "$h/.ssh/authorized_keys"`,
		`chown -R ` + defaultUser + `: "$h/.ssh"; chmod 700 "$h/.ssh"; chmod 600 "$h/.ssh/authorized_keys"`,
		`if command -v restorecon >/dev/null 2>&1; then restorecon -R "$h/.ssh"; fi`,
		`echo "CI-Plane: this server is ready. Docker $(docker version --format "{{.Server.Version}}") runs and the user ` + defaultUser + ` may use it. Go back to CI-Plane to continue."`,
	}
	return "sh -c '" + strings.Join(steps, "; ") + "'"
}

// RemoveCommand implements api.Workers.
func (m *Manager) RemoveCommand() string {
	steps := []string{
		`[ "$(id -u)" = 0 ] || { echo "Run this command as root, for example after sudo -i" >&2; exit 1; }`,
		`if command -v docker >/dev/null 2>&1; then ` +
			`for c in $(docker ps -aq --filter label=` + labelRunner + `) $(docker ps -aq --filter label=` + labelRole + `); do docker rm -f -v "$c" >/dev/null; done; ` +
			`for n in $(docker network ls -q --filter label=` + labelRunner + `); do docker network rm "$n" >/dev/null; done; ` +
			`for v in $(docker volume ls -q --filter label=` + labelRunner + `) $(docker volume ls -q --filter label=` + labelRole + `); do docker volume rm -f "$v" >/dev/null; done; fi`,
		// The SSH session of CI-Plane is still open; end it, or userdel
		// refuses. /proc instead of pkill, which minimal systems lack.
		`if id ` + defaultUser + ` >/dev/null 2>&1; then for p in /proc/[0-9]*; do [ "$(stat -c %U "$p" 2>/dev/null)" != ` + defaultUser + ` ] || kill -9 "${p#/proc/}" 2>/dev/null || :; done; sleep 1; userdel -r ` + defaultUser + ` 2>/dev/null || userdel -f -r ` + defaultUser + ` 2>/dev/null || :; fi`,
		`if id ` + defaultUser + ` >/dev/null 2>&1; then echo "The user ` + defaultUser + ` could not be removed; remove it with userdel -r ` + defaultUser + `" >&2; exit 1; fi`,
		`echo "CI-Plane was removed from this server: its containers, volumes, networks and the user ` + defaultUser + ` are gone. Docker and its images stay installed; remove them yourself if you no longer need them."`,
	}
	return "sh -c '" + strings.Join(steps, "; ") + "'"
}

// factsScript prints what Check reports, one "key value" per line.
const factsScript = `echo "cpus $(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)"
awk '/^MemTotal:/{print "mem", int($2/1024)}' /proc/meminfo
. /etc/os-release 2>/dev/null || :
echo "os ${NAME:-Linux} ${VERSION_ID:-}"
echo "arch $(uname -m)"
if ! command -v docker >/dev/null 2>&1; then echo "docker-missing"; exit 0; fi
if v=$(docker version --format '{{.Server.Version}}' 2>&1); then echo "docker $v"; else echo "docker-error $(echo "$v" | tr '\n' ' ')"; fi
r=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null) || :
[ -n "$r" ] && [ -e "$r" ] || r=/var/lib/docker
[ -e "$r" ] || r=/
df -Pm "$r" | awk 'NR==2{print "disk", $2, $4}'
`

// Check implements api.Workers. It accepts whatever host key it sees (trust
// on first use) and returns it with the facts, so the caller can pin it.
func (m *Manager) Check(ctx context.Context, host string, port int, user string) (api.WorkerFacts, error) {
	if port == 0 {
		port = 22
	}
	if user == "" {
		user = defaultUser
	}
	host = strings.TrimSpace(host)
	if host == "" {
		return api.WorkerFacts{}, errors.New("Enter the address of the server.")
	}
	var facts api.WorkerFacts
	seen := func(_ string, _ net.Addr, k ssh.PublicKey) error {
		facts.HostKey = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k)))
		facts.Fingerprint = ssh.FingerprintSHA256(k)
		return nil
	}
	t, err := dialSSH(ctx, net.JoinHostPort(host, strconv.Itoa(port)), user, m.signer, seen, tofuAlgos)
	if err != nil {
		return facts, err
	}
	defer t.close()
	out, err := runOn(ctx, t, factsScript, "")
	if err != nil {
		return facts, fmt.Errorf("Connected, but reading the facts of the server failed: %v", err)
	}
	return facts, parseFacts(out, user, &facts)
}

func parseFacts(out, user string, f *api.WorkerFacts) error {
	var dockerErr error
	for _, line := range strings.Split(out, "\n") {
		key, val, _ := strings.Cut(strings.TrimSpace(line), " ")
		val = strings.TrimSpace(val)
		switch key {
		case "cpus":
			f.CPUs, _ = strconv.Atoi(val)
		case "mem":
			f.MemMB, _ = strconv.Atoi(val)
		case "os":
			f.OS = val
		case "arch":
			f.Arch = val
		case "docker":
			f.Docker = val
		case "disk":
			if p := strings.Fields(val); len(p) == 2 {
				f.DiskMB, _ = strconv.Atoi(p[0])
				f.DiskFreeMB, _ = strconv.Atoi(p[1])
			}
		case "docker-missing":
			dockerErr = errors.New("Docker is not installed. Paste the setup command on the server as root, then try again.")
		case "docker-error":
			dockerErr = explainDocker(val, errors.New(val))
			if strings.Contains(strings.ToLower(val), "permission denied") {
				dockerErr = fmt.Errorf("permission denied on the Docker socket: %s. The user %s must be in the group docker: paste the setup command on the server as root, then try again.", val, user)
			}
		}
	}
	if dockerErr != nil {
		return dockerErr
	}
	if f.Arch != "" && f.Arch != "x86_64" && f.Arch != "amd64" {
		return fmt.Errorf("This server is %s; CI-Plane runs runners on x86_64 (amd64) servers only.", f.Arch)
	}
	return nil
}
