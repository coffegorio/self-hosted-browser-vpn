"""Start a proxy container from the persisted, validated configuration."""

import json
import os
import socket
import sys
import time
from pathlib import Path


RUNTIME = Path("/runtime")
ACME_WEBROOT = Path("/acme")
SERVER = "/app/shbvpn-proxy"


def proxy_arguments(config: dict) -> list[str]:
    host = config["host"]
    addresses = config.get("self_addresses", [])
    if not isinstance(host, str) or not isinstance(addresses, list) or any(
        not isinstance(address, str) for address in addresses
    ):
        raise ValueError("invalid persisted proxy configuration")
    args = [
        SERVER, "--listen", ":8443",
        "--cert", str(RUNTIME / "tls/current/fullchain.pem"),
        "--key", str(RUNTIME / "tls/current/privkey.pem"),
        "--credentials", str(RUNTIME / "credentials"),
        "--self-host", host,
    ]
    for address in addresses:
        args.extend(("--self-address", address))
    return args


def runtime_ready(paths) -> bool:
    try:
        return all(path.is_file() and path.stat().st_size > 0 for path in paths)
    except OSError:
        # The manager can replace a file or TLS symlink between is_file and stat.
        return False


def run_proxy() -> None:
    required = (
        RUNTIME / "config.json",
        RUNTIME / "credentials",
        RUNTIME / "tls/current/fullchain.pem",
        RUNTIME / "tls/current/privkey.pem",
    )
    while not runtime_ready(required):
        time.sleep(2)
    config = json.loads((RUNTIME / "config.json").read_text(encoding="utf-8"))
    os.execv(SERVER, proxy_arguments(config))


def probe_acme() -> None:
    with socket.create_connection(("127.0.0.1", 8080), timeout=2):
        pass


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: run_server.py acme|proxy|probe-acme")
    if sys.argv[1] == "acme":
        os.execv(SERVER, [SERVER, "--acme-only", "--listen", ":8080", "--acme-webroot", str(ACME_WEBROOT)])
    if sys.argv[1] == "proxy":
        run_proxy()
        return
    if sys.argv[1] == "probe-acme":
        probe_acme()
        return
    raise SystemExit("Unknown service mode")


if __name__ == "__main__":
    main()
