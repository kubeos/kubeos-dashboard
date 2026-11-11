# BUILD.md — from `git clone` to a running systemd service

The KubeOS dashboard ships as a **binary plus a systemd unit**, not as a container image.
This file is the step-by-step path: build the release, put it on the node, install it, verify it.

Everything below has been run exactly as written on 2026-11-11 (Debian 13 / trixie, k8s v1.37.2).

---

## 0. Which machine does what

Two steps, and it matters which machine you are on for each:

| Step | Machine | Why |
|---|---|---|
| **Build** the release | any Linux with `tar` + `sha256sum` | it only assembles files; it never touches a cluster |
| **Install** it | **the machine that will serve the dashboard** — on KubeOS: the node itself | `install.sh` has no `--host` and never uses `ssh`; it installs *where you type it*, as root |

Two different questions, two different answers:

```
WHERE the service runs  → decided by which machine you are on   (no flag: always local)
WHICH cluster it shows  → decided by the kubeconfig's server:   (a URL; can be remote)
```

On a KubeOS node both are the same box, which is the intended case.

**Check you are on the right machine before you start** (all three must succeed):

```sh
hostname; id -u                                                      # node name, and 0 = root
ls -l /etc/kubernetes/admin.conf                                      # exists → cluster node
kubectl --kubeconfig /etc/kubernetes/admin.conf get --raw=/readyz      # prints "ok"
```

(A KubeOS node has **`wget`, not `curl`** — keep that in mind for any one-liner you copy from
elsewhere, including older versions of this document.)

---

## 1. Prerequisites

**Build machine**

| Needed | Notes |
|---|---|
| `git` + credentials | the repository is **private**: `git@github.com:skmdab/kubeos-dashboard.git`, or `https://` with a token |
| `tar`, `gzip`, `sha256sum` | coreutils; present on any Debian/Ubuntu/Fedora/macOS-with-coreutils |
| — | **no docker, no Go, no Node, no Helm, no registry account, no network** |

**Node (install machine)**

| Needed | Notes |
|---|---|
| root | the installer creates a system user and writes to `/etc`, `/usr`, `/var` |
| a kubeconfig | on a KubeOS node: `/etc/kubernetes/admin.conf`, created by first boot |
| systemd | it is installed as `kubeos-dashboard.service` |
| `kubectl` | **strongly recommended** — used to rename the kubeconfig context to `main`, which is what makes the URLs `/c/main/...` (see §7) |
| `openssl` | only to generate the self-signed certificate; skip it with `--tls-cert/--tls-key` |
| `wget` **or** `curl` | only for the post-install readiness check (a KubeOS node has `wget` only) |
| `ip` | only for the certificate SAN and the final URL line |
| free port | `30443` by default; it must not already be taken |

---

## 2. Step 1 — clone

```sh
git clone git@github.com:skmdab/kubeos-dashboard.git
cd kubeos-dashboard
```

52 MB of that is `vendor/headlamp/` (the pinned upstream binary + frontend). It is committed on
purpose, so the build needs no download — see [`vendor/README.md`](vendor/README.md).

---

## 3. Step 2 — build the release

```sh
deploy/binary/build-binary.sh
```

Expected output (the sha256 changes every build):

```
build-binary: using vendored headlamp-server.tgz (offline, digest verified)
build-binary: using vendored frontend.tgz (offline, digest verified)
build-binary: assembling kubeos-dashboard-0.1.0-linux-amd64
build-binary:    Headlamp unknown (linux/amd64)
build-binary: release: …/release/kubeos-dashboard-0.1.0-linux-amd64.tar.gz
build-binary:   unpacked 122M, 830 files, 50M compressed
build-binary:   sha256: <64 hex chars>
```

Result: `release/kubeos-dashboard-0.1.0-linux-amd64.tar.gz` — 50 MB compressed, 122 MB unpacked,
830 files.

**Only if you changed the TypeScript** (`kubeos-branding/src/*`) rebuild the plugin bundle first:

```sh
cd kubeos-branding && npm install && npm run build && cd -
deploy/binary/build-binary.sh
```

`dist/main.js` is committed, so a normal build never needs Node. The build warns if `src/` is newer
than the committed bundle, which is the mistake that ships a stale UI.

### What is inside the tarball

