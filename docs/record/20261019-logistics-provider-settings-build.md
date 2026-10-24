# 物流商配置模块构建说明

- 日期：2026-10-19；最新交接：2026-10-23。
- 天泰续验：用户回传自动登录通过，尚未明确两个账号是否均已验收；新增真实查询行暴露箱号规范化缺口，修复及样本见 [物流交接第 40 节](20261012-fba-logistics-delivery-window-handoff.md#40-天泰登录回传与箱号匹配修正2026-10-22)。不要继续把天泰登录整体列为未验收，也不扩大为双账号查询已通过。
- 目标：在 LXE Agent Desktop 的“设置 → 业务集成”中维护物流商实际登录账号与加密密码，同一账号跨店铺复用；店铺由执行任务明确，实时状态复用现有浏览器模块。
- 当前状态：配置、原只读链路及 `FBA19SS5YN6R` 改期 dry-run 模拟已由用户回传验收，未写入。威飒配置凭据登录、页面公司核对、统一入口复用登录查询及 UPS 官方只读续验现已收到真实会话成功摘要；见第 26 节。云驼配置凭据已真实提交并进入 `/home`，自动查询页导航及统一查询待按第 30 节复验。飞沃可直接查询，不要求先登录，也不列自动登录待办；天泰自动登录已有用户通过摘要，具体双账号覆盖待补充，其他供应商统一入口实页仍待各自验证。
- 本文范围：第 1–22 节保留构建方案、实现和交接历史；配置设计见第 23 节，查询验收见第 26 节，新增/编辑弹窗见第 27 节，云驼最新归档和测试入口见第 30 节，凭据加密沿用第 20 节。完整物流闭环的最新恢复入口统一以[物流交接第 42 节](20261012-fba-logistics-delivery-window-handoff.md#42-本轮归档与下一轮恢复入口2026-10-23)为准。旧方案中“不配置密码”“必填公司名称”和“固定绑定紫鸟店铺”的要求均已被用户新要求替代。配置构建阶段没有修改物流订单、Amazon 或原始表格。
- 相关现状：[美国 FBA 物流查询与送达时段更新交接](20261012-fba-logistics-delivery-window-handoff.md)。

## 1. 已确认的产品位置

模块放在桌面设置弹窗的“业务集成”分组，与“紫鸟自动化”“ERP 账号”“飞书”同级，不放入业务工作台，也不塞进 ERP 账号的四个平台页签。

建议顺序：

```text
业务集成
  紫鸟自动化
  ERP 账号
  物流商配置
  飞书
  日志与排障
```

左侧摘要显示配置数量，例如“已配置 6 条”；没有配置时显示“未配置”。物流配置不是桌面首次启动的必填项，不影响 `DesktopSetupState.complete`，也不参加现有 ERP 的“已配置 0/4”统计。

现有设置弹窗整体是一个 `<form>`，底部通用“保存”按钮会调用 `saveSetup()`。物流商页面不得在其中嵌套另一个 `<form>`，也不得复用 `saveSetup()`。该分区使用普通容器和 `type="button"` 按钮，通过独立 IPC 保存；激活物流商分区时隐藏底部通用保存按钮。

## 2. 本期能力和非目标

第一阶段完成配置模块：

1. 展示固定支持的物流商。
2. 新增、编辑、启用、停用和删除配置。
3. 允许同一物流商建立多个公司账户配置，例如两个天泰账户。
4. 对需要紫鸟的物流商，选择一个实时发现的紫鸟店铺并保存业务绑定。
5. 展示当前店铺是否存在、是否运行，以及绑定是否唯一。
6. 严格校验配置，不接受任意 URL、模块名、脚本或认证材料。

第二阶段在第一阶段稳定后增加统一查询入口，按配置选择现有物流商适配器。不要在第一阶段顺便实现批量导入、尾程 ETA 查询或 Amazon 改期。

本期不做：

- 不实现物流商账号密码登录、验证码处理或自动切换账户。
- 不保存 Cookie、token、sign、Authorization、浏览器端口、`browser_id`、WebDriver 会话或页面 ref。
- 不允许用户配置请求 URL、HTTP 方法、JavaScript、Python 模块路径或请求头。
- 不启动、重启或退出紫鸟店铺，不导航到物流网站。
- 不把历史验证时间当作当前登录态，不把店铺绑定当作当前页面正确的证明。
- 不在 Bun `agent.sqlite3` 建配置表，也不在 Python 数据库建立 agent 会话影子表。

## 3. 现有实现边界

### 3.1 桌面公共设置

`apps/desktop/src/main/config-store` 负责桌面公共 `settings.json`、加密 `secrets.bin`、文件锁、并发修改检测和 schema 迁移。现有 `integrations` 是固定平台的单账户模型，字段白名单严格，修改会带来设置 schema 升级。

物流商配置是动态列表，而且以后会由普通 `lxeskill` 命令读取。不要把整张列表扩进 `DesktopConfig.integrations`。如未来需要物流商密码，必须单独设计加密凭证存储，不能把密码加入本模块的公开配置文件。

### 3.2 复杂业务配置先例

“越南备货设置”采用独立 Desktop IPC、独立设置服务和 `LXE_DATA_ROOT/skill-data` 下的原子文件存储，桌面与普通 Python 命令读取同一份业务输入。物流商配置沿用这个形状：Python 负责 schema 校验、文件锁、原子替换和读取快照；Desktop 服务只负责受控调用并转发有界诊断。

这份文件是应用级业务配置，不是 Python 进程会话状态。Python 命令仍是一次性执行器；浏览器真实状态继续来自紫鸟实时接口及当前 Selenium 附着结果。

### 3.3 已有物流查询命令

当前已经存在：

| provider_id | 命令 | 通道 | 店铺 | 公司账户名 |
| --- | --- | --- | --- | --- |
| `wesa` | `lxeskill logistics wesa query` | 紫鸟页面 | 必填 | 必填 |
| `feiwo` | `lxeskill logistics feiwo query` | 紫鸟页面 | 必填 | 不使用 |
| `yuntuo` | `lxeskill logistics yuntuo query` | 紫鸟页面 | 必填 | 当前命令不使用 |
| `tiantai` | `lxeskill logistics tiantai query` | 紫鸟页面 | 必填 | 必填 |
| `jiufang` | `lxeskill logistics jiufang query` | 公开 HTTP | 不使用 | 不使用 |

所有业务模块已经遵守 `run(arguments) -> payload dict`。浏览器型命令使用官方配对 Selenium、`strict_attach=True` 和固定目标域名；九方使用固定公开接口。配置模块不能改变这些安全约束。

## 4. 固定供应商注册表

新增代码注册表，不能从用户配置动态生成。建议文件：

```text
python/lxeskill_cli/services/agent_cli/logistics/provider_registry.py
```

注册表至少包含：

```python
ProviderSpec(
    provider_id="tiantai",
    label="天泰供应链",
    transport="ziniao_browser",
    requires_store=True,
    requires_account_name=True,
    command="lxeskill logistics tiantai query",
)
```

约束：

- `provider_id` 只能来自固定枚举。
- 注册表决定字段显示、校验要求和后续适配器路由。
- 固定 origin、路径、请求参数和认证处理仍保留在各查询模块中。
- 新物流商必须先实现独立适配器、真实响应契约和测试，再加入注册表。
- 暂未实现的掌柜、合联国际、天美通不能作为“可查询”供应商伪装加入。

## 5. 配置数据模型

建议存储位置：

```text
<LXE_DATA_ROOT>/skill-data/logistics-query/profiles.json
<LXE_DATA_ROOT>/skill-data/logistics-query/.settings.lock
```

建议 schema：

```json
{
  "schema_version": 1,
  "revision": 1,
  "profiles": [
    {
      "profile_id": "4d98d090-977a-4fad-94b8-b6a9a764df7c",
      "display_name": "天泰-新棱镜",
      "provider_id": "tiantai",
      "enabled": true,
      "store_binding": {
        "store_id": "VycOXC1cvUBC/rBIOnYXUg==",
        "store_name": "Amazon-Yunjian-US 深圳市久艺电子商务有限公司"
      },
      "account_name": "深圳市新棱镜贸易有限公司",
      "created_at": "2026-10-19T00:00:00Z",
      "updated_at": "2026-10-19T00:00:00Z"
    }
  ]
}
```

字段规则：

| 字段 | 规则 |
| --- | --- |
| `profile_id` | 服务端生成 UUID；创建后不可由 UI 修改 |
| `revision` | 文件级单调递增整数；每次修改必须携带读取时的 revision |
| `display_name` | 1–80 字符；用户可读名称；同名拒绝，避免查询时误选 |
| `provider_id` | 固定注册表枚举 |
| `enabled` | 布尔值；停用后统一查询入口拒绝使用 |
| `store_binding` | 浏览器型供应商必填；公开接口必须为 `null` |
| `store_id` | 保存业务绑定标识；执行前必须用实时 `get_status` 重新核对 |
| `store_name` | 保存时的可读名称；实时名称不一致时报告冲突，不静默覆盖 |
| `account_name` | 仅注册表要求的供应商必填；2–200 字符 |
| 时间字段 | 服务端生成 UTC ISO 8601；仅表示配置变更时间，不表示登录态或页面验证仍有效 |

配置 schema 不提供 `password`、`secret`、`api_key`、`token`、Cookie、Authorization、sign、调试端口或 browser session 等字段。`store_id` 本身可能呈现为 Base64 形状，因此不能靠字符串外观把它误判为认证 token。读取到未知字段、未知 schema、重复 ID、重复名称或供应商字段组合不合法时应返回真实、有界错误，不悄悄删除或修正原文件。

写入必须：

1. 获取跨进程文件锁。
2. 重新读取并校验当前文件。
3. 写入同目录临时文件，`flush + fsync`。
4. `os.replace` 原子替换。
5. 清理失败遗留的临时文件。

必须使用 `revision` 做乐观并发控制。保存和删除请求携带读到的 revision；锁内重新读取后发现 revision 不一致时提示重新加载，不能覆盖其他窗口或进程的修改。

## 6. Desktop 协议和 IPC

在 `@lxe/desktop-protocol` 定义独立类型，不扩展 `DesktopSetupInput`：

```ts
type DesktopLogisticsProviderId = "wesa" | "feiwo" | "yuntuo" | "tiantai" | "jiufang";

interface DesktopLogisticsStoreBinding {
  store_id: string;
  store_name: string;
}

interface DesktopLogisticsProfile { /* 对应第 5 节 */ }

interface DesktopLogisticsProviderSpec {
  provider_id: DesktopLogisticsProviderId;
  label: string;
  transport: "ziniao_browser" | "public_http";
  requires_store: boolean;
  requires_account_name: boolean;
}

interface DesktopLogisticsStoreStatus {
  store_id: string;
  store_name: string;
  running: boolean;
}

interface DesktopLogisticsSettingsState {
  schema_version: 1;
  revision: number;
  profiles: DesktopLogisticsProfile[];
  providers: DesktopLogisticsProviderSpec[];
  stores: DesktopLogisticsStoreStatus[];
  stores_error: string | null;
}
```

建议桥接方法：

```ts
getLogisticsSettings(): Promise<DesktopLogisticsSettingsState>;
saveLogisticsProfile(input: DesktopLogisticsProfileInput, expectedRevision: number): Promise<DesktopLogisticsSettingsState>;
deleteLogisticsProfile(profileId: string, expectedRevision: number): Promise<DesktopLogisticsSettingsState>;
refreshLogisticsStores(): Promise<DesktopLogisticsSettingsState>;
```

优先使用单条 upsert/delete，减少一个编辑动作覆盖其他配置的风险。成功修改后返回新 revision 和完整状态。

IPC 输入必须在 Electron main 侧再次校验：字段白名单、长度、枚举、UUID、布尔类型和供应商字段组合。不能只依赖 React 或 Python 校验。所有 handler 仅接受主 renderer frame，沿用当前受信 sender 检查。

读取配置失败和读取紫鸟状态失败要分开表达：配置损坏时 `getLogisticsSettings` 返回错误或明确的 `profiles_error`；紫鸟客户端未运行时仍可显示已经保存的 profiles，同时通过 `stores_error` 展示实际诊断。不能把“紫鸟状态不可读”改写成“尚未配置”。

Desktop bridge 启动私有 Python 设置进程时，必须像其他受管子进程一样传入 `LXE_DATA_ROOT`、临时目录和 `config.environment()` 中已有的紫鸟环境变量。密码只通过子进程环境进入现有紫鸟客户端，不进入 argv、配置文件、stdout 或返回对象；错误输出继续使用已有脱敏和长度上限。刷新店铺允许协调 Python 自有的可丢弃 `ziniao_store_sessions` 缓存，但不得读取 Bun agent DB，也不得启动、停止或重启店铺。

## 7. 紫鸟店铺发现和绑定规则

`get_status` 当前能够返回：

- `store_id`：紫鸟 `browserOauth`。
- `browser_id`：当前目录中的浏览器数字 ID。
- `store_name`：店铺名称。
- 运行与未运行列表。

配置只保存 `store_id + store_name`。`browser_id` 不写入配置，因为它不属于业务绑定，也不能代替实时会话材料。

UI 选择规则：

1. 下拉框展示运行及未运行店铺，明确标记状态。
2. 新建浏览器型配置时由用户明确选择，不自动取第一家店铺。
3. 编辑时如果保存的 `store_id` 不在实时列表，保留原绑定并显示“当前未发现”，不能清空。
4. 同一 `store_id` 可以绑定多个不同物流商；同一物流商也可有多个账户配置。
5. `store_id` 相同但 `store_name` 变化时显示冲突，用户重新确认后才更新名称。

本阶段的“刷新店铺”只调用紫鸟实时状态接口，不打开店铺、不附着页面、不启动或退出店铺。完整页面和账户核验仍在实际物流查询时完成。

## 8. 设置页面交互

新增设置 section：`logistics`，导航位置在 `erp` 与 `feishu` 之间。建议图标使用 `Truck` 或 `PackageSearch`。

页面结构：

1. 标题“物流商配置”和一句说明。
2. 顶部操作：“添加物流商”“刷新店铺”。
3. 配置卡片列表，每张卡显示配置名、物流商、查询通道、公司账户、绑定店铺、启用状态和当前店铺状态。
4. 新增/编辑区域根据 provider spec 动态显示字段。
5. 删除需要确认对话框；停用不删除配置。

建议状态文案：

| 状态 | 含义 |
| --- | --- |
| `可用` | 配置合法，所绑定店铺当前运行；不代表物流页面或账户已验证 |
| `店铺未运行` | 实时目录找到店铺，但当前未运行 |
| `当前未发现` | 保存的 `store_id` 不在实时目录 |
| `公开接口` | 供应商不需要紫鸟店铺 |
| `已停用` | 配置存在，但统一查询入口不可使用 |

不得显示“连接成功”来表示仅保存成功，也不得把配置合法写成“账号已登录”。

由于外层设置弹窗已经是 `<form>`：

- 物流面板内部不要创建 `<form>`。
- 所有操作按钮显式使用 `type="button"`。
- `save()` 在 `activeSettingsSection === "logistics"` 时直接返回。
- 设置弹窗底部的通用保存按钮在 logistics 分区隐藏。
- 页面自己的保存操作完成后不关闭整个设置弹窗。
- 切换分区或关闭弹窗时，如果存在未保存草稿，使用现有交互风格提示；不要悄悄丢弃。

中英文文案必须同时补齐。窄窗口下卡片和操作按钮需要换行，不能出现横向溢出。

## 9. 建议文件改动

第一阶段预计涉及：

```text
packages/foundation/desktop-protocol/src/index.ts
apps/desktop/src/ipc-channels.ts
apps/desktop/src/preload-bridge.ts
apps/desktop/src/main/ipc.ts
apps/desktop/src/main/ipc-validation.ts
apps/desktop/src/main.ts
apps/desktop/src/main/logistics-settings.ts                  # 新增 Desktop bridge
apps/dashboard/src/desktop/settings-model.ts
apps/dashboard/src/desktop/shell.tsx
apps/dashboard/src/desktop/logistics-settings-panel.tsx     # 新增
apps/dashboard/src/desktop/logistics-settings.css           # 新增或并入现有设置 CSS
apps/dashboard/src/shared/i18n.tsx
python/lxeskill_cli/services/agent_cli/logistics/provider_registry.py
python/lxeskill_cli/services/agent_cli/logistics/settings.py
```

同时增加对应 Desktop、Dashboard、协议和 Python 定向测试。不要在第一阶段修改五个既有查询适配器的请求逻辑。

## 10. 第二阶段统一查询入口

此门面负责按配置调用物流商适配器、取得运单及尾程承运人/转单号。它不直接决定 Amazon 改期日期，也不因货代 ETA 缺失而阻断已有单号的后续尾程核验；日期来源以第 19 节为准。

第一阶段验收后，可新增：

```text
lxeskill logistics query --profile-id <UUID> --fba <完整FBA> [--expected-warehouse <仓库>]
```

执行步骤：

1. 读取并校验配置快照。
2. 按完整 `profile_id` 找唯一启用配置，不按名称模糊匹配。
3. 从固定注册表取得适配器，不从配置动态 import。
4. 浏览器型供应商先读取实时店铺状态，精确核对 `store_id` 和保存的店铺名称，要求店铺正在运行。
5. 组装现有适配器参数；威飒、天泰传入配置的 `account_name`。
6. 调用现有 `run(arguments)`。
7. 返回统一外层元数据，同时完整保留现有适配器结果、`missing_fields`、`warnings` 和真实脱敏错误。

浏览器型查询仍必须运行在 LXE Agent 执行会话中，复用 `LXE_AGENT_SESSION_ID`，严格附着唯一目标域名。配置不能绕过页面 origin、唯一标签页、账户可见性和响应身份检查。

九方公开接口不需要店铺。统一命令的 session contract 和技能归属在加入 catalog 前要单独定稿：不能因为同一个门面命令而错误要求九方启动浏览器，也不能绕过现有技能权限。`catalog.json` 一旦修改，必须运行 Python CLI/infra 与 Bun 双端契约测试。

## 11. 测试计划

开发阶段只运行与改动相关的定向测试。

### 11.1 Python 设置服务

至少覆盖：

- 首次读取创建空配置。
- 五个 provider 的合法字段组合。
- 同一 provider 多 profile。
- UUID、名称长度、重复名称、未知字段、未知 provider、错误 schema。
- 浏览器型缺店铺、公开型错误携带店铺、必填账户缺失。
- secret/token/cookie/sign 等未知敏感字段被严格 schema 拒绝，同时合法 Base64 形状的 `store_id` 不被误拒。
- 损坏 JSON 保留实际错误，不覆盖原文件。
- 文件锁、原子写入和并发 revision 冲突。
- 读取紫鸟状态失败时 profiles 仍可读取，诊断显式返回。
- 不创建或访问 `agent_sessions`。

### 11.2 Desktop 和协议

至少覆盖：

- 新 IPC channel、preload bridge 和协议类型一致。
- Electron main 输入验证拒绝未知字段、超长文本、错误 UUID 和错误枚举。
- Desktop bridge 对非 JSON、子进程失败、超时和有界诊断的处理。
- 物流配置保存不会调用 `saveSetup()`，不会触发 gateway restart。
- 不把任何配置写入 `settings.json` 或 `secrets.bin`。

### 11.3 Dashboard

至少覆盖：

- 左侧“业务集成”出现“物流商配置”，顺序正确。
- 摘要数量、加载、空状态、错误和重试。
- 不同 provider 动态字段正确。
- 店铺刷新、店铺未运行、当前未发现、名称冲突和公开接口状态。
- 新增、编辑、停用、删除确认和未保存草稿。
- logistics 分区隐藏通用保存按钮，内部没有嵌套 form。
- 保存时不关闭设置弹窗。
- 中英文和窄窗口布局。

### 11.4 第二阶段查询

统一入口加入后覆盖固定路由、禁用 profile、缺失 profile、店铺状态冲突、账户字段传递、公开接口不读取店铺，以及五个现有适配器返回结构不被改写。生产物流网站不用于自动测试；继续使用当前真实响应投影 fixture 和本地 mock。

## 12. 定向验证命令

下一轮根据实际文件调整测试文件名，但从仓库根运行。建议顺序：

```text
uv run pytest <新增物流配置测试> python/lxeskill_cli/tests/browser/test_wesa_query.py python/lxeskill_cli/tests/browser/test_feiwo_query.py python/lxeskill_cli/tests/browser/test_yuntuo_query.py python/lxeskill_cli/tests/browser/test_tiantai_query.py python/lxeskill_cli/tests/logistics/test_jiufang_query.py

bun test <新增 desktop 测试> packages/foundation/desktop-protocol/test

bun run --cwd apps/desktop typecheck
bun run --cwd apps/dashboard typecheck
```

若第二阶段修改 `catalog.json`，额外运行项目规定的双端契约：

```text
uv run pytest python/lxeskill_cli/tests/lxeskill python/lxeskill_cli/tests/infra
bun test packages/agent/runtime/test/tooling/lxeskill-command.test.ts
```

最终合并前按项目流程 rebase 最新 `main`，只运行一次完整验证。代码或基线发生实际变化后，之前的完整验证结果失效。

## 13. 第一阶段验收条件

只有同时满足以下条件，才能宣布配置模块完成：

1. 设置 → 业务集成出现“物流商配置”，位置和摘要正确。
2. 可以保存两个同为天泰但公司账户不同的 profile，不互相覆盖。
3. 威飒/天泰强制公司账户；飞沃/云驼不伪造账户要求；九方不要求店铺。
4. 紫鸟店铺来自实时目录，用户明确选择；多店铺时不会自动取第一条。
5. 保存后的 `store_id` 每次展示时重新与实时目录核对；不保存 `browser_id` 和调试端口。
6. 配置读写原子、并发安全，损坏输入不会覆盖原文件。
7. `settings.json`、`secrets.bin`、Bun agent DB 和 Python SQLite 均未被用于保存这些 profiles。
8. 保存、停用和删除物流配置不会重启 Gateway/Agent。
9. 没有新增 Playwright、Puppeteer 或裸 CDP 页面自动化。
10. 所有定向测试、类型检查和 `git diff --check` 通过。

第一阶段完成只代表配置模块可用，不代表五家物流商当前登录、页面、空结果、失败合同、尾程号码或 ETA 已全部验证。

## 14. 原构建启动提示（历史，最新入口见第 18 节）

以下提示保留原第一阶段构建背景，不作为下一轮重复实施或合并 main 的指令：

> 阅读 `docs/record/20261019-logistics-provider-settings-build.md` 和项目 `AGENTS.md`，实现第一阶段“设置 → 业务集成 → 物流商配置”。先检查当前分支、worktree 和用户已有改动。只实现固定 provider 注册表、配置原子存储、Desktop 独立 IPC、设置页面 CRUD、实时店铺目录刷新和定向测试；不要实现统一查询命令、批量导入、物流网站生产请求、自动登录或 Amazon 改期。不要扩展 `DesktopSetupInput` 保存 profiles，不触发后台重启，不把 profiles 写入 agent DB、Python SQLite、`settings.json` 或 `secrets.bin`。紫鸟状态只读，不启动、重启、退出或导航店铺。所有页面自动化边界继续遵守官方配对 Selenium 规则。开发阶段运行定向测试；准备合并时按 `AGENTS.md` 执行 rebase、一次完整验证、fast-forward 合并和 worktree 归还流程。


## 15. 第一阶段实现记录（2026-10-19）

已实现固定五家 provider 注册表、独立 Python 配置文件、Desktop 私有 IPC 和设置页面 CRUD。
配置按单条 profile 保存，使用跨进程锁、revision、fsync 和原子替换；未知字段、损坏 JSON、
重复标识、重复名称及不合法的供应商字段组合均明确拒绝，不修改原文件。限制 200 条配置、
总文件 1 MiB，并在写入前检查 UTF-8 大小，避免生成随后无法读取的文件。

店铺刷新直接调用现有底层 `ZiniaoClient.get_browser_list/get_running_info`。
未复用会启动客户端或更新内核的高层 getter；未访问页面、启动店铺或创建 SQLite 状态。
实时目录按业务 store_id 优先匹配，旧接口的数字 ID 只作为内存中的后备匹配材料。
配置只保存 store_id 和当时的店铺名；名称冲突必须显式重新确认，缺失绑定不自动清空。

页面包含双语文案、状态区分、删除确认、草稿离开保护和窄窗口换行。
物流保存不调用 `saveSetup()`，不关闭设置弹窗，不参与初始配置完成判断，也不重启后台。
草稿保留最初读到的 revision；刷新不会让旧草稿绕过并发冲突。

测试使用本地 fixture 和独立临时目录；新增真实 Chromium 的 8 组界面回归覆盖完整设置壳。
生产物流网站和紫鸟客户端均未作为测试目标。本期未增加统一查询命令，未修改 catalog 或查询适配器请求逻辑。

本任务以已提交的 `codex/fba-delivery-window` 物流适配器提交为前置基线，再与最新 main 集成。
合并前完整验证结果在后续验证记录中登记。


## 16. 合并前验证记录

任务分支已 rebase 到 `origin/main` 的 `9f36647a`，无冲突。
配置模块实现提交为 `95984c7d`；本节与集成修正单独提交。

- 定向物流 Python 测试：初始配置与五家适配器共 271 项通过；最终新增配置测试增至 60 项并全部通过。
- Desktop、Dashboard 与协议首轮定向测试：87 项通过；补充主 frame 验证后相关用例继续通过。
- 真实 Chromium：物流配置 8 组交互场景通过，中文和英文窄屏截图已查看，无横向溢出。
- `bun run verify`：协议 4 份 schema 检查、生产边界和全仓库类型检查通过；Bun 全量结果为 2152 项通过、10 项跳过、1 项失败。
- 该失败为前置物流分支新增技能缺少中文名称映射。实际扫描 40 份技能，确认两项受覆盖约束的缺失；补齐物流相关三项名称后，`bun test apps/dashboard/test/shared/skill-labels.test.tsx` 的 4 项全部通过，Dashboard 类型检查再次通过。
- 全量 Python 首次在收集阶段发现新增 `test_settings.py` 与越南备货同名，已更名为 `tests/logistics/test_logistics_settings.py`。之后执行 `bun run test:py-tools`：2908 项通过、20 项跳过、30 条现有 aiohttp 弃用警告，退出码 0。
- `git diff --check` 通过。

完整验证后的改动仅为名称映射和测试文件更名；按 `AGENTS.md` 选择定向复验受影响的 Dashboard，
并完成原本因失败尚未执行的全量 Python 阶段，没有重复运行整套全量验证。
不能将第一次 `bun run verify` 记录为直接成功；其发现的问题已分别修复并获得真实通过结果。

此次验证未使用物流生产网站、紫鸟生产客户端或原始业务表格；配置模块完成不等同于物流账户登录态、页面及 ETA 已验收。

## 17. 交付方式纠正：当前 pool-1 分支走 PR

用户明确要求继续在当前 `/Users/lxe-3/LXE_AGENT/.worktrees/pool-1` 工作，并通过 PR 交付。
此前推进本地 main 的操作已撤回：main 恢复到操作前的 `dfaee548`，未推送 main。
物流配置的两个提交已移回 `codex/fba-delivery-window`，对应提交为 `1bc94ccb` 和 `03ddb97e`。
后续以此节为准，不再将本任务记为已合并 main。

2026-10-19 曾核实当前分支对应的 PR 是 [LXE123/LXE_AGENT #91](https://github.com/LXE123/LXE_AGENT/pull/91)，当时状态为 open；不是持续有效的在线状态。
用户随后明确要求先自行测试，完成后再处理 PR；当前没有推送或更新 PR。保持当前工作目录和分支，不强推、不自行合并。
移回后对比确认 apps、packages、python、config 的文件内容与完成验证时完全一致；
差异仅为当前分支尚未纳入的其他技能说明文档及交付记录，不重复执行相同实现的全量测试。
当前目录启动开发应用即可使用该功能，Desktop main/preload 的变更需要重启开发进程。

## 18. 下一轮交接（2026-10-20）

### 当前落点和交付约束

- 工作目录：`/Users/lxe-3/LXE_AGENT/.worktrees/pool-1`。
- 分支：`codex/fba-delivery-window`。本轮归档前工作区干净，最新代码提交为 `1cf4fd1a fix: keep logistics editor stable when switching providers`。
- 第一阶段实现提交：`1bc94ccb`；名称映射及测试收集修正：`03ddb97e`；交付方式纠正：`e94bbd75`。
- 保留当前目录和分支。用户要求先测试，后续获得明确指示再推送或更新 PR；不要切换到主工作区开发，不自行合并 main，不释放 pool-1。
- 之前误推进本地 main 的操作已经撤回，main 恢复到 `dfaee548`；该事件已在第 17 节记录。本次归档没有修改 main 或远端。

第一阶段的代码和自动化验证已具备，但用户尚未反馈手动测试结果，不能写成“用户验收通过”。
保存 profile 只说明业务配置已保存，不代表物流页面、账户登录态或查询能力已现场验证。

### 最新界面修复

用户反馈：滚到下方编辑区域切换供应商时，输入框数量变化导致页面上下跳动。

原因是切到字段较少的供应商后，编辑区缩短，浏览器收缩可滚动范围并调整滚动位置。
修复在切换前保留当前编辑区已展开的高度，并让字段从顶部排列，避免滚动位置和供应商下拉框跟着变化。
字段仍按五家供应商的要求显示，没有添加不适用的输入框；取消编辑、卸载编辑区后释放留白。
因此切到九方时编辑区底部可能保留空白，这是当前稳定滚动的预期表现。

对应文件：

- `apps/dashboard/src/desktop/logistics-settings-panel.tsx`
- `apps/dashboard/src/desktop/logistics-settings.css`
- `apps/dashboard/test/behavior/logistics-settings.cjs`

### 已有验证证据

- 新增滚动回归先在旧代码复现失败：`1200px jiufang: scroll position moved`。
- 修复后本地 Chromium 的物流配置 9 组场景通过，新增场景覆盖 1200px、680px 窗口，滚到编辑区底部后遍历五家供应商，核对滚动位置、下拉框位置、编辑区高度和焦点稳定。
- Dashboard 物流组件测试 9 项通过，Dashboard 类型检查及 `git diff --check` 通过。
- 第 16 节的完整验证属于防跳动修复之前的历史结果；此次局部界面修复仅运行相关定向验证，没有宣称重新跑过全量，也没有以生产物流网站或紫鸟客户端作为自动测试目标。

从当前仓库根运行相关命令：

```sh
bun test --test-name-pattern logistics-settings apps/dashboard/test/behavior/renderer.test.ts
bun test apps/dashboard/test/desktop/logistics-settings.test.tsx
bun run --cwd apps/dashboard typecheck
```

配置存储及 IPC 的定向入口：

```sh
uv run --frozen pytest -q python/lxeskill_cli/tests/logistics/test_logistics_settings.py
bun test apps/desktop/test/logistics-settings.test.ts apps/desktop/test/preload-bridge.test.ts apps/desktop/test/ipc-validation.test.ts packages/foundation/desktop-protocol/test
bun run --cwd apps/desktop typecheck
```

没有代码、基线或新问题变化时，不为归档重复运行这些测试。

### 用户手动验收方法（结果待反馈）

在上述 pool-1 目录启动 `bun run desktop:dev`，进入“设置 → 业务集成 → 物流商配置”。
若旧开发进程还在运行，先停止旧进程再从当前目录启动，以加载新的 Desktop main/preload。

1. **供应商切换**：添加配置，选择天泰并绑定店铺，滚到编辑区底部；依次切换九方、飞沃、天泰、云驼、威飒。供应商下拉框和页面滚动位置应保持稳定，窄窗口下重复检查。
2. **字段要求**：威飒、天泰要求公司账户；飞沃、云驼不显示公司账户；九方不显示店铺字段。浏览器型配置必须由用户明确选店铺，不能自动取第一家。
3. **多账户与持久化**：保存两条名称不同、公司账户不同的天泰配置，关闭并重新打开设置，确认两条都存在且互不覆盖；必要时重新启动开发应用复查。保存不能关闭整个设置弹窗或重启后台。
4. **编辑与保护**：修改配置后切换分区或关闭弹窗，应提示草稿处理；停用保留配置，删除必须确认；重复名称或不完整字段不能覆盖已有有效配置。
5. **实时店铺状态**：刷新后与紫鸟客户端当前目录比较，区分运行、未运行、未发现及名称冲突。紫鸟状态读取失败时，已有配置仍应可见并显示实际错误；不把保存成功当作已登录或页面正确。

若用户反馈失败，先记录供应商、具体操作、窗口宽度和实际界面/错误，再按问题修复；不沿用历史店铺状态推断本次运行情况。

### 下一阶段边界及恢复提示

先收集用户对第一阶段和防跳动修复的手动反馈。用户未授权前，不自动开始第二阶段或处理 PR。
若明确进入第二阶段，再按第 10 节设计 `lxeskill logistics query --profile-id ...`：固定路由、完整 profile ID、禁用配置拒绝使用、实时核对店铺 ID/名称/运行状态、传递必要公司账户，并保留现有适配器结果及真实错误。
九方公开 HTTP 路径不读取或启动店铺；统一命令的 session contract 与技能权限必须在修改 catalog 前单独明确。
涉及 catalog 时执行 Python/Bun 双端契约测试；涉及紫鸟页面时继续使用官方配对 Selenium 和严格附着。
批量导入、自动登录、任意请求配置、生产网站操作或 Amazon 改期均不从“配置模块测试”自动获得授权。

下一轮可直接使用：

> 阅读 `docs/record/20261019-logistics-provider-settings-build.md` 第 18 节和项目 `AGENTS.md`，在当前 `/Users/lxe-3/LXE_AGENT/.worktrees/pool-1` 的 `codex/fba-delivery-window` 分支继续。先检查已有改动并接收用户手动验收结果；物流配置第一阶段和供应商切换防跳动修复已实现，暂不重复构建。依据用户反馈修复并运行相关定向测试。没有明确指示不要推送、更新 PR、合并 main、释放 worktree，或开始统一查询入口和生产页面操作。

## 19. 物流商职责纠正（2026-10-20）

用户明确当前重点是纠正日期依据：威飒等物流商负责按 FBA 取得尾程承运人和转单号；UPS/FedEx 等实际运输公司的官方追踪提供送达状态及日期，再与 Amazon 的计划时段比较。不要把货代下单、到港、清关日期或转述轨迹直接用于 Amazon 改期，也不要为了获得日期而先扩展货代自动登录。配置模块本身仍用于选择正确的物流商账户和店铺。

代码检查未发现从货代日期自动推导 Amazon `target_date` 的实现；现有查询模块也没有已验证的尾程 ETA 输出。实际缺口是技能流程未明确衔接尾程，旧交接“无 ETA 则不建议”的门槛漏掉了已超期但尚未送达的场景。本轮已修正模型可见技能与交接说明，详细规则见 [尾程证据与改期建议](../../skills/fba-shipment-delivery-window/references/carrier-evidence.md) 和 [物流交接第 26 节](20261012-fba-logistics-delivery-window-handoff.md#26-日期来源与流程纠正2026-10-20)。

货代 ETA 缺失不阻断已有明确单号的尾程查询；尾程暂无日期但明确未送达且 Amazon 计划已过时，仍提出标注来源的业务顺延建议。建议与可执行分开：Amazon 接收状态、编辑截止、日历和既有写入批准要求继续有效。无预计日期的顺延不能写成 UPS 预计日期。

此前将用户“先测试物流商”误记为威飒单票查询，现已更正为配置模块，先处理独立登录账号、密码及页面公司名称的区别，详见第 20 节。“货代缺少预计日期仍继续查尾程”“超期未送达的业务顺延”及完整改期链路继续待测试，具体清单见物流交接第 26 节末。

职责纠正时尚未实现统一查询入口、物流商账号密码/自动登录、独立尾程适配器或自动建议计算器；其中账号密码配置现已由第 20 节补齐，其他能力仍待接入。不把技能修正当作完整自动流程验收。第 18 节的配置手动验收待办和 pool-1/分支、PR 交付限制继续保留。

## 20. 配置模块登录字段修正（2026-10-20）

本节记录首次补齐凭据的实现；其中保留公司名称输入的界面方案已由第 21 节替代，密码存储设计继续有效。

用户明确当前任务是修改并测试“设置 → 业务集成 → 物流商配置”，不是物流单票查询。原问题是各物流商使用不同登录账号和密码，而旧界面只有用于页面核对的公司账户名。本次已补齐：

- 威飒、飞沃、云驼、天泰可分别填写登录账号和密码；九方当前公开接口不要求登录，仍不显示这两个字段。
- 原 `account_name` 保留用于现有查询的页面身份核对，界面改称“页面公司名称”，说明其与登录账号独立。仅威飒、天泰按既有适配器要求显示，不改查询请求逻辑。
- 密码为只写字段；重开编辑区不回显。留空保留原密码，输入替换，点击“清除已保存密码”后保存则清除。修改登录账号或供应商时不得默默沿用旧密码。
- 兼容未配置凭据的旧 profile；不会把公司名称迁移成登录账号。配置卡片分别显示登录账号和密码是否已保存，不宣称登录成功；自动登录仍待接入和现场验证。

### 存储与一致性

公开业务文件仍是 `skill-data/logistics-query/profiles.json`。schema 升至 2，新增可空的 `login_username` 和内部 `credential_id`，不保存密码。读取 v1 严格校验后在内存补空值，不改原文件或 revision；下一次成功修改才原子写为 v2。损坏或未知字段不被静默修复。

密码由 Electron `safeStorage` 加密，保存到独立的 `config/logistics-credentials/<UUID>.bin`，不进入 Python、子进程参数、环境、业务 JSON、`settings.json`、原 `secrets.bin`、SQLite 或 renderer 返回对象。Desktop 接受用户输入密码，但返回仅含 `password_configured`，不返回密码或内部引用。Python 管理公开配置的锁和 revision，不读取/解密凭据。

新密码先写入独立不可变加密条目并 fsync，再由配置 revision 发布引用。保存冲突不覆盖旧引用；子进程返回丢失或超时时保留新条目，避免实际上已提交的配置指向被删密码。因此不确定失败可能留下无引用的加密条目，不自动重试或据错误断言保存一定没发生。成功替换、清除或删除配置后清理旧引用对应条目。加密服务不可用时明确报实际错误，不回退明文；不涉及密码的旧配置仍可编辑。

### 验证与手动验收

开发验证使用本地 IPC fixture、临时数据目录和测试加密端口；未执行真实物流登录。当前目录和分支不变，不推送、更新 PR、合并 main 或释放 pool-1。

- Python 配置与迁移：72 项通过；FBA 技能文档契约：5 项通过。
- Desktop、Dashboard、preload、IPC 验证与协议定向测试：84 项通过。包含实际私有 Python 进程与临时文件存储的集成检查，以及响应丢失后不删除已提交密码的故障场景。
- 本地 Chromium：10 组物流配置场景通过，包括双账户、密码保留/替换/清除、草稿保护、供应商切换滚动稳定性及中英文窄屏布局。中英文编辑区截图已查看。
- Desktop 与 Dashboard 类型检查、物流技能格式校验及 `git diff --check` 通过。未修改 catalog，未运行或宣称重新通过全量测试。

从当前 pool-1 重启 `bun run desktop:dev`，确保加载新增 main/preload 与协议类型后，进入物流商配置：

1. 创建两条天泰配置，分别填写配置名、页面公司名、不同登录账号和密码，并绑定店铺；保存后重开设置，确认两条互不覆盖。
2. 编辑已保存配置：密码框应为空并提示留空保留；不输入密码保存后仍显示已保存。分别测试替换和清除密码。
3. 修改登录账号后，不填写新密码或清除旧密码时应阻止保存；切换供应商不会将旧账号密码带给新供应商，滚动位置仍保持稳定。
4. 飞沃、云驼显示独立登录字段，不要求公司名称；九方不显示登录或店铺字段。原无凭据的 profile 仍能打开并编辑。

尾程查询与顺延判断仍保留待测试标记，本次配置验收不自动开始物流查询或 Amazon 修改。

## 21. 移除多余的公司名称输入（2026-10-20）

用户指出“页面公司名称”是多余的手工输入，登录使用物流商实际账号和密码。本次已移除该输入、说明和卡片展示，并取消 UI、Electron main 和 Python 设置服务的必填要求。威飒、天泰可以直接配置登录账号及密码，不再因为缺少公司名称而无法保存；配置名称和店铺绑定仍按原规则维护。

`account_name` 仅作旧数据兼容，保留已有值，不参与登录或作为新配置的要求；新增配置可省略该字段，存储规范化为 `null`，schema 仍为 2。现有查询适配器的公司身份核验不移除：它们需要的值从本次实际页面取得，不把旧配置或登录账号当作页面公司身份。

验证结果：Python 配置测试 73 项、Desktop/Dashboard/协议定向测试 86 项、本地 Chromium 10 组配置交互全部通过；包含不填写公司名称保存威飒/天泰的实际设置进程集成测试。两端类型检查、`git diff --check` 通过，中英文窄屏编辑截图已查看。未运行全量测试，未登录生产物流网站。

手动验收：在当前 pool-1 重启开发应用，进入物流商配置；选择威飒或天泰后，应只出现配置名称、供应商、登录账号、登录密码、店铺和启用项，不出现“页面公司名称”，填好后可直接保存。密码的保留、替换和清除规则继续按第 20 节。保持当前分支，不推送、合并或释放 worktree。

## 22. 下一轮交接：准备配置模块手动测试（2026-10-20）

### 当前落点

- 目录：`/Users/lxe-3/LXE_AGENT/.worktrees/pool-1`；分支：`codex/fba-delivery-window`。归档前工作区干净。
- 最新代码提交：`2382ed6b fix: remove company name from logistics configuration inputs`；账号密码配置提交：`f1ae508f`。
- 当前任务是测试“设置 → 业务集成 → 物流商配置”，不要误解成按 FBA 查询物流。配置模块的用户手动验收尚未通过或反馈。
- 保留当前目录、分支和 pool-1；未经新指示不推送、不更新 PR、不合并 main、不释放 worktree。PR #91 的在线状态未重新核实。

### 已有验证与边界

最终代码已取得 Python 配置测试 73 项、Desktop/Dashboard/协议定向测试 86 项、FBA 技能文档测试 5 项通过；本地 Chromium 10 组配置场景、两端类型检查、技能格式及 `git diff --check` 通过，中英文窄屏编辑截图已查看。本次仅归档，没有代码或基线变化，不重复运行这些测试或全量测试。

存储集成测试使用隔离临时目录及测试加密端口，界面测试替换了 IPC；这些结果不代替真实 Desktop 环境下的手动验收，也不证明物流账户已登录。现在能配置账号密码，但自动登录、统一物流查询入口、独立尾程适配器和自动建议计算器尚未接入。尾程无 ETA 继续查询、超期业务顺延和完整改期链路继续保留第 26 节物流交接的待测试标记，不在本次配置测试中展开。

### 启动与测试顺序

若旧开发进程仍在运行，先停止旧进程，再从当前目录启动，确保 main/preload 与界面均为最新代码：

```sh
cd /Users/lxe-3/LXE_AGENT/.worktrees/pool-1
bun run desktop:dev
```

进入“设置 → 业务集成 → 物流商配置”，逐项测试：

1. **字段与供应商切换**：威飒、飞沃、云驼、天泰显示登录账号、密码和店铺；所有供应商均不显示“页面公司名称”。九方不要求登录凭据或店铺。新建时必须主动选店铺，不能默认取第一家；切换供应商及窄窗口滚动仍应稳定。
2. **多账户与持久化**：保存两条名称不同、登录账号/密码不同的同一物流商配置；关闭重开设置，必要时重启开发应用，确认各自存在且互不覆盖。保存不关闭整个设置弹窗，不重启后台。
3. **密码操作**：重开编辑时密码框为空且提示留空保留；不填写保存仍显示已保存。分别验证替换、清除，只影响选定配置。已有密码时修改登录账号，必须设置新密码或明确清除旧密码；切换供应商不能带入旧账号密码。保存成功只表示凭据已保存，不作登录成功判断。
4. **编辑保护和 CRUD**：未保存草稿在切换分区、关闭或取消时应提示；停用保留配置，删除需确认；重复配置名、缺少必需店铺和并发 revision 冲突不能覆盖已有配置。
5. **旧配置与店铺状态**：旧无凭据配置仍可编辑，不把历史公司名当登录账号；刷新店铺区分运行、未运行、未发现和名称冲突。紫鸟状态读取失败时配置仍显示，并保留实际诊断。刷新只读，不启动或重启店铺。

反馈失败时记录供应商、操作步骤、窗口宽度及界面实际错误，不在聊天或诊断记录中发送密码。修复后只跑受影响的定向验证；没有新问题不重复构建或重复查询历史货件。

下一轮恢复提示：

> 阅读本文件第 22 节及项目 `AGENTS.md`，在当前 pool-1 的 `codex/fba-delivery-window` 分支继续。先检查已有改动，按用户反馈验收物流商配置模块。登录账号和加密密码已实现，多余公司名称输入已移除；从当前目录启动或重启开发应用后测试字段、多账户持久化、密码保留/替换/清除和草稿保护。不要把配置测试改成 FBA 单票查询，不自动开始物流登录、UPS 查询、顺延建议或 Amazon 修改，也不推送、更新 PR、合并 main 或释放 worktree。

## 23. 纠正账号与店铺关系：取消固定绑定（2026-10-20）

用户已确认威飒配置关闭重开后能够保留；这仅作为该项持久化验收，不扩展为密码替换、清除或登录验收。随后用户指出，物流账号应跨店铺复用，店铺状态应取自实际执行环境，并明确授权修正。遵循“如无必要，勿增实体”，不再维护账号与店铺的固定对应关系。

### 当前设计与兼容

- 配置只维护实际物流账号：配置名称、供应商、登录账号、加密密码及启用项。一个威飒账号供多个店铺使用，也只需配置一条；确有多个物流账号时才分别配置。
- 页面不再提供店铺选择、绑定名称确认和店铺状态卡片。“刷新配置”只重新读取账号配置；删除独立的店铺发现逻辑、`stores/stores_error` 返回字段和 `refreshLogisticsStores` IPC。
- 店铺仍由执行任务明确，现有查询适配器继续复用 `StoreSessionService` 与 `store_driver_session`，实时核对运行情况并通过官方配对 Selenium 严格附着目标页面。没有新增“当前店铺”全局状态、会话表或缓存；多个店铺同时运行时不能默认取第一家，目标不明确先确认。
- 店铺运行与物流网站登录分别判断；配置卡片只显示启用和密码保存状态，不宣称已登录或可查询。统一查询入口和自动登录仍未接入，本轮不扩展这些能力。
- 公开配置 schema 升至 3，不再接受或保存 `store_binding`。v1/v2 旧文件先严格校验完整旧字段，再在内存移除绑定，保留 profile ID、账号、时间、revision 及原密码引用；读取不改文件，下一次成功修改才在原锁和 revision 保护下原子写入 v3。损坏旧绑定及未知字段仍报错，不能借迁移悄悄修复。
- 密码继续使用第 20 节的 Electron `safeStorage` 与独立加密文件，无需重新输入或重新加密；旧公司名仍仅作历史数据兼容。没有访问真实用户密码或改写实际业务配置。

### 验证与下一步测试

- Python 设置服务 87 项通过：包括全部供应商的 v1/v2 迁移、密码引用保留、损坏旧数据保护、并发冲突，以及真实私有 CLI 在禁止导入浏览器模块时完成读写删除。
- Desktop、Dashboard、preload、IPC 与协议定向用例共 87 项最终通过。首轮新增脱敏断言误以为截断后仍保留消息开头，调整 fixture 让敏感值位于实际保留片段后，复验 Desktop 18 项通过；其余 69 项首轮通过。迁移集成测试使用真实私有 Python 入口和临时目录，确认两条旧绑定配置编辑后仍引用原密码，加密文件字节不变。
- 本地 Chromium 的 10 组物流配置场景通过，涵盖无需店铺保存、多账号、密码保留/替换/清除、草稿保护、revision 冲突、供应商切换防跳动及中英文窄屏布局。Desktop 与 Dashboard 类型检查通过。
- 本轮未修改 catalog、查询适配器请求逻辑或生产页面，未重复运行全量验证。`git diff --check` 通过。

保持当前 pool-1 和 `codex/fba-delivery-window`，不推送、更新 PR、合并 main 或释放 worktree。重启当前目录的 `bun run desktop:dev`，检查原威飒配置的账号和“密码已保存”仍在，页面已无绑定店铺及店铺状态；编辑时密码留空保存，再重开设置确认。新建浏览器型物流账号无需选择店铺即可保存。真实 Desktop 的本轮手动验收仍待反馈，尾程与顺延的待测试事项继续保留。

## 24. 配置验收完成，改期流程先核对 Amazon 货件（2026-10-20）

取消绑定的提交为 `c139ec65`。用户随后确认“完成，没有问题”，本轮配置手动验收通过，不重复要求配置同一威飒账号。

用户又明确物流查询与 Amazon 修改的店铺职责：物流账号不绑定店铺，但改期必须先在当前目标 Amazon 店铺精确找到完整 FBA。现已复用已有只读 discovery，将这一步放在物流/尾程之前，并补齐重复列表和工作流程身份冲突的停止校验。方案、154 项定向验证和真实测试入口见 [物流交接第 27 节](20261012-fba-logistics-delivery-window-handoff.md#27-改期先确认当前店铺存在目标-fba2026-10-20)。独立物流查询不要求 Amazon 前置检查；当前列表页未命中不代表货件不存在，需核对所属店铺及页面范围。

没有新增固定绑定、全局店铺状态或预检命令；自动登录、统一物流查询入口、尾程查询与完整改期链路仍按原边界待接入或验收。保留当前 pool-1 和分支，不推送、更新 PR、合并 main 或释放 worktree。

后续前置实页测试发现，指定完整 FBA 后仍出现整组改期选择，且枚举停在最后一票；已修正为按指定 FBA 精确回报并回到对应分页。查询和修改都适用完整 FBA 直接定位，不设“只读测试”特殊分支；后续按用户请求范围执行。最新问题、115 项定向验证及待复验入口见 [物流交接第 28 节](20261012-fba-logistics-delivery-window-handoff.md#28-指定-fba-直接匹配不再要求重复选择2026-10-20)。

用户现已回传目标定位正常；下一步威飒查询返回数字 `parcel_count=1` 导致旧字符串校验失败，已修复并通过 63 项威飒定向测试。实际反馈、来源明确的诊断行 fixture 和待复验边界见 [物流交接第 29 节](20261012-fba-logistics-delivery-window-handoff.md#29-威飒数字件数解析修正2026-10-20)，不重复配置或 Amazon 前置验收。

用户随后确认威飒可用，并授权先优化切页。现已在通用域名选择中去掉“扫描后先回原页、再切目标页”的往返及重复选择当前页，继续核对全部实时标签和域名唯一性；见 [物流交接第 30 节](20261012-fba-logistics-delivery-window-handoff.md#30-减少通用域名选页的冗余切换2026-10-20)。这项优化不新增账号店铺绑定、持久状态或登录能力。

后续用户确认切页优化可用，并回传 `2026-10-20T10:29Z` 的 UPS 官方结果：单号 `1ZH910550314112374` 为标签已创建、尚未收件、无预计或实际送达日期。Amazon 已查到的时段为 2026-11-08 至 2026-11-14，尚在未来，暂不改期；用户认可只读链路初步通过，详见 [物流交接第 31 节](20261012-fba-logistics-delivery-window-handoff.md#31-本票只读查询与暂不改期建议初步验收2026-10-20)。本次没有打开 Amazon 编辑弹窗或提交修改，需改期及完整执行链路仍待验收。

## 25. 接入统一查询与内部登录通道（2026-10-21）

用户回传同票 dry-run 模拟通过，没有真实写入，并明确先做自动登录和统一物流查询，不等待新的合格改期样本。具体实票结果、实现边界及分轮定向验证见 [物流交接第 32–33 节](20261012-fba-logistics-delivery-window-handoff.md#32-本票修改模拟通过无真实写入2026-10-21)。

新增 `lxeskill logistics profiles/login/query`。统一入口按启用配置 UUID 路由五家原查询适配器，账号跨店铺复用；九方不需要浏览器或登录服务。保留内部配置引用但不向模型公开，原配置字段、加密文件格式和独立查询命令不变；设置页中英文提示调整为以真实页面验证登录。

原第 20 节“密码不进入 Python”描述的是配置保存链路。本轮新增经认证的 Desktop 内部登录服务，解密密码仅经固定私有 Python 子进程 stdin 交给官方配对 Selenium；不返回给 CLI，不进入 argv、环境、公共配置或数据库。使用 profile revision 核对、同源及唯一实时表单检查、失败不重试和取消清理。无需重建已验收配置，但须重启加载本分支的 Desktop 才会注入新通道。

威飒/天泰登录执行器在本节形成时仅通过合成 DOM/driver 与内部通道测试，实际登录页结构和登录结果待 LXE_Agent 验证；公司仍取本次真实快照，不增加固定公司输入或店铺绑定。已登录页面复用不能证明配置凭据已通过验证。云驼自动登录最新进展见第 29–30 节；飞沃可直接查询，不要求先登录，2026-10-22 用户更正见第 31 节。

## 26. 威飒配置登录与统一查询实页通过（2026-10-21）

用户在 LXE_Agent 回传真实凭据提交成功（`status=authenticated`、`login_attempted/configured_login_submitted=true`），随后快照核对公司“深圳市新棱镜贸易有限公司”，再用同一配置通过统一入口 `--login-mode reuse` 查询 `FBA19SS5YN6R`。`2026-10-21T03:40:51Z` 的结果精确命中 `WS10027586 / SMF3 / UPS / 1ZH910550314112374`，HTTP/业务成功，分页完整、仓库一致、无缺项或警告。

此证据补足第 25 节实现时的威飒待验收项；天泰、其他物流商和 query 默认 auto 模式自身完成新登录仍分别待验收。用户已确认公司对应，不将 `profile_identity_verified=false` 改写为执行器已权威匹配登录用户名。详细范围及随后 UPS 只读证据见 [物流交接第 34 节](20261012-fba-logistics-delivery-window-handoff.md#34-威飒真实登录统一查询与-ups-续验通过2026-10-21)。已有配置无需重建，本票无需重复登录或查询；没有 Amazon 写入。

## 27. 新增与编辑改为独立弹窗（2026-10-21）

用户截图指出“添加物流商”直接展开在配置列表下方，要求改为弹窗。新增和编辑共用表单现均通过 portal 显示在设置之上，背景保留配置列表；弹窗有独立标题、关闭按钮、可滚动字段区和固定底部操作，保存成功只关闭编辑弹窗。原有配置字段、密码保留/替换/清除、revision 校验及 IPC 不变。

Esc、取消或遮罩关闭有未保存草稿时先提示确认；确认弹窗也移到独立浮层，键盘只作用于最上层，关闭后恢复焦点。保存期间阻止重复提交和关闭，失败时错误与草稿留在编辑弹窗内。表单不嵌套 `<form>`，避免 Enter 触发外层设置保存。

定向验证：组件测试 12 项通过，Dashboard 类型检查通过；本地 Electron 的物流设置 10 组场景通过，覆盖新增/编辑、保存及失败、草稿、键盘/遮罩、焦点、短窗口滚动及中英文布局。已查看本地模拟配置截图，不作为真实 Desktop 或生产账号操作证据。未改 catalog 或 Python/登录查询实现，未运行全量验证；保留分支和 worktree，不推送、合并或释放。

## 28. 本轮归档及下一轮测试入口（2026-10-21）

用户已接受弹窗修复并要求归档，当前实现基线 `cec514c6`。本轮仅整理文档，不重跑未变化代码的测试；既有 `apps/dashboard/test/behavior/logistics-settings.cjs` 文件末尾缺换行差异继续保留，不纳入归档提交。

下一轮先在加载该分支的真实 Desktop 中确认添加和编辑弹窗、取消及草稿提示，再测试用户明确指定的天泰配置登录和统一查询。天泰两个账户分别核对，不从历史账户名或列表顺序推断；公司全名来自本次快照，浏览器环境由本次任务明确，账号仍跨店铺复用。原威飒登录、统一查询和 UPS 阶段无需重做。

具体命令、历史天泰样本的复用条件、待办及可复制提示词见 [物流交接第 35 节](20261012-fba-logistics-delivery-window-handoff.md#35-本轮归档及下一轮测试清单2026-10-21)。后续保持 pool-1 与当前分支，不推送、更新 PR、合并 main 或释放 worktree；实际改期另需明确方案批准。

## 29. 云驼配置登录接入（2026-10-21）

用户已完成云驼配置，但真实 `logistics login` 先被 Desktop 的威飒/天泰白名单提前拒绝。放开固定供应商后，首次表单探测又在提交前安全停止：页面存在唯一密码框，但没有原生 `<form>`。用户随后提供真实登录区源码，确认 Element UI 的 div 布局使用 `placeholder=LOGIN_ACCOUNT`、`placeholder=PASSWORD` 和文本为 `LOGIN_LOGIN` 的 `type=button`。现已允许云驼配置进入原有私有凭据通道，并按这些源码特征识别唯一同组控件；不使用临时 `data-aid`。第二次实页结果确认登录后落到 `/home`，可见快速下单、批量下单、财务结算及 SYSTEM SETTING；此前只认查询页而误报失败。现按这些真实工作台标记确认登录，再在同一标签页导航到固定 `/customer/trackquery/` 并验证查询就绪。密码传递、revision 核对、取消、脱敏和失败不重试规则不变。

后续字符码位探针确认页面的 `SYSTEM SETTING` 中间是 U+00A0，旧常量使用普通空格，导致其余三个标记虽命中仍无法识别 `/home`。现仅归一化该已观察字符再执行原四标记门禁，并保留缺标记拒绝用例；不放宽路径或认证条件。

本地验证及当时的复测命令见 [物流交接第 36 节](20261012-fba-logistics-delivery-window-handoff.md#36-云驼自动登录补齐待实页验收2026-10-21)。第 29 节形成时真实凭据提交仍待验收；后续已经提交成功并进入 `/home`，最新结论由第 30 节替代。不把此前的 Desktop 白名单或门禁误判算作密码错误。飞沃可直接查询，不以自动登录为前置条件。

## 30. 云驼自动登录归档及复测入口（2026-10-21）

云驼真实凭据已经提交成功并进入 `/home`；随后发现工作台 `SYSTEM SETTING` 中间为 U+00A0，导致普通空格门禁误判。最终基线 `be6243c8` 只归一化该已观察字符，继续要求完整路径、无密码框及四个工作台标记；识别后在同一标签页进入固定查询页。登录页源码、三轮真实诊断、本地 93 项定向验证、日志权限独立问题及下一轮命令统一见 [物流交接第 37 节](20261012-fba-logistics-delivery-window-handoff.md#37-云驼自动登录归档及下一轮复测2026-10-21)。

下一轮不退出当前已登录账号：先验证 `/home` → `/customer/trackquery/`，再用当前账号明确对应的完整 FBA 做统一 query + reuse。当前工作台没有可见公司全名，不将 `company_names=[]` 写成账号错误或机器已核验身份。保持 pool-1 与当前分支，不推送、更新 PR、合并或释放；不执行尾程或 Amazon 写入。

## 31. 飞沃可直接查询（2026-10-22）

用户确认飞沃可直接查询，不要求先登录，不再列自动登录待办。既有配置界面可填写凭据不代表飞沃查询必须填写或验证凭据；本次只更正说明，不调整配置界面或查询执行器。现有命令仍使用 LXE_Agent 会话及官方配对 Selenium，详见 [物流交接第 38 节](20261012-fba-logistics-delivery-window-handoff.md#38-飞沃直接查询口径更正2026-10-22)。
