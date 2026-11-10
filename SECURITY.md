# 🔒 Security policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x | ✅ |
| older | ❌ |

Security fixes go into the latest release. Update to it before you report.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private vulnerability reporting instead:
[Report a vulnerability](https://github.com/saschazesiger/CI-Plane/security/advisories/new) (repository →
*Security* → *Report a vulnerability*).

Include what you found, how to reproduce it, the version (shown under **Settings → About**), and what an attacker
needs to exploit it. You will get an answer as soon as possible; a fix and an advisory follow once the report is
confirmed, with credit to you if you wish.

## Scope

CI-Plane runs code from the repositories you connect in privileged containers, and access to Docker on a worker
equals root on it. That jobs of a connected repository can take over their worker is the documented trust model,
not a vulnerability; see [docs/security.md](docs/security.md). Reports about ways around the login, the Cloudflare
Access check, webhook signatures, the encryption of secrets, or about CI-Plane touching what is not its own are very
welcome.
