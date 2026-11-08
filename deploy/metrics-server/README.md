# metrics-server

Headlamp's CPU and memory cards show *usage* only when the `metrics.k8s.io` API
answers. KubeOS does not ship a metrics server, so without this the cards silently
fall back to capacity -- "2 units", "1.93 GB" -- with no gauge and no percentage.
Nothing is broken in that state, there is simply no number to draw.

`components.yaml` is upstream metrics-server **v0.8.0** with one change:
`--kubelet-insecure-tls` is added, because KubeOS kubelets serve self-signed
serving certificates (kubeadm default, no `serverTLSBootstrap`). It relaxes
verification of the kubelet endpoint on the node network only.

## Install

```sh
kubectl apply -f deploy/metrics-server/components.yaml
```

The node has no registry access, so the image has to be side-loaded with
`ctr` (same path the dashboard image takes):

```sh
docker save registry.k8s.io/metrics-server/metrics-server:v0.8.0 \
  | gzip -1 | ssh root@<node> 'ctr -n k8s.io images import -'
```

The image must be baked into the ISO for the same reason.

## Verify

```sh
kubectl get apiservice v1beta1.metrics.k8s.io     # AVAILABLE must be True
kubectl top nodes
kubectl top pods -A
```

`AVAILABLE` flips to `True` roughly 30 s after the pod starts, once it has scraped
the kubelet once.

## Cost

Requests 100m CPU / 200Mi memory, scrapes every 15 s. That is 5% of a 2 vCPU node
and about 10% of this box's 1.9 GiB, which is worth knowing before adding anything
else to the same node.
