# KubeOS Dashboard

The web dashboard for **KubeOS**, built on [Headlamp](https://headlamp.dev/).

This repository holds only the KubeOS-specific layer:

| Path | What it is |
|---|---|
| `kubeos-branding/` | Headlamp plugin: the KubeOS theme, logo, page title and favicon |
| `image/Dockerfile` | one-layer image on the official Headlamp image |
| `deploy/values.yaml` | Helm values: NodePort 30443, TLS, plugin manager off |

Nothing here modifies Headlamp itself. The upstream image, binary and frontend
bundle are used exactly as published.

## Branches

`development` is the default branch and the only branch that receives work. `main`
is a release mirror, updated only when its maintainer asks for it by fast-forwarding
it to `development`. Nothing is committed to `main` directly and nothing is pushed to
it automatically. See `AGENTS.md`.

## Attribution

Based on Headlamp, Copyright The Kubernetes Authors, Apache-2.0. Headlamp is a
CNCF sandbox project; KubeOS is not affiliated with or endorsed by CNCF, the
Kubernetes project, or the Headlamp maintainers. See `NOTICE`.

## Versions that must move together

| Component | Pinned to | Why |
|---|---|---|
| Headlamp image | `v0.46.0` | `ARG HEADLAMP_VERSION` in `image/Dockerfile` |
| Helm chart | `0.46.0` | `--version` on `helm upgrade`; chart default image tag is derived from `appVersion` |
| Plugin SDK | `@kinvolk/headlamp-plugin` `^0.14.0` | the release paired with Headlamp 0.46 |

Bump them in one commit, then re-check that the theme still applies.

## Build

```sh
cd kubeos-branding
npm install
npm run build            # -> kubeos-branding/dist/{main.js,package.json}

cd ..
docker build -f image/Dockerfile -t ghcr.io/skmdab/headlamp:kubeos-0.1.0 .
```

The plugin bundle is built once and committed, because the machine that builds
the ISO has no Node toolchain.

## Deploy as a binary (systemd, no container)

The dashboard also ships as a **host service**: a static `headlamp-server` binary, the
built frontend, the KubeOS plugin, a systemd unit and an installer - no container runtime,
no Pod. This is the form KubeOS itself uses, because the node runs its control plane as
host services and keeps no base Pods.

```sh
cd kubeos-branding && npm run build && cd -   # rebuild the plugin (it is committed)
deploy/binary/build-binary.sh                 # -> release/kubeos-dashboard-<v>-linux-amd64.tar.gz
```

On the node:

```sh
tar -xzf kubeos-dashboard-0.1.0-linux-amd64.tar.gz && cd kubeos-dashboard-0.1.0-linux-amd64
./install.sh --kubeconfig /etc/kubernetes/admin.conf
```

`build-binary.sh` needs only tar and sha256sum, and **no network**: the two pieces it
assembles - the static `headlamp-server` and the built frontend - are vendored in
[`vendor/headlamp/`](vendor/README.md), verified against their image layer digests on every
build. So a clone of this repository produces a deployable dashboard with no docker, no Go,
no Node and no registry account. Upstream publishes no standalone server binary, and
compiling Headlamp needs Go 1.26, so reusing the released binary keeps us on upstream's exact
build; vendoring it keeps that from turning into a dependency on `ghcr.io`. Upstream's
`LICENSE` and `NOTICE` travel in the tarball, since it redistributes upstream's binary.

Two things the installer handles that are easy to get wrong:

- **The cluster id is the kubeconfig context name.** Headlamp builds every URL as
  `/c/<context>/...`, so the installer renames the context in its *copy* of the kubeconfig
  to `main` - the same id the in-cluster deployment used, so existing links keep working.
- **`--app-name=KubeOS`** comes from the backend flag, so the page title carries the KubeOS
  name without the DOM rewriting the plugin used to do.

Everything else lives in [`deploy/binary/README.md`](deploy/binary/README.md): layout,
options (`--port`, `--san`, `--tls-cert/--tls-key`), the shared-identity model, and the
unit's hardening.

## Install

```sh
helm upgrade --install kubeos-dashboard headlamp \
  --repo https://headlamp-k8s.github.io/headlamp/ \
  --version 0.46.0 \
  --namespace kubeos-system --create-namespace \
  -f deploy/values.yaml
```

Then open `https://<node-ip>:30443`.

## Cluster usage metrics

The CPU and memory cards need the `metrics.k8s.io` API, which Kubernetes does not
provide by itself. Without a metrics server they quietly show capacity instead of
usage. See `deploy/metrics-server/` for the pinned metrics-server, why it needs
`--kubelet-insecure-tls` on KubeOS, and how to side-load the image offline:

```sh
kubectl apply -f deploy/metrics-server/components.yaml
```

## Node controls (top bar)

Three buttons sit in Headlamp's top bar, left of the settings and user icons:
**Restart**, **Power off** and **Shell**. They act on the node, not on a resource, so
they are reachable from every page.

A dashboard Pod cannot touch the host's systemd, so each control creates a short-lived
**privileged Pod** in `kubeos-system` — pinned to the node by `nodeSelector`, `hostPID`,
the host's `/` mounted at `/host`, image `ghcr.io/skmdab/kubeos-join-helper:0.1.0`
(already on every KubeOS node, so this works offline) — and that Pod asks the host's own
systemd:

```sh
nsenter -t 1 -m -u -i -n -p -- /usr/bin/systemctl reboot    # or poweroff
chroot /host /usr/bin/systemctl reboot                      # fallback
```

Safety, deliberately chosen:

- **A bare Pod with `restartPolicy: Never`, never a Job.** A Job whose Pod dies with the
  node is re-created by the controller and would reboot the node for ever.
- An idempotency marker under `/var/lib/kubeos` is written *before* the request, so the
  same Pod can never fire a shutdown twice.
- **Power off requires the node's name typed** into the dialog; Restart is a plain
  confirmation. Power off leaves the machine dark until someone is physically at it.
- The shell Pod (`kubeos-system/kubeos-node-shell`) is privileged and mounts the host's
  root filesystem, so it does not stay: it is deleted when the terminal is closed and in
  any case expires after an hour (`activeDeadlineSeconds`). Its header line states what
  the shell is — a privileged container, with `nsenter -t 1 -m -u -i -n -p -- /bin/bash`
  for the node's own shell.

`?view=exec&container=<c>` deep links are **not** used for the shell: on Headlamp
v0.46.0 they crash the page (React "maximum update depth exceeded") because `PodDetails`
auto-launches the terminal from an effect whose guard resets when the activity takes over
the screen. The button calls `Activity.launch()` with `CommonComponents.Terminal`
directly, the same path the Pod page's own "Terminal / Exec" button takes.

## Authentication

`config.unsafeUseServiceAccountToken: true` in `deploy/values.yaml` makes
`headlamp-server` talk to the API as its own service account, so the dashboard
opens without a login prompt.

The service account name is the pod's, not a guess: the chart names it after the
release, `kubeos-dashboard-headlamp`.

**The binding is created by the chart itself — do not add it by hand.** Upstream's
`templates/clusterrolebinding.yaml` is gated on `clusterRoleBinding.create`, whose
default is `true`, and binds `clusterRoleName` (default `cluster-admin`) to that
service account. This was verified on a live node on 2026-11-11: after
`helm upgrade --install`, the object `kubeos-dashboard-headlamp-admin` exists with
`.metadata.managedFields[].manager == helm` and `subjects: kubeos-dashboard-headlamp`,
and `kubectl auth can-i list pods --as=system:serviceaccount:kubeos-system:kubeos-dashboard-headlamp`
answers **yes** with no manual step. The command below is therefore only for a
deployment that explicitly sets `clusterRoleBinding.create: false`, or for repairing
a cluster where someone deleted the object:

```sh
kubectl create clusterrolebinding kubeos-dashboard-headlamp-admin \
  --clusterrole=cluster-admin \
  --serviceaccount=kubeos-system:kubeos-dashboard-headlamp
```

**`cluster-admin` is a development shortcut.** Before this goes into an ISO the
binding must become a scoped `Role`/`ClusterRole` -- read on the KubeOS namespaces
plus logs and events is what a dashboard actually needs -- because whatever it is
granted, everyone who can reach port 30443 gets without authenticating. Setting
`clusterRoleBinding.clusterRoleName` is the supported knob for that; keep `create: true`.

## Known limits

- **Page title**: Headlamp computes it from a build-time product name, which only
  a frontend rebuild can change. The plugin rewrites the title through the DOM,
  so it reads KubeOS, but the About/version text still says Headlamp.
- **Default theme**: `registerAppTheme` in plugin 0.14 has no "make it the
  default" option, so the plugin seeds `headlampThemePreference` and reloads once
  on a browser's very first visit. Until that reload the first paint is Light;
  after it the KubeOS theme is the stored choice and a user can still pick Light
  or Dark in *Settings → General → Themes*.
- **Terminal colours**: the KubeOS console palette is an installer UI palette
  (index 7 is the panel background, index 0 is body text). It does not map onto
  ANSI semantics, where black must be dark; copying it verbatim would make
  `\e[30m` render light. Terminals therefore keep Headlamp's auto-selected ANSI
  palette.
