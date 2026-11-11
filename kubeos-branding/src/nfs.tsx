/**
 * KubeOS "NFS" page, registered INSIDE Headlamp's own Storage section
 * (sidebar `parent: 'storage'`, so it sits next to Persistent Volume Claims,
 * Persistent Volumes, Storage Classes and Volume Attributes Classes).
 *
 * WHY THIS PAGE EXISTS
 *   KubeOS's dynamic storage is a host service (/usr/bin/kubeos-storage-provisioner)
 *   that produces hostPath volumes: node-local, and therefore ReadWriteOnce only.
 *   NFS is the one thing that class structurally cannot do - a volume several Pods
 *   write at once, whose data lives off the node. The Platform side now ships the
 *   NFS *client* (package `nfs-common`) and a documented static example
 *   (/usr/share/kubeos/examples/nfs-static-pv.yaml), but attaching an export meant
 *   hand-editing YAML. This page is that form.
 *
 * WHAT IT CANNOT DO, AND SAYS SO ON SCREEN: KubeOS has no NFS server and no NFS
 * provisioner. Every volume is one PV pointing at one exported directory, created
 * here by an admin. There is no "create a new volume of N capacity" - the capacity
 * field is documentation for the scheduler, NFS enforces no quota (exactly like
 * local-path).
 *
 * SAFETY DECISIONS
 *   * The StorageClass this page creates is `nfs-static`, never the cluster default
 *     (`local-path` stays default: a claim that names no class must keep binding to
 *     node-local storage).
 *   * `volumeBindingMode: Immediate` - an NFS volume is not tied to a node, so
 *     there is nothing to wait for, unlike local-path.
 *   * Reclaim defaults to `Retain`, and the form cannot create a PV with anything
 *     else unless the user picks it explicitly with the consequence spelled out: an
 *     NFS export usually holds data that outlives the claim, and a mistyped claim
 *     name must never delete files that may belong to another system.
 *   * No delete action here. Removing an NFS volume happens on Storage → Persistent
 *     Volumes, where `Retain` still protects the data; a "delete" button on a page
 *     about external storage invites exactly the mistake this class is designed to
 *     avoid.
 */
import {
  ApiProxy,
  registerRoute,
  registerSidebarEntry,
} from "@kinvolk/headlamp-plugin/lib";
import { SectionBox } from "@kinvolk/headlamp-plugin/lib/CommonComponents";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControl from "@mui/material/FormControl";
import FormControlLabel from "@mui/material/FormControlLabel";
import InputLabel from "@mui/material/InputLabel";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import React from "react";
import { BRAND } from "./brand";

/** Sidebar/route identity. `PARENT` is Headlamp's own Storage group. */
const PARENT = "storage";
const ENTRY = "kubeos-storage-nfs";
const PATH = "/kubeos-storage/nfs";

/** Must match /usr/share/kubeos/examples/nfs-static-pv.yaml on the Platform side. */
const CLASS_NAME = "nfs-static";
/**
 * NFSv4.1 needs no rpcbind and no portmapper on the client, and pinning the
 * protocol turns "protocol not supported" (a v4 export mounted as v3) into a clear
 * failure instead of a silent one. `hard` keeps retrying rather than failing a
 * write mid-flight, which for a database on NFS is the behaviour you want.
 */
const DEFAULT_MOUNT_OPTIONS = "nfsvers=4.1,hard,timeo=600,retrans=2";
const DEFAULT_CAPACITY_GIB = 20;
const ACCESS_MODES = [
  "ReadWriteMany",
  "ReadWriteOnce",
  "ReadOnlyMany",
] as const;
const RECLAIM_POLICIES = ["Retain", "Delete"] as const;

type AccessMode = (typeof ACCESS_MODES)[number];
type ReclaimPolicy = (typeof RECLAIM_POLICIES)[number];

export type NfsVolume = {
  name: string;
  server: string;
  path: string;
  capacity: string;
  accessModes: string[];
  mountOptions: string[];
  reclaimPolicy: string;
  storageClassName: string;
  phase: string;
  /** `namespace/name`, or null while the PV is unbound. */
  claim: string | null;
  /**
   * Whether that claim still EXISTS. `spec.claimRef` survives on a released PV, so
   * "a claimRef is set" is not the same question as "something still claims me" -
   * conflating the two made the Remove action unusable on an already-released volume
   * (measured 2026-11-11 on the live node).
   */
  claimExists: boolean;
  readOnly: boolean;
  created: string;
};

