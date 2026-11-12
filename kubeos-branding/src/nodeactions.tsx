/**
 * KubeOS node actions in the TOP BAR: Restart, Power off, Shell.
 *
 * WHY THEY LIVE IN THE APP BAR: they are properties of the NODE, not of a resource -
 * a user wants them from wherever they are, the way Proxmox puts its node controls in
 * the header. `registerAppBarAction` appends to Headlamp's own top bar, right of the
 * settings and user icons.
 *
 * HOW A BROWSER BUTTON REACHES THE HOST, NOW: it does not go through the cluster at all. The
 * node runs `kubeos-console.service` (deploy/binary/console.py) as root, listening on its own
 * TLS port, and every button is a request to it - `POST /action/restart`,
 * `POST /action/poweroff`, and a WebSocket for the shell. Until 2026-11-12 each action created
 * a one-shot privileged Pod in kubeos-system that nsentered into PID 1 to run systemctl; the
 * user's rule from that day is that **no button may create a Pod, now or later**, and this
 * file no longer can: it holds no Pod spec at all.
 *
 * THE CONSEQUENCES THAT REMAIN TRUE, and why the design is still careful:
 *   * Restart and Power off are a plain confirmation - no typed node name (user decision
 *     2026-11-12). The dialog spells out the consequence instead, and Power off stays the
 *     red button; a single-node appliance gains nothing from making the operator retype what
 *     the dialog already says.
 *   * The console refuses a second action while one is in flight (`409 already running`), so
 *     a double click cannot queue two shutdowns.
 *   * The answer must reach the browser BEFORE the machine goes down; console.py replies 202
 *     first and only then runs systemctl, in a detached session.
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
 * WHAT THE SHELL IS, EXACTLY: the node's own login shell, with no Pod, no exec and no
 * container in the path (user decision 2026-11-12: *"i need shell without pod creation"*).
 * The node runs `kubeos-console.service`, a small PTY-over-WebSocket service; this file opens
 * a WebSocket to it and paints an xterm. The earlier design - a privileged Pod plus an
 * exec plus a `/bin/bash` wrapper that nsentered into PID 1 - is gone, along with the
 * "Opening a shell…" delay and the container dropdown Headlamp drew over the terminal.
 *
 * AND NOTHING IS LEFT BEHIND: closing the terminal closes the WebSocket, and the console
 * hangs up the shell with it. The only cleanup left in this file is the sweep that removes a
 * `kubeos-node-shell` Pod if an older dashboard created one.
 */
import {
  Activity,
  ApiProxy,
  registerAppBarAction,
} from "@kinvolk/headlamp-plugin/lib";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import React from "react";
import { BRAND } from "./brand";
import { certificateHint, consoleConfig } from "./consoleapi";

const NAMESPACE = "kubeos-system";
/**
 * The Pod name the shell USED to create. Nothing creates it any more (the shell is a node
 * service now, see the console section below), but a dashboard deployed before 2026-11-12
 * can leave one behind - a privileged container with the host's root filesystem mounted,
 * waiting for its one-hour deadline. The sweep on page load deletes it.
 */
const SHELL_POD = "kubeos-node-shell";
const SHELL_ACTIVITY_ID = "kubeos-node-shell";
/** Where the node's host console listens (installed by deploy/binary/install.sh). */
const CONSOLE_PORT = 30444;
/** The Secret install.sh publishes the console token into. */
const CONSOLE_SECRET = "kubeos-console-token";


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

/**
 * Actions whose one-shot Pods are finished with. Nothing creates these any more (2026-11-12:
 * the buttons POST to the node console), so this exists only to clear the debris of an older
 * dashboard that is still deployed on a node.
 */
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

/**
 * The shell's half of the same housekeeping.
 *
 * Closing the terminal deletes the Pod, but closing the ACTIVITY with its own ✕ never
 * calls the terminal's onClose (measured 2026-11-11), so a privileged container with the
 * host's root filesystem mounted can sit in the cluster until `activeDeadlineSeconds` (one
 * hour) runs out - seen again on 2026-11-12 after a browser test was simply closed. A Pod
 * that exists while no terminal is open cannot belong to a live session, so it is debris
 * and loading the dashboard removes it.
 */
async function sweepLeftoverShellPod(): Promise<void> {
  const path = `/api/v1/namespaces/${NAMESPACE}/pods/${SHELL_POD}`;
  const existing: any = await apiJson(path).catch(() => null);
  if (!existing) {
    return;
  }
  await ApiProxy.remove(path);
  console.log("kubeos: removed a leftover node shell pod");
}

/**
 * Run the housekeeping exactly once per page load, and let the Shell button wait for it:
 * otherwise a click in the same second as the page load could delete the Pod the click
 * just created.
 */
let housekeeping: Promise<unknown> | null = null;
function runHousekeeping(): Promise<unknown> {
  if (!housekeeping) {
    housekeeping = Promise.all([
      sweepStaleActionPods().catch(() => 0),
      sweepLeftoverShellPod().catch(() => undefined),
    ]);
  }
  return housekeeping;
}

/** Cluster name from the URL, which is how every Headlamp route is scoped. */
function currentCluster(): string {
  const match = window.location.pathname.match(/^\/c\/([^/]+)/);
  return match?.[1] ?? "main";
}

/**
 * Restart / Power off, WITHOUT A POD.
 *
 * These buttons used to create a one-shot privileged Pod that nsentered into PID 1 and ran
 * `systemctl reboot` / `systemctl poweroff`. It worked, but every click left an object in
 * the cluster - and a power off killed the node before anything could delete it, which is
 * how three `kubeos-node-poweroff-*` Pods once sat in `kubeos-system` for 12 hours. The user
 * drew the line on 2026-11-12: *"they too should not create pod.. and for future too"*.
 *
 * So the action is a POST to the node's console service (see console.py), which already runs
 * as root on the host: `POST /action/restart` is the entire implementation. Nothing is
 * created, so nothing can be left behind, and the service answers 202 before systemd takes
 * the machine down.
 */
