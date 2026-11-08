/**
 * KubeOS: joining nodes together from the dashboard -- both directions.
 *
 * Two controls, the same on every KubeOS dashboard:
 *
 *   1. "Generate token" (on the machine you want to be the control plane).
 *      Mints an official kubeadm bootstrap token and hands back one string that
 *      carries everything a joining node needs: the API endpoint, the token and the
 *      CA certificate hash. Same three values `kubeadm token create
 *      --print-join-command` produces -- no custom protocol.
 *
 *   2. "Join this node" (on every other machine). Paste that string; this node
 *      discards the one-node cluster a fresh KubeOS install always creates, and runs
 *      the official `kubeadm join` against the control plane.
 *
 * WHY there is no SSH and no credential here any more: the dashboard pod already runs
 * ON the node that must join. A privileged one-shot pod therefore reaches the host
 * through `nsenter` and starts the join as a **transient systemd unit**, which keeps
 * running after the local cluster (and with it this dashboard) is torn down by
 * `kubeadm reset`. So the join needs no password, no key, and nothing is stored
 * anywhere -- the only secret involved is the token, which expires.
 */
import { ApiProxy, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

const NAMESPACE = 'kubeos-system';
const HELPER_IMAGE = 'ghcr.io/skmdab/kubeos-join-helper:0.1.0';
const TOKEN_TTL_MINUTES = 60;
const TOKEN_PREFIX = 'KOSJOIN1.';
const CRI_SOCKET = 'unix:///run/containerd/containerd.sock';

/* -------------------------------------------------------------------------- */
/* Join string: endpoint + token + CA hash, one paste-able value              */
/* -------------------------------------------------------------------------- */

interface JoinBundle {
  endpoint: string;
  token: string;
  caHash: string;
  controlPlane?: string;
}

function encodeJoin(bundle: JoinBundle): string {
  const json = JSON.stringify(bundle);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  bytes.forEach(b => {
    binary += String.fromCharCode(b);
  });
  return TOKEN_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJoin(text: string): JoinBundle {
  const trimmed = text.trim();
  if (!trimmed.startsWith(TOKEN_PREFIX)) {
    throw new Error(
      `That does not look like a KubeOS join token (it must start with ${TOKEN_PREFIX}).`
    );
  }
  const body = trimmed.slice(TOKEN_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  const json = new TextDecoder().decode(
    Uint8Array.from(atob(body + '='.repeat((4 - (body.length % 4)) % 4)), c => c.charCodeAt(0))
  );
  const parsed = JSON.parse(json) as JoinBundle;
  if (!parsed.endpoint || !parsed.token || !parsed.caHash) {
    throw new Error('The join token is incomplete (endpoint, token or CA hash missing).');
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* DER helpers: the CA hash is sha256 over the CA public key                  */
/* -------------------------------------------------------------------------- */

interface Tlv {
  tag: number;
  start: number;
  headerLen: number;
  len: number;
  end: number;
}

function readTlv(buf: Uint8Array, off: number): Tlv {
  const tag = buf[off];
  let len = buf[off + 1];
  let headerLen = 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    len = 0;
    for (let i = 0; i < count; i++) {
      len = (len << 8) | buf[off + 2 + i];
    }
    headerLen = 2 + count;
  }
  return { tag, start: off, headerLen, len, end: off + headerLen + len };
}

function subjectPublicKeyInfo(der: Uint8Array): Uint8Array {
  const certificate = readTlv(der, 0);
  const tbs = readTlv(der, certificate.start + certificate.headerLen);
  let child = readTlv(der, tbs.start + tbs.headerLen);
  if (child.tag === 0xa0) {
    child = readTlv(der, child.end);
  }
  for (let i = 0; i < 5; i++) {
    child = readTlv(der, child.end);
  }
  return der.slice(child.start, child.end);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function certificateHash(caDataBase64: string): Promise<string> {
  // certificate-authority-data is base64 of the PEM text; unwrap it to DER first.
  const pemText = new TextDecoder().decode(base64ToBytes(caDataBase64));
  const derBase64 = pemText.includes('BEGIN CERTIFICATE')
    ? pemText.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, '')
    : caDataBase64;
  const spki = subjectPublicKeyInfo(base64ToBytes(derBase64));
  const digest = await crypto.subtle.digest('SHA-256', spki);
  return `sha256:${Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

async function readClusterInfo(): Promise<{ endpoint: string; caHash: string }> {
  const configMap: any = await ApiProxy.request(
    '/api/v1/namespaces/kube-public/configmaps/cluster-info'
  );
  const kubeconfig: string = configMap?.data?.kubeconfig ?? '';
  const rawEndpoint = kubeconfig.match(/server:\s*(\S+)/)?.[1] ?? '';
  const caData = kubeconfig.match(/certificate-authority-data:\s*(\S+)/)?.[1] ?? '';
  if (!rawEndpoint || !caData) {
    throw new Error('cluster-info has no server address or CA certificate');
  }
  return { endpoint: rawEndpoint.replace(/^https?:\/\//, ''), caHash: await certificateHash(caData) };
}

/* -------------------------------------------------------------------------- */
/* Token minting (a bootstrap-token Secret, which is what kubeadm creates)    */
/* -------------------------------------------------------------------------- */

const TOKEN_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomToken(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => TOKEN_CHARS[b % TOKEN_CHARS.length])
    .join('');
}

async function createBootstrapToken(): Promise<string> {
  const id = randomToken(6);
  const secret = randomToken(16);
  const expiration = new Date(Date.now() + TOKEN_TTL_MINUTES * 60 * 1000)
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z');
  await ApiProxy.post('/api/v1/namespaces/kube-system/secrets', {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `bootstrap-token-${id}`,
      namespace: 'kube-system',
      labels: { 'kubeos.io/join-token': 'dashboard' },
    },
    type: 'bootstrap.kubernetes.io/token',
    data: {
      'token-id': btoa(id),
      'token-secret': btoa(secret),
      'usage-bootstrap-authentication': btoa('true'),
      'usage-bootstrap-signing': btoa('true'),
      'auth-extra-groups': btoa('system:bootstrappers:kubeadm:default-node-token'),
      expiration: btoa(expiration),
      description: btoa('KubeOS dashboard join token'),
    },
  });
  return `${id}.${secret}`;
}

/* -------------------------------------------------------------------------- */
/* Joining: a privileged one-shot pod that hands the work to a systemd unit   */
/* -------------------------------------------------------------------------- */

function bootstrapScript(bundle: JoinBundle): string {
  return `#!/bin/sh
# Started by the KubeOS dashboard as a transient systemd unit, so it survives the
# moment kubeadm reset tears down this machine's single-node cluster.
set -e
systemctl stop kubeos-cluster-setup.service 2>/dev/null || true
mkdir -p /var/lib/kubeos
date -u +'%Y-%m-%dT%H:%M:%SZ' > /var/lib/kubeos/initialized
kubeadm reset -f --cri-socket ${CRI_SOCKET} >/dev/null 2>&1 || true
rm -rf /etc/kubernetes /var/lib/etcd /etc/cni/net.d /var/lib/kubelet/* /root/.kube
systemctl enable containerd.service >/dev/null 2>&1 || true
systemctl start containerd.service >/dev/null 2>&1 || true
n=0
while [ ! -S /run/containerd/containerd.sock ] && [ $n -lt 60 ]; do n=$((n + 1)); sleep 1; done
exec kubeadm join ${bundle.endpoint} --token ${bundle.token} --discovery-token-ca-cert-hash ${bundle.caHash} --cri-socket ${CRI_SOCKET}
`;
}

/** The node this dashboard pod runs on, so the bootstrap pod cannot land elsewhere. */
async function ownNodeName(): Promise<string | undefined> {
  try {
    const pods: any = await ApiProxy.request(`/api/v1/namespaces/${NAMESPACE}/pods`);
    const own = (pods?.items ?? []).find((pod: any) =>
      String(pod.metadata?.name ?? '').startsWith('kubeos-dashboard-headlamp')
    );
    return own?.spec?.nodeName;
  } catch {
    return undefined;
  }
}

async function startSelfJoin(bundle: JoinBundle): Promise<string> {
  const suffix = randomToken(6);
  const jobName = `kubeos-bootstrap-${suffix}`;
  const unitName = `kubeos-self-join-${suffix}`;
  const scriptB64 = btoa(
    String.fromCharCode(...new TextEncoder().encode(bootstrapScript(bundle)))
  );
  const node = await ownNodeName();

  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      name: jobName,
      namespace: NAMESPACE,
      labels: { 'kubeos.io/bootstrap': 'self' },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 300,
      template: {
        metadata: { labels: { 'kubeos.io/bootstrap': 'self' } },
        spec: {
          restartPolicy: 'Never',
          hostPID: true,
          ...(node ? { nodeSelector: { 'kubernetes.io/hostname': node } } : {}),
          tolerations: [{ operator: 'Exists' }],
          containers: [
            {
              name: 'bootstrap',
              image: HELPER_IMAGE,
              imagePullPolicy: 'IfNotPresent',
              securityContext: { privileged: true },
              volumeMounts: [{ name: 'host', mountPath: '/host' }],
              // Write the script onto the host, then hand it to systemd so the join
              // continues after this pod's cluster disappears.
              command: [
                '/bin/sh',
                '-c',
                `set -e
echo ${scriptB64} | base64 -d > /host/root/kubeos-self-join.sh
chmod 0700 /host/root/kubeos-self-join.sh
nsenter -t 1 -m -u -i -n -p -- systemd-run \\
  --unit=${unitName} --collect --property=Type=oneshot \\
  --property=StandardOutput=journal --property=StandardError=journal \\
  /bin/sh /root/kubeos-self-join.sh`,
              ],
            },
          ],
          volumes: [{ name: 'host', hostPath: { path: '/' } }],
        },
      },
    },
  };

  await ApiProxy.post(`/apis/batch/v1/namespaces/${NAMESPACE}/jobs`, job);
  return jobName;
}

/* -------------------------------------------------------------------------- */
/* Small UI pieces                                                            */
/* -------------------------------------------------------------------------- */

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Box component="code" sx={{ fontFamily: 'monospace', fontSize: '0.8rem', wordBreak: 'break-all' }}>
      {children}
    </Box>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <Button
      size="small"
      variant="outlined"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => setCopied(false)
        );
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

function JoinNodePage() {
  const [bundle, setBundle] = React.useState<JoinBundle | null>(null);
  const [generated, setGenerated] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [generateError, setGenerateError] = React.useState<string | null>(null);

  const [pasted, setPasted] = React.useState('');
  const [joinError, setJoinError] = React.useState<string | null>(null);
  const [joinJob, setJoinJob] = React.useState<string | null>(null);
  const [joining, setJoining] = React.useState(false);

  React.useEffect(() => {
    readClusterInfo()
      .then(info => setBundle({ ...info }))
      .catch(() => setBundle(null));
  }, []);

  const generate = async () => {
    setBusy(true);
    setGenerateError(null);
    try {
      const info = bundle ?? (await readClusterInfo());
      const token = await createBootstrapToken();
      const value = encodeJoin({ ...info, token });
      setGenerated(value);
      setBundle(info);
    } catch (err: any) {
      setGenerateError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    setJoining(true);
    setJoinError(null);
    try {
      const decoded = decodeJoin(pasted);
      // Guard against pasting a token that this very node generated: joining yourself
      // tears down the cluster the dashboard is running in and goes nowhere. The
      // maintainer hit exactly this on 2026-11-08.
      try {
        const here = await readClusterInfo();
        if (here.endpoint === decoded.endpoint) {
          throw new Error(
            `That token was generated by THIS node (${decoded.endpoint}). Use the dashboard of ` +
              'the node you chose as the control plane to generate the token, then paste it here.'
          );
        }
      } catch (err: any) {
        if (String(err?.message ?? '').includes('generated by THIS node')) {
          throw err;
        }
        // If this node cannot read its own cluster-info any more, let the join proceed.
      }
      const jobName = await startSelfJoin(decoded);
      setJoinJob(jobName);
      setPasted('');
    } catch (err: any) {
      setJoinError(String(err?.message ?? err));
    } finally {
      setJoining(false);
    }
  };

  return (
    <>
      <SectionBox title="1. This node is the control plane — generate a token">
        <Typography variant="body2" sx={{ mb: 2, opacity: 0.8 }}>
          <strong>Use this only on the node you choose as the control plane.</strong> Click,
          copy the string, then paste it into the <em>Join</em> box on every <em>other</em>
          KubeOS node — never into this same dashboard. It carries the API address, a kubeadm bootstrap token valid for{' '}
          {TOKEN_TTL_MINUTES} minutes, and this cluster's CA fingerprint — the same three
          values <Mono>kubeadm token create --print-join-command</Mono> prints.
        </Typography>

        <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2 }}>
          <Button variant="contained" onClick={generate} disabled={busy}>
            {busy ? 'Generating…' : 'Generate token'}
          </Button>
          {generated && <CopyButton text={generated} label="Copy token" />}
        </Box>

        {generateError && <Typography color="error">{generateError}</Typography>}

        {generated && (
          <Box
            component="pre"
            sx={{
              p: 2,
              borderRadius: 1,
              bgcolor: 'background.default',
              border: '1px solid rgba(163,240,0,0.25)',
              fontSize: '0.75rem',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {generated}
          </Box>
        )}

        {bundle && (
          <Typography variant="caption" sx={{ display: 'block', mt: 1, opacity: 0.7 }}>
            Control plane endpoint: <Mono>{bundle.endpoint}</Mono> · CA hash:{' '}
            <Mono>{bundle.caHash}</Mono>
          </Typography>
        )}
      </SectionBox>

      <SectionBox title="2. Join this node to a control plane">
        <Typography variant="body2" sx={{ mb: 2, opacity: 0.8 }}>
          Paste the token generated on the control plane. This machine will discard the
          one-node cluster its install created and join that control plane with the
          official <Mono>kubeadm join</Mono>. <strong>This dashboard goes away</strong>{' '}
          while that happens — watch the node appear on the control plane's dashboard.
        </Typography>

        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <TextField
            label="Control plane token"
            placeholder="KOSJOIN1.…"
            value={pasted}
            onChange={e => setPasted(e.target.value)}
            size="small"
            multiline
            minRows={2}
            sx={{ flex: 1, minWidth: 320 }}
          />
          <Button variant="contained" onClick={join} disabled={joining || !pasted.trim()}>
            {joining ? 'Starting…' : 'Join this node'}
          </Button>
        </Box>

        {joinError && (
          <Typography color="error" sx={{ mt: 1 }}>
            {joinError}
          </Typography>
        )}

        {joinJob && (
          <Typography variant="body2" sx={{ mt: 2 }}>
            Join started on this node (job <Mono>{joinJob}</Mono>). A transient systemd
            unit now runs independently of this cluster, so it
            finishes even though this dashboard is about to disappear. Check on the
            control plane: <Mono>kubectl get nodes</Mono>
          </Typography>
        )}
      </SectionBox>
    </>
  );
}

registerSidebarEntry({
  parent: null,
  name: 'kubeos-add-node',
  label: 'Join node',
  url: '/kubeos-add-node',
  icon: 'mdi:server-plus',
});

registerRoute({
  path: '/kubeos-add-node',
  sidebar: 'kubeos-add-node',
  name: 'kubeos-add-node',
  exact: true,
  component: JoinNodePage,
});
