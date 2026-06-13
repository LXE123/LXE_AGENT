from __future__ import annotations

from shared.env_config import env_flag, env_int, env_text


LLM_REQUEST_TIMEOUT_S = env_int("LLM_REQUEST_TIMEOUT_S", 120, minimum=1)
AGENT_LLM_THINKING_ENABLED = env_flag("AGENT_LLM_THINKING_ENABLED", False)
AGENT_LLM_THINKING_EFFORT = env_text("AGENT_LLM_THINKING_EFFORT", "low")
AGENT_LLM_THINKING_DISPLAY = env_text("AGENT_LLM_THINKING_DISPLAY", "omitted")
AGENT_LLM_PROVIDER = env_text("AGENT_LLM_PROVIDER", "kimi_coding")
AGENT_LLM_MODEL = env_text("AGENT_LLM_MODEL", "kimi-for-coding")
AGENT_LLM_MAX_TOKENS = env_int("AGENT_LLM_MAX_TOKENS", 0, minimum=0)


__all__ = [
    "AGENT_LLM_MAX_TOKENS",
    "AGENT_LLM_MODEL",
    "AGENT_LLM_PROVIDER",
    "AGENT_LLM_THINKING_DISPLAY",
    "AGENT_LLM_THINKING_EFFORT",
    "AGENT_LLM_THINKING_ENABLED",
    "LLM_REQUEST_TIMEOUT_S",
]
