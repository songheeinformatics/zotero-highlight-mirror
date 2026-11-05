"""xpi 패키징: python build.py  →  dist/highlight-mirror-<version>.xpi

Compress-Archive(PowerShell 5.1)는 zip 항목 경로에 백슬래시를 넣어 Zotero가 읽지 못하므로
python zipfile로 묶는다. manifest.json이 zip 루트에 와야 한다.
"""
import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent
version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
dist = ROOT / "dist"
dist.mkdir(exist_ok=True)
out = dist / f"highlight-mirror-{version}.xpi"

include = ["manifest.json", "bootstrap.js", "prefs.js"]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in include:
        z.write(ROOT / name, name)
    for p in sorted((ROOT / "content").rglob("*")):
        if p.is_file():
            z.write(p, p.relative_to(ROOT).as_posix())
print(out)
