import crypto from 'node:crypto';

import { activeGoal, artifactInputIsCurrent, deriveTaskContinuity, event, makeId, setTaskState } from './core.mjs';
import { materialContext } from './material-applicability.mjs';

const VALID_KINDS = new Set(['research', 'analysis', 'tool', 'synthesis', 'review', 'delivery']);
const SAFE_TOOL_NAMES = new Set(['materials.read', 'materials.search', 'memory.search', 'calculate', 'web.search', 'web.read']);
const MAX_PLAN_STEPS = 12;
const MAX_TEAM_SIZE = 8;

const clean = (value, limit = 2_000) => String(value ?? '').replaceAll('\u0000', '').trim().slice(0, limit);
const cleanList = (value, limit = 12, itemLimit = 500) => (Array.isArray(value) ? value : [])
  .map((item) => clean(item, itemLimit)).filter(Boolean).slice(0, limit);

function assertAcyclic(steps) {
  const visiting = new Set();
  const visited = new Set();
  const byKey = new Map(steps.map((step) => [step.key, step]));
  const visit = (key) => {
    if (visiting.has(key)) throw new Error(`计划存在循环依赖：${key}。`);
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependsOn || []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const step of steps) visit(step.key);
}

export function validateModelPlan(task, input = {}) {
  const projectAlignment = input.projectAlignment && typeof input.projectAlignment === 'object' ? {
    status: ['standalone', 'aligned', 'conflict'].includes(input.projectAlignment.status) ? input.projectAlignment.status : '',
    explanation: clean(input.projectAlignment.explanation, 1_000),
  } : { status: task.projectRootTaskId ? '' : 'standalone', explanation: '' };
  if (task.projectRootTaskId && !['aligned', 'conflict'].includes(projectAlignment.status)) throw new Error('关联任务计划必须明确判断任务目标与项目根目标是否一致。');
  if (!projectAlignment.explanation) projectAlignment.explanation = task.projectRootTaskId ? '未说明对齐依据。' : '独立任务。';
  const deliverables = cleanList(input.deliverables, 4, 40).filter((kind) => ['document', 'spreadsheet', 'presentation', 'email', 'calendar', 'research'].includes(kind));
  if (!deliverables.length) throw new Error('计划必须声明至少一种实际交付物。');
  const roles = (Array.isArray(input.roles) ? input.roles : []).map((role, index) => ({
    key: clean(role.key, 60) || `role-${index + 1}`,
    name: clean(role.name, 80) || `成员 ${index + 1}`,
    mission: clean(role.mission, 500),
    capabilities: cleanList(role.capabilities, 10, 100),
    recruitmentReason: clean(role.recruitmentReason, 500),
  }));
  if (!roles.length || roles.length > MAX_TEAM_SIZE) throw new Error(`计划必须安排 1–${MAX_TEAM_SIZE} 个必要角色。`);
  if (new Set(roles.map((role) => role.key)).size !== roles.length) throw new Error('计划角色 key 必须唯一。');
  const roleKeys = new Set(roles.map((role) => role.key));
  const steps = (Array.isArray(input.steps) ? input.steps : []).map((step, index) => ({
    key: clean(step.key, 60) || `step-${index + 1}`,
    title: clean(step.title, 160),
    kind: VALID_KINDS.has(step.kind) ? step.kind : 'analysis',
    role: clean(step.role, 60),
    dependsOn: cleanList(step.dependsOn, MAX_PLAN_STEPS, 60),
    tools: cleanList(step.tools, 8, 80),
    acceptanceCriteria: cleanList(step.acceptanceCriteria, 10, 500),
    expectedResult: clean(step.expectedResult, 1_000),
    webScope: step.webScope && typeof step.webScope === 'object' ? {
      queries: cleanList(step.webScope.queries, 8, 500),
      urls: cleanList(step.webScope.urls, 12, 1_000),
    } : null,
  }));
  if (steps.length < 3 || steps.length > MAX_PLAN_STEPS) throw new Error(`计划必须包含 3–${MAX_PLAN_STEPS} 个可执行步骤。`);
  if (new Set(steps.map((step) => step.key)).size !== steps.length) throw new Error('计划步骤 key 必须唯一。');
  const stepKeys = new Set(steps.map((step) => step.key));
  for (const step of steps) {
    if (!step.title || !step.expectedResult || !step.acceptanceCriteria.length) throw new Error(`步骤 ${step.key} 缺少标题、预期结果或验收标准。`);
    if (!roleKeys.has(step.role)) throw new Error(`步骤 ${step.key} 引用了不存在的角色 ${step.role}。`);
    if (step.dependsOn.includes(step.key) || step.dependsOn.some((key) => !stepKeys.has(key))) throw new Error(`步骤 ${step.key} 的依赖无效。`);
    const unknownTools = step.tools.filter((tool) => !SAFE_TOOL_NAMES.has(tool));
    if (unknownTools.length) throw new Error(`步骤 ${step.key} 请求了未授权工具：${unknownTools.join('、')}。`);
    if (step.tools.some((tool) => tool.startsWith('web.')) && !(step.webScope?.queries.length || step.webScope?.urls.length)) throw new Error(`步骤 ${step.key} 使用公开网页工具时必须预先声明 webScope.queries 或 webScope.urls。`);
  }
  assertAcyclic(steps);
  if (steps.filter((step) => step.kind === 'synthesis').length !== 1) throw new Error('计划必须且只能包含一个候选成果合成步骤。');
  if (steps.filter((step) => step.kind === 'review').length !== 1) throw new Error('计划必须且只能包含一个独立审阅步骤。');
  if (steps.filter((step) => step.kind === 'delivery').length !== 1) throw new Error('计划必须且只能包含一个确认后交付步骤。');
  const synthesis = steps.find((step) => step.kind === 'synthesis');
  const review = steps.find((step) => step.kind === 'review');
  const delivery = steps.find((step) => step.kind === 'delivery');
  if (review.role === synthesis.role) throw new Error('独立审阅必须由与候选成果合成不同的角色承担，不能自审。');
  if (!review.dependsOn.includes(synthesis.key)) throw new Error('独立审阅必须依赖候选成果合成。');
  if (!delivery.dependsOn.includes(review.key)) throw new Error('正式交付必须依赖独立审阅。');
  const ancestors = new Set();
  const collect = (key) => {
    for (const dependency of steps.find((step) => step.key === key)?.dependsOn || []) {
      if (ancestors.has(dependency)) continue;
      ancestors.add(dependency);
      collect(dependency);
    }
  };
  collect(synthesis.key);
  const orphaned = steps.filter((step) => !['synthesis', 'review', 'delivery'].includes(step.kind) && !ancestors.has(step.key));
  if (orphaned.length) throw new Error(`这些工作没有汇入候选成果：${orphaned.map((step) => step.key).join('、')}。`);
  return {
    summary: clean(input.summary, 1_000),
    projectAlignment,
    outputKind: ['document', 'spreadsheet', 'presentation', 'email', 'calendar', 'research'].includes(input.outputKind) ? input.outputKind : task.type,
    deliverables: [...new Set(deliverables)],
    roles,
    steps,
  };
}

