import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { Command } from "@office/shared";
import { MAC_TRIAL_MODEL, assertMacTrialCommand, loadMacTrialConfig } from "./mac-trial-guard.js";
import { ARTICLE_PROJECT_CAPACITY } from "./article-project-capacity.js";

function fixture() {
  const root = mkdtempSync(path.join(process.cwd(), ".open-office-mac-guard-"));
  const stateRoot = path.join(root, "state");
  const workspace = path.join(root, "toy");
  const executionWorkspace = path.join(root, "execution-toy");
  const wrapper = path.join(root, "wrapper");
  mkdirSync(stateRoot);
  mkdirSync(workspace);
  mkdirSync(executionWorkspace);
  writeFileSync(wrapper, "#!/bin/sh\nexit 1\n");
  chmodSync(wrapper, 0o700);
  writeFileSync(path.join(workspace, "src.js"), "export const value = 1;\n");
  writeFileSync(path.join(executionWorkspace, "src.js"), "export const value = 1;\n");
  const guard = loadMacTrialConfig({
    OPEN_OFFICE_MAC_TRIAL: "1",
    NO_OPEN: "1",
    OPEN_OFFICE_CONFIG_DIR: stateRoot,
    WORKSPACE: workspace,
    OPEN_OFFICE_IRIXI_EXECUTION_WORKSPACE: executionWorkspace,
    OPEN_OFFICE_CODEX_WRAPPER: wrapper,
    OPEN_OFFICE_CODEX_MODEL: MAC_TRIAL_MODEL,
  });
  assert.ok(guard);
  return { root, stateRoot, workspace, executionWorkspace, wrapper, guard };
}

test("guard accepts only the fixed solo Codex UI path", () => {
  const f = fixture();
  try {
    assert.doesNotThrow(() => assertMacTrialCommand({
      type: "CREATE_AGENT", agentId: "agent-one", name: "Rex",
      role: "Senior Developer — General-purpose dev, any language/framework",
      backend: "codex", workDir: f.workspace,
    }, f.guard));
    assert.doesNotThrow(() => assertMacTrialCommand({
      type: "RUN_TASK", agentId: "agent-one", taskId: "task-one", prompt: "PROJECT_INTAKE_DISCUSSION_07\nClarify the bounded project.",
      repoPath: f.workspace, name: "Rex", role: "Senior Developer", personality: "",
    }, f.guard));
    assert.doesNotThrow(() => assertMacTrialCommand({
      type: "REQUEST_REVIEW", reviewerAgentId: "reviewer-one", sourceAgentId: "agent-one",
      changedFiles: ["src.js"], projectDir: f.executionWorkspace, entryFile: "src.js", backend: "codex",
    }, f.guard));
    assert.doesNotThrow(() => assertMacTrialCommand({
      type: "RUN_TASK", agentId: "agent-one", taskId: "task-two", prompt: "Fix the bounded toy function.\nINTEGRATED_TOY_DEVELOPER_05",
      repoPath: f.executionWorkspace, name: "Rex", role: "Senior Developer", personality: "",
    }, f.guard));
    const articlePrefix = "ARTICLE_LEARNING_DEVELOPER_12\n";
    assert.doesNotThrow(() => assertMacTrialCommand({ type: "RUN_TASK", agentId: "agent-one", taskId: "article-cap", prompt: articlePrefix + "x".repeat(ARTICLE_PROJECT_CAPACITY.maxNativePromptBytes - Buffer.byteLength(articlePrefix)), repoPath: f.executionWorkspace }, f.guard));
    assert.throws(() => assertMacTrialCommand({ type: "RUN_TASK", agentId: "agent-one", taskId: "article-over", prompt: articlePrefix + "x".repeat(ARTICLE_PROJECT_CAPACITY.maxNativePromptBytes - Buffer.byteLength(articlePrefix) + 1), repoPath: f.executionWorkspace }, f.guard), /oversized/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("guard rejects boundary-changing commands and escaped paths", () => {
  const f = fixture();
  try {
    const rejects = (command: Command) => assert.throws(() => assertMacTrialCommand(command, f.guard));
    rejects({ type: "CREATE_TEAM", leadId: "a", memberIds: [] });
    rejects({ type: "SERVE_PREVIEW", previewCmd: "npm start" });
    rejects({ type: "PICK_FOLDER", requestId: "pick" });
    rejects({ type: "APPROVAL_DECISION", approvalId: "approval", decision: "yes" });
    rejects({ type: "OPEN_FILE", path: "/tmp/private" });
    rejects({ type: "SAVE_CONFIG", worktreeEnabled: true });
    rejects({ type: "CREATE_AGENT", agentId: "a", name: "Rex", role: "Senior Developer", backend: "codex", model: "other", workDir: f.workspace });
    rejects({ type: "CREATE_AGENT", agentId: "a", name: "Rex", role: "Senior Developer", backend: "codex", workDir: f.workspace, skillFiles: ["unsafe"] });
    rejects({ type: "RUN_TASK", agentId: "a", taskId: "t", prompt: "x", repoPath: f.stateRoot });
    rejects({ type: "RUN_TASK", agentId: "a", taskId: "t", prompt: "PROJECT_INTAKE_DISCUSSION_07\nx", repoPath: f.executionWorkspace });
    rejects({ type: "RUN_TASK", agentId: "a", taskId: "t", prompt: "x\nINTEGRATED_TOY_DEVELOPER_05", repoPath: f.workspace });
    rejects({ type: "RUN_TASK", agentId: "a", taskId: "t", prompt: "PROJECT_INTAKE_DISCUSSION_07\nx\nINTEGRATED_TOY_DEVELOPER_05", repoPath: f.executionWorkspace });
    rejects({ type: "REQUEST_REVIEW", reviewerAgentId: "r", sourceAgentId: "a", changedFiles: ["/tmp/private"], projectDir: f.workspace, backend: "codex" });
    symlinkSync(path.join(f.workspace, "src.js"), path.join(f.workspace, "linked.js"));
    rejects({ type: "REQUEST_REVIEW", reviewerAgentId: "r", sourceAgentId: "a", changedFiles: ["linked.js"], projectDir: f.workspace, backend: "codex" });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("guard requires explicit canonical roots, wrapper, and model", () => {
  const f = fixture();
  try {
    assert.throws(() => loadMacTrialConfig({ OPEN_OFFICE_MAC_TRIAL: "1" }));
    assert.throws(() => loadMacTrialConfig({
      OPEN_OFFICE_MAC_TRIAL: "1", NO_OPEN: "1", OPEN_OFFICE_CONFIG_DIR: f.stateRoot,
      WORKSPACE: f.workspace, OPEN_OFFICE_CODEX_WRAPPER: f.wrapper, OPEN_OFFICE_CODEX_MODEL: "other",
    }));
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
