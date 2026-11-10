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
| 💥 The manager crashes or restarts | State is in SQLite. Running jobs continue on the workers. Half-done starts and cleanups are finished. Sessions survive, so nobody is signed out. |
| 🚫 A runner cannot be started on a worker | Leftovers are removed, the job goes back to the queue and tries another worker first. Waits grow from 2 seconds to 5 minutes, and it keeps trying for as long as GitHub shows the job as queued. |
| 🤒 A worker fails three starts in a row | It is marked *unhealthy* and gets no jobs. A test container is tried every 30 seconds; when it runs, the worker is back. A job that starts on it also resets the count. |
| 🔌 A worker is unreachable | Noticed within 15 seconds, when its live values stop. It gets no new jobs; other workers take over. Runners that were still starting there fail and their jobs move. Jobs running on it are left alone: they may well finish. CI-Plane reconnects with waits up to 30 seconds and cleans up when the worker returns. |
| 🕳️ A runner starts but never connects to GitHub | After two minutes CI-Plane asks GitHub. If the runner is in fact running a job, it stays. Otherwise it is removed and the job is tried again. If GitHub cannot be asked, CI-Plane waits up to five times as long before it gives up, without counting it against the worker. |
| 🪑 A runner is not needed (job cancelled, taken by another runner) | The next fitting job uses it, or it is removed after a minute. Before removal CI-Plane deregisters it on GitHub; if GitHub answers that it just took a job, it stays. |
| 🧷 A registration cannot be deleted on GitHub (app uninstalled, outage) | After a few tries the runner is removed from the worker anyway, so it does not hold capacity. The sweep below deletes the registration later. |
| 🧟 A job hangs | After six hours of running, the runner is removed (the limit of GitHub-hosted runners; adjustable). |
| 💽 The disk fills up | Under 15 GB free, the worker is *disk-full* and gets no jobs until space is back. The janitor runs an extra pass every five minutes meanwhile. |
| 👻 A runner is registered on GitHub but no runner belongs to it | Every five minutes, idle registrations named with this installation's prefix that no runner belongs to are deleted. |
| 📦 Containers exist that no runner belongs to | Containers with this installation's prefix that the database does not know are removed. |
| 🚇 `cloudflared` exits | It is restarted with waits from 1 second to 1 minute. Every ten minutes CI-Plane checks from outside that the address still asks for a login and `/webhook` answers. The overview shows a problem as an alert. |
| 🧱 GitHub's API fails or limits requests | Calls are retried with growing waits and respect the rate limit. A failed registration is not counted against the worker. |

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
- removes older versions of these images that CI-Plane pulled itself, unless something else uses or tags them
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
