# tiny-claw 架构文档

## 项目目标

构建一个自主规划、执行任务的 Agent，类似 OpenClaw。用户输入任务后，Agent 通过规划-执行-观察循环自主完成。

## 开发路线

```
基础能力（主链路）：  Loop → Model IO + Prompt → 工具调用 → History → 上下文压缩 → 配置管理
高级能力：           Memory → Skill → 聊天工具(飞书/钉钉) → RAG
```

当前进度：已完成 Loop、Model IO + Prompt、工具调用、History、上下文压缩、配置管理、Memory、Skill、Gateway、飞书接入。

## 模块结构

```
src/
├── index.ts          # CLI 入口（使用 AgentSession）
├── gateway.ts        # HTTP Gateway（SSE 流式 API + 插件路由注册表）
├── agent.ts          # AgentSession 类（核心 Agent Loop）
├── config.ts         # 配置加载（从 workspace 读取）
├── client.ts         # Anthropic Messages API 客户端（流式）
├── history.ts        # 滑动窗口消息历史
├── compress.ts       # 上下文压缩（模型摘要）
├── estimate-tokens.ts # Token 估算（触发压缩）
├── types.ts          # 共享类型定义
├── plugins/          # 插件系统
│   ├── types.ts      # Plugin、PluginContext、RouteDefinition 接口
│   ├── loader.ts     # 插件加载器（内置/外部）
│   └── feishu/       # 飞书插件
│       ├── index.ts  # 插件入口（注册路由）
│       ├── client.ts # FeishuClient（token 缓存、消息发送/回复）
│       └── handler.ts # 事件处理（验证、消息解析、异步回复）
├── prompts/          # 系统提示词模板
│   ├── default.md    # 默认模板（含 {{placeholder}} 占位符）
│   └── build.ts      # 模板加载 + buildSystemPrompt()
├── tools/            # 工具实现
│   ├── registry.ts   # 工具注册中心
│   ├── search.ts     # 网络搜索（多 provider：SearXNG/Brave/DuckDuckGo）
│   ├── web_fetch.ts  # 网页内容获取
│   ├── bash.ts       # Shell 命令执行
│   ├── file_read.ts  # 文件读取
│   ├── file_write.ts # 文件写入
│   ├── file_edit.ts  # 文件精确替换
│   ├── memory.ts     # 持久化记忆（读写 memory/*.md）
│   └── skill.ts      # 技能系统（加载/激活 skills/*.md）
└── workspace/        # 工作目录相关
    ├── workspace.ts  # 目录初始化、身份加载
    └── logger.ts     # 追加式文件日志（history + 执行日志）
web/                    # Web UI（React + Vite）
├── src/
│   ├── lib/           # SSE 客户端、API 封装
│   └── components/    # UI 组件
├── dist/              # 构建产物（Gateway 直接服务）
└── package.json       # 前端独立依赖
```

## 工作目录结构

tiny-claw 运行时需要一个工作目录（workspace），所有持久化数据都放在其中。工作目录路径通过 `--workspace` CLI 参数或 `TINY_CLAW_WORKSPACE` 环境变量指定，默认为 `./workspace`。

```
workspace/
├── config.json        # 配置（API key、模型、工具权限等）
├── identity.md        # 身份设定（注入 system prompt 模板 {{identity}} 占位符）
├── system_prompt.md   # 可选：自定义 system prompt 模板（不存在则使用默认模板）
├── skills/            # 自定义技能（skills/<name>/SKILL.md）
├── memory/            # 跨会话长期记忆（TODO: 分层记忆系统）
├── history/           # 对话历史持久化，JSONL 格式，每日轮转
│   └── 2026-05-19.jsonl
└── logs/              # 执行日志，[时间] [级别] 消息，每日轮转
    └── 2026-05-19.log
```

### config.json

| 字段 | 说明 | 默认值 |
|------|------|--------|
| apiUrl | API 基础地址 | 必填 |
| apiKey | API 密钥 | 必填 |
| model | 模型标识 | 必填 |
| maxTokens | 单次响应最大 token | 4096 |
| maxContextTokens | 上下文最大 token 估计 | 128000 |
| contextCompressionThreshold | 压缩触发阈值（占比） | 0.7 |
| historyWindowSize | 历史窗口（轮） | 5 |
| maxAgentIterations | Agent Loop 最大迭代次数 | 0（不限） |
| searchProvider | 搜索引擎 (searxng/brave/duckduckgo) | duckduckgo |
| searxngUrl | SearXNG 实例地址 | - |
| braveApiKey | Brave Search API key | - |
| enabledPlugins | 启用的内置插件列表 | [] |
| externalPlugins | 外部插件模块路径列表 | [] |
| plugins | 插件配置（按插件名命名空间） | {} |

