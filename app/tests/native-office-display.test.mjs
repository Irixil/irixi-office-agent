import assert from 'node:assert/strict';
import test from 'node:test';

import { nativeExecutionRoleFallback, nativeExecutionStatusLabel, nativeGoalVersionStamp, nativeOfficeWaitingPresentation, nativeReviewDisposition } from '../public/native-product-state.js';

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

test('办公室状态区分待审、未验证与有完整绑定证据的审阅结果', () => {
  const reportSha = 'a'.repeat(64);
  const failed = nativeOfficeWaitingPresentation(product({
    native: { plan: null, actions: { canApprovePlan: false, canAdjudicateConfirm: true } },
    artifact: { id: 'artifact-1', review: { id: 'review-fail', passed: false, nativeVerdict: 'FAIL', fullOutputSha256: reportSha }, confirmation: null },
  }), task);
  assert.equal(failed.statusLabel, '审阅未通过，待修改');
  assert.equal(failed.office.title, '审阅未通过，待修改');
  assert.equal(failed.office.tone, 'attention');

  const unverified = nativeOfficeWaitingPresentation(product({
    artifact: { id: 'artifact-1', review: { id: 'review-unverified', passed: false, nativeVerdict: 'UNVERIFIED', fullOutputSha256: null }, confirmation: null },
  }), task);
  assert.equal(unverified.statusLabel, '审阅未验证');
  assert.doesNotMatch(unverified.office.title, /未通过/u);

  const unknown = nativeReviewDisposition({ id: 'review-unknown', passed: false });
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.label, '审阅状态待核实');

  const planned = nativeOfficeWaitingPresentation(product({
    native: { plan: { text: '当前计划' }, actions: { canApprovePlan: true } },
    artifact: null,
  }), task);
  assert.equal(planned.statusLabel, '待批准计划');
  assert.equal(planned.office.title, '原生计划等待你的审批');

  const passed = nativeOfficeWaitingPresentation(product({
    native: { plan: null, actions: { canApprovePlan: false, canConfirm: true } },
    artifact: { id: 'artifact-1', review: { id: 'review-pass', passed: true, nativeVerdict: 'PASS', fullOutputSha256: reportSha }, confirmation: null },
  }), task);
  assert.equal(passed.statusLabel, '等待你确认');
  assert.equal(passed.office.title, '原生候选已通过审阅，等待你的确认');

  assert.equal(nativeOfficeWaitingPresentation(product(), task).statusLabel, '待审阅');
  assert.equal(nativeReviewDisposition(null).state, 'pending');
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

test('当前执行状态中文展示结束态，其他状态复用已有文案且不改执行账', () => {
  assert.equal(nativeExecutionStatusLabel({ current: true, native: { phase: 'complete' },
    execution: { phase: 'completed' }, taskLifecycle: { status: 'completed', inFlight: false } }), '本轮执行已结束');
  assert.equal(nativeExecutionStatusLabel({ native: { phase: 'executing' }, statusLabel: '原生团队正在执行' }), '原生团队正在执行');
  assert.equal(nativeExecutionStatusLabel({ native: { phase: 'waiting_user' }, status: '等待确认' }), '等待确认');
});

test('状态显示依据当前执行阶段、在途记录与准备失败，不把planned或过期执行说成已结束', () => {
  const failure = { phase: 'developer', actor: 'developer', status: 'failed', modelCallCreated: false,
    error: '工作区准备超时。', createdAt: '2026-10-19T12:00:01.000Z' };
  assert.equal(nativeExecutionStatusLabel({ current: true, status: 'waiting_user', statusLabel: '等待下一步',
    native: { phase: 'complete', actions: { phase: 'complete' }, preparationFailures: [] },
    execution: { phase: 'planned', modelCalls: [] }, taskLifecycle: { status: 'waiting_user', inFlight: false } }), '执行已准备，等待 Lead 启动');
  assert.equal(nativeExecutionStatusLabel({ current: true, status: 'waiting_user',
    native: { phase: 'complete', plan: { text: '[PLAN]...[/PLAN]' }, actions: { canApprovePlan: true }, preparationFailures: [] },
    execution: { phase: 'planned', modelCalls: [] }, taskLifecycle: { status: 'waiting_user', inFlight: false } }), 'Lead 计划待审批');
  assert.equal(nativeExecutionStatusLabel({ current: true, status: 'in_progress',
    native: { phase: 'complete', sessions: [], preparationFailures: [failure] },
    execution: { phase: 'executing', deadline: '2026-10-19T12:20:00.000Z', modelCalls: [{ status: 'completed' }] },
    taskLifecycle: { status: 'running', inFlight: false } }), '成员执行准备失败（未创建本次模型调用）');
  assert.equal(nativeExecutionStatusLabel({ current: true, status: 'in_progress', statusLabel: '等待后台核实',
    native: { phase: 'complete', sessions: [], preparationFailures: [] },
    execution: { phase: 'executing', deadline: '2000-01-01T00:00:00.000Z', modelCalls: [{ status: 'running' }] },
    taskLifecycle: { status: 'running', inFlight: true } }), '执行时限已到，仍有在途工作待核实');
  assert.equal(nativeExecutionStatusLabel({ current: true, status: 'partial',
    native: { phase: 'complete', sessions: [], preparationFailures: [] },
    execution: { phase: 'partial', stopReason: 'execution_deadline_elapsed', modelCalls: [] },
    taskLifecycle: { status: 'failed', inFlight: false } }), '本轮执行已到期，调用记录保留');
  assert.equal(nativeExecutionStatusLabel({ current: true, status: 'failed', statusLabel: '本轮已停止',
    native: { phase: 'partial', sessions: [], preparationFailures: [], actions: { canRun: false } },
    execution: { phase: 'partial', modelCalls: [{ role: 'Lead', status: 'failed' }] },
    taskLifecycle: { status: 'failed', inFlight: false } }), '本轮已停止');
  assert.equal(nativeExecutionStatusLabel({ current: true, status: 'ready_to_export', artifact: { confirmation: { approvalId: 'approved-v2' } },
    native: { phase: 'complete', sessions: [], preparationFailures: [] },
    execution: { phase: 'executing', deadline: '2000-01-01T00:00:00.000Z', modelCalls: [{ status: 'completed' }] },
    taskLifecycle: { status: 'waiting_user', inFlight: false } }), '本轮执行已结束');
  assert.equal(nativeExecutionStatusLabel({ current: true, status: 'in_progress', statusLabel: '原生团队正在执行',
    native: { phase: 'executing', sessions: [{ status: 'completed', createdAt: '2026-10-19T12:00:02.000Z' }], preparationFailures: [failure] },
    execution: { phase: 'executing', modelCalls: [{ status: 'completed' }] },
    taskLifecycle: { status: 'running', inFlight: false } }), '原生团队正在执行');
});

test('目标印章显示短编号，同时保留完整目标编号供查询', () => {
  const versionId = 'goal-fe40c5d8-20f1-4169-9398-d51ea096d3a6';
  assert.deepEqual(nativeGoalVersionStamp(versionId), { label: 'goal-fe4…', fullId: versionId });
  assert.deepEqual(nativeGoalVersionStamp(''), { label: '尚未建立', fullId: '' });
});
