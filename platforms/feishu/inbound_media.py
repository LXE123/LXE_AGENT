from __future__ import annotations

import base64
import mimetypes
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from shared.infra.net import HttpSessionPurpose, get_aiohttp_session
from shared.logging import logger

from shared.media.image_processing import compress_image_bytes

from .auth import token_manager
from .config import FEISHU_API_HOST
from .message_parser import InboundResource


_FILENAME_SANITIZER = re.compile(r'[<>:"/\\|?*\x00-\x1f]+')


@dataclass(slots=True)
class ResolvedInboundMessage:
    user_input: str
    user_content_blocks: list[dict[str, Any]] = field(default_factory=list)
    resource_metadata: list[dict[str, Any]] = field(default_factory=list)


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _artifacts_root() -> Path:
    return _project_root() / "artifacts" / "feishu" / "inbound"


def _guess_content_type(*, file_name: str, header_value: str, default: str) -> str:
    header_content_type = str(header_value or "").split(";", 1)[0].strip().lower()
    if header_content_type:
        return header_content_type
    guessed, _ = mimetypes.guess_type(str(file_name or "").strip())
    return str(guessed or default).strip()


def _filename_from_headers(headers: Any) -> str:
    disposition = str((headers or {}).get("Content-Disposition") or (headers or {}).get("content-disposition") or "")
    if not disposition:
        return ""
    match = re.search(r"filename[*]?=(?:UTF-8'')?[\"']?([^\"';\n]+)", disposition, re.IGNORECASE)
    if not match:
        return ""
    try:
        return match.group(1).strip()
    except Exception:
        return ""


def _sanitize_filename(value: str, *, fallback: str) -> str:
    candidate = Path(str(value or "").strip()).name.strip()
    candidate = _FILENAME_SANITIZER.sub("_", candidate).strip().strip(".")
    return candidate or fallback


def _reserve_file_path(directory: Path, file_name: str) -> Path:
    candidate = directory / file_name
    if not candidate.exists():
        return candidate
    stem = candidate.stem or "file"
    suffix = candidate.suffix
    index = 2
    while True:
        next_candidate = directory / f"{stem}_{index}{suffix}"
        if not next_candidate.exists():
            return next_candidate
        index += 1


async def _download_message_resource(
    *,
    message_id: str,
    file_key: str,
    resource_type: str,
) -> tuple[bytes, str, str]:
    token = await token_manager.get_token()
    session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
    url = f"{FEISHU_API_HOST}/im/v1/messages/{message_id}/resources/{file_key}"
    headers = {"Authorization": f"Bearer {token}"}
    async with session.get(url, params={"type": resource_type}, headers=headers) as response:
        if response.status != 200:
            preview = (await response.text()).strip()[:300]
            raise RuntimeError(
                f"download resource failed: status={response.status} type={resource_type} "
                f"message_id={message_id} file_key={file_key} body={preview}"
            )
        payload = await response.read()
        file_name = _filename_from_headers(response.headers)
        content_type = str(response.headers.get("Content-Type") or "").strip()
        return payload, file_name, content_type


async def resolve_inbound_message(
    *,
    message_id: str,
    parsed_text: str,
    resources: list[InboundResource] | None,
    artifacts_root: Path | None = None,
) -> ResolvedInboundMessage:
    safe_message_id = str(message_id or "").strip()
    base_text = str(parsed_text or "").strip()
    blocks: list[dict[str, Any]] = []
    metadata: list[dict[str, Any]] = []
    file_sections: list[str] = []

    target_root = Path(artifacts_root) if artifacts_root is not None else _artifacts_root()

    for resource in list(resources or []):
        resource_type = str(getattr(resource, "type", "") or "").strip().lower()
        file_key = str(getattr(resource, "file_key", "") or "").strip()
        file_name = str(getattr(resource, "file_name", "") or "").strip()
        if resource_type not in {"image", "file"} or not file_key or not safe_message_id:
            continue

        try:
            payload, header_name, header_content_type = await _download_message_resource(
                message_id=safe_message_id,
                file_key=file_key,
                resource_type=resource_type,
            )
        except Exception as exc:
            logger.warning(
                "[Feishu] failed to download inbound %s: message_id=%s file_key=%s error=%s",
                resource_type,
                safe_message_id,
                file_key,
                exc,
            )
            continue

        effective_name = header_name or file_name
        if resource_type == "image":
            compressed_payload, mime_type = compress_image_bytes(payload)
            if not compressed_payload:
                logger.warning(
                    "[Feishu] failed to compress inbound image: message_id=%s file_key=%s",
                    safe_message_id,
                    file_key,
                )
                continue
            blocks.append(
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": mime_type,
                        "data": base64.b64encode(compressed_payload).decode("ascii"),
                    },
                }
            )
            metadata.append(
                {
                    "type": "image",
                    "file_key": file_key,
                    "file_name": effective_name,
                    "mime_type": mime_type,
                }
            )
            continue

        mime_type = _guess_content_type(
            file_name=effective_name,
            header_value=header_content_type,
            default="application/octet-stream",
        )
        message_dir = target_root / safe_message_id
        message_dir.mkdir(parents=True, exist_ok=True)
        safe_name = _sanitize_filename(
            effective_name,
            fallback=f"{safe_message_id}-{len(file_sections) + 1}",
        )
        target_path = _reserve_file_path(message_dir, safe_name)
        target_path.write_bytes(payload)
        metadata.append(
            {
                "type": "file",
                "file_key": file_key,
                "file_name": target_path.name,
                "mime_type": mime_type,
                "path": str(target_path.resolve()),
            }
        )
        section_lines = []
        if target_path.name:
            section_lines.append(f"文件名: {target_path.name}")
        section_lines.append(f"本地文件路径: {target_path.resolve()}")
        section_lines.append(f"文件类型: {mime_type}")
        file_sections.append("\n".join(section_lines))

    if file_sections:
        base_text = "\n\n".join([part for part in [base_text, *file_sections] if str(part or "").strip()])

    user_input = str(base_text or "").strip()
    if not user_input and not blocks:
        return ResolvedInboundMessage(user_input="", user_content_blocks=[], resource_metadata=metadata)

    return ResolvedInboundMessage(
        user_input=user_input,
        user_content_blocks=([{"type": "text", "text": user_input}] if user_input else []) + blocks,
        resource_metadata=metadata,
    )


__all__ = ["ResolvedInboundMessage", "resolve_inbound_message"]
