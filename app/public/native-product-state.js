const STATUS_MAP = {
  running: 'running',
  in_progress: 'running',
  waiting_user: 'waiting_user',
  ready_to_export: 'ready_to_export',
  partial: 'partial',
  blocked: 'partial',
  paused: 'partial',
  planned: 'ready',
  pending: 'ready',
  ready: 'ready',
  failed: 'failed',
  cancelled: 'cancelled',
  completed: 'completed',
};
const SHA256 = /^[a-f0-9]{64}$/;
const OFFICE_FUNCTION_IDS = new Set(['utility', 'game', 'agent']);
const OFFICE_FUNCTION_BY_STATION = {
  researcher: 'learning', writer: 'utility', reviewer: 'game', steward: 'agent',
  archivist: 'archive', coordinator: 'coordination',
};

export function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

export function filterNativeTaskHistory(tasks, query = '', projectId = '') {
  const needle = String(query || '').trim().toLocaleLowerCase();
  return (Array.isArray(tasks) ? tasks : []).filter((task) => {
    const titleMatches = !needle || String(task.title || '').toLocaleLowerCase().includes(needle);
    return titleMatches && (!projectId || task.projectId === projectId);
  });
}

export function renderTaskListMarkup(root, markup) {
  if (root.dataset.taskListInput === markup && root.innerHTML === root.dataset.taskListDOM) return false;
  root.innerHTML = markup;
  root.dataset.taskListInput = markup;
  root.dataset.taskListDOM = root.innerHTML;
  return true;
}

export function nativeReviewBinding(product) {
  const artifact = product?.artifact;
  const values = [product?.taskId, product?.goalVersionId, product?.execution?.id, product?.product?.registrySha256,
    artifact?.id, artifact?.version, artifact?.candidateSha256];
  if (product?.native?.reviewRound?.id) values.push(product.native.reviewRound.id);
  return values.every((value) => value !== null && value !== undefined && value !== '') ? JSON.stringify(values) : null;
}

export function canReviewNativeCandidate(product) {
  const artifact = product?.artifact;
  return Boolean(product?.current && product.native?.actions?.canReview === true
    && product.links?.actions && product.execution?.id && product.product?.registrySha256
    && artifact?.id && Number.isInteger(artifact.version) && SHA256.test(artifact.candidateSha256 || '')
    && !artifact.confirmation && nativeReviewBinding(product));
}

export function createBoundTextareaDraft(selector) {
  let draft = null;
  return {
    capture(root, binding, activeElement) {
      const field = root.querySelector(selector);
      if (!binding || !field || field.form?.dataset.reviseBinding !== binding) {
        if (draft?.binding !== binding) draft = null;
        return;
      }
      draft = {
        binding,
        value: field.value,
        focused: field === activeElement,
        start: field.selectionStart,
        end: field.selectionEnd,
        direction: field.selectionDirection,
      };
    },
    restore(root, binding) {
      if (!binding || draft?.binding !== binding) {
        draft = null;
        return;
      }
      const field = root.querySelector(selector);
      if (!field || field.form?.dataset.reviseBinding !== binding) return;
      field.value = draft.value;
      if (draft.focused) {
        field.focus({ preventScroll: true });
        field.setSelectionRange(draft.start, draft.end, draft.direction);
      }
    },
  };
}

function nativeFocusKey(element) {
  if (element?.dataset?.nativeFocusKey) return element.dataset.nativeFocusKey;
  if (element?.dataset?.action) return `action:${element.dataset.action}`;
  if (element?.dataset?.openDialog) return `dialog:${element.dataset.openDialog}`;
  if (element?.id) return `id:${element.id}`;
  const form = element?.form;
  const formRole = ['native-scope', 'native-authorize-scope', 'native-goal', 'native-revise']
    .find((role) => form?.hasAttribute(`data-${role}`));
  if (formRole && element.name) return `form:${formRole}:${element.tagName}:${element.name}`;
  if (formRole && element.type === 'submit') return `form:${formRole}:submit`;
  return element?.getAttribute?.('href') ? `href:${element.getAttribute('href')}` : null;
}

export function renderNativeMarkup(root, markup, binding, activeElement = null) {
  const previousBinding = root.dataset.nativeRenderBinding || null;
  if (root.dataset.nativeRenderInput === markup
    && root.innerHTML === root.dataset.nativeRenderDOM
    && previousBinding === binding) return false;

  const scopeSelect = root.querySelector('form[data-native-scope] select[name="projectId"]');
  const selectedScope = scopeSelect?.selectedOptions?.[0];
  const scopeProject = scopeSelect ? {
    value: scopeSelect.value,
    fingerprint: selectedScope?.dataset.scopeFingerprint || null,
  } : null;
  const focused = activeElement && root.contains(activeElement) ? activeElement : null;
  const focusKey = nativeFocusKey(focused);
  const value = focused && ['INPUT', 'SELECT', 'TEXTAREA'].includes(focused.tagName) ? focused.value : null;
  const selection = focused && Number.isInteger(focused.selectionStart) ? {
    start: focused.selectionStart,
    end: focused.selectionEnd,
    direction: focused.selectionDirection,
  } : null;
  const scopeFingerprint = focusKey === 'scope-project'
    ? focused.selectedOptions?.[0]?.dataset.scopeFingerprint || null
    : null;

  root.innerHTML = markup;
  root.dataset.nativeRenderBinding = binding || '';
  root.dataset.nativeRenderInput = markup;
  root.dataset.nativeRenderDOM = root.innerHTML;
  if (!binding || previousBinding !== binding) return true;

  const nextScope = root.querySelector('form[data-native-scope] select[name="projectId"]');
  if (scopeProject && nextScope) {
    const stillCurrent = [...nextScope.options].some((option) => option.value === scopeProject.value
      && option.dataset.scopeFingerprint === scopeProject.fingerprint
      && option.dataset.scopeCurrent === 'true');
    if (stillCurrent) nextScope.value = scopeProject.value;
  }
  if (!focusKey) return true;

  const target = [...root.querySelectorAll('button, a, input, select, textarea')]
    .find((element) => nativeFocusKey(element) === focusKey);
  if (!target) return true;
  if (focusKey === 'scope-project') {
    const stillCurrent = [...target.options].some((option) => option.value === value
      && option.dataset.scopeFingerprint === scopeFingerprint
      && option.dataset.scopeCurrent === 'true');
    if (!scopeFingerprint || !stillCurrent) return true;
    target.value = value;
  } else if (value !== null && 'value' in target) {
    if (target.tagName === 'SELECT' && ![...target.options].some((option) => option.value === value)) return true;
    target.value = value;
  }
  target.focus({ preventScroll: true });
  if (selection && typeof target.setSelectionRange === 'function') {
    target.setSelectionRange(selection.start, selection.end, selection.direction);
  }
  return true;
}

const ACTOR_ROLE = {
  developer: 'writer',
  writer: 'writer',
  researcher: 'researcher',
  reviewer: 'reviewer',
  steward: 'steward',
  archivist: 'archivist',
  coordinator: 'coordinator',
};

