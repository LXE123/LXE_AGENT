import json
from pathlib import Path
from threading import RLock

from shared.logging import logger


_LOCK = RLock()
_STORE_PATH = Path("artifacts/card/card_debug_state.json")
_CACHE_ENABLED: bool | None = None


def _load_state() -> bool:
    if not _STORE_PATH.exists():
        return False
    try:
        raw = json.loads(_STORE_PATH.read_text(encoding="utf-8"))
        return bool(raw.get("enabled", False))
    except Exception as exc:
        logger.warning(f"[CardDebug] 读取调试状失败，回为关? {exc}")
        return False


def _save_state(enabled: bool) -> None:
    _STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = {"enabled": bool(enabled)}
    _STORE_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def is_card_debug_enabled() -> bool:
    global _CACHE_ENABLED
    with _LOCK:
        if _CACHE_ENABLED is None:
            _CACHE_ENABLED = _load_state()
        return _CACHE_ENABLED


def set_card_debug_enabled(enabled: bool) -> bool:
    global _CACHE_ENABLED
    with _LOCK:
        current = is_card_debug_enabled()
        target = bool(enabled)
        if current == target:
            return False
        _CACHE_ENABLED = target
        _save_state(target)
        logger.info(f"[CardDebug] global => {'ON' if target else 'OFF'}")
        return True

