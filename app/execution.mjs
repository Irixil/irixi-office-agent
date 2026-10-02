import crypto from 'node:crypto';

// Adapted from OpenOffice phase-machine.ts and retry.ts at
// 5b0246c396aed041c5262ab0132623bf2b8b067b. The original MIT license is
// retained in third_party/OpenOffice-MIT.txt. Irixi stores this state inside
// its existing task snapshot and treats exhausted budgets as partial, never success.

const boundedEnvironmentNumber = (name, fallback, minimum, maximum) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
};

export const DEFAULT_BUDGET = Object.freeze({
  maxRoles: 8,
  maxConcurrentModelCalls: 2,
  maxModelCalls: 24,
  maxDurationMs: boundedEnvironmentNumber('IRIXI_RUN_TIMEOUT_MS', 30 * 60_000, 5 * 60_000, 60 * 60_000),
  maxAttemptsPerStep: 2,
  maxPlanRevisions: 2,
  maxToolRoundsPerStep: 3,
});

const PHASES = {
  planned: new Set(['executing', 'cancelled']),
  executing: new Set(['reviewing', 'partial', 'failed', 'cancelled']),
  reviewing: new Set(['waiting_user', 'partial', 'failed', 'cancelled']),
  waiting_user: new Set(['completed', 'executing', 'cancelled']),
  partial: new Set(['executing', 'cancelled']),
  failed: new Set(['executing', 'cancelled']),
  completed: new Set([]),
  cancelled: new Set([]),
};

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}-${crypto.randomUUID()}`;

export function transitionExecution(task, next) {
  const current = task.execution?.phase;
  if (!current || !PHASES[current]?.has(next)) throw new Error(`不允许从 ${current || 'unknown'} 进入 ${next}。`);
  task.execution.phase = next;
  task.execution.updatedAt = now();
  return task.execution;
}

export function startExecution(task, goalVersionId, budget = {}) {
  if (task.execution) {
    task.executionHistory ??= [];
    task.executionHistory.push(structuredClone(task.execution));
    task.executionHistory = task.executionHistory.slice(-20);
  }
  const limits = { ...DEFAULT_BUDGET, ...budget };
  const modelRoles = new Set(task.workItems.filter((item) => item.kind !== 'delivery' && item.role !== 'steward').map((item) => item.agentId || item.role));
  if (modelRoles.size > limits.maxRoles) throw new Error(`执行角色超过上限 ${limits.maxRoles}。`);
  const startedAt = now();
  task.execution = {
    id: id('run'),
    goalVersionId,
    projectRootGoalVersionId: task.projectRootGoalVersionId || goalVersionId,
    projectRootInputFingerprint: task.projectRootInputFingerprint || null,
    phase: 'planned',
    limits,
    modelCalls: [],
    // Bounded delegation/result-batch semantics adapted from OpenOffice
    // delegation.ts/types.ts. These are local task records, not Git agents.
    delegations: [],
    returnedResults: [],
    resultBatch: [],
    planRevisions: 0,
    startedAt,
    deadlineAt: new Date(Date.now() + limits.maxDurationMs).toISOString(),
    updatedAt: startedAt,
    stopReason: null,
  };
  transitionExecution(task, 'executing');
  return task.execution;
}

export function beginWork(task, role) {
  const item = task.workItems.find((work) => work.role === role);
  return beginWorkItem(task, item?.id);
}

export function beginWorkItem(task, workItemId) {
  const item = task.workItems.find((work) => work.id === workItemId);
  if (!item) throw new Error(`找不到工作项 ${workItemId}。`);
  const unmet = (item.dependsOn || []).filter((workId) => task.workItems.find((work) => work.id === workId)?.status !== 'completed');
  if (unmet.length) throw new Error(`${item.title} 的前置工作尚未完成。`);
  const itemProjectGoalVersionId = item.projectRootGoalVersionId || (!task.projectRootTaskId ? task.execution?.projectRootGoalVersionId : null);
  const itemProjectInputFingerprint = item.projectRootInputFingerprint || (!task.projectRootTaskId ? task.execution?.projectRootInputFingerprint : null);
  if (item.goalVersionId !== task.execution?.goalVersionId || itemProjectGoalVersionId !== task.execution?.projectRootGoalVersionId
    || itemProjectInputFingerprint !== task.execution?.projectRootInputFingerprint) throw new Error('工作项目标或项目输入版本已经过期。');
  item.status = 'running';
  item.startedAt = now();
  item.updatedAt = item.startedAt;
  item.attempts ??= [];
  task.execution.delegations ??= [];
  task.execution.delegations.push({
    id: id('delegation'),
    workItemId: item.id,
    goalVersionId: item.goalVersionId,
    fromRole: task.activeRole || 'coordinator',
    toRole: item.role,
    agentId: item.agentId || null,
    status: 'running',
    delegatedAt: item.startedAt,
  });
  task.execution.delegations = task.execution.delegations.slice(-30);
  return item;
}

export function completeWork(task, role, result) {
  const item = task.workItems.find((work) => work.role === role);
  return completeWorkItem(task, item?.id, result);
}

export function completeWorkItem(task, workItemId, result) {
  const item = task.workItems.find((work) => work.id === workItemId);
  if (!item || item.status !== 'running') throw new Error(`工作项 ${workItemId} 不在运行。`);
  const itemProjectGoalVersionId = item.projectRootGoalVersionId || (!task.projectRootTaskId ? task.execution?.projectRootGoalVersionId : null);
  const itemProjectInputFingerprint = item.projectRootInputFingerprint || (!task.projectRootTaskId ? task.execution?.projectRootInputFingerprint : null);
  if (item.goalVersionId !== task.execution?.goalVersionId || itemProjectGoalVersionId !== task.execution?.projectRootGoalVersionId
    || itemProjectInputFingerprint !== task.execution?.projectRootInputFingerprint) throw new Error('工作结果属于旧目标或旧项目输入版本。');
  const meaningful = typeof result === 'string' ? result.trim() : result && Object.keys(result).length;
  if (!meaningful) throw new Error(`${item.title} 没有可检查产物，不能标记完成。`);
  item.result = structuredClone(result);
  item.status = 'completed';
  item.completedAt = now();
  item.updatedAt = item.completedAt;
  const delegation = task.execution?.delegations?.findLast((entry) => entry.workItemId === item.id && entry.status === 'running');
  if (delegation) { delegation.status = 'returned'; delegation.returnedAt = item.completedAt; }
  task.execution.returnedResults ??= [];
  task.execution.returnedResults.push({
    id: id('result'),
    workItemId: item.id,
    goalVersionId: item.goalVersionId,
    role: item.role,
    agentId: item.agentId || null,
    returnedAt: item.completedAt,
    result: structuredClone(result),
  });
  task.execution.returnedResults = task.execution.returnedResults.slice(-30);
  task.execution.resultBatch = task.execution.returnedResults
    .filter((entry) => entry.goalVersionId === task.execution.goalVersionId)
    .map((entry) => ({ resultId: entry.id, workItemId: entry.workItemId, role: entry.role, returnedAt: entry.returnedAt }));
  return item;
}

export function failWork(task, role, error, status = 'failed') {
  const item = task.workItems.find((work) => work.role === role);
  return failWorkItem(task, item?.id, error, status);
}

export function failWorkItem(task, workItemId, error, status = 'failed') {
  const item = task.workItems.find((work) => work.id === workItemId);
  if (!item) return null;
  item.status = status;
  item.error = String(error?.message || error || '未知失败').slice(0, 1_000);
  item.updatedAt = now();
  item.completedAt = item.updatedAt;
  const delegation = task.execution?.delegations?.findLast((entry) => entry.workItemId === item.id && entry.status === 'running');
  if (delegation) {
    delegation.status = status === 'cancelled' ? 'cancelled' : status === 'blocked' ? 'blocked' : 'failed';
    delegation.finishedAt = item.updatedAt;
    delegation.error = item.error;
  }
  return item;
}

export function recordAttempt(task, role, error) {
  const item = task.workItems.find((work) => work.role === role);
  return recordWorkAttempt(task, item?.id, error);
}

export function recordWorkAttempt(task, workItemId, error) {
  const item = task.workItems.find((work) => work.id === workItemId);
  if (!item) throw new Error(`找不到工作项 ${workItemId}。`);
  item.attempts ??= [];
  item.attempts.push({ at: now(), error: String(error?.message || error).slice(0, 1_000) });
  item.updatedAt = now();
  return item.attempts.length;
}

export function mayRetry(task, role, error) {
  const item = task.workItems.find((work) => work.role === role);
  return mayRetryWork(task, item?.id, error);
}

export function mayRetryWork(task, workItemId, error) {
  return retryDisposition(task, workItemId, error).retryable;
}

export function retryDisposition(task, workItemId, error) {
  const item = task.workItems.find((work) => work.id === workItemId);
  const permanent = /(认证|凭据|余额|权限|permission|unauthorized|forbidden|invalid schema|输出结构)/i.test(String(error?.message || error));
  const attempts = item?.attempts || [];
  const maxAttempts = task.execution?.limits?.maxAttemptsPerStep || DEFAULT_BUDGET.maxAttemptsPerStep;
  const normalized = attempts.map((attempt) => String(attempt.error || '').slice(0, 80).toLowerCase());
  const sameErrorAtLimit = attempts.length >= maxAttempts && normalized.length >= 2 && normalized.every((value) => value === normalized[0]);
  return {
    retryable: !permanent && attempts.length < maxAttempts,
    permanent,
    sameErrorAtLimit,
    attempts: attempts.length,
    maxAttempts,
  };
}

export function reserveModelCall(task, role) {
  const execution = task.execution;
  if (!execution || !['executing', 'reviewing'].includes(execution.phase)) throw new Error('当前执行阶段不允许模型调用。');
  if (Date.now() >= Date.parse(execution.deadlineAt)) {
    const minutes = Math.round(execution.limits.maxDurationMs / 60_000);
    const error = new Error(`任务已达到 ${minutes} 分钟运行上限。`);
    error.code = 'budget_exhausted';
    throw error;
  }
  if (execution.modelCalls.length >= execution.limits.maxModelCalls) {
    const error = new Error(`任务已达到 ${execution.limits.maxModelCalls} 次模型调用上限。`);
    error.code = 'budget_exhausted';
    throw error;
  }
  const running = execution.modelCalls.filter((call) => call.status === 'running').length;
  if (running >= execution.limits.maxConcurrentModelCalls) {
    const error = new Error('并发模型调用已达到上限。');
    error.code = 'budget_exhausted';
    throw error;
  }
  const call = { id: id('call'), role, status: 'running', startedAt: now(), finishedAt: null, usage: 'unknown', error: null };
  execution.modelCalls.push(call);
  execution.updatedAt = call.startedAt;
  return call;
}

export function finishModelCall(task, callId, { status = 'completed', usage = 'unknown', error = null } = {}) {
  const call = task.execution?.modelCalls.find((item) => item.id === callId);
  if (!call) return null;
  call.status = status;
  call.usage = usage ?? 'unknown';
  call.error = error ? String(error).slice(0, 1_000) : null;
  call.finishedAt = now();
  task.execution.updatedAt = call.finishedAt;
  return call;
}

export function sourcePackets(task, maxChars = 120_000) {
  let remaining = maxChars;
  const packets = [];
  for (const material of task.materials.filter((item) => item.status === 'ready')) {
    if (remaining <= 0) break;
    const lines = String(material.text || '').split(/\r?\n/);
    const selected = [];
    let used = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const rendered = `${index + 1}| ${lines[index]}`;
      if (used + rendered.length + 1 > remaining) break;
      selected.push(rendered);
      used += rendered.length + 1;
    }
    if (!selected.length && lines.length) continue;
    remaining -= used;
    packets.push({
      materialId: material.id,
      sourceName: material.name,
      source: material.source,
      metadata: material.generatedEvidence === true ? {
        evidenceType: 'web-read',
        finalUrl: material.source,
        fetchedAt: material.fetchedAt || null,
        httpStatus: material.evidenceMetadata?.httpStatus ?? null,
        contentType: material.evidenceMetadata?.contentType || null,
        resolutionMode: material.evidenceMetadata?.resolutionMode || null,
        contentSha256: material.evidenceSha256 || null,
        sourceLocator: material.locator || null,
      } : null,
      locator: `L1-L${selected.length || 1}`,
      excerpt: selected.join('\n'),
      excerptSha256: crypto.createHash('sha256').update(selected.join('\n')).digest('hex'),
      truncated: selected.length < lines.length,
    });
  }
  return packets;
}

function locatorText(material, locator) {
  const match = /^L(\d+)-L(\d+)$/.exec(String(locator || ''));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const lines = String(material.text || '').split(/\r?\n/);
  if (start < 1 || end < start || end > lines.length) return null;
  return lines.slice(start - 1, end).join('\n');
}

const normalize = (value) => String(value || '').replaceAll(/\s+/g, ' ').trim().toLowerCase();

function criticalTokens(value) {
  // UUIDs are structural references (for example material/task/artifact IDs),
  // not business dates. Remove only the canonical UUID token itself so a real
  // date written next to an ID is still checked normally.
  const text = String(value || '').replaceAll(/\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/gi, '');
  const tokens = [];
  const dateRanges = [];
  const datePattern = /(\d{4})(?:[-/.年](\d{1,2})(?:[-/.月](\d{1,2})日?)?|年)/g;
  for (const match of text.matchAll(datePattern)) {
    const year = match[1];
    tokens.push(`date:${year}`);
    if (match[2]) tokens.push(`date:${year}-${String(Number(match[2])).padStart(2, '0')}`);
    if (match[3]) tokens.push(`date:${year}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`);
    dateRanges.push([match.index, match.index + match[0].length]);
  }
  const pattern = /(?:[¥￥$€]\s*\d[\d,.]*)|(?:\d[\d,.]*\s*(?:万元|美元|欧元|元|天|日|周|月|年|小时|%|套|件|个|人|家))/g;
  // Chinese prose commonly varies only by spacing around a number and unit
  // (for example, "12800 元" versus "12800元"). That formatting is not a
  // factual difference, so canonicalize whitespace for token comparison only.
  for (const match of text.matchAll(pattern)) {
    const overlapsDate = dateRanges.some(([start, end]) => match.index < end && match.index + match[0].length > start);
    if (!overlapsDate) tokens.push(normalize(match[0]).replaceAll(' ', ''));
  }
  return tokens;
}

export function validateClaim(task, claim) {
  const material = task.materials.find((item) => item.id === claim?.materialId && item.status === 'ready');
  if (!material) return { passed: false, reason: '来源材料不存在或不可读。' };
  if (claim.sourceName !== material.name) return { passed: false, reason: '来源名称与材料 ID 不匹配。' };
  const selected = locatorText(material, claim.locator);
  if (selected === null) return { passed: false, reason: '来源行号无效。' };
  const quote = normalize(claim.quote);
  if (!quote || !normalize(selected).includes(quote)) return { passed: false, reason: '引用原文不在所标行号中。' };
  const quoteTokens = new Set(criticalTokens(claim.quote));
  const missing = criticalTokens(claim.statement).filter((token) => !quoteTokens.has(token));
  if (missing.length) return { passed: false, reason: `结论中的关键数字没有出现在引用原文：${missing.join('、')}` };
  return { passed: true, reason: `${material.name} ${claim.locator} 与原文一致。` };
}

export function validateResearchResult(task, result) {
  const observations = Array.isArray(result?.observations) ? result.observations : [];
  const ready = task.materials.filter((item) => item.status === 'ready');
  const checks = observations.map((claim) => validateClaim(task, claim));
  const covered = new Set(observations.filter((_, index) => checks[index]?.passed).map((item) => item.materialId));
  const missingMaterials = ready.filter((item) => !covered.has(item.id));
  if (!observations.length || checks.some((item) => !item.passed) || missingMaterials.length) {
    const messages = checks.filter((item) => !item.passed).map((item) => item.reason);
    if (!observations.length) messages.push('研究结果没有可核对观察。');
    if (missingMaterials.length) messages.push(`未覆盖材料：${missingMaterials.map((item) => item.name).join('、')}`);
    throw new Error(messages.join(' '));
  }
  return result;
}

export function groundingChecks(task, artifact) {
  const claims = Array.isArray(artifact.claims) ? artifact.claims : [];
  const ready = task.materials.filter((item) => item.status === 'ready');
  const results = claims.map((claim) => validateClaim(task, claim));
  const validClaims = claims.filter((_, index) => results[index]?.passed);
  const allSourceLinksValid = claims.length > 0 && results.every((item) => item.passed);
  const sourceTokens = new Set(validClaims.flatMap((claim) => criticalTokens(claim.quote)));
  const allowedContextTokens = new Set(criticalTokens([
    task.goal?.versions?.find((item) => item.id === task.goal.activeVersionId)?.statement,
    ...(task.goal?.versions?.find((item) => item.id === task.goal.activeVersionId)?.successCriteria || []),
    ...(task.goal?.versions?.find((item) => item.id === task.goal.activeVersionId)?.boundaries || []),
  ].join('\n')));
  const derivedNumbers = new Set((artifact.derivations || []).filter((item) => item.tool === 'calculate' && item.ok && Number.isFinite(item.result?.result)
    && Array.isArray(item.result?.inputs) && item.result.inputs.every((input) => input.sourceRef && input.evidence?.quote)).map((item) => String(item.result.result)));
  const numberPart = (token) => token.replaceAll(',', '').match(/[-+]?\d+(?:\.\d+)?/)?.[0] || '';
  let actualDeliveredContent = [artifact.content, ...(artifact.deliverables || []).map((entry) => entry.content)].join('\n');
  for (const material of task.materials.filter((item) => item.generatedEvidence === true && item.fetchedAt)) {
    actualDeliveredContent = actualDeliveredContent.replaceAll(String(material.fetchedAt), '');
  }
  const unsupportedTokens = criticalTokens(actualDeliveredContent).filter((token) => !sourceTokens.has(token) && !allowedContextTokens.has(token) && !derivedNumbers.has(numberPart(token)));
  const detail = results.filter((item) => !item.passed).map((item) => item.reason);
  return [
    {
      name: '来源定位守卫',
      passed: ready.length === 0 || allSourceLinksValid,
      evidence: ready.length === 0 ? '没有事实材料。' : allSourceLinksValid ? `${claims.length} 条结论的材料 ID、来源名、行号和逐字引文可追溯；这不证明自然语言结论受原文蕴含。` : detail.join(' ') || '候选缺少可定位来源结论。',
      blocking: true,
    },
    {
      name: '关键数值守卫',
      passed: unsupportedTokens.length === 0,
      evidence: unsupportedTokens.length ? `正文中的关键数字未获原文支持：${[...new Set(unsupportedTokens)].join('、')}` : '这里只证明价格、日期、周期等关键数字能在有效引用或目标条件中找到；不证明主体、关系或自然语言蕴含。',
      blocking: true,
    },
    {
      name: '派生数值来源守卫',
      passed: (artifact.derivations || []).every((item) => item.tool !== 'calculate' || (item.ok && Number.isFinite(item.result?.result) && item.result.inputs?.every((input) => input.sourceRef && input.evidence?.quote))),
      evidence: (artifact.derivations || []).length ? `${artifact.derivations.filter((item) => item.tool === 'calculate').length} 条计算记录保留了表达式、输入原文位置和确定性结果。` : '候选没有记录派生数值。',
      blocking: true,
    },
  ];
}

export function demoResearch(task) {
  const observations = sourcePackets(task).map((packet) => {
    const first = packet.excerpt.split('\n').find((line) => line.replace(/^\d+\|\s*/, '').trim()) || '';
    const lineNumber = Number(first.match(/^(\d+)\|/)?.[1] || 1);
    const quote = first.replace(/^\d+\|\s*/, '').trim();
    return {
      statement: `${packet.sourceName}：${quote}`,
      materialId: packet.materialId,
      sourceName: packet.sourceName,
      locator: `L${lineNumber}-L${lineNumber}`,
      quote,
    };
  });
  return {
    summary: `演示材料整理覆盖 ${observations.length} 份可读材料；这不是模型研究。`,
    observations,
    missingFacts: task.materials.filter((item) => item.status !== 'ready').map((item) => `${item.name} 无法读取：${item.error || '未知原因'}`),
  };
}
