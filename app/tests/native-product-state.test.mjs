import assert from 'node:assert/strict';
import test from 'node:test';

import { canCreateNativeTask, canReviewNativeCandidate, createBoundTextareaDraft, escapeHtml, filterNativeTaskHistory, gameWorkspaceBindingMatches, gameWorkspaceFileResponseMatches, nativeActionPayload, nativeCoworkerPresence, nativeCoworkerTask, nativeFunctionChatContext, nativeFunctionDiscussionMember, nativeOfficeWaitingPresentation, nativeProductAsOfficeTask, nativeReviewBinding, normalizeNativeCandidate, normalizeNativeProductState, normalizeNativeTaskDraft, officeFunctionForCoworker, officeFunctionForStation, renderNativeMarkup, renderTaskListMarkup, safeLocalPath } from '../public/native-product-state.js';

const PLAN_SHA256 = 'a'.repeat(64);
const INSTRUCTION_SNAPSHOT_SHA256 = 'f'.repeat(64);

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

test('NPC优先打开当前同职能任务，否则找最近已结算同职能任务，不跨职能代选', () => {
  const tasks = [
    { id: 'utility-old', functionId: 'utility', updatedAt: '2026-10-20' },
    { id: 'game-recent', functionId: 'game', updatedAt: '2026-10-23' },
    { id: 'utility-busy', functionId: 'utility', updatedAt: '2026-10-24', inFlight: true },
  ];
  assert.equal(nativeCoworkerTask(tasks, 'game', 'game-recent').id, 'game-recent');
  assert.equal(nativeCoworkerTask(tasks, 'utility', 'game-recent').id, 'utility-old');
  assert.equal(nativeCoworkerTask(tasks, 'agent', 'game-recent'), null);
});

test('把目标等用户文本写入办公室HTML前逐字符转义', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
});

test('原生对话历史完整保留，不按参与者或条数截断', () => {
  const conversations = Array.from({ length: 14 }, (_, index) => ({
    id: `conversation-${index}`, actor: index % 2 ? 'assistant' : 'user', status: 'saved', text: `历史消息 ${index}`,
  }));
  const product = normalizeNativeProductState(projection({ conversations }));
  assert.equal(product.conversations.length, 14);
  assert.equal(product.conversations[13].text, '历史消息 13');
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
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [], actions: { canRun: true, canReview: false, canConfirm: false, canPreview: false, canCancel: false } },
    links: { nativeTask: '/native?taskId=task-native-1', actions: '/api/product/tasks/task-native-1/actions', candidate: '/api/product/candidate', confirm: '/api/irixi-authority/confirm', patch: '/api/irixi-authority/patch', preview: '/product-preview/token/index.html' },
    ...overrides,
  };
}

test('接受目标条件与原生当前阶段独立于未改写的执行账本', () => {
  const value = normalizeNativeProductState(projection({
    status: 'ready_to_export',
    successCriteria: ['按已接受目标交付可审阅候选。'],
    boundaries: ['不覆盖正式源。'],
    execution: { id: 'execution-1', phase: 'executing', stopReason: null },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      phase: 'complete', sessions: [], actions: {} },
  }));

  assert.deepEqual(value.successCriteria, ['按已接受目标交付可审阅候选。']);
  assert.deepEqual(value.boundaries, ['不覆盖正式源。']);
  assert.equal(value.native.phase, 'complete');
  assert.equal(value.execution.phase, 'executing');
  assert.equal(value.status, 'ready_to_export');
});

test('execution 未提供调用记录时保持待核，不从 native sessions 重复计数', () => {
  const missing = normalizeNativeProductState(projection({
    execution: { id: 'execution-1', phase: 'executing', stopReason: null },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      sessions: [{ callOrdinal: 1, status: 'completed' }, { callOrdinal: 2, status: 'running' }], actions: {} },
  }));
  assert.equal(missing.execution.modelCalls, null);

  const explicitNone = normalizeNativeProductState(projection({
    execution: { id: 'execution-1', phase: 'prepared', stopReason: null, modelCalls: [] },
  }));
  assert.deepEqual(explicitNone.execution.modelCalls, []);
});

test('完成态产品投影保留后台登记项目供工程选择器使用', () => {
  const project = { projectId: 'project-utility-1', label: '已登记工具', scopeFingerprint: 'f'.repeat(64),
    allowedWritePaths: ['app.js'], checkIds: ['node-syntax-v1'], current: true };
  const value = normalizeNativeProductState(projection({ setup: { projects: [project], selectedProject: null, selectedScope: null } }));
  assert.deepEqual(value.setup.projects, [project]);
});

test('自动只读审阅接续授权只在目标、范围、执行和候选绑定一致时显示', () => {
  const candidateSha256 = 'a'.repeat(64);
  const continuation = { taskId: 'task-native-1', goalVersionId: 'goal-native-1', executionId: 'execution-1',
    registrySha256: 'registry-1', scopeFingerprint: 'scope-1', artifactId: 'artifact-1', artifactVersion: 1,
    candidateSha256, authorized: true, status: 'authorized',
    dispatchEventId: 'event-review-1', reviewRoundId: null, maxModelCalls: 1, maxDurationMs: 1200000 };
  const current = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 1, candidateSha256, status: 'candidate', review: null },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      autoReviewContinuation: continuation, actions: {} },
  }));
  assert.equal(current.native.autoReviewContinuation.status, 'authorized');
  const stale = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 1, candidateSha256: 'b'.repeat(64), status: 'candidate', review: null },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      autoReviewContinuation: continuation, actions: {} },
  }));
  assert.equal(stale.native.autoReviewContinuation, null);
  assert.throws(() => nativeActionPayload(current, 'prepare_run', { autoReviewContinuation: 'yes' }), /布尔/);
});

test('未持久化计划状态经真实归一化后不会显示为待批准', () => {
  const value = normalizeNativeProductState(projection({
    status: 'waiting_user',
    native: { bindingCurrent: true, registrySha256: 'registry-1', source: 'openoffice-native',
      phase: 'design', plan: { text: '原始 Lead 计划', sha256: PLAN_SHA256 }, planApprovalStatus: 'not_persisted',
      aiEnabled: true, actions: { canApprovePlan: false } },
  }));
  assert.equal(value.native.planApprovalStatus, 'not_persisted');
  assert.equal(value.native.actions.canApprovePlan, false);
  const presentation = nativeOfficeWaitingPresentation(value, {
    id: value.taskId, status: 'waiting_user', goal: { activeVersionId: value.goalVersionId },
  });
  assert.notEqual(presentation?.statusLabel, '待批准计划');

  const unknown = normalizeNativeProductState(projection({
    native: { bindingCurrent: true, planApprovalStatus: 'untrusted-value', actions: {} },
  }));
  assert.equal(unknown.native.planApprovalStatus, 'not_ready');
});

