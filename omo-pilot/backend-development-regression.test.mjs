import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const modules = process.env.IRIXI_BACKEND_CANDIDATE ? path.join(process.env.IRIXI_BACKEND_CANDIDATE, 'omo-pilot') : import.meta.dirname;
const { fileIndex } = await import(pathToFileURL(path.join(modules, 'conversation-project.mjs')));
const { validateBehaviorCase, checkBehavior } = await import(pathToFileURL(path.join(modules, 'conversation-checks.mjs')));
const { executeConversationCommand } = await import(pathToFileURL(path.join(modules, 'conversation-command.mjs')));
const { ConversationApplications } = await import(pathToFileURL(path.join(modules, 'conversation-application.mjs')));
const evidence = process.env.IRIXI_BACKEND_TEST_EVIDENCE;
const fixtures = [];
async function fixture(name) { const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `irixi-be-${name}-`))); fixtures.push(root); return root; }
async function record(name, value) { if (evidence) { await fs.mkdir(evidence, { recursive: true }); await fs.writeFile(path.join(evidence, `${name}.json`), JSON.stringify(value, null, 2)); } }

// These are small component fixtures. They are not either promised product case,
// and no model or normal product conversation is used in these tests.
test('source index excludes real SQLite/sidecars and rebuildable environments, while retaining source and rejecting links', async () => {
  const root = await fixture('source-index');
  await fs.writeFile(path.join(root, 'source.py'), 'print(42)\n');
  await fs.writeFile(path.join(root, 'notes.db'), 'ordinary source text, not a database\n');
  for (const name of ['.venv/bin', '__pycache__', '.irixi-data', 'node_modules/pkg']) await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.symlink('/usr/bin/python3', path.join(root, '.venv/bin/python'));
  await fs.writeFile(path.join(root, '__pycache__/source.pyc'), 'cache');
  await fs.writeFile(path.join(root, '.irixi-data/private.sqlite'), 'runtime data');
  execFileSync('/usr/bin/python3', ['-I', '-c', "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('create table items(value integer)');c.execute('insert into items values(17)');c.commit();c.close()", path.join(root, 'data.sqlite')]);
  await fs.writeFile(path.join(root, 'data.sqlite-wal'), 'component sidecar');
  await fs.writeFile(path.join(root, 'data.sqlite-shm'), 'component sidecar');
  const dataFiles = []; const index = await fileIndex(root, undefined, { dataFiles });
  assert.deepEqual(Object.keys(index).sort(), ['notes.db', 'source.py']); assert.deepEqual(dataFiles, ['data.sqlite']);
  await fs.symlink('source.py', path.join(root, 'ordinary-link.py')); await assert.rejects(() => fileIndex(root), /链接/u); await fs.unlink(path.join(root, 'ordinary-link.py'));
  await fs.link(path.join(root, 'source.py'), path.join(root, 'hardlink.py')); await assert.rejects(() => fileIndex(root), /链接/u);
  await record('source-index', { root, index, dataFiles, normalLinksRejected: true });
});

test('Python behavioral check uses the project interpreter and actual installed dependency', async () => {
  const root = await fixture('python-check');
  const installed = await executeConversationCommand({ command: '/usr/bin/python3 -m venv .venv && python3 -m pip install --disable-pip-version-check --no-input --retries 0 --timeout 10 packaging==24.2', timeout: 45 }, { root, networkHosts: ['pypi.org', 'files.pythonhosted.org'], registryPath: path.join(root, 'commands.jsonl') });
  assert.equal(installed.details.exitCode, 0, installed.details.stderr);
  await fs.writeFile(path.join(root, 'check.py'), 'import packaging,sys\nprint(packaging.__version__)\nprint(sys.executable)\n');
  const value = validateBehaviorCase({ caseId: 'project-python', requirement: 'Run with the installed project package and interpreter', kind: 'cli', runner: 'python3', target: 'check.py', expected: { stdoutIncludes: ['24.2', path.join(root, '.venv/bin/python3')] } });
  const checked = await checkBehavior(value, { root, registryPath: path.join(root, 'commands.jsonl') });
  assert.equal(checked.status, 'passed', JSON.stringify(checked)); assert.ok(checked.coveredFiles.includes('check.py'));
  await fs.writeFile(path.join(root, 'check.py'), 'print("wrong interpreter result")\n');
  const broken = await checkBehavior(value, { root, registryPath: path.join(root, 'commands.jsonl') });
  assert.equal(broken.status, 'failed'); await record('python-check', { root, installed, checked, broken });
});

