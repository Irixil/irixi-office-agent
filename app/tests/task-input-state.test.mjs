import assert from 'node:assert/strict';
import test from 'node:test';

import { materialDecisionExpectation, planInputsChanged, projectWorkspaceAttachExpectation, shouldPollTask } from '../public/task-input-state.js';

test('模型计划在新增支持目标的改稿要求后要求重新规划', () => {
  const task = {
    goal: { activeVersionId: 'goal-1' },
    plan: { source: 'model' },
    materials: [{ id: 'material-1', status: 'ready' }],
    suggestions: [{ id: 'suggestion-1', goalVersionId: 'goal-1', classification: 'support', status: 'routed' }],
    workItems: [{ inputMaterialIds: ['material-1'], inputSuggestionIds: [] }],
  };
  assert.equal(planInputsChanged(task), true);
  task.workItems[0].inputSuggestionIds.push('suggestion-1');
  assert.equal(planInputsChanged(task), false);
});

test('生成的网页证据不被当作用户新增材料触发重新规划', () => {
  const task = {
    goal: { activeVersionId: 'goal-1' }, plan: { source: 'model' }, suggestions: [],
    materials: [{ id: 'material-web', status: 'ready', generatedEvidence: true }],
    workItems: [{ inputMaterialIds: [], inputSuggestionIds: [] }],
  };
  assert.equal(planInputsChanged(task), false);
});

test('长复核和原生刷新只轮询发起操作的当前任务', () => {
  const task = { id: 'task-a', status: 'failed' };
  assert.equal(shouldPollTask(task, { pendingAction: 'artifact-review', pendingActionTaskId: 'task-a' }), true);
  assert.equal(shouldPollTask(task, { pendingAction: 'native-refresh', pendingActionTaskId: 'task-b' }), false);
  assert.equal(shouldPollTask({ id: 'task-b', status: 'running' }), true);
});

test('材料决定提交读取 render-time 表单快照而不读取刷新后的 live task', () => {
  const form = { dataset: {
    expectedFingerprint: JSON.stringify('fingerprint-old'),
    expectedScope: JSON.stringify({ localGoalVersionId: 'goal-old', projectRootTaskId: 'task-root', projectRootGoalVersionId: 'root-old', projectRootInputFingerprint: 'input-old' }),
    expectedContentSha256: JSON.stringify('content-old'),
  } };
  const liveTask = { materialContext: { fingerprint: 'fingerprint-new', scope: { localGoalVersionId: 'goal-new' }, directory: [{ contentSha256: 'content-new' }] } };
  const expectation = materialDecisionExpectation(form);
  assert.equal(expectation.expectedFingerprint, 'fingerprint-old');
  assert.equal(expectation.expectedScope.localGoalVersionId, 'goal-old');
  assert.equal(expectation.expectedContentSha256, 'content-old');
  assert.notEqual(expectation.expectedFingerprint, liveTask.materialContext.fingerprint);
});

test('项目授权提交只读取 render-time scope/capability 快照', () => {
  const old = {
    expectedGoalVersionId: 'goal-old', expectedProjectRootGoalVersionId: 'root-old',
    expectedProjectRootInputFingerprint: 'root-input-old', expectedMaterialApplicabilityFingerprint: 'material-old',
    expectedPreviousScopeFingerprint: 'scope-old', expectedCapabilityFingerprint: 'cap-old',
  };
  const form = { dataset: { expectedSnapshot: JSON.stringify(old) } };
  const liveTask = { goal: { activeVersionId: 'goal-new' }, projectWorkspace: { scopeFingerprint: 'scope-new' } };
  assert.deepEqual(projectWorkspaceAttachExpectation(form), old);
  assert.notEqual(projectWorkspaceAttachExpectation(form).expectedGoalVersionId, liveTask.goal.activeVersionId);
});

test('project UI 计划 freshness 包含 workspace scope 与 source snapshot', () => {
  const task = {
    type: 'project', goal: { activeVersionId: 'goal-1' }, plan: { source: 'model' }, suggestions: [], materials: [],
    materialContext: { fingerprint: null, effectiveMaterialIds: [] },
    projectWorkspace: { scopeFingerprint: 'scope-new', sourceSnapshotSha256: 'source-new' },
    workItems: [{ inputMaterialIds: [], inputSuggestionIds: [], materialApplicabilityFingerprint: null, workspaceScopeFingerprint: 'scope-old', sourceSnapshotSha256: 'source-new' }],
  };
  assert.equal(planInputsChanged(task), true);
  task.workItems[0].workspaceScopeFingerprint = 'scope-new';
  assert.equal(planInputsChanged(task), false);
});