/* ---- API access ---------------------------------------------------------- */

/**
 * ApiProxy wraps some responses in a `.json` field and returns others bare, so
 * every caller has to cope with both shapes. One helper keeps that out of the
 * page code.
 */
async function apiJson<T>(path: string): Promise<T> {
  const response: any = await ApiProxy.request(path);
  return (response?.json ?? response) as T;
}

async function readNfs(): Promise<{
  volumes: NfsVolume[];
  classPresent: boolean;
}> {
  const [pvList, scList, pvcList] = await Promise.all([
    apiJson<{ items: any[] }>("/api/v1/persistentvolumes"),
    apiJson<{ items: any[] }>("/apis/storage.k8s.io/v1/storageclasses"),
    // One list instead of one request per volume, and it is the only way to tell a
    // live claim from the claimRef a released PV keeps.
    apiJson<{ items: any[] }>("/api/v1/persistentvolumeclaims"),
  ]);
  const liveClaims = new Set(
    (pvcList?.items ?? []).map(
      (pvc: any) => `${pvc?.metadata?.namespace}/${pvc?.metadata?.name}`
    )
  );

  const volumes: NfsVolume[] = (pvList?.items ?? [])
    .filter((pv: any) => pv?.spec?.nfs)
    .map((pv: any) => {
      const claimRef = pv?.spec?.claimRef;
      return {
        name: pv.metadata?.name ?? "?",
        server: pv.spec.nfs.server ?? "?",
        path: pv.spec.nfs.path ?? "?",
        capacity: pv.spec?.capacity?.storage ?? "-",
        accessModes: pv.spec?.accessModes ?? [],
        mountOptions: pv.spec?.mountOptions ?? [],
        reclaimPolicy: pv.spec?.persistentVolumeReclaimPolicy ?? "-",
        storageClassName: pv.spec?.storageClassName ?? "",
        phase: pv.status?.phase ?? "Unknown",
        claim: claimRef?.name
          ? `${claimRef.namespace ?? "?"}/${claimRef.name}`
          : null,
        claimExists: Boolean(
          claimRef?.name &&
            liveClaims.has(`${claimRef.namespace ?? "?"}/${claimRef.name}`)
        ),
        readOnly: Boolean(pv.spec.nfs.readOnly),
        created: pv.metadata?.creationTimestamp ?? "",
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const classPresent = (scList?.items ?? []).some(
    (sc: any) => sc?.metadata?.name === CLASS_NAME
  );
  return { volumes, classPresent };
}

function useNfs() {
  const [volumes, setVolumes] = React.useState<NfsVolume[]>([]);
  const [classPresent, setClassPresent] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const load = React.useCallback(() => {
    setLoading(true);
    readNfs()
      .then((state) => {
        setVolumes(state.volumes);
        setClassPresent(state.classPresent);
        setError(null);
      })
      .catch((reason) => setError(String(reason?.message ?? reason)))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(load, [load]);
  return { volumes, classPresent, error, loading, reload: load };
}

/* ---- creation ------------------------------------------------------------ */

/** DNS-1123 subdomain, which is what both a PV and a PVC name must satisfy. */
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;

/** `nfs-<last path segment>`, so a PV name says which export it is. */
function suggestName(path: string): string {
  const segment = path.replace(/\/+$/, "").split("/").filter(Boolean).pop();
  const base = (segment ?? "export").toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  const trimmed = base.replace(/^[^a-z0-9]+/, "").replace(/[^a-z0-9]+$/, "");
  return `nfs-${trimmed || "export"}`;
}

type CreateRequest = {
  name: string;
  server: string;
  path: string;
  capacityGib: number;
  accessMode: AccessMode;
  mountOptions: string;
  reclaimPolicy: ReclaimPolicy;
  createClaim: boolean;
  claimNamespace: string;
  claimName: string;
};

/**
 * Create the pieces in dependency order: StorageClass (once per cluster) → PV →
 * optional PVC. A 409 on the class is success (someone already made it), and the
 * claim is reported as a warning rather than rolled back if the PV succeeded -
 * half of this is still useful, and saying so beats a silent partial state.
 */
async function createNfsVolume(
  request: CreateRequest,
  classPresent: boolean
): Promise<{ warnings: string[] }> {
  const warnings: string[] = [];
  const options = request.mountOptions
    .split(",")
    .map((option) => option.trim())
    .filter(Boolean);

  if (!classPresent) {
    const storageClass = {
      apiVersion: "storage.k8s.io/v1",
      kind: "StorageClass",
      metadata: {
        name: CLASS_NAME,
        labels: { "kubeos.in/component": "nfs" },
        // Deliberately NO is-default-class annotation: local-path must stay the
        // default so a claim that names no class keeps getting node-local storage.
      },
      // No provisioner behind this class: the PVs are made by hand, here.
      provisioner: "kubernetes.io/no-provisioner",
      volumeBindingMode: "Immediate",
      reclaimPolicy: request.reclaimPolicy,
    };
    try {
      await ApiProxy.post(
        "/apis/storage.k8s.io/v1/storageclasses",
        storageClass
      );
    } catch (reason: any) {
      if (
        !/already exists|AlreadyExists/i.test(String(reason?.message ?? reason))
      ) {
        throw reason;
      }
    }
  }

  const persistentVolume = {
    apiVersion: "v1",
    kind: "PersistentVolume",
    metadata: {
      name: request.name,
      labels: { "kubeos.in/component": "nfs" },
      annotations: { "kubeos.io/export": `${request.server}:${request.path}` },
    },
    spec: {
      capacity: { storage: `${request.capacityGib}Gi` },
      accessModes: [request.accessMode],
      volumeMode: "Filesystem",
      storageClassName: CLASS_NAME,
      persistentVolumeReclaimPolicy: request.reclaimPolicy,
      mountOptions: options,
      nfs: {
        server: request.server,
        path: request.path,
        readOnly: request.accessMode === "ReadOnlyMany",
      },
    },
  };
  await ApiProxy.post("/api/v1/persistentvolumes", persistentVolume);

  if (request.createClaim) {
    const claim = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: { name: request.claimName, namespace: request.claimNamespace },
      spec: {
        accessModes: [request.accessMode],
        storageClassName: CLASS_NAME,
        // Pin it: with several same-sized NFS PVs the binder could otherwise pick
        // a different export than the one just created.
        volumeName: request.name,
        resources: { requests: { storage: `${request.capacityGib}Gi` } },
      },
    };
    try {
      await ApiProxy.post(
        `/api/v1/namespaces/${request.claimNamespace}/persistentvolumeclaims`,
        claim
      );
    } catch (reason: any) {
      warnings.push(
        `the volume was created, but the claim ${request.claimNamespace}/${request.claimName} ` +
          `was not: ${String(reason?.message ?? reason)}`
      );
    }
  }

  return { warnings };
}

/* ---- detaching and removing --------------------------------------------- */

type PodRef = { namespace: string; name: string; phase: string };

/**
 * Pods that mount this claim. Checked at click time, not from cached page data:
 * the question "is it safe to release this claim" must be answered by the cluster
 * as it is now, not by what the table rendered a minute ago.
 */
async function podsUsingClaim(
  namespace: string,
  claimName: string
): Promise<PodRef[]> {
  const list = await apiJson<{ items: any[] }>(
    `/api/v1/namespaces/${namespace}/pods`
  );
  return (list?.items ?? [])
    .filter((pod: any) =>
      (pod?.spec?.volumes ?? []).some(
        (volume: any) => volume?.persistentVolumeClaim?.claimName === claimName
      )
    )
    .map((pod: any) => ({
      namespace: pod?.metadata?.namespace ?? "?",
      name: pod?.metadata?.name ?? "?",
      phase: pod?.status?.phase ?? "?",
    }));
}

/**
 * Release the claim. The PV is left alone on purpose: with `Retain` the data on the
 * export is untouched either way, and keeping the PV means the volume can be claimed
 * again without re-entering the server and path.
 */
async function detachClaim(claim: string): Promise<void> {
  const [namespace, name] = claim.split("/");
  await ApiProxy.remove(
    `/api/v1/namespaces/${namespace}/persistentvolumeclaims/${name}`
  );
}

/**
 * Delete the PV object. This can never delete the files on the NFS server - the
 * Kubernetes API has no such operation for NFS - which is exactly why the dialog
 * says so out loud instead of leaving the user to guess.
 */
async function removeVolume(name: string): Promise<void> {
  await ApiProxy.remove(`/api/v1/persistentvolumes/${name}`);
}

/* ---- presentation -------------------------------------------------------- */

const mono = { fontFamily: "monospace", fontSize: "0.85rem" } as const;
const dialogNote = {
  display: "block",
  mb: 2,
  color: BRAND.text.muted,
} as const;

function Note({ children }: { children: React.ReactNode }) {
  return (
    <Typography
      variant="caption"
      sx={{ display: "block", mt: 1.5, color: BRAND.text.muted }}
    >
      {children}
    </Typography>
  );
}

/** Phase colour: only "something needs attention" and "healthy" earn a colour. */
function phaseColour(phase: string): string {
  switch (phase) {
    case "Bound":
      return BRAND.lime.primary;
    case "Available":
      return BRAND.text.body;
    case "Released":
    case "Failed":
      return "#E0A030";
    default:
      return BRAND.text.muted;
  }
}

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
    <Box
      sx={{
        border: `1px solid ${BRAND.bg.muted}`,
        borderRadius: `${BRAND.radius}px`,
      }}
    >
      <Box
        sx={{
          display: "grid",
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
            sx={{
              color: BRAND.text.muted,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            {column}
          </Typography>
        ))}
      </Box>
      {rows.map((cells, rowIndex) => (
        <Box
          key={rowIndex}
          sx={{
            display: "grid",
            gridTemplateColumns: template,
            gap: 2,
            px: 1.5,
            py: 1,
            alignItems: "center",
            borderTop: `1px solid ${BRAND.bg.muted}`,
            "&:hover": { backgroundColor: BRAND.bg.muted },
          }}
        >
          {cells.map((cell, cellIndex) => (
            <Box key={cellIndex} sx={{ minWidth: 0, overflow: "hidden" }}>
              {cell}
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function StatusLine({
  classPresent,
  volumes,
  loading,
  reload,
}: {
  classPresent: boolean;
  volumes: NfsVolume[];
  loading: boolean;
  reload: () => void;
}) {
  const bound = volumes.filter((volume) => volume.phase === "Bound").length;
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 2,
        flexWrap: "wrap",
        mb: 2,
      }}
    >
      <Typography variant="body2" sx={{ color: BRAND.text.muted }}>
        StorageClass{" "}
        <Box
          component="span"
          sx={{ ...mono, color: classPresent ? BRAND.lime.primary : "#E0A030" }}
        >
          {CLASS_NAME}
        </Box>{" "}
        {classPresent ? "exists" : "not created yet"} · {volumes.length} NFS
        volume
        {volumes.length === 1 ? "" : "s"} · {bound} bound
      </Typography>
      <Button
        size="small"
        variant="outlined"
        onClick={reload}
        disabled={loading}
      >
        {loading ? "Loading…" : "Reload"}
      </Button>
    </Box>
  );
}

/* ---- the create dialog --------------------------------------------------- */

function AddNfsDialog({
  open,
  classPresent,
  onClose,
  onCreated,
}: {
  open: boolean;
  classPresent: boolean;
  onClose: () => void;
  onCreated: (warnings: string[]) => void;
}) {
  const [server, setServer] = React.useState("");
  const [path, setPath] = React.useState("");
  const [name, setName] = React.useState("");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [capacity, setCapacity] = React.useState(String(DEFAULT_CAPACITY_GIB));
  const [accessMode, setAccessMode] =
    React.useState<AccessMode>("ReadWriteMany");
  const [mountOptions, setMountOptions] = React.useState(DEFAULT_MOUNT_OPTIONS);
  const [reclaimPolicy, setReclaimPolicy] =
    React.useState<ReclaimPolicy>("Retain");
  const [createClaim, setCreateClaim] = React.useState(true);
  const [claimNamespace, setClaimNamespace] = React.useState("default");
  const [claimName, setClaimName] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    setServer("");
    setPath("");
    setName("");
    setNameTouched(false);
    setCapacity(String(DEFAULT_CAPACITY_GIB));
    setAccessMode("ReadWriteMany");
    setMountOptions(DEFAULT_MOUNT_OPTIONS);
    setReclaimPolicy("Retain");
    setCreateClaim(true);
    setClaimNamespace("default");
    setClaimName("");
    setError(null);
    setBusy(false);
  }, [open]);

  // The volume name follows the path until the user edits it by hand.
  const effectiveName = nameTouched ? name : path ? suggestName(path) : "";
  const effectiveClaimName = claimName || effectiveName;
  const capacityGib = Number(capacity);
  const nameValid = NAME_PATTERN.test(effectiveName);
  const namespaceValid = NAME_PATTERN.test(claimNamespace);
  const claimValid =
    !createClaim || (namespaceValid && NAME_PATTERN.test(effectiveClaimName));
  const pathValid = path.startsWith("/") && path.length > 1;
  const canSubmit =
    !busy &&
    server.trim().length > 0 &&
    pathValid &&
    nameValid &&
    claimValid &&
    Number.isFinite(capacityGib) &&
    capacityGib > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { warnings } = await createNfsVolume(
        {
          name: effectiveName,
          server: server.trim(),
          path: path.trim(),
          capacityGib,
          accessMode,
          mountOptions,
          reclaimPolicy,
          createClaim,
          claimNamespace,
          claimName: effectiveClaimName.trim(),
        },
        classPresent
      );
      onCreated(warnings);
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Add an NFS volume</DialogTitle>
      <DialogContent dividers>
        <Typography variant="caption" sx={dialogNote}>
          Attaches an <strong>existing</strong> NFS export to this cluster.
          KubeOS has no NFS server: this is where you point it at yours. One
          volume per exported directory.
        </Typography>

        <TextField
          label="NFS server"
          placeholder="192.168.1.10"
          value={server}
          onChange={(event) => setServer(event.target.value)}
          fullWidth
          margin="dense"
          helperText="Hostname or IP of the server. `showmount -e <server>` lists its exports."
        />
        <TextField
          label="Exported path"
          placeholder="/export/kubeos"
          value={path}
          onChange={(event) => setPath(event.target.value)}
          fullWidth
          margin="dense"
          error={path.length > 0 && !pathValid}
          helperText="The exported directory itself, not a subdirectory of it."
        />
        <TextField
          label="Volume name"
          value={effectiveName}
          onChange={(event) => {
            setNameTouched(true);
            setName(event.target.value);
          }}
          fullWidth
          margin="dense"
          error={effectiveName.length > 0 && !nameValid}
          helperText="Lowercase letters, digits, '-' and '.' - used as the PersistentVolume name."
        />
        <TextField
          label="Capacity (GiB)"
          type="number"
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
          margin="dense"
          sx={{ width: 200 }}
          helperText="Documentation only: NFS enforces no quota."
        />

        <Box sx={{ display: "flex", gap: 2, mt: 1, flexWrap: "wrap" }}>
          <FormControl size="small" sx={{ minWidth: 190 }}>
            <InputLabel>Access mode</InputLabel>
            <Select
              label="Access mode"
              value={accessMode}
              onChange={(event) =>
                setAccessMode(event.target.value as AccessMode)
              }
            >
              {ACCESS_MODES.map((mode) => (
                <MenuItem key={mode} value={mode}>
                  {mode}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 170 }}>
            <InputLabel>Reclaim policy</InputLabel>
            <Select
              label="Reclaim policy"
              value={reclaimPolicy}
              onChange={(event) =>
                setReclaimPolicy(event.target.value as ReclaimPolicy)
              }
            >
              {RECLAIM_POLICIES.map((policy) => (
                <MenuItem key={policy} value={policy}>
                  {policy}
                </MenuItem>
              ))}
            </Select>
          </FormControl>
        </Box>
        <Typography variant="caption" sx={dialogNote}>
          {accessMode === "ReadWriteMany"
            ? "ReadWriteMany is why you are here: several Pods can write at once."
            : "ReadWriteOnce works over NFS too, but the volume is not pinned to a node - any Pod on any node may use it."}{" "}
          {reclaimPolicy === "Retain"
            ? "Retain: deleting the claim keeps the PV and the data on the export."
            : "Delete: deleting the claim also removes the PV. Kubernetes still never deletes the files on the export, but nothing protects them either."}
        </Typography>

        <TextField
          label="Mount options"
          value={mountOptions}
          onChange={(event) => setMountOptions(event.target.value)}
          fullWidth
          margin="dense"
          helperText="Comma separated, passed to mount.nfs. Keep nfsvers pinned to what your server exports."
        />

        <FormControlLabel
          control={
            <Checkbox
              checked={createClaim}
              onChange={(event) => setCreateClaim(event.target.checked)}
            />
          }
          label="Also create a claim bound to this volume"
          sx={{ mt: 1 }}
        />
        {createClaim && (
          <Box sx={{ display: "flex", gap: 2 }}>
            <TextField
              label="Namespace"
              value={claimNamespace}
              onChange={(event) => setClaimNamespace(event.target.value)}
              margin="dense"
              size="small"
              error={claimNamespace.length > 0 && !namespaceValid}
            />
            <TextField
              label="Claim name"
              value={effectiveClaimName}
              onChange={(event) => setClaimName(event.target.value)}
              margin="dense"
              size="small"
              error={
                effectiveClaimName.length > 0 &&
                !NAME_PATTERN.test(effectiveClaimName)
              }
            />
          </Box>
        )}

        <Note>
          The export must let this Pod write as its own UID. With NFS&apos;s
          default <code>root_squash</code> a Pod running as root writes as{" "}
          <code>nobody</code>; either allow it on the export (
          <code>no_root_squash</code>) or set <code>fsGroup</code> on the Pod.
          Whether the node can mount NFS at all is a Platform-side fact: the ISO
          ships <code>nfs-common</code> since 2026-11-11, older builds did not.
        </Note>

        {error && (
          <Typography
            variant="body2"
            sx={{ mt: 2, color: "#E05050", ...mono, wordBreak: "break-word" }}
          >
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!canSubmit}>
          {busy ? "Creating…" : "Create volume"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ---- the detach / remove dialog ----------------------------------------- */

type VolumeAction = { kind: "detach" | "remove"; volume: NfsVolume } | null;

function VolumeActionDialog({
  action,
  onClose,
  onDone,
  onSwitchToDetach,
}: {
  action: VolumeAction;
  onClose: () => void;
  onDone: (message: string) => void;
  /** Turns a blocked Remove into the Detach that unblocks it, instead of a dead end. */
  onSwitchToDetach: () => void;
}) {
  const [pods, setPods] = React.useState<PodRef[] | null>(null);
  const [typed, setTyped] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const volume = action?.volume ?? null;
  const claim = volume?.claim ?? null;

  React.useEffect(() => {
    setPods(null);
    setTyped("");
    setError(null);
    setBusy(false);
    if (action?.kind !== "detach" || !claim) {
      return;
    }
    const [namespace, name] = claim.split("/");
    // A failed check must not read as "nothing is using it": null means unknown and
    // the button stays disabled.
    podsUsingClaim(namespace, name)
      .then(setPods)
      .catch((reason) => {
        setPods([]);
        setError(
          `could not list the Pods using this claim: ${String(
            reason?.message ?? reason
          )}`
        );
      });
  }, [action, claim]);

  if (!volume || !action) {
    return null;
  }

  const isDetach = action.kind === "detach";
  const stillInUse = (pods?.length ?? 0) > 0;
  // A released PV keeps its claimRef, so only a claim that still exists blocks removal.
  const claimBlocksRemoval = !isDetach && volume.claimExists;
  const canSubmit = isDetach
    ? !busy && pods !== null && !stillInUse && !error
    : !busy && typed === volume.name && !claimBlocksRemoval;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (isDetach && claim) {
        await detachClaim(claim);
        onDone(
          `Claim ${claim} released. Volume ${volume.name} and its data are untouched.`
        );
      } else {
        await removeVolume(volume.name);
        onDone(
          `Volume ${volume.name} removed. Files on ${volume.server}:${volume.path} were not touched.`
        );
      }
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {isDetach ? "Detach claim" : "Remove volume"} — {volume.name}
      </DialogTitle>
      <DialogContent dividers>
        <Typography
          variant="body2"
          sx={{ ...mono, color: BRAND.text.muted, mb: 2 }}
        >
          {volume.server}:{volume.path}
        </Typography>

        {isDetach ? (
          <>
            {!volume.claimExists && (
              <Note>
                The claim <strong>{claim}</strong> no longer exists — this
                volume was already released. Detaching again is unnecessary.
              </Note>
            )}
            <Typography variant="body2">
              Releases <strong>{claim}</strong> so the volume can be claimed
              again. Reclaim policy is <strong>{volume.reclaimPolicy}</strong>,
              so{" "}
              {volume.reclaimPolicy === "Retain"
                ? "the volume object and every file on the export stay exactly as they are."
                : "the volume object is removed as well. Files on the NFS server are still never deleted by Kubernetes."}
            </Typography>
            {pods === null && !error && (
              <Note>Checking whether anything still uses this claim…</Note>
            )}
            {stillInUse && (
              <Typography variant="body2" sx={{ color: "#E0A030", mt: 2 }}>
                Still mounted by{" "}
                {pods
                  ?.map((pod) => `${pod.namespace}/${pod.name} (${pod.phase})`)
                  .join(", ")}
                . Delete or scale those down first — releasing the claim under a
                running Pod leaves it mounting a volume that no longer exists
                for it.
              </Typography>
            )}
          </>
        ) : (
          <>
            {claimBlocksRemoval && (
              <Typography variant="body2" sx={{ color: "#E0A030", mb: 2 }}>
                The claim <strong>{claim}</strong> still points at this volume.
                Detach it first — deleting a bound PersistentVolume leaves that
                claim stuck.
              </Typography>
            )}
            <Typography variant="body2">
              Deletes the PersistentVolume object.{" "}
              <strong>The files on the export are not deleted:</strong>{" "}
              Kubernetes has no operation that removes content from an NFS
              server, so they stay until someone removes them there.
            </Typography>
            {claimBlocksRemoval ? (
              // Do NOT render a disabled "type to confirm" box here. A disabled input looks
              // exactly like an empty one, so a user clicks it, nothing happens, and the page
              // reads as broken (reported 2026-11-11 with a screenshot). The field can never
              // be used while the removal itself is refused, so say why instead - and put the
              // action that unblocks it one click away.
              <Typography
                variant="body2"
                sx={{ color: BRAND.text.muted, mt: 1 }}
              >
                Removal stays disabled while a claim points at this volume, so
                there is nothing to type yet. Release the claim first with{" "}
                <strong>Detach claim instead</strong>, then remove the volume.
              </Typography>
            ) : (
              <TextField
                label={`Type ${volume.name} to confirm`}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                fullWidth
                margin="dense"
                inputProps={{ autoComplete: "off" }}
              />
            )}
          </>
        )}

        {error && (
          <Typography
            variant="body2"
            sx={{ mt: 2, color: "#E05050", ...mono, wordBreak: "break-word" }}
          >
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        {claimBlocksRemoval && (
          // The way out of the blocked state, right where the user is looking.
          <Button
            onClick={onSwitchToDetach}
            disabled={busy}
            sx={{ mr: "auto" }}
          >
            Detach claim instead
          </Button>
        )}
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={submit} disabled={!canSubmit}>
          {busy ? "Working…" : isDetach ? "Detach claim" : "Remove volume"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ---- the page ------------------------------------------------------------ */

function NfsPage() {
  const { volumes, classPresent, error, loading, reload } = useNfs();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [action, setAction] = React.useState<VolumeAction>(null);
  const [banner, setBanner] = React.useState<string | null>(null);

  const onCreated = (warnings: string[]) => {
    setDialogOpen(false);
    setBanner(
      warnings.length > 0
        ? warnings.join(" · ")
        : "NFS volume created. Pods that claim it can mount the export now."
    );
    reload();
  };

  return (
    <SectionBox title="NFS">
      <Typography variant="body2" sx={{ color: BRAND.text.muted, mb: 2 }}>
        NFS volumes on this cluster: storage that lives off the node, and the
        only way to get a volume several Pods write at once (
        <code>ReadWriteMany</code>). KubeOS has no NFS server - these point at
        an export you already run.
      </Typography>

      <StatusLine
        classPresent={classPresent}
        volumes={volumes}
        loading={loading}
        reload={reload}
      />

      <Box sx={{ display: "flex", gap: 2, alignItems: "center", mb: 2 }}>
        <Button variant="contained" onClick={() => setDialogOpen(true)}>
          Add NFS volume
        </Button>
        {banner && (
          <Typography variant="caption" sx={{ color: BRAND.lime.primary }}>
            {banner}
          </Typography>
        )}
      </Box>

      {error && (
        <Typography
          variant="body2"
          sx={{ color: "#E05050", ...mono, wordBreak: "break-word" }}
        >
          {error}
        </Typography>
      )}

      {!error && volumes.length === 0 && !loading && (
        <Box
          sx={{
            border: `1px dashed ${BRAND.bg.muted}`,
            borderRadius: `${BRAND.radius}px`,
            p: 3,
            textAlign: "center",
          }}
        >
          <Typography variant="body2" sx={{ color: BRAND.text.muted }}>
            No NFS volumes yet.
          </Typography>
          <Note>
            &quot;Add NFS volume&quot; needs a server and an exported path;
            nothing is created on the server itself.
          </Note>
        </Box>
      )}

      {volumes.length > 0 && (
        <DataTable
          columns={[
            "Name",
            "Export",
            "Capacity",
            "Access",
            "Status",
            "Claim",
            "Reclaim",
            "Actions",
          ]}
          template="minmax(110px,1.1fr) minmax(180px,1.8fr) 80px 120px 80px minmax(130px,1.1fr) 76px 150px"
          rows={volumes.map((volume) => [
            <Typography key="n" variant="body2" sx={mono}>
              {volume.name}
            </Typography>,
            <Typography key="e" variant="body2" sx={mono}>
              {volume.server}:{volume.path}
            </Typography>,
            <Typography
              key="c"
              variant="body2"
              sx={{ color: BRAND.text.muted }}
            >
              {volume.capacity}
            </Typography>,
            <Typography
              key="a"
              variant="body2"
              sx={{ ...mono, fontSize: "0.75rem" }}
            >
              {volume.accessModes.join(", ") || "-"}
            </Typography>,
            <Typography
              key="p"
              variant="body2"
              sx={{ color: phaseColour(volume.phase) }}
            >
              {volume.phase}
            </Typography>,
            <Typography
              key="cl"
              variant="body2"
              sx={{
                ...mono,
                color: volume.claim ? BRAND.lime.light : BRAND.text.muted,
              }}
            >
              {volume.claim
                ? `${volume.claim}${volume.claimExists ? "" : " (released)"}`
                : "unbound"}
            </Typography>,
            <Typography
              key="r"
              variant="body2"
              sx={{
                color:
                  volume.reclaimPolicy === "Retain"
                    ? BRAND.text.muted
                    : "#E0A030",
              }}
            >
              {volume.reclaimPolicy}
            </Typography>,
            // Two buttons, deliberately different: Detach only releases the claim
            // (reversible, data untouched); Remove deletes the volume object and
            // demands the name typed out. Neither can delete files on the export.
            <Box key="a" sx={{ display: "flex", gap: 0.5 }}>
              <Button
                size="small"
                onClick={() => setAction({ kind: "detach", volume })}
                disabled={!volume.claimExists}
                title={
                  volume.claimExists
                    ? `Release ${volume.claim}`
                    : volume.claim
                    ? `${volume.claim} no longer exists`
                    : "No claim to release"
                }
              >
                Detach
              </Button>
              <Button
                size="small"
                sx={{ color: "#E0A030" }}
                onClick={() => setAction({ kind: "remove", volume })}
              >
                Remove
              </Button>
            </Box>,
          ])}
        />
      )}

      <Note>
        Capacity is not a quota: NFS does not limit a directory to the number in
        the claim, and neither does local-path. Watch the export on the server.
      </Note>
      <Note>
        A volume in <strong>Released</strong> or <strong>Failed</strong> means
        its claim was deleted and the PV stayed behind because the policy is{" "}
        <code>Retain</code>. Remove it from Storage → Persistent Volumes; the
        files on the export are never deleted by Kubernetes.
      </Note>
      {!classPresent && (
        <Note>
          The first volume created here also creates the StorageClass{" "}
          <code>{CLASS_NAME}</code>. It is deliberately not the cluster default:
          claims that name no class keep binding to node-local storage.
        </Note>
      )}

      <AddNfsDialog
        open={dialogOpen}
        classPresent={classPresent}
        onClose={() => setDialogOpen(false)}
        onCreated={onCreated}
      />

      <VolumeActionDialog
        action={action}
        onClose={() => setAction(null)}
        onSwitchToDetach={() =>
          setAction((current) =>
            current ? { kind: "detach", volume: current.volume } : current
          )
        }
        onDone={(message) => {
          setAction(null);
          setBanner(message);
          reload();
        }}
      />
    </SectionBox>
  );
}

/* ---- registration -------------------------------------------------------- */

// `parent: 'storage'` puts this INSIDE Headlamp's own Storage section, right below
// Volume Attributes Classes - the user asked for NFS in the Storage field, and a
// top-level group would have been a second, competing storage menu.
registerSidebarEntry({
  parent: PARENT,
  name: ENTRY,
  label: "NFS",
  url: PATH,
});

registerRoute({
  path: PATH,
  sidebar: ENTRY,
  name: ENTRY,
  exact: true,
  component: NfsPage,
});
