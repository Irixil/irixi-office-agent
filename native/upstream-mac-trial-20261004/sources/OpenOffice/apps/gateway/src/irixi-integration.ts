import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { GatewayEvent } from "@office/shared";
import {
  assertProductProjection,
  assertProductWorkspace,
  isNoobiBuiltPreviewAsset,
  isAllowedAuthorityUrl,
  loadProductProjectRegistry,
  productProjectionMatches,
  productRegistrySha256,
} from "./product-project-registry.js";

const AUTHORITY_PROJECTION_TIMEOUT_MS = 8_000;
const PRODUCT_NATIVE_CALL_ADMISSION_TIMEOUT_MS = 15_000;

export async function authorizeProductWorktreeRebind(endpoint: string, evidence: unknown) {
  const response = await fetch(new URL("/v1/product-worktree-rebind", endpoint), {
    method: "POST", signal: AbortSignal.timeout(PRODUCT_NATIVE_CALL_ADMISSION_TIMEOUT_MS),
    headers: { "content-type": "application/json" }, body: JSON.stringify(evidence),
  });
  const result = await response.json() as { authorized?: boolean; eventId?: string; error?: string };
  if (!response.ok || result.authorized !== true || typeof result.eventId !== "string" || !result.eventId) {
    throw new Error(typeof result.error === "string" ? result.error : "Irixi rejected managed worktree continuation");
  }
  return { authorized: true as const, eventId: result.eventId };
}

type Projection = {
  schemaVersion: 1;
  taskId: string;
  title: string;
  goalStatement: string;
  status: string;
  goalVersionId: string;
  projectRootGoalVersionId: string | null;
  projectRootInputFingerprint: string | null;
  materialApplicabilityFingerprint: string | null;
  instructionIds: string[];
  taskInputBindingSha256: string;
  pipelineBindingSha256: string;
  authoritySha256: string;
  confirmedContract?: null | { goalVersionId: string; statement: string; successCriteria: string[]; boundaries: string[]; materialSha256: string | null;
    developmentBinding?: null | { batchId: string; executionId: string; repairOfExecutionId: string; priorLedgerSha256: string; repairInputManifestSha256: string; scopeFingerprint: string; reviewOnly?: boolean } };
  current: boolean;
  workspace: null | { current: boolean; scopeFingerprint: string; sourceSnapshotSha256: string };
  execution: null | { id: string; phase: string; stopReason: string | null };
  registeredExecution: null | { goalVersionId: string; displayPrompt: string; prompt: string; promptSha256: string };
  productRegistry?: null | { registrySha256: string; current: boolean };
  artifact: null | { id: string; version: number; candidateSha256: string | null; diffSha256: string | null; patchSha256: string | null;
    hostCheck?: { passed: boolean } | null;
    review?: { id: string; passed: boolean; nativeVerdict: string | null; scopeOutcome: string | null; fullOutputSha256?: string | null } | null;
    confirmation?: { approvalId: string; artifactVersion: number; goalVersionId: string; reviewAdjudication?: { reviewId: string; reviewFullOutputSha256: string; reason: string; decidedBy: string; decidedAt: string; authorizationSourceThreadId: string; authorizationText: string } | null } | null;
  };
};

