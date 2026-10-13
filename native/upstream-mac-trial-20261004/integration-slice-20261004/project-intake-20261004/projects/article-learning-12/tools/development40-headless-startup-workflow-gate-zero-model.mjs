#!/usr/bin/env node
// Real headless Chrome + actual HTML parser/classic scripts. The HTTP/API/model
// endpoints are process-local fixtures; this never contacts the product service
// or a model and never writes the candidate workspace.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2), arg = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
const workspace = path.resolve(arg('--workspace') || ''), mode = arg('--mode'), evidence = path.resolve(arg('--evidence') || '');
if (!workspace || !evidence || !['baseline','selfcheck','candidate'].includes(mode)) throw Error('Use --workspace source --mode baseline|selfcheck|candidate --evidence new.json');
const project = path.resolve(import.meta.dirname, '..'), chromeBinary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const actualRecord = JSON.parse(await fs.readFile(path.join(project, 'backend/learning-08-original-retest-client-failure/actual-local-record.json')));
const raw = JSON.parse(await fs.readFile(path.join(project, 'backend/learning-08-original-retest-client-failure/original-rejected-raw-assessment.json')));
const KEY = 'irixi.article-learning-12.session.v1', sourceTurnId = '3427b9ea-dc67-43ca-84f9-30429cc8d8ba', invalidTurnId = '2dbd94bc-f4b1-4868-ae4f-0589dfc502e2';
const goalVersionId = 'controlled-goal', candidateSha256 = 'c'.repeat(64), initialRecordBytes = JSON.stringify(actualRecord);
const sha = value => crypto.createHash('sha256').update(value).digest('hex'), sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const htmlBytes = await fs.readFile(path.join(workspace, 'index.html'), 'utf8');
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), mode, workspace, workspaceIndexSha256: sha(htmlBytes), nativeModelCalls: 0, productApiCalls: 0, physicalInput: false, headless: true, cases: [], limitations: [] };
const check = (id, passed, detail = null) => report.cases.push({ id, passed: Boolean(passed), detail });

function legalOrderControl(html) {
  const button = /<button id="continueInvalidRetest"[\s\S]*?<\/button>/.exec(html)?.[0];
  const achievements = '<script src="achievements.js"></script>';
  assert.ok(button && html.includes(achievements) && html.includes('<script src="app.js"></script>'));
  let controlled = html.replace(button, '').replace(achievements, '');
  controlled = controlled.replace('<script src="app.js"></script>', `${button}\n${achievements}\n<script src="app.js"></script>`);
  return controlled;
}

const stats = { requests: [], materialPosts: 0, inferencePosts: 0, inferenceGets: 0, statePuts: [], stateGets: 0 };
let material = { ...actualRecord.material }, revision = 16, savedState = { schemaVersion: 3, record: structuredClone(actualRecord), cumulative: {} }, rejectNextRebind = false, lastInference = null;
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); const bytes = Buffer.concat(chunks); if (bytes.length > 256 * 1024) throw Error('fixture body too large'); return bytes.length ? JSON.parse(bytes) : null; }
function resetOld({ reject = false } = {}) { material = { ...actualRecord.material }; revision = 16; savedState = { schemaVersion: 3, record: structuredClone(actualRecord), cumulative: {} }; rejectNextRebind = reject; }

