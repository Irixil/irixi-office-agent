#!/usr/bin/env node
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createProductBootstrapController, confirmedLearningPreviewSourceMatches } from './product-bootstrap-controller.mjs';
import { createTrustedProductProjects } from './trusted-product-projects.mjs';

const root = process.env.IRIXI_DESKTOP_ROOT;
const port = Number(process.env.IRIXI_DESKTOP_PORT || 3847);
function configuredLoopbackOrigin(value, name) {
  const url = new URL(value);
  const configuredPort = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !Number.isInteger(configuredPort) || configuredPort < 1024 || configuredPort > 65535) {
    throw new Error(`${name} must be a plain HTTP 127.0.0.1 origin on a non-privileged port.`);
  }
  return new URL(`http://127.0.0.1:${configuredPort}/`);
}
const native = configuredLoopbackOrigin(process.env.IRIXI_NATIVE_URL || 'http://127.0.0.1:9109/', 'IRIXI_NATIVE_URL');
const authority = configuredLoopbackOrigin(process.env.IRIXI_PRODUCT_AUTHORITY_URL || 'http://127.0.0.1:3869/', 'IRIXI_PRODUCT_AUTHORITY_URL');
const agentOfficePort = Number(process.env.IRIXI_AGENT_OFFICE_PORT || 3029);
const scenePort = Number(process.env.IRIXI_SCENE_PORT || 5189);
const tasksRoot = process.env.IRIXI_AUTHORITY_TASKS_ROOT;
const aiEnabled = process.env.IRIXI_PRODUCT_ENABLE_AI === '1';
assert.ok(root && path.isAbsolute(root));
assert.equal(await fsp.realpath(root), root);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(Number.isInteger(agentOfficePort) && agentOfficePort >= 1024 && agentOfficePort <= 65535);
assert.ok(Number.isInteger(scenePort) && scenePort >= 1024 && scenePort <= 65535);
const configuredPorts = [port, Number(authority.port), Number(native.port), agentOfficePort, scenePort];
assert.equal(new Set(configuredPorts).size, configuredPorts.length, 'Desktop and managed service ports must be distinct');
assert.ok(tasksRoot && path.isAbsolute(tasksRoot));
const canonicalTasksRoot = await fsp.realpath(tasksRoot);
const irixiAppRoot = await fsp.realpath(path.join(root, 'app'));
const projectCatalogueFile = path.resolve(process.env.IRIXI_PRODUCT_PROJECT_CATALOG_FILE
  || path.join(import.meta.dirname, 'registered-projects.local.json'));
