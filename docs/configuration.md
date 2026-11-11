# 🔧 Configuration

This page lists every environment variable and every setting with its default and meaning, then how to back up,
restore and update CI-Plane.

## 🌱 Environment variables

Read once at start. Set them with `docker run -e NAME=value` or under `environment:` in Compose.

| Variable | Default | Meaning |
|---|---|---|
| `CI_PLANE_DATA` | `/data` | Directory of the database (`ci-plane.db`) and of `secret.key`. |
| `CI_PLANE_LISTEN` | `:8080` | Address of the local listener (interface, API, `/healthz`). |
| `CI_PLANE_TUNNEL_LISTEN` | `127.0.0.1:8081` | Address `cloudflared` sends requests to. If you change it, run the Cloudflare setup again so the tunnel routes there. |
| `CI_PLANE_HOSTS` | empty | Extra host names the local listener answers to, comma-separated, for example `ci-box.example.com`. IP addresses, single-label names and names ending in `.localhost`, `.local`, `.lan`, `.internal`, `.home.arpa`, `.home`, `.intranet`, `.ts.net` always work. |
| `CI_PLANE_ADMIN_PASSWORD` | empty | If set, becomes the admin password at every start and signs everybody out. For a forgotten password: set it, restart, sign in, then remove it. At least 10 characters. |
| `CI_PLANE_SECRET_KEY` | empty | The key that encrypts secrets, 32 bytes in base64. Without it, `secret.key` in the data directory is used (and created on first start). See [Security](security.md#-secrets-at-rest). |
| `CI_PLANE_CLOUDFLARED` | `cloudflared` | Path of the `cloudflared` program. The image ships it; only needed when running the binary outside the image. |
| `CI_PLANE_DEMO` | off | `1`: demo mode on simulated GitHub, Cloudflare and workers; nothing real is touched, there is no login and no tunnel listener. |
| `CI_PLANE_DEMO_FRESH` | off | `1`: the demo starts empty, as on a first run, with the login on (implies `CI_PLANE_DEMO`). |
| `CI_PLANE_DEMO_SEED` | `1` | Seed of the demo; the same seed gives the same accounts, workers, history and rhythm. |
| `CI_PLANE_DEMO_SPEED` | `1` | How fast the demo runs, from `0.1` to `100`. |
| `CI_PLANE_DEMO_FREEZE` | off | `1`: the demo stops moving after about ten seconds, for screenshots. |

Switches accept `1`, `true`, `yes` or `on`.

## ⚙️ Settings

Under **Settings** in the interface. Changes wait in a bar at the bottom until you save; they apply from the next
job on.

**Sizes**

| Setting | Default | Meaning |
|---|---|---|
| Sizes | `size-s` 2 CPUs / 4 GB, `size-m` 4 / 8, `size-l` 8 / 16, `size-xl` 16 / 32 | What a job with that label needs: CPUs that must be free on a worker for it to start (not a limit), and memory that is reserved for it and is the limit of each of its containers. 1 to 12 sizes; 0.5 to 256 CPUs, 0.5 to 1024 GB. |
| Default | `size-m` | The size of a job that names none. |

**Runner**

| Setting | Default | Meaning |
|---|---|---|
| Runner image | `ghcr.io/actions/actions-runner:latest` | The image of the runner container; your own must be built on it ([GitHub](github.md#-your-own-runner-image)). |
| Docker image (advanced) | `docker:dind` | The Docker daemon each job gets for itself. |
| Registry mirror image (advanced) | `registry:2` | The pull-through cache for Docker Hub on every worker. |
| Label of CI-Plane (advanced) | `ci-plane` | The label in `runs-on` that sends a job to CI-Plane. Change it only together with your workflows. |

**Capacity and disk**

| Setting | Default | Range | Meaning |
|---|---|---|---|
| Kept for the system | 10 % | 0 to 50 % | Share of every worker's CPUs and memory that is never counted as free for a job. |
| A new runner holds its CPUs for | 120 seconds | 0 to 3600 s | After its job began. A runner that has just started causes no load yet, so the free CPUs of its size stay taken until its job begins and are then let go evenly over this time; afterwards only its real load counts. Raise it if jobs take long to reach their full load. |
| Memory kept on top | 1 GB | 0 to 64 GB | Memory kept for the system in addition. |
| Least free disk | 15 GB | 1 to 10 000 GB | Below this, a worker is *disk-full* and takes no jobs. |
| Registry mirror at most | 20 GB | 1 to 10 000 GB | When the mirror is larger, the janitor empties it. |

**Timeouts and limits**

| Setting | Default | Range | Meaning |
|---|---|---|---|
| A runner must connect within | 120 seconds | 30 to 1800 s | Otherwise CI-Plane asks GitHub, then removes it and the job gets a new one, if possible on another worker. |
| An idle runner is removed after | 10 minutes | 1 minute to 24 hours | Counted from the moment the runner came online without getting a job. |
| A runner without a job is kept for | 60 seconds | 10 to 3600 s | A runner whose job was cancelled or taken by another runner waits this long for a job of the same size. |
| A job may run at most | 6 hours | 10 minutes to 120 hours | Then its runner is removed. |
| A waiting job is not overtaken after | 5 minutes | 0 minutes to 24 hours | Until then, smaller jobs may start before a large one that does not fit yet. |
| A worker pauses after | 3 failed starts | 1 to 20 | In a row; then it is *unhealthy* and tested every 30 seconds. |
| Keep finished jobs and events for | 30 days | 1 to 365 days | Older history is deleted. |

**Failover to GitHub** ([Failover to GitHub](failover.md))

| Setting | Default | Range | Meaning |
|---|---|---|---|
| Failover to GitHub | off | | Jobs that found no room may go to GitHub-hosted runners. It switches itself off after as many failed starts in a row as *A worker pauses after*. |
| Relay repository | | a private repository CI-Plane sees | Runs the relay workflow; its owner pays the minutes. |
| Waiting time | 3 minutes | 0 minutes to 24 hours | How long a job waits for room on your workers first. |
| At most | 5 runners | 1 to 100 | Runners on GitHub at the same time. |
| Largest size | `size-m` | one of the sizes | Larger jobs always wait for a worker. |

**Elsewhere**

- **Cloudflare tunnel**: status, the e-mail addresses that may sign in, repair and removal ([Cloudflare](cloudflare.md)).
- **Password**: change the admin password; other browsers are signed out.
- **Workers** page: tier, on/off, draining and the [CPU priority](workers.md#-cpu-priority) of each worker.
- **Repositories** page: on/off and parallel jobs per repository and per account ([GitHub](github.md#-limits-per-repository-and-account)).
- **Workers** page: tiers, on/off, drain ([Workers](workers.md)).

## 💾 Backup and restore

Everything lives in `/data`: `ci-plane.db` (with its `-wal` and `-shm` files) and `secret.key`. Stop the container
for a consistent copy; running jobs carry on on the workers meanwhile.

```sh
docker stop ci-plane
docker run --rm -v ci-plane:/data -v "$PWD":/backup alpine tar czf /backup/ci-plane-backup.tgz -C /data .
docker start ci-plane
```

The backup contains the secret key unless you use `CI_PLANE_SECRET_KEY`; then keep that value with the backup, or the
secrets in it cannot be read. Treat the backup like a password: it opens your GitHub Apps and your workers.

To restore into a new volume:

```sh
docker volume create ci-plane
docker run --rm -v ci-plane:/data -v "$PWD":/backup alpine \
  sh -c 'tar xzf /backup/ci-plane-backup.tgz -C /data && chown -R 10001 /data'
```

Then start CI-Plane as usual. Run only one installation with the same data at a time: two would manage the same
runners. If you bind-mount a directory instead of a volume, it must be writable by uid 10001.

## ⬆️ Updating

Images are tagged `latest` (always the latest `main`; `edge` is the same image), and `X.Y.Z` and `X.Y` for a
release. Data and sessions survive an update, and jobs that run meanwhile finish on their workers.

```sh
docker pull ghcr.io/saschazesiger/ci-plane:latest
docker rm -f ci-plane
docker run -d --name ci-plane --restart unless-stopped \
  -p 8080:8080 -v ci-plane:/data ghcr.io/saschazesiger/ci-plane:latest
```

With Compose: `docker compose pull && docker compose up -d`. Read the [changelog](../CHANGELOG.md) first. To stay on
a version, use its tag instead of `latest`.

The container reports its health at `http://127.0.0.1:8080/healthz` (the image's `HEALTHCHECK` uses it).
