import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ARTICLE_INFERENCE_TAG, authorizeProductWorktreeRebind, buildProductApprovedExecutionPrompt, createIrixiIntegration, INTEGRATED_DEVELOPER_TAG, integratedAutoReviewTransition, integratedTerminalReceiptMatches, isRegisteredInferenceSource, persistInferenceStartFailureBeforePublish, persistIntegratedTerminalBeforePublish, persistIntakeTerminalBeforePublish, prepareNativeSourceBaseline, PROJECT_INTAKE_TAG } from "./irixi-integration.js";
import { productRegistrySha256 } from "./product-project-registry.js";

test("unwraps automatic review only from the real observation response envelope", () => {
  const autoReview = { dispatchEventId: "dispatch-1", executionId: "run-1", candidateSha256: "a".repeat(64), sourceTaskId: "developer-1", changedFiles: ["index.html"], entryFile: "index.html" };
  assert.deepEqual(integratedAutoReviewTransition({ observation: { transition: { autoReview } } }), autoReview);
  assert.deepEqual(integratedAutoReviewTransition({ transition: { autoReview } }), autoReview);
  assert.equal(integratedAutoReviewTransition({ observation: {} }), null);
});

test("recognizes only a registered article learning UUID after volatile run-map loss", () => {
  assert.equal(isRegisteredInferenceSource("article-learning-12", "learning-ced26fdc-bc0c-4011-9e59-8abebae46f68"), true);
  assert.equal(isRegisteredInferenceSource("article-learning-12", "learning-arbitrary"), false);
  assert.equal(isRegisteredInferenceSource("another-project", "learning-ced26fdc-bc0c-4011-9e59-8abebae46f68"), false);
});

test("approved product execution prompt carries the exact registered request, bindings, and plan", () => {
  const executionPrompt = "IRIXI_NATIVE_PRODUCT_EXECUTION_V1\nGoal: current goal\n\nSuccess criteria:\n- full coverage\n\nBoundaries:\n- six registered files";
  const plan = "Approved plan body with the complete task flow.";
  const context = {
    taskId: "task-current", goalVersionId: "goal-current", executionId: "run-current",
    registrySha256: H("a"), planSha256: digest(plan), executionPrompt,
    executionPromptSha256: digest(executionPrompt),
  };
  const prompt = buildProductApprovedExecutionPrompt(context, plan);
  assert.ok(prompt.startsWith(executionPrompt));
  assert.ok(prompt.includes("IRIXI_APPROVED_PRODUCT_EXECUTION_V1\nTASK_ID: task-current\nGOAL_VERSION_ID: goal-current\nEXECUTION_ID: run-current"));
  assert.ok(prompt.includes(`REGISTRY_SHA256: ${context.registrySha256}`));
  assert.ok(prompt.includes(`APPROVED_PLAN_SHA256: ${context.planSha256}`));
  assert.ok(prompt.includes(`Exact user-approved Lead plan:\n${plan}`));
  assert.ok(prompt.includes("The host has already admitted this current execution."));
  assert.ok(prompt.includes("historical round numbers do not create current run authority."));
  assert.ok(prompt.includes("The host manages registered fixed checks and static preview."));
  assert.ok(prompt.includes("roles registered and managed by the external OpenOffice Orchestrator, not Codex /root/... subagents."));
  assert.ok(prompt.includes("do not use send_message, list_agents, followup_task, or spawn_agent to find or create these roles."));
  assert.ok(prompt.includes("@Exact Registered Name: complete assignment; the OpenOffice DelegationRouter schedules that assignment."));
  assert.ok(prompt.includes("Do not claim an OpenOffice role is missing because Codex's internal agent list does not contain it."));
  assert.ok(prompt.includes("Executable @delegations to registered members and each complete assignment body must appear in the FINAL answer; commentary is not executable and must not be claimed as delegated work."));
  assert.ok(prompt.includes("Lead/coordination roles must not write code or invoke tools themselves."));
  assert.throws(() => buildProductApprovedExecutionPrompt(context, "different plan"), /approved plan digest is invalid/);
});

const H = (char: string) => char.repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

test("rebinds the same managed worktree only after Authority approves its current baseline and changed-file hashes", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-worktree-rebind-"));
  const previousOpenOfficeConfig = process.env.OPEN_OFFICE_CONFIG_DIR;
  process.env.OPEN_OFFICE_CONFIG_DIR = path.join(root, "openoffice-config");
  t.after(() => {
    if (previousOpenOfficeConfig === undefined) delete process.env.OPEN_OFFICE_CONFIG_DIR;
    else process.env.OPEN_OFFICE_CONFIG_DIR = previousOpenOfficeConfig;
    rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source");
  mkdirSync(source);
  const files = [
    { path: "app.js", body: "export const app = 1;\n" },
    { path: "index.html", body: "<main>ready</main>\n" },
  ];
  for (const file of files) writeFileSync(path.join(source, file.path), file.body, { mode: 0o644 });
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Rebind Test"); git("config", "user.email", "rebind-test@example.invalid");
  git("add", "--", ...files.map((file) => file.path)); git("commit", "-qm", "registered source");
  const sourceHead = git("rev-parse", "HEAD");
  const worktreeModuleSpecifier: string = "../../../packages/orchestrator/src/worktree.ts";
  const { createWorktree } = await import(worktreeModuleSpecifier);
  const worktree = createWorktree(source, "product-senior-developer", "Senior Developer");
  assert.ok(worktree);
  const sourceManifest = files.map(({ path: relative }) => {
    const bytes = readFileSync(path.join(source, relative));
    return { path: relative, bytes: bytes.length, sha256: digest(bytes.toString("utf8")), mode: lstatSync(path.join(source, relative)).mode & 0o777 };
  });
  const scopeFingerprint = H("a");
  const sourceSnapshotSha256 = digest(canonical({ sourceHead, sourceManifest }));
  const registry = {
    schemaVersion: 1, projectId: "article-learning-12", taskId: "task-rebind-test", goalVersionId: "goal-current",
    taskInputBindingSha256: H("b"), pipelineBindingSha256: H("c"), authorityUrl: "http://127.0.0.1:3869/",
    workspace: { path: source, scopeFingerprint, sourceSnapshotSha256, sourceHead, sourceManifest,
      allowedWritePaths: files.map((file) => file.path), checks: ["node-syntax-v1"] },
    native: { backend: "codex", model: "gpt-5.6-sol", allowedRoles: ["Lead", "Senior Developer", "Reviewer"], maxModelCalls: 8, maxDurationMs: 1_200_000,
      promptBudget: { contextWindowTokens: 272_000, effectiveContextPercent: 95, outputTokens: 24_576, protocolTokens: 8_192 } },
    capabilities: { team: true, worktree: true, staticPreviewEntries: [], staticPreviewFiles: [], autoMerge: false, manualMerge: false, commandPreview: false },
  } as any;
  const gitWorktree = (...args: string[]) => execFileSync("git", ["-C", worktree, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const gitDir = realpathSync(path.resolve(worktree, gitWorktree("rev-parse", "--git-dir")));
  const markerFile = path.join(gitDir, "irixi-product-source-baseline.json");
  writeFileSync(markerFile, `${JSON.stringify({ schemaVersion: 1, executionId: "run-prior", sourceHead,
    sourceSnapshotSha256, baselineHead: sourceHead })}\n`, { mode: 0o600 });
  for (const file of files) writeFileSync(path.join(worktree, file.path), `${file.body}// continued\n`);

  writeFileSync(path.join(worktree, "unregistered.txt"), "must not be rebound\n");
  await assert.rejects(() => prepareNativeSourceBaseline(registry, worktree, false, "run-current", async () => ({ authorized: true, eventId: "event-rebind-1" })), /untracked, deleted, renamed, or unauthorized/);
  assert.equal(JSON.parse(readFileSync(markerFile, "utf8")).executionId, "run-prior");
  rmSync(path.join(worktree, "unregistered.txt"));
  assert.equal(createWorktree(source, "product-senior-developer", "Senior Developer"), worktree);
  const autoCommittedHead = gitWorktree("rev-parse", "HEAD");
  assert.notEqual(autoCommittedHead, sourceHead);

  let evidence: any = null;
  let authorizations = 0;
  await assert.rejects(() => prepareNativeSourceBaseline(registry, worktree, false, "run-current", async () => {
    authorizations += 1; return { authorized: false };
  }), /Authority did not authorize/);
  assert.equal(JSON.parse(readFileSync(markerFile, "utf8")).executionId, "run-prior");
  const baseline = await prepareNativeSourceBaseline(registry, worktree, false, "run-current", async (value) => {
    authorizations += 1; evidence = value; return { authorized: true, eventId: "event-rebind-1" };
  });
  assert.equal(baseline.baselineHead, sourceHead);
  assert.equal(baseline.rebindEventId, "event-rebind-1");
  assert.equal(authorizations, 2);
  assert.equal(evidence.priorExecutionId, "run-prior");
  assert.equal(evidence.currentExecutionId, "run-current");
  assert.equal(evidence.nativeWorkspace, realpathSync(worktree));
  assert.deepEqual(evidence.changedFiles.map((file: { path: string }) => file.path), ["app.js", "index.html"]);
  assert.equal(evidence.changedFiles[0].sha256, digest(readFileSync(path.join(worktree, "app.js")).toString("utf8")));
  const rebound = JSON.parse(readFileSync(markerFile, "utf8"));
  assert.equal(rebound.executionId, "run-current");
  assert.equal(rebound.reboundEventId, "event-rebind-1");
  assert.equal(rebound.baselineHead, sourceHead);
  assert.equal(gitWorktree("rev-parse", "HEAD"), autoCommittedHead);
  const current = await prepareNativeSourceBaseline(registry, worktree, false, "run-current", async () => {
    authorizations += 1; return { authorized: true, eventId: "unexpected" };
  });
  assert.equal(current.rebindEventId, "event-rebind-1");
  assert.equal(authorizations, 2);
});

test("worktree rebind accepts one delayed Authority receipt within native admission timeout", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  t.after(() => {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout });
  });
  let timeoutMs = 0;
  let posts = 0;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (milliseconds: number) => { timeoutMs = milliseconds; return originalTimeout(milliseconds); },
  });
  globalThis.fetch = async (_input, init) => {
    posts += 1;
    assert.equal(timeoutMs, 15_000);
    assert.ok(init?.signal instanceof AbortSignal);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 3_150);
      init.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
    });
    return Response.json({ authorized: true, eventId: "rebind-delayed-receipt" }, { status: 201 });
  };
  const result = await authorizeProductWorktreeRebind("http://127.0.0.1:3869/", { currentExecutionId: "run-current" });
  assert.deepEqual(result, { authorized: true, eventId: "rebind-delayed-receipt" });
  assert.equal(timeoutMs, 15_000);
  assert.equal(posts, 1, "a delayed success is one reservation, not a retry signal");
});

