# 本地开发与测试

本文面向 tiny-claw 源码贡献者。普通安装和使用请从项目根目录的 [README](../README.md) 开始。

## 环境要求

- Node.js 20.17 或更高版本
- npm
- macOS 客户端构建仅支持 Apple Silicon Mac

## 安装依赖

```bash
npm install
```

WebUI 使用独立的依赖清单，执行构建或 `npm run web:build` 时会自动安装；也可以手动执行：

```bash
npm --prefix web install
```

## 开发服务

Gateway 与生产 WebUI：

```bash
npm run web:build
npm run gateway -- --port 3000
```

前端开发时可以单独启动 Vite：

```bash
npm run gateway -- --port 3000
npm run web:dev
```

Gateway API 默认监听 `127.0.0.1:3000`，Vite 开发服务默认监听 `127.0.0.1:4173`。

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 运行 Vitest 测试 |
| `npm run test:e2e` | 运行 Playwright WebUI 测试 |
| `npm run test:coverage` | 生成测试覆盖率 |
| `npm run test:local-model` | 使用内置小模型执行本地推理冒烟测试 |
| `npm run test:all` | 执行类型检查、WebUI 构建、覆盖率和 E2E 测试 |
| `npm run build` | 编译主程序并复制运行时资源 |
| `npm run desktop:compile` | 编译 Electron 主进程 |

## 技术栈

- TypeScript：主程序、Gateway、插件与 Electron 主进程
- React + Vite：WebUI
- Vitest：单元与集成测试
- Playwright：浏览器端到端测试
- Electron + electron-builder：macOS 客户端和 DMG
- node-llama-cpp：内置本地模型推理

## 开发约定

新增能力优先通过插件注册工具、Hook、聊天命令或 HTTP 路由，避免把业务逻辑写入 Agent Loop。模块结构、数据流和设计决策参见 [架构说明](architecture.md)，插件接口参见 [插件开发指南](plugin-development.md)。
