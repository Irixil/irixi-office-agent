import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createOmoPilotServer } from '../omo-pilot/server.mjs';

const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const runtimeDir = path.resolve(option('--runtime', path.join(os.homedir(), 'Library/Application Support/IRiXi/Personal Agent P0')));
const port = Number(option('--port', '58312'));
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口无效。');
// Reserve the port before loading/recovering any task state. A duplicate launch
// must fail before it can interrupt an existing instance's children or ledger.
const reservation = http.createServer((req, res) => {
  res.writeHead(503, { 'x-irixi-starting': '1' }); res.end('试用入口正在启动。');
});
await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(port, '127.0.0.1', resolve); });
await fs.mkdir(path.join(runtimeDir, 'tmp'), { recursive: true });
process.env.TMPDIR = path.join(runtimeDir, 'tmp');
let instance;
try { instance = await createOmoPilotServer({ runtimeDir, includeBuiltinProjects: false, conversationMode: true, httpServer: reservation }); }
catch (error) { reservation.close(); throw error; }
const { server, conversations } = instance;
console.log(`IRiXI Personal Agent P0: http://127.0.0.1:${port}/?backend=openoffice&view=office\nData: ${runtimeDir}`);
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  server.close();
  for (const c of conversations.state.conversations) await conversations.stop(c.id, { preservePending: true });
  await Promise.all([...conversations.jobs.values()]);
  await conversations.applications.close();
  await conversations.save(); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