export function officeFunctionForStation(value) {
  return OFFICE_FUNCTION_BY_STATION[String(value || '').trim().toLowerCase()] || null;
}

export function officeFunctionForCoworker(detail) {
  return officeFunctionForStation(detail?.officeRole || detail?.stationRole || detail?.role);
}

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`OpenOffice 状态缺少 ${name}。`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeNativeTaskDraft(input = {}) {
  const draft = {
    title: typeof input.title === 'string' ? input.title.trim() : '',
    statement: typeof input.statement === 'string' ? input.statement.trim() : '',
    successCriteria: typeof input.successCriteria === 'string'
      ? input.successCriteria.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : Array.isArray(input.successCriteria) ? input.successCriteria.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
    boundaries: typeof input.boundaries === 'string'
      ? input.boundaries.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : Array.isArray(input.boundaries) ? input.boundaries.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
  };
  const functionId = typeof input.functionId === 'string' ? input.functionId.trim() : '';
  if (OFFICE_FUNCTION_IDS.has(functionId)) draft.functionId = functionId;
  const projectId = optionalString(input.projectId);
  const projectScopeFingerprint = optionalString(input.projectScopeFingerprint);
  if (projectId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(projectId)
    && projectScopeFingerprint && /^[a-f0-9]{64}$/.test(projectScopeFingerprint)) {
    draft.projectId = projectId;
    draft.projectScopeFingerprint = projectScopeFingerprint;
  }
  return draft;
}

function stationRoleFor(value) {
  const role = optionalString(value);
  return role ? ACTOR_ROLE[role.toLowerCase()] || null : null;
}

function normalizeSetupProject(item) {
  if (!item || typeof item !== 'object') return null;
  const projectId = optionalString(item.projectId || item.id);
  const scopeFingerprint = optionalString(item.scopeFingerprint);
  if (!projectId || !scopeFingerprint) return null;
  return {
    projectId,
    label: optionalString(item.label || item.name || item.title) || projectId,
    scopeFingerprint,
    allowedWritePaths: Array.isArray(item.allowedWritePaths) ? item.allowedWritePaths.filter((value) => typeof value === 'string') : [],
    checkIds: Array.isArray(item.checkIds) ? item.checkIds.filter((value) => typeof value === 'string') : [],
    ...(item.projectKind === 'utility' ? { projectKind: 'utility' } : {}),
    ...(optionalString(item.location) ? { location: optionalString(item.location) } : {}),
    current: item.current === true,
  };
}

function normalizeSetup(raw) {
  const projects = Array.isArray(raw?.projects) ? raw.projects.map(normalizeSetupProject).filter(Boolean) : [];
  return {
    projects,
    selectedProject: normalizeSetupProject(raw?.selectedProject),
    selectedScope: raw?.selectedScope && typeof raw.selectedScope === 'object' ? {
      projectId: optionalString(raw.selectedScope.projectId),
      scopeFingerprint: optionalString(raw.selectedScope.scopeFingerprint),
      goalVersionId: optionalString(raw.selectedScope.goalVersionId),
      selectedAt: optionalString(raw.selectedScope.selectedAt),
      current: raw.selectedScope.current === true,
    } : null,
  };
}

function normalizeCurrentResultRecovery(raw, { taskId, goalVersionId, scope, inFlight, executionId, registrySha256 }) {
  const input = raw?.reuseInput;
  if (!raw || raw.canReuseCurrentResult !== true || raw.taskId !== taskId || raw.goalVersionId !== goalVersionId
    || inFlight !== false || !scope?.current || raw.projectId !== scope.projectId
    || !SHA256.test(scope.scopeFingerprint || '') || raw.scopeFingerprint !== scope.scopeFingerprint || !input || input.mode !== 'reuse_current_result'
    || input.expectedGoalVersionId !== goalVersionId || input.expectedScopeFingerprint !== scope.scopeFingerprint
    || input.expectedExecutionId !== executionId || input.expectedRegistrySha256 !== registrySha256
    || !optionalString(input.expectedExecutionId) || !SHA256.test(input.expectedRegistrySha256 || '')
    || !optionalString(input.expectedArtifactId) || !Number.isInteger(input.expectedArtifactVersion)
    || input.expectedArtifactVersion < 1 || !SHA256.test(input.expectedCandidateSha256 || '')) return null;
  const allowedKeys = ['expectedArtifactId', 'expectedArtifactVersion', 'expectedCandidateSha256', 'expectedExecutionId',
    'expectedGoalVersionId', 'expectedRegistrySha256', 'expectedScopeFingerprint', 'mode'].sort();
  if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(allowedKeys)) return null;
  return {
    taskId, title: optionalString(raw.title), goalVersionId, projectId: scope.projectId,
    scopeFingerprint: scope.scopeFingerprint,
    artifactId: input.expectedArtifactId, artifactVersion: input.expectedArtifactVersion,
    candidateSha256: input.expectedCandidateSha256,
    reuseInput: { ...input },
  };
}

function normalizeTeam(raw) {
  const entries = Array.isArray(raw) ? raw : Array.isArray(raw?.agents) ? raw.agents : [];
  return entries.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const actor = optionalString(item.actor || item.roleKey || item.role);
    const stationRole = stationRoleFor(item.stationRole || actor);
    if (!stationRole) return [];
    const rawStatus = optionalString(item.status) || 'idle';
    return [{
      id: optionalString(item.id) || `native-agent-${index}`,
      actor,
      roleKey: stationRole,
      stationRole,
      name: optionalString(item.name) || actor || stationRole,
      status: ['running', 'in_progress', 'working'].includes(rawStatus) ? 'working' : rawStatus,
    }];
  });
}

function normalizeWorkItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item, index) => {
    if (!item || typeof item !== 'object') return [];
    const actor = optionalString(item.actor || item.role);
    const role = stationRoleFor(item.stationRole || actor);
    const agentId = optionalString(item.agentId);
    if (!role && !agentId) return [];
    const rawStatus = optionalString(item.status) || 'pending';
    const status = rawStatus === 'in_progress' ? 'running' : rawStatus === 'done' ? 'completed' : rawStatus;
    return [{
      id: optionalString(item.id) || `native-work-${index}`,
      agentId,
      actor,
      role,
      title: optionalString(item.title) || `${actor || role} · ${rawStatus}`,
      status,
    }];
  });
}

function normalizeConversations(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = optionalString(item.id);
    const actor = optionalString(item.actor);
    const status = optionalString(item.status) || 'saved';
    const text = optionalString(item.text);
    if (!id || !actor || (!text && !['failed', 'cancelled'].includes(status))) return [];
    return [{
      id,
      at: optionalString(item.at),
      actor,
      status,
      text,
      sourceTaskId: optionalString(item.sourceTaskId),
      agentId: optionalString(item.agentId),
      role: optionalString(item.role),
    }];
  });
}

