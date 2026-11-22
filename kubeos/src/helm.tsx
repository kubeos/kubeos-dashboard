/**
 * The KubeOS Helm section: what is deployed on this node, and the operations a user would
 * otherwise type in a terminal (`helm install/upgrade/rollback/uninstall`).
 *
 * WHY: `helm` is installed on every node, but until 0.1.0-15 the dashboard could only *describe*
 * releases - the user's words were "i just don't want to see only information.. i want user should
 * do some basic operations from dashboard" (2026-11-22).
 *
 * WHY IT IS A GROUP WITH CHILDREN: listing releases and creating one are different jobs, and a
 * single page could not explain both. "Releases" is the list you land on; "Install" is the form.
 *
 * WHY NOTHING HERE CREATES A POD (user decision 2026-11-12): every call goes to
 * `kubeos-console.service`, which runs `/usr/bin/helm` on the host with an argument list and
 * answers JSON. Nothing is executed inside the cluster to run it, and a failed operation leaves
 * no object behind.
 *
 * THE SAFETY SHAPE, and it is the same in every dialog:
 *   - a PREVIEW (`--dry-run=client`, rendered by the node, nothing applied) is shown first, and
 *     the apply button stays disabled until the form has been previewed and not edited since;
 *   - anything destructive (rollback, uninstall) additionally needs the release name TYPED;
 *   - the console refuses an uninstall in kubeos-system or kube-system no matter what this page
 *     sends, refuses a second operation while one is running, and validates every name before it
 *     reaches argv.
 */
import { registerRoute, registerSidebarEntry } from '@kinvolk/headlamp-plugin/lib';
import { SectionBox } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import React from 'react';

import { ConsoleConfig, consoleConfig, consoleFetch, consoleJson } from './consoleapi';

const GROUP = 'kubeos-helm';
const RELEASES_ENTRY = 'kubeos-helm-releases';
const INSTALL_ENTRY = 'kubeos-helm-install';
const RELEASES_PATH = '/kubeos-helm/releases';
const INSTALL_PATH = '/kubeos-helm/install';

const LIME = '#c4ff2e';
const DIM = '#9aa596';
const RED = '#ff8080';

/** Kept in step with HELM_PROTECTED_NAMESPACES in console.py: the node refuses these anyway. */
const PROTECTED_NAMESPACES = ['kubeos-system', 'kube-system'];

interface Release {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
}

interface HistoryEntry {
  revision: number;
  updated: string;
  status: string;
  chart: string;
  app_version: string;
  description: string;
}

interface Detail {
  namespace: string;
  name: string;
  status: any;
  values: any;
  values_yaml: string;
  metadata: any;
  history: HistoryEntry[] | null;
  manifest: string;
  manifest_truncated: boolean;
  manifest_error: string;
}

type Uploaded = { chart: string; name: string; version: string; uploaded: string };

/** A status is a single word; colour it the way the rest of the product does. */
function statusColour(status: string): string {
  const value = (status || '').toLowerCase();
  if (value === 'deployed') {
    return LIME;
  }
  if (value === 'failed' || value === 'pending-upgrade' || value === 'pending-install') {
    return RED;
  }
  return DIM;
}

/**
 * How many objects a release owns.
 *
 * helm v4 returns `info.resources` as a DICT keyed `<apiVersion>/<kind>` whose values are the
 * objects of that kind (`{"v1/ConfigMap": [{...}, {...}]}`), while v3 returned a flat list.
 * Counting `Object.keys()` would report "1 kind" as "1 object", so add the lengths up.
 */
function resourceCount(resources: unknown): number | null {
  if (Array.isArray(resources)) {
    return resources.length;
  }
  if (resources && typeof resources === 'object') {
    const lists = Object.values(resources as Record<string, unknown>);
    if (lists.every(list => Array.isArray(list))) {
      return lists.reduce((total, list) => total + (list as unknown[]).length, 0);
    }
  }
  return null;
}

function pre(text: string) {
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        p: 1.5,
        maxHeight: 420,
        overflow: 'auto',
        background: '#0d130d',
        border: '1px solid #1d2a1d',
        borderRadius: '4px',
        color: '#d6e2d2',
        fontFamily: 'monospace',
        fontSize: '0.85rem',
        whiteSpace: 'pre',
      }}
    >
      {text}
    </Box>
  );
}

