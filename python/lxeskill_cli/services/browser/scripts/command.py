from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from shared.bounded_worker import run_worker
from shared.datasets import dataset_dir


class ScriptFailure(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def diagnostic(message: str, store_id: str) -> str:
    for key, value in os.environ.items():
        if value and re.search(r"password|secret|token|cookie|api.?key|authorization", key, re.I):
            message = message.replace(value, "[REDACTED]")
    if store_id:
        message = message.replace(store_id, "[store]")
    return message if len(message) <= 8192 else message[:8192] + " … [truncated]"


def run_script(arguments: dict[str, Any], session_id: str) -> tuple[dict, list[str]]:
    extra = arguments.keys() - {"store_id", "script_file", "params_file", "timeout_sec"}
    if extra:
        raise ValueError(f"Unknown script options: {', '.join(sorted(extra))}")
    store_id = arguments.get("store_id")
    if not isinstance(store_id, str) or not store_id.strip():
        raise ValueError("store_id is required")
    timeout = arguments.get("timeout_sec", 180)
    if type(timeout) is not int or not 1 <= timeout <= 600:
        raise ValueError("timeout_sec must be an integer from 1 to 600")
    if not isinstance(arguments.get("script_file"), str) or not arguments["script_file"].strip():
        raise ValueError("script_file is required")
    script = Path(arguments["script_file"]).expanduser().resolve(strict=True)
    if not script.is_file() or script.suffix.lower() != ".js":
        raise ValueError(f"Expected a .js file: {script}")
    params = {}
    if "params_file" in arguments:
        params = json.loads(Path(arguments["params_file"]).expanduser().read_text(encoding="utf-8-sig"))
        if not isinstance(params, dict):
            raise ValueError("params_file must contain a JSON object")
    node = shutil.which("node")
    if not node:
        raise FileNotFoundError("node executable not found on PATH")

    root = dataset_dir("browser_store_agent", hashlib.sha256(session_id.encode()).hexdigest()[:24])
    root.mkdir(parents=True, exist_ok=True)
    output = Path(tempfile.mkdtemp(dir=root))
    keep = False
    try:
        request = dict(store_id=store_id.strip(), script=str(script), params=params,
                       timeout=timeout, output=str(output), node=node)
        process = run_worker("services.browser.scripts.worker", [],
                             input_text=json.dumps(request, allow_nan=False), timeout_seconds=timeout)
        detail = diagnostic(process.stderr.strip(), store_id)
        if detail:
            print(detail, file=sys.stderr)
        if not process.stdout.strip():
            raise ScriptFailure("script_failed", detail or f"Script worker exited with code {process.returncode}")
        reply = json.loads(process.stdout)
        if not reply["ok"]:
            raise ScriptFailure(reply["code"], diagnostic(reply["error"], store_id))
        if process.returncode:
            raise ScriptFailure("script_failed", detail or f"Script worker exited with code {process.returncode}")
        files = reply["files"]
        for name in files:
            path = Path(name).resolve(strict=True)
            if not path.is_relative_to(output.resolve()) or not path.is_file():
                raise ValueError(f"Invalid downloaded artifact: {name}")
        keep = bool(files)
        return {"result": reply["result"], "downloads": files}, files
    except subprocess.TimeoutExpired as exc:
        detail = diagnostic(str(exc.stderr or "").strip(), store_id)
        raise ScriptFailure("script_timeout", f"Script exceeded {timeout}s" + (f"\n{detail}" if detail else "")) from exc
    finally:
        if not keep:
            shutil.rmtree(output)
