> **Moved here 2026-11-11** from `~/headlamp/KUBEOS-DASHBOARD-NOTES.md`, when the upstream
> Headlamp clone was deleted after its binaries were vendored into this repository
> (`vendor/README.md`). It is the historical record of choosing the dashboard base — kept
> verbatim, so its paths and dates describe that moment, not today's layout.

# KubeOS dashboard on Headlamp — saved context (survey of 2026-11-08)

Hand-off notes so a **new session opened in this directory** (`/home/shaik/headlamp`) can continue
without repeating the survey. Nothing here has been implemented. No file in the ISO tree was
changed, and nothing in this clone has been edited.

---

## 1. Decision already approved by the user

The KubeOS web dashboard is built **on top of Headlamp**:

- Upstream: <https://github.com/kubernetes-sigs/headlamp> (user asked to pull exactly this repo).
- Local clone: **`/home/shaik/headlamp`**, shallow (`--depth 1`), HEAD **`138e0bc`**, ~134 MB.
- Licence **Apache-2.0** (`LICENSE`), CNCF sandbox project, actively maintained.
- It is a **sigs** project: attribute as "Based on Headlamp" and **never imply CNCF / Kubernetes
  endorsement**; keep `LICENSE` and `NOTICE` files and copyright headers.

Rejected alternative: the official `kubernetes/dashboard` — archived by its maintainers, so KubeOS
would own all security maintenance.

---

## 2. What the branding surfaces are, and the good news

Headlamp's own docs describe a supported **white-label pattern** — no fork needed for the UI. Docs:

- `docs/tutorials/plugin-development/getting-started/applying-custom-themes/index.md`
  — tutorial 9, "Applying Custom Themes"; §6 *Replacing the Application Logo*, §7
  *Building a White-label Headlamp Flavour*.

Two plugin APIs do the visible rebrand:

```tsx
import { registerAppLogo, registerAppTheme, AppLogoProps } from '@kinvolk/headlamp-plugin/lib';

registerAppTheme({
  name: 'KubeOS',
  base: 'dark',              // 'light' | 'dark'
  primary: '<accent>',       // ask the user for the exact lime
  secondary: '...',
  sidebar: { background, color, selectedBackground, selectedColor, actionBackground },
  navbar:  { background, color },
  radius: 8,
  buttonTextTransform: 'none',
});

registerAppLogo(({ logoType, themeName }: AppLogoProps) => /* React element */);
```

- Theme: a **named theme appears in Settings → General → Themes** next to Light/Dark. The whole UI
  (sidebar, navbar, buttons, backgrounds, text) re-renders from it. Built on MUI, but the `AppTheme`
  object is flat and simple.
- Logo: `logoType` is `'small'` (sidebar collapsed) or expanded; only **one** registration wins
  (last plugin loaded), which is exactly what a product wants.
- Anything the theme cannot reach (page title, favicon, footer/about text) can still be set from the
  plugin's `main.js` with plain DOM calls.

Logo/favicon assets that exist upstream (do **not** ship these in KubeOS):

`frontend/src/resources/{logo-dark.svg,logo-light.svg,icon-dark.svg,icon-light.svg}` and
`frontend/public/{favicon.ico,favicon-16x16.png,favicon-32x32.png,apple-touch-icon.png,android-chrome-*.png,icon.icns,icon.ico}`.

Branding rule that still applies: **never invent, redraw or recolour the KubeOS logo.** Ask the user
for the current logo file and the exact colours (the existing brand is "MFZ KUBEOS", lime green on
black; an all-green cleanup was requested by the user earlier).

---

## 3. How plugins reach a running deployment (important)

- The final image starts with:
  `ENTRYPOINT ["/headlamp/headlamp-server", "-html-static-dir", "/headlamp/frontend",
  "-plugins-dir", "/headlamp/plugins"]` (`Dockerfile`, last line).
- `Dockerfile` copies `./plugins` (built plugin bundles) into `/headlamp/plugins` of the final image,
  and the official static plugins into `/headlamp/static-plugins`
  (`ENV HEADLAMP_STATIC_PLUGINS_DIR=/headlamp/static-plugins`).
- Chart value `config.pluginsDir: "/headlamp/plugins"` is passed as `-plugins-dir=...`.
- **`/headlamp/plugins` is over-mounted with an `emptyDir` ONLY when `pluginsManager.enabled` is
  true** (`charts/headlamp/templates/deployment.yaml` lines ~446–460 and ~551–558). Default is
  `pluginsManager.enabled: false`, so a plugin **baked into the image at `/headlamp/plugins/<name>/`
  is served**.
- Consequence — two viable delivery paths:
  - **(A) No fork (recommended first):** use the upstream image unchanged, and deliver the KubeOS
    branding plugin as a **ConfigMap volume** mounted at
    `/headlamp/plugins/kubeos-branding/{package.json,main.js}` via `volumeMounts`/`volumes`
    (`configMap.items[].path` may contain slashes). Zero image maintenance.
  - **(B) Own image:** copy the plugin into the build (`COPY ./plugins ./plugins`) and publish
    `ghcr.io/kubeosin/headlamp`. More control, but we then own rebuilds and CVE patching.
- `pluginsManager` sidecar (`npx @headlamp-k8s/pluginctl`) needs **internet at runtime** — not
  acceptable for an offline-first KubeOS node.
