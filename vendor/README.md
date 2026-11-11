# vendor/ - the upstream pieces, committed so the build needs no network

`kubeos-dashboard` does not compile Headlamp and does not download it at build time. The two
pieces of upstream Headlamp this product ships are **committed here**, exactly as upstream
published them, and every build re-verifies them against the digests pinned in
`deploy/binary/build-binary.sh`.

```
vendor/headlamp/v0.46.0/
├── headlamp-server.tgz   40 MB   the image layer whose only file is headlamp/headlamp-server
├── frontend.tgz          12 MB   the image layer holding headlamp/frontend/ (the built UI)
├── SHA256SUMS                    sha256 of the two files above
└── README.md                     provenance, written by build-binary.sh --vendor
```

## Why commit 52 MB of binaries

Because the product must be buildable from this repository alone. Before this directory
existed, `deploy/binary/build-binary.sh` had to reach `ghcr.io/headlamp-k8s/headlamp` to fetch
those two layers - a network dependency on someone else's registry for a build that otherwise
needs nothing but `tar` and `sha256sum`. With them vendored:

```sh
git clone https://github.com/skmdab/kubeos-dashboard && cd kubeos-dashboard
deploy/binary/build-binary.sh          # no docker, no Go, no Node, no registry, no network
# -> release/kubeos-dashboard-0.1.0-linux-amd64.tar.gz
```

That is the whole point: clone, one command, a deployable dashboard.

The cost is repository size (1.3 MB of our own code, 52 MB of vendored upstream). It is a
deliberate trade, taken 2026-11-11 after the alternative - a GitHub release asset - was
rejected because it would still make "having the dashboard" depend on downloading something.

## What is vendored, and what is not

Only the two layers a host install needs. The upstream image is not vendored and not used:
its base OS, its 52 MB `chown` layer that duplicates the same two paths, and its bundled
plugins all stay out. We do not re-package upstream's image; we take two files trees out of
it.

## Provenance and licence

- Upstream: **Headlamp** <https://github.com/kubernetes-sigs/headlamp>, version **v0.46.0**,
  image `ghcr.io/headlamp-k8s/headlamp:v0.46.0` (linux/amd64).
- Licence: **Apache-2.0**. `LICENSE` and `NOTICE` in the repository root carry the attribution,
  and both are copied into every release tarball, because the tarball redistributes upstream's
  binary.
- The vendored files are **unmodified**. Not "roughly upstream" - the same bytes: the layer
  digests in `deploy/binary/build-binary.sh` are the sha256 of these files, and the build
  refuses any file that does not match.

Verify by hand at any time:

```sh
cd vendor/headlamp/v0.46.0 && sha256sum -c SHA256SUMS
```

Expect:

```
headlamp-server.tgz: OK
frontend.tgz: OK
```

The build performs exactly this check before it uses them, so a truncated clone, a corrupted
file, or a digest that was edited without re-vendoring fails loudly instead of shipping.

## Bumping Headlamp

```sh
HEADLAMP_VERSION=vX.Y.Z \
BINARY_LAYER=sha256:… FRONTEND_LAYER=sha256:… \
  deploy/binary/build-binary.sh --vendor
```

Read the two digests from the new image's manifest:

```sh
docker manifest inspect ghcr.io/headlamp-k8s/headlamp:vX.Y.Z            # pick the amd64 digest
docker manifest inspect ghcr.io/headlamp-k8s/headlamp@sha256:<that>     # its two layer digests
```

Then commit `vendor/headlamp/vX.Y.Z/` together with the digest change in the script. The old
version directory can be deleted in the same commit; keeping two versions doubles the
repository size for nothing.

## Why not git LFS

GitHub accepts these files as ordinary blobs (each is under 100 MB), and LFS would put the
same dependency back in the build - an LFS server, `git lfs pull`, credentials - which is
precisely what vendoring removes. Plain files also mean `git archive` and a tarball download
of the repository both produce a buildable tree.

## If you specifically want Headlamp out of this product

Vendoring makes the build self-contained; it does not make the dashboard our own code. Upstream
Headlamp is still 90 % of what runs (see `MEMORY.md` for the inventory: our plugin is ~3.7k
lines of the KubeOS-specific pages, upstream supplies the server and the generic Kubernetes
UI). Replacing it means writing and maintaining a dashboard server and UI of our own - a
different, much larger decision, deliberately not taken here.
