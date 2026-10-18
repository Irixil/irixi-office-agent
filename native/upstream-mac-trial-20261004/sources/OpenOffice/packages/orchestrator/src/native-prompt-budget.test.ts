import assert from "node:assert/strict";
import test from "node:test";

import { prepareNativePrompt, type NativePromptBudgetRequest } from "./native-prompt-budget.js";

function request(overrides: Partial<NativePromptBudgetRequest> = {}): NativePromptBudgetRequest {
  return {
    executionModelId: "gpt-5.6-sol",
    limits: { modelId: "gpt-5.6-sol", contextWindowTokens: 272_000, effectiveContextPercent: 95 },
    reserves: { outputTokens: 24_576, protocolTokens: 8_192 },
    blocks: [{ id: "goal", purpose: "goal", content: "Build the accepted integration." }],
    ...overrides,
  };
}

test("keeps unique tail success criteria and removes only explicitly identical blocks", () => {
  const result = prepareNativePrompt(request({
    blocks: [
      { id: "goal", purpose: "goal", content: "Build the accepted integration." },
      { id: "source-a", purpose: "source facts", content: "Use the registered native executor.", exactDuplicateGroup: "native-source" },
      { id: "source-repeat", purpose: "source facts", content: "Use the registered native executor.", exactDuplicateGroup: "native-source" },
      { id: "success", purpose: "success criteria", content: "SUCCESS: preserve the final delivery binding." },
    ],
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.keptBlocks.map((block) => block.id), ["goal", "source-a", "success"]);
  assert.deepEqual(result.removedExactDuplicates, [{
    removedBlockId: "source-repeat",
    retainedBlockId: "source-a",
    exactDuplicateGroup: "native-source",
    purpose: "source facts",
  }]);
  assert.ok(result.prompt.endsWith("SUCCESS: preserve the final delivery binding."));
  assert.equal(result.budget.effectiveContextTokens, 258_400);
  assert.equal(result.budget.availablePromptTokens, 225_632);
  assert.equal(result.budget.estimator, "utf8_bytes_upper_bound");
});

test("does not remove equal text that has another responsibility", () => {
  const text = "Keep this exact contract text.";
  const result = prepareNativePrompt(request({
    blocks: [
      { id: "goal", purpose: "goal", content: text, exactDuplicateGroup: "shared-text" },
      { id: "success", purpose: "success criteria", content: text, exactDuplicateGroup: "shared-text" },
    ],
  }));

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.removedExactDuplicates.length, 0);
  assert.equal(result.prompt, `${text}\n\n${text}`);
});

test("counts Unicode by UTF-8 bytes and refuses oversize without slicing", () => {
  const content = "汉🙂";
  const result = prepareNativePrompt(request({
    limits: { modelId: "gpt-5.6-sol", contextWindowTokens: 20, effectiveContextPercent: 100 },
    reserves: { outputTokens: 8, protocolTokens: 4 },
    blocks: [{ id: "unicode", purpose: "goal", content }],
  }));

  assert.equal(Buffer.byteLength(content, "utf8"), 7);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.prompt, content);
  assert.equal(result.budget.promptUtf8Bytes, 7);
  assert.equal(result.budget.promptTokenUpperBound, 7);

  const rejected = prepareNativePrompt(request({
    limits: { modelId: "gpt-5.6-sol", contextWindowTokens: 18, effectiveContextPercent: 100 },
    reserves: { outputTokens: 8, protocolTokens: 4 },
    blocks: [{ id: "unicode", purpose: "goal", content }],
  }));
  assert.equal(rejected.ok, false);
  if (rejected.ok) return;
  assert.equal(rejected.reason.code, "PROMPT_BUDGET_EXCEEDED");
  assert.equal(rejected.budget?.promptTokenUpperBound, 7);
  assert.equal(rejected.budget?.availablePromptTokens, 6);
  assert.equal("prompt" in rejected, false);
});

test("accepts the exact conservative boundary and rejects one byte above it", () => {
  const base = request({
    limits: { modelId: "gpt-5.6-sol", contextWindowTokens: 32, effectiveContextPercent: 100 },
    reserves: { outputTokens: 8, protocolTokens: 8 },
    blocks: [{ id: "boundary", purpose: "goal", content: "x".repeat(16) }],
  });
  const accepted = prepareNativePrompt(base);
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.equal(accepted.budget.availablePromptTokens, 16);

  const rejected = prepareNativePrompt({
    ...base,
    blocks: [{ id: "boundary", purpose: "goal", content: "x".repeat(17) }],
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.reason.code, "PROMPT_BUDGET_EXCEEDED");
    assert.equal(rejected.budget?.promptUtf8Bytes, 17);
  }
});

test("registered review prompt fits directly while the generic reviewer wrapper exceeds the recorded budget", () => {
  const exactRegisteredReview = "x".repeat(225_340);
  const direct = prepareNativePrompt(request({
    blocks: [{ id: "registered-review", purpose: "complete Authority-issued review", content: exactRegisteredReview }],
    separator: "",
  }));
  assert.equal(direct.ok, true);
  if (direct.ok) assert.equal(direct.budget.promptUtf8Bytes, 225_340);

  const wrapped = prepareNativePrompt(request({
    blocks: [{ id: "wrapped-review", purpose: "reviewer template plus registered review",
      content: `${"w".repeat(820)}${exactRegisteredReview}` }],
    separator: "",
  }));
  assert.equal(wrapped.ok, false);
  if (!wrapped.ok) {
    assert.equal(wrapped.reason.code, "PROMPT_BUDGET_EXCEEDED");
    assert.equal(wrapped.budget?.promptUtf8Bytes, 226_160);
    assert.equal(wrapped.budget?.availablePromptTokens, 225_632);
  }
});

test("charges fixed output-schema bytes against the existing input budget without changing reserves", () => {
  const counted = prepareNativePrompt(request({
    limits: { modelId: "gpt-5.6-sol", contextWindowTokens: 32, effectiveContextPercent: 100 },
    reserves: { outputTokens: 8, protocolTokens: 8, outputSchemaUtf8Bytes: 7 },
    blocks: [{ id: "prompt", purpose: "goal", content: "x".repeat(9) }],
  }));
  assert.equal(counted.ok, true);
  if (counted.ok) {
    assert.equal(counted.budget.protocolReserveTokens, 8);
    assert.equal(counted.budget.availablePromptTokens, 16);
    assert.equal(counted.budget.promptTokenUpperBound, 9);
    assert.equal(counted.budget.outputSchemaUtf8Bytes, 7);
  }

  const overBudget = prepareNativePrompt(request({
    limits: { modelId: "gpt-5.6-sol", contextWindowTokens: 32, effectiveContextPercent: 100 },
    reserves: { outputTokens: 8, protocolTokens: 8, outputSchemaUtf8Bytes: 7 },
    blocks: [{ id: "prompt", purpose: "goal", content: "x".repeat(10) }],
  }));
  assert.equal(overBudget.ok, false);
  if (!overBudget.ok) assert.equal(overBudget.reason.code, "PROMPT_BUDGET_EXCEEDED");
});

test("fails closed when limits are for another model", () => {
  const result = prepareNativePrompt(request({ executionModelId: "gpt-6-luna" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason.code, "MODEL_LIMITS_MISMATCH");
});
