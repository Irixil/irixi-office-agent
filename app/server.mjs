import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  acceptGoalReplacement,
  activeGoal,
  addMaterial,
  addSuggestion,
  buildPlan,
  confirmArtifact,
  correctSuggestion,
  createArtifact,
  createStore,
  createTask,
  deriveTaskContinuity,
  event,
  invalidateCurrentWork,
  currentInstructionIds,
  projectInputFingerprint,
  projectRootId,
  publicTask,
  recordReview,
  rejectArtifact,
  reviseArtifact,
  setTaskState,
  assertArtifactInputCurrent,
  assertExportAllowed,
} from './core.mjs';
import { createProviders } from './providers.mjs';
import {
  applyModelPlan,
  assertProjectExecutionAuditCurrent,
  assertSessionFresh,
  markSession,
  readyWorkItems,
  sessionInput,
  projectExecutionAudit,
  stampProjectToolCall,
  validateWorkResult,
  validateModelPlan,
  workSession,
} from './orchestration.mjs';
import { runAuthorizedTools } from './tools.mjs';
import { readPublicPage } from './web-tools.mjs';
import {
  applicabilityFingerprintMatches,
  assertNoCriticalMaterialDecision,
  currentMaterialScope,
  ensureMaterialPolicy,
  materialContentSha256,
  materialContext,
  recordMaterialDecision,
} from './material-applicability.mjs';
import {
  beginWork,
  beginWorkItem,
  completeWork,
  completeWorkItem,
  createTrustedProjectReviewFacts,
  failWork,
  failWorkItem,
  finishModelCall,
  mayRetry,
  mayRetryWork,
  recordAttempt,
  recordWorkAttempt,
  retryDisposition,
  reserveModelCall,
  startExecution,
  transitionExecution,
  validateClaim,
  validateResearchResult,
} from './execution.mjs';
import { createProjectWorkspaceHost, projectWorkspaceFingerprint, projectWorkspaceIsCurrent } from './project-workspace.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const publicRoot = path.join(moduleDir, 'public');
const artRoot = path.join(projectRoot, 'art');
const sceneRoot = path.join(artRoot, 'godot-office-pilot', 'build', 'web');
const vendorRoot = path.join(projectRoot, 'node_modules');
const dataRoot = path.join(projectRoot, 'data', 'tasks');
const artifactRuntimeRoot = path.join(projectRoot, '.irixi-runtime', 'artifacts');
const nativeGeneratorRevision = '2026-10-01.1';
const bundledNode = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin', 'node');
const bundledNodeModules = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'node_modules');
const bundledPython = path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin', 'python3');
const documentRenderScript = path.join(os.homedir(), '.codex', 'plugins', 'cache', 'openai-primary-runtime', 'documents', '26.909.12148', 'skills', 'documents', 'render_docx.py');
const presentationSkillRoot = path.join(os.homedir(), '.codex', 'plugins', 'cache', 'openai-primary-runtime', 'presentations', '26.909.12148', 'skills', 'presentations');
const documentFontPath = path.join(projectRoot, 'third_party', 'fonts', 'NotoSansSC-Regular.ttf');
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 1_500_000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.pck': 'application/octet-stream',
  '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const activeJobs = new Map();
const activeQueuedReplies = new Map();
const OFFICE_BOUNDS = Object.freeze({ minX: 0.18, maxX: 0.82, minY: 0.58, maxY: 0.84 });

async function projectState(store, task) {
  const rootId = projectRootId(task);
  const root = rootId === task.id ? task : await store.get(rootId);
  if (projectRootId(root) !== root.id) throw new Error('关联的项目根任务本身已属于其他项目，请选择真正的根任务。');
  const rootGoal = activeGoal(root);
  const all = await store.list();
  const linked = all.filter((item) => projectRootId(item) === root.id);
  return { root, rootGoal, linked };
}

function linkedSummary(task) {
  const continuity = deriveTaskContinuity(task);
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    goal: continuity.currentGoal,
    completed: continuity.completed,
    blockers: continuity.blockers,
    acceptedInstructions: continuity.acceptedInstructions,
    candidate: continuity.candidate,
    nextStep: continuity.progress.nextStep,
    factsBoundary: '候选、历史与未确认内容保持其原状态，不视为已确认事实。',
  };
}

async function hydrateProjectContext(store, task) {
  const copy = structuredClone(task);
  const { root, rootGoal, linked } = await projectState(store, task);
  copy.projectRootGoalVersionId = rootGoal.id;
  copy.projectRootInputFingerprint = projectInputFingerprint(root);
  copy.linkedTaskContext = linked.filter((item) => item.id !== task.id).map(linkedSummary);
  copy.projectContext = {
    rootTaskId: root.id,
    rootGoal: { id: rootGoal.id, version: rootGoal.version, statement: rootGoal.statement, successCriteria: rootGoal.successCriteria, boundaries: rootGoal.boundaries },
    acceptedInstructions: deriveTaskContinuity(root).acceptedInstructions,
    inputFingerprint: projectInputFingerprint(root),
    currentTaskRole: task.id === root.id ? 'root' : 'linked',
  };
  return copy;
}

async function normalizeProjectScopeForExplicitWrite(store, task) {
  const root = projectRootId(task) === task.id ? task : await store.get(projectRootId(task));
  task.projectRootGoalVersionId = activeGoal(root).id;
  task.projectRootInputFingerprint = projectInputFingerprint(root);
}

async function assertProjectGoalFresh(store, task, expectedVersionId = null, expectedInputFingerprint = null) {
  const root = projectRootId(task) === task.id ? task : await store.get(projectRootId(task));
  const rootGoalVersionId = activeGoal(root).id;
  const recorded = task.projectRootGoalVersionId || (projectRootId(task) === task.id ? activeGoal(task).id : null);
  const rootInputFingerprint = projectInputFingerprint(root);
  if (projectRootId(task) !== task.id && rootGoalDecisionPending(root)) {
    const error = new Error('项目根任务正在等待完整目标变更决定；关联任务已暂停，不能接受新结果。');
    error.code = 'project_goal_decision_pending';
    throw error;
  }
  const recordedInput = task.projectRootInputFingerprint || (projectRootId(task) === task.id ? projectInputFingerprint(task) : null);
  if (recorded !== rootGoalVersionId || recordedInput !== rootInputFingerprint
    || (expectedVersionId && expectedVersionId !== rootGoalVersionId)
    || (expectedInputFingerprint && expectedInputFingerprint !== rootInputFingerprint)) {
    const error = new Error('项目根目标已经变化，当前结果必须按新版项目目标重新规划。');
    error.code = 'stale_result';
    throw error;
  }
  return { rootGoalVersionId, rootInputFingerprint };
}

function pauseLinkedTaskForRootDecision(task, rootTaskId) {
  if (task.id === rootTaskId || projectRootId(task) !== rootTaskId) return;
  invalidateCurrentWork(task, 'project_goal_decision_pending', '项目根任务正在等待完整目标变更决定；本任务已暂停，旧计划与在途结果不可写回。');
  for (const queued of task.conversationQueue || []) if (['pending', 'running'].includes(queued.status)) {
    queued.status = 'stale';
    queued.completedAt = new Date().toISOString();
    queued.error = '项目根任务正在等待目标变更决定。';
  }
  setTaskState(task, 'waiting_user', 'coordinator', '项目根任务正在等待完整目标变更决定；决定完成后将按有效项目输入重新规划。');
  event(task, 'project.goal_decision_pending', '项目根任务出现待确认的目标替换；关联任务已确定性暂停。', {
    rootTaskId,
    rootGoalVersionId: task.projectRootGoalVersionId,
    rootInputFingerprint: task.projectRootInputFingerprint,
    taskGoalVersionId: activeGoal(task).id,
  });
}

function rootGoalDecisionPending(root) {
  return (root.suggestions || []).some((item) => item.goalVersionId === activeGoal(root).id
    && item.classification === 'replace' && item.status === 'waiting_user');
}

function pausedForRootDecision(task) {
  return task.status === 'waiting_user'
    && task.events?.findLast((item) => item.type === 'task.state')?.message?.includes('项目根任务正在等待完整目标变更决定');
}

function releaseLinkedTaskFromRootDecision(task, rootTaskId) {
  if (task.id === rootTaskId || projectRootId(task) !== rootTaskId || task.status !== 'waiting_user') return;
  const pendingLocalDecision = (task.suggestions || []).some((item) => item.goalVersionId === activeGoal(task).id
    && item.classification === 'replace' && item.status === 'waiting_user');
  if (pendingLocalDecision) return;
  setTaskState(task, 'idle', 'coordinator', '项目根任务的目标决定已解除；可按当前项目输入重新规划。');
  event(task, 'project.goal_decision_resolved', '项目根任务的待定目标已处理；本任务保持自身目标，等待续接重规划。', { rootTaskId });
}

function normalizeRootGoalDecision(tasks, root) {
  if (rootGoalDecisionPending(root)) {
    if (root.status !== 'waiting_user') setTaskState(root, 'waiting_user', 'coordinator', '项目根任务正在等待完整目标变更决定；决定完成前关联任务保持暂停。');
    for (const linked of tasks.values()) if (linked.id !== root.id && !pausedForRootDecision(linked)) pauseLinkedTaskForRootDecision(linked, root.id);
    return;
  }
  for (const linked of tasks.values()) if (pausedForRootDecision(linked)) releaseLinkedTaskFromRootDecision(linked, root.id);
}

function invalidateLinkedTaskForRootGoal(task, rootTaskId, rootGoalVersionId, rootInputFingerprint, reason = 'project_goal_replaced') {
  if (task.id === rootTaskId || projectRootId(task) !== rootTaskId) return;
  ensureMaterialPolicy(task, reason);
  task.projectRootGoalVersionId = rootGoalVersionId;
  task.projectRootInputFingerprint = rootInputFingerprint;
  invalidateCurrentWork(task, reason, reason === 'project_root_instructions_changed'
    ? '项目根任务的工作交代已更新；本任务自身目标与历史保留，旧计划和在途结果已失效，后续将按当前项目输入重新规划。'
    : '项目根目标已更新；本任务自身目标与历史保留，旧计划和在途结果已失效，后续将按新版项目目标重新规划。');
  for (const queued of task.conversationQueue || []) if (['pending', 'running'].includes(queued.status)) {
    queued.status = 'stale'; queued.completedAt = new Date().toISOString(); queued.error = '项目根目标已更新。';
  }
  if ((task.suggestions || []).some((item) => item.goalVersionId === activeGoal(task).id && item.status === 'waiting_user')) {
    setTaskState(task, 'waiting_user', 'coordinator', '项目目标已同步，但本任务仍有需要你判断的目标冲突。');
  }
  event(task, reason === 'project_root_instructions_changed' ? 'project.instructions_synced' : 'project.goal_synced', reason === 'project_root_instructions_changed'
    ? '项目根任务的新工作交代已同步；旧计划、审阅和迟到结果不可继续使用。'
    : '新版项目目标已同步；任务自身目标与历史保留，旧计划、审阅和迟到结果不可继续使用。', { rootTaskId, rootGoalVersionId, rootInputFingerprint });
}

async function reconcileProjectInputs(store) {
  const tasks = await store.list();
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const snapshot of tasks) {
    const root = byId.get(projectRootId(snapshot));
    if (!root || projectRootId(root) !== root.id) continue;
    const rootGoalVersionId = activeGoal(root).id;
    const rootInputFingerprint = projectInputFingerprint(root);
    if (snapshot.id === root.id) {
      const hasPersistedRootScope = Object.hasOwn(snapshot, 'projectRootGoalVersionId')
        && Object.hasOwn(snapshot, 'projectRootInputFingerprint');
      const rootScopeChanged = hasPersistedRootScope
        && (snapshot.projectRootGoalVersionId !== rootGoalVersionId || snapshot.projectRootInputFingerprint !== rootInputFingerprint);
      if (rootScopeChanged || (rootGoalDecisionPending(snapshot) && snapshot.status !== 'waiting_user')) {
        await store.mutate(snapshot.id, (task) => {
          if (hasPersistedRootScope) {
            task.projectRootGoalVersionId = activeGoal(task).id;
            task.projectRootInputFingerprint = projectInputFingerprint(task);
          }
          if (rootGoalDecisionPending(task) && task.status !== 'waiting_user') {
            setTaskState(task, 'waiting_user', 'coordinator', '项目根任务正在等待完整目标变更决定；决定完成前关联任务保持暂停。');
          }
        });
      }
      continue;
    }
    const rootDecisionPending = rootGoalDecisionPending(root);
    const childPausedForRoot = pausedForRootDecision(snapshot);
    if (rootDecisionPending) {
      if (!childPausedForRoot) await store.mutate(snapshot.id, (task) => pauseLinkedTaskForRootDecision(task, root.id));
      continue;
    }
    if (childPausedForRoot) await store.mutate(snapshot.id, (task) => releaseLinkedTaskFromRootDecision(task, root.id));
    const hasPersistedRootScope = Object.hasOwn(snapshot, 'projectRootGoalVersionId')
      && Object.hasOwn(snapshot, 'projectRootInputFingerprint');
    if (!hasPersistedRootScope) continue;
    if (snapshot.projectRootGoalVersionId === rootGoalVersionId && snapshot.projectRootInputFingerprint === rootInputFingerprint) continue;
    await store.mutate(snapshot.id, (task) => invalidateLinkedTaskForRootGoal(
      task,
      root.id,
      rootGoalVersionId,
      rootInputFingerprint,
      task.projectRootGoalVersionId === rootGoalVersionId ? 'project_root_instructions_changed' : 'project_goal_replaced',
    ));
  }
}

function publicTaskWithRuntime(task) {
  const result = publicTask(task);
  const active = activeQueuedReplies.get(task?.id) || activeJobs.get(task?.id);
  result.runtime = { activeJob: active ? { kind: active.kind, role: active.role || null } : null };
  return result;
}

function json(res, status, body) {
  const value = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(value),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(value);
}

function problem(res, status, message, code = 'request_failed') {
  json(res, status, { error: { code, message } });
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const error = new Error('请求必须使用 JSON。'); error.status = 415; throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) { const error = new Error('请求内容超过安全上限。'); error.status = 413; throw error; }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { const error = new Error('请求 JSON 无法解析。'); error.status = 400; throw error; }
}

function ensureLocalMutation(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const url = new URL(origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error();
  } catch {
    const error = new Error('只接受来自本机 Irixi 页面发起的修改。'); error.status = 403; throw error;
  }
}

function safeFilename(value, fallback = 'irixi-export') {
  const result = String(value || '').normalize('NFKC').replaceAll(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replaceAll(/\s+/g, ' ').trim().slice(0, 100);
  return result || fallback;
}

function htmlEscape(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function exportBody(task, artifact, format) {
  if (format === 'md') return { type: 'text/markdown; charset=utf-8', extension: 'md', content: artifact.content };
  if (format === 'html') {
    const body = htmlEscape(artifact.content)
      .replaceAll(/^### (.+)$/gm, '<h3>$1</h3>').replaceAll(/^## (.+)$/gm, '<h2>$1</h2>').replaceAll(/^# (.+)$/gm, '<h1>$1</h1>')
      .replaceAll(/\n\n/g, '</p><p>').replaceAll(/\n/g, '<br>');
    return {
      type: 'text/html; charset=utf-8', extension: 'html',
      content: `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${htmlEscape(artifact.title)}</title><style>body{font:17px/1.75 ui-serif,Georgia,serif;max-width:780px;margin:56px auto;padding:0 24px;color:#231b14}h1,h2,h3{line-height:1.25;color:#234536}@media print{body{margin:0;max-width:none}}</style></head><body><p>${body}</p></body></html>`,
    };
  }
  if (format === 'eml' && task.type === 'email') {
    const lines = artifact.content.split(/\r?\n/);
    const subjectLine = lines.find((line) => /^主题[:：]/.test(line));
    const subject = (subjectLine?.replace(/^主题[:：]\s*/, '') || artifact.title).replaceAll(/[\r\n]/g, ' ');
    return { type: 'message/rfc822; charset=utf-8', extension: 'eml', content: `Subject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\nX-Irixi-Status: Draft-Only\r\n\r\n${artifact.content}\r\n` };
  }
  if (format === 'ics' && task.type === 'calendar') {
    const uid = `${artifact.id}@irixi.local`;
    const stamp = new Date().toISOString().replaceAll(/[-:]/g, '').replace('.000', '');
    const clean = (value) => String(value).replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll(',', '\\,').replaceAll(';', '\\;');
    return { type: 'text/calendar; charset=utf-8', extension: 'ics', content: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Irixi//Office Agent 1.0//ZH-CN\r\nMETHOD:PUBLISH\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:${stamp}\r\nSUMMARY:${clean(artifact.title)}\r\nDESCRIPTION:${clean(`${artifact.content}\n\n此文件是 Irixi 生成的草稿；导入前请确认时间与参与者。`)}\r\nSTATUS:TENTATIVE\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` };
  }
  throw new Error('这个成果类型不支持所选导出格式。');
}

function processOutput(command, args, { timeoutMs = 20_000, cwd, env, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('本地制作进程已按取消请求终止。'), { code: 'cancelled' }));
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], cwd, env: env ? { ...process.env, ...env } : process.env });
    const output = [];
    const errors = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size <= MAX_MATERIAL_BYTES) output.push(chunk); });
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.once('error', (error) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) return reject(Object.assign(new Error('本地制作进程已按取消请求终止。'), { code: 'cancelled' }));
      if (size > MAX_MATERIAL_BYTES) return reject(new Error('解析后的材料超过 1.5 MB 上限。'));
      if (code !== 0) return reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `解析工具退出码 ${code}`));
      resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}

