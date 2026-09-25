#!/usr/bin/env python3
"""Manage a container installation's identity, ACME certificate, and key.

The manager runs as root in the Certbot image. The proxy and ACME containers
only read the relevant shared volumes. Certificate versions are published by
replacing one symlink so a new certificate/key pair becomes visible together.
"""

import argparse
import ipaddress
import json
import os
import re
import secrets
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
INSTALLER = SCRIPT_DIR / "installer"
if not (INSTALLER / "public_ip.py").is_file():
    INSTALLER = SCRIPT_DIR.parent / "installer"
sys.path.insert(0, str(INSTALLER))
from public_ip import is_public_ip  # noqa: E402


RUNTIME = Path("/runtime")
CERTBOT_STATE = Path("/certbot-state")
ACME = Path("/acme")
PROXY_HOST = "proxy"
PROXY_PORT = 8443
ACME_HOST = "acme"
ACME_PORT = 8080
PROXY_GID = 10001
CERT_NAME = "shbvpn"
SUCCESS_INTERVAL = 12 * 60 * 60
FAILURE_INTERVAL = 60 * 60
STOP = threading.Event()


class ManagerError(RuntimeError):
    """A safe, operator-facing configuration or lifecycle error."""


class StopRequested(Exception):
    """A termination signal arrived while waiting for a child or service."""


def _stop(_signal_number, _frame):
    STOP.set()


def validate_settings(environment):
    """Return validated desired identity and optional extra-address update."""
    kind = environment.get("SHBVPN_KIND", "").strip()
    host = environment.get("SHBVPN_HOST", "").strip().lower()
    port_text = environment.get("SHBVPN_PORT", "443").strip()
    email = environment.get("SHBVPN_EMAIL", "").strip()
    if kind not in ("ip", "domain"):
        raise ManagerError("SHBVPN_KIND must be ip or domain")
    if not port_text.isdecimal() or not 1 <= int(port_text) <= 65535 or int(port_text) == 80:
        raise ManagerError("SHBVPN_PORT must be 1..65535 except 80")
    if kind == "ip":
        try:
            address = ipaddress.IPv4Address(host)
        except ipaddress.AddressValueError as error:
            raise ManagerError("SHBVPN_HOST must be a public IPv4 address for kind=ip") from error
        if not is_public_ip(host):
            raise ManagerError("SHBVPN_HOST must be a public IPv4 address for kind=ip")
        host = str(address)
    else:
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ManagerError("Use kind=ip for an IP address")
        if len(host) > 253 or "." not in host or any(
            not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
            for label in host.split(".")
        ):
            raise ManagerError("SHBVPN_HOST must be a valid DNS hostname")
    if email and (len(email) > 254 or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email)):
        raise ManagerError("SHBVPN_EMAIL is invalid")
    clear_text = environment.get("SHBVPN_CLEAR_SELF_ADDRESSES", "0").strip()
    if clear_text not in ("0", "1"):
        raise ManagerError("SHBVPN_CLEAR_SELF_ADDRESSES must be 0 or 1")
    raw_addresses = environment.get("SHBVPN_SELF_ADDRESSES", "").strip()
    if clear_text == "1" and raw_addresses:
        raise ManagerError("Cannot set and clear extra self addresses together")
    addresses = None
    if clear_text == "1":
        addresses = []
    elif raw_addresses:
        addresses = normalize_addresses(raw_addresses.split(","))
    return {"kind": kind, "host": host, "port": int(port_text), "email": email,
            "self_addresses": addresses}


def normalize_addresses(values):
    normalized = []
    for value in values:
        address = value.strip()
        if not is_public_ip(address):
            raise ManagerError("Every SHBVPN_SELF_ADDRESSES entry must be a public IP")
        parsed = ipaddress.ip_address(address)
        if isinstance(parsed, ipaddress.IPv6Address) and parsed.ipv4_mapped:
            parsed = parsed.ipv4_mapped
        canonical = str(parsed)
        if canonical in normalized:
            raise ManagerError("SHBVPN_SELF_ADDRESSES contains a duplicate IP")
        normalized.append(canonical)
    return normalized


