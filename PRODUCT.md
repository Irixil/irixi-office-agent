# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Node.js 24 standard library with native HTML, CSS, and JavaScript. The product runs locally without a package install or build step.

## Users

The first version serves the project owner alone. The same person provides materials, decides the goal, reviews candidates, and authorizes formal actions.

## Product Purpose

Irixi turns a clear office goal and selected materials into an inspectable, recoverable office outcome. It keeps the final goal visible across long work, coordinates specialist roles on demand, produces candidate versions, checks them independently, and lets the user decide what becomes formal.

Success means the user can complete a real office task with less repeated explanation and correction, while always understanding the active goal, real progress, current artifact, uncertainty, and next decision.

## Positioning

Irixi combines a real goal-and-artifact workbench with a Victorian office that projects actual execution state. The office never invents activity, and a specialist suggestion can never silently replace the user's final goal.

## Operating Context

- The user works from a local browser on macOS.
- Inputs may include pasted text, selected local office files, and explicit read-only URLs.
- Initial outcomes include documents, research briefs, email drafts, and calendar drafts.
- Candidate work stays inside Irixi until the user approves a named version and action.
- External accounts and public deployment are optional extensions, not prerequisites for local use.

## Capabilities and Constraints

- One coordinator owns the goal and calls research, writing, review, and operations roles when needed.
- Suggestions are classified as supporting, replacing, deviating, or unclear; only the user can accept a replacement goal.
- Task, goal, materials, work items, artifact versions, reviews, approvals, events, and recovery state persist locally.
- The model provider is replaceable. Codex CLI is the first real provider; a deterministic demo provider is visibly labelled and exists for repeatable tests.
- Read-only research may proceed inside the task's selected scope. Export, sending, publishing, calendar creation, deletion, payment, and permission changes require exact user confirmation.
- The local usable version must not depend on copying the reference projects' runtimes or assets.

## Brand Commitments

- Product and coordinator name: Irixi.
- Irixi is the unique anthropomorphic Victorian owl gentleman with top hat, monocle, cane, forest-green tailcoat, burgundy bow tie, and parchment waistcoat.
- The workplace is a Victorian miniature office and octagonal archive in walnut, aged brass, forest green, burgundy, parchment, and cool gray.
- Supporting colleagues are distinct small animals; they do not inherit Irixi's owl anatomy or signature accessory combination.
- The interface must remain a serious tool even when the office is delightful.

## Evidence on Hand

- Product intent: `docs/sdlc/intent.md`
- Product requirements and decisions: `docs/product/Irixi-PRD-v0.1.md`
- Goal-first architecture: `docs/architecture/goal-first-agent.md`
- Original character and office concepts: `art/concepts/`
- Locked cast rules: `art/production-guides/cast-lock.md`
- No validated production application, real user task results, or production deployment exists yet.

## Product Principles

1. Final goal before suggestions, tools, and local optimizations.
2. Candidate work before formal action.
3. Real state before theatrical activity.
4. One accountable coordinator with specialists called only when useful.
5. Evidence and recovery before a completion claim.

## Accessibility & Inclusion

Every important status is expressed with text as well as color and animation. Core task creation, review, approval, and cancellation work by keyboard, and reduced-motion preferences are respected.
