from __future__ import annotations

from typing import Awaitable, Callable

from .card.runtime.debug_state import set_card_debug_enabled
from .stream import SessionContext

CARD_DEBUG_OPERATOR_ID = "01382417600539953451"
StatusCardSender = Callable[..., Awaitable[None]]


async def try_handle_card_debug_command(ctx: SessionContext, send_status_card: StatusCardSender) -> bool:
    text = str(ctx.user_input or "").strip()
    if not text:
        return False

    parts = text.split()
    if not parts:
        return False
    if parts[0] != "卡片调试":
        try:
            parts = parts[parts.index("卡片调试") :]
        except ValueError:
            return False

    action = parts[1] if len(parts) >= 2 else ""
    current_ids: list[str] = []
    for item in [
        ctx.raw_data.get("senderStaffId"),
        ctx.raw_data.get("senderId"),
        ctx.raw_data.get("userId"),
        ctx.user_id,
    ]:
        value = str(item or "").strip()
        if value and value not in current_ids:
            current_ids.append(value)

    if CARD_DEBUG_OPERATOR_ID not in current_ids:
        await send_status_card(
            ctx,
            markdown="❌ 无权限操作卡片调试开关",
        )
        return True

    if action in {"开", "on", "enable", "1"}:
        set_card_debug_enabled(True)
        await send_status_card(
            ctx,
            markdown="✅ 卡片调试已开启（全局）\n\n当前状态: ON",
        )
        return True

    if action in {"关", "off", "disable", "0"}:
        set_card_debug_enabled(False)
        await send_status_card(
            ctx,
            markdown="✅ 卡片调试已关闭（全局）\n\n当前状态: OFF",
        )
        return True

    await send_status_card(
        ctx,
        markdown="⚙️ 命令格式:\n卡片调试 开\n卡片调试 关",
    )
    return True
