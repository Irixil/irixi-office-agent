import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { animationCycleDuration, canStepWithoutCornerCutting, coworkerRuntimeState, crispZoom, feetOverlap, footToCell, isMovementKey, isSafeSwitchFrame, isWalkInProgress, pointToSegmentDistance, worldToCell } from '../public/office-geometry.js';

test('空地点击按世界坐标落到网格，相机缩放只用清晰倍率', () => {
  assert.deepEqual(worldToCell(511.9, 447.9, 32), { x: 15, y: 13 });
  assert.equal(crispZoom(1440, 810, 960, 540), 1);
  assert.equal(crispZoom(1920, 1080, 960, 540), 2);
  assert.equal(crispZoom(959, 540, 960, 540), 959 / 960);
  assert.deepEqual(footToCell(335, 337, 32), { x: 10, y: 9 });
});

test('对角移动要求两个正交邻格都可走', () => {
  const blocked = new Set(['2,1']);
  const walkable = (x, y) => !blocked.has(`${x},${y}`);
  assert.equal(canStepWithoutCornerCutting(walkable, 1, 1, 1, 1), false);
  assert.equal(canStepWithoutCornerCutting(walkable, 1, 1, 0, 1), true);
});

test('自动寻路只被真正的移动键中断', () => {
  assert.equal(isMovementKey('ArrowLeft'), true);
  assert.equal(isMovementKey('d'), true);
  assert.equal(isMovementKey('Enter'), false);
});

test('最后一步 tween 尚未到位时仍报告 walking，完成后才报告停步', () => {
  assert.equal(isWalkInProgress({ pathLength: 0, stepInProgress: true }), true);
  assert.equal(isWalkInProgress({ pathLength: 0, stepInProgress: false }), false);
  assert.equal(isWalkInProgress({ pathLength: 0, stepInProgress: false, manualMoving: true }), true);
});

test('v6 变帧时长和安全切换帧不会被平均 fps 取代', () => {
  const durations = [420, 160, 180, 150, 170, 240, 150, 170, 320, 170, 160, 260, 180, 420];
  assert.equal(animationCycleDuration(durations), 3150);
  assert.equal(isSafeSwitchFrame(0, [0, 1, 12, 13]), true);
  assert.equal(isSafeSwitchFrame(8, [0, 1, 12, 13]), false);
  assert.equal(isSafeSwitchFrame(7), true);
});

test('脚底避让只阻止真正近距离重叠，不把角色视觉宽度扩成墙', () => {
  assert.equal(feetOverlap(1008, 320, 960, 310), false);
  assert.equal(feetOverlap(970, 316, 960, 310), true);
  assert.equal(pointToSegmentDistance(760, 410, 548, 400, 960, 400), 10);
  assert.equal(pointToSegmentDistance(760, 470, 548, 400, 960, 400), 70);
});

test('只有实际工作角色显示正在工作，失败与待确认不会被当成忙碌', () => {
  const task = { status: 'running', activeRole: 'writer', workItems: [{ role: 'writer', status: 'running' }, { role: 'reviewer', status: 'blocked' }, { role: 'steward', status: 'waiting_user' }] };
  assert.deepEqual(coworkerRuntimeState(task, 'writer'), { active: true, status: 'active', localEligible: false, activitySource: 'task' });
  assert.deepEqual(coworkerRuntimeState(task, 'reviewer'), { active: false, status: 'failed', localEligible: false, activitySource: 'status' });
  assert.deepEqual(coworkerRuntimeState(task, 'steward'), { active: false, status: 'waiting_user', localEligible: false, activitySource: 'status' });
  assert.deepEqual(coworkerRuntimeState(task, 'researcher'), { active: false, status: 'idle', localEligible: true, activitySource: 'local' });
  assert.deepEqual(coworkerRuntimeState(task, 'researcher', { activeConversationRole: 'researcher' }), { active: true, status: 'replying', localEligible: false, activitySource: 'conversation' });
  assert.deepEqual(coworkerRuntimeState(task, 'researcher', { engagedRole: 'researcher' }), { active: false, status: 'idle', localEligible: false, activitySource: 'status' });
  assert.deepEqual(coworkerRuntimeState(task, 'writer', { activeConversationRole: 'researcher' }), { active: true, status: 'active', localEligible: false, activitySource: 'task' });
  const waiting = { status: 'waiting_user', activeRole: 'reviewer', workItems: [{ role: 'researcher', status: 'completed' }, { role: 'writer', status: 'completed' }] };
  assert.deepEqual(coworkerRuntimeState(waiting, 'researcher', { activeConversationRole: 'researcher' }), { active: true, status: 'replying', localEligible: false, activitySource: 'conversation' });
  assert.deepEqual(coworkerRuntimeState(waiting, 'writer', { activeConversationRole: 'researcher' }), { active: false, status: 'done', localEligible: true, activitySource: 'local' });
});