/** One POST to the node's Helm endpoint; the node's own sentence comes back as the error. */
async function helmAction(config: ConsoleConfig, body: Record<string, unknown>): Promise<string> {
  const answer = await consoleFetch(config, '/helm/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = await consoleJson<{ output?: string }>(answer);
  return String(parsed.output ?? '');
}

async function uploadChart(config: ConsoleConfig, file: File): Promise<Uploaded> {
  const answer = await consoleFetch(config, '/helm/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/gzip' },
    body: file,
  });
  const parsed = await consoleJson<any>(answer);
  return {
    chart: String(parsed.chart),
    name: String(parsed.name ?? ''),
    version: String(parsed.version ?? ''),
    uploaded: 'just now',
  };
}

async function listCharts(config: ConsoleConfig): Promise<Uploaded[]> {
  const answer = await consoleFetch(config, '/helm/charts');
  const parsed = await consoleJson<{ charts: Uploaded[] }>(answer);
  return parsed.charts ?? [];
}

/** The releases page of whatever cluster/clone prefix this tab is on. */
function releasesUrl(): string {
  const path = window.location.pathname;
  const cut = path.indexOf('/kubeos-helm');
  return `${cut >= 0 ? path.slice(0, cut) : path.replace(/\/$/, '')}/kubeos-helm/releases`;
}

/* ---- shared form pieces -------------------------------------------------- */

/**
 * Chart choice for install and upgrade: a previous upload from this node, a fresh upload, or an
 * absolute path that already exists on the node (for a chart baked into an image, say).
 */
function ChartSource({
  config,
  uploads,
  value,
  onChange,
  hint,
}: {
  config: ConsoleConfig | null;
  uploads: Uploaded[];
  value: string;
  onChange: (next: string) => void;
  hint?: string;
}) {
  const [busy, setBusy] = React.useState(false);
  const [problem, setProblem] = React.useState('');
  const fileInput = React.useRef<HTMLInputElement | null>(null);

  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Chart
      </Typography>
      <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
        <Box
          component="select"
          value={value.startsWith('upload:') ? value : ''}
          onChange={(event: React.ChangeEvent<HTMLSelectElement>) => onChange(event.target.value)}
          sx={{
            background: '#0d130d',
            color: '#d6e2d2',
            border: '1px solid #1d2a1d',
            borderRadius: '4px',
            p: 0.75,
            fontFamily: 'monospace',
            fontSize: '0.85rem',
            minWidth: 280,
          }}
        >
          <option value="">{uploads.length ? 'choose an uploaded chart…' : 'no charts uploaded yet'}</option>
          {value.startsWith('upload:') && !uploads.some(entry => entry.chart === value) ? (
            <option value={value}>just uploaded · {value.replace('upload:', '')}</option>
          ) : null}
          {uploads.map(entry => (
            <option key={entry.chart} value={entry.chart}>
              {entry.name}-{entry.version} · {entry.uploaded}
            </option>
          ))}
        </Box>
        <input
          ref={fileInput}
          type="file"
          accept=".tgz,.tar.gz,application/gzip"
          style={{ display: 'none' }}
          onChange={async event => {
            const file = event.target.files?.[0];
            if (!file || !config) {
              return;
            }
            setBusy(true);
            setProblem('');
            try {
              const saved = await uploadChart(config, file);
              onChange(saved.chart);
            } catch (reason: any) {
              setProblem(String(reason?.message ?? reason));
            } finally {
              setBusy(false);
              if (fileInput.current) {
                fileInput.current.value = '';
              }
            }
          }}
        />
        <Button
          size="small"
          variant="outlined"
          disabled={busy || !config}
          onClick={() => fileInput.current?.click()}
        >
          {busy ? 'uploading…' : 'Upload a chart (.tgz)'}
        </Button>
        <TextField
          size="small"
          label="or a chart path on the node"
          value={value.startsWith('upload:') ? '' : value}
          onChange={event => onChange(event.target.value)}
          sx={{ minWidth: 320 }}
        />
      </Box>
      {hint ? (
        <Typography variant="caption" sx={{ color: DIM, display: 'block', mt: 0.5 }}>
          {hint}
        </Typography>
      ) : null}
      {problem ? (
        <Typography variant="body2" sx={{ color: RED, mt: 0.5 }}>
          {problem}
        </Typography>
      ) : null}
    </Box>
  );
}

