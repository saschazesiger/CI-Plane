# 🩺 Troubleshooting

This page lists symptoms with their cause and fix, using the texts CI-Plane shows. Look first at the **Overview**
(alerts name the problem and the next step), the job's timeline under **Jobs**, the worker's recent events, and the
log: `docker logs ci-plane`.

## 🌐 Interface and login

| Symptom | Cause | Fix |
|---|---|---|
| *CI-Plane does not know the name "…". Open it by its IP address, or add the name to the environment variable CI_PLANE_HOSTS.* | You opened the local address by a public-looking name; the local listener refuses those against DNS rebinding. | Use the IP address, or a `.lan`/`.local`/`.internal` name, or start CI-Plane with `-e CI_PLANE_HOSTS=that.name.example`. |
| The page asks to choose a password you never set, or someone else set it | The first visitor of the local address sets the password. | Restart with `-e CI_PLANE_ADMIN_PASSWORD=<new password>`, sign in, change nothing else, then restart without the variable. Check who can reach port 8080. |
| Forgot the password | | Same as above: `CI_PLANE_ADMIN_PASSWORD` sets a new one at start and signs everybody out. |
| *Too many wrong passwords. Wait … and try again.* | Five wrong attempts from your address; the wait doubles from 30 seconds to 15 minutes. | Wait. A restart also clears the count. |
| *This request was refused: it came from another website.* | The request's origin is not the host you opened. | Open CI-Plane by one address and do not embed it in other pages. Behind a reverse proxy, pass the original `Host`. |
| *CI-Plane does not answer* (banner) | The container stopped or restarts. | `docker ps`, `docker logs ci-plane`. The page reconnects by itself. |
| Container exits: *CI_PLANE_SECRET_KEY must be 32 bytes in base64* | The variable is set but malformed. | Use the exact value of `secret.key`, or `openssl rand -base64 32` for a new installation. |
| *secret: cannot decrypt (was the secret key changed?)* | The secrets were encrypted with another key (a changed `CI_PLANE_SECRET_KEY`, or a lost `secret.key`). | Put the original key back. Without it, remove and re-add the GitHub accounts, the tunnel and the workers. |
| *listen on :8080 (CI_PLANE_LISTEN): address already in use* | Another program uses the port. | Publish another host port (`-p 8081:8080`) or set `CI_PLANE_LISTEN`. |

## ☁️ Cloudflare

| Symptom | Cause | Fix |
|---|---|---|
| *Cloudflare does not accept this API token …* | A truncated token, the Global API Key, or a token without *Zone · Zone · Read*. | Create the token again with the button on the page and paste all of it. |
| *the token may not use any domain …* | No domain was chosen under *Zone Resources*. | Recreate the token with your domain or *All zones*. |
| The check names a missing permission, for example *Account > Cloudflare Tunnel > Edit* | The prefilled form dropped it. | Edit the token on Cloudflare, add the permission, check again. |
| *Cloudflare Zero Trust is not enabled on this Cloudflare account yet …* | Zero Trust was never set up. | Open <https://one.dash.cloudflare.com/>, pick the account, choose a team name and the Free plan, then **Set up the tunnel** again. |
| *the DNS record … already exists … and was not made by CI-Plane* | The subdomain is in use. | Choose another subdomain, or delete that record under DNS. |
| *Cloudflare Access already has an application … that CI-Plane did not create* | An Access application covers the same address. | Delete it under *Zero Trust → Access → Applications*, or choose another subdomain. |
| *a tunnel named ci-plane-… exists in Cloudflare but is managed by a configuration file* | A tunnel of that name was created by hand. | Delete it under *Zero Trust → Networks → Tunnels*. |
| *cloudflared did not connect to Cloudflare within 1m0s … port 7844 (UDP and TCP)* | Outgoing traffic to Cloudflare's edge is blocked. | Allow outgoing UDP and TCP 7844 from the CI-Plane machine. |
| *https://…/ cannot be reached from here … The DNS record may not be visible yet* | New DNS needs a moment, or the machine cannot resolve or reach its own public address. | Wait a minute and repair. If it stays, check the record and the machine's DNS. |
| *… answered 530 … Cloudflare cannot find a running connector for the tunnel* | `cloudflared` is not connected, or the record points at another tunnel. | **Settings → Cloudflare tunnel → Repair**. |
| *… redirects to "…" instead of the Cloudflare Access login* | A redirect or page rule of the domain is in front. | Exclude the subdomain from that rule. |
| *…/webhook asks for a login, so GitHub could not deliver events* | The Bypass application for `/webhook` is missing. | Repair. |
| Alert *The tunnel to Cloudflare is down* | `cloudflared` exited or lost its connection; it is restarted by itself. | If it stays, repair. Jobs are still found once a minute meanwhile. |
| You cannot sign in from outside | Your address is not in the list, or the one-time code went to spam. | Add it under **Settings → Cloudflare tunnel → Who may sign in from outside**. |
| *Forbidden: sign in through Cloudflare Access with an allowed e-mail address.* | You signed in at Cloudflare with an address that is not on the list (any more). | Same as above, then reload. |

