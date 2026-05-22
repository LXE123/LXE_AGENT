from __future__ import annotations

import base64
import io

from PIL import Image

from agent_runtime.facts import ToolExecutionFact
from agent_runtime.tool_executor import _tool_result_from_fact
from shared.media.image_processing import compress_image_bytes


def _image_bytes(*, fmt: str = "PNG", size: tuple[int, int] = (32, 24)) -> bytes:
    image = Image.new("RGB", size, color=(30, 90, 150))
    buffer = io.BytesIO()
    image.save(buffer, format=fmt)
    return buffer.getvalue()


def test_compress_image_bytes_png_outputs_jpeg() -> None:
    output, media_type = compress_image_bytes(_image_bytes(fmt="PNG"))

    assert media_type == "image/jpeg"
    assert output.startswith(b"\xff\xd8")


def test_compress_image_bytes_jpeg_outputs_jpeg() -> None:
    output, media_type = compress_image_bytes(_image_bytes(fmt="JPEG"))

    assert media_type == "image/jpeg"
    assert output.startswith(b"\xff\xd8")


def test_compress_image_bytes_empty_or_invalid_returns_empty() -> None:
    assert compress_image_bytes(b"") == (b"", "")
    assert compress_image_bytes(b"not an image") == (b"", "")


def test_browser_vision_tool_result_uses_compressed_jpeg(tmp_path) -> None:
    screenshot_path = tmp_path / "screen.png"
    screenshot_path.write_bytes(_image_bytes(fmt="PNG", size=(64, 48)))

    result = _tool_result_from_fact(
        "ziniao_page",
        ToolExecutionFact(
            tool_name="ziniao_page",
            success=True,
            screenshot_path=str(screenshot_path),
            payload={"action": "browser_vision", "store_id": "store-1"},
        ),
    )

    assert result.content[0] == {"type": "text", "text": f"MEDIA:{screenshot_path}"}
    image_block = result.content[1]
    assert image_block["type"] == "image"
    assert image_block["source"]["media_type"] == "image/jpeg"
    assert base64.b64decode(image_block["source"]["data"]).startswith(b"\xff\xd8")