function normalizeNative(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bindingCurrent = raw.bindingCurrent === true;
  const source = optionalString(raw.source);
  const agents = Array.isArray(raw.agents) ? raw.agents.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const id = optionalString(item.id);
    if (!id) return [];
    return [{ id, name: optionalString(item.name), role: optionalString(item.role), backend: optionalString(item.backend), model: optionalString(item.model), isTeamLead: item.isTeamLead === true }];
  }) : [];
  const sessions = Array.isArray(raw.sessions) ? raw.sessions.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    return [{
      eventId: optionalString(item.eventId), sourceTaskId: optionalString(item.sourceTaskId), attemptId: optionalString(item.attemptId),
      agentId: optionalString(item.agentId), role: optionalString(item.role), phase: optionalString(item.phase),
      callOrdinal: Number.isInteger(item.callOrdinal) ? item.callOrdinal : null,
      modelCallId: optionalString(item.modelCallId), reviewRoundId: optionalString(item.reviewRoundId),
      status: optionalString(item.status) || 'unknown', createdAt: optionalString(item.createdAt),
    }];
  }) : [];
  const preparationFailures = Array.isArray(raw.preparationFailures) ? raw.preparationFailures.flatMap((item) => {
    if (!item || typeof item !== 'object' || item.modelCallCreated !== false || item.status !== 'failed'
      || !SHA256.test(item.candidateSha256 || '') || !optionalString(item.attemptId) || !optionalString(item.error)) return [];
    return [{ eventId: optionalString(item.eventId), sourceTaskId: optionalString(item.sourceTaskId),
      attemptId: item.attemptId, agentId: optionalString(item.agentId), actor: optionalString(item.actor),
      phase: optionalString(item.phase), reviewDispatchEventId: optionalString(item.reviewDispatchEventId),
      artifactId: optionalString(item.artifactId), artifactVersion: Number.isInteger(item.artifactVersion) ? item.artifactVersion : null,
      candidateSha256: item.candidateSha256, modelCallCreated: false, status: 'failed', error: item.error.slice(0, 1000),
      createdAt: optionalString(item.createdAt) }];
  }) : [];
  const actions = raw.actions && typeof raw.actions === 'object' ? Object.fromEntries(
    ['canRun', 'canReview', 'canReviewSameRun', 'canOpenReviewRound', 'canReconnectReview', 'canConfirm', 'canAdjudicateConfirm', 'canPreview', 'canGoal', 'canScope', 'canAuthorizeScope', 'canPause', 'canCancel', 'canChat', 'canInstructions', 'canMaterials', 'canInspectDiff', 'canRevise', 'canApprovePlan'].map((key) => [key, raw.actions[key] === true]),
  ) : {
    canRun: false, canReview: false, canReviewSameRun: false, canOpenReviewRound: false, canReconnectReview: false, canConfirm: false, canAdjudicateConfirm: false, canPreview: false, canGoal: false, canScope: false, canAuthorizeScope: false, canPause: false,
    canCancel: false, canChat: false, canInstructions: false, canMaterials: false, canInspectDiff: false, canRevise: false, canApprovePlan: false,
  };
  actions.phase = optionalString(raw.actions?.phase);
  actions.canContinue = raw.actions?.canResume === true || raw.actions?.canContinue === true;
  actions.canResume = raw.actions?.canResume === true;
  actions.resumeReason = optionalString(raw.actions?.resumeReason);
  actions.stopClass = optionalString(raw.actions?.stopClass);
  // Model execution is a separate capability gate. Only the documented
  // native-level field can open it; action metadata is informative but is not
  // accepted as a substitute for the runtime mode contract.
  const aiEnabled = typeof raw.aiEnabled === 'boolean' ? raw.aiEnabled : null;
  actions.canRun = actions.canRun && aiEnabled === true;
  actions.canChat = actions.canChat && aiEnabled === true;
  const planText = optionalString(raw.plan?.text);
  const planSha256 = optionalString(raw.plan?.sha256);
  const plan = bindingCurrent && raw.plan && typeof raw.plan === 'object' && planText && SHA256.test(planSha256 || '')
    ? { text: planText, sha256: planSha256 } : null;
  const planApprovalStatus = ['saved', 'not_persisted', 'unavailable', 'mismatch', 'not_ready'].includes(raw.planApprovalStatus)
    ? raw.planApprovalStatus : 'not_ready';
  actions.canApprovePlan = actions.canApprovePlan && Boolean(plan);
  const round = raw.reviewRound && typeof raw.reviewRound === 'object' ? raw.reviewRound : null;
  const reviewRound = round && typeof round.id === 'string' && ['open', 'running', 'expired', 'stale', 'completed', 'failed'].includes(round.status)
    && SHA256.test(round.candidateSha256 || '') && Number.isInteger(round.maxModelCalls) && Number.isInteger(round.modelCalls)
    ? { id: round.id, status: round.status, expectedReviewId: optionalString(round.expectedReviewId), candidateSha256: round.candidateSha256,
      remainingCalls: Number.isInteger(round.remainingCalls) ? round.remainingCalls : 0, maxModelCalls: round.maxModelCalls,
      modelCalls: round.modelCalls, deadlineAt: optionalString(round.deadlineAt) }
    : null;
  return {
    bindingCurrent,
    registrySha256: optionalString(raw.registrySha256),
    source,
    aiEnabled,
    agents,
    runAgentId: optionalString(raw.runAgentId),
    phase: optionalString(raw.phase),
    plan,
    planApprovalStatus,
    sessions,
    preparationFailures,
    reviewRound,
    actions,
  };
}

export function safeLocalPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return null;
  try {
    const url = new URL(value, 'http://irixi.local');
    return url.origin === 'http://irixi.local' ? `${url.pathname}${url.search}${url.hash}` : null;
  } catch {
    return null;
  }
}

const GAME_WORKSPACE_BINDING_KEYS = Object.freeze([
  'taskId', 'goalVersionId', 'runId', 'projectId', 'registrySha256', 'scopeFingerprint',
  'artifactId', 'artifactVersion', 'candidateSha256',
]);

function sameGameWorkspaceBinding(left, right) {
  return Boolean(left && right && GAME_WORKSPACE_BINDING_KEYS.every((key) => (left[key] ?? null) === (right[key] ?? null)));
}

export function gameWorkspaceBindingMatches(data, native) {
  const binding = data?.binding;
  return Boolean(binding && native?.current && native.product?.bindingCurrent
    && binding.taskId === native.taskId && binding.goalVersionId === native.goalVersionId
    && binding.runId === native.execution?.id && binding.projectId === native.product.projectId
    && binding.registrySha256 === native.product.registrySha256
    && binding.scopeFingerprint === native.product.workspaceScopeFingerprint
    && (binding.artifactId ?? null) === (native.artifact?.id ?? null)
    && (binding.artifactVersion ?? null) === (native.artifact?.version ?? null)
    && (binding.candidateSha256 ?? null) === (native.artifact?.candidateSha256 ?? null));
}

