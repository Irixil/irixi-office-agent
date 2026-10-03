import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { groundingChecks } from './execution.mjs';
import {
  applicabilityFingerprintMatches,
  assertNoCriticalMaterialDecision,
  ensureMaterialPolicy,
  materialContext,
  registerAddedMaterial,
} from './material-applicability.mjs';
import {
  assertProjectArtifactCurrent,
  projectArtifactIsCurrent,
  projectCandidateFingerprint,
  publicProjectWorkspace,
} from './project-workspace.mjs';

const VALID_TASK_TYPES = new Set(['general', 'document', 'research', 'spreadsheet', 'presentation', 'email', 'calendar', 'project']);
const VALID_SUGGESTIONS = new Set(['support', 'replace', 'deviate', 'unclear']);
const SAFE_ID = /^[a-z0-9][a-z0-9-]{5,80}$/;

export const now = () => new Date().toISOString();
export const makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function cleanText(value, limit = 50_000) {
  return String(value ?? '').replaceAll('\u0000', '').trim().slice(0, limit);
}

function cleanList(value, limit = 12) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/);
  return list.map((item) => cleanText(item, 500)).filter(Boolean).slice(0, limit);
}

export function currentInstructionIds(task) {
  const goal = activeGoal(task);
  return (task.suggestions || [])
    .filter((item) => (item.goalVersionId || goal.id) === goal.id && item.classification === 'support' && item.status === 'routed')
    .map((item) => item.id);
}

export function projectRootId(task) {
  return task.projectRootTaskId || task.id;
}

export function projectInputFingerprint(task) {
  return crypto.createHash('sha256').update(JSON.stringify({
    goalVersionId: activeGoal(task).id,
    instructionIds: currentInstructionIds(task).slice().sort(),
  })).digest('hex');
}

function archiveCurrentPlan(task, reason) {
  if (task.workItems?.length) {
    task.workHistory ??= [];
    task.workHistory.push({ archivedAt: now(), reason, goalVersionId: activeGoal(task).id, items: structuredClone(task.workItems) });
    task.workHistory = task.workHistory.slice(-20);
  }
  if (task.plan) {
    task.planHistory ??= [];
    task.planHistory.push(structuredClone(task.plan));
    task.planHistory = task.planHistory.slice(-10);
  }
}

export function invalidateCurrentWork(task, reason, message) {
  archiveCurrentPlan(task, reason);
  if (task.projectWorkspace) {
    if (task.projectWorkspace.candidate?.status === 'ready') task.projectWorkspace.candidate.status = 'historical';
    task.projectWorkspace.status = 'reauthorization_required';
    task.projectWorkspace.reason = '目标、材料、项目关联或已接受交代已变化，请重新明确授权当前代码工作区。';
  }
  for (const item of task.workItems || []) if (!['completed', 'cancelled', 'stale'].includes(item.status)) item.status = 'stale';
  for (const session of task.agentSessions || []) {
    if (session.goalVersionId === activeGoal(task).id && !['completed', 'cancelled', 'stale'].includes(session.status)) session.status = 'stale';
  }
  for (const artifact of task.artifacts || []) {
    if (artifact.goalVersionId !== activeGoal(task).id || artifact.status !== 'candidate') continue;
    artifact.status = 'superseded_candidate';
    artifact.reviewStatus = 'stale_input';
  }
  if (task.execution && !['completed', 'cancelled'].includes(task.execution.phase)) {
    task.executionHistory ??= [];
    task.execution.phase = 'cancelled';
    task.execution.stopReason = reason;
    task.execution.updatedAt = now();
    task.executionHistory.push(structuredClone(task.execution));
    task.executionHistory = task.executionHistory.slice(-20);
    task.execution = null;
  }
  task.workItems = [];
  task.plan = null;
  setTaskState(task, 'idle', 'coordinator', message);
}

function pauseForGoalDecision(task) {
  for (const item of task.workItems || []) if (['running', 'ready', 'pending'].includes(item.status)) item.status = 'stale';
  for (const session of task.agentSessions || []) if (['planned', 'running'].includes(session.status)) session.status = 'stale';
  if (task.execution && !['completed', 'cancelled'].includes(task.execution.phase)) {
    task.executionHistory ??= [];
    task.execution.phase = 'cancelled';
    task.execution.stopReason = 'goal_replacement_waiting';
    task.execution.updatedAt = now();
    task.executionHistory.push(structuredClone(task.execution));
    task.executionHistory = task.executionHistory.slice(-20);
    task.execution = null;
  }
}

export function event(task, type, message, detail = {}) {
  const item = { id: makeId('event'), at: now(), type, message: cleanText(message, 500), detail };
  task.events ??= [];
  task.events.push(item);
  task.events = task.events.slice(-500);
  task.updatedAt = item.at;
  return item;
}

export function createTask(input = {}) {
  const statement = cleanText(input.goal, 4_000);
  if (!statement) throw new Error('请先写下这项工作的最终目标。');
  const type = VALID_TASK_TYPES.has(input.type) ? input.type : 'general';
  const createdAt = now();
  const goalVersion = {
    id: makeId('goal'),
    version: 1,
    statement,
    successCriteria: cleanList(input.successCriteria),
    boundaries: cleanList(input.boundaries),
    status: 'active',
    acceptedAt: createdAt,
    createdAt,
  };
  const task = {
    id: makeId('task'),
    title: cleanText(input.title, 160) || statement.slice(0, 42),
    type,
    status: 'idle',
    activeRole: 'coordinator',
    provider: type === 'project' || input.provider === 'codex-cli' ? 'codex-cli' : 'demo',
    goal: { activeVersionId: goalVersion.id, versions: [goalVersion] },
    projectRootTaskId: null,
    projectRootGoalVersionId: goalVersion.id,
    projectRootInputFingerprint: crypto.createHash('sha256').update(JSON.stringify({ goalVersionId: goalVersion.id, instructionIds: [] })).digest('hex'),
    materials: [],
    suggestions: [],
    workItems: [],
    artifacts: [],
    reviews: [],
    approvals: [],
    workHistory: [],
    plan: null,
    planHistory: [],
    team: null,
    agentSessions: [],
    memoryPolicy: input.memoryPolicy === 'workspace-confirmed' ? 'workspace-confirmed' : 'task-only',
    memoryEntries: [],
    conversationQueue: [],
    execution: null,
    executionHistory: [],
    events: [],
    createdAt,
    updatedAt: createdAt,
  };
  event(task, 'task.created', '任务已建立，目标版本 v1 开始生效。', { goalVersionId: goalVersion.id });
  return task;
}

export function activeGoal(task) {
  return task.goal.versions.find((item) => item.id === task.goal.activeVersionId);
}

