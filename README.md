## 关于本仓库
这个仓库是自己实现一个类似 open-claw 的 agent，可以实现其主要功能，能作为一个 agent 自主规划、执行任务。

## 技术栈
- 主要编程语言：**TypeScript**（项目涉及大量消息格式、工具 schema、API 响应等结构化数据，类型安全能显著减少 bug）

## 功能

### 基础能力（主链路）

1. [x] **Main Loop** — 规划-执行-观察循环，直到任务完成
   - 终止条件：任务完成、模型判断无法继续、用户中断
   - 异常处理：执行失败时重试或换策略，单次循环最大步数限制
2. [x] **Model IO + Prompt** — 调用大模型，管理提示词
   - Prompt 管理：使用模板和上下文构造提示词
   - Model 调用：发送 prompt，获取响应
   - 流式输出：支持 streaming
3. [x] **工具调用** — 脚本执行、文件读写等
   - 声明式工具注册：使用 JSON Schema 定义工具的参数和描述（类似 OpenAI function calling）
   - 工具发现：自动发现和注册可用工具
   - 内置工具：web_search、web_fetch、bash、file_read、file_write、file_edit、memory_save、memory_append、memory_list、skill_use、skill_list
4. [x] **History** — 历史消息管理
5. [x] **日志** — 方便排查问题
6. [x] **上下文压缩** — 长任务导致上下文溢出时自动压缩
7. [x] **配置管理** — 模型选择、API key、工具权限等配置的统一管理

### 高级能力

1. [x] **Memory** — 持久化记忆（工具驱动，读写 memory/*.md）
2. [x] **Skill** — 技能系统，支持可插拔的专项能力（skills/<name>/SKILL.md）
3. [x] **网关** — HTTP Gateway（SSE 流式 API、会话管理）
4. [x] **插件系统** — 内置/外部插件加载，路由注册，生命周期管理
5. [ ] **权限管理** — 可配置bash执行、文件读写等权限
6. [ ] **模式切换** — 可以以不同模式执行任务，比如 询问模式、自动模式、计划模式等。
7. [x] **飞书接入** — 飞书机器人（WebSocket 长连接模式）
8. [ ] **心跳** — 定时启动，执行定期任务
9. [ ] **Web UI** — 基于 Gateway 的前端界面
10. [ ] **RAG** — 检索增强生成


## 难点记录
1. 搜索问题：DuckDuckGo 虽然免费，但 Instant Answer API 本质不是搜索引擎，只能搜短英文实体关键词。Brave Search 是搜索引擎，但需绑定银行卡。SearXNG 需要自建服务器。当前默认 DuckDuckGo + 系统提示词约束模型使用简短关键词搜索。
2. 插件系统：官方 `@larksuite/openclaw-lark` 依赖 openclaw/plugin-sdk 的 18 个子模块，无法直接使用。当前实现了简化版插件系统和飞书插件（WebSocket 长连接），后续逐步兼容 openclaw 插件生态。