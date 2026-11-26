"""Managed background process registry inside the sandbox (D-241 Step 2).

Each process runs in its own session (`start_new_session=True`) so stopping it
signals the entire process group (including dev-server children) instead of
orphaning grandchildren. Output is captured into a bounded per-process ring
buffer with monotonic byte offsets so callers can stream incremental logs
without unbounded memory growth.

Per-`botId` scoping here is a guardrail against a confused bot, never a
security boundary: `shell` runs as the same `bot` UID inside the container.
"""

from __future__ import annotations

import collections
import os
import signal
import subprocess
import threading
import time
import uuid
from typing import Callable

MAX_RUNNING_PROCESSES = 8
MAX_RETAINED_PROCESSES = 32
EXITED_RETENTION_S = 600.0
MAX_BUFFER_BYTES = 512 * 1024
DEFAULT_MAX_DURATION_S = 1800
MIN_MAX_DURATION_S = 10
MAX_MAX_DURATION_S = 3600
MAX_WAIT_MS = 30_000
STOP_GRACE_S = 3.0
READ_CHUNK_BYTES = 16 * 1024
TAIL_ON_STOP_BYTES = 8 * 1024


class ProcessError(RuntimeError):
    """A bounded managed-process refusal that should be reported to the caller."""

    def __init__(self, message: str, *, code: str = "PROCESS_FAILED") -> None:
        super().__init__(message)
        self.code = code


class ProcessLimitError(ProcessError):
    """The machine already holds the maximum number of live managed processes."""

    def __init__(self, running: int, limit: int) -> None:
        super().__init__(
            f"this computer already has {running} running background processes (limit {limit}); "
            "stop one with process_stop before starting another",
            code="PROCESS_LIMIT",
        )


def _exit_code_of(returncode: int) -> int:
    return 128 - returncode if returncode < 0 else returncode


def _group_alive(pgid: int) -> bool:
    """Whether any process is still in the group `start_new_session` created."""
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    except OSError:
        return True
    return True


