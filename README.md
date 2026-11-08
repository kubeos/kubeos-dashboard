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

## Authentication

`config.unsafeUseServiceAccountToken: true` in `deploy/values.yaml` makes
`headlamp-server` talk to the API as its own service account, so the dashboard
opens without a login prompt.

The service account name is the pod's, not a guess: the chart names it after the
release, `kubeos-dashboard-headlamp`. It needs a binding or the UI loads normally
and every list is empty behind 403s:

```sh
kubectl create clusterrolebinding kubeos-dashboard-headlamp-admin \
  --clusterrole=cluster-admin \
  --serviceaccount=kubeos-system:kubeos-dashboard-headlamp
```

**`cluster-admin` is a development shortcut.** Before this goes into an ISO the
binding must become a scoped `Role`/`ClusterRole` -- read on the KubeOS namespaces
plus logs and events is what a dashboard actually needs -- because whatever it is
granted, everyone who can reach port 30443 gets without authenticating.

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
