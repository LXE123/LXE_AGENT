# Context Persistence

状态：Current

## 目的

这篇文档解释一次 turn 中临时产生的上下文，为什么以及如何变成长期 message history。读者如果想理解历史消息为什么不是每个 step 都立刻落盘、tool call 和 tool result 为什么必须闭合、JSONL 和 SQLite 各自保存什么，应该读这一篇。

## 设计理念

Context persistence 的核心取舍是把“正在执行的一轮临时上下文”和“下一轮可以信任的长期历史”分开治理。turn 内的消息还可能继续变化：模型可能继续调用工具，工具可能成功、失败或被取消，上下文也可能因为过大而被压缩。只有当 turn 到达清晰边界后，runtime 才把允许保留的消息合并进长期历史。

## 链路位置

这一层位于 [Context Assembly](context_assembly.md) 和 turn 结束后的 session storage 之间。turn 开始时，历史 message history 被读入 runtime；turn 执行中，新消息先留在本轮临时上下文；turn 结束后，runtime 把闭合后的消息合并进长期 history，再交给 storage 层保存。message 的基础格式见 [Canonical Message 与 Context State](canonical_message.md)，长期历史体积治理见 [上下文裁剪与压缩实现细节](context_pruning_compaction.md)。

## 总览

上下文持久化可以按六个阶段理解：先读取上一轮留下的长期历史；再在本轮内临时累积用户输入、模型输出和工具结果；然后确认工具调用链条已经闭合；turn 结束时把本轮可保留消息合并进长期 history；合并后再做压缩和历史长度治理；最后把 message history 和 session metadata 分别交给各自的存储边界。

这套设计不是事件日志系统。它不把每个 step、每个流式片段、每个中间状态都当作独立持久化事件，而是把 turn 视为一次上下文更新的自然边界。

## 历史读取

### 目的

历史读取阶段让本轮 turn 能继承上一轮结束时留下的长期 message history。没有这一步，模型只能看到当前输入，无法理解之前的对话、工具观察和已压缩摘要。

### 设计理念

长期历史只保存模型下一轮真正需要理解的对话材料，而不是保存所有运行时控制态。这样 context 可以专注于“模型应当看到什么”，session metadata、metrics、路由信息和其它控制数据则留在更适合它们的存储位置。

### 发生事件

turn 开始时，runtime 会取回这个 session 的历史消息，并把它们作为本轮上下文的基础。读取出来的历史会被清洗成 canonical message 形态，确保后续组装、工具结果闭合和 provider 适配都基于同一种消息语言。

如果历史中已经包含压缩摘要、旧的工具观察或之前的 assistant 输出，它们会以长期 history 的身份参与本轮上下文组装。当前用户输入不会直接写进长期 history，而是先进入本轮临时上下文。

## 本轮临时累积

### 目的

本轮临时累积阶段保存 turn 内不断增长的上下文：用户输入、模型文本、tool call、tool result 和可能出现的错误观察。它的目的，是让同一个 turn 内的后续 step 能看到前面 step 刚产生的结果。

### 设计理念

turn 内上下文不急着落盘，是因为它还没有稳定。一个 tool call 写出来之后，后面必须跟着成功、失败或取消结果；一个工具结果回来之后，模型可能还会继续推理；一次 context overflow 可能导致旧历史被压缩。把这些中间状态先留在内存里，可以避免把半截工具链或临时失败状态过早写成长期历史。

### 发生事件

本轮开始时，当前用户输入会加入临时上下文。模型每次产生文本或提出工具调用，runtime 会把这些结果追加到临时上下文里。工具执行完成后，观察结果也会追加进去，供下一次 step 使用。

这个阶段的关键点是：临时上下文既服务于当前 turn 后续 step，也为 turn 结束后的长期保存做准备。但它在 turn 结束前还不是最终历史。

## 闭合检查

### 目的