export type IrixiEventBinding = {
  taskId: string;
  goalVersionId: string;
  taskInputBindingSha256: string;
  pipelineBindingSha256: string;
  executionId: string | null;
  workspaceScopeFingerprint: string | null;
  sourceSnapshotSha256: string | null;
  artifactId: string | null;
  artifactVersion: number | null;
  candidateSha256: string | null;
  diffSha256: string | null;
  authoritySnapshotSha256: string;
  sourceTaskId: string;
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function isValidLeadPlanText(text: unknown): text is string {
  if (typeof text !== "string" || !text.trim() || text.includes("\u0000") || Buffer.byteLength(text) > 40_000) return false;
  const markers = [...text.matchAll(/\[\/?PLAN\]/g)];
  if (markers.length !== 2 || markers[0][0] !== "[PLAN]" || markers[1][0] !== "[/PLAN]") return false;
  const opening = markers[0].index!;
  const closing = markers[1].index!;
  const lineStart = (index: number) => index === 0 || text[index - 1] === "\n";
  const lineEnd = (index: number, length: number) => index + length === text.length || text[index + length] === "\n"
    || (text[index + length] === "\r" && text[index + length + 1] === "\n");
  if (!lineStart(opening) || !lineEnd(opening, 6) || !lineEnd(closing, 7)) return false;
  const body = text.slice(opening + 6, closing).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return Boolean(body.trim());
}
const PRODUCT_LEARNING_AUTHORITY_ROUTES = new Set([
  "GET /v1/intake",
  "GET /v1/learning/client-state",
  "PUT /v1/learning/client-state",
  "POST /v1/materials",
  "POST /v1/learning/open-batch",
  "GET /v1/inference",
  "POST /v1/inference/reservations",
  "POST /v1/inference/native-calls",
  "POST /v1/inference/results",
  "POST /v1/inference/failures",
]);
export type ProductApprovalContext = {
  taskId: string; goalVersionId: string; executionId: string; registrySha256: string;
  planSha256: string; executionPrompt: string; executionPromptSha256: string;
};

export function buildProductApprovedExecutionPrompt(context: ProductApprovalContext, approvedPlan: string): string {
  if (!context.executionPrompt.startsWith("IRIXI_NATIVE_PRODUCT_EXECUTION_V1\n")
    || sha256(context.executionPrompt) !== context.executionPromptSha256
    || sha256(approvedPlan) !== context.planSha256) {
    throw new Error("Product execution prompt or approved plan digest is invalid");
  }
  return [
    context.executionPrompt,
    [
      "IRIXI_APPROVED_PRODUCT_EXECUTION_V1",
      `TASK_ID: ${context.taskId}`,
      `GOAL_VERSION_ID: ${context.goalVersionId}`,
      `EXECUTION_ID: ${context.executionId}`,
      `REGISTRY_SHA256: ${context.registrySha256}`,
      `REGISTERED_PROMPT_SHA256: ${context.executionPromptSha256}`,
      `APPROVED_PLAN_SHA256: ${context.planSha256}`,
    ].join("\n"),
    `Exact user-approved Lead plan:\n${approvedPlan}`,
    "The user explicitly approved this exact Lead plan for this registered task and project scope. Coordinate execution through registered team members. Writable work must remain in managed isolated worktrees and within the registered file list. Do not merge, publish, create another project directory, or expand scope.",
    "The listed Lead, Senior Developer, and Reviewer are roles registered and managed by the external OpenOffice Orchestrator, not Codex /root/... subagents. Use the supplied OpenOffice roster as the delegation target list; do not use send_message, list_agents, followup_task, or spawn_agent to find or create these roles. As Lead, delegate only by emitting in the FINAL answer a line in the form @Exact Registered Name: complete assignment; the OpenOffice DelegationRouter schedules that assignment. Do not claim an OpenOffice role is missing because Codex's internal agent list does not contain it. If a requested target is absent from the supplied OpenOffice roster, do not invent or rename it; report that target as missing.",
    "The host has already admitted this current execution. Use the bound task, goal version, execution ID, and registry SHA above; historical round numbers do not create current run authority. Do not start another run or call a scheduler, reservation, or job-manager API.",
    "The host manages registered fixed checks and static preview. Complete only your assigned role work, report what you actually verified, and do not claim a host check or preview passed before its evidence is returned.",
    "Executable @delegations to registered members and each complete assignment body must appear in the FINAL answer; commentary is not executable and must not be claimed as delegated work. Lead/coordination roles must not write code or invoke tools themselves.",
  ].join("\n\n");
}

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};
function assertNativeWorkspace(registryRoot: string, actualWorkspace: string, readOnly: boolean) {
  const actual = realpathSync(actualWorkspace);
  const root = realpathSync(registryRoot);
  if (actual === root) {
    if (!readOnly) throw new Error("Writable native processes require a registered managed worktree");
    return;
  }
  const top = realpathSync(execFileSync("git", ["-C", actual, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout: 3_000 }).trim());
  const actualCommon = realpathSync(path.resolve(actual, execFileSync("git", ["-C", actual, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 3_000 }).trim()));
  const rootCommon = realpathSync(path.resolve(root, execFileSync("git", ["-C", root, "rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: 3_000 }).trim()));
  if (top !== actual || actualCommon !== rootCommon) throw new Error("Native process workspace is not a registered managed worktree");
}

type WorktreeRebindEvidence = {
  priorExecutionId: string;
  currentExecutionId: string;
  nativeWorkspace: string;
  expectedGoalVersionId: string;
  expectedRegistrySha256: string;
  scopeFingerprint: string;
  sourceHead: string;
  sourceSnapshotSha256: string;
  baselineHead: string;
  changedFiles: Array<{ path: string; sha256: string }>;
};

type PreparedNativeBaseline = { baselineHead: string; rebindEventId: string | null };

export async function prepareNativeSourceBaseline(
  registry: NonNullable<ReturnType<typeof loadProductProjectRegistry>>,
  actualWorkspace: string,
  readOnly: boolean,
  executionId: string,
  authorizeRebind?: (evidence: WorktreeRebindEvidence) => Promise<{ authorized: boolean; eventId?: string }>,
): Promise<PreparedNativeBaseline> {
  const root = realpathSync(registry.workspace.path);
  const sourceHead = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3_000 }).trim();
  if (sourceHead !== registry.workspace.sourceHead) throw new Error("Registered source Git HEAD changed after workspace authorization");
  const manifest = registry.workspace.sourceManifest.map((entry) => {
    const file = path.resolve(root, entry.path);
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Registered source snapshot path escaped its workspace");
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== entry.bytes || (stat.mode & 0o777) !== entry.mode) {
      throw new Error(`Registered source snapshot changed: ${entry.path}`);
    }
    const bytes = readFileSync(file);
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error(`Registered source snapshot changed: ${entry.path}`);
    return { ...entry };
  });
  if (sha256(canonical({ sourceHead, sourceManifest: manifest })) !== registry.workspace.sourceSnapshotSha256) {
    throw new Error("Registered source snapshot digest is invalid");
  }
  if (readOnly) return { baselineHead: sourceHead, rebindEventId: null };

  const actual = realpathSync(actualWorkspace);
  const gitDirText = execFileSync("git", ["-C", actual, "rev-parse", "--git-dir"], { encoding: "utf8", timeout: 3_000 }).trim();
  const gitDir = realpathSync(path.resolve(actual, gitDirText));
  const markerFile = path.join(gitDir, "irixi-product-source-baseline.json");
  if (existsSync(markerFile)) {
    const markerStat = lstatSync(markerFile);
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.nlink !== 1 || markerStat.size > 4_096) throw new Error("Managed worktree source baseline marker is invalid");
    const marker = JSON.parse(readFileSync(markerFile, "utf8"));
    if (marker?.schemaVersion !== 1 || marker.sourceSnapshotSha256 !== registry.workspace.sourceSnapshotSha256
      || marker.sourceHead !== sourceHead || typeof marker.baselineHead !== "string" || !/^[a-f0-9]{40}$/.test(marker.baselineHead)) {
      throw new Error("Managed worktree is bound to another source snapshot");
    }
    execFileSync("git", ["-C", actual, "merge-base", "--is-ancestor", marker.baselineHead, "HEAD"], { stdio: "ignore", timeout: 3_000 });
    if (marker.executionId !== executionId) {
      if (!authorizeRebind) throw new Error("Managed worktree is bound to another execution");
      const changed = execFileSync("git", ["-C", actual, "diff", "--name-only", marker.baselineHead, "--"], {
        encoding: "utf8", timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
      }).trim().split("\n").filter(Boolean).sort();
      const status = execFileSync("git", ["-C", actual, "status", "--porcelain=v1", "--untracked-files=all"], {
        encoding: "utf8", timeout: 5_000, maxBuffer: 2 * 1024 * 1024,
      }).split("\n").filter((line) => line.trim());
      const statusPaths = status.map((line) => line.slice(3)).sort();
      const allowed = registry.workspace.allowedWritePaths;
      if (new Set(changed).size !== changed.length || changed.some((relative) => !allowed.includes(relative))
        || new Set(statusPaths).size !== statusPaths.length
        || status.some((line) => !/^[ M]{2} /.test(line) || line.slice(3).includes(" -> ") || !changed.includes(line.slice(3)))) {
        throw new Error("Managed worktree continuation contains untracked, deleted, renamed, or unauthorized files");
      }
      const changedFiles = changed.map((relative) => {
        const file = path.resolve(actual, relative);
        if (!file.startsWith(`${actual}${path.sep}`)) throw new Error("Managed worktree changed path escaped its workspace");
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Managed worktree changed file is unsafe: ${relative}`);
        return { path: relative, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") };
      });
      const evidence: WorktreeRebindEvidence = {
        priorExecutionId: marker.executionId,
        currentExecutionId: executionId,
        expectedGoalVersionId: registry.goalVersionId,
        expectedRegistrySha256: productRegistrySha256(registry),
        scopeFingerprint: registry.workspace.scopeFingerprint,
        sourceHead, sourceSnapshotSha256: registry.workspace.sourceSnapshotSha256,
        baselineHead: marker.baselineHead, nativeWorkspace: actual, changedFiles,
      };
      const temporary = `${markerFile}.${process.pid}.${executionId}.tmp`;
      const pendingMarker = `${JSON.stringify({ ...marker, executionId })}\n`;
      writeFileSync(temporary, pendingMarker, { flag: "wx", mode: 0o600 });
      try {
        const result = await authorizeRebind(evidence);
        if (!result?.authorized || typeof result.eventId !== "string" || !result.eventId) {
          throw new Error("Authority did not authorize managed worktree continuation with an event binding");
        }
        const reboundMarker = `${JSON.stringify({ ...marker, executionId, reboundEventId: result.eventId })}\n`;
        writeFileSync(temporary, reboundMarker, { flag: "w", mode: 0o600 });
        renameSync(temporary, markerFile);
      } catch (error) {
        try { unlinkSync(temporary); } catch { /* Preserve the original continuation error. */ }
        throw error;
      }
      const reboundMarker = JSON.parse(readFileSync(markerFile, "utf8"));
      return { baselineHead: marker.baselineHead, rebindEventId: reboundMarker.reboundEventId };
    }
    return { baselineHead: marker.baselineHead, rebindEventId: typeof marker.reboundEventId === "string" ? marker.reboundEventId : null };
  }
  const worktreeHead = execFileSync("git", ["-C", actual, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3_000 }).trim();
  const status = execFileSync("git", ["-C", actual, "status", "--porcelain=v1", "--untracked-files=all"], { encoding: "utf8", timeout: 5_000, maxBuffer: 2 * 1024 * 1024 });
  if (worktreeHead !== sourceHead || status.trim()) throw new Error("Managed worktree is not clean at the registered source HEAD before snapshot overlay");
  for (const entry of manifest) {
    const source = path.resolve(root, entry.path), destination = path.resolve(actual, entry.path);
    if (!destination.startsWith(`${actual}${path.sep}`)) throw new Error("Managed worktree snapshot path escaped its workspace");
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    chmodSync(destination, entry.mode);
  }
  execFileSync("git", ["-C", actual, "add", "--", ...manifest.map((entry) => entry.path)], { stdio: "ignore", timeout: 10_000 });
  let baselineHead = sourceHead;
  try {
    execFileSync("git", ["-C", actual, "diff", "--cached", "--quiet"], { stdio: "ignore", timeout: 3_000 });
  } catch (error: any) {
    if (error?.status !== 1) throw error;
    execFileSync("git", ["-C", actual, "-c", "user.name=Irixi Product Baseline", "-c", "user.email=irixi-product@localhost",
      "commit", "--no-gpg-sign", "-m", `Irixi source baseline ${registry.workspace.sourceSnapshotSha256}`], { stdio: "ignore", timeout: 10_000 });
    baselineHead = execFileSync("git", ["-C", actual, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 3_000 }).trim();
  }
  const marker = `${JSON.stringify({ schemaVersion: 1, executionId, sourceHead, sourceSnapshotSha256: registry.workspace.sourceSnapshotSha256, baselineHead, reboundEventId: null })}\n`;
  const temporary = `${markerFile}.${process.pid}.tmp`;
  writeFileSync(temporary, marker, { flag: "wx", mode: 0o600 });
  renameSync(temporary, markerFile);
  return { baselineHead, rebindEventId: null };
}
export const INTEGRATED_DEVELOPER_TAG = "INTEGRATED_TOY_DEVELOPER_05";
export const INTEGRATED_REVIEWER_TAG = "INTEGRATED_TOY_REVIEWER_05";
export const PROJECT_INTAKE_TAG = "PROJECT_INTAKE_DISCUSSION_07";
export const ARTICLE_DEVELOPER_TAG = "ARTICLE_LEARNING_DEVELOPER_12";
export const ARTICLE_REVIEWER_TAG = "ARTICLE_LEARNING_REVIEWER_12";
export const ARTICLE_INFERENCE_TAG = "ARTICLE_LEARNING_INFERENCE_12";
export function isRegisteredInferenceSource(projectId: string | null, sourceTaskId: string): boolean {
  return projectId === "article-learning-12"
    && /^learning-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceTaskId);
}

type IntakeTerminalEvent = Extract<GatewayEvent, { type: "TASK_DONE" | "TASK_FAILED" }>;

export async function persistIntakeTerminalBeforePublish(options: {
  integration: { recordIntake(type: "TASK_DONE" | "TASK_FAILED", sourceTaskId: string, value: string): Promise<void> };
  event: IntakeTerminalEvent;
  buffer: (event: IntakeTerminalEvent) => void;
  publish: (event: IntakeTerminalEvent) => void;
}) {
  const { integration, event, buffer, publish } = options;
  try {
    const value = event.type === "TASK_DONE" ? event.result.fullOutput || event.result.summary : event.error;
    await integration.recordIntake(event.type, event.taskId, value);
    buffer(event);
    publish(event);
    return { persisted: true as const, event };
  } catch {
    const failed = {
      type: "TASK_FAILED" as const,
      agentId: event.agentId,
      taskId: event.taskId,
      error: "The clarification result was not persisted by Irixi; no completion was recorded.",
    };
    buffer(failed);
    publish(failed);
    return { persisted: false as const, event: failed };
  }
}

export async function persistInferenceTerminalBeforePublish(options: {
  integration: { recordInference(type: "TASK_DONE" | "TASK_FAILED", sourceTaskId: string, value: string): Promise<void> };
  event: IntakeTerminalEvent;
  buffer: (event: IntakeTerminalEvent) => void;
  publish: (event: IntakeTerminalEvent) => void;
}) {
  const { integration, event, buffer, publish } = options;
  try {
    const value = event.type === "TASK_DONE" ? event.result.fullOutput || event.result.summary : event.error;
    await integration.recordInference(event.type, event.taskId, value);
    buffer(event); publish(event);
    return { persisted: true as const, event };
  } catch {
    const failed = { type: "TASK_FAILED" as const, agentId: event.agentId, taskId: event.taskId,
      error: "The learning inference result was not persisted by Irixi; no completion was recorded." };
    buffer(failed); publish(failed);
    return { persisted: false as const, event: failed };
  }
}

export async function persistInferenceStartFailureBeforePublish(options: {
  integration: {
    isInferenceTask(sourceTaskId: string): boolean;
    recordInference(type: "TASK_DONE" | "TASK_FAILED", sourceTaskId: string, value: string): Promise<void>;
  };
  event: Extract<IntakeTerminalEvent, { type: "TASK_FAILED" }>;
  buffer: (event: IntakeTerminalEvent) => void;
  publish: (event: IntakeTerminalEvent) => void;
}) {
  if (options.integration.isInferenceTask(options.event.taskId)) return persistInferenceTerminalBeforePublish(options);
  options.buffer(options.event);
  options.publish(options.event);
  return { persisted: false as const, event: options.event };
}

type IntegratedTerminalEvent = Extract<GatewayEvent, { type: "TASK_DONE" | "TASK_FAILED" }>;

function boundedTerminalError(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const bytes = Buffer.from(normalized, "utf8");
  if (bytes.length <= 1_000) return normalized;
  let end = 1_000;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function isTerminalObservationTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; message?: unknown };
  return value.name === "TimeoutError" || value.name === "AbortError"
    || (typeof value.message === "string" && /operation was aborted due to timeout/i.test(value.message));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function integratedTerminalReceiptMatches(response: unknown, expected: Record<string, unknown>): boolean {
  const envelope = asRecord(response);
  const observation = asRecord(envelope?.observation) || envelope;
  const record = asRecord(observation?.record);
  const expectedBinding = asRecord(expected.binding);
  const actualBinding = asRecord(record?.binding);
  if (!record || !expectedBinding || !actualBinding) return false;
  const expectedBindingKeys = Object.keys(expectedBinding).sort();
  const actualBindingKeys = Object.keys(actualBinding).sort();
  return record.type === expected.type
    && record.actor === expected.actor
    && record.sourceTaskId === expected.sourceTaskId
    && record.sourceEventId === expected.sourceEventId
    && (record.nativeAttemptId ?? null) === (expected.nativeAttemptId ?? null)
    && (record.resultSha256 ?? null) === (expected.resultSha256 ?? null)
    && (expected.preparationFailure !== true || (record.preparationFailure === true
      && record.reservationStatus === "not_created" && record.modelCallCreated === false
      && record.scopeOutcome === null && typeof record.nativeRole === "string"))
    && expectedBindingKeys.length === actualBindingKeys.length
    && expectedBindingKeys.every((key, index) => key === actualBindingKeys[index] && expectedBinding[key] === actualBinding[key]);
}

export function integratedAutoReviewTransition(value: any) {
  return value?.observation?.transition?.autoReview ?? value?.transition?.autoReview ?? null;
}

export async function persistIntegratedTerminalBeforePublish(options: {
  integration: { record(type: string, actor: "lead" | "developer" | "reviewer", sourceTaskId: string, detail: Record<string, unknown>): Promise<any> };
  event: IntegratedTerminalEvent;
  actor: "lead" | "developer" | "reviewer";
  buffer: (event: IntegratedTerminalEvent) => void;
  publish: (event: IntegratedTerminalEvent) => void;
  afterPersist?: (value: any) => void;
}) {
  const { integration, event, actor, buffer, publish, afterPersist } = options;
  const detail = {
    sourceEventId: `${event.taskId}:${event.nativeAttemptId || "legacy"}:${event.type}`,
    resultText: event.type === "TASK_DONE" ? event.result.fullOutput || event.result.summary : null,
    ...(event.type === "TASK_FAILED" ? { error: boundedTerminalError(event.error) } : {}),
    agentId: event.agentId,
    ...(event.irixiAuthority ? { eventBinding: event.irixiAuthority } : {}),
    ...(event.type === "TASK_DONE" && actor === "developer" ? { changedFiles: event.result.changedFiles.length ? event.result.changedFiles : null, entryFile: event.result.entryFile || null } : {}),
    ...(event.type === "TASK_DONE" ? { isFinalResult: event.isFinalResult === true } : {}),
    scopeOutcome: event.type === "TASK_FAILED" ? "failed" : "completed",
    nativeAttemptId: event.nativeAttemptId,
  };
  try {
    let recorded: any;
    try {
      recorded = await integration.record(event.type, actor, event.taskId, detail);
    } catch (error) {
      if (!isTerminalObservationTimeout(error)) throw error;
      // Authority deduplicates sourceEventId only when the full observation fingerprint matches.
      // Replaying this exact terminal write can recover a committed receipt without rerunning the model.
      recorded = await integration.record(event.type, actor, event.taskId, detail);
    }
    if (!recorded || typeof recorded !== "object") throw new Error("Irixi terminal observation receipt is missing");
    buffer(event);
    publish(event);
    afterPersist?.(recorded);
    return { persisted: true as const, event };
  } catch (error) {
    const authorityError = String(error instanceof Error ? error.message : "authority persistence failed").replace(/[\r\n]+/g, " ").slice(0, 300);
    console.warn(`[IrixiTerminalPersistence] ${JSON.stringify({ taskId: event.taskId, eventType: event.type, actor, authorityError, authorityErrorSha256: sha256(authorityError) })}`);
    const failed = { type: "TASK_FAILED" as const, agentId: event.agentId, taskId: event.taskId, error: "The Irixi authority rejected this terminal result; no candidate or review completion was recorded." };
    let failurePersisted = false;
    try {
      const failureReceipt = await integration.record("TASK_FAILED", actor, event.taskId, {
        sourceEventId: `${event.taskId}:${event.nativeAttemptId || "legacy"}:TASK_FAILED:authority-persistence`,
        nativeAttemptId: event.nativeAttemptId,
        scopeOutcome: "failed",
      });
      if (!failureReceipt || typeof failureReceipt !== "object") throw new Error("Irixi failure observation receipt is missing");
      failurePersisted = true;
    } catch { /* The UI still receives an honest failure; authority remains fail-closed. */ }
    buffer(failed);
    publish(failed);
    return { persisted: false as const, failurePersisted, authorityError, event: failed };
  }
}

export function withoutIrixiProtocolTags(value: string | undefined): string {
  return String(value || "")
    .replaceAll(INTEGRATED_DEVELOPER_TAG, "[developer protocol tag omitted]")
    .replaceAll(INTEGRATED_REVIEWER_TAG, "[reviewer protocol tag omitted]")
    .replaceAll(PROJECT_INTAKE_TAG, "[intake protocol tag omitted]")
    .replaceAll(ARTICLE_DEVELOPER_TAG, "[article developer protocol tag omitted]")
    .replaceAll(ARTICLE_REVIEWER_TAG, "[article reviewer protocol tag omitted]")
    .replaceAll(ARTICLE_INFERENCE_TAG, "[article inference protocol tag omitted]");
}

export function createIrixiIntegration() {
  const rawUrl = process.env.IRIXI_AUTHORITY_URL?.trim();
  const expectedTaskId = process.env.IRIXI_AUTHORITY_TASK_ID?.trim();
  const intakeTaskId = process.env.IRIXI_INTAKE_TASK_ID?.trim() || null;
  const initialProductRegistry = loadProductProjectRegistry();
  const initialProductRegistrySha256 = initialProductRegistry ? productRegistrySha256(initialProductRegistry) : null;
  let lastProjectedExecutionId: string | null = null;
  const configuredProjectId = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID?.trim() || null;
  if (initialProductRegistry && configuredProjectId && configuredProjectId !== initialProductRegistry.projectId) {
    throw new Error("Configured Irixi project does not match the current product registry");
  }
  const articleProjectId = initialProductRegistry?.projectId || configuredProjectId;
  if (!rawUrl && !expectedTaskId) return null;
  if (!rawUrl || !expectedTaskId) throw new Error("IRIXI_AUTHORITY_URL and IRIXI_AUTHORITY_TASK_ID must be set together");
  if (initialProductRegistry && (rawUrl !== initialProductRegistry.authorityUrl || expectedTaskId !== initialProductRegistry.taskId)) {
    throw new Error("Product registry authority or task does not match the configured Irixi endpoint");
  }
  const authorityTaskId = expectedTaskId;
  if (!isAllowedAuthorityUrl(rawUrl)) throw new Error("Irixi authority must use an explicit HTTP loopback origin on a non-privileged port");
  const endpoint = new URL(rawUrl);
  const taskBindings = new Map<string, IrixiEventBinding>();
  const taskActors = new Map<string, "lead" | "developer" | "reviewer">();
  type RegisteredProductReview = {
    sourceTaskId: string; agentId: string; role: string; dispatchEventId: string; goalVersionId: string;
    executionId: string; registrySha256: string; artifactId: string; artifactVersion: number;
    candidateSha256: string; expectedReviewId: string | null; reviewRoundId: string | null;
    prompt: string; promptSha256: string; binding: IrixiEventBinding;
  };
  const productReviewTasks = new Map<string, RegisteredProductReview>();
  const canonicalReviewerRole = (role: unknown) => {
    if (typeof role !== "string") return null;
    const registered = initialProductRegistry?.native.allowedRoles.find((candidate) => candidate.toLowerCase() === role.toLowerCase());
    return registered?.toLowerCase().includes("review") ? registered : null;
  };
  const reviewContracts = new Map<string, NonNullable<Projection["confirmedContract"]>>();
  const intakeRuns = new Map<string, string>();
  const inferenceRuns = new Map<string, { prompt: string; promptSha256: string }>();
  const projectProgressRuns = new Map<string, { reservationId: string; sessionId: string; batchId: string; prompt: string; promptSha256: string }>();
  type NativeRun = { attemptId: string; agentId: string; nativeWorkspace: string; binding: IrixiEventBinding; actor: "lead" | "developer" | "reviewer"; phase: string | null };
  const pendingNativeRuns = new Map<string, NativeRun>();
  const nativeRuns = new Map<string, NativeRun>();

  async function intakeRequest(pathname: string, init: RequestInit = {}) {
    const url = new URL(pathname, endpoint);
    const method = (init.method || "GET").toUpperCase();
    const productLearningRoute = initialProductRegistry?.projectId === "article-learning-12"
      && initialProductRegistry.taskId === authorityTaskId
      && PRODUCT_LEARNING_AUTHORITY_ROUTES.has(`${method} ${url.pathname}`);
    if (!intakeTaskId && !productLearningRoute) throw new Error("Irixi project intake is not enabled");
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000), ...init });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof value?.error === "string" ? value.error : `Irixi intake rejected request (${response.status})`), { status: response.status });
    return value;
  }

  async function projectProgressRequest(pathname: string, init: RequestInit = {}) {
    if (initialProductRegistry?.projectId !== "project-progress-assistant" || initialProductRegistry.taskId !== authorityTaskId) {
      throw new Error("Project progress assistant is not the registered current product");
    }
    const response = await fetch(new URL(pathname, endpoint), { signal: AbortSignal.timeout(8_000), ...init });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof value?.error === "string" ? value.error : `Project progress authority rejected request (${response.status})`), { status: response.status });
    return value;
  }

  async function projection(requireCurrent = true): Promise<Projection> {
    const requestId = randomUUID();
    const startedAt = performance.now();
    let stage = "authority_fetch";
    let httpStatus: number | null = null;
    const audit = (outcome: "failed" | "slow_success", error?: unknown) => {
      const errorName = error instanceof Error ? error.name : "Error";
      const errorClass = ["TimeoutError", "AbortError", "TypeError"].includes(errorName) ? errorName : "Error";
      console.warn(`[IrixiAuthorityProjection] ${JSON.stringify({
        requestId, taskId: authorityTaskId, executionId: lastProjectedExecutionId,
        registrySha256: initialProductRegistrySha256, stage, outcome,
        elapsedMs: Number((performance.now() - startedAt).toFixed(1)), httpStatus,
        ...(error ? { errorClass } : {}),
      })}`);
    };
    try {
      const headers: Record<string, string> = { accept: "application/json", "x-irixi-projection-id": requestId };
      if (lastProjectedExecutionId) headers["x-irixi-execution-id"] = lastProjectedExecutionId;
      if (initialProductRegistrySha256) headers["x-irixi-registry-sha256"] = initialProductRegistrySha256;
      const response = await fetch(new URL(`/v1/authority?taskId=${encodeURIComponent(authorityTaskId)}`, endpoint), {
        signal: AbortSignal.timeout(AUTHORITY_PROJECTION_TIMEOUT_MS), headers,
      });
      httpStatus = response.status;
      stage = "response_body";
      const responseText = await response.text();
      stage = "http_status";
      if (!response.ok) {
        const responseExcerpt = responseText.trim().slice(0, 300);
        throw new Error(`Irixi authority rejected current state (${response.status})${responseExcerpt ? `: ${responseExcerpt}` : ""}`);
      }
      stage = "response_json";
      let body: { projection?: Projection };
      try { body = JSON.parse(responseText) as { projection?: Projection }; }
      catch { throw new Error("Irixi authority returned invalid JSON"); }
      stage = "binding_validation";
      const value = body.projection;
      if (!value || value.schemaVersion !== 1 || value.taskId !== authorityTaskId || (requireCurrent && !value.current)
        || !/^[a-f0-9]{64}$/.test(value.authoritySha256) || !/^[a-f0-9]{64}$/.test(value.taskInputBindingSha256)
        || !/^[a-f0-9]{64}$/.test(value.pipelineBindingSha256)
        || value.workspace && ((requireCurrent && !value.workspace.current) || !value.workspace.scopeFingerprint || !value.workspace.sourceSnapshotSha256)) {
        throw new Error("Irixi authority is stale or malformed");
      }
      lastProjectedExecutionId = value.execution?.id || null;
      if (performance.now() - startedAt >= 250) audit("slow_success");
      return value;
    } catch (error) {
      audit("failed", error);
      throw error;
    }
  }

  const binding = (value: Projection, sourceTaskId: string): IrixiEventBinding => ({
    taskId: value.taskId,
    goalVersionId: value.goalVersionId,
    taskInputBindingSha256: value.taskInputBindingSha256,
    pipelineBindingSha256: value.pipelineBindingSha256,
    executionId: value.execution?.id || null,
    workspaceScopeFingerprint: value.workspace?.scopeFingerprint || null,
    sourceSnapshotSha256: value.workspace?.sourceSnapshotSha256 || null,
    artifactId: value.artifact?.id || null,
    artifactVersion: value.artifact?.version || null,
    candidateSha256: value.artifact?.candidateSha256 || null,
    diffSha256: value.artifact?.diffSha256 || null,
    authoritySnapshotSha256: value.authoritySha256,
    sourceTaskId,
  });

  return {
    taskId: authorityTaskId,
    async productBindingProjection() {
      const value = await projection(false);
      const productRegistry = loadProductProjectRegistry();
      const productBindingCurrent = productRegistry ? Boolean(productProjectionMatches(productRegistry, value)
        && value.productRegistry?.current && value.productRegistry.registrySha256 === productRegistrySha256(productRegistry)) : null;
      return {
        taskId: value.taskId,
        goalVersionId: value.goalVersionId,
        current: value.current,
        execution: value.execution,
        product: productRegistry ? {
          projectId: productRegistry.projectId,
          registrySha256: productRegistrySha256(productRegistry),
          bindingCurrent: productBindingCurrent,
        } : null,
      };
    },
    async publicProjection() {
      const value = await projection(false);
      const boardResponse = await fetch(new URL(`/v1/task-board?taskId=${encodeURIComponent(authorityTaskId)}`, endpoint), {
        signal: AbortSignal.timeout(3_000), headers: { accept: "application/json" },
      });
      if (!boardResponse.ok) throw new Error(`Irixi task board rejected current state (${boardResponse.status})`);
      const board = await boardResponse.json() as any;
      if (board.taskId !== value.taskId || board.goalVersionId !== value.goalVersionId
        || board.pipelineBindingSha256 !== value.pipelineBindingSha256
        || board.executionId !== (value.execution?.id || null)) throw new Error("Irixi task board changed during projection");
      const productRegistry = loadProductProjectRegistry();
      const productBindingCurrent = productRegistry ? Boolean(productProjectionMatches(productRegistry, value)
        && value.productRegistry?.current && value.productRegistry.registrySha256 === productRegistrySha256(productRegistry)) : null;
      return {
        enabled: true as const,
        taskId: value.taskId,
        title: value.title,
        goalStatement: value.goalStatement,
        goalVersionId: value.goalVersionId,
        current: value.current,
        status: value.status,
        actor: board.actor || null,
        statusLabel: board.statusLabel,
        nextStep: board.nextStep,
        execution: value.execution,
        team: board.team || { agents: [] },
        workItems: board.workItems || [],
        input: board.input || { instructions: [], materials: [], materialApplicabilityFingerprint: null },
        conversations: board.conversations || [],
        native: board.native || null,
        artifact: value.artifact ? {
          id: value.artifact.id, version: value.artifact.version,
          candidateSha256: value.artifact.candidateSha256,
          hostCheck: value.artifact.hostCheck || null,
          review: value.artifact.review || null,
          confirmation: value.artifact.confirmation || null,
        } : null,
        registeredExecution: value.registeredExecution ? {
          goalVersionId: value.registeredExecution.goalVersionId,
          displayPrompt: value.registeredExecution.displayPrompt,
          promptSha256: value.registeredExecution.promptSha256,
        } : null,
        product: productRegistry ? {
          projectId: productRegistry.projectId,
          registrySha256: productRegistrySha256(productRegistry),
          bindingCurrent: productBindingCurrent,
          bindingError: productBindingCurrent ? null : "The project registry belongs to an older task, goal, input, execution, or workspace binding.",
          workspaceScopeFingerprint: productRegistry.workspace.scopeFingerprint,
          allowedWritePaths: productRegistry.workspace.allowedWritePaths,
          checks: productRegistry.workspace.checks,
          capabilities: productRegistry.capabilities,
          native: {
            allowedRoles: productRegistry.native.allowedRoles,
            maxModelCalls: productRegistry.native.maxModelCalls,
            maxDurationMs: productRegistry.native.maxDurationMs,
          },
        } : null,
      };
    },
    async executionPrompt() {
      const value = await projection(true);
      if (!value.registeredExecution || value.registeredExecution.goalVersionId !== value.goalVersionId
        || sha256(value.registeredExecution.prompt) !== value.registeredExecution.promptSha256) {
        throw new Error("Current registered execution prompt is unavailable");
      }
      return { prompt: value.registeredExecution.prompt, promptSha256: value.registeredExecution.promptSha256 };
    },
    async replaceProductGoal(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string; statement: string; successCriteria: string[]; boundaries: string[] }) {
      const response = await fetch(new URL("/v1/product-goal", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected the goal update (${response.status})`);
      return response.json();
    },
    async addProductInstruction(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string;
      text: string; expectedArtifactId?: string; expectedArtifactVersion?: number }) {
      const response = await fetch(new URL("/v1/product-instructions", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected the product instruction (${response.status})`);
      return response.json();
    },
    async addProductConversation(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string; agentId: string; text: string }) {
      const response = await fetch(new URL("/v1/product-conversation", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected the product conversation (${response.status})`);
      return response.json();
    },
    async readProjectProgress(sessionId: string) {
      return projectProgressRequest(`/v1/project-progress/session?sessionId=${encodeURIComponent(sessionId)}`);
    },
    async openProjectProgressSession(input: Record<string, unknown>) {
      return projectProgressRequest("/v1/project-progress/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async saveProjectProgressState(input: Record<string, unknown>) {
      return projectProgressRequest("/v1/project-progress/session/state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async openProjectProgressBatch(input: Record<string, unknown>) {
      return projectProgressRequest("/v1/project-progress/session/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async reserveProjectProgressInference(input: Record<string, unknown>) {
      const value = await projectProgressRequest("/v1/project-progress/inference", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (typeof value?.sourceTaskId !== "string" || typeof value?.reservationId !== "string"
        || typeof value?.prompt !== "string" || typeof value?.promptSha256 !== "string"
        || sha256(value.prompt) !== value.promptSha256 || typeof value?.sessionId !== "string" || typeof value?.batchId !== "string") {
        throw new Error("Authority returned a malformed project progress reservation");
      }
      projectProgressRuns.set(value.sourceTaskId, { reservationId: value.reservationId, sessionId: value.sessionId,
        batchId: value.batchId, prompt: value.prompt, promptSha256: value.promptSha256 });
      return value;
    },
    async acceptProjectProgressProposal(input: Record<string, unknown>) {
      return projectProgressRequest("/v1/project-progress/session/accept", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async addProductMaterial(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string; name: string; kind?: string; text: string }) {
      const response = await fetch(new URL("/v1/product-materials", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected the product material (${response.status})`);
      return response.json();
    },
    async cancelProductExecution(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string }) {
      const response = await fetch(new URL("/v1/product-cancel", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected cancellation (${response.status})`);
      return response.json();
    },
    async pauseProductExecution(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string }) {
      const response = await fetch(new URL("/v1/product-pause", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected pause (${response.status})`);
      return response.json();
    },
    async resumeProductExecution(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string }) {
      const response = await fetch(new URL("/v1/product-resume", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected resume (${response.status})`);
      return response.json();
    },
    async recoverProductLeadPlan(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string; expectedSourceTaskId: string; expectedNativeAttemptId: string; expectedPlanSha256: string; planText: string }) {
      const response = await fetch(new URL("/v1/product-lead-plan-recovery", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected saved Lead plan recovery (${response.status})`);
      return response.json();
    },
    async productLeadPlan() {
      const response = await fetch(new URL(`/v1/product-lead-plan?taskId=${encodeURIComponent(expectedTaskId!)}`, endpoint), {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.status === 404) return null;
      const value = await response.json();
      if (!response.ok || value?.taskId !== expectedTaskId || typeof value.goalVersionId !== "string"
        || typeof value.executionId !== "string" || typeof value.registrySha256 !== "string"
        || typeof value.agentId !== "string" || !isValidLeadPlanText(value.planText)
        || sha256(value.planText) !== value.planSha256) {
        throw new Error(typeof value?.error === "string" ? value.error : "Irixi returned a malformed saved Lead plan");
      }
      return value as { taskId: string; goalVersionId: string; executionId: string; registrySha256: string;
        agentId: string; sourceTaskId: string; attemptId: string; planText: string; planSha256: string };
    },
    async registerProductAgents(input: { expectedRegistrySha256: string; agents: Array<{ id: string; name: string; role: string; backend: string; model: string; isTeamLead: boolean }> }) {
      const response = await fetch(new URL("/v1/product-agents", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      if (!response.ok) throw new Error(`Irixi rejected the native agent roster (${response.status})`);
      return response.json();
    },
    async openProductReviewRound(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string;
      expectedArtifactId: string; expectedArtifactVersion: number; expectedCandidateSha256: string; expectedReviewId: string | null }) {
      const expectedReviewId = input.expectedReviewId ?? null;
      const request = { ...input, expectedReviewId };
      const current = await projection();
      const response = await fetch(new URL("/v1/product-review-round", endpoint), { method: "POST", signal: AbortSignal.timeout(8_000), headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
      const value = await response.json();
      if (!response.ok || typeof value?.reviewRoundId !== "string" || value?.taskId !== current.taskId
        || value?.artifactId !== input.expectedArtifactId || value?.artifactVersion !== input.expectedArtifactVersion
        || value?.candidateSha256 !== input.expectedCandidateSha256 || value?.expectedReviewId !== expectedReviewId
        || value?.maxModelCalls !== 1 || value?.modelCalls !== 0 || !Number.isFinite(Date.parse(value?.deadlineAt || ""))) {
        throw new Error(typeof value?.error === "string" ? value.error : "Irixi rejected the follow-up review round");
      }
      return value as { taskId: string; reviewRoundId: string; artifactId: string; artifactVersion: number;
        candidateSha256: string; expectedReviewId: string | null; maxModelCalls: 1; modelCalls: 0; deadlineAt: string };
    },
    async productReviewRequest(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string;
      expectedArtifactId: string; expectedArtifactVersion: number; expectedCandidateSha256: string; expectedReviewId: string | null;
      expectedReviewRoundId?: string; reviewEvidence?: string }) {
      const response = await fetch(new URL("/v1/product-review-request", endpoint), { method: "POST", signal: AbortSignal.timeout(8_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const value = await response.json();
      if (!response.ok || typeof value?.prompt !== "string" || sha256(value.prompt) !== value.promptSha256
        || value?.artifactId !== input.expectedArtifactId
        || value?.artifactVersion !== input.expectedArtifactVersion || value?.candidateSha256 !== input.expectedCandidateSha256
        || value?.expectedReviewId !== input.expectedReviewId || typeof value?.dispatchEventId !== "string"
        || (input.expectedReviewRoundId && value?.reviewRoundId !== input.expectedReviewRoundId)) {
        throw new Error(typeof value?.error === "string" ? value.error : "Irixi rejected the product review request");
      }
      return value as { taskId: string; artifactId: string; artifactVersion: number; candidateSha256: string;
        expectedReviewId: string | null; reviewRoundId?: string | null; dispatchEventId: string; prompt: string; promptSha256: string };
    },
    async registerProductReviewTask(sourceTaskId: string, agentId: string, role: string, request: {
      goalVersionId: string; executionId: string; registrySha256: string; artifactId: string; artifactVersion: number;
      candidateSha256: string; expectedReviewId: string | null; reviewRoundId?: string | null;
      dispatchEventId: string; prompt: string; promptSha256: string;
    }) {
      const registeredRole = canonicalReviewerRole(role);
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(sourceTaskId) || !/^[A-Za-z0-9_-]{1,160}$/.test(agentId)
        || !registeredRole
        || !/^event-[A-Za-z0-9_-]{1,160}$/.test(request.dispatchEventId)
        || sha256(request.prompt) !== request.promptSha256 || !request.prompt.startsWith("IRIXI_PRODUCT_REVIEW_V1\n")) {
        throw new Error("Product Reviewer dispatch identity is malformed");
      }
      const value = await projection();
      const registry = loadProductProjectRegistry();
      if (!registry || !value.current || value.taskId !== authorityTaskId || !value.execution?.id
        || !value.artifact?.id || !value.artifact.candidateSha256 || !value.productRegistry?.current
        || productRegistrySha256(registry) !== request.registrySha256
        || value.productRegistry.registrySha256 !== request.registrySha256
        || value.goalVersionId !== request.goalVersionId || value.execution.id !== request.executionId
        || value.artifact.id !== request.artifactId || value.artifact.version !== request.artifactVersion
        || value.artifact.candidateSha256 !== request.candidateSha256
        || (value.artifact.review?.id || null) !== request.expectedReviewId) {
        throw new Error("Product Reviewer dispatch binding is stale");
      }
      const registered: RegisteredProductReview = {
        sourceTaskId, agentId, role: registeredRole, dispatchEventId: request.dispatchEventId,
        goalVersionId: request.goalVersionId, executionId: request.executionId, registrySha256: request.registrySha256,
        artifactId: request.artifactId, artifactVersion: request.artifactVersion,
        candidateSha256: request.candidateSha256, expectedReviewId: request.expectedReviewId,
        reviewRoundId: request.reviewRoundId || null, prompt: request.prompt, promptSha256: request.promptSha256,
        binding: binding(value, sourceTaskId),
      };
      productReviewTasks.set(sourceTaskId, registered);
      taskBindings.set(sourceTaskId, registered.binding);
      taskActors.set(sourceTaskId, "reviewer");
      return { sourceTaskId, dispatchEventId: registered.dispatchEventId, promptSha256: registered.promptSha256,
        reviewRoundId: registered.reviewRoundId, binding: { ...registered.binding } };
    },
    isRegisteredProductReview(sourceTaskId: string, prompt: string) {
      const registered = productReviewTasks.get(sourceTaskId);
      return Boolean(registered && registered.prompt === prompt && registered.promptSha256 === sha256(prompt));
    },
    async productCandidate() {
      const value = await projection(true);
      const response = await fetch(new URL(`/v1/product-candidate?taskId=${encodeURIComponent(value.taskId)}`, endpoint), {
        signal: AbortSignal.timeout(3_000),
      });
      const candidate = await response.json();
      if (!response.ok || candidate?.taskId !== value.taskId || candidate?.goalVersionId !== value.goalVersionId
        || candidate?.artifactId !== value.artifact?.id || candidate?.artifactVersion !== value.artifact?.version
        || candidate?.candidateSha256 !== value.artifact?.candidateSha256) {
        throw new Error(typeof candidate?.error === "string" ? candidate.error : "Irixi returned a stale product candidate");
      }
      return candidate;
    },
    async publicIntake() { return intakeRequest("/v1/intake"); },
    async setIntakeDiscussionEnabled(enabled: boolean) {
      return intakeRequest(enabled ? "/v1/intake/open-discussion" : "/v1/intake/close-discussion", {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
    },
    async beginIntake(concept: string) {
      return intakeRequest("/v1/intake/messages", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ concept }),
      });
    },
    async confirmIntake(input: { expectedGoalVersionId: string; statement: string; successCriteria: string[]; boundaries: string[] }) {
      return intakeRequest("/v1/intake/confirm", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
      });
    },
    async selectIntakeScope(expectedGoalVersionId: string) {
      return intakeRequest("/v1/intake/select-scope", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedGoalVersionId }),
      });
    },
    async authorizeIntakeScope(expectedGoalVersionId: string) {
      return intakeRequest("/v1/intake/authorize-scope", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedGoalVersionId }),
      });
    },
    async startNewIntakeBatch(expectedGoalVersionId: string) {
      return intakeRequest("/v1/intake/start-new-batch", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedGoalVersionId }),
      });
    },
    async beginInference(input: { sessionId: string; turnId: string; kind: "explain" | "discuss" | "assess" | "summarize"; articleSha256: string; payload: unknown }) {
      if (articleProjectId !== "article-learning-12") throw new Error("Article learning inference is not enabled");
      const currentRegistry = loadProductProjectRegistry();
      if (currentRegistry && (currentRegistry.projectId !== articleProjectId || currentRegistry.taskId !== authorityTaskId)) {
        throw new Error("Article learning inference no longer matches the current product task binding");
      }
      const nativePromptBudget = currentRegistry ? { modelId: currentRegistry.native.model, ...currentRegistry.native.promptBudget } : null;
      const value = await intakeRequest("/v1/inference/reservations", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, projectId: articleProjectId, ...(nativePromptBudget ? { nativePromptBudget } : {}) }),
      });
      if (!value || typeof value.sourceTaskId !== "string" || typeof value.prompt !== "string"
        || !value.prompt.startsWith(`${ARTICLE_INFERENCE_TAG}\n`) || sha256(value.prompt) !== value.promptSha256) {
        throw new Error("Irixi returned a malformed inference reservation");
      }
      inferenceRuns.set(value.sourceTaskId, { prompt: value.prompt, promptSha256: value.promptSha256 });
      return value as { sourceTaskId: string; prompt: string; promptSha256: string; turnId: string; remaining: number };
    },
    async registerLearningMaterial(input: { sessionId: string; label: string; source?: string; articleText: string }) {
      return intakeRequest("/v1/materials", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async openLearningBatch(input: { expectedGoalVersionId: string; expectedCandidateSha256: string; acknowledgement?: "new_reviewed_candidate_learning_acceptance" | "preserve_reconciled_sealed_learning_batch" | "preserve_platform_schema_contract_failure"; expectedFailedCandidateSha256?: string; expectedPriorLearningLedgerSha256?: string; expectedSchemaRepairProofFile?: string; expectedSchemaRepairProofSha256?: string; expectedFailedTurnId?: string; expectedMaterialEventId?: string; expectedSourceTaskId?: string }) {
      const currentRegistry = loadProductProjectRegistry();
      if (currentRegistry && (currentRegistry.projectId !== articleProjectId || currentRegistry.taskId !== authorityTaskId)) {
        throw new Error("Learning batch no longer matches the current product task binding");
      }
      const nativePromptBudget = currentRegistry ? { modelId: currentRegistry.native.model, ...currentRegistry.native.promptBudget } : null;
      return intakeRequest("/v1/learning/open-batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, ...(nativePromptBudget ? { nativePromptBudget } : {}) }) });
    },
    async openRepairBatch(input: { expectedGoalVersionId: string; expectedFailedExecutionId: string; expectedScopeFingerprint: string; expectedPriorLedgerSha256: string; expectedSourceSnapshotSha256: string; acknowledgement: "preserve_failed_batch" | "preserve_failed_learning_contract" | "preserve_failed_learning_resume"; maxModelCalls: 2; maxDurationMs: 1200000; repairKind?: "learning_contract" | "learning_resume"; expectedFailedCandidateSha256?: string; expectedLearningLedgerSha256?: string; expectedLearningEvidenceSha256?: string; expectedRootEvidenceSha256?: string; expectedIndependentEvidenceSha256?: string; expectedSavedEventId?: string; expectedFailedTurnId?: string; expectedFailedPlatformExecutionId?: string; expectedFailedPlatformLedgerSha256?: string; expectedFailedPlatformRootEvidenceSha256?: string; expectedFailedPlatformIndependentEvidenceSha256?: string; reviewOnly?: boolean; expectedCandidateSha256?: string; optInBoundedAutoReview?: boolean }) {
      return intakeRequest("/v1/intake/open-repair-batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async authorizeGoalIncrement(input: { expectedPriorGoalVersionId: string; expectedNewGoalVersionId: string; expectedConfirmedArtifactId: string; expectedConfirmedCandidateSha256: string; expectedSourceManifestSha256: string; expectedPriorLedgerSha256: string; acknowledgement: "preserve_confirmed_candidate_as_increment_input"; maxModelCalls: 2; maxDurationMs: 1200000; optInBoundedAutoReview: boolean }) {
      return intakeRequest("/v1/intake/authorize-goal-increment", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async clientState(input: { sessionId?: string; scope?: "project"; historical?: boolean }) {
      if (input.scope === "project") return intakeRequest("/v1/learning/client-state?scope=project");
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(input.sessionId || "")) throw new Error("Client-state session is invalid");
      return intakeRequest(`/v1/learning/client-state?sessionId=${encodeURIComponent(input.sessionId!)}${input.historical ? "&historical=true" : ""}`);
    },
    async saveClientState(input: unknown) {
      return intakeRequest("/v1/learning/client-state", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async recordHostClientFailure(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedCandidateSha256: string; evidenceFile: string; evidenceSha256: string }) {
      return intakeRequest("/v1/intake/host-client-failure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async recordAutoReviewDispatchFailure(input: { acknowledgement: "preserve_auto_review_dispatch_failure"; expectedGoalVersionId: string; expectedExecutionId: string; expectedCandidateSha256: string; expectedLedgerSha256: string; expectedDispatchEventId: string }) {
      return intakeRequest("/v1/intake/auto-review-dispatch-failure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async coordinateSealedReviewerResult(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedCandidateSha256: string; sourceTaskId: string; expectedLedgerSha256: string; expectedStdoutSha256: string; expectedDeveloperStdoutSha256?: string; expectedSourceManifestSha256?: string; hostProofFile?: string; hostProofSha256?: string }) {
      return intakeRequest("/v1/intake/coordinate-sealed-reviewer-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    async inferenceStatus(turnId: string) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(turnId)) throw new Error("Inference turn ID is invalid");
      return intakeRequest(`/v1/inference?turnId=${encodeURIComponent(turnId)}`);
    },
    async coordinateSealedInferenceResult(input: { expectedGoalVersionId: string; expectedCandidateSha256: string; expectedTurnId: string; sourceTaskId: string; expectedSessionId: string; expectedMaterialEventId: string; expectedArticleSha256: string; expectedPromptSha256: string; expectedLedgerSha256: string; expectedStdoutSha256: string; expectedOriginalTransportTextSha256: string; hostProofFile: string; hostProofSha256: string }) {
      return intakeRequest("/v1/inference/coordinate-sealed-result", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    },
    isInferenceTask(sourceTaskId: string) {
      return inferenceRuns.has(sourceTaskId) || isRegisteredInferenceSource(articleProjectId, sourceTaskId);
    },
    hasInferenceReservation(sourceTaskId: string) {
      return inferenceRuns.has(sourceTaskId);
    },
    async recordInference(type: "TASK_DONE" | "TASK_FAILED", sourceTaskId: string, value: string) {
      if (!(inferenceRuns.has(sourceTaskId) || isRegisteredInferenceSource(articleProjectId, sourceTaskId))) return;
      const pathname = type === "TASK_DONE" ? "/v1/inference/results" : "/v1/inference/failures";
      await intakeRequest(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceTaskId, text: type === "TASK_DONE" ? value : undefined, resultSha256: type === "TASK_DONE" ? sha256(value) : undefined, errorSha256: type === "TASK_FAILED" ? sha256(value) : undefined }) });
      inferenceRuns.delete(sourceTaskId);
    },
    async confirmCurrentArtifact(input: { artifactId: string; version: number; adjudicationReason?: string;
      expectedReviewId?: string; expectedReviewFullOutputSha256?: string; expectedCandidateSha256?: string;
      expectedTaskId?: string; expectedExecutionId?: string;
      authorizationSourceThreadId?: string; authorizationText?: string }) {
      const value = await projection();
      if (!value.artifact || value.artifact.id !== input.artifactId || value.artifact.version !== input.version) throw new Error("Irixi candidate version is stale");
      const adjudicating = typeof input.adjudicationReason === "string";
      if (adjudicating && (value.artifact.review?.passed !== false || value.artifact.review.id !== input.expectedReviewId
        || value.artifact.review.fullOutputSha256 !== input.expectedReviewFullOutputSha256
        || value.artifact.candidateSha256 !== input.expectedCandidateSha256
        || value.taskId !== input.expectedTaskId || value.execution?.id !== input.expectedExecutionId
        || !input.authorizationSourceThreadId || !input.authorizationText)) throw new Error("Irixi review adjudication is stale");
      const registry = loadProductProjectRegistry();
      const response = await fetch(new URL("/v1/confirm", endpoint), {
        method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId: input.artifactId, version: input.version,
          ...(registry ? { expectedGoalVersionId: value.goalVersionId, expectedRegistrySha256: productRegistrySha256(registry) } : {}),
          ...(adjudicating ? { adjudicationReason: input.adjudicationReason,
            expectedReviewId: input.expectedReviewId, expectedReviewFullOutputSha256: input.expectedReviewFullOutputSha256,
            expectedCandidateSha256: input.expectedCandidateSha256,
            expectedTaskId: input.expectedTaskId, expectedExecutionId: input.expectedExecutionId,
            authorizationSourceThreadId: input.authorizationSourceThreadId, authorizationText: input.authorizationText } : {}) }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Irixi confirmation failed");
      return body;
    },
    async downloadCurrentPatch(artifactId: string, approvalId: string) {
      const value = await projection();
      if (!value.artifact || value.artifact.id !== artifactId || value.artifact.confirmation?.approvalId !== approvalId) throw new Error("Irixi approved patch is stale");
      const response = await fetch(new URL(`/v1/patch?artifactId=${encodeURIComponent(artifactId)}&approvalId=${encodeURIComponent(approvalId)}`, endpoint), { signal: AbortSignal.timeout(3_000) });
      if (!response.ok) throw new Error(`Irixi patch download failed (${response.status})`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { bytes, contentType: response.headers.get("content-type") || "text/x-diff; charset=utf-8", contentDisposition: response.headers.get("content-disposition") || "attachment; filename=irixi.patch", sha256: response.headers.get("x-content-sha256") || "" };
    },
    async authorizeStaticPreview(filePath: string | {
      taskId: string; goalVersionId: string; executionId: string; registrySha256: string; artifactId: string;
      artifactVersion: number; candidateSha256: string; token: string; entry: string; file: string;
      root?: string; entryAbsolute?: string;
    }) {
      const workspace = process.env.OPEN_OFFICE_IRIXI_EXECUTION_WORKSPACE?.trim();
      const productRegistry = loadProductProjectRegistry();
      const registeredWorkspace = productRegistry?.workspace.path || workspace;
      if ((!productRegistry && articleProjectId !== "article-learning-12") || !registeredWorkspace) throw new Error("Static preview is not registered");
      const value = await projection();
      let authorized: any = null;
      if (productRegistry) {
        if (!filePath || typeof filePath !== "object") throw new Error("Product preview requires a candidate-bound request");
        const request = filePath;
        assertProductProjection(productRegistry, value);
        if (request.taskId !== value.taskId || request.goalVersionId !== value.goalVersionId
          || request.executionId !== value.execution?.id || request.registrySha256 !== productRegistrySha256(productRegistry)
          || request.artifactId !== value.artifact?.id || request.artifactVersion !== value.artifact?.version
          || request.candidateSha256 !== value.artifact?.candidateSha256
          || !productRegistry.capabilities.staticPreviewEntries.includes(request.entry)
          || (!productRegistry.capabilities.staticPreviewFiles.includes(request.file)
            && !isNoobiBuiltPreviewAsset(productRegistry.projectId, request.file))) {
          throw new Error("Product preview binding is stale or outside registered files");
        }
        const response = await fetch(new URL("/v1/product-preview-authorize", endpoint), { method: "POST", signal: AbortSignal.timeout(3_000),
          headers: { "content-type": "application/json" }, body: JSON.stringify({ entry: request.entry, file: request.file,
            expectedGoalVersionId: request.goalVersionId, expectedExecutionId: request.executionId,
            expectedRegistrySha256: request.registrySha256, expectedArtifactId: request.artifactId,
            expectedArtifactVersion: request.artifactVersion, expectedCandidateSha256: request.candidateSha256 }) });
        authorized = await response.json();
        if (!response.ok) throw new Error(typeof authorized?.error === "string" ? authorized.error : "Product preview authorization failed");
        assertNativeWorkspace(productRegistry.workspace.path, authorized.root, true);
        const absoluteEntry = path.resolve(authorized.entry);
        const absoluteFile = path.resolve(authorized.file);
        if (!absoluteEntry.startsWith(`${path.resolve(authorized.root)}${path.sep}`)
          || !absoluteFile.startsWith(`${path.resolve(authorized.root)}${path.sep}`)
          || authorized.taskId !== request.taskId || authorized.goalVersionId !== request.goalVersionId
          || authorized.executionId !== request.executionId || authorized.registrySha256 !== request.registrySha256
          || authorized.artifactId !== request.artifactId || authorized.artifactVersion !== request.artifactVersion
          || authorized.candidateSha256 !== request.candidateSha256
          || (request.root && request.root !== authorized.root)
          || (request.entryAbsolute && request.entryAbsolute !== absoluteEntry)) throw new Error("Product preview authorization changed during verification");
        return { ...authorized, root: path.resolve(authorized.root), entry: absoluteEntry, file: absoluteFile };
      } else {
        if (typeof filePath !== "string") throw new Error("Legacy preview path is invalid");
        const legacyFilePath = filePath;
        if (!path.isAbsolute(legacyFilePath)) throw new Error("Static preview entry must be absolute");
        const absolute = path.resolve(legacyFilePath);
        if (!absolute.startsWith(`${path.resolve(registeredWorkspace)}${path.sep}`)) throw new Error("Preview entry is outside the registered workspace");
        const stat = lstatSync(absolute);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(absolute) !== absolute) throw new Error("Preview entry is invalid");
        const entryFile = path.relative(path.resolve(registeredWorkspace), absolute).split(path.sep).join("/");
        authorized = await intakeRequest("/v1/preview/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entryFile }) });
        if (!value.artifact?.candidateSha256 || !value.artifact.confirmation || value.artifact.confirmation.goalVersionId !== value.goalVersionId) {
          throw new Error("Only the current confirmed candidate may be previewed");
        }
        if (authorized.candidateSha256 !== value.artifact.candidateSha256) throw new Error("Preview authorization changed during verification");
        return { root: registeredWorkspace, entry: absolute, candidateSha256: value.artifact.candidateSha256 };
      }
    },
    async authorizeIntake(sourceTaskId: string, prompt: string) {
      if (!intakeTaskId || !/^[A-Za-z0-9_-]{1,160}$/.test(sourceTaskId)
        || !prompt.startsWith(`${PROJECT_INTAKE_TAG}\n`) || Buffer.byteLength(prompt) > 16_000) {
        throw new Error("Project intake request is not the registered read-only discussion prompt");
      }
      const promptSha256 = sha256(prompt);
      await intakeRequest("/v1/intake/reservations", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceTaskId, promptSha256 }),
      });
      intakeRuns.set(sourceTaskId, promptSha256);
    },
    isIntakeTask(sourceTaskId: string) { return intakeRuns.has(sourceTaskId); },
    async recordIntake(type: "TASK_DONE" | "TASK_FAILED", sourceTaskId: string, value: string) {
      if (!intakeRuns.has(sourceTaskId)) return;
      const pathname = type === "TASK_DONE" ? "/v1/intake/replies" : "/v1/intake/failures";
      const body = type === "TASK_DONE"
        ? { sourceTaskId, text: value, resultSha256: sha256(value) }
        : { sourceTaskId, errorSha256: sha256(value) };
      await intakeRequest(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      intakeRuns.delete(sourceTaskId);
    },
    async authorize(sourceTaskId: string, actor: "developer" | "reviewer", prompt?: string, actualDiff?: string, repoPath?: string) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(sourceTaskId)) throw new Error("OpenOffice source task ID is invalid");
      const projectProgress = projectProgressRuns.get(sourceTaskId);
      if (projectProgress) {
        const value = await projection();
        const productRegistry = loadProductProjectRegistry();
        if (!productRegistry || productRegistry.projectId !== "project-progress-assistant" || actor !== "reviewer"
          || !String(prompt || "").includes(projectProgress.prompt)) throw new Error("Project progress conversation is not its exact reserved read-only Lead update");
        assertProductProjection(productRegistry, value);
        assertProductWorkspace(productRegistry, repoPath || productRegistry.workspace.path);
        const current = binding(value, sourceTaskId);
        taskBindings.set(sourceTaskId, current); taskActors.set(sourceTaskId, "lead");
        return current;
      }
      const productRegistry = loadProductProjectRegistry();
      const productLearningInference = Boolean(productRegistry && inferenceRuns.has(sourceTaskId));
      const productConversation = Boolean(productRegistry && (sourceTaskId.startsWith("product-conversation-") || productLearningInference));
      if (actor === "developer" && !productRegistry && ![INTEGRATED_DEVELOPER_TAG, ARTICLE_DEVELOPER_TAG].some((tag) => String(prompt || "").includes(tag))) {
        throw new Error("Integrated developer prompt tag is missing");
      }
      const value = await projection();
      if (productRegistry) {
        assertProductProjection(productRegistry, value);
        assertProductWorkspace(productRegistry, repoPath || productRegistry.workspace.path);
      }
      if (productLearningInference) {
        if (actor !== "reviewer" || !String(prompt || "").includes("IRIXI_PRODUCT_CONVERSATION_V1")) {
          throw new Error("Learning inference must use the registered read-only conversation phase");
        }
        const current = binding(value, sourceTaskId);
        taskBindings.set(sourceTaskId, current);
        taskActors.set(sourceTaskId, "lead");
        return current;
      }
      if (!value.execution?.id) throw new Error("Irixi has no explicit current execution for this task");
      if (actor === "developer" && (!value.registeredExecution
        || value.registeredExecution.goalVersionId !== value.goalVersionId
        || typeof prompt !== "string"
        || sha256(prompt) !== value.registeredExecution.promptSha256
        || prompt !== value.registeredExecution.prompt)) {
        throw new Error("Integrated developer prompt is not the accepted execution request");
      }
      if (actor === "reviewer" && !productConversation) {
        if (!value.artifact?.id || !value.artifact.candidateSha256 || !value.artifact.diffSha256 || !value.artifact.patchSha256) {
          throw new Error("Irixi has no current host-verified candidate for review");
        }
        if (typeof actualDiff !== "string" || !actualDiff || sha256(actualDiff) !== value.artifact.diffSha256) {
          throw new Error("The native review diff is not the current Irixi candidate diff");
        }
        if (articleProjectId === "article-learning-12" && (!value.confirmedContract || value.confirmedContract.goalVersionId !== value.goalVersionId || !value.confirmedContract.statement
          || !value.confirmedContract.successCriteria?.length || !value.confirmedContract.boundaries?.length)) throw new Error("Irixi confirmed review contract is unavailable");
      }
      const current = binding(value, sourceTaskId);
      const reserved = await fetch(new URL("/v1/reservations", endpoint), {
        method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ actor, sourceTaskId, binding: current,
          promptSha256: actor === "developer" ? value.registeredExecution?.promptSha256 : null,
          productRegistrySha256: productRegistry ? productRegistrySha256(productRegistry) : null }),
      });
      if (!reserved.ok) throw new Error(`Irixi rejected the ${actor} run reservation (${reserved.status})`);
      taskBindings.set(sourceTaskId, current);
      taskActors.set(sourceTaskId, actor);
      if (actor === "reviewer" && value.confirmedContract) reviewContracts.set(sourceTaskId, structuredClone(value.confirmedContract));
      return current;
    },
    async authorizeNativeCall(context: {
      attemptId: string; taskId: string; agentId: string; role: string; backend: string; model?: string;
      workspace: string; prompt: string; promptSha256: string; teamId?: string; phase?: string; isTeamLead: boolean;
      readOnly: boolean;
      promptBudget?: { modelId: string; contextWindowTokens: number; effectiveContextPercent: number; effectiveContextTokens: number; outputReserveTokens: number; protocolReserveTokens: number; availablePromptTokens: number; promptUtf8Bytes: number; promptTokenUpperBound: number; estimator: "utf8_bytes_upper_bound" };
    }) {
      const registry = loadProductProjectRegistry();
      if (!registry) return;
      const value = await projection();
      assertProductProjection(registry, value);
      assertNativeWorkspace(registry.workspace.path, context.workspace, context.readOnly);
      const inference = inferenceRuns.get(context.taskId);
      const projectProgress = projectProgressRuns.get(context.taskId);
      if (projectProgress && (context.phase !== "conversation" || context.isTeamLead !== true || context.readOnly !== true
        || context.role !== "Lead" || context.backend !== registry.native.backend || context.model !== registry.native.model
        || !context.prompt.includes("IRIXI_PROJECT_PROGRESS_ASSISTANT_V1\n")
        || !context.prompt.includes(projectProgress.prompt) || !context.promptBudget)) {
        throw new Error("Project progress update did not enter its reserved read-only Lead conversation");
      }
      if (inference) {
        if (!inference || !inference.prompt.startsWith(`${ARTICLE_INFERENCE_TAG}\n`)
          || !context.prompt.includes(inference.prompt)
          || context.phase !== "conversation" || context.isTeamLead !== true || context.readOnly !== true
          || context.role !== "Lead" || context.backend !== registry.native.backend || context.model !== registry.native.model
          || !value.execution?.id || !context.promptBudget) {
          throw new Error("Learning inference did not enter the registered read-only Lead conversation with its exact prompt");
        }
        await prepareNativeSourceBaseline(registry, context.workspace, true, value.execution.id);
        const admission = await intakeRequest("/v1/inference/native-calls", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({
            sourceTaskId: context.taskId, expectedGoalVersionId: value.goalVersionId,
            expectedCandidateSha256: value.artifact?.candidateSha256,
            expectedExecutionId: value.execution.id,
            nativeTaskId: context.taskId,
            reservationPromptSha256: inference.promptSha256,
            productRegistrySha256: productRegistrySha256(registry),
            attemptId: context.attemptId, agentId: context.agentId, role: context.role,
            backend: context.backend, model: context.model, phase: context.phase,
            isTeamLead: context.isTeamLead, readOnly: context.readOnly,
            workspace: registry.workspace.path, nativeWorkspace: realpathSync(context.workspace),
            promptSha256: context.promptSha256, promptBudget: context.promptBudget,
          }),
        }) as { authorized?: boolean; deadlineAt?: string };
        const deadline = Date.parse(admission.deadlineAt || "");
        if (!admission.authorized || !Number.isFinite(deadline) || deadline <= Date.now()) {
          throw new Error("Irixi did not authorize the current learning batch deadline");
        }
        return { timeoutMs: Math.max(1, deadline - Date.now()) };
      }
      if (!value.execution?.id) throw new Error("Irixi product execution is unavailable");
      const isConversation = context.phase === "conversation";
      const isReview = !isConversation && (context.phase === "review" || context.role.toLowerCase().includes("review"));
      const registeredReview = productReviewTasks.get(context.taskId);
      const canonicalContextReviewRole = registeredReview ? canonicalReviewerRole(context.role) : null;
      if (isReview && registry && (!registeredReview || registeredReview.prompt !== context.prompt
        || registeredReview.promptSha256 !== context.promptSha256 || registeredReview.agentId !== context.agentId
        || registeredReview.role !== canonicalContextReviewRole || context.phase !== "review" || context.isTeamLead
        || !context.readOnly || context.backend !== registry.native.backend || context.model !== registry.native.model
        || registeredReview.goalVersionId !== value.goalVersionId || registeredReview.executionId !== value.execution?.id
        || registeredReview.registrySha256 !== productRegistrySha256(registry)
        || registeredReview.artifactId !== value.artifact?.id || registeredReview.artifactVersion !== value.artifact?.version
        || registeredReview.candidateSha256 !== value.artifact?.candidateSha256)) {
        throw new Error("Native Reviewer call no longer matches its exact Authority-issued dispatch");
      }
      const roundMatch = context.prompt.match(/^IRIXI_REVIEW_ROUND_ID: ([A-Za-z0-9_-]{1,160})$/m);
      const reviewRoundId = roundMatch?.[1] || null;
      if (isReview) {
        const candidateSha256 = value.artifact?.candidateSha256;
        if (!candidateSha256 || !context.prompt.includes("IRIXI_PRODUCT_REVIEW_V1\n")
          || !context.prompt.includes(`Goal: ${value.goalStatement}`)
          || !context.prompt.includes(`Candidate SHA-256: ${candidateSha256}`)
          || !context.prompt.includes("Success criteria:\n") || !context.prompt.includes("Boundaries:\n")
          || !context.prompt.includes("Complete candidate file contents:\n") || !context.prompt.includes("Patch:\n")) {
          throw new Error("Registered Reviewer input is missing the current goal or complete candidate");
        }
      } else {
        const registered = value.registeredExecution;
        if (!projectProgress && (!registered || registered.goalVersionId !== value.goalVersionId
          || sha256(registered.prompt) !== registered.promptSha256
          || !context.prompt.includes(registered.prompt))) {
          throw new Error("Native product role input omitted the exact current registered execution request");
        }
        if (!isConversation && (!context.isTeamLead || context.phase === "execute")) {
          const approvedBinding = [
            "IRIXI_APPROVED_PRODUCT_EXECUTION_V1",
            `TASK_ID: ${value.taskId}`,
            `GOAL_VERSION_ID: ${value.goalVersionId}`,
            `EXECUTION_ID: ${value.execution.id}`,
            `REGISTRY_SHA256: ${productRegistrySha256(registry)}`,
            `REGISTERED_PROMPT_SHA256: ${registered?.promptSha256 || ""}`,
          ].join("\n");
          if (!context.prompt.includes(approvedBinding)
            || !/APPROVED_PLAN_SHA256: [a-f0-9]{64}/.test(context.prompt)) {
            throw new Error("Native product execution role input is missing the current approved plan binding");
          }
        }
      }
      const preparedBaseline = await prepareNativeSourceBaseline(registry, context.workspace, context.readOnly, value.execution.id,
        (evidence) => authorizeProductWorktreeRebind(endpoint.toString(), evidence));
      const current = binding(value, context.taskId);
      const nativeActor = context.isTeamLead ? "lead" : context.role.toLowerCase().includes("review") ? "reviewer" : "developer";
      const nativeRun: NativeRun = { attemptId: context.attemptId, agentId: context.agentId, nativeWorkspace: realpathSync(context.workspace),
        binding: current, actor: nativeActor, phase: context.phase || null };
      // Keep the exact terminal context before admission: Authority may commit the reservation
      // and lose its HTTP response, leaving the child unspawned but still requiring settlement.
      pendingNativeRuns.set(context.attemptId, nativeRun);
      const sourceTaskId = `${context.taskId}-${context.attemptId}`;
      const response = await fetch(new URL("/v1/product-native-calls", endpoint), {
        method: "POST", signal: AbortSignal.timeout(PRODUCT_NATIVE_CALL_ADMISSION_TIMEOUT_MS), headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceTaskId, attemptId: context.attemptId, agentId: context.agentId,
          role: isReview && registeredReview ? registeredReview.role : context.role,
          backend: context.backend, model: context.model || registry.native.model,
          workspace: registry.workspace.path, nativeWorkspace: nativeRun.nativeWorkspace,
          baselineHead: preparedBaseline.baselineHead,
          worktreeRebindEventId: preparedBaseline.rebindEventId,
          promptSha256: context.promptSha256, teamId: context.teamId || null, phase: context.phase || null,
          isTeamLead: context.isTeamLead, readOnly: context.readOnly, promptBudget: context.promptBudget || null,
          ...(projectProgress ? { projectProgressReservationId: projectProgress.reservationId,
            projectProgressSourceTaskId: context.taskId, projectProgressPromptSha256: projectProgress.promptSha256 } : {}),
          ...(isReview && reviewRoundId ? { reviewRoundId } : {}),
          productRegistrySha256: productRegistrySha256(registry) }),
      });
      const admission = await response.json() as { reservation?: { detail?: { deadlineAt?: string; phase?: string | null } }; error?: string };
      if (!response.ok) throw new Error(typeof admission.error === "string" ? admission.error : `Irixi rejected native process admission (${response.status})`);
      taskBindings.set(context.taskId, current);
      taskActors.set(context.taskId, nativeActor);
      nativeRun.phase = typeof admission.reservation?.detail?.phase === "string" ? admission.reservation.detail.phase : null;
      nativeRuns.set(context.attemptId, nativeRun);
      pendingNativeRuns.delete(context.attemptId);
      const deadline = Date.parse(admission.reservation?.detail?.deadlineAt || "");
      if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("Irixi native process deadline is unavailable or expired");
      return { timeoutMs: Math.max(1, deadline - Date.now()) };
    },
    reviewerContext(binding: IrixiEventBinding) {
      const contract = reviewContracts.get(binding.sourceTaskId);
      return [
        articleProjectId === "article-learning-12" ? ARTICLE_REVIEWER_TAG : INTEGRATED_REVIEWER_TAG,
        ...(articleProjectId === "article-learning-12" ? [
          "IRIXI_PROJECT_ID: article-learning-12",
          `IRIXI_GOAL_VERSION_ID: ${binding.goalVersionId}`,
          `IRIXI_CANDIDATE_SHA256: ${binding.candidateSha256 || "missing"}`,
          ...(contract?.developmentBinding ? [
            `IRIXI_EXECUTION_ID: ${contract.developmentBinding.executionId}`,
            `IRIXI_DEVELOPMENT_BATCH: ${contract.developmentBinding.batchId}`,
            `IRIXI_REPAIR_OF_EXECUTION_ID: ${contract.developmentBinding.repairOfExecutionId}`,
            `IRIXI_PRIOR_LEDGER_SHA256: ${contract.developmentBinding.priorLedgerSha256}`,
            `IRIXI_SCOPE_FINGERPRINT: ${contract.developmentBinding.scopeFingerprint}`,
            `IRIXI_SOURCE_SNAPSHOT_SHA256: ${contract.developmentBinding.repairInputManifestSha256}`,
            ...(contract.developmentBinding.reviewOnly ? [`IRIXI_REVIEW_ONLY: true`] : []),
          ] : [`IRIXI_EXECUTION_ID: ${binding.executionId}`]),
          `Confirmed goal statement: ${contract?.statement || "missing"}`,
          `Confirmed success criteria:\n${(contract?.successCriteria || []).map((item) => `- ${item}`).join("\n")}`,
          `Confirmed boundaries:\n${(contract?.boundaries || []).map((item) => `- ${item}`).join("\n")}`,
          `Registered material declaration SHA-256: ${contract?.materialSha256 || "missing"}`,
          "Accepted assessment scope: cover the article's complete important concepts and require supported actual application AND transfer to an actually unseen scenario, as specified by the current confirmed criteria. A question-type label by itself is not evidence of that coverage or transfer. Do not invent a fixed requirement that every concept receive all four question types, or any fixed score or question count, unless explicitly required by the current confirmed criteria. Structural identity and anti-duplicate gates prevent relabeling but do not by themselves prove semantic mastery; actual-use acceptance remains a separate evidence step.",
        ] : []),
        `Irixi task ${binding.taskId}; goal ${binding.goalVersionId}; execution ${binding.executionId}.`,
        `Review only the current candidate ${binding.candidateSha256 || "missing"} and diff ${binding.diffSha256 || "missing"}.`,
        articleProjectId === "article-learning-12"
          ? "Review every file in the exact current static candidate and the complete bounded review input against the confirmed goal, success criteria, registered material hash, and authorized workspace boundary. A file existing, an animation, or browsing progress is not evidence that the learning outcomes pass. Prefix every blocking accepted-contract issue with CONTRACT: and every suggestion outside the confirmed boundary with OUT_OF_SCOPE:."
          : "The accepted contract covers string inputs and exactly the registered cases. Prefix every blocking accepted-contract issue with CONTRACT: and every suggestion outside that input/case/file boundary with OUT_OF_SCOPE:.",
        "A native VERDICT remains a factual review result. Do not rewrite FAIL as PASS; the host separately records whether findings are contract-blocking, outside-scope, or need a user decision.",
      ].join("\n");
    },
    bindingFor(sourceTaskId: string, attemptId?: string) { return (attemptId ? (nativeRuns.get(attemptId) || pendingNativeRuns.get(attemptId))?.binding : null) || taskBindings.get(sourceTaskId) || null; },
    actorFor(sourceTaskId: string, attemptId?: string) { return (attemptId ? (nativeRuns.get(attemptId) || pendingNativeRuns.get(attemptId))?.actor : null) || taskActors.get(sourceTaskId) || null; },
    inheritTaskBinding(parentSourceTaskId: string, childSourceTaskId: string) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(parentSourceTaskId) || !/^[A-Za-z0-9_-]{1,160}$/.test(childSourceTaskId)) return null;
      const parent = taskBindings.get(parentSourceTaskId);
      if (!parent || parent.taskId !== authorityTaskId) return null;
      const inherited = { ...parent, sourceTaskId: childSourceTaskId };
      taskBindings.set(childSourceTaskId, inherited);
      return inherited;
    },
    async record(type: string, actor: "lead" | "developer" | "reviewer" | "host" | "user", sourceTaskId: string, detail: Record<string, unknown> = {}) {
      const attemptId = typeof detail.nativeAttemptId === "string" ? detail.nativeAttemptId : null;
      const nativeRun = attemptId ? nativeRuns.get(attemptId) || pendingNativeRuns.get(attemptId) : undefined;
      const recoveredPendingRun = Boolean(attemptId && nativeRun && pendingNativeRuns.has(attemptId) && !nativeRuns.has(attemptId));
      const registeredReview = productReviewTasks.get(sourceTaskId);
      const prior = nativeRun?.binding || taskBindings.get(sourceTaskId);
      const terminal = type === "TASK_DONE" || type === "TASK_FAILED";
      const preparationFailure = Boolean(initialProductRegistry && type === "TASK_FAILED" && attemptId && !nativeRun
        && typeof detail.agentId === "string");
      if (!prior && !preparationFailure) {
        if (terminal) throw new Error("Irixi terminal event has no current native binding or persisted reservation");
        return;
      }
      let current: IrixiEventBinding;
      if (preparationFailure) {
        const eventBinding = asRecord(detail.eventBinding) as IrixiEventBinding | null;
        const exactBinding = prior || eventBinding;
        if (!exactBinding || exactBinding.sourceTaskId !== sourceTaskId || exactBinding.taskId !== authorityTaskId) {
          throw new Error("Unreserved product failure has no exact preparation-time Authority binding");
        }
        const currentRegistry = registeredReview ? loadProductProjectRegistry() : null;
        if (registeredReview && (!currentRegistry || actor !== "reviewer" || detail.agentId !== registeredReview.agentId
          || registeredReview.sourceTaskId !== sourceTaskId
          || registeredReview.registrySha256 !== productRegistrySha256(currentRegistry)
          || exactBinding.goalVersionId !== registeredReview.goalVersionId
          || exactBinding.executionId !== registeredReview.executionId
          || exactBinding.artifactId !== registeredReview.artifactId
          || exactBinding.artifactVersion !== registeredReview.artifactVersion
          || exactBinding.candidateSha256 !== registeredReview.candidateSha256)) {
          throw new Error("Registered Reviewer preparation failure no longer matches its Authority-issued dispatch");
        }
        const value = await projection();
        const projected = binding(value, sourceTaskId);
        const stable = ["taskId", "goalVersionId", "taskInputBindingSha256", "pipelineBindingSha256", "executionId", "workspaceScopeFingerprint", "sourceSnapshotSha256"] as const;
        if (stable.some((key) => exactBinding[key] !== projected[key])) throw new Error("Preparation-time Authority binding is stale");
        if (registeredReview && (value.productRegistry?.registrySha256 !== registeredReview.registrySha256
          || projected.artifactId !== registeredReview.artifactId || projected.artifactVersion !== registeredReview.artifactVersion
          || projected.candidateSha256 !== registeredReview.candidateSha256
          || (value.artifact?.review?.id || null) !== registeredReview.expectedReviewId)) {
          throw new Error("Registered Reviewer preparation failure candidate or registry changed");
        }
        current = exactBinding;
      } else if (!(terminal && nativeRun)) {
        const value = await projection();
        const projected = binding(value, sourceTaskId);
        const stable = ["taskId", "goalVersionId", "taskInputBindingSha256", "pipelineBindingSha256", "executionId", "workspaceScopeFingerprint", "sourceSnapshotSha256"] as const;
        if (prior && stable.some((key) => prior[key] !== projected[key])) throw new Error("Irixi authority changed during the OpenOffice task");
        current = projected;
        taskBindings.set(sourceTaskId, current);
      } else current = prior!;
      const resultText = typeof detail.resultText === "string" ? detail.resultText : null;
      if (type === "TASK_DONE" && resultText && (actor === "reviewer" || nativeRun?.phase === "conversation")
        && Buffer.byteLength(resultText, "utf8") > 40_000) {
        throw new Error("Reviewer or conversation output exceeds the complete terminal transport limit");
      }
      const reviewPreparationBinding = registeredReview ? {
        phase: "review", reviewDispatchEventId: registeredReview.dispatchEventId,
        reviewRegistrySha256: registeredReview.registrySha256, reviewPromptSha256: registeredReview.promptSha256,
        reviewArtifactId: registeredReview.artifactId, reviewArtifactVersion: registeredReview.artifactVersion,
        reviewCandidateSha256: registeredReview.candidateSha256, expectedReviewId: registeredReview.expectedReviewId,
        reviewRoundId: registeredReview.reviewRoundId,
      } : {};
      const payload = {
        type, actor, sourceTaskId, binding: current,
        sourceEventId: preparationFailure
          ? `${typeof detail.sourceEventId === "string" ? detail.sourceEventId : `${sourceTaskId}:${type}`}:preparation`
          : typeof detail.sourceEventId === "string" ? detail.sourceEventId : `${sourceTaskId}:${type}`,
        scopeOutcome: preparationFailure ? null : detail.scopeOutcome || null,
        resultSha256: resultText ? sha256(resultText) : detail.resultSha256 || null,
        ...(preparationFailure ? { preparationFailure: true, nativeAttemptId: attemptId, agentId: detail.agentId } : {}),
        ...(preparationFailure ? { nativeWorkspace: null } : {}),
        ...(preparationFailure ? reviewPreparationBinding : {}),
        ...(type === "TASK_DONE" && typeof detail.isFinalResult === "boolean" ? { isFinalResult: detail.isFinalResult } : {}),
        ...(type === "TASK_FAILED" && typeof detail.error === "string" ? { error: detail.error } : {}),
        ...(actor === "reviewer" && type === "TASK_DONE" && resultText ? { reviewText: resultText } : {}),
        ...(type === "TASK_DONE" && resultText && nativeRun?.phase === "conversation" ? { conversationText: resultText } : {}),
        ...(actor === "lead" && type === "TASK_DONE" && resultText && nativeRun?.phase === "create" ? { leadPlanText: resultText } : {}),
        ...(actor === "lead" && type === "TASK_DONE" && resultText && nativeRun?.phase === "execute" ? { leadResultText: resultText } : {}),
        checkId: detail.checkId || null,
        changedFiles: Array.isArray(detail.changedFiles) ? detail.changedFiles : null,
        entryFile: typeof detail.entryFile === "string" ? detail.entryFile : null,
        caseTotal: detail.caseTotal ?? null,
        casePassed: detail.casePassed ?? null,
        ...(nativeRun ? {
          nativeAttemptId: nativeRun.attemptId,
          agentId: nativeRun.agentId,
          nativeWorkspace: nativeRun.nativeWorkspace,
        } : {}),
      };
      const observationUrl = new URL("/v1/observations", endpoint);
      const sendObservation = (body: Record<string, unknown>) => fetch(observationUrl, {
        method: "POST", signal: AbortSignal.timeout(terminal ? 8_000 : 3_000),
        headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
      let receiptPayload = payload;
      let response = await sendObservation(payload);
      if (!response.ok) {
        const rejection = await response.text();
        if (recoveredPendingRun && type === "TASK_FAILED" && response.status === 409
          && rejection.includes("Product terminal event has no matching native process reservation")) {
          const { nativeAttemptId: _attempt, agentId: _agent, nativeWorkspace: _workspace, ...unreservedPayload } = payload;
          receiptPayload = {
            ...unreservedPayload,
            ...reviewPreparationBinding,
            sourceEventId: `${payload.sourceEventId}:preparation`,
            scopeOutcome: null,
            resultSha256: null,
            preparationFailure: true,
            nativeAttemptId: attemptId,
            agentId: nativeRun!.agentId,
          };
          response = await sendObservation(receiptPayload);
        } else {
          throw new Error(`Irixi observation was rejected (${response.status})${rejection ? `: ${rejection.slice(0, 240)}` : ""}`);
        }
      }
      const recorded = await response.json();
      if (!response.ok) {
        const rejection = JSON.stringify(recorded).slice(0, 240);
        throw new Error(`Irixi observation was rejected (${response.status})${rejection ? `: ${rejection}` : ""}`);
      }
      if (terminal && !integratedTerminalReceiptMatches(recorded, receiptPayload)) {
        throw new Error("Irixi observation receipt does not match the exact terminal source, attempt, binding, and result hash");
      }
      if (terminal && attemptId) {
        nativeRuns.delete(attemptId);
        pendingNativeRuns.delete(attemptId);
        if (nativeRun?.phase === "conversation") projectProgressRuns.delete(sourceTaskId);
      }
      return recorded;
    },
  };
}
