# MEMORY.md — working memory for the KubeOS dashboard project

Written to be read at the start of a session, after `AGENTS.md`. It is the durable
record of decisions, machine facts and history so no session has to rediscover them.

Last updated: 2026-11-08 22:20 (session C, the first combined KubeOS+dashboard session; see
the RESUME block below before anything else). Started from the transcript of session
`session-956734de-8e0e-4798-8bee-5f8bcf2eabd5` (42 turns, 469 steps) and has been
kept current by hand ever since.

No secrets here by design: no tokens, no private keys. See §10 for where those live.

---

---

## RESUME HERE TOMORROW (written 2026-11-08 22:20, before the host was powered off)

The host PC will be switched off. **Nothing is lost**: the three VMs, etcd,
the containerd stores, the helm release and the TLS secret are all on the VM disks.
Two one-command scripts now exist so no session starts by rediscovering the setup.

```sh
cd ~/headlamp/_kubeos-dashboard
./up.sh                 # start the 3 VMs, wait for API + 3 nodes Ready + dashboard, print the URL
./up.sh --check         # same, verify only, starts nothing
./redeploy.sh           # after editing kubeos-branding/src/: npm build -> image -> load on all 3 nodes -> helm upgrade
./redeploy.sh --no-build  # skip the build, just re-load the image and helm upgrade
```

`up.sh` was tested in `--check` mode at 22:20 and printed: 3 nodes Ready, dashboard pod
`1/1 Running` on kubeos2, and HTTP 200 on `:30443` for `.4`, `.5` and `.6`.
`redeploy.sh` was **not** run end to end (it would have re-deployed an unchanged image);
its build half was proven separately — `npm ci` (843 MB, 39 s) then `npm run build`
produces a byte-identical `dist/main.js` (76 882 bytes).

**State at shutdown (verified 22:20):** cluster `kubeos`(.4 control-plane) +
`kubeos2`(.5) + `kubeos3`(.6), all Ready; 16/16 pods Running; dashboard release
`kubeos-dashboard` in `kubeos-system`, one Ready pod on kubeos2; `https://192.168.122.4:30443`.
KubeOS repo at `a4ea487`, this repo at `ac41643`, both on `development`, both clean
except the memory edits.

**The trap found today, and why the shutdown would have gone wrong:** `kubelet` on
**kubeos2 was `disabled`** (a joined node, unlike .4/.6 built from the ISO where hook
9050 enables it). A powered-off host would have booted kubeos2 into **NotReady**, and
because the dashboard pod happens to be scheduled there, the dashboard would have been
gone with no obvious cause. Fixed with `systemctl enable kubelet` on .5, then **proved by
really rebooting kubeos2**: node came back Ready, kubelet `enabled/active`, dashboard pod
restarted on a new pod IP (`.77`) and `:30443` answered 200 again. `up.sh` now warns if any
node reports `kubelet` not `enabled`. **Whenever a node is joined by hand, check
`systemctl is-enabled kubelet` on it.**

**Not tested:** reboot of the control-plane VM `.4`. Its `kubelet` and `containerd` are
both `enabled`, and etcd/static pods restart from disk, but a control-plane reboot is
untested here — if the cluster does not come back tomorrow, start there
(`systemctl status kubelet`, `journalctl -u kubelet -b`, `crictl ps -a`).

**Still open (unchanged):** `local-path` `volumeBindingMode: Immediate` defect,
dashboard authentication/scoped RBAC (today `cluster-admin`), join hardening, and
packaging the dashboard into the ISO (`9031` hook + `kubeos-cluster-ready` step 8).
Memory edits in both repos are **uncommitted** — commit them first thing.

## How this file stays current

`AGENTS.md` §9 makes this the project's memory and §10.3 makes reading it the third
step of every session. The rule that matters: **it is written during the session, not
at the end.** After every change, deploy, decision, discovery or mistake, append it in
the same turn and carry on — session `956734de` died with an unanswered question
because its context only ever existed in the chat log.

What to touch, most-often first:

- **§5 Session history** — one bullet per event, appended under the session that did it.
  Plain language, what changed and why; no need to restate code that is in the repo.
- **§7 Open items** — add, re-scope or remove the moment the state changes.
- **§6 Live state** — after each deploy, say what was verified and how.
- **§2, §4, §8, §9** — when a new machine fact, command, internals detail or trap is
  learned the hard way.
- **Version trio** (§3) — when Headlamp, the chart or the plugin SDK moves.

Keep it factual and keep it honest: if something was not tested, say "not verified".

**Commits are batched, memory edits included.** `AGENTS.md` §3.7 is the rule: ask for a
push when a logical piece of work is finished, not for every edit. Edits to this file
therefore accumulate in the working tree (kept identical on host and builder) and go up
with the next real change. Do not propose a commit whose only content is memory polish.

---

## 1. What this project is

The web dashboard for **KubeOS**: a thin KubeOS branding/UX layer on top of
**Headlamp v0.46.0**, delivered as a one-layer image on the upstream image. Nothing
forks Headlamp; the plugin is the only custom code.

Upstream clone for reading Headlamp source: `/home/shaik/headlamp` (read-only source
of truth for behaviour questions — this project never edits it).

## 2. Machines and access

**Standing access permission (user, 2026-11-10):** "you have permission for them how you
have permission for KubeOS" — `~/kubeos-dashboard` and `~/headlamp` (including
`_kubeos-dashboard/`) may be edited, built and deployed **without asking for approval
each time**: read, write, `npm run build`, `docker build`, `docker run`, `scp`/`ssh` to
the test node. This covers *file and tool access only* — `git commit` / `git push` still
need an explicit yes (AGENTS.md §3), and the ISO tree is still edited by its own rules.

| Machine | Address | Facts |
|---|---|---|
| Host (this box) | — | docker works (`docker version` succeeds). No `kubectl`, no `helm`. |
| Builder VM | `root@192.168.122.2` | Debian 13.7, node 20.19.2 / npm 9.2.0, git + GitHub SSH as `skmdab`, no docker. Authoritative git working tree at `/root/kubeos-dashboard`. |
| KubeOS node | `root@192.168.122.4` | KubeOS Linux v1.0 "Orhan", k8s v1.37.2, containerd 2.4.2, `helm` present, no docker, 2 vCPU / 1.9 GiB. Calico + CoreDNS running. |
| KubeOS node | `root@192.168.122.5` | **The only live node since 2026-11-10.** Fresh KubeOS install, VM `kubeos`, hostname `kubeos`, own control-plane (the 2026-11-08 two-node pair at .4/.6 is gone). k8s v1.37.2, containerd 2.4.2, root-only login, 25 GB `vda` (VG `kubeos-vg`, 1.00g free) plus a **10 GiB `vdb`** used for LVM testing. Same `.vm_key`. |

Helpful scripts and materials from earlier sessions live **outside the repo** in
`/home/shaik/headlamp/_kubeos-dashboard/`: `vm.sh` (run on builder), `node.sh` (run on
node), `.vm_key` (the SSH key authorized on both VMs), `admin.conf` (node kubeconfig),
`token.txt`, screenshot tooling (`shoot-*.js`), and `.docker/` (a `DOCKER_CONFIG`).

**The host's own SSH works.** `ssh -T git@github.com` authenticates as `skmdab` from a
normal shell, and the VMs are reachable as usual.

What fails is plain `ssh` **inside the agent sandbox**, and it is a sandbox artefact
rather than a host problem: root-owned files are presented there as
`nobody:nogroup` (`stat /etc/ssh/ssh_config` → `nobody:nogroup`), and `ssh` refuses a
config owned by someone else with `Bad owner or permissions on
/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf`. The file is genuinely root-owned on
the host. Consequences and workarounds:

- VMs: use `vm.sh` / `node.sh`, which pass `ssh -F /dev/null -i <key> -o
  StrictHostKeyChecking=no -o UserKnownHostsFile=<file>` and skip the system config.
- GitHub from the agent: `GIT_SSH_COMMAND="ssh -F /dev/null -o
  StrictHostKeyChecking=accept-new" git fetch origin development`, then leave `git pull`
  alone (it re-fetches) and fast-forward with `git merge --ff-only origin/development`.
- Pushing: the builder VM has working git + GitHub SSH, so commits are pushed from
  there; the host then fast-forwards as above. The maintainer can also push from the
  host shell himself.
- Do not "fix" the file ownership from this session: it is correct already, and the
  error only appears under the sandbox.

## 3. Repo and branch state

- Remote `git@github.com:skmdab/kubeos-dashboard.git` (private).
- **`development` is the default branch and the only branch that receives pushes.**
  `main` is a release mirror, moved only when the maintainer says "push to main" in
  that same message. `main` sitting behind `development` is the normal state.
- Host `/home/shaik/kubeos-dashboard` and builder `/root/kubeos-dashboard` must stay
  identical (sync is allowed without asking; pushing is not).
- Versions that move together: Headlamp image `v0.46.0` (`ARG HEADLAMP_VERSION`),
  Helm chart `0.46.0`, plugin SDK `@kinvolk/headlamp-plugin ^0.14.0`.

## 4. The build → deploy loop that actually works

**CORRECTION 2026-11-11: the host builds the plugin itself — the builder VM is not needed for the
dashboard at all.** The line that used to sit here ("build on the builder VM, host has no toolchain
wired up") was wrong when it was written and is wrong now: the host has `node v26.13.0`,
`npm 12.2.1`, `pnpm 12.16.1`, `docker 26.1.5`, and `kubeos-branding/node_modules` already installed
(843 MB). `cd kubeos-branding && npm run build` on the host produces `dist/main.js` and leaves
`git status` **clean**, i.e. the committed bundle is byte-reproducible from the source. Use the
host; only fall back to the builder if the host disk or node version ever gets in the way.

```sh
# 1. edit plugin source, then build it — on the HOST, not the builder
( cd ~/kubeos-dashboard/kubeos-branding && npm run build )

# 2. rebuild the image on the host, from the host repo
DOCKER_CONFIG=/home/shaik/headlamp/_kubeos-dashboard/.docker \
  docker build -f image/Dockerfile -t ghcr.io/skmdab/headlamp:kubeos-0.1.0 .

# 3. side-load into the node's containerd (the node has no registry access)
docker save ghcr.io/skmdab/headlamp:kubeos-0.1.0 | gzip -1 \
  | ./node.sh 'ctr -n k8s.io images import -'

# 4. restart and check
./node.sh 'kubectl -n kubeos-system rollout restart deploy/kubeos-dashboard-headlamp &&
           kubectl -n kubeos-system rollout status deploy/kubeos-dashboard-headlamp'
```

Screenshots for visual verification are taken from a headless-Chrome container, not
local Firefox (Firefox crashes in this sandbox):

```sh
docker run --rm --network host -v "$PWD":/shots -v /etc/hosts:/etc/hosts:ro \
  --entrypoint node zenika/alpine-chrome:with-puppeteer /shots/<script>.js
```

Live dashboard: **https://192.168.122.5:30443** (NodePort, self-signed cert →
browser warning expected; the single test VM at 192.168.122.5 is VM `kubeos`, the old
.4/.6 machines are gone). No login prompt (see §6).