export function gameWorkspaceFileResponseMatches(response, {
  native, expectedBinding, view, relativePath, requestId, currentRequestId,
}) {
  return Boolean(requestId === currentRequestId && ['source', 'candidate'].includes(view)
    && response?.view === view && response?.relativePath === relativePath && response?.file
    && sameGameWorkspaceBinding(response.binding, expectedBinding)
    && gameWorkspaceBindingMatches(response, native));
}

function nativeExecutionActive(product) {
  const execution = product?.execution;
  const activeCall = execution?.modelCalls?.some((call) => ['reserved', 'running', 'started', 'in_progress'].includes(call?.status))
    || execution?.calls?.some((call) => ['reserved', 'running', 'started', 'in_progress'].includes(call?.status));
  const activeSession = product?.native?.sessions?.some((session) => ['running', 'in_progress', 'working'].includes(session.status));
  if (activeCall || activeSession) return true;
  if (typeof product?.taskLifecycle?.inFlight === 'boolean') return product.taskLifecycle.inFlight;
  if (['complete', 'completed', 'idle'].includes(product?.native?.actions?.phase)) return false;
  if (['running', 'executing', 'in_progress'].includes(product?.native?.actions?.phase)) return true;

  // Authority may retain an old execution phase after the task has reached a
  // user-facing terminal state. Prefer live task/call state over that phase.
  if (['ready_to_export', 'completed', 'failed', 'blocked', 'cancelled', 'archived'].includes(product?.status)) return false;
  const deadline = Date.parse(execution?.deadline || '');
  if (Number.isFinite(deadline) && deadline <= Date.now()) return false;
  return Boolean(execution?.id && (
    ['running', 'executing', 'in_progress'].includes(execution.phase)
    || ['running', 'in_progress'].includes(product.status)
  ));
}

export function canCreateNativeTask(product, backendMode = 'openoffice') {
  return backendMode === 'openoffice' && Boolean(safeLocalPath(product?.links?.createTask)) && !nativeExecutionActive(product);
}

function nativeTaskPath(value) {
  const safe = safeLocalPath(value);
  if (!safe) return null;
  const url = new URL(safe, 'http://irixi.local');
  url.searchParams.set('backend', 'openoffice');
  return `${url.pathname}${url.search}${url.hash}`;
}

function nextStepFor(product) {
  if (!product.current) return '目标或授权已变化；旧执行与旧候选不能继续作为当前结果。';
  if (product.nextStep) return product.nextStep;
  if (product.artifact?.confirmation) return '指定版本已经确认，可以下载同一份已确认 patch。';
  if (product.artifact?.review?.passed) return '候选已通过原生审阅，等待你核对并确认指定版本。';
  if (product.status === 'failed' || product.execution?.stopReason) return `原生执行已停止：${product.execution?.stopReason || '未提供停止原因'}`;
  if (product.execution) return `OpenOffice 原生执行处于 ${product.execution.phase || product.status} 阶段。`;
  if (product.registeredExecution) return '任务已经登记到 OpenOffice；请从原生任务入口继续查看。';
  return '原生后台尚未提供下一步摘要。';
}

function taskStatus(product) {
  if (!product.current) return 'partial';
  if (product.artifact?.confirmation) return 'ready_to_export';
  if (product.artifact?.review?.passed) return 'waiting_user';
  if (!product.artifact && product.execution?.phase === 'planned') return product.native?.plan ? 'ready' : 'waiting_start';
  if (product.native?.actions?.canApprovePlan) return 'waiting_user';
  if (['failed', 'cancelled', 'paused', 'blocked', 'completed'].includes(product.status)) {
    return STATUS_MAP[product.status] || 'idle';
  }
  const activeStatuses = ['reserved', 'running', 'started', 'in_progress', 'working'];
  const bindingMatches = product.native?.bindingCurrent === true
    && product.native.source === 'openoffice-native'
    && Boolean(product.execution?.id)
    && product.native.registrySha256 === product.product?.registrySha256;
  const deadline = Date.parse(product.execution?.deadline || '');
  const withinDeadline = !Number.isFinite(deadline) || deadline > Date.now();
  const hasActiveCall = bindingMatches && withinDeadline && (
    product.execution?.modelCalls?.some((call) => activeStatuses.includes(call.status))
    || product.native.sessions.some((session) => activeStatuses.includes(session.status))
  );
  if (hasActiveCall) return 'running';
  if (product.status === 'waiting_user') return 'waiting_user';
  if (['running', 'in_progress'].includes(product.status)) return 'partial';
  return STATUS_MAP[product.status] || 'idle';
}