闭合检查保证长期 history 中不会留下只有 tool call、没有 tool result 的半截对话。这样的历史一旦进入下一轮模型请求，会让 provider 和模型都难以判断这次工具调用是否已经完成。

### 设计理念

工具调用是一种成对结构：模型提出 tool call，runtime 返回 tool result。成功结果、失败结果和取消结果都可以被保存；真正不能保存的是“不知道这个工具后来发生了什么”。因此 runtime 更重视闭合性，而不是只保存成功路径。

### 发生事件

当模型提出工具调用后，runtime 会把这个意图保留在本轮临时上下文里。随后工具执行会产生结果，结果会和前面的调用对应起来。

如果 turn 在工具完成前被取消，runtime 会补一个 synthetic cancel 结果，说明这次工具没有机会完成。这样长期 history 仍然能表达完整事实：模型曾经请求过工具，但执行被中断。

只有闭合后的消息才适合进入长期 history。这个边界也是 context persistence 和 tool execution 之间最重要的衔接点。

## Turn 后合并

### 目的

Turn 后合并阶段把本轮允许保留的临时消息并入长期 message history。它让下一次 turn 能看到本轮用户输入、模型输出、工具观察和必要的错误说明。

### 设计理念

持久化以 turn 为边界，而不是以 step 为边界。step 是模型和工具的内部节拍，可能产生很多中间动作；turn 才是一次用户请求或后台唤醒被 runtime 处理完的完整单位。以 turn 为边界保存，可以让长期 history 更接近可理解的对话，而不是碎片化的事件流。

### 发生事件

当 turn 正常完成或以错误结束时，本轮临时上下文会作为一个完整片段合并进长期 history。这样即使结果是错误，下一轮仍能看到它为什么失败。

当 turn 被取消时，runtime 只保留取消前已经闭合、允许持久化的消息。没有闭合的部分会先被补成可解释结果，再进入长期 history；不适合保留的临时状态不会直接落到长期历史里。

## 长期治理

### 目的

长期治理阶段避免 message history 在多轮之后无限增长。它负责把已经合并进历史的内容整理到可持续的体积，而不是改变当前 turn 的执行结果。

### 设计理念

runtime 先合并本轮消息，再治理长期历史，是为了保证本轮事实先完整进入历史，然后再由压缩和历史长度策略决定旧内容如何保留。这样不会因为过早裁剪而丢失当前 turn 的工具链条，也不会让旧历史长期挤占上下文预算。

### 发生事件

本轮消息合并后，runtime 会评估长期 history 是否过大。如果历史已经接近模型能承受的范围，旧内容会被压缩成摘要，较新的内容尽量保留原文。

随后还会根据会话类型和平台规则限制长期历史长度。这个阶段治理的是下一轮会看到的 history，而不是当前 turn 内已经完成的推理过程。

长期压缩、历史轮数限制和上下文预算治理见 [上下文裁剪与压缩实现细节](context_pruning_compaction.md)。

## 落盘边界

### 目的

落盘边界明确哪些数据属于 message history，哪些数据属于 session metadata。这样上下文存储不会和会话统计、模型信息、路由信息混在一起。

### 设计理念

JSONL 保存的是 canonical message history，SQLite 保存的是 session metadata、metrics、model 等会话状态。这样的拆分让长文本历史可以独立管理，也让 session row 保持轻量。JSONL 在这里表达的是当前长期历史快照，不是 append-only event log。

### 发生事件

当 turn 后治理完成，runtime 会把最终 message history 交给 JSONL 存储。这个保存动作代表“下一轮应该看到的历史现在是什么”，而不是“刚刚发生了哪一个事件”。

SQLite 侧保存 session 的统计和元信息，例如消息数量、调用计数、token 统计、模型信息和标题候选。它不承担保存完整对话内容的职责。

因此排查上下文时，应先区分两个问题：如果想知道模型下一轮会看到什么，看 message history；如果想知道 session 的状态、指标和生命周期，看 SQLite metadata。
