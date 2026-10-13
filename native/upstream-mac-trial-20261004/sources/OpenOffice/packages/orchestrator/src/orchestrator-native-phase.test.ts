import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { AIBackend } from "./ai-backend.js";
import { parseDelegationLine, setSessionDir } from "./agent-session.js";
import { setStorageRoot } from "./memory.js";
import { Orchestrator } from "./orchestrator.js";
import type { NativeCallContext, OrchestratorEvent } from "./types.js";

test("parses the exact full-width role separator emitted by the native Lead", () => {
  assert.deepEqual(parseDelegationLine("@Senior Developer：已分配已批准计划中的端到端 BUILD，范围限于六个授权文件，并要求保留现有改动、完成规定检查和页面验收记录。此轮未分配 Reviewer。"), {
    targetName: "Senior Developer",
    prompt: "已分配已批准计划中的端到端 BUILD，范围限于六个授权文件，并要求保留现有改动、完成规定检查和页面验收记录。此轮未分配 Reviewer。",
  });
});

function waitForTask(
  orchestrator: Orchestrator,
  predicate: (event: Extract<OrchestratorEvent, { type: "task:done" }>) => boolean,
) {
  return new Promise<Extract<OrchestratorEvent, { type: "task:done" }>>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      orchestrator.off("task:done", onDone);
      orchestrator.off("task:failed", onFailed);
    };
    const onDone = (event: Extract<OrchestratorEvent, { type: "task:done" }>) => {
      if (!predicate(event)) return;
      cleanup();
      resolve(event);
    };
    const onFailed = (event: Extract<OrchestratorEvent, { type: "task:failed" }>) => {
      cleanup();
      reject(new Error(`${event.taskId}: ${event.error}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the native phase test task"));
    }, 10_000);
    orchestrator.on("task:done", onDone);
    orchestrator.on("task:failed", onFailed);
  });
}

test("native admission keeps create, approved execute, automatic Lead follow-up, conversation, and unknown phases distinct", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-office-native-phase-"));
  setSessionDir(path.join(root, "sessions"));
  setStorageRoot(path.join(root, "memory"));

  const outputs = [
    "[PLAN]\nSUMMARY: proposed plan",
    "@Developer: Implement the approved task",
    "STATUS: done\nSUMMARY: worker completed the task",
    "STATUS: done\nSUMMARY: approved work is complete",
    "Conversation status is available.",
    "This output must never be spawned.",
  ];
  let spawned = 0;
  const admissions: NativeCallContext[] = [];
  const backend: AIBackend = {
    id: "controlled-local-process",
    name: "Controlled local process",
    command: process.execPath,
    buildArgs() {
      const output = outputs[spawned++];
      return ["-e", `process.stdout.write(${JSON.stringify(output ?? "unexpected extra spawn")})`];
    },
  };
  const orchestrator = new Orchestrator({
    workspace: root,
    backends: [backend],
    worktree: false,
    retry: false,
    beforeNativeCall: async (context) => {
      admissions.push(context);
      if (context.phase === "unknown") throw new Error("Unknown native phase rejected");
    },
  });

  try {
    orchestrator.createAgent({ agentId: "lead", name: "Lead", role: "Team Lead", teamId: "team-1" });
    orchestrator.createAgent({ agentId: "developer", name: "Developer", role: "Developer", teamId: "team-1" });
    orchestrator.setTeamLead("lead");
    orchestrator.setTeamPhase("team-1", "create", "lead");

    const planDone = waitForTask(orchestrator, (event) => event.taskId === "create-plan");
    orchestrator.runTask("lead", "create-plan", "Plan the registered project", { phaseOverride: "create" });
    await planDone;
    assert.equal(orchestrator.getTeamPhase("lead"), "design");

    assert.equal(orchestrator.approvePlan("lead")?.phase, "execute");
    const finalDone = waitForTask(orchestrator, (event) => event.isFinalResult === true);
    orchestrator.runTask("lead", "approved-execute", "Execute the explicitly approved plan", { phaseOverride: "execute" });
    const final = await finalDone;

    assert.notEqual(final.taskId, "approved-execute");
    assert.equal(orchestrator.getTeamPhase("lead"), "complete");
    assert.deepEqual(
      admissions.filter((call) => call.agentId === "lead").slice(0, 3).map((call) => call.phase),
      ["create", "execute", "execute"],
      "the worker-result scheduler must resume the Lead using the authoritative execute phase",
    );

    const conversationDone = waitForTask(orchestrator, (event) => event.taskId === "status-conversation");
    orchestrator.runTask("lead", "status-conversation", "Read-only status question", { phaseOverride: "conversation" });
    await conversationDone;
    assert.equal(admissions.at(-1)?.phase, "conversation");
    assert.equal(orchestrator.getTeamPhase("lead"), "complete");

    const spawnedBeforeUnknownPhase = spawned;
    const rejectedUnknownPhase = new Promise<Extract<OrchestratorEvent, { type: "task:failed" }>>((resolve) => {
      orchestrator.once("task:failed", resolve);
    });
    orchestrator.runTask("lead", "unknown-phase", "This must fail closed", { phaseOverride: "unknown" });
    const failure = await rejectedUnknownPhase;
    assert.equal(failure.taskId, "unknown-phase");
    assert.match(failure.error, /Unknown native phase rejected/);
    assert.equal(admissions.at(-1)?.phase, "unknown", "the orchestrator must not relabel an unknown phase as execute");
    assert.equal(spawned, spawnedBeforeUnknownPhase, "rejected unknown phase must fail before process spawn");
  } finally {
    orchestrator.destroy();
    rmSync(root, { recursive: true, force: true });
  }
});
