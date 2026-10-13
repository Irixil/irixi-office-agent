import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { bindDelegationToRegisteredExecution, classifyStdoutJsonLine } from "./agent-session.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const realLearning02Stdout = path.resolve(import.meta.dirname,
  "../../../../../integration-slice-20261004/project-intake-20261004/projects/article-learning-12/state/learning-02/call-1/stdout.log");

test("schema-bound learning JSON is ordinary stdout, including a final line without newline", () => {
  const raw = fs.readFileSync(realLearning02Stdout, "utf8");
  assert.equal(Buffer.byteLength(raw), 5299);
  assert.equal(classifyStdoutJsonLine(raw.trim()).kind, "plain");
  assert.doesNotThrow(() => JSON.parse(raw));
});

test("real stream-json envelopes remain protocol and are not surfaced as model text", () => {
  assert.equal(classifyStdoutJsonLine(JSON.stringify({ type: "system", session_id: "fixture" })).kind, "protocol");
  assert.equal(classifyStdoutJsonLine(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "visible" }] } })).kind, "protocol");
  assert.equal(classifyStdoutJsonLine(JSON.stringify({ type: "result", result: "done" })).kind, "protocol");
});

test("chunk boundaries do not change classification after the line is reassembled", () => {
  const raw = fs.readFileSync(realLearning02Stdout, "utf8").trim();
  const chunks = [raw.slice(0, 17), raw.slice(17, 2048), raw.slice(2048)];
  assert.equal(classifyStdoutJsonLine(chunks.join("")).kind, "plain");
});

test("delegation carries only the exact registered request's approved execution context", () => {
  const registered = "IRIXI_NATIVE_PRODUCT_EXECUTION_V1\nTask: current task\nGoal: current goal";
  const plan = "Approved plan for the current execution";
  const approved = `${registered}\n\nIRIXI_APPROVED_PRODUCT_EXECUTION_V1\nTASK_ID: task-current\nGOAL_VERSION_ID: goal-current\nEXECUTION_ID: run-current\nREGISTRY_SHA256: ${sha256("registry-current")}\nREGISTERED_PROMPT_SHA256: ${sha256(registered)}\nAPPROVED_PLAN_SHA256: ${sha256(plan)}\n\nExact user-approved Lead plan:\n${plan}`;
  const assignment = "Implement the accepted work";
  const bound = bindDelegationToRegisteredExecution(assignment, registered, approved);
  assert.ok(bound.includes(approved));
  assert.ok(bound.endsWith(assignment));

  const staleRegistered = `${registered}\nStale instruction`;
  assert.equal(bindDelegationToRegisteredExecution(assignment, registered, `${approved.replace(registered, staleRegistered)}`), assignment);
  const invalidApproval = bindDelegationToRegisteredExecution(assignment, registered, approved.replace(sha256(registered), "a".repeat(64)));
  assert.ok(invalidApproval.includes(registered));
  assert.doesNotMatch(invalidApproval, /IRIXI_APPROVED_PRODUCT_EXECUTION_V1/);
  const unapproved = bindDelegationToRegisteredExecution(assignment, registered, registered);
  assert.ok(unapproved.includes(registered));
  assert.doesNotMatch(unapproved, /IRIXI_APPROVED_PRODUCT_EXECUTION_V1/);

  const otherPlan = "Different approved plan";
  const conflicting = `${registered}\n\nIRIXI_APPROVED_PRODUCT_EXECUTION_V1\nTASK_ID: task-current\nGOAL_VERSION_ID: goal-current\nEXECUTION_ID: run-current\nREGISTRY_SHA256: ${sha256("registry-current")}\nREGISTERED_PROMPT_SHA256: ${sha256(registered)}\nAPPROVED_PLAN_SHA256: ${sha256(otherPlan)}\n\nExact user-approved Lead plan:\n${otherPlan}`;
  const conflictingApproval = bindDelegationToRegisteredExecution(assignment, approved, conflicting);
  assert.ok(conflictingApproval.includes(registered));
  assert.doesNotMatch(conflictingApproval, /IRIXI_APPROVED_PRODUCT_EXECUTION_V1/);
});
