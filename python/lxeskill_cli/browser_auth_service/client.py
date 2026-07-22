from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from typing import Any

from shared.infra.net import build_child_env
from shared.logging import get_logger
from shared.workspace import workspace_root

logger = get_logger(__name__)


class BrowserAuthClientError(RuntimeError):
    """Raised when the browser auth CLI fails."""


def _mask_account(account: str) -> str:
    text = str(account or "").strip()
    if len(text) <= 4:
        return text or "-"
    if len(text) <= 7:
        return f"{text[:2]}***{text[-2:]}"
    return f"{text[:3]}****{text[-4:]}"


def _decode_subprocess_output(raw: bytes | str | None) -> str:
    if raw is None:
        return ""
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace").strip()
    return str(raw).strip()


def _extract_protocol_payload(stdout_text: str) -> dict[str, Any]:
    lines = [line.strip() for line in str(stdout_text or "").splitlines() if line.strip()]
    if not lines:
        raise BrowserAuthClientError("browser_auth_service 协议错误: stdout 为空")
    protocol_line = lines[-1]
    try:
        payload = json.loads(protocol_line)
    except json.JSONDecodeError as exc:
        preview = str(stdout_text or "").strip()[-500:]
        raise BrowserAuthClientError(
            f"browser_auth_service 协议错误: stdout 最后一行不是 JSON: {exc}; stdout={preview}"
        ) from exc
    if not isinstance(payload, dict):
        raise BrowserAuthClientError("browser_auth_service 协议错误: stdout JSON 必须是 object")
    return payload


def _refresh_failure_message(payload: dict[str, Any]) -> str:
    stage = str(payload.get("stage") or "browser").strip()
    current_url = str(payload.get("current_url") or "").strip() or "-"
    exception_type = str(payload.get("exception_type") or "Error").strip()
    message = str(payload.get("message") or "browser_auth_service 刷新失败").strip()
    return (
        f"browser_auth_service 刷新失败: stage={stage} current_url={current_url} "
        f"exception_type={exception_type} error={message}"
    )


def refresh_auth_sync(account: str = "") -> dict[str, Any]:
    masked_account = _mask_account(account)
    logger.info(
        f"[BrowserAuthClient] 调用 browser_auth_service 完整刷新: account={masked_account}"
    )
    command = [
        sys.executable,
        "-m",
        "browser_auth_service.main",
        "refresh",
    ]
    if str(account or "").strip():
        command.extend(["--account", str(account).strip()])

    completed = subprocess.run(
        command,
        cwd=str(workspace_root()),
        env=build_child_env(
            extra_env={
                "PYTHONIOENCODING": "utf-8",
                "PYTHONUTF8": "1",
                "PYTHONUNBUFFERED": "1",
            }
        ),
        stdout=subprocess.PIPE,
    )

    stdout = _decode_subprocess_output(completed.stdout)
    payload = _extract_protocol_payload(stdout)

    if completed.returncode != 0 or not payload.get("success"):
        message = _refresh_failure_message(payload)
        logger.error(f"[BrowserAuthClient] {message}")
        raise BrowserAuthClientError(message)
    logger.info(
        f"[BrowserAuthClient] browser_auth_service 完整刷新成功: "
        f"account={masked_account} final_url={payload.get('final_url')} "
        f"state_written={bool(payload.get('state_written'))}"
    )
    return payload


def read_auth_sync(
    account: str = "",
) -> dict[str, Any]:
    masked_account = _mask_account(account)
    try:
        from .service import read_auth as read_auth_from_file

        payload = read_auth_from_file(account=account)
    except Exception as exc:
        message = str(exc or "读取 browser_auth_service 状态失败").strip()
        logger.error(
            f"[BrowserAuthClient] 本地认证状态读取失败: "
            f"account={masked_account} message={message}"
        )
        raise BrowserAuthClientError(message) from exc
    if not isinstance(payload, dict) or not payload.get("success"):
        raise BrowserAuthClientError("读取 browser_auth_service 状态失败")
    return payload


async def refresh_auth(account: str = "") -> dict[str, Any]:
    return await asyncio.to_thread(
        refresh_auth_sync,
        account,
    )


async def read_auth(
    account: str = "",
) -> dict[str, Any]:
    return await asyncio.to_thread(
        read_auth_sync,
        account,
    )
