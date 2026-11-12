/**
 * KubeOS node actions in the TOP BAR: Restart, Power off, Shell.
 *
 * WHY THEY LIVE IN THE APP BAR: they are properties of the NODE, not of a resource -
 * a user wants them from wherever they are, the way Proxmox puts its node controls in
 * the header. `registerAppBarAction` appends to Headlamp's own top bar, right of the
 * settings and user icons.
 *
 * HOW A BROWSER BUTTON CAN POWER OFF A NODE: the page talks to headlamp-server, which only
 * proxies Kubernetes API calls - it exposes no way to run a command on the host, and it
 * must not (it runs as an unprivileged user). So each action creates a ONE-SHOT privileged Pod
 * in kubeos-system that shares the host PID namespace and mounts the host filesystem at
 * /host, then asks the host's OWN systemd to do the work:
 *
 *     nsenter -t 1 -m -u -i -n -p -- /usr/bin/systemctl reboot
 *
 * with `chroot /host /usr/bin/systemctl ...` as the fallback. The image is the
 * join-helper already required by the "Join node" page, which ships nsenter and chroot -
 * no new image, and it works offline.
 *
 * SAFETY, because a stray reboot destroys more than a dashboard session:
 *   * `restartPolicy: Never` on purpose, NOT a Job. A Job whose Pod dies with the node
 *     is a reboot loop: the Job controller re-creates it, it runs again, the node goes
 *     down again, for ever. A bare Pod with `Never` is not restarted after a reboot.
 *   * an idempotency marker in /var/lib/kubeos keyed by Pod name: if the same Pod ever
 *     runs twice, the second run exits without touching systemd.
 *   * BOTH actions are a plain confirmation - no typed node name (user decision 2026-11-12).
 *     The dialog spells out the consequence instead, and Power off stays the red button; a
 *     single-node appliance gains nothing from making the operator retype what the dialog
 *     already says.
 *   * the Pod is pinned to the node it was created for (nodeSelector on the hostname),
 *     so nothing can land on the wrong machine if a second node ever joins.
 *
 * WHY THE SHELL IS AN "ACTIVITY" AND NOT A `?view=exec` LINK (measured 2026-11-11): the
 * obvious one-click shell is a deep link to Headlamp's Pod page,
 *     /c/main/pods/kubeos-system/<pod>?view=exec&container=<c>
 * which auto-launches the terminal from a useEffect in PodDetails. On Headlamp v0.46.0
 * that crashes the page with "Uh-oh! Something went wrong." and React error #185
 * ("Maximum update depth exceeded"): the activity takes over the screen, PodDetails
 * remounts, its "already launched" ref is fresh again, it launches again... for ever.
 * The same terminal opened from the Pod page's own "Terminal / Exec" button works, which
 * is what isolates the bug to the auto-launch effect. So this file does what that button
 * does: `Activity.launch()` with Headlamp's exported `Terminal`. Deep links must stay
 * out of KubeOS until upstream fixes the effect.
 *
 * WHAT THE SHELL IS, EXACTLY (stated in the UI too): an exec into a privileged container
 * that mounts the host at /host - so you start in the container, and
 *     nsenter -t 1 -m -u -i -n -p -- /bin/bash
 * gives you the host. Headlamp's own node shell does the same thing, and being honest
 * about it beats a button that pretends to be something it is not.
 *
 * AND IT DOES NOT LIVE FOR EVER: a privileged container with host root mounted is not
 * something to leave parked in the cluster. The Pod is created on the click, deleted when
 * the terminal reports it closed, and in any case expires after an hour
 * (activeDeadlineSeconds) - measured: closing the activity with its own ✕ does NOT call
 * the terminal's onClose, so the deadline is the part that actually guarantees cleanup.
 */
import {
  Activity,
  ApiProxy,
  CommonComponents,
  K8s,
  registerAppBarAction,
} from "@kinvolk/headlamp-plugin/lib";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import React from "react";
import { BRAND } from "./brand";

