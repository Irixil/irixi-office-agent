import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';
import { openChromeTrial } from '../../article-learning-11/browser/real-discussion-20261005/chrome-headed.mjs';
import { closeControlledBrowserSession } from './browser-session-lifecycle.mjs';

const project = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
let trialName = 'real-project-20261005', profileTrial = null;
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--trial', '--profile-trial'].includes(args[i]) && /^[A-Za-z0-9_-]{1,90}$/.test(args[i + 1] || ''), 'Use --trial safe-name and optional --profile-trial prior-safe-name');
  if (args[i] === '--trial') trialName = args[i + 1]; else profileTrial = args[i + 1];
}
const owned = path.join(project, 'browser', trialName);
const profilePath = path.join(project, 'browser', profileTrial || trialName, 'chrome-profile');
const actions = [];
let browser;
await fs.mkdir(owned, { recursive: true });
try { await fs.access(path.join(owned, 'session-evidence.json')); throw new Error('Use a new trial name to preserve prior browser evidence'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (profileTrial) {
  const profileStat = await fs.lstat(profilePath);
  assert.ok(profileStat.isDirectory() && !profileStat.isSymbolicLink(), 'Reopen requires the actual prior isolated browser profile');
}
function requireUnlocked() {
  const rows = execFileSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-l'], { encoding: 'utf8' }).split('\n');
  const lock = rows.find(l => l.includes('IOConsoleUsers')) || '';
  const rootLock = rows.find(l => l.includes('"IOConsoleLocked"')) || '';
  assert.ok(/"IOConsoleLocked"\s*=\s*No/.test(rootLock) && lock.includes('kCGSessionLoginDoneKey"=Yes') && lock.includes('kCGSSessionOnConsoleKey"=Yes') && !lock.includes('CGSSessionScreenIsLocked"=Yes'), 'Mac must already be unlocked; this harness cannot unlock it or change security settings');
}
requireUnlocked();
browser = await openChromeTrial({ url: 'http://127.0.0.1:9109/pair', ownedRoot: owned, profilePath, safeWorkspacePath: path.join(project, 'workspace') });
const save = async () => fs.writeFile(path.join(owned, 'session-evidence.json'), JSON.stringify({ startedAt: actions[0]?.at, actions, browser: browser.evidence, businessCreatedByHarness: false }, null, 2) + '\n');
const click = async (selector) => {
  requireUnlocked();
  await browser.evaluate(`document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center',behavior:'instant'})`);
  await new Promise(resolve => setTimeout(resolve, 300));
  const pos = await browser.evaluate(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});if(!n)return null;const r=n.getBoundingClientRect(),h=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {x:r.x+r.width/2,y:r.y+r.height/2,visible:r.width>0&&r.height>0,hit:h===n||n.contains(h),disabled:!!n.disabled,text:n.textContent.trim()};})()`);
  assert.ok(pos?.visible && pos.hit && !pos.disabled, `Control is not actually clickable: ${selector}`);
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 });
  return pos;
};
actions.push({ at: new Date().toISOString(), op: 'open', url: 'http://127.0.0.1:9109/pair' });
await save();
process.stdout.write(JSON.stringify({ ready: true, owned, headed: true }) + '\n');
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  if (!line.trim()) continue;
  let command;
  try {
    command = JSON.parse(line);
    let result;
    if (command.op === 'read') result = await browser.evaluate(command.expression);
    else if (command.op === 'snapshot') result = await browser.evaluate("({url:location.href,title:document.title,text:document.body.innerText.slice(0,9000),buttons:[...document.querySelectorAll('button')].map(n=>({text:n.textContent.trim(),disabled:n.disabled})).filter(n=>n.text),inputs:[...document.querySelectorAll('textarea,input')].map(n=>({tag:n.tagName,placeholder:n.placeholder,value:n.value,disabled:n.disabled}))})");
    else if (command.op === 'click') result = await click(command.selector);
    else if (command.op === 'clickText') {
      const selector = await browser.evaluate(`(()=>{const n=[...document.querySelectorAll(${JSON.stringify(command.tag || 'button')})].find(n=>n.textContent.trim().includes(${JSON.stringify(command.text)}));if(!n)return null;n.dataset.realTrialTarget='1';return '[data-real-trial-target]';})()`);
      assert.ok(selector, 'Visible text control not found');
      result = await click(selector);
      await browser.evaluate("document.querySelector('[data-real-trial-target]')?.removeAttribute('data-real-trial-target')");
    } else if (command.op === 'type') { requireUnlocked(); await browser.type(command.selector, command.value); result = { typed: true }; }
    else if (command.op === 'key') {
      requireUnlocked();
      const codes={Home:36,End:35,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Enter:13,Tab:9,Escape:27,' ':32};
      assert.ok(Object.hasOwn(codes,command.key),'Only normal navigation/selection keys are permitted');
      await browser.send('Input.dispatchKeyEvent',{type:'keyDown',key:command.key,windowsVirtualKeyCode:codes[command.key],nativeVirtualKeyCode:codes[command.key]});
      await browser.send('Input.dispatchKeyEvent',{type:'keyUp',key:command.key,windowsVirtualKeyCode:codes[command.key],nativeVirtualKeyCode:codes[command.key]});
      result={key:command.key};
    }
    else if (command.op === 'dialog') { requireUnlocked(); assert.equal(typeof command.accept, 'boolean'); await browser.send('Page.handleJavaScriptDialog', { accept: command.accept }); result = { accepted: command.accept }; }
    else if (command.op === 'capture') { assert.match(command.name, /^[A-Za-z0-9_-]+\.png$/); result = { file: await browser.capture(command.name) }; }
    else if (command.op === 'navigate') { assert.equal(new URL(command.url).origin, 'http://127.0.0.1:9109'); await browser.load(command.url); result = { navigated: true }; }
    else if (command.op === 'close') result = await closeControlledBrowserSession({ input, browser });
    else throw new Error('Unknown controlled browser command');
    actions.push({ at: new Date().toISOString(), command, result });
    await save();
    process.stdout.write(JSON.stringify({ ok: true, op: command.op, result }) + '\n');
    if (command.op === 'close') break;
  } catch (error) {
    actions.push({ at: new Date().toISOString(), command, error: error.message });
    await save();
    process.stdout.write(JSON.stringify({ ok: false, op: command?.op, error: error.message }) + '\n');
  }
}
await browser.close().catch(() => {});
await save();