### identity.md

可选的 markdown 文件，内容注入到 system prompt 模板的 `{{identity}}` 占位符中。用于定义 agent 的角色、行为准则、专业领域等。如果不存在则对应区域为空。

### system_prompt.md（可选）

自定义 system prompt 模板，覆盖默认模板。使用 `{{placeholder}}` 占位符语法，运行时替换为实际内容。如果文件不存在则使用 `src/prompts/default.md` 默认模板。

**可用占位符：**

| 占位符 | 替换内容 |
|--------|----------|
| `{{identity}}` | `workspace/identity.md` 内容 |
| `{{memories}}` | 长期记忆内容 |
| `{{skills}}` | 可用技能列表 |
| `{{tools}}` | 内置工具列表（名称 + 描述） |
| `{{current_date}}` | 当前日期（如 2026-05-22） |

未匹配的占位符替换为空字符串。

## 核心数据流

```
用户输入
  ↓
CLI 参数解析 → 确定 workspace 路径
  ↓
workspace 初始化 → 创建子目录、加载配置、加载 identity
  ↓
history.push(user message)
  ↓
┌─── Agent Loop ──────────────────────────────┐
│  history.getRecentMessages(N)               │
│       ↓                                     │
│  compressIfNeeded() → 超阈值时模型摘要压缩  │
│       ↓                                     │
│  client.chat(messages, tools, onDelta,      │
│              systemPrompt)                  │
│       ↓                                     │
│  response = { text, toolCalls }             │
│       ↓                                     │
│  有 toolCalls?                              │
│    是 → 执行工具 → push tool_result         │
│         → 回到循环顶部                       │
│    否 → push assistant message              │
│         → 跳出循环，等待用户输入             │
└─────────────────────────────────────────────┘
```

Agent Loop 是核心：模型自主决定是否调用工具，工具执行结果反馈给模型，模型继续输出，直到无工具调用时将最终回答交给用户。

## 关键设计决策

### 技术栈：TypeScript

项目涉及消息格式、工具 schema、API 响应等大量结构化数据，类型安全显著减少 bug。

### 零运行时依赖

Node 22 内置 fetch、readline/promises、TextDecoder，不需要额外 HTTP/IO 库。开发依赖仅 typescript、@types/node、tsx。

### API 兼容层

火山方舟 Coding Plan 兼容 Anthropic Messages API，但有两个差异：
- 认证用 `x-api-key` header（与标准 Anthropic 一致）
- base_url 不含版本号，客户端拼接 `/v1/messages`
- 部分模型（如 kimi-k2.6）有 thinking 输出，client.ts 过滤 thinking_delta，只输出 text_delta

### 消息历史：滑动窗口

`historyWindowSize` 按"轮"计算（1轮 = 1 user + 1 assistant），截取时保证第一条是 user 消息，满足 API 交替约束。默认 5 轮。

### 上下文压缩

当对话历史 token 估计超过 `maxContextTokens * contextCompressionThreshold` 时触发压缩：

1. **优先压缩历史对话**：markTurnStart 之前的多条消息用模型摘要为一条 `[对话历史摘要]` 用户消息
2. **回退压缩当前轮早期**：历史不足时，压缩当前 Agent Loop 早期消息，保留最后 4 条
3. **压缩失败兜底**：API 调用失败时简单截断，保留最后 2 条

token 估算采用粗略规则（CJK 1.5 token/字，ASCII 0.25 token/字），不追求精确，只用于判断是否接近上下文上限。压缩使用 `client.complete()` 非流式调用，max_tokens=1024，避免流式开销。

### 工具注册：ToolRegistry 模式

工具通过 `ToolRegistry.register(tool)` 注册，模型调用时通过 `getTool(name)` 查找执行。新增工具只需：1) 实现 Tool 接口 2) 注册到 Registry。

### 搜索引擎：多 Provider 架构

web_search 工具支持三个搜索引擎，通过 `config.json` 的 `searchProvider` 字段切换：

| Provider | 说明 | 配置 |
|----------|------|------|
| duckduckgo（默认） | DuckDuckGo Instant Answer API，无需 key | 无额外配置 |
| searxng | 自建 SearXNG 实例，返回完整搜索结果 | 需配置 `searxngUrl` |
| brave | Brave Search API，结果质量好 | 需配置 `braveApiKey` |

