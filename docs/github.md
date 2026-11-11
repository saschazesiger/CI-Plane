# 🐙 GitHub

This page covers the GitHub App CI-Plane creates and its permissions, labels and sizes, how the runner differs from
`ubuntu-latest`, how to use your own runner image, and the limits per repository.

## 🧩 The GitHub App

CI-Plane talks to GitHub through a **private GitHub App** that it creates for you with GitHub's manifest flow
(**Repositories → Add repository or organisation**, or step 3 of the setup assistant):

1. You choose your personal account or an organisation (you must be an owner).
2. GitHub shows the prepared app, named `CI-Plane <random>` or `CI-Plane <organisation> <random>`. You choose
   **Create GitHub App**. GitHub hands CI-Plane the app's private key and webhook secret, which are stored encrypted.
3. You install the app on the repositories that should use CI-Plane.

The app sends one event, `workflow_job`, to `https://<your tunnel address>/webhook`. The tunnel has to exist first,
because GitHub only sends webhooks to an https address.

### Permissions

| | Organisation | Personal account |
|---|---|---|
| Actions | **write** | **write** |
| Metadata | read | read |
| Self-hosted runners (organisation) | **write** | |
| Administration (repository) | | **write** |
| Runners are registered on | the organisation | each repository |

*Actions: write* is what lets CI-Plane have GitHub run a job again whose worker was lost
([Reliability](reliability.md#-a-job-whose-worker-is-lost)). An app that was created by an earlier version of
CI-Plane only has *read*. To change it once: open the app on GitHub (*Settings → Developer settings → GitHub Apps →
Edit*), set **Actions** to *Read and write* under *Permissions & events*, save, and accept the new permission where
GitHub asks for it (the installation's page). Everything else works without it.

On an organisation, runners are registered on the organisation and join its **Default** runner group. Personal
accounts have no organisation-level runners, so CI-Plane registers them on each repository, which GitHub only allows
with *Administration: write*. That permission is wide (it covers the settings of the repository); if you can, use an
organisation.

### Why one app per account

A private app can only be installed on the account that owns it. One public app for everybody would let strangers
install it. So each account or organisation gets its own private app: one click to create, one to install. An app
only ever serves its owner: jobs and installations of other owners are ignored, even if someone makes the app public
on GitHub.

### Choose repositories later

Repositories come and go with the installation. To add or remove some, choose **Choose repositories on GitHub** on
the **Repositories** page; CI-Plane hears about the change from GitHub and reads the list again every 30 minutes
anyway (**Read again from GitHub** does it at once).

### Remove an account

**Remove …** on the account's card makes CI-Plane forget the app and its keys; jobs of that account that were still
open are closed. GitHub has no API to delete an app, so CI-Plane then links to the app's settings page, where you
delete it under *Advanced*.

## 🏷️ Labels and sizes

A job is sent to CI-Plane with the label `ci-plane` in `runs-on`:

```yaml
runs-on: [self-hosted, ci-plane, size-l]
```

| Rule | |
|---|---|
| Needed | `ci-plane` (the *Label of CI-Plane* in the settings) |
| Allowed | `self-hosted`, `linux`, `x64`, and at most one size |
| Size | `size-s`, `size-m`, `size-l`, `size-xl` by default; without one, the default size (`size-m`) |
| Case | labels are compared without regard to case |
| Anything else | the job is *ignored* and the reason is shown under **Jobs**, for example *unknown label "gpu" in runs-on* |

Jobs without `ci-plane` are not CI-Plane's business and are not stored. Each runner registers with
`self-hosted, linux, x64, ci-plane, <size>`. GitHub gives a job to any idle runner that has all of its labels, so a job
that names no size may run on a runner of any size. Name the size to get exactly that size.

Sizes are edited under **Settings → Sizes** (up to 12; names in lowercase letters, digits and dashes). They apply
from the next job on.

## 🆚 Differences to `ubuntu-latest`

The default runner image is GitHub's official [`ghcr.io/actions/actions-runner`](https://github.com/actions/runner).
It is a small Ubuntu image with the runner, not the large image of GitHub-hosted runners.

| | GitHub-hosted `ubuntu-latest` | CI-Plane |
|---|---|---|
| Preinstalled tools | hundreds (compilers, SDKs, browsers) | very few; install them in a step or use your own image |
| `setup-*` actions (Node, Go, Python, Java …) | work | work; they download the toolchain each time |
| Docker | the host's daemon | a daemon for this job only; `docker build`, `docker compose` and service containers work |
| Container jobs and service containers | yes | yes; service ports answer on `localhost` |
| Clean machine per job | yes | yes; nothing survives the job except what you push elsewhere |
| Docker Hub pulls | GitHub's cache | through a pull-through mirror on the worker |
| CPU and memory | fixed by the runner type | memory by the size label; every CPU of the worker that is free |
| Time limit | 6 hours | 6 hours by default (*A job may run at most* in the settings) |
| Architectures, systems | Linux, Windows, macOS, arm64 | Linux on x86_64 only |

## 🧱 Your own runner image

When every job installs the same tools, build them into an image. It must be built on the official image, which
provides `/home/runner`, `run.sh` and the user `runner`:

```dockerfile
FROM ghcr.io/actions/actions-runner:latest

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends build-essential git jq unzip zip \
 && rm -rf /var/lib/apt/lists/*
USER runner
```

Build it, push it to a registry the workers can reach, and enter it under **Settings → Runner → Runner image**.

- Workers pull the image as the user `ci-plane`. For a private registry, log in once on every worker:
  `sudo -u ci-plane docker login ghcr.io`.
- The janitor pulls the image again once a day. Use a tag you move (`:latest`, `:2`), and rebuild when a new runner
  version comes out: GitHub refuses runners that are too old.
- The first job after a change pulls the new image, which makes that start slower.

## 🚦 Limits per repository and account

On the **Repositories** page:

- **On/off** per repository and per account. Jobs of a switched-off repository or account are *ignored*.
- **Public repositories are off** until you switch them on, and a repository that turns from private to public is
  switched off. Anyone can open a pull request against a public repository, and its workflows would run that
  person's code on your workers; see [Security](security.md).
- **Parallel jobs** per repository and per account (0 means no limit). Jobs over the limit wait with
  *"Waiting: acme-labs/web is limited to 2 parallel jobs"*.

## ⚠️ Known limitations

- **Public repositories in an organisation.** Organisation runners join the **Default** runner group, which by
  default does not allow public repositories. Jobs of a public repository then stay queued while runners start and
  are removed again. To allow them, enable public repositories for the Default runner group under the
  organisation's *Settings → Actions → Runner groups*, and read [Security](security.md) first: never do this for
  repositories that run pull requests from forks.
- **Approvals and environments.** A job that waits for an approval gets no runner until it is approved and queued.
- **Many repositories.** With more than 30 repositories in one account, only those with a job in the last 48 hours
  are polled for missed jobs; webhooks still work for all.
