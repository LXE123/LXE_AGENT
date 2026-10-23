# 正式更新代码验证记录

日期：2026-09-21。Windows 测试机：PC-20240421FADR。

本次完成正式代码接入、安装包构建检查和隔离更新器验证。没有部署线上服务器，没有发布 COS 正式渠道，也没有覆盖 D:\lxe agent。

## 已完成

| 范围 | 结果 |
| --- | --- |
| 服务器完整测试 | 1,403 passed；含专用本机 PostgreSQL 并发限流和迁移测试 |
| 桌面 JavaScript 完整测试 | 1,654 passed，3 项 Windows 专用测试在 Windows 补跑通过 |
| Python 完整测试 | 1,764 passed，2 skipped，54 subtests passed |
| Windows 定向测试 | 18 passed，包含更新状态机、安装尝试记录、跨盘技能回收和运行时复制 |
| 类型与构建 | 协议生成检查、TS 边界检查、全部工作区类型检查、Dashboard 与 Electron 构建通过 |
| 最后诊断修正 | 类型检查及 17 项构建、更新、发布定向测试通过 |
| UI | 实际 React 组件预览核对：圆环进度、展开按钮、确认弹窗与任务忙碌提示 |
| Windows 隔离更新器 | 本机 HTTP 测试源下载 131,072 字节并校验；再次下载只复用缓存；改动文件后校验拒绝；缓存不含签名 URL；未调用安装 |
| 正式安装保护 | 正式 exe 和 app.asar 的 SHA-256 与测试前相同 |

首次打包暴露了 electron-builder 没有收集到外部 electron-updater 依赖的问题。已经改为把更新器及 JavaScript 依赖直接编入主程序，并增加构建回归检查。修复后核对实际 app.asar 内包含更新器实现，版本为 0.2.17，资源目录包含 app-update.yml。

完整 JavaScript 测试之后只修改了两处错误诊断文本处理；已完成上述定向复验。服务器代码提交为 1f06848，客户端最终代码提交为 f45bd67f。

## 仍需真实验收

1. 按正常部署流程上线服务器接口、执行数据库迁移并加载只读 COS 凭据。
2. 备份正式 LXE 数据，手动覆盖安装首次包含更新功能的 0.2.17。
3. 发布下一个经过验证的版本，验证真实 LXE 的后台下载、任务拦截、子进程退出、NSIS 覆盖安装及数据保留。

隔离更新器使用的是测试 HTTP 源；COS 有效签名、过期拒绝和独立 NSIS 覆盖升级由前一阶段独立小程序验证。本次不将两者合称为“正式 LXE 端到端升级通过”。普通退出不安装的配置已核对，正式应用完整退出链路仍属于第 3 步真实验收。

## 最终候选包

- 版本：0.2.17；构建编号：20260921T082839100Z-f99c97aa。
- 源码提交：f45bd67f87f0a73033511501a7ac4d3d148311cc。
- 大小：314,081,149 字节；原件与归档副本 SHA-512 一致。
- Windows 归档目录：`D:\lxe-update-lab-20260921\formal-candidates\20260921T082839100Z-f99c97aa`。
- 目录内同时保存 `candidate.json` 和 `LXE-Agent-0.2.17-windows-x64.exe`。
- SHA-512（base64）：`1YuFnkQMicFszaAQWCjvqfoFPPkX6akmhr++3eVDr6hAdC5bwkiS+fTGuSwSlxv+l7ra7NslGzU5mUEV9KhjAg==`。
- 仅作为待真实验收的候选包；未发布、未安装。