function previousCompletedByKey(task) {
  const all = [...(task.workHistory || []).flatMap((entry) => entry.items || []), ...(task.workItems || [])];
  return new Map(all.filter((item) => item.stepKey && item.status === 'completed' && item.goalVersionId === activeGoal(task).id)
    .map((item) => [item.stepKey, item]));
}

function workItemUsesGeneratedEvidence(task, item) {
  if (!item) return false;
  if ((item.tools || []).some((tool) => tool.startsWith('web.'))) return true;
  const resultText = item.result ? JSON.stringify(item.result) : '';
  return (task.materials || []).some((material) => material.generatedEvidence === true
    && (resultText.includes(material.id) || (material.source && resultText.includes(material.source))));
}

function workItemGeneratedEvidenceIsCurrent(task, item) {
  if (!workItemUsesGeneratedEvidence(task, item)) return true;
  const directory = new Map(materialContext(task).directory.map((entry) => [entry.id, entry]));
  const resultText = item.result ? JSON.stringify(item.result) : '';
  return (task.materials || []).some((material) => {
    if (material.generatedEvidence !== true || directory.get(material.id)?.eligible !== true) return false;
    const bindings = Array.isArray(material.evidenceBindings) ? material.evidenceBindings : material.evidenceForWorkItemId ? [{ workItemId: material.evidenceForWorkItemId }] : [];
    if (bindings.some((binding) => binding.workItemId === item.id)) return true;
    return !task.materialApplicability && bindings.length === 0
      && (resultText.includes(material.id) || (material.source && resultText.includes(material.source)));
  });
}

