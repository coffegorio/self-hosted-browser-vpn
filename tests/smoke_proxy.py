#!/usr/bin/env python3
"""Run a real HTTPS proxy smoke test against a temporary server instance.

Requires Python 3.9+, OpenSSL, Go 1.22+ (or --server-bin), and network access
to --public-target. No VPS, root access, or persistent configuration is used.
"""

import argparse
import base64
import os
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PUBLIC_TARGET = "example.com:443"


def fail(message):
    raise RuntimeError(message)


def make_certificate(folder):
    if not shutil.which("openssl"):
        fail("OpenSSL is required to create the temporary TLS certificate")
    config = folder / "openssl.cnf"
    cert = folder / "proxy.crt"
    key = folder / "proxy.key"
    config.write_text(
        "[req]\n"
        "prompt = no\n"
        "distinguished_name = subject\n"
        "x509_extensions = extensions\n"
        "[subject]\n"
        "CN = localhost\n"
        "[extensions]\n"
        "subjectAltName = DNS:localhost,IP:127.0.0.1\n"
        "basicConstraints = critical,CA:TRUE\n"
        "keyUsage = critical,digitalSignature,keyEncipherment,keyCertSign\n"
        "extendedKeyUsage = serverAuth\n",
        encoding="ascii",
    )
    result = subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-days", "1", "-keyout", str(key), "-out", str(cert),
         "-config", str(config)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode:
        fail("OpenSSL could not create a temporary certificate:\n" + result.stderr)
    return cert, key


