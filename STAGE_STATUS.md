# Workbench progress · 2026-10-27

The current product is a conversation-first desktop personal agent. OmO is the sole harness for current conversations and tool execution. DZ supplies internal goal, planning, change, checking, and continuity rules.

## Delivered locally

The maintainer's October 27 macOS workbench completed engineering, system acceptance, independent checks, and formal installation checks. The current recorded build is `95b4c2fa`, with 22 source-file identities checked against the installation record. Acceptance covered 23 required outcomes. The product owner’s hands-on adoption decision remains separate from engineering acceptance.

The workbench includes:

- Project folders containing multiple conversations, short titles, and persistent organization menus.
- A native folder chooser and saved start requests that continue once a project location is selected.
- Copy, quote, edit, revision branches, chat branches, Git worktree branches, and local deep links.
- Cross-conversation references with their original source and version.
- Per-turn model and reasoning selection through the currently connected Desktop Codex CLI.
- Expandable real activity, host-checked tools, and actual read-only child agents.
- Clear progress and usable outcomes, stop/recovery handling, multiple windows, text-size controls, and existing-data preservation.

## Validation behind this update

The local acceptance exercised eight available models with OmO tools and returned results. Two representative models completed project creation or modification, checking, and actual use of the outputs. Examples included an expense-calculation command tool and changes to an existing focus-recording web app.

The latest branch-material change was checked with 77 local regressions, seven independent fault checks, and relevant native UI paths. Installation and existing-data checks are recorded separately from isolated model and function checks.

This publication checks current source identities, selected controlled tests, source syntax, public-file boundaries, and repository presentation. It does not run a new real-model acceptance batch or replace the installed application. See the [published source identities](docs/status/source-manifest-20261027.json).

## Distribution and next scope

This is a source update. It includes the workbench, launcher and macOS wrapper source, plus the existing attributed historical implementations. OmO, model runtimes, credentials, user data, and the installed app binary are not bundled. Follow [getting started](docs/getting-started.md) to prepare a development environment; a signed clean-machine installer is not provided by this update.

Public web sharing is deferred. Additional model providers, expanded automatic personal memory, complex parallel merging, and richer conflict-management flows remain later work. Current model/CLI configuration is replaceable rather than a permanent product restriction.
