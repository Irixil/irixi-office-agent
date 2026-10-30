# Conversation-first personal agent architecture

## Current route

```text
macOS shell or browser
  → conversation workbench / local Node.js service
  → project and conversation storage
  → OmO native RPC
  → configured model/CLI bridge and host-enforced tools
  → file changes, functional checks, runnable results
```

`omo-pilot/server.mjs` serves the current workbench. `conversation-store.mjs` records project relationships, messages, turns, references, branches, execution state, and outcomes. The macOS wrapper is in `omo-pilot/macos-app/`; the persistent workbench launcher is `scripts/start-personal-agent-p0.mjs`.

## Execution and continuity

OmO is the sole harness. The replaceable connection uses the configured Codex CLI with either an existing account connection or the official OpenAI API Key file route. Native RPC and the provider bridge preserve tool contracts, model selection, source identities, actual tool receipts, cancellation, and child-task lifecycle.

Bundled DZ rules are mapped to the product's own storage and capabilities. They do not direct the product to modify this development repository's `.dz/` ledger or create a second task store.

Discussion and execution are distinct. A project can have several conversations sharing actual files. Adoption into the same project directory is coordinated. Parallel writers use independent copies and scoped tools; combined results are checked before adoption. Discussion and reads can run concurrently. Continuation checks the saved stop point and current files.

## Messages and branches

References retain their source and version. Chat branches inherit only through the selected completed turn; they do not roll back actual files. Revision branches preserve the original message record. Git worktree branches provide a separate working directory where applicable. Materials have both a visible registration and a bounded read scope.

## Checks and outcomes

Command and browser checks bind a requirement, operation, and result to the delivered version. Reading source or running an unrelated successful command does not establish that a feature works. Product output distinguishes saved files, model responses, checked behavior, and usable outcomes.

## Historical implementations

The office scene remains in `app/public/office-game.js`, with Phaser/EasyStar.js and attributed agent-office adaptations. Older OpenOffice source under `native/` and earlier project workflows remain for history and compatibility. They are not the current conversation workbench harness.

[Current progress](../../STAGE_STATUS.md) · [Setup](../getting-started.md) · [Attribution](../../THIRD_PARTY_NOTICES.md)

## Memory and specialist adapters

`conversation-memory.mjs` distinguishes preferences, project decisions and temporary requirements, retaining source information and edit/disable/delete controls. `conversation-parallel.mjs` and `conversation-development.mjs` support scoped helper work and development checks. `specialist-skills.mjs` and the Noobi adapter resolve separately prepared local integrations; they do not ship another project’s private runtime.

`app/api-key-store.mjs` manages permission-restricted local plaintext Key files. The official Key route has explicit tool capabilities and does not silently reuse an account connection. DeepSeek interface preparation is separate from live-provider validation.
