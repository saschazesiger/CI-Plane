# 🔭 Future work

This page lists ideas that were considered and **not built**, with what each would need, so they can be picked up
later. Nothing here works today unless it says so.

| Mark | Meaning |
|---|---|
| ✅ built in | a preset of CI-Plane; its tests cover it against a simulated GitHub, not on the provider's machines |
| 🧪 untested | should work as it is, but nobody has tried it |
| 📝 not built | needs code |

## 🧩 Other CI services as pools

[Pools](pools.md) start a runner of GitHub Actions through a workflow on a machine of GitHub Actions. A CI service
that is not a provider of GitHub Actions runners would need an adapter of its own: another way to start the machine,
and another way for the machine to prove who it is when it collects the runner.

### CircleCI 📝

CircleCI is a CI of its own, not a provider of GitHub Actions runners. An adapter would need:

- **Start**: start a pipeline through CircleCI's API with the runner's name as a pipeline parameter.
- **Config**: a config in a CircleCI project that runs the relay script on a machine executor (Docker must be
  available, as on a GitHub machine).
- **Collect**: CircleCI's OIDC token (`$CIRCLE_OIDC_TOKEN`, issuer `https://oidc.circleci.com/org/<organization id>`)
  instead of GitHub's, with checks of its own claims (project, pipeline, who started it) in place of those of
  [`/webhook/relay`](pools.md#-security).
- **Watch**: list and cancel pipelines, as the runs of the relay workflow are listed and stopped now.
- **Secret**: a CircleCI API token, stored encrypted through `internal/secret`.

Limits to know:

- Jobs end after 1 hour on the Free plan, 3 hours on Performance, 5 hours on Scale.
- OIDC tokens live 1 hour by default.
- **Check the terms of use first**: whether CircleCI allows running another CI's runner on its machines.

### Travis CI 📝 (not recommended)

The same adapter idea through API v3 (`POST /repo/{slug}/requests` with a custom config). Against it:

- No confirmed OIDC support: collecting the runner would need a stored secret in Travis instead of a token that
  proves which build asks.
- No lasting free plan.
- Reports that builds started through the API with a custom config are unreliable.

## 🏊 Other providers of GitHub Actions runners

🧪 Providers whose machines run GitHub Actions jobs by a `runs-on` label should work today as **Another provider**:
Depot, Namespace, Ubicloud, WarpBuild, BuildJet. They are **untested**. What to check for each:

- its GitHub App is installed on the relay repository (most need an organisation);
- the label of a machine for standard and for large jobs;
- the machine has Docker, `curl` and `jq`, and may run privileged containers (the job's own Docker daemon);
- the OIDC token of the run is GitHub's, as on GitHub-hosted machines.

Once one is tried, it could get a preset with its default labels, as Blacksmith has.

| Provider | Status |
|---|---|
| GitHub-hosted runners, Blacksmith | ✅ built in; see [Pools](pools.md#-providers) |
| Depot, Namespace, Ubicloud, WarpBuild, BuildJet | 🧪 untested |

## 💡 Other ideas 📝

- **Real minutes instead of counted ones.** A pool's budget is counted by CI-Plane from the dispatch to the end of
  the runner ([Budget](pools.md#-budget)). GitHub's billing API could give the real minutes of the relay repository's
  owner; other providers would need their own API.
- **A registry login per pool.** A private runner image that needs a login cannot be pulled on a pool's machine
  today. A login stored encrypted per pool, handed to the run with the configuration, would allow it.
- **Cloud VMs as workers.** Start a VM at a cloud provider when the queue grows, add it as a worker, remove it when
  it has been idle for a while. Needs a cloud API token, an image with Docker, and the setup command run at boot.
