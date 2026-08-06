# tiny-claw 架构文档

## 项目目标

构建一个自主规划、执行任务的 Agent，类似 OpenClaw。用户输入任务后，Agent 通过规划-执行-观察循环自主完成。

## 开发路线

```
基础能力（主链路）：  Loop → Model IO + Prompt → 工具调用 → History → 上下文压缩 → 配置管理
高级能力：           Memory → Skill → Sub-agent → 聊天工具(飞书/钉钉) → RAG
```

当前进度：已完成 Loop、Model IO + Prompt、工具调用、History、上下文压缩、配置管理、Memory、自动记忆、Skill、Sub-agent、Gateway、飞书接入。

## 模块结构

```
src/
├── index.ts          # CLI 入口（使用 PluginManager + AgentSession）
├── gateway.ts        # HTTP Gateway（SSE 流式 API + 插件路由）
├── gateway-sse.ts    # SSE 心跳生命周期管理
├── agent.ts          # AgentSession 类（核心 Agent Loop，仅编排流程+调用钩子）
├── plugin-manager.ts # 插件管理器（生命周期、工具注册、钩子调度）
├── config.ts         # 配置加载（从 workspace 读取）
├── client.ts         # 模型客户端兼容导出
├── model/            # 模型协议适配层
│   ├── types.ts      # ModelClient 接口
│   ├── index.ts      # createModelClient 工厂
│   ├── anthropic.ts  # Anthropic Messages 兼容协议实现
│   ├── openai.ts     # OpenAI Chat Completions 兼容协议实现
│   ├── request-repair.ts # 模型请求错误修复策略链
│   ├── local.ts      # node-llama-cpp 本地模型适配器
│   ├── local-catalog.ts # 内置 Qwen / Gemma GGUF 模型目录
│   └── local-store.ts # 本地模型下载、状态与持久化清单
├── history.ts        # 滑动窗口消息历史
├── estimate-tokens.ts # Token 估算（供 compress 插件使用）
├── sub-agent.ts      # 并行 sub-agent 执行器（受限工具 + 临时 AgentSession）
├── types.ts          # 共享类型定义
├── prompts/          # 默认提示词模板
│   ├── default.md    # 主 agent system prompt 模板
│   └── sub_agent.md  # sub-agent 任务提示词模板
├── plugins/          # 插件系统
│   ├── types.ts      # Plugin、PluginContext、PluginHooks、HookContext 接口
│   ├── loader.ts     # 插件加载器（内置/外部动态加载）
│   ├── core/         # 核心插件包（始终启用）
│   │   ├── index.ts  # 聚合导出所有核心插件
│   │   ├── tools.ts  # 基础工具注册插件（文件、搜索、记忆、技能等）
│   │   ├── sub-agent.ts # sub-agent 插件（注册 sub_agent_run 工具）
│   │   ├── prompts.ts # 提示词构建插件（模板加载+占位符替换）
│   │   ├── history.ts # 会话历史插件（用户消息进入 MessageHistory）
│   │   ├── session-summary.ts # 会话滚动摘要插件（摘要 + 最近几轮原文）
│   │   ├── auto-memory.ts # 自动记忆插件（每 10 轮批量整理长期记忆）
│   │   ├── plan.ts # 计划执行模式（工具、状态机、恢复 API）
│   │   ├── attachments.ts # 图片上传路由与 session 附件存储
│   │   ├── compress.ts # 上下文压缩插件（阈值判断+模型摘要）
│   │   └── logger.ts # 日志插件（通过钩子记录所有事件）
│   └── feishu/       # 飞书插件（平台适配器）
│       ├── index.ts  # 插件入口
│       ├── client.ts # FeishuClient
│       └── handler.ts # 事件处理
├── tools/            # 工具实现（工厂函数，供核心插件导入）
│   ├── registry.ts   # 工具注册中心（由 PluginManager 内部持有）
│   ├── search.ts     # 网络搜索（多 provider）
│   ├── web_fetch.ts  # 网页内容获取
│   ├── bash.ts       # Shell 命令执行
│   ├── file_read.ts  # 文件读取
│   ├── file_write.ts # 文件写入
│   ├── file_edit.ts  # 文件精确替换
│   ├── project-tree.ts # 项目目录树（异步、边界与数量限制）
│   ├── project-search.ts # 项目结构化搜索（ripgrep）
│   ├── project-git.ts # 项目 Git 状态与 Diff 工具
│   ├── plan.ts       # 计划创建与步骤状态更新工具
│   ├── memory.ts     # 持久化记忆（读写 memory/*.md）
│   ├── skill.ts      # 技能系统（加载/激活 skills/*.md）
│   └── sub_agent.ts  # sub_agent_run 工具定义
└── workspace/        # 工作目录相关
    ├── workspace.ts  # 目录初始化、身份加载
    └── logger.ts     # 追加式文件日志（history + 执行日志）
web/                    # Web UI（React + Vite）
├── src/
│   ├── lib/           # SSE 客户端、API 封装
│   └── components/    # UI 组件
├── dist/              # 构建产物（Gateway 直接服务）
└── package.json       # 前端独立依赖
desktop/                # Electron macOS 桌面壳
├── main.ts             # 应用生命周期、Gateway 子进程与 BrowserWindow
├── workspace.ts        # 桌面 workspace 首次初始化
└── tsconfig.json       # 桌面主进程独立编译配置
```

## 桌面应用

macOS 桌面版使用 Electron 承载现有 Web UI，不改变 Agent Loop 和插件边界。Electron 主进程创建窗口后先加载内置浅色启动页，展示应用 Logo 和服务启动状态；同时启动独立 Gateway 子进程，Gateway 就绪后在同一窗口切换到本机随机端口上的 Web UI。窗口不直接开放 Node.js 能力。受 sandbox 和 context isolation 保护的 preload 只暴露 `selectProjectDirectory()`，通过固定 IPC 请求调用系统目录选择器；主进程仅接受当前主窗口的请求。浏览器版没有该桥接能力，继续使用手动路径输入。桌面主进程创建系统菜单栏图标，关闭主窗口时只隐藏窗口并保持 Gateway 常驻；点击菜单栏图标、Dock 图标或再次启动应用会恢复并聚焦现有窗口。只有通过菜单栏“退出 tiny-claw”、`Command+Q` 等显式退出应用时，主进程才向 Gateway 发送 `SIGTERM`，等待其销毁插件并关闭 HTTP 服务。

桌面版 workspace 默认位于 `~/Library/Application Support/tiny-claw/workspace`。首次启动由统一配置初始化器生成不含真实密钥的完整默认配置，应用升级和重新安装不会覆盖已有配置、会话、记忆、技能及插件。开发模式和 CLI/Gateway 模式仍使用原有 `./workspace` 或显式指定的目录。

