import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('原生NPC事件先进入同职能项目对话，不打开旧模型讨论框', () => {
  const start = source.indexOf('function openCoworkerConversation(detail)');
  const end = source.indexOf("window.addEventListener('irixi:coworker'", start);
  const route = source.slice(start, end);
  assert.match(route, /if \(nativeMode\(\)\) \{ void openCoworkerProjectConversation\(detail\); return; \}/);
  assert.ok(route.indexOf('openCoworkerProjectConversation(detail)') < route.indexOf("dialog.showModal()"));
  assert.match(route, /nativeCoworkerTask\(state\.nativeTaskHistory\.tasks, functionId, state\.nativeTaskHistory\.activeTaskId\)/);
  assert.match(route, /if \(target\) \{ await openProjectChatTask\(target\.id\); return; \}/);
  assert.match(route, /project-dialogue-panel'\)\.hidden = false;[\s\S]*renderProjectChat\(\)/);
  assert.doesNotMatch(route, /postNativeAction\('chat'/);
});

test('旧补充要求表单按原任务绑定保存，使用稳定requestId提交且失败保留草稿', () => {
  const openDialog = source.slice(source.indexOf('function openDialog('), source.indexOf('function closeDialog('));
  const form = source.slice(source.indexOf("$('#suggestion-form').addEventListener('input'"), source.indexOf("$('#coworker-form').addEventListener('submit'"));
  assert.match(openDialog, /form\.dataset\.nativeInstructionBinding = binding/);
  assert.match(form, /nativeInstructionDraftKeyForBinding\(binding\)/);
  assert.match(form, /draft\?\.text === text && typeof draft\.requestId === 'string'/);
  assert.match(form, /postNativeAction\('instructions', \{ text, requestId \}\)/);
  assert.match(form, /失败|未确认保存/);
  assert.match(form, /draft\?\.text === text && draft\?\.requestId === requestId/);
  assert.match(form, /formBinding !== binding/);
});

test('切换任务时锁住提交，并按新任务绑定强制恢复草稿；同绑定聚焦时保留输入', () => {
  const render = source.slice(source.indexOf('function renderProjectChat()'), source.indexOf('async function saveProjectInstruction('));
  const open = source.slice(source.indexOf('async function openProjectChatTask('), source.indexOf('async function selectNativeTask('));
  assert.match(open, /projectChatSelectionPending = true/);
  assert.match(open, /project-instructions-text'\)\.disabled = true/);
  assert.match(open, /projectChatSelectionPending = false;[\s\S]*renderProjectChat\(\)/);
  assert.match(render, /bindingChanged \|\| document\.activeElement !== text/);
  assert.match(render, /projectInstructionDraftKey\(product\)/);
});
