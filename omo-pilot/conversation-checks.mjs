import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { executeConversationCommand } from './conversation-command.mjs';

const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
const inside = (root, target) => target.startsWith(root + path.sep);
const wait = (ms, signal) => new Promise((resolve, reject) => { if (signal?.aborted) return reject(new Error('检查已停止。')); const timer = setTimeout(done, ms); function done() { signal?.removeEventListener('abort', abort); resolve(); } function abort() { clearTimeout(timer); reject(new Error('检查已停止。')); } signal?.addEventListener('abort', abort, { once: true }); });
export function validateBehaviorCase(value) {
  if (!value || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value.caseId || '') || typeof value.requirement !== 'string' || !value.requirement.trim() || value.requirement.length > 1000) throw new Error('检查需要固定用例编号和对应用户要求。');
  if (!['cli', 'web', 'application', 'document'].includes(value.kind) || typeof value.target !== 'string' || path.isAbsolute(value.target) || value.target.split(/[\\/]/u).some((p) => !p || p === '..' || p.startsWith('.'))) throw new Error('检查必须指向项目内实际成果入口。');
  if (JSON.stringify(value).length > 30000) throw new Error('检查用例过长。');
  if (value.kind === 'cli') {
    if (!['node', 'python3'].includes(value.runner) || !Array.isArray(value.arguments || []) || (value.arguments || []).some((v) => typeof v !== 'string') || typeof value.expected !== 'object'
      || !(typeof value.expected.stdoutEquals === 'string' || Array.isArray(value.expected.stdoutIncludes) && value.expected.stdoutIncludes.length && value.expected.stdoutIncludes.every((v) => typeof v === 'string' && v))) throw new Error('命令行检查需要真实入口、输入与明确预期输出；环境命令不能代替。');
    if (value.runner === 'node' && !/\.(?:js|mjs|cjs)$/iu.test(value.target) || value.runner === 'python3' && !/\.py$/iu.test(value.target)) throw new Error('入口文件与运行方式不匹配。');
  } else if (value.kind === 'web' || value.kind === 'application') {
    if (value.kind === 'web' && !/\.html?$/iu.test(value.target) || !Array.isArray(value.actions) || !value.actions.length || value.actions.length > 40 || !value.actions.some((a) => ['assert', 'http', 'sqlite'].includes(a.action))) throw new Error('应用检查需要实际操作和具体结果断言。');
    for (const a of value.actions) {
      if (value.kind === 'application' && a.action === 'http') {
        if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(a.method || 'GET') || typeof a.path !== 'string' || !a.path.startsWith('/') || a.path.startsWith('//') || !Number.isInteger(a.status) || !['jsonEquals', 'bodyIncludes'].some((k) => Object.hasOwn(a, k))) throw new Error('接口检查需要本应用路径、状态码和具体返回预期。');
        continue;
      }
      if (value.kind === 'application' && a.action === 'sqlite') {
        if (typeof a.file !== 'string' || !/^[^./\\][^/\\]*\.(?:db|sqlite|sqlite3)$/iu.test(a.file) || typeof a.query !== 'string' || !/^\s*SELECT\b/iu.test(a.query) || !Array.isArray(a.rows)) throw new Error('数据检查需要数据区的SQLite文件、只读SELECT和固定行结果。');
        continue;
      }
      if (!['fill', 'click', 'select', 'assert', 'reload'].includes(a.action) || a.action !== 'reload' && (typeof a.selector !== 'string' || a.selector.length > 1000)) throw new Error('网页检查动作无效。');
      if (a.action === 'assert' && !['textEquals', 'textIncludes', 'valueEquals', 'count'].some((key) => Object.hasOwn(a, key))) throw new Error('页面断言必须写出具体预期。');
    }
  } else {
    if (!/\.(?:md|txt|csv|tsv|json|yaml|yml)$/iu.test(value.target)) throw new Error('document 文稿检查只支持 .md、.txt、.csv、.tsv、.json、.yaml、.yml。HTML 页面请用 kind=web，提供实际页面操作和结果断言；不能用文稿内容检查代替网页行为检查。');
    if (!Array.isArray(value.expected?.includes) || !value.expected.includes.length || value.expected.includes.some((s) => typeof s !== 'string' || !s)) throw new Error('文稿检查的 expected.includes 必须是非空字符串数组，写明对应用户要求的具体内容。');
  }
  return value;
}
// Internal executor: the caller validates the case before registering or running it.
// Filesystem state is checked here because it can change after input validation.
export async function checkBehavior(value, { root, signal, onProcess, registryPath, application }) {
  root = await fs.realpath(root);
  const target = path.resolve(root, value.target);
  if (!inside(root, target) || await fs.realpath(target) !== target || !(await fs.stat(target)).isFile()) throw new Error('检查入口不存在或超出当前成果。');
  if (value.kind === 'document') {
    const stat = await fs.stat(target); if (stat.size > 2_000_000) throw new Error('文稿过大，尚未检查。');
    const text = await fs.readFile(target, 'utf8');
    const missing = value.expected.includes.filter((s) => !text.includes(s)); const unexpected = (value.expected.excludes || []).filter((s) => text.includes(s));
    return { status: missing.length || unexpected.length ? 'failed' : 'passed', actual: { missing, unexpected, characters: text.length }, coveredFiles: [value.target], scope: '指定内容检查，不代表事实或所有需求均正确' };
  }
  if (value.kind === 'cli') {
    const coverageDir = await fs.mkdtemp(path.join(root, '.irixi-check-coverage-'));
    let invocation;
    if (value.runner === 'python3') {
      const shim = `import sys,runpy,os,json\nroot=os.getcwd(); seen=set(); target=sys.argv[1]; sys.argv=sys.argv[1:]; sys.path[0]=os.path.dirname(os.path.abspath(target))\ndef trace(frame,event,arg):\n p=os.path.realpath(frame.f_code.co_filename)\n if p.startswith(root+os.sep) and os.path.isfile(p): seen.add(os.path.relpath(p,root))\n return trace\nsys.settrace(trace)\ntry: runpy.run_path(target,run_name='__main__')\nfinally:\n sys.settrace(None)\n with open(${JSON.stringify(path.join(coverageDir, 'python.json'))},'w') as f: json.dump(list(seen),f)\n`;
      invocation = `python3 -B -c ${quote(shim)}`;
    } else invocation = `NODE_V8_COVERAGE=${quote(coverageDir)} node`;
    const command = `printf %s ${quote(value.stdin || '')} | ${invocation} ${quote(value.target)} ${(value.arguments || []).map(quote).join(' ')}`;
    const result = await executeConversationCommand({ command, timeout: 60 }, { root, signal, registryPath });
    const output = result.details.stdout;
    const coveredFiles = new Set();
    try {
      for (const name of await fs.readdir(coverageDir)) {
        const record = JSON.parse(await fs.readFile(path.join(coverageDir, name), 'utf8'));
        if (name === 'python.json') for (const file of record) coveredFiles.add(file);
        else for (const script of record.result || []) if (script.url?.startsWith('file://')) {
          const file = decodeURIComponent(new URL(script.url).pathname); if (inside(root, file)) coveredFiles.add(path.relative(root, file));
        }
      }
    } finally { await fs.rm(coverageDir, { recursive: true, force: true }); }
    const expected = value.expected; const pass = result.details.exitCode === (expected.exitCode ?? 0) && !result.details.timedOut && !result.details.stopped && !result.details.overflow
      && (expected.stdoutEquals === undefined || output === expected.stdoutEquals) && (expected.stdoutIncludes || []).every((text) => output.includes(text));
    return { status: pass ? 'passed' : 'failed', actual: { output, ...result.details }, coveredFiles: [...coveredFiles], scope: '实际运行指定入口并比较输出' };
  }
  if (value.kind === 'application' && !application?.url) throw new Error('动态应用尚未启动，不能用静态预览代替。');
  return checkWeb(value, { root, signal, onProcess, registryPath, application });
}

// Private Chrome profile and a CDP pipe, never the user's browser/account. The
// model only supplies fixed DOM actions; it cannot submit arbitrary page code.
async function checkWeb(value, { root, signal, onProcess, registryPath, application }) {
  const chrome = fileURLToPath(new URL('../.irixi-runtime/browser/chromium-headless-shell-1248/chrome-headless-shell', import.meta.url));
  await fs.access(chrome).catch(() => { throw new Error('网页检查器尚未安装。请运行本项目的检查器安装程序；功能尚未验证。'); });
  const temp = await fs.mkdtemp(path.join(path.dirname(root), 'browser-check-'));
  let child; let failed = false; let serial = 0; let pipeBuffer = ''; const diagnostic = []; const pending = new Map(); const observers = new Map();
  const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  let origin; const loadedFiles = new Set();
  const server = http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method) || req.headers.host !== new URL(origin).host) throw new Error('scope');
      const name = decodeURIComponent(new URL(req.url, origin).pathname).replace(/^\//, '') || value.target;
      if (name.split('/').some((s) => s.startsWith('.') || s === '..')) throw new Error('scope');
      const file = path.resolve(root, name); if (!inside(root, file) || await fs.realpath(file) !== file) throw new Error('scope');
      const content = await fs.readFile(file); loadedFiles.add(path.relative(root, file));
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Content-Security-Policy': "sandbox allow-scripts allow-same-origin allow-forms; default-src 'self' data: 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'self'" }); res.end(content);
    } catch { res.writeHead(404); res.end('Unavailable'); }
  });
  const rejectPending = (error) => { failed = true; for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  const stop = () => { if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } rejectPending(new Error('网页检查已停止。')); };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    if (failed || signal?.aborted || !child?.stdio[3]?.writable) return reject(new Error('网页检查器未运行。'));
    const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`网页检查等待超时：${method}；最近事件 ${diagnostic.slice(-12).join(",")}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
  let closed;
  try {
    if (application) origin = application.url.replace(/\/$/u, '');
    else { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); origin = `http://127.0.0.1:${server.address().port}`; }
    if (signal?.aborted) throw new Error('检查已停止。');
    const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${temp}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-features=MediaRouter', '--disable-gpu', 'about:blank'];
    child = spawn('/bin/sh', ['-c', 'IFS= read -r irixi_start || exit 1; exec "$@"', 'irixi-browser-check', chrome, ...args], { cwd: root, detached: true, stdio: ['pipe', 'ignore', 'ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: temp, TMPDIR: temp } });
    closed = new Promise((resolve) => { child.once('close', resolve); child.once('error', resolve); });
    signal?.addEventListener('abort', stop, { once: true });
    child.on('error', (error) => rejectPending(error)); child.on('close', () => rejectPending(new Error('网页检查器已退出。')));
    child.stdio[4].on('data', (bytes) => {
      pipeBuffer += bytes.toString(); const records = pipeBuffer.split('\0'); pipeBuffer = records.pop();
      for (const text of records) { if (!text) continue; let event; try { event = JSON.parse(text); } catch { continue; }
        if (event.id && pending.has(event.id)) { const p = pending.get(event.id); pending.delete(event.id); clearTimeout(p.timer); event.error ? p.reject(new Error(event.error.message)) : p.resolve(event.result || {}); }
        else { diagnostic.push(event.method); if (diagnostic.length > 40) diagnostic.shift(); observers.get(event.method)?.(event); }
      }
    });
    await onProcess?.({ pid: child.pid, group: true }); if (signal?.aborted) throw new Error('检查已停止。'); child.stdin.end('start\n');
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const cdp = (method, params) => send(method, params, sessionId);
    observers.set('Fetch.requestPaused', (event) => { const request = event.params; const allowed = request.request.url.startsWith(origin + '/') || request.request.url.startsWith('data:'); void cdp(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId: request.requestId } : { requestId: request.requestId, errorReason: 'BlockedByClient' }).catch((error) => rejectPending(error)); });
    await cdp('Fetch.enable', { patterns: [{ urlPattern: '*' }] }); await cdp('Page.enable'); await cdp('Runtime.enable');
    const evaluate = async (fn, arg) => { const result = await cdp('Runtime.evaluate', { expression: `(${fn})(${JSON.stringify(arg)})`, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error('页面操作失败：' + (result.exceptionDetails.exception?.description || result.exceptionDetails.text)); return result.result?.value; };
    // Parse on the blank host-owned page, before any application action can run.
    const invalidSelectors = await evaluate((actions) => actions.flatMap((action, index) => {
      if (typeof action.selector !== 'string') return [];
      try { document.querySelectorAll(action.selector); return []; }
      catch (error) { if (error.name !== 'SyntaxError') throw error; return [{ step: index + 1, selector: action.selector, error: error.message }]; }
    }), value.actions);
    if (invalidSelectors.length) return { status: 'failed', failureKind: 'invalid_definition', invalidSelectors,
      error: `检查格式无效：第 ${invalidSelectors.map((item) => item.step).join('、')} 步需要原生 CSS 选择器。可只修正这些选择器，其他动作和预期必须保持不变。`,
      actual: [], coveredFiles: [], scope: '宿主选择器语法检查；尚未执行应用操作或功能断言' };
    await cdp('Page.navigate', { url: origin + (application ? '/' : '/' + value.target.split('/').map(encodeURIComponent).join('/')) });
    const ready = async () => { for (let i = 0; i < 100; i++) { if (await evaluate(() => document.readyState === 'complete')) return; await wait(50, signal); } throw new Error('页面未完成加载。'); };
    await ready(); const actual = [];
    const result = (error) => ({ status: error ? 'failed' : 'passed', ...(error ? { error } : {}), actual, coveredFiles: [...loadedFiles], scope: '真实浏览器中的指定操作与页面断言' });
    for (const [index, action] of value.actions.entries()) {
      if (signal?.aborted) throw new Error('检查已停止。');
      const step = index + 1;
      try {
      if (application && action.action === 'http') {
        const response = await fetch(origin + action.path, { method: action.method || 'GET', redirect: 'manual', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', Origin: origin }, ...(action.json !== undefined ? { body: JSON.stringify(action.json) } : {}) });
        const body = await response.text(); let parsed;
        if (Object.hasOwn(action, 'jsonEquals')) parsed = JSON.parse(body);
        const passed = response.status === action.status && (action.bodyIncludes === undefined || body.includes(action.bodyIncludes)) && (action.jsonEquals === undefined || isDeepStrictEqual(parsed, action.jsonEquals));
        actual.push({ step, action, observed: { status: response.status, body }, passed });
        if (!passed) return result(`第 ${step} 步接口结果与预期不符。`);
        continue;
      }
      if (application && action.action === 'sqlite') {
        const file = path.join(application.dataRoot, action.file);
        if (await fs.realpath(file) !== file) throw new Error('数据库路径不在本次检查数据区。');
        const output = await executeConversationCommand({ command: `/usr/bin/sqlite3 -readonly -json ${quote(file)} ${quote(action.query)}`, timeout: 15 }, { root, readRoots: [application.dataRoot], signal, registryPath });
        const rows = JSON.parse(output.details.stdout || '[]'); const passed = !output.isError && isDeepStrictEqual(rows, action.rows);
        actual.push({ step, action, observed: rows, passed });
        if (!passed) return result(`第 ${step} 步数据库记录与预期不符。`);
        continue;
      }
      if (action.action === 'reload') { await cdp('Page.reload'); await ready(); actual.push({ action: 'reload', loaded: true }); continue; }
      const observe = async () => evaluate((a) => {
        const nodes = document.querySelectorAll(a.selector); const element = nodes[0];
        if (a.action === 'assert') return { count: nodes.length, text: element?.textContent || '', value: element?.value ?? null };
        if (nodes.length !== 1) return { ready: false, count: nodes.length, reason: '操作目标必须唯一，实际数量：' + nodes.length };
        const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || element.disabled) return { ready: false, reason: '目标不可见或不可操作。' };
        if (a.action === 'click') element.click();
        else if (a.action === 'fill' || a.action === 'select') { const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, a.value || ''); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); }
        return { count: nodes.length, acted: a.action };
      }, action);
      let observed = await observe();
      if (action.action !== 'assert') {
        for (let i = 0; i < 30 && observed.ready === false; i++) { await wait(100, signal); observed = await observe(); }
        if (observed.ready === false && observed.count > 1) {
          const error = `第 ${step} 步 ${action.action} ${action.selector} 匹配 ${observed.count} 个目标。请只修正此步选择器，保留其他动作和预期，再从头检查。`;
          actual.push({ step, action, observed, error, passed: false });
          return { ...result(error), failureKind: 'invalid_definition', invalidSelectors: [{ step, selector: action.selector, error }] };
        }
        if (observed.ready === false) throw new Error('等待目标可操作超时：' + observed.reason);
      }
      if (action.action === 'assert') {
        const matches = (v) => ((action.count === 0 && ['textEquals', 'textIncludes', 'valueEquals'].every((key) => action[key] === undefined)) || v.count > 0) && (action.count === undefined || v.count === action.count) && (action.textEquals === undefined || v.text.trim() === action.textEquals) && (action.textIncludes === undefined || v.text.includes(action.textIncludes)) && (action.valueEquals === undefined || v.value === action.valueEquals);
        for (let i = 0; i < 30 && !matches(observed); i++) { await wait(100, signal); observed = await observe(); }
        actual.push({ step, action, observed, passed: matches(observed) });
        if (!matches(observed)) return result(`第 ${step} 步检查未通过：${action.selector}。后续动作未执行，已保留实际观察。`);
      } else actual.push({ step, action, observed });
      } catch (error) {
        if (signal?.aborted) throw error;
        const detail = `第 ${step} 步 ${action.action}${action.selector ? ` ${action.selector}` : ''} 失败：${error.message}`;
        actual.push({ step, action, error: detail, passed: false }); return result(detail);
      }
    }
    return result();
  } finally {
    signal?.removeEventListener('abort', stop); stop(); if (closed) await closed; await new Promise((resolve) => server.close(resolve)); await fs.rm(temp, { recursive: true, force: true });
  }
}