export function setTaskState(task, status, role = task.activeRole, message = '') {
  task.status = status;
  task.activeRole = role;
  event(task, 'task.state', message || `任务状态变为 ${status}。`, { status, role });
}

export function classifySuggestion(text) {
  const value = cleanText(text, 2_000);
  if (!value) throw new Error('建议不能为空。');
  if (/(替换(?:最终)?目标|换个目标|(?:最终)?目标.{0,12}(?:改成|改为|换成|替换为)|取消原目标|不再.+而(?:改为)?|instead|replace)/i.test(value)) return 'replace';
  if (/(修改要求|改稿|退回|新版本|下一版|下版|缩短正文|正文.{0,16}字|把标题|标题.{0,8}改成|不改变(?:最终)?目标|(?:最终)?目标保持不变)/i.test(value)) return 'support';
  if (/(以后|顺便|另一个|先记着|无关|later|backlog)/i.test(value)) return 'deviate';
  if (/(要不要|也许|可能|不确定|是否|unclear|maybe)/i.test(value)) return 'unclear';
  return 'support';
}

export function addSuggestion(task, input = {}) {
  const text = cleanText(input.text, 2_000);
  const classification = VALID_SUGGESTIONS.has(input.classification)
    ? input.classification
    : classifySuggestion(text);
  const suggestion = {
    id: makeId('suggestion'),
    text,
    goalVersionId: activeGoal(task).id,
    classification,
    status: classification === 'replace' ? 'waiting_user' : classification === 'deviate' ? 'later' : 'routed',
    createdAt: now(),
    correctedAt: null,
  };
  task.suggestions.push(suggestion);
  if (classification === 'replace') {
    pauseForGoalDecision(task);
    setTaskState(task, 'waiting_user', 'coordinator', '发现可能替代当前目标的建议，已暂停受影响工作。');
  } else {
    if (classification === 'support' && (task.projectWorkspace || task.plan || task.workItems?.length)) invalidateCurrentWork(task, 'accepted_instruction_changed', '已接受新的工作交代；旧计划、代码工作区授权与在途结果已失效，需要按当前输入重新规划。');
    else event(task, 'suggestion.routed', `建议已归入“${classification}”。`, { suggestionId: suggestion.id, classification });
  }
  return suggestion;
}

export function correctSuggestion(task, suggestionId, classification) {
  if (!VALID_SUGGESTIONS.has(classification)) throw new Error('未知的建议分类。');
  const suggestion = task.suggestions.find((item) => item.id === suggestionId);
  if (!suggestion) throw new Error('找不到这条建议。');
  suggestion.goalVersionId ??= activeGoal(task).id;
  if (suggestion.goalVersionId !== activeGoal(task).id) throw new Error('历史目标下的工作交代不能直接带入当前目标；请在当前目标下重新记录。');
  if (suggestion.status === 'accepted') throw new Error('已确认并进入目标历史的建议不能重新分类。');
  const previous = suggestion.classification;
  suggestion.classification = classification;
  suggestion.status = classification === 'replace' ? 'waiting_user' : classification === 'deviate' ? 'later' : 'routed';
  suggestion.correctedAt = now();
  event(task, 'suggestion.corrected', `建议分类从“${previous}”改为“${classification}”，计划需要重新核对。`, {
    suggestionId,
    previous,
    classification,
  });
  if (classification === 'replace') {
    if (classification !== previous && previous === 'support' && (task.projectWorkspace || task.plan || task.workItems?.length)) invalidateCurrentWork(task, 'accepted_instruction_changed', '已接受的工作交代发生变化；旧计划与代码工作区授权已失效，需要重新规划。');
    pauseForGoalDecision(task);
    setTaskState(task, 'waiting_user', 'coordinator', '发现可能替代当前目标的建议，已暂停受影响工作。');
  } else if (classification !== previous && (classification === 'support' || previous === 'support') && (task.projectWorkspace || task.plan || task.workItems?.length)) {
    invalidateCurrentWork(task, 'accepted_instruction_changed', '已接受的工作交代发生变化；旧计划与在途结果已失效，需要重新规划。');
  }
  else if (previous === 'replace' && !task.suggestions.some((item) => item.id !== suggestionId && item.classification === 'replace' && item.status === 'waiting_user')) {
    setTaskState(task, task.workItems.length ? 'ready' : 'idle', 'coordinator', '替代目标警报已解除；当前目标继续有效，计划需要重新核对。');
  }
  return suggestion;
}

export function acceptGoalReplacement(task, suggestionId, input = {}) {
  const suggestion = task.suggestions.find((item) => item.id === suggestionId);
  if (!suggestion || suggestion.classification !== 'replace' || suggestion.status !== 'waiting_user') throw new Error('这不是当前待确认的替代目标，不能重复或跨历史确认。');
  const current = activeGoal(task);
  if ((suggestion.goalVersionId || current.id) !== current.id) throw new Error('这条替代建议属于历史目标，不能改变当前目标。');
  const nextStatement = cleanText(input.statement, 4_000);
  const nextSuccessCriteria = cleanList(input.successCriteria);
  const nextBoundaries = cleanList(input.boundaries);
  if (!nextStatement) throw new Error('请明确填写新目标。');
  if (!nextSuccessCriteria.length) throw new Error('请明确填写新目标的成功条件；不会自动继承旧条件。');
  if (!nextBoundaries.length) throw new Error('请明确填写新目标的工作边界；不会自动继承旧边界。');
  ensureMaterialPolicy(task, 'goal_replaced');
  if (task.projectWorkspace) invalidateCurrentWork(task, 'goal_replaced', '新目标已接受；旧代码工作区授权、计划与候选已失效，需要按完整新输入重新授权。');
  for (const item of task.events || []) {
    if (!item.type?.startsWith('conversation.') || item.detail?.goalVersionId) continue;
    item.detail ??= {};
    item.detail.archivedGoalVersionId = current.id;
    item.detail.legacyScope = 'archived_on_goal_replacement';
  }
  for (const item of task.suggestions) {
    item.goalVersionId ??= current.id;
    if (item.id !== suggestionId && item.goalVersionId === current.id && item.status === 'routed') item.status = 'superseded';
  }
  current.status = 'superseded';
  const version = {
    id: makeId('goal'),
    version: task.goal.versions.length + 1,
    statement: nextStatement,
    successCriteria: nextSuccessCriteria,
    boundaries: nextBoundaries,
    status: 'active',
    acceptedAt: now(),
    createdAt: now(),
    predecessorId: current.id,
  };
  task.goal.versions.push(version);
  task.goal.activeVersionId = version.id;
  if (projectRootId(task) === task.id) {
    task.projectRootGoalVersionId = version.id;
    task.projectRootInputFingerprint = projectInputFingerprint(task);
  }
  suggestion.status = 'accepted';
  if (task.workItems.length) {
    task.workHistory ??= [];
    task.workHistory.push({ archivedAt: now(), reason: 'goal_replaced', goalVersionId: current.id, items: structuredClone(task.workItems) });
    task.workHistory = task.workHistory.slice(-20);
  }
  if (task.execution && !['completed', 'cancelled'].includes(task.execution.phase)) {
    task.execution.phase = 'cancelled';
    task.execution.stopReason = 'goal_replaced';
    task.execution.updatedAt = now();
  }
  task.workItems = [];
  setTaskState(task, 'idle', 'coordinator', `新目标 v${version.version} 已接受，旧计划已作废。`);
  return version;
}

