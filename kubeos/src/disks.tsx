/**
 * KubeOS "Disks" section: LVM volume groups and LVM thin pools.
 *
 * SHAPE (user decision 2026-11-10, from the Proxmox VE screenshot): a top-level
 * "Disks" group whose only two sub-pages are "LVM" and "LVM-Thin", and the group
 * itself sits between Storage and Network in the sidebar. Proxmox's physical-disk
 * panel is deliberately *not* reproduced: on KubeOS the two things a user has to
 * watch are the volume group and the thin pool that backs pod data.
 *
 * WHY this page exists, and why it reads a ConfigMap:
 *   The dashboard runs as a pod. It cannot run `vgs`/`lvs` on the host, and
 *   Kubernetes has no object type for LVM, so there is nothing for the API to
 *   serve. Each KubeOS node therefore publishes its own LVM reports as the
 *   ConfigMap `kubeos-system/kubeos-disks` (raw `vgs`/`pvs`/`lvs --reportformat
 *   json` output, refreshed by kubeos-disks-report.timer every minute). These
 *   pages render exactly that: no privileged pod, no host mount, and it works
 *   offline.
 *
 * Read-only by design. A page that could run commands on a node would be a much
 * larger security surface than a page that displays numbers the node published.
 */
import { ApiProxy, registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControl from '@mui/material/FormControl';
import InputLabel from '@mui/material/InputLabel';
import MenuItem from '@mui/material/MenuItem';
import Select from '@mui/material/Select';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';
import { BRAND } from './brand';

const NAMESPACE = 'kubeos-system';
const CONFIGMAP = 'kubeos-disks';

/** Sidebar entry names. Also used as the `sidebar` of the matching route. */
const GROUP = 'kubeos-disks';
const LVM_ENTRY = 'kubeos-disks-lvm';
const THIN_ENTRY = 'kubeos-disks-thin';
const LVM_PATH = '/kubeos-disks/lvm';
const THIN_PATH = '/kubeos-disks/lvm-thin';

/* ---- shapes of the raw lvm JSON we publish ------------------------------- */

type VgEntry = {
  vg_name: string;
  vg_size: string;
  vg_free: string;
  pv_count: string;
  lv_count: string;
  snap_count?: string;
};

type PvEntry = {
  pv_name: string;
  vg_name: string;
  pv_size: string;
  pv_free: string;
};

type LvEntry = {
  lv_name: string;
  vg_name: string;
  lv_size: string;
  lv_attr: string;
  pool_lv?: string;
  data_percent?: string;
  metadata_percent?: string;
  chunk_size?: string;
};

type Report<T> = { report?: Array<Record<string, T[]>> };

/** One entry of `lsblk --json`; children are its partitions / LVM / dm layers. */
type BlockDevice = {
  name: string;
  kname?: string;
  size?: number;
  type?: string;
  fstype?: string | null;
  mountpoints?: Array<string | null> | null;
  children?: BlockDevice[];
};

type Disks = {
  node: string;
  generated: string;
  vgs: VgEntry[];
  pvs: PvEntry[];
  lvs: LvEntry[];
  blocks: BlockDevice[];
};

/* ---- interpretation ------------------------------------------------------ */

/**
 * lv_attr is positional (see lvm lv_attr): character 1 is the volume type —
 * `t` thin pool, `V` thin volume, `-` normal LV, `s` snapshot, `r` raid, etc.
 * Everything else in the string is about state (`wi-ao----`), not type.
 */
const lvType = (attr?: string) => (attr ?? '').charAt(0);

const isThinPool = (lv: LvEntry) => lvType(lv.lv_attr) === 't' && !lv.lv_name.startsWith('[');
const thinVolumesOfPool = (lvs: LvEntry[], pool: string) =>
  lvs.filter(lv => lvType(lv.lv_attr) === 'V' && (lv.pool_lv ?? '') === pool);

/** lvm prints sizes as `<12.25g`, `536.87m`, `1.03g` … — normalise to GiB. */
const GIB_PER_UNIT: Record<string, number> = {
  b: 1 / 1024 ** 3,
  s: 512 / 1024 ** 3,
  k: 1 / 1024 ** 2,
  m: 1 / 1024,
  g: 1,
  t: 1024,
  p: 1024 ** 2,
};

const gib = (value?: string) => {
  const match = /<?([\d.]+)\s*([bksmgpt])?/i.exec(value ?? '');
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'g').toLowerCase();
  const factor = GIB_PER_UNIT[unit];
  return Number.isFinite(amount) && factor ? amount * factor : null;
};

