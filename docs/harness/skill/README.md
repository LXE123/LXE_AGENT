# Skill Docs

状态：Current

本目录是 skill 文档的规范入口。当前运行时 skill 的事实来源是 [`skills/*/SKILL.md`](../../../skills)，本目录只做维护导航、当前 catalog、历史归档和外部参考资料。

## 当前入口

- [Current skill catalog](current_skill_catalog.md)：当前运行中 22 个 skill 的分组、用途、触发场景和运行时文件链接。
- [Archive](archive/README.md)：历史草稿、阶段记录、脱敏流程记录和早期 skill 设计笔记。
- [Reference](reference/README.md)：外部平台/API 参考资料。
- [`skills/*/SKILL.md`](../../../skills)：agent 实际加载的 runtime skill prompt。

## 运行时事实来源

当前 runtime 由 [`agent_runtime.skill_index`](../../../agent_runtime/skill_index.py) 扫描 `skills/**/SKILL.md`。只有文件名为 `SKILL.md` 的文档会进入 skill index，`SKILL.hidden.md` 不会被加载。

bot 可见 skill 由 [`config/permission_policy.yaml`](../../../config/permission_policy.yaml) 中的 `skill_types` 控制：

- `AMAZON_FBA` 可见 `amazon_fba` 和 `default`。
- 备货 bot 可见 `amazon_replenish` 和 `default`。
- `LXE_CLAW` 可见全部 skill。

## 目录结构

| 路径 | 状态 | 阅读规则 |
| --- | --- | --- |
| [current_skill_catalog.md](current_skill_catalog.md) | `Current` | 当前 skill 总览，只做摘要和链接，不复制完整 prompt。 |
| [archive](archive/README.md) | `Archive` | 历史材料按当前 runtime skill slug 归档，已统一状态头和标题；只作为维护背景。 |
| [reference](reference/README.md) | `Reference` | 外部平台/API 资料，不是 runtime skill index 的一部分。 |

## Hidden Skill

[`skills/replenishment-amazon-fba-inventory-snapshot/SKILL.hidden.md`](../../../skills/replenishment-amazon-fba-inventory-snapshot/SKILL.hidden.md) 是保留文件，但当前 `skill_index` 不加载它，因此不列入当前运行中 skill catalog。