export function normalizeNativeProductState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('OpenOffice 返回了无法识别的产品状态。');
  if (raw.task === null && raw.status === 'waiting_task') {
    const setup = normalizeSetup(raw.setup);
    return {
      setupOnly: true,
      setupStatus: 'waiting_task',
      taskId: null,
      title: '建立第一项原生任务',
      goalStatement: null,
      goalVersionId: null,
      authorityCurrent: false,
      current: false,
      status: 'waiting_task',
      statusLabel: '等待建立任务',
      nextStep: '写下一个真实目标；尚未填写的成功条件和工作边界会保持为空，不由前端补写。',
      actor: null,
      stationRole: null,
      execution: null,
      artifact: null,
      registeredExecution: null,
      team: [],
      workItems: [],
      conversations: [],
      native: { bindingCurrent: false, registrySha256: null, sessions: [], actions: {} },
      product: null,
      setup,
      currentResultRecovery: null,
      links: {
        createTask: safeLocalPath(raw.links?.createTask) || '/api/product/tasks',
        projects: safeLocalPath(raw.links?.projects) || '/api/product/projects',
        nativeTask: null,
        actions: null,
        confirm: null,
        patch: null,
      },
      officeStatus: 'idle',
      memory: { entries: [], projectScopeCurrent: false, indexAvailable: raw.memory?.indexAvailable === true },
    };
  }
  if (raw.task && typeof raw.task === 'object' && ['waiting_scope', 'waiting_scope_authorization', 'ready_to_run', 'runtime_starting', 'runtime_unavailable'].includes(raw.status)) {
    const taskId = requiredString(raw.task.id, 'task.id');
    const goalVersionId = requiredString(raw.task.goalVersionId, 'task.goalVersionId');
    const setup = normalizeSetup(raw.setup);
    const status = raw.status;
    const actions = normalizeNative(raw.native || {})?.actions || {};
    const taskLifecycle = raw.taskLifecycle && typeof raw.taskLifecycle === 'object'
      && typeof raw.taskLifecycle.inFlight === 'boolean' ? {
        status: optionalString(raw.taskLifecycle.status), inFlight: raw.taskLifecycle.inFlight,
      } : null;
    const currentResultRecovery = normalizeCurrentResultRecovery(raw.currentResultRecovery, {
      taskId, goalVersionId, scope: setup.selectedScope, inFlight: taskLifecycle?.inFlight,
      executionId: optionalString(raw.execution?.id), registrySha256: optionalString(raw.registry?.registrySha256),
    });
    return {
      setupOnly: false,
      setupPending: true,
      setupStatus: status,
      taskId,
      title: optionalString(raw.task.title) || `OpenOffice 任务 ${taskId}`,
      functionId: OFFICE_FUNCTION_IDS.has(raw.task.functionId) ? raw.task.functionId : null,
      goalStatement: requiredString(raw.task.statement, 'task.statement'),
      successCriteria: Array.isArray(raw.task.successCriteria) ? raw.task.successCriteria.filter((item) => typeof item === 'string') : [],
      boundaries: Array.isArray(raw.task.boundaries) ? raw.task.boundaries.filter((item) => typeof item === 'string') : [],
      goalVersionId,
      authorityCurrent: true,
      current: false,
      status,
      taskLifecycle,
      statusLabel: currentResultRecovery ? '已确认成果待恢复' : status === 'waiting_scope' ? '等待选择项目范围'
        : status === 'waiting_scope_authorization' ? '等待授权所选范围'
          : status === 'ready_to_run' ? '项目范围已授权，等待原生运行准备'
            : status === 'runtime_starting' ? '原生后台正在启动'
              : '原生后台当前不可用，执行记录已保留',
      nextStep: currentResultRecovery
        ? '当前任务已有已确认成果；可沿用同一执行与候选恢复，不会重新开发或调用模型。'
        : status === 'waiting_scope'
        ? '从后台返回的已登记项目中选择一个当前范围；不会接受任意本地路径。'
        : status === 'waiting_scope_authorization'
          ? '核对所选项目、可写路径和固定检查；只有后台明确开放授权动作后才能继续。'
          : status === 'ready_to_run'
            ? '范围授权已保存，但原生执行、产品登记和模型调用尚未开始；等待后台完成可验证的运行准备。'
            : status === 'runtime_starting'
              ? '当前执行与产品登记已经写入，原生后台正在启动；模型工作尚未开始。'
              : '当前执行与产品登记仍保留，但原生后台不可用；不会用旧数据冒充已连接。',
      actor: null,
      stationRole: null,
      execution: raw.execution && typeof raw.execution === 'object' ? {
        id: optionalString(raw.execution.id), phase: optionalString(raw.execution.phase), stopReason: optionalString(raw.execution.stopReason),
        deadline: optionalString(raw.execution.deadline),
        modelCalls: Array.isArray(raw.execution.modelCalls) ? raw.execution.modelCalls.map((call) => ({ status: optionalString(call?.status) })) : [],
      } : null,
      registry: raw.registry && typeof raw.registry === 'object' ? {
        status: optionalString(raw.registry.status), projectId: optionalString(raw.registry.projectId),
        scopeFingerprint: optionalString(raw.registry.scopeFingerprint), preparedAt: optionalString(raw.registry.preparedAt),
        registrySha256: optionalString(raw.registry.registrySha256), registeredEventId: optionalString(raw.registry.registeredEventId),
      } : null,
      artifact: null,
      registeredExecution: null,
      team: [],
      workItems: [],
      conversations: [],
      native: { bindingCurrent: false, registrySha256: null, sessions: [], actions },
      product: null,
      setup,
      currentResultRecovery,
      canPrepareRun: raw.canPrepareRun === true,
      blockedReason: optionalString(raw.blockedReason),
      links: {
        createTask: safeLocalPath(raw.links?.createTask) || (!nativeExecutionActive(raw) ? '/api/product/tasks' : null),
        projects: safeLocalPath(raw.links?.projects) || '/api/product/projects',
        nativeTask: null,
        actions: safeLocalPath(raw.links?.actions) || `/api/product/tasks/${encodeURIComponent(taskId)}/actions`,
        confirm: null,
        patch: null,
      },
      officeStatus: status === 'runtime_unavailable' ? 'partial' : 'waiting_start',
      memory: normalizeMemory(raw.memory),
    };
  }
  const taskId = requiredString(raw.taskId, 'taskId');
  const goalVersionId = requiredString(raw.goalVersionId, 'goalVersionId');
  if (typeof raw.current !== 'boolean') throw new Error('OpenOffice 状态缺少 current。');
  const status = requiredString(raw.status, 'status');
  const authorityCurrent = raw.current;
  const bindingCurrent = raw.product?.bindingCurrent === true;
  const currentResultRecovery = normalizeCurrentResultRecovery(raw.currentResultRecovery, {
    taskId, goalVersionId,
    scope: { projectId: optionalString(raw.product?.projectId), scopeFingerprint: optionalString(raw.product?.workspaceScopeFingerprint), current: authorityCurrent && bindingCurrent },
    inFlight: raw.taskLifecycle?.inFlight,
    executionId: optionalString(raw.execution?.id), registrySha256: optionalString(raw.product?.registrySha256),
  });
  const actor = optionalString(raw.actor || raw.execution?.actor);
  const stationRole = stationRoleFor(actor);
  const native = normalizeNative(raw.native);
  const previewRaw = raw.preview && typeof raw.preview === 'object' ? raw.preview : null;
  const preview = previewRaw ? {
    status: optionalString(previewRaw.status),
    taskId: optionalString(previewRaw.taskId),
    goalVersionId: optionalString(previewRaw.goalVersionId),
    executionId: optionalString(previewRaw.executionId),
    registrySha256: optionalString(previewRaw.registrySha256),
    artifactId: optionalString(previewRaw.artifactId),
    artifactVersion: Number.isInteger(previewRaw.artifactVersion) ? previewRaw.artifactVersion : null,
    candidateSha256: optionalString(previewRaw.candidateSha256),
    entry: optionalString(previewRaw.entry),
    error: optionalString(previewRaw.error),
  } : null;
  const previewBindingCurrent = Boolean(preview && authorityCurrent && bindingCurrent
    && preview.taskId === taskId && preview.goalVersionId === goalVersionId
    && preview.executionId === optionalString(raw.execution?.id)
    && preview.registrySha256 === optionalString(raw.product?.registrySha256)
    && preview.artifactId === optionalString(raw.artifact?.id) && preview.artifactVersion === raw.artifact?.version
    && preview.candidateSha256 === optionalString(raw.artifact?.candidateSha256)
    && raw.product?.capabilities?.staticPreviewEntries?.includes(preview.entry)
    && raw.product?.capabilities?.staticPreviewFiles?.includes(preview.entry));
  const confirmedToolZipAvailable = Boolean(authorityCurrent && bindingCurrent
    && safeLocalPath(raw.links?.zip)
    && raw.artifact?.review?.passed === true
    && raw.artifact?.confirmation?.approvalId
    && raw.artifact.confirmation.artifactVersion === raw.artifact.version
    && raw.artifact.confirmation.goalVersionId === goalVersionId);
  const nativeSessionAgentIds = new Set(native?.sessions.map((session) => session.agentId).filter(Boolean) || []);
  const nativeRosterAgentIds = new Set(native?.source === 'openoffice-native' ? native.agents.map((agent) => agent.id) : []);
  const rosterIsNative = raw.team?.source === 'openoffice-native' && native?.source === 'openoffice-native';
  const team = normalizeTeam(raw.team).filter((agent) => nativeSessionAgentIds.has(agent.id) || rosterIsNative && nativeRosterAgentIds.has(agent.id));
  const product = {
    taskId,
    title: optionalString(raw.title) || `OpenOffice 任务 ${taskId}`,
    functionId: OFFICE_FUNCTION_IDS.has(raw.functionId || raw.task?.functionId) ? raw.functionId || raw.task.functionId : null,
    goalStatement: optionalString(raw.goalStatement) || 'OpenOffice 尚未提供目标正文。',
    successCriteria: Array.isArray(raw.successCriteria) ? raw.successCriteria.filter((item) => typeof item === 'string') : [],
    boundaries: Array.isArray(raw.boundaries) ? raw.boundaries.filter((item) => typeof item === 'string') : [],
    goalVersionId,
    authorityCurrent,
    current: authorityCurrent && bindingCurrent,
    status,
    taskLifecycle: raw.taskLifecycle && typeof raw.taskLifecycle === 'object'
      && typeof raw.taskLifecycle.inFlight === 'boolean' ? {
        status: optionalString(raw.taskLifecycle.status), inFlight: raw.taskLifecycle.inFlight,
      } : null,
    statusLabel: optionalString(raw.statusLabel),
    nextStep: optionalString(raw.nextStep),
    actor,
    stationRole,
    execution: raw.execution && typeof raw.execution === 'object' ? {
      id: optionalString(raw.execution.id),
      phase: optionalString(raw.execution.phase),
      stopReason: optionalString(raw.execution.stopReason),
      deadline: optionalString(raw.execution.deadline),
      modelCalls: Array.isArray(raw.execution.modelCalls) ? raw.execution.modelCalls.map((call) => ({ status: optionalString(call?.status) })) : [],
    } : null,
    artifact: raw.artifact && typeof raw.artifact === 'object' ? {
      id: optionalString(raw.artifact.id),
      version: raw.artifact.version ?? null,
      candidateSha256: optionalString(raw.artifact.candidateSha256),
      hostCheck: raw.artifact.hostCheck && typeof raw.artifact.hostCheck === 'object' ? { passed: raw.artifact.hostCheck.passed === true } : null,
      review: raw.artifact.review && typeof raw.artifact.review === 'object' ? {
        id: optionalString(raw.artifact.review.id),
        passed: raw.artifact.review.passed === true,
        nativeVerdict: optionalString(raw.artifact.review.nativeVerdict),
        scopeOutcome: optionalString(raw.artifact.review.scopeOutcome),
        fullOutputSha256: optionalString(raw.artifact.review.fullOutputSha256),
      } : null,
      confirmation: raw.artifact.confirmation && typeof raw.artifact.confirmation === 'object' ? {
        approvalId: optionalString(raw.artifact.confirmation.approvalId),
        artifactVersion: raw.artifact.confirmation.artifactVersion ?? null,
        goalVersionId: optionalString(raw.artifact.confirmation.goalVersionId),
        reviewAdjudication: raw.artifact.confirmation.reviewAdjudication && typeof raw.artifact.confirmation.reviewAdjudication === 'object' ? {
          reviewId: optionalString(raw.artifact.confirmation.reviewAdjudication.reviewId),
          reviewFullOutputSha256: optionalString(raw.artifact.confirmation.reviewAdjudication.reviewFullOutputSha256),
          reason: optionalString(raw.artifact.confirmation.reviewAdjudication.reason),
          decidedBy: optionalString(raw.artifact.confirmation.reviewAdjudication.decidedBy),
          decidedAt: optionalString(raw.artifact.confirmation.reviewAdjudication.decidedAt),
          authorizationSourceThreadId: optionalString(raw.artifact.confirmation.reviewAdjudication.authorizationSourceThreadId),
          authorizationText: optionalString(raw.artifact.confirmation.reviewAdjudication.authorizationText),
        } : null,
      } : null,
    } : null,
    registeredExecution: raw.registeredExecution && typeof raw.registeredExecution === 'object' ? {
      goalVersionId: optionalString(raw.registeredExecution.goalVersionId),
      displayPrompt: optionalString(raw.registeredExecution.displayPrompt),
      promptSha256: optionalString(raw.registeredExecution.promptSha256),
    } : null,
    team,
    workItems: normalizeWorkItems(raw.workItems),
    conversations: normalizeConversations(raw.conversations),
    memory: normalizeMemory(raw.memory),
    canPrepareRun: raw.canPrepareRun === true,
    currentResultRecovery,
    blockedReason: optionalString(raw.blockedReason),
    native,
    product: raw.product && typeof raw.product === 'object' ? {
      projectId: optionalString(raw.product.projectId),
      registrySha256: optionalString(raw.product.registrySha256),
      bindingCurrent,
      bindingError: optionalString(raw.product.bindingError),
      workspaceScopeFingerprint: optionalString(raw.product.workspaceScopeFingerprint),
      allowedWritePaths: Array.isArray(raw.product.allowedWritePaths) ? raw.product.allowedWritePaths.filter((item) => typeof item === 'string') : [],
      checks: Array.isArray(raw.product.checks) ? raw.product.checks.filter((item) => typeof item === 'string' || (item && typeof item === 'object')) : [],
      capabilities: raw.product.capabilities && typeof raw.product.capabilities === 'object' && !Array.isArray(raw.product.capabilities) ? {
        team: typeof raw.product.capabilities.team === 'boolean' ? raw.product.capabilities.team : null,
        worktree: typeof raw.product.capabilities.worktree === 'boolean' ? raw.product.capabilities.worktree : null,
        staticPreviewEntries: Array.isArray(raw.product.capabilities.staticPreviewEntries) ? raw.product.capabilities.staticPreviewEntries.filter((item) => typeof item === 'string') : [],
        staticPreviewFiles: Array.isArray(raw.product.capabilities.staticPreviewFiles) ? raw.product.capabilities.staticPreviewFiles.filter((item) => typeof item === 'string') : [],
        autoMerge: typeof raw.product.capabilities.autoMerge === 'boolean' ? raw.product.capabilities.autoMerge : null,
        manualMerge: typeof raw.product.capabilities.manualMerge === 'boolean' ? raw.product.capabilities.manualMerge : null,
        commandPreview: typeof raw.product.capabilities.commandPreview === 'boolean' ? raw.product.capabilities.commandPreview : null,
      } : null,
      allowedRoles: Array.isArray(raw.product.native?.allowedRoles) ? raw.product.native.allowedRoles.filter((item) => typeof item === 'string') : [],
      maxModelCalls: Number.isFinite(raw.product.native?.maxModelCalls) ? raw.product.native.maxModelCalls : null,
      maxDurationMs: Number.isFinite(raw.product.native?.maxDurationMs) ? raw.product.native.maxDurationMs : null,
    } : null,
    links: {
      createTask: safeLocalPath(raw.links?.createTask) || (!nativeExecutionActive(raw) ? '/api/product/tasks' : null),
      nativeTask: nativeTaskPath(raw.links?.nativeTask),
      actions: safeLocalPath(raw.links?.actions),
      candidate: safeLocalPath(raw.links?.candidate),
      confirm: safeLocalPath(raw.links?.confirm),
      patch: safeLocalPath(raw.links?.patch),
      zip: confirmedToolZipAvailable ? safeLocalPath(raw.links?.zip) : null,
      preview: previewBindingCurrent && preview?.status === 'ready'
        ? safeLocalPath(raw.previewLink || raw.links?.preview) : null,
    },
    preview: previewBindingCurrent ? preview : null,
  };
  product.nextStep = nextStepFor(product);
  product.officeStatus = taskStatus(product);
  return product;
}