macOS 发布由 Tag 触发 GitHub Actions。流水线在临时钥匙串中导入 Developer ID Application 证书，签名 Electron 应用并生成 DMG，然后使用 Apple `notarytool` 公证最终 DMG、装订公证票据并验证签名与磁盘映像完整性。证书、私钥密码和 Apple 公证凭据仅通过 GitHub Actions Secrets 注入，临时钥匙串在任务结束时删除。

## 工作目录结构

tiny-claw 运行时需要一个工作目录（workspace），所有持久化数据都放在其中。工作目录路径通过 `--workspace` CLI 参数或 `TINY_CLAW_WORKSPACE` 环境变量指定，默认为 `./workspace`。

```
workspace/
├── config.json        # 配置（API key、模型、工具权限等）
├── identity.md        # 身份设定（注入 system prompt 模板 {{identity}} 占位符）
├── system_prompt.md   # 可选：自定义 system prompt 模板（不存在则使用默认模板）
├── sub_agent_prompt.md # 可选：自定义 sub-agent 任务提示词模板
├── skills/            # 自定义技能（skills/<name>/SKILL.md）
├── memory/            # 跨会话长期记忆（Markdown + frontmatter）
├── sessions/          # 按会话持久化消息、会话摘要、auto-memory 增量状态
│   └── <encoded-session-id>/
│       ├── messages.jsonl
│       ├── meta.json
│       ├── state.json
│       ├── plans/          # 按对话轮次持久化的结构化任务计划与步骤进度
│       └── attachments/   # 图片文件及附件元数据
└── logs/              # 执行日志，[时间] [级别] 消息，每日轮转
    └── 2026-05-19.log
```

## 项目开发模式

项目开发模式建立在持久化的 `SessionContext` 上。普通会话使用 `{ mode: "chat" }`；项目会话在创建时绑定规范化后的项目真实路径，并把 `{ mode: "project", project: { root, name } }` 写入 `sessions/<session>/meta.json`。绑定创建后不可修改，后续 `/chat` 只接收 `session_id`，不会从请求中临时切换项目。

`core-project` 插件负责 `/projects/inspect`、`/projects/status`、`/projects/diff` 路由和项目提示词注入。静态项目检查只识别技术栈与规则文件，并按文件签名缓存；动态 Git 状态与 diff 通过异步子进程按需读取，不阻塞 Gateway 事件循环，也不重复注入模型上下文。Git 参数使用数组传递而不拼接 shell 字符串，超时和 diff 最大字符数由 `project.gitTimeoutMs`、`project.diffMaxChars` 控制。读取 `.tiny-claw/rules.md` 和根目录 `AGENTS.md` 时应用单文件与总字符上限。Gateway 只维护一个 `PluginManager`，项目根目录和有效配置通过 session 运行时上下文传递给插件及工具。

`core-project-tools` 插件注册 `project_tree`、`project_search`、`git_status`、`git_diff` 四个只读开发工具。工具注册支持基于 `SessionContext` 的可用性过滤，因此普通会话不会把项目工具定义发送给模型。目录树使用异步文件系统 API，并跳过依赖、版本库和常见构建目录；项目搜索使用 `rg --json` 解析结构化结果，达到结果数、字符数或超时上限时主动终止子进程。四个工具都强制使用项目根目录和符号链接边界校验，并继承统一权限审批与审计日志。

WebUI 打开项目时使用前端互斥锁和 loading 状态阻止重复提交，并用 `project.openTimeoutMs` 控制检查与会话创建总时限。Gateway 的 `reuseEmpty` 语义会复用同一项目最近的空闲空会话，作为重复请求的第二层保护。项目栏展示分支、工作区状态和变更文件，任务完成后自动刷新；diff 仅在用户选择文件时按需加载。

项目会话的有效配置在创建 `AgentSession` 时由全局配置和 `project` 段合并：项目工具配置覆盖项目模式，项目模式覆盖全局配置；未显式配置时项目危险操作默认 `ask`。工具执行时从 `ToolExecutionContext` 获取有效配置，禁止自行重新加载未合并的全局权限。项目模式下 bash 和文件工具的相对路径基于项目根目录，绝对路径、`..` 和符号链接均不能越过项目边界；sub-agent 继承父会话的项目上下文。

WebUI 先调用 `/projects/inspect` 检查目录，选择成功后立即通过 `POST /sessions` 创建项目会话，不等待用户发送第一条消息。应用启动时读取持久化 Session 列表，分别恢复普通对话和项目模式最后使用的 Session；切换视图时恢复各自状态。右侧功能页面由 `view` 控制，左侧普通会话/项目列表由独立的 `sidebarMode` 控制，因此从项目进入记忆、日志或设置时仍保留项目列表。项目侧栏按 `SessionContext.project.root` 分组：项目行显示持久化目录名并提供项目级新对话和删除按钮，下面缩进显示该项目的会话预览；顶部“新建项目”单独进入目录选择流程。项目不是独立持久化实体，删除项目会复用 Session 删除接口清理该目录关联的全部会话及会话数据，但不会删除用户选择的本地项目目录或其中的文件。

## 计划执行模式

计划模式在执行层仍是每轮请求的临时 `ExecutionMode`，不修改 Session 的普通/项目上下文绑定；用户选择则作为 `meta.json` 中可变的 `preferences.executionMode` 持久化。WebUI 切换模式时立即更新 Session 偏好，发送 `POST /chat` 时再次携带并兜底保存；刷新、切换会话和 Gateway 重启后从 Session 元数据恢复各自选择。AgentSession 在本轮开始时把模式注册到 PluginManager，审批暂停时将模式写入待恢复状态，恢复执行后继续沿用，最终在本轮结束时清理。工具注册支持同时按 `SessionContext` 和 `ExecutionMode` 过滤，因此 `plan_create`、`plan_update` 只在计划模式下发送给模型。

`core-plan` 插件通过 `onBuildTurnPrompt` 注入不进入历史记录的本轮计划规则，并负责计划工具、状态机及 `GET /plan?session_id=...` 恢复接口。每轮消息生成独立 `turnId`，消息和 Hook 只把该标识作为内部元数据使用，调用模型前会将其剥离。计划原子写入 `sessions/<session>/plans/<turnId>.json`，步骤状态为 pending、in_progress、completed、failed、skipped、waiting_approval；同一时间只能有一个执行中步骤且必须按顺序推进。需要审批时插件把当前步骤切换到 waiting_approval，恢复工具执行前切回 in_progress；迭代上限和执行错误会明确标记当前步骤失败。

模型输出无工具调用的最终回复时，如果当前步骤是唯一未结束的执行中步骤，插件会通过计划状态机自动将其标记为 completed，避免模型遗漏最后一次 `plan_update` 而把已经完成的任务误判为失败。只要仍有其他 pending 或执行中步骤，就不会自动收尾，仍按计划提前结束处理。

