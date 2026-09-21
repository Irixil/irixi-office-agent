import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const VALID_TASK_TYPES = new Set(['document', 'research', 'email', 'calendar']);
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
  const type = VALID_TASK_TYPES.has(input.type) ? input.type : 'document';
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
    provider: input.provider === 'codex-cli' ? 'codex-cli' : 'demo',
    goal: { activeVersionId: goalVersion.id, versions: [goalVersion] },
    materials: [],
    suggestions: [],
    workItems: [],
    artifacts: [],
    reviews: [],
    approvals: [],
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
  if (/(改成|替换目标|不再.+而|最终目标|换成|instead|replace)/i.test(value)) return 'replace';
  if (/(以后|顺便|另一个|先记着|下一版|无关|later|backlog)/i.test(value)) return 'deviate';
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
    classification,
    status: classification === 'replace' ? 'waiting_user' : classification === 'deviate' ? 'later' : 'routed',
    createdAt: now(),
    correctedAt: null,
  };
  task.suggestions.push(suggestion);
  if (classification === 'replace') {
    setTaskState(task, 'waiting_user', 'coordinator', '发现可能替代当前目标的建议，已暂停受影响工作。');
  } else {
    event(task, 'suggestion.routed', `建议已归入“${classification}”。`, { suggestionId: suggestion.id, classification });
  }
  return suggestion;
}

export function correctSuggestion(task, suggestionId, classification) {
  if (!VALID_SUGGESTIONS.has(classification)) throw new Error('未知的建议分类。');
  const suggestion = task.suggestions.find((item) => item.id === suggestionId);
  if (!suggestion) throw new Error('找不到这条建议。');
  const previous = suggestion.classification;
  suggestion.classification = classification;
  suggestion.status = classification === 'replace' ? 'waiting_user' : classification === 'deviate' ? 'later' : 'routed';
  suggestion.correctedAt = now();
  event(task, 'suggestion.corrected', `建议分类从“${previous}”改为“${classification}”，计划需要重新核对。`, {
    suggestionId,
    previous,
    classification,
  });
  if (classification === 'replace') setTaskState(task, 'waiting_user', 'coordinator');
  else if (previous === 'replace' && !task.suggestions.some((item) => item.id !== suggestionId && item.classification === 'replace' && item.status === 'waiting_user')) {
    setTaskState(task, task.workItems.length ? 'ready' : 'idle', 'coordinator', '替代目标警报已解除；当前目标继续有效，计划需要重新核对。');
  }
  return suggestion;
}

export function acceptGoalReplacement(task, suggestionId, statement) {
  const suggestion = task.suggestions.find((item) => item.id === suggestionId);
  if (!suggestion || suggestion.classification !== 'replace') throw new Error('这不是一条待确认的替代目标。');
  const current = activeGoal(task);
  const nextStatement = cleanText(statement || suggestion.text, 4_000);
  if (!nextStatement) throw new Error('新目标不能为空。');
  current.status = 'superseded';
  const version = {
    id: makeId('goal'),
    version: task.goal.versions.length + 1,
    statement: nextStatement,
    successCriteria: [...current.successCriteria],
    boundaries: [...current.boundaries],
    status: 'active',
    acceptedAt: now(),
    createdAt: now(),
    predecessorId: current.id,
  };
  task.goal.versions.push(version);
  task.goal.activeVersionId = version.id;
  suggestion.status = 'accepted';
  task.workItems = [];
  setTaskState(task, 'idle', 'coordinator', `新目标 v${version.version} 已接受，旧计划已作废。`);
  return version;
}

export function addMaterial(task, input = {}) {
  const text = cleanText(input.text, 1_500_000);
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
  task.materials.push(material);
  event(task, 'material.added', `${material.name} 已进入材料账本。`, { materialId: material.id, status: material.status });
  return material;
}

