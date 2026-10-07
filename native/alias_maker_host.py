#!/usr/bin/env python3
"""Native messaging host: creates Proton labels through the local Proton Bridge IMAP server.

Protocol: browser native messaging (4-byte native-endian length + UTF-8 JSON, both ways).
Requests (anything else is rejected):
  {"type": "ping"}
  {"type": "list_labels"}
  {"type": "create_label", "name": "<tag>"}
  {"type": "ensure_labels", "names": ["<tag>", ...]}
Replies: {"ok": true, ...} or {"ok": false, "error": "<message>"}.

Stdlib only. The Bridge password is read from libsecret via `secret-tool`; TLS verification is
always on and trusts only the certificate file named in the config.
"""
import imaplib
import json
import os
import re
import ssl
import struct
import subprocess
import sys

SECRET_SERVICE = "alias-maker-bridge"
LABEL_PREFIX = "Labels/"
TAG_RE = re.compile(r"^[a-z0-9-]{1,24}$")
MAX_REQUEST_BYTES = 64 * 1024
MAX_NAMES = 200
TIMEOUT = 15
CONFIG_PATH = os.environ.get("ALIAS_MAKER_CONFIG") or os.path.expanduser("~/.config/alias-maker/host.json")


class HostError(Exception):
    """An error whose message is safe to show to the user."""


# ---- request validation -------------------------------------------------------------------

def _check_name(name):
    if not isinstance(name, str) or not TAG_RE.match(name) or name.startswith("-") or name.endswith("-"):
        raise HostError("Invalid label name. Use a-z, 0-9 and hyphens, up to 24 characters.")
    return name


def validate_request(msg):
    """Returns (type, args) or raises HostError. Unknown types and extra keys are rejected."""
    if not isinstance(msg, dict) or not isinstance(msg.get("type"), str):
        raise HostError("Request must be a JSON object with a string 'type'.")
    kind = msg["type"]
    keys = set(msg) - {"type"}

    def only(*allowed):
        if keys != set(allowed):
            raise HostError(f"'{kind}' takes exactly these fields: {', '.join(allowed) or 'none'}.")

    if kind in ("ping", "list_labels"):
        only()
        return kind, {}
    if kind == "create_label":
        only("name")
        return kind, {"name": _check_name(msg["name"])}
    if kind == "ensure_labels":
        only("names")
        names = msg["names"]
        if not isinstance(names, list) or not 1 <= len(names) <= MAX_NAMES:
            raise HostError(f"'names' must be a list of 1 to {MAX_NAMES} labels.")
        return kind, {"names": list(dict.fromkeys(_check_name(n) for n in names))}
    raise HostError(f"Unknown request type: {kind[:40]!r}")


# ---- configuration and credentials --------------------------------------------------------

def load_config(path=CONFIG_PATH):
    try:
        with open(path, encoding="utf-8") as f:
            cfg = json.load(f)
    except FileNotFoundError:
        raise HostError(f"Host is not configured ({path} missing). Run native/install.sh.")
    except (OSError, ValueError) as e:
        raise HostError(f"Cannot read host config: {e}")
    if not isinstance(cfg, dict):
        raise HostError("Host config must be a JSON object.")
    out = {
        "user": cfg.get("user"),
        "host": cfg.get("host", "127.0.0.1"),
        "port": cfg.get("port", 1143),
        "security": cfg.get("security", "starttls"),
        "cert": cfg.get("cert"),
    }
    if not isinstance(out["user"], str) or not out["user"]:
        raise HostError("Host config needs 'user' (your Bridge IMAP username).")
    if not isinstance(out["host"], str) or not isinstance(out["port"], int):
        raise HostError("Host config 'host' must be a string and 'port' an integer.")
    if out["security"] not in ("starttls", "ssl"):
        raise HostError("Host config 'security' must be 'starttls' or 'ssl'.")
    if not isinstance(out["cert"], str) or not os.path.isfile(out["cert"]):
        raise HostError("Host config 'cert' must point to Bridge's exported certificate (cert.pem).")
    return out


def read_password():
    try:
        r = subprocess.run(
            ["secret-tool", "lookup", "service", SECRET_SERVICE],
            capture_output=True, timeout=10, check=False,
        )
    except FileNotFoundError:
        raise HostError("secret-tool not found. Install libsecret's secret-tool.")
    except subprocess.TimeoutExpired:
        raise HostError("Timed out reading the Bridge password from the keyring.")
    password = r.stdout.decode("utf-8", "replace").rstrip("\r\n")
    if r.returncode != 0 or not password:
        raise HostError("Bridge password not found in the keyring. Run native/install.sh --store-password.")
    return password


