# Third-party notices

## Current OmO workbench (2026-10-27)

The current conversation workbench uses [OmO / oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) as its sole execution harness, through the locally prepared OmO 5.1.40 native RPC runtime. iRIXI's bridge, conversation store, tools, and macOS wrapper are included under `omo-pilot/`. OmO runtime packages and the existing authenticated Desktop Codex CLI are not redistributed by this source update. Obtain each runtime from its original distributor and retain its applicable license. The historical OpenOffice adaptations below remain attributed and are not the current workbench execution route.


## Historical native runtime integration candidate (2026-10-11)

**Status:** historical implementation record, not the current formal application entry. The current macOS product entry is `iRIXI Personal Agent.app` (`local.irixi.personal-agent.p0`) with the OmO runtime. The repository still contains this older OpenOffice integration; its orderly retirement is not yet complete.

At the time of this candidate, the reviewed local OpenOffice revision was `5b0246c396aed041c5262ab0132623bf2b8b067b` and the agent-office revision was `b00de4e8615c02605be7b90694dccda55d5d8168`. These fixed revisions identify reviewed historical source, not current upstream releases. Historical OpenOffice call sites included Gateway, Orchestrator, AgentManager, AgentSession, DelegationRouter, managed worktrees and PreviewServer. The Irixi authority adaptations added goal/input/scope guards, model-call reservations, bounded context admission, candidate checks and exact-version review/confirmation/export around that candidate chain. This does not claim those call sites are the current formal route.

The historical 3847 scene reused the agent-office scene/grid adaptation and existing art. Its product adapter projected office state; this does not make the older server the current app entry. Sources and retained licenses: <https://github.com/longyangxi/OpenOffice> (MIT text in `third_party/OpenOffice-MIT.txt`) and <https://github.com/harishkotra/agent-office> (MIT text in `third_party/agent-office-MIT.txt`).

The candidate reused an existing external local source workspace and installed dependencies; it did not vendor a newly downloaded runtime. Other adaptation-specific exclusions below describe their historical implementations. Development zero-model checks and toy evidence remain distinct from later formal project acceptance.
## OpenOffice orchestration adaptation

- Upstream: <https://github.com/longyangxi/OpenOffice>
- Fixed revision: `5b0246c396aed041c5262ab0132623bf2b8b067b`
- Reviewed files: `packages/orchestrator/src/phase-machine.ts`, `packages/orchestrator/src/retry.ts`, `packages/orchestrator/src/delegation.ts`, and `packages/orchestrator/src/types.ts`
- Local adaptation: `app/execution.mjs`
- Adapted behavior and actual call sites:
  - phase-transition ideas from `phase-machine.ts` → `transitionExecution()` for normal run/review/cancel transitions. Goal replacement and bounded replan/review continuation still contain explicit local phase resets; therefore this is not an upstream phase machine used on every route.
  - retry behavior from `retry.ts` → `recordAttempt()` / `mayRetry()` for the legacy sequential provider path, plus `recordWorkAttempt()` / `retryDisposition()` / `mayRetryWork()` for dynamic work-item and review retries. This is a code-behavior adaptation into Irixi's persisted task state, not merely a conceptual reference: it preserves attempt counting, the retry ceiling, and the first-80-character, case-normalized same-error comparison. A repeated identical failure at the ceiling stops instead of spending a replan, while a different non-permanent failure may still enter the existing bounded replan path.
  - delegation/result-record shapes from `delegation.ts` and `types.ts` → local `beginWorkItem()` / `completeWorkItem()` records and `execution.resultBatch` inside one task snapshot.
- Modified for Irixi: roles are local office work items inside one task snapshot. No upstream AgentManager, worker session, Git branch or worktree is started.
- Excluded: the upstream in-memory retry tracker/Map, retry and escalation prompts, AgentManager, AgentSession, worktrees, preview services, package runtime and upstream assets
- License: MIT; full text retained in `third_party/OpenOffice-MIT.txt`
- Review date: 2026-09-21