const NAMESPACE = "kubeos-system";
/**
 * The join-helper image is already on every KubeOS node (the Join node page needs it)
 * and ships both `nsenter` and `chroot`. Reusing it keeps the offline promise: no image
 * to pull for a button that must work when the network does not.
 */
const HELPER_IMAGE = "ghcr.io/skmdab/kubeos-join-helper:0.1.0";
const SHELL_POD = "kubeos-node-shell";
const SHELL_CONTAINER = "shell";
const SHELL_ACTIVITY_ID = "kubeos-node-shell";
const MANAGED_BY = { "app.kubernetes.io/managed-by": "kubeos-dashboard" };

// Headlamp exports the Pod class and its own terminal; using them keeps this feature a
// thin wrapper instead of a second xterm implementation.
const PodClass = K8s.ResourceClasses.Pod;
const Terminal = CommonComponents.Terminal;

type PowerAction = "restart" | "poweroff";

async function apiJson<T>(path: string): Promise<T> {
  const response: any = await ApiProxy.request(path);
  return (response?.json ?? response) as T;
}

/** The node this dashboard manages. Single-node appliance: there is exactly one. */
async function readNodeName(): Promise<string> {
  const list = await apiJson<{ items: any[] }>("/api/v1/nodes");
  return list?.items?.[0]?.metadata?.name ?? "";
}

/** Actions whose one-shot Pods are finished with, whatever terminal phase they reached. */
const ACTION_LABELS = ["restart", "poweroff"];

/**
 * Delete the one-shot action Pods left behind by earlier clicks.
 *
 * A power off kills the node before anything can remove its own Pod, so the API server is
 * left holding the object and later marks it Unknown/Failed - for ever, unless somebody
 * deletes it (measured 2026-11-12: three of them, one 12 hours old). Nothing in the cluster
 * owns them, so the dashboard sweeps them itself whenever it loads, which is exactly the
 * moment after the node comes back. Restart leaves the same debris for the same reason.
 */
async function sweepStaleActionPods(): Promise<number> {
  const list = await apiJson<{ items: any[] }>(
    `/api/v1/namespaces/${NAMESPACE}/pods`
  );
  const stale = (list?.items ?? []).filter((pod) => {
    const action = pod?.metadata?.labels?.["kubeos.in/action"];
    const phase = pod?.status?.phase;
    return (
      ACTION_LABELS.includes(action) &&
      (phase === "Succeeded" || phase === "Failed" || phase === "Unknown")
    );
  });
  let removed = 0;
  for (const pod of stale) {
    const name = pod?.metadata?.name;
    if (!name) {
      continue;
    }
    try {
      await ApiProxy.remove(`/api/v1/namespaces/${NAMESPACE}/pods/${name}`);
      removed += 1;
    } catch {
      // Not fatal: an unreachable node, a permission problem or a race with another tab
      // simply means the next load tries again.
    }
  }
  if (removed > 0) {
    console.log(`kubeos: removed ${removed} finished node-action pod(s)`);
  }
  return removed;
}

/** Cluster name from the URL, which is how every Headlamp route is scoped. */
function currentCluster(): string {
  const match = window.location.pathname.match(/^\/c\/([^/]+)/);
  return match?.[1] ?? "main";
}

/**
 * The script the one-shot Pod runs. `set -eu` so a failed nsenter cannot look like
 * success, and the marker is written BEFORE the shutdown request: if systemd takes the
 * machine down mid-command the container is killed, but the Pod can never run the same
 * shutdown twice.
 */
function actionScript(action: PowerAction): string {
  // The UI calls it "Restart" and the systemd verb is "reboot": `systemctl restart` is a
  // UNIT verb and, given no unit, answers only "Too few arguments." - which is exactly what
  // the first real test printed while the node happily stayed up (2026-11-11).
  const verb = action === "restart" ? "reboot" : "poweroff";
  return [
    "set -eu",
    `MARK="/host/var/lib/kubeos/.kubeos-${verb}-$POD_NAME"`,
    'if [ -e "$MARK" ]; then echo "already requested: $MARK"; exit 0; fi',
    "mkdir -p /host/var/lib/kubeos",
    ': > "$MARK"',
    `echo "requesting ${verb} through the host systemd"`,
    // nsenter first: it enters PID 1's mount namespace, so the binary is the HOST's
    // systemctl and it talks to the HOST's systemd. chroot is the fallback for an
    // image without nsenter.
    `nsenter -t 1 -m -u -i -n -p -- /usr/bin/systemctl ${verb} || chroot /host /usr/bin/systemctl ${verb}`,
  ].join("\n");
}

