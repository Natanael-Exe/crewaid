"""Streaming exec over the bridge's own connection (D-150).

A hosted sandbox provider reaches this machine through a TCP tunnel to the
bridge, and its own exec API — where it has one — is a single request and
response with no stdin, no stream, no environment and no kill. The session's
file I/O needs all four, so the bridge answers them itself.

The route is an HTTP Upgrade on the bridge's port (`POST /exec`,
`Upgrade: crewaid-exec/1`). After the 101 the connection carries frames in both
directions, each one byte of type, four bytes of big-endian length, then the
payload:

    client -> bridge   SPEC (JSON, first and only once), STDIN, STDIN_END, KILL
    bridge -> client   STDOUT, STDERR, EXIT (int32), ERROR (JSON, then close)

A framed byte protocol rather than a WebSocket because neither end needs one:
the bridge is standard-library Python, and the orchestrator already holds a raw
socket to it through the tunnel.

The process runs as whoever runs the bridge — `bot` — which is what
`/skill/run` already does, so this route adds no capability to anyone who can
reach the port. argv is executed directly, never through a shell, and the
caller's environment is merged over the bridge's, exactly as `docker exec`
merges over the container's.
"""

from __future__ import annotations

import json
import os
import signal
import struct
import subprocess
import threading
from typing import BinaryIO, Callable

UPGRADE_TOKEN = "crewaid-exec/1"

SPEC = 0x01
STDIN = 0x02
STDIN_END = 0x03
KILL = 0x04
STDOUT = 0x11
STDERR = 0x12
EXIT = 0x13
ERROR = 0x14

HEADER = struct.Struct(">BI")
# One frame's payload. Output is read in 64 KiB pieces, so only a client could
# send more, and a client that does is not speaking this protocol.
MAX_FRAME_BYTES = 1024 * 1024
READ_CHUNK = 64 * 1024
DRAIN_AFTER_EXIT_S = 2.0

# What `docker exec` reports when the binary is missing or not executable, so
# a caller sees the same exit code whichever provider ran the command.
EXIT_NOT_FOUND = 127
EXIT_NOT_EXECUTABLE = 126


class ProtocolError(ValueError):
    """The client sent something this protocol does not allow."""


def encode_frame(kind: int, payload: bytes = b"") -> bytes:
    if len(payload) > MAX_FRAME_BYTES:
        raise ProtocolError(f"frame of {len(payload)} bytes exceeds {MAX_FRAME_BYTES}")
    return HEADER.pack(kind, len(payload)) + payload


def read_exactly(stream: BinaryIO, length: int) -> bytes | None:
    """`length` bytes, or None when the stream ends at a frame boundary."""
    chunks: list[bytes] = []
    remaining = length
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            if remaining == length:
                return None
            raise ProtocolError("connection closed inside a frame")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream: BinaryIO) -> tuple[int, bytes] | None:
    header = read_exactly(stream, HEADER.size)
    if header is None:
        return None
    kind, length = HEADER.unpack(header)
    if length > MAX_FRAME_BYTES:
        raise ProtocolError(f"frame of {length} bytes exceeds {MAX_FRAME_BYTES}")
    payload = read_exactly(stream, length) if length else b""
    if payload is None:
        raise ProtocolError("connection closed inside a frame")
    return kind, payload


def parse_spec(payload: bytes) -> dict[str, object]:
    """The SPEC frame, validated field by field; unknown fields are refused."""
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ProtocolError(f"SPEC is not JSON: {exc}") from exc
    if not isinstance(value, dict):
        raise ProtocolError("SPEC must be an object")
    unknown = set(value) - {"argv", "cwd", "env", "stdin"}
    if unknown:
        raise ProtocolError(f"SPEC has unknown field(s): {', '.join(sorted(unknown))}")
    argv = value.get("argv")
    if not isinstance(argv, list) or not argv or not all(isinstance(a, str) for a in argv):
        raise ProtocolError("SPEC.argv must be a non-empty list of strings")
    cwd = value.get("cwd")
    if cwd is not None and (not isinstance(cwd, str) or not cwd.startswith("/")):
        raise ProtocolError("SPEC.cwd must be an absolute path")
    env = value.get("env", {})
    if not isinstance(env, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in env.items()
    ):
        raise ProtocolError("SPEC.env must map strings to strings")
    stdin = value.get("stdin", False)
    if not isinstance(stdin, bool):
        raise ProtocolError("SPEC.stdin must be a boolean")
    return {"argv": argv, "cwd": cwd, "env": env, "stdin": stdin}


def exit_code_of(returncode: int) -> int:
    """subprocess reports a signal as -N; a shell and `docker exec` say 128+N."""
    return 128 - returncode if returncode < 0 else returncode