async function applicationFixture(t) {
  const directory = await fixture('dynamic-check'); const root = path.join(directory, 'project'); await fs.mkdir(root);
  const runtime = path.join(directory, 'runtime'); await fs.mkdir(runtime);
  await fs.writeFile(path.join(root, '.irixi-app.json'), JSON.stringify({ command: 'node server.mjs', readyPath: '/health', env: {}, dataFiles: ['records.sqlite'] }));
  const source = `import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
const db=new DatabaseSync(path.join(process.env.IRIXI_DATA_DIR,'records.sqlite'));db.exec('PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS counts(value INTEGER);INSERT INTO counts SELECT 17 WHERE NOT EXISTS(SELECT 1 FROM counts)');
const value=()=>db.prepare('SELECT value FROM counts').get()?.value;
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');
if(req.url==='/health'){res.end(JSON.stringify({ready:true}));return;}
if(req.url==='/state'){res.end(JSON.stringify({value:fs.existsSync('broken-api')?-1:value(),label:'component'}));return;}
if(req.url==='/increment'&&req.method==='POST'){db.exec('UPDATE counts SET value=value+1');res.end(JSON.stringify({value:value()}));return;}
if(req.url==='/break-db'&&req.method==='POST'){db.exec('UPDATE counts SET value=-2');res.end(JSON.stringify({broken:true}));return;}
if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><button id="inc">Increment</button><div id="value">Loading</div><script>async function show(){const r=await fetch("/state").then(r=>r.json());document.querySelector("#value").textContent=String(r.value)}document.querySelector("#inc").onclick=async()=>{await fetch("/increment",{method:"POST"});await show()};show()</script>');return;}
res.writeHead(404);res.end(JSON.stringify({error:'missing'}));});server.listen(Number(process.env.PORT),'127.0.0.1');`;
  await fs.writeFile(path.join(root, 'server.mjs'), source);
  const project = { id: 'component-project', root }; const store = { root: runtime, state: { projects: [project] }, save: async () => {} };
  const manager = new ConversationApplications(store); t.after(() => manager.close());
  const application = await manager.start(project, { version: 'component-v1', turnId: 'component-turn' });
  return { root, manager, project, application, registryPath: path.join(directory, 'checks.jsonl') };
}
function appCase(caseId, actions) { return validateBehaviorCase({ caseId, requirement: 'Verify the actual component HTTP application and persistent records', kind: 'application', target: 'server.mjs', actions }); }

test('dynamic checks exercise DOM actions, actual HTTP, and live SQLite; broken outputs cannot pass', async (t) => {
  const context = await applicationFixture(t); const { root, application } = context;
  const value = appCase('component-actions', [
    { action: 'assert', selector: '#value', textEquals: '17' }, { action: 'click', selector: '#inc' }, { action: 'assert', selector: '#value', textEquals: '18' },
    { action: 'http', method: 'GET', path: '/state', status: 200, jsonEquals: { value: 18, label: 'component' } },
    { action: 'sqlite', file: 'records.sqlite', query: 'SELECT value FROM counts', rows: [{ value: 18 }] },
  ]);
  const checked = await checkBehavior(value, context); await record('dynamic-success', { root, application, checked });
  assert.equal(checked.status, 'passed', JSON.stringify(checked));
  await fs.writeFile(path.join(root, 'broken-api'), 'return a deliberately incorrect value');
  const brokenHttp = await checkBehavior(appCase('broken-http', [{ action: 'http', method: 'GET', path: '/state', status: 200, jsonEquals: { value: 18, label: 'component' } }]), context);
  assert.equal(brokenHttp.status, 'failed');
  const brokenDom = await checkBehavior(appCase('broken-dom', [{ action: 'assert', selector: '#value', textEquals: '18' }]), context); assert.equal(brokenDom.status, 'failed');
  await fs.unlink(path.join(root, 'broken-api'));
  await fetch(new URL('/break-db', application.url), { method: 'POST', headers: { Origin: new URL(application.url).origin } });
  const brokenSqlite = await checkBehavior(appCase('broken-database', [{ action: 'sqlite', file: 'records.sqlite', query: 'SELECT value FROM counts', rows: [{ value: 18 }] }]), context); assert.equal(brokenSqlite.status, 'failed');
  await record('dynamic-mutation-failures', { brokenHttp, brokenDom, brokenSqlite });
});

test('JSON and SQLite row comparisons respect object field semantics, not key insertion order', async (t) => {
  const context = await applicationFixture(t);
  const checkedHttp = await checkBehavior(appCase('json-field-order', [
    { action: 'http', method: 'GET', path: '/state', status: 200, jsonEquals: { label: 'component', value: 17 } },
  ]), context);
  const checkedSqlite = await checkBehavior(appCase('sqlite-field-order', [
    { action: 'sqlite', file: 'records.sqlite', query: "SELECT value, 'component' AS label FROM counts", rows: [{ label: 'component', value: 17 }] },
  ]), context);
  await record('json-field-order', { checkedHttp, checkedSqlite });
  assert.equal(checkedHttp.status, 'passed', JSON.stringify(checkedHttp)); assert.equal(checkedSqlite.status, 'passed', JSON.stringify(checkedSqlite));
});

test.after(async () => { await record('fixture-locations', { modules, fixtures, note: 'Component fixtures only; retained for evidence. All application managers closed.' }); });
