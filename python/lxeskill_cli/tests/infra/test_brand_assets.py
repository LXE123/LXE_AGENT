from pathlib import Path

from PIL import Image


REPOSITORY_ROOT = Path(__file__).resolve().parents[4]
DASHBOARD_BRAND_ROOT = (
    REPOSITORY_ROOT / "apps" / "dashboard" / "src" / "assets" / "brand"
)
DESKTOP_BUILD_ROOT = REPOSITORY_ROOT / "apps" / "desktop" / "build"


def test_application_logo_is_rgba_with_transparent_corners() -> None:
    logo = Image.open(DASHBOARD_BRAND_ROOT / "lxe-agent-logo.png").convert("RGBA")

    assert logo.size == (1024, 1024)
    corners = ((0, 0), (1023, 0), (0, 1023), (1023, 1023))
    assert all(logo.getpixel(point)[3] == 0 for point in corners)
    assert logo.getpixel((512, 512))[3] == 255
    assert Image.open(DESKTOP_BUILD_ROOT / "icon-win.png").size == logo.size
    assert Image.open(DESKTOP_BUILD_ROOT / "icon-mac.png").size == logo.size


def test_tray_assets_have_expected_sizes_and_template_pixels() -> None:
    tray_source = Image.open(
        DASHBOARD_BRAND_ROOT / "lxe-agent-tray-source.png"
    ).convert("RGBA")
    assert tray_source.size == (1024, 1024)
    assert tray_source.getpixel((0, 0))[3] == 0
    assert tray_source.getbbox() is not None

    with Image.open(DESKTOP_BUILD_ROOT / "tray-win.ico") as windows_icon:
        assert windows_icon.ico.sizes() == {(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48)}

    for filename, size in (("tray-macTemplate.png", 16), ("tray-macTemplate@2x.png", 32)):
        template = Image.open(DESKTOP_BUILD_ROOT / filename).convert("RGBA")
        assert template.size == (size, size)
        assert template.getbbox() is not None
        assert template.convert("RGB").getextrema() == ((0, 0), (0, 0), (0, 0))
