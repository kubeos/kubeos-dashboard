#!/bin/sh
# WHEN   run as root on a node that should stop serving the dashboard:
#            ./uninstall.sh            stop, disable, remove files, keep the user
#            ./uninstall.sh --purge    also remove the user and /var/lib/kubeos-dashboard
# WHY    The dashboard is a host service now, so removing it must not leave a unit that
#        fails at every boot, nor a privileged user behind.
# SAFE   Idempotent and additive in reverse: it names every path it deletes.
set -eu

log() { printf 'uninstall-dashboard: %s\n' "$*"; }
die() { printf 'uninstall-dashboard: ERROR: %s\n' "$*" >&2; exit 1; }

SERVICE=kubeos-dashboard
RUN_USER=kubeos-dashboard
PURGE=0

for arg in "$@"; do
    case $arg in
        --purge) PURGE=1 ;;
        -h | --help) printf 'Usage: %s [--purge]\n' "$0"; exit 0 ;;
        *) die "unknown argument: $arg" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "run as root"

if systemctl list-unit-files 2>/dev/null | grep -q "^$SERVICE.service"; then
    systemctl stop "$SERVICE" 2>/dev/null || true
    systemctl disable "$SERVICE" >/dev/null 2>&1 || true
fi

rm -f "/etc/systemd/system/$SERVICE.service" "/etc/default/$SERVICE"
systemctl daemon-reload
log "service removed"

# Config and secrets go; the state directory only on --purge, because a future install
# would otherwise lose Headlamp's own preferences for the node.
rm -rf /usr/lib/kubeos-dashboard /usr/share/kubeos-dashboard /etc/kubeos-dashboard
log "binary, frontend, plugin, kubeconfig and certificate removed"

if [ "$PURGE" -eq 1 ]; then
    rm -rf /var/lib/kubeos-dashboard
    if id "$RUN_USER" >/dev/null 2>&1; then
        userdel "$RUN_USER" 2>/dev/null || true
        log "state directory and user $RUN_USER removed"
    fi
else
    log "kept /var/lib/kubeos-dashboard and the user $RUN_USER (use --purge to remove them)"
fi