def ensure_directory(path, mode, gid=0):
    if path.is_symlink():
        raise ManagerError(f"Refusing a symlink at {path}")
    path.mkdir(parents=True, exist_ok=True)
    os.chown(path, 0, gid)
    os.chmod(path, mode)


def prepare_directories():
    ensure_directory(RUNTIME, 0o750, PROXY_GID)
    ensure_directory(RUNTIME / "tls", 0o750, PROXY_GID)
    ensure_directory(CERTBOT_STATE, 0o700)
    for name in ("config", "work", "logs"):
        ensure_directory(CERTBOT_STATE / name, 0o700)
    ensure_directory(ACME, 0o755)
    ensure_directory(ACME / ".well-known", 0o755)
    ensure_directory(ACME / ".well-known/acme-challenge", 0o755)


def atomic_write(path, data, mode=0o640, gid=PROXY_GID):
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(data)
            output.flush()
            os.fchown(output.fileno(), 0, gid)
            os.fchmod(output.fileno(), mode)
            os.fsync(output.fileno())
        os.replace(temporary, path)
        fsync_directory(path.parent)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def fsync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def ensure_config(settings):
    path = RUNTIME / "config.json"
    if path.is_symlink():
        raise ManagerError("Saved config.json must not be a symlink")
    desired = {key: settings[key] for key in ("kind", "host", "port")}
    if path.exists():
        try:
            existing = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, UnicodeError) as error:
            raise ManagerError("Saved config.json is invalid") from error
        if not isinstance(existing, dict) or any(existing.get(key) != value for key, value in desired.items()):
            raise ManagerError("Saved host, kind, or port differs; use a new runtime volume")
        stored = existing.get("self_addresses", [])
        if not isinstance(stored, list) or any(not isinstance(value, str) for value in stored):
            raise ManagerError("Saved self_addresses is invalid")
        saved_addresses = normalize_addresses(stored)
    else:
        saved_addresses = []
    desired["self_addresses"] = (
        saved_addresses if settings["self_addresses"] is None else settings["self_addresses"]
    )
    data = (json.dumps(desired, separators=(",", ":")) + "\n").encode("utf-8")
    if not path.exists() or path.read_bytes() != data:
        atomic_write(path, data)
    return desired


def ensure_credentials():
    path = RUNTIME / "credentials"
    if path.is_symlink():
        raise ManagerError("Saved credentials must not be a symlink")
    if path.exists():
        value = path.read_text(encoding="utf-8")
        if value.endswith("\r\n"):
            value = value[:-2]
        elif value.endswith("\n"):
            value = value[:-1]
        if ":" not in value or any(character in value for character in "\r\n"):
            raise ManagerError("Saved credentials are invalid")
        user, password = value.split(":", 1)
        if not user or not password:
            raise ManagerError("Saved credentials are invalid")
        os.chown(path, 0, PROXY_GID)
        os.chmod(path, 0o640)
        return
    atomic_write(path, ("browser:" + secrets.token_urlsafe(32) + "\n").encode("ascii"))


def lineage_paths():
    lineage = CERTBOT_STATE / "config/live" / CERT_NAME
    return lineage / "fullchain.pem", lineage / "privkey.pem"


def certbot_base():
    return ["certbot", "--config-dir", str(CERTBOT_STATE / "config"),
            "--work-dir", str(CERTBOT_STATE / "work"),
            "--logs-dir", str(CERTBOT_STATE / "logs")]


