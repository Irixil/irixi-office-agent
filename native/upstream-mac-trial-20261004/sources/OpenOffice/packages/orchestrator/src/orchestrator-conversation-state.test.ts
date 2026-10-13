import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AIBackend } from "./ai-backend.js";
import type { AgentSession } from "./agent-session.js";
import { setSessionDir } from "./agent-session.js";
import { setStorageRoot } from "./memory.js";
import { Orchestrator } from "./orchestrator.js";
import type { OrchestratorEvent } from "./types.js";

type Internals = {
  agentManager: { get(id: string): AgentSession | undefined };
  delegationRouter: {
    tasks: Map<string, unknown>;
    totalDelegations: number;
    isDelegated(taskId: string): boolean;
    setTeamProjectDir(dir: string): void;
    getTeamProjectDir(): string | null;
  };
  teamPreview: unknown;
  teamChangedFiles: Set<string>;
  teamFinalized: boolean;
};

function fixture(output = "@Worker: do not dispatch this chat line\n[PLAN]\nConversation answer only.\n") {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-conversation-state-"));
  setSessionDir(path.join(root, "sessions"));
  setStorageRoot(path.join(root, "memory"));
  const buildArgs: Array<{ readOnly?: boolean; noTools?: boolean }> = [];
  const backend: AIBackend = {
    id: "controlled-local-process",
    name: "Controlled local process",
    command: process.execPath,
    buildArgs(_prompt, options) {
      buildArgs.push({ readOnly: options.readOnly, noTools: options.noTools });
      return ["-e", `process.stdout.write(${JSON.stringify(output)})`];
    },
  };
  const orchestrator = new Orchestrator({ workspace: root, backends: [backend], worktree: false, retry: false });
  const events: OrchestratorEvent[] = [];
  const eventTypes = ["task:done", "task:failed", "task:queued", "task:delegated", "team:phase", "team:chat"] as const;
  for (const type of eventTypes) orchestrator.on(type, (event: OrchestratorEvent) => events.push(event));
  orchestrator.createAgent({ agentId: "lead", name: "Lead", role: "Team Lead", teamId: "team-1" });
  orchestrator.createAgent({ agentId: "worker", name: "Worker", role: "Developer", teamId: "team-1" });
  orchestrator.setTeamLead("lead");
  orchestrator.setTeamPhase("team-1", "create", "lead");
  events.length = 0;

  const internals = orchestrator as unknown as Internals;
  const lead = internals.agentManager.get("lead")!;
  const worker = internals.agentManager.get("worker")!;
  lead.originalTask = "Original approved project task";
  lead.currentPhase = "create";
  (lead as unknown as { _lastFullOutput: string; _lastResultText: string; _lastResult: string })._lastFullOutput = "Original project plan output";
  (lead as unknown as { _lastResultText: string })._lastResultText = "Original structured project result";
  (lead as unknown as { _lastResult: string })._lastResult = "done: original project result";
  lead.lastSummary = "Original project summary";
  internals.delegationRouter.tasks.set("existing-delegation", { origin: "lead", depth: 1 });
  internals.delegationRouter.totalDelegations = 1;
  internals.delegationRouter.setTeamProjectDir(root);
  internals.teamPreview = { entryFile: "existing.html" };
  internals.teamChangedFiles = new Set(["existing.ts"]);
  internals.teamFinalized = true;

  return { root, orchestrator, internals, lead, worker, events, buildArgs };
}

function controlledBusyProcess() {
  return { pid: undefined, kill() {} };
}

