"""Trusted two-generation store for the Desktop-managed Vietnam SKU map."""

from __future__ import annotations

from contextlib import contextmanager, suppress
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
from tempfile import TemporaryDirectory
from typing import Iterator, Literal
from uuid import uuid4
from zipfile import BadZipFile, ZipFile

from services.yacang.errors import safe_remote_detail
from shared.input_assets import slot_dir
from shared.process_lock import interprocess_lock

from .asset_contract import AssetContractError, validate_complete_sku_parameters


SKU_SLOT = "vietnam_sku_parameter_map"
MAX_COMPRESSED = 20 * 1024 * 1024
MAX_UNCOMPRESSED = 100 * 1024 * 1024
MAX_MEMBERS = 1000
REVISION_RE = re.compile(r"^[0-9a-f]{32}$")
_DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
_MANIFEST_NAME = "manifest.json"


class SkuMapStoreError(RuntimeError):
    """The managed map cannot be read or changed safely."""


@dataclass(frozen=True)
class SkuMapVersion:
    path: Path
    file_name: str
    size_bytes: int
    updated_at: str


@dataclass(frozen=True)
class SkuMapStatus:
    revision: str | None = None
    current: SkuMapVersion | None = None
    previous: SkuMapVersion | None = None
    current_error: str | None = None
    previous_error: str | None = None
    manifest_error: str | None = None


@dataclass(frozen=True)
class SkuMapMutation:
    status: Literal["installed", "unchanged", "rolled_back"]
    manifest_revision: str


@dataclass(frozen=True)
class _VersionRecord:
    id: str
    file_name: str
    sha256: str
    size_bytes: int
    uploaded_at: str


@dataclass(frozen=True)
class _Manifest:
    revision: str
    current: _VersionRecord | None
    previous: _VersionRecord | None


@dataclass(frozen=True)
class StagedCandidate:
    sha256: str
    file_name: str
    size_bytes: int
    staged_path: Path
    version: _VersionRecord


def _diagnostic(exc: BaseException) -> str:
    secrets = tuple(
        os.environ.get(name, "")
        for name in ("LXE_YACANG_MOBILE", "LXE_YACANG_PASSWORD")
    )
    return safe_remote_detail(f"{type(exc).__name__}: {exc}", secrets=secrets, limit=2000)


def _is_reparse(path: Path, info: os.stat_result) -> bool:
    flag = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return path.is_symlink() or bool(getattr(info, "st_file_attributes", 0) & flag)


def _existing_info(path: Path) -> os.stat_result | None:
    try:
        return path.lstat()
    except FileNotFoundError:
        return None


def _safe_directory(path: Path, *, create: bool = False) -> bool:
    info = _existing_info(path)
    if info is None:
        if not create:
            return False
        path.mkdir(parents=True, exist_ok=True)
        info = path.lstat()
    if _is_reparse(path, info) or not stat.S_ISDIR(info.st_mode):
        raise SkuMapStoreError(f"受控映射表目录不是普通目录: {path}")
    return True


def _safe_regular(path: Path, *, label: str) -> os.stat_result:
    info = _existing_info(path)
    if info is None:
        raise SkuMapStoreError(f"{label}缺失: {path}")
    if _is_reparse(path, info) or not stat.S_ISREG(info.st_mode):
        raise SkuMapStoreError(f"{label}不是普通文件: {path}")
    return info


def _root(*, create: bool) -> Path | None:
    root = slot_dir(SKU_SLOT)
    base = root.parent
    if not _safe_directory(base.parent, create=create):
        return None
    if not _safe_directory(base, create=create):
        return None
    if not _safe_directory(root, create=create):
        return None
    return root


def _versions(root: Path, *, create: bool) -> Path | None:
    path = root / "versions"
    return path if _safe_directory(path, create=create) else None


def _lock_path(root: Path) -> Path:
    path = root / ".manifest.lock"
    info = _existing_info(path)
    if info is not None and (_is_reparse(path, info) or not stat.S_ISREG(info.st_mode)):
        raise SkuMapStoreError("映射表锁文件不是普通文件")
    return path


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _safe_file_name(value: object) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > 255
        or value in (".", "..")
        or "/" in value
        or "\\" in value
        or any(ord(char) < 32 for char in value)
        or not value.lower().endswith(".xlsx")
    ):
        raise SkuMapStoreError("映射表清单包含无效文件名")
    return value