function actionPod(action: PowerAction, node: string) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      // Unique per click: a fixed name would collide with the Pod left over from a
      // previous reboot, and `create` would fail to report anything useful.
      name: `kubeos-node-${action}-${Date.now()}`,
      namespace: NAMESPACE,
      labels: { ...MANAGED_BY, "kubeos.in/action": action },
    },
    spec: {
      // Never, not a Job - see the header: a Job would reboot the node again on every
      // boot. A Pod with `Never` is not restarted once the container has exited.
      restartPolicy: "Never",
      hostPID: true,
      // This Pod never talks to the API: it runs one nsenter. Without a service-account
      // token the kubelet skips the projected `kube-api-access-*` volume entirely, which
      // removes a whole class of start-up failure - measured 2026-11-12: after a reboot the
      // kubelet retried these Pods and logged `MountVolume.SetUp failed ... object
      // "kubeos-system"/"kube-root-ca.crt" not registered`, i.e. the Pod's start depended on
      // a ConfigMap it does not need. POD_NAME still arrives through the downward API.
      automountServiceAccountToken: false,
      nodeSelector: { "kubernetes.io/hostname": node },
      tolerations: [{ operator: "Exists" }],
      containers: [
        {
          name: "action",
          image: HELPER_IMAGE,
          imagePullPolicy: "IfNotPresent",
          securityContext: { privileged: true },
          env: [
            {
              name: "POD_NAME",
              valueFrom: { fieldRef: { fieldPath: "metadata.name" } },
            },
          ],
          volumeMounts: [{ name: "host", mountPath: "/host" }],
          command: ["/bin/sh", "-c", actionScript(action)],
        },
      ],
      volumes: [{ name: "host", hostPath: { path: "/" } }],
    },
  };
}

function shellPod(node: string) {
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: SHELL_POD,
      namespace: NAMESPACE,
      labels: { ...MANAGED_BY, "kubeos.in/action": "shell" },
    },
    spec: {
      restartPolicy: "Always",
      hostPID: true,
      // Backstop: this container is privileged and has the host's root filesystem
      // mounted, so it must never sit in the cluster unattended. Closing the terminal
      // deletes it (closeShellActivity), but an activity closed with its own ✕ does not
      // call the terminal's onClose, so an hour is the hard limit.
      activeDeadlineSeconds: 3600,
      nodeSelector: { "kubernetes.io/hostname": node },
      tolerations: [{ operator: "Exists" }],
      containers: [
        {
          name: SHELL_CONTAINER,
          image: HELPER_IMAGE,
          imagePullPolicy: "IfNotPresent",
          securityContext: { privileged: true },
          // Nothing to do but stay alive: the terminal attaches with `kubectl exec`,
          // which starts its own process inside this container.
          command: ["/bin/sh", "-c", "while :; do sleep 300; done"],
          volumeMounts: [{ name: "host", mountPath: "/host" }],
        },
      ],
      volumes: [{ name: "host", hostPath: { path: "/" } }],
    },
  };
}

/**
 * Create the shell Pod if it is not there, then wait for it to be Running.
 *
 * A Pod that is Terminating, Failed or Succeeded has to be removed and recreated: its
 * container is gone, so it can never become a shell, and simply waiting would fail after
 * 40 s with a confusing message.
 */
