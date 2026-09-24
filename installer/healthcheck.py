#!/usr/bin/env python3
"""Verify certificate, authentication, and private-destination blocking locally."""

import base64
import json
import socket
import ssl
from pathlib import Path


def request(host: str, port: int, authorization: str = "") -> int:
    context = ssl.create_default_context()
    with socket.create_connection(("127.0.0.1", port), timeout=10) as raw:
        with context.wrap_socket(raw, server_hostname=host) as connection:
            connection.settimeout(10)
            lines = [
                "GET http://127.0.0.1/ HTTP/1.1",
                "Host: 127.0.0.1",
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


def main() -> None:
    config = json.loads(Path("/etc/shbvpn/config.json").read_text(encoding="utf-8"))
    credentials = Path("/etc/shbvpn/credentials").read_text(encoding="utf-8").strip()
    encoded = base64.b64encode(credentials.encode("utf-8")).decode("ascii")
    host, port = config["host"], config["port"]
    if request(host, port) != 407:
        raise RuntimeError("Proxy accepted a request without authentication")
    if request(host, port, encoded) != 403:
        raise RuntimeError("Proxy did not block a private destination")
    print("TLS, authentication and destination guard: OK")


if __name__ == "__main__":
    main()
