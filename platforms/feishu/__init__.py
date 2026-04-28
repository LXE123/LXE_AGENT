"""Feishu platform — lazy imports to avoid requiring lark-oapi at import time."""


def __getattr__(name: str):
    if name == "FeishuAgentGateway":
        from .gateway import FeishuAgentGateway
        return FeishuAgentGateway
    if name == "FeishuStreamAdapter":
        from .gateway import FeishuStreamAdapter
        return FeishuStreamAdapter
    if name == "FeishuCardSender":
        from .card_sender import FeishuCardSender
        return FeishuCardSender
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["FeishuAgentGateway", "FeishuCardSender", "FeishuStreamAdapter"]