function projection(prompt: string, current = true) {
  return {
    schemaVersion: 1 as const,
    taskId: "task-public-toy",
    title: "Public toy",
    goalStatement: "Fix the accepted greeting contract",
    status: current ? "running" : "waiting_user",
    goalVersionId: "goal-current",
    projectRootGoalVersionId: "goal-current",
    projectRootInputFingerprint: H("1"),
    materialApplicabilityFingerprint: H("2"),
    instructionIds: [],
    taskInputBindingSha256: H("3"),
    pipelineBindingSha256: H("4"),
    authoritySha256: H("5"),
    current,
    workspace: { current, scopeFingerprint: H("6"), sourceSnapshotSha256: H("7") },
    execution: { id: "run-current", phase: "running", stopReason: null },
    registeredExecution: current ? { goalVersionId: "goal-current", displayPrompt: "Accepted public task", prompt, promptSha256: digest(prompt) } : null,
    artifact: null,
  };
}

test("CONTROLLED: exact registered prompt is required before a Developer reservation", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const prompt = `IRIXI_NATIVE_PRODUCT_EXECUTION_V1\nGoal: Accepted public task\n\nSuccess criteria:\n- Preserve the accepted request\n\nBoundaries:\n- Registered project scope\n\n${INTEGRATED_DEVELOPER_TAG}`;
  let current = projection(prompt);
  let reservations = 0;
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = current.taskId;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/authority") return Response.json({ projection: current });
    if (url.pathname === "/v1/task-board") return Response.json({
      taskId: current.taskId,
      goalVersionId: current.goalVersionId,
      pipelineBindingSha256: current.pipelineBindingSha256,
      executionId: current.execution?.id || null,
    });
    if (url.pathname === "/v1/reservations") {
      reservations += 1;
      assert.equal(JSON.parse(String(init?.body)).promptSha256, digest(prompt));
      return Response.json({ reservation: { ok: true } }, { status: 201 });
    }
    throw new Error("unexpected controlled URL");
  };
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    const oldVersionPrompt = `Accepted public task\n\nIrixi accepted goal version: goal-old\n${INTEGRATED_DEVELOPER_TAG}`;
    await assert.rejects(bridge.authorize("task-wrong", "developer", oldVersionPrompt), /not the accepted execution request/);
    assert.equal(reservations, 0);
    await bridge.authorize("task-current", "developer", prompt);
    assert.equal(reservations, 1);
    current = projection(prompt, false);
    const publicState = await bridge.publicProjection();
    assert.equal(publicState.current, false);
    assert.equal(publicState.registeredExecution, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
  }
});

test("product binding watch reads the authority snapshot without depending on task-board presentation", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalRegistry = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  const originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  const current = projection("accepted prompt");
  const reads: string[] = [];
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = current.taskId;
  delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    reads.push(url.pathname);
    if (url.pathname === "/v1/authority") return Response.json({ projection: current });
    throw new Error(`unexpected ${url.pathname}`);
  };
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    const state = await bridge.productBindingProjection();
    assert.deepEqual(reads, ["/v1/authority"]);
    assert.equal(state.taskId, current.taskId);
    assert.equal(state.goalVersionId, current.goalVersionId);
    assert.equal(state.current, true);
    assert.equal(state.execution?.id, current.execution.id);
    assert.equal(state.product, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalRegistry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = originalRegistry;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
  }
});

test("product binding projection tolerates a 3.25-second Authority read with its bounded timeout", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalRegistry = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  const originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  const current = projection("accepted prompt");
  let useLegacyTimeout = true;
  const requestedTimeouts: number[] = [];
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = current.taskId;
  delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (milliseconds: number) => {
      requestedTimeouts.push(milliseconds);
      return originalTimeout(useLegacyTimeout ? 3_000 : milliseconds);
    },
  });
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/v1/authority");
    await new Promise<void>((resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("Authority projection timeout signal is missing"));
      const timer = setTimeout(resolve, 3_250);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    return Response.json({ projection: current });
  };
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    await assert.rejects(bridge.productBindingProjection(), (error: unknown) => error instanceof Error && error.name === "TimeoutError");
    useLegacyTimeout = false;
    const state = await bridge.productBindingProjection();
    assert.equal(state.taskId, current.taskId);
    assert.equal(state.current, true);
    assert.deepEqual(requestedTimeouts, [8_000, 8_000]);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout });
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalRegistry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = originalRegistry;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
  }
});

test("preserves a bounded Authority rejection status and body without accepting a stale projection", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalRegistry = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  const originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = "task-current";
  delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  globalThis.fetch = async () => Response.json({ error: "projection digest mismatch" }, { status: 409 });
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    await assert.rejects(bridge.productBindingProjection(), (error: unknown) =>
      error instanceof Error && error.message === 'Irixi authority rejected current state (409): {"error":"projection digest mismatch"}');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalRegistry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = originalRegistry;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
  }
});

test("audits Authority projection timeouts with correlated metadata only", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalRegistry = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  const originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  const originalWarn = console.warn;
  const originalTimeout = AbortSignal.timeout;
  const current = projection("private prompt marker");
  const auditLines: string[] = [];
  let calls = 0;
  let timeoutMs = 0;
  let timeoutHeaders: Headers | null = null;
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = current.taskId;
  delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (milliseconds: number) => {
      timeoutMs = milliseconds;
      return AbortSignal.abort(new DOMException("timed out", "TimeoutError"));
    },
  });
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    if (calls === 1) return Response.json({ projection: current });
    timeoutHeaders = new Headers(init?.headers);
    const signal = init?.signal;
    assert.ok(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return; }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  console.warn = (...args: unknown[]) => auditLines.push(args.map(String).join(" "));
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    await bridge.productBindingProjection();
    await assert.rejects(bridge.productBindingProjection(), (error: unknown) => error instanceof Error && error.name === "TimeoutError");
    assert.equal(calls, 2);
    assert.equal(timeoutMs, 8_000);
    assert.ok(timeoutHeaders);
    assert.match(timeoutHeaders.get("x-irixi-projection-id") || "", /^[a-f0-9-]{36}$/i);
    assert.equal(timeoutHeaders.get("x-irixi-execution-id"), current.execution?.id);
    const line = auditLines.find((entry) => entry.startsWith("[IrixiAuthorityProjection] "));
    assert.ok(line);
    const record = JSON.parse(line.slice("[IrixiAuthorityProjection] ".length));
    assert.equal(record.taskId, current.taskId);
    assert.equal(record.executionId, current.execution?.id);
    assert.equal(record.registrySha256, null);
    assert.equal(record.stage, "authority_fetch");
    assert.equal(record.outcome, "failed");
    assert.equal(record.httpStatus, null);
    assert.equal(record.errorClass, "TimeoutError");
    assert.ok(Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0);
    assert.equal(line.includes("private prompt marker"), false);
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout });
    console.warn = originalWarn;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalRegistry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = originalRegistry;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
  }
});

test("product review prompt preparation tolerates bounded authority reads over three seconds", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalRegistry = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  const originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = "task-review-timeout";
  delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  const prompt = "Verified readonly review prompt";
  const expectedCandidateSha256 = H("a");
  const expectedReviewId = "review-previous";
  const expectedReviewRoundId = "review-round-1";
  const reviewEvidence = "核对 mastered 门槛。";
  const dispatchEventId = "event-review-dispatch";
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/v1/product-review-request");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      expectedGoalVersionId: "goal-current", expectedExecutionId: "run-current", expectedRegistrySha256: H("b"),
      expectedArtifactId: "artifact-review-timeout", expectedArtifactVersion: 1,
      expectedCandidateSha256, expectedReviewId, expectedReviewRoundId, reviewEvidence,
    });
    await new Promise<void>((resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return reject(new Error("review request timeout signal is missing"));
      const timer = setTimeout(resolve, 3_250);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    return Response.json({ taskId: "task-review-timeout", artifactId: "artifact-review-timeout", artifactVersion: 1,
      candidateSha256: expectedCandidateSha256, expectedReviewId, reviewRoundId: expectedReviewRoundId,
      dispatchEventId, prompt, promptSha256: digest(prompt) });
  };
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    const request = await bridge.productReviewRequest({ expectedGoalVersionId: "goal-current", expectedExecutionId: "run-current",
      expectedRegistrySha256: H("b"), expectedArtifactId: "artifact-review-timeout", expectedArtifactVersion: 1,
      expectedCandidateSha256, expectedReviewId, expectedReviewRoundId, reviewEvidence });
    assert.equal(request.prompt, prompt);
    assert.equal(request.artifactVersion, 1);
    assert.equal(request.expectedReviewId, expectedReviewId);
    assert.equal(request.reviewRoundId, expectedReviewRoundId);
    assert.equal(request.dispatchEventId, dispatchEventId);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalRegistry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = originalRegistry;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
  }
});

test("open review round preserves a null prior review ID across its Authority request and response", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalRegistry = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  const originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  const current = projection("accepted prompt", false);
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = current.taskId;
  delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/authority") return Response.json({ projection: current });
    assert.equal(url.pathname, "/v1/product-review-round");
    assert.equal(JSON.parse(String(init?.body)).expectedReviewId, null);
    return Response.json({ taskId: current.taskId, reviewRoundId: "round-no-review", artifactId: "artifact-current",
      artifactVersion: 41, candidateSha256: H("a"), expectedReviewId: null, maxModelCalls: 1, modelCalls: 0,
      deadlineAt: new Date(Date.now() + 60_000).toISOString() }, { status: 201 });
  };
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    const round = await bridge.openProductReviewRound({ expectedGoalVersionId: "goal-current", expectedExecutionId: "run-current",
      expectedRegistrySha256: H("b"), expectedArtifactId: "artifact-current", expectedArtifactVersion: 41,
      expectedCandidateSha256: H("a"), expectedReviewId: null });
    assert.equal(round.expectedReviewId, null);
    assert.equal(round.reviewRoundId, "round-no-review");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalRegistry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = originalRegistry;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
  }
});

test("CONTROLLED: article reviewer context contains the TaskStore-confirmed contract", async () => {
  const originalFetch = globalThis.fetch, originalUrl = process.env.IRIXI_AUTHORITY_URL, originalTask = process.env.IRIXI_AUTHORITY_TASK_ID, originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/"; process.env.IRIXI_AUTHORITY_TASK_ID = "task-article-learning-12"; process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = "article-learning-12";
  const diff = "=== NEW FILE: index.html ===\n<html></html>";
  const value: any = projection("unused"); value.taskId = "task-article-learning-12"; value.goalVersionId = "goal-article"; value.artifact = { id: "artifact-1", version: 1, candidateSha256: H("a"), diffSha256: digest(diff), patchSha256: digest(diff) };
  value.confirmedContract = { goalVersionId: "goal-article", statement: "Teach the confirmed article goal", successCriteria: ["Ground every assessment"], boundaries: ["No publishing"], materialSha256: H("b"), developmentBinding: { batchId: "development-02", executionId: value.execution.id, repairOfExecutionId: "run-failed", priorLedgerSha256: H("c"), repairInputManifestSha256: H("d"), scopeFingerprint: H("e") } };
  globalThis.fetch = async (input) => { const url = new URL(String(input)); if (url.pathname === "/v1/authority") return Response.json({ projection: value }); if (url.pathname === "/v1/reservations") return Response.json({ reservation: { ok: true } }, { status: 201 }); throw new Error(`unexpected ${url.pathname}`); };
  try {
    const bridge = createIrixiIntegration()!; const binding = await bridge.authorize("review-article", "reviewer", undefined, diff); assert.equal(bridge.actorFor("review-article"), "reviewer"); const context = bridge.reviewerContext(binding);
    assert.match(context, /Teach the confirmed article goal/); assert.match(context, /Ground every assessment/); assert.match(context, /No publishing/); assert.match(context, new RegExp(H("b")));
    assert.match(context, /IRIXI_DEVELOPMENT_BATCH: development-02/); assert.match(context, /IRIXI_REPAIR_OF_EXECUTION_ID: run-failed/); assert.match(context, new RegExp(`IRIXI_PRIOR_LEDGER_SHA256: ${H("c")}`)); assert.match(context, new RegExp(`IRIXI_SOURCE_SNAPSHOT_SHA256: ${H("d")}`));
    assert.match(context, /complete important concepts/); assert.match(context, /supported actual application AND transfer to an actually unseen scenario, as specified by the current confirmed criteria/);
    assert.match(context, /Do not invent a fixed requirement that every concept receive all four question types/); assert.match(context, /unless explicitly required by the current confirmed criteria/); assert.match(context, /Structural identity and anti-duplicate gates prevent relabeling but do not by themselves prove semantic mastery/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
  }
});

test("CONTROLLED: intake uses its exact tagged prompt and records a reply without creating a project run", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalIntake = process.env.IRIXI_INTAKE_TASK_ID;
  const prompt = `${PROJECT_INTAKE_TAG}\n\nRead-only clarification`;
  let reservations = 0;
  let replies = 0;
  const discussionToggles: boolean[] = [];
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = "task-public-toy";
  process.env.IRIXI_INTAKE_TASK_ID = "task-intake";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/intake/open-discussion" || url.pathname === "/v1/intake/close-discussion") {
      assert.equal(init?.method, "POST");
      discussionToggles.push(url.pathname.endsWith("/open-discussion"));
      return Response.json({ modelAvailability: { discussion: { available: discussionToggles.at(-1) } } });
    }
    if (url.pathname === "/v1/intake/reservations") {
      reservations += 1;
      assert.equal(JSON.parse(String(init?.body)).promptSha256, digest(prompt));
      return Response.json({ reservation: { ok: true } }, { status: 201 });
    }
    if (url.pathname === "/v1/intake/replies") {
      replies += 1;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.text, "Draft only; explicit confirmation required.");
      assert.equal(body.resultSha256, digest(body.text));
      return Response.json({ status: "draft_ready" }, { status: 201 });
    }
    throw new Error(`unexpected controlled URL ${url.pathname}`);
  };
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    await bridge.setIntakeDiscussionEnabled(true);
    await bridge.setIntakeDiscussionEnabled(false);
    assert.deepEqual(discussionToggles, [true, false]);
    await assert.rejects(bridge.authorizeIntake("task-intake-native", "unregistered"), /not the registered/);
    assert.equal(reservations, 0);
    await bridge.authorizeIntake("task-intake-native", prompt);
    assert.equal(reservations, 1);
    assert.equal(bridge.isIntakeTask("task-intake-native"), true);
    await bridge.recordIntake("TASK_DONE", "task-intake-native", "Draft only; explicit confirmation required.");
    assert.equal(replies, 1);
    assert.equal(bridge.isIntakeTask("task-intake-native"), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalIntake === undefined) delete process.env.IRIXI_INTAKE_TASK_ID; else process.env.IRIXI_INTAKE_TASK_ID = originalIntake;
  }
});

test("CONTROLLED: intake completion is not visible before the authority persists it", async () => {
  let release!: () => void;
  const persisted = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const event = { type: "TASK_DONE" as const, agentId: "agent-intake", taskId: "task-intake-native", result: { summary: "draft", fullOutput: "draft reply", changedFiles: [], diffStat: "", testResult: "unknown" as const } };
  const pending = persistIntakeTerminalBeforePublish({
    integration: { async recordIntake() { order.push("persist-start"); await persisted; order.push("persist-done"); } },
    event,
    buffer(value) { assert.equal(value, event); order.push("buffer"); },
    publish(value) { assert.equal(value, event); order.push("publish"); },
  });
  await Promise.resolve();
  assert.deepEqual(order, ["persist-start"]);
  release();
  const result = await pending;
  assert.equal(result.persisted, true);
  assert.deepEqual(order, ["persist-start", "persist-done", "buffer", "publish"]);
});

