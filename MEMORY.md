# MEMORY.md — working memory for the KubeOS dashboard project

Written to be read at the start of a session, after `AGENTS.md`. It is the durable
record of decisions, machine facts and history so no session has to rediscover them.

Last updated: 2026-11-08 (session B, this one). Started from the transcript of session
`session-956734de-8e0e-4798-8bee-5f8bcf2eabd5` (42 turns, 469 steps) and has been
kept current by hand ever since.

No secrets here by design: no tokens, no private keys. See §10 for where those live.

---

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

| Machine | Address | Facts |
|---|---|---|
| Host (this box) | — | docker works (`docker version` succeeds). No `kubectl`, no `helm`. |
| Builder VM | `root@192.168.122.2` | Debian 13.7, node 20.19.2 / npm 9.2.0, git + GitHub SSH as `skmdab`, no docker. Authoritative git working tree at `/root/kubeos-dashboard`. |
| KubeOS node | `root@192.168.122.4` | KubeOS Linux v1.0 "Orhan", k8s v1.37.2, containerd 2.4.2, `helm` present, no docker, 2 vCPU / 1.9 GiB. Calico + CoreDNS running. |
| KubeOS node 2 | `root@192.168.122.5` | Second KubeOS install (2026-11-08), hostname `kubeos2`, joined to `main` **by hand** as a worker. Same ISO/image set. Reached with the same `.vm_key`. |

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

```sh
# 1. edit plugin source, then build on the builder VM (host has no toolchain wired up)
./vm.sh 'cd /root/kubeos-dashboard/kubeos-branding && npm run build'

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

Live dashboard: **https://192.168.122.4:30443** (NodePort, self-signed cert →
browser warning expected). No login prompt (see §6).

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

### Next session — start here

Copy this block when beginning: confirm branch + sync on both machines, read §7 open
items, then ask. The most likely next piece of work is the auth scoping (open item 2)
or whatever the maintainer reports after clicking around.

## 6. Current live state

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
