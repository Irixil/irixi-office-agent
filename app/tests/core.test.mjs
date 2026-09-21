import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  acceptGoalReplacement,
  activeGoal,
  addMaterial,
  addSuggestion,
  buildPlan,
  confirmArtifact,
  correctSuggestion,
  createArtifact,
  createStore,
  createTask,
  recordReview,
  reviseArtifact,
} from '../core.mjs';
import { __test as providerTest } from '../providers.mjs';
import { __test as serverTest } from '../server.mjs';

test('替代建议未经确认不会改变当前目标，确认后旧计划作废', () => {
  const task = createTask({ goal: '完成季度复盘', successCriteria: ['含结论'], boundaries: ['不编造'] });
  const firstGoal = activeGoal(task);
  buildPlan(task);
  const suggestion = addSuggestion(task, { text: '最终目标改成准备下季度预算' });
  assert.equal(suggestion.classification, 'replace');
  assert.equal(activeGoal(task).id, firstGoal.id);
  assert.equal(task.status, 'waiting_user');

  correctSuggestion(task, suggestion.id, 'support');
  assert.equal(activeGoal(task).id, firstGoal.id);
  assert.equal(task.status, 'ready');
  correctSuggestion(task, suggestion.id, 'replace');
  const next = acceptGoalReplacement(task, suggestion.id, '准备下季度预算');
  assert.equal(next.version, 2);
  assert.equal(activeGoal(task).statement, '准备下季度预算');
  assert.equal(task.workItems.length, 0);
});

test('新候选版本不会继承旧版确认', () => {
  const task = createTask({ goal: '形成可审阅报告' });
  const first = createArtifact(task, { title: '报告', summary: '初稿', content: '# 形成可审阅报告\n\n这是一份足够长、可以核对目标与边界的候选报告正文。'.repeat(4), sources: [] }, 'demo');
  recordReview(task, first.id, { summary: '通过', checks: [{ name: '目标', passed: true, evidence: '包含目标', blocking: true }] });
  confirmArtifact(task, first.id);
  assert.equal(first.status, 'confirmed');

  const second = reviseArtifact(task, first.id, { content: `${first.content}\n\n人工补充。` });
  assert.equal(first.status, 'confirmed');
  assert.equal(second.status, 'candidate');
  assert.equal(second.reviewStatus, 'pending');
  assert.throws(() => confirmArtifact(task, second.id), /尚未通过/);
  recordReview(task, second.id, { summary: '通过', checks: [{ name: '目标', passed: true, evidence: '包含目标', blocking: true }] });
  confirmArtifact(task, second.id);
  assert.equal(first.status, 'superseded_formal');
  assert.equal(second.status, 'confirmed');
});

test('任务可原子保存并从磁盘恢复', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createStore(root);
  const task = createTask({ title: '恢复测试', goal: '重启后继续工作' });
  addMaterial(task, { name: '记录', text: '保留这段文字' });
  await store.save(task);
  const restored = await createStore(root).get(task.id);
  assert.equal(restored.title, '恢复测试');
  assert.equal(restored.materials[0].text, '保留这段文字');
});

test('演示提供者醒目标记且导出规则按成果类型限制', () => {
  const task = createTask({ title: '演示', goal: '核对演示标记', type: 'email' });
  const result = providerTest.demoResult(task);
  assert.match(result.summary, /演示提供者/);
  const artifact = createArtifact(task, result, 'demo');
  recordReview(task, artifact.id, { summary: '通过', checks: [{ name: '目标', passed: true, evidence: 'ok', blocking: true }] });
  confirmArtifact(task, artifact.id);
  assert.match(serverTest.exportBody(task, artifact, 'eml').content, /X-Irixi-Status: Draft-Only/);
  assert.throws(() => serverTest.exportBody(task, artifact, 'ics'), /不支持/);

  const calendar = createTask({ title: '日程', goal: '准备试用日程', type: 'calendar' });
  const calendarArtifact = createArtifact(calendar, providerTest.demoResult(calendar), 'demo');
  recordReview(calendar, calendarArtifact.id, { summary: '通过', checks: [{ name: '目标', passed: true, evidence: 'ok', blocking: true }] });
  confirmArtifact(calendar, calendarArtifact.id);
  assert.match(serverTest.exportBody(calendar, calendarArtifact, 'ics').content, /STATUS:TENTATIVE/);
  assert.match(serverTest.exportBody(calendar, calendarArtifact, 'html').content, /<!doctype html>/);
  assert.equal(serverTest.exportBody(calendar, calendarArtifact, 'md').extension, 'md');
});

test('网址策略拒绝本机、内网和保留地址', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '192.168.1.5', '172.20.1.2', '::1', 'fd00::1']) {
    assert.equal(serverTest.isPrivateIp(address), true, address);
  }
  assert.equal(serverTest.isPrivateIp('8.8.8.8'), false);
});
