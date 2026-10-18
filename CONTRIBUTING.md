# Contributing to iRIXI

Small, reproducible contributions are useful while the native setup is being made portable.

- Try the [demo-provider setup](docs/getting-started.md) and report fresh-checkout installation problems.
- Reproduce continuity bugs involving changed requirements, version binding, review, download, or recovery.
- Improve documentation, Chinese/English wording, keyboard interaction, or accessibility.
- Propose a concrete personal-project use case with an observable result.

Use the [bug report](https://github.com/Irixil/irixi-office-agent/issues/new?template=bug_report.yml) or [use-case template](https://github.com/Irixil/irixi-office-agent/issues/new?template=feature_request.yml). Include the version and expected behavior. Remove credentials, local usernames, task databases, and personal material from attachments.

For code changes, start from `main`, keep the change focused, run `npm ci` and `npm test`, and run checks for the affected native package. Describe the trigger, before/after behavior, verification, and remaining limits in the pull request. Report failures explicitly.

Preserve goal/input/scope binding, model-call budgets, exact-version checks, independent review, and confirmation. Use generated fixtures. Real-model runs require a separate explicit budget; normal desktop tests should not spend model calls.

Upstream adaptations retain attribution and licenses. Original iRIXI code and artwork do not yet have a repository-wide license; discuss reuse or substantial contributions before assuming a license grant. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
