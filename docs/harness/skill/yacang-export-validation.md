# 雅仓数据导出：实现与验收记录

本次从 `main` 独立实现，参考 PR #65（`49df456ffc3cbb90a331ba1a6af504378a15e1d5`）的登录协议、三个导出接口、队列条件和原表校验。没有移植旧自然语言解析器、预览命令、真实接口开关或备货计算。

## 使用与状态

桌面“雅仓”设置只需手机号和密码。密码放在现有加密存储，界面仅显示是否配置；配置版本从 v9 升到 v10。开发环境可在 `settings.json` 的 `integrations.yacang` 配置 `managed` 和 `mobile`，密码通过 `LXE_YACANG_PASSWORD` 注入；已保存的密码优先，清除配置后不会因环境变量而恢复账号。

唯一业务命令是 `lxeskill yacang export run --params '<JSON>'`。三类报表为 `inventory-sales`、`inventory-current-snapshot`、`warehouse-products`。默认四仓，产品资料全局只导出一次。库存动销默认不发送创建日期，也不会把“7 天销量”改成创建日期筛选。

原始 XLSX 放在 `yacang/exports/<账号摘要>/<本次运行编号>/`。校验后原子发布，不改写源表；结果保留报表、仓库、实际请求筛选、工作表、行数及局部失败。产品资料沿用平台 `status=1` 范围，不声称覆盖其他状态，也不把创建时间冒称入库或上架时间。

每次执行一个客户端、登录一次。同一账号用跨进程任务锁防止登录相互干扰，平台请求另有串行锁。Token 只保留在内存；非敏感提交记录与冷却记录保存在 Python 所属 `lxeskill.sqlite3`，不进入 Agent 会话库。提交结果不明时保留基线 ID；用户重试只恢复队列核对，不再次提交。平台任务明确完成后移除记录，允许后续重新导出。

## 自动化验证

测试在仓库根运行，使用本地 HTTP 服务模拟 PR 的协议形状，并非真实平台验收：

- 三类报表和两种队列格式、默认九份文件、指定仓库、显式日期和无日期、隐藏日期筛选拒绝、全局资料状态校验。
- 旧任务排除、多个候选拒绝、同账号并发登录阻止、跨进程锁、提交记录恢复及账号隔离。
- 正常与零行工作簿、表头异常、仓库不符、非 XLSX、原文件字节不变、部分成功的 CLI 附件保留。
- 验证码异常、缺少 Token、非 JSON、401/403/429、网络超时、提交结果不明；只有队列查询允许有限重试。
- 错误中真实诊断保留、凭据和签名 URL 脱敏后截断、密码不出现在界面或设置明文、开发环境注入、清除配置不复活密码。
- 配置迁移、Skill 归属、Python/Bun 命令契约、附件目录登记及前端构建。

定向命令：

```sh
uv run --frozen pytest -q python/lxeskill_cli/tests/yacang python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra
bun test apps/desktop/test/config-store.test.ts apps/desktop/test/config-store-repository.test.ts apps/desktop/test/ipc-validation.test.ts apps/dashboard/test/desktop/settings-model.test.ts packages/agent/runtime/test/tooling/lxeskill-command.test.ts packages/agent/runtime/test/tooling/skills.test.ts
bun run dashboard:build
```

最终 rebase 后运行仓库完整验证 `bun run verify`，结果以任务交付记录为准。

## 真实验收：未完成

2026-09-23 检查时，当前环境没有雅仓账号环境变量，开发桌面 v9 配置也没有雅仓账号。本次未执行真实登录、真实导出或网页文件对照。PR 协议与模拟测试不能证明生产接口支持无创建日期导出；平台拒绝或实际附加日期时，Skill 应回问日期，不能自动改成当天。

账号在新版桌面配置后，仍需完成：

1. 单仓库存动销不设置创建日期，与网页相同范围对照；再验证显式日期。
2. 单仓当前库存及全局产品资料，与网页原表的表头、仓库、行数和业务范围对照。
3. 普通 Agent Loop：笼统请求先问类型，“库存和销量”只导一类；取消停止；历史库存或逐日销量先解释限制；产品资料要求单仓时先确认全局范围。
4. 部分成功只交付已完成文件；模拟附件发送失败后仅重试交付，不重复导出。独立 Skill 与东南亚入口各测试一次，确保不会重复发送。

这些模型交互规则已写入 Skill，但未运行真实模型端到端验收，不将文档检查称为模型行为测试通过。