def connect(cfg, password):
    """Opens an authenticated IMAP session. Certificate verification is never disabled."""
    ctx = ssl.create_default_context(cafile=cfg["cert"])
    try:
        if cfg["security"] == "ssl":
            imap = imaplib.IMAP4_SSL(cfg["host"], cfg["port"], ssl_context=ctx, timeout=TIMEOUT)
        else:
            imap = imaplib.IMAP4(cfg["host"], cfg["port"], timeout=TIMEOUT)
            imap.starttls(ssl_context=ctx)
        imap.login(cfg["user"], password)
    except ssl.SSLError as e:
        raise HostError(f"TLS verification failed ({e.reason or e}). Re-export Bridge's certificate.")
    except imaplib.IMAP4.error as e:
        raise HostError(f"Bridge rejected the login: {_text(e)}")
    except OSError as e:
        raise HostError(f"Cannot reach Proton Bridge at {cfg['host']}:{cfg['port']} ({e.strerror or e}). Is Bridge running?")
    return imap


def _text(e):
    return " ".join(str(a) for a in e.args)[:200]


# ---- IMAP operations ----------------------------------------------------------------------

_LIST_RE = re.compile(rb'^\((?P<flags>[^)]*)\)\s+(?:"(?P<delim>[^"]*)"|NIL)\s+(?P<name>.+)$')


def parse_list_response(data):
    """Extracts label names from LIST responses. Nested paths are ignored (Bridge labels are flat)."""
    labels = []
    for item in data or []:
        if not isinstance(item, bytes):
            continue
        m = _LIST_RE.match(item.strip())
        if not m:
            continue
        name = m.group("name").decode("utf-8", "replace").strip()
        if name.startswith('"') and name.endswith('"'):
            name = name[1:-1]
        if name.startswith(LABEL_PREFIX):
            label = name[len(LABEL_PREFIX):]
            if label and "/" not in label:
                labels.append(label)
    return sorted(set(labels))


def list_labels(imap):
    typ, data = imap.list('""', f'"{LABEL_PREFIX}*"')
    if typ != "OK":
        raise HostError("Bridge refused to list labels.")
    return parse_list_response(data)


def create_label(imap, name):
    typ, data = imap.create(f'"{LABEL_PREFIX}{name}"')
    if typ != "OK":
        detail = b" ".join(d for d in data or [] if isinstance(d, bytes)).decode("utf-8", "replace")[:200]
        raise HostError(f"Bridge could not create label '{name}': {detail or typ}")


def ensure_labels(imap, names):
    have = set(list_labels(imap))
    created, existing = [], []
    for name in names:
        if name in have:
            existing.append(name)
        else:
            create_label(imap, name)
            created.append(name)
    return {"created": created, "existing": existing}


# ---- dispatch -----------------------------------------------------------------------------

def handle(msg, connector=None):
    kind, args = validate_request(msg)
    if kind == "ping":
        cfg = load_config()
        with _session(cfg, connector) as imap:
            return {"ok": True, "labels": len(list_labels(imap))}
    cfg = load_config()
    with _session(cfg, connector) as imap:
        if kind == "list_labels":
            return {"ok": True, "labels": list_labels(imap)}
        if kind == "create_label":
            have = list_labels(imap)
            if args["name"] in have:
                return {"ok": True, "created": [], "existing": [args["name"]]}
            create_label(imap, args["name"])
            return {"ok": True, "created": [args["name"]], "existing": []}
        return {"ok": True, **ensure_labels(imap, args["names"])}


class _session:
    def __init__(self, cfg, connector):
        self.cfg, self.connector = cfg, connector

    def __enter__(self):
        connector = self.connector or connect
        self.imap = connector(self.cfg, read_password() if self.connector is None else "")
        return self.imap

    def __exit__(self, *exc):
        try:
            self.imap.logout()
        except Exception:
            pass
        return False


# ---- native messaging framing -------------------------------------------------------------

def read_message(stream):
    header = stream.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("=I", header)
    if length > MAX_REQUEST_BYTES:
        raise HostError("Request too large.")
    body = stream.read(length)
    if len(body) < length:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except ValueError:
        raise HostError("Request is not valid JSON.")


def write_message(stream, obj):
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("=I", len(data)))
    stream.write(data)
    stream.flush()


def main():
    stdin, stdout = sys.stdin.buffer, sys.stdout.buffer
    while True:
        try:
            msg = read_message(stdin)
            if msg is None:
                return
            reply = handle(msg)
        except HostError as e:
            reply = {"ok": False, "error": str(e)}
        except Exception:  # never leak internals or credentials
            reply = {"ok": False, "error": "Unexpected host error."}
        write_message(stdout, reply)


if __name__ == "__main__":
    main()
