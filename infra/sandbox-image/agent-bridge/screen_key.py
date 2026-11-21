"""The key the screen gateway checks tickets with (D-223).

The orchestrator signs a ticket for every screen stream it grants. When the
grant points inside this machine, the screen gateway on 127.0.0.1:7071 checks
that ticket before it streams a pixel, so it needs the orchestrator's PUBLIC
key — and the computer session the orchestrator knows this machine by, so a
ticket granted for another computer opens nothing here.

The orchestrator delivers both through the bridge before each grant, and the
bridge writes them where the gateway reads them. Nothing here is a secret: the
public key can only verify. A process on this machine that rewrites the file
can only let itself watch this machine's own screens, which it can already do.

The bridge port is never put behind a preview (it has no auth), so the only
way to this route is the orchestrator's own tunnel.
"""

from __future__ import annotations

import json
import os
import re
import tempfile

SCREEN_KEY_FILENAME = "crewaid-screen-ticket.json"

# An Ed25519 SPKI key as base64url is 59 characters; the bound only keeps a
# hostile body from being written to disk.
_PUBLIC_KEY = re.compile(r"^[A-Za-z0-9_-]{16,256}$")
_SESSION = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")


def screen_key_path(env: dict[str, str] | os._Environ[str] = os.environ) -> str:
    """Where the gateway reads the key: the user's runtime directory, 0700."""
    return os.path.join(env.get("XDG_RUNTIME_DIR") or "/tmp", SCREEN_KEY_FILENAME)


def validate_screen_key(request: dict[str, object]) -> dict[str, str]:
    """Exactly a public key and a session, or ValueError naming what is wrong."""
    if set(request) != {"publicKey", "session"}:
        raise ValueError("expected exactly publicKey and session")
    public_key = request["publicKey"]
    session = request["session"]
    if not isinstance(public_key, str) or not _PUBLIC_KEY.match(public_key):
        raise ValueError("publicKey must be base64url text")
    if not isinstance(session, str) or not _SESSION.match(session):
        raise ValueError("session must be a short identifier")
    return {"publicKey": public_key, "session": session}


def write_screen_key(key: dict[str, str], path: str) -> None:
    """Replace the file whole, so the gateway never reads half of one."""
    directory = os.path.dirname(path) or "."
    descriptor, temporary = tempfile.mkstemp(prefix=".screen-key-", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(key, handle)
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise
