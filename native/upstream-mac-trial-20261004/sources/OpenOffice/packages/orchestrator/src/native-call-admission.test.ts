import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { AgentSession, isTransientNativeAdmissionTransportError, resolveNativeTaskTimeoutMs, setSessionDir } from "./agent-session.js";
import { Orchestrator } from "./orchestrator.js";
import { setStorageRoot } from "./memory.js";
import type { AIBackend } from "./ai-backend.js";

test("product authority deadline replaces the generic team timeout", () => {
  assert.equal(resolveNativeTaskTimeoutMs(undefined, true), 0);
  assert.equal(resolveNativeTaskTimeoutMs("team", true), 3 * 60_000);
  assert.equal(resolveNativeTaskTimeoutMs("team", true, 17 * 60_000), 17 * 60_000);
  assert.equal(resolveNativeTaskTimeoutMs("team", false, 5 * 60_000), 5 * 60_000);
});

test("native admission rejection happens before task:started and process spawn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-native-admission-"));
  setSessionDir(root);
  const events: Array<{ type: string; error?: string }> = [];
  let admissions = 0;
  const backend: AIBackend = {
    id: "controlled-no-model",
    name: "Controlled no-model backend",
    command: "/usr/bin/false",
    buildArgs: () => [],
  };
  const session = new AgentSession({
    agentId: "agent-guard", name: "Guard", role: "Developer", workspace: root, backend,
    onEvent: (event) => events.push(event as { type: string; error?: string }),
    renderPrompt: (_name, vars) => String(vars.prompt || ""),
    beforeNativeCall: async (context) => {
      admissions += 1;
      assert.equal(context.workspace, root);
      assert.match(context.promptSha256, /^[a-f0-9]{64}$/);
      throw new Error("authority rejected current goal");
    },
  });
  await session.runTask("task-one", "Do the registered work", root, undefined, true);
  assert.equal(admissions, 1);
  assert.equal(session.pid, null);
  assert.equal(events.some((event) => event.type === "task:started"), false);
  assert.deepEqual(events.map((event) => event.type), ["agent:status", "task:failed"]);
  assert.match(events.at(-1)?.error || "", /authority rejected/);
});

test("a child-process spawn error never emits task:started", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-native-spawn-error-"));
  setSessionDir(root);
  setStorageRoot(root);
  const events: Array<{ type: string; error?: string }> = [];
  let resolveFailure!: () => void;
  const failed = new Promise<void>((resolve) => { resolveFailure = resolve; });
  const backend: AIBackend = {
    id: "controlled-no-model", name: "Missing executable", command: path.join(root, "missing-executable"),
    buildArgs: () => [],
  };
  const session = new AgentSession({
    agentId: "agent-spawn-error", name: "Spawn error", role: "Developer", workspace: root, backend,
    onEvent: (event) => {
      const value = event as { type: string; error?: string };
      events.push(value);
      if (value.type === "task:failed") resolveFailure();
    },
    renderPrompt: (_name, vars) => String(vars.prompt || ""),
  });
  try {
    await session.runTask("task-spawn-error", "No model should start", root, undefined, true);
    await failed;
    assert.equal(events.some((event) => event.type === "task:started"), false);
    assert.ok(events.some((event) => event.type === "task:failed"));
  } finally { session.destroy(); rmSync(root, { recursive: true, force: true }); }
});

test("transient native admission retries once with the exact same attempt context", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-native-retry-"));
  setSessionDir(root);
  const contexts: unknown[] = [];
  const backend: AIBackend = {
    id: "controlled-no-model", name: "Controlled no-model backend", command: "/usr/bin/false",
    buildArgs: () => { throw new Error("stop after admission"); },
  };
  const session = new AgentSession({
    agentId: "agent-retry", name: "Retry", role: "Developer", workspace: root, backend,
    onEvent: () => {}, renderPrompt: (_name, vars) => String(vars.prompt || ""),
    beforeNativeCall: async (context) => {
      contexts.push(context);
      if (contexts.length === 1) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
      return { timeoutMs: 1_000 };
    },
  });
  try {
    await session.runTask("task-retry", "Do the registered work", root, undefined, true);
    assert.equal(contexts.length, 2);
    assert.equal(contexts[0], contexts[1]);
    assert.equal((contexts[0] as { attemptId: string }).attemptId, (contexts[1] as { attemptId: string }).attemptId);
    assert.equal(session.pid, null);
  } finally { session.destroy(); rmSync(root, { recursive: true, force: true }); }
});

