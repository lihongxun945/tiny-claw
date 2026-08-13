# tiny-claw

tiny-claw 是一个插件化、可扩展的个人 AI Agent 框架，用于研究Agent实现原理，实现了一个完整Agent的全部功能，支持工具调用、长期记忆、权限审批、Web UI 和飞书接入。
这个项目的目的是研究Agent实现原理，并未经过严格测试，因此可能存在一些潜在的问题，不建议部署在生产环境中。

![tiny-claw WebUI](docs/images/tiny-claw-webui.png)

## 核心功能

- 自主 Agent Loop、流式输出和多轮工具调用
- 远程模型与内置 Qwen、Gemma 本地模型
- Web 搜索、网页读取、Shell、文件读写和项目开发工具
- 普通模式与可持久化、支持调研后动态细化的计划执行模式
- 会话历史、上下文压缩、滚动摘要和跨会话长期记忆
- Skill、Sub-agent 和自定义插件扩展
- 危险操作权限审批、单次授权与本轮授权
- Web UI、macOS 客户端、Gateway API 和飞书机器人
- 图片输入、模型调用调试和工具审计日志

## 项目定位

tiny-claw 更关注 Agent 核心机制的可读性和可扩展性，适合学习、个人使用和定制化实验。OpenClaw 面向更完整的产品与生态，具备更丰富的平台集成和生产能力。tiny-claw 尚未经过生产环境验证，不建议直接用于关键业务。

## 快速开始

推荐普通用户使用 macOS 客户端，无需安装 Node.js 或手动启动 Gateway。只有需要研究 Agent 实现、调试源码或参与项目开发时，才推荐从源码本地启动。

### 使用 macOS 客户端（推荐）

#### 下载与安装

从 GitHub Releases 下载 `tiny-claw-<version>-arm64.dmg`，打开 DMG 后将 `tiny-claw.app` 拖入“应用程序”目录。当前客户端仅支持 Apple Silicon Mac。

#### 首次配置

客户端首次启动会自动创建完整的默认配置。打开左下角“配置”页面，至少完成以下设置：

1. 填写模型服务的 API URL。
2. 填写 API Key。
3. 填写模型名称。
4. 选择模型协议：`anthropic-messages` 或 `openai-chat`。
5. 按需配置 Ollama Web Search、Brave Search 或 SearXNG。
6. 点击“保存”。

模型配置保存后，新会话会自动使用最新设置。插件启停、Gateway Host 和 Gateway Token 等启动期配置需要退出并重新打开客户端后生效。

客户端运行后会在 macOS 菜单栏显示 tiny-claw 图标。关闭主窗口只会隐藏窗口，Agent 和 Gateway 会继续在后台运行；点击菜单栏图标、Dock 图标或再次打开应用即可恢复窗口。需要完全退出时，请在菜单栏图标的菜单中选择“退出 tiny-claw”，或按 `Command+Q`。

#### 日常使用

- 在“聊天”页面输入任务并发送，Agent 会根据任务调用工具并流式输出结果。
- 点击“新对话”创建新会话；历史会话会显示在左侧列表中。
- 在“记忆”页面查看、编辑、禁用或删除长期记忆。
- 在“日志”页面查看运行日志、模型调用错误和工具审计记录。
- 在“配置”页面修改模型、上下文、搜索、权限、Sub-agent、插件和调试设置。
- 当工具需要审批时，在聊天消息的工具块中点击“批准”或“拒绝”；批准后原任务会自动继续执行。
- 项目模式的 `project_search` 会优先使用系统 `rg` 加速；未安装 ripgrep 时会自动使用内置搜索实现。

#### Skill

个人 Skill 放在 runtime workspace 的 `skills/<name>/SKILL.md`，会在所有会话中可用。项目模式会额外自动发现项目根目录下的 `.agents/skills/<name>/SKILL.md`，并兼容 `.claude/skills/<name>/SKILL.md`。系统提示词只注入 Skill 名称和描述，完整正文由模型在需要时通过 `skill_use` 按需加载。

