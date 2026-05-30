为了更好的展示该 agent，我决定做出一个网页来展示。
---
这个网站如何设计呢？
首先首页是很多 agent 的集中简介（有该 agent 的头像，有几句话简单介绍），可以点击，会进入到 agent 的具体介绍页面。
---
进入到 agent 的具体介绍页面后，可以看到该 agent 的 tool 和 skill，每个 tool 和 skill 都会有一个图标和一段简介，可点击，会有具体介绍，我不确定是该打开新页面，还是会有一个弹窗介绍。
---
还有一个很重要的，每个单独 agent 的使用情况也该展示，分成天/周/月，展示该 agent 的调用情况和 token 消耗数量。然后还有就是该 agent 的健康状态，是否开启。
---

agent 可视化设想
---
首页是 Agent 列表页，集中展示多个 Agent
---
点击某个 Agent 后进入 Agent 详情页。
---
详情页核心内容包括三部分：
  Tool 和 Skill 展示
 每个 Tool / Skill 用卡片展示，包含图标、名称和简短说明。点击后可以用弹窗展示更详细信息，不必跳转新页面，浏览效率更高。 
 使用情况分析
 展示该 Agent 的调用次数、Token 消耗、平均响应时间、成功率等指标。支持按天、周、月切换，并用折线图或面积图展示趋势。 
健康状态和活动记录
 展示 Agent 的健康评分、响应时间、错误率、成功率、在线状态，以及最近调用过哪些工具或技能。
 ---

# Agent 自带前端网页 UI 设计

## 这个网页可以展示什么
1. session 会话
记录会话，按更新时间（也就是最后一次发言）排序，降序
有一种情况要注意，用户使用了 /clear，上下文就被清除了，那么这些被清除的上下文就应该直接归档成一个会话记录。
2. models 模型
展示使用什么模型，以及什么供应商
4. Skill 和 tool
可以看到有什么 skill 和 tool，并且可以看到详细介绍

## 美术风格


## 技术栈
react

## 逻辑
问：这个前端页面具体该怎么和 harness 框架交互呢？
答：通过 fast-api 查询或修改 harness 框架中的数据。
问：为什么要用 fast-api ？
答：react 本身作为前端页面组件天生就是适配这种前后端交流的情况的，而且这样也不用单独写一套 react 读写本地文件的逻辑。FastAPI 负责读取数据库、配置、日志、后台任务状态，并调用 harness 框架内部能力。
问：第一批 API 有哪些
答：如下
session 列表：GET /api/sessions?limit=&offset=  // 获取历史会话列表
session 删除：DELETE /api/sessions/{id} // 删除会话记录
skill 列表：GET /api/skills // 获取技能列表、分类、启用状态
toolset 列表：GET /api/tools/toolsets	// 获取工具集、启用状态、包含哪些 tool
model 列表：GET /api/models // 获取 model 列表
model 当前使用: GET /api/models/current // 获取当前使用的 model