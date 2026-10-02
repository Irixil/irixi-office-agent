import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { footToCell, pointToSegmentDistance, worldToCell } from '../public/office-geometry.js';

globalThis.Phaser = {
  Scene: class {},
  Game: class {},
  AUTO: 'AUTO',
  Scale: { RESIZE: 'RESIZE', CENTER_BOTH: 'CENTER_BOTH' },
  Input: { Keyboard: { KeyCodes: { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39 } } },
  Geom: { Rectangle: class { constructor(...args) { this.args = args; } } },
};

const dispatched = [];
const windowListeners = [];
const host = { dataset: {} };
globalThis.document = {
  hidden: false,
  activeElement: null,
  addEventListener() {},
  querySelector() { return null; },
  getElementById() { return host; },
};
globalThis.window = {
  addEventListener(type, callback) { windowListeners.push({ type, callback }); },
  dispatchEvent(event) { dispatched.push(event); },
};
globalThis.CustomEvent = class {
  constructor(type, options = {}) { this.type = type; this.detail = options.detail; }
};

const { alignedLocalActionEnd, coworkerAnimationSpec, coworkerHitArea, coworkerLocalActions, coworkerTransitionSafeFrames, createOfficeBridge, isEditableTarget, normalizeRoomContract, OfficeScene, PEOPLE, phaserAnimationFrames, seatedV6Contract, stewardBookOwner, stewardRouteLegs, stewardV6Contract, TILE } = await import(new URL('../public/office-game.js?movement-regression', import.meta.url));
const ROOM = normalizeRoomContract(JSON.parse(readFileSync(new URL('../../art/office-playable-v1/concept-runtime-v4/manifest.json', import.meta.url), 'utf8')));
const COWORKERS = JSON.parse(readFileSync(new URL('../../art/office-playable-v1/concept-runtime-v4/characters/coworkers/manifest.json', import.meta.url), 'utf8'));
const V6_ROOT = new URL('../../art/office-playable-v1/motion-repair-v6/', import.meta.url);
const V6_INTEGRATION = JSON.parse(readFileSync(new URL('integration-manifest.json', V6_ROOT), 'utf8'));
const V6_SEATED = Object.fromEntries(Object.entries(V6_INTEGRATION.seatedRoles).map(([role, binding]) => [role, JSON.parse(readFileSync(new URL(binding.manifest, V6_ROOT), 'utf8'))]));
const REST_ROOT = new URL('../../art/office-playable-v1/rest-states-v6/', import.meta.url);
const REST_INTEGRATION = JSON.parse(readFileSync(new URL('integration-manifest.json', REST_ROOT), 'utf8'));
const REST_SEATED = Object.fromEntries(Object.entries(REST_INTEGRATION.roles).map(([role, binding]) => [role, JSON.parse(readFileSync(new URL(binding.manifest, REST_ROOT), 'utf8'))]));
const CONTINUITY_ROOT = new URL('continuity-repair-v3/', REST_ROOT);
const CONTINUITY_INTEGRATION = JSON.parse(readFileSync(new URL('integration-manifest.json', CONTINUITY_ROOT), 'utf8'));
const CONTINUITY_TRANSITIONS = Object.fromEntries(Object.entries(CONTINUITY_INTEGRATION.transitions).map(([role, binding]) => [role, JSON.parse(readFileSync(new URL(binding.manifest, CONTINUITY_ROOT), 'utf8'))]));
const ARCHIVIST_REST_OVERRIDE = JSON.parse(readFileSync(new URL(CONTINUITY_INTEGRATION.archivistRestOverride.manifest, CONTINUITY_ROOT), 'utf8'));
const MOLE_MANIFEST = JSON.parse(readFileSync(new URL(V6_INTEGRATION.stewardMole.manifest, V6_ROOT), 'utf8'));
const MOLE_ROUTE = JSON.parse(readFileSync(new URL(V6_INTEGRATION.stewardMole.routeContract, V6_ROOT), 'utf8'));
const MOLE_ACTIONS = Object.fromEntries(MOLE_MANIFEST.actions.map(({ action, manifest }) => [action, JSON.parse(readFileSync(new URL(`steward-mole/${manifest}`, V6_ROOT), 'utf8'))]));
const OFFICE_SOURCE = readFileSync(new URL('../public/office-game.js', import.meta.url), 'utf8');

test('下载触发 beforeunload 时不会销毁仍在显示的办公室场景', () => {
  assert.equal(windowListeners.some(({ type }) => type === 'beforeunload'), false);
});

function movementScene() {
  const scene = new OfficeScene();
  scene.room = ROOM;
  const body = {
    anims: { currentAnim: { key: 'irixi-down-idle' } },
    play(key) { this.anims.currentAnim = { key }; return this; },
  };
  const player = {
    x: 496,
    y: 448,
    getByName() { return body; },
    setDepth(depth) { this.depth = depth; return this; },
    setPosition(x, y) { this.x = x; this.y = y; return this; },
  };
  let tween = null;
  let killed = 0;
  scene.updateLocalCoworkers = () => {};
  scene.inputLocked = () => false;
  scene.cursors = { left: { isDown: false }, right: { isDown: false }, up: { isDown: false }, down: { isDown: false } };
  scene.keys = { A: { isDown: false }, D: { isDown: false }, W: { isDown: false }, S: { isDown: false } };
  scene.grid = { isWalkable: () => true };
  scene.player = player;
  scene.cameras = { main: { zoom: 1 } };
  scene.destinationMarker = { visible: false, setVisible(value) { this.visible = value; return this; } };
  scene.tweens = {
    add(config) { tween = config; return config; },
    killTweensOf() { killed += 1; },
  };
  host.dataset = {};
  dispatched.length = 0;
  return {
    scene,
    body,
    player,
    get tween() { return tween; },
    get killed() { return killed; },
  };
}

test('持续按住 W 不会取消自己的手动 tween', () => {
  const runtime = movementScene();
  runtime.scene.cursors.up.isDown = true;
  runtime.scene.update(200);
  assert.equal(runtime.killed, 0);
  assert.equal(runtime.scene.manualMoving, true);
  assert.equal(runtime.scene.stepInProgress, true);
  assert.equal(runtime.body.anims.currentAnim.key, 'irixi-up-walk');

  runtime.scene.update(216);
  assert.equal(runtime.killed, 0);
  assert.equal(runtime.scene.manualMoving, true);
  assert.equal(runtime.scene.stepInProgress, true);
  assert.equal(runtime.body.anims.currentAnim.key, 'irixi-up-walk');
});

