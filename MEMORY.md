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

### Next session — start here

Copy this block when beginning: confirm branch + sync on both machines, read §7 open
items, then ask. The most likely next piece of work is the auth scoping (open item 2)
or whatever the maintainer reports after clicking around.

## 6. Current live state (verified 2026-11-08 by this session)

- `https://192.168.122.4:30443` → **200**; pod `kubeos-dashboard-headlamp-…` 1/1
  Running; plugin bundle served from `/headlamp/plugins/kubeos-branding/`.
- `v1beta1.metrics.k8s.io` → **Available True**; `kubectl top nodes` returns a row.
- Overview: all four rings lime with real percentages.
- No login prompt: the server authenticates as its own SA. This is a **development
  shortcut** — anyone who can reach `:30443` is cluster-admin without typing anything.
  Scoping that down is unsolved (§7).

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
4. **metrics-server** — handed to the KubeOS workspace and reported accepted; still
   listed in `CLI_REQUIREMENTS.md` until a rebuilt ISO is verified.
5. **Smaller, unstarted polish:** the `Only warnings` toggle is Headlamp green rather
   than lime; the `100.0 %` label sits slightly high in the rings; the ring's remaining
   track is `rgba(20,20,20,0.1)` and invisible on the dark page (a faint lime track was
   previewed and **not** committed).
6. **Cleanup of test leftovers:** host containers `kubeos-dash-local` and
   `kubeos-dashboard-test`; on the node `/root/kubeos-dashboard.tar.gz`, `/root/chart`,
   `/root/manifests.yaml`, `/root/values*.yaml`, `/root/tls.*`.
7. **Accepted limitations** (decided, not bugs): About/version text still says
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