def _record_from_json(raw: object, label: str) -> _VersionRecord | None:
    if raw is None:
        return None
    if not isinstance(raw, dict) or set(raw) != {
        "id", "file_name", "sha256", "size_bytes", "uploaded_at"
    }:
        raise SkuMapStoreError(f"映射表清单 {label} 结构无效")
    version_id = raw["id"]
    sha256 = raw["sha256"]
    size = raw["size_bytes"]
    stamp = raw["uploaded_at"]
    if not isinstance(version_id, str) or not REVISION_RE.fullmatch(version_id):
        raise SkuMapStoreError(f"映射表清单 {label} 版本 ID 无效")
    if not isinstance(sha256, str) or not _DIGEST_RE.fullmatch(sha256):
        raise SkuMapStoreError(f"映射表清单 {label} 摘要无效")
    if type(size) is not int or size < 0 or size > MAX_COMPRESSED:
        raise SkuMapStoreError(f"映射表清单 {label} 大小无效")
    if not isinstance(stamp, str):
        raise SkuMapStoreError(f"映射表清单 {label} 时间无效")
    try:
        parsed = datetime.fromisoformat(stamp)
    except ValueError as exc:
        raise SkuMapStoreError(f"映射表清单 {label} 时间无效: {exc}") from exc
    if parsed.tzinfo is None:
        raise SkuMapStoreError(f"映射表清单 {label} 时间缺少时区")
    return _VersionRecord(version_id, _safe_file_name(raw["file_name"]), sha256, size, stamp)


def _read_manifest_strict(root: Path) -> _Manifest | None:
    path = root / _MANIFEST_NAME
    if _existing_info(path) is None:
        return None
    info = _safe_regular(path, label="映射表清单")
    if info.st_size > 64 * 1024:
        raise SkuMapStoreError("映射表清单超过 64 KiB")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise SkuMapStoreError(f"映射表清单无法读取: {_diagnostic(exc)}") from exc
    if not isinstance(raw, dict) or set(raw) != {"schema_version", "revision", "current", "previous"}:
        raise SkuMapStoreError("映射表清单结构无效")
    if type(raw["schema_version"]) is not int or raw["schema_version"] != 1:
        raise SkuMapStoreError("映射表清单版本无效")
    revision = raw["revision"]
    if not isinstance(revision, str) or not REVISION_RE.fullmatch(revision):
        raise SkuMapStoreError("映射表清单 revision 无效")
    current = _record_from_json(raw["current"], "current")
    previous = _record_from_json(raw["previous"], "previous")
    if current is None and previous is None:
        raise SkuMapStoreError("映射表清单没有有效版本指针")
    if current and previous and current.id == previous.id:
        raise SkuMapStoreError("映射表清单版本指针重复")
    return _Manifest(revision, current, previous)


def _check_zip(path: Path) -> None:
    try:
        with ZipFile(path) as archive:
            members = archive.infolist()
            if len(members) > MAX_MEMBERS:
                raise SkuMapStoreError(f"映射表 ZIP 条目超过 {MAX_MEMBERS} 个")
            uncompressed = 0
            for member in members:
                if member.flag_bits & 1:
                    raise SkuMapStoreError("映射表 ZIP 包含加密条目")
                uncompressed += member.file_size
                if uncompressed > MAX_UNCOMPRESSED:
                    raise SkuMapStoreError("映射表声明解压大小超过 100 MiB")
            if not members:
                raise SkuMapStoreError("映射表 ZIP 没有工作簿条目")
    except (BadZipFile, OSError, ValueError) as exc:
        raise SkuMapStoreError(f"映射表 ZIP 无法读取: {_diagnostic(exc)}") from exc


def _validate_file(path: Path, *, label: str) -> tuple[int, str]:
    info = _safe_regular(path, label=label)
    if info.st_size > MAX_COMPRESSED:
        raise SkuMapStoreError(f"{label}超过 20 MiB")
    if info.st_size == 0:
        raise SkuMapStoreError(f"{label}为空")
    if path.suffix.lower() != ".xlsx":
        raise SkuMapStoreError(f"{label}必须是 .xlsx 文件")
    _check_zip(path)
    try:
        validate_complete_sku_parameters(path)
    except AssetContractError as exc:
        raise SkuMapStoreError(str(exc)) from exc
    return info.st_size, _digest(path)


def _verified_version(root: Path, record: _VersionRecord) -> SkuMapVersion:
    versions = _versions(root, create=False)
    if versions is None:
        raise SkuMapStoreError("映射表版本目录缺失")
    path = versions / f"{record.id}.xlsx"
    size, digest = _validate_file(path, label="映射表版本")
    if size != record.size_bytes:
        raise SkuMapStoreError(f"映射表版本大小不符: {record.file_name}")
    if digest != record.sha256:
        raise SkuMapStoreError(f"映射表版本 SHA-256 不符: {record.file_name}")
    stamp = datetime.fromisoformat(record.uploaded_at).astimezone().strftime("%Y-%m-%d")
    return SkuMapVersion(path=path, file_name=record.file_name, size_bytes=size, updated_at=stamp)


