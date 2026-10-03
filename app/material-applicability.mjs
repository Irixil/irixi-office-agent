import crypto from 'node:crypto';

const CATEGORIES = new Set(['reusable_fact', 'goal_specific', 'constraint', 'unclassified']);
const DISPOSITIONS = new Set(['use', 'exclude', 'pending']);
const IMPACTS = new Set(['required_for_delivery', 'non_blocking']);

const hash = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex');
const clean = (value, limit = 1_000) => String(value ?? '').replaceAll('\u0000', '').trim().slice(0, limit);
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;

export function materialContentSha256(material) {
  return hash(material?.text || '');
}

export function currentMaterialScope(task) {
  const localGoalVersionId = task?.goal?.activeVersionId || null;
  const projectRootTaskId = task?.projectRootTaskId || task?.id || null;
  return {
    localGoalVersionId,
    projectRootTaskId,
    projectRootGoalVersionId: task?.projectRootGoalVersionId || localGoalVersionId,
    projectRootInputFingerprint: task?.projectRootInputFingerprint || null,
  };
}

const sameRootScope = (left, right) => left?.projectRootTaskId === right?.projectRootTaskId
  && left?.projectRootGoalVersionId === right?.projectRootGoalVersionId
  && left?.projectRootInputFingerprint === right?.projectRootInputFingerprint;

const sameExactScope = (left, right) => left?.localGoalVersionId === right?.localGoalVersionId && sameRootScope(left, right);

export function ensureMaterialPolicy(task, reason = 'explicit_material_change') {
  if (task.materialApplicability?.version === 1) return task.materialApplicability;
  const scope = currentMaterialScope(task);
  task.materialApplicability = {
    version: 1,
    activatedAt: new Date().toISOString(),
    activationReason: clean(reason, 120),
    legacyScope: scope,
    legacyMaterials: (task.materials || [])
      .filter((material) => material.status === 'ready' && material.generatedEvidence !== true)
      .map((material) => ({ materialId: material.id, contentSha256: materialContentSha256(material) })),
    decisions: [],
  };
  return task.materialApplicability;
}

function latestDecision(task, materialId) {
  return (task.materialApplicability?.decisions || [])
    .filter((decision) => decision.materialId === materialId)
    .at(-1) || null;
}

function evidenceBindingCurrent(task, material) {
  const bindings = Array.isArray(material.evidenceBindings) ? material.evidenceBindings : material.evidenceForWorkItemId ? [{
    workItemId: material.evidenceForWorkItemId,
    goalVersionId: material.evidenceGoalVersionId || null,
    projectRootGoalVersionId: material.evidenceProjectRootGoalVersionId || null,
    sourceContextFingerprint: material.evidenceSourceContextFingerprint || null,
    planRevision: material.evidencePlanRevision || null,
  }] : [];
  // Existing tasks stored web evidence before execution-chain bindings existed.
  // Preserve that read behavior until a material-policy-changing business event
  // activates the new contract; new/changed tasks require an explicit binding.
  if (!task.materialApplicability && bindings.length === 0) return true;
  const scope = currentMaterialScope(task);
  return bindings.some((binding) => {
    const item = (task.workItems || []).find((candidate) => candidate.id === binding.workItemId);
    if (!item) return false;
    if (binding.goalVersionId && binding.goalVersionId !== scope.localGoalVersionId) return false;
    if (binding.projectRootGoalVersionId && binding.projectRootGoalVersionId !== scope.projectRootGoalVersionId) return false;
    if (binding.sourceContextFingerprint && item.sourceContextFingerprint !== binding.sourceContextFingerprint) return false;
    if (binding.planRevision && task.plan?.revision !== binding.planRevision) return false;
    return item.goalVersionId === scope.localGoalVersionId
      && item.projectRootGoalVersionId === scope.projectRootGoalVersionId;
  });
}

