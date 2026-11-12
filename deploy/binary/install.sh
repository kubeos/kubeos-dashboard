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
# One CA for the whole cluster, so every node's certificate chains to something a browser can
# be taught once (user decision 2026-11-12: "what about certificate https error on..?"). The
# CA lives in a Secret and each node signs its own leaf with it; --self-signed keeps the old
# per-node self-signed certificate.
CA_CERT_FILE=$CONF_DIR/ca.crt
CA_KEY_FILE=$CONF_DIR/ca.key
CA_SECRET=kubeos-dashboard-ca
CA_SRC_CERT=
CA_SRC_KEY=
DO_CA=1

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

# The login gateway (user decision 2026-11-12: "fix dashboard login with root password
# instead of token like proxmox dashboard"). Headlamp has no local login of its own, so a
# small stdlib service owns the public port and asks for a local account before proxying to
# Headlamp, which then listens on loopback only. --no-login restores the old "anyone who
# reaches the port is cluster-admin" behaviour, which is why it is not the default.
AUTH_SERVICE=kubeos-dashboard-auth
AUTH_UNIT=/etc/systemd/system/$AUTH_SERVICE.service
AUTH_ENV=/etc/default/$AUTH_SERVICE
AUTH_SESSION_KEY=$CONF_DIR/session.key
AUTH_INTERNAL_PORT=30445
SESSION_HOURS=12
DO_LOGIN=1
SRC=$(cd "$(dirname "$0")" && pwd)

