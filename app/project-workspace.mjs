import crypto from 'node:crypto';
import fsSync, { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { materialContext } from './material-applicability.mjs';
import {
  acceptedProposalCurrent,
  assertPlainJson,
  GENERIC_EXECUTION_MODE,
  GENERIC_FIXTURE_ID,
  registeredRepository,
  SCOPE_LIMITS,
  scopeFingerprint as genericFingerprint,
} from './project-scope.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const HOST_VERIFIER_PATH = fileURLToPath(import.meta.url);
const DEFAULT_FIXTURE_ROOT = path.join(moduleDir, 'project-fixtures', 'node-single-file-v1', 'workspace');
const DEFAULT_WRAPPER = path.join(moduleDir, 'project-runtime', 'fixed-export-wrapper.mjs');
const GENERIC_JSON_WRAPPER = path.join(moduleDir, 'project-runtime', 'generic-json-function-wrapper.mjs');
const CONTINUITY_WRAPPER = path.join(moduleDir, 'project-runtime', 'fixed-continuity-wrapper.mjs');
const DEFAULT_PROBE_WRAPPER = path.join(moduleDir, 'project-runtime', 'capability-probe-wrapper.mjs');
const IRIXI_PROJECT_ROOT = path.resolve(moduleDir, '..');
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const MAX_OUTPUT_BYTES = 4 * 1024;
const POLICY_VERSION = 2;
const PROFILE_VERSION = 'macos-node-contract-v1';
const SAFE_SEGMENT = /^[^/\\\u0000]+$/u;

const DEFAULT_FIXTURES = Object.freeze({
  'node-single-file-v1': Object.freeze({
    id: 'node-single-file-v1',
    label: 'Node 单文件练习项目',
    sourceRoot: DEFAULT_FIXTURE_ROOT,
    snapshotPaths: Object.freeze(['package.json', 'src/greeting.mjs', 'checks/check.mjs']),
    readablePaths: Object.freeze(['package.json', 'src/greeting.mjs']),
    editablePaths: Object.freeze(['src/greeting.mjs']),
    candidateModulePath: 'src/greeting.mjs',
    publicContract: Object.freeze({
      id: 'greet-name-contract-v1',
      namedExport: 'greetName',
      input: '一个字符串 name',
      behavior: '去掉 name 首尾空白；非空时返回“Hello, <name>!”，空白名称返回“Hello, friend!”。',
    }),
    check: Object.freeze({ id: 'greet-name-contract-v1', trustedParentPath: 'checks/check.mjs' }),
    limits: Object.freeze({ maxFiles: 8, maxFileBytes: MAX_TEXT_BYTES, maxTotalBytes: MAX_TOTAL_BYTES }),
  }),
  'irixi-continuity-ui-v1': Object.freeze({
    id: 'irixi-continuity-ui-v1',
    label: 'Irixi 续接状态小修复',
    executionMode: 'host_fixed_transaction_v1',
    sourceRoot: IRIXI_PROJECT_ROOT,
    snapshotPaths: Object.freeze([
      'package.json',
      'app/public/app.js',
      'app/project-fixtures/irixi-continuity-ui-v1/checks/check.mjs',
    ]),
    readablePaths: Object.freeze(['app/public/app.js']),
    editablePaths: Object.freeze(['app/public/app.js']),
    candidateModulePath: 'app/public/app.js',
    wrapperPath: CONTINUITY_WRAPPER,
    region: Object.freeze({
      path: 'app/public/app.js',
      id: 'render-continuity-function-v1',
      startMarker: 'function renderContinuity(task) {',
      endMarker: '\n}\n\nfunction renderProject(task) {',
      maxBytes: 8 * 1024,
    }),
    publicContract: Object.freeze({
      id: 'render-continuity-terminal-state-v1',
      entrypoint: 'renderContinuity',
      input: '宿主提供的 task 与 continuity 公开状态',
      inputInterface: Object.freeze({
        version: 1,
        fields: Object.freeze([
          Object.freeze({ path: 'task.status', type: 'string', purpose: '当前任务状态' }),
          Object.freeze({ path: 'task.execution.stopReason', type: 'string|null', purpose: '宿主保存的实际停止原因' }),
          Object.freeze({ path: 'task.runtime.activeJob', type: 'object|null', purpose: '当前正在运行的宿主工作' }),
          Object.freeze({ path: 'task.continuity.candidate.confirmed', type: 'boolean|undefined', purpose: '指定候选是否已确认' }),
          Object.freeze({ path: 'task.continuity.progress.done', type: 'string[]', purpose: '已完成记录' }),
          Object.freeze({ path: 'task.continuity.progress.incomplete', type: 'string[]', purpose: '未完成记录' }),
          Object.freeze({ path: 'task.continuity.progress.stoppedBecause', type: 'string|null', purpose: '用户可读停止原因' }),
          Object.freeze({ path: 'task.continuity.progress.nextStep', type: 'string', purpose: '用户可读下一步' }),
          Object.freeze({ path: 'task.continuity.progress.needsUserDecision', type: 'boolean', purpose: '是否等待用户决定' }),
        ]),
      }),
      behavior: '仅修改 app/public/app.js 中完整 renderContinuity 函数。预算耗尽、永久错误、同错耗尽、固定业务检查未通过和固定项目事务未完成必须显示红色“需要先处理”；普通可恢复状态仍显示“Irixi 可继续”，忙碌、下载和等待决定状态保持原语义。除指定 badge/tone 外，现有完整 HTML 结构、文本和转义必须保持不变。',
      writeScope: 'workspace.read/write 只暴露并替换固定 renderContinuity 函数片段；整文件候选与区域外字节由宿主校验。',
    }),
    check: Object.freeze({ id: 'render-continuity-terminal-state-v1', trustedParentPath: 'app/project-fixtures/irixi-continuity-ui-v1/checks/check.mjs' }),
    limits: Object.freeze({ maxFiles: 8, maxFileBytes: MAX_TEXT_BYTES, maxTotalBytes: MAX_TOTAL_BYTES }),
  }),
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const makeId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const fingerprint = (value) => sha256(canonical(value));
const PROFILE_TEMPLATE_SHA256 = fingerprint({
  version: PROFILE_VERSION,
  systemReadSubpaths: ['/System/Library', '/usr/lib', '/Library/Apple/System/Library'],
  sysctls: ['hw.ncpu', 'hw.activecpu', 'hw.physicalcpu', 'hw.logicalcpu', 'hw.memsize', 'hw.pagesize', 'hw.pagesize_compat', 'hw.machine', 'kern.osrelease', 'kern.osversion', 'kern.ostype', 'kern.hostname', 'kern.version'],
  machLookups: [], network: 'deny', writes: 'deny', process: 'fixed-node-initial-exec',
});
const EXECUTION_CONTRACT_SHA256 = fingerprint({
  profileTemplateSha256: PROFILE_TEMPLATE_SHA256,
  nodeArgs: ['--max-old-space-size=64'],
  caseTimeoutMs: 2_000,
  stdoutCapBytes: MAX_OUTPUT_BYTES,
  stderrCapBytes: MAX_OUTPUT_BYTES,
  environmentKeys: ['LANG', 'LC_ALL'],
  protocol: 'one-typed-json-envelope-v1',
});

function conflict(message, code = 'stale_project_workspace') {
  const error = new Error(message);
  error.status = 409;
  error.code = code;
  error.publicSafe = true;
  return error;
}

function projectError(message, code = 'project_workspace_error', status = 400) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.publicSafe = true;
  return error;
}

function sanitizeProjectError(error, fallback = '项目工作区操作失败；未暴露本机路径或子进程原始输出。') {
  if (error?.publicSafe || error?.code === 'cancelled') return error;
  const safe = projectError(fallback, 'project_workspace_error', Number(error?.status) || 400);
  safe.cause = error;
  return safe;
}

function assertRelative(relative) {
  const text = String(relative || '');
  if (!text || path.isAbsolute(text) || text.includes('\u0000')) throw new Error('项目相对路径不合法。');
  const segments = text.split('/');
  if (segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..')) throw new Error('项目相对路径越界。');
  const normalized = path.posix.normalize(text);
  if (normalized !== text) throw new Error('项目相对路径必须使用规范形式。');
  return text;
}

function resolveInside(root, relative) {
  const safe = assertRelative(relative);
  const file = path.resolve(root, ...safe.split('/'));
  if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error('项目路径越界。');
  return file;
}

async function assertDirectoryChainNoLinks(root) {
  const absolute = path.resolve(root);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('项目工作区目录链不能包含符号链接。');
    if (!stat.isDirectory()) throw new Error('项目工作区目录链包含非目录节点。');
  }
  return absolute;
}

async function assertRegularNoLinks(root, relative) {
  const safe = assertRelative(relative);
  let current = await assertDirectoryChainNoLinks(root);
  for (const segment of safe.split('/')) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error(`项目路径不能包含符号链接：${safe}`);
    if (current !== resolveInside(root, safe) && !stat.isDirectory()) throw new Error(`项目路径中间段不是目录：${safe}`);
  }
  const stat = await fs.lstat(current);
  if (!stat.isFile()) throw new Error(`项目只接受普通文件：${safe}`);
  if (stat.nlink !== 1) throw new Error(`项目文件不能使用硬链接：${safe}`);
  return { file: current, stat };
}

async function readRegular(root, relative, maxBytes = MAX_TEXT_BYTES) {
  const { file } = await assertRegularNoLinks(root, relative);
  const handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error(`项目文件超过上限或不是独立普通文件：${relative}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.nlink !== after.nlink
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || bytes.length !== after.size) throw new Error(`项目文件在读取期间变化：${relative}`);
    return bytes;
  } finally { await handle.close(); }
}

function fixedRegionFor(fixture, relative, bytes) {
  if (!fixture.region || fixture.region.path !== relative) {
    return { content: bytes, prefix: Buffer.alloc(0), suffix: Buffer.alloc(0), region: null };
  }
  const text = bytes.toString('utf8');
  if (text.includes('\uFFFD')) throw projectError('固定函数文件不是有效 UTF-8。', 'project_region_invalid');
  const { startMarker, endMarker } = fixture.region;
  const start = text.indexOf(startMarker);
  const endStart = start < 0 ? -1 : text.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || endStart < 0
    || text.indexOf(startMarker, start + startMarker.length) !== -1
    || text.indexOf(endMarker, endStart + endMarker.length) !== -1) {
    throw conflict('固定 renderContinuity 函数边界缺失或不唯一，请重新授权。', 'project_region_changed');
  }
  const end = endStart + 2;
  const prefix = Buffer.from(text.slice(0, start), 'utf8');
  const content = Buffer.from(text.slice(start, end), 'utf8');
  const suffix = Buffer.from(text.slice(end), 'utf8');
  if (Buffer.concat([prefix, content, suffix]).compare(bytes) !== 0 || content.length > fixture.region.maxBytes) {
    throw conflict('固定 renderContinuity 函数区域无效或超过上限。', 'project_region_changed');
  }
  return { content, prefix, suffix, region: fixture.region };
}

function assertReplacementRegion(fixture, relative, content) {
  if (!fixture.region || fixture.region.path !== relative) return;
  const bytes = Buffer.from(content, 'utf8');
  const { startMarker, endMarker, maxBytes } = fixture.region;
  if (bytes.length > maxBytes || !content.startsWith(startMarker)
    || content.indexOf(startMarker, startMarker.length) !== -1
    || content.includes(endMarker)
    || !content.endsWith('}')) {
    throw projectError('只能提交完整且唯一的 renderContinuity 函数。', 'project_region_invalid');
  }
}

function assertGenericModulePolicy(content) {
  const forbidden = /\b(?:import|await|process|globalThis|fetch|require|eval|Function|WebSocket|XMLHttpRequest|setTimeout|setInterval)\b/u;
  if (forbidden.test(content) || /\basync\s+function\b/u.test(content) || /=>\s*import\s*\(/u.test(content)) {
    throw projectError('本版 JSON 纯函数模块不能包含 import、异步执行、进程或外部副作用入口。', 'project_pure_module_required');
  }
}

function assertRegionOutsideMatches(fixture, relative, sourceBytes, candidateBytes) {
  if (!fixture.region || fixture.region.path !== relative) return;
  const source = fixedRegionFor(fixture, relative, sourceBytes);
  const candidate = fixedRegionFor(fixture, relative, candidateBytes);
  if (source.prefix.length !== candidate.prefix.length || source.suffix.length !== candidate.suffix.length
    || sha256(source.prefix) !== sha256(candidate.prefix) || sha256(source.suffix) !== sha256(candidate.suffix)) {
    throw conflict('固定函数区域外的候选字节已变化。', 'project_region_outside_changed');
  }
}

function wrapperPathFor(fixture) {
  return path.resolve(fixture.wrapperPath || DEFAULT_WRAPPER);
}

function contractFingerprint(fixture, contract) {
  const descriptor = { id: contract.id, exportName: contract.exportName, resultType: contract.resultType, caseIds: contract.cases.map((entry) => entry.id) };
  if (fixture.region) descriptor.fixedRegion = {
    id: fixture.region.id, path: fixture.region.path,
    startMarker: fixture.region.startMarker, endMarker: fixture.region.endMarker,
    maxBytes: fixture.region.maxBytes,
  };
  return fingerprint(descriptor);
}

async function manifestFor(root, paths, limits = {}) {
  const maxFiles = limits.maxFiles || 32;
  const maxFileBytes = limits.maxFileBytes || MAX_TEXT_BYTES;
  const maxTotalBytes = limits.maxTotalBytes || MAX_TOTAL_BYTES;
  const names = [...new Set(paths.map(assertRelative))].sort();
  if (names.length > maxFiles) throw new Error('项目文件数量超过安全上限。');
  let total = 0;
  const manifest = [];
  for (const relative of names) {
    const bytes = await readRegular(root, relative, maxFileBytes);
    total += bytes.length;
    if (total > maxTotalBytes) throw new Error('项目文件总大小超过安全上限。');
    manifest.push({ path: relative, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return manifest;
}

function manifestHash(manifest) {
  return fingerprint(manifest.map(({ path: file, bytes, sha256: hash }) => [file, bytes, hash]));
}

async function copyManifest(sourceRoot, destinationRoot, manifest) {
  await assertDirectoryChainNoLinks(path.dirname(destinationRoot));
  try { await fs.mkdir(destinationRoot, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await assertDirectoryChainNoLinks(destinationRoot);
  for (const entry of manifest) {
    const bytes = await readRegular(sourceRoot, entry.path, Math.max(entry.bytes, 1));
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw conflict(`复制前源文件已变化：${entry.path}`, 'project_source_changed');
    const target = resolveInside(destinationRoot, entry.path);
    await ensureSafeDirectory(destinationRoot, path.posix.dirname(entry.path));
    const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
  }
}

async function ensureSafeDirectory(root, relativeDirectory) {
  const absoluteRoot = await assertDirectoryChainNoLinks(root);
  const relative = relativeDirectory === '.' ? '' : String(relativeDirectory || '');
  let current = absoluteRoot;
  for (const segment of relative ? relative.split('/') : []) {
    if (!SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') throw projectError('项目目录路径不合法。');
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw projectError('项目目录链包含链接或非目录节点。');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(current, { mode: 0o700 });
      const created = await fs.lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) throw projectError('项目目录创建后类型不安全。');
    }
  }
  const final = await fs.realpath(current);
  if (final !== current || !final.startsWith(absoluteRoot)) throw projectError('项目目录链在操作期间变化。');
  return current;
}

function taskGoalId(task) {
  return task?.goal?.activeVersionId || null;
}

export function projectTaskBinding(task) {
  const goalVersionId = taskGoalId(task);
  return {
    goalVersionId,
    projectRootGoalVersionId: task.projectRootGoalVersionId || goalVersionId,
    projectRootInputFingerprint: task.projectRootInputFingerprint || null,
    materialApplicabilityFingerprint: materialContext(task, { includeGeneratedEvidence: false }).fingerprint,
    instructionIds: (task.suggestions || [])
      .filter((item) => (item.goalVersionId || goalVersionId) === goalVersionId && item.classification === 'support' && item.status === 'routed')
      .map((item) => item.id).sort(),
  };
}

function sameBinding(left, right) {
  return Boolean(left && right)
    && left.goalVersionId === right.goalVersionId
    && left.projectRootGoalVersionId === right.projectRootGoalVersionId
    && (left.projectRootInputFingerprint || null) === (right.projectRootInputFingerprint || null)
    && (left.materialApplicabilityFingerprint || null) === (right.materialApplicabilityFingerprint || null)
    && canonical(left.instructionIds || []) === canonical(right.instructionIds || []);
}

function projectWorkspaceBindingIsCurrent(task) {
  if (task.type !== 'project') return true;
  const workspace = task.projectWorkspace;
  return Boolean(workspace && sameBinding(workspace.taskInputBinding, projectTaskBinding(task)));
}

function workspaceMatchesFixtureDefinition(workspace, fixture) {
  if (!workspace || !fixture) return false;
  const expectedMode = fixture.executionMode || null;
  const expectedContractFingerprint = fingerprint(fixture.publicContract);
  if (expectedMode === 'host_fixed_transaction_v1' || expectedMode === GENERIC_EXECUTION_MODE) {
    return workspace.executionMode === expectedMode
      && workspace.publicContractFingerprint === expectedContractFingerprint;
  }
  return (workspace.executionMode || null) === expectedMode
    && (!workspace.publicContractFingerprint || workspace.publicContractFingerprint === expectedContractFingerprint);
}

function projectWorkspaceDefinitionIsCurrent(task) {
  if (task.type !== 'project') return true;
  const workspace = task.projectWorkspace;
  if (!workspace) return false;
  if (workspace.fixtureId === GENERIC_FIXTURE_ID) {
    const proposal = task.projectScopeProposal;
    return proposal?.status === 'accepted'
      && workspace.proposalId === proposal.id
      && workspace.proposalFingerprint === proposal.fingerprint
      && workspace.publicContractFingerprint === fingerprint(workspace.publicContract);
  }
  const fixture = DEFAULT_FIXTURES[workspace.fixtureId];
  return fixture ? workspaceMatchesFixtureDefinition(workspace, fixture) : true;
}

export function projectWorkspaceIsCurrent(task) {
  if (task.type !== 'project') return true;
  return task.projectWorkspace?.status === 'ready'
    && projectWorkspaceBindingIsCurrent(task)
    && projectWorkspaceDefinitionIsCurrent(task);
}

function assertWorkspaceCurrent(task) {
  if (!projectWorkspaceIsCurrent(task)) {
    throw conflict('代码工作区授权属于旧目标、材料、项目关联或工作交代，请明确重新授权。', 'project_workspace_stale');
  }
}

export function projectWorkspaceFingerprint(task) {
  return task.projectWorkspace?.scopeFingerprint || null;
}

export function projectCandidateFingerprint(projectCandidate) {
  if (!projectCandidate) return null;
  return fingerprint({
    sourceSnapshotSha256: projectCandidate.sourceSnapshotSha256,
    workspaceScopeFingerprint: projectCandidate.workspaceScopeFingerprint,
    candidateId: projectCandidate.candidateId,
    candidateSha256: projectCandidate.candidateSha256,
    diffSha256: projectCandidate.diffSha256,
    patchSha256: projectCandidate.patchSha256,
    regionIntegritySha256: projectCandidate.regionIntegritySha256 || null,
    sourceIntegritySha256: projectCandidate.sourceIntegritySha256,
    projectExecutionAuditSha256: projectCandidate.projectExecutionAuditSha256,
    sandboxCapabilityFingerprint: projectCandidate.sandboxCapabilityFingerprint,
    runtimeFingerprint: projectCandidate.runtimeFingerprint,
    checks: (projectCandidate.checks || []).map((entry) => [
      entry.id, entry.checkId, entry.hostVerifierSha256, entry.trustedParentSha256,
      entry.childWrapperSha256, entry.contractSha256, entry.inputSetSha256,
      entry.expectedSetSha256, entry.executionContractSha256, entry.runtimeFingerprint,
      entry.resultDigest, entry.passed,
    ]),
    taskInputBinding: projectCandidate.taskInputBinding,
  });
}

export function projectArtifactIsCurrent(task, artifact) {
  if (task.type !== 'project') return true;
  const workspace = task.projectWorkspace;
  const evidence = artifact?.projectCandidate;
  if (!workspace || !projectWorkspaceIsCurrent(task) || !workspace.candidate || workspace.candidate.status !== 'ready' || !evidence) return false;
  const expectsRegionIntegrity = Boolean(DEFAULT_FIXTURES[workspace.fixtureId]?.region);
  const regionIntegrityCurrent = expectsRegionIntegrity
    ? Boolean(evidence.regionIntegrity && typeof evidence.regionIntegritySha256 === 'string'
      && evidence.regionIntegritySha256 === evidence.regionIntegrity.integritySha256
      && evidence.regionIntegritySha256 === fingerprint(Object.fromEntries(Object.entries(evidence.regionIntegrity).filter(([key]) => key !== 'integritySha256'))))
    : !evidence.regionIntegrity && !evidence.regionIntegritySha256;
  return evidence.workspaceScopeFingerprint === workspace.scopeFingerprint
    && evidence.sourceSnapshotSha256 === workspace.sourceSnapshotSha256
    && evidence.candidateId === workspace.candidate.id
    && evidence.candidateSha256 === workspace.candidate.candidateSha256
    && typeof evidence.sourceIntegritySha256 === 'string'
    && evidence.sourceIntegritySha256 === evidence.sourceIntegrity?.integritySha256
    && typeof evidence.projectExecutionAuditSha256 === 'string'
    && evidence.projectExecutionAuditSha256 === evidence.projectExecutionAudit?.auditSha256
    && regionIntegrityCurrent
    && evidence.projectExecutionAudit?.plan?.id === task.plan?.id
    && evidence.projectExecutionAudit?.plan?.revision === task.plan?.revision
    && evidence.sandboxCapabilityFingerprint === workspace.sandboxCapability?.fingerprint
    && evidence.runtimeFingerprint === workspace.sandboxCapability?.runtimeFingerprint
    && typeof evidence.patch === 'string'
    && sha256(evidence.patch) === evidence.patchSha256
    && sameBinding(evidence.taskInputBinding, projectTaskBinding(task));
}

export function assertProjectArtifactCurrent(task, artifact) {
  if (!projectArtifactIsCurrent(task, artifact)) throw new Error('代码候选的目标、材料、工作区范围或文件版本已变化，请重新运行、检查和审阅。');
}

export function publicProjectWorkspace(task) {
  const workspace = task.projectWorkspace;
  if (!workspace) return null;
  const bindingCurrent = projectWorkspaceBindingIsCurrent(task);
  const definitionCurrent = projectWorkspaceDefinitionIsCurrent(task);
  const current = bindingCurrent && definitionCurrent;
  return {
    policyVersion: workspace.policyVersion,
    fixtureId: workspace.fixtureId,
    proposalId: workspace.proposalId || null,
    proposalFingerprint: workspace.proposalFingerprint || null,
    label: workspace.label,
    executionMode: workspace.executionMode || null,
    publicContract: workspace.publicContract || null,
    publicContractFingerprint: workspace.publicContractFingerprint || null,
    status: current ? workspace.status : 'reauthorization_required',
    reason: current ? workspace.reason || null
      : !definitionCurrent ? '固定项目的公开输入接口或执行模式已变化，请重新明确授权当前代码工作区。'
        : '目标、材料、项目关联或已接受交代已变化，请重新明确授权当前代码工作区。',
    sourceSnapshotId: workspace.sourceSnapshotId,
    sourceSnapshotSha256: workspace.sourceSnapshotSha256,
    readablePaths: workspace.readablePaths,
    editablePaths: workspace.editablePaths,
    checks: workspace.checks,
    scopeFingerprint: workspace.scopeFingerprint,
    grantedAt: workspace.grantedAt,
    candidate: workspace.candidate ? {
      id: workspace.candidate.id,
      revision: workspace.candidate.revision,
      status: workspace.candidate.status,
      candidateSha256: workspace.candidate.candidateSha256,
      mutationSequence: workspace.candidate.mutationSequence,
      diffSha256: workspace.candidate.diffSha256 || null,
      sourceIntegrity: workspace.candidate.sourceIntegrity || null,
      checks: workspace.candidate.checks || [],
    } : null,
    sandboxCapability: workspace.sandboxCapability || null,
  };
}

function sandboxString(value) {
  return `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function ancestors(files) {
  const values = new Set(['/']);
  for (const file of files) {
    let current = path.resolve(file);
    while (current && current !== path.dirname(current)) {
      values.add(current);
      current = path.dirname(current);
    }
    values.add('/');
  }
  return [...values].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

function sandboxProfile({ nodePath, readableFiles }) {
  const literals = [...new Set([nodePath, ...readableFiles].map((entry) => path.resolve(entry)))];
  const metadata = ancestors(literals);
  return `(version 1)
(deny default)
(allow process-exec (literal ${sandboxString(nodePath)}))
(allow file-read*
  (literal "/")
  (literal ${sandboxString(nodePath)})
  (subpath "/System/Library")
  (subpath "/usr/lib")
  (subpath "/Library/Apple/System/Library")
${readableFiles.map((entry) => `  (literal ${sandboxString(path.resolve(entry))})`).join('\n')})
(allow file-read-metadata
${metadata.map((entry) => `  (literal ${sandboxString(entry)})`).join('\n')})
(allow sysctl-read
  (sysctl-name "hw.ncpu") (sysctl-name "hw.activecpu")
  (sysctl-name "hw.physicalcpu") (sysctl-name "hw.logicalcpu")
  (sysctl-name "hw.memsize") (sysctl-name "hw.pagesize")
  (sysctl-name "hw.pagesize_compat") (sysctl-name "hw.machine")
  (sysctl-name "kern.osrelease") (sysctl-name "kern.osversion")
  (sysctl-name "kern.ostype") (sysctl-name "kern.hostname")
  (sysctl-name "kern.version"))
`;
}

async function runChild(command, args, { input = '', env = {}, timeoutMs = 2_000, signal, cwd } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('项目检查已取消。'), { code: 'cancelled' }));
    const started = Date.now();
    const child = spawn(command, args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env, cwd, detached: true });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let outputLimitExceeded = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdoutHash = crypto.createHash('sha256');
    const stderrHash = crypto.createHash('sha256');
    let timedOut = false;
    const killGroup = () => {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
    };
    const collect = (previous, chunk, stream) => {
      if (stream === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - previous.length);
      const kept = chunk.subarray(0, remaining);
      if (stream === 'stdout') stdoutHash.update(kept);
      else stderrHash.update(kept);
      const next = remaining ? Buffer.concat([previous, kept]) : previous;
      if (chunk.length > remaining) {
        truncated = true;
        outputLimitExceeded = true;
        killGroup();
      }
      return next;
    };
    child.stdout.on('data', (chunk) => { stdout = collect(stdout, chunk, 'stdout'); });
    child.stderr.on('data', (chunk) => { stderr = collect(stderr, chunk, 'stderr'); });
    const stop = () => killGroup();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(error); });
    child.once('close', (code, closeSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) return reject(Object.assign(new Error('项目检查已取消。'), { code: 'cancelled' }));
      resolve({
        code, signal: closeSignal, timedOut, truncated, outputLimitExceeded,
        stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8'),
        stdoutBytes, stderrBytes,
        stdoutPrefixSha256: stdoutHash.digest('hex'), stderrPrefixSha256: stderrHash.digest('hex'),
        elapsedMs: Date.now() - started,
      });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function parseSingleEnvelope(stdout, expectedKeys) {
  if (!stdout.endsWith('\n') || stdout.slice(0, -1).includes('\n')) throw new Error('子进程必须只返回一份 JSON envelope。');
  const body = stdout.slice(0, -1);
  if (!body || Buffer.byteLength(body) > 16 * 1024) throw new Error('子进程 envelope 缺失或超限。');
  let value;
  try { value = JSON.parse(body); } catch { throw new Error('子进程 envelope 不是合法 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('子进程 envelope 类型错误。');
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (canonical(actual) !== canonical(expected)) throw new Error('子进程 envelope 字段不完整或有多余字段。');
  return value;
}

async function writeAtomicText(root, relative, content) {
  await assertDirectoryChainNoLinks(root);
  const file = resolveInside(root, relative);
  const parent = await ensureSafeDirectory(root, path.posix.dirname(relative));
  if (parent !== path.dirname(file)) throw projectError('项目写入父目录不匹配。');
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
  const handle = await fs.open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
  const beforeRenameParent = await fs.realpath(path.dirname(file));
  if (beforeRenameParent !== parent) throw projectError('项目写入目录在提交前变化。');
  await fs.rename(temp, file);
}

function unifiedPatch(changes) {
  const side = (value, prefix) => {
    const normalized = value.replaceAll('\r\n', '\n');
    const hasFinalNewline = normalized.endsWith('\n');
    const body = hasFinalNewline ? normalized.slice(0, -1) : normalized;
    const lines = body === '' ? [] : body.split('\n');
    let text = lines.map((line) => `${prefix}${line}\n`).join('');
    if (lines.length && !hasFinalNewline) text += '\\ No newline at end of file\n';
    return { count: lines.length, text };
  };
  const chunks = [];
  for (const change of changes) {
    const before = side(change.before, '-');
    const after = side(change.after, '+');
    chunks.push(`--- a/${change.path}\n+++ b/${change.path}\n@@ -1,${before.count} +1,${after.count} @@\n${before.text}${after.text}`);
  }
  return chunks.join('');
}

function patchLines(value) {
  const normalized = value.replaceAll('\r\n', '\n');
  const hasFinalNewline = normalized.endsWith('\n');
  const body = hasFinalNewline ? normalized.slice(0, -1) : normalized;
  return { lines: body === '' ? [] : body.split('\n'), hasFinalNewline };
}

function applySingleHunk(source, patch, expectedFinalNewline) {
  const sourceState = patchLines(source);
  const patchBody = patch.endsWith('\n') ? patch.slice(0, -1) : patch;
  const rows = patchBody.split('\n');
  if (!rows[0]?.startsWith('--- a/') || !rows[1]?.startsWith('+++ b/')) throw new Error('固定区域 patch 文件头无效。');
  const header = rows[2]?.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/);
  if (!header) throw new Error('固定区域 patch hunk 无效。');
  const oldStart = Number(header[1]);
  const oldCount = Number(header[2]);
  const newCount = Number(header[4]);
  let sourceIndex = oldStart - 1;
  let consumed = 0;
  let produced = 0;
  const output = sourceState.lines.slice(0, sourceIndex);
  for (const row of rows.slice(3)) {
    const marker = row[0];
    const text = row.slice(1);
    if (marker === ' ' || marker === '-') {
      if (sourceState.lines[sourceIndex] !== text) throw new Error('固定区域 patch 与源文件上下文不一致。');
      sourceIndex += 1;
      consumed += 1;
    }
    if (marker === ' ' || marker === '+') {
      output.push(text);
      produced += 1;
    }
    if (![' ', '-', '+'].includes(marker)) throw new Error('固定区域 patch 含未知行类型。');
  }
  if (consumed !== oldCount || produced !== newCount) throw new Error('固定区域 patch hunk 计数不一致。');
  output.push(...sourceState.lines.slice(sourceIndex));
  return `${output.join('\n')}${expectedFinalNewline ? '\n' : ''}`;
}

function fixedRegionPatch(fixture, relative, beforeBytes, afterBytes) {
  const before = fixedRegionFor(fixture, relative, beforeBytes);
  const after = fixedRegionFor(fixture, relative, afterBytes);
  if (!before.region || !after.region) throw new Error('固定区域 patch 缺少登记边界。');
  if (before.prefix.compare(after.prefix) !== 0 || before.suffix.compare(after.suffix) !== 0) {
    throw conflict('固定函数区域外的候选字节已变化。', 'project_region_outside_changed');
  }
  const prefixText = before.prefix.toString('utf8');
  const suffixText = before.suffix.toString('utf8');
  const prefixState = patchLines(prefixText);
  const suffixWithoutBoundary = suffixText.startsWith('\n') ? suffixText.slice(1) : suffixText;
  const suffixState = patchLines(suffixWithoutBoundary);
  const beforeContext = prefixState.lines.slice(-3);
  const afterContext = suffixState.lines.slice(0, 3);
  const sourceRegionLines = before.content.toString('utf8').split('\n');
  const candidateRegionLines = after.content.toString('utf8').split('\n');
  const regionStartLine = (prefixText.match(/\n/g) || []).length + 1;
  const oldStart = regionStartLine - beforeContext.length;
  const oldCount = beforeContext.length + sourceRegionLines.length + afterContext.length;
  const newCount = beforeContext.length + candidateRegionLines.length + afterContext.length;
  const rows = [
    ...beforeContext.map((line) => ` ${line}`),
    ...sourceRegionLines.map((line) => `-${line}`),
    ...candidateRegionLines.map((line) => `+${line}`),
    ...afterContext.map((line) => ` ${line}`),
  ];
  const patch = `--- a/${relative}\n+++ b/${relative}\n@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@\n${rows.join('\n')}\n`;
  const sourceText = beforeBytes.toString('utf8');
  const candidateText = afterBytes.toString('utf8');
  const reconstructed = applySingleHunk(sourceText, patch, candidateText.endsWith('\n'));
  if (reconstructed !== candidateText) throw new Error('固定区域 patch 不能精确重建候选文件。');
  return {
    patch,
    proof: {
      version: 1,
      path: relative,
      regionId: fixture.region.id,
      regionStartLine,
      sourceWhole: { bytes: beforeBytes.length, sha256: sha256(beforeBytes) },
      candidateWhole: { bytes: afterBytes.length, sha256: sha256(afterBytes) },
      sourceRegion: { bytes: before.content.length, sha256: sha256(before.content), lines: sourceRegionLines.length },
      candidateRegion: { bytes: after.content.length, sha256: sha256(after.content), lines: candidateRegionLines.length },
      prefix: { bytes: before.prefix.length, sha256: sha256(before.prefix) },
      suffix: { bytes: before.suffix.length, sha256: sha256(before.suffix) },
      outsideUnchanged: true,
      reconstructedCandidateSha256: sha256(Buffer.from(reconstructed, 'utf8')),
    },
  };
}

async function diffCandidate(sourceRoot, candidateRoot, editablePaths, fixture = null) {
  const changes = [];
  for (const relative of editablePaths) {
    const beforeBytes = await readRegular(sourceRoot, relative);
    const afterBytes = await readRegular(candidateRoot, relative);
    if (sha256(beforeBytes) === sha256(afterBytes)) continue;
    const before = beforeBytes.toString('utf8');
    const after = afterBytes.toString('utf8');
    if (before.includes('\uFFFD') || after.includes('\uFFFD')) throw new Error(`项目 diff 只支持 UTF-8 文本：${relative}`);
    const region = fixture?.region?.path === relative ? fixedRegionPatch(fixture, relative, beforeBytes, afterBytes) : null;
    changes.push({ path: relative, before, after, beforeSha256: sha256(beforeBytes), afterSha256: sha256(afterBytes), bytes: afterBytes.length, region });
  }
  const patch = changes.map((change) => change.region?.patch || unifiedPatch([change])).join('');
  const regionProof = changes.find((change) => change.region)?.region?.proof || null;
  const regionIntegrityBody = regionProof ? {
    ...regionProof,
    patchBytes: Buffer.byteLength(patch),
    patchSha256: sha256(patch),
  } : null;
  const regionIntegrity = regionIntegrityBody ? { ...regionIntegrityBody, integritySha256: fingerprint(regionIntegrityBody) } : null;
  return {
    changes: changes.map(({ before: _before, after: _after, region: _region, ...entry }) => entry),
    patch,
    diffSha256: sha256(patch),
    regionIntegrity,
  };
}

function exactExpected(body, key, actual) {
  if ((body[key] ?? null) !== (actual ?? null)) throw conflict(`项目授权页面已过期：${key} 已变化。`);
}

function genericFixtureFromProposal(proposal, projectRoot) {
  const checks = structuredClone(proposal.checks || []).map((entry, index) => ({
    ...entry,
    key: entry.id === 'node-syntax-v1' ? entry.id : `json-function-v1-${index + 1}`,
  }));
  const jsonCheck = checks.find((entry) => entry.id === 'json-function-v1');
  const publicChecks = checks.map((entry) => entry.id === 'json-function-v1'
    ? { id: entry.id, modulePath: entry.modulePath, namedExport: entry.namedExport, cases: entry.cases }
    : { id: entry.id });
  return {
    id: GENERIC_FIXTURE_ID,
    label: 'Irixi 有限源码项目',
    executionMode: GENERIC_EXECUTION_MODE,
    sourceRoot: projectRoot,
    snapshotPaths: [...new Set(['package.json', ...proposal.readablePaths])].sort(),
    readablePaths: [...proposal.readablePaths],
    editablePaths: [...proposal.editablePaths],
    candidateModulePath: jsonCheck?.modulePath || proposal.editablePaths[0],
    wrapperPath: GENERIC_JSON_WRAPPER,
    genericChecks: checks,
    publicContract: {
      id: 'bounded-json-source-v1',
      input: '用户明确确认的有限源码文件与 JSON 纯函数用例',
      behavior: proposal.goal.statement,
      deliverable: 'project_patch',
      readablePaths: [...proposal.readablePaths],
      editablePaths: [...proposal.editablePaths],
      checks: publicChecks,
      writeScope: '一次模型候选生成只能批量替换已授权完整文件；宿主随后运行固定检查和 diff。',
    },
    check: { id: checks[0]?.id || 'node-syntax-v1', trustedParentPath: 'package.json' },
    limits: { maxFiles: 12, maxFileBytes: SCOPE_LIMITS.fileBytes, maxTotalBytes: SCOPE_LIMITS.totalBytes },
  };
}

export function createProjectWorkspaceHost({ projectRoot = path.resolve(moduleDir, '..'), fixtures = DEFAULT_FIXTURES, nodePath = process.execPath, sandboxExecPath = SANDBOX_EXEC, capabilityOverride = null } = {}) {
  const registry = new Map(Object.values(fixtures).map((fixture) => [fixture.id, fixture]));
  const fixedWrapper = path.resolve(DEFAULT_WRAPPER);
  const genericJsonWrapper = path.resolve(GENERIC_JSON_WRAPPER);
  const probeWrapper = path.resolve(DEFAULT_PROBE_WRAPPER);

  function fixtureForTask(task) {
    if (task.projectWorkspace?.fixtureId === GENERIC_FIXTURE_ID) {
      const proposal = task.projectScopeProposal;
      if (!proposal || proposal.status !== 'accepted' || task.projectWorkspace.proposalFingerprint !== proposal.fingerprint) return null;
      return genericFixtureFromProposal(proposal, projectRoot);
    }
    return registry.get(task.projectWorkspace?.fixtureId);
  }

  async function resolvedRuntime() {
    const resolvedNode = await fs.realpath(nodePath);
    const resolvedSandbox = await fs.realpath(sandboxExecPath);
    const resolvedWrapper = await fs.realpath(fixedWrapper);
    const resolvedGenericJsonWrapper = await fs.realpath(genericJsonWrapper);
    const resolvedProbe = await fs.realpath(probeWrapper);
    return { nodePath: resolvedNode, sandboxExecPath: resolvedSandbox, wrapperPath: resolvedWrapper, genericJsonWrapperPath: resolvedGenericJsonWrapper, probePath: resolvedProbe };
  }

  async function capabilitySummary() {
    try {
      const runtime = await resolvedRuntime();
      const base = {
        platform: process.platform,
        osRelease: os.release(),
        osVersion: os.version(),
        profileVersion: PROFILE_VERSION,
        profileTemplateSha256: PROFILE_TEMPLATE_SHA256,
        executionContractSha256: EXECUTION_CONTRACT_SHA256,
        nodeSha256: sha256(await fs.readFile(runtime.nodePath)),
        sandboxExecSha256: sha256(await fs.readFile(runtime.sandboxExecPath)),
        hostVerifierSha256: sha256(await fs.readFile(HOST_VERIFIER_PATH)),
        wrapperSha256: sha256(await fs.readFile(runtime.wrapperPath)),
        genericJsonWrapperSha256: sha256(await fs.readFile(runtime.genericJsonWrapperPath)),
        probeWrapperSha256: sha256(await fs.readFile(runtime.probePath)),
      };
      return { available: process.platform === 'darwin', reason: process.platform === 'darwin' ? '授权时仍会对实际候选路径运行完整隔离探针。' : '固定项目检查目前只支持通过探针验证的 macOS sandbox-exec。', fingerprint: fingerprint(base), ...base };
    } catch { return { available: false, reason: '固定检查运行时不可用；未暴露本机诊断路径。', fingerprint: null, platform: process.platform, profileVersion: PROFILE_VERSION }; }
  }

  async function runSandboxed(runtime, readableFiles, entry, input, _profileDir, signal, timeoutMs = 2_000, { args = [], cwd } = {}) {
    const profile = sandboxProfile({ nodePath: runtime.nodePath, readableFiles });
    const profileSha256 = sha256(profile);
    const result = await runChild(runtime.sandboxExecPath, ['-p', profile, runtime.nodePath, '--max-old-space-size=64', entry, ...args], {
      input: `${JSON.stringify(input)}\n`, env: { LANG: 'C', LC_ALL: 'C' }, timeoutMs, signal, cwd,
    });
    return { ...result, profileSha256 };
  }

  async function probeCapability({ grantRoot, originalRoot, candidateRoot, candidateModule, trustedParentPath, signal }) {
    if (capabilityOverride) {
      const overridden = typeof capabilityOverride === 'function'
        ? await capabilityOverride({ grantRoot, originalRoot, candidateRoot, candidateModule, trustedParentPath, signal })
        : structuredClone(capabilityOverride);
      const runtime = await capabilitySummary();
      return { ...overridden, runtimeFingerprint: overridden.runtimeFingerprint || runtime.fingerprint, testOnlyOverride: true };
    }
    if (process.platform !== 'darwin') return { available: false, reason: '当前平台不是已验证的 macOS sandbox-exec。', probes: [] };
    let runtime;
    try { runtime = await resolvedRuntime(); } catch { return { available: false, reason: '固定隔离运行时不可用；未暴露本机诊断路径。', code: 'project_runtime_unavailable', probes: [] }; }
    const profiles = await ensureSafeDirectory(grantRoot, 'profiles');
    const outsideWrite = path.join(grantRoot, 'probe-outside-write.txt');
    const privateRoot = await ensureSafeDirectory(grantRoot, 'private-parent');
    const privateExpected = path.join(privateRoot, 'expected-canary.json');
    await fs.writeFile(privateExpected, '{"private":true}\n', { flag: 'wx', mode: 0o600 });
    const taskRoot = path.dirname(path.dirname(grantRoot));
    const storeRoot = path.dirname(taskRoot);
    const otherTaskCanary = path.join(storeRoot, `.project-capability-canary-${crypto.randomUUID()}`);
    await fs.writeFile(otherTaskCanary, 'other-task-private\n', { flag: 'wx', mode: 0o600 });
    const candidateWrite = candidateModule;
    const candidateRelative = path.relative(candidateRoot, candidateModule).split(path.sep).join('/');
    const originalFile = resolveInside(originalRoot, candidateRelative);
    const candidateBefore = await readRegular(candidateRoot, candidateRelative);
    const probes = [];
    let networkConnections = 0;
    const listener = net.createServer((socket) => { networkConnections += 1; socket.destroy(); });
    try {
      await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
    } catch (error) {
      await fs.unlink(otherTaskCanary).catch(() => {});
      throw error;
    }
    const port = listener.address().port;
    const signalCanary = spawn(runtime.nodePath, ['--max-old-space-size=32', '-e', 'setInterval(() => {}, 1000)'], {
      shell: false, stdio: 'ignore', env: { LANG: 'C', LC_ALL: 'C' },
    });
    try {
      await new Promise((resolve, reject) => {
        signalCanary.once('spawn', resolve);
        signalCanary.once('error', reject);
      });
    } catch (error) {
      await new Promise((resolve) => listener.close(resolve));
      await fs.unlink(otherTaskCanary).catch(() => {});
      throw error;
    }
    const cases = [
      ['positive-read', { action: 'positive-read', path: candidateModule, expectedBytes: candidateBefore.length, expectedSha256: sha256(candidateBefore) }],
      ['original-read-denied', { action: 'denied-read', path: originalFile }],
      ['parent-read-denied', { action: 'denied-read', path: trustedParentPath }],
      ['parent-expected-read-denied', { action: 'denied-read', path: privateExpected }],
      ['other-task-read-denied', { action: 'denied-read', path: otherTaskCanary }],
      ['home-read-denied', { action: 'denied-read', path: os.homedir() }],
      ['outside-write-denied', { action: 'denied-write', path: outsideWrite }],
      ['candidate-write-denied', { action: 'denied-write', path: candidateWrite }],
      ['process-signal-denied', { action: 'denied-signal', pid: signalCanary.pid }],
      ['spawn-denied', { action: 'denied-spawn' }],
      ['network-denied', { action: 'denied-network', port }],
      ['environment-clean', { action: 'clean-env' }],
    ];
    let signalCanaryProtected = false;
    try {
      for (const [name, request] of cases) {
        const nonce = crypto.randomBytes(16).toString('hex');
        const probeId = `${name}-${crypto.randomBytes(4).toString('hex')}`;
        const result = await runSandboxed(runtime, [runtime.probePath, candidateModule], runtime.probePath, { ...request, probeId, nonce }, profiles, signal, 2_000, { cwd: candidateRoot });
        let accepted = false;
        try {
          const envelope = parseSingleEnvelope(result.stdout, ['probeId', 'nonce', 'passed']);
          accepted = result.code === 0 && !result.signal && !result.timedOut && !result.truncated && envelope.probeId === probeId && envelope.nonce === nonce && envelope.passed === true;
        } catch { accepted = false; }
        probes.push({
          name, accepted, exitCode: result.code, signal: result.signal, timedOut: result.timedOut,
          truncated: result.truncated, outputLimitExceeded: result.outputLimitExceeded,
          stdoutBytes: result.stdoutBytes, stdoutPrefixSha256: result.stdoutPrefixSha256,
          stderrBytes: result.stderrBytes, stderrPrefixSha256: result.stderrPrefixSha256,
          profileSha256: result.profileSha256,
        });
      }
      try { signalCanaryProtected = process.kill(signalCanary.pid, 0); }
      catch { signalCanaryProtected = false; }
    } finally {
      await new Promise((resolve) => listener.close(resolve));
      if (signalCanary.exitCode === null && signalCanary.signalCode === null) {
        signalCanary.kill('SIGKILL');
        await new Promise((resolve) => signalCanary.once('close', resolve));
      }
      await fs.unlink(otherTaskCanary).catch(() => {});
    }
    const candidateAfter = await readRegular(candidateRoot, candidateRelative);
    const writesAbsent = !fsSync.existsSync(outsideWrite) && sha256(candidateBefore) === sha256(candidateAfter);
    const available = probes.every((item) => item.accepted) && networkConnections === 0 && writesAbsent && signalCanaryProtected;
    const runtimeSummary = await capabilitySummary();
    const summary = { available, reason: available ? '实际候选路径的隔离正负探针全部通过。' : '实际候选路径的隔离探针未全部通过，固定检查已关闭。', probes, networkConnections, writesAbsent, signalCanaryProtected, runtimeFingerprint: runtimeSummary.fingerprint };
    summary.fingerprint = fingerprint({ profileVersion: PROFILE_VERSION, runtime: runtimeSummary, probes: probes.map(({ name, accepted, profileSha256 }) => ({ name, accepted, profileSha256 })), networkConnections, writesAbsent, signalCanaryProtected });
    return summary;
  }

  async function attachDraft(task, taskDir, body) {
    if (task.type !== 'project') throw new Error('只有代码项目任务可以授权项目工作区。');
    if (task.provider !== 'codex-cli') throw new Error('代码项目必须使用真实 Codex 提供者。');
    let proposal = null;
    let repository = null;
    let fixture = registry.get(String(body.fixtureId || ''));
    if (body.proposalId) {
      proposal = task.projectScopeProposal;
      if (!proposal || proposal.id !== body.proposalId || proposal.status !== 'accepted') throw conflict('项目范围建议尚未被明确接受或页面已过期。', 'project_scope_stale');
      exactExpected(body, 'expectedProposalFingerprint', proposal.fingerprint);
      repository = await registeredRepository(projectRoot);
      if (!acceptedProposalCurrent(proposal, projectTaskBinding(task), repository.treeSha256)) throw conflict('目标输入或登记源码结构已变化，请重新整理并确认项目范围。', 'project_scope_stale');
      fixture = genericFixtureFromProposal(proposal, projectRoot);
    }
    if (!fixture) throw new Error('未知的固定项目工作区。');
    const binding = projectTaskBinding(task);
    exactExpected(body, 'expectedGoalVersionId', binding.goalVersionId);
    exactExpected(body, 'expectedProjectRootGoalVersionId', binding.projectRootGoalVersionId);
    exactExpected(body, 'expectedProjectRootInputFingerprint', binding.projectRootInputFingerprint);
    exactExpected(body, 'expectedMaterialApplicabilityFingerprint', binding.materialApplicabilityFingerprint);
    exactExpected(body, 'expectedPreviousScopeFingerprint', task.projectWorkspace?.scopeFingerprint || null);
    const capability = await capabilitySummary();
    exactExpected(body, 'expectedCapabilityFingerprint', capability.fingerprint);

    const originalRoot = await fs.realpath(fixture.sourceRoot);
    const sourceManifestBefore = await manifestFor(originalRoot, fixture.snapshotPaths, fixture.limits);
    const grantId = makeId('workspace');
    const sourceSnapshotId = makeId('source');
    const grantRelativeRoot = path.posix.join('project-workspaces', grantId);
    const grantRoot = resolveInside(taskDir, grantRelativeRoot);
    const stagingRoot = `${grantRoot}.${crypto.randomUUID()}.tmp`;
    const sourceRoot = path.join(stagingRoot, 'source');
    const candidateRoot = path.join(stagingRoot, 'candidate-1');
    await assertDirectoryChainNoLinks(taskDir);
    const workspaceRoot = await ensureSafeDirectory(taskDir, 'project-workspaces');
    if (path.dirname(stagingRoot) !== workspaceRoot) throw projectError('项目授权暂存目录越界。');
    await fs.mkdir(stagingRoot, { mode: 0o700 });
    await assertDirectoryChainNoLinks(stagingRoot);
    try {
      await copyManifest(originalRoot, sourceRoot, sourceManifestBefore);
      const candidateManifestSource = sourceManifestBefore.filter((entry) => fixture.readablePaths.includes(entry.path));
      await copyManifest(sourceRoot, candidateRoot, candidateManifestSource);
      const sourceManifestAfter = await manifestFor(originalRoot, fixture.snapshotPaths, fixture.limits);
      if (canonical(sourceManifestBefore) !== canonical(sourceManifestAfter)) throw conflict('源项目在授权复制期间发生变化，请重试。', 'project_source_changed');
      await fs.rename(stagingRoot, grantRoot);
    } catch (error) {
      await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    const finalSourceRoot = path.join(grantRoot, 'source');
    const finalCandidateRoot = path.join(grantRoot, 'candidate-1');
    const candidateManifest = await manifestFor(finalCandidateRoot, fixture.readablePaths, fixture.limits);
    const checkerBytes = await readRegular(finalSourceRoot, fixture.check.trustedParentPath);
    const fixtureWrapper = wrapperPathFor(fixture);
    const wrapperBytes = await fs.readFile(fixtureWrapper);
    const sourceSnapshotSha256 = manifestHash(sourceManifestBefore);
    const candidateSha256 = manifestHash(candidateManifest);
    const checkerSha256 = sha256(checkerBytes);
    const hostVerifierSha256 = sha256(await fs.readFile(HOST_VERIFIER_PATH));
    const wrapperSha256 = sha256(wrapperBytes);
    let checkDescriptors;
    if (fixture.executionMode === GENERIC_EXECUTION_MODE) {
      checkDescriptors = fixture.genericChecks.map((check) => {
        const body = check.id === 'json-function-v1'
          ? { id: check.id, modulePath: check.modulePath, namedExport: check.namedExport, cases: check.cases }
          : { id: check.id, editablePaths: fixture.editablePaths };
        return {
          id: check.key, kind: check.id, specification: structuredClone(body),
          trustedParentSha256: checkerSha256, hostVerifierSha256, trustedVerifierSha256: hostVerifierSha256,
          childWrapperSha256: wrapperSha256, contractSha256: genericFingerprint(body),
          inputSetSha256: genericFingerprint(check.cases?.map(({ id, args }) => ({ id, args })) || fixture.editablePaths),
          expectedSetSha256: genericFingerprint(check.cases?.map(({ id, expected }) => ({ id, expected })) || []),
          executionContractSha256: EXECUTION_CONTRACT_SHA256,
        };
      });
    } else {
      const importedChecker = await import(`${pathToFileURL(resolveInside(finalSourceRoot, fixture.check.trustedParentPath)).href}?sha=${checkerSha256}`);
      const contract = importedChecker.contract;
      if (!contract || contract.id !== fixture.check.id || !Array.isArray(contract.cases) || !contract.cases.length) throw projectError('固定检查契约无效。', 'project_check_invalid');
      checkDescriptors = [{
        id: fixture.check.id,
        trustedParentSha256: checkerSha256,
        hostVerifierSha256,
        trustedVerifierSha256: hostVerifierSha256,
        childWrapperSha256: wrapperSha256,
        contractSha256: contractFingerprint(fixture, contract),
        inputSetSha256: fingerprint(contract.cases.map(({ id, input }) => ({ id, input }))),
        expectedSetSha256: fingerprint(contract.cases.map(({ id, expected }) => ({ id, expected }))),
        executionContractSha256: EXECUTION_CONTRACT_SHA256,
      }];
    }
    const sandboxCapability = await probeCapability({
      grantRoot, originalRoot, candidateRoot: finalCandidateRoot,
      candidateModule: resolveInside(finalCandidateRoot, fixture.candidateModulePath),
      trustedParentPath: fixture.executionMode === GENERIC_EXECUTION_MODE ? HOST_VERIFIER_PATH : resolveInside(finalSourceRoot, fixture.check.trustedParentPath), signal: null,
    });
    sandboxCapability.contractBindingFingerprint = fingerprint(checkDescriptors);
    sandboxCapability.fingerprint = fingerprint({ probeFingerprint: sandboxCapability.fingerprint || null, checkDescriptors });
    const publicContractFingerprint = fingerprint(fixture.publicContract);
    const scopeFingerprint = fingerprint({ policyVersion: POLICY_VERSION, fixtureId: fixture.id, proposalFingerprint: proposal?.fingerprint || null, executionMode: fixture.executionMode || null, publicContractFingerprint, grantId, sourceSnapshotSha256, readablePaths: fixture.readablePaths, editablePaths: fixture.editablePaths, checks: checkDescriptors, sandboxCapabilityFingerprint: sandboxCapability.fingerprint || null, taskInputBinding: binding });
    if (task.projectWorkspace) {
      task.projectWorkspaceHistory ??= [];
      task.projectWorkspaceHistory.push({ ...structuredClone(task.projectWorkspace), archivedAt: new Date().toISOString() });
      task.projectWorkspaceHistory = task.projectWorkspaceHistory.slice(-10);
    }
    task.projectWorkspace = {
      policyVersion: POLICY_VERSION, fixtureId: fixture.id, label: fixture.label, executionMode: fixture.executionMode || null,
      publicContract: structuredClone(fixture.publicContract), publicContractFingerprint, grantId,
      proposalId: proposal?.id || null, proposalFingerprint: proposal?.fingerprint || null,
      repositoryId: proposal?.repositoryId || null, repositoryTreeSha256: repository?.treeSha256 || null,
      status: sandboxCapability.available ? 'ready' : 'sandbox_unavailable',
      reason: sandboxCapability.available ? null : sandboxCapability.reason,
      sourceSnapshotId, sourceSnapshotSha256, sourceManifest: sourceManifestBefore,
      readablePaths: [...fixture.readablePaths], editablePaths: [...fixture.editablePaths], checks: checkDescriptors,
      taskInputBinding: binding,
      scopeFingerprint, grantedAt: new Date().toISOString(), grantRelativeRoot,
      originalManifestSha256: sourceSnapshotSha256, sandboxCapability,
      candidate: {
        id: makeId('candidate'), revision: 1, relativeRoot: path.posix.join(grantRelativeRoot, 'candidate-1'),
        status: 'ready', sourceSnapshotSha256, candidateSha256, manifest: candidateManifest,
        mutationSequence: 0, ownerRunId: null, ownerWorkItemId: null, ownerSessionId: null,
        taskInputBinding: binding, checks: [], diffSha256: sha256(''), sourceIntegrity: null, updatedAt: new Date().toISOString(),
      },
    };
    return publicProjectWorkspace(task);
  }

  async function assertOriginalCurrent(task) {
    assertWorkspaceCurrent(task);
    const workspace = task.projectWorkspace;
    const fixture = fixtureForTask(task);
    if (!fixture) throw new Error('项目 fixture 已不可用。');
    if (!workspaceMatchesFixtureDefinition(workspace, fixture)) {
      throw conflict('固定项目的公开输入接口或执行模式已变化，请重新授权工作区。', 'project_contract_changed');
    }
    const root = await fs.realpath(fixture.sourceRoot);
    if (fixture.executionMode === GENERIC_EXECUTION_MODE) {
      const repository = await registeredRepository(projectRoot);
      if (repository.treeSha256 !== workspace.repositoryTreeSha256) throw conflict('登记源码结构已在授权后变化，请重新整理并授权范围。', 'project_source_changed');
    }
    const current = await manifestFor(root, fixture.snapshotPaths, fixture.limits);
    if (manifestHash(current) !== workspace.originalManifestSha256) throw conflict('原始项目已在授权后变化，请重新授权工作区。', 'project_source_changed');
    return fixture;
  }

  async function ensureCandidateOwner(task, taskDir, item) {
    const workspace = task.projectWorkspace;
    if (!workspace) throw new Error('尚未授权项目工作区。');
    assertWorkspaceCurrent(task);
    if (workspace.status !== 'ready') throw new Error(workspace.reason || '固定项目检查的隔离能力不可用。');
    const fixture = fixtureForTask(task);
    if (!fixture) throw projectError('固定项目工作区定义不可用。', 'project_fixture_unavailable');
    const currentBinding = projectTaskBinding(task);
    const runId = task.execution?.id || null;
    const session = (task.agentSessions || []).findLast((entry) => entry.workItemId === item.id && (!runId || entry.runId === runId));
    let candidate = workspace.candidate;
    if (!candidate || candidate.status !== 'ready' || candidate.ownerRunId && candidate.ownerRunId !== runId || !sameBinding(candidate.taskInputBinding, currentBinding)) {
      const revision = (candidate?.revision || 0) + 1;
      const sourceRoot = resolveInside(taskDir, path.posix.join(workspace.grantRelativeRoot, 'source'));
      const relativeRoot = path.posix.join(workspace.grantRelativeRoot, `candidate-${revision}`);
      const candidateRoot = resolveInside(taskDir, relativeRoot);
      const sourceEntries = workspace.sourceManifest.filter((entry) => fixture.readablePaths.includes(entry.path));
      await copyManifest(sourceRoot, candidateRoot, sourceEntries);
      const manifest = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
      candidate = {
        id: makeId('candidate'), revision, relativeRoot, status: 'ready', sourceSnapshotSha256: workspace.sourceSnapshotSha256,
        candidateSha256: manifestHash(manifest), manifest, mutationSequence: 0, ownerRunId: runId,
        ownerWorkItemId: item.id, ownerSessionId: session?.id || null, taskInputBinding: currentBinding,
        checks: [], diffSha256: sha256(''), sourceIntegrity: null, updatedAt: new Date().toISOString(),
      };
      workspace.candidate = candidate;
    } else if (!candidate.ownerRunId) {
      candidate.ownerRunId = runId; candidate.ownerWorkItemId = item.id; candidate.ownerSessionId = session?.id || null;
    }
    if (candidate.ownerRunId !== runId || candidate.ownerWorkItemId !== item.id) throw conflict('这个候选已属于另一条执行链，不能写入当前工作项。');
    return { workspace, candidate, fixture };
  }

  async function runContractCheck({ task, taskDir, item, signal }) {
    const { workspace, candidate, fixture } = await ensureCandidateOwner(task, taskDir, item);
    const grantRoot = resolveInside(taskDir, workspace.grantRelativeRoot);
    const sourceRoot = path.join(grantRoot, 'source');
    const candidateRoot = resolveInside(taskDir, candidate.relativeRoot);
    const checkerPath = resolveInside(sourceRoot, fixture.check.trustedParentPath);
    const candidateModule = resolveInside(candidateRoot, fixture.candidateModulePath);
    const sourceCandidateBytes = await readRegular(sourceRoot, fixture.candidateModulePath);
    const candidateBytesBefore = await readRegular(candidateRoot, fixture.candidateModulePath);
    assertRegionOutsideMatches(fixture, fixture.candidateModulePath, sourceCandidateBytes, candidateBytesBefore);
    const checkerBytes = await readRegular(sourceRoot, fixture.check.trustedParentPath);
    const hostVerifierSha256 = sha256(await fs.readFile(HOST_VERIFIER_PATH));
    const fixtureWrapper = await fs.realpath(wrapperPathFor(fixture));
    const wrapperBytes = await fs.readFile(fixtureWrapper);
    if (hostVerifierSha256 !== workspace.checks[0].hostVerifierSha256
      || sha256(checkerBytes) !== workspace.checks[0].trustedParentSha256
      || sha256(wrapperBytes) !== workspace.checks[0].childWrapperSha256) throw conflict('可信 verifier、契约文件或固定 wrapper 已变化。', 'project_check_changed');
    const currentRuntime = await capabilitySummary();
    if (!currentRuntime.available || currentRuntime.fingerprint !== workspace.sandboxCapability.runtimeFingerprint) throw conflict('系统、Node、隔离 profile 或固定运行时已变化，请重新授权并运行隔离探针。', 'project_runtime_changed');
    const imported = await import(`${pathToFileURL(checkerPath).href}?sha=${sha256(checkerBytes)}`);
    const contract = imported.contract;
    if (!contract || contract.id !== fixture.check.id || !Array.isArray(contract.cases) || !contract.cases.length) throw new Error('固定检查契约无效。');
    const inputSetSha256 = fingerprint(contract.cases.map(({ id, input }) => ({ id, input })));
    const expectedSetSha256 = fingerprint(contract.cases.map(({ id, expected }) => ({ id, expected })));
    const contractSha256 = contractFingerprint(fixture, contract);
    if (contractSha256 !== workspace.checks[0].contractSha256
      || inputSetSha256 !== workspace.checks[0].inputSetSha256
      || expectedSetSha256 !== workspace.checks[0].expectedSetSha256
      || EXECUTION_CONTRACT_SHA256 !== workspace.checks[0].executionContractSha256) throw conflict('固定检查契约已在授权后变化。', 'project_check_changed');
    const runtime = await resolvedRuntime();
    const profiles = path.join(grantRoot, 'profiles');
    const caseResults = [];
    for (const testCase of contract.cases) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const request = { caseId: testCase.id, nonce, exportName: contract.exportName, input: testCase.input };
      const child = await runSandboxed(runtime, [fixtureWrapper, candidateModule], fixtureWrapper, request, profiles, signal, 2_000, { args: [candidateModule], cwd: candidateRoot });
      let passed = false;
      let protocolCode = null;
      try {
        if (child.timedOut) throw Object.assign(new Error('timeout'), { code: 'timeout' });
        if (child.outputLimitExceeded || child.truncated) throw Object.assign(new Error('output_limit'), { code: 'output_limit' });
        if (child.code !== 0 || child.signal) throw Object.assign(new Error('abnormal_exit'), { code: 'abnormal_exit' });
        const envelope = parseSingleEnvelope(child.stdout, ['caseId', 'nonce', 'value']);
        if (envelope.caseId !== testCase.id || envelope.nonce !== nonce) throw Object.assign(new Error('binding_mismatch'), { code: 'binding_mismatch' });
        if (typeof envelope.value !== contract.resultType) throw Object.assign(new Error('type_mismatch'), { code: 'type_mismatch' });
        if (canonical(envelope.value) !== canonical(testCase.expected)) throw Object.assign(new Error('expected_mismatch'), { code: 'expected_mismatch' });
        passed = true;
      } catch (error) { protocolCode = error.code || 'protocol_invalid'; }
      caseResults.push({
        caseId: testCase.id, passed, exitCode: child.code, signal: child.signal,
        timedOut: child.timedOut, truncated: child.truncated, outputLimitExceeded: child.outputLimitExceeded,
        stdoutBytes: child.stdoutBytes, stdoutPrefixSha256: child.stdoutPrefixSha256,
        stderrBytes: child.stderrBytes, stderrPrefixSha256: child.stderrPrefixSha256,
        elapsedMs: child.elapsedMs, profileSha256: child.profileSha256, protocolCode,
      });
    }
    const manifestAfter = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
    if (manifestHash(manifestAfter) !== candidate.candidateSha256) throw conflict('候选在固定检查期间变化，检查结果已拒收。');
    const candidateBytesAfter = await readRegular(candidateRoot, fixture.candidateModulePath);
    assertRegionOutsideMatches(fixture, fixture.candidateModulePath, sourceCandidateBytes, candidateBytesAfter);
    const casePassed = caseResults.filter((entry) => entry.passed).length;
    const resultDigest = checkResultDigest(caseResults);
    const record = {
      id: makeId('check'), checkId: contract.id, passed: casePassed === caseResults.length,
      hostVerifierSha256, trustedParentSha256: sha256(checkerBytes), childWrapperSha256: sha256(wrapperBytes), contractSha256,
      executionContractSha256: EXECUTION_CONTRACT_SHA256,
      runtimeFingerprint: currentRuntime.fingerprint,
      inputSetSha256, expectedSetSha256, caseTotal: caseResults.length, casePassed, resultDigest,
      candidateSha256: candidate.candidateSha256, workspaceScopeFingerprint: workspace.scopeFingerprint,
      sandboxCapabilityFingerprint: workspace.sandboxCapability.fingerprint, taskInputBinding: projectTaskBinding(task),
      cases: caseResults, startedAt: new Date(Date.now() - caseResults.reduce((sum, entry) => sum + entry.elapsedMs, 0)).toISOString(), completedAt: new Date().toISOString(),
    };
    candidate.checks.push(record);
    candidate.checks = candidate.checks.slice(-20);
    candidate.updatedAt = record.completedAt;
    return record;
  }

  async function runGenericCheck({ task, taskDir, item, signal, checkId }) {
    const { workspace, candidate, fixture } = await ensureCandidateOwner(task, taskDir, item);
    const specification = fixture.genericChecks.find((entry) => entry.key === checkId);
    const descriptor = workspace.checks.find((entry) => entry.id === checkId);
    if (!specification || !descriptor) throw projectError('未知或未授权的固定检查。', 'project_check_invalid');
    const candidateRoot = resolveInside(taskDir, candidate.relativeRoot);
    const before = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
    if (manifestHash(before) !== candidate.candidateSha256) throw conflict('候选已在固定检查前变化。');
    const runtime = await resolvedRuntime();
    const runtimeSummary = await capabilitySummary();
    if (!runtimeSummary.available || runtimeSummary.fingerprint !== workspace.sandboxCapability.runtimeFingerprint) throw conflict('固定检查运行时已变化，请重新授权。', 'project_runtime_changed');
    const sourceRoot = resolveInside(taskDir, path.posix.join(workspace.grantRelativeRoot, 'source'));
    const checkerBytes = await readRegular(sourceRoot, fixture.check.trustedParentPath);
    const wrapperBytes = await fs.readFile(runtime.genericJsonWrapperPath);
    const specificationBody = specification.id === 'json-function-v1'
      ? { id: specification.id, modulePath: specification.modulePath, namedExport: specification.namedExport, cases: specification.cases }
      : { id: specification.id, editablePaths: fixture.editablePaths };
    if (descriptor.hostVerifierSha256 !== sha256(await fs.readFile(HOST_VERIFIER_PATH))
      || descriptor.trustedParentSha256 !== sha256(checkerBytes)
      || descriptor.childWrapperSha256 !== sha256(wrapperBytes)
      || descriptor.contractSha256 !== genericFingerprint(specificationBody)
      || descriptor.inputSetSha256 !== genericFingerprint(specification.cases?.map(({ id, args }) => ({ id, args })) || fixture.editablePaths)
      || descriptor.expectedSetSha256 !== genericFingerprint(specification.cases?.map(({ id, expected }) => ({ id, expected })) || [])
      || descriptor.executionContractSha256 !== EXECUTION_CONTRACT_SHA256) throw conflict('固定检查定义、wrapper 或 verifier 已变化。', 'project_check_changed');
    const caseResults = [];
    if (specification.id === 'node-syntax-v1') {
      for (const relative of fixture.editablePaths) {
        const candidateFile = resolveInside(candidateRoot, relative);
        const source = (await readRegular(candidateRoot, relative)).toString('utf8');
        if (fixture.genericChecks.some((entry) => entry.id === 'json-function-v1' && entry.modulePath === relative)) assertGenericModulePolicy(source);
        const profile = sandboxProfile({ nodePath: runtime.nodePath, readableFiles: [candidateFile] });
        const result = await runChild(runtime.sandboxExecPath, ['-p', profile, runtime.nodePath, '--max-old-space-size=64', '--check', candidateFile], {
          env: { LANG: 'C', LC_ALL: 'C' }, timeoutMs: 2_000, signal, cwd: candidateRoot,
        });
        const passed = result.code === 0 && !result.signal && !result.timedOut && !result.truncated && !result.outputLimitExceeded;
        caseResults.push({
          caseId: `syntax-${relative}`, passed, exitCode: result.code, signal: result.signal, timedOut: result.timedOut,
          truncated: result.truncated, outputLimitExceeded: result.outputLimitExceeded,
          stdoutBytes: result.stdoutBytes, stdoutPrefixSha256: result.stdoutPrefixSha256,
          stderrBytes: result.stderrBytes, stderrPrefixSha256: result.stderrPrefixSha256,
          elapsedMs: result.elapsedMs, profileSha256: sha256(profile), protocolCode: passed ? null : 'syntax_failed',
        });
      }
    } else {
      const candidateModule = resolveInside(candidateRoot, specification.modulePath);
      assertGenericModulePolicy((await readRegular(candidateRoot, specification.modulePath)).toString('utf8'));
      for (const testCase of specification.cases) {
        assertPlainJson(testCase.args); assertPlainJson(testCase.expected);
        const nonce = crypto.randomBytes(16).toString('hex');
        const request = { caseId: testCase.id, nonce, exportName: specification.namedExport, args: testCase.args };
        const child = await runSandboxed(runtime, [runtime.genericJsonWrapperPath, candidateModule], runtime.genericJsonWrapperPath, request, null, signal, 2_000, { args: [candidateModule], cwd: candidateRoot });
        let passed = false;
        let protocolCode = null;
        try {
          if (child.timedOut) throw Object.assign(new Error('timeout'), { code: 'timeout' });
          if (child.outputLimitExceeded || child.truncated) throw Object.assign(new Error('output_limit'), { code: 'output_limit' });
          if (child.code !== 0 || child.signal) throw Object.assign(new Error('abnormal_exit'), { code: 'abnormal_exit' });
          const envelope = parseSingleEnvelope(child.stdout, ['type', 'caseId', 'nonce', 'value']);
          if (envelope.type !== 'json-function-result-v1' || envelope.caseId !== testCase.id || envelope.nonce !== nonce) throw Object.assign(new Error('binding_mismatch'), { code: 'binding_mismatch' });
          assertPlainJson(envelope.value);
          if (canonical(envelope.value) !== canonical(testCase.expected)) throw Object.assign(new Error('expected_mismatch'), { code: 'expected_mismatch' });
          passed = true;
        } catch (error) { protocolCode = error.code || 'protocol_invalid'; }
        caseResults.push({
          caseId: testCase.id, passed, exitCode: child.code, signal: child.signal, timedOut: child.timedOut,
          truncated: child.truncated, outputLimitExceeded: child.outputLimitExceeded,
          stdoutBytes: child.stdoutBytes, stdoutPrefixSha256: child.stdoutPrefixSha256,
          stderrBytes: child.stderrBytes, stderrPrefixSha256: child.stderrPrefixSha256,
          elapsedMs: child.elapsedMs, profileSha256: child.profileSha256, protocolCode,
        });
      }
    }
    const after = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
    if (manifestHash(after) !== candidate.candidateSha256 || canonical(before) !== canonical(after)) throw conflict('候选在固定检查期间变化，结果已拒收。');
    const casePassed = caseResults.filter((entry) => entry.passed).length;
    const record = {
      id: makeId('check'), checkId, passed: casePassed === caseResults.length,
      hostVerifierSha256: descriptor.hostVerifierSha256, trustedParentSha256: descriptor.trustedParentSha256,
      childWrapperSha256: descriptor.childWrapperSha256, contractSha256: descriptor.contractSha256,
      inputSetSha256: descriptor.inputSetSha256, expectedSetSha256: descriptor.expectedSetSha256,
      executionContractSha256: descriptor.executionContractSha256, runtimeFingerprint: runtimeSummary.fingerprint,
      caseTotal: caseResults.length, casePassed, resultDigest: checkResultDigest(caseResults),
      candidateSha256: candidate.candidateSha256, workspaceScopeFingerprint: workspace.scopeFingerprint,
      sandboxCapabilityFingerprint: workspace.sandboxCapability.fingerprint, taskInputBinding: projectTaskBinding(task), cases: caseResults,
      completedAt: new Date().toISOString(),
    };
    candidate.checks.push(record); candidate.checks = candidate.checks.slice(-30); candidate.updatedAt = record.completedAt;
    return record;
  }

  async function runTool(store, taskId, itemId, request, { signal } = {}) {
    const changed = await store.mutate(taskId, async (task) => {
      const item = task.workItems.find((entry) => entry.id === itemId);
      if (!item || item.status !== 'running') throw conflict('工作项已不在当前执行中。');
      const fixture = await assertOriginalCurrent(task);
      const { workspace, candidate } = await ensureCandidateOwner(task, store.taskDir(taskId), item);
      const candidateRoot = resolveInside(store.taskDir(taskId), candidate.relativeRoot);
      const sourceRoot = resolveInside(store.taskDir(taskId), path.posix.join(workspace.grantRelativeRoot, 'source'));
      const args = request.args || {};
      if (request.tool === 'workspace.read') {
        const relative = assertRelative(args.path);
        if (!fixture.readablePaths.includes(relative)) throw new Error('这个文件不在当前工作区的可读范围。');
        if (args.expectedCandidateSha256 !== candidate.candidateSha256) throw conflict('候选已变化，请先读取当前版本。');
        const view = args.view === 'source' ? 'source' : 'candidate';
        const bytes = await readRegular(view === 'source' ? sourceRoot : candidateRoot, relative);
        if (view === 'candidate' && fixture.region?.path === relative) {
          const sourceBytes = await readRegular(sourceRoot, relative);
          assertRegionOutsideMatches(fixture, relative, sourceBytes, bytes);
        }
        const selected = fixedRegionFor(fixture, relative, bytes).content;
        return {
          path: relative, view, content: selected.toString('utf8'), bytes: selected.length, fileSha256: sha256(selected),
          contentScope: fixture.region?.path === relative ? fixture.region.id : 'whole_file',
          wholeFileBytes: bytes.length, wholeFileSha256: sha256(bytes),
          sourceSnapshotSha256: workspace.sourceSnapshotSha256, candidateSha256: candidate.candidateSha256,
          workspaceScopeFingerprint: workspace.scopeFingerprint,
        };
      }
      if (request.tool === 'workspace.write') {
        if (fixture.executionMode === GENERIC_EXECUTION_MODE) {
          if (args.expectedCandidateSha256 !== candidate.candidateSha256) throw conflict('候选已变化，迟到批量修改已拒绝。');
          const changes = Array.isArray(args.changes) ? args.changes : [];
          if (!changes.length || changes.length > fixture.editablePaths.length) throw projectError('批量候选必须包含 1 个到授权上限内的文件修改。', 'project_write_batch_invalid');
          const names = changes.map((entry) => assertRelative(entry.path));
          if (new Set(names).size !== names.length || names.some((relative) => !fixture.editablePaths.includes(relative))) throw projectError('批量候选包含重复或未授权文件。', 'project_write_batch_invalid');
          const manifestBefore = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
          if (manifestHash(manifestBefore) !== candidate.candidateSha256) throw conflict('候选文件已在工具记录外变化，迟到修改已拒绝。');
          for (const entry of changes) {
            const before = await readRegular(candidateRoot, entry.path);
            if (entry.expectedFileSha256 !== sha256(before)) throw conflict(`文件已变化，迟到修改已拒绝：${entry.path}`);
            const content = String(entry.content ?? '');
            const bytes = Buffer.from(content, 'utf8');
            if (content.includes('\u0000') || bytes.length > fixture.limits.maxFileBytes) throw projectError('候选文件含空字符或超过大小上限。', 'project_write_batch_invalid');
            if (fixture.genericChecks.some((check) => check.id === 'json-function-v1' && check.modulePath === entry.path)) assertGenericModulePolicy(content);
          }
          const nextRevision = candidate.revision + 1;
          const grantRoot = resolveInside(store.taskDir(taskId), workspace.grantRelativeRoot);
          const finalRelativeRoot = path.posix.join(workspace.grantRelativeRoot, `candidate-${nextRevision}`);
          const finalRoot = resolveInside(store.taskDir(taskId), finalRelativeRoot);
          const stagingRoot = path.join(grantRoot, `.candidate-${nextRevision}-${crypto.randomUUID()}.tmp`);
          await copyManifest(candidateRoot, stagingRoot, manifestBefore);
          try {
            for (const entry of changes) await writeAtomicText(stagingRoot, entry.path, Buffer.from(String(entry.content), 'utf8'));
            const nextManifest = await manifestFor(stagingRoot, fixture.readablePaths, fixture.limits);
            const nextSha = manifestHash(nextManifest);
            const stagedDiff = await diffCandidate(sourceRoot, stagingRoot, fixture.editablePaths, fixture);
            if (!stagedDiff.changes.length) throw projectError('候选没有产生实际源码变化；事务已停止，不会隐式重试。', 'project_no_change');
            await fs.rename(stagingRoot, finalRoot);
            candidate.revision = nextRevision;
            candidate.relativeRoot = finalRelativeRoot;
            candidate.manifest = nextManifest;
            candidate.candidateSha256 = nextSha;
            candidate.mutationSequence += 1;
            candidate.checks = [];
            candidate.sourceIntegrity = null;
            candidate.diffSha256 = stagedDiff.diffSha256;
            candidate.updatedAt = new Date().toISOString();
            return {
              changes: changes.map((entry) => ({ path: entry.path, bytes: Buffer.byteLength(String(entry.content)), fileSha256: sha256(Buffer.from(String(entry.content), 'utf8')) })),
              candidateSha256: nextSha, mutationSequence: candidate.mutationSequence,
              diffSha256: stagedDiff.diffSha256, workspaceScopeFingerprint: workspace.scopeFingerprint,
            };
          } catch (error) {
            await fs.rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
            throw error;
          }
        }
        const relative = assertRelative(args.path);
        if (!fixture.editablePaths.includes(relative)) throw new Error('这个文件不在当前工作区的可修改范围。');
        if (args.expectedCandidateSha256 !== candidate.candidateSha256) throw conflict('候选已变化，迟到修改已拒绝。');
        const currentManifest = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
        if (manifestHash(currentManifest) !== candidate.candidateSha256) throw conflict('候选文件已在工具记录外变化，迟到修改已拒绝。');
        const before = await readRegular(candidateRoot, relative);
        const sourceBytes = await readRegular(sourceRoot, relative);
        assertRegionOutsideMatches(fixture, relative, sourceBytes, before);
        const selectedBefore = fixedRegionFor(fixture, relative, before);
        if (args.expectedFileSha256 !== sha256(selectedBefore.content)) throw conflict('文件已变化，迟到修改已拒绝。');
        const content = String(args.content ?? '');
        const bytes = Buffer.from(content, 'utf8');
        if (content.includes('\u0000') || bytes.length > fixture.limits.maxFileBytes) throw new Error('候选文件含空字符或超过大小上限。');
        assertReplacementRegion(fixture, relative, content);
        const nextBytes = fixture.region?.path === relative
          ? Buffer.concat([selectedBefore.prefix, bytes, selectedBefore.suffix])
          : bytes;
        if (nextBytes.length > fixture.limits.maxFileBytes) throw new Error('候选文件超过大小上限。');
        await writeAtomicText(candidateRoot, relative, nextBytes);
        const written = await readRegular(candidateRoot, relative);
        if (sha256(written) !== sha256(nextBytes)) throw conflict('候选写入后字节不一致。');
        assertRegionOutsideMatches(fixture, relative, sourceBytes, written);
        const selectedWritten = fixedRegionFor(fixture, relative, written).content;
        if (sha256(selectedWritten) !== sha256(bytes)) throw conflict('固定函数写入后内容不一致。');
        const manifest = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
        candidate.manifest = manifest; candidate.candidateSha256 = manifestHash(manifest); candidate.mutationSequence += 1;
        candidate.checks = []; candidate.sourceIntegrity = null; candidate.updatedAt = new Date().toISOString();
        const diff = await diffCandidate(sourceRoot, candidateRoot, fixture.editablePaths, fixture);
        candidate.diffSha256 = diff.diffSha256;
        return {
          path: relative, fileSha256: sha256(bytes), bytes: bytes.length,
          contentScope: fixture.region?.path === relative ? fixture.region.id : 'whole_file',
          wholeFileBytes: written.length, wholeFileSha256: sha256(written),
          candidateSha256: candidate.candidateSha256, mutationSequence: candidate.mutationSequence,
          diffSha256: diff.diffSha256, workspaceScopeFingerprint: workspace.scopeFingerprint,
        };
      }
      if (request.tool === 'workspace.diff') {
        if (args.expectedCandidateSha256 !== candidate.candidateSha256) throw conflict('候选已变化，请重新查看 diff。');
        const diff = await diffCandidate(sourceRoot, candidateRoot, fixture.editablePaths, fixture);
        const sourceIntegrity = await sourceIntegrityEvidence(task, sourceRoot, fixture);
        candidate.diffSha256 = diff.diffSha256;
        candidate.sourceIntegrity = sourceIntegrity;
        return { ...diff, sourceIntegrity, sourceSnapshotSha256: workspace.sourceSnapshotSha256, candidateSha256: candidate.candidateSha256, workspaceScopeFingerprint: workspace.scopeFingerprint };
      }
      if (request.tool === 'workspace.check') {
        if (fixture.executionMode === GENERIC_EXECUTION_MODE) {
          if (!fixture.genericChecks.some((entry) => entry.key === args.checkId)) throw new Error('未知或未授权的固定检查。');
          if (args.expectedCandidateSha256 !== candidate.candidateSha256) throw conflict('候选已变化，请对当前版本重新检查。');
          return runGenericCheck({ task, taskDir: store.taskDir(taskId), item, signal, checkId: args.checkId });
        }
        if (args.checkId !== fixture.check.id) throw new Error('未知或未授权的固定检查。');
        if (args.expectedCandidateSha256 !== candidate.candidateSha256) throw conflict('候选已变化，请对当前版本重新检查。');
        return runContractCheck({ task, taskDir: store.taskDir(taskId), item, signal });
      }
      throw new Error('未知项目工具。');
    });
    return changed.result;
  }

  async function assertSourceSnapshotCurrent(workspace, sourceRoot, fixture) {
    const sourceManifest = await manifestFor(sourceRoot, fixture.snapshotPaths, fixture.limits);
    const sourceSnapshotSha256 = manifestHash(sourceManifest);
    if (canonical(sourceManifest) !== canonical(workspace.sourceManifest)
      || sourceSnapshotSha256 !== workspace.sourceSnapshotSha256
      || sourceSnapshotSha256 !== workspace.originalManifestSha256) {
      throw conflict('任务内只读源快照已变化，请重新授权工作区。', 'project_source_snapshot_changed');
    }
    return sourceManifest;
  }

  async function sourceIntegrityEvidence(task, sourceRoot, fixture) {
    assertWorkspaceCurrent(task);
    const workspace = task.projectWorkspace;
    const originalRoot = await fs.realpath(fixture.sourceRoot);
    const [currentOriginalManifest, currentSnapshotManifest] = await Promise.all([
      manifestFor(originalRoot, fixture.snapshotPaths, fixture.limits),
      manifestFor(sourceRoot, fixture.snapshotPaths, fixture.limits),
    ]);
    const authorizedManifest = workspace.sourceManifest;
    const authorizedByPath = new Map(authorizedManifest.map((entry) => [entry.path, entry]));
    const originalByPath = new Map(currentOriginalManifest.map((entry) => [entry.path, entry]));
    const snapshotByPath = new Map(currentSnapshotManifest.map((entry) => [entry.path, entry]));
    const paths = fixture.snapshotPaths.slice().sort().map((relative) => {
      const authorized = authorizedByPath.get(relative);
      const currentOriginal = originalByPath.get(relative);
      const taskSnapshot = snapshotByPath.get(relative);
      if (!authorized || !currentOriginal || !taskSnapshot) throw conflict('源完整性清单缺少固定文件。', 'project_source_changed');
      return {
        path: relative,
        authorized: { bytes: authorized.bytes, sha256: authorized.sha256 },
        currentOriginal: { bytes: currentOriginal.bytes, sha256: currentOriginal.sha256 },
        taskSnapshot: { bytes: taskSnapshot.bytes, sha256: taskSnapshot.sha256 },
        unchanged: authorized.bytes === currentOriginal.bytes && authorized.sha256 === currentOriginal.sha256
          && authorized.bytes === taskSnapshot.bytes && authorized.sha256 === taskSnapshot.sha256,
      };
    });
    const authorizedSourceSha256 = manifestHash(authorizedManifest);
    const currentOriginalSha256 = manifestHash(currentOriginalManifest);
    const taskSnapshotSha256 = manifestHash(currentSnapshotManifest);
    if (!paths.every((entry) => entry.unchanged)
      || canonical(authorizedManifest) !== canonical(currentOriginalManifest)
      || canonical(authorizedManifest) !== canonical(currentSnapshotManifest)
      || authorizedSourceSha256 !== workspace.originalManifestSha256
      || currentOriginalSha256 !== workspace.originalManifestSha256
      || taskSnapshotSha256 !== workspace.sourceSnapshotSha256) {
      throw conflict('原项目或任务内只读源快照已变化，请重新授权工作区。', 'project_source_changed');
    }
    const evidence = {
      verified: true,
      fileCount: paths.length,
      paths,
      authorizedSourceSha256,
      currentOriginalSha256,
      taskSnapshotSha256,
      allUnchanged: true,
    };
    return { ...evidence, integritySha256: fingerprint(evidence) };
  }

  function checkResultDigest(cases) {
    return fingerprint(cases.map(({ caseId, passed, exitCode, signal: closeSignal, timedOut, truncated, outputLimitExceeded, protocolCode }) => ({
      caseId, passed, exitCode, signal: closeSignal, timedOut, truncated, outputLimitExceeded, protocolCode,
    })));
  }

  function assertCurrentPassingCheck(task, workspace, candidate, check, fixture, runtimeFingerprint) {
    return assertCurrentPassingCheckId(task, workspace, candidate, check, fixture.check.id, runtimeFingerprint);
  }

  function assertCurrentPassingCheckId(task, workspace, candidate, check, checkId, runtimeFingerprint) {
    const descriptor = workspace.checks?.find((entry) => entry.id === checkId);
    if (!descriptor || !check || check.checkId !== checkId || typeof check.id !== 'string'
      || check.passed !== true || !Array.isArray(check.cases) || check.cases.length === 0
      || check.caseTotal !== check.cases.length
      || check.casePassed !== check.cases.filter((entry) => entry.passed === true).length
      || check.casePassed !== check.caseTotal || check.cases.some((entry) => entry.passed !== true)
      || check.resultDigest !== checkResultDigest(check.cases)
      || check.candidateSha256 !== candidate.candidateSha256
      || check.workspaceScopeFingerprint !== workspace.scopeFingerprint
      || check.sandboxCapabilityFingerprint !== workspace.sandboxCapability?.fingerprint
      || check.runtimeFingerprint !== runtimeFingerprint
      || !sameBinding(check.taskInputBinding, projectTaskBinding(task))
      || check.hostVerifierSha256 !== descriptor.hostVerifierSha256
      || check.trustedParentSha256 !== descriptor.trustedParentSha256
      || check.childWrapperSha256 !== descriptor.childWrapperSha256
      || check.contractSha256 !== descriptor.contractSha256
      || check.inputSetSha256 !== descriptor.inputSetSha256
      || check.expectedSetSha256 !== descriptor.expectedSetSha256
      || check.executionContractSha256 !== descriptor.executionContractSha256) {
      throw conflict('固定检查证据不完整、已过期或与当前候选不一致。', 'project_check_stale');
    }
    const current = candidate.checks?.find((entry) => entry.id === check.id && entry.resultDigest === check.resultDigest);
    if (!current || canonical(current) !== canonical(check)) {
      throw conflict('固定检查证据已不在当前候选记录中。', 'project_check_stale');
    }
    return check;
  }

  async function buildArtifactEvidence(task, taskDir) {
    const workspace = task.projectWorkspace;
    const candidate = workspace?.candidate;
    if (!workspace || workspace.status !== 'ready' || !candidate) throw new Error('没有可交付的当前代码候选。');
    if (!sameBinding(candidate.taskInputBinding, projectTaskBinding(task))) throw conflict('候选属于旧目标或材料范围。');
    const fixture = await assertOriginalCurrent(task);
    const sourceRoot = resolveInside(taskDir, path.posix.join(workspace.grantRelativeRoot, 'source'));
    const candidateRoot = resolveInside(taskDir, candidate.relativeRoot);
    const currentRuntime = await capabilitySummary();
    if (!currentRuntime.available || currentRuntime.fingerprint !== workspace.sandboxCapability.runtimeFingerprint) throw conflict('系统、Node、sandbox-exec、可信 verifier 或固定 wrapper 已变化。', 'project_runtime_changed');
    const sourceIntegrity = await sourceIntegrityEvidence(task, sourceRoot, fixture);
    const checkerBytes = await readRegular(sourceRoot, fixture.check.trustedParentPath);
    if (workspace.checks.some((entry) => entry.trustedParentSha256 !== sha256(checkerBytes))) throw conflict('固定检查契约文件已变化。', 'project_check_changed');
    const manifest = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
    if (manifestHash(manifest) !== candidate.candidateSha256) throw conflict('候选文件已在工具记录外变化。');
    const sourceCandidateBytes = await readRegular(sourceRoot, fixture.candidateModulePath);
    const candidateBytes = await readRegular(candidateRoot, fixture.candidateModulePath);
    assertRegionOutsideMatches(fixture, fixture.candidateModulePath, sourceCandidateBytes, candidateBytes);
    const diff = await diffCandidate(sourceRoot, candidateRoot, fixture.editablePaths, fixture);
    if (!diff.changes.length) throw new Error('代码候选没有实际修改。');
    const checks = fixture.executionMode === GENERIC_EXECUTION_MODE
      ? workspace.checks.map((descriptor) => candidate.checks.findLast((entry) => entry.checkId === descriptor.id && entry.passed && entry.candidateSha256 === candidate.candidateSha256))
      : [candidate.checks.findLast((entry) => entry.passed && entry.candidateSha256 === candidate.candidateSha256)];
    if (checks.some((entry) => !entry)) throw new Error('当前代码候选尚未通过全部固定检查。');
    checks.forEach((entry) => assertCurrentPassingCheckId(task, workspace, candidate, entry, entry.checkId, currentRuntime.fingerprint));
    const patchRelativePath = path.posix.join(workspace.grantRelativeRoot, 'artifacts', `${candidate.id}.patch`);
    await writeAtomicText(taskDir, patchRelativePath, diff.patch);
    return {
      grantId: workspace.grantId, sourceSnapshotId: workspace.sourceSnapshotId,
      sourceSnapshotSha256: workspace.sourceSnapshotSha256, workspaceScopeFingerprint: workspace.scopeFingerprint,
      candidateId: candidate.id, candidateSha256: candidate.candidateSha256, diffSha256: diff.diffSha256,
      sandboxCapabilityFingerprint: workspace.sandboxCapability.fingerprint,
      runtimeFingerprint: workspace.sandboxCapability.runtimeFingerprint,
      sourceIntegrity, sourceIntegritySha256: sourceIntegrity.integritySha256,
      regionIntegrity: diff.regionIntegrity, regionIntegritySha256: diff.regionIntegrity?.integritySha256 || null,
      changes: diff.changes, patch: diff.patch, checks: checks.map((entry) => structuredClone(entry)), patchRelativePath, patchSha256: sha256(diff.patch),
      taskInputBinding: projectTaskBinding(task),
    };
  }

  async function currentSourceIntegrity(task, taskDir) {
    const fixture = await assertOriginalCurrent(task);
    const workspace = task.projectWorkspace;
    const sourceRoot = resolveInside(taskDir, path.posix.join(workspace.grantRelativeRoot, 'source'));
    return sourceIntegrityEvidence(task, sourceRoot, fixture);
  }

  async function assertArtifactFilesCurrent(task, taskDir, artifact) {
    assertProjectArtifactCurrent(task, artifact);
    const runtime = await capabilitySummary();
    if (!runtime.available || runtime.fingerprint !== task.projectWorkspace?.sandboxCapability?.runtimeFingerprint) throw conflict('固定检查运行时已变化，请重新授权、检查和审阅。', 'project_runtime_changed');
    const evidence = artifact.projectCandidate;
    if (!evidence.projectExecutionAudit || evidence.projectExecutionAuditSha256 !== evidence.projectExecutionAudit.auditSha256) throw conflict('代码执行审计证据缺失或被篡改。', 'project_execution_audit_stale');
    const fixture = await assertOriginalCurrent(task);
    const workspace = task.projectWorkspace;
    const sourceRoot = resolveInside(taskDir, path.posix.join(workspace.grantRelativeRoot, 'source'));
    const candidateRoot = resolveInside(taskDir, workspace.candidate.relativeRoot);
    const sourceIntegrity = await sourceIntegrityEvidence(task, sourceRoot, fixture);
    if (!evidence.sourceIntegrity || evidence.sourceIntegritySha256 !== sourceIntegrity.integritySha256
      || evidence.sourceIntegrity.integritySha256 !== evidence.sourceIntegritySha256
      || canonical(evidence.sourceIntegrity) !== canonical(sourceIntegrity)) {
      throw conflict('原项目完整性证据缺失、被篡改或已经过期。', 'project_source_integrity_stale');
    }
    const manifest = await manifestFor(candidateRoot, fixture.readablePaths, fixture.limits);
    if (manifestHash(manifest) !== evidence.candidateSha256) throw conflict('代码候选文件已变化。');
    const sourceCandidateBytes = await readRegular(sourceRoot, fixture.candidateModulePath);
    const candidateBytes = await readRegular(candidateRoot, fixture.candidateModulePath);
    assertRegionOutsideMatches(fixture, fixture.candidateModulePath, sourceCandidateBytes, candidateBytes);
    const currentDiff = await diffCandidate(sourceRoot, candidateRoot, fixture.editablePaths, fixture);
    if (currentDiff.diffSha256 !== evidence.diffSha256) throw conflict('代码候选 diff 已变化。');
    if (canonical(currentDiff.changes) !== canonical(evidence.changes) || currentDiff.patch !== evidence.patch
      || sha256(currentDiff.patch) !== evidence.patchSha256) throw conflict('代码候选的结构化变化或 patch 证据已变化。');
    if ((evidence.regionIntegritySha256 || null) !== (currentDiff.regionIntegrity?.integritySha256 || null)
      || canonical(evidence.regionIntegrity || null) !== canonical(currentDiff.regionIntegrity || null)) {
      throw conflict('固定区域完整性证据缺失、被篡改或已经过期。', 'project_region_integrity_stale');
    }
    const checkerBytes = await readRegular(sourceRoot, fixture.check.trustedParentPath);
    const hostVerifierSha256 = sha256(await fs.readFile(HOST_VERIFIER_PATH));
    const fixtureWrapper = wrapperPathFor(fixture);
    const wrapperBytes = await fs.readFile(fixtureWrapper);
    const expectedCheckIds = workspace.checks.map((entry) => entry.id).sort();
    if (canonical((evidence.checks || []).map((entry) => entry.checkId).sort()) !== canonical(expectedCheckIds)) throw conflict('固定检查证据集合缺失或多余。', 'project_check_stale');
    for (const evidenceCheck of evidence.checks) {
      assertCurrentPassingCheckId(task, workspace, workspace.candidate, evidenceCheck, evidenceCheck.checkId, runtime.fingerprint);
      if (evidenceCheck.executionContractSha256 !== EXECUTION_CONTRACT_SHA256
        || hostVerifierSha256 !== evidenceCheck.hostVerifierSha256
        || sha256(checkerBytes) !== evidenceCheck.trustedParentSha256 || sha256(wrapperBytes) !== evidenceCheck.childWrapperSha256) throw conflict('可信 verifier、固定 wrapper 或执行契约已变化。', 'project_runtime_changed');
    }
    if (fixture.executionMode !== GENERIC_EXECUTION_MODE) {
      const evidenceCheck = evidence.checks[0];
      const imported = await import(`${pathToFileURL(resolveInside(sourceRoot, fixture.check.trustedParentPath)).href}?sha=${sha256(checkerBytes)}`);
      const contract = imported.contract;
      const contractSha256 = contractFingerprint(fixture, contract);
      const inputSetSha256 = fingerprint(contract.cases.map(({ id, input }) => ({ id, input })));
      const expectedSetSha256 = fingerprint(contract.cases.map(({ id, expected }) => ({ id, expected })));
      if (contractSha256 !== evidenceCheck.contractSha256 || inputSetSha256 !== evidenceCheck.inputSetSha256 || expectedSetSha256 !== evidenceCheck.expectedSetSha256) throw conflict('固定检查契约已变化。', 'project_runtime_changed');
    }
    const patch = await readRegular(taskDir, evidence.patchRelativePath, MAX_TOTAL_BYTES);
    if (sha256(patch) !== evidence.patchSha256 || patch.toString('utf8') !== evidence.patch) throw conflict('代码 patch 文件已变化。');
    return patch;
  }

  return {
    async repository() {
      const repository = await registeredRepository(projectRoot);
      return {
        repositoryId: repository.repositoryId,
        id: repository.repositoryId,
        label: 'Irixi Office Agent',
        files: repository.files.map(({ path: relative, bytes, sha256: hash, selectable }) => ({ path: relative, bytes, sha256: hash, selectable })),
        treeSha256: repository.treeSha256,
        limits: structuredClone(SCOPE_LIMITS),
        checkCatalog: [
          { id: 'node-syntax-v1', purpose: '对获准修改的 JS/MJS 文件运行固定 Node 语法检查。' },
          { id: 'json-function-v1', purpose: '逐用例隔离调用无 import 的同步 named export；expected 只由宿主保存和比较。' },
        ],
      };
    },
    async scopeInput() {
      const repository = await registeredRepository(projectRoot);
      return {
        repositoryId: repository.repositoryId,
        treeSha256: repository.treeSha256,
        files: await Promise.all(repository.files.map(async (entry) => ({
          path: entry.path,
          bytes: entry.bytes,
          sha256: entry.sha256,
          selectable: entry.selectable !== false,
          excerpt: entry.selectable === false ? null : (await readRegular(projectRoot, entry.path, SCOPE_LIMITS.fileBytes)).toString('utf8').slice(0, 3_000),
          excerptTruncated: entry.selectable !== false && entry.bytes > 3_000,
        }))),
        limits: structuredClone(SCOPE_LIMITS),
        checkCatalog: [
          { id: 'node-syntax-v1', purpose: '固定 Node 语法检查' },
          { id: 'json-function-v1', purpose: '同步 named export 的父侧 JSON 用例比较' },
        ],
      };
    },
    async assertWorkspaceReady(task) {
      try { await assertOriginalCurrent(task); return true; }
      catch (error) { throw sanitizeProjectError(error, '代码工作区已变化，请重新整理范围并授权。'); }
    },
    async capabilities() {
      const base = await capabilitySummary();
      const fixtureCapabilities = await Promise.all([...registry.values()].map(async (fixture) => {
        try {
          const root = await fs.realpath(fixture.sourceRoot);
          const checker = await readRegular(root, fixture.check.trustedParentPath);
          const checkerSha256 = sha256(checker);
          const imported = await import(`${pathToFileURL(resolveInside(root, fixture.check.trustedParentPath)).href}?sha=${checkerSha256}`);
          const contract = imported.contract;
          return {
            id: fixture.id, label: fixture.label, readablePaths: fixture.readablePaths, editablePaths: fixture.editablePaths,
            executionMode: fixture.executionMode || null, publicContract: fixture.publicContract,
            publicContractFingerprint: fingerprint(fixture.publicContract),
            checks: [{
              id: fixture.check.id,
              hostVerifierSha256: base.hostVerifierSha256,
              trustedVerifierSha256: base.hostVerifierSha256,
              trustedContractFileSha256: checkerSha256,
              contractSha256: contractFingerprint(fixture, contract),
              inputSetSha256: fingerprint(contract.cases.map(({ id, input }) => ({ id, input }))),
              expectedSetSha256: fingerprint(contract.cases.map(({ id, expected }) => ({ id, expected }))),
              executionContractSha256: EXECUTION_CONTRACT_SHA256,
            }],
          };
        } catch { return { id: fixture.id, label: fixture.label, readablePaths: fixture.readablePaths, editablePaths: fixture.editablePaths, executionMode: fixture.executionMode || null, publicContract: fixture.publicContract, publicContractFingerprint: fingerprint(fixture.publicContract), checks: [{ id: fixture.check.id, unavailable: true }] }; }
      }));
      return { ...base, fixtures: fixtureCapabilities };
    },
    async attachDraft(...args) {
      try { return await attachDraft(...args); } catch (error) { throw sanitizeProjectError(error, '项目工作区授权失败；未暴露本机路径。'); }
    },
    async runTool(...args) {
      try { return await runTool(...args); } catch (error) { throw sanitizeProjectError(error, '项目工具执行失败；请按当前候选版本重试。'); }
    },
    async buildArtifactEvidence(...args) {
      try { return await buildArtifactEvidence(...args); } catch (error) { throw sanitizeProjectError(error, '代码候选证据生成失败。'); }
    },
    async currentSourceIntegrity(...args) {
      try { return await currentSourceIntegrity(...args); } catch (error) { throw sanitizeProjectError(error, '原项目完整性证据已变化或无法复核。'); }
    },
    async assertArtifactFilesCurrent(...args) {
      try { return await assertArtifactFilesCurrent(...args); } catch (error) { throw sanitizeProjectError(error, '代码候选证据已变化或无法复核。'); }
    },
    publicState: publicProjectWorkspace,
  };
}

export const __test = {
  canonical, fingerprint, assertRelative, resolveInside, manifestFor, manifestHash,
  sandboxProfile, parseSingleEnvelope, diffCandidate, unifiedPatch, applySingleHunk, sameBinding,
  runChild, assertGenericModulePolicy, PROFILE_TEMPLATE_SHA256, EXECUTION_CONTRACT_SHA256, DEFAULT_FIXTURES,
};
