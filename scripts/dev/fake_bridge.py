#!/usr/bin/env python3
"""Dev-only fake Proton Bridge IMAP server (STARTTLS) for testing the native host end to end.

Usage: fake_bridge.py CERT KEY PORT PASSWORD [initial labels...]
Supports: CAPABILITY, STARTTLS, LOGIN, LIST, CREATE (under Labels/ only, flat), NOOP, LOGOUT.
"""
import socket
import ssl
import sys
import threading

cert, key, port, password, *labels = sys.argv[1:]
port = int(port)
labels = list(labels)
lock = threading.Lock()


def serve(conn):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    f = conn.makefile("rwb", buffering=0)
    f.write(b"* OK [CAPABILITY IMAP4rev1 STARTTLS] Fake Bridge ready\r\n")
    authed = False
    while True:
        line = f.readline()
        if not line:
            return
        tag, _, rest = line.decode().rstrip("\r\n").partition(" ")
        cmd, _, args = rest.partition(" ")
        cmd = cmd.upper()
        if cmd == "CAPABILITY":
            f.write(f"* CAPABILITY IMAP4rev1 STARTTLS\r\n{tag} OK done\r\n".encode())
        elif cmd == "STARTTLS":
            f.write(f"{tag} OK begin TLS\r\n".encode())
            conn = ctx.wrap_socket(conn, server_side=True)
            f = conn.makefile("rwb", buffering=0)
        elif cmd == "LOGIN":
            ok = args.split(" ", 1)[-1].strip('"') == password
            authed = ok
            f.write(f"{tag} {'OK' if ok else 'NO'} login\r\n".encode())
        elif cmd == "LIST" and authed:
            with lock:
                for n in labels:
                    f.write(f'* LIST (\\HasNoChildren) "/" "Labels/{n}"\r\n'.encode())
            f.write(b'* LIST (\\HasNoChildren) "/" "Folders/work"\r\n')
            f.write(f"{tag} OK done\r\n".encode())
        elif cmd == "CREATE" and authed:
            name = args.strip().strip('"')
            if name.startswith("Labels/") and "/" not in name[7:]:
                with lock:
                    labels.append(name[7:])
                f.write(f"{tag} OK created\r\n".encode())
            else:
                f.write(f"{tag} NO operation not allowed\r\n".encode())
        elif cmd == "LOGOUT":
            f.write(f"* BYE\r\n{tag} OK bye\r\n".encode())
            return
        else:
            f.write(f"{tag} NO unsupported\r\n".encode())


srv = socket.create_server(("127.0.0.1", port))
print("fake bridge listening", port, flush=True)
while True:
    c, _ = srv.accept()
    threading.Thread(target=lambda c=c: (serve(c), c.close()), daemon=True).start()