test('人工裁决入口保留原始 FAIL 并规范化完整的授权留痕', () => {
  const value = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 43, status: 'candidate', candidateSha256: 'a'.repeat(64),
      review: { id: 'review-fail-1', passed: false, nativeVerdict: 'FAIL', scopeOutcome: 'completed', fullOutputSha256: 'b'.repeat(64) },
      confirmation: null },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [],
      actions: { canConfirm: false, canAdjudicateConfirm: true } },
  }));
  assert.equal(value.artifact.review.passed, false);
  assert.equal(value.artifact.review.nativeVerdict, 'FAIL');
  assert.equal(value.native.actions.canConfirm, false);
  assert.equal(value.native.actions.canAdjudicateConfirm, true);
  const confirmed = normalizeNativeProductState(projection({ artifact: { id: 'artifact-1', version: 43, status: 'confirmed',
    candidateSha256: 'a'.repeat(64), review: { id: 'review-fail-1', passed: false, nativeVerdict: 'FAIL' },
    confirmation: { approvalId: 'approval-1', artifactVersion: 43, goalVersionId: 'goal-native-1', reviewAdjudication: {
      reviewId: 'review-fail-1', reviewFullOutputSha256: 'b'.repeat(64), reason: '保留原FAIL并记录理由',
      decidedBy: '真人授权主控', decidedAt: '2026-10-18T04:00:00.000Z',
      authorizationSourceThreadId: '01a0bf2d-670d-7281-a677-d1ace9528000', authorizationText: '本轮明确授权原文',
    } } } }));
  assert.equal(confirmed.artifact.review.passed, false);
  assert.equal(confirmed.artifact.confirmation.reviewAdjudication.authorizationSourceThreadId, '01a0bf2d-670d-7281-a677-d1ace9528000');
  assert.equal(confirmed.artifact.confirmation.reviewAdjudication.authorizationText, '本轮明确授权原文');
});

test('游戏工坊文件响应必须匹配当前候选、目标、执行、登记、选中路径与请求序号', () => {
  const native = normalizeNativeProductState(projection({
    functionId: 'game',
    artifact: { id: 'artifact-game-1', version: 2, candidateSha256: 'c'.repeat(64), status: 'candidate' },
    product: { ...projection().product, projectId: 'noobi-owl-book-sorter-v1' },
  }));
  const binding = {
    taskId: native.taskId, goalVersionId: native.goalVersionId, runId: native.execution.id,
    projectId: native.product.projectId, registrySha256: native.product.registrySha256,
    scopeFingerprint: native.product.workspaceScopeFingerprint, artifactId: native.artifact.id,
    artifactVersion: native.artifact.version, candidateSha256: native.artifact.candidateSha256,
  };
  const response = { binding, view: 'candidate', relativePath: 'src/main.js', file: { content: 'ok', binary: false } };
  assert.equal(gameWorkspaceBindingMatches({ binding }, native), true);
  assert.equal(gameWorkspaceFileResponseMatches(response, { native, expectedBinding: binding,
    view: 'candidate', relativePath: 'src/main.js', requestId: 8, currentRequestId: 8 }), true);
  assert.equal(gameWorkspaceFileResponseMatches(response, { native, expectedBinding: binding,
    view: 'candidate', relativePath: 'src/other.js', requestId: 8, currentRequestId: 8 }), false);
  assert.equal(gameWorkspaceFileResponseMatches(response, { native, expectedBinding: binding,
    view: 'source', relativePath: 'src/main.js', requestId: 8, currentRequestId: 8 }), false);
  assert.equal(gameWorkspaceFileResponseMatches(response, { native, expectedBinding: binding,
    view: 'candidate', relativePath: 'src/main.js', requestId: 7, currentRequestId: 8 }), false);
  const changedCandidate = normalizeNativeProductState(projection({
    functionId: 'game', artifact: { id: 'artifact-game-2', version: 3, candidateSha256: 'd'.repeat(64), status: 'candidate' },
    product: { ...projection().product, projectId: 'noobi-owl-book-sorter-v1' },
  }));
  assert.equal(gameWorkspaceBindingMatches({ binding }, changedCandidate), false);
});

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

test('工具任务只携带明确选择的项目与当前范围指纹', () => {
  const fingerprint = 'a'.repeat(64);
  assert.deepEqual(normalizeNativeTaskDraft({ functionId: 'utility', title: '工具', statement: '做一个空白工具',
    projectId: 'tool-empty-123456789abc', projectScopeFingerprint: fingerprint, projectName: '忽略前端名称', projectMode: 'new' }), {
    title: '工具', statement: '做一个空白工具', successCriteria: [], boundaries: [], functionId: 'utility',
    projectId: 'tool-empty-123456789abc', projectScopeFingerprint: fingerprint,
  });
  assert.equal(Object.hasOwn(normalizeNativeTaskDraft({ functionId: 'utility', projectId: 'tool-empty-123456789abc' }), 'projectId'), false);
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
    execution: { id: 'run-ade27', phase: 'executing', stopReason: null, goalVersionId: 'goal-native-1' },
    native: { bindingCurrent: true, aiEnabled: false, actions: { phase: 'complete', canCancel: true, canPause: true },
      sessions: Array.from({ length: 5 }, (_, index) => ({ eventId: `event-${index}`, status: 'completed' })) },
  }));
  assert.equal(nativeComplete.native.actions.phase, 'complete');
  assert.equal(nativeComplete.native.actions.canCancel, true);
  assert.equal(nativeComplete.native.sessions.length, 5);
  assert.equal(nativeComplete.links.createTask, '/api/product/tasks');
  assert.equal(canCreateNativeTask(nativeComplete), true);
});

test('旧执行阶段不能压过权威任务终态，但实际预留或运行中的调用仍锁住切换', () => {
  const raw = (taskLifecycle, modelCallStatus) => ({
    task: { id: 'task-terminal', title: '已完成任务', statement: '保留原成果', goalVersionId: 'goal-terminal', successCriteria: [], boundaries: [] },
    status: 'ready_to_run', execution: { id: 'run-old', phase: 'executing', modelCalls: modelCallStatus ? [{ status: modelCallStatus }] : [] },
    taskLifecycle, setup: { projects: [], selectedScope: null }, links: { createTask: null },
  });
  const terminal = normalizeNativeProductState(raw({ status: 'ready_to_export', inFlight: false }));
  assert.equal(terminal.execution.phase, 'executing');
  assert.equal(terminal.execution.bindingCurrent, false, 'a legacy execution without a current binding must not be promoted to current');
  assert.equal(terminal.taskLifecycle.status, 'ready_to_export');
  assert.equal(canCreateNativeTask(terminal), true);

  for (const status of ['reserved', 'running']) {
    const active = normalizeNativeProductState(raw({ status: 'ready_to_export', inFlight: true }, status));
    assert.equal(canCreateNativeTask(active), false, `${status} model calls must continue to block a task switch`);
  }
});

