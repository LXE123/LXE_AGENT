from __future__ import annotations


def exception_text(exc: Exception) -> str:
    message = str(exc).strip()
    return message or exc.__class__.__name__
