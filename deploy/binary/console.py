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

WHAT IT DOES NOT DO: it does not authenticate a *user* - there are no users on this model.
It requires a per-machine token (see --token-file) so a port scanner or a random web page
cannot open a root shell, and it refuses a cross-origin handshake. Anyone who can read the
token can have root, which is exactly as strong as the dashboard itself: its kubeconfig is
cluster-admin and it has no login either.

SAFE: the token is compared in constant time, the handshake is size-limited, a shell is
fenced by its own process group, and the service is restarted by systemd if it dies.
"""
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
import signal
import socket
import ssl
import struct
import subprocess
import sys
import termios
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
OP_CONT, OP_TEXT, OP_BIN, OP_CLOSE, OP_PING, OP_PONG = 0x0, 0x1, 0x2, 0x8, 0x9, 0xA


def log(message: str) -> None:
    print(f"kubeos-console: {message}", flush=True)


def read_token(path: str) -> str:
    with open(path, "r", encoding="utf-8") as handle:
        token = handle.read().strip()
    if len(token) < 16:
        raise SystemExit(f"the token in {path} is too short to be a secret")
    return token


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


# ---- HTTP/WebSocket entry point ------------------------------------------


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "kubeos-console"
    timeout = 30

    # set on the class by main() so the handler can reach the configuration
    token = ""
    shell = "/bin/bash"

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
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self) -> None:  # noqa: N802 - http.server naming
        path = urlparse(self.path).path
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
    httpd = ThreadingHTTPServer((args.listen, args.port), Handler)
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