def certbot_command(config, email, first):
    if first:
        command = certbot_base() + [
            "certonly", "--non-interactive", "--agree-tos", "--quiet", "--webroot",
            "--webroot-path", str(ACME), "--cert-name", CERT_NAME, "--keep-until-expiring",
        ]
        command += ["--email", email] if email else ["--register-unsafely-without-email"]
        if config["kind"] == "ip":
            command += ["--preferred-profile", "shortlived", "--ip-address", config["host"]]
        else:
            command += ["-d", config["host"]]
        return command
    return certbot_base() + ["renew", "--cert-name", CERT_NAME,
                             "--no-random-sleep-on-renew", "--quiet"]


def run_external(command, purpose, timeout):
    """Run without inheriting output; Certbot writes diagnostics to its state logs."""
    process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + timeout
    try:
        while True:
            result = process.poll()
            if result is not None:
                if result:
                    detail = (f"; inspect {CERTBOT_STATE / 'logs'}" if purpose == "Certbot" else "")
                    raise ManagerError(f"{purpose} failed (exit {result}{detail})")
                return
            if STOP.is_set():
                raise StopRequested()
            if time.monotonic() >= deadline:
                raise ManagerError(f"{purpose} timed out")
            STOP.wait(min(1.0, max(0.0, deadline - time.monotonic())))
    except (ManagerError, StopRequested):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        raise


def wait_for_acme(timeout=120):
    deadline = time.monotonic() + timeout
    while not STOP.is_set():
        try:
            with socket.create_connection((ACME_HOST, ACME_PORT), timeout=2):
                return
        except OSError:
            if time.monotonic() >= deadline:
                raise ManagerError("ACME challenge service is unavailable")
            STOP.wait(min(2.0, max(0.0, deadline - time.monotonic())))
    raise StopRequested()


def current_target():
    tls = RUNTIME / "tls"
    current = tls / "current"
    if not os.path.lexists(current):
        return None
    if not current.is_symlink():
        raise ManagerError("TLS current path must be a symlink")
    target = os.readlink(current)
    if Path(target).name != target or not target.startswith("version-"):
        raise ManagerError("TLS current symlink target is invalid")
    if (tls / target).is_symlink():
        raise ManagerError("TLS version directory must not be a symlink")
    for name in ("fullchain.pem", "privkey.pem"):
        if (tls / target / name).is_symlink():
            raise ManagerError("Published TLS files must not be symlinks")
    return target


def switch_to_version(name):
    tls = RUNTIME / "tls"
    link = tls / (".current-" + secrets.token_hex(8))
    try:
        link.symlink_to(name)
        os.replace(link, tls / "current")
        fsync_directory(tls)
    finally:
        if os.path.lexists(link):
            link.unlink()


def matching_published_pair(cert_data, key_data):
    current = RUNTIME / "tls/current"
    try:
        return ((current / "fullchain.pem").read_bytes() == cert_data and
                (current / "privkey.pem").read_bytes() == key_data)
    except FileNotFoundError:
        return False


def validate_pair(certificate, private_key):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    try:
        context.load_cert_chain(str(certificate), str(private_key))
    except (OSError, ssl.SSLError) as error:
        raise ManagerError("Certificate and private key are invalid or do not match") from error


def publish_certificate():
    """Return the old version name if a new pair was published, else None.

    The caller runs the live health check and rolls back to the old version if
    that check fails. A first issuance has no previous version to roll back to.
    """
    cert_source, key_source = lineage_paths()
    if not cert_source.is_file() or not key_source.is_file():
        raise ManagerError("Certbot certificate lineage is incomplete")
    cert_data, key_data = cert_source.read_bytes(), key_source.read_bytes()
    previous = current_target()
    if matching_published_pair(cert_data, key_data):
        return None
    tls = RUNTIME / "tls"
    token = secrets.token_hex(12)
    staging = tls / (".staging-" + token)
    version = "version-" + token
    staging.mkdir(mode=0o750)
    try:
        os.chown(staging, 0, PROXY_GID)
        atomic_write(staging / "fullchain.pem", cert_data)
        atomic_write(staging / "privkey.pem", key_data)
        validate_pair(staging / "fullchain.pem", staging / "privkey.pem")
        os.replace(staging, tls / version)
        fsync_directory(tls)
        switch_to_version(version)
    finally:
        if staging.exists():
            shutil.rmtree(staging)
    return previous


