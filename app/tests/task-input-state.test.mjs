import assert from 'node:assert/strict';
import test from 'node:test';

import { planInputsChanged, shouldPollTask } from '../public/task-input-state.js';

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
