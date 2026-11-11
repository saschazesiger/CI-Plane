# 🔒 Security

This page covers the trust model of CI-Plane, the two listeners and the login, how secrets are stored, what
privileged containers mean for your workers, the resource limits of a job, and how to harden an installation.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## 🤝 Trust model

CI-Plane runs code from your repositories on your servers. It is built for **repositories you trust**:

- Each job gets a **privileged** Docker-in-Docker container. A job can therefore become root on the worker, read
  everything on it, and reach everything the worker can reach on the network.
- The user `ci-plane` on a worker is in the group `docker`, which is equivalent to root on that worker. Whoever
  controls CI-Plane controls its workers.
- Jobs on the same worker are separated by containers, not by virtual machines. A hostile job can see or disturb
  the others.

So:

- **Never connect public repositories that accept pull requests from forks.** A pull request from a stranger would
  run with root on your worker.
- Connect only repositories whose every writer you would give root on the workers.
- Keep workers away from data and networks that jobs must not reach. A dedicated server or VM per trust level is
  the simple answer.
- Untrusted code, multi-tenant use and GitHub's public-repository use cases are **not supported**.

## 🚪 The two listeners

| Listener | Default | Who reaches it | How you are signed in |
|---|---|---|---|
| local | `:8080` | your network (published by `docker run -p` / Compose) | admin password |
| tunnel | `127.0.0.1:8081` | `cloudflared` inside the container only | Cloudflare Access, checked by CI-Plane |

- **The first visitor of the local address sets the admin password.** There is no setup code, by design. Open the
  interface right after the first start, and do not publish port 8080 to the internet before the password is set (or
  ever). `docker run -p 8080:8080` and the shipped `docker-compose.yml` publish the port on **all** interfaces of the
  host; bind it to one address if you want less, for example `-p 192.168.1.10:8080:8080`.
- The first password can only be set on the local listener, never through the tunnel.
- The local listener answers only to IP addresses, single-label names, and names ending in `.localhost`, `.local`,
  `.lan`, `.internal`, `.home.arpa`, `.home`, `.intranet` and `.ts.net`. Other names must be listed in
  `CI_PLANE_HOSTS`. This stops DNS rebinding: a website you have open cannot point its own name at your CI-Plane and
  talk to it from your browser.
- The local listener speaks plain HTTP. The password and the session cookie cross your network unencrypted; use it on
  a network you trust, or reach CI-Plane through the tunnel.