```
bin/headlamp-server                 static Go binary, 93 MB, no libc
share/frontend/                     the built UI
share/plugins/kubeos-branding/      the KubeOS plugin (branding, NFS, disks, join, node controls)
systemd/kubeos-dashboard.service    the unit
systemd/kubeos-dashboard.env.example
install.sh  uninstall.sh            root-only, idempotent
LICENSE  NOTICE                     Apache-2.0 attribution for the vendored upstream binary
VERSION  sha256sums.txt             upstream version, both layer digests, plugin sha256
```

`VERSION` is the audit trail: it names the upstream image, both layer digests and the plugin's
sha256, so any tarball can be traced back to its inputs.

---

## 4. Step 3 — copy it to the node

```sh
scp release/kubeos-dashboard-0.1.0-linux-amd64.tar.gz root@<node-ip>:/root/
```

---

## 5. Step 4 — install (on the node, as root)

```sh
ssh root@<node-ip>
tar -xzf /root/kubeos-dashboard-0.1.0-linux-amd64.tar.gz -C /root
cd /root/kubeos-dashboard-0.1.0-linux-amd64
./install.sh --kubeconfig /etc/kubernetes/admin.conf --port 30443
```

Expected output:

```
install-dashboard: created system user kubeos-dashboard
install-dashboard: installed the binary, the frontend and the plugin
install-dashboard: kubeconfig installed as /etc/kubeos-dashboard/kubeconfig (…)
install-dashboard: kubeconfig context renamed: 'kubernetes-admin@kubernetes' -> 'main' (…)
install-dashboard: identity check: the API server accepts this kubeconfig
install-dashboard: generated a self-signed certificate for DNS:localhost,IP:127.0.0.1,DNS:<host>,IP:<node-ip> (valid 825 days)
install-dashboard: enabled kubeos-dashboard
install-dashboard: dashboard answers on https://127.0.0.1:30443/ (HTTP 200)
install-dashboard: Dashboard:  https://<node-ip>:30443/
```

The installer stops at the first problem (`no such file`, `incomplete release`, `run as root`), so a
half-installed service is not a state you can end up in.

### Options

| Option | Default | Meaning |
|---|---|---|
| `--kubeconfig <path>` | **required** | the identity the dashboard proxies with; it is copied, so the service user only needs read access to the copy |
| `--port <n>` | `30443` | HTTPS port |
| `--listen <addr>` | `0.0.0.0` | bind address |
| `--tls-cert` / `--tls-key` | self-signed | use an existing certificate (give both) |
| `--san <entry>` | — | extra SAN, repeatable, e.g. `--san 'IP:10.0.0.5' --san 'DNS:dash.lan'` |
| `--context-name <name>` | `main` | cluster id in every URL (`/c/<name>/…`) |
| `--no-start` | — | install and enable, but do not start now |

Re-running `install.sh` is the **upgrade path**: it replaces the binary, frontend and plugin, keeps
the existing certificate and kubeconfig, rewrites the flags and restarts the unit.

### What it creates

```
/usr/lib/kubeos-dashboard/headlamp-server      binary + VERSION            root:root 0755
/usr/share/kubeos-dashboard/{frontend,plugins} the UI and the plugin       root:root 0755
/etc/kubeos-dashboard/kubeconfig               the shared identity          0600
/etc/kubeos-dashboard/tls.crt, tls.key         HTTPS                        0644 / 0600
/etc/default/kubeos-dashboard                  the flags (HEADLAMP_ARGS=…)  0644
/etc/systemd/system/kubeos-dashboard.service   the unit
/var/lib/kubeos-dashboard/                     writable HOME for the server 0750
```

---

## 6. Step 5 — verify

```sh
systemctl status kubeos-dashboard --no-pager     # active (running)
systemctl is-enabled kubeos-dashboard            # enabled  → starts at boot
wget --no-check-certificate -q -O /dev/null https://127.0.0.1:30443/ \
  && echo "dashboard answers on 30443"           # prints the line = HTTP 200
journalctl -u kubeos-dashboard -n 20 --no-pager -o cat
```

`curl` is not installed on a KubeOS node; use `wget` as above, or from another machine
`curl -sk -o /dev/null -w '%{http_code}' https://<node-ip>:30443/`.

In the journal you should see, in order:

```
*** Headlamp Server ***
Proxy setup            context=main  clusterURL=https://<node-ip>:6443
HEADLAMP_BACKEND_READY
```

Then open **`https://<node-ip>:30443/`** in a browser. The certificate is self-signed, so the
browser warns once — accept it for that host. The page title should read `<cluster> - Cluster - KubeOS`
and the top bar carries **Restart · Power off · Shell**.

---

## 7. Things that are correct but look wrong