test("cancellation during native admission prevents a late grant from starting or overwriting the task", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-native-cancel-admission-"));
  setSessionDir(root);
  setStorageRoot(root);
  const events: Array<{ type: string; status?: string; error?: string }> = [];
  let resolveAdmission!: (value: { timeoutMs: number }) => void;
  const lateAdmission = new Promise<{ timeoutMs: number }>((resolve) => { resolveAdmission = resolve; });
  let resolveAdmissionStarted!: () => void;
  const admissionStarted = new Promise<void>((resolve) => { resolveAdmissionStarted = resolve; });
  let spawnCalls = 0;
  const backend: AIBackend = {
    id: "controlled-no-model", name: "No-model cancellation test", command: "/not-executed",
    buildArgs: () => [],
  };
  const session = new AgentSession({
    agentId: "agent-cancel-admission", name: "Cancel admission", role: "Developer", workspace: root, backend,
    onEvent: (event) => events.push(event as { type: string; status?: string; error?: string }),
    renderPrompt: (_name, vars) => String(vars.prompt || ""),
    beforeNativeCall: async () => {
      resolveAdmissionStarted();
      return lateAdmission;
    },
    spawnProcess: (() => {
      spawnCalls += 1;
      throw new Error("a cancelled attempt must not invoke the process spawner");
    }) as typeof spawn,
  });
  try {
    const running = session.runTask("task-cancel-admission", "No model should start", root, undefined, true);
    await admissionStarted;
    session.cancelTask("Cancelled while native admission was pending");
    resolveAdmission({ timeoutMs: 30_000 });
    await running;

    assert.equal(spawnCalls, 0);
    assert.equal(events.some((event) => event.type === "task:started"), false);
    const failures = events.filter((event) => event.type === "task:failed");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.error, "Cancelled while native admission was pending");
    assert.notEqual(session.status, "working");
  } finally { session.destroy(); rmSync(root, { recursive: true, force: true }); }
});

test("native admission never retries authority or validation rejections", () => {
  for (const status of [401, 403, 409]) {
    assert.equal(isTransientNativeAdmissionTransportError(Object.assign(new TypeError(`fetch failed: rejected (${status})`), { status })), false);
  }
  assert.equal(isTransientNativeAdmissionTransportError(new Error("binding validation failed")), false);
  assert.equal(isTransientNativeAdmissionTransportError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } })), true);
});

test("authority deadline consumed by preflight prevents process spawn", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-native-deadline-"));
  setSessionDir(root);
  const events: Array<{ type: string }> = [];
  let buildArgs = 0;
  const backend: AIBackend = {
    id: "controlled-no-model", name: "Controlled no-model backend", command: process.execPath,
    buildArgs: () => {
      buildArgs += 1;
      const until = performance.now() + 15;
      while (performance.now() < until) { /* controlled pre-spawn delay */ }
      return ["-e", "process.exit(99)"];
    },
  };
  const session = new AgentSession({
    agentId: "agent-deadline", name: "Deadline", role: "Developer", workspace: root, backend,
    onEvent: (event) => events.push(event as { type: string }), renderPrompt: (_name, vars) => String(vars.prompt || ""),
    beforeNativeCall: async () => ({ timeoutMs: 5 }),
  });
  try {
    await session.runTask("task-deadline", "Do the registered work", root, undefined, true);
    assert.equal(buildArgs, 1);
    assert.equal(session.pid, null);
    assert.equal(events.some((event) => event.type === "task:started"), false);
    assert.deepEqual(events.map((event) => event.type), ["agent:status", "task:failed"]);
  } finally { session.destroy(); rmSync(root, { recursive: true, force: true }); }
});

test("native deadline that expires during spawn confirmation kills immediately without sending the prompt", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-native-late-spawn-"));
  setSessionDir(root);
  setStorageRoot(root);
  const events: Array<{ type: string; error?: string }> = [];
  let resolveFailure!: () => void;
  const failed = new Promise<void>((resolve) => { resolveFailure = resolve; });
  const killSignals: Array<NodeJS.Signals | undefined> = [];
  const childEmitter = new EventEmitter();
  const child = Object.assign(childEmitter, {
    pid: 2_147_483_647,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    killed: false,
    kill(signal?: NodeJS.Signals) {
      killSignals.push(signal);
      this.killed = true;
      queueMicrotask(() => {
        this.signalCode = signal ?? "SIGKILL";
        childEmitter.emit("exit", null, this.signalCode);
        childEmitter.emit("close", null);
      });
      return true;
    },
  }) as unknown as ChildProcess;
  const backend: AIBackend = {
    id: "controlled-no-model", name: "No-model late-spawn test", command: "/not-executed",
    buildArgs: () => [],
  };
  const session = new AgentSession({
    agentId: "agent-late-spawn", name: "Late spawn", role: "Developer", workspace: root, backend,
    onEvent: (event) => {
      const value = event as { type: string; error?: string };
      events.push(value);
      if (value.type === "task:failed") resolveFailure();
    },
    renderPrompt: (_name, vars) => String(vars.prompt || ""),
    beforeNativeCall: async () => ({ timeoutMs: 1_000 }),
    spawnProcess: (() => {
      setTimeout(() => child.emit("spawn"), 1_100);
      return child;
    }) as typeof spawn,
  });
  try {
    await session.runTask("task-late-spawn", "Do not send this prompt after the deadline", root, undefined, true);
    await failed;
    assert.deepEqual(events.filter((event) => event.type === "task:started").map((event) => event.type), ["task:started"]);
    assert.equal(events.at(-1)?.error, "native_process_timeout");
    assert.deepEqual(killSignals, ["SIGKILL"]);
    assert.equal(child.stdin?.writableEnded, false);
  } finally { session.destroy(); rmSync(root, { recursive: true, force: true }); }
});