项目会话中，同名裸名优先匹配项目 Skill；也可以用 `project/<name>` 或 `workspace/<name>` 精确指定来源。`.agents/skills` 是推荐的跨 Agent 项目路径，`.claude/skills` 用于兼容 Claude Code 生态。

#### 数据与升级

macOS 客户端的所有用户数据保存在：

```text
~/Library/Application Support/tiny-claw/workspace
```

其中包含配置、会话、长期记忆、Skill、插件和日志。覆盖安装或升级客户端不会清除该目录，建议在迁移电脑前备份整个 workspace。

客户端 workspace 与源码仓库中的 `./workspace` 相互独立，客户端不会自动读取源码开发环境的数据。如需迁移，可以在客户端完全退出后，将需要的配置、会话、记忆、Skill 或插件复制到客户端 workspace。

### 从源码本地启动（开发者）

源码启动适合研究 Agent Loop、插件系统、上下文与记忆实现，或者调试和参与 tiny-claw 开发。普通使用请优先选择上面的 macOS 客户端。

#### 安装依赖

```bash
git clone https://github.com/lihongxun945/tiny-claw.git
cd tiny-claw
npm install
```

#### 配置模型

首次启动 Gateway 时，如果 workspace 中没有 `config.json`，tiny-claw 会自动生成一份完整的默认配置。可以直接在 WebUI 的“配置”页面填写 API Key、模型、搜索、权限、记忆、Sub-agent 和插件等全部设置。

也可以在启动前手动复制配置模板：

```bash
cp config.simple.example.json workspace/config.json
```

推荐从 `config.simple.example.json` 开始；`config.all.example.json` 是完整配置参考。
自动生成的配置会预设 DeepSeek API 地址、`deepseek-chat` 模型和可直接使用的 DuckDuckGo 关键词搜索；API Key、飞书密钥和付费搜索服务密钥等用户凭证保持为空。可以填写远程 API Key，也可以在配置页面下载并启用 Qwen 或 Gemma 本地模型；仅启用本地模型时不需要 API Key。

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

#### 配置搜索引擎

Agent 的 `web_search` 能力依赖搜索 provider。`duckduckgo` 是免配置兜底，只适合简单关键词查询，本质上不是真正稳定的搜索引擎能力，效果较差；推荐配置 Ollama Web Search、Brave Search 或自建 SearXNG。

Ollama Web Search 示例：

```json
{
  "searchProvider": "ollama",
  "ollamaApiKey": "YOUR_OLLAMA_API_KEY"
}
```

Brave Search 示例：

```json
{
  "searchProvider": "brave",
  "braveApiKey": "YOUR_BRAVE_API_KEY"
}
```

SearXNG 示例：

```json
{
  "searchProvider": "searxng",
  "searxngUrl": "http://localhost:8080"
}
```

#### 启动 Gateway

源码环境推荐使用 Gateway + WebUI 模式：

```bash
npm run web:build
npm run gateway -- --port 3000
```

Gateway API 默认监听 `127.0.0.1:3000`，WebUI 默认访问：

```text
http://localhost:3001
```

启动后即可在 WebUI 中创建会话并与 Agent 对话。

注意：`npm run gateway` 会以 daemon 模式启动 Gateway。daemon 模式只有在 `web/dist/index.html` 已存在时才会启动 WebUI 静态服务；首次启动、刚拉代码或清理过构建产物后，需要先执行 `npm run web:build`，再启动或重启 Gateway。否则可能只启动了 Gateway API，`http://localhost:3001` 会提示无法访问。

## 配置参考