export function addMaterial(task, input = {}) {
  const text = cleanText(input.text, 1_500_000);
  const readyUserMaterial = input.status !== 'failed' && input.generatedEvidence !== true;
  if (readyUserMaterial) ensureMaterialPolicy(task, 'ready_material_added');
  const material = {
    id: makeId('material'),
    name: cleanText(input.name, 200) || '未命名材料',
    kind: cleanText(input.kind, 40) || 'text',
    source: cleanText(input.source, 1_000) || 'user',
    status: input.status === 'failed' ? 'failed' : 'ready',
    text,
    error: cleanText(input.error, 500),
    bytes: Number(input.bytes || Buffer.byteLength(text)),
    createdAt: now(),
  };
  if (input.generatedEvidence === true) material.generatedEvidence = true;
  task.materials.push(material);
  if (readyUserMaterial) registerAddedMaterial(task, material);
  event(task, 'material.added', `${material.name} 已进入材料账本。`, { materialId: material.id, status: material.status });
  if (readyUserMaterial && (task.projectWorkspace || task.plan || task.workItems?.length || task.artifacts?.some((artifact) => ['candidate', 'confirmed'].includes(artifact.status)))) {
    invalidateCurrentWork(task, 'material_input_changed', '材料输入已变化；旧计划、在途结果和候选资格已失效，需要按当前材料重新规划。');
  }
  return material;
}

export function buildPlan(task) {
  const goal = activeGoal(task);
  const applicable = materialContext(task, { includeGeneratedEvidence: false }).effectiveMaterials;
  const needsResearch = task.type === 'research' || applicable.length > 1 || applicable.some((item) => item.kind === 'url');
  const definitions = [
    ...(needsResearch ? [['researcher', '整理并核对选定材料', '带材料 ID、行号和原文的研究结果']] : []),
    ['writer', task.type === 'email' ? '起草邮件' : task.type === 'calendar' ? '起草日程' : task.type === 'spreadsheet' ? '起草表格候选数据' : task.type === 'presentation' ? '起草演示稿候选内容' : '起草候选成果', '绑定研究结果与来源的候选成果'],
    ['reviewer', '独立核对目标、事实来源与边界', '逐项审阅结果'],
    ['steward', '准备指定版本的正式交付', '等待用户确认'],
  ];
  if (task.workItems.length) {
    task.workHistory ??= [];
    task.workHistory.push({ archivedAt: now(), reason: 'plan_rebuilt', goalVersionId: task.workItems[0]?.goalVersionId, items: structuredClone(task.workItems) });
    task.workHistory = task.workHistory.slice(-20);
  }
  task.workItems = definitions.map(([role, title, expected], index) => {
    const item = {
      id: makeId('work'),
      title,
      role,
      status: index === 0 ? 'ready' : 'pending',
      goalVersionId: goal.id,
      projectRootGoalVersionId: task.projectRootGoalVersionId || goal.id,
      projectRootInputFingerprint: task.projectRootInputFingerprint || projectInputFingerprint(task),
      materialApplicabilityFingerprint: materialContext(task, { includeGeneratedEvidence: false }).fingerprint,
      inputMaterialIds: applicable.map((material) => material.id),
      inputSuggestionIds: task.suggestions.filter((suggestion) => (suggestion.goalVersionId || goal.id) === goal.id && suggestion.classification === 'support' && suggestion.status === 'routed').map((suggestion) => suggestion.id),
      dependsOn: [],
      expectedResult: expected,
      result: null,
      attempts: [],
      createdAt: now(),
      updatedAt: now(),
    };
    return item;
  });
  for (let index = 1; index < task.workItems.length; index += 1) task.workItems[index].dependsOn = [task.workItems[index - 1].id];
  setTaskState(task, 'ready', 'coordinator', `已形成 ${task.workItems.length} 个可检查步骤。`);
  return task.workItems;
}

export function createArtifact(task, result, provider, expectedGoalVersionId = activeGoal(task).id) {
  const goal = activeGoal(task);
  if (goal.id !== expectedGoalVersionId) throw new Error('候选成果属于旧目标版本，已拒绝写入当前结果。');
  assertNoCriticalMaterialDecision(task, '候选成果');
  const version = task.artifacts.length + 1;
  for (const item of task.artifacts) if (item.status === 'candidate') item.status = 'superseded_candidate';
  const artifact = {
    id: makeId('artifact'),
    logicalId: task.artifacts[0]?.logicalId || makeId('deliverable'),
    version,
    type: task.type,
    title: cleanText(result.title, 200) || `${task.title} v${version}`,
    summary: cleanText(result.summary, 2_000),
    content: cleanText(result.content, 1_500_000),
    sources: Array.isArray(result.sources) ? result.sources.map((item) => cleanText(item, 500)).filter(Boolean) : [],
    claims: Array.isArray(result.claims) ? result.claims.map((item) => ({
      statement: cleanText(item.statement, 1_000),
      materialId: cleanText(item.materialId, 120),
      sourceName: cleanText(item.sourceName, 200),
      locator: cleanText(item.locator, 80),
      quote: cleanText(item.quote, 2_000),
    })).filter((item) => item.statement && item.materialId && item.locator && item.quote) : [],
    derivations: Array.isArray(result.derivations) ? structuredClone(result.derivations).slice(0, 50) : [],
    caveats: Array.isArray(result.caveats) ? result.caveats.map((item) => cleanText(item, 1_000)).filter(Boolean).slice(0, 20) : [],
    deliverables: Array.isArray(result.deliverables) ? result.deliverables.map((entry) => ({
      kind: cleanText(entry.kind, 40), title: cleanText(entry.title, 200), content: cleanText(entry.content, 1_500_000),
    })).filter((entry) => entry.kind && entry.content) : [],
    nativeFiles: [],
    ...(task.type === 'project' && result.projectCandidate ? { projectCandidate: structuredClone(result.projectCandidate) } : {}),
    provider,
    createdByRole: provider === 'human-edit' ? 'user' : 'writer',
    goalVersionId: goal.id,
    projectRootGoalVersionId: task.projectRootGoalVersionId || (projectRootId(task) === task.id ? goal.id : null),
    projectRootInputFingerprint: task.projectRootInputFingerprint || (projectRootId(task) === task.id ? projectInputFingerprint(task) : null),
    materialApplicabilityFingerprint: materialContext(task, { includeGeneratedEvidence: false }).fingerprint,
    workResultIds: task.workItems.filter((item) => item.status === 'completed' && item.result).map((item) => item.id),
    instructionIds: task.suggestions.filter((item) => (item.goalVersionId || goal.id) === goal.id && item.classification === 'support' && item.status === 'routed').map((item) => item.id),
    status: 'candidate',
    reviewStatus: 'pending',
    previousId: task.artifacts.filter((item) => item.goalVersionId === goal.id).at(-1)?.id || null,
    createdAt: now(),
  };
  if (!artifact.content) throw new Error('提供者没有返回可用的候选内容。');
  if (task.type === 'project' && !artifact.projectCandidate) throw new Error('代码候选缺少宿主生成的真实 diff 与固定检查证据。');
  task.artifacts.push(artifact);
  event(task, 'artifact.created', `候选成果 v${version} 已生成。`, { artifactId: artifact.id, provider });
  return artifact;
}

