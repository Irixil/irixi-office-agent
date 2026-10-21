# iRIXI Personal Agent

### A personal AI agent in a living Victorian office.

Turn a project goal into a plan, an agent team, a reviewed deliverable, and a place to continue next time.

[![Early preview](https://img.shields.io/badge/status-early_preview-b68b4c)](STAGE_STATUS.md)
[![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-43853d)](docs/getting-started.md)
[![Desktop first](https://img.shields.io/badge/desktop-first-254b40)](docs/showcase.md)

**[简体中文](README.zh-CN.md) · [See the office](#see-the-office) · [Get started](docs/getting-started.md) · [What works today](STAGE_STATUS.md) · [Contribute](CONTRIBUTING.md)**

iRIXI is a visual personal AI assistant for people building and maintaining their own projects. An owl coordinates your work in a Victorian miniature office, while animal colleagues make project roles and activity visible. Underneath the scene, OpenOffice supplies native agent collaboration, model sessions, and managed worktrees.

**Early preview.** Built and exercised on selected local projects. [See the current scope →](STAGE_STATUS.md)

## See the office

![iRIXI visual AI office with an owl coordinator and animal colleagues](docs/media/irixi-office.gif)

*An idle/rest recording from the running desktop interface. The map also has a walkable upstairs gallery.*

## Why iRIXI?

Personal projects often span several conversations and several days. iRIXI is being built to keep the goal, changing requirements, work history, review, and final deliverable together.

| What you need | How iRIXI approaches it |
| --- | --- |
| Explain a project in ordinary language | Keep a goal, success conditions, boundaries, materials, and accepted instructions in one task record. |
| Know who is doing what | Show the native team and its current state in an interactive office. |
| Change your mind during development | Save the change and carry current requirements into the next planning and execution step. |
| Inspect work before accepting it | Keep candidate files, checks, independent review, and your confirmation as separate steps. |
| Come back later | Recover the saved project and its history through the ordinary project list. |
| Keep control of execution | Use registered file scopes, bounded model calls and deadlines, and exact-version delivery. |

## From a request to a deliverable

```text
Describe a goal → Plan with the Lead → Approve the plan
       → Develop in managed worktrees → Independent review
       → Confirm the specific version → Download → Continue later
```

Requirements can change along the way. Failed reviews and earlier versions stay in the project history. A new candidate needs its own review and confirmation.

### An existing project, improved in place

The latest local validation used an existing article-learning project. The request began with “download the full learning report,” then added a separate review list containing only weak or untested topics.

- The native team planned, developed, and refined the change through independent review.
- The confirmed version downloads the saved server record and provides both a full report and a separate review list.
- Both Markdown downloads were opened and checked. Switching away, returning to the project, and refreshing preserved the restored session.

This selected workflow was validated locally with human supervision. Generated candidate patches remain separate from the application source. [More examples →](docs/showcase.md)

## Get started

**Requirements:** Node.js 24+, npm, and a desktop browser. Development and interaction testing have primarily used macOS.

### Explore the office with the demo provider

```bash
git clone https://github.com/Irixil/irixi-office-agent.git
cd irixi-office-agent
npm ci
npm run start:legacy
```

Open [localhost:3847](http://127.0.0.1:3847), keep the **demo provider** selected, and create a task with synthetic material. This is the older desktop backend and is useful for exploring the office and task interface. It does not exercise the native multi-agent development chain.

### Work on the native integration

`npm start` launches the native product entry; `npm run start:zero` disables model execution for development checks. Native execution additionally needs the bundled upstream workspaces prepared, an existing Codex runtime, and a locally registered project scope. The public snapshot excludes the original user's runtime configuration and approvals.

**The native preview is currently a developer setup, with fresh-machine execution unverified.** Read the [setup guide](docs/getting-started.md) before starting it.

## Built around one project history

- **Desktop:** JavaScript, Node.js, Phaser, and EasyStar.js.
- **Native agents:** locally adapted [OpenOffice](https://github.com/longyangxi/OpenOffice) for team coordination, sessions, worktrees, and previews.
- **Office interaction:** adapted scene and grid ideas from [agent-office](https://github.com/harishkotra/agent-office), with iRIXI artwork and interaction.
- **Project continuity:** task records and local memory, plus an optional local XERJ index. This does not mean that every conversation is remembered automatically.
- **Review and delivery:** checks bind to the current goal, inputs, scope, and candidate. Code changes are delivered as confirmed patches.

See the [architecture](docs/architecture/goal-first-agent.md) and [third-party notices](THIRD_PARTY_NOTICES.md) for ownership and integration boundaries.

## Current focus

- Make native setup and project registration reproducible on a fresh machine.
- Make project history and cross-version continuation easier to use.
- Expand article-writing and game workflows through real project use.

Detailed status lives in [STAGE_STATUS.md](STAGE_STATUS.md); version changes live in [CHANGELOG.md](CHANGELOG.md).

## Help shape the project

Useful contributions include reproducible installation reports, project-continuity bugs, clearer documentation, and office interaction improvements. Start with the [contribution guide](CONTRIBUTING.md).

**[Report a bug](https://github.com/Irixil/irixi-office-agent/issues/new?template=bug_report.yml) · [Suggest a use case](https://github.com/Irixil/irixi-office-agent/issues/new?template=feature_request.yml) · [Follow previews](https://github.com/Irixil/irixi-office-agent/releases)**

If the direction is useful to you, a star helps others discover iRIXI. Share the repository with someone working on personal AI assistants, multi-agent workflows, or visual agent offices.

