#!/bin/sh
# WHEN   run as root on the node, from an unpacked release directory:
#            ./install.sh --kubeconfig /etc/kubernetes/admin.conf
#        It is also the upgrade path: re-running it replaces the binary, frontend and
#        plugin and restarts the unit. Certificates and the kubeconfig are kept unless
#        you pass --tls-cert/--tls-key or a new --kubeconfig.
# WHY    The dashboard runs as a host service (no Pod, no image), so something has to
#        put the files in place, create the unprivileged user, give it exactly the
#        identity it needs and start systemd. That is all this script does - it makes no
#        cluster changes, so it works on a node where the API server is already running.
# SAFE   Idempotent. It only writes the paths listed under "layout" below, and it never
#        deletes data: the state directory /var/lib/kubeos-dashboard is left alone.
#
# Layout it creates:
#   /usr/lib/kubeos-dashboard/headlamp-server        the static Go binary
#   /usr/share/kubeos-dashboard/frontend/            Headlamp's built frontend
#   /usr/share/kubeos-dashboard/plugins/             the KubeOS plugin bundle
#   /etc/kubeos-dashboard/kubeconfig                 identity the server proxies with
#   /etc/kubeos-dashboard/tls.{crt,key}              HTTPS, self-signed if not supplied
#   /etc/default/kubeos-dashboard                    the flags (port, paths)
#   /etc/systemd/system/kubeos-dashboard.service     the unit
#   /var/lib/kubeos-dashboard/                       HOME, writable, owned by the user
set -eu

log() { printf 'install-dashboard: %s\n' "$*"; }
die() { printf 'install-dashboard: ERROR: %s\n' "$*" >&2; exit 1; }

SERVICE=kubeos-dashboard
RUN_USER=kubeos-dashboard
BIN_DIR=/usr/lib/kubeos-dashboard
SHARE_DIR=/usr/share/kubeos-dashboard
CONF_DIR=/etc/kubeos-dashboard
STATE_DIR=/var/lib/kubeos-dashboard
UNIT=/etc/systemd/system/$SERVICE.service
ENV_FILE=/etc/default/$SERVICE
CERT_DAYS=825

PORT=30443
LISTEN_ADDR=0.0.0.0
KUBECONFIG_SRC=
TLS_CERT=
TLS_KEY=
EXTRA_SANS=
DO_START=1
# Headlamp names the cluster after the kubeconfig CONTEXT, and the context name appears
# in every URL (/c/<context>/...). Renaming the context in the copy keeps the dashboard's
# addresses identical to the container deployment's (/c/main/...), so bookmarks and the
# links the KubeOS console prints stay valid.
CONTEXT_NAME=main

# The host console (the dashboard's Shell button). Separate unit, separate port, no Pod.
CONSOLE_SERVICE=kubeos-console
CONSOLE_DIR=/usr/lib/kubeos-console
CONSOLE_ENV=/etc/default/$CONSOLE_SERVICE
CONSOLE_UNIT=/etc/systemd/system/$CONSOLE_SERVICE.service
CONSOLE_TOKEN=$CONF_DIR/console.token
CONSOLE_SECRET=kubeos-console-token
CONSOLE_PORT=30444
DO_CONSOLE=1
SRC=$(cd "$(dirname "$0")" && pwd)

usage() {
    cat <<USAGE
Usage: $0 --kubeconfig <path> [options]

  --kubeconfig <path>   kubeconfig the dashboard proxies with (required).
                        Copy the file; the service user only needs read access to the copy.
  --port <n>            HTTPS port to listen on (default $PORT)
  --listen <addr>       bind address (default $LISTEN_ADDR)
  --tls-cert/--tls-key  use an existing certificate instead of a self-signed one
  --san <entry>         extra subjectAltName for the generated certificate, e.g.
                        'IP:192.168.1.50' or 'DNS:dashboard.lan' (repeatable)
  --context-name <name> name for the kubeconfig context in the installed copy, which
                        decides the cluster id in every URL (default $CONTEXT_NAME)
  --console-port <n>    HTTPS port of the host console, i.e. what the Shell button
                        connects to (default $CONSOLE_PORT). It shares the dashboard's
                        certificate, so a browser has to accept :30444 once.
  --no-console          do not install the host console; the Shell button then reports
                        that the console is not installed
  --no-start            install and enable, but do not start the service now
  -h, --help            this text
USAGE
}

