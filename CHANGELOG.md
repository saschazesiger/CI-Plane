# 📝 Changelog

All notable changes to CI-Plane. Versions follow [Semantic Versioning](https://semver.org/).

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