async function ensureArtifactRuntime() {
  await fs.mkdir(artifactRuntimeRoot, { recursive: true });
  const modulesLink = path.join(artifactRuntimeRoot, 'node_modules');
  try { await fs.symlink(bundledNodeModules, modulesLink, 'dir'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const worker = path.join(artifactRuntimeRoot, 'artifact-worker.mjs');
  await fs.copyFile(path.join(moduleDir, 'artifact-worker.mjs'), worker);
  const fontCache = path.join(artifactRuntimeRoot, 'font-cache');
  await fs.mkdir(fontCache, { recursive: true });
  const fontConfig = path.join(artifactRuntimeRoot, 'fonts.conf');
  const escapeXml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  await fs.writeFile(fontConfig, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig><dir>${escapeXml(path.dirname(documentFontPath))}</dir><cachedir>${escapeXml(fontCache)}</cachedir></fontconfig>\n`, { mode: 0o600 });
  return { worker, fontConfig };
}

const sha256File = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function nativePreviewFiles(kind, candidateDir) {
  if (kind === 'document') {
    const previewDir = path.join(candidateDir, 'document-preview');
    const names = (await fs.readdir(previewDir)).filter((name) => name.endsWith('.png')).sort();
    return names.map((name) => path.join(previewDir, name));
  }
  const prefix = kind === 'spreadsheet' ? 'spreadsheet.xlsx.sheet-' : 'presentation.pptx.slide-';
  const names = (await fs.readdir(candidateDir)).filter((name) => name.startsWith(prefix) && name.endsWith('.png')).sort();
  return names.map((name) => path.join(candidateDir, name));
}

async function recordedPreviewFiles(nativeFile, taskDir) {
  if (!nativeFile?.previewPaths?.length) return [];
  const root = `${path.resolve(taskDir)}${path.sep}`;
  const files = nativeFile.previewPaths.map((relative) => path.resolve(taskDir, relative));
  if (files.some((file) => !file.startsWith(root))) return [];
  try {
    const stats = await Promise.all(files.map((file) => fs.stat(file)));
    return stats.every((stat) => stat.isFile() && stat.size > 0) ? files : [];
  } catch {
    return [];
  }
}

async function generateNativeCandidateFiles(store, taskId, artifactId, { signal, runId, workItemId, force = false } = {}) {
  const assertFresh = (task) => {
    if (signal?.aborted) throw Object.assign(new Error('候选文件生成已取消。'), { code: 'cancelled' });
    if (runId && task.execution?.id !== runId) throw Object.assign(new Error('候选文件属于旧运行，未写入当前成果。'), { code: 'stale_result' });
    if (workItemId && !task.workItems.some((item) => item.id === workItemId && item.status === 'running')) throw Object.assign(new Error('候选文件所属工作项已不在运行。'), { code: 'stale_result' });
  };
  const snapshot = await store.get(taskId);
  assertFresh(snapshot);
  await assertProjectGoalFresh(store, snapshot);
  const artifact = snapshot.artifacts.find((entry) => entry.id === artifactId);
  if (!artifact) throw new Error('找不到要生成原生文件的候选成果。');
  const deliverables = (artifact.deliverables || []).filter((entry) => ['document', 'spreadsheet', 'presentation'].includes(entry.kind));
  if (!deliverables.length) return [];
  const runtime = await ensureArtifactRuntime();
  const taskDir = store.taskDir(taskId);
  const candidateDir = path.join(taskDir, 'exports', 'candidates', artifact.id);
  await fs.mkdir(candidateDir, { recursive: true });
  const records = [];
  for (const deliverable of deliverables) {
    const extension = { document: 'docx', spreadsheet: 'xlsx', presentation: 'pptx' }[deliverable.kind];
    const outputPath = path.join(candidateDir, `${deliverable.kind}.${extension}`);
    const requestPath = path.join(candidateDir, `${deliverable.kind}.request.json`);
    const contentSha256 = crypto.createHash('sha256').update(deliverable.content).digest('hex');
    let previousRequest = null;
    try { previousRequest = JSON.parse(await fs.readFile(requestPath, 'utf8')); } catch { /* No reusable prior attempt. */ }
    if (!force && previousRequest?.generatorRevision === nativeGeneratorRevision
      && previousRequest?.kind === deliverable.kind && previousRequest?.title === (deliverable.title || artifact.title)
      && previousRequest?.content === deliverable.content && path.resolve(previousRequest.outputPath) === outputPath) {
      try {
        const stat = await fs.stat(outputPath);
        const receipt = JSON.parse(await fs.readFile(`${outputPath}.receipt.json`, 'utf8'));
        const outputSha256 = await sha256File(outputPath);
        const previousNative = (artifact.nativeFiles || []).find((entry) => entry.kind === deliverable.kind
          && entry.status === 'ready' && entry.contentSha256 === contentSha256
          && entry.generatorRevision === nativeGeneratorRevision && entry.sha256 === outputSha256
          && entry.previewSourceSha256 === outputSha256);
        const previewFiles = await recordedPreviewFiles(previousNative, taskDir);
        if (stat.isFile() && stat.size >= 100 && receipt.kind === deliverable.kind && path.resolve(receipt.outputPath) === outputPath && previewFiles.length) {
          records.push({
            kind: deliverable.kind, format: extension, filename: `${safeFilename(deliverable.title || artifact.title)}-v${artifact.version}.${extension}`,
            status: 'ready', relativePath: path.relative(taskDir, outputPath), sha256: outputSha256, bytes: stat.size, contentSha256,
            generatorRevision: nativeGeneratorRevision,
            previewSourceSha256: outputSha256,
            previewPaths: previewFiles.map((file) => path.relative(taskDir, file)), validation: receipt.validation || null,
            generatedAt: receipt.createdAt || new Date().toISOString(), reusedAt: new Date().toISOString(),
          });
          await store.mutate(taskId, async (task) => {
            await assertProjectGoalFresh(store, task, artifact.projectRootGoalVersionId, artifact.projectRootInputFingerprint);
            assertFresh(task);
            const current = task.artifacts.find((entry) => entry.id === artifactId);
            if (!current) throw new Error('候选成果已不存在。');
            current.nativeFiles = structuredClone(records);
          });
          continue;
        }
      } catch { /* Existing files are incomplete; regenerate this deliverable. */ }
    }
    await fs.writeFile(requestPath, `${JSON.stringify({
      generatorRevision: nativeGeneratorRevision,
      kind: deliverable.kind, title: deliverable.title || artifact.title, content: deliverable.content,
      outputPath, workspaceDir: taskDir, contentSha256,
    }, null, 2)}\n`, { mode: 0o600 });
    try {
      await processOutput(bundledNode, [runtime.worker, requestPath], {
        timeoutMs: 120_000,
        cwd: artifactRuntimeRoot,
        env: { RUNTIME_NODE_MODULES: bundledNodeModules, IRIXI_PRESENTATION_SKILL: presentationSkillRoot, IRIXI_RUNTIME_PYTHON: bundledPython, IRIXI_DOCUMENT_FONT: documentFontPath },
        signal,
      });
      assertFresh(await store.get(taskId));
      let previewFiles = [];
      const outputSha256 = await sha256File(outputPath);
      if (deliverable.kind === 'document') {
        const previewDir = path.join(candidateDir, `document-preview-${outputSha256.slice(0, 12)}-${crypto.randomUUID()}`);
        await processOutput(bundledPython, [documentRenderScript, outputPath, '--output_dir', previewDir], { timeoutMs: 120_000, env: { FONTCONFIG_FILE: runtime.fontConfig }, signal });
        const names = (await fs.readdir(previewDir)).filter((name) => name.endsWith('.png')).sort();
        previewFiles = names.map((name) => path.join(previewDir, name));
      } else {
        previewFiles = await nativePreviewFiles(deliverable.kind, candidateDir);
      }
      if (!previewFiles.length) throw new Error(`${deliverable.kind.toUpperCase()} 未能渲染出检查页面。`);
      const stat = await fs.stat(outputPath);
      if (!stat.isFile() || stat.size < 100) throw new Error('生成的原生文件为空或不完整。');
      const receipt = JSON.parse(await fs.readFile(`${outputPath}.receipt.json`, 'utf8'));
      records.push({
        kind: deliverable.kind, format: extension, filename: `${safeFilename(deliverable.title || artifact.title)}-v${artifact.version}.${extension}`,
        status: 'ready', relativePath: path.relative(taskDir, outputPath), sha256: outputSha256, bytes: stat.size, contentSha256,
        generatorRevision: nativeGeneratorRevision,
        previewSourceSha256: outputSha256,
        previewPaths: previewFiles.map((file) => path.relative(taskDir, file)), validation: receipt.validation || null, generatedAt: new Date().toISOString(),
      });
      await store.mutate(taskId, async (task) => {
        await assertProjectGoalFresh(store, task, artifact.projectRootGoalVersionId, artifact.projectRootInputFingerprint);
        assertFresh(task);
        const current = task.artifacts.find((entry) => entry.id === artifactId);
        if (!current) throw new Error('候选成果已不存在。');
        current.nativeFiles = structuredClone(records);
      });
    } catch (error) {
      const failed = { kind: deliverable.kind, format: extension, filename: `${safeFilename(deliverable.title || artifact.title)}-v${artifact.version}.${extension}`, status: 'failed', contentSha256, generatorRevision: nativeGeneratorRevision, error: error.message, generatedAt: new Date().toISOString() };
      await store.mutate(taskId, async (task) => {
        await assertProjectGoalFresh(store, task, artifact.projectRootGoalVersionId, artifact.projectRootInputFingerprint);
        assertFresh(task);
        const current = task.artifacts.find((entry) => entry.id === artifactId);
        if (current) current.nativeFiles = [...structuredClone(records), failed];
        event(task, 'artifact.native_failed', `${deliverable.kind} 候选文件生成或渲染检查失败：${error.message}`, { artifactId, kind: deliverable.kind });
      });
      throw Object.assign(new Error(`${deliverable.kind} 候选文件生成失败：${error.message}`), { code: 'native_generation_failed' });
    }
  }
  await store.mutate(taskId, async (task) => {
    await assertProjectGoalFresh(store, task, artifact.projectRootGoalVersionId, artifact.projectRootInputFingerprint);
    assertFresh(task);
    const current = task.artifacts.find((entry) => entry.id === artifactId);
    if (!current) throw new Error('候选成果已不存在。');
    current.nativeFiles = records;
    event(task, 'artifact.native_ready', `${records.length} 份原生候选文件已生成并渲染检查。`, { artifactId, files: records.map((entry) => ({ kind: entry.kind, filename: entry.filename, sha256: entry.sha256 })) });
  });
  return records;
}

async function parseUploadedMaterial(taskDir, input) {
  const name = safeFilename(input.name, 'material.txt');
  const extension = path.extname(name).toLowerCase();
  if (!['.txt', '.md', '.markdown', '.docx', '.pdf'].includes(extension)) throw new Error('只支持 TXT、MD、DOCX 和 PDF 文件。');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(String(input.base64 || ''))) throw new Error('文件内容编码不正确。');
  const bytes = Buffer.from(String(input.base64 || ''), 'base64');
  if (!bytes.length || bytes.length > MAX_MATERIAL_BYTES) throw new Error('文件必须大于 0 且不超过 1.5 MB。');
  const uploadDir = path.join(taskDir, 'materials');
  await fs.mkdir(uploadDir, { recursive: true });
  const file = path.join(uploadDir, `${Date.now()}-${name}`);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  if (['.txt', '.md', '.markdown'].includes(extension)) return { name, kind: extension.slice(1), source: `local-file:${name}`, text: bytes.toString('utf8'), bytes: bytes.length };
  if (extension === '.docx') {
    const text = (await processOutput('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file])).trim();
    if (!text) throw new Error('DOCX 没有可读取的正文。');
    return { name, kind: 'docx', source: `local-file:${name}`, text, bytes: bytes.length };
  }
  const swiftCache = path.join(projectRoot, '.irixi-runtime', 'swift-module-cache');
  await fs.mkdir(swiftCache, { recursive: true });
  const swift = 'import Foundation; import PDFKit; let p=CommandLine.arguments[1]; guard let d=PDFDocument(url: URL(fileURLWithPath:p)), let s=d.string, !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { exit(2) }; print(s)';
  let text;
  try {
    text = (await processOutput('/usr/bin/swift', ['-module-cache-path', swiftCache, '-e', swift, file], { timeoutMs: 60_000 })).trim();
  } catch {
    throw new Error('这份 PDF 无法可靠提取文字；请改用可搜索 PDF 或粘贴正文。');
  }
  return { name, kind: 'pdf', source: `local-file:${name}`, text, bytes: bytes.length };
}

async function callProviderStep(store, providers, taskId, role, method, signal, artifactId = null) {
  while (true) {
    let callId = null;
    let task;
    if (signal.aborted) { const error = new Error('运行已取消。'); error.code = 'cancelled'; throw error; }
    if (method === 'generate' || method === 'review') {
      const current = await store.get(taskId);
      assertNoCriticalMaterialDecision(current, method === 'review' ? '独立审阅' : '候选成果');
    }
    if ((await store.get(taskId)).provider === 'codex-cli') {
      const reserved = await store.mutate(taskId, (draft) => {
        const call = reserveModelCall(draft, role);
        event(draft, 'model.call', `${role} 已占用第 ${draft.execution.modelCalls.length}/${draft.execution.limits.maxModelCalls} 次模型调用。`, { callId: call.id, role, usage: 'unknown' });
        return call;
      });
      callId = reserved.result.id;
      task = reserved.task;
    } else {
      task = await store.get(taskId);
    }
    task = await hydrateProjectContext(store, task);
    try {
      if (method === 'generate' || method === 'review') assertNoCriticalMaterialDecision(task, method === 'review' ? '独立审阅' : '候选成果');
      const artifact = artifactId ? task.artifacts.find((item) => item.id === artifactId) : null;
      const result = method === 'review'
        ? await providers.review(task, artifact, { signal })
        : await providers[method](task, { signal });
      if (callId) await store.mutate(taskId, (draft) => finishModelCall(draft, callId, { status: 'completed', usage: result?._providerMeta?.usage || 'unknown' }));
      return result;
    } catch (error) {
      const changed = await store.mutate(taskId, (draft) => {
        if (callId) finishModelCall(draft, callId, { status: error.code === 'cancelled' ? 'cancelled' : 'failed', error: error.message });
        const attempt = recordAttempt(draft, role, error);
        event(draft, 'work.attempt_failed', `${role} 第 ${attempt} 次尝试失败：${error.message}`, { role, attempt, code: error.code || 'provider_error' });
        return mayRetry(draft, role, error);
      });
      if (error.code === 'cancelled' || signal.aborted || !changed.result) throw error;
    }
  }
}

async function callDynamicWork(store, providers, projectWorkspaceHost, taskId, workItemId, signal, runId) {
  const initial = await store.get(taskId);
  const initialItem = initial.workItems.find((candidate) => candidate.id === workItemId);
  if (initial.type === 'project' && initialItem?.kind === 'tool'
    && initial.projectWorkspace?.executionMode === 'host_fixed_transaction_v1') {
    return callFixedProjectTransaction(store, providers, projectWorkspaceHost, taskId, workItemId, signal, runId);
  }
  let toolResults = [];
  const seenRequestIds = new Set();
  for (let round = 0; round < 4; round += 1) {
    if (signal.aborted) throw Object.assign(new Error('运行已取消。'), { code: 'cancelled' });
    const prepared = await store.mutate(taskId, (task) => {
      const item = task.workItems.find((candidate) => candidate.id === workItemId);
      const session = workSession(task, workItemId);
      assertSessionFresh(task, session, { runId });
      if (!item || item.status !== 'running') throw Object.assign(new Error('工作项已经不在当前运行中。'), { code: 'stale_result' });
      if (item.kind === 'synthesis') assertNoCriticalMaterialDecision(task, '候选成果');
      const attemptId = `${runId}:${workItemId}:${round + 1}`;
      const input = sessionInput(task, item, toolResults, []);
      markSession(task, workItemId, 'running', { runId, attemptId, input, toolCalls: session.toolCalls || [] });
      const call = reserveModelCall(task, item.role);
      event(task, 'model.call', `${item.title} 已占用第 ${task.execution.modelCalls.length}/${task.execution.limits.maxModelCalls} 次模型调用。`, { callId: call.id, role: item.role, agentId: item.agentId, workItemId, round: round + 1 });
      return { item: structuredClone(item), input, callId: call.id, attemptId, planRevision: task.plan.revision, maxToolRounds: task.execution.limits.maxToolRoundsPerStep };
    });
    try {
      const providerTask = await hydrateProjectContext(store, prepared.task);
      const providerInput = {
        ...prepared.result.input,
        projectContext: providerTask.projectContext,
        linkedTaskContext: providerTask.linkedTaskContext,
        continuity: deriveTaskContinuity(providerTask),
      };
      if (providerTask.type === 'project' && prepared.result.item.kind === 'synthesis') {
        providerInput.projectSourceIntegrity = await projectWorkspaceHost.currentSourceIntegrity(providerTask, store.taskDir(taskId));
        providerInput.projectExecutionAudit = projectExecutionAudit(providerTask, { synthesisWorkItemId: prepared.result.item.id });
      }
      await store.mutate(taskId, async (task) => {
        await assertProjectGoalFresh(store, task, providerInput.projectRootGoalVersionId, providerInput.projectRootInputFingerprint);
        const session = workSession(task, workItemId);
        assertSessionFresh(task, session, { runId, attemptId: prepared.result.attemptId });
        session.input = structuredClone(providerInput);
        session.updatedAt = new Date().toISOString();
      });
      const result = await providers.executeWork(providerTask, prepared.result.item, providerInput, { signal });
      await store.mutate(taskId, async (task) => {
        await assertProjectGoalFresh(store, task, providerInput.projectRootGoalVersionId, providerInput.projectRootInputFingerprint);
        const session = workSession(task, workItemId);
        assertSessionFresh(task, session, { runId, attemptId: prepared.result.attemptId });
        finishModelCall(task, prepared.result.callId, { status: 'completed', usage: result?._providerMeta?.usage || 'unknown' });
      });
      const requests = Array.isArray(result.toolRequests) ? result.toolRequests : [];
      let protocolError = null;
      try {
        const session = workSession(prepared.task, workItemId);
        validateWorkResult(prepared.result.item, result, { toolCalls: session?.toolCalls || [] });
        const claimErrors = (result.claims || []).map((claim, index) => ({ index, check: validateClaim(prepared.task, claim) })).filter((entry) => !entry.check.passed);
        if (claimErrors.length) throw new Error(`来源声明未通过宿主核对：${claimErrors.map((entry) => `第 ${entry.index + 1} 条 ${entry.check.reason}`).join('；')}`);
      } catch (error) {
        if (error.code === 'work_gap') throw error;
        protocolError = error.message;
      }
      if (!requests.length && !protocolError) return result;
      if (round >= prepared.result.maxToolRounds) throw new Error(protocolError || '模型在工具往返上限后仍未形成工作结果。');
      for (const request of requests) {
        if (seenRequestIds.has(request.id)) throw new Error(`模型重复了工具请求 ${request.id}。`);
        seenRequestIds.add(request.id);
      }
      const latest = await store.get(taskId);
      const item = latest.workItems.find((candidate) => candidate.id === workItemId);
      const onHostedSearchStart = async () => {
        const reserved = await store.mutate(taskId, (task) => {
          const current = task.workItems.find((candidate) => candidate.id === workItemId);
          const call = reserveModelCall(task, 'web-search');
          event(task, 'model.call', `公开搜索已占用第 ${task.execution.modelCalls.length}/${task.execution.limits.maxModelCalls} 次模型调用。`, {
            callId: call.id, role: 'web-search', agentId: current?.agentId || null, workItemId,
          });
          return call.id;
        });
        return {
          onFinish: async ({ status, usage, error }) => {
            await store.mutate(taskId, (task) => {
              const finalStatus = status === 'succeeded' ? 'completed' : status === 'aborted' ? 'cancelled' : 'failed';
              const finished = finishModelCall(task, reserved.result, {
                status: finalStatus,
                usage: usage ?? 'unknown',
                error: error?.message || null,
              });
              if (!finished) throw new Error('找不到公开搜索的模型调用记录。');
            });
          },
        };
      };
      const executed = await runAuthorizedTools(store, latest, item, requests, { signal, onHostedSearchStart, projectWorkspaceHost });
      const feedback = protocolError ? [{ requestId: `protocol-${round + 1}`, tool: 'protocol', ok: false, error: protocolError, sources: [] }] : [];
      toolResults = [...toolResults, ...executed, ...feedback];
      await store.mutate(taskId, (task) => {
        const session = workSession(task, workItemId);
        assertSessionFresh(task, session, { runId, attemptId: prepared.result.attemptId });
        const current = task.workItems.find((candidate) => candidate.id === workItemId);
        let sequence = session.toolCalls.filter((entry) => entry.hostAudit).length;
        const recorded = executed.map((entry, index) => entry.tool?.startsWith('workspace.')
          ? stampProjectToolCall(task, current, session, requests[index], entry, {
            runId, attemptId: prepared.result.attemptId, round: round + 1, batchOrdinal: round + 1,
            requestOrdinal: index + 1, sessionSequence: ++sequence,
          })
          : entry);
        session.toolCalls.push(...[...recorded, ...feedback].map((entry) => ({ ...entry, at: new Date().toISOString() })));
        event(task, 'tool.batch_completed', `${item.title} 的 ${executed.length} 个受控工具请求已完成。`, { workItemId, agentId: item.agentId, requests: executed.map((entry) => ({ requestId: entry.requestId, tool: entry.tool, ok: entry.ok, sources: entry.sources })) });
      });
    } catch (error) {
      await store.mutate(taskId, (task) => {
        const session = workSession(task, workItemId);
        if (session && session.runId === runId) markSession(task, workItemId, error.code === 'cancelled' ? 'cancelled' : 'failed', { error: error.message });
        finishModelCall(task, prepared.result.callId, { status: error.code === 'cancelled' ? 'cancelled' : 'failed', error: error.message });
        if (task.workItems.some((item) => item.id === workItemId)) recordWorkAttempt(task, workItemId, error);
      }).catch(() => {});
      throw error;
    }
  }
  throw new Error('工具往返未能形成最终工作结果。');
}

function fixedTransactionError(message, code = 'project_transaction_failed', detail = null) {
  return Object.assign(new Error(message), { code, projectTransaction: true, detail });
}

async function callFixedProjectTransaction(store, providers, projectWorkspaceHost, taskId, workItemId, signal, runId) {
  if (signal.aborted) throw Object.assign(new Error('运行已取消。'), { code: 'cancelled' });
  const transactionId = `project-transaction-${crypto.randomUUID()}`;
  const attemptId = `${runId}:${workItemId}:transaction`;
  const opened = await store.mutate(taskId, (task) => {
    const item = task.workItems.find((candidate) => candidate.id === workItemId);
    const session = workSession(task, workItemId);
    assertSessionFresh(task, session, { runId });
    if (!item || item.status !== 'running') throw Object.assign(new Error('工作项已经不在当前运行中。'), { code: 'stale_result' });
    if ((session.toolCalls || []).some((entry) => entry.hostAudit)) throw fixedTransactionError('当前执行链已有项目工具记录，固定事务不会隐式重试。');
    markSession(task, workItemId, 'running', { runId, attemptId, toolCalls: session.toolCalls || [] });
    const current = workSession(task, workItemId);
    current.projectTransaction = {
      id: transactionId, mode: 'host_fixed_transaction_v1', status: 'reading', modelInvocationCount: 0,
      publicContractFingerprint: task.projectWorkspace.publicContractFingerprint,
      workspaceScopeFingerprint: task.projectWorkspace.scopeFingerprint,
      sourceSnapshotSha256: task.projectWorkspace.sourceSnapshotSha256,
    };
    return { item: structuredClone(item) };
  });

  const record = async (request, entry, { actor, step, sequence }) => {
    await store.mutate(taskId, (task) => {
      const item = task.workItems.find((candidate) => candidate.id === workItemId);
      const session = workSession(task, workItemId);
      assertSessionFresh(task, session, { runId, attemptId });
      const stamped = stampProjectToolCall(task, item, session, request, entry, {
        runId, attemptId, round: 1, batchOrdinal: sequence, requestOrdinal: 1, sessionSequence: sequence,
        actor, transactionId, transactionStep: step,
      });
      session.toolCalls.push({ ...stamped, at: new Date().toISOString() });
      session.projectTransaction.status = step === 'diff' ? 'verifying' : `${step}_completed`;
      session.updatedAt = new Date().toISOString();
      event(task, 'project.transaction_step', `固定项目事务已执行 ${step}。`, {
        workItemId, transactionId, step, actor, sequence, tool: entry.tool, ok: entry.ok === true,
      });
    });
  };
  const execute = async (request, meta) => {
    const latest = await store.get(taskId);
    const item = latest.workItems.find((candidate) => candidate.id === workItemId);
    const entries = await runAuthorizedTools(store, latest, item, [request], { signal, projectWorkspaceHost });
    const entry = entries[0];
    await record(request, entry, meta);
    if (!entry?.ok) throw fixedTransactionError(`固定项目事务的 ${meta.step} 步骤失败。`, 'project_transaction_failed', { step: meta.step });
    return entry;
  };

  try {
    const candidate = opened.task.projectWorkspace?.candidate;
    const path = opened.task.projectWorkspace?.editablePaths?.[0];
    const readRequest = {
      id: `host-${transactionId}-read`, tool: 'workspace.read',
      args: { path, view: 'candidate', expectedCandidateSha256: candidate?.candidateSha256 },
    };
    const readEntry = await execute(readRequest, { actor: 'host', step: 'read', sequence: 1 });
    const prepared = await store.mutate(taskId, (task) => {
      const item = task.workItems.find((candidateItem) => candidateItem.id === workItemId);
      const session = workSession(task, workItemId);
      assertSessionFresh(task, session, { runId, attemptId });
      if (task.projectWorkspace?.candidate?.candidateSha256 !== readEntry.result.candidateSha256) throw Object.assign(new Error('候选已在读取后变化。'), { code: 'stale_result' });
      const input = sessionInput(task, item, [readEntry], []);
      input.projectTransaction = {
        id: transactionId,
        mode: 'host_fixed_transaction_v1',
        publicContractFingerprint: task.projectWorkspace.publicContractFingerprint,
        readResult: structuredClone(readEntry.result),
        requiredModelAction: 'one_workspace_write',
        hostNextActions: ['workspace.check', 'workspace.diff'],
      };
      const call = reserveModelCall(task, item.role);
      session.input = structuredClone(input);
      session.projectTransaction.status = 'awaiting_candidate';
      session.projectTransaction.modelInvocationCount = 1;
      session.projectTransaction.modelCallId = call.id;
      session.updatedAt = new Date().toISOString();
      event(task, 'model.call', `${item.title} 已占用第 ${task.execution.modelCalls.length}/${task.execution.limits.maxModelCalls} 次模型调用。`, { callId: call.id, role: item.role, agentId: item.agentId, workItemId, transactionId });
      return { item: structuredClone(item), input, callId: call.id };
    });
    const providerTask = await hydrateProjectContext(store, prepared.task);
    const providerInput = {
      ...prepared.result.input,
      projectContext: providerTask.projectContext,
      linkedTaskContext: providerTask.linkedTaskContext,
      continuity: deriveTaskContinuity(providerTask),
    };
    await store.mutate(taskId, async (task) => {
      await assertProjectGoalFresh(store, task, providerInput.projectRootGoalVersionId, providerInput.projectRootInputFingerprint);
      const session = workSession(task, workItemId);
      assertSessionFresh(task, session, { runId, attemptId });
      session.input = structuredClone(providerInput);
      session.updatedAt = new Date().toISOString();
    });
    let result;
    try {
      result = await providers.executeWork(providerTask, prepared.result.item, providerInput, { signal });
      await store.mutate(taskId, (task) => finishModelCall(task, prepared.result.callId, { status: 'completed', usage: result?._providerMeta?.usage || 'unknown' }));
    } catch (error) {
      await store.mutate(taskId, (task) => finishModelCall(task, prepared.result.callId, { status: error.code === 'cancelled' ? 'cancelled' : 'failed', error: error.message })).catch(() => {});
      if (error.code === 'cancelled' || error.code === 'stale_result') throw error;
      throw fixedTransactionError('候选生成未完成，固定项目事务已停止。');
    }
    validateWorkResult(prepared.result.item, result, { toolCalls: [readEntry] });
    const requests = Array.isArray(result.toolRequests) ? result.toolRequests : [];
    if (requests.length !== 1 || requests[0].tool !== 'workspace.write') {
      throw fixedTransactionError('固定项目事务只接受一个候选 workspace.write，不会隐式追加工具轮次。');
    }
    const writeEntry = await execute(requests[0], { actor: 'model', step: 'write', sequence: 2 });
    const currentCandidateSha256 = writeEntry.result.candidateSha256;
    const checkRequest = {
      id: `host-${transactionId}-check`, tool: 'workspace.check',
      args: { checkId: providerTask.projectWorkspace.checks[0].id, expectedCandidateSha256: currentCandidateSha256 },
    };
    const checkEntry = await execute(checkRequest, { actor: 'host', step: 'check', sequence: 3 });
    const diffRequest = {
      id: `host-${transactionId}-diff`, tool: 'workspace.diff',
      args: { expectedCandidateSha256: currentCandidateSha256 },
    };
    const diffEntry = await execute(diffRequest, { actor: 'host', step: 'diff', sequence: 4 });
    if (checkEntry.result.passed !== true) {
      throw fixedTransactionError(`固定业务检查未通过（${checkEntry.result.casePassed}/${checkEntry.result.caseTotal}）；候选和诊断已保留，不会隐式重试。`, 'project_verification_failed', {
        checkId: checkEntry.result.checkId,
        casePassed: checkEntry.result.casePassed,
        caseTotal: checkEntry.result.caseTotal,
        resultDigest: checkEntry.result.resultDigest,
        candidateSha256: currentCandidateSha256,
        diffSha256: diffEntry.result.diffSha256,
      });
    }
    await store.mutate(taskId, (task) => {
      const session = workSession(task, workItemId);
      assertSessionFresh(task, session, { runId, attemptId });
      session.projectTransaction.status = 'passed';
      session.projectTransaction.checkId = checkEntry.result.checkId;
      session.projectTransaction.resultDigest = checkEntry.result.resultDigest;
      session.projectTransaction.candidateSha256 = currentCandidateSha256;
      session.projectTransaction.diffSha256 = diffEntry.result.diffSha256;
      session.updatedAt = new Date().toISOString();
    });
    const evidence = {
      transactionId,
      checkId: checkEntry.result.checkId,
      casePassed: checkEntry.result.casePassed,
      caseTotal: checkEntry.result.caseTotal,
      resultDigest: checkEntry.result.resultDigest,
      candidateSha256: currentCandidateSha256,
      diffSha256: diffEntry.result.diffSha256,
      regionIntegritySha256: diffEntry.result.regionIntegrity?.integritySha256 || null,
      sourceIntegritySha256: diffEntry.result.sourceIntegrity?.integritySha256 || null,
    };
    return {
      summary: '固定项目事务已完成真实读取、候选写入、原生检查与局部差异核对。',
      output: JSON.stringify(evidence), sources: [], claims: [], gap: '', caveats: [], toolRequests: [], deliverables: [],
      acceptanceChecks: prepared.result.item.acceptanceCriteria.map((criterion) => ({ criterion, passed: true, evidence: `host transaction ${transactionId}` })),
      hostProjectTransaction: evidence,
    };
  } catch (error) {
    const stopped = error.code === 'cancelled' || error.code === 'stale_result' || error.projectTransaction === true
      ? error
      : fixedTransactionError('固定项目事务未完成，已停止且不会隐式重试。');
    await store.mutate(taskId, (task) => {
      const session = workSession(task, workItemId);
      if (session?.runId === runId && session.projectTransaction?.id === transactionId) {
        session.projectTransaction.status = 'failed';
        session.projectTransaction.errorCode = stopped.code || 'project_transaction_failed';
        session.projectTransaction.failure = stopped.detail || null;
        session.error = stopped.message;
        session.updatedAt = new Date().toISOString();
      }
    }).catch(() => {});
    throw stopped;
  }
}

async function callDynamicReview(store, providers, taskId, item, artifactId, signal, runId) {
  const prepared = await store.mutate(taskId, (task) => {
    const session = workSession(task, item.id);
    assertSessionFresh(task, session, { runId });
    const attemptId = `${runId}:${item.id}:review`;
    markSession(task, item.id, 'running', { runId, attemptId, input: { artifactId } });
    const call = reserveModelCall(task, item.role);
    return { callId: call.id, attemptId, snapshot: structuredClone(task), artifact: structuredClone(task.artifacts.find((artifact) => artifact.id === artifactId)) };
  });
  try {
    const providerTask = await hydrateProjectContext(store, prepared.result.snapshot);
    const providerInput = {
      artifactId,
      projectContext: providerTask.projectContext,
      linkedTaskContext: providerTask.linkedTaskContext,
      continuity: deriveTaskContinuity(providerTask),
    };
    await store.mutate(taskId, async (task) => {
      await assertProjectGoalFresh(store, task, providerTask.projectRootGoalVersionId, providerTask.projectRootInputFingerprint);
      assertSessionFresh(task, workSession(task, item.id), { runId, attemptId: prepared.result.attemptId });
      markSession(task, item.id, 'running', { input: providerInput });
    });
    const result = await providers.review(providerTask, prepared.result.artifact, { signal });
    await store.mutate(taskId, async (task) => {
      await assertProjectGoalFresh(store, task, providerTask.projectRootGoalVersionId, providerTask.projectRootInputFingerprint);
      assertSessionFresh(task, workSession(task, item.id), { runId, attemptId: prepared.result.attemptId });
      finishModelCall(task, prepared.result.callId, { status: 'completed', usage: result?._providerMeta?.usage || 'unknown' });
    });
    return result;
  } catch (error) {
    await store.mutate(taskId, (task) => finishModelCall(task, prepared.result.callId, { status: error.code === 'cancelled' ? 'cancelled' : 'failed', error: error.message })).catch(() => {});
    throw error;
  }
}

async function requestReplan(store, providers, taskId, failure, signal, runId) {
  const reserved = await store.mutate(taskId, (task) => {
    if (task.execution?.id !== runId) throw Object.assign(new Error('旧运行不能发起重规划。'), { code: 'stale_result' });
    if (task.execution.planRevisions >= task.execution.limits.maxPlanRevisions) throw Object.assign(new Error('重规划次数已达到上限。'), { code: 'budget_exhausted' });
    setTaskState(task, 'running', 'coordinator', 'Irixi 正在根据刚才的真实失败有界重排必要步骤。');
    const call = reserveModelCall(task, 'planner');
    return { callId: call.id, snapshot: structuredClone(task), revision: task.plan.revision };
  });
  try {
    const providerTask = await hydrateProjectContext(store, reserved.result.snapshot);
    const plan = await providers.replan(providerTask, failure, { signal });
    validateModelPlan(reserved.result.snapshot, plan);
    return await store.mutate(taskId, async (task) => {
      await assertProjectGoalFresh(store, task, providerTask.projectRootGoalVersionId, providerTask.projectRootInputFingerprint);
      if (task.execution?.id !== runId || task.plan?.revision !== reserved.result.revision) throw Object.assign(new Error('重规划结果属于旧运行。'), { code: 'stale_result' });
      finishModelCall(task, reserved.result.callId, { status: 'completed', usage: plan?._providerMeta?.usage || 'unknown' });
      task.execution.planRevisions += 1;
      applyModelPlan(task, plan, { reason: 'gap_replan', preserveCompleted: true });
      setTaskState(task, 'running', 'coordinator', `计划已根据真实缺口重排，继续执行第 ${task.plan.revision} 版。`);
      return task.plan;
    });
  } catch (error) {
    await store.mutate(taskId, (task) => {
      const call = task.execution?.modelCalls.find((item) => item.id === reserved.result.callId);
      if (call?.status === 'running') finishModelCall(task, call.id, { status: error.code === 'cancelled' ? 'cancelled' : 'failed', error: error.message });
    }).catch(() => {});
    throw error;
  }
}

function artifactContentSha256(artifact) {
  return crypto.createHash('sha256').update(JSON.stringify({
    content: artifact.content,
    deliverables: (artifact.deliverables || []).map((entry) => ({ kind: entry.kind, title: entry.title, content: entry.content })),
  })).digest('hex');
}

async function trustedReviewOptions(task, artifact, taskDir, projectWorkspaceHost) {
  if (task.type !== 'project') return {};
  await projectWorkspaceHost.assertArtifactFilesCurrent(task, taskDir, artifact);
  assertProjectExecutionAuditCurrent(task, artifact);
  return { projectReviewFacts: createTrustedProjectReviewFacts(task, artifact) };
}

function recoverableNativeCandidate(task) {
  if (!['failed', 'partial'].includes(task.status) || task.plan?.source !== 'model' || !task.execution) return null;
  const goal = activeGoal(task);
  const item = task.workItems.find((entry) => entry.kind === 'synthesis' && entry.status === 'failed' && /候选文件生成失败/.test(entry.error || ''));
  if (!item || item.goalVersionId !== goal.id || !item.inputFingerprint || !item.sourceContextFingerprint) return null;
  const session = task.agentSessions?.findLast((entry) => entry.workItemId === item.id && entry.runId === task.execution.id && entry.planRevision === task.plan.revision && ['running', 'failed'].includes(entry.status));
  if (!session || !session.attemptId?.startsWith(`${task.execution.id}:${item.id}:`)) return null;
  const artifact = task.artifacts?.filter((entry) => entry.goalVersionId === goal.id && entry.status === 'candidate' && entry.reviewStatus === 'pending').at(-1);
  if (!artifact || artifact.provider !== task.provider || task.reviews?.some((review) => review.artifactId === artifact.id)) return null;
  if (!applicabilityFingerprintMatches(task, artifact.materialApplicabilityFingerprint)
    || (item.materialApplicabilityFingerprint ?? null) !== materialContext(task, { includeGeneratedEvidence: false }).fingerprint
    || (session.materialApplicabilityFingerprint ?? null) !== (item.materialApplicabilityFingerprint ?? null)) return null;
  const expectedKinds = task.plan.deliverables || [task.plan.outputKind];
  if (expectedKinds.some((kind) => !artifact.deliverables?.some((entry) => entry.kind === kind && String(entry.content || '').trim()))) return null;
  if ((item.dependsOn || []).some((id) => !artifact.workResultIds.includes(id) || task.workItems.find((entry) => entry.id === id)?.status !== 'completed')) return null;
  const currentMaterialIds = materialContext(task, { includeGeneratedEvidence: false }).effectiveMaterials.map((entry) => entry.id).sort();
  const currentSuggestionIds = task.suggestions.filter((entry) => (entry.goalVersionId || goal.id) === goal.id && entry.classification === 'support' && entry.status === 'routed').map((entry) => entry.id).sort();
  if (JSON.stringify([...(item.inputMaterialIds || [])].sort()) !== JSON.stringify(currentMaterialIds)
    || JSON.stringify([...(item.inputSuggestionIds || [])].sort()) !== JSON.stringify(currentSuggestionIds)) return null;
  const contentSha256 = artifactContentSha256(artifact);
  if (session.nativeCandidate) {
    if (session.nativeCandidate.artifactId !== artifact.id
      || session.nativeCandidate.contentSha256 !== contentSha256
      || session.nativeCandidate.inputFingerprint !== item.inputFingerprint
      || session.nativeCandidate.sourceContextFingerprint !== item.sourceContextFingerprint
      || (session.nativeCandidate.materialApplicabilityFingerprint ?? null) !== (item.materialApplicabilityFingerprint ?? null)) return null;
  } else {
    const failedNative = (artifact.nativeFiles || []).filter((entry) => entry.status === 'failed');
    if (!failedNative.length || failedNative.some((entry) => {
      const deliverable = artifact.deliverables.find((candidate) => candidate.kind === entry.kind);
      return !deliverable || entry.contentSha256 !== crypto.createHash('sha256').update(deliverable.content).digest('hex');
    })) return null;
    const callEvent = task.events?.findLast((entry) => entry.type === 'model.call' && entry.detail?.workItemId === item.id && entry.detail?.callId);
    const call = callEvent && task.execution.modelCalls.find((entry) => entry.id === callEvent.detail.callId && entry.status === 'completed' && entry.finishedAt);
    const createdEvent = task.events?.findLast((entry) => entry.type === 'artifact.created' && entry.detail?.artifactId === artifact.id);
    const failedEvent = task.events?.findLast((entry) => entry.type === 'artifact.native_failed' && entry.detail?.artifactId === artifact.id);
    if (!call || !createdEvent || !failedEvent) return null;
  }
  return { artifactId: artifact.id, workItemId: item.id, contentSha256, inputFingerprint: item.inputFingerprint, sourceContextFingerprint: item.sourceContextFingerprint };
}

async function resumeNativeCandidate(store, taskId, controller, runInfo) {
  const resume = runInfo.resumeNative;
  if (!resume) return;
  await generateNativeCandidateFiles(store, taskId, resume.artifactId, { signal: controller.signal, runId: runInfo.runId, workItemId: resume.workItemId });
  await store.mutate(taskId, (task) => {
    const item = task.workItems.find((entry) => entry.id === resume.workItemId);
    const session = workSession(task, resume.workItemId);
    const artifact = task.artifacts.find((entry) => entry.id === resume.artifactId);
    assertSessionFresh(task, session, { runId: runInfo.runId });
    if (!item || item.status !== 'running' || !artifact || artifactContentSha256(artifact) !== resume.contentSha256
      || item.inputFingerprint !== resume.inputFingerprint || item.sourceContextFingerprint !== resume.sourceContextFingerprint) {
      throw Object.assign(new Error('候选或输入已变化，不能复用旧合成结果。'), { code: 'stale_result' });
    }
    const storedResult = {
      summary: artifact.summary, output: artifact.content, sources: artifact.sources, claims: artifact.claims,
      caveats: artifact.caveats || [], artifactId: artifact.id, version: artifact.version,
    };
    completeWorkItem(task, item.id, storedResult);
    markSession(task, item.id, 'completed', { output: storedResult, nativeCandidate: { ...resume, resumedAt: new Date().toISOString() } });
    const agent = task.team.agents.find((entry) => entry.id === item.agentId);
    if (agent) agent.status = 'available';
    readyWorkItems(task);
    event(task, 'artifact.native_retry_completed', '已复用内容未变化的候选稿完成原生文件重试；旧失败记录保留，后续仍需独立审阅。', { artifactId: artifact.id, workItemId: item.id, contentSha256: resume.contentSha256 });
  });
}

async function handleDynamicWorkFailure(store, taskId, itemSnapshot, error, runId) {
  return store.mutate(taskId, (task) => {
    const item = task.workItems.find((entry) => entry.id === itemSnapshot.id);
    if (!item) return false;
    const priorAttempts = itemSnapshot.attempts?.length || 0;
    if ((item.attempts?.length || 0) <= priorAttempts) recordWorkAttempt(task, item.id, error);
    const session = workSession(task, item.id);
    if (error.projectTransaction === true || ['project_transaction_failed', 'project_verification_failed'].includes(error.code)) {
      failWorkItem(task, item.id, error, 'failed');
      if (session?.runId === runId) markSession(task, item.id, 'failed', { error: error.message });
      const agent = task.team?.agents?.find((entry) => entry.id === item.agentId);
      if (agent) agent.status = 'available';
      event(task, 'project.transaction_stopped', error.message, {
        workItemId: item.id, code: error.code || 'project_transaction_failed', detail: error.detail || null,
      });
      return { retryable: false, terminalReason: error.code === 'project_verification_failed' ? 'project_verification_failed' : 'project_transaction_failed' };
    }
    if (error.code === 'work_gap') {
      failWorkItem(task, item.id, error, 'failed');
      if (session?.runId === runId) markSession(task, item.id, 'failed', { error: error.message });
      const agent = task.team?.agents?.find((entry) => entry.id === item.agentId);
      if (agent) agent.status = 'available';
      event(task, 'work.gap_detected', `${item.title} 明确报告当前内容缺口，将交给现有有界重规划修复上游成果。`, {
        workItemId: item.id, code: error.code, message: error.message,
      });
      return { retryable: false, terminalReason: null };
    }
    const disposition = retryDisposition(task, item.id, error);
    const retryable = !['cancelled', 'stale_result', 'native_generation_failed'].includes(error.code) && disposition.retryable;
    if (retryable) {
      item.status = 'ready';
      item.error = null;
      item.updatedAt = new Date().toISOString();
      if (session?.runId === runId) markSession(task, item.id, 'planned', { error: null });
      const agent = task.team?.agents?.find((entry) => entry.id === item.agentId);
      if (agent) agent.status = 'available';
      event(task, 'work.retry_scheduled', `${item.title} 遇到可重试失败，将在同一计划和尝试上限内重试。`, {
        workItemId: item.id, attempt: item.attempts.length, maxAttempts: task.execution?.limits?.maxAttemptsPerStep,
        code: error.code || 'work_failed',
      });
      return { retryable: true, terminalReason: null };
    }
    const terminalReason = error.code === 'native_generation_failed' ? 'native_generation_failed'
      : disposition.permanent ? 'permanent_error'
        : disposition.sameErrorAtLimit ? 'same_error_exhausted' : null;
    failWorkItem(task, item.id, error, error.code === 'cancelled' ? 'cancelled' : disposition.permanent ? 'blocked' : 'failed');
    if (session?.runId === runId) markSession(task, item.id, error.code === 'cancelled' ? 'cancelled' : 'failed', { error: error.message });
    if (terminalReason) event(task, 'work.retry_stopped', terminalReason === 'permanent_error'
      ? `${item.title} 遇到权限、认证或结构类永久错误，已停止重试。`
      : terminalReason === 'same_error_exhausted'
        ? `${item.title} 在尝试上限内重复同一错误，已停止无意义重规划。`
        : `${item.title} 的原生文件生成失败；保留候选内容，不重新调用模型。`, {
      workItemId: item.id, code: error.code || 'work_failed', attempts: disposition.attempts, maxAttempts: disposition.maxAttempts,
    });
    return { retryable: false, terminalReason };
  });
}

async function runDynamicTask(store, providers, projectWorkspaceHost, taskId, controller, runInfo) {
  if (runInfo.resumeNative) await resumeNativeCandidate(store, taskId, controller, runInfo);
  while (true) {
    await answerOneQueuedConversation(store, providers, taskId, controller.signal);
    const snapshot = await store.mutate(taskId, (task) => {
      if (task.execution?.id !== runInfo.runId || activeGoal(task).id !== runInfo.goalVersionId) throw Object.assign(new Error('运行已经过期。'), { code: 'stale_result' });
      const ready = readyWorkItems(task);
      return { readyIds: ready.map((item) => item.id), planRevision: task.plan.revision };
    });
    const task = snapshot.task;
    const ready = task.workItems.filter((item) => snapshot.result.readyIds.includes(item.id));
    const reviewItem = ready.find((item) => item.kind === 'review');
    const deliveryItem = ready.find((item) => item.kind === 'delivery');
    const synthesisBlocked = ready.find((item) => item.kind === 'synthesis') && materialContext(task).blockingDecisions;
    if (synthesisBlocked?.length) {
      await store.mutate(taskId, (draft) => {
        const synthesis = draft.workItems.find((item) => item.kind === 'synthesis' && item.status === 'ready');
        if (synthesis) { synthesis.status = 'blocked'; synthesis.error = `需要材料决定：${synthesisBlocked.map((item) => item.name).join('、')}`; synthesis.updatedAt = new Date().toISOString(); }
        if (draft.execution?.phase === 'executing') transitionExecution(draft, 'partial');
        if (draft.execution) draft.execution.stopReason = 'material_decision_required';
        setTaskState(draft, 'waiting_user', 'coordinator', `形成候选前需要决定材料用途：${synthesisBlocked.map((item) => `${item.name}（${item.reason}）`).join('；')}`);
      });
      return;
    }
    const runnable = ready.filter((item) => !['review', 'delivery'].includes(item.kind)).slice(0, task.execution.limits.maxConcurrentModelCalls);

    if (runnable.length) {
      const batchResults = await Promise.allSettled(runnable.map(async (item) => {
        await store.mutate(taskId, (draft) => {
          beginWorkItem(draft, item.id);
          draft.activeAgentId = item.agentId;
          const agent = draft.team.agents.find((candidate) => candidate.id === item.agentId);
          if (agent) agent.status = 'working';
          markSession(draft, item.id, 'running', { runId: runInfo.runId });
          setTaskState(draft, 'running', item.role, `${agent?.name || item.role}正在处理“${item.title}”。`);
        });
        try {
          const result = await callDynamicWork(store, providers, projectWorkspaceHost, taskId, item.id, controller.signal, runInfo.runId);
          if (String(result.gap || '').trim()) throw Object.assign(new Error(result.gap), { code: 'work_gap' });
          const staged = await store.mutate(taskId, async (draft) => {
            const current = draft.workItems.find((candidate) => candidate.id === item.id);
            const session = workSession(draft, item.id);
            assertSessionFresh(draft, session, { runId: runInfo.runId });
            let storedResult = { summary: result.summary, output: result.output, sources: result.sources, claims: result.claims, caveats: result.caveats || [] };
            let artifactId = null;
            if (current.kind === 'synthesis') {
              const requiredKinds = draft.plan.deliverables || [draft.plan.outputKind];
              const deliverables = Array.isArray(result.deliverables) ? result.deliverables : [];
              const missingKinds = requiredKinds.filter((kind) => !deliverables.some((entry) => entry.kind === kind && String(entry.content || '').trim()));
              if (missingKinds.length) throw Object.assign(new Error(`候选成果缺少交付物：${missingKinds.join('、')}。`), { code: 'work_gap' });
              const derivations = (draft.agentSessions || []).flatMap((session) => session.toolCalls || []).filter((entry) => entry.tool === 'calculate' && entry.ok);
              const projectCandidate = draft.type === 'project' ? await projectWorkspaceHost.buildArtifactEvidence(draft, store.taskDir(taskId)) : null;
              if (projectCandidate) {
                projectCandidate.projectExecutionAudit = projectExecutionAudit(draft, { synthesisWorkItemId: current.id });
                projectCandidate.projectExecutionAuditSha256 = projectCandidate.projectExecutionAudit.auditSha256;
              }
              const artifact = createArtifact(draft, { title: `${draft.title}｜候选成果`, summary: result.summary, content: result.output, sources: result.sources, claims: result.claims, caveats: result.caveats, deliverables, derivations, projectCandidate }, draft.provider, runInfo.goalVersionId);
              artifactId = artifact.id;
              storedResult = { ...storedResult, artifactId: artifact.id, version: artifact.version };
              session.nativeCandidate = {
                artifactId: artifact.id, contentSha256: artifactContentSha256(artifact), inputFingerprint: current.inputFingerprint,
                sourceContextFingerprint: current.sourceContextFingerprint,
                materialApplicabilityFingerprint: current.materialApplicabilityFingerprint ?? null,
                planRevision: draft.plan.revision, modelCompletedAt: new Date().toISOString(),
              };
              session.output = structuredClone(storedResult);
              session.updatedAt = new Date().toISOString();
            }
            if (artifactId) return { artifactId, storedResult };
            completeWorkItem(draft, item.id, storedResult);
            markSession(draft, item.id, 'completed', { output: storedResult });
            const agent = draft.team.agents.find((candidate) => candidate.id === item.agentId);
            if (agent) agent.status = draft.workItems.some((candidate) => candidate.agentId === item.agentId && candidate.id !== item.id && candidate.status === 'running') ? 'working' : 'available';
            readyWorkItems(draft);
            return { artifactId: null, storedResult };
          });
          if (staged.result.artifactId) {
            if (staged.task.type !== 'project') await generateNativeCandidateFiles(store, taskId, staged.result.artifactId, { signal: controller.signal, runId: runInfo.runId, workItemId: item.id });
            await store.mutate(taskId, (draft) => {
              const session = workSession(draft, item.id);
              assertSessionFresh(draft, session, { runId: runInfo.runId });
              completeWorkItem(draft, item.id, staged.result.storedResult);
              markSession(draft, item.id, 'completed', { output: staged.result.storedResult });
              const agent = draft.team.agents.find((candidate) => candidate.id === item.agentId);
              if (agent) agent.status = draft.workItems.some((candidate) => candidate.agentId === item.agentId && candidate.id !== item.id && candidate.status === 'running') ? 'working' : 'available';
              readyWorkItems(draft);
            });
          }
        } catch (error) {
          const handled = await handleDynamicWorkFailure(store, taskId, item, error, runInfo.runId).catch(() => ({ result: { retryable: false, terminalReason: null } }));
          throw Object.assign(error, { retryable: handled.result.retryable === true, terminalReason: handled.result.terminalReason, workItemId: item.id, stepKey: item.stepKey, planRevision: snapshot.result.planRevision });
        }
      }));
      const failures = batchResults.filter((result) => result.status === 'rejected').map((result) => result.reason);
      if (failures.length) {
        const fatal = failures.find((error) => error.code === 'cancelled' || error.code === 'stale_result') || failures[0];
        if (fatal.code === 'cancelled' || fatal.code === 'stale_result' || controller.signal.aborted) throw fatal;
        const exhausted = failures.filter((error) => error.retryable !== true);
        if (!exhausted.length) continue;
        const terminal = exhausted.find((error) => error.terminalReason);
        if (terminal) {
          await store.mutate(taskId, (draft) => {
            if (['executing', 'reviewing'].includes(draft.execution?.phase)) transitionExecution(draft, 'partial');
            draft.execution.stopReason = terminal.terminalReason;
            setTaskState(draft, 'partial', draft.workItems.find((item) => item.id === terminal.workItemId)?.role || draft.activeRole,
              terminal.terminalReason === 'native_generation_failed' ? `候选内容已保留，但原生文件生成失败：${terminal.message}`
                : terminal.terminalReason === 'project_verification_failed' ? `固定业务检查未通过，已保留候选与诊断并停止：${terminal.message}`
                  : terminal.terminalReason === 'project_transaction_failed' ? `固定项目事务未完成，已停止且不会隐式重试：${terminal.message}`
                    : `工作在有界重试后停止：${terminal.message}`);
          });
          return;
        }
        await requestReplan(store, providers, taskId, {
          message: exhausted.map((error) => error.message).join('；'), code: 'work_batch_failed',
          failures: exhausted.map((error) => ({ message: error.message, code: error.code || 'work_failed', stepKey: error.stepKey, workItemId: error.workItemId })),
        }, controller.signal, runInfo.runId);
      }
      continue;
    }

    if (reviewItem) {
      const artifact = task.artifacts.filter((item) => item.goalVersionId === runInfo.goalVersionId).at(-1);
      if (!artifact) throw new Error('独立审阅前缺少候选成果。');
      if (task.type === 'project') {
        await projectWorkspaceHost.assertArtifactFilesCurrent(task, store.taskDir(taskId), artifact);
        assertProjectExecutionAuditCurrent(task, artifact);
      }
      await store.mutate(taskId, (draft) => { beginWorkItem(draft, reviewItem.id); draft.activeAgentId = reviewItem.agentId; markSession(draft, reviewItem.id, 'running', { runId: runInfo.runId }); if (draft.execution.phase === 'executing') transitionExecution(draft, 'reviewing'); setTaskState(draft, 'running', reviewItem.role, '独立审阅角色正在逐项核对候选成果。'); });
      let checked;
      try {
        const reviewEvidence = await callDynamicWork(store, providers, projectWorkspaceHost, taskId, reviewItem.id, controller.signal, runInfo.runId);
        await store.mutate(taskId, (draft) => {
          const session = workSession(draft, reviewItem.id);
          assertSessionFresh(draft, session, { runId: runInfo.runId });
          session.reviewEvidence = { summary: reviewEvidence.summary, output: reviewEvidence.output, sources: reviewEvidence.sources, acceptanceChecks: reviewEvidence.acceptanceChecks };
          session.updatedAt = new Date().toISOString();
        });
        const result = await callDynamicReview(store, providers, taskId, reviewItem, artifact.id, controller.signal, runInfo.runId);
        checked = await store.mutate(taskId, async (draft) => {
          const currentArtifact = draft.artifacts.find((entry) => entry.id === artifact.id);
          const reviewOptions = await trustedReviewOptions(draft, currentArtifact, store.taskDir(taskId), projectWorkspaceHost);
          const review = recordReview(draft, artifact.id, result, reviewOptions);
          completeWorkItem(draft, reviewItem.id, { reviewId: review.id, passed: review.passed, summary: review.summary });
          markSession(draft, reviewItem.id, 'completed', { output: { reviewId: review.id, passed: review.passed } });
          readyWorkItems(draft);
          return review;
        });
      } catch (error) {
        if (error.code === 'cancelled' || error.code === 'stale_result' || controller.signal.aborted) throw error;
        const handled = await handleDynamicWorkFailure(store, taskId, reviewItem, error, runInfo.runId);
        if (handled.result.retryable === true) continue;
        const failed = await store.mutate(taskId, (draft) => {
          if (draft.execution.phase === 'reviewing') transitionExecution(draft, 'partial');
          if (handled.result.terminalReason) draft.execution.stopReason = handled.result.terminalReason;
          return { planRevisions: draft.execution.planRevisions, maxPlanRevisions: draft.execution.limits.maxPlanRevisions, terminalReason: handled.result.terminalReason };
        });
        if (failed.result.terminalReason || failed.result.planRevisions >= failed.result.maxPlanRevisions) {
          await store.mutate(taskId, (draft) => { draft.execution.stopReason = failed.result.terminalReason || 'review_work_failed'; setTaskState(draft, 'partial', reviewItem.role, `独立审阅工作未达到验收条件：${error.message}`); });
          return;
        }
        await store.mutate(taskId, (draft) => { draft.execution.phase = 'executing'; draft.execution.updatedAt = new Date().toISOString(); });
        await requestReplan(store, providers, taskId, { message: error.message, code: 'review_work_failed', workItemId: reviewItem.id, stepKey: reviewItem.stepKey }, controller.signal, runInfo.runId);
        continue;
      }
      if (!checked.result.passed) {
        if (checked.task.execution.planRevisions >= checked.task.execution.limits.maxPlanRevisions) {
          await store.mutate(taskId, (draft) => { transitionExecution(draft, 'partial'); draft.execution.stopReason = 'review_blocked'; });
          return;
        }
        await store.mutate(taskId, (draft) => { if (draft.execution.phase === 'reviewing') transitionExecution(draft, 'partial'); });
        await store.mutate(taskId, (draft) => { draft.execution.phase = 'executing'; draft.execution.updatedAt = new Date().toISOString(); });
        await requestReplan(store, providers, taskId, {
          message: checked.result.summary, code: 'review_failed', reviewId: checked.result.id,
          artifactId: checked.result.artifactId, goalVersionId: checked.result.goalVersionId,
          failedBlockingChecks: checked.result.checks.filter((item) => item.blocking && !item.passed).map((item) => ({ name: item.name, evidence: item.evidence })),
          nativeFiles: (artifact.nativeFiles || []).map((file) => ({ kind: file.kind, status: file.status, filename: file.filename, sha256: file.sha256 || null, error: file.error || null })),
        }, controller.signal, runInfo.runId);
      }
      continue;
    }

    if (deliveryItem) {
      await store.mutate(taskId, (draft) => {
        const current = draft.workItems.find((item) => item.id === deliveryItem.id);
        current.status = 'waiting_user'; current.updatedAt = new Date().toISOString();
        transitionExecution(draft, 'waiting_user');
        setTaskState(draft, 'waiting_user', current.role, '候选成果已通过独立审阅，等待你确认指定版本。');
      });
      return;
    }

    const unfinished = task.workItems.filter((item) => !['completed', 'waiting_user', 'cancelled', 'stale'].includes(item.status));
    if (!unfinished.length) return;
    throw new Error(`计划无法继续，阻塞步骤：${unfinished.map((item) => item.title).join('、')}。`);
  }
}

function planInputFingerprint(task, projectRootGoalVersionId) {
  const applicability = materialContext(task, { includeGeneratedEvidence: false });
  return JSON.stringify({
    goalVersionId: activeGoal(task).id,
    projectRootGoalVersionId,
    projectRootInputFingerprint: task.projectRootInputFingerprint || null,
    materialApplicabilityFingerprint: applicability.fingerprint,
    materials: applicability.effectiveMaterials.map((item) => [item.id, item.status, item.createdAt, item.bytes, materialContentSha256(item)]),
    suggestions: task.suggestions.map((item) => [item.id, item.classification, item.status, item.correctedAt]),
    provider: task.provider,
    ...(task.type === 'project' ? {
      workspaceScopeFingerprint: projectWorkspaceFingerprint(task),
      sourceSnapshotSha256: task.projectWorkspace?.sourceSnapshotSha256 || null,
    } : {}),
  });
}

function modelPlanInputsChanged(task) {
  if (task.plan?.source !== 'model') return false;
  const goal = activeGoal(task);
  const applicability = materialContext(task, { includeGeneratedEvidence: false });
  const materialIds = applicability.effectiveMaterials.map((item) => item.id).sort();
  const suggestionIds = task.suggestions.filter((item) => (item.goalVersionId || goal.id) === goal.id && item.classification === 'support' && item.status === 'routed').map((item) => item.id).sort();
  return task.workItems.some((item) => (item.materialApplicabilityFingerprint ?? null) !== applicability.fingerprint
    || JSON.stringify([...(item.inputMaterialIds || [])].sort()) !== JSON.stringify(materialIds)
    || JSON.stringify([...(item.inputSuggestionIds || [])].sort()) !== JSON.stringify(suggestionIds)
    || (task.type === 'project' && (item.workspaceScopeFingerprint ?? null) !== projectWorkspaceFingerprint(task))
    || (task.type === 'project' && (item.sourceSnapshotSha256 ?? null) !== (task.projectWorkspace?.sourceSnapshotSha256 || null)));
}

async function planTask(store, providers, taskId) {
  const snapshot = await store.get(taskId);
  if (snapshot.type === 'project' && !projectWorkspaceIsCurrent(snapshot)) {
    return store.mutate(taskId, (task) => {
      setTaskState(task, 'waiting_user', 'coordinator', task.projectWorkspace?.reason || '请先明确授权固定代码工作区；授权前不会调用模型。');
      return [];
    });
  }
  if (snapshot.provider !== 'codex-cli' || typeof providers.plan !== 'function') {
    return store.mutate(taskId, async (task) => {
      await assertProjectGoalFresh(store, task);
      if (task.projectRootTaskId) {
        event(task, 'project.alignment_required', '演示提供者不能判断任务目标与项目根目标是否一致，已停下等待使用真实规划器对齐。', {
          rootTaskId: task.projectRootTaskId,
          rootGoalVersionId: task.projectRootGoalVersionId,
          taskGoalVersionId: activeGoal(task).id,
        });
        setTaskState(task, 'waiting_user', 'coordinator', '关联任务需要真实规划器核对项目根目标后才能继续。');
        return [];
      }
      return buildPlan(task);
    });
  }
  if (activeJobs.has(taskId)) throw Object.assign(new Error('这项任务正在运行。'), { status: 409 });
  const controller = new AbortController();
  const entry = { controller, promise: null, kind: 'planning', role: 'coordinator' };
  activeJobs.set(taskId, entry);
  const hydratedSnapshot = await hydrateProjectContext(store, snapshot);
  const goalVersionId = activeGoal(snapshot).id;
  const projectRootGoalVersionId = hydratedSnapshot.projectRootGoalVersionId;
  const projectRootInputFingerprint = hydratedSnapshot.projectRootInputFingerprint;
  const inputFingerprint = planInputFingerprint(snapshot, projectRootGoalVersionId);
  try {
    const plan = await providers.plan(hydratedSnapshot, { signal: controller.signal });
    validateModelPlan(hydratedSnapshot, plan);
    return await store.mutate(taskId, async (task) => {
      await assertProjectGoalFresh(store, task, projectRootGoalVersionId, projectRootInputFingerprint);
      if (activeJobs.get(taskId) !== entry || planInputFingerprint(task, task.projectRootGoalVersionId || activeGoal(task).id) !== inputFingerprint) {
        throw Object.assign(new Error('规划结果属于已变化的目标或输入，未写入当前任务。'), { code: 'stale_result' });
      }
      return applyModelPlan(task, plan);
    });
  } catch (error) {
    if (error.code !== 'cancelled' && !controller.signal.aborted) await store.mutate(taskId, (task) => {
      event(task, 'planning.failed', `形成计划失败：${error.message}`, { code: error.code || 'planning_failed', goalVersionId, projectRootGoalVersionId, projectRootInputFingerprint });
    }).catch(() => {});
    throw error;
  } finally {
    if (activeJobs.get(taskId) === entry) activeJobs.delete(taskId);
    setImmediate(() => drainConversationQueue(store, providers, taskId).catch(() => {}));
  }
}

async function runTask(store, providers, projectWorkspaceHost, taskId) {
  if (activeJobs.has(taskId)) throw new Error('这项任务正在运行。');
  const controller = new AbortController();
  const entry = { controller, promise: null };
  activeJobs.set(taskId, entry);
  let runInfo;
  try {
    const prepared = await store.mutate(taskId, async (task) => {
      await assertProjectGoalFresh(store, task);
      if (task.type === 'project' && !projectWorkspaceIsCurrent(task)) throw new Error(task.projectWorkspace?.reason || '请先明确授权固定代码工作区。');
      const goal = activeGoal(task);
      const currentProjectGoal = task.projectRootGoalVersionId || goal.id;
      const planProjectGoal = task.plan?.projectRootGoalVersionId || (!task.projectRootTaskId ? currentProjectGoal : null);
      const currentProjectInput = task.projectRootInputFingerprint || projectInputFingerprint(task);
      const planProjectInput = task.plan?.projectRootInputFingerprint || (!task.projectRootTaskId ? currentProjectInput : null);
      const dynamic = task.plan?.source === 'model' && task.plan.goalVersionId === goal.id && planProjectGoal === currentProjectGoal
        && planProjectInput === currentProjectInput
        && (task.type !== 'project' || task.plan.workspaceScopeFingerprint === projectWorkspaceFingerprint(task))
        && (task.type !== 'project' || task.plan.sourceSnapshotSha256 === task.projectWorkspace?.sourceSnapshotSha256)
        && task.workItems.some((item) => item.stepKey);
      if (task.projectRootTaskId && !dynamic) throw new Error('关联任务必须先由真实规划器核对项目根目标与任务目标，再开始执行。');
      if (task.plan?.source === 'model' && !dynamic) throw new Error('当前计划不再匹配任务目标或项目根目标，请先重新规划。');
      const resumeNative = dynamic ? recoverableNativeCandidate(task) : null;
      const mustRebuild = !task.workItems.length
        || ['cancelled', 'cancellation_unknown', 'failed', 'partial'].includes(task.status)
        || task.workItems.some((item) => item.goalVersionId !== goal.id)
        || task.workItems.some((item) => ['completed', 'failed', 'cancelled', 'blocked', 'stale'].includes(item.status));
      if (mustRebuild && !dynamic) buildPlan(task);
      const execution = startExecution(task, goal.id);
      if (dynamic) {
        const applicability = materialContext(task, { includeGeneratedEvidence: false });
        const currentMaterialIds = applicability.effectiveMaterials.map((item) => item.id).sort();
        const currentSuggestionIds = task.suggestions.filter((item) => (item.goalVersionId || goal.id) === goal.id && item.classification === 'support' && item.status === 'routed').map((item) => item.id).sort();
        const planInputsChanged = task.workItems.some((item) => (item.materialApplicabilityFingerprint ?? null) !== applicability.fingerprint
          || JSON.stringify([...(item.inputMaterialIds || [])].sort()) !== JSON.stringify(currentMaterialIds)
          || JSON.stringify([...(item.inputSuggestionIds || [])].sort()) !== JSON.stringify(currentSuggestionIds));
        if (planInputsChanged) throw new Error('材料或工作交代已变化，请先让规划器按当前输入重新形成计划。');
        for (const item of task.workItems) {
          if (item.status === 'completed') continue;
          if (item.status === 'waiting_user' && item.kind === 'delivery') continue;
          item.status = 'pending'; item.error = null; item.startedAt = null; item.updatedAt = new Date().toISOString();
          task.agentSessions.push({
            id: `session-${crypto.randomUUID()}`, agentId: item.agentId, roleKey: item.role, workItemId: item.id,
            goalVersionId: goal.id, planRevision: task.plan.revision, status: 'planned', input: null, output: null,
            projectRootGoalVersionId: task.projectRootGoalVersionId || goal.id,
            projectRootInputFingerprint: task.projectRootInputFingerprint || null,
            materialApplicabilityFingerprint: applicability.fingerprint,
            workspaceScopeFingerprint: item.workspaceScopeFingerprint ?? null,
            sourceSnapshotSha256: item.sourceSnapshotSha256 ?? null,
            inputFingerprint: item.inputFingerprint,
            sourceContextFingerprint: item.sourceContextFingerprint,
            runId: execution.id, attemptId: null, toolCalls: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
            resumedFromRunId: task.executionHistory.at(-1)?.id || null,
          });
        }
        task.agentSessions = task.agentSessions.slice(-80);
        readyWorkItems(task);
        if (resumeNative) {
          const item = task.workItems.find((entry) => entry.id === resumeNative.workItemId);
          beginWorkItem(task, item.id);
          markSession(task, item.id, 'running', {
            runId: execution.id, attemptId: `${execution.id}:${item.id}:native-retry`,
            input: { artifactId: resumeNative.artifactId, contentSha256: resumeNative.contentSha256, inputFingerprint: item.inputFingerprint, sourceContextFingerprint: item.sourceContextFingerprint },
            nativeCandidate: { ...resumeNative, resumedFromRunId: task.executionHistory.at(-1)?.id || null },
          });
          const agent = task.team.agents.find((entry) => entry.id === item.agentId);
          if (agent) agent.status = 'working';
          event(task, 'artifact.native_retry_started', '候选内容与输入未变化，复用已完成的模型合成，仅重试原生文件后进入独立审阅。', { artifactId: resumeNative.artifactId, workItemId: item.id, contentSha256: resumeNative.contentSha256 });
        }
        setTaskState(task, 'running', 'coordinator', `动态团队开始执行计划 v${task.plan.revision}；无依赖工作可并行推进。`);
        return { runId: execution.id, goalVersionId: goal.id, projectRootGoalVersionId: currentProjectGoal, firstRole: null, dynamic: true, resumeNative };
      }
      const firstRole = task.workItems.some((item) => item.role === 'researcher') ? 'researcher' : 'writer';
      beginWork(task, firstRole);
      setTaskState(task, 'running', firstRole, firstRole === 'researcher'
        ? '研究角色正在整理材料，并为每条观察保存原文位置。'
        : task.provider === 'demo' ? '演示写作角色正在生成候选稿。' : 'Codex 写作角色正在生成候选稿。');
      return { runId: execution.id, goalVersionId: goal.id, projectRootGoalVersionId: currentProjectGoal, firstRole, dynamic: false };
    });
    runInfo = prepared.result;
  } catch (error) {
    activeJobs.delete(taskId);
    throw error;
  }

  const job = (async () => {
    try {
      if (runInfo.dynamic) {
        await runDynamicTask(store, providers, projectWorkspaceHost, taskId, controller, runInfo);
        return;
      }
      if (runInfo.firstRole === 'researcher') {
        const researchResult = await callProviderStep(store, providers, taskId, 'researcher', 'research', controller.signal);
        await store.mutate(taskId, (task) => {
          if (activeGoal(task).id !== runInfo.goalVersionId || task.execution?.id !== runInfo.runId) throw Object.assign(new Error('研究结果属于旧目标或旧运行。'), { code: 'stale_result' });
          validateResearchResult(task, researchResult);
          completeWork(task, 'researcher', researchResult);
          beginWork(task, 'writer');
          setTaskState(task, 'running', 'writer', task.provider === 'demo' ? '演示写作角色正在使用研究结果生成候选稿。' : 'Codex 写作角色正在使用研究结果生成候选稿。');
        });
      }

      const generated = await callProviderStep(store, providers, taskId, 'writer', 'generate', controller.signal);
      const created = await store.mutate(taskId, (task) => {
        if (activeGoal(task).id !== runInfo.goalVersionId || task.execution?.id !== runInfo.runId) throw Object.assign(new Error('候选结果属于旧目标或旧运行。'), { code: 'stale_result' });
        const artifact = createArtifact(task, generated, task.provider, runInfo.goalVersionId);
        if (['document', 'spreadsheet', 'presentation'].includes(task.type) && !artifact.deliverables.length) {
          artifact.deliverables = [{ kind: task.type, title: artifact.title, content: artifact.content }];
        }
        return artifact;
      });
      await generateNativeCandidateFiles(store, taskId, created.result.id, { signal: controller.signal, runId: runInfo.runId });
      await store.mutate(taskId, (task) => {
        const artifact = task.artifacts.find((item) => item.id === created.result.id);
        if (!artifact || activeGoal(task).id !== runInfo.goalVersionId || task.execution?.id !== runInfo.runId) throw Object.assign(new Error('候选原生文件属于旧目标或旧运行。'), { code: 'stale_result' });
        completeWork(task, 'writer', { artifactId: artifact.id, version: artifact.version, title: artifact.title, claimCount: artifact.claims.length, nativeFileCount: artifact.nativeFiles.length });
        beginWork(task, 'reviewer');
        transitionExecution(task, 'reviewing');
        setTaskState(task, 'running', 'reviewer', '原生候选文件已生成并渲染检查；独立审阅角色正在逐项核对。');
      });

      const reviewResult = await callProviderStep(store, providers, taskId, 'reviewer', 'review', controller.signal, created.result.id);
      await store.mutate(taskId, async (task) => {
        if (activeGoal(task).id !== runInfo.goalVersionId || task.execution?.id !== runInfo.runId) throw Object.assign(new Error('审阅结果属于旧目标或旧运行。'), { code: 'stale_result' });
        const artifact = task.artifacts.find((entry) => entry.id === created.result.id);
        const reviewOptions = await trustedReviewOptions(task, artifact, store.taskDir(taskId), projectWorkspaceHost);
        const review = recordReview(task, created.result.id, reviewResult, reviewOptions);
        completeWork(task, 'reviewer', { reviewId: review.id, passed: review.passed, summary: review.summary, sourceEvidenceCount: review.sourceEvidence.length });
        const steward = task.workItems.find((item) => item.role === 'steward');
        if (steward) steward.status = review.passed ? 'waiting_user' : 'blocked';
        transitionExecution(task, review.passed ? 'waiting_user' : 'partial');
        task.execution.stopReason = review.passed ? null : 'review_blocked';
      });
    } catch (error) {
      await store.mutate(taskId, (task) => {
        const goalChanged = activeGoal(task).id !== runInfo.goalVersionId || task.execution?.id !== runInfo.runId;
        if (goalChanged || error.code === 'stale_result') {
          event(task, 'execution.stale', '旧目标或旧运行返回的结果已保留为事件，但没有进入当前候选。', { runId: runInfo.runId, goalVersionId: runInfo.goalVersionId });
          return;
        }
        const running = task.workItems.find((item) => item.status === 'running');
        if (error.code === 'cancelled' || controller.signal.aborted) {
          if (running) failWork(task, running.role, error, 'cancelled');
          if (task.execution && !['cancelled', 'completed'].includes(task.execution.phase)) transitionExecution(task, 'cancelled');
          task.execution.stopReason = 'local_process_terminated';
          setTaskState(task, 'cancelled', task.activeRole, '取消已确认：本地执行进程已终止；已产生的结果仍保留。');
          return;
        }
        const budget = error.code === 'budget_exhausted';
        if (error.code === 'material_decision_required') {
          if (running) failWork(task, running.role, error, 'blocked');
          if (task.execution && ['executing', 'reviewing'].includes(task.execution.phase)) transitionExecution(task, 'partial');
          if (task.execution) task.execution.stopReason = 'material_decision_required';
          setTaskState(task, 'waiting_user', 'coordinator', error.message);
          return;
        }
        if (running) failWork(task, running.role, error, budget ? 'blocked' : 'failed');
        if (task.execution && ['executing', 'reviewing'].includes(task.execution.phase)) transitionExecution(task, budget ? 'partial' : 'failed');
        task.execution.stopReason = budget ? 'budget_exhausted' : 'provider_failed';
        setTaskState(task, budget ? 'partial' : 'failed', task.activeRole, `${budget ? '预算已用尽' : '运行失败'}：${error.message}`);
      }).catch(() => {});
    } finally {
      if (activeJobs.get(taskId) === entry) activeJobs.delete(taskId);
      setImmediate(() => drainConversationQueue(store, providers, taskId).catch(() => {}));
    }
  })();
  entry.promise = job;
}

async function answerOneQueuedConversation(store, providers, taskId, signal) {
  const snapshot = await store.get(taskId);
  const pending = (snapshot.conversationQueue || []).find((item) => item.status === 'pending');
  if (!pending) return false;
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abortFromParent, { once: true });
  const activeReply = { controller, kind: 'conversation', role: pending.role, agentId: pending.agentId || null, queueId: pending.id };
  activeQueuedReplies.set(taskId, activeReply);
  try {
    const started = await store.mutate(taskId, async (task) => {
      task.conversationQueue ??= [];
      const queued = task.conversationQueue.find((item) => item.id === pending.id && item.status === 'pending');
      if (!queued) throw Object.assign(new Error('排队对话已被处理。'), { code: 'stale_result' });
      const currentAgent = queued.agentId ? task.team?.agents?.find((agent) => agent.id === queued.agentId && agent.roleKey === queued.role && agent.goalVersionId === activeGoal(task).id) : null;
      const queuedProjectGoal = queued.projectRootGoalVersionId || (!task.projectRootTaskId ? activeGoal(task).id : null);
      const currentProjectGoal = task.projectRootGoalVersionId || (!task.projectRootTaskId ? activeGoal(task).id : null);
      const queuedInstructions = queued.instructionIds || [];
      const materialApplicabilityFingerprint = materialContext(task, { includeGeneratedEvidence: false }).fingerprint;
      if (activeGoal(task).id !== queued.goalVersionId || currentProjectGoal !== queuedProjectGoal
        || (queued.projectRootInputFingerprint && task.projectRootInputFingerprint !== queued.projectRootInputFingerprint)
        || JSON.stringify(currentInstructionIds(task).slice().sort()) !== JSON.stringify(queuedInstructions.slice().sort())
        || (queued.materialApplicabilityFingerprint ?? null) !== materialApplicabilityFingerprint
        || task.provider !== queued.provider || (queued.agentId && !currentAgent)) {
        queued.status = 'stale'; queued.completedAt = new Date().toISOString(); queued.error = '排队消息所属的目标、提供者或团队已变化。';
        event(task, 'conversation.stale', '排队消息所属的目标、提供者或团队已变化，未启动旧回复。', { role: queued.role, agentId: queued.agentId, goalVersionId: queued.goalVersionId, queueId: queued.id });
        return null;
      }
      queued.status = 'running'; queued.startedAt = new Date().toISOString();
      event(task, 'conversation.call_started', `${queued.role} 已开始回复排队消息。`, { role: queued.role, agentId: queued.agentId, workItemId: queued.workItemId, goalVersionId: queued.goalVersionId, provider: queued.provider, queueId: queued.id, requestEventId: queued.requestEventId });
      return structuredClone(queued);
    });
    const queued = started.result;
    if (!queued) return true;
    const reply = await providers.converse(await hydrateProjectContext(store, started.task), queued.role, queued.message, { signal: controller.signal });
    if (controller.signal.aborted) throw Object.assign(new Error('这次模型回复已取消。'), { code: 'cancelled' });
    const content = String(reply.reply || '').slice(0, 4_000);
    await store.mutate(taskId, async (task) => {
      await assertProjectGoalFresh(store, task, queued.projectRootGoalVersionId || (!task.projectRootTaskId ? activeGoal(task).id : null), queued.projectRootInputFingerprint || null);
      const current = task.conversationQueue?.find((item) => item.id === queued.id);
      if (!current || current.status !== 'running' || activeGoal(task).id !== queued.goalVersionId
        || JSON.stringify(currentInstructionIds(task).slice().sort()) !== JSON.stringify((queued.instructionIds || []).slice().sort())
        || (queued.materialApplicabilityFingerprint ?? null) !== materialContext(task, { includeGeneratedEvidence: false }).fingerprint
        || task.provider !== queued.provider) throw Object.assign(new Error('排队对话属于旧目标、旧工作交代、旧提供者或已取消回复。'), { code: 'stale_result' });
      current.status = 'completed'; current.completedAt = new Date().toISOString(); current.reply = content;
      event(task, 'conversation.reply', content, { role: queued.role, agentId: queued.agentId, workItemId: queued.workItemId, kind: reply.kind || 'answer', sourceRefs: Array.isArray(reply.sourceRefs) ? reply.sourceRefs.slice(0, 12) : [], provider: queued.provider, goalVersionId: queued.goalVersionId, projectRootGoalVersionId: queued.projectRootGoalVersionId || null, projectRootInputFingerprint: queued.projectRootInputFingerprint || null, materialApplicabilityFingerprint: queued.materialApplicabilityFingerprint ?? null, instructionIds: queued.instructionIds || [], queueId: queued.id, requestEventId: queued.requestEventId, content });
    });
  } catch (error) {
    await store.mutate(taskId, (task) => {
      const queued = task.conversationQueue?.find((item) => item.id === pending.id);
      if (queued && queued.status !== 'completed') {
        queued.status = error.code === 'cancelled' || controller.signal.aborted ? 'cancelled' : 'failed';
        queued.completedAt = new Date().toISOString(); queued.error = error.message;
      }
      event(task, error.code === 'cancelled' || controller.signal.aborted ? 'conversation.cancelled' : error.code === 'stale_result' ? 'conversation.stale' : 'conversation.failed', error.code === 'cancelled' || controller.signal.aborted ? '这次排队回复已取消。' : error.code === 'stale_result' ? '排队回复所属的目标或提供者已变化，未写入旧回复。' : `同事回复失败：${error.message}`, { role: pending.role, agentId: pending.agentId, goalVersionId: pending.goalVersionId, queueId: pending.id });
    }).catch(() => {});
  } finally {
    signal?.removeEventListener('abort', abortFromParent);
    if (activeQueuedReplies.get(taskId) === activeReply) activeQueuedReplies.delete(taskId);
  }
  return true;
}

async function drainConversationQueue(store, providers, taskId) {
  if (activeJobs.has(taskId)) return false;
  const snapshot = await store.get(taskId);
  const pending = (snapshot.conversationQueue || []).find((item) => item.status === 'pending');
  if (!pending) return false;
  const controller = new AbortController();
  const entry = { controller, promise: null, kind: 'conversation', role: pending.role, agentId: pending.agentId || null, queueId: pending.id };
  activeJobs.set(taskId, entry);
  try {
    await answerOneQueuedConversation(store, providers, taskId, controller.signal);
  } finally {
    if (activeJobs.get(taskId) === entry) activeJobs.delete(taskId);
    setImmediate(() => drainConversationQueue(store, providers, taskId).catch(() => {}));
  }
  return true;
}

async function serveFile(res, root, relative) {
  const clean = relative.replace(/^\/+/, '');
  const file = path.resolve(root, clean || 'index.html');
  if (file !== root && !file.startsWith(`${root}${path.sep}`)) return problem(res, 404, '找不到页面。', 'not_found');
  try {
    const content = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': content.length, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch { problem(res, 404, '找不到页面。', 'not_found'); }
}

function projectOfficeTask(task) {
  if (!task) return null;
  const goal = activeGoal(task);
  const artifact = task.artifacts?.filter((item) => item.goalVersionId === goal?.id).at(-1) || null;
  const review = artifact
    ? task.reviews?.filter((item) => item.artifactId === artifact.id).at(-1) || null
    : null;
  let state = 'idle';
  const activeStationRole = task.team?.agents?.find((agent) => agent.id === task.activeAgentId)?.stationRole || task.activeRole;
  if (task.status === 'running') {
    state = { archivist: 'reading', researcher: 'researching', writer: 'drafting', reviewer: 'reviewing', steward: 'active' }[activeStationRole] || 'idle';
  } else if (task.status === 'waiting_user') state = 'waiting_user';
  else if (task.status === 'ready_to_export' || task.status === 'completed') state = 'completed';
  else if (['partial', 'failed', 'cancelled', 'cancellation_unknown'].includes(task.status)) state = 'failed';
  return {
    taskId: task.id,
    role: task.activeRole || 'coordinator',
    goalVersion: goal?.id || null,
    state,
    activity: task.events?.at(-1)?.message || '任务已载入。',
    updatedAt: task.updatedAt,
    demo: task.provider === 'demo',
    team: {
      agents: task.team?.agents || [],
      workItems: task.workItems?.map((item) => ({ id: item.id, role: item.role, agentId: item.agentId || null, kind: item.kind || null, title: item.title, status: item.status, updatedAt: item.updatedAt || null })) || [],
      delegations: task.execution?.delegations || [],
      resultBatch: task.execution?.resultBatch || [],
    },
    result: artifact ? {
      artifactId: artifact.id,
      logicalId: artifact.logicalId,
      version: artifact.version,
      title: artifact.title,
      summary: artifact.summary,
      goalStatement: goal?.statement || null,
      effectiveMaterialIds: materialContext(task).effectiveMaterials.map((item) => item.id),
      materialIds: materialContext(task).effectiveMaterials.map((item) => item.id),
      allMaterialIds: task.materials?.map((item) => item.id) || [],
      process: {
        taskStatus: task.status,
        executionPhase: task.execution?.phase || null,
        activeRole: task.activeRole || 'coordinator',
      },
      status: artifact.status,
      reviewStatus: artifact.reviewStatus,
      reviewId: review?.id || null,
      reviewPassed: review?.passed ?? null,
      goalVersionId: artifact.goalVersionId,
      workResultIds: artifact.workResultIds,
      instructionIds: artifact.instructionIds || [],
      createdAt: artifact.createdAt,
    } : null,
  };
}

function defaultOfficeLayout() {
  return { version: 1, furniture: { desk: { x: 0.5, y: 0.72 } }, bounds: { desk: { ...OFFICE_BOUNDS } }, updatedAt: null };
}

function validateOfficeLayout(input) {
  if (input?.furnitureId !== 'desk') throw new Error('这个试验只允许移动既有书桌。');
  const x = Number(input.x);
  const y = Number(input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)
    || x < OFFICE_BOUNDS.minX || x > OFFICE_BOUNDS.maxX
    || y < OFFICE_BOUNDS.minY || y > OFFICE_BOUNDS.maxY) {
    throw new Error(`书桌位置必须在 x ${OFFICE_BOUNDS.minX}–${OFFICE_BOUNDS.maxX}、y ${OFFICE_BOUNDS.minY}–${OFFICE_BOUNDS.maxY} 之间。`);
  }
  return { version: 1, furniture: { desk: { x, y } }, bounds: { desk: { ...OFFICE_BOUNDS } }, updatedAt: new Date().toISOString() };
}

async function readOfficeLayout(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    const layout = validateOfficeLayout({ furnitureId: 'desk', ...parsed?.furniture?.desk });
    layout.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null;
    return layout;
  } catch (error) {
    if (error.code === 'ENOENT') return defaultOfficeLayout();
    const failure = new Error(`办公室布局记录无法读取：${error.message}`);
    failure.status = 500;
    throw failure;
  }
}

async function writeOfficeLayout(file, layout) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(layout, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  return layout;
}

export async function createIrixiServer({ root = dataRoot, providers: providedProviders = null, publicPageReader = readPublicPage, projectWorkspaceHost: providedProjectWorkspaceHost = null } = {}) {
  const store = createStore(root);
  await store.init();
  await reconcileProjectInputs(store);
  const providers = providedProviders || createProviders({ projectRoot, store });
  const projectWorkspaceHost = providedProjectWorkspaceHost || createProjectWorkspaceHost({ projectRoot });
  const layoutFile = path.join(store.root, '.office-layout.json');
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, version: '1.0.0' });
      if (req.method === 'GET' && pathname === '/api/project-capabilities') return json(res, 200, { project: await projectWorkspaceHost.capabilities() });
      if (req.method === 'GET' && pathname === '/api/tasks') {
        const tasks = await store.list();
        return json(res, 200, { tasks: await Promise.all(tasks.map(async (task) => publicTaskWithRuntime(await hydrateProjectContext(store, task)))) });
      }
      if (req.method === 'GET' && pathname === '/api/office-scene') {
        const taskId = url.searchParams.get('taskId');
        const task = taskId ? await store.get(taskId) : null;
        return json(res, 200, { connected: true, generatedAt: new Date().toISOString(), task: projectOfficeTask(task) });
      }
      if (req.method === 'GET' && pathname === '/api/office-layout') return json(res, 200, { layout: await readOfficeLayout(layoutFile) });
      if (req.method === 'GET' && pathname === '/api/connections') {
        const model = await providers.status();
        return json(res, 200, { connections: [
          model.demo, model.codex,
          { id: 'web', label: '网页读取', available: true, verified: true, boundary: '只读取你明确添加的公开 HTTP/HTTPS 地址；拒绝本机和内网地址。' },
          { id: 'files', label: '本地文件', available: true, verified: true, boundary: '只读取你主动选择的 TXT、MD、DOCX、PDF，不覆盖来源文件。' },
          { id: 'email', label: '邮件', available: false, verified: false, boundary: '当前只生成 EML 草稿，不连接邮箱、不发送。' },
          { id: 'calendar', label: '日历', available: false, verified: false, boundary: '当前只生成待确认 ICS 草稿，不创建线上日程。' },
        ] });
      }
      const taskMatch = pathname.match(/^\/api\/tasks\/([a-z0-9-]+)$/);
      if (req.method === 'GET' && taskMatch) return json(res, 200, { task: publicTaskWithRuntime(await hydrateProjectContext(store, await store.get(taskMatch[1]))) });
      const workspaceMatch = pathname.match(/^\/api\/tasks\/([a-z0-9-]+)\/project-workspace$/);
      if (req.method === 'GET' && workspaceMatch) {
        const task = await store.get(workspaceMatch[1]);
        return json(res, 200, { projectWorkspace: projectWorkspaceHost.publicState(task) });
      }
      const previewMatch = pathname.match(/^\/api\/tasks\/([a-z0-9-]+)\/artifacts\/([a-z0-9-]+)\/previews\/(\d+)$/);
      if (req.method === 'GET' && previewMatch) {
        const task = await store.get(previewMatch[1]);
        const artifact = task.artifacts.find((entry) => entry.id === previewMatch[2]);
        if (!artifact) return problem(res, 404, '找不到候选成果。', 'not_found');
        const previews = (artifact.nativeFiles || []).filter((entry) => entry.status === 'ready').flatMap((entry) => entry.previewPaths || []);
        const relative = previews[Number(previewMatch[3])];
        if (!relative) return problem(res, 404, '找不到候选预览页。', 'not_found');
        const taskDir = store.taskDir(task.id);
        const file = path.resolve(taskDir, relative);
        if (!file.startsWith(`${taskDir}${path.sep}`)) throw new Error('候选预览路径越界。');
        const bytes = await fs.readFile(file);
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(bytes);
      }
      const exportMatch = pathname.match(/^\/api\/tasks\/([a-z0-9-]+)\/artifacts\/([a-z0-9-]+)\/export$/);
      if (req.method === 'GET' && exportMatch) {
        if (activeJobs.has(exportMatch[1])) throw new Error('任务仍有工作在进行，不能使用旧核对结果导出。');
        const format = url.searchParams.get('format') || 'md';
        const prepared = await store.locked(async () => {
          const task = await store.get(exportMatch[1]);
          if (activeJobs.has(exportMatch[1])) throw new Error('任务仍有工作在进行，不能使用旧核对结果导出。');
          await assertProjectGoalFresh(store, task);
          const artifact = assertExportAllowed(task, exportMatch[2], url.searchParams.get('approval'));
          if (task.type === 'project' && format !== 'patch') throw new Error('代码项目只交付已确认的 patch，不提供正文或办公文件导出。');
          if (format === 'patch') {
            if (task.type !== 'project') throw new Error('只有代码项目候选支持 patch 下载。');
            const bytes = await projectWorkspaceHost.assertArtifactFilesCurrent(task, store.taskDir(task.id), artifact);
            assertProjectExecutionAuditCurrent(task, artifact);
            return { task, artifact, patch: true, bytes };
          }
          if (!['docx', 'xlsx', 'pptx'].includes(format)) return { task, artifact };
          const native = artifact.nativeFiles?.find((entry) => entry.format === format && entry.status === 'ready');
          if (!native) throw new Error('这个指定版本没有已验证的该格式原生文件。');
          const taskDir = store.taskDir(task.id);
          const file = path.resolve(taskDir, native.relativePath);
          if (!file.startsWith(`${taskDir}${path.sep}`)) throw new Error('原生文件路径越界。');
          const bytes = await fs.readFile(file);
          if (crypto.createHash('sha256').update(bytes).digest('hex') !== native.sha256) throw new Error('原生文件与候选审阅时的版本不一致。');
          return { task, artifact, native, bytes };
        });
        if (prepared.bytes) {
          const filename = prepared.patch ? `${safeFilename(prepared.artifact.title)}-v${prepared.artifact.version}.patch` : prepared.native.filename;
          const type = prepared.patch ? 'text/x-diff; charset=utf-8' : MIME[`.${format}`];
          res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Content-Length': prepared.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          return res.end(prepared.bytes);
        }
        const result = exportBody(prepared.task, prepared.artifact, format);
        const name = `${safeFilename(prepared.artifact.title)}-v${prepared.artifact.version}.${result.extension}`;
        res.writeHead(200, { 'Content-Type': result.type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Content-Length': Buffer.byteLength(result.content), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(result.content);
      }
      if (req.method === 'GET' && pathname.startsWith('/assets/')) return serveFile(res, artRoot, pathname.slice('/assets/'.length));
      if (req.method === 'GET' && pathname === '/vendor/phaser.min.js') return serveFile(res, vendorRoot, 'phaser/dist/phaser.min.js');
      if (req.method === 'GET' && pathname === '/vendor/easystar.min.js') return serveFile(res, vendorRoot, 'easystarjs/bin/easystar-0.4.4.min.js');
      if (req.method === 'GET' && (pathname === '/scene' || pathname.startsWith('/scene/'))) return serveFile(res, sceneRoot, pathname.replace(/^\/scene\/?/, ''));
      if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveFile(res, publicRoot, pathname === '/' ? 'index.html' : pathname);

      ensureLocalMutation(req);
      if (req.method === 'PUT' && pathname === '/api/office-layout') {
        const layout = validateOfficeLayout(await readJson(req));
        return json(res, 200, { layout: await writeOfficeLayout(layoutFile, layout) });
      }
      if (req.method === 'DELETE' && pathname === '/api/office-layout') {
        const layout = defaultOfficeLayout();
        return json(res, 200, { layout: await writeOfficeLayout(layoutFile, layout) });
      }
      if (req.method === 'POST' && pathname === '/api/tasks') {
        const body = await readJson(req);
        const task = createTask(body);
        await store.save(task);
        for (const item of task.events) await store.appendAudit(task, item);
        return json(res, 201, { task: publicTask(task) });
      }
      if (req.method === 'POST' && pathname === '/api/connections/codex/verify') return json(res, 200, await providers.verifyCodex());
      const actionMatch = pathname.match(/^\/api\/tasks\/([a-z0-9-]+)\/(.+)$/);
      if (req.method === 'POST' && actionMatch) {
        const [, taskId, action] = actionMatch;
        const body = await readJson(req);
        if (action === 'project-workspace/attach') {
          if (activeJobs.has(taskId)) return problem(res, 409, '任务运行期间不能更换代码工作区。', 'already_running');
          const changed = await store.mutate(taskId, async (task) => {
            if (task.plan || task.workItems?.length || task.execution) invalidateCurrentWork(task, 'project_workspace_changed', '代码工作区授权已变化；旧计划、结果与候选保留为历史。');
            const attached = await projectWorkspaceHost.attachDraft(task, store.taskDir(taskId), body);
            event(task, 'project_workspace.attached', '已明确授权固定代码工作区；原项目保持只读，候选只保存在任务目录。', {
              fixtureId: attached.fixtureId, scopeFingerprint: attached.scopeFingerprint,
              sourceSnapshotSha256: attached.sourceSnapshotSha256, sandboxAvailable: attached.sandboxCapability?.available === true,
            });
            setTaskState(task, attached.status === 'ready' ? 'idle' : 'waiting_user', 'coordinator', attached.status === 'ready'
              ? '固定代码工作区已复制并通过隔离探针，可以形成计划。'
              : attached.reason || '固定检查隔离未通过，已停止。');
            return attached;
          });
          return json(res, 201, { task: publicTask(changed.task), projectWorkspace: changed.result });
        }
        if (action === 'conversation/cancel') {
          const queuedReply = activeQueuedReplies.get(taskId);
          if (queuedReply) {
            const changed = await store.mutate(taskId, (task) => event(task, 'conversation.cancel_requested', '已请求取消这次排队模型回复；当前工作与已有成果继续保留。', { role: queuedReply.role, agentId: queuedReply.agentId, queueId: queuedReply.queueId }));
            queuedReply.controller.abort();
            return json(res, 202, { task: publicTaskWithRuntime(changed.task), cancelled: true });
          }
          const active = activeJobs.get(taskId);
          if (!active || active.kind !== 'conversation') {
            const changed = await store.mutate(taskId, (task) => {
              task.conversationQueue ??= [];
              const queued = task.conversationQueue.findLast((item) => item.status === 'pending');
              if (!queued) return false;
              queued.status = 'cancelled'; queued.completedAt = new Date().toISOString();
              event(task, 'conversation.cancelled', '这次排队回复已取消；任务与已有成果不受影响。', { role: queued.role, agentId: queued.agentId, goalVersionId: queued.goalVersionId, queueId: queued.id });
              return true;
            });
            return json(res, 200, { task: publicTaskWithRuntime(changed.task), cancelled: changed.result });
          }
          const changed = await store.mutate(taskId, (task) => event(task, 'conversation.cancel_requested', '已请求取消这次模型回复；任务、候选成果和已有对话保持不变。', { role: active.role || null }));
          active.controller.abort();
          return json(res, 202, { task: publicTaskWithRuntime(changed.task), cancelled: true });
        }
        if (action === 'conversation') {
          const role = String(body.role || 'coordinator');
          const requestedAgentId = String(body.agentId || '');
          const message = String(body.message || '').trim().slice(0, 2_000);
          const conversationTask = await store.get(taskId);
          const knownDynamicAgent = conversationTask.team?.agents?.find((agent) => agent.roleKey === role && agent.goalVersionId === activeGoal(conversationTask).id);
          if (requestedAgentId && knownDynamicAgent?.id !== requestedAgentId) throw new Error('对话对象与当前团队记录不一致。');
          if (!['archivist', 'researcher', 'writer', 'reviewer', 'steward'].includes(role) && !knownDynamicAgent) throw new Error('未知的办公室同事。');
          if (!message) throw new Error('请先写下要说的话。');
          if (activeJobs.has(taskId)) {
            const changed = await store.mutate(taskId, (task) => {
              task.conversationQueue ??= [];
              if (task.conversationQueue.filter((item) => item.status === 'pending').length >= 8) throw new Error('待回复消息已达 8 条上限，请等待一条完成后再发送。');
              const goalVersionId = activeGoal(task).id;
              const projectRootGoalVersionId = task.projectRootGoalVersionId || goalVersionId;
              const projectRootInputFingerprint = task.projectRootInputFingerprint || projectInputFingerprint(task);
              const instructionIds = currentInstructionIds(task);
              const materialApplicabilityFingerprint = materialContext(task, { includeGeneratedEvidence: false }).fingerprint;
              const provider = task.provider;
              const workItemId = task.workItems.find((item) => item.agentId === knownDynamicAgent?.id && item.status === 'running')?.id || task.workItems.find((item) => item.agentId === knownDynamicAgent?.id)?.id || null;
              const userEvent = event(task, 'conversation.user', message, { role, agentId: knownDynamicAgent?.id || null, workItemId, goalVersionId, projectRootGoalVersionId, projectRootInputFingerprint, materialApplicabilityFingerprint, instructionIds, provider, content: message });
              const queued = { id: `conversation-${crypto.randomUUID()}`, role, agentId: knownDynamicAgent?.id || null, workItemId, message, goalVersionId, projectRootGoalVersionId, projectRootInputFingerprint, materialApplicabilityFingerprint, instructionIds, provider, requestEventId: userEvent.id, status: 'pending', createdAt: new Date().toISOString(), startedAt: null, completedAt: null, reply: null, error: null };
              task.conversationQueue.push(queued); task.conversationQueue = task.conversationQueue.slice(-40);
              event(task, 'conversation.queued', '同事收到了这条消息；当前模型工作到安全切换点后会实际回复。', { role, agentId: queued.agentId, workItemId, goalVersionId, provider, queueId: queued.id, requestEventId: userEvent.id });
              return queued;
            });
            return json(res, 202, { task: publicTaskWithRuntime(changed.task), queued: true, queueItem: changed.result });
          }
          const controller = new AbortController();
          const agentId = knownDynamicAgent?.id || null;
          const entry = { controller, promise: null, kind: 'conversation', role, agentId };
          activeJobs.set(taskId, entry);
          let request;
          try {
            const before = await store.mutate(taskId, (task) => {
              const goalVersionId = activeGoal(task).id;
              const provider = task.provider;
              const workItemId = task.workItems.find((item) => item.agentId === agentId && item.status === 'running')?.id || task.workItems.find((item) => item.agentId === agentId)?.id || null;
              const projectRootGoalVersionId = task.projectRootGoalVersionId || goalVersionId;
              const projectRootInputFingerprint = task.projectRootInputFingerprint || projectInputFingerprint(task);
              const instructionIds = currentInstructionIds(task);
              const materialApplicabilityFingerprint = materialContext(task, { includeGeneratedEvidence: false }).fingerprint;
              const userEvent = event(task, 'conversation.user', message, { role, agentId, workItemId, goalVersionId, projectRootGoalVersionId, projectRootInputFingerprint, materialApplicabilityFingerprint, instructionIds, provider, content: message });
              event(task, 'conversation.call_started', `${role} 已开始一次${provider === 'demo' ? '演示' : '真实模型'}回复。`, { role, agentId, workItemId, goalVersionId, provider, requestEventId: userEvent.id });
              return { goalVersionId, projectRootGoalVersionId, projectRootInputFingerprint, materialApplicabilityFingerprint, instructionIds, provider, requestEventId: userEvent.id };
            });
            request = before.result;
            const reply = await providers.converse(await hydrateProjectContext(store, before.task), role, message, { signal: controller.signal });
            if (controller.signal.aborted) {
              const error = new Error('这次模型回复已取消，迟到结果未写入对话。');
              error.code = 'cancelled';
              throw error;
            }
            const content = String(reply.reply || '').slice(0, 4_000);
            const changed = await store.mutate(taskId, async (task) => {
              await assertProjectGoalFresh(store, task, request.projectRootGoalVersionId, request.projectRootInputFingerprint);
              if (activeJobs.get(taskId) !== entry || activeGoal(task).id !== request.goalVersionId
                || JSON.stringify(currentInstructionIds(task).slice().sort()) !== JSON.stringify(request.instructionIds.slice().sort())
                || request.materialApplicabilityFingerprint !== materialContext(task, { includeGeneratedEvidence: false }).fingerprint
                || task.provider !== request.provider) {
                const error = new Error('对话结果属于旧目标或旧提供者，未写入当前对话。');
                error.code = 'stale_result';
                throw error;
              }
              return event(task, 'conversation.reply', content, {
                role, kind: reply.kind || 'answer', sourceRefs: Array.isArray(reply.sourceRefs) ? reply.sourceRefs.slice(0, 12) : [],
                provider: request.provider, goalVersionId: request.goalVersionId, projectRootGoalVersionId: request.projectRootGoalVersionId,
                projectRootInputFingerprint: request.projectRootInputFingerprint, materialApplicabilityFingerprint: request.materialApplicabilityFingerprint,
                instructionIds: request.instructionIds,
                requestEventId: request.requestEventId, content,
              });
            });
            return json(res, 200, { task: publicTask(changed.task), reply });
          } catch (error) {
            await store.mutate(taskId, (task) => {
              const stale = error.code === 'stale_result' || (request && activeGoal(task).id !== request.goalVersionId);
              const cancelled = error.code === 'cancelled' || controller.signal.aborted;
              event(task, stale ? 'conversation.stale' : cancelled ? 'conversation.cancelled' : 'conversation.failed', stale ? '旧目标或旧运行的对话结果已丢弃。' : cancelled ? '这次模型回复已取消，没有写入迟到结果。' : `同事回复失败：${error.message}`, {
                role, provider: request?.provider || task.provider, goalVersionId: request?.goalVersionId || activeGoal(task).id, requestEventId: request?.requestEventId,
              });
              if (error.code === 'cancelled' && task.status === 'cancellation_unknown') setTaskState(task, 'cancelled', task.activeRole, '取消已确认：本地对话进程已终止。');
            }).catch(() => {});
            throw error;
          } finally {
            if (activeJobs.get(taskId) === entry) activeJobs.delete(taskId);
            setImmediate(() => drainConversationQueue(store, providers, taskId).catch(() => {}));
          }
        }
        if (action === 'suggestions') {
          const changed = await store.mutateWhere((task) => task.id === taskId || projectRootId(task) === taskId, (tasks) => {
            const task = tasks.get(taskId);
            const suggestion = addSuggestion(task, body);
            if (projectRootId(task) === task.id && suggestion.classification === 'support') {
              task.projectRootInputFingerprint = projectInputFingerprint(task);
              for (const linked of tasks.values()) invalidateLinkedTaskForRootGoal(linked, task.id, activeGoal(task).id, task.projectRootInputFingerprint, 'project_root_instructions_changed');
            }
            if (projectRootId(task) === task.id) normalizeRootGoalDecision(tasks, task);
            return suggestion;
          });
          if (['replace', 'support'].includes(changed.result.classification)) {
            for (const id of changed.tasks.keys()) {
              activeJobs.get(id)?.controller.abort();
              activeQueuedReplies.get(id)?.controller.abort();
            }
          }
          return json(res, 201, { task: publicTask(changed.tasks.get(taskId)), suggestion: changed.result });
        }
        if (action.startsWith('suggestions/') && action.endsWith('/classification')) {
          const id = action.split('/')[1];
          const changed = await store.mutateWhere((task) => task.id === taskId || projectRootId(task) === taskId, (tasks) => {
            const task = tasks.get(taskId);
            const beforeFingerprint = projectInputFingerprint(task);
            const suggestion = correctSuggestion(task, id, body.classification);
            if (projectRootId(task) === task.id && projectInputFingerprint(task) !== beforeFingerprint) {
              task.projectRootInputFingerprint = projectInputFingerprint(task);
              for (const linked of tasks.values()) invalidateLinkedTaskForRootGoal(linked, task.id, activeGoal(task).id, task.projectRootInputFingerprint, 'project_root_instructions_changed');
            }
            if (projectRootId(task) === task.id) normalizeRootGoalDecision(tasks, task);
            return suggestion;
          });
          if (!changed.tasks.get(taskId).plan || changed.result.classification === 'replace') {
            for (const taskIdToAbort of changed.tasks.keys()) {
              activeJobs.get(taskIdToAbort)?.controller.abort();
              activeQueuedReplies.get(taskIdToAbort)?.controller.abort();
            }
          }
          return json(res, 200, { task: publicTask(changed.tasks.get(taskId)), suggestion: changed.result });
        }
        if (action.startsWith('suggestions/') && action.endsWith('/accept-goal')) {
          const id = action.split('/')[1];
          const changed = await store.mutateWhere((task) => task.id === taskId || projectRootId(task) === taskId, (tasks) => {
            const target = tasks.get(taskId);
            if (projectRootId(target) === target.id) {
              const root = target;
              const goal = acceptGoalReplacement(root, id, body);
              const inputFingerprint = projectInputFingerprint(root);
              for (const task of tasks.values()) invalidateLinkedTaskForRootGoal(task, root.id, goal.id, inputFingerprint);
              return { goal, root: true };
            }
            return { goal: acceptGoalReplacement(target, id, body), root: false };
          });
          const syncedTaskIds = changed.result.root ? [...changed.tasks.keys()].filter((value) => value !== taskId) : [];
          for (const changedId of [taskId, ...syncedTaskIds]) {
            activeJobs.get(changedId)?.controller.abort();
            activeQueuedReplies.get(changedId)?.controller.abort();
          }
          return json(res, 200, { task: publicTask(changed.tasks.get(taskId)), goal: changed.result.goal, syncedTaskIds });
        }
        if (action === 'project-link') {
          const requestedRootId = String(body.rootTaskId || taskId);
          const all = await store.list();
          const childSnapshot = all.find((task) => task.id === taskId);
          const rootSnapshot = all.find((task) => task.id === requestedRootId);
          if (!childSnapshot || !rootSnapshot) throw new Error('找不到要关联的任务。');
          if (projectRootId(rootSnapshot) !== rootSnapshot.id) throw new Error('请选择项目根任务，不能关联到另一个子任务。');
          if (taskId !== requestedRootId && all.some((task) => task.id !== taskId && projectRootId(task) === taskId)) throw new Error('这个任务已有子任务，不能再变成另一个项目的子任务。');
          const changed = await store.mutateMany([taskId, requestedRootId], async (tasks) => {
            const child = tasks.get(taskId);
            const root = tasks.get(requestedRootId);
            const currentTasks = await store.list();
            const currentRoot = currentTasks.find((task) => task.id === requestedRootId);
            if (!currentRoot || projectRootId(currentRoot) !== currentRoot.id) throw new Error('请选择项目根任务，不能关联到另一个子任务。');
            if (taskId !== requestedRootId && currentTasks.some((task) => task.id !== taskId && projectRootId(task) === taskId)) {
              throw new Error('这个任务已有子任务，不能再变成另一个项目的子任务。');
            }
            const nextRootId = requestedRootId === taskId ? null : requestedRootId;
            if (projectRootId(child) === (nextRootId || child.id)) return child;
            ensureMaterialPolicy(child, 'project_link_changed');
            if (child.projectWorkspace || child.plan || child.workItems?.length || child.execution) invalidateCurrentWork(child, 'project_link_changed', '项目关联已改变；原任务目标和历史保留，旧代码工作区授权与计划已失效。');
            child.projectRootTaskId = nextRootId;
            child.projectRootGoalVersionId = activeGoal(root).id;
            child.projectRootInputFingerprint = projectInputFingerprint(root);
            event(child, 'project.linked', nextRootId ? `已明确关联到项目根任务“${root.title}”。` : '已从原项目解除关联，恢复为独立任务。', { rootTaskId: nextRootId || child.id, rootGoalVersionId: activeGoal(root).id });
            return child;
          });
          activeJobs.get(taskId)?.controller.abort();
          activeQueuedReplies.get(taskId)?.controller.abort();
          return json(res, 200, { task: publicTask(await hydrateProjectContext(store, changed.tasks.get(taskId))) });
        }
        const applicabilityMatch = action.match(/^materials\/([a-z0-9-]+)\/applicability$/);
        if (applicabilityMatch) {
          const changed = await store.mutate(taskId, async (task) => {
            await normalizeProjectScopeForExplicitWrite(store, task);
            const decision = recordMaterialDecision(task, applicabilityMatch[1], body);
            invalidateCurrentWork(task, 'material_applicability_changed', '材料适用决定已变化；旧计划、在途结果和候选资格已失效，需要按当前材料重新规划。');
            event(task, 'material.applicability_decided', `已记录“${task.materials.find((item) => item.id === decision.materialId)?.name || '材料'}”的当前用途：${decision.purpose}`, {
              materialId: decision.materialId, decisionId: decision.id, category: decision.category,
              disposition: decision.disposition, impact: decision.impact, materialApplicabilityFingerprint: materialContext(task, { includeGeneratedEvidence: false }).fingerprint,
            });
            return decision;
          });
          activeJobs.get(taskId)?.controller.abort();
          activeQueuedReplies.get(taskId)?.controller.abort();
          return json(res, 200, { task: publicTask(changed.task), decision: changed.result });
        }
        if (action === 'materials/text') {
          const changed = await store.mutate(taskId, (task) => addMaterial(task, { name: body.name || '粘贴文本', kind: 'text', source: 'user-paste', text: body.text }));
          activeJobs.get(taskId)?.controller.abort(); activeQueuedReplies.get(taskId)?.controller.abort();
          return json(res, 201, { task: publicTask(changed.task), material: changed.result });
        }
        if (action === 'materials/file') {
          let parsed;
          try { parsed = await parseUploadedMaterial(store.taskDir(taskId), body); }
          catch (error) {
            const changed = await store.mutate(taskId, (task) => addMaterial(task, { name: body.name || '文件', kind: path.extname(body.name || '').slice(1), source: `local-file:${body.name || 'unknown'}`, status: 'failed', error: error.message }));
            return json(res, 422, { error: { code: 'material_parse_failed', message: error.message }, task: publicTask(changed.task) });
          }
          const changed = await store.mutate(taskId, (task) => addMaterial(task, parsed));
          activeJobs.get(taskId)?.controller.abort(); activeQueuedReplies.get(taskId)?.controller.abort();
          return json(res, 201, { task: publicTask(changed.task), material: changed.result });
        }
        if (action === 'materials/url') {
          try {
            const fetched = await publicPageReader(body.url, { maxBytes: MAX_MATERIAL_BYTES, timeoutMs: 15_000 });
            const changed = await store.mutate(taskId, (task) => addMaterial(task, { name: body.name || new URL(fetched.finalUrl).hostname, kind: 'url', source: fetched.finalUrl, text: fetched.text, bytes: fetched.bytes }));
            activeJobs.get(taskId)?.controller.abort(); activeQueuedReplies.get(taskId)?.controller.abort();
            return json(res, 201, { task: publicTask(changed.task), material: changed.result });
          } catch (error) {
            const changed = await store.mutate(taskId, (task) => addMaterial(task, { name: body.name || body.url || '网址', kind: 'url', source: body.url, status: 'failed', error: error.message }));
            return json(res, 422, { error: { code: 'url_read_failed', message: error.message }, task: publicTask(changed.task) });
          }
        }
        if (action === 'provider') {
          if (activeJobs.has(taskId)) {
            const error = new Error('模型调用进行中不能切换提供者。');
            error.status = 409;
            throw error;
          }
          if (!['demo', 'codex-cli'].includes(body.provider)) throw new Error('未知的模型提供者。');
          const changed = await store.mutate(taskId, (task) => {
            if (task.type === 'project' && body.provider !== 'codex-cli') throw new Error('代码项目固定使用 Codex；演示提供者不能获得项目工作区。');
            task.provider = body.provider;
            event(task, 'provider.changed', body.provider === 'demo' ? '已切换到演示提供者。' : '已选择 Codex CLI；运行时会发送当前目标与选定材料。', { provider: body.provider });
          });
          return json(res, 200, { task: publicTask(changed.task) });
        }
        if (action === 'memory-policy') {
          if (!['task-only', 'workspace-confirmed'].includes(body.policy)) throw new Error('未知的记忆范围。');
          const changed = await store.mutate(taskId, (task) => {
            task.memoryPolicy = body.policy;
            event(task, 'memory.policy_changed', body.policy === 'workspace-confirmed' ? '已允许搜索其他任务中由你确认的成果。' : '记忆范围已收回到当前任务。', { policy: body.policy });
          });
          return json(res, 200, { task: publicTask(changed.task) });
        }
        if (action.startsWith('memory/') && action.endsWith('/retract')) {
          const memoryId = action.split('/')[1];
          const changed = await store.mutate(taskId, (task) => {
            const memory = task.memoryEntries?.find((entry) => entry.id === memoryId);
            if (!memory) throw new Error('找不到这条记忆。');
            memory.status = 'retracted'; memory.retractedAt = new Date().toISOString();
            event(task, 'memory.retracted', '这条已确认记忆已撤回，后续任务不会再检索它。', { memoryId, source: memory.source });
            return memory;
          });
          return json(res, 200, { task: publicTask(changed.task), memory: changed.result });
        }
        if (action === 'plan') {
          const changed = await planTask(store, providers, taskId);
          return json(res, 200, { task: publicTask(changed.task), workItems: changed.result });
        }
        if (action === 'continue') {
          if (activeJobs.has(taskId)) return problem(res, 409, '这项任务正在运行。', 'already_running');
          let snapshot = await store.get(taskId);
          const continuity = deriveTaskContinuity(snapshot);
          if (['waiting_user', 'ready_to_export'].includes(snapshot.status) || continuity.progress.needsUserDecision) {
            return json(res, 200, { task: publicTask(await hydrateProjectContext(store, snapshot)), action: 'await_user', message: continuity.progress.nextStep });
          }
          await assertProjectGoalFresh(store, snapshot);
          if (['permanent_error', 'same_error_exhausted', 'budget_exhausted', 'project_verification_failed', 'project_transaction_failed'].includes(snapshot.execution?.stopReason)) {
            return json(res, 200, { task: publicTask(await hydrateProjectContext(store, snapshot)), action: 'blocked', message: continuity.progress.stoppedBecause || continuity.progress.nextStep });
          }
          const goal = activeGoal(snapshot);
          const planStale = !snapshot.plan || !snapshot.workItems?.length || snapshot.plan.goalVersionId !== goal.id
            || (snapshot.plan.projectRootGoalVersionId && snapshot.plan.projectRootGoalVersionId !== snapshot.projectRootGoalVersionId)
            || modelPlanInputsChanged(snapshot);
          if (planStale) {
            const planned = await planTask(store, providers, taskId);
            snapshot = planned.task;
            if (snapshot.status === 'waiting_user' || !snapshot.workItems.length || (snapshot.provider === 'codex-cli' && !snapshot.plan)) {
              return json(res, 200, { task: publicTask(await hydrateProjectContext(store, snapshot)), action: 'await_user', message: deriveTaskContinuity(snapshot).progress.nextStep });
            }
          }
          await runTask(store, providers, projectWorkspaceHost, taskId);
          return json(res, 202, { task: publicTask(await hydrateProjectContext(store, await store.get(taskId))), action: 'running', accepted: true });
        }
        if (action === 'run') {
          if (activeJobs.has(taskId)) return problem(res, 409, '这项任务正在运行。', 'already_running');
          await runTask(store, providers, projectWorkspaceHost, taskId);
          return json(res, 202, { task: publicTask(await store.get(taskId)), accepted: true });
        }
        if (action === 'cancel') {
          const active = activeJobs.get(taskId);
          if (active?.kind === 'planning') {
            const changed = await store.mutate(taskId, (task) => {
              event(task, 'planning.cancelled', '已取消这次形成计划；原目标、材料和已有计划保持不变。', { role: 'coordinator' });
              setTaskState(task, task.workItems.length ? 'ready' : 'idle', 'coordinator', '形成计划已取消，可以稍后重新开始。');
            });
            active.controller.abort();
            return json(res, 202, { task: publicTaskWithRuntime(changed.task), cancelled: true, kind: 'planning' });
          }
          const changed = await store.mutate(taskId, (task) => {
            for (const item of task.workItems) if (item.status === 'running') item.status = 'cancelled';
            if (active) {
              if (task.execution) task.execution.stopReason = 'cancellation_requested';
              setTaskState(task, 'cancellation_unknown', task.activeRole, '已请求取消，正在确认本地执行进程是否终止。');
            } else {
              if (task.execution && !['completed', 'cancelled'].includes(task.execution.phase)) transitionExecution(task, 'cancelled');
              if (task.execution) task.execution.stopReason = 'cancelled_while_idle';
              setTaskState(task, 'cancelled', task.activeRole, '已取消；当前没有运行中的本地模型进程。');
            }
          });
          active?.controller.abort();
          return json(res, 200, { task: publicTask(changed.task) });
        }
        const reviseMatch = action.match(/^artifacts\/([a-z0-9-]+)\/revise$/);
        if (reviseMatch) {
          const changed = await store.mutate(taskId, async (task) => {
            await assertProjectGoalFresh(store, task);
            return reviseArtifact(task, reviseMatch[1], body);
          });
          await generateNativeCandidateFiles(store, taskId, changed.result.id);
          const refreshed = await store.get(taskId);
          return json(res, 201, { task: publicTask(refreshed), artifact: refreshed.artifacts.find((entry) => entry.id === changed.result.id) });
        }
        const reviewMatch = action.match(/^artifacts\/([a-z0-9-]+)\/review$/);
        if (reviewMatch) {
          if (activeJobs.has(taskId)) throw new Error('这项任务正在运行。');
          const controller = new AbortController();
          const entry = { controller, promise: null };
          activeJobs.set(taskId, entry);
          let reviewContext = null;
          try {
            const prepared = await store.mutate(taskId, async (task) => {
              await assertProjectGoalFresh(store, task);
              const artifact = task.artifacts.find((item) => item.id === reviewMatch[1]);
              if (!artifact) throw new Error('找不到要审阅的候选成果。');
              if (artifact.goalVersionId !== activeGoal(task).id || artifact.status !== 'candidate') throw new Error('只能重新审阅当前目标下未确认的候选版本。');
              assertArtifactInputCurrent(task, artifact);
              if (task.type === 'project') {
                await projectWorkspaceHost.assertArtifactFilesCurrent(task, store.taskDir(taskId), artifact);
                assertProjectExecutionAuditCurrent(task, artifact);
              }
              artifact.reviewStatus = 'pending';
              event(task, 'artifact.review_started', `候选成果 v${artifact.version} 正在重新独立核对；旧核对保留为历史，但不能用于确认。`, { artifactId: artifact.id });
              startExecution(task, activeGoal(task).id);
              transitionExecution(task, 'reviewing');
              const plannedReviewer = task.workItems.find((item) => item.kind === 'review') || task.workItems.find((item) => item.role === 'reviewer');
              if (!plannedReviewer) throw new Error('当前计划没有可用的独立审阅角色。');
              const dynamic = task.plan?.source === 'model' && Boolean(workSession(task, plannedReviewer.id));
              const reviewer = dynamic ? {
                ...structuredClone(plannedReviewer),
                id: `work-${crypto.randomUUID()}`,
                stepKey: `manual-review-${artifact.version}-${crypto.randomUUID()}`,
                title: `独立复核候选 v${artifact.version}`,
                status: 'ready',
                dependsOn: [], dependencyKeys: [],
                inputFingerprint: artifactContentSha256(artifact),
                sourceContextFingerprint: artifactContentSha256(artifact),
                result: null, attempts: [], error: null, startedAt: null, completedAt: null,
                createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                manualReviewOfArtifactId: artifact.id,
                basedOnWorkItemId: plannedReviewer.id,
              } : plannedReviewer;
              if (dynamic) {
                task.workItems.push(reviewer);
                task.agentSessions.push({
                  id: `session-${crypto.randomUUID()}`, agentId: reviewer.agentId, roleKey: reviewer.role, workItemId: reviewer.id,
                  goalVersionId: activeGoal(task).id, planRevision: task.plan.revision, status: 'planned', input: null, output: null,
                  projectRootGoalVersionId: task.projectRootGoalVersionId || activeGoal(task).id,
                  projectRootInputFingerprint: task.projectRootInputFingerprint || null,
                  materialApplicabilityFingerprint: materialContext(task, { includeGeneratedEvidence: false }).fingerprint,
                  inputFingerprint: reviewer.inputFingerprint,
                  sourceContextFingerprint: reviewer.sourceContextFingerprint,
                  ...(task.type === 'project' ? {
                    workspaceScopeFingerprint: projectWorkspaceFingerprint(task),
                    sourceSnapshotSha256: task.projectWorkspace?.sourceSnapshotSha256 || null,
                  } : {}),
                  runId: task.execution.id, attemptId: null, toolCalls: [], manualReviewOfArtifactId: artifact.id,
                  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
                });
                task.agentSessions = task.agentSessions.slice(-80);
                beginWorkItem(task, reviewer.id);
                task.activeAgentId = reviewer.agentId;
                markSession(task, reviewer.id, 'planned', { runId: task.execution.id, attemptId: null, reviewedArtifactId: artifact.id, reviewedArtifactHash: artifactContentSha256(artifact) });
              }
              else reviewer.status = 'running';
              const role = reviewer.role || 'reviewer';
              setTaskState(task, 'running', role, '独立审阅角色正在重新对照原文核对这个候选版本。');
              return { reviewerId: reviewer.id, role, runId: task.execution.id, dynamic, artifactHash: artifactContentSha256(artifact) };
            });
            reviewContext = prepared.result;
            entry.kind = 'review'; entry.role = reviewContext.role;
            const result = reviewContext.dynamic
              ? await callDynamicReview(store, providers, taskId, prepared.task.workItems.find((item) => item.id === reviewContext.reviewerId), reviewMatch[1], controller.signal, reviewContext.runId)
              : await callProviderStep(store, providers, taskId, reviewContext.role, 'review', controller.signal, reviewMatch[1]);
            const changed = await store.mutate(taskId, async (draft) => {
              await assertProjectGoalFresh(store, draft, prepared.task.projectRootGoalVersionId, prepared.task.projectRootInputFingerprint);
              const artifact = draft.artifacts.find((item) => item.id === reviewMatch[1]);
              if (!artifact || artifactContentSha256(artifact) !== reviewContext.artifactHash) throw Object.assign(new Error('候选成果在审阅期间已变化，这次结果不能写入。'), { code: 'stale_result' });
              const reviewOptions = await trustedReviewOptions(draft, artifact, store.taskDir(taskId), projectWorkspaceHost);
              const review = recordReview(draft, reviewMatch[1], result, reviewOptions);
              const storedResult = { reviewId: review.id, passed: review.passed, summary: review.summary, sourceEvidenceCount: review.sourceEvidence.length };
              if (reviewContext.dynamic) {
                completeWorkItem(draft, reviewContext.reviewerId, storedResult);
                markSession(draft, reviewContext.reviewerId, 'completed', { output: storedResult, reviewedArtifactId: artifact.id, reviewedArtifactHash: reviewContext.artifactHash });
              } else completeWork(draft, reviewContext.role, storedResult);
              const steward = draft.workItems.find((item) => item.kind === 'delivery') || draft.workItems.find((item) => item.role === 'steward');
              if (steward && !reviewContext.dynamic) steward.status = review.passed ? 'waiting_user' : 'blocked';
              transitionExecution(draft, review.passed ? 'waiting_user' : 'partial');
              draft.execution.stopReason = review.passed ? null : 'review_blocked';
              return review;
            });
            return json(res, 200, { task: publicTask(changed.task), review: changed.result });
          } catch (error) {
            await store.mutate(taskId, async (task) => {
              await assertProjectGoalFresh(store, task);
              const artifact = task.artifacts.find((item) => item.id === reviewMatch[1]);
              if (artifact?.status === 'candidate') artifact.reviewStatus = 'failed';
              const reviewer = reviewContext
                ? task.workItems.find((item) => item.id === reviewContext.reviewerId)
                : task.workItems.find((item) => item.kind === 'review') || task.workItems.find((item) => item.role === 'reviewer');
              if (reviewer?.status === 'running') failWorkItem(task, reviewer.id, error, error.code === 'budget_exhausted' ? 'blocked' : 'failed');
              if (reviewContext?.dynamic && reviewer) markSession(task, reviewer.id, error.code === 'cancelled' ? 'cancelled' : 'failed', { error: error.message });
              if (task.execution && ['executing', 'reviewing'].includes(task.execution.phase)) transitionExecution(task, error.code === 'budget_exhausted' ? 'partial' : error.code === 'cancelled' ? 'cancelled' : 'failed');
              if (task.execution) task.execution.stopReason = error.code || 'review_failed';
              setTaskState(task, error.code === 'budget_exhausted' ? 'partial' : error.code === 'cancelled' ? 'cancelled' : 'failed', reviewer?.role || 'reviewer', `重新审阅失败：${error.message}`);
            }).catch(() => {});
            throw error;
          } finally {
            if (activeJobs.get(taskId) === entry) activeJobs.delete(taskId);
            setImmediate(() => drainConversationQueue(store, providers, taskId).catch(() => {}));
          }
        }
        const refreshNativeMatch = action.match(/^artifacts\/([a-z0-9-]+)\/refresh-native$/);
        if (refreshNativeMatch) {
          if (activeJobs.has(taskId)) throw new Error('这项任务正在运行。');
          const controller = new AbortController();
          const entry = { controller, promise: null, kind: 'native-refresh', role: 'writer' };
          activeJobs.set(taskId, entry);
          let refreshStarted = false;
          try {
            await store.mutate(taskId, async (task) => {
              await assertProjectGoalFresh(store, task);
              const artifact = task.artifacts.find((item) => item.id === refreshNativeMatch[1]);
              if (!artifact) throw new Error('找不到要重新生成本地文件的候选成果。');
              if (artifact.goalVersionId !== activeGoal(task).id || artifact.status !== 'candidate') throw new Error('只有当前目标下未确认的候选版本可以重新生成本地文件。');
              assertArtifactInputCurrent(task, artifact);
              if (!(artifact.deliverables || []).some((item) => ['document', 'spreadsheet', 'presentation'].includes(item.kind))) throw new Error('这个候选版本没有需要重新生成的本地办公文件。');
              artifact.reviewStatus = 'pending';
              event(task, 'artifact.native_refresh_started', `候选成果 v${artifact.version} 正在重新生成本地文件；已有审阅保留为历史，但不再允许据此确认。`, { artifactId: artifact.id, generatorRevision: nativeGeneratorRevision });
              setTaskState(task, 'running', 'writer', `正在为候选成果 v${artifact.version} 重新生成本地文件。`);
            });
            refreshStarted = true;
            await generateNativeCandidateFiles(store, taskId, refreshNativeMatch[1], { signal: controller.signal, force: true });
            const changed = await store.mutate(taskId, async (task) => {
              await assertProjectGoalFresh(store, task);
              const artifact = task.artifacts.find((item) => item.id === refreshNativeMatch[1]);
              artifact.reviewStatus = 'pending';
              event(task, 'artifact.native_refreshed', `候选成果 v${artifact.version} 的本地文件已重新生成；需要重新独立核对后才能确认。`, {
                artifactId: artifact.id, generatorRevision: nativeGeneratorRevision,
                files: (artifact.nativeFiles || []).map((file) => ({ kind: file.kind, sha256: file.sha256 || null })),
              });
              setTaskState(task, 'waiting_user', 'reviewer', `候选成果 v${artifact.version} 的本地文件已更新，等待重新独立核对。`);
              return artifact;
            });
            return json(res, 200, { task: publicTask(changed.task), artifact: changed.result });
          } catch (error) {
            if (refreshStarted) await store.mutate(taskId, (task) => {
                const artifact = task.artifacts.find((item) => item.id === refreshNativeMatch[1]);
                if (artifact) artifact.reviewStatus = 'failed';
                setTaskState(task, error.code === 'cancelled' ? 'cancelled' : 'failed', 'writer', `重新生成本地文件失败：${error.message}`);
              }).catch(() => {});
            throw error;
          } finally {
            if (activeJobs.get(taskId) === entry) activeJobs.delete(taskId);
          }
        }
        const confirmMatch = action.match(/^artifacts\/([a-z0-9-]+)\/confirm$/);
        if (confirmMatch) {
          if (activeJobs.has(taskId)) return problem(res, 409, '任务仍有工作在进行，不能使用旧核对结果确认。', 'already_running');
          const changed = await store.mutate(taskId, async (task) => {
            if (activeJobs.has(taskId)) throw new Error('任务仍有工作在进行，不能使用旧核对结果确认。');
            await assertProjectGoalFresh(store, task);
            if (task.type === 'project') {
              const artifact = task.artifacts.find((entry) => entry.id === confirmMatch[1]);
              await projectWorkspaceHost.assertArtifactFilesCurrent(task, store.taskDir(taskId), artifact);
              assertProjectExecutionAuditCurrent(task, artifact);
            }
            return confirmArtifact(task, confirmMatch[1]);
          });
          return json(res, 200, { task: publicTask(changed.task), approval: changed.result });
        }
        const rejectMatch = action.match(/^artifacts\/([a-z0-9-]+)\/reject$/);
        if (rejectMatch) {
          const changed = await store.mutate(taskId, (task) => rejectArtifact(task, rejectMatch[1], body.reason));
          return json(res, 200, { task: publicTask(changed.task), artifact: changed.result });
        }
      }
      problem(res, 404, '找不到这个操作。', 'not_found');
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : error.status || (/(找不到|不存在)/.test(error.message) ? 404 : 400);
      problem(res, status, error.message || '请求失败。', error.publicSafe ? error.code : 'request_failed');
    }
  });
  return { server, store, providers, projectWorkspaceHost };
}

export async function start({ port = Number(process.env.PORT || 3847), host = '127.0.0.1', root = dataRoot, providers: providedProviders = null, publicPageReader = readPublicPage, projectWorkspaceHost = null } = {}) {
  const { server, store, providers, projectWorkspaceHost: runningProjectWorkspaceHost } = await createIrixiServer({ root, providers: providedProviders, publicPageReader, projectWorkspaceHost });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  for (const task of await store.list()) {
    const hasInterruptedRun = task.status === 'running'
      || task.workItems?.some((item) => item.status === 'running')
      || ['planned', 'executing', 'reviewing'].includes(task.execution?.phase)
      || task.execution?.modelCalls?.some((call) => call.status === 'running')
      || task.execution?.delegations?.some((delegation) => delegation.status === 'running')
      || task.agentSessions?.some((session) => session.status === 'running');
    if (hasInterruptedRun) await store.mutate(task.id, (draft) => {
      const interruptedAt = new Date().toISOString();
      for (const item of draft.workItems || []) if (item.status === 'running') {
        item.status = 'failed'; item.error = '应用重启中断了本次工作，可从已保存步骤继续。'; item.completedAt = interruptedAt; item.updatedAt = interruptedAt;
      }
      for (const call of draft.execution?.modelCalls || []) if (call.status === 'running') {
        call.status = 'failed'; call.error = '应用重启中断本地模型调用。'; call.finishedAt = interruptedAt;
      }
      for (const delegation of draft.execution?.delegations || []) if (delegation.status === 'running') {
        delegation.status = 'failed'; delegation.error = '应用重启中断本次委派。'; delegation.finishedAt = interruptedAt;
      }
      for (const session of draft.agentSessions || []) if (session.status === 'running') {
        session.status = 'failed'; session.error = '应用重启中断本次会话。'; session.updatedAt = interruptedAt;
      }
      for (const agent of draft.team?.agents || []) agent.status = 'available';
      if (draft.execution && ['planned', 'executing', 'reviewing'].includes(draft.execution.phase)) {
        draft.execution.phase = 'partial'; draft.execution.stopReason = 'process_restart_interrupted'; draft.execution.updatedAt = interruptedAt;
      }
      draft.activeAgentId = null;
      event(draft, 'execution.recovered', '应用重启中断了上次运行；已关闭悬空调用并保留完成步骤与候选成果，等待你继续。', { interruptedAt });
      setTaskState(draft, 'partial', draft.activeRole || 'coordinator', '上次运行被应用重启中断；已保存现有结果，可点击继续运行。');
    });
    if (task.conversationQueue?.some((item) => item.status === 'running')) await store.mutate(task.id, (draft) => {
      for (const item of draft.conversationQueue || []) if (item.status === 'running') {
        item.status = 'pending'; item.startedAt = null; item.error = '应用重启中断了上次回复，已恢复为待回复。';
        event(draft, 'conversation.recovered', '应用重启中断了上次排队回复，已恢复为可取消、可重试的待回复消息。', { role: item.role, agentId: item.agentId, queueId: item.id });
      }
    });
    if ((await store.get(task.id)).conversationQueue?.some((item) => item.status === 'pending')) setImmediate(() => drainConversationQueue(store, providers, task.id).catch(() => {}));
  }
  const address = server.address();
  return { server, store, providers, projectWorkspaceHost: runningProjectWorkspaceHost, url: `http://${host}:${address.port}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const running = await start();
  process.stdout.write(`Irixi 1.0 已启动：${running.url}\n`);
  process.stdout.write('任务数据只保存在本机。按 Control-C 停止。\n');
}

export const __test = { exportBody, safeFilename, projectOfficeTask, validateOfficeLayout, generateNativeCandidateFiles };
