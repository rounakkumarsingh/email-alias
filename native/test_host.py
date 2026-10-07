import io
import json
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import alias_maker_host as host


class FakeImap:
    def __init__(self, labels=(), fail_create=False):
        self.labels = list(labels)
        self.created = []
        self.fail_create = fail_create
        self.logged_out = False

    def list(self, directory, pattern):
        assert pattern == '"Labels/*"'
        data = [f'(\\HasNoChildren) "/" "Labels/{n}"'.encode() for n in self.labels]
        data.append(b'(\\HasNoChildren) "/" "Folders/work"')
        data.append(b'(\\HasChildren) "/" "Labels/a/b"')
        return "OK", data

    def create(self, mailbox):
        if self.fail_create:
            return "NO", [b"nope"]
        assert mailbox.startswith('"Labels/') and mailbox.endswith('"')
        name = mailbox[len('"Labels/'):-1]
        self.created.append(name)
        self.labels.append(name)
        return "OK", [b"done"]

    def logout(self):
        self.logged_out = True


class ConfigMixin(unittest.TestCase):
    def setUp(self):
        d = tempfile.mkdtemp()
        cert = os.path.join(d, "cert.pem")
        open(cert, "w").close()
        cfg = os.path.join(d, "host.json")
        with open(cfg, "w") as f:
            json.dump({"user": "me@example.com", "cert": cert}, f)
        host.CONFIG_PATH = cfg
        self._orig = host.load_config
        host.load_config = lambda path=cfg: self._orig(path)


class ValidateTests(unittest.TestCase):
    def test_accepts(self):
        self.assertEqual(host.validate_request({"type": "ping"}), ("ping", {}))
        self.assertEqual(host.validate_request({"type": "create_label", "name": "fin"})[1], {"name": "fin"})
        self.assertEqual(host.validate_request({"type": "ensure_labels", "names": ["a", "b", "a"]})[1], {"names": ["a", "b"]})

    def test_rejects(self):
        bad = [
            None, [], {}, {"type": 1}, {"type": "nope"},
            {"type": "ping", "extra": 1},
            {"type": "create_label"}, {"type": "create_label", "name": "A"},
            {"type": "create_label", "name": "a.b"}, {"type": "create_label", "name": "a/b"},
            {"type": "create_label", "name": "x" * 25}, {"type": "create_label", "name": "-a"},
            {"type": "create_label", "name": 5}, {"type": "create_label", "name": "a", "x": 1},
            {"type": "ensure_labels", "names": []}, {"type": "ensure_labels", "names": "a"},
            {"type": "ensure_labels", "names": ["ok", "../x"]},
            {"type": "ensure_labels", "names": ["a"] * 0 + [f"t{i}" for i in range(201)]},
        ]
        for msg in bad:
            with self.subTest(msg=msg), self.assertRaises(host.HostError):
                host.validate_request(msg)


class ParseTests(unittest.TestCase):
    def test_parse(self):
        data = [b'(\\HasNoChildren) "/" "Labels/github"', b'(\\HasNoChildren) "/" Labels/fin',
                b'(\\HasNoChildren) "/" "Folders/x"', b'(\\HasChildren) "/" "Labels/a/b"', None, b"garbage"]
        self.assertEqual(host.parse_list_response(data), ["fin", "github"])


class HandleTests(ConfigMixin):
    def run_req(self, msg, imap):
        return host.handle(msg, connector=lambda cfg, pw: imap)

    def test_ensure_creates_only_missing(self):
        imap = FakeImap(["github"])
        r = self.run_req({"type": "ensure_labels", "names": ["github", "fin"]}, imap)
        self.assertEqual(r, {"ok": True, "created": ["fin"], "existing": ["github"]})
        self.assertEqual(imap.created, ["fin"])
        self.assertTrue(imap.logged_out)

    def test_create_label_idempotent(self):
        imap = FakeImap(["fin"])
        r = self.run_req({"type": "create_label", "name": "fin"}, imap)
        self.assertEqual(r["created"], [])
        self.assertEqual(imap.created, [])

    def test_list_and_ping(self):
        imap = FakeImap(["b", "a"])
        self.assertEqual(self.run_req({"type": "list_labels"}, imap)["labels"], ["a", "b"])
        self.assertEqual(self.run_req({"type": "ping"}, imap), {"ok": True, "labels": 2})

    def test_create_failure_reported(self):
        with self.assertRaises(host.HostError):
            self.run_req({"type": "create_label", "name": "x"}, FakeImap(fail_create=True))

    def test_invalid_request_never_connects(self):
        def boom(cfg, pw):
            raise AssertionError("connected")
        with self.assertRaises(host.HostError):
            host.handle({"type": "delete_everything"}, connector=boom)


class ConfigTests(unittest.TestCase):
    def test_missing(self):
        with self.assertRaises(host.HostError):
            host.load_config("/nonexistent/host.json")

    def test_bad_security(self):
        d = tempfile.mkdtemp()
        cert = os.path.join(d, "c.pem")
        open(cert, "w").close()
        p = os.path.join(d, "h.json")
        with open(p, "w") as f:
            json.dump({"user": "u", "cert": cert, "security": "plain"}, f)
        with self.assertRaises(host.HostError):
            host.load_config(p)


class FramingTests(unittest.TestCase):
    def test_round_trip(self):
        out = io.BytesIO()
        host.write_message(out, {"ok": True})
        out.seek(0)
        self.assertEqual(host.read_message(out), {"ok": True})
        self.assertIsNone(host.read_message(out))

    def test_oversize(self):
        with self.assertRaises(host.HostError):
            host.read_message(io.BytesIO(struct.pack("=I", host.MAX_REQUEST_BYTES + 1)))


if __name__ == "__main__":
    unittest.main()
