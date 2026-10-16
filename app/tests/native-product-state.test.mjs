import assert from 'node:assert/strict';
import test from 'node:test';

import { canCreateNativeTask, createBoundTextareaDraft, escapeHtml, nativeActionPayload, nativeCoworkerPresence, nativeFunctionChatContext, nativeFunctionDiscussionMember, nativeProductAsOfficeTask, nativeReviewBinding, normalizeNativeCandidate, normalizeNativeProductState, normalizeNativeTaskDraft, officeFunctionForCoworker, officeFunctionForStation, renderNativeMarkup, safeLocalPath } from '../public/native-product-state.js';

const PLAN_SHA256 = 'a'.repeat(64);

test('办公室职能归属独立于原生执行角色', () => {
  assert.equal(officeFunctionForStation('researcher'), 'learning');
  assert.equal(officeFunctionForStation(' Researcher '), 'learning');
  assert.equal(officeFunctionForStation('writer'), 'utility');
  assert.equal(officeFunctionForStation('reviewer'), 'game');
  assert.equal(officeFunctionForStation('steward'), 'agent');
  assert.equal(officeFunctionForStation('archivist'), 'archive');
  assert.equal(officeFunctionForStation('developer'), null);
  assert.equal(officeFunctionForCoworker({ officeRole: 'researcher', role: 'writer', stationRole: 'writer' }), 'learning');
});