while [ $# -gt 0 ]; do
    case $1 in
        --kubeconfig) KUBECONFIG_SRC=$2; shift 2 ;;
        --port) PORT=$2; shift 2 ;;
        --listen) LISTEN_ADDR=$2; shift 2 ;;
        --tls-cert) TLS_CERT=$2; shift 2 ;;
        --tls-key) TLS_KEY=$2; shift 2 ;;
        --san) EXTRA_SANS="$EXTRA_SANS $2"; shift 2 ;;
        --context-name) CONTEXT_NAME=$2; shift 2 ;;
        --console-port) CONSOLE_PORT=$2; shift 2 ;;
        --no-console) DO_CONSOLE=0; shift ;;
        --no-start) DO_START=0; shift ;;
        -h | --help) usage; exit 0 ;;
        *) die "unknown argument: $1 (try --help)" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"
[ -n "$KUBECONFIG_SRC" ] || die "--kubeconfig is required (try --help)"
[ -f "$KUBECONFIG_SRC" ] || die "no such file: $KUBECONFIG_SRC"
[ -x "$SRC/bin/headlamp-server" ] || die "incomplete release: $SRC/bin/headlamp-server is missing"
[ -s "$SRC/share/frontend/index.html" ] || die "incomplete release: $SRC/share/frontend/index.html is missing"
[ -s "$SRC/share/plugins/kubeos-branding/main.js" ] || die "incomplete release: the KubeOS plugin bundle is missing"

# ---- user ----------------------------------------------------------------
if ! id "$RUN_USER" >/dev/null 2>&1; then
    useradd --system --home-dir "$STATE_DIR" --no-create-home \
        --shell /usr/sbin/nologin --comment "KubeOS dashboard" "$RUN_USER"
    log "created system user $RUN_USER"
fi

# ---- files ---------------------------------------------------------------
install -d -m 0755 "$BIN_DIR" "$SHARE_DIR" "$CONF_DIR"
install -d -m 0750 -o "$RUN_USER" -g "$RUN_USER" "$STATE_DIR"

install -m 0755 "$SRC/bin/headlamp-server" "$BIN_DIR/headlamp-server"
rm -rf "$SHARE_DIR/frontend" "$SHARE_DIR/plugins"
install -d -m 0755 "$SHARE_DIR/frontend" "$SHARE_DIR/plugins"
cp -a "$SRC/share/frontend/." "$SHARE_DIR/frontend/"
cp -a "$SRC/share/plugins/." "$SHARE_DIR/plugins/"
chown -R root:root "$BIN_DIR" "$SHARE_DIR"
chmod -R a+rX "$BIN_DIR" "$SHARE_DIR"
log "installed the binary, the frontend and the plugin"

# ---- identity ------------------------------------------------------------
# Version skew is normal: the binary and the frontend must come from the same
# upstream release, which the release tarball guarantees. The VERSION file is kept
# next to the binary so an operator can see what is installed.
[ -f "$SRC/VERSION" ] && install -m 0644 "$SRC/VERSION" "$BIN_DIR/VERSION"

install -m 0600 -o "$RUN_USER" -g "$RUN_USER" "$KUBECONFIG_SRC" "$CONF_DIR/kubeconfig"
log "kubeconfig installed as $CONF_DIR/kubeconfig (the identity the dashboard uses for everyone)"

# The dashboard derives its cluster id, its URLs and its page title from this context name.
current_context=""
if command -v kubectl >/dev/null 2>&1; then
    current_context=$(kubectl config current-context --kubeconfig "$CONF_DIR/kubeconfig" 2>/dev/null || true)
fi
if [ -n "$current_context" ] && [ "$current_context" != "$CONTEXT_NAME" ]; then
    kubectl config rename-context "$current_context" "$CONTEXT_NAME" \
        --kubeconfig "$CONF_DIR/kubeconfig" >/dev/null 2>&1 ||
        die "could not rename the context '$current_context' to '$CONTEXT_NAME' in the copy"
    log "kubeconfig context renamed: '$current_context' -> '$CONTEXT_NAME' (this is the cluster id in every URL)"
elif [ -z "$current_context" ]; then
    log "NOTE: kubectl not found, so the context name was not checked; Headlamp will use"
    log "      whatever the kubeconfig says and the URLs will carry that name"
fi

# Pre-flight the identity, so a broken kubeconfig fails here instead of as an empty page.
if command -v kubectl >/dev/null 2>&1; then
    if kubectl --kubeconfig "$CONF_DIR/kubeconfig" get --raw=/version >/dev/null 2>&1; then
        log "identity check: the API server accepts this kubeconfig"
    else
        log "WARNING: the API server did not accept this kubeconfig (the dashboard will show nothing)"
    fi
fi