const num = (value?: string) => {
  const parsed = Number((value ?? '').replace('%', ''));
  return Number.isFinite(parsed) ? parsed : null;
};

/** Percentage as the node reported it, with one decimal — "0.5 %", not "0.52 %". */
const pct = (value?: string) => {
  const parsed = num(value);
  return parsed === null ? '—' : `${parsed.toFixed(1)} %`;
};

/** lvm marks approximate sizes with '<' or '>' and pads an exhausted space as "0 ". */
const sizeText = (value?: string) => {
  const cleaned = (value ?? '').trim().replace(/^[<>]/, '');
  if (cleaned === '') {
    return '—';
  }
  return /^0+(\.0+)?$/.test(cleaned) ? '0g' : cleaned;
};

/** Used share of a volume group, from lvm's own size/free strings. */
const usedPercent = (size?: string, free?: string) => {
  const total = gib(size);
  const spare = gib(free);
  if (total === null || spare === null || total <= 0) {
    return null;
  }
  return Math.min(100, Math.max(0, ((total - spare) / total) * 100));
};

/** `lsblk --json` has its own shape (`blockdevices`), not lvm's `report` one. */
const parseBlocks = (raw?: string): BlockDevice[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as { blockdevices?: BlockDevice[] };
    return parsed.blockdevices ?? [];
  } catch {
    return [];
  }
};

async function readDisks(): Promise<Disks | null> {
  const configMap: any = await ApiProxy.request(
    `/api/v1/namespaces/${NAMESPACE}/configmaps/${CONFIGMAP}`
  );
  const data = configMap?.json?.data ?? configMap?.data;
  if (!data) {
    return null;
  }
  const parse = <T,>(raw?: string): T[] => {
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw) as Report<T>;
      const first = parsed.report?.[0] ?? {};
      const key = Object.keys(first)[0];
      return key ? (first[key] as T[]) ?? [] : [];
    } catch {
      return [];
    }
  };
  return {
    node: data.node ?? '?',
    generated: data.generated ?? '',
    vgs: parse<VgEntry>(data['vgs.json']),
    pvs: parse<PvEntry>(data['pvs.json']),
    lvs: parse<LvEntry>(data['lvs.json']),
    blocks: parseBlocks(data['lsblk.json']),
  };
}