## 5. Session history (append-only)

Newest session last. Each session appends its own block rather than rewriting earlier
ones — the old reasoning is often worth more than a tidy summary of it.

### Session A — `956734de`, 2026-11-08 01:27 → 13:12 (killed mid-answer)

1. **Surveys and decisions.** The maintainer picked Headlamp over the archived
   `kubernetes/dashboard`; separate private repo; delivery path **B — own image**, but
   implemented as one layer on the official image (no fork); pin the **chart version**,
   not the image tag (chart `0.46.0` → image `v0.46.0`; the bare `0.46.0` tag is a 404
   on ghcr.io); NodePort for v1; dashboard ships in the ISO **later, as an add-on**.
2. **Branding.** Colours copied from the KubeOS tree, never invented: lime ramp
   `#DBFF7A → #A3F000 → #63C400`, glow `#96FF28`, page `#050B05`, panel `#0B140B`,
   body text `#E8F2DC`, emphasis `#F4FFE8`, console grey `#6E7D64`. Logos: MFZ mark
   from the website logo (already transparent), wordmark cropped out of
   `kubeos-lockup-640.png` (rows 378–443) with its near-black backdrop converted to
   alpha. The maintainer chose **mark and wordmark side by side, not a combined
   lockup** — size option **B** (mark 24 / gap 9 / wordmark 15) in the preview sheet.
3. **Plugin built and image published to the local docker daemon.** First real bug: the
   copied `dist/package.json` landed mode `600`, served as **403**, and the frontend
   silently rejects the plugin. Fix: `COPY --chmod=644`.
4. **First render.** `registerAppTheme` only advertises a theme; Headlamp resolves the
   active theme *before* plugin code runs, so a fresh browser got Light. Fixed by
   seeding `localStorage.headlampThemePreference` when absent plus **one** guarded
   reload (marker in `sessionStorage`), so a real user choice is never overridden.
   The maintainer explicitly wanted the lime-selection dark theme as the default.
5. **Real cluster.** The maintainer installed the ISO in KVM (`root@192.168.122.4`).
   Image side-loaded with `ctr`; chart rendered from the local clone (the Helm repo URL
   served an error page); TLS cert generated per machine into the
   `kubeos-dashboard-tls` secret.
6. **Second real bug.** The chart's probes speak **HTTP** while TLS is on → the pod
   crash-looped with "client sent an HTTP request to an HTTPS server". Fix:
   `probes.scheme: HTTPS`, and mount the cert that `tlsCertPath` pointed at.
7. **Visual defect pass.** Sidebar and content were both `#050B05` (flat) → sidebar to
   `BRAND.bg.panel`. Links were MUI blue `#6CB6F2` because `createMuiTheme`'s dark
   branch hardcodes it and overrides `AppTheme.link.color` → a scoped
   `.MuiLink-root { color: ... !important }` stylesheet rule.
8. **Gauges.** Ring "healthy" slices are `theme.palette.success.main` (`green[50]`,
   `#e8f5e9`); `success` and `chartStyles` are **not** in `AppTheme`, so a CSS rule
   keyed on the painted fill is the only lever. Maintainer chose **lime gauges**
   (`#A3F000`), and explicitly kept status chips as-is (Running neutral, Unhealthy
   amber) so warnings still read as warnings. Usage rings were then limed too
   (`#929191` → lime).
9. **Branch policy correction.** The maintainer said the earlier "keep main and
   development identical" was misread: **development only**, `main` only on request.
   Written into `AGENTS.md` + `README.md` (`e8501e1`) so it cannot drift back.
10. **Maintainer's rules adopted** as `AGENTS.md` (`501eeb0`), then `CLI_REQUIREMENTS.md`
    created with three real gaps (`7c7e9a6`), then the handoff format for KubeOS work
    added as §11 (`58ff2c0`).
11. **Login friction.** After the PC reboot the dashboard "was gone" — it was not: the
    service answered 200 and the browser was back at the token form. Rather than paste
    a 944-character JWT on every new browser, `unsafeUseServiceAccountToken: true` was
    enabled and the pod's own SA (`kubeos-system/kubeos-dashboard-headlamp`, **not**
    `kubeos-dashboard`) was bound to `cluster-admin` by hand (`e43371e`).
12. **CPU/RAM empty** because KubeOS ships no metrics-server. Installed upstream
    v0.8.0 by hand with `--kubelet-insecure-tls` (KubeOS kubelets are self-signed) and
    side-loaded the image; committed the manifest as `deploy/metrics-server/`.
