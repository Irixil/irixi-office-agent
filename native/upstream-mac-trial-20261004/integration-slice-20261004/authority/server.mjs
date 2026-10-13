#!/usr/bin/env node
import { historicalBindings } from './historical-bindings.mjs';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAuthorityReader, fingerprint, projectTaskBoard, sha256 } from './authority-core.mjs';
import { createIntakeController } from './intake-controller.mjs';
import { articleDiscussionBlock, describeArticleDiscussion } from './model-availability.mjs';
import { createIntegrationController } from './task-controller.mjs';
import { createArticleProjectController } from './article-project-controller.mjs';
import { cleanRepairReviewBoundary } from './article-clean-repair-input.mjs';
import { storageRepair48ReviewBoundary } from './article-storage-repair-48.mjs';
import { storageRepair49ReviewBoundary } from './article-storage-repair-49.mjs';

const TRIAL_ROOT = path.resolve(import.meta.dirname, '..', '..');
const SLICE_ROOT = path.resolve(import.meta.dirname, '..');
const PORT = Number(process.env.IRIXI_AUTHORITY_PORT || 3869);
const TASKS_ROOT = process.env.IRIXI_AUTHORITY_TASKS_ROOT;
const TASK_ID = process.env.IRIXI_AUTHORITY_TASK_ID;
const IRIXI_APP_ROOT = process.env.IRIXI_APP_ROOT;
const TOY_ROOT = process.env.IRIXI_INTEGRATION_TOY_ROOT;
const PRODUCT_MODE = process.env.IRIXI_PRODUCT_AUTHORITY === '1';
const INTAKE_TASK_ID = process.env.IRIXI_INTAKE_TASK_ID || null;
const ARTICLE_INTAKE_TASK_ID = 'task-article-learning-11';
const ARTICLE_INTAKE_MODE = INTAKE_TASK_ID === ARTICLE_INTAKE_TASK_ID && TASK_ID === ARTICLE_INTAKE_TASK_ID;
const REAL_ARTICLE_TASK_ID = 'task-article-learning-12';
const REAL_ARTICLE_MODE = INTAKE_TASK_ID === REAL_ARTICLE_TASK_ID && TASK_ID === REAL_ARTICLE_TASK_ID;
const ARTICLE_PROJECT_ROOT = path.join(SLICE_ROOT, 'project-intake-20261004', 'projects', REAL_ARTICLE_MODE ? 'article-learning-12' : 'article-learning-11');
const ARTICLE_WORKSPACE = path.join(ARTICLE_PROJECT_ROOT, 'workspace');
const ARTICLE_DISCUSSION_LEDGER = path.join(ARTICLE_PROJECT_ROOT, 'state', 'model-ledger.json');
const ARTICLE_DRAFT = '我想做一个帮助我读文章和学习的小产品，但还没想清楚怎么做。';
const ARTICLE_PROJECT_FILE = REAL_ARTICLE_MODE ? path.join(ARTICLE_PROJECT_ROOT, 'project.json') : null;
const ARTICLE_CAPABILITY_FILE = REAL_ARTICLE_MODE ? path.join(ARTICLE_PROJECT_ROOT, 'state', 'model-capability.json') : null;
const INTAKE_BATCH_STATUS_FILE = ARTICLE_INTAKE_MODE || REAL_ARTICLE_MODE
  ? path.join(ARTICLE_PROJECT_ROOT, 'state', 'model-capability.json')
  : path.join(SLICE_ROOT, 'project-intake-20261004', 'state', 'model-capability.json');
const REVIEW_LEDGER_FILE = path.join(SLICE_ROOT, 'batches', 'codex-intake-review-10', 'state', 'model-ledger.json');
const REVIEW_BINDING = historicalBindings.reviewBinding;
const STATE_ROOT = path.resolve(process.env.IRIXI_INTEGRATION_STATE_ROOT || path.join(SLICE_ROOT, 'state'));
const MAX_BODY = 64 * 1024;
const PRODUCT_INFERENCE_BODY_BYTES = 1024 * 1024;
const OBSERVATION_TYPES = new Set(['TASK_STARTED', 'TASK_DONE', 'TASK_FAILED', 'HOST_CHECKED', 'REVIEW_STARTED', 'REVIEW_DONE', 'DISCUSSION', 'CONFIRMED']);
const SLOW_AUTHORITY_PROJECTION_MS = 250;

if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error('IRIXI_AUTHORITY_PORT is invalid');
for (const [name, value] of [['IRIXI_AUTHORITY_TASKS_ROOT', TASKS_ROOT], ['IRIXI_AUTHORITY_TASK_ID', TASK_ID], ['IRIXI_APP_ROOT', IRIXI_APP_ROOT], ...(!(PRODUCT_MODE || ARTICLE_INTAKE_MODE || REAL_ARTICLE_MODE) ? [['IRIXI_INTEGRATION_TOY_ROOT', TOY_ROOT]] : [])]) {
  if (!value || (name !== 'IRIXI_AUTHORITY_TASK_ID' && !path.isAbsolute(value))) throw new Error(`${name} is required`);
}
if (!STATE_ROOT.startsWith(`${SLICE_ROOT}${path.sep}`)) throw new Error('Integration state must stay inside the slice');
if (ARTICLE_INTAKE_MODE || REAL_ARTICLE_MODE) {
  const workspaceStat = await fs.lstat(ARTICLE_WORKSPACE);
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink() || await fs.realpath(ARTICLE_WORKSPACE) !== ARTICLE_WORKSPACE) throw new Error('Article discussion workspace is invalid');
  if (!path.resolve(TASKS_ROOT).startsWith(`${ARTICLE_PROJECT_ROOT}${path.sep}`)
    || !STATE_ROOT.startsWith(`${ARTICLE_PROJECT_ROOT}${path.sep}`)) throw new Error('Article discussion state must stay inside its isolated project root');
}

const reader = await createAuthorityReader({ tasksRoot: TASKS_ROOT, taskId: TASK_ID, irixiAppRoot: IRIXI_APP_ROOT });
const articleController = REAL_ARTICLE_MODE ? await createArticleProjectController({ tasksRoot: TASKS_ROOT, irixiAppRoot: IRIXI_APP_ROOT, projectFile: ARTICLE_PROJECT_FILE, capabilityFile: ARTICLE_CAPABILITY_FILE }) : null;
const controller = PRODUCT_MODE ? null : ARTICLE_INTAKE_MODE || REAL_ARTICLE_MODE ? articleController : await createIntegrationController({ tasksRoot: TASKS_ROOT, irixiAppRoot: IRIXI_APP_ROOT, toyRoot: TOY_ROOT });
const intake = !PRODUCT_MODE && INTAKE_TASK_ID ? await createIntakeController({ tasksRoot: TASKS_ROOT, irixiAppRoot: IRIXI_APP_ROOT, taskId: INTAKE_TASK_ID, articleProjectFile: ARTICLE_PROJECT_FILE, articleCapabilityFile: ARTICLE_CAPABILITY_FILE }) : null;
const productLearning = PRODUCT_MODE ? await createIntakeController({ tasksRoot: TASKS_ROOT, irixiAppRoot: IRIXI_APP_ROOT, taskId: TASK_ID, productMode: true }) : null;