test('把目标等用户文本写入办公室HTML前逐字符转义', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

function projection(overrides = {}) {
  return {
    taskId: 'task-native-1',
    title: '真实代码任务',
    goalStatement: '完成同一任务的原生执行与审阅',
    goalVersionId: 'goal-native-1',
    current: true,
    status: 'in_progress',
    execution: { id: 'execution-1', phase: 'developer', stopReason: null },
    artifact: null,
    registeredExecution: { goalVersionId: 'goal-native-1', displayPrompt: '执行当前任务', promptSha256: 'prompt-1' },
    product: {
      projectId: 'project-1', registrySha256: 'registry-1', bindingCurrent: true, bindingError: null, workspaceScopeFingerprint: 'scope-1',
      allowedWritePaths: ['src/a.js'], checks: ['node-test'],
      capabilities: { team: true, worktree: true, staticPreviewEntries: ['index.html'], staticPreviewFiles: ['index.html', 'app.js', 'styles.css'], autoMerge: false, manualMerge: false, commandPreview: false },
      native: { allowedRoles: ['developer', 'reviewer'], maxModelCalls: 4, maxDurationMs: 600000 },
    },
    native: { bindingCurrent: true, registrySha256: 'registry-1', sessions: [], actions: { canRun: true, canReview: false, canConfirm: false, canPreview: false, canCancel: false } },
    links: { nativeTask: '/native?taskId=task-native-1', actions: '/api/product/tasks/task-native-1/actions', candidate: '/api/product/candidate', confirm: '/api/irixi-authority/confirm', patch: '/api/irixi-authority/patch', preview: '/product-preview/token/index.html' },
    ...overrides,
  };
}

test('新建原生任务保持空成功条件和边界，不由前端补写', () => {
  assert.deepEqual(normalizeNativeTaskDraft({ title: ' 任务 ', statement: ' 目标 ', successCriteria: '', boundaries: '  ' }), {
    title: '任务', statement: '目标', successCriteria: [], boundaries: [],
  });
  assert.deepEqual(normalizeNativeTaskDraft({ statement: '目标', successCriteria: ' 条件一 \n\n条件二', boundaries: [' 边界一 ', ''] }), {
    title: '', statement: '目标', successCriteria: ['条件一', '条件二'], boundaries: ['边界一'],
  });
  assert.equal(normalizeNativeTaskDraft({ statement: '目标', functionId: 'game' }).functionId, 'game');
  assert.equal(Object.hasOwn(normalizeNativeTaskDraft({ statement: '旧目标', functionId: 'reviewer' }), 'functionId'), false);
});

test('无任务初始化响应是正常设置态，不要求执行或产品登记', () => {
  const value = normalizeNativeProductState({
    task: null,
    status: 'waiting_task',
    execution: null,
    registry: null,
    setup: { projects: [], selectedProject: null, selectedScope: null },
  });
  assert.equal(value.setupOnly, true);
  assert.equal(value.setupStatus, 'waiting_task');
  assert.equal(value.taskId, null);
  assert.equal(value.officeStatus, 'idle');
  assert.deepEqual(value.setup.projects, []);
  assert.equal(value.links.createTask, '/api/product/tasks');
  assert.equal(value.links.projects, '/api/product/projects');
});

test('原生新任务入口仅在有受控创建链接且没有活动执行时开放', () => {
  const task = projection({ links: { createTask: '/api/product/tasks' }, execution: null });
  assert.equal(canCreateNativeTask(task), true);
  assert.equal(canCreateNativeTask({ ...task, status: 'completed', execution: { id: 'execution-done', phase: 'completed' },
    native: { actions: { canCancel: false, canPause: false }, sessions: [{ status: 'completed' }] } }), true);
  assert.equal(canCreateNativeTask({ ...task, status: 'ready_to_export', execution: {
    id: 'execution-exported', phase: 'executing', stopReason: null,
    deadline: '2026-10-15T10:26:44.040Z',
    modelCalls: Array.from({ length: 5 }, () => ({ status: 'completed' })),
  } }), true);
  assert.equal(canCreateNativeTask({ ...task, status: 'ready_to_export', execution: {
    id: 'execution-exported', phase: 'executing', deadline: '2026-10-15T10:26:44.040Z',
    modelCalls: [{ status: 'running' }],
  } }), false);
  assert.equal(canCreateNativeTask({ ...task, status: 'ready_to_export', execution: {
    id: 'execution-exported', phase: 'executing', stopReason: null, goalVersionId: 'goal-native-1',
  }, native: { actions: { phase: 'complete', canCancel: true, canPause: true }, sessions: Array.from({ length: 5 }, () => ({ status: 'completed' })) } }), true);
  assert.equal(canCreateNativeTask({ ...task, execution: { id: 'execution-running', phase: 'executing' } }), false);
  assert.equal(canCreateNativeTask({ ...task, execution: { id: 'execution-expired', phase: 'executing', deadline: '2020-01-01T00:00:00Z', modelCalls: [] } }), true);
  assert.equal(canCreateNativeTask({ ...task, execution: { id: 'execution-planned', phase: 'planned' },
    native: { actions: { canCancel: true, canPause: false }, sessions: [{ status: 'running' }] } }), false);
  assert.equal(canCreateNativeTask({ ...task, links: {} }), false);
  assert.equal(canCreateNativeTask(task, 'openoffice-blocked'), false);
  const terminal = normalizeNativeProductState(projection({ status: 'completed',
    execution: { id: 'execution-done', phase: 'completed', stopReason: null } }));
  assert.equal(terminal.links.createTask, '/api/product/tasks');
  assert.equal(canCreateNativeTask(terminal), true);
  const staleExportPhase = normalizeNativeProductState(projection({ status: 'ready_to_export',
    execution: { id: 'execution-exported', phase: 'executing', deadline: '2026-10-15T10:26:44.040Z',
      modelCalls: Array.from({ length: 5 }, () => ({ status: 'completed' })) } }));
  assert.equal(staleExportPhase.execution.modelCalls.length, 5);
  assert.equal(staleExportPhase.links.createTask, '/api/product/tasks');
  assert.equal(canCreateNativeTask(staleExportPhase), true);
  const nativeComplete = normalizeNativeProductState(projection({ status: 'ready_to_export',
    execution: { id: 'run-native-fixture', phase: 'executing', stopReason: null, goalVersionId: 'goal-native-1' },
    native: { bindingCurrent: true, aiEnabled: false, actions: { phase: 'complete', canCancel: true, canPause: true },
      sessions: Array.from({ length: 5 }, (_, index) => ({ eventId: `event-${index}`, status: 'completed' })) },
  }));
  assert.equal(nativeComplete.native.actions.phase, 'complete');
  assert.equal(nativeComplete.native.actions.canCancel, true);
  assert.equal(nativeComplete.native.sessions.length, 5);
  assert.equal(nativeComplete.links.createTask, '/api/product/tasks');
  assert.equal(canCreateNativeTask(nativeComplete), true);
});

test('待选范围与待授权是正常设置态，并保留完整目标和登记项目', () => {
  const task = {
    id: 'task-setup-1', title: '原生设置', goalVersionId: 'goal-setup-1', statement: '接入登记项目',
    successCriteria: ['保留完整条件'], boundaries: ['设置阶段不执行'], functionId: 'game',
  };
  const project = {
    projectId: 'project-live-1', label: '已登记项目', scopeFingerprint: 'scope-live-1',
    allowedWritePaths: ['src/main.ts'], checkIds: ['typecheck'], current: true,
  };
  const waiting = normalizeNativeProductState({ task, status: 'waiting_scope', execution: null, registry: null, setup: { projects: [project], selectedProject: null, selectedScope: null } });
  assert.equal(waiting.setupPending, true);
  assert.equal(waiting.setupStatus, 'waiting_scope');
  assert.equal(waiting.links.createTask, '/api/product/tasks');
  assert.equal(waiting.functionId, 'game');
  assert.equal(canCreateNativeTask(waiting), true);
  assert.equal(waiting.officeStatus, 'ready');
  assert.deepEqual(waiting.successCriteria, ['保留完整条件']);
  assert.deepEqual(waiting.setup.projects[0], project);
  assert.equal(nativeProductAsOfficeTask(waiting).goal.versions[0].boundaries[0], '设置阶段不执行');
  assert.equal(nativeProductAsOfficeTask(waiting).functionId, 'game');

  const selected = normalizeNativeProductState({
    task, status: 'waiting_scope_authorization', execution: null, registry: null,
    setup: { projects: [project], selectedProject: project, selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId, selectedAt: '2026-10-11T11:18:50.134Z', current: true } },
    native: { actions: { canAuthorizeScope: true } },
  });
  assert.equal(selected.setupStatus, 'waiting_scope_authorization');
  assert.equal(canCreateNativeTask(selected), true);
  assert.equal(selected.setup.selectedScope.current, true);
  assert.equal(selected.native.actions.canAuthorizeScope, true);
  assert.deepEqual(nativeActionPayload(selected, 'authorize_scope', { projectId: project.projectId, expectedScopeFingerprint: project.scopeFingerprint }), {
    projectId: project.projectId, expectedScopeFingerprint: project.scopeFingerprint,
    action: 'authorize_scope', expectedGoalVersionId: task.goalVersionId,
  });

  const authorized = normalizeNativeProductState({
    task, status: 'ready_to_run', execution: null, registry: null,
    canPrepareRun: true, canRun: false, blockedReason: 'native_runtime_not_started',
    setup: { projects: [project], selectedProject: project, selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId, selectedAt: '2026-10-11T11:30:55.144Z', current: true } },
  });
  assert.equal(authorized.setupPending, true);
  assert.equal(authorized.setupStatus, 'ready_to_run');
  assert.equal(authorized.canPrepareRun, true);
  assert.equal(authorized.native.actions.canRun, false);
  assert.equal(authorized.execution, null);
  assert.equal(authorized.product, null);
  assert.match(authorized.nextStep, /尚未开始/);
  assert.deepEqual(nativeActionPayload(authorized, 'prepare_run', { expectedScopeFingerprint: project.scopeFingerprint }), {
    expectedScopeFingerprint: project.scopeFingerprint,
    action: 'prepare_run',
    expectedGoalVersionId: task.goalVersionId,
  });

  const unavailable = normalizeNativeProductState({
    task, status: 'runtime_unavailable',
    execution: { id: 'execution-setup-1', phase: 'planned' },
    registry: { status: 'runtime_starting', projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, registrySha256: 'registry-setup-1', registeredEventId: 'event-registry-1' },
    canPrepareRun: true, canReconnect: true,
    setup: { projects: [project], selectedProject: project, selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId, current: true } },
    blockedReason: 'native_runtime_unavailable',
  });
  assert.equal(unavailable.setupPending, true);
  assert.equal(unavailable.setupStatus, 'runtime_unavailable');
  assert.equal(unavailable.execution.id, 'execution-setup-1');
  assert.equal(unavailable.registry.projectId, project.projectId);
  assert.equal(unavailable.registry.registrySha256, 'registry-setup-1');
  assert.equal(unavailable.canPrepareRun, true);
  assert.equal(unavailable.officeStatus, 'partial');
  assert.match(unavailable.nextStep, /执行与产品登记仍保留/);
  assert.deepEqual(nativeActionPayload(unavailable, 'prepare_run', { expectedScopeFingerprint: project.scopeFingerprint }), {
    expectedScopeFingerprint: project.scopeFingerprint,
    action: 'prepare_run', expectedGoalVersionId: task.goalVersionId,
  });
  assert.deepEqual(nativeActionPayload(unavailable, 'prepare_run', {
    mode: 'reuse_current_result', expectedScopeFingerprint: project.scopeFingerprint,
    expectedExecutionId: 'execution-setup-1', expectedRegistrySha256: 'registry-setup-1',
    expectedArtifactId: 'artifact-setup-1', expectedArtifactVersion: 1,
  }), {
    mode: 'reuse_current_result', expectedScopeFingerprint: project.scopeFingerprint,
    action: 'prepare_run', expectedGoalVersionId: task.goalVersionId,
    expectedExecutionId: 'execution-setup-1', expectedRegistrySha256: 'registry-setup-1',
    expectedArtifactId: 'artifact-setup-1', expectedArtifactVersion: 1,
  });
  assert.deepEqual(nativeActionPayload(unavailable, 'instructions', { text: '输入变化' }), {
    text: '输入变化', action: 'instructions', expectedGoalVersionId: task.goalVersionId,
    expectedExecutionId: 'execution-setup-1', expectedRegistrySha256: 'registry-setup-1',
  });
});

