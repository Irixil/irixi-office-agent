import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { completeArticleReviewPayload } from "./article-project-review.js";

test("article review includes every byte of every registered file even in a git workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "article-full-review-"));
  mkdirSync(join(root, ".git"));
  const longFile = `${Array.from({ length: 160 }, (_, index) => `line-${index}`).join("\n")}\nTAIL-MUST-BE-REVIEWED`;
  writeFileSync(join(root, "long.js"), longFile);
  writeFileSync(join(root, "second.js"), "SECOND-COMPLETE");
  const payload = completeArticleReviewPayload(root, ["long.js", "second.js"]);
  assert.match(payload, /line-159\nTAIL-MUST-BE-REVIEWED/);
  assert.match(payload, /SECOND-COMPLETE$/);
  assert.equal(payload, `=== NEW FILE: long.js ===\n${longFile}\n\n=== NEW FILE: second.js ===\nSECOND-COMPLETE`);
});