/** The values editor: the YAML a terminal user would edit in a values.yaml. */
function ValuesEditor({
  value,
  onChange,
  hint,
  rows = 10,
}: {
  value: string;
  onChange: (next: string) => void;
  hint?: string;
  rows?: number;
}) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Values (YAML)
      </Typography>
      <TextField
        value={value}
        onChange={event => onChange(event.target.value)}
        multiline
        minRows={rows}
        fullWidth
        placeholder={'greeting: hello'}
        InputProps={{
          sx: { fontFamily: 'monospace', fontSize: '0.85rem', background: '#0d130d' },
        }}
      />
      {hint ? (
        <Typography variant="caption" sx={{ color: DIM, display: 'block', mt: 0.5 }}>
          {hint}
        </Typography>
      ) : null}
    </Box>
  );
}

/** Preview output, plus the sentence that says what the preview proves. */
function PreviewPanel({ text }: { text: string }) {
  if (!text) {
    return null;
  }
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
        Preview (rendered by the node with --dry-run, nothing applied)
      </Typography>
      {pre(text)}
    </Box>
  );
}

/** A dialog in the shape the rest of the product uses. */
function HelmDialog({
  open,
  title,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions: React.ReactNode;
}) {
  return (
    <Dialog
      open={open}
      // A click just outside the paper must NOT throw away a half-filled form: MUI's default
      // "close on backdrop click" did exactly that on 2026-11-22, and because the dialog and the
      // page both have a button labelled "Upgrade", the closed dialog then made the automation
      // (and a user) act on the page's button with no visible reason. Escape still closes.
      onClose={(_event, reason) => {
        if (reason === 'backdropClick') {
          return;
        }
        onClose();
      }}
      maxWidth="md"
      fullWidth
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent dividers>{children}</DialogContent>
      <DialogActions>{actions}</DialogActions>
    </Dialog>
  );
}

