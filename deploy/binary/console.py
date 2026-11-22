#!/usr/bin/python3
"""KubeOS host console: a login shell on the node, over TLS WebSocket.

WHY THIS EXISTS: the dashboard's Shell button used to open a shell by creating a
privileged Pod and `kubectl exec`-ing into it, because Kubernetes has no "run on the host"
call and the browser can only reach headlamp-server (a Kubernetes API proxy). The user
rejected the Pod (2026-11-12: *"yes i need shell without pod creation"*), so the node now
runs its own tiny terminal service instead: one process, one PTY, no Pod, nothing for the
API server to schedule.

WHY STDlib ONLY: a KubeOS node must give this without network access and without a build
step - python3 is already on the image, and every vendored daemon (ttyd, gotty) would be
another binary to ship and trust. The WebSocket framing needed for xterm is a small part of
RFC 6455 and is implemented below.

IT ALSO RUNS THE NODE ACTIONS (restart / power off): the dashboard's buttons used to create a
one-shot privileged Pod for `systemctl reboot`; user decision 2026-11-12 is that the buttons
must not create Pods either (*"they too should not create pod.. and for future too"*). Since
this service already runs as root on the host, `POST /action/<verb>` is the whole
implementation - no object, nothing to schedule, nothing to leak.

IT ALSO JOINS THIS NODE TO A CLUSTER (the dashboard's "Join node" page): `POST /action/join`
hands the join string to `kubeos-node-join`, which disables this machine's control-plane
units, discards its one-node cluster and runs `kubeadm join` - as a **transient systemd
unit**, not a Pod (user rule 2026-11-12: no button may create a Pod). Running it under
systemd is also what keeps it alive while the local API server it was talking to is being
deleted.

IT ALSO BROWSES AND FILLS NFS EXPORTS (the NFS page in the dashboard): a static NFS
PersistentVolume is just a server and a path - nothing can list it without a mount, and
the dashboard may not create a Pod to hold the mount. So `GET /nfs` mounts the export on
the node (under /run/kubeos-nfs/<hash>, one mount per server:path, reused) and lists a
directory, and `POST /nfs` writes an uploaded file into it. The mount lives on the node,
so the contents listed are exactly what a Pod claiming that volume sees.

WHAT IT DOES NOT DO: it does not authenticate a *user* - there are no users on this model.
It requires a per-machine token (see --token-file) so a port scanner or a random web page
cannot open a root shell, and it refuses a cross-origin handshake. Anyone who can read the
token can have root, which is exactly as strong as the dashboard itself: its kubeconfig is
cluster-admin and it has no login either.

SAFE: the token is compared in constant time, the handshake is size-limited, a shell is
fenced by its own process group, and the service is restarted by systemd if it dies.
"""
# KubeOS deploy marker: 2026-11-20T22:05Z - a redeploy of the release carries this line, so
# "apt upgrade kubeos-dashboard" can be proven by CONTENT and not only by a timestamp.
from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import hmac
import json
import os
import pty
import re
import select
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import tarfile
import tempfile
import termios
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


def log(message: str) -> None:
    print(f"kubeos-console: {message}", flush=True)


class QuietServer(ThreadingHTTPServer):
    """A threading server that does not print a traceback when a client simply goes away.

    WHY: `BaseServer.handle_error` prints a full traceback for every exception that escapes a
    request, and a client hanging up mid-response is not an error - it is a closed terminal, a
    page that was reloaded while it was still loading, or a probe that gave up. Measured
    2026-11-20 on the busiest node: 12 such tracebacks, every one raised inside
    `socketserver.write`. Anything that is NOT a disconnect keeps the traceback it deserves.
    """

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError,
                            TimeoutError)):
            log(f"{client_address[0]} went away mid-response ({type(exc).__name__})")
            return
        super().handle_error(request, client_address)


