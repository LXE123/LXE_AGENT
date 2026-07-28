from __future__ import annotations

from lxeskill.business import load_catalog
from shared.repository import repository_root


PROJECT_ROOT = repository_root()


def _skill_text(name: str) -> str:
    return (PROJECT_ROOT / "skills" / name / "SKILL.md").read_text(encoding="utf-8")


def test_repository_skill_inventory_distinguishes_top_level_and_nested_manifests() -> None:
    skill_root = PROJECT_ROOT / "skills"
    assert len(list(skill_root.glob("*/SKILL.md"))) == 28
    assert len(list(skill_root.rglob("SKILL.md"))) == 55


def test_ziniao_is_independent_and_shipment_owns_only_four_stages() -> None:
    catalog = load_catalog()
    assert catalog["ziniao_browser"]["owner_skills"] == ["ziniao-browser"]
    assert catalog["ziniao_page"]["owner_skills"] == ["ziniao-browser"]

    shipment = _skill_text("fba-shipment-create")
    frontmatter = shipment.split("---", 2)[1]
    assert "lxeskill browser" not in frontmatter
    assert frontmatter.count("lxeskill fba shipment") == 4

    ziniao = _skill_text("ziniao-browser")
    assert "data.screenshot_path" in ziniao
    assert "不含 base64" in ziniao
    assert "旧元素 `ref` 立即视为失效" in ziniao


def test_fba_docs_send_only_declared_deliverables() -> None:
    catalog = load_catalog()
    deliverable_owners = {
        str(owner)
        for entry in catalog.values()
        if list(entry.get("command_path") or [])[:1] == ["fba"]
        and any(item.get("role") == "deliverable" for item in list(entry.get("artifact_paths") or []))
        for owner in list(entry.get("owner_skills") or [])
    }
    assert deliverable_owners
    for owner in deliverable_owners:
        text = _skill_text(owner)
        assert "terminal `files`" in text, owner
        assert "send_files(paths=<terminal.files>)" in text, owner

    assert "不主动调用 `send_files`" in _skill_text("fba-export-tax-products-manage")