test('同一动态角色优先运行中的手动复核，完成后取最新复核而不是旧待排项', () => {
  const agent = { id: 'agent-auditor', roleKey: 'auditor', stationRole: 'reviewer' };
  const task = {
    status: 'running', activeRole: 'auditor', activeAgentId: agent.id, team: { agents: [agent] },
    workItems: [
      { id: 'old-review', agentId: agent.id, role: 'auditor', kind: 'review', status: 'pending' },
      { id: 'manual-review', agentId: agent.id, role: 'auditor', kind: 'review', status: 'running', manualReviewOfArtifactId: 'artifact-1' },
    ],
  };
  assert.deepEqual(coworkerRuntimeState(task, 'reviewer'), { active: true, status: 'active', localEligible: false, activitySource: 'task' });
  task.status = 'waiting_user';
  task.workItems[1].status = 'completed';
  assert.deepEqual(coworkerRuntimeState(task, 'reviewer'), { active: false, status: 'done', localEligible: true, activitySource: 'local' });
});

test('运行时美术清单保持五个角色、四种动作和统一帧尺寸', () => {
  const packRoot = new URL('../../art/office-playable-v1/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', packRoot), 'utf8'));
  const contract = manifest.coworkerAnimationContract;
  assert.equal(contract.status, 'integration-ready');
  assert.deepEqual(contract.rowOrder, ['idle', 'working', 'sleeping', 'slack']);
  assert.deepEqual(contract.roleBindings, {
    researcher: 'agent-hamster',
    writer: 'agent-mouse',
    reviewer: 'agent-chinchilla',
    steward: 'agent-mole',
    archivist: 'agent-fancy-rat',
  });
  for (const sheet of Object.values(contract.sheets)) {
    const png = readFileSync(new URL(sheet, packRoot));
    assert.equal(png.readUInt32BE(16), 256);
    assert.equal(png.readUInt32BE(20), 288);
  }
  const irixi = manifest.characters.irixi;
  const owl = readFileSync(new URL(irixi.sheet, packRoot));
  assert.equal(owl.readUInt32BE(16), irixi.frameSize[0] * irixi.sheetGrid[0]);
  assert.equal(owl.readUInt32BE(20), irixi.frameSize[1] * irixi.sheetGrid[1]);
  assert.ok(irixi.anchor[0] <= irixi.frameSize[0] && irixi.anchor[1] <= irixi.frameSize[1]);
});

test('任务刷新的生产入口会重绘已打开的同事对话', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderAll = source.match(/function renderAll\(\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.match(renderAll, /renderOffice\(\)/);
  assert.match(renderAll, /if \(\$\('#coworker-dialog'\)\.open\) renderCoworkerConversation\(\)/);
  assert.doesNotMatch(renderAll, /coworker-message[^\n]*(?:value|reset)/);
});

test('办公室主视图以场景为主，任务与目标使用默认收起的原生边栏', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const office = html.match(/<div class="office-shell">([\s\S]*?)<\/section>\s*<section id="view-desk"/)?.[1] || '';
  assert.match(office, /<details class="office-float office-float-left office-drawer">/);
  assert.match(office, /<details class="office-float office-float-right office-drawer">/);
  assert.doesNotMatch(office, /<details[^>]+open/);
  assert.match(office, /id="office-game"/);
  assert.match(office, /id="role-strip"/);
  assert.match(office, /id="active-goal"/);
});
