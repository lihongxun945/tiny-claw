# tiny-claw 架构文档

## 项目目标

构建一个自主规划、执行任务的 Agent，类似 OpenClaw。用户输入任务后，Agent 通过规划-执行-观察循环自主完成。

## 开发路线

```
基础能力（主链路）：  Loop → Model IO + Prompt → 工具调用 → History → 上下文压缩 → 配置管理
高级能力：           Memory → Skill → 聊天工具(飞书/钉钉) → RAG
```

当前进度：已完成 Loop、Model IO + Prompt、工具调用、History，进入上下文压缩阶段。

## 模块结构

```
src/
├── index.ts      # 主循环（Agent Loop），CLI 入口
├── config.ts     # 配置加载（从 workspace 读取）
├── client.ts     # Anthropic Messages API 客户端（流式）
├── workspace.ts  # 工作目录初始化、身份加载、system prompt 构建
├── logger.ts     # 追加式文件日志（history + 执行日志）
├── history.ts    # 滑动窗口消息历史
├── memory.ts     # 持久化记忆（读写 memory/*.md）
├── tools.ts      # 工具注册中心
├── search.ts     # DuckDuckGo 网络搜索工具
├── bash.ts       # Shell 命令执行工具
├── file_read.ts  # 文件读取工具
├── file_write.ts # 文件写入工具
├── file_edit.ts  # 文件精确替换工具
└── types.ts      # 共享类型定义
```

## 工作目录结构

tiny-claw 运行时需要一个工作目录（workspace），所有持久化数据都放在其中。工作目录路径通过 `--workspace` CLI 参数或 `TINY_CLAW_WORKSPACE` 环境变量指定，默认为 `./workspace`。

```
workspace/
├── config.json        # 配置（API key、模型、工具权限等）
├── identity.md        # 身份设定（注入 system prompt）
├── skills/            # 自定义技能（TODO: 技能加载系统）
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
| historyWindowSize | 历史窗口（轮） | 5 |

### identity.md

可选的 markdown 文件，内容注入到 system prompt 中。用于定义 agent 的角色、行为准则、专业领域等。如果不存在则使用默认 system prompt。

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

### 工具注册：ToolRegistry 模式

工具通过 `ToolRegistry.register(tool)` 注册，模型调用时通过 `getTool(name)` 查找执行。新增工具只需：1) 实现 Tool 接口 2) 注册到 Registry。

### 搜索引擎：DuckDuckGo

免 API key，解析 HTML 搜索结果页提取标题、摘要、链接。作为第一个工具验证 tool use 链路，后续可扩展 Brave/Perplexity 等 provider。

### 内置工具

| 工具 | 用途 | 安全措施 |
|------|------|----------|
| web_search | DuckDuckGo 搜索 | 无 |
| bash | 执行 shell 命令 | 超时控制（默认30秒）、输出截断（10KB） |
| file_read | 读取文件 | 路径 resolve 防止路径遍历 |
| file_write | 写入文件 | 自动创建父目录 |
| file_edit | 精确替换文本 | old_text 必须唯一匹配，防止误替换 |
| memory_save | 保存/覆盖长期记忆 | name 防路径遍历（仅允许字母、数字、_-） |
| memory_append | 追加内容到已有记忆 | 同上 |
| memory_list | 列出所有长期记忆 | 无参数 |

bash 工具用 `child_process.spawn` 执行，返回 `{ stdout, stderr, exitCode }`。file_edit 采用唯一匹配策略：`old_text` 在文件中必须只出现一次，否则报错，避免误修改。

### 持久化记忆

记忆系统采用工具驱动的方式，让模型自主决定何时保存和读取信息：

- **写路径**：`memory_save` 和 `memory_append` 两个工具，写入 `workspace/memory/*.md`
- **读路径**：启动时 `loadAllMemories()` 读取所有 `*.md` 文件，注入到 system prompt 的"长期记忆"章节
- **文件格式**：纯 Markdown，名称语义化（如 `user-preferences.md`、`project-context.md`）
- **安全**：文件名仅允许字母、数字、下划线、连字符，防止路径遍历

对比"自动提取"方案，工具驱动的优势是实现简单、透明可控，适合早期阶段。后续可在此基础上叠加自动提取（Phase 2）。

### 身份注入

`identity.md` 作为可选的 system prompt 扩展。如果文件存在，运行时加载并注入到 API 请求的 `system` 参数中，让模型在每次对话中遵循角色设定。

## 待实现

- **上下文压缩**：长任务上下文溢出时自动压缩
- **Loop 终止条件**：最大步数、超时、模型判断无法继续
- **安全沙箱**：工具执行权限控制
- **配置管理**：统一管理模型选择、工具权限等
- **技能系统**：从 workspace/skills/ 加载自定义技能