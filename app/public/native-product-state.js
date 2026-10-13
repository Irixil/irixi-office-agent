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

const ACTOR_ROLE = {
  developer: 'writer',
  writer: 'writer',
  researcher: 'researcher',
  reviewer: 'reviewer',
  steward: 'steward',
  archivist: 'archivist',
  coordinator: 'coordinator',
};

function requiredString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`OpenOffice 状态缺少 ${name}。`);
  return value.trim();
}

function optionalString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeNativeTaskDraft(input = {}) {
  return {
    title: typeof input.title === 'string' ? input.title.trim() : '',
    statement: typeof input.statement === 'string' ? input.statement.trim() : '',
    successCriteria: typeof input.successCriteria === 'string'
      ? input.successCriteria.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : Array.isArray(input.successCriteria) ? input.successCriteria.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
    boundaries: typeof input.boundaries === 'string'
      ? input.boundaries.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
      : Array.isArray(input.boundaries) ? input.boundaries.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : [],
  };
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
      status: optionalString(item.status) || 'unknown', createdAt: optionalString(item.createdAt),
    }];
  }) : [];
  const actions = raw.actions && typeof raw.actions === 'object' ? Object.fromEntries(
    ['canRun', 'canReview', 'canConfirm', 'canPreview', 'canGoal', 'canScope', 'canAuthorizeScope', 'canPause', 'canCancel', 'canChat', 'canInstructions', 'canMaterials', 'canInspectDiff', 'canRevise', 'canApprovePlan'].map((key) => [key, raw.actions[key] === true]),
  ) : {
    canRun: false, canReview: false, canConfirm: false, canPreview: false, canGoal: false, canScope: false, canAuthorizeScope: false, canPause: false,
    canCancel: false, canChat: false, canInstructions: false, canMaterials: false, canInspectDiff: false, canRevise: false, canApprovePlan: false,
  };
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
  actions.canApprovePlan = actions.canApprovePlan && Boolean(plan);
  return {
    bindingCurrent,
    registrySha256: optionalString(raw.registrySha256),
    source,
    aiEnabled,
    agents,
    runAgentId: optionalString(raw.runAgentId),
    phase: optionalString(raw.phase),
    plan,
    sessions,
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
  if (!product.artifact && product.execution?.phase === 'planned') return 'ready';
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
      links: {
        createTask: safeLocalPath(raw.links?.createTask) || '/api/product/tasks',
        projects: safeLocalPath(raw.links?.projects) || '/api/product/projects',
        nativeTask: null,
        actions: null,
        confirm: null,
        patch: null,
      },
      officeStatus: 'idle',
    };
  }
  if (raw.task && typeof raw.task === 'object' && ['waiting_scope', 'waiting_scope_authorization', 'ready_to_run', 'runtime_starting', 'runtime_unavailable'].includes(raw.status)) {
    const taskId = requiredString(raw.task.id, 'task.id');
    const goalVersionId = requiredString(raw.task.goalVersionId, 'task.goalVersionId');
    const setup = normalizeSetup(raw.setup);
    const status = raw.status;
    const actions = normalizeNative(raw.native || {})?.actions || {};
    return {
      setupOnly: false,
      setupPending: true,
      setupStatus: status,
      taskId,
      title: optionalString(raw.task.title) || `OpenOffice 任务 ${taskId}`,
      goalStatement: requiredString(raw.task.statement, 'task.statement'),
      successCriteria: Array.isArray(raw.task.successCriteria) ? raw.task.successCriteria.filter((item) => typeof item === 'string') : [],
      boundaries: Array.isArray(raw.task.boundaries) ? raw.task.boundaries.filter((item) => typeof item === 'string') : [],
      goalVersionId,
      authorityCurrent: true,
      current: false,
      status,
      statusLabel: status === 'waiting_scope' ? '等待选择项目范围'
        : status === 'waiting_scope_authorization' ? '等待授权所选范围'
          : status === 'ready_to_run' ? '项目范围已授权，等待原生运行准备'
            : status === 'runtime_starting' ? '原生后台正在启动'
              : '原生后台当前不可用，执行记录已保留',
      nextStep: status === 'waiting_scope'
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
      canPrepareRun: raw.canPrepareRun === true,
      blockedReason: optionalString(raw.blockedReason),
      links: {
        createTask: null,
        projects: safeLocalPath(raw.links?.projects) || '/api/product/projects',
        nativeTask: null,
        actions: safeLocalPath(raw.links?.actions) || `/api/product/tasks/${encodeURIComponent(taskId)}/actions`,
        confirm: null,
        patch: null,
      },
      officeStatus: status === 'runtime_unavailable' ? 'partial' : 'ready',
    };
  }
  const taskId = requiredString(raw.taskId, 'taskId');
  const goalVersionId = requiredString(raw.goalVersionId, 'goalVersionId');
  if (typeof raw.current !== 'boolean') throw new Error('OpenOffice 状态缺少 current。');
  const status = requiredString(raw.status, 'status');
  const authorityCurrent = raw.current;
  const bindingCurrent = raw.product?.bindingCurrent === true;
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
  const nativeSessionAgentIds = new Set(native?.sessions.map((session) => session.agentId).filter(Boolean) || []);
  const nativeRosterAgentIds = new Set(native?.source === 'openoffice-native' ? native.agents.map((agent) => agent.id) : []);
  const rosterIsNative = raw.team?.source === 'openoffice-native' && native?.source === 'openoffice-native';
  const team = normalizeTeam(raw.team).filter((agent) => nativeSessionAgentIds.has(agent.id) || rosterIsNative && nativeRosterAgentIds.has(agent.id));
  const product = {
    taskId,
    title: optionalString(raw.title) || `OpenOffice 任务 ${taskId}`,
    goalStatement: optionalString(raw.goalStatement) || 'OpenOffice 尚未提供目标正文。',
    successCriteria: Array.isArray(raw.successCriteria) ? raw.successCriteria.filter((item) => typeof item === 'string') : [],
    boundaries: Array.isArray(raw.boundaries) ? raw.boundaries.filter((item) => typeof item === 'string') : [],
    goalVersionId,
    authorityCurrent,
    current: authorityCurrent && bindingCurrent,
    status,
    statusLabel: optionalString(raw.statusLabel),
    nextStep: optionalString(raw.nextStep),
    actor,
    stationRole,
    execution: raw.execution && typeof raw.execution === 'object' ? {
      id: optionalString(raw.execution.id),
      phase: optionalString(raw.execution.phase),
      stopReason: optionalString(raw.execution.stopReason),
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
      } : null,
      confirmation: raw.artifact.confirmation && typeof raw.artifact.confirmation === 'object' ? {
        approvalId: optionalString(raw.artifact.confirmation.approvalId),
        artifactVersion: raw.artifact.confirmation.artifactVersion ?? null,
        goalVersionId: optionalString(raw.artifact.confirmation.goalVersionId),
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
      nativeTask: nativeTaskPath(raw.links?.nativeTask),
      actions: safeLocalPath(raw.links?.actions),
      candidate: safeLocalPath(raw.links?.candidate),
      confirm: safeLocalPath(raw.links?.confirm),
      patch: safeLocalPath(raw.links?.patch),
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
  const runningWork = product.current && product.officeStatus === 'running' ? workItems.find((item) => item.status === 'running') : null;
  const workingAgent = product.current && product.officeStatus === 'running' ? roster.find((agent) => agent.status === 'working') : null;
  const activeRole = product.current && product.officeStatus === 'running' ? product.stationRole || runningWork?.role || workingAgent?.stationRole || null : null;
  const activeAgent = activeRole ? roster.find((agent) => agent.stationRole === activeRole) : null;
  return {
    id: product.taskId,
    title: product.title,
    type: 'project',
    provider: 'openoffice',
    status: product.officeStatus,
    activeRole,
    activeAgentId: activeAgent?.id || runningWork?.agentId || null,
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

export function nativeCoworkerPresence(product, officeTask, role) {
  const members = Array.isArray(officeTask?.team?.agents) ? officeTask.team.agents : [];
  const workItems = Array.isArray(product?.workItems) ? product.workItems : [];
  const member = members.find((agent) => agent?.stationRole === role || agent?.roleKey === role) || null;
  const matchingWork = workItems.filter((item) => item?.role === role || (member?.id && item?.agentId === member.id));
  const workItem = matchingWork.find((item) => item.status === 'running') || matchingWork.at(-1) || null;
  const active = product?.current === true && officeTask?.status === 'running'
    && (officeTask.activeRole === role || member?.status === 'working' || workItem?.status === 'running');
  return { member, workItem, active };
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
      nativeVerdict: optionalString(raw.review.nativeVerdict), text: optionalString(raw.review.text),
    } : null,
    confirmation: raw.confirmation && typeof raw.confirmation === 'object' ? raw.confirmation : null,
  };
}

export function nativeActionPayload(product, action, input = {}) {
  const setupActions = ['goal', 'instructions', 'materials', 'scope', 'authorize_scope', 'prepare_run'];
  const executionActions = ['pause', 'cancel', 'continue', 'run', 'approve_plan', 'review', 'revise', 'preview', 'chat'];
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
  const registrySha256 = product.product?.registrySha256 || product.registry?.registrySha256 || null;
  if (product.execution?.id) payload.expectedExecutionId = product.execution.id;
  if (registrySha256) payload.expectedRegistrySha256 = registrySha256;
  if (['review', 'revise', 'preview'].includes(action)) {
    if (!product.artifact?.id || product.artifact.version === null || product.artifact.version === undefined) throw new Error('当前原生候选版本绑定不完整。');
    payload.expectedArtifactId = product.artifact.id;
    payload.expectedArtifactVersion = product.artifact.version;
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
