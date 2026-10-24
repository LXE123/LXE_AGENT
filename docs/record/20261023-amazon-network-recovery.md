# Amazon 真实运行异常诊断与最小修复（2026-10-23）

## 结果与工作区

本轮完成日志取证；首阶段修复店铺解析403与官方查询429停止边界，后续按用户授权补齐MSKU、深圳库存和货件三条403路径。历史连接故障的 DNS/TCP/TLS 细分根因仍为 **UNKNOWN**，没有宣称网络已修复。

- 修复分支：`codex/amazon-network-recovery`；工作区：`.worktrees/pool-10`；基线：main `abde37ddd63ca406921ad73c90dd1afa1139c363`。通过项目 `scripts/wt-claim` 领取，独立 frozen Bun/uv 环境，没有复制 `.venv`。
- 诊断时PR4为`b892ea8f`；本轮收口时PR4已独立推进至`6d0e72ea`，本修复不应用到PR4或运行中的Desktop。
- 诊断阶段只授权隔离修复／测试；2026-10-24追加授权本分支Commit、Push及独立PR。全过程不发起生产ERP查询、登录、认证刷新或真实附件发送。
- 新建 checkout 缺少 fd，按 `bun run desktop:tools:fd` 准备固定版本 10.5.0。无依赖声明或锁文件修改。

## 原始证据与五次失败

证据来自 PR4 `var/db/session_transcripts/` 六个会话（前缀 `174706cc`、`cd567088`、`d95d9d76`、`c840bb26`、`e85c8e5a`、`458a20c7`），以及 `var/logs/runtime/20261023/` 的 Python、Runtime、Desktop 日志和 browser_auth_service 日志。未改写原始记录。下表行号为原 PR4 transcript 行号；北京时间，统计窗口截至18:55。

| 时间 | 失败位置及调用链 | 证据及随后结果 |
|---|---|---|
| 18:01:59 | 深圳CLI → `_export_store_msku_actual_inventory_once` → `search_warehouse_stock` → ERP session POST，目标 `private-amz.mabangerp.com` | `d95d9d76…:35`，`Cannot connect to host …:443 ssl:default [None]`，`auth_refresh_required=false`。18:07明确有再次查询；Python日志386、389行搜索/导出分别HTTP200、success=true及276294字节。此后turn取消，最终CLI结果未确认，不能把“没有成功终态”写成“没有成功联网”。 |
| 18:08:20 | 解析CLI → `resolve_fba_store` → `fetch_fba_stores` → `_fetch_fba_stores_once` → ERP session GET，目标 `private-amz.mabangerp.com` | `c840bb26…:11`；18:08:24再次调用成功。中间一次exec等待参数60000ms被工具校验拒绝，属于另一类错误。 |
| 18:12:18 | 货件CLI → `_download_status_file` → `download_raw_file_from_url` → EXTERNAL session GET，目标 `fba-1253885479.cos.ap-guangzhou.myqcloud.com` | `458a20c7…:53`，阶段明确为WMS待装箱“下载文件”；已有下载地址。18:12:43重跑完整货件CLI，18:14:11成功。日志463、495行同一状态任务由411855变为411856，确有重新创建导出任务，并非仅重下原URL。 |
| 18:26:05 | MSKU CLI → `download_store_msku_excel` → `run_export_pipeline` → `export_store_msku_file_url` → ERP session POST，目标 `private.mabangerp.com` | `e85c8e5a…:33`，Python日志606行阶段`submit_export_request`、`ClientConnectorError`、耗时5010ms；同会话未见该店铺导出成功。没有证据证明远端导出任务已创建。 |
| 18:31:45 | 货件CLI → `resolve_shop_option` → `fetch_shop_options` → ERP session GET，目标 `api-private.mabangerp.com` | `458a20c7…:109`；尚未进入三状态导出。18:31:59重跑，18:33:18 CLI成功。 |

五次都没有捕获失败请求的HTTP响应状态。DNS结果、所选IP、TCP errno、TLS握手细节、当时系统路由及VPN状态均未留存，因此细分归因一律UNKNOWN。不能据域名、随后成功或`ssl:default`判定马帮故障、证书错误或VPN故障。

离线构造 aiohttp `ClientConnectorError(..., ConnectionResetError())` 能得到同样的`ssl:default [None]`文字，未执行网络请求。这只证明该文字不唯一指向证书错误，不是对历史失败原因的复现。

## 网络、Session、超时与重试归属

