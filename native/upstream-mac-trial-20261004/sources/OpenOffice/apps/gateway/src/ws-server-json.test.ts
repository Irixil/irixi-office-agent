import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import type { IncomingMessage } from "node:http";
import { readSmallJson } from "./json-body.js";
import { clientStateErrorStatus } from "./client-state-http.js";
import { hasCurrentProductPlanAwaitingApproval, productReviewRoundBindingMatches, projectProgressBindingMatches, shouldStartFreshProductPlan } from "./ws-server.js";

test("the review-round HTTP action accepts only an exact current binding, including no prior review", () => {
  const artifact = { id: "artifact-1", version: 41, candidateSha256: "a".repeat(64), review: null };
  const base = { expectedArtifactId: artifact.id, expectedArtifactVersion: artifact.version,
    expectedCandidateSha256: artifact.candidateSha256, expectedReviewId: null };
  assert.equal(productReviewRoundBindingMatches(base, artifact, true), true);
  assert.equal(productReviewRoundBindingMatches({ ...base, expectedReviewId: undefined }, artifact, true), false);
  assert.equal(productReviewRoundBindingMatches({ ...base, expectedReviewId: "stale-review" }, artifact, true), false);
  assert.equal(productReviewRoundBindingMatches(base, artifact, false), false);
});

test("project progress requests must carry the exact page candidate binding", () => {
  const binding = { expectedGoalVersionId: "goal-1", expectedExecutionId: "run-1", expectedRegistrySha256: "a".repeat(64),
    expectedArtifactId: "artifact-1", expectedArtifactVersion: 7, expectedCandidateSha256: "b".repeat(64) };
  assert.equal(projectProgressBindingMatches(binding, binding), true);
  for (const field of Object.keys(binding)) {
    assert.equal(projectProgressBindingMatches({ ...binding, [field]: "stale" }, binding), false, field);
    assert.equal(projectProgressBindingMatches(Object.fromEntries(Object.entries(binding).filter(([key]) => key !== field)), binding), false, field);
  }
});

test("a fresh Lead plan starts only for the current, runnable, unplanned zero-call execution", () => {
  const state = {
    current: true,
    product: { bindingCurrent: true },
    execution: { phase: "planned" },
    native: { phase: "design", plan: null, sessions: [], actions: { canRun: true } },
  };
  assert.equal(shouldStartFreshProductPlan(state), true);
  assert.equal(shouldStartFreshProductPlan({ ...state, current: false }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, product: { bindingCurrent: false } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, execution: { phase: "running" } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, native: { ...state.native, phase: "create" } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, native: { ...state.native, plan: { text: "old", sha256: "a".repeat(64) } } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, native: { ...state.native, sessions: [{ status: "complete" }] } }), false);
  assert.equal(shouldStartFreshProductPlan({ ...state, native: { ...state.native, actions: { canRun: false } } }), false);
});

test("only the exact persisted Lead plan can await approval, including the existing saved-plan recovery", () => {
  const state = {
    current: true,
    taskId: "task-1",
    goalVersionId: "goal-1",
    product: { bindingCurrent: true, registrySha256: "b".repeat(64) },
    execution: { id: "run-1", phase: "executing", stopReason: null },
    native: { runAgentId: "product-lead" },
  };
  const planText = "Persisted plan";
  const runtimeView = {
    phase: "design",
    leadAgentId: "product-lead",
    plan: { text: planText, sha256: "a".repeat(64) },
  };
  const savedPlan = { taskId: "task-1", goalVersionId: "goal-1", executionId: "run-1", registrySha256: "b".repeat(64),
    agentId: "product-lead", planText, planSha256: "a".repeat(64) };

  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, savedPlan), true);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, null), false, "an in-memory-only R5 plan is not approvable");
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, { ...savedPlan, planText: "different" }), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, { ...savedPlan, taskId: "other-task" }), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, { ...savedPlan, goalVersionId: "other-goal" }), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, { ...savedPlan, executionId: "other-run" }), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, { ...savedPlan, registrySha256: "c".repeat(64) }), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, { ...savedPlan, agentId: "other-lead" }), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, runtimeView, { ...savedPlan, planSha256: "d".repeat(64) }), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval({ ...state, execution: { ...state.execution, phase: "planned" } }, runtimeView, savedPlan), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval({ ...state, current: false }, runtimeView, savedPlan), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval({ ...state, product: { ...state.product, bindingCurrent: false } }, runtimeView, savedPlan), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, { ...runtimeView, phase: "execute" }, savedPlan), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, { ...runtimeView, leadAgentId: "other-lead" }, savedPlan), false);
  assert.equal(hasCurrentProductPlanAwaitingApproval(state, { ...runtimeView, plan: null }, savedPlan), false);

  const stopped = { ...state, execution: { ...state.execution, phase: "failed", stopReason: "persistence_failed" } };
  assert.equal(hasCurrentProductPlanAwaitingApproval(stopped, runtimeView, savedPlan), false, "failed executions require the explicit existing recovery eligibility");
  assert.equal(hasCurrentProductPlanAwaitingApproval({ ...stopped, native: { ...state.native,
    actions: { resumeReason: "saved_lead_plan_same_execution_budget_and_deadline" } } }, runtimeView, savedPlan), true,
  "a persisted plan retains the existing explicit same-budget recovery path");
});

function requestBody(bytes: number): { raw: string; request: IncomingMessage } {
  const prefix = '{"payload":"', suffix = '"}';
  const raw = prefix + "x".repeat(bytes - Buffer.byteLength(prefix) - Buffer.byteLength(suffix)) + suffix;
  const chunks = [raw.slice(0, 7011), raw.slice(7011, 17003), raw.slice(17003)];
  return { raw, request: Readable.from(chunks.map((chunk) => Buffer.from(chunk))) as IncomingMessage };
}

test("the native inference body contract accepts the observed 22,813-byte request", async () => {
  const { raw, request } = requestBody(22_813);
  assert.equal(Buffer.byteLength(raw), 22_813);
  const parsed = await readSmallJson(request, 64 * 1024);
  assert.equal(typeof parsed.payload, "string");
});

test("the native inference body contract rejects a request above 64 KiB", async () => {
  const { request } = requestBody(64 * 1024 + 1);
  await assert.rejects(readSmallJson(request, 64 * 1024), /Request is too large/);
});

test("the product client-state contract accepts the observed 68,163-byte save", async () => {
  const { raw, request } = requestBody(68_163);
  assert.equal(Buffer.byteLength(raw), 68_163);
  const parsed = await readSmallJson(request, 320 * 1024, { drainOnLimit: true });
  assert.equal(typeof parsed.payload, "string");
});

test("an oversized product client-state body drains and reports a controlled 413", async () => {
  const { request } = requestBody(320 * 1024 + 1);
  await assert.rejects(readSmallJson(request, 320 * 1024, { drainOnLimit: true }), (error: Error) => {
    assert.match(error.message, /Request is too large/);
    return clientStateErrorStatus(error) === 413;
  });
});
