# Native integration source snapshot

This directory preserves the current Desktop adapter source and full-file overlays for the modified upstream files. It is source material for review; it is not a complete native runtime checkout.

## Contents

- `product/` contains the native Desktop entry, launcher, product server, bootstrap controller, project registry adapter, and a placeholder registry example.
- `authority/` contains `server.mjs` and every local production module it statically imports, plus the article-learning controller dependencies used by the product path.
- `overlays/OpenOffice/` contains the current modified Gateway, Orchestrator, shared, web, schema, and package files based on OpenOffice `5b0246c396aed041c5262ab0132623bf2b8b067b`.
- `overlays/agent-office/` contains the current modified server, room, UI, and Vite configuration files based on agent-office `b00de4e8615c02605be7b90694dccda55d5d8168`.

The overlays are complete file replacements, not unified patches. Restore the matching upstream repositories at the pinned revisions, then copy each overlay file to the same relative path in its upstream checkout. Install dependencies and build those repositories using their documented toolchains: OpenOffice uses pnpm; agent-office uses its npm workspace lockfile. The product launcher expects the checkouts at `sources/OpenOffice` and `sources/agent-office` beside `integrations/`.

Create the ignored local catalog `product/registered-projects.local.json` from `product/registry.example.json`. Replace the example project ID, label, canonical Git root, baseline/writable paths, registered checks, and native model policy with values chosen for your own registered workspace. The example is a project-catalog template, not a task policy or a pre-authorized scope; the Authority flow supplies task, goal, and scope bindings at runtime. Do not copy a catalog from another machine or task. Keep task state under the configured local tasks root.

## Deliberate exclusions and substitutions

No `node_modules`, build output, local registry, task/runtime state, call logs, model output, or development evidence is included. Authority's historical UUIDs, hashes, project identifiers, dates, batch labels, and local paths were replaced only in the public source copy with consistent neutral placeholders. Repeated-value equality and the original guards remain; old private historical continuation records are not included and cannot be resumed from this snapshot.

In the OpenOffice and Authority public copies, private project slugs were replaced with neutral sample identifiers, and user-specific paths were changed to generic placeholders. These are sanitization substitutions in the public copy; configure a matching project ID if restoring the overlay. The original workspaces were not modified.

This snapshot does not claim a clean-clone native run, real-model acceptance, or full product completion. Restore upstream checkouts, apply the overlays, build, configure the local registry, and then run the relevant native acceptance flow before making those claims. The legacy app and local scene assets are separate from that integration.
