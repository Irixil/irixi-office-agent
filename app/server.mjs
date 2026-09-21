import dns from 'node:dns/promises';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  acceptGoalReplacement,
  addMaterial,
  addSuggestion,
  buildPlan,
  confirmArtifact,
  correctSuggestion,
  createArtifact,
  createStore,
  createTask,
  event,
  publicTask,
  recordReview,
  reviseArtifact,
  setTaskState,
  assertExportAllowed,
} from './core.mjs';
import { createProviders } from './providers.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const publicRoot = path.join(moduleDir, 'public');
const artRoot = path.join(projectRoot, 'art');
const dataRoot = path.join(projectRoot, 'data', 'tasks');
const MAX_JSON_BYTES = 12 * 1024 * 1024;
const MAX_MATERIAL_BYTES = 1_500_000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
const activeJobs = new Map();

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

function processOutput(command, args, { timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let size = 0;
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => { size += chunk.length; if (size <= MAX_MATERIAL_BYTES) output.push(chunk); });
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (size > MAX_MATERIAL_BYTES) return reject(new Error('解析后的材料超过 1.5 MB 上限。'));
      if (code !== 0) return reject(new Error(Buffer.concat(errors).toString('utf8').trim() || `解析工具退出码 ${code}`));
      resolve(Buffer.concat(output).toString('utf8'));
    });
  });
}

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') || normalized.startsWith('::ffff:127.') || normalized.startsWith('::ffff:10.') || normalized.startsWith('::ffff:192.168.');
}

async function validateRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('网址格式不正确。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持不含账号信息的 HTTP/HTTPS 网址。');
  if (['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())) throw new Error('不能读取本机或内网网址。');
  const addresses = await dns.lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) throw new Error('不能读取本机、内网或保留地址。');
  return url;
}

function stripHtml(value) {
  return value.replaceAll(/<script[\s\S]*?<\/script>/gi, ' ').replaceAll(/<style[\s\S]*?<\/style>/gi, ' ')
    .replaceAll(/<[^>]+>/g, ' ').replaceAll('&nbsp;', ' ').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll(/\s+/g, ' ').trim();
}

async function fetchMaterial(value) {
  let current = await validateRemoteUrl(value);
  for (let redirect = 0; redirect < 4; redirect += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response;
    try { response = await fetch(current, { redirect: 'manual', signal: controller.signal, headers: { 'User-Agent': 'Irixi-Office-Agent/1.0' } }); }
    finally { clearTimeout(timer); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('网址重定向缺少目标地址。');
      current = await validateRemoteUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) throw new Error(`网址返回 HTTP ${response.status}。`);
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!/(text|json|xml|html|markdown)/.test(contentType)) throw new Error(`不支持该网页内容类型：${contentType || '未知'}。`);
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      size += chunk.length;
      if (size > MAX_MATERIAL_BYTES) { await reader.cancel(); throw new Error('网页正文超过 1.5 MB 上限。'); }
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    return { text: contentType.includes('html') ? stripHtml(raw) : raw.trim(), finalUrl: current.toString(), bytes: size };
  }
  throw new Error('网址重定向次数过多。');
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