test('原生来源标记的真实 roster 与 Lead 可以在无 session 时投影，但运行仍绑定当前执行', () => {
  const value = normalizeNativeProductState(projection({
    actor: null,
    status: 'waiting_user',
    execution: { id: 'execution-1', phase: 'planned', stopReason: null },
    team: { source: 'openoffice-native', agents: [
      { id: 'product-lead', name: 'Lead', actor: 'Lead', stationRole: 'coordinator', status: 'idle', isTeamLead: true },
      { id: 'product-senior-developer', name: 'Senior Developer', actor: 'Senior Developer', stationRole: 'writer', status: 'idle' },
      { id: 'product-reviewer', name: 'Reviewer', actor: 'Reviewer', stationRole: 'reviewer', status: 'idle' },
    ] },
    native: {
      bindingCurrent: true,
      registrySha256: 'registry-1',
      source: 'openoffice-native',
      aiEnabled: true,
      agents: [
        { id: 'product-lead', name: 'Lead', role: 'Lead', isTeamLead: true },
        { id: 'product-senior-developer', name: 'Senior Developer', role: 'Senior Developer', isTeamLead: false },
        { id: 'product-reviewer', name: 'Reviewer', role: 'Reviewer', isTeamLead: false },
      ],
      runAgentId: 'product-lead',
      phase: 'design',
      plan: { text: '先核对范围，再修改并检查。', sha256: PLAN_SHA256 },
      sessions: [],
      actions: { canRun: true, canApprovePlan: true, canResume: false, stopClass: null },
    },
  }));
  assert.deepEqual(value.team.map((agent) => agent.id), ['product-lead', 'product-senior-developer', 'product-reviewer']);
  assert.equal(value.native.runAgentId, 'product-lead');
  assert.deepEqual(value.native.plan, { text: '先核对范围，再修改并检查。', sha256: PLAN_SHA256 });
  assert.equal(value.native.agents.find((agent) => agent.id === value.native.runAgentId).isTeamLead, true);
  assert.equal(value.native.actions.canRun, true);
  assert.equal(value.native.actions.canContinue, false);
  assert.equal(value.officeStatus, 'ready');
  assert.deepEqual(nativeActionPayload(value, 'run'), {
    action: 'run', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
  });
  assert.deepEqual(nativeActionPayload(value, 'approve_plan'), {
    action: 'approve_plan', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
    expectedPlanSha256: PLAN_SHA256,
  });
  assert.deepEqual(nativeActionPayload(value, 'approve_plan', { expectedPlanSha256: 'spoofed-plan' }), {
    action: 'approve_plan', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
    expectedPlanSha256: PLAN_SHA256,
  });
  const officeTask = nativeProductAsOfficeTask(value);
  assert.deepEqual(nativeCoworkerPresence(value, officeTask, 'writer'), {
    member: officeTask.team.agents.find((agent) => agent.id === 'product-senior-developer'),
    workItem: null,
    active: false,
  });

  const missingAiFlag = normalizeNativeProductState(projection({
    actor: null,
    execution: { id: 'execution-1', phase: 'planned' },
    native: { bindingCurrent: true, registrySha256: 'registry-1', source: 'openoffice-native', agents: [{ id: 'product-lead', name: 'Lead', role: 'Lead', isTeamLead: true }], runAgentId: 'product-lead', actions: { canRun: true } },
  }));
  assert.equal(missingAiFlag.native.aiEnabled, null);
  assert.equal(missingAiFlag.native.actions.canRun, false);
  assert.equal(missingAiFlag.officeStatus, 'ready');

  const missingPlan = normalizeNativeProductState(projection({
    actor: null,
    execution: { id: 'execution-1', phase: 'planned' },
    native: { bindingCurrent: true, registrySha256: 'registry-1', source: 'openoffice-native', actions: { canApprovePlan: true } },
  }));
  assert.equal(missingPlan.native.actions.canApprovePlan, false);
  assert.throws(() => nativeActionPayload(missingPlan, 'approve_plan'), /没有可批准且绑定有效/);

  const stalePlan = normalizeNativeProductState(projection({
    actor: null,
    execution: { id: 'execution-1', phase: 'planned' },
    native: { bindingCurrent: false, registrySha256: 'registry-1', source: 'openoffice-native', plan: { text: '旧计划', sha256: 'stale-plan' }, actions: { canApprovePlan: true } },
  }));
  assert.equal(stalePlan.native.plan, null);
  assert.equal(stalePlan.native.actions.canApprovePlan, false);
  assert.throws(() => nativeActionPayload(stalePlan, 'approve_plan'), /没有可批准且绑定有效/);

  const malformedPlan = normalizeNativeProductState(projection({
    actor: null,
    execution: { id: 'execution-1', phase: 'planned' },
    native: { bindingCurrent: true, registrySha256: 'registry-1', source: 'openoffice-native', plan: { text: '摘要格式错误', sha256: 'A'.repeat(64) }, actions: { canApprovePlan: true } },
  }));
  assert.equal(malformedPlan.native.plan, null);
  assert.equal(malformedPlan.native.actions.canApprovePlan, false);
  assert.throws(() => nativeActionPayload(malformedPlan, 'approve_plan'), /没有可批准且绑定有效/);

  const actionMetadataOnly = normalizeNativeProductState(projection({
    actor: null,
    execution: { id: 'execution-1', phase: 'planned' },
    native: {
      bindingCurrent: true,
      registrySha256: 'registry-1',
      source: 'openoffice-native',
      agents: [{ id: 'product-lead', name: 'Lead', role: 'Lead', isTeamLead: true }],
      runAgentId: 'product-lead',
      actions: { canRun: true, aiEnabled: true },
    },
  }));
  assert.equal(actionMetadataOnly.native.aiEnabled, null);
  assert.equal(actionMetadataOnly.native.actions.canRun, false);
});

