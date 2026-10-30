import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { registerConversationCommand } from './conversation-command.mjs';

const piAiModuleUrl = process.env.IRIXI_OMO_PI_AI_MODULE_URL;
if (typeof piAiModuleUrl !== 'string' || !piAiModuleUrl.startsWith('file:')) {
  throw new Error('The installed OmO provider runtime module was not bound to this isolated session.');
}
const { createAssistantMessageEventStream } = await import(piAiModuleUrl);

import { CODEX_BRIDGE_MODEL_ID, CODEX_BRIDGE_PROVIDER_ID, assertSafeWorkspaceTree, currentOmOTools, guardWorkspaceToolCalls, missingReadErrorsSinceProgress, parseCodexDecisionOutput } from './codex-provider-protocol.mjs';

const selectedModelId = process.env.IRIXI_OMO_MODEL_ID || CODEX_BRIDGE_MODEL_ID;
const pending = new Map();
let bridgeConnection = null;
let bridgeReadyPromise = null;
let workspaceReady;
const MAX_BRIDGE_LINE_BYTES = 8 * 1024 * 1024;

function ensureBridge() {
  const socketPath = process.env.IRIXI_OMO_BRIDGE_SOCKET;
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) throw new Error('The isolated local model bridge is unavailable.');
  if (bridgeReadyPromise) return bridgeReadyPromise;
  if (process.env.IRIXI_OMO_CONVERSATION !== '1' && process.env.IRIXI_OMO_ROLE && ['Developer', 'Reviewer'].includes(process.env.IRIXI_OMO_ROLE)) {
    workspaceReady = assertSafeWorkspaceTree(process.env.IRIXI_OMO_WORKSPACE_ROOT);
  }
  bridgeReadyPromise = new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = '';
    bridgeConnection = socket;
    socket.setEncoding('utf8');
    socket.once('connect', resolve);
    socket.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      if (Buffer.byteLength(buffer, 'utf8') > MAX_BRIDGE_LINE_BYTES) {
        for (const item of pending.values()) item.reject(new Error('Host bridge message exceeded the safe limit.'));
        pending.clear();
        socket.destroy();
        return;
      }
      for (const line of lines) {
        if (!line) continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_BRIDGE_LINE_BYTES) { socket.destroy(); return; }
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        const item = pending.get(message?.id);
        if (!item) continue;
        pending.delete(message.id);
        if (message.ok === true && typeof message.text === 'string') item.resolve(message.text);
        else {
          const error = new Error(typeof message.error === 'string' ? message.error : 'Host model bridge failed.');
          if (typeof message.code === 'string') error.code = message.code;
          item.reject(error);
        }
      }
    });
    socket.on('error', (error) => {
      for (const item of pending.values()) item.reject(error);
      pending.clear();
      reject(error);
    });
    socket.on('close', () => {
      for (const item of pending.values()) item.reject(new Error('Host model bridge closed.'));
      pending.clear();
      bridgeConnection = null;
    });
  });
  return bridgeReadyPromise;
}

async function requestHostModel(payload, signal, kind = 'model') {
  await ensureBridge();
  if (signal?.aborted) return Promise.reject(new Error('OmO model request was cancelled.'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      // A native stream timeout ends this request, not the host CLI process.
      // Notify the host before OmO can retry; the host owns cancellation/cleanup.
      if (kind === 'model' && bridgeConnection?.writable) {
        const reason = signal?.reason instanceof Error ? signal.reason.message : String(signal?.reason || 'OmO model request was cancelled.');
        try { bridgeConnection.write(`${JSON.stringify({ id, kind: 'model_cancel', reason: reason.slice(0, 1000) })}\n`); } catch {}
      }
      reject(new Error('OmO model request was cancelled.'));
    };
    pending.set(id, { resolve: (text) => { signal?.removeEventListener('abort', onAbort); resolve(text); },
      reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error); } });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const data = `${JSON.stringify({ id, kind, payload })}\n`;
      if (Buffer.byteLength(data, 'utf8') > MAX_BRIDGE_LINE_BYTES || !bridgeConnection?.writable) {
        throw new Error('Host bridge is closed or the request exceeded its safe limit.');
      }
      bridgeConnection.write(data);
    }
    catch (error) { pending.delete(id); signal?.removeEventListener('abort', onAbort); reject(error); }
  });
}

