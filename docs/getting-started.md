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

## Current OmO-backed integration

The current code path is `app/public/` → `omo-pilot/server.mjs` → OmO 5.1.40 native RPC → the constrained provider bridge → an existing Desktop Codex CLI. OmO owns the native tool loop; the bridge does not replace it with a separate executor. The older OpenOffice integration is retained as source and for the legacy/demo route.

Install Node.js 24+ dependencies with `npm ci`, then run `npm start` to open the local server at [127.0.0.1:3848](http://127.0.0.1:3848). Starting the server does not make a model call. A real project run also requires a compatible local OmO 5.1.40 installation, its runtime modules, an existing Desktop Codex CLI, and a trusted local project catalogue that binds paths, allowed files, fixed checks, roles, and limits. The public snapshot does not include these installations, credentials, project registrations, or approvals. `IRIXI_CODEX_PATH` may select an existing Desktop Codex CLI where supported; the bridge does not silently fall back to a global Codex executable.

OmO's source and license are maintained by its upstream project; this repository includes only the iRIXI integration and provider bridge, not the OmO distribution. Review the upstream terms before installing or distributing it.

The historical OpenOffice native setup is retained for compatibility and separate development checks:

```bash
npm run start:zero
```

This older zero-model entry may require the original upstream workspaces and is not the current OmO path. The public preview has not verified a clean-machine OmO installation or end-to-end execution.

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
