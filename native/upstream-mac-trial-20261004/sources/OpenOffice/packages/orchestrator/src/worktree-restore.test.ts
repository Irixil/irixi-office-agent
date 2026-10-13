import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("managed worktree restoration starts at the saved commit and writes native owner metadata", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "managed-worktree-restore-"));
  const configRoot = path.join(root, "openoffice");
  const source = path.join(root, "workspace");
  mkdirSync(source);
  const previousConfig = process.env.OPEN_OFFICE_CONFIG_DIR;
  process.env.OPEN_OFFICE_CONFIG_DIR = configRoot;
  t.after(() => {
    if (previousConfig === undefined) delete process.env.OPEN_OFFICE_CONFIG_DIR;
    else process.env.OPEN_OFFICE_CONFIG_DIR = previousConfig;
    rmSync(root, { recursive: true, force: true });
  });

  const git = (...args: string[]) => execFileSync("git", ["-C", source, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", source]);
  git("config", "user.name", "Worktree Restore Test");
  git("config", "user.email", "worktree-restore@example.invalid");
  writeFileSync(path.join(source, "index.html"), "<main>baseline</main>\n");
  git("add", "--", "index.html");
  git("commit", "-qm", "registered baseline");
  const sourceHead = git("rev-parse", "HEAD");

  const manager = await import("./worktree.js");
  const agentId = "product-senior-developer";
  const agentName = "Senior Developer";
  const branch = manager.getManagedWorktreeBranch(agentName, agentId);
  git("switch", "-c", branch);
  writeFileSync(path.join(source, "index.html"), "<main>saved candidate</main>\n");
  git("add", "--", "index.html");
  git("commit", "-qm", "saved product candidate");
  const savedCommit = git("rev-parse", "HEAD");
  git("switch", "main");
  git("branch", "-D", branch);

  const owner = {
    gatewayId: "product-article-learning-12",
    machineId: "mac-test",
    instanceDir: path.join(root, "instance"),
    pid: process.pid,
    startedAt: 123,
  };
  const worktree = manager.createWorktree(source, agentId, agentName, owner, savedCommit);
  assert.ok(worktree);
  assert.equal(git("rev-parse", "HEAD"), sourceHead);
  assert.equal(execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), savedCommit);
  assert.equal(readFileSync(path.join(worktree, "index.html"), "utf8"), "<main>saved candidate</main>\n");
  assert.ok(worktree.startsWith(path.join(configRoot, "worktrees") + path.sep));

  const ownerFile = path.join(path.dirname(worktree), ".owners", `${path.basename(worktree)}.json`);
  const metadata = JSON.parse(readFileSync(ownerFile, "utf8"));
  assert.equal(metadata.gatewayId, owner.gatewayId);
  assert.equal(metadata.machineId, owner.machineId);
  assert.equal(metadata.instanceDir, owner.instanceDir);
  assert.equal(metadata.agentId, agentId);
  assert.equal(metadata.agentName, agentName);
  assert.equal(metadata.branch, branch);
  assert.equal(metadata.repoRoot, source);
});
