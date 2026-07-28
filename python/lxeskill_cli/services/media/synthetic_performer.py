from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
from typing import Any, Callable, Iterable
import xml.etree.ElementTree as ET


KEYWORD = "contains-synthetic-performer"
SUPPORTED_EXTENSIONS = frozenset({".jpg", ".jpeg", ".png", ".mp4", ".mov"})
VIDEO_EXTENSIONS = frozenset({".mp4", ".mov"})
RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DC_NAMESPACE = "http://purl.org/dc/elements/1.1/"
MAX_ERROR_LENGTH = 4_096


class MediaTagError(RuntimeError):
    pass


def _error_text(value: str) -> str:
    text = value.strip()
    return text if len(text) <= MAX_ERROR_LENGTH else f"…{text[-MAX_ERROR_LENGTH:]}"


def _exiftool_path() -> str:
    path = str(os.environ.get("LXE_EXIFTOOL_PATH") or "").strip()
    if not path:
        raise MediaTagError("LXE_EXIFTOOL_PATH is not configured")
    candidate = Path(path).expanduser()
    if not candidate.is_file():
        raise MediaTagError(f"ExifTool is unavailable: {candidate}")
    return str(candidate)


def _run_exiftool(arguments: list[str], *, timeout: int = 1_800) -> subprocess.CompletedProcess[bytes]:
    command = [_exiftool_path(), "-api", "LargeFileSupport=1", *arguments]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise MediaTagError(f"ExifTool timed out after {timeout} seconds") from exc
    except OSError as exc:
        raise MediaTagError(f"Could not start ExifTool: {type(exc).__name__}: {exc}") from exc
    if completed.returncode != 0:
        stderr = completed.stderr.decode("utf-8", errors="replace")
        stdout = completed.stdout.decode("utf-8", errors="replace")
        detail = _error_text(stderr or stdout or "no error output")
        raise MediaTagError(f"ExifTool exited with {completed.returncode}: {detail}")
    return completed


def _raw_xmp(path: Path) -> bytes:
    return _run_exiftool(["-b", "-XMP", str(path)]).stdout


def _subject_values(raw_xmp: bytes) -> list[str]:
    if not raw_xmp.strip():
        return []
    try:
        root = ET.fromstring(raw_xmp)
    except ET.ParseError as exc:
        raise MediaTagError(f"Invalid XMP metadata: {exc}") from exc
    values: list[str] = []
    subject_tag = f"{{{DC_NAMESPACE}}}subject"
    bag_tag = f"{{{RDF_NAMESPACE}}}Bag"
    item_tag = f"{{{RDF_NAMESPACE}}}li"
    for subject in root.iter(subject_tag):
        for bag in subject.findall(bag_tag):
            values.extend(
                str(item.text or "").strip()
                for item in bag.findall(item_tag)
                if str(item.text or "").strip()
            )
    return values


def _has_keyword(path: Path) -> bool:
    return KEYWORD in _subject_values(_raw_xmp(path))


def _validated_sources(raw_sources: Any) -> list[Path]:
    if not isinstance(raw_sources, list) or not raw_sources:
        raise MediaTagError("sources must be a non-empty array")
    sources: list[Path] = []
    for raw in raw_sources:
        if not isinstance(raw, str) or not raw.strip():
            raise MediaTagError("sources must contain non-empty paths")
        path = Path(raw).expanduser()
        if not path.is_absolute():
            raise MediaTagError(f"source path must be absolute: {raw}")
        if not path.exists():
            raise MediaTagError(f"source path does not exist: {path}")
        sources.append(path.resolve())
    return sources


def _source_files(sources: Iterable[Path], recursive: bool) -> list[tuple[Path, str]]:
    discovered: list[tuple[Path, str]] = []
    relative_names: set[str] = set()
    for source in sources:
        if source.is_file():
            candidates = [(source, source.name)]
        elif source.is_dir():
            iterator = source.rglob("*") if recursive else source.iterdir()
            candidates = [
                (path, path.relative_to(source).as_posix())
                for path in iterator
                if path.is_file() and not path.is_symlink()
            ]
        else:
            continue
        for path, relative_name in candidates:
            normalized = relative_name.casefold()
            if normalized in relative_names:
                raise MediaTagError(f"multiple source files map to the same output path: {relative_name}")
            relative_names.add(normalized)
            discovered.append((path, relative_name))
    return sorted(discovered, key=lambda item: item[1].casefold())


def _media_type(path: Path) -> str:
    return "video" if path.suffix.casefold() in VIDEO_EXTENSIONS else "image"


def _record(path: Path, relative_name: str, status: str, *, error: str = "") -> dict[str, Any]:
    try:
        size_bytes = path.stat().st_size
    except OSError:
        size_bytes = 0
    return {
        "name": path.name,
        "relative_path": relative_name,
        "media_type": _media_type(path),
        "status": status,
        "size_bytes": size_bytes,
        **({"error": _error_text(error)} if error else {}),
    }


