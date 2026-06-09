和 LLM 模型的供应商对接时，有一些字段是根据不同供应商有着不同的值，现在需要根据 这些 provider 去维护这些值，一个 provider 一个文件。

比如
base_url
model
support_vision
default_max_tokens

--- 

我决定模仿 openclaw 的做法：
```text
auth profile
= 凭据/登录态
= API key、OAuth token、profile id、过期/刷新信息

model/provider config 或 modelCatalog
= 模型能力元数据
= contextWindow、contextTokens、maxTokens、input、cost、compat、baseUrl、api
```
分成两类，一类存 凭据/登录态，模型能力元数据