test("CONTROLLED: unreserved native failure requires and preserves its exact preparation-time binding", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "native-preparation-receipt-")));
  const previous = {
    url: process.env.IRIXI_AUTHORITY_URL, task: process.env.IRIXI_AUTHORITY_TASK_ID,
    registry: process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE, project: process.env.OPEN_OFFICE_IRIXI_PROJECT_ID,
    fetch: globalThis.fetch,
  };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = previous.url;
    if (previous.task === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = previous.task;
    if (previous.registry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = previous.registry;
    if (previous.project === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = previous.project;
    rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, "index.html");
  const bytes = Buffer.from("<main>registered</main>\n");
  writeFileSync(source, bytes, { mode: 0o644 });
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Preparation receipt test"); git("config", "user.email", "preparation-receipt@example.invalid");
  git("add", "--", "index.html"); git("commit", "-qm", "registered source");
  const sourceHead = git("rev-parse", "HEAD");
  const sourceManifest = [{ path: "index.html", bytes: bytes.length, sha256: digest(bytes.toString("utf8")), mode: lstatSync(source).mode & 0o777 }];
  const sourceSnapshotSha256 = digest(canonical({ sourceHead, sourceManifest }));
  const registryFile = path.join(root, "registry.json");
  writeFileSync(registryFile, JSON.stringify({
    schemaVersion: 1, projectId: "article-learning-12", taskId: "task-public-toy", goalVersionId: "goal-current",
    taskInputBindingSha256: H("3"), pipelineBindingSha256: H("4"), authorityUrl: "http://127.0.0.1:31639/",
    workspace: { path: root, scopeFingerprint: H("6"), sourceSnapshotSha256, sourceHead,
      sourceManifest,
      allowedWritePaths: ["index.html"], checks: ["node-syntax-v1"] },
    native: { backend: "codex", model: "gpt-5.6-sol", allowedRoles: ["Lead", "Senior Developer", "Reviewer"], maxModelCalls: 8, maxDurationMs: 1_200_000,
      promptBudget: { contextWindowTokens: 272_000, effectiveContextPercent: 95, outputTokens: 24_576, protocolTokens: 8_192 } },
    capabilities: { team: true, worktree: true, staticPreviewEntries: [], staticPreviewFiles: [], autoMerge: false, manualMerge: false, commandPreview: false },
  }), { mode: 0o600 });
  const registeredRegistry = JSON.parse(readFileSync(registryFile, "utf8"));
  const registeredRegistrySha256 = productRegistrySha256(registeredRegistry);
  const prompt = "registered execution request";
  let current: any = { ...projection(prompt), taskId: "task-public-toy",
    workspace: { current: true, scopeFingerprint: H("6"), sourceSnapshotSha256 } };
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:31639/";
  process.env.IRIXI_AUTHORITY_TASK_ID = current.taskId;
  process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = registryFile;
  process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = "article-learning-12";
  let submitted: Record<string, unknown> | null = null;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/authority") return Response.json({ projection: current });
    if (url.pathname === "/v1/reservations") return Response.json({ reservation: { ok: true } }, { status: 201 });
    if (url.pathname === "/v1/product-review-request") {
      const reviewPrompt = `IRIXI_PRODUCT_REVIEW_V1\n\nIRIXI_REVIEW_ROUND_ID: review-round-no-review\n\nGoal: ${current.goalStatement}\n\nCandidate SHA-256: ${current.artifact.candidateSha256}\n\nSuccess criteria:\n- Check the exact candidate\n\nBoundaries:\n- Read-only\n\nComplete candidate file contents:\nindex.html\n\nPatch:\n- registered diff`;
      return Response.json({ taskId: current.taskId, artifactId: current.artifact.id, artifactVersion: current.artifact.version,
        candidateSha256: current.artifact.candidateSha256, expectedReviewId: null, reviewRoundId: "review-round-no-review",
        dispatchEventId: "event-review-dispatch", prompt: reviewPrompt, promptSha256: digest(reviewPrompt) }, { status: 201 });
    }
    if (url.pathname === "/v1/product-native-calls") {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.phase, "review");
      assert.equal(body.reviewRoundId, "review-round-no-review");
      assert.equal(body.role, "Reviewer");
      return Response.json({ error: "Product terminal event has no matching native process reservation" }, { status: 409 });
    }
    if (url.pathname === "/v1/observations") {
      const received = JSON.parse(String(init?.body)) as Record<string, unknown>;
      submitted = received;
      if (received.actor === "reviewer" && received.preparationFailure !== true) {
        return Response.json({ error: "Product terminal event has no matching native process reservation" }, { status: 409 });
      }
      if (received.actor === "reviewer" && received.preparationFailure === true) {
        assert.equal(received.phase, "review");
        assert.equal(received.reviewDispatchEventId, "event-review-dispatch");
        assert.equal(received.reviewRegistrySha256, registeredRegistrySha256);
        assert.equal(received.reviewPromptSha256, digest(`IRIXI_PRODUCT_REVIEW_V1\n\nIRIXI_REVIEW_ROUND_ID: review-round-no-review\n\nGoal: ${current.goalStatement}\n\nCandidate SHA-256: ${current.artifact.candidateSha256}\n\nSuccess criteria:\n- Check the exact candidate\n\nBoundaries:\n- Read-only\n\nComplete candidate file contents:\nindex.html\n\nPatch:\n- registered diff`));
        assert.equal(received.reviewArtifactId, "artifact-current");
        assert.equal(received.reviewArtifactVersion, 41);
        assert.equal(received.reviewCandidateSha256, candidateSha256);
        assert.equal(received.expectedReviewId, null);
        assert.equal(received.reviewRoundId, "review-round-no-review");
      }
      return Response.json({ observation: { record: {
        ...received, preparationFailure: true, nativeRole: "Senior Developer",
        reservationStatus: "not_created", modelCallCreated: false,
      }, created: true } }, { status: 201 });
    }
    throw new Error(`unexpected controlled URL ${url.pathname}`);
  };
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  assert.throws(() => createIrixiIntegration(), /Product registry authority or task does not match/);
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:31639/";
  const bridge = createIrixiIntegration();
  assert.ok(bridge);
  const sourceTaskId = "worker-preparation";
  const parentTaskId = "lead-parent-task";
  const parentBinding = {
    taskId: current.taskId, goalVersionId: current.goalVersionId,
    taskInputBindingSha256: current.taskInputBindingSha256, pipelineBindingSha256: current.pipelineBindingSha256,
    executionId: current.execution?.id || null, workspaceScopeFingerprint: current.workspace?.scopeFingerprint || null,
    sourceSnapshotSha256: current.workspace?.sourceSnapshotSha256 || null, artifactId: null, artifactVersion: null,
    candidateSha256: null, diffSha256: null, authoritySnapshotSha256: current.authoritySha256, sourceTaskId: parentTaskId,
  };
  await assert.rejects(() => bridge.record("TASK_FAILED", "developer", sourceTaskId, {
    sourceEventId: `${sourceTaskId}:attempt-preparation:TASK_FAILED`, nativeAttemptId: "attempt-preparation",
    agentId: "product-senior-developer", error: "preparation failed",
  }), /no exact preparation-time Authority binding/);
  await assert.rejects(() => bridge.record("TASK_FAILED", "developer", sourceTaskId, {
    sourceEventId: `${sourceTaskId}:attempt-preparation:TASK_FAILED`, nativeAttemptId: "attempt-preparation",
    agentId: "product-senior-developer", eventBinding: { ...parentBinding, sourceTaskId, executionId: "run-old" }, error: "preparation failed",
  }), /binding is stale/);

  await bridge.authorize(parentTaskId, "developer", prompt, undefined, root);
  const binding = bridge.inheritTaskBinding(parentTaskId, sourceTaskId);
  assert.deepEqual(binding, { ...parentBinding, sourceTaskId });

  const event = { type: "TASK_FAILED" as const, agentId: "product-senior-developer", taskId: sourceTaskId,
    nativeAttemptId: "attempt-preparation", irixiAuthority: binding, error: "preparation failed" };
  const persisted = await persistIntegratedTerminalBeforePublish({
    integration: bridge, event, actor: "developer", buffer() {}, publish() {},
  });
  assert.equal(persisted.persisted, true);
  const received = submitted as unknown as Record<string, unknown>;
  assert.equal(received.sourceEventId, `${sourceTaskId}:attempt-preparation:TASK_FAILED:preparation`);
  assert.equal(received.preparationFailure, true);
  assert.equal(received.scopeOutcome, null);
  assert.equal(received.resultSha256, null);
  assert.deepEqual(received.binding, binding);

  const candidateSha256 = H("a");
  current = { ...current, productRegistry: { current: true, registrySha256: registeredRegistrySha256 },
    artifact: { id: "artifact-current", version: 41, candidateSha256, review: null } };
  const reviewRequest = await bridge.productReviewRequest({ expectedGoalVersionId: current.goalVersionId,
    expectedExecutionId: current.execution.id, expectedRegistrySha256: registeredRegistrySha256,
    expectedArtifactId: "artifact-current", expectedArtifactVersion: 41, expectedCandidateSha256: candidateSha256,
    expectedReviewId: null, expectedReviewRoundId: "review-round-no-review" });
  const reviewTaskId = "product-review-current";
  const reviewRegistrationInput = {
    goalVersionId: current.goalVersionId, executionId: current.execution.id, registrySha256: registeredRegistrySha256,
    artifactId: reviewRequest.artifactId, artifactVersion: reviewRequest.artifactVersion,
    candidateSha256: reviewRequest.candidateSha256, expectedReviewId: null,
    reviewRoundId: reviewRequest.reviewRoundId,
    dispatchEventId: reviewRequest.dispatchEventId, prompt: reviewRequest.prompt, promptSha256: reviewRequest.promptSha256,
  };
  await assert.rejects(() => bridge.registerProductReviewTask(`${reviewTaskId}-unknown`, "product-reviewer", "reviewer-intern", reviewRegistrationInput),
    /Product Reviewer dispatch identity is malformed/);
  await assert.rejects(() => bridge.registerProductReviewTask(`${reviewTaskId}-wrong-role`, "product-reviewer", "Senior Developer", reviewRegistrationInput),
    /Product Reviewer dispatch identity is malformed/);
  const reviewRegistration = await bridge.registerProductReviewTask(reviewTaskId, "product-reviewer", "reviewer", reviewRegistrationInput);
  assert.equal(bridge.isRegisteredProductReview(reviewTaskId, reviewRequest.prompt), true);
  const reviewFailureEvent = { type: "TASK_FAILED" as const, agentId: "product-reviewer", taskId: reviewTaskId,
    nativeAttemptId: "attempt-review-preflight", irixiAuthority: reviewRegistration.binding,
    error: "Native prompt exceeded the input budget before model submission." };
  const reviewFailure = await persistIntegratedTerminalBeforePublish({ integration: bridge, event: reviewFailureEvent,
    actor: "reviewer", buffer() {}, publish() {} });
  assert.equal(reviewFailure.persisted, true);
  const reviewerFailurePayload = submitted as unknown as Record<string, unknown>;
  assert.equal(reviewerFailurePayload.actor, "reviewer");
  assert.equal(reviewerFailurePayload.preparationFailure, true);
  assert.equal(reviewerFailurePayload.modelCallCreated, undefined);
  assert.equal(reviewerFailurePayload.nativeWorkspace, null);
  assert.equal(reviewerFailurePayload.reviewRegistrySha256, registeredRegistrySha256);
  assert.equal(reviewerFailurePayload.reviewDispatchEventId, "event-review-dispatch");
  assert.equal(reviewerFailurePayload.reviewCandidateSha256, candidateSha256);
  assert.equal(reviewerFailurePayload.error, reviewFailureEvent.error);

  const reviewPrompt = reviewRequest.prompt;
  const reviewAttemptId = "attempt-review-no-reservation";
  await assert.rejects(() => bridge.authorizeNativeCall({
    attemptId: reviewAttemptId, taskId: reviewTaskId, agentId: "product-reviewer", role: "reviewer",
    backend: "codex", model: "gpt-5.6-sol", workspace: root, prompt: reviewPrompt,
    promptSha256: digest(reviewPrompt), teamId: "synthetic-team", phase: "review", isTeamLead: false, readOnly: true,
  }), /Product terminal event has no matching native process reservation/);
  const failedAdmission = await persistIntegratedTerminalBeforePublish({
    integration: bridge,
    event: { type: "TASK_FAILED", agentId: "product-reviewer", taskId: reviewTaskId,
      nativeAttemptId: reviewAttemptId, irixiAuthority: reviewRegistration.binding,
      error: "Product terminal event has no matching native process reservation" },
    actor: "reviewer", buffer() {}, publish() {},
  });
  assert.equal(failedAdmission.persisted, true);
  assert.equal((submitted as any).error, "Product terminal event has no matching native process reservation");
  assert.equal((submitted as any).preparationFailure, true);
  assert.equal((submitted as any).modelCallCreated, undefined);
  assert.equal((submitted as any).reviewRoundId, "review-round-no-review");

  const staleChild = "late-old-worker";
  const staleBinding = bridge.inheritTaskBinding(parentTaskId, staleChild);
  current = { ...current, execution: { ...current.execution, id: "run-new" } };
  await assert.rejects(() => bridge.record("TASK_FAILED", "developer", staleChild, {
    sourceEventId: `${staleChild}:attempt-old:TASK_FAILED`, nativeAttemptId: "attempt-old",
    agentId: "product-senior-developer", eventBinding: staleBinding, error: "late failure",
  }), /binding is stale/);
});

