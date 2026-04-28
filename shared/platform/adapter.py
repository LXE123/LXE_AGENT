from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from gateway.models import OutboundRequest


InboundSink = Callable[[Any], Any]


class ChannelAdapter(Protocol):
    platform: str
    connector_key: str

    def set_inbound_sink(self, sink: InboundSink) -> None:
        ...

    async def start(self) -> None:
        ...

    async def stop(self) -> None:
        ...

    def health(self) -> dict[str, Any]:
        ...

    async def handle_outbound(self, request: "OutboundRequest") -> None:
        ...