function userMaterialEligibility(task, material) {
  if (material.status !== 'ready') return { eligible: false, state: 'failed', reason: material.error || '材料不可读。', decision: null };
  const policy = task.materialApplicability;
  if (!policy) return { eligible: true, state: 'legacy_current', reason: '旧任务尚未发生材料或目标业务变更，按原范围继续使用。', decision: null };
  const scope = currentMaterialScope(task);
  const contentSha256 = materialContentSha256(material);
  const decision = latestDecision(task, material.id);
  if (decision) {
    const decisionScope = {
      localGoalVersionId: decision.localGoalVersionId,
      projectRootTaskId: decision.projectRootTaskId,
      projectRootGoalVersionId: decision.projectRootGoalVersionId,
      projectRootInputFingerprint: decision.projectRootInputFingerprint || null,
    };
    if (decision.contentSha256 !== contentSha256) {
      if (decision.disposition === 'exclude') {
        return { eligible: false, state: 'excluded', reason: '材料正文已变化；用户原先明确排除，当前仍不使用。', decision };
      }
      if (decision.category === 'constraint' && decision.impact === 'required_for_delivery'
        && ['use', 'pending'].includes(decision.disposition)) {
        return { eligible: false, state: 'needs_reconfirmation', reason: `约束“${decision.purpose}”的正文已变化，影响交付前必须重新确认。`, decision, blocking: true };
      }
      return { eligible: false, state: 'content_changed', reason: '材料正文已变化，旧适用决定不再有效；当前未使用。', decision };
    }
    const rootTask = scope.projectRootTaskId === task.id && decisionScope.projectRootTaskId === task.id;
    const reusableScope = decision.category === 'reusable_fact'
      && (rootTask ? true : sameRootScope(decisionScope, scope));
    const scopeMatches = reusableScope || sameExactScope(decisionScope, scope);
    if (scopeMatches && decision.disposition === 'use') {
      return { eligible: true, state: decision.category, reason: decision.reason || decision.purpose, decision };
    }
    if (scopeMatches && decision.disposition === 'pending') {
      const blocking = decision.category === 'constraint' && decision.impact === 'required_for_delivery';
      return { eligible: false, state: blocking ? 'needs_decision' : 'excluded_non_blocking', reason: decision.reason || decision.purpose, decision, blocking };
    }
    if (scopeMatches && decision.disposition === 'exclude') {
      return { eligible: false, state: 'excluded', reason: decision.reason || decision.purpose, decision };
    }
    if (decision.category === 'constraint' && decision.disposition !== 'exclude' && decision.impact === 'required_for_delivery') {
      return { eligible: false, state: 'needs_reconfirmation', reason: `约束“${decision.purpose}”属于旧目标范围，影响交付前必须重新确认。`, decision, blocking: true };
    }
    return { eligible: false, state: 'scope_changed', reason: '材料决定属于旧目标或旧项目范围，当前未使用。', decision };
  }
  const legacy = (policy.legacyMaterials || []).find((entry) => entry.materialId === material.id && entry.contentSha256 === contentSha256);
  if (legacy && sameExactScope(policy.legacyScope, scope)) {
    return { eligible: true, state: 'legacy_current', reason: '制度启用前已在同一目标范围内使用；范围变化后不会自动沿用。', decision: null };
  }
  return { eligible: false, state: 'unclassified', reason: '尚未说明这份材料为何适用于当前目标。', decision: null };
}

export function materialContext(task, { includeGeneratedEvidence = true } = {}) {
  const policyActive = task.materialApplicability?.version === 1;
  const directory = [];
  const effectiveMaterials = [];
  const blockers = [];
  for (const material of task.materials || []) {
    let eligibility;
    if (material.generatedEvidence === true) {
      const eligible = material.status === 'ready' && includeGeneratedEvidence && evidenceBindingCurrent(task, material);
      eligibility = { eligible, state: eligible ? 'generated_evidence' : 'generated_evidence_history', reason: eligible ? '当前执行链取得的网页证据。' : '旧执行链网页证据，仅保留历史。', decision: null };
    } else eligibility = userMaterialEligibility(task, material);
    const contentSha256 = materialContentSha256(material);
    const entry = {
      id: material.id,
      name: material.name,
      kind: material.kind,
      source: material.source,
      status: material.status,
      bytes: material.bytes,
      contentSha256,
      eligibility: eligibility.state,
      eligible: eligibility.eligible,
      reason: eligibility.reason,
      purpose: eligibility.decision?.purpose || null,
      category: eligibility.decision?.category || null,
      disposition: eligibility.decision?.disposition || null,
      impact: eligibility.decision?.impact || null,
      generatedEvidence: material.generatedEvidence === true,
      metadata: material.generatedEvidence === true ? {
        evidenceType: 'web-read',
        finalUrl: material.source || null,
        fetchedAt: material.fetchedAt || null,
        httpStatus: material.evidenceMetadata?.httpStatus ?? null,
        contentType: material.evidenceMetadata?.contentType || null,
        resolutionMode: material.evidenceMetadata?.resolutionMode || null,
        contentSha256: material.evidenceSha256 || contentSha256,
        sourceLocator: material.locator || null,
      } : null,
    };
    directory.push(entry);
    if (eligibility.eligible) effectiveMaterials.push(material);
    if (eligibility.blocking) blockers.push({ materialId: material.id, name: material.name, purpose: eligibility.decision?.purpose || material.name, reason: eligibility.reason, state: eligibility.state });
  }
  const fingerprint = policyActive ? hash(JSON.stringify({
    scope: currentMaterialScope(task),
    effective: effectiveMaterials.filter((material) => material.generatedEvidence !== true).map((material) => [material.id, materialContentSha256(material)]),
    decisions: (task.materialApplicability.decisions || []).map((decision) => [
      decision.id, decision.materialId, decision.contentSha256, decision.category, decision.disposition, decision.impact,
      decision.purpose, decision.reason, decision.localGoalVersionId, decision.projectRootTaskId,
      decision.projectRootGoalVersionId, decision.projectRootInputFingerprint || null,
    ]),
  })) : null;
  return { policyActive, scope: currentMaterialScope(task), fingerprint, effectiveMaterials, directory, blockingDecisions: blockers };
}

