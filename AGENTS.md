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
| `internal/api/` | CI-Plane's HTTP API, registered on the Z-Dash server; `services.go` holds the contracts |
| `internal/demo/` | demo mode on the simulator |
| `web/` | the interface, on the Z-Dash shell |

CI-Plane runs on the **Z-Dash server** (`github.com/saschazesiger/Z-Dash/server`, its `docs/server.md`): the listeners, the sign-in (the admin password locally, Cloudflare Access through the tunnel), the CSRF and Host guards, the live updates, the Cloudflare tunnel with its settings, and Z-Dash itself at `/z-dash/` come from there. A fix to any of them goes to Z-Dash, then `go get github.com/saschazesiger/Z-Dash/server@main` here (the nightly *Update Z-Dash server* does that). `cmd/ci-plane/tunnel.go` moves a tunnel of an earlier CI-Plane to the server's format once.

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
  minified build (`/z-dash/ds.min.css`, `/z-dash/ds.min.js`) and the shell (`/z-dash/server/`) from the Z-Dash
  server; `web/web.go` embeds only CI-Plane's own files. No framework, no bundler, no other CSS library. Project CSS is a theme (tokens) plus layout glue.
- **Few dependencies.** Standard library, `golang.org/x/crypto`, `modernc.org/sqlite`. Anything else needs a reason.
- **Secrets** go through `internal/secret` and never into logs, events or command lines.
- Text and documentation are English. Comments say why, not what.
- **Test, then push to `main` yourself.** After a change, run the checks below that cover it (and try the change in
  the running app or on the real system where that is possible). Once you are sure it works, rebase onto
  `origin/main`, run the tests again and push to `main` without asking; no pull request needed. If you are not
  sure it works, do not push to `main`: say what is untested and why.

## Commands

```sh
go build ./... && go vet ./...
go test ./...                      # the engine tests take about half a minute
go test -race ./internal/engine/   # slower, run before changing the engine
go mod download github.com/saschazesiger/Z-Dash/server
ZD="$(go list -m -f '{{.Dir}}' github.com/saschazesiger/Z-Dash/server)/zdash/dist"
rm -rf web/.z-dash && cp -R "$ZD" web/.z-dash && chmod -R u+w web/.z-dash   # the module's copy of Z-Dash, for its tools
node web/.z-dash/tools/check-project.mjs --config web/ds-check.json   # needs Node 22
CI_PLANE_DEMO=1 go run ./cmd/ci-plane   # the interface on simulated workers, http://localhost:8080
```