test('待选范围与待授权是正常设置态，并保留完整目标和登记项目', () => {
  const task = {
    id: 'task-setup-1', title: '原生设置', goalVersionId: 'goal-setup-1', statement: '接入登记项目',
    successCriteria: ['保留完整条件'], boundaries: ['设置阶段不执行'], functionId: 'game',
  };
  const project = {
    projectId: 'project-live-1', label: '已登记项目', scopeFingerprint: 'scope-live-1',
    allowedWritePaths: ['src/main.ts'], checkIds: ['typecheck'], current: true,
    allowedRoles: ['Lead', 'Senior Developer', 'Frontend Developer', 'Reviewer'], maxAgents: 4, maxModelCalls: 8,
  };
  const waiting = normalizeNativeProductState({ task, status: 'waiting_scope', execution: null, registry: null, setup: { projects: [project], selectedProject: null, selectedScope: null } });
  assert.equal(waiting.setupPending, true);
  assert.equal(waiting.setupStatus, 'waiting_scope');
  assert.equal(waiting.links.createTask, '/api/product/tasks');
  assert.equal(waiting.functionId, 'game');
  assert.equal(canCreateNativeTask(waiting), true);
  assert.equal(waiting.officeStatus, 'waiting_start');
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

  const failed = normalizeNativeProductState({
    task, status: 'ready_to_run', taskLifecycle: { status: 'failed', inFlight: false },
    execution: { id: 'run-current', phase: 'failed', bindingCurrent: true, deadline: '2026-10-12T01:20:00.000Z',
      modelCalls: [{ role: 'lead', status: 'failed' }], failureReason: '工作区路由连接超时，本轮已结束。' },
    registry: { status: 'registered', projectId: project.projectId, scopeFingerprint: project.scopeFingerprint },
    canPrepareRun: true,
    setup: { projects: [project], selectedProject: project, selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId, current: true } },
  });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.setupStatus, 'ready_to_run');
  assert.equal(failed.officeStatus, 'failed');
  assert.equal(failed.execution.modelCalls.length, 1);
  assert.equal(failed.execution.deadline, '2026-10-12T01:20:00.000Z');
  assert.match(failed.nextStep, /本轮已停止/);
  assert.match(failed.nextStep, /1 次调用失败/);
  assert.match(failed.nextStep, /原截止 2026-10-12T01:20:00\.000Z 保留/);
  assert.match(failed.nextStep, /不会自动重试/);
  assert.doesNotMatch(failed.nextStep, /Lead|没有生成计划/);
  assert.equal(failed.canPrepareRun, true);

  const staleFailure = normalizeNativeProductState({
    task, status: 'ready_to_run', taskLifecycle: { status: 'failed', inFlight: false },
    execution: { id: 'run-old-goal', phase: 'failed', bindingCurrent: false, modelCalls: [{ status: 'failed' }], failureReason: '旧目标失败' },
    canPrepareRun: true,
    setup: { projects: [project], selectedProject: project, selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId, current: true } },
  });
  assert.equal(staleFailure.status, 'ready_to_run');
  assert.notEqual(staleFailure.officeStatus, 'failed');
  assert.equal(staleFailure.execution, null);

  const unsettledFailure = normalizeNativeProductState({
    task, status: 'ready_to_run', taskLifecycle: { status: 'failed', inFlight: true },
    execution: { id: 'run-pending', phase: 'failed', bindingCurrent: true, modelCalls: [{ status: 'reserved' }] },
    setup: { projects: [project], selectedProject: project, selectedScope: { projectId: project.projectId, scopeFingerprint: project.scopeFingerprint, goalVersionId: task.goalVersionId, current: true } },
  });
  assert.equal(unsettledFailure.statusLabel, '失败状态待核实');
  assert.match(unsettledFailure.nextStep, /尚待核实/);
  assert.doesNotMatch(unsettledFailure.nextStep, /执行失败并已结束/);
  assert.equal(unsettledFailure.officeStatus, 'partial');

  const runningWithoutBinding = normalizeNativeProductState({
    task, status: 'ready_to_run', taskLifecycle: { status: 'executing', inFlight: true }, execution: null,
    setup: { projects: [], selectedProject: null, selectedScope: null },
  });
  assert.equal(runningWithoutBinding.execution, null);
  assert.equal(runningWithoutBinding.taskLifecycle.inFlight, true);

  const unavailable = normalizeNativeProductState({
    task, status: 'runtime_unavailable',
    execution: { id: 'execution-setup-1', phase: 'planned', bindingCurrent: true },
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
  assert.throws(() => nativeActionPayload(unavailable, 'prepare_run', {
    mode: 'reuse_current_result', expectedScopeFingerprint: project.scopeFingerprint,
    expectedExecutionId: 'execution-setup-1', expectedRegistrySha256: 'registry-setup-1',
    expectedArtifactId: 'artifact-setup-1', expectedArtifactVersion: 1,
  }), /可安全复用/);
  assert.deepEqual(nativeActionPayload(unavailable, 'instructions', { text: '输入变化', requestId: 'instruction-request-1' }), {
    text: '输入变化', action: 'instructions', expectedGoalVersionId: task.goalVersionId, requestId: 'instruction-request-1',
    expectedTaskId: task.id, expectedProjectId: project.projectId, expectedScopeFingerprint: project.scopeFingerprint,
    expectedExecutionId: 'execution-setup-1', expectedRegistrySha256: 'registry-setup-1',
    expectedArtifactId: null, expectedArtifactVersion: null, expectedCandidateSha256: null, expectedDiffSha256: null,
  });
});

