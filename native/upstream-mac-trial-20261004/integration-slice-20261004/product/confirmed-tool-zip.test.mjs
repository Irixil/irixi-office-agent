import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { buildConfirmedToolZip, confirmedToolBindingMatches } from './confirmed-tool-zip.mjs';

const execFile = promisify(execFileCallback);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);

test('confirmed utility ZIP contains exact baseline, candidate, patch, and checksums without Git metadata', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'confirmed-tool-zip-test-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot);
  const sourceFiles = {
    'IRIXI_PROJECT.json': '{"schemaVersion":1,"projectId":"tool-zip-test","creationKey":"test-key","projectKind":"utility","templateId":"tool-starter-v1"}\n',
    'README.md': '# Test tool\n', 'PRODUCT.md': '# Goal\n',
    'package.json': '{"name":"tool-zip-test","private":true}\n',
    'index.html': '<main>old</main>\n', 'styles.css': 'body { color: black; }\n',
    'app.js': 'document.body.dataset.version = "old";\n', 'core.js': 'export const version = "old";\n',
  };
  for (const [relative, content] of Object.entries(sourceFiles)) await fs.writeFile(path.join(projectRoot, relative), content, { mode: 0o644 });
  const git = (args, options = {}) => execFile('git', args, { cwd: projectRoot, timeout: 5_000, maxBuffer: 128 * 1024, ...options });
  await git(['init', '--quiet']);
  await git(['config', 'user.name', 'ZIP test']);
  await git(['config', 'user.email', 'zip-test@localhost.invalid']);
  await git(['add', '--all']);
  await git(['commit', '--quiet', '-m', 'baseline']);
  const baselinePaths = Object.keys(sourceFiles).sort();
  const sourceManifest = await Promise.all(baselinePaths.map(async (relative) => {
    const bytes = await fs.readFile(path.join(projectRoot, relative));
    return { path: relative, bytes: bytes.length, sha256: sha256(bytes), mode: 0o644 };
  }));
  const candidateRoot = path.join(root, 'candidate');
  await git(['worktree', 'add', '--quiet', '--detach', candidateRoot, 'HEAD']);
  const candidateGit = (args, options = {}) => execFile('git', args, { cwd: candidateRoot, timeout: 5_000, maxBuffer: 128 * 1024, ...options });
  await fs.writeFile(path.join(candidateRoot, 'app.js'), 'document.body.dataset.version = "confirmed";\n');
  const diff = await candidateGit(['diff', '--binary', 'HEAD'], { encoding: 'buffer' });
  const confirmedPatch = Buffer.from(diff.stdout);
  const candidateBytes = await fs.readFile(path.join(candidateRoot, 'app.js'));
  const candidateFile = { path: 'app.js', bytes: candidateBytes.length, sha256: sha256(candidateBytes) };
  const candidateSha256 = sha256(Buffer.from(canonical([candidateFile])));
  const project = { projectId: 'tool-zip-test', label: 'Test utility', projectKind: 'utility', templateId: 'tool-starter-v1',
    root: projectRoot, baselinePaths, sourceManifest, sourceSnapshotSha256: 'b'.repeat(64), scopeFingerprint: 'c'.repeat(64),
    allowedWritePaths: ['README.md', 'PRODUCT.md', 'package.json', 'index.html', 'styles.css', 'app.js', 'core.js'] };
  const binding = { taskId: 'task-zip-test', goalVersionId: 'goal-zip-test', executionId: 'run-zip-test', registrySha256: 'd'.repeat(64),
    projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, sourceSnapshotSha256: project.sourceSnapshotSha256,
    artifactId: 'artifact-zip-test', artifactVersion: 2, candidateSha256, approvalId: 'approval-zip-test',
    reviewId: 'review-zip-test', status: 'confirmed' };
  const candidate = { taskId: binding.taskId, goalVersionId: binding.goalVersionId, artifactId: binding.artifactId,
    artifactVersion: binding.artifactVersion, candidateSha256: binding.candidateSha256,
    patch: confirmedPatch.toString('utf8'), patchSha256: sha256(confirmedPatch),
    files: [candidateFile],
    review: { id: binding.reviewId, passed: true },
    confirmation: { approvalId: binding.approvalId, artifactVersion: binding.artifactVersion, goalVersionId: binding.goalVersionId } };
  const projection = { current: true, taskId: binding.taskId, goalVersionId: binding.goalVersionId,
    execution: { id: binding.executionId }, workspace: { current: true, scopeFingerprint: binding.scopeFingerprint,
      sourceSnapshotSha256: binding.sourceSnapshotSha256 },
    productRegistry: { current: true, projectId: binding.projectId, registrySha256: binding.registrySha256 },
    artifact: { id: binding.artifactId, version: binding.artifactVersion, status: 'confirmed',
      candidateSha256: binding.candidateSha256, review: { id: binding.reviewId, passed: true },
      confirmation: { approvalId: binding.approvalId, artifactVersion: binding.artifactVersion, goalVersionId: binding.goalVersionId } } };
  assert.equal(confirmedToolBindingMatches(binding, projection), true);

  const archive = await buildConfirmedToolZip({ project, candidate, confirmedPatch, binding });
  assert.equal(archive.filename, 'tool-zip-test-v2.zip');
  assert.equal(archive.sha256, sha256(archive.bytes));
  const archivePath = path.join(root, 'result.zip');
  await fs.writeFile(archivePath, archive.bytes);
  await execFile('/usr/bin/unzip', ['-t', archivePath], { timeout: 5_000, maxBuffer: 128 * 1024 });
  const listing = (await execFile('/usr/bin/unzip', ['-Z1', archivePath], { encoding: 'utf8' })).stdout.trim().split(/\r?\n/);
  assert.ok(listing.includes('tool/app.js'));
  assert.ok(listing.includes('baseline/app.js'));
  assert.ok(listing.includes('candidate.patch'));
  assert.ok(listing.includes('MANIFEST.json'));
  assert.ok(listing.includes('MANIFEST.sha256'));
  assert.ok(listing.includes('README.txt'));
  assert.equal(listing.some((entry) => entry.includes('.git') || /(?:^|\/)logs?(?:\/|$)|\.log$/i.test(entry)), false);
  const extract = async (entry) => Buffer.from((await execFile('/usr/bin/unzip', ['-p', archivePath, entry], { encoding: 'buffer' })).stdout);
  assert.deepEqual(await extract('tool/app.js'), candidateBytes);
  assert.equal(sha256(await extract('baseline/app.js')), sourceManifest.find((entry) => entry.path === 'app.js').sha256);
  assert.ok((await extract('MANIFEST.sha256')).toString('utf8').includes(`${sha256(confirmedPatch)}  candidate.patch`));
  assert.match((await extract('README.txt')).toString('utf8'), /打开 tool\/index\.html/);
  assert.match((await extract('README.txt')).toString('utf8'), /离线直接双击打开尚未验证/);
  const manifest = JSON.parse((await extract('MANIFEST.json')).toString('utf8'));
  assert.equal(manifest.binding.approvalId, binding.approvalId);
  assert.equal(manifest.candidateFiles.find((entry) => entry.path === 'app.js').sha256, sha256(candidateBytes));

  await assert.rejects(() => buildConfirmedToolZip({ project, candidate: { ...candidate,
    confirmation: { ...candidate.confirmation, approvalId: 'approval-stale' } }, confirmedPatch, binding }), /binding is stale/);
  const unsafeFiles = [{ path: '../../outside.txt', bytes: 1, sha256: 'f'.repeat(64) }];
  const unsafeSha256 = sha256(Buffer.from(canonical(unsafeFiles)));
  await assert.rejects(() => buildConfirmedToolZip({ project, candidate: { ...candidate,
    candidateSha256: unsafeSha256, files: unsafeFiles }, confirmedPatch,
    binding: { ...binding, candidateSha256: unsafeSha256 } }), /outside the registered writable files/);
  const unsafeProject = { ...project, baselinePaths: [...project.baselinePaths, 'logs/debug.log'],
    sourceManifest: [...project.sourceManifest, { path: 'logs/debug.log', bytes: 1, sha256: 'f'.repeat(64), mode: 0o644 }] };
  await assert.rejects(() => buildConfirmedToolZip({ project: unsafeProject, candidate, confirmedPatch, binding }), /manifest is unsafe or incomplete/);
  assert.equal(confirmedToolBindingMatches(binding, { ...projection, execution: { id: 'run-replaced' } }), false);
});