test("CONTROLLED: lost native admission receipts settle the exact reservation without duplicating it", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "native-admission-lost-receipt-")));
  const previous = {
    url: process.env.IRIXI_AUTHORITY_URL, task: process.env.IRIXI_AUTHORITY_TASK_ID,
    registry: process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE, project: process.env.OPEN_OFFICE_IRIXI_PROJECT_ID,
    fetch: globalThis.fetch,
  };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = previous.url;
    if (previous.task === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = previous.task;
    if (previous.registry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = previous.registry;
    if (previous.project === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = previous.project;
    rmSync(root, { recursive: true, force: true });
  });

  const source = path.join(root, "source");
  mkdirSync(source);
  const sourceFile = path.join(source, "index.html");
  const sourceBytes = Buffer.from("<main>registered native call</main>\n");
  writeFileSync(sourceFile, sourceBytes, { mode: 0o644 });
  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q"); git("config", "user.name", "Native admission test"); git("config", "user.email", "native-admission@example.invalid");
  git("add", "--", "index.html"); git("commit", "-qm", "registered source");
  const sourceHead = git("rev-parse", "HEAD");
  const sourceManifest = [{ path: "index.html", bytes: sourceBytes.length, sha256: digest(sourceBytes.toString("utf8")), mode: lstatSync(sourceFile).mode & 0o777 }];
  const scopeFingerprint = H("6");
  const sourceSnapshotSha256 = digest(canonical({ sourceHead, sourceManifest }));
  const taskId = "task-native-admission-receipt";
  const registeredPrompt = "Use the registered read-only Lead planning request.";
  const current = {
    ...projection(registeredPrompt),
    taskId,
    workspace: { current: true, scopeFingerprint, sourceSnapshotSha256 },
  };
  const registry = {
    schemaVersion: 1, projectId: "article-learning-12", taskId, goalVersionId: "goal-current",
    taskInputBindingSha256: H("3"), pipelineBindingSha256: H("4"), authorityUrl: "http://127.0.0.1:3869/",
    workspace: { path: source, scopeFingerprint, sourceSnapshotSha256, sourceHead, sourceManifest,
      allowedWritePaths: ["index.html"], checks: ["node-syntax-v1"] },
    native: { backend: "codex", model: "gpt-5.6-sol", allowedRoles: ["Lead", "Senior Developer", "Reviewer"], maxModelCalls: 8, maxDurationMs: 1_200_000,
      promptBudget: { contextWindowTokens: 272_000, effectiveContextPercent: 95, outputTokens: 24_576, protocolTokens: 8_192 } },
    capabilities: { team: true, worktree: true, staticPreviewEntries: [], staticPreviewFiles: [], autoMerge: false, manualMerge: false, commandPreview: false },
  };
  const registryFile = path.join(root, "registry.json");
  writeFileSync(registryFile, JSON.stringify(registry), { mode: 0o600 });
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = taskId;
  process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = registryFile;
  process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = "article-learning-12";

  const attemptId = "attempt-response-lost";
  const agentId = "product-lead";
  const fullPrompt = `${registeredPrompt}\n\nPlanning only; no model is invoked in this test.`;
  const effectiveContextTokens = Math.floor(272_000 * 0.95);
  const promptUtf8Bytes = Buffer.byteLength(fullPrompt, "utf8");
  const context = {
    attemptId, taskId, agentId, role: "Lead", backend: "codex", model: "gpt-5.6-sol",
    workspace: source, prompt: fullPrompt, promptSha256: digest(fullPrompt), phase: "create", isTeamLead: true, readOnly: true,
    promptBudget: { modelId: "gpt-5.6-sol", contextWindowTokens: 272_000, effectiveContextPercent: 95, effectiveContextTokens,
      outputReserveTokens: 24_576, protocolReserveTokens: 8_192, availablePromptTokens: effectiveContextTokens - 24_576 - 8_192,
      promptUtf8Bytes, promptTokenUpperBound: promptUtf8Bytes, estimator: "utf8_bytes_upper_bound" as const },
  };
  let reservationPosts = 0;
  let slowReservationPosts = 0;
  let createdReservations = 0;
  let firstReservationBody: Record<string, unknown> | null = null;
  let submittedTerminal: Record<string, unknown> | null = null;
  let admissionMode: "slow_success" | "lost_receipt" = "slow_success";
  const bridge = createIrixiIntegration();
  assert.ok(bridge);
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/authority") return Response.json({ projection: current });
    if (url.pathname === "/v1/product-native-calls") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (admissionMode === "slow_success") {
        slowReservationPosts += 1;
        const signal = init?.signal;
        assert.ok(signal instanceof AbortSignal);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
          }, 3_100);
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
        return Response.json({ reservation: { detail: { deadlineAt: new Date(Date.now() + 60_000).toISOString(), phase: "create" } } }, { status: 201 });
      }
      reservationPosts += 1;
      if (firstReservationBody === null) {
        firstReservationBody = body;
        createdReservations += 1;
      } else assert.deepEqual(body, firstReservationBody, "same attempt retry must preserve every reservation field");
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    }
    if (url.pathname === "/v1/observations") {
      submittedTerminal = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ observation: { record: submittedTerminal } }, { status: 201 });
    }
    throw new Error(`unexpected controlled URL ${url.pathname}`);
  };

  const slowAdmission = await bridge.authorizeNativeCall({ ...context, attemptId: "attempt-slow-admission" });
  assert.ok(slowAdmission && slowAdmission.timeoutMs > 0);
  assert.equal(slowReservationPosts, 1, "a successful delayed admission must not dispatch a duplicate reservation");
  admissionMode = "lost_receipt";

  await assert.rejects(() => bridge.authorizeNativeCall(context), /fetch failed/);
  assert.equal(bridge.bindingFor(taskId, attemptId)?.taskId, taskId);
  await assert.rejects(() => bridge.authorizeNativeCall(context), /fetch failed/);
  assert.equal(reservationPosts, 2);
  assert.equal(createdReservations, 1);

  const event = { type: "TASK_FAILED" as const, agentId, taskId, nativeAttemptId: attemptId, error: "authority admission response was lost" };
  const persisted = await persistIntegratedTerminalBeforePublish({
    integration: bridge, event, actor: "lead", buffer() {}, publish() {},
  });
  assert.equal(persisted.persisted, true);
  const terminal = submittedTerminal as unknown as Record<string, unknown>;
  assert.equal(terminal.preparationFailure, undefined);
  assert.equal(terminal.nativeAttemptId, attemptId);
  assert.equal(terminal.agentId, agentId);
  assert.equal(terminal.nativeWorkspace, source);
  assert.equal(terminal.sourceEventId, `${taskId}:${attemptId}:TASK_FAILED`);
  assert.equal(terminal.scopeOutcome, "failed");
});