## 🐙 GitHub

| Symptom | Cause | Fix |
|---|---|---|
| *GitHub can only send webhooks to an https address; set up the Cloudflare tunnel first* | The app is created before the tunnel. | Do step 2 first. |
| *GitHub no longer accepts this code …* / *the app creation took longer than an hour and expired* | The manifest flow was left open too long or finished twice. | Start **Add repository or organisation** again; delete a half-created app on GitHub if one exists. |
| Alert *The GitHub App of … is not installed* | Created, but not installed. | **Install on GitHub** and choose repositories. |
| *the app … is suspended on GitHub* | The installation was suspended. | Unsuspend it in the account's or organisation's *Settings → GitHub Apps*. |
| *a webhook with a wrong signature arrived …* | The app's webhook secret was changed on GitHub. | Remove the account in CI-Plane and add it again. |
| A repository is missing on **Repositories** | The app is not installed on it. | **Choose repositories on GitHub**, then **Read again from GitHub**. |
| Jobs never show up in CI-Plane | `runs-on` lacks `ci-plane`, the repository is not in the installation, or webhooks fail. | Check `runs-on`; check the repository list; under the app's *Advanced* settings on GitHub, look at recent deliveries. Missed jobs are found within a minute anyway while GitHub can be asked. |
| Jobs of a **public** repository of an organisation stay queued while runners start and are removed again | Organisation runners join the **Default** runner group, which by default does not serve public repositories. | Allow public repositories for the Default group in the organisation's *Settings → Actions → Runner groups*, after reading [Security](security.md#-trust-model). |
| Job shows *runs on …, a runner CI-Plane does not manage* | Another self-hosted runner with matching labels took it. | Expected; the runner CI-Plane started for it is used by the next job or removed. |

## 🧱 Workers

| Symptom | Cause | Fix |
|---|---|---|
| *The server refused the key. Paste the setup command on the server as root, then try again.* | The setup command has not run (completely), or the key was removed. | Run the setup command as root and connect again. |
| *… did not answer within 10 seconds. Check the address, the port and any firewall …* | Wrong address or port, a firewall, or the server is off. | Check from the CI-Plane machine: `nc -vz <host> 22`. |
| *… refused the connection. Check the port and that the SSH server is running.* | Nothing listens on that port. | Start `sshd`, or use the right port. |
| *The name "…" could not be resolved.* | DNS inside the container does not know the name. | Use the IP address, or a name the container can resolve. |
| *The server at … presented a different host key …* | The server was reinstalled, or someone intercepts the connection. | If you reinstalled it: remove the worker and add it again. Otherwise investigate. |
| *This server is aarch64; CI-Plane runs runners on x86_64 (amd64) servers only.* | arm64 is not supported. | Use an x86_64 server. |
| *Docker is not installed* / *Docker is not running on the worker …* | | Run the setup command, or `systemctl enable --now docker` as root. |
| *permission denied on the Docker socket …* | `ci-plane` is not in the group `docker`. | Run the setup command again. |
| *Pulling the runner image … failed* | No internet on the worker, a wrong image name, or a private registry without login. | Fix the image under **Settings**, or `sudo -u ci-plane docker login <registry>` on the worker. Then **Try again**. |
| Worker *unreachable*: *The worker sent no live values for 15 seconds; reconnecting* | Network trouble, or the server is overloaded or off. | CI-Plane reconnects by itself. Jobs go elsewhere meanwhile. |
| Worker *unhealthy*: *3 runners in a row failed to start …* | Look at the worker's recent events for the cause (image pull, Docker, disk). | Fix the cause; the worker comes back by itself after a test container runs. |
| Worker *disk-full*: *… GB of disk free, … GB are needed* | Docker's disk is nearly full. | **Clean up**, `docker image prune` for images that are not CI-Plane's, or lower *Least free disk*. |
| *The Docker daemon of the runner did not start* | The worker's kernel or Docker refuses privileged containers or the nested daemon (rootless Docker, some LXC containers). | Use a VM or bare metal with a normal Docker Engine. |

## 🏊 Pools