test('移动键会取消自动路径最后一步并接管为手动移动', () => {
  const runtime = movementScene();
  runtime.scene.playerCell = { x: 15, y: 12 };
  runtime.scene.walkTarget = { kind: 'floor', destination: { x: 15, y: 12 } };
  runtime.scene.stepInProgress = true;
  runtime.scene.manualMoving = false;
  runtime.body.play('irixi-up-walk');
  runtime.scene.cursors.up.isDown = true;

  runtime.scene.update(216);
  assert.equal(runtime.killed, 1);
  assert.equal(runtime.scene.walkTarget, null);
  assert.equal(runtime.scene.manualMoving, true);
  assert.equal(runtime.scene.stepInProgress, true);
  assert.equal(runtime.body.anims.currentAnim.key, 'irixi-up-walk');
});

test('最后一步真实完成后才同步最终像素、idle 和 arrival', () => {
  const runtime = movementScene();
  runtime.scene.playerCell = { x: 19, y: 10 };
  runtime.scene.walkTarget = { kind: 'coworker', destination: { x: 18, y: 9 } };
  runtime.player.setPosition(624, 352);

  runtime.scene.moveToCell(18, 9);
  assert.equal(host.dataset.walking, 'true');
  assert.equal(host.dataset.playerAnimation, 'irixi-up-walk');
  assert.equal(dispatched.length, 0);

  runtime.player.setPosition(runtime.tween.x, runtime.tween.y);
  runtime.tween.onComplete();
  assert.equal(host.dataset.walking, 'false');
  assert.equal(host.dataset.playerCell, '18,9');
  assert.equal(host.dataset.playerPixel, '592,320');
  assert.equal(host.dataset.playerAnimation, 'irixi-up-idle');
  assert.equal(host.dataset.walkTarget, '');
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].type, 'irixi:arrival');
});

test('到达同事后重复点击会再次确认已到身边，不会误报不可达', async () => {
  const runtime = movementScene();
  runtime.scene.playerCell = { x: 14, y: 12 };
  const writer = { role: 'writer', name: '小鼠写作员', interactionPoint: ROOM.workstations.writer.interactionPoint, statusText: { text: '待命' } };

  await runtime.scene.talkTo(writer);
  await runtime.scene.talkTo(writer);

  assert.deepEqual(dispatched.map(({ type }) => type), ['irixi:coworker', 'irixi:arrival', 'irixi:coworker', 'irixi:arrival']);
  assert.equal(dispatched.some(({ type }) => type === 'irixi:unreachable'), false);
});

test('移动中鼹鼠被点击会先暂停，猫头鹰目标改为其实时脚点邻格', async () => {
  const runtime = movementScene();
  runtime.scene.playerCell = { x: 15, y: 13 };
  runtime.scene.stewardRoutine = { phase: 'outbound', legIndex: 0, legs: [{ from: [960, 400], to: [548, 400] }] };
  const steward = {
    role: 'steward', name: '鼹鼠事务员', interactionPoint: ROOM.workstations.steward.interactionPoint, statusText: { text: '待命' },
    sprite: { x: 752, y: 400 },
  };
  let pauseReason = null;
  let target = null;
  runtime.scene.pauseStewardMotion = (reason) => { pauseReason = reason; };
  runtime.scene.startPath = async (destination, walkTarget) => { target = { destination, walkTarget }; return true; };

  await runtime.scene.talkTo(steward);

  assert.equal(pauseReason, 'conversation');
  assert.notDeepEqual(target.destination, worldToCell(...ROOM.workstations.steward.interactionPoint, TILE));
  const targetFoot = [target.destination.x * TILE + TILE / 2, (target.destination.y + 1) * TILE];
  assert.ok(Math.hypot(targetFoot[0] - steward.sprite.x, targetFoot[1] - steward.sprite.y) <= 64);
  assert.ok(pointToSegmentDistance(...targetFoot, 960, 400, 548, 400) >= 40);
  assert.equal(dispatched[0].type, 'irixi:coworker');
});

test('不同位置确实找不到路径时仍提示不可达', async () => {
  const runtime = movementScene();
  runtime.scene.playerCell = { x: 22, y: 17 };
  runtime.scene.grid.findPath = async () => null;
  const writer = { role: 'writer', name: '小鼠写作员', interactionPoint: ROOM.workstations.writer.interactionPoint, statusText: { text: '待命' } };

  await runtime.scene.talkTo(writer);

  assert.deepEqual(dispatched.map(({ type }) => type), ['irixi:coworker', 'irixi:unreachable']);
});

test('手动松键后点地板会把移动所有权交给自动路径并正常收尾', async () => {
  const runtime = movementScene();
  runtime.scene.playerCell = { x: 15, y: 12 };
  runtime.scene.manualMoving = true;
  runtime.scene.grid.findPath = async () => [{ x: 15, y: 12 }, { x: 14, y: 12 }];
  runtime.scene.destinationMarker = {
    visible: false,
    setPosition() { return this; },
    setDepth() { return this; },
    setVisible(value) { this.visible = value; return this; },
  };

  const accepted = await runtime.scene.startPath({ x: 14, y: 12 }, { kind: 'floor', destination: { x: 14, y: 12 } });
  assert.equal(accepted, true);
  assert.equal(runtime.scene.manualMoving, false);
  assert.equal(runtime.scene.destinationMarker.visible, true);

  runtime.scene.update(200);
  runtime.player.setPosition(runtime.tween.x, runtime.tween.y);
  runtime.tween.onComplete();
  assert.equal(host.dataset.walking, 'false');
  assert.equal(host.dataset.walkTarget, '');
  assert.equal(runtime.scene.destinationMarker.visible, false);
  assert.equal(runtime.body.anims.currentAnim.key, 'irixi-left-idle');
});

test('实际注册的 keydown 回调忽略手动 tween 的系统 repeat', () => {
  const runtime = movementScene();
  let keydown = null;
  runtime.scene.input = { keyboard: { on(name, callback) { if (name === 'keydown') keydown = callback; } } };
  runtime.scene.stepInProgress = true;
  runtime.scene.manualMoving = true;
  runtime.scene.registerMovementCancellation();

  keydown({ key: 'w', repeat: true, preventDefault() {} });
  assert.equal(runtime.killed, 0);
  assert.equal(runtime.scene.stepInProgress, true);
  assert.equal(runtime.scene.manualMoving, true);
});

