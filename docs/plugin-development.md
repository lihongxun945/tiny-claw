# 插件开发指南

tiny-claw 采用插件化架构，所有业务逻辑（工具注册、提示词构建、上下文压缩、日志记录）均由插件实现。框架通过 `PluginManager` 统一调度插件生命周期和钩子。

## 插件类型

| 类型 | 位置 | 说明 |
|------|------|------|
| **核心插件** | `src/plugins/core/` | 始终启用，实现基础功能 |
| **内置插件** | `src/plugins/<name>/` | 通过 `enabledPlugins` 配置启用 |
| **用户插件** | `workspace/plugins/<name>/` | 自动扫描加载，放入即可用 |
| **外部插件** | npm 包或文件路径 | 通过 `externalPlugins` 配置加载 |

用户自定义的插件建议放在 `workspace/plugins/`，无需修改 `enabledPlugins` 配置，启动时自动扫描加载。

## Plugin 接口

```typescript
interface Plugin {
  name: string;
  init(ctx: PluginContext): Promise<void>;
  destroy?(): Promise<void>;
}
```

- `init` — 插件初始化，注册工具、钩子、路由等
- `destroy` — 可选，插件卸载时的清理逻辑

## PluginContext API

`init(ctx)` 中的 `ctx` 提供以下能力：

| API | 说明 |
|-----|------|
| `config` | 插件专属配置（来自 `plugins.<name>`） |
| `workspacePath` | 工作目录路径 |
| `registerTool(tool)` | 注册工具到全局 ToolRegistry |
| `registerChatCommand(command)` | 注册用户显式触发的斜杠聊天命令 |
| `executeChatCommand(input, options)` | 执行已注册聊天命令，供平台插件复用 |
| `registerHooks(hooks)` | 注册生命周期钩子 |
| `registerRoute(route)` | 注册 HTTP 路由（Gateway 模式） |
| `extendPrompt(section)` | 注册提示词片段（追加到系统提示词） |
| `getOrCreateSession(id, prefix?)` | 获取/创建 AgentSession（Gateway 模式） |
| `deleteSession(id)` | 删除会话 |
| `log(level, message, sessionId?)` | 插件日志 |

## 生命周期钩子

插件可以通过 `registerHooks` 注册钩子，在 Agent Loop 的关键节点介入：

| 钩子 | 触发时机 | 用途 |
|------|----------|------|
| `onBeforeChat` | 用户输入进入 Loop 前 | 日志记录、输入修改、阻断 |
| `onBuildPrompt` | 构建系统提示词时 | 追加或修改提示词 |
| `onUserMessage` | 用户消息写入会话历史时 | 历史管理、当前轮状态初始化 |
| `onBeforeModelCall` | 调用模型前 | 上下文压缩、消息修改 |
| `onChatResponse` | 模型响应后、写入 assistant 历史前 | 响应后处理、会话摘要、自动记忆 |
| `onBeforeTool` | 工具执行前 | 权限校验、阻断 |
| `onAfterTool` | 工具执行后 | 结果处理、日志 |
| `onAfterIteration` | 每轮迭代结束 | 进度追踪 |
| `onTurnEnd` | 当前用户轮次完成、等待审批或达到迭代上限 | 按结束原因执行状态持久化与清理 |
| `onError` | 异常发生时 | 错误处理 |

`onBeforeModelCall` 接收结构化 `ModelCallContext`。插件执行耗时预处理时，可以调用 `modelContext.reportStatus?.(...)` 上报临时状态；状态会通过 Agent 事件流发送给客户端，但不会写入消息历史或进入后续模型上下文：

```typescript
modelContext.reportStatus?.({
  stage: "custom_prepare",
  state: "started",
  message: "正在准备上下文…",
});
```

## 快速开始：创建一个简单插件

### 1. 创建插件目录和文件

在 `workspace/plugins/greeter/index.ts` 中编写：

