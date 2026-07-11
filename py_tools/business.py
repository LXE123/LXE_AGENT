from __future__ import annotations

import contextlib
import importlib
import io
import json
from pathlib import Path
from typing import Any

from shared.logging import get_logger


logger = get_logger(__name__)
_PROJECT_ROOT = Path(__file__).resolve().parents[1]


def load_catalog() -> dict[str, dict[str, Any]]:
    path = Path(__file__).with_name("catalog.json")
    document = json.loads(path.read_text(encoding="utf-8"))
    if str(document.get("protocol_version") or "") != "1":
        raise RuntimeError("invalid script tool catalog protocol")
    entries: dict[str, dict[str, Any]] = {}
    modules: set[str] = set()
    for raw in list(document.get("entries") or []):
        entry = dict(raw or {})
        name = str(entry.get("name") or "").strip()
        module = str(entry.get("module") or "").strip()
        handler = str(entry.get("handler") or "").strip()
        if not name or name in entries:
            raise RuntimeError(f"duplicate or empty script tool name: {name}")
        if not module and not handler:
            raise RuntimeError(f"script tool has no handler: {name}")
        if module:
            if module in modules:
                raise RuntimeError(f"duplicate script tool module: {module}")
            modules.add(module)
            expected = (
                "amazon_logistic_quote"
                if module == "services.agent_cli.amazon_logistic.run"
                else f"mabang_{module.rsplit('.', 1)[-1]}"
                if module.startswith("services.agent_cli.mabang.")
                else f"amazon_fba_{module.rsplit('.', 1)[-1]}"
                if module.startswith("services.agent_cli.browser.amazon_fba.")
                else ""
            )
            if expected != name:
                raise RuntimeError(f"script tool naming mismatch: {module} -> {name}")
        entries[name] = entry
    return entries


def _argv(arguments: dict[str, Any], positional: list[str]) -> list[str]:
    output: list[str] = []
    for key in positional:
        value = arguments.get(key)
        if value is None or str(value).strip() == "":
            raise ValueError(f"missing positional argument: {key}")
        output.append(str(value))
    for key, value in arguments.items():
        if key in positional or value is None or value is False:
            continue
        flag = f"--{str(key).replace('_', '-')}"
        if value is True:
            output.append(flag)
        elif isinstance(value, list):
            for item in value:
                output.extend((flag, str(item)))
        else:
            output.extend((flag, str(value)))
    return output


def _allowed_file(raw_path: str) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = _PROJECT_ROOT / path
    resolved = path.resolve()
    relation = resolved.relative_to(_PROJECT_ROOT).as_posix()
    if not (
        relation.startswith("artifacts/")
        or relation.startswith("skills/") and "/assets/" in f"/{relation}"
    ):
        raise ValueError(f"business CLI returned a file outside allowed artifact roots: {raw_path}")
    if not resolved.is_file():
        raise ValueError(f"business CLI returned a missing file: {raw_path}")
    return resolved


def _collect_files(value: Any, *, key: str = "") -> list[str]:
    candidates: list[str] = []
    if isinstance(value, dict):
        for child_key, child in value.items():
            normalized = str(child_key).lower()
            if normalized == "files" and isinstance(child, list):
                candidates.extend(str(item) for item in child if str(item).strip())
            elif (
                normalized in {"file", "file_path", "xlsx_path", "csv_path", "markdown_path"}
                or normalized.endswith("_file_path")
                or normalized.startswith(("output_", "result_", "validation_report_"))
                and normalized.endswith(("_xlsx", "_csv", "_file"))
            ):
                if isinstance(child, str) and child.strip():
                    candidates.append(child)
                elif isinstance(child, list):
                    for item in child:
                        if isinstance(item, str) and item.strip():
                            candidates.append(item)
                        elif isinstance(item, dict):
                            raw_value = str(item.get("value") or item.get("path") or "").strip()
                            if raw_value:
                                candidates.append(raw_value)
            else:
                candidates.extend(_collect_files(child, key=normalized))
    elif isinstance(value, list):
        for child in value:
            candidates.extend(_collect_files(child, key=key))
    output: list[str] = []
    for candidate in candidates:
        path = str(_allowed_file(candidate))
        if path not in output:
            output.append(path)
    return output


def execute_module_json(
    entry: dict[str, Any],
    arguments: dict[str, Any],
    _session: dict[str, Any],
) -> tuple[bool, list[dict[str, Any]], list[str], dict[str, str] | None]:
    module_name = str(entry.get("module") or "").strip()
    module = importlib.import_module(module_name)
    main = getattr(module, "main", None)
    if not callable(main):
        raise RuntimeError(f"business CLI has no callable main(): {module_name}")
    stdout = io.StringIO()
    argv = _argv(dict(arguments or {}), [str(item) for item in list(entry.get("positional") or [])])
    with contextlib.redirect_stdout(stdout):
        try:
            exit_code = int(main(argv) or 0)
        except SystemExit as exc:
            exit_code = int(exc.code or 0)
    lines = [line.strip() for line in stdout.getvalue().splitlines() if line.strip()]
    if not lines:
        raise RuntimeError(f"business CLI returned no JSON: {module_name}")
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"business CLI returned malformed JSON: {module_name}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"business CLI response must be an object: {module_name}")
    success = bool(payload.get("success")) if "success" in payload else exit_code == 0
    if "finished" in payload:
        success = success and bool(payload.get("finished"))
    files = _collect_files(payload) if success else []
    content = [{"type": "text", "text": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}]
    if success:
        return True, content, files, None
    message = str(payload.get("exception") or payload.get("message") or payload.get("notice") or f"{module_name} failed").strip()
    return False, content, [], {"code": "business_cli_failed", "message": message}


__all__ = ["execute_module_json", "load_catalog"]