export function buildPlan(task) {
  const goal = activeGoal(task);
  const hasUrl = task.materials.some((item) => item.kind === 'url');
  const definitions = [
    ['archivist', '整理材料与未知项', '材料清单与来源摘要'],
    ...(hasUrl || task.type === 'research' ? [['researcher', '研究与交叉核对', '研究笔记与待核实项']] : []),
    ['writer', task.type === 'email' ? '起草邮件' : task.type === 'calendar' ? '起草日程' : '起草候选成果', '候选成果 v1'],
    ['reviewer', '独立核对目标、来源与边界', '逐项审阅结果'],
    ['steward', '准备指定版本的正式交付', '等待用户确认'],
  ];
  task.workItems = definitions.map(([role, title, expected], index) => ({
    id: makeId('work'),
    title,
    role,
    status: index === 0 ? 'ready' : 'pending',
    goalVersionId: goal.id,
    expectedResult: expected,
  }));
  setTaskState(task, 'ready', 'coordinator', `已形成 ${task.workItems.length} 个可检查步骤。`);
  return task.workItems;
}

export function createArtifact(task, result, provider) {
  const goal = activeGoal(task);
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
    provider,
    createdByRole: provider === 'human-edit' ? 'user' : 'writer',
    goalVersionId: goal.id,
    status: 'candidate',
    reviewStatus: 'pending',
    previousId: task.artifacts.at(-1)?.id || null,
    createdAt: now(),
  };
  if (!artifact.content) throw new Error('提供者没有返回可用的候选内容。');
  task.artifacts.push(artifact);
  event(task, 'artifact.created', `候选成果 v${version} 已生成。`, { artifactId: artifact.id, provider });
  return artifact;
}

export function reviseArtifact(task, artifactId, input = {}) {
  const base = task.artifacts.find((item) => item.id === artifactId);
  if (!base) throw new Error('找不到要修改的候选版本。');
  return createArtifact(task, {
    title: input.title || base.title,
    summary: input.summary || `基于 v${base.version} 的人工修改`,
    content: input.content,
    sources: base.sources,
  }, 'human-edit');
}

export function recordReview(task, artifactId, result) {
  const artifact = task.artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw new Error('找不到要核对的候选成果。');
  const checks = Array.isArray(result.checks) ? result.checks.map((item) => ({
    name: cleanText(item.name, 120),
    passed: Boolean(item.passed),
    evidence: cleanText(item.evidence, 1_000),
    blocking: item.blocking !== false,
  })) : [];
  const passed = checks.length > 0 && checks.every((item) => item.passed || !item.blocking);
  const review = {
    id: makeId('review'),
    artifactId,
    goalVersionId: artifact.goalVersionId,
    checks,
    summary: cleanText(result.summary, 2_000),
    passed,
    provider: cleanText(result.provider, 80) || 'deterministic',
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
  if (artifact.reviewStatus !== 'passed') throw new Error('这个版本尚未通过独立核对，不能确认。');
  for (const item of task.artifacts) if (item.status === 'confirmed') item.status = 'superseded_formal';
  artifact.status = 'confirmed';
  artifact.confirmedAt = now();
  const approval = {
    id: makeId('approval'),
    action: 'export-new-file',
    artifactId,
    artifactVersion: artifact.version,
    status: 'confirmed',
    decidedAt: now(),
  };
  task.approvals.push(approval);
  setTaskState(task, 'ready_to_export', 'steward', `已确认指定版本 v${artifact.version}，可以导出新文件。`);
  return approval;
}

export function assertExportAllowed(task, artifactId, approvalId) {
  const artifact = task.artifacts.find((item) => item.id === artifactId);
  if (!artifact) throw new Error('找不到要导出的成果。');
  if (artifact.status !== 'confirmed') throw new Error('只有明确确认的指定版本才能导出。');
  const approval = task.approvals.find((item) => item.id === approvalId && item.artifactId === artifactId && item.status === 'confirmed');
  if (!approval) throw new Error('缺少这个指定版本的有效导出确认。');
  return artifact;
}

export function publicTask(task) {
  return structuredClone(task);
}

export function createStore(root) {
  const tasksRoot = path.resolve(root);
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
      const task = await this.get(id);
      const previousEventIds = new Set(task.events.map((item) => item.id));
      const result = await change(task);
      await this.save(task);
      for (const item of task.events) if (!previousEventIds.has(item.id)) await this.appendAudit(task, item);
      return { task, result };
    },
  };
}

export const __test = { cleanText, cleanList, VALID_TASK_TYPES, VALID_SUGGESTIONS };
