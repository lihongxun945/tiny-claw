# tiny-claw

tiny-claw 是一个插件化、可扩展的个人 AI Agent，能够围绕用户目标规划步骤、调用工具并持续执行任务，支持资料检索、文件处理和项目开发。它集成了长期记忆、上下文管理和权限审批，可连接远程模型或运行本地模型，并通过 macOS 客户端、Web UI、CLI 和飞书提供交互入口。开发者可以通过 Skill、Sub-agent 和自定义插件扩展能力，构建适合自己工作方式的智能助手。

![tiny-claw WebUI](docs/images/tiny-claw-webui.png)

## 核心功能

- 自主 Agent Loop、流式输出和多轮工具调用
- 远程模型与内置 Qwen、Gemma 本地模型
- Web 搜索、网页读取、Shell、文件读写和项目开发工具
- 可选的规划工具，支持持久化任务目标、步骤与进度，不强制限制工具执行
- 会话历史、上下文压缩、滚动摘要和跨会话长期记忆
- Skill、Sub-agent 和自定义插件扩展
- 危险操作权限审批、单次授权与本轮授权
- Web UI、macOS 客户端、Gateway API 和飞书机器人
- 图片输入、上下文占用与请求内容查看、模型调用调试和工具审计日志

## 本次更新（0.1.0-beta.22）

- **流式续跑更连贯**：审批恢复时合并同一轮已有文本和工具记录，刷新后继续接收完整轮次的更新，减少重复工具展示。
- **规划更灵活**：更新进度可以省略整体标题，沿用本轮或明确关联的历史计划标题；规划工具仍是可选能力，审批独立生效。
- **思考模型兼容修复**：摘要和程序生成的运行提示不再冒充模型回复，真实 `reasoning_content` 原样保留；协议错误增加结构化诊断，不伪造思考内容或重放工具。
- **减少重复审批**：项目内普通静态环境变量、常规 Git 暂存/提交/分支创建可自动通过；Git Diff 安全转换、本地 npx 解析和受管临时目录继续保留安全边界。破坏性操作、远程操作和环境覆盖仍需确认。
- **长任务支持**：主 Agent 默认迭代上限调整为 1000 次，Sub-agent 默认及最大上限为 100 次；已有显式配置保持不变。
- **导航调整**：侧边栏将项目入口放在对话之前。

## 主动询问

Web UI 和 macOS 客户端支持模型调用 `ask_user` 主动弹出问题，提供单选、多选或自由回答。等待回答时暂停当前任务，不能追加新任务；关闭弹窗可稍后从“回答问题”入口继续，也可终止任务。答案写入原工具调用结果并恢复同一轮流式输出，不授予工具执行权限。刷新和重启保留待回答问题，默认不自动过期。问题及答案在历史消息中可见。

能力由 `core-user-input` 插件实现，配置位于 `plugins.core-user-input`：`enabled` 默认 true，`maxOptions` 默认 8，`maxQuestionChars` 默认 4000，`maxAnswerChars` 默认 12000。CLI、飞书保持正文提问；子 Agent 不开放弹窗工具，由主 Agent 汇总需要澄清的问题。

## 项目定位