13. **Handoff written and accepted.** The maintainer pasted the metrics-server handoff
    into the KubeOS workspace and said it was added there ("done.. it added to kubeos
    code").
14. **Latest fix (`ef5bc81`).** The maintainer reported that clicking a sidebar
    sub-item made its label disappear. Cause: `sidebar.selectedColor` is used only for
    a *nested* selected row (label + 4px marker bar on the dark panel, no fill); it was
    set to near-black `#050B05`, measuring **1.06:1**. Now `BRAND.lime.primary`. A
    contrast scanner then found **0** low-contrast text nodes across six pages, so this
    was the only such bug.
15. **Session ended unanswered.** The last question was **"why storage section does not
    showing any data"** — never answered. See §7.

### Session B — this one, 2026-11-08 13:24 → (cwd `~/kubeos-dashboard`)

1. **Recovery of session A.** Read `AGENTS.md`, the whole repo, then decompressed and
   parsed A's transcript (1.8 MB zstd → 3397 events) and distilled it into this file.
   Verified the environment independently: both repos on `development` @ `ef5bc81`,
   clean and identical; node Ready; dashboard 200; metrics Available True.
2. **`MEMORY.md` created** (`b20b03b`) and `AGENTS.md` §10 gained the step that reads it.
3. **SSH misdiagnosis corrected** (`218841a`). Session B first reported "the host's SSH
   is broken"; the maintainer's own `ssh -T git@github.com` worked. The real cause is
   the sandbox mapping root-owned files to `nobody`, so only the agent is affected.
   Recorded, together with the `-F /dev/null` fetch + `--ff-only` merge recipe.
4. **Storage question answered** (`2dd3fe2`). Zero StorageClasses, PVs, PVCs and CSI
   drivers; the dashboard SA gets `200 {"items":[]}`, so the empty pages are honest. A
   throwaway PVC (`kubeos-storage-test/cli-check`) stayed `Pending` with
   `FailedBinding: no persistent volumes available for this claim and no storage class
   is set`, proving there is no provisioner. Cleaned up afterwards; nothing installed.
   Logged as CLI requirement 4 and handed over in the §11 format.
5. **Memory made automatic.** On the maintainer's instruction, `AGENTS.md` §9 now says
   this file is written *during* a session, and this file says how (§"How this file
   stays current"). From here on, every session appends under its own heading.

6. **"Adding a node" question.** The maintainer expected a Proxmox-style add-node
   button. Verified there is none and cannot be one at the Kubernetes layer: no
   create-node API, and Headlamp offers only cordon/drain/delete/edit. The real blocker
   is KubeOS — every install runs `kubeos-cluster-init` and there is no `kubeos join`.
   Logged as CLI requirement 5, and the dashboard-side option (a join-token + pending-CSR
   panel) is parked in §7 item 7.
7. **Second node joined by hand — end to end.** A second fresh KubeOS install
   (`192.168.122.5`, `kubeos2`) was brought up; on its own it formed a *separate*
   cluster (`kubeos2 Ready control-plane`), confirming the CLI gap. It was then reset
   (`kubeadm reset -f`, wipe `/etc/kubernetes`, `/var/lib/etcd`, `/etc/cni/net.d`,
   `/var/lib/kubelet/*`, `/var/lib/kubeos/initialized`, disable `kubelet` and
   `kubeos-cluster-setup`), joined with a `kubeadm token create --print-join-command`
   token from the control plane, and verified: both nodes Ready, `calico-node` +
   `kube-proxy` per node, a TCP payload crossed from a `kubeos` pod to a `kubeos2` pod,
   DNS resolved, a 2-replica Deployment placed one pod per node, and the dashboard
   showed both nodes with live CPU/memory. No internet was needed — the worker images
   were already in that node's containerd. Recipe written into CLI requirement 5.

8. **Reviewed the KubeOS join implementation (uncommitted, no ISO rebuilt).** The
   KubeOS session's working tree in `/home/shaik/KubeOS` adds `usr/bin/kubeos`
   (token/join/status), `usr/bin/kubeos-node-join`, `kubeos-cluster-join.service`, an
   installer question (`94-kubeos-join`, `join.templates`) and a preseed late_command
   that writes `/etc/kubeos/join.conf` into the target. Design matches the manual recipe
   verified here. Two of its assumptions were checked on the live worker and hold:
   `kubectl --kubeconfig /etc/kubernetes/kubelet.conf get node <self>` works (the script
   waits on exactly that), and `kubeos status` / `kubeos token` behave correctly on a
   worker (the copy was removed afterwards). One real defect reported:
   `kubeos-node-join` deletes `join.conf` **before** writing the `joined` marker, so a
   crash in that window makes the next boot fall back to `kubeos-cluster-init` — i.e. a
   second cluster, the very failure the design prevents. Also flagged: the new installer
   question has no preseed value (blocks unattended installs), and a permanently failing
   join leaves only a journal line, nothing `kubeos status` can report.

9. **Plan set for the rebuilt-ISO test (2026-11-08).** The maintainer will rebuild the
   ISO, install it into **both** KVM guests (`kubeos1` as first node, `kubeos2` answering
   the installer's join question) and give SSH access. Order agreed: fabricate nothing —
   verify what a fresh install does by itself, and hand back anything that needs KubeOS
   work as a §11 prompt. The "Add node" panel is deliberately **not** started until these
   results are in, because the join mechanics it wraps must match what the ISO ships.
   Checks to run on `kubeos1`: first-boot journal without WARNINGs, metrics APIService
   Available, `local-path (default)` present, bare PVC → Bound, `local-path-provisioner`
   + `busybox` images present, no ImagePullBackOff, `kubeos status` / `kubeos token`.
   On `kubeos2`: `/var/lib/kubeos/joined` exists, **no** `/etc/kubernetes/admin.conf`,
   no etcd/apiserver, journal shows `kubeos-cluster-join` and not `kubeos-cluster-setup`,
   both nodes Ready with calico/kube-proxy each, cross-node traffic with the baked
   `busybox`, metrics for both nodes, and the dashboard listing both. Host RAM is tight
   (7.6 GiB total, ~600 MiB free), so the existing guests are reinstalled in place.

### Session C — combined KubeOS + dashboard session, 2026-11-08 17:35 → (this one)

The maintainer merged the two projects into **one session** and added
`~/KubeOS/DEEPSEEK_RULES.md` (combined-session rules: dashboard is the focus, KubeOS files may be
changed when the dashboard needs it, **the KubeOS CLI is frozen** — CLI gaps go into
`CLI_REQUIREMENTS.md`, never patched in the KubeOS tree).

1. **The two trees were separated again** (`~/kubeos-dashboard` is the repo; `~/KubeOS` has no
   dashboard code). Both on `development`, both clean apart from these memory edits.
2. **Every file in both projects was read** (111 in KubeOS, 25 here): no chart in this repo, the
   plugin bundle `kubeos-branding/dist/main.js` is committed, and the KubeOS tree's
   `9030`/`kubeos-cluster-ready` contain no dashboard work at all.
3. **Fresh-install verification of the rebuilt KubeOS ISO** on `192.168.122.4` (first boot finished
   18:01:16Z): node Ready and untainted, 12/12 pods Running, pod CIDR `10.244.0.0/16`.
   **metrics-server now works** (`v1beta1.metrics.k8s.io` `AVAILABLE True`, `kubectl top nodes`
   returns data) — so CLI item 1 can be closed. **storage is broken** — see item 4.
4. **Storage defect, root-caused and logged as CLI item 4.** The shipped StorageClass sets
   `volumeBindingMode: Immediate`; local-path is node-local, so every claim fails with
   `configuration error, no node was specified`. Proven on the node: with `WaitForFirstConsumer`
   the same 1Gi no-class claim reaches `Bound` in ~20 s. `volumeBindingMode` is immutable, so the
   class must be deleted and re-applied. Also: first boot's self-test consumes no claim with a pod,
   so it can only ever warn. **Not fixed here — CLI work.**
5. **The dashboard was deployed into `kubeos-system` by hand** so the maintainer could see it:
   `https://192.168.122.4:30443` → 200, pod `kubeos-dashboard-headlamp` 1/1 Running, plugin files
   200. Recipe that worked, and which the CLI must reproduce:
   chart **directory** from `/home/shaik/headlamp/charts/headlamp` (version `0.46.0`, 656 KiB) →
   `/root/kubeos-dash/chart`, `deploy/values.yaml` beside it, per-machine cert
   (`openssl`, SAN = node IP) into secret `kubeos-system/kubeos-dashboard-tls`, then
   `helm upgrade --install kubeos-dashboard /root/kubeos-dash/chart -n kubeos-system -f values.yaml`
   with **helm v4.3.0** on the node. **No hand-made RBAC was needed: the chart itself creates
   `clusterrolebinding/kubeos-dashboard-headlamp-admin` → `ClusterRole/cluster-admin`** (its
   defaults), which is exactly the binding our docs tell you to create by hand.
6. **Image path:** `docker build -f image/Dockerfile` on the host → `docker save | gzip -1 | ctr -n
   k8s.io images import -` on the node (a rebuilt layer produced the *same* image ID, so the
   committed bundle really is what runs). Warn the next session: the 112 MB export at
   `~/headlamp/_kubeos-dashboard/kubeos-dashboard.tar.gz` is **stale** (03:16) and the file named
   `headlamp-0.46.0.tgz` there is a **GitHub Pages "Site not found" page**, not a chart.
7. **Access recipe for the test VM** (this one cost time): the node takes password `1` for root and
   `sshpass` is **not** installed, but `SSH_ASKPASS=<script> SSH_ASKPASS_REQUIRE=force ssh …` works
   without it. The maintainer's `.vm_key` was then appended to root's `authorized_keys`, so later
   commands are plain key auth. **A fresh KubeOS install regenerates its SSH host keys by design**
   (`8050` hook), so the old `.known_hosts_node` entry is stale — use
   `-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=no`.
8. **Memory made automatic** (maintainer's instruction, 2026-11-08): everything is written to this
   file **during** the session, and `DEEPSEEK_RULES.md` §9 now says so explicitly, with §10 step 1
   reading both `MEMORY.md` files before anything else.

9. **N-node join proven by hand, dashboard-style (2026-11-08 evening).** `kubeos2`
   (`192.168.122.5`) was a fresh install with its **own** control-plane. It was reset and joined to
   `kubeos` with a token created **through the API** — a Secret of type
   `bootstrap.kubernetes.io/token` (6-char id, 16-char secret, `usage-bootstrap-*` true,
   `auth-extra-groups=system:bootstrappers:kubeadm:default-node-token`, 30 min expiry) — which is
   exactly what the plugin can do. Verified afterwards: both nodes `Ready`, `calico-node` and
   `kube-proxy` on each, a 2-replica Deployment placed one pod per node, cross-node ping 0% loss
   (~1.9 ms), cluster DNS resolving from the new node's pods, dashboard unaffected.
   **CA hash**: sha256 over the SPKI DER of the CA taken from `kube-public/cluster-info`
   (`sha256:4b78440e…`) matched `kubeadm token create --print-join-command` byte for byte. The
   bootstrap CSR was **auto-approved**, so the panel needs only `list` on CSRs for display.
10. **Traps found while joining (do not repeat):** (a) the new machine's
   `kubeos-cluster-setup.service` keeps retrying while `/var/lib/kubeos/initialized` is missing and
   **recreated `/etc/kubernetes` right after a reset** — stop the unit and write the marker *before*
   `kubeadm reset`; (b) `systemctl mask` fails ("File already exists") because our unit lives in
   `/etc/systemd/system`; (c) `pkill -f kubeos-cluster-init` **matches the remote shell running your
   own script and kills the session** — never use a self-matching pattern.
11. **Add-node panel — SDK facts confirmed for the build:** `registerRoute({path, sidebar, name,
   exact, component})` and `registerSidebarEntry({parent|sidebar, name, label, url, icon})` exist, and
   `ApiProxy` is exported from `@kinvolk/headlamp-plugin/lib` for raw API calls
   (`ApiProxy.request('/api/v1/namespaces/kube-public/configmaps/cluster-info')`).
   Design: sidebar entry → page that (1) shows endpoint + CA hash, (2) "Generate join command"
   creates a fresh short-lived token secret and renders ONE copy-paste line (stop first-boot unit,
   mark initialised, reset, join), (3) lists nodes/CSRs so the operator sees the new node appear.
   Destructive reset is opt-in via a checkbox (default on) because a fresh KubeOS box always carries
   its own cluster.

12. **"Join node" page — the form the maintainer asked for (2026-11-08 night).** The first attempt was
    backwards (dashboard minted a token to carry to the node). Their requirement: *"when user clicks
    join node it should ask token or key of that node … if I want to join 3 new node then I should
    enter my 3 node token or key in the dashboard"*. Implemented as: sidebar **Join node** → form
    (node address, user, **password *or* SSH private key**) → `Join this node` → the plugin mints a
    bootstrap token, then creates a **Job** running `ghcr.io/skmdab/kubeos-join-helper:0.1.0`
    (`image/joinhelper/`: alpine + openssh-client + sshpass), which SSHes into that machine, stops
    `kubeos-cluster-setup`, writes `/var/lib/kubeos/initialized`, `kubeadm reset`, starts containerd
    and waits for the CRI socket, then `kubeadm join`. Page shows per-attempt state + the helper's
    log and a live node list. **Proven** by resetting `kubeos2` out of the cluster and re-joining it
    through the Job. The credential lives only as a Job env var (Job auto-deletes after 15 min).
    Verification of served code: `/plugins/kubeos-branding/main.js` (NOT `/headlamp/plugins/…`,
    which is the SPA index) — 75 096 bytes containing `Join this node`, `NODE_PASSWORD`, `NODE_KEY`,
    `batch/v1`.
13. **Three bugs this feature produced, all fixed, all instructive:**
    (a) `kubeadm join https://host:6443` fails — `cluster-info` stores the scheme, kubeadm wants
    `host:port`;
    (b) the CA hash was wrong because `certificate-authority-data` is base64 of the **PEM text**,
    so the DER parser ate `-----BEGIN…` (first byte `0x2d`). Correct value comes from unwrapping
    the PEM first: `sha256:4b78440e…`, matching `kubeadm token create --print-join-command`;
    (c) the helper aborted with `i: parameter not set` because an **unquoted heredoc expands
    comments too** — a comment mentioning `$i` blew up under `set -u`. Keep `$` out of heredoc
    comments.

14. **First real join attempt by the maintainer failed, and the cause was predicted one turn
    earlier (2026-11-08 night).** Their attempt on a *stock* fresh node `192.168.122.6` logged
    `kubeos-join: using password authentication for root@192.168.122.6` →
    `Permission denied, please try again.` → `ERROR cannot ssh to root@…`. Reason: a stock KubeOS
    install ships Debian's `PermitRootLogin prohibit-password`, so **root + password is refused**
    (the older test VMs only accepted it because someone had added
    `/etc/ssh/sshd_config.d/` overrides by hand; the ISO contains no such file). Confirmed sshd
    policy on both nodes: `permitrootlogin yes` / `passwordauthentication yes` came from those
    overrides, and every node already has a normal user (`shaik`) in group `sudo`.
    Two fixes made and deployed the same turn:
    (a) the helper now supports a **non-root user** — it writes the privileged script to a temp
    file on the node and runs it through `sudo -S` (password) or `sudo -n` (NOPASSWD), so no sshd
    change is needed anywhere;
    (b) the panel showed "failed" with **no output** because pod logs are plain text and
    `ApiProxy.request` parses JSON — it now uses `ApiProxy.clusterRequest(path, {isJSON: false})`
    and prints a `kubectl logs` fallback when the log is empty.
    **Therefore root-login sshd overrides are NOT required** for the join feature.
15. **Answer kept for the maintainer's question "are those sshd settings necessary?":** SSH
    reachable on the node = yes (unavoidable: the join runs on that machine). `PermitRootLogin yes`
    = no. `PasswordAuthentication yes` = no (already Debian's default). A normal sudo user = already
    present on every install.

16. **Join flow REDESIGNED to the maintainer's own model (2026-11-08, late).** Their words: *"in
    dashboard there need be two options, like one is button with title says Generate token … and
    another field is for entering controlplane token"*, scenario: nodes 1/2/3 installed, user picks
    node2 as control plane, generates a token there, pastes it into node1's and node3's dashboards,
    and the official kubeadm runs underneath. Implemented exactly that:
    - **"1. This node is the control plane — Generate token"**: mints the official bootstrap-token
      Secret and returns ONE string `KOSJOIN1.<base64url(json{endpoint,token,caHash})>` — the same
      three values `kubeadm token create --print-join-command` prints; 60-minute TTL.
    - **"2. Join this node to a control plane"**: paste the string → the page provisions a
      **privileged one-shot pod** (hostPID, hostPath `/`, `nsenter -t 1`) which writes the join
      script to `/root/kubeos-self-join.sh` on the host and launches it with **`systemd-run`
      (`--unit=kubeos-self-join-<random>`)**, so the join survives `kubeadm reset` destroying the
      local cluster and with it the dashboard pod. Then plain `kubeadm join`.
    **No SSH, no passwords, no keys, nothing stored** — this replaced the credential-raising Job
    design and removes the loopholes found in item 14's audit. Privileged host access verified
    non-destructively on `kubeos` (`nsenter` → `hostname`, systemd state, `/host/etc/kubernetes`).
    **PREREQUISITE, still manual:** a node can only paste a token if it has its own dashboard, so
    the dashboard must be installed on **every** fresh node — that is `CLI_REQUIREMENTS.md` item 3
    (dashboard install not automated). Until the ISO does it, the dashboard is installed per node by
    hand (image side-load + chart + TLS secret).
17. **What the privileged pod means, stated plainly:** it runs with `privileged: true` and the host
    root filesystem mounted, i.e. it can do anything on that node. That is inherent to "join this
    machine without an SSH credential", and it is bounded by the fact that whoever can create pods
    in `kubeos-system` can already take over the node's cluster. The dashboard's missing
    authentication remains the top security item.

18. **Per-node dashboard install is now one command** (2026-11-08):
    `~/headlamp/_kubeos-dashboard/install-dashboard.sh <node-ip> root` — loads `headlamp` **and**
    `kubeos-join-helper` into that node's containerd (the helper must be local, because the self-join
    pod runs in that node's own cluster), copies the chart + `deploy/values.yaml`, creates
    `kubeos-system` with a per-machine cert, runs the helm release, waits for the rollout. Verified
    on `192.168.122.6`: dashboard 200, plugin bundle 76 410 bytes containing `Generate token` and
    `KOSJOIN1`, both images present. **Trap on this node:** the first attempt's `kubeadm init` failed
    with `invalid or incomplete external CA … apiserver.key: no such file` because an earlier reset
    left a partial `/etc/kubernetes/pki` (ca.crt without keys); a reinstall fixed it. Never leave a
    half-reset `/etc/kubernetes` on a node that is meant to bootstrap itself.
    **Test layout as of 2026-11-08 21:00:** CP cluster = `kubeos` + `kubeos2` (Ready);
    `192.168.122.6` is a *separate* fresh install running its own dashboard, waiting for the
    maintainer to paste a token from `.4`. The stale `kubeos3` Node object was deleted from the CP.

19. **First browser test of the two-control flow went wrong in an instructive way (2026-11-08 21:00).**
    The maintainer opened `.6`'s dashboard, clicked **Generate token there**, and pasted that token
    into the *same* dashboard — so `.6` joined **itself**: its token carried
    `endpoint 192.168.122.6:6443` (visible in their screenshot), `kubeadm reset` destroyed the cluster
    the join was aimed at, kubelet.conf was left behind and the control plane `.4` never saw a node.
    **Guard added**: the join handler reads this node's own `cluster-info` first and refuses a token
    whose endpoint is the same, with the message *"That token was generated by THIS node … use the
    dashboard of the node you chose as the control plane"*. Section 1's text now says the same in
    bold. Recovery used: `kubeadm reset` + wipe `/etc/kubernetes /var/lib/etcd /etc/cni/net.d
    /var/lib/kubelet/* /var/lib/kubeos/initialized`, start `kubeos-cluster-setup`, then
    `install-dashboard.sh`. **State after recovery:** `.4` CP = `kubeos` + `kubeos2` Ready; `.6` =
    separate fresh install with its own dashboard (200, guard present); both serve the 76 881-byte
    bundle. Reminder that cost time twice: after rebuilding an image, side-load it into **every**
    node of the cluster or the pod schedules onto one that still has the old one.

20. **The browser test WORKED (2026-11-08 ~21:25).** `kubeos3` (`192.168.122.6`) joined the control
    plane by pasting the generated token into its own dashboard — no CLI, no SSH. Verified: node
    `Ready`, `kube-proxy`/`calico-node` scheduled on it, and a busbox pod placed on `kubeos3` got
    IP `10.244.254.65` and resolved `kubernetes.default` → `10.96.0.1`. Cluster is now
    `kubeos` (control-plane) + `kubeos2` + `kubeos3` (workers), all Ready.
    **Maintainer's next observation: workers show an EMPTY "Roles" column in Headlamp.** That is
    correct Kubernetes behaviour — roles are labels (`node-role.kubernetes.io/<role>`), kubeadm labels
    only the control plane, and joined nodes get nothing. Fixed for display by labelling workers:
    `kubectl label node <n> node-role.kubernetes.io/worker= --overwrite`. **Open decision:** whether
    to make this automatic (the dashboard labelling any node that appears without a role label, the
    way k3s/RKE2 do) or to log it as a CLI requirement for first boot/join.

- **2026-11-08 21:50 — maintainer: "why all pods showing as unhealthy" (screenshot of the dashboard).
  Not a defect: the screenshot is Headlamp's Warning *events* table, not a pod list.** The tell is
  the column set `Type | Name | Namespace | Node | Reason | Message | Count | Last Seen` — a Pods
  list has `Status`/`Restarts`/`Age`, never `Reason`/`Count`/`Last Seen`. The rows are historical
  warnings; `Unhealthy` is the event *reason*, and "12m / 44m …" is `Last Seen`. Verified live on
  `.4` (3h53m-old cluster, 3 nodes Ready): **16/16 pods 1/1 Running, 0 restarts, no Warning event in
  the last 5 minutes, BGP full mesh Established on all three nodes** (`Mesh_192_168_122_4/5/6`).
  What the listed rows actually were: (a) `calico-node-6c275` on kubeos3 "BIRD is not ready / BGP not
  established with 192.168.122.4,192.168.122.5" for ~2 min after the join — the normal bootstrap
  window, self-heals once the mesh comes up; (b) `calico-node-67fhd` = the *pre-reset* calico pod on
  kubeos3 stuck terminating, `FailedPreStopHook` (leftover from the wipe/rebuild); (c) three
  `kubeos-dashboard-headlamp-*` pods from **three separate ReplicaSets** (`5f679c8f8b`, `7f6b7db478`,
  `645d8c8cb6`), i.e. three `install-dashboard.sh` runs minutes apart, each new replica probing
  `https://10.244.120.7x:4466` before its server listened → `connection refused`; only the last
  replica survives, Ready; (d) `calico-kube-controllers` readiness "timed out after 1s" once — the
  probe budget is 1 s and a join on a 4-core host can exceed it. Kubelet keeps events for 1 h
  (`--event-ttl`), so the feed empties itself. **Lesson for next time: always confirm a dashboard
  "unhealthy" claim with `kubectl get pods -A` before touching anything — the events page looks
  like a status page.** No code, config or cluster change was made for this; nothing committed.

- **2026-11-08 22:20 — host about to be powered off; made the setup survivable and found one
  real breakage.** The maintainer asked whether tomorrow's session could resume this exact
  setup or would start from scratch. Audit of what survives a shutdown: VM disks, etcd
  (130 MB under `/var/lib/etcd`), both images in **every** node's containerd store
  (`headlamp:kubeos-0.1.0`, `kubeos-join-helper:0.1.0`), helm release, TLS secret, the SSH
  key and `admin.conf` in `~/headlamp/_kubeos-dashboard/`, both git repos — all persistent.
  Missing/at risk: **libvirt has no autostart** (`/etc/libvirt/qemu/autostart/` does not
  exist), **`node_modules` was absent** so `npm run build` would have failed, no resume
  runbook, and memory edits uncommitted. **The real find: `kubelet` was `disabled` on
  kubeos2** (`enabled` on .4 and .6 — the ISO's hook 9050 enables it, a hand-joined node
  does not get it); that node would have booted **NotReady**, and the dashboard pod is
  scheduled on kubeos2, so the dashboard would have silently vanished tomorrow. Fixed with
  `systemctl enable kubelet` and **verified by rebooting kubeos2 for real**: node Ready,
  kubelet enabled/active, dashboard pod re-created on `10.244.120.77`, HTTP 200 on `:30443`.
  Then: `npm ci` in `kubeos-branding` (843 MB, 39 s; 3 packages' install scripts were blocked
  by npm but the build still works) — `npm run build` reproduces a byte-identical
  `dist/main.js` (76 882 B); wrote `~/headlamp/_kubeos-dashboard/up.sh` (start the 3 VMs,
  wait for API + 3 nodes Ready + dashboard pod, print URL, warn if any kubelet is disabled)
  and `redeploy.sh` (npm build → docker build → load image on all 3 nodes → helm upgrade →
  verify). Both `sh -n` clean; `up.sh --check` tested live. **Control-plane reboot of .4 was
  deliberately not tested** (it would take the whole cluster down with no console access) —
  its units are enabled, so it should come back, but that is an assumption, recorded as such.

- **2026-11-09 11:27 — resume after a real overnight power-off: everything came back by itself.**
  The RESUME block above was written before the shutdown; this is the proof it works. Host
  rebooted (~09:46), the maintainer started the VMs, then restarted them at 11:24:44. With no
  intervention from me: 3/3 nodes Ready, 16/16 pods Running, kubelet+containerd enabled/active on
  all three, no OOM kills, and the dashboard answering HTTP 200 on `:30443` for `.4`, `.5`, `.6`.
  The dashboard pod shows 3 restarts — **all of them node reboots** (`SandboxChanged` events, new
  pod IP each time: `.77` → `.78` → `.79`), not crashes; that is worth remembering before anyone
  reads a restart count as a bug. The cluster also serves the **current** bundle:
  `/plugins/kubeos-branding/main.js` is byte-identical to `dist/main.js` (76 882 B).
  `./up.sh --check` confirmed all of it in one command. **Host memory is the new risk:** 7.6 GiB
  total, four 2 GiB VMs (three nodes + `builder`), 6.9 GiB used / ~170 MiB free — shut `builder`
  down when not building an ISO.

- **2026-11-09 13:05 — pivot to the KubeOS CLI side (installer partitioning).** The maintainer said
  "now we move to KubeOS cli part" and lifted the CLI freeze **for storage/installer work only**;
  image baking, dashboard install, /etc/issue URL and multi-node joiner mode are still frozen. The
  first piece is a Proxmox-style guided partition flow in the installer (disk picker + root size +
  swap size, everything else automatic, no guided/manual menu). Nothing in this repo changed; the
  dashboard's own queue is unchanged. Two follow-ups that came out of the CLI discussion and affect
  this project: (a) the original "storage" item is still open — the shipped `local-path` class uses
  `volumeBindingMode: Immediate`, which is why first boot wastes 2 min 8 s on a claim that can never
  bind and why the Storage pages stay empty; (b) `kubeos-cluster-ready` may get a live first-boot
  progress banner on `/etc/issue` (maintainer approved the idea), which matters for the dashboard
  because today a first boot looks finished while it is still running.

### Next session — start here

Copy this block when beginning: confirm branch + sync on both machines, read §7 open
items, then ask. The most likely next piece of work is the auth scoping (open item 2)
or whatever the maintainer reports after clicking around.

### Session — 2026-11-10 17:30 → 18:05 (Disks section, Proxmox shape)

1. **Rejected first attempt, new spec.** The first Disks page was nested inside Headlamp's
   Storage group; the maintainer rejected it and sent two screenshots (Proxmox VE node menu)
   with the words "i want exact like proxmox which is Disks—LVM—LVMThin only this two" and
   "Disks field need to be in the middle of Storage of Network.. not in Storage". The
   screenshots were deleted after being read, as instructed.
2. **Rewritten `src/disks.tsx`.** Top-level `Disks` group (icon `mdi:harddisk`) with exactly
   two children, `LVM` → `/kubeos-disks/lvm` and `LVM-Thin` → `/kubeos-disks/lvm-thin`; one
   page each, Proxmox-style grid with a lime usage bar, a thin-volume sub-table under the
   pool, and a shared toolbar (node, timestamp, Refresh). The group links to its first child,
   so clicking "Disks" opens LVM and expands the two children.
3. **Sidebar position.** Impossible through the plugin API (§8); solved with a guarded DOM
   move of our own nodes after render, documented in the file header.
4. **Bug fixed on the way.** `ApiProxy.request(path, false, {})` is the wrong signature
   (2nd arg is `RequestParams`, 3rd `autoLogoutOnAuthError`); now `ApiProxy.request(path)`.
5. **Verified live** on 192.168.122.5 with the alpine-chrome container: sidebar order is
   Map, Workloads, **Storage, Disks (LVM, LVM-Thin), Network**, Gateway (beta), …; LVM page
   shows `kubeos-vg 24.49g / 1.00g free / /dev/vda3 / 4 LVs`; LVM-Thin shows `kubeos-data
   12.25g, 0.5 % data, 10.1 % metadata, chunk 64.00k, 1 volume`, thin volume `pod-data`.
6. **KubeOS side (ISO tree, left uncommitted there).** `kubeos-disks-report` now publishes an
   explicit `lvs` column list that includes `chunk_size` (lvm's default report has no such
   column, which is why the Chunk cell was empty) and compares the report payload instead of
   the timestamp — the old check included `generated`, so it never matched and the ConfigMap
   was rewritten every minute. Deployed to .5 by hand (`tar … --strip-components=2` into `/`)
   and verified: "unchanged; not rewriting the ConfigMap".
7. Tooling: `redeploy.sh` now targets only 192.168.122.5, and `install-dashboard.sh` does a
   `rollout restart` after `helm upgrade` (same image tag ⇒ helm alone leaves the old pod).
8. **Follow-up the same evening (maintainer sent `Whygonetobottom.png`):** Disks was in the
   right place but LVM/LVM-Thin rendered under "Join node". Two React placement effects
   (§8): a remounted Collapse is appended at the end, and Storage's own child list is
   inserted before the *next entry's* node — which was our Disks row, so opening Storage
   nested its PVC list under Disks. The shim now finds child lists by content and re-seats
   Storage's row, Storage's list, our row and our list as one block. Verified by clicking
   through the sidebar (load → Disks → LVM-Thin → Storage → Disks → LVM): every step ends
   with `Storage [PVCs…]` and `Disks [LVM, LVM-Thin]` correctly nested and no page errors.

### Session — 2026-11-10 18:10 → 19:40 (Create: Volume Group / Create: Thinpool)

1. **Request.** "when i click LVM it should show 'Create: Volume Group' beside .. exact below
   global search bar and when user click the button it should ask Disk field and it shows disk
   list and name field and create button for creating vg and same goes to LVM Thin … it should
   show 'Create: Thinpool'". Placement means the **section header's right edge** — that is the
   `SectionBox` `headerProps.actions` slot, i.e. exactly under the global search bar.
2. **UI.** `src/disks.tsx` now gives each page a `SectionBox` whose `actions` holds the
   `Create: Volume Group` / `Create: Thinpool` button, and a MUI `Dialog` each: VG = Disk select +
   Name; thin pool = Volume Group select (`kubeos-vg — 1.00g free of 24.49g`) + Name + optional
   Size. Client-side validation: name `^[A-Za-z0-9][A-Za-z0-9+_.-]{0,126}$`, device
   `^/dev/[a-z]+[a-z0-9]*$`, size `^[0-9]{1,6}(\.[0-9]{1,3})?[mMgGtT]$`; empty size ⇒ `-l 100%FREE`.
3. **How the write actually happens.** The browser cannot run LVM, so the plugin creates a
   one-shot privileged `batch/v1` Job (hostPID, `privileged: true`, hostPath `/`→`/host,
   `nsenter -t 1 -m -u -i -n -p`) using the same helper image as the "Join node" feature, waits
   ≤60 s for it, then deletes it (ttl 600 s as a backstop) and pokes `kubeos-disks-report.service`
   so the ConfigMap is fresh on the next Refresh. Shell script is built as one `set -e` string with
   the validated values only — the dialog text tells the user this runs as root on the node.
4. **Disk list source.** The report ConfigMap could not answer "which disk is empty", so the KubeOS
   side of `kubeos-disks-report` now also publishes `lsblk.json`
   (`lsblk -b -J -e 7 -o NAME,KNAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS`). The select filters to `type:
   disk`, no fstype, no children and not already a PV — after `testvg` was created `/dev/vdb`
   correctly vanished and the dialog said "No free disk on this node…".
5. **Verified end to end on 192.168.122.5** (headless Chrome + real clicks): VG dialog →
   `vgs` = `testvg <10.00g 0 /dev/vdb`; Thinpool dialog → `lvs` = `testpool testvg 9.97g
   twi-a-tz--`; `kubectl -n kubeos-system get jobs` back to "No resources found"; the LVM table
   then listed `testvg` and LVM-Thin listed `testpool`. `kubeos-vg` untouched.
6. **Test traps worth keeping.** In a MUI `Select` dialog the first `input` is a hidden a11y input,
   so type by element **id** (`kubeos-vg-name`, `kubeos-thin-name`, `kubeos-thin-size`) — otherwise
   the text goes nowhere. An unconditional `Escape` at the end of a step closes the whole dialog;
   only press it while `li[role="option"]` is still open.
7. **Left on the node on purpose:** `testvg` on `/dev/vdb` and `testpool` (9.97g) inside it —
   visible proof, removable with `vgremove -f testvg` (remove the pool LV first if LVM objects).
   The spare 10 GiB disk is now consumed; a fresh ISO test will not have it.
   **Correction made right after (19:39):** `vgremove` leaves an orphan PV label on the disk
   (`pvs` still lists `/dev/vdb` with an empty `vg_name`, and `lsblk` then reports
   `fstype: LVM2_member`), so the first filter — "no fstype and not a PV" — declared *no free
   disk* after a delete, and would do the same on any reinstall. `freeDisks()` now excludes a disk
   only when it is a PV **with** a volume group, offers an orphan-PV disk labelled
   `/dev/vdb — 10.00 GiB (old LVM label, wiped)`, and `pvcreate -ff` wipes it before `vgcreate`.
   Re-verified end to end after rebuilding (`create-1..7-*.png`, 19:39): dialog lists the disk,
   `vgs` = `testvg 10.00g`, `lvs` = `testpool testvg 9.97g twi-a-tz--`, `page errors []`.
8. **The Job is not deleted by the plugin** — `ttlSecondsAfterFinished: 600` removes it, so a
   finished `kubeos-lvm-{vg,thin}-*` Job and its Completed pod stay visible for ten minutes. That
   is deliberate-ish: the pod log is the only record of the root commands that ran. If a scoped
   role ever lacks `delete jobs`, nothing breaks.
9. **Final polish pass (19:50).** `sizeText()` also had to `trim()`: lvm pads an exhausted space as
   `"0 "` (see `vgs.json` → `"vg_free":"0 "`), so a full group showed `0 free of 10.00g` and the
   hint read `(0 )`; it now renders `0g` and drops the parenthetical. The thin dialog's VG label and
   size hint went through `sizeText()` too — they were still printing lvm's raw `<10.00g`. Final
   bundle `dist/main.js` 93 914 B, md5 `30ed4af1…`, served copy on the node identical. Everything
   re-verified from a clean disk: `pvremove` → dialog shows `/dev/vdb — 10.00 GiB empty` → create
   `testvg` → create `testpool` → tables correct, `page errors []`.
10. **Committed and pushed (20:20, after the maintainer said "NOW IT IS PERFECT JUST PUSH
   DEVELOPMENT").** `development` = `a30aea1` "feat(disks): Proxmox-style Disks section with LVM,
   LVM-Thin and create dialogs" — `src/disks.tsx`, the one-line import in `src/index.tsx`, the
   rebuilt `dist/main.js` (93 914 B) and this file. `main` untouched at `30d8d26`. The matching
   KubeOS commit is `633771b`/`7cf9f26` on `development` (`skmdab/KubeOS`). The maintainer's own
   screenshot `Whygonetobottom.png` was left untracked in the repo root on purpose.

## 6. Current live state

**2026-11-11 17:41 — a real NFS test rig exists now (builder serves, node mounts).**

- **Builder VM (`192.168.122.2`) is an NFS server**: `nfs-kernel-server` 1:2.8.3-1 installed,
  exporting **`/srv/nfs/kubeos`** to `192.168.122.0/24` with
  `rw,sync,no_subtree_check,no_root_squash` (root squash would stop most Pod images from writing;
  the previous `/etc/exports` is saved as `/etc/exports.kubeos-backup`). `nfs-server` is enabled and
  active, listening on 111 + 2049.
- **Node `192.168.122.5` now has the NFS client** (`nfs-common` 1:2.8.3-1, `/usr/sbin/mount.nfs`).
  How it got there matters: the installed KubeOS has **no plain `trixie main` apt repo** (only
  security/updates/backports + docker/helm/k8s), so `nfs-common` had **no installation candidate**.
  I added `deb https://deb.debian.org/debian/ trixie main` as a temporary
  `/etc/apt/sources.list.d/kubeos-temp-test.list`, installed, then deleted the file again. **A
  reinstall loses it** — the permanent fix is the ISO change already committed on the Platform side.
  `rpcbind` came along as a dependency and is socket-active on 111.
- **Verified at both levels, not just the object level:** OS mount of `192.168.122.2:/srv/nfs/kubeos`
  (negotiated **v4.2**; node wrote a file the builder sees), and a real **Pod** with the exact shape
  the dialog creates (`nfs-vers=4.1` mount options, RWX, Retain, pinned claim): PV/PVC `Bound`, Pod
  `Succeeded`, running as `uid=100(headlamp)`, its file readable on the builder's disk. Test objects
  were then deleted, so the NFS page starts from its empty state.
- Files left on the export as proof: `written-by-builder.txt`, `written-by-node.txt`, `from-pod.txt`.
- **Trap for anyone repeating this:** `mount -t nfs4 <server>:<path>` on the node initially failed with
  `fsconfig() failed: NFS: mount program didn't pass remote address` — that is the message you get when
  `mount.nfs` is **missing**, not a broken server. Check `command -v mount.nfs` first.


**2026-11-11 17:35 — NEW: an "NFS" page inside Headlamp's own Storage section. Deployed and
tested end to end.**

- `kubeos-branding/src/nfs.tsx` (new, imported for its side effect by `index.tsx`). It registers
  `registerSidebarEntry({ parent: 'storage', name: 'kubeos-storage-nfs', label: 'NFS', url:
  '/kubeos-storage/nfs' })` — **`parent: 'storage'` is Headlamp's own Storage group**
  (`frontend/src/components/Sidebar/useSidebarItems.tsx:310`), so NFS appears indented under Storage,
  below Volume Attributes Classes, instead of becoming a second competing storage menu. Route:
  `/c/main/kubeos-storage/nfs`.
- **Why NFS at all:** the KubeOS local-path provisioner makes `hostPath` volumes — node-local, so
  `ReadWriteOnce` only. NFS is the only way to a volume several Pods write at once, and it is the
  Platform change made the same day (`nfs-common` + `/usr/share/kubeos/examples/nfs-static-pv.yaml`).
  The page is the form for that example.
- **What it does:** lists every PV with a `spec.nfs` source (name, `server:path`, capacity, access
  mode, phase, claim, reclaim policy) and "Add NFS volume" creates, in dependency order, the
  StorageClass `nfs-static` (only if absent), the PV, and optionally a PVC **pinned with `volumeName`**
  so the binder cannot pick a different export.
- **Deliberate safety decisions, all documented in the file's header:** the class is never the cluster
  default (`local-path` must stay default so a claim naming no class keeps getting node-local storage);
  `volumeBindingMode: Immediate` (an NFS volume is not node-bound, unlike local-path); reclaim defaults
  to **`Retain`** so a mistyped claim can never delete an export's files; and there is **no delete
  action** on this page — removal belongs on Storage → Persistent Volumes.
- **Verified, not assumed** (headless Chromium + puppeteer): the page renders and the sidebar nests
  correctly; the dialog fills and submits; the result was `StorageClass nfs-static exists · 1 NFS
  volume · 1 bound` with the row `nfs-kubeos-test | 127.0.0.1:/export/kubeos-test | 20Gi |
  ReadWriteMany | Bound | default/nfs-kubeos-test | Retain`; then all test objects were deleted again
  and the node is back to `local-path (default)` + 0 PVs. Screenshots: `nfs-page.png` (empty state),
  `nfs-dialog.png`, `nfs-created.png` (bound).
- **Two tooling facts that cost time:** the `zenika/alpine-chrome:with-puppeteer` image **does** have
  puppeteer, at `/usr/src/app/node_modules` — the earlier `MODULE_NOT_FOUND` was plain module
  resolution, fixed with `-e NODE_PATH=/usr/src/app/node_modules -w /usr/src/app`; and the self-signed
  node certificate must be accepted **at launch** (`acceptInsecureCerts: true` +
  `--ignore-certificate-errors`), because `goto({ignoreHTTPSErrors})` does not cover the first
  navigation and fails with `ERR_CERT_AUTHORITY_INVALID`.
- **Pre-existing defect found, NOT fixed:** `npm run tsc` **fails at `HEAD` (`ed9ea86`)** with two
  errors in `addnode.tsx` (337, 349): `setBundle({ ...info })` where `info` is `{endpoint, caHash}` but
  the state is typed `JoinBundle` (which requires `token`). At runtime it is harmless — the token is
  added later in `generate()` — so it is a stale type, not a bug, but it means the typecheck is not
  usable as a gate. `nfs.tsx` itself typechecks clean. Worth splitting `ClusterInfo` from
  `JoinBundle` in a small follow-up.
- **The console errors on this deployment are Headlamp's, not the page's:** `401 GET
  /clusters/main/me` (no login by design, `unsafeUseServiceAccountToken`) and 404s for API groups that
  do not exist (`gateway.networking.k8s.io`, `scheduling.k8s.io` betas). No request from the NFS page
  failed.


**2026-11-11 16:32 — THE DASHBOARD IS DEPLOYED ON THE REAL NODE AND VERIFIED. `https://192.168.122.5:30443`**

- Node `kubeos` (KubeOS Linux v1.0 Orhan, kernel 6.12.116, k8s v1.37.2, containerd 2.4.2) stays
  `Ready`; **`kubectl get pods -A` shows exactly one pod and it is the dashboard** —
  `kubeos-system/kubeos-dashboard-headlamp-7d7d8f7946-9m525`, `1/1 Running`, `0` restarts, pod IP
  `10.244.0.3`, started 10:58:54Z. The host-native control plane means nothing else is a Pod.
- **Deployed with the repo's own script**, `sh ~/headlamp/_kubeos-dashboard/install-dashboard.sh 192.168.122.5`
  (images → chart+values → namespace + per-machine TLS secret → `helm upgrade --install` → rollout
  → verify), exit 0 in one pass. Nothing was done by hand except the two RBAC notes below.
- **Proof it is really the current code, not a stale image:** `GET /plugins/kubeos-branding/main.js`
  returns **93,914 bytes** whose sha256 is `b1f76115a8c12cb8fec46e46680921942969e7c83c5f485b7bdabf5b5bda3062`,
  byte-identical to `npm run build` of `HEAD` (`ed9ea86`) — `cmp` clean. `GET /` → **200**, 4618 bytes;
  `/plugins/kubeos-branding/package.json` → 200.
- **Visually verified** (headless Chromium, `dashboard.png` in this folder): MVZ-style **MFZ KUBEOS**
  logo in lime, lime section highlight, the **Disks** section and **Join node** in the sidebar, and
  real numbers on the rings (CPU 0.15/2, Memory 1.00/1.93 GB, Pods 1/1, Nodes 1/1 Ready) — so
  **metrics-server is being read through the dashboard too**. `<title>` is still "Headlamp" in the
  served HTML by design; the plugin rewrites it in the browser.
- TLS is the per-machine self-signed cert minted on the node (`CN=kubeos-dashboard`, 825 days,
  `notBefore Nov 11 10:58:52 2026`), as the values file requires. Browser warning expected.
- **Two RBAC facts established here, both now written into `CLI_REQUIREMENTS.md` and `README.md`:**
  1. **The chart creates `kubeos-dashboard-headlamp-admin` itself** (`clusterRoleBinding.create`
     defaults to `true`, `clusterRoleName` defaults to `cluster-admin`). A hand-run
     `kubectl create clusterrolebinding …` therefore failed with "already exists", and
     `kubectl auth can-i list pods --as=system:serviceaccount:kubeos-system:kubeos-dashboard-headlamp`
     answered `yes` with no manual step. The old README instruction (and CLI requirement) was wrong.
  2. **`kubectl logs`/`exec` were Forbidden** — `nodes/proxy` for
     `user=kube-apiserver-kubelet-client`. The node's `apiserver-kubelet-client.crt` has **no
     organization**, so it is in no group; a throwaway `/tmp` probe proved **kubeadm v1.37.2 mints it
     that way itself**, and `kubeadm init` (which the native path never runs) is what normally ships
     the binding. Fixed on the node by hand for testing:
     `kubectl create clusterrolebinding kubeos:apiserver-kubelet-client --clusterrole=system:kubelet-api-admin --user=kube-apiserver-kubelet-client`
     — after it `exec` printed `EXEC-WORKS` and `logs` returned the headlamp JSON log lines.
     **This is a KubeOS bug, not a dashboard bug** (`grep -rn 'nodes/proxy' config/` in the ISO tree
     → nothing), and the exact object to add is in `CLI_REQUIREMENTS.md`.
- **Node access works again:** SSH as `root@192.168.122.5` with `~/headlamp/_kubeos-dashboard/.vm_key`
  (the user added the key at the console at 16:28). Both that key and `~/.ssh/id_ed25519` had been
  refused before — a fresh install has no `authorized_keys`, the documented gap.
- **OBSERVED 2026-11-11 17:06, after a node reboot: the dashboard container restarted once**
  (`RESTARTS 1`). The node was busy booting — systemd units, the storage service and a test pod all
  starting together — and the chart's **liveness** probe killed the container before its HTTPS server
  answered. Nothing is broken, but this will look like a crash-loop to whoever watches the Pod page,
  and the fix belongs in `deploy/values.yaml` when the dashboard ships in the ISO: raise
  `livenessProbe.initialDelaySeconds` (or `failureThreshold`) so a cold, loaded boot cannot kill it.
- **Screenshots:** the `zenika/alpine-chrome:with-puppeteer` image has **no `puppeteer` module
  installed** (`MODULE_NOT_FOUND`), so the node-script recipe in §4 does **not** work; the entrypoint
  is `tini --` and the binary is `/usr/bin/chromium-browser`. What works:
  `docker run --rm --network host -v "$PWD":/shots zenika/alpine-chrome:with-puppeteer /usr/bin/chromium-browser --headless --no-sandbox --disable-gpu --disable-dev-shm-usage --ignore-certificate-errors --hide-scrollbars --window-size=1600,1000 --virtual-time-budget=25000 --screenshot=/shots/dashboard.png https://192.168.122.5:30443/`
  (harmless `ERROR: No matching issuer found` on stderr; the PNG is still written).

**2026-11-11 16:20 (superseded by the block above) — nothing was deployed then, and the reason was access, not code:**

- **The dashboard image is ALREADY current and needs no rebuild.** `main.js` inside
  `ghcr.io/skmdab/headlamp:kubeos-0.1.0` has sha256
  `b1f76115a8c12cb8fec46e46680921942969e7c83c5f485b7bdabf5b5bda3062`, and a fresh
  `npm run build` of `HEAD` (`ed9ea86`) produces **exactly that hash** — image, plugin bundle and
  committed source agree. (Before touching the image, check this hash; a rebuild that cannot change
  the output is 20 minutes of noise.)
- **The plugin now builds on the host** (see §4): `node v26.13.0` / `pnpm 12.16.1` / `docker 26.1.5`,
  `node_modules` present, and the build leaves `git status` clean. **The builder VM is optional from
  now on, not required.**
- **Builder VM synced to `ed9ea86`** and clean, so §4's "keep both in sync" holds. It was on
  `df5b4fa` with 4 modified files + 1 untracked. Before resetting, every differing file was diffed
  against host `HEAD`: `addnode.tsx` was byte-identical, `index.tsx`/`CLI_REQUIREMENTS.md` were
  strictly older (0 builder-only lines vs 3 and 60 host-only), and the builder's only unique content
  was 7 lines of its own older session-B `MEMORY.md` text plus 10 lines of a stale `dist/main.js`
  build. Nothing was lost; its former state is kept as a **stash** on the builder
  (`git stash list` → "builder state before sync to host ed9ea86").
- **Artifacts staged in `stage/`** (`~/headlamp/_kubeos-dashboard/stage/`): `kubeos-dashboard.tar.gz`
  (112 MB, `docker save` of today's image) and `headlamp-0.46.0.tgz` (44 K, 118 entries, chart
  `0.46.0`/`appVersion 0.46.0`). The **old** `../headlamp-0.46.0.tgz` from 2026-11-08 is **empty
  garbage** (`tar tzf` → 0 entries) — do not reuse it.
- **Node `192.168.122.5` refuses BOTH keys** (`~/headlamp/_kubeos-dashboard/.vm_key` and
  `~/.ssh/id_ed25519`): `Permission denied (publickey,password)`. Its API answers on `:6443`
  (`403`, i.e. alive), `:30443` refuses (`000`, nothing deployed). Cause is the known fresh-install
  gap — nothing in the ISO creates `/root/.ssh/authorized_keys` — not PermitRootLogin (Debian
  defaults to `prohibit-password`, which allows keys).
- **`~/headlamp/_kubeos-dashboard/admin.conf` is useless here:** it points at the **old** `.4` node
  and carries that install's CA (`notBefore Nov 7 2026`), while `.5` minted a brand-new PKI at its own
  first boot. Do not try to reach `.5` with it.
- **The deploy tooling already exists and is idempotent** — `redeploy.sh` (build → image → `ctr import`
  on every node → `install-dashboard.sh`) and `install-dashboard.sh` (both images, chart + values,
  namespace + per-machine TLS cert, `helm upgrade --install`, rollout restart, verify). `install-dashboard.sh`
  **mints `kubeos-system/kubeos-dashboard-tls` itself** with `openssl` on the node, which is why the
  ISO not doing it has not blocked testing — but that is a manual workaround under this repo's §6 and
  stays listed in `CLI_REQUIREMENTS.md`.
- **Gap to expect on a fresh node:** `install-dashboard.sh` creates the namespace, the TLS secret and
  the release, but **not** the service-account binding, so the UI loads with empty lists behind 403s
  until `kubectl create clusterrolebinding kubeos-dashboard-headlamp-admin …` runs. That is
  `CLI_REQUIREMENTS.md` item "Dashboard service account has no permissions on a fresh install" —
  it is the CLI's job, and running it by hand here is the §6 temporary workaround.
- **`libvirtd` is wedged on the host** after `virsh dumpxml kubeos` hung this session: `virsh list`
  still answers, but `domstate`/`dumpxml` return nothing. The console route into the node is therefore
  closed until `sudo systemctl restart libvirtd`. Do not hammer it; one stuck `virsh` per keystroke is
  what wedges it (lessons log, 2026-11-09).

**2026-11-08 18:10 — fresh ISO install + hand-deployed dashboard (session C; supersedes the block
below):**

- `192.168.122.4` runs the **new KubeOS ISO** (kernel 6.12.115, k8s v1.37.2, containerd 2.4.2);
  first boot completed 18:01:16Z; node Ready, untainted, **12/12 pods Running**; pod CIDR
  `10.244.0.0/16` (auto-chosen, no LAN overlap).
- `https://192.168.122.4:30443` → **200**; pod `kubeos-system/kubeos-dashboard-headlamp` 1/1
  Running; `/headlamp/plugins/kubeos-branding/{main.js,package.json}` → 200. The `<title>` in the
  served HTML still says "Headlamp" — the plugin rewrites it in the browser, as designed.
- `v1beta1.metrics.k8s.io` → **Available True**, `kubectl top nodes` has data, so the Overview rings
  show real percentages. **CLI item 1 (metrics-server) is closed.**
- **Storage does not work on this install**: `local-path (default)` exists and the provisioner is
  1/1 Running, but every claim stays `Pending` (`configuration error, no node was specified`) because
  the class ships `volumeBindingMode: Immediate`. CLI item 4. Storage pages will look empty.
- No login prompt; the chart's own default binding is `cluster-admin`, so **anyone who can reach
  30443 is cluster-admin**. Scoping it down is still open (§7 item 2).
- The second node `kubeos2` from session B no longer exists — both KVM guests were reinstalled to
  test this ISO.

<details><summary>previous live state (2026-11-08, session B — two-node, older image set)</summary>

## 6. Previous live state (verified 2026-11-08 by session B)

- `https://192.168.122.4:30443` → **200**; pod `kubeos-dashboard-headlamp-…` 1/1
  Running; plugin bundle served from `/headlamp/plugins/kubeos-branding/`.
- `v1beta1.metrics.k8s.io` → **Available True**; `kubectl top nodes` returns a row.
- **Two nodes** as of 2026-11-08: `kubeos` (control-plane, untainted, schedulable) and
  `kubeos2` (worker, joined by hand — not something a fresh install does). Calico pool
  `10.244.0.0/16`, IPIP `Always`. No `kubeos` CLI binary on either node — only the
  `kubeos-cluster-setup` unit and `/usr/bin/kubeos-cluster-{init,ready}`.
- Overview: all four rings lime with real percentages.
- No login prompt: the server authenticates as its own SA. This is a **development
  shortcut** — anyone who can reach `:30443` is cluster-admin without typing anything.
  Scoping that down is unsolved (§7).

</details>

## 7. Open items (do these before this ships in an ISO)

1. **Storage section shows no data** — investigated and answered: the cluster has zero
   PVCs, PVs, StorageClasses and CSI drivers, and the dashboard's SA gets HTTP 200 with
   `items: []`, so the empty pages are honest. A test PVC stayed `Pending` with
   `FailedBinding: no persistent volumes available for this claim and no storage class
   is set`, i.e. there is no provisioner and no default class. Now item 4 in
   `CLI_REQUIREMENTS.md`; the fix (pinned local-path provisioner + default
   StorageClass) belongs to the KubeOS side as a handoff, not a hand-install.
2. **Auth is the real gap.** Replace the hand-made `clusterrolebinding
   kubeos-dashboard-headlamp-admin` → `cluster-admin` with a read-mostly scoped
   ClusterRole, and decide how a user authenticates (short-lived token printed at first
   boot is the earlier preference). Remove the dev leftovers: the `kubeos-dashboard` SA
   and its `kubeos-dashboard-token` secret (a cluster-admin token sitting in a Secret),
   and the `kubeos-dashboard-admin` binding.
3. **Dashboard install is not automated** — no namespace, release, TLS secret or
   side-loaded image on a fresh install (item 3 in `CLI_REQUIREMENTS.md`).
4. **metrics-server — ✅ closed 2026-11-08**: verified on a fresh install of the rebuilt ISO
   (`v1beta1.metrics.k8s.io` Available True, `kubectl top nodes` returns data, baked `v0.8.0`).
   Remains in `CLI_REQUIREMENTS.md` only until that file is next tidied.
5. **Smaller, unstarted polish:** the `Only warnings` toggle is Headlamp green rather
   than lime; the `100.0 %` label sits slightly high in the rings; the ring's remaining
   track is `rgba(20,20,20,0.1)` and invisible on the dark page (a faint lime track was
   previewed and **not** committed).
6. **Cleanup of test leftovers:** host containers `kubeos-dash-local` and
   `kubeos-dashboard-test`; on the node `/root/kubeos-dashboard.tar.gz`, `/root/chart`,
   `/root/manifests.yaml`, `/root/values*.yaml`, `/root/tls.*`.
7. **Multi-node / "add node"** — the dashboard has no add-node action (Headlamp offers
   cordon/drain/delete/edit, and Kubernetes has no create-node API). A second node was
   joined **by hand** and works (see §5.7), so the cluster supports it; what is missing
   is KubeOS automation: every install still runs `kubeos-cluster-init`, and there is no
   `kubeos join`. Logged as CLI requirement 5. Dashboard-side work that *is* buildable:
   a "Join a node" panel in our plugin that prints a fresh
   `kubeadm token create --print-join-command` and lists/approves pending CSRs.
   Hypervisor-style VM provisioning stays out of scope by §5.
8. **"Add node" panel in the dashboard — an N-node feature, not a two-node one.** The
   maintainer's requirement (2026-11-08): the join action must live in the dashboard and
   stay available for every further node. Verified as buildable: the plugin API has
   `registerRoute` + `registerSidebarEntry`, and the join command can be assembled
   entirely from in-cluster data — a bootstrap token created through the API plus the CA
   hash, which was computed from `kube-public/cluster-info` and matched kubeadm's own
   `sha256:a21c9d4c…` byte for byte. Needs RBAC beyond reading: create/list secrets in
   `kube-system`, get configmaps in `kube-public`, list/approve CSRs. Today's
   cluster-admin covers it; the scoped role in item 2 must include it. Not built yet.
9. **Accepted limitations** (decided, not bugs): About/version text still says
   Headlamp (only a frontend rebuild changes it, which would break the one-layer
   promise); the theme seeds itself with one reload on a browser's very first visit;
   the CLI's 16-colour console palette is deliberately *not* mapped to ANSI (index 7 is
   the panel background, so copying it would make `\e[30m` render light).
10. **The create path is the dashboard's only write action — and it runs as root on the node**
   (LVM create via a privileged one-shot Job, see §5 2026-11-10 19:40). Item 2's scoped
   ClusterRole therefore cannot be read-only: it needs `create jobs` (+ `delete` for cleanup)
   in `kubeos-system`, and the namespace must keep allowing privileged pods (no PodSecurity
   `restricted` label). Decide deliberately whether that is acceptable for the product, or gate
   it behind an explicit "storage admin" role/token. Nothing else in the plugin writes.

## 8. Headlamp internals worth remembering

- A plugin is a folder under `-plugins-dir` with `package.json` + `main.js`; the backend
  serves `/plugins/<name>/{main.js,package.json}` and the frontend fetches both, so a
  non-644 manifest is a silent 403 and a dead plugin.
- `registerAppTheme` cannot set `chartStyles`, `success`, `error` or `warning`; those
  live in `createMuiTheme`. The only levers are scoped CSS rules keyed on what Headlamp
  actually painted.
- The dark branch hardcodes `MuiLink` `#6CB6F2`, overriding `AppTheme.link.color`.
- `sidebar.selectedColor` ≠ the text colour of a lime selected row. Top-level selected
  rows fill with `selectedBackground` and take `getContrastText(selectedBackground)`;
  `selectedColor` is only for a nested selected row's label and 4px marker bar, drawn on
  the sidebar background with no fill. Treat `AppTheme` token names with suspicion;
  read `frontend/src/components/Sidebar/ListItemLink.tsx` before changing one.
- Status labels are **not** MUI Chips — they are `MuiBox`/`MuiTypography` boxes with
  emotion hashes, so locate them by text/aria-label, not by class.
- Theme preference is `localStorage.headlampThemePreference`; sessions for token login
  are cookies with `sessionTTL` (86400 s here).
- Chart probes default to HTTP; with TLS on, `probes.scheme: HTTPS` is mandatory.
- `pluginsManager` must stay disabled: it needs internet at runtime and would empty-dir
  over `/headlamp/plugins`, hiding the baked-in plugin.
- **A plugin cannot choose its sidebar position.** `registerSidebarEntry` has no
  index/priority option and `useSidebarItems.tsx` *pushes* every custom entry onto the
  end of the in-cluster list; `registerSidebarEntryFilter` runs per item, so it can drop
  or modify entries but never reorder them. `settings.sidebarSortAlphabetically` re-sorts
  by label and would put Storage last, so it is not a lever either. KubeOS wants Disks
  between Storage and Network (Proxmox order), so `src/disks.tsx` moves its own nodes in
  the DOM after render (guarded, idempotent, no-op if the markup changes).
- The sidebar DOM for one top-level entry is `<li><a href=…>…</a></li>`, and the open
  group's child list is a separate `<li>` (a `MuiCollapse` with no direct `<a>` child). A
  group with no `url` links to its **first child**, so Storage's anchor is
  `/c/main/storage/persistentvolumeclaims`, not `/c/main/storage` — matching on
  `href$="/storage"` finds nothing. A parent entry is `isSelected` (and therefore
  expanded) whenever one of its children is the current route (`getIsSelected` recurses).
- **Where React puts that child list is the hard part.** A freshly mounted Collapse is
  inserted with a null reference (`insertBefore(node, null)`), so it appears at the END of
  the sidebar; and when it *does* find a next sibling, React uses the **next entry's DOM
  node** as the reference, so anything a shim squeezed between two entries steals the
  child list of the entry above it (Storage's PVC list appeared nested under Disks).
  Consequences for any DOM reordering: locate child lists by *content*, never by position,
  and re-seat the neighbouring blocks **together** (Storage row, Storage list, Disks row,
  Disks list) instead of moving one node at a time. Reloading a URL hides both bugs;
  verifying by *clicking* the sidebar exposes them.
- **Top-bar actions**: `registerAppBarAction(Component)` drops a component into Headlamp's
  own top bar; `TopBar` is mounted at `components/App/Layout.tsx:349` inside `AppContainer`'s
  `BrowserRouter`/`HashRouter`, so router hooks (`useHistory`, links) are legal there.
- **`?view=exec&container=<c>` is a trap on v0.46.0.** The deep link crashes the Pod page
  ("Uh-oh! Something went wrong.") with React #185, *maximum update depth exceeded*:
  `PodDetails` auto-launches the terminal from a `useEffect` guarded by a `useRef`, the
  `Activity` takes over the screen, the route remounts, the ref is fresh again, and it
  launches for ever. The same terminal from the Pod page's own "Terminal / Exec" button
  works, which is what isolates it to that effect. Launch an `Activity` yourself instead.
- **What a plugin can and cannot import from the library**: `Activity` and `K8s` are
  exported from the package root; **`Terminal` is not** — reach it as
  `CommonComponents.Terminal` (props `{item: Pod, isAttach?, noDialog?, onClose?}`, and
  `noDialog` is what makes it render inline inside an activity).
- **`@mui/icons-material` cannot be used in a plugin at all.** The icons call
  `createSvgIcon` from `@mui/material/utils`, and the plugin loader externalises
  `@mui/material` to `pluginLib.MuiMaterial` without a `utils` submodule, so the bundle
  throws `Cannot read properties of undefined (reading 'createSvgIcon')` while registering
  — and the failure takes the **whole plugin** with it (every KubeOS page and every custom
  sidebar entry silently disappears; the only sign is one console error). Text labels or
  inline `<svg>`, never MUI icons.

## 9. Mistakes made before, don't repeat

- Mirroring `main` on every commit "to keep them identical" — the maintainer wanted
  `development` only. Read `AGENTS.md` §3 before every push.
- Rewriting `CLI_REQUIREMENTS.md` to point at the ISO repo. That file records what the
  dashboard needs; the KubeOS side owns its own tree. Handoffs go to chat in the §11
  format, and handoff prompts must stay short and paste-ready (a long version confused
  the maintainer twice).
- Treating a browser-automation failure as a dashboard bug. Earlier "in-cluster"
  screenshots were really a local instance because the script typed the token into the
  navbar Search box. The working recipe: the field with `id="token"` (a password input)
  plus `page.keyboard.type()`.
- Assuming the sandbox `/tmp` persists between commands — it does not; scratch files
  must live inside the workspace.

## 10. Where the non-repo material lives

- `/home/shaik/headlamp/_kubeos-dashboard/` — SSH key, kubeconfig, dashboard token,
  helper scripts, screenshot tooling, preview PNGs, `DOCKER_CONFIG`.
- `/home/shaik/headlamp` — upstream Headlamp clone (source of truth for behaviour).
- `/home/shaik/KubeOS` — the KubeOS ISO/CLI tree. **Never edited from this project**;
  work needed there is handed over as a prompt (AGENTS.md §11).

**2026-11-11 17:44 — "where is the mountpoint?" answered on the live node.** The NFS volume
`nfs-kubeos` (2Gi, RWX, `nfs-static`) is `Bound` to claim `default/nfs-kubeos`, but **nothing was
mounted anywhere** until a Pod consumed the claim: an NFS PV is mounted *inside the Pod*, never on the
node's own filesystem, so `ls` on the node finds nothing. A helper Pod **`default/nfs-explorer`** was
started (image `ghcr.io/skmdab/headlamp:kubeos-0.1.0`, which is already on the node and has `/bin/sh`,
mounted at `/data`, `sleep infinity`) so the contents can be browsed from the dashboard's pod
**Terminal** or with `kubectl exec`. It mounted as `vers=4.1` — the class's pinned mount options — and
showed the three proof files; the same directory on the builder (`/srv/nfs/kubeos`) lists them too.
Delete it with `kubectl delete pod nfs-explorer` when done. Worth remembering for the product: Headlamp
has no file browser, so browsing a volume means a Pod plus exec — a "Browse volume" action on the NFS
page (running `ls` through exec) would be a real feature, not a workaround.

**2026-11-11 17:52 — unmount actions added to the NFS page (user: "if i wanted to unmount from dashboard?").**
Each row now has two buttons, and neither can delete files on the export (the Kubernetes API has no
such operation for NFS):
- **Detach** — releases the claim (`DELETE .../persistentvolumeclaims/<name>`). It **refuses while a
  Pod mounts that claim** and names the Pod(s) — measured: "Still mounted by default/nfs-explorer
  (Running)", submit disabled, because releasing a claim under a running Pod leaves it mounting a
  volume that no longer exists for it.
- **Remove** — deletes the PV object and requires the volume name typed out. Blocked while a claim
  still exists.
- **Bug found by testing, and it is the interesting one:** after a detach, the PV keeps
  `spec.claimRef` (that is normal for a released PV), so my first version treated "claimRef set" as
  "claim exists" and **blocked Remove on an already-released volume for ever**. Fixed by resolving
  claim existence from one extra `GET /api/v1/persistentvolumeclaims` per load; the row now reads
  `default/x (released)` and Detach is disabled when the claim is gone (`claimExists` on `NfsVolume`).
- Verified end to end through the UI on a throwaway volume (`nfs-removetest`): guard blocked the
  in-use volume, Detach released the idle one, Remove deleted the PV — and afterwards
  `ls /srv/nfs/kubeos` on the builder still showed all three files. Screenshots: `nfs-actions.png`,
  `nfs-detach-blocked.png`, `nfs-remove-confirm.png`, `nfs-after-remove.png`.
- The user's own volume `nfs-kubeos` was deliberately left untouched (still `Bound`), and the helper
  Pod **`default/nfs-explorer` is still running and still mounts it** — so Detach on it stays blocked
  until that Pod is deleted.

### Session 2026-11-11 (evening) — top-bar node controls: Restart, Power off, Shell

User: *"i want add restart poweroff and shell buttons for node on top right side"*. New file
`kubeos-branding/src/nodeactions.tsx` (~490 lines) + `import "./nodeactions";` in `index.tsx`;
`registerAppBarAction` appends to Headlamp's own top bar (rendered inside the router, see §8).
Measured header order: `Restart`, `Power off` (amber), `Shell`.

- **Restart / Power off** create a one-shot privileged Pod in `kubeos-system`
  (`nodeSelector` on the hostname, `hostPID`, host `/` at `/host`, image
  `ghcr.io/skmdab/kubeos-join-helper:0.1.0`) that runs
  `nsenter -t 1 -m -u -i -n -p -- /usr/bin/systemctl reboot|poweroff` with
  `chroot /host /usr/bin/systemctl …` as fallback, writing
  `/var/lib/kubeos/.kubeos-<action>-$POD_NAME` before the request. **Bare Pod with
  `restartPolicy: Never`, not a Job** — a Job is re-created after the node dies and would
  reboot for ever. Power off needs the node name typed; Restart is a plain confirm.
- **Shell** ensures `kubeos-node-shell` (privileged, `hostPID`, `/host`,
  `activeDeadlineSeconds: 3600`, deleted on terminal close) and opens a full-screen
  `Activity` with `CommonComponents.Terminal`, plus a hint line naming the `nsenter`
  command for the host.
- **Verified end to end with puppeteer** (`_kubeos-dashboard/node-actions-test.js`):
  header shows all three buttons; the Power off confirm stays disabled with no name and
  with a wrong name; the Shell terminal accepted
  `echo KUBEOS-SHELL-OK && hostname && head -1 /host/etc/hostname` and printed
  `KUBEOS-SHELL-OK` / `kubeos-node-shell` / `kubeos` (so `/host` really is the node);
  0 page errors. The Pod spec was read back from the API:
  `activeDeadlineSeconds=3600 restart=Always privileged=true` with the join-helper image.
- **The shutdown mechanism was proven without rebooting** using a probe Pod with the
  identical spec but the read-only verb `systemctl is-system-running`: `nsenter` → `running`,
  `chroot /host` → `running`, host `uptime` readable, `/var/lib/kubeos` writable. The
  literal `reboot`/`poweroff` verb is still unexercised — offered to the user, and it costs
  one click.
- No RBAC was added: the chart already binds the dashboard SA to `cluster-admin`
  (`kubeos-dashboard-headlamp-admin`).
- Deployed with `_kubeos-dashboard/redeploy.sh` (plugin build → image → containerd import →
  `helm upgrade`); bundle `dist/main.js` 119,621 B, sha256 `730c3ab1…`.

- **`systemctl restart` is not "restart the machine".** The node-actions Restart button built its
  command as `systemctl ${action}` while the action was called `restart` in the UI, so the Pod ran
  `systemctl restart` with no unit, printed `Too few arguments.` twice (nsenter attempt + chroot
  fallback) and exited 2 — and the node stayed up, which looks exactly like a button that "does
  nothing". The systemd verb for a machine reboot is **`reboot`**; `restart` takes a unit. The fix is
  an explicit `action === "restart" ? "reboot" : "poweroff"`, but the lesson is broader: the
  read-only mechanism probe (`systemctl is-system-running`) passes in both worlds and could never
  catch a wrong verb, so **every privileged action needs one real end-to-end firing** before it is
  called done. Measured after the fix: confirm → node down in 7 s → kernel start → `Ready=True`
  ~10 s after kernel start, 9/9 units active, dashboard back on 200, and the action Pod went
  `Unknown` and was never re-created (the reason it is a bare `restartPolicy: Never` Pod, not a Job).

- **A disabled field looks like a broken field.** The NFS page's *Remove volume* dialog rendered
  `Type <name> to confirm` with `disabled={claimBlocksRemoval}` while a claim still pointed at the PV.
  The rule was right (removal is refused anyway) but the user clicked, nothing happened, and reported
  "the insert fields are not editable" with a screenshot. Fixed 2026-11-11: when the action is blocked
  the field is not rendered; the dialog explains why and offers **Detach claim instead**, which swaps
  the same dialog to the Detach flow. Rule to keep: **never render a control that can never be used** —
  say why and put the unblocking action next to it. Verification detail worth keeping: the NFS table is
  a div grid (no `<tr>`), so a browser test locates a row by the innermost `div` that carries the
  volume name and exactly two buttons.
