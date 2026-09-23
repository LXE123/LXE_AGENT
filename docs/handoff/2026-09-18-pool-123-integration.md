# Pool 1/2/3 集成交接

## 分支与范围

- 集成分支：`codex/integrate-pool-123`，基线为 `efd39316`（`feature-amazon-replenish-multi-platform`）。
- Pool 1：`codex/zhihui-tms-analysis`，合入至 `ae72dc65`。此分支仅包含智汇 TMS 菲律宾导出的设计与客户端认证基础；后续 `codex/zhihui-tms-client-auth` 分支上的完整导出链路不在本次范围。
- Pool 2：`codex/shangman-erp-export-client`，合入至 `9ea85b1d`，包含智慧印尼商品导出、桌面配置、验证码通道与 Skill 契约。
- Pool 3：`feature/new-yacang-module`，合入至 `e1f73fe0`，包含雅仓导出、桌面配置、Skill 与测试。
- Pool 4：`codex/mabang-brazil-overseas-export` 未合入，其工作区有未提交修改。

## 入口与调用链

- 智汇：`services/zhihui/tms_client.py` 提供客户端认证基础；本次 Pool 1 没有暴露完整 CLI。
- 智慧：`skills/shangman-goods-export-workflow-map/SKILL.md` → `lxeskill` catalog → `services/agent_cli/shangman` → `services/shangman`；桌面设置经 `apps/desktop/src/main/config-store` 注入运行环境，验证码通过 Agent Runtime 处理。
- 雅仓：`skills/yacang-export-workflow-map/SKILL.md` → `lxeskill` catalog → `services/agent_cli/yacang` → `services/yacang`；桌面设置经相同配置层注入运行环境。
- 两个平台的桌面设置与展示在 `apps/dashboard/src/desktop`、`apps/dashboard/src/shared/i18n.tsx`，配置契约在 `packages/foundation/desktop-protocol/src/index.ts`。

## 冲突处理与文件

- 保留智慧、雅仓双方的配置字段、密钥字段、设置入口、翻译、Skill 标签和 catalog 命令。
- 保持当前桌面设置 schema 版本 10，并允许读取旧版 schema 9；补齐 schema 8 迁移两种平台的测试。
- 更新合并后的 catalog/Skill 数量断言，修正旧雅仓权限类型测试的过期预期。
- 主要人工修改：`apps/dashboard/src/desktop/shell.tsx`、`apps/dashboard/src/shared/i18n.tsx`、`apps/desktop/src/main/config-store/model.ts`、`python/lxeskill_cli/lxeskill/catalog.json` 及对应测试。其他平台专属文件来自原分支提交。

## 环境与验证

- 不新增密钥文件。雅仓使用 `LXE_YACANG_MOBILE`、`LXE_YACANG_PASSWORD`、`LXE_YACANG_PROD_ENABLED`；智慧使用 `LXE_SHANGMAN_TENANT_ID`、`LXE_SHANGMAN_USERNAME`、`LXE_SHANGMAN_PROCESSED_PASSWORD`、`LXE_SHANGMAN_BASIC_AUTH`、`LXE_SHANGMAN_PROD_ENABLED`，均由桌面配置层提供。
- 本次运行：`bun run typecheck` 通过；`bun run dashboard:build` 通过（存在既有的大 chunk 提示）；Bun 定向测试 81 通过、1 跳过；Python 平台与契约定向测试 463 通过；Python infra 测试 122 通过。
- 尚未在真实第三方平台执行在线导出或认证；合入 `main` 前仍须按项目规范在最终基线上运行一次全量验证。

## 下一步

1. 在原仓库审阅 `codex/integrate-pool-123` 分支与三个源分支的提交关系。
2. 若需要智汇完整导出功能，单独评估 `codex/zhihui-tms-client-auth`，不要将它视作本次 Pool 1 已交付内容。
3. 合入 `main` 前同步最新 `main`，按项目规范处理冲突并运行一次全量验证；`push` 需用户单独确认。
