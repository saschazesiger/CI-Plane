# Working on CI-Plane

CI-Plane starts ephemeral GitHub Actions runners on your own servers. One Go binary, one container, one SQLite
file. Read [docs/how-it-works.md](docs/how-it-works.md) for the design before changing behaviour.

## Layout

| Path | What |
|---|---|
| `cmd/ci-plane/` | `main`: wires the packages together |
| `internal/model/` | domain types, settings, label matching |
| `internal/store/` | SQLite; the only place with SQL |
| `internal/secret/` | encryption at rest |
| `internal/engine/` | the scheduler and supervisor; defines `Forge` (GitHub) and `Fleet` (workers); `pools.go` runs runners on machines of other providers ([docs/pools.md](docs/pools.md)) |
| `internal/sim/` | `Forge` and `Fleet` in memory: tests and demo mode |
| `internal/node/` | workers over SSH: implements `engine.Fleet` and `api.Workers`; `docker.go` holds the start script of a runner, also used on pools |
| `internal/github/` | GitHub Apps: implements `engine.Forge` and `api.GitHub`, webhooks; `relay.go` starts the runners of pools through the relay workflow and hands them out at `/webhook/relay` |
| `internal/cloudflare/` | tunnel and Access: implements `api.Cloudflare` |
| `internal/api/` | HTTP API, login, live updates; `services.go` holds the contracts |
| `internal/demo/` | demo mode on the simulator |
| `web/` | the interface; `web/vendor/z-dash/` is a verified copy of Z-Dash 3, never edit it |

## Rules

- **Durability first.** Every action on a worker or on GitHub is idempotent and is stored as an intent before it is
  carried out. Nothing may depend on a webhook arriving, on the process staying alive, or on a worker answering.
  A change to `internal/engine` comes with a test on the simulator.
- **Only touch what is ours.** On a worker, CI-Plane creates and removes only Docker objects whose name starts with
  `ci-plane-` and that carry a `ci-plane.*` label. On GitHub, only runners named `ci-plane-*`.
- **Errors are for the person in front of the interface.** Say what happened and what to do, in plain English.
- **Interface: Z-Dash only** (formerly Dashboard-Style). Use its components (`ds-*`), option classes (`ds-tone-*`,
  `ds-sm`, `ds-density-*`) and `DS.*` helpers as documented in <https://github.com/saschazesiger/Z-Dash>
  (`docs/components.md`, `docs/options.md`, `docs/patterns.md`, `docs/rules.md`, `example/`). The page loads the
  minified build (`ds.min.css`, `ds.min.js`); `web/web.go` embeds only those files of the copy. No framework, no bundler, no other CSS library. Project CSS is a theme (tokens) plus layout glue.
- **Few dependencies.** Standard library, `golang.org/x/crypto`, `modernc.org/sqlite`. Anything else needs a reason.
- **Secrets** go through `internal/secret` and never into logs, events or command lines.
- Text and documentation are English. Comments say why, not what.

## Commands

```sh
go build ./... && go vet ./...
go test ./...                      # the engine tests take about half a minute
go test -race ./internal/engine/   # slower, run before changing the engine
sh web/vendor/z-dash/tools/verify.sh web/vendor/z-dash
node web/vendor/z-dash/tools/check-project.mjs --config web/ds-check.json   # needs Node 22
CI_PLANE_DEMO=1 go run ./cmd/ci-plane   # the interface on simulated workers, http://localhost:8080
```
