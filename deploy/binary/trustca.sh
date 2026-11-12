#!/bin/sh
# WHEN   run as root on a KubeOS node, by a person who is tired of the browser's
#        "Not secure" badge on https://<node>:30443:
#            kubeos-trust-ca                 # show the CA, its fingerprint, and what to do
#            kubeos-trust-ca --system        # trust it for THIS NODE (curl, wget, git)
#            kubeos-trust-ca --desktop       # print the one-liners for your OWN machine
#            kubeos-trust-ca --browser USER  # install into USER's NSS store if a browser exists here
#
# WHY    every node serves a leaf signed by ONE cluster CA ("KubeOS Cluster CA"), which is what
#        makes one import in one browser enough for every node and both ports. A browser cannot
#        be taught a CA by a web page, so somebody has to do it once - and the manual path
#        (Settings > Privacy > Security > Manage certificates > Authorities > Import) is the
#        step people miss, then report "https not secure". This prints the exact commands and
#        the fingerprint to compare against, so the import is verifiable instead of blind.
#
# SAFE   Read-only unless asked: `--system` writes /usr/local/share/ca-certificates/
#        kubeos-cluster-ca.crt and refreshes the system bundle (idempotent, `--remove` undoes
#        it); `--browser` writes only that user's NSS database. Nothing touches the cluster, the
#        dashboard services or the certificate files. Missing tools are reported, never installed.

set -eu

log() { printf 'kubeos-trust-ca: %s\n' "$*"; }

# Keep in sync with install.sh: the CA this node serves and signs its leaf with.
CONF_DIR=/etc/kubeos-dashboard
CA_FILE=$CONF_DIR/ca.crt
CA_NAME="KubeOS Cluster CA"
CA_DEST=/usr/local/share/ca-certificates/kubeos-cluster-ca.crt
PORT=${KUBEOS_DASHBOARD_PORT:-30443}

MODE=show
REMOVE=0
NSS_USER=
case ${1:-} in
    "") ;;
    --system) MODE=system ;;
    --desktop) MODE=desktop ;;
    --browser)
        MODE=browser
        [ $# -ge 2 ] || { log "usage: $0 --browser <user>"; exit 2; }
        NSS_USER=$2
        shift
        ;;
    --help | -h)
        sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
        exit 0
        ;;
    *)
        log "unknown argument: $1 (try --help)"
        exit 2
        ;;
esac
if [ "${2:-}" = "--remove" ]; then REMOVE=1; fi

[ -s "$CA_FILE" ] || {
    log "no cluster CA at $CA_FILE - is the dashboard installed on this node?"
    log "  (install.sh creates it, or adopts the CA this cluster publishes)"
    exit 1
}

# openssl already prints it colon-separated and upper-case, which is exactly what every
# browser's certificate dialog shows - so it is passed through untouched, not reformatted.
fingerprint() {
    openssl x509 -in "$CA_FILE" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*=//'
}

host_address() {
    ip -4 addr show scope global 2>/dev/null |
        awk '/inet /{sub(/\/.*/, "", $2); print $2; exit}'
}

show_ca() {
    log "cluster CA: $CA_FILE"
    openssl x509 -in "$CA_FILE" -noout -subject -issuer -dates 2>/dev/null | sed 's/^/  /'
    log "SHA-256 fingerprint (compare the SAME value in the browser's import dialog):"
    printf '  %s\n' "$(fingerprint)"
    node_address=$(host_address)
    if [ -n "$node_address" ]; then
        log "download it (no login needed): https://$node_address:$PORT/kubeos-ca.crt"
    fi
}

