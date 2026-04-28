"""Channel classification rules for transport submodes."""

from __future__ import annotations

import re
from typing import Any

MATSON_CHANNEL_PATTERN = re.compile(r"美森|matson", re.IGNORECASE)


def is_matson_channel_name(channel_name: Any) -> bool:
    return bool(MATSON_CHANNEL_PATTERN.search(str(channel_name or "").strip()))