def _scan(
    files: list[tuple[Path, str]],
    emit: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    total = len(files)
    for index, (path, relative_name) in enumerate(files, start=1):
        emit({"stage": "scan", "processed": index - 1, "total": total, "current_file": relative_name})
        if path.suffix.casefold() not in SUPPORTED_EXTENSIONS:
            item = _record(path, relative_name, "unsupported")
        else:
            try:
                item = _record(path, relative_name, "already_tagged" if _has_keyword(path) else "needs_tag")
            except Exception as exc:  # noqa: BLE001 - per-file failures remain visible to the caller
                item = _record(path, relative_name, "failed", error=f"{type(exc).__name__}: {exc}")
        items.append(item)
        emit({"stage": "scan", "processed": index, "total": total, "current_file": relative_name, "status": item["status"]})
    return {
        "success": True,
        "action": "scan",
        "keyword": KEYWORD,
        "items": items,
        "counts": {status: sum(item["status"] == status for item in items) for status in (
            "needs_tag", "already_tagged", "unsupported", "failed"
        )},
    }


def _copy_or_tag(source: Path, destination: Path, already_tagged: bool) -> str:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        raise MediaTagError(f"output file already exists: {destination}")
    if already_tagged:
        shutil.copy2(source, destination)
        return "copied"
    _run_exiftool([
        "-api",
        "NoDups=1",
        "-o",
        str(destination),
        f"-XMP-dc:Subject+={KEYWORD}",
        str(source),
    ])
    if not destination.is_file():
        raise MediaTagError(f"ExifTool did not create the output file: {destination}")
    return "tagged"


def _apply(
    files: list[tuple[Path, str]],
    output_directory: Path,
    emit: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    if output_directory.exists() and not output_directory.is_dir():
        raise MediaTagError(f"output_directory is not a directory: {output_directory}")
    output_directory.mkdir(parents=True, exist_ok=True)
    items: list[dict[str, Any]] = []
    supported = [(path, relative_name) for path, relative_name in files if path.suffix.casefold() in SUPPORTED_EXTENSIONS]
    total = len(supported)
    for index, (path, relative_name) in enumerate(supported, start=1):
        emit({"stage": "apply", "processed": index - 1, "total": total, "current_file": relative_name})
        destination = output_directory.joinpath(*Path(relative_name).parts)
        destination_existed = destination.exists()
        try:
            already_tagged = _has_keyword(path)
            status = _copy_or_tag(path, destination, already_tagged)
            if not _has_keyword(destination):
                raise MediaTagError("verification failed: XMP dc:subject rdf:Bag does not contain the required rdf:li")
            item = _record(path, relative_name, status)
        except Exception as exc:  # noqa: BLE001 - preserve partial batch results
            item = _record(path, relative_name, "failed", error=f"{type(exc).__name__}: {exc}")
            if not destination_existed and destination.exists():
                destination.unlink(missing_ok=True)
        items.append(item)
        emit({"stage": "verify", "processed": index, "total": total, "current_file": relative_name, "status": item["status"]})
    return {
        "success": True,
        "action": "apply",
        "keyword": KEYWORD,
        "output_directory": str(output_directory),
        "items": items,
        "counts": {status: sum(item["status"] == status for item in items) for status in (
            "tagged", "copied", "failed"
        )},
    }


def run_with_events(arguments: dict[str, Any], emit: Callable[[dict[str, Any]], None]) -> dict[str, Any]:
    action = str(arguments.get("action") or "").strip()
    if action not in {"scan", "apply"}:
        raise MediaTagError("action must be scan or apply")
    sources = _validated_sources(arguments.get("sources"))
    recursive = arguments.get("recursive", False)
    if not isinstance(recursive, bool):
        raise MediaTagError("recursive must be a boolean")
    files = _source_files(sources, recursive)
    if action == "scan":
        return _scan(files, emit)
    raw_output = str(arguments.get("output_directory") or "").strip()
    if not raw_output:
        raise MediaTagError("output_directory is required for apply")
    output_directory = Path(raw_output).expanduser()
    if not output_directory.is_absolute():
        raise MediaTagError("output_directory must be absolute")
    return _apply(files, output_directory.resolve(), emit)


def run(arguments: dict[str, Any]) -> dict[str, Any]:
    try:
        return run_with_events(arguments, lambda _event: None)
    except Exception as exc:  # noqa: BLE001 - public business modules return failure envelopes
        return {"success": False, "exception": f"{type(exc).__name__}: {exc}"}


__all__ = ["KEYWORD", "SUPPORTED_EXTENSIONS", "run", "run_with_events"]
