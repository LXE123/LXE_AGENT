为了快速部署这个 agent，我准备在 scripts/ 里创建一个文件 install.ps1，专门用来安装该项目。

不过在写这个按照脚本之前，有一件事必须要搞清楚。版本管理问题。目前已切换成 uv 管理，完成。

那么下一步就是规划这个安装脚本了。
这个安装脚本 install.ps1 应该都有什么功能呢？
大概可以分为两个阶段，仓库拉取和环境安装。
第一阶段
1. 自动安装 uv （方便快速版本管理）
2. clone 或下载源码（zip 格式）
第二阶段
1. uv 安装依赖，做环境管理
2. uv python install 3.12.10
3. uv sync --frozen --all-groups --python 3.12.10
4. 安装 Playwright Chromium
5. 创建 LXE 启动器（创建一个独立 shim，只用于启动项目）并设置用户 PATH
6. 跑健康检查
7. 输出启动命令：LXE start

---

再补两个脚本：
scripts/doctor.ps1
scripts/update.ps1

1. scripts/doctor.ps1
这个做什么？
uv 可用
Python 是 3.12.10
uv lock --check
uv sync --frozen --all-groups --python 3.12.10 --check
关键 import：psycopg、pandas、playwright
Playwright Chromium 可用
.env.example 和 config/runtime.env 存在；真实 secret/private 值由 .env 或系统环境变量提供，本机非敏感覆盖由 .env.local 提供

2. scripts/update.ps1
这个做什么？
检查是否是 git 仓库
检查是否有本地未提交改动
有本地改动就直接失败，提示先提交或 stash
git pull --ff-only
uv sync --frozen --all-groups --python 3.12.10
uv run --frozen python -m playwright install chromium
跑 scripts/doctor.ps1

---

疑问解答：
1. scripts/install.ps1 这个文件本身就在项目里，为什么这个文件还会承担拉取仓库的角色？
这个问题换一种更简单的提问方式就是，安装脚本从哪来？直接从 GitHub 拉一个单文件脚本执行。此时用户电脑上还没有项目源码，所以这个脚本必须自己完成 clone / 下载源码。
是的，就这样，直接从仓库把这个文件单独拉取过来安装整个项目。

2. scripts/install.ps1 这个脚本是否应该支持重复安装
不支持，安装好后，可以更新可以删除，但是不支持重复安装
如果重复安装，直接让用户自己手动删除 %USERPROFILE%\.lxe_agent

3. 安装目录应该在哪？
%USERPROFILE%\.lxe_agent
