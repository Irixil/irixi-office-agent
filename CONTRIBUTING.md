# Contributing to iRIXI

Small, reproducible contributions are welcome for the conversation workbench and its source setup.

- Try the [workbench setup](docs/getting-started.md) and report fresh-checkout installation problems.
- Reproduce continuity bugs involving changed requirements, references, branches, model selection, actual outcomes, or recovery.
- Improve documentation, Chinese/English wording, keyboard interaction, or accessibility.
- Propose a concrete personal-project use case with an observable result.

Use the [bug report](https://github.com/Irixil/irixi-office-agent/issues/new?template=bug_report.yml) or [use-case template](https://github.com/Irixil/irixi-office-agent/issues/new?template=feature_request.yml). Include the version and expected behavior. Remove credentials, local usernames, task databases, and personal material from attachments.

For code changes, start from `main`, keep the change focused, run `npm ci` and `npm test`, and run checks for the affected native package. Describe the trigger, before/after behavior, verification, and remaining limits in the pull request. Report failures explicitly.

Preserve actual permission boundaries, current goal and file checks, per-turn model identity, write coordination, cancellation, and truthful outcome checks. Use generated fixtures. Real-model runs require a separate explicit budget; normal desktop tests should not spend model calls.

Upstream adaptations retain attribution and licenses. Original iRIXI code and artwork do not yet have a repository-wide license; discuss reuse or substantial contributions before assuming a license grant. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
