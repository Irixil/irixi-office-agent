import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  NOOBI_GAME_BASELINE_PATHS, NOOBI_GAME_PROJECT_ID, NOOBI_GAME_READONLY_PNG_PATHS,
  NOOBI_GAME_READONLY_MANIFEST_PATHS, NOOBI_GAME_WRITE_PATHS, inspectPngHeader,
} from './noobi-game-contract.mjs';
import { __test, createTrustedProductProjects } from './trusted-product-projects.mjs';

const workspaceRoot = path.resolve(import.meta.dirname, '../../../..');
// Local catalogue is excluded from this public source snapshot.
const execFile = promisify(execFileCallback);

// Private installation/history replay is retained only in the development workspace.

test('trusted game path exception is exact and preserves regular file/link/size checks', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-game-path-')));
  try {
    await fs.mkdir(path.join(root, '.noobi'));
    await fs.writeFile(path.join(root, '.noobi/playtest.json'), '{}\n');
    assert.equal((await __test.readSnapshotFile(root, '.noobi/playtest.json', NOOBI_GAME_PROJECT_ID, NOOBI_GAME_WRITE_PATHS)).bytes, 3);
    for (const unsafe of ['.noobi/project.json', '.env', 'nested/.env', 'nested/.git/config', '../outside.json', 'nested/.noobi/playtest.json']) {
      await assert.rejects(() => __test.readSnapshotFile(root, unsafe, NOOBI_GAME_PROJECT_ID, NOOBI_GAME_WRITE_PATHS));
    }
    await assert.rejects(() => __test.readSnapshotFile(root, '.noobi/playtest.json', 'another-project', []));

    const image = 'public/assets/images/rooms/room-1440x810.png';
    await fs.mkdir(path.dirname(path.join(root, image)), { recursive: true });
    await fs.writeFile(path.join(root, image), Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(() => __test.readSnapshotFile(root, image, NOOBI_GAME_PROJECT_ID, NOOBI_GAME_WRITE_PATHS), /bounded regular file/);

    const malformed = Buffer.alloc(33);
    await fs.writeFile(path.join(root, image), malformed);
    await assert.rejects(() => __test.readSnapshotFile(root, image, NOOBI_GAME_PROJECT_ID, NOOBI_GAME_WRITE_PATHS), /PNG header/);
    assert.throws(() => inspectPngHeader(malformed), /PNG header/);
    await fs.unlink(path.join(root, image));
    await fs.symlink(path.join(root, '.noobi/playtest.json'), path.join(root, image));
    await assert.rejects(() => __test.readSnapshotFile(root, image, NOOBI_GAME_PROJECT_ID, NOOBI_GAME_WRITE_PATHS), /bounded regular file/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

// Private installation/history replay is retained only in the development workspace.

test('generic tool project registration is root-bound, resumes the same request, and never overwrites existing content', async (t) => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'trusted-tool-project-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const projectsRoot = path.join(temporary, 'projects');
  const sourceRoot = path.join(temporary, 'source');
  await fs.mkdir(projectsRoot);
  await fs.mkdir(sourceRoot);
  await fs.writeFile(path.join(sourceRoot, 'main.js'), 'export const starter = true;\n');
  await execFile('git', ['init', '-q', sourceRoot]);
  await execFile('git', ['-C', sourceRoot, 'add', 'main.js']);
  await execFile('git', ['-C', sourceRoot, '-c', 'user.name=Irixi Test', '-c', 'user.email=irixi-test@example.invalid', 'commit', '-qm', 'fixture']);
  const catalogue = path.join(temporary, 'catalogue.json');
  await fs.writeFile(catalogue, JSON.stringify({ schemaVersion: 1, projects: [{
    projectId: 'existing-tool-fixture', label: 'Existing fixture', root: sourceRoot,
    baselinePaths: ['main.js'], allowedWritePaths: ['main.js'], checks: [{ id: 'node-syntax-v1' }],
    native: { backend: 'codex', model: 'gpt-6-luna', allowedRoles: ['Lead'], maxAgents: 1, maxModelCalls: 8, maxDurationMs: 1_200_000 },
  }] }));
  const trusted = await createTrustedProductProjects({ file: catalogue, projectsRoot });
  const request = { name: '学习记录小工具', requestId: 'request-1234567890-abcdef' };
  await assert.rejects(() => trusted.registerToolProject({ name: '中'.repeat(80), requestId: 'request-unicode-name-123456' }),
    (error) => error.code === 'PROJECT_INPUT_INVALID');
  assert.deepEqual(await fs.readdir(projectsRoot), []);
  const suffix = crypto.createHash('sha256').update(request.requestId).digest('hex').slice(0, 12);
  const projectId = `tool-workspace-${suffix}`;
  const projectDirectory = path.join(projectsRoot, projectId);
  const pending = path.join(projectsRoot, `.irixi-create-${crypto.createHash('sha256').update(request.requestId).digest('hex').slice(0, 16)}.json`);
  await fs.writeFile(pending, `${JSON.stringify({ schemaVersion: 1, projectId, requestId: request.requestId, name: request.name, templateId: 'tool-starter-v1' })}\n`, { mode: 0o600 });
  await fs.mkdir(projectDirectory);
  await fs.writeFile(path.join(projectDirectory, 'IRIXI_PROJECT.json'), `${JSON.stringify({ schemaVersion: 1, projectId, creationKey: request.requestId, projectKind: 'utility', templateId: 'tool-starter-v1' }, null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(projectDirectory, 'README.md'), '# 新工具工程\n\n这是一个通用空白工程。具体需求以关联的 Irixi 任务为准。\n');

  const first = await trusted.registerToolProject(request);
  assert.equal(first.created, true);
  assert.equal(first.project.projectId, projectId);
  assert.equal(first.project.projectKind, 'utility');
  assert.equal(first.project.location, `projects/${projectId}`);
  assert.deepEqual(first.project.checkIds, ['node-syntax-v1']);
  assert.deepEqual(first.project.staticPreviewEntries, ['index.html']);
  assert.equal(await fs.readFile(path.join(projectDirectory, 'PRODUCT.md'), 'utf8'),
    '# 产品目标\n\n本模板不预设业务功能、答案或数据。由关联任务的原生 Lead 根据用户目标规划，再由 Developer 实现并经独立 Reviewer 审阅。\n');
  assert.equal((await execFile('git', ['-C', projectDirectory, 'rev-parse', '--show-toplevel'])).stdout.trim(), projectDirectory);
  assert.equal((await trusted.current(projectId)).native.maxModelCalls, 8);
  assert.deepEqual((await fs.readdir(projectsRoot)).sort(), [projectId]);

  await fs.writeFile(path.join(projectDirectory, 'README.md'), 'user change\n');
  const retry = await trusted.registerToolProject(request);
  assert.equal(retry.created, false);
  assert.equal(retry.project.projectId, projectId);
  assert.equal(await fs.readFile(path.join(projectDirectory, 'README.md'), 'utf8'), 'user change\n');
  assert.deepEqual((await fs.readdir(projectsRoot)).sort(), [projectId]);
  await assert.rejects(() => trusted.registerToolProject({ ...request, root: '/tmp/escape' }), /项目名称或创建请求编号无效/);
});
