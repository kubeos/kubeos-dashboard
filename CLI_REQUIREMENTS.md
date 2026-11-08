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

### The dashboard install itself is not automated (now also blocks joining nodes)

> **Added 2026-11-08:** the new join flow depends on this. A node can only *paste* a control-plane
> token if it runs its own dashboard, and a fresh KubeOS install has none — so "every dashboard has
> Generate token / Join node" is only true once the CLI installs the dashboard on every node.
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

### storage: there is no StorageClass or provisioner, so every Storage page is empty
- **Dashboard feature affected:** Storage -- Persistent Volume Claims, Persistent
  Volumes, Storage Classes and Volume Attributes Classes. Beyond the dashboard, a
  stateful workload (database, registry, anything with a PVC) cannot run at all.
- **Symptom seen:** all four pages read "No data to be shown." That is honest, not a
  permissions or UI bug: `kubectl get pvc,pv,sc -A` answers "No resources found",
  `kubectl get csidrivers` is empty, and the dashboard's own service account gets
  HTTP 200 with `items: []` from `/api/v1/persistentvolumeclaims`,
  `/api/v1/persistentvolumes` and `/apis/storage.k8s.io/v1/storageclasses`. When a
  test PVC was created, it stayed `Pending` with
  `FailedBinding: no persistent volumes available for this claim and no storage class
  is set` -- there is no default class, so nothing will ever bind a claim.
- **What the CLI must add or change:** a pinned dynamic provisioner plus one
  **default** StorageClass, for example Rancher `local-path-provisioner` (single-node
  appliance, node-local volumes, no replication) or `sig-storage-local-static-
  provisioner`. Bake the provisioner image into the ISO image set, ship its manifest,
  and annotate the class with
  `storageclass.kubernetes.io/is-default-class: "true"` so a PVC that names no class
  still binds. Do not make the default class wait on anything optional.
- **Where it should run:** at install time, with the other addons (Calico, CoreDNS,
  metrics-server) -- i.e. after the CNI and a Ready, untainted node.
- **How to verify it works:** on the KubeOS VM --
  `kubectl get sc` shows one class marked `(default)`;
  `kubectl create -f` a 1Gi PVC with no `storageClassName` and
  `kubectl get pvc` reports `Bound` with a capacity; `kubectl get pv` shows the
  matching volume. Then the dashboard's Storage pages list that claim, volume and
  class instead of "No data to be shown.".
- **Temporary workaround used for testing (if any):** none installed, deliberately.
  The check was a throwaway namespace `kubeos-storage-test` with a 1Gi PVC
  (`cli-check`), used to observe `FailedBinding` and to confirm the dashboard renders a
  PVC correctly; both were deleted afterwards
  (`kubectl delete namespace kubeos-storage-test`). Nothing is left on the node.

### multi-node: every KubeOS install becomes its own one-node cluster
- **Dashboard feature affected:** there is no "add node" anywhere in the dashboard --
  the Nodes page lists the one node and offers only cordon, drain, delete and edit.
  Expectation from the maintainer: add a node the way Proxmox adds one.
- **Symptom seen:** a second machine installed from the KubeOS ISO does not appear in
  the dashboard's Nodes list. It ends up as its own independent cluster instead: first
  boot runs `kubeos-cluster-init` (kubeadm init, marker `/var/lib/kubeos/initialized`),
  never `kubeadm join`. **Verified 2026-11-08** on a second fresh install
  (`192.168.122.5`, hostname `kubeos2`): `kubectl get nodes` *on that machine* showed it
  as `kubeos2  Ready  control-plane`, while the original cluster still had one node. No
  `kubeos` CLI binary exists in `PATH` on either node.
- **What the CLI must add or change:** a supported join path for an additional machine:
  either a command (`kubeos join <ip>:6443 --token ...`) or first-boot logic that detects
  "join an existing cluster" (answer file / kernel keyword) and runs `kubeadm join`
  instead of `kubeos-cluster-init`. The manual recipe below worked first try, so this is
  packaging, not new capability. It also needs the bootstrap-token story (create/rotate/
  print, ideally short-lived) and must not touch the existing node's CNI.
- **Where it should run:** at install/first boot of the *additional* node; no change to
  the first node's first boot.
- **How to verify it works:** `kubectl get nodes` shows two rows, both `Ready`;
  `kubectl -n kube-system get pods -o wide` shows a `calico-node` and a `kube-proxy` per
  node; pod-to-pod traffic works across nodes; the dashboard's Nodes page lists both.
  **All of this was verified after the manual join** — see the workaround below.