tiny-claw 面向个人任务自动化与项目开发，注重执行过程可见、数据本地保存和能力按需扩展。核心机制采用 TypeScript 实现，工具、记忆与外部平台接入通过插件组织，方便阅读源码、定制行为和集成到现有工作流程。

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
- 会话仍在后台执行时，左侧列表会显示“执行中”状态并自动刷新；选中该会话后只能停止，不能追加发送新消息。
- 页面刷新或连接中断后会重新订阅当前任务，恢复已有输出并继续流式更新；同一轮输出合并为一条助手消息，关闭页面不会取消任务。
- 模型请求前的同步摘要阶段显示“正在进行上下文压缩...”，期间输入框保持锁定；压缩完成后继续请求模型，任务结束才解除锁定；失败时保留原始消息和已有摘要，硬预算允许时继续。
- 复杂任务可通过 `update_plan` 展示计划和进度，默认折叠；简单问答不需要计划。未创建计划或进度更新失败都不会阻止执行，安全审批保持独立。
- 更新计划进度时可省略整体 `title`，保留本轮原标题；明确关联历史 `plan_id` 时可继承其标题。没有可用标题的新计划仍需提供 `title`，每次提交完整步骤列表。
- 自动审批支持普通静态环境设置的项目测试（如 `CI=true`、`AI_ENTRY=scripts/test.js`）、普通 Git Diff 和已安装的本地 `npx` 工具。加载器变量、执行路径和 Git 环境覆盖仍需审批。Diff 自动禁用外部辅助程序，本地工具不会通过 npx 自动下载；实际转换命令会记录在结果和审计日志中。项目临时日志请使用受管 `$TMPDIR`，任意 `/tmp` 写入仍需确认。
- 项目内的常规 `git add`、`git commit -m` 和分支创建可自动通过；破坏性操作、远程操作、特殊选项与项目外写入仍需审批。Git hooks、filters 和自定义环境变量的具体行为取决于项目代码，自动审批不等于沙箱隔离。
- 点击停止显示“正在停止...”，确认结束后恢复输入；上下文压缩也可取消。macOS/Linux 上命令取消或超时会终止其进程组，包括普通后台子进程；`bashTerminationGraceMs` 配置强制终止前的宽限期，默认 1000 毫秒。
- 自动审批按 shell 语法分析管道、重定向与工作目录；`2>/dev/null`、`2>&1` 和引号内普通文本不再误判为外部写入。不支持的语法请求确认，并显示具体原因。
- 自动审批支持只读 `sed` 行打印，例如 `sed -n '15,100p' file`，无需信任项目；支持数字或 `$` 行地址和多个 `-e` 打印表达式。原地编辑、写文件、执行命令、外部脚本及未识别表达式仍需确认；管道和重定向分别检查。“每次审批”模式不受影响。
- 自动审批也支持 `find` 的常见只读查询，以及 `git status`、`git ls-files`、`git rev-parse` 的已识别只读选项，无需额外信任项目。`find -o` 按“或”处理；执行外部命令、删除、写文件、Git 全局配置覆盖及未知选项仍需确认。
- 只读查询还支持 `git branch --show-current`、`git log --oneline -N` 和受限的 awk 字段打印、算术格式化。Git diff 需显式带 `--no-ext-diff --no-textconv` 禁用外部助手，选项仍单独校验。项目文件的 `node --check` 可自动通过；`timeout 时限 命令` 和括号子 Shell 递归检查内部操作及重定向，不改变审批边界。动态环境赋值、任意内联代码和未支持的选项仍需确认。
- 项目模式的自动审批默认允许明确的项目内 Node/Python 脚本、`npm run` / `npm test` / `npm build` 及无额外选项的 make 任务，无需额外勾选“信任此项目”。内联代码、未知解释器选项、外部脚本、系统修改、远程操作和可识别的范围外写入仍需审批；“每次审批”保持不变。这是对项目代码执行的默认授权，不是沙箱，不能保证脚本内部没有其他副作用。
- “信任此项目”仍保留在创建项目和项目设置中，用于已有的额外授权及托管 TMPDIR；不再是上述项目脚本执行的前提。同一真实目录共享设置，重启后保留。设置变更不自动执行待审批命令，也不终止已启动进程。
- 可信项目可将临时日志写入 `$TMPDIR`，指向 workspace 下隔离的 `project-tmp/<项目路径哈希>`，不放开整个 `/tmp`。路径按真实目录和符号链接边界检查。
- 项目长任务使用 `background_start`，无需 `nohup` 或 `&`；用 `background_status` 查询状态和有界日志，`background_stop` 终止。用户可直接输入 `/tasks` 或 `/task-stop <id>`，无需模型调用。后台任务独立于当前对话，点击对话停止不会终止已启动的后台任务。
- `security.background` 可配置 `timeoutSeconds`（默认 3600）、`maxRunning`（默认 4）、`maxLogChars`（默认 20000）。任务由当前服务进程托管，正常服务关闭时取消；重启不自动恢复执行，遗留运行记录显示中断。完成记录和日志保存在会话目录。
- 在“记忆”页面查看、编辑、禁用或删除长期记忆。
- 在“日志”页面查看运行日志、模型调用错误和工具审计记录。
- 在“插件”页面查看插件状态、依赖和权限声明，并编辑插件自己声明的私有配置；保存后会自动重载目标插件。
- 在“配置”页面修改模型、上下文、搜索、权限、Sub-agent、插件和调试设置。
- 输入框内审批模式左侧以“上下文 24%”显示最新上下文占用；点击可查看完整统计、System Prompt、上下文摘要、Messages、Tools 和 Token 估算明细。请求准备及超限时保存“最新预算估算（未发送）”，弹窗另外显示上次请求占用，避免工具返回后仍展示过期数字。摘要单独展示本次请求实际使用的会话摘要；兼容旧快照。
- 每个会话的最新上下文快照保存在会话目录，重启后仍可查看；尚未产生快照时隐藏入口，删除会话时一并删除快照。
- 完整工具结果保存在消息历史中，发给模型和页面展示的内容受预算保护。大结果标注“内容已精简”，可下载原文；模型通过 `session_history_recall` 的 `tool_call_id`、`result_index`、`offset`、`query` 分页或定位读取，返回 `nextOffset`，不能无限取回全文。
- `plugins.core-tool-context` 配置结果保护：`maxResultTokens` 默认 8000、`readMaxTokens` 默认 4000、`searchSnippetChars` 默认 1500、`safetyMargin` 默认 0.05、`summaryRetries` 默认 1、`searchMaxResponseBytes` 默认 8388608。历史不按固定轮数裁剪；接近 Token 阈值时可压缩当前轮较早的完整工具交互，保留最新需求和最新交互，原始历史不改写。采集超过上限的搜索响应会明确报告未完整接收。
- 工具结果预算优先分配给最新交互，旧结果可按引用取回；`readMaxTokens` 同时保障最新结果的阅读预算（受 `maxResultTokens` 上限约束）。预算不足时先压缩历史，不能通过把每页缩成几个字维持执行。请求裁剪不改写内存历史或落盘原文。
- 当工具需要审批时，在聊天消息的工具块中点击“批准”或“拒绝”；刷新、切换会话或重启 Gateway 后审批仍会保留，批准或拒绝后原任务会自动继续处理。
- 工具调用区域会显示执行中、成功、失败、已拦截和待审批状态；长任务会持续显示已执行时长。未在当前请求开放的工具不会执行，拦截记录不计入执行失败。
- 工具耗时使用后端时间戳，切回窗口立即校准，完成后保留耗时；计划信息条和历史计划显示本轮总耗时（包含等待审批）。刷新不归零，旧记录缺少时间时不显示估算值。后台任务的运行时间独立于启动工具调用耗时。
- 当前计划信息条显示完成步骤数与当前步骤，不展示百分比；展开后查看完整计划。轮次结束后，计划保留在对应历史消息中。
- 不再区分普通与计划模式；旧模式偏好兼容读取，但不限制工具。`plan.enabled` 可关闭进度展示功能，不影响聊天执行。
- 计划支持 1 到 `plan.maxSteps`（默认 8）个步骤，可自由修订；最终回答不会自动把未完成步骤标为完成。
- 运行与计划分别持久化。页面刷新继续订阅已有输出，Gateway 重启后的运行标记为中断，不自动重放可能已执行的命令。等待审批时也可点击“停止”取消任务。
- 历史回答保留当轮计划快照；后续更新可关联历史计划，但不会改写旧记录。新轮次不默认继承旧计划，旧 `plan.decisionRetries` 和 `plan.maxGateCorrections` 不再生效。
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