test('只从当前任务、当前范围和无在途工作的只读绑定恢复已确认成果', () => {
  const scopeFingerprint = 'a'.repeat(64);
  const registrySha256 = 'b'.repeat(64);
  const candidateSha256 = 'c'.repeat(64);
  const task = { id: 'task-recovery-1', title: '已确认任务', goalVersionId: 'goal-recovery-1', statement: '沿用已确认结果', successCriteria: [], boundaries: [] };
  const project = { projectId: 'project-recovery-1', label: '登记项目', location: '/workspace/project-recovery-1', scopeFingerprint, allowedWritePaths: ['src/'], checkIds: ['syntax'], current: true };
  const reuseInput = {
    mode: 'reuse_current_result', expectedGoalVersionId: task.goalVersionId, expectedScopeFingerprint: scopeFingerprint,
    expectedExecutionId: 'run-recovery-1', expectedRegistrySha256: registrySha256,
    expectedArtifactId: 'artifact-recovery-1', expectedArtifactVersion: 4, expectedCandidateSha256: candidateSha256,
  };
  const raw = {
    task, status: 'ready_to_run', execution: { id: 'run-recovery-1', phase: 'failed', bindingCurrent: true, modelCalls: [] },
    registry: { projectId: project.projectId, scopeFingerprint, registrySha256 }, canPrepareRun: true,
    taskLifecycle: { status: 'ready_to_export', inFlight: false },
    setup: { projects: [project], selectedProject: project, selectedScope: { projectId: project.projectId, scopeFingerprint, goalVersionId: task.goalVersionId, current: true } },
    currentResultRecovery: { taskId: task.id, title: task.title, goalVersionId: task.goalVersionId, projectId: project.projectId,
      scopeFingerprint, canReuseCurrentResult: true, reuseInput },
  };
  const value = normalizeNativeProductState(raw);
  assert.deepEqual(value.currentResultRecovery.reuseInput, reuseInput);
  assert.equal(value.setup.projects[0].location, project.location);
  assert.equal(value.statusLabel, '已确认成果待恢复');
  assert.match(value.nextStep, /不会重新开发或调用模型/);
  assert.deepEqual(nativeActionPayload(value, 'prepare_run', { mode: 'reuse_current_result' }), {
    action: 'prepare_run', ...reuseInput,
  });
  assert.throws(() => nativeActionPayload(value, 'prepare_run', {
    mode: 'reuse_current_result', expectedArtifactId: 'forged-artifact',
  }), /可安全复用/);
  assert.equal(normalizeNativeProductState({ ...raw, taskLifecycle: { status: 'running', inFlight: true } }).currentResultRecovery, null);
  assert.equal(normalizeNativeProductState({ ...raw, currentResultRecovery: { ...raw.currentResultRecovery, taskId: 'another-task' } }).currentResultRecovery, null);
  assert.equal(normalizeNativeProductState({ ...raw, currentResultRecovery: { ...raw.currentResultRecovery,
    reuseInput: { ...reuseInput, expectedGoalVersionId: 'old-goal' } } }).currentResultRecovery, null);
  assert.equal(normalizeNativeProductState({ ...raw, currentResultRecovery: { ...raw.currentResultRecovery,
    reuseInput: { ...reuseInput, expectedExecutionId: 'stale-execution' } } }).currentResultRecovery, null);
  assert.equal(normalizeNativeProductState({ ...raw, registry: { ...raw.registry, registrySha256: 'd'.repeat(64) } }).currentResultRecovery, null);
});

test('prepared execution without a persisted Lead plan is waiting to start, not plan-ready', () => {
  const waiting = normalizeNativeProductState(projection({
    status: 'waiting_user', execution: { id: 'run-planned', phase: 'planned', stopReason: null }, artifact: null,
    native: { bindingCurrent: true, registrySha256: 'registry-1', actions: {} },
  }));
  assert.equal(waiting.officeStatus, 'waiting_start');
  const ready = normalizeNativeProductState(projection({
    status: 'waiting_user', execution: { id: 'run-planned', phase: 'planned', stopReason: null }, artifact: null,
    native: { bindingCurrent: true, registrySha256: 'registry-1', plan: { text: 'Lead plan', sha256: PLAN_SHA256 }, actions: {} },
  }));
  assert.equal(ready.officeStatus, 'ready');
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
      plan: { text: '先核对范围，再修改并检查。', sha256: PLAN_SHA256, instructionSnapshotSha256: INSTRUCTION_SNAPSHOT_SHA256, instructionCount: 0 },
      sessions: [],
      actions: { canRun: true, canApprovePlan: true, canResume: false, stopClass: null },
    },
  }));
  assert.deepEqual(value.team.map((agent) => agent.id), ['product-lead', 'product-senior-developer', 'product-reviewer']);
  assert.equal(value.native.runAgentId, 'product-lead');
  assert.deepEqual(value.native.plan, { text: '先核对范围，再修改并检查。', sha256: PLAN_SHA256, instructionSnapshotSha256: INSTRUCTION_SNAPSHOT_SHA256, instructionCount: 0, instructionIds: [] });
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
    expectedInstructionSnapshotSha256: INSTRUCTION_SNAPSHOT_SHA256,
  });
  assert.deepEqual(nativeActionPayload(value, 'approve_plan', { expectedPlanSha256: 'spoofed-plan' }), {
    action: 'approve_plan', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
    expectedPlanSha256: PLAN_SHA256,
    expectedInstructionSnapshotSha256: INSTRUCTION_SNAPSHOT_SHA256,
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
  assert.equal(missingAiFlag.officeStatus, 'waiting_start');

  const missingPlan = normalizeNativeProductState(projection({
    actor: null,
    execution: { id: 'execution-1', phase: 'planned' },
    native: { bindingCurrent: true, registrySha256: 'registry-1', source: 'openoffice-native', actions: { canApprovePlan: true } },
  }));
  assert.equal(missingPlan.native.actions.canApprovePlan, false);
  assert.equal(missingPlan.officeStatus, 'waiting_start');
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
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [{ agentId: 'native-reviewer', role: 'reviewer', status: 'running' }] },
  }));
  const officeTask = nativeProductAsOfficeTask(executingGame);
  assert.equal(officeTask.activeRole, null);
  assert.equal(nativeCoworkerPresence(executingGame, officeTask, 'reviewer').active, false);
  assert.equal(nativeCoworkerPresence(executingGame, officeTask, 'writer').active, true);
});

