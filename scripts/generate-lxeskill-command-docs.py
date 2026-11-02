"""Refresh the command handbook using the same catalog and renderer as CLI help."""
from __future__ import annotations

import argparse
from pathlib import Path

from lxeskill.business import load_catalog
from lxeskill.help import GROUPS, render_help


DOCUMENT = Path(__file__).resolve().parents[1] / "docs/lxeskill-cli/commands.md"
BEGIN = "<!-- BEGIN GENERATED COMMAND REFERENCE -->"
END = "<!-- END GENERATED COMMAND REFERENCE -->"
EXAMPLES = (
    "mabang_download_fba_delivery_csv",
    "mabang_replenishment_template",
    "mabang_calculate_store_msku_replenishment",
    "amazon_operations_analyze_listing",
)


def render_reference() -> str:
    catalog = load_catalog()
    lines = [
        "## 整体入口", "", "```text", "$ lxeskill --help", "",
        render_help([], catalog), "```",
    ]
    for group, (label, _) in GROUPS.items():
        lines += [
            "", f"## {label}", "", "```text", f"$ lxeskill help {group}", "",
            render_help([group], catalog, business_navigation=True), "```",
        ]
    lines += ["", "## 典型调用示例", "", "执行前将尖括号内容替换为实际值，单号等示例值也应按任务修改。"]
    for name in EXAMPLES:
        info = catalog[name]["help"]
        lines += ["", f"### {info['summary']}", "", "```bash", *info["examples"], "```"]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    current = DOCUMENT.read_text(encoding="utf-8")
    if current.count(BEGIN) != 1 or current.count(END) != 1:
        raise ValueError("The handbook must contain exactly one pair of generated-region markers")
    before, rest = current.split(BEGIN)
    _, after = rest.split(END)
    updated = before + BEGIN + "\n\n" + render_reference() + "\n\n" + END + after
    if current == updated:
        print("Command handbook is up to date.")
        return 0
    DOCUMENT.write_text(updated, encoding="utf-8", newline="\n")
    print(f"Updated {DOCUMENT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