test('实际注册的 keydown 回调仍会取消 pending 自动寻路', () => {
  const runtime = movementScene();
  let keydown = null;
  runtime.scene.input = { keyboard: { on(name, callback) { if (name === 'keydown') keydown = callback; } } };
  runtime.scene.pathPending = true;
  runtime.scene.registerMovementCancellation();

  keydown({ key: 'a', repeat: true, preventDefault() {} });
  assert.equal(runtime.killed, 1);
  assert.equal(runtime.scene.pathPending, false);
  assert.equal(runtime.scene.walkTarget, null);
});

test('实际键盘注册不全局 capture，游戏场景仅拦截移动键滚屏', () => {
  const runtime = movementScene();
  const registrations = [];
  const callbacks = {};
  runtime.scene.input = { keyboard: {
    addKeys(keys, capture) {
      registrations.push({ keys, capture });
      if (typeof keys === 'string') return Object.fromEntries(keys.split(',').map((key) => [key, { isDown: false }]));
      return Object.fromEntries(Object.keys(keys).map((key) => [key, { isDown: false }]));
    },
    on(name, callback) { callbacks[name] = callback; },
  } };
  runtime.scene.registerKeyboardControls();

  assert.deepEqual(registrations.map(({ capture }) => capture), [false, false]);
  const event = { key: 'ArrowLeft', target: null, prevented: false, preventDefault() { this.prevented = true; } };
  callbacks.keydown(event);
  assert.equal(event.prevented, true);
  runtime.scene.pathPending = true;
  callbacks['keydown-ESC']();
  assert.equal(runtime.scene.pathPending, false);
  assert.equal(dispatched.at(-1).type, 'irixi:walk-cancelled');
});

test('文本框、选择框与 contenteditable 的逐键录入、空格、方向编辑和 IME 不被游戏阻止', () => {
  const runtime = movementScene();
  let keydown = null;
  runtime.scene.input = { keyboard: { on(name, callback) { if (name === 'keydown') keydown = callback; } } };
  runtime.scene.pathPending = true;
  runtime.scene.inputLocked = () => true;
  runtime.scene.registerMovementCancellation();
  const editable = { matches(selector) { return selector.includes('textarea'); }, closest() { return null; } };

  for (const key of ['w', 'a', 's', 'd', ' ', 'ArrowLeft', 'ArrowRight', 'Process']) {
    const event = { key, target: editable, isComposing: key === 'Process', prevented: false, preventDefault() { this.prevented = true; } };
    keydown(event);
    assert.equal(event.prevented, false, `${key} 不应被 preventDefault`);
  }
  assert.equal(runtime.killed, 0);
  assert.equal(runtime.scene.pathPending, true);
  assert.equal(isEditableTarget(editable), true);
  assert.equal(isEditableTarget({ matches() { return false; }, closest(selector) { return selector.includes('contenteditable') ? {} : null; } }), true);
});

test('输入锁期间清除 Phaser 按键状态但继续自动走近', () => {
  const runtime = movementScene();
  let resets = 0;
  runtime.scene.inputLocked = () => true;
  runtime.scene.input = { keyboard: { resetKeys() { resets += 1; } } };
  runtime.scene.path = [{ x: 14, y: 13 }];

  runtime.scene.update(200);
  assert.equal(resets, 1);
  assert.deepEqual(runtime.scene.playerCell, { x: 14, y: 13 });
  assert.equal(runtime.scene.stepInProgress, true);
  assert.equal(runtime.scene.manualMoving, false);
});

test('真实对话请求只让对应同事工作，只打开对话则从休息回到待命', () => {
  const scene = new OfficeScene();
  const person = (role) => ({
    role,
    home: [...ROOM.workstations[role].home],
    active: false,
    localEligible: true,
    localAction: 'sleeping', activitySource: 'local', actionSource: 'rest',
    sprite: { setAlpha() { return this; } },
    statusText: { text: '', setText(value) { this.text = value; } },
  });
  const researcher = person('researcher');
  const writer = person('writer');
  scene.people = new Map([['researcher', researcher], ['writer', writer]]);
  scene.room = ROOM;
  scene.moveCoworker = () => {};
  scene.setPersonAction = (officePerson, action, source) => { officePerson.localAction = action; officePerson.actionSource = source; };
  const task = { status: 'waiting_user', activeRole: 'reviewer', workItems: [{ role: 'researcher', status: 'completed' }, { role: 'writer', status: 'completed' }] };

  scene.setTask(task, { activeConversationRole: 'researcher', engagedRole: 'researcher' });
  assert.deepEqual({ active: researcher.active, eligible: researcher.localEligible, activity: researcher.activitySource, source: researcher.actionSource, action: researcher.localAction, text: researcher.statusText.text }, { active: true, eligible: false, activity: 'conversation', source: 'conversation', action: 'working', text: '正在回复' });
  assert.deepEqual({ active: writer.active, activity: writer.activitySource, source: writer.actionSource, action: writer.localAction, text: writer.statusText.text }, { active: false, activity: 'local', source: 'rest', action: 'sleeping', text: '已完成' });

  researcher.localAction = 'sleeping';
  scene.setTask(task, { engagedRole: 'researcher' });
  assert.deepEqual({ active: researcher.active, eligible: researcher.localEligible, activity: researcher.activitySource, source: researcher.actionSource, action: researcher.localAction, text: researcher.statusText.text }, { active: false, eligible: false, activity: 'status', source: 'status', action: 'idle', text: '已完成' });
});

test('同事动作契约允许每个动作独立帧序、时长、画布和锚点，同时兼容旧共享表', () => {
  const legacy = JSON.parse(readFileSync(new URL('../../art/office-playable-v1/concept-runtime-v4/characters/coworkers/writer-mouse/manifest.json', import.meta.url), 'utf8'));
  const idle = coworkerAnimationSpec(legacy, 'writer', 'idle');
  assert.equal(idle.textureKey, 'coworker-writer');
  assert.deepEqual(idle.frames, [0, 1]);
  assert.deepEqual(idle.frameSize, [176, 208]);
  assert.deepEqual(idle.anchor, [88, 194]);

  const seated = structuredClone(legacy);
  seated.animations.working = { sheet: 'runtime/seated-work.png', frameSize: [240, 220], anchor: [118, 204], frameIndices: [0, 1, 3, 2], frameDurationMs: 90, loop: true, hitArea: [-70, -188, 142, 154] };
  const working = coworkerAnimationSpec(seated, 'writer', 'working');
  assert.equal(working.textureKey, 'coworker-writer-working');
  assert.deepEqual(working.frames, [0, 1, 3, 2]);
  assert.deepEqual(working.frameSize, [240, 220]);
  assert.deepEqual(working.anchor, [118, 204]);
  assert.equal(working.frameRate, 1000 / 90);
  assert.deepEqual(coworkerHitArea(seated, 'working'), [-70, -188, 142, 154]);
});