export function reviseArtifact(task, artifactId, input = {}) {
  const base = task.artifacts.find((item) => item.id === artifactId);
  if (!base) throw new Error('找不到要修改的候选版本。');
  if (base.goalVersionId !== activeGoal(task).id) throw new Error('旧目标下的成果不能直接改成当前目标成果。');
  assertArtifactInputCurrent(task, base);
  if (!['candidate', 'confirmed'].includes(base.status)) throw new Error('只有当前有效候选或已确认版本可以保存人工修改。');
  if (task.type === 'project') throw new Error('代码候选不能用正文编辑器覆盖；请提交修改要求并重新运行受控工作区流程。');
  const baseDeliverables = base.deliverables || [];
  if (baseDeliverables.length > 1) throw new Error('这个候选包含多份交付物，请在同事对话中提交修改要求后重新运行，以免覆盖其他交付物。');
  const onlyDeliverable = baseDeliverables[0] || null;
  if (onlyDeliverable && ['spreadsheet', 'presentation'].includes(onlyDeliverable.kind)) {
    throw new Error('电子表格或演示文稿是结构化成果，不能用概要文本覆盖。请在同事对话中提交修改要求后重新运行。');
  }
  if (onlyDeliverable && onlyDeliverable.kind !== 'document' && onlyDeliverable.content !== base.content) {
    throw new Error('这份成果的概要与真正交付内容不同，不能从概要编辑器覆盖原内容。请在同事对话中提交修改要求。');
  }
  const content = cleanText(input.content, 1_500_000);
  const deliverables = baseDeliverables.map((entry) => ({ ...entry, content }));
  return createArtifact(task, {
    title: input.title || base.title,
    summary: input.summary || `基于 v${base.version} 的人工修改`,
    content,
    sources: base.sources,
    claims: base.claims,
    deliverables,
    derivations: base.derivations,
  }, 'human-edit');
}

