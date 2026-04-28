from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path


@dataclass(frozen=True)
class SkillReferenceManifest:
    path: str
    description: str


@dataclass(frozen=True)
class SkillManifest:
    name: str
    description: str
    type: str
    references: list[SkillReferenceManifest] = field(default_factory=list)
    body_path: Path = field(default_factory=Path)
    root_dir: Path = field(default_factory=Path)


@dataclass(frozen=True)
class SkillQueueItem:
    name: str
    description: str
    location: str = ""
