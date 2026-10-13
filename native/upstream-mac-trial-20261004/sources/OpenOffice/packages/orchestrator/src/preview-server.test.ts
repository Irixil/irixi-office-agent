import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { resolvePreviewDataDir } from "./preview-server.js";

test("preview persistence follows the existing isolated config directory", () => {
  assert.equal(resolvePreviewDataDir("/tmp/irixi-open-office", "/unused", "production"), path.join("/tmp/irixi-open-office", "data"));
});

test("preview persistence keeps the original defaults without an isolated config directory", () => {
  assert.equal(resolvePreviewDataDir(undefined, "/home/fixture", "production"), "/home/fixture/.open-office/data");
  assert.equal(resolvePreviewDataDir(undefined, "/home/fixture", "development"), "/home/fixture/.open-office-dev/data");
  assert.throws(() => resolvePreviewDataDir("relative/path", "/home/fixture", "production"), /absolute path/);
});
