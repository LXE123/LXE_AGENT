"""基础编码工具 -- 文件读写、搜索、命令执行。

直接注册到 UnifiedToolRegistry。这里的 workspace 指项目根目录（WORKSPACE_ROOT）。
所有文件操作限制在 WORKSPACE_ROOT 内。
不走 ToolBase 旧体系，不走 browser executor 链路。
"""
from __future__ import annotations

import asyncio
import base64
import contextlib
from dataclasses import dataclass
import fnmatch
import io
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from PIL import Image

from shared.logging import logger
from shared.worker_core.utils import send_file_to_current_session

from agent_runtime.tool_executor import get_tool_context
from agent_runtime.tools.process_sessions import process_exec_session, run_exec_command
from agent_runtime.types import (
    ToolDefinition,
    ToolExecutionError,
    ToolResult,
    image_content_block,
    text_content_block,
    text_tool_result,
)


# ===================================================================
# 安全边界
# ===================================================================

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS_ROOT = WORKSPACE_ROOT / "artifacts"

_SKIP_DIRS = frozenset({
    ".git", "node_modules", "__pycache__", ".venv", "venv",
    ".tox", ".mypy_cache", ".pytest_cache", "dist", "build",
})
_BINARY_EXTS = frozenset({
    ".pyc", ".pyo", ".exe", ".dll", ".so", ".bin", ".zip", ".tar", ".gz", ".7z", ".rar", ".whl",
    ".pdf", ".xlsx", ".xlsm", ".xltx", ".xltm", ".xls", ".docx", ".docm", ".dotx", ".dotm",
    ".doc", ".pptx", ".pptm", ".potx", ".potm", ".ppsx", ".ppsm", ".ppt", ".odt", ".ods", ".odp",
})
_MAX_OUTPUT = 10_000
_MAX_GREP = 100
_MAX_FIND = 200
_BINARY_SNIFF_BYTES = 4096

_READ_DESCRIPTION = (
    "Read the contents of a file under the project root (workspace). Supports text files and images (jpg, png, gif, webp). "
    "Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB "
    "(whichever is hit first). Use offset/limit for large files. When you need the full file, "
    "continue with offset until complete."
)
_READ_FILE_TYPE_SNIFF_BYTES = 4100
_READ_MAX_LINES = 2000
_READ_TEXT_MAX_BYTES = 50 * 1024
_READ_IMAGE_MAX_WIDTH = 2000
_READ_IMAGE_MAX_HEIGHT = 2000
_READ_IMAGE_MAX_BYTES = int(4.5 * 1024 * 1024)
_READ_IMAGE_JPEG_QUALITY = 80
_READ_IMAGE_JPEG_QUALITY_STEPS = (85, 70, 55, 40)
_READ_IMAGE_SCALE_FACTORS = (0.75, 0.5, 0.35, 0.25)


@dataclass(frozen=True, slots=True)
class _ReadImageCandidate:
    media_type: str
    data: bytes
    width: int
    height: int


def _safe_resolve(raw: str) -> Path:
    """将用户路径解析为绝对路径，必须在 workspace 内。"""
    text = str(raw or "").strip()
    if not text:
        raise ValueError("路径不能为空")
    p = Path(text)
    if not p.is_absolute():
        p = WORKSPACE_ROOT / p
    resolved = p.resolve()
    if not resolved.is_relative_to(WORKSPACE_ROOT):
        raise PermissionError(f"路径越界: {resolved} 不在 {WORKSPACE_ROOT} 内")
    return resolved


def _safe_resolve_artifact(raw: str) -> Path:
    resolved = _safe_resolve(raw)
    if not resolved.is_relative_to(ARTIFACTS_ROOT):
        raise PermissionError(f"路径越界: {resolved} 不在 {ARTIFACTS_ROOT} 内")
    return resolved


def _truncate(text: str, limit: int = _MAX_OUTPUT) -> str:
    if len(text) <= limit:
        return text
    half = limit // 2
    return text[:half] + f"\n\n... (truncated, {len(text)} chars total) ...\n\n" + text[-half:]


def _should_skip_dir(name: str) -> bool:
    return name in _SKIP_DIRS


def _tool_error(message: str) -> None:
    raise ToolExecutionError(str(message or "").strip())


