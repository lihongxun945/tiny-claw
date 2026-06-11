# AGENTS.md

This file provides guidance to AI, when working with code in this repository.

## 项目概述

tiny-claw 是一个个人项目，目标是构建一个类似 open-claw 的自主 Agent，能够自主规划、执行任务。

## 编程语言

主要使用 TypeScript。项目涉及大量消息格式、工具 schema、API 响应等结构化数据，必须充分利用类型系统。

## 工作规范

进行代码变更前，必须遵守：
- 进行任何代码变更前，你必须要先设计方案，只有我同意你的方案后，才开始进行编码
- 在你设计方案前，必须阅读 docs/architecture.md 文件，理解当前项目的架构，按照规范进行方案设计。
- 当前项目是插件化架构，你的设计必须充分解耦，大部分功能应该都是通过插件注册，可插拔的，而不是硬编码到主流程的

在代码变更时，必须遵守：
- 改动任何代码，都需要判断是否要更新测试用例，如果需要的话一定要更新
- 不要硬编码阈值，需要设置阈值的地方，你都要增加一个配置项，并在代码中设置一个合理的默认值

在代码变更后，必须遵守：
- 必须执行相关的自动测试
- 代码变更后必须检查 `docs/architecture.md` 是否需要同步更新（模块结构、数据流、设计决策等）
- 代码变更后必须检查 `README.md` 是否需要同步更新，比如增加了新的工具、命令、配置等，或者已有的文档需要更新
- 代码变更后必须检查 `config.example.json` 是否需要更新，如果有新增的配置项则必须增加示例
- 除非明确要求，不要自己提交或者推送git
- 只要改动了webui代码，就要执行一下build，以免改动不生效

## 沟通规范

任何时候，你发送消息都必须以“陛下”开头

## Behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

1. Think Before Coding
Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

State your assumptions explicitly. If uncertain, ask.
If multiple interpretations exist, present them - don't pick silently.
If a simpler approach exists, say so. Push back when warranted.
If something is unclear, stop. Name what's confusing. Ask.
2. Simplicity First
Minimum code that solves the problem. Nothing speculative.

No features beyond what was asked.
No abstractions for single-use code.
No "flexibility" or "configurability" that wasn't requested.
No error handling for impossible scenarios.
If you write 200 lines and it could be 50, rewrite it.
Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

3. Surgical Changes
Touch only what you must. Clean up only your own mess.

When editing existing code:

Don't "improve" adjacent code, comments, or formatting.
Don't refactor things that aren't broken.
Match existing style, even if you'd do it differently.
If you notice unrelated dead code, mention it - don't delete it.
When your changes create orphans:

Remove imports/variables/functions that YOUR changes made unused.
Don't remove pre-existing dead code unless asked.
The test: Every changed line should trace directly to the user's request.

4. Goal-Driven Execution
Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

"Add validation" → "Write tests for invalid inputs, then make them pass"
"Fix the bug" → "Write a test that reproduces it, then make it pass"
"Refactor X" → "Ensure tests pass before and after"
For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.