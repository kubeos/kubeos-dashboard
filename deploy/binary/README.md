# Running the KubeOS dashboard as a binary (systemd, no container)

KubeOS runs its control plane as host services and keeps no base Pods, so the dashboard
ships as a **binary plus a systemd unit**, not as a container image. This directory holds
everything needed to produce and install that form of it.

## Build the release

```sh
cd kubeos-branding && npm run build && cd -
deploy/binary/build-binary.sh
```

That writes `release/kubeos-dashboard-<version>-linux-amd64.tar.gz` (~40 MB compressed,
~125 MB unpacked) and prints its sha256. It downloads two layers of the pinned upstream
Headlamp image (`headlamp-server`, the built frontend), verifies each against its image
digest (a layer digest *is* the sha256 of its bytes), and adds the KubeOS plugin bundle
and the installer. No docker, Go or Node is needed for that step.

Why not compile it ourselves: upstream Headlamp needs Go 1.26, and upstream publishes no
standalone server binary - only Electron desktop builds. Reusing the static binary from
the release image keeps us on upstream's exact build instead of maintaining a Go
toolchain, and the digest pin makes the content auditable.

## Install on a node

```sh
tar -xzf kubeos-dashboard-0.1.0-linux-amd64.tar.gz
cd kubeos-dashboard-0.1.0-linux-amd64
./install.sh --kubeconfig /etc/kubernetes/admin.conf
```

Then open `https://<node-ip>:30443/`. The certificate is self-signed unless you pass
`--tls-cert/--tls-key`, so the browser warns once.

`install.sh` creates the unprivileged `kubeos-dashboard` user, copies the files, writes
`/etc/default/kubeos-dashboard` with the flags, installs the unit, enables and starts it,
and waits for a real HTTP 200 before reporting success. It is also the upgrade path: run
it again from a newer release.

Useful options: `--port` (default 30443), `--san 'IP:10.0.0.5'` to add a name to the
generated certificate, `--no-start`. `./uninstall.sh [--purge]` reverses it.

## What runs, and with which identity

```
/usr/lib/kubeos-dashboard/headlamp-server     static Go binary, ~90 MB
/usr/share/kubeos-dashboard/frontend/         Headlamp's built frontend
/usr/share/kubeos-dashboard/plugins/          the KubeOS plugin bundle (branding, NFS, disks, join, node controls)
/etc/kubeos-dashboard/kubeconfig              the identity the server proxies with
/etc/kubeos-dashboard/tls.{crt,key}           HTTPS
/etc/default/kubeos-dashboard                 flags: port, paths, --app-name=KubeOS
/var/lib/kubeos-dashboard/                    writable HOME for the server
```

`headlamp-server` is started with `--kubeconfig`, so **every user shares one identity**:
whatever the kubeconfig is allowed to do, the dashboard can do. That is the same model as
the container deployment's `unsafeUseServiceAccountToken`, and it is why the kubeconfig
should be a dedicated, scoped credential rather than `admin.conf` in production. The
dashboard has no login of its own - put it behind TLS you trust and, if it must be
reachable from an untrusted network, behind a reverse proxy that authenticates.

The unit runs with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome` and a single
writable path (`/var/lib/kubeos-dashboard`). It listens on a high port, so it needs no
capabilities.

## What the plugin needs from the cluster

The pages use the same Kubernetes API a `kubectl` user would: create Pods in
`kubeos-system` for the shell and the power actions, `pods/exec` for the terminal, and
`persistentvolumes`/`storageclasses` for storage. The container deployment binds its
service account to `cluster-admin`; the binary needs an identity with equivalent rights.
That grant belongs to the KubeOS side, not here.