test('原生同事讨论只接受当前目标历史，并同时受模型能力和完整执行绑定约束', () => {
  const value = normalizeNativeProductState(projection({
    team: { source: 'openoffice-native', agents: [
      { id: 'product-senior-developer', name: 'Senior Developer', actor: 'Senior Developer', stationRole: 'writer', status: 'idle' },
    ] },
    conversations: [
      { id: 'message-1', at: '2026-10-11T12:00:00.000Z', actor: 'user', status: 'saved', text: '现在做到哪一步？', agentId: 'product-senior-developer', role: 'Senior Developer' },
      { id: 'message-2', at: '2026-10-11T12:00:10.000Z', actor: 'assistant', status: 'completed', text: '正在核对范围。', sourceTaskId: 'native-chat-1', agentId: 'product-senior-developer', role: 'Senior Developer' },
      { id: 'message-3', actor: 'assistant', status: 'failed', text: null, sourceTaskId: 'native-chat-2', agentId: 'product-senior-developer', role: 'Senior Developer' },
      { id: '', actor: 'assistant', status: 'completed', text: '不能进入投影' },
    ],
    native: {
      bindingCurrent: true,
      registrySha256: 'registry-1',
      source: 'openoffice-native',
      aiEnabled: true,
      agents: [{ id: 'product-senior-developer', name: 'Senior Developer', role: 'Senior Developer', isTeamLead: false }],
      sessions: [],
      actions: { canChat: true },
    },
  }));
  assert.equal(value.native.actions.canChat, true);
  assert.deepEqual(value.conversations.map(({ id, actor, status, text, agentId }) => ({ id, actor, status, text, agentId })), [
    { id: 'message-1', actor: 'user', status: 'saved', text: '现在做到哪一步？', agentId: 'product-senior-developer' },
    { id: 'message-2', actor: 'assistant', status: 'completed', text: '正在核对范围。', agentId: 'product-senior-developer' },
    { id: 'message-3', actor: 'assistant', status: 'failed', text: null, agentId: 'product-senior-developer' },
  ]);
  assert.deepEqual(nativeActionPayload(value, 'chat', { text: '只读讨论', agentId: 'product-senior-developer' }), {
    text: '只读讨论', agentId: 'product-senior-developer', action: 'chat',
    expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
  });

  const zeroModel = normalizeNativeProductState(projection({
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: false, sessions: [], actions: { canChat: true } },
  }));
  assert.equal(zeroModel.native.actions.canChat, false);
  assert.throws(() => nativeActionPayload({ ...value, current: false, execution: null }, 'chat', { text: '旧绑定', agentId: 'product-senior-developer' }), /执行绑定不完整/);
});

