import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CODEX_BRIDGE_MODEL_ID, CODEX_BRIDGE_PROVIDER_ID, assertSafeWorkspaceTree } from './codex-provider-protocol.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OMO_NATIVE_BINARY = path.join(ROOT, '.irixi-runtime', 'omo', 'bin', 'omo');
export const OMO_PROVIDER_EXTENSION = path.join(ROOT, 'omo-pilot', 'codex-bridge-provider.mjs');
export const OMO_REQUIRED_VERSION = '5.1.40';
const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;

function safeNativeError(value) {
  return String(value || '')
    .replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '[redacted-key]')
    .replace(/\b((?:OPENAI|CODEX|API)[A-Z0-9_]*(?:KEY|TOKEN|SECRET))\s*[:=]\s*[^\s,;]+/giu, '$1=[redacted]')
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password)["']?\s*[:=]\s*["']?)[^"'\s,}]+/giu, '$1[redacted]')
    .replace(/([?&](?:key|token|secret|password)=)[^&\s]+/giu, '$1[redacted]')
    .replace(/(^|[\s"'=,(])\/(?!\/)[^\s"'<>;,)]*/gu, '$1[path redacted]')
    .replace(/[A-Za-z]:\\[^\s"'<>;,)]*/gu, '[path redacted]')
    .slice(0, 300);
}

function nativeProviderFailureDetail(failure) {
  if (typeof failure === 'string' && failure.trim()) return safeNativeError(failure) || null;
  if (!failure || typeof failure !== 'object' || Array.isArray(failure)) return null;
  const detailValue = [failure.message, failure.reason, failure.detail, failure.description,
    typeof failure.error === 'string' ? failure.error : failure.error?.message,
    typeof failure.cause === 'string' ? failure.cause : failure.cause?.message]
    .find((value) => typeof value === 'string' && value.trim());
  return detailValue ? safeNativeError(detailValue) || null : null;
}

export function nativeProviderFailureMessage(failure) {
  const category = safeNativeError(typeof failure === 'object' && failure
    ? failure.category || failure.code || '' : '');
  const detail = nativeProviderFailureDetail(failure);
  const label = category || 'unknown';
  return safeNativeError(detail ? `Native OmO provider failure (${label}): ${detail}` : `Native OmO provider failure (${label}).`);
}

function assistantStopError(message) {
  if (message?.stopReason !== 'error' && message?.stopReason !== 'aborted') return '';
  return safeNativeError(message.errorMessage) || `Native OmO assistant stopped: ${message.stopReason}.`;
}

export function updateNativeFailureFromEvent(event, previous = '') {
  if (event?.type === 'message_end' && event.message?.role === 'assistant') return assistantStopError(event.message);
  if (event?.type !== 'agent_end') return previous;
  if (event.willRetry) return '';
  const last = (event.messages || []).filter((message) => message?.role === 'assistant').at(-1);
  const assistantError = assistantStopError(last);
  if (event.failure) {
    if (nativeProviderFailureDetail(event.failure)) return nativeProviderFailureMessage(event.failure);
    return safeNativeError(previous || assistantError || nativeProviderFailureMessage(event.failure));
  }
  return assistantError;
}

const NATIVE_ROLE_TOOLS = Object.freeze({
  Lead: { names: [], permission: 'read-only' },
  Developer: { names: ['read', 'write', 'edit', 'grep', 'find', 'ls'], permission: 'workspace' },
  Reviewer: { names: ['read', 'grep', 'find', 'ls'], permission: 'read-only' },
  Chat: { names: ['read', 'grep', 'find', 'ls'], permission: 'read-only' },
});

export function nativeRoleTools(role) { return NATIVE_ROLE_TOOLS[role] || { names: [], permission: 'read-only' }; }

export function nativeTurnFailure({ settled, stopReason, error, text, state }) {
  if (!settled) return 'Native OmO did not emit agent_settled.';
  if (stopReason !== 'stop' || error || !String(text || '').trim()) {
    return error || 'Native OmO settled without a non-empty final assistant stop.';
  }
  if (state?.isStreaming !== false || state?.isCompacting !== false || state?.pendingMessageCount !== 0) {
    return 'Native OmO agent_settled did not agree with an idle final RPC state.';
  }
  return null;
}

export function canAcceptNativeProviderRequest({ failed, aborted, childExited, childKilled, pending,
  promptAdmitted, modelConfirmed, payload, allowedTools }) {
  return !failed && !aborted && !childExited && !childKilled && !pending && promptAdmitted && modelConfirmed
    && payload?.provider === CODEX_BRIDGE_PROVIDER_ID && payload?.modelId === CODEX_BRIDGE_MODEL_ID
    && Array.isArray(payload?.tools)
    && payload.tools.every((tool) => allowedTools.has(tool?.name));
}

async function readInstallMetadata(homeDir) {
  const filePath = path.join(homeDir, '.omo', 'install.json');
  const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
  if (parsed.version !== OMO_REQUIRED_VERSION) throw new Error(`OmO install version mismatch: expected ${OMO_REQUIRED_VERSION}.`);
  return parsed;
}

async function resolvePiAiModulePath(installMetadata, overridePath) {
  let candidate = overridePath;
  if (overridePath) {
    if (!path.isAbsolute(overridePath)) throw new Error('OmO provider runtime module path must be absolute.');
  } else if (typeof installMetadata.binPath === 'string' && path.isAbsolute(installMetadata.binPath)) {
    candidate = path.resolve(path.dirname(installMetadata.binPath), '..', 'lib', 'node_modules',
      '@earendil-works', 'pi-coding-agent', 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js');
  }
  if (!candidate) throw new Error('The installed OmO provider runtime module is unavailable; no model call was started.');
  try { await fsp.access(candidate); } catch {
    throw new Error('The installed OmO provider runtime module is unavailable; no model call was started.');
  }
  const piAiPackage = JSON.parse(await fsp.readFile(path.resolve(path.dirname(candidate), '..', 'package.json'), 'utf8'));
  const codingAgentPackagePath = path.resolve(path.dirname(installMetadata.binPath), '..', 'lib', 'node_modules',
    '@earendil-works', 'pi-coding-agent', 'package.json');
  const codingAgentPackage = JSON.parse(await fsp.readFile(codingAgentPackagePath, 'utf8'));
  if (!piAiPackage.version || piAiPackage.version !== codingAgentPackage.version) {
    throw new Error('The installed OmO provider API does not match its adjacent 5.1.40-compatible runtime package; no model call was started.');
  }
  return candidate;
}

export async function runOmoNativeRpcRole({
  role, prompt, cwd, runModelDecision, timeoutMs = 20 * 60_000, signal = null,
  allowedWritePaths = [],
  homeDir = path.join(ROOT, '.irixi-runtime', 'omo', 'home'),
  piAiModulePath = null,
  executable = OMO_NATIVE_BINARY,
}) {
  if (!Object.hasOwn(NATIVE_ROLE_TOOLS, role) || typeof prompt !== 'string' || !prompt.trim()
    || typeof runModelDecision !== 'function') throw new Error('Native OmO role request is incomplete.');
  const installMetadata = await readInstallMetadata(homeDir);
  const installedVersion = installMetadata.version;
  const resolvedPiAiModulePath = await resolvePiAiModulePath(installMetadata, piAiModulePath);
  const tools = nativeRoleTools(role);
  if (['Developer', 'Reviewer'].includes(role)) {
    if (!cwd || !path.isAbsolute(cwd)) throw new Error('OmO worker role requires its registered absolute worktree.');
    cwd = await assertSafeWorkspaceTree(cwd);
  }
  if (!Array.isArray(allowedWritePaths) || allowedWritePaths.some((item) => typeof item !== 'string' || !item
    || path.isAbsolute(item) || item.split(/[\\/]+/u).includes('..'))) throw new Error('OmO writable scope is invalid.');
  const args = [
    '--mode', 'rpc', '--session-runtime', 'in-process', '--no-session', '--no-extensions', '--extension', OMO_PROVIDER_EXTENSION,
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-model-fallback',
    '--provider', CODEX_BRIDGE_PROVIDER_ID, '--model', CODEX_BRIDGE_MODEL_ID,
    ...(tools.names.length ? ['--tools', tools.names.join(',')] : ['--no-tools']),
    '--permission-preset', tools.permission,
  ];
  const isolatedHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-omo-session-'));
  const isolatedAgentDir = path.join(isolatedHome, '.omo', 'agent');
  const bridgeSocketPath = path.join(isolatedHome, `bridge-${randomUUID().slice(0, 8)}.sock`);
  const bridgeServer = createServer();
  try {
    await fsp.chmod(isolatedHome, 0o700);
    await fsp.mkdir(isolatedAgentDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(isolatedAgentDir, 0o700);
    await new Promise((resolve, reject) => {
      bridgeServer.once('error', reject);
      bridgeServer.listen(bridgeSocketPath, resolve);
    });
    await fsp.chmod(bridgeSocketPath, 0o600);
  } catch (error) {
    if (bridgeServer.listening) bridgeServer.close();
    await fsp.rm(isolatedHome, { recursive: true, force: true });
    throw error;
  }
  const child = spawn(executable, args, {
    cwd: cwd || ROOT,
    env: {
      HOME: isolatedHome,
      PI_CODING_AGENT_DIR: isolatedAgentDir,
      IRIXI_OMO_PI_AI_MODULE_URL: pathToFileURL(resolvedPiAiModulePath).href,
      IRIXI_OMO_BRIDGE_SOCKET: bridgeSocketPath,
      IRIXI_OMO_ROLE: role,
      IRIXI_OMO_WORKSPACE_ROOT: cwd || ROOT,
      IRIXI_OMO_ALLOWED_WRITE_PATHS: JSON.stringify(allowedWritePaths),
      SENPI_NO_FALLBACK: '1',
      PATH: `${path.dirname(executable)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let bridgeBuffer = '';
  let stderrBuffer = '';
  let nextId = 0;
  let providerCalls = 0;
  let finalText = '';
  let finalAssistantStopReason = null;
  let lastAssistantError = '';
  let runtimeInfo = null;
  let sessionState = null;
  let settled = false;
  let processError = null;
  let promptAdmitted = false;
  let selectedModelConfirmed = false;
  const providerAbort = new AbortController();
  const failProcess = (error) => {
    if (!processError) {
      const safeError = new Error(safeNativeError(error instanceof Error ? error.message : error) || 'Native OmO role failed.');
      if (error?.code) safeError.code = error.code;
      processError = safeError;
    }
    providerAbort.abort();
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  };
  const rpcWaiters = new Map();
  const modelCalls = new Set();
  let providerDecisionPending = false;
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = Object.assign(new Error('Native OmO role exceeded its execution timeout.'), { code: 'OMO_ROLE_TIMEOUT' });
      failProcess(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
    child.once('close', () => clearTimeout(timer));
  });

  const waitForRpc = (command, data = {}) => new Promise((resolve, reject) => {
    const id = `irixi-${++nextId}`;
    rpcWaiters.set(id, { command, resolve, reject });
    try { child.stdin.write(`${JSON.stringify({ id, type: command, ...data })}\n`); }
    catch (error) { rpcWaiters.delete(id); reject(error); }
  });
  const handleModelRequest = (message, socket) => {
    const closed = processError || providerAbort.signal.aborted || child.exitCode !== null || child.killed;
    if (closed) return;
    const requestId = message?.id;
    if (typeof requestId !== 'string' || !message.payload || typeof message.payload !== 'object') return;
    const payload = message.payload;
    const permittedTools = new Set(tools.names);
    if (!canAcceptNativeProviderRequest({ failed: false, aborted: false, childExited: false, childKilled: false,
      pending: providerDecisionPending, promptAdmitted, modelConfirmed: selectedModelConfirmed, payload, allowedTools: permittedTools })) {
      failProcess(new Error(providerDecisionPending
        ? 'Native OmO requested overlapping provider decisions; the run was stopped.'
        : 'Native OmO requested a model decision before prompt admission or outside its registered provider/tool scope.'));
      return;
    }
    providerDecisionPending = true;
    providerCalls += 1;
    const job = Promise.resolve().then(() => runModelDecision(payload, providerCalls, providerAbort.signal)).then(async (text) => {
      if (processError || providerAbort.signal.aborted || child.exitCode !== null || child.killed) return;
      if (typeof text !== 'string' || !text.trim()) throw new Error('Host returned an empty model decision.');
      const response = `${JSON.stringify({ id: requestId, ok: true, text })}\n`;
      if (Buffer.byteLength(response, 'utf8') > MAX_RPC_LINE_BYTES) throw new Error('Host model decision exceeded the safe limit.');
      if (processError || providerAbort.signal.aborted || child.exitCode !== null || child.killed) return;
      if (!socket.write(response)) await new Promise((resolve, reject) => {
        socket.once('drain', resolve); socket.once('error', reject);
      });
    }).catch((error) => {
      failProcess(error);
      const response = `${JSON.stringify({ id: requestId, ok: false, error: 'The host rejected or failed this model request.' })}\n`;
      if (child.exitCode === null && !child.killed && socket.writable) socket.write(response);
    }).finally(() => { providerDecisionPending = false; modelCalls.delete(job); });
    modelCalls.add(job);
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    if (Buffer.byteLength(stdoutBuffer, 'utf8') > MAX_RPC_LINE_BYTES) {
      failProcess(new Error('Native OmO RPC output exceeded the safe limit.'));
      stdoutBuffer = '';
    }
    for (const line of lines) {
      if (!line) continue;
      if (Buffer.byteLength(line) > MAX_RPC_LINE_BYTES) { failProcess(new Error('Native OmO RPC line exceeded the safe limit.')); continue; }
      let event;
      try { event = JSON.parse(line); } catch { failProcess(new Error('Native OmO emitted invalid RPC JSON.')); continue; }
      if (event.type === 'response') {
        const waiter = event.id && rpcWaiters.get(event.id);
        if (!waiter) continue;
        const id = event.id || waiter.id;
        rpcWaiters.delete(id);
        if (event.success === false) waiter.reject(new Error(`Native OmO RPC ${waiter.command} was rejected: ${safeNativeError(event.error) || 'unknown reason'}.`));
        else waiter.resolve(event.data ?? event);
      } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
        const msg = event.message;
        const text = (msg.content || []).filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text).join('\n').trim();
        finalText = text;
        finalAssistantStopReason = msg.stopReason || null;
        lastAssistantError = updateNativeFailureFromEvent(event, lastAssistantError);
      } else if (event.type === 'agent_end') {
        const assistants = (event.messages || []).filter((msg) => msg?.role === 'assistant');
        const last = assistants.at(-1);
        if (last) {
          const text = (last.content || []).filter((block) => block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text).join('\n').trim();
          finalText = text;
          finalAssistantStopReason = last.stopReason || null;
        } else {
          finalText = '';
          finalAssistantStopReason = null;
        }
        lastAssistantError = updateNativeFailureFromEvent(event, lastAssistantError);
      } else if (event.type === 'agent_settled') {
        settled = true;
      }
    }
  });
  let bridgeSocket = null;
  bridgeServer.on('connection', (socket) => {
    if (bridgeSocket || processError) { socket.destroy(); return; }
    bridgeSocket = socket;
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RPC_LINE_BYTES) {
        failProcess(new Error('Native OmO bridge output exceeded the safe limit.'));
        buffer = '';
      }
      for (const line of lines) {
        if (!line) continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_RPC_LINE_BYTES) {
          failProcess(new Error('Native OmO bridge output exceeded the safe limit.'));
          continue;
        }
        let message;
        try { message = JSON.parse(line); } catch { failProcess(new Error('Native OmO provider emitted invalid bridge JSON.')); continue; }
        handleModelRequest(message, socket);
      }
    });
    socket.on('error', (error) => failProcess(error));
    socket.on('close', () => {
      if (bridgeSocket === socket) bridgeSocket = null;
      if (promptAdmitted && !settled && !processError) failProcess(new Error('OmO local provider bridge closed before settlement.'));
    });
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    if (Buffer.byteLength(stderrBuffer, 'utf8') < 4_096) stderrBuffer += String(chunk).slice(0, 4_096);
  });
  child.once('error', (error) => { failProcess(error); for (const item of rpcWaiters.values()) item.reject(error); rpcWaiters.clear(); });
  child.once('close', (code) => {
    providerAbort.abort();
    if (!settled && !processError) failProcess(new Error(safeNativeError(stderrBuffer)
      || `Native OmO exited before agent_settled (exit ${code}).`));
    for (const item of rpcWaiters.values()) item.reject(processError);
    rpcWaiters.clear();
  });

  const abort = () => { failProcess(Object.assign(new Error('OmO native run was cancelled.'), { code: 'ABORTED' })); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    const run = async () => {
      runtimeInfo = await waitForRpc('get_protocol_info');
      await waitForRpc('set_model', { provider: CODEX_BRIDGE_PROVIDER_ID, modelId: CODEX_BRIDGE_MODEL_ID });
      sessionState = await waitForRpc('get_state');
      if (sessionState?.model?.provider !== CODEX_BRIDGE_PROVIDER_ID || sessionState?.model?.id !== CODEX_BRIDGE_MODEL_ID) {
        throw new Error('Native OmO did not confirm the registered local Codex model before prompt.');
      }
      selectedModelConfirmed = true;
      promptAdmitted = true;
      await waitForRpc('prompt', { message: prompt });
      await new Promise((resolve, reject) => {
        const interval = setInterval(() => {
          if (processError) { clearInterval(interval); reject(processError); }
          else if (settled) { clearInterval(interval); resolve(); }
        }, 10);
      });
      await Promise.all([...modelCalls]);
      const finalState = await waitForRpc('get_state');
      const finalFailure = nativeTurnFailure({
        settled, stopReason: finalAssistantStopReason, error: lastAssistantError, text: finalText, state: finalState,
      });
      if (finalFailure) throw new Error(finalFailure);
      return {
        status: 'model_returned', output: { text: finalText }, provider: CODEX_BRIDGE_PROVIDER_ID,
        model: CODEX_BRIDGE_MODEL_ID, providerDecisionRequests: providerCalls,
        sessionId: typeof finalState.sessionId === 'string' && finalState.sessionId.trim() ? finalState.sessionId : null,
        runtime: { installedVersion, engineVersion: runtimeInfo?.engineVersion || null,
          runtimeBuildId: runtimeInfo?.runtimeBuildId || null, protocolVersion: runtimeInfo?.protocolVersion || null },
      };
    };
    return await Promise.race([run(), timeout]);
  } finally {
    signal?.removeEventListener('abort', abort);
    try { child.stdin.end(); } catch {}
    if (child.exitCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      if (!child.killed) child.kill('SIGTERM');
      const forceKill = setTimeout(() => child.kill('SIGKILL'), 1_000);
      forceKill.unref?.();
      await closed;
      clearTimeout(forceKill);
    }
    bridgeSocket?.destroy();
    if (bridgeServer.listening) await new Promise((resolve) => bridgeServer.close(resolve));
    await fsp.rm(isolatedHome, { recursive: true, force: true });
  }
}

export const __test = { safeNativeError, nativeProviderFailureMessage, updateNativeFailureFromEvent };