const trustedProjects = await createTrustedProductProjects({ file: projectCatalogueFile, authorityUrl: authority.href });
const tasksRootKey = crypto.createHash('sha256').update(canonicalTasksRoot).digest('hex').slice(0, 16);
const bindingFile = path.resolve(process.env.IRIXI_PRODUCT_BINDING_FILE || path.join(import.meta.dirname, 'runtime', `active-product-task-${tasksRootKey}.json`));
if (!bindingFile.startsWith(`${path.resolve(import.meta.dirname)}${path.sep}`)) throw new Error('Product binding file must stay inside the product directory');
await fsp.mkdir(path.dirname(bindingFile), { recursive: true });
let activeTaskId = process.env.IRIXI_AUTHORITY_TASK_ID || null;
if (!activeTaskId) {
  try { const saved = JSON.parse(await fsp.readFile(bindingFile, 'utf8')); if (/^[A-Za-z0-9_-]{1,160}$/.test(saved?.taskId || '')) activeTaskId = saved.taskId; }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
}
async function saveActiveTask(taskId) {
  const temporary = `${bindingFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, taskId })}\n`, { flag: 'wx', mode: 0o600 });
  await fsp.rename(temporary, bindingFile);
}
let nativeRuntime = null;
let memoryAuthority = null;
async function stopMemoryAuthority() {
  const runtime = memoryAuthority;
  if (!runtime) return;
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
    runtime.child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { runtime.child.removeListener('exit', onExit); resolve(); }, 5_000);
      const onExit = () => { clearTimeout(timer); resolve(); };
      runtime.child.once('exit', onExit);
    });
  }
  if (runtime.child.exitCode === null && runtime.child.signalCode === null) runtime.child.kill('SIGKILL');
  if (memoryAuthority?.child === runtime.child) memoryAuthority = null;
}
async function stopNativeRuntime() {
  const runtime = nativeRuntime;
  if (!runtime) return;
  const running = () => runtime.child.exitCode === null && runtime.child.signalCode === null;
  const waitForExit = (timeoutMs) => running() ? Promise.race([
    new Promise((resolve) => runtime.child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]) : Promise.resolve();
  if (running()) {
    runtime.child.kill('SIGTERM');
    // The nested launcher owns several detached process groups and may need its
    // full graceful window to reap them before this direct child exits.
    await waitForExit(12_000);
  }
  if (running()) {
    runtime.child.kill('SIGKILL');
    await waitForExit(2_000);
  }
  if (running()) throw Object.assign(new Error('Managed native runtime did not stop before the task mutation'), { status: 503 });
  if (nativeRuntime?.child === runtime.child) nativeRuntime = null;
}
async function startMemoryAuthority(taskId) {
  if (memoryAuthority?.taskId === taskId && memoryAuthority.child.exitCode === null && memoryAuthority.child.signalCode === null) return;
  await stopMemoryAuthority();
  const child = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'authority', 'server.mjs')], {
    cwd: path.join(import.meta.dirname, '..'),
    env: { ...process.env, IRIXI_PRODUCT_AUTHORITY: '1', IRIXI_AUTHORITY_PORT: authority.port || '3869',
      IRIXI_AUTHORITY_TASKS_ROOT: canonicalTasksRoot, IRIXI_AUTHORITY_TASK_ID: taskId, IRIXI_APP_ROOT: irixiAppRoot,
      IRIXI_INTEGRATION_STATE_ROOT: path.join(import.meta.dirname, 'runtime', 'memory-authority', tasksRootKey) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  memoryAuthority = { taskId, child };
  child.once('exit', () => { if (memoryAuthority?.child === child) memoryAuthority = null; });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2_000); });
  try {
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Authority writer exited before readiness.');
      try {
        const response = await fetch(new URL('health', authority), { signal: AbortSignal.timeout(500) });
        const value = response.ok ? await response.json() : null;
        ready = value?.ok === true && value?.mode === 'irixi-native-product-authority-v1';
      } catch {}
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error('Authority writer did not become ready.');
  } catch (error) {
    await stopMemoryAuthority();
    throw publicError('PRODUCT_AUTHORITY_UNAVAILABLE', `The current Authority writer could not start${stderr ? `: ${stderr.trim()}` : '.'}`, 503);
  }
}
async function writeRuntimePolicy(taskId, projectId) {
  const directory = path.join(import.meta.dirname, 'runtime', taskId);
  await fsp.mkdir(directory, { recursive: true });
  const file = path.join(directory, 'trusted-runtime-policy.json');
  const bytes = `${JSON.stringify(await trustedProjects.runtimePolicy(projectId), null, 2)}\n`;
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
  await fsp.rename(temporary, file);
  return { file, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
async function startNativeRuntime(taskId, policyFile) {
  if (nativeRuntime && nativeRuntime.taskId !== taskId) throw Object.assign(new Error('Another native product task owns this setup process'), { status: 409 });
  if (nativeRuntime?.child.exitCode === null && nativeRuntime.child.signalCode === null) return nativeRuntime;
  const args = [path.join(import.meta.dirname, 'start-product.mjs'), '--registry', policyFile, '--tasks-root', canonicalTasksRoot,
    '--task', taskId, '--desktop-root', root, '--native-only', '--managed-registry',
    '--authority-port', authority.port, '--openoffice-port', native.port,
    '--agent-office-port', String(agentOfficePort), '--scene-port', String(scenePort)];
  args.push(process.env.IRIXI_PRODUCT_ENABLE_AI === '1' ? '--enable-ai' : '--zero-model');
  const child = spawn(process.execPath, args, { cwd: import.meta.dirname, env: process.env, stdio: ['inherit', 'pipe', 'pipe'] });
  nativeRuntime = { taskId, child };
  child.once('exit', () => { if (nativeRuntime?.child === child) nativeRuntime = null; });
  let buffered = '';
  const ready = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      process.stdout.write(chunk);
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n'); buffered = lines.pop() || '';
      for (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value?.allStartedServicesReady === true && value?.taskId === taskId) resolve(value);
        } catch {}
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    child.once('exit', (code, signal) => reject(new Error(`Native product launcher exited before readiness (${code ?? signal ?? 'unknown'})`)));
  });
  let timer;
  try {
    const value = await Promise.race([ready, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native product runtime did not become ready')), 60_000);
    })]);
    nativeRuntime.ready = value;
    return nativeRuntime;
  } catch (error) {
    await stopNativeRuntime();
    throw Object.assign(error, { status: 503 });
  } finally { if (timer) clearTimeout(timer); }
}
const memoryModule = await import(pathToFileURL(path.join(root, 'app/memory.mjs')).href);
const configuredXerjUrl = new URL(process.env.IRIXI_XERJ_URL || 'http://127.0.0.1:19200');
if (configuredXerjUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(configuredXerjUrl.hostname)
  || configuredXerjUrl.username || configuredXerjUrl.password || configuredXerjUrl.pathname !== '/' || configuredXerjUrl.search || configuredXerjUrl.hash) {
  throw new Error('IRIXI_XERJ_URL must be a plain loopback HTTP origin.');
}
const memoryIndex = memoryModule.createXerjMemoryIndex({ projectRoot: root, baseUrl: configuredXerjUrl.href });
const bootstrap = await createProductBootstrapController({ tasksRoot: canonicalTasksRoot, irixiAppRoot,
  projectCatalog: trustedProjects.listPublic, projectAuthorization: trustedProjects.current, memoryIndex });
const publicRoot = await fsp.realpath(path.join(root, 'app/public'));
const artRoot = await fsp.realpath(path.join(root, 'art'));
const vendor = {
  '/vendor/phaser.min.js': await fsp.realpath(path.join(root, 'node_modules/phaser/dist/phaser.min.js')),
  '/vendor/easystar.min.js': await fsp.realpath(path.join(root, 'node_modules/easystarjs/bin/easystar-0.4.4.min.js')),
};
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8' };
const irixiLearningApiPaths = [
  '/api/irixi-client-state', '/api/irixi-inference', '/api/irixi-intake', '/api/irixi-materials', '/api/irixi-learning/open-batch',
];
const isIrixiLearningApi = (pathname) => irixiLearningApiPaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
const requestBodies = new WeakMap();
const requestJsonBodies = new WeakMap();
function publicError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status, public: true });
}
function sendFailure(res, status, code, message, details = null) {
  const reason = { code, message, ...(details || {}) };
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: false, reason, error: reason }));
}
function boundedAuthorityMessage(value) {
  if (typeof value !== 'string') return null;
  const redacted = value
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
  return message || null;
}
function authorityRejectionDetails(bytes, stage) {
  const details = {
    authorityStage: stage,
    authorityResponseSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    const code = body?.code || body?.errorCode || body?.reason?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code)) details.authorityCode = code;
    const message = boundedAuthorityMessage(body?.error || body?.message);
    if (message) details.authorityMessage = message;
  } catch {}
  return details;
}
const setupPublicState = (value) => ({ ...value, mode: 'product_setup', aiEnabled,
  native: { aiEnabled, runAgentId: null, sessions: [], actions: {
    canRun: false, canReview: false, canInspectDiff: false, canRevise: false, canConfirm: false, canPreview: false,
    canCancel: false, canPause: false, canResume: false, canContinue: false, canChat: false,
    canGoal: Boolean(value.task), canInstructions: Boolean(value.task), canMaterials: Boolean(value.task),
    canScope: Boolean(value.task) && value.status === 'waiting_scope',
    canAuthorizeScope: value.status === 'waiting_scope_authorization' && value.setup?.selectedScope?.current === true,
    canPrepareRun: value.canPrepareRun === true, canReconnect: value.canReconnect === true,
    blockedReason: value.blockedReason || (value.task ? 'registered_project_scope_required' : 'task_required'),
  } } });
