#!/usr/bin/env python3
"""Ask the local Chrome process to flush its profile and exit cleanly."""

import base64
import json
import os
import socket
import struct
import sys
import urllib.request
from urllib.parse import urlsplit


def websocket_frame(payload: bytes) -> bytes:
    mask = os.urandom(4)
    length = len(payload)
    if length < 126:
        header = bytes((0x81, 0x80 | length))
    elif length < 65536:
        header = bytes((0x81, 0x80 | 126)) + struct.pack("!H", length)
    else:
        header = bytes((0x81, 0x80 | 127)) + struct.pack("!Q", length)
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return header + mask + masked


port = int(sys.argv[1]) if len(sys.argv) > 1 else 9223
with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as response:
    endpoint = json.load(response)["webSocketDebuggerUrl"]

parsed = urlsplit(endpoint)
key = base64.b64encode(os.urandom(16)).decode("ascii")
request = (
    f"GET {parsed.path or '/'}{('?' + parsed.query) if parsed.query else ''} HTTP/1.1\r\n"
    f"Host: {parsed.netloc}\r\n"
    "Upgrade: websocket\r\n"
    "Connection: Upgrade\r\n"
    f"Sec-WebSocket-Key: {key}\r\n"
    "Sec-WebSocket-Version: 13\r\n\r\n"
).encode("ascii")

with socket.create_connection((parsed.hostname, parsed.port), timeout=2) as connection:
    connection.sendall(request)
    handshake = b""
    while b"\r\n\r\n" not in handshake:
        chunk = connection.recv(4096)
        if not chunk:
            raise RuntimeError("Chrome closed the WebSocket during its handshake")
        handshake += chunk
    status_line = handshake.split(b"\r\n", 1)[0]
    if b" 101 " not in status_line:
        raise RuntimeError(f"Chrome rejected the WebSocket handshake: {status_line!r}")
    command = json.dumps({"id": 1, "method": "Browser.close"}).encode("utf-8")
    connection.sendall(websocket_frame(command))
