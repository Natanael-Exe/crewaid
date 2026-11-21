#!/usr/bin/env python3
"""Measure six production-constrained sandbox desktops for M2-QA-09."""

import argparse
import concurrent.futures
import datetime
import json
import os
import pathlib
import platform
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time
import uuid


LIMITS = (
    "--memory", "2g",
    "--memory-swap", "2g",
    "--cpus", "1.0",
    "--pids-limit", "512",
    "--security-opt", "no-new-privileges",
    "--cap-drop", "ALL",
    "--tmpfs", "/dev/shm:size=512m",
    "--restart", "no",
)
WORKLOAD = """
set -eu
mkdir -p /home/bot/qa-measurement
curl -fsS --max-time 10 -X PUT \
  'http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com%2F' >/dev/null
i=0
while [ "$i" -lt "$1" ]; do
  scrot /home/bot/qa-measurement/screen.png
  xdotool mousemove 640 400 click 1
  i=$((i + 1))
  sleep 2
done
""".strip()


def run(*args, check=True, timeout=120):
    return subprocess.run(
        args,
        check=check,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def docker(*args, **kwargs):
    return run("docker", *args, **kwargs)


def bytes_value(value):
    units = {
        "B": 1,
        "kB": 1000,
        "KB": 1000,
        "KiB": 1024,
        "MB": 1000 ** 2,
        "MiB": 1024 ** 2,
        "GB": 1000 ** 3,
        "GiB": 1024 ** 3,
    }
    match = re.fullmatch(r"([0-9.]+)([A-Za-z]+)", value.strip())
    if match is None or match.group(2) not in units:
        raise ValueError(f"cannot parse byte value {value!r}")
    return int(float(match.group(1)) * units[match.group(2)])


def percentile(values, fraction):
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, int(round((len(ordered) - 1) * fraction))))
    return ordered[index]


def wait_for_health(container, started_at, timeout_seconds=60):
    deadline = time.monotonic() + timeout_seconds
    last = ""
    while time.monotonic() < deadline:
        result = docker(
            "exec", container,
            "curl", "-fsS", "--max-time", "2", "http://127.0.0.1:7070/health",
            check=False,
            timeout=5,
        )
        if result.returncode == 0:
            return time.monotonic() - started_at
        last = result.stderr.strip()
        time.sleep(0.2)
    raise RuntimeError(f"{container} did not become healthy: {last}")


def start_and_measure(containers):
    started_at = {}

    def start_one(container):
        started_at[container] = time.monotonic()
        docker("start", container)
        return wait_for_health(container, started_at[container])

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(containers)) as pool:
        futures = {container: pool.submit(start_one, container) for container in containers}
        return {container: future.result() for container, future in futures.items()}


def summarize_times(values):
    milliseconds = [round(value * 1000) for value in values]
    return {
        "individual_ms": milliseconds,
        "p50_ms": round(statistics.median(milliseconds)),
        "p95_ms": percentile(milliseconds, 0.95),
        "max_ms": max(milliseconds),
    }