async function requestNodeAction(
  action: PowerAction,
  token: string,
  port: number
): Promise<void> {
  const target = `https://${window.location.hostname}:${port}/action/${action}`;
  let response: Response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
  } catch (reason: any) {
    throw new Error(
      `could not reach the node console on port ${port}. ${certificateHint(port)} (${String(
        reason?.message ?? reason
      )})`
    );
  }
  if (response.status === 202) {
    return;
  }
  let detail = "";
  try {
    detail = String((await response.json())?.error ?? "");
  } catch {
    detail = response.statusText;
  }
  throw new Error(`${response.status} ${detail || response.statusText}`.trim());
}

/**
 * Closing the terminal stops the session; the console kills the shell when the socket goes
 * away, so there is nothing to clean up in the cluster.
 */
function closeShellActivity() {
  Activity.close(SHELL_ACTIVITY_ID);
}

/** xterm over the console's WebSocket. Everything visible here is the node's own shell. */
function NodeConsole({
  token,
  port,
  onClose,
}: {
  token: string;
  port: number;
  onClose: () => void;
}) {
  const host = React.useRef<HTMLDivElement | null>(null);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [hint, setHint] = React.useState<string | null>(null);
  const hostname = window.location.hostname;

  React.useEffect(() => {
    let socket: WebSocket | null = null;
    let term: Terminal | null = null;
    let fit: FitAddon | null = null;
    let onWindowResize: (() => void) | null = null;
    let disposed = false;

    const stop = (text: string, extra?: string) => {
      if (disposed) {
        return;
      }
      setProblem(text);
      if (extra) {
        setHint(extra);
      }
      try {
        socket?.close();
      } catch {
        // already closed
      }
      term?.dispose();
      term = null;
    };

    if (!host.current) {
      return undefined;
    }
    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      theme: { background: "#0b0b0b", foreground: "#cfd8cf", cursor: "#c8f04a" },
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    fit.fit();

    const url = `wss://${hostname}:${port}/ws?token=${encodeURIComponent(token)}`;
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    const sendSize = () => {
      if (socket?.readyState === WebSocket.OPEN && term) {
        socket.send(
          JSON.stringify({ t: "r", cols: term.cols, rows: term.rows })
        );
      }
    };

    socket.onopen = () => {
      sendSize();
      fit?.fit();
      sendSize();
      term?.focus();
      term?.onData((data: string) => {
        if (socket?.readyState === WebSocket.OPEN) {
          // Binary frames are stdin: the console writes them straight to the PTY.
          socket.send(new TextEncoder().encode(data));
        }
      });
      onWindowResize = () => {
        fit?.fit();
        sendSize();
      };
      window.addEventListener("resize", onWindowResize);
    };
    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data === "string") {
        term?.write(event.data);
      } else {
        term?.write(new Uint8Array(event.data as ArrayBuffer));
      }
    };
    socket.onerror = () => {
      stop(
        `could not reach the host console on port ${port}`,
        `If this browser has never opened https://${hostname}:${port}/ , do that once, accept the certificate warning, then press Shell again.`
      );
    };
    socket.onclose = () => {
      if (!disposed) {
        stop("the host console closed this session");
      }
    };

    return () => {
      disposed = true;
      if (onWindowResize) {
        window.removeEventListener("resize", onWindowResize);
      }
      try {
        socket?.close();
      } catch {
        // already closed
      }
      term?.dispose();
      term = null;
    };
    // token/port come from the Secret and never change for an open activity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box
      className="kubeos-node-shell"
      sx={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      {problem ? (
        <Box sx={{ p: 3 }}>
          <Typography
            variant="body2"
            sx={{ color: "#E0A030", wordBreak: "break-word" }}
          >
            {problem}
          </Typography>
          {hint && (
            <Typography
              variant="caption"
              sx={{ display: "block", mt: 1, color: BRAND.text.muted }}
            >
              {hint}
            </Typography>
          )}
          <Button
            variant="outlined"
            size="small"
            sx={{ mt: 2, color: BRAND.text.body, borderColor: BRAND.bg.muted }}
            onClick={onClose}
          >
            Close
          </Button>
        </Box>
      ) : (
        <Box sx={{ flex: 1, minHeight: 0, pl: 1, pt: 1 }} ref={host} />
      )}
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
      const { token, port } = await consoleConfig();
      await requestNodeAction(action, token, port);
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
          The request goes straight to the node&apos;s own systemd through the KubeOS console
          service on this node. Nothing is created in the cluster for it, so nothing can be
          left behind.
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
    // clicks and any node-shell Pod orphaned by a session that was closed with its ✕
    // (see sweepStaleActionPods and sweepLeftoverShellPod).
    runHousekeeping();
  }, []);

  const openShell = async () => {
    setShell("busy");
    setMessage(null);
    try {
      const name = node || (await readNodeName());
      // Housekeeping first: it also removes a shell Pod left by a dashboard deployed
      // before 2026-11-12, which would otherwise sit there holding host root.
      await runHousekeeping();
      const { token, port } = await consoleConfig();
      Activity.launch({
        // A fixed id means a second click re-opens the same activity instead of stacking
        // identical terminals.
        id: SHELL_ACTIVITY_ID,
        title: `Node shell: ${name}`,
        cluster: currentCluster(),
        location: "full",
        content: (
          <NodeConsole
            token={token}
            port={port}
            onClose={closeShellActivity}
          />
        ),
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
