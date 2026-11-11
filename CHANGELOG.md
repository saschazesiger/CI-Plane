# 📝 Changelog

All notable changes to CI-Plane. Versions follow [Semantic Versioning](https://semver.org/).

## Unreleased

- **Jobs are placed by the measured CPU load** of the workers instead of by reserved CPUs. A worker that is busy,
  with jobs or with anything else that runs on it, gets no new jobs; inside a tier the least busy worker wins.
- **No CPU limits.** The CPUs of a size are now what must be free on a worker for a job to start. A running job may
  use every CPU nothing else wants. Memory is reserved and limited as before.
- **CPU priority per worker** (*normal*, *low*, *background*), so that servers which do other work can be workers:
  in the background, jobs only get CPU time nothing else wants.
- **Interface on Z-Dash 3** (formerly Dashboard-Style 2.2), vendored in `web/vendor/z-dash/`. Tones and sizes are
  option classes now (`ds-tone-*`, `ds-sm`), the page loads the minified build, and the binary embeds only the
  files the page loads. The nightly update workflow is now *Update Z-Dash* and runs the project check.
- New setting *A new runner holds its CPUs for* (120 seconds): over how long a runner whose job just began lets go
  of the CPUs of its size, until only its real load counts.
- **A job whose worker is lost runs again on another worker.** When GitHub fails a job because its worker went
  offline or its runner was killed, CI-Plane has GitHub re-run that job, up to twice. New apps ask for *Actions:
  write* for this; existing apps need that permission changed once on GitHub.
- **Public repositories are off by default**, and a repository that becomes public is switched off.
- More self-healing: a runner whose containers came up just before a restart of CI-Plane is kept instead of
  started again; runners that were starting on a worker that goes offline move after 30 seconds without counting
  against it; a runner that exits without a job backs off; no runners are started for an account while GitHub
  refuses them; jobs of an uninstalled app wait and expire instead of being retried for ever; every open job is
  asked about in turn, however many there are; registrations are deleted even while a worker is unreachable.
- The janitor no longer removes an image that was on a server before CI-Plane pulled the same tag.
- Fewer GitHub API requests: the list of runners is asked for with ETags.
- Existing databases are upgraded when CI-Plane starts. Existing workers keep the priority *normal*.

## 0.1.0

First release.

- Ephemeral, just-in-time GitHub Actions runners on your own Linux servers, one per job, each with its own Docker
  daemon, removed with everything they created.
- Scheduling by size labels (`size-s` to `size-xl`, editable), tiers and the largest free share of CPU and memory;
  limits of parallel jobs per repository and account.
- Durable by design: every step is stored before it runs, a check against GitHub every minute, redelivery of failed
  webhooks, recovery from restarts, unreachable and unhealthy workers, and orphaned runners.
- Workers over SSH with a one-line setup command; a registry mirror for Docker Hub and a janitor per worker.
- One private GitHub App per account or organisation, created from the interface with GitHub's manifest flow.
- Public access only through a Cloudflare Tunnel with Cloudflare Access as the login, set up from the interface.
- Web interface on Dashboard-Style with a five-step setup assistant, live updates, job timelines, light and dark.
- Demo mode on simulated GitHub, Cloudflare and workers.

The flows against GitHub and Cloudflare are tested against simulated APIs; a complete end-to-end run against real
accounts is still to be confirmed.
