import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertPlainJson, registeredRepository, validateProjectScopeResult } from '../project-scope.mjs';

const binding = { goalVersionId: 'goal-1', projectRootGoalVersionId: 'goal-1', projectRootInputFingerprint: 'root-1', materialApplicabilityFingerprint: null, instructionIds: [] };
const repository = {
  repositoryId: 'irixi-office-agent', treeSha256: 'tree-1',
  files: [
    { path: 'app/alpha.mjs', bytes: 40, sha256: 'a', selectable: true },
    { path: 'app/beta.mjs', bytes: 40, sha256: 'b', selectable: true },
  ],
};

function proposal(overrides = {}) {
  return {
    repositoryId: 'irixi-office-agent',
    goal: { statement: '调整两个纯函数的 JSON 行为。', successCriteria: ['给定输入得到确认结果。'], boundaries: ['不访问网络或文件系统。'] },
    deliverable: 'project_patch',
    readablePaths: ['app/alpha.mjs'], editablePaths: ['app/alpha.mjs'],
    checks: [
      { id: 'node-syntax-v1', modulePath: null, namedExport: null, cases: null },
      { id: 'json-function-v1', modulePath: 'app/alpha.mjs', namedExport: 'alpha', cases: [{ id: 'basic', argsJson: '[1]', expectedJson: '2' }] },
    ],
    rationale: '只读取和修改实现该行为的纯模块，并由宿主验证语法与逐例输出。',
    ...overrides,
  };
}

test('通用范围要求每个可改模块有独立 JSON 行为检查且不接受 syntax-only', () => {
  const valid = validateProjectScopeResult(proposal(), repository, binding);
  assert.equal(valid.status, 'proposed');
  assert.equal(valid.checks.length, 2);
  assert.deepEqual(valid.checks[1].cases, [{ id: 'basic', args: [1], expected: 2 }]);
  assert.throws(() => validateProjectScopeResult(proposal({ checks: [{ id: 'node-syntax-v1', modulePath: null, namedExport: null, cases: null }] }), repository, binding), /每个可改/);
  assert.throws(() => validateProjectScopeResult(proposal({ readablePaths: ['app/alpha.mjs', 'app/beta.mjs'], editablePaths: ['app/alpha.mjs', 'app/beta.mjs'] }), repository, binding), /每个可改/);
  const two = validateProjectScopeResult(proposal({
    readablePaths: ['app/alpha.mjs', 'app/beta.mjs'], editablePaths: ['app/alpha.mjs', 'app/beta.mjs'],
    checks: [
      { id: 'node-syntax-v1', modulePath: null, namedExport: null, cases: null },
      { id: 'json-function-v1', modulePath: 'app/alpha.mjs', namedExport: 'alpha', cases: [{ id: 'a', argsJson: '[1]', expectedJson: '2' }] },
      { id: 'json-function-v1', modulePath: 'app/beta.mjs', namedExport: 'beta', cases: [{ id: 'b', argsJson: '[{"value":2}]', expectedJson: '{"value":3}' }] },
    ],
  }), repository, binding);
  assert.deepEqual(two.editablePaths, ['app/alpha.mjs', 'app/beta.mjs']);
});

test('模型 JSON 字符串 transport 必须完整解析并规范化，非法或开放形状 fail closed', () => {
  const withCase = (item) => proposal({ checks: [
    { id: 'node-syntax-v1', modulePath: null, namedExport: null, cases: null },
    { id: 'json-function-v1', modulePath: 'app/alpha.mjs', namedExport: 'alpha', cases: [item] },
  ] });
  assert.throws(() => validateProjectScopeResult(withCase({ id: 'bad-json', argsJson: '[1', expectedJson: '2' }), repository, binding), /不是合法 JSON/);
  assert.throws(() => validateProjectScopeResult(withCase({ id: 'not-array', argsJson: '{"value":1}', expectedJson: '2' }), repository, binding), /解码后必须是数组/);
  assert.throws(() => validateProjectScopeResult(withCase({ id: 'non-finite', argsJson: '[]', expectedJson: '1e999' }), repository, binding), /非有限/);
  assert.throws(() => validateProjectScopeResult(withCase({ id: 'prototype-key', argsJson: '[]', expectedJson: '{"constructor":1}' }), repository, binding), /原型相关/);
  assert.throws(() => validateProjectScopeResult(withCase({ id: 'oversize', argsJson: '[]', expectedJson: `"${'x'.repeat(17 * 1024)}"` }), repository, binding), /有界 JSON 字符串/);
  assert.throws(() => validateProjectScopeResult(withCase({ id: 'missing', argsJson: '[]' }), repository, binding), /字段缺失/);
  assert.throws(() => validateProjectScopeResult(withCase({ id: 'extra', argsJson: '[]', expectedJson: '2', expected: 2 }), repository, binding), /多余字段/);
  assert.throws(() => validateProjectScopeResult(proposal({ checks: [
    { id: 'node-syntax-v1', modulePath: 'app/alpha.mjs', namedExport: null, cases: null },
    proposal().checks[1],
  ] }), repository, binding), /必须明确为 null/);
});

test('范围拒绝仓库外路径、超限文件与非普通 JSON', () => {
  assert.throws(() => validateProjectScopeResult(proposal({ deliverable: 'document' }), repository, binding), /只能交付/);
  assert.throws(() => validateProjectScopeResult(proposal({ readablePaths: ['../secret.mjs'] }), repository, binding), /不安全路径/);
  assert.throws(() => validateProjectScopeResult(proposal(), { ...repository, files: [{ ...repository.files[0], selectable: false }] }, binding), /仓库外文件/);
  assert.throws(() => assertPlainJson(JSON.parse('{"constructor":{"x":1}}')), /原型相关字段/);
  assert.throws(() => assertPlainJson({ value: Infinity }), /非有限/);
});

test('登记源码目录逐段拒绝符号链接且不读取目标', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-scope-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-scope-outside-'));
  try {
    await fs.mkdir(path.join(root, 'app', 'public'), { recursive: true });
    await fs.writeFile(path.join(root, 'app', 'safe.mjs'), 'export function safe() { return 1; }\n');
    await fs.writeFile(path.join(root, 'app', 'keys.mjs'), 'export const privateKey = "not-catalogued";\n');
    await fs.writeFile(path.join(outside, 'secret.mjs'), 'export const secret = 1;\n');
    await fs.symlink(path.join(outside, 'secret.mjs'), path.join(root, 'app', 'linked.mjs'));
    await assert.rejects(registeredRepository(root), /符号链接/);
    await fs.unlink(path.join(root, 'app', 'linked.mjs'));
    const catalog = await registeredRepository(root);
    assert.equal(catalog.files.some((entry) => entry.path === 'app/keys.mjs'), false);
    assert.equal(catalog.files.some((entry) => entry.path === 'app/safe.mjs'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
