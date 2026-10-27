import childProcess from 'node:child_process';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Install the isolation wall before loading any product module.
const blockedCalls = { process: 0, outboundNetwork: 0, codexRole: 0, developer: 0, hostChecks: 0, modelDecision: 0 };
const blocked = (kind) => (..._args) => { blockedCalls[kind] += 1; throw new Error(`Isolated fixture blocked ${kind}.`); };
const originalDnsLookup = dns.lookup.bind(dns);
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = blocked('process');
for (const name of ['request', 'get']) { http[name] = blocked('outboundNetwork'); https[name] = blocked('outboundNetwork'); }
for (const name of ['connect', 'createConnection']) net[name] = blocked('outboundNetwork');
net.Socket.prototype.connect = blocked('outboundNetwork');
dns.lookup = (hostname, ...args) => hostname === '127.0.0.1'
  ? originalDnsLookup(hostname, ...args)
  : blocked('outboundNetwork')(hostname, ...args);
dns.lookupService = blocked('outboundNetwork');
globalThis.fetch = blocked('outboundNetwork');
syncBuiltinESMExports();

const { createOmoPilotServer } = await import('../../../omo-pilot/server.mjs');
const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-goal-entry-live-controller-'));
const projectRoot = path.join(runtimeDir, 'projects', 'fixture-document-project');
let server;
let controller;
let task;
let stopPromise;

const fakeOmoRoleRunner = async ({ role, signal }) => {
  if (role !== 'Lead') throw new Error(`Isolated fixture rejects unexpected OmO role: ${role}`);
  if (signal.aborted) throw new Error('Fixture Lead was cancelled before waiting.');
  console.log('Synthetic Lead is pending. Submit the full goal form to exercise the real controller goal handler.');
  await new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error('Synthetic Lead cancelled by goal replacement.'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  throw new Error('Synthetic Lead should only settle through abort.');
};

try {
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.writeFile(path.join(projectRoot, 'index.html'), '<!doctype html><html><body>isolated fixture source</body></html>');
  ({ server, controller } = await createOmoPilotServer({
    runtimeDir,
    preferLocalFallback: false,
    omoRoleRunner: fakeOmoRoleRunner,
    codexRoleRunner: async () => { blockedCalls.codexRole += 1; throw new Error('Codex CLI/provider is disabled in this fixture.'); },
    developerRunner: async () => { blockedCalls.developer += 1; throw new Error('Developer execution is disabled in this fixture.'); },
    hostChecksRunner: async () => { blockedCalls.hostChecks += 1; throw new Error('Host checks are not part of this UI fixture.'); },
  }));

  controller.modelStatus = () => ({ state: 'isolated-fixture', requiredModel: 'none', configuredModel: 'none',
    configuredProvider: 'Synthetic local role', modelRegistered: false, connectionStatus: 'disabled',
    liveExecutionBlocked: false, message: 'Isolated UI fixture: no model or CLI provider is available.' });
  controller.aiEnabled = () => true; // Opens the normal Lead UI path; the fake role never reaches a provider.

  const projectId = 'fixture-goal-entry-project';
  controller.state.customProjects.push({ projectId, label: '隔离界面验收工程', rootPath: projectRoot,
    location: 'temporary fixture only', allowedWritePaths: ['index.html'], projectKind: 'utility', requestId: null });
  await controller.save();
  const project = (await controller.listRegisteredProjects()).find((entry) => entry.projectId === projectId);
  if (!project) throw new Error('Could not register the isolated temporary project.');
  task = await controller.createTask({
    title: '换目标入口隔离验收', functionId: 'utility', projectId, projectScopeFingerprint: project.scopeFingerprint,
    statement: '在隔离工程中演示可访问完整的新目标表单。',
    successCriteria: ['从普通项目对话打开完整目标表单。', '目标提交进入真实 goal 处理分支并使旧执行绑定失效。'],
    boundaries: ['所有数据只写入本次临时 runtime。', '不调用模型、CLI、外网或正式任务。'],
    taskCreationRequestId: 'fixture-goal-entry-create-v1',
  });
  await controller.handleTaskAction(task.id, { action: 'authorize_scope', projectId });
  await controller.handleTaskAction(task.id, { action: 'prepare_run', expectedScopeFingerprint: project.scopeFingerprint });

  server.prependListener('request', (req, res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method === 'GET' && new URL(req.url || '/', 'http://127.0.0.1').pathname === '/') {
      const originalEnd = res.end.bind(res);
      res.end = (chunk, encoding, callback) => {
        if (chunk) {
          const html = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
          const banner = `<aside style="position:fixed;z-index:2147483647;inset:0 0 auto;padding:10px 14px;background:#7a271a;color:white;font:14px sans-serif;text-align:center">隔离界面验收：真实本机控制器 + 临时任务；Lead/Developer/Codex 均为无模型假角色。数据只写入临时目录，所有出站连接已封锁。</aside><style>body{padding-top:44px!important}</style>`;
          chunk = Buffer.from(html.replace('</body>', `${banner}</body>`));
        }
        return originalEnd(chunk, encoding, callback);
      };
    }
  });

  const appResponse = await controller.buildProductState(task.id);
  if (appResponse?.native?.actions?.canRun !== true || appResponse?.native?.actions?.canGoal !== true) {
    throw new Error('Prepared fixture did not expose the normal run and goal UI actions.');
  }
  if (server.listening) throw new Error('Fixture server unexpectedly started before explicit launch confirmation.');

  let stopping = false;
  stopPromise = new Promise((resolve) => {
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      controller.abortExecutionControllers(task.execution?.id);
      server.closeAllConnections?.();
      if (server.listening) await new Promise((done) => server.close(done));
      await controller.save();
      const evidence = { stopped: true, retained: true, taskId: task.id, executionId: task.execution?.id || null,
        taskStore: controller.stateFile, blockedCalls, recordedAt: new Date().toISOString() };
      const evidencePath = path.join(runtimeDir, 'fixture-operation-evidence.json');
      await fs.writeFile(evidencePath, JSON.stringify(evidence, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ ...evidence, evidencePath }, null, 2));
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      console.log('LIVE ISOLATED CONTROLLER FIXTURE — no production data or provider');
      console.log(`Open http://127.0.0.1:${port}/?backend=openoffice&task=${encodeURIComponent(task.id)}`);
      console.log(`TaskStore: ${controller.stateFile}`);
      console.log('Flow: click “开始执行” and accept the warning; wait for the synthetic Lead; open “更换完整工作目标”; submit a new full goal.');
      console.log('Stop with Ctrl+C. The temporary runtime and operation evidence are retained for review.');
    });
  });
  await stopPromise;
} catch (error) {
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (runtimeDir) {
    const evidencePath = path.join(runtimeDir, 'fixture-startup-error.json');
    await fs.writeFile(evidencePath, JSON.stringify({ message: String(error?.message || error), blockedCalls,
      retained: true, recordedAt: new Date().toISOString() }, null, 2), { mode: 0o600 }).catch(() => {});
    console.error(`Isolated fixture evidence retained at ${evidencePath}`);
  }
  throw error;
}