| 路径 | 已确认配置与生命周期 |
|---|---|
| 马帮ERP请求 | 复用`shared.infra.net.erp_http_session`，连接池64、单域名32、total timeout60秒、DNS缓存300秒、keepalive30秒、DummyCookieJar、trust_env=false。 |
| COS/外部文件 | 复用EXTERNAL session，连接池16、单域名8、total timeout30秒、DNS缓存300秒、keepalive20秒。仅读完整成功body后写文件；本次COS失败无已下载字节数，不能称为已确认的传输中断。 |
| 官方SKU查询 | PR4复用既有`AsyncCloudClient`及本轮catalog scope，超时60秒、DummyCookieJar、trust_env=false、async context退出关闭。与浏览器认证的ERP请求职责不同。组合并发默认4，未调高。 |
| 云端权限查询 | Desktop → managed Python `lxeskill cloud-context` → `CloudClient` → `/api/v1/device-context`。urllib显式`ProxyHandler({})`，HTTP超时10秒，Desktop子进程deadline15秒。 |
| 公司模型访问 | `DirectNativeCloudClient`使用独立Node agent、10秒deadline，成功或失败均销毁agent；不继承系统代理。 |

网络策略是项目明确的直连策略，并非各Service遗漏代理参数。aiohttp/requests的trust_env=false，native urllib/Node也显式直连；auth bootstrap清除代理环境并设NO_PROXY=*。历史Python日志428行有实际direct快照。不能把当前shell或scutil快照当成当时网络状态；也没有擅自启用代理、关闭TLS校验或改NO_PROXY。

五个连接失败点没有内建的通用连接重试。店铺解析/导出/深圳/货件各自仅在相应认证异常时有限恢复一次；普通连接异常向上传播。货件任务轮询180秒/10秒间隔与EXTERNAL下载30秒超时不同，不是整个流程180秒的总时限。没有发现这些路径的无限循环重试。完整命令的人工/模型重跑会重复前置工作和导出任务，本次COS案例已经证明；此次不增加重试或新建任务恢复框架。

CLI终态`business_cli_failed`是现有统一失败封装，不证明ERP业务拒绝；本次原连接文字保留，`auth_refresh_required=false`的失败也保留。部分adapter只保存str(exc)，没有完整连接原因链，这是历史取证限制；未凭通用错误码改写实际原因。

网络session由既有Registry复用，business dispatcher的finally执行`close_all_network_clients()`；官方client也在context退出时关闭。本次本机HTTP回归验证生命周期、cookie隔离和取消；没有历史连接池队列或泄漏证据，不能将延迟归为连接池耗尽。

## 确定问题与本轮最小修复

1. **P2，已局部修复：店铺解析403被当作登录过期。** `store_resolver.AUTH_FAIL_STATUS`从`{401,403}`改为`{401}`，403走已有`MabangRequestError`并保留状态和服务端正文，不刷新、不重发。401仍只恢复一次；恢复后再次401/403/429直接停止。调用完整`fetch_fba_stores()`的测试验证实际请求/刷新次数，不只测试常量。
2. **P2，已局部修复：官方查询公共实现429继续重试。** `official_api.post_json`仅对既有502/503/504和原允许的连接异常保留最多3次尝试；429首次响应立即失败，Retry-After不授权重试。删除仅服务该429分支、已无生产消费者的`retry_delay`函数和6个旧helper用例。未提高次数、扩大可重试异常或新增HTTP client。

首阶段新增11个参数化实例：店铺403/429、401恢复及再次拒绝、连接异常保留、HTTP200挑战页停止；官方429两种payload；真实回环HTTP429一请求零等待。两条原恢复测试改用502/503，保留原有限恢复和1.5MB响应读取覆盖。

### 后续授权：MSKU、深圳库存及货件403边界

用户明确要求继续在同一独立修复分支处理以下三条历史路径。本次只改三个生产文件的四行分类，不改现有恢复次数、网络Session、CLI契约或库存算法。

| 模块 / 位置 | 实际调用方及最小修复 |
|---|---|
| `store_msku.py:57` | `download_store_msku_excel` → `run_export_pipeline` → MSKU ID查询 / 导出提交。`AUTH_FAIL_STATUS`仅保留401；403走已有`MabangRequestError`，不进入认证恢复。 |
| `store_msku_actual_inventory.py:54` | `export_store_msku_actual_inventory` → 仓库搜索 / 库存导出。相同常量仅保留401，覆盖JSON读取和二进制导出的既有HTTP状态检查；原普通/组合库存计算不变。 |
| `batch_delivery.py:32,171` | 三类`unlinked_shipments`和单发货单CSV（也被MSKU明细调用）共用`_read_api_json`。HTTP认证分类仅保留401；HTTP200下的JSON `code=403`（数字或文本）走原业务异常，JSON401仍触发一次认证恢复。 |