def _looks_binary_file(path: Path) -> bool:
    if path.suffix.lower() in _BINARY_EXTS:
        return True
    try:
        with path.open("rb") as handle:
            sample = handle.read(_BINARY_SNIFF_BYTES)
    except Exception:
        return False
    if not sample:
        return False
    if b"\x00" in sample:
        return True
    control_bytes = sum(
        1
        for value in sample
        if value < 32 and value not in {9, 10, 13}
    )
    return control_bytes > max(4, len(sample) // 20)


def _binary_read_error(path: Path) -> str:
    ext = path.suffix.lower()
    ext_text = ext or "<no_ext>"
    return f"二进制文件不可直接按文本读取: {path} (ext={ext_text})"


async def _terminate_subprocess(proc: asyncio.subprocess.Process | None) -> None:
    if proc is None:
        return
    if proc.returncode is None:
        with contextlib.suppress(Exception):
            proc.kill()
    with contextlib.suppress(Exception):
        await asyncio.wait_for(proc.communicate(), timeout=5.0)


def _json_tool_result(payload: dict[str, Any]) -> ToolResult:
    return ToolResult(
        content=[text_content_block(json.dumps(dict(payload or {}), indent=2, ensure_ascii=False))],
        details=dict(payload or {}),
    )


def _exec_running_tool_result(payload: dict[str, Any]) -> ToolResult:
    details = dict(payload or {})
    session_id = str(details.get("session") or "").strip()
    pid = str(details.get("pid") or "").strip()
    message = (
        f"Command still running (session {session_id}, pid {pid}).\n"
        "Use process (list/poll/log/write/kill/remove) for follow-up. "
        "You will be notified automatically when it finishes."
    )
    return ToolResult(
        content=[text_content_block(message)],
        details=details,
    )


def _sniff_read_image_mime(sample: bytes) -> str | None:
    if sample.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if sample.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if sample.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(sample) >= 12 and sample[:4] == b"RIFF" and sample[8:12] == b"WEBP":
        return "image/webp"
    return None


def _fit_image_size(width: int, height: int, *, max_width: int, max_height: int) -> tuple[int, int]:
    safe_width = max(1, int(width or 1))
    safe_height = max(1, int(height or 1))
    scale = min(max_width / safe_width, max_height / safe_height, 1.0)
    return (
        max(1, int(round(safe_width * scale))),
        max(1, int(round(safe_height * scale))),
    )


def _flatten_for_jpeg(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    background = Image.new("RGB", rgba.size, (255, 255, 255))
    background.paste(rgba, mask=rgba.getchannel("A"))
    return background


def _encode_read_image_candidate(
    image: Image.Image,
    *,
    size: tuple[int, int],
    media_type: str,
    quality: int | None = None,
) -> _ReadImageCandidate:
    width, height = size
    rendered = image.copy()
    if rendered.size != (width, height):
        rendered = rendered.resize((width, height), Image.LANCZOS)

    save_kwargs: dict[str, Any]
    format_name: str
    if media_type == "image/png":
        if rendered.mode not in {"1", "L", "LA", "P", "RGB", "RGBA"}:
            rendered = rendered.convert("RGBA")
        format_name = "PNG"
        save_kwargs = {"optimize": True}
    elif media_type == "image/jpeg":
        if rendered.mode != "RGB":
            rendered = _flatten_for_jpeg(rendered)
        format_name = "JPEG"
        save_kwargs = {
            "quality": int(quality or _READ_IMAGE_JPEG_QUALITY),
            "optimize": True,
        }
    else:
        raise ValueError(f"unsupported media_type: {media_type}")

    buffer = io.BytesIO()
    rendered.save(buffer, format=format_name, **save_kwargs)
    return _ReadImageCandidate(
        media_type=media_type,
        data=buffer.getvalue(),
        width=width,
        height=height,
    )


def _select_smallest_candidate(candidates: list[_ReadImageCandidate]) -> _ReadImageCandidate:
    return min(candidates, key=lambda item: (len(item.data), item.media_type))


def _read_text_body(path: Path, *, offset: int, limit: int) -> str:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception as e:
        _tool_error(f"读取失败: {e}")

    total = len(lines)
    start_index = max(0, int(offset or 1) - 1)
    safe_limit = max(1, min(int(limit or _READ_MAX_LINES), _READ_MAX_LINES))
    selected: list[str] = []
    next_index = start_index

    max_index = min(total, start_index + safe_limit)
    for index in range(start_index, max_index):
        line = lines[index]
        candidate_lines = selected + [line]
        candidate_text = "\n".join(candidate_lines)
        if len(candidate_text.encode("utf-8")) > _READ_TEXT_MAX_BYTES:
            break
        selected.append(line)
        next_index = index + 1

    has_more = next_index < total
    body = "\n".join(selected)
    if not has_more:
        return body

    while True:
        suffix = f"Use offset={next_index + 1} to continue"
        candidate = body + (f"\n{suffix}" if body else suffix)
        if len(candidate.encode("utf-8")) <= _READ_TEXT_MAX_BYTES or not selected:
            return candidate
        selected.pop()
        next_index -= 1
        body = "\n".join(selected)


def _build_read_image_result(path: Path, *, detected_mime: str) -> ToolResult:
    try:
        raw = path.read_bytes()
    except Exception as e:
        _tool_error(f"读取图片失败: {e}")

    try:
        with Image.open(io.BytesIO(raw)) as source:
            original_width, original_height = source.size
            animated = bool(getattr(source, "is_animated", False)) and int(getattr(source, "n_frames", 1) or 1) > 1
            if animated:
                source.seek(0)
            base_image = source.copy()
    except Exception as e:
        _tool_error(f"读取图片失败: {e}")

    smallest: _ReadImageCandidate | None = None
    if (
        not animated
        and original_width <= _READ_IMAGE_MAX_WIDTH
        and original_height <= _READ_IMAGE_MAX_HEIGHT
        and len(raw) <= _READ_IMAGE_MAX_BYTES
    ):
        smallest = _ReadImageCandidate(
            media_type=detected_mime,
            data=raw,
            width=original_width,
            height=original_height,
        )

    if smallest is None:
        base_size = _fit_image_size(
            original_width,
            original_height,
            max_width=_READ_IMAGE_MAX_WIDTH,
            max_height=_READ_IMAGE_MAX_HEIGHT,
        )
        step_one = [
            _encode_read_image_candidate(base_image, size=base_size, media_type="image/png"),
            _encode_read_image_candidate(
                base_image,
                size=base_size,
                media_type="image/jpeg",
                quality=_READ_IMAGE_JPEG_QUALITY,
            ),
        ]
        smallest = _select_smallest_candidate(step_one)
        within_limit = [item for item in step_one if len(item.data) <= _READ_IMAGE_MAX_BYTES]
        if within_limit:
            smallest = _select_smallest_candidate(within_limit)
        else:
            for quality in _READ_IMAGE_JPEG_QUALITY_STEPS:
                candidate = _encode_read_image_candidate(
                    base_image,
                    size=base_size,
                    media_type="image/jpeg",
                    quality=quality,
                )
                if len(candidate.data) < len(smallest.data):
                    smallest = candidate
                if len(candidate.data) <= _READ_IMAGE_MAX_BYTES:
                    smallest = candidate
                    break
            else:
                for factor in _READ_IMAGE_SCALE_FACTORS:
                    scaled_size = (
                        max(1, int(round(base_size[0] * factor))),
                        max(1, int(round(base_size[1] * factor))),
                    )
                    for quality in _READ_IMAGE_JPEG_QUALITY_STEPS:
                        candidate = _encode_read_image_candidate(
                            base_image,
                            size=scaled_size,
                            media_type="image/jpeg",
                            quality=quality,
                        )
                        if len(candidate.data) < len(smallest.data):
                            smallest = candidate
                        if len(candidate.data) <= _READ_IMAGE_MAX_BYTES:
                            smallest = candidate
                            break
                    if len(smallest.data) <= _READ_IMAGE_MAX_BYTES:
                        break

    scale = (original_width / smallest.width) if smallest.width else 1.0
    summary = (
        f"Read image file [{smallest.media_type}]\n"
        f"[Image: original {original_width}x{original_height}, displayed at "
        f"{smallest.width}x{smallest.height}. Multiply coordinates by {scale:.2f} "
        "to map to original image.]"
    )
    encoded = base64.b64encode(smallest.data).decode("ascii")
    return ToolResult(
        content=[
            text_content_block(summary),
            image_content_block(media_type=smallest.media_type, data=encoded),
        ],
    )


# ===================================================================
# Handler: read
# ===================================================================

async def _handle_read(
    path: str = "", offset: int = 1, limit: int = _READ_MAX_LINES, **_: Any,
) -> ToolResult:
    try:
        resolved = _safe_resolve(path)
    except (ValueError, PermissionError) as e:
        _tool_error(str(e))

    if not resolved.is_file():
        _tool_error(f"文件不存在: {resolved}")

    try:
        with resolved.open("rb") as handle:
            sample = handle.read(_READ_FILE_TYPE_SNIFF_BYTES)
    except Exception as e:
        _tool_error(f"读取失败: {e}")

    detected_mime = _sniff_read_image_mime(sample)
    if detected_mime:
        return _build_read_image_result(resolved, detected_mime=detected_mime)

    return text_tool_result(_read_text_body(resolved, offset=offset, limit=limit))


# ===================================================================
# Handler: write
# ===================================================================

async def _handle_write(file_path: str = "", content: str = "", **_: Any) -> ToolResult:
    try:
        resolved = _safe_resolve(file_path)
    except (ValueError, PermissionError) as e:
        _tool_error(str(e))

    try:
        resolved.parent.mkdir(parents=True, exist_ok=True)
        resolved.write_text(content, encoding="utf-8")
    except Exception as e:
        _tool_error(f"写入失败: {e}")

    return text_tool_result(f"Wrote {len(content)} chars to {resolved.relative_to(WORKSPACE_ROOT)}")


# ===================================================================
# Handler: edit
# ===================================================================

async def _handle_edit(
    file_path: str = "", old_string: str = "", new_string: str = "", **_: Any,
) -> ToolResult:
    try:
        resolved = _safe_resolve(file_path)
    except (ValueError, PermissionError) as e:
        _tool_error(str(e))

    if not resolved.is_file():
        _tool_error(f"文件不存在: {resolved}")

    if _looks_binary_file(resolved):
        _tool_error(_binary_read_error(resolved))

    try:
        text = resolved.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        _tool_error(f"读取失败: {e}")

    count = text.count(old_string)
    if count == 0:
        _tool_error("old_string not found in file")
    if count > 1:
        _tool_error(f"old_string matches {count} locations, provide more context to be unique")

    new_text = text.replace(old_string, new_string, 1)
    resolved.write_text(new_text, encoding="utf-8")

    # 返回替换处前后几行作为确认
    pos = new_text.find(new_string)
    before = new_text[:pos].splitlines()[-3:]
    after_block = new_text[pos:pos + len(new_string) + 300].splitlines()[:6]
    preview = "\n".join(before + after_block)

    return text_tool_result(f"Edited {resolved.relative_to(WORKSPACE_ROOT)}\n---\n{preview}")


# ===================================================================
# Handler: grep
# ===================================================================

async def _handle_grep(
    pattern: str = "", path: str = "", glob: str = "",
    output_mode: str = "content", **_: Any,
) -> ToolResult:
    try:
        root = _safe_resolve(path or ".")
    except (ValueError, PermissionError) as e:
        _tool_error(str(e))

    try:
        regex = re.compile(pattern)
    except re.error as e:
        _tool_error(f"正则错误: {e}")

    results: list[str] = []
    file_match_counts: dict[str, int] = {}
    hit_limit = False

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not _should_skip_dir(d)]
        for fname in filenames:
            if glob and not fnmatch.fnmatch(fname, glob):
                continue
            fpath = Path(dirpath) / fname
            if _looks_binary_file(fpath):
                continue
            try:
                lines = fpath.read_text(encoding="utf-8", errors="replace").splitlines()
            except Exception:
                continue
            rel = str(fpath.relative_to(WORKSPACE_ROOT))
            for i, line in enumerate(lines, 1):
                if regex.search(line):
                    file_match_counts[rel] = file_match_counts.get(rel, 0) + 1
                    if output_mode == "content" and len(results) < _MAX_GREP:
                        results.append(f"{rel}:{i}: {line.rstrip()}")
            if len(file_match_counts) > _MAX_GREP * 2:
                hit_limit = True
                break
        if hit_limit:
            break

    mode = str(output_mode or "content").strip()
    if mode == "files_with_matches":
        body = "\n".join(sorted(file_match_counts.keys()))
    elif mode == "count":
        body = "\n".join(f"{k}: {v}" for k, v in sorted(file_match_counts.items()))
    else:
        body = "\n".join(results)

    if not body:
        return text_tool_result("No matches found.")

    suffix = ""
    if hit_limit:
        suffix = f"\n... (results truncated, too many matches)"
    return text_tool_result(_truncate(body + suffix))


# ===================================================================
# Handler: find
# ===================================================================

async def _handle_find(pattern: str = "", path: str = "", **_: Any) -> ToolResult:
    try:
        root = _safe_resolve(path or ".")
    except (ValueError, PermissionError) as e:
        _tool_error(str(e))

    matches: list[str] = []
    for p in root.rglob(pattern):
        if any(part in _SKIP_DIRS for part in p.parts):
            continue
        matches.append(str(p.relative_to(WORKSPACE_ROOT)))
        if len(matches) >= _MAX_FIND:
            break

    if not matches:
        return text_tool_result("No files found.")
    body = "\n".join(matches)
    if len(matches) >= _MAX_FIND:
        body += f"\n... (showing first {_MAX_FIND} results)"
    return text_tool_result(_truncate(body))


# ===================================================================
# Handler: ls
# ===================================================================

async def _handle_ls(path: str = "", **_: Any) -> ToolResult:
    try:
        resolved = _safe_resolve(path or ".")
    except (ValueError, PermissionError) as e:
        _tool_error(str(e))

    if not resolved.is_dir():
        _tool_error(f"不是目录: {resolved}")

    entries: list[str] = []
    try:
        for entry in sorted(
            os.scandir(resolved),
            key=lambda e: (not e.is_dir(), e.name.lower()),
        ):
            try:
                st = entry.stat()
                kind = "d" if entry.is_dir() else ("l" if entry.is_symlink() else "f")
                size = st.st_size if not entry.is_dir() else 0
                mtime = time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))
                entries.append(f"{kind}  {size:>10}  {mtime}  {entry.name}")
            except OSError:
                entries.append(f"?  {'?':>10}  {'?':>16}  {entry.name}")
    except Exception as e:
        _tool_error(f"列目录失败: {e}")

    return text_tool_result("\n".join(entries) if entries else "(empty directory)")


