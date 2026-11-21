/**
 * KubeOS etcd snapshots page: take, list, download and delete etcd backups of this machine.
 *
 * WHY: on a KubeOS node the control plane is a set of host services and the cluster state lives
 * in one etcd on one machine. A snapshot is the only thing that can rescue that state after a
 * bad upgrade or a wiped node, and there was no way to take one except an SSH session and a
 * hand-typed etcdctl command with the right four certificate paths (user asked for this page,
 * 2026-11-12).
 *
 * WHY IT GOES THROUGH kubeos-console.service AND NOT A POD: the standing rule is that no button
 * may create a Pod, and this is exactly the case where a Pod would be tempting - the PKI is on
 * the host. The console service already runs as root on the machine, so it runs etcdctl there
 * and streams the file back; nothing is created in the cluster.
 *
 * WHAT IT DOES NOT DO, on purpose: restore. Restoring stops and rewrites etcd, i.e. it takes the
 * API server (and this dashboard) down in the middle of the operation, so it stays a documented
 * CLI procedure rather than a button that can strand a node. The page says where.
 */
import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import React from 'react';

import { consoleConfig, consoleFetch, consoleJson, consoleUrl } from './consoleapi';

interface Snapshot {
  name: string;
  bytes: number;
  modified: number;
}

const LIME = '#c4ff2e';
const RED = '#ff8080';
const DIM = '#9aa596';

function human(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function when(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function KubeosSnapshotsPage() {
  const [snapshots, setSnapshots] = React.useState<Snapshot[] | null>(null);
  const [directory, setDirectory] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [token, setToken] = React.useState('');

  const load = React.useCallback(async () => {
    try {
      const config = await consoleConfig();
      setToken(config.token);
      const answer = await consoleFetch(config, '/etcd/snapshots');
      const body = await consoleJson<any>(answer);
      if (body?.ok === false) {
        throw new Error(String(body.error ?? 'the console refused the request'));
      }
      setSnapshots(body.snapshots ?? []);
      setDirectory(String(body.directory ?? ''));
      setError(null);
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
      setSnapshots([]);
    }
  }, []);

  React.useEffect(() => {
    load();
  }, [load]);

  const takeSnapshot = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = await consoleConfig();
      const answer = await consoleFetch(config, '/etcd/snapshot', { method: 'POST' });
      const body = await consoleJson<any>(answer);
      if (!answer.ok || body?.ok === false) {
        throw new Error(String(body?.error ?? `HTTP ${answer.status}`));
      }
      await load();
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      const config = await consoleConfig();
      const answer = await consoleFetch(config, `/etcd/snapshot?name=${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });
      const body = await consoleJson<any>(answer);
      if (!answer.ok || body?.ok === false) {
        throw new Error(String(body?.error ?? `HTTP ${answer.status}`));
      }
      await load();
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setBusy(false);
    }
  };

  const unsupported = error?.includes('not a control plane');

  return (
    <SectionBox title="etcd snapshots">
      <Typography variant="body2" sx={{ mb: 2, opacity: 0.75 }}>
        A snapshot of this machine&apos;s etcd - the cluster&apos;s only copy of its state. Taken by
        the node itself (<code>kubeos-console</code> runs <code>etcdctl</code>), so nothing is created
        in the cluster.
        {directory ? (
          <>
            {' '}
            Stored in <code>{directory}</code>.
          </>
        ) : null}
      </Typography>

      <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', mb: 2 }}>
        <Button variant="contained" onClick={takeSnapshot} disabled={busy || unsupported}
          sx={{ bgcolor: LIME, color: '#0b0b0b', fontWeight: 700, '&:hover': { bgcolor: '#d3ff5c' } }}>
          {busy ? 'working…' : 'Take snapshot'}
        </Button>
        <Button variant="outlined" onClick={load} disabled={busy}>
          Refresh
        </Button>
      </Box>

      {error && (
        <Typography variant="body2" sx={{ mb: 2, color: RED }}>
          {unsupported
            ? 'This machine is not a control plane, so it has no etcd to snapshot. Open the dashboard on the control plane instead.'
            : `error: ${error}`}
        </Typography>
      )}

      {snapshots === null && !error && (
        <Typography variant="body2" sx={{ opacity: 0.7 }}>
          reading…
        </Typography>
      )}

      {snapshots !== null && snapshots.length === 0 && !error && (
        <Typography variant="body2" sx={{ color: DIM }}>
          No snapshots yet. Take one before an upgrade - it is the only way back.
        </Typography>
      )}

      {snapshots !== null && snapshots.length > 0 && (
        <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
          <Box component="thead">
            <Box component="tr" sx={{ textAlign: 'left', color: DIM, fontSize: '0.72rem' }}>
              <Box component="th" sx={{ py: 0.5 }}>file</Box>
              <Box component="th" sx={{ py: 0.5 }}>taken</Box>
              <Box component="th" sx={{ py: 0.5 }}>size</Box>
              <Box component="th" sx={{ py: 0.5, textAlign: 'right' }}>actions</Box>
            </Box>
          </Box>
          <Box component="tbody">
            {snapshots.map(entry => (
              <Box component="tr" key={entry.name} sx={{ borderTop: '1px solid #1d211c' }}>
                <Box component="td" sx={{ py: 0.6, pr: 2, fontSize: '0.82rem' }}>{entry.name}</Box>
                <Box component="td" sx={{ py: 0.6, pr: 2, fontSize: '0.82rem', color: DIM }}>
                  {when(entry.modified)}
                </Box>
                <Box component="td" sx={{ py: 0.6, pr: 2, fontSize: '0.82rem' }}>{human(entry.bytes)}</Box>
                <Box component="td" sx={{ py: 0.6, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <Button size="small"
                    href={consoleUrl(`/etcd/snapshot?name=${encodeURIComponent(entry.name)}&token=${encodeURIComponent(token)}`)}
                    target="_blank" rel="noopener">
                    Download
                  </Button>
                  <Button size="small" color="inherit" disabled={busy} onClick={() => remove(entry.name)}
                    sx={{ color: '#ff9494' }}>
                    Delete
                  </Button>
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      )}

      <Typography variant="caption" sx={{ display: 'block', mt: 2, color: DIM }}>
        Restoring is deliberately not a button: it stops etcd and the API server (this dashboard
        included) while it rewrites the data directory. On the node:
        <br />
        <code>
          systemctl stop kubeos-dashboard kubeos-dashboard-auth kubeos-console kube-apiserver etcd
        </code>
        <br />
        <code>
          ETCDCTL_API=3 etcdctl snapshot restore /var/lib/kubeos/etcd-snapshots/&lt;file&gt;
          --data-dir=/var/lib/etcd
        </code>
        <br />
        <code>systemctl start etcd kube-apiserver kubeos-dashboard kubeos-dashboard-auth kubeos-console</code>
      </Typography>
    </SectionBox>
  );
}

registerSidebarEntry({
  parent: null,
  name: 'kubeos-snapshots',
  label: 'Snapshots',
  url: '/kubeos-snapshots',
  icon: 'mdi:content-save-outline',
});

registerRoute({
  path: '/kubeos-snapshots',
  sidebar: 'kubeos-snapshots',
  name: 'kubeos-snapshots',
  exact: true,
  component: KubeosSnapshotsPage,
});