- **`kubectl get pods -A` does not list the dashboard.** It is a host service, not a Pod. Use
  `systemctl status kubeos-dashboard` and `journalctl -u kubeos-dashboard`.
- **Overview says "Pods 0 / 0 Requested"** on a fresh KubeOS node — that is the truth, the cluster
  really has no Pods.
- **URLs are `/c/main/...`** because the installer renamed the context in its private copy of the
  kubeconfig. If you see `/c/kubernetes-admin@kubernetes/...`, `kubectl` was missing at install time
  and the rename was skipped: install `kubectl` and re-run `install.sh`.
- **Every browser user shares one identity.** `headlamp-server` is started with `--kubeconfig`, so
  whatever that file may do, the dashboard may do — there is no login of its own. Keep it on a
  trusted network (TLS is mandatory: the unit refuses to start without a certificate), and use a
  scoped kubeconfig rather than `admin.conf` if the network is not trusted.

---

## 8. Day 2

```sh
systemctl restart kubeos-dashboard                    # after editing /etc/default/kubeos-dashboard
journalctl -u kubeos-dashboard -f                     # live log
cat /usr/lib/kubeos-dashboard/VERSION                 # what is installed

# change the port: rewrite the flags, then restart
sed -i 's/--port=30443/--port=31443/' /etc/default/kubeos-dashboard
systemctl restart kubeos-dashboard
```

**Upgrade** — copy a newer tarball to the node and run `install.sh` again (same command).

**Remove**

```sh
cd /root/kubeos-dashboard-<version>-linux-amd64
./uninstall.sh            # stop, disable, remove files; keeps /var/lib and the user
./uninstall.sh --purge    # also remove /var/lib/kubeos-dashboard and the user
```

---

## 9. Bumping upstream Headlamp

```sh
# read the two layer digests of the new image
docker manifest inspect ghcr.io/headlamp-k8s/headlamp:vX.Y.Z            # pick the amd64 digest
docker manifest inspect ghcr.io/headlamp-k8s/headlamp@sha256:<that>     # its layers

HEADLAMP_VERSION=vX.Y.Z \
BINARY_LAYER=sha256:… FRONTEND_LAYER=sha256:… \
  deploy/binary/build-binary.sh --vendor

git add vendor/ deploy/binary/build-binary.sh && git commit   # the vendored files ARE the change
```

`--online` ignores `vendor/` and only downloads (useful to test a version before committing 52 MB).
A normal build never needs network: the vendored files are re-verified against the pinned digests,
and one modified byte aborts the build with the expected and actual hash.

---

## 10. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERROR: no such file: /etc/kubernetes/admin.conf` | you are on the wrong machine (the path is a node's) | run it on the node, or pass `--kubeconfig` pointing at a file that exists |
| `ERROR: run as root` | — | `sudo` / root shell |
| `ERROR: incomplete release: …` | extracted a partial tarball | re-extract; verify with `sha256sum -c sha256sums.txt` |
| `ERROR: digest mismatch for …vendor/headlamp/…` | vendored file corrupted or edited | `cd vendor/headlamp/v0.46.0 && sha256sum -c SHA256SUMS`, restore with `git checkout -- vendor/` |
| `WARNING: no HTTP 200 yet` | port busy, or the certificate/kubeconfig unreadable | `ss -lntp \| grep 30443`, then `journalctl -u kubeos-dashboard -n 40` |
| `curl: command not found` | a KubeOS node ships `wget`, not `curl` | use the `wget` forms in §0 and §6, or run `curl` from another machine |
| service `failed`, `ConditionPathExists` | kubeconfig or certificate missing | re-run `install.sh` |
| page loads but every list is empty | the kubeconfig cannot reach the API | `kubectl --kubeconfig /etc/kubeos-dashboard/kubeconfig get --raw=/version` |
| `Forbidden … subresource(s)=[proxy]` on Logs/Exec | the identity lacks `nodes/proxy` | grant it (kubeadm normally does via `system-api:apiserver-kubelet-client`); see `~/KubeOS` notes |
| URLs show `/c/kubernetes-admin@kubernetes/` | `kubectl` was missing at install | install `kubectl`, re-run `install.sh` |
| browser certificate warning | self-signed by design | accept it once, or pass `--tls-cert/--tls-key` |

---

## 11. What you do *not* need

No docker · no container runtime on the build machine · no Go toolchain · no Node (unless you edit
the plugin) · no Helm · no registry account or `ghcr.io` access · no clone of upstream Headlamp.
The repository plus the machine's own `tar`/`sha256sum`/systemd is the whole dependency list.
