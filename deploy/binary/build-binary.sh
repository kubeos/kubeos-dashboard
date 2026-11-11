#!/bin/sh
# WHEN   run on any Linux with curl, tar and sha256sum to produce the dashboard as a
#        systemd-deployable release instead of a container image:
#            deploy/binary/build-binary.sh
# WHY    KubeOS runs its control plane as host services and keeps no base Pods, so the
#        dashboard has to run as a binary on the node. Upstream Headlamp publishes no
#        standalone server binary (its releases are Electron desktop builds), so this
#        assembles the release from the two layers of the official image that hold
#        exactly what a host install needs: the static `headlamp-server` and the built
#        frontend. Nothing else from the image is used - not the base OS, not the 52 MB
#        `chown` layer that duplicates those files, not the upstream bundled plugins.
#        A layer digest IS the sha256 of its bytes, so pinning the digests below pins
#        the exact content; the download is verified against them before extraction.
# SAFE   Re-runnable and network-only. It downloads into release/.cache (verified, then
#        reused), and rewrites release/<name>/ plus the tarball. It never touches the
#        KubeOS node or a cluster.
#
# The plugin bundle must be built first (it is committed, but rebuild it after editing):
#     cd kubeos-branding && npm run build
set -eu

log() { printf 'build-binary: %s\n' "$*"; }
die() { printf 'build-binary: ERROR: %s\n' "$*" >&2; exit 1; }

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
OUT=$REPO/release
CACHE=$OUT/.cache

# One edit per bump. Digests from:
#   docker manifest inspect ghcr.io/headlamp-k8s/headlamp:v0.46.0   (amd64 image)
#   docker manifest inspect ghcr.io/headlamp-k8s/headlamp@sha256:<that digest>
# Layer 1 = the only file in it is headlamp/headlamp-server.
# Layer 2 = headlamp/frontend/ (index.html plus the built assets).
HEADLAMP_VERSION=${HEADLAMP_VERSION:-v0.46.0}
IMAGE_REPO=${IMAGE_REPO:-headlamp-k8s/headlamp}
BINARY_LAYER=${BINARY_LAYER:-sha256:f745ef7900f22b212a50bd446fb6a1a180457b1ddc1b80116e1e223295eb4a16}
FRONTEND_LAYER=${FRONTEND_LAYER:-sha256:103033326ffd8d7fb9298ae1f16ee875769bf0e15fa4cd45764f3dd4e7f5659c}
PLUGIN_DIST=$REPO/kubeos-branding/dist

retry() { # retry <attempts> <command...>
    attempts=$1; shift; i=1
    until "$@"; do
        if [ "$i" -ge "$attempts" ]; then return 1; fi
        log "attempt $i failed, retrying in 5s"
        i=$((i + 1)); sleep 5
    done
}

pull_token() {
    curl -fsS "https://ghcr.io/token?service=ghcr.io&scope=repository:${IMAGE_REPO}:pull" |
        sed -n 's/.*"token":"\([^"]*\)".*/\1/p'
}

