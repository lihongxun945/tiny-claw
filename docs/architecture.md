# Breeze Coder 架构文档

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
├── gateway-streams.ts # 当前执行快照及可重连 SSE 订阅
├── agent.ts          # AgentSession 类（核心 Agent Loop，仅编排流程+调用钩子）
├── plugin-manager.ts # 插件管理器（生命周期、工具注册、钩子调度）
├── kernel/          # 类型化插件内核（Capability、作用域与资源释放）
│   ├── capability.ts # Capability Token 与单例/多实例声明
│   ├── registry.ts # 支持优先级和父级继承的 Capability Registry
│   ├── disposable.ts # 可逆序释放的资源集合
│   ├── scope.ts # Application / Session / Turn 三级作用域
│   ├── runtime-values.ts # Session 运行依赖与 Turn 状态 Token
│   ├── plugin.ts # 新插件 manifest 与内核上下文类型
│   ├── plugin-graph.ts # Manifest、SemVer 依赖与拓扑排序
│   ├── plugin-container.ts # 单插件状态机与资源代
│   ├── plugin-host.ts # 插件发现后的统一启停与故障隔离
│   ├── plugin-config.ts # 插件私有配置默认值、校验、冻结与 Secret 处理
│   ├── plugin-permissions.ts # Manifest 权限声明检查与注册边界
│   └── builtin-capabilities.ts # 工具、命令、路由、钩子和提示词 Capability
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
├── history.ts        # 消息历史与当前轮工具链保护
├── estimate-tokens.ts # Token 估算（供 compress 插件使用）
├── sub-agent.ts      # 并行 sub-agent 执行器（受限工具 + 临时 AgentSession）
├── types.ts          # 共享类型定义
├── prompts/          # 默认提示词模板
│   ├── default.md    # 主 agent system prompt 模板
│   └── sub_agent.md  # sub-agent 任务提示词模板
├── plugins/          # 插件系统
│   ├── types.ts      # Plugin、PluginContext、PluginHooks、HookContext 接口
│   ├── loader.ts     # 插件发现器（只导入和标准化，不直接启动）
│   ├── core/         # 核心插件包（始终启用）
│   │   ├── index.ts  # 聚合导出所有核心插件
│   │   ├── tools.ts  # 基础工具注册插件（文件、搜索、记忆、技能等）
│   │   ├── sub-agent.ts # sub-agent 插件（注册 sub_agent_run 工具）
│   │   ├── prompts.ts # 提示词构建插件（模板加载+占位符替换）
│   │   ├── history.ts # 会话历史插件（用户消息进入 MessageHistory）
│   │   ├── session-summary.ts # 会话滚动摘要插件（摘要 + 未压缩原文）
│   │   ├── auto-memory.ts # 自动记忆插件（每 10 轮批量整理长期记忆）
│   │   ├── plan.ts # 计划执行模式（工具、状态机、恢复 API）
│   │   ├── attachments.ts # 图片上传路由与 session 附件存储
│   │   ├── models.ts # 模型列表与会话切换 API（GET /models、PUT /sessions/:id/model）
│   │   └── logger.ts # 日志插件（通过钩子记录所有事件）
│   └── feishu/       # 飞书插件（平台适配器）
│       ├── index.ts  # 插件入口
│       ├── client.ts # FeishuClient
│       └── handler.ts # 事件处理
├── tools/            # 工具实现（工厂函数，供核心插件导入）
│   ├── registry.ts   # 独立工具注册表（保留给独立场景，PluginManager 使用 Capability）
│   ├── search.ts     # 网络搜索（多 provider）
│   ├── web_fetch.ts  # 网页内容获取
│   ├── bash.ts       # Shell 命令执行
│   ├── file_read.ts  # 文件读取
│   ├── file_write.ts # 文件写入
│   ├── file_edit.ts  # 文件精确替换
│   ├── project-tree.ts # 项目目录树（异步、边界与数量限制）
│   ├── project-search.ts # 项目结构化搜索（ripgrep 优先，内置 fallback）
│   ├── project-git.ts # 项目 Git 状态与 Diff 工具
│   ├── plan.ts       # 计划创建与步骤状态更新工具
│   ├── memory.ts     # 长期记忆事实源、生命周期与工具
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

插件 Manifest 可以声明私有配置 Schema 和权限需求。`plugins.<id>` 是插件配置的持久化位置，`pluginStates.<id>.enabled` 保存用户插件的启用状态；未配置时默认启用，核心插件始终启用且不可切换。禁用插件仍会被发现并显示在管理页，但不会执行 `setup()` 或注册任何能力；停用必需依赖时，宿主会拒绝操作并列出仍在运行的依赖者。宿主在 `setup()` 前完成默认值合并、类型校验和深度冻结；配置错误使用户插件进入 `blocked`，不会影响无依赖的其他插件。Secret 字段由 Manifest 标记，插件管理 API 和 WebUI 只返回掩码，掩码回写时保留磁盘中的真实值。WebUI 插件页可查看状态、依赖、配置问题与权限，并启停用户插件或在保存配置后只重载目标插件。

权限声明和运行时审批分层：新式 builtin、workspace、external 插件注册工具或 Gateway 路由时必须先声明对应能力，但声明不代表授权；危险工具仍进入 `security.mode`、工具级覆盖、自动风险判断和用户审批链路。旧 Plugin 接口在迁移期继续适配。由于插件与宿主仍在同一 Node.js 进程中，Manifest 权限是治理与审计边界，不是进程级安全沙箱。

跨会话记忆拆分为两个独立模块。`core-profile-memory` 管理 `workspace/profile/*.md`，保存稳定用户身份、偏好和长期约束，并在每次模型调用前通过 `onBuildTurnPrompt` 固定注入全文；Profile 不进入向量数据库，也不按时间衰减。`core-vector-memory` 管理 `workspace/memory/*.md`，Markdown 是可读、可恢复的事实源，嵌入式 LanceDB 是可重建的检索索引；每轮用户消息触发语义向量、关键词和 metadata 过滤的混合检索，只把达到阈值的少量结果加入 Prompt。Embedding 或向量索引故障时退化为关键词检索，不阻断 Agent Loop。

自动记忆只分析用户问题和最终回答，通过 `memory_search`、`memory_read`、`memory_save`、`memory_delete` 等已有工具维护记忆。新状态默认追加并用 `supersedes` 结束旧状态，避免破坏历史；读取会更新强度和最后使用轮次。遗忘使用 `active -> stale -> trash -> purge` 状态机，普通记忆只有同时满足未使用轮次和自然时间阈值才进入 stale，删除先进入可恢复回收站。workspace 成功主对话轮数持久化在 `memory/state.json`，sub-agent 和工具迭代不计入。

## 桌面应用

品牌名称为 `Breeze Coder`，npm 包名为 `breeze-coder`，Windows 可执行文件为 `breeze-coder.exe`。发布脚本从 package.json 的 build 配置读取产品名和可执行文件名，不再假定安装路径不含空格。应用 ID / Windows AppUserModelId 为 `com.lihongxun.breeze-coder`，NSIS 安装 GUID 随应用 ID 更新。桌面启动在获取单实例锁前显式将 userData 指向 appData 下的 `breeze-coder`；`--user-data-dir` 仍优先。环境变量统一为 `BREEZE_CODER_*`，项目规则目录为 `.breeze-coder/`，浏览器主题键为 `breeze-coder-theme`，preload 桥接名称为 `breezeCoderDesktop`。不保留旧品牌标识兼容，不自动迁移旧工作空间；已有用户数据不会被删除或改写，迁移时需先备份并复制到新目录。

图标源为用户选定的 `build/icon-source.png`，`build/icon.png` 仅在原图四角应用半径为边长 20% 的透明圆角遮罩，不增加外围边距、不缩放主体；iconset 和 WebUI 图标由圆角图标缩放生成。macOS 托盘使用 `build/trayTemplate.svg` 的透明黑白简化版本，不添加白底。旧品牌 SVG 已移除。

桌面入口同时支持 macOS ARM64 和 Windows x64，复用同一 Web UI、Gateway 和插件体系。Windows 使用 electron-builder NSIS 安装向导，默认按当前用户安装、不删除用户数据；Windows 暂不签名，macOS 维持 Developer ID 签名和公证。Windows 图标从现有 PNG 由打包器生成 ICO，托盘使用普通图片而不是 macOS Template 图像，配置 AppUserModelId；默认数据目录来自 app.getPath("userData")，通常为 `%APPDATA%/breeze-coder/workspace`。显式 `--user-data-dir` 支持隔离测试目录。

Electron 通过私有父子进程 IPC 发送 desktop:shutdown；Gateway 取消前台任务、等待流完成、销毁插件及托管任务后退出。IPC 断开也触发清理；超时沿用原有 3 秒兜底，Windows 使用 taskkill /T /F 结束进程树，POSIX 使用信号。Shell 执行统一由 platform/shell.ts 查找 Git for Windows 的 bin/bash.exe（安装目录或 PATH 中 git.exe 的同一安装），拒绝以 WSL bash 代替。缺失 Bash 时返回依赖安装提示，不阻断其他工具。动态 Skill 命令也使用同一 Shell。Windows 仅对可明确解析的盘符/相对路径进行自动审批；/tmp、/usr、自定义挂载等不确定路径请求人工确认。受管 TMPDIR 和安全转换后的执行路径统一为正斜杠。命令取消/超时通过 platform/process-tree.ts 终止 Windows 进程树，POSIX 进程组行为不变。

Tag 发布工作流拆为 macos/windows/publish 三个 Job。各平台独立全量测试和本地模型测试，在原生 Runner 构建；Windows 无签名凭据，macOS 保留现有签名凭据。desktop-smoke 验证打包后 LanceDB 写入/向量查询、llama CPU 原生模块、窗口启动、隔离配置、隐藏/恢复及 Gateway 退出；Windows 额外运行 NSIS 静默安装/卸载。两边完成后统一创建 Release，避免并发创建；已成功平台的 Artifacts 不受另一平台失败影响。版本检查要求 Tag、package.json 与 lockfile 一致，产物使用平台独立 SHA256 校验文件。