test("only product-bound GPT-6 Luna calls pass the medium effort override to Codex", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-product-reasoning-"));
  setSessionDir(root);
  const capture = async (model: string, productBound: boolean) => {
    let effort: string | undefined;
    const backend: AIBackend = {
      id: "codex", name: "Codex", command: "/usr/bin/false",
      buildArgs: (_prompt, opts) => {
        effort = opts.modelReasoningEffort;
        throw new Error("stop after argument capture");
      },
    };
    const session = new AgentSession({
      agentId: `effort-${model}-${productBound}`, name: "Effort", role: "Developer", workspace: root,
      backend, model, beforeNativeCall: productBound ? async () => undefined : undefined,
      onEvent: () => {}, renderPrompt: (_name, vars) => String(vars.prompt || ""),
    });
    try { await session.runTask("task-effort", "Do the registered work", root, undefined, true); }
    finally { session.destroy(); }
    return effort;
  };
  try {
    assert.equal(await capture("gpt-6-luna", true), "medium");
    assert.equal(await capture("gpt-6-luna", false), undefined);
    assert.equal(await capture("gpt-5.6-sol", true), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("system guard cancellation keeps its reason distinct from a user cancellation", () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-cancel-reason-"));
  setSessionDir(root);
  const backend: AIBackend = {
    id: "controlled-no-model",
    name: "Controlled no-model backend",
    command: "/usr/bin/false",
    buildArgs: () => [],
  };
  const makeSession = (events: Array<{ type: string; error?: string }>) => new AgentSession({
    agentId: "agent-cancel", name: "Cancel", role: "Developer", workspace: root, backend,
    onEvent: (event) => events.push(event as { type: string; error?: string }),
    renderPrompt: (_name, vars) => String(vars.prompt || ""),
  });

  const userEvents: Array<{ type: string; error?: string }> = [];
  const userSession = makeSession(userEvents);
  userSession.cancelTask();
  assert.equal(userEvents.at(-1)?.error, "Task cancelled by user");
  userSession.destroy();

  const systemEvents: Array<{ type: string; error?: string }> = [];
  const systemSession = makeSession(systemEvents);
  systemSession.cancelTask("Task cancelled by product binding guard: authority_projection_error");
  assert.equal(systemEvents.at(-1)?.error, "Task cancelled by product binding guard: authority_projection_error");
  systemSession.destroy();
});

test("system guard cancellation does not enter the automatic retry path", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-guard-stop-"));
  setSessionDir(path.join(root, "sessions"));
  setStorageRoot(path.join(root, "memory"));
  let spawns = 0;
  const backend: AIBackend = {
    id: "controlled-waiter",
    name: "Controlled waiter",
    command: process.execPath,
    buildArgs: () => { spawns += 1; return ["-e", "setTimeout(() => {}, 5000)"]; },
  };
  const orchestrator = new Orchestrator({ workspace: root, backends: [backend], worktree: false });
  const retries: unknown[] = [];
  orchestrator.on("task:retrying", (event) => retries.push(event));
  try {
    orchestrator.createAgent({ agentId: "guarded", name: "Guarded", role: "Developer" });
    const failed = new Promise<{ error: string }>((resolve) => {
      orchestrator.once("task:failed", (event) => resolve(event));
    });
    orchestrator.runTask("guarded", "task-guarded", "Run only until the guard check");
    for (let attempt = 0; attempt < 50 && !orchestrator.getAgent("guarded")?.pid; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(orchestrator.getAgent("guarded")?.pid, "controlled process should start before the guard abort");
    orchestrator.cancelTask("guarded", "Task cancelled by product binding guard: authority_projection_error");
    const failure = await failed;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.match(failure.error, /product binding guard/);
    assert.equal(retries.length, 0);
    assert.equal(spawns, 1);
  } finally {
    orchestrator.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