export function recordReview(task, artifactId, result, { projectReviewFacts = null } = {}) {
  const artifact = task.artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw new Error('找不到要核对的候选成果。');
  assertArtifactInputCurrent(task, artifact);
  assertNoCriticalMaterialDecision(task, '独立审阅');
  const providedChecks = Array.isArray(result.checks) ? result.checks.map((item) => ({
    name: cleanText(item.name, 120),
    passed: Boolean(item.passed),
    evidence: cleanText(item.evidence, 1_000),
    blocking: item.blocking !== false,
  })) : [];
  const requiredCoverage = [
    ['目标符合度', /目标|goal/i],
    ...(task.projectRootTaskId ? [['项目根目标符合度', /项目.{0,4}目标|root goal/i]] : []),
    ['完整性', /完整|complete/i],
    ['来源核对', /来源|事实|source|fact/i],
    ['边界遵守', /边界|权限|boundary|permission/i],
    ['文件可用性', /文件|可用|file|usable/i],
  ];
  const missingCoverage = requiredCoverage.filter(([, pattern]) => !providedChecks.some((item) => pattern.test(item.name)));
  const claimChecks = Array.isArray(result.claimChecks) ? result.claimChecks.map((item) => ({
    claimIndex: Number.isInteger(item.claimIndex) ? item.claimIndex : -1,
    materialId: cleanText(item.materialId, 120),
    locator: cleanText(item.locator, 80),
    verdict: ['supported', 'unsupported', 'uncertain'].includes(item.verdict) ? item.verdict : 'invalid',
    evidence: cleanText(item.evidence, 1_000),
  })) : [];
  const claimProblems = [];
  const seenClaimIndexes = new Set();
  for (const item of claimChecks) {
    const claim = artifact.claims[item.claimIndex];
    if (!claim) claimProblems.push(`claimIndex ${item.claimIndex} 无效`);
    else {
      if (seenClaimIndexes.has(item.claimIndex)) claimProblems.push(`第 ${item.claimIndex + 1} 条结论被重复审阅`);
      if (item.materialId !== claim.materialId || item.locator !== claim.locator) claimProblems.push(`第 ${item.claimIndex + 1} 条审阅未绑定原结论的材料和行号`);
      if (!item.evidence) claimProblems.push(`第 ${item.claimIndex + 1} 条审阅缺少证据说明`);
      if (item.verdict !== 'supported') claimProblems.push(`第 ${item.claimIndex + 1} 条为 ${item.verdict}：${item.evidence || '无说明'}`);
      seenClaimIndexes.add(item.claimIndex);
    }
  }
  for (let index = 0; index < artifact.claims.length; index += 1) {
    if (!seenClaimIndexes.has(index)) claimProblems.push(`缺少第 ${index + 1} 条结论的语义审阅`);
  }
  const deterministicChecks = [
    {
      name: '目标版本守卫',
      passed: artifact.goalVersionId === activeGoal(task).id,
      evidence: artifact.goalVersionId === activeGoal(task).id ? '候选成果绑定当前目标版本。' : '候选成果绑定旧目标版本。',
      blocking: true,
    },
    {
      name: '代码候选宿主证据守卫',
      passed: task.type !== 'project' || projectArtifactIsCurrent(task, artifact)
        && artifact.projectCandidate.changes?.length > 0
        && artifact.projectCandidate.checks?.some((entry) => entry.passed && entry.candidateSha256 === artifact.projectCandidate.candidateSha256),
      evidence: task.type !== 'project'
        ? '这个候选不是代码项目。'
        : projectArtifactIsCurrent(task, artifact)
          ? '宿主记录的当前 source、candidate、diff、固定检查与任务输入一致。'
          : '代码候选已不匹配当前工作区或任务输入。',
      blocking: true,
    },
    {
      name: '原生文件可用性守卫',
      passed: (artifact.deliverables || []).filter((entry) => ['document', 'spreadsheet', 'presentation'].includes(entry.kind))
        .every((entry) => artifact.nativeFiles?.some((file) => file.kind === entry.kind && file.status === 'ready')),
      evidence: (artifact.deliverables || []).some((entry) => ['document', 'spreadsheet', 'presentation'].includes(entry.kind))
        ? `${(artifact.nativeFiles || []).filter((file) => file.status === 'ready').map((file) => file.filename).join('、') || '未生成'}；候选阶段已实际生成并渲染检查。`
        : '这个候选成果不要求 DOCX、XLSX 或 PPTX 原生文件。',
      blocking: true,
    },
    {
      name: '审阅覆盖守卫',
      passed: missingCoverage.length === 0,
      evidence: missingCoverage.length ? `审阅缺少：${missingCoverage.map(([name]) => name).join('、')}` : '审阅覆盖目标、完整性、来源、边界和文件可用性。',
      blocking: true,
    },
    {
      name: '逐条事实语义审阅',
      passed: claimProblems.length === 0,
      evidence: artifact.claims.length === 0
        ? '候选没有结构化事实声明。'
        : claimProblems.length === 0
          ? `${artifact.claims.length} 条结论均由独立审阅逐条标为 supported；这是审阅判断，不是确定性代码对语义真值的证明。`
          : claimProblems.slice(0, 8).join('；'),
      blocking: true,
    },
    ...groundingChecks(task, artifact, { projectReviewFacts }),
  ];
  const checks = [...providedChecks, ...deterministicChecks];
  const passed = checks.length > 0 && checks.every((item) => item.passed || !item.blocking);
  const failedBlockingChecks = checks.filter((item) => item.blocking && !item.passed);
  const modelSummary = cleanText(result.summary, 2_000);
  const review = {
    id: makeId('review'),
    artifactId,
    goalVersionId: artifact.goalVersionId,
    materialApplicabilityFingerprint: artifact.materialApplicabilityFingerprint ?? null,
    checks,
    summary: passed ? (modelSummary || '候选成果已通过独立核对。') : `宿主最终审阅未通过：${failedBlockingChecks.map((item) => `${item.name}（${item.evidence}）`).join('；')}`.slice(0, 2_000),
    modelSummary,
    passed,
    provider: cleanText(result.provider, 80) || 'deterministic',
    claimChecks,
    sourceEvidence: artifact.claims.map((item) => ({ materialId: item.materialId, sourceName: item.sourceName, locator: item.locator, quote: item.quote })),
    nativeFiles: (artifact.nativeFiles || []).filter((file) => file.status === 'ready').map((file) => ({
      kind: file.kind, sha256: file.sha256 || null, contentSha256: file.contentSha256 || null, generatorRevision: file.generatorRevision || null,
    })),
    projectCandidateFingerprint: projectCandidateFingerprint(artifact.projectCandidate),
    createdAt: now(),
  };
  task.reviews.push(review);
  artifact.reviewStatus = passed ? 'passed' : 'failed';
  setTaskState(task, passed ? 'waiting_user' : 'partial', passed ? 'steward' : 'reviewer', passed
    ? `候选成果 v${artifact.version} 已通过核对，等待确认。`
    : `候选成果 v${artifact.version} 未通过核对。`);
  return review;
}

export function confirmArtifact(task, artifactId) {
  const artifact = task.artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw new Error('找不到要确认的候选成果。');
  assertArtifactInputCurrent(task, artifact);
  assertNoCriticalMaterialDecision(task, '确认指定版本');
  if (artifact.goalVersionId !== activeGoal(task).id) throw new Error('这个版本属于旧目标，不能作为当前目标成果确认。');
  if (artifact.status !== 'candidate') throw new Error('只有当前候选版本可以确认。');
  if (['running', 'cancellation_unknown'].includes(task.status)) throw new Error('任务仍有工作在进行，不能使用旧核对结果确认。');
  if (artifact.reviewStatus !== 'passed') throw new Error('这个版本尚未通过独立核对，不能确认。');
  const latestReview = task.reviews.filter((item) => item.artifactId === artifactId).at(-1);
  if (!latestReview?.passed || latestReview.goalVersionId !== activeGoal(task).id
    || (latestReview.materialApplicabilityFingerprint ?? null) !== (artifact.materialApplicabilityFingerprint ?? null)) {
    throw new Error('缺少当前目标和材料范围下的有效独立审阅。');
  }
  if (latestReview.nativeFiles) {
    const reviewed = JSON.stringify(latestReview.nativeFiles);
    const current = JSON.stringify((artifact.nativeFiles || []).filter((file) => file.status === 'ready').map((file) => ({
      kind: file.kind, sha256: file.sha256 || null, contentSha256: file.contentSha256 || null, generatorRevision: file.generatorRevision || null,
    })));
    if (reviewed !== current) throw new Error('本地文件已在上次核对后变化，请重新独立核对。');
  }
  if (task.type === 'project' && latestReview.projectCandidateFingerprint !== projectCandidateFingerprint(artifact.projectCandidate)) {
    throw new Error('代码候选证据已在独立审阅后变化，请重新审阅。');
  }
  const missingNative = (artifact.deliverables || []).filter((entry) => ['document', 'spreadsheet', 'presentation'].includes(entry.kind)
    && !artifact.nativeFiles?.some((file) => file.kind === entry.kind && file.status === 'ready'));
  if (missingNative.length) throw new Error(`候选原生文件尚未生成并验证：${missingNative.map((entry) => entry.kind).join('、')}。`);
  for (const item of task.artifacts) if (item.status === 'confirmed') item.status = 'superseded_formal';
  artifact.status = 'confirmed';
  artifact.confirmedAt = now();
  const approval = {
    id: makeId('approval'),
    action: task.type === 'project' ? 'export-project-patch' : 'export-new-file',
    artifactId,
    artifactVersion: artifact.version,
    goalVersionId: artifact.goalVersionId,
    materialApplicabilityFingerprint: artifact.materialApplicabilityFingerprint ?? null,
    projectCandidateFingerprint: projectCandidateFingerprint(artifact.projectCandidate),
    status: 'confirmed',
    decidedAt: now(),
  };
  task.approvals.push(approval);
  task.memoryEntries ??= [];
  for (const entry of task.memoryEntries) if (entry.logicalId === artifact.logicalId && entry.status === 'active') entry.status = 'superseded';
  const conflicts = task.memoryEntries.filter((entry) => entry.status === 'active' && entry.logicalId !== artifact.logicalId && entry.title === artifact.title && entry.content !== artifact.content);
  const memory = {
    id: makeId('memory'), title: artifact.title, content: artifact.content.slice(0, 20_000),
    source: `task:${task.id}/artifact:${artifact.id}/v${artifact.version}`, artifactId: artifact.id,
    logicalId: artifact.logicalId,
    goalVersionId: artifact.goalVersionId, confirmed: true, status: conflicts.length ? 'conflict' : 'active',
    conflictsWith: conflicts.map((entry) => entry.id), createdAt: now(), retractedAt: null,
  };
  for (const entry of conflicts) { entry.status = 'conflict'; entry.conflictsWith = [...new Set([...(entry.conflictsWith || []), memory.id])]; }
  task.memoryEntries.push(memory);
  setTaskState(task, 'ready_to_export', 'steward', `已确认指定版本 v${artifact.version}，可以导出新文件。`);
  return approval;
}

