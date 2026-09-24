#!/usr/bin/env python3
"""Print an extension import key without putting the proxy password in argv."""

import base64
import json
from pathlib import Path

CONFIG = Path("/etc/shbvpn/config.json")
CREDENTIALS = Path("/etc/shbvpn/credentials")


def main() -> None:
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    username, password = CREDENTIALS.read_text(encoding="utf-8").strip().split(":", 1)
    payload = {
        "v": 1,
        "host": config["host"],
        "port": config["port"],
        "username": username,
        "password": password,
    }
    encoded = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    ).rstrip(b"=")
    print("shbvpn1:" + encoded.decode("ascii"))


if __name__ == "__main__":
    main()