# ===================================================================
# Handler: send_file
# ===================================================================

async def _handle_send_file(path: str = "", **_: Any) -> ToolResult:
    try:
        resolved = _safe_resolve_artifact(path)
    except (ValueError, PermissionError) as e:
        _tool_error(str(e))

    if not resolved.exists():
        _tool_error(f"文件不存在: {resolved}")
    if not resolved.is_file():
        _tool_error(f"路径不是文件: {resolved}")

    ctx = get_tool_context()
    session_id = str(getattr(getattr(ctx, "session", None), "session_id", "") or "").strip()
    if not session_id:
        _tool_error("当前没有可用会话，无法发送文件。")

    sent = await send_file_to_current_session(session_id, str(resolved))
    if not sent:
        _tool_error(f"文件发送失败: {resolved}")

    try:
        display_path = str(resolved.relative_to(WORKSPACE_ROOT))
    except Exception:
        display_path = str(resolved)
    return text_tool_result(f"已发送文件到当前会话: {display_path}")


# ===================================================================
# Handler: exec
# ===================================================================

_CMD_BLACKLIST = [
    re.compile(r"rm\s+-rf\s+/", re.IGNORECASE),
    re.compile(r"format\s+[a-zA-Z]:", re.IGNORECASE),
    re.compile(r"shutdown", re.IGNORECASE),
    re.compile(r"del\s+/[sS]", re.IGNORECASE),
    re.compile(r"mkfs", re.IGNORECASE),
    re.compile(r"rd\s+/[sS]", re.IGNORECASE),
]
_PROJECT_PYTHON_LAUNCHERS = {"py", "python", "python.exe", "python3", "python3.exe"}
_PROJECT_PIP_LAUNCHERS = {"pip", "pip.exe", "pip3", "pip3.exe"}
_PROJECT_PYTHON_VERSIONS = {"-3", "-3.12", "-3.12.10"}
_PROJECT_VENV_DIR = ".venv"


