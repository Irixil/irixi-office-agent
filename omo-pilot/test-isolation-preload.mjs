import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const originals = {
  spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, exec: childProcess.exec,
  execSync: childProcess.execSync, execFile: childProcess.execFile, execFileSync: childProcess.execFileSync,
  fork: childProcess.fork, httpRequest: http.request, httpGet: http.get,
  httpsRequest: https.request, httpsGet: https.get, httpCreateServer: http.createServer,
  httpsCreateServer: https.createServer, netConnect: net.connect, netCreateConnection: net.createConnection,
  fetch: globalThis.fetch,
};
const guard = { blockedCalls: 0 };
globalThis.__IRIXI_TEST_ISOLATION__ = guard;
const blocked = () => {
  guard.blockedCalls += 1;
  throw new Error('Real process, network-client, and listening-server access is blocked in isolated product tests.');
};
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = blocked;
http.request = blocked;
http.get = blocked;
https.request = blocked;
https.get = blocked;
net.connect = blocked;
net.createConnection = blocked;
globalThis.fetch = blocked;
http.createServer = (...args) => {
  const server = originals.httpCreateServer(...args);
  server.listen = blocked;
  return server;
};
https.createServer = (...args) => {
  const server = originals.httpsCreateServer(...args);
  server.listen = blocked;
  return server;
};
syncBuiltinESMExports();
