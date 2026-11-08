#!/bin/sh
# KubeOS join helper: make one machine join this cluster, over SSH.
#
# WHY a container: the dashboard's own image has no ssh client, and the join has to
# run ON the target machine (kubeadm lives there). So the dashboard starts this as a
# one-shot Job, gives it one node's address + credential, and reads the log.
#
# The credential is supplied as an environment variable for the duration of this pod
# only; nothing stores it afterwards.
#
# TWO WAYS IN, because a stock KubeOS node refuses root logins by password
# (Debian's `PermitRootLogin prohibit-password`):
#   * NODE_USER=root            -> the steps run directly over ssh;
#   * any other user            -> the steps are written to a temp file on the node and
#                                 run through sudo: `sudo -S` with the password, or
#                                 `sudo -n` when the key's user has NOPASSWD sudo.
# The normal user the KubeOS installer creates is already in group sudo, so no sshd
# change is needed on the node.
set -eu

: "${NODE_ADDR:?node address is required}"
: "${JOIN_ENDPOINT:?cluster endpoint is required}"
: "${JOIN_TOKEN:?join token is required}"
: "${CA_HASH:?CA hash is required}"
NODE_USER="${NODE_USER:-root}"
CRI_SOCKET="${CRI_SOCKET:-unix:///run/containerd/containerd.sock}"

say() { echo "kubeos-join: $*"; }

SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR"

if [ -n "${NODE_PASSWORD:-}" ]; then
    say "using password authentication for ${NODE_USER}@${NODE_ADDR}"
    # sshpass is needed because ssh reads passwords from a terminal, not stdin.
    run_ssh() { sshpass -p "$NODE_PASSWORD" ssh $SSH_OPTS "$NODE_USER@$NODE_ADDR" "$@"; }
elif [ -n "${NODE_KEY:-}" ]; then
    say "using key authentication for ${NODE_USER}@${NODE_ADDR}"
    printf '%s\n' "$NODE_KEY" > /tmp/id_join
    chmod 600 /tmp/id_join
    run_ssh() { ssh -i /tmp/id_join $SSH_OPTS "$NODE_USER@$NODE_ADDR" "$@"; }
else
    echo "kubeos-join: ERROR either NODE_PASSWORD or NODE_KEY must be set" >&2
    exit 1
fi

say "checking that the machine answers on ssh"
if ! run_ssh 'echo reachable'; then
    echo "kubeos-join: ERROR cannot ssh to ${NODE_USER}@${NODE_ADDR}" >&2
    exit 1
fi

# The body that must run AS ROOT on the target machine. This heredoc is unquoted, so
# this shell expands the variables meant for it -- and would also expand anything else
# with a dollar in it, including inside comments. Keep body comments dollar-free, and
# escape the loop counter.
body=$(cat <<REMOTE
set -e
systemctl stop kubeos-cluster-setup.service 2>/dev/null || true
mkdir -p /var/lib/kubeos
date -u +'%Y-%m-%dT%H:%M:%SZ' > /var/lib/kubeos/initialized
kubeadm reset -f --cri-socket ${CRI_SOCKET} >/dev/null 2>&1 || true
rm -rf /etc/kubernetes /var/lib/etcd /etc/cni/net.d /var/lib/kubelet/* /root/.kube
systemctl enable containerd.service >/dev/null 2>&1 || true
systemctl start containerd.service >/dev/null 2>&1 || true
i=0
while [ ! -S "${CRI_SOCKET#unix://}" ] && [ \$i -lt 60 ]; do i=\$((i + 1)); sleep 1; done
if [ ! -S "${CRI_SOCKET#unix://}" ]; then
  echo "kubeos-join: ERROR the container runtime socket ${CRI_SOCKET} never appeared" >&2
  exit 1
fi
echo "kubeos-join: reset done, container runtime ready, running kubeadm join"
kubeadm join ${JOIN_ENDPOINT} --token ${JOIN_TOKEN} --discovery-token-ca-cert-hash ${CA_HASH} --cri-socket ${CRI_SOCKET}
REMOTE
)

fail() {
    echo "kubeos-join: ERROR the join failed on ${NODE_ADDR}" >&2
    exit 1
}

if [ "$NODE_USER" = "root" ]; then
    say "running the privileged steps as root"
    printf '%s\n' "$body" | run_ssh 'sh -s' || fail
else
    # A non-root user needs sudo. The script goes to a file first, because sudo takes
    # the password on stdin and the script would otherwise be competing for it.
    b64=$(printf '%s\n' "$body" | base64 | tr -d '\n')
    say "user ${NODE_USER} is not root: running the privileged steps through sudo"
    if [ -n "${NODE_PASSWORD:-}" ]; then
        run_ssh "echo ${b64} | base64 -d > /tmp/kubeos-join.sh; echo '${NODE_PASSWORD}' | sudo -S -p '' sh /tmp/kubeos-join.sh; rc=\$?; rm -f /tmp/kubeos-join.sh; exit \$rc" || fail
    else
        run_ssh "echo ${b64} | base64 -d > /tmp/kubeos-join.sh; sudo -n sh /tmp/kubeos-join.sh; rc=\$?; rm -f /tmp/kubeos-join.sh; exit \$rc" || fail
    fi
fi

say "node ${NODE_ADDR} joined ${JOIN_ENDPOINT}"
