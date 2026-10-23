import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

const piAiModuleUrl = process.env.IRIXI_OMO_PI_AI_MODULE_URL;
if (typeof piAiModuleUrl !== 'string' || !piAiModuleUrl.startsWith('file:')) {
  throw new Error('The installed OmO provider runtime module was not bound to this isolated session.');
}
const { createAssistantMessageEventStream } = await import(piAiModuleUrl);

import { CODEX_BRIDGE_MODEL_ID, CODEX_BRIDGE_PROVIDER_ID, assertSafeWorkspaceTree, currentOmOTools, guardWorkspaceToolCalls, parseCodexDecisionOutput } from './codex-provider-protocol.mjs';

const pending = new Map();
let bridgeConnection = null;
let bridgeReadyPromise = null;
let workspaceReady;
const MAX_BRIDGE_LINE_BYTES = 8 * 1024 * 1024;

function ensureBridge() {
  const socketPath = process.env.IRIXI_OMO_BRIDGE_SOCKET;
  if (typeof socketPath !== 'string' || !socketPath.startsWith('/')) throw new Error('The isolated local model bridge is unavailable.');
  if (bridgeReadyPromise) return bridgeReadyPromise;
  if (process.env.IRIXI_OMO_ROLE && ['Developer', 'Reviewer'].includes(process.env.IRIXI_OMO_ROLE)) {
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
        else item.reject(new Error(typeof message.error === 'string' ? message.error : 'Host model bridge failed.'));
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

async function requestHostModel(payload, signal) {
  await ensureBridge();
  if (signal?.aborted) return Promise.reject(new Error('OmO model request was cancelled.'));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      pending.delete(id);
      reject(new Error('OmO model request was cancelled.'));
    };
    pending.set(id, { resolve: (text) => { signal?.removeEventListener('abort', onAbort); resolve(text); },
      reject: (error) => { signal?.removeEventListener('abort', onAbort); reject(error); } });
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const data = `${JSON.stringify({ id, payload })}\n`;
      if (Buffer.byteLength(data, 'utf8') > MAX_BRIDGE_LINE_BYTES || !bridgeConnection?.writable) {
        throw new Error('Host bridge is closed or the request exceeded its safe limit.');
      }
      bridgeConnection.write(data);
    }
    catch (error) { pending.delete(id); signal?.removeEventListener('abort', onAbort); reject(error); }
  });
}

function streamCodexBridge(model, context, options) {
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
      if (model.provider !== CODEX_BRIDGE_PROVIDER_ID || model.id !== CODEX_BRIDGE_MODEL_ID) {
        throw new Error('OmO selected a model outside the registered local Codex bridge.');
      }
      if (workspaceReady) await workspaceReady;
      const text = await requestHostModel({
        provider: model.provider, modelId: model.id,
        messages: context.messages, tools,
      }, options?.signal);
      const decision = parseCodexDecisionOutput(text, tools);
      await guardWorkspaceToolCalls(decision, {
        role: process.env.IRIXI_OMO_ROLE || 'Lead',
        rootPath: process.env.IRIXI_OMO_WORKSPACE_ROOT || process.cwd(),
        allowedWritePaths: JSON.parse(process.env.IRIXI_OMO_ALLOWED_WRITE_PATHS || '[]'),
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
  pi.registerProvider(CODEX_BRIDGE_PROVIDER_ID, {
    name: 'Local Codex CLI bridge',
    baseUrl: 'http://127.0.0.1:1/unused-local-bridge-metadata',
    apiKey: 'IRIXI_LOCAL_PIPE_ONLY_NO_NETWORK',
    api: 'openai-completions',
    models: [{
      id: CODEX_BRIDGE_MODEL_ID, name: 'GPT-6 Luna via local Codex CLI', reasoning: true,
      input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 16384,
    }],
    streamSimple: streamCodexBridge,
  });
}
