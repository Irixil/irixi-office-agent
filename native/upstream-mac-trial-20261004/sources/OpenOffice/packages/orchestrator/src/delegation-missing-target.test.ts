import assert from "node:assert/strict";
import test from "node:test";

import { AgentManager } from "./agent-manager.js";
import type { AgentSession } from "./agent-session.js";
import { DelegationRouter } from "./delegation.js";
import type { PromptEngine } from "./prompt-templates.js";
import type { OrchestratorEvent } from "./types.js";

type Run = { taskId: string; prompt: string; repoPath?: string; teamContext?: string; phaseOverride?: string };

function session(input: {
  agentId: string;
  name: string;
  role: string;
  teamId: string;
  runs?: Run[];
}): AgentSession {
  const runs = input.runs ?? [];
  return {
    ...input,
    status: "idle",
    lastResult: null,
    currentPhase: "execute",
    workspaceDir: "/tmp/delegation-resolver-test",
    runTask(taskId: string, prompt: string, repoPath?: string, teamContext?: string, _isUserInitiated?: boolean, phaseOverride?: string) {
      runs.push({ taskId, prompt, repoPath, teamContext, phaseOverride });
    },
    destroy() {},
  } as unknown as AgentSession;
}

function fixture(guardDelegation?: ConstructorParameters<typeof DelegationRouter>[4]) {
  const manager = new AgentManager();
  const events: OrchestratorEvent[] = [];
  const promptEngine = {
    render(name: string, values: Record<string, string>) {
      assert.equal(name, "delegation-prefix");
      return `delegated:${values.prompt}`;
    },
  } as unknown as PromptEngine;
  const router = new DelegationRouter(manager, promptEngine, (event) => events.push(event), undefined, guardDelegation);
  const leader = session({ agentId: "lead", name: "Lead", role: "Team Lead", teamId: "team-1" });
  manager.add(leader);
  manager.setTeamLead(leader.agentId);
  router.wireAgent(leader);
  return { manager, events, router, leader };
}

test("an authorized missing-target resolver registers a real member and delegates through runTask", () => {
  const { manager, events, router, leader } = fixture();
  const runs: Run[] = [];
  let resolverCalls = 0;
  router.setMissingTargetResolver((request) => {
    resolverCalls++;
    assert.deepEqual(request, {
      fromAgentId: "lead",
      targetName: "Developer",
      prompt: "Implement the bounded change",
      teamProjectDir: null,
    });
    const developer = session({ agentId: "dev", name: "Developer", role: "Developer", teamId: "team-1", runs });
    manager.add(developer);
    router.wireAgent(developer);
    return developer;
  });

  leader.onDelegation?.("lead", "Developer", "Implement the bounded change", "lead-task-current");

  assert.equal(resolverCalls, 1);
  assert.equal(manager.findByName("Developer")?.agentId, "dev");
  assert.equal(runs.length, 1);
  assert.match(runs[0].taskId, /^[A-Za-z0-9_-]+$/);
  assert.equal(runs[0].prompt, "delegated:Implement the bounded change");
  assert.equal(runs[0].phaseOverride, "execute");
  const delegated = events.find((event): event is Extract<OrchestratorEvent, { type: "task:delegated" }> =>
    event.type === "task:delegated" && event.toAgentId === "dev");
  assert.equal(delegated?.fromTaskId, "lead-task-current");
  assert.equal(events.some((event) => event.type === "team:chat" && event.messageType === "warning"), false);
});

test("a rejected resolver reports a warning and does not claim or execute a delegation", () => {
  const { events, router, leader } = fixture();
  router.setMissingTargetResolver(() => null);

  leader.onDelegation?.("lead", "Developer", "Implement the bounded change");

  assert.equal(events.some((event) => event.type === "task:delegated"), false);
  const warning = events.find((event): event is Extract<OrchestratorEvent, { type: "team:chat" }> =>
    event.type === "team:chat" && event.messageType === "warning");
  assert.ok(warning && warning.message.includes("was not delegated"));
});

test("stopping during resolution prevents a newly registered member from running", () => {
  const { manager, events, router, leader } = fixture();
  const runs: Run[] = [];
  router.setMissingTargetResolver(() => {
    const developer = session({ agentId: "dev", name: "Developer", role: "Developer", teamId: "team-1", runs });
    manager.add(developer);
    router.stop();
    return developer;
  });

  leader.onDelegation?.("lead", "Developer", "Implement the bounded change");

  assert.equal(runs.length, 0);
  assert.equal(events.some((event) => event.type === "task:delegated"), false);
  assert.equal(events.some((event) => event.type === "team:chat" && event.messageType === "warning"), true);
});

test("delegation requires the exact registered member name", () => {
  const { manager, events, router, leader } = fixture();
  const runs: Run[] = [];
  manager.add(session({ agentId: "dev", name: "Senior Developer", role: "Senior Developer", teamId: "team-1", runs }));

  leader.onDelegation?.("lead", "senior developer", "Implement the bounded change");

  assert.equal(runs.length, 0);
  assert.equal(events.some((event) => event.type === "task:delegated"), false);
  assert.equal(events.some((event) => event.type === "team:chat" && event.messageType === "warning"), true);
});

test("an unregistered role is not synthesized by delegation parsing", () => {
  const { manager, events, router, leader } = fixture();
  const runs: Run[] = [];
  manager.add(session({ agentId: "dev", name: "Senior Developer", role: "Senior Developer", teamId: "team-1", runs }));

  leader.onDelegation?.("lead", "Product Manager", "Expand the team and execute another task");

  assert.equal(manager.findByName("Product Manager"), undefined);
  assert.equal(runs.length, 0);
  assert.equal(events.some((event) => event.type === "task:delegated"), false);
  assert.equal(events.some((event) => event.type === "team:chat" && event.messageType === "warning"), true);
});

test("host delegation guard blocks direct generic reviewer tasks", () => {
  const { manager, events, router, leader } = fixture(({ targetRole }) =>
    targetRole.toLowerCase().includes("review") ? "Reviewer only accepts a candidate-bound request" : null);
  const runs: Run[] = [];
  manager.add(session({ agentId: "reviewer", name: "Reviewer", role: "Reviewer", teamId: "team-1", runs }));

  leader.onDelegation?.("lead", "Reviewer", "Review what the developer changed");

  assert.equal(runs.length, 0);
  assert.equal(events.some((event) => event.type === "task:delegated"), false);
  const warning = events.find((event) => event.type === "team:chat" && event.messageType === "warning");
  assert.ok(warning?.type === "team:chat" && warning.message.includes("candidate-bound request"));
});
