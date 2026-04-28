from __future__ import annotations

from .audio import convert_audio
from .calendar import convert_calendar, convert_general_calendar, convert_share_calendar_event
from .file import convert_file
from .folder import convert_folder
from .hongbao import convert_hongbao
from .image import convert_image
from .interactive.index import convert_interactive
from .location import convert_location
from .merge_forward import convert_merge_forward
from .post import convert_post
from .share import convert_share_chat, convert_share_user
from .sticker import convert_sticker
from .system import convert_system
from .text import convert_text
from .todo import convert_todo
from .types import ContentConverterFn
from .unknown import convert_unknown
from .video import convert_video
from .video_chat import convert_video_chat
from .vote import convert_vote


CONVERTERS: dict[str, ContentConverterFn] = {
    "text": convert_text,
    "post": convert_post,
    "image": convert_image,
    "file": convert_file,
    "audio": convert_audio,
    "video": convert_video,
    "media": convert_video,
    "sticker": convert_sticker,
    "interactive": convert_interactive,
    "share_chat": convert_share_chat,
    "share_user": convert_share_user,
    "location": convert_location,
    "merge_forward": convert_merge_forward,
    "folder": convert_folder,
    "system": convert_system,
    "hongbao": convert_hongbao,
    "share_calendar_event": convert_share_calendar_event,
    "calendar": convert_calendar,
    "general_calendar": convert_general_calendar,
    "video_chat": convert_video_chat,
    "todo": convert_todo,
    "vote": convert_vote,
    "unknown": convert_unknown,
}


__all__ = ["CONVERTERS"]
