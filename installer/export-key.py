#!/usr/bin/env python3
"""Print an extension import key without putting the proxy password in argv."""

import argparse
import base64
import json
from pathlib import Path
from typing import List, Optional

DEFAULT_CONFIG_DIR = Path("/etc/shbvpn")


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config-dir", type=Path, default=DEFAULT_CONFIG_DIR,
        help="directory containing config.json and credentials (default: /etc/shbvpn)",
    )
    args = parser.parse_args(argv)
    config_dir = args.config_dir.expanduser()

    config = json.loads((config_dir / "config.json").read_text(encoding="utf-8"))
    username, password = (config_dir / "credentials").read_text(encoding="utf-8").strip().split(":", 1)
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
