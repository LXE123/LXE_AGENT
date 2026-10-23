# 越南备货九表验收

本文汇总 [PR #90](https://github.com/LXE123/LXE_AGENT/pull/90) 合并时的证据。作者开发阶段的文件与故障验证来自[原始交接记录](https://github.com/LXE123/LXE_AGENT/blob/5b6fa0bb2d4d76062eb24d34b79177b166ddce05/docs/harness/vietnam-stock-recommendation/handoff-nine-sheet-export.md)；最终跨平台结果来自[维护者合并前验证](https://github.com/LXE123/LXE_AGENT/pull/90#issuecomment-6288831699)。本次整理未重新执行计算或访问生产 ERP。

当前实现见[越南备货实现说明](../lxeskill-cli/vietnam-replenishment.md)，操作步骤见[越南 Skill](../../skills/vietnam-replenishment/SKILL.md)。历史测试只证明对应版本，不累加为当前测试数。

## 最终版本与跨平台验证

最终验证提交为 `bce7fd43`，基线为 `main@c4628e7a`，合并提交为 `5b6fa0bb`。2026-10-20 使用实际 LibreOffice Kit 0.1.5，九表集成包含真实重算：

| 环境 | 实际结果 |
| --- | --- |
| macOS 完整源码验证 | 协议、生产边界、全部工作区 TypeScript 检查通过；Bun 2214 通过、10 跳过；Python 2401 通过、6 跳过 |
| Windows 定向验证 | Python 740 通过、2 跳过；桌面与 lxeskillCLI 命令契约 31 通过；真实 Electron 工作台及越南设置 UI 2 通过 |

桌面核对覆盖：FBA 模板列表及入口计数不显示越南模板，越南设置模板区域间距为 14px，天数修正常显。Office 的 Node API / CLI 分工沿用 main，详见 [Kit 0.1.5 接入验收](office-integration-20261020.md)。跳过项不计作通过，源码和 UI 验证不等于安装器验收。

## 文件保真与输入生命周期

- **九表对照**：作者用三个合成雅仓 SKU（模板提供其中两个）和真实 Office 重算结果，对比修复前后输出。全部 18 个 ZIP 部件逐字节一致；九表顺序、尺寸、100 个公式、246 个非空 `v` 缓存和 4 个 inline 值，以及四张业务表 XML 一致。250 指缓存和值单元格总数，不是 250 个公式缓存。模板没有的来源 SKU 仍保留，依赖模板参数的结果留空。
- **换版与锁**：真实独立上传进程在读取报表期间将 current B 换为 C；本轮仍使用 B 的成本 12 和来源 B，下一轮使用 C 的成本 99 和来源 C。非阻塞 OS 锁探测确认选择和复制模板期间持锁，快照返回后可继续上传。显式临时模板使用成本 77，current C 与 previous B 的哈希不变。
- **旧入口退役**：只有旧 `sku-map.xlsx`、没有九表模板时，正式 CLI 返回退出码 2、`input_required`、`files=[]`；旧 `--sku-map-file` 返回退出码 2、`invalid_arguments`。没有恢复独立映射表覆盖或五表终稿回退。
- **来源边界**：正式 CLI 与 Office Kit 在隔离目录生成合成九表；设置服务上传、读取、导出和坏模板保护通过。一次用户聊天只读取并发送了已有结果，不能算作附件到新工作簿的全流程验收。

## 故障与兼容性证据

| 范围 | 复现及验证结果 |
| --- | --- |
| 资产换版 | 原实现复制失败可丢失 current，半写可发布截断文件。注入复制、短写、同步、切换等故障后，修复版保留 current/previous 的文件名与哈希，连续失败后仍可正常上传；正常换版、同内容重试的两代版本序列不变 |
| 二次故障 | 回滚再次失败时保留可恢复副本并报告实际恢复目录；清理失败不覆盖原上传错误，也不把已成功发布误报为失败。相关故障有独立回归 |
| Windows 文件同步 | 实机发现暂存文件用只读句柄 `fsync` 报 `OSError: [Errno 9] Bad file descriptor`；改为先通过可写句柄同步，再复制源元数据。共享资产逻辑覆盖越南和 FBA，也接受只读模板；最终 Windows 定向验证见上表 |
| OOXML 样式与命名空间 | 缺少可选 `numFmts`、带前缀的样式/共享字符串/包关系、扩展属性、局部前缀覆盖、`mc:Ignorable` 和 `dxfs` 顺序均有独立构造用例；重新解析检查真实 URI、样式引用，并用 openpyxl 和实际 Office 读取/重算 |
| XML 错误交付 | 真实 Office 后注入空命名空间共享字符串或未绑定前缀，正式 CLI 退出 4、`ok=false`、`files=[]`，保留实际 XML 错误且不交付成品 |
| 日期系统 | 原反例把 1900 系统的 2026-10-01 合入 1904 模板后读成 2030-10-02，偏移 1462 天。修复后上传、聊天模板、历史 current 和合并入口均拒绝不支持的 1904 或系统不一致，不转换日期；源文件哈希不变 |

日期回归由修复前 8 失败、3 通过变为 11 通过；覆盖 `date1904` 缺省、`0/false`、`1/true`、双向不一致和双 1904。三个正式 CLI 失败路径均退出 4、`ok=false`、`files=[]`，正常 1900 生成与导出仍通过。作者同时核对用户原始九表模板、当时 current、五表骨架和 Office 重算五表均为 1900，未改真实模板。

可复核的回归入口：[资产换版](../../python/lxeskill_cli/tests/infra/test_input_assets.py)、[设置与锁](../../python/lxeskill_cli/tests/vietnam_replenishment/test_settings.py)、[工作簿合并](../../python/lxeskill_cli/tests/vietnam_replenishment/test_full_workbook.py)、[CLI 与 Office 集成](../../python/lxeskill_cli/tests/vietnam_replenishment/test_pr5_integration.py)。这些链接是后续复验入口，不表示本次文档整理重新运行了测试。

## 未验证范围

真实雅仓三份生产报表及其业务 SKU 结果、真实聊天附件到新 Excel 的完整 UI 流程、原生 Excel/WPS、发布安装器、完整 Open XML schema、掉电或进程强制终止恢复仍未完成验收。普通 I/O 故障恢复不证明两代资产在掉电时具备事务原子性；哈希一致也不证明 ERP 报表同批次或数据新鲜度。
