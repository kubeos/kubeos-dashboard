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
 * WHY there is no SSH, no key and no pod: the dashboard already runs ON the node that
 * must join, and that node runs `kubeos-console.service` (the same service behind Shell,
 * Restart, Power off and the NFS browser). "Join this node" is one authenticated POST to
 * it; the service starts `kubeos-node-join` as a **transient systemd unit**, which keeps
 * running after `kubeadm reset` tears down the local cluster - and with it this dashboard.
 * Nothing is created in the cluster (user rule 2026-11-12: no button may create a pod).
 * The only secret involved is the bootstrap token, which expires.
 */
import { ApiProxy, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

import { consoleConfig, consoleFetch, consoleJson } from './consoleapi';

const NAMESPACE = 'kubeos-system';
const TOKEN_TTL_MINUTES = 60;
const TOKEN_PREFIX = 'KOSJOIN1.';

/* -------------------------------------------------------------------------- */
/* Join string: endpoint + token + CA hash, one paste-able value              */
/* -------------------------------------------------------------------------- */

interface JoinBundle {
  endpoint: string;
  token: string;
  caHash: string;
  controlPlane?: string;
  /**
   * A kubeconfig for THIS dashboard, as `kubeos-dashboard` on the control plane. The joining
   * node runs `install.sh` with it after the join, so its dashboard points at the joined
   * cluster instead of the one `kubeadm reset` deleted - otherwise the browser shows
   * "Failed to get authentication information" (user hit exactly that, twice, 2026-11-12).
   */
  kubeconfig?: string;
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

/** What a control plane can tell a joining node before any token exists. */
interface ClusterInfo {
  endpoint: string;
  caHash: string;
  /** base64 CA from cluster-info: what a handover kubeconfig must trust. */
  caData?: string;
}

async function readClusterInfo(): Promise<ClusterInfo> {
  const configMap: any = await ApiProxy.request(
    '/api/v1/namespaces/kube-public/configmaps/cluster-info'
  );
  const kubeconfig: string = configMap?.data?.kubeconfig ?? '';
  const rawEndpoint = kubeconfig.match(/server:\s*(\S+)/)?.[1] ?? '';
  const caData = kubeconfig.match(/certificate-authority-data:\s*(\S+)/)?.[1] ?? '';
  if (!rawEndpoint || !caData) {
    throw new Error('cluster-info has no server address or CA certificate');
  }
  return {
    endpoint: rawEndpoint.replace(/^https?:\/\//, ''),
    caHash: await certificateHash(caData),
    caData,
  };
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
/* The joining node's own dashboard identity (a service account, not a Pod)    */
/* -------------------------------------------------------------------------- */

const DASHBOARD_SA = 'kubeos-dashboard';
const DASHBOARD_CRB = 'kubeos:dashboard-join';

/**
 * Mint a kubeconfig for the joining node's dashboard and hand it over inside the join string.
 *
 * WHY: after `kubeadm reset` the joining node's dashboard has no cluster to talk to, so it
 * shows "Failed to get authentication information". The node cannot invent cluster access by
 * itself - a worker only holds a kubelet identity - so the control plane has to give it one.
 * A ServiceAccount + ClusterRoleBinding + token Secret is the least machinery that works, it
 * needs no certificate authority, and it is exactly as privileged as the dashboard's own
 * kubeconfig already is (Headlamp shows everything). Nothing is created by a *button click on
 * the joining node*; this runs on the control plane whose dashboard is doing the joining.
 */
async function dashboardKubeconfig(endpoint: string, caData: string): Promise<string> {
  const ignoreExists = async (run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (!message.includes('409') && !message.toLowerCase().includes('already exists')) {
        throw new Error(`could not prepare the dashboard identity: ${message}`);
      }
    }
  };

  await ignoreExists(() =>
    ApiProxy.post(`/api/v1/namespaces/${NAMESPACE}/serviceaccounts`, {
      apiVersion: 'v1',
      kind: 'ServiceAccount',
      metadata: { name: DASHBOARD_SA, namespace: NAMESPACE, labels: { 'kubeos.io/join': 'dashboard' } },
    })
  );
  await ignoreExists(() =>
    ApiProxy.post('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings', {
      apiVersion: 'rbac.authorization.k8s.io/v1',
      kind: 'ClusterRoleBinding',
      metadata: { name: DASHBOARD_CRB, labels: { 'kubeos.io/join': 'dashboard' } },
      roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: 'cluster-admin' },
      subjects: [{ kind: 'ServiceAccount', name: DASHBOARD_SA, namespace: NAMESPACE }],
    })
  );
  const secretName = `${DASHBOARD_SA}-token`;
  await ignoreExists(() =>
    ApiProxy.post(`/api/v1/namespaces/${NAMESPACE}/secrets`, {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: {
        name: secretName,
        namespace: NAMESPACE,
        labels: { 'kubeos.io/join': 'dashboard' },
        annotations: { 'kubernetes.io/service-account.name': DASHBOARD_SA },
      },
      type: 'kubernetes.io/service-account-token',
    })
  );

  // The token controller fills `data.token` a moment after the Secret exists.
  let token = '';
  for (let attempt = 0; attempt < 20 && !token; attempt++) {
    const answer: any = await ApiProxy.request(
      `/api/v1/namespaces/${NAMESPACE}/secrets/${secretName}`
    );
    const secret = answer?.json ?? answer;
    token = secret?.data?.token ? atob(String(secret.data.token)) : '';
    if (!token) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  if (!token) {
    throw new Error('the cluster did not issue a dashboard token within 10 seconds');
  }

  return `apiVersion: v1
kind: Config
clusters:
- name: kubeos
  cluster:
    server: https://${endpoint}
    certificate-authority-data: ${caData}
users:
- name: ${DASHBOARD_SA}
  user:
    token: ${token}
contexts:
- name: main
  context:
    cluster: kubeos
    user: ${DASHBOARD_SA}
current-context: main
`;
}

/* -------------------------------------------------------------------------- */
/* Joining: the node's own console service does the work, never a pod          */
/* -------------------------------------------------------------------------- */

/**
 * Hand the join string to `kubeos-console.service` on this node.
 *
 * WHY NOT A POD: user decision 2026-11-12 - no dashboard button may create a Pod, now or
 * later. The old version created a privileged Job that `nsenter`ed into the host; this one
 * is a single authenticated POST, and the service runs the join as a transient **systemd
 * unit**, which is also what lets it keep going after `kubeadm reset` deletes the cluster
 * this page is talking to.
 *
 * The service answers 202 as soon as the unit is started, so the caller must tell the
 * operator that this page is about to lose its cluster - not wait for a result that cannot
 * arrive here.
 */
async function startSelfJoin(bundle: JoinBundle): Promise<string> {
  const config = await consoleConfig();
  const response = await consoleFetch(config, '/action/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bundle: encodeJoin(bundle) }),
  });
  const body = await consoleJson<{ unit?: string; detail?: string }>(response);
  return body.detail ?? `the join is running as ${body.unit ?? 'a systemd unit'} on this node`;
}

/* -------------------------------------------------------------------------- */
/* Watching a join to the end - deliberately OUTSIDE React                    */
/* -------------------------------------------------------------------------- */

/**
 * WHY MODULE SCOPE: by the end of a join this dashboard's own API server has been replaced, so
 * Headlamp is painting "Lost connection / Bad Gateway" and may unmount the page that started the
 * join at any moment. A watcher living in a component dies with it, which is exactly what the
 * user hit: the join finished, the tab stayed on the red error, and only a manual reload brought
 * the dashboard back (2026-11-12). A timer on `window` is not unmounted.
 *
 * WHY THE RELOAD WAITS FOR `/healthz`: the join ends by restarting the three dashboard units. A
 * reload fired in that gap lands on the BROWSER'S error page, which is the same complaint in
 * another costume; so the tab is reloaded only once the gateway answers again.
 */
const JOIN_STATES_RUNNING = ['active', 'activating', 'deactivating', 'reloading'];
const JOIN_START_GRACE_MS = 8000;
const RELOAD_TRIES = 90; // 90 x 2 s = 3 min, then reload regardless
let joinWatchTimer: number | undefined;

function isJoinUnitRunning(state: any): boolean {
  return JOIN_STATES_RUNNING.includes(String(state?.state?.ActiveState ?? ''));
}

async function readJoinUnitState(): Promise<any | null> {
  try {
    const config = await consoleConfig();
    const answer = await consoleFetch(config, '/action/join');
    return await consoleJson<any>(answer);
  } catch {
    // the console restarts with the rest of the dashboard during a join: that is expected
    return null;
  }
}

async function reloadOnceDashboardAnswers(): Promise<void> {
  for (let attempt = 0; attempt < RELOAD_TRIES; attempt++) {
    try {
      const probe = await fetch('/healthz', { cache: 'no-store' });
      if (probe.ok) {
        window.location.reload();
        return;
      }
    } catch {
      // still restarting - try again in a moment
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  window.location.reload();
}

function watchJoinUntilDone(startedAt: number): void {
  if (joinWatchTimer !== undefined) {
    return;
  }
  let seenRunning = false;
  let finishing = false;
  joinWatchTimer = window.setInterval(async () => {
    if (finishing) {
      return;
    }
    const body = await readJoinUnitState();
    if (body === null) {
      return; // console unreachable: keep waiting, the unit is still running
    }
    if (isJoinUnitRunning(body)) {
      seenRunning = true;
      return;
    }
    // Before the unit exists the console still reports the PREVIOUS run's state, so "not
    // running" is only believed once it has been seen running or a few seconds have passed.
    if (!seenRunning && Date.now() - startedAt < JOIN_START_GRACE_MS) {
      return;
    }
    finishing = true;
    if (joinWatchTimer !== undefined) {
      window.clearInterval(joinWatchTimer);
      joinWatchTimer = undefined;
    }
    await reloadOnceDashboardAnswers();
  }, 3000);
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
  const [bundle, setBundle] = React.useState<ClusterInfo | null>(null);
  const [generated, setGenerated] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [generateError, setGenerateError] = React.useState<string | null>(null);

  const [pasted, setPasted] = React.useState('');
  const [joinError, setJoinError] = React.useState<string | null>(null);
  const [joinNotice, setJoinNotice] = React.useState<string | null>(null);
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
      const bootstrap = await createBootstrapToken();
      // The kubeconfig is best effort: without it the join still works and the node's
      // dashboard can be re-pointed by hand; with it, the join finishes with the dashboard
      // already correct.
      let handover = '';
      try {
        if (info.caData) {
          handover = await dashboardKubeconfig(info.endpoint, info.caData);
        }
      } catch (err: any) {
        setGenerateError(`join string generated, but the dashboard handover failed: ${String(
          err?.message ?? err
        )}`);
      }
      const value = encodeJoin({ ...info, token: bootstrap, kubeconfig: handover });
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
      const startedAt = Date.now();
      setJoinNotice(await startSelfJoin(decoded));
      // Module-level on purpose: this component may be unmounted by Headlamp's own error screen
      // long before the join ends, and the tab must still reload itself (user, 2026-11-12).
      watchJoinUntilDone(startedAt);
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
            {joining ? (
              <>
                <CircularProgress size={14} sx={{ color: '#0b0b0b', mr: 1 }} />
                Starting…
              </>
            ) : (
              'Join this node'
            )}
          </Button>
        </Box>

        {joinError && (
          <Typography color="error" sx={{ mt: 1 }}>
            {joinError}
          </Typography>
        )}

        {joinNotice && (
          // A full-screen notice, not a card inside the page: everything else on this page is
          // about to become wrong (it reads the cluster being discarded), and the user asked for
          // exactly two lines and nothing else on screen while the join runs.
          <Box
            sx={{
              position: 'fixed',
              inset: 0,
              zIndex: 2500,
              bgcolor: '#0b0b0b',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              p: 4,
              textAlign: 'center',
            }}
          >
            <CircularProgress size={40} sx={{ color: '#c4ff2e' }} />
            <Typography variant="body1" sx={{ fontWeight: 700, color: '#c4ff2e' }}>
              Joining… do not close this tab
            </Typography>
            <Typography variant="body2" sx={{ color: '#c9cfc6', maxWidth: 540 }}>
              {joinNotice}
            </Typography>
          </Box>
        )}
      </SectionBox>
    </>
  );
}

registerSidebarEntry({
  parent: null,
  name: 'kubeos-add-node',
  label: 'Join Cluster',
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
