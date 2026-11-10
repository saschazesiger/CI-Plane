# 🛠️ Development

This page covers the layout of the code, how to build and test it, the demo mode, how to regenerate the screenshots
and GIFs, and how the vendored design system is updated. The rules for changes are in [AGENTS.md](../AGENTS.md).

## 🗂️ Layout

| Path | What |
|---|---|
| `cmd/ci-plane/` | `main`: reads the environment, wires the packages together, runs the two listeners |
| `internal/model/` | domain types, settings and their defaults, label matching |
| `internal/store/` | SQLite (WAL); the only place with SQL |
| `internal/secret/` | encryption at rest (AES-256-GCM) |
| `internal/engine/` | the scheduler and supervisor; defines `Forge` (GitHub) and `Fleet` (workers) |
| `internal/sim/` | `Forge` and `Fleet` in memory: tests and demo mode |
| `internal/node/` | workers over SSH: the setup and remove commands, Docker scripts, live values, janitor |
| `internal/github/` | GitHub Apps: manifest flow, tokens, just-in-time runners, webhooks, redelivery |
| `internal/cloudflare/` | tunnel and Access setup, the `cloudflared` supervisor, Access token checks |
| `internal/api/` | HTTP API, login, live updates (server-sent events); `services.go` holds the contracts |
| `internal/demo/` | demo mode on the simulator, with stand-ins for GitHub, Cloudflare and workers |
| `web/` | the interface: `index.html`, `app/*.js`, `theme.css`, `app.css`, embedded into the binary |
| `web/vendor/dashboard-style/` | a verified copy of Dashboard-Style; never edit it |
| `scripts/screenshots.mjs` | the screenshots and GIFs of the documentation |
| `docs/` | this documentation; `docs/images/` is generated |

Dependencies are the standard library, `golang.org/x/crypto` (SSH, Argon2) and `modernc.org/sqlite` (no cgo).

## 🔨 Build

Go 1.27 or newer:

```sh
go build ./... && go vet ./...
go build -o ci-plane ./cmd/ci-plane
docker build -t ci-plane:dev .        # the image: the binary, cloudflared (pinned by version and checksum), alpine
```

The version shown in the interface is set with `-ldflags "-X main.version=v0.1.0"` (the release workflow passes the
tag as the build argument `VERSION`).

## 🧪 Tests

```sh
go test ./...                         # everything; the engine tests take about half a minute
go test -race ./internal/engine/      # slower; run it before changing the engine
```

| Package | Covers |
|---|---|
| `internal/engine` | scheduling, tiers, limits, every failure in [Reliability](reliability.md), restarts mid-step, 60-job runs; all on the simulator |
| `internal/github` | manifest flow, tokens, runners, webhooks and signatures, redelivery, against a fake GitHub API |
| `internal/cloudflare` | setup, repair, removal, the supervisor and Access tokens, against a fake Cloudflare API and a fake `cloudflared` |
| `internal/node` | SSH against an in-process SSH server, parsing, the scripts |
| `internal/api`, `store`, `model`, `secret`, `demo` | the HTTP API and login, storage, label matching, encryption, the demo |

Two tests in `internal/node` need Docker and are skipped unless switched on:

```sh
# Starts and removes real runners on the local Docker daemon and asserts that nothing is left.
CI_PLANE_DOCKER_TEST=1 go test -run 'TestDocker|TestJanitor' -v ./internal/node/

# Pastes the setup command into clean privileged Ubuntu 24.04 and Debian 13 containers with sshd,
# installs Docker from get.docker.com, connects over SSH like CI-Plane does, then runs the remove command.
CI_PLANE_SETUP_TEST=1 go test -run TestSetupOnFreshServer -v ./internal/node/
```

Both pull images and need internet; the setup test takes several minutes.

The interface has no build step. Before a change to `web/`, check it against Dashboard-Style's rules and check that
the vendored copy is untouched (needs Node for the first command):

```sh
node web/vendor/dashboard-style/tools/check-project.mjs --config web/ds-check.json
sh web/vendor/dashboard-style/tools/verify.sh web/vendor/dashboard-style
```