桌面版使用 Electron 承载现有 Web UI，不改变 Agent Loop 和插件边界。Electron 主进程创建窗口后先加载内置启动页，启动页与窗口背景跟随操作系统深浅色外观，展示应用 Logo 和服务启动状态；同时启动独立 Gateway 子进程，Gateway 就绪后在同一窗口切换到本机随机端口上的 Web UI。窗口不直接开放 Node.js 能力。受 sandbox 和 context isolation 保护的 preload 只暴露 `selectProjectDirectory()`，通过固定 IPC 请求调用系统目录选择器；主进程仅接受当前主窗口的请求。浏览器版没有该桥接能力，继续使用手动路径输入。桌面主进程创建系统托盘/菜单栏图标，关闭主窗口时只隐藏窗口并保持 Gateway 常驻；点击托盘、macOS Dock 或再次启动应用会恢复并聚焦现有窗口。显式退出应用时通过上述 IPC 关闭流程等待 Gateway 清理完成。

macOS 桌面版 workspace 默认位于 `~/Library/Application Support/breeze-coder/workspace`。首次启动由统一配置初始化器生成不含真实密钥的完整默认配置，应用升级和重新安装不会覆盖已有配置、会话、记忆、技能及插件。开发模式和 CLI/Gateway 模式仍使用原有 `./workspace` 或显式指定的目录。

macOS 发布由 Tag 触发 GitHub Actions。流水线在临时钥匙串中导入 Developer ID Application 证书，签名 Electron 应用并生成 DMG，然后使用 Apple `notarytool` 公证最终 DMG、装订公证票据并验证签名与磁盘映像完整性。证书、私钥密码和 Apple 公证凭据仅通过 GitHub Actions Secrets 注入，临时钥匙串在任务结束时删除。

## 工作目录结构

Breeze Coder 运行时需要一个工作目录（workspace），所有持久化数据都放在其中。工作目录路径通过 `--workspace` CLI 参数或 `BREEZE_CODER_WORKSPACE` 环境变量指定，默认为 `./workspace`。

```
workspace/
├── config.json        # 配置（API key、模型、工具权限等）
├── identity.md        # 身份设定（注入 system prompt 模板 {{identity}} 占位符）
├── system_prompt.md   # 可选：自定义 system prompt 模板（不存在则使用默认模板）
├── sub_agent_prompt.md # 可选：自定义 sub-agent 任务提示词模板
├── skills/            # 自定义技能（skills/<name>/SKILL.md）
├── profile/           # 每轮固定注入的用户 Profile（Markdown + frontmatter）
├── memory/            # 按需向量召回的长期记忆（Markdown + frontmatter）
├── sessions/          # 按会话持久化消息、会话摘要、auto-memory 增量状态
│   └── <encoded-session-id>/
│       ├── messages.jsonl
│       ├── meta.json
│       ├── state.json
│       ├── summary/
│       │   ├── current.json # 结构化 Checkpoint + Delta 当前状态（启用后生成）
│       │   └── archive/     # 后续 Checkpoint 归档目录
│       ├── plans/          # 按对话轮次持久化的结构化任务计划与步骤进度
│       └── attachments/   # 图片文件及附件元数据
└── logs/              # 执行日志，[时间] [级别] 消息，每日轮转
    └── 2026-05-19.log
```

新写入的 Session 消息带有稳定的 `_messageId` 和从 1 开始单调递增的 `_sequence`，并在按 Session 串行的异步写锁内完成 JSONL 追加和 `meta.json.lastMessageSequence` 原子更新。旧消息读取时生成确定性兼容 ID，不改写原始 JSONL。结构化摘要 Store 使用独立的 `summary/current.json`、原子替换和 revision 乐观校验；归档位于 `summary/archive/`。运行时已完全使用该 Store，`state.json.summary` 仅作为一次性旧数据迁移入口。

## 项目开发模式

项目开发模式建立在持久化的 `SessionContext` 上。普通会话使用 `{ mode: "chat" }`；项目会话在创建时绑定规范化后的项目真实路径，并把 `{ mode: "project", project: { root, name } }` 写入 `sessions/<session>/meta.json`。绑定创建后不可修改，后续 `/chat` 只接收 `session_id`，不会从请求中临时切换项目。

`core-project` 插件负责 `/projects/inspect`、`/projects/status`、`/projects/diff` 路由和项目提示词注入。静态项目检查只识别技术栈与规则文件，并按文件签名缓存；动态 Git 状态与 diff 通过异步子进程按需读取，不阻塞 Gateway 事件循环，也不重复注入模型上下文。Git 参数使用数组传递而不拼接 shell 字符串，超时和 diff 最大字符数由 `project.gitTimeoutMs`、`project.diffMaxChars` 控制。读取 `.breeze-coder/rules.md` 和根目录 `AGENTS.md` 时应用单文件与总字符上限。项目模式还会自动发现项目根目录下 `.agents/skills/<name>/SKILL.md`，并兼容 `.claude/skills/<name>/SKILL.md`；默认只把技能名称和描述注入提示词，完整正文仍通过 `skill_use` 按需加载。Gateway 只维护一个 `PluginManager`，项目根目录和有效配置通过 session 运行时上下文传递给插件及工具。

`core-project-tools` 插件注册 `project_tree`、`project_search`、`git_status`、`git_diff` 四个只读开发工具。工具注册支持基于 `SessionContext` 的可用性过滤，因此普通会话不会把项目工具定义发送给模型。目录树使用异步文件系统 API，并跳过依赖、版本库和常见构建目录；项目搜索优先使用 `rg --json` 解析结构化结果，若运行环境未安装 ripgrep，则自动切换到内置 TypeScript 搜索实现，避免桌面发布包依赖用户系统预装外部命令。两种搜索实现都会在达到结果数、字符数或超时上限时主动截断或终止。四个工具都强制使用项目根目录和符号链接边界校验，并继承统一权限审批与审计日志。

WebUI 打开项目时使用前端互斥锁和 loading 状态阻止重复提交，并用 `project.openTimeoutMs` 控制检查与会话创建总时限。Gateway 的 `reuseEmpty` 语义会复用同一项目最近的空闲空会话，作为重复请求的第二层保护。项目栏展示分支、工作区状态和变更文件，任务完成后自动刷新；diff 仅在用户选择文件时按需加载。

项目会话的有效配置在创建 `AgentSession` 时由全局配置和 `project` 段合并：项目工具配置覆盖项目模式，项目模式覆盖全局配置；未显式配置时项目危险操作默认 `ask`。工具执行时从 `ToolExecutionContext` 获取有效配置，禁止自行重新加载未合并的全局权限。项目模式下 bash 和文件工具的相对路径基于项目根目录，绝对路径、`..` 和符号链接均不能越过项目边界；sub-agent 继承父会话的项目上下文。

WebUI 先调用 `/projects/inspect` 检查目录，再读取项目设置并展示创建确认弹窗；用户确认信任选择后保存设置，通过 `POST /sessions` 创建项目会话，不等待用户发送第一条消息。取消确认不保存授权。应用启动时读取持久化 Session 列表，分别恢复普通对话和项目模式最后使用的 Session；切换视图时恢复各自状态。右侧功能页面由 `view` 控制，左侧普通会话/项目列表由独立的 `sidebarMode` 控制，因此从项目进入记忆、日志或设置时仍保留项目列表。项目侧栏按 `SessionContext.project.root` 分组：项目行显示持久化目录名并提供项目级新对话和删除按钮，下面缩进显示该项目的会话预览；顶部“新建项目”单独进入目录选择流程。项目不是独立持久化实体，删除项目会复用 Session 删除接口清理该目录关联的全部会话及会话数据，但不会删除用户选择的本地项目目录或其中的文件。

### 自动审批分析与托管命令

项目信任由 core-project 的 POST/PUT /projects/settings 路由管理，前者读取，后者校验布尔值并原子更新用户 config.json 中已有 security.trustedProjects 字段。全局设置页不再编辑路径列表，ProjectView 在目录检查后显示创建确认弹窗，也在项目栏提供项目设置入口。同一真实目录共享信任；信任不写入仓库。权限分析、Bash TMPDIR、后台工具和项目提示词按调用读取最新持久化信任值，避免 Session 配置缓存导致撤销延迟；不重启会话、不自动消费待审批请求。配置缺失旧字段时保留原配置兼容逻辑。

插件通过 `PluginContext.registerDisposable` 将运行资源绑定到插件生命周期；后台任务在插件卸载及正常服务退出时均取消并等待清理完成。

`security/shell-analysis.ts` 使用 bash-parser 生成 AST，`security/auto-approval.ts` 遍历命令、管道、逻辑连接和重定向，跟踪可确定的工作目录。丢弃输出到准确的 `/dev/null`、描述符复制以及引号内普通文本不作为外部写入；命令替换中的命令仍分析。未知语法或动态目标请求确认。支持范围内的写入目标经真实路径与符号链接检查；这是审批静态分析，不是完整 Bash 解释器或 OS 沙箱。

`security/read-command-analysis.ts` 按参数识别 find、Git 与 awk 的只读子集。find 查询谓词按参数个数消费，支持路径、名称/类型筛选、深度、逻辑组合和标准输出；执行、删除、文件输出与未知参数请求确认。find 的 -o 不作为输出路径。Git 支持 status、ls-files、rev-parse 的已识别查询选项，以及 branch --show-current、log 的日志展示与数量选项；diff 必须显式禁用 ext-diff 和 textconv，并只接受已识别选项。全局配置覆盖及未知查询选项保守确认。awk 只接受单条 print/printf 中的字段、字符串、数值和算术 token，不接受函数、赋值、文件脚本、内部重定向或命令管道。shell 管道、动态展开和重定向仍独立检查；显式 ask/allow 不变。

Shell 分析对 Subshell 内部递归检查，子环境的 cd 不传播到外层，子 Shell 自身的重定向按父目录检查。timeout 仅识别字面量时限和直接命令，再递归分析目标；未知包装选项不放行。Node 的 --check/-c 只允许单个项目内文件，包含符号链接边界校验，不放行额外预加载选项。这些能力沿用现有安全分析入口，bash 与 background_start 共用，不新增主循环特例或配置阈值。

