"""Validate SKU workbooks before saving or taking a calculation snapshot."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat
from zipfile import BadZipFile, ZipFile

from services.yacang.errors import safe_remote_detail

from .asset_contract import (
    AssetContractError,
    validate_usable_sku_parameters,
)


MAX_COMPRESSED = 20 * 1024 * 1024
MAX_UNCOMPRESSED = 100 * 1024 * 1024
MAX_MEMBERS = 1000


class SkuMapStoreError(RuntimeError):
    """The SKU map cannot be read or changed safely."""


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


def _safe_regular(path: Path, *, label: str) -> os.stat_result:
    info = _existing_info(path)
    if info is None:
        raise SkuMapStoreError(f"{label}缺失: {path}")
    if _is_reparse(path, info) or not stat.S_ISREG(info.st_mode):
        raise SkuMapStoreError(f"{label}不是普通文件: {path}")
    return info


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


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


def validate_sku_map(path: Path, *, label: str) -> tuple[int, str]:
    info = _safe_regular(path, label=label)
    if info.st_size > MAX_COMPRESSED:
        raise SkuMapStoreError(f"{label}超过 20 MiB")
    if info.st_size == 0:
        raise SkuMapStoreError(f"{label}为空")
    if path.suffix.lower() != ".xlsx":
        raise SkuMapStoreError(f"{label}必须是 .xlsx 文件")
    _check_zip(path)
    try:
        validate_usable_sku_parameters(path)
    except AssetContractError as exc:
        raise SkuMapStoreError(str(exc)) from exc
    return info.st_size, _digest(path)
