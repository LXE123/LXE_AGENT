# 雅仓库存动销日期列交付交接

## 分支、完成范围与入口

- 当前最终累计层：`codex/pr4-yacang-compat`，pool-22，依赖 PR3/PR2/PR1。main 基线 5f785341。
- 原 `codex/yacang-snapshot-date` / pool-14 / `06301fff` 保持 clean。
- 库存动销交付副本去掉末列“创建日期”，原始 XLSX 留在同次运行 original/；当前库存与仓库产品逐字节原样交付，产品真实创建时间保留。
- 入口：yacang-export → lxeskill yacang export run → 既有 workflow 下载/校验 → delivery.publish_inventory_sales_without_snapshot_date → terminal.files → send_files。
- 只调整交付副本；created_date 筛选、仓库/报表选择、四仓多报表、九文件、部分成功、认证与 CLI schema 不变。
- 沿用 LXE_YACANG_MOBILE / LXE_YACANG_PASSWORD、LXE_DATA_ROOT、LXE_SQLITE_DB_PATH，无新增变量。

## 本层文件

- python/lxeskill_cli/services/yacang/{delivery,workflow}.py
- python/lxeskill_cli/tests/yacang/test_export.py：保留 PR1 默认 Python DB 路径测试。
- python/lxeskill_cli/lxeskill/catalog.json：仅 dataset 描述，command/schema 不变。
- skills/yacang-export/SKILL.md、skills/southeast-asia-replenishment-workflow-map/SKILL.md
- docs/harness/skill/{current_skill_catalog,yacang-export-validation}.md
- 本交接；原独立 PR4 acceptance 报告已合并。

共享 map/catalog 文档保留前两层国家边界；本次迁移修复是 PR1 归属，在全部累计层原样继承，不作为新雅仓功能。

## 实现与验证

- 修改 worksheet P 列及 dimension/row spans，不重建整本文件；DOM 保留命名空间，其他 ZIP 部件保持原字节，文件句柄关闭后原子发布，沿用长路径适配。
- 原新测试先失败后通过；覆盖四仓三类九文件、原件、共享字符串/命名空间、空表、部分成功 CLI files、中文长路径与异常不发布。
- 最新迁移修复后组合 Python：590 passed、2 skipped、4 既有 aiohttp warnings。
- 最新 Bun：58 passed、0 failed、330 assertions、7 文件，覆盖 Skill/catalog、真实 macOS exec/Seatbelt/Python bootstrap、Desktop state、Gateway files 顺序。
- 最新 pool-22 typecheck：8 工作区通过。此前组合 Bun 243 passed / 1607 assertions、desktop:build 通过；本轮没有改 TS/构建，不重复执行无关全套。
- 先前临时原件验证：1108 数据行、15 列，其他单元格与 ZIP 部件不变、ZIP/openpyxl 通过。macOS Numbers 曾实际打开合成回归文件；真实业务数据未加入 Git。
- 上述 fixture/sandbox 未调用生产导出/login API，不使用真实凭据。

## 服务、实测与边界

- 运行服务：pool-22，正式 app://lxe/，最近一次授权重启 gateway boot 为 ecc2bbe135d94c708b480f1f118485fc；旧 pool-18 已停止。提交同步阶段不重启服务。
- 启动复用了忽略目录内的本机配置/配对 machine identity/上马持久认证，只调整 workspace_root；无旧 Bun DB、会话、任务、transcript、产物或 venv 复制，无凭据提交。
- 用户已确认完整组合服务测试通过。独立查到雅仓 read → exec → send_files，4 模型/3 Tool、完成附件交付；这属于本次迁移收敛前实测，收敛后未重新执行生产导出。
- Runtime Step Loop、Cloud 权限、Gateway 调度、Shangman Credentials/AuthStore/GoodsExporter/生产门禁、TMS/巴西业务及 send_files 均未改。
- Windows-native ACL、Excel/WPS、安装包：NOT VERIFIED。真实 Git 父链/merge-tree：交付同步前必须验证，最终结果记录在仓库外交付资料。
- 日期字段不推断为商品上架时间；隐藏库存动销字段不改变真实筛选。

## Git 与下一步

2026-10-08 四层为未提交快照；2026-10-09 已获受控提交、父链建立及本地 origin 同步授权，原三个业务分支保留。先验证真实 parent/增量/merge-tree，再正常推送本地，不 force push。仓库外 evidence JSON 记录最终 hash、范围与同步结果；GitHub push/线上 PR 创建未授权。PR1 → PR2 → PR3 → PR4 串行，前项合入后基于当时 main 再核对下一层。