function stationForRole(role, steps) {
  const text = `${role.key} ${role.name} ${role.mission} ${(role.capabilities || []).join(' ')} ${steps.filter((step) => step.role === role.key).map((step) => `${step.kind} ${step.title}`).join(' ')}`.toLowerCase();
  const ownedKinds = new Set(steps.filter((step) => step.role === role.key).map((step) => step.kind));
  if (ownedKinds.has('review')) return 'reviewer';
  if (ownedKinds.has('synthesis')) return 'writer';
  if (ownedKinds.has('research') || ownedKinds.has('analysis')) return 'researcher';
  if (ownedKinds.has('delivery')) return 'steward';
  if (/archive|record|档案|记录/.test(text)) return 'archivist';
  if (/review|audit|审阅/.test(text)) return 'reviewer';
  if (/write|synth|draft|写作|撰写|合成/.test(text)) return 'writer';
  if (/deliver|steward|交付|事务/.test(text)) return 'steward';
  return 'researcher';
}

export function applyModelPlan(task, input, { reason = 'initial_model_plan', preserveCompleted = false } = {}) {
  const goal = activeGoal(task);
  const validated = validateModelPlan(task, input);
  if (task.projectRootTaskId && validated.projectAlignment.status === 'conflict') {
    archiveCurrentPlanForConflict(task);
    event(task, 'project.goal_conflict', `任务目标与项目根目标需要人工对齐：${validated.projectAlignment.explanation}`, {
      rootTaskId: task.projectRootTaskId,
      rootGoalVersionId: task.projectRootGoalVersionId,
      taskGoalVersionId: goal.id,
    });
    setTaskState(task, 'waiting_user', 'coordinator', '任务自身目标与新版项目根目标存在冲突，已停下等待你决定如何对齐。');
    return task.workItems;
  }
  const previousByKey = preserveCompleted ? previousCompletedByKey(task) : new Map();
  if (task.workItems.length) {
    task.workHistory ??= [];
    task.workHistory.push({ archivedAt: new Date().toISOString(), reason, goalVersionId: goal.id, items: structuredClone(task.workItems) });
    task.workHistory = task.workHistory.slice(-20);
  }
  const revision = (task.plan?.revision || 0) + 1;
  const roleMap = new Map();
  const usedStations = new Set();
  const stationOrder = ['researcher', 'writer', 'reviewer', 'steward', 'archivist'];
  const agents = validated.roles.map((role) => {
    const existing = task.team?.agents?.find((agent) => agent.roleKey === role.key && agent.goalVersionId === goal.id);
    const preferred = stationForRole(role, validated.steps);
    const stationRole = existing?.stationRole && !usedStations.has(existing.stationRole)
      ? existing.stationRole
      : [preferred, ...stationOrder].find((station) => !usedStations.has(station)) || null;
    if (stationRole) usedStations.add(stationRole);
    const agent = {
      id: existing?.id || makeId('agent'), roleKey: role.key, name: role.name,
      mission: role.mission, capabilities: role.capabilities, recruitmentReason: role.recruitmentReason,
      status: 'available', goalVersionId: goal.id, joinedAt: existing?.joinedAt || new Date().toISOString(),
      dynamic: true, stationRole, textOnly: stationRole === null,
    };
    roleMap.set(role.key, agent);
    return agent;
  });
  const idByKey = new Map(validated.steps.map((step) => [step.key, makeId('work')]));
  const fingerprintByKey = new Map();
  const applicability = materialContext(task, { includeGeneratedEvidence: false });
  const materialFingerprint = applicability.effectiveMaterials.map((material) => ({
    id: material.id, bytes: material.bytes, createdAt: material.createdAt,
    contentSha256: crypto.createHash('sha256').update(String(material.text || '')).digest('hex'),
  }));
  const instructionFingerprint = task.suggestions.filter((suggestion) => (suggestion.goalVersionId || goal.id) === goal.id && suggestion.classification === 'support' && suggestion.status === 'routed').map((suggestion) => ({ id: suggestion.id, text: suggestion.text }));
  const projectRootGoalVersionId = task.projectRootGoalVersionId || goal.id;
  const projectRootInputFingerprint = task.projectRootInputFingerprint || null;
  const applicabilityFingerprintPart = applicability.policyActive
    ? { materialApplicabilityFingerprint: applicability.fingerprint }
    : {};
  const sourceContextFingerprint = crypto.createHash('sha256').update(JSON.stringify({
    goalVersionId: goal.id, projectRootGoalVersionId, projectRootInputFingerprint,
    ...applicabilityFingerprintPart, materialFingerprint, instructionFingerprint,
  })).digest('hex');
  const fingerprintFor = (step) => {
    if (fingerprintByKey.has(step.key)) return fingerprintByKey.get(step.key);
    const dependencyFingerprints = step.dependsOn.map((key) => fingerprintFor(validated.steps.find((candidate) => candidate.key === key)));
    const value = crypto.createHash('sha256').update(JSON.stringify({
      goalVersionId: goal.id, projectRootGoalVersionId, projectRootInputFingerprint,
      ...applicabilityFingerprintPart, step, materialFingerprint, instructionFingerprint, dependencyFingerprints,
    })).digest('hex');
    fingerprintByKey.set(step.key, value);
    return value;
  };
  const workItems = validated.steps.map((step) => {
    const prior = previousByKey.get(step.key);
    const inputFingerprint = fingerprintFor(step);
    const reused = Boolean(prior && !workItemUsesGeneratedEvidence(task, prior) && prior.kind === step.kind && prior.inputFingerprint === inputFingerprint && !['synthesis', 'review', 'delivery'].includes(step.kind));
    return {
      id: idByKey.get(step.key), stepKey: step.key, title: step.title, kind: step.kind,
      role: step.role, agentId: roleMap.get(step.role).id,
      status: reused ? 'completed' : 'pending', goalVersionId: goal.id,
      projectRootGoalVersionId,
      projectRootInputFingerprint,
      inputMaterialIds: applicability.effectiveMaterials.map((material) => material.id),
      materialApplicabilityFingerprint: applicability.fingerprint,
      inputSuggestionIds: task.suggestions.filter((suggestion) => (suggestion.goalVersionId || goal.id) === goal.id && suggestion.classification === 'support' && suggestion.status === 'routed').map((suggestion) => suggestion.id),
      dependsOn: step.dependsOn.map((key) => idByKey.get(key)), dependencyKeys: step.dependsOn,
      tools: step.tools, acceptanceCriteria: step.acceptanceCriteria, expectedResult: step.expectedResult, webScope: step.webScope,
      inputFingerprint,
      sourceContextFingerprint,
      result: reused ? structuredClone(prior.result) : null, attempts: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      reusedFromWorkItemId: reused ? prior.id : null,
    };
  });
  let invalidated = true;
  while (invalidated) {
    invalidated = false;
    for (const item of workItems) {
      if (!item.reusedFromWorkItemId) continue;
      const dependenciesReused = item.dependsOn.every((id) => workItems.find((candidate) => candidate.id === id)?.reusedFromWorkItemId);
      if (!dependenciesReused) {
        item.status = 'pending'; item.result = null; item.reusedFromWorkItemId = null; invalidated = true;
      }
    }
  }
  for (const item of workItems) {
    if (item.status === 'completed') continue;
    item.status = item.dependsOn.every((id) => workItems.find((candidate) => candidate.id === id)?.status === 'completed') ? 'ready' : 'pending';
  }
  task.workItems = workItems;
  task.team = { revision, goalVersionId: goal.id, projectRootGoalVersionId, projectRootInputFingerprint, agents, formedAt: new Date().toISOString() };
  task.agentSessions ??= [];
  for (const item of workItems) {
    if (item.kind === 'delivery' || item.status === 'completed') continue;
    task.agentSessions.push({
      id: makeId('session'), agentId: item.agentId, roleKey: item.role, workItemId: item.id,
      goalVersionId: goal.id, planRevision: revision, status: 'planned', input: null, output: null,
      projectRootGoalVersionId,
      projectRootInputFingerprint,
      materialApplicabilityFingerprint: applicability.fingerprint,
      runId: null, attemptId: null, toolCalls: [],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
  }
  task.agentSessions = task.agentSessions.slice(-80);
  task.planHistory ??= [];
  if (task.plan) task.planHistory.push(structuredClone(task.plan));
  task.planHistory = task.planHistory.slice(-10);
  task.plan = {
    id: makeId('plan'), revision, source: 'model', goalVersionId: goal.id, summary: validated.summary,
    projectRootGoalVersionId,
    projectRootInputFingerprint,
    materialApplicabilityFingerprint: applicability.fingerprint,
    outputKind: validated.outputKind, deliverables: validated.deliverables, projectAlignment: validated.projectAlignment, roleKeys: validated.roles.map((role) => role.key),
    stepKeys: validated.steps.map((step) => step.key), reason, createdAt: new Date().toISOString(),
  };
  task.type = validated.outputKind || task.type;
  const previouslyCompleted = [...previousByKey.values()].length;
  const reusedCount = workItems.filter((item) => item.reusedFromWorkItemId).length;
  event(task, reason === 'gap_replan' ? 'plan.replanned' : 'plan.model_created',
    reason === 'gap_replan' ? `模型根据实际缺口形成第 ${revision} 版计划；原样复用 ${reusedCount} 项，因契约或依赖变化重算 ${Math.max(0, previouslyCompleted - reusedCount)} 项。` : `模型形成第 ${revision} 版可执行计划，并按能力组建 ${agents.length} 人团队。`,
    { planId: task.plan.id, revision, reusedCount, invalidatedCount: Math.max(0, previouslyCompleted - reusedCount), agentIds: agents.map((agent) => agent.id), workItemIds: workItems.map((item) => item.id) });
  setTaskState(task, 'ready', 'coordinator', `计划 v${revision} 已通过依赖、权限与交付边界校验。`);
  return task.workItems;
}

function archiveCurrentPlanForConflict(task) {
  if (task.workItems.length) {
    task.workHistory ??= [];
    task.workHistory.push({ archivedAt: new Date().toISOString(), reason: 'project_goal_conflict', goalVersionId: activeGoal(task).id, items: structuredClone(task.workItems) });
    task.workHistory = task.workHistory.slice(-20);
  }
  if (task.plan) {
    task.planHistory ??= [];
    task.planHistory.push(structuredClone(task.plan));
    task.planHistory = task.planHistory.slice(-10);
  }
  task.workItems = [];
  task.plan = null;
}

export function readyWorkItems(task) {
  for (const item of task.workItems || []) {
    if (item.status === 'pending' && (item.dependsOn || []).every((id) => task.workItems.find((candidate) => candidate.id === id)?.status === 'completed')) {
      item.status = 'ready';
      item.updatedAt = new Date().toISOString();
    }
  }
  return task.workItems.filter((item) => item.status === 'ready');
}

export function workSession(task, workItemId) {
  return task.agentSessions?.findLast((session) => session.workItemId === workItemId) || null;
}

function workItemMatchesArtifact(task, item, artifact) {
  const goal = activeGoal(task);
  const projectRootGoalVersionId = artifact.projectRootGoalVersionId || (!task.projectRootTaskId ? artifact.goalVersionId : null);
  const projectRootInputFingerprint = artifact.projectRootInputFingerprint || null;
  const itemProjectRootGoalVersionId = item?.projectRootGoalVersionId || (!task.projectRootTaskId ? goal.id : null);
  const itemProjectRootInputFingerprint = item?.projectRootInputFingerprint || null;
  return item?.status === 'completed'
    && item.goalVersionId === artifact.goalVersionId
    && itemProjectRootGoalVersionId === projectRootGoalVersionId
    && itemProjectRootInputFingerprint === projectRootInputFingerprint
    && (item.materialApplicabilityFingerprint ?? null) === (artifact.materialApplicabilityFingerprint ?? null);
}

function completedSessionForArtifact(task, item, artifact, planRevision = null) {
  const session = (task.agentSessions || []).findLast((candidate) => candidate.workItemId === item.id
    && candidate.status === 'completed' && (planRevision === null || candidate.planRevision === planRevision)) || null;
  if (!session) return null;
  const projectRootGoalVersionId = artifact.projectRootGoalVersionId || (!task.projectRootTaskId ? artifact.goalVersionId : null);
  const projectRootInputFingerprint = artifact.projectRootInputFingerprint || null;
  const sessionProjectRootGoalVersionId = session.projectRootGoalVersionId || (!task.projectRootTaskId ? artifact.goalVersionId : null);
  const sessionProjectRootInputFingerprint = session.projectRootInputFingerprint || null;
  if (session.goalVersionId !== artifact.goalVersionId
    || sessionProjectRootGoalVersionId !== projectRootGoalVersionId
    || sessionProjectRootInputFingerprint !== projectRootInputFingerprint
    || (session.materialApplicabilityFingerprint ?? null) !== (artifact.materialApplicabilityFingerprint ?? null)) return null;
  return session;
}

export function candidateDependencyEvidence(task, artifact) {
  if (!artifact || !artifactInputIsCurrent(task, artifact)) return [];
  const snapshots = [
    { items: task.workItems || [], archived: false },
    ...(task.workHistory || []).slice().reverse().map((entry) => ({ items: entry.items || [], archived: true })),
  ];
  const chain = snapshots.find((snapshot) => snapshot.items.some((item) => item.kind === 'synthesis'
    && item.result?.artifactId === artifact.id && workItemMatchesArtifact(task, item, artifact))) || snapshots[0];
  const chainItems = chain.items;
  const chainById = new Map(chainItems.map((item) => [item.id, item]));
  const synthesis = chainItems.find((item) => item.kind === 'synthesis'
    && item.result?.artifactId === artifact.id && workItemMatchesArtifact(task, item, artifact)) || null;
  const synthesisSession = synthesis ? completedSessionForArtifact(task, synthesis, artifact) : null;
  const planRevision = synthesisSession?.planRevision ?? null;
  const dependencyIds = new Set();
  const collectDependencies = (item) => {
    for (const dependencyId of item?.dependsOn || []) {
      if (dependencyIds.has(dependencyId)) continue;
      dependencyIds.add(dependencyId);
      collectDependencies(chainById.get(dependencyId));
    }
  };
  if (synthesis) collectDependencies(synthesis);
  else for (const workItemId of artifact.workResultIds || []) dependencyIds.add(workItemId);
  const artifactResultIds = new Set(artifact.workResultIds || []);
  return [...dependencyIds]
    .map((workItemId) => chainById.get(workItemId))
    .filter((item) => artifactResultIds.has(item?.id)
      && (['research', 'analysis'].includes(item?.kind) || (!task.plan?.source && !item?.kind))
      && item.result
      && workItemMatchesArtifact(task, item, artifact)
      && (!synthesis || item.sourceContextFingerprint === synthesis.sourceContextFingerprint)
      && (!chain.archived || !workItemUsesGeneratedEvidence(task, item))
      && workItemGeneratedEvidenceIsCurrent(task, item))
    .map((item) => {
      const session = completedSessionForArtifact(task, item, artifact, planRevision);
      return {
        workItemId: item.id,
        stepKey: item.stepKey || null,
        kind: item.kind,
        role: item.role,
        title: item.title,
        result: structuredClone(item.result),
        sessionId: session?.id || null,
        successfulToolCalls: (session?.toolCalls || []).filter((call) => call.ok === true).map((call) => structuredClone(call)),
      };
    });
}

export function validateWorkResult(item, result, { toolCalls = [] } = {}) {
  const requests = Array.isArray(result?.toolRequests) ? result.toolRequests : [];
  const output = clean(result?.output, 1_500_000);
  const gap = clean(result?.gap, 2_000);
  const caveats = cleanList(result?.caveats, 20, 1_000);
  if (requests.length) {
    if (output || gap || caveats.length || (result.acceptanceChecks || []).length || (result.deliverables || []).length) throw new Error('工具请求阶段不能同时提交最终结果、交付物、缺口、限制说明或验收结论。');
    return { stage: 'tools', requests };
  }
  if (!output) throw new Error('工作项没有可检查的最终结果。');
  if (gap) throw Object.assign(new Error(gap), { code: 'work_gap' });
  const discovered = toolCalls.some((call) => call.tool === 'web.search' && call.ok && (call.result?.sources || []).length > 0);
  const readOriginal = toolCalls.some((call) => call.tool === 'web.read' && call.ok && (call.sources || []).some((source) => String(source).startsWith('material:')));
  if (discovered && !readOriginal) throw new Error('公开搜索只发现了候选网址，还没有读取原站正文。请先用 web.read 读取至少一个允许的候选 URL，再形成研究结果。');
  const checks = Array.isArray(result.acceptanceChecks) ? result.acceptanceChecks : [];
  if (checks.length !== item.acceptanceCriteria.length) throw new Error('工作结果没有逐条覆盖当前步骤的验收标准。');
  for (const criterion of item.acceptanceCriteria) {
    const check = checks.find((candidate) => clean(candidate.criterion, 500) === criterion);
    if (!check || check.passed !== true || !clean(check.evidence, 1_000)) throw new Error(`工作结果未满足验收标准：${criterion}`);
  }
  return { stage: 'final', output, checks, caveats };
}

export function sessionInput(task, item, toolResults = [], memories = []) {
  const applicability = materialContext(task);
  const dependencies = (item.dependsOn || []).map((id) => task.workItems.find((candidate) => candidate.id === id)).filter(Boolean)
    .map((candidate) => ({ stepKey: candidate.stepKey, title: candidate.title, role: candidate.role, result: candidate.result }));
  const priorSameStep = (task.workHistory || []).flatMap((entry) => entry.items || [])
    .filter((candidate) => candidate.status === 'completed' && candidate.result && candidate.goalVersionId === activeGoal(task).id && candidate.sourceContextFingerprint === item.sourceContextFingerprint)
    .filter((candidate) => !workItemUsesGeneratedEvidence(task, candidate))
    .filter((candidate) => candidate.stepKey === item.stepKey)
    .at(-1);
  const historicalCompletedEvidence = priorSameStep ? [{
      stepKey: priorSameStep.stepKey, title: priorSameStep.title, kind: priorSameStep.kind, role: priorSameStep.role,
      expectedResult: priorSameStep.expectedResult, acceptanceCriteria: priorSameStep.acceptanceCriteria,
      inputFingerprint: priorSameStep.inputFingerprint, sourceContextFingerprint: priorSameStep.sourceContextFingerprint,
      result: { ...priorSameStep.result, output: typeof priorSameStep.result.output === 'string' ? priorSameStep.result.output.slice(0, 12_000) : priorSameStep.result.output, deliverables: undefined },
    }] : [];
  const candidateArtifact = item.kind === 'review'
    ? task.artifacts.filter((artifact) => artifact.goalVersionId === activeGoal(task).id).at(-1) || null
    : null;
  return {
    goalVersionId: activeGoal(task).id, goal: activeGoal(task).statement,
    projectRootGoalVersionId: task.projectRootGoalVersionId || activeGoal(task).id,
    projectRootInputFingerprint: task.projectRootInputFingerprint || null,
    successCriteria: activeGoal(task).successCriteria, boundaries: activeGoal(task).boundaries,
    continuity: deriveTaskContinuity(task),
    linkedTaskContext: task.linkedTaskContext || null,
    workItem: { stepKey: item.stepKey, title: item.title, kind: item.kind, role: item.role, expectedResult: item.expectedResult, acceptanceCriteria: item.acceptanceCriteria, allowedTools: item.tools || [], webScope: item.webScope || null },
    materialApplicability: { fingerprint: applicability.fingerprint, blockingDecisions: applicability.blockingDecisions },
    materialDirectory: applicability.directory,
    dependencies, historicalCompletedEvidence,
    candidateArtifact: candidateArtifact ? {
      id: candidateArtifact.id, version: candidateArtifact.version, title: candidateArtifact.title,
      summary: candidateArtifact.summary, content: candidateArtifact.content, caveats: candidateArtifact.caveats || [],
      sources: candidateArtifact.sources, claims: candidateArtifact.claims, derivations: candidateArtifact.derivations || [],
      deliverables: candidateArtifact.deliverables || [],
      nativeFiles: (candidateArtifact.nativeFiles || []).map((file) => ({ kind: file.kind, format: file.format, filename: file.filename, status: file.status, sha256: file.sha256, contentSha256: file.contentSha256, bytes: file.bytes, previewCount: file.previewPaths?.length || 0, error: file.error || null })),
    } : null,
    toolResults, memories,
    instructions: task.suggestions.filter((suggestion) => item.inputSuggestionIds?.includes(suggestion.id)).map((suggestion) => ({ id: suggestion.id, text: suggestion.text })),
  };
}

export function markSession(task, workItemId, status, patch = {}) {
  const session = workSession(task, workItemId);
  if (!session) return null;
  Object.assign(session, patch, { status, updatedAt: new Date().toISOString() });
  return session;
}

export function assertSessionFresh(task, session, { runId = null, attemptId = null } = {}) {
  const projectRootGoalVersionId = task.projectRootGoalVersionId || activeGoal(task).id;
  const sessionProjectGoalVersionId = session?.projectRootGoalVersionId || (!task.projectRootTaskId ? projectRootGoalVersionId : null);
  const projectRootInputFingerprint = task.projectRootInputFingerprint || null;
  const sessionProjectInputFingerprint = session?.projectRootInputFingerprint || (!task.projectRootTaskId ? projectRootInputFingerprint : null);
  if (!session || session.goalVersionId !== activeGoal(task).id || sessionProjectGoalVersionId !== projectRootGoalVersionId
    || sessionProjectInputFingerprint !== projectRootInputFingerprint || session.planRevision !== task.plan?.revision
    || (session.materialApplicabilityFingerprint ?? null) !== materialContext(task, { includeGeneratedEvidence: false }).fingerprint) {
    const error = new Error('代理会话属于旧目标或旧计划，结果已拒绝写入。');
    error.code = 'stale_result';
    throw error;
  }
  if ((runId && task.execution?.id !== runId) || (runId && session.runId !== runId) || (attemptId && session.attemptId !== attemptId)) {
    const error = new Error('代理结果属于旧运行或旧尝试，结果已拒绝写入。');
    error.code = 'stale_result';
    throw error;
  }
}

export function planFingerprint(task) {
  return crypto.createHash('sha256').update(JSON.stringify({ goal: activeGoal(task), plan: task.plan, work: task.workItems.map((item) => ({ key: item.stepKey, status: item.status, result: item.result })) })).digest('hex');
}

export const __test = { SAFE_TOOL_NAMES, VALID_KINDS, assertAcyclic, workItemUsesGeneratedEvidence };