async function runTask(store, providers, taskId) {
  if (activeJobs.has(taskId)) throw new Error('这项任务正在运行。');
  await store.mutate(taskId, (task) => {
    if (!task.workItems.length) buildPlan(task);
    for (const item of task.workItems) item.status = item.role === 'archivist' ? 'running' : item.status;
    setTaskState(task, 'running', 'archivist', '档案角色正在读取选定材料并核对解析状态。');
  });
  const job = (async () => {
    try {
      await store.mutate(taskId, (task) => {
        const archivist = task.workItems.find((item) => item.role === 'archivist');
        if (archivist) archivist.status = 'completed';
        const researcher = task.workItems.find((item) => item.role === 'researcher');
        if (researcher) {
          researcher.status = 'running';
          setTaskState(task, 'running', 'researcher', '研究角色正在核对来源与材料缺口。');
        } else {
          const writer = task.workItems.find((item) => item.role === 'writer');
          if (writer) writer.status = 'running';
          setTaskState(task, 'running', 'writer', task.provider === 'demo' ? '演示写作角色正在生成候选稿。' : 'Codex 写作角色正在生成候选稿。');
        }
      });
      let staged = await store.get(taskId);
      if (staged.status === 'cancelled') return;
      if (staged.workItems.some((item) => item.role === 'researcher')) {
        await store.mutate(taskId, (task) => {
          const researcher = task.workItems.find((item) => item.role === 'researcher');
          const writer = task.workItems.find((item) => item.role === 'writer');
          if (researcher) researcher.status = 'completed';
          if (writer) writer.status = 'running';
          setTaskState(task, 'running', 'writer', task.provider === 'demo' ? '演示写作角色正在生成候选稿。' : 'Codex 写作角色正在生成候选稿。');
        });
      }
      let task = await store.get(taskId);
      const result = await providers.generate(task);
      const latest = await store.get(taskId);
      if (latest.status === 'cancelled') return;
      const created = await store.mutate(taskId, (draft) => {
        const artifact = createArtifact(draft, result, draft.provider);
        for (const item of draft.workItems) {
          if (item.role === 'writer') item.status = 'completed';
          if (item.role === 'reviewer') item.status = 'running';
        }
        setTaskState(draft, 'running', 'reviewer', '独立审阅角色正在逐项核对候选成果。');
        return artifact;
      });
      task = created.task;
      const reviewResult = await providers.review(task, created.result);
      await store.mutate(taskId, (draft) => {
        const review = recordReview(draft, created.result.id, reviewResult);
        for (const item of draft.workItems) {
          if (item.role === 'reviewer') item.status = review.passed ? 'completed' : 'failed';
          if (item.role === 'steward') item.status = review.passed ? 'waiting_user' : 'blocked';
        }
      });
    } catch (error) {
      await store.mutate(taskId, (task) => {
        for (const item of task.workItems) if (item.status === 'running') item.status = 'failed';
        setTaskState(task, 'failed', task.activeRole, `运行失败：${error.message}`);
      }).catch(() => {});
    } finally {
      activeJobs.delete(taskId);
    }
  })();
  activeJobs.set(taskId, job);
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

export async function createIrixiServer({ root = dataRoot } = {}) {
  const store = createStore(root);
  await store.init();
  const providers = createProviders({ projectRoot, store });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = decodeURIComponent(url.pathname);
    try {
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, version: '1.0.0' });
      if (req.method === 'GET' && pathname === '/api/tasks') return json(res, 200, { tasks: (await store.list()).map(publicTask) });
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
      if (req.method === 'GET' && taskMatch) return json(res, 200, { task: publicTask(await store.get(taskMatch[1])) });
      const exportMatch = pathname.match(/^\/api\/tasks\/([a-z0-9-]+)\/artifacts\/([a-z0-9-]+)\/export$/);
      if (req.method === 'GET' && exportMatch) {
        const task = await store.get(exportMatch[1]);
        const artifact = assertExportAllowed(task, exportMatch[2], url.searchParams.get('approval'));
        const format = url.searchParams.get('format') || 'md';
        const result = exportBody(task, artifact, format);
        const name = `${safeFilename(artifact.title)}-v${artifact.version}.${result.extension}`;
        res.writeHead(200, { 'Content-Type': result.type, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'Content-Length': Buffer.byteLength(result.content), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(result.content);
      }
      if (req.method === 'GET' && pathname.startsWith('/assets/')) return serveFile(res, artRoot, pathname.slice('/assets/'.length));
      if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveFile(res, publicRoot, pathname === '/' ? 'index.html' : pathname);

      ensureLocalMutation(req);
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
        if (action === 'suggestions') {
          const changed = await store.mutate(taskId, (task) => addSuggestion(task, body));
          return json(res, 201, { task: publicTask(changed.task), suggestion: changed.result });
        }
        if (action.startsWith('suggestions/') && action.endsWith('/classification')) {
          const id = action.split('/')[1];
          const changed = await store.mutate(taskId, (task) => correctSuggestion(task, id, body.classification));
          return json(res, 200, { task: publicTask(changed.task), suggestion: changed.result });
        }
        if (action.startsWith('suggestions/') && action.endsWith('/accept-goal')) {
          const id = action.split('/')[1];
          const changed = await store.mutate(taskId, (task) => acceptGoalReplacement(task, id, body.statement));
          return json(res, 200, { task: publicTask(changed.task), goal: changed.result });
        }
        if (action === 'materials/text') {
          const changed = await store.mutate(taskId, (task) => addMaterial(task, { name: body.name || '粘贴文本', kind: 'text', source: 'user-paste', text: body.text }));
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
          return json(res, 201, { task: publicTask(changed.task), material: changed.result });
        }
        if (action === 'materials/url') {
          try {
            const fetched = await fetchMaterial(body.url);
            const changed = await store.mutate(taskId, (task) => addMaterial(task, { name: body.name || new URL(fetched.finalUrl).hostname, kind: 'url', source: fetched.finalUrl, text: fetched.text, bytes: fetched.bytes }));
            return json(res, 201, { task: publicTask(changed.task), material: changed.result });
          } catch (error) {
            const changed = await store.mutate(taskId, (task) => addMaterial(task, { name: body.name || body.url || '网址', kind: 'url', source: body.url, status: 'failed', error: error.message }));
            return json(res, 422, { error: { code: 'url_read_failed', message: error.message }, task: publicTask(changed.task) });
          }
        }
        if (action === 'provider') {
          if (!['demo', 'codex-cli'].includes(body.provider)) throw new Error('未知的模型提供者。');
          const changed = await store.mutate(taskId, (task) => {
            task.provider = body.provider;
            event(task, 'provider.changed', body.provider === 'demo' ? '已切换到演示提供者。' : '已选择 Codex CLI；运行时会发送当前目标与选定材料。', { provider: body.provider });
          });
          return json(res, 200, { task: publicTask(changed.task) });
        }
        if (action === 'plan') {
          const changed = await store.mutate(taskId, (task) => buildPlan(task));
          return json(res, 200, { task: publicTask(changed.task), workItems: changed.result });
        }
        if (action === 'run') {
          if (activeJobs.has(taskId)) return problem(res, 409, '这项任务正在运行。', 'already_running');
          await runTask(store, providers, taskId);
          return json(res, 202, { task: publicTask(await store.get(taskId)), accepted: true });
        }
        if (action === 'cancel') {
          const changed = await store.mutate(taskId, (task) => {
            for (const item of task.workItems) if (item.status === 'running') item.status = 'cancelled';
            setTaskState(task, 'cancelled', task.activeRole, '用户已取消；已产生的候选版本会保留，不执行任何外部操作。');
          });
          return json(res, 200, { task: publicTask(changed.task) });
        }
        const reviseMatch = action.match(/^artifacts\/([a-z0-9-]+)\/revise$/);
        if (reviseMatch) {
          const changed = await store.mutate(taskId, (task) => reviseArtifact(task, reviseMatch[1], body));
          return json(res, 201, { task: publicTask(changed.task), artifact: changed.result });
        }
        const reviewMatch = action.match(/^artifacts\/([a-z0-9-]+)\/review$/);
        if (reviewMatch) {
          const task = await store.get(taskId);
          const artifact = task.artifacts.find((item) => item.id === reviewMatch[1]);
          if (!artifact) throw new Error('找不到要审阅的候选成果。');
          const result = await providers.review(task, artifact);
          const changed = await store.mutate(taskId, (draft) => recordReview(draft, artifact.id, result));
          return json(res, 200, { task: publicTask(changed.task), review: changed.result });
        }
        const confirmMatch = action.match(/^artifacts\/([a-z0-9-]+)\/confirm$/);
        if (confirmMatch) {
          const changed = await store.mutate(taskId, (task) => confirmArtifact(task, confirmMatch[1]));
          return json(res, 200, { task: publicTask(changed.task), approval: changed.result });
        }
      }
      problem(res, 404, '找不到这个操作。', 'not_found');
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : error.status || (/(找不到|不存在)/.test(error.message) ? 404 : 400);
      problem(res, status, error.message || '请求失败。');
    }
  });
  return { server, store, providers };
}

export async function start({ port = Number(process.env.PORT || 3847), host = '127.0.0.1', root = dataRoot } = {}) {
  const { server, store, providers } = await createIrixiServer({ root });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { server, store, providers, url: `http://${host}:${address.port}` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const running = await start();
  process.stdout.write(`Irixi 1.0 已启动：${running.url}\n`);
  process.stdout.write('任务数据只保存在本机。按 Control-C 停止。\n');
}

export const __test = { exportBody, safeFilename, isPrivateIp, validateRemoteUrl, stripHtml };