export function assertMaterialEligible(task, materialId, options = {}) {
  const context = materialContext(task, options);
  const entry = context.directory.find((candidate) => candidate.id === materialId);
  if (!entry || !entry.eligible) {
    const error = new Error(entry ? `材料“${entry.name}”当前不可用于此目标：${entry.reason}` : `材料 ${materialId} 不存在或不可读。`);
    error.code = 'material_not_applicable';
    throw error;
  }
  return (task.materials || []).find((material) => material.id === materialId);
}

export function recordMaterialDecision(task, materialId, input = {}) {
  const before = materialContext(task, { includeGeneratedEvidence: false });
  const material = (task.materials || []).find((entry) => entry.id === materialId && entry.generatedEvidence !== true);
  if (!material) throw new Error('找不到要设置适用性的原始材料。');
  const expected = input.expectedScope || {};
  if (input.expectedFingerprint !== before.fingerprint
    || JSON.stringify(expected) !== JSON.stringify(before.scope)
    || input.expectedContentSha256 !== materialContentSha256(material)) {
    const error = new Error('材料、目标范围或适用决定已变化；请刷新后重新提交。');
    error.code = 'stale_material_decision';
    error.status = 409;
    throw error;
  }
  const category = clean(input.category, 40);
  const disposition = clean(input.disposition, 40);
  const explicitImpact = clean(input.impact, 40);
  if (category === 'constraint' && ['pending', 'use'].includes(disposition) && !IMPACTS.has(explicitImpact)) {
    throw new Error('约束材料必须明确选择是否影响交付。');
  }
  const impact = explicitImpact || 'non_blocking';
  const purpose = clean(input.purpose, 500);
  const reason = clean(input.reason, 1_000);
  if (!CATEGORIES.has(category) || !DISPOSITIONS.has(disposition) || !IMPACTS.has(impact)) throw new Error('材料适用决定无效。');
  if (!purpose) throw new Error('请说明这份材料在当前目标中的用途。');
  if (category !== 'constraint' && disposition === 'pending') throw new Error('只有约束可以设为待重新确认。');
  ensureMaterialPolicy(task, 'material_applicability_decided');
  const previous = latestDecision(task, material.id);
  const scope = currentMaterialScope(task);
  const decision = {
    id: id('material-decision'), materialId: material.id, contentSha256: materialContentSha256(material),
    category, disposition, impact, purpose, reason,
    ...scope, decidedBy: 'user', decidedAt: new Date().toISOString(), supersedesDecisionId: previous?.id || null,
  };
  task.materialApplicability.decisions.push(decision);
  return decision;
}

export function registerAddedMaterial(task, material) {
  ensureMaterialPolicy(task, 'ready_material_added');
  const scope = currentMaterialScope(task);
  const decision = {
    id: id('material-decision'), materialId: material.id, contentSha256: materialContentSha256(material),
    category: 'unclassified', disposition: 'use', impact: 'non_blocking',
    purpose: '用户为当前目标加入的材料', reason: '仅限加入时的当前目标与项目范围；范围变化后不会自动沿用。',
    ...scope, decidedBy: 'user', decidedAt: new Date().toISOString(), supersedesDecisionId: null,
  };
  task.materialApplicability.decisions.push(decision);
  return decision;
}

export function bindGeneratedEvidence(task, material, item) {
  material.evidenceBindings ??= [];
  const binding = {
    workItemId: item.id,
    sourceContextFingerprint: item.sourceContextFingerprint || null,
    goalVersionId: item.goalVersionId || currentMaterialScope(task).localGoalVersionId,
    projectRootGoalVersionId: item.projectRootGoalVersionId || currentMaterialScope(task).projectRootGoalVersionId,
    planRevision: task.plan?.revision || null,
    boundAt: new Date().toISOString(),
  };
  const key = JSON.stringify([binding.workItemId, binding.sourceContextFingerprint, binding.goalVersionId, binding.projectRootGoalVersionId, binding.planRevision]);
  if (!material.evidenceBindings.some((entry) => JSON.stringify([entry.workItemId, entry.sourceContextFingerprint, entry.goalVersionId, entry.projectRootGoalVersionId, entry.planRevision]) === key)) material.evidenceBindings.push(binding);
  return binding;
}

export function applicabilityFingerprintMatches(task, value) {
  const current = materialContext(task, { includeGeneratedEvidence: false }).fingerprint;
  return current === null ? value == null : value === current;
}

export function assertNoCriticalMaterialDecision(task, action) {
  const blockers = materialContext(task).blockingDecisions;
  if (!blockers.length) return;
  const error = new Error(`完成${action}前需要决定：${blockers.map((item) => `${item.name}（${item.reason}）`).join('；')}`);
  error.code = 'material_decision_required';
  error.status = 409;
  error.blockers = blockers;
  throw error;
}

export const __test = { sameExactScope, sameRootScope, evidenceBindingCurrent, userMaterialEligibility };
