#!/usr/bin/env python3

import importlib.util
import json
import os
import pathlib
import stat
import sys
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from unittest import mock

BRIDGE_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(BRIDGE_DIR) not in sys.path:
    sys.path.insert(0, str(BRIDGE_DIR))

import screen_key  # noqa: E402

SPEC = importlib.util.spec_from_file_location("crewaid_agent_bridge_key", BRIDGE_DIR / "bridge.py")
assert SPEC is not None and SPEC.loader is not None
bridge = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = bridge
SPEC.loader.exec_module(bridge)

KEY = {"publicKey": "MCowBQYDK2VwAyEAq3Jx2ZbHyJ8fYcXnWmQ1kN4yT0pLs9u7vB6cR2dE5aF", "session": "crewaid-cmv6rarhx"}


class ScreenKeyTests(unittest.TestCase):
    def test_accepts_exactly_a_public_key_and_a_session(self):
        self.assertEqual(screen_key.validate_screen_key(dict(KEY)), KEY)

    def test_refuses_anything_else(self):
        for request in (
            {},
            {"publicKey": KEY["publicKey"]},
            {**KEY, "privateKey": "x" * 40},
            {**KEY, "publicKey": "not base64url!"},
            {**KEY, "session": "../../etc/passwd"},
            {**KEY, "session": 7},
        ):
            with self.subTest(request=request), self.assertRaises(ValueError):
                screen_key.validate_screen_key(request)

    def test_lives_in_the_runtime_directory(self):
        self.assertEqual(
            screen_key.screen_key_path({"XDG_RUNTIME_DIR": "/tmp/runtime-bot"}),
            "/tmp/runtime-bot/crewaid-screen-ticket.json",
        )

    def test_writes_the_file_whole_and_private(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, screen_key.SCREEN_KEY_FILENAME)
            screen_key.write_screen_key(KEY, path)
            self.assertEqual(json.loads(pathlib.Path(path).read_text()), KEY)
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
            # Replaced, not appended: a new orchestrator key supersedes the old.
            screen_key.write_screen_key({**KEY, "session": "other"}, path)
            self.assertEqual(json.loads(pathlib.Path(path).read_text())["session"], "other")
            self.assertEqual(os.listdir(directory), [screen_key.SCREEN_KEY_FILENAME])


class ScreenKeyRouteTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.env = mock.patch.dict(os.environ, {"XDG_RUNTIME_DIR": self.directory.name})
        self.env.start()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), bridge.BridgeHandler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.env.stop()
        self.directory.cleanup()

    def post(self, body):
        connection = HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)
        connection.request("POST", "/screen/key", body, {"Content-Type": "application/json"})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def test_writes_the_key_the_gateway_reads(self):
        self.assertEqual(self.post(json.dumps(KEY)), (200, {"ok": True, "expiresViewers": True}))
        path = pathlib.Path(self.directory.name, screen_key.SCREEN_KEY_FILENAME)
        self.assertEqual(json.loads(path.read_text()), KEY)

    def test_refuses_a_malformed_key_and_writes_nothing(self):
        status, body = self.post(json.dumps({**KEY, "session": "a b"}))
        self.assertEqual((status, body["code"]), (400, "INVALID_SCREEN_KEY"))
        self.assertEqual(os.listdir(self.directory.name), [])


if __name__ == "__main__":
    unittest.main()