test('本地生活动作必须由清单明确提供，不能拿真实 working 动画冒充', () => {
  const contract = { animations: { idle: {}, working: {}, reading: {}, organizing: {}, sleeping: {}, slack: {} }, localActions: ['reading', 'working', { action: 'organizing' }, 'missing', 'sleeping'] };
  assert.deepEqual(coworkerLocalActions(contract), ['reading', 'organizing', 'sleeping']);
});

test('无模型运行时只播放清单声明的本地生活动作，并保留 local 来源', () => {
  const scene = new OfficeScene();
  const body = { getData() { return true; } };
  const person = { role: 'writer', active: false, localEligible: true, localAction: 'idle', localActionIndex: 0, nextLocalActionAt: 0, sprite: { getByName() { return body; } } };
  scene.people = new Map([['writer', person]]);
  scene.reducedMotion = false;
  scene.coworkerContracts = { writer: { localActions: ['reading'], animations: { idle: {}, working: {}, reading: { displayDurationMs: 5100 } } } };
  scene.setPersonAction = (officePerson, action, source) => { officePerson.localAction = action; officePerson.actionSource = source; };

  scene.updateLocalCoworkers(100);
  assert.deepEqual({ action: person.localAction, source: person.actionSource, nextAt: person.nextLocalActionAt }, { action: 'reading', source: 'local', nextAt: 5200 });

  scene.updateLocalCoworkers(5200);
  assert.deepEqual({ action: person.localAction, source: person.actionSource, nextAt: person.nextLocalActionAt }, { action: 'idle', source: 'local', nextAt: 17000 });
});

test('循环生活动作只在完整帧循环边界结束', () => {
  const contract = { animations: { reading: { loop: true, frameIndices: Array.from({ length: 14 }, (_, index) => index), frameDurationMs: 120, displayDurationMs: 6000 } } };
  assert.equal(alignedLocalActionEnd(100, contract, 'writer', 'reading'), 6820);
});

