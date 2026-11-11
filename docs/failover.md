# 🛫 Failover to GitHub

This page covers the failover to GitHub-hosted runners: when it starts a runner on GitHub, how to switch it on for a
repository, what it costs and how it switches itself off.

When none of your workers has had room for a job for a while, CI-Plane can start the job's runner on a
**GitHub-hosted machine**, through a small workflow in the job's own repository. The job's workflow stays as it is:
the job keeps its labels (`ci-plane`, a size), and GitHub gives it to the runner CI-Plane started, like to any runner
with those labels. The failover is off until you switch it on for a repository, and you can switch it off for one
repository or for all of them at once, for example when the minutes of your GitHub plan are used up.

## 🔁 How it works

```mermaid
sequenceDiagram
  participant G as GitHub
  participant M as CI-Plane
  participant R as Relay workflow (same repository, GitHub-hosted)
  M->>M: the job waited 3 minutes, no worker has room
  M->>G: register a just-in-time runner (as always)
  M->>G: start ci-plane-relay.yml in the job's repository (runner name)
  G->>R: run it on ubuntu-latest
  R->>M: POST /webhook/relay with the run's OIDC token
  M->>R: the runner's configuration
  R->>G: the runner connects and takes the job
  G->>M: workflow_job in_progress, completed
  R-->>G: the runner exits, the run ends
  M->>G: remove the registration; stop the run if it still runs
```

1. **When.** A job goes to GitHub only if its repository has the failover switched on, no worker could take it, it
   has waited at least *Waiting time* (3 minutes by default), its size is not larger than *Largest size*, and fewer
   than *At most* runners are on GitHub already. Your own workers always come first, and the limits of parallel jobs
   per repository and account apply as usual. A job that waits for that tells you so in its reason.
2. **Start.** CI-Plane registers the runner like any other, stores its configuration encrypted, and starts the
   relay workflow `.github/workflows/ci-plane-relay.yml` in the job's repository. That file only calls the relay
   runner workflow of CI-Plane's own repository
   ([`.github/workflows/ci-plane-relay-runner.yml`](../.github/workflows/ci-plane-relay-runner.yml)), pinned to the tag
   `relay-v1`. The run's title is the runner's name, so the run shows next to the job in the repository's *Actions* tab.
3. **Collect.** The run asks GitHub for an OIDC token and shows it to CI-Plane at `https://<your address>/webhook/relay`.
   CI-Plane checks the token's signature; that it was made for CI-Plane's own address; that it comes from the relay
   workflow on the default branch of the repository the runner is for, started by CI-Plane's GitHub App; and that
   the job is the relay runner workflow at `relay-v1`. It asks GitHub which run it is and hands that run, and only
   that run, the configuration of its runner. The configuration never goes to GitHub as an input, so it
   does not show in the run.
