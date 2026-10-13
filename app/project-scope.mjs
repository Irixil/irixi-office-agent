import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const GENERIC_REPOSITORY_ID = 'irixi-office-agent';
export const GENERIC_EXECUTION_MODE = 'host_bounded_transaction_v1';
export const GENERIC_FIXTURE_ID = 'irixi-bounded-js-v1';
export const SCOPE_LIMITS = Object.freeze({ readableFiles: 8, editableFiles: 2, checks: 3, cases: 12, fileBytes: 128 * 1024, totalBytes: 512 * 1024, jsonBytes: 16 * 1024, jsonDepth: 8, jsonNodes: 256 });
const SAFE_RELATIVE = /^(?:app\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.(?:js|mjs)$/u;
const SAFE_EXPORT = /^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/u;
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,79}$/u;
const FORBIDDEN_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const PRIVATE_SOURCE_STEMS = new Set(['env', 'environment', 'key', 'keys', 'secret', 'secrets', 'credential', 'credentials']);

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const scopeFingerprint = (value) => sha256(canonical(value));

function clean(value, limit) { return String(value ?? '').replaceAll('\u0000', '').trim().slice(0, limit); }
function cleanList(value, max, limit) { return (Array.isArray(value) ? value : []).map((entry) => clean(entry, limit)).filter(Boolean).slice(0, max); }
function safeRelative(value) {
  const relative = clean(value, 240);
  if (!SAFE_RELATIVE.test(relative) || relative.includes('..') || path.posix.normalize(relative) !== relative) throw new Error(`项目范围包含不安全路径：${relative || '空路径'}。`);
  return relative;
}

export function assertPlainJson(value, limits = SCOPE_LIMITS) {
  let nodes = 0;
  const visit = (item, depth) => {
    nodes += 1;
    if (nodes > limits.jsonNodes || depth > limits.jsonDepth) throw new Error('JSON 用例超过深度或节点上限。');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('JSON 用例不能包含非有限数值。');
      return;
    }
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    if (typeof item !== 'object' || (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)) throw new Error('JSON 用例只能包含普通 JSON 值。');
    for (const [key, child] of Object.entries(item)) {
      if (FORBIDDEN_JSON_KEYS.has(key)) throw new Error('JSON 用例包含原型相关字段。');
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  if (Buffer.byteLength(canonical(value)) > limits.jsonBytes) throw new Error('JSON 用例超过字节上限。');
  return value;
}

function parseJsonTransport(value, label) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value) > SCOPE_LIMITS.jsonBytes) throw new Error(`${label} 必须是有界 JSON 字符串。`);
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error(`${label} 不是合法 JSON。`); }
  assertPlainJson(parsed);
  return parsed;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonical(Object.keys(value).sort()) !== canonical([...expected].sort())) throw new Error(`${label} 字段缺失或包含多余字段。`);
}

async function regularFile(root, relative) {
  const realRoot = await fs.realpath(root);
  let file = realRoot;
  const segments = relative.split('/');
  for (const [index, segment] of segments.entries()) {
    file = path.join(file, segment);
    const node = await fs.lstat(file);
    if (node.isSymbolicLink()) throw new Error('登记源码路径不能包含符号链接。');
    if (index < segments.length - 1 && !node.isDirectory()) throw new Error('登记源码路径中间段不是目录。');
  }
  const realFile = await fs.realpath(file);
  if (!realFile.startsWith(`${realRoot}${path.sep}`)) throw new Error('登记源码路径越界。');
  const stat = await fs.lstat(realFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error('登记源码必须是有界独立普通文件。');
  const bytes = await fs.readFile(realFile);
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes), selectable: bytes.length <= SCOPE_LIMITS.fileBytes };
}

export async function registeredRepository(projectRoot) {
  const root = await fs.realpath(projectRoot);
  const names = [];
  for (const name of await fs.readdir(path.join(root, 'app'))) if (name.endsWith('.mjs') && !PRIVATE_SOURCE_STEMS.has(path.parse(name).name.toLowerCase())) names.push(`app/${name}`);
  for (const name of await fs.readdir(path.join(root, 'app', 'public'))) if (name.endsWith('.js') && !PRIVATE_SOURCE_STEMS.has(path.parse(name).name.toLowerCase())) names.push(`app/public/${name}`);
  const files = [];
  let total = 0;
  for (const relative of names.sort()) {
    const entry = await regularFile(root, relative);
    total += entry.bytes;
    if (total > 2 * 1024 * 1024) throw new Error('登记仓库安全源码目录超过固定清单上限。');
    files.push(entry);
  }
  const body = { repositoryId: GENERIC_REPOSITORY_ID, files };
  return { ...body, treeSha256: scopeFingerprint(body) };
}

