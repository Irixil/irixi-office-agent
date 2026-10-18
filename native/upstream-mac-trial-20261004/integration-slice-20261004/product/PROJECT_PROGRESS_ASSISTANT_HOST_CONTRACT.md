# Project Progress Assistant host contract v1

Status: Authority, Gateway, and Desktop same-origin proxy code exists in the local source tree; real Agent business behavior and page acceptance have not been evidenced. This is read-only host input, not an allowed business-file write. The native team owns the product UI.

## Current candidate and frozen page binding

Use the current task from a fresh `GET /api/product-state`; callers cannot select a TaskStore path, task ID, or workspace path. Gateway admits progress requests only when the projection is current, the registered project is `project-progress-assistant`, its binding is current, an execution exists, and the artifact has a confirmation, an independently passing review, and a candidate SHA-256.

Freeze these six values from that fresh page response and submit them unchanged with every request in the session:

```json
{
  "expectedGoalVersionId": "<goalVersionId>",
  "expectedExecutionId": "<execution.id>",
  "expectedRegistrySha256": "<product.registrySha256>",
  "expectedArtifactId": "<artifact.id>",
  "expectedArtifactVersion": 1,
  "expectedCandidateSha256": "<artifact.candidateSha256>"
}
```

The public product-state artifact is a compact projection with `id`, `version`, `candidateSha256`, `review`, and `confirmation`. Before the initial binding is frozen, if `previewLink` is non-null, verify that `preview.status` is `ready` and its task, goal version, execution, registry SHA, artifact ID/version, and candidate SHA exactly match the same response. Also resolve `previewLink` with `new URL(previewLink, location.href)` and require its `origin + pathname` to equal the current page's `location.origin + location.pathname`. Freeze the six values only while actually on that same-candidate preview URL. If an old page receives a new candidate whose preview URL does not match the old page location, do not bind the new candidate to the old page; stop writes and load the matching preview through the normal entry. After refresh, obtain a fresh current preview link rather than reconstructing or reusing the old token. Gateway compares the preview context with its current Authority projection and clears a mismatched preview. The location comparison is a client requirement, not enforced by the progress API.

Important boundary: the progress routes do not read the browser's current URL and do not take `previewLink` or an entry path as request input. The server-enforced progress binding is the current task/execution/registry/confirmed-candidate check above. Preview verification is a same-candidate UI consistency check, not an extra server gate on progress API calls. Any mismatch in the six submitted values is rejected; Gateway never silently substitutes a newer candidate.

## Same-origin API and payloads

Desktop forwards method, URL, and JSON body to the current Gateway and returns its status and JSON. Mutations reject a cross-origin `Origin`. Gateway requires `application/json`, limits JSON bodies to 64 KiB, and returns `Cache-Control: no-store`. Browser routes are `/api/project-progress/...`; Authority's internal routes are `/v1/project-progress/...`. The app must not call Authority directly.

All POST/PUT bodies carry the six frozen binding fields. GET carries them as query parameters; Gateway validates them before reading the session. Authority's internal read call receives only `sessionId`.

### Open and read a session

`POST /api/project-progress/session`, success `201`:

```json
{
  "expectedGoalVersionId": "...", "expectedExecutionId": "...",
  "expectedRegistrySha256": "...", "expectedArtifactId": "...",
  "expectedArtifactVersion": 1, "expectedCandidateSha256": "...",
  "sessionId": "progress-session-1",
  "state": {
    "goal": "Project goal", "materials": [],
    "completed": [], "nextSteps": [], "blockers": [], "decisions": [],
    "summary": ""
  }
}
```

Authority normalizes persisted state to `goal`, `materials`, `completed`, `nextSteps`, `blockers`, `decisions`, and `summary`. `schemaVersion` is not required for state; extra input keys are omitted from the saved result. `goal`, `materials`, and entries in the four lists must be non-empty, unchanged round-trip text with no surrounding whitespace or NUL. `materials` has at most 30 entries, each at most 4,000 bytes. Each of the other four lists has at most 100 entries, each at most 1,000 bytes, and entries must be unique within each list. `goal` is at most 4,000 bytes. `summary` may be empty, must have no surrounding whitespace, and is at most 4,000 bytes. `sessionId` is 8–100 ASCII letters, digits, `_`, or `-`. First open returns `{sessionId,revision:0,state,created:true}`. Reopening the same ID with the same binding is idempotent and returns latest state with `created:false`; it does not overwrite progress. Reusing that ID with another binding conflicts.

```http
GET /api/project-progress/session?sessionId=progress-session-1&expectedGoalVersionId=...&expectedExecutionId=...&expectedRegistrySha256=...&expectedArtifactId=...&expectedArtifactVersion=1&expectedCandidateSha256=...
```

Returns `200` with `{ "session": null, "batch": null, "proposal": null }` when absent, or `{ "session": {"sessionId":"...","revision":0,"state":{...},"binding":{...}}, "batch": null, "proposal": null }`. Refresh projects current TaskStore events; it does not reconstruct missing progress from browser cache.