项目模式下，自动审批默认允许工作目录和入口文件均在当前项目内的 Node/Python 脚本；路径检查包含符号链接。允许 npm run/test/build 和不含选项或变量覆盖的 make 任务，不以 trustedProjects 为前提。解释器内联代码、未知选项、外部脚本、npm 执行目录/配置覆盖与未识别命令保守请求确认。外层 AST 仍独立检查管道、重定向、目录切换、系统和远程操作；普通模式及显式 ask/allow 不变。此策略是代码执行授权，不是沙箱，不检测脚本内部所有副作用。

`security.trustedProjects` 在全局用户配置中保存额外授权的项目绝对路径，默认空数组；按真实路径精确匹配，不自动信任子目录、项目声明或已有项目。托管临时目录授权不覆盖系统危险操作与可识别的外部写入，也不绕过 Git 操作分类。`security/project-trust.ts` 创建 workspace 下 `project-tmp/<真实项目路径哈希>`，可信项目命令的 TMPDIR 与审批解析使用同一目录。

`core-background` 插件注册 background_start/status/stop 工具与 /tasks、/task-stop 命令，主 Agent Loop 不包含后台任务分支。启动仍经过计划门禁、统一权限审批和工具审计，background_start 默认继承 bash 权限覆盖。后台任务绑定发起 session，通过 ID 查询/取消，不能跨会话操作；运行控制器独立于消息轮次取消，应用 Scope 释放时终止进程组。任务上限、超时、有界日志通过 security.background 配置。状态记录原子保存至 sessions/<session>/background/<id>.json；运行中日志由内存提供，结束时持久化。重启后未知运行记录显示 interrupted，不通过旧 PID 操作进程或自动重放。进程异常崩溃不保证清理已脱离宿主的进程，当前不承诺跨重启续跑。

## 任务计划展示

core-plan 是非阻塞进度插件，不是工作流引擎。简单问答直接回答，多阶段任务通过提示词鼓励模型调用 update_plan；不做额外意图分类请求，不要求先创建计划，不根据计划状态过滤或拦截执行工具。旧 executionMode 字段兼容读取和请求，但不再控制计划权限，WebUI 移除普通/计划切换。

插件只注册 update_plan，接收 title、完整 steps（稳定 id、title、status、可选 summary）及可选历史 plan_id。首次调用创建当轮计划，后续调用整体更新；允许增删、修订和重新排列步骤，不强制顺序。格式错误只返回工具错误，不暂停运行。plan.enabled 控制进度插件工具和提示词启用，关闭后执行、审批、取消仍可用；plan.maxSteps 沿用步骤上限。旧 maxGateCorrections 和 decisionRetries 字段仅兼容读取，不再生效。

title 可在更新时省略：优先保留本轮计划标题，本轮无可用标题时仅继承显式 plan_id 所关联的同会话历史计划标题；两者均无标题才要求提供顶层 title。显式传入空白或非字符串标题仍返回清晰的参数错误。步骤标题依然必填，历史计划及其快照不被修改，无关新轮次不自动继承最近计划。

Plan 保存模型报告的进度，Run 保存真实执行状态。update_plan 不写 Run 状态，不批准工具，也不启动或恢复进程。即使没有计划、计划格式错误、计划完成，普通工具仍按独立安全策略执行。后台任务状态只来自后台任务执行记录，计划 in_progress 不代表评测进程存在。

每轮计划单独持久化，plan_id 仅关联当前会话中的历史计划；新记录以 previousPlanId 关联旧记录，不修改旧计划或其快照。无关新轮次不继承旧计划。update_plan 本身不自动选择最近计划或识别“继续”关键词。旧工具工厂仅保留兼容测试，不再注册到模型工具列表。

运行期间在输入框上方显示默认折叠的信息条，展示步骤完成数和当前步骤，不显示百分比进度条；展开查看完整步骤与摘要。轮次结束后移入对应历史消息，未完成步骤不自动算完成，也不继续显示为活动执行。问题、选项和重要结果必须在正文或独立审批入口展示，不能仅存于折叠计划。

Run 仍由 run-store.ts 独立持久化。一次消息轮次对应一个 Run，审批恢复复用原 Run；running、waiting_approval、waiting_user、completed、interrupted、cancelled 描述运行而非计划。会话互斥、重复轮次拒绝、进程故障恢复和停止保持独立。completed 仅表示本轮结束。历史计划与快照继续兼容读取，不自动执行旧任务。

Run 持久化 startedAt/completedAt 及按 toolCallId 索引的 toolTimings。总耗时从本轮开始计算，包含审批等待，审批续跑不重置；终态冻结结束时间。服务异常退出无法确定精确停止时间时，以最后持久化活动时间截止，不把停机时间计入。工具调用由 Agent 执行包装器统一记录时间，SSE 增量、GatewayStream 快照和历史投影使用同一数据，审批后实际执行覆盖此前权限检查的计时。旧记录不伪造时间。后台任务独立保存自己的开始/结束时间，启动工具耗时不代表后台任务运行时长。

WebUI 的 useElapsedTime 只用时间差计算显示值，每秒刷新并监听 focus/pageshow/visibilitychange 立即校准；切换会话或折叠不会重置时间。工具结束后显示固定耗时，计划信息条及历史计划显示本轮总耗时；未记录开始时间时不显示数值。

### 用户询问与恢复

core-user-input 注册 ask_user 和 POST /user-input/answer。插件负责题型、选项和答案校验及提示词；ToolExecutionContext.suspend(kind, payload) 是通用暂停接口，Agent 不按工具名判断。Run.suspension 原子保存问题、稳定请求 ID、原工具调用、同批未执行调用、迭代和 actor。waiting_user 且 suspension.pending 是可恢复等待态，不写 completedAt，不保持模型请求或后台 Promise；普通旧 waiting_user 仍兼容为结束状态。

答案提交校验当前会话、请求 ID 和状态，经 RouteContext.resumeTool 进入统一 GatewayStream。状态转 running 和答案记录同次落盘，随后写入原工具结果，未执行同批调用配对记录 blocked 并交由模型重新判断。相同请求只消费一次；取消后不接受迟到答案。进程在答复续跑过程中异常退出时按已有 running 恢复规则标记 interrupted，不自动重放副作用。等待状态重启后可直接回答。

前端根据 Run 快照和会话 attention=input 恢复等待状态。仅当前会话自动弹窗；sessionStorage 记录已展示的请求 ID，收起和刷新不反复弹窗，常驻回答入口不依赖计划展开。等待不显示生成光标或运行动画；提交、取消、跨窗口状态刷新共享原 Run revision。历史以 ask_user 的问题和对应答案显示独立只读记录。插件配置 plugins.core-user-input 控制 enabled、maxOptions、maxQuestionChars、maxAnswerChars，默认 true/8/4000/12000。非 Web 渠道不暂停，子 Agent 不暴露 ask_user。

Web 静态服务器按插件注册路由转发新增 API，RouteContext 提供通用 SSE 工具恢复桥接，不让插件直接管理 Session 或 SSE 订阅。问题等待与权限审批完全独立，回答不产生权限授权。

`core-notifications` 在 onTurnEnd 阶段根据 TurnEndReason 纯自动生成系统通知，不经过大模型。默认对 approval_required、waiting_user、completed、iteration_limit 通知，interrupted 不通知；配置 `notifications.enabled` 为总开关、`notifications.reasons` 为原因白名单，通知标题和正文由插件内置，不暴露为配置。Agent 通过 SSE 推送 `notification` 事件，Web 与 Electron 渲染层仅在页面/窗口不在前台聚焦时才弹系统通知（后台抑制固定开启），不依赖 Service Worker 或 Web Push。

### 工具审批

Approval 仍关联具体工具、参数和 continuation。批准或拒绝在原 Run 中恢复，恢复计划不代表批准操作；授权只消费一次。等待审批时不能发送新任务，允许批准、拒绝或取消整个等待任务。取消将未执行调用记录为 blocked，清理审批和运行轮次；不调用模型自动继续。到期将审批标记为 expired 并持久化，不删除 continuation，Run 保持 waiting_approval。plan-recovery.ts 仅在 continuation 丢失时将 Run 转 interrupted，旧孤立 waiting_approval 步骤转 waiting_user。

### 展示与历史

重建等待审批或用户确认的会话时，保留待执行调用所在轮次的完整持久化消息后缀，包括同批已经执行完成的工具结果；恢复只执行待授权调用，不重放已完成调用。摘要插件使用当前运行时消息投影，不逐条从磁盘替换当前消息，以免重新引入已被清理的孤立调用；历史部分仍从持久化记录读取。

会话摘要投影按完整工具交换保留或移除消息：助手的工具调用及其全部连续结果视为一个整体，旧 Checkpoint 落在交换内部时保留整组。当前片段首条仅在确实是用户问题（不含工具结果）时特殊保留，审批恢复后以助手调用开头的片段不再留下已被摘要覆盖的孤立调用。最终模型请求仍做严格工具链校验；失败日志记录轮次、迭代及投影前后消息的序号、角色、块类型和工具 ID，不记录正文、参数或结果，也不补造结果或重放工具。

主请求对已结束历史使用协议投影：缺少结果的历史工具调用转成文字说明，同组已有结果的调用仍保留协议配对。摘要抽取独立读取原始历史，只选择用户输入和最终回答，不使用这些工具说明。Run 为 running、waiting_approval 或 waiting_user 的轮次不参与摘要，覆盖位置不能跨过活动轮次。历史工具链缺失不阻塞问答提取，也不会被推断成成功结果；原始消息日志不变。