def run_healthcheck(timeout=120):
    """Allow proxy startup and TLS reload time, then verify its live behavior."""
    command = [sys.executable, str(INSTALLER / "healthcheck.py"),
               "--config-dir", str(RUNTIME), "--connect-host", PROXY_HOST,
               "--connect-port", str(PROXY_PORT),
               "--tls-cert", str(RUNTIME / "tls/current/fullchain.pem")]
    deadline = time.monotonic() + timeout
    while not STOP.is_set():
        try:
            run_external(command, "Proxy health check", min(30, max(1, deadline - time.monotonic())))
            return
        except ManagerError as error:
            if time.monotonic() >= deadline:
                raise ManagerError(f"Proxy health check failed after {timeout} seconds") from error
            STOP.wait(min(2, max(0, deadline - time.monotonic())))
    raise StopRequested()


def verify_published_pair():
    current_target()
    cert = RUNTIME / "tls/current/fullchain.pem"
    key = RUNTIME / "tls/current/privkey.pem"
    if not cert.is_file() or not key.is_file():
        raise ManagerError("Published TLS pair is missing")
    validate_pair(cert, key)


def run_cycle(environment):
    prepare_directories()
    settings = validate_settings(environment)
    config = ensure_config(settings)
    ensure_credentials()
    wait_for_acme()
    cert, key = lineage_paths()
    first = not (cert.is_file() and key.is_file())
    certbot_failure = None
    try:
        run_external(certbot_command(config, settings["email"], first), "Certbot", 600)
    except ManagerError as error:
        # A failed Certbot invocation may still have written a usable lineage.
        # Reconcile it now; do not leave an already renewed certificate idle.
        certbot_failure = error
        if not (cert.is_file() and key.is_file()):
            raise
    previous = publish_certificate()
    try:
        run_healthcheck()
    except (ManagerError, StopRequested):
        if previous is not None:
            switch_to_version(previous)
        raise
    if certbot_failure is not None:
        raise certbot_failure


def rotate_credentials():
    if not (RUNTIME / "config.json").is_file() or not (RUNTIME / "credentials").is_file():
        raise ManagerError("Container installation is not initialized")
    atomic_write(RUNTIME / "credentials",
                 ("browser:" + secrets.token_urlsafe(32) + "\n").encode("ascii"))
    subprocess.run([sys.executable, str(INSTALLER / "export-key.py"),
                    "--config-dir", str(RUNTIME)], check=True)
    print("Restart the proxy container to activate the new key.", file=sys.stderr)


def show_key():
    subprocess.run([sys.executable, str(INSTALLER / "export-key.py"),
                    "--config-dir", str(RUNTIME)], check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("run", "health", "show-key", "rotate"),
                        default="run")
    args = parser.parse_args(argv)
    if args.command == "show-key":
        show_key()
        return 0
    if args.command == "rotate":
        rotate_credentials()
        return 0
    if args.command == "health":
        try:
            verify_published_pair()
            run_healthcheck(timeout=15)
            return 0
        except (ManagerError, OSError):
            print("Container proxy health check failed", file=sys.stderr)
            return 1
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    while not STOP.is_set():
        try:
            run_cycle(os.environ)
        except StopRequested:
            break
        except (ManagerError, OSError, ValueError, ssl.SSLError) as error:
            # No credentials or child process output are ever included here.
            print(f"Manager cycle failed: {error}; retrying in one hour", file=sys.stderr)
            STOP.wait(FAILURE_INTERVAL)
        else:
            print("Certificate and live proxy verified", flush=True)
            STOP.wait(SUCCESS_INTERVAL)
    return 0


if __name__ == "__main__":
    sys.exit(main())
