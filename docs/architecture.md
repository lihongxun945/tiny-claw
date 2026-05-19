# tiny-claw 架构文档

## 项目目标

构建一个自主规划、执行任务的 Agent，类似 OpenClaw。用户输入任务后，Agent 通过规划-执行-观察循环自主完成。

## 开发路线

```
基础能力（主链路）：  Loop → Model IO + Prompt → 工具调用 → History → 上下文压缩 → 配置管理
高级能力：           Memory → Skill → 聊天工具(飞书/钉钉) → RAG
```

当前进度：已完成 Model IO + Prompt、工具调用、History，进入上下文压缩阶段。

## 模块结构

```
src/
├── index.ts      # 主循环（Agent Loop）
├── config.ts     # 配置加载
├── client.ts     # Anthropic Messages API 客户端
├── history.ts    # 滑动窗口消息历史
├── tools.ts      # 工具注册中心
├── search.ts     # DuckDuckGo 网络搜索工具
├── bash.ts       # Shell 命令执行工具
├── file_read.ts  # 文件读取工具
├── file_write.ts # 文件写入工具
├── file_edit.ts  # 文件精确替换工具
└── types.ts      # 共享类型定义
```

## 核心数据流

```
用户输入
  ↓
history.push(user message)
  ↓
┌─── Agent Loop ───────────────────────────┐
│  history.getRecentMessages(N)            │
│       ↓                                  │
│  client.chat(messages, tools, onDelta)   │
│       ↓                                  │
│  response = { text, toolCalls }          │
│       ↓                                  │
│  有 toolCalls?                           │
│    是 → 执行工具 → push tool_result      │
│         → 回到循环顶部                    │
│    否 → push assistant message           │
│         → 跳出循环，等待用户输入          │
└──────────────────────────────────────────┘
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

bash 工具用 `child_process.spawn` 执行，返回 `{ stdout, stderr, exitCode }`。file_edit 采用唯一匹配策略：`old_text` 在文件中必须只出现一次，否则报错，避免误修改。

## 配置

`config.json`（gitignore，参考 `config.example.json`）：

| 字段 | 说明 | 默认值 |
|------|------|--------|
| apiUrl | API 基础地址 | 必填 |
| apiKey | API 密钥 | 必填 |
| model | 模型标识 | 必填 |
| maxTokens | 单次响应最大 token | 4096 |
| historyWindowSize | 历史窗口（轮） | 5 |

## 待实现

- **上下文压缩**：长任务上下文溢出时自动压缩
- **Loop 终止条件**：最大步数、超时、模型判断无法继续
- **安全沙箱**：工具执行权限控制
- **配置管理**：统一管理模型选择、工具权限等
