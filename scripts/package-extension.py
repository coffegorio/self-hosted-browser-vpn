#!/usr/bin/env python3
"""Build and verify the allowlisted Chrome Web Store ZIP."""

import hashlib
import json
from pathlib import Path
import re
import struct
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / "extension"
RUNTIME_FILES = ("manifest.json", "background.js", "core.mjs", "popup.html", "popup.js", "popup.css")
ICON_SIZES = (16, 32, 48, 128)


def require(condition, message):
    if not condition:
        raise SystemExit(message)


def check_png(path, width, height, color_type):
    header = path.read_bytes()[:29]
    require(
        len(header) == 29 and header[:16] == b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
        and struct.unpack(">IIBB", header[16:26]) == (width, height, 8, color_type),
        f"Unexpected PNG format for {path.relative_to(ROOT)}",
    )


def main():
    manifest = json.loads((EXTENSION / "manifest.json").read_text(encoding="utf-8"))
    version = manifest.get("version", "")
    require(
        re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){0,3}", version)
        and any(int(part) for part in version.split("."))
        and all(int(part) <= 65535 for part in version.split(".")),
        "Invalid Chrome extension version",
    )
    require(manifest.get("manifest_version") == 3, "Expected Manifest V3")
    require(0 < len(manifest.get("name", "")) <= 75, "Invalid Chrome Web Store name")
    require(0 < len(manifest.get("description", "")) <= 132, "Invalid Chrome Web Store description")
    require(not manifest.get("externally_connectable"), "Unexpected external messaging")
    icons = {str(size): f"icons/icon-{size}.png" for size in ICON_SIZES}
    require(manifest.get("icons") == icons, "Manifest icons differ from the package allowlist")
    require(set(manifest["action"]["default_icon"].values()) <= set(icons.values()), "Unknown toolbar icon")
    check_png(EXTENSION / icons["128"], 128, 128, 6)
    for name in ("setup", "configured", "verified"):
        check_png(ROOT / "store" / "screenshots" / f"{name}.png", 1280, 800, 2)

    files = {name: (EXTENSION / name).read_bytes() for name in (*RUNTIME_FILES, *icons.values())}
    files["LICENSE"] = (ROOT / "LICENSE").read_bytes()
    output = ROOT / "dist"
    output.mkdir(exist_ok=True)
    archive = output / f"self-hosted-browser-vpn-{version}.zip"
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as package:
        for name in sorted(files):
            entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o644 << 16
            package.writestr(entry, files[name])
    with zipfile.ZipFile(archive) as package:
        require(package.testzip() is None and package.namelist() == sorted(files), "Invalid store ZIP")
        require(all(package.read(name) == contents for name, contents in files.items()), "Store ZIP content mismatch")

    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix(".zip.sha256").write_text(f"{digest}  {archive.name}\n", encoding="ascii")
    print(f"{archive}\nSHA256 {digest}\n{len(files)} files; {archive.stat().st_size} bytes")


if __name__ == "__main__":
    main()