test('办公室只把当前绑定下的真实活动调用显示为推进中', () => {
  const live = normalizeNativeProductState(projection({
    functionId: 'utility', status: 'waiting_user', execution: { id: 'execution-1', phase: 'execute', deadline: '2099-01-01T00:00:00Z' },
    team: { source: 'openoffice-native', agents: [{ id: 'lead-1', name: 'Lead', role: 'Lead', stationRole: 'coordinator', status: 'completed' }] },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', agents: [{ id: 'lead-1', role: 'Lead' }], sessions: [{ eventId: 'call-1', role: 'developer', status: 'running' }], actions: { canApprovePlan: false } },
  }));
  const liveOffice = nativeProductAsOfficeTask(live);
  assert.equal(live.officeStatus, 'running');
  assert.equal(liveOffice.status, 'running');
  assert.equal(liveOffice.team.agents[0].status, 'completed');
  assert.equal(nativeCoworkerPresence(live, liveOffice, 'writer').active, true);

  const stalePhase = normalizeNativeProductState(projection({
    functionId: 'utility', status: 'waiting_user', execution: { id: 'execution-1', phase: 'execute' },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [] },
  }));
  assert.equal(stalePhase.officeStatus, 'waiting_user');

  const missingCall = normalizeNativeProductState(projection({
    functionId: 'utility', status: 'running', execution: { id: 'execution-1', phase: 'execute' },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [] },
  }));
  assert.equal(missingCall.officeStatus, 'partial');
  assert.equal(nativeCoworkerPresence(missingCall, nativeProductAsOfficeTask(missingCall), 'writer').active, false);

  const expired = normalizeNativeProductState(projection({
    functionId: 'utility', status: 'running', execution: { id: 'execution-1', phase: 'execute', deadline: '2000-01-01T00:00:00Z' },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [{ status: 'running' }] },
  }));
  assert.equal(expired.officeStatus, 'partial');

  const failed = normalizeNativeProductState(projection({
    functionId: 'utility', status: 'failed', execution: { id: 'execution-1', phase: 'execute' },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [{ status: 'running' }] },
  }));
  assert.equal(failed.officeStatus, 'failed');

  const approval = normalizeNativeProductState(projection({
    functionId: 'utility', status: 'running', execution: { id: 'execution-1', phase: 'execute' },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', plan: { text: '待审批计划', sha256: PLAN_SHA256, instructionSnapshotSha256: INSTRUCTION_SNAPSHOT_SHA256, instructionCount: 0 }, sessions: [{ status: 'running' }], actions: { canApprovePlan: true } },
  }));
  assert.equal(approval.officeStatus, 'waiting_user');
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

test('UNVERIFIED 本身不代表已停止；仅服务端明确的结算失败绑定显示停止', () => {
  const unverified = normalizeNativeProductState(projection({
    status: 'waiting_user', taskLifecycle: { status: 'idle', inFlight: false },
    execution: { id: 'execution-1', phase: 'partial', stopReason: 'native_process_failed', deadline: '2026-10-22T14:31:02.757Z' },
    artifact: { id: 'artifact-1', version: 1, candidateSha256: 'a'.repeat(64), hostCheck: { passed: true },
      review: { id: 'review-attempt-1', passed: false, nativeVerdict: 'UNVERIFIED', scopeOutcome: 'unverified' } },
    nextStep: '宿主固定检查已通过，但当前候选尚无有效的同版独立审阅结果；等待审阅完成后再查看成果，不要确认或交付。',
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [],
      reviewRound: null, actions: { canReview: false, canOpenReviewRound: false } },
  }));
  assert.match(unverified.nextStep, /等待审阅完成/u);
  assert.equal(unverified.native.actions.canOpenReviewRound, false);
  const waiting = nativeOfficeWaitingPresentation(unverified, { id: unverified.taskId, status: 'waiting_user', goal: { activeVersionId: unverified.goalVersionId } });
  assert.equal(waiting.office.kicker, 'REVIEW UNVERIFIED');

  const stopped = normalizeNativeProductState(projection({
    status: 'waiting_user',
    artifact: { id: 'artifact-1', version: 1, candidateSha256: 'a'.repeat(64), hostCheck: { passed: true },
      review: { id: 'review-attempt-1', passed: false, nativeVerdict: 'UNVERIFIED', scopeOutcome: 'unverified' } },
    nextStep: '本轮 Reviewer 调用已失败；不会自动重试，后续复审需要明确授权。',
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1', sessions: [],
      autoReviewContinuation: { taskId: 'task-native-1', goalVersionId: 'goal-native-1', executionId: 'execution-1',
        registrySha256: 'registry-1', scopeFingerprint: 'scope-1', artifactId: 'artifact-1', artifactVersion: 1,
        candidateSha256: 'a'.repeat(64), authorized: true, status: 'blocked_or_failed' },
      reviewRound: null, actions: { canReview: false, canOpenReviewRound: false } },
  }));
  const stoppedPresentation = nativeOfficeWaitingPresentation(stopped, { id: stopped.taskId, status: 'waiting_user', goal: { activeVersionId: stopped.goalVersionId } });
  assert.equal(stoppedPresentation.office.kicker, 'REVIEW STOPPED');
});

