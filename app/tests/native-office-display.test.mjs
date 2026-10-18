import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeExecutionRoleFallback, nativeOfficeWaitingPresentation } from '../public/native-product-state.js';

const task = { id: 'task-1', status: 'waiting_user', goal: { activeVersionId: 'goal-1' } };
const product = (overrides = {}) => ({
  current: true,
  taskId: task.id,
  goalVersionId: task.goal.activeVersionId,
  nextStep: '查看当前结果。',
  native: { plan: null, actions: { canApprovePlan: false } },
  artifact: { id: 'artifact-1', review: null, confirmation: null },
  ...overrides,
});

test('办公室状态按当前原生计划和候选审阅结果显示，不改变审批能力', () => {
  const failed = nativeOfficeWaitingPresentation(product({
    artifact: { id: 'artifact-1', review: { passed: false }, confirmation: null },
  }), task);
  assert.equal(failed.statusLabel, '审阅未通过，待修改');
  assert.equal(failed.office.title, '审阅未通过，待修改');
  assert.equal(failed.office.tone, 'attention');

  const planned = nativeOfficeWaitingPresentation(product({
    native: { plan: { text: '当前计划' }, actions: { canApprovePlan: true } },
    artifact: null,
  }), task);
  assert.equal(planned.statusLabel, '待批准计划');
  assert.equal(planned.office.title, '原生计划等待你的审批');

  const passed = nativeOfficeWaitingPresentation(product({
    artifact: { id: 'artifact-1', review: { passed: true }, confirmation: null },
  }), task);
  assert.equal(passed.statusLabel, '等待你确认');
  assert.equal(passed.office.title, '原生候选已通过审阅，等待你的确认');

  assert.equal(nativeOfficeWaitingPresentation(product(), task).statusLabel, '待审阅');
});

test('不把其他任务、旧目标或已确认候选的审阅投影到当前办公室', () => {
  assert.equal(nativeOfficeWaitingPresentation(product({ taskId: 'other-task' }), task), null);
  assert.equal(nativeOfficeWaitingPresentation(product({ goalVersionId: 'old-goal' }), task), null);
  assert.equal(nativeOfficeWaitingPresentation(product({ current: false }), task), null);
  assert.equal(nativeOfficeWaitingPresentation(product({
    artifact: { id: 'artifact-1', review: { passed: false }, confirmation: { approvalId: 'approval-1' } },
  }), task), null);
  assert.equal(nativeOfficeWaitingPresentation(product(), { ...task, status: 'running' }), null);
});

test('已确认且无在途调用时忽略历史 executing 阶段，只有当前 running 才显示执行中', () => {
  assert.equal(nativeExecutionRoleFallback({
    officeStatus: 'ready_to_export', taskLifecycle: { inFlight: false },
    execution: { phase: 'executing' }, artifact: { confirmation: { approvalId: 'approval-1' } },
  }), '本轮工作已结束，原生角色待命');
  assert.equal(nativeExecutionRoleFallback({
    officeStatus: 'running', taskLifecycle: { inFlight: true },
    execution: { phase: 'executing' }, artifact: null,
  }), '原生团队正在执行当前授权任务，当前角色尚未返回');
  assert.equal(nativeExecutionRoleFallback({
    officeStatus: 'running', taskLifecycle: { inFlight: false }, execution: { phase: 'executing' },
  }), null);
});
