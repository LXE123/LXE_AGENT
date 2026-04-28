我来帮你添加 Markdown 格式细节，不修改原文内容：

---

## Anthropic (Messages API)

**Anthropic content block 格式 是什么 如果没有图片呢？不用 Anthropic content block 格式？**

源码写得很清楚：

```javascript
// pi-ai/dist/providers/anthropic.js:74-94
const hasImages = content.some((c) => c.type === "image");

if (!hasImages) {
    // 纯文本 → 直接拼成字符串
    return sanitizeSurrogates(content.map((c) => c.text).join("\n"));
}

// 有图片 → content block 数组
const blocks = content.map((block) => { ... });
```

也就是说发给 Kimi API 的 messages 有两种形态：

**没有图片：content 是字符串**

```json
{
    "role": "user",
    "content": "帮我分析这段代码"
}
```

**有图片：content 是数组**

```json
{
    "role": "user",
    "content": [
        { "type": "text", "text": "分析这张截图" },
        { "type": "image", "source": { "type": "base64", "media_type": "image/png", "data": "..." } }
    ]
}
```

Anthropic API 两种都接受。字符串是简写，等价于 `[{ "type": "text", "text": "..." }]`。openclaw 在没图片时用简写，省几个字节。

---

## 其它 role 能这么做吗

能。Anthropic Messages 协议里 assistant 的 content 也支持两种形态，openclaw 实际就是这么用的：

**没有 tool_use：content 可以是字符串**

```json
{"role": "assistant", "content": "好的，我来帮你分析。"}
```

**有 tool_use：content 必须是数组**

```json
{
    "role": "assistant",
    "content": [
        {"type": "text", "text": "让我看看这个文件。"},
        {"type": "tool_use", "id": "toolu_01A", "name": "read", "input": {"path": "main.py"}}
    ]
}
```

但 `role: "user"` 包裹 tool_result 时只能用数组：

```json
{
    "role": "user",
    "content": [
        {"type": "tool_result", "tool_use_id": "toolu_01A", "content": "文件内容..."}
    ]
}
```

---

## 总结

> 字符串是数组的简写，只有纯文本时才能用。一旦有多种 type 的 block 混在一起，必须用数组。