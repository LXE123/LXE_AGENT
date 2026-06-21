# Skill Runtime Design Note

状态：Archive

本文是历史记录，不是当前运行时 skill 文档。当前 truth source 是 `/skills/*/SKILL.md`。

---

下面是对 skill 模块的设计与思考
- 用提示词暗示 llm 最好一次最多完整读取一个 skill.
- 最多150个skill进入挑选队列
- 在队列中的skill只带着标题和介绍让AI挑选
- 不允许同名 skill
- 不要对 skill 分级
- 触发条件主要靠 description

---

我再提一个 references，
references 是对 skill 的补充说明，附属资源，llm 可以按需调用。

Skill 的完整目录结构
skill-name/                     ← Skill 根目录
├── SKILL.md                    ← 必需：核心说明文件（触发时加载）
│   ├── YAML frontmatter        ← 元数据（始终在 context）
│   └── Markdown body           ← 指令（触发时加载）
│
├── references/                 ← 可选：参考资料（按需加载）
│   ├── advanced.md             ← 详细文档
│   ├── api-docs.md             ← API 参考
│   └── patterns.md             ← 模式指南
│
├── scripts/                    ← 可选：可执行脚本
│   └── helper.py
│
└── assets/                     ← 可选：资产文件
    └── template.html

三级加载系统
Level 1: Metadata (name + description) 
         └── 始终在 context (~100 words)
         
Level 2: SKILL.md body
         └── 触发时加载 (<5k words)
         
Level 3: Bundled resources (references/, scripts/, assets/)
         └── 按需加载 (references/ 通过 read 工具加载)

---

每个 skill 中都包含什么
- name # skill 名字
- description # skill 简介
- type # 类别
- content # 正文内容
- references # 引用

---

以什么角度出发，以什么理念为基础来设置skill架构
SKILL不是新功能，是“如何使用现有工具完成任务”的指导手册。
---
skill 文件的格式要固定
- name
- description（简短触发条件（1-2句），用于快速匹配）
- content（大概分为两部分，1. when to use 2. 如何执行）
- references（可选，主 SKILL 的扩展说明）
---
skill 未加载时，只会以 XML 格式存在于 system prompt 的 <available_skills> 区块中，格式如下，
- name
- description
- location
system prompt指导如何调用skill
```
## Skills (mandatory)

Before replying: scan <available_skills> <description> entries.
- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.
- If multiple could apply: choose the most specific one, then read/follow it.
- If none clearly apply: do not read any SKILL.md.
Constraints: never read more than one skill up front; only read after selecting.
- When a skill drives external API writes, assume rate limits: prefer fewer larger writes, avoid tight one-item loops, serialize bursts when possible, and respect 429/Retry-After.

{skillsPrompt}
```
skillsPrompt:
```xml
<available_skills>
  <skill>
    <name>github</name>
    <description>GitHub operations via gh CLI: issues, PRs, CI...</description>
    <location>~/.openclaw/skills/github/SKILL.md</location>
  </skill>
  <skill>
    <name>himalaya</name>
    <description>CLI to manage emails via IMAP/SMTP...</description>
    <location>~/.openclaw/skills/himalaya/SKILL.md</location>
  </skill>
</available_skills>
```
- 假设一次 turn 中多次 loop，那么一次 loop 理论上只会完整调用一个skill，随着循环上下文中会存在多个完整skill
- available_skills 中最多存在 150 个 skill
- 这 150 个 skill 介绍如何进入 prompt？
  1. 给每个 skill 加一个类别，第一批分类是，紫鸟浏览器，亚马逊店铺，默认
  2. 但现在因为 skill 很少，虽然分类了，但是不进行过滤，直接全放进来
---
如何读取完整的 skill，用 read 工具，
示例：
```json
加载前：
System Prompt
└── <available_skills>
    ├── name: github
    ├── description: GitHub operations...
    └── location: ~/skills/github/SKILL.md

模型调用 read 工具读取 ────────────────────────▶

加载后会作为 tool result 插入上下文的 messages 数组：

├── **Tool Result: SKILL.md 完整内容**  ← 在这里
│   └── # GitHub Skill
│       ## When to Use
│       ...
└── Assistant: 根据 skill 指导，我应该...
```


第一批SKILL，如下
1. 紫鸟webdriver的完整skill
2. 亚马逊店铺切换站点的skill
3. 目前半成品的亚马逊创建货件skill
4. 飞书官方skill（就是我刚才让你看的哪些“https://github.com/larksuite/openclaw-lark/tree/main/skills”）
5. 紫鸟店铺中的selenium操作skill

---

1. SKILL 的格式是什么？
skill-name/                     ← Skill 根目录
├── SKILL.md                    ← 必需：核心说明文件（触发时加载）
│   ├── YAML frontmatter        ← 元数据（始终在 context）
│   └── Markdown body           ← 指令（触发时加载）
│
├── references/                 ← 可选：参考资料（按需加载）
│   ├── advanced.md             ← 详细文档
│   ├── api-docs.md             ← API 参考
│   └── patterns.md             ← 模式指南
│
├── scripts/                    ← 可选：可执行脚本
│   └── helper.py
│
└── assets/                     ← 可选：资产文件
    └── template.html

2. skill 在上下文中的格式是什么？
未读取时：
<available_skills>
  <skill>
    <name>github</name>
    <description>GitHub operations via gh CLI...</description>
    <location>~/.openclaw/skills/github/SKILL.md</location>
  </skill>
</available_skills>

读取后完整内容会在 toolresult 中（用 read 工具读取）：
Tool Result
        └── {role: "toolResult", content: "PR #123..."}

3. 在上下文中未读取 SKILL 可以最多有多少个
150 个

4. 在主 SKILL 中，reference 怎么写
直接举例：
- **Form filling**: historical example path `references/FORMS.md`
- **API reference**: historical example path `references/REFERENCE.md`

5. 怎么读取 reference
通过系统提示词告诉 LLM：
"Use the read tool to load a skill's file when the task matches its name."
"When a skill file references a relative path, resolve it against the skill directory..."
