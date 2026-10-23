# 输入框引用验收记录

日期：2026-10-02。Lexical 固定 0.49.0，沿用 React 19。行为基准为本地 dsh 的 `639ed015397290b3745d163aafe02ffee4aa3f84`，不引入其插件或会话引用框架。

## 已验证内容

- 真实临时目录：根目录与深层搜索、中文和空格、隐藏路径、固定排除目录、忽略 `.gitignore`、结果和索引上限、过期重建、取消、路径越界及符号链接；Windows 使用真实 junction 验证边界。
- 桌面 RPC：两个不同会话只能得到各自工作区的候选，未知会话拒绝；技能读取保持权限过滤和旧管理页调用兼容。删除会话会释放其搜索实例。
- Runtime：直接输入、多技能、重复引用、权限禁用、未知技能、附件／系统事件／历史／工具结果中的文本；正文与资源目录进入模型请求，激活所属工具并记录实际使用。加载异常保留实际错误和用户输入；模型请求由测试 Provider 捕获，不调用公网模型。
- 预览：技能源文件可位于工作区之外，但只能按当前会话授权的技能名称解析；每次读取重新校验。撤权、删除、恢复、绝对路径伪装及跨会话访问均验证。历史技能标记只来自加载记录。
- 真实 Electron 中的 10 组新交互：键盘选项、目录下钻和选择、空格引号、手写技能、点击预览、未知技能、文件删除后发送、输入法组合事件、Esc、旧请求隔离、撤销重做、原生复制、删除、会话草稿切换、8192 字符以及窄窗口与深色主题。
- 原有 5 组输入框测试继续通过，包括发送／排队、发送失败保留草稿、附件、离线、模型设置保存中的发送门禁。其余对话与工作区交互回归也通过。

## macOS ARM64

最终更新到主分支后执行了一次完整 `bun run verify`：协议检查、生产代码边界和类型检查通过；Bun **1948 通过、7 跳过、1 失败**。唯一失败是架构检查要求视图经 Query hooks 查询数据，已将补全读取移入 `api/queries.ts`，用 Query Client 合并请求并保留输入框的请求代次隔离。

修复后 Query／传输／架构的 **12 项测试**、输入框与引用的 **15 组 Electron 场景**通过。继续执行完整检查中未运行的 Python 部分：**1965 通过、4 跳过**。没有为了得到绿色总数重复运行未变化的全量测试。

期间主分支另合入“移除重复工作区文件按钮”；再次 rebase 后，真实 Electron 文件查看器与架构定向检查通过，全工作区类型检查通过。生产 Dashboard 和 Electron 构建通过，单 React 和 Renderer CSP 构建检查均通过。

本机日志：`/tmp/lxe-composer-verify.log`、`/tmp/lxe-composer-py.log`、`/tmp/lxe-composer-query-tests.log`、`/tmp/lxe-composer-final-ui.log`、`/tmp/lxe-composer-rebase-test.log`。

## Windows x64

验收机 `PC-20240421FADR`，通过 Tailscale SSH，在池内独立 worktree 和依赖环境运行。首次 **179 项定向测试通过、0 失败**，包含协议、搜索、Runtime、Dashboard Service、文件预览、历史展示以及 6 个 Electron 测试套件（44 组交互场景）。全工作区类型检查与生产 Dashboard／Electron 构建通过。

组件测试阻止向外部网站请求；Lexical、图标及查看器使用随包资源。文件服务使用真实磁盘目录，技能预览不依赖模型、额外安装应用或网络内容。未重新发布安装器或更新渠道。

## 截图说明

`composer-reference-fixture-dark.png` 与 `composer-reference-menu-fixture-dark.png` 是**生产组件测试夹具**截图，不是用户的生产聊天记录。macOS 输出在 `/tmp/lxe-composer-captures/`，Windows 输出在 `D:\projects\composer-reference-captures\`。

Windows 最终版本同步 Query 修复及最新侧栏变更后，再次执行受影响范围：**19 项测试通过、0 失败**，包括 44 组对话交互、18 组文件查看器场景，以及 Query／传输／架构测试。全工作区类型检查和 Dashboard／Electron 构建再次退出码 0。日志为 `D:\projects\lxe-composer-win.log` 与 `D:\projects\lxe-composer-win-final.log`。

## 候选菜单对齐（2026-10-02）

对照 dsh 的 `ui-input-trigger/MenuView` 与 `ui-reference`，改为单行名称与右侧说明；根目录不重复路径，其他文件只显示父目录，目录下钻后以固定面包屑提供路径。目录选中行显示 Tab 提示；技能候选不额外加图标。菜单与输入框等宽，上限 400px，按窗口和输入框高度收缩。鼠标按下即选择并保留编辑焦点，鼠标移动才更换高亮。

macOS：真实 Electron 的 **13 组引用交互**与原有 **5 组输入框交互**通过，另通过 Dashboard 类型检查、模块边界检查和生产构建。新增检查覆盖裸 `@`／`/`、父目录展示、鼠标选择、带引号的下钻／返回根目录、20 项列表键盘滚动、短窗口、输入框增高和聊天滚动保持。这是输入框局部修改，按仓库简单修改流程在干净的 main 开发并做定向验证。

截图 `at-root-menu-fixture-light.png`、`skill-menu-fixture-light.png` 和 `composer-reference-menu-fixture-dark.png` 位于 `/tmp/lxe-menu-captures/`，均为**生产组件测试夹具**。日志为 `/tmp/lxe-menu-ui.log`、`/tmp/lxe-menu-ui-references.log` 与 `/tmp/lxe-menu-build.log`。

Windows x64：同步同一提交后，以上 **18 组 Electron 交互**、Dashboard 类型检查和完整桌面构建均通过；已核对 Windows 菜单截图。日志为 `D:\projects\lxe-menu-win-test.log`、`lxe-menu-win-types.log`、`lxe-menu-win-build.log`，截图在 `D:\projects\lxe-menu-captures\`。macOS 的 Electron 构建也通过；本次未重新发布安装器。
