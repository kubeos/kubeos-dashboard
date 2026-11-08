# AGENTS.md -- KubeOS Dashboard

Guidance for anyone, human or agent, changing this repository.

## Branches

- **`development` is the default branch.** All work happens here, and `origin/HEAD`
  points at it.
- **`main` is a release mirror.** It is fast-forwarded from `development` and must
  always hold the same code. Never commit to `main` directly, and never let the two
  diverge:

  ```sh
  git checkout main && git merge --ff-only development && git push origin main
  git checkout development
  ```

## This repo is small on purpose

| Path | What it is |
|---|---|
| `kubeos-branding/` | Headlamp plugin: theme, logo, title, favicon |
| `image/Dockerfile` | one layer on the official Headlamp image |
| `deploy/values.yaml` | Helm values: NodePort 30443, TLS, plugin manager off |

Nothing here patches Headlamp. The upstream image, binary and frontend bundle are
used exactly as published, so an upstream security release is an `ARG` bump rather
than a merge. Do not add a Headlamp fork, a fork of `dist/`, or a vendored copy.

## Two things that are easy to break

- **`kubeos-branding/dist/` is committed.** The ISO build machine has no Node
  toolchain. Change `src/`, rebuild, commit both. A `dist/` that does not match
  `src/` is a bug.
- **The plugin files must be world-readable.** `headlamp-server` runs as an
  unprivileged user; a `dist/package.json` at mode 600 is served as 403 and the
  frontend silently drops the plugin. The Dockerfile uses `COPY --chmod=644`, so
  never remove it.

## Authentication is not solved yet

The dashboard runs with `unsafeUseServiceAccountToken: true`, so it authenticates
as its own service account (`kubeos-dashboard-headlamp`) and asks for nothing.
That binding is currently `cluster-admin`, created by hand, which means anyone who
reaches port 30443 has full cluster access. Scoping it to a read-mostly role is
the open work item; do not describe the dashboard as authenticated until it is
done, and do not widen the exposure in the meantime.

## Versions move together

Headlamp image `v0.46.0`, Helm chart `0.46.0`, `@kinvolk/headlamp-plugin ^0.14.0`.
Bump all three in one commit, then confirm the theme still applies.

## Branding rules

- Colours and the logo come from the KubeOS platform tree (`kubeos-branding/src/brand.ts`
  records provenance per value). Do not invent, "improve" or recolour the logo, and
  do not add brand values that the platform does not define; mark derived values as
  derived, as `brand.ts` already does for `bg.muted` and `radius`.
- Accent lime is `#A3F000`, light lime `#DBFF7A`; page `#050B05`, panel `#0B140B`,
  body text `#E8F2DC`.
- Keep `LICENSE` and `NOTICE`. Never imply CNCF, Kubernetes or Headlamp-maintainer
  endorsement: KubeOS is not affiliated with them.
- Status semantics outrank brand colour: healthy things may be lime, but warnings
  stay amber and errors stay red. Overrides therefore key on the exact fill
  Headlamp painted (see `applyChartColour`), not on "the first slice".

## Verifying a change

Rebuild the plugin (`npx headlamp-plugin build && npx headlamp-plugin tsc`), rebuild
the image, import it into the node's containerd (`imagePullPolicy: Never`, there is
no registry), then look at the real thing at `https://<node-ip>:30443`. Screenshots
or it did not happen.