export function rejectArtifact(task, artifactId, reason = '') {
  const artifact = task.artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw new Error('找不到要拒绝应用的候选成果。');
  if (artifact.goalVersionId !== activeGoal(task).id) throw new Error('这个版本属于旧目标，不能在当前目标下处理。');
  if (artifact.status !== 'candidate') throw new Error('只有当前候选版本可以被拒绝应用。');
  const message = cleanText(reason, 1_000) || '用户拒绝应用这个候选版本。';
  artifact.status = 'rejected';
  artifact.rejection = { reason: message, rejectedAt: now() };
  event(task, 'artifact.rejected', `候选成果 v${artifact.version} 已拒绝应用，未生成正式交付。`, { artifactId: artifact.id, reason: message });
  setTaskState(task, 'waiting_user', 'steward', `候选成果 v${artifact.version} 已拒绝应用，可修改或重新运行。`);
  return artifact;
}

export function assertExportAllowed(task, artifactId, approvalId) {
  const artifact = task.artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw new Error('找不到要导出的成果。');
  if (artifact.goalVersionId !== activeGoal(task).id) throw new Error('旧目标下的成果不能作为当前目标正式导出。');
  assertArtifactInputCurrent(task, artifact);
  assertNoCriticalMaterialDecision(task, '导出');
  if (artifact.status !== 'confirmed') throw new Error('只有明确确认的指定版本才能导出。');
  if (artifact.reviewStatus !== 'passed') throw new Error('这个版本当前没有有效的通过核对，不能导出。');
  const latestReview = task.reviews.filter((item) => item.artifactId === artifactId).at(-1);
  if (!latestReview?.passed || latestReview.goalVersionId !== activeGoal(task).id
    || (latestReview.materialApplicabilityFingerprint ?? null) !== (artifact.materialApplicabilityFingerprint ?? null)) {
    throw new Error('缺少当前目标和材料范围下仍然有效的独立审阅。');
  }
  if (latestReview.nativeFiles) {
    const reviewed = JSON.stringify(latestReview.nativeFiles);
    const current = JSON.stringify((artifact.nativeFiles || []).filter((file) => file.status === 'ready').map((file) => ({
      kind: file.kind, sha256: file.sha256 || null, contentSha256: file.contentSha256 || null, generatorRevision: file.generatorRevision || null,
    })));
    if (reviewed !== current) throw new Error('本地文件已在确认后变化，必须重新核对并确认。');
  }
  if (task.type === 'project' && latestReview.projectCandidateFingerprint !== projectCandidateFingerprint(artifact.projectCandidate)) {
    throw new Error('代码候选证据已在确认后变化，必须重新核对并确认。');
  }
  const approval = task.approvals.find((item) => {
    if (item.id !== approvalId || item.artifactId !== artifactId || item.status !== 'confirmed') return false;
    if (item.goalVersionId === artifact.goalVersionId) return item.materialApplicabilityFingerprint === artifact.materialApplicabilityFingerprint
      && (task.type !== 'project' || item.projectCandidateFingerprint === projectCandidateFingerprint(artifact.projectCandidate));
    return item.goalVersionId === undefined
      && projectRootId(task) === task.id
      && artifact.projectRootGoalVersionId === undefined
      && artifact.projectRootInputFingerprint === undefined
      && item.artifactVersion === artifact.version;
  });
  if (!approval) throw new Error('缺少这个指定版本的有效导出确认。');
  return artifact;
}

export function publicTask(task) {
  const result = structuredClone(task);
  delete result.projectWorkspaceHistory;
  if (Object.hasOwn(result, 'projectWorkspace')) result.projectWorkspace = publicProjectWorkspace(task);
  const materials = materialContext(task);
  const planningMaterials = materialContext(task, { includeGeneratedEvidence: false });
  result.materialContext = {
    policyActive: materials.policyActive,
    scope: materials.scope,
    fingerprint: materials.fingerprint,
    directory: materials.directory,
    blockingDecisions: materials.blockingDecisions,
    effectiveMaterialIds: planningMaterials.effectiveMaterials.map((item) => item.id),
  };
  result.continuity = deriveTaskContinuity(task);
  return result;
}

export function assertArtifactInputCurrent(task, artifact) {
  const current = currentInstructionIds(task).slice().sort();
  const used = (artifact.instructionIds || []).slice().sort();
  if (JSON.stringify(current) !== JSON.stringify(used)) throw new Error('工作交代已在候选生成后变化，请按当前输入重新规划和生成。');
  const expectedProjectGoal = task.projectRootGoalVersionId || (projectRootId(task) === task.id ? activeGoal(task).id : null);
  if (expectedProjectGoal && artifact.projectRootGoalVersionId && artifact.projectRootGoalVersionId !== expectedProjectGoal) throw new Error('项目根目标已在候选生成后变化，请按新版项目目标重新规划。');
  if (projectRootId(task) !== task.id && !artifact.projectRootGoalVersionId) throw new Error('这个候选生成于任务关联项目之前，请按当前项目目标重新规划。');
  const expectedProjectInput = task.projectRootInputFingerprint || (projectRootId(task) === task.id ? projectInputFingerprint(task) : null);
  if (artifact.projectRootInputFingerprint && expectedProjectInput && artifact.projectRootInputFingerprint !== expectedProjectInput) {
    throw new Error('项目根任务的工作交代已在候选生成后变化，请按当前输入重新规划和生成。');
  }
  if (projectRootId(task) !== task.id && !artifact.projectRootInputFingerprint) throw new Error('这个候选没有绑定当前项目输入，请重新规划。');
  if (!applicabilityFingerprintMatches(task, artifact.materialApplicabilityFingerprint)) throw new Error('材料内容或适用决定已变化，请按当前材料重新规划、生成和核对。');
  assertProjectArtifactCurrent(task, artifact);
}