`core-progress` 通过提示词钩子要求复杂任务说明行动意图及关键发现。按 sessionId/turnId 隔离记录最近正文响应时间及随后工具调用数；默认 60 秒或 5 次工具调用后，在下一次请求消息末尾附加临时进展提醒，不修改固定系统提示词或持久化历史，不阻断工具、不额外调用模型。正文响应和提醒均重置计数以节流；暂停、结束、错误时清理，恢复后重新计时，不把等待审批时间算作沉默。配置为 progress.enabled/silenceMs/toolCalls。仅实际模型正文沿现有消息历史和 SSE 快照保存；单次模型请求期间不会伪造进度或插入提醒。

旧消息未保存正文提示时，历史 API 可从该轮 Run 的中断、取消或等待原因生成只读补充，不修改原始历史。旧计划缺失目标也能展示，不要求先修复才能执行工具。

计划面板只提供辅助详情，默认折叠。进度来自 update_plan，真实运行和审批状态来自独立记录。正文由模型说明关键进展与用户问题，计划插件不再用暂停工具控制运行，也不自动追加完成结论。

GET /plan 返回计划列表、最新 Run、当前执行 turnId 和 activePlan；是否在输入框上方展示由 Run running/waiting_approval 决定，不根据步骤未完成推断。模式偏好仍保存于 Session meta，审批 continuation 保留 executionMode。普通/项目绑定保持不变。

GatewayStream 保留当前 Run、turnId、累计文本、工具调用和事件序号。SSE 先发送 snapshot，再发送带序号的增量和 run_state；前端按序号去重并按轮次合并助手消息。刷新或切换会话重新订阅；连接状态与后端运行状态分开，断线不视为任务完成。历史会话 busy 从运行记录派生，审批入口来自持久化审批事实源。

实时 snapshot 使用 `textMode=full-turn` 明确表示整轮内容。审批或用户回答续跑时，Gateway 先从同一 turnId 的历史初始化正文及工具调用，再追加本次增量；done 正文也包含续跑前的前缀。前端按 turnId 用整轮快照替换历史展示，不因 snapshot 携带 approvalId 再次拼接；工具开始事件按 toolCallId 更新已有条目，清除旧待审批结果。旧快照仍走兼容分支。连续刷新或重连不会重复追加同轮回答。

当前回答下方用灰色状态行展示可观测执行阶段及阶段耗时。Agent 通过 Run.status 上报准备上下文、等待模型响应、接收回答、调用工具和处理结果；工具通过可选的 ToolExecutionContext.reportActivity 上报具体操作，不由模型正文推测。bash 通过审批并收到进程 spawn 事件后才报告执行命令，文件读取和项目搜索在权限检查后报告操作。状态携带 startedAt，经 run_state SSE 和快照恢复；前端按 Run revision 拒绝旧状态覆盖。光标仅在文本输出阶段显示，压缩、工具执行、停止和断线期间不显示；审批单独提示操作尚未执行。连接丢失独立展示，不将断线解释为后台仍在运行。工具详情和计划折叠不影响状态行可见性，终态后移除活动状态。

重连失败保留累计正文、工具调用及 turnId，普通运行统一显示“正在处理”，不以连接有无推断后台执行。无事件流时 Gateway 仅对本进程拥有且执行器已空闲的 running 记录补写 interrupted；不干预其他进程或真实活动任务。模型循环的失败统一抛给发起入口，普通执行与审批恢复均先持久化终态、发送 run_state，再报告 error，避免流结束后遗留 running。

OpenAI-compatible 流响应的 reasoning_content 作为协议元数据合并到 ChatResponse.reasoningContent，并随原助手消息以 _reasoningContent 持久化。工具结果回传及审批恢复时原样映射回 reasoning_content，不加入可见正文、不生成虚构推理内容；未提供该字段的模型不附加字段。旧历史未保存的推理字段无法凭空恢复。

服务端返回 reasoning_content 相关 400 时，模型适配器抛出带协议诊断的 ReasoningProtocolError，日志插件记录请求 ID、轮次、消息角色、思考字段是否存在及长度和工具调用 ID，不额外记录思考正文。不为该错误补造思考字段、关闭思考模式或自动重试工具。

会话摘要在 onBeforeModelCall 阶段按 Token 预算同步执行，不再在 onTurnEnd 按轮数整理。压缩期间输入保持锁定，通用状态持久化到 Run.status 并通过 SSE 更新，页面显示“正在进行上下文压缩...”。刷新后从流快照或 Run.status 恢复提示。摘要失败保留原始消息和已有 Checkpoint，硬预算允许时继续调用主模型；否则明确报错。

轮次结束或出错时将当前计划保存为 plan-snapshots/<turn>.json。后续轮次的更新创建独立记录，不覆盖以前快照；快照保存失败仅记录告警，不阻断任务。历史未完成记录可通过界面显式关联到新请求，但该关联不构成执行恢复或操作授权。

工具调用仍以单条助手消息聚合，展示执行中、成功、失败、已拦截和待审批；有审批时强制展开。输入框执行期间只能停止，等待审批期间锁定普通发送但审批卡片可操作。

在 macOS/Linux 上，bash 工具为每次调用创建独立进程组；取消与超时先向整组发送 SIGTERM，等待 `bashTerminationGraceMs`（默认 1000ms）后发送 SIGKILL 并释放输出管道，避免后台子进程持有管道导致调用无法返回。普通 `&`/`nohup` 子进程仍受本次调用管理，不作为独立持久任务。显式另建会话的外部进程不在该进程组保证范围内。前端点击停止立即显示“正在停止...”，仍等待服务端终态解锁。模型调用前的摘要压缩接收本轮 AbortSignal；取消时不提交尚未保存的摘要批次，并保留原始消息供后续处理。

`core-context-inspector` 通过 `onModelRequestPrepared` 观察每一次真正发送给模型的最终请求。该钩子位于提示词注入、工具过滤和上下文压缩之后，因此快照包含实际的 System Prompt、Messages 与 Tools。插件将最新快照写入 `sessions/<session>/context-snapshot.json`，采用异步临时文件加原子重命名，仅保留最新一份；写入失败记录警告，不中断模型请求。`GET /context?session_id=...` 从磁盘读取，缺失或损坏时返回 404，Gateway 重启后可恢复，删除会话目录时一并清理。旧会话没有快照时需等待下一次模型调用生成。Agent 同时通过 SSE 推送 `context_usage`，WebUI 在输入框内审批模式左侧以“上下文 24%”展示占用比例，无数据时隐藏入口；点击后在弹窗中查看完整 Token 统计、占用比例及请求内容。Token 统计复用上下文压缩模块的估算函数；附件只保留类型和名称，不暴露本地文件路径或 Base64 数据。

上下文弹窗提供独立的“上下文摘要”标签页。会话摘要与临时压缩插件通过 `ModelCallContext.contextSummaries` 提供本次请求实际注入的摘要文本，Agent 仅将其转交给最终请求快照并持久化，不读取调用结束后更新的摘要。该元数据不参与 Token 计数，也不改变原始 System Prompt 和 Messages 展示。新快照无摘要时记录空数组；旧快照缺失该字段时明确提示未单独记录。

### 工具结果与上下文预算

core-tool-context 通过 onBeforeModelCall 提供模型侧工具结果投影，纯函数位于 tool-context.ts。完整结果仍由 Agent 原有路径写入 messages.jsonl，工具执行、审批和暂停不受投影影响。小结果原样保留，大结果转换为合法 JSON，包含截取标记及 contentRef.toolCallId。搜索结果保留标题、URL、resultIndex 和有界 snippet；普通结果保留退出码、错误和预览。审批与待回答控制结果不裁剪。最终投影计入完整动态提示词包装，从最新结果向旧结果分配共享预算，不以每条最低额度突破上限；旧结果至少保留原文引用。readMaxTokens 控制回查读取额度，实际发送仍受共享预算限制。分页结果再次缩小时同步更新 nextOffset，避免跳过原文。模型请求投影不回写 MessageHistory，内存和持久化历史均保留原文；摘要插件通过持久化覆盖序号与结果额度重建后续请求。

session_history_recall 在当前会话内按 tool_call_id 定位原文，可指定 result_index、字符 offset 或 query，返回有界片段及 nextOffset。原文不可跨会话读取。GET /tool-result 为用户提供附件形式的原文下载；Gateway 历史与实时流使用同一展示投影，不把全文直接渲染到页面。这是展示副本，不替代 Agent 内部原始结果或落盘内容。

session-summary 使用同一投影构造抽取请求；输入大小按最终序列化字符数与模型 Token 上限双重检查。历史轮次和当前轮较早的完整工具交互均可压缩，最新用户请求与最新交互保留，未配对调用不进入抽取批次。Checkpoint 覆盖序号与 revision 持久化，原文不改写，重启按覆盖范围重建上下文。模型仅输出 operations，程序填写实际批次的版本与范围，仍校验引用、类型和版本冲突。结构化校验失败有限重试，失败或取消不推进覆盖位置；容量允许时继续，否则沿用 Run 错误终态解锁输入，不重放工具副作用。

预算包含推理协议字段、系统提示、工具定义、消息与输出预留，并扣除可配置安全余量；最终检查及空响应重试前再次检查，不能发送本地已判定超限的请求。core-context-inspector 持久化 kind=estimate 的准备/失败估算与上次请求统计；正常请求快照保持兼容。WebUI 区分未发送的预算估算和上次请求占用。

历史持久化与读取均保留模型返回的 `_reasoningContent` 字符串（包括空字符串），供 OpenAI 兼容适配器回传 `reasoning_content`。摘要重建、审批续跑和服务重启恢复不得丢弃该协议字段；旧记录缺失或字段类型非法时不伪造推理内容。

配置位于 plugins.core-tool-context：maxResultTokens=8000、readMaxTokens=4000、searchSnippetChars=1500、safetyMargin=0.05、summaryRetries=1、searchMaxResponseBytes=8388608。搜索 HTTP 正文有独立采集字节限制和取消处理；超限明确报未完整接收，不宣称保存了未收到的原文。bash 等工具已有采集上限继续生效。


### config.json