- **Temporary workaround used for testing (if any):** yes, done by hand on the second
  VM and it worked. Exact steps, which the CLI should reproduce:
  1. On the second machine, discard the cluster it made for itself:
     `kubeadm reset -f --cri-socket unix:///run/containerd/containerd.sock`;
     `rm -rf /etc/kubernetes /var/lib/etcd /etc/cni/net.d /var/lib/kubelet/*
     /var/lib/kubeos/initialized`;
     `systemctl disable --now kubelet kubeos-cluster-setup.service`;
     `hostnamectl set-hostname kubeos2`.
  2. On the control plane: `kubeadm token create --print-join-command --ttl 1h`.
  3. On the second machine: run that command with
     `--cri-socket unix:///run/containerd/containerd.sock`.
  No internet was needed: the worker's images (`kube-proxy`, `pause`, `calico/node`)
  were already in its containerd from the ISO install. Results measured afterwards:
  both nodes `Ready`, `calico-node` + `kube-proxy` on each, a TCP payload sent from a pod
  on `kubeos` arrived in a pod on `kubeos2`, cluster DNS resolved, a 2-replica Deployment
  placed one pod per node, and the dashboard showed both nodes with live CPU/memory.
  Note the second machine must **skip** `kubeos-cluster-init`, or it forges a second
  cluster (it also gets its own etcd and apiserver, i.e. unnecessary on a worker).

### join-helper image and Job permissions: the "Join node" page cannot work on a fresh install
- **Dashboard feature affected:** the new **Join node** page (adds machines to the cluster from
  the dashboard, one form submission per node).
- **Symptom seen:** on an offline node the join Job stays in `ImagePullBackOff` because
  `ghcr.io/skmdab/kubeos-join-helper:0.1.0` is not in the node's containerd, exactly like the
  dashboard image itself.
- **What the CLI must add or change:**
  1. bake `ghcr.io/skmdab/kubeos-join-helper:0.1.0` into the ISO image set (it is ~10 MB: alpine +
     openssh-client + sshpass) so any node can run the Job;
  2. make sure the image a *workload* needs exists on **every** node, not only the first — a
     dashboard pod rescheduled onto the second node failed with `ImagePullBackOff` until it was
     side-loaded there too. Same for the dashboard image.
- **Where it should run:** image baking in the build hook that already pulls the platform images;
  no runtime component.
- **How to verify it works:** on a freshly installed, offline node:
  `crictl images | grep -E 'kubeos-join-helper|headlamp'` lists both; then in the dashboard, Join
  node → enter a second machine's address + root password → the attempt reaches `succeeded` and
  the node appears in the Nodes list as `Ready`.
- **Temporary workaround used for testing (if any):** the helper image was built on the host and
  side-loaded into **both** nodes with
  `docker save ghcr.io/skmdab/kubeos-join-helper:0.1.0 | gzip -1 | ssh root@<node> 'ctr -n k8s.io images import -'`.

### storage: the provisioner runs, but no claim can ever bind
- **Dashboard feature affected:** Storage -- Persistent Volume Claims, Persistent Volumes,
  Storage Classes; and every stateful workload behind them.
- **Symptom seen (fresh install, 2026-11-08 18:05, node `192.168.122.4`):** `kubectl get sc`
  shows `local-path (default)`, the provisioner pod is `1/1 Running`, and yet every claim
  stays `Pending`. First boot logged
  `kubeos-cluster-ready: WARNING: the test claim did not reach Bound after 120s`, and the
  provisioner log says exactly why:
  `failed to provision volume with StorageClass "local-path": configuration error, no node was specified`.
  So the dashboard's Storage pages will stay empty on every fresh install.
- **What the CLI must add or change:** the shipped `local-path-storage.yaml` sets
  `volumeBindingMode: Immediate`. That cannot work: local-path is node-local, so the
  provisioner must be told which node the volume goes on, and only `WaitForFirstConsumer`
  supplies it (the scheduler writes `pv.kubernetes.io/selected-node` onto the claim before
  the provisioner runs). Two changes:
  1. `volumeBindingMode: WaitForFirstConsumer` in the StorageClass (upstream's own value).
     Note the field is **immutable**: an existing cluster needs the class deleted and
     re-applied (a fresh install is unaffected).
  2. first boot's step 7 self-test must consume the test claim with a small pod (the baked
     `busybox` is already there) and wait for `Bound` before deleting both. A claim with no
     consumer staying `Pending` is correct Kubernetes behaviour, so the current test can only
     ever warn.
- **Where it should run:** first boot, step 7 of `kubeos-cluster-ready`, after the CNI, a
  Ready untainted node and the kube-system wait.
- **How to verify it works:** `kubectl get sc` shows `local-path (default)` with
  `WaitForFirstConsumer`; apply a 1Gi PVC with no `storageClassName` plus a pod that mounts
  it -> `kubectl get pvc` reports `Bound`, `kubectl get pv` shows the `pvc-...` volume;
  `journalctl -u kubeos-cluster-setup -b | grep -i storage` shows no `WARNING:`.
- **Temporary workaround used for testing (if any):** yes, on the KubeOS VM only: deleted the
  class and re-applied the same manifest with `volumeBindingMode: WaitForFirstConsumer`, then
  a 1Gi no-class claim bound in ~20 s with a `busybox:1.38.0` consumer pod. The installed
  manifest file was not edited, and the test pod/claim/PV were deleted afterwards.
