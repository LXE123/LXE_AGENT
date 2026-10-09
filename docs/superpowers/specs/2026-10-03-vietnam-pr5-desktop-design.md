# 越南备货 PR5：Desktop 映射表管理与长期参数设置

## 基线、目标与范围

本模块在 Clean Stack 的在线 Workflow 层之后实施，分支为 `codex/vietnam-clean-pr5-desktop`，基线为新 PR4 `9db9fc89b93a508d12c94f8e5963cbfc7d56c973`。前序资产、雅仓来源、Workbook 和在线 Workflow 已按层依赖；不在 `main` 开发。

本 PR 让业务人员在 Desktop 管理 `vietnam_sku_parameter_map`，并长期设置越南备货的 30 天、15 天、7 天权重和汇率。成功上传的 current 才能进入 PR4 确定性工作流；保存后的长期参数在下一次生成中生效。生成仍只交付经验证的五表 XLSX，不改变雅仓取数、SKU 精确匹配、公式骨架或 Office Kit 口径。

聊天单次参数覆盖另开后续 PR。现有业务命令在 PR5 仍不接受聊天参数或映射表路径；若用户明确要求“本次用某数值”，Skill 必须说明暂不支持并停止，不能忽略要求。完整业务目标的优先级是“聊天临时值 > Desktop 长期设置 > 系统默认值”；本 PR 只实现后两层，不声称第一层已可用。

## 方案选择与模块接口

不使用现有 `shared.input_assets.promote_asset()` 更新此槽：它会先移走 current 再复制候选，中断时可能没有 current。也不为全部业务资产重写通用轮换。PR5 为 Desktop 管理的越南 SKU 槽增加受控版本存储，沿用已有资产注册、列表、Desktop 工作台、Python 映射表解析器和跨进程锁。

模块对调用方提供三个业务动作：读取受信 current 的私有快照、安装候选映射表、回滚到 previous。调用方不用知道版本文件名、哈希清单和切换顺序。Desktop 主进程只提供固定槽位的上传/回滚动作，不接受渲染进程传入的任意源路径；源文件由 Electron 原生文件选择器取得。Python 侧集中校验文件和执行存储事务；其他 `management: command` 槽的行为保持原样。历史 `vietnam_replenishment_template` 槽只保留兼容展示，不开放上传入口，也不进入生成。

## 候选文件与运行前校验

上传仅接受本机普通 `.xlsx` 文件，不跟随符号链接；压缩文件不超过 20 MiB，ZIP 条目不超过 1000 个，声明解压总量不超过 100 MiB。超限、损坏、加密或非工作簿文件在切换前失败。限制仅针对运营映射表，错误显示具体原因，不输出整表、成本和价格到日志。

内容校验复用 `load_sku_parameters()`，并将 PR4 工作流的完整性预检提成共用函数。第一张工作表必须有 `SKU`、`成本`、`跨境价`、`折扣价`、`热销标记` 表头；SKU 为非空文本且唯一，输入格不能是公式；每一行的三项价格为显式、有限、非负且符合最终 Excel 写入精度的数值，显式 0 有效；热销标记可空，否则只能是 1 或 2；映射表至少有一个 SKU。可选 `上架时间` 仍按现有解析器检查，生成时仍要与雅仓商品创建时间核对。上传不调用雅仓，也不能预断映射表是否覆盖未来本轮出现的新 SKU；生成时继续做精确 SKU 和实时来源校验。

先读取候选并计算 SHA-256，再复制到槽位内的暂存文件，核对复制后的 SHA-256 并对暂存副本再次做内容校验。源文件若在复制期间变化则失败，旧 current 和 previous 保持不变。相同内容再次上传是幂等操作，不占用 previous。上传失败给出经必要脱敏、显式截断的实际错误；不以通用成功文案掩盖失败。

## 可信 current、替换与回滚

槽位内使用不可变的 `versions/<id>.xlsx` 文件和同目录 `manifest.json`。清单 schema 固定为版本 1，记录不可复用的 32 位十六进制提交 revision，以及两个逻辑版本 `current`、`previous`；每个版本记录 32 位十六进制版本 ID、原始展示名、SHA-256、大小和上传时间。路径只能由受限 ID 在槽位根内构造，清单或版本文件若为符号链接、Windows reparse point 或非普通文件就拒绝读取。每次真正切换 current（包括回滚）都生成新 revision，同内容幂等上传不变。只有清单指向且文件摘要吻合的版本可被读取；手工放在旧式 `current/` 目录的文件不自动受信，用户须在 Desktop 重新上传一次。清单缺失表示尚未上传；清单损坏、文件缺失或摘要不符是明确错误，不回退旧目录或历史模板。`shared.input_assets.current_asset()`、`previous_asset()` 对这个槽位和 `assets list` 必须经同一受信清单读取入口，不能继续扫描旧 `current/previous` 目录；其他槽位仍按原规则读取。旧目录有文件但无清单时，列表显示没有 current，生成在雅仓调用前停止。

安装和回滚复用 `shared.process_lock.interprocess_lock`，对该槽串行操作。Desktop 在打开选择器前记录预期 manifest revision；提交时仍在锁内比较，发现其他窗口已改动则拒绝覆盖并要求刷新。不能只比较 current 摘要，因为 A→B→A 的连续切换仍须识别为并发改动。回滚也按同一 revision 比较。候选版本文件完全写入并复验后，先写同目录临时清单，再以一次文件替换提交新指针。版本文件及临时清单先刷新到磁盘；临时清单必须与正式清单位于同一卷，只能用 `os.replace` 提交，替换失败时不得退化为先删除后重命名。提交前发生任何复制、校验或写入错误，旧清单和 current/previous 不变。崩溃后未被清单引用的暂存或版本文件只能视为孤儿，下次持锁管理时清理；清单已提交则以清单所指版本为准，读取仍复验摘要。提交后仅清理不再被两个指针引用的版本；清理失败不撤销成功提交，也不暴露旧版本给生成命令。

