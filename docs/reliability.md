# 🛟 Reliability

CI-Plane assumes that everything fails sometimes: webhooks get lost, servers disappear, the manager restarts in the
middle of a step. None of that should need you.

## The principle

- **Stored before done.** Each step (register a runner, start it, remove it) is written to the database as an
  intent first. After a crash the next pass finds the intent and continues.
- **Repeatable.** Starting a runner first removes leftovers of the same name. Removing something that is gone
  succeeds. Receiving the same webhook twice changes nothing.
- **Compared, not assumed.** Webhooks are the fast path. Independently, CI-Plane compares its state with GitHub
  every minute and with each worker every few seconds.

## What happens when

| Failure | What CI-Plane does |
|---|---|
| 📭 A webhook is lost, or the manager was down | Once a minute it lists waiting jobs of active repositories and checks open jobs. It also asks GitHub to redeliver failed deliveries. |
| 🔁 A webhook arrives twice or out of order | Nothing: the job id is the key, and a finished job never comes back. |
| 💥 The manager crashes or restarts | State is in SQLite. Running jobs continue on the workers. Half-done starts and cleanups are finished. |
| 🚫 A runner cannot be started on a worker | Leftovers are removed, the job goes back to the queue and prefers another worker. Waits grow from 2 seconds to 5 minutes, and it keeps trying for as long as GitHub shows the job as queued. |
| 🤒 A worker fails three starts in a row | It is marked *unhealthy* and gets no jobs. A test container is tried every 30 seconds; when it runs, the worker is back. |
| 🔌 A worker is unreachable | It gets no new jobs at once; other workers take over. Jobs running on it are left alone: they may well finish. Its leftovers are removed when it returns. |
| 🕳️ A runner starts but never connects to GitHub | After two minutes it is removed and the job is tried again. |
| 🪑 A runner is not needed (job cancelled) | The next fitting job uses it, or it is removed after a minute. Before removal CI-Plane deregisters it on GitHub; if GitHub answers that it just took a job, it stays. |
| 🧟 A job hangs | After six hours the runner is removed (the limit of GitHub-hosted runners; adjustable). |
| 💽 The disk fills up | Under 15 GB free, the worker gets no jobs until space is back. |
| 👻 A runner is registered on GitHub but does not exist | Registrations named `ci-plane-*` that no runner belongs to are deleted. |
| 📦 Containers exist that no runner belongs to | Containers named `ci-plane-*` that the database does not know are removed. |
| 🚇 `cloudflared` exits | It is restarted. The interface shows the state of the tunnel. |
| 🧱 GitHub's API fails or limits requests | Calls are retried with growing waits; a failed start is not counted against the worker. |

## 🧹 The janitor

Every ten minutes, per worker:

- refreshes the runner image once a day (GitHub rejects outdated runners)
- removes older versions of CI-Plane's images
- empties the registry mirror when it grows past its cap (20 GB by default)
- makes sure the mirror is running

It never runs `docker system prune` and never touches containers, images or volumes that are not CI-Plane's.

## 🔬 How this is tested

The engine runs against a simulator that plays GitHub and the workers in memory and can fail on demand. The tests
cover each row of the table above, restarts in the middle of a start and of a cleanup, and a run of 60 jobs with
injected failures. Every test ends with the same assertion: no job is stuck, no runner is left, no container and no
registration remain.

```sh
go test -race ./internal/engine/
```
