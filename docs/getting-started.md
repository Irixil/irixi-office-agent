# Getting started

This is a desktop-first source preview, primarily developed on macOS. Node.js 24 or later is required. A fresh-machine native installation has not yet been verified.

## Explore the desktop with demo data

```bash
git clone https://github.com/Irixil/irixi-office-agent.git
cd irixi-office-agent
npm ci
npm run start:legacy
```

Open [localhost:3847](http://127.0.0.1:3847). Keep the demo provider selected, create a task, and add synthetic material. Use WASD or the arrow keys to walk; click the floor to move, or click a colleague to open a conversation while approaching them. Esc cancels movement or closes the conversation.

The demo provider does not use a real model. This route exercises the older desktop backend, rather than the native product development chain. Stop the server with Ctrl+C. Existing tasks are stored in `data/tasks/`; use a separate checkout for experiments.

## Native product development setup

```text
app/                                             Desktop and legacy backend
art/office-playable-v1/                           Runtime office artwork
native/upstream-mac-trial-20261004/
  sources/OpenOffice/                            Adapted native agent runtime
  sources/agent-office/                          Adapted office source
  integration-slice-20261004/
    authority/                                   Input, scope, review and delivery guards
    product/                                     Product entry and desktop adapters
```

The native entry requires the desktop dependencies, dependencies and compiled outputs for the bundled upstream workspaces, an existing authenticated Codex executable for real inference, and a local trusted project catalogue. That catalogue binds canonical paths, allowed files, fixed checks, roles, and execution limits. Original runtime scopes and approvals are not included.

Follow each upstream workspace's package scripts and README to prepare dependencies. This publication has not revalidated a complete clean build. `IRIXI_CODEX_PATH` can select an existing executable where supported.

After those prerequisites are prepared:

```bash
npm run start:zero
```

This launches the native product entry with model execution disabled. For explicitly authorized real-model work, the normal entry is `npm start`. Open [the native desktop](http://127.0.0.1:3847/?backend=openoffice). `IRIXI_NATIVE_ROOT` or `--native-root` can select an existing canonical native integration directory; otherwise the public launcher resolves the bundled source tree.

The optional local XERJ index uses an existing installation. The launcher does not download it; when unavailable, the desktop continues with local task and memory storage. Search indexing and full cross-machine memory behavior are separate validation items.

## What is intentionally local

The public source omits personal project catalogues, task databases, original materials, credentials, raw model-call records, runtime approvals, generated candidate worktrees, and private recovery data. `*.local.json` files are ignored by Git.

Historical recovery uses the existing `historical-bindings.example.json` schema with disabled placeholders. Its exact version, hash, budget, and CAS guards remain present. Missing private history never grants new execution permission.

The Noobi adapter retains a fixed-root guard with a disabled public placeholder. Its original external checkout and build outputs are not included; the game route is not a ready-to-run public demo.

## Checks

```bash
npm test
```

Desktop tests use generated fixtures, mocks, and temporary local servers. Real-model smoke scripts are separate and require a new explicit budget. See [the changelog](../CHANGELOG.md) for this preview's publication checks.

For setup failures, [open an installation report](https://github.com/Irixil/irixi-office-agent/issues/new?template=bug_report.yml) with your OS, Node version, entry command, expected result, and sanitized error. Never attach tokens or your task database.
