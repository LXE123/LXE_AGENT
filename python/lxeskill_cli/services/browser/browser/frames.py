from __future__ import annotations

import re
from typing import Any
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

from services.browser.browser.shadow_dom import SHADOW_DOM_HELPERS_JS


_FRAME_REF = re.compile(r"^f(\d+(?:\.\d+)*)@([a-f0-9]{32}):(aid-[A-Za-z0-9-]+)$")


def diagnostic_url(url: Any) -> str:
    """Keep the location useful without returning inline data or URL credentials."""
    text = str(url or "")
    parts = urlsplit(text)
    if parts.scheme in {"data", "javascript"}:
        return f"{parts.scheme}:[redacted]"
    return urlunsplit((parts.scheme, parts.netloc.rsplit('@', 1)[-1], parts.path, "", ""))


def frame_error(exc: Exception) -> str:
    text = re.sub(r"https?://[^\s\"<>]+", lambda match: diagnostic_url(match[0]), str(exc))
    return text[:2000] + (" ... [truncated]" if len(text) > 2000 else "")


def list_frames(driver: Any) -> list[dict[str, Any]]:
    """Read child frame elements in the current document, including open shadows."""
    return list(driver.execute_script(SHADOW_DOM_HELPERS_JS + """
// LXE_FRAME_LIST
return deepQuerySelectorAll('iframe, frame').map((el, index) => ({
  element: el, index,
  src: el.getAttribute('src') || '',
  id: el.id || '', name: el.getAttribute('name') || '',
  title: el.getAttribute('title') || '',
}));
""") or [])


def frame_document_id(driver: Any, *, create: bool = False) -> str:
    # A disposable DOM marker, never a Cookie or an application session ID.
    return str(driver.execute_script("""
// LXE_FRAME_DOCUMENT_ID
if (!document.__lxeFrameDocumentId && arguments[0]) {
  document.__lxeFrameDocumentId = arguments[0];
}
return document.__lxeFrameDocumentId || '';
""", uuid4().hex if create else "") or "")


def frame_ref(path: list[int], document_id: str, aid: str) -> str:
    if not path:
        return aid
    return f"f{'.'.join(str(index) for index in path)}@{document_id}:{aid}"


def parse_frame_ref(ref: str) -> tuple[list[int], str, str]:
    match = _FRAME_REF.fullmatch(str(ref or ""))
    if match:
        return [int(index) for index in match[1].split('.')], match[2], match[3]
    if str(ref or "").startswith("f"):
        raise RuntimeError(f"invalid frame ref: {ref}")
    return [], "", str(ref or "")


def enter_ref_frame(driver: Any, ref: str) -> str:
    """Leave the driver in the original, identity-checked document for an action."""
    path, expected_document_id, aid = parse_frame_ref(ref)
    driver.switch_to.default_content()
    try:
        for index in path:
            frames = list_frames(driver)
            if index >= len(frames):
                raise RuntimeError(f"frame_path={path}: frame index {index} no longer exists")
            driver.switch_to.frame(frames[index]["element"])
        if path:
            actual = frame_document_id(driver)
            if actual != expected_document_id:
                raise RuntimeError(f"frame_path={path}: frame document changed; take a new snapshot")
        return aid
    except Exception:
        driver.switch_to.default_content()
        raise
