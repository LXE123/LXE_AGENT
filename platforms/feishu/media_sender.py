from __future__ import annotations

import json
import mimetypes
import os
from pathlib import Path

from aiohttp import FormData

from shared.infra.net import HttpSessionPurpose, get_aiohttp_session
from shared.logging import logger
from shared.platform.markdown_card import build_markdown_card

from .auth import token_manager
from .card_sender import FeishuCardSender, build_markdown_card_context
from .config import FEISHU_API_HOST


_IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp"})
_FILE_TYPE_BY_EXTENSION = {
    ".pdf": "pdf",
    ".doc": "doc",
    ".docx": "doc",
    ".xls": "xls",
    ".xlsx": "xls",
    ".csv": "xls",
    ".ppt": "ppt",
    ".pptx": "ppt",
    ".txt": "stream",
    ".zip": "stream",
}


class FeishuMediaSender:
    def __init__(self) -> None:
        self._card_sender = FeishuCardSender()

    async def send_file(self, ctx, path: str) -> bool:
        safe_path = os.path.abspath(str(path or "").strip())
        if not safe_path:
            raise RuntimeError("[FeishuMedia] file path is required")
        file_path = Path(safe_path)
        if not file_path.is_file():
            raise RuntimeError(f"[FeishuMedia] file path missing: {safe_path}")
        if file_path.suffix.lower() not in _IMAGE_EXTENSIONS:
            try:
                file_key = await self._upload_file(file_path)
                if not file_key:
                    raise RuntimeError("[FeishuMedia] upload_file returned empty file_key")
                await self._send_file_message(ctx, file_key=file_key)
                logger.info("[FeishuMedia] file sent: response_route_id=%s path=%s", ctx.response_route_id, safe_path)
                return True
            except Exception as error:
                raise RuntimeError(f"[FeishuMedia] send_file failed: path={safe_path} error={error}") from error
        try:
            image_key = await self._upload_image(file_path)
            if not image_key:
                raise RuntimeError("[FeishuMedia] upload_image returned empty image_key")
            await self._send_image_message(ctx, image_key=image_key)
            logger.info("[FeishuMedia] image sent: response_route_id=%s path=%s", ctx.response_route_id, safe_path)
            return True
        except Exception as error:
            raise RuntimeError(f"[FeishuMedia] send_image failed: path={safe_path} error={error}") from error

    async def send_markdown_card(self, ctx, markdown: str, *, title: str = "") -> bool:
        safe_markdown = str(markdown or "").strip()
        if not safe_markdown:
            return False
        try:
            await self._card_sender.send_card(
                build_markdown_card_context(ctx),
                ctx.response_route_id,
                build_markdown_card(safe_markdown, title=str(title or "").strip()),
            )
            return True
        except Exception as error:
            logger.error("[FeishuMedia] send_markdown_card failed: %s", error, exc_info=True)
            return False

    async def _upload_file(self, file_path: Path) -> str:
        token = await token_manager.get_token()
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        form = FormData()
        form.add_field("file_type", self._file_type_for_path(file_path))
        form.add_field("file_name", file_path.name)
        content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        with file_path.open("rb") as fh:
            form.add_field(
                "file",
                fh.read(),
                filename=file_path.name,
                content_type=content_type,
            )
        response = await session.post(
            f"{FEISHU_API_HOST}/im/v1/files",
            data=form,
            headers={"Authorization": f"Bearer {token}"},
        )
        data = await self._read_response_json(
            response,
            operation="upload_file",
            url=f"{FEISHU_API_HOST}/im/v1/files",
        )
        file_key = str((data.get("data") or {}).get("file_key") or "").strip()
        if not file_key:
            raise RuntimeError(f"[Feishu] upload_file missing file_key: resp={data}")
        return file_key

    async def _upload_image(self, file_path: Path) -> str:
        token = await token_manager.get_token()
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        form = FormData()
        form.add_field("image_type", "message")
        with file_path.open("rb") as fh:
            form.add_field(
                "image",
                fh.read(),
                filename=file_path.name,
                content_type="application/octet-stream",
            )
        response = await session.post(
            f"{FEISHU_API_HOST}/im/v1/images",
            data=form,
            headers={"Authorization": f"Bearer {token}"},
        )
        data = await self._read_response_json(
            response,
            operation="upload_image",
            url=f"{FEISHU_API_HOST}/im/v1/images",
        )
        image_key = str((data.get("data") or {}).get("image_key") or "").strip()
        if not image_key:
            raise RuntimeError(f"[Feishu] upload_image missing image_key: resp={data}")
        return image_key

    async def _send_image_message(self, ctx, *, image_key: str) -> None:
        await self._send_im_message(ctx, msg_type="image", content={"image_key": image_key})

    async def _send_file_message(self, ctx, *, file_key: str) -> None:
        await self._send_im_message(ctx, msg_type="file", content={"file_key": file_key})

    async def _send_im_message(self, ctx, *, msg_type: str, content: dict[str, str]) -> None:
        token = await token_manager.get_token()
        raw_data = getattr(ctx, "raw_data", {}) or {}
        chat_id = str(
            raw_data.get("chat_id")
            or raw_data.get("conversationId")
            or getattr(ctx, "conversation_id", "")
        ).strip()
        reply_to_message_id = str(
            raw_data.get("source_message_id")
            or raw_data.get("message_id")
            or getattr(ctx, "message_id", "")
        ).strip()
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        encoded_content = json.dumps(dict(content or {}), ensure_ascii=False)
        if reply_to_message_id:
            url = f"{FEISHU_API_HOST}/im/v1/messages/{reply_to_message_id}/reply"
            body = {"msg_type": msg_type, "content": encoded_content}
        else:
            if not chat_id:
                raise RuntimeError(f"[FeishuMedia] missing chat_id for {msg_type} send")
            url = f"{FEISHU_API_HOST}/im/v1/messages?receive_id_type=chat_id"
            body = {"receive_id": chat_id, "msg_type": msg_type, "content": encoded_content}
        response = await session.post(url, json=body, headers=headers)
        await self._read_response_json(response, operation=f"send_{msg_type}_message", url=url)

    @staticmethod
    def _file_type_for_path(file_path: Path) -> str:
        return _FILE_TYPE_BY_EXTENSION.get(file_path.suffix.lower(), "stream")

    async def _read_response_json(self, response, *, operation: str, url: str) -> dict:
        content_type = str(response.headers.get("Content-Type") or "").strip().lower()
        if "application/json" not in content_type:
            preview = (await response.text()).strip()[:300]
            raise RuntimeError(
                f"[Feishu] {operation} failed: status={response.status} "
                f"content_type={content_type or '<empty>'} url={url} body={preview}"
            )
        data = dict(await response.json(content_type=None) or {})
        if int(data.get("code", -1)) != 0:
            raise RuntimeError(f"[Feishu] {operation} failed: resp={data}")
        return data
