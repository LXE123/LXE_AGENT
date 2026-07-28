from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import struct
import subprocess

import pytest

from services.media import synthetic_performer as media


REAL_EXIFTOOL = Path(os.environ.get("LXE_EXIFTOOL_PATH", ""))


def _xmp(*values: str, bag: bool = True) -> bytes:
    items = "".join(f"<rdf:li>{value}</rdf:li>" for value in values)
    container = f"<rdf:Bag>{items}</rdf:Bag>" if bag else items
    return (
        "<x:xmpmeta xmlns:x='adobe:ns:meta/'>"
        "<rdf:RDF xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns#'>"
        "<rdf:Description xmlns:dc='http://purl.org/dc/elements/1.1/'>"
        f"<dc:subject>{container}</dc:subject>"
        "</rdf:Description></rdf:RDF></x:xmpmeta>"
    ).encode()


def test_subject_validation_requires_exact_rdf_bag_item() -> None:
    assert media._subject_values(_xmp("existing", media.KEYWORD)) == ["existing", media.KEYWORD]
    assert media.KEYWORD not in media._subject_values(_xmp(f" {media.KEYWORD} extra"))
    assert media._subject_values(_xmp(media.KEYWORD, bag=False)) == []
    assert media._subject_values(b"") == []


def test_scan_reports_supported_existing_unsupported_and_real_failure(tmp_path: Path, monkeypatch) -> None:
    needs_tag = tmp_path / "needs.jpg"
    tagged = tmp_path / "tagged.mp4"
    unsupported = tmp_path / "notes.txt"
    broken = tmp_path / "broken.png"
    for path in (needs_tag, tagged, unsupported, broken):
        path.write_bytes(path.name.encode())

    def fake_has_keyword(path: Path) -> bool:
        if path.name == "broken.png":
            raise media.MediaTagError("malformed XMP from fixture")
        return path.name == "tagged.mp4"

    monkeypatch.setattr(media, "_has_keyword", fake_has_keyword)
    events: list[dict] = []

    result = media.run_with_events(
        {"action": "scan", "sources": [str(tmp_path)], "recursive": False},
        events.append,
    )

    statuses = {item["name"]: item["status"] for item in result["items"]}
    assert statuses == {
        "broken.png": "failed",
        "needs.jpg": "needs_tag",
        "notes.txt": "unsupported",
        "tagged.mp4": "already_tagged",
    }
    assert result["counts"] == {
        "needs_tag": 1,
        "already_tagged": 1,
        "unsupported": 1,
        "failed": 1,
    }
    assert "malformed XMP from fixture" in result["items"][0]["error"]
    assert events[-1]["processed"] == 4


def test_apply_creates_complete_verified_batch_without_touching_sources(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source"
    output = tmp_path / "output"
    source.mkdir()
    missing = source / "missing.jpg"
    tagged = source / "tagged.mov"
    missing.write_bytes(b"missing-original")
    tagged.write_bytes(b"tagged-original")
    before = {path.name: path.read_bytes() for path in (missing, tagged)}

    def fake_has_keyword(path: Path) -> bool:
        return path.parent == output or path.name == "tagged.mov"

    def fake_copy_or_tag(path: Path, destination: Path, already_tagged: bool) -> str:
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(path.read_bytes())
        return "copied" if already_tagged else "tagged"

    monkeypatch.setattr(media, "_has_keyword", fake_has_keyword)
    monkeypatch.setattr(media, "_copy_or_tag", fake_copy_or_tag)

    result = media.run_with_events(
        {
            "action": "apply",
            "sources": [str(source)],
            "recursive": False,
            "output_directory": str(output),
        },
        lambda _event: None,
    )

    assert result["counts"] == {"tagged": 1, "copied": 1, "failed": 0}
    assert {item["status"] for item in result["items"]} == {"tagged", "copied"}
    assert {path.name: path.read_bytes() for path in (missing, tagged)} == before
    assert (output / "missing.jpg").read_bytes() == before["missing.jpg"]
    assert (output / "tagged.mov").read_bytes() == before["tagged.mov"]


def test_exiftool_failure_preserves_real_stderr(tmp_path: Path, monkeypatch) -> None:
    executable = tmp_path / "exiftool.exe"
    executable.write_bytes(b"fixture")
    monkeypatch.setenv("LXE_EXIFTOOL_PATH", str(executable))
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            args=[], returncode=9, stdout=b"", stderr=b"Malformed XMP packet at byte 42"
        ),
    )

    with pytest.raises(media.MediaTagError, match="Malformed XMP packet at byte 42"):
        media._run_exiftool(["-ver"])


