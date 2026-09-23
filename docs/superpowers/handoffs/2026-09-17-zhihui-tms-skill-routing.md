# 智汇 TMS 阶段 9 交付：自然语言 Skill 路由扩展

## 位置与范围

- Worktree：`/Users/hym/.codex/worktrees/f797/LXE_AGENT`
- 分支：`codex/zhihui-tms-client-auth`
- 只扩展 LLM 自然语言到业务 Skill 的触发语义；不改变 CLI、接口参数、凭据注入、频控、重试或生产调用。

## 完成内容

- `skills/zhihui-tms-product-export/SKILL.md` 增加导出、下载、拉取、整理、Excel/XLSX、SKU、销量、库存、入库时间、上架时间和口语化表达示例。
- 明确排除订单、物流、发货、采购、财务、独立历史销量和独立历史库存报表，避免过宽路由。
- `catalog.json` 的 `request` 描述同步自然语言表达，owner skill 仍为 `zhihui-tms-product-export`，命令仍为 `lxeskill tms philippines products-export`。
- 增加 Skill manifest 契约测试，验证触发词覆盖和排除边界。

## 验证

- `uv run --no-sync pytest python/lxeskill_cli/tests/zhihui_tms/test_cli_entry.py -q`：14 passed。
- `bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts`：4 passed。
- `git diff --check`：通过。
- 未调用真实智汇接口，未使用账号、密码或生产开关。

## Git 与下一步

- 本核心尚未 `git add`、`git commit`、`push`，等待用户批准。
- 建议提交信息：`feat: broaden Zhihui TMS skill routing phrases`。
- 批准后只暂存本阶段 4 个文件；提交后按用户要求同步最新 `main` 并检查冲突。