test('原生执行角色保留在 roster，不映射成办公室职能工位', () => {
  const unknown = normalizeNativeProductState(projection({ team: { agents: [{ id: 'product-developer', actor: 'developer', name: 'developer', status: 'idle' }] } }));
  const unknownTask = nativeProductAsOfficeTask(unknown);
  assert.equal(unknown.stationRole, null);
  assert.deepEqual(unknown.team, []);
  assert.equal(unknownTask.activeRole, null);
  assert.deepEqual(unknownTask.workItems, []);

  const developer = normalizeNativeProductState(projection({ actor: 'developer' }));
  const developerTask = nativeProductAsOfficeTask(developer);
  assert.equal(developer.stationRole, 'writer');
  assert.equal(developerTask.activeRole, null);
  assert.deepEqual(developerTask.workItems, []);

  const roster = normalizeNativeProductState(projection({
    actor: 'developer',
    team: [{ id: 'developer-1', actor: 'developer', name: '原生开发员', status: 'working' }],
    workItems: [{ id: 'work-1', agentId: 'developer-1', title: '修改代码', status: 'in_progress' }],
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true, sessions: [{ agentId: 'developer-1', role: 'developer', status: 'running' }], actions: { canRun: true } },
  }));
  const rosterTask = nativeProductAsOfficeTask(roster);
  assert.equal(rosterTask.team.agents[0].name, '原生开发员');
  assert.equal(rosterTask.activeRole, null);
  assert.equal(rosterTask.activeAgentId, null);
  assert.equal(rosterTask.workItems[0].role, 'writer');
  assert.equal(rosterTask.workItems[0].status, 'running');
  assert.equal(roster.native.actions.canRun, true);
  assert.equal(roster.links.actions, '/api/product/tasks/task-native-1/actions');
});

test('原生任务职能显式传入，旧任务不按执行阶段分类', () => {
  assert.equal(normalizeNativeProductState(projection({ functionId: 'utility' })).functionId, 'utility');
  assert.equal(nativeProductAsOfficeTask(normalizeNativeProductState(projection({ functionId: 'game' }))).functionId, 'game');
  assert.equal(normalizeNativeProductState(projection({ functionId: 'reviewer' })).functionId, null);
  assert.equal(normalizeNativeProductState(projection({ functionId: undefined, actor: 'reviewer' })).functionId, null);

  const executingGame = normalizeNativeProductState(projection({
    functionId: 'utility', status: 'running', actor: 'reviewer',
    team: [{ id: 'native-reviewer', actor: 'reviewer', name: '实际 Reviewer', status: 'working' }],
    workItems: [{ id: 'review-work', agentId: 'native-reviewer', title: '审阅', status: 'running' }],
    native: { bindingCurrent: true, registrySha256: 'registry-1', sessions: [{ agentId: 'native-reviewer', role: 'reviewer', status: 'running' }] },
  }));
  const officeTask = nativeProductAsOfficeTask(executingGame);
  assert.equal(officeTask.activeRole, null);
  assert.equal(nativeCoworkerPresence(executingGame, officeTask, 'reviewer').active, false);
  assert.equal(nativeCoworkerPresence(executingGame, officeTask, 'writer').active, true);
});

test('匹配职能的只读讨论只选择当前团队内已登记的原生 Lead', () => {
  const lead = { id: 'native-lead', name: '真实 Lead' };
  const product = { functionId: 'agent', current: true, native: { runAgentId: lead.id, aiEnabled: true, actions: { canChat: true } }, team: [lead] };
  assert.deepEqual(nativeFunctionChatContext(product, 'agent', true), { functionOwner: true, member: lead, canSend: true });
  assert.deepEqual(nativeFunctionChatContext(product, 'utility', true), { functionOwner: false, member: null, canSend: false });
  assert.deepEqual(nativeFunctionChatContext({ ...product, functionId: null }, 'agent', true), { functionOwner: false, member: null, canSend: false });
  assert.deepEqual(nativeFunctionChatContext({ ...product, team: [] }, 'agent', true), { functionOwner: true, member: null, canSend: false });
  assert.equal(nativeFunctionChatContext(product, 'learning', true).canSend, false);
  assert.equal(nativeFunctionChatContext(product, 'archive', true), null);
  assert.equal(nativeFunctionChatContext({ ...product, current: false }, 'agent', true).canSend, false);
  assert.equal(nativeFunctionChatContext({ ...product, native: { ...product.native, aiEnabled: false } }, 'agent', true).canSend, false);
  assert.equal(nativeFunctionChatContext({ ...product, native: { ...product.native, actions: { canChat: false } } }, 'agent', true).canSend, false);
  assert.equal(nativeFunctionChatContext(product, 'agent', false).canSend, false);
});

