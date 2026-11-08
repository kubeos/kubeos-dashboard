# CLI requirements from dashboard work

Running list of things the KubeOS CLI must provide for the dashboard to work on a
fresh install, written so each item can be pasted into a KubeOS CLI session without
extra context. The dashboard side of each item lives in `deploy/` in this repo.

Every item below is currently patchable only **by hand on the test VM**. A fresh
KubeOS install does none of it.

## Open

### metrics-server: there is no source for CPU and memory usage
- **Dashboard feature affected:** Overview page -- the CPU and Memory cards (also
  `kubectl top`).
- **Symptom seen:** both cards showed a bare capacity figure ("2 units",
  "1.93 GB") with no ring and no percentage. On the VM: `kubectl top nodes` returns
  `error: Metrics API not available`, and `kubectl get apiservice
  v1beta1.metrics.k8s.io` is NotFound. The dashboard log shows the request failing:
  `GET /apis/metrics.k8s.io/v1beta1/nodes -> 404`.
- **What the CLI must add or change:** deploy a pinned metrics-server into
  `kube-system` -- ServiceAccount, ClusterRole, ClusterRoleBinding, RoleBinding,
  Service, Deployment and the `v1beta1.metrics.k8s.io` APIService -- and bake the
  image `registry.k8s.io/metrics-server/metrics-server:v0.8.0` into the ISO image
  set. It must run with `--kubelet-insecure-tls`: KubeOS kubelets serve self-signed
  certificates (no `serverTLSBootstrap`), and without the flag the scraper fails on
  x509 and the APIService never becomes Available.
- **Where it should run:** namespace `kube-system`, at install time, alongside the
  other addons (Calico, CoreDNS).
- **How to verify it works:** on the KubeOS VM --
  `kubectl get apiservice v1beta1.metrics.k8s.io` shows `AVAILABLE True`;
  `kubectl top nodes` prints a `kubeos` row with CPU(cores) and MEMORY(bytes);
  `kubectl top pods -A` prints rows. In the dashboard the two cards read
  "CPU Usage" / "Memory Usage" with a ring and a percentage.
- **Temporary workaround used for testing (if any):** yes, applied by hand on the
  VM. Manifest is `deploy/metrics-server/components.yaml` (upstream v0.8.0 plus the
  flag), applied with `kubectl apply -f`. The image was side-loaded because the node
  has no registry access:
  `docker save registry.k8s.io/metrics-server/metrics-server:v0.8.0 | gzip -1 | ssh root@<node> 'ctr -n k8s.io images import -'`

### Dashboard service account has no permissions on a fresh install
- **Dashboard feature affected:** every page of the dashboard, as soon as it is
  deployed with `unsafeUseServiceAccountToken: true` (which is how it is configured
  now, so that nobody has to paste a token).
- **Symptom seen:** the UI loads and renders normally, but every list is empty and
  the API answers 403 -- it looks like the cluster is empty rather than forbidden.
  With no binding, `kubectl auth can-i list pods --as=system:serviceaccount:kubeos-system:kubeos-dashboard-headlamp`
  returns `no`.
- **What the CLI must add or change:** a RBAC binding for the service account the
  dashboard pod runs as. The chart names it after the release, so with release
  `kubeos-dashboard` it is `kubeos-system/kubeos-dashboard-headlamp` -- note this is
  *not* the `kubeos-dashboard` service account, which is a different object. What it
  is bound to is a product decision: today it is `ClusterRole/cluster-admin`, which
  is a development shortcut and is too much for an appliance. A read-mostly
  ClusterRole (get/list/watch on workloads, events, nodes, plus pods/log) is what a
  dashboard actually needs.
- **Where it should run:** namespace `kubeos-system`, at dashboard install time.
- **How to verify it works:** `kubectl auth can-i list pods --as=system:serviceaccount:kubeos-system:kubeos-dashboard-headlamp`
  answers `yes`, and the dashboard's Namespaces/Pods/Events pages list real objects
  instead of staying empty.
- **Temporary workaround used for testing (if any):** yes, by hand:
  `kubectl create clusterrolebinding kubeos-dashboard-headlamp-admin --clusterrole=cluster-admin --serviceaccount=kubeos-system:kubeos-dashboard-headlamp`

### The dashboard install itself is not automated
- **Dashboard feature affected:** getting the dashboard onto a freshly installed
  KubeOS at all.
- **Symptom seen:** on a fresh install there is no dashboard: no `kubeos-system`
  namespace, no release, no service, no certificate.
- **What the CLI must add or change:** on install, deploy the dashboard from this
  repo's pinned Helm chart (`--version 0.46.0`) with `deploy/values.yaml`, and:
  - generate a per-machine TLS certificate into the `kubeos-system/kubeos-dashboard-tls`
    secret (the chart expects `tls.crt` + `tls.key` at `/headlamp-cert`); never ship
    one shared key in the ISO;
  - make `ghcr.io/skmdab/headlamp:kubeos-0.1.0` available in the node's containerd,
    since there is no registry to pull from;
  - expose it on NodePort **30443** (see `deploy/values.yaml`), and decide whether
    that port stays reachable beyond the management network.
- **Where it should run:** namespace `kubeos-system`, after Kubernetes is up (the
  dashboard is an add-on, not part of the base install).
- **How to verify it works:** `helm -n kubeos-system status kubeos-dashboard` is
  `deployed`, `kubectl -n kubeos-system get pods` shows the dashboard pod 1/1
  Running, `curl -k https://<node>:30443/` returns 200, and opening that URL in a
  browser lands on the Overview page with no login prompt.
- **Temporary workaround used for testing (if any):** yes, by hand on the VM: TLS
  keypair generated with openssl and `kubectl apply`-ed as a
  `kubernetes.io/tls` secret; image side-loaded with `docker save | ctr import`;
  chart applied with `helm upgrade --install ... --version 0.46.0 -f deploy/values.yaml`.
