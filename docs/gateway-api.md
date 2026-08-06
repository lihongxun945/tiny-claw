# Gateway API

Gateway 提供 HTTP 与 SSE 接口，用于 WebUI、桌面客户端和外部系统接入 tiny-claw。

## 启动

```bash
npm run web:build
npm run gateway -- --port 3000
```

Gateway API 默认监听 `127.0.0.1:3000`。

## 鉴权

Gateway 默认仅允许本机访问。如需监听非回环地址，必须配置 Bearer Token：

```json
{
  "security": {
    "gateway": {
      "host": "0.0.0.0",
      "token": "YOUR_GATEWAY_TOKEN"
    }
  }
}
```

外部请求需要携带：

```text
Authorization: Bearer YOUR_GATEWAY_TOKEN
```

WebUI 仍只监听本机回环地址，并由本地代理访问 Gateway。

## 聊天

`POST /chat` 使用 SSE 返回事件。

```json
{
  "message": "分析这个项目",
  "session_id": "optional-session-id",
  "execution_mode": "normal",
  "turn_id": "optional-uuid",
  "attachments": []
}
```

`execution_mode` 支持 `normal` 和 `plan`。`turn_id` 省略时由 Gateway 生成。响应可能包含：

| SSE 事件 | 说明 |
|---|---|
| `text_delta` | 模型文本增量 |
| `tool_call` | 工具调用名称、ID 和输入 |
| `tool_result` | 对应工具调用的结果 |
| `done` | 本轮完成、等待审批或达到迭代上限 |
| `error` | 请求或 Agent 执行错误 |

同一 Session 同时只能运行一个任务。客户端断开 SSE 时 Gateway 会取消该任务，也可以调用取消接口。

## 主要接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/chat` | 发送消息并通过 SSE 接收结果 |
| `GET` | `/sessions` | 列出进程中的活跃会话 |
| `POST` | `/sessions` | 创建普通或项目会话 |
| `DELETE` | `/sessions/:id` | 删除会话及持久化数据 |
| `POST` | `/sessions/:id/cancel` | 取消正在运行的任务 |
| `PUT` | `/sessions/:id/execution-mode` | 保存会话默认执行模式 |
| `GET` | `/history/sessions` | 列出持久化会话 |
| `GET` | `/history/sessions/:id/messages` | 获取格式化历史消息 |
| `GET` | `/plan?session_id=:id` | 获取会话各轮计划 |
| `GET` | `/approvals` | 列出待处理审批 |
| `POST` | `/approvals/:id/approve-and-resume` | 单次批准并恢复任务 |
| `POST` | `/approvals/:id/approve-turn-and-resume` | 允许本轮后续审批并恢复任务 |
| `POST` | `/approvals/:id/reject` | 拒绝审批 |
| `GET` | `/memory` | 列出长期记忆 |
| `GET` | `/memory/:name` | 读取长期记忆 |
| `PUT` | `/memory/:name` | 更新长期记忆 |
| `DELETE` | `/memory/:name` | 删除长期记忆 |
| `GET` | `/config` | 获取脱敏配置 |
| `PUT` | `/config` | 更新配置 |
| `GET` | `/commands` | 获取已注册聊天命令 |

插件可以注册额外 HTTP 路由，具体接口以当前启用插件为准。

## 取消与迭代上限

默认最多执行 100 次 Agent Loop 迭代，可通过 `maxAgentIterations` 调整，显式配置 `0` 表示不限。达到上限时 `done` 事件的 reason 为 `iteration_limit`，最终文本会明确说明任务可能尚未完成。