def _project_python_executable() -> Path:
    if os.name == "nt":
        executable = WORKSPACE_ROOT / _PROJECT_VENV_DIR / "Scripts" / "python.exe"
    else:
        executable = WORKSPACE_ROOT / _PROJECT_VENV_DIR / "bin" / "python"
    if not executable.exists():
        raise RuntimeError(f"项目 Python 不存在: {executable}")
    return executable


def _quote_command_path(path: Path) -> str:
    return f'"{path}"'


def _normalize_project_python_command(command: str) -> str:
    cmd = str(command or "").strip()
    if not cmd:
        return cmd

    match = re.match(r"^([A-Za-z0-9_.-]+)(?:\s+(-\d+(?:\.\d+){0,2}))?(?=\s|$)(.*)$", cmd, re.DOTALL)
    if match is None:
        return cmd

    launcher = str(match.group(1) or "").lower()
    version = str(match.group(2) or "").strip()
    rest = str(match.group(3) or "")

    if launcher in _PROJECT_PYTHON_LAUNCHERS:
        if version and version not in _PROJECT_PYTHON_VERSIONS:
            raise RuntimeError(f"项目只允许使用 {_PROJECT_VENV_DIR} Python，不能使用 {launcher} {version}")
        return f"{_quote_command_path(_project_python_executable())}{rest}"

    if launcher in _PROJECT_PIP_LAUNCHERS:
        if version:
            return cmd
        return f"{_quote_command_path(_project_python_executable())} -m pip{rest}"

    return cmd