`workspace/config.json` 支持以下配置。`workspacePath` 和 `systemPrompt` 是运行时内部字段，不需要写入配置文件。

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `remoteModel.enabled` | `true` | `false` | 是否启用远程模型；与本地模型同时启用时优先使用远程模型 |
| `localModel.enabled` | `false` | `true` | 是否启用内置本地推理 |
| `localModel.modelId` | `"qwen3.5-4b-q4"` | `"gemma-4-12b-it-q4"` | 本地模型：Qwen3.5 0.8B/2B/4B/9B/27B/35B-A3B，或 Gemma 4 E2B/E4B/12B/26B-A4B/31B |
| `localModel.contextSize` | `32768` | `32768` | 本地模型实际加载的上下文 token 数，允许范围最高 262144；默认采用更适合本地内存占用的 32768 |
| `apiUrl` | 必填 | `"https://ark.cn-beijing.volces.com/api/coding"` | 模型 API 基础地址 |
| `apiKey` | 必填 | `"YOUR_API_KEY"` | 模型 API Key |
| `model` | 必填 | `"deepseek-v4-flash"` | 模型名称 |
| `modelProvider` | `"anthropic-messages"` | `"openai-chat"` | 模型协议适配器：`anthropic-messages`、`openai-chat`、`chatgpt` |
| `maxTokens` | `16384` | `16384` | 单次模型回复最大 token |
| `emptyResponseRetries` | `1` | `1` | 模型成功返回空文本且无工具调用时的重试次数 |
| `maxContextTokens` | `128000` | `128000` | 上下文窗口 token 估算上限 |
| `contextCompressionThreshold` | `0.7` | `0.7` | 超过 `maxContextTokens * threshold` 时触发上下文压缩 |
| `contextCompressionMaxChars` | `5000` | `5000` | 上下文压缩摘要目标字数上限 |
| `contextCompressionToolResultMaxChars` | `500` | `500` | 构建历史压缩摘要时每个 tool result 保留的字符数 |
| `contextCompressionMaxOutputTokens` | `2048` | `2048` | 上下文压缩模型调用允许生成的最大 token 数 |
| `toolResultInitialMaxChars` | `12000` | `12000` | 对话上下文超预算时 tool result 的初始截断字符数 |
| `historyWindowSize` | `5` | `20` | 普通历史窗口轮数；会话摘要开启后仍会保留近期原文 |
| `maxAgentIterations` | `100` | `100` | 单次任务最大 Agent Loop 次数；达到上限时会明确提示，配置 `0` 表示不限 |
| `searchProvider` | `"ollama"` | `"brave"` | 搜索服务：`ollama`、`searxng`、`brave`、`duckduckgo` |
| `ollamaApiKey` | 无 | `"YOUR_OLLAMA_API_KEY"` | Ollama Web Search API Key，`searchProvider=ollama` 时使用 |
| `searxngUrl` | 无 | `"http://localhost:8080"` | 自建 SearXNG 地址，`searchProvider=searxng` 时使用 |
| `braveApiKey` | 无 | `"YOUR_BRAVE_API_KEY"` | Brave Search API Key，`searchProvider=brave` 时使用 |
| `enabledPlugins` | `[]` | `["feishu"]` | 启用的内置插件列表 |
| `externalPlugins` | `[]` | `["./workspace/plugins/foo/index.ts"]` | 额外加载的外部插件入口 |
| `plugins` | `{}` | `{ "feishu": { "appId": "cli_xxx" } }` | 插件私有配置 |
| `subAgent` | 见下文 | `{ "maxConcurrency": 3 }` | Sub-agent 工具权限与并发配置 |
| `sessionSummary` | 见下文 | `{ "enabled": true }` | 会话滚动摘要与持久化配置 |
| `autoMemory` | 见下文 | `{ "mode": "hybrid" }` | 自动长期记忆配置 |
| `profile` | 见下文 | `{ "enabled": true }` | 每轮固定注入的用户身份、偏好和长期约束 |
| `memory` | 见下文 | `{ "enabled": true }` | 向量长期记忆、召回、Embedding 与遗忘配置 |
| `debug` | `false` | `{ "enabled": true, "modelIO": true }` | 模型输入输出调试日志 |
| `security` | 见下文 | `{ "bash": { "mode": "allow" } }` | bash、Gateway、工具审计安全配置 |
| `project` | 见下文 | `{ "security": { "mode": "ask" }, "openTimeoutMs": 30000, "gitTimeoutMs": 10000, "diffMaxChars": 200000, "treeMaxDepth": 4, "treeMaxEntries": 2000, "searchMaxResults": 200, "searchMaxChars": 50000, "searchTimeoutMs": 10000 }` | 项目会话权限、打开/Git/搜索超时和工具输出限制 |
| `plan` | `{ "enabled": true, "maxSteps": 8 }` | 同默认值 | 计划执行模式开关与单个计划最大步骤数；支持调研后细化计划及等待用户确认后继续 |