const fixtureScript = `(()=>{const KEY=${JSON.stringify(KEY)},SEED=${JSON.stringify(initialRecordBytes)};if(!localStorage.getItem(KEY))localStorage.setItem(KEY,SEED);window.__controlledHeadlessFixture=true;const native=window.setTimeout.bind(window);window.setTimeout=(fn,ms,...a)=>native(fn,ms===5000?350:ms,...a);window.addEventListener('error',e=>{(window.__startupErrors||=[]).push(e.message)});window.addEventListener('unhandledrejection',e=>{(window.__startupErrors||=[]).push(String(e.reason?.message||e.reason))});})();`;
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://fixture'), method = req.method || 'GET';
    if (url.pathname === '/__fixture/state') return json(res, 200, { stats, material, revision, savedState, rejectNextRebind });
    if (url.pathname === '/__fixture/reset-reject' && method === 'POST') { resetOld({ reject: true }); return json(res, 200, { ok: true }); }
    if (url.pathname.startsWith('/api/')) {
      const input = method === 'POST' || method === 'PUT' ? await body(req) : null; stats.requests.push({ method, path: url.pathname, search: url.search, input });
      if (url.pathname === '/api/irixi-authority') return json(res, 200, { current: true, goalVersionId, artifact: { candidateSha256, confirmation: { id: 'controlled-confirmation' } } });
      if (url.pathname === '/api/irixi-intake') return json(res, 200, { modelAvailability: { learning: { enabled: true, sealed: false, running: false, remaining: 2, deadlineAt: new Date(Date.now() + 10 * 60_000).toISOString() } } });
      if (url.pathname === '/api/irixi-materials' && method === 'POST') {
        stats.materialPosts++; material = { materialEventId: `controlled-material-${stats.materialPosts}`, sessionId: input.sessionId, label: input.label, source: input.source, articleText: input.articleText, articleSha256: actualRecord.material.articleSha256, normalization: 'controlled exact article' };
        revision = 0; savedState = null; return json(res, 200, material);
      }
      if (url.pathname === '/api/irixi-client-state' && url.searchParams.get('scope') === 'project') return json(res, 200, { scope: 'project', items: [], totalSessions: 0, truncated: false, limit: 200 });
      if (url.pathname === '/api/irixi-client-state') {
        if (method === 'GET') { stats.stateGets++; return json(res, 200, { revision, state: savedState, stateSha256: savedState ? sha(JSON.stringify(savedState)) : null, goalVersionId, candidateSha256, materialEventId: material.materialEventId, material }); }
        stats.statePuts.push(structuredClone(input));
        if (rejectNextRebind && String(material.materialEventId).startsWith('controlled-material-') && input.expectedMaterialEventId === material.materialEventId) { rejectNextRebind = false; return json(res, 409, { error: 'controlled CAS rejection' }); }
        if (input.expectedRevision !== revision || input.expectedGoalVersionId !== goalVersionId || input.expectedCandidateSha256 !== candidateSha256 || input.expectedMaterialEventId !== material.materialEventId) return json(res, 409, { error: 'controlled stale CAS' });
        revision++; savedState = structuredClone(input.state); return json(res, 200, { revision, stateSha256: sha(JSON.stringify(savedState)), goalVersionId, candidateSha256, materialEventId: material.materialEventId });
      }
      if (url.pathname === '/api/irixi-inference') {
        if (method === 'POST') { stats.inferencePosts++; lastInference = structuredClone(input); return json(res, 200, { accepted: true, turnId: input.turnId, remaining: 1 }); }
        stats.inferenceGets++; if (!lastInference || url.searchParams.get('turnId') !== lastInference.turnId) return json(res, 404, { error: 'controlled unknown turn' });
        return json(res, 200, { status: 'done', text: JSON.stringify(raw), textSha256: sha(JSON.stringify(raw)) });
      }
      return json(res, 404, { error: 'unhandled fixture API' });
    }
    const match = /^\/(exact|control)\/(fixture\.js|index\.html|core\.js|p0-repair\.js|app\.js|achievements\.js|styles\.css)$/.exec(url.pathname);
    if (!match) { res.writeHead(404); return res.end(); }
    let text, mime = 'text/javascript';
    if (match[2] === 'fixture.js') text = fixtureScript;
    else {
      text = await fs.readFile(path.join(workspace, match[2]), 'utf8');
      if (match[2] === 'index.html') { mime = 'text/html'; if (match[1] === 'control') text = legalOrderControl(text); text = text.replace('<script src="core.js">', '<script src="fixture.js"></script><script src="core.js">'); }
      else if (match[2].endsWith('.css')) mime = 'text/css';
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }); res.end(text);
  } catch (error) { json(res, 500, { error: error.message }); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port, profile = await fs.mkdtemp(path.join(os.tmpdir(), 'development40-headless-profile-'));
const chrome = spawn(chromeBinary, ['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--disable-component-update','--disable-default-apps','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { stdio: ['ignore','ignore','pipe'] });
let diagnostics = '', browserSocket, targetSocket, control, send, pageErrors = [], ordinal = 0;
chrome.stderr.on('data', bytes => { diagnostics += bytes; });
function cdp(socket, event) { const pending = new Map(); socket.addEventListener('message', message => { const value = JSON.parse(String(message.data)); if (value.id && pending.has(value.id)) { const row = pending.get(value.id); pending.delete(value.id); value.error ? row.reject(Error(value.error.message)) : row.resolve(value.result); } else event?.(value); }); return (method, params = {}) => new Promise((resolve, reject) => { const id = ++ordinal; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }); }
async function socket(url) { const value = new WebSocket(url); await new Promise((resolve, reject) => { value.addEventListener('open', resolve, { once: true }); value.addEventListener('error', reject, { once: true }); }); return value; }
async function evaluate(expression) { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result.value; }
async function until(expression, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await evaluate(expression); if (value) return value; } catch {} await sleep(25); } throw Error(`condition did not settle: ${expression}`); }
async function navigate(kind) { pageErrors = []; await send('Page.navigate', { url: `http://127.0.0.1:${port}/${kind}/index.html` }); await sleep(500); }

try {
  for (let i = 0; i < 120 && !/DevTools listening on (ws:\/\/\S+)/.test(diagnostics); i++) await sleep(50);
  const ws = /DevTools listening on (ws:\/\/\S+)/.exec(diagnostics)?.[1]; assert.ok(ws, 'headless Chrome endpoint');
  browserSocket = await socket(ws); control = cdp(browserSocket); const { targetId } = await control('Target.createTarget', { url: 'about:blank' });
  const base = ws.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, ''), pages = await (await fetch(`${base}/json/list`)).json();
  targetSocket = await socket(pages.find(item => item.id === targetId).webSocketDebuggerUrl);
  send = cdp(targetSocket, event => { if (event.method === 'Runtime.exceptionThrown') pageErrors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text); });
  await send('Page.enable'); await send('Runtime.enable');

  await navigate(mode === 'selfcheck' ? 'control' : 'exact');
  const exactStartup = await evaluate('({fixture:!!window.__controlledHeadlessFixture,button:!!document.getElementById("continueInvalidRetest"),errors:window.__startupErrors||[],runtime:document.getElementById("runtimeText")?.textContent})');
  const exactCrashed = pageErrors.some(value => /addEventListener/.test(value)) || exactStartup.errors.some(value => /addEventListener/.test(value));
  if (mode === 'baseline') check('exact39_real_parser_startup_failure_reproduced', exactCrashed, { pageErrors, exactStartup });
  else check(mode === 'selfcheck' ? 'in_memory_legal_order_starts_for_workflow_selfcheck' : 'candidate_real_parser_startup_has_no_exception', !exactCrashed && pageErrors.length === 0, { pageErrors, exactStartup });

  if (mode === 'baseline') {
    await navigate('control'); await until('window.__controlledHeadlessFixture && document.getElementById("continueInvalidRetest") && window.LearningAchievements');
    const controlled = await evaluate('({errors:window.__startupErrors||[],button:!!document.getElementById("continueInvalidRetest"),achievements:!!window.LearningAchievements})');
    check('in_memory_legal_order_control_starts', pageErrors.length === 0 && controlled.errors.length === 0 && controlled.button && controlled.achievements, { pageErrors, controlled });
    report.expectedBaselineFailureReproduced = report.cases.every(row => row.passed); report.passed = report.expectedBaselineFailureReproduced;
  } else {
    await until('window.__controlledHeadlessFixture && window.LearningAchievements && document.getElementById("continueInvalidRetest")');
    await until('!document.getElementById("continueInvalidRetest").hidden && !document.getElementById("continueInvalidRetest").disabled');
    const before = await evaluate(`(async()=>({bytes:localStorage.getItem(${JSON.stringify(KEY)}),state:JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})),stats:await fetch('/__fixture/state').then(r=>r.json())}))()`);
    await evaluate('document.getElementById("continueInvalidRetest").click();document.getElementById("continueInvalidRetest").click();true');
    const preparedId = await until(`(()=>{const r=JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}));const p=r.turns.filter(t=>t.status==='pending');return p.length===1?p[0].turnId:''})()`);
    let afterClick = await evaluate(`fetch('/__fixture/state').then(r=>r.json()).then(server=>({record:JSON.parse(localStorage.getItem(${JSON.stringify(KEY)})),server}))`);
    const prepared = afterClick.record.turns.find(turn => turn.turnId === preparedId);
    check('native_click_prepares_one_saved_identity_without_inference', preparedId !== invalidTurnId && prepared?.questionSourceTurnId === sourceTurnId && prepared?.context?.questionSourceTurnId === sourceTurnId && afterClick.server.stats.materialPosts === 1 && afterClick.server.stats.inferencePosts === 0 && afterClick.server.savedState?.record?.turns?.some(turn => turn.turnId === preparedId && turn.status === 'pending'), { preparedId, materialPosts: afterClick.server.stats.materialPosts, inferencePosts: afterClick.server.stats.inferencePosts, statePutCount: afterClick.server.stats.statePuts.length, stateGets: afterClick.server.stats.stateGets });
    check('old_invalid_remains_byte_exact_after_click', JSON.stringify(before.state.turns.find(turn=>turn.turnId===invalidTurnId)) === JSON.stringify(afterClick.record.turns.find(turn=>turn.turnId===invalidTurnId)));

    const pageKind = mode === 'selfcheck' ? 'control' : 'exact';
    await navigate(pageKind); await until(`(()=>{const r=JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}));return r.turns.some(t=>t.turnId===${JSON.stringify(preparedId)}&&t.status==='pending')&&!document.getElementById('assessBtn').disabled})()`);
    const postsBefore = (await evaluate("fetch('/__fixture/state').then(r=>r.json())")).stats.inferencePosts;
    await evaluate('document.getElementById("answer").value="受控正确答案；不是用户学习结果";const f=document.getElementById("answerForm");f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));f.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));true');
    await until(`fetch('/__fixture/state').then(x=>x.json()).then(x=>x.stats.inferencePosts===${postsBefore + 1})`);
    await until(`(()=>{const r=JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}));return r.turns.some(t=>t.turnId===${JSON.stringify(preparedId)}&&t.status==='done')})()`, 15000);
    const completed = await evaluate(`fetch('/__fixture/state').then(r=>r.json()).then(server=>({server,record:JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}))}))`);
    const runningSaved = completed.server.stats.statePuts.some(row => row.state?.record?.turns?.some(turn => turn.turnId === preparedId && turn.status === 'running' && turn.context?.questionSourceTurnId === sourceTurnId));
    check('concurrent_submit_posts_once_and_saves_same_running_identity', completed.server.stats.inferencePosts === postsBefore + 1 && runningSaved, { preparedId, inferencePosts: completed.server.stats.inferencePosts, statePutCount: completed.server.stats.statePuts.length });
    check('controlled_done_consumes_prepared_identity_and_preserves_source', completed.record.turns.some(turn => turn.turnId === preparedId && turn.status === 'done' && turn.context?.questionSourceTurnId === sourceTurnId) && !completed.record.turns.some(turn => turn.status === 'pending'), { preparedId });
    const postsAtDone = completed.server.stats.inferencePosts; await navigate(pageKind); await sleep(300); const reopened = await evaluate(`fetch('/__fixture/state').then(r=>r.json()).then(server=>({server,record:JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}))}))`);
    check('reopen_keeps_done_identity_without_repost', reopened.server.stats.inferencePosts === postsAtDone && reopened.record.turns.some(turn => turn.turnId === preparedId && turn.status === 'done'), { postsAtDone, postsAfterReopen: reopened.server.stats.inferencePosts });

    await evaluate(`localStorage.setItem(${JSON.stringify(KEY)},${JSON.stringify(initialRecordBytes)});fetch('/__fixture/reset-reject',{method:'POST'})`); await navigate(pageKind); await until('!document.getElementById("continueInvalidRetest").hidden && !document.getElementById("continueInvalidRetest").disabled');
    const rejectBefore = await evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}))`), rejectStatsBefore = await evaluate("fetch('/__fixture/state').then(r=>r.json()).then(x=>x.stats.inferencePosts)");
    await evaluate('document.getElementById("continueInvalidRetest").click();true');
    let rollbackSettled = false;
    try { await until(`(()=>{const r=JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}));return !r.turns.some(t=>t.status==='pending')&&!document.getElementById('continueInvalidRetest').hidden&&!document.getElementById('continueInvalidRetest').disabled})()`, 5000); rollbackSettled = true; } catch {}
    const rejectAfter = await evaluate(`(async()=>({bytes:localStorage.getItem(${JSON.stringify(KEY)}),available:!document.getElementById('continueInvalidRetest').hidden&&!document.getElementById('continueInvalidRetest').disabled,stats:await fetch('/__fixture/state').then(r=>r.json())}))()`);
    const rejectedRecord = JSON.parse(rejectAfter.bytes), beforeInvalid = rejectBefore.turns.find(turn => turn.turnId === invalidTurnId), afterInvalid = rejectedRecord.turns.find(turn => turn.turnId === invalidTurnId);
    const rollbackPreserved = JSON.stringify(beforeInvalid) === JSON.stringify(afterInvalid) && !rejectedRecord.turns.some(turn => turn.status === 'pending') && rejectedRecord.material.materialEventId === rejectBefore.material.materialEventId;
    check('cas409_restores_prior_record_and_control_without_inference', rollbackSettled && rollbackPreserved && rejectAfter.available && rejectAfter.stats.stats.inferencePosts === rejectStatsBefore, { rollbackSettled, rollbackPreserved, available: rejectAfter.available, currentMaterialEventId: rejectedRecord.material?.materialEventId, priorMaterialEventId: rejectBefore.material?.materialEventId, pendingCount: rejectedRecord.turns.filter(turn=>turn.status==='pending').length, postsBefore: rejectStatsBefore, postsAfter: rejectAfter.stats.stats.inferencePosts });
    report.passed = report.cases.every(row => row.passed); report.productWorkflowPassed = report.passed;
  }
} catch (error) { report.error = { name: error.name, message: error.message, stack: error.stack }; report.passed = false; }
finally {
  try { if (control) await control('Browser.close'); } catch {}
  targetSocket?.close(); browserSocket?.close(); await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), sleep(2000)]); if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill('SIGTERM');
  await new Promise(resolve => server.close(resolve));
  report.finishedAt = new Date().toISOString(); report.limitations.push('All API and inference results are local fixtures; this is real HTML/parser/DOM behavior but not a product service, Native model, or human-learning result.');
  await fs.writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, mode, cases: report.cases.map(({id,passed})=>({id,passed})), nativeModelCalls: 0, productApiCalls: 0, physicalInput: false, evidence }));
  if (!report.passed) process.exitCode = 1;
}
