#!/usr/bin/env node
// Zero-network parser-order gate. It reads the candidate's real HTML and
// startup scripts and checks the DOM that a blocking classic script can
// actually see at its parser position. It never invents missing elements.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const value = name => { const index = argv.indexOf(name); return index < 0 ? null : argv[index + 1]; };
const workspace = path.resolve(value('--workspace') || '');
const mode = value('--mode');
const evidence = path.resolve(value('--evidence') || '');
if (!workspace || !evidence || !['baseline', 'candidate'].includes(mode)) {
  throw new Error('Use --workspace source --mode baseline|candidate --evidence new.json');
}

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const html = await fs.readFile(path.join(workspace, 'index.html'), 'utf8');
const app = await fs.readFile(path.join(workspace, 'app.js'), 'utf8');
const achievements = await fs.readFile(path.join(workspace, 'achievements.js'), 'utf8');

function legalOrderControl(source) {
  const button = /<button\s+[^>]*id=["']continueInvalidRetest["'][\s\S]*?<\/button>/i.exec(source)?.[0];
  const achievementScript = /<script\s+[^>]*src=["']achievements\.js["'][^>]*><\/script>/i.exec(source)?.[0];
  const appScript = /<script\s+[^>]*src=["']app\.js["'][^>]*><\/script>/i.exec(source)?.[0];
  assert.ok(button && achievementScript && appScript, 'control requires the real button and startup scripts');
  return source.replace(button, '').replace(achievementScript, '').replace(appScript, `${button}\n${achievementScript}\n${appScript}`);
}

function inspect(source) {
  const appTag = /<script\s+[^>]*src=["']app\.js["'][^>]*><\/script>/i.exec(source);
  const achievementTag = /<script\s+[^>]*src=["']achievements\.js["'][^>]*><\/script>/i.exec(source);
  assert.ok(appTag && achievementTag, 'startup scripts must be present');
  const appIndex = appTag.index;
  const prefix = source.slice(0, appIndex);
  const parsedIds = [...prefix.matchAll(/\bid=["']([^"']+)["']/gi)].map(match => match[1]);
  const visible = id => parsedIds.includes(id) ? { id } : null;
  const bindingIds = [...app.matchAll(/\bn\(["']([^"']+)["']\)\.addEventListener\(/g)].map(match => match[1]);
  assert.ok(bindingIds.includes('continueInvalidRetest'), 'app startup must bind the explicit continuation control');
  const bindingVisibility = Object.fromEntries(bindingIds.map(id => [id, visible(id)]));
  const missingBindingIds = bindingIds.filter(id => bindingVisibility[id] === null);
  const closingHtmlIndex = source.search(/<\/html\s*>/i);
  const buttonIndex = source.search(/<button\s+[^>]*id=["']continueInvalidRetest["']/i);
  return {
    appIndex,
    achievementIndex: achievementTag.index,
    buttonIndex,
    closingHtmlIndex,
    parserLookupForContinuation: visible('continueInvalidRetest'),
    bindingIds,
    missingBindingIds,
    achievementsAvailableWhenAppStarts: achievementTag.index < appIndex,
    continuationParsedWhenAppStarts: buttonIndex >= 0 && buttonIndex < appIndex,
    continuationInsideDocument: closingHtmlIndex < 0 || buttonIndex < closingHtmlIndex,
    classicScripts: [...source.matchAll(/<script\s+([^>]*)src=["']([^"']+)["']([^>]*)><\/script>/gi)].map(match => ({
      src: match[2],
      async: /\basync\b/i.test(`${match[1]} ${match[3]}`),
      defer: /\bdefer\b/i.test(`${match[1]} ${match[3]}`),
      index: match.index,
    })),
  };
}

const exact = inspect(html);
const control = inspect(legalOrderControl(html));
const startupReady = row => row.parserLookupForContinuation !== null && row.missingBindingIds.length === 0 && row.achievementsAvailableWhenAppStarts && row.continuationParsedWhenAppStarts && row.continuationInsideDocument;
const cases = mode === 'baseline'
  ? [
      { id: 'frozen39_parser_lookup_returns_null_for_late_control', passed: exact.parserLookupForContinuation === null && !startupReady(exact), detail: exact },
      { id: 'in_memory_legal_order_parser_lookup_returns_real_control', passed: startupReady(control), detail: control },
    ]
  : [
      { id: 'candidate_parser_visible_startup_contract', passed: startupReady(exact), detail: exact },
    ];

const report = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  mode,
  workspace,
  sourceHashes: {
    indexHtml: sha256(html),
    appJs: sha256(app),
    achievementsJs: sha256(achievements),
  },
  nativeModelCalls: 0,
  networkCalls: 0,
  browserLaunches: 0,
  physicalInput: false,
  cases,
  passed: cases.every(row => row.passed),
  scope: 'Blocking classic-script parser visibility only. Full DOM workflow is covered by the separate headless gate.',
};
await fs.writeFile(evidence, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, mode, cases: cases.map(({ id, passed }) => ({ id, passed })), evidence }));
if (!report.passed) process.exitCode = 1;