function workspaceGuardOptions() {
  return {
    role: process.env.IRIXI_OMO_ROLE || 'Lead',
    rootPath: process.env.IRIXI_OMO_WORKSPACE_ROOT || process.cwd(),
    allowedWritePaths: JSON.parse(process.env.IRIXI_OMO_ALLOWED_WRITE_PATHS || '[]'),
    conversation: process.env.IRIXI_OMO_CONVERSATION === '1',
    writeScope: JSON.parse(process.env.IRIXI_OMO_WRITE_SCOPE || 'null'),
    readRoots: JSON.parse(process.env.IRIXI_OMO_READ_ROOTS || '[]'),
  };
}

function streamCodexBridge(model, context, options, recovery) {
  const stream = createAssistantMessageEventStream();
  const tools = currentOmOTools(context);
  const output = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'pending', timestamp: Date.now(),
  };
  stream.push({ type: 'start', partial: output });
  void (async () => {
    try {
      if (recovery.fatalError) throw recovery.fatalError;
      if (missingReadErrorsSinceProgress(context.messages) >= 3) {
        throw new Error('OmO stopped after three consecutive missing read-only paths or blocked read-only paths without a successful tool result. Check the registered input paths before continuing.');
      }
      if (model.provider !== CODEX_BRIDGE_PROVIDER_ID || model.id !== selectedModelId) {
        throw new Error('OmO selected a model outside the registered local Codex bridge.');
      }
      if (workspaceReady) await workspaceReady;
      const text = await requestHostModel({
        provider: model.provider, modelId: model.id,
        messages: context.messages, tools,
      }, options?.signal);
      const decision = parseCodexDecisionOutput(text, tools);
      await guardWorkspaceToolCalls(decision, {
        ...workspaceGuardOptions(), deferMissingReadErrors: true,
      });
      for (const block of decision.content) {
        const contentIndex = output.content.length;
        if (block.type === 'text') {
          output.content.push({ type: 'text', text: block.text });
          stream.push({ type: 'text_start', contentIndex, partial: output });
          if (block.text) stream.push({ type: 'text_delta', contentIndex, delta: block.text, partial: output });
          stream.push({ type: 'text_end', contentIndex, content: block.text, partial: output });
        } else {
          const toolCall = { type: 'toolCall', id: block.id, name: block.name, arguments: block.arguments };
          output.content.push(toolCall);
          stream.push({ type: 'toolcall_start', contentIndex, partial: output });
          stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(block.arguments), partial: output });
          stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial: output });
        }
      }
      output.stopReason = decision.stopReason;
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