四个现有测试文件新增52个参数化实例，注入实际响应并执行既有公开Service及恢复包装：MSKU ID/导出8个、深圳搜索/导出8个、货件店铺/中途状态24个、共享单发货单CSV12个。覆盖首次403、401后成功、401后再次401、401后403；验证请求与刷新次数、原错误状态/正文、拒绝后不启动下游任务或发布文件。旧测试中用于模拟合法恢复的合成AuthError403改为401，新增用例直接证明真实403不会被误分类。

此前首阶段的两个生产修复和三个测试文件在本轮保持逐字节一致，先前七条修改已备份后再编辑。18:10那次货件鉴权恢复没有记录触发响应码，仍不能断言实际就是403；本次只证明这些代码路径的后续行为，不宣称全项目所有403、JSON错误格式或历史网络原因已覆盖。

## 其他异常

- **模型参数：** 两次exec传`yield-time-ms=60000`，两次输出预算分别20000、12000；公开schema与校验均明确250～30000ms、1～10000。一次还使用了不支持的`yield_time_ms`拼法。另有搜索相对路径`var/workspace/python/lxeskill_cli`不存在。没有发现adapter改变参数的证据；保留现有校验，不向Skill追加禁止条款。
- **临时验表脚本：** `KeyError`来自模型假设有“子SKU”列；`data_only`属于openpyxl调用却传给pandas；两次IndexError均从35列行元组取零基下标35。这些脚本位于transcript，不在生产模块或正式测试中，没有为其新增Excel框架。
- **云端检查：** 截至18:55，54条`cloud_skill_permission_failed`中49条是urllib超时，5条是RemoteDisconnected。`desktop-cloud`catch还调用native.failed，同一次失败会记录native和permission两个事件，不将两条日志算两次请求。另有2条独立native timeout。失败发生在云端接入传输，未捕获权限HTTP拒绝；具体网络段UNKNOWN。保留既有轮询、缓存和失败状态，不关闭检查。
- **SKU重试：** 18个成功阶段、6898个逻辑请求、7046次HTTP尝试、148次重试、最终请求失败0。重试不是148次整表重导；每个逻辑查询预算原为3次，query scope复用client，无浏览器认证恢复。没有逐次状态/错误分类，不能说148次都是网络故障或429。新增429停止只改变后续行为，不能反推历史148次的组成。
- **库存未知：** 日志四个店铺样本分别有123/823/25/333条未知，相关V2终态公式错误数0；按既定临时规则输出待核对文件并失败，重复相同输入不能消除缺失。不改V1/V2算法、公式或AG规则。

## 实际验证与环境

### 首阶段证据（保留；本轮未重复运行Bun）

- 新回归先红：**4 failed、6 passed、87 deselected**，确实命中403误分类和429重发；随后首组**95 passed**。
- 扩展初跑：Python **1 failed、137 passed**，旧集成测试仍期待429重试；改为503恢复并增加真实HTTP429拒绝。Bun **56 passed、2 failed**，原因为新worktree缺少固定fd；按项目脚本准备后重跑。
- 最终Python：从pool-10根运行`uv run --frozen --no-sync pytest`，16文件 **234 passed、0 failed、无skip、5条既有aiohttp enable_cleanup_closed弃用warning**。覆盖解析/CLI、MSKU/CLI、深圳/CLI、货件/CLI、官方查询/组合、SKU、认证边界、公共cloud客户端及真实localhost HTTP。
- 最终Bun：`TMPDIR=/private/tmp bun test packages/agent/runtime/test/tooling/coding-tools.test.ts apps/desktop/test/cloud-context.test.ts apps/desktop/test/native-cloud-access.test.ts`：**58 passed、0 failed、607 assertions**。工具schema、范围校验、云端错误及缓存保持有效。
- 以上测试不累计早期重叠组。未运行模型API、真实ERP、真实登录、外发、Windows、完整Desktop聊天；未将本机HTTP fixture当生产复测。

### 本轮后续修复实际执行