class _ManagedProcess:
    def __init__(
        self,
        *,
        process_id: str,
        bot_id: str,
        run_id: str | None,
        command: str,
        cwd: str,
        proc: subprocess.Popen[bytes],
        max_duration_s: float,
        max_buffer_bytes: int,
        stop_grace_s: float,
    ) -> None:
        self.process_id = process_id
        self.bot_id = bot_id
        self.run_id = run_id
        self.command = command
        self.cwd = cwd
        self.proc = proc
        self.max_duration_s = max_duration_s
        self.max_buffer_bytes = max_buffer_bytes
        self.stop_grace_s = stop_grace_s

        now_wall = time.time()
        now_mono = time.monotonic()
        self.started_at_wall = now_wall
        self.started_at_mono = now_mono
        self.expires_at_wall = now_wall + max_duration_s
        self.expires_at_mono = now_mono + max_duration_s

        self.condition = threading.Condition()
        self._chunks: collections.deque[bytes] = collections.deque()
        self._buffered_bytes = 0
        self.total_bytes = 0
        self.dropped_bytes = 0
        self.status = "running"
        self.exit_code: int | None = None
        self.stop_reason: str | None = None
        self.finished_at_mono: float | None = None
        self._terminating = False

        self._ttl_timer = threading.Timer(max_duration_s, self._on_ttl_expired)
        self._ttl_timer.daemon = True
        self._ttl_timer.start()

        self._pump = threading.Thread(
            target=self._run_pump,
            name=f"proc-pump-{process_id}",
            daemon=True,
        )
        self._pump.start()

    def _on_ttl_expired(self) -> None:
        self.terminate(reason="timeout")

    def _append(self, chunk: bytes) -> None:
        if not chunk:
            return
        with self.condition:
            self._chunks.append(chunk)
            self._buffered_bytes += len(chunk)
            self.total_bytes += len(chunk)
            while self._buffered_bytes > self.max_buffer_bytes and self._chunks:
                excess = self._buffered_bytes - self.max_buffer_bytes
                oldest = self._chunks.popleft()
                if len(oldest) <= excess:
                    self._buffered_bytes -= len(oldest)
                    self.dropped_bytes += len(oldest)
                else:
                    self._chunks.appendleft(oldest[excess:])
                    self._buffered_bytes -= excess
                    self.dropped_bytes += excess
            self.condition.notify_all()

    def _run_pump(self) -> None:
        stream = self.proc.stdout
        try:
            if stream is not None:
                while True:
                    chunk = (
                        stream.read1(READ_CHUNK_BYTES)
                        if hasattr(stream, "read1")
                        else stream.read(READ_CHUNK_BYTES)
                    )
                    if not chunk:
                        break
                    self._append(chunk)
        except OSError:
            pass
        finally:
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
            returncode = self.proc.wait()
            self._ttl_timer.cancel()
            with self.condition:
                self.status = "exited"
                self.exit_code = _exit_code_of(returncode)
                self.finished_at_mono = time.monotonic()
                self.condition.notify_all()

    def terminate(self, *, reason: str) -> None:
        with self.condition:
            if self.status == "exited":
                return
            if self.stop_reason is None:
                self.stop_reason = reason
            if self._terminating:
                already_stopping = True
            else:
                self._terminating = True
                already_stopping = False
        if already_stopping:
            self._pump.join(timeout=self.stop_grace_s + 1.0)
            return

        self._ttl_timer.cancel()
        pid = self.proc.pid
        try:
            os.killpg(pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            pass

        # Wait for the whole group, not just `bash`: a dev server's child that
        # handles SIGTERM slowly (or ignores it) outlives the shell, and
        # judging by `bash` alone would skip SIGKILL and leave it serving.
        deadline = time.monotonic() + self.stop_grace_s
        while time.monotonic() < deadline and (
            self.proc.poll() is None or _group_alive(pid)
        ):
            time.sleep(0.05)
        if self.proc.poll() is None or _group_alive(pid):
            try:
                os.killpg(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError, OSError):
                pass
            try:
                self.proc.wait(timeout=2.0)
            except subprocess.TimeoutExpired:
                pass
        self._pump.join(timeout=2.0)

    def _slice_locked(self, offset: int) -> tuple[bytes, int, bool]:
        clamped = max(0, offset)
        truncated = clamped < self.dropped_bytes
        rel_start = max(0, clamped - self.dropped_bytes)
        if rel_start >= self._buffered_bytes:
            return b"", self.total_bytes, truncated
        raw = b"".join(self._chunks)
        return raw[rel_start:], self.total_bytes, truncated

    def snapshot_locked(self) -> dict[str, object]:
        now_mono = time.monotonic()
        elapsed_ms = int(
            ((self.finished_at_mono or now_mono) - self.started_at_mono) * 1000
        )
        remaining_s = (
            max(0, int(round(self.expires_at_mono - now_mono)))
            if self.status == "running"
            else 0
        )
        return {
            "processId": self.process_id,
            "botId": self.bot_id,
            "runId": self.run_id,
            "command": self.command,
            "cwd": self.cwd,
            "status": self.status,
            "exitCode": self.exit_code,
            "stopReason": self.stop_reason,
            "startedAtMs": int(self.started_at_wall * 1000),
            "expiresAtMs": int(self.expires_at_wall * 1000),
            "maxDurationSec": int(round(self.max_duration_s)),
            "remainingSec": remaining_s,
            "elapsedMs": max(0, elapsed_ms),
            "totalBytes": self.total_bytes,
            "droppedBytes": self.dropped_bytes,
        }

    def snapshot(self) -> dict[str, object]:
        with self.condition:
            return self.snapshot_locked()

    def read_output(self, *, offset: int = 0, wait_ms: int = 0) -> dict[str, object]:
        clamped_offset = max(0, offset)
        wait_s = min(max(0, wait_ms), MAX_WAIT_MS) / 1000.0
        deadline = time.monotonic() + wait_s
        with self.condition:
            while self.status == "running" and self.total_bytes <= clamped_offset:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.condition.wait(timeout=remaining)
            data, next_offset, truncated = self._slice_locked(clamped_offset)
            snap = self.snapshot_locked()
        return {
            **snap,
            "output": data.decode("utf-8", errors="replace"),
            "offset": clamped_offset,
            "nextOffset": next_offset,
            "truncated": truncated,
        }

    def tail_output(self, max_bytes: int = TAIL_ON_STOP_BYTES) -> dict[str, object]:
        with self.condition:
            start = max(self.dropped_bytes, self.total_bytes - max_bytes)
            data, next_offset, truncated = self._slice_locked(start)
            snap = self.snapshot_locked()
        return {
            **snap,
            "output": data.decode("utf-8", errors="replace"),
            "offset": start,
            "nextOffset": next_offset,
            "truncated": truncated,
        }


class ProcessRegistry:
    """In-container table of live and recently exited managed processes."""

    def __init__(
        self,
        *,
        max_running: int = MAX_RUNNING_PROCESSES,
        max_retained: int = MAX_RETAINED_PROCESSES,
        max_buffer_bytes: int = MAX_BUFFER_BYTES,
        exited_retention_s: float = EXITED_RETENTION_S,
        stop_grace_s: float = STOP_GRACE_S,
        popen: Callable[..., subprocess.Popen[bytes]] = subprocess.Popen,
    ) -> None:
        self._lock = threading.Lock()
        self._entries: dict[str, _ManagedProcess] = {}
        self._max_running = max_running
        self._max_retained = max_retained
        self._max_buffer_bytes = max_buffer_bytes
        self._exited_retention_s = exited_retention_s
        self._stop_grace_s = stop_grace_s
        self._popen = popen

    def _prune_locked(self) -> None:
        now = time.monotonic()
        stale = [
            pid
            for pid, entry in self._entries.items()
            if entry.finished_at_mono is not None
            and (now - entry.finished_at_mono) >= self._exited_retention_s
        ]
        for pid in stale:
            self._entries.pop(pid, None)
        if len(self._entries) > self._max_retained:
            exited = sorted(
                (
                    (entry.finished_at_mono or 0.0, pid)
                    for pid, entry in self._entries.items()
                    if entry.finished_at_mono is not None
                ),
            )
            for _, pid in exited:
                if len(self._entries) <= self._max_retained:
                    break
                self._entries.pop(pid, None)

    def start(
        self,
        *,
        bot_id: str,
        command: str,
        cwd: str,
        env: dict[str, str] | None = None,
        run_id: str | None = None,
        max_duration_s: float = DEFAULT_MAX_DURATION_S,
    ) -> dict[str, object]:
        os.makedirs(cwd, exist_ok=True)
        merged_env = {**os.environ, **(env or {})}
        # Count, spawn and record under one lock: the bridge serves requests on
        # threads, and two starts that both counted before either was recorded
        # would together pass the limit.
        with self._lock:
            self._prune_locked()
            running = sum(
                1 for entry in self._entries.values() if entry.status == "running"
            )
            if running >= self._max_running:
                raise ProcessLimitError(running, self._max_running)
            try:
                proc = self._popen(
                    ["bash", "-lc", command],
                    cwd=cwd,
                    env=merged_env,
                    stdin=subprocess.DEVNULL,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    start_new_session=True,
                )
            except OSError as exc:
                raise ProcessError(f"could not start process: {exc}") from exc

            process_id = f"proc-{uuid.uuid4().hex[:12]}"
            entry = _ManagedProcess(
                process_id=process_id,
                bot_id=bot_id,
                run_id=run_id,
                command=command,
                cwd=cwd,
                proc=proc,
                max_duration_s=max_duration_s,
                max_buffer_bytes=self._max_buffer_bytes,
                stop_grace_s=self._stop_grace_s,
            )
            self._entries[process_id] = entry
        return entry.snapshot()

    def list(self, bot_id: str) -> list[dict[str, object]]:
        with self._lock:
            self._prune_locked()
            entries = [
                entry for entry in self._entries.values() if entry.bot_id == bot_id
            ]
        entries.sort(key=lambda e: e.started_at_mono)
        return [entry.snapshot() for entry in entries]

    def read_output(
        self,
        bot_id: str,
        process_id: str,
        *,
        offset: int = 0,
        wait_ms: int = 0,
    ) -> dict[str, object] | None:
        with self._lock:
            self._prune_locked()
            entry = self._entries.get(process_id)
            if entry is None or entry.bot_id != bot_id:
                return None
        return entry.read_output(offset=offset, wait_ms=wait_ms)

    def stop(
        self,
        bot_id: str,
        process_id: str,
        *,
        reason: str = "stopped",
    ) -> dict[str, object] | None:
        with self._lock:
            entry = self._entries.get(process_id)
            if entry is None or entry.bot_id != bot_id:
                return None
        entry.terminate(reason=reason)
        return entry.tail_output()

    def stop_run(self, bot_id: str, run_id: str) -> list[str]:
        with self._lock:
            targets = [
                entry
                for entry in self._entries.values()
                if entry.bot_id == bot_id
                and entry.run_id == run_id
                and entry.status == "running"
            ]
        stopped: list[str] = []
        for entry in targets:
            entry.terminate(reason="cancelled")
            stopped.append(entry.process_id)
        return stopped

    def close_all(self) -> None:
        with self._lock:
            entries = list(self._entries.values())
        for entry in entries:
            entry.terminate(reason="shutdown")