def _inspect_locked(root: Path) -> SkuMapStatus:
    try:
        manifest = _read_manifest_strict(root)
    except SkuMapStoreError as exc:
        return SkuMapStatus(manifest_error=str(exc))
    if manifest is None:
        return SkuMapStatus()
    values: dict[str, SkuMapVersion | str | None] = {
        "current": None, "previous": None, "current_error": None, "previous_error": None,
    }
    for name in ("current", "previous"):
        record = getattr(manifest, name)
        if record is None:
            continue
        try:
            values[name] = _verified_version(root, record)
        except (SkuMapStoreError, OSError) as exc:
            values[f"{name}_error"] = str(exc) if isinstance(exc, SkuMapStoreError) else _diagnostic(exc)
    return SkuMapStatus(
        revision=manifest.revision,
        current=values["current"],
        previous=values["previous"],
        current_error=values["current_error"],
        previous_error=values["previous_error"],
    )


def inspect_sku_map() -> SkuMapStatus:
    try:
        root = _root(create=False)
        if root is None:
            return SkuMapStatus()
        with interprocess_lock(_lock_path(root)):
            return _inspect_locked(root)
    except (SkuMapStoreError, OSError) as exc:
        message = str(exc) if isinstance(exc, SkuMapStoreError) else _diagnostic(exc)
        return SkuMapStatus(manifest_error=message)


def trusted_version(generation: Literal["current", "previous"]) -> SkuMapVersion | None:
    if generation not in ("current", "previous"):
        raise ValueError(f"unknown generation: {generation}")
    status = inspect_sku_map()
    if status.manifest_error:
        raise SkuMapStoreError(status.manifest_error)
    error = getattr(status, f"{generation}_error")
    if error:
        raise SkuMapStoreError(error)
    return getattr(status, generation)


def _stage_and_validate_candidate(source: Path) -> StagedCandidate:
    root = _root(create=True)
    assert root is not None
    versions = _versions(root, create=True)
    assert versions is not None
    source = Path(source)
    if source.suffix.lower() != ".xlsx":
        raise SkuMapStoreError("候选映射表必须是 .xlsx 文件")
    _safe_file_name(source.name)
    size, digest = _validate_file(source, label="候选映射表")
    version_id = uuid4().hex
    staged = versions / f".{version_id}.stage.xlsx"
    try:
        with source.open("rb") as stream, staged.open("xb") as target:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                target.write(block)
            target.flush()
            os.fsync(target.fileno())
        stage_size, stage_digest = _validate_file(staged, label="暂存映射表")
        if stage_size != size or stage_digest != digest or _digest(source) != digest:
            raise SkuMapStoreError("候选映射表在复制期间已变化，请重新选择文件")
        uploaded_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        record = _VersionRecord(version_id, source.name, digest, size, uploaded_at)
        return StagedCandidate(digest, source.name, size, staged, record)
    except Exception:
        staged.unlink(missing_ok=True)
        raise


def _record_json(record: _VersionRecord | None) -> dict[str, object] | None:
    if record is None:
        return None
    return {
        "id": record.id, "file_name": record.file_name, "sha256": record.sha256,
        "size_bytes": record.size_bytes, "uploaded_at": record.uploaded_at,
    }


def _manifest_json(manifest: _Manifest) -> dict[str, object]:
    return {
        "schema_version": 1, "revision": manifest.revision,
        "current": _record_json(manifest.current), "previous": _record_json(manifest.previous),
    }


def _write_fsynced_manifest(manifest: _Manifest) -> Path:
    root = _root(create=True)
    assert root is not None
    path = root / f".manifest.{uuid4().hex}.tmp"
    try:
        with path.open("x", encoding="utf-8") as stream:
            json.dump(_manifest_json(manifest), stream, ensure_ascii=False, separators=(",", ":"))
            stream.flush()
            os.fsync(stream.fileno())
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise


def _commit_manifest(root: Path, manifest: _Manifest) -> None:
    temporary = _write_fsynced_manifest(manifest)
    try:
        os.replace(temporary, root / _MANIFEST_NAME)
    finally:
        # A cleanup error after replacement must not turn a committed pointer
        # into a reported failure.
        with suppress(Exception):
            temporary.unlink(missing_ok=True)


