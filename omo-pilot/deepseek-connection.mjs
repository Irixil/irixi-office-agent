import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const DEEPSEEK_MODEL = 'deepseek-flash';
export const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/chat/completions';
const messages = {
  unconfigured: '尚未配置 DeepSeek 官方密钥。',
  unverified: '密钥已配置，连接尚未验证。',
  verifying: '正在验证连接；只发送固定短句。',
  verified: '连接已验证，开发能力未验证。',
  interrupted: '上次验证未完成；没有自动重试。',
  credential_unavailable: '无法读取本产品的凭据状态；连接未验证。',
  credential_changed: '密钥已变更；旧验证失效。',
  authentication_failed: '官方接口未接受此密钥。请检查 DeepSeek 专用密钥。',
  insufficient_balance: '官方接口提示余额不足；没有自动重试。',
  access_denied: '官方接口拒绝访问此模型。没有改用其他模型。',
  rate_limited: '官方接口限制请求频率；没有自动重试。',
  http_failed: '官方接口未返回成功响应；连接未验证。',
  connection_failed: '无法完成官方接口请求；连接未验证。',
  timed_out: '连接验证超时；没有自动重试。',
  invalid_response: '未取得目标模型的有效非空文本；连接未验证。',
};

// Credentials are supplied only by the host's fixed DeepSeek Keychain adapter.
// This module never accepts a browser key, URL, prompt, tools, or model override.
export class DeepSeekConnection {
  constructor({ runtimeDir, readCredential, credentialStatus, fetchImpl = fetch }) {
    this.file = path.join(runtimeDir, 'connections', 'deepseek.json');
    this.readCredential = readCredential; this.credentialStatus = credentialStatus;
    this.fetchImpl = fetchImpl; this.pending = null; this.writes = Promise.resolve();
    this.state = { version: 1, configured: false, revision: null, status: 'unconfigured', verification: null, attempts: [] };
  }
  async init() {
    try { this.state = JSON.parse(await fs.readFile(this.file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('DeepSeek 连接记录无法读取；原记录未覆盖。'); }
    if (this.state.version !== 1 || !Array.isArray(this.state.attempts)) throw new Error('DeepSeek 连接记录格式不兼容；原记录未覆盖。');
    if (this.state.status === 'verifying') {
      this.state.status = 'interrupted';
      const attempt = this.state.attempts.at(-1);
      if (attempt?.status === 'verifying') { attempt.status = 'interrupted'; attempt.finishedAt = new Date().toISOString(); }
      await this.save();
    }
    await this.status(); return this;
  }
  save() {
    this.writes = this.writes.catch(() => {}).then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify(this.state, null, 2) + '\n', { mode: 0o600 });
      await fs.rename(temp, this.file);
    });
    return this.writes;
  }
  view() {
    return { provider: 'deepseek', purpose: 'connection-only', model: DEEPSEEK_MODEL,
      configured: this.state.configured, revision: this.state.revision, status: this.state.status,
      message: messages[this.state.status], developmentVerified: false, taskSelectable: false,
      verification: this.state.verification, attempts: this.state.attempts };
  }
  async status() {
    let meta;
    try { meta = await this.credentialStatus(); }
    catch { this.state.status = 'credential_unavailable'; this.state.verification = null; await this.save(); return this.view(); }
    if (meta.revision !== this.state.revision || meta.configured !== this.state.configured) {
      this.state.configured = meta.configured; this.state.revision = meta.revision;
      this.state.verification = null; this.state.status = meta.configured ? 'unverified' : 'unconfigured';
      await this.save();
    } else if (this.state.status === 'credential_unavailable') {
      this.state.status = meta.configured ? 'unverified' : 'unconfigured'; await this.save();
    }
    return this.view();
  }
  verify() {
    if (this.pending) return this.pending;
    this.pending = this.verifyOnce().finally(() => { this.pending = null; });
    return this.pending;
  }
  async verifyOnce() {
    const current = await this.status();
    if (!current.configured || current.status === 'credential_unavailable' || current.status === 'verified') return current;
    let credential;
    try { credential = await this.readCredential(); }
    catch { this.state.status = 'credential_unavailable'; return this.view(); }
    if (credential.revision !== current.revision) return this.status();
    const attempt = { id: randomUUID(), startedAt: new Date().toISOString(), revision: credential.revision,
      requestedModel: DEEPSEEK_MODEL, maxTokens: 256, thinking: 'disabled', status: 'verifying' };
    this.state.status = 'verifying'; this.state.attempts.push(attempt);
    // Persist the attempt before sending. Restarting never automatically retries it.
    await this.save();
    let code = 'connection_failed';
    try {
      const response = await this.fetchImpl(DEEPSEEK_ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential.key}` },
        body: JSON.stringify({ model: DEEPSEEK_MODEL, messages: [{ role: 'user', content: '请只回复：连接正常。' }],
          thinking: { type: 'disabled' }, max_tokens: 256, stream: false }),
      });
      credential = null;
      attempt.httpStatus = response.status;
      if (!response.ok) {
        code = ({ 401: 'authentication_failed', 402: 'insufficient_balance', 403: 'access_denied', 429: 'rate_limited' })[response.status] || 'http_failed';
        await response.body?.cancel();
      } else {
        code = 'invalid_response';
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > 65536) throw new Error('Response too large');
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const choice = body?.choices?.[0]; const text = choice?.message?.content;
        if (!body.error && body.object === 'chat.completion' && body.model === DEEPSEEK_MODEL
          && choice?.message?.role === 'assistant' && typeof text === 'string' && text.trim()
          && ['stop', 'length'].includes(choice.finish_reason) && !choice.message.tool_calls?.length
          && !(body.usage?.completion_tokens > 256)) {
          attempt.responseModel = body.model;
          attempt.textCharacters = text.trim().length;
          attempt.textSha256 = createHash('sha256').update(text).digest('hex');
          attempt.usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map((key) =>
            [key, Number.isSafeInteger(body.usage?.[key]) && body.usage[key] >= 0 ? body.usage[key] : null]));
          code = 'verified';
        }
      }
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') code = 'timed_out';
      // Never persist exception messages, response text, headers, or credentials.
    } finally { credential = null; }
    const latest = await this.status();
    if (latest.revision !== attempt.revision || !latest.configured) code = 'credential_changed';
    else if (latest.status === 'credential_unavailable') code = 'credential_unavailable';
    attempt.status = code; attempt.finishedAt = new Date().toISOString();
    this.state.status = latest.configured ? code : 'unconfigured';
    this.state.verification = code === 'verified' ? { attemptId: attempt.id, revision: attempt.revision,
      model: attempt.responseModel, verifiedAt: attempt.finishedAt } : null;
    await this.save(); return this.view();
  }
}
