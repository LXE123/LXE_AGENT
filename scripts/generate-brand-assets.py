"""Generate application icon variants from the approved brand masters."""

from __future__ import annotations

from base64 import b64encode
from io import BytesIO
from pathlib import Path

from PIL import Image


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
BRAND_ROOT = REPOSITORY_ROOT / "apps" / "dashboard" / "src" / "assets" / "brand"
DESKTOP_BUILD_ROOT = REPOSITORY_ROOT / "apps" / "desktop" / "build"
APP_LOGO_PATH = BRAND_ROOT / "lxe-agent-logo.png"
CALLBACK_LOGO_PATH = REPOSITORY_ROOT / "apps/agent-cli/src/assets/lxe-agent-logo.data-url.txt"
TRAY_SOURCE_PATH = BRAND_ROOT / "lxe-agent-tray-source.png"
WINDOWS_TRAY_SIZES = (16, 20, 24, 32, 40, 48)


def resized(image: Image.Image, size: int) -> Image.Image:
    return image.resize((size, size), Image.Resampling.LANCZOS)


def save_png(image: Image.Image, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    image.save(destination, format="PNG", optimize=True)


def generate_brand_assets() -> None:
    app_logo = resized(Image.open(APP_LOGO_PATH).convert("RGBA"), 1024)
    tray_source = resized(Image.open(TRAY_SOURCE_PATH).convert("RGBA"), 1024)

    # Normalize the checked-in masters so the Renderer and platform outputs use
    # exactly the same pixels and density.
    save_png(app_logo, APP_LOGO_PATH)
    save_png(tray_source, TRAY_SOURCE_PATH)
    save_png(app_logo, DESKTOP_BUILD_ROOT / "icon-win.png")
    save_png(app_logo, DESKTOP_BUILD_ROOT / "icon-mac.png")

    # The loopback server closes after the callback, so the page embeds its logo.
    callback_png = BytesIO()
    resized(app_logo, 96).save(callback_png, format="PNG", optimize=True)
    CALLBACK_LOGO_PATH.parent.mkdir(parents=True, exist_ok=True)
    CALLBACK_LOGO_PATH.write_text(
        "data:image/png;base64," + b64encode(callback_png.getvalue()).decode("ascii") + "\n",
        encoding="ascii",
    )

    tray_source.save(
        DESKTOP_BUILD_ROOT / "tray-win.ico",
        format="ICO",
        sizes=[(size, size) for size in WINDOWS_TRAY_SIZES],
    )

    template = Image.new("RGBA", tray_source.size, (0, 0, 0, 255))
    template.putalpha(tray_source.getchannel("A"))
    save_png(resized(template, 16), DESKTOP_BUILD_ROOT / "tray-macTemplate.png")
    save_png(resized(template, 32), DESKTOP_BUILD_ROOT / "tray-macTemplate@2x.png")


if __name__ == "__main__":
    generate_brand_assets()