async function readCapabilityFile() {
  const file = path.resolve(INTAKE_BATCH_STATUS_FILE);
  if (!file.startsWith(`${SLICE_ROOT}${path.sep}`)) throw new Error('Intake batch status file must stay inside the slice');
  let stat;
  try { stat = await fs.lstat(file); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8_192 || await fs.realpath(file) !== file) throw new Error('Intake batch status file is invalid');
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!value || typeof value.phase !== 'string' || Buffer.byteLength(value.phase) > 120) throw new Error('Intake model capability phase is malformed');
  return { file, value };
}

async function writeArticleCapabilityEnabled(enabled) {
  if (!ARTICLE_INTAKE_MODE) throw Object.assign(new Error('This intake lane has no user-openable discussion batch'), { status: 404 });
  const loaded = await readCapabilityFile();
  if (!loaded) throw Object.assign(new Error('The bounded discussion capability has not been prepared'), { status: 409 });
  const parent = path.dirname(loaded.file);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await fs.realpath(parent) !== parent) throw new Error('Article discussion state directory is invalid');
  const entry = loaded.value.discussion;
  if (!entry || entry.ledgerFile !== ARTICLE_DISCUSSION_LEDGER || entry.cap !== 2 || entry.windowMs !== 20 * 60_000) throw new Error('Article discussion capability is malformed');
  const current = await modelAvailability();
  if (enabled && !current.discussion.openable && !current.discussion.available) {
    throw Object.assign(new Error(`This bounded discussion batch cannot be opened: ${current.discussion.reason}`), { status: 409 });
  }
  const next = structuredClone(loaded.value);
  next.phase = enabled ? 'article-learning-discussion-open' : 'article-learning-discussion-closed';
  next.discussion.enabled = enabled;
  next.discussion.reason = enabled ? '用户已明确开启本批只读澄清；发送消息才会启动模型。' : '用户已关闭本批只读澄清；账本和已用额度保持不变。';
  const temporary = path.join(parent, `.model-capability-${process.pid}-${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, loaded.file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  return modelAvailability();
}

async function modelAvailability() {
  const discussionLedger = ARTICLE_INTAKE_MODE ? ARTICLE_DISCUSSION_LEDGER : path.join(SLICE_ROOT, 'project-intake-20261004', 'state', 'model-ledger.json');
  const unavailable = { phase: 'unavailable', discussion: { available: false, enabled: false, remaining: 0, deadlineAt: null, reason: '模型批次尚未开放' }, execution: { available: false, enabled: false, remaining: 0, deadlineAt: null, reason: '模型批次尚未开放' }, label: '模型批次尚未开放；仍可编辑目标和选择范围。' };
  const loaded = await readCapabilityFile();
  if (!loaded) return unavailable;
  const { value } = loaded;
  async function one(name, expectedLedger, expectedCap, runtime = null) {
    const entry = value[name];
    if (!entry || typeof entry.enabled !== 'boolean' || typeof entry.reason !== 'string' || Buffer.byteLength(entry.reason) > 500
      || entry.ledgerFile !== expectedLedger || entry.cap !== expectedCap || entry.windowMs !== 20 * 60_000) throw new Error(`Intake ${name} capability is malformed`);
    let ledger = null;
    try {
      const ledgerStat = await fs.lstat(expectedLedger);
      if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink() || ledgerStat.nlink !== 1 || ledgerStat.size > 256 * 1024 || await fs.realpath(expectedLedger) !== expectedLedger) throw new Error(`Intake ${name} ledger is invalid`);
      ledger = JSON.parse(await fs.readFile(expectedLedger, 'utf8'));
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const used = ledger ? Array.isArray(ledger.calls) ? ledger.calls.length : NaN : 0;
    if (!Number.isInteger(used) || used < 0 || used > entry.cap || ledger && (ledger.cap !== entry.cap || ledger.windowMs !== entry.windowMs)) throw new Error(`Intake ${name} ledger is malformed`);
    const deadlineAt = ledger?.deadlineAt || null;
    if (deadlineAt !== null && (typeof deadlineAt !== 'string' || !Number.isFinite(Date.parse(deadlineAt)))) throw new Error(`Intake ${name} deadline is malformed`);
    const remaining = entry.cap - used;
    const runtimeBlock = runtime ? articleDiscussionBlock({ calls: ledger?.calls || [], ...runtime }) : null;
    const reason = runtimeBlock?.reason || entry.reason;
    const timeEligible = deadlineAt === null || Date.parse(deadlineAt) > Date.now();
    const eligible = !runtimeBlock && !ledger?.sealed && remaining > 0 && timeEligible;
    const available = entry.enabled && eligible;
    return { available, enabled: entry.enabled, remaining, deadlineAt, reason, sealed: Boolean(ledger?.sealed), eligible, ...(runtimeBlock ? { blockedBy: runtimeBlock.code } : {}) };
  }
  if (ARTICLE_INTAKE_MODE) {
    const intakeValue = await intake.read();
    const discussion = await one('discussion', discussionLedger, 2, { pendingRun: intakeValue.pendingRun, intakeStatus: intakeValue.status });
    discussion.openable = !discussion.enabled && discussion.eligible && !intakeValue.pendingRun;
    discussion.closeable = discussion.enabled;
    const execution = { available: false, enabled: false, remaining: 0, deadlineAt: null, reason: '该入口仅讨论和确认目标，不授权代码执行。', sealed: true, mode: 'discussion_only' };
    return { phase: value.phase, discussion, execution,
      label: `模型状态：${describeArticleDiscussion(discussion)}。编辑和确认目标不依赖模型。` };
  }
  const discussion = await one('discussion', discussionLedger, 2);
  const execution = { ...(await one('execution', REVIEW_LEDGER_FILE, 1)), mode: 'review_only' };
  const { projection } = await reader.read();
  const reviewBindingCurrent = projection.current
    && projection.goalVersionId === REVIEW_BINDING.goalVersionId
    && projection.execution?.id === REVIEW_BINDING.executionId
    && !projection.execution?.stopReason
    && projection.artifact?.id === REVIEW_BINDING.artifactId
    && projection.artifact?.version === REVIEW_BINDING.artifactVersion
    && projection.artifact?.hostCheck?.passed === true
    && !projection.artifact?.review
    && !projection.artifact?.confirmation;
  if (!reviewBindingCurrent) {
    execution.available = false;
    execution.reason = '只读审阅批次只绑定已通过宿主检查的当前候选 v1；候选、目标、运行或审阅状态已变化';
  }
  const describe = (name, entry) => {
    if (entry.available) return `${name}可用，剩余 ${entry.remaining} 次${entry.deadlineAt ? `，本轮截止 ${entry.deadlineAt}` : '，首次调用后开启 20 分钟窗口'}`;
    if (entry.sealed) return `${name}不可用：批次已封存`;
    if (entry.remaining === 0) return `${name}不可用：额度已用完`;
    if (entry.deadlineAt && Date.parse(entry.deadlineAt) <= Date.now()) return `${name}不可用：20 分钟窗口已结束`;
    if (!entry.enabled) return `${name}不可用：${entry.reason}`;
    return `${name}不可用：${entry.reason}`;
  };
  return { phase: value.phase, discussion, execution,
    label: `模型状态：${describe('讨论', discussion)}；${describe('当前候选只读审阅', execution)}。目标与范围操作不依赖模型，仍可继续。` };
}

async function intakeState() {
  if (PRODUCT_MODE && productLearning) {
    const learning = await productLearning.productLearningStatus();
    return { enabled: true, exists: true, taskId: TASK_ID, discussionOnly: false, executionSupported: false,
      modelAvailability: { phase: 'native-product-learning', discussion: { available: false, enabled: false, remaining: 0, sealed: true, reason: '当前产品任务不开放旧讨论批次。' },
        execution: { available: false, enabled: false, remaining: 0, sealed: true, reason: '开发与审阅由当前 OpenOffice 原生执行管理。' },
        learning, label: `文章学习：${learning.reason}` } };
  }
  if (REAL_ARTICLE_MODE) await intake.ensureTask();
  const value = await intake.read();
  if (REAL_ARTICLE_MODE) {
    const project = JSON.parse(await fs.readFile(ARTICLE_PROJECT_FILE, 'utf8'));
    const capability = JSON.parse(await fs.readFile(ARTICLE_CAPABILITY_FILE, 'utf8'));
    let executionOption = null;
    if (value.exists) executionOption = await articleController.state(INTAKE_TASK_ID);
    async function lane(name) {
      const configured = capability[name];
      if (!configured || configured.cap !== 2 || configured.windowMs !== 20 * 60_000 || typeof configured.ledgerFile !== 'string') throw new Error(`Article ${name} capability is malformed`);
      let ledger = null;
      try { ledger = JSON.parse(await fs.readFile(configured.ledgerFile, 'utf8')); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const calls = ledger?.calls || [];
      if (!Array.isArray(calls) || calls.length > configured.cap) throw new Error(`Article ${name} ledger is malformed`);
      const running = calls.some((call) => ['reserved', 'running'].includes(call.status));
      const failed = calls.some((call) => ['failed', 'interrupted'].includes(call.status) || call.status === 'completed' && (call.exitCode !== 0 || call.signal));
      const deadlineAt = ledger?.deadlineAt || null, expired = Boolean(deadlineAt && Date.parse(deadlineAt) <= Date.now());
      const roleSlots = configured.mode === 'review_only' ? 1 : configured.cap;
      const remaining = roleSlots - calls.length, sealed = Boolean(ledger?.sealed) || failed;
      const available = Boolean(configured.enabled && !running && !sealed && !expired && remaining > 0);
      const reason = available ? configured.reason : running ? '已有一次模型调用正在运行。' : sealed ? '本批失败或已封存，不会自动重试。' : expired ? '本批20分钟窗口已结束。' : remaining === 0 ? (configured.mode === 'review_only' ? '本批唯一只读Reviewer槽位已用完；不能启动第二次Reviewer。' : '本批两次额度已用完；需要用户显式开启下一批。') : configured.reason;
      return { available, enabled: Boolean(configured.enabled), remaining, deadlineAt, sealed, running, reason, mode: configured.mode || null, maxNativeCalls: roleSlots };
    }
    const development = await lane('development'), learning = await lane('learning');
    return { ...value, draftGoal: project.goalDraft, requirementsStatus: project.requirementsStatus, unsentDraft: project.goalDraft?.statement || '', discussionOnly: false,
      executionSupported: Boolean(executionOption?.authorized && executionOption?.registeredExecution), executionOption,
      workspace: { label: project.title, pathRegistered: true, writable: Boolean(executionOption?.authorized) },
      modelAvailability: { phase: capability.phase,
        discussion: { available: false, enabled: false, remaining: 0, reason: '该真实项目使用已明确需求表单，不消耗旧讨论批次。' },
        execution: development, learning,
        label: `开发/审阅：${development.reason}；学习：${learning.reason}` },
    };
  }
  if (ARTICLE_INTAKE_MODE) return {
    ...value, unsentDraft: ARTICLE_DRAFT, executionSupported: false, executionOption: null,
    discussionOnly: true, workspace: { label: '文章学习项目讨论（空工作区）', pathRegistered: true, writable: false },
    modelAvailability: await modelAvailability(),
  };
  const executionOption = await controller.registeredScopeState(INTAKE_TASK_ID);
  const executionSupported = Boolean(executionOption.authorized && executionOption.current);
  let progress = null;
  if (executionSupported && INTAKE_TASK_ID === TASK_ID) {
    const { projection, task } = await reader.read();
    progress = projectTaskBoard(projection, await readObservations(), task);
  }
  return {
    ...value,
    ...(progress ? { status: progress.status, statusLabel: progress.statusLabel, nextStep: progress.nextStep } : {}),
    executionSupported, executionOption, modelAvailability: await modelAvailability(),
  };
}
function send(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

function boundedProductInputError(value) {
  const redacted = String(value || 'Request failed')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:token|api[_-]?key|secret|password|authorization)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
    .replace(/\/((?:Users|home|private|tmp|var|etc|opt|Volumes))\/[^\s"'`<>]*/g, '[redacted-path]')
    .replace(/\b[A-Za-z]:\\[^\s"'`<>]*/g, '[redacted-path]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
  let message = '', bytes = 0;
  for (const character of redacted) {
    const size = Buffer.byteLength(character);
    if (bytes + size > 300) break;
    message += character; bytes += size;
  }
  return message || 'Request failed';
}

function projectionAuditHeader(req, name, pattern) {
  const value = req.headers[name];
  return typeof value === 'string' && pattern.test(value) ? value : null;
}

function authorityProjectionAudit(req, res) {
  const requestId = projectionAuditHeader(req, 'x-irixi-projection-id', /^[a-f0-9-]{36}$/i);
  const expectedExecutionId = projectionAuditHeader(req, 'x-irixi-execution-id', /^[A-Za-z0-9_-]{1,160}$/);
  const expectedRegistrySha256 = projectionAuditHeader(req, 'x-irixi-registry-sha256', /^[a-f0-9]{64}$/);
  const startedAt = performance.now();
  let phase = 'request_validation';
  let failedPhase = null;
  let errorClass = null;
  let executionId = null;
  let registrySha256 = null;
  let readMs = null;
  let clientClosed = false;
  const emit = (outcome, httpStatus, force = false) => {
    const elapsedMs = Number((performance.now() - startedAt).toFixed(1));
    if (!force && elapsedMs < SLOW_AUTHORITY_PROJECTION_MS && httpStatus !== null && httpStatus < 400) return;
    console.info(`[AuthorityProjection] ${JSON.stringify({
      requestId, taskId: TASK_ID, expectedExecutionId, executionId,
      expectedRegistrySha256, registrySha256, phase: failedPhase || phase,
      outcome, elapsedMs, readMs, httpStatus, errorClass,
    })}`);
  };
  res.once('finish', () => emit('response', res.statusCode));
  res.once('close', () => {
    if (res.writableFinished) return;
    clientClosed = true;
    emit('client_closed', null, true);
  });
  return {
    setPhase(value) { phase = value; },
    recordRead(projection, durationMs) {
      readMs = Number(durationMs.toFixed(1));
      executionId = typeof projection.execution?.id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(projection.execution.id)
        ? projection.execution.id : null;
      registrySha256 = typeof projection.productRegistry?.registrySha256 === 'string'
        && /^[a-f0-9]{64}$/.test(projection.productRegistry.registrySha256) ? projection.productRegistry.registrySha256 : null;
      if (clientClosed) emit('read_completed_after_client_close', null, true);
    },
    fail(error) {
      failedPhase = phase;
      const name = error instanceof Error ? error.name : 'Error';
      errorClass = ['TimeoutError', 'AbortError', 'TypeError', 'SyntaxError'].includes(name) ? name : 'Error';
    },
  };
}

function page(res) {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Irixi integrated toy</title>
<style>body{font:16px system-ui;max-width:780px;margin:2rem auto;padding:0 1rem}pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem}button,input,textarea{font:inherit;margin:.25rem;padding:.5rem}textarea{width:100%;min-height:5rem}.muted{color:#666}.card{border:1px solid #ddd;border-radius:.6rem;padding:1rem;margin:1rem 0}.bad{color:#a21}</style>
<h1>Integrated public toy</h1><p class="muted">Irixi is the authority. OpenOffice executes the explicit task; Agent Office only projects its state.</p>
<section class="card" data-readable-progress><h2 data-current-title>Loading current goal…</h2><p data-current-goal></p><p data-current-status></p><p><strong>下一步：</strong><span data-current-next></span></p></section>
<button data-action="refresh">Refresh</button>
<button data-action="confirm" disabled>Confirm displayed candidate version</button><a data-action="download" hidden>Download confirmed patch</a>
<details><summary>Technical details</summary><pre data-authority-status></pre></details>
<h2>Replace goal</h2><textarea data-goal-statement placeholder="New goal"></textarea><input data-goal-success placeholder="Success criterion"><input data-goal-boundary placeholder="Boundary"><button data-action="replace-goal">Accept complete replacement</button><pre data-action-result></pre>
<script type="module">
const technical=document.querySelector('[data-authority-status]'), result=document.querySelector('[data-action-result]'), confirm=document.querySelector('[data-action="confirm"]'), download=document.querySelector('[data-action="download"]');let current=null;
function fail(message){current=null;document.querySelector('[data-current-title]').textContent='当前状态暂不可用';document.querySelector('[data-current-goal]').textContent='没有启动或确认任何新工作。';document.querySelector('[data-current-status]').textContent=message;document.querySelector('[data-current-status]').className='bad';document.querySelector('[data-current-next]').textContent='检查本地 authority 服务后重试。';confirm.disabled=true;download.hidden=true;technical.textContent=message}
async function refresh(){try{const [a,b]=await Promise.all([fetch('/v1/authority?taskId=${TASK_ID}'),fetch('/v1/task-board?taskId=${TASK_ID}')]);const authority=await a.json(),board=await b.json();if(!a.ok||!b.ok||!authority.projection)throw new Error(authority.error||board.error||'Unable to read current task');current=authority.projection;document.querySelector('[data-current-title]').textContent=board.title;document.querySelector('[data-current-goal]').textContent=board.goalStatement;document.querySelector('[data-current-status]').textContent=board.statusLabel;document.querySelector('[data-current-status]').className=current.current?'':'bad';document.querySelector('[data-current-next]').textContent=board.nextStep;technical.textContent=JSON.stringify({goalVersionId:current.goalVersionId,current:current.current,status:current.status,execution:current.execution,acceptedExecution:current.registeredExecution?{displayPrompt:current.registeredExecution.displayPrompt,promptSha256:current.registeredExecution.promptSha256}:null,artifact:current.artifact},null,2);confirm.disabled=!(current.current&&current.artifact&&current.artifact.review&&current.artifact.review.passed&&!current.artifact.confirmation);if(current.current&&current.artifact&&current.artifact.confirmation){download.hidden=false;download.href='/v1/patch?artifactId='+encodeURIComponent(current.artifact.id)+'&approvalId='+encodeURIComponent(current.artifact.confirmation.approvalId)}else download.hidden=true}catch(error){fail(error instanceof Error?error.message:'Unable to read current task')}}
document.querySelector('[data-action="refresh"]').onclick=refresh;confirm.onclick=async()=>{if(!current?.current||!current.artifact)return fail('Displayed candidate is not current');const r=await fetch('/v1/confirm',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({artifactId:current.artifact.id,version:current.artifact.version})});result.textContent=await r.text();await refresh()};document.querySelector('[data-action="replace-goal"]').onclick=async()=>{const r=await fetch('/v1/goal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({statement:document.querySelector('[data-goal-statement]').value,successCriteria:[document.querySelector('[data-goal-success]').value],boundaries:[document.querySelector('[data-goal-boundary]').value]})});result.textContent=await r.text();await refresh()};refresh();
</script>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html), 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 'cache-control': 'no-store' });
  res.end(html);
}