test("CONTROLLED: integrated terminal completion is not visible before Irixi persists host evidence", async () => {
  let release!: () => void;
  const persisted = new Promise<void>((resolve) => { release = resolve; });
  const order: string[] = [];
  const event = { type: "TASK_DONE" as const, agentId: "reviewer-current", taskId: "review-current", result: { summary: "review", fullOutput: "VERDICT: PASS", changedFiles: ["src/greeting.js"], diffStat: "1 file", testResult: "passed" as const } };
  const pending = persistIntegratedTerminalBeforePublish({
    integration: { async record(_type, _actor, _sourceTaskId, detail) { order.push("persist-start"); await persisted; order.push("persist-done"); return { observation: { record: { sourceEventId: detail.sourceEventId } } }; } },
    event, actor: "reviewer",
    buffer(value) { assert.equal(value, event); order.push("buffer"); },
    publish(value) { assert.equal(value, event); order.push("publish"); },
  });
  await Promise.resolve();
  assert.deepEqual(order, ["persist-start"]);
  release();
  assert.equal((await pending).persisted, true);
  assert.deepEqual(order, ["persist-start", "persist-done", "buffer", "publish"]);
});

test("CONTROLLED: rejected host evidence records a bound native failure before publishing TASK_FAILED", async () => {
  const order: string[] = [];
  let calls = 0;
  const event = { type: "TASK_DONE" as const, agentId: "agent-current", taskId: "developer-current", result: { summary: "claimed done", fullOutput: "claimed done", changedFiles: [], diffStat: "", testResult: "unknown" as const } };
  const result = await persistIntegratedTerminalBeforePublish({
    integration: { async record(type, _actor, sourceTaskId, detail) {
      calls += 1;
      order.push(`record:${type}`);
      assert.equal(sourceTaskId, event.taskId);
      if (calls === 1) throw new Error("host check rejected");
      assert.equal(detail.sourceEventId, `${event.taskId}:legacy:TASK_FAILED:authority-persistence`);
      return { observation: { record: { sourceEventId: detail.sourceEventId } } };
    } },
    event, actor: "developer",
    buffer(value) { assert.equal(value.type, "TASK_FAILED"); order.push("buffer"); },
    publish(value) { assert.equal(value.type, "TASK_FAILED"); order.push("publish"); },
  });
  assert.equal(result.persisted, false);
  assert.equal(result.failurePersisted, true);
  assert.deepEqual(order, ["record:TASK_DONE", "record:TASK_FAILED", "buffer", "publish"]);
});

test("CONTROLLED: a missing Authority receipt is never reported as persisted", async () => {
  const published: string[] = [];
  let calls = 0;
  const event = { type: "TASK_FAILED" as const, agentId: "worker-current", taskId: "worker-current", nativeAttemptId: "attempt-current", error: "preparation failed" };
  const result = await persistIntegratedTerminalBeforePublish({
    integration: { async record() { calls += 1; return undefined; } }, event, actor: "developer",
    buffer(value) { published.push(`buffer:${value.type}`); }, publish(value) { published.push(`publish:${value.type}`); },
  });
  assert.equal(result.persisted, false);
  assert.equal(result.failurePersisted, false);
  assert.equal(calls, 2);
  assert.deepEqual(published, ["buffer:TASK_FAILED", "publish:TASK_FAILED"]);
});

test("CONTROLLED: bounded auto-review dispatch is exposed only after persisted Developer host evidence", async () => {
  const order: string[] = [];
  const transition = { transition: { autoReview: { dispatchEventId: "dispatch-1", executionId: "run-1", candidateSha256: "a".repeat(64), sourceTaskId: "developer-1", changedFiles: ["index.html"], entryFile: "index.html" } } };
  const event = { type: "TASK_DONE" as const, agentId: "agent-developer", taskId: "developer-1", result: { summary: "done", fullOutput: "STATUS: done", changedFiles: ["index.html"], diffStat: "1 file", testResult: "passed" as const } };
  const result = await persistIntegratedTerminalBeforePublish({
    integration: { async record() { order.push("persist"); return transition; } }, event, actor: "developer",
    buffer() { order.push("buffer"); }, publish() { order.push("publish"); }, afterPersist(value) { assert.equal(value, transition); order.push("auto-review"); },
  });
  assert.equal(result.persisted, true); assert.deepEqual(order, ["persist", "buffer", "publish", "auto-review"]);
  const failedOrder: string[] = [];
  await persistIntegratedTerminalBeforePublish({ integration: { async record() { throw new Error("host rejected"); } }, event, actor: "developer", buffer() {}, publish() {}, afterPersist() { failedOrder.push("unexpected"); } });
  assert.deepEqual(failedOrder, []);
});

test("CONTROLLED: readonly Reviewer PASS omits Developer-only changed-file fields", async () => {
  const event = { type: "TASK_DONE" as const, agentId: "reviewer-current", taskId: "review-current", result: { summary: "PASS", fullOutput: "VERDICT: PASS\nSUMMARY: exact candidate passes", changedFiles: [], diffStat: "", testResult: "passed" as const } };
  let recorded: Record<string, unknown> | null = null;
  const result = await persistIntegratedTerminalBeforePublish({
    integration: { async record(_type, actor, _sourceTaskId, detail) { assert.equal(actor, "reviewer"); recorded = detail; return { observation: { created: true } }; } },
    event, actor: "reviewer", buffer() {}, publish() {},
  });
  const reviewerDetail = recorded as unknown as Record<string, unknown>;
  assert.equal(result.persisted, true); assert.equal(reviewerDetail.resultText, event.result.fullOutput);
  assert.equal(Object.hasOwn(reviewerDetail, "changedFiles"), false); assert.equal(Object.hasOwn(reviewerDetail, "entryFile"), false);

  let developerDetail: Record<string, unknown> | null = null;
  await persistIntegratedTerminalBeforePublish({ integration: { async record(_type, _actor, _sourceTaskId, detail) { developerDetail = detail; return { observation: { record: { sourceEventId: detail.sourceEventId } } }; } }, event: { ...event, agentId: "developer-current", taskId: "developer-current" }, actor: "developer", buffer() {}, publish() {} });
  const capturedDeveloperDetail = developerDetail as unknown as Record<string, unknown>;
  assert.equal(capturedDeveloperDetail.changedFiles, null); assert.equal(capturedDeveloperDetail.entryFile, null);
});

