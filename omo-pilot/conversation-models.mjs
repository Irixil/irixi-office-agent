import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveCodexRuntime } from '../app/codex-runtime.mjs';

export const DEFAULT_SELECTION = Object.freeze({ provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' });

// Only capability metadata is read. Account identity and credentials never enter the product catalogue.
export async function readModelCatalogue() {
  const runtime = resolveCodexRuntime();
  try {
    const cache = JSON.parse(await fs.readFile(path.join(runtime.codexHome, 'models_cache.json'), 'utf8'));
    const models = cache.models.filter((m) => m.visibility === 'list' && m.supported_in_api !== false
      && m.input_modalities?.includes('text') && /^[a-zA-Z0-9._-]+$/u.test(m.slug)).map((m) => ({
      provider: 'desktop-codex', id: m.slug, name: m.display_name || m.slug,
      efforts: (m.supported_reasoning_levels || []).map((x) => x.effort).filter((x) => /^[a-z]+$/u.test(x)),
      defaultEffort: m.default_reasoning_level, source: 'desktop-cli-catalogue',
    }));
    return { models, fetchedAt: cache.fetched_at, providers: [
      { id: 'desktop-codex', name: 'Desktop Codex CLI', status: runtime.executable ? 'connected' : 'unavailable' },
      { id: 'claude-code', name: 'Claude Code', status: 'not_connected' },
      { id: 'deepseek', name: 'DeepSeek', status: 'not_connected' },
    ] };
  } catch {
    return { models: [], providers: [{ id: 'desktop-codex', name: 'Desktop Codex CLI', status: 'unavailable' }],
      error: '尚未取得当前连接的模型目录。请打开 Desktop Codex 后刷新；草稿会保留。' };
  }
}

export function validateModelSelection(catalogue, selection) {
  if (selection?.provider === 'deepseek' || /^deepseek(?:[-_.]|$)/iu.test(selection?.model || '')) throw new Error('DeepSeek 本轮仅限连接验证，不能用于项目、助手或恢复。');
  const model = catalogue.models.find((m) => m.provider === selection?.provider && m.id === selection?.model);
  if (!model) throw new Error('所选模型当前不可用。请刷新模型列表；没有自动换用其他模型。');
  if (!model.efforts.includes(selection.effort)) throw new Error('该模型不支持所选思考强度。请重新选择，草稿已保留。');
  if (selection.connectionId != null && selection.connectionId !== 'openai-api-key') throw new Error('该模型连接不能用于项目执行，未自动切换。');
  if (selection.connectionId === 'openai-api-key' && model.provider !== 'desktop-codex') throw new Error('API Key 连接仅支持当前 Codex CLI 路径。');
  if (selection.connectionId === 'openai-api-key' && selection.connectionRevision != null && (typeof selection.connectionRevision !== 'string' || !selection.connectionRevision || selection.connectionRevision.length > 160)) throw new Error('连接版本无效。');
  return { provider: model.provider, model: model.id, effort: selection.effort,
    ...(selection.connectionId === 'openai-api-key' ? { connectionId: selection.connectionId, ...(selection.connectionRevision ? { connectionRevision: selection.connectionRevision } : {}) } : {}) };
}