test('失败候选的后续审阅轮显式开启、8次额度绑定同一候选与上一份审阅', () => {
  const candidateSha256 = 'a'.repeat(64);
  const previousReviewId = 'review-failed-1';
  const value = normalizeNativeProductState(projection({
    status: 'partial', execution: { id: 'execution-1', phase: 'partial', stopReason: 'execution_expired' },
    artifact: { id: 'artifact-1', version: 39, candidateSha256, diffSha256: 'd'.repeat(64), status: 'candidate',
      review: { id: previousReviewId, passed: false, nativeVerdict: 'FAIL' } },
    product: { ...projection().product, workspaceScopeFingerprint: 'f'.repeat(64) },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      reviewRound: { id: 'review-round-1', status: 'open', callUnit: 'CLI 调用', expectedReviewId: previousReviewId, candidateSha256,
        diffSha256: 'd'.repeat(64), scopeFingerprint: 'f'.repeat(64), remainingCalls: 8, maxModelCalls: 8, modelCalls: 0,
        deadlineAt: '2026-10-17T12:20:00.000Z' },
      actions: { canReview: true, canReviewSameRun: false, canOpenReviewRound: false, canCancel: true } },
  }));
  assert.equal(value.native.reviewRound.id, 'review-round-1');
  assert.equal(value.native.reviewRound.maxModelCalls, 8);
  assert.equal(canReviewNativeCandidate(value), true);
  assert.deepEqual(nativeActionPayload(value, 'review'), {
    action: 'review', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
    expectedArtifactId: 'artifact-1', expectedArtifactVersion: 39, expectedCandidateSha256: candidateSha256,
    expectedReviewId: previousReviewId, expectedReviewRoundId: 'review-round-1', expectedTaskId: 'task-native-1',
      expectedPreviousReviewRoundId: null,
    expectedDiffSha256: 'd'.repeat(64), expectedScopeFingerprint: 'f'.repeat(64),
  });
  assert.deepEqual(nativeActionPayload(value, 'cancel', { requestId: 'cancel-round-1' }), {
    requestId: 'cancel-round-1', action: 'cancel', expectedGoalVersionId: 'goal-native-1',
    expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
    expectedReviewRoundId: 'review-round-1', expectedPreviousReviewRoundId: null,
    expectedTaskId: 'task-native-1', expectedArtifactId: 'artifact-1', expectedArtifactVersion: 39,
    expectedCandidateSha256: candidateSha256, expectedDiffSha256: 'd'.repeat(64),
    expectedReviewId: previousReviewId, expectedScopeFingerprint: 'f'.repeat(64),
  });
  const canOpen = normalizeNativeProductState(projection({
    execution: { id: 'execution-1', phase: 'partial', stopReason: 'execution_expired' },
    artifact: { id: 'artifact-1', version: 39, candidateSha256, diffSha256: 'd'.repeat(64), status: 'candidate',
      review: { id: previousReviewId, passed: false, nativeVerdict: 'FAIL' } },
    product: { ...projection().product, workspaceScopeFingerprint: 'f'.repeat(64) },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      reviewRoundOffer: { maxModelCalls: 8, maxDurationMs: 1200000 },
      actions: { canReview: false, canOpenReviewRound: true } },
  }));
  assert.deepEqual(nativeActionPayload(canOpen, 'open_review_round', { requestId: 'round-request-1' }), {
    requestId: 'round-request-1', action: 'open_review_round', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
    expectedArtifactId: 'artifact-1', expectedArtifactVersion: 39, expectedCandidateSha256: candidateSha256,
    expectedReviewId: previousReviewId, expectedDiffSha256: 'd'.repeat(64), expectedTaskId: 'task-native-1', expectedScopeFingerprint: 'f'.repeat(64),
    expectedPreviousReviewRoundId: null,
  });
  const legacyOpen = normalizeNativeProductState(projection({
    execution: { id: 'execution-1', phase: 'partial', stopReason: 'execution_expired' },
    artifact: { id: 'artifact-1', version: 39, candidateSha256, diffSha256: 'd'.repeat(64), status: 'candidate',
      review: { id: previousReviewId, passed: false, nativeVerdict: 'FAIL' } },
    product: { ...projection().product, workspaceScopeFingerprint: 'f'.repeat(64) },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      actions: { canReview: false, canOpenReviewRound: true } },
  }));
  assert.deepEqual(nativeActionPayload(legacyOpen, 'open_review_round', { requestId: 'legacy-request-1' }), {
    requestId: 'legacy-request-1', action: 'open_review_round', expectedGoalVersionId: 'goal-native-1',
    expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1', expectedArtifactId: 'artifact-1',
    expectedArtifactVersion: 39, expectedCandidateSha256: candidateSha256, expectedReviewId: previousReviewId,
  });
  const canReconnect = normalizeNativeProductState(projection({
    execution: { id: 'execution-1', phase: 'partial', stopReason: 'execution_deadline_elapsed' },
    artifact: { id: 'artifact-1', version: 39, candidateSha256, status: 'candidate',
      review: { id: previousReviewId, passed: false, nativeVerdict: 'FAIL' } },
    product: { ...projection().product, workspaceScopeFingerprint: 'd'.repeat(64) },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      actions: { canReview: false, canReconnectReview: true } },
  }));
  assert.deepEqual(nativeActionPayload(canReconnect, 'reconnect_review_runtime'), {
    action: 'reconnect_review_runtime', expectedGoalVersionId: 'goal-native-1',
    expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
    expectedArtifactId: 'artifact-1', expectedArtifactVersion: 39,
    expectedCandidateSha256: candidateSha256, expectedReviewId: previousReviewId,
    expectedScopeFingerprint: 'd'.repeat(64),
  });
  assert.deepEqual(nativeActionPayload(canReconnect, 'cancel'), {
    action: 'cancel', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1', expectedRegistrySha256: 'registry-1',
  });
  assert.throws(() => nativeActionPayload({ ...canReconnect, native: { ...canReconnect.native, actions: { canReconnectReview: false } } }, 'reconnect_review_runtime'), /未开放/);
  assert.throws(() => nativeActionPayload({ ...canOpen, native: { ...canOpen.native, actions: { canOpenReviewRound: false } } }, 'open_review_round'), /未开放/);
});

test('未审阅的当前候选允许以 null Review ID 接回并开启审阅轮，预检失败显示为零调用', () => {
  const candidateSha256 = 'a'.repeat(64);
  const value = normalizeNativeProductState(projection({
    status: 'partial', execution: { id: 'execution-1', phase: 'partial', stopReason: 'execution_deadline_elapsed' },
    artifact: { id: 'artifact-1', version: 41, candidateSha256, diffSha256: 'd'.repeat(64), status: 'candidate', review: null },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      reviewRoundOffer: { maxModelCalls: 8, maxDurationMs: 1200000 },
      preparationFailures: [{ eventId: 'event-preflight', sourceTaskId: 'review-task', attemptId: 'attempt-1',
        taskId: 'task-native-1', goalVersionId: 'goal-native-1', executionId: 'execution-1',
        workspaceScopeFingerprint: 'd'.repeat(64), registrySha256: 'registry-1',
        agentId: 'agent-reviewer', actor: 'reviewer', phase: 'review', reviewDispatchEventId: 'dispatch-1',
        artifactId: 'artifact-1', artifactVersion: 41, candidateSha256, modelCallCreated: false,
        status: 'failed', error: '输入超过保守预算；没有提交模型。' },
        { attemptId: 'spoof', candidateSha256, modelCallCreated: true, status: 'failed', error: 'ignored' }],
    actions: { canReview: false, canOpenReviewRound: true, canReconnectReview: true } },
    product: { ...projection().product, workspaceScopeFingerprint: 'd'.repeat(64) },
  }));
  assert.equal(value.artifact.review, null);
  assert.equal(value.native.preparationFailures.length, 1);
  assert.equal(value.native.preparationFailures[0].modelCallCreated, false);
  assert.deepEqual(nativeActionPayload(value, 'open_review_round', { requestId: 'round-request-2' }), {
    requestId: 'round-request-2', action: 'open_review_round', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1',
    expectedRegistrySha256: 'registry-1', expectedArtifactId: 'artifact-1', expectedArtifactVersion: 41,
    expectedCandidateSha256: candidateSha256, expectedReviewId: null, expectedDiffSha256: 'd'.repeat(64),
    expectedTaskId: 'task-native-1', expectedScopeFingerprint: 'd'.repeat(64), expectedPreviousReviewRoundId: null,
  });
  assert.deepEqual(nativeActionPayload(value, 'reconnect_review_runtime'), {
    action: 'reconnect_review_runtime', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1',
    expectedRegistrySha256: 'registry-1', expectedArtifactId: 'artifact-1', expectedArtifactVersion: 41,
    expectedCandidateSha256: candidateSha256, expectedReviewId: null, expectedScopeFingerprint: 'd'.repeat(64),
  });
});

