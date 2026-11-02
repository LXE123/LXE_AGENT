"""Read-only help generated from the CLI catalog, without loading business code."""
from __future__ import annotations

import json
from typing import Any

GROUPS = {
    "fba": ("FBA", "发货、采购、装箱、货件及相关单据"),
    "replenishment": ("备货", "库存与销量采集、分析和补货计算"),
    "operations": ("运营", "Listing、关键词、竞品和评价分析"),
    "common": ("公共能力与维护", "浏览器操作与共用认证维护"),
}
BUILTINS = {
    "list": ("查看可用命令及结构化定义", "lxeskill list"),
    "describe": ("查询指定命令的结构化定义", "lxeskill describe <完整命令>"),
    "datasets list": ("查看数据集目录", "lxeskill datasets list"),
    "doctor": ("检查命令与 Skill 契约", "lxeskill doctor"),
    "cloud-context": ("查看云端身份与授权范围", "lxeskill cloud-context [--server <URL>]"),
    "cloud-status": ("检查云端接入状态", "lxeskill cloud-status [--server <URL>]"),
}


def help_target(arguments: list[str]) -> list[str] | None:
    if not arguments:
        return []
    if arguments[0] == "help":
        return [value for value in arguments[1:] if value not in {"-h", "--help"}]
    if any(value in {"-h", "--help"} for value in arguments):
        # Options belong to execution, not help. Never execute a command because
        # an option precedes --help (for example an export destination).
        target = []
        for value in arguments:
            if value.startswith("-"):
                break
            target.append(value)
        return target
    return None


def command_text(entry: dict[str, Any]) -> str:
    return " ".join(entry["command_path"])


def _rows(items: list[tuple[str, str]]) -> list[str]:
    width = max((len(name) for name, _ in items), default=0)
    return [f"  {name:<{width}}  {description}" for name, description in items]


def _command_help(entry: dict[str, Any]) -> str:
    command = command_text(entry)
    info = entry.get("help", {})
    schema = entry.get("input_schema", {})
    properties = schema.get("properties", {})
    required = set(schema.get("required", []))
    positional = set(entry.get("positional", []))
    usage = "lxeskill " + command
    for name in entry.get("positional", []):
        usage += f" <{name}>"
    if properties or entry.get("input_modes") != ["flags"]:
        usage += " [选项]"
    lines = [info.get("summary", command), "", "用法：", "  " + usage]
    if entry.get("visibility") == "internal":
        lines += ["", "用途：应用集成命令，默认不出现在命令列表和业务导航中。"]
    options = []
    for name, field in properties.items():
        kind = field.get("type", "string")
        kind_text = "/".join(kind) if isinstance(kind, list) else kind
        label = f"<{name}>" if name in positional else "--" + name.replace("_", "-")
        if name not in positional and kind != "boolean":
            label += f" <{kind_text}>"
        details = ["必填" if name in required or name in positional else "可选"]
        if field.get("description"):
            details.append(field["description"])
        if "enum" in field:
            details.append("可选值：" + ", ".join(map(str, field["enum"])))
        if kind == "array":
            details.append("可重复传入，每次一个值")
            if field.get("items", {}).get("enum"):
                details.append("可选值：" + ", ".join(map(str, field["items"]["enum"])))
        if "default" in field:
            details.append("默认 " + json.dumps(field["default"], ensure_ascii=False))
        options.append((label, "；".join(details)))
    if entry.get("input_modes") != ["flags"]:
        options += [("--input-json <文件>", "从 JSON 对象文件读取参数，与 --stdin-json 二选一"),
                    ("--stdin-json", "从标准输入读取 JSON 对象")]
    if entry.get("session_mode") == "lxe_session":
        options.append(("--session-id <ID>", "指定会话；默认使用 LXE_AGENT_SESSION_ID"))
    options.append(("-h, --help", "查看帮助，不执行业务"))
    lines += ["", "参数：", *_rows(options)]
    if entry.get("input_modes") == ["flags"]:
        lines += ["", "输入：仅支持命令行参数。"]
    if info.get("notes"):
        lines += ["", "说明：", *("  " + note for note in info["notes"])]
    examples = info.get("examples", [])
    if examples:
        lines += ["", "示例（尖括号内容需替换为实际值）：", *("  " + example for example in examples)]
    lines += ["", "业务结果通过 stdout 返回 JSON，诊断输出到 stderr。", "查询结构化定义：lxeskill describe " + command]
    return "\n".join(lines)


