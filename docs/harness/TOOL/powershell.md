目前该 agent 系统在 windows 系统上使用 exec 工具时，基本上都是基于 powershell 来运行。
---
powershell 可执行终端命令时，返回的数据可能是文本，可能是对象。取决于终端命令种类。
---
第一种终端命令 PowerShell cmdlet 返回都是对象
比如，有以下这些返回对象
Get-Location -> PathInfo 对象
Get-ChildItem -> FileInfo / DirectoryInfo 对象
Select-Object -> PSCustomObject 对象
字符串命令或 Write-Output "abc" -> String 对象
这些对象除了 string 对象都需要解析才能看到具体文本内容。

第二种，外部程序 比如 cmd /c dir，比如 python 脚本
这种情况返回  stdout/stderr，是纯文本

只举例到这，重点是了解到在 powershell 中执行命令，不一定能拿到文本，而是需要解析的命令。
---

要写这些的原因是，目前我的这个 harness 框架的 exec 工具无法正常拿到 powershell 终端最终格式化好的内容。
问题出在哪？
目前（0516）项目执行 powershell 时，是通过一个 wrapper 调用的。
就是这个 wrapper 导致了无法正常拿到返回结果
---
参考了优秀开源模型的经验后，我决定抛弃这个 wrapper，直接指挥 powershell 运行。
那么具体细节如何实现呢？
1. 首先按固定路径 + PATH 的顺序查找可用的 PowerShell。查看当前系统 powershell 版本，如果有 PowerShell 7+，就使用 PowerShell 7+。否则 PowerShell 5.1 （这个 powerShell 5.1 一般是自带的，如果一个 windows 电脑连 5.1 都没有，那我选择拒绝为这台电脑服务。。。）
具体查询步骤如下：
- ProgramFiles\PowerShell\7\pwsh.exe
- ProgramW6432\PowerShell\7\pwsh.exe
- PATH 里的 pwsh
- SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe
- powershell.exe
具体代码：
```js
export function resolvePowerShellPath(): string {
  // Prefer PowerShell 7 when available; PS 5.1 lacks "&&" support.
  const programFiles = process.env.ProgramFiles || process.env.PROGRAMFILES || "C:\\Program Files";
  const pwsh7 = path.join(programFiles, "PowerShell", "7", "pwsh.exe");
  if (fs.existsSync(pwsh7)) {
    return pwsh7;
  }

  const programW6432 = process.env.ProgramW6432;
  if (programW6432 && programW6432 !== programFiles) {
    const pwsh7Alt = path.join(programW6432, "PowerShell", "7", "pwsh.exe");
    if (fs.existsSync(pwsh7Alt)) {
      return pwsh7Alt;
    }
  }

  const pwshInPath = resolveShellFromPath("pwsh");
  if (pwshInPath) {
    return pwshInPath;
  }

  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (systemRoot) {
    const candidate = path.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return "powershell.exe";
}
```
2. 启动：
```bash
pwsh/powershell -NoProfile -NonInteractive -Command <原始 command>
```
启动的格式大概是这样的，
这些启动的 powershell 都看成当前 agent 的子进程，会stdout 和 stderr 分别接 pipe，harness 分别 pump。这个 pipe 主要负责把 powershell 输出的 stdout/stderr 转发给 agent。
3. 读取输出：持续读取子进程的 stdout/stderr。PowerShell 会自己负责把 success/output 对象格式化成终端文本，exec 只捕获这些文本即可。
---
生命周期：
每次 exec 启动一个独立的 PowerShell 子进程。命令执行结束后，PowerShell 进程自然退出，harness 等待子进程退出并读取 exit code。harness 不负责解析 PowerShell 对象，只负责持续读取 stdout/stderr 文本、记录退出码、处理超时或取消。
---
当前代码是：
```py
stderr=asyncio.subprocess.STDOUT
```
这会把错误、CLIXML、普通输出混在一个 output 里。改成更干净的设计是分别 pump stdout/stderr，最终 payload 仍可合并展示，内部保留来源。
参考：
```json
{
  "session": "exec_xxx",
  "status": "completed",
  "exit_code": 0,
  "duration_sec": 0.56,
  "output": "
    [stdout]
    ...

    [stderr]
    ..."
}
```
---
一个潜在问题：
- 退出码语义会变简单，但可能丢失 native 程序的精确退出码
回答：这个问题不用担心