test('当前执行的非Reviewer预留前失败不要求候选SHA，并排除身份不匹配记录', () => {
  const failure = { eventId: 'event-preflight', sourceTaskId: 'worker-task', attemptId: 'attempt-1',
    taskId: 'task-native-1', goalVersionId: 'goal-native-1', executionId: 'execution-1',
    workspaceScopeFingerprint: 'scope-1', registrySha256: 'registry-1', agentId: 'agent-developer',
    actor: 'developer', phase: 'developer', candidateSha256: null, modelCallCreated: false,
    status: 'failed', error: '工作区准备失败。', createdAt: '2026-10-19T12:00:01.000Z' };
  const value = normalizeNativeProductState(projection({
    status: 'in_progress', taskLifecycle: { status: 'running', inFlight: false },
    execution: { id: 'execution-1', phase: 'executing', deadline: '2026-10-19T12:20:00.000Z', modelCalls: [
      { status: 'completed' }, { status: 'completed' },
    ] },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-1',
      phase: 'executing', sessions: [{ status: 'completed', createdAt: '2026-10-19T11:59:00.000Z' }],
      preparationFailures: [failure, { ...failure, eventId: 'stale', goalVersionId: 'old-goal' }], actions: {} },
  }));
  assert.equal(value.native.preparationFailures.length, 1);
  assert.equal(value.native.preparationFailures[0].candidateSha256, null);
  assert.match(value.nextStep, /未创建模型调用/);
});

test('ZIP 链接只在当前审阅通过并确认后规范化为同源路径', () => {
  const confirmedTool = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1', review: { id: 'review-1', passed: true }, confirmation: { approvalId: 'approval-1', artifactVersion: 2, goalVersionId: 'goal-native-1' } },
    links: { zip: '/api/irixi-authority/zip?artifactId=artifact-1&approvalId=approval-1' },
  }));
  assert.equal(confirmedTool.links.zip, '/api/irixi-authority/zip?artifactId=artifact-1&approvalId=approval-1');

  const unconfirmedTool = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1', review: { id: 'review-1', passed: true } },
    links: { zip: '/api/irixi-authority/zip?artifactId=artifact-1' },
  }));
  assert.equal(unconfirmedTool.links.zip, null);

  const external = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'candidate-1', review: { id: 'review-1', passed: true }, confirmation: { approvalId: 'approval-1', artifactVersion: 2, goalVersionId: 'goal-native-1' } },
    links: { zip: 'https://example.test/package.zip' },
  }));
  assert.equal(external.links.zip, null);
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
    files: [{ path: 'a', sha256: 'file-1', bytes: 12 }], checks: [{ id: 'check-1', passed: true }],
    review: { id: 'review-1', passed: true, nativeVerdict: 'PASS', scopeOutcome: 'clean', fullOutputSha256: 'a'.repeat(64), text: 'VERDICT: PASS\nReviewed.' }, confirmation: null,
  }, product);
  assert.equal(candidate.files[0].path, 'a');
  assert.equal(candidate.checks[0].passed, true);
  assert.equal(candidate.review.scopeOutcome, 'clean');
  assert.throws(() => normalizeNativeCandidate({ ...candidate, artifactVersion: 3 }, product), /不属于当前任务、目标或版本/);
});

test('同一未确认原生候选仅在后台开放且绑定当前审阅记录时可重新审阅', () => {
  const candidateSha256 = 'a'.repeat(64);
  const product = normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256, review: { id: 'review-old', passed: false } },
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true,
      reviewRound: { id: 'round-1', status: 'open', candidateSha256, maxModelCalls: 1, modelCalls: 0, remainingCalls: 1 },
      actions: { canReview: true } },
  }));
  assert.equal(canReviewNativeCandidate(product), true);
  assert.deepEqual(nativeActionPayload(product, 'review', {
    expectedArtifactId: 'spoofed-artifact', expectedArtifactVersion: 99,
    expectedCandidateSha256: '0'.repeat(64), expectedReviewId: 'spoofed-review',
    reviewEvidence: '核对 mastered 门槛。',
  }), {
    action: 'review', expectedGoalVersionId: 'goal-native-1', expectedExecutionId: 'execution-1',
    expectedRegistrySha256: 'registry-1', expectedArtifactId: 'artifact-1', expectedArtifactVersion: 2,
    expectedCandidateSha256: candidateSha256, expectedReviewId: 'review-old',
    reviewEvidence: '核对 mastered 门槛。', expectedReviewRoundId: 'round-1',
  });
  assert.equal(canReviewNativeCandidate(normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256, confirmation: { approvalId: 'approval-1' } },
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true, actions: { canReview: true } },
  }))), false);
  assert.equal(canReviewNativeCandidate(normalizeNativeProductState(projection({
    current: false,
    artifact: { id: 'artifact-1', version: 2, candidateSha256 },
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true, actions: { canReview: true } },
  }))), false);
  assert.equal(canReviewNativeCandidate(normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256: 'short' },
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true, actions: { canReview: true } },
  }))), false);
  assert.equal(canReviewNativeCandidate(product), true);
  assert.equal(canReviewNativeCandidate(normalizeNativeProductState(projection({
    artifact: { id: 'artifact-1', version: 2, candidateSha256 },
    native: { bindingCurrent: true, registrySha256: 'registry-1', aiEnabled: true, actions: { canReview: false } },
  }))), false);
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
  assert.deepEqual(nativeActionPayload(draft, 'instructions', { text: '补充验收要求', requestId: 'instruction-request-2' }), {
    text: '补充验收要求', action: 'instructions', expectedGoalVersionId: 'goal-native-1', requestId: 'instruction-request-2',
    expectedTaskId: 'task-native-1', expectedProjectId: null, expectedScopeFingerprint: null,
    expectedExecutionId: null, expectedRegistrySha256: null, expectedArtifactId: null, expectedArtifactVersion: null,
    expectedCandidateSha256: null, expectedDiffSha256: null,
  });
  assert.throws(() => nativeActionPayload(draft, 'run'), /执行绑定不完整/);
});