test('v6 工作与休息入口把四个坐席角色的变帧时长、锚点和安全帧原样接入', () => {
  assert.equal(V6_INTEGRATION.id, 'office-playable-motion-v6-integration');
  assert.equal(REST_INTEGRATION.id, 'office-playable-rest-states-v6-integration');
  for (const [role, binding] of Object.entries(V6_INTEGRATION.seatedRoles)) {
    const restManifest = REST_SEATED[role];
    const contract = seatedV6Contract(V6_INTEGRATION, role, V6_SEATED[role], ROOM, REST_INTEGRATION, restManifest);
    const idle = coworkerAnimationSpec(contract, role, 'idle');
    const working = coworkerAnimationSpec(contract, role, 'working');
    assert.equal(idle.isStatic, false);
    assert.equal(idle.textureKey, `coworker-${role}-idle`);
    assert.equal(working.textureKey, `coworker-${role}-${binding.action}`);
    assert.deepEqual(working.frames, Array.from({ length: 14 }, (_, index) => index));
    assert.deepEqual(working.frameDurationsMs, binding.frameDurationsMs);
    assert.deepEqual(working.animation.safeSwitchFrameIndices, [0, 1, 12, 13]);
    assert.deepEqual(phaserAnimationFrames(working).map(({ duration }) => duration), binding.frameDurationsMs);
    assert.deepEqual(coworkerLocalActions(contract), ['sleeping', 'slack']);
    for (const restingAction of ['idle', 'sleeping', 'slack']) {
      const resting = coworkerAnimationSpec(contract, role, restingAction);
      const state = restManifest.states[restingAction];
      assert.equal(resting.isStatic, false);
      assert.equal(resting.textureKey, `coworker-${role}-${restingAction}`);
      assert.deepEqual(resting.anchor, working.anchor);
      assert.deepEqual(resting.frameSize, working.frameSize);
      assert.deepEqual(resting.frameDurationsMs, state.frameDurationsMs);
      assert.deepEqual(resting.animation.safeSwitchFrameIndices, state.safeExitFrameIndices);
      assert.equal(resting.animation.loop, state.loop);
      assert.equal(resting.animation.returnTo, state.returnTo);
    }
    assert.equal(contract.deskDock.characterDepthY < contract.deskDock.frontLayerDepthY, true);
    assert.deepEqual(contract.deskDock.stationPatch, V6_SEATED[role].stationPatch);
  }
  const reviewer = seatedV6Contract(V6_INTEGRATION, 'reviewer', V6_SEATED.reviewer, ROOM);
  assert.deepEqual(reviewer.deskDock.worldAnchor, [1200, 550]);
  assert.deepEqual(reviewer.deskDock.stationPatch.worldPosition, [1194, 443]);
  assert.equal(reviewer.deskDock.frontLayerDepthY, 592);
  assert.match(OFFICE_SOURCE, /MOTION_ROOT = `\$\{ASSET_ROOT\}motion-repair-v6\//);
  assert.match(OFFICE_SOURCE, /REST_ROOT = `\$\{ASSET_ROOT\}rest-states-v6\//);
  assert.match(OFFICE_SOURCE, /CONTINUITY_ROOT = `\$\{REST_ROOT\}continuity-repair-v3\//);
  assert.match(OFFICE_SOURCE, /`\$\{MOTION_ROOT\}integration-manifest\.json`/);
  assert.match(OFFICE_SOURCE, /`\$\{REST_ROOT\}integration-manifest\.json`/);
  assert.match(OFFICE_SOURCE, /`\$\{CONTINUITY_ROOT\}integration-manifest\.json`/);
  assert.doesNotMatch(OFFICE_SOURCE, /seated-work-v5\//);
  assert.doesNotMatch(OFFICE_SOURCE, /continuity-repair-v[12]\//);
});

test('continuity v3 只播放生成的中间帧，端点由 work13 与 idle0 提供且反向时序严格反转', () => {
  assert.equal(CONTINUITY_INTEGRATION.id, 'rest-states-v6-continuity-repair-v3-integration');
  for (const role of Object.keys(CONTINUITY_INTEGRATION.transitions)) {
    const contract = seatedV6Contract(V6_INTEGRATION, role, V6_SEATED[role], ROOM, REST_INTEGRATION, REST_SEATED[role], CONTINUITY_INTEGRATION, CONTINUITY_TRANSITIONS[role], role === 'archivist' ? ARCHIVIST_REST_OVERRIDE : null);
    const forward = coworkerAnimationSpec(contract, role, 'work-to-rest');
    const reverse = coworkerAnimationSpec(contract, role, 'rest-to-work');
    const working = coworkerAnimationSpec(contract, role, 'working');
    assert.deepEqual(forward.frames, [1, 2]);
    assert.deepEqual(forward.frameDurationsMs, [180, 200]);
    assert.deepEqual(reverse.frames, [2, 1]);
    assert.deepEqual(reverse.frameDurationsMs, [200, 180]);
    assert.equal(forward.textureKey, `coworker-${role}-work-rest-transition`);
    assert.equal(reverse.textureKey, forward.textureKey);
    assert.equal(forward.animation.returnTo, 'idle');
    assert.equal(reverse.animation.returnTo, 'working');
    assert.equal(working.animation.startFrameIndex, 13);
    assert.deepEqual(forward.anchor, working.anchor);
    assert.deepEqual(forward.frameSize, working.frameSize);
  }
  const archivist = seatedV6Contract(V6_INTEGRATION, 'archivist', V6_SEATED.archivist, ROOM, REST_INTEGRATION, REST_SEATED.archivist, CONTINUITY_INTEGRATION, CONTINUITY_TRANSITIONS.archivist, ARCHIVIST_REST_OVERRIDE);
  for (const state of ['idle', 'sleeping', 'slack']) {
    const spec = coworkerAnimationSpec(archivist, 'archivist', state);
    assert.equal(spec.textureKey, `coworker-archivist-${state}-continuity-v3`);
    assert.equal(spec.animation.sheet, ARCHIVIST_REST_OVERRIDE.states[state].spritesheet);
    assert.deepEqual(spec.frameDurationsMs, ARCHIVIST_REST_OVERRIDE.states[state].frameDurationsMs);
    assert.deepEqual(spec.anchor, ARCHIVIST_REST_OVERRIDE.anchor);
  }
});

test('重复状态刷新不重启工作循环，退出只在 v6 安全帧生效', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, ROOM);
  const body = {
    anims: { currentFrame: { textureFrame: 8 } }, frame: { name: 8 }, texture: { key: 'coworker-writer-noteTaking' }, plays: 0,
    getData() { return true; },
    setOrigin() { return this; },
    play() { this.plays += 1; return this; },
    stop() { return this; }, setTexture(key) { this.texture.key = key; return this; }, setFrame(frame) { this.frame.name = frame; return this; },
  };
  const person = {
    role: 'writer', active: true, activitySource: 'task', actionSource: 'task', localAction: 'working', pendingAction: null,
    sprite: { getByName() { return body; }, setInteractive() { return this; } }, hitArea: null,
  };
  const scene = new OfficeScene();
  scene.coworkerContracts = { writer: contract };
  scene.people = new Map([['writer', person]]);
  scene.syncRoleDebug = () => {};

  assert.equal(scene.setPersonAction(person, 'working', 'task'), true);
  assert.equal(body.plays, 0, '相同工作状态的 poll 不应重启动画');
  assert.equal(scene.setPersonAction(person, 'idle', 'local'), false);
  assert.equal(person.localAction, 'working');
  assert.equal(person.pendingAction.action, 'idle');
  body.anims.currentFrame.textureFrame = 12;
  scene.updateCoworkerTransitions();
  assert.equal(person.localAction, 'idle');
  assert.equal(person.pendingAction, null);
  assert.equal(body.frame.name, 0);
});

test('场景创建时会真正启动 idle 呼吸循环，后续同状态刷新不会重启', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, ROOM, REST_INTEGRATION, REST_SEATED.writer);
  const body = {
    anims: { currentFrame: { textureFrame: 0 } }, frame: { name: 0 }, texture: { key: 'coworker-writer-idle' }, plays: 0,
    getData() { return true; }, setOrigin() { return this; },
    play() { this.plays += 1; return this; }, stop() { return this; }, setTexture() { return this; }, setFrame() { return this; },
  };
  const person = { role: 'writer', activitySource: 'local', localAction: null, pendingAction: null, sprite: { getByName() { return body; }, setInteractive() { return this; } } };
  const scene = new OfficeScene();
  scene.coworkerContracts = { writer: contract };
  scene.syncRoleDebug = () => {};

  assert.equal(scene.setPersonAction(person, 'idle', 'local', true), true);
  assert.equal(body.plays, 1);
  assert.equal(scene.setPersonAction(person, 'idle', 'status'), true);
  assert.equal(body.plays, 1);
});

test('rest v6 只按定向安全帧切换，休息中收到真实工作会先回 idle 再进 work', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, ROOM, REST_INTEGRATION, REST_SEATED.writer);
  const body = {
    anims: { currentFrame: { textureFrame: 1 } }, frame: { name: 1 }, texture: { key: 'coworker-writer-sleeping' }, plays: [],
    getData() { return true; },
    setOrigin() { return this; },
    play(key) { this.plays.push(key); return this; },
    once() { return this; },
    stop() { return this; }, setTexture(key) { this.texture.key = key; return this; }, setFrame(frame) { this.frame.name = frame; return this; },
  };
  const person = {
    role: 'writer', active: true, activitySource: 'task', actionSource: 'local', localAction: 'sleeping', pendingAction: null,
    sprite: { getByName() { return body; }, setInteractive() { return this; } }, hitArea: null,
  };
  const scene = new OfficeScene();
  scene.coworkerContracts = { writer: contract };
  scene.people = new Map([['writer', person]]);
  scene.syncRoleDebug = () => {};

  assert.equal(scene.setPersonAction(person, 'working', 'task'), false);
  assert.deepEqual({ action: person.localAction, pending: person.pendingAction.action, then: person.pendingAction.then.action }, { action: 'sleeping', pending: 'idle', then: 'working' });
  body.anims.currentFrame.textureFrame = 3;
  scene.updateCoworkerTransitions();
  assert.deepEqual({ action: person.localAction, pending: person.pendingAction.action, plays: body.plays }, { action: 'idle', pending: 'working', plays: ['writer-idle'] });
  body.anims.currentFrame.textureFrame = 0;
  scene.updateCoworkerTransitions();
  assert.equal(person.localAction, 'idle', 'idle frame 0 不能直接跳回 working');
  body.anims.currentFrame.textureFrame = 3;
  scene.updateCoworkerTransitions();
  assert.equal(person.localAction, 'working');
  assert.deepEqual(body.plays, ['writer-idle', 'writer-working']);
});

test('continuity v3 在 work13 与 idle0 间可逆衔接，过渡中最新工作意图不会丢失', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, ROOM, REST_INTEGRATION, REST_SEATED.writer, CONTINUITY_INTEGRATION, CONTINUITY_TRANSITIONS.writer);
  const complete = new Map();
  const body = {
    anims: { currentFrame: { textureFrame: 12 } }, frame: { name: 12 }, texture: { key: 'coworker-writer-noteTaking' }, plays: [],
    getData() { return true; }, setOrigin() { return this; },
    play(config) { this.plays.push(config); return this; },
    once(event, callback) { complete.set(event, callback); return this; },
    stop() { return this; }, setTexture(key) { this.texture.key = key; return this; }, setFrame(frame) { this.frame.name = frame; return this; },
  };
  const person = { role: 'writer', active: false, activitySource: 'local', localAction: 'working', pendingAction: null, afterTransition: null, sprite: { getByName() { return body; }, setInteractive() { return this; } } };
  const scene = new OfficeScene();
  scene.coworkerContracts = { writer: contract };
  scene.people = new Map([['writer', person]]);
  scene.reducedMotion = false;
  scene.time = { now: 1000 };
  scene.syncRoleDebug = () => {};

  assert.equal(scene.setPersonAction(person, 'idle', 'local'), false);
  assert.deepEqual({ action: person.localAction, pending: person.pendingAction.action, then: person.pendingAction.then.action }, { action: 'working', pending: 'work-to-rest', then: 'idle' });
  body.anims.currentFrame.textureFrame = 13;
  scene.updateCoworkerTransitions();
  assert.equal(person.localAction, 'work-to-rest');
  assert.equal(person.afterTransition.action, 'idle');
  assert.deepEqual(body.plays.at(-1), 'writer-work-to-rest');

  scene.setPersonAction(person, 'working', 'task');
  assert.equal(person.afterTransition.action, 'working', '过渡中真实工作应覆盖旧 idle 目标');
  complete.get('animationcomplete-writer-work-to-rest')();
  assert.equal(person.localAction, 'idle');
  assert.deepEqual(person.pendingAction, { action: 'rest-to-work', source: 'task', then: { action: 'working', source: 'task' } });

  body.anims.currentFrame.textureFrame = 0;
  scene.updateCoworkerTransitions();
  assert.equal(person.localAction, 'rest-to-work');
  assert.deepEqual(body.plays.at(-1), 'writer-rest-to-work');
  complete.get('animationcomplete-writer-rest-to-work')();
  assert.equal(person.localAction, 'working');
  assert.deepEqual(body.plays.at(-1), { key: 'writer-working', startFrame: 13 });
  assert.equal(person.pendingAction, null);
});

test('rest-to-work 中途取消会在 work13 边界排队反向放下道具，不会停留在工作态', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, ROOM, REST_INTEGRATION, REST_SEATED.writer, CONTINUITY_INTEGRATION, CONTINUITY_TRANSITIONS.writer);
  const complete = new Map();
  const body = {
    anims: { currentFrame: { textureFrame: 0 } }, frame: { name: 0 }, texture: { key: 'coworker-writer-idle' },
    getData() { return true; }, setOrigin() { return this; }, play() { return this; },
    once(event, callback) { complete.set(event, callback); return this; },
    stop() { return this; }, setTexture() { return this; }, setFrame() { return this; },
  };
  const person = { role: 'writer', active: true, activitySource: 'task', localAction: 'idle', pendingAction: null, afterTransition: null, sprite: { getByName() { return body; }, setInteractive() { return this; } } };
  const scene = new OfficeScene();
  scene.coworkerContracts = { writer: contract };
  scene.people = new Map([['writer', person]]);
  scene.reducedMotion = false;
  scene.time = { now: 1000 };
  scene.syncRoleDebug = () => {};

  scene.setPersonAction(person, 'working', 'task');
  assert.equal(person.localAction, 'rest-to-work');
  person.active = false;
  scene.setPersonAction(person, 'idle', 'status');
  assert.equal(person.afterTransition.action, 'idle');
  complete.get('animationcomplete-writer-rest-to-work')();
  assert.equal(person.localAction, 'working');
  assert.deepEqual(person.pendingAction, { action: 'work-to-rest', source: 'status', then: { action: 'idle', source: 'status' } });
  body.anims.currentFrame.textureFrame = 13;
  scene.updateCoworkerTransitions();
  assert.equal(person.localAction, 'work-to-rest');
  complete.get('animationcomplete-writer-work-to-rest')();
  assert.equal(person.localAction, 'idle');
});

test('取消或失败会清掉尚未完成的 rest→idle→work 链，不会继续显示工作', () => {
  const spec = { animation: { safeSwitchFrameIndices: [0, 3] } };
  assert.deepEqual(coworkerTransitionSafeFrames('sleeping', 'idle', spec), [3]);
  assert.deepEqual(coworkerTransitionSafeFrames('idle', 'working', spec), [3]);
  assert.deepEqual(coworkerTransitionSafeFrames('idle', 'slack', spec), [0, 3]);
  assert.deepEqual(coworkerTransitionSafeFrames('working', 'idle', { animation: { safeSwitchFrameIndices: [0, 1, 12, 13] } }), [0, 1, 12, 13]);

  const contract = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, ROOM, REST_INTEGRATION, REST_SEATED.writer);
  const body = { anims: { currentFrame: { textureFrame: 1 } }, frame: { name: 1 }, getData() { return true; } };
  const person = { role: 'writer', localAction: 'sleeping', pendingAction: { action: 'idle', source: 'task', then: { action: 'working', source: 'task' } }, sprite: { getByName() { return body; } } };
  const scene = new OfficeScene();
  scene.coworkerContracts = { writer: contract };
  scene.syncRoleDebug = () => {};
  assert.equal(scene.setPersonAction(person, 'idle', 'status'), false);
  assert.deepEqual(person.pendingAction, { action: 'idle', source: 'status', then: null });
});

test('slack 是单次动作并在自身末帧自动回 idle', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, ROOM, REST_INTEGRATION, REST_SEATED.writer);
  let complete = null;
  const body = {
    anims: { currentFrame: { textureFrame: 0 } }, frame: { name: 0 }, texture: { key: 'coworker-writer-idle' },
    getData() { return true; }, setOrigin() { return this; }, play() { return this; },
    once(_event, callback) { complete = callback; return this; }, stop() { return this; }, setTexture() { return this; }, setFrame() { return this; },
  };
  const person = { role: 'writer', active: false, activitySource: 'local', localAction: 'idle', pendingAction: null, sprite: { getByName() { return body; }, setInteractive() { return this; } } };
  const scene = new OfficeScene();
  scene.coworkerContracts = { writer: contract };
  scene.reducedMotion = false;
  scene.time = { now: 1000 };
  scene.syncRoleDebug = () => {};

  assert.equal(scene.setPersonAction(person, 'slack', 'local'), true);
  assert.equal(person.localAction, 'slack');
  assert.equal(typeof complete, 'function');
  complete();
  assert.equal(person.localAction, 'idle');
  assert.equal(person.nextLocalActionAt > 1000, true);
});

test('鼹鼠 v6 使用 11 张独立动作表、一楼合同路线与完整书本所有权交接', () => {
  const contract = stewardV6Contract(V6_INTEGRATION, MOLE_MANIFEST, MOLE_ACTIONS, MOLE_ROUTE, ROOM);
  assert.equal(MOLE_MANIFEST.actions.length, 11);
  assert.equal(new Set(MOLE_MANIFEST.actions.map(({ action }) => action)).size, 11);
  assert.deepEqual(contract.deskDock.worldAnchor, [960, 310]);
  assert.deepEqual(MOLE_ROUTE.outboundWaypoints, [[960, 310], [960, 400], [548, 400], [548, 256]]);
  assert.deepEqual(stewardRouteLegs(MOLE_ROUTE, 'outbound').map(({ action }) => action), ['walk-carry-down', 'walk-carry-left', 'walk-carry-up']);
  assert.deepEqual(stewardRouteLegs(MOLE_ROUTE, 'return').map(({ action }) => action), ['walk-empty-down', 'walk-empty-right', 'walk-empty-up']);
  assert.equal(coworkerAnimationSpec(contract, 'steward', 'pickup-books').frameDurationsMs.reduce((a, b) => a + b), 1980);
  assert.equal(coworkerAnimationSpec(contract, 'steward', 'shelve-books').frameDurationsMs.reduce((a, b) => a + b), 2120);
  const props = V6_INTEGRATION.stewardMole.propVisibility;
  assert.equal(stewardBookOwner('pickup-books', 3, 'transition', props), 'transition');
  assert.equal(stewardBookOwner('pickup-books', 4, 'transition', props), 'mole');
  assert.equal(stewardBookOwner('shelve-books', 4, 'mole', props), 'mole');
  assert.equal(stewardBookOwner('shelve-books', 5, 'mole', props), 'shelf');
  assert.deepEqual(props.fixedDeskStackWorldBBox, [960, 269, 1022, 309]);
  assert.deepEqual(props.shelfPatchWorldBBox, [508, 80, 578, 137]);
  assert.doesNotMatch(OFFICE_SOURCE, /setFlipX|flipX/);
});

test('鼹鼠对话暂停与路线中途脚底避让可叠加，只有理由全部消失才续走', () => {
  const scene = new OfficeScene();
  let tweenPauses = 0; let tweenResumes = 0; let animationPauses = 0; let animationResumes = 0;
  const body = { anims: { pause() { animationPauses += 1; }, resume() { animationResumes += 1; } } };
  const steward = { role: 'steward', localAction: 'walk-carry-down', sprite: { x: 752, y: 400, getByName() { return body; } } };
  scene.people = new Map([['steward', steward]]);
  scene.player = { x: 760, y: 400 };
  scene.coworkerContracts = { steward: { animations: { 'walk-carry-right': {} } } };
  const actions = [];
  scene.setPersonAction = (person, action) => { actions.push(action); person.localAction = action; };
  scene.stewardRoutine = {
    phase: 'outbound', completed: false, bookOwner: 'mole', pauseReasons: new Set(),
    tween: { pause() { tweenPauses += 1; }, resume() { tweenResumes += 1; } },
  };
  scene.syncRoleDebug = () => {};

  scene.pauseStewardMotion('conversation');
  scene.pauseStewardMotion('collision');
  assert.deepEqual([...scene.stewardRoutine.pauseReasons], ['conversation', 'collision']);
  assert.deepEqual(actions, ['walk-carry-right']);
  scene.resumeStewardMotion('conversation');
  assert.deepEqual(actions, ['walk-carry-right', 'walk-carry-down']);
  assert.equal(tweenResumes, 0);
  scene.player = { x: 900, y: 500 };
  scene.updateStewardMotionPause();
  assert.equal(scene.stewardRoutine.pauseReasons.size, 0);
  assert.equal(tweenPauses, 2);
  assert.equal(tweenResumes, 1);
  assert.equal(animationPauses, 3);
  assert.equal(animationResumes, 1);
});

test('鼹鼠 route tween 运行中遇到玩家脚底会真实暂停，不只检查 leg 起点', () => {
  const scene = new OfficeScene();
  let tweenConfig = null; let paused = 0;
  const body = { anims: { pause() {}, resume() {} } };
  const sprite = { x: 960, y: 360, setDepth() { return this; }, setPosition(x, y) { this.x = x; this.y = y; return this; }, getByName() { return body; } };
  scene.people = new Map([['steward', { role: 'steward', sprite }]]);
  scene.player = { x: 700, y: 500 };
  scene.stewardRoutine = { phase: 'outbound', completed: false, pauseReasons: new Set(), legIndex: 0, legs: [{ from: [960, 310], to: [960, 400], action: 'walk-carry-down' }], tween: null };
  scene.setPersonAction = () => true;
  scene.syncRoleDebug = () => {};
  scene.tweens = { add(config) { tweenConfig = config; return { pause() { paused += 1; }, resume() {} }; } };

  scene.advanceStewardRoute();
  scene.player = { x: 960, y: 360 };
  tweenConfig.onUpdate();

  assert.equal(paused, 1);
  assert.equal(scene.stewardRoutine.pauseReasons.has('collision'), true);
});

test('页面生产桥接会把对话 presence 完整传给场景', () => {
  const calls = [];
  const scene = {
    people: new Map(), playerCell: { x: 15, y: 13 }, pathPending: false, path: [], stepInProgress: false, manualMoving: false, walkTarget: null, task: null,
    setTask(task, presence) { calls.push({ task, presence }); },
    cancelWalk() {}, talkTo() {},
  };
  const bridge = createOfficeBridge(scene);
  const task = { id: 'task-live', status: 'waiting_user' };
  const presence = { activeConversationRole: 'researcher', engagedRole: 'researcher' };

  bridge.setTask(task, presence);
  assert.deepEqual(calls, [{ task, presence }]);
  assert.equal(bridge.scene, scene);
});

test('概念运行包的五个差异工位碰撞不重叠且建议交互点可安全落到入口连通区', () => {
  const desks = ROOM.foregroundItems.filter((item) => /^(writer|steward|researcher|reviewer|archivist)-desk-front$/.test(item.id));
  assert.equal(desks.length, 5);
  const deskRoles = desks.map((desk) => desk.id.replace('-desk-front', ''));
  assert.deepEqual(new Set(deskRoles), new Set(PEOPLE.map((person) => person.role)));
  for (let i = 0; i < desks.length; i += 1) for (let j = i + 1; j < desks.length; j += 1) {
    const a = desks[i]; const b = desks[j];
    const [ax, ay, aw, ah] = a.collisionRect; const [bx, by, bw, bh] = b.collisionRect;
    const overlaps = ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    assert.equal(overlaps, false, `${a.id} 与 ${b.id} 的桌面碰撞重叠`);
  }

  const scene = new OfficeScene();
  scene.room = ROOM;
  const map = scene.makeCollisionMap();
  scene.grid = { isWalkable: (x, y) => y >= 0 && y < map.length && x >= 0 && x < map[0].length && map[y][x] === 0 };
  scene.playerCell = footToCell(ROOM.spawn[0], ROOM.spawn[1], TILE);
  const walkable = (x, y) => y >= 0 && y < map.length && x >= 0 && x < map[0].length && map[y][x] === 0;
  const spawn = footToCell(ROOM.spawn[0], ROOM.spawn[1], TILE);
  const queue = [spawn];
  const reached = new Set([`${spawn.x},${spawn.y}`]);
  const directions = [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => [dx, dy])).filter(([dx, dy]) => dx || dy);
  while (queue.length) {
    const cell = queue.shift();
    for (const [dx, dy] of directions) {
      const x = cell.x + dx; const y = cell.y + dy;
      if (!walkable(x, y) || (dx && dy && (!walkable(cell.x + dx, cell.y) || !walkable(cell.x, cell.y + dy))) || reached.has(`${x},${y}`)) continue;
      reached.add(`${x},${y}`); queue.push({ x, y });
    }
  }
  for (const [role, workstation] of Object.entries(ROOM.workstations)) {
    const suggested = worldToCell(workstation.interactionPoint[0], workstation.interactionPoint[1], TILE);
    const cell = scene.nearestWalkable({ interactionPoint: workstation.interactionPoint });
    assert.ok(cell, `${role} 没有可用交互点`);
    assert.equal(walkable(cell.x, cell.y) && reached.has(`${cell.x},${cell.y}`), true, `${role} 交互点不可达`);
    if (walkable(suggested.x, suggested.y)) assert.deepEqual(cell, suggested, `${role} 的已修正交互点不应被改写`);
    else assert.notDeepEqual(cell, suggested, `${role} 的被阻挡建议点必须落到最近可走格`);
  }
});

test('v4 五位同事均使用原生状态表和实测桌前锚点', () => {
  assert.equal(COWORKERS.status, 'integration-ready-art-validated-runtime-pending');
  assert.deepEqual(new Set(Object.keys(COWORKERS.characters)), new Set(PEOPLE.map(({ role }) => role)));
  for (const [role, character] of Object.entries(COWORKERS.characters)) {
    assert.deepEqual(ROOM.workstations[role].home, character.homeAnchor);
    assert.equal(character.frameSize[1], 208);
    assert.equal(character.anchor[1], 194);
  }
  assert.match(OFFICE_SOURCE, /const WALK_CYCLE_MS = 480/);
  assert.match(OFFICE_SOURCE, /animation\.frameCount \* 1000 \/ WALK_CYCLE_MS/);
  assert.doesNotMatch(OFFICE_SOURCE, /body\.setScale\(/);
});

test('主角按 v4 原生画布与脚点渲染，不改变路径坐标', () => {
  const scene = new OfficeScene();
  scene.irixiContract = { frameSize: [208, 256], anchor: [104, 238] };
  const makeText = () => ({ setOrigin() { return this; }, setName(name) { this.name = name; return this; }, setVisible(value) { this.visible = value; return this; } });
  scene.add = {
    container(x, y) {
      return {
        x, y, children: [],
        setDepth(depth) { this.depth = depth; return this; },
        add(children) { this.children.push(...children); return this; },
        getByName(name) { return this.children.find((child) => child.name === name); },
      };
    },
    ellipse() { return {}; },
    sprite(_x, _y, texture) {
      return {
        texture,
        anims: { currentAnim: null },
        setOrigin(x, y) { this.origin = [x, y]; return this; },
        setScale(value) { this.scale = value; return this; },
        setName(name) { this.name = name; return this; },
        setData() { return this; },
        play(key) { this.anims.currentAnim = { key }; return this; },
      };
    },
    text: makeText,
  };

  const player = scene.makeAnimal(15, 13, 'irixi', 'Irixi', true);
  const body = player.getByName('body');
  assert.deepEqual(body.origin, [0.5, 238 / 256]);
  assert.equal(body.scale, undefined);
  assert.deepEqual(footToCell(player.x, player.y, 32), { x: 15, y: 13 });
  assert.equal(player.depth, 448);
  assert.equal(body.anims.currentAnim.key, 'irixi-down-idle');
});