test('审阅通过与确认分别映射为等待确认和允许下载', () => {
  const reviewed = normalizeNativeProductState(projection({
    status: 'completed',
    execution: null,
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1', hostCheck: { passed: true }, review: { id: 'review-1', passed: true } },
  }));
  assert.equal(reviewed.officeStatus, 'waiting_user');
  assert.match(reviewed.nextStep, /等待你核对并确认/);

  const confirmed = normalizeNativeProductState(projection({
    status: 'completed',
    execution: null,
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1', review: { id: 'review-1', passed: true }, confirmation: { approvalId: 'approval-1', artifactVersion: 2, goalVersionId: 'goal-native-1' } },
  }));
  assert.equal(confirmed.officeStatus, 'ready_to_export');
  assert.match(confirmed.nextStep, /下载同一份已确认 patch/);
});

test('真实候选必须与当前任务、目标、版本和候选摘要完全绑定', () => {
  const product = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1', hostCheck: { passed: true }, review: { id: 'review-1', passed: true } },
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true, actions: { canInspectDiff: true, canConfirm: true, canApprovePlan: true } },
  }));
  assert.equal(product.links.candidate, '/api/product/candidate');
  assert.equal(product.native.actions.canInspectDiff, true);
  assert.equal(product.native.actions.canApprovePlan, false);
  assert.deepEqual(nativeActionPayload(product, 'revise', { expectedArtifactId: 'spoofed', expectedArtifactVersion: 99, reason: '修正范围。' }), {
    action: 'revise', expectedArtifactId: 'artifact-1', expectedArtifactVersion: 2, reason: '修正范围。',
    expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
  });
  const candidate = normalizeNativeCandidate({
    taskId: product.taskId, goalVersionId: product.goalVersionId, artifactId: 'artifact-1', artifactVersion: 2,
    candidateSha256: 'candidate-1', diffSha256: 'diff-1', patchSha256: 'patch-1', patch: 'diff --git a/a b/a',
    files: [{ path: 'a', sha256: 'file-1', bytes: 12 }], checks: [{ id: 'check-1', passed: true }], review: null, confirmation: null,
  }, product);
  assert.equal(candidate.files[0].path, 'a');
  assert.equal(candidate.checks[0].passed, true);
  assert.throws(() => normalizeNativeCandidate({ ...candidate, artifactVersion: 3 }, product), /不属于当前任务、目标或版本/);
});

test('静态预览动作绑定当前候选摘要，状态只接受同源就绪链接', () => {
  const product = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1', hostCheck: { passed: true } },
    preview: { status: 'pending', taskId: 'task-native-1', goalVersionId: 'goal-native-1', executionId: 'execution-1', registrySha256: 'registry-1', artifactId: 'artifact-1', artifactVersion: 2, entry: 'index.html', candidateSha256: 'candidate-1' },
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true, actions: { canPreview: true } },
  }));
  assert.equal(product.preview.status, 'pending');
  assert.equal(product.links.preview, null);
  assert.deepEqual(nativeActionPayload(product, 'preview', { entry: 'index.html', expectedCandidateSha256: 'spoofed' }), {
    action: 'preview', entry: 'index.html', expectedCandidateSha256: 'candidate-1', expectedGoalVersionId: 'goal-native-1',
    expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1', expectedArtifactId: 'artifact-1', expectedArtifactVersion: 2,
  });
  const ready = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1' },
    preview: { status: 'ready', taskId: 'task-native-1', goalVersionId: 'goal-native-1', executionId: 'execution-1', registrySha256: 'registry-1', artifactId: 'artifact-1', artifactVersion: 2, entry: 'index.html', candidateSha256: 'candidate-1' },
    previewLink: '/product-preview/token/index.html',
  }));
  assert.equal(ready.links.preview, '/product-preview/token/index.html');
  const staleReady = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1' },
    preview: { status: 'ready', taskId: 'task-native-1', goalVersionId: 'goal-native-1', executionId: 'execution-1', registrySha256: 'registry-1', artifactId: 'artifact-1', artifactVersion: 2, entry: 'index.html', candidateSha256: 'old-candidate' },
    previewLink: '/product-preview/token/index.html',
  }));
  assert.equal(staleReady.preview, null);
  assert.equal(staleReady.links.preview, null);
});

test('目标失效优先于旧候选，不能继续显示为可交付', () => {
  const value = normalizeNativeProductState(projection({
    current: false,
    status: 'completed',
    artifact: { id: 'artifact-old', version: 1, review: { id: 'review-old', passed: true }, confirmation: { approvalId: 'approval-old', artifactVersion: 1, goalVersionId: 'goal-old' } },
  }));
  assert.equal(value.officeStatus, 'partial');
  assert.match(value.nextStep, /旧执行与旧候选不能继续/);
});

