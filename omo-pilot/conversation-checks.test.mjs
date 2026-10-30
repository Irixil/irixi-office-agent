import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkBehavior as runBehaviorCheck, validateBehaviorCase } from './conversation-checks.mjs';
async function checkBehavior(value, options) { return runBehaviorCheck(validateBehaviorCase(value), options); }
import { needsWriteReview, confusesDecisionHostWithTools } from './conversation-store.mjs';
const final = { content: [{ type: 'text', text: '完成' }] };
test('不能把内部决策环境误报为产品工具拒绝，但允许解释两者区别', () => {
  const answer = (text) => ({ content: [{ type: 'text', text }] });
  assert.equal(confusesDecisionHostWithTools(answer('code-mode host is disabled，写入 main.py 被阻止，未能验证。')), true);
  assert.equal(confusesDecisionHostWithTools(answer('CLI 只读不能写入，所以请你保存代码。')), true);
  assert.equal(confusesDecisionHostWithTools(answer('内部 code-mode host is disabled 不代表 OmO 不可用。')), false);
  assert.equal(confusesDecisionHostWithTools({ content: [{ type: 'toolCall', name: 'write', arguments: { path: 'main.py', content: 'print(1)' } }] }), false);
});
test('读回、无关命令、失败后无关成功和 bash 写入都不能冒充功能通过', () => {
  const write = { toolName: 'write', eventType: 'end', isError: false };
  for (const receipts of [[write, { toolName: 'read', eventType: 'end', isError: false }], [write, { toolName: 'bash', eventType: 'end', isError: false }], [write, { toolName: 'bash', eventType: 'end', isError: true }, { toolName: 'bash', eventType: 'end', isError: false }], [{ toolName: 'bash', eventType: 'end', isError: false }]]) assert.equal(needsWriteReview(final, receipts), true);
  assert.equal(needsWriteReview(final, [], { changed: true, version: 'v2', checks: [{ caseId: 'a', status: 'passed', version: 'v1' }] }), true);
  assert.equal(needsWriteReview(final, [], { changed: true, version: 'v2', checks: [{ caseId: 'a', status: 'failed', version: 'v2' }, { caseId: 'b', status: 'passed', version: 'v2' }] }), true);
  assert.equal(needsWriteReview(final, [], { changed: true, version: 'v2', checks: [{ caseId: 'a', status: 'failed', version: 'v1' }, { caseId: 'a', status: 'passed', version: 'v2' }] }), false);
});
test('真实 CLI 入口按输入计算，宿主比较输出；错误预期不能通过', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-check-cli-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'main.py'), 'import sys\nprint(sum(int(x) for x in sys.argv[1:]))\n');
  const value = { caseId: 'sum', requirement: '求和', kind: 'cli', target: 'main.py', runner: 'python3', arguments: ['2', '4'], expected: { stdoutEquals: '6\n' } };
  const result = await checkBehavior(value, { root }); assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.equal((await checkBehavior({ ...value, expected: { stdoutEquals: '9\n' } }, { root })).status, 'failed');
  await assert.rejects(checkBehavior({ ...value, target: '../outside.py' }, { root }), /入口/);
});
test('嵌套 Python 入口可导入同级模块，覆盖记录只包含实际文件', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-check-python-import-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'main.py'), 'from helper import total\nprint(total(3, 8))\n');
  await fs.writeFile(path.join(root, 'src', 'helper.py'), 'def total(a,b): return a+b\n');
  await fs.writeFile(path.join(root, 'unrelated.py'), 'raise Exception("must not run")\n');
  const result = await checkBehavior({ caseId: 'nested', requirement: '导入同级模块并求和', kind: 'cli', target: 'src/main.py', runner: 'python3', expected: { stdoutEquals: '11\n' } }, { root });
  assert.equal(result.status, 'passed', JSON.stringify(result));
  assert.deepEqual(result.coveredFiles.sort(), ['src/helper.py', 'src/main.py']);
});
test('真实浏览器输入点击、断言及刷新恢复；错误断言明确失败', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-check-web-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'index.html'), `<form id="editor"><input id="name"><button id="add">记录</button></form><div id="list"></div><script>list.textContent=localStorage.getItem('value')||'';editor.onsubmit=(event)=>{event.preventDefault();list.textContent=document.querySelector('#name').value;localStorage.setItem('value',list.textContent)}</script>`);
  const actions = [{ action: 'fill', selector: '#name', value: '学习记录' }, { action: 'click', selector: '#add' }, { action: 'assert', selector: '#list', textEquals: '学习记录' }, { action: 'reload' }, { action: 'assert', selector: '#list', textEquals: '学习记录' }];
  const value = { caseId: 'record', requirement: '记录并保存', kind: 'web', target: 'index.html', actions };
  const result = await checkBehavior(value, { root }); assert.equal(result.status, 'passed', JSON.stringify(result));
  const wrong = await checkBehavior({ ...value, actions: [{ action: 'assert', selector: '#list', textIncludes: '不存在的内容' }, { action: 'click', selector: '#missing' }] }, { root }); assert.equal(wrong.status, 'failed');
  assert.equal(wrong.actual.length, 1); assert.match(wrong.error, /第 1 步/); assert.equal(wrong.actual[0].observed.text, '');
  const missing = await checkBehavior({ ...value, actions: [{ action: 'click', selector: '#missing' }, { action: 'assert', selector: '#list', textEquals: '' }] }, { root });
  assert.equal(missing.status, 'failed'); assert.match(missing.error, /第 1 步 click #missing/); assert.equal(missing.actual.length, 1);
  const controller = new AbortController(); controller.abort(); await assert.rejects(checkBehavior(value, { root, signal: controller.signal }), /停止/);
});