```typescript
import type { Plugin, PluginContext } from "../../../src/plugins/types.js";

interface GreeterConfig {
  greeting?: string;
}

export default {
  name: "greeter",
  async init(ctx: PluginContext) {
    const cfg = ctx.config as GreeterConfig;
    const greeting = cfg.greeting || "你好";

    // 注入系统提示词
    ctx.extendPrompt({
      title: "Greeter",
      content: `你是一个友好的助手，用"${greeting}"打招呼。`,
      priority: 10,
    });

    // 注册生命周期钩子
    ctx.registerHooks({
      onBeforeChat: (_ctx, input) => {
        ctx.log("INFO", `用户说: ${input}`);
      },
      onAfterTool: (_ctx, name, result) => {
        ctx.log("INFO", `工具 ${name} 执行完成`);
        return result;
      },
    });
  },
} satisfies Plugin;
```

### 2. 添加配置（可选）

在 `workspace/config.json` 中：

```json
{
  "plugins": {
    "greeter": {
      "greeting": "嗨~"
    }
  }
}
```

### 3. 启动

启动 Gateway，插件会被自动加载：

```bash
npm run gateway
```

控制台会显示 `插件已加载: greeter (workspace/plugins/)`。

## 注册工具

插件可以注册自己的工具，工具需要实现 `Tool` 接口：

```typescript
// workspace/plugins/greeter/tools/greeting.ts
import type { Tool } from "../../../../src/types.js";

export const createGreetingTool = (): Tool => ({
  name: "greeting",
  description: "发送问候",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "对方名字" },
    },
    required: ["name"],
  },
  async execute(input: { name: string }) {
    return `你好，${input.name}！`;
  },
});
```

然后在 `init` 中注册：

```typescript
import { createGreetingTool } from "./tools/greeting.js";

export default {
  name: "greeter",
  async init(ctx) {
    ctx.registerTool(createGreetingTool());
  },
} satisfies Plugin;
```

## 注册聊天命令

聊天命令由用户显式输入 `/命令` 触发，不会暴露给模型调用。适合做控制面操作，例如快捷查询、审批、部署入口或插件自定义工作流。

```typescript
import type { Plugin } from "../../../src/plugins/types.js";

export default {
  name: "greeter-command",
  async init(ctx) {
    ctx.registerChatCommand({
      name: "hello",
      description: "发送一句问候",
      usage: "/hello [name]",
      execute: ({ args, channel }) => ({
        text: `你好，${args[0] ?? "world"}！来自 ${channel}`,
      }),
    });
  },
} satisfies Plugin;
```

注册后可以在 Web UI 或飞书中输入：

```text
/hello 小明
```

内置命令也走同一套机制，例如 `/help`、`/new`、`/context`、`/dream`、`/approvals`、`/approve <审批 ID>`、`/reject <审批 ID>`。

## 注册 HTTP 路由

Gateway 模式下可注册自定义 HTTP 端点：

```typescript
ctx.registerRoute({
  method: "GET",
  path: "/api/hello",
  handler: async (req, res, routeCtx) => {
    routeCtx.sendJSON(200, { message: "Hello from plugin!" });
  },
});
```

## 参考：核心插件

核心插件是学习插件开发的最佳参考：

- [core-tools](../src/plugins/core/tools.ts) — 注册基础内置工具，演示 `registerTool` 用法
- [core-project-tools](../src/plugins/core/project-tools.ts) — 注册仅在项目会话中暴露的目录、搜索和 Git 工具
- [core-chat-commands](../src/plugins/core/chat-commands.ts) — 注册内置斜杠命令，演示 `registerChatCommand` 用法
- [core-sub-agent](../src/plugins/core/sub-agent.ts) — 注册 `sub_agent_run`，演示将编排能力封装为独立核心插件
- [core-prompts](../src/plugins/core/prompts.ts) — 系统提示词模板加载，演示 `extendPrompt` 和 `onBuildPrompt` 钩子
- [core-compress](../src/plugins/core/compress.ts) — 上下文压缩，演示 `onBeforeModelCall` 钩子
- [core-auto-memory](../src/plugins/core/auto-memory.ts) — workspace 内累计多轮后批量整理长期记忆，演示 `onChatResponse` 中的阈值触发后台整理
- [core-logger](../src/plugins/core/logger.ts) — 日志和对话历史写入，演示完整的钩子使用

## 参考：飞书插件

[飞书插件](../src/plugins/feishu/) 是一个完整的内置插件示例，展示了如何接入外部平台：

- 使用 `registerRoute` 注册 Webhook 回调
- 使用 `registerTool` 注册平台特定工具
- 使用 `getOrCreateSession` 管理多会话
- 通过 `config` 读取平台凭证