首次启动 CLI 或 Gateway 时，如果 workspace 中没有 `config.json`，tiny-claw 会自动生成一份完整的默认配置。可以直接编辑该文件，或在 WebUI 的“配置”页面填写 API Key、模型、搜索、权限、记忆、Sub-agent 和插件等全部设置。

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
npm run gateway -- --port 3000
```

Gateway API 默认监听 `127.0.0.1:3000`，WebUI 默认访问：

```text
http://localhost:3001
```

启动后即可在 WebUI 中创建会话并与 Agent 对话。

WebUI 支持浅色和深色主题，可在左侧栏底部切换。首次打开时跟随系统外观，手动选择后会保存在当前浏览器中；桌面版启动页同样会跟随系统深浅色设置。

`npm run gateway` 会以 daemon 模式启动 Gateway。若 `web/dist/index.html` 不存在，启动命令会先自动安装 WebUI 依赖并完成构建；构建失败时 Gateway 不会启动，并保留 npm/Vite 的原始错误输出。已有构建产物时会直接启动，不重复构建。

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
| `maxAgentIterations` | `1000` | `1000` | 单次任务最大 Agent Loop 次数；达到上限时会明确提示，配置 `0` 表示不限 |
| `searchProvider` | `"duckduckgo"` | `"brave"` | 搜索服务：`ollama`、`searxng`、`brave`、`duckduckgo` |
| `ollamaApiKey` | 无 | `"YOUR_OLLAMA_API_KEY"` | Ollama Web Search API Key，`searchProvider=ollama` 时使用 |
| `searxngUrl` | 无 | `"http://localhost:8080"` | 自建 SearXNG 地址，`searchProvider=searxng` 时使用 |
| `braveApiKey` | 无 | `"YOUR_BRAVE_API_KEY"` | Brave Search API Key，`searchProvider=brave` 时使用 |
| `enabledPlugins` | `[]` | `["feishu"]` | 启用的内置插件列表 |
| `externalPlugins` | `[]` | `["./workspace/plugins/foo/index.ts"]` | 额外加载的外部插件入口 |
| `plugins` | `{}` | `{ "feishu": { "appId": "cli_xxx" } }` | 插件私有配置 |
| `pluginStates` | `{}` | `{ "feishu": { "enabled": false } }` | 用户插件启用状态；未配置时默认启用，核心插件不可禁用 |
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
    "maxIterations": 100,
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
| `subAgent.maxIterations` | `100` | `100` | 单个子任务最大 Agent Loop 次数，上限 `100` |
| `subAgent.maxConcurrency` | `3` | `3` | 并行执行的子任务数量，上限 `8` |

### 会话摘要配置

设置默认值由后端提供。旧的临时压缩配置、历史窗口、`sessionSummary.maxChars`、`sessionSummary.turnThreshold` 和计划门禁配置兼容忽略，保存设置时清理；已有摘要、原始消息和有效自定义值不删除。旧配置缺少模型协议时仍沿用 Anthropic，新建配置使用 OpenAI Chat，避免隐式切换已有连接。

执行期间，回答下方的灰色状态行会显示等待模型响应、生成回答、调用工具或具体命令等阶段及耗时；无需展开工具或计划。刷新后可恢复当前阶段，断线、等待审批与正在停止使用独立提示。

会话摘要只在模型请求前达到 Token 预算时同步生成，不再按对话轮数触发。`contextCompressionThreshold`（默认 `0.7`）按系统提示词、工具定义、摘要和消息的完整输入计算，并预留模型最大输出空间。压缩期间显示“正在进行上下文压缩...”；低占用的多轮对话不触发。旧配置 `sessionSummary.turnThreshold` 兼容读取但不再生效，跨会话的 `autoMemory.turnThreshold` 不受影响。

未压缩的历史正文、工具调用和工具结果跨轮完整保留，不按轮数或消息类型裁剪。达到 Token 预算后，从最早的历史完整轮次生成摘要，成功持久化后才移除对应的请求原文；当前执行轮不参与摘要，磁盘 messages.jsonl 始终保留。失败保留原文和已有摘要：未超过模型硬上限则继续，超过时明确报错。旧 recentTurns 设置不再生效。

单次工具输出在进入历史前限制大小：file_read 超限时明确标记并支持 offset/limit 分段读取；bash 保留 stdout/stderr 尾部，超限返回 truncated 和完整日志 outputPath，可通过 file_read 读取。项目搜索沿用 project.searchMaxChars/searchMaxResults。字符上限不等于 Token 保证，请求前仍执行模型硬预算检查。

`core-session-summary` 为主会话及子 Agent 会话维护可追溯的 Checkpoint + Delta 结构化摘要，持久化到 `workspace/sessions/<session>/summary/current.json`。模型只输出带 `sourceMessageIds` 的变更意图，代码负责来源校验、ID 生成、Reducer 合并、revision 冲突检测和 Checkpoint 归档。摘要作为明确标记的历史资料追加到本次 System Prompt，不冒充用户或助手消息，也不写入消息历史。程序生成的运行提示仍在页面展示，但新记录通过来源标记作为运行资料发送；真实模型回复的思考字段原样保留，以兼容思考模式的工具续跑。动态资料变化可能影响前缀缓存命中。旧版 `state.json.summary` 会一次性迁移为带 legacy 来源的事实条目。

主会话和 `sub:` 子 Agent 复用同一套摘要实现。关闭摘要后不再自动裁剪历史，超出模型硬预算时明确报错。完整原始消息始终保存在 `messages.jsonl`；需要核对摘要来源或引用被压缩的原文时，模型可调用只读工具 `session_history_recall`，按 messageId、序号范围或关键词从当前会话取回。

| 配置项 | 默认值 | 说明 |
|---|---:|---|
| `sessionSummary.enabled` | `true` | 是否启用结构化会话摘要 |
| `sessionSummary.persistent` | `true` | 是否持久化到 `summary/current.json` |
| `fileReadMaxChars` | `20000` | 单次文件读取正文字符上限 |
| `bashMaxOutputChars` | `10000` | stdout/stderr 各自返回的尾部字符上限 |
| `sessionSummary.maxInputChars` | `40000` | 完整摘要请求的输入字符上限（含提示词、已有摘要和消息元数据），按完整消息分批 |
| `sessionSummary.maxOutputTokens` | `10000` | Delta 提取模型输出上限 |
| `sessionSummary.maxOperations` | `32` | 单个 Delta 最大操作数 |
| `sessionSummary.maxItemChars` | `1000` | 单个摘要条目最大字符数 |
| `sessionSummary.maxSourcesPerOperation` | `8` | 单个操作最多引用的原始消息数 |
| `sessionSummary.checkpointDeltaThreshold` | `20` | 达到该 Delta 数量后固化 Checkpoint |
| `sessionSummary.checkpointMaxChars` | `50000` | 达到该结构化存储大小后触发整理，不是摘要总容量上限 |
| `sessionSummary.recallMaxResults` | `20` | 单次原文召回最大消息数 |
| `sessionSummary.recallMaxOutputChars` | `20000` | 单次原文召回最大输出字符数 |
| `sessionSummary.recallMaxQueryChars` | `500` | 原文召回关键词最大字符数 |

摘要更新通过 SSE 上报 `session_summary` 的 started/completed/failed 状态，WebUI 会明确显示整理进度及结果；状态不写入聊天历史。

### 自动记忆配置

跨会话记忆分为两类：`workspace/profile/*.md` 保存稳定用户身份、称呼、语言和长期交互约束，由 `core-profile-memory` 每轮固定注入全文；`workspace/memory/*.md` 保存项目事实、历史决策和经验，由 `core-vector-memory` 按当前问题相关性召回。Profile 不进入向量数据库，也不会因长时间未使用而自动遗忘。

`core-auto-memory` 可以在多轮对话后同时整理 Profile 和向量长期记忆。每轮最终问答会连同记忆作用域按 session 持久化到 `state.json`；达到阈值或执行 `/dream` 时聚合全部主会话的待整理增量，再按 `global` 或 `project:<项目根目录>` 分批分析，避免不同项目相互污染。Markdown 文件仍是可读、可备份的事实源，LanceDB 索引保存在 `workspace/memory/vector/`，只负责向量长期记忆的语义候选召回和 metadata 过滤。

每次用户提问时，`core-vector-memory` 会自动执行向量与关键词混合检索，只把少量高相关记忆注入当前轮 Prompt；不再把全部记忆全文发送给模型。自动召回不足时，Agent 可以调用 `memory_search` 深度搜索，再用 `memory_read` 读取指定记忆。Embedding 不可用或索引损坏时会退化为关键词检索，不阻断正常聊天。

普通会话只访问 `global` 记忆；项目会话访问 `global` 和当前 `project:<项目根目录>`。项目会话调用 `memory_save` 时默认写入当前项目，也可以显式指定 `global` 保存跨项目规则，但不能访问其他项目的 scope。后台自动整理不能把项目记忆提升为全局，也不能覆盖或删除其他 scope 的记忆。

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

自动记忆整理会按 scope 把“Profile 摘要索引 + 当前可见的长期记忆摘要索引 + workspace 内新增最终问答 + 配置限制”交给整理模型，不包含工具过程、工具结果或调试日志。稳定用户偏好使用 `profile_*` 工具维护；项目事实和历史经验使用 `memory_*` 工具维护。达到阈值后的整理在后台运行；`/dream` 同步等待结果。每个 scope 成功后只推进对应快照的增量游标，失败则保留该 scope 的待重试内容。

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

文件工具支持读取和修改 workspace 之外的文件：相对路径以 workspace 为基准，也可以传入绝对路径。危险操作默认自动执行；审批模式可以直接在聊天输入框下方切换，工具级模式可在设置页配置：

```json
{
  "security": {
    "mode": "auto",
    "tools": {
      "bash": { "mode": "ask" },
      "file_write": { "mode": "ask" },
      "memory_delete": { "mode": "ask" }
    },
    "auditTools": true
  }
}
```

权限决策顺序为：`security.tools.<tool>.mode` > `security.mode` > `auto`。用户可选 `ask`、`auto`、`allow`；`auto` 默认执行普通操作和当前工作目录内的全部文件操作，只对目录外写入、提权、系统状态修改和远程脚本执行等明确高风险行为请求审批；格式化磁盘、删除根目录等灾难性命令由内置安全策略直接拒绝。`bash` 工具和技能文件中的动态 shell 注入都使用 `bash` 的工具级权限。Web UI 可以“批准本次”或“允许本轮”，飞书中可以回复完整 `/approve <审批 ID>` 或 `/approve-all <审批 ID>`，批准后都会尝试继续原会话。工具调用和自动权限决策默认写入审计日志，可通过 `auditTools: false` 关闭工具审计。

| 配置项 | 默认值 | 示例 | 说明 |
|---|---:|---|---|
| `security.mode` | `"auto"` | `"ask"` | 全局危险操作权限模式：`ask`、`auto`、`allow`；在聊天输入框下方切换 |
| `security.approvalTtlMs` | `86400000` | `86400000` | 待审批工具调用有效期，默认 24 小时；已有审批不自动延期 |
| `security.tools.<tool>.mode` | 继承全局 | `"ask"` | 单个工具权限模式，覆盖 `security.mode` |
| `security.gateway.host` | `"127.0.0.1"` | `"0.0.0.0"` | Gateway 监听地址；暴露到非回环地址时必须配置 token |
| `security.gateway.token` | 无 | `"YOUR_GATEWAY_TOKEN"` | Gateway Bearer token |
| `security.gateway.sseHeartbeatIntervalMs` | `15000` | `15000` | 流式响应空闲时发送 SSE 心跳的间隔，避免长时间推理导致连接超时 |
| `security.auditTools` | `true` | `true` | 是否记录工具调用审计日志 |

审批卡片显示到期时间。过期后保留审批和任务恢复信息，不执行命令、不自动中断任务；可点击“重新申请审批”，核对后再批准，或点击输入框中的“停止”取消任务。飞书和 CLI 可使用 `/renew-approval <审批 ID>` 重新申请。重新申请不代表授权，实际执行仍经过权限检查；“允许本轮”在轮次结束时清理，不跨轮次生效。旧版本已经删除的过期审批无法恢复。

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
