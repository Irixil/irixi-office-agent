import assert from "node:assert/strict";
import test from "node:test";
import { beginProductPreview, clearProductPreview, finishProductPreview, getProductPreviewContext, productPreviewMatches, type ProductPreviewContext } from "./product-project-registry.js";

const sha = "a".repeat(64);
const context: ProductPreviewContext = {
  taskId: "task-1", goalVersionId: "goal-1", executionId: "execution-1", registrySha256: sha,
  artifactId: "artifact-1", artifactVersion: 2, candidateSha256: sha, token: "preview-token", entry: "index.html",
  root: "/tmp/candidate", entryAbsolute: "/tmp/candidate/index.html", status: "ready",
};
const projection = {
  taskId: context.taskId, goalVersionId: context.goalVersionId, current: true,
  execution: { id: context.executionId }, product: { registrySha256: sha, bindingCurrent: true },
  artifact: { id: context.artifactId, version: context.artifactVersion, candidateSha256: context.candidateSha256 },
};

test("product preview requires the current task and registry binding as well as exact candidate identity", () => {
  assert.equal(productPreviewMatches(context, projection), true);
  assert.equal(productPreviewMatches(context, { ...projection, current: false }), false);
  assert.equal(productPreviewMatches(context, { ...projection, product: { registrySha256: sha, bindingCurrent: false } }), false);
  assert.equal(productPreviewMatches(context, { ...projection, artifact: { ...projection.artifact, candidateSha256: "b".repeat(64) } }), false);
});

test("a failed preview dispatch is retryable and a late old result cannot replace the retry", () => {
  clearProductPreview();
  beginProductPreview(context);
  assert.equal(finishProductPreview(context.token, "failed", "queue rejected")?.status, "failed");
  const retry = { ...context, token: "preview-retry", status: "pending" as const };
  beginProductPreview(retry);
  assert.equal(finishProductPreview(context.token, "ready"), null);
  assert.equal(getProductPreviewContext()?.token, retry.token);
  assert.equal(getProductPreviewContext()?.status, "pending");
  clearProductPreview();
});
