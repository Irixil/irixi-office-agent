import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { createServer, connect } from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const literal = (value) => JSON.stringify(value);
export function identity(pid) {
  try { return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'pgid='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
}
async function markerProcesses(root, marker) {
  let listing = '';
  try { ({ stdout: listing } = await execFileAsync('/usr/sbin/lsof', ['-nP', '-a', '-d', 'cwd', '+D', root, '-Fpn'], { encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch (error) {
    if (error.code !== 1) throw Object.assign(new Error(`无法核实本轮后台进程是否退出：lsof ${error.killed ? '核查超时（5秒）' : '核查失败'}；code=${error.code ?? 'none'}，signal=${error.signal || 'none'}。`), { probe: { command: 'lsof', code: error.code, signal: error.signal, killed: error.killed } });
    listing = String(error.stdout || '');
  }
  const pids = [...new Set([...listing.matchAll(/^p(\d+)$/gm)].map((m) => Number(m[1])))];
  const owned = [];
  for (const pid of pids) {
    const born = identity(pid); if (!born) continue;
    let environment = '';
    try { ({ stdout: environment } = await execFileAsync('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 2000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { continue; }
    // Inspect only candidates whose cwd is this private working copy. Never log
    // process environments; an unrelated same-cwd process is left untouched.
    if (environment.split(/\s+/u).includes(`IRIXI_COMMAND_MARKER=${marker}`) && identity(pid) === born) {
      const group = Number(born.split(/\s+/u).at(-1));
      if (Number.isSafeInteger(group) && group > 1 && group !== process.pid) owned.push({ pid, group, identity: born });
    }
  }
  return owned;
}
export async function cleanupCommandMarker(root, marker) {
  if (!path.isAbsolute(root || '') || !/^[0-9a-f-]{36}$/u.test(marker || '')) throw new Error('命令恢复标记无效。');
  for (let attempt = 0; attempt < 5; attempt++) {
    const owned = await markerProcesses(root, marker);
    if (!owned.length) return;
    for (const item of owned) if (identity(item.pid) === item.identity) { try { process.kill(-item.group, 'SIGKILL'); } catch {} }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  if ((await markerProcesses(root, marker)).length) throw new Error('本轮仍有后台进程未退出，尚不能继续写入。');
}
export async function cleanupCommandRegistry(file) {
  let text = '';
  try { text = await fs.readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const line of text.split('\n').filter(Boolean)) {
    const record = JSON.parse(line); const current = identity(record.pid);
    if (!current || current === record.identity) { try { process.kill(-record.pid, 'SIGKILL'); } catch {} }
    if (record.root && record.marker) await cleanupCommandMarker(record.root, record.marker);
  }
}
export function commandSandboxProfile(root, temp, readRoots = [], port = null, { writeRoots = [], proxyPort = null } = {}) {
  const reads = ['/bin', '/usr', '/System', '/dev', '/private/var/select', '/var/select', '/Library/Developer/CommandLineTools', '/private/etc/ssl/openssl.cnf', '/private/etc/ssl/cert.pem', '/etc/ssl/openssl.cnf', '/etc/ssl/cert.pem', root, temp, ...readRoots, ...writeRoots];
  const ancestors = new Set(['/']);
  for (const item of reads) { let dir = path.dirname(item); while (dir !== '/') { ancestors.add(dir); dir = path.dirname(dir); } }
  return `(version 1) (deny default)
(allow process-exec) (allow process-fork) (allow sysctl-read)
(allow signal (require-all (target children) (target same-sandbox)))
(allow file-read-data (literal "/"))
(allow file-read-metadata ${[...ancestors].map((item) => `(literal ${literal(item)})`).join(' ')})
(allow file-read* ${reads.map((item) => `(subpath ${literal(item)})`).join(' ')})
(allow file-write* (subpath ${literal(root)}) (subpath ${literal(temp)}) ${writeRoots.map((item) => `(subpath ${literal(item)})`).join(' ')} (literal "/dev/null"))
${port ? `(allow network-bind (local ip "localhost:${port}")) (allow network-inbound (local ip "localhost:${port}")) (allow network-outbound (remote ip "localhost:${port}"))` : ''}
${proxyPort ? `(allow network-outbound (remote ip "localhost:${proxyPort}"))` : ''}`;
}

export async function executeConversationCommand({ command, timeout = 120 }, { root, readRoots = [], writeRoots = [], environment = {}, networkHosts = [], signal, onUpdate, registryPath }) {
  if (process.platform !== 'darwin') throw new Error('当前命令隔离实现仅支持本机 macOS；未执行无隔离命令。');
  if (typeof command !== 'string' || !command.trim() || command.length > 32000) throw new Error('命令不能为空或过长。');
  if (networkHosts.some((host) => typeof host !== 'string' || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/u.test(host))) throw new Error('公开依赖授权域名无效。');
  root = await fs.realpath(root);
  const temp = await fs.mkdtemp(path.join(root, '.irixi-command-'));
  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  // Seatbelt cannot restrict remote hostnames. HTTPS package traffic goes only
  // through this host-owned proxy; the command still cannot connect externally.
  const sockets = new Set(); const network = { allowedHosts: networkHosts, connections: {}, denied: [] };
  let proxy; let proxyPort;
  if (networkHosts.length) {
    const allowed = new Set(networkHosts);
    proxy = http.createServer((_req, res) => { res.writeHead(403); res.end('Only approved HTTPS destinations are allowed.'); });
    proxy.on('clientError', (_error, socket) => socket.destroy());
    proxy.on('connect', (req, client, head) => {
      const match = /^([a-z0-9.-]+):443$/u.exec(req.url || ''); const host = match?.[1];
      if (!host || !allowed.has(host)) {
        if (network.denied.length < 20) network.denied.push(host ? `${host}:443` : '<invalid HTTPS destination>');
        client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return;
      }
      network.connections[host] = (network.connections[host] || 0) + 1;
      const remote = connect(443, host); sockets.add(remote); sockets.add(client);
      remote.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client); });
      remote.on('error', () => client.destroy()); client.on('error', () => remote.destroy());
      client.once('close', () => { remote.destroy(); sockets.delete(client); });
      remote.once('close', () => { client.destroy(); sockets.delete(remote); });
    });
    await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    proxyPort = proxy.address().port;
  }
  const profile = commandSandboxProfile(root, temp, readRoots, port, { writeRoots, proxyPort });
  const marker = randomUUID();
  let output = ''; let stdout = ''; let stderr = ''; let timedOut = false; let overflow = false;
  try {
    if (signal?.aborted) throw new Error('命令已取消，未启动进程。');
    return await new Promise((resolve, reject) => {
      // The shell waits for a host handshake. A host crash before durable registration
      // closes stdin, so an unregistered command cannot begin running.
      const child = spawn('/bin/sh', ['-c', 'IFS= read -r irixi_start || exit 1; exec "$@"', 'irixi-command', '/usr/bin/sandbox-exec', '-p', profile, '/bin/bash', '--noprofile', '--norc', '-c', command], {
        cwd: root, env: { ...Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, String(value).replaceAll('${PORT}', String(port))])), HOME: temp, TMPDIR: temp, PORT: String(port), IRIXI_COMMAND_MARKER: marker, PATH: `${root}/.venv/bin:${root}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', PIP_CONFIG_FILE: '/dev/null', npm_config_userconfig: path.join(temp, 'npmrc'), npm_config_globalconfig: path.join(temp, 'global-npmrc'),
          ...(proxyPort ? { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`, HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: 'localhost,127.0.0.1,::1,[::1]', npm_config_https_proxy: `http://127.0.0.1:${proxyPort}`, npm_config_proxy: `http://127.0.0.1:${proxyPort}` } : {}) },
        stdio: ['pipe', 'pipe', 'pipe'], detached: true,
      });
      const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch {} };
      const kill = () => { killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 750).unref(); };
      let registration = Promise.resolve();
      child.once('spawn', () => {
        if (registryPath || process.env.IRIXI_OMO_COMMAND_REGISTRY) {
          let identity = null;
          try { identity = execFileSync('/bin/ps', ['-p', String(child.pid), '-o', 'lstart=', '-o', 'pgid='], { encoding: 'utf8' }).trim(); } catch {}
          registration = fs.appendFile(registryPath || process.env.IRIXI_OMO_COMMAND_REGISTRY, JSON.stringify({ pid: child.pid, identity, root, marker }) + '\n');
          registration.catch(() => kill());
        }
        registration.then(() => { if (signal?.aborted) kill(); else child.stdin.end('start\n'); }).catch(() => kill());
      });
      child.stdin.on('error', () => kill());
      const abort = () => kill();
      const timer = setTimeout(() => { timedOut = true; kill(); }, Math.max(1, Math.min(600, Number(timeout) || 120)) * 1000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const append = (data) => {
        if (output.length + data.length > 240000) { overflow = true; kill(); return; }
        output += String(data);
        onUpdate?.({ content: [{ type: 'text', text: output.slice(-16000) }] });
      };
      child.stdout.on('data', (data) => { stdout += String(data).slice(0, Math.max(0, 240000 - stdout.length)); append(data); }); child.stderr.on('data', (data) => { stderr += String(data).slice(0, Math.max(0, 240000 - stderr.length)); append(data); });
      child.on('error', reject);
      child.once('exit', () => killGroup('SIGKILL'));
      child.on('close', async (code, exitSignal) => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        killGroup('SIGKILL');
        try { await registration; } catch (error) { reject(error); return; }
        try { await cleanupCommandMarker(root, marker); } catch (error) { reject(error); return; }
        resolve({ content: [{ type: 'text', text: `${output}\nExit code: ${code}; signal: ${exitSignal || 'none'}${timedOut ? '; timed out' : ''}${signal?.aborted ? '; stopped' : ''}${overflow ? '; output limit exceeded' : ''}` }],
          details: { stdout, stderr, exitCode: code, signal: exitSignal, timedOut, stopped: signal?.aborted === true, overflow, ...(proxy ? { network } : {}) }, isError: code !== 0 || timedOut || signal?.aborted || overflow });
      });
    });
  } finally { for (const socket of sockets) socket.destroy(); if (proxy) await new Promise((resolve) => proxy.close(resolve)); await fs.rm(temp, { recursive: true, force: true }); }
}

export function registerConversationCommand(pi) {
  pi.registerTool({ name: 'bash', label: 'Run project command', description: 'Run a bounded shell command in the isolated project working copy. Returns real stdout, stderr and exit status. Only the project and command temporary directory are writable. For local web checks use the allocated $PORT (process.env.PORT) on 127.0.0.1; other direct network access is blocked. When the host has approved public dependency downloads, npm/pip use an enforced HTTPS proxy for only the recorded hosts; install scripts run within the same filesystem sandbox. Project .venv/bin and node_modules/.bin take precedence in PATH. Run one tool at a time. Background processes are terminated when the command finishes. For servers, start, check and stop in a single bounded command.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'number', description: 'Timeout in seconds, at most 600.' } }, required: ['command'] },
    execute: (_id, params, signal, onUpdate) => executeConversationCommand(params, {
      root: process.env.IRIXI_OMO_WORKSPACE_ROOT, readRoots: JSON.parse(process.env.IRIXI_OMO_READ_ROOTS || '[]'),
      environment: JSON.parse(process.env.IRIXI_OMO_COMMAND_ENV || '{}'), networkHosts: JSON.parse(process.env.IRIXI_OMO_NETWORK_HOSTS || '[]'), signal, onUpdate,
    }),
  });
}