function validateChecks(rawChecks, readable, editable) {
  const checks = Array.isArray(rawChecks) ? rawChecks : [];
  if (!checks.length || checks.length > SCOPE_LIMITS.checks) throw new Error(`必须选择 1–${SCOPE_LIMITS.checks} 个固定检查。`);
  const normalized = checks.map((raw) => {
    exactKeys(raw, ['id', 'modulePath', 'namedExport', 'cases'], '固定检查');
    const id = clean(raw?.id, 80);
    if (id === 'node-syntax-v1') {
      if (raw.modulePath !== null || raw.namedExport !== null || raw.cases !== null) throw new Error('Node syntax 检查的非适用字段必须明确为 null。');
      return { id };
    }
    if (id !== 'json-function-v1') throw new Error('只能选择登记的 syntax 或 JSON 纯函数检查。');
    const modulePath = safeRelative(raw.modulePath);
    if (!readable.includes(modulePath) || !editable.includes(modulePath)) throw new Error('JSON 纯函数模块必须在本次可读且可改范围。');
    const namedExport = clean(raw.namedExport, 80);
    if (!SAFE_EXPORT.test(namedExport)) throw new Error('JSON 纯函数 named export 不合法。');
    const cases = Array.isArray(raw.cases) ? raw.cases : [];
    if (!cases.length || cases.length > SCOPE_LIMITS.cases) throw new Error(`JSON 纯函数检查必须包含 1–${SCOPE_LIMITS.cases} 个用例。`);
    const seen = new Set();
    return {
      id, modulePath, namedExport,
      cases: cases.map((item) => {
        exactKeys(item, ['id', 'argsJson', 'expectedJson'], 'JSON 纯函数用例');
        const caseId = clean(item?.id, 80);
        if (!SAFE_ID.test(caseId) || seen.has(caseId)) throw new Error('JSON 纯函数用例 id 缺失、重复或不安全。');
        seen.add(caseId);
        const args = parseJsonTransport(item.argsJson, `用例 ${caseId} 的 argsJson`);
        const expected = parseJsonTransport(item.expectedJson, `用例 ${caseId} 的 expectedJson`);
        if (!Array.isArray(args)) throw new Error('JSON 纯函数用例 argsJson 解码后必须是数组。');
        return { id: caseId, args: structuredClone(args), expected: structuredClone(expected) };
      }),
    };
  });
  if (normalized.filter((entry) => entry.id === 'node-syntax-v1').length !== 1) throw new Error('通用源码范围必须且只能包含一项固定 Node syntax 检查。');
  const behaviorModules = normalized.filter((entry) => entry.id === 'json-function-v1').map((entry) => entry.modulePath);
  if (new Set(behaviorModules).size !== behaviorModules.length || editable.some((entry) => !behaviorModules.includes(entry))) {
    throw new Error('每个可改纯函数模块必须且只能有一组用户可核对的 JSON 行为用例。');
  }
  return normalized;
}

export function validateProjectScopeResult(input, repository, taskInputBinding) {
  if (!repository || repository.repositoryId !== GENERIC_REPOSITORY_ID) throw new Error('未知的登记源码仓库。');
  if (input?.repositoryId !== GENERIC_REPOSITORY_ID) throw new Error('范围建议只能选择登记的 Irixi 源码仓库。');
  if (input?.deliverable !== 'project_patch') throw new Error('通用源码范围只能交付隔离候选 patch。');
  const available = new Set(repository.files.filter((entry) => entry.selectable !== false).map((entry) => entry.path));
  const readablePaths = [...new Set((Array.isArray(input.readablePaths) ? input.readablePaths : []).map(safeRelative))].sort();
  const editablePaths = [...new Set((Array.isArray(input.editablePaths) ? input.editablePaths : []).map(safeRelative))].sort();
  if (!readablePaths.length || readablePaths.length > SCOPE_LIMITS.readableFiles) throw new Error(`可读文件必须为 1–${SCOPE_LIMITS.readableFiles} 个。`);
  if (!editablePaths.length || editablePaths.length > Math.min(SCOPE_LIMITS.editableFiles, SCOPE_LIMITS.checks - 1)) throw new Error('首版可改文件必须为 1–2 个，且每个文件都要有独立 JSON 行为检查。');
  if (readablePaths.some((entry) => !available.has(entry)) || editablePaths.some((entry) => !available.has(entry) || !readablePaths.includes(entry))) throw new Error('范围建议包含仓库外文件或可改文件未纳入可读范围。');
  const byPath = new Map(repository.files.map((entry) => [entry.path, entry]));
  if (readablePaths.reduce((sum, entry) => sum + byPath.get(entry).bytes, 0) > SCOPE_LIMITS.totalBytes) throw new Error('所选可读源码超过总字节上限。');
  const goal = {
    statement: clean(input.goal?.statement, 4_000),
    successCriteria: cleanList(input.goal?.successCriteria, 12, 500),
    boundaries: cleanList(input.goal?.boundaries, 12, 500),
  };
  if (!goal.statement || !goal.successCriteria.length || !goal.boundaries.length) throw new Error('需求卡必须完整包含目的、验收条件和工作边界。');
  const checks = validateChecks(input.checks, readablePaths, editablePaths);
  const rationale = clean(input.rationale, 2_000);
  if (!rationale) throw new Error('范围建议必须解释文件与检查为何足够。');
  const body = {
    repositoryId: GENERIC_REPOSITORY_ID,
    repositoryTreeSha256: repository.treeSha256,
    goal,
    deliverable: 'project_patch',
    readablePaths,
    editablePaths,
    checks,
    rationale,
    taskInputBinding: structuredClone(taskInputBinding),
  };
  return { id: `scope-${crypto.randomUUID()}`, status: 'proposed', ...body, fingerprint: scopeFingerprint(body) };
}

export function acceptedProposalCurrent(proposal, taskInputBinding, repositoryTreeSha256) {
  if (!proposal || proposal.status !== 'accepted' || !proposal.acceptedTaskInputBinding) return false;
  return canonical(proposal.acceptedTaskInputBinding) === canonical(taskInputBinding)
    && proposal.repositoryTreeSha256 === repositoryTreeSha256;
}

export function publicProjectScope(task) {
  const proposal = task.projectScopeProposal;
  if (!proposal) return null;
  const { taskInputBinding: _old, acceptedTaskInputBinding: _accepted, ...visible } = proposal;
  return structuredClone(visible);
}