async def _handle_exec(
    command: str = "",
    cwd: str = "",
    timeout: float | None = None,
    background: bool = False,
    yield_ms: float | None = None,
    **_: Any,
) -> ToolResult:
    cmd = str(command or "").strip()
    if not cmd:
        _tool_error("command 不能为空")

    try:
        normalized_cmd = _normalize_project_python_command(cmd)
    except RuntimeError as e:
        _tool_error(str(e))
    if normalized_cmd != cmd:
        logger.info("[CodingTools] normalized project Python command: %s -> %s", cmd, normalized_cmd)
        cmd = normalized_cmd

    for pat in _CMD_BLACKLIST:
        if pat.search(cmd):
            _tool_error(f"命令被安全策略阻止: {cmd}")

    try:
        work_dir = _safe_resolve(cwd or ".")
    except (ValueError, PermissionError) as e:
        _tool_error(str(e))

    owner_session_id = ""
    origin_turn_id = ""
    try:
        tool_ctx = get_tool_context()
    except RuntimeError:
        tool_ctx = None
    if tool_ctx is not None:
        session = getattr(tool_ctx, "session", None)
        runtime = dict(getattr(tool_ctx, "state_data", {}) or {})
        owner_session_id = str(getattr(session, "session_id", "") or "").strip()
        origin_turn_id = str(dict(runtime.get("runtime") or {}).get("active_turn_id") or "").strip()

    payload = await run_exec_command(
        command=cmd,
        cwd=str(work_dir),
        timeout=float(timeout) if timeout is not None else None,
        background=bool(background),
        yield_ms=float(yield_ms) if yield_ms is not None else None,
        owner_session_id=owner_session_id,
        origin_turn_id=origin_turn_id,
    )
    if str(payload.get("status") or "").strip() == "running":
        return _exec_running_tool_result(payload)
    return _json_tool_result(payload)