本地模型可直接在 WebUI“配置”页面下载和测试，无需安装 Ollama。模型文件保存在 `workspace/models/`；Qwen3.5 4B 更适合中文和 Agent 场景，Gemma 4 提供从 E2B 到 31B 的不同规模。选择模型不会自动下载，点击“下载并安装”后卡片会显示实时百分比和下载字节数；下载完成后才能测试本地模型。远程和本地模型使用独立卡片和测试按钮，测试不会写入会话历史或执行工具。Qwen3.5 和 Gemma 4 目录中的模型均采用 Apache-2.0；模型不会被打包进 tiny-claw 安装包。

### Sub-agent 配置

`sub_agent_run` 工具支持一次并行启动多个临时子 agent。子 agent 默认只开放读取/检索类工具，不允许执行 shell、写文件或保存记忆。可在 `workspace/config.json` 中调整：

```json
{
  "subAgent": {
    "allowedTools": ["web_search", "web_fetch", "file_read", "memory_list", "memory_read", "skill_list", "skill_use"],
    "disabledTools": ["bash", "file_write", "file_edit", "memory_save", "memory_append", "memory_delete", "sub_agent_run"],
    "maxIterations": 3,
    "maxConcurrency": 3
  }
}
```

如果需要让子 agent 具备更多能力，可以把工具名加入 `allowedTools`，再确保不在 `disabledTools` 中。`sub_agent_run` 会始终被禁用，避免递归派生。

Sub-agent 提示词默认模板位于 `src/prompts/sub_agent.md`，可在工作目录放置 `workspace/sub_agent_prompt.md` 覆盖。支持占位符：`{{task}}`、`{{context}}`、`{{allowed_tools}}`、`{{current_date}}`。临时 sub-agent 不独立续跑权限审批；遇到需要审批的工具时会把工具与参数返回给主 Agent，由主 Agent 重新调用并完成审批，避免产生无法恢复的子会话审批。

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `subAgent.allowedTools` | 读取/检索类工具 | `["web_search", "file_read"]` | 子 agent 可使用的工具白名单 |
| `subAgent.disabledTools` | `["sub_agent_run"]` | `["bash", "file_write"]` | 子 agent 禁用工具；`sub_agent_run` 始终禁用 |
| `subAgent.maxIterations` | `3` | `3` | 单个子任务最大 Agent Loop 次数，上限 `8` |
| `subAgent.maxConcurrency` | `3` | `3` | 并行执行的子任务数量，上限 `8` |

### 会话摘要配置

`core-session-summary` 插件会为每个普通会话维护滚动摘要，模型调用时注入摘要并只保留最近几轮原文，避免历史消息持续膨胀。摘要默认持久化到 `workspace/sessions/<session>/state.json`，刷新、切换会话或重启 Gateway 后仍可恢复：

```json
{
  "sessionSummary": {
    "enabled": true,
    "persistent": true,
    "turnThreshold": 5,
    "recentTurns": 3,
    "maxChars": 4000
  }
}
```

`sub:` 开头的临时 sub-agent 会话默认不生成摘要，避免额外消耗。完整原始消息按会话写入 `workspace/sessions/<session>/messages.jsonl`，持久摘要只作为模型上下文状态，不影响 UI 历史回放。

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `sessionSummary.enabled` | `true` | `true` | 是否启用会话滚动摘要 |
| `sessionSummary.persistent` | `true` | `true` | 是否把摘要持久化到 session 状态文件 |
| `sessionSummary.turnThreshold` | `5` | `5` | 累积多少轮后更新一次摘要 |
| `sessionSummary.recentTurns` | `3` | `3` | 模型上下文中保留的最近原文轮数 |
| `sessionSummary.maxChars` | `4000` | `4000` | 会话滚动摘要最大字符数 |

### 自动记忆配置