function ErrorLine({ text }: { text: string }) {
  if (!text) {
    return null;
  }
  return (
    <Box sx={{ color: RED, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.85rem' }}>
      {text}
    </Box>
  );
}

/* ---- releases page ------------------------------------------------------- */

export function HelmReleasesPage() {
  const [releases, setReleases] = React.useState<Release[] | null>(null);
  const [error, setError] = React.useState<string>('');
  const [selected, setSelected] = React.useState<Release | null>(null);
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [detailError, setDetailError] = React.useState<string>('');
  const [repos, setRepos] = React.useState<any[] | null>(null);
  const [uploads, setUploads] = React.useState<Uploaded[]>([]);
  const [config, setConfig] = React.useState<ConsoleConfig | null>(null);
  const [showManifest, setShowManifest] = React.useState(false);
  const [dialog, setDialog] = React.useState<'upgrade' | 'rollback' | 'uninstall' | null>(null);
  const [flash, setFlash] = React.useState<string>('');

  const loadReleases = React.useCallback(async () => {
    setError('');
    try {
      const cfg = await consoleConfig();
      setConfig(cfg);
      const body = await consoleJson<{ releases: Release[] }>(
        await consoleFetch(cfg, '/helm/releases')
      );
      setReleases(body.releases);
    } catch (reason: any) {
      setReleases([]);
      setError(String(reason?.message ?? reason));
    }
  }, []);

  const loadDetail = React.useCallback(async (row: Release | null) => {
    if (!row) {
      setDetail(null);
      setDetailError('');
      return;
    }
    setDetailError('');
    setDetail(null);
    try {
      const cfg = config ?? (await consoleConfig());
      const body = await consoleJson<Detail>(
        await consoleFetch(
          cfg,
          `/helm/release?name=${encodeURIComponent(row.name)}&namespace=${encodeURIComponent(
            row.namespace
          )}`
        )
      );
      setDetail(body);
    } catch (reason: any) {
      setDetailError(String(reason?.message ?? reason));
    }
  }, [config]);

  React.useEffect(() => {
    loadReleases();
    (async () => {
      try {
        const cfg = await consoleConfig();
        const body = await consoleJson<{ repos: any[] }>(await consoleFetch(cfg, '/helm/repos'));
        setRepos(body.repos);
        setUploads(await listCharts(cfg));
      } catch {
        setRepos([]);
      }
    })();
  }, [loadReleases]);

  React.useEffect(() => {
    loadDetail(selected);
    setShowManifest(false);
  }, [selected, loadDetail]);

  /** After an operation: refresh the list AND the open detail, because both just changed. */
  const afterChange = React.useCallback(async () => {
    await loadReleases();
    await loadDetail(selected);
  }, [loadReleases, loadDetail, selected]);

  const header = (
    <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 1.5 }}>
      <Typography variant="body2" sx={{ color: DIM }}>
        Helm releases on this node — click a row to inspect it, or use its buttons to change it
      </Typography>
      <Box sx={{ flex: 1 }} />
      <Button size="small" onClick={loadReleases} data-testid="kubeos-helm-refresh">
        Refresh
      </Button>
    </Box>
  );

  return (
    <SectionBox title="Releases">
      {header}
      {flash ? (
        <Box sx={{ mb: 1.5, color: LIME }} data-testid="kubeos-helm-flash">
          {flash}
        </Box>
      ) : null}
      {error ? (
        <Box sx={{ p: 1.5, mb: 2, border: `1px solid ${RED}`, borderRadius: '4px', color: RED }}>
          {error}
        </Box>
      ) : null}

      {releases === null ? (
        <Typography sx={{ color: DIM }}>reading Helm releases…</Typography>
      ) : releases.length === 0 ? (
        <Box sx={{ color: DIM }}>
          <Typography sx={{ mb: 1 }}>No Helm releases on this node.</Typography>
          <Typography variant="body2">
            Install one from the <strong>Install</strong> page in this section: upload a chart,
            fill in the values, preview what it renders, then install.
          </Typography>
        </Box>
      ) : (
        <Box
          component="table"
          sx={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: '0.85rem',
            '& th': { textAlign: 'left', color: DIM, fontWeight: 500, py: 0.75, pr: 2, borderBottom: '1px solid #1d2a1d' },
            '& td': { py: 0.75, pr: 2, borderBottom: '1px solid #141d14' },
          }}
        >
          <thead>
            <tr>
              <th>Name</th>
              <th>Namespace</th>
              <th>Chart</th>
              <th>App version</th>
              <th>Revision</th>
              <th>Status</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            {releases.map(release => {
              const isSelected =
                selected?.name === release.name && selected?.namespace === release.namespace;
              return (
                <tr
                  key={`${release.namespace}/${release.name}`}
                  onClick={() => setSelected(release)}
                  style={{
                    cursor: 'pointer',
                    background: isSelected ? 'rgba(196,255,46,0.08)' : undefined,
                  }}
                >
                  <td style={{ color: LIME }}>{release.name}</td>
                  <td>{release.namespace}</td>
                  <td>{release.chart}</td>
                  <td>{release.app_version}</td>
                  <td>{release.revision}</td>
                  <td style={{ color: statusColour(release.status) }}>{release.status}</td>
                  <td style={{ color: DIM }}>{release.updated}</td>
                </tr>
              );
            })}
          </tbody>
        </Box>
      )}

      {repos !== null ? (
        <Typography variant="body2" sx={{ color: DIM, mt: 1.5 }}>
          Chart repositories: {repos.length === 0
            ? 'none configured (charts are installed from an uploaded file)'
            : repos.map(r => r.name).join(', ')}
        </Typography>
      ) : null}

      {selected ? (
        <Box sx={{ mt: 3, borderTop: '1px solid #1d2a1d', pt: 2 }} data-testid="kubeos-helm-detail">
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 2, mb: 1, flexWrap: 'wrap' }}>
            <Typography variant="subtitle1" sx={{ color: LIME }}>
              {selected.namespace}/{selected.name}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              variant="contained"
              disabled={!detail || !config}
              onClick={() => setDialog('upgrade')}
            >
              Upgrade
            </Button>
            <Button
              size="small"
              variant="outlined"
              disabled={!detail || !config || !(detail.history && detail.history.length > 1)}
              onClick={() => setDialog('rollback')}
            >
              Rollback
            </Button>
            <Button
              size="small"
              variant="outlined"
              sx={{ color: RED, borderColor: RED }}
              disabled={!detail || !config}
              onClick={() => setDialog('uninstall')}
            >
              Uninstall
            </Button>
            <Button size="small" onClick={() => setSelected(null)}>
              Close
            </Button>
          </Box>

          {detailError ? <ErrorLine text={detailError} /> : null}
          {detail === null && !detailError ? (
            <Typography sx={{ color: DIM }}>reading the release…</Typography>
          ) : null}

          {detail ? (
            <>
              <Box
                component="table"
                sx={{
                  mb: 2,
                  fontSize: '0.85rem',
                  '& th': { textAlign: 'left', color: DIM, fontWeight: 500, py: 0.5, pr: 3 },
                  '& td': { py: 0.5, pr: 3 },
                }}
              >
                <tbody>
                  <tr>
                    <th>Status</th>
                    <td style={{ color: statusColour(detail.status?.info?.status) }}>
                      {detail.status?.info?.status ?? 'unknown'}
                    </td>
                    <th>Chart</th>
                    <td>
                      {selected.chart} ({selected.app_version})
                    </td>
                  </tr>
                  <tr>
                    <th>Revision</th>
                    <td>{detail.status?.version}</td>
                    <th>Last deployed</th>
                    <td>{detail.status?.info?.last_deployed}</td>
                  </tr>
                  <tr>
                    <th>Description</th>
                    <td>{detail.status?.info?.description ?? ''}</td>
                    <th>Objects</th>
                    <td>{resourceCount(detail.status?.info?.resources) ?? '—'}</td>
                  </tr>
                </tbody>
              </Box>

              {detail.status?.info?.notes ? (
                <>
                  <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
                    Notes from the chart
                  </Typography>
                  {pre(String(detail.status.info.notes).trim())}
                </>
              ) : null}

              <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>
                Values you supplied
              </Typography>
              {detail.values_yaml ? (
                pre(detail.values_yaml)
              ) : (
                <Typography variant="body2" sx={{ color: DIM }}>
                  This release was installed with the chart's default values.
                </Typography>
              )}

              <Typography variant="subtitle2" sx={{ mt: 2, mb: 0.5 }}>
                History
              </Typography>
              {detail.history && detail.history.length > 0 ? (
                <Box
                  component="table"
                  sx={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    fontSize: '0.85rem',
                    '& th': { textAlign: 'left', color: DIM, fontWeight: 500, py: 0.5, pr: 2, borderBottom: '1px solid #1d2a1d' },
                    '& td': { py: 0.5, pr: 2, borderBottom: '1px solid #141d14' },
                  }}
                >
                  <thead>
                    <tr>
                      <th>Revision</th>
                      <th>Updated</th>
                      <th>Status</th>
                      <th>Chart</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.history.map(entry => (
                      <tr key={entry.revision}>
                        <td>{entry.revision}</td>
                        <td style={{ color: DIM }}>{entry.updated}</td>
                        <td style={{ color: statusColour(entry.status) }}>{entry.status}</td>
                        <td>
                          {entry.chart} {entry.app_version}
                        </td>
                        <td>{entry.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </Box>
              ) : (
                <Typography variant="body2" sx={{ color: DIM }}>
                  No history returned for this release.
                </Typography>
              )}

              <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 2 }}>
                <Typography variant="subtitle2">Rendered manifest</Typography>
                <Button size="small" onClick={() => setShowManifest(!showManifest)}>
                  {showManifest ? 'Hide' : 'Show'}
                </Button>
                {detail.manifest_truncated ? (
                  <Typography variant="caption" sx={{ color: DIM }}>
                    (truncated at 256 KiB)
                  </Typography>
                ) : null}
              </Box>
              {showManifest ? (
                <Box sx={{ mt: 1 }}>
                  {detail.manifest
                    ? pre(detail.manifest)
                    : detail.manifest_error
                      ? <ErrorLine text={detail.manifest_error} />
                      : <Typography variant="body2" sx={{ color: DIM }}>The manifest is empty.</Typography>}
                </Box>
              ) : null}
            </>
          ) : null}
        </Box>
      ) : null}

      {config && selected && detail ? (
        <>
          <UpgradeDialog
            open={dialog === 'upgrade'}
            config={config}
            release={selected}
            detail={detail}
            uploads={uploads}
            onClose={() => setDialog(null)}
            onDone={async message => {
              setDialog(null);
              setFlash(message);
              await afterChange();
            }}
          />
          <RollbackDialog
            open={dialog === 'rollback'}
            config={config}
            release={selected}
            detail={detail}
            onClose={() => setDialog(null)}
            onDone={async message => {
              setDialog(null);
              setFlash(message);
              await afterChange();
            }}
          />
          <UninstallDialog
            open={dialog === 'uninstall'}
            config={config}
            release={selected}
            onClose={() => setDialog(null)}
            onDone={async message => {
              setDialog(null);
              setSelected(null);
              setFlash(message);
              await loadReleases();
            }}
          />
        </>
      ) : null}
    </SectionBox>
  );
}