The upstream hard-ceiling behavior that force-completes work was deliberately not adopted. Irixi records an exhausted budget as partial or failed.

## agent-office scene and grid adaptation

- Upstream: <https://github.com/harishkotra/agent-office>
- Fixed revision: `b00de4e8615c02605be7b90694dccda55d5d8168`
- Adapted files: `packages/ui/src/game/Game.ts` and `packages/core/src/office/Grid.ts`
- Local call sites: `app/public/office-game.js` (`OfficeScene`, `OfficeGrid`)
- Preserved behavior: a Phaser scene owns characters and input focus; EasyStar receives a shared collision grid and computes paths; character depth follows its feet.
- Modified for Irixi: the local player genuinely walks on the grid, colleague clicks open the office conversation immediately while pathfinding continues, and task work-item states drive colleague labels. Upstream camera-follow-only movement was not represented as player walking.
- Excluded: upstream server, database, WebSocket protocol, generated assets, and camera controls.
- License: MIT; full text retained in `third_party/agent-office-MIT.txt`
- Review date: 2026-09-25

## agent-office public web search adaptation

- Upstream: <https://github.com/harishkotra/agent-office>
- Fixed revision: `b00de4e8615c02605be7b90694dccda55d5d8168`
- Reviewed file: `packages/server/src/tools/ToolExecutor.ts`, specifically `webSearch` and `webSearchDuckDuckGo`
- Local adaptation: `app/web-tools.mjs`; actual tool execution enters through `web.search` and `web.read` in `app/tools.mjs`. `app/orchestration.mjs` only validates plan/tool declarations, while `app/server.mjs` supplies execution context, cancellation and hosted-search budget accounting.
- Preserved behavior: a no-key DuckDuckGo Instant Answer fallback reads `Abstract`, `AbstractText` and `RelatedTopics`, and returns an explicit no-result state when applicable.
- Modified for Irixi: search results are discovery-only; the target page must be separately read before citation. URL/DNS checks reject local, private, reserved and mixed public/private destinations on every redirect; body type, size, time and abort are bounded; read pages are archived as task evidence with hash and line locators.
- Excluded: upstream arbitrary code execution, broad file access and Tavily paid search. Ordinary DuckDuckGo HTML search can return a challenge in the current environment and is not represented as universally available.
- License: MIT; full text retained in `third_party/agent-office-MIT.txt`
- Review date: 2026-09-30

## Runtime libraries

- Phaser `3.80.1`, MIT, used for the local pixel office scene. License: `third_party/Phaser-MIT.txt`.
- EasyStar.js `0.4.4`, MIT, used for collision-aware local pathfinding. License: `third_party/EasyStar-MIT.txt`.

## Noto Sans SC document font

- Upstream: <https://github.com/google/fonts/tree/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc>
- Fixed source: <https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf>
- Upstream file name: `NotoSansSC[wght].ttf`; local packaged name: `third_party/fonts/NotoSansSC-Regular.ttf`
- SHA-256: `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da`
- Local use: embedded in generated DOCX candidates and exposed through an isolated Fontconfig file while rendering previews. It is not installed globally.
- License: SIL Open Font License 1.1; official text retained in `third_party/fonts/OFL.txt` (SHA-256 `1c05c68c34f9708415aada51f17e1b0092d2cea709bf4a94cd38114f9e73d7d9`).
# Chromium Headless Shell (workbench functional checks)

The local workbench uses Chrome Headless Shell 156.0.8078.4, Playwright browser revision 1248, installed through `playwright@1.64.1` from the official Playwright CDN. It is a separate browser for isolated functional checks and never uses the user's Chrome profile. Installer: `scripts/install-browser-checker.mjs`. Vendor license: `third_party/chromium-headless-shell/LICENSE.headless_shell`. Runtime is in `.irixi-runtime/browser/chromium-headless-shell-1248`.
