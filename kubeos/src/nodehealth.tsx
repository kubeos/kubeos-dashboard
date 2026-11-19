/**
 * KubeOS node health card: the facts about the machine itself, on the Node page.
 *
 * WHY: the Kubernetes API knows whether a node is Ready, and nothing else that matters in an
 * appliance. The failures that actually take a KubeOS node down are local - a failed systemd
 * unit, the disk holding container images and pod data filling up, a kernel or containerd that
 * no longer matches what the platform expects - and none of them appear anywhere in Headlamp.
 * Today the only way to see them is an SSH session (user asked for this card, 2026-11-12).
 *
 * WHERE THE DATA COMES FROM: the login gateway on THIS machine (`/kubeos-node-health`), which
 * reads /proc, `systemctl --failed` and `df` as root. Nothing is written, no Pod is created and
 * the cluster is never touched, so the card also works on a node that belongs to no cluster.
 *
 * HONEST LIMIT, stated on the card: host facts are per MACHINE, and a dashboard is served by one
 * machine. Opening another node's page shows that node's cluster record plus this machine's
 * health, and the card says which machine it is describing.
 */
import { registerDetailsViewSection } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import React from 'react';

interface Disk {
  path: string;
  total_bytes: number;
  free_bytes: number;
  used_percent: number;
}

interface Health {
  hostname: string;
  os?: string;
  kernel?: string;
  uptime_seconds?: number;
  load?: string;
  failed_units?: string[];
  disks?: Disk[];
  versions?: Record<string, string>;
  membership?: { state: string; detail: string };
}

const LIME = '#c4ff2e';
const RED = '#ff8080';
const DIM = '#9aa596';

function humanBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function humanUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** One label/value row; `tone` colours the value like the rest of the KubeOS UI. */
function Row({ label, value, tone }: { label: string; value: React.ReactNode; tone?: 'ok' | 'bad' | 'dim' }) {
  const colour = tone === 'ok' ? LIME : tone === 'bad' ? RED : tone === 'dim' ? DIM : undefined;
  return (
    <Box component="tr">
      <Box component="th"
        sx={{ textAlign: 'left', py: 0.45, pr: 2, color: DIM, fontWeight: 600, fontSize: '0.72rem', width: 150, verticalAlign: 'top' }}>
        {label}
      </Box>
      <Box component="td" sx={{ py: 0.45, fontSize: '0.82rem', color: colour, verticalAlign: 'top' }}>
        {value}
      </Box>
    </Box>
  );
}

function NodeHealthSection({ resource }: any) {
  const [health, setHealth] = React.useState<Health | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetch('/kubeos-node-health', { headers: { Accept: 'application/json' } })
      .then(answer => (answer.ok ? answer.json() : Promise.reject(new Error(`HTTP ${answer.status}`))))
      .then((body: Health) => {
        if (!cancelled) setHealth(body);
      })
      .catch((reason: any) => {
        if (!cancelled) setError(String(reason?.message ?? reason));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only the Node page gets this card.
  if (resource?.kind !== 'Node') return null;

  const serving = health?.hostname ?? '';
  const viewing = String(resource?.metadata?.name ?? '');
  const otherMachine = serving !== '' && viewing !== '' && serving !== viewing;
  const failed = health?.failed_units ?? [];
  const member = health?.membership?.state;

  return (
    <SectionBox title="KubeOS node health">
      <Typography variant="body2" sx={{ mb: 1.5, opacity: 0.75 }}>
        Read from <strong>{serving || 'this machine'}</strong> itself - systemd, the disks and the
        installed versions. It is not part of the cluster API, so it is available even when this
        machine belongs to no cluster.
      </Typography>

      {otherMachine && (
        <Typography variant="caption" sx={{ display: 'block', mb: 1.5, color: DIM }}>
          This page is about <strong>{viewing}</strong>, but the dashboard is served by{' '}
          <strong>{serving}</strong>, so the health below describes {serving}. For{' '}
          {viewing}&apos;s own health, open <code>https://{viewing}:30443</code>.
        </Typography>
      )}

      {error && (
        <Typography variant="body2" color="error" sx={{ mb: 1 }}>
          could not read this machine&apos;s health: {error}
        </Typography>
      )}

      {!health && !error && (
        <Typography variant="body2" sx={{ opacity: 0.7 }}>
          reading&hellip;
        </Typography>
      )}

      {health && (
        <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse' }}>
          <Box component="tbody">
            <Row label="machine" value={health.hostname} />
            <Row label="in a cluster"
              value={member === 'member' ? 'yes' : member === 'detached' ? 'no' : 'unknown'}
              tone={member === 'member' ? 'ok' : member === 'detached' ? 'bad' : 'dim'} />
            <Row label="failed units"
              value={failed.length === 0 ? 'none' : `${failed.length}: ${failed.join(', ')}`}
              tone={failed.length === 0 ? 'ok' : 'bad'} />
            {health.disks?.map(disk => (
              <Row key={disk.path} label={`disk ${disk.path}`}
                value={`${disk.used_percent}% used · ${humanBytes(disk.free_bytes)} free of ${humanBytes(disk.total_bytes)}`}
                tone={disk.used_percent >= 90 ? 'bad' : disk.used_percent >= 80 ? undefined : 'ok'} />
            ))}
            {health.uptime_seconds !== undefined && (
              <Row label="uptime" value={humanUptime(health.uptime_seconds)} />
            )}
            {health.load && <Row label="load (1/5/15)" value={health.load} />}
            {health.kernel && <Row label="kernel" value={health.kernel} />}
            {health.os && <Row label="system" value={health.os} />}
            {Object.entries(health.versions ?? {}).map(([name, raw]) => (
              <Row key={name} label={name} value={String(raw)} tone="dim" />
            ))}
          </Box>
        </Box>
      )}
    </SectionBox>
  );
}

registerDetailsViewSection(NodeHealthSection);
