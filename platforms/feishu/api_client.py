from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from shared.infra.net import HttpSessionPurpose, get_aiohttp_session
from shared.logging import logger

from .auth import token_manager
from .config import FEISHU_API_HOST


@dataclass(slots=True)
class DownloadedResource:
    data: bytes
    content_type: str
    file_name: str


class FeishuApiClient:
    """Minimal Feishu bot API client for IM read operations."""

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token = await token_manager.get_token()
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        url = f"{FEISHU_API_HOST}{path}"
        async with session.request(
            method,
            url,
            headers=headers,
            params=dict(params or {}),
            json=json_data,
        ) as response:
            data = await response.json(content_type=None)
        raw_code = data.get("code", -1)
        try:
            code = int(raw_code)
        except Exception:
            code = -1
        if code != 0:
            logger.error(
                "[FeishuApi] request failed: %s %s code=%s msg=%s",
                method,
                path,
                code,
                data.get("msg"),
            )
            raise RuntimeError(f"Feishu API error: {data.get('msg') or 'unknown error'}")
        return dict(data.get("data") or {})

    async def get_bot_groups(
        self,
        *,
        page_size: int = 100,
        page_token: str = "",
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "page_size": max(1, min(int(page_size or 100), 100)),
        }
        if str(page_token or "").strip():
            params["page_token"] = str(page_token).strip()
        return await self._request("GET", "/im/v1/chats", params=params)

    async def get_chat_info(self, chat_id: str) -> dict[str, Any]:
        return await self._request("GET", f"/im/v1/chats/{str(chat_id or '').strip()}")

    async def get_chat_messages(
        self,
        chat_id: str,
        *,
        start_time: str = "",
        end_time: str = "",
        page_size: int = 50,
        page_token: str = "",
        sort_rule: str = "create_time_desc",
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "container_id_type": "chat",
            "container_id": str(chat_id or "").strip(),
            "page_size": max(1, min(int(page_size or 50), 50)),
            "sort_type": _sort_rule_to_sort_type(sort_rule),
            "card_msg_content_type": "raw_card_content",
            "user_id_type": "open_id",
        }
        if str(start_time or "").strip():
            params["start_time"] = str(start_time).strip()
        if str(end_time or "").strip():
            params["end_time"] = str(end_time).strip()
        if str(page_token or "").strip():
            params["page_token"] = str(page_token).strip()
        return await self._request("GET", "/im/v1/messages", params=params)

    async def get_thread_messages(
        self,
        thread_id: str,
        *,
        page_size: int = 50,
        page_token: str = "",
        sort_rule: str = "create_time_desc",
    ) -> dict[str, Any]:
        params: dict[str, Any] = {
            "container_id_type": "thread",
            "container_id": str(thread_id or "").strip(),
            "page_size": max(1, min(int(page_size or 50), 50)),
            "sort_type": _sort_rule_to_sort_type(sort_rule),
            "card_msg_content_type": "raw_card_content",
            "user_id_type": "open_id",
        }
        if str(page_token or "").strip():
            params["page_token"] = str(page_token).strip()
        return await self._request("GET", "/im/v1/messages", params=params)

    async def get_message_items(self, message_id: str) -> list[dict[str, Any]]:
        data = await self._request(
            "GET",
            f"/im/v1/messages/{str(message_id or '').strip()}",
            params={
                "card_msg_content_type": "raw_card_content",
                "user_id_type": "open_id",
            },
        )
        return list(data.get("items") or [])

    async def add_message_reaction(self, message_id: str, emoji_type: str) -> str:
        safe_message_id = str(message_id or "").strip()
        safe_emoji_type = str(emoji_type or "").strip()
        if not safe_message_id:
            raise RuntimeError("message_id is required")
        if not safe_emoji_type:
            raise RuntimeError("emoji_type is required")
        data = await self._request(
            "POST",
            f"/im/v1/messages/{safe_message_id}/reactions",
            json_data={"reaction_type": {"emoji_type": safe_emoji_type}},
        )
        reaction_id = str(data.get("reaction_id") or "").strip()
        if not reaction_id:
            raise RuntimeError("Feishu add_message_reaction missing reaction_id")
        return reaction_id

    async def delete_message_reaction(self, message_id: str, reaction_id: str) -> None:
        safe_message_id = str(message_id or "").strip()
        safe_reaction_id = str(reaction_id or "").strip()
        if not safe_message_id:
            raise RuntimeError("message_id is required")
        if not safe_reaction_id:
            raise RuntimeError("reaction_id is required")
        await self._request(
            "DELETE",
            f"/im/v1/messages/{safe_message_id}/reactions/{safe_reaction_id}",
        )

    async def list_chat_members(self, chat_id: str) -> list[dict[str, Any]]:
        safe_chat_id = str(chat_id or "").strip()
        page_token = ""
        members: list[dict[str, Any]] = []
        while True:
            params: dict[str, Any] = {
                "member_id_type": "open_id",
                "page_size": 100,
            }
            if page_token:
                params["page_token"] = page_token
            data = await self._request("GET", f"/im/v1/chats/{safe_chat_id}/members", params=params)
            members.extend(dict(item or {}) for item in list(data.get("items") or []))
            if not bool(data.get("has_more")):
                break
            page_token = str(data.get("page_token") or "").strip()
            if not page_token:
                break
        return members

    async def download_resource(
        self,
        *,
        message_id: str,
        file_key: str,
        resource_type: str,
    ) -> DownloadedResource:
        token = await token_manager.get_token()
        session = get_aiohttp_session(HttpSessionPurpose.EXTERNAL)
        path = f"/im/v1/messages/{str(message_id or '').strip()}/resources/{str(file_key or '').strip()}"
        url = f"{FEISHU_API_HOST}{path}"
        headers = {"Authorization": f"Bearer {token}"}
        async with session.get(
            url,
            headers=headers,
            params={"type": str(resource_type or "").strip()},
        ) as response:
            if int(getattr(response, "status", 0) or 0) != 200:
                preview = (await response.text()).strip()[:300]
                raise RuntimeError(
                    f"Feishu download error: status={response.status} "
                    f"message_id={message_id} file_key={file_key} body={preview}"
                )
            payload = await response.read()
            headers_map = response.headers or {}
            return DownloadedResource(
                data=payload,
                content_type=str(headers_map.get("Content-Type") or headers_map.get("content-type") or "").strip(),
                file_name=_filename_from_headers(headers_map),
            )


def _sort_rule_to_sort_type(rule: str) -> str:
    return "ByCreateTimeAsc" if str(rule or "").strip() == "create_time_asc" else "ByCreateTimeDesc"


def _filename_from_headers(headers: Any) -> str:
    raw = str((headers or {}).get("Content-Disposition") or (headers or {}).get("content-disposition") or "").strip()
    if not raw:
        return ""
    marker = "filename="
    lowered = raw.lower()
    index = lowered.find(marker)
    if index < 0:
        return ""
    value = raw[index + len(marker):].strip().strip('"').strip("'")
    if value.lower().startswith("utf-8''"):
        value = value[7:]
    return value.strip()


api_client = FeishuApiClient()


__all__ = ["DownloadedResource", "FeishuApiClient", "api_client"]