def test_copy_or_tag_appends_subject_without_overwriting_source(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "视频.mp4"
    destination = tmp_path / "output" / "视频.mp4"
    source.write_bytes(b"ftyp-original-mdat-payload")
    original = source.read_bytes()
    calls: list[list[str]] = []

    def fake_run(arguments: list[str], *, timeout: int = 1_800) -> subprocess.CompletedProcess[bytes]:
        del timeout
        calls.append(arguments)
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(source.read_bytes() + b"xmp-metadata")
        return subprocess.CompletedProcess(args=[], returncode=0, stdout=b"", stderr=b"")

    monkeypatch.setattr(media, "_run_exiftool", fake_run)

    assert media._copy_or_tag(source, destination, already_tagged=False) == "tagged"
    assert source.read_bytes() == original
    assert calls == [[
        "-api",
        "NoDups=1",
        "-o",
        str(destination),
        f"-XMP-dc:Subject+={media.KEYWORD}",
        str(source),
    ]]


def test_apply_never_deletes_an_existing_destination(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source"
    output = tmp_path / "output"
    source.mkdir()
    output.mkdir()
    source_file = source / "same.png"
    destination = output / "same.png"
    source_file.write_bytes(b"source-image-data")
    destination.write_bytes(b"keep-existing-output")
    monkeypatch.setattr(media, "_has_keyword", lambda _path: False)

    result = media.run_with_events(
        {
            "action": "apply",
            "sources": [str(source)],
            "recursive": False,
            "output_directory": str(output),
        },
        lambda _event: None,
    )

    assert result["counts"] == {"tagged": 0, "copied": 0, "failed": 1}
    assert "output file already exists" in result["items"][0]["error"]
    assert destination.read_bytes() == b"keep-existing-output"
    assert source_file.read_bytes() == b"source-image-data"


def test_recursive_scan_handles_chinese_names_and_mixed_media(tmp_path: Path, monkeypatch) -> None:
    nested = tmp_path / "子文件夹"
    nested.mkdir()
    (tmp_path / "封面.JPG").write_bytes(b"jpeg")
    (nested / "人物.MOV").write_bytes(b"video")
    (nested / "说明.txt").write_text("text", encoding="utf-8")
    monkeypatch.setattr(media, "_has_keyword", lambda _path: False)

    flat = media.run_with_events(
        {"action": "scan", "sources": [str(tmp_path)], "recursive": False},
        lambda _event: None,
    )
    recursive = media.run_with_events(
        {"action": "scan", "sources": [str(tmp_path)], "recursive": True},
        lambda _event: None,
    )

    assert [item["relative_path"] for item in flat["items"]] == ["封面.JPG"]
    assert {item["relative_path"] for item in recursive["items"]} == {
        "封面.JPG",
        "子文件夹/人物.MOV",
        "子文件夹/说明.txt",
    }
    assert recursive["counts"] == {
        "needs_tag": 2,
        "already_tagged": 0,
        "unsupported": 1,
        "failed": 0,
    }


@pytest.mark.skipif(not REAL_EXIFTOOL.is_file(), reason="real ExifTool is not configured")
def test_real_exiftool_preserves_media_payloads_and_existing_keywords(tmp_path: Path) -> None:
    source = tmp_path / "source"
    output = tmp_path / "output"
    source.mkdir()
    repository = Path.cwd()
    shutil.copy2(repository / "apps/desktop/build/icon-win.png", source / "图标.png")
    shutil.copy2(
        repository
        / "skills/replenishment-amazon-restock-inventory-snapshot/assets"
        / "amazon_restock_inventory_download_step_1_menu.jpg",
        source / "已有关键词.jpg",
    )
    media_payload = bytes(range(256)) * 8
    quicktime = (
        struct.pack(">I4s", 8, b"moov")
        + struct.pack(">I4s", len(media_payload) + 8, b"mdat")
        + media_payload
    )
    (source / "视频.mov").write_bytes(quicktime)
    (source / "视频.mp4").write_bytes(quicktime)
    media._run_exiftool([
        "-overwrite_original",
        "-XMP-dc:Subject=existing-keyword",
        str(source / "已有关键词.jpg"),
    ])
    source_hashes = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in source.iterdir()
    }

    result = media.run_with_events(
        {
            "action": "apply",
            "sources": [str(source)],
            "recursive": False,
            "output_directory": str(output),
        },
        lambda _event: None,
    )

    assert result["counts"] == {"tagged": 4, "copied": 0, "failed": 0}
    assert source_hashes == {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in source.iterdir()
    }
    subjects = media._subject_values(media._raw_xmp(output / "已有关键词.jpg"))
    assert subjects == ["existing-keyword", media.KEYWORD]
    for name in ("图标.png", "已有关键词.jpg", "视频.mov", "视频.mp4"):
        assert media._subject_values(media._raw_xmp(output / name)).count(media.KEYWORD) == 1

    def png_payload(path: Path) -> bytes:
        data = path.read_bytes()
        offset = 8
        chunks: list[bytes] = []
        while offset + 12 <= len(data):
            length = struct.unpack(">I", data[offset:offset + 4])[0]
            if data[offset + 4:offset + 8] == b"IDAT":
                chunks.append(data[offset + 8:offset + 8 + length])
            offset += 12 + length
        return b"".join(chunks)

    def jpeg_payload(path: Path) -> bytes:
        data = path.read_bytes()
        marker = data.index(b"\xff\xda")
        header_length = struct.unpack(">H", data[marker + 2:marker + 4])[0]
        return data[marker + 2 + header_length:data.rindex(b"\xff\xd9")]

    def mdat_payload(path: Path) -> bytes:
        data = path.read_bytes()
        offset = 0
        chunks: list[bytes] = []
        while offset + 8 <= len(data):
            size = struct.unpack(">I", data[offset:offset + 4])[0]
            kind = data[offset + 4:offset + 8]
            if kind == b"mdat":
                chunks.append(data[offset + 8:offset + size])
            offset += size
        return b"".join(chunks)

    assert png_payload(source / "图标.png") == png_payload(output / "图标.png")
    assert jpeg_payload(source / "已有关键词.jpg") == jpeg_payload(output / "已有关键词.jpg")
    assert mdat_payload(source / "视频.mov") == mdat_payload(output / "视频.mov") == media_payload
    assert mdat_payload(source / "视频.mp4") == mdat_payload(output / "视频.mp4") == media_payload


def test_public_run_returns_failure_envelope_for_invalid_input() -> None:
    result = media.run({"action": "scan", "sources": []})
    assert result["success"] is False
    assert "sources must be a non-empty array" in result["exception"]

    recursive = media.run({"action": "scan", "sources": [str(Path.cwd())], "recursive": "yes"})
    assert recursive["success"] is False
    assert "recursive must be a boolean" in recursive["exception"]