test('旧范围已失效时只给设置输入附带独立旧绑定，不恢复旧执行资格', () => {
  const registrySha256 = 'd'.repeat(64);
  const draft = normalizeNativeProductState(projection({
    status: 'waiting_scope', current: false, authorityCurrent: true, execution: null, product: null,
    registry: { registrySha256 },
    inputMutationBinding: { goalVersionId: 'goal-native-1', executionId: 'run-expired', registrySha256 },
    native: { bindingCurrent: false, sessions: [], actions: { canInstructions: true } },
  }));
  assert.equal(draft.current, false);
  assert.equal(draft.execution, null);
  assert.equal(draft.canRun, undefined);
  assert.deepEqual(nativeActionPayload(draft, 'instructions', {
    text: '补充当前要求', requestId: 'instruction-request-3', expectedExecutionId: 'forged', expectedRegistrySha256: 'e'.repeat(64),
  }), {
    text: '补充当前要求', action: 'instructions', expectedGoalVersionId: 'goal-native-1', requestId: 'instruction-request-3',
    expectedTaskId: 'task-native-1', expectedProjectId: null, expectedScopeFingerprint: null,
    expectedExecutionId: 'run-expired', expectedRegistrySha256: registrySha256,
    expectedArtifactId: null, expectedArtifactVersion: null, expectedCandidateSha256: null, expectedDiffSha256: null,
  });
  assert.deepEqual(nativeActionPayload(draft, 'prepare_run'), {
    action: 'prepare_run', expectedGoalVersionId: 'goal-native-1',
  });
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

test('续改动作保留服务器提供的修订身份并绑定完整目标与范围', () => {
  const value = normalizeNativeProductState(projection({
    current: true,
    artifact: { id: 'artifact-returned', version: 4, candidateSha256: 'a'.repeat(64) },
    execution: { id: 'execution-returned', phase: 'partial' },
    product: { projectId: 'project-1', registrySha256: 'b'.repeat(64), bindingCurrent: true, workspaceScopeFingerprint: 'c'.repeat(64) },
    native: { bindingCurrent: true, registrySha256: 'b'.repeat(64), aiEnabled: true,
      actions: { canContinue: true, revisionId: 'revision-omo-test' } },
  }));
  assert.equal(value.native.actions.canContinue, true);
  assert.equal(value.native.actions.revisionId, 'revision-omo-test');
  assert.deepEqual(nativeActionPayload(value, 'continue', {
    revisionId: value.native.actions.revisionId,
    expectedExecutionId: value.execution.id,
    expectedRegistrySha256: value.product.registrySha256,
    expectedScopeFingerprint: value.product.workspaceScopeFingerprint,
    expectedArtifactId: value.artifact.id,
    expectedArtifactVersion: value.artifact.version,
    expectedCandidateSha256: value.artifact.candidateSha256,
  }), {
    action: 'continue', expectedGoalVersionId: 'goal-native-1', revisionId: 'revision-omo-test',
    expectedExecutionId: 'execution-returned', expectedRegistrySha256: 'b'.repeat(64),
    expectedScopeFingerprint: 'c'.repeat(64), expectedArtifactId: 'artifact-returned',
    expectedArtifactVersion: 4, expectedCandidateSha256: 'a'.repeat(64),
  });
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
      { value: 'article-learning-12', dataset: { scopeFingerprint: fingerprint, scopeCurrent: 'true' } },
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
  scope.value = 'article-learning-12';
  const oldButton = button;
  const enabledMarkup = markup('可以选择', 'scope-v1', false);
  assert.equal(renderNativeMarkup(root, enabledMarkup, 'task/goal/catalog-v1', oldButton), true);
  assert.equal(html.includes('<button data-native-focus-key="scope-submit">'), true);
  assert.equal(scope.value, 'article-learning-12');
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

test('native task history filters by title and registered project without changing the list', () => {
  const tasks = [
    { id: 'task-a', title: '整理客户资料', projectId: 'utility-1' },
    { id: 'task-b', title: '复习学习记录', projectId: 'learning-1' },
    { id: 'task-c', title: '整理项目资料', projectId: 'utility-1' },
  ];
  assert.deepEqual(filterNativeTaskHistory(tasks, '项目'), [tasks[2]]);
  assert.deepEqual(filterNativeTaskHistory(tasks, '', 'utility-1'), [tasks[0], tasks[2]]);
  assert.deepEqual(filterNativeTaskHistory(tasks, '  整理 ', 'utility-1'), [tasks[0], tasks[2]]);
  assert.deepEqual(filterNativeTaskHistory(tasks, '无匹配'), []);
  assert.equal(tasks.length, 3);
});

test('same-bound redraw preserves review continuation opt-in, but a new binding clears it', () => {
  let checked = false;
  let html = '';
  const checkbox = { get checked() { return checked; }, set checked(value) { checked = value; } };
  const root = {
    dataset: {}, contains: () => false,
    querySelector: (selector) => selector === 'input[data-auto-review-continuation]' ? checkbox : null,
    querySelectorAll: () => [],
    get innerHTML() { return html; },
    set innerHTML(value) { html = value; checked = value.includes('checked'); },
  };
  assert.equal(renderNativeMarkup(root, '<input type="checkbox" data-auto-review-continuation>', 'task-1/goal-1/scope-1'), true);
  checked = true;
  assert.equal(renderNativeMarkup(root, '<p>status changed</p><input type="checkbox" data-auto-review-continuation>', 'task-1/goal-1/scope-1'), true);
  assert.equal(checked, true);
  assert.equal(renderNativeMarkup(root, '<input type="checkbox" data-auto-review-continuation>', 'task-2/goal-2/scope-2'), true);
  assert.equal(checked, false);
});

test('same task-list content preserves its DOM nodes while changed or externally modified content rerenders', () => {
  let html = '';
  let button = null;
  let writes = 0;
  const root = {
    dataset: {},
    get innerHTML() { return html; },
    set innerHTML(value) {
      writes += 1;
      html = `<normalized>${value}</normalized>`;
      button = {};
    },
  };
  const markup = '<button data-native-task-id="task-old">旧任务</button>';
  assert.equal(renderTaskListMarkup(root, markup), true);
  const originalButton = button;
  assert.equal(renderTaskListMarkup(root, markup), false);
  assert.equal(button, originalButton);
  assert.equal(writes, 1);

  const changed = '<button class="is-active" data-native-task-id="task-old">旧任务</button>';
  assert.equal(renderTaskListMarkup(root, changed), true);
  assert.notEqual(button, originalButton);
  assert.equal(writes, 2);

  html = '<externally changed DOM>';
  assert.equal(renderTaskListMarkup(root, changed), true);
  assert.equal(writes, 3);
});
