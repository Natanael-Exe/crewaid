#!/usr/bin/env python3

import importlib.util
import json
import os
import pathlib
import sys
import tempfile
import threading
import time
import unittest
from http.client import HTTPConnection

BRIDGE_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

import processes as proc_mod

BRIDGE_SPEC = importlib.util.spec_from_file_location(
    "crewaid_agent_bridge_proc_test", BRIDGE_DIR / "bridge.py"
)
assert BRIDGE_SPEC is not None and BRIDGE_SPEC.loader is not None
bridge = importlib.util.module_from_spec(BRIDGE_SPEC)
BRIDGE_SPEC.loader.exec_module(bridge)


class ProcessRegistryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.cwd = self.tmp.name

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_start_stream_incremental_output_and_exit_code(self) -> None:
        reg = proc_mod.ProcessRegistry()
        try:
            started = reg.start(
                bot_id="bot-a",
                run_id="run-1",
                command="printf 'first\\n'; sleep 0.08; printf 'second\\n'; exit 3",
                cwd=self.cwd,
            )
            pid = str(started["processId"])
            first = reg.read_output("bot-a", pid, offset=0, wait_ms=2000)
            self.assertIsNotNone(first)
            assert first is not None
            self.assertIn("first\n", str(first["output"]))

            collected = str(first["output"])
            offset = int(first["nextOffset"])
            deadline = time.monotonic() + 3.0
            final = first
            while final["status"] == "running" and time.monotonic() < deadline:
                final = reg.read_output("bot-a", pid, offset=offset, wait_ms=1000)
                assert final is not None
                collected += str(final["output"])
                offset = int(final["nextOffset"])

            self.assertEqual(final["status"], "exited")
            self.assertEqual(final["exitCode"], 3)
            self.assertEqual(collected, "first\nsecond\n")
        finally:
            reg.close_all()

    def test_ring_buffer_caps_memory_and_flags_truncation(self) -> None:
        reg = proc_mod.ProcessRegistry(max_buffer_bytes=64)
        try:
            started = reg.start(
                bot_id="bot-a",
                command="python3 -c \"print('A' * 100 + 'B' * 30, end='')\"",
                cwd=self.cwd,
            )
            pid = str(started["processId"])
            res = reg.read_output("bot-a", pid, offset=0, wait_ms=2000)
            assert res is not None
            while res["status"] == "running":
                res = reg.read_output("bot-a", pid, offset=int(res["nextOffset"]), wait_ms=1000)
                assert res is not None

            full = reg.read_output("bot-a", pid, offset=0, wait_ms=0)
            assert full is not None
            self.assertTrue(full["truncated"])
            self.assertEqual(full["totalBytes"], 130)
            self.assertEqual(full["droppedBytes"], 66)
            self.assertEqual(len(str(full["output"])), 64)
            self.assertTrue(str(full["output"]).endswith("B" * 30))

            untouched = reg.read_output("bot-a", pid, offset=int(full["droppedBytes"]), wait_ms=0)
            assert untouched is not None
            self.assertFalse(untouched["truncated"])
        finally:
            reg.close_all()

    def test_stop_kills_entire_process_group_including_background_children(self) -> None:
        reg = proc_mod.ProcessRegistry(stop_grace_s=0.5)
        pid_file = pathlib.Path(self.cwd) / "child.pid"
        try:
            started = reg.start(
                bot_id="bot-a",
                command=f"sleep 60 & echo $! > {pid_file}; wait",
                cwd=self.cwd,
            )
            deadline = time.monotonic() + 2.0
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            child_pid = int(pid_file.read_text().strip())
            os.kill(child_pid, 0)  # Child is alive before stop.

            stopped = reg.stop("bot-a", str(started["processId"]))
            assert stopped is not None
            self.assertEqual(stopped["status"], "exited")
            self.assertEqual(stopped["stopReason"], "stopped")

            # Child in the same process group must be gone too.
            time.sleep(0.05)
            with self.assertRaises(ProcessLookupError):
                os.kill(child_pid, 0)
        finally:
            reg.close_all()

    def test_stop_kills_a_child_that_ignores_sigterm_after_the_shell_exits(self) -> None:
        reg = proc_mod.ProcessRegistry(stop_grace_s=0.5)
        pid_file = pathlib.Path(self.cwd) / "stubborn.pid"
        try:
            # The shell dies on SIGTERM at once; the child ignores it and would
            # keep serving if stop judged by the shell alone.
            started = reg.start(
                bot_id="bot-a",
                command=f"(trap '' TERM; exec sleep 60) & echo $! > {pid_file}; wait",
                cwd=self.cwd,
            )
            deadline = time.monotonic() + 2.0
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            child_pid = int(pid_file.read_text().strip())

            stopped = reg.stop("bot-a", str(started["processId"]))
            assert stopped is not None
            self.assertEqual(stopped["status"], "exited")

            deadline = time.monotonic() + 2.0
            while time.monotonic() < deadline:
                try:
                    os.kill(child_pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.02)
            with self.assertRaises(ProcessLookupError):
                os.kill(child_pid, 0)
        finally:
            reg.close_all()

    def test_a_read_past_all_output_waits_for_exit_and_returns_no_bytes(self) -> None:
        # The orchestrator's exit watcher reads this way so a chatty dev server's
        # logs never cross the bridge just to learn whether it is still running.
        reg = proc_mod.ProcessRegistry()
        try:
            started = reg.start(
                bot_id="bot-a",
                command="for i in 1 2 3; do echo noisy; sleep 0.05; done; exit 4",
                cwd=self.cwd,
            )
            res = reg.read_output(
                "bot-a", str(started["processId"]), offset=2**53, wait_ms=5000
            )
            assert res is not None
            self.assertEqual(res["status"], "exited")
            self.assertEqual(res["exitCode"], 4)
            self.assertEqual(res["output"], "")
        finally:
            reg.close_all()

    def test_stop_run_stops_only_cancelled_run_and_keeps_completed_turn_processes(self) -> None:
        reg = proc_mod.ProcessRegistry(stop_grace_s=0.5)
        try:
            dev_server = reg.start(
                bot_id="bot-a",
                run_id="run-completed",
                command="sleep 60",
                cwd=self.cwd,
            )
            load_test = reg.start(
                bot_id="bot-a",
                run_id="run-cancelled",
                command="sleep 60",
                cwd=self.cwd,
            )

            stopped_ids = reg.stop_run("bot-a", "run-cancelled")
            self.assertEqual(stopped_ids, [load_test["processId"]])

            dev_state = reg.read_output("bot-a", str(dev_server["processId"]), wait_ms=0)
            load_state = reg.read_output("bot-a", str(load_test["processId"]), wait_ms=0)
            assert dev_state is not None and load_state is not None
            self.assertEqual(dev_state["status"], "running")
            self.assertEqual(load_state["status"], "exited")
            self.assertEqual(load_state["stopReason"], "cancelled")
        finally:
            reg.close_all()

    def test_bot_scoping_concurrency_cap_and_ttl_expiry(self) -> None:
        reg = proc_mod.ProcessRegistry(max_running=2, stop_grace_s=0.3)
        try:
            p1 = reg.start(bot_id="bot-a", command="sleep 60", cwd=self.cwd, max_duration_s=0.25)
            p2 = reg.start(bot_id="bot-a", command="sleep 60", cwd=self.cwd, max_duration_s=60)

            self.assertIsNone(reg.read_output("bot-b", str(p1["processId"])))
            self.assertIsNone(reg.stop("bot-b", str(p1["processId"])))

            with self.assertRaises(proc_mod.ProcessLimitError):
                reg.start(bot_id="bot-a", command="sleep 60", cwd=self.cwd)

            # Wait for p1's short TTL to fire and auto-stop it.
            res = reg.read_output("bot-a", str(p1["processId"]), offset=0, wait_ms=2000)
            assert res is not None
            self.assertEqual(res["status"], "exited")
            self.assertEqual(res["stopReason"], "timeout")

            # After p1 expired, a new process is admitted again.
            p3 = reg.start(bot_id="bot-a", command="echo ok", cwd=self.cwd)
            self.assertIn("processId", p3)
            self.assertIsNotNone(reg.stop("bot-a", str(p2["processId"])))
        finally:
            reg.close_all()


class ProcessBridgeHttpTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.original_registry = bridge.PROCESSES
        bridge.PROCESSES = proc_mod.ProcessRegistry(stop_grace_s=0.3)
        self.server = bridge.BridgeServer(("127.0.0.1", 0), bridge.BridgeHandler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        bridge.PROCESSES.close_all()
        bridge.PROCESSES = self.original_registry
        self.tmp.cleanup()

    def _req(self, method: str, path: str, body: dict | None = None, headers: dict | None = None):
        conn = HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        hdrs = dict(headers or {})
        payload = None
        if body is not None:
            payload = json.dumps(body).encode()
            hdrs["Content-Type"] = "application/json"
        conn.request(method, path, body=payload, headers=hdrs)
        resp = conn.getresponse()
        data = json.loads(resp.read().decode())
        conn.close()
        return resp.status, data

    def test_http_lifecycle_and_origin_refusal(self) -> None:
        status, data = self._req(
            "POST",
            "/processes",
            {"botId": "bot-1", "command": "echo hi", "cwd": self.tmp.name},
            headers={"Origin": "https://evil.example"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(data["code"], "BROWSER_REQUEST_REFUSED")

        status, started = self._req(
            "POST",
            "/processes",
            {"botId": "bot-1", "runId": "run-7", "command": "echo hello; sleep 30", "cwd": self.tmp.name},
        )
        self.assertEqual(status, 200)
        pid = started["process"]["processId"]

        status, listed = self._req("GET", "/processes?botId=bot-1")
        self.assertEqual(status, 200)
        self.assertEqual(len(listed["processes"]), 1)

        # A login shell can take a while to print on a loaded machine; keep
        # reading rather than betting the whole test on one 2s window.
        output = ""
        deadline = time.monotonic() + 10.0
        while "hello" not in output and time.monotonic() < deadline:
            status, out = self._req("GET", f"/processes/{pid}?botId=bot-1&offset=0&waitMs=2000")
            self.assertEqual(status, 200)
            output = out["process"]["output"]
        self.assertIn("hello", output)

        status, run_stop = self._req("POST", "/processes/stop-run", {"botId": "bot-1", "runId": "run-7"})
        self.assertEqual(status, 200)
        self.assertEqual(run_stop["stopped"], [pid])

        status, missing = self._req("GET", "/processes/proc-unknown?botId=bot-1")
        self.assertEqual(status, 404)
        self.assertEqual(missing["code"], "NO_SUCH_PROCESS")


if __name__ == "__main__":
    unittest.main()
