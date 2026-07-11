# Context Persistence

状态：Current

`session_transcripts/<session>.jsonl` 只追加 message 与 replacement/compaction checkpoint，不重写旧 transcript。replay cache 以文件 size/mtime 为签名；进程内 append/replacement 直接更新 cache，外部追加或删除自动失效。

JSONL 写入前会递归移除 base64 图片，当前 turn 内存仍保留原图。第一条真实用户输入生成 session title；maintenance/compaction summary 不参与 title。