async function ensureShellPod(node: string): Promise<void> {
  const path = `/api/v1/namespaces/${NAMESPACE}/pods/${SHELL_POD}`;
  let existing: any = null;
  try {
    existing = await apiJson(path);
  } catch {
    existing = null;
  }
  const phase = existing?.status?.phase;
  const unusable =
    !existing ||
    existing?.metadata?.deletionTimestamp ||
    phase === "Succeeded" ||
    phase === "Failed";

  if (unusable) {
    if (existing) {
      // Wait for the old Pod to be gone, otherwise `create` answers 409.
      await ApiProxy.remove(path).catch(() => {});
      for (let attempt = 0; attempt < 30; attempt++) {
        const still: any = await apiJson(path).catch(() => null);
        if (!still) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    try {
      await ApiProxy.post(
        `/api/v1/namespaces/${NAMESPACE}/pods`,
        shellPod(node)
      );
    } catch (reason: any) {
      // 409 is not a failure here: two quick clicks race, and the Pod the other click
      // created is the Pod we want anyway.
      if (!/409|already exists/i.test(String(reason?.message ?? reason))) {
        throw reason;
      }
    }
  }

  for (let attempt = 0; attempt < 40; attempt++) {
    const pod: any = await apiJson(path);
    const data = pod?.json ?? pod;
    const status = data?.status?.phase;
    if (status === "Running") {
      return;
    }
    if (status === "Failed") {
      throw new Error(
        `the shell Pod failed: ${data?.status?.message ?? "see the Pod events"}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("the shell Pod did not reach Running within 40 s");
}

/**
 * Closing the terminal must ALSO remove the Pod: it is privileged and mounts the host's
 * root filesystem, so leaving it behind would keep a root shell on the node alive for
 * nobody. The next click recreates it in about a second (the image is already on the
 * node), which is a fair price for not parking host root in the cluster.
 */
function closeShellActivity() {
  Activity.close(SHELL_ACTIVITY_ID);
  ApiProxy.remove(`/api/v1/namespaces/${NAMESPACE}/pods/${SHELL_POD}`).catch(
    () => {
      // Already gone: closing the terminal twice is not an error.
    }
  );
}

/**
 * What the terminal activity renders. It re-reads the Pod through Headlamp's own object
 * store, so a Pod that was deleted while the terminal was open reports why instead of
 * showing a dead terminal.
 */
function NodeShellContent({ onClose }: { onClose: () => void }) {
  const [pod, error]: [any, any] = (PodClass as any).useGet(
    SHELL_POD,
    NAMESPACE
  );

  if (error) {
    return (
      <Box sx={{ p: 3 }}>
        <Typography
          variant="body2"
          sx={{ color: "#E05050", wordBreak: "break-word" }}
        >
          The node shell Pod could not be read:{" "}
          {String(error?.message ?? error)}
        </Typography>
      </Box>
    );
  }
  if (!pod) {
    return <CommonComponents.Loader title="Opening a shell on the node…" />;
  }
  // The one line a user needs and would otherwise have to guess: the terminal opens in
  // the container, the node's own filesystem is at /host, and this is how to get a real
  // host shell (same ritual Headlamp's own node shell expects).
  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <Box
        sx={{
          px: 2,
          py: 1,
          backgroundColor: BRAND.bg.panel,
          borderBottom: `1px solid ${BRAND.bg.muted}`,
        }}
      >
        <Typography variant="caption" sx={{ color: BRAND.text.body }}>
          A privileged container on this node; the host filesystem is at{" "}
          <code>/host</code>. For the node&apos;s own shell run{" "}
          <Box component="code" sx={{ color: BRAND.lime.primary }}>
            nsenter -t 1 -m -u -i -n -p -- /bin/bash
          </Box>
        </Typography>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0 }}>
        <Terminal noDialog open item={pod} onClose={onClose} />
      </Box>
    </Box>
  );
}

/* ---- the confirmation dialog -------------------------------------------- */

function NodeActionDialog({
  action,
  node,
  onClose,
  onDone,
}: {
  action: PowerAction | null;
  node: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    setBusy(false);
    setError(null);
  }, [action]);

  if (!action) {
    return null;
  }
  const isPowerOff = action === "poweroff";
  // One click plus one explicit confirmation (user decision 2026-11-12): the consequences are
  // spelled out in the body, so typing the node name was friction, not safety.
  const canSubmit = !busy;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await ApiProxy.post(
        `/api/v1/namespaces/${NAMESPACE}/pods`,
        actionPod(action, node)
      );
      onDone(
        isPowerOff
          ? `Power off requested for ${node}. The dashboard and every workload stop until it is powered on again.`
          : `Restart requested for ${node}. The dashboard drops for a few seconds and comes back on its own.`
      );
    } catch (reason: any) {
      setError(String(reason?.message ?? reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>
        {isPowerOff ? "Power off" : "Restart"} {node || "this node"}?
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          {isPowerOff
            ? "The node shuts down and stays off. Every workload stops, and the dashboard is unreachable until someone powers the machine on — there is no remote way back."
            : "The node reboots: the control plane, the dashboard and every workload stop and come back on their own. Expect the dashboard to drop for a few seconds."}
        </Typography>
        <Typography
          variant="caption"
          sx={{ display: "block", color: BRAND.text.muted, mb: 2 }}
        >
          The request goes to the node&apos;s own systemd through a short-lived
          privileged Pod, because a browser cannot reach the host any other way. The Pod is
          never restarted (so this cannot loop) and it is removed automatically the next time
          the dashboard loads.
        </Typography>
        {error && (
          <Typography
            variant="body2"
            sx={{ mt: 2, color: "#E05050", wordBreak: "break-word" }}
          >
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={submit}
          disabled={!canSubmit}
          sx={isPowerOff ? { backgroundColor: "#C05050" } : undefined}
        >
          {busy ? "Requesting…" : isPowerOff ? "Power off" : "Restart"}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/* ---- the top-bar buttons ------------------------------------------------- */

const button = {
  size: "small",
  variant: "outlined",
  sx: {
    minWidth: 0,
    px: 1.25,
    py: 0.25,
    fontSize: "0.75rem",
    lineHeight: 1.6,
    borderColor: BRAND.bg.muted,
    color: BRAND.text.body,
    whiteSpace: "nowrap",
  },
} as const;

function NodeActions() {
  const [node, setNode] = React.useState("");
  const [action, setAction] = React.useState<PowerAction | null>(null);
  const [shell, setShell] = React.useState<"idle" | "busy" | "error">("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  React.useEffect(() => {
    readNodeName()
      .then(setNode)
      .catch(() => setNode(""));
    // Housekeeping, not part of the button: clear the finished action Pods of earlier
    // clicks (see sweepStaleActionPods).
    sweepStaleActionPods().catch(() => {});
  }, []);

  const openShell = async () => {
    setShell("busy");
    setMessage(null);
    try {
      const name = node || (await readNodeName());
      await ensureShellPod(name);
      Activity.launch({
        // A fixed id means a second click re-opens the same activity instead of stacking
        // identical terminals.
        id: SHELL_ACTIVITY_ID,
        title: `Node shell: ${name}`,
        cluster: currentCluster(),
        location: "full",
        content: <NodeShellContent onClose={closeShellActivity} />,
      });
      setShell("idle");
    } catch (reason: any) {
      setShell("error");
      setMessage(
        `could not open a shell: ${String(reason?.message ?? reason)}`
      );
    }
  };

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mr: 1 }}>
      {message && (
        <Typography
          variant="caption"
          sx={{ color: "#E0A030", mr: 1, maxWidth: 260 }}
        >
          {message}
        </Typography>
      )}
      <Button
        {...button}
        onClick={() => setAction("restart")}
        title={`Restart ${node || "the node"}`}
      >
        Restart
      </Button>
      <Button
        {...button}
        onClick={() => setAction("poweroff")}
        title={`Power off ${node || "the node"}`}
        sx={{ ...button.sx, color: "#E0A030" }}
      >
        Power off
      </Button>
      <Button
        {...button}
        onClick={openShell}
        disabled={shell === "busy"}
        title="Shell on the node"
      >
        {shell === "busy" ? "Opening…" : "Shell"}
      </Button>

      <NodeActionDialog
        action={action}
        node={node}
        onClose={() => setAction(null)}
        onDone={(text) => {
          setAction(null);
          setMessage(text);
        }}
      />
    </Box>
  );
}

registerAppBarAction(NodeActions);
