#!/usr/bin/env python3
"""
M1-FE-02 · Pull real v3 docs for the primitives the M1 composition rests on.

Targets the assumptions that would blow the estimate if wrong:
  TextArea  -> auto-grow built in, or do I hand-roll scrollHeight? (M1-FE-07)
  ListBox   -> sections + arbitrary row content + selection?      (M1-FE-03)
  ScrollShadow, Card, Surface, Chip, Avatar, TagGroup, Autocomplete, Toast
"""
import json
import subprocess
import sys
import threading
import queue

CMD = ["npx", "-y", "@heroui/react-mcp@latest"]
TARGETS = ["TextArea", "ListBox", "ScrollShadow", "TagGroup", "Autocomplete"]


class StdioMCP:
    def __init__(self, cmd):
        self.p = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        self._id = 0
        self.q = queue.Queue()
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        assert self.p.stdout
        for line in self.p.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                self.q.put(json.loads(line))
            except json.JSONDecodeError:
                pass

    def _send(self, obj):
        assert self.p.stdin
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()

    def request(self, method, params=None, timeout=180):
        self._id += 1
        rid = self._id
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        while True:
            try:
                msg = self.q.get(timeout=timeout)
            except queue.Empty:
                raise TimeoutError(method)
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg.get("result")

    def notify(self, method, params=None):
        self._send({"jsonrpc": "2.0", "method": method, "params": params or {}})


def text_of(res):
    return "\n".join(c.get("text", "") for c in res.get("content", []) if c.get("type") == "text")


def main():
    m = StdioMCP(CMD)
    m.request("initialize", {
        "protocolVersion": "2024-11-05", "capabilities": {},
        "clientInfo": {"name": "crewaid-m1-fe-02", "version": "0"},
    })
    m.notify("notifications/initialized")

    res = m.request("tools/call", {"name": "get_component_docs", "arguments": {"components": TARGETS}})
    doc = text_of(res)
    with open("/tmp/heroui_docs.md", "w") as f:
        f.write(doc)
    print(f"[docs saved -> /tmp/heroui_docs.md  ({len(doc):,} chars)]\n")

    # Surface the exact answers I need instead of dumping 100k chars.
    keys = [
        "autoGrow", "auto-grow", "autosize", "auto-size", "rows", "maxRows",
        "minRows", "resize", "Section", "selectionMode", "onAction",
        "disabledKeys", "items", "renderEmptyState", "virtual",
    ]
    lines = doc.splitlines()
    for k in keys:
        hits = [i for i, l in enumerate(lines) if k.lower() in l.lower()]
        if hits:
            print(f"--- {k}  ({len(hits)} hits) ---")
            for i in hits[:3]:
                print("   ", lines[i].strip()[:180])

    theme = m.request("tools/call", {"name": "get_theme_variables", "arguments": {}})
    tv = text_of(theme)
    with open("/tmp/heroui_theme.md", "w") as f:
        f.write(tv)
    print(f"\n[theme tokens saved -> /tmp/heroui_theme.md ({len(tv):,} chars)]")
    print(tv[:1500])


if __name__ == "__main__":
    main()