/* ---- upgrade ------------------------------------------------------------- */

function UpgradeDialog({
  open,
  config,
  release,
  detail,
  uploads,
  onClose,
  onDone,
}: {
  open: boolean;
  config: ConsoleConfig;
  release: Release;
  detail: Detail;
  uploads: Uploaded[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const installedChart = `${detail.metadata?.chart ?? release.chart}-${
    detail.metadata?.version ?? ''
  }`;
  const [chart, setChart] = React.useState('');
  const [values, setValues] = React.useState('');
  const [preview, setPreview] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [previewed, setPreviewed] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setChart('');
    setValues(detail.values_yaml ?? '');
    setPreview('');
    setError('');
    setBusy(false);
    setPreviewed(false);
  }, [open, detail.values_yaml]);

  // Any edit invalidates the preview: what the user saw is no longer what would be applied.
  const touch = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setPreviewed(false);
    setPreview('');
  };

  const body = () => ({
    action: 'upgrade',
    name: release.name,
    namespace: release.namespace,
    chart,
    values,
  });

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError('');
    try {
      const output = await helmAction(config, { ...body(), dryRun });
      if (dryRun) {
        setPreview(output);
        setPreviewed(true);
      } else {
        await onDone(`Upgraded ${release.namespace}/${release.name}.`);
      }
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
      setPreviewed(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <HelmDialog
      open={open}
      title={`Upgrade ${release.namespace}/${release.name}`}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => run(true)} disabled={busy}>
            {busy ? 'working…' : 'Preview'}
          </Button>
          <Button
            variant="contained"
            disabled={busy || !previewed}
            onClick={() => run(false)}
            data-testid="kubeos-helm-upgrade-apply"
          >
            Upgrade
          </Button>
        </>
      }
    >
      <Typography variant="body2" sx={{ color: DIM, mb: 2 }}>
        Installed chart: <strong>{installedChart}</strong>. Leave the chart empty to reuse it — the
        node finds the uploaded file it came from. A value change alone only needs the values box.
      </Typography>
      <ChartSource
        config={config}
        uploads={uploads}
        value={chart}
        onChange={touch(setChart)}
        hint="Empty means: keep the chart this release was installed from."
      />
      <ValuesEditor
        value={values}
        onChange={touch(setValues)}
        hint="The release's current values, ready to edit. Empty means: chart defaults."
      />
      <PreviewPanel text={preview} />
      <ErrorLine text={error} />
    </HelmDialog>
  );
}

