import test from "node:test";
import assert from "node:assert/strict";
import { authoritativeTerminalOutput, parseAgentOutput } from "./output-parser.js";
import { parseDelegationLine } from "./agent-session.js";
import { PromptEngine, selectBoundWorkerPrompt } from "./prompt-templates.js";

test("passes a registered learning prompt exactly once without worker context headers", () => {
  const registered = `ARTICLE_LEARNING_INFERENCE_12
IRIXI_PROJECT_ID: article-learning-12
IRIXI_TURN_ID: turn-1`;
  const rendered = `memory: IRIXI_PROJECT_ID: article-learning-12\n${registered}`;
  const selected = selectBoundWorkerPrompt(rendered, registered);
  assert.equal(selected, registered);
  assert.equal(selected.match(/^IRIXI_PROJECT_ID:/gm)?.length, 1);
  assert.equal(selectBoundWorkerPrompt("ordinary rendered", "ordinary task"), "ordinary rendered");
});

test("registered product Developer prompts separate code handoff from downstream acceptance", () => {
  const prompt = new PromptEngine().render("worker-initial", {
    name: "Senior Developer", role: "Senior Developer", personality: "", soul: "", memory: "",
    recoveryContext: "", teamRoster: "", prompt: "IRIXI_APPROVED_PRODUCT_EXECUTION_V1\nEXECUTION_ID: run-current",
  });
  assert.match(prompt, /do not start another numbered run or call a reservation\/job-manager API/i);
  assert.match(prompt, /Fixed checks and static preview are host-managed/i);
  assert.match(prompt, /STATUS: done means the assigned implementation is complete.*does not mean host acceptance/i);
  assert.match(prompt, /Use STATUS: failed only when the assigned implementation is incomplete/i);
  assert.match(prompt, /Do not fail solely because host checks, independent review, owner acceptance, or real UI\/learning acceptance are still pending/i);
  assert.match(prompt, /state the local checks actually run/i);
  assert.match(prompt, /leave the field empty when there are no changed paths/i);
});

test("approved product Lead returns the candidate handoff for host capture before Reviewer", () => {
  const engine = new PromptEngine();
  const initial = engine.render("leader-initial", {
    name: "Lead", personality: "", teamRoster: "Senior Developer, Reviewer", originalTask: "",
    prompt: "IRIXI_APPROVED_PRODUCT_EXECUTION_V1\nEXECUTION_ID: run-current",
  });
  assert.match(initial, /These registered-product rules take precedence/i);
  assert.match(initial, /do not delegate directly to Reviewer/i);

  const prompt = engine.render("leader-result", {
    fromName: "Senior Developer", resultStatus: "completed successfully", resultSummary: "STATUS: done",
    originalTask: "IRIXI_APPROVED_PRODUCT_EXECUTION_V1\nEXECUTION_ID: run-current",
    roundInfo: "Round 1", teamRoster: "Senior Developer, Reviewer", devPreview: "ENTRY_FILE: index.html", prompt: "",
  });
  assert.match(prompt, /registered-product rules take precedence/i);
  assert.match(prompt, /do not delegate directly to Reviewer/i);
  assert.match(prompt, /Finish this Lead execute coordination call with a factual handoff/i);
  assert.match(prompt, /authority captures and host-checks the current worker result, then queues the registered full Reviewer/i);
  assert.match(prompt, /real UI\/learning acceptance remains separately authorized/i);
});

test("product Lead rules are not injected into ordinary team tasks", () => {
  const prompt = new PromptEngine().render("leader-result", {
    fromName: "Developer", resultStatus: "completed successfully", resultSummary: "done",
    originalTask: "ordinary project", roundInfo: "Round 1", teamRoster: "Developer, Reviewer", devPreview: "", prompt: "",
  });
  assert.match(prompt, /Dev done → assign reviewer ONLY/i);
  assert.doesNotMatch(prompt, /registered-product rules take precedence/i);
});

test("an empty changed-path report stays empty and preserves failed status", () => {
  const parsed = parseAgentOutput(`STATUS: failed
FILES_CHANGED:
ENTRY_FILE:
SUMMARY: Required host fixture was unavailable, so the registered check did not complete.`);
  assert.equal(parsed.status, "failed");
  assert.deepEqual(parsed.changedFiles, []);
  assert.equal(parsed.entryFile, undefined);
});

test("parses the native multiline FILES_CHANGED report and preserves failed status", () => {
  const parsed = parseAgentOutput(`STATUS: failed
FILES_CHANGED:
PRODUCT.md
index.html
src/app.js
styles.css
PREVIEW_CMD: static preview (automatic)
SUMMARY: Developer stage failed because an attempted collaboration review could not start.`);

  assert.equal(parsed.status, "failed");
  assert.deepEqual(parsed.changedFiles, ["PRODUCT.md", "index.html", "src/app.js", "styles.css"]);
  assert.equal(parsed.previewCmd, "static preview (automatic)");
  assert.match(parsed.summary, /Developer stage failed/);
});

test("parses comma-separated FILES_CHANGED without consuming later fields", () => {
  const parsed = parseAgentOutput(`STATUS: done
FILES_CHANGED: index.html, app.js
ENTRY_FILE: index.html
SUMMARY: Built and checked.`);
  assert.equal(parsed.status, "done");
  assert.deepEqual(parsed.changedFiles, ["index.html", "app.js"]);
  assert.equal(parsed.entryFile, "index.html");
});

test("preserves the backend terminal result instead of a parsed summary", () => {
  const backend = "**VERDICT:** PASS\n\n**SUMMARY:** exact native review";
  assert.equal(authoritativeTerminalOutput("exact native review", backend), backend);
  assert.equal(authoritativeTerminalOutput("fallback", ""), "fallback");
});

test("preserves a native reviewer verdict when the backend result contains only its summary", () => {
  const raw = "**VERDICT:** PASS\n\n**SUMMARY:** exact candidate passed";
  assert.equal(authoritativeTerminalOutput(raw, "exact candidate passed"), raw);
  assert.equal(authoritativeTerminalOutput(raw, "**VERDICT:** FAIL\nreason"), "**VERDICT:** FAIL\nreason");
});

test("parses registered role names with spaces and ignores inline mentions", () => {
  assert.deepEqual(parseDelegationLine("@Senior Developer: Update the page"), {
    targetName: "Senior Developer", prompt: "Update the page",
  });
  assert.deepEqual(parseDelegationLine("**@Senior Developer:** Update the page"), {
    targetName: "Senior Developer", prompt: "Update the page",
  });
  assert.equal(parseDelegationLine("Please ask @Senior Developer: to update the page"), null);
});

test("recognizes the native Lead's full-width delegation separator in dispatch and summary parsing", () => {
  const raw = "@Senior Developer：已分配已批准计划中的端到端 BUILD，范围限于六个授权文件，并要求保留现有改动、完成规定检查和页面验收记录。此轮未分配 Reviewer。";
  assert.deepEqual(parseDelegationLine(raw), {
    targetName: "Senior Developer",
    prompt: "已分配已批准计划中的端到端 BUILD，范围限于六个授权文件，并要求保留现有改动、完成规定检查和页面验收记录。此轮未分配 Reviewer。",
  });
  assert.equal(parseAgentOutput(raw).summary, "Delegated tasks to Senior Developer");
  assert.equal(parseAgentOutput("@Senior Developer: Update the page").summary, "Delegated tasks to Senior Developer");
});