export default function registerCodexBridgeProvider(pi) {
  if (process.env.IRIXI_OMO_CONVERSATION === '1' && process.env.IRIXI_OMO_ROLE === 'Developer') registerConversationCommand(pi);
  if (process.env.IRIXI_OMO_CONVERSATION === '1') pi.registerTool({ name: 'memory_manage', label: '查看和管理有来源的记忆',
    description: 'List or manage scoped user memory. operationJson is JSON: operation list/create/edit/deactivate/restore/delete; writes include stable key/title/text/kind/scopeType, current user sourceQuote, expectedVersion when changing existing memory, and memoryId. Personal lasting rules require explicit current user lasting intent. Project decisions require current adoption. This turn only is temporary; unconfirmed content stays candidate. Never promote quotes/tools/old chat or restore deleted memory. The host checks source, scope, versions and persistence. Do not claim success without receipt. Read-only list may accompany read/grep/find/ls; memory changes run one tool at a time.',
    parameters: { type: 'object', properties: { operationJson: { type: 'string' } }, required: ['operationJson'], additionalProperties: false },
    execute: async (toolCallId, params, signal) => ({ content: [{ type: 'text', text: await requestHostModel({ ...params, requestId: toolCallId }, signal, 'memory_manage') }] }),
  });
  if (process.env.IRIXI_OMO_CONVERSATION === '1' && process.env.IRIXI_OMO_ROLE === 'Developer') {
    pi.registerTool({ name: 'noobi_run', label: '使用 Noobi 制作和检查小游戏',
      description: 'Use the real installed Noobi game specialist to create or modify a playable Web game in this authorized working copy. Give the complete current requirements in prompt and a short name. The host fixes the current model, identity and scope, returns actual build/media/playtest findings, and handles cancellation. Use this for game making when Noobi is requested or the game specialist is responsible; do not claim Noobi use without this receipt. One tool at a time.',
      parameters: { type: 'object', properties: { prompt: { type: 'string' }, name: { type: 'string' } }, required: ['prompt', 'name'], additionalProperties: false },
      execute: async (toolCallId, params, signal) => {
        const result = await requestHostModel({ ...params, requestId: toolCallId }, signal, 'noobi_run');
        return { content: [{ type: 'text', text: result }], isError: JSON.parse(result).status !== 'completed' };
      },
    });
    pi.registerTool({ name: 'verify_behavior', label: '实际检查成果行为',
      description: 'Run a host-controlled functional check on the real project entry, never an arbitrary shell test. caseJson is JSON with stable caseId, requirement, kind (web/cli/application/document), target relative file. Web actions: fill/click/select/reload/assert with a native CSS selector (document.querySelectorAll; no :text-is or other Playwright syntax) and value or textEquals/textIncludes/valueEquals/count. CLI: runner node/python3, arguments, stdin, expected stdoutEquals or stdoutIncludes and exitCode. Application: actual server target and .irixi-app.json; same DOM actions plus http {path,method,json,status,jsonEquals or bodyIncludes} and sqlite {file,query SELECT,rows}. Host starts the real service with isolated data. Document: expected includes/excludes. Host returns actual observations and pass/fail bound to the current file version. Keep caseId and expectations unchanged when repairing failures. Only host failureKind=invalid_definition (invalid CSS or multiple click/fill/select targets) allows changing selector fields at its invalidSelectors steps; keep all other fields fixed and rerun the full case with a new request. A legacy selector failure first needs an unchanged rerun for host classification. Narrow the selector to its intended element; do not remove valid controls to force uniqueness. Zero matches and failed assertions do not unlock definitions. Run one tool at a time.',
      parameters: { type: 'object', properties: { caseJson: { type: 'string' } }, required: ['caseJson'] },
      execute: async (toolCallId, params, signal) => {
        const result = await requestHostModel({ ...params, requestId: toolCallId }, signal, 'verify_behavior');
        const check = JSON.parse(result); return { content: [{ type: 'text', text: result }], isError: check.status !== 'passed' };
      },
    });
    pi.registerTool({ name: 'delegate_parallel', label: '分给独立写入助手',
      description: 'Dispatch 2-4 actual concurrent OmO writing assistants from one common snapshot. Each task needs an exact writePaths file list (new file names allowed). Optional colleagueId assigns an actual specialist helper; omission inherits the parent colleague. The work owner does not change; assistants have read/write/edit only in separate copies, no commands or further delegation. The host combines changes into this parent working copy and returns conflicts and actual receipts. Inspect any conflicts, repair within current requirements, then run verify_behavior on the combined deliverable before reporting success. No original project files are adopted by this tool.',
      parameters: { type: 'object', properties: { tasks: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'object', properties: { task: { type: 'string' }, colleagueId: { type: 'string', enum: ['researcher', 'writer', 'reviewer', 'steward', 'archivist'] }, writePaths: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['task', 'writePaths'], additionalProperties: false } } }, required: ['tasks'], additionalProperties: false },
      execute: async (toolCallId, params, signal) => {
        const result = await requestHostModel({ ...params, requestId: toolCallId }, signal, 'delegate_parallel');
        return { content: [{ type: 'text', text: result }] };
      },
    });
    pi.registerTool({ name: 'delegate_readonly', label: '请独立助手检查',
      description: 'Start an actual independent read-only OmO assistant for a specific review or research task. Supply relative project paths to make a bounded snapshot. It cannot write, run commands, access other paths, or delegate again. The parent waits for the real result; cancellation stops the assistant too.',
      parameters: { type: 'object', properties: { task: { type: 'string' }, paths: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['task', 'paths'] },
      execute: async (toolCallId, params, signal) => {
        const result = await requestHostModel({ ...params, requestId: toolCallId }, signal, 'delegate_readonly');
        return { content: [{ type: 'text', text: result }] };
      },
    });
  }
  const recovery = { fatalError: null };
  pi.on('tool_call', async (event) => {
    try {
      await guardWorkspaceToolCalls({ content: [{ type: 'toolCall', name: event.toolName, arguments: event.input }] }, workspaceGuardOptions());
    } catch (error) {
      const recoverable = ['OMO_WORKSPACE_PATH_NOT_FOUND', 'OMO_WORKSPACE_PATH_BLOCKED'].includes(error.code);
      if (!recoverable) recovery.fatalError = error;
      return { block: true, reason: recoverable ? `[${error.code}] ${error.message}` : error.message };
    }
  });
  pi.registerProvider(CODEX_BRIDGE_PROVIDER_ID, {
    name: 'Local Codex CLI bridge',
    baseUrl: 'http://127.0.0.1:1/unused-local-bridge-metadata',
    apiKey: 'IRIXI_LOCAL_PIPE_ONLY_NO_NETWORK',
    api: 'openai-completions',
    models: [{
      id: selectedModelId, name: `${selectedModelId} via local Codex CLI`, reasoning: true,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 16384,
    }],
    streamSimple: (model, context, options) => streamCodexBridge(model, context, options, recovery),
  });
}