跨会话记忆分为两类：`workspace/profile/*.md` 保存稳定用户身份、称呼、语言和长期交互约束，由 `core-profile-memory` 每轮固定注入全文；`workspace/memory/*.md` 保存项目事实、历史决策和经验，由 `core-vector-memory` 按当前问题相关性召回。Profile 不进入向量数据库，也不会因长时间未使用而自动遗忘。

`core-auto-memory` 可以在多轮对话后同时整理 Profile 和向量长期记忆。每轮最终问答会先按 session 持久化到 `state.json`，达到阈值或执行 `/dream` 时聚合全部主会话的待整理增量。Markdown 文件仍是可读、可备份的事实源，LanceDB 索引保存在 `workspace/memory/vector/`，只负责向量长期记忆的语义候选召回和 metadata 过滤。

每次用户提问时，`core-vector-memory` 会自动执行向量与关键词混合检索，只把少量高相关记忆注入当前轮 Prompt；不再把全部记忆全文发送给模型。自动召回不足时，Agent 可以调用 `memory_search` 深度搜索，再用 `memory_read` 读取指定记忆。Embedding 不可用或索引损坏时会退化为关键词检索，不阻断正常聊天。

新事实默认追加；明确替代旧状态时通过 `supersedes` 将旧记忆标记为 `superseded`，保留历史而不静默覆盖。删除会把记忆移入 `workspace/memory/trash/`。普通记忆只有在未使用轮次和未使用天数同时达到阈值后才标记为 `stale`；读取会刷新使用状态并增强记忆。回收站超过保留期后才物理清理。

```json
{
  "autoMemory": {
    "enabled": true,
    "mode": "hybrid",
    "turnThreshold": 10,
    "maxCandidates": 5,
    "maxBatchChars": 8000,
    "lockTimeoutSeconds": 300
  },
  "profile": {
    "enabled": true,
    "maxItemChars": 2000,
    "maxTotalChars": 8000
  },
  "memory": {
    "maxItemChars": 20000,
    "maxTotalChars": 80000
  }
}
```

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `autoMemory.enabled` | `true` | `true` | 是否启用自动记忆 |
| `autoMemory.mode` | `"hybrid"` | `"hybrid"` | `auto` 开放保存/更新/删除；`hybrid` 只开放保存/更新，删除只建议；`suggest` 只读并输出建议 |
| `autoMemory.turnThreshold` | `10` | `10` | workspace 内累计多少轮主会话最终问答后触发一次分析 |
| `autoMemory.maxCandidates` | `5` | `5` | 单次最多允许的 memory 工具调用次数 |
| `autoMemory.maxBatchChars` | `8000` | `8000` | 单次分析中增量最终问答的最大字符数 |
| `autoMemory.lockTimeoutSeconds` | `300` | `300` | workspace 记忆整理锁的过期时间 |
| `profile.enabled` | `true` | `true` | 是否固定注入启用的用户 Profile |
| `profile.maxItemChars` | `2000` | `2000` | 单个 Profile Markdown 正文上限 |
| `profile.maxTotalChars` | `8000` | `8000` | 每轮固定注入的 Profile 总字符上限 |
| `memory.maxItemChars` | `20000` | `20000` | 单条记忆正文最大字符数 |
| `memory.maxTotalChars` | `80000` | `80000` | 所有启用记忆正文的总字符上限 |
| `memory.enabled` | `true` | `true` | 是否启用向量长期记忆和自动召回 |
| `memory.embedding.provider` | `local-hash` | `local-hash` | `local-hash` 无需模型；`openai-compatible` 使用 Embedding API |
| `memory.embedding.model` | `local-hash-v1` | `local-hash-v1` | Embedding 模型名 |
| `memory.embedding.dimensions` | `384` | `384` | 向量维度；切换模型或维度后自动重建索引 |
| `memory.retrieval.maxResults` | `5` | `5` | 每轮最多自动召回的记忆条数 |
| `memory.retrieval.maxContextChars` | `6000` | `6000` | 自动注入的记忆字符预算 |
| `memory.retrieval.minScore` | `0.35` | `0.35` | 混合检索最低分数 |
| `memory.maintenance.inactiveTurns` | `200` | `200` | 成为 stale 候选所需的未使用对话轮数 |
| `memory.maintenance.inactiveDays` | `30` | `30` | 成为 stale 候选所需的未使用自然天数；与轮数条件同时满足 |
| `memory.maintenance.trashRetentionDays` | `30` | `30` | 回收站物理清理前的保留天数 |