设置页面通过 GET /config 同时获取用户配置和 createDefaultConfig 提供的 defaults，不再维护表单默认值副本。显示缺省值不会自动写入未修改的列表/JSON 配置。兼容清理器统一移除临时压缩、历史窗口、无效摘要字符限制及旧计划门禁字段；加载时只忽略，保存时移除，不改写摘要和消息文件。loadConfig 保留 Profile 设置。新建配置使用 openai-chat，旧文件未声明协议时仍按 anthropic-messages 读取并在设置 API 明确返回，避免协议迁移副作用。

仓库提供两个配置示例：`config.simple.example.json` 是推荐入门配置，`config.all.example.json` 是完整配置参考。实际运行时只读取 `workspace/config.json`。

CLI 和 Gateway 入口会在加载插件前初始化 workspace 并调用 `ensureConfigFile()`，AgentSession 仍保留幂等兜底：配置文件不存在时生成完整默认配置，已存在时绝不覆盖。模型配置以 `models` 数组为唯一权威：每个 Profile 独立配置 provider、model/apiUrl/apiKey 或 localModelId/contextSize，`defaultModelId` 指定默认模型。旧字段 `apiUrl`/`apiKey`/`model`/`modelProvider`/`remoteModel`/`localModel` 仅在加载时作为单模型输入被归一化迁移成 `remote`/`local` Profile，保存时移除这些扁平字段、不再落盘；GET /config 响应中仍从 `models` 派生出这些扁平字段作为视图，供前端与旧调用方读取。会话可通过 `AgentSession.switchModel` 随时切换模型，`currentModelId` 持久化到 `sessions/<session>/meta.json`，重启后按该值恢复。模型的 HTTP API 由 `core-models` 插件承载：`GET /models` 返回脱敏后的模型列表与 `defaultModelId`，`PUT /sessions/:id/model` 校验并切换会话模型，二者均通过动态路由参数（`:id`）接入插件路由匹配。仅启用本地模型时不要求 API Key。本地模型目录、显式后台下载、字节级进度和独立连通性测试由 `core-local-models` 插件提供，GGUF 文件及清单保存在 `workspace/models/`。目录覆盖 Qwen3.5 与 Gemma 4 的不同参数规模，WebUI 通过插件路由动态读取，不维护独立的硬编码型号列表。选择本地模型不会触发下载，只有调用下载路由后才开始。每个本地模型在目录中声明建议内存、推荐上下文与模型上限，运行时和摘要插件使用同一个实际上下文值，防止压缩逻辑按远程模型窗口计算而让本地推理溢出。配置 API 保存后会释放空闲会话，使模型与上下文配置在下一次消息时重新加载。

本地模型适配器在模型首次输出工具调用时立即终止当前次生成，只把工具调用交回 Agent Loop；它不会向模型注入占位工具结果。工具实际执行并返回真实结果后，Agent Loop 才开始下一次模型调用，确保等待审批期间不会生成基于虚假结果的回答。

本地模型按文件路径缓存复用，每次推理结束都等待上下文释放。`disposeLocalModels()` 供停止本地推理后的清理流程显式释放模型缓存；真实模型测试先等待释放，再删除临时 GGUF 文件，避免 Windows 文件占用错误。加载失败不保留失败的缓存项，释放失败则向调用方报错并保留缓存项以便重试。

| 字段 | 说明 | 默认值 |
|------|------|--------|
| apiUrl | API 基础地址（派生视图，保存时不落盘） | 由 models[0] 派生；旧格式输入时必填 |
| remoteModel | 远程模型启用状态（派生视图） | enabled=true |
| localModel | Qwen/Gemma 本地模型、上下文与启用状态（派生视图） | enabled=false, modelId=qwen3.5-4b-q4, contextSize=32768 |
| apiKey | API 密钥（派生视图，保存时不落盘） | 由 models[0] 派生；旧格式输入时必填 |
| model | 模型标识（派生视图，保存时不落盘） | 由 models[0] 派生；旧格式输入时必填 |
| modelProvider | 模型协议适配器（派生视图） | anthropic-messages |
| models | 多模型 Profile 数组（唯一权威，含远程与本地模型） | createDefaultConfig 生成 deepseek（openai-chat） |
| defaultModelId | 默认使用的模型 ID | models[0].id |
| maxTokens | 单次响应最大 token | 16384 |
| maxContextTokens | 上下文最大 token 估计 | 128000 |
| contextCompressionThreshold | 可用预算的压缩触发比例 | 0.8 |
| contextCompressionTargetRatio | 可用预算的压缩目标比例，严格小于触发比例 | 0.2 |
| maxAgentIterations | Agent Loop 最大迭代次数；达到上限时明确提示，显式配置 0 表示不限 | 1000 |
| emptyResponseRetries | 模型成功返回空文本且无工具调用时的重试次数 | 1 |
| sessionSummary | Token 触发的持久化摘要配置 | enabled=true, persistent=true；旧 turnThreshold/recentTurns 不再生效 |
| autoMemory | 自动记忆配置 | enabled=true, turnThreshold=10 |
| memory | 长期记忆容量限制 | maxItemChars=20000, maxTotalChars=80000 |
| attachments | 图片附件配置 | enabled=true, 每条最多 4 张、单张 10 MB |
| debug | Debug 模式配置，可记录模型原始输入输出 | enabled=false |
| security | 基础安全边界：bash 策略、Gateway host/token、工具审计 | 见下文 |
| project | 项目会话权限与迭代上限 | security.mode=auto, maxAgentIterations=1000 |
| plan | 计划/进度配置 | enabled=true, maxSteps=100 |
| notifications | 通知配置：总开关与触发原因 | enabled=true, reasons=approval_required,waiting_user,completed,iteration_limit |
| searchProvider | 搜索引擎 (ollama/searxng/brave/duckduckgo) | duckduckgo |
| ollamaApiKey | Ollama Web Search API key | - |
| searxngUrl | SearXNG 实例地址 | - |
| braveApiKey | Brave Search API key | - |
| enabledPlugins | 启用的内置插件列表 | [] |
| externalPlugins | 外部插件模块路径列表 | [] |
| plugins | 插件配置（按插件名命名空间） | {} |
| pluginStates | 用户插件启用状态（按插件 ID 命名空间） | {} |
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

未匹配的占位符替换为空字符串。

### sub_agent_prompt.md（可选）

自定义 sub-agent 任务提示词模板，覆盖默认模板 `src/prompts/sub_agent.md`。该模板用于 `sub_agent_run` 工具内部创建的临时 AgentSession，和主 agent 的 system prompt 分开管理。

**可用占位符：**

| 占位符 | 替换内容 |
|--------|----------|
| `{{task}}` | 当前子任务描述 |
| `{{context}}` | 子任务补充上下文 |
| `{{allowed_tools}}` | 当前 sub-agent 可用工具列表 |

### subAgent 配置

`sub_agent_run` 支持一次并行启动多个临时 sub-agent。默认只开放读取/检索类工具，不允许执行 shell、写文件或保存记忆。

```json
{
  "subAgent": {
    "allowedTools": ["web_search", "web_fetch", "file_read", "memory_list", "memory_read", "skill_list", "skill_use"],
    "disabledTools": ["bash", "file_write", "file_edit", "memory_save", "memory_append", "memory_delete", "sub_agent_run"],
    "maxIterations": 100,
    "maxConcurrency": 3
  }
}
```

- `allowedTools`：sub-agent 允许注册的工具白名单；未配置时使用默认只读工具集
- `disabledTools`：在白名单基础上额外禁用的工具
- `maxIterations`：每个 sub-agent 的最大 Agent Loop 轮数，默认 100，硬上限为 100
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
        "mode": "ask"
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

- `security.mode`：全局危险操作权限模式，默认 `auto`；用户可在聊天输入框下方选择 `ask`、`auto` 或 `allow`，选择会持久化到配置。`auto` 由确定性策略决定自动执行、人工审批或拒绝；`ask` 总是创建审批记录；`allow` 无条件执行。
- `security.tools.<tool>.mode`：单个工具权限模式，覆盖全局模式。`bash` 工具和技能动态 shell 统一使用 `security.tools.bash.mode`。
- `gateway.host`：Gateway API 监听地址，默认 `127.0.0.1`。暴露到其他机器时应同时配置 token。
- `gateway.token`：可选 Bearer token。配置后 API 请求需要携带 `Authorization: Bearer <token>`。
- `auditTools`：是否把工具调用和完成状态写入日志，默认开启。审计日志不会记录文件内容或记忆内容。

自动审批策略位于独立安全模块，输出 `allow`、`ask` 或 `deny` 以及风险等级、规则 ID 和原因。策略默认放行普通工具和命令，当前工作目录内的创建、覆盖、编辑、移动和删除均视为低风险；目录外写入、提权、系统状态修改和远程脚本执行进入 `ask`；格式化磁盘、删除根目录等灾难性操作直接 `deny`。每次自动决策写入审计日志，但不记录文件内容或密钥。

`security/sed-analysis.ts` 单独识别 `sed` 的字面量只读行打印子集：`p`、数字或 `$` 行地址及范围、多条打印命令、`-e` / `--expression` 和只读选项。识别成功的命令不要求项目信任；`-i`、`w`、`e`、外部脚本或未支持的表达式保守请求确认。外层 shell 分析仍独立检查动态展开、管道中的其他命令和重定向，不因识别只读 `sed` 而放宽。显式 `ask` 模式仍始终请求审批。

项目模式自动审批允许命令前的普通静态环境赋值（如 `AI_ENTRY`、`AI_OUTPUT_FILE`）；动态展开、独立赋值、加载器/解释器配置、PATH/HOME、Git 环境覆盖等仍需确认。普通对话保持原有 CI/NODE_ENV/FORCE_COLOR/NO_COLOR 有限白名单。自定义变量的业务含义由项目代码决定，该策略与允许执行项目脚本一致，不是对脚本内部副作用的沙箱保证。系统查询限定为 `nproc`/`nproc --all`、无参数 `vm_stat`、`od -c` 和 `sysctl -n` 的 CPU/内存硬件键，不整体放行这些命令。

