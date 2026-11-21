#!/usr/bin/env python3
"""
M1-FE-02 · Probe the FREE HeroUI MCP server for the real v3 component index.

Why this exists: D-001 says we compose the chat surface from free primitives.
Before writing a single component I need the ACTUAL free component list, not a
recalled one -- @heroui/react v3 is new enough that training-data recall is wrong.

Server: npx -y @heroui/react-mcp@latest  (stdio, free tier -- NOT mcp.heroui.pro)
Speaks MCP over stdio JSON-RPC: initialize -> initialized -> tools/list -> call.
"""
import json
import subprocess
import sys
import threading
import queue

CMD = ["npx", "-y", "@heroui/react-mcp@latest"]


class StdioMCP:
    def __init__(self, cmd):
        self.p = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._id = 0
        self.q = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()
        threading.Thread(target=self._draining_stderr, daemon=True).start()

    def _reader(self):
        for line in self.p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.q.put(json.loads(line))
            except json.JSONDecodeError:
                pass  # server banner / non-protocol noise

    def _draining_stderr(self):
        for line in self.p.stderr:
            if any(k in line.lower() for k in ("error", "cannot", "not found", "denied")):
                print(f"[stderr] {line.rstrip()}", file=sys.stderr)

    def _send(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()

    def request(self, method, params=None, timeout=180):
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline_msgs = []
        while True:
            try:
                msg = self.q.get(timeout=timeout)
            except queue.Empty:
                raise TimeoutError(f"{method} timed out; saw {len(deadline_msgs)} other msgs")
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"{method} -> {msg['error']}")
                return msg.get("result")
            deadline_msgs.append(msg)

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})


def main():
    m = StdioMCP(CMD)
    init = m.request(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "crewaid-m1-fe-02", "version": "0.0.0"},
        },
    )
    print("=== SERVER ===")
    print(json.dumps(init.get("serverInfo", {}), indent=2))
    m.notify("notifications/initialized")

    tools = m.request("tools/list").get("tools", [])
    print(f"\n=== TOOLS ({len(tools)}) ===")
    for t in tools:
        desc = (t.get("description") or "").strip().splitlines()
        first = desc[0] if desc else ""
        print(f"- {t['name']}: {first[:150]}")
        schema = t.get("inputSchema", {})
        props = schema.get("properties", {})
        if props:
            req = set(schema.get("required", []))
            args = ", ".join(f"{k}{'*' if k in req else ''}" for k in props)
            print(f"    args: {args}")

    with open("/tmp/heroui_tools.json", "w") as f:
        json.dump(tools, f, indent=2)
    print("\n[saved tool list -> /tmp/heroui_tools.json]")

    # Find and call whatever lists components.
    lister = next(
        (
            t["name"]
            for t in tools
            if any(k in t["name"].lower() for k in ("list_components", "components", "list"))
        ),
        None,
    )
    if lister:
        print(f"\n=== CALLING {lister} ===")
        res = m.request("tools/call", {"name": lister, "arguments": {}})
        for c in res.get("content", []):
            if c.get("type") == "text":
                print(c["text"][:6000])
        with open("/tmp/heroui_components.json", "w") as f:
            json.dump(res, f, indent=2)
        print("\n[saved -> /tmp/heroui_components.json]")


if __name__ == "__main__":
    main()