usage() {
    cat <<USAGE
Usage: $0 --kubeconfig <path> [options]

  --kubeconfig <path>   kubeconfig the dashboard proxies with (required).
                        Copy the file; the service user only needs read access to the copy.
  --port <n>            HTTPS port to listen on (default $PORT)
  --listen <addr>       bind address (default $LISTEN_ADDR)
  --tls-cert/--tls-key  use an existing certificate instead of the cluster CA's
  --self-signed         do NOT use the cluster CA: generate a per-node self-signed
                        certificate (the browser then warns once per node, for ever)
  --ca-cert/--ca-key    use this CA instead of the cluster's (e.g. a CA you own). Both
                        are installed on the node so it can sign its own leaf.
  --san <entry>         extra subjectAltName for the generated certificate, e.g.
                        'IP:192.168.1.50' or 'DNS:dashboard.lan' (repeatable)
  --context-name <name> name for the kubeconfig context in the installed copy, which
                        decides the cluster id in every URL (default $CONTEXT_NAME)
  --console-port <n>    HTTPS port of the host console, i.e. what the Shell button
                        connects to (default $CONSOLE_PORT). It shares the dashboard's
                        certificate, so a browser has to accept :30444 once.
  --no-console          do not install the host console; the Shell button then reports
                        that the console is not installed
  --no-login            do NOT put the login gateway in front of the dashboard: the dashboard
                        then accepts any request that reaches its port, with no password
                        (the old behaviour; Headlamp's kubeconfig is cluster-admin)
  --session-hours <n>   how long a login stays valid (default $SESSION_HOURS)
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
        --self-signed) DO_CA=0; shift ;;
        --ca-cert) CA_SRC_CERT=$2; shift 2 ;;
        --ca-key) CA_SRC_KEY=$2; shift 2 ;;
        --tls-key) TLS_KEY=$2; shift 2 ;;
        --san) EXTRA_SANS="$EXTRA_SANS $2"; shift 2 ;;
        --context-name) CONTEXT_NAME=$2; shift 2 ;;
        --console-port) CONSOLE_PORT=$2; shift 2 ;;
        --no-console) DO_CONSOLE=0; shift ;;
        --no-login) DO_LOGIN=0; shift ;;
        --session-hours) SESSION_HOURS=$2; shift 2 ;;
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
elif [ "$DO_CA" -eq 1 ]; then
    # ---- one CA for the cluster, a leaf per node ----------------------------------
    command -v openssl >/dev/null 2>&1 ||
        die "openssl is needed to sign the certificate (or pass --tls-cert/--tls-key)"
    if [ -n "$CA_SRC_CERT" ] || [ -n "$CA_SRC_KEY" ]; then
        [ -n "$CA_SRC_CERT" ] && [ -n "$CA_SRC_KEY" ] || die "give both --ca-cert and --ca-key"
        install -m 0644 "$CA_SRC_CERT" "$CA_CERT_FILE"
        install -m 0600 "$CA_SRC_KEY" "$CA_KEY_FILE"
        log "installed the supplied CA certificate"
    elif command -v kubectl >/dev/null 2>&1 &&
        kubectl --kubeconfig "$CONF_DIR/kubeconfig" -n kubeos-system get secret "$CA_SECRET" \
            -o jsonpath='{.data.ca\.crt}' >/dev/null 2>&1; then
        (umask 077 && kubectl --kubeconfig "$CONF_DIR/kubeconfig" -n kubeos-system get secret \
            "$CA_SECRET" -o jsonpath='{.data.ca\.crt}' | base64 -d > "$CA_CERT_FILE")
        (umask 077 && kubectl --kubeconfig "$CONF_DIR/kubeconfig" -n kubeos-system get secret \
            "$CA_SECRET" -o jsonpath='{.data.ca\.key}' | base64 -d > "$CA_KEY_FILE")
        chmod 0644 "$CA_CERT_FILE"
        chmod 0600 "$CA_KEY_FILE"
        log "adopted the cluster CA this cluster already publishes (Secret kubeos-system/$CA_SECRET)"
    elif [ -s "$CA_CERT_FILE" ] && [ -s "$CA_KEY_FILE" ]; then
        # Only when the cluster has no CA yet: a node that installed the dashboard while it was
        # still its own one-node cluster has a CA of its own here, and using it after joining
        # would silently fork the trust into two CAs with the SAME subject name (measured
        # 2026-11-12 on kubeos2: the leaf looked right but did not verify against the cluster CA).
        log "keeping this node's copy of the cluster CA ($CA_CERT_FILE) - the cluster has none yet"
    else
        (umask 077 && openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
            -keyout "$CA_KEY_FILE" -out "$CA_CERT_FILE" \
            -subj "/O=KubeOS/CN=KubeOS Cluster CA" \
            -addext "basicConstraints=critical,CA:TRUE" \
            -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1) ||
            die "could not create the cluster CA"
        chmod 0644 "$CA_CERT_FILE"
        chmod 0600 "$CA_KEY_FILE"
        log "created the cluster CA ($CA_CERT_FILE, 10 years)"
    fi
    # PUBLISH ONLY WHEN THE CLUSTER HAS NO CA YET. A Secret holds one value, so an
    # unconditional `apply` lets the LAST node to install overwrite the cluster's CA with its
    # own - the two CAs then share the subject name, every leaf "looks" right, and nothing
    # verifies against the other node (measured 2026-11-12: kubeos2's reinstall replaced
    # kubeos1's CA in the Secret). First writer wins; everybody else adopts.
    ca_already_published=0
    if command -v kubectl >/dev/null 2>&1 &&
        kubectl --kubeconfig "$CONF_DIR/kubeconfig" -n kubeos-system get secret "$CA_SECRET" \
            -o jsonpath='{.data.ca\.crt}' >/dev/null 2>&1; then
        ca_already_published=1
    fi
    if [ "$ca_already_published" -eq 1 ]; then
        log "the cluster already publishes a CA (Secret kubeos-system/$CA_SECRET) - not replacing it"
    elif command -v kubectl >/dev/null 2>&1; then
        kubectl --kubeconfig "$CONF_DIR/kubeconfig" get namespace kubeos-system >/dev/null 2>&1 ||
            kubectl --kubeconfig "$CONF_DIR/kubeconfig" create namespace kubeos-system >/dev/null 2>&1 ||
            log "WARNING: could not create the kubeos-system namespace"
        # The CA PRIVATE key is in this Secret, so every node can sign its own leaf. That is
        # the same trust boundary as the dashboard's own kubeconfig (cluster-admin): whoever
        # can read this Secret can already do anything in the cluster.
        kubectl --kubeconfig "$CONF_DIR/kubeconfig" -n kubeos-system create secret generic \
            "$CA_SECRET" --from-file=ca.crt="$CA_CERT_FILE" --from-file=ca.key="$CA_KEY_FILE" \
            --dry-run=client -o yaml 2>/dev/null |
            kubectl --kubeconfig "$CONF_DIR/kubeconfig" apply -f - >/dev/null 2>&1 &&
            log "published the cluster CA as Secret kubeos-system/$CA_SECRET" ||
            log "WARNING: could not publish Secret kubeos-system/$CA_SECRET (each node will make its own CA)"
    fi

    host=$(hostname)
    primary=$(ip -4 addr show scope global 2>/dev/null |
        awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
    sans="DNS:localhost,IP:127.0.0.1,DNS:$host"
    [ -n "${primary:-}" ] && sans="$sans,IP:$primary"
    # Every node's internal IP, so typing ANY node's address in the browser matches a SAN on
    # EVERY node's certificate. Re-run this script after adding a node to refresh the list.
    node_ips=$(kubectl --kubeconfig "$CONF_DIR/kubeconfig" get nodes \
        -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}' \
        2>/dev/null || true)
    for address in $node_ips; do
        case ",$sans," in
            *",IP:$address,"*) ;;
            *) sans="$sans,IP:$address" ;;
        esac
    done
    for entry in $EXTRA_SANS; do sans="$sans,$entry"; done

    work=$(mktemp -d)
    (umask 077 && openssl req -new -newkey rsa:2048 -nodes -sha256 \
        -keyout "$work/tls.key" -out "$work/leaf.csr" -subj "/CN=$host" >/dev/null 2>&1) ||
        { rm -rf "$work"; die "could not create the certificate request"; }
    {
        printf 'basicConstraints=CA:FALSE\n'
        printf 'keyUsage=critical,digitalSignature,keyEncipherment\n'
        printf 'extendedKeyUsage=serverAuth\n'
        printf 'subjectAltName=%s\n' "$sans"
    } > "$work/ext.cnf"
    openssl x509 -req -in "$work/leaf.csr" -CA "$CA_CERT_FILE" -CAkey "$CA_KEY_FILE" \
        -CAcreateserial -days "$CERT_DAYS" -sha256 -extfile "$work/ext.cnf" \
        -out "$work/leaf.crt" >/dev/null 2>&1 ||
        { rm -rf "$work"; die "could not sign the node certificate with the cluster CA"; }
    # leaf first, then the CA: what a client needs to build the chain in one file.
    cat "$work/leaf.crt" "$CA_CERT_FILE" > "$work/tls.crt"
    install -m 0644 -o "$RUN_USER" -g "$RUN_USER" "$work/tls.crt" "$CONF_DIR/tls.crt"
    install -m 0600 -o "$RUN_USER" -g "$RUN_USER" "$work/tls.key" "$CONF_DIR/tls.key"
    rm -rf "$work"
    log "signed this node's certificate with the cluster CA for $sans (valid $CERT_DAYS days)"

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

    # THE CLUSTER OWNS THE TOKEN, not this machine: the dashboard reads it from Secret
    # kubeos-system/kubeos-console-token, which is ONE name per cluster, so every node of a
    # cluster has to run the console with the same token - otherwise installing the dashboard
    # on a joined node overwrites the Secret and the Shell button on the control plane starts
    # answering 401 (measured 2026-11-12, the first two-node test). So an existing Secret wins
    # over whatever this node has locally; to rotate, delete the Secret and re-run this script
    # on each node - the first one generates a new token and the rest adopt it.
    if command -v kubectl >/dev/null 2>&1; then
        cluster_token=$(kubectl --kubeconfig "$CONF_DIR/kubeconfig" -n kubeos-system get secret \
            "$CONSOLE_SECRET" -o jsonpath='{.data.token}' 2>/dev/null | base64 -d 2>/dev/null) || cluster_token=""
        if [ -n "${cluster_token:-}" ] && [ "$cluster_token" != "$(cat "$CONSOLE_TOKEN" 2>/dev/null)" ]; then
            (umask 077 && printf '%s\n' "$cluster_token" > "$CONSOLE_TOKEN")
            chmod 0600 "$CONSOLE_TOKEN"
            log "adopted the console token this cluster already publishes (Secret kubeos-system/$CONSOLE_SECRET)"
        fi
    fi

    # Kept if it already exists, so a re-run does not break a browser tab that is already
    # connected (it does not survive a reload, but rotating a secret on every install would be
    # a surprise with no benefit).
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