**Check** on a pool lists what is missing. When a pool pauses, it shows why ([Pools](pools.md#-when-a-pool-fails)).

| Symptom | Cause | Fix |
|---|---|---|
| *The relay workflow is not in …* or *… is not on the branch … of …* | The workflow was never added, was removed, or is on another branch. | **Add the workflow on GitHub** on the pool, and commit it to the default branch. |
| *The GitHub App of … may not start workflows* | The app has *Actions: read* only (apps of early versions). | Give it *Actions: Read and write* at the link shown and accept the new permission on its installation ([GitHub](github.md#permissions)). |
| *The relay workflow in … is disabled* | GitHub disabled it, or someone did, under *Actions*. | Enable it under *Actions* in the relay repository. |
| *The Cloudflare tunnel is not set up or not connected* | Runs on a pool reach CI-Plane through the tunnel. | Check the tunnel under **Settings** ([Cloudflare](cloudflare.md)). |
| *This repository is public* | A pool's runs show the names of your runners. | Use a private relay repository. |
| *the runner did not connect to GitHub within 600 seconds* | The provider had no machine free, the minutes or the spending limit are used up, or the machine's label is wrong. | Open the run in the relay repository's *Actions* tab: its log says why. Check the label against the provider's list. |
| *its run of the relay workflow failed or was cancelled* | The run ended with an error, for example a runner image that could not be pulled. | The run's log on GitHub says why. A pool cannot pull an image that needs a login. |

## ⏳ Jobs

The reason a job waits is shown in the job list and its timeline.

| Reason | Fix |
|---|---|
| *No worker has been added yet* | Add a worker. |
| *No worker is available: all are switched off, draining or offline* | Switch one on, stop draining, or bring one back. |
| *No worker is large enough for large (8 free CPUs, 16 GB)* | Lower the values of the size under **Settings**, add a larger worker (a worker offers its CPUs and memory minus 10 % and 1 GB), or add a [pool](pools.md) with a machine for large jobs. |
| *No worker has 4 free CPUs and 8 GB right now; the job starts when one does* | Normal under load: the workers are busy, with jobs or with other work, or their memory is reserved. The side sheet of a worker shows what takes its CPUs. Add workers, or use smaller sizes. |
| *Waiting: GitHub does not register runners for … right now (…)* | GitHub refused the last runner; the text in brackets says why (suspended app, outage, rate limit). CI-Plane tries again by itself, at the latest after five minutes. |
| *Waiting: the GitHub App of … is not installed on the account any more* | Install the app again from the **Repositories** page. |
| *Ignored: the repository is public and switched off* | Public repositories take jobs only after you switch them on under **Repositories**. Re-run the job afterwards. |
| *GitHub does not run the job again yet: the GitHub App may not re-run jobs* | Give the app *Actions: Read and write*, see [GitHub](github.md#-the-github-app). CI-Plane keeps asking for six hours. |
| *Could not give the runners the CPU priority … on this worker* | The worker's CPU priority needs systemd and the right to start privileged containers. Check `systemctl --version` and `docker info` on the server, or set the worker's CPU priority to *normal*. |
| *Waiting: … is limited to N parallel jobs* | Raise the limit on **Repositories** (0 means none). |
| *Waiting to try again after a failed start* | The timeline shows the failed attempt and its cause; it is retried with growing waits. |
| *The size … no longer exists in the settings* | The job was queued under a size of an earlier version that is gone. Re-run the job. |
| *…; … pauses until … after … failed starts in a row* | A pool failed to start runners and pauses; the pool on the **Pools** page says why. Fix the cause, then **Try again now** ([Pools](pools.md#-when-a-pool-fails)). |
| *…; … has used its … minutes of this month* | The pool's budget is used up. Raise it, or wait for the next month ([Pools](pools.md#-budget)). |
| *…; it goes to … once it has waited …* | The pool takes only jobs that have waited that long; the job starts there by itself, or earlier on a worker. |

| Ignored with | Fix |
|---|---|
| *unknown label "…" in runs-on* | Use only `self-hosted`, `linux`, `x64`, `ci-plane` and one size. |
| *runs-on names two sizes: … and …* | Keep one. |
| *the repository is switched off* / *the account … is switched off* | Switch it on, then re-run the job. |

| Timeline says | Meaning |
|---|---|
| *Attempt N failed: the runner did not connect to GitHub within 120 seconds* | The runner started but never came online: often the worker cannot reach GitHub, or the runner image is outdated. |
| *Cleanup is delayed (worker): … It is retried until it succeeds* | The worker cannot be reached; the cleanup finishes when it is back. |
| *GitHub gave its runner to another job; …* | Normal: GitHub pairs jobs and runners freely ([How it works](how-it-works.md#runners-are-not-tied-to-jobs)). |
| *Job exceeded the time limit; removing the runner* | It ran longer than *A job may run at most* (6 hours by default). |
