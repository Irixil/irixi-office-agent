import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { addMaterial, createArtifact, createStore, createTask } from '../core.mjs';
import { createProviders } from '../providers.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-real-provider-'));

try {
  const store = createStore(root);
  const task = createTask({
    title: '真实模型安全样例',
    goal: '只根据合成材料形成一份三点办公摘要',
    type: 'document',
    provider: 'codex-cli',
    successCriteria: ['包含现状、风险和下一步'],
    boundaries: ['不得补充材料中没有的数字', '不得执行外部操作'],
  });
  addMaterial(task, {
    name: 'synthetic-note.txt',
    source: 'synthetic-test-fixture',
    text: '现状：原型已经完成。风险：尚未进行用户试用。下一步：安排一次本地试用并记录反馈。',
  });
  await store.save(task);
  const providers = createProviders({ projectRoot, store });
  const connection = await providers.verifyCodex();
  assert.equal(connection.ok, true, connection.message);

  const generated = await providers.generate(task);
  assert.ok(generated.title && generated.summary && generated.content);
  assert.match(generated.content, /原型|试用|反馈/);
  const artifact = createArtifact(task, generated, 'codex-cli');
  const reviewed = await providers.review(task, artifact);
  assert.ok(Array.isArray(reviewed.checks) && reviewed.checks.length >= 4);
  assert.ok(reviewed.checks.every((item) => typeof item.passed === 'boolean'));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    connection: connection.message,
    title: generated.title,
    sourceCount: generated.sources.length,
    reviewCheckCount: reviewed.checks.length,
    reviewPassed: reviewed.checks.every((item) => item.passed || !item.blocking),
    contentSha256: crypto.createHash('sha256').update(generated.content).digest('hex'),
  }, null, 2)}\n`);
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
