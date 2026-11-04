#!/usr/bin/env python3
"""Build a reproducible, allowlisted store ZIP; no credentials or dev files."""
from pathlib import Path
import hashlib,json,zipfile
root=Path(__file__).resolve().parents[1]
ext=root/'extension'
manifest=json.loads((ext/'manifest.json').read_text())
files=['manifest.json','background.js','core.mjs','popup.html','popup.js','popup.css']
files+=sorted(set(manifest['icons'].values()))
assert manifest['manifest_version']==3
assert not manifest.get('externally_connectable')
for f in files:
 assert (ext/f).is_file(),f
out=root/'dist';out.mkdir(exist_ok=True)
archive=out/f"self-hosted-browser-vpn-{manifest['version']}.zip"
with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
 for f in sorted(files):
  item=zipfile.ZipInfo(f,date_time=(2026,1,1,0,0,0));item.compress_type=zipfile.ZIP_DEFLATED
  item.external_attr=0o644<<16;z.writestr(item,(ext/f).read_bytes())
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 assert sorted(z.namelist())==sorted(files)
 for f in files:assert z.read(f)==(ext/f).read_bytes()
sha=hashlib.sha256(archive.read_bytes()).hexdigest()
archive.with_suffix('.zip.sha256').write_text(sha+'  '+archive.name+'\n')
print(f'{archive}\nSHA256 {sha}\n{len(files)} files; {archive.stat().st_size} bytes')
