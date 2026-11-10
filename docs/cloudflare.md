# ☁️ Cloudflare

This page covers the Cloudflare API token and its permissions, what CI-Plane creates in your account, who can sign
in, how to change that, repair and removal, and what is reachable from the internet.

GitHub has to reach CI-Plane to deliver jobs, and you may want to open the interface from anywhere. CI-Plane does both
through a **Cloudflare Tunnel**: `cloudflared`, bundled in the image, opens an outgoing connection to Cloudflare, so
no port on your network is opened. **Cloudflare Access** is the login for everybody who comes through the tunnel.
There is no other way in from the internet.

## 📋 What you need

- A Cloudflare account with a domain whose DNS is on Cloudflare.
- Cloudflare Zero Trust enabled on that account. The free plan is enough. If it is not enabled yet, CI-Plane says so:
  open <https://one.dash.cloudflare.com/>, pick the account, choose a team name and the Free plan (no payment details
  are needed), then run the setup again.
- Outgoing connections from the CI-Plane machine to Cloudflare on port 7844 (UDP and TCP) for the tunnel, and to
  `api.cloudflare.com` on 443.

## 🔑 The API token

**Create the token on Cloudflare** opens Cloudflare's *Create API token* page with the permissions filled in. Pick
your account and the domain (or *All zones*) under the resources, then create the token and paste it into CI-Plane.

| Scope | Permission | Level | Used for |
|---|---|---|---|
| Account | Cloudflare Tunnel | Edit | create the tunnel, set its routing, get its connector token |
| Account | Access: Apps and Policies | Edit | the two Access applications and their policies |
| Account | Access: Organizations, Identity Providers, and Groups | Edit | find the team domain, add the One-time PIN login |
| Zone | DNS | Edit | the DNS record of the address |
| Zone | Zone | Read | list the domains |

Cloudflare drops unknown entries of the prefilled form silently; if one is missing on the form, add it by hand.
**Check token** tests each permission and names the one that is missing. Use an API token, not the Global API Key.

The token is stored encrypted ([Security](security.md#-secrets-at-rest)). CI-Plane needs it again only to change the
e-mail addresses, to repair and to remove. You may delete the token on Cloudflare after the setup, but then these three
need a new one.

## 🏗️ What is created

For the address `ci.example.com`:

| Object | Name | Details |
|---|---|---|
| Tunnel | `ci-plane-ci.example.com` | managed remotely (no config file); routes `ci.example.com` to CI-Plane's tunnel listener, everything else answers 404 |
| DNS record | `ci.example.com` | proxied CNAME to `<tunnel id>.cfargotunnel.com`, with the comment *Managed by CI-Plane (Cloudflare Tunnel)* |
| Access application | `CI-Plane ci.example.com` | the whole address, policy *allowed e-mails*, sessions of 24 hours, shown in the App Launcher |
| Access application | `CI-Plane ci.example.com webhook` | `ci.example.com/webhook`, policy *webhook for everyone* (Bypass) |
| Access policies | `CI-Plane ci.example.com: allowed e-mails`, `…: webhook for everyone` | reusable policies of the account |
| Login method | One-time PIN | added once if the account has none: Cloudflare mails a code to the address |

Then CI-Plane starts `cloudflared`, waits until it is connected, and checks from outside, without credentials, that
`https://ci.example.com/` redirects to the Cloudflare Access login and that `/webhook` reaches CI-Plane. It repeats
that check every ten minutes; a problem shows up on the overview and in **Settings → Cloudflare tunnel**.

CI-Plane refuses to take over what it did not create: a DNS record of the same name, or an Access application on the
same address, stops the setup with a message. Choose another subdomain or delete the object first.

## 🙋 Who can sign in

Only the e-mail addresses you entered. Cloudflare Access asks for the address, mails a one-time code, and lets the
person in for 24 hours. CI-Plane checks Cloudflare's signed token on every request itself (signature, audience,
allowed address), so a request that bypassed Access would still be refused. Whoever gets in has the same rights as
the admin password on the local address.

**Change the addresses** under **Settings → Cloudflare tunnel → Who may sign in from outside**, one per line, then
**Save addresses**. The policy on Cloudflare is updated at once.

## 🌍 What is reachable from the internet

| Path | From the internet |
|---|---|
| `https://<address>/webhook` | open to everybody (Bypass), but only `POST`s signed with your GitHub App's webhook secret are accepted; `GET` answers a short text for the check |
| `https://<address>/` and everything else | only after the Cloudflare Access login, for the listed addresses |
| port 8080 (the local listener) | not through the tunnel at all; it is only on your network |
| the workers | never; CI-Plane reaches them over SSH from the inside |

## 🔧 Repair

If the check from outside fails, or something was changed by hand on Cloudflare, choose
**Settings → Cloudflare tunnel → Repair: run the setup again**. Leave the token field empty to reuse the stored token,
or paste a new one. The setup finds what exists, recreates what is missing and corrects what differs. You can also
change the subdomain this way: the old DNS record is deleted, and the webhook address of every GitHub App is updated.

## 🗑️ Remove

**Settings → Cloudflare tunnel → Remove the tunnel …** stops `cloudflared` and deletes, in this order, the two Access
applications, the two policies, the DNS record and the tunnel. What is already gone is skipped. If a deletion fails,
the rest stays recorded, and **Remove** can be pressed again. The One-time PIN login method stays in your account.

Without the tunnel, GitHub cannot deliver jobs (the check every minute still finds them, but slower and only while
GitHub can be asked), and the interface is reachable on your network only.
