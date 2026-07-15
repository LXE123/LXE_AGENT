from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
PACKAGE_ROOT = ROOT / "packages" / "agent" / "lxeskill-cli"
SPEC_PATH = ROOT / "scripts" / "lxeskill-bundle" / "lxeskill.spec"
CATALOG_PATH = ROOT / "python" / "lxeskill_cli" / "lxeskill" / "catalog.json"


def _target() -> str:
    platforms = {"Darwin": "darwin", "Linux": "linux", "Windows": "win32"}
    architectures = {"AMD64": "x64", "x86_64": "x64", "arm64": "arm64", "aarch64": "arm64"}
    system = platforms.get(platform.system())
    machine = architectures.get(platform.machine())
    if not system or not machine:
        raise RuntimeError(f"unsupported build host: {platform.system()} {platform.machine()}")
    return f"{system}-{machine}"


def _executable(bundle_root: Path) -> Path:
    suffix = ".exe" if os.name == "nt" else ""
    return bundle_root / "lxeskill" / f"lxeskill{suffix}"


def _run_smoke(executable: Path) -> None:
    environment = {**os.environ, "LXE_ROOT": str(ROOT)}
    for arguments in (["--help"], ["list"], ["doctor"]):
        completed = subprocess.run(
            [str(executable), *arguments],
            cwd=ROOT,
            env=environment,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if completed.returncode != 0:
            raise RuntimeError(
                f"bundle smoke failed ({' '.join(arguments)}):\n{completed.stdout}\n{completed.stderr}"
            )
        lines = [line for line in completed.stdout.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError(f"bundle smoke produced no JSONL output: {' '.join(arguments)}")
        terminal = json.loads(lines[-1])
        if terminal.get("protocol_version") != "1" or terminal.get("type") != "result" or not terminal.get("ok"):
            raise RuntimeError(f"bundle smoke returned an invalid terminal record: {terminal}")

    playwright = subprocess.run(
        [str(executable), "--version"],
        cwd=ROOT,
        env={**environment, "LXESKILL_INTERNAL_PLAYWRIGHT_CLI": "1"},
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if playwright.returncode != 0 or "Version " not in playwright.stdout:
        raise RuntimeError(f"bundled Playwright driver is unusable:\n{playwright.stdout}\n{playwright.stderr}")

    imports = subprocess.run(
        [str(executable)],
        cwd=ROOT,
        env={**environment, "LXESKILL_INTERNAL_IMPORT_SMOKE": "1"},
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    if imports.returncode != 0:
        raise RuntimeError(f"frozen dynamic import smoke failed:\n{imports.stdout}\n{imports.stderr}")
    imported = json.loads(imports.stdout.strip())
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    expected_modules = sum(
        bool(str(entry.get("module") or "").strip())
        for entry in catalog.get("entries", [])
    )
    if not imported.get("ok") or imported.get("modules") != expected_modules:
        raise RuntimeError(f"frozen dynamic import smoke returned an invalid result: {imported}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Build and smoke-test the native lxeskill runtime bundle.")
    parser.add_argument("--skip-smoke", action="store_true")
    arguments = parser.parse_args()

    target = _target()
    vendor_root = PACKAGE_ROOT / "vendor" / target
    work_root = ROOT / "build" / "lxeskill" / target
    shutil.rmtree(vendor_root, ignore_errors=True)
    shutil.rmtree(work_root, ignore_errors=True)
    vendor_root.mkdir(parents=True, exist_ok=True)
    work_root.mkdir(parents=True, exist_ok=True)

    subprocess.run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(vendor_root),
            "--workpath",
            str(work_root),
            str(SPEC_PATH),
        ],
        cwd=ROOT,
        check=True,
    )
    executable = _executable(vendor_root)
    if not executable.is_file():
        raise RuntimeError(f"PyInstaller did not create the expected executable: {executable}")
    if not arguments.skip_smoke:
        _run_smoke(executable)

    size = sum(path.stat().st_size for path in (vendor_root / "lxeskill").rglob("*") if path.is_file())
    print(f"Built {target}: {executable} ({size / 1024 / 1024:.1f} MiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
