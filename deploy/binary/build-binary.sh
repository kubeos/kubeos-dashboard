#!/bin/sh
# WHEN   run on any Linux with tar and sha256sum to produce the dashboard as a
#        systemd-deployable release instead of a container image:
#            deploy/binary/build-binary.sh              # offline, from vendor/
#            deploy/binary/build-binary.sh --online     # ignore vendor/, use ghcr.io
#            deploy/binary/build-binary.sh --vendor     # (re)fill vendor/ from ghcr.io
# WHY    KubeOS runs its control plane as host services and keeps no base Pods, so the
#        dashboard has to run as a binary on the node. Upstream Headlamp publishes no
#        standalone server binary (its releases are Electron desktop builds), so this
#        assembles the release from the two layers of the official image that hold
#        exactly what a host install needs: the static `headlamp-server` and the built
#        frontend. Nothing else from the image is used - not the base OS, not the 52 MB
#        `chown` layer that duplicates those files, not the upstream bundled plugins.
#
#        The two layers are VENDORED in this repository (vendor/headlamp/), so a clone
#        of kubeos-dashboard builds a working dashboard with no network and no registry
#        account: that is the whole point of vendoring them. A layer digest IS the
#        sha256 of its bytes, so the pinned digests below verify the vendored files on
#        every build - a corrupted or swapped file fails instead of shipping.
# SAFE   Re-runnable. Default mode touches release/ only. --vendor also rewrites
#        vendor/headlamp/<version>/ (run it only when bumping HEADLAMP_VERSION: it needs
#        network, and the files it writes go into git). It never touches a node or a
#        cluster.
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

# One edit per bump. Digests and file names from:
#   docker manifest inspect ghcr.io/headlamp-k8s/headlamp:v0.46.0   (amd64 image)
#   docker manifest inspect ghcr.io/headlamp-k8s/headlamp@sha256:<that digest>
# Layer 1 = the only file in it is headlamp/headlamp-server.
# Layer 2 = headlamp/frontend/ (index.html plus the built assets).
HEADLAMP_VERSION=${HEADLAMP_VERSION:-v0.46.0}
IMAGE_REPO=${IMAGE_REPO:-headlamp-k8s/headlamp}
BINARY_LAYER=${BINARY_LAYER:-sha256:f745ef7900f22b212a50bd446fb6a1a180457b1ddc1b80116e1e223295eb4a16}
FRONTEND_LAYER=${FRONTEND_LAYER:-sha256:103033326ffd8d7fb9298ae1f16ee875769bf0e15fa4cd45764f3dd4e7f5659c}
PLUGIN_DIST=$REPO/kubeos-branding/dist
VENDOR_DIR=$REPO/vendor/headlamp/$HEADLAMP_VERSION

# auto   = vendored files if present, ghcr.io otherwise (the normal build)
# online = always ghcr.io, ignores vendor/ (use when the version is not vendored yet)
# vendor = ghcr.io, then write the result into vendor/ (the bump path)
MODE=auto
while [ $# -gt 0 ]; do
    case $1 in
        --online) MODE=online; shift ;;
        --vendor) MODE=vendor; shift ;;
        -h | --help)
            sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

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

verify() { # verify <file> <wanted-sha256>
    got=$(sha256sum "$1" | cut -d' ' -f1)
    [ "$got" = "$2" ] || die "digest mismatch for $1 (got $got, want $2)"
}