export function nativeProductAsOfficeTask(product) {
  const roster = product.team.map((agent) => ({ ...agent, goalVersionId: product.goalVersionId }));
  const workItems = product.workItems.flatMap((item) => {
    const matching = item.agentId ? roster.find((agent) => agent.id === item.agentId) : roster.find((agent) => agent.stationRole === item.role);
    const role = item.role || matching?.stationRole || null;
    return role ? [{ ...item, role, agentId: matching?.id || item.agentId || null }] : [];
  });
  // Native execution identities are displayed from the native roster. Do not
  // project an executor phase onto one of the office-function coworkers.
  const activeRole = null;
  const activeAgent = null;
  return {
    id: product.taskId,
    title: product.title,
    functionId: OFFICE_FUNCTION_IDS.has(product.functionId) ? product.functionId : null,
    type: 'project',
    provider: 'openoffice',
    status: product.officeStatus,
    activeRole,
    activeAgentId: null,
    updatedAt: null,
    goal: {
      activeVersionId: product.goalVersionId,
      versions: [{
        id: product.goalVersionId,
        version: product.goalVersionId,
        statement: product.goalStatement,
        successCriteria: product.successCriteria || [],
        boundaries: product.boundaries || [],
      }],
    },
    materials: [],
    materialContext: { fingerprint: null, effectiveMaterialIds: [], directory: [] },
    suggestions: [],
    workItems,
    team: { agents: roster },
    events: [{ type: 'openoffice.projection', at: null, message: product.statusLabel || product.nextStep, detail: {} }],
    artifacts: [],
    reviews: [],
    approvals: [],
    conversationQueue: [],
    runtime: {},
    continuity: { progress: { nextStep: product.nextStep } },
    plan: null,
    nativeProduct: true,
  };
}