项目内 Git 暂存（明确路径或 add -A/-u）、仅带 -m/--message 的普通提交、单个新分支创建可自动通过，无需额外信任项目。路径越界、特殊 pathspec、未知选项、全局配置覆盖、历史重写、工作区恢复/清理和远程操作仍需确认，即使项目受信任也不例外。提交 hooks 和暂存 filters 属于项目代码执行授权范围，并非无副作用操作；管道与重定向仍独立检查。

bash、background_start 和技能动态命令显式声明支持安全执行转换，审批分析器通过 AST 的源码位置构造 executionCommand；不能精确定位或整条命令存在其他风险时不自动转换放行。普通 git diff 在执行时禁用外部 diff、textconv、pager 和 fsmonitor；显式请求外部辅助程序仍需审批。直接 npx 调用仅在执行目录的 node_modules/.bin 存在可执行目标且真实路径位于当前项目内时，替换为该目标的绝对路径，绕开 npx 下载/缓存解析；包版本、安装参数、缺失目标和外部符号链接不自动放行。执行器必须使用同一 executionCommand，审计日志记录原命令与实际命令，bash/后台工具结果也返回实际命令。

所有项目会话使用项目独立的受管 TMPDIR，写入及路径展开均按同一目录检查，不要求额外标记项目信任。前台、后台及技能动态命令设置相同 TMPDIR；提示词引导模型用 `$TMPDIR` 存放临时日志。任意 `/tmp` 写入、目录穿越、符号链接逃逸仍需审批，不静默改写用户指定的日志路径。显式 ask/allow 模式语义不变。

`ask` 模式及自动策略返回的 `ask` 决策使用 workspace 级审批事实源。审批请求与 Agent continuation 原子写入 `workspace/approvals/<approvalId>.json`，文件权限为 `0600`；记录按 workspace、工具名、参数和调用者身份去重，过期时间由 `security.approvalTtlMs` 配置，默认 24 小时。已存在的 expiresAt 不随默认值变化。`AgentSession` 创建时从事实源恢复待审批调用，因此页面刷新、切换会话和 Gateway 重启不会丢失审批。单次批准后的许可只消费一次；“允许本轮”的后续临时授权仍只保存在当前恢复循环内，并在结束、失败或取消后清理。Gateway 暴露 `/approvals` 系列接口，Web UI 提供“批准本次”“允许本轮”和拒绝操作；批准与拒绝都会把最终工具结果送回原 Agent Loop。飞书审批继续按用户 `open_id` 和 `chat_id` 隔离。

过期记录及 continuation 保留在原文件，拒绝直接批准过期请求。POST `/approvals/:id/renew` 与 core-chat-commands 注册的 `/renew-approval` 显式将 expired 转为 pending，按当前配置重设 expiresAt，保留原 ID、命令、参数和创建时间；不授予许可，不调用模型或工具。后续批准时仍经过原执行器和当前权限检查。历史投影覆盖旧 displayResult 中的期限及审批状态；前端在期限到达时禁用批准并展示重新申请入口。停止接口支持从磁盘恢复待审批会话再取消，不要求会话已加载到内存。旧版本已删除的记录无法恢复。

当工具结果包含 `requiresConfirmation: true` 时，Agent Loop 会立即暂停当前轮，但不会把临时审批结果写入模型历史，避免同一个 `tool_use_id` 最终对应两条正式结果。历史接口读取独立审批事实源，为尚无结果的工具调用生成只用于 WebUI 的审批投影；批准、拒绝或过期后才向模型历史追加唯一的最终工具结果。计划处于 `waiting_approval` 却找不到有效 continuation 时，会降级为 `waiting_user`，提示用户继续任务后重新发起审批，避免出现没有操作入口的悬空状态。

### autoMemory 配置

`core-auto-memory` 插件在主会话最终回复后记录完整对话轮数，默认 workspace 内累计 10 轮后触发一次模型整理。它不会每轮额外调用模型；每轮最终问答会连同 `global` 或 `project:<项目根目录>` 作用域按 session 持久化到 `workspace/sessions/<session>/state.json` 的 `autoMemory.pendingTurns`。达到阈值时，整理任务在后台运行，不阻塞当前回复完成和下一轮用户输入；用户执行 `/dream` 时则同步等待整理结果。两种入口都会聚合所有主会话的待整理增量，再按 scope 分批调用模型；每批只看到全局与当前项目允许的记忆，自动写入被宿主强制限定到该批 scope。

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

自动记忆会跳过 `sub:` 开头的 sub-agent 会话，也会跳过模型中间工具调用，只在最终回复时计入一轮。每条 pending turn 持有稳定 ID 和记忆 scope；旧状态缺少 scope 时从 Session 元数据补算。整理开始时冻结待处理 ID 快照，每个 scope 成功后通过 Session 状态原子更新只删除该批处理的 ID，其他 scope 失败时仍保留待重试内容，整理期间新增的轮次也不会丢失。workspace 级文件锁避免多进程并发整理，Session 状态锁避免会话摘要和自动记忆整文件覆盖。即使没有新增对话，`/dream` 也会运行一次 workspace 级整理。后台整理和 `/dream` 都通过 `[AUTO_MEMORY]` 日志记录排队、开始、工具操作、完成、跳过和失败状态；日志只记录 memory 名称和计数，不记录对话或记忆正文。记忆写入统一校验 `memory.maxItemChars` 和 `memory.maxTotalChars`，超限时返回可重试错误，不会静默截断后落盘。

### 图片附件

`core-attachments` 插件注册 `POST /uploads` 和 `GET /uploads`，上传文件按 session 保存到 `workspace/sessions/<session>/attachments/`。消息历史只持久化附件 ID、相对路径和 MIME 类型，不保存 Base64；模型调用时由协议适配器读取文件，OpenAI Chat 转为 `image_url` data URL，Anthropic Messages 转为 base64 image block。删除 session 时附件目录会随 session 一起删除。

上传端会校验文件签名、声明 MIME、文件大小和允许类型，附件只能在所属 session 中引用。WebUI 支持选择或粘贴 PNG、JPEG、WebP、GIF 图片，发送前可预览和移除。

## 核心数据流

