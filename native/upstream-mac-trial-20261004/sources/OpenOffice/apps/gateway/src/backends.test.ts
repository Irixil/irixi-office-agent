import assert from "node:assert/strict";
import test from "node:test";

import { getBackend } from "./backends.js";

test("Codex planning calls disable delegation and shell execution", () => {
  const backend = getBackend("codex");
  assert.ok(backend);
  const args = backend.buildArgs("plan only", {
    fullAccess: false,
    noTools: true,
    readOnly: true,
    model: "gpt-5.6-sol",
  });
  assert.deepEqual(args.slice(0, 2), ["--ask-for-approval", "on-request"]);
  for (const feature of ["multi_agent", "shell_tool", "skill_search", "tool_suggest", "apps", "browser_use",
    "computer_use", "image_generation", "workspace_dependencies"]) {
    const index = args.indexOf(feature);
    assert.equal(args[index - 1], "--disable");
  }
  assert.deepEqual(args.slice(args.indexOf("mcp_servers={}") - 1, args.indexOf("plugins={}") + 1), [
    "-c", "mcp_servers={}", "-c", "plugins={}",
  ]);
  assert.equal(args[args.indexOf("gpt-5.6-sol") - 1], "--model");
  assert.deepEqual(args.slice(-5), ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"]);
});

test("Codex product workers keep shell access but cannot spawn unmetered CLI subagents", () => {
  const backend = getBackend("codex");
  assert.ok(backend);
  const args = backend.buildArgs("implement", {
    fullAccess: false, noTools: false, disableMultiAgent: true,
    readOnly: false, model: "gpt-5.6-sol",
  });
  const multiAgent = args.indexOf("multi_agent");
  assert.equal(args[multiAgent - 1], "--disable");
  assert.equal(args.includes("shell_tool"), false);
  assert.deepEqual(args.slice(-5), ["exec", "--sandbox", "workspace-write", "--skip-git-repo-check", "-"]);
});

test("Codex applies medium only as the explicit bound GPT-6 Luna product effort", () => {
  const backend = getBackend("codex");
  assert.ok(backend);
  const args = backend.buildArgs("implement", {
    fullAccess: false, noTools: false, readOnly: false,
    model: "gpt-6-luna", modelReasoningEffort: "medium",
  });
  const configIndex = args.indexOf("model_reasoning_effort=medium");
  assert.ok(configIndex > 0);
  assert.equal(args[configIndex - 1], "-c");
  assert.ok(configIndex < args.indexOf("exec"));
  assert.equal(args[args.indexOf("gpt-6-luna") - 1], "--model");
  assert.equal(backend.buildArgs("generic", { model: "gpt-6-luna" }).includes("model_reasoning_effort=medium"), false);
  assert.equal(backend.buildArgs("other model", { model: "gpt-5.6-sol", modelReasoningEffort: "medium" }).includes("model_reasoning_effort=medium"), false);
});