# ---- login gateway: files, session key, and where Headlamp must listen ----
if [ "$DO_LOGIN" -eq 1 ]; then
    [ -s "$SRC/authproxy.py" ] || die "incomplete release: $SRC/authproxy.py is missing (or use --no-login)"
    install -m 0755 "$SRC/authproxy.py" "$BIN_DIR/authproxy.py"
    if [ ! -s "$AUTH_SESSION_KEY" ]; then
        (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$AUTH_SESSION_KEY")
        chmod 0600 "$AUTH_SESSION_KEY"
        log "generated the session key in $AUTH_SESSION_KEY (delete it to log every browser out)"
    fi
    # Headlamp must not stay reachable while the gateway guards it.
    HEADLAMP_LISTEN=127.0.0.1
    HEADLAMP_PORT=$AUTH_INTERNAL_PORT
else
    HEADLAMP_LISTEN=$LISTEN_ADDR
    HEADLAMP_PORT=$PORT
    log "WARNING: --no-login - anyone who can reach :$PORT is cluster-admin with no password"
fi

# ---- flags + unit --------------------------------------------------------
ARGS="--kubeconfig=$CONF_DIR/kubeconfig"
ARGS="$ARGS --html-static-dir=$SHARE_DIR/frontend"
ARGS="$ARGS --plugins-dir=$SHARE_DIR/plugins"
ARGS="$ARGS --listen-addr=$HEADLAMP_LISTEN --port=$HEADLAMP_PORT"
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
    url="https://127.0.0.1:$HEADLAMP_PORT/"
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

# ---- the login gateway ---------------------------------------------------
if [ "$DO_LOGIN" -eq 1 ]; then
    {
        printf '# Written by kubeos-dashboard install.sh - re-run it to change the flags.\n'
        printf 'AUTH_ARGS=--listen %s --port %s --upstream-port %s --tls-cert %s/tls.crt --tls-key %s/tls.key --session-key %s --session-hours %s --ca-file %s\n' \
            "$LISTEN_ADDR" "$PORT" "$HEADLAMP_PORT" "$CONF_DIR" "$CONF_DIR" "$AUTH_SESSION_KEY" \
            "$SESSION_HOURS" "$CA_CERT_FILE"
    } > "$AUTH_ENV"
    chmod 0644 "$AUTH_ENV"
    install -m 0644 "$SRC/systemd/$AUTH_SERVICE.service" "$AUTH_UNIT"
    systemctl daemon-reload
    systemctl enable "$AUTH_SERVICE" >/dev/null 2>&1
    log "enabled $AUTH_SERVICE (login: root, or any member of sudo, with this node's password)"
    if [ "$DO_START" -eq 1 ]; then
        systemctl restart "$AUTH_SERVICE"
        gateway_url="https://127.0.0.1:$PORT/healthz"
        gateway_code=""
        i=1
        while [ "$i" -le 20 ]; do
            if command -v curl >/dev/null 2>&1; then
                gateway_code=$(curl -sk -o /dev/null -w '%{http_code}' "$gateway_url" 2>/dev/null || true)
            elif command -v wget >/dev/null 2>&1; then
                gateway_code=$(wget --no-check-certificate -q -O /dev/null "$gateway_url" 2>/dev/null && echo 200 || true)
            fi
            [ "$gateway_code" = "200" ] && break
            sleep 1
            i=$((i + 1))
        done
        if [ "$gateway_code" = "200" ]; then
            log "login gateway answers on $gateway_url (HTTP 200)"
        else
            log "WARNING: the login gateway did not answer - check: journalctl -u $AUTH_SERVICE -n 40 --no-pager"
        fi
    fi
fi

show_host=$(ip -4 addr show scope global 2>/dev/null | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')
log ""
log "Dashboard:  https://${show_host:-<node-ip>}:$PORT/"
log "  service   systemctl status $SERVICE"
log "  logs      journalctl -u $SERVICE -f"
if [ "$DO_LOGIN" -eq 1 ]; then
    log "  login     root + this node's root password (or any account in the sudo group)"
    log "  gateway   systemctl status $AUTH_SERVICE   sessions last ${SESSION_HOURS}h"
else
    log "  login     NONE - anyone who reaches this port is cluster-admin (--no-login)"
fi
log "  identity  $CONF_DIR/kubeconfig (the dashboard proxies with this; it is not a user login)"
if [ -s "$CA_CERT_FILE" ]; then
    log "  certificate signed by the KubeOS cluster CA - import it ONCE per browser:"
    log "      https://${show_host:-<node-ip>}:$PORT/kubeos-ca.crt"
    log "  (Chrome/Edge: Settings > Privacy > Security > Manage certificates > Authorities >"
    log "   Import > select the downloaded file > trust it for identifying websites)"
    log "  then https shows the padlock on EVERY node, both ports, with no warning"
elif [ -n "${code:-}" ] && [ "$code" = "200" ]; then
    log "  the certificate is self-signed: the browser will warn once per node; accept it"
fi
if [ "$DO_CONSOLE" -eq 1 ]; then
    log ""
    log "Host console: https://${show_host:-<node-ip>}:$CONSOLE_PORT/  <- open once per browser"
    log "  it is what the dashboard's "Shell" button connects to (no Pod is created)"
    log "  service   systemctl status $CONSOLE_SERVICE"
fi
