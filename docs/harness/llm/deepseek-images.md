# DeepSeek 图片请求

仅 `deepseek`、Responses 协议且支持视觉的路线启用 Files API。图片仍按现有规则预处理；发送前把历史图片逐张上传为 `purpose=user_data`，模型请求中改用 `input_image.file_id`。因此从其他供应商切换过来时，即使 Base64 历史超过 50 MB，也先上传、替换引用，再发送模型请求。

- 运行时共享 `<dataRoot>/cache/deepseek-files.json`，按接口地址、有效认证头的哈希和实际图片字节/MIME 的哈希隔离。索引不保存明文凭证和图片 Base64。文件锁与原子替换保护并发更新；损坏的索引记录实际错误后重建。
- 远端文件有效期为 7 天，剩余不足 1 小时不再复用。写入时清理过期及临近过期映射；服务端明确拒绝旧 `file_id` 时按实际使用的映射失效，最多重传并重试一次。不会因配额不足主动删除远端文件。
- 文件模式限制为 128 MiB 图片原始字节、600 次图片出现；Files 失败后整次请求回退到 Base64，总量限制为 20 MiB。超预算从最旧图片开始省略，按 64 MiB / 10 MiB / 20 张批量释放空间。同一图片重复出现时，上传可复用，预算逐次计入。
- 省略只作用于当前 DeepSeek 请求，切换供应商不继承它。需要恢复路径时，把准确的历史图片副本原子保存到 `<dataRoot>/cache/deepseek-images/`；不依赖可能已覆盖的截图原路径。恢复副本不随远端 `file_id` 过期而删除，可手动清理缓存；transcript 中的原图仍在。
- 最终按 UTF-8 JSON 校验完整请求体的 48 MiB 上限。文字和工具历史本身过大时明确失败；413 不作为 token 上下文溢出或普通可重试错误。上传有独立 60 秒期限，模型空闲超时从上传结束后开始。

transcript 继续保存原始 Base64，保持历史回放和跨供应商兼容；此优化减少网络请求体，不缩小 transcript。图片省略后的 usage 不用于校准完整共享历史的 token 估算。旧文件重试有独立的物理请求 trace，原始失败诊断保留并按日志规则脱敏。


## 实现与验证入口

- [请求投影](../../../packages/agent/runtime/src/providers/deepseek-image-request.ts)、[Files 上传](../../../packages/agent/runtime/src/providers/deepseek-files.ts)和[上传索引](../../../packages/agent/runtime/src/providers/deepseek-upload-index.ts)。
- [协议与图片测试](../../../packages/agent/runtime/test/providers/deepseek-images.test.ts)。
- 共享历史的保存规则见 [图片持久化](../runtime/context/context_persistence.md#图片与敏感数据)，协议总览见 [LLM 适配](README.md)。
