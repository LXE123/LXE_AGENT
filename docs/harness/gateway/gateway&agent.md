20260330
- 现在第一件事，gateway 和 agent 之间应该是什么关系？
1. gateway 管理从所有渠道来的信息，那么 agent 发出的信息呢？
agent负责什么
-循环中自我上下文管理
-skill调用
-tool调用
这里有一些很重要的问题。
比如用户要求 agent 发送一个文件，这个文件该不该经过 gateway？
agent 在循环过程中需要发送网络请求，该不该经过 gateway？
到底 agent 发出的什么东西，要经过gateway？
飞书和钉钉都直接经过 API 发送信息给用户。gateway 在其中该扮演什么角色？

可以肯定 gateway 负责转发渠道来的信息，可转发后 gateway 又该负责什么？

2. 如果 gateway 关闭了，agent 还有任何存在的必要吗？我认为没有，因为 agent 没有 gateway 就无法接收和发送任何信息，我看不到 agent 离开了 gateway 还有任何存在的必要。
3. gateway 必须清楚明白了解 agent 的行为和状况，gateway 对于 agent 来说是主导关系，应该完全掌控着 agent 的生死。

4. gateway 和 woker 之间的契约是什么，换一句话说 gateway 和 woker 之间要沟通什么信息。先说一些确定的字段
- 平台
- 用户id
- 会话id
- 是否是群聊
- 用户 msg
其它的呢，比如说目前架构有一个队列，里面排列着任务。也就是说 gateway 还要给这个信息打包成 job，于是还要添加 job 的字段
- job id

---