WebUI 收到计划工具结果或终止事件后重新读取持久化计划，避免解析模型自然语言或依赖单条 SSE 连接。执行中或等待审批的计划显示在输入框上方；完成或失败后，历史消息接口按 `turnId` 将计划挂到对应轮次的最终助手消息下。切换 Session、刷新页面和 Gateway 重启后均能恢复每轮计划，后续对话不会覆盖或全局展示旧计划。

WebUI 以单条助手消息作为工具调用的展示边界。同一轮出现多个工具调用时聚合为一个可展开面板，完成后显示成功和失败数量并默认折叠，展开后的列表限制高度并独立滚动。仍在执行的调用默认展开；只要存在待审批调用，聚合面板就强制展开且不能折叠，确保审批入口持续可见。单个工具调用继续使用原有工具卡片，不增加额外层级。

### config.json

仓库提供两个配置示例：`config.simple.example.json` 是推荐入门配置，`config.all.example.json` 是完整配置参考。实际运行时只读取 `workspace/config.json`。

Gateway 和 AgentSession 启动时会调用 `ensureConfigFile()`：配置文件不存在时生成完整默认配置，已存在时绝不覆盖。远程模型与本地模型可分别启用，同时启用时模型工厂固定优先选择远程模型；仅启用本地模型时不要求 API Key。本地模型目录、显式后台下载、字节级进度和独立连通性测试由 `core-local-models` 插件提供，GGUF 文件及清单保存在 `workspace/models/`。目录覆盖 Qwen3.5 与 Gemma 4 的不同参数规模，WebUI 通过插件路由动态读取，不维护独立的硬编码型号列表。选择本地模型不会触发下载，只有调用下载路由后才开始。每个本地模型在目录中声明建议内存、推荐上下文与模型上限，运行时和 `core-compress` 使用同一个实际上下文值，防止压缩逻辑按远程模型窗口计算而让本地推理溢出。配置 API 保存后会释放空闲会话，使模型与上下文配置在下一次消息时重新加载。

本地模型适配器在模型首次输出工具调用时立即终止当前次生成，只把工具调用交回 Agent Loop；它不会向模型注入占位工具结果。工具实际执行并返回真实结果后，Agent Loop 才开始下一次模型调用，确保等待审批期间不会生成基于虚假结果的回答。

| 字段 | 说明 | 默认值 |
|------|------|--------|
| apiUrl | API 基础地址 | 必填 |
| remoteModel | 远程模型启用状态 | enabled=true |
| localModel | Qwen/Gemma 本地模型、上下文与启用状态 | enabled=false, modelId=qwen3.5-4b-q4, contextSize=32768 |
| apiKey | API 密钥 | 必填 |
| model | 模型标识 | 必填 |
| modelProvider | 模型协议适配器 | anthropic-messages |
| maxTokens | 单次响应最大 token | 16384 |
| maxContextTokens | 上下文最大 token 估计 | 128000 |
| contextCompressionThreshold | 压缩触发阈值（占比） | 0.7 |
| contextCompressionMaxOutputTokens | 压缩摘要模型输出 token 上限 | 2048 |
| historyWindowSize | 历史窗口（轮） | 5 |
| maxAgentIterations | Agent Loop 最大迭代次数；达到上限时明确提示，显式配置 0 表示不限 | 100 |
| sessionSummary | 会话滚动摘要配置 | enabled=true, persistent=true, turnThreshold=5, recentTurns=3 |
| autoMemory | 自动记忆配置 | enabled=true, turnThreshold=10 |
| memory | 长期记忆容量限制 | maxItemChars=20000, maxTotalChars=80000 |
| attachments | 图片附件配置 | enabled=true, 每条最多 4 张、单张 10 MB |
| debug | Debug 模式配置，可记录模型原始输入输出 | enabled=false |
| security | 基础安全边界：bash 策略、Gateway host/token、工具审计 | 见下文 |
| project | 项目会话权限、历史窗口与迭代上限 | security.mode=ask, historyWindowSize=8, maxAgentIterations=100 |
| searchProvider | 搜索引擎 (ollama/searxng/brave/duckduckgo) | ollama |
| ollamaApiKey | Ollama Web Search API key | - |
| searxngUrl | SearXNG 实例地址 | - |
| braveApiKey | Brave Search API key | - |
| enabledPlugins | 启用的内置插件列表 | [] |
| externalPlugins | 外部插件模块路径列表 | [] |
| plugins | 插件配置（按插件名命名空间） | {} |
| subAgent | Sub-agent 配置（工具权限、迭代数、并发数） | 见下文 |

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

### sub_agent_prompt.md（可选）

自定义 sub-agent 任务提示词模板，覆盖默认模板 `src/prompts/sub_agent.md`。该模板用于 `sub_agent_run` 工具内部创建的临时 AgentSession，和主 agent 的 system prompt 分开管理。

**可用占位符：**

| 占位符 | 替换内容 |
|--------|----------|
| `{{task}}` | 当前子任务描述 |
| `{{context}}` | 子任务补充上下文 |
| `{{allowed_tools}}` | 当前 sub-agent 可用工具列表 |
| `{{current_date}}` | 当前日期（如 2026-05-22） |

### subAgent 配置

`sub_agent_run` 支持一次并行启动多个临时 sub-agent。默认只开放读取/检索类工具，不允许执行 shell、写文件或保存记忆。

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

- `allowedTools`：sub-agent 允许注册的工具白名单；未配置时使用默认只读工具集
- `disabledTools`：在白名单基础上额外禁用的工具
- `maxIterations`：每个 sub-agent 的最大 Agent Loop 轮数，硬上限为 8
- `maxConcurrency`：一次 `sub_agent_run` 最多并发的 sub-agent 数，硬上限为 8
- `sub_agent_run` 始终禁用，避免 sub-agent 递归派生 sub-agent

### security 配置

文件工具支持访问 workspace 外部文件：相对路径以 workspace 为基准，也可以传入绝对路径或使用 `..`。`bash` 可通过 `cwd` 在任意目录执行命令。Shell 和 Gateway 暴露范围通过 `security` 配置：

```json
{
  "security": {
    "mode": "allow",
    "tools": {
      "bash": {
        "mode": "ask"
      },
      "memory_delete": {
        "mode": "deny"
      }
    },
    "gateway": {
      "host": "127.0.0.1",
      "token": ""
    },
    "auditTools": true
  }
}
```

- `security.mode`：全局危险操作权限模式，默认 `allow` 自动执行；`ask` 创建一次性审批记录；`deny` 拒绝执行。
- `security.tools.<tool>.mode`：单个工具权限模式，覆盖全局模式。`bash` 工具和技能动态 shell 统一使用 `security.tools.bash.mode`。
- `gateway.host`：Gateway API 监听地址，默认 `127.0.0.1`。暴露到其他机器时应同时配置 token。
- `gateway.token`：可选 Bearer token。配置后 API 请求需要携带 `Authorization: Bearer <token>`。
- `auditTools`：是否把工具调用和完成状态写入日志，默认开启。审计日志不会记录文件内容或记忆内容。

