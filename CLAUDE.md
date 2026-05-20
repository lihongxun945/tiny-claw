# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

tiny-claw 是一个个人项目，目标是构建一个类似 open-claw 的自主 Agent，能够自主规划、执行任务。项目目前处于早期开发阶段。

## 编程语言

主要使用 TypeScript。项目涉及大量消息格式、工具 schema、API 响应等结构化数据，必须充分利用类型系统。

## 工作规范

- 代码变更后必须检查 `docs/architecture.md` 是否需要同步更新（模块结构、数据流、设计决策等）
- 代码变更后必须做端到端测试：运行 `npm start` 验证主链路可正常运行，确认新功能/修复有效
- 每日开发结束后更新 `docs/devlog/YYYY-MM-DD.md`
- 除非明确要求，不要自己提交或者推送git