def render_help(target: list[str], catalog: dict[str, dict[str, Any]], *, business_navigation: bool = False) -> str:
    entries = list(catalog.values())
    name = " ".join(target)
    if not target:
        return "\n".join([
            "LXE 业务命令行工具", "", "业务分组：",
            *_rows([(f"help {key}", f"{label}：{description}") for key, (label, description) in GROUPS.items() if key != "common"]),
            "", "公共能力：", "  help common  浏览器操作与共用认证维护", "", "查询与检查：",
            *_rows([(key, value[0]) for key, value in BUILTINS.items()]), "", "用法：",
            "  lxeskill help <业务分组>      按业务用途查找现有命令",
            "  lxeskill <命令前缀> --help    查看该前缀下的命令",
            "  lxeskill <完整命令> --help    查看参数和示例",
            "", "帮助为只读查询，无需业务账号；list、describe 仍返回结构化 JSON。",
        ])
    if business_navigation and name in GROUPS:
        label, description = GROUPS[name]
        selected = [e for e in entries if e.get("visibility") != "internal" and e.get("help", {}).get("group") == name]
        sections: dict[str, list[tuple[str, str]]] = {}
        for entry in selected:
            info = entry["help"]
            sections.setdefault(info["section"], []).append((command_text(entry), info["summary"]))
        lines = [f"{label}：{description}"]
        for section, commands in sections.items():
            lines += ["", section + "：", *_rows(commands)]
        lines += ["", "以上为现有完整命令路径，执行时加 lxeskill 前缀；不需要再加业务分组名。",
                  "使用 lxeskill <完整命令> --help 查看参数和示例。"]
        return "\n".join(lines)
    if name in BUILTINS:
        description, usage = BUILTINS[name]
        lines = [description, "", "用法：", "  " + usage, "", "执行结果：stdout 返回结构化 JSON。"]
        if name == "describe":
            lines += ["", "示例：", "  lxeskill describe mabang delivery export"]
        if name.startswith("cloud-"):
            lines += ["", "参数：", "  --server <URL>  指定云端服务地址；省略时使用已配置地址。"]
        lines += ["", "-h, --help  只显示帮助，不执行查询或检查。"]
        return "\n".join(lines)
    for entry in entries:
        if name == command_text(entry) or name in entry.get("legacy_aliases", []):
            return _command_help(entry)
        path = entry["command_path"]
        if entry.get("positional") and target[:len(path)] == path and len(target) - len(path) <= len(entry["positional"]):
            return _command_help(entry)
    children: dict[str, str] = {}
    for entry in entries:
        path = entry["command_path"]
        if entry.get("visibility") == "internal" or path[:len(target)] != target or len(path) <= len(target):
            continue
        child = " ".join(path[:len(target)+1])
        children[child] = entry.get("help", {}).get("summary", "") if len(path) == len(target)+1 else "命令组，追加 --help 继续查看"
    for key, (description, _) in BUILTINS.items():
        if key.split()[:len(target)] == target and len(key.split()) > len(target):
            children[key] = description
    if children:
        return "\n".join([f"命令组：lxeskill {name}", "", *_rows(list(children.items())), "",
                          "以上为完整命令路径，执行时加 lxeskill 前缀。", "追加 --help 查看下一层或具体参数。"])
    raise ValueError(f"unknown lxeskill help target: {name}; use lxeskill --help or lxeskill list")