async function body(req, limit = MAX_BODY) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request is too large'), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function readObservations() {
  const { task } = await reader.read();
  return (task.events || []).filter((entry) => entry.type === 'integration.observation').map((entry) => ({
    id: entry.id, at: entry.at, ...(entry.detail || {}),
  }));
}

async function appendObservation(input) {
  if (!input || !OBSERVATION_TYPES.has(input.type)) throw Object.assign(new Error('Observation type is not allowed'), { status: 400 });
  if (!['lead', 'developer', 'reviewer', 'host', 'user'].includes(input.actor)) throw Object.assign(new Error('Observation actor is invalid'), { status: 400 });
  const actorMatrix = {
    TASK_STARTED: new Set(['lead', 'developer', 'reviewer']), TASK_DONE: new Set(['lead', 'developer', 'reviewer']), TASK_FAILED: new Set(['lead', 'developer', 'reviewer']),
    HOST_CHECKED: new Set(['host']), REVIEW_STARTED: new Set(['reviewer']), REVIEW_DONE: new Set(['reviewer']),
    DISCUSSION: new Set(['user']), CONFIRMED: new Set(['user']),
  };
  if (!actorMatrix[input.type].has(input.actor)) throw Object.assign(new Error('Observation actor does not match its type'), { status: 400 });
  if (typeof input.sourceTaskId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(input.sourceTaskId)) throw Object.assign(new Error('sourceTaskId is invalid'), { status: 400 });
  if (typeof input.sourceEventId !== 'string' || !/^[A-Za-z0-9_.:-]{1,240}$/.test(input.sourceEventId)) throw Object.assign(new Error('sourceEventId is invalid'), { status: 400 });
  if (input.scopeOutcome && !['completed', 'failed', 'discussion', 'later', 'needs_decision'].includes(input.scopeOutcome)) throw Object.assign(new Error('scopeOutcome is invalid'), { status: 400 });
  if (input.type === 'TASK_DONE' && input.actor === 'reviewer') {
    if (typeof input.reviewText !== 'string' || !input.reviewText.trim() || Buffer.byteLength(input.reviewText) > 40_000) throw Object.assign(new Error('Reviewer text is missing or too large'), { status: 400 });
    if (input.resultSha256 !== sha256(input.reviewText)) throw Object.assign(new Error('Reviewer text does not match its result digest'), { status: 400 });
  }
  if (input.type === 'TASK_DONE' && input.actor === 'lead') {
    const hasPlan = typeof input.leadPlanText === 'string';
    const hasExecutionResult = typeof input.leadResultText === 'string';
    const hasConversation = typeof input.conversationText === 'string';
    if ([hasPlan, hasExecutionResult, hasConversation].filter(Boolean).length !== 1) throw Object.assign(new Error('Lead terminal must contain exactly one phase-bound result'), { status: 400 });
    const text = hasPlan ? input.leadPlanText : hasExecutionResult ? input.leadResultText : input.conversationText;
    if (!text.trim() || Buffer.byteLength(text) > 40_000) throw Object.assign(new Error('Lead result text is missing or too large'), { status: 400 });
    if (hasPlan && (!text.startsWith('[PLAN]\n') || !text.trimEnd().endsWith('[/PLAN]'))) {
      throw Object.assign(new Error('Lead plan text is missing or invalid'), { status: 400 });
    }
    if (input.resultSha256 !== sha256(text)) throw Object.assign(new Error('Lead result text does not match its digest'), { status: 400 });
  }
  const recordBody = {
    schemaVersion: 1,
    type: input.type,
    actor: input.actor,
    sourceTaskId: input.sourceTaskId,
    sourceEventId: input.sourceEventId,
    binding: input.binding,
    scopeOutcome: input.scopeOutcome || null,
    resultSha256: input.resultSha256 || null,
    checkId: input.checkId || null,
    caseTotal: Number.isInteger(input.caseTotal) ? input.caseTotal : null,
    casePassed: Number.isInteger(input.casePassed) ? input.casePassed : null,
    changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : null,
    entryFile: typeof input.entryFile === 'string' ? input.entryFile : null,
    nativeAttemptId: typeof input.nativeAttemptId === 'string' ? input.nativeAttemptId : null,
    agentId: typeof input.agentId === 'string' ? input.agentId : null,
    nativeWorkspace: typeof input.nativeWorkspace === 'string' ? input.nativeWorkspace : null,
    reviewText: typeof input.reviewText === 'string' ? input.reviewText : null,
    leadPlanText: typeof input.leadPlanText === 'string' ? input.leadPlanText : null,
    leadResultText: typeof input.leadResultText === 'string' ? input.leadResultText : null,
    conversationText: typeof input.conversationText === 'string' ? input.conversationText : null,
    isFinalResult: input.isFinalResult === true,
    error: typeof input.error === 'string' ? input.error : null,
  };
  if (recordBody.changedFiles && (recordBody.changedFiles.length < 1 || recordBody.changedFiles.length > 8 || recordBody.changedFiles.some((file) => typeof file !== 'string' || !/^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/.test(file)))) throw Object.assign(new Error('changedFiles is invalid'), { status: 400 });
  for (const key of ['resultSha256', 'checkId']) {
    if (recordBody[key] !== null && (typeof recordBody[key] !== 'string' || Buffer.byteLength(recordBody[key]) > 200)) throw Object.assign(new Error(`${key} is invalid`), { status: 400 });
  }
  if (recordBody.error !== null && (input.type !== 'TASK_FAILED' || !recordBody.error
    || /[\u0000-\u001f\u007f]/.test(recordBody.error) || Buffer.byteLength(recordBody.error, 'utf8') > 1_000)) {
    throw Object.assign(new Error('error is invalid'), { status: 400 });
  }
  recordBody.observationFingerprint = fingerprint(recordBody);
  const stored = await reader.appendObservation(recordBody);
  let transition = stored.transition || null;
  if (controller && stored.created && input.type === 'TASK_DONE' && input.actor === 'developer') transition = await controller.hostCheck(TASK_ID);
  if (controller && stored.created && input.type === 'TASK_DONE' && input.actor === 'reviewer') {
    transition = await controller.recordReviewer(TASK_ID, input.sourceTaskId, input.reviewText);
  }
  if (controller && stored.created && input.type === 'TASK_FAILED') transition = await controller.recordNativeFailure(TASK_ID, input.actor, input.sourceTaskId);
  return { record: { id: stored.event.id, at: stored.event.at, ...(stored.event.detail || {}) }, created: stored.created, transition };
}

