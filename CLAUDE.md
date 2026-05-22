# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

tiny-claw 是一个个人项目，目标是构建一个类似 open-claw 的自主 Agent，能够自主规划、执行任务。项目目前处于早期开发阶段。

## 编程语言

主要使用 TypeScript。项目涉及大量消息格式、工具 schema、API 响应等结构化数据，必须充分利用类型系统。

## 架构设计
在设计和实现任何功能之前，你都需要考虑可维护性、可拓展性，需要架构清晰，考虑后续的维护和拓展成本，不要无脑叠加和硬编码。

## 工作规范

- 代码变更后必须检查 `docs/architecture.md` 是否需要同步更新（模块结构、数据流、设计决策等）
- 代码变更后必须做端到端测试：运行 `npm start` 验证主链路可正常运行，确认新功能/修复有效
- 每日开发结束后更新 `docs/devlog/YYYY-MM-DD.md`
- 除非明确要求，不要自己提交或者推送git
- 只要改动了webui代码，就要执行一下build，以免改动不生效

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