### Save user state

`PUT /api/project-progress/session/state` carries binding, `sessionId`, `expectedRevision`, and the complete `state`; success `200` returns `{sessionId,revision,state}`. This is optimistic concurrency control: `expectedRevision` must equal the latest revision. Existing `completed` entries cannot be removed or reordered; users may append entries. Save increments revision without changing goal, candidate, or session binding.

### Explicitly open a batch

`POST /api/project-progress/session/batch` carries binding and `sessionId`; success `201` returns `{sessionId,batchId,binding,model,maxCalls:8,reservedCalls:0,openedAt,deadlineAt}`. The registered model must be `gpt-6-luna`. The 20-minute window begins when the batch opens; its maximum of eight reserved calls is separate from the development execution count and deadline. A non-expired batch with remaining budget cannot be reopened. Expired, exhausted, failed, or stale batches are not silently renewed.

### Request one read-only progress proposal

`POST /api/project-progress/inference` carries binding, `sessionId`, `batchId`, `expectedRevision`, and a non-empty `update` (up to 8,000 bytes). After reservation and dispatch, Gateway returns `202`:

```json
{"accepted":true,"sessionId":"...","sourceTaskId":"product-conversation-progress-...","reservationId":"...","batchId":"..."}
```

`202` means accepted/dispatched, not that the model completed or produced a valid proposal. Match the result only by the exact returned `sourceTaskId` to the reservation/AgentSession terminal result for the same session and batch. Never associate by title, most recent conversation, or another model result. A valid proposal is exactly one JSON object with no surrounding text and keys `schemaVersion:1`, string `summary` (empty is allowed; no surrounding whitespace; at most 4,000 bytes), and string arrays `nextSteps`, `blockers`, `decisions`. Invalid JSON/schema, failed calls, and late results are retained as evidence/history; they are not repaired, retried, applied, or allowed to change user state. The normal post-202 poll is `GET /api/project-progress/session` with the same frozen binding; match its `proposal.sourceTaskId` to the exact sourceTaskId from the 202 response. Do not use `GET /api/product-state` as a substitute for the result poll or assume a webhook.

Exact read shape: with no session, `{session:null,batch:null,proposal:null}`. With a session, `session` is `{sessionId,revision,state,binding}`. When a batch exists, `batch` is the batch record `{sessionId,batchId,binding,model,maxCalls,openedAt,deadlineAt}` plus the current `reservedCalls` count; otherwise it is null. `proposal` is the detail of the latest result/failed/historical terminal event, or null, shaped as `{sessionId,batchId,reservationId,sourceTaskId,attemptId,binding,expectedRevision,status,raw,rawSha256,proposal,error,finishedAt,historical?,proposalSha256?}`. `historical` appears only when true; `proposalSha256` appears only for a valid parsed proposal. On failure `raw`, `rawSha256`, and `proposal` are null, `error` is populated, and `proposalSha256` is absent. For a completed but invalid format, raw text/hash are retained, `proposal` is null, and `proposalSha256` is absent. The public JSON does not expose the reserved prompt or full event ledger. Proposal `schemaVersion:1`, `summary`, and its three lists are not persisted session-state fields.

### Explicitly accept a proposal

`POST /api/project-progress/session/accept` carries binding, `sessionId`, exact `sourceTaskId`, current `expectedRevision`, and `expectedProposalSha256`; success `200` returns `{sessionId,revision,state}`. Authority accepts only if current candidate, batch, unexpired result, proposal digest, and revision all match. Acceptance replaces only `nextSteps`, `blockers`, and `decisions`; the user's `goal` and `completed` remain unchanged.

## Errors and stop conditions

Caught errors on these Gateway routes are returned as `409` JSON `{ "error": "<message>" }`; therefore an Authority `404` (for example, unknown session) is surfaced through Gateway as `409`. Missing/wrong JSON Content-Type also follows this Gateway catch path and becomes `409`. Oversized bodies may be rejected earlier by Desktop/Gateway parsing; check the actual outer response status. Do not blindly retry any `409`: reread `/api/product-state` and session, verify the same candidate, and begin another session/batch only with explicit user intent. After a network interruption following `202`, poll existing `GET /api/project-progress/session` and match exact `sourceTaskId` before deciding anything; never blindly resubmit inference.

## Event ledger and exclusions

Append-only records use the current TaskStore's `integration.project_progress.*` namespace: `session_opened`, `state_saved`, `batch_opened`, `inference_reserved`, `native_call_reserved`, `native_call_finished`, `inference_result` / `inference_historical` / `inference_failed`, and `proposal_accepted`. Do not create a second progress database or write article-learning events.

No UI, autonomous background polling, cross-project memory, article-material reuse, arbitrary workspace access, automatic completion decision, automatic proposal acceptance, or candidate/source merge is included. Business files remain for a later native implementation, checks, and review. This contract is read-only and is not in `allowedWritePaths`.