CI (`.github/workflows/ci.yml`) runs the verification, `go vet`, `go test -race ./...` and a Docker build. The
release workflow pushes `ghcr.io/saschazesiger/ci-plane:edge` from `main`, and `X.Y.Z`, `X.Y` and `latest` plus a
GitHub release from a tag `vX.Y.Z`.

## 🎭 Demo mode

```sh
CI_PLANE_DEMO=1 go run ./cmd/ci-plane
```

Open <http://localhost:8080>. The real engine and interface run against the simulator: a few accounts, repositories
and five workers, jobs queued at a natural rhythm, now and then an incident. Nothing real is touched; there is no
login and no tunnel listener.

| Variable | |
|---|---|
| `CI_PLANE_DEMO_FRESH=1` | start empty, as on a first run, with the login on, to click through the setup assistant |
| `CI_PLANE_DEMO_SEED=n` | another set of accounts, workers and history (default 1) |
| `CI_PLANE_DEMO_SPEED=n` | run faster or slower, 0.1 to 100 (default 1) |
| `CI_PLANE_DEMO_FREEZE=1` | stop moving after about ten seconds, for screenshots |

In the assistants, a worker address that contains `fail` or `offline` does not answer, and a Cloudflare subdomain
that contains `broken` fails at the DNS step, so the error paths can be tried. The pages that play GitHub's part are
served under `/demo/`. The demo's setup and remove commands are short stand-ins, not the real ones.

## 📸 Screenshots and GIFs

Everything in `docs/images/` comes from `scripts/screenshots.mjs`. It builds CI-Plane, starts the demo on ports
18080 to 18082, drives Chromium with Playwright and writes the images. Install Playwright outside the repository and
point `NODE_PATH` at it; GIFs need `ffmpeg` on the `PATH` (or `FFMPEG=/path/to/ffmpeg`):

```sh
npm install --prefix /tmp/pw playwright@1.63.0
/tmp/pw/node_modules/.bin/playwright install chromium
NODE_PATH=/tmp/pw/node_modules node scripts/screenshots.mjs              # everything, about two minutes
NODE_PATH=/tmp/pw/node_modules node scripts/screenshots.mjs stills       # or one part: stills, setup, live
```

| Part | Demo | Writes |
|---|---|---|
| `stills` | frozen, seed 1 | `overview.png` (the hero, 1440 wide), `overview-dark.png`, `jobs.png`, `jobs-timeline.png`, `workers.png`, `repositories.png`, `settings.png`, `phone-overview.png`, `phone-workers.png` |
| `setup` | fresh, speed 3 | `setup-1-password.png` … `setup-5-try.png`, `setup.gif` (the assistant end to end) |
| `live` | running, speed 3 | `live.gif` (overview and jobs while jobs move) |

The GIFs are made from screenshots taken in a loop rather than a screen video: lossless frames of a flat interface
give much smaller, sharper GIFs. Waits play six times faster. Keep each GIF under about 3 MB and look at every picture
before you commit it. `KEEP_TMP=1` keeps the frames for inspection.

## 🎨 The vendored design system

The interface uses only [Dashboard-Style](https://github.com/saschazesiger/Dashboard-Style), vendored in
`web/vendor/dashboard-style/` with a `SHA256SUMS` file and the commit in `VERSION`. Never edit the copy; the project's
look lives in `web/theme.css` (tokens) and `web/app.css` (layout glue).

The workflow `.github/workflows/update-dashboard-style.yml` checks Dashboard-Style's `main` once a day, vendors a new
commit, verifies it, runs `go test ./...` and commits the update. To update by hand:

```sh
commit=$(curl -fsSL -H 'Accept: application/vnd.github.sha' https://api.github.com/repos/saschazesiger/Dashboard-Style/commits/main)
curl -fsSL "https://raw.githubusercontent.com/saschazesiger/Dashboard-Style/$commit/scripts/vendor.sh" -o /tmp/vendor.sh
sh /tmp/vendor.sh "$commit" web/vendor/dashboard-style
sh web/vendor/dashboard-style/tools/verify.sh web/vendor/dashboard-style
go test ./...
```