test("a real controlled conversation preserves the current native project and cannot delegate or advance phases", async () => {
  const value = fixture();
  try {
    const terminal = new Promise<Extract<OrchestratorEvent, { type: "task:done" }>>((resolve, reject) => {
      value.orchestrator.once("task:done", resolve);
      value.orchestrator.once("task:failed", (event) => reject(new Error(event.error)));
    });
    value.orchestrator.runTask("lead", "conversation-1", "What is the current status?", { phaseOverride: "conversation" });
    const done = await terminal;

    assert.equal(done.taskId, "conversation-1");
    assert.equal(done.isFinalResult, undefined);
    assert.deepEqual(value.buildArgs, [{ readOnly: true, noTools: true }]);
    assert.equal(value.orchestrator.getTeamPhase("lead"), "create");
    assert.equal(value.orchestrator.getOriginalTask("lead"), "Original approved project task");
    assert.equal(value.orchestrator.getLeaderLastOutput("lead"), "Original project plan output");
    assert.equal(value.lead.lastSummary, "Original project summary");
    assert.equal(value.lead.lastResult, "done: original project result");
    assert.equal(value.lead.currentPhase, "create");
    assert.equal(value.internals.delegationRouter.isDelegated("existing-delegation"), true);
    assert.equal(value.internals.delegationRouter.getTeamProjectDir(), value.root);
    assert.deepEqual(value.internals.teamPreview, { entryFile: "existing.html" });
    assert.deepEqual([...value.internals.teamChangedFiles], ["existing.ts"]);
    assert.equal(value.internals.teamFinalized, true);
    assert.equal(value.events.some((event) => event.type === "task:delegated"), false);
    assert.equal(value.events.some((event) => event.type === "team:phase"), false);
  } finally {
    value.orchestrator.destroy();
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("registered product Reviewer receives only the supplied candidate and no tools", async () => {
  const value = fixture("VERDICT: PASS\nSUMMARY: controlled product review\n");
  value.orchestrator.createAgent({ agentId: "reviewer", name: "Reviewer", role: "Reviewer", teamId: "team-1" });
  try {
    const terminal = new Promise<Extract<OrchestratorEvent, { type: "task:done" }>>((resolve, reject) => {
      value.orchestrator.once("task:done", resolve);
      value.orchestrator.once("task:failed", (event) => reject(new Error(event.error)));
    });
    value.orchestrator.runTask("reviewer", "product-review-1",
      "IRIXI_PRODUCT_REVIEW_V1\nReview only the registered candidate and host evidence.",
      { phaseOverride: "review" });
    await terminal;

    assert.deepEqual(value.buildArgs, [{ readOnly: true, noTools: true }]);
  } finally {
    value.orchestrator.destroy();
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("a busy lead queues a conversation without resetting project state first", () => {
  const value = fixture();
  try {
    (value.lead as unknown as { process: unknown }).process = controlledBusyProcess();
    value.orchestrator.runTask("lead", "conversation-queued", "Queue this read-only question", { phaseOverride: "conversation" });

    assert.equal(value.events.some((event) => event.type === "task:queued" && event.taskId === "conversation-queued"), true);
    assert.equal(value.orchestrator.getOriginalTask("lead"), "Original approved project task");
    assert.equal(value.internals.delegationRouter.isDelegated("existing-delegation"), true);
    assert.deepEqual(value.internals.teamPreview, { entryFile: "existing.html" });
    assert.deepEqual([...value.internals.teamChangedFiles], ["existing.ts"]);
    assert.equal(value.internals.teamFinalized, true);
  } finally {
    (value.lead as unknown as { process: unknown }).process = null;
    (value.lead as unknown as { taskQueue: unknown[] }).taskQueue = [];
    value.orchestrator.destroy();
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("an ordinary lead task retains the existing fresh-project reset behavior", () => {
  const value = fixture();
  try {
    (value.lead as unknown as { process: unknown }).process = controlledBusyProcess();
    value.orchestrator.runTask("lead", "project-2", "Start a different authorized project task");

    assert.equal(value.orchestrator.getOriginalTask("lead"), "Start a different authorized project task");
    assert.equal(value.internals.delegationRouter.isDelegated("existing-delegation"), false);
    assert.equal(value.internals.delegationRouter.getTeamProjectDir(), value.root);
    assert.equal(value.internals.teamPreview, null);
    assert.deepEqual([...value.internals.teamChangedFiles], []);
    assert.equal(value.internals.teamFinalized, false);
  } finally {
    (value.lead as unknown as { process: unknown }).process = null;
    (value.lead as unknown as { taskQueue: unknown[] }).taskQueue = [];
    value.orchestrator.destroy();
    rmSync(value.root, { recursive: true, force: true });
  }
});
