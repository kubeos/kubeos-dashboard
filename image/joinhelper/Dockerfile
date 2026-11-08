# One-shot helper that adds a machine to the cluster over SSH.
#
# Deliberately tiny: an SSH client and nothing else. kubeadm is NOT here -- it runs on
# the target node, which is where the join must happen.
FROM docker.io/library/alpine:3.20

RUN apk add --no-cache openssh-client sshpass

COPY join.sh /join.sh
RUN chmod 0755 /join.sh

ENTRYPOINT ["/bin/sh", "/join.sh"]