fetch_layer() { # fetch_layer <digest> <file>
    digest=$1; file=$2; want=${digest#sha256:}
    name=$(basename "$file")

    # Vendored first: this is what makes a fresh clone build with no network at all.
    if [ "$MODE" != online ] && [ -f "$VENDOR_DIR/$name" ]; then
        verify "$VENDOR_DIR/$name" "$want"
        cp -f "$VENDOR_DIR/$name" "$file"
        log "using vendored $name (offline, digest verified)"
        return 0
    fi
    [ "$MODE" = auto ] &&
        log "no vendored $name for $HEADLAMP_VERSION, falling back to ghcr.io (a vendored build needs vendor/headlamp/$HEADLAMP_VERSION/)"

    if [ -f "$file" ]; then
        if [ "$(sha256sum "$file" | cut -d' ' -f1)" = "$want" ]; then
            log "cached $file"
            return 0
        fi
        log "$file does not match its digest, downloading again"
        rm -f "$file"
    fi
    command -v curl >/dev/null 2>&1 || die "curl is needed to fetch layers from ghcr.io (or vendor/ them)"
    token=$(pull_token)
    [ -n "${token:-}" ] || die "no pull token for $IMAGE_REPO (network or registry change?)"
    retry 4 curl -fsSL -H "Authorization: Bearer $token" \
        "https://ghcr.io/v2/${IMAGE_REPO}/blobs/${digest}" -o "$file" ||
        die "download failed for $digest"
    verify "$file" "$want"
    log "downloaded and verified ${want} ($(du -h "$file" | cut -f1))"
}

# ---- inputs -------------------------------------------------------------
[ -s "$PLUGIN_DIST/main.js" ] || die "no plugin bundle at $PLUGIN_DIST/main.js - run: cd kubeos-branding && npm run build"

# Is dist/main.js older than src/? Two things make the naive test wrong:
#   * in a fresh clone every file gets the checkout time, so a src file can land a few
#     milliseconds *after* dist/main.js and the committed release is called stale;
#   * uncommitted edits under src/ are not staleness by themselves - 2026-11-12 this
#     warned on a release that had just been rebuilt from those very edits, because the
#     git branch below only asked "is src dirty".
# So ask the build's own mtimes and tolerate a 2 s checkout skew.
plugin_is_stale() {
    dist_t=$(stat -c %Y "$PLUGIN_DIST/main.js" 2>/dev/null) || return 1
    [ -n "$(find "$REPO/kubeos-branding/src" \( -name '*.tsx' -o -name '*.ts' \) \
        -newermt "@$((dist_t + 2))" 2>/dev/null | head -1)" ]
}
plugin_is_stale &&
    log "WARNING: kubeos-branding/src is newer than dist/main.js - the release would ship an old plugin"
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$REPO/kubeos-branding/package.json" | head -1)
[ -n "$VERSION" ] || die "cannot read the plugin version from kubeos-branding/package.json"
NAME=kubeos-dashboard-${VERSION}-linux-amd64
STAGE=$OUT/$NAME

mkdir -p "$CACHE"
fetch_layer "$BINARY_LAYER" "$CACHE/headlamp-server.tgz"
fetch_layer "$FRONTEND_LAYER" "$CACHE/frontend.tgz"

# ---- vendor -------------------------------------------------------------
# Only on the bump path. Everything written here is meant to be committed: it is what
# lets the next person build without ghcr.io.
if [ "$MODE" = vendor ]; then
    mkdir -p "$VENDOR_DIR"
    cp -f "$CACHE/headlamp-server.tgz" "$CACHE/frontend.tgz" "$VENDOR_DIR/"
    ( cd "$VENDOR_DIR" && sha256sum headlamp-server.tgz frontend.tgz > SHA256SUMS )
    {
        printf '# Vendored upstream Headlamp %s\n\n' "$HEADLAMP_VERSION"
        printf 'Source: `ghcr.io/%s:%s` (linux/amd64 manifest), two layers extracted\n' "$IMAGE_REPO" "$HEADLAMP_VERSION"
        printf 'unmodified. Written by `deploy/binary/build-binary.sh --vendor`; do not edit.\n\n'
        printf '| file | contents | layer digest |\n|---|---|---|\n'
        printf '| `headlamp-server.tgz` | `headlamp/headlamp-server` (static Go binary) | `%s` |\n' "$BINARY_LAYER"
        printf '| `frontend.tgz` | `headlamp/frontend/` (built UI) | `%s` |\n\n' "$FRONTEND_LAYER"
        printf 'Upstream is Apache-2.0: see `LICENSE` and `NOTICE` in the repository root.\n'
        printf 'The digests above are re-verified on every build, so a modified file cannot ship.\n'
    } > "$VENDOR_DIR/README.md"
    log "vendored both layers into $VENDOR_DIR (commit this directory)"
fi

# ---- assemble -----------------------------------------------------------
log "assembling $NAME"
rm -rf "$STAGE"
mkdir -p "$STAGE/bin" "$STAGE/share/frontend" "$STAGE/share/plugins/kubeos-branding" \
    "$STAGE/systemd" "$STAGE/console"

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
cp "$HERE/kubeos-console.service" "$STAGE/systemd/"
# The host console: the node's own PTY over TLS, so the Shell button creates no Pod.
cp "$HERE/console.py" "$STAGE/console/console.py"
chmod 0644 "$STAGE/console/console.py"
cp "$HERE/README.md" "$STAGE/"
chmod 0755 "$STAGE/install.sh" "$STAGE/uninstall.sh"
# We redistribute upstream's binary, so upstream's licence and notice travel with it.
for f in LICENSE NOTICE; do
    [ -f "$REPO/$f" ] || die "missing $f - it must ship with the vendored upstream binary"
    cp "$REPO/$f" "$STAGE/$f"
done

{
    printf 'name: kubeos-dashboard\n'
    printf 'version: %s\n' "$VERSION"
    printf 'headlamp: %s\n' "$HEADLAMP_VERSION"
    printf 'image: ghcr.io/%s:%s\n' "$IMAGE_REPO" "$HEADLAMP_VERSION"
    printf 'binary-layer: %s\n' "$BINARY_LAYER"
    printf 'frontend-layer: %s\n' "$FRONTEND_LAYER"
    printf 'upstream-license: Apache-2.0\n'
    printf 'upstream-unmodified: yes\n'
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