const server = http.createServer(async (req, res) => {
  let requestPathname = null;
  try {
    if (req.headers.origin && req.headers.origin !== `http://127.0.0.1:${PORT}`) throw Object.assign(new Error('External browser origins are not accepted by the authority bridge'), { status: 403 });
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    requestPathname = url.pathname;
    if (req.method === 'GET' && url.pathname === '/') return page(res);
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, mode: PRODUCT_MODE ? 'irixi-native-product-authority-v1' : 'irixi-authority-read-through-v1', modelCalls: 0 });
    if (req.method === 'GET' && url.pathname === '/v1/intake') {
      if (!intake) return send(res, 404, { error: 'Project intake is not enabled' });
      return send(res, 200, await intakeState());
    }
    if (req.method === 'GET' && url.pathname === '/v1/inference') {
      if (productLearning) return send(res, 200, await productLearning.inferenceStatus(url.searchParams.get('turnId')));
      if (!REAL_ARTICLE_MODE || !intake) return send(res, 404, { error: 'Learning inference is not enabled' });
      return send(res, 200, await intake.inferenceStatus(url.searchParams.get('turnId')));
    }
    if (req.method === 'GET' && url.pathname === '/v1/learning/client-state') {
      if (productLearning) return send(res, 200, await productLearning.productClientState(url.searchParams.get('sessionId'), { scope: url.searchParams.get('scope'), historical: url.searchParams.get('historical') === 'true' }));
      if (!REAL_ARTICLE_MODE || !articleController) return send(res, 404, { error: 'Article client state is not enabled' });
      return send(res, 200, await articleController.clientState(TASK_ID, url.searchParams.get('sessionId'), { scope: url.searchParams.get('scope'), historical: url.searchParams.get('historical') === 'true' }));
    }
    if (req.method === 'GET' && url.pathname === '/v1/authority') {
      const audit = authorityProjectionAudit(req, res);
      try {
        audit.setPhase('task_id_validation');
        if (url.searchParams.get('taskId') !== TASK_ID) return send(res, 404, { error: 'Unknown task' });
        audit.setPhase('task_store_read');
        const readStartedAt = performance.now();
        const { projection, task, taskFileSha256 } = await reader.read();
        audit.recordRead(projection, performance.now() - readStartedAt);
        audit.setPhase('projection_assembly');
        const goal = task && (task.goal?.versions || []).find((entry) => entry.id === task.goal.activeVersionId);
        const repair = task && (task.events || []).findLast((entry) => entry.type === 'integration.repair_batch_authorized' && entry.detail?.executionId === task.execution?.id)?.detail;
        const increment = task && (task.events || []).findLast((entry) => entry.type === 'project.goal_increment_authorized' && entry.detail?.executionId === task.execution?.id)?.detail;
        const development = repair || (increment ? { batchId: increment.batchId, executionId: increment.executionId, repairOfExecutionId: increment.priorExecutionId, priorLedgerSha256: increment.priorLedgerSha256, repairInputManifestSha256: increment.sourceManifestSha256, scopeFingerprint: increment.scopeFingerprint, reviewOnly: false } : null);
        const effectiveRepairBoundary = task && ARTICLE_PROJECT_FILE ? await storageRepair49ReviewBoundary(task,ARTICLE_PROJECT_FILE) || await storageRepair48ReviewBoundary(task,ARTICLE_PROJECT_FILE) || await cleanRepairReviewBoundary(task,ARTICLE_PROJECT_FILE) : null;
        const confirmedContract = goal ? { goalVersionId: goal.id, statement: goal.statement, successCriteria: goal.successCriteria, boundaries: effectiveRepairBoundary ? [...goal.boundaries,effectiveRepairBoundary] : goal.boundaries,
          materialSha256: task.projectWorkspace?.publicContract?.materialSha256 || null,
          developmentBinding: development ? { batchId: development.batchId, executionId: development.executionId, repairOfExecutionId: development.repairOfExecutionId, priorLedgerSha256: development.priorLedgerSha256, repairInputManifestSha256: development.repairInputManifestSha256, scopeFingerprint: development.scopeFingerprint, reviewOnly: development.reviewOnly === true } : null } : null;
        audit.setPhase('response_write');
        return send(res, 200, { projection: { ...projection, confirmedContract }, source: { taskFileSha256 } });
      } catch (error) {
        audit.fail(error);
        throw error;
      }
    }
    if (req.method === 'GET' && url.pathname === '/v1/task-board') {
      if (intake && url.searchParams.get('taskId') === INTAKE_TASK_ID) {
        const value = await intakeState();
        if (value.executionOption?.authorized && value.executionOption?.current && value.executionOption?.execution && INTAKE_TASK_ID === TASK_ID) {
          const { projection, task } = await reader.read();
          return send(res, 200, projectTaskBoard(projection, await readObservations(), task));
        }
        return send(res, 200, {
          taskId: value.taskId, title: value.title, goalStatement: value.goal?.statement || '项目目标尚未确认',
          goalVersionId: value.goal?.id || 'not-confirmed', executionId: null, artifactId: null, artifactVersion: null,
          candidateSha256: null, diffSha256: null, status: value.status, statusLabel: value.statusLabel,
          nextStep: value.nextStep, actor: value.pendingRun ? 'developer' : null, scopeOutcome: value.goal?.confirmed ? 'confirmed_goal_only' : 'discussion',
          confirmed: false, current: true, authoritySha256: value.authoritySha256, pipelineBindingSha256: value.pipelineBindingSha256,
        });
      }
      if (url.searchParams.get('taskId') !== TASK_ID) return send(res, 404, { error: 'Unknown task' });
      const { projection, task } = await reader.read();
      return send(res, 200, projectTaskBoard(projection, await readObservations(), task));
    }
    if (req.method === 'GET' && url.pathname === '/v1/product-registry') {
      if (!PRODUCT_MODE || url.searchParams.get('taskId') !== TASK_ID) return send(res, 404, { error: 'Product authority is not enabled for this task' });
      const { projection } = await reader.read();
      return send(res, 200, { taskId: TASK_ID, productRegistry: projection.productRegistry || null });
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-registry') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      const registered = await reader.registerProductRegistry(await body(req));
      const { projection } = await reader.read();
      return send(res, registered.created ? 201 : 200, { ...registered, productRegistry: projection.productRegistry });
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-agents') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      return send(res, 201, await reader.registerProductAgents(await body(req)));
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-goal') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 200, { goal: await reader.replaceProductGoal(await body(req)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-instructions') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 201, await reader.addProductInstruction(await body(req)));
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-worktree-rebind') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 201, await reader.authorizeProductWorktreeRebind(await body(req)));
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-conversation') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 201, await reader.addProductConversation(await body(req)));
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-materials') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 201, await reader.addProductMaterial(await body(req, 4 * 1024 * 1024)));
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-cancel') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 200, { cancellation: await reader.cancelProductExecution(await body(req)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-pause') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 200, { pause: await reader.pauseProductExecution(await body(req)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-resume') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 201, { resumed: await reader.resumeProductExecution(await body(req)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-lead-plan-recovery') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 201, { recovered: await reader.recoverProductLeadPlan(await body(req, 80_000)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-review-request') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      return send(res, 200, await reader.productReviewRequest(await body(req)));
    }
    if (req.method === 'GET' && url.pathname === '/v1/product-lead-plan') {
      if (!PRODUCT_MODE || url.searchParams.get('taskId') !== TASK_ID) return send(res, 404, { error: 'Current Lead plan is unavailable' });
      const value = await reader.productLeadPlan();
      return send(res, value ? 200 : 404, value || { error: 'Current Lead plan is unavailable' });
    }
    if (req.method === 'GET' && url.pathname === '/v1/product-candidate') {
      if (!PRODUCT_MODE || url.searchParams.get('taskId') !== TASK_ID) return send(res, 404, { error: 'Product candidate is unavailable' });
      return send(res, 200, await reader.productCandidate());
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-preview-authorize') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product preview is unavailable' });
      return send(res, 200, await reader.authorizeProductPreview(await body(req)));
    }
    if (req.method === 'GET' && url.pathname === '/v1/patch') {
      if (PRODUCT_MODE) {
        const result = await reader.exportProductNativePatch(url.searchParams.get('artifactId'), url.searchParams.get('approvalId'));
        res.writeHead(200, { 'content-type': 'text/x-diff; charset=utf-8', 'content-length': result.bytes.length, 'content-disposition': `attachment; filename="${result.filename}"`, 'x-content-sha256': result.sha256, 'cache-control': 'no-store' });
        res.end(result.bytes); return;
      }
      if (!controller || REAL_ARTICLE_MODE) return send(res, 404, { error: 'This project uses confirmed local static preview, not patch export' });
      const result = await controller.exportPatch(TASK_ID, url.searchParams.get('artifactId'), url.searchParams.get('approvalId'));
      res.writeHead(200, { 'content-type': 'text/x-diff; charset=utf-8', 'content-length': result.bytes.length, 'content-disposition': `attachment; filename="${result.filename}"`, 'x-content-sha256': result.sha256, 'cache-control': 'no-store' });
      res.end(result.bytes);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/v1/observations') {
      if (!controller && !PRODUCT_MODE) return send(res, 404, { error: 'This discussion-only intake has no execution observations' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      return send(res, 201, { observation: await appendObservation(await body(req)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/reservations') {
      if (!controller && !PRODUCT_MODE) return send(res, 404, { error: 'This discussion-only intake has no project execution reservations' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      const input = await body(req);
      if (REAL_ARTICLE_MODE && input.actor === 'developer') { await articleController.assertRepairInputCurrent(INTAKE_TASK_ID); await articleController.assertRegisteredExecutionCurrent(INTAKE_TASK_ID); }
      return send(res, 201, { reservation: await reader.reserveRun(input) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/product-native-calls') {
      if (!PRODUCT_MODE) return send(res, 404, { error: 'Product authority is not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      return send(res, 201, { reservation: await reader.reserveProductNativeCall(await body(req)) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/confirm') {
      if (PRODUCT_MODE) return send(res, 200, { approval: await reader.confirmProductNativeArtifact(await body(req)) });
      if (!controller) return send(res, 404, { error: 'This discussion-only intake has no code candidate' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      const input = await body(req);
      return send(res, 200, await controller.confirm(TASK_ID, input.artifactId, input.version));
    }
    if (req.method === 'POST' && url.pathname === '/v1/goal') {
      if (!controller || REAL_ARTICLE_MODE) return send(res, 404, { error: 'Use the intake goal confirmation endpoint' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      return send(res, 200, { goal: await controller.replaceGoal(TASK_ID, await body(req)) });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/inference/')) {
      if (productLearning) {
        if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
        const input = await body(req, PRODUCT_INFERENCE_BODY_BYTES);
        if (url.pathname === '/v1/inference/reservations') return send(res, 201, await productLearning.beginInference(input));
        if (url.pathname === '/v1/inference/native-calls') return send(res, 201, await productLearning.authorizeProductInferenceNativeCall(input));
        if (url.pathname === '/v1/inference/results' || url.pathname === '/v1/inference/failures') {
          await productLearning.recordInference(input);
          return send(res, 201, { saved: true });
        }
        return send(res, 404, { error: 'Product learning inference route is not enabled' });
      }
      if (!REAL_ARTICLE_MODE || !intake) return send(res, 404, { error: 'Learning inference is not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      const input = await body(req);
      if (url.pathname === '/v1/inference/reservations') return send(res, 201, await intake.beginInference(input));
      if (url.pathname === '/v1/inference/results') { await intake.recordInference(input); return send(res, 201, { saved: true }); }
      if (url.pathname === '/v1/inference/failures') { await intake.recordInference(input); return send(res, 201, { saved: true }); }
      if (url.pathname === '/v1/inference/coordinate-sealed-result') return send(res, 201, await intake.coordinateSealedInferenceResult(input));
    }
    if (req.method === 'POST' && url.pathname === '/v1/materials') {
      if (!productLearning && (!REAL_ARTICLE_MODE || !intake)) return send(res, 404, { error: 'Learning materials are not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      return send(res, 201, await (productLearning || intake).registerMaterial(await body(req)));
    }
    if (req.method === 'POST' && url.pathname === '/v1/learning/open-batch') {
      if (!productLearning && (!REAL_ARTICLE_MODE || !articleController)) return send(res, 404, { error: 'Learning batches are not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      const input = await body(req);
      if (productLearning) return send(res, 201, await productLearning.openProductLearningBatch(input));
      return send(res, 201, await articleController.openLearningBatch(TASK_ID, input.expectedGoalVersionId, input.expectedCandidateSha256, input));
    }
    if (req.method === 'POST' && url.pathname === '/v1/preview/authorize') {
      if (!REAL_ARTICLE_MODE || !articleController) return send(res, 404, { error: 'Static preview is not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      return send(res, 200, await articleController.authorizePreview(TASK_ID, (await body(req)).entryFile));
    }
    if (req.method === 'POST' && url.pathname.startsWith('/v1/intake/')) {
      if (!intake) return send(res, 404, { error: 'Project intake is not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      const input = await body(req);
      if (url.pathname === '/v1/intake/messages') {
        if (REAL_ARTICLE_MODE) throw Object.assign(new Error('真实项目使用已登记需求表单；当前不开放旧讨论批次。'), { status: 409 });
        const capability = await modelAvailability();
        if (!capability.discussion.available) throw Object.assign(new Error(`只读澄清当前不可用：${capability.discussion.reason}`), { status: 409 });
        const result = await intake.beginMessage(input);
        return send(res, 201, { ...result, projection: await intakeState() });
      }
      if (url.pathname === '/v1/intake/reservations') {
        if (REAL_ARTICLE_MODE) throw Object.assign(new Error('真实项目使用已登记需求表单；当前不开放旧讨论批次。'), { status: 409 });
        const capability = await modelAvailability();
        if (!capability.discussion.available) throw Object.assign(new Error(`只读澄清当前不可用：${capability.discussion.reason}`), { status: 409 });
        return send(res, 201, { reservation: await intake.reserveRun(input) });
      }
      if (url.pathname === '/v1/intake/replies') { await intake.recordReply(input); return send(res, 201, await intakeState()); }
      if (url.pathname === '/v1/intake/failures') { await intake.recordFailure(input); return send(res, 201, await intakeState()); }
      if (url.pathname === '/v1/intake/confirm') { if (REAL_ARTICLE_MODE) { await intake.ensureTask(); await articleController.confirmGoal(INTAKE_TASK_ID, input); } else await intake.confirmGoal(input); return send(res, 200, await intakeState()); }
      if (url.pathname === '/v1/intake/open-discussion') return send(res, 200, { ...await intakeState(), modelAvailability: await writeArticleCapabilityEnabled(true) });
      if (url.pathname === '/v1/intake/close-discussion') return send(res, 200, { ...await intakeState(), modelAvailability: await writeArticleCapabilityEnabled(false) });
      if (!controller) return send(res, 404, { error: 'This discussion-only intake has no execution scope' });
      if (url.pathname === '/v1/intake/select-scope') { if (REAL_ARTICLE_MODE) return send(res, 200, await intakeState()); await controller.selectRegisteredScope(INTAKE_TASK_ID, input.expectedGoalVersionId); return send(res, 200, await intakeState()); }
      if (url.pathname === '/v1/intake/authorize-scope') { if (REAL_ARTICLE_MODE) await articleController.authorize(INTAKE_TASK_ID, input.expectedGoalVersionId); else await controller.authorizeRegisteredScope(INTAKE_TASK_ID, input.expectedGoalVersionId); return send(res, 200, await intakeState()); }
      if (url.pathname === '/v1/intake/authorize-goal-increment') {
        if (!REAL_ARTICLE_MODE || !articleController) return send(res, 404, { error: 'Article goal increments are not enabled' });
        return send(res, 201, await articleController.authorizeGoalIncrement(INTAKE_TASK_ID, input));
      }
      if (url.pathname === '/v1/intake/open-repair-batch') {
        if (!REAL_ARTICLE_MODE || !articleController) return send(res, 404, { error: 'Article repair batches are not enabled' });
        return send(res, 201, await articleController.openRepairBatch(INTAKE_TASK_ID, input));
      }
      if (url.pathname === '/v1/intake/prepare-clean-repair-input') {
        if (!REAL_ARTICLE_MODE || !articleController) return send(res,404,{error:'Article clean input preparation is not enabled'});
        return send(res,201,await articleController.prepareCleanRepairInput(INTAKE_TASK_ID,input));
      }
      if (url.pathname === '/v1/intake/validate-clean-repair-input') {
        if (!REAL_ARTICLE_MODE || !articleController) return send(res,404,{error:'Article clean input preparation is not enabled'});
        return send(res,200,await articleController.validateCleanRepairInput(INTAKE_TASK_ID,input));
      }
      if (url.pathname === '/v1/intake/open-clean-repair-batch') {
        if (!REAL_ARTICLE_MODE || !articleController) return send(res,404,{error:'Article clean repair batches are not enabled'});
        return send(res,201,await articleController.openCleanRepairBatch(INTAKE_TASK_ID,input));
      }
      if (url.pathname === '/v1/intake/host-client-failure') {
        if (!REAL_ARTICLE_MODE || !articleController) return send(res, 404, { error: 'Article host client checks are not enabled' });
        return send(res, 201, await articleController.recordHostClientFailure(INTAKE_TASK_ID, input));
      }
      if (url.pathname === '/v1/intake/auto-review-dispatch-failure') {
        if (!REAL_ARTICLE_MODE || !articleController) return send(res, 404, { error: 'Article automatic review dispatch coordination is not enabled' });
        return send(res, 201, await articleController.recordAutoReviewDispatchFailure(INTAKE_TASK_ID, input));
      }
      if (url.pathname === '/v1/intake/coordinate-sealed-reviewer-result') {
        if (!REAL_ARTICLE_MODE || !articleController) return send(res, 404, { error: 'Article sealed review coordination is not enabled' });
        return send(res, 201, await articleController.coordinateSealedReviewerResult(INTAKE_TASK_ID, input));
      }
      if (url.pathname === '/v1/intake/start-new-batch') {
        if (REAL_ARTICLE_MODE) throw Object.assign(new Error('真实项目不允许通过旧入口重置批次。'), { status: 409 });
        const capability = await modelAvailability();
        if (capability.execution.mode === 'review_only') throw Object.assign(new Error('当前批次仅允许审阅已保存候选，不能启动 Developer 或新执行。'), { status: 409 });
        if (!capability.execution.available) throw Object.assign(new Error(`执行/审阅模型当前不可用：${capability.execution.reason}`), { status: 409 });
        await controller.startNewRegisteredExecution(INTAKE_TASK_ID, input.expectedGoalVersionId);
        return send(res, 200, await intakeState());
      }
    }
    if (req.method === 'PUT' && url.pathname === '/v1/learning/client-state') {
      if (productLearning) return send(res, 200, await productLearning.saveProductClientState(await body(req)));
      if (!REAL_ARTICLE_MODE || !articleController) return send(res, 404, { error: 'Article client state is not enabled' });
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) return send(res, 415, { error: 'Content-Type must be application/json' });
      return send(res, 200, await articleController.saveClientState(TASK_ID, await body(req)));
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = Number(error?.status) || 409;
    const message = error instanceof Error ? error.message : 'Request failed';
    if (req.method === 'POST' && ['/v1/product-goal', '/v1/product-instructions', '/v1/product-materials', '/v1/product-conversation'].includes(requestPathname)) {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code) ? error.code : null;
      return send(res, status, { ...(code ? { code } : {}), error: boundedProductInputError(message) });
    }
    return send(res, status, { error: message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[IrixiAuthority] listening on http://127.0.0.1:${PORT}; task=${TASK_ID}; state=${path.relative(TRIAL_ROOT, STATE_ROOT)}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