export function artifactInputIsCurrent(task, artifact) {
  const current = currentInstructionIds(task).slice().sort();
  const used = (artifact.instructionIds || []).slice().sort();
  if (JSON.stringify(current) !== JSON.stringify(used)) return false;
  const expectedProjectGoal = task.projectRootGoalVersionId || (projectRootId(task) === task.id ? activeGoal(task).id : null);
  if (expectedProjectGoal && artifact.projectRootGoalVersionId && artifact.projectRootGoalVersionId !== expectedProjectGoal) return false;
  if (projectRootId(task) !== task.id && !artifact.projectRootGoalVersionId) return false;
  const expectedProjectInput = task.projectRootInputFingerprint || (projectRootId(task) === task.id ? projectInputFingerprint(task) : null);
  if (artifact.projectRootInputFingerprint && expectedProjectInput && artifact.projectRootInputFingerprint !== expectedProjectInput) {
    return false;
  }
  if (projectRootId(task) !== task.id && !artifact.projectRootInputFingerprint) return false;
  if (!applicabilityFingerprintMatches(task, artifact.materialApplicabilityFingerprint)) return false;
  if (!projectArtifactIsCurrent(task, artifact)) return false;
  return true;
}

export function deriveTaskContinuity(task) {
  const goal = activeGoal(task);
  const currentArtifacts = (task.artifacts || []).filter((item) => item.goalVersionId === goal.id
    && ['candidate', 'confirmed'].includes(item.status) && artifactInputIsCurrent(task, item));
  const candidate = currentArtifacts.at(-1) || null;
  const approval = candidate ? (task.approvals || []).findLast((item) => item.artifactId === candidate.id && item.status === 'confirmed') || null : null;
  const readyForDownload = task.status === 'ready_to_export' && Boolean(candidate && approval);
  const completed = (task.workItems || []).filter((item) => item.goalVersionId === goal.id && item.status === 'completed').map((item) => ({
    id: item.id, title: item.title, evidence: item.result?.summary || item.result?.title || item.result?.output?.slice?.(0, 500) || '已保存可检查结果。',
  }));
  const pending = (task.workItems || []).filter((item) => item.goalVersionId === goal.id && !['completed', 'cancelled', 'stale'].includes(item.status)).map((item) => ({
    id: item.id,
    title: readyForDownload && (item.kind === 'delivery' || item.role === 'steward') ? '下载已确认的指定版本' : item.title,
    status: readyForDownload && (item.kind === 'delivery' || item.role === 'steward') ? 'ready_to_export' : item.status,
  }));
  const materialDecisions = materialContext(task).blockingDecisions;
  const blockers = [
    ...materialDecisions.map((item) => `材料“${item.name}”需要决定：${item.reason}`),
    ...(task.materials || []).filter((item) => item.status === 'failed').map((item) => `材料“${item.name}”读取失败：${item.error || '未知原因'}`),
    ...(task.workItems || []).filter((item) => ['failed', 'blocked'].includes(item.status)).map((item) => `${item.title}：${item.error || item.status}`),
    ...(task.suggestions || []).filter((item) => item.goalVersionId === goal.id && item.status === 'waiting_user').map((item) => `目标替代建议等待确认：${item.text}`),
  ];
  const pendingReplacement = (task.suggestions || []).find((item) => item.goalVersionId === goal.id && item.status === 'waiting_user');
  const pendingRootDecision = task.status === 'waiting_user'
    ? task.events?.findLast((item) => item.type === 'project.goal_decision_pending'
      && (!item.detail?.rootGoalVersionId || item.detail.rootGoalVersionId === task.projectRootGoalVersionId)
      && (!item.detail?.taskGoalVersionId || item.detail.taskGoalVersionId === goal.id)) || null
    : null;
  const waitingStateEvent = task.events?.findLast((item) => item.type === 'task.state' && item.detail?.status === 'waiting_user') || null;
  const waitingForProjectAlignment = task.status === 'waiting_user'
    && /(?:项目根目标|关联任务需要真实规划器)/.test(waitingStateEvent?.message || '');
  const projectConflict = waitingForProjectAlignment
    ? task.events?.findLast((item) => ['project.goal_conflict', 'project.alignment_required'].includes(item.type)
      && (!item.detail?.rootGoalVersionId || item.detail.rootGoalVersionId === task.projectRootGoalVersionId)
      && (!item.detail?.taskGoalVersionId || item.detail.taskGoalVersionId === goal.id)) || null
    : null;
  const needsUserDecision = task.status === 'waiting_user' || Boolean(pendingReplacement);
  let nextStep = '按当前记录继续执行。';
  if (task.status === 'waiting_user' && pendingReplacement) nextStep = '对照旧目标，完整填写并决定是否接受新目标、成功条件和工作边界。';
  else if (task.status === 'waiting_user' && pendingRootDecision) nextStep = '等待项目根任务的目标变更决定；决定完成后按有效项目输入重新规划。';
  else if (task.status === 'waiting_user' && projectConflict) nextStep = '决定如何让本任务目标与项目根目标对齐；对齐前不会继续执行。';
  else if (task.status === 'waiting_user' && candidate?.reviewStatus === 'passed') nextStep = '审阅当前候选并明确确认、拒绝或提出修改。';
  else if (task.status === 'waiting_user') nextStep = blockers[0] ? `处理等待中的决定：${blockers[0]}` : '处理当前明确等待的用户决定。';
  else if (materialDecisions.length) nextStep = `可继续规划和不依赖它的研究；形成候选前需决定：${materialDecisions[0].name}（${materialDecisions[0].reason}）`;
  else if (readyForDownload) nextStep = '下载已确认的指定版本。';
  else if (['failed', 'partial', 'cancelled', 'cancellation_unknown'].includes(task.status)
    && ['budget_exhausted', 'permanent_error', 'same_error_exhausted', 'project_verification_failed', 'project_transaction_failed'].includes(task.execution?.stopReason)) {
    if (task.execution?.stopReason === 'budget_exhausted') nextStep = '现有预算已用尽；调整预算或范围后再继续。';
    else if (task.execution?.stopReason === 'permanent_error') nextStep = '当前原因不可自动重试；先解除权限或环境阻碍，或调整输入与范围后再重新开始。';
    else if (task.execution?.stopReason === 'project_verification_failed') nextStep = '固定业务检查未通过，候选与诊断已保留；补充或修改工作要求后，重新授权工作区并重新规划。';
    else if (task.execution?.stopReason === 'project_transaction_failed') nextStep = '固定项目事务未完成；补充或修改工作要求后，重新授权工作区并重新规划。';
    else nextStep = '同一错误已达到重试上限；请改变输入、范围或运行条件后再重新开始。';
  }
  else if (!task.plan || !task.workItems?.length) nextStep = '按当前目标、材料和已接受交代重新形成计划。';
  else if (task.status === 'running') nextStep = '等待当前工作到安全写回点；进度会写回同一任务。';
  else if (['failed', 'partial', 'cancelled', 'cancellation_unknown'].includes(task.status)) nextStep = '从未完成的有效步骤恢复；可重试错误仍受原有次数与时间上限约束。';
  const failedWork = (task.workItems || []).findLast((item) => ['failed', 'blocked', 'cancelled'].includes(item.status) && item.error);
  const matchingStateEvent = task.events?.findLast((item) => item.type === 'task.state' && item.detail?.status === task.status);
  const stoppedBecause = ['failed', 'partial', 'cancelled', 'cancellation_unknown'].includes(task.status)
    ? failedWork?.error || matchingStateEvent?.message || task.execution?.stopReason || blockers[0] || task.status
    : needsUserDecision ? (pendingRootDecision?.message || projectConflict?.message || (pendingReplacement ? blockers[0] || '等待用户明确决定。' : '等待用户明确决定。'))
      : readyForDownload ? '指定版本已确认，当前等待你下载。' : null;
  return {
    taskId: task.id,
    project: {
      rootTaskId: projectRootId(task),
      rootGoalVersionId: task.projectRootGoalVersionId || null,
      rootInputFingerprint: task.projectRootInputFingerprint || null,
      linked: projectRootId(task) !== task.id,
    },
    currentGoal: { id: goal.id, version: goal.version, statement: goal.statement, successCriteria: goal.successCriteria, boundaries: goal.boundaries },
    completed,
    pending,
    acceptedInstructions: (task.suggestions || []).filter((item) => item.goalVersionId === goal.id && item.classification === 'support' && item.status === 'routed').map((item) => ({ id: item.id, text: item.text })),
    blockers,
    candidate: candidate ? { id: candidate.id, version: candidate.version, status: candidate.status, reviewStatus: candidate.reviewStatus, confirmed: Boolean(approval) } : null,
    approval: approval ? { id: approval.id, artifactId: approval.artifactId, decidedAt: approval.decidedAt } : null,
    historical: {
      goalVersions: task.goal.versions.filter((item) => item.id !== goal.id).map((item) => ({ id: item.id, version: item.version, statement: item.statement, status: 'historical' })),
      candidates: (task.artifacts || []).filter((item) => item.goalVersionId !== goal.id || item.id !== candidate?.id).map((item) => ({ id: item.id, version: item.version, status: item.status, confirmed: item.status === 'confirmed' || item.status === 'superseded_formal', historical: true })),
    },
    progress: { done: completed.map((item) => item.title), incomplete: pending.map((item) => item.title), stoppedBecause, nextStep, needsUserDecision },
  };
}

