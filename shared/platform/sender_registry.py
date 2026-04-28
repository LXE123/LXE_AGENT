"""Platform sender registries."""
from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .card_sender import CardSender
    from .media_sender import MediaSender


_card_senders: dict[str, CardSender] = {}
_media_senders: dict[str, MediaSender] = {}


def register_card_sender(platform: str, sender: CardSender) -> None:
    _card_senders[str(platform or "").strip()] = sender


def get_card_sender(platform: str) -> CardSender:
    key = str(platform or "").strip()
    try:
        return _card_senders[key]
    except KeyError as error:
        raise RuntimeError(
            f"No CardSender registered for platform={key!r}. Registered: {list(_card_senders)}"
        ) from error


def register_media_sender(platform: str, sender: MediaSender) -> None:
    _media_senders[str(platform or "").strip()] = sender


def get_media_sender(platform: str) -> MediaSender:
    key = str(platform or "").strip()
    try:
        return _media_senders[key]
    except KeyError as error:
        raise RuntimeError(
            f"No MediaSender registered for platform={key!r}. Registered: {list(_media_senders)}"
        ) from error
