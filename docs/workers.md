# 🖥️ Workers

This page covers what a worker needs, what the setup command does line by line, tiers, switching off and draining,
cleaning up and removing a worker.

A worker is a Linux server with Docker that runs the jobs. CI-Plane reaches it over SSH with a key of its own and runs
plain `docker` commands there. Nothing else is installed.

## 📋 Requirements

| | |
|---|---|
| CPU | x86_64 (amd64). Other architectures are refused when you connect: *"This server is aarch64; CI-Plane runs runners on x86_64 (amd64) servers only."* |
| System | Linux. The setup command is made for Ubuntu and Debian (an opt-in test covers Ubuntu 24.04 and Debian 13); it installs Docker with `get.docker.com`, which supports the common distributions. |
| Docker | A normal (rootful) Docker Engine that can run privileged containers and set CPU and memory limits. Installed by the setup command if missing. |
| SSH | An SSH server reachable from CI-Plane: on your network, over a VPN, or on a public address. Any port. |
| Internet | To pull images: `ghcr.io/actions/actions-runner`, `docker:dind`, `registry:2`, and whatever your jobs pull. |
| Disk | The filesystem that holds Docker's data needs more than the threshold (15 GB by default) free, plus room for the jobs. |
| Root | Once, to paste the setup command. CI-Plane itself logs in as the user `ci-plane`. |

Size the machine for the jobs: a worker with 16 CPUs and 64 GB offers 14.4 CPUs and 56.6 GB after the default reserve
of 10 % and 1 GB, so it holds three `size-m` jobs and one `size-s` at the same time. It cannot hold a `size-xl` job
(16 CPUs): that needs a worker with at least 18 CPUs and 37 GB of memory. A size larger than any worker can give never starts;
its jobs wait with *"No worker is large enough for …"*.

## ➕ Add a worker

**Workers → Add worker** (or step 4 of the setup assistant):

1. **Run the setup command** as root on the server.
2. **Connect**: enter the address as CI-Plane reaches it and the SSH port. If the command has not run yet, CI-Plane
   tries again every 5 seconds until you choose **Stop trying**.
3. **Check and add**: CI-Plane shows the system, CPUs, memory, disk and the SSH host key. Compare the key with
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the server. Give it a name (unique, up to 40 characters) and
   a tier, and choose **Add worker**.
4. **Preparation** runs by itself: check Docker, pull the runner, Docker-in-Docker and mirror images, copy the runner
   tools into a shared volume, start the registry mirror, run a test container. The page turns green when the
   worker is online. If a step fails, the page shows it with **Try again**.

The host key seen at the first connection is pinned. If it ever changes, CI-Plane refuses the server
([Troubleshooting](troubleshooting.md#-workers)).

## 📜 The setup command

The interface shows the command with this installation's public key built in. It is one line of the form
`sh -c '…'`, contains no secret, downloads nothing from CI-Plane, and every step may run twice. In order, it:

1. stops unless it runs as root;
2. installs Docker from `https://get.docker.com` if `docker` is missing (installing `curl` first with `apt-get`,
   `dnf` or `yum` if needed);
3. enables and starts Docker (`systemctl enable --now docker`, or `service docker start` without systemd) and waits
   up to 30 seconds for it to answer;
4. creates the group `docker` if it is missing and the user `ci-plane` (home directory, shell `/bin/sh`);
5. adds `ci-plane` to the group `docker` and sets its password field to `*`, so no password works but SSH keys do;
6. adds CI-Plane's public key to `~ci-plane/.ssh/authorized_keys` with the option `restrict` (no port forwarding, no
   agent forwarding, no terminal), unless it is there already;
7. sets the owner and the modes of `.ssh` (700) and `authorized_keys` (600), and restores SELinux labels where
   `restorecon` exists;
8. prints *"CI-Plane: this server is ready. Docker … runs and the user ci-plane may use it."*

Membership in the group `docker` is the only privilege the user gets, and it is equivalent to root on that server
([Security](security.md#-what-privileged-means)).

## 🪜 Tiers

Every worker has a tier from 1 to 9. CI-Plane fills the lowest tier first; inside a tier, the worker with the largest
free share of CPU and memory gets the job. A higher tier is only used when every worker of the lower tiers is full,
switched off, draining or offline.

Use tiers to keep a machine for overflow: your own servers in tier 1, a rented or shared machine in tier 2.

On the **Workers** page, drag a row by its handle (or focus the handle and use the arrow keys) to change the order or
move a worker to another tier; **Edit** in a worker's side sheet changes its name and tier.

## ⏸️ Switch off and drain

| | New jobs | Running jobs | Use it for |
|---|---|---|---|
| **Switch off** (the switch in the row) | none | finish | taking a worker out for a while |
| **Drain** (in the side sheet) | none | finish | maintenance: drain, wait until it runs nothing, then work on it |

Both take effect at once and survive restarts. Switch on, or **Stop draining**, to take jobs again. A switched-off
worker raises no alerts.

## 🧹 Clean up

**Clean up** in a worker's side sheet runs the janitor at once: refresh the images once a day, remove superseded
images and runner tool volumes, empty the registry mirror if it is past its cap, make sure the mirror runs. It
reports what it freed. The janitor runs by itself every ten minutes, and every five minutes while the disk is low
([Reliability](reliability.md#-the-janitor)).

Leftovers of runners (containers, volumes, networks) are removed by the engine, not by the janitor: right after each
job, and whenever a container shows up that no runner of this installation belongs to.

## 👋 Remove a worker

1. **Drain** it and wait until it runs nothing. (Removing a worker with runners asks for confirmation: waiting jobs
   start elsewhere, running jobs are lost.)
2. **Remove …** in its side sheet. CI-Plane forgets the worker and shows the remove command.
3. Run the remove command on the server as root. It:
   - removes every container, network and volume with a `ci-plane.runner` or `ci-plane.role` label (runners, the
     registry mirror, the runner tools),
   - ends the processes of the user `ci-plane` and deletes the user with its home directory and key,
   - prints what it did. Docker and its images stay installed; remove them yourself if you no longer need them.

The remove command does not tell installations apart. If two installations of CI-Plane share the server, it removes
the runners and the user of both.

## 🔍 What CI-Plane sees

The side sheet of a worker shows its state and why, reserved and live CPU and memory, disk, Docker version, the
pinned host key, the latest runners and recent events.

| State | Meaning |
|---|---|
| `setup` | added, never connected |
| `online` | connected and healthy; takes jobs if switched on and not draining |
| `unreachable` | the SSH connection or the live values stopped; CI-Plane reconnects by itself |
| `unhealthy` | three runners in a row failed to start; tested every 30 seconds |
| `disk-full` | less free disk than the threshold |
