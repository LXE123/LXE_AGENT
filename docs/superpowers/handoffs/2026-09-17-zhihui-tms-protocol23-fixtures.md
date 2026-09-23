# 智汇 TMS 阶段 8 交付：协议 23 测试夹具同步

## 范围

- Worktree：`/Users/hym/.codex/worktrees/f797/LXE_AGENT`
- 分支：`codex/zhihui-tms-client-auth`
- 只修复智汇 Desktop 进度功能带来的 Agent 协议版本 23 测试夹具遗漏；不调用真实智汇接口，不涉及雅仓。

## 完成内容

- `apps/gateway/test/orchestration/fixtures/json-rpc-peer.mjs` 的 initialize 请求和成功响应版本由旧值 22 同步为 23。
- `apps/gateway/test/orchestration/fixtures/fake-agent-cli.mjs` 的模拟 Agent 版本同步为 23。
- 生产代码仍统一使用 `@lxe/desktop-protocol` 的 `AGENT_PROTOCOL_VERSION`，没有新增硬编码生产版本。

## 验证

- `bun test apps/gateway/test/orchestration/json-rpc-process.test.ts`：15 pass。
- `bun test apps/gateway/test/orchestration/process-runtime.test.ts`：10 pass。
- `bun test apps/gateway/test/orchestration/composition.test.ts`：6 pass。
- `git diff --check`：通过。

## Git 与下一步

- 本核心尚未 `git add`、`git commit`、`push`，等待用户批准。
- 建议提交信息：`fix: sync gateway protocol test fixtures to v23`。
- 批准后只暂存本交付文档和上述两个测试夹具；提交后再按用户要求同步最新 `main` 并检查冲突。
