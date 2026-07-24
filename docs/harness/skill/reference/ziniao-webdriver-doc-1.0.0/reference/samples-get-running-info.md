# getRunningInfo 脱敏响应样本

抓取时间：2026-07-17。方法：店铺浏览器运行中，向本机固定控制端口 16851 POST `{"action": "getRunningInfo", "requestId": "..."}`，只读。下面的店铺标识、IP、用户目录和下载目录已脱敏。

紫鸟官方文档（见 [api-core.md](api-core.md)）未承诺 `getRunningInfo` 的完整字段集合，本样本用于确认实际字段。`debuggingPort` 已用 `GET /json/version`（CDP）验证真实可附着。

```json
{
  "action": "getRunningInfo",
  "requestId": "sample-running-info",
  "statusCode": 0,
  "err": "",
  "browsers": [
    {
      "statusCode": 0,
      "browserOauth": "<encrypted-store-id>",
      "ip": "<masked-ip>",
      "isDynamicIp": false,
      "browserPath": "/Users/<user>/Library/Application Support/ziniaobrowser/env-kit/Core/chrome_64_138.1.2.80",
      "downloadPath": "/Users/<user>/Library/Application Support/ziniaobrowserdatas/ziniao browser/<store-download-directory>",
      "userData": "/Users/<user>/Library/Application Support/ziniaobrowser/userdata/chrome_<profile-id>",
      "launcherPage": "https://sellercentral.amazon.com/home",
      "debuggingPort": 26176,
      "reportPluginId": "",
      "duplicate": 0,
      "proxyTag": null,
      "proxyType": 1,
      "mainHandle": 3220,
      "core_type": 0,
      "core_version": "138.1.2.80",
      "ipDetectionPage": "chrome-extension://djjncglmphdcfhldjiohjoilhimbmpdb/index.html"
    }
  ]
}
```

结论：附着一个运行中店铺所需的全部材料（`browserOauth`、`browserPath`、`debuggingPort`、`downloadPath`、`core_type`、`core_version`）都在响应中；仅 `browserId` 与 `browserName` 缺失，需用 `browserOauth` 关联 `getBrowserList`。据此 `StoreSessionService.ensure_store_session` 在"店铺运行中但本地缓存缺失"时优先从本响应重建附着记录（`_record_from_running_info`），避免 `startBrowser` 触发重启；字段不全时仍回退 `startBrowser`。`ziniao_store_sessions` 缓存表保留为快路径。

注意：样本仅一例（macOS、core_version 138.1.2.80）。若观察到其他版本字段缺失，`session.rebuild.incomplete` trace 事件会记录缺失项。
