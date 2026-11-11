# 🏊 Pools: runners of other providers

This page covers pools: what they are and when to use one, the providers, how a runner starts on a pool, the setup,
tiers, the budget, the pause after failures, what it costs and what can go wrong.

A **pool** is a source of runners that CI-Plane does not run itself: machines of GitHub, of Blacksmith, or of any
other provider whose machines run GitHub Actions jobs by a `runs-on` label. CI-Plane starts a runner there through a
small workflow in a private repository of yours, the **relay repository**. The job's workflow stays as it is: the job
keeps its labels (`ci-plane`, maybe `large`), and GitHub gives it to the runner CI-Plane started, like to any runner
with those labels.

To the scheduler a pool is one more worker with a tier. Pools are added on the **Workers** page, next to the
workers. Use one to:

- **take the overflow** when your own workers are full, so jobs do not wait for long;
- **use up free minutes first**, for example the minutes included in your GitHub plan, before your own workers;
- run jobs while you have **no worker at all**, or while all of them are being worked on.

## 🧩 Providers

| Provider | Machine for standard jobs | Machine for large jobs | To know |
|---|---|---|---|
| **GitHub-hosted runners** | `ubuntu-latest` | none by default: enter the label of a [larger runner](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) of your plan, if you have one | Uses the Actions minutes of the relay repository's owner. |
| **Blacksmith** | `blacksmith-4vcpu-ubuntu-2404` | `blacksmith-8vcpu-ubuntu-2404` | Organisations only: [Blacksmith's GitHub App](https://docs.blacksmith.sh/blacksmith-runners/overview) must be installed on the organisation of the relay repository. Blacksmith bills its own minutes. |
| **Another provider** | the label the provider gives you | the label the provider gives you, or none | Any provider whose machines run GitHub Actions jobs by a `runs-on` label, set up for the relay repository. See [Future work](future.md#-other-providers-of-github-actions-runners) for providers that should work but are untested. |

The provider is only the preset a pool starts from: all pools work the same way, and differ only in the labels of
their machines. The machine must have Docker, `curl` and `jq`, as GitHub-hosted Ubuntu machines and Blacksmith's do.

## 🔁 How a runner starts on a pool

```mermaid
sequenceDiagram
  participant G as GitHub
  participant M as CI-Plane
  participant R as Relay workflow (relay repository, machine of the pool)
  M->>M: the pool has room, its tier comes first
  M->>G: register a just-in-time runner (as always)
  M->>G: start ci-plane-relay.yml in the relay repository (runner name, machine)
  G->>R: run it on the pool's machine
  R->>M: POST /webhook/relay with the run's OIDC token
  M->>R: the runner's configuration and the start script
  R->>R: start the job's Docker daemon and the runner container
  R->>G: the runner connects and takes the job
  G->>M: workflow_job in_progress, completed
  R-->>G: the runner exits, the run ends
  M->>G: remove the registration; stop the run if it still runs
```

1. **Pick.** The scheduler chooses the pool by its tier ([below](#-tiers)). The job's timeline says *Pool … chosen
   (tier …, … of … runners in use); starting the runner … on a … machine through …*.
2. **Start.** CI-Plane registers the runner like any other, stores its configuration encrypted, and starts the relay
   workflow `.github/workflows/ci-plane-relay.yml` of the relay repository with the runner's name and the label of
   the machine. That file only calls the relay runner workflow of CI-Plane's own repository
   ([`.github/workflows/ci-plane-relay-runner.yml`](../.github/workflows/ci-plane-relay-runner.yml)), pinned to the
   tag `relay-v2`. The run's title is the runner's name.
3. **Collect.** The run shows CI-Plane its OIDC token at `https://<your address>/webhook/relay` and gets the runner's
   configuration and the script that starts its containers ([Security](#-security)).
4. **Run.** The script starts the same containers as on a worker ([below](#-the-same-environment-everywhere)). GitHub
   gives the job to the runner.
5. **End.** The runner exits after its job and the run ends. A runner that gets no job within 20 minutes stops by
   itself, so it does not use minutes while CI-Plane cannot remove it. CI-Plane lists the runs of the relay workflow
   like the containers of a worker: a run that ended is a runner that ended. Registration and run are removed as for
   any other runner.

In the interface, such jobs run on the pool as their worker.

## 🧰 Set up a pool

1. **Create a private repository** for the relay, for example `acme/ci-plane-relay`. Its owner pays the minutes.
   It must be private: its runs show the names of your runners. For Blacksmith it must belong to an organisation.
2. **Install CI-Plane's GitHub App on it** (**Repositories → Choose repositories on GitHub**). The app needs
   *Actions: Read and write*, which apps created by CI-Plane have; an app of an early version may only have *read*
   ([GitHub](github.md#permissions)).
3. **Add a pool** on the **Workers** page: choose the provider, the relay repository and the [fields](#-fields).
4. **Add the workflow**: **Add the workflow on GitHub** opens GitHub's editor with
   `.github/workflows/ci-plane-relay.yml` filled in; commit it to the default branch. The file is
   [`internal/github/relay-workflow.yml`](../internal/github/relay-workflow.yml).
5. **Check** says *Ready*, or what is still missing: the tunnel, the app's permission, the workflow, or a disabled
   workflow.

The workflow needs CI-Plane's public address, which the [Cloudflare tunnel](cloudflare.md) provides; while the tunnel
is down, no pool takes jobs. Requests to `/webhook` and below pass Cloudflare Access without a login, so nothing has
to change there.

One pool serves jobs of all your accounts and repositories; only the relay repository has to be in an account
CI-Plane's app is installed on. Runners are registered where the job is, as always: on its organisation, or on its
repository for a personal account.

## 🪜 Tiers

A pool has a tier from 1 to 9, like a worker ([Workers](workers.md#-tiers)). The lowest tier with room wins.
Inside a tier, your own workers go first, because their capacity is there anyway; the pools of a tier are tried in
their order on the page. So a pool in tier 1 is used before the workers in tier 2, and a pool in tier 9 only when no
worker has room.

A pool has room when it is switched on, the tunnel is connected, it has a machine for the job's size, fewer runners
than *Runners at the same time* are on it, its budget is not used up, it is not [pausing](#-when-a-pool-fails), and
the job has waited as long as *Use* asks.

**Overflow.** Your workers in tiers 1 and 2; GitHub-hosted runners in tier 9, used only for jobs that have waited
3 minutes. A short burst waits for your workers; a long queue spills over.

| Pool | Tier | Use | Runners at the same time | Budget |
|---|---|---|---|---|
| GitHub | 9 | for jobs that have waited 3 minutes | 5 | 0 (no limit) |

**Free minutes first.** Your plan includes 2,000 minutes a month. A GitHub pool in tier 1, used at once, with a
budget of 2,000 minutes, takes jobs before any worker until the month's minutes are counted as used; then the
workers take over until the first day of the next month.

| Pool | Tier | Use | Runners at the same time | Budget |
|---|---|---|---|---|
| GitHub | 1 | at once | 5 | 2,000 minutes |

A job whose last start failed on a pool tries anything else first, as on a worker.

## 📝 Fields

| Field | Default | Range | Meaning |
|---|---|---|---|
| Name | the provider's | up to 40 characters | Unique among pools and workers. |
| Provider | GitHub-hosted runners | GitHub-hosted runners, Blacksmith, another provider | Fills in the machines. |
| Repository | | a private repository CI-Plane sees | The relay repository with `.github/workflows/ci-plane-relay.yml`. Its owner pays the minutes. |
| Tier | 9 | 1 to 9 | 1 is used first; workers of the same tier go first. |
| Use | for jobs that have waited 3 minutes | at once, or 0 minutes to 24 hours | Only jobs that have waited this long for room go to the pool. |
| Runners at the same time | 5 | 1 to 100 | Your plan or provider may have its own limit of parallel jobs. |
| Machine for standard jobs | see [Providers](#-providers) | a `runs-on` label | |
| Machine for large jobs | see [Providers](#-providers) | a `runs-on` label, or empty | Empty: large jobs do not go to this pool. |
| Budget | 0 (no limit) | 0 to 10,000,000 minutes a month | See [below](#-budget). |
| On | on | | Off: the pool takes no new jobs; its runners finish. |

A pool with runners on it cannot be removed: switch it off, wait until they are done, then remove it.

## 🧮 Budget

The budget is the runner time a pool may use per calendar month, in UTC. CI-Plane counts it itself: from the moment
a runner is online until it is gone, every started minute, per runner. A runner that never came online counts
nothing. The provider's bill may differ a little: it also covers the half minute a machine needs to start the runner.

When the budget is used up, the pool takes no new jobs until the next month or until you raise the budget; runners
already on it finish. The event *… has used its … minutes of this month* appears on the overview. The pool shows the
minutes used this month, running runners included.

## ⏸️ When a pool fails

A pool that fails pauses and comes back by itself. A failed start counts against the pool when its workflow did not
run, or its runner did not come online in time. After each failed start in a row, the pool pauses longer:

| Failed starts in a row | 1 | 2 | 3 | 4 | 5 | 6 | 7 and more |
|---|---|---|---|---|---|---|---|
| Pause | 1 minute | 5 minutes | 15 minutes | 1 hour | 3 hours | 6 hours | 12 hours |

Then it is tried again. Meanwhile its jobs go to the other workers and pools, or wait; nothing is lost. Most failures
are a hiccup of the provider that is over within minutes, so the first pauses are short. A pool that is broken for
hours (workflow removed, minutes used up) costs two failed tries a day at most, and still notices the fix by itself.

- A runner that comes online on the pool ends the pause and resets the count.
- After a pause one runner tries the pool; the other jobs go elsewhere until it is online, so they do not fail with it.
- A job whose start failed on a pool, for whatever reason, takes a worker that has room before it tries that pool again.
- **Try again now**, or any change to the pool, ends the pause at once.
- Failures that say nothing about the pool do not count: GitHub's rate limit, a network error, an outage of GitHub,
  a tunnel that is down. Runners that were already starting when the pool paused count as the same failure.

The pool shows why it pauses and until when, and a waiting job's reason says so: *… pauses until 14:05 UTC after
2 failed starts in a row*. The usual causes:

- The workflow is missing, disabled, or not on the default branch.
- The GitHub App may not start workflows (*Actions: read* only).
- The minutes or the spending limit of the account are used up, or the provider has no machine with that label.
- GitHub cannot reach CI-Plane's address, so runs cannot collect their runner.

## 🧱 The same environment everywhere

On a pool's machine, the relay workflow starts the same two containers as on a worker, with the same start script:
the job's own Docker daemon (`docker:dind`) and the runner image from the settings
([How it works](how-it-works.md#-on-the-worker)). A job finds the same tools, the same paths and its own Docker
wherever it runs. Left out there is what only makes sense on a server that is shared and kept:

| | On a worker | On a pool's machine |
|---|---|---|
| Registry mirror | yes | no: Docker Hub is used directly |
| Memory limit of the size | yes | no: the machine is the job's alone |
| CPU priority | the worker's | no |
| Images | pulled in advance | pulled for each runner, about 15 to 25 seconds |

The size decides which machine a job gets: *Machine for standard jobs* or *Machine for large jobs*. Its CPUs and
memory in the settings do not apply; the machine has what the provider gives it. A private runner image that needs a
login cannot be pulled there.

## 💸 What it costs

Each runner is a run of the relay workflow, billed to the relay repository's owner by the provider, from the moment
the machine starts until the runner exits after its job: about a minute more than the job, plus the pull of the
images. The relay repository is private, so GitHub bills the minutes even for jobs of public repositories. Nothing is
used while the pool takes no jobs. Larger runners and other providers cost more per minute; their price lists say how
much.

A standard GitHub-hosted machine of a private repository has fewer CPUs than the default standard size (4 CPUs).

## 🧷 What can go wrong

| | What CI-Plane does |
|---|---|
| The runner is not online within ten minutes (no machine free, parallel job limit) | The runner is given up, the job goes back to the queue, and the pool pauses ([above](#-when-a-pool-fails)). |
| The run ends before its runner took the job | Like a runner that exits on a worker: the job goes back to the queue with growing waits. |
| The run is cancelled or the machine dies while the job runs | Like a lost worker: once GitHub fails the job, CI-Plane has GitHub run it again ([Reliability](reliability.md#-a-job-whose-worker-is-lost)). |
| The job runs into the six hours a run of the relay workflow may take | CI-Plane ends the runner ten minutes earlier, as a job that ran too long. It is not run again. *A job may run at most* applies as well, if it is shorter. |
| The job is taken by another runner meanwhile | The runner on the pool is not needed: its registration is removed and its run is stopped. |
| CI-Plane restarts while runs start | The configurations waiting to be collected are stored encrypted, so the runs still get them. |
| CI-Plane is down while runners wait on a pool | Each stops by itself after 20 minutes without a job. A job that is running finishes. |
| Someone starts the relay workflow by hand, or re-runs a run | The run gets nothing: only runs the GitHub App started may collect a runner, and only once. |
| Someone changes `ci-plane-relay.yml` | Its runs get nothing unless they still call the relay runner workflow at `relay-v2`, which they cannot change. A token made for another address, to be passed on to CI-Plane, is refused. |

## 🔒 Security

- **Who collects a runner.** The run shows an OIDC token of GitHub Actions. CI-Plane checks its signature against
  GitHub's published keys, the issuer and expiry, and that:
  - its audience is CI-Plane's own address, so a token made for anywhere else is no good here, and this one is no
    good anywhere else;
  - it comes from the relay repository, matched by its id, not only its name;
  - the workflow is `ci-plane-relay.yml` on the default branch, so a pull request cannot change what runs;
  - the run was started by CI-Plane's GitHub App (`workflow_dispatch`);
  - the job is CI-Plane's relay runner workflow at the tag `relay-v2` (`job_workflow_ref`), so nobody with access to
    the relay repository can change the steps that run the runner;
  - the run's title names a runner that waits for this repository, and the run is not older than it;
  - the job runs on the machine the runner was started for, by its `runs-on` label, and for a pool of GitHub-hosted
    runners on a machine of GitHub's own. The machine is an input of the run, so a changed calling file could name
    another one; such a run gets nothing.
- **One run, one attempt.** Each configuration goes to one run only; a re-run gets nothing.
- **What the run gets**: the runner's configuration and the start script, both from CI-Plane. The configuration never
  goes to GitHub as an input, so it does not show in the run; the start script reads it from its input, not its
  command line.
- **What the job sees.** The script and the containers run without the variables and tokens of the relay workflow,
  which has only `id-token: write`. The job runs in the runner container, as on a worker.
- The relay repository is private, because its runs show the names of your runners. They never show a configuration.
