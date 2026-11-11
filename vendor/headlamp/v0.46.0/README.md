# Vendored upstream Headlamp v0.46.0

Source: `ghcr.io/headlamp-k8s/headlamp:v0.46.0` (linux/amd64 manifest), two layers extracted
unmodified. Written by `deploy/binary/build-binary.sh --vendor`; do not edit.

| file | contents | layer digest |
|---|---|---|
| `headlamp-server.tgz` | `headlamp/headlamp-server` (static Go binary) | `sha256:f745ef7900f22b212a50bd446fb6a1a180457b1ddc1b80116e1e223295eb4a16` |
| `frontend.tgz` | `headlamp/frontend/` (built UI) | `sha256:103033326ffd8d7fb9298ae1f16ee875769bf0e15fa4cd45764f3dd4e7f5659c` |

Upstream is Apache-2.0: see `LICENSE` and `NOTICE` in the repository root.
The digests above are re-verified on every build, so a modified file cannot ship.