自动记忆整理会把“Profile 摘要索引 + 长期记忆摘要索引 + workspace 内新增最终问答 + 配置限制”交给整理模型，不包含工具过程、工具结果或调试日志。稳定用户偏好使用 `profile_*` 工具维护；项目事实和历史经验使用 `memory_*` 工具维护。达到阈值后的整理在后台运行；`/dream` 同步等待结果。整理成功后只推进本次快照的增量游标，失败则保留待重试内容。

### 聊天命令

聊天输入支持斜杠命令。命令由插件注册；在 WebUI 输入 `/` 时会显示当前已注册命令，支持按名称或别名过滤，并可使用方向键、Tab 或 Enter 补全。内置命令如下：

| 命令 | 说明 |
|---|---|
| `/help` | 列出可用命令 |
| `/help <命令名>` | 查看单个命令说明 |
| `/new` | Web 中开启新会话；飞书中重置当前会话 |
| `/reset` | `/new` 的别名 |
| `/context` | 显示当前会话上下文长度估算 |
| `/ctx` | `/context` 的别名 |
| `/dream` | 立即触发 workspace 级 auto-memory 整理 |
| `/approvals` | 列出当前可处理的命令审批 |
| `/approve <审批 ID>` | 批准一条命令审批；可恢复原任务时会继续执行 |
| `/approve-all <审批 ID>` | 允许当前对话轮次后续所有 `ask` 权限申请并继续执行 |
| `/reject <审批 ID>` | 拒绝一条命令审批 |

自定义插件可以通过 `ctx.registerChatCommand(...)` 注册命令。命令会在进入 Agent Loop 前执行，适合做会话管理、审批、上下文查询等轻量操作。

### 图片输入

WebUI 支持选择图片或直接粘贴截图，可在发送前预览和移除。图片按 session 保存在 `workspace/sessions/<session>/attachments/`，历史记录只保存附件引用；需要使用支持视觉输入的模型。默认支持 PNG、JPEG、WebP 和 GIF，每条消息最多 4 张、单张不超过 10 MB。

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `attachments.enabled` | `true` | `true` | 是否允许上传图片 |
| `attachments.maxFilesPerMessage` | `4` | `4` | 每条消息最多携带的图片数 |
| `attachments.maxFileSize` | `10485760` | `10485760` | 单张图片最大字节数 |
| `attachments.allowedImageTypes` | PNG/JPEG/WebP/GIF | `["image/png","image/jpeg"]` | 允许上传的图片 MIME 类型 |

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

开启后，每次模型调用会按 Request ID 写入
`workspace/debug/model-calls/YYYY-MM-DD/<requestId>.json`。在 Web UI 的“日志 → 模型调用”中可以按调用查看：

- 请求原文：发送给模型的 URL 和请求体，包括 system prompt、messages、tools
- 响应原文：非流式接口返回的原始 JSON
- 解析结果：tiny-claw 解析后的文本和工具调用
- 错误与修复：失败响应、自动修复策略和重试请求，归入同一个 Request ID
- 流事件：流式接口返回的原始 SSE JSON 事件（仅在 `rawStreamEvents` 开启时记录）

认证请求头不会写入调试记录，图片 Base64 数据也会被替换为占位说明。请求体仍可能包含用户输入、工具结果、system prompt 和记忆内容，建议只在本地排查时开启。

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `debug` | `false` | `true` | 简写形式，直接开启或关闭 debug |
| `debug.enabled` | `false` | `true` | 是否启用 debug 日志 |
| `debug.modelIO` | `true` | `true` | debug 开启后，是否记录模型请求和响应 |
| `debug.rawStreamEvents` | `true` | `true` | debug 开启后，是否记录流式原始事件 |

### 安全边界

