# 智汇 TMS 阶段 7 交付：Desktop 工具卡实时进度

## 位置与范围

- Worktree / Pool：`/Users/hym/.codex/worktrees/f797/LXE_AGENT`（继续使用当前工作区，不新建 Pool）。
- 分支：`codex/zhihui-tms-client-auth`，不是 `main`。
- 只实现智汇 TMS 商品导出的 Desktop 可视进度；未触碰雅仓业务。
- 上一核心的 CLI JSONL 进度及测试仍是本工作区未提交修改，见 `2026-09-17-zhihui-tms-desktop-progress.md`。本次变更在其上继续。

## 完成内容与调用链

`lxeskill tms philippines products-export` 输出白名单 JSONL → Agent `exec` stdout 增量解析 → `zhihui_tms.progress` Agent 事件 → Gateway 依据 session/turn/tool call 更新运行中的 `exec` 工具卡 → Desktop 页面卡片摘要显示阶段。完成后原有工具结果和 `background_task.changed` 终态仍覆盖进度。

- 解析器只接受当前七种阶段、确切字段和有界整数；额外字段、长行、其它命令及错误形状均不进入进度事件。协议事件再用受控文案格式与长度校验；不透传原始 stdout、账号、Token、下载 URL。
- 只对现有 catalog 识别出的智汇商品导出命令开启解析；不改变调用频率、401/403/429 停止策略、Selenium 链路或附件交付行为。
- 进度早于工具卡到达时暂存；只更新同会话、同回合、同工具调用且仍在运行的卡；终态覆盖并阻止迟到进度重新写入。界面保留原命令文字，并另外显示阶段文字。
- 协议版本从 22 升为 23。没有新增环境变量；既有智汇凭据与生产开关继续走项目现有配置，不写入代码或文档。

## 修改文件

- Runtime：`packages/agent/runtime/src/tooling/coding/{zhihui-progress.ts,process-manager.ts,exec-tools.ts,public-types.ts,register.ts}`、`coding-tools.ts`；测试 `test/tooling/zhihui-progress.test.ts`。
- Agent / 协议：`apps/agent-cli/src/{runtime-host.ts,server.ts}`，`packages/foundation/desktop-protocol/src/index.ts` 及 `test/{json-rpc,protocol}.test.ts`，`docs/harness/tool/ask-user-question.md`。
- Gateway / 页面：`apps/gateway/src/orchestration/local-conversation.ts` 及对应测试，`apps/dashboard/src/features/sessions/{conversation.ts,view.tsx}`、`src/styles.css` 及对应测试。
- 本计划：`docs/superpowers/plans/2026-09-17-zhihui-tms-desktop-live-progress.md`。上一阶段未提交文件详见上一交付文档。

## 验证结果

- 五份定向 Bun 测试：75 pass、0 fail；覆盖解析、stdout 回调、协议拒绝伪造字段、Gateway 先到/后到/终态/隔离和页面投影。
- 上阶段模型侧 JSONL 定向测试：1 pass。
- 智汇 Python 测试：60 pass（`UV_CACHE_DIR=/private/tmp/uv-cache-zhihui-progress UV_OFFLINE=1 uv run --no-sync pytest python/lxeskill_cli/tests/zhihui_tms`）。默认 uv 缓存路径在本沙箱不可写，故使用可写临时缓存与已有独立 `.venv`。
- desktop-protocol、runtime、agent-cli、gateway、dashboard、desktop 六个包 typecheck：均 exit 0。Dashboard build：exit 0（有既有 500 kB chunk 警告）。`git diff --check`：exit 0。
- 未调用真实智汇接口、未用真实账号、未启动 Desktop 人工点击验收；因此这里只确认本地模拟链路，不能宣称生产端到端完成。整份 `coding-tools.test.ts` 的已知缺少固定版 `fd` 环境问题仍在；未把整份测试报告为通过。

## Git 与下一步

- 尚未执行 `git add`、`git commit`、`push` 或分支同步；用户要求先给出精确文件和英文 commit message，再单独批准 add/commit，push 另行确认。
- 下一窗口先检查本工作区和本交付文档，不要创建 pool2，不要开发雅仓，不要越权提交。等待用户对阶段 6、7 的分批暂存/提交决策；随后可做真实 Desktop 界面人工联调。生产账号联调必须另向用户取得授权、范围及平台确认的频控要求。一个新核心结束再写交付文档并交接清晰命名的窗口。
