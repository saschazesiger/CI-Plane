# 🛟 Reliability

This page lists what goes wrong in practice and what CI-Plane does about each case, then what the janitor cleans.

CI-Plane assumes that everything fails sometimes: webhooks get lost, servers disappear, the manager restarts in the
middle of a step. None of that should need you.

## 🧱 The principle

- **Stored before done.** Each step (register a runner, start it, remove it) is written to the database as an
  intent first. After a crash the next pass finds the intent and continues.
- **Repeatable.** Starting a runner first removes leftovers of the same name. Removing something that is gone
  succeeds. Receiving the same webhook twice changes nothing.
- **Compared, not assumed.** Webhooks are the fast path. Independently, CI-Plane compares its state with GitHub
  every minute and with each worker every few seconds.

## 📋 What happens when

| Failure | What CI-Plane does |
|---|---|
| 📭 A webhook is lost, or the manager was down | Once a minute it lists the waiting jobs of active repositories and asks GitHub about open jobs it has not heard of for a while. Every five minutes it asks GitHub to redeliver failed webhook deliveries; after a start it looks back 24 hours. |
| 🔁 A webhook arrives twice or out of order | Nothing: the job id is the key, and a finished job never comes back. |
| 💥 The manager crashes or restarts | State is in SQLite. Running jobs continue on the workers. Half-done starts and cleanups are finished. A runner whose containers came up just before the restart is kept as it is, not started again. Sessions survive, so nobody is signed out. |
| 🚫 A runner cannot be started on a worker | Leftovers are removed, the job goes back to the queue and tries another worker first. Waits grow from 2 seconds to 5 minutes, and it keeps trying for as long as GitHub shows the job as queued. |
| 🤒 A worker fails three starts in a row | It is marked *unhealthy* and gets no jobs. A test container is tried every 30 seconds; when it runs, the worker is back. A job that starts on it also resets the count. |
| 🔌 A worker is unreachable | Noticed within 15 seconds, when its live values stop. It gets no new jobs; other workers take over. Runners that were still starting there are given up after 30 seconds and their jobs move, without counting against the worker; GitHub is asked first, and a runner that has taken a job meanwhile stays. Their registrations on GitHub are deleted at once; the containers are removed when the worker returns. Jobs running on it are left alone: the worker may still reach GitHub and finish them. CI-Plane reconnects with waits up to 30 seconds. |
| ⚰️ A worker is lost while a job runs on it (power, network, reboot) | See [below](#-a-job-whose-worker-is-lost): once GitHub gives the job up, CI-Plane has GitHub run it again, and the new attempt starts on another worker. |
| 🚪 A runner connects and exits without taking a job | Its job goes back to the queue with growing waits, as after a failed start, and tries another worker first. A crash counts against the worker; a clean exit does not. |
| 🕳️ A runner starts but never connects to GitHub | After two minutes CI-Plane asks GitHub. If the runner is in fact running a job, it stays. Otherwise it is removed and the job is tried again. If GitHub cannot be asked, CI-Plane waits up to five times as long before it gives up, without counting it against the worker. |
| 🪑 A runner is not needed (job cancelled, taken by another runner) | The next fitting job uses it, or it is removed after a minute. Before removal CI-Plane deregisters it on GitHub; if GitHub answers that it just took a job, it stays. |
| 🧷 A registration cannot be deleted on GitHub (app uninstalled, outage) | After a few tries the runner is removed from the worker anyway, so it does not hold capacity. The sweep below deletes the registration later. |
| 🙅 GitHub registers no runners for an account (app suspended, outage, rate limit) | After the first refusal no further runner is started for that account until a wait is over (2 seconds to 5 minutes, growing). Its jobs wait with the reason GitHub gave and start by themselves when GitHub answers again. |
| 🧩 The app was uninstalled while jobs were open | No runner is tried for them; they wait with *"the GitHub App of … is not installed on the account any more"* and start when it is installed again. A job GitHub cannot be asked about for an hour is closed if it has waited more than 25 hours (GitHub gives up waiting jobs after 24) or if its runner is gone. |
| 🧟 A job hangs | After six hours of running, the runner is removed (the limit of GitHub-hosted runners; adjustable). |
| 💽 The disk fills up | Under 15 GB free, the worker is *disk-full* and gets no jobs until space is back. The janitor runs an extra pass every five minutes meanwhile. |
| 👻 A runner is registered on GitHub but no runner belongs to it | Every five minutes, idle registrations named with this installation's prefix that no runner belongs to are deleted. |
| 📦 Containers exist that no runner belongs to | Containers with this installation's prefix that the database does not know are removed. |
| 🚇 `cloudflared` exits | It is restarted with waits from 1 second to 1 minute. Every ten minutes CI-Plane checks from outside that the address still asks for a login and `/webhook` answers. The overview shows a problem as an alert. |
| 🛫 The failover to GitHub fails (minutes used up, workflow missing) | A failed start on GitHub puts the job back in the queue like any other. After as many failed starts in a row as *A worker pauses after*, the failover of that repository switches itself off and says why; its jobs wait for the workers. See [Failover to GitHub](failover.md#-when-it-switches-itself-off). |
| 🧱 GitHub's API fails or limits requests | Calls are retried with growing waits and respect the rate limit. A failed registration is not counted against the worker. Lists that are read often (runners, waiting jobs) are asked for with ETags, so an unchanged answer does not use up the limit. At most 30 open jobs are asked about per minute, in turn. |

### ⚰️ A job whose worker is lost

A job that dies with its worker did not fail by itself, so it should not count as failed. CI-Plane cannot move a
running job, and it cannot end one early either: only GitHub decides that a runner is lost, some minutes after it
last heard of it. So this is what happens:

1. The worker stops answering, or the containers of the runner are gone (a reboot). CI-Plane notes it and waits: a
   worker that CI-Plane cannot reach may still reach GitHub and finish its job.
2. GitHub gives the runner up and reports the job as **failed**.
3. CI-Plane decides whether the job was lost or failed by itself, because a job that fails by itself is never run
   again:
   - the runner had crashed or vanished while the job ran (seen on a worker that answers): **lost**;
   - the worker has been unreachable and stays away for five more minutes: **lost**;
   - the worker comes back earlier: the exit code of the runner tells. A runner that ended normally reported the
     result itself, so the job **failed by itself**; anything else is **lost**. The containers are kept until then.
4. For a lost job CI-Plane asks GitHub to **run that job again**. GitHub refuses while other jobs of the same
   workflow run are still going on; CI-Plane keeps asking, for up to six hours. Asking twice never starts two
   attempts.
5. The new attempt arrives as a new job and is placed like any other, on a worker that is there. The timeline of the
   old job says what happened.

On GitHub the workflow run shows a second attempt; the first, failed one stays in its history. A run is attempted at
most three times this way. If several jobs of one run are lost together, GitHub takes them one after another, each
as an attempt of its own.

Re-running needs the permission *Actions: Read and write*. Apps created before this feature only have *Read*; see
[GitHub](github.md#-the-github-app) for the one-time change. Without it the job stays failed and its timeline says
what to do.

Two installations of CI-Plane can share a worker or a GitHub organisation: each only cleans up names with its own
prefix (`ci-plane-<installation>-…`). The flip side: if you lose the database and start a new installation, the old
one's leftovers are not cleaned up by the new one. Run the remove command on the worker
([Workers](workers.md#-remove-a-worker)) and delete old `ci-plane-*` runners under the repository's or organisation's
*Settings → Actions → Runners* on GitHub.

With more than 30 repositories in one account, only repositories that had a job in the last 48 hours are polled for
waiting jobs, to stay inside GitHub's rate limit. Their webhooks still arrive as usual.

## 🧹 The janitor

Every ten minutes per worker, and every five minutes while the disk is low, the janitor:

- pulls the runner, Docker-in-Docker and mirror images again once a day (GitHub refuses runners that are too old)
- removes older versions of these images that CI-Plane pulled itself, unless something else uses or tags them. An
  image that was already on the server before CI-Plane first pulled that tag is not CI-Plane's and stays
- removes the runner tool volumes of runner images that are no longer current
- empties the registry mirror when it grows past its cap (20 GB by default)
- makes sure the mirror runs

It never runs `docker system prune` and never touches containers, images or volumes that are not CI-Plane's. The
same pass runs when you choose **Clean up** on a worker.

## 🔬 How this is tested

The engine runs against a simulator that plays GitHub and the workers in memory and can fail on demand. The tests
cover the rows of the table above, restarts in the middle of a start and of a cleanup, and a run of 60 jobs with
injected failures. Every test ends with the same assertion: no job is stuck, no runner is left, no container and no
registration remain.

```sh
go test -race ./internal/engine/
```
