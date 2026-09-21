# Plan: Irixi 1.0 本地可用版本

> Status: Accepted
> Source of truth: This file
> Based on: Accepted [intent.md](intent.md) and [spec.md](spec.md)
> Decision record: 用户于 2026-09-21 将技术与范围取舍委托给当前实现，并要求持续推进到可用版本

## Technical fit

- Baseline: 当前目录只有产品文档和原创美术，无应用代码、依赖清单或 Git 历史；Node.js 24、现代浏览器、Codex CLI 与 macOS 文档工具可用。
- Path: end-to-end vertical slice，随后逐步补全材料、成果类型、连接中心和视觉状态。
- Stack: Node.js 标准库单进程 + 原生 HTML/CSS/JavaScript；无构建步骤、无第三方运行依赖。
- Persistence: 每个任务一个可读目录，JSON 快照 + JSONL 事件 + materials/artifacts/reviews/approvals 子目录；临时文件写完后原子替换。
- Transport: 本机 `127.0.0.1` HTTP JSON API + SSE 状态更新。
- UI: 办公室总览、任务书桌、成果审阅和连接中心；桌面优先、窄屏可用。
- Explicitly deferred infrastructure: Electron、云数据库、账号系统、公共服务器、多租户和后台队列。

## Existing-parts review

- OpenOffice 与 agent-office 只作为负责人编排、角色状态、任务板、办公室投影和适配器边界的产品参考。
- 不复制两仓库代码、执行器、房间运行时或素材，因此本轮无第三方运行代码和许可链。
- 使用项目内原创 Irixi 概念图与角色素材；来源记录保留在 `art/concepts/prompts.md` 和 `art/production-guides/cast-lock.md`。
- 平台标准库足以覆盖 HTTP、文件、事件、子进程、测试和浏览器 UI；没有引入包管理供应链。

## Contracts

- Data: `data/tasks/<id>/task.json` 是任务快照，其他文件只承载材料、产物、审阅、确认和事件。
- State: 所有变化通过一个领域服务校验并持久化；UI 不直接制造完成状态。
- API: task create/list/read/update；material import；plan/run；suggestion route；artifact edit/review/confirm/export；provider/connectors/status；SSE events。
- Model: `demo` 与 `codex-cli` 提供者共用结构化结果；Codex 使用 `exec --ephemeral --sandbox read-only --output-schema`，以参数数组调用，不经过 shell。
- File boundary: 上传内容复制进任务目录；路径清理、大小上限、扩展名允许清单、URL 协议与响应大小限制。
- Formal action: 浏览器下载或新文件导出；路径存在即拒绝，不执行覆盖、发送或删除。
- Logging: 保存动作与结果摘要，不保存隐藏推理、密钥或完整模型流。

## First thin slice

- Goal and Must: DZ-GOAL，R1、R2、R4、R7、R8、R10、R11。
- Loop: 创建任务 → 保存目标 → 计划 → 演示候选 → 独立核对 → 确认 → 下载 → 刷新恢复。
- Files: server/domain/providers/static/tests/data scaffolding.
- Checks: Node test、API smoke、刷新恢复、权限拒绝、真实浏览器桌面与窄屏。
- Rollback: 所有应用文件位于 `app/`，运行数据位于 `data/`；不修改原始材料和外部系统。

## Staged delivery

| Stage | User-visible result | Must | Verification |
|---|---|---|---|
| 1. Truth engine | 目标、建议、状态、版本、确认与恢复可工作 | R1 R2 R7 R9 R10 | domain/API tests |
| 2. Workbench | 办公室总览和任务书桌可真实操作 | R1 R4 R11 | browser desktop/mobile |
| 3. Agent | Codex 与演示提供者、计划、起草、独立审阅 | R4 R5 R8 | structured provider tests + real sample |
| 4. Materials | 文本、MD/TXT、DOCX、PDF、URL 输入 | R3 | parser/network boundary tests |
| 5. Outcomes | 文档、研究、EML、ICS、HTML/PDF路径 | R6 R7 R9 | output fixtures and confirmation tests |
| 6. Connections | 模型/网页/文件/邮件/日历状态与数据边界 | R12 | capability matrix tests |
| 7. Release evidence | 恢复、安全、浏览器和完整目标覆盖 | R13 | full test + review + verification.md |

## Alternatives not chosen

- React/Vite/Electron — 首版没有复杂组件生态需求，会增加安装、构建和更新面。
- 复制参考仓库 — 带来不需要的运行时、安全与素材来源风险。
- 模型控制状态与文件 — 会破坏可恢复性和权限边界；模型只给结构化建议与候选。
- 完全静态演示 — 不能满足可用、可恢复和真实 Agent 路径。

## Authorization points

- 本地可逆代码、测试和项目内数据不需要新的动作授权。
- 真实模型试验只使用隔离的虚构材料，并消耗当前 Codex 账户用量；不读取项目外材料。
- 外部账号连接、付费 API、公开部署、发送、发布、创建日程、覆盖和删除需要届时针对准确目标的授权。

## Handoff completeness

- An engineer with no chat history can implement and verify this plan: yes.
- Remaining ambiguity: 外部账号优先级由用户试用本地版本后决定，不阻止当前建设。
