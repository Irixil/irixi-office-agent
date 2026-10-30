import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { commandSandboxProfile, cleanupCommandMarker, identity } from './conversation-command.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const csp = "sandbox allow-scripts allow-same-origin allow-forms; default-src 'self' data: blob: 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'none'; worker-src 'none'; base-uri 'self'";

// A host contract, authored by the agent from the actual project's start command.
// It is not a user-facing setup form and never grants network or secret access.
export async function readApplicationConfig(root) {
  const file = path.join(root, '.irixi-app.json');
  let bytes;
  try { if (await fs.realpath(file) !== file || !(await fs.stat(file)).isFile()) throw new Error('应用启动配置不是本项目的普通文件。'); bytes = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (bytes.length > 12000) throw new Error('应用启动配置过长。');
  const value = JSON.parse(bytes);
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('应用配置必须是对象。');
  if (!value || typeof value.command !== 'string' || !value.command.trim() || value.command.length > 4000
    || typeof value.readyPath !== 'string' || !value.readyPath.startsWith('/') || value.readyPath.startsWith('//') || /[\r\n]/u.test(value.readyPath)
    || value.env && (typeof value.env !== 'object' || Array.isArray(value.env))) throw new Error('应用需要实际启动命令和本机就绪地址。');
  for (const [key, item] of Object.entries(value.env || {})) {
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || /(?:PASSWORD|SECRET|TOKEN|CREDENTIAL|API_KEY|AUTH|PROXY)/u.test(key)
      || ['HOME', 'PATH', 'TMPDIR', 'PORT', 'IRIXI_DATA_DIR', 'IRIXI_COMMAND_MARKER', 'NODE_OPTIONS', 'PYTHONPATH'].includes(key)
      || typeof item !== 'string' || item.length > 2000 || /\0/u.test(item)) throw new Error(`应用配置 ${key} 不是允许的非机密变量。`);
  }
  for (const key of ['install', 'build']) if (value[key] !== undefined && (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 4000)) throw new Error(`应用 ${key} 命令无效。`);
  if (value.dataFiles !== undefined && (!Array.isArray(value.dataFiles) || new Set(value.dataFiles.map((name) => typeof name === 'string' ? path.basename(name) : name)).size !== value.dataFiles.length || value.dataFiles.some((name) => typeof name !== 'string' || !/\.(?:db|sqlite|sqlite3)$/iu.test(name) || path.isAbsolute(name) || name.split(/[\\/]/u).some((part) => !part || part === '..' || part.startsWith('.')) || /(?:^|\/)(?:credentials?|secrets?)(?:\.|$)/iu.test(name)))) throw new Error('运行数据必须是项目内明确的非机密相对文件。');
  for (const name of value.dataFiles || []) {
    const file = path.join(root, name);
    try { if (await fs.realpath(file) !== file || !(await fs.stat(file)).isFile()) throw new Error(`运行数据路径无效：${name}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { command: value.command.trim(), readyPath: value.readyPath, env: value.env || {}, ...(value.install ? { install: value.install } : {}), ...(value.build ? { build: value.build } : {}), dataFiles: value.dataFiles || [] };

}

function listenerOwned(record) {
  if (!record.pid || !record.identity || identity(record.pid) !== record.identity) return false;
  let output;
  try { output = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${record.port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (error) { if (error.status === 1) return false; throw error; }
  const pids = [...output.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1]));
  return pids.length > 0 && pids.every((pid) => Number(identity(pid)?.split(/\s+/u).at(-1)) === record.pid);
}

function signalOwned(record, signal) {
  if (!record.identity || identity(record.pid) !== record.identity) return;
  try { process.kill(-record.pid, signal); }
  catch (error) {
    if (error.code === 'ESRCH') return;
    // macOS returns EPERM for an already-exited group leader awaiting reap.
    // Its descendants are still checked by cleanupCommandMarker below.
    if (error.code === 'EPERM' && /^Z/u.test(execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'stat='], { encoding: 'utf8' }).trim())) return;
    throw error;
  }
}

async function responds(record) {
  if (!listenerOwned(record)) return false;
  try { const reply = await fetch(`http://127.0.0.1:${record.port}${record.config.readyPath}`, { signal: AbortSignal.timeout(1500), redirect: 'manual' }); await reply.body?.cancel(); return reply.status >= 200 && reply.status < 400; }
  catch { return false; }
}

export class ConversationApplications {
  constructor(store) { this.store = store; this.proxies = new Map(); this.pending = new Map(); this.controllers = new Map(); this.closed = false; }
  start(project, options = {}) {
    if (this.closed) return Promise.reject(new Error('应用管理已关闭。'));
    if (this.pending.has(project.id)) return this.pending.get(project.id);
    const controller = new AbortController(); this.controllers.set(project.id, controller);
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const job = this.launch(project, { ...options, signal }).finally(() => { this.pending.delete(project.id); this.controllers.delete(project.id); });
    this.pending.set(project.id, job); return job;
  }
  async launch(project, { root = project.root, version, turnId, signal, dataRoot: suppliedDataRoot, coverageDir } = {}) {
    root = await fs.realpath(root);
    const config = await readApplicationConfig(root);
    if (!config) throw new Error('当前成果还没有应用启动配置。');
    if (signal?.aborted) throw new Error('启动已停止。');
    const previous = project.application;
    if (previous && previous.root === root && previous.version === version && await responds(previous)) {
      await this.ensureProxy(project); previous.status = 'running'; delete previous.error; await this.store.save(); return previous;
    }
    if (previous) await this.stop(project, { preserveLaunch: true });
    const directory = path.join(this.store.root, 'applications', project.id);
    const dataRoot = suppliedDataRoot || path.join(directory, 'data'); const temp = path.join(directory, 'home');
    await fs.mkdir(dataRoot, { recursive: true }); await fs.mkdir(temp, { recursive: true });
    const reservation = http.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(previous?.port || 0, '127.0.0.1', resolve); });
    const port = reservation.address().port; await new Promise((resolve) => reservation.close(resolve));
    const marker = randomUUID();
    const configuredEnv = Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, value.replaceAll('${IRIXI_DATA_DIR}', dataRoot).replaceAll('${PORT}', String(port))]));
    const record = { status: 'starting', projectId: project.id, root, version, turnId, config, port, proxyPort: previous?.proxyPort || null,
      dataRoot, temp, marker, startedAt: now(), logPath: path.join(directory, 'application.log') };
    project.application = record; await this.store.save();
    const log = await fs.open(record.logPath, 'a+', 0o600); const logStart = (await log.stat()).size;
    let child;
    const stop = () => signalOwned(record, 'SIGTERM');
    try {
      if (signal?.aborted || this.closed) throw new Error('应用启动已停止。');
      const profile = commandSandboxProfile(root, temp, [dataRoot, record.logPath], port, { writeRoots: [dataRoot, record.logPath, ...(coverageDir ? [coverageDir] : [])] });
      child = spawn('/bin/sh', ['-c', 'IFS= read -r irixi_start || exit 1; exec "$@"', 'irixi-application', '/usr/bin/sandbox-exec', '-p', profile, '/bin/bash', '--noprofile', '--norc', '-c', config.command], {
        cwd: root, detached: true, stdio: ['pipe', log.fd, log.fd], env: { ...configuredEnv, ...(coverageDir ? { NODE_V8_COVERAGE: coverageDir } : {}), HOME: temp, TMPDIR: temp, PORT: String(port), IRIXI_DATA_DIR: dataRoot,
          IRIXI_COMMAND_MARKER: marker, PATH: `${root}/.venv/bin:${root}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8' },
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      record.pid = child.pid; record.identity = identity(child.pid);
      if (!record.identity) throw new Error('未能登记应用进程，未启动应用。');
      await this.store.save();
      if (signal?.aborted || this.closed) throw new Error('应用启动已停止。');
      signal?.addEventListener('abort', stop, { once: true });
      child.stdin.on('error', stop); child.stdin.end('start\n'); child.unref();
      for (let attempt = 0; attempt < 80; attempt++) {
        if (signal?.aborted || this.closed) throw new Error('应用启动已停止。');
        if (await responds(record)) {
          await this.ensureProxy(project); if (signal?.aborted || this.closed) throw new Error('应用启动已停止。'); record.status = 'running'; delete record.error; record.readyAt = now(); await this.store.save(); return record;
        }
        if (identity(record.pid) !== record.identity) break;
        await wait(250);
      }
      throw new Error('应用没有就绪，查看应用日志后修复启动问题。');
    } catch (error) {
      await this.stop(project, { preserveLaunch: true }); record.status = signal?.aborted || this.closed ? 'stopped' : 'failed'; record.error = error.message;
      const size = (await log.stat()).size; const bytes = Buffer.alloc(Math.min(size - logStart, 6000));
      if (bytes.length) { await log.read(bytes, 0, bytes.length, size - bytes.length); record.logTail = bytes.toString('utf8'); error.message += '\n应用启动日志：\n' + record.logTail; }
      await this.store.save(); throw error;
    } finally { signal?.removeEventListener('abort', stop); await log.close(); }
  }
  async ensureProxy(project) {
    if (this.proxies.has(project.id)) return;
    const record = project.application;
    const proxy = http.createServer((req, res) => {
      const host = `127.0.0.1:${record.proxyPort}`; const origin = `http://${host}`;
      const fail = (code, message) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(message); };
      if (req.headers.host !== host || !req.url.startsWith('/') || req.url.startsWith('//')) return fail(403, '应用地址无效。');
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers.origin && req.headers.origin !== origin) return fail(403, '此页面无权修改应用数据。');
      if (record.status !== 'running' && record.status !== 'starting' || !listenerOwned(record)) return fail(503, '应用已停止，请从项目成果重新打开。');
      const headers = { ...req.headers, host: `127.0.0.1:${record.port}` }; delete headers.connection; delete headers.cookie;
      if (headers.origin === origin) headers.origin = `http://127.0.0.1:${record.port}`;
      const upstream = http.request({ hostname: '127.0.0.1', port: record.port, method: req.method, path: req.url, headers }, (response) => {
        const output = { ...response.headers, 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
        delete output['access-control-allow-origin']; delete output['access-control-allow-credentials']; delete output.connection; delete output['set-cookie'];
        if (output.location?.startsWith(`http://127.0.0.1:${record.port}/`)) output.location = output.location.replace(`http://127.0.0.1:${record.port}`, origin);
        res.writeHead(response.statusCode, output); response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) fail(502, '应用没有响应，请检查应用状态。'); else res.destroy(); });
      req.on('aborted', () => upstream.destroy()); req.pipe(upstream);
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(record.proxyPort || 0, '127.0.0.1', resolve); });
    record.proxyPort = proxy.address().port; record.url = `http://127.0.0.1:${record.proxyPort}/`;
    this.proxies.set(project.id, proxy);
  }
  async status(project) {
    const record = project.application; if (!record) return null;
    // The active launch owns readiness and startup failure; polling must not fail it early.
    if (record.status === 'starting' && this.pending.has(project.id)) return record;
    const running = await responds(record);
    if (running) { await this.ensureProxy(project); if (record.status !== 'running' || record.error !== undefined) { record.status = 'running'; delete record.error; await this.store.save(); } }
    else if (['running', 'starting'].includes(record.status)) { record.status = 'interrupted'; record.error = '应用进程已退出或没有响应。数据仍保留，可重新打开。'; await this.store.save(); }
    return record;
  }
  async stop(project, { preserveLaunch = false } = {}) {
    if (!preserveLaunch) this.controllers.get(project.id)?.abort();
    const record = project.application; if (!record) return null;
    record.status = 'stopping'; await this.store.save();
    const proxy = this.proxies.get(project.id);
    if (proxy) { proxy.closeAllConnections(); await new Promise((resolve) => proxy.close(resolve)); this.proxies.delete(project.id); }
    if (record.identity && identity(record.pid) === record.identity) {
      signalOwned(record, 'SIGTERM');
      for (let attempt = 0; attempt < 10 && identity(record.pid) === record.identity; attempt++) await wait(50);
      if (identity(record.pid) === record.identity) signalOwned(record, 'SIGKILL');
    }
    if (record.root && record.marker) await cleanupCommandMarker(record.root, record.marker);
    record.status = 'stopped'; record.stoppedAt = now(); await this.store.save(); return record;
  }
  async recover() {
    for (const project of [...this.store.state.projects, ...(this.store.state.applicationProjects || [])]) {
      const record = project.application; if (!record) continue;
      if (record.status === 'stopping') { await this.stop(project); continue; }
      if (['running', 'starting'].includes(record.status)) {
        if (await responds(record)) { await this.ensureProxy(project); record.status = 'running'; delete record.error; record.recoveredAt = now(); }
        else { await this.stop(project); record.status = 'interrupted'; record.error = '后台曾中断。数据已保留，打开成果后恢复应用。'; }
      }
    }
    await this.store.save();
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    for (const project of [...this.store.state.projects, ...(this.store.state.applicationProjects || [])]) if (project.application) await this.stop(project);
  }
}