/* ---- rollback ------------------------------------------------------------ */

function RollbackDialog({
  open,
  config,
  release,
  detail,
  onClose,
  onDone,
}: {
  open: boolean;
  config: ConsoleConfig;
  release: Release;
  detail: Detail;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const history = detail.history ?? [];
  const current = Number(detail.status?.version ?? release.revision ?? 0);
  const candidates = history.filter(entry => entry.revision !== current);
  const [revision, setRevision] = React.useState<number | null>(null);
  const [confirm, setConfirm] = React.useState('');
  const [preview, setPreview] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setRevision(candidates.length > 0 ? candidates[0].revision : null);
    setConfirm('');
    setPreview('');
    setError('');
    setBusy(false);
    // candidates is derived per render; keying on `open` is what matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const run = async (dryRun: boolean) => {
    if (revision === null) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const output = await helmAction(config, {
        action: 'rollback',
        name: release.name,
        namespace: release.namespace,
        revision,
        confirm,
        dryRun,
      });
      if (dryRun) {
        setPreview(output);
      } else {
        await onDone(`Rolled ${release.namespace}/${release.name} back to revision ${revision}.`);
      }
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <HelmDialog
      open={open}
      title={`Roll back ${release.namespace}/${release.name}`}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => run(true)} disabled={busy || revision === null}>
            Preview
          </Button>
          <Button
            variant="contained"
            disabled={busy || revision === null || confirm !== release.name}
            onClick={() => run(false)}
          >
            Roll back
          </Button>
        </>
      }
    >
      <Typography variant="body2" sx={{ color: DIM, mb: 2 }}>
        A rollback creates a NEW revision with the old contents; nothing is deleted from the
        history. Current revision: <strong>{current}</strong>.
      </Typography>
      <Box component="select"
        value={revision === null ? '' : String(revision)}
        onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
          setRevision(Number(event.target.value));
          setPreview('');
        }}
        sx={{
          background: '#0d130d', color: '#d6e2d2', border: '1px solid #1d2a1d',
          borderRadius: '4px', p: 0.75, mb: 2, fontFamily: 'monospace', fontSize: '0.85rem',
          minWidth: 340,
        }}
      >
        {candidates.map(entry => (
          <option key={entry.revision} value={entry.revision}>
            revision {entry.revision} · {entry.status} · {entry.chart} {entry.app_version} · {entry.description}
          </option>
        ))}
      </Box>
      <TextField
        size="small"
        label={`type ${release.name} to confirm`}
        value={confirm}
        onChange={event => setConfirm(event.target.value)}
        fullWidth
        sx={{ mb: 2 }}
      />
      <PreviewPanel text={preview} />
      <ErrorLine text={error} />
    </HelmDialog>
  );
}

