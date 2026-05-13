from __future__ import annotations

import io

from PIL import Image

from shared.logging import logger


_MAX_DIMENSION = 1024
_JPEG_QUALITY = 60


def compress_image_bytes(payload: bytes) -> tuple[bytes, str]:
    """Compress raw image bytes into JPEG bytes for multimodal model input."""
    try:
        if not payload:
            return b"", ""
        image = Image.open(io.BytesIO(payload))
        if image.mode != "RGB":
            image = image.convert("RGB")

        width, height = image.size
        max_edge = max(width, height)
        if max_edge > _MAX_DIMENSION:
            scale = _MAX_DIMENSION / max_edge
            image = image.resize(
                (max(1, int(width * scale)), max(1, int(height * scale))),
                Image.LANCZOS,
            )

        buffer = io.BytesIO()
        image.save(buffer, format="JPEG", quality=_JPEG_QUALITY)
        return buffer.getvalue(), "image/jpeg"
    except Exception as exc:
        logger.warning("[ImageProcessing] image compression failed: %s", exc)
        return b"", ""