`ask` 模式使用进程内审批队列。审批记录按 workspace、工具名、参数和调用者身份去重，默认 10 分钟过期。单次批准后的许可只消费一次；拒绝、过期或消费后立即失效。“允许本轮”会以 session 和调用者身份建立临时授权，当前审批先按单次许可消费，后续 `ask` 工具在同一个 Agent Loop 中自动通过；`deny` 不受影响。临时授权在恢复执行结束、失败或取消后由 `AgentSession` 的 `finally` 清理，服务重启也会自然失效。Gateway 暴露 `/approvals` 系列接口，Web UI 在聊天工具块内提供“批准本次”“允许本轮”和拒绝操作，批准后会自动调用 `AgentSession.resumeApproval()` 继续原任务。飞书消息会携带用户 `open_id` 和 `chat_id`，用户可以发送 `/approvals`、`/approve <id>`、`/approve-all <id>` 或 `/reject <id>` 处理自己在当前会话发起的审批。

当工具结果包含 `requiresConfirmation: true` 时，Agent Loop 会立即暂停当前轮：审批提示会发给用户并写入历史用于 UI 恢复，但不会再把该结果回灌给模型继续总结。这样用户批准前不会产生基于“未执行命令”的最终回答；批准后由审批命令消费一次性许可并执行记录的命令。工具调用和工具结果的 SSE 事件携带同一个稳定 `tool_call_id`；Web UI 在审批续跑过程中以该 ID 实时替换原工具块中的待审批结果，并将后续工具调用和回复流投影到同一条助手消息，收到完成事件后再固化该消息，保持实时显示与刷新后的持久化历史一致。

### autoMemory 配置

`core-auto-memory` 插件在主会话最终回复后记录完整对话轮数，默认 workspace 内累计 10 轮后触发一次模型整理。它不会每轮额外调用模型；每轮最终问答会先按 session 持久化到 `workspace/sessions/<session>/state.json` 的 `autoMemory.pendingTurns`。达到阈值或用户执行 `/dream` 时，插件会聚合所有主会话的待整理增量，把已保存长期记忆全文、增量对话和配置的长度限制交给模型，并通过受限的 memory 工具调用链路整理长期记忆。

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
  "memory": {
    "maxItemChars": 20000,
    "maxTotalChars": 80000
  }
}
```

- `enabled`：是否启用自动记忆；默认启用，设置为 `false` 可关闭
- `mode`：`auto` 向整理模型开放 `memory_save/memory_delete/memory_list/memory_read`；`hybrid` 只开放保存、读取和列表，删除只能在最终文本中建议；`suggest` 只开放读取和列表，不允许写入
- `turnThreshold`：workspace 内触发模型整理的主会话完整对话轮数，默认 10
- `maxCandidates`：单次最多允许的 memory 工具调用次数，默认 5
- `maxBatchChars`：传给记忆整理模型的增量对话字符上限，默认 8000；已有启用记忆始终全文输入
- `lockTimeoutSeconds`：workspace 记忆整理锁的兜底过期时间，默认 300 秒。锁记录 owner PID；服务重启后如果原进程已经退出，新进程会立即回收残留锁，不需要等待超时。owner 信息缺失或损坏时仍按超时处理，避免误删刚创建的并发锁。
- `memory.maxItemChars`：单条记忆正文最大字符数，默认 20000
- `memory.maxTotalChars`：所有启用记忆正文的总字符上限，默认 80000

自动记忆会跳过 `sub:` 开头的 sub-agent 会话，也会跳过模型中间工具调用，只在最终回复时计入一轮。每条 pending turn 持有稳定 ID；整理开始时冻结待处理 ID 快照，成功后通过 Session 状态原子更新只删除本次处理的 ID，整理期间新增的轮次不会丢失。workspace 级文件锁避免多进程并发整理，Session 状态锁避免会话摘要和自动记忆整文件覆盖。整理失败或触发权限审批时保留 pending。即使没有新增对话，`/dream` 也会运行一次 workspace 级整理。记忆写入统一校验 `memory.maxItemChars` 和 `memory.maxTotalChars`，超限时返回可重试错误，不会静默截断后落盘。

### 图片附件

`core-attachments` 插件注册 `POST /uploads` 和 `GET /uploads`，上传文件按 session 保存到 `workspace/sessions/<session>/attachments/`。消息历史只持久化附件 ID、相对路径和 MIME 类型，不保存 Base64；模型调用时由协议适配器读取文件，OpenAI Chat 转为 `image_url` data URL，Anthropic Messages 转为 base64 image block。删除 session 时附件目录会随 session 一起删除。

上传端会校验文件签名、声明 MIME、文件大小和允许类型，附件只能在所属 session 中引用。WebUI 支持选择或粘贴 PNG、JPEG、WebP、GIF 图片，发送前可预览和移除。

## 核心数据流

```
用户输入
  ↓
PluginManager 加载核心插件（tools, sub-agent, prompts, history, session-summary, auto-memory, compress, logger）
  ↓
AgentSession 初始化 → PluginManager.setRuntimeDeps()
  ↓
