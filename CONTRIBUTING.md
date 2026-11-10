# 🤝 Contributing

Thanks for helping. Issues and pull requests are welcome; for larger changes, open an issue first.

## Build and test

```sh
go build ./... && go vet ./...
go test ./...                                  # the engine tests take about half a minute
go test -race ./internal/engine/               # before changing the engine
sh web/vendor/dashboard-style/tools/verify.sh web/vendor/dashboard-style
CI_PLANE_DEMO=1 go run ./cmd/ci-plane          # the interface on simulated workers, http://localhost:8080
```

Opt-in tests against Docker, the demo mode and the screenshots are described in
[docs/development.md](docs/development.md).

## Rules

These come from [AGENTS.md](AGENTS.md), which has the details.

- **Durability first.** Every action on a worker or on GitHub is idempotent and stored as an intent before it is
  carried out. Nothing may depend on a webhook arriving, on the process staying alive, or on a worker answering.
  A change to `internal/engine` comes with a test on the simulator.
- **Only touch what is ours.** On a worker, only Docker objects named `ci-plane-*` with a `ci-plane.*` label; on
  GitHub, only runners named `ci-plane-*`.
- **Errors are for the person in front of the interface.** Say what happened and what to do, in plain English.
- **Interface: Dashboard-Style only.** Its components and helpers, no framework, no bundler, no other CSS library.
  Never edit `web/vendor/dashboard-style/`.
- **Few dependencies.** Standard library, `golang.org/x/crypto`, `modernc.org/sqlite`. Anything else needs a reason.
- **Secrets** go through `internal/secret` and never into logs, events or command lines.
- Text and documentation are English. Comments say why, not what.

## Pull requests

Keep them focused, describe what changes for the user, and update the documentation and the
[changelog](CHANGELOG.md) when behaviour changes. If the interface changes, regenerate the affected pictures with
`scripts/screenshots.mjs`.

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
