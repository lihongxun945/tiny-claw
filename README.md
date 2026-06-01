## 关于本仓库
这个仓库是自己实现一个类似 open-claw 的 agent，可以实现其主要功能，能作为一个 agent 自主规划、执行任务。

## 快速开始

### 安装

```bash
git clone https://github.com/lihongxun945/tiny-claw.git
cd tiny-claw
npm install
```

### 配置

复制配置模板并修改：

```bash
cp config.example.json workspace/config.json
```

`workspace/config.json` 必填字段：

```json
{
  "apiUrl": "https://ark.cn-beijing.volces.com/api/coding",
  "apiKey": "YOUR_API_KEY",
  "model": "glm-5.1",
  "modelProvider": "anthropic-messages"
}
```

`modelProvider` 用于选择模型协议适配器。当前支持：

| modelProvider | 协议 |
|---|---|
| `anthropic-messages` | Anthropic Messages API 兼容协议 |
| `openai-chat` / `chatgpt` | OpenAI Chat Completions 兼容协议 |

### Sub-agent 配置

`sub_agent_run` 工具支持一次并行启动多个临时子 agent。子 agent 默认只开放读取/检索类工具，不允许执行 shell、写文件或保存记忆。可在 `workspace/config.json` 中调整：

```json
{
  "subAgent": {
    "allowedTools": ["web_search", "web_fetch", "file_read", "memory_list", "memory_read", "memory_search", "skill_list", "skill_use"],
    "disabledTools": ["bash", "file_write", "file_edit", "memory_save", "memory_append", "memory_delete", "sub_agent_run"],
    "maxIterations": 3,
    "maxConcurrency": 3
  }
}
```

如果需要让子 agent 具备更多能力，可以把工具名加入 `allowedTools`，再确保不在 `disabledTools` 中。`sub_agent_run` 会始终被禁用，避免递归派生。

Sub-agent 提示词默认模板位于 `src/prompts/sub_agent.md`，可在工作目录放置 `workspace/sub_agent_prompt.md` 覆盖。支持占位符：`{{task}}`、`{{context}}`、`{{allowed_tools}}`、`{{current_date}}`。

### 会话摘要配置

`core-session-summary` 插件会为每个普通会话维护滚动摘要，模型调用时注入摘要并只保留最近几轮原文，避免历史消息持续膨胀：

```json
{
  "sessionSummary": {
    "enabled": true,
    "recentTurns": 3,
    "maxChars": 4000
  }
}
```

`sub:` 开头的临时 sub-agent 会话默认不生成摘要，避免额外消耗。

### Debug 模式

需要查看大模型调用的原始输入/输出时，可以在 `workspace/config.json` 中开启：

```json
{
  "debug": {
    "enabled": true,
    "modelIO": true,
    "rawStreamEvents": true
  }
}
```

开启后会写入 `workspace/logs/YYYY-MM-DD.log`，Web UI 的日志页也能看到：

- `model_request`：发送给模型的请求体，包括 system prompt、messages、tools
- `model_stream_event`：流式接口返回的原始 SSE JSON 事件
- `model_response`：非流式接口返回的原始 JSON
- `model_parsed_response`：tiny-claw 解析后的文本和工具调用
- `model_error`：模型接口错误响应

Debug 日志可能包含用户输入、工具结果和提示词内容，建议只在本地排查时开启。

### CLI 模式

```bash
npm start
```

启动后直接在终端与 Agent 对话，输入问题即可。

### Gateway 模式

```bash
npm run gateway -- --port 3000
```

启动 HTTP API 服务，支持外部客户端通过 SSE 流式调用 Agent：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /chat | 发送消息（SSE 流式响应） |
| GET | /sessions | 列出活跃会话 |
| DELETE | /sessions/:id | 销毁会话 |
| GET | /memory | 列出长期记忆 |
| PUT | /memory/:name | 更新长期记忆 |
| DELETE | /memory/:name | 删除长期记忆 |

POST /chat 请求示例：

```json
{ "message": "你好", "session_id": "optional" }
```

### 飞书机器人配置