async def _handle_process(
    action: str = "",
    session: str = "",
    text: str = "",
    offset: int | None = None,
    limit: int | None = None,
    **_: Any,
) -> ToolResult:
    payload = await process_exec_session(
        action=action,
        session_id=session,
        text=text,
        offset=offset,
        limit=limit,
    )
    return _json_tool_result(payload)


# ===================================================================
# ToolDefinition 注册清单
# ===================================================================

CODING_READ = ToolDefinition(
    name="read",
    description=_READ_DESCRIPTION,
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "Path to the file to read, relative to the project root (workspace) or absolute inside it",
            },
            "offset": {"type": "integer", "description": "Line number to start reading from (1-indexed)"},
            "limit": {"type": "integer", "description": "Maximum number of lines to read"},
        },
        "required": ["path"],
        "additionalProperties": False,
    },
    handler=_handle_read,
)

CODING_WRITE = ToolDefinition(
    name="write",
    description="Create or overwrite a file with the given content. Auto-creates parent directories.",
    parameters={
        "type": "object",
        "properties": {
            "file_path": {"type": "string", "description": "File path"},
            "content": {"type": "string", "description": "Full file content to write"},
        },
        "required": ["file_path", "content"],
        "additionalProperties": False,
    },
    handler=_handle_write,
)