def serve(
    rfile: BinaryIO,
    wfile: BinaryIO,
    popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
) -> None:
    """Run one exec to completion on an already-upgraded connection."""
    write_lock = threading.Lock()
    # Set when EXIT has been written. A pump still holding a pipe a background
    # child kept open must not write after it: the caller has already stopped
    # reading, and a frame after EXIT would be the next request's garbage.
    finished = threading.Event()

    def send(kind: int, payload: bytes = b"") -> bool:
        try:
            with write_lock:
                if finished.is_set():
                    return False
                wfile.write(encode_frame(kind, payload))
                wfile.flush()
            return True
        except (BrokenPipeError, ConnectionResetError, OSError):
            return False

    def fail(code: str, detail: str) -> None:
        send(ERROR, json.dumps({"code": code, "detail": detail}).encode())

    try:
        first = read_frame(rfile)
        if first is None:
            return
        kind, payload = first
        if kind != SPEC:
            raise ProtocolError("the first frame must be SPEC")
        spec = parse_spec(payload)
    except ProtocolError as exc:
        fail("INVALID_EXEC_REQUEST", str(exc))
        return

    env = {**os.environ, **spec["env"]}  # type: ignore[dict-item]
    try:
        process = popen(
            spec["argv"],
            cwd=spec["cwd"],
            env=env,
            stdin=subprocess.PIPE if spec["stdin"] else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # Its own process group, so KILL — or the caller going away — takes
            # down whatever the command started, not only its first process.
            start_new_session=True,
        )
    except (FileNotFoundError, NotADirectoryError) as exc:
        send(STDERR, f"exec: {exc}\n".encode())
        send(EXIT, struct.pack(">i", EXIT_NOT_FOUND))
        return
    except PermissionError as exc:
        send(STDERR, f"exec: {exc}\n".encode())
        send(EXIT, struct.pack(">i", EXIT_NOT_EXECUTABLE))
        return

    def kill_group() -> None:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass

    def pump(source: BinaryIO | None, kind: int) -> None:
        if source is None:
            return
        while True:
            chunk = source.read1(READ_CHUNK) if hasattr(source, "read1") else source.read(READ_CHUNK)
            if not chunk:
                return
            if not send(kind, chunk):
                kill_group()
                return

    def read_client() -> None:
        # Runs until the client closes. A close before the process has exited
        # is an abandoned exec, and an abandoned process is killed rather than
        # left running on a machine nobody is watching.
        try:
            while True:
                frame = read_frame(rfile)
                if frame is None:
                    if process.poll() is None:
                        kill_group()
                    return
                kind, payload = frame
                if kind == STDIN and process.stdin is not None:
                    try:
                        process.stdin.write(payload)
                        process.stdin.flush()
                    except (BrokenPipeError, ValueError):
                        pass
                elif kind == STDIN_END and process.stdin is not None:
                    try:
                        process.stdin.close()
                    except (BrokenPipeError, ValueError):
                        pass
                elif kind == KILL:
                    kill_group()
                else:
                    raise ProtocolError(f"unexpected frame type 0x{kind:02x}")
        except ProtocolError as exc:
            fail("INVALID_EXEC_REQUEST", str(exc))
            kill_group()
        except (ConnectionResetError, OSError):
            kill_group()

    reader = threading.Thread(target=read_client, name="exec-client", daemon=True)
    pumps = [
        threading.Thread(target=pump, args=(process.stdout, STDOUT), daemon=True),
        threading.Thread(target=pump, args=(process.stderr, STDERR), daemon=True),
    ]
    reader.start()
    for thread in pumps:
        thread.start()
    returncode = process.wait()
    # The pipes can outlive the process: a command that backgrounds a child
    # without redirecting it leaves that child holding stdout. Waiting for the
    # pipes to close would hang the caller for the child's whole life, so the
    # process's own exit decides, and the pumps get a bounded moment to drain
    # what it wrote before it went.
    for thread in pumps:
        thread.join(timeout=DRAIN_AFTER_EXIT_S)
    for thread, stream in zip(pumps, (process.stdout, process.stderr)):
        # A pump still running is reading a pipe a background child holds;
        # closing it under that read is not safe, and the child owns it now.
        if not thread.is_alive() and stream is not None:
            stream.close()
    if process.stdin is not None and not process.stdin.closed:
        try:
            process.stdin.close()
        except (BrokenPipeError, ValueError):
            pass
    with write_lock:
        finished.set()
        try:
            wfile.write(encode_frame(EXIT, struct.pack(">i", exit_code_of(returncode))))
            wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