install_system() {
    command -v update-ca-certificates >/dev/null 2>&1 || {
        log "update-ca-certificates is not installed - nothing to install into"
        exit 1
    }
    if [ "$REMOVE" -eq 1 ]; then
        if [ -f "$CA_DEST" ]; then
            rm -f "$CA_DEST"
            update-ca-certificates --fresh >/dev/null 2>&1 || true
            log "removed $CA_DEST from this machine's trust store"
        else
            log "$CA_DEST was not installed - nothing to remove"
        fi
        return 0
    fi
    install -m 0644 "$CA_FILE" "$CA_DEST"
    update-ca-certificates >/dev/null 2>&1 || {
        log "WARNING: update-ca-certificates failed (the file is in place, the bundle may be stale)"
        exit 1
    }
    log "installed $CA_NAME into this machine's trust store ($CA_DEST)"
    if command -v wget >/dev/null 2>&1; then
        if wget -qO- "https://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
            log "verified: wget trusts https://127.0.0.1:$PORT/ without --no-check-certificate"
        else
            log "note: wget still does not trust 127.0.0.1:$PORT - check the certificate SANs"
        fi
    fi
}

desktop_hint() {
    node_address=$(host_address)
    ca_url="https://${node_address:-<node-ip>}:$PORT/kubeos-ca.crt"
    fp=$(fingerprint)
    cat <<HINT
kubeos-trust-ca: on YOUR OWN machine (the one with the browser), pick one:

  Chrome / Edge / Brave on Linux (no GUI):
      certutil -d sql:\$HOME/.pki/nssdb -A -t "C,," -n "$CA_NAME" -i kubeos-ca.crt
      # certutil comes from libnss3-tools; then restart the browser
  Chrome / Edge / Brave on any OS (GUI):
      open $ca_url
      Settings > Privacy and security > Security > Manage certificates > Authorities
      > Import > select kubeos-ca.crt > tick "Trust this certificate for identifying websites"
  Firefox: Settings > Privacy & Security > Certificates > View Certificates > Authorities
      > Import > select kubeos-ca.crt > tick "Trust this CA to identify websites"
  macOS (system trust): sudo security add-trusted-cert -d -r trustRoot \\
      -k /Library/Keychains/System.keychain kubeos-ca.crt

  Expected fingerprint (must match the imported certificate):
      $fp
  Then reload, and delete any OLD "$CA_NAME" entries from an earlier install.
HINT
}

install_browser() {
    [ -n "$NSS_USER" ] || { log "usage: $0 --browser <user>"; exit 2; }
    getent passwd "$NSS_USER" >/dev/null 2>&1 || {
        log "no such local user: $NSS_USER"
        exit 1
    }
    command -v certutil >/dev/null 2>&1 || {
        log "certutil is missing (Debian package libnss3-tools). Not installing it for you."
        desktop_hint
        exit 1
    }
    home=$(getent passwd "$NSS_USER" | cut -d: -f6)
    [ -d "$home" ] || { log "$NSS_USER has no home directory"; exit 1; }
    if [ "$REMOVE" -eq 1 ]; then
        runuser -u "$NSS_USER" -- certutil -d "sql:$home/.pki/nssdb" -D -n "$CA_NAME" 2>/dev/null ||
            log "$CA_NAME was not in $NSS_USER's NSS store"
        log "removed $CA_NAME from $NSS_USER's NSS store"
        return 0
    fi
    mkdir -p "$home/.pki/nssdb"
    chown -R "$NSS_USER":"$(id -gn "$NSS_USER")" "$home/.pki"
    chmod 700 "$home/.pki" "$home/.pki/nssdb"
    [ -f "$home/.pki/nssdb/cert9.db" ] ||
        runuser -u "$NSS_USER" -- certutil -d "sql:$home/.pki/nssdb" -N --empty-password >/dev/null
    # -t "C,," = trusted CA for SSL. Re-adding replaces, so this is safe to re-run after a
    # KubeOS reinstall changed the cluster CA.
    if runuser -u "$NSS_USER" -- certutil -d "sql:$home/.pki/nssdb" -A -t "C,," -n "$CA_NAME" \
        -i "$CA_FILE" 2>/dev/null; then
        log "installed $CA_NAME into $NSS_USER's NSS store (restart that user's browser)"
    else
        log "certutil could not add the CA to $NSS_USER's store (an old copy may be there)"
        log "  remove the old one first: sudo -u $NSS_USER certutil -d sql:$home/.pki/nssdb -D -n '$CA_NAME'"
        exit 1
    fi
}

case $MODE in
    show) show_ca && desktop_hint ;;
    system) install_system ;;
    desktop) desktop_hint ;;
    browser) install_browser ;;
esac