文件工具支持读取和修改 workspace 之外的文件：相对路径以 workspace 为基准，也可以传入绝对路径。危险操作默认自动执行；如果需要更严格的安全边界，可以通过全局模式或工具级模式改为 `ask` / `deny`：

```json
{
  "security": {
    "mode": "auto",
    "tools": {
      "bash": { "mode": "ask" },
      "file_write": { "mode": "ask" },
      "memory_delete": { "mode": "deny" }
    },
    "auditTools": true
  }
}
```

权限决策顺序为：`security.tools.<tool>.mode` > `security.mode` > `auto`。`auto` 默认执行普通操作和当前工作目录内的全部文件操作，只对目录外写入、提权、系统状态修改和远程脚本执行等明确高风险行为请求审批；格式化磁盘、删除根目录等灾难性命令直接拒绝。`bash` 工具和技能文件中的动态 shell 注入都使用 `bash` 的工具级权限。`ask` 会创建一次性审批记录；Web UI 可以“批准本次”或“允许本轮”，飞书中可以回复完整 `/approve <审批 ID>` 或 `/approve-all <审批 ID>`，批准后都会尝试继续原会话。“允许本轮”仅对当前 session、调用者和当前 Agent Loop 生效，本轮完成、失败或取消后自动清理，且不会覆盖 `deny`。工具调用和自动权限决策默认写入审计日志，可通过 `auditTools: false` 关闭工具审计。

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `security.mode` | `"auto"` | `"ask"` | 全局危险操作权限模式：`deny`、`ask`、`auto`、`allow` |
| `security.tools.<tool>.mode` | 继承全局 | `"deny"` | 单个工具权限模式，覆盖 `security.mode` |
| `security.gateway.host` | `"127.0.0.1"` | `"0.0.0.0"` | Gateway 监听地址；暴露到非回环地址时必须配置 token |
| `security.gateway.token` | 无 | `"YOUR_GATEWAY_TOKEN"` | Gateway Bearer token |
| `security.gateway.sseHeartbeatIntervalMs` | `15000` | `15000` | 流式响应空闲时发送 SSE 心跳的间隔，避免长时间推理导致连接超时 |
| `security.auditTools` | `true` | `true` | 是否记录工具调用审计日志 |

### Gateway API

Gateway 支持通过 HTTP + SSE 集成外部客户端，默认只监听 `127.0.0.1`。接口、鉴权、请求格式和取消规则参见 [Gateway API 文档](docs/gateway-api.md)。

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

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `enabledPlugins` | `[]` | `["feishu"]` | 启用飞书内置插件 |
| `plugins.feishu.appId` | 必填 | `"cli_xxx"` | 飞书自建应用 App ID |
| `plugins.feishu.appSecret` | 必填 | `"YOUR_FEISHU_APP_SECRET"` | 飞书自建应用 App Secret |
| `plugins.feishu.verificationToken` | 必填 | `"YOUR_FEISHU_VERIFICATION_TOKEN"` | 事件订阅 Verification Token |

7. **确认连接** — 先按“快速开始”确保 Gateway 已运行；飞书插件会随 Gateway 自动建立 WebSocket 长连接。

启动后日志显示 `飞书长连接已建立` 即表示连接成功，可以在飞书中给机器人发消息测试。

当相关工具权限为 `ask` 时，飞书用户可以直接发送文字命令处理自己发起的审批：

| 命令 | 说明 |
|------|------|
| `/approvals` | 列出当前用户在当前会话中可以处理的审批 |
| `/approve <审批 ID>` | 批准审批，并尝试继续原会话任务 |
| `/approve-all <审批 ID>` | 允许本轮全部权限申请，并尝试继续原会话任务 |
| `/reject <审批 ID>` | 拒绝命令执行 |

飞书审批绑定发起用户和会话。批准后会继续原会话中暂停的工具调用；其他用户无法查看、批准或拒绝该审批。

## 文档

- [架构说明](docs/architecture.md)
- [Gateway API](docs/gateway-api.md)
- [插件开发指南](docs/plugin-development.md)
- [本地开发与测试](docs/development.md)
- [macOS 构建与发布](docs/release.md)
