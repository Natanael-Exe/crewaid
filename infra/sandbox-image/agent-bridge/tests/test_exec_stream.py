#!/usr/bin/env python3
"""`POST /exec` (D-150) over a real bridge server and a raw client socket."""

import importlib.util
import json
import os
import pathlib
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer

BRIDGE_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))
SPEC = importlib.util.spec_from_file_location("crewaid_agent_bridge_exec", BRIDGE_DIR / "bridge.py")
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)

import exec_stream  # noqa: E402  (importable once BRIDGE_DIR is on the path)


class ExecClient:
    """The protocol as a caller speaks it, with nothing borrowed from the bridge
    but the frame constants, so an encoding mistake on one side cannot hide
    behind the same mistake on the other."""

    def __init__(self, port: int, *, upgrade: bool = True, method: str = "POST"):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        headers = f"{method} /exec HTTP/1.1\r\nHost: bridge\r\nContent-Length: 0\r\n"
        if upgrade:
            headers += f"Connection: Upgrade\r\nUpgrade: {exec_stream.UPGRADE_TOKEN}\r\n"
        self.sock.sendall((headers + "\r\n").encode())
        self.buffer = b""
        head = self._until(b"\r\n\r\n")
        self.status = int(head.split(b" ", 2)[1])
        self.head = head.decode("latin-1")

    def _until(self, marker: bytes) -> bytes:
        while marker not in self.buffer:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise AssertionError(f"closed before {marker!r}: {self.buffer!r}")
            self.buffer += chunk
        head, _, self.buffer = self.buffer.partition(marker)
        return head

    def _exactly(self, n: int) -> bytes:
        while len(self.buffer) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise EOFError
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def send(self, kind: int, payload: bytes = b"") -> None:
        self.sock.sendall(struct.pack(">BI", kind, len(payload)) + payload)

    def spec(self, argv, **extra) -> None:
        self.send(exec_stream.SPEC, json.dumps({"argv": argv, **extra}).encode())

    def frame(self):
        kind, length = struct.unpack(">BI", self._exactly(5))
        return kind, self._exactly(length)

    def collect(self):
        """stdout, stderr and the exit code, reading until EXIT or ERROR."""
        out, err = b"", b""
        while True:
            kind, payload = self.frame()
            if kind == exec_stream.STDOUT:
                out += payload
            elif kind == exec_stream.STDERR:
                err += payload
            elif kind == exec_stream.EXIT:
                return out, err, struct.unpack(">i", payload)[0]
            elif kind == exec_stream.ERROR:
                return out, err, json.loads(payload)
            else:
                raise AssertionError(f"unexpected frame 0x{kind:02x}")

    def close(self) -> None:
        self.sock.close()


class ExecStreamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.BridgeHandler)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def open(self, **kwargs) -> ExecClient:
        client = ExecClient(self.port, **kwargs)
        self.addCleanup(client.close)
        return client

    def test_upgrades_and_returns_stdout_and_the_exit_code(self):
        client = self.open()
        self.assertEqual(client.status, 101)
        self.assertIn(exec_stream.UPGRADE_TOKEN, client.head)
        client.spec(["printf", "hello"])
        self.assertEqual(client.collect(), (b"hello", b"", 0))

    def test_keeps_stderr_apart_and_reports_a_failing_exit_code(self):
        client = self.open()
        client.spec(["sh", "-c", "printf out; printf err >&2; exit 3"])
        self.assertEqual(client.collect(), (b"out", b"err", 3))

    def test_round_trips_every_byte_value_through_stdin(self):
        # The write path pipes a file's bytes through stdin and the read path
        # reads them back from stdout, so both must be byte-exact.
        data = bytes(range(256)) * 1024
        client = self.open()
        client.spec(["cat"], stdin=True)
        for offset in range(0, len(data), 60_000):
            client.send(exec_stream.STDIN, data[offset:offset + 60_000])
        client.send(exec_stream.STDIN_END)
        out, err, code = client.collect()
        self.assertEqual((len(out), err, code), (len(data), b"", 0))
        self.assertEqual(out, data)

    def test_passes_the_environment_and_working_directory(self):
        # Paths reach the shell through the environment, never interpolated
        # into the command line, so the variable must arrive intact.
        with tempfile.TemporaryDirectory() as directory:
            client = self.open()
            client.spec(
                ["sh", "-c", 'printf "%s|%s" "$CREWAID_PATH" "$(pwd -P)"'],
                cwd=directory,
                env={"CREWAID_PATH": "/tmp/it's $(not) run"},
            )
            out, _, code = client.collect()
        self.assertEqual(code, 0)
        path, cwd = out.decode().split("|")
        self.assertEqual(path, "/tmp/it's $(not) run")
        self.assertEqual(cwd, str(pathlib.Path(directory).resolve()))

    def test_kill_ends_the_process_with_the_signal_exit_code(self):
        client = self.open()
        client.spec(["sleep", "30"])
        time.sleep(0.2)
        started = time.monotonic()
        client.send(exec_stream.KILL)
        _, _, code = client.collect()
        self.assertEqual(code, 128 + 9)
        self.assertLess(time.monotonic() - started, 5)

    def test_a_caller_that_goes_away_takes_the_process_with_it(self):
        with tempfile.TemporaryDirectory() as directory:
            pid_file = pathlib.Path(directory) / "pid"
            client = self.open()
            client.spec(["sh", "-c", f'echo $$ > "{pid_file}"; exec sleep 30'])
            deadline = time.monotonic() + 5
            while not pid_file.exists() or not pid_file.read_text().strip():
                self.assertLess(time.monotonic(), deadline, "the command never started")
                time.sleep(0.05)
            pid = int(pid_file.read_text())
            client.close()
            deadline = time.monotonic() + 5
            while True:
                try:
                    os.kill(pid, 0)
                except ProcessLookupError:
                    break
                self.assertLess(time.monotonic(), deadline, "the process outlived its caller")
                time.sleep(0.05)

    def test_a_background_child_holding_stdout_does_not_hold_the_exit(self):
        client = self.open()
        started = time.monotonic()
        client.spec(["sh", "-c", "sleep 30 & printf started"])
        out, _, code = client.collect()
        self.assertEqual((out, code), (b"started", 0))
        self.assertLess(time.monotonic() - started, exec_stream.DRAIN_AFTER_EXIT_S + 3)

    def test_a_missing_binary_answers_like_docker_exec(self):
        client = self.open()
        client.spec(["/nonexistent/crewaid-binary"])
        out, err, code = client.collect()
        self.assertEqual((out, code), (b"", exec_stream.EXIT_NOT_FOUND))
        self.assertIn(b"exec:", err)

    def test_refuses_a_spec_with_an_unknown_field(self):
        client = self.open()
        client.spec(["true"], shell=True)
        _, _, error = client.collect()
        self.assertEqual(error["code"], "INVALID_EXEC_REQUEST")
        self.assertIn("shell", error["detail"])

    def test_refuses_a_first_frame_that_is_not_spec(self):
        client = self.open()
        client.send(exec_stream.STDIN, b"early")
        _, _, error = client.collect()
        self.assertEqual(error["code"], "INVALID_EXEC_REQUEST")

    def test_a_plain_post_is_told_to_upgrade(self):
        client = self.open(upgrade=False)
        self.assertEqual(client.status, 426)
        self.assertIn(exec_stream.UPGRADE_TOKEN, client.head)

    def test_get_is_not_allowed(self):
        client = self.open(upgrade=False, method="GET")
        self.assertEqual(client.status, 405)


class FrameCodecTests(unittest.TestCase):
    def test_refuses_an_oversized_frame_in_both_directions(self):
        with self.assertRaises(exec_stream.ProtocolError):
            exec_stream.encode_frame(exec_stream.STDOUT, b"x" * (exec_stream.MAX_FRAME_BYTES + 1))
        import io
        header = struct.pack(">BI", exec_stream.STDIN, exec_stream.MAX_FRAME_BYTES + 1)
        with self.assertRaises(exec_stream.ProtocolError):
            exec_stream.read_frame(io.BytesIO(header))

    def test_maps_a_signal_to_the_shell_exit_code(self):
        self.assertEqual(exec_stream.exit_code_of(-9), 137)
        self.assertEqual(exec_stream.exit_code_of(3), 3)


if __name__ == "__main__":
    unittest.main()