注意：DuckDuckGo provider 使用 Instant Answer API（返回摘要/定义），不是完整搜索结果列表，但无需配置即可使用。如需完整搜索结果，推荐使用 SearXNG 或 Brave。

### 内置工具

| 工具 | 用途 | 安全措施 |
|------|------|----------|
| web_search | 网络搜索（多 provider） | 按配置选择引擎 |
| web_fetch | 获取网页内容 | 15 秒超时、50KB 截断、仅支持文本类内容 |
| bash | 执行 shell 命令 | 超时控制（默认30秒）、输出截断（10KB） |
| file_read | 读取文件 | 路径 resolve 防止路径遍历 |
| file_write | 写入文件 | 自动创建父目录 |
| file_edit | 精确替换文本 | old_text 必须唯一匹配，防止误替换 |
| memory_save | 保存/覆盖长期记忆 | name 防路径遍历（仅允许字母、数字、_-） |
| memory_append | 追加内容到已有记忆 | 同上 |
| memory_list | 列出所有长期记忆 | 无参数 |
| skill_use | 激活一个技能 | 技能不存在时返回可用列表 |
| skill_list | 列出所有可用技能 | 无参数 |

bash 工具用 `child_process.spawn` 执行，返回 `{ stdout, stderr, exitCode }`。file_edit 采用唯一匹配策略：`old_text` 在文件中必须只出现一次，否则报错，避免误修改。

### 持久化记忆

记忆系统采用工具驱动的方式，让模型自主决定何时保存和读取信息：

- **写路径**：`memory_save` 和 `memory_append` 两个工具，写入 `workspace/memory/*.md`
- **读路径**：启动时 `loadAllMemories()` 读取所有 `*.md` 文件，注入到 system prompt 的"长期记忆"章节
- **文件格式**：纯 Markdown，名称语义化（如 `user-preferences.md`、`project-context.md`）
- **安全**：文件名仅允许字母、数字、下划线、连字符，防止路径遍历

对比"自动提取"方案，工具驱动的优势是实现简单、透明可控，适合早期阶段。后续可在此基础上叠加自动提取（Phase 2）。

### 系统提示词模板

系统提示词采用单文件模板方案，支持用户自定义覆盖。`src/prompts/default.md` 是默认模板，使用 `{{placeholder}}` 占位符语法。用户可在 `workspace/system_prompt.md` 放置自定义模板覆盖默认值。

模板加载逻辑：优先检查 `workspace/system_prompt.md`，存在则使用用户模板，否则使用 `src/prompts/default.md`。运行时将所有 `{{xxx}}` 占位符替换为实际内容（identity、memories、skills、tools、current_date），未匹配的占位符替换为空字符串。

`buildSystemPrompt(workspacePath, tools)` 在 `src/prompts/build.ts` 中实现，`AgentSession` 构造时在工具注册完成后调用，确保 `{{tools}}` 占位符能获得完整的工具列表。

### 技能系统

技能是 Markdown 文件，放在 `workspace/skills/` 目录下，包含 frontmatter（name、description）和指令正文：

```markdown
---
name: code-review
description: 代码审查，检查代码质量、安全性和最佳实践
---

你是一个代码审查专家。执行以下步骤：...
```

- **发现**：启动时 `listSkills()` 扫描 `skills/<name>/SKILL.md`，将名称和描述注入 system prompt
- **激活**：模型调用 `skill_use(name)` 获取完整指令内容，指令中注入技能工作目录绝对路径
- **查询**：模型调用 `skill_list()` 列出所有可用技能
- **动态内容**：支持 `!`command`` 执行命令注入、`$ARGUMENTS` 参数替换、`${CLAUDE_SKILL_DIR}` 路径替换
- **文件格式**：`SKILL.md` frontmatter 用 `---` 包裹，必须包含 `description` 字段，`name` 由目录名决定

### Gateway：HTTP API 服务

Gateway 是一个 HTTP 服务器，让外部客户端（Web UI、聊天机器人等）通过 HTTP API 与 Agent 交互。

启动方式：`npx tsx src/gateway.ts --port 3000`

**API 端点：**

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /chat | 发送消息，SSE 流式返回事件 |
| GET | /sessions | 列出活跃会话 |
| GET | /sessions/:id/messages | 获取会话消息历史 |
| DELETE | /sessions/:id | 销毁会话 |

**POST /chat 请求：**
```json
{ "message": "你好", "session_id": "optional" }
```

**SSE 事件类型：**
- `text_delta` — 文本增量
- `tool_call` — 工具调用
- `tool_result` — 工具结果
- `done` — 完成（含完整文本和 session_id）
- `error` — 错误