fetch_layer() { # fetch_layer <digest> <file>
    digest=$1; file=$2; want=${digest#sha256:}
    if [ -f "$file" ]; then
        if [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$want" ]; then
            log "cached $file"
            return 0
        fi
        log "$file does not match its digest, downloading again"
        rm -f "$file"
    fi
    token=$(pull_token)
    [ -n "${token:-}" ] || die "no pull token for $IMAGE_REPO (network or registry change?)"
    retry 4 curl -fsSL -H "Authorization: Bearer $token" \
        "https://ghcr.io/v2/${IMAGE_REPO}/blobs/${digest}" -o "$file" ||
        die "download failed for $digest"
    got=$(sha256sum "$file" | cut -d' ' -f1)
    [ "$got" = "$want" ] || die "digest mismatch for $digest (got $got)"
    log "downloaded and verified ${want} ($(du -h "$file" | cut -f1))"
}

# ---- inputs -------------------------------------------------------------
[ -s "$PLUGIN_DIST/main.js" ] || die "no plugin bundle at $PLUGIN_DIST/main.js - run: cd kubeos-branding && npm run build"
if [ -n "$(find "$REPO/kubeos-branding/src" -newer "$PLUGIN_DIST/main.js" -name '*.tsx' -o -newer "$PLUGIN_DIST/main.js" -name '*.ts' 2>/dev/null | head -1)" ]; then
    log "WARNING: kubeos-branding/src is newer than dist/main.js - the release would ship an old plugin"
fi
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO/kubeos-branding/package.json" | head -1)
[ -n "$VERSION" ] || die "cannot read the plugin version from kubeos-branding/package.json"
NAME=kubeos-dashboard-${VERSION}-linux-amd64
STAGE=$OUT/$NAME

mkdir -p "$CACHE"
fetch_layer "$BINARY_LAYER" "$CACHE/headlamp-server.tgz"
fetch_layer "$FRONTEND_LAYER" "$CACHE/frontend.tgz"

# ---- assemble -----------------------------------------------------------
log "assembling $NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/share/frontend" "$STAGE/share/plugins/kubeos-branding" "$STAGE/systemd"

TMP=$CACHE/extract
rm -rf "$TMP"; mkdir -p "$TMP"
tar -xzf "$CACHE/headlamp-server.tgz" -C "$TMP"
tar -xzf "$CACHE/frontend.tgz" -C "$TMP"
[ -x "$TMP/headlamp/headlamp-server" ] || die "the binary layer did not contain headlamp/headlamp-server"
[ -s "$TMP/headlamp/frontend/index.html" ] || die "the frontend layer did not contain headlamp/frontend/index.html"

cp "$TMP/headlamp/headlamp-server" "$STAGE/bin/headlamp-server"
chmod 0755 "$STAGE/bin/headlamp-server"
cp -a "$TMP/headlamp/frontend/." "$STAGE/share/frontend/"
cp "$PLUGIN_DIST/main.js" "$PLUGIN_DIST/package.json" "$STAGE/share/plugins/kubeos-branding/"

cp "$HERE/install.sh" "$HERE/uninstall.sh" "$STAGE/"
cp "$HERE/kubeos-dashboard.service" "$HERE/kubeos-dashboard.env.example" "$STAGE/systemd/"
cp "$HERE/README.md" "$STAGE/"
chmod 0755 "$STAGE/install.sh" "$STAGE/uninstall.sh"

{
    printf 'name: kubeos-dashboard\n'
    printf 'version: %s\n' "$VERSION"
    printf 'headlamp: %s\n' "$HEADLAMP_VERSION"
    printf 'image: ghcr.io/%s:%s\n' "$IMAGE_REPO" "$HEADLAMP_VERSION"
    printf 'binary-layer: %s\n' "$BINARY_LAYER"
    printf 'frontend-layer: %s\n' "$FRONTEND_LAYER"
    printf 'plugin-main-js: %s\n' "$(sha256sum "$PLUGIN_DIST/main.js" | cut -d' ' -f1)"
    printf 'build-date: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$STAGE/VERSION"

( cd "$STAGE" && find . -type f ! -name sha256sums.txt | sort | xargs sha256sum > sha256sums.txt )

# ---- verify the artifact without docker ---------------------------------
"$STAGE/bin/headlamp-server" --version 2>&1 | head -3 | sed 's/^/build-binary:    /' || true
FILES=$(find "$STAGE" -type f | wc -l)
SIZE=$(du -sh "$STAGE" | cut -f1)

rm -f "$OUT/$NAME.tar.gz"
tar -czf "$OUT/$NAME.tar.gz" -C "$OUT" "$NAME"
log "release: $OUT/$NAME.tar.gz"
log "  unpacked $SIZE, $FILES files, $(du -h "$OUT/$NAME.tar.gz" | cut -f1) compressed"
log "  sha256: $(sha256sum "$OUT/$NAME.tar.gz" | cut -d' ' -f1)"
log "install on a node with: tar -xzf $NAME.tar.gz && cd $NAME && ./install.sh --kubeconfig /etc/kubernetes/admin.conf"
