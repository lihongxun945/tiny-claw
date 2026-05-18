# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

tiny-claw 是一个个人项目，目标是构建一个类似 open-claw 的自主 Agent，能够自主规划、执行任务。项目目前处于早期开发阶段。

## 编程语言

主要使用 TypeScript。项目涉及大量消息格式、工具 schema、API 响应等结构化数据，必须充分利用类型系统。

## 架构

Agent 围绕以下核心能力构建，按依赖顺序实现：

### 基础能力（主链路）
1. **Loop** — 规划-执行-观察循环，支持终止条件、异常处理、超时控制
2. **Model IO + Prompt** — 合并实现，prompt 构造的输出就是 Model IO 的输入；必须支持流式输出
3. **工具调用** — 声明式 JSON Schema 注册工具，安全沙箱执行
4. **History** — 历史消息管理
5. **上下文压缩** — 主链路跑通后立即实现，防止长任务上下文溢出
6. **配置管理** — 模型选择、API key、工具权限等统一管理

### 高级能力
Memory（分层记忆）、Skill（技能系统）、聊天工具（飞书/钉钉）、RAG

## 开发顺序

Loop → Model IO + Prompt → 工具调用 → History → 上下文压缩 → 配置管理 → 高级能力。每个能力可用后再做下一个。