- The plugin bundle must be **pre-built** (`main.js` + `package.json`): building it needs Node and
  `@kinvolk/headlamp-plugin`, which the Debian 13 build VM does not have. Keep the built bundle
  committed, or build the image on the host.

---

## 4. Chart facts (`charts/headlamp`)

- Image: `registry: ghcr.io`, `repository: headlamp-k8s/headlamp`, `tag: ""` (falls back to the
  chart `appVersion` — pin an explicit tag or digest for KubeOS).
- `config.inCluster: true`, `config.inClusterContextName: "main"`, `config.baseURL: ""`,
  `config.sessionTTL: 86400`.
- `config.unsafeUseServiceAccountToken: false` — **keep it false.** Turning it on authenticates
  every visitor as the pod's service account; only safe behind an auth proxy.
- OIDC: supported (`config.oidc.*`, secret or env). Out of scope for a single-node box.
- TLS is **built in**: `config.tlsCertPath: "/headlamp-cert/headlamp-ca.crt"` and
  `config.tlsKeyPath: "/headlamp-cert/headlamp-tls.key"` (commented examples at
  `charts/headlamp/values.yaml` lines ~143–144); mount the pair with `extraVolumes`/`volumeMounts`.
- Exposure: `service.type: ClusterIP` by default (`nodePort: null`), and a full `ingress:` block
  (disabled) with `hosts`, `pathType`, `tls`.
- Other useful keys: `config.enableHelm`, `config.watchPlugins`, `config.staticPlugins.enabled`,
  `config.podDebugImage`, `config.nodeShellImage`, `config.serviceAccountTokenPath`,
  `namespaceOverride`, `initContainers`, `extraContainers`.
- Repo also ships `kubernetes-headlamp.yaml`, `kubernetes-headlamp-ingress-sample.yaml`,
  `kubernetes-headlamp-monitoring.yaml`, `Dockerfile`, `Dockerfile.plugins`, `backstage-test/`,
  `docker-extension/`, `app/` (version manifests — frontend/root `package.json` are both `0.1.0`).

---

## 5. Integration plan drafted (NOT started, NOT approved item by item)

Layer split per `AGENTS.md` §6: dashboard is its **own repo/folder**, never inside the live-build tree.

- **Repo:** `kubeosin/kubeos-dashboard` (or a folder `~/kubeos-dashboard`): branding plugin source,
  built bundle, Helm values, deploy script, `LICENSE`, `NOTICE`, README with attribution.
- **ISO side (minimal, only packaging):**
  - bake the Headlamp image (hook `9030`, `ctr images pull`/import — the build VM already bakes 10
    images and the offline node must not need a registry);
  - ship the chart + branding plugin bundle under `/usr/share/kubeos/dashboard/`;
  - new first-boot step (same systemd theme as `kubeos-cluster-setup.service`) that renders values
    and runs `helm upgrade --install` into namespace `kubeos-system`;
  - **per-machine secrets generated at first boot** (never baked into the ISO).
- **Access / auth:**
  - TLS: generate a self-signed cert for the node IP at first boot, store as a Secret, mount at
    `/headlamp-cert` and set `config.tlsCertPath`/`config.tlsKeyPath`. **Never expose without TLS.**
  - A ServiceAccount + long-lived token (`type: kubernetes.io/service-account-token`) for login,
    root-readable only, printed once on the console / in `/etc/issue`; **never a shipped default
    token**.
  - NodePort (or ClusterIP + `kubectl port-forward`) — say the security implication out loud when
    choosing.
  - Add the dashboard URL + how to get the token to `/etc/issue`, `/etc/motd` and a
    `kubeos status` helper.
- **Base-system items agreed to be done together with the dashboard:** StorageClass `local-path`,
  `unattended-upgrades`, `metrics-server`, etcd snapshot timer, an Ingress controller, dynamic login
  banner, README.

---

## 6. Open questions for the user (ask before doing work)

1. Where the dashboard project lives: separate GitHub repo, or a sibling folder only?
2. Delivery path **A (upstream image + plugin ConfigMap)** or **B (fork/publish own image)**?
3. Image pinning: which Headlamp tag/digest to standardise on.
4. Exact brand colours + logo file for `registerAppTheme` / `registerAppLogo` (never invent them).
5. Exposure: NodePort vs port-forward for v1; which port.
6. Whether `kubeos-dashboard` ships in the ISO now or as a later add-on.

---

## 7. Hard rules that still govern this work

- Never run `lb`, `sudo`, `chroot`, `mount`, `debootstrap`; build output is read-only; the **user**
  builds. One concern per change, show the diff first, `sh tools/check-config.sh bookworm` after
  config edits.
- No secrets in any repo; no default admin token; no unauthenticated/unencrypted exposure.
- Keep upstream `LICENSE`/`NOTICE`/copyright; add "Based on Headlamp"; no implied endorsement.
- Do not mix dashboard code into the live-build tree; do not add VM/hypervisor features.
- KubeOS repo state at hand-off: `development` and `master` both at `a6a2bf1`, both pushed; the user
  works on `development`. Push **development only** unless the user explicitly says otherwise.
- Known build-hygiene backlog unrelated to the dashboard: remove the local-only
  `--apt-http-proxy http://127.0.0.1:3142` from `auto/config`; `config/` in the repo is stale
  generated output; Security/updates apt repos are disabled.