```
用户输入
  ↓
PluginManager 加载核心插件（tools, sub-agent, prompts, history, session-summary, auto-memory, compress, logger, notifications）
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
│  onChatResponse 钩子 → 响应后处理                  │
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

列表接口支持 `page`（从 1 开始）、`page_size`（20/50/100，默认 20）及 `session_id`，按 startedAt 与 requestId 倒序返回轻量 traces、page、pageSize、total。每个 trace 旁原子保存 `.json.meta` 索引，不含 events；列表异步读取索引，旧记录缺少索引时逐条异步读取并补建，损坏记录跳过，迁移不覆盖并发写入的新索引。首次索引建立仍可能较慢。详情通过 ID 按需加载，WebUI 使用 `view=display` 仅传输请求和最终响应；省略该参数仍可取得完整 trace。前端翻页替换列表而非追加，筛选和页大小变更回到第一页，列表与详情请求取消旧请求并检查取消状态，防止迟到响应覆盖新选择。

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

### 消息历史与上下文压缩

Agent 向插件提供全部未压缩历史和当前轮消息，不按 historyWindowSize 或工具消息类型裁剪；跨轮保留完整工具调用及结果，只修复孤立的协议记录。唯一摘要路径是 core-session-summary，在 onBeforeModelCall 按完整输入 Token 阈值触发，主会话和子 Agent 共用。

摘要只覆盖已结束的历史轮次，成功落盘后推进整个轮次的覆盖序号（包括未发给摘要模型的工具消息）。当前轮尚无最终回答，不生成摘要，仅沿用工具结果截断。关闭摘要时不生成临时摘要、不按轮数丢弃历史，工具结果预算保护仍生效，硬预算不足时明确报错。取消和失败保留原文及已提交的摘要批次。原始 messages.jsonl 不被摘要改写。

摘要请求将提示词、已有条目、元数据和问答投影一起计入 maxInputChars，同时预留 maxOutputTokens 并检查模型上下文上限；二分选择能容纳的完整轮次前缀，不拆分单轮问答。按 turnId 分组，旧消息缺少 turnId 时以真实用户输入分轮；每轮只发送用户输入及末尾无工具调用的模型回答。工具名称、参数、结果、思考、中间播报和 runtime_notice 全部排除，图片仅保留附件名称。失败或中止且没有最终回答的轮次仅保留用户输入，不编造回答。模型引用只能来自实际发送的问答，覆盖范围仍以原始连续消息校验；纯工具残留可直接提交空 Delta，不调用模型。单轮问答无法容纳时保留原文，不截断用户输入、不推进覆盖序号。所有主模型调用继续执行最终硬预算和工具链合法性检查。

主请求的工具输出只做确定性截断，不做模型摘要。根据 turnStartIndex 区分当前轮与历史轮，审批恢复沿用原轮边界。历史结果按 plugins.core-tool-context.historyResultMaxChars（默认 500，正整数）保留前缀，附带 truncated、originalChars 和 contentRef.toolCallId；当前轮沿用单条和共享 Token 预算，新结果优先。审批及用户确认控制消息不截断。请求投影保留工具协议配对，不修改磁盘原文；摘要覆盖旧消息组后仍可按调用 ID 读取原结果。

工具边界控制单次输出：fileReadMaxChars 默认 20000，超限明确提示按行读取；bashMaxOutputChars 默认 10000，分别限制 stdout/stderr 尾部，超限标记 truncated 并提供 workspace/tool-output/<uuid>.log 完整日志。file_read 仅对该内部日志目录中的 UUID 日志提供受根目录校验的跨项目只读访问。项目搜索保留原有字符及结果数限制。历史层不对工具实际返回内容二次截断。

### 会话结构化摘要与原文召回

滚动摘要使用独立 SummaryBatch（ID、消息覆盖范围、文本、时间），任务状态只保留 active goals/constraints/pending。Delta 仍作为一次更新的校验协议，但先将目标引用解析成独立批次文本，事实与过程不再累计进入任务 Checkpoint。批次、任务状态、覆盖序号在同一原子提交中更新。旧 Checkpoint 纯本地转换：保留覆盖位置和有效任务条目，其余 active 条目作为带来源范围的 legacy 批次保存；先备份旧 revision，再原子切换，不回放已覆盖历史，不调用模型迁移。

集中压缩由 maxBatchesPerCompression（默认 3）和 maxCompressionDurationMs（默认 120000）限制。每批调用前以剩余总时间创建取消信号，并以 Promise race 防止不响应信号的适配器阻塞；迟到结果不提交。用户取消仍传播为取消，而预算耗尽转为保留原文的工具投影兜底，最终硬预算检查保持生效。每批报告批次、覆盖位置、剩余条数和已用时，成功批次即时原子提交，后续请求只处理未覆盖部分。

预算统一为扣除固定提示词、工具定义、输出预留和安全空间后的可用容量，高水位默认 80%，低水位默认 20%；完整动态包装及运行资料均参与计数。正常追加阶段不改写摘要投影。集中整理时依次处理已结束轮次的问答，选择最近 N 批独立摘要（默认 5），并受 maxBudgetRatio（默认 0.1）约束；单批 maxBatchTokens 默认 1500，生成后校验，超限有限重试。不能达到低水位时从旧工具结果回收正文额度，保留原文引用，最新结果优先但不以每条最低额度突破共享硬预算。

projection 持久化选中批次 ID 与工具结果 Token 上限，旧原文不因淘汰摘要或服务重启重新注入；批次正文不可变。摘要数据和原文仍保留在磁盘供追溯。只在达到低水位时上报达标，必要内容超过目标但符合硬预算时继续，否则最终请求校验拒绝发送。配置加载和设置保存共同校验 `0 < target < trigger < 1`。存储 compact 仅用于归档 Delta，不做摘要再摘要；归档阈值不包含累积的独立批次，避免批次增多后每次都触发归档。

`core-session-summary` 在模型请求前达到高水位时读取持久化历史，生成严格 JSON Delta；低占用时不按轮数生成。校验器要求 revision 与连续 sequence 范围正确，且每个操作只能引用本批真实 `messageId`；程序补全来源、生成确定性 ID，以纯 Reducer 更新任务状态，同时生成独立历史批次。成功提交后才推进覆盖序号，后续只提取未覆盖消息。摘要请求检查输入字符和模型 Token 预算，按完整交互分批；单批无法容纳或摘要超长时不推进该批覆盖序号。达到 Delta 数量或 Checkpoint 字符阈值时先归档旧 revision，再固化 Checkpoint。

模型调用时，摘要被序列化为带 `data-kind="derived-summary"` 和 `role="internal"` 的临时派生上下文。`model-context.ts` 在请求投影阶段将其追加到 System Prompt 的历史资料区，明确它不是新指令，不再使用 `assistant` 角色冒充模型输出，避免思考模式要求 `reasoning_content` 时拒绝请求。带 `_source: runtime_notice` 的程序提示持久化供 UI 展示，但请求投影将它们移入运行资料区；不根据文本猜测旧消息来源。真实模型消息和思考字段不改写，摘要不写入原始历史，工具调用和结果之间不插入合成消息。预算计算涵盖资料及其边界提示，上下文快照仍单列摘要并反映实际 System Prompt；动态资料变化可能影响前缀缓存。未被摘要覆盖的原文全部保留；旧版自由文本摘要只在首次读取时迁移，并带 legacy_summary 来源。旧摘要缺少覆盖时间时不推测覆盖范围，保留历史原文。

`core-session-recall` 单独注册只读工具 `session_history_recall`。工具只能读取执行上下文中的当前 session，可按摘要来源 messageId、sequence 范围或关键词查询 `messages.jsonl`，返回稳定 ID、序号、turnId、角色、时间和原文。条数、查询长度和输出字符上限由 `sessionSummary.recallMaxResults`、`recallMaxQueryChars`、`recallMaxOutputChars` 控制。

摘要开始、完成和失败通过通用 Hook 状态回调进入 SSE，WebUI 显示明确的整理提示；状态不写入消息历史。摘要失败保留当前 Checkpoint 并继续完成用户对话。旧快照中的临时摘要仍可展示，但不再生成。

### 工具注册：插件化

工具通过 `PluginContext.registerTool()` 注册到 `TOOL_CAPABILITY`。核心插件 `plugins/core/tools.ts` 在初始化时注册基础内置工具，`plugins/core/sub-agent.ts` 单独注册 `sub_agent_run`。

所有插件的工具由 PluginManager 从 Capability Registry 动态合并，模型调用时通过 `getTool(name)` 查找执行。同名工具后注册者覆盖前注册者，卸载覆盖项后自动回退。新增工具只需：1) 在任意插件中实现 Tool 接口 2) 在插件 init 中注册。

`PluginManager` 支持工具白名单/黑名单过滤（`allowedTools` / `disabledTools`），用于 sub-agent 等需要收敛权限的场景。工具在注册阶段被过滤，模型看不到被禁用的工具定义，也无法调用这些工具。文件工具支持 workspace 外路径；危险操作默认使用自动审批，可通过 `security.mode` 或 `security.tools.<tool>.mode` 配置为 `ask`、`auto` 或 `allow`。灾难性操作由自动审批策略在内部直接拒绝，不作为用户可选模式。

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

Sub-agent 使用独立任务提示词模板，不复用主 agent 的 system prompt。默认模板为 `src/prompts/sub_agent.md`，可用 `workspace/sub_agent_prompt.md` 覆盖。模板支持 `{{task}}`、`{{context}}`、`{{allowed_tools}}`。

**隔离边界：**

- 每个 sub-agent 使用独立 `AgentSession` 和独立历史
- Sub-agent 的历史不会直接合并进主 agent 历史
- 主 agent 只接收 sub-agent 的结构化汇报结果
- Sub-agent 当前不支持运行中双向对话，也不支持 sub-agent 之间通信
- Sub-agent 不持有可交互审批续跑状态。子任务工具触发 `ask` 时，执行器会清理该 `sub:*` 审批并返回 `approval_required`，由主 agent 使用结果中的同一工具参数重新发起调用；这样审批归属主 Session，可由 Gateway 正常恢复
- 审批去重键包含 Session ID，主 agent 与 sub-agent 即使调用相同工具和参数也不会复用审批记录
- 每个临时 sub-agent 结束后都会销毁其专用 `PluginManager`，释放插件及运行时状态

### 持久化记忆

记忆系统分为 Profile 和向量长期记忆两个插件模块：

- **Profile 写路径**：`profile_save` 写入 `workspace/profile/*.md`；`profile_delete` 只在用户明确取消或遗忘规则时删除
- **Profile 读路径**：`core-profile-memory` 每次模型调用前读取所有启用 Profile 并固定注入全文，不参与向量检索和时间遗忘
- **Memory 写路径**：`memory_save` 和 `memory_append` 写入 `workspace/memory/*.md`
- **Memory 读路径**：`core-vector-memory` 根据当前用户问题执行混合检索，最终从 Markdown 读取命中正文并按字符预算注入
- **作用域**：普通会话只访问 `global`；项目会话访问 `global` 与当前项目 scope，默认写当前项目、显式指定时可写 `global`，禁止访问其他项目
- **文件格式**：带 frontmatter 的 Markdown，名称语义化（如 `user-preferences.md`、`project-context.md`）
- **安全**：文件名仅允许字母、数字、下划线、连字符，防止路径遍历
- **启停控制**：`disabled: true` 的内容保留在磁盘中，但不固定注入或参与默认向量召回
- **来源标记**：`source` 记录记忆来源，取值为 `auto`、`tool`、`manual`，便于 Web UI 审计和人工整理

### 系统提示词模板（插件化）

系统提示词构建已迁移到 `plugins/core/prompts.ts` 插件中，通过 `onBuildPrompt` 钩子实现。

采用单文件模板方案，支持用户自定义覆盖。`src/prompts/default.md` 是默认模板，使用 `{{placeholder}}` 占位符语法。用户可在 `workspace/system_prompt.md` 放置自定义模板覆盖默认值。

模板加载逻辑：优先检查 `workspace/system_prompt.md`，存在则使用用户模板，否则使用 `src/prompts/default.md`。运行时将模板占位符替换为 identity、skills 等基础内容（不自动注入当前日期）；`{{tools}}` 保留到 `onBuildTurnPrompt`，按当前会话、执行模式和计划阶段动态生成，无此占位符的自定义模板则追加当前工具清单。HookContext 查询工具时同样经过阶段过滤，避免缓存的系统提示词暴露完整工具列表。Profile 与向量召回内容由各自插件通过 `onBuildTurnPrompt` 动态追加，确保写入后下一次模型调用即可生效。

Agent 对同批工具逐个重新查询当前允许的工具集合。前一个状态更新成功后，后续调用按最新状态校验；更新失败不开放执行工具，完成或暂停步骤后也立即收回执行能力。已开放工具仍须通过执行前插件校验与权限审批。越界调用不执行，持久化配对结果并返回 `status: "blocked"`；`reason` 区分 unregistered_tool 与 currently_unavailable，后者可在条件满足后重试，`availableTools` 给出当前列表，不表示整轮禁用。WebUI 单独显示“已拦截”，不计入成功或失败。

其他插件可以通过 `ctx.extendPrompt()` 注册 `PromptSection`，自动追加到系统提示词末尾。

### 技能系统

技能是 Markdown 文件。个人/workspace 技能放在 `workspace/skills/` 目录下；项目模式会额外发现项目根目录的 `.agents/skills/`，并兼容 `.claude/skills/`。每个技能目录包含一个 `SKILL.md`，其中包含 frontmatter（name、description）和指令正文：

```markdown
---
name: code-review
description: 代码审查，检查代码质量、安全性和最佳实践
---

你是一个代码审查专家。执行以下步骤：...
```

- **发现**：普通会话扫描 `workspace/skills/<name>/SKILL.md`；项目会话额外扫描 `<project>/.agents/skills/<name>/SKILL.md` 和 `<project>/.claude/skills/<name>/SKILL.md`，将名称和描述注入 system prompt
- **激活**：模型调用 `skill_use(name)` 获取完整指令内容，指令中注入技能工作目录绝对路径。项目模式下裸名优先匹配项目技能，也可以用 `project/<name>` 或 `workspace/<name>` 精确指定来源
- **查询**：模型调用 `skill_list()` 列出当前会话可用技能，并带上 `project/` 或 `workspace/` 来源前缀
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

**静态文件服务：** Gateway 启动时自动在独立端口（默认 gateway 端口 +1，可通过 `--web-port` 指定）启动 Web UI 服务器。daemon 父进程在派生后台子进程前检查 `web/dist/index.html`，缺失时同步执行现有 `web:build` 脚本；只有构建成功且产物存在才启动 Gateway，失败则保留构建输出并终止启动。已有构建产物时直接提供静态文件并代理 API 请求；非 daemon 模式缺少构建产物时仍可启动 Vite dev server。

### Web UI

工具历史展示不以结果缺失推断正在执行。Gateway 在补齐审批后，根据对应轮次的 Run 和 pendingToolCallId 为无结果调用提供运行、中断或结果未知状态及原因，不依赖计划步骤状态；普通会话同样适用。前端实时调用以流事件及开始/结束时间判断活动状态，轮次结束后无结果调用停止计时，显示结果未知。过期审批保留入口，展示重新申请操作；审批被处理或取消后刷新历史移除入口。历史原文保留，当前中断原因在工具卡片单独展示。

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

切换会话或首次加载历史消息时，消息列表在布局阶段立即定位到底部；同一会话后续流式输出仍使用平滑滚动。

Web UI 按 session 保存消息、流式文本、工具调用、运行状态和中止控制器。切换会话或进入其他页签不会关闭仍在运行的 SSE；流事件继续写入其所属 session，返回该会话时可恢复处理中状态和已有输出。“停止”只中止当前会话。Gateway 的 `GatewayStream` 独立消费 Agent 事件，维护当前轮次累计文本、工具状态与订阅者，页面连接断开仅移除订阅；任务结束后释放内存快照。刷新或断线后，前端根据会话轮询通过 `GET /sessions/:id/events` 获取 `snapshot` 并订阅后续增量，204 表示任务已结束，应刷新历史。按快照 `turnId` 替换同轮历史助手片段，避免历史消息和流式消息重复；审批恢复沿用审批 ID 合并工具结果。该机制只恢复当前 Gateway 进程中的 Web 任务，不跨服务重启恢复执行。助手消息由 ReactMarkdown 渲染，围栏代码块通过共享的 highlight.js 语言注册表执行语法高亮；项目 Diff 视图复用同一高亮模块，未知或未标注语言使用自动识别。

Web UI 的主题状态只属于客户端展示偏好，不进入 Gateway 配置或 Session 数据。首次加载优先读取浏览器 `localStorage` 中的 `breeze-coder-theme`，没有有效值时使用 `prefers-color-scheme`；用户通过侧栏切换后持久化为 `light` 或 `dark`。`index.html` 在 React 挂载前同步设置根节点的 `data-theme`，避免页面先以浅色渲染再切换；组件样式通过语义化 CSS 变量响应主题。

**记忆管理：** Web UI 提供"记忆"页签，支持搜索、刷新、查看、编辑、保存、删除、启用/禁用长期记忆。面板直接调用 `/memory` API，不通过 agent tool，以避免管理操作被模型行为影响。

**开发模式：** `npm run web:dev` 启动 Vite dev server（:5173），通过代理转发 API 请求到 Gateway（:3000）。

**生产模式：** `npm run web:build` 可手动构建到 `web/dist/`；daemon 启动时若产物缺失也会自动完成该构建。Gateway 随后在独立端口启动 Web UI 服务器并代理 API 请求。默认 `http://localhost:3001`（可通过 `--web-port` 指定）。

### 插件系统

Breeze Coder 采用插件化架构，主框架（AgentSession）只负责编排 Agent Loop 和在关键节点调用插件钩子，所有业务逻辑（工具注册、提示词构建、上下文压缩、日志记录）均由插件实现。

**核心原则：** 插件通过注册钩子介入流程，框架通过 PluginManager 统一调度。

**类型化插件内核（第一阶段）：** `src/kernel/` 提供 Capability Registry 和 Application / Session / Turn 三级作用域。Capability Token 显式声明单例或多实例语义；单例能力按优先级选择，同优先级冲突直接报错，多实例能力按优先级有序聚合。子作用域继承父级能力与作用域数据，又可以在本地隔离 Session 和 Turn 状态；销毁作用域时会递归、逆序释放已注册资源。

第三阶段已将 Capability Registry 切换为唯一能力数据源。`PluginManager` 不再维护工具、命令、路由、Prompt Section 和 Hook 的重复容器；Agent Loop、Gateway 和命令分发都通过对应 Capability 快照读取。工具和命令重名时保持“后注册覆盖前注册”语义，覆盖项卸载后会自动回退到上一个贡献。Hook 每次调度开始时获取稳定快照，调度中发生的卸载从下一次生命周期调用起生效。

旧 `registerTool` / `registerChatCommand` / `registerRoute` / `registerHooks` / `extendPrompt` API 仍保留，但只向 Capability Registry 写入，并返回幂等 `Disposable`。现有插件可继续忽略返回值；需要动态卸载单项能力时可调用 `dispose()`，ApplicationScope 销毁时仍会兜底释放全部注册。

第二阶段已将会话运行状态迁入 Scope：`PluginManager` 只保留 `sessionId -> SessionScope` 定位索引，`Config`、`ModelClient`、`MessageHistory` 和 `SessionContext` 存储于 SessionScope，`turnId` 和 `executionMode` 存储于当前 TurnScope。普通完成、错误和取消会释放 TurnScope；等待审批时保留原 TurnScope，批准后复用它继续执行。Gateway 重启后仍以 `events.jsonl` 为恢复事实源，并用持久化的 turn ID 和执行模式重建 Scope，不依赖旧内存对象。Session 删除、超时回收、配置刷新和 Gateway 退出都等待 SessionScope 递归释放。

第四阶段引入 `PluginHost`、`PluginGraph` 和 `PluginContainer`。Loader 先只发现并导入插件，再由 PluginHost 在全部注册后校验 Manifest、SemVer 依赖和循环依赖，按拓扑顺序启动、反向顺序停止。每个插件容器独立持有 `DisposableStore`；启动失败会回滚该插件已注册的所有能力，停用后工具、命令、路由和 Hook 立即消失，重新启动时创建新的资源代。核心插件校验或启动失败会终止宿主启动；用户插件失败只标记自身 `failed` 并将必需依赖者标记为 `blocked`，独立插件继续启动。

新插件可实现带 `manifest` 和 `setup()` 的 `KernelPlugin`；现有 `{ name, init, destroy }` 插件由适配器转为版本 `0.0.0` 的 KernelPlugin，无霋立即改造。PluginManager 对内提供插件状态列表以及启动、停用和重载方法；workspace 插件重载时使用唯一 import URL 绕过 ESM 模块缓存，重新校验导出 ID 后创建新容器。本阶段不暴露 HTTP 管理 API，也不修改配置格式。

**Plugin 接口：**

```typescript
interface Plugin {
  name: string;
  init(ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}
```

**KernelPlugin Manifest：**

```typescript
interface PluginManifest {
  id: string;
  version: string;
  kind: "core" | "builtin" | "workspace" | "external";
  requires?: Record<string, string>;
  optional?: Record<string, string>;
  provides?: string[];
}
```

**PluginContext（宿主提供）：**

| 方法/属性 | 说明 |
|-----------|------|
| `config` | 插件专属配置（来自 `plugins.<name>`） |
| `workspacePath` | 工作目录路径 |
| `applicationScope` | 宿主级作用域，统一管理 Capability 和可释放资源 |
| `capabilities` | ApplicationScope 的类型化 Capability Registry |
| `registerRoute(route)` | 注册 HTTP 路由并返回 `Disposable` |
| `registerTool(tool)` | 注册工具 Capability 并返回 `Disposable` |
| `registerChatCommand(command)` | 注册用户显式触发的斜杠聊天命令并返回 `Disposable` |
| `executeChatCommand(input, options)` | 执行已注册聊天命令，供平台插件复用 |
| `registerHooks(hooks)` | 注册生命周期钩子并返回 `Disposable` |
| `extendPrompt(section)` | 注册提示词片段并返回 `Disposable` |
| `getOrCreateSession(id, prefix?)` | 获取/创建 AgentSession |
| `deleteSession(id)` | 异步删除会话并等待 SessionScope 资源释放 |
| `log(level, message, sessionId?)` | 插件日志 |

**插件分类：**

1. **核心插件**（`plugins/core/`）：始终启用，实现基础功能
   - `core-tools`：注册基础内置工具（文件、搜索、记忆、技能等）
   - `core-sub-agent`：注册 `sub_agent_run`，提供并行临时 sub-agent 能力
   - `core-prompts`：系统提示词模板加载与占位符替换
   - `core-history`：将用户输入写入当前会话 `MessageHistory`
   - `core-session-summary`：维护普通会话滚动摘要，减少旧消息原文进入上下文
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
- 通过 Capability Registry 查询工具、命令、路由、Prompt Section 和 Hook
- 按稳定快照串行调度 Hook
- 委托 PluginHost 管理 Manifest 校验、依赖顺序、故障隔离与插件级资源
- 提供 `setRuntimeDeps()` 在 AgentSession 创建后注入 `Config` 和 `ModelClient`

**路由注册表：** Gateway 启动时通过 PluginManager 加载插件，插件通过 `registerRoute()` 注册路由。请求匹配时插件路由优先于核心路由。路由 `path` 支持 `:param` 动态路径段（如 `/sessions/:id/model`），由 `src/plugins/route-matcher.ts` 的 `matchRoutePath()` 纯函数匹配，匹配到的参数以原始 segment 形式写入 `RouteContext.params`，由 handler 自行 `decodeURIComponent`；Web 静态服务器代理判断同样复用该匹配器，使插件新增的动态路由无需在代理白名单中单独登记。

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
- `TOOL_CAPABILITY`：注册、定义导出、同名覆盖与卸载回退
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