class StatsSampler:
    def __init__(self, containers):
        self.containers = containers
        self.samples = []
        self.stop_event = threading.Event()
        self.thread = threading.Thread(target=self._sample, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        self.thread.join(timeout=10)

    def _sample(self):
        while not self.stop_event.is_set():
            result = docker(
                "stats", "--no-stream", "--format", "{{json .}}", *self.containers,
                check=False,
                timeout=10,
            )
            if result.returncode == 0:
                rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
                if len(rows) == len(self.containers):
                    self.samples.append({
                        "cpu_percent": sum(float(row["CPUPerc"].rstrip("%")) for row in rows),
                        "memory_bytes": sum(
                            bytes_value(row["MemUsage"].split("/")[0].strip()) for row in rows
                        ),
                        "pids": sum(int(row["PIDs"]) for row in rows),
                    })
            self.stop_event.wait(0.25)


def volume_bytes(volume):
    result = docker(
        "run", "--rm", "--network", "none",
        "--mount", f"type=volume,source={volume},target=/workspace,readonly",
        "alpine:3.22", "du", "-sb", "/workspace",
    )
    return int(result.stdout.split()[0])


def writable_bytes(container):
    return int(docker("inspect", "--size", "--format", "{{.SizeRw}}", container).stdout.strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="crewaid/sandbox:dev")
    parser.add_argument("--network", default="agent-net")
    parser.add_argument("--count", type=int, default=6)
    parser.add_argument("--workload-seconds", type=int, default=60)
    parser.add_argument("--output", type=pathlib.Path)
    args = parser.parse_args()

    if platform.system() != "Linux" or os.geteuid() != 0:
        parser.error("run as root on the Linux Docker daemon host")
    if args.count < 1 or args.workload_seconds < 2:
        parser.error("--count must be positive and --workload-seconds must be at least 2")

    docker("network", "inspect", args.network)
    image = json.loads(docker("image", "inspect", args.image).stdout)[0]
    run_id = uuid.uuid4().hex[:10]
    containers = [f"crewaid-qa09-{run_id}-{index + 1}" for index in range(args.count)]
    volumes = [f"crewaid-workspace-qa09-{run_id}-{index + 1}" for index in range(args.count)]
    disk_before = shutil.disk_usage("/")
    started = time.monotonic()
    sampler = StatsSampler(containers)
    result = None

    try:
        for index, (container, volume) in enumerate(zip(containers, volumes), start=1):
            bot_id = f"qa09-{run_id}-{index}"
            docker(
                "volume", "create",
                "--label", f"crewaid.botId={bot_id}",
                "--label", "crewaid.managedBy=crewaid-orchestrator",
                volume,
            )
            docker(
                "create",
                "--name", container,
                "--network", args.network,
                "--label", "crewaid.qa=M2-QA-09",
                "--label", f"crewaid.sessionId={bot_id}",
                "--label", "crewaid.managedBy=crewaid-orchestrator",
                "--label", f"crewaid.identity={bot_id}",
                "--mount", f"type=volume,source={volume},target=/home/bot",
                *LIMITS,
                args.image,
            )

        sampler.start()
        startup = start_and_measure(containers)
        baseline_volume = sum(volume_bytes(volume) for volume in volumes)
        baseline_writable = sum(writable_bytes(container) for container in containers)

        iterations = max(1, args.workload_seconds // 2)
        workload_started = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(containers)) as pool:
            futures = [
                pool.submit(
                    docker,
                    "exec", container,
                    "bash", "-lc", WORKLOAD, "qa-workload", str(iterations),
                    timeout=args.workload_seconds + 30,
                )
                for container in containers
            ]
            for future in futures:
                future.result()
        workload_elapsed = time.monotonic() - workload_started

        final_volume = sum(volume_bytes(volume) for volume in volumes)
        final_writable = sum(writable_bytes(container) for container in containers)

        with concurrent.futures.ThreadPoolExecutor(max_workers=len(containers)) as pool:
            list(pool.map(lambda name: docker("stop", "--time", "10", name), containers))
        restart = start_and_measure(containers)
        sampler.stop()

        if not sampler.samples:
            raise RuntimeError("docker stats returned no complete samples")
        cpu = [sample["cpu_percent"] for sample in sampler.samples]
        memory = [sample["memory_bytes"] for sample in sampler.samples]
        pids = [sample["pids"] for sample in sampler.samples]
        disk_after = shutil.disk_usage("/")
        result = {
            "result": "PASS",
            "task": "M2-QA-09",
            "measured_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "host": {
                "kernel": platform.release(),
                "architecture": platform.machine(),
                "logical_cpus": os.cpu_count(),
                "memory_bytes": os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES"),
                "disk_total_bytes": disk_before.total,
                "disk_free_before_bytes": disk_before.free,
                "disk_free_after_bytes": disk_after.free,
            },
            "image": {
                "reference": args.image,
                "id": image["Id"],
                "created": image["Created"],
                "size_bytes": image["Size"],
            },
            "sandbox_count": args.count,
            "limits_per_sandbox": {
                "cpus": 1,
                "memory_bytes": 2 * 1024 ** 3,
                "memory_swap_bytes": 2 * 1024 ** 3,
                "pids": 512,
                "shm_bytes": 512 * 1024 ** 2,
            },
            "concurrent_startup": summarize_times(startup.values()),
            "concurrent_restart": summarize_times(restart.values()),
            "representative_workload": {
                "description": "six Chrome sessions load example.com while X11 clicks and screenshots run",
                "target_seconds": args.workload_seconds,
                "elapsed_seconds": round(workload_elapsed, 3),
                "iterations_per_sandbox": iterations,
                "stats_samples": len(sampler.samples),
            },
            "aggregate_runtime": {
                "cpu_percent_mean": round(statistics.fmean(cpu), 2),
                "cpu_percent_p95": round(percentile(cpu, 0.95), 2),
                "cpu_percent_peak": round(max(cpu), 2),
                "memory_bytes_mean": round(statistics.fmean(memory)),
                "memory_bytes_peak": max(memory),
                "pids_peak": max(pids),
            },
            "disk_growth": {
                "workspace_bytes": final_volume - baseline_volume,
                "container_writable_bytes": final_writable - baseline_writable,
                "combined_bytes": (final_volume + final_writable) - (
                    baseline_volume + baseline_writable
                ),
            },
            "total_elapsed_seconds": round(time.monotonic() - started, 3),
        }
    finally:
        sampler.stop()
        for container in containers:
            docker("rm", "--force", container, check=False)
        for volume in volumes:
            docker("volume", "rm", "--force", volume, check=False)
        leftover_containers = [
            container for container in containers
            if docker("inspect", container, check=False).returncode == 0
        ]
        leftovers = docker(
            "volume", "ls", "--quiet", "--filter", f"name=crewaid-workspace-qa09-{run_id}",
            check=False,
        ).stdout.split()
        if leftover_containers or leftovers:
            print(
                "FAIL: cleanup left "
                f"containers={leftover_containers}, workspace volumes={leftovers}",
                file=sys.stderr,
            )
            raise SystemExit(1)
    rendered = json.dumps(result, indent=2) + "\n"
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(rendered)
    print(rendered, end="")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, ValueError, subprocess.SubprocessError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