回滚先核对 previous 的文件摘要并重跑内容预检，再在锁内交换两个指针；原 current 完整时成为新的 previous，支持再次切换。若原 current 已损坏，恢复有效 previous 后不把损坏文件保留为可再次启用的 previous。回滚时也要先复验 current 的摘要、大小和内容，才能决定是否把它保留为新的 previous；无 previous 或 previous 损坏时拒绝回滚，current 不变。PR4 的生成流程在同一把锁保护下读取清单、复制并校验私有快照，然后释放锁再导出雅仓；替换或回滚不会改变已经开始的一轮生成。

资产列表继续由 Python `assets list` 提供，对越南 SKU 槽持同一跨进程锁读取、复验并一次构造 current/previous 的文件大小和展示信息，不能先取得路径再在锁外 `stat`；协议透传 `management`。若清单结构有效但 current 损坏，列表仍返回清单 revision、有效 previous、current=null 和实际完整性错误，使 Desktop 能以 revision 安全回滚；previous 损坏时返回其实际错误并禁用回滚。清单本身损坏时该槽返回错误且不提供可操作 revision，其余槽仍可展示，生成和写入均拒绝此状态。上传恢复损坏 current 时只保留已验证的 previous；不能把损坏的旧 current 变成 previous。Desktop 资产页只给该槽显示上传和回滚按钮，回滚仅在存在有效 previous 和 revision 时可用，并显示具体成功或失败结果。旧模板槽的说明改为历史兼容，避免提示用户上传完整模板。

## 四参数长期设置与生效顺序

Desktop `settings.json` 增加独立的 `vietnam_recommendation` 四字段对象，schema 从 11 升为 12。四项以十进制字符串保存，避免 JavaScript 浮点数改写用户输入；读取旧 schema 时补入 `0.8 / 0.8 / 0 / 3900`。新 schema 缺字段或字段非法必须报错，不静默恢复默认。设置区放在“设置 → ERP 账号 → 雅仓”下的“越南备货”，纳入现有草稿、脏状态和统一保存流程；无需设置雅仓密码也能编辑四参数；仅修改四参数时，提交不得因雅仓手机号的未完成草稿而自动触发 `yacang: save` 的密码校验。参数保存与雅仓凭据动作在输入契约中彼此独立。

三项权重必须是有限非负数，汇率必须是有限正数；均须满足 PR3 `RecommendationConfig` 的 15 位 Excel 有效数字和精确写入限制。Desktop IPC 和存储层在保存前校验，Python 在运行时再次校验。Desktop 每次向 Gateway/Agent/Python 环境同时注入 `LXE_VIETNAM_WEIGHT_30D`、`LXE_VIETNAM_WEIGHT_15D`、`LXE_VIETNAM_WEIGHT_7D`、`LXE_VIETNAM_EXCHANGE_RATE`。沿用现有 `saveSetup` 的环境变更检测与 Gateway 重启，让保存后的设置进入下一轮命令。

Python 只在四个变量全部缺席时使用 `RecommendationConfig()` 的系统默认值；出现部分缺失、空串或非法值时，在雅仓导出前失败并报告实际配置问题，不能逐项偷偷回退。PR4 Workflow 改为把校验后的配置传给 PR3 生成器，CLI 成功结果报告本轮生效四值及可观测来源 `environment` 或 `default`，便于核对输出；Python 不把任意人工注入的环境变量误称为已保存的 Desktop 设置。其他环境变量、雅仓凭据和 Desktop 密钥存储不受此设置影响。

## 验证、交付与风险

定向测试使用合成 XLSX 和替代的雅仓导出函数，不调用生产雅仓。Python 覆盖候选格式、内容、SHA-256、同内容幂等、切换失败、回滚、损坏版本、多窗口交错与 A→B→A 并发冲突，以及生成期间替换；缺 current、坏 current、仅有旧目录文件但无受信清单、或坏配置均须在雅仓调用前停止；旧目录文件也不得在列表中显示为 current。Desktop 覆盖原生选择器取消、无 renderer 文件路径、IPC 固定槽、列表状态、v11 设置迁移、非法设置拒绝、保存后环境刷新和界面草稿。至少一条合成端到端用例核对非默认四值进入五表，并继续使用项目 Office Kit。若修改 `catalog.json`，按仓库规定执行 Python CLI/infra 与 Bun catalog 双端定向测试；另做受影响模块 typecheck、`git diff --check`、Git 状态及敏感信息检查。全量测试留待最终合并前按仓库规则运行一次。

Windows 是正式分发目标。开发阶段通过故障注入验证文件替换前后的状态；Windows 文件占用、断电恢复及安装包中的 Python 命令路由须在 Windows 环境现场验收，不能用 macOS 结果声称完成 Windows 验收。真实雅仓当前库存导出仍按既有交接等待现场联调。清单与摘要防止应用正常入口的失败上传和意外文件改动；同一系统用户若直接改写清单及版本文件，不属于本 PR 能以文件系统权限隔离的对抗边界。

PR5 限于 Desktop SKU 映射表管理、四参数长期设置、必要 Workflow/CLI/Skill 接线和测试、文档及 `handoff-pr5.md`。聊天单次覆盖、雅仓接口猜测、历史模板参数复用、公共资产重构及无关 Bug 均不并入。按可独立验证的步骤拆 commit；每次 Git add/commit、push、创建 PR、merge 分别取得用户批准。本层以新 PR4 为基线，收口信息见 `docs/harness/vietnam-stock-recommendation/handoff-pr5.md`。
