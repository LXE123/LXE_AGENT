"""Per-turn skill/tool usage extraction from TurnLog.

Two skill event kinds are derived from tool steps:

- ``skill_activation``: the model read a skill's SKILL.md via the ``read``
  tool. Deduplicated per turn — re-reading the same SKILL.md counts once.
- ``skill_execution``: the model ran a skill-owned script via the ``exec``
  tool. Every run counts. Ownership comes from the ``commands`` list in the
  skill's SKILL.md front matter (python module signatures), or from the
  script living under ``skills/<dir>/scripts/``.

``success`` on executions reflects tool-level success (the process ran and
exited); a CLI that ran fine but reported a business failure in its JSON
output is still a successful execution here.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from typing import Any

from shared.logging import get_logger

from .skill_index import SKILLS_ROOT, load_skill_index
from .types import TurnLog

logger = get_logger(__name__)

_READ_TOOL = "read"
_EXEC_TOOL = "exec"
_SKILL_MD_PATTERN = re.compile(r"skills/((?:[^/\s]+/)*[^/\s]+)/SKILL\.md$")
_SKILL_SCRIPT_PATTERN = re.compile(r"skills/((?:[^/\s\"']+/)*?[^/\s\"']+)/scripts/[^\s\"']+")


@dataclass(frozen=True)
class SkillCommandIndex:
    """Lookup tables mapping tool arguments back to owning skills."""

    # skills/-relative dir path ("fba-shipment-create") -> (skill name, module/type)
    dirs: dict[str, tuple[str, str]] = field(default_factory=dict)
    # declared command signature -> (skill name, module/type, compiled matcher)
    commands: list[tuple[str, str, str, re.Pattern[str]]] = field(default_factory=list)


def _command_matcher(signature: str) -> re.Pattern[str]:
    return re.compile(rf"(?<![\w.]){re.escape(signature)}(?![\w.])")


def build_skill_command_index() -> SkillCommandIndex:
    dirs: dict[str, tuple[str, str]] = {}
    commands: list[tuple[str, str, str, re.Pattern[str]]] = []
    try:
        manifests = load_skill_index().all()
    except Exception as error:
        logger.warning("[UsageStats] skill index unavailable: %s", error)
        return SkillCommandIndex()
    for manifest in manifests:
        try:
            rel_dir = manifest.root_dir.resolve().relative_to(SKILLS_ROOT.resolve())
            dirs[rel_dir.as_posix()] = (manifest.name, manifest.type)
        except Exception:
            pass
        for signature in manifest.commands:
            commands.append((signature, manifest.name, manifest.type, _command_matcher(signature)))
    return SkillCommandIndex(dirs=dirs, commands=commands)


@dataclass
class ToolUsage:
    name: str
    calls: int = 0
    errors: int = 0
    duration_ms: int = 0


@dataclass
class SkillActivation:
    skill: str
    module: str


@dataclass
class SkillExecution:
    skill: str
    module: str
    command: str  # matched signature or skills/<dir>/scripts path
    success: bool
    duration_ms: int


@dataclass
class TurnUsageReport:
    session_id: str = ""
    turn_id: str = ""
    started_at: float = 0.0
    status: str = ""
    elapsed_ms: int = 0
    llm_calls: int = 0
    tool_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    tools: list[ToolUsage] = field(default_factory=list)
    activations: list[SkillActivation] = field(default_factory=list)
    executions: list[SkillExecution] = field(default_factory=list)

    def to_record(self) -> dict[str, Any]:
        """Plain-dict shape consumed by shared.db (no agent_runtime imports there)."""
        return asdict(self)


def _normalize_path_text(value: Any) -> str:
    return str(value or "").strip().replace("\\", "/")


def _skill_for_skill_md_path(path: Any, index: SkillCommandIndex) -> tuple[str, str] | None:
    match = _SKILL_MD_PATTERN.search(_normalize_path_text(path))
    if match is None:
        return None
    return index.dirs.get(match.group(1))


def _skills_for_exec_command(command: Any, index: SkillCommandIndex) -> list[tuple[str, str, str]]:
    """Return (skill, module, matched command) entries for one exec command."""
    text = _normalize_path_text(command)
    if not text:
        return []
    found: list[tuple[str, str, str]] = []
    seen: set[tuple[str, str]] = set()
    for dir_match in _SKILL_SCRIPT_PATTERN.finditer(text):
        owner = index.dirs.get(dir_match.group(1))
        if owner is None:
            continue
        key = (owner[0], dir_match.group(0))
        if key not in seen:
            seen.add(key)
            found.append((owner[0], owner[1], dir_match.group(0)))
    for signature, skill, module, matcher in index.commands:
        if matcher.search(text) is None:
            continue
        key = (skill, signature)
        if key not in seen:
            seen.add(key)
            found.append((skill, module, signature))
    return found


def collect_turn_usage(
    turn_log: TurnLog,
    *,
    index: SkillCommandIndex | None = None,
) -> TurnUsageReport:
    """Derive the per-turn usage report from a finalized TurnLog."""
    safe_index = index if index is not None else build_skill_command_index()
    report = TurnUsageReport(
        session_id=str(turn_log.session_id or ""),
        turn_id=str(turn_log.turn_id or ""),
        started_at=float(turn_log.started_at or 0.0),
        status=str(turn_log.status or ""),
        elapsed_ms=int(turn_log.elapsed_ms or 0),
        llm_calls=int(turn_log.total_llm_calls or 0),
        tool_calls=int(turn_log.total_tool_calls or 0),
        input_tokens=int(turn_log.total_input_tokens or 0),
        output_tokens=int(turn_log.total_output_tokens or 0),
    )

    tools: dict[str, ToolUsage] = {}
    activated: dict[str, str] = {}

    for step in list(turn_log.steps or []):
        tool_name = str(step.tool_name or "").strip()
        if not tool_name:
            continue
        usage = tools.setdefault(tool_name, ToolUsage(name=tool_name))
        if step.event == "tool_call":
            usage.calls += 1
            if tool_name == _READ_TOOL:
                owner = _skill_for_skill_md_path(dict(step.tool_args or {}).get("path"), safe_index)
                if owner is not None:
                    activated.setdefault(owner[0], owner[1])
        elif step.event in ("tool_result", "tool_error"):
            usage.duration_ms += max(0, int(step.duration_ms or 0))
            if step.event == "tool_error":
                usage.errors += 1
            if tool_name == _EXEC_TOOL:
                command = dict(step.tool_args or {}).get("command")
                for skill, module, matched in _skills_for_exec_command(command, safe_index):
                    report.executions.append(
                        SkillExecution(
                            skill=skill,
                            module=module,
                            command=matched,
                            success=step.event == "tool_result",
                            duration_ms=max(0, int(step.duration_ms or 0)),
                        )
                    )

    report.tools = sorted(tools.values(), key=lambda item: item.name)
    report.activations = [
        SkillActivation(skill=skill, module=module) for skill, module in sorted(activated.items())
    ]
    return report


__all__ = [
    "SkillActivation",
    "SkillCommandIndex",
    "SkillExecution",
    "ToolUsage",
    "TurnUsageReport",
    "build_skill_command_index",
    "collect_turn_usage",
]
