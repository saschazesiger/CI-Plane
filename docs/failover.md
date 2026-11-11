# 🛫 Failover to GitHub

This page covers the failover to GitHub-hosted runners: when it starts a runner on GitHub, how to set it up, what it
costs and how it switches itself off.

When none of your workers has had room for a job for a while, CI-Plane can start the job's runner on a
**GitHub-hosted machine**. The workflows of your repositories stay as they are: the job keeps its labels
(`ci-plane`, a size), and GitHub gives it to the runner CI-Plane started, like to any runner with those labels.
The failover is off until you switch it on, and you can switch it off at any time, for example when the minutes of
your GitHub plan are used up.

## 🔁 How it works

```mermaid
sequenceDiagram
  participant G as GitHub
  participant M as CI-Plane
  participant R as Relay workflow (GitHub-hosted)
  M->>M: the job waited 3 minutes, no worker has room
  M->>G: register a just-in-time runner (as always)
  M->>G: start the relay workflow in the relay repository (runner name)
  G->>R: run it on ubuntu-latest
  R->>M: POST /webhook/relay with the run's OIDC token
  M->>R: the runner's configuration, once
  R->>G: the runner connects and takes the job
  G->>M: workflow_job in_progress, completed
  R-->>G: the runner exits, the run ends
  M->>G: remove the registration; stop the run if it still runs
```

1. **When.** A job goes to GitHub only if no worker could take it, it has waited at least *Waiting time*
   (3 minutes by default), its size is not larger than *Largest size*, and fewer than *At most* runners are on GitHub
   already. Your own workers always come first, and the limits of parallel jobs per repository and account apply
   as usual. A job that waits for that tells you so in its reason.
2. **Start.** CI-Plane registers the runner like any other, stores its configuration encrypted, and starts the relay
   workflow in your **relay repository**, a private repository of yours. The run's title is the runner's name.
3. **Collect.** The run asks GitHub for an OIDC token and shows it to CI-Plane at `https://<your address>/webhook/relay`.
   CI-Plane checks the token's signature and that it comes from the relay workflow on the default branch of the relay
   repository, started by CI-Plane's GitHub App; it asks GitHub which run it is and hands that run, and only that
   run, the configuration of its runner. The configuration never goes to GitHub as an input, so it does not show in
   the run.
4. **Run.** The run downloads the latest runner (checked against GitHub's published digest) and starts it with the
   machine's usual environment, without the variables and tokens of the relay workflow. GitHub gives the job to it.
5. **End.** The runner exits after its job and the run ends. A runner that gets no job within 20 minutes stops by
   itself, so it does not use minutes while CI-Plane cannot remove it. CI-Plane watches the runs of the relay workflow like the
   containers of a worker: a run that ended is a runner that ended. Registration and run are removed as for any
   other runner.

In the interface, such jobs run on the worker **GitHub-hosted**, and their timeline says that they were sent there.

## 🧰 Setup

1. **Create a private repository** in the account whose minutes the runners should use, for example
   `ci-plane-relay`. It holds nothing but the workflow. It must be private: its runs show the names of your runners.
2. **Install the GitHub App** of that account on it (**Repositories**, *Choose repositories on GitHub*). The app
   needs *Actions: write*, which apps created by CI-Plane have; an app from an older version may only have *read*
   ([GitHub](github.md#permissions)).
3. **Add the relay workflow** as `.github/workflows/ci-plane-relay.yml` on the default branch. The interface shows it
   under **Settings → Failover to GitHub** with a copy button; the same file is
   [`internal/github/relay-workflow.yml`](../internal/github/relay-workflow.yml).
4. Under **Settings → Failover to GitHub**, choose the repository, switch the failover on, save, and choose
   **Check**. It says what is missing, if anything.

The workflow needs CI-Plane's public address, which the [Cloudflare tunnel](cloudflare.md) provides. Requests to
`/webhook` and below pass Cloudflare Access without a login, so nothing has to change there.

## ⚙️ Settings

| Setting | Default | Range | Meaning |
|---|---|---|---|
| Failover to GitHub | off | | Whether jobs may go to GitHub-hosted runners at all. |
| Relay repository | | a private repository CI-Plane sees | Where the relay workflow runs. Its owner pays the minutes. |
| Waiting time | 3 minutes | 0 minutes to 24 hours | How long a job waits for room on your workers before it goes to GitHub. |
| At most | 5 runners | 1 to 100 | Runners on GitHub at the same time. Your GitHub plan has its own limit of parallel jobs. |
| Largest size | `size-m` | one of the sizes | Larger jobs always wait for a worker. |

## 💸 What it costs

Each runner on GitHub is a run of the relay workflow on `ubuntu-latest`, billed to the owner of the relay
repository like any other run, from the moment the machine starts until the runner exits after its job: about a
minute more than the job itself. Nothing is used while your workers have room.

A standard machine for a private repository has fewer CPUs and less memory than the larger sizes promise (at the time
of writing 2 CPUs and 7 GB). *Largest size* keeps larger jobs away from it.

## 🛑 When it switches itself off

When GitHub does not run the relay workflow, every further try fails the same way. So after as many failed starts
in a row as *A worker pauses after* (3 by default), the failover switches itself off. The settings show when and
why, and the event appears on the overview. The usual causes:

- The minutes or the spending limit of the account are used up.
- The workflow is missing, disabled or changed, or the repository was renamed.
- GitHub cannot reach CI-Plane's address, so runs cannot collect their runner.

The jobs keep waiting for your workers meanwhile; nothing is lost. Fix the cause and switch the failover on again.
A runner that comes online resets the count.

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
| Someone else shows CI-Plane a token | Only tokens GitHub signed for the relay workflow on the default branch of the relay repository, started by the GitHub App, are accepted, and each configuration goes to one run only. |
| The relay repository is changed while runners run through it | Refused: switch the failover off and wait until they are done. |

## 🔒 Security

- The relay repository must be **private**; CI-Plane refuses a public one.
- The relay workflow gets only `id-token: write`. Its token proves which run it is; CI-Plane accepts it only for the
  relay workflow on the default branch of the relay repository (by its id, not only its name), started by its GitHub
  App, and hands each configuration to one run only.
- The configuration reaches the runner through its environment, not its command line.
- The job on the GitHub-hosted machine runs in the machine's usual environment, without the relay workflow's
  variables. It runs as the same user as the relay workflow, as on any GitHub-hosted machine; the workflow holds
  nothing worth taking once the configuration is collected.
- Jobs of public repositories may go to GitHub too, if you switched those repositories on. They run on a machine of
  GitHub's instead of yours, which is no worse.