const readBody = (req) => {
  let pending = requestBodies.get(req);
  if (!pending) {
    pending = (async () => {
      const chunks = []; let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) throw publicError('REQUEST_BODY_TOO_LARGE', 'Request body exceeds the 4 MiB product input limit.', 413);
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    })();
    requestBodies.set(req, pending);
  }
  return pending;
};
const readJsonBody = (req) => {
  let pending = requestJsonBodies.get(req);
  if (!pending) {
    pending = readBody(req).then((bytes) => {
      if (!bytes.length) throw publicError('REQUEST_JSON_REQUIRED', 'A JSON request body is required.', 400);
      try {
        const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw publicError('REQUEST_JSON_OBJECT_REQUIRED', 'Request body must be a JSON object.', 400);
        }
        return value;
      } catch (error) {
        if (error?.public === true) throw error;
        throw publicError('REQUEST_JSON_INVALID', 'Request body must be valid UTF-8 JSON.', 400);
      }
    });
    requestJsonBodies.set(req, pending);
  }
  return pending;
};
async function proxy(req, res, { transform = null } = {}) {
  if (!['GET', 'HEAD'].includes(req.method || '') && req.headers.origin) {
    const origin = new URL(req.headers.origin);
    if (origin.host !== req.headers.host) throw new Error('Cross-origin product mutation is forbidden');
  }
  const body = ['GET', 'HEAD'].includes(req.method || '') ? undefined : await readBody(req);
  const response = await fetch(new URL(req.url, native), { method: req.method, body,
    headers: { accept: String(req.headers.accept || '*/*'), 'content-type': String(req.headers['content-type'] || 'application/json'), origin: native.origin }, signal: AbortSignal.timeout(10_000) });
  let bytes = Buffer.from(await response.arrayBuffer());
  if (transform && (response.headers.get('content-type') || '').includes('application/json')) {
    try { bytes = Buffer.from(JSON.stringify(transform(JSON.parse(bytes.toString('utf8'))))); }
    catch { /* Keep the native response byte-identical if the optional projection cannot be decorated. */ }
  }
  const headers = { 'cache-control': 'no-store', 'content-type': response.headers.get('content-type') || 'application/octet-stream' };
  for (const name of ['content-disposition', 'x-content-sha256']) { const value = response.headers.get(name); if (value) headers[name] = value; }
  res.writeHead(response.status, headers); res.end(bytes);
}
function networkErrorCode(error) {
  let cursor = error;
  while (cursor) { if (typeof cursor.code === 'string') return cursor.code; cursor = cursor.cause; }
  return null;
}
async function authorityInputMutation(res, taskId, input) {
  const endpoint = { goal: 'v1/product-goal', support: 'v1/product-instructions', material: 'v1/product-materials', converse: 'v1/product-conversation',
    memory_save: 'v1/product-memory/save', memory_change: 'v1/product-memory/change' }[input.action];
  assert.ok(endpoint, 'Unsupported authority input mutation');
  try {
    const projectionResponse = await fetch(new URL(`v1/authority?taskId=${encodeURIComponent(taskId)}`, authority), {
      signal: AbortSignal.timeout(2_000), headers: { accept: 'application/json' },
    });
    const projectionBytes = Buffer.from(await projectionResponse.arrayBuffer());
    let taskBoundByAuthority = false;
    if (!projectionResponse.ok) {
      let failedProjection;
      try { failedProjection = JSON.parse(projectionBytes.toString('utf8')); } catch {}
      if (['memory_save', 'memory_change'].includes(input.action) && failedProjection?.taskId === taskId) {
        // The Authority has positively identified this task; global memory may be written before project scope exists.
        taskBoundByAuthority = true;
      } else {
        if (projectionResponse.status === 404) {
          if (failedProjection && typeof failedProjection === 'object' && !Array.isArray(failedProjection)
            && JSON.stringify(Object.keys(failedProjection).sort()) === JSON.stringify(['error'])
            && failedProjection.error === 'Unknown task') return 'refused';
        }
        sendFailure(res, projectionResponse.status, 'PRODUCT_AUTHORITY_REJECTED', 'The current Irixi authority rejected this task input update.',
          authorityRejectionDetails(projectionBytes, 'projection'));
        return 'handled';
      }
    }
    if (!taskBoundByAuthority) {
      let projection;
      try { projection = JSON.parse(projectionBytes.toString('utf8'))?.projection; }
      catch { throw publicError('PRODUCT_AUTHORITY_INVALID', 'The current Irixi authority returned an invalid task projection.', 503); }
      if (projection?.taskId !== taskId) throw publicError('PRODUCT_AUTHORITY_BINDING_MISMATCH', 'The current Irixi authority is bound to a different product task.', 409);
    }
    const body = structuredClone(input); delete body.action;
    const response = await fetch(new URL(endpoint, authority), { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { accept: 'application/json', 'content-type': 'application/json', origin: authority.origin }, body: JSON.stringify(body) });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      sendFailure(res, response.status, 'PRODUCT_AUTHORITY_REJECTED', 'The current Irixi authority rejected this task input update.',
        authorityRejectionDetails(bytes, 'mutation'));
      return 'handled';
    }
    let value;
    try { value = JSON.parse(bytes.toString('utf8')); }
    catch { throw publicError('PRODUCT_AUTHORITY_INVALID', 'The current Irixi authority returned an invalid mutation result.', 503); }
    res.writeHead(response.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ accepted: true, action: input.action, ...value })); return 'handled';
  } catch (error) {
    if (networkErrorCode(error) === 'ECONNREFUSED') return 'refused';
    if (error?.public === true) throw error;
    throw publicError('PRODUCT_AUTHORITY_UNAVAILABLE', 'The current Irixi authority did not complete the task input update.', 503);
  }
}
async function currentExpiredResultProjection(taskId, setup, { confirmedOnly = false } = {}) {
  if (setup?.blockedReason !== 'explicit_new_run_required') return null;
  try {
    const response = await fetch(new URL(`v1/authority?taskId=${encodeURIComponent(taskId)}`, authority), {
      signal: AbortSignal.timeout(2_000), headers: { accept: 'application/json' },
    });
    const projection = response.ok ? (await response.json()).projection : null;
    const scope = setup.setup?.selectedScope;
    const registrySha256 = setup.registry?.registrySha256;
    const artifact = projection?.artifact;
    const actions = projection?.native?.actions;
    const hasArtifactCapability = actions?.canPreview === true || actions?.canInspectDiff === true
      || actions?.canReview === true || actions?.canConfirm === true;
    const current = projection?.taskId === taskId && projection.current === true
      && projection.goalVersionId === setup.task?.goalVersionId
      && projection.execution?.id === setup.execution?.id
      && projection.productRegistry?.current === true
      && projection.productRegistry.registrySha256 === registrySha256
      && projection.workspace?.current === true && scope?.current === true
      && projection.workspace.scopeFingerprint === scope.scopeFingerprint
      && projection.native?.bindingCurrent === true && projection.native.registrySha256 === registrySha256
      && artifact?.goalVersionId === projection.goalVersionId
      && artifact.nativeCandidate === true && ['candidate', 'confirmed'].includes(artifact.status)
      && typeof artifact.id === 'string' && Number.isInteger(artifact.version)
      && typeof artifact.candidateSha256 === 'string' && hasArtifactCapability;
    if (!current || (confirmedOnly && (artifact.status !== 'confirmed'
      || !artifact.confirmation?.approvalId || actions.canPreview !== true))) return null;
    return projection;
  } catch { return null; }
}
function currentLearningPreviewUrl(value, taskId) {
  const preview = value?.preview, artifact = value?.artifact;
  const url = value?.previewLink || value?.links?.preview;
  if (value?.taskId !== taskId || value?.current !== true || value?.native?.bindingCurrent !== true
    || preview?.status !== 'ready' || preview.taskId !== taskId || preview.goalVersionId !== value.goalVersionId
    || preview.executionId !== value.execution?.id || preview.registrySha256 !== value.product?.registrySha256
    || preview.artifactId !== artifact?.id || preview.artifactVersion !== artifact?.version
    || preview.candidateSha256 !== artifact?.candidateSha256
    || !value.product?.capabilities?.staticPreviewEntries?.includes(preview.entry)
    || !value.product?.capabilities?.staticPreviewFiles?.includes(preview.entry)
    || typeof url !== 'string' || !url.startsWith('/product-preview/')) return null;
  return url;
}
function confirmedLearningPreviewSourceIsCurrent(value, result) {
  const expected = { taskId: result.taskId, projectId: result.projectId,
    goalVersionId: result.reuseInput.expectedGoalVersionId, executionId: result.reuseInput.expectedExecutionId,
    registrySha256: result.reuseInput.expectedRegistrySha256, artifactId: result.reuseInput.expectedArtifactId,
    artifactVersion: result.reuseInput.expectedArtifactVersion, candidateSha256: result.reuseInput.expectedCandidateSha256 };
  return confirmedLearningPreviewSourceMatches(value, expected);
}
function currentConfirmedLearningPreviewUrl(value, result) {
  return confirmedLearningPreviewSourceIsCurrent(value, result) ? currentLearningPreviewUrl(value, result.taskId) : null;
}
async function readLearningNativeState(taskId) {
  const response = await fetch(new URL('/api/product-state', native), {
    signal: AbortSignal.timeout(3_000), headers: { accept: 'application/json' },
  });
  if (!response.ok) return null;
  const value = await response.json();
  return value?.taskId === taskId ? value : null;
}
async function createLearningPreview(taskId, expected) {
  const response = await fetch(new URL(`/api/product/tasks/${encodeURIComponent(taskId)}/actions`, native), {
    method: 'POST', signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', 'content-type': 'application/json', origin: native.origin },
    body: JSON.stringify({ action: 'preview', expectedGoalVersionId: expected.goalVersionId,
      expectedExecutionId: expected.executionId, expectedRegistrySha256: expected.registrySha256,
      expectedArtifactId: expected.artifact.id, expectedArtifactVersion: expected.artifact.version,
      expectedCandidateSha256: expected.artifact.candidateSha256, entry: 'index.html' }),
  });
  if (!response.ok) throw publicError('LEARNING_PREVIEW_REJECTED', 'The current confirmed learning result did not accept its bound preview request.', 409);
}
async function staticFile(urlPath) {
  if (vendor[urlPath]) return vendor[urlPath];
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const base = decoded.startsWith('/assets/') ? artRoot : publicRoot;
  const relative = decoded === '/' ? 'index.html' : decoded.startsWith('/assets/') ? decoded.slice('/assets/'.length) : decoded.slice(1);
  const candidate = path.resolve(base, relative);
  if (candidate !== base && !candidate.startsWith(`${base}${path.sep}`)) throw new Error('Forbidden');
  const real = await fsp.realpath(candidate);
  if (real !== base && !real.startsWith(`${base}${path.sep}`)) throw new Error('Forbidden');
  return real;
}
const server = http.createServer(async (req, res) => {
  try {
    const incoming = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${port}`}`);
    const productApiRequest = incoming.pathname.startsWith('/api/product') || incoming.pathname.startsWith('/api/irixi-authority')
      || isIrixiLearningApi(incoming.pathname);
    if (productApiRequest && req.headers.origin) {
      const origin = new URL(req.headers.origin);
      if (origin.host !== req.headers.host) throw publicError('CROSS_ORIGIN_FORBIDDEN', 'Cross-origin product access is forbidden.', 403);
    }
    const assertProductMutation = () => {
      if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) throw publicError('CONTENT_TYPE_INVALID', 'Content-Type must be application/json.', 415);
      if (req.headers.origin) { const origin = new URL(req.headers.origin); if (origin.host !== req.headers.host) throw publicError('CROSS_ORIGIN_FORBIDDEN', 'Cross-origin product mutation is forbidden.', 403); }
    };
    if (req.method === 'GET' && incoming.pathname === '/api/product-health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, mode: activeTaskId ? 'native_product_or_setup' : 'waiting_task', aiEnabled })); return;
    }
    if (req.method === 'POST' && incoming.pathname === '/api/product/tasks') {
      assertProductMutation();
      const input = await readJsonBody(req);
      const value = await bootstrap.createTask(input);
      if (!value.created || !value.task?.id) {
        const reason = {
          code: /^[A-Z][A-Z0-9_]{2,63}$/.test(value.reason?.code || '') ? value.reason.code : 'TASK_INPUT_INVALID',
          message: typeof value.reason?.message === 'string' && value.reason.message.length <= 300
            ? value.reason.message : 'The task request was rejected.',
        };
        res.writeHead(reason.code === 'TASK_INPUT_OUT_OF_RANGE' ? 413 : 400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: false, created: false, task: null, status: 'rejected', execution: null, registry: null,
          reason, error: reason })); return;
      }
      await stopNativeRuntime();
      await stopMemoryAuthority();
      activeTaskId = value.task.id;
      await saveActiveTask(activeTaskId);
      res.writeHead(201, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); return;
    }
    if (req.method === 'GET' && incoming.pathname === '/api/product/projects') {
      const value = await bootstrap.listRegisteredProjects();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ projects: value })); return;
    }
    if (req.method === 'GET' && incoming.pathname === '/api/product/learning-entry') {
      const taskId = incoming.searchParams.get('taskId');
      if (!taskId || activeTaskId !== taskId) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ available: false, status: 'unavailable' })); return;
      }
      const result = await bootstrap.findCurrentConfirmedResult('sample-article-project');
      if (!result || result.taskId !== taskId) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ available: false, status: 'unavailable' })); return;
      }
      const value = await readLearningNativeState(taskId);
      const url = currentConfirmedLearningPreviewUrl(value, result);
      if (url) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ available: true, status: 'ready', url, view: 'learn' })); return;
      }
      if (confirmedLearningPreviewSourceIsCurrent(value, result)) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ available: true, status: 'preview_pending' })); return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ available: false, status: 'unavailable' })); return;
    }
    if (req.method === 'POST' && incoming.pathname === '/api/product/learning-entry/open') {
      assertProductMutation();
      const input = await readJsonBody(req);
      if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['view'])
        || !['learn', 'records'].includes(input.view)) {
        throw publicError('LEARNING_ENTRY_INPUT_INVALID', 'Choose the learning page or its saved-records entry.', 400);
      }
      const result = await bootstrap.findCurrentConfirmedResult('sample-article-project');
      if (!result) throw publicError('LEARNING_RESULT_UNAVAILABLE', 'No current confirmed article-learning result is available.', 404);
      if (activeTaskId && activeTaskId !== result.taskId) {
        const current = await bootstrap.taskSwitchState(activeTaskId);
        if (current?.inFlight) {
          sendFailure(res, 409, 'LEARNING_ENTRY_BUSY', `“${current.title}”仍有工作在途；不会切换或取消它。请先回到当前工作并让它到达安全停点，再点学习同事。`, {
            recoveryUrl: `/native?taskId=${encodeURIComponent(current.taskId)}`,
          }); return;
        }
      }
      let currentValue = null;
      try { if (activeTaskId === result.taskId) currentValue = await readLearningNativeState(result.taskId); } catch {}
      if (!currentValue) {
        if (!result.canReuseCurrentResult) {
          const recoveryUrl = `/native?taskId=${encodeURIComponent(result.taskId)}`;
          sendFailure(res, 409, 'LEARNING_RESULT_RECOVERY_REQUIRED', '学习成果仍保留，但当前状态不能安全地复用原确认结果；请先打开原生任务核对恢复状态。没有启动新轮。', { recoveryUrl }); return;
        }
        const prepared = await bootstrap.prepareRun(result.taskId, result.reuseInput);
        if (prepared?.prepared?.reused !== true || prepared.prepared.reuseCurrentResult !== true
          || prepared.prepared.executionId !== result.reuseInput.expectedExecutionId) {
          throw publicError('LEARNING_RESULT_RECOVERY_MISMATCH', '原确认结果没有按原执行绑定恢复；未启动新的模型工作。', 409);
        }
        const policy = await writeRuntimePolicy(result.taskId, result.projectId);
        await stopNativeRuntime();
        const runtime = await startNativeRuntime(result.taskId, policy.file);
        if (runtime.ready?.taskId !== result.taskId || runtime.ready?.modelCalls !== 0
          || runtime.ready?.allStartedServicesReady !== true) {
          throw publicError('LEARNING_RUNTIME_NOT_READY', '原文章学习结果已保留，但本机后台未确认零模型恢复就绪。', 503);
        }
        const setup = await bootstrap.state(result.taskId);
        const currentResult = await currentExpiredResultProjection(result.taskId, setup, { confirmedOnly: true });
        if (!currentResult || currentResult.execution?.id !== result.reuseInput.expectedExecutionId
          || currentResult.artifact?.id !== result.reuseInput.expectedArtifactId
          || currentResult.artifact?.candidateSha256 !== result.reuseInput.expectedCandidateSha256) {
          throw publicError('LEARNING_RESULT_RECOVERY_MISMATCH', '恢复后的目标、登记或已确认候选与原结果不一致。', 409);
        }
        activeTaskId = result.taskId;
        await saveActiveTask(activeTaskId);
        currentValue = await readLearningNativeState(result.taskId);
      }
      if (currentConfirmedLearningPreviewUrl(currentValue, result)) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ available: true, status: 'ready', url: currentConfirmedLearningPreviewUrl(currentValue, result), view: input.view })); return;
      }
      const artifact = currentValue?.artifact;
      const expected = {
        taskId: result.taskId, projectId: result.projectId,
        goalVersionId: currentValue?.goalVersionId,
        executionId: currentValue?.execution?.id,
        registrySha256: currentValue?.product?.registrySha256,
        artifactId: result.reuseInput.expectedArtifactId,
        artifactVersion: result.reuseInput.expectedArtifactVersion,
        candidateSha256: result.reuseInput.expectedCandidateSha256,
        artifact,
      };
      if (expected.goalVersionId !== result.goalVersionId
        || expected.executionId !== result.reuseInput.expectedExecutionId
        || expected.registrySha256 !== result.reuseInput.expectedRegistrySha256
        || !confirmedLearningPreviewSourceMatches(currentValue, expected)) {
        throw publicError('LEARNING_PREVIEW_UNAVAILABLE', 'The current learning task did not expose a preview bound to its confirmed result.', 409);
      }
      if (currentValue.preview?.status !== 'pending') await createLearningPreview(result.taskId, expected);
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        currentValue = await readLearningNativeState(result.taskId);
        if (!confirmedLearningPreviewSourceIsCurrent(currentValue, result)) {
          throw publicError('LEARNING_PREVIEW_BINDING_CHANGED', '学习预览准备期间原确认结果绑定发生变化；没有打开新成果。', 409);
        }
        const url = currentConfirmedLearningPreviewUrl(currentValue, result);
        if (url) {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ available: true, status: 'ready', url, view: input.view })); return;
        }
        if (currentValue?.preview?.status === 'failed') throw publicError('LEARNING_PREVIEW_FAILED', '当前确认学习成果的预览生成失败；可再次从学习同事入口重试。', 503);
      }
      res.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ available: true, status: 'preview_pending', taskId: result.taskId })); return;
    }
    if (req.method === 'GET' && incoming.pathname === '/api/product-state' && !activeTaskId) {
      const value = await bootstrap.state();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(setupPublicState(value))); return;
    }
    const bootstrapAction = incoming.pathname.match(/^\/api\/product\/tasks\/([^/]+)\/actions$/);
    if (req.method === 'POST' && bootstrapAction) {
      assertProductMutation();
      const input = await readJsonBody(req);
      const setupAliases = { instructions: 'support', materials: 'material', chat: 'converse', continue: 'resume' };
      if (typeof input.action === 'string' && setupAliases[input.action]) input.action = setupAliases[input.action];
      const taskId = decodeURIComponent(bootstrapAction[1]);
      if (input.action === 'memory_save' || input.action === 'memory_change') {
        const direct = await authorityInputMutation(res, taskId, input);
        if (direct === 'handled') { bootstrap.invalidateMemoryCache(); return; }
        if (nativeRuntime) throw publicError('PRODUCT_AUTHORITY_UNAVAILABLE', 'Long-term memory changes require the current Authority writer; the current native runtime is unavailable.', 503);
        await startMemoryAuthority(taskId);
        const started = await authorityInputMutation(res, taskId, input);
        if (started === 'handled') { bootstrap.invalidateMemoryCache(); return; }
        throw publicError('PRODUCT_AUTHORITY_UNAVAILABLE', 'The current Authority writer did not accept the long-term memory change.', 503);
      }
      const localState = await bootstrap.state(taskId);
      if (['run', 'resume', 'continue'].includes(input.action)
          && (await bootstrap.state(taskId, { refreshMemories: true })).memory?.stalePreparedPrompt) {
        throw publicError('MEMORY_BINDING_STALE', 'Long-term memory changed after preparation; prepare the same current run again before starting the Lead.', 409);
      }
      const offlineMutableInput = ['goal', 'support', 'material'].includes(input.action);
      const localSetupAction = (localState.execution === null && ['goal', 'support', 'material', 'converse'].includes(input.action))
        || (localState.execution !== null && offlineMutableInput);
      if (localSetupAction) {
        if (localState.execution !== null) {
          try { return await proxy(req, res); }
          catch (error) {
            if (networkErrorCode(error) !== 'ECONNREFUSED') {
              throw publicError('NATIVE_GATEWAY_UNAVAILABLE', 'The native product gateway did not complete the task input update.', 503);
            }
          }
        }
        const direct = await authorityInputMutation(res, taskId, input);
        if (direct === 'handled') return;
        /* Only ECONNREFUSED is proof that the fixed local authority is absent. */
        await stopNativeRuntime();
        await stopMemoryAuthority();
        const afterStop = await authorityInputMutation(res, taskId, input);
        if (afterStop === 'handled') return;
        let value;
        if (input.action === 'goal') value = await bootstrap.replaceGoal(taskId, input);
        else if (input.action === 'support') value = await bootstrap.addInstruction(taskId, input);
        else if (input.action === 'material') value = await bootstrap.addMaterial(taskId, input);
        else value = await bootstrap.addConversation(taskId, input);
        res.writeHead(input.action === 'goal' ? 200 : 201, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ accepted: true, action: input.action, ...value })); return;
      }
      if (input.action === 'authorize_scope') {
        await stopMemoryAuthority();
        if (localState.execution === null) await stopNativeRuntime();
        const value = await bootstrap.authorizeScope(taskId, { expectedGoalVersionId: input.expectedGoalVersionId,
          projectId: input.projectId, expectedScopeFingerprint: input.expectedScopeFingerprint || input.scopeFingerprint });
        activeTaskId = taskId;
        await saveActiveTask(activeTaskId);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); return;
      }
      if (input.action === 'prepare_run') {
        let preparationInput = { expectedGoalVersionId: input.expectedGoalVersionId,
          expectedScopeFingerprint: input.expectedScopeFingerprint || input.scopeFingerprint };
        const reuseFields = ['expectedExecutionId', 'expectedRegistrySha256', 'expectedArtifactId', 'expectedArtifactVersion', 'expectedCandidateSha256'];
        const restoreFields = ['expectedApprovalId', 'expectedCurrentExecutionId', 'expectedCurrentExecutionSha256',
          'expectedCurrentPromptSha256', 'expectedCurrentRegistrySha256', 'expectedExecutionSha256',
          'expectedPromptSha256', 'expectedReviewId'];
        const restoreRequested = restoreFields.some((key) => Object.hasOwn(input, key));
        const reuseRequested = input.mode !== undefined || reuseFields.some((key) => Object.hasOwn(input, key)) || restoreRequested;
        if (reuseRequested) {
          const expectedKeys = ['action', 'expectedGoalVersionId', 'expectedScopeFingerprint', 'mode', ...reuseFields,
            ...(restoreRequested ? restoreFields : [])].sort();
          if (JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(expectedKeys)
            || input.mode !== 'reuse_current_result') {
            throw publicError('RUN_PREPARATION_INVALID', 'Current-result recovery requires its exact execution, registry, goal, scope, and artifact binding.', 400);
          }
          preparationInput = { ...preparationInput, mode: input.mode,
            expectedExecutionId: input.expectedExecutionId, expectedRegistrySha256: input.expectedRegistrySha256,
            expectedArtifactId: input.expectedArtifactId, expectedArtifactVersion: input.expectedArtifactVersion,
            expectedCandidateSha256: input.expectedCandidateSha256 };
          if (restoreRequested) for (const key of restoreFields) preparationInput[key] = input[key];
        }
        await stopMemoryAuthority();
        const value = await bootstrap.prepareRun(taskId, preparationInput);
        const policy = await writeRuntimePolicy(taskId, value.prepared.projectId);
        await stopNativeRuntime();
        const runtime = await startNativeRuntime(taskId, policy.file);
        if (reuseRequested) {
          const ready = runtime.ready;
          const servicesReady = ['authority', 'openoffice', 'agentOffice', 'scene']
            .every((name) => ready?.services?.[name]?.ready === true);
          if (ready?.allStartedServicesReady !== true || ready.taskId !== taskId
            || ready.modelCalls !== 0 || ready.readyServiceCount !== 4
            || ready.expectedReadyServiceCount !== 4 || !servicesReady) {
            throw publicError('RUN_REUSE_RUNTIME_NOT_READY', 'The original task runtime did not confirm a zero-model recovery startup.', 503);
          }
          const projection = await currentExpiredResultProjection(taskId, await bootstrap.state(taskId), { confirmedOnly: true });
          if (!projection || input.expectedGoalVersionId !== projection.goalVersionId
            || input.expectedScopeFingerprint !== projection.workspace.scopeFingerprint
            || input.expectedExecutionId !== projection.execution.id
            || input.expectedRegistrySha256 !== projection.productRegistry.registrySha256
            || input.expectedArtifactId !== projection.artifact.id
            || input.expectedArtifactVersion !== projection.artifact.version
            || input.expectedCandidateSha256 !== projection.artifact.candidateSha256
            || projection.native.actions.canRun !== false) {
            throw publicError('RUN_REUSE_POSTLOAD_BINDING_UNAVAILABLE', 'The runtime started, but Authority could not confirm the same execution and approved result; no model work was started.', 503);
          }
        }
        res.writeHead(202, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ...value, runtime: { ready: true, policySha256: policy.sha256,
          aiEnabled: process.env.IRIXI_PRODUCT_ENABLE_AI === '1', modelCalls: 0 } })); return;
      }
      if (input.action === 'select_scope' || input.action === 'scope') {
        await stopMemoryAuthority();
        if (localState.execution === null || localState.setup?.selectedScope?.current !== true) await stopNativeRuntime();
        const value = await bootstrap.selectScope(taskId, { expectedGoalVersionId: input.expectedGoalVersionId,
          projectId: input.projectId, expectedScopeFingerprint: input.expectedScopeFingerprint || input.scopeFingerprint });
        activeTaskId = taskId;
        await saveActiveTask(activeTaskId);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ ...value,
          authorizationRequired: true, canRun: false, blockedReason: 'selected_scope_requires_explicit_workspace_authorization' })); return;
      }
    }
    if (req.method === 'GET' && incoming.pathname === '/api/product-state' && activeTaskId) {
      const setup = await bootstrap.state(activeTaskId);
      const expiredResultCurrent = setup.blockedReason !== 'explicit_new_run_required'
        || Boolean(await currentExpiredResultProjection(activeTaskId, setup));
      if (!setup.execution || !setup.registry || !expiredResultCurrent
        || (['waiting_scope', 'waiting_scope_authorization'].includes(setup.status)
          && setup.setup?.selectedScope?.current !== true)) {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(setupPublicState(setup))); return;
      }
      try { return await proxy(req, res, { transform: (value) => ({ ...value,
        ...(setup.task?.id === activeTaskId && value.taskId === activeTaskId
          && setup.task.goalVersionId === value.goalVersionId
          && ['utility', 'game', 'agent'].includes(setup.task.functionId) ? { functionId: setup.task.functionId } : {}),
        memory: setup.memory,
        ...(setup.memory?.stalePreparedPrompt ? { canPrepareRun: true, blockedReason: 'memory_binding_stale',
          nextStep: '长期记忆在原生准备后发生变化；先按相同目标和项目范围重新准备，再启动 Lead。',
          native: { ...value.native, actions: { ...value.native?.actions, canRun: false } } } : {}) }) }); } catch {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(setupPublicState({ ...setup, status: 'runtime_unavailable', canRun: false, canReconnect: setup.canReconnect === true,
          blockedReason: 'native_runtime_unavailable', runtimeError: 'Native product runtime is unavailable; reconnect preserves the same execution ledger and deadline.' }))); return;
      }
    }
    if (incoming.pathname === '/' && req.method === 'GET' && !incoming.searchParams.has('backend')) {
      incoming.searchParams.set('backend', 'openoffice');
      res.writeHead(302, { location: `${incoming.pathname}${incoming.search}`, 'cache-control': 'no-store' }); res.end(); return;
    }
    if (incoming.pathname === '/native' && req.method === 'GET') {
      const taskId = incoming.searchParams.get('taskId');
      if (!/^[a-z0-9-]{1,160}$/.test(taskId || '')) throw new Error('Native task ID is invalid');
      const target = new URL('/', native);
      target.searchParams.set('irixiTask', taskId);
      res.writeHead(302, { location: target.href, 'cache-control': 'no-store' }); res.end(); return;
    }
    const productPreview = incoming.pathname.match(/^\/product-preview\/([A-Za-z0-9_-]{16,128})\/(.+)$/);
    if (productPreview) {
      if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }); res.end(); return; }
      let relative;
      try { relative = decodeURIComponent(productPreview[2]); }
      catch { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return; }
      if (!relative || relative.includes('\\') || relative.startsWith('/')
        || relative.split('/').some((part) => !part || part === '.' || part === '..' || part === '.git')) {
        res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); return;
      }
      const nativePath = '/preview-static/' + productPreview[1] + '/'
        + relative.split('/').map((part) => encodeURIComponent(part)).join('/');
      const response = await fetch(new URL(nativePath, native), {
        method: req.method, headers: { accept: String(req.headers.accept || '*/*') }, signal: AbortSignal.timeout(10_000),
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      const headers = { 'cache-control': 'no-store' };
      for (const name of ['content-type', 'content-security-policy', 'x-content-type-options', 'content-length']) {
        const value = response.headers.get(name);
        if (value) headers[name] = value;
      }
      res.writeHead(response.status, headers);
      if (req.method === 'HEAD') res.end(); else res.end(bytes);
      return;
    }
    if (req.url?.startsWith('/api/product') || req.url?.startsWith('/api/irixi-authority')
      || isIrixiLearningApi(incoming.pathname)) return await proxy(req, res);
    if (req.url?.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end('{"error":"Legacy self-executor API is disabled in native product mode"}'); return; }
    if (!['GET', 'HEAD'].includes(req.method || '')) { res.writeHead(405); res.end(); return; }
    const file = await staticFile(req.url || '/');
    const stat = await fsp.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Not found');
    const bytes = await fsp.readFile(file);
    res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'content-length': bytes.length, 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') res.end(); else res.end(bytes);
  } catch (error) {
    const exposed = error?.public === true || (Number.isInteger(error?.status) && /^[A-Z][A-Z0-9_]{2,63}$/.test(error?.code || ''));
    const status = Number.isInteger(error?.status) ? error.status : 500;
    sendFailure(res, status, exposed ? error.code : 'PRODUCT_REQUEST_FAILED', exposed ? error.message : 'The product request could not be completed.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ok: true, desktop: `http://127.0.0.1:${port}/`, native: native.href })));
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections?.();
  await stopNativeRuntime();
  await stopMemoryAuthority();
  await closed;
  process.exit(signal === 'SIGINT' ? 130 : 143);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void shutdown(signal).catch((error) => {
    console.error(`[DesktopProduct] shutdown failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  });
});