┌─── Agent Loop ───────────────────────────────────┐
│  onBeforeChat 钩子 → 日志记录 / 阻断 / 输入修改  │
│       ↓                                          │
│  onBuildPrompt 钩子 → 构建系统提示词（懒加载）   │
│       ↓                                          │
│  onUserMessage 钩子 → 推送用户消息到 MessageHistory│
│       ↓                                          │
│  history.getRecentMessages(N)                     │
│       ↓                                          │
│  onBeforeModelCall 钩子 → 上下文压缩 / 消息修改  │
│       ↓                                          │
│  client.chat(messages, tools, onDelta,            │
│              systemPrompt)                        │
│       ↓                                          │
│  response = { text, toolCalls }                   │
│       ↓                                          │
│  onChatResponse 钩子 → 会话摘要 / 自动记忆整理    │
│       ↓                                          │
│  push assistant message + appendHistory           │
│       ↓                                          │
│  onAfterIteration 钩子                            │
│       ↓                                          │
│  有 toolCalls?                                    │
│    是 → onBeforeTool 钩子 → 执行工具             │
│         → onAfterTool 钩子 → push tool_result    │
│         → 回到循环顶部                            │
│    否 → 跳出循环，等待用户输入                    │
└──────────────────────────────────────────────────┘
```

Agent Loop 是核心：模型自主决定是否调用工具，工具执行结果反馈给模型，模型继续输出，直到无工具调用时将最终回答交给用户。

### 运行稳定性

- 同一 session 同一时间只允许执行一个任务，避免历史消息和工具结果交错。
- `AgentSession.cancel()` 会中止当前模型请求，并把取消信号传给工具；`bash` 收到信号后终止子进程。
- Gateway 在 SSE 客户端断开时自动取消后台任务，也提供 `POST /sessions/:id/cancel` 主动取消接口。
- 活跃任务不会被空闲会话清理器删除。
- 模型调用、hook 和工具异常会进入 `onError` hook；工具异常仍会转换为结构化结果反馈给模型。
- 配置加载和 Gateway 配置更新都会执行 schema 校验。非法配置不会写回磁盘。

## 关键设计决策

### 技术栈：TypeScript

项目涉及消息格式、工具 schema、API 响应等大量结构化数据，类型安全显著减少 bug。

### 零运行时依赖

Node 22 内置 fetch、readline/promises、TextDecoder，不需要额外 HTTP/IO 库。开发依赖仅 typescript、@types/node、tsx。

### 模型协议适配层

模型接入封装在 `src/model/` 中，Agent 和插件只依赖统一的 `ModelClient` 接口：

```ts
interface ModelClient {
  complete(messages, systemPrompt?): Promise<string>;
  chat(messages, onDelta, tools?, systemPrompt?): Promise<ChatResponse>;
}
```

`createModelClient(config)` 根据 `config.modelProvider` 创建具体协议适配器。旧的 `src/client.ts` 保留为兼容导出。

| modelProvider | 协议 | 实现 |
|---|---|---|
| `anthropic-messages` | Anthropic Messages API 兼容协议 | `src/model/anthropic.ts` |
| `openai-chat` / `chatgpt` | OpenAI Chat Completions 兼容协议 | `src/model/openai.ts` |

Anthropic Messages 兼容实现的注意点：
- 认证用 `x-api-key` header（与标准 Anthropic 一致）
- base_url 不含版本号，客户端拼接 `/v1/messages`
- 部分模型（如 kimi-k2.6）有 thinking 输出，适配器过滤 thinking_delta，只输出 text_delta

OpenAI Chat 兼容实现会将内部消息格式转换为 `system/user/assistant/tool` messages，并把内部工具定义转换为 OpenAI `tools: [{ type: "function", function: ... }]` 格式。

模型请求失败后可进入 `request-repair.ts` 的有限修复策略链。每个修复器根据 provider、模型、HTTP 状态、错误响应和原始请求体判断是否可修复，并且在同一次请求中最多执行一次；所有策略执行机会耗尽后返回原始 API 错误，避免无限重试。当前 OpenAI 适配器可在服务端明确拒绝 `max_tokens` 时自动改用 `max_completion_tokens` 重试，并在当前客户端实例中缓存已确认的参数选择，流式聊天和非流式摘要共用该流程。

### Debug 模式

`config.json` 支持开启 Debug 模式，用于排查模型调用：

```json
{
  "debug": {
    "enabled": true,
    "modelIO": true,
    "rawStreamEvents": true
  }
}
```

模型适配器不直接写文件，而是通过 `onModelDebug` 生命周期事件把结构化数据交给 `core-debug` 插件。插件按 Request ID 写入 `workspace/debug/model-calls/YYYY-MM-DD/<requestId>.json`，并通过 `GET /debug/model-calls` 提供列表与详情查询，Web UI 的“日志 → 模型调用”负责展示。

模型调用页面只展示“请求原文”和“最终回复”：最终回复优先使用 `parsed_response`，缺失时回退到 `response` 或 `error`。`stream_event` 和 `repair` 仍保留在 trace 文件中供底层排查，但不在页面中逐条展示。

远程模型与 `local-llama` 本地模型统一通过 `onModelDebug` 生命周期写入调用记录。本地模型记录请求参数、消息、工具定义、最终解析结果和错误，不记录逐 Token 流事件；记录携带实际模型 ID 和 session ID，可与远程模型调用一起筛选和查看。

- `request`：发送给模型的原始请求体
- `stream_event`：流式接口返回的原始 SSE JSON 事件
- `response`：非流式接口返回的原始 JSON
- `parsed_response`：解析后的文本与工具调用
- `error` / `repair`：错误响应与请求修复过程

同一逻辑请求的重试共用一个 Request ID。插件不会持久化认证请求头，并会移除图片 Base64 数据；请求体仍可能包含用户输入、工具结果、system prompt 和记忆内容，仅建议本地排查时开启。

原始流事件在模型调用期间先由 `core-debug` 插件按 Request ID 聚合，收到最终响应或错误后再批量写入 trace。请求事件仍立即落盘，因此可以看到正在运行的调用，同时避免每个流事件同步重写整份 JSON 阻塞 Agent Loop。

### SSE 连接稳定性

Gateway 在聊天和审批续跑的 SSE 响应空闲期间发送注释心跳，间隔由 `security.gateway.sseHeartbeatIntervalMs` 配置，默认 15000 毫秒。心跳只维持连接，不进入 Agent 事件流。插件可以在耗时 Hook 中通过 `ModelCallContext.reportStatus()` 产生临时 `status` 事件；WebUI 只在当前处理状态中展示，收到正文、工具调用或终止事件后清除，不写入会话历史。Web UI 以 `done.text` 作为最终回答的权威内容；`done.reason` 区分正常完成、等待审批和达到迭代上限。达到上限时 Agent 会先输出明确停止提示，再发送 `iteration_limit` 完成事件。如果流在 `done` / `error` 前意外关闭，会重新读取当前 session 的持久化历史，仅在确认当前用户消息之后已有 assistant 结果时恢复界面。

### 消息历史：滑动窗口

`historyWindowSize` 按用户轮次计算。进入新一轮前先移除旧轮次的 `tool_use` / `tool_result`，再从后向前保留最近 N 条用户消息及其后续可读助手文本；工具密集型任务不会因为中间工具消息过多而挤掉原始用户问题。当前轮工具链不参与裁剪。默认 5 轮。

### 上下文压缩（插件化）

上下文压缩逻辑位于 `plugins/core/compress.ts`，通过结构化的 `onBeforeModelCall` 上下文执行。Agent 先从模型上下文窗口中扣除系统提示词、工具定义和最大输出空间，再取 `contextCompressionThreshold` 与硬输入上限中的较小值作为消息预算：

1. **只压缩历史轮次**：`turnStartIndex` 之前尚未进入摘要的消息用于增量更新唯一的 `[当前会话摘要]`；当前用户轮次及其中完整工具链不参与摘要或任意切分。
2. **摘要和游标持久化**：摘要正文与 `summaryThroughTimestamp` 原子写入 `sessions/<session>/state.json`，刷新、切换会话或 Gateway 重启后继续增量压缩，不重复摘要已覆盖消息。
3. **近期原文按完整用户轮次保留**：压缩后从配置的 `sessionSummary.recentTurns` 开始逐轮缩减，直到满足预算；不会从轮次中间截断消息。
4. **工具结果受控截断**：仅缩短 `tool_result.content`，保留 `tool_use` / `tool_result` 协议结构；最终调用模型前再次校验工具消息链。
5. **失败显式终止**：压缩模型失败时保留原始合法上下文，不静默丢弃历史；若仍超预算，Agent 返回明确错误而不调用主模型。
6. **过程状态可见**：真正调用摘要模型时依次上报压缩开始和完成/失败状态，并附带压缩前后的 token 估算；这些状态只进入实时事件流。

token 估算采用统一粗略规则，只用于预算保护。压缩使用 `client.complete()` 非流式调用，摘要字符硬上限由 `contextCompressionMaxChars` 控制，模型输出 token 上限由 `contextCompressionMaxOutputTokens` 控制。

### 会话滚动摘要

核心插件 `core-session-summary` 为每个普通会话维护一份滚动摘要，减少旧消息原文进入模型上下文。摘要默认每 5 个完整对话轮次更新一次，不会每轮额外调用模型；摘要状态默认持久化到 `workspace/sessions/<session>/state.json`，以便刷新、切换会话或 Gateway 重启后恢复：

1. `onBeforeModelCall`：移除旧摘要消息；如果已有摘要，优先保留上次摘要后尚未沉淀的增量消息和当前轮消息，并将摘要合并进下一条 user 消息前部。没有未沉淀增量时，回退保留最近 `recentTurns` 轮原文。
2. 摘要尚未生成时，不会因为 `recentTurns` 提前裁掉历史，仍由 `historyWindowSize` 控制底层历史窗口。
3. `onChatResponse`：当模型给出最终回复（没有 tool_calls）后，累计本轮增量消息；达到 `turnThreshold` 后调用 `client.complete()`，用“已有摘要 + 累计增量上下文”更新会话摘要。
4. `onTurnEnd`：Agent 因迭代上限停止时，把本轮原始用户问题、可读助手进度和停止提示写入待摘要状态，不保存工具调用与工具结果；审批暂停不计为完整轮次。
5. `sub:` 开头的临时 sub-agent 会话跳过摘要，避免额外模型调用。

默认配置：

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

其中 `turnThreshold` 是摘要刷新频率，`recentTurns` 是已有摘要后仍保留的近期原文窗口，二者不需要和 `historyWindowSize` 相同。

完整原始消息写入 `workspace/sessions/<session>/messages.jsonl`，会话列表来自 `workspace/sessions/<session>/meta.json`；滚动摘要写入 `workspace/sessions/<session>/state.json`，只作为会话级模型上下文状态，不写入长期 memory，也不污染 UI 历史回放。

### 工具注册：插件化

工具通过 `ToolRegistry.register(tool)` 注册，由 `PluginManager` 内部持有 `ToolRegistry` 实例。核心插件 `plugins/core/tools.ts` 在初始化时通过 `ctx.registerTool()` 注册基础内置工具，`plugins/core/sub-agent.ts` 单独注册 `sub_agent_run`。

插件也可以注册自己的工具，通过 `PluginContext.registerTool()` 方法。所有插件的工具统一合并到 PluginManager 的 ToolRegistry 中，模型调用时通过 `getTool(name)` 查找执行。新增工具只需：1) 在任意插件中实现 Tool 接口 2) 在插件 init 中注册。

`PluginManager` 支持工具白名单/黑名单过滤（`allowedTools` / `disabledTools`），用于 sub-agent 等需要收敛权限的场景。工具在注册阶段被过滤，模型看不到被禁用的工具定义，也无法调用这些工具。文件工具支持 workspace 外路径；危险操作默认允许执行，可通过 `security.mode` 或 `security.tools.<tool>.mode` 改为 `ask` 或 `deny`。

### 聊天命令注册：插件化

聊天命令通过 `PluginContext.registerChatCommand()` 注册，由 `PluginManager` 在用户输入进入 Agent Loop 前统一解析和分发。命令只在用户显式输入 `/command` 时触发，不暴露给模型调用。核心插件 `plugins/core/chat-commands.ts` 注册 `/help`、`/new`、`/context`、`/dream`、`/approvals`、`/approve`、`/approve-all` 和 `/reject`；workspace 插件也可以注册自己的命令。`/dream` 会复用 `core-auto-memory` 的整理入口，立即触发 workspace 级长期记忆整理。

Web `/chat` 和飞书消息入口都会先调用 `executeChatCommand()`，命中命令时直接返回结果，不写入模型上下文。未以 `/` 开头的普通消息才进入 Agent Loop。

Gateway 的 `GET /commands` 从 `PluginManager.getChatCommands()` 动态返回命令元数据，WebUI 使用该接口实现斜杠命令补全。因此 workspace 插件注册的自定义命令和别名无需修改前端即可显示；补全只填充输入框，不会直接执行命令。

### 搜索引擎：多 Provider 架构

web_search 工具支持四个搜索引擎，通过 `config.json` 的 `searchProvider` 字段切换：

| Provider | 说明 | 配置 |
|----------|------|------|
| ollama（默认） | Ollama Web Search API，支持常规查询和网页摘要 | 需配置 `ollamaApiKey` |
| duckduckgo | DuckDuckGo Instant Answer API，无需 key，适合简短英文实体查询 | 无额外配置 |
| searxng | 自建 SearXNG 实例，返回完整搜索结果 | 需配置 `searxngUrl` |
| brave | Brave Search API，结果质量好 | 需配置 `braveApiKey` |

注意：DuckDuckGo provider 使用 Instant Answer API（返回摘要/定义），不是完整搜索结果列表，但无需配置即可使用。仅在使用 DuckDuckGo 时，系统提示词和工具描述会要求模型优先使用 1-3 个简短英文实体关键词；Ollama、SearXNG 和 Brave 使用常规搜索查询即可。如需完整搜索结果，优先推荐 Ollama。

### 内置工具

| 工具 | 用途 | 安全措施 |
|------|------|----------|
| web_search | 网络搜索（多 provider） | 按配置选择引擎 |
| web_fetch | 获取网页内容 | 15 秒超时、50KB 截断、仅支持文本类内容 |
| bash | 在指定目录执行 shell 命令 | 支持任意 cwd、超时控制（默认30秒）、输出截断（10KB） |
| file_read | 读取文件 | 相对路径以 workspace 为基准，也支持绝对路径 |
| file_write | 写入文件 | 自动创建父目录 |
| file_edit | 精确替换文本 | old_text 必须唯一匹配，防止误替换 |
| memory_save | 保存/覆盖长期记忆，写入 frontmatter 元数据 | name 防路径遍历（仅允许字母、数字、_-） |
| memory_append | 追加内容到已有记忆 | 同上 |
| memory_list | 列出长期记忆摘要索引 | 用于快速查看记忆列表 |
| memory_read | 读取指定记忆完整内容 | 已知记忆名称时使用 |
| memory_delete | 删除指定记忆 | 仅在用户明确要求删除时使用 |
| skill_use | 激活一个技能 | 技能不存在时返回可用列表 |
| skill_list | 列出所有可用技能 | 无参数 |
| sub_agent_run | 并行启动临时 sub-agent 执行子任务 | 默认只读工具集、权限可配置、禁止递归 |

bash 工具用 `child_process.spawn` 执行，返回 `{ stdout, stderr, exitCode }`。file_edit 采用唯一匹配策略：`old_text` 在文件中必须只出现一次，否则报错，避免误修改。

### Sub-agent

Sub-agent 通过核心插件 `core-sub-agent` 提供，对主 agent 暴露为普通工具 `sub_agent_run`。从主 agent 的消息协议看，它和 `web_fetch`、`file_read` 一样是一次标准工具调用：主 agent 传入任务，工具返回 JSON 结果。区别在于工具内部会创建一个或多个临时 `AgentSession`，让它们独立执行子任务。

**通信模型：**

```
主 AgentSession
  ↓ tool_use: sub_agent_run({ tasks, max_iterations, max_concurrency })
