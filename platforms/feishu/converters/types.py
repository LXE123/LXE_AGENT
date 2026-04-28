from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypeAlias


ApiMessageItem: TypeAlias = dict[str, Any]


@dataclass(slots=True)
class MentionInfo:
    key: str
    open_id: str
    name: str = ""
    is_bot: bool = False


@dataclass(slots=True)
class ResourceDescriptor:
    type: str
    file_key: str
    file_name: str = ""
    duration: int | None = None
    cover_image_key: str = ""


@dataclass(slots=True)
class ConvertResult:
    content: str = ""
    resources: list[ResourceDescriptor] = field(default_factory=list)


ResolveUserNameFn: TypeAlias = Callable[[str], str | None]
BatchResolveNamesFn: TypeAlias = Callable[[list[str]], Awaitable[None]]
FetchSubMessagesFn: TypeAlias = Callable[[str], Awaitable[list[ApiMessageItem]]]


class ConvertContext:  # slots + self-reference callback typing gets noisy with dataclass replace
    def __init__(
        self,
        *,
        mentions: dict[str, MentionInfo] | None = None,
        mentions_by_open_id: dict[str, MentionInfo] | None = None,
        message_id: str = "",
        item: ApiMessageItem | None = None,
        bot_open_id: str = "",
        account_id: str = "",
        resolve_user_name: ResolveUserNameFn | None = None,
        batch_resolve_names: BatchResolveNamesFn | None = None,
        fetch_sub_messages: FetchSubMessagesFn | None = None,
        convert_message_content: ConvertMessageContentFn | None = None,
        strip_bot_mentions: bool = False,
        include_resource_placeholders: bool = True,
    ) -> None:
        self.mentions = dict(mentions or {})
        self.mentions_by_open_id = dict(mentions_by_open_id or {})
        self.message_id = str(message_id or "").strip()
        self.item = dict(item or {})
        self.bot_open_id = str(bot_open_id or "").strip()
        self.account_id = str(account_id or "").strip()
        self.resolve_user_name = resolve_user_name
        self.batch_resolve_names = batch_resolve_names
        self.fetch_sub_messages = fetch_sub_messages
        self.convert_message_content = convert_message_content
        self.strip_bot_mentions = bool(strip_bot_mentions)
        self.include_resource_placeholders = bool(include_resource_placeholders)

    def child(
        self,
        *,
        item: ApiMessageItem | None = None,
        message_id: str | None = None,
    ) -> "ConvertContext":
        return ConvertContext(
            mentions=self.mentions,
            mentions_by_open_id=self.mentions_by_open_id,
            message_id=message_id if message_id is not None else self.message_id,
            item=item if item is not None else self.item,
            bot_open_id=self.bot_open_id,
            account_id=self.account_id,
            resolve_user_name=self.resolve_user_name,
            batch_resolve_names=self.batch_resolve_names,
            fetch_sub_messages=self.fetch_sub_messages,
            convert_message_content=self.convert_message_content,
            strip_bot_mentions=self.strip_bot_mentions,
            include_resource_placeholders=self.include_resource_placeholders,
        )


ContentConverterFn: TypeAlias = Callable[[str, ConvertContext], ConvertResult | Awaitable[ConvertResult]]
ConvertMessageContentFn: TypeAlias = Callable[[str, str, ConvertContext], Awaitable[ConvertResult]]


__all__ = [
    "ApiMessageItem",
    "BatchResolveNamesFn",
    "ContentConverterFn",
    "ConvertContext",
    "ConvertMessageContentFn",
    "ConvertResult",
    "FetchSubMessagesFn",
    "MentionInfo",
    "ResolveUserNameFn",
    "ResourceDescriptor",
]
