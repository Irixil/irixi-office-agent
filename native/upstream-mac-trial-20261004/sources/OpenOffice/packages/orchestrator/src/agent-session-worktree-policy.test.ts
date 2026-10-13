import assert from "node:assert/strict";
import test from "node:test";
import { bindDelegationToRegisteredExecution, parseDelegationOutput, shouldRemoveWorktreeAfterFailure } from "./agent-session.js";

test("delegation output keeps its full multiline body across text blocks", () => {
  assert.deepEqual(parseDelegationOutput([
    "Lead summary outside the assignment",
    "@Senior Developer: Implement the complete flow.",
    "Preserve every success criterion.",
    "",
    "- Stay inside the registered writable paths.",
    "@Reviewer: Independently inspect the exact candidate.",
    "Report any unmet criterion.",
  ]), [
    { targetName: "Senior Developer", prompt: "Implement the complete flow.\nPreserve every success criterion.\n\n- Stay inside the registered writable paths." },
    { targetName: "Reviewer", prompt: "Independently inspect the exact candidate.\nReport any unmet criterion." },
  ]);
});

test("delegated product work inherits the exact registered execution request", () => {
  const taskPrompt = "IRIXI_NATIVE_PRODUCT_EXECUTION_V1\nGoal: Complete P0.\n\nSuccess criteria:\n- Verify behavior.\n\nBoundaries:\n- Only registered files.";
  const assignment = "Implement the accepted plan.";
  const delegated = bindDelegationToRegisteredExecution(assignment, taskPrompt);
  assert.ok(delegated.includes(taskPrompt));
  assert.doesNotMatch(delegated, /IRIXI_APPROVED_PRODUCT_EXECUTION_V1/);
  assert.ok(delegated.endsWith(`Lead assignment (additional detail, subordinate to the registered request):\n\n${assignment}`));
  const continued = bindDelegationToRegisteredExecution(assignment, "batch result prompt", taskPrompt);
  assert.ok(continued.includes(taskPrompt));
  assert.doesNotMatch(continued, /IRIXI_APPROVED_PRODUCT_EXECUTION_V1/);
  assert.ok(continued.endsWith(assignment));
  assert.equal(bindDelegationToRegisteredExecution(assignment, "ordinary team task"), assignment);
});

test("product-mode failure keeps its managed worktree for recovery", () => {
  assert.equal(shouldRemoveWorktreeAfterFailure({
    requireWorktreeIsolation: true,
    isTransientApiError: false,
    structuredFailure: false,
  }), false);
});

test("legacy cleanup still removes only ordinary failed worktrees", () => {
  assert.equal(shouldRemoveWorktreeAfterFailure({
    requireWorktreeIsolation: false,
    isTransientApiError: false,
    structuredFailure: false,
  }), true);
  assert.equal(shouldRemoveWorktreeAfterFailure({
    requireWorktreeIsolation: false,
    isTransientApiError: true,
    structuredFailure: false,
  }), false);
  assert.equal(shouldRemoveWorktreeAfterFailure({
    requireWorktreeIsolation: false,
    isTransientApiError: false,
    structuredFailure: true,
  }), false);
});