test('产品登记绑定失效与暂停状态都不会显示同事忙碌', () => {
  const stale = normalizeNativeProductState(projection({ product: { ...projection().product, bindingCurrent: false, bindingError: '旧绑定' }, actor: 'developer' }));
  assert.equal(stale.current, false);
  assert.equal(nativeProductAsOfficeTask(stale).activeRole, null);

  const paused = normalizeNativeProductState(projection({ status: 'paused', actor: 'developer' }));
  assert.equal(paused.officeStatus, 'partial');
  assert.equal(nativeProductAsOfficeTask(paused).activeRole, null);

  const unregistered = normalizeNativeProductState(projection({ product: null, actor: 'developer' }));
  assert.equal(unregistered.current, false);
  assert.equal(nativeProductAsOfficeTask(unregistered).activeRole, null);
});

test('原生入口只接受同源相对路径', () => {
  assert.equal(safeLocalPath('/api/product-state?task=1'), '/api/product-state?task=1');
  assert.equal(safeLocalPath('https://example.com/steal'), null);
  assert.equal(safeLocalPath('//example.com/steal'), null);
});

test('关键状态字段缺失时拒绝投影，不静默使用旧任务', () => {
  assert.throws(() => normalizeNativeProductState(projection({ goalVersionId: null })), /goalVersionId/);
  assert.throws(() => normalizeNativeProductState(projection({ current: null })), /current/);
});

test('原生动作始终绑定当前目标、执行与产品登记，调用输入不能覆盖', () => {
  const product = normalizeNativeProductState(projection());
  assert.deepEqual(nativeActionPayload(product, 'run', {
    agentId: 'developer-1',
    action: 'cancel',
    expectedGoalVersionId: 'goal-old',
    expectedExecutionId: 'execution-old',
    expectedRegistrySha256: 'registry-old',
  }), {
    agentId: 'developer-1',
    action: 'run',
    expectedGoalVersionId: 'goal-native-1',
    expectedExecutionId: 'execution-1',
    expectedRegistrySha256: 'registry-1',
  });
  assert.equal(nativeActionPayload(product, 'materials', { name: '资料', text: '正文' }).action, 'materials');
});

test('记忆保存和修正绑定当前目标，但不附带无关执行与登记字段', () => {
  const product = normalizeNativeProductState(projection());
  assert.deepEqual(nativeActionPayload(product, 'memory_save', {
    scopeType: 'global', kind: 'preference', title: '语言', text: '简短中文。',
  }), {
    scopeType: 'global', kind: 'preference', title: '语言', text: '简短中文。',
    action: 'memory_save', expectedGoalVersionId: 'goal-native-1',
  });
  assert.deepEqual(nativeActionPayload(product, 'memory_change', {
    memoryId: 'memory-abc123', expectedRevision: 2, operation: 'deactivate',
  }), {
    memoryId: 'memory-abc123', expectedRevision: 2, operation: 'deactivate',
    action: 'memory_change', expectedGoalVersionId: 'goal-native-1',
  });
});

test('失效绑定或未知动作不能形成原生动作载荷', () => {
  const current = normalizeNativeProductState(projection());
  const stale = normalizeNativeProductState(projection({ current: false }));
  assert.throws(() => nativeActionPayload(stale, 'run'), /绑定不完整/);
  assert.throws(() => nativeActionPayload(current, 'publish'), /不支持/);
  assert.throws(() => nativeActionPayload(current, 'support'), /不支持/);
  assert.throws(() => nativeActionPayload(current, 'resume'), /不支持/);
});

test('设置态没有执行或产品登记时仍可提交设置动作，但不能运行', () => {
  const draft = normalizeNativeProductState(projection({
    status: 'draft', execution: null, product: null,
    native: { bindingCurrent: false, sessions: [], actions: { canGoal: true, canInstructions: true, canMaterials: true } },
  }));
  assert.equal(draft.authorityCurrent, true);
  assert.equal(draft.current, false);
  assert.deepEqual(nativeActionPayload(draft, 'instructions', { text: '补充验收要求' }), {
    text: '补充验收要求', action: 'instructions', expectedGoalVersionId: 'goal-native-1',
  });
  assert.throws(() => nativeActionPayload(draft, 'run'), /执行绑定不完整/);
});

test('继续和输入动作只认后端明确资格', () => {
  const product = normalizeNativeProductState(projection({
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true, sessions: [], actions: {
      canContinue: true, canChat: true, canInstructions: true, canMaterials: true,
    } },
  }));
  assert.equal(product.native.actions.canContinue, true);
  assert.equal(product.native.actions.canChat, true);
  assert.equal(product.native.actions.canInstructions, true);
  assert.equal(product.native.actions.canMaterials, true);
  assert.equal(product.native.actions.canRun, false);
  assert.equal(product.native.actions.canCancel, false);
});

test('轮询重绘保留同绑定退回理由、焦点与光标', () => {
  const product = {
    taskId: 'task-1', goalVersionId: 'goal-1', execution: { id: 'run-1' },
    product: { registrySha256: 'registry-1' },
    artifact: { id: 'artifact-1', version: 16, candidateSha256: 'candidate-1' },
  };
  const binding = nativeReviewBinding(product);
  const makeField = (value, formBinding) => ({
    value, form: { dataset: { reviseBinding: formBinding } },
    selectionStart: 3, selectionEnd: 6, selectionDirection: 'forward',
    focus(options) { this.focusOptions = options; active = this; },
    setSelectionRange(start, end, direction) { this.selection = [start, end, direction]; },
  });
  let active;
  const root = { querySelector: () => field };
  const draft = createBoundTextareaDraft('form[data-native-revise] textarea[name="reason"]');
  let field = makeField('请保留这个修复', binding);
  active = field;
  draft.capture(root, binding, active);
  field = makeField('', binding);
  assert.equal(field.value, '');
  active = null;
  draft.restore(root, binding);
  assert.equal(field.value, '请保留这个修复');
  assert.deepEqual(field.focusOptions, { preventScroll: true });
  assert.deepEqual(field.selection, [3, 6, 'forward']);
});

