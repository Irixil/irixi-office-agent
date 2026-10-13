import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { activeGoal, createStore, createTask, projectInputFingerprint } from '../core.mjs';
import { start } from '../server.mjs';

async function request(url, pathname, body) {
  const response = await fetch(`${url}${pathname}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value = await response.json();
  return { response, value };
}

function decisionBody(task, materialId, patch) {
  const entry = task.materialContext.directory.find((item) => item.id === materialId);
  return {
    category: 'goal_specific', disposition: 'use', impact: 'non_blocking', purpose: '当前目标用途', reason: 'HTTP 测试',
    ...patch,
    expectedFingerprint: task.materialContext.fingerprint,
    expectedScope: task.materialContext.scope,
    expectedContentSha256: entry.contentSha256,
  };
}

async function waitFor(url, taskId, predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await request(url, `/api/tasks/${taskId}`);
    if (predicate(current.value.task)) return current.value.task;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('等待任务状态超时。');
}

test('HTTP 材料决定校验迟到页面并在目标替换与重启后保持资格和原因', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-material-applicability-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await request(running.url, '/api/tasks', {
    title: '私密试用准备', goal: '准备公开发布', type: 'research', provider: 'demo', successCriteria: ['形成准备清单'], boundaries: ['不发布'],
  });
  const taskId = created.value.task.id;
  const add = async (name, text) => (await request(running.url, `/api/tasks/${taskId}/materials/text`, { name, text })).value;
  const fact = await add('试用事实', '当前已登记 12 位试用者。');
  const slogan = await add('旧发布口号', '面向所有人公开发布。');
  const critical = await add('私密边界', '不得上传真实客户记录。');
  const optional = await add('旧排版', '使用三栏版式。');

  let task = optional.task;
  const missingImpactBody = decisionBody(task, critical.material.id, { category: 'constraint', disposition: 'pending', purpose: '缺少显式影响选择' });
  delete missingImpactBody.impact;
  const missingImpact = await request(running.url, `/api/tasks/${taskId}/materials/${critical.material.id}/applicability`, missingImpactBody);
  assert.equal(missingImpact.response.status, 400);
  assert.match(missingImpact.value.error.message, /必须明确选择是否影响交付/);
  const decide = async (materialId, patch) => {
    const result = await request(running.url, `/api/tasks/${taskId}/materials/${materialId}/applicability`, decisionBody(task, materialId, patch));
    assert.equal(result.response.status, 200, JSON.stringify(result.value));
    task = result.value.task;
    return result;
  };
  await decide(fact.material.id, { category: 'reusable_fact', purpose: '用户明确允许沿用的试用人数参考' });
  const staleBody = decisionBody(task, slogan.material.id, { category: 'goal_specific', purpose: '旧发布口号' });
  await decide(slogan.material.id, { category: 'goal_specific', purpose: '旧发布口号' });
  const stale = await request(running.url, `/api/tasks/${taskId}/materials/${slogan.material.id}/applicability`, staleBody);
  assert.equal(stale.response.status, 409);
  assert.match(stale.value.error.message, /刷新后重新提交/);
  await decide(critical.material.id, { category: 'constraint', disposition: 'use', impact: 'required_for_delivery', purpose: '私密数据边界' });
  await decide(optional.material.id, { category: 'constraint', disposition: 'pending', impact: 'non_blocking', purpose: '旧排版偏好' });

  const suggestion = await request(running.url, `/api/tasks/${taskId}/suggestions`, { text: '替换目标为私密试用准备', classification: 'replace' });
  const replaced = await request(running.url, `/api/tasks/${taskId}/suggestions/${suggestion.value.suggestion.id}/accept-goal`, {
    statement: '准备私密试用', successCriteria: ['形成可审阅试用清单'], boundaries: ['不发布', '不上传真实客户记录'],
  });
  assert.equal(replaced.response.status, 200);
  task = replaced.value.task;
  assert.deepEqual(task.materialContext.effectiveMaterialIds, [fact.material.id]);
  assert.equal(task.materialContext.blockingDecisions.length, 1);
  assert.equal(task.materialContext.blockingDecisions[0].materialId, critical.material.id);
  assert.match(task.continuity.progress.nextStep, /决定/);

  const beforeRestartFingerprint = task.materialContext.fingerprint;
  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root });
  const restored = await request(running.url, `/api/tasks/${taskId}`);
  assert.equal(restored.value.task.materialContext.fingerprint, beforeRestartFingerprint);
  assert.deepEqual(restored.value.task.materialContext.effectiveMaterialIds, [fact.material.id]);
  assert.equal(restored.value.task.materialContext.blockingDecisions[0].materialId, critical.material.id);
});

test('linked legacy 启动无变更时逐字节保留，root 输入变化时先按旧 scope 激活再失效', async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-material-legacy-link-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const store = createStore(dataRoot);
  await store.init();
  const rootTask = createTask({ title: '项目根', goal: '根目标' });
  rootTask.projectRootGoalVersionId = activeGoal(rootTask).id;
  rootTask.projectRootInputFingerprint = projectInputFingerprint(rootTask);
  const child = createTask({ title: '关联任务', goal: '子目标' });
  child.projectRootTaskId = rootTask.id;
  child.projectRootGoalVersionId = activeGoal(rootTask).id;
  child.projectRootInputFingerprint = rootTask.projectRootInputFingerprint;
  child.materials.push({ id: 'material-legacy-linked', name: '旧关联材料', kind: 'text', source: 'user', status: 'ready', text: '只属于旧 root scope。', bytes: 25, createdAt: '2026-01-01T00:00:00.000Z' });
  await store.save(rootTask);
  await store.save(child);
  const childFile = path.join(dataRoot, child.id, 'task.json');
  const before = await fs.readFile(childFile, 'utf8');

  let running = await start({ port: 0, root: dataRoot });
  const unchanged = await fs.readFile(childFile, 'utf8');
  assert.equal(unchanged, before);
  await new Promise((resolve) => running.server.close(resolve));

  const changedRoot = await store.get(rootTask.id);
  changedRoot.suggestions.push({ id: 'suggestion-new-root-input', text: '新增已接受根交代', classification: 'support', status: 'routed', goalVersionId: activeGoal(changedRoot).id, createdAt: new Date().toISOString() });
  changedRoot.projectRootInputFingerprint = projectInputFingerprint(changedRoot);
  await store.save(changedRoot);
  running = await start({ port: 0, root: dataRoot });
  t.after(() => running.server.close());
  const response = await request(running.url, `/api/tasks/${child.id}`);
  assert.equal(response.response.status, 200);
  assert.equal(response.value.task.materialContext.policyActive, true);
  assert.equal(response.value.task.materialApplicability.legacyScope.projectRootInputFingerprint, rootTask.projectRootInputFingerprint);
  assert.equal(response.value.task.projectRootInputFingerprint, changedRoot.projectRootInputFingerprint);
  assert.equal(response.value.task.materialContext.directory.find((item) => item.id === 'material-legacy-linked').eligible, false);
});

test('关键待确认允许 demo 研究完成并在合成前明确停下，不占用生成调用', async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-material-critical-gate-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const running = await start({ port: 0, root: dataRoot });
  t.after(() => running.server.close());
  const created = await request(running.url, '/api/tasks', { title: '试用准备', goal: '形成私密试用说明', type: 'research', provider: 'demo' });
  const taskId = created.value.task.id;
  const factAdded = await request(running.url, `/api/tasks/${taskId}/materials/text`, { name: '人数', text: '试用人数为 12 人。' });
  const constraintAdded = await request(running.url, `/api/tasks/${taskId}/materials/text`, { name: '私密边界', text: '不得上传客户记录。' });
  let task = constraintAdded.value.task;
  let decided = await request(running.url, `/api/tasks/${taskId}/materials/${factAdded.value.material.id}/applicability`, decisionBody(task, factAdded.value.material.id, { category: 'reusable_fact', purpose: '人数参考' }));
  task = decided.value.task;
  decided = await request(running.url, `/api/tasks/${taskId}/materials/${constraintAdded.value.material.id}/applicability`, decisionBody(task, constraintAdded.value.material.id, { category: 'constraint', disposition: 'pending', impact: 'required_for_delivery', purpose: '私密数据边界' }));
  assert.equal(decided.response.status, 200);
  const continued = await request(running.url, `/api/tasks/${taskId}/continue`, {});
  assert.equal(continued.response.status, 202);
  assert.equal(continued.value.action, 'running');
  const stopped = await waitFor(running.url, taskId, (current) => current.status === 'waiting_user');
  assert.equal(stopped.workItems.find((item) => item.role === 'researcher').status, 'completed');
  assert.equal(stopped.workItems.find((item) => item.role === 'writer').status, 'blocked');
  assert.equal(stopped.execution.stopReason, 'material_decision_required');
  assert.equal(stopped.artifacts.length, 0);
  assert.equal(stopped.execution.modelCalls.length, 0);
  assert.match(stopped.continuity.progress.nextStep, /决定/);
});

test('standalone legacy 缺 root 字段时 GET 不迁移，首次决定按 hydrated canonical scope 成功保存', async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-material-legacy-root-fields-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const store = createStore(dataRoot);
  await store.init();
  const legacy = createTask({ title: '旧独立任务', goal: '延续旧目标' });
  delete legacy.projectRootGoalVersionId;
  delete legacy.projectRootInputFingerprint;
  legacy.materials.push({ id: 'material-legacy-root', name: '旧材料', kind: 'text', source: 'user', status: 'ready', text: '旧材料正文。', bytes: 21, createdAt: '2026-01-01T00:00:00.000Z' });
  await store.save(legacy);
  const taskFile = path.join(dataRoot, legacy.id, 'task.json');
  const before = await fs.readFile(taskFile, 'utf8');
  const running = await start({ port: 0, root: dataRoot });
  t.after(() => running.server.close());
  const loaded = await request(running.url, `/api/tasks/${legacy.id}`);
  assert.equal(loaded.response.status, 200);
  assert.equal(await fs.readFile(taskFile, 'utf8'), before);
  assert.equal(loaded.value.task.materialContext.scope.projectRootInputFingerprint, projectInputFingerprint(legacy));
  const saved = await request(running.url, `/api/tasks/${legacy.id}/materials/material-legacy-root/applicability`, decisionBody(loaded.value.task, 'material-legacy-root', { category: 'goal_specific', purpose: '当前目标继续使用' }));
  assert.equal(saved.response.status, 200, JSON.stringify(saved.value));
  assert.equal(saved.value.task.materialContext.scope.projectRootInputFingerprint, projectInputFingerprint(legacy));
  const persisted = await store.get(legacy.id);
  assert.equal(persisted.projectRootGoalVersionId, activeGoal(legacy).id);
  assert.equal(persisted.projectRootInputFingerprint, projectInputFingerprint(legacy));
});

test('linked legacy 缺 root scope 字段时 GET 不迁移，首次决定显式绑定当前 root', async (t) => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-material-legacy-linked-fields-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const store = createStore(dataRoot);
  await store.init();
  const rootTask = createTask({ title: '根任务', goal: '根目标' });
  const child = createTask({ title: '旧子任务', goal: '子目标' });
  child.projectRootTaskId = rootTask.id;
  delete child.projectRootGoalVersionId;
  delete child.projectRootInputFingerprint;
  child.materials.push({ id: 'material-legacy-linked-fields', name: '旧子任务材料', kind: 'text', source: 'user', status: 'ready', text: '旧子任务正文。', bytes: 24, createdAt: '2026-01-01T00:00:00.000Z' });
  await store.save(rootTask);
  await store.save(child);
  const taskFile = path.join(dataRoot, child.id, 'task.json');
  const before = await fs.readFile(taskFile, 'utf8');
  const running = await start({ port: 0, root: dataRoot });
  t.after(() => running.server.close());
  const loaded = await request(running.url, `/api/tasks/${child.id}`);
  assert.equal(loaded.response.status, 200);
  assert.equal(await fs.readFile(taskFile, 'utf8'), before);
  assert.equal(loaded.value.task.materialContext.scope.projectRootGoalVersionId, activeGoal(rootTask).id);
  assert.equal(loaded.value.task.materialContext.scope.projectRootInputFingerprint, projectInputFingerprint(rootTask));
  const saved = await request(running.url, `/api/tasks/${child.id}/materials/material-legacy-linked-fields/applicability`, decisionBody(loaded.value.task, 'material-legacy-linked-fields', { category: 'goal_specific', purpose: '当前子任务使用' }));
  assert.equal(saved.response.status, 200, JSON.stringify(saved.value));
  const persisted = await store.get(child.id);
  assert.equal(persisted.projectRootGoalVersionId, activeGoal(rootTask).id);
  assert.equal(persisted.projectRootInputFingerprint, projectInputFingerprint(rootTask));
});