/* ---- uninstall ----------------------------------------------------------- */

function UninstallDialog({
  open,
  config,
  release,
  onClose,
  onDone,
}: {
  open: boolean;
  config: ConsoleConfig;
  release: Release;
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const protectedNamespace = PROTECTED_NAMESPACES.includes(release.namespace);
  const [confirm, setConfirm] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setConfirm('');
    setError('');
    setBusy(false);
  }, [open]);

  return (
    <HelmDialog
      open={open}
      title={`Uninstall ${release.namespace}/${release.name}`}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="contained"
            sx={{ background: RED, color: '#1a0000' }}
            disabled={busy || protectedNamespace || confirm !== release.name}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await helmAction(config, {
                  action: 'uninstall',
                  name: release.name,
                  namespace: release.namespace,
                  confirm,
                });
                await onDone(`Uninstalled ${release.namespace}/${release.name}.`);
              } catch (reason: any) {
                setError(String(reason?.message ?? reason));
              } finally {
                setBusy(false);
              }
            }}
          >
            Uninstall
          </Button>
        </>
      }
    >
      <Typography variant="body2" sx={{ color: DIM, mb: 2 }}>
        This deletes the objects this release created. The namespace itself is left in place, and
        the cluster's own services are out of reach here: a release in{' '}
        {PROTECTED_NAMESPACES.join(' or ')} is refused by the node even if this page asked.
      </Typography>
      {protectedNamespace ? (
        <Box sx={{ mb: 2, color: RED }}>
          {release.namespace} holds this node's own services, so this release cannot be uninstalled
          from the dashboard. Use kubectl on the node.
        </Box>
      ) : null}
      <TextField
        size="small"
        label={`type ${release.name} to confirm`}
        value={confirm}
        onChange={event => setConfirm(event.target.value)}
        fullWidth
        disabled={protectedNamespace}
      />
      <ErrorLine text={error} />
    </HelmDialog>
  );
}

/* ---- install page -------------------------------------------------------- */

