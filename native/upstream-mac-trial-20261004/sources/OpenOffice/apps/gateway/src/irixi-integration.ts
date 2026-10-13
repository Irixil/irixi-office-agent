import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { GatewayEvent } from "@office/shared";
import {
  assertProductProjection,
  assertProductWorkspace,
  loadProductProjectRegistry,
  productProjectionMatches,
  productRegistrySha256,
} from "./product-project-registry.js";

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
    review?: { id: string; passed: boolean; nativeVerdict: string | null; scopeOutcome: string | null } | null;
    confirmation?: { approvalId: string; artifactVersion: number; goalVersionId: string } | null;
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
  const endpoint = new URL(rawUrl);
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.port !== "3869" || endpoint.pathname !== "/") {
    throw new Error("Irixi authority must use the fixed loopback endpoint http://127.0.0.1:3869/");
  }
  const taskBindings = new Map<string, IrixiEventBinding>();
  const taskActors = new Map<string, "lead" | "developer" | "reviewer">();
  const reviewContracts = new Map<string, NonNullable<Projection["confirmedContract"]>>();
  const intakeRuns = new Map<string, string>();
  const inferenceRuns = new Map<string, { prompt: string; promptSha256: string }>();
  type NativeRun = { attemptId: string; agentId: string; nativeWorkspace: string; binding: IrixiEventBinding; actor: "lead" | "developer" | "reviewer"; phase: string | null };
  const pendingNativeRuns = new Map<string, NativeRun>();
  const nativeRuns = new Map<string, NativeRun>();

  async function intakeRequest(pathname: string, init: RequestInit = {}) {
    if (!intakeTaskId) throw new Error("Irixi project intake is not enabled");
    const response = await fetch(new URL(pathname, endpoint), { signal: AbortSignal.timeout(3_000), ...init });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(typeof value?.error === "string" ? value.error : `Irixi intake rejected request (${response.status})`), { status: response.status });
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
        signal: AbortSignal.timeout(3_000), headers,
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
        || typeof value.agentId !== "string" || typeof value.planText !== "string"
        || !value.planText.startsWith("[PLAN]\n") || !value.planText.trimEnd().endsWith("[/PLAN]")
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
    async productReviewRequest(input: { expectedGoalVersionId: string; expectedExecutionId: string; expectedRegistrySha256: string; expectedArtifactId: string; expectedArtifactVersion: number }) {
      const response = await fetch(new URL("/v1/product-review-request", endpoint), { method: "POST", signal: AbortSignal.timeout(8_000), headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
      const value = await response.json();
      if (!response.ok || typeof value?.prompt !== "string" || sha256(value.prompt) !== value.promptSha256) {
        throw new Error(typeof value?.error === "string" ? value.error : "Irixi rejected the product review request");
      }
      return value as { taskId: string; artifactId: string; artifactVersion: number; candidateSha256: string; prompt: string; promptSha256: string };
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
    async recordInference(type: "TASK_DONE" | "TASK_FAILED", sourceTaskId: string, value: string) {
      if (!(inferenceRuns.has(sourceTaskId) || isRegisteredInferenceSource(articleProjectId, sourceTaskId))) return;
      const pathname = type === "TASK_DONE" ? "/v1/inference/results" : "/v1/inference/failures";
      await intakeRequest(pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceTaskId, text: type === "TASK_DONE" ? value : undefined, resultSha256: type === "TASK_DONE" ? sha256(value) : undefined, errorSha256: type === "TASK_FAILED" ? sha256(value) : undefined }) });
      inferenceRuns.delete(sourceTaskId);
    },
    async confirmCurrentArtifact(artifactId: string, version: number) {
      const value = await projection();
      if (!value.artifact || value.artifact.id !== artifactId || value.artifact.version !== version) throw new Error("Irixi candidate version is stale");
      const registry = loadProductProjectRegistry();
      const response = await fetch(new URL("/v1/confirm", endpoint), {
        method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ artifactId, version,
          ...(registry ? { expectedGoalVersionId: value.goalVersionId, expectedRegistrySha256: productRegistrySha256(registry) } : {}) }),
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
          || !productRegistry.capabilities.staticPreviewFiles.includes(request.file)) {
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
        if (!registered || registered.goalVersionId !== value.goalVersionId
          || sha256(registered.prompt) !== registered.promptSha256
          || !context.prompt.includes(registered.prompt)) {
          throw new Error("Native product role input omitted the exact current registered execution request");
        }
        if (!isConversation && (!context.isTeamLead || context.phase === "execute")) {
          const approvedBinding = [
            "IRIXI_APPROVED_PRODUCT_EXECUTION_V1",
            `TASK_ID: ${value.taskId}`,
            `GOAL_VERSION_ID: ${value.goalVersionId}`,
            `EXECUTION_ID: ${value.execution.id}`,
            `REGISTRY_SHA256: ${productRegistrySha256(registry)}`,
            `REGISTERED_PROMPT_SHA256: ${registered.promptSha256}`,
          ].join("\n");
          if (!context.prompt.includes(approvedBinding)
            || !/APPROVED_PLAN_SHA256: [a-f0-9]{64}/.test(context.prompt)) {
            throw new Error("Native product execution role input is missing the current approved plan binding");
          }
        }
      }
      const preparedBaseline = await prepareNativeSourceBaseline(registry, context.workspace, context.readOnly, value.execution.id, async (evidence) => {
        const response = await fetch(new URL("/v1/product-worktree-rebind", endpoint), {
          method: "POST", signal: AbortSignal.timeout(3_000),
          headers: { "content-type": "application/json" }, body: JSON.stringify(evidence),
        });
        const result = await response.json() as { authorized?: boolean; eventId?: string; error?: string };
        if (!response.ok || result.authorized !== true || typeof result.eventId !== "string" || !result.eventId) {
          throw new Error(typeof result.error === "string" ? result.error : "Irixi rejected managed worktree continuation");
        }
        return { authorized: true, eventId: result.eventId };
      });
      const current = binding(value, context.taskId);
      const nativeActor = context.isTeamLead ? "lead" : context.role.toLowerCase().includes("review") ? "reviewer" : "developer";
      const nativeRun: NativeRun = { attemptId: context.attemptId, agentId: context.agentId, nativeWorkspace: realpathSync(context.workspace),
        binding: current, actor: nativeActor, phase: context.phase || null };
      // Keep the exact terminal context before admission: Authority may commit the reservation
      // and lose its HTTP response, leaving the child unspawned but still requiring settlement.
      pendingNativeRuns.set(context.attemptId, nativeRun);
      const sourceTaskId = `${context.taskId}-${context.attemptId}`;
      const response = await fetch(new URL("/v1/product-native-calls", endpoint), {
        method: "POST", signal: AbortSignal.timeout(3_000), headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceTaskId, attemptId: context.attemptId, agentId: context.agentId, role: context.role,
          backend: context.backend, model: context.model || registry.native.model,
          workspace: registry.workspace.path, nativeWorkspace: nativeRun.nativeWorkspace,
          baselineHead: preparedBaseline.baselineHead,
          worktreeRebindEventId: preparedBaseline.rebindEventId,
          promptSha256: context.promptSha256, teamId: context.teamId || null, phase: context.phase || null,
          isTeamLead: context.isTeamLead, readOnly: context.readOnly, promptBudget: context.promptBudget || null,
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
        const value = await projection();
        const projected = binding(value, sourceTaskId);
        const stable = ["taskId", "goalVersionId", "taskInputBindingSha256", "pipelineBindingSha256", "executionId", "workspaceScopeFingerprint", "sourceSnapshotSha256"] as const;
        if (stable.some((key) => exactBinding[key] !== projected[key])) throw new Error("Preparation-time Authority binding is stale");
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
      const payload = {
        type, actor, sourceTaskId, binding: current,
        sourceEventId: preparationFailure
          ? `${typeof detail.sourceEventId === "string" ? detail.sourceEventId : `${sourceTaskId}:${type}`}:preparation`
          : typeof detail.sourceEventId === "string" ? detail.sourceEventId : `${sourceTaskId}:${type}`,
        scopeOutcome: preparationFailure ? null : detail.scopeOutcome || null,
        resultSha256: resultText ? sha256(resultText) : detail.resultSha256 || null,
        ...(preparationFailure ? { preparationFailure: true, nativeAttemptId: attemptId, agentId: detail.agentId } : {}),
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
      }
      return recorded;
    },
  };
}
