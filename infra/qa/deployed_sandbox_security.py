#!/usr/bin/env python3
"""M2-QA-06 acceptance probe for the provisioned Linux Docker host.

Run this as root only after ``agent-egress.py`` has installed the policy for
the sandbox network and a reachable PostgreSQL listener is published on the
host. The probe creates one disposable production-constrained sandbox and
removes it even when an assertion fails.
"""

import argparse
import json
import os
import platform
import socket
import subprocess
import sys
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


def run(*args, check=True, timeout=60):
    return subprocess.run(
        args,
        check=check,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


def docker(*args, **kwargs):
    return run("docker", *args, **kwargs)


def network_details(network):
    result = json.loads(docker("network", "inspect", network).stdout)[0]
    if result["Driver"] != "bridge":
        raise RuntimeError(f"{network} is {result['Driver']!r}, not a local bridge")
    bridge = (result.get("Options") or {}).get("com.docker.network.bridge.name")
    bridge = bridge or "br-" + result["Id"][:12]
    gateway = result["IPAM"]["Config"][0]["Gateway"]
    return bridge, gateway


def assert_policy_hook(binary, bridge):
    chain = "CREWAID-" + bridge
    result = run(
        binary,
        "-w", "10",
        "-t", "mangle",
        "-C", "PREROUTING",
        "-i", bridge,
        "-j", chain,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"{binary} has no {chain} hook for {bridge}; install agent-egress.py first"
        )


def drop_packets(bridge):
    chain = "CREWAID-" + bridge
    result = run("iptables", "-w", "10", "-t", "mangle", "-nvxL", chain)
    total = 0
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) >= 3 and fields[2] == "DROP" and fields[0].isdigit():
            total += int(fields[0])
    return total


def wait_for_health(container, timeout_seconds=60):
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
            return
        last = result.stderr.strip()
        time.sleep(0.25)
    raise RuntimeError(f"sandbox did not become healthy: {last}")


def assert_host_listener(host, port):
    try:
        with socket.create_connection((host, port), timeout=2):
            return
    except OSError as error:
        raise RuntimeError(
            f"no reachable PostgreSQL positive control at {host}:{port}: {error}"
        ) from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", default="crewaid/sandbox:dev")
    parser.add_argument("--network", default="agent-net")
    parser.add_argument("--postgres-port", type=int, default=5432)
    args = parser.parse_args()

    if platform.system() != "Linux" or os.geteuid() != 0:
        parser.error("run as root on the Linux Docker daemon host")
    if not 1 <= args.postgres_port <= 65535:
        parser.error("--postgres-port must be between 1 and 65535")

    bridge, gateway = network_details(args.network)
    assert_host_listener(gateway, args.postgres_port)
    assert_policy_hook("iptables", bridge)
    assert_policy_hook("ip6tables", bridge)
    before_drops = drop_packets(bridge)

    container = "crewaid-qa06-" + uuid.uuid4().hex[:10]
    result = None
    try:
        docker(
            "run", "--detach",
            "--name", container,
            "--network", args.network,
            "--label", "crewaid.qa=M2-QA-06",
            *LIMITS,
            args.image,
            timeout=90,
        )
        wait_for_health(container)

        inspected = json.loads(docker("inspect", container).stdout)[0]
        if inspected["Mounts"] != [] or inspected["HostConfig"]["Binds"] is not None:
            raise AssertionError("sandbox unexpectedly has a host or volume mount")

        socket_probe = docker(
            "exec", container, "bash", "-lc",
            "test ! -e /var/run/docker.sock && "
            "! curl -fsS --max-time 2 --unix-socket /var/run/docker.sock http://localhost/_ping",
            check=False,
            timeout=5,
        )
        if socket_probe.returncode != 0:
            raise AssertionError("the sandbox can see or reach /var/run/docker.sock")

        postgres_probe = docker(
            "exec", container, "python3", "-c",
            "import socket,sys; s=socket.socket(); s.settimeout(2); "
            "s.connect((sys.argv[1],int(sys.argv[2])))",
            gateway, str(args.postgres_port),
            check=False,
            timeout=5,
        )
        if postgres_probe.returncode == 0:
            raise AssertionError("the sandbox connected to the host PostgreSQL port")

        # Keep the PRD's literal curl path in the acceptance test as well as the
        # unambiguous socket connect above. A timeout is the expected DROP result.
        curl_probe = docker(
            "exec", container,
            "curl", "-sS", "--connect-timeout", "2", "--max-time", "2",
            f"telnet://{gateway}:{args.postgres_port}",
            check=False,
            timeout=5,
        )
        if curl_probe.returncode == 0:
            raise AssertionError("curl unexpectedly reached the host PostgreSQL port")

        public_probe = docker(
            "exec", container,
            "curl", "-4fsS", "--connect-timeout", "10", "--max-time", "30",
            "-o", "/dev/null", "https://example.com/",
            check=False,
            timeout=35,
        )
        if public_probe.returncode != 0:
            raise AssertionError(
                "public HTTPS/Docker DNS positive control failed: " + public_probe.stderr.strip()
            )

        after_drops = drop_packets(bridge)
        if after_drops <= before_drops:
            raise AssertionError("the PostgreSQL probe did not increment the firewall DROP counter")

        result = {
            "result": "PASS",
            "task": "M2-QA-06",
            "image": args.image,
            "network": args.network,
            "bridge": bridge,
            "postgres": {
                "host_positive_control": "reachable",
                "sandbox_socket_connect": "blocked",
                "sandbox_curl": "blocked",
            },
            "docker_socket": "absent and unreachable",
            "public_https_and_dns": "reachable",
            "firewall_drop_counter_delta": after_drops - before_drops,
        }
    finally:
        docker("rm", "--force", container, check=False)
        if docker("inspect", container, check=False).returncode == 0:
            raise RuntimeError(f"cleanup left sandbox container {container}")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
