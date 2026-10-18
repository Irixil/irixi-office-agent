import assert from "node:assert/strict";
import test from "node:test";
import { beginProductPreview, clearProductPreview, finishProductPreview, getProductPreviewContext, isAllowedAuthorityUrl, isAllowedProductSourceFile, isNoobiBuiltPreviewAsset, productPreviewContentType, productPreviewMatches, type ProductPreviewContext } from "./product-project-registry.js";

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

test("Noobi built preview admits only normalized relative assets under assets/", () => {
  for (const asset of ["assets/game.js", "assets/style.css", "assets/room.png", "assets/provenance/source.json"]) {
    assert.equal(isNoobiBuiltPreviewAsset("noobi-owl-book-sorter-v1", asset), true);
  }
  for (const asset of ["index.html", "../secret", "assets/../secret.js", "assets//game.js", "assets/.hidden.js", "assets\\game.js", "/assets/game.js"]) {
    assert.equal(isNoobiBuiltPreviewAsset("noobi-owl-book-sorter-v1", asset), false);
  }
  assert.equal(isNoobiBuiltPreviewAsset("article-learning-12", "assets/game.js"), false);
  assert.equal(productPreviewContentType("/candidate/dist/assets/room.png"), "image/png");
  assert.equal(productPreviewContentType("/candidate/dist/assets/game.js"), "application/javascript; charset=utf-8");
});

test("large registered source files are limited to read-only Noobi artwork PNGs", () => {
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", "public/assets/images/books/book-stack-master.png", 1_487_434, false), true);
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", "public/assets/images/rooms/room-1440x810.png", 2_019_437, false), true);
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", ".noobi/playtest.json", 3_914, true), true);
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", "src/main.js", 512 * 1024, true), true);
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", "public/assets/images/books/book-stack-master.png", 1_487_434, true), false);
  assert.equal(isAllowedProductSourceFile("article-learning-12", "public/assets/images/books/book-stack-master.png", 1_487_434, false), false);
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", "public/assets/other/large.png", 1_487_434, false), false);
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", "public/assets/images/books/oversized.png", 2 * 1024 * 1024 + 1, false), false);
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", "public/assets/images/books/book-stack-master.png", "1487434" as unknown as number, false), false);
  assert.equal(isAllowedProductSourceFile("noobi-owl-book-sorter-v1", "src/main.js", 512 * 1024 + 1, false), false);
});

test("Authority origin accepts explicit isolated loopback ports and rejects unsafe or implicit origins", () => {
  assert.equal(isAllowedAuthorityUrl("http://127.0.0.1:3869/"), true);
  assert.equal(isAllowedAuthorityUrl("http://127.0.0.1:31639/"), true);
  for (const value of [
    "http://127.0.0.1/", "http://127.0.0.1:80/", "http://127.0.0.1:1023/",
    "http://127.0.0.1:65536/", "https://127.0.0.1:31639/", "http://localhost:31639/",
    "http://user@127.0.0.1:31639/", "http://127.0.0.1:31639/path",
    "http://127.0.0.1:31639/?task=other", "http://127.0.0.1:31639/#fragment",
  ]) assert.equal(isAllowedAuthorityUrl(value), false, value);
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