4. **Run.** The run downloads the latest runner (checked against GitHub's published digest) and starts it with the
   machine's usual environment, without the variables and tokens of the relay workflow. GitHub gives the job to it.
5. **End.** The runner exits after its job and the run ends. A runner that gets no job within 20 minutes stops by
   itself, so it does not use minutes while CI-Plane cannot remove it. CI-Plane watches the runs of the relay
   workflow like the containers of a worker: a run that ended is a runner that ended. Registration and run are
   removed as for any other runner.

In the interface, such jobs run on the worker **GitHub-hosted**, and their timeline says that they were sent there.

## 🧰 Switch it on for a repository

1. On **Repositories**, switch on **Failover to GitHub** for the repository. CI-Plane checks at once what is missing.
2. **Add the relay workflow** to the repository as `.github/workflows/ci-plane-relay.yml` on the default branch.
   **Add the workflow on GitHub** opens GitHub's editor with the file filled in; commit it. The same file is shown
   under **Settings → Failover to GitHub** and is
   [`internal/github/relay-workflow.yml`](../internal/github/relay-workflow.yml).
3. **Check** again: it says *Ready*, or what is still missing.

The GitHub App needs *Actions: write*, which apps created by CI-Plane have; an app from an older version may only
have *read*, and **Check** says so with a link to the page where you change it ([GitHub](github.md#permissions)).
The workflow needs CI-Plane's public address, which the [Cloudflare tunnel](cloudflare.md) provides. Requests to
`/webhook` and below pass Cloudflare Access without a login, so nothing has to change there.

On an organisation, runners are registered on the organisation, so GitHub may give a runner that was started for one
repository to a waiting job of another repository of the same organisation with the same labels. Both use the same
organisation's minutes, and the runner runs CI-Plane's unchanged relay runner workflow either way. On a personal
account, runners belong to one repository.

## ⚙️ Settings

Per repository, on **Repositories**: **Failover to GitHub**, on or off.

For all repositories, under **Settings → Failover to GitHub**:

| Setting | Default | Range | Meaning |
|---|---|---|---|
| Failover to GitHub | off | | Whether jobs may go to GitHub-hosted runners at all, for the repositories that have it on. Switch it off when your minutes are used up. |
| Waiting time | 3 minutes | 0 minutes to 24 hours | How long a job waits for room on your workers before it goes to GitHub. |
| At most | 5 runners | 1 to 100 | Runners on GitHub at the same time, all repositories together. Your GitHub plan has its own limit of parallel jobs. |
| Largest size | `size-m` | one of the sizes | Larger jobs always wait for a worker. |

## 💸 What it costs

Each runner on GitHub is a run of the relay workflow on `ubuntu-latest` in the job's repository, billed to its owner
like any other run, from the moment the machine starts until the runner exits after its job: about a minute more
than the job itself. Nothing is used while your workers have room. Runs in public repositories are free on GitHub.

A standard machine has fewer CPUs and less memory than the larger sizes promise (at the time of writing 2 CPUs and
7 GB in private repositories, 4 CPUs and 16 GB in public ones). *Largest size* keeps larger jobs away from it.

## 🛑 When it switches itself off

When GitHub does not run the relay workflow of a repository, every further try fails the same way. So after as many
failed starts in a row as *A worker pauses after* (3 by default), the failover of that repository switches itself
off. **Repositories** shows when and why, and the event appears on the overview. The usual causes:

- The workflow is missing, disabled, or not on the default branch.
- The GitHub App may not start workflows (*Actions: read* only).
- The minutes or the spending limit of the account are used up.
- GitHub cannot reach CI-Plane's address, so runs cannot collect their runner.

The jobs keep waiting for your workers meanwhile; nothing is lost. Fix the cause and switch the failover of the
repository on again. A runner that comes online resets the count. Starts that fail because of GitHub's rate limit or
an outage do not count.

## 🧷 What can go wrong

| | What CI-Plane does |
|---|---|
| The run does not start within ten minutes (GitHub busy, parallel job limit) | The runner is given up, the job goes back to the queue and counts as a failed start. |
| The run ends before its runner took the job | Like a runner that exits on a worker: the job goes back to the queue with growing waits. |
| The run is cancelled or the machine dies while the job runs | Like a lost worker: once GitHub fails the job, CI-Plane has GitHub run it again ([Reliability](reliability.md#-a-job-whose-worker-is-lost)). |
| The job is taken by another runner meanwhile | The runner on GitHub is not needed: its registration is removed and its run is stopped. |
| CI-Plane restarts while runs start | The configurations waiting to be collected are stored encrypted, so the runs still get them. |
| CI-Plane is down while runners wait on GitHub | Each stops by itself after 20 minutes without a job. A job that is running finishes. |
| Someone starts the relay workflow by hand | The run gets nothing: only runs the GitHub App started may collect a runner. |
| Someone changes `ci-plane-relay.yml` in a repository | Its runs get nothing unless they still call the relay runner workflow at `relay-v1`, which they cannot change. A token made for another address, to be passed on to CI-Plane, is refused. |
| Someone else shows CI-Plane a token | Only tokens GitHub signed for CI-Plane's address, from the relay runner workflow called by the relay workflow on the default branch of the runner's repository and started by the GitHub App, are accepted, and each configuration goes to one run only. |

## 🔒 Security

- The relay workflow gets only `id-token: write`. Its token proves which run it is; CI-Plane accepts it only for the
  relay workflow on the default branch of the repository the runner was started for (by its id, not only its name),
  started by its GitHub App, and hands each configuration to one run, one attempt, only.
- **Nobody with access to a repository can change what runs the runner.** The steps live in the relay runner workflow
  of CI-Plane's repository, pinned to a tag, and the token says which workflow file the job came from
  (`job_workflow_ref`): a changed copy is refused. Its audience is CI-Plane's address, so a changed calling file that
  sends the token elsewhere gets a token CI-Plane does not take. This matters on an organisation, where a runner may
  take a job of another repository.
- A pull request cannot change what runs either: CI-Plane starts the workflow on the default branch, and a token of a
  run on another branch is refused.
- The configuration reaches the runner through its environment, not its command line.
- The job on the GitHub-hosted machine runs in the machine's usual environment, without the relay workflow's
  variables. It runs as the same user as the relay workflow, as on any GitHub-hosted machine; the workflow holds
  nothing worth taking once the configuration is collected.
- In a public repository, the runs of the relay workflow and their logs are public like any other run. They show the
  runner's name, never its configuration.
