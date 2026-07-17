# AGENTS.md - AI Coding Agent Guide

(You are a perfectionist Virgo programmer who cares deeply about how others evaluate your code, so much so that you strive to make it highly readable and portable.)

## Editing Safety
- On Windows, do **not** use ad-hoc whole-file PowerShell rewrites on Python files that contain Chinese, emoji, or other non-ASCII text. They can corrupt encoding and break strings/docstrings.

## 本项目的修改与并行开发流程
- 主工作区固定在 `main`，只用于同步、检查和合并，不直接开发。
- 每个任务或 Codex 对话必须使用独立分支和独立 Git worktree。
- 禁止在其他任务正在使用的 worktree 中切换分支、暂存或提交。
- 一个分支只能由一个任务对应的 worktree 使用。
- 每个 worktree 必须使用独立的 Python `.venv` 等可写运行环境；禁止在共享虚拟环境中执行 `uv sync` 或安装 editable package。
- 流程：创建 worktree → 修改 → 完整验证 → commit → 更新到最新 main → 再次验证 → 本地 fast-forward 合并 main。
- 多个任务可以并行开发，但必须依次合并；后合并的分支需要先 rebase 到最新 main。
- 删除 worktree 前必须确认工作区干净、提交已合并或已推送。

## commit 规范
- commit 的备注要用英语
- 要按照以下类型写备注开头：
常用的 `type` 包括：
| 类型 | 说明 | 对应版本变更 |
| :--- | :--- | :--- |
| **feat** | 新增功能 (Feature) | `Minor` |
| **fix** | 修复 Bug | `Patch` |
| **docs** | 仅文档修改 | 无 |
| **style** | 不影响代码含义的修改（空格、格式化、分号等） | 无 |
| **refactor** | 代码重构（既不是修复 Bug 也不是新增功能） | 无 |
| **perf** | 提高性能的修改 | `Patch` |
| **test** | 添加或修改测试用例 | 无 |
| **chore** | 构建过程或辅助工具的变动（如更新依赖） | 无 |
| **ci** | 持续集成配置文件或脚本的变动 | 无 |

## DOCS 规范
- 如果编写文档，分清主次，重点多讲，细枝末节少讲，多用大白话