test('执行或候选绑定变化时不把旧退回理由带入新版本', () => {
  const product = {
    taskId: 'task-1', goalVersionId: 'goal-1', execution: { id: 'run-1' },
    product: { registrySha256: 'registry-1' },
    artifact: { id: 'artifact-1', version: 16, candidateSha256: 'candidate-1' },
  };
  const oldBinding = nativeReviewBinding(product);
  const newBinding = nativeReviewBinding({ ...product, execution: { id: 'run-2' } });
  let active;
  const makeField = (value, formBinding) => ({
    value, form: { dataset: { reviseBinding: formBinding } }, selectionStart: 0, selectionEnd: 0,
    focus() { active = this; }, setSelectionRange() {},
  });
  let field = makeField('旧版本原因', oldBinding);
  const root = { querySelector: () => field };
  const draft = createBoundTextareaDraft('form[data-native-revise] textarea[name="reason"]');
  draft.capture(root, oldBinding, field);
  draft.capture(root, newBinding, field);
  field = makeField('', newBinding);
  active = null;
  draft.restore(root, newBinding);
  assert.equal(field.value, '');
  assert.equal(active, null);
  assert.equal(nativeReviewBinding({ ...product, artifact: { ...product.artifact, version: 17 } }) === oldBinding, false);
  assert.equal(nativeReviewBinding({ ...product, product: { registrySha256: 'registry-2' } }) === oldBinding, false);
});

test('原生轮询复用规范化DOM并只保留同绑定的有效范围选择与焦点', () => {
  const makeSelect = (fingerprint) => ({
    tagName: 'SELECT',
    dataset: { nativeFocusKey: 'scope-project' },
    value: 'agent-office-native-server',
    options: [
      { value: 'agent-office-native-server', dataset: { scopeFingerprint: 'agent-scope', scopeCurrent: 'true' } },
      { value: 'sample-article-project', dataset: { scopeFingerprint: fingerprint, scopeCurrent: 'true' } },
    ],
    get selectedOptions() { return this.options.filter((option) => option.value === this.value); },
    focus() { this.focused = true; },
  });
  const makeButton = (disabled) => ({
    tagName: 'BUTTON', dataset: { nativeFocusKey: 'scope-submit' }, disabled,
    focus(options) { this.focused = true; this.focusOptions = options; },
  });
  let html = '';
  let scope = makeSelect('scope-v1');
  let button = makeButton(true);
  let writes = 0;
  const root = {
    dataset: {},
    contains: (node) => node === scope || node === button,
    querySelector(selector) { return selector === 'form[data-native-scope] select[name="projectId"]' ? scope : null; },
    querySelectorAll() { return [scope, button]; },
    get innerHTML() { return html; },
    set innerHTML(value) {
      writes += 1;
      html = value.replace(/\s(required|disabled)(?=[\s>])/g, ' $1=""');
      const fingerprint = value.includes('scope-v2') ? 'scope-v2' : 'scope-v1';
      scope = makeSelect(fingerprint);
      button = makeButton(value.includes(' disabled'));
    },
  };
  const markup = (status, fingerprint, disabled) => `<form data-native-scope><select name="projectId" required><option data-scope-fingerprint="${fingerprint}"></option></select><button data-native-focus-key="scope-submit"${disabled ? ' disabled' : ''}>${status}</button></form>`;

  const firstMarkup = markup('等待资格', 'scope-v1', true);
  assert.equal(renderNativeMarkup(root, firstMarkup, 'task/goal/catalog-v1'), true);
  scope.value = 'sample-article-project';
  const oldButton = button;
  const enabledMarkup = markup('可以选择', 'scope-v1', false);
  assert.equal(renderNativeMarkup(root, enabledMarkup, 'task/goal/catalog-v1', oldButton), true);
  assert.equal(html.includes('<button data-native-focus-key="scope-submit">'), true);
  assert.equal(scope.value, 'sample-article-project');
  assert.equal(button.focused, true);
  assert.deepEqual(button.focusOptions, { preventScroll: true });
  assert.equal(root.innerHTML, root.dataset.nativeRenderDOM);

  const stableSelect = scope;
  assert.equal(renderNativeMarkup(root, enabledMarkup, 'task/goal/catalog-v1', button), false);
  assert.equal(writes, 2);
  assert.equal(scope, stableSelect);

  html = '<div>状态暂不可用</div>';
  scope = null;
  button = null;
  assert.equal(renderNativeMarkup(root, enabledMarkup, 'task/goal/catalog-v1'), true);
  assert.equal(html.includes('可以选择'), true);
  assert.equal(writes, 3);

  const changedCatalog = markup('可以选择', 'scope-v2', false);
  assert.equal(renderNativeMarkup(root, changedCatalog, 'task/goal/catalog-v2', button), true);
  assert.equal(scope.value, 'agent-office-native-server');
  assert.equal(button.focused, undefined);
  assert.equal(writes, 4);
});