def build_server(folder, provided_binary):
    if provided_binary:
        binary = Path(provided_binary).expanduser().resolve()
        if not binary.is_file():
            fail("Server binary does not exist: " + str(binary))
        return binary
    if not shutil.which("go"):
        fail("Go 1.22+ is required; install Go or pass --server-bin PATH")
    binary = folder / "shbvpn-proxy"
    result = subprocess.run(
        ["go", "build", "-o", str(binary), "."],
        cwd=ROOT / "server",
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode:
        fail("Could not build the server:\n" + result.stdout + result.stderr)
    return binary


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return listener.getsockname()[1]


def client_context(cert=None):
    context = ssl.create_default_context(cafile=str(cert) if cert is not None else None)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    return context


def connect_tls(port, context):
    raw = socket.create_connection(("127.0.0.1", port), timeout=8)
    try:
        wrapped = context.wrap_socket(raw, server_hostname="localhost")
        wrapped.settimeout(12)
        return wrapped
    except Exception:
        raw.close()
        raise


def request(port, cert, method, target, credentials=None):
    authorization = ""
    if credentials is not None:
        token = base64.b64encode(credentials.encode("utf-8")).decode("ascii")
        authorization = "Proxy-Authorization: Basic " + token + "\r\n"
    if method == "CONNECT":
        first_line = "CONNECT " + target + " HTTP/1.1"
        host = target
    else:
        first_line = method + " " + target + " HTTP/1.1"
        host = target.split("/", 3)[2]
    wire = (
        first_line + "\r\n" +
        "Host: " + host + "\r\n" +
        authorization +
        "Connection: close\r\n\r\n"
    ).encode("ascii")
    with connect_tls(port, client_context(cert)) as stream:
        stream.sendall(wire)
        received = bytearray()
        while b"\r\n\r\n" not in received:
            chunk = stream.recv(4096)
            if not chunk:
                break
            received.extend(chunk)
            if len(received) > 65536:
                fail("Proxy response headers exceeded 64 KiB")
    first = received.split(b"\r\n", 1)[0].decode("ascii", "replace")
    fields = first.split()
    if len(fields) < 2 or not fields[0].startswith("HTTP/") or not fields[1].isdigit():
        fail("Invalid proxy response: " + repr(first))
    return int(fields[1]), received.decode("latin-1", "replace")


def check_status(name, port, cert, method, target, credentials, expected):
    actual, headers = request(port, cert, method, target, credentials)
    if actual != expected:
        fail("{}: expected HTTP {}, got HTTP {} ({})".format(name, expected, actual, headers.split("\r\n", 1)[0]))
    if expected == 407 and "proxy-authenticate: basic" not in headers.lower():
        fail(name + ": 407 response did not offer Basic proxy authentication")
    print("PASS {}: HTTP {}".format(name, actual))


def check_https_fetch(port, cert, target, credentials):
    if not shutil.which("curl"):
        fail("curl is required for the HTTPS fetch through the CONNECT tunnel")
    result = subprocess.run(
        ["curl", "--noproxy", "", "--proxy", "https://localhost:{}".format(port),
         "--proxy-cacert", str(cert), "--proxy-user", credentials,
         "--fail", "--location", "--proto-redir", "=https",
         "--silent", "--show-error", "--max-time", "20",
         "--output", os.devnull, "--write-out", "%{http_code}",
         "https://{}/".format(target)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    if result.returncode or not result.stdout.startswith("2"):
        fail("HTTPS fetch through proxy failed (curl exit {}, origin HTTP {}): {}".format(
            result.returncode, result.stdout.strip(), result.stderr.strip()))
    print("PASS HTTPS fetch through CONNECT tunnel: origin HTTP " + result.stdout.strip())


def wait_for_server(process, port, cert, log_path):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        if process.poll() is not None:
            fail("Server exited during startup:\n" + log_path.read_text(errors="replace"))
        try:
            with connect_tls(port, client_context(cert)):
                return
        except (OSError, ssl.SSLError):
            time.sleep(0.15)
    fail("Server did not become ready:\n" + log_path.read_text(errors="replace"))


def stop_server(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server-bin", help="prebuilt server binary; skips Go build")
    parser.add_argument("--public-target", default=DEFAULT_PUBLIC_TARGET,
                        help="reachable public HTTPS host:port for the positive CONNECT test")
    args = parser.parse_args()
    if ":" not in args.public_target:
        parser.error("--public-target must be host:port")

    with tempfile.TemporaryDirectory(prefix="shbvpn-smoke-") as temporary:
        folder = Path(temporary)
        cert, key = make_certificate(folder)
        binary = build_server(folder, args.server_bin)
        credentials = "smoke_" + os.urandom(8).hex() + ":" + os.urandom(24).hex()
        credentials_file = folder / "credentials"
        credentials_file.write_text(credentials + "\n", encoding="ascii")
        credentials_file.chmod(0o600)
        port = free_port()
        log_path = folder / "server.log"
        with log_path.open("wb") as log:
            process = subprocess.Popen(
                [str(binary), "--listen", "127.0.0.1:{}".format(port),
                 "--cert", str(cert), "--key", str(key),
                 "--credentials", str(credentials_file)],
                cwd=ROOT,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
            try:
                wait_for_server(process, port, cert, log_path)
                print("PASS TLS connection: temporary proxy certificate trusted explicitly")
                try:
                    with connect_tls(port, client_context()):
                        pass
                except ssl.SSLCertVerificationError:
                    print("PASS TLS validation: untrusted certificate rejected")
                else:
                    fail("TLS validation: untrusted certificate was accepted")

                check_status("missing credentials", port, cert, "CONNECT", args.public_target, None, 407)
                check_status("wrong credentials", port, cert, "CONNECT", args.public_target, "wrong:password", 407)
                check_status("loopback IPv4", port, cert, "CONNECT", "127.0.0.1:443", credentials, 403)
                check_status("loopback IPv6", port, cert, "CONNECT", "[::1]:443", credentials, 403)
                check_status("localhost DNS", port, cert, "CONNECT", "localhost:443", credentials, 403)
                check_status("private IPv4", port, cert, "CONNECT", "10.0.0.1:443", credentials, 403)
                check_status("cloud metadata", port, cert, "CONNECT", "169.254.169.254:80", credentials, 403)
                check_status("cloud metadata over HTTP", port, cert, "GET", "http://169.254.169.254/latest/meta-data/", credentials, 403)
                check_status("non-web port", port, cert, "CONNECT", "example.com:25", credentials, 403)
                check_status("authenticated public CONNECT", port, cert, "CONNECT", args.public_target, credentials, 200)
                check_https_fetch(port, cert, args.public_target, credentials)
            finally:
                stop_server(process)

        try:
            socket.create_connection(("127.0.0.1", port), timeout=1).close()
        except OSError:
            print("PASS proxy outage: connection refused after server stop")
        else:
            fail("Proxy was still reachable after shutdown")
    print("PASS all proxy smoke checks")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError, ssl.SSLError) as error:
        print("FAIL " + str(error), file=sys.stderr)
        sys.exit(1)