test("CONTROLLED: readonly Lead plan persists as Lead evidence without Developer candidate fields", async () => {
  const plan = "[PLAN]\nImplement the accepted product scope.\n[/PLAN]";
  const event = { type: "TASK_DONE" as const, agentId: "product-lead", taskId: "lead-plan", nativeAttemptId: "attempt-plan",
    result: { summary: plan, fullOutput: plan, changedFiles: [], diffStat: "", testResult: "passed" as const } };
  let recorded: Record<string, unknown> | null = null;
  const result = await persistIntegratedTerminalBeforePublish({
    integration: { async record(type, actor, _sourceTaskId, detail) {
      assert.equal(type, "TASK_DONE"); assert.equal(actor, "lead"); recorded = detail;
      return { observation: { record: { sourceEventId: detail.sourceEventId } } };
    } }, event, actor: "lead", buffer() {}, publish() {},
  });
  const leadDetail = recorded as unknown as Record<string, unknown>;
  assert.equal(result.persisted, true);
  assert.equal(leadDetail.resultText, plan);
  assert.equal(Object.hasOwn(leadDetail, "changedFiles"), false);
  assert.equal(Object.hasOwn(leadDetail, "entryFile"), false);
});

test("CONTROLLED: saved Lead plan reader preserves surrounding prose and rejects malformed plan blocks", async (t) => {
  const previous = { url: process.env.IRIXI_AUTHORITY_URL, task: process.env.IRIXI_AUTHORITY_TASK_ID, fetch: globalThis.fetch };
  t.after(() => {
    globalThis.fetch = previous.fetch;
    if (previous.url === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = previous.url;
    if (previous.task === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = previous.task;
  });
  const planText = `**Conclusion:** Create a reusable weekly summary template that helps you capture completed work, outcomes, blockers, and next week’s priorities.\nThis plan follows the task’s concise English instruction over the saved Chinese preference. It preserves the stated goal and boundaries: planning only, no implementation, and no changes to tasks A, B, or C.\n[PLAN]\n- **Purpose:** Make weekly reporting quick, consistent, and useful for personal reflection or sharing.\n- **Sections:** Week and focus; key work completed; outcomes or evidence; blockers and lessons; next week’s priorities; support needed.\n- **Format:** A one-page template with short prompts and space for bullets, designed to be easy to reuse each week.\n- **Check:** Confirm that a completed example can distinguish activity from outcomes and makes next actions clear.\n[/PLAN]`;
  const taskId = "saved-plan-reader-task";
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = taskId;
  let body = { taskId, goalVersionId: "goal-current", executionId: "run-current", registrySha256: H("r"),
    agentId: "product-lead", sourceTaskId: "lead-source", attemptId: "lead-attempt", planText, planSha256: digest(planText) };
  globalThis.fetch = async () => Response.json(body);
  const bridge = createIrixiIntegration();
  assert.ok(bridge);
  const saved = await bridge.productLeadPlan();
  assert.equal(saved?.planText, planText);
  assert.equal(saved?.planSha256, digest(planText));
  const r5PlanText = "[PLAN]\nPreserve the original task scope and report the observed result.未验证。[/PLAN]";
  body = { ...body, planText: r5PlanText, planSha256: digest(r5PlanText) };
  const r5Saved = await bridge.productLeadPlan();
  assert.equal(r5Saved?.planText, r5PlanText);
  assert.equal(r5Saved?.planSha256, digest(r5PlanText));
  body = { ...body, planText: "[PLAN] inline\nempty boundary\n[/PLAN]", planSha256: digest("[PLAN] inline\nempty boundary\n[/PLAN]") };
  await assert.rejects(bridge.productLeadPlan(), /malformed saved Lead plan/);
});

test("CONTROLLED: terminal receipt requires the exact event, attempt, binding, and result hash", () => {
  const expected = {
    type: "TASK_DONE", actor: "lead", sourceTaskId: "lead-current", sourceEventId: "lead-current:attempt-current:TASK_DONE",
    nativeAttemptId: "attempt-current", resultSha256: H("a"), binding: {
      taskId: "task-current", goalVersionId: "goal-current", taskInputBindingSha256: H("1"), pipelineBindingSha256: H("2"),
      executionId: "run-current", workspaceScopeFingerprint: H("3"), sourceSnapshotSha256: H("4"), artifactId: null,
      artifactVersion: null, candidateSha256: null, diffSha256: null, authoritySnapshotSha256: H("5"), sourceTaskId: "lead-current",
    },
  };
  const receipt = { observation: { record: { ...expected }, created: false } };
  assert.equal(integratedTerminalReceiptMatches(receipt, expected), true);
  for (const mismatch of [
    { observation: { ...receipt.observation, record: { ...receipt.observation.record, sourceEventId: "other:TASK_DONE" } } },
    { observation: { ...receipt.observation, record: { ...receipt.observation.record, nativeAttemptId: "other-attempt" } } },
    { observation: { ...receipt.observation, record: { ...receipt.observation.record, binding: { ...expected.binding, goalVersionId: "old-goal" } } } },
    { observation: { ...receipt.observation, record: { ...receipt.observation.record, resultSha256: H("b") } } },
  ]) assert.equal(integratedTerminalReceiptMatches(mismatch, expected), false);
});

test("CONTROLLED: integration rejects a terminal response whose persisted result hash differs", async () => {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalRegistry = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  const originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  const prompt = `Accepted public task\n\n${INTEGRATED_DEVELOPER_TAG}`;
  const current = projection(prompt);
  process.env.IRIXI_AUTHORITY_URL = "http://127.0.0.1:3869/";
  process.env.IRIXI_AUTHORITY_TASK_ID = current.taskId;
  delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/authority") return Response.json({ projection: current });
    if (url.pathname === "/v1/reservations") return Response.json({ reservation: { ok: true } }, { status: 201 });
    if (url.pathname === "/v1/observations") {
      const payload = JSON.parse(String(init?.body));
      if (payload.sourceEventId.endsWith(":rejected:TASK_DONE")) {
        return Response.json({ error: "changedFiles is invalid" }, { status: 400 });
      }
      return Response.json({ observation: { record: {
        type: payload.type, actor: payload.actor, sourceTaskId: payload.sourceTaskId,
        sourceEventId: payload.sourceEventId, nativeAttemptId: null,
        resultSha256: payload.sourceEventId.endsWith(":mismatch:TASK_DONE") ? H("f") : payload.resultSha256,
        binding: payload.binding,
      }, created: false } }, { status: 201 });
    }
    throw new Error(`unexpected controlled URL ${url.pathname}`);
  };
  try {
    const bridge = createIrixiIntegration();
    assert.ok(bridge);
    await bridge.authorize("terminal-receipt-task", "developer", prompt);
    await bridge.record("TASK_DONE", "developer", "terminal-receipt-task", {
      sourceEventId: "terminal-receipt-task:attempt-current:TASK_DONE", resultText: "completed output", scopeOutcome: "completed",
    });
    await assert.rejects(bridge.record("TASK_DONE", "developer", "terminal-receipt-task", {
      sourceEventId: "terminal-receipt-task:mismatch:TASK_DONE", resultText: "completed output", scopeOutcome: "completed",
    }), /does not match the exact terminal source/);
    await assert.rejects(bridge.record("TASK_DONE", "developer", "terminal-receipt-task", {
      sourceEventId: "terminal-receipt-task:rejected:TASK_DONE", resultText: "completed output", scopeOutcome: "completed",
    }), /Irixi observation was rejected \(400\): \{"error":"changedFiles is invalid"\}/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalRegistry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = originalRegistry;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
  }
});

test("CONTROLLED: timed-out terminal write retries once with the identical idempotency key and payload", async () => {
  const event = { type: "TASK_DONE" as const, agentId: "lead-current", taskId: "lead-current", nativeAttemptId: "attempt-current",
    result: { summary: "completed", fullOutput: "completed output", changedFiles: [], diffStat: "", testResult: "passed" as const } };
  let firstWrite: { type: string; actor: string; sourceTaskId: string; detail: Record<string, unknown> } | null = null;
  let attempts = 0;
  const order: string[] = [];
  const result = await persistIntegratedTerminalBeforePublish({
    integration: { async record(type, actor, sourceTaskId, detail) {
      attempts += 1;
      order.push(`record:${type}`);
      const current = { type, actor, sourceTaskId, detail: structuredClone(detail) };
      if (attempts === 1) {
        firstWrite = current; // The Authority committed, but the first receipt was lost to timeout.
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      }
      assert.deepEqual(current, firstWrite);
      return { record: { sourceEventId: detail.sourceEventId }, created: false };
    } },
    event, actor: "lead",
    buffer(value) { assert.equal(value, event); order.push("buffer"); },
    publish(value) { assert.equal(value, event); order.push("publish"); },
  });
  assert.equal(result.persisted, true);
  assert.equal(attempts, 2);
  assert.deepEqual(order, ["record:TASK_DONE", "record:TASK_DONE", "buffer", "publish"]);
});

test("product learning uses its registered task without enabling legacy project intake", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "product-learning-registry-")));
  const workspace = path.join(root, "workspace");
  mkdirSync(workspace);
  const html = "<!doctype html><main>fixture</main>\n";
  writeFileSync(path.join(workspace, "index.html"), html);
  const registryFile = path.join(root, "registry.json");
  const registry = {
    schemaVersion: 1,
    projectId: "article-learning-12",
    taskId: "task-product-learning-test",
    goalVersionId: "goal-current",
    taskInputBindingSha256: H("a"),
    pipelineBindingSha256: H("b"),
    authorityUrl: "http://127.0.0.1:3869/",
    workspace: {
      path: workspace,
      scopeFingerprint: H("c"),
      sourceSnapshotSha256: H("d"),
      sourceHead: "e".repeat(40),
      sourceManifest: [{ path: "index.html", bytes: Buffer.byteLength(html), sha256: digest(html), mode: 0o644 }],
      allowedWritePaths: ["index.html"],
      checks: ["node-syntax-v1"],
    },
    native: {
      backend: "codex", model: "gpt-6-luna", allowedRoles: ["Lead"], maxModelCalls: 8, maxDurationMs: 1_200_000,
      promptBudget: { contextWindowTokens: 128_000, effectiveContextPercent: 95, outputTokens: 8_192, protocolTokens: 4_096 },
    },
    capabilities: {
      team: false, worktree: false, staticPreviewEntries: ["index.html"], staticPreviewFiles: ["index.html"],
      autoMerge: false, manualMerge: false, commandPreview: false,
    },
  };
  writeFileSync(registryFile, JSON.stringify(registry));

  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.IRIXI_AUTHORITY_URL;
  const originalTask = process.env.IRIXI_AUTHORITY_TASK_ID;
  const originalIntake = process.env.IRIXI_INTAKE_TASK_ID;
  const originalRegistry = process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
  const originalProject = process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
  const originalConfig = process.env.OPEN_OFFICE_CONFIG_DIR;
  const requests: string[] = [];
  const sourceTaskId = "learning-76b58201-26d0-4471-b5fa-b84ff1a6c7ae";
  const reservedPrompt = `${ARTICLE_INFERENCE_TAG}\nRegistered synthetic learning request.`;
  let current = {
    ...projection("registered product execution"),
    taskId: registry.taskId,
    taskInputBindingSha256: registry.taskInputBindingSha256,
    pipelineBindingSha256: registry.pipelineBindingSha256,
    workspace: { current: true, scopeFingerprint: registry.workspace.scopeFingerprint, sourceSnapshotSha256: registry.workspace.sourceSnapshotSha256 },
  };
  const order: string[] = [];
  try {
    process.env.IRIXI_AUTHORITY_URL = registry.authorityUrl;
    process.env.IRIXI_AUTHORITY_TASK_ID = registry.taskId;
    process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = registryFile;
    process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = registry.projectId;
    process.env.OPEN_OFFICE_CONFIG_DIR = path.join(root, "openoffice-config");
    mkdirSync(process.env.OPEN_OFFICE_CONFIG_DIR);
    delete process.env.IRIXI_INTAKE_TASK_ID;
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      requests.push(`${String(init?.method || "GET").toUpperCase()} ${url.pathname}`);
      if (url.pathname === "/v1/authority") return Response.json({ projection: current });
      if (url.pathname === "/v1/inference/reservations") return Response.json({
        sourceTaskId, prompt: reservedPrompt, promptSha256: digest(reservedPrompt), turnId: "turn-registered", remaining: 7,
      }, { status: 201 });
      if (url.pathname === "/v1/inference/failures") {
        order.push("persist");
        return Response.json({ ok: true }, { status: 201 });
      }
      return Response.json({ ok: true }, { status: url.pathname === "/v1/materials" ? 201 : 200 });
    };

    const { irixiPublicIntegration: bridge } = await import("./ws-server.js");
    assert.ok(bridge);
    await bridge.publicIntake();
    await bridge.clientState({ scope: "project" });
    await bridge.registerLearningMaterial({ sessionId: "session-current", label: "Fixture", articleText: "Synthetic test text." });
    await bridge.openLearningBatch({ expectedGoalVersionId: registry.goalVersionId, expectedCandidateSha256: H("f") });
    assert.deepEqual(requests.slice(0, 4), [
      "GET /v1/intake", "GET /v1/learning/client-state", "POST /v1/materials", "POST /v1/learning/open-batch",
    ]);

    const reservation = await bridge.beginInference({
      sessionId: "session-current", turnId: "turn-registered", kind: "explain", articleSha256: H("e"), payload: { answer: "synthetic" },
    });
    assert.equal(bridge.hasInferenceReservation(sourceTaskId), true);
    assert.equal(bridge.hasInferenceReservation("learning-arbitrary"), false);
    const conversationPrompt = `IRIXI_PRODUCT_CONVERSATION_V1\nRead-only learning call.\n\n${reservation.prompt}`;
    const duplicateInstance = createIrixiIntegration();
    assert.ok(duplicateInstance);
    await assert.rejects(
      duplicateInstance.authorize(sourceTaskId, "reviewer", conversationPrompt, undefined, workspace),
      /Irixi has no current host-verified candidate for review/,
      "the old split-instance wiring loses the registered inference context",
    );
    await assert.rejects(
      bridge.authorize(sourceTaskId, "reviewer", undefined, undefined, workspace),
      /Learning inference must use the registered read-only conversation phase/,
      "a registered inference still rejects a missing conversation prompt",
    );
    await bridge.authorize(sourceTaskId, "reviewer", conversationPrompt, undefined, workspace);
    await assert.rejects(
      bridge.authorize("learning-arbitrary", "reviewer", conversationPrompt, undefined, workspace),
      /Irixi has no current host-verified candidate for review/,
      "unregistered learning-like IDs do not gain conversation authorization",
    );

    const failed = { type: "TASK_FAILED" as const, agentId: "product-lead", taskId: sourceTaskId, error: "authorization failed" };
    const persisted = await persistInferenceStartFailureBeforePublish({
      integration: bridge, event: failed,
      buffer() { order.push("buffer"); }, publish() { order.push("publish"); },
    });
    assert.equal(persisted.persisted, true);
    assert.equal(bridge.hasInferenceReservation(sourceTaskId), false, "terminal persistence consumes the exact in-memory reservation");
    assert.deepEqual(order, ["persist", "buffer", "publish"], "reserved inference failures settle before notification");
    assert.ok(requests.includes("POST /v1/inference/failures"));
    const beforeUnregisteredFailure = requests.length;
    const unregisteredFailure = { ...failed, taskId: "unregistered-task" };
    const unregistered = await persistInferenceStartFailureBeforePublish({
      integration: bridge, event: unregisteredFailure,
      buffer() { order.push("buffer-unregistered"); }, publish() { order.push("publish-unregistered"); },
    });
    assert.equal(unregistered.persisted, false);
    assert.equal(requests.length, beforeUnregisteredFailure, "unregistered task failures do not reach the inference receipt route");
    assert.deepEqual(order.slice(-2), ["buffer-unregistered", "publish-unregistered"]);

    await assert.rejects(bridge.setIntakeDiscussionEnabled(true), /Irixi project intake is not enabled/);
    await assert.rejects(bridge.authorizeIntake("legacy-intake-task", `${PROJECT_INTAKE_TAG}\nRead-only discussion`), /not the registered/);
    await assert.rejects(bridge.coordinateSealedInferenceResult({
      expectedGoalVersionId: registry.goalVersionId, expectedCandidateSha256: H("f"), expectedTurnId: "turn-current",
      sourceTaskId: "source-current", expectedSessionId: "session-current", expectedMaterialEventId: "event-material",
      expectedArticleSha256: H("a"), expectedPromptSha256: H("b"), expectedLedgerSha256: H("c"),
      expectedStdoutSha256: H("d"), expectedOriginalTransportTextSha256: H("e"),
      hostProofFile: "proof.json", hostProofSha256: H("f"),
    }), /Irixi project intake is not enabled/);
    assert.ok(requests.length > 4, "registered product inference uses only its exact current Authority routes");

    delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE;
    delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID;
    const legacy = createIrixiIntegration();
    assert.ok(legacy);
    await assert.rejects(legacy.publicIntake(), /Irixi project intake is not enabled/);
    assert.ok(requests.includes("POST /v1/inference/failures"), "terminal receipt remains in the existing Authority route");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.IRIXI_AUTHORITY_URL; else process.env.IRIXI_AUTHORITY_URL = originalUrl;
    if (originalTask === undefined) delete process.env.IRIXI_AUTHORITY_TASK_ID; else process.env.IRIXI_AUTHORITY_TASK_ID = originalTask;
    if (originalIntake === undefined) delete process.env.IRIXI_INTAKE_TASK_ID; else process.env.IRIXI_INTAKE_TASK_ID = originalIntake;
    if (originalRegistry === undefined) delete process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE; else process.env.OPEN_OFFICE_PRODUCT_REGISTRY_FILE = originalRegistry;
    if (originalProject === undefined) delete process.env.OPEN_OFFICE_IRIXI_PROJECT_ID; else process.env.OPEN_OFFICE_IRIXI_PROJECT_ID = originalProject;
    if (originalConfig === undefined) delete process.env.OPEN_OFFICE_CONFIG_DIR; else process.env.OPEN_OFFICE_CONFIG_DIR = originalConfig;
    rmSync(root, { recursive: true, force: true });
  }
});