export function HelmInstallPage() {
  const [config, setConfig] = React.useState<ConsoleConfig | null>(null);
  const [uploads, setUploads] = React.useState<Uploaded[]>([]);
  const [chart, setChart] = React.useState('');
  const [name, setName] = React.useState('');
  const [namespace, setNamespace] = React.useState('default');
  const [values, setValues] = React.useState('');
  const [preview, setPreview] = React.useState('');
  const [previewed, setPreviewed] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const [done, setDone] = React.useState('');

  React.useEffect(() => {
    (async () => {
      try {
        const cfg = await consoleConfig();
        setConfig(cfg);
        setUploads(await listCharts(cfg));
      } catch (reason: any) {
        setError(String(reason?.message ?? reason));
      }
    })();
  }, []);

  const touch =
    (setter: (value: string) => void) =>
    (value: string) => {
      setter(value);
      setPreviewed(false);
      setPreview('');
    };

  const ready = Boolean(config && chart && name && namespace);

  const run = async (dryRun: boolean) => {
    if (!config) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const output = await helmAction(config, {
        action: 'install',
        name,
        namespace,
        chart,
        values,
        dryRun,
      });
      if (dryRun) {
        setPreview(output);
        setPreviewed(true);
      } else {
        setDone(`Installed ${namespace}/${name}.`);
        setUploads(await listCharts(config));
      }
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
      setPreviewed(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionBox title="Install">
      <Typography variant="body2" sx={{ color: DIM, mb: 2 }}>
        The same as <code>helm install &lt;name&gt; &lt;chart&gt; -n &lt;namespace&gt; -f values.yaml</code>,
        except that the node renders a preview first and nothing is applied until you press
        Install.
      </Typography>

      {done ? (
        <Box sx={{ mb: 2, color: LIME }} data-testid="kubeos-helm-install-done">
          {done}{' '}
          <Button size="small" onClick={() => window.location.assign(releasesUrl())}>
            Open Releases
          </Button>
        </Box>
      ) : null}
      {error ? (
        <Box
          sx={{ mb: 2, p: 1.5, border: `1px solid ${RED}`, borderRadius: '4px', color: RED, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: '0.85rem' }}
          data-testid="kubeos-helm-install-error"
        >
          {error}
        </Box>
      ) : null}

      <ChartSource
        config={config}
        uploads={uploads}
        value={chart}
        onChange={touch(setChart)}
        hint="Upload a packaged chart (.tgz), or point at a chart path that already exists on the node."
      />

      <Box sx={{ display: 'flex', gap: 2, mb: 2, flexWrap: 'wrap' }}>
        <TextField
          size="small"
          label="Release name"
          value={name}
          onChange={event => touch(setName)(event.target.value)}
          sx={{ minWidth: 220 }}
          placeholder="web"
        />
        <TextField
          size="small"
          label="Namespace"
          value={namespace}
          onChange={event => touch(setNamespace)(event.target.value)}
          sx={{ minWidth: 220 }}
        />
      </Box>

      <ValuesEditor
        value={values}
        onChange={touch(setValues)}
        hint="Optional. YAML, exactly as a values file."
      />

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', mb: 2 }}>
        <Button variant="outlined" disabled={!ready || busy} onClick={() => run(true)}>
          {busy ? 'working…' : 'Preview'}
        </Button>
        <Button
          variant="contained"
          disabled={!ready || busy || !previewed}
          onClick={() => run(false)}
          data-testid="kubeos-helm-install-apply"
        >
          Install
        </Button>
        <Typography variant="caption" sx={{ color: DIM }}>
          {previewed
            ? 'Previewed — what you see above is what will be created.'
            : 'Preview first: Install stays disabled until the node has rendered this release.'}
        </Typography>
      </Box>

      <PreviewPanel text={preview} />
    </SectionBox>
  );
}

/* ---- registration -------------------------------------------------------- */

// A GROUP with children, not one page: "Releases" is what you look at, "Install" is what you do.
// Every entry carries `url` - an entry with a name but no url renders as a group heading and
// cannot be clicked at all (the bug 0.1.0-15 shipped, found by the user).
registerSidebarEntry({
  parent: null,
  name: GROUP,
  label: 'Helm',
  icon: 'mdi:package-variant-closed',
});
// No `icon` on the children on purpose (user, 2026-11-22): the little glyphs in front of
// "Releases" and "Install" were noise next to the group's own icon. Only these two entries changed.
registerSidebarEntry({
  parent: GROUP,
  name: RELEASES_ENTRY,
  label: 'Releases',
  url: RELEASES_PATH,
});
registerSidebarEntry({
  parent: GROUP,
  name: INSTALL_ENTRY,
  label: 'Install',
  url: INSTALL_PATH,
});
registerRoute({
  path: RELEASES_PATH,
  sidebar: RELEASES_ENTRY,
  name: RELEASES_ENTRY,
  exact: true,
  component: HelmReleasesPage,
});
registerRoute({
  path: INSTALL_PATH,
  sidebar: INSTALL_ENTRY,
  name: INSTALL_ENTRY,
  exact: true,
  component: HelmInstallPage,
});
