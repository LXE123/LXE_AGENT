"""App-wide Vietnam inputs, shared by Desktop and the ordinary lxeskill command.

The module entrypoint is a private Desktop bridge, not a model command. All
writes are atomic and serialized; the calculation keeps its own input snapshot.
"""
from __future__ import annotations

from contextlib import contextmanager
from dataclasses import asdict
from datetime import datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import shutil
from tempfile import TemporaryDirectory
from uuid import uuid4

from shared.process_lock import interprocess_lock
from shared.input_assets import current_asset, promote_asset, slot_dir
from shared.repository import state_root
from services.yacang.errors import safe_remote_detail
from .full_workbook import validate_full_template
from .validation_diagnostics import validation_diagnostic
from .workbook import RecommendationConfig, validate_recommendation_config

_FIELDS = tuple(asdict(RecommendationConfig()))
_DECIMAL = re.compile(r"^[+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$")


def data_directory() -> Path:
    return state_root() / "skill-data" / "vietnam-stock-recommendation"


def config_json(config: RecommendationConfig) -> dict[str, str]:
    return {key: str(value) for key, value in asdict(config).items()}


def parse_parameters(raw: object) -> RecommendationConfig:
    if not isinstance(raw, dict) or set(raw) != set(_FIELDS):
        raise ValueError(f"越南备货参数必须包含且仅包含: {', '.join(_FIELDS)}")
    values = {}
    for key in _FIELDS:
        value = raw[key]
        if not isinstance(value, str) or not 0 < len(value.strip()) <= 128 or not _DECIMAL.fullmatch(value.strip()):
            raise ValueError(f"{key} 必须是非负十进制数字文本")
        values[key] = Decimal(value.strip())
    result = RecommendationConfig(**values)
    validate_recommendation_config(result)
    return result


def _json(path: Path) -> object:
    if path.stat().st_size > 1024 * 1024:
        raise ValueError(f"配置文件超过 1 MiB: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def _write_parameters(root: Path, config: RecommendationConfig) -> None:
    temporary = root / f".parameters-{uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            json.dump(config_json(config), stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, root / "parameters.json")
    finally:
        temporary.unlink(missing_ok=True)


def _initialize_parameters(root: Path) -> RecommendationConfig:
    path = root / "parameters.json"
    if path.exists():
        return parse_parameters(_json(path))
    config = RecommendationConfig()
    _write_parameters(root, config)
    return config


@contextmanager
def _locked():
    root = data_directory()
    root.mkdir(parents=True, exist_ok=True)
    with interprocess_lock(root / ".settings.lock"):
        yield root


def read_state() -> dict:
    result = {"directory": str(data_directory()), "parameters": None, "parameters_error": None,
              "template": None, "template_error": None}
    with _locked() as root:
        try:
            result["parameters"] = config_json(_initialize_parameters(root))
        except Exception as exc:
            result["parameters_error"] = safe_remote_detail(f"{type(exc).__name__}: {exc}")
        try:
            version = current_asset("vietnam_full_workbook")
            if version is not None:
                validate_full_template(version.path)
                result["template"] = {
                    "path": str(version.path), "file_name": version.file_name,
                    "size_bytes": version.path.stat().st_size,
                    "updated_at": datetime.fromtimestamp(version.path.stat().st_mtime, timezone.utc).isoformat(),
                }
        except Exception as exc:
            result["template_error"] = validation_diagnostic(exc)
    return result


def save_parameters(raw: object) -> dict:
    config = parse_parameters(raw)
    with _locked() as root:
        _write_parameters(root, config)
    return read_state()


def upload_template(source: Path) -> dict:
    """Validate one nine-sheet snapshot before replacing the current asset."""
    if source.stat().st_size > 40 * 1024 * 1024:
        raise ValueError("越南备货模板超过 40 MiB")
    with TemporaryDirectory(prefix="vietnam-template-upload-") as directory:
        snapshot = Path(directory) / source.name
        shutil.copyfile(source, snapshot)
        validate_full_template(snapshot)
        with _locked():
            promote_asset("vietnam_full_workbook", snapshot)
    return read_state()


def export_template(destination: Path) -> dict:
    if not destination.is_absolute() or destination.suffix.lower() != ".xlsx":
        raise ValueError("模板导出路径必须是绝对 .xlsx 文件")
    if destination.resolve().is_relative_to(slot_dir("vietnam_full_workbook").resolve()):
        raise ValueError("模板导出不能覆盖应用内保存的模板")
    with _locked():
        current = current_asset("vietnam_full_workbook")
        if current is None:
            raise ValueError("尚未上传越南备货模板")
        validate_full_template(current.path)
        temporary = destination.parent / f".vietnam-template-export-{uuid4().hex}.xlsx"
        try:
            with current.path.open("rb") as reader, temporary.open("xb") as writer:
                shutil.copyfileobj(reader, writer)
                writer.flush()
                os.fsync(writer.fileno())
            os.replace(temporary, destination)
        finally:
            temporary.unlink(missing_ok=True)
    return {"path": str(destination)}


@contextmanager
def run_inputs():
    """Read the shared calculation settings for this run."""
    with _locked() as root:
        config = _initialize_parameters(root)
        source = str(root / "parameters.json")
    yield config, source


def main() -> int:
    import sys
    try:
        action = sys.argv[1]
        if action == "read" and len(sys.argv) == 2:
            result = read_state()
        elif action == "save" and len(sys.argv) == 3:
            result = save_parameters(json.loads(sys.argv[2]))
        elif action == "upload-template" and len(sys.argv) == 3:
            source = Path(sys.argv[2])
            if not source.is_absolute():
                raise ValueError("上传模板必须是绝对路径")
            result = upload_template(source)
        elif action == "export-template" and len(sys.argv) == 3:
            result = export_template(Path(sys.argv[2]))
        else:
            raise ValueError("无效的桌面设置操作")
        print(json.dumps({"success": True, "data": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"success": False, "error": validation_diagnostic(exc)}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