**会话管理：** 通过 `session_id` 复用会话，30 分钟无活动自动清理。

**静态文件服务：** Gateway 启动时自动在独立端口（默认 gateway 端口 +1，可通过 `--web-port` 指定）启动 Web UI 服务器。若 `web/dist/` 存在（已构建前端），提供静态文件 + 代理 API 请求到 gateway；若不存在且非 daemon 模式，自动启动 Vite dev server。

### Web UI

基于 React + Vite 的浏览器聊天界面，代码位于独立的 `web/` 目录。

**技术栈：** React 19 + Vite + react-markdown，无 CSS 框架（~150 行 CSS），无状态管理库（useState 足够）。

**目录结构：**
```
web/
├── index.html           # Vite 入口
├── package.json         # 前端独立依赖
├── vite.config.ts       # React 插件 + dev 代理
├── tsconfig.json        # 前端 TS 配置
└── src/
    ├── main.tsx         # React 挂载
    ├── App.tsx          # 根组件，持有全部状态
    ├── types.ts         # 前端类型
    ├── index.css        # 全局样式
    ├── lib/
    │   ├── sse-client.ts # POST SSE 流消费器（fetch + ReadableStream）
    │   └── api.ts        # API 封装
    └── components/
        ├── ChatView.tsx      # 消息列表 + 自动滚动
        ├── MessageBubble.tsx # 单条消息（ReactMarkdown）
        ├── ToolCallBlock.tsx # 工具调用折叠（details/summary）
        ├── ChatInput.tsx     # 输入框 + 发送按钮
        └── SessionSidebar.tsx # 会话列表 + 新建
```

**SSE 消费：** POST /chat 返回 SSE 流，无法使用 `EventSource`（仅支持 GET）。使用 `fetch` + `ReadableStream` 手动解析 SSE 帧，实现为 async generator。

**开发模式：** `npm run web:dev` 启动 Vite dev server（:5173），通过代理转发 API 请求到 Gateway（:3000）。

**生产模式：** `npm run web:build` 构建到 `web/dist/`，Gateway 启动时自动在独立端口启动 Web UI 服务器并代理 API 请求。默认 `http://localhost:3001`（可通过 `--web-port` 指定）。

### 插件系统

插件系统允许扩展 Gateway 功能（如聊天平台接入），而不修改核心代码。

**Plugin 接口：**

```typescript
interface Plugin {
  name: string;
  init(ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}
```

**PluginContext（宿主提供）：**

| 方法/属性 | 说明 |
|-----------|------|
| `config` | 插件专属配置（来自 `plugins.<name>`） |
| `workspacePath` | 工作目录路径 |
| `registerRoute(route)` | 注册 HTTP 路由 |
| `getOrCreateSession(id, prefix?)` | 获取/创建 AgentSession（可选前缀） |
| `deleteSession(id)` | 删除会话 |
| `log(level, message, sessionId?)` | 插件日志 |

**插件加载：**
- 内置插件：放在 `src/plugins/<name>/` 下，通过 `enabledPlugins` 启用
- 外部插件：npm 包或文件路径，通过 `externalPlugins` 加载
- 每个插件的配置在 `plugins.<pluginName>` 下命名空间隔离

**路由注册表：** Gateway 启动时加载插件，插件通过 `registerRoute()` 注册路由。请求匹配时插件路由优先于核心路由。

### 飞书插件（内置）

通过飞书自建应用 + WebSocket 长连接，让用户通过飞书与 Agent 对话。无需公网地址，插件主动连接飞书服务器接收事件。

**接入流程：**

```
飞书用户 → 飞书服务器 ←(WebSocket 长连接)→ 飞书插件 → AgentSession → 飞书 API (回复消息)
```

**配置示例：**
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

**依赖：** `@larksuiteoapi/node-sdk`（飞书官方 SDK，提供 WSClient 和 EventDispatcher）

**关键设计：**
- 使用 `WSClient` 建立长连接，无需公网域名或 ngrok
- 使用 `EventDispatcher` 注册 `im.message.receive_v1` 事件处理
- 收到消息后异步处理，同一 `chat_id` 复用 AgentSession（session_id 格式：`feishu:<chat_id>`）
- 超长回复自动按换行符分段发送（~4000 字符/段）
- 支持 `onReady`/`onError`/`onReconnecting`/`onReconnected` 生命周期回调
- 插件销毁时自动关闭 WebSocket 连接

## 待实现

- **安全沙箱**：工具执行权限控制
- **RAG**：检索增强生成