export function nativeOfficeWaitingPresentation(product, task) {
  if (!product?.current || task?.status !== 'waiting_user' || product.taskId !== task.id
      || product.goalVersionId !== task.goal?.activeVersionId) return null;
  const detail = product.nextStep || '按当前审阅结果处理。';
  const presentation = (statusLabel, kicker, title, tone = 'normal') => ({
    statusLabel, office: { kicker, title, detail, tone },
  });
  if (product.native?.actions.canApprovePlan && product.native.plan) {
    return presentation('待批准计划', 'PLAN AWAITING APPROVAL', '原生计划等待你的审批');
  }
  const artifact = product.artifact;
  if (!artifact?.id || artifact.confirmation) return null;
  if (artifact.review?.passed === false) {
    return presentation('审阅未通过，待修改', 'REVIEW RETURNED', '审阅未通过，待修改', 'attention');
  }
  if (artifact.review?.passed === true) {
    return presentation('等待你确认', 'CANDIDATE READY', '原生候选已通过审阅，等待你的确认');
  }
  return presentation('待审阅', 'NATIVE REVIEW PENDING', '原生候选等待审阅');
}

export function nativeExecutionRoleFallback(product) {
  if (product?.taskLifecycle?.inFlight === false
    && (product.officeStatus === 'ready_to_export' || product.artifact?.confirmation)) {
    return '本轮工作已结束，原生角色待命';
  }
  if (product?.officeStatus === 'running' && product.taskLifecycle?.inFlight === true) {
    return '原生团队正在执行当前授权任务，当前角色尚未返回';
  }
  return null;
}

export function nativeCoworkerPresence(product, officeTask, role) {
  const members = Array.isArray(officeTask?.team?.agents) ? officeTask.team.agents : [];
  const workItems = Array.isArray(product?.workItems) ? product.workItems : [];
  const member = members.find((agent) => agent?.stationRole === role || agent?.roleKey === role) || null;
  const matchingWork = workItems.filter((item) => item?.role === role || (member?.id && item?.agentId === member.id));
  const workItem = matchingWork.find((item) => item.status === 'running') || matchingWork.at(-1) || null;
  const ownsFunction = OFFICE_FUNCTION_BY_STATION[role] === product?.functionId;
  const active = product?.current === true && officeTask?.status === 'running' && ownsFunction;
  return { member, workItem, active };
}

export function nativeFunctionDiscussionMember(product, functionId) {
  if (!['utility', 'game', 'agent'].includes(functionId) || product?.functionId !== functionId) return null;
  const leadId = product?.native?.runAgentId;
  if (typeof leadId !== 'string' || !leadId) return null;
  return product.team.find((agent) => agent.id === leadId) || null;
}

export function nativeFunctionChatContext(product, functionId, actionBound) {
  if (functionId === 'learning') return { functionOwner: false, member: null, canSend: false };
  if (!['utility', 'game', 'agent'].includes(functionId)) return null;
  const functionOwner = product?.functionId === functionId;
  const member = functionOwner ? nativeFunctionDiscussionMember(product, functionId) : null;
  return { functionOwner, member, canSend: Boolean(functionOwner && member?.id && product.current === true
    && product.native?.aiEnabled === true && product.native?.actions.canChat === true && actionBound === true) };
}