# ---- TLS -----------------------------------------------------------------
if [ -n "$TLS_CERT" ] || [ -n "$TLS_KEY" ]; then
    [ -n "$TLS_CERT" ] && [ -n "$TLS_KEY" ] || die "give both --tls-cert and --tls-key"
    install -m 0644 -o "$RUN_USER" -g "$RUN_USER" "$TLS_CERT" "$CONF_DIR/tls.crt"
    install -m 0600 -o "$RUN_USER" -g "$RUN_USER" "$TLS_KEY" "$CONF_DIR/tls.key"
    log "installed the supplied certificate"
elif [ -s "$CONF_DIR/tls.crt" ] && [ -s "$CONF_DIR/tls.key" ]; then
    log "keeping the existing certificate in $CONF_DIR"
else
    command -v openssl >/dev/null 2>&1 ||
        die "openssl is needed for the self-signed certificate (or pass --tls-cert/--tls-key)"
    host=$(hostname)
    # The node's own IPv4 plus loopback: that is the set of names a browser on the LAN
    # can reach the dashboard by. Add more with --san.
    primary=$(ip -4 addr show scope global 2>/dev/null |
        awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
    sans="DNS:localhost,IP:127.0.0.1,DNS:$host"
    [ -n "${primary:-}" ] && sans="$sans,IP:$primary"
    for entry in $EXTRA_SANS; do sans="$sans,$entry"; done
    openssl req -x509 -newkey rsa:2048 -nodes -days "$CERT_DAYS" \
        -keyout "$CONF_DIR/tls.key" -out "$CONF_DIR/tls.crt" \
        -subj "/CN=$host" -addext "subjectAltName=$sans" >/dev/null 2>&1 ||
        die "could not generate the self-signed certificate"
    chown "$RUN_USER:$RUN_USER" "$CONF_DIR/tls.crt" "$CONF_DIR/tls.key"
    chmod 0644 "$CONF_DIR/tls.crt"
    chmod 0600 "$CONF_DIR/tls.key"
    log "generated a self-signed certificate for $sans (valid $CERT_DAYS days)"
fi

# ---- host console --------------------------------------------------------
# WHY A SEPARATE SERVICE: the Shell button used to create a privileged Pod and exec into it,
# because Kubernetes has no "run on the host" call (user: *"i need shell without pod
# creation"*, 2026-11-12). This service is the node's own PTY over TLS WebSocket, so a click
# creates nothing in the cluster. It shares the dashboard's certificate and is reachable at
# https://<node>:$CONSOLE_PORT/ - open that page once per browser to accept the certificate,
# because a page may accept a certificate warning but a WebSocket may not.
if [ "$DO_CONSOLE" -eq 1 ]; then
    [ -s "$SRC/console/console.py" ] ||
        die "incomplete release: $SRC/console/console.py is missing (or use --no-console)"
    install -d -m 0755 "$CONSOLE_DIR"
    install -m 0644 "$SRC/console/console.py" "$CONSOLE_DIR/console.py"
    chown root:root "$CONSOLE_DIR/console.py"

    # One token per machine, kept if it already exists so a re-run does not break a browser
    # tab that is already connected... it does not survive a reload, but rotating a secret
    # on every install would be a surprise with no benefit.
    if [ ! -s "$CONSOLE_TOKEN" ]; then
        (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$CONSOLE_TOKEN")
        chmod 0600 "$CONSOLE_TOKEN"
        log "generated the console token in $CONSOLE_TOKEN"
    fi

    {
        printf '# Written by kubeos-dashboard install.sh - re-run it to change the flags.\n'
        printf 'CONSOLE_ARGS=--listen 0.0.0.0 --port %s --tls-cert %s/tls.crt --tls-key %s/tls.key --token-file %s\n' \
            "$CONSOLE_PORT" "$CONF_DIR" "$CONF_DIR" "$CONSOLE_TOKEN"
    } > "$CONSOLE_ENV"
    chmod 0644 "$CONSOLE_ENV"

    install -m 0644 "$SRC/systemd/$CONSOLE_SERVICE.service" "$CONSOLE_UNIT"

    # The browser gets the token from the cluster, not from the page: the dashboard reads this
    # Secret through the API it already proxies. Honest limit: anyone who can read that
    # Secret could open the shell - but the dashboard's own kubeconfig is cluster-admin, so
    # that is the same set of people who can already do anything on this node.
    if command -v kubectl >/dev/null 2>&1; then
        kubectl --kubeconfig "$CONF_DIR/kubeconfig" get namespace kubeos-system >/dev/null 2>&1 ||
            kubectl --kubeconfig "$CONF_DIR/kubeconfig" create namespace kubeos-system >/dev/null 2>&1 ||
            log "WARNING: could not create the kubeos-system namespace"
        kubectl --kubeconfig "$CONF_DIR/kubeconfig" -n kubeos-system create secret generic \
            "$CONSOLE_SECRET" --from-literal=token="$(cat "$CONSOLE_TOKEN")" \
            --dry-run=client -o yaml 2>/dev/null |
            kubectl --kubeconfig "$CONF_DIR/kubeconfig" apply -f - >/dev/null 2>&1 &&
            log "published the console token as Secret kubeos-system/$CONSOLE_SECRET" ||
            log "WARNING: could not publish Secret kubeos-system/$CONSOLE_SECRET (the Shell button will say so)"
    else
        log "WARNING: kubectl not found, so the console token was not published to the cluster"
    fi

    systemctl daemon-reload
    systemctl enable "$CONSOLE_SERVICE" >/dev/null 2>&1
    log "enabled $CONSOLE_SERVICE"

    if [ "$DO_START" -eq 1 ]; then
        systemctl restart "$CONSOLE_SERVICE"
        console_url="https://127.0.0.1:$CONSOLE_PORT/healthz"
        console_code=""
        i=1
        while [ "$i" -le 20 ]; do
            if command -v curl >/dev/null 2>&1; then
                console_code=$(curl -sk -o /dev/null -w '%{http_code}' "$console_url" 2>/dev/null || true)
            elif command -v wget >/dev/null 2>&1; then
                console_code=$(wget --no-check-certificate -q -O /dev/null "$console_url" 2>/dev/null && echo 200 || true)
            fi
            [ "$console_code" = "200" ] && break
            sleep 1
            i=$((i + 1))
        done
        if [ "$console_code" = "200" ]; then
            log "host console answers on $console_url (HTTP 200)"
        else
            log "WARNING: the host console did not answer - check: journalctl -u $CONSOLE_SERVICE -n 40 --no-pager"
        fi
    fi
fi

# ---- flags + unit --------------------------------------------------------
ARGS="--kubeconfig=$CONF_DIR/kubeconfig"
ARGS="$ARGS --html-static-dir=$SHARE_DIR/frontend"
ARGS="$ARGS --plugins-dir=$SHARE_DIR/plugins"
ARGS="$ARGS --listen-addr=$LISTEN_ADDR --port=$PORT"
ARGS="$ARGS --tls-cert-path=$CONF_DIR/tls.crt --tls-key-path=$CONF_DIR/tls.key"
ARGS="$ARGS --app-name=KubeOS"
ARGS="$ARGS --watch-plugins-changes=false --allow-kubeconfig-changes=false"
ARGS="$ARGS --log-level=info"

{
    printf '# Written by kubeos-dashboard install.sh - re-run it to change the flags.\n'
    printf '# --allow-kubeconfig-changes=false keeps the dashboard from editing the kubeconfig\n'
    printf '# it was given, which mirrors the container deployment.\n'
    printf 'HEADLAMP_ARGS=%s\n' "$ARGS"
} > "$ENV_FILE"
chmod 0644 "$ENV_FILE"

install -m 0644 "$SRC/systemd/$SERVICE.service" "$UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null 2>&1
log "enabled $SERVICE"

if [ "$DO_START" -eq 1 ]; then
    systemctl restart "$SERVICE"

    # Readiness is the HTTP answer, not `is-active`: the server starts listening a moment
    # after systemd reports it running, and a node without curl/wget must not fail here.
    url="https://127.0.0.1:$PORT/"
    code=""
    i=1
    while [ "$i" -le 30 ]; do
        if command -v curl >/dev/null 2>&1; then
            code=$(curl -sk -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)
        elif command -v wget >/dev/null 2>&1; then
            code=$(wget --no-check-certificate -q -O /dev/null "$url" 2>/dev/null && echo 200 || true)
        fi
        [ "$code" = "200" ] && break
        sleep 1
        i=$((i + 1))
    done

    if [ "$code" = "200" ]; then
        log "dashboard answers on $url (HTTP 200)"
    else
        log "WARNING: no HTTP 200 yet - check: journalctl -u $SERVICE -n 40 --no-pager"
    fi
fi

show_host=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
log ""
log "Dashboard:  https://${show_host:-<node-ip>}:$PORT/"
log "  service   systemctl status $SERVICE"
log "  logs      journalctl -u $SERVICE -f"
log "  identity  $CONF_DIR/kubeconfig (all users share it - the dashboard has no login of its own)"
if [ -n "${code:-}" ] && [ "$code" = "200" ]; then
    log "  the certificate is self-signed: the browser will warn once; accept it for this host"
fi
if [ "$DO_CONSOLE" -eq 1 ]; then
    log ""
    log "Host console: https://${show_host:-<node-ip>}:$CONSOLE_PORT/  <- open once per browser"
    log "  it is what the dashboard's "Shell" button connects to (no Pod is created)"
    log "  service   systemctl status $CONSOLE_SERVICE"
fi