CODING_EDIT = ToolDefinition(
    name="edit",
    description="Find-and-replace in a file. old_string must match exactly once. Use read first to see the file.",
    parameters={
        "type": "object",
        "properties": {
            "file_path": {"type": "string", "description": "File path"},
            "old_string": {"type": "string", "description": "Exact text to find (must appear exactly once)"},
            "new_string": {"type": "string", "description": "Replacement text"},
        },
        "required": ["file_path", "old_string", "new_string"],
        "additionalProperties": False,
    },
    handler=_handle_edit,
)

CODING_LS = ToolDefinition(
    name="ls",
    description="List directory contents with type (d/f/l), size, and modification time.",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Directory path (default: project root / workspace)", "default": "."},
        },
        "additionalProperties": False,
    },
    handler=_handle_ls,
)

CODING_SEND_FILE = ToolDefinition(
    name="send_file",
    description=(
        "Send an existing local file from the artifacts directory under the project root (workspace) "
        "to the current user in the current session. Supports images and regular files. Use this only "
        "after the file already exists; it does not read or modify the file."
    ),
    parameters={
        "type": "object",
        "properties": {
            "path": {
                "type": "string",
                "description": "File path to send, relative to the project root (workspace) or absolute inside its artifacts directory only",
            },
        },
        "required": ["path"],
        "additionalProperties": False,
    },
    handler=_handle_send_file,
)

CODING_EXEC = ToolDefinition(
    name="exec",
    description=(
        "Execute shell commands. Returns result if command finishes within yield_ms "
        "(default 10s), otherwise backgrounds the command and returns a session ID. "
        "Use the process tool to check progress of backgrounded commands. "
        "Python and pip commands in this workspace are forced to use .venv."
    ),
    parameters={
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "Shell command string"},
            "cwd": {"type": "string", "description": "Working directory (default: workspace root)", "default": "."},
            "timeout": {
                "type": "number",
                "description": "Timeout in seconds (default 120, kills process on expiry). Ignored when background=true.",
            },
            "background": {
                "type": "boolean",
                "description": "Run in background immediately, don't wait for result",
            },
            "yield_ms": {
                "type": "number",
                "description": "Milliseconds to wait before backgrounding (default 10000). Only applies when background=false.",
            },
        },
        "required": ["command"],
        "additionalProperties": False,
    },
    handler=_handle_exec,
)

CODING_PROCESS = ToolDefinition(
    name="process",
    description=(
        "Manage running or finished exec sessions. Actions: list (show all sessions), "
        "poll (get new output), log (full output with offset/limit), write (send stdin), "
        "kill (terminate), remove (kill + delete)."
    ),
    parameters={
        "type": "object",
        "properties": {
            "action": {
                "type": "string",
                "enum": ["list", "poll", "log", "write", "kill", "remove"],
                "description": "Action to perform",
            },
            "session": {
                "type": "string",
                "description": "Session ID (required for all actions except list)",
            },
            "text": {
                "type": "string",
                "description": "Text to write to stdin (for write action)",
            },
            "offset": {
                "type": "integer",
                "description": "Line offset for log action (1-indexed, default 1)",
            },
            "limit": {
                "type": "integer",
                "description": "Max lines for log action (default 2000)",
            },
        },
        "required": ["action"],
        "additionalProperties": False,
    },
    handler=_handle_process,
)

CODING_TOOLS = [CODING_READ, CODING_WRITE, CODING_EDIT, CODING_LS, CODING_SEND_FILE, CODING_EXEC, CODING_PROCESS]
CODING_TOOL_NAMES = frozenset(t.name for t in CODING_TOOLS)


def register_coding_tools(registry: Any) -> None:
    """Register all coding tools into the UnifiedToolRegistry."""
    for tool in CODING_TOOLS:
        if not registry.has(tool.name):
            registry.register(tool)
    logger.info(f"[CodingTools] registered {len(CODING_TOOLS)} tools: {', '.join(t.name for t in CODING_TOOLS)}")


__all__ = [
    "CODING_TOOL_NAMES",
    "CODING_TOOLS",
    "WORKSPACE_ROOT",
    "register_coding_tools",
]
