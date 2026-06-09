from __future__ import annotations


class LLMProviderError(RuntimeError):
    def __init__(
        self,
        raw_message: str = "",
        *,
        provider: str = "",
        status_code: int = 0,
        category: str = "",
        user_message: str = "",
        retryable: bool = True,
        context_overflow: bool = False,
    ) -> None:
        safe_raw_message = str(raw_message or "").strip()
        self.provider = str(provider or "").strip()
        self.status_code = int(status_code or 0)
        self.category = str(category or "").strip()
        self.raw_message = safe_raw_message
        self.user_message = str(user_message or safe_raw_message or "LLM provider error").strip()
        self.retryable = bool(retryable)
        self.context_overflow = bool(context_overflow)
        super().__init__(safe_raw_message or self.user_message)

    def summary(self) -> str:
        parts = []
        if self.provider:
            parts.append(f"provider={self.provider}")
        if self.status_code:
            parts.append(f"status={self.status_code}")
        if self.category:
            parts.append(f"category={self.category}")
        parts.append(f"retryable={self.retryable}")
        parts.append(f"context_overflow={self.context_overflow}")
        message = self.raw_message or self.user_message
        if message:
            parts.append(f"message={message}")
        return " ".join(parts)


class AnthropicStreamError(LLMProviderError):
    def __init__(self, message: str) -> None:
        super().__init__(
            message,
            provider="anthropic",
            category="stream_error",
            user_message=str(message or "").strip() or "LLM stream error",
            retryable=True,
        )


__all__ = [
    "AnthropicStreamError",
    "LLMProviderError",
]