def read_token(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        token = handle.read().strip()
    if len(token) < 16:
        raise SystemExit(f"the token in {path} is too short to be a secret")
    return token


def describe_chart(path: str) -> tuple:
    """(name, version, problem) for a chart archive, read WITHOUT trusting its contents.

    WHY THIS EXISTS: the Install page takes a .tgz from a browser, and `helm install <file>` would
    happily be pointed at anything. This answers "is this really a chart, and which one" before the
    file is offered to helm, and before its name is shown to a person. It reads only the first
    Chart.yaml it finds at the top two levels, and never extracts anything to disk.
    """
    try:
        with open(path, "rb") as handle:
            if handle.read(2) != b"\x1f\x8b":
                return "", "", "that file is not gzip-compressed (a chart is a .tgz)"
        with tarfile.open(path, "r:gz") as archive:
            member = None
            for candidate in archive.getmembers():
                if (candidate.isfile() and candidate.name.endswith("Chart.yaml")
                        and candidate.name.count("/") <= 1):
                    member = candidate
                    break
            if member is None:
                return "", "", "that archive has no Chart.yaml, so it is not a Helm chart"
            if member.size > 64 * 1024:
                return "", "", "that Chart.yaml is implausibly large for a chart"
            extracted = archive.extractfile(member)
            if extracted is None:
                return "", "", "that archive's Chart.yaml cannot be read"
            text = extracted.read().decode("utf-8", "replace")
    except (OSError, tarfile.TarError) as reason:
        return "", "", "that archive cannot be read as a chart: %s" % reason
    name = re.search(r"^name:\s*[\"']?([A-Za-z0-9._-]+)", text, re.MULTILINE)
    version = re.search(r"^version:\s*[\"']?([A-Za-z0-9._+-]+)", text, re.MULTILINE)
    if name is None or version is None:
        return "", "", "that Chart.yaml has no name or no version, so helm would refuse it"
    return name.group(1), version.group(1), ""


# ---- WebSocket framing ----------------------------------------------------


def send_frame(sock: socket.socket, opcode: int, payload: bytes = b"") -> None:
    head = bytes([0x80 | opcode])
    length = len(payload)
    if length < 126:
        head += bytes([length])
    elif length < 1 << 16:
        head += bytes([126]) + struct.pack("!H", length)
    else:
        head += bytes([127]) + struct.pack("!Q", length)
    # Server frames are never masked (RFC 6455 5.1).
    sock.sendall(head + payload)


# ---- one terminal ---------------------------------------------------------


class Session:
    """A PTY running a login shell, glued to one WebSocket.

    ONE THREAD ON PURPOSE: an SSLSocket is not safe for a concurrent read and write, and
    the first version proved it - a writer thread silently lost the shell's output while
    the reader blocked in recv (the command still ran, its output never arrived). So a
    single select() loop drives both the socket and the PTY, and frames are parsed from a
    buffer because a recv can return half a frame.
    """

    def __init__(self, sock: socket.socket, shell: str) -> None:
        self.sock = sock
        self.shell = shell
        self.buffer = bytearray()
        self.pid = -1
        self.fd = -1

    def spawn(self, env_extra: dict[str, str]) -> None:
        pid, fd = pty.fork()
        if pid == 0:  # child
            try:
                env = {
                    "TERM": "xterm-256color",
                    "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    "LANG": "C.UTF-8",
                    "SHELL": self.shell,
                    "HOME": "/root",
                }
                env.update(env_extra)
                os.execvpe(self.shell, [self.shell, "-l"], env)
            finally:
                os._exit(127)
        self.pid, self.fd = pid, fd

    def resize(self, cols: int, rows: int) -> None:
        if self.fd < 0:
            return
        cols, rows = max(2, min(cols, 1000)), max(2, min(rows, 1000))
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        try:
            os.kill(self.pid, signal.SIGWINCH)
        except ProcessLookupError:
            pass

    def send(self, opcode: int, payload: bytes = b"") -> bool:
        try:
            send_frame(self.sock, opcode, payload)
            return True
        except OSError:
            return False

    def take_frames(self) -> list[tuple[int, bytes]]:
        """Every complete frame in the buffer; partial frames stay buffered."""
        frames = []
        while True:
            if len(self.buffer) < 2:
                return frames
            opcode = self.buffer[0] & 0x0F
            length = self.buffer[1] & 0x7F
            offset = 2
            if length == 126:
                if len(self.buffer) < 4:
                    return frames
                length = struct.unpack("!H", bytes(self.buffer[2:4]))[0]
                offset = 4
            elif length == 127:
                if len(self.buffer) < 10:
                    return frames
                length = struct.unpack("!Q", bytes(self.buffer[2:10]))[0]
                offset = 10
            mask = b""
            if self.buffer[1] & 0x80:
                if len(self.buffer) < offset + 4:
                    return frames
                mask = bytes(self.buffer[offset : offset + 4])
                offset += 4
            if len(self.buffer) < offset + length:
                return frames
            payload = bytes(self.buffer[offset : offset + length])
            del self.buffer[: offset + length]
            if mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            frames.append((opcode, payload))

    def handle(self, opcode: int, payload: bytes) -> bool:
        """One frame from the browser. Returns False when the session should end."""
        if opcode == OP_CLOSE:
            return False
        if opcode == OP_PING:
            return self.send(OP_PONG, payload)
        if opcode == OP_PONG:
            return True
        if opcode == OP_TEXT:
            try:
                message = json.loads(payload.decode("utf-8", "replace"))
            except ValueError:
                return True
            if message.get("t") == "r":
                self.resize(int(message.get("cols", 80)), int(message.get("rows", 24)))
            return True
        if opcode in (OP_BIN, OP_CONT) and payload:
            try:
                os.write(self.fd, payload)
            except OSError:
                return False
        return True

    def run(self, env_extra: dict[str, str]) -> None:
        self.spawn(env_extra)
        try:
            while True:
                readable, _, _ = select.select([self.sock, self.fd], [], [], 1.0)
                if self.fd in readable:
                    try:
                        data = os.read(self.fd, 65536)
                    except OSError:
                        break  # EIO: the shell is gone
                    if not data:
                        break
                    if not self.send(OP_BIN, data):
                        break
                if self.sock in readable:
                    chunk = self.sock.recv(65536)
                    if not chunk:
                        break
                    self.buffer += chunk
                    for opcode, payload in self.take_frames():
                        if not self.handle(opcode, payload):
                            return
        except (ConnectionError, OSError):
            pass
        finally:
            self.kill()
            self.send(OP_CLOSE, struct.pack("!H", 1000))
            try:
                self.sock.close()
            except OSError:
                pass

    def kill(self) -> None:
        if self.fd >= 0:
            try:
                os.close(self.fd)
            except OSError:
                pass
            self.fd = -1
        if self.pid > 0:
            try:
                os.kill(self.pid, signal.SIGHUP)
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self.pid = -1


# ---- NFS exports ---------------------------------------------------------
# WHY A MOUNT AND NOT AN API: an NFS PersistentVolume carries only a server and a path.
# Nothing in Kubernetes can list a directory on it without a container holding the mount,
# and the dashboard may not create containers. The node has mount.nfs, so the node mounts.

NFS_ROOT = "/run/kubeos-nfs"
NFS_DEFAULT_OPTIONS = "nfsvers=4.1,hard,timeo=600,retrans=2"
NFS_MAX_UPLOAD = 256 * 1024 * 1024
# Resolve the helper instead of hard-coding /sbin/mount: on Debian 13 /sbin is a symlink
# to usr/sbin and `mount` lives in /usr/bin, so the "obvious" path does not exist (found by
# the first request: FileNotFoundError surfaced as a 500 with no explanation).
NFS_MOUNT_CMD = shutil.which("mount") or "/usr/bin/mount"
# Anything that reaches a mount call is validated character by character: a space here
# would be an argument, and a colon would be a different server.
NFS_SERVER_RE = re.compile(r"^[A-Za-z0-9._:\[\]-]+$")
NFS_PATH_RE = re.compile(r"^/[A-Za-z0-9._/ :-]*$")
NFS_OPTIONS_RE = re.compile(r"^[A-Za-z0-9._=:@/-]+(,[A-Za-z0-9._=:@/-]+)*$")
# One lock, because two simultaneous browses of the same export must not race on mount.
NFS_LOCK = threading.Lock()


class Failure(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _is_mountpoint(path: str) -> bool:
    try:
        with open("/proc/self/mountinfo", "r", encoding="utf-8") as fh:
            for line in fh:
                fields = line.split()
                if len(fields) > 4 and fields[4] == path:
                    return True
    except OSError:
        pass
    return False


def nfs_mountpoint(server: str, export: str, options: str = "") -> str:
    """Mount the export if it is not mounted yet, and return the local directory."""
    if not NFS_SERVER_RE.match(server or ""):
        raise Failure(400, "invalid NFS server")
    if not NFS_PATH_RE.match(export or "") or ".." in (export or ""):
        raise Failure(400, "invalid NFS export path")
    opts = (options or NFS_DEFAULT_OPTIONS).strip() or NFS_DEFAULT_OPTIONS
    if not NFS_OPTIONS_RE.match(opts):
        raise Failure(400, "invalid mount options")
    key = hashlib.sha256(f"{server}:{export}".encode()).hexdigest()[:16]
    point = os.path.join(NFS_ROOT, key)
    with NFS_LOCK:
        os.makedirs(point, mode=0o700, exist_ok=True)
        if _is_mountpoint(point):
            return point
        result = subprocess.run(
            [NFS_MOUNT_CMD, "-t", "nfs", "-o", opts, f"{server}:{export}", point],
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            reason = (result.stderr or result.stdout or "").strip()
            # A stale mountpoint from a mount that never completed blocks the retry.
            raise Failure(502, f"could not mount {server}:{export} - {reason or 'mount failed'}")
        log(f"mounted {server}:{export} on {point}")
        return point


def nfs_safe_path(root: str, sub: str) -> str:
    """Resolve `sub` inside `root`, refusing anything that escapes it (realpath, so a
    symlink pointing outside the export is refused too)."""
    target = os.path.realpath(os.path.join(root, (sub or "").lstrip("/")))
    if target != root and not target.startswith(root + os.sep):
        raise Failure(403, "that path is outside the volume")
    return target


def nfs_listing(server: str, export: str, sub: str, options: str) -> dict:
    root = nfs_mountpoint(server, export, options)
    target = nfs_safe_path(root, sub)
    if not os.path.isdir(target):
        raise Failure(404, "not a directory")
    entries = []
    with os.scandir(target) as iterator:
        for entry in iterator:
            try:
                info = entry.stat(follow_symlinks=False)
                is_dir = entry.is_dir(follow_symlinks=False)
                link = entry.is_symlink()
            except OSError as reason:
                entries.append({"name": entry.name, "dir": False, "size": 0,
                                "mtime": 0, "error": str(reason)})
                continue
            entries.append({
                "name": entry.name,
                "dir": is_dir,
                "link": link,
                "size": info.st_size,
                "mtime": int(info.st_mtime),
                "mode": oct(info.st_mode & 0o777),
            })
    entries.sort(key=lambda item: (not item["dir"], item["name"].lower()))
    relative = os.path.relpath(target, root)
    return {
        "server": server,
        "export": export,
        "path": "" if relative == "." else relative,
        "parent": "" if relative in (".", "") else os.path.dirname(relative),
        "entries": entries,
    }


def nfs_write(server: str, export: str, sub: str, name: str, body: bytes,
              overwrite: bool, options: str) -> dict:
    if not name or "/" in name or "\\" in name or name in (".", ".."):
        raise Failure(400, "invalid file name")
    root = nfs_mountpoint(server, export, options)
    directory = nfs_safe_path(root, sub)
    if not os.path.isdir(directory):
        raise Failure(404, "that directory is not on the volume")
    target = os.path.join(directory, name)
    if not os.path.realpath(target).startswith(root + os.sep):
        raise Failure(403, "that path is outside the volume")
    if os.path.exists(target) and not overwrite:
        raise Failure(409, "a file with that name already exists")
    # Write beside the target and rename: an interrupted upload leaves no half file, and
    # an interrupted overwrite leaves the old contents intact.
    temp = os.path.join(directory, f".kubeos-upload-{os.getpid()}-{int(time.time())}")
    with open(temp, "wb") as handle:
        handle.write(body)
    os.chmod(temp, 0o644)
    os.replace(temp, target)
    return {"ok": True, "name": name, "size": len(body)}


# ---- HTTP/WebSocket entry point ------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "kubeos-console"
    timeout = 30

    # set on the class by main() so the handler can reach the configuration
    token = ""
    shell = "/bin/bash"

    # SECURITY (SECURITY-REVIEW.md S6): one place that adds the browser protections to every
    # response this console sends, proxied ones included. Only headers that cannot change how a
    # page renders: framing denied, no MIME sniffing, no referrer leak, HTTPS pinned. A full
    # Content-Security-Policy is deliberately NOT set here - it has to be tested in a browser
    # against this service first, or a wrong policy blanks the UI.
    SECURITY_HEADERS = (
        ("X-Frame-Options", "DENY"),
        ("X-Content-Type-Options", "nosniff"),
        ("Referrer-Policy", "no-referrer"),
        ("Content-Security-Policy", "frame-ancestors 'none'"),
        ("Strict-Transport-Security", "max-age=31536000"),
    )

    def end_headers(self):
        for key, value in self.SECURITY_HEADERS:
            self.send_header(key, value)
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:  # journald gets enough
        # The WebSocket handshake carries the token in its query string; the journal is not
        # the place for it.
        line = re.sub(r"(token=)[0-9a-f]+", r"\1…", fmt % args)
        log(f"{self.client_address[0]} {line}")

    # ---- node actions ----------------------------------------------------
    # NOTHING IN THE CLUSTER: the old implementation created a privileged Pod per click, which
    # also meant a Pod could be left behind when a power off killed the node mid-flight.
    # systemctl on the host is the whole action.
    ACTIONS = {"restart": ["reboot"], "poweroff": ["poweroff"]}
    systemctl = "/usr/bin/systemctl"
    # (verb, monotonic time) of the last accepted action. It only has to outlive a double
    # click: a reboot restarts this service, which clears it anyway, and a bounded window
    # means a FAILED systemctl cannot wedge the console until someone restarts it (found by
    # testing: the first version refused every later action for ever).
    last_action: tuple[str, float] = ("", 0.0)
    ACTION_WINDOW = 120.0

    def _action_allowed(self) -> bool:
        """Same token as the shell, and only from the dashboard's own origin."""
        given = self.headers.get("Authorization", "")
        if given.lower().startswith("bearer "):
            given = given[7:]
        else:
            given = (parse_qs(urlparse(self.path).query).get("token") or [""])[0]
        if not hmac.compare_digest(given, self.token):
            return False
        origin = self.headers.get("Origin", "")
        if not origin:
            return True
        return (urlparse(origin).hostname or "") == self.headers.get("Host", "").split(":")[0]

    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin and (urlparse(origin).hostname or "") == self.headers.get("Host", "").split(":")[0]:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()

    def do_OPTIONS(self) -> None:  # noqa: N802 - CORS preflight
        self.send_response(204)
        self._cors()
        # DELETE belongs in this list: the dashboard deletes an etcd snapshot with method
        # DELETE, and a browser refuses to send a method the preflight did not advertise -
        # which is exactly what "Failed to fetch" meant on the Snapshots page (measured
        # 2026-11-20: the request never reached this service, the journal showed no DELETE
        # at all, while curl - which ignores CORS - deleted the file fine).
        self.send_header("Access-Control-Allow-Methods", "POST, PUT, GET, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _nfs_get(self, parsed) -> None:
        query = parse_qs(parsed.query)
        one = lambda key, default="": (query.get(key) or [default])[0]
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        try:
            listing = nfs_listing(one("server"), one("export"), one("sub"), one("options"))
            self._json(200, {"ok": True, **listing})
        except Failure as reason:
            self._json(reason.code, {"ok": False, "error": reason.message})
        except OSError as reason:
            self._json(500, {"ok": False, "error": str(reason)})
        except Exception:  # noqa: BLE001 - never leave the browser with an empty reply
            log("nfs list failed:\n" + traceback.format_exc())
            self._json(500, {"ok": False, "error": "internal error (see journalctl -u kubeos-console)"})

    def _nfs_post(self, parsed) -> None:
        query = parse_qs(parsed.query)
        one = lambda key, default="": (query.get(key) or [default])[0]
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._json(400, {"ok": False, "error": "empty upload"})
            return
        if length > NFS_MAX_UPLOAD:
            self._json(413, {"ok": False, "error": "file larger than 256 MiB"})
            return
        body = b""
        while len(body) < length:
            chunk = self.rfile.read(min(1 << 20, length - len(body)))
            if not chunk:
                break
            body += chunk
        try:
            result = nfs_write(
                one("server"), one("export"), one("sub"), one("name"), body,
                one("overwrite") in ("1", "true", "yes"), one("options"),
            )
            log(f"{self.client_address[0]} wrote {result['name']} ({result['size']} bytes)")
            self._json(201, result)
        except Failure as reason:
            self._json(reason.code, {"ok": False, "error": reason.message})
        except OSError as reason:
            self._json(500, {"ok": False, "error": str(reason)})
        except Exception:  # noqa: BLE001
            log("nfs write failed:\n" + traceback.format_exc())
            self._json(500, {"ok": False, "error": "internal error (see journalctl -u kubeos-console)"})

    def do_PUT(self) -> None:  # noqa: N802 - uploads use PUT
        parsed = urlparse(self.path)
        if parsed.path != "/nfs":
            self.send_error(404)
            return
        self._nfs_post(parsed)

    def do_DELETE(self) -> None:  # noqa: N802 - http.server naming
        parsed = urlparse(self.path)
        if parsed.path != "/etcd/snapshot":
            self.send_error(404)
            return
        self._snapshot_delete(parse_qs(parsed.query))

    def do_POST(self) -> None:  # noqa: N802 - http.server naming
        path = urlparse(self.path).path
        if path == "/nfs":
            self._nfs_post(urlparse(self.path))
            return
        if path == "/action/join":
            self._join_post()
            return
        if path == "/action/standalone":
            self._standalone_post()
            return
        if path == "/etcd/snapshot":
            self._snapshot_post()
            return
        if path == "/action/lvm":
            self._lvm_post()
            return
        if path == "/helm/upload":
            self._helm_upload_post()
            return
        if path == "/helm/action":
            self._helm_action_post()
            return
        if not path.startswith("/action/"):
            self.send_error(404)
            return
        verb = path[len("/action/"):].rstrip("/")
        argv = self.ACTIONS.get(verb)
        if argv is None:
            self._json(404, {"ok": False, "error": f"unknown action: {verb}"})
            return
        if not self._action_allowed():
            log(f"{self.client_address[0]} refused action {verb}: bad token or origin")
            self._json(403, {"ok": False, "error": "bad token"})
            return
        # A second click must not queue a second shutdown: the first one is already on its
        # way and the machine will not be there to serve this request anyway.
        previous_verb, previous_at = Handler.last_action
        if previous_verb and (time.monotonic() - previous_at) < Handler.ACTION_WINDOW:
            self._json(409, {"ok": False, "error": f"already running: {previous_verb}"})
            return
        Handler.last_action = (verb, time.monotonic())
        log(f"{self.client_address[0]} requested {verb} (systemctl {' '.join(argv)})")
        self._json(202, {"ok": True, "action": verb})
        # Answer first, then act: the reply has to reach the browser before the network goes
        # down. `start_new_session` detaches it, so systemd stopping this service mid-reboot
        # does not take the shutdown with it.
        subprocess.Popen(
            [self.systemctl, *argv],
            start_new_session=True,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
        )

    # ---- this node's own facts --------------------------------------------
    # The dashboard's Nodes section lists the CLUSTER, which cannot contain a node whose object
    # was deleted (or that was never joined) - so the machine you are actually talking to had
    # nowhere to appear, and on a detached worker the page looked like the control plane's
    # (user: "why it not showing itself kubeos2 in nodes section", 2026-11-12). This answers
    # "what is this machine" from the machine itself, and whether it is a member of the cluster.
    NODE_UNITS = ("kubelet", "containerd", "kube-proxy",
                  "kubeos-dashboard", "kubeos-dashboard-auth", "kubeos-console")
    DASHBOARD_KUBECONFIG = "/etc/kubeos-dashboard/kubeconfig"

    def _node_get(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        host = socket.gethostname()
        units = {}
        for unit in self.NODE_UNITS:
            result = subprocess.run(["/usr/bin/systemctl", "is-active", unit],
                                    capture_output=True, text=True, timeout=10)
            units[unit] = (result.stdout or "").strip() or "unknown"
        addresses = []
        try:
            addresses = socket.gethostbyname_ex(host)[2]
        except OSError:
            pass
        member = None
        if os.path.exists(self.DASHBOARD_KUBECONFIG):
            probe = subprocess.run(
                ["/usr/bin/kubectl", "--kubeconfig", self.DASHBOARD_KUBECONFIG,
                 "get", "node", host, "-o",
                 'jsonpath={.status.conditions[?(@.type=="Ready")].status}'],
                capture_output=True, text=True, timeout=25)
            member = bool((probe.stdout or "").strip())
        self._json(200, {"hostname": host, "addresses": addresses, "units": units,
                         "member": member,
                         "dashboard_kubeconfig": os.path.exists(self.DASHBOARD_KUBECONFIG)})

    # ---- LVM objects, created on the node by THIS service -------------------
    # WHY HERE AND NOT IN A POD: the Disks page used to start a privileged one-shot Job
    # (hostPID, host root at /host, `nsenter -t 1`) to run pvcreate/vgcreate/lvcreate. It
    # worked, but it broke the rule this product is built on - a dashboard button must not
    # create a Pod - it left a Job (and its pod log) behind for a storage click, it needed
    # pods/jobs create permission on the node's identity, and a shutdown could strand the
    # container. The console is already the node's own root service (Restart, Power off and
    # Shell go through it), so LVM belongs here: the same privilege, no object.
    LVM_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9+_.-]{0,126}$")
    # A whole disk as lsblk names it: /dev/vdb, /dev/sda, /dev/nvme0n1, /dev/mmcblk0.
    LVM_DEVICE_RE = re.compile(r"^/dev/(?:[a-z]+[a-z0-9]*|[a-z]+[a-z0-9]*n[0-9]+|mmcblk[0-9]+)$")
    # lvcreate -L size: a number with a unit, e.g. 8g / 512m / 1.5t.
    LVM_SIZE_RE = re.compile(r"^[0-9]{1,6}(?:\.[0-9]{1,3})?[mMgGtT]$")
    LVM_REPORT_UNIT = "kubeos-disks-report.service"
    LVM_TIMEOUT = 120
    lvm_lock = threading.Lock()

    def _lvm_error(self, code: int, message: str) -> None:
        self._json(code, {"ok": False, "error": message})

    def _lvm_run(self, argv: list[str]) -> tuple[bool, str]:
        try:
            done = subprocess.run(argv, capture_output=True, text=True, timeout=self.LVM_TIMEOUT)
        except (OSError, subprocess.TimeoutExpired) as reason:
            return False, f"{argv[0]} could not run: {reason}"
        output = ((done.stdout or "") + (done.stderr or "")).strip()
        return done.returncode == 0, output[-800:]

    def _lvm_post(self) -> None:
        if not self._action_allowed():
            log(f"{self.client_address[0]} refused /action/lvm: bad token or origin")
            self._json(403, {"ok": False, "error": "bad token"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._lvm_error(400, "bad Content-Length")
            return
        if length <= 0 or length > 8192:
            self._lvm_error(400, "expected a small JSON body")
            return
        try:
            request = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            self._lvm_error(400, "the body is not JSON")
            return
        if not isinstance(request, dict):
            self._lvm_error(400, "the body must be a JSON object")
            return

        action = str(request.get("action") or "")
        name = str(request.get("name") or "")
        if not self.LVM_NAME_RE.match(name):
            self._lvm_error(400, "invalid name: letters, digits and +_.- only, no leading '-'")
            return

        # One LVM action at a time: two dialogs (or a double click) must not race on the same
        # volume group, and `vgcreate` is not fast.
        if not self.lvm_lock.acquire(blocking=False):
            self._lvm_error(409, "another LVM action is still running")
            return
        try:
            if action == "vgcreate":
                message, code = self._lvm_vgcreate(name, str(request.get("device") or ""))
            elif action == "thinpool":
                message, code = self._lvm_thinpool(
                    name, str(request.get("volumeGroup") or ""), str(request.get("size") or ""))
            else:
                message, code = f"unknown action: {action}", 400
            if code != 200:
                log(f"{self.client_address[0]} refused lvm {action} {name}: {message}")
                self._lvm_error(code, message)
                return
            # The page reads its facts from the report ConfigMap, so refresh it now instead of
            # waiting up to a minute for the timer.
            try:
                subprocess.run(["/usr/bin/systemctl", "start", self.LVM_REPORT_UNIT],
                               capture_output=True, text=True, timeout=30)
            except (OSError, subprocess.TimeoutExpired):
                pass
            log(f"{self.client_address[0]} created lvm {action} {name}")
            self._json(200, {"ok": True, "action": action, "name": name, "detail": message})
        finally:
            self.lvm_lock.release()

    def _lvm_vgcreate(self, name: str, device: str) -> tuple[str, int]:
        if not self.LVM_DEVICE_RE.match(device):
            return "invalid device path", 400
        if not os.path.exists(device):
            return f"{device} does not exist", 400
        ok, kind = self._lvm_run(["/usr/bin/lsblk", "-ndo", "TYPE", device])
        if not ok or kind.strip() != "disk":
            return f"{device} is not a whole disk (lsblk says {kind.strip() or 'nothing'})", 400
        ok, mounted = self._lvm_run(["/usr/bin/findmnt", "-rn", "-S", device])
        if ok and mounted.strip():
            return f"{device} is mounted: {mounted.strip().splitlines()[0]}", 400
        # "already in a volume group" before the partition test: a disk that is already a PV also
        # lists its thin pools as children, and "belongs to kbstest" is the useful answer.
        ok, group = self._lvm_run(["/usr/sbin/pvs", "--noheadings", "-o", "vg_name", device])
        if ok and group.strip():
            return f"{device} already belongs to volume group {group.strip()}", 400
        # A disk with partitions on it is in use, whatever it holds: refuse before pvcreate
        # gets a chance to write anything (lsblk lists the disk itself first, then its children).
        ok, children = self._lvm_run(["/usr/bin/lsblk", "-rno", "NAME", device])
        if ok and len(children.strip().splitlines()) > 1:
            return f"{device} has partitions on it; refusing to overwrite it", 400
        ok, output = self._lvm_run(["/usr/sbin/pvcreate", "-ff", "-y", device])
        if not ok:
            return f"pvcreate failed: {output}", 500
        ok, output = self._lvm_run(["/usr/sbin/vgcreate", name, device])
        if not ok:
            return f"vgcreate failed: {output}", 500
        return f"volume group {name} created on {device}", 200

    def _lvm_thinpool(self, name: str, volume_group: str, size: str) -> tuple[str, int]:
        if not self.LVM_NAME_RE.match(volume_group):
            return "invalid volume group name", 400
        if size and not self.LVM_SIZE_RE.match(size):
            return "invalid size (for example 8g, 512m, 1.5t)", 400
        ok, groups = self._lvm_run(["/usr/sbin/vgs", "--noheadings", "-o", "vg_name"])
        if not ok:
            return f"could not list volume groups: {groups}", 500
        if volume_group not in groups.split():
            return f"volume group {volume_group} does not exist", 400
        argv = ["/usr/sbin/lvcreate", "--type", "thin-pool"]
        argv += ["-L", size] if size else ["-l", "100%FREE"]
        argv += ["-n", name, volume_group]
        ok, output = self._lvm_run(argv)
        if not ok:
            return f"lvcreate failed: {output}", 500
        return f"thin pool {name} created in {volume_group}", 200

    # ---- etcd snapshots ---------------------------------------------------
    # WHY A HOST SERVICE AND NOT A PROVISIONER POD: a snapshot is the only thing that can
    # rescue a broken cluster state, and on KubeOS a Pod cannot be relied on for it - the
    # whole design keeps base Pods out, and a Pod cannot read the host's etcd PKI without
    # being mounted into the host. etcdctl is already on the node (vendored with the control
    # plane), so this is three lines of subprocess and nothing new to install.
    SNAPSHOT_DIR = "/var/lib/kubeos/etcd-snapshots"
    SNAPSHOT_PREFIX = "kubeos-etcd"
    SNAPSHOT_MAX_BYTES = 1 << 30        # refuse to stream anything bigger than 1 GiB
    ETCDCTL = "/usr/local/bin/etcdctl"
    ETCD_PKI = "/etc/kubernetes/pki/etcd"
    ETCD_ENDPOINT = "https://127.0.0.1:2379"
    SNAPSHOT_NAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,120}\.db$")

    def _snapshots_supported(self) -> bool:
        """Only a control plane has an etcd to snapshot; a worker must say so, not pretend."""
        return os.path.exists(os.path.join(self.ETCD_PKI, "server.crt")) and os.path.exists(self.ETCDCTL)

    def _snapshot_names(self) -> list[str]:
        try:
            return sorted(entry for entry in os.listdir(self.SNAPSHOT_DIR)
                          if entry.endswith(".db") and self.SNAPSHOT_NAME_RE.match(entry))
        except OSError:
            return []

    # --- Helm, read only (2026-11-22) --------------------------------------------------
    # Until now Helm existed only in a terminal: `helm` is installed on the node (v4.3.0) but a
    # node had no way to answer "what is deployed here, and with which values?" without SSH.
    #
    # NOT A POD, NOT A JOB, NOT AN EXEC (user decision 2026-11-12): this runs `helm` on the host
    # with an argument list, exactly like the LVM actions above, and this release only READS.
    # Install/upgrade/rollback/uninstall are a separate change with their own guards - a page that
    # can only look must never be able to change a cluster.
    HELM = "/usr/bin/helm"
    ADMIN_KUBECONFIG = "/etc/kubernetes/admin.conf"
    HELM_MANIFEST_LIMIT = 256 * 1024
    # Release names and namespaces are DNS labels; anything else is refused before it reaches argv.
    HELM_NAME = re.compile(r"^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$")

    # --- Helm operations (2026-11-22, phase 2) ------------------------------------------
    # The user's words: "i just don't want to see only information.. i want user should do some
    # basic operations from dashboard" - the five things they would otherwise type: install,
    # upgrade, rollback, uninstall, and a preview before any of them.
    #
    # STILL NOT A POD (user decision 2026-11-12): every operation runs `helm` on the host with an
    # argument list. Nothing is created in the cluster to run it, and nothing is left behind if it
    # fails.
    #
    # THE PREVIEW IS ALWAYS `--dry-run=client`, never `server`: client mode renders the chart
    # without contacting the API at all, so a preview can never create a namespace or a release
    # even where helm's own `--create-namespace --dry-run=server` combination has been reported to
    # persist one. The real operation then runs without --dry-run.
    HELM_CHART_DIR = "/var/lib/kubeos-console/charts"
    HELM_UPLOAD_LIMIT = 64 * 1024 * 1024
    HELM_VALUES_LIMIT = 256 * 1024
    HELM_BODY_LIMIT = 512 * 1024
    HELM_PREVIEW_TIMEOUT = 180
    HELM_MUTATE_TIMEOUT = 600
    HELM_KEEP_CHARTS = 20
    # A release in one of these namespaces is the cluster's own control plane or this node's
    # dashboard and console: a web page must never be able to remove it (user decision
    # 2026-11-22, "guard kubeos-system/kube-system + typed confirm").
    HELM_PROTECTED_NAMESPACES = ("kubeos-system", "kube-system")
    helm_lock = threading.Lock()

    def _helm_error(self, code: int, message: str) -> None:
        self._json(code, {"ok": False, "error": message})

    def _helm_kubeconfig(self) -> "str | None":
        """admin.conf on a control plane; the dashboard's own identity on a worker."""
        for path in (self.ADMIN_KUBECONFIG, self.DASHBOARD_KUBECONFIG):
            if os.path.exists(path):
                return path
        return None

    def _helm(self, args: list, timeout: int = 60) -> tuple:
        """Run helm with an argument LIST (never a shell string): (ok, stdout, error)."""
        kubeconfig = self._helm_kubeconfig()
        if kubeconfig is None:
            return False, "", "this node has no kubeconfig, so Helm cannot be used here"
        if not os.access(self.HELM, os.X_OK):
            return False, "", "helm is not installed on this node"
        env = {key: value for key, value in os.environ.items() if not key.startswith("HELM_")}
        env.update({"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                    "KUBECONFIG": kubeconfig, "HOME": "/root"})
        try:
            result = subprocess.run([self.HELM] + list(args), capture_output=True, text=True,
                                    timeout=timeout, env=env)
        except subprocess.TimeoutExpired:
            return False, "", "helm did not answer within %d seconds" % timeout
        except OSError as reason:
            return False, "", "could not run helm: %s" % reason
        if result.returncode != 0:
            return False, result.stdout or "", (result.stderr or result.stdout
                                                or "helm failed").strip()[-600:]
        return True, result.stdout, ""

    def _helm_releases_get(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        ok, out, error = self._helm(["list", "--all-namespaces", "-o", "json"])
        if not ok:
            self._json(409, {"ok": False, "error": error})
            return
        try:
            releases = json.loads(out or "[]")
        except ValueError:
            self._json(500, {"ok": False, "error": "helm list returned something that is not JSON"})
            return
        log("%s listed %d Helm release(s)" % (self.client_address[0], len(releases)))
        self._json(200, {"ok": True, "helm": True, "releases": releases})

    def _helm_release_get(self, parsed) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        query = parse_qs(parsed.query)
        name = (query.get("name") or [""])[0]
        namespace = (query.get("namespace") or [""])[0]
        if not self.HELM_NAME.match(name) or not self.HELM_NAME.match(namespace):
            self._json(400, {"ok": False,
                             "error": "name and namespace must look like Kubernetes names"})
            return
        target = ["--namespace", namespace, name]
        status_ok, status_out, status_err = self._helm(["status"] + target + ["-o", "json"])
        if not status_ok:
            self._json(404, {"ok": False, "error": status_err})
            return

        def as_json(ok: bool, out: str):
            if not ok:
                return None
            try:
                return json.loads(out or "null")
            except ValueError:
                return None

        values_ok, values_out, _ = self._helm(["get", "values"] + target + ["-o", "json"])
        # The Upgrade dialog edits YAML, not JSON, and handing it the exact text helm itself prints
        # is one conversion less to get wrong. helm prints "null" when the release has no values.
        yaml_ok, yaml_out, _ = self._helm(["get", "values"] + target + ["-o", "yaml"])
        values_yaml = yaml_out if yaml_ok else ""
        if values_yaml.strip() in ("", "null"):
            values_yaml = ""
        metadata_ok, metadata_out, _ = self._helm(["get", "metadata"] + target + ["-o", "json"])
        history_ok, history_out, _ = self._helm(["history"] + target + ["--max", "20", "-o", "json"])
        manifest_ok, manifest_out, manifest_err = self._helm(["get", "manifest"] + target)
        manifest = manifest_out if manifest_ok else ""
        truncated = len(manifest) > self.HELM_MANIFEST_LIMIT
        if truncated:
            manifest = manifest[:self.HELM_MANIFEST_LIMIT]
        log("%s opened Helm release %s/%s" % (self.client_address[0], namespace, name))
        self._json(200, {
            "ok": True,
            "namespace": namespace,
            "name": name,
            "status": as_json(status_ok, status_out),
            "values": as_json(values_ok, values_out),
            "values_yaml": values_yaml,
            "metadata": as_json(metadata_ok, metadata_out),
            "history": as_json(history_ok, history_out),
            "manifest": manifest,
            "manifest_truncated": truncated,
            "manifest_error": "" if manifest_ok else manifest_err,
        })

    def _helm_repos_get(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        ok, out, error = self._helm(["repo", "list", "-o", "json"])
        repos: list = []
        if ok:
            try:
                repos = json.loads(out or "[]")
            except ValueError:
                repos = []
        # No repository configured is the normal state on an offline node, so it is not an error;
        # the page says "no repositories, upload a chart instead" rather than showing a failure.
        self._json(200, {"ok": True, "repos": repos, "error": "" if ok else error})

    # --- Helm operations, phase 2 (2026-11-22) ------------------------------------------
    def _helm_charts_get(self) -> None:
        """Charts uploaded through this page, so the Install form can offer them again."""
        if not self._action_allowed():
            self._helm_error(403, "bad token")
            return
        charts = []
        try:
            entries = sorted(os.listdir(self.HELM_CHART_DIR), reverse=True)
        except OSError:
            entries = []
        for entry in entries:
            path = os.path.join(self.HELM_CHART_DIR, entry)
            if not entry.endswith(".tgz") or not os.path.isfile(path):
                continue
            name, version, problem = describe_chart(path)
            charts.append({"chart": "upload:" + entry,
                           "size": os.path.getsize(path),
                           "uploaded": time.strftime("%Y-%m-%d %H:%M:%S",
                                                     time.localtime(os.path.getmtime(path))),
                           "name": name, "version": version,
                           "problem": problem})
            if len(charts) >= self.HELM_KEEP_CHARTS:
                break
        self._json(200, {"ok": True, "charts": charts, "directory": self.HELM_CHART_DIR})

    def _helm_upload_post(self) -> None:
        """Store a chart .tgz posted by the browser, and say what is inside it."""
        if not self._action_allowed():
            log(f"{self.client_address[0]} refused /helm/upload: bad token or origin")
            self._helm_error(403, "bad token")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            self._helm_error(400, "empty upload")
            return
        if length > self.HELM_UPLOAD_LIMIT:
            self._helm_error(413, "that chart is larger than 64 MiB")
            return
        try:
            os.makedirs(self.HELM_CHART_DIR, mode=0o700, exist_ok=True)
        except OSError as reason:
            self._helm_error(500, "cannot create %s: %s" % (self.HELM_CHART_DIR, reason))
            return
        # The stored name is generated HERE and never taken from the browser: a client-supplied
        # filename in a directory that is later handed to `helm` is a path problem waiting to
        # happen, and the original name is not needed to run anything.
        entry = "chart-%s-%s.tgz" % (time.strftime("%Y%m%d-%H%M%S", time.gmtime()),
                                     os.urandom(3).hex())
        path = os.path.join(self.HELM_CHART_DIR, entry)
        written = 0
        try:
            with open(path, "wb") as handle:
                remaining = length
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    handle.write(chunk)
                    written += len(chunk)
                    remaining -= len(chunk)
        except OSError as reason:
            self._remove_quietly(path)
            self._helm_error(500, "could not store the upload: %s" % reason)
            return
        chart_name, chart_version, problem = describe_chart(path)
        if written != length:
            self._remove_quietly(path)
            self._helm_error(400, "the upload stopped after %d of %d bytes" % (written, length))
            return
        if problem:
            self._remove_quietly(path)
            self._helm_error(400, problem)
            return
        self._prune_charts()
        log("%s uploaded chart %s (%d bytes, %s-%s)" % (self.client_address[0], entry, written,
                                                        chart_name, chart_version))
        self._json(201, {"ok": True, "chart": "upload:" + entry, "size": written,
                         "name": chart_name, "version": chart_version})

    @staticmethod
    def _remove_quietly(path: str) -> None:
        try:
            os.unlink(path)
        except OSError:
            pass

    def _prune_charts(self) -> None:
        """Keep the newest HELM_KEEP_CHARTS uploads; a node is not a chart museum."""
        try:
            entries = sorted((os.path.getmtime(os.path.join(self.HELM_CHART_DIR, name)), name)
                             for name in os.listdir(self.HELM_CHART_DIR)
                             if name.startswith("chart-") and name.endswith(".tgz"))
        except OSError:
            return
        for _, name in entries[:-self.HELM_KEEP_CHARTS]:
            self._remove_quietly(os.path.join(self.HELM_CHART_DIR, name))

    def _helm_chart_path(self, request: dict, name: str = "", namespace: str = "") -> tuple:
        """Resolve the posted `chart` to a real path. ("", reason) means refused."""
        chart = str(request.get("chart") or "").strip()
        if chart.startswith("upload:"):
            entry = chart[len("upload:"):]
            if not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.tgz$", entry):
                return "", "that is not a chart this node uploaded"
            path = os.path.join(self.HELM_CHART_DIR, entry)
            if not os.path.isfile(path):
                return "", "that uploaded chart is no longer on the node; upload it again"
            return path, ""
        if chart:
            if ".." in chart or not re.match(r"^/[A-Za-z0-9._/-]+$", chart):
                return "", "give a chart as an uploaded file, or an absolute path on the node"
            if os.path.isdir(chart):
                if not os.path.isfile(os.path.join(chart, "Chart.yaml")):
                    return "", "%s is a directory without a Chart.yaml" % chart
                return chart, ""
            if os.path.isfile(chart) and (chart.endswith(".tgz") or chart.endswith(".tar.gz")):
                return chart, ""
            return "", "%s is neither a chart directory nor a .tgz file" % chart
        # No chart given: an UPGRADE can reuse the chart this release was installed from, if it is
        # still among this node's uploads. Without it helm cannot upgrade at all - it has no
        # "keep the current chart" flag - so say so instead of failing with helm's own words.
        if not (name and namespace):
            return "", "choose a chart: upload one, or give an absolute path on the node"
        ok, out, _ = self._helm(["get", "metadata", name, "-n", namespace, "-o", "json"])
        if not ok:
            return "", "choose a chart: this release has no readable metadata to match one against"
        try:
            metadata = json.loads(out or "{}")
        except ValueError:
            return "", "choose a chart: this release's metadata is not JSON"
        wanted = (str(metadata.get("chart") or ""), str(metadata.get("version") or ""))
        try:
            candidates = sorted(os.listdir(self.HELM_CHART_DIR), reverse=True)
        except OSError:
            candidates = []
        for entry in candidates:
            if not entry.endswith(".tgz"):
                continue
            found_name, found_version, problem = describe_chart(os.path.join(self.HELM_CHART_DIR,
                                                                             entry))
            if not problem and (found_name, found_version) == wanted:
                log("%s matched release %s/%s to uploaded chart %s"
                    % (self.client_address[0], namespace, name, entry))
                return os.path.join(self.HELM_CHART_DIR, entry), ""
        return "", ("%s/%s was installed from chart %s-%s, and this node no longer has that file: "
                    "upload it again to change only its values"
                    % (namespace, name, wanted[0] or "?", wanted[1] or "?"))

    def _helm_values_file(self, request: dict) -> tuple:
        """Write the posted YAML to a private temp file. ("", "") means 'no -f at all'."""
        values = request.get("values")
        if values is None or (isinstance(values, str) and not values.strip()):
            return "", ""
        if not isinstance(values, str):
            return "", "the values must be YAML text"
        if len(values) > self.HELM_VALUES_LIMIT:
            return "", "the values are larger than 256 KiB"
        try:
            os.makedirs(self.HELM_CHART_DIR, mode=0o700, exist_ok=True)
            handle, path = tempfile.mkstemp(prefix="values-", suffix=".yaml",
                                            dir=self.HELM_CHART_DIR)
            with os.fdopen(handle, "w") as out:
                out.write(values)
            os.chmod(path, 0o600)
        except OSError as reason:
            return "", "cannot write the values file: %s" % reason
        return path, ""

    def _helm_action_post(self) -> None:
        """install / upgrade / rollback / uninstall, each optionally as a preview."""
        if not self._action_allowed():
            log(f"{self.client_address[0]} refused /helm/action: bad token or origin")
            self._helm_error(403, "bad token")
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > self.HELM_BODY_LIMIT:
            self._helm_error(400, "expected a JSON body under 512 KiB")
            return
        try:
            request = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except (ValueError, UnicodeDecodeError):
            self._helm_error(400, "the body is not JSON")
            return
        if not isinstance(request, dict):
            self._helm_error(400, "the body must be a JSON object")
            return

        action = str(request.get("action") or "")
        name = str(request.get("name") or "")
        namespace = str(request.get("namespace") or "")
        dry = bool(request.get("dryRun"))
        if action not in ("install", "upgrade", "rollback", "uninstall"):
            self._helm_error(400, "unknown Helm action: %s" % (action or "(none)"))
            return
        if not self.HELM_NAME.match(name):
            self._helm_error(400, "the release name must look like a Kubernetes name")
            return
        if not self.HELM_NAME.match(namespace):
            self._helm_error(400, "the namespace must look like a Kubernetes name")
            return
        if action == "uninstall" and namespace in self.HELM_PROTECTED_NAMESPACES:
            self._helm_error(403, ("refusing to uninstall %s/%s from a web page: namespace %s "
                                   "holds this node's own services (use kubectl on the node)"
                                   % (namespace, name, namespace)))
            return
        # A preview may be repeated freely; anything that changes the cluster runs one at a time,
        # because two `helm upgrade`s on one release interleave their revisions.
        if not self.helm_lock.acquire(blocking=(dry)):
            self._helm_error(409, "another Helm operation is still running on this node")
            return
        values_path = ""
        try:
            if action == "uninstall":
                if str(request.get("confirm") or "") != name:
                    self._helm_error(400, "type the release name (%s) to confirm the uninstall" % name)
                    return
                argv = ["uninstall", name, "-n", namespace]
            elif action == "rollback":
                revision = request.get("revision")
                if isinstance(revision, bool) or not isinstance(revision, int) \
                        or not 1 <= revision <= 10000:
                    self._helm_error(400, "pick a revision number from the history")
                    return
                if str(request.get("confirm") or "") != name:
                    self._helm_error(400, "type the release name (%s) to confirm the rollback" % name)
                    return
                argv = ["rollback", name, str(revision), "-n", namespace]
            else:
                chart, problem = self._helm_chart_path(request, name, namespace)
                if problem:
                    self._helm_error(400, problem)
                    return
                values_path, problem = self._helm_values_file(request)
                if problem:
                    self._helm_error(400, problem)
                    return
                if action == "install":
                    argv = ["install", name, chart, "-n", namespace, "--create-namespace"]
                else:
                    argv = ["upgrade", name, chart, "-n", namespace]
                if values_path:
                    argv += ["-f", values_path]
            if dry:
                argv.append("--dry-run=client")
            timeout = self.HELM_PREVIEW_TIMEOUT if dry else self.HELM_MUTATE_TIMEOUT
            ok, out, error = self._helm(argv, timeout)
            if not ok:
                first = (error or "helm failed").splitlines()[0][:200]
                log("%s Helm %s %s %s/%s failed: %s" % (self.client_address[0],
                                                        "preview of" if dry else "", action,
                                                        namespace, name, first))
                self._helm_error(409, error or "helm failed")
                return
            log("%s Helm %s%s %s/%s (values: %s)" % (self.client_address[0],
                                                     "preview of " if dry else "", action,
                                                     namespace, name,
                                                     "yes" if values_path else "no"))
            self._json(200, {"ok": True, "action": action, "name": name, "namespace": namespace,
                             "dryRun": dry,
                             "output": (out or "")[:self.HELM_MANIFEST_LIMIT]})
        except Exception as reason:  # noqa: BLE001 - see the comment
            # Deliberately broad: by the time anything here can fail, `helm` may ALREADY have run.
            # Dropping the connection (what an unhandled exception does) tells the browser "no
            # answer" and invites a retry of an operation that has been applied - measured
            # 2026-11-22, when a bad %-format in the success log did exactly that. Answer instead.
            log("%s Helm %s %s/%s: answered with an error after running helm: %r"
                % (self.client_address[0], action, namespace, name, reason))
            self._json(500, {"ok": False,
                             "error": ("the node ran the Helm command but could not report it (%s); "
                                       "reload this page to see the real state before retrying"
                                       % reason)})
        finally:
            if values_path:
                self._remove_quietly(values_path)
            self.helm_lock.release()

    def _snapshots_get(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        if not self._snapshots_supported():
            self._json(409, {"ok": False, "supported": False,
                             "error": "this machine is not a control plane, so it has no etcd to snapshot"})
            return
        entries = []
        for name in self._snapshot_names():
            full = os.path.join(self.SNAPSHOT_DIR, name)
            try:
                stat = os.stat(full)
            except OSError:
                continue
            entries.append({"name": name, "bytes": stat.st_size, "modified": int(stat.st_mtime)})
        self._json(200, {"ok": True, "supported": True, "directory": self.SNAPSHOT_DIR,
                         "snapshots": entries})

    def _snapshot_post(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        if not self._snapshots_supported():
            self._json(409, {"ok": False, "supported": False,
                             "error": "this machine is not a control plane, so it has no etcd to snapshot"})
            return
        name = "%s-%s.db" % (self.SNAPSHOT_PREFIX, time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
        target = os.path.join(self.SNAPSHOT_DIR, name)
        os.makedirs(self.SNAPSHOT_DIR, exist_ok=True)
        try:
            os.chmod(self.SNAPSHOT_DIR, 0o700)
        except OSError:
            pass
        result = subprocess.run(
            [self.ETCDCTL, "--endpoints", self.ETCD_ENDPOINT,
             "--cacert", os.path.join(self.ETCD_PKI, "ca.crt"),
             "--cert", os.path.join(self.ETCD_PKI, "server.crt"),
             "--key", os.path.join(self.ETCD_PKI, "server.key"),
             "snapshot", "save", target],
            capture_output=True, text=True, timeout=120,
            env={"ETCDCTL_API": "3", "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        )
        if result.returncode != 0:
            log("etcd snapshot failed:\n" + (result.stderr or result.stdout or "")[-2000:])
            # A half-written .db must not look like a backup.
            try:
                os.unlink(target)
            except OSError:
                pass
            self._json(500, {"ok": False, "error": (result.stderr or result.stdout or "etcdctl failed").strip()[-400:]})
            return
        try:
            size = os.stat(target).st_size
        except OSError:
            size = 0
        log(f"{self.client_address[0]} wrote a snapshot: {name} ({size} bytes)")
        self._json(201, {"ok": True, "name": name, "bytes": size,
                         "modified": int(time.time()), "directory": self.SNAPSHOT_DIR})

    def _snapshot_download(self, query) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        name = (query.get("name") or [""])[0]
        # No traversal, and only files this service created: the directory is root-owned 0700,
        # but the name still comes from a URL.
        if not self.SNAPSHOT_NAME_RE.match(name) or name not in self._snapshot_names():
            self._json(404, {"ok": False, "error": "no such snapshot"})
            return
        full = os.path.join(self.SNAPSHOT_DIR, name)
        try:
            size = os.stat(full).st_size
        except OSError:
            self._json(404, {"ok": False, "error": "no such snapshot"})
            return
        if size > self.SNAPSHOT_MAX_BYTES:
            self._json(413, {"ok": False, "error": "snapshot larger than 1 GiB - fetch it over ssh"})
            return
        log(f"{self.client_address[0]} downloading snapshot {name} ({size} bytes)")
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Disposition", f'attachment; filename="{name}"')
        self.send_header("Content-Length", str(size))
        self._cors()
        self.end_headers()
        with open(full, "rb") as handle:
            shutil.copyfileobj(handle, self.wfile)

    def _snapshot_delete(self, query) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        name = (query.get("name") or [""])[0]
        if not self.SNAPSHOT_NAME_RE.match(name) or name not in self._snapshot_names():
            self._json(404, {"ok": False, "error": "no such snapshot"})
            return
        try:
            os.unlink(os.path.join(self.SNAPSHOT_DIR, name))
        except OSError as reason:
            self._json(500, {"ok": False, "error": f"could not delete {name}: {reason}"})
            return
        log(f"{self.client_address[0]} deleted snapshot {name}")
        self._json(200, {"ok": True, "name": name})

    # ---- joining this node to a cluster -----------------------------------
    JOIN_UNIT = "kubeos-node-join"
    JOIN_HELPER = "/usr/bin/kubeos-node-join"

    def _join_post(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        length = int(self.headers.get("Content-Length") or 0)
        # 32 KiB: the join string now also carries the joining node's dashboard kubeconfig
        # (a service-account token plus the cluster CA), which is a few KiB on its own.
        if length <= 0 or length > 32768:
            self._json(400, {"ok": False, "error": "expected a small JSON body"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8", "replace"))
        except ValueError:
            self._json(400, {"ok": False, "error": "the body is not JSON"})
            return
        bundle = str(payload.get("bundle") or "").strip()
        if not (bundle.startswith("KOSJOIN1.") or bundle.startswith("kubeadm join ")):
            self._json(400, {"ok": False, "error": "that does not look like a KubeOS join string"})
            return
        if not os.path.exists(self.JOIN_HELPER):
            self._json(500, {"ok": False, "error":
                             f"{self.JOIN_HELPER} is missing - this node's image has no join helper"})
            return
        # A transient unit, not a child process: `kubeadm reset` tears down this node's own
        # API server, and a unit keeps running through that.
        #
        # NO --collect, and a reset-failed first: a collected unit is unloaded the moment it
        # finishes, so `systemctl show` then reports the *defaults* (`Result=success`) and the
        # page could not tell a failed join from a finished one (measured on kubeos2). Leaving
        # the unit behind makes `Result` truthful; the reset is what lets the operator try a
        # second, corrected join string.
        subprocess.run(["/usr/bin/systemctl", "reset-failed", self.JOIN_UNIT],
                       capture_output=True, text=True, timeout=15)
        result = subprocess.run(
            ["/usr/bin/systemd-run", "--unit", self.JOIN_UNIT, "--no-block",
             "--description=KubeOS join: make this node a worker",
             self.JOIN_HELPER, bundle],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            self._json(500, {"ok": False,
                             "error": (result.stderr or result.stdout or "systemd-run failed").strip()})
            return
        log(f"{self.client_address[0]} started the join as unit {self.JOIN_UNIT}")
        self._json(202, {"ok": True, "unit": self.JOIN_UNIT,
                         "detail": "the node is joining; this dashboard goes away when its own "
                                   "cluster is reset and comes back when the node is Ready"})

    # ---- becoming a standalone node again ----------------------------------
    # Fired by the dashboard gateway when this machine has been REMOVED from its cluster (see
    # kubeos-node-standalone and authproxy's membership probe). A transient unit for the same
    # reason as the join: the work stops kubelet and starts the node's own control plane, which
    # takes this dashboard down and back up again.
    STANDALONE_UNIT = "kubeos-node-standalone"
    STANDALONE_HELPER = "/usr/bin/kubeos-node-standalone"

    def _standalone_post(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        if not os.path.exists(self.STANDALONE_HELPER):
            self._json(500, {"ok": False,
                             "error": f"{self.STANDALONE_HELPER} is missing - this node's image has no standalone helper"})
            return
        subprocess.run(["/usr/bin/systemctl", "reset-failed", self.STANDALONE_UNIT],
                       capture_output=True, text=True, timeout=15)
        result = subprocess.run(
            ["/usr/bin/systemd-run", "--unit", self.STANDALONE_UNIT, "--no-block",
             "--description=KubeOS: make this node a standalone node again",
             self.STANDALONE_HELPER],
            capture_output=True, text=True, timeout=30,
        )
        if result.returncode != 0:
            self._json(500, {"ok": False,
                             "error": (result.stderr or result.stdout or "systemd-run failed").strip()})
            return
        log(f"{self.client_address[0]} started the standalone bring-up as unit {self.STANDALONE_UNIT}")
        self._json(202, {"ok": True, "unit": self.STANDALONE_UNIT,
                         "detail": "this machine is rebuilding its own one-node cluster; its dashboard "
                                   "comes back when that is done"})

    def _standalone_get(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        active = subprocess.run(["/usr/bin/systemctl", "is-active", self.STANDALONE_UNIT],
                                capture_output=True, text=True, timeout=10)
        state = (active.stdout or "").strip() or "unknown"
        shown = subprocess.run(
            ["/usr/bin/systemctl", "show", self.STANDALONE_UNIT, "-p", "Result",
             "-p", "ActiveEnterTimestamp", "--value"],
            capture_output=True, text=True, timeout=10,
        )
        values = (shown.stdout or "").splitlines()
        journal = subprocess.run(
            ["/usr/bin/journalctl", "-u", self.STANDALONE_UNIT, "-n", "1", "--no-pager", "-o", "cat"],
            capture_output=True, text=True, timeout=15,
        )
        self._json(200, {"ok": True, "unit": self.STANDALONE_UNIT, "state": state,
                         "result": values[0] if values else "",
                         "entered": values[1] if len(values) > 1 else "",
                         "last_log_line": (journal.stdout or "").strip()[-300:]})

    def _join_get(self) -> None:
        if not self._action_allowed():
            self._json(403, {"ok": False, "error": "bad token"})
            return
        show = subprocess.run(
            ["/usr/bin/systemctl", "show", self.JOIN_UNIT,
             "-p", "ActiveState", "-p", "SubState", "-p", "Result"],
            capture_output=True, text=True, timeout=15,
        )
        state = {}
        for line in (show.stdout or "").splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                state[key] = value
        tail = subprocess.run(
            ["/usr/bin/journalctl", "-u", self.JOIN_UNIT, "-n", "20", "--no-pager", "-o", "cat"],
            capture_output=True, text=True, timeout=15,
        )
        self._json(200, {"ok": True, "state": state, "log": (tail.stdout or "").strip()})

    def do_GET(self) -> None:  # noqa: N802 - http.server naming
        parsed = urlparse(self.path)
        if parsed.path == "/healthz":
            body = b"ok\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/":
            # A browser cannot "accept" a certificate for a WebSocket the way it can for a
            # page, so this page exists to be opened ONCE per browser: accepting the warning
            # here is what lets the dashboard's Shell button connect to :30444 afterwards.
            body = (
                "<!doctype html><meta charset=utf-8><title>KubeOS host console</title>"
                "<body style='background:#0b0b0b;color:#c8f04a;font:14px/1.6 monospace;"
                "padding:2rem'><h1 style='font-size:1.1rem'>KubeOS host console</h1>"
                "<p>This port gives the dashboard's <b>Shell</b> button a shell on the node."
                "</p><p>If you can read this, this browser now trusts the certificate:"
                " close this tab and press <b>Shell</b> in the dashboard.</p>"
                "</body>"
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if parsed.path == "/nfs":
            self._nfs_get(parsed)
            return
        if parsed.path == "/action/join":
            self._join_get()
            return
        if parsed.path == "/action/standalone":
            self._standalone_get()
            return
        if parsed.path == "/node":
            self._node_get()
            return
        if parsed.path == "/etcd/snapshots":
            self._snapshots_get()
            return
        if parsed.path == "/etcd/snapshot":
            self._snapshot_download(parse_qs(parsed.query))
            return
        # Helm: read-only in this release (see _helm_releases_get for why it is not a Pod).
        if parsed.path == "/helm/releases":
            self._helm_releases_get()
            return
        if parsed.path == "/helm/release":
            self._helm_release_get(parsed)
            return
        if parsed.path == "/helm/repos":
            self._helm_repos_get()
            return
        if parsed.path == "/helm/charts":
            self._helm_charts_get()
            return
        if parsed.path != "/ws":
            self.send_error(404)
            return
        query = parse_qs(parsed.query)
        given = (query.get("token") or [""])[0]
        if not hmac.compare_digest(given, self.token):
            log(f"{self.client_address[0]} refused: bad token")
            self.send_error(403, "bad token")
            return
        origin = self.headers.get("Origin", "")
        if origin:
            # Same host, any port: the dashboard is served from :30443, the console from
            # :30444, and a page on any other host must not drive this socket.
            origin_host = urlparse(origin).hostname or ""
            if origin_host not in (self.headers.get("Host", "").split(":")[0],):
                log(f"{self.client_address[0]} refused: origin {origin}")
                self.send_error(403, "bad origin")
                return
        key = self.headers.get("Sec-WebSocket-Key", "")
        if not key:
            self.send_error(400, "not a websocket handshake")
            return
        accept = base64.b64encode(
            hashlib.sha1((key + WS_GUID).encode()).digest()
        ).decode()
        self.send_response(101, "Switching Protocols")
        self.send_header("Upgrade", "websocket")
        self.send_header("Connection", "Upgrade")
        self.send_header("Sec-WebSocket-Accept", accept)
        self.end_headers()
        self.wfile.flush()
        env_extra = {}
        for name in ("KUBECONFIG",):
            if os.environ.get(name):
                env_extra[name] = os.environ[name]
        log(f"{self.client_address[0]} opened a shell")
        Session(self.connection, self.shell).run(env_extra)
        log(f"{self.client_address[0]} closed a shell")


def main() -> int:
    parser = argparse.ArgumentParser(description="KubeOS host console")
    parser.add_argument("--listen", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=30444)
    parser.add_argument("--tls-cert", required=True)
    parser.add_argument("--tls-key", required=True)
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--shell", default="/bin/bash")
    # Points the restart/power off endpoints at a stand-in, which is how they are tested
    # without taking the machine down.
    parser.add_argument("--systemctl", default="/usr/bin/systemctl")
    args = parser.parse_args()

    Handler.token = read_token(args.token_file)
    Handler.shell = args.shell
    Handler.systemctl = args.systemctl
    httpd = QuietServer((args.listen, args.port), Handler)
    httpd.daemon_threads = True
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.tls_cert, args.tls_key)
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    log(f"listening on wss://{args.listen}:{args.port}/ws (shell: {args.shell})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
