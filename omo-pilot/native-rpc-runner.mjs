import { spawn, execFileSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CODEX_BRIDGE_MODEL_ID, CODEX_BRIDGE_PROVIDER_ID, assertSafeWorkspaceTree } from './codex-provider-protocol.mjs';
import { cleanupCommandRegistry } from './conversation-command.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OMO_NATIVE_BINARY = path.join(ROOT, '.irixi-runtime', 'omo', 'bin', 'omo');
export const OMO_PROVIDER_EXTENSION = path.join(ROOT, 'omo-pilot', 'codex-bridge-provider.mjs');
export const OMO_REQUIRED_VERSION = '5.1.40';
const MAX_RPC_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TOOL_RECEIPT_CONTENT_BYTES = 64 * 1024;
const MAX_TOOL_RECEIPT_EVENTS = 512;

async function createPrivateBridgeServer(ownedTempRoot = null) {
  const tempRoot = ownedTempRoot || (process.platform === 'win32' ? os.tmpdir() : '/tmp');
  const directory = await fsp.mkdtemp(path.join(tempRoot, 'irixi-bridge-'));
  let socketPath = path.join(directory, 'b.sock');
  let shortDirectory = null;
  const server = createServer();
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    if (shortDirectory) await fsp.rm(shortDirectory, { recursive: true, force: true });
    await fsp.rm(directory, { recursive: true, force: true });
  };
  try {
    await fsp.chmod(directory, 0o700);
    // macOS Unix sockets have a short pathname limit. Only the private alias
    // lives outside the owned temp root; the socket itself stays inside it.
    if (process.platform !== 'win32' && Buffer.byteLength(socketPath) > 96) {
      shortDirectory = await fsp.mkdtemp('/private/tmp/irixi-sock-');
      await fsp.chmod(shortDirectory, 0o700);
      await fsp.symlink(directory, path.join(shortDirectory, 'd'));
      socketPath = path.join(shortDirectory, 'd', 'b.sock');
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
    await fsp.chmod(socketPath, 0o600);
    return { directory, path: socketPath, server, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

function safeReceiptValue(value, key = '', depth = 0, seen = new WeakSet(), metadata = { redactions: new Set(), workspaceRoot: null }) {
  if (/(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credential|authorization)/iu.test(key)) {
    metadata.redactions.add('sensitive_field');
    return '[redacted]';
  }
  if (typeof value === 'string') {
    let text = value;
    const replace = (regex, replacement, reason) => {
      const next = text.replace(regex, replacement);
      if (next !== text) metadata.redactions.add(reason);
      text = next;
    };
    replace(/\bBearer\s+\S+/giu, 'Bearer [redacted]', 'bearer_token');
    replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/gu, '[redacted-key]', 'key_like_token');
    replace(/([?&](?:key|token|secret|password)=)[^&\s]+/giu, '$1[redacted]', 'query_secret');
    text = text.replace(/(^|[\s"'=,(])(\/(?!\/)[^\s"'<>;,)]*)/gu, (match, prefix, candidate) => {
      const root = metadata.workspaceRoot;
      if (root) {
        const relative = path.relative(root, path.resolve(candidate));
        if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
          metadata.redactions.add('workspace_path_mapped_to_relative');
          return `${prefix}[workspace]/${relative.split(path.sep).join('/')}`;
        }
      }
      metadata.redactions.add('external_absolute_path');
      return `${prefix}[path redacted]`;
    });
    replace(/[A-Za-z]:\\[^\s"'<>;,)]*/gu, '[path redacted]', 'external_absolute_path');
    return text;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object' || depth > 12) return '[unsupported]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => safeReceiptValue(item, '', depth + 1, seen, metadata));
  return Object.fromEntries(Object.keys(value).sort().slice(0, 100)
    .map((name) => [name, safeReceiptValue(value[name], name, depth + 1, seen, metadata)]));
}

function safeReceiptContent(value, workspaceRoot = null) {
  let structurallyLimited = false;
  const metadata = { redactions: new Set(), workspaceRoot: workspaceRoot ? path.resolve(workspaceRoot) : null };
  const inspected = new WeakSet();
  const inspect = (item, depth = 0) => {
    if (!item || typeof item !== 'object') return;
    if (depth > 12 || inspected.has(item)) { structurallyLimited = true; return; }
    inspected.add(item);
    const entries = Array.isArray(item) ? item : Object.values(item);
    if (entries.length > 100) structurallyLimited = true;
    entries.slice(0, 100).forEach((entry) => inspect(entry, depth + 1));
  };
  inspect(value);
  let serialized;
  try { serialized = JSON.stringify(safeReceiptValue(value, '', 0, new WeakSet(), metadata)); }
  catch { serialized = '"[unserializable]"'; }
  const bytes = Buffer.from(serialized, 'utf8');
  return {
    text: bytes.subarray(0, MAX_TOOL_RECEIPT_CONTENT_BYTES).toString('utf8'),
    utf8Bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha256Scope: 'sanitized-json-copy',
    truncated: bytes.length > MAX_TOOL_RECEIPT_CONTENT_BYTES || structurallyLimited,
    structurallyLimited,
    redactions: [...metadata.redactions].sort(),
  };
}

export function createNativeToolReceiptCollector({ binding, workspaceRoot = null, onReceipt = null } = {}) {
  const active = new Map();
  const seenIds = new Set();
  const receipts = [];
  const errors = [];
  let sequence = 0;
  let sessionId = null;
  let finished = false;
  let overflowEventCount = 0;
  let overflowError = null;
  const append = (data) => {
    if (finished) return null;
    if (receipts.length >= MAX_TOOL_RECEIPT_EVENTS) {
      overflowEventCount += 1;
      if (!overflowError) {
        overflowError = { code: 'receipt_event_limit', firstToolCallId: data?.toolCallId || null, droppedEventCount: 0 };
        errors.push(overflowError);
      }
      overflowError.droppedEventCount = overflowEventCount;
      return null;
    }
    const record = {
      binding: structuredClone(binding || {}), sessionId, sequence: ++sequence,
      eventType: data.eventType, toolCallId: data.toolCallId || null, toolName: data.toolName || null,
      ...(data.args ? { args: safeReceiptContent(data.args, workspaceRoot) } : {}),
      ...(Object.hasOwn(data, 'content') ? { content: safeReceiptContent(data.content, workspaceRoot) } : {}),
      ...(typeof data.isError === 'boolean' ? { isError: data.isError } : {}),
      ...(data.integrityError ? { integrityError: data.integrityError } : {}),
      occurredAt: new Date().toISOString(),
    };
    receipts.push(record);
    try { onReceipt?.(structuredClone(record)); }
    catch (error) { errors.push({ code: 'receipt_callback_failed', message: safeNativeError(error?.message) }); }
    return record;
  };
  return {
    setSessionId(value) { sessionId = typeof value === 'string' && value.trim() ? value : null; },
    ingest(event) {
      if (finished || !event || typeof event !== 'object') return null;
      const type = event.type;
      const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null;
      const toolName = typeof event.toolName === 'string' ? event.toolName : null;
      if (type === 'tool_execution_start') {
        if (!toolCallId || !toolName || !event.args || typeof event.args !== 'object' || Array.isArray(event.args)) {
          errors.push({ code: 'invalid_tool_start', toolCallId });
          return append({ eventType: 'integrity_error', toolCallId, toolName, integrityError: 'invalid_tool_start' });
        }
        if (seenIds.has(toolCallId)) {
          errors.push({ code: 'duplicate_tool_call_id', toolCallId });
          return append({ eventType: 'integrity_error', toolCallId, toolName, integrityError: 'duplicate_tool_call_id' });
        }
        seenIds.add(toolCallId);
        active.set(toolCallId, { toolName, args: structuredClone(event.args), updates: 0 });
        return append({ eventType: 'start', toolCallId, toolName, args: event.args });
      }
      if (type === 'tool_execution_update') {
        const call = toolCallId ? active.get(toolCallId) : null;
        if (!call) {
          errors.push({ code: 'orphan_tool_update', toolCallId });
          return append({ eventType: 'integrity_error', toolCallId, toolName, integrityError: 'orphan_tool_update',
            ...(Object.hasOwn(event, 'partialResult') ? { content: event.partialResult } : {}) });
        }
        call.updates += 1;
        if (!Object.hasOwn(event, 'partialResult')) {
          errors.push({ code: 'missing_partial_result', toolCallId });
          return append({ eventType: 'integrity_error', toolCallId, toolName: call.toolName, integrityError: 'missing_partial_result' });
        }
        return append({ eventType: 'update', toolCallId, toolName: call.toolName, content: event.partialResult });
      }
      if (type === 'tool_execution_end') {
        const call = toolCallId ? active.get(toolCallId) : null;
        if (!call || toolName && toolName !== call.toolName || !Object.hasOwn(event, 'result')) {
          const code = !call ? 'orphan_tool_end' : toolName && toolName !== call.toolName ? 'tool_name_mismatch' : 'missing_tool_result';
          errors.push({ code, toolCallId });
          return append({ eventType: 'integrity_error', toolCallId, toolName, integrityError: code,
            ...(Object.hasOwn(event, 'result') ? { content: event.result } : {}) });
        }
        active.delete(toolCallId);
        return append({ eventType: 'end', toolCallId, toolName: call.toolName, content: event.result,
          isError: event.isError === true });
      }
      return null;
    },
    finish({ cancelled = false } = {}) {
      if (finished) return { receipts: structuredClone(receipts), errors: structuredClone(errors),
        complete: active.size === 0 && errors.length === 0, overflowEventCount };
      for (const [toolCallId, call] of active) {
        const code = cancelled ? 'cancelled_before_tool_end' : 'missing_tool_end';
        errors.push({ code, toolCallId });
        append({ eventType: cancelled ? 'cancelled' : 'incomplete', toolCallId, toolName: call.toolName, integrityError: code });
      }
      active.clear();
      finished = true;
      return { receipts: structuredClone(receipts), errors: structuredClone(errors),
        complete: active.size === 0 && errors.length === 0, overflowEventCount };
    },
  };
}

export function createNativeIdleWatchdog(timeoutMs, onTimeout, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || typeof onTimeout !== 'function') {
    throw new Error('Native OmO idle watchdog requires a finite timeout and callback.');
  }
  let timer = null;
  let closed = false;
  const reset = () => {
    if (closed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      if (closed) return;
      closed = true;
      timer = null;
      onTimeout();
    }, timeoutMs);
    timer?.unref?.();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  reset();
  return { reset, close };
}

export function createNativeSessionWatchdog(timeoutMs, idleTimeoutMs, onTimeout, schedulers = {}) {
  const usesIdleTimeout = Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0;
  const watchdog = createNativeIdleWatchdog(usesIdleTimeout ? idleTimeoutMs : timeoutMs, onTimeout, schedulers);
  return {
    reset() { if (usesIdleTimeout) watchdog.reset(); },
    close: () => watchdog.close(),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}

export function completedNativeToolOperations(messages) {
  const pending = new Map();
  const completed = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    if (message?.role === 'assistant') {
      for (const block of blocks) {
        if (block?.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string'
          && block.arguments && typeof block.arguments === 'object' && !Array.isArray(block.arguments)) {
          pending.set(block.id, { name: block.name, arguments: stableValue(block.arguments) });
        }
      }
    }
    const results = message?.role === 'toolResult' || message?.role === 'tool'
      ? [message] : blocks.filter((block) => block?.type === 'toolResult');
    for (const result of results) {
      const callId = result.toolCallId || result.id;
      const call = pending.get(callId);
      if (!call) continue;
      const resultText = typeof result.content === 'string' ? result.content
        : Array.isArray(result.content) ? result.content.map((block) => block?.type === 'text' ? block.text : block?.type).join('\n')
          : result.content;
      if (!(typeof resultText === 'string' && resultText.length > 0)
        && !(result.details && typeof result.details === 'object')) continue;
      completed.push(JSON.stringify({ name: call.name, arguments: call.arguments,
        result: stableValue(resultText), details: stableValue(result.details ?? null), isError: result.isError === true }));
      pending.delete(callId);
    }
  }
  return completed;
}

export function hasRepeatedNativeToolCycle(operations) {
  return repeatedNativeToolCycle(operations) !== null;
}

function repeatedNativeToolCycle(operations) {
  for (let period = 1; period * 3 <= operations.length; period += 1) {
    const first = operations.slice(-period * 3, -period * 2);
    const second = operations.slice(-period * 2, -period);
    const third = operations.slice(-period);
    if (first.every((operation, index) => operation === second[index] && operation === third[index])) return first;
  }
  return null;
}

export function shouldStopForNoProgressToolDecision(operations, text) {
  const cycle = repeatedNativeToolCycle(operations);
  if (!cycle || typeof text !== 'string') return false;
  try {
    const proposed = JSON.parse(text)?.content?.filter((block) => block?.type === 'toolCall') || [];
    if (!proposed.length) return false;
    return proposed.length <= cycle.length && proposed.every((block, index) => {
      if (typeof block?.name !== 'string' || !block.arguments || typeof block.arguments !== 'object'
        || Array.isArray(block.arguments)) return false;
      let prior;
      try { prior = JSON.parse(cycle[index]); } catch { return false; }
      return prior?.name === block.name && JSON.stringify(prior.arguments) === JSON.stringify(stableValue(block.arguments));
    });
  }
  catch { return false; }
}

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

function nativeToolReceiptSummaryPersistenceFailure(writeError, priorError = null) {
  if (!writeError) return null;
  const error = Object.assign(new Error('Native OmO tool receipt completeness could not be persisted.'), {
    code: 'OMO_TOOL_RECEIPT_SUMMARY_PERSIST_FAILED', cause: writeError,
  });
  if (priorError) error.priorError = priorError;
  return error;
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
    const failureDetail = nativeProviderFailureDetail(event.failure);
    const failureCode = typeof event.failure === 'object' && event.failure
      ? String(event.failure.category || event.failure.code || '').toLowerCase() : '';
    const isGenericBridgeFailure = failureDetail === 'The host rejected or failed this model request.'
      || (failureCode === 'unknown' && /provider returned an error that could not be classified/iu.test(failureDetail || ''));
    if (isGenericBridgeFailure) return safeNativeError(previous || assistantError || nativeProviderFailureMessage(event.failure));
    if (previous && !failureDetail) return safeNativeError(previous);
    if (failureDetail) return nativeProviderFailureMessage(event.failure);
    return safeNativeError(assistantError || nativeProviderFailureMessage(event.failure));
  }
  return assistantError;
}

const NATIVE_ROLE_TOOLS = Object.freeze({
  Lead: { names: ['read', 'grep', 'find', 'ls'], permission: 'read-only' },
  Developer: { names: ['read', 'write', 'edit', 'grep', 'find', 'ls'], permission: 'workspace' },
  Reviewer: { names: ['read', 'grep', 'find', 'ls'], permission: 'read-only' },
  Chat: { names: ['read', 'grep', 'find', 'ls'], permission: 'read-only' },
});

export function nativeRoleTools(role, conversation = false) {
  const value = NATIVE_ROLE_TOOLS[role] || { names: [], permission: 'read-only' };
  return conversation && role === 'Developer' ? { ...value, names: [...value.names, 'bash', 'delegate_readonly', 'verify_behavior'] } : value;
}

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
  promptAdmitted, modelConfirmed, payload, allowedTools, modelId = CODEX_BRIDGE_MODEL_ID }) {
  return !failed && !aborted && !childExited && !childKilled && !pending && promptAdmitted && modelConfirmed
    && payload?.provider === CODEX_BRIDGE_PROVIDER_ID && payload?.modelId === modelId
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
  role, prompt, cwd, runModelDecision, timeoutMs = 20 * 60_000, idleTimeoutMs = null, signal = null,
  stopOnIdenticalDecision = false,
  allowedWritePaths = [],
  conversation = false,
  decisionOnly = false,
  modelSelection = null, onDelegate = null, onBehaviorCheck = null,
  readRoots = [],
  commandRegistryPath = null,
  onNativeStarted = null,
  homeDir = path.join(ROOT, '.irixi-runtime', 'omo', 'home'),
  piAiModulePath = null,
  executable = OMO_NATIVE_BINARY,
  toolReceiptBinding = null,
  toolReceiptWorkspaceRoot = null,
  onToolReceipt = null,
  onToolReceiptSummary = null,
}) {
  if (!Object.hasOwn(NATIVE_ROLE_TOOLS, role) || typeof prompt !== 'string' || !prompt.trim()
    || typeof runModelDecision !== 'function') throw new Error('Native OmO role request is incomplete.');
  const modelId = modelSelection?.model || CODEX_BRIDGE_MODEL_ID;
  if (!/^[a-zA-Z0-9._-]+$/u.test(modelId)) throw new Error('Invalid host model.');
  const installMetadata = await readInstallMetadata(homeDir);
  const installedVersion = installMetadata.version;
  const resolvedPiAiModulePath = await resolvePiAiModulePath(installMetadata, piAiModulePath);
  const tools = conversation && role === 'Chat' && decisionOnly ? { names: [], permission: 'read-only' } : nativeRoleTools(role, conversation);
  if (['Developer', 'Reviewer'].includes(role)) {
    if (!cwd || !path.isAbsolute(cwd)) throw new Error('OmO worker role requires its registered absolute worktree.');
    cwd = conversation ? await fsp.realpath(cwd) : await assertSafeWorkspaceTree(cwd);
  }
  if (!Array.isArray(allowedWritePaths) || allowedWritePaths.some((item) => typeof item !== 'string' || !item
    || path.isAbsolute(item) || item.split(/[\\/]+/u).includes('..'))) throw new Error('OmO writable scope is invalid.');
  // OmO parses extension flags as a map: repeating --permission overwrites
  // earlier rules. Its permission parser accepts a comma-separated list.
  const permissionRules = [
    ...(conversation ? ['external_directory=allow'] : []),
    ...(conversation && role === 'Developer' && onDelegate ? ['delegate_readonly=allow'] : []),
    ...(conversation && role === 'Developer' && onBehaviorCheck ? ['verify_behavior=allow'] : []),
  ];
  const args = [
    '--mode', 'rpc', '--session-runtime', 'in-process', '--no-session', '--no-extensions', '--extension', OMO_PROVIDER_EXTENSION,
    '--no-skills', '--no-prompt-templates', '--no-themes', '--no-context-files', '--no-model-fallback',
    '--provider', CODEX_BRIDGE_PROVIDER_ID, '--model', modelId,
    ...(tools.names.length ? ['--tools', tools.names.join(',')] : ['--no-tools']),
    '--permission-preset', tools.permission,
    // Scope is enforced by the host file guards and command OS sandbox. Do not
    // leave RPC waiting for a second, invisible external-directory confirmation.
    ...(permissionRules.length ? ['--permission', permissionRules.join(',')] : []),
  ];
  const isolatedHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'irixi-omo-session-'));
  const isolatedAgentDir = path.join(isolatedHome, '.omo', 'agent');
  const commandRegistry = commandRegistryPath || path.join(isolatedHome, 'command-processes.jsonl');
  if (conversation && commandRegistryPath) {
    if (!path.isAbsolute(commandRegistryPath)) throw new Error('Command recovery registry must be an absolute host path.');
    await fsp.mkdir(path.dirname(commandRegistryPath), { recursive: true, mode: 0o700 });
    await fsp.writeFile(commandRegistryPath, '', { mode: 0o600, flag: 'wx' });
  }
  let bridgeCleanup = null;
  let bridgeSocketPath = null;
  let bridgeServer = null;
  try {
    await fsp.chmod(isolatedHome, 0o700);
    await fsp.mkdir(isolatedAgentDir, { recursive: true, mode: 0o700 });
    await fsp.chmod(isolatedAgentDir, 0o700);
    const bridge = await createPrivateBridgeServer(conversation ? os.tmpdir() : null);
    bridgeCleanup = bridge.cleanup;
    bridgeSocketPath = bridge.path;
    bridgeServer = bridge.server;
  } catch (error) {
    await bridgeCleanup?.();
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
      IRIXI_OMO_MODEL_ID: modelId,
      IRIXI_OMO_WORKSPACE_ROOT: cwd || ROOT,
      IRIXI_OMO_ALLOWED_WRITE_PATHS: JSON.stringify(allowedWritePaths),
      IRIXI_OMO_CONVERSATION: conversation ? '1' : '0',
      IRIXI_OMO_READ_ROOTS: JSON.stringify(readRoots),
      IRIXI_OMO_COMMAND_REGISTRY: commandRegistry,
      SENPI_NO_FALLBACK: '1',
      PATH: `${path.dirname(executable)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: conversation && process.platform !== 'win32',
  });
  const childClosed = new Promise((resolve) => child.once('close', resolve));
  let resolveNativeStarted;
  let rejectNativeStarted;
  const nativeStarted = new Promise((resolve, reject) => {
    resolveNativeStarted = resolve;
    rejectNativeStarted = reject;
  });
  child.once('spawn', () => {
    Promise.resolve().then(() => onNativeStarted?.({
      pid: child.pid || null, role, executablePath: child.spawnfile || executable,
      argv: Array.isArray(child.spawnargs) ? [...child.spawnargs] : [...args],
      ...(conversation ? { commandRegistryPath: commandRegistry } : {}),
    })).then(resolveNativeStarted, (error) => {
      rejectNativeStarted(error);
      failProcess(error);
    });
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
  let toolReceiptWriteError = null;
  let toolReceiptSummaryWriteError = null;
  let toolReceiptWriteQueue = Promise.resolve();
  const receiptCollector = createNativeToolReceiptCollector({
    binding: toolReceiptBinding, workspaceRoot: toolReceiptWorkspaceRoot,
    onReceipt: typeof onToolReceipt === 'function' ? (receipt) => {
      toolReceiptWriteQueue = toolReceiptWriteQueue.then(() => onToolReceipt(receipt)).catch((error) => {
        toolReceiptWriteError ||= error;
      });
    } : null,
  });
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
    if (child.exitCode === null && !child.killed) {
      if (conversation && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
      child.kill('SIGTERM');
    }
  };
  const rpcWaiters = new Map();
  const modelCalls = new Set();
  let providerDecisionPending = false;
  let watchdog = null;
  const timeout = new Promise((_, reject) => {
    const expire = () => {
      const error = Object.assign(new Error('Native OmO role exceeded its execution timeout.'), { code: 'OMO_ROLE_TIMEOUT' });
      failProcess(error);
      reject(error);
    };
    watchdog = createNativeSessionWatchdog(timeoutMs, idleTimeoutMs, expire);
    child.once('close', () => watchdog?.close());
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
    const repeatedToolCycle = stopOnIdenticalDecision
      && hasRepeatedNativeToolCycle(completedNativeToolOperations(payload.messages));
    const permittedTools = new Set(tools.names);
    if (!canAcceptNativeProviderRequest({ failed: false, aborted: false, childExited: false, childKilled: false,
      pending: providerDecisionPending, promptAdmitted, modelConfirmed: selectedModelConfirmed, payload, modelId, allowedTools: permittedTools })) {
      failProcess(new Error(providerDecisionPending
        ? 'Native OmO requested overlapping provider decisions; the run was stopped.'
        : 'Native OmO requested a model decision before prompt admission or outside its registered provider/tool scope.'));
      return;
    }
    watchdog?.reset();
    providerDecisionPending = true;
    providerCalls += 1;
    const job = Promise.resolve().then(() => runModelDecision(payload, providerCalls, providerAbort.signal)).then(async (text) => {
      if (processError || providerAbort.signal.aborted || child.exitCode !== null || child.killed) return;
      if (typeof text !== 'string' || !text.trim()) throw new Error('Host returned an empty model decision.');
      if (repeatedToolCycle && shouldStopForNoProgressToolDecision(
        completedNativeToolOperations(payload.messages), text)) {
        throw Object.assign(new Error('The same OmO tool operations repeated with identical results; no progress was made.'), {
          code: 'OMO_NO_PROGRESS_LOOP',
        });
      }
      const response = `${JSON.stringify({ id: requestId, ok: true, text })}\n`;
      if (Buffer.byteLength(response, 'utf8') > MAX_RPC_LINE_BYTES) throw new Error('Host model decision exceeded the safe limit.');
      if (processError || providerAbort.signal.aborted || child.exitCode !== null || child.killed) return;
      if (!socket.write(response)) await new Promise((resolve, reject) => {
        socket.once('drain', resolve); socket.once('error', reject);
      });
      watchdog?.reset();
    }).catch((error) => {
      failProcess(error);
      const response = `${JSON.stringify({ id: requestId, ok: false,
        error: safeNativeError(processError?.message || error?.message) || 'The host rejected or failed this model request.',
        code: processError?.code || error?.code || 'HOST_MODEL_REQUEST_FAILED' })}\n`;
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
        watchdog?.reset();
        const id = event.id || waiter.id;
        rpcWaiters.delete(id);
        if (event.success === false) waiter.reject(new Error(`Native OmO RPC ${waiter.command} was rejected: ${safeNativeError(event.error) || 'unknown reason'}.`));
        else waiter.resolve(event.data ?? event);
      } else if (event.type === 'extension_ui_request' && conversation && ['select', 'confirm', 'input', 'editor', 'question'].includes(event.method)) {
        child.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id, cancelled: true })}\n`);
        failProcess(Object.assign(new Error(`工具系统要求当前页面无法显示的交互（${String(event.method || 'unknown')}），本轮已停止。这不是你点击了拒绝；需要检查工具连接配置。`), { code: 'OMO_INTERACTIVE_STEP_UNAVAILABLE' }));
      } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
        watchdog?.reset();
        const msg = event.message;
        const text = (msg.content || []).filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text).join('\n').trim();
        finalText = text;
        finalAssistantStopReason = msg.stopReason || null;
        lastAssistantError = updateNativeFailureFromEvent(event, lastAssistantError);
      } else if (event.type === 'agent_end') {
        watchdog?.reset();
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
        watchdog?.reset();
        settled = true;
      } else if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) {
        watchdog?.reset();
        receiptCollector.ingest(event);
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
        if (['delegate_readonly', 'verify_behavior'].includes(message?.kind)) {
          const hostTool = message.kind === 'delegate_readonly' ? onDelegate : onBehaviorCheck;
          if (!conversation || role !== 'Developer' || typeof hostTool !== 'function' || !promptAdmitted || providerAbort.signal.aborted) {
            socket.write(`${JSON.stringify({ id: message.id, ok: false, error: 'Subtask dispatch is unavailable in this scope.' })}\n`); continue;
          }
          const job = Promise.resolve().then(() => hostTool(message.payload, providerAbort.signal)).then((result) => {
            if (!providerAbort.signal.aborted && socket.writable) socket.write(`${JSON.stringify({ id: message.id, ok: true, text: JSON.stringify(result) })}\n`);
          }).catch((error) => {
            if (!providerAbort.signal.aborted && socket.writable) socket.write(`${JSON.stringify({ id: message.id, ok: false, error: safeNativeError(error.message) })}\n`);
          }).finally(() => modelCalls.delete(job));
          modelCalls.add(job);
        } else handleModelRequest(message, socket);
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
  child.once('error', (error) => {
    rejectNativeStarted(error);
    failProcess(error);
    for (const item of rpcWaiters.values()) item.reject(error);
    rpcWaiters.clear();
  });
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
      await nativeStarted;
      runtimeInfo = await waitForRpc('get_protocol_info');
      await waitForRpc('set_model', { provider: CODEX_BRIDGE_PROVIDER_ID, modelId });
      sessionState = await waitForRpc('get_state');
      receiptCollector.setSessionId(sessionState?.sessionId);
      if (sessionState?.model?.provider !== CODEX_BRIDGE_PROVIDER_ID || sessionState?.model?.id !== modelId) {
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
      const toolReceiptSummary = receiptCollector.finish();
      await toolReceiptWriteQueue;
      if (toolReceiptWriteError) throw Object.assign(new Error('Native OmO tool receipts could not be persisted.'), {
        code: 'OMO_TOOL_RECEIPT_PERSIST_FAILED', cause: toolReceiptWriteError,
      });
      return {
        status: 'model_returned', output: { text: finalText }, provider: CODEX_BRIDGE_PROVIDER_ID,
        model: modelId, providerDecisionRequests: providerCalls,
        sessionId: typeof finalState.sessionId === 'string' && finalState.sessionId.trim() ? finalState.sessionId : null,
        toolReceiptSummary,
        runtime: { installedVersion, engineVersion: runtimeInfo?.engineVersion || null,
          runtimeBuildId: runtimeInfo?.runtimeBuildId || null, protocolVersion: runtimeInfo?.protocolVersion || null },
      };
    };
    return await Promise.race([run(), timeout]);
  } finally {
    providerAbort.abort();
    await Promise.allSettled([...modelCalls]);
    const toolReceiptSummary = receiptCollector.finish({ cancelled: signal?.aborted === true || processError?.code === 'ABORTED' });
    await toolReceiptWriteQueue;
    if (sessionState?.sessionId && typeof onToolReceiptSummary === 'function') {
      const errorCounts = {};
      for (const error of toolReceiptSummary.errors) {
        const code = String(error?.code || 'unknown').slice(0, 80);
        errorCounts[code] = (errorCounts[code] || 0) + (Number.isSafeInteger(error?.droppedEventCount) ? error.droppedEventCount : 1);
      }
      try {
        await onToolReceiptSummary({ sessionId: sessionState.sessionId, receiptCount: toolReceiptSummary.receipts.length,
          complete: toolReceiptSummary.complete, overflowEventCount: toolReceiptSummary.overflowEventCount,
          errorCounts });
      } catch (error) { toolReceiptSummaryWriteError = error; }
    }
    if (toolReceiptWriteError && !processError) processError = Object.assign(new Error('Native OmO tool receipts could not be persisted.'), {
      code: 'OMO_TOOL_RECEIPT_PERSIST_FAILED', cause: toolReceiptWriteError,
    });
    watchdog?.close();
    signal?.removeEventListener('abort', abort);
    try { child.stdin.end(); } catch {}
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.killed) child.kill('SIGTERM');
      const forceKill = setTimeout(() => {
        if (conversation && process.platform !== 'win32') { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
        child.kill('SIGKILL');
      }, 1_000);
      forceKill.unref?.();
      await childClosed;
      clearTimeout(forceKill);
    } else await childClosed;
    bridgeSocket?.destroy();
    if (conversation) {
      await cleanupCommandRegistry(commandRegistry);
    }
    if (conversation && process.platform !== 'win32' && child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    }
    await bridgeCleanup?.();
    await fsp.rm(isolatedHome, { recursive: true, force: true });
    const summaryPersistenceFailure = nativeToolReceiptSummaryPersistenceFailure(toolReceiptSummaryWriteError, processError);
    if (summaryPersistenceFailure) throw summaryPersistenceFailure;
  }
}

export const __test = { safeNativeError, nativeProviderFailureMessage, updateNativeFailureFromEvent,
  nativeToolReceiptSummaryPersistenceFailure, createPrivateBridgeServer };
