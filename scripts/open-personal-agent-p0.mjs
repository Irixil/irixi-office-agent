import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2); const option = (name, value) => args.includes(name) ? args[args.indexOf(name) + 1] : value;
const runtime = path.resolve(option('--runtime', path.join(os.homedir(), 'Library/Application Support/IRiXi/Personal Agent P0')));
const port = Number(option('--port', '58312'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效。');
const url = `http://127.0.0.1:${port}/?backend=openoffice&view=office`;
if (!fs.existsSync(path.join(runtime, 'conversation/state.json'))) throw new Error('长期试用数据尚未安装。没有创建空目录或替换记录。');
async function running() {
  let response;
  try { response = await fetch(`http://127.0.0.1:${port}/api/product-health`, { signal: AbortSignal.timeout(10000) }); }
  catch (error) {
    if (error.cause?.code === 'ECONNREFUSED') return false;
    throw new Error('试用入口暂时没有回应。为保护正在运行的任务，没有启动第二个实例。请稍后再打开。', { cause: error });
  }
  if (response.status === 503 && response.headers.get('x-irixi-starting') === '1') return 'starting';
  if (!response.ok) throw new Error(`${port} 已被其他服务占用。没有停止或替换该服务。`);
  const state = await response.json();
  if (state.storagePath !== path.join(runtime, 'conversation')) throw new Error(`${port} 当前是另一个测试实例。没有覆盖它的数据或停止它。`);
  const html = await (await fetch(url, { signal: AbortSignal.timeout(10000) })).text();
  if (!html.includes(`/conversation-app.js?v=${state.build}`)) throw new Error('产品源码已更新。请由维护者安全重载；对话和成果仍在。');
  return true;
}
let readiness = await running();
if (!readiness) {
  const log = fs.openSync(path.join(runtime, 'server.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(repo, 'scripts/start-personal-agent-p0.mjs'), '--runtime', runtime, '--port', String(port)], {
    cwd: repo, detached: true, stdio: ['ignore', log, log],
  });
  child.unref(); fs.closeSync(log);
}
if (readiness !== true) {
  let ready = false;
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await running() === true) { ready = true; break; }
  }
  if (!ready) throw new Error(`试用入口未启动。记录位于 ${path.join(runtime, 'server.log')}。`);
}
console.log(`试用入口已就绪：${url}`);
if (!process.argv.includes('--no-open')) spawn('/usr/bin/open', [url], { stdio: 'ignore' }).unref();