export function normalizeNativeCandidate(raw, product) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !product?.artifact) throw new Error('OpenOffice 返回了无法识别的候选内容。');
  const artifact = product.artifact;
  const taskId = requiredString(raw.taskId, 'candidate.taskId');
  const goalVersionId = requiredString(raw.goalVersionId, 'candidate.goalVersionId');
  const artifactId = requiredString(raw.artifactId, 'candidate.artifactId');
  if (taskId !== product.taskId || goalVersionId !== product.goalVersionId || artifactId !== artifact.id
    || raw.artifactVersion !== artifact.version || requiredString(raw.candidateSha256, 'candidate.candidateSha256') !== artifact.candidateSha256) {
    throw new Error('OpenOffice 返回的候选不属于当前任务、目标或版本。');
  }
  if (typeof raw.patch !== 'string' || !Array.isArray(raw.files) || !Array.isArray(raw.checks)) throw new Error('OpenOffice 候选缺少完整差异、文件或检查记录。');
  return {
    taskId,
    goalVersionId,
    artifactId,
    artifactVersion: raw.artifactVersion,
    candidateSha256: artifact.candidateSha256,
    diffSha256: requiredString(raw.diffSha256, 'candidate.diffSha256'),
    patchSha256: requiredString(raw.patchSha256, 'candidate.patchSha256'),
    patch: raw.patch,
    files: raw.files.flatMap((item) => item && typeof item === 'object' && optionalString(item.path)
      ? [{ path: optionalString(item.path), sha256: optionalString(item.sha256), bytes: Number.isFinite(item.bytes) ? item.bytes : null }]
      : []),
    checks: raw.checks.flatMap((item) => item && typeof item === 'object' && optionalString(item.id)
      ? [{ id: optionalString(item.id), passed: item.passed === true, detail: optionalString(item.detail || item.output || item.summary) }]
      : []),
    review: raw.review && typeof raw.review === 'object' ? {
      id: optionalString(raw.review.id), passed: raw.review.passed === true,
      nativeVerdict: optionalString(raw.review.nativeVerdict), fullOutputSha256: optionalString(raw.review.fullOutputSha256),
      text: optionalString(raw.review.text),
    } : null,
    confirmation: raw.confirmation && typeof raw.confirmation === 'object' ? raw.confirmation : null,
  };
}

function normalizeMemory(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !Number.isInteger(entry.revision)
        || !['preference', 'convention'].includes(entry.kind) || !['global', 'project'].includes(entry.scopeType)
        || !['active', 'deactivated', 'deleted'].includes(entry.status)) return [];
    return [{ id: entry.id, revision: entry.revision, kind: entry.kind, scopeType: entry.scopeType,
      title: optionalString(entry.title) || '未命名记忆', text: optionalString(entry.text) || '', status: entry.status,
      ownerTaskId: optionalString(entry.ownerTaskId), source: entry.source && typeof entry.source === 'object' ? {
        type: optionalString(entry.source.type), taskId: optionalString(entry.source.taskId), eventId: optionalString(entry.source.eventId), revision: entry.source.revision,
      } : null }];
  }) : [];
  const references = Array.isArray(raw?.references) ? raw.references.flatMap((item) => item && typeof item.id === 'string' && Number.isInteger(item.revision)
    ? [{ id: item.id, revision: item.revision, title: optionalString(item.title) || item.id,
      ownerTaskId: optionalString(item.ownerTaskId), sourceEventId: optionalString(item.sourceEventId) }] : []) : [];
  return { entries, references, projectScopeCurrent: raw?.projectScopeCurrent === true,
    indexAvailable: raw?.indexAvailable === true, indexDegraded: optionalString(raw?.indexDegraded),
    currentForExecution: raw?.currentForExecution !== false, stalePreparedPrompt: raw?.stalePreparedPrompt === true };
}

export function nativeActionPayload(product, action, input = {}) {
  const setupActions = ['goal', 'instructions', 'materials', 'scope', 'authorize_scope', 'prepare_run', 'memory_save', 'memory_change'];
  const executionActions = ['pause', 'cancel', 'continue', 'run', 'approve_plan', 'review', 'open_review_round', 'reconnect_review_runtime', 'revise', 'preview', 'chat'];
  if (![...setupActions, ...executionActions].includes(action)) throw new Error('不支持这个原生任务动作。');
  if (!product?.authorityCurrent || !product.goalVersionId) throw new Error('当前原生任务目标绑定不完整。');
  if (executionActions.includes(action) && (!product.current || !product.execution?.id || !product.product?.registrySha256)) {
    throw new Error('当前原生任务执行绑定不完整。');
  }
  const payload = {
    ...input,
    action,
    expectedGoalVersionId: product.goalVersionId,
  };
  if (action === 'prepare_run' && input.mode === 'reuse_current_result') {
    const recovery = product.currentResultRecovery;
    const scope = product.setup?.selectedScope;
    if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['mode'])
      || !product.setupPending || !product.canPrepareRun || product.taskLifecycle?.inFlight !== false
      || !scope?.current || recovery?.taskId !== product.taskId || recovery.goalVersionId !== product.goalVersionId
      || recovery.projectId !== scope.projectId || recovery.scopeFingerprint !== scope.scopeFingerprint
      || recovery.reuseInput?.mode !== 'reuse_current_result') {
      throw new Error('当前没有可安全复用的已确认成果绑定。');
    }
    return { action, ...recovery.reuseInput };
  }
  const registrySha256 = product.product?.registrySha256 || product.registry?.registrySha256 || null;
  if (action !== 'prepare_run' && !['memory_save', 'memory_change'].includes(action) && product.execution?.id) payload.expectedExecutionId = product.execution.id;
  if (action !== 'prepare_run' && !['memory_save', 'memory_change'].includes(action) && registrySha256) payload.expectedRegistrySha256 = registrySha256;
  if (['review', 'open_review_round', 'reconnect_review_runtime', 'revise', 'preview'].includes(action)) {
    if (!product.artifact?.id || product.artifact.version === null || product.artifact.version === undefined) throw new Error('当前原生候选版本绑定不完整。');
    payload.expectedArtifactId = product.artifact.id;
    payload.expectedArtifactVersion = product.artifact.version;
  }
  if (action === 'review' || action === 'open_review_round' || action === 'reconnect_review_runtime') {
    if (!SHA256.test(product.artifact?.candidateSha256 || '')) throw new Error('当前原生候选摘要绑定不完整。');
    payload.expectedCandidateSha256 = product.artifact.candidateSha256;
    payload.expectedReviewId = product.artifact.review?.id || null;
    if (action === 'review' && product.native?.reviewRound?.status === 'open') {
      payload.expectedReviewRoundId = product.native.reviewRound.id;
    }
    if (action === 'open_review_round' && product.native?.actions?.canOpenReviewRound !== true) {
      throw new Error('当前未开放这个候选的显式后续审阅轮。');
    }
    if (action === 'reconnect_review_runtime') {
      if (product.native?.actions?.canReconnectReview !== true || product.artifact?.review?.passed === true
        || product.artifact?.confirmation
        || !SHA256.test(product.product?.workspaceScopeFingerprint || '')) {
        throw new Error('当前未开放这个失败候选的原执行环境重连。');
      }
      payload.expectedScopeFingerprint = product.product.workspaceScopeFingerprint;
    }
  }
  if (action === 'preview') {
    if (!product.artifact?.candidateSha256) throw new Error('当前原生候选摘要绑定不完整。');
    payload.expectedCandidateSha256 = product.artifact.candidateSha256;
  }
  if (action === 'approve_plan') {
    const planSha256 = product.native?.bindingCurrent === true && product.native?.actions.canApprovePlan === true
      ? product.native?.plan?.sha256 : null;
    if (!planSha256) throw new Error('当前没有可批准且绑定有效的 Lead 计划。');
    payload.expectedPlanSha256 = planSha256;
  }
  return payload;
}
