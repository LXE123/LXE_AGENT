# Mac WireGuard 系统服务

Apple Silicon Mac 开发版在导入 Enrollment 或点击“重连”时，通过一次管理员授权安装 `com.lxe.wireguard.lxe-agent` 系统服务。已有用户升级后点击一次“重连”即可迁移；无需重新登记设备。Windows 流程不变。

服务随系统启动，关闭 LXE 不会停止隧道。它每 5 秒检查本隧道的 socket、接口、地址和到 `10.88.0.1` 的路由，连续两次异常后重建；服务进程退出由 launchd 重启，节流为 10 秒。暂时断网、握手变旧、上游 HTTP 错误和 401 不触发隧道重建。应用仍每分钟检查业务状态，这与系统服务的恢复是两条独立流程。

配置和控制器在 `/Library/Application Support/LXE/WireGuard/`，目录由 root 持有、权限 0700，`lxe-agent.conf` 权限 0600。运行期不依赖用户临时目录；配置含私钥，不要复制到工单、日志或仓库。安装会在 root 目录内备份、切换并检查本地就绪；失败恢复旧配置和服务。旧的一次性隧道切换失败时，使用旧配置恢复成受监督隧道。回滚也失败会保留真实诊断并明确报告旧连接没有恢复。

## 排查

```sh
sudo launchctl print system/com.lxe.wireguard.lxe-agent
sudo /opt/homebrew/bin/bash '/Library/Application Support/LXE/WireGuard/service.sh' probe
sudo tail -n 60 '/Library/Application Support/LXE/WireGuard/service.log'
curl --connect-timeout 3 --max-time 5 http://10.88.0.1:8000/api/v1/agent-data/health
```

`probe` 退出码 0 表示本地隧道就绪，不代表业务授权成功。日志包含启动、检查失败、重建、退出码和恢复耗时；每份最多 5 MB，另保留 3 份历史文件，输出前脱敏。

## 维护

停止并禁用自动启动（保留配置；恢复时在应用点击“重连”）：

```sh
sudo /opt/homebrew/bin/bash '/Library/Application Support/LXE/WireGuard/service.sh' stop
```

卸载本服务并删除持久化私钥配置（保留脱敏日志；不删除其他 VPN）：

```sh
sudo /opt/homebrew/bin/bash '/Library/Application Support/LXE/WireGuard/service.sh' uninstall
```

不要单独杀监督进程来停用服务，launchd 会重新启动它。不要直接后台执行 `wg-quick up` 与此服务同时管理同一隧道。

## 实机验收

从独立 Tailscale SSH 通道操作，先确认这是 `lxe-agent` 的进程和接口。分别终止其 wireguard-go 和监督进程，检查网络正常时 30 秒内恢复、地址/路由一致且没有重复隧道；随后关闭 LXE 验证服务独立运行。停止和卸载后观察至少 30 秒，确认不会重新启动。断网恢复与系统重启安排在维护窗口，确认恢复网络/启动系统后无需再次授权即可连通。不得对其他 WireGuard 隧道做故障注入。