正式版：
以什么角度出发，以什么理念为基础 gateway 应该控制队列，应该掌握agent
1. 渠道的入站信息需要 gateway 统一管理，
2. gateway 负责把渠道数据标准化并路由，发到 job 队列中。
3. gateway 完全控制队列，队列是简单的 asyncio.Queue（FIFO），一次可以执行多个任务(多个任务"指的是不同用户的任务并发,按 session 串行消费，不同 session 间并行，所以还会有一个 session scheduler)，任务跑完后踢出队列。
4. gateway 负责启动 agent，如果 gateway 关闭，agent 也会立即关闭
5. gateway 拿到信息后，根据 用户id 和 会话id 和 平台 和 connector_key（对应bot的型号） 来创建 session 或者进入已存在的 session。
6. gateway 把各个平台渠道作为插件管理，当 agent 准备好回复信息时，准备好格式化的参数通过 IPC 发送给 gateway，gateway 调用对应的 channel 插件
agent模式更新卡片暂时不考虑
7. agent 负责上下文管理，TOOL 筛选和调用，SKILL 筛选和调用
8. agent 循环过程中，操作浏览器，读取本地文件，模型调用，skill/tool内部执行过程，gateway 不管理。
9. agent 和 gateway 是双进程，其中以 gateway 为主。

关于第 6 条，agent 是怎么让 gateway 上的 channel 插件发送消息的。
我认为我们得很认真的思考，agent和gateway之间究竟用什么字段进行沟通，agent 和 gateway 又有几种发送消息的方式。

总结起来就是，用 5 个字段沟通
1. session_id # 看到 session_id, gateway 就会知道发往哪个平台哪个对话
2. content  # llm 生成的文本内容
3. files   # 媒体文件本地路径列表，可为空
4. emit_kind # 三种发送路径的显式标记：final，tool，progress
5. emit_id # 每条发送的唯一 id，用于日志、排重、追踪

agent 有三种发送消息的路径
1. 循环正常结束发送
2. 循环中调用 message tool 立即发送。（专门为媒体文件准备）
3. 进度回调 思考/工具提示，当然我们现在暂时不支持更新卡片，所以只是列出来暂时不需要关心
这三种路径都通过刚才列出的五个字段与 gateway 沟通

---

问题答疑：
1. agent 怎么接任务？
gateway 会维护一个队列，Gateway 根据 session 串行消费，不同 session 间并行的原则安排 agent 执行任务

2. 文本消息和媒体消息两条路径的触发时机：

文本消息（例子1）：agent 循环结束时，通知 gateway 发送总结信息
媒体消息（例子2）：agent 循环过程中主动调用 message tool 通知 gateway 发送

3. 媒体文件为什么要在循环过程中发送？
因为媒体文件是 tool 执行的产物，只有在循环中才存在。

---

scheduler 的运作机制是什么
首先核心理念：按 session 串行消费，不同 session 间并行
也就是说，用户的每一条消息进入 gateway，都要经过 scheduler，
scheduler 会对这些信息做什么？
1. 读取 用户id 和 会话id 和 平台 和 connector_key，命中或创建一个 session id
2. 发送该 session 到队列中，让 agent 开始任务

---

为了保证用户体验，必须再增加一个进度提醒，
我对这个进度提醒的思考是这样的，在发送

---

为了引入流式响应，需要对 agent 和 gateway 的协议做一些修改

首先明确一点，需要流式传送的是什么，只有文本需要。
总不可能流式传送一张图片，一个pdf等等之类的文件

然后，为了保证顺序，每次发送的都是积累起来的完整文本。示例如下：
// 第 1 次 delta（收到"你"）
{ "state": "delta", "message": { "content": [{ "text": "你" }] } }
// 第 2 次 delta（收到"好"）
{ "state": "delta", "message": { "content": [{ "text": "你好" }] } }
// 第 3 次 delta（收到"世界"）
{ "state": "delta", "message": { "content": [{ "text": "你好世界" }] } }

然后，为了防止丢包，还要给每次流式传输增加一个 seq 序号，如果说从 1 直接跳到 3，说明丢包

然后还要明确的发送时间段间隔，比如 150ms，每发送一次数据块后至少等待 150ms 后才发送下一次

---

飞书接收和发送流式数据代码参考

## 飞书 CardKit 的工作原理

从代码注释可以看到：

```typescript
/**
 * Stream text content to a specific card element using the CardKit API.
 *
 * The card automatically diffs the new content against the previous
 * content and renders incremental changes with a typewriter animation.
 *
 * @param params.content   - The full cumulative text (not a delta).
 */
export async function streamCardContent(params: {
  cardId: string;
  elementId: string;
  content: string;    // ← 传入完整累积文本
  sequence: number;   // ← 递增序列号保证顺序
}): Promise<void>;
```

**关键点**：`content` 参数要求传入**完整累积文本**（cumulative text），而不是增量（delta）。飞书服务端会自动做 diff，只渲染新增部分，并产生打字机动画效果。

## 你提供的数据格式完全匹配

你的数据格式：
```
第1次: "你"
第2次: "你好"
第3次: "你好世界"
```

正好符合 `streamCardContent` 的调用序列：

```typescript
// 第 1 次 delta
await streamCardContent({
  cardId: 'card_xxx',
  elementId: 'streaming_content',
  content: '你',           // ← 完整文本
  sequence: 1,             // ← 递增
});

// 第 2 次 delta
await streamCardContent({
  cardId: 'card_xxx',
  elementId: 'streaming_content',
  content: '你好',         // ← 完整文本
  sequence: 2,
});

// 第 3 次 delta
await streamCardContent({
  cardId: 'card_xxx',
  elementId: 'streaming_content',
  content: '你好世界',     // ← 完整文本
  sequence: 3,
});
```

## 实现建议

1. **节流控制**：不要每次 delta 都调用 API，建议 100ms 节流
2. **序列号递增**：每次调用 `sequence` 必须 +1
3. **Markdown 优化**：建议先调用 `optimizeMarkdownStyle(content)` 再发送

```typescript
// 伪代码示例
let sequence = 1;
let lastUpdateTime = 0;
const THROTTLE_MS = 100;

async function onDelta(cumulativeText: string) {
  const now = Date.now();
  
  // 节流控制
  if (now - lastUpdateTime < THROTTLE_MS) {
    // 延迟发送
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => doUpdate(cumulativeText), THROTTLE_MS);
    return;
  }
  
  await doUpdate(cumulativeText);
}

async function doUpdate(text: string) {
  await streamCardContent({
    cardId: cardKitCardId,
    elementId: 'streaming_content',  // 对应卡片中 element_id
    content: optimizeMarkdownStyle(text),  // 优化 markdown 样式
    sequence: sequence++,
  });
  lastUpdateTime = Date.now();
}
```

---

## 1. `streamCardContent` 代码

```typescript
/**
 * Stream text content to a specific card element using the CardKit API.
 *
 * The card automatically diffs the new content against the previous
 * content and renders incremental changes with a typewriter animation.
 *
 * @param params.cardId    - CardKit card ID (from `convertMessageToCardId`).
 * @param params.elementId - The element ID to update (e.g. `STREAMING_ELEMENT_ID`).
 * @param params.content   - The full cumulative text (not a delta).
 * @param params.sequence  - Monotonically increasing sequence number.
 */
export async function streamCardContent(params: {
  cfg: ClawdbotConfig;
  cardId: string;
  elementId: string;
  content: string;
  sequence: number;
  accountId?: string;
}): Promise<void> {
  const { cfg, cardId, elementId, content, sequence, accountId } = params;

  const client = LarkClient.fromCfg(cfg, accountId).sdk;

  // SDK 返回类型不完整，运行时包含 code/msg 字段
  const resp = (await client.cardkit.v1.cardElement.content({
    data: { content, sequence },
    path: { card_id: cardId, element_id: elementId },
  })) as CardKitResponse;
  logCardKitResponse({
    resp,
    api: 'cardElement.content',
    context: `seq=${sequence}, contentLen=${content.length}`,
  });
}
```

调用的是飞书 SDK 的 `client.cardkit.v1.cardElement.content()` 方法。

---

## 2. `optimizeMarkdownStyle` 代码

位于 `src/card/markdown-style.ts`：

```typescript
/**
 * 优化 Markdown 样式：
 * - 标题降级：H1 → H4，H2~H6 → H5
 * - 表格前后增加段落间距
 * - 有序列表：序号后确保只有一个空格
 * - 无序列表："- " 格式规范化（跳过分隔线 ---）
 * - 表格：单元格前后补空格，分隔符行规范化，表格前后加空行
 * - 代码块内容不受影响
 */
export function optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  try {
    let r = _optimizeMarkdownStyle(text, cardVersion);
    r = stripInvalidImageKeys(r);
    return r;
  } catch {
    return text;
  }
}

function _optimizeMarkdownStyle(text: string, cardVersion = 2): string {
  // ── 1. 提取代码块，用占位符保护，处理后再还原 ─────────────────────
  const MARK = '___CB_';
  const codeBlocks: string[] = [];
  let r = text.replace(/```[\s\S]*?```/g, (m) => {
    return `${MARK}${codeBlocks.push(m) - 1}___`;
  });

  // ── 2. 标题降级 ────────────────────────────────────────────────────
  // 只有当原文档包含 h1~h3 标题时才执行降级
  const hasH1toH3 = /^#{1,3} /m.test(text);
  if (hasH1toH3) {
    r = r.replace(/^#{2,6} (.+)$/gm, '##### $1'); // H2~H6 → H5
    r = r.replace(/^# (.+)$/gm, '#### $1');       // H1 → H4
  }

  if (cardVersion >= 2) {
    // ── 3. 连续标题间增加段落间距 ───────────────────────────────────────
    r = r.replace(/^(#{4,5} .+)\n{1,2}(#{4,5} )/gm, '$1\n<br>\n$2');

    // ── 4. 表格前后增加段落间距 ─────────────────────────────────────────
    // 4a. 非表格行直接跟表格行时，先补一个空行
    r = r.replace(/^([^|\n].*)\n(\|.+\|)/gm, '$1\n\n$2');
    // 4b. 表格前：在空行之前插入 <br>
    r = r.replace(/\n\n((?:\|.+\|[^\S\n]*\n?)+)/g, '\n\n<br>\n\n$1');
    // 4c. 表格后追加 <br>
    r = r.replace(/((?:^\|.+\|[^\S\n]*\n?)+)/gm, (m, _table, offset) => {
      const after = r.slice(offset + m.length).replace(/^\n+/, '');
      if (!after || /^(---|#{4,5} |\*\*)/.test(after)) return m;
      return m + '\n<br>\n';
    });
    
    // ── 5. 还原代码块，并在前后追加 <br> ──────────────────────────────
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, `\n<br>\n${block}\n<br>\n`);
    });
  } else {
    // 还原代码块（无 <br>）
    codeBlocks.forEach((block, i) => {
      r = r.replace(`${MARK}${i}___`, block);
    });
  }

  // ── 6. 压缩多余空行（3 个以上连续换行 → 2 个）────────────────────
  r = r.replace(/\n{3,}/g, '\n\n');

  return r;
}

/**
 * 过滤无效的图片 key：只保留 img_xxx 格式的飞书图片 key
 * HTTP URL 会被过滤掉（防止 CardKit error 200570）
 */
function stripInvalidImageKeys(text: string): string {
  if (!text.includes('![')) return text;
  return text.replace(IMAGE_RE, (fullMatch, _alt, value) => {
    if (value.startsWith('img_')) return fullMatch;
    return ''; // 过滤非 img_ 的图片引用
  });
}
```

---

## 功能总结

| 函数 | 主要功能 |
|------|----------|
| `streamCardContent` | 调用飞书 CardKit API，将**完整累积文本**发送到指定卡片元素，实现打字机效果 |
| `optimizeMarkdownStyle` | 预处理 markdown：<br>1. 标题降级（避免 H1 太大）<br>2. 表格/代码块前后加间距<br>3. 过滤无效图片 URL |

---

20260403

为了单人本地使用版本的 agent，我必须对目前 gateway 和 agent 之间的链接关系进行修改。
1. 这个agent只会绑定单个平台的单个 bot。
2. 如果在单个平台的不同群聊发消息，当成同一个用户做排队处理。接收消息时把 platform + chat_type + chat_id 存起来作为回复路径

---

我决定把这个项目改成一个单进程项目，在该进程内，多个线程相互协作。
gateway 会天然自带一个主线程，
这个主线程是做什么的？
大概如下
1. 管理一个 event_loop
2. 启动各个平台的 adapter (比如飞书)
3. 创建和管理 asyncio task 
- asyncio task 会创建专门用来运行 agent 的线程
- asyncio task 
4. 管理后台任务
5. 管理流式传输（agent 发送请求给大模型时生成的流式事件）