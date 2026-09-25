#!/usr/bin/env python3
"""Verify live TLS, authentication, and destination blocking locally."""

import argparse
import base64
import json
import socket
import ssl
import time
from pathlib import Path
from typing import List, Optional

DEFAULT_CONFIG_DIR = Path("/etc/shbvpn")


def installed_certificate(path: Path) -> bytes:
    pem = path.read_text(encoding="ascii")
    end = pem.find("-----END CERTIFICATE-----")
    if end == -1:
        raise RuntimeError("Installed certificate is not PEM encoded")
    return ssl.PEM_cert_to_DER_cert(pem[: end + len("-----END CERTIFICATE-----")])


def request(
    host: str,
    port: int,
    certificate: bytes,
    authorization: str = "",
    method: str = "GET",
    target: str = "http://127.0.0.1/",
    connect_host: str = "127.0.0.1",
) -> int:
    context = ssl.create_default_context()
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    with socket.create_connection((connect_host, port), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=host) as connection:
            connection.settimeout(10)
            if connection.getpeercert(binary_form=True) != certificate:
                raise RuntimeError("Proxy is serving a certificate other than the installed one")
            lines = [
                f"{method} {target} HTTP/1.1",
                f"Host: {target if method == 'CONNECT' else '127.0.0.1'}",
                "Connection: close",
            ]
            if authorization:
                lines.append("Proxy-Authorization: Basic " + authorization)
            connection.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
            first_line = connection.makefile("rb").readline(512).decode("ascii")
    try:
        return int(first_line.split(" ", 2)[1])
    except (IndexError, ValueError) as error:
        raise RuntimeError(f"Invalid HTTP response: {first_line!r}") from error


def check_proxy(
    host: str, port: int, certificate: bytes, encoded: str, addresses: list[str],
    connect_host: str = "127.0.0.1",
) -> None:
    if request(host, port, certificate, connect_host=connect_host) != 407:
        raise RuntimeError("Proxy accepted a request without authentication")
    if request(host, port, certificate, encoded, connect_host=connect_host) != 403:
        raise RuntimeError("Proxy did not block a private destination")
    if request(host, port, certificate, encoded, method="CONNECT", target=f"{host}:443",
               connect_host=connect_host) != 403:
        raise RuntimeError("Proxy did not block its own hostname or IP address")
    for address in addresses:
        target_host = f"[{address}]" if ":" in address else address
        if request(host, port, certificate, encoded, method="CONNECT", target=f"{target_host}:443",
                   connect_host=connect_host) != 403:
            raise RuntimeError(f"Proxy did not block its own address: {address}")


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config-dir", type=Path, default=DEFAULT_CONFIG_DIR,
        help="directory containing config.json, credentials, and tls/ (default: /etc/shbvpn)",
    )
    parser.add_argument(
        "--connect-host", default="127.0.0.1",
        help="address used to connect to the proxy (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--connect-port", type=int,
        help="proxy port used for the health check (default: port from config.json)",
    )
    parser.add_argument(
        "--tls-cert", type=Path,
        help="expected TLS fullchain PEM (default: CONFIG_DIR/tls/fullchain.pem)",
    )
    args = parser.parse_args(argv)
    if args.connect_port is not None and not 1 <= args.connect_port <= 65535:
        parser.error("--connect-port must be in the range 1..65535")
    config_dir = args.config_dir.expanduser()
    config = json.loads((config_dir / "config.json").read_text(encoding="utf-8"))
    credentials = (config_dir / "credentials").read_text(encoding="utf-8").strip()
    encoded = base64.b64encode(credentials.encode("utf-8")).decode("ascii")
    host, port = config["host"], args.connect_port or config["port"]
    certificate = installed_certificate((args.tls_cert or config_dir / "tls/fullchain.pem").expanduser())
    deadline = time.monotonic() + 5
    while True:
        try:
            check_proxy(host, port, certificate, encoded, config.get("self_addresses", []), args.connect_host)
            break
        except (ConnectionRefusedError, ConnectionResetError, BrokenPipeError):
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.2)
    print("TLS, authentication and destination guards: OK")


if __name__ == "__main__":
    main()