- Through the tunnel, every request except `/webhook` needs a Cloudflare Access token. CI-Plane verifies it itself
  (RS256 signature against the team's keys, issuer, audience of the application, expiry, and an allowed e-mail),
  so a request that somehow bypassed Access is still refused with *403*. A signed-in Access user has full admin
  rights.
- `/webhook` accepts only `POST`s signed (HMAC-SHA256) with the webhook secret of the GitHub App that sent them. A
  delivery is handled once, and events about jobs older than seven days are ignored.
- `/webhook/relay`, below `/webhook` and so also without Access, hands a run of the relay workflow of a pool the
  configuration of its runner and the script that starts its containers ([Pools](pools.md#-security)). It accepts
  only an OIDC token of GitHub Actions (RS256 against GitHub's published keys, issuer, CI-Plane's own address as
  audience, expiry) from CI-Plane's relay runner workflow pinned to the tag `relay-v2`, called by the relay workflow
  on the default branch of the pool's relay repository, matched by repository id and started by the GitHub App, and
  hands each configuration to one run, one attempt, only.

## 🔑 Login and sessions

- The admin password has at least 10 characters and is stored as an Argon2id hash.
- Login attempts are counted per client address **before** the password is checked. Five attempts are free; then
  each further attempt waits 30 seconds, doubling up to 15 minutes. A success clears the count.
- Sessions last 30 days, survive restarts, and only the SHA-256 of their token is stored. The cookie is `HttpOnly`
  and `SameSite=Strict`.
- Changing the password signs out every other browser. `CI_PLANE_ADMIN_PASSWORD` sets a new password at start and
  signs out everybody; remove the variable afterwards, or it does that on every start.
- Requests that change something must carry a header only the interface sends and, if the browser names an origin,
  come from the same host. Pages are served with a strict Content Security Policy and may not be framed.

## 🔐 Secrets at rest

The GitHub Apps' private keys, webhook secrets and client secrets, the Cloudflare API token, the tunnel token, and
CI-Plane's SSH private key are encrypted with AES-256-GCM before they go into the database.

The key is `secret.key` in the data directory, created on first start (`/data/secret.key`, mode 600), or the value
of `CI_PLANE_SECRET_KEY` (32 bytes in base64, `openssl rand -base64 32`). With the key file next to the database,
the encryption protects a copy of the database, not the whole volume. To keep them apart, move the key into
`CI_PLANE_SECRET_KEY`:

```sh
docker exec ci-plane cat /data/secret.key          # this value becomes CI_PLANE_SECRET_KEY
```

Start the container with `-e CI_PLANE_SECRET_KEY=<that value>`, then delete `/data/secret.key`. The value must stay
the same forever: with another key, the stored secrets cannot be decrypted, and CI-Plane reports
*"secret: cannot decrypt (was the secret key changed?)"*.

Secrets never go into logs, events or command lines. The runner's just-in-time configuration reaches the worker on
standard input and is written into the runner container's environment file without ever appearing in a command line.

## 🧨 What privileged means

| Container | Privileged | Why |
|---|---|---|
| `…-dind` | **yes** | a Docker daemon needs it to create namespaces, cgroups and networks |
| `…-runner` | no | but it has the inner daemon's socket, so it can start privileged containers there |
| `ci-plane-mirror` | no | the registry mirror |

A privileged container has all capabilities and the host's devices. Code that controls it can load kernel modules,
mount the host's disks and leave the container. That is why the trust model above is not optional.

## 📏 Resource limits

**Memory** of a job's size is enforced with Docker's `--memory` on **each** of its two containers, the runner and
its Docker daemon. Steps run in one or the other (a `run:` step in the runner, a container or `docker build` in the
daemon), so real use rarely exceeds the size. The worst case is **twice the size**, when both are full at once.
CI-Plane keeps a reserve per worker (10 % and 1 GB by default) and only places a job when at least half of the
size's memory is really available at that moment. One shared limit for both containers would need root on the worker
and is on the roadmap.

**CPU** is not limited: a job may use every CPU of the worker that nothing else wants. What protects the other work
of a server is the placement (a job only starts where the CPUs of its size are idle) and the
[CPU priority](workers.md#-cpu-priority) of the worker. The priority guards against load, not against an attack: a job runs
privileged and can change anything on the worker, its priority included.

With a priority other than *normal*, CI-Plane starts one more kind of privileged container on the worker: for about
a second, sharing the host's process namespace, to run `systemctl set-property --runtime ciplane.slice CPUWeight=…`
on the server. It runs a fixed command with no input from a job, and only when the priority is not set yet. It needs
no right the SSH user does not already have through Docker.

Disk is not limited per job. A worker under the free-disk threshold takes no jobs until space is back.

## 🛡️ Hardening

- Run CI-Plane on a machine only admins can reach, and bind port 8080 to the interface you use.
- Prefer an organisation over a personal account: the app then needs no *Administration* permission on repositories.
- Switch off repositories you do not need, and remove the app from repositories on GitHub that should never use it.
- Keep `CI_PLANE_SECRET_KEY` outside the data volume and its backups.
- Use dedicated workers. Do not run other services on them that jobs must not reach.
- Keep Docker on the workers and the CI-Plane image up to date.
- Compare the SSH host key when you add a worker; CI-Plane pins it and refuses the server if it changes.
- Keep the list of Cloudflare Access e-mails short, and remove people when they leave.

## 🧾 What CI-Plane holds

| Where | What |
|---|---|
| CI-Plane container | runs as the unprivileged user `ciplane` (uid 10001), needs no Docker socket |
| `/data` | the SQLite database (jobs, events, settings, encrypted secrets) and `secret.key` |
| each worker | the user `ci-plane` with CI-Plane's public key (option `restrict`: no forwarding, no terminal) |
| GitHub | one private app per account; runners named `ci-plane-*` |
| Cloudflare | the tunnel, a DNS record, two Access applications and their policies |