export function createStore(root) {
  const tasksRoot = path.resolve(root);
  // ponytail: one process-wide write queue closes project propagation races; use per-project locks only if measured write throughput becomes a problem.
  let mutationQueue = Promise.resolve();
  const taskDir = (id) => {
    if (!SAFE_ID.test(id)) throw new Error('任务 ID 不合法。');
    return path.join(tasksRoot, id);
  };
  const atomicWrite = async (file, content) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temp, content, { mode: 0o600 });
    await fs.rename(temp, file);
  };
  return {
    root: tasksRoot,
    taskDir,
    async init() { await fs.mkdir(tasksRoot, { recursive: true }); },
    async list() {
      await this.init();
      const names = await fs.readdir(tasksRoot, { withFileTypes: true });
      const tasks = [];
      for (const entry of names) {
        if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
        try { tasks.push(await this.get(entry.name)); } catch { /* ignore damaged folders in list */ }
      }
      return tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async get(id) {
      const file = path.join(taskDir(id), 'task.json');
      return JSON.parse(await fs.readFile(file, 'utf8'));
    },
    async save(task) {
      const dir = taskDir(task.id);
      await fs.mkdir(dir, { recursive: true });
      await atomicWrite(path.join(dir, 'task.json'), `${JSON.stringify(task, null, 2)}\n`);
      return task;
    },
    async appendAudit(task, item) {
      const file = path.join(taskDir(task.id), 'events.jsonl');
      await fs.appendFile(file, `${JSON.stringify(item)}\n`, { mode: 0o600 });
    },
    async mutate(id, change) {
      const previous = mutationQueue;
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      mutationQueue = previous.then(() => current);
      await previous;
      try {
        const task = await this.get(id);
        const previousEventIds = new Set((task.events || []).map((item) => item.id));
        const result = await change(task);
        await this.save(task);
        for (const item of task.events || []) if (!previousEventIds.has(item.id)) await this.appendAudit(task, item);
        return { task, result };
      } finally {
        release();
      }
    },
    async mutateMany(ids, change) {
      const uniqueIds = [...new Set(ids)];
      const previous = mutationQueue;
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      mutationQueue = previous.then(() => current);
      await previous;
      try {
        const tasks = new Map(await Promise.all(uniqueIds.map(async (id) => [id, await this.get(id)])));
        const previousEventIds = new Map([...tasks].map(([id, task]) => [id, new Set((task.events || []).map((item) => item.id))]));
        const result = await change(tasks);
        for (const task of tasks.values()) {
          await this.save(task);
          for (const item of task.events || []) if (!previousEventIds.get(task.id).has(item.id)) await this.appendAudit(task, item);
        }
        return { tasks, result };
      } finally { release(); }
    },
    async mutateWhere(select, change) {
      const previous = mutationQueue;
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      mutationQueue = previous.then(() => current);
      await previous;
      try {
        const tasks = new Map((await this.list()).filter(select).map((task) => [task.id, task]));
        const previousEventIds = new Map([...tasks].map(([id, task]) => [id, new Set((task.events || []).map((item) => item.id))]));
        const result = await change(tasks);
        for (const task of tasks.values()) {
          await this.save(task);
          for (const item of task.events || []) if (!previousEventIds.get(task.id).has(item.id)) await this.appendAudit(task, item);
        }
        return { tasks, result };
      } finally { release(); }
    },
    async locked(change) {
      const previous = mutationQueue;
      let release;
      const current = new Promise((resolve) => { release = resolve; });
      mutationQueue = previous.then(() => current);
      await previous;
      try { return await change(); }
      finally { release(); }
    },
  };
}

export const __test = { cleanText, cleanList, VALID_TASK_TYPES, VALID_SUGGESTIONS };