1. **创建飞书自建应用** — 前往 [飞书开放平台](https://open.feishu.cn/app) 创建应用，获取 `App ID` 和 `App Secret`

2. **配置事件订阅** — 在应用后台 → 事件与回调：
   - 订阅方式选择 **长连接**
   - 添加事件 `im.message.receive_v1`（接收消息）

3. **开启机器人能力** — 在应用后台 → 应用能力 → 机器人，开启机器人能力

4. **配置权限** — 在应用后台 → 权限管理，添加以下权限：
   - `im:message` — 获取与发送消息
   - `im:message.reaction` — 消息表情

5. **发布应用** — 创建版本并发布

6. **修改配置文件** — 在 `workspace/config.json` 中添加飞书插件配置：

```json
{
  "enabledPlugins": ["feishu"],
  "plugins": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "verificationToken": "xxx"
    }
  }
}
```

7. **启动 Gateway** — 飞书插件会随 Gateway 自动启动 WebSocket 长连接：

```bash
npm run gateway -- --port 3000
```

启动后日志显示 `飞书长连接已建立` 即表示连接成功，可以在飞书中给机器人发消息测试。

## 插件开发

tiny-claw 采用插件化架构，所有业务逻辑由插件实现。框架通过 `PluginManager` 统一调度插件生命周期和钩子。

用户自定义插件只需放在 `workspace/plugins/<name>/index.ts`，启动时自动加载，无需修改配置。

插件开发详细文档请参考 [docs/plugin-development.md](docs/plugin-development.md)，包含：

- `Plugin` / `PluginContext` 接口说明
- 8 个生命周期钩子的触发时机和用途
- 快速创建插件的完整示例
- 注册工具、HTTP 路由的代码示例
- 配置读写方式
- 核心插件和飞书插件作为实战参考

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
   - 内置工具：web_search、web_fetch、bash、file_read、file_write、file_edit、memory_save、memory_append、memory_list、memory_read、memory_search、memory_delete、skill_use、skill_list、sub_agent_run
4. [x] **History** — 历史消息管理
5. [x] **日志** — 方便排查问题
6. [x] **上下文压缩** — 长任务导致上下文溢出时自动压缩
7. [x] **配置管理** — 模型选择、API key、工具权限等配置的统一管理
8. [ ] **聊天指令** 通过输入 /xxxx 执行指令，比如 /new_session 开启新session

### 高级能力

1. [x] **Memory** — 持久化记忆（工具驱动，读写 memory/*.md）
2. [x] **Skill** — 技能系统，支持可插拔的专项能力（skills/<name>/SKILL.md）
3. [x] **网关** — HTTP Gateway（SSE 流式 API、会话管理）
4. [x] **插件系统** — 内置/外部插件加载，路由注册，生命周期管理
5. [ ] **权限管理** — 可配置bash执行、文件读写等权限
6. [ ] **模式切换** — 可以以不同模式执行任务，比如 询问模式、自动模式、计划模式等。
7. [x] **飞书接入** — 飞书机器人（WebSocket 长连接模式）
8. [ ] **心跳** — 定时启动，执行定期任务
9. [x] **Web UI** — 基于 Gateway 的前端界面
10. [ ] **多Agent** - 多agent，互相隔离，不同的工作目录和上下文
11. [x] **SubAgent** - 并行执行子任务的临时 sub-agent，默认只读权限，可配置工具白名单/黑名单
12. [ ] **RAG** — 检索增强生成
13. [ ] **沙箱** — 通过沙箱执行脚本


## 难点记录
1. 搜索问题：默认使用 Ollama Web Search API，支持常规查询和网页摘要，需配置 `ollamaApiKey`。DuckDuckGo 保留为免配置兜底，但 Instant Answer API 本质不是完整搜索引擎，只适合简短英文实体关键词。Brave Search 需要 API key，SearXNG 需要自建服务器。
2. 插件系统：官方 `@larksuite/openclaw-lark` 依赖 openclaw/plugin-sdk 的 18 个子模块，无法直接使用。当前实现了简化版插件系统和飞书插件（WebSocket 长连接），后续逐步兼容 openclaw 插件生态。

## 与 Open-Claw 的对比

| 功能模块 | tiny-claw | open-claw |
|---------|-----------|-----------|
| **Agent Loop** | 自实现规划-执行-观察循环，`AgentSession` 管理多会话 | 内置 Loop 引擎，架构相似 |
| **Prompt 管理** | 手动构造 system prompt + `identity.md` 注入 | 内置 prompt 模板系统 |
| **工具系统** | `ToolRegistry` + JSON Schema 声明式注册，15 个内置工具 | Plugin SDK 驱动，工具通过插件注册 |
| **上下文压缩** | 模型摘要压缩，滑动窗口历史 | 有类似机制 |
| **Memory** | 工具驱动，文件存储 `memory/*.md` | 独立的 Memory 模块 |
| **Skill 系统** | `workspace/skills/<name>/SKILL.md` + frontmatter | 插件形式的技能系统 |
| **HTTP Gateway** | 自定义实现，SSE 流式 + 会话管理 | 内置 Gateway 模块 |
| **飞书接入** | 简化实现，直接使用 `@larksuiteoapi/node-sdk` WSClient | 官方 `@larksuite/openclaw-lark` 插件 |
| **插件系统** | 自定义 Plugin 接口 + 路由注册表，~100 行 | 完整 Plugin SDK，18 个子模块 |
| **权限沙箱** | 未实现 | 有 sandbox 模块 |
| **Web UI** | React + Vite 前端，基于 Gateway SSE | 有 Web UI |
| **RAG** | 未实现 | RAG 模块 |
| **代码规模** | ~20 个源文件，轻量聚焦 | 企业级，功能全面 |
| **外部依赖** | 极少（仅 `@larksuiteoapi/node-sdk`） | 重型（Plugin SDK 等） |
| **模型支持** | 兼容 Anthropic Messages API（可对接火山方舟等） | Anthropic Messages API |
| **多租户** | `AgentSession` + `session_id` 隔离 | Session 管理 |

### 设计哲学差异

- **tiny-claw** 追求极简——零运行时依赖、核心逻辑自实现、代码量小、易于理解和修改。适合学习、个人项目或定制化场景。
- **open-claw** 追求企业级完备性——丰富的插件生态、完善的权限管理、开箱即用的多平台支持。适合团队协作、生产环境部署。
- **插件兼容**：当前插件系统为简化自实现，后续计划逐步兼容 open-claw 的插件规范，最终能复用其插件生态。