function useDisksReport() {
  const [disks, setDisks] = React.useState<Disks | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    readDisks()
      .then(report => {
        setDisks(report);
        setError(null);
      })
      .catch(reason => setError(String(reason?.message ?? reason)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(load, [load]);

  return { disks, error, loading, reload: load };
}

/* ---- presentation -------------------------------------------------------- */

const mono = { fontFamily: 'monospace', fontSize: '0.85rem' } as const;

function UsageBar({ percent, text }: { percent: number | null; text: string }) {
  return (
    <Box>
      <Box
        sx={{
          height: 6,
          borderRadius: 3,
          backgroundColor: BRAND.bg.muted,
          overflow: 'hidden',
        }}
      >
        <Box
          sx={{
            height: '100%',
            width: `${percent === null ? 0 : Math.max(percent, 0.8)}%`,
            backgroundColor: BRAND.lime.primary,
          }}
        />
      </Box>
      <Typography
        variant="caption"
        sx={{ display: 'block', mt: 0.5, color: BRAND.text.muted, whiteSpace: 'nowrap' }}
      >
        {text}
      </Typography>
    </Box>
  );
}

/**
 * One Proxmox-style grid: a muted header row followed by one row per object.
 * Cells may be plain strings (rendered in the body style, first column in mono)
 * or any node, such as a UsageBar.
 */
function DataTable({
  columns,
  template,
  rows,
}: {
  columns: string[];
  template: string;
  rows: React.ReactNode[][];
}) {
  return (
    <Box sx={{ border: `1px solid ${BRAND.bg.muted}`, borderRadius: `${BRAND.radius}px` }}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: template,
          gap: 2,
          px: 1.5,
          py: 0.75,
          backgroundColor: BRAND.bg.muted,
          borderRadius: `${BRAND.radius}px ${BRAND.radius}px 0 0`,
        }}
      >
        {columns.map((column, index) => (
          <Typography
            key={index}
            variant="caption"
            sx={{ color: BRAND.text.muted, textTransform: 'uppercase', letterSpacing: '0.06em' }}
          >
            {column}
          </Typography>
        ))}
      </Box>
      {rows.map((cells, rowIndex) => (
        <Box
          key={rowIndex}
          sx={{
            display: 'grid',
            gridTemplateColumns: template,
            gap: 2,
            px: 1.5,
            py: 1,
            alignItems: 'center',
            borderTop: `1px solid ${BRAND.bg.muted}`,
          }}
        >
          {cells.map((cell, cellIndex) => (
            <Box key={cellIndex} sx={{ minWidth: 0 }}>
              {typeof cell === 'string' ? (
                <Typography
                  variant="body2"
                  sx={{
                    ...(cellIndex === 0 ? mono : {}),
                    color: cellIndex === 0 ? BRAND.text.emphasis : BRAND.text.body,
                  }}
                >
                  {cell}
                </Typography>
              ) : (
                cell
              )}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Typography variant="caption" sx={{ display: 'block', mt: 1.5, color: BRAND.text.muted }}>
      {children}
    </Typography>
  );
}

/** Node name, report age and a reload button — the toolbar both pages share. */
function ReportBar({
  disks,
  loading,
  reload,
}: {
  disks: Disks | null;
  loading: boolean;
  reload: () => void;
}) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
      <Typography variant="body2" sx={{ flex: 1, color: BRAND.text.muted }}>
        {disks?.generated
          ? `Node ${disks.node} · LVM data last changed at ${disks.generated
              .replace('T', ' ')
              .replace('Z', ' UTC')} · the node checks every minute and republishes only on change`
          : 'Waiting for the node’s disk report.'}
      </Typography>
      <Button size="small" variant="outlined" onClick={reload} disabled={loading}>
        {loading ? 'Refreshing…' : 'Refresh'}
      </Button>
    </Box>
  );
}

/** Error state, worded once for both pages. */
function ReportProblem({ error }: { error: string | null }) {
  if (!error) {
    return null;
  }
  return (
    <Typography variant="body2" sx={{ color: BRAND.lime.light }}>
      Could not read {NAMESPACE}/{CONFIGMAP}: {error}
    </Typography>
  );
}

function NoReport() {
  return (
    <Typography variant="body2" sx={{ color: BRAND.text.muted }}>
      This cluster has no disk report yet. On a KubeOS node it appears after first boot (
      <code>systemctl status kubeos-disks-report.timer</code>). A cluster installed before this
      feature simply has none.
    </Typography>
  );
}

/* ---- creating LVM objects from the dashboard ----------------------------- */

/**
 * The dashboard pod cannot run `vgcreate` — LVM only exists on the node. So KubeOS
 * does what "Join node" already does: it starts a one-shot privileged Job pinned
 * to this node (host root at /host, host namespaces through `nsenter -t 1`), the
 * Job creates the object, and then it pokes kubeos-disks-report.service so the
 * ConfigMap — and therefore this page — shows the result straight away.
 *
 * SECURITY, stated plainly: this is the only write path in the dashboard, and it
 * runs commands as root on the node. Every value that reaches the shell is
 * validated against a strict pattern first (NAME/DEVICE/SIZE below), so a name
 * typed into the dialog can never become shell syntax. It also means the dashboard
 * needs permission to create Jobs in kubeos-system; on a real cluster that is a
 * permission to grant deliberately, not cluster-admin.
 */
const HELPER_IMAGE = 'ghcr.io/skmdab/kubeos-join-helper:0.1.0';
const REPORT_UNIT = 'kubeos-disks-report.service';

/** lvm rejects a leading '-' and anything outside this set. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9+_.-]{0,126}$/;
/** A whole disk exactly as lsblk names it, e.g. /dev/vdb. */
const DEVICE_PATTERN = /^\/dev\/[a-z]+[a-z0-9]*$/;
/** lvcreate -L size: a number with a unit, e.g. 8g / 512m / 1.5g. */
const SIZE_PATTERN = /^[0-9]{1,6}(?:\.[0-9]{1,3})?[mMgGtT]$/;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type CreateRequest =
  | { kind: 'vg'; device: string; name: string }
  | { kind: 'thin'; volumeGroup: string; name: string; size: string };

/** Byte count as "10.00 GiB". */
const bytesText = (bytes?: number) =>
  bytes === undefined ? '—' : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

/** Disks with nothing on them: no partitions, no filesystem, no LVM physical volume. */
function freeDisks(disks: Disks | null): BlockDevice[] {
  const pvByPath = new Map((disks?.pvs ?? []).map(pv => [pv.pv_name, pv]));
  return (disks?.blocks ?? [])
    .filter(device => device.type === 'disk')
    .filter(device => (device.children ?? []).length === 0)
    .filter(device => {
      const pv = pvByPath.get(`/dev/${device.kname || device.name}`);
      if (pv) {
        // A PV that belongs to a volume group is in use. An *orphan* PV (an LVM label
        // with no group, left behind by an earlier install) is free space in practice:
        // `pvcreate -ff` in hostScript() overwrites the label before vgcreate.
        return !pv.vg_name;
      }
      return !device.fstype;
    });
}

/** True for a disk whose only residue is a stale LVM label (see freeDisks()). */
function hasOrphanPv(disks: Disks | null, device: BlockDevice): boolean {
  return (disks?.pvs ?? []).some(
    pv => pv.pv_name === `/dev/${device.kname || device.name}` && !pv.vg_name
  );
}

/** The shell the Job runs on the host. Values are pre-validated (see above). */
function hostScript(request: CreateRequest): string {
  const host = 'nsenter -t 1 -m -u -i -n -p --';
  const refresh = `${host} systemctl start ${REPORT_UNIT} >/dev/null 2>&1 || true`;
  if (request.kind === 'vg') {
    return [
      'set -e',
      `echo 'creating volume group ${request.name} on ${request.device}'`,
      `${host} pvcreate -ff -y '${request.device}'`,
      `${host} vgcreate '${request.name}' '${request.device}'`,
      `${host} vgs '${request.name}'`,
      refresh,
    ].join('\n');
  }
  const size = request.size ? `-L '${request.size}'` : '-l 100%FREE';
  return [
    'set -e',
    `echo 'creating thin pool ${request.name} in ${request.volumeGroup}'`,
    `${host} lvcreate --type thin-pool ${size} -n '${request.name}' '${request.volumeGroup}'`,
    `${host} lvs -a '${request.volumeGroup}'`,
    refresh,
  ].join('\n');
}

async function startCreateJob(request: CreateRequest): Promise<string> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const jobName = `kubeos-lvm-${request.kind}-${suffix}`;
  const labels = { 'kubeos.io/storage-create': request.kind };
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: { name: jobName, namespace: NAMESPACE, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 600,
      template: {
        metadata: { labels },
        spec: {
          restartPolicy: 'Never',
          hostPID: true,
          tolerations: [{ operator: 'Exists' }],
          containers: [
            {
              name: 'storage-create',
              image: HELPER_IMAGE,
              imagePullPolicy: 'IfNotPresent',
              securityContext: { privileged: true },
              volumeMounts: [{ name: 'host', mountPath: '/host' }],
              command: ['/bin/sh', '-c', hostScript(request)],
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

/** Wait for the Job to finish. Returns null on success, else the failure reason. */
async function waitForJob(jobName: string): Promise<string | null> {
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(2000);
    const job: any = await ApiProxy.request(
      `/apis/batch/v1/namespaces/${NAMESPACE}/jobs/${jobName}`
    );
    const status = job?.status ?? {};
    if ((status.succeeded ?? 0) > 0) {
      return null;
    }
    if ((status.failed ?? 0) > 0) {
      const condition = (status.conditions ?? []).find((entry: any) => entry.type === 'Failed');
      return condition?.message ?? 'the job failed';
    }
  }
  return 'the job did not finish within two minutes';
}

const dialogNote = { display: 'block', mb: 2, color: BRAND.text.muted } as const;

function CreateVolumeGroupDialog({
  open,
  disks,
  onClose,
  onCreated,
}: {
  open: boolean;
  disks: Disks | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const devices = freeDisks(disks);
  const [device, setDevice] = React.useState('');
  const [name, setName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const first = devices[0];
    setDevice(first ? `/dev/${first.kname || first.name}` : '');
    setName('');
    setError(null);
    setBusy(false);
  }, [open, devices.length]);

  const canCreate = !busy && DEVICE_PATTERN.test(device) && NAME_PATTERN.test(name);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const jobName = await startCreateJob({ kind: 'vg', device, name });
      const failure = await waitForJob(jobName);
      if (failure) {
        setError(
          `Could not create the volume group: ${failure} (job ${jobName}; its pod log has the output)`
        );
        return;
      }
      onCreated();
      onClose();
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Create: Volume Group</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={dialogNote}>
          A volume group is built on one empty disk and holds the logical volumes. Only disks with
          no partitions and no filesystem are offered; a stale LVM label left by an earlier install
          is overwritten.
        </Typography>
        {devices.length === 0 ? (
          <Typography variant="body2" sx={{ color: BRAND.lime.light }}>
            No free disk on this node: every disk already holds partitions, a filesystem or LVM.
            Add a disk and press Refresh.
          </Typography>
        ) : (
          <>
            <FormControl fullWidth size="small">
              <InputLabel id="kubeos-vg-disk">Disk</InputLabel>
              <Select
                labelId="kubeos-vg-disk"
                label="Disk"
                value={device}
                onChange={event => setDevice(String(event.target.value))}
              >
                {devices.map(entry => {
                  const path = `/dev/${entry.kname || entry.name}`;
                  return (
                    <MenuItem key={path} value={path}>
                      {path} — {bytesText(entry.size)}{' '}
                      {hasOrphanPv(disks, entry) ? '(old LVM label, wiped)' : 'empty'}
                    </MenuItem>
                  );
                })}
              </Select>
            </FormControl>
            <TextField
              id="kubeos-vg-name"
              fullWidth
              size="small"
              sx={{ mt: 2 }}
              label="Name"
              value={name}
              onChange={event => setName(event.target.value.trim())}
              error={name.length > 0 && !NAME_PATTERN.test(name)}
              helperText="Letters, digits and + _ . - ; cannot start with a dash. The group appears as a container for logical volumes."
            />
          </>
        )}
        {error && (
          <Typography variant="body2" sx={{ mt: 2, color: BRAND.lime.light }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={create} disabled={!canCreate}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function CreateThinPoolDialog({
  open,
  disks,
  onClose,
  onCreated,
}: {
  open: boolean;
  disks: Disks | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const groups = disks?.vgs ?? [];
  const [volumeGroup, setVolumeGroup] = React.useState('');
  const [name, setName] = React.useState('');
  const [size, setSize] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setVolumeGroup(groups[0]?.vg_name ?? '');
    setName('');
    setSize('');
    setError(null);
    setBusy(false);
  }, [open, groups.length]);

  const selected = groups.find(group => group.vg_name === volumeGroup);
  const canCreate =
    !busy &&
    NAME_PATTERN.test(volumeGroup) &&
    NAME_PATTERN.test(name) &&
    (size === '' || SIZE_PATTERN.test(size));

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const jobName = await startCreateJob({ kind: 'thin', volumeGroup, name, size });
      const failure = await waitForJob(jobName);
      if (failure) {
        setError(
          `Could not create the thin pool: ${failure} (job ${jobName}; its pod log has the output)`
        );
        return;
      }
      onCreated();
      onClose();
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Create: Thinpool</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={dialogNote}>
          A thin pool lives inside an existing volume group and hands out space on demand, which is
          what KubeOS uses for pod data. The pool’s metadata and its spare copy are taken from the
          same free space, so the usable data area is slightly smaller than the size below.
        </Typography>
        {groups.length === 0 ? (
          <Typography variant="body2" sx={{ color: BRAND.lime.light }}>
            There is no volume group on this node yet. Create one on the LVM page first — a thin
            pool cannot exist without it.
          </Typography>
        ) : (
          <>
            <FormControl fullWidth size="small">
              <InputLabel id="kubeos-thin-vg">Volume group</InputLabel>
              <Select
                labelId="kubeos-thin-vg"
                label="Volume group"
                value={volumeGroup}
                onChange={event => setVolumeGroup(String(event.target.value))}
              >
                {groups.map(group => (
                  <MenuItem key={group.vg_name} value={group.vg_name}>
                    {group.vg_name} — {sizeText(group.vg_free)} free of {sizeText(group.vg_size)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <TextField
              id="kubeos-thin-name"
              fullWidth
              size="small"
              sx={{ mt: 2 }}
              label="Name"
              value={name}
              onChange={event => setName(event.target.value.trim())}
              error={name.length > 0 && !NAME_PATTERN.test(name)}
              helperText="The thin pool’s name, e.g. kubeos-data."
            />
            <TextField
              id="kubeos-thin-size"
              fullWidth
              size="small"
              sx={{ mt: 2 }}
              label="Size"
              value={size}
              onChange={event => setSize(event.target.value.trim())}
              error={size !== '' && !SIZE_PATTERN.test(size)}
              helperText={
                selected && sizeText(selected.vg_free) !== '0g'
                  ? `Leave empty to use all free space (${sizeText(
                      selected.vg_free
                    )}), or give a size such as 8g.`
                  : 'Leave empty to use all free space, or give a size such as 8g.'
              }
            />
          </>
        )}
        {error && (
          <Typography variant="body2" sx={{ mt: 2, color: BRAND.lime.light }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={create} disabled={!canCreate}>
          {busy ? 'Creating…' : 'Create'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ---- the two pages ------------------------------------------------------- */

const VG_TEMPLATE =
  'minmax(120px, 1.2fr) minmax(150px, 1.6fr) repeat(4, minmax(64px, 0.7fr))';

function LvmPage() {
  const { disks, error, loading, reload } = useDisksReport();
  const [creating, setCreating] = React.useState(false);

  const rows = (disks?.vgs ?? []).map<React.ReactNode[]>(vg => {
    const devices = disks!.pvs
      .filter(pv => pv.vg_name === vg.vg_name)
      .map(pv => pv.pv_name)
      .join(', ');
    return [
      vg.vg_name,
      <UsageBar
        key="usage"
        percent={usedPercent(vg.vg_size, vg.vg_free)}
        text={`${sizeText(vg.vg_free)} free of ${sizeText(vg.vg_size)}`}
      />,
      sizeText(vg.vg_size),
      sizeText(vg.vg_free),
      devices || vg.pv_count,
      vg.lv_count,
    ];
  });

  return (
    <>
      <SectionBox
        title="LVM"
        headerProps={{
          actions: [
            <Button
              key="create"
              variant="contained"
              size="small"
              onClick={() => setCreating(true)}
              disabled={loading}
            >
              Create: Volume Group
            </Button>,
          ],
        }}
      >
        <ReportBar disks={disks} loading={loading} reload={reload} />
        <ReportProblem error={error} />
        {!error && !loading && !disks && <NoReport />}
        {disks &&
          (rows.length === 0 ? (
            <Typography variant="body2" sx={{ color: BRAND.text.muted }}>
              No volume groups on this node.
            </Typography>
          ) : (
            <>
              <DataTable
                columns={['Volume group', 'Usage', 'Size', 'Free', 'Devices', 'LVs']}
                template={VG_TEMPLATE}
                rows={rows}
              />
              <Note>
                Usage is how much of the volume group is allocated. KubeOS creates one volume group
                (<code>kubeos-vg</code>) on the whole disk, keeps the root logical volume in it and
                carves the thin pool out of the same group — so growing the pool means growing the
                disk first.
              </Note>
            </>
          ))}
      </SectionBox>
      <CreateVolumeGroupDialog
        open={creating}
        disks={disks}
        onClose={() => setCreating(false)}
        onCreated={reload}
      />
    </>
  );
}

const THIN_TEMPLATE =
  'minmax(120px, 1.2fr) minmax(150px, 1.6fr) repeat(4, minmax(64px, 0.7fr))';

function LvmThinPage() {
  const { disks, error, loading, reload } = useDisksReport();
  const [creating, setCreating] = React.useState(false);

  const pools = (disks?.lvs ?? []).filter(isThinPool);
  const rows = pools.map<React.ReactNode[]>(pool => {
    const volumes = thinVolumesOfPool(disks!.lvs, pool.lv_name);
    return [
      pool.lv_name,
      <UsageBar
        key="usage"
        percent={num(pool.data_percent)}
        text={`${pct(pool.data_percent)} data used`}
      />,
      sizeText(pool.lv_size),
      pct(pool.metadata_percent),
      sizeText(pool.chunk_size),
      `${volumes.length}`,
    ];
  });

  return (
    <>
      <SectionBox
        title="LVM-Thin"
        headerProps={{
          actions: [
            <Button
              key="create"
              variant="contained"
              size="small"
              onClick={() => setCreating(true)}
              disabled={loading}
            >
              Create: Thinpool
            </Button>,
          ],
        }}
      >
        <ReportBar disks={disks} loading={loading} reload={reload} />
        <ReportProblem error={error} />
        {!error && !loading && !disks && <NoReport />}
        {disks &&
          (rows.length === 0 ? (
            <Typography variant="body2" sx={{ color: BRAND.text.muted }}>
              No thin pools on this node.
            </Typography>
          ) : (
            <>
              <DataTable
                columns={['Thin pool', 'Usage', 'Size', 'Metadata', 'Chunk', 'Volumes']}
                template={THIN_TEMPLATE}
                rows={rows}
              />

              {pools.map(pool => {
                const volumes = thinVolumesOfPool(disks.lvs, pool.lv_name);
                if (volumes.length === 0) {
                  return null;
                }
                return (
                  <Box key={pool.lv_name} sx={{ mt: 3 }}>
                    <Typography
                      variant="caption"
                      sx={{
                        display: 'block',
                        mb: 1,
                        color: BRAND.text.muted,
                        textTransform: 'uppercase',
                        letterSpacing: '0.06em',
                      }}
                    >
                      Thin volumes in {pool.lv_name}
                    </Typography>
                    <DataTable
                      columns={['Volume', 'Volume group', 'Size', 'Type']}
                      template="minmax(120px, 1.2fr) repeat(3, minmax(72px, 0.8fr))"
                      rows={volumes.map(volume => [
                        volume.lv_name,
                        volume.vg_name,
                        sizeText(volume.lv_size),
                        'thin volume',
                      ])}
                    />
                  </Box>
                );
              })}

              <Note>
                Usage is how much of the pool the volumes have actually written; Metadata is the
                pool’s own mapping tables. A thin pool that reaches 100 % data stops accepting
                writes, so <code>lvextend</code> on the pool is the answer — not a bigger
                filesystem. Hidden pool members (metadata, data, spare) are not listed.
              </Note>
            </>
          ))}
      </SectionBox>
      <CreateThinPoolDialog
        open={creating}
        disks={disks}
        onClose={() => setCreating(false)}
        onCreated={reload}
      />
    </>
  );
}

/* ---- sidebar placement --------------------------------------------------- */

/**
 * Headlamp appends every plugin entry to the END of the in-cluster sidebar
 * (`useSidebarItems.tsx` does `sidebarEntry.subList.push(item)`) and
 * `registerSidebarEntry` has no index/priority option, so a plugin cannot ask for
 * a position. KubeOS wants Proxmox's node order — Storage, then Disks, then
 * Network — so once the sidebar is in the DOM we put *our own* nodes directly
 * after the built-in Storage group.
 *
 * The markup MUI produces for one top-level entry is `<li><a>…</a></li>`, and the
 * child list of the open group is a separate `<li>` (a MuiCollapse) holding no
 * direct `<a>`. Three traps, all found the hard way:
 *   1. that child list is **not** reliably next to its own row: React mounts a
 *      fresh Collapse with `insertBefore(node, null)`-style logic, so a
 *      freshly opened group's list can land at the very END of the sidebar
 *      (LVM/LVM-Thin appeared under "Join node"), which is why lists are located
 *      by *content*, not by position;
 *   2. React inserts a group's child list before the **next entry's DOM node**, so
 *      with our row sitting between Storage and Network, opening Storage put
 *      Storage's own children under our Disks row — the two groups' blocks have to
 *      be re-normalised together, not one at a time;
 *   3. the Storage entry links to its first child
 *      (`…/storage/persistentvolumeclaims`), not to `/storage`.
 *
 * Scope and safety: only the nodes that make up the Storage/Disks blocks are
 * moved, never anyone else's; the function returns before touching the DOM when
 * the order is already right, so the observer cannot loop; and if Headlamp's
 * markup ever changes so that the anchors cannot be found, nothing is moved and
 * Disks simply stays where Headlamp put it (at the end of the list). It re-runs on
 * sidebar mutations, at most once per animation frame.
 */
const OUR_HREF = /\/kubeos-disks(\/|\?|$)/;
const STORAGE_HREF = /\/storage(\/|\?|$)/;

/** A top-level sidebar entry: an `<li>` whose first element child is its link. */
const isEntry = (element: Element) =>
  element.tagName === 'LI' && element.firstElementChild?.tagName === 'A';

const hrefOfEntry = (element: Element) =>
  element.firstElementChild?.getAttribute('href') ?? '';

/** A rendered child list: an `<li>` that is not an entry but holds links. */
const isChildList = (element: Element) => !isEntry(element) && !!element.querySelector('a');

function placeDisksAfterStorage(): void {
  // Our group row: the top-level entry that links to one of our pages. A group
  // with no url of its own links to its first child, so child anchors match too —
  // only the entry wrapper counts.
  const ourItem = Array.from(document.querySelectorAll('a[href*="/kubeos-disks"]'))
    .map(anchor => anchor.closest('li'))
    .find(item => item !== null && isEntry(item) && OUR_HREF.test(hrefOfEntry(item)));

  const list = ourItem?.parentElement;
  if (!ourItem || !list) {
    return;
  }

  const children = Array.from(list.children);
  const storageItem = children.find(
    child => isEntry(child) && STORAGE_HREF.test(hrefOfEntry(child))
  );
  if (!storageItem || storageItem === ourItem) {
    return;
  }

  const childLists = children.filter(isChildList);
  const ourSubList = childLists.find(child => !!child.querySelector('a[href*="/kubeos-disks"]'));

  // Storage's child list only exists while Storage is the open group; there is at
  // most one other list, and it is only ours when ours is that one.
  const storageIsOpen = storageItem.firstElementChild?.classList.contains('Mui-selected');
  const storageSubList = storageIsOpen
    ? childLists.find(child => child !== ourSubList)
    : undefined;

  const block = [storageItem, storageSubList, ourItem, ourSubList].filter(
    (node): node is Element => !!node
  );
  const inPlace = block.every(
    (node, index) => index === 0 || block[index - 1].nextElementSibling === node
  );
  if (inPlace) {
    return;
  }

  // Re-seat the four nodes as one unit, in that order, where Storage already is.
  const parent = storageItem.parentNode;
  if (!parent) {
    return;
  }
  const marker = document.createComment('kubeos-disks-block');
  parent.insertBefore(marker, storageItem);
  const fragment = document.createDocumentFragment();
  block.forEach(node => fragment.appendChild(node));
  parent.insertBefore(fragment, marker);
  marker.parentNode?.removeChild(marker);
}

function keepDisksAfterStorage(): void {
  let scheduled = false;
  const schedule = () => {
    if (scheduled) {
      return;
    }
    scheduled = true;
    window.requestAnimationFrame(() => {
      scheduled = false;
      placeDisksAfterStorage();
    });
  };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
}

/* ---- registration -------------------------------------------------------- */

// Proxmox order: a top-level Disks group with exactly two sub-pages. The group
// has no url of its own, so Headlamp links it to its first child (LVM) and
// expands the children while either page is open.
registerSidebarEntry({ name: GROUP, label: 'Disks', icon: 'mdi:harddisk' });
registerSidebarEntry({ parent: GROUP, name: LVM_ENTRY, label: 'LVM', url: LVM_PATH });
registerSidebarEntry({ parent: GROUP, name: THIN_ENTRY, label: 'LVM-Thin', url: THIN_PATH });

registerRoute({
  path: LVM_PATH,
  sidebar: LVM_ENTRY,
  name: LVM_ENTRY,
  exact: true,
  component: LvmPage,
});

registerRoute({
  path: THIN_PATH,
  sidebar: THIN_ENTRY,
  name: THIN_ENTRY,
  exact: true,
  component: LvmThinPage,
});

keepDisksAfterStorage();
