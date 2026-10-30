import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { resolveCodexRuntime } from '../app/codex-runtime.mjs';

const product = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const contained = (root, file) => file.startsWith(root + path.sep);

export async function verifiedNoobiBuild(build) {
  const allowed = path.join(product, '.irixi-runtime/noobi-specialist');
  let expectedVersion;
  if (!build) {
    const selected = JSON.parse(await fs.readFile(path.join(allowed, 'selected.json'), 'utf8'));
    if (!/^build-[A-Za-z0-9]+$/u.test(selected.directory)) throw new Error('Noobi 构建选择无效。');
    build = path.join(allowed, selected.directory);
    expectedVersion = selected.version;
  }
  const real = await fs.realpath(build);
  if (!contained(allowed, real)) throw new Error('Noobi 构建不在本产品的专用位置。');
  const manifest = JSON.parse(await fs.readFile(path.join(real, 'manifest.json'), 'utf8'));
  if (manifest.compatibilityVersion !== 1 || !Object.keys(manifest.outputs || {}).length) throw new Error('Noobi 构建记录不完整。');
  for (const [relative, expected] of Object.entries(manifest.outputs)) {
    const filename = path.resolve(real, relative);
    if (!contained(path.join(real, 'dist'), filename) || await fs.realpath(filename) !== filename || digest(await fs.readFile(filename)) !== expected) throw new Error('Noobi 构建已变化，请重新检查后加载。');
  }
  if (digest(JSON.stringify({ originals: manifest.originals, outputs: manifest.outputs })) !== manifest.version) throw new Error('Noobi 构建版本记录不一致。');
  if (expectedVersion && expectedVersion !== manifest.version) throw new Error('Noobi 当前选择与构建版本不同。');
  return { path: real, manifest };
}

// The caller durably owns the job and workspace before entering this function.
// All worker events stay bound to that identity; no message supplies a new path.
export async function runControlledNoobi({ build, jobDirectory, workspace, projectId, jobId, prompt, name,
  modelSelection, previousResult = null, signal, onProcess, onEvent, onApproval }) {
  signal.throwIfAborted();
  const verified = await verifiedNoobiBuild(build);
  const runtime = resolveCodexRuntime();
  if (!runtime.executable) throw new Error(runtime.executableError);
  const root = await fs.realpath(workspace);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(projectId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(jobId) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 48000) throw new Error('Noobi 工作身份或要求无效。');
  await fs.mkdir(jobDirectory, { recursive: true, mode: 0o700 });
  const directory = await fs.realpath(jobDirectory);
  if (root === directory || contained(root, directory) || contained(directory, root)) throw new Error('Noobi 宿主记录与模型工作目录必须分开。');
  const input = { build: verified.path, buildVersion: verified.manifest.version, dependencyDirectory: verified.manifest.dependencyDirectory,
    jobDirectory: directory, workspace: root, projectId, jobId, prompt, name, modelSelection, previousResult,
    executable: runtime.executable, codexHome: runtime.codexHome };
  const inputFile = path.join(directory, 'input.json');
  await fs.writeFile(inputFile, JSON.stringify(input), { flag: 'wx', mode: 0o600 });
  await fs.mkdir(path.join(directory, 'tmp'), { recursive: true });
  const require = createRequire(path.join(verified.manifest.dependencyDirectory, 'electron/package.json'));
  const executable = require('electron');
  const env = Object.fromEntries(['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]));
  env.TMPDIR = path.join(directory, 'tmp');
  signal.throwIfAborted();
  const child = spawn(executable, [path.join(product, 'omo-pilot/noobi-worker.mjs'), inputFile], {
    cwd: directory, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true,
  });
  let result, workerError, closed = false, serial = Promise.resolve(), stopping = false;
  const lifetime = new AbortController(), approvalSignal = AbortSignal.any([signal, lifetime.signal]);
  const approvalWaits = new Set();
  let killTimer;
  const killGroup = (sig) => { if (!child.pid || closed) return; try { process.kill(-child.pid, sig); } catch (e) { if (e.code !== 'ESRCH') throw e; } };
  const stop = () => {
    if (stopping || closed) return; stopping = true;
    if (child.connected) child.send({ kind: 'stop' });
    // Cancel the whole owned worker group, including native model and playtest
    // processes, if graceful cleanup does not finish. Parent waits for close.
    killTimer = setTimeout(() => { killGroup('SIGTERM'); killTimer = setTimeout(() => killGroup('SIGKILL'), 3000); }, 6000);
  };
  signal.addEventListener('abort', stop, { once: true });
  const completion = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, sig) => { closed = true; clearTimeout(killTimer); lifetime.abort(new Error('Noobi 作业已退出，确认不再生效。')); resolve({ code, signal: sig }); });
  });
  child.stderr.on('data', () => {}); // Never expose raw auth/client diagnostics.
  child.on('message', (message) => {
    if (message?.jobId !== jobId || message?.projectId !== projectId) { workerError = new Error('Noobi 回执工作身份不匹配。'); stop(); return; }
    // Waiting for a human must not hold the event/receipt persistence queue.
    if (message.kind === 'approval') {
      const wait = Promise.resolve().then(async () => {
        approvalSignal.throwIfAborted();
        const answer = await onApproval?.(message.approval, approvalSignal) || { decision: 'decline' };
        if (child.connected && !approvalSignal.aborted) child.send({ kind: 'approval', token: message.approval.token,
          decision: typeof answer === 'string' ? answer : answer.decision, answers: answer.answers });
      }).catch((error) => { if (!approvalSignal.aborted) { workerError = error; stop(); } });
      approvalWaits.add(wait); wait.finally(() => approvalWaits.delete(wait)); return;
    }
    serial = serial.then(async () => {
      if (message.kind === 'process') await onProcess?.({ pid: message.pid, group: false });
      else if (message.kind === 'event') await onEvent?.(message.event);
      else if (message.kind === 'result') result = message.result;
      else if (message.kind === 'failure') workerError = new Error(message.error || 'Noobi 未完成本轮制作。');
      if (message.receiptId && child.connected) child.send({ kind: 'receipt', receiptId: message.receiptId });
    }).catch((error) => { workerError = error; stop(); });
  });
  try {
    await onProcess?.({ pid: child.pid, group: true });
    if (signal.aborted) stop(); else child.send({ kind: 'start' });
    const exit = await completion; await serial; await Promise.allSettled([...approvalWaits]);
    signal.throwIfAborted();
    if (workerError) throw workerError;
    if (exit.code !== 0 || !result || result.status !== 'completed' || result.buildVersion !== verified.manifest.version) throw new Error('Noobi 没有返回已检查的完整成果，工作副本已保留。');
    return result;
  } catch (error) {
    stop(); await completion.catch(() => {}); throw error;
  } finally {
    clearTimeout(killTimer); signal.removeEventListener('abort', stop);
  }
}