def _cleanup_orphans(root: Path, manifest: _Manifest | None) -> None:
    versions = _versions(root, create=False)
    if versions is None:
        return
    live = {record.id for record in (manifest.current, manifest.previous) if record is not None} if manifest else set()
    for path in versions.iterdir():
        if path.is_symlink():
            continue
        name = path.name
        if name.startswith(".") and name.endswith(".stage.xlsx"):
            path.unlink(missing_ok=True)
        elif name.endswith(".xlsx") and REVISION_RE.fullmatch(name[:-5]) and name[:-5] not in live:
            path.unlink(missing_ok=True)


def _cleanup_orphans_best_effort(root: Path, manifest: _Manifest | None) -> None:
    with suppress(Exception):
        _cleanup_orphans(root, manifest)


def _check_expected(expected: str | None, actual: str | None) -> None:
    if expected is not None and (not isinstance(expected, str) or not REVISION_RE.fullmatch(expected)):
        raise SkuMapStoreError("预期映射表 revision 无效")
    if expected != actual:
        raise SkuMapStoreError("映射表已变化，请刷新后重试")


def install_sku_map(source: Path, expected_revision: str | None) -> SkuMapMutation:
    root = _root(create=True)
    assert root is not None
    with interprocess_lock(_lock_path(root)):
        old = _read_manifest_strict(root)
        _check_expected(expected_revision, old.revision if old else None)
        _cleanup_orphans_best_effort(root, old)
        staged = _stage_and_validate_candidate(Path(source))
        final = root / "versions" / f"{staged.version.id}.xlsx"
        committed = False
        version_published = False
        try:
            old_status = _inspect_locked(root) if old else SkuMapStatus()
            if old and old.current and old_status.current and old.current.sha256 == staged.sha256:
                _cleanup_orphans_best_effort(root, old)
                return SkuMapMutation("unchanged", old.revision)
            if old and old.current and old_status.current:
                previous = old.current
            elif old and old.previous and old_status.previous:
                previous = old.previous
            else:
                previous = None
            os.replace(staged.staged_path, final)
            version_published = True
            next_manifest = _Manifest(uuid4().hex, staged.version, previous)
            _commit_manifest(root, next_manifest)
            committed = True
            _cleanup_orphans_best_effort(root, next_manifest)
            return SkuMapMutation("installed", next_manifest.revision)
        finally:
            with suppress(Exception):
                staged.staged_path.unlink(missing_ok=True)
            if version_published and not committed:
                with suppress(Exception):
                    final.unlink(missing_ok=True)


def rollback_sku_map(expected_revision: str | None) -> SkuMapMutation:
    root = _root(create=False)
    if root is None:
        raise SkuMapStoreError("没有可回滚的映射表版本")
    with interprocess_lock(_lock_path(root)):
        old = _read_manifest_strict(root)
        _check_expected(expected_revision, old.revision if old else None)
        _cleanup_orphans_best_effort(root, old)
        if old is None or old.previous is None:
            raise SkuMapStoreError("没有可回滚的映射表版本")
        status = _inspect_locked(root)
        if status.previous_error or status.previous is None:
            raise SkuMapStoreError(status.previous_error or "previous 映射表版本无效")
        previous = old.current if old.current and status.current is not None else None
        next_manifest = _Manifest(uuid4().hex, old.previous, previous)
        _commit_manifest(root, next_manifest)
        _cleanup_orphans_best_effort(root, next_manifest)
        return SkuMapMutation("rolled_back", next_manifest.revision)


@contextmanager
def current_sku_map_snapshot() -> Iterator[Path]:
    with TemporaryDirectory(prefix="vietnam-sku-map-") as directory:
        snapshot = Path(directory) / "current.xlsx"
        root = _root(create=False)
        if root is None:
            raise SkuMapStoreError("请先上传越南 SKU 参数映射表")
        with interprocess_lock(_lock_path(root)):
            manifest = _read_manifest_strict(root)
            if manifest is None or manifest.current is None:
                raise SkuMapStoreError("请先上传越南 SKU 参数映射表")
            version = _verified_version(root, manifest.current)
            shutil.copyfile(version.path, snapshot)
            size, digest = _validate_file(snapshot, label="映射表私有快照")
            if size != manifest.current.size_bytes or digest != manifest.current.sha256:
                raise SkuMapStoreError("映射表私有快照与受信版本不一致")
        yield snapshot


__all__ = [
    "SKU_SLOT", "SkuMapMutation", "SkuMapStatus", "SkuMapStoreError", "SkuMapVersion",
    "current_sku_map_snapshot", "inspect_sku_map", "install_sku_map",
    "rollback_sku_map", "trusted_version",
]
