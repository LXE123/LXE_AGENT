# 物流商配置模块构建说明

- 日期：2026-10-19。
- 目标：在 LXE Agent Desktop 的“设置 → 业务集成”中增加“物流商配置”，集中维护物流商、公司账户和紫鸟店铺的对应关系，为后续统一单票查询和批量查询提供明确配置。
- 本文范围：定义下一轮开发的结构、边界、分阶段任务、测试和验收条件。本轮不实现代码，不访问物流商生产页面，不修改现有物流订单、Amazon 或原始表格。
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

## 14. 下一轮启动提示

可直接使用以下提示启动构建：

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

已核实当前分支对应的 PR 是 [LXE123/LXE_AGENT #91](https://github.com/LXE123/LXE_AGENT/pull/91)，状态为 open。
继续更新现有 PR；保持当前工作目录和分支，不强推、不自行合并。
移回后对比确认 apps、packages、python、config 的文件内容与完成验证时完全一致；
差异仅为当前分支尚未纳入的其他技能说明文档及交付记录，不重复执行相同实现的全量测试。
当前目录启动开发应用即可使用该功能，Desktop main/preload 的变更需要重启开发进程。
