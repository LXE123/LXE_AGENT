# -*- mode: python ; coding: utf-8 -*-
from __future__ import annotations

import json
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules


ROOT = Path(SPEC).resolve().parents[2]
SOURCE_ROOT = ROOT / "python" / "lxeskill_cli"
CATALOG_PATH = SOURCE_ROOT / "lxeskill" / "catalog.json"

catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
catalog_modules = {
    str(entry.get("module") or "").strip()
    for entry in list(catalog.get("entries") or [])
    if str(entry.get("module") or "").strip()
}

hiddenimports = set(catalog_modules)
for package in ("browser_auth_service", "lxeskill", "services", "shared"):
    hiddenimports.update(collect_submodules(package))

datas = []
for package in ("browser_auth_service", "lxeskill", "services", "shared"):
    datas.extend(collect_data_files(package, include_py_files=False))

# Playwright ships its own matching Node driver and JavaScript protocol package.
# Collecting the whole distribution keeps browser auth usable without a Python
# installation and avoids coupling the frozen CLI to a separately installed
# playwright-core version.
playwright_datas, playwright_binaries, playwright_hiddenimports = collect_all("playwright")
datas.extend(playwright_datas)
hiddenimports.update(playwright_hiddenimports)

a = Analysis(
    [str(ROOT / "scripts" / "lxeskill-bundle" / "entrypoint.py")],
    pathex=[str(SOURCE_ROOT)],
    binaries=playwright_binaries,
    datas=datas,
    hiddenimports=sorted(hiddenimports),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest"],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="lxeskill",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="lxeskill",
)
