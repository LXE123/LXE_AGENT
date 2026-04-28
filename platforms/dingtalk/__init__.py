"""DingTalk platform — lazy imports to avoid package-level cycles."""


def __getattr__(name: str):
    if name == "DingTalkAgentGateway":
        from .gateway import DingTalkAgentGateway
        return DingTalkAgentGateway
    if name == "DingTalkStreamAdapter":
        from .gateway import DingTalkStreamAdapter
        return DingTalkStreamAdapter
    if name == "DingTalkCardSender":
        from .card_sender import DingTalkCardSender
        return DingTalkCardSender
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["DingTalkAgentGateway", "DingTalkCardSender", "DingTalkStreamAdapter"]