core-sub-agent 插件
  ↓
runSubAgents() 并发创建临时 AgentSession
  ↓
每个 sub-agent 使用受限工具集独立执行
  ↓
返回 { status, results[] } 作为 tool_result
  ↓
主 AgentSession 读取结果继续推理
```

**工具参数：**

| 参数 | 说明 |
|------|------|
| `task` | 单个子任务描述；如果提供 `tasks` 则忽略 |
| `context` | 单个子任务的补充上下文 |
| `tasks` | 多个可并行执行的子任务，每项包含 `id`、`task`、`context` |
| `max_iterations` | 本次调用覆盖每个 sub-agent 的最大迭代数 |
| `max_concurrency` | 本次调用覆盖最大并发数 |

**返回结构：**

```json
{
  "status": "completed",
  "results": [
    {
      "id": "task-1",
      "status": "completed",
      "summary": "子任务结论...",
      "toolCalls": [
        { "name": "file_read", "input": { "path": "src/agent.ts" } }
      ]
    }
  ]
}
```

**权限模型：**

Sub-agent 默认只允许 `web_search`、`web_fetch`、`file_read`、`memory_list`、`memory_read`、`skill_list`、`skill_use`。`bash`、`file_write`、`file_edit`、`memory_save`、`memory_append`、`memory_delete` 默认不可用。`sub_agent_run` 始终不可用，防止递归创建。

权限通过 `config.json` 的 `subAgent.allowedTools` 和 `subAgent.disabledTools` 配置。实现上，sub-agent 创建专用 `PluginManager`，并在工具注册阶段过滤工具定义，因此被禁用的工具不会进入模型可见工具列表。

**Prompt 模板：**

Sub-agent 使用独立任务提示词模板，不复用主 agent 的 system prompt。默认模板为 `src/prompts/sub_agent.md`，可用 `workspace/sub_agent_prompt.md` 覆盖。模板支持 `{{task}}`、`{{context}}`、`{{allowed_tools}}`、`{{current_date}}`。

**隔离边界：**

- 每个 sub-agent 使用独立 `AgentSession` 和独立历史
- Sub-agent 的历史不会直接合并进主 agent 历史
- 主 agent 只接收 sub-agent 的结构化汇报结果
- Sub-agent 当前不支持运行中双向对话，也不支持 sub-agent 之间通信

### 持久化记忆

记忆系统采用工具驱动的方式，让模型自主决定何时保存和读取信息：

- **写路径**：`memory_save` 和 `memory_append` 两个工具，写入 `workspace/memory/*.md`
- **读路径**：启动时 `loadAllMemories()` 读取未禁用记忆全文，注入到 system prompt 的"长期记忆"章节；`memory_list` 仍返回摘要索引，避免工具结果过大
- **文件格式**：带 frontmatter 的 Markdown，名称语义化（如 `user-preferences.md`、`project-context.md`）
- **安全**：文件名仅允许字母、数字、下划线、连字符，防止路径遍历
- **启停控制**：`disabled: true` 的记忆保留在磁盘中，但不进入 system prompt，也不参与默认 `memory_list`
- **来源标记**：`source` 记录记忆来源，取值为 `auto`、`tool`、`manual`，便于 Web UI 审计和人工整理

对比"自动提取"方案，工具驱动的优势是实现简单、透明可控，适合早期阶段。后续可在此基础上叠加自动提取（Phase 2）。

### 系统提示词模板（插件化）

系统提示词构建已迁移到 `plugins/core/prompts.ts` 插件中，通过 `onBuildPrompt` 钩子实现。

采用单文件模板方案，支持用户自定义覆盖。`src/prompts/default.md` 是默认模板，使用 `{{placeholder}}` 占位符语法。用户可在 `workspace/system_prompt.md` 放置自定义模板覆盖默认值。

模板加载逻辑：优先检查 `workspace/system_prompt.md`，存在则使用用户模板，否则使用 `src/prompts/default.md`。运行时将所有 `{{xxx}}` 占位符替换为实际内容（identity、memories、skills、tools、current_date），未匹配的占位符替换为空字符串。

其他插件可以通过 `ctx.extendPrompt()` 注册 `PromptSection`，自动追加到系统提示词末尾。

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
- **动态内容**：支持 `!`command`` 执行命令注入、`$ARGUMENTS` 参数替换、`${CLAUDE_SKILL_DIR}` 路径替换。动态命令统一遵循 `bash` 工具权限。
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
| POST | /sessions/:id/cancel | 取消会话中正在运行的任务 |
| DELETE | /sessions/:id | 销毁会话 |
| GET | /memory | 列出长期记忆 |
| GET | /memory/:name | 读取单条长期记忆 |
| PUT | /memory/:name | 更新单条长期记忆 |
| POST | /memory/:name/enable | 启用单条长期记忆 |
| POST | /memory/:name/disable | 禁用单条长期记忆 |
| DELETE | /memory/:name | 删除单条长期记忆 |

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
        ├── MemoryManager.tsx  # 长期记忆管理面板
        └── SessionSidebar.tsx # 会话列表 + 新建
```

**SSE 消费：** POST /chat 返回 SSE 流，无法使用 `EventSource`（仅支持 GET）。使用 `fetch` + `ReadableStream` 手动解析 SSE 帧，实现为 async generator。

Web UI 按 session 保存消息、流式文本、工具调用、运行状态和中止控制器。切换会话或进入其他页签不会关闭仍在运行的 SSE；流事件继续写入其所属 session，返回该会话时可恢复处理中状态和已有输出。“停止”只中止当前会话。刷新页面后的任务重连不在这一前端状态机制的范围内。

**记忆管理：** Web UI 提供"记忆"页签，支持搜索、刷新、查看、编辑、保存、删除、启用/禁用长期记忆。面板直接调用 `/memory` API，不通过 agent tool，以避免管理操作被模型行为影响。

**开发模式：** `npm run web:dev` 启动 Vite dev server（:5173），通过代理转发 API 请求到 Gateway（:3000）。

**生产模式：** `npm run web:build` 构建到 `web/dist/`，Gateway 启动时自动在独立端口启动 Web UI 服务器并代理 API 请求。默认 `http://localhost:3001`（可通过 `--web-port` 指定）。

### 插件系统

tiny-claw 采用插件化架构，主框架（AgentSession）只负责编排 Agent Loop 和在关键节点调用插件钩子，所有业务逻辑（工具注册、提示词构建、上下文压缩、日志记录）均由插件实现。

**核心原则：** 插件通过注册钩子介入流程，框架通过 PluginManager 统一调度。

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
| `registerTool(tool)` | 注册工具到全局 ToolRegistry |
| `registerChatCommand(command)` | 注册用户显式触发的斜杠聊天命令 |
| `executeChatCommand(input, options)` | 执行已注册聊天命令，供平台插件复用 |
| `registerHooks(hooks)` | 注册生命周期钩子 |
| `extendPrompt(section)` | 注册提示词片段（追加到系统提示词） |
| `getOrCreateSession(id, prefix?)` | 获取/创建 AgentSession |
| `deleteSession(id)` | 删除会话 |
| `log(level, message, sessionId?)` | 插件日志 |

**插件分类：**

1. **核心插件**（`plugins/core/`）：始终启用，实现基础功能
   - `core-tools`：注册基础内置工具（文件、搜索、记忆、技能等）
   - `core-sub-agent`：注册 `sub_agent_run`，提供并行临时 sub-agent 能力
   - `core-prompts`：系统提示词模板加载与占位符替换
   - `core-history`：将用户输入写入当前会话 `MessageHistory`
   - `core-session-summary`：维护普通会话滚动摘要，减少旧消息原文进入上下文
   - `core-compress`：上下文压缩（阈值判断 + 模型摘要）
   - `core-logger`：执行日志与对话历史写入
   - `core-debug`：模型调用调试事件的结构化持久化与查询 API

2. **用户插件**（内置/外部）：通过配置启用
   - 内置插件：放在 `src/plugins/<name>/`，通过 `enabledPlugins` 启用
   - 外部插件：npm 包或文件路径，通过 `externalPlugins` 加载
   - 每个插件的配置在 `plugins.<pluginName>` 下命名空间隔离

**生命周期钩子（PluginHooks）：**

| 钩子 | 触发时机 | 用途 |
|------|----------|------|
| `onBeforeChat` | 用户输入进入 Loop 前 | 日志、输入修改、阻断 |
| `onBuildPrompt` | 构建系统提示词 | 模板填充、内容注入 |
| `onUserMessage` | 用户输入完成预处理后 | 写入当前会话 MessageHistory |
| `onBeforeModelCall` | 调用模型 API 前 | 上下文压缩、消息修改 |
| `onChatResponse` | 模型返回后 | 响应拦截/修改 |
| `onBeforeTool` | 工具执行前 | 日志、阻断 |
| `onAfterTool` | 工具执行后 | 日志、结果修改 |
| `onAfterIteration` | 每次 Agent 迭代完成 | 状态更新 |
| `onTurnEnd` | Agent 本轮完成、等待审批或达到迭代上限 | 轮次收尾与未完成任务状态持久化 |
| `onError` | 发生错误 | 错误日志 |
| `onModelDebug` | 模型适配器产生调试事件 | 持久化请求、响应、错误与修复过程 |

钩子采用串行管道模式：按注册顺序执行，前一个钩子的返回值作为下一个的输入。

**PluginManager：**

`PluginManager` 是插件系统的核心，负责：
- 加载核心插件（始终启用）
- 加载用户插件（从配置读取）
- 维护 `ToolRegistry`（所有插件的工具合并注册）
- 维护钩子列表（负责调度）
- 维护路由注册表（Gateway 使用）
- 提供 `setRuntimeDeps()` 在 AgentSession 创建后注入 `Config` 和 `ModelClient`

**路由注册表：** Gateway 启动时通过 PluginManager 加载插件，插件通过 `registerRoute()` 注册路由。请求匹配时插件路由优先于核心路由。

**入口文件变化：**

CLI 入口和 Gateway 入口现在都需要先创建 PluginManager，加载核心插件，再将 PluginManager 传给 AgentSession：

```typescript
// CLI
const pm = new PluginManager(workspacePath);
await pm.loadCorePlugins();
const session = new AgentSession("cli", workspacePath, pm);

// Gateway
const pm = new PluginManager(workspacePath);
await pm.loadCorePlugins();
await pm.loadUserPlugins({ builtinPlugins, externalPlugins, pluginConfigs });
const session = new AgentSession(id, workspacePath, pm);
```

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
- 普通回复先发送一张占位卡片，再按 Agent 流式事件节流更新同一张卡片，避免结束后一次性返回
- 飞书文字审批绑定发起人的 `open_id` 和当前 `chat_id`，避免其他用户查看或处理审批
- 超长回复自动按换行符分段发送（~4000 字符/段）
- 支持 `onReady`/`onError`/`onReconnecting`/`onReconnected` 生命周期回调
- 插件销毁时自动关闭 WebSocket 连接

## 自动化测试

项目使用 Vitest + V8 coverage 建立自动化测试底座。测试统一使用临时 workspace，不读写真实 `workspace/`，默认不依赖模型服务、Ollama、飞书或外网。

```bash
npm test              # 执行测试
npm run test:watch    # 监听模式
npm run test:coverage # 执行测试并检查覆盖率
npm run test:e2e      # 执行 Playwright WebUI E2E
npm run test:all      # 类型检查 + coverage + WebUI build + E2E
```

当前覆盖范围：

- `MessageHistory`：历史窗口、当前轮保护、压缩替换
- 长期记忆：CRUD、禁用过滤、旧文件兼容、工具包装器
- 配置加载：默认值、搜索配置、必填字段校验
- 搜索 provider：Ollama、DuckDuckGo、Brave、SearXNG、动态 key 刷新
- `ToolRegistry`：注册、定义导出、同名覆盖
- `PluginManager`：生命周期管道、阻断、结果修改、多 session 隔离、工具权限过滤
- 插件加载器：外部插件加载、非法插件拒绝、销毁容错
- `AgentSession`：直接回复、工具回环、未知工具、工具异常、模型异常、最大迭代次数
- Gateway HTTP API：配置脱敏、Memory CRUD、会话过滤和删除、WebUI 静态代理
- WebUI E2E：Markdown 表格、记忆编辑和启停、API 错误空态

覆盖率门槛：

| 指标 | 最低要求 |
|------|----------|
| statements | 75% |
| branches | 65% |
| functions | 75% |
| lines | 75% |

`.github/workflows/test.yml` 在 push 和 pull request 时安装 Chromium 并执行 `npm run test:all`。

## 待实现

- **安全沙箱**：工具执行权限控制
- **RAG**：检索增强生成