- 新增52例先红：**26 failed、26 passed、68 deselected**；失败均命中403误分类，401恢复用例在修改前已通过。只修改四行生产分类后，四个受改测试文件 **120 passed**。
- 最终合并回归：从pool-10根执行`uv run --frozen --no-sync pytest`，**21文件、345 passed、0 failed、无skip**。覆盖上述四文件、各CLI适配、店铺解析、官方查询、公共导出/认证、SKU、共享CSV及MSKU明细消费者、cloud/HTTP生命周期。29条warning均为aiohttp `enable_cleanup_closed`在当前Python版本已无效的弃用提示，不是请求或测试失败。
- 首次20文件扩展组为319 passed；随后补入已经单独通过的共享货件API测试，最终21文件345 passed。各组存在重叠，数量不相加。
- Bun复用首阶段 **58 passed / 607 assertions** 证据：Runtime、Desktop、工具schema及其测试源码本轮均未修改。本轮没有把复用结果写成再次执行。
- 证据目录：`/private/tmp/amazon-network-recovery-403-followup-20261023/`，含修复前七路径备份、`before-hashes.json`、`before.patch`、`red.log`、`targeted-green.log`、`python-final.log`（20文件）、`python-final-all.log`（最终21文件）。
- `git diff --check`、两份未跟踪文档空白检查通过；首阶段五个源码/测试文件指纹不变、暂存区为空。PR4 HEAD仍为`b892ea8f`且工作区干净；本地main仍为`36130265`，没有同步或改写。
- 未调用生产ERP、真实认证刷新或附件发送，未重启/部署PR4服务；真实网络、模型API、Desktop聊天和Windows仍 **NOT VERIFIED**。
- 测试变量：`UV_CACHE_DIR=/private/tmp/codex-uv-cache`、`PYTHONDONTWRITEBYTECODE=1`、`TMPDIR=/private/tmp`；无需业务凭据。
- 首阶段证据目录：`/private/tmp/amazon-network-recovery-20261023/`。含9份源文件指纹、脱敏分类摘要`evidence.json`、`python-consumers.log`（初跑）、`python-final.log`及`bun-final.log`；Bun初跑在`/private/tmp/amazon-network-recovery-bun-20261023.log`。没有复制原始凭据或完整会话到仓库。

## Git与下一步

累计修改5个生产文件、7个现有测试文件，新增本记录及最小计划，共14条路径；其中本次追加3个生产文件和4个现有测试文件，更新两份已有草稿文档。无Skill、CLI/catalog、Runtime或Desktop生产实现、算法、锁文件变化。`git diff --check`及未跟踪文档空白检查通过。修改均未暂存，PR4仍干净；没有Commit或远端写操作。

本地局部代码修复具备人工评审材料，但历史连接问题不能宣布修复或生产验收通过。若后续继续定位网络，需要在获授权的最小复测中保留实际errno/原因链与DNS、连接、TLS阶段证据；不增加导出POST重发、不通过证书绕过或权限关闭验证假设。本轮授权的三条403路径已完成离线回归；其他未调查路径不作全覆盖承诺。修复尚未部署到运行服务，PR4继续保持原提交。

## 2026-10-24提交收口

- 本轮复核原14路径，只包含5个生产模块、7个既有测试和2份交接／计划。保持原Client、认证恢复次数、CLI、计算与导出算法；403/429立即停止，401仍只恢复一次，502/503/504及原有限连接恢复预算不变。
- 最新main已只读fetch至`e3274147`；5个受改生产文件和关键测试的上游预像与原基线一致。提交后用merge-tree复核整份补丁兼容性，不机械合并main、不改写分支历史。
- 本轮Python21文件338 passed、29条既有aiohttp弃用warning、无skip；选择包含各公开Service及CLI、共享CSV/MSKU明细、cloud和HTTP生命周期。与历史345组选择不同，不将数量混算。日志`/private/tmp/amazon-publish-network-python.log`。
- Bun原3文件58 passed、607 assertions。首轮51 pass/7 fail由沙箱阻止var/tmp写入与localhost监听引起；同命令提权后全部通过，未改源码或断言。最终日志`/private/tmp/amazon-publish-network-bun-final.log`。
- 完整保护快照由`/private/tmp/amazon-two-fixes-current-path`指向；PR4、PR3旧草稿及其他worktree保持。精确暂存、检查完整diff／敏感模式、Commit并正常Push后独立提PR；实际SHA、远端及PR URL以收口报告确认。
- 历史5次连接失败的DNS/TCP/TLS根因仍UNKNOWN；真实模型、生产ERP、登录、当前Desktop全链、附件及原生Windows仍NOT VERIFIED。不宣称已解决所有连接异常。
