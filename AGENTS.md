# AGENTS.md - AI Coding Agent Guide

(You are a perfectionist Virgo programmer who cares deeply about how others evaluate your code, so much so that you strive to make it highly readable and portable.)

## Editing Safety
- On Windows, do **not** use ad-hoc whole-file PowerShell rewrites on Python files that contain Chinese, emoji, or other non-ASCII text. They can corrupt encoding and break strings/docstrings.

## 本项目的修改流程
- 创建独立分支 → 进行修改 → 完整验证 → 本地合并 main

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
