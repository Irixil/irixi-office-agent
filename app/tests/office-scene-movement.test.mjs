import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import EasyStar from 'easystarjs';
import test from 'node:test';

import { canStepWithoutCornerCutting, feetOverlap, footToCell, pointToSegmentDistance, worldToCell } from '../public/office-geometry.js';

globalThis.Phaser = {
  Scene: class {},
  Game: class {},
  AUTO: 'AUTO',
  Scale: { RESIZE: 'RESIZE', CENTER_BOTH: 'CENTER_BOTH' },
  Input: { Keyboard: { KeyCodes: { UP: 38, DOWN: 40, LEFT: 37, RIGHT: 39 } } },
  Geom: { Rectangle: class { constructor(...args) { this.args = args; } } },
};
globalThis.EasyStar = EasyStar;

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

const { bindQualityStates, bindStewardStates, alignedLocalActionEnd, coworkerAnimationSpec, coworkerHitArea, coworkerLocalActions, coworkerRenderTransform, coworkerTransitionSafeFrames, createOfficeBridge, isEditableTarget, normalizeRoomContract, OfficeGrid, OfficeScene, PEOPLE, phaserAnimationFrames, scaledCoworkerHitArea, SEATED_ROLE_POSITION_CORRECTION, SEATED_ROLE_RENDER_SCALE, seatedBodyRenderOffset, seatedRoleBodyRenderOffset, seatedV6Contract, stewardBookOwner, stewardRouteLegs, stewardV6Contract, walkableFoot, TILE } = await import(new URL('../public/office-game.js?movement-regression', import.meta.url));
const BASE_ROOM = JSON.parse(readFileSync(new URL('../../art/office-playable-v1/concept-runtime-v4/manifest.json', import.meta.url), 'utf8'));
const FLOOR_EXTENSION = JSON.parse(readFileSync(new URL('../../art/office-playable-v1/concept-runtime-v5/manifest.json', import.meta.url), 'utf8'));
const ROOM = normalizeRoomContract(BASE_ROOM);
const EXTENDED_ROOM = normalizeRoomContract(BASE_ROOM, FLOOR_EXTENSION);
// Explicit historical coordinate fixture for isolated transform/original-obstacle contracts.
// Production connectivity below uses EXTENDED_ROOM and the current authored staircase instead.
const TRANSLATION_FIXTURE_ROOM = normalizeRoomContract(BASE_ROOM, {
  ...FLOOR_EXTENSION, world: { ...FLOOR_EXTENSION.world, logicalSize: [1568,1620], upperFloorOrigin: [128,0], groundFloorOrigin: [0,810] },
});
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
const REVIEWER_SLEEP_TRANSITION = JSON.parse(readFileSync(new URL('../../art/office-playable-v1/rest-states-v6/continuity-repair-v4/reviewer-sleep-transition-v2/manifest.json', import.meta.url), 'utf8'));
const MOLE_MANIFEST = JSON.parse(readFileSync(new URL(V6_INTEGRATION.stewardMole.manifest, V6_ROOT), 'utf8'));
const MOLE_ROUTE = JSON.parse(readFileSync(new URL(V6_INTEGRATION.stewardMole.routeContract, V6_ROOT), 'utf8'));
const MOLE_ACTIONS = Object.fromEntries(MOLE_MANIFEST.actions.map(({ action, manifest }) => [action, JSON.parse(readFileSync(new URL(`steward-mole/${manifest}`, V6_ROOT), 'utf8'))]));
const OFFICE_SOURCE = readFileSync(new URL('../public/office-game.js', import.meta.url), 'utf8');
const APP_SOURCE = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const INDEX_SOURCE = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('办公室 preload 实际引用的嵌套清单和图片均已随版本打包', () => {
  const queued = [];
  const callbacks = new Map();
  const scene = new OfficeScene();
  scene.load = {
    json(key, url) { queued.push({ type: 'json', key, url }); },
    image(key, url) { queued.push({ type: 'image', key, url }); },
    spritesheet(key, url) { queued.push({ type: 'spritesheet', key, url }); },
    once(event, callback) { callbacks.set(event, callback); },
  };
  scene.preload();
  assert.ok(queued.length > 0, 'preload must request packaged assets');
  // JSON completion callbacks enqueue further manifests and images, just as the real loader does.
  for (const { type, key, url } of queued) {
    const pathname = decodeURIComponent(url.split('?')[0]);
    assert.ok(pathname.startsWith('/assets/'), `Unexpected office asset URL: ${url}`);
    const file = new URL(`../../art/${pathname.slice('/assets/'.length)}`, import.meta.url);
    assert.ok(existsSync(file), `Missing preload asset: ${url}`);
    const bytes = readFileSync(file);
    assert.ok(bytes.length > 0, `Empty preload asset: ${url}`);
    if (type === 'json') {
      callbacks.get(`filecomplete-json-${key}`)?.(key, 'json', JSON.parse(bytes.toString('utf8')));
    } else if (pathname.endsWith('.png')) {
      assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `Invalid PNG: ${url}`);
    }
  }
});

test('下载触发 beforeunload 时不会销毁仍在显示的办公室场景', () => {
  assert.equal(windowListeners.some(({ type }) => type === 'beforeunload'), false);
});

test('二楼前景独立加载和平移，不把物件的可见投影加入地面碰撞', () => {
  const extension = structuredClone(FLOOR_EXTENSION);
  extension.world.upperFloorOrigin = [128,40]; // synthetic nonzero transform, not the new production origin
  const previous = normalizeRoomContract(BASE_ROOM, extension);
  const item = { id: 'upper-reading-table-front', file: 'foreground/reading-table.png', x: 900, y: 420, pivot: [60, 80], depthY: 440 };
  extension.upperFloor.foregroundItems = [item];
  const room = normalizeRoomContract(BASE_ROOM, extension);
  const normalized = room.foregroundItems.find(({ id }) => id === item.id);
  assert.deepEqual([normalized.x, normalized.y, normalized.depthY], [1028, 460, 480]);
  assert.deepEqual(normalized.pivot, item.pivot);
  assert.equal(normalized.collisionRect, null);
  assert.deepEqual(room.blockedRects, previous.blockedRects);
  const queued = []; const callbacks = new Map();
  const scene = new OfficeScene();
  scene.load = { json() {}, spritesheet() {}, image(key, url) { queued.push({ key, url }); }, once(event, callback) { callbacks.set(event, callback); } };
  scene.preload();
  callbacks.get('filecomplete-json-office-floor-extension-v5')('', 'json', extension);
  assert.deepEqual(queued.find(({ key }) => key === `room-foreground-${item.id}`), { key: `room-foreground-${item.id}`, url: `/assets/office-playable-v1/concept-runtime-v5/${item.file}?v=${extension.revision}` });
});

test('五个工位按实际前景ID保持椅背在身后、桌沿在身前，同母版拆层不增加地面碰撞', () => {
  for (const { role } of PEOPLE) {
    const chair = ROOM.foregroundItems.find(({ id }) => id.startsWith(`${role}-chair-back-`));
    const front = ROOM.foregroundItems.find(({ id }) => id === ROOM.workstations[role].frontLayerId);
    assert.ok(chair && front, role);
    assert.ok(chair.depthY <= ROOM.workstations[role].home[1], `${role} chair remains behind the seated body`);
    assert.ok(front.depthY > ROOM.workstations[role].home[1], `${role} tabletop remains in front of the seated body`);
    assert.equal(chair.collisionRect, null);
    if (role !== 'steward') {
      const projection = ROOM.foregroundItems.find(({ id }) => id === `${role}-desk-projection-v10`);
      assert.ok(projection, role); assert.equal(projection.depthY, front.depthY); assert.equal(projection.collisionRect, null);
    } else {
      const near = ROOM.foregroundItems.find(({ id }) => id === 'steward-chair-near-v3');
      assert.ok(near); assert.ok(chair.depthY < near.depthY && near.depthY < front.depthY);
      assert.ok(near.depthY > ROOM.workstations[role].home[1], 'near arm occludes seated body, while chair back stays behind');
      const layers = [chair, near, front];
      for (const layer of layers) {
        assert.deepEqual([layer.x,layer.y,layer.pivot],[850,150,[0,0]], 'same furniture master uses one canvas origin');
        const png=readFileSync(new URL(`../../art/office-playable-v1/concept-runtime-v4/${layer.file}`,import.meta.url));
        assert.deepEqual([png.readUInt32BE(16),png.readUInt32BE(20)],[400,275], 'same furniture master canvas');
        assert.equal(layer.collisionRect,null, 'visual tabletop/chair layer does not become a floor wall');
      }
      assert.equal(ROOM.foregroundItems.some(({id})=>['steward-desk-front','steward-desk-projection-v10'].includes(id)),false,'old desk is not drawn twice');
    }
  }
  const withoutVisualLayers = structuredClone(BASE_ROOM);
  withoutVisualLayers.foregroundItems = [];
  const previous = new OfficeScene(); previous.room = normalizeRoomContract(withoutVisualLayers, FLOOR_EXTENSION);
  const candidate = new OfficeScene(); candidate.room = EXTENDED_ROOM;
  assert.deepEqual(candidate.makeCollisionMap(), previous.makeCollisionMap());
});

test('新坐姿按同一身体接触点注册，跨状态原点变化不移动工位或点击落点', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'reviewer', V6_SEATED.reviewer, TRANSLATION_FIXTURE_ROOM);
  const home = [...contract.deskDock.worldAnchor];
  const states = { idle: { static: true, frameCount: 1, staticFrameIndex: 0, hitArea: [-60, -100, 120, 100] }, working: { static: true, frameCount: 1, staticFrameIndex: 0, anchor: [110, 224], hitArea: [-70, -104, 120, 100] } };
  const placement = { scale: 0.8, registrationPoint: [100, 184], worldPoint: [1200, 540], contacts: { seat: [100, 184] } };
  bindQualityStates(contract, { id: 'seated-placement-test', frameSize: [256, 256], anchor: [100, 220], placement, states });
  assert.deepEqual(contract.placement.worldPoint, [1200, 1350]);
  assert.deepEqual(contract.deskDock.worldAnchor, home);
  const body = { anims: {}, getData() { return true; }, setOrigin() { return this; }, setScale(value) { this.scale = value; return this; }, setPosition(x, y) { this.position = [x, y]; return this; }, stop() { return this; }, setTexture() { return this; }, setFrame() { return this; } };
  const person = { role: 'reviewer', home: [...home], localAction: null, sprite: { getByName() { return body; }, setInteractive(rect) { this.hitRect = rect.args; } } };
  const scene = new OfficeScene(); scene.coworkerContracts = { reviewer: contract }; scene.syncRoleDebug = () => {};
  for (const action of ['idle', 'working']) {
    scene.setPersonAction(person, action, 'status', true, null, true);
    const anchor = contract.animations[action].anchor;
    const renderedContact = placement.registrationPoint.map((value, axis) => home[axis] + body.position[axis] + (value - anchor[axis]) * body.scale);
    assert.deepEqual(renderedContact, [1200, 1350]);
    [-43, -56.2, 96, 80].forEach((value, axis) => assert.ok(Math.abs(person.hitArea[axis] - value) < 1e-9));
    assert.deepEqual(person.home, home);
  }
  const legacy = coworkerRenderTransform({ role: 'writer', deskDock: { renderRegistrationPoint: [88, 103] } }, [88, 194]);
  assert.equal(legacy.scale, 1.12); assert.ok(Math.abs(legacy.offset[1] - 10.92) < 1e-9);
  assert.throws(() => bindQualityStates(contract, { placement: { ...placement, scale: 0 } }), /Invalid placement/);
});

test('真实Phaser enable不替换旧矩形时，五位换状态仍更新实际input且不丢点击注册', async () => {
  const NativeRectangle = (await import('phaser/src/geom/rectangle/index.js')).default;
  const inputSource = readFileSync(new URL('../../node_modules/phaser/src/input/InputPlugin.js', import.meta.url), 'utf8');
  const bodySource = inputSource.match(/enable: function \(gameObject, hitArea, hitAreaCallback, dropZone\)\s*\{([\s\S]*?)\n    \},/)[1];
  const actualPhaserEnable = new Function('gameObject', 'hitArea', 'hitAreaCallback', 'dropZone', bodySource);
  const oldRectangle = Phaser.Geom.Rectangle; Phaser.Geom.Rectangle = NativeRectangle;
  try {
    for (const { role } of PEOPLE) {
      const contract = role === 'steward' ? stewardV6Contract(V6_INTEGRATION, MOLE_MANIFEST, MOLE_ACTIONS, MOLE_ROUTE, EXTENDED_ROOM)
        : seatedV6Contract(V6_INTEGRATION, role, V6_SEATED[role], EXTENDED_ROOM, REST_INTEGRATION, REST_SEATED[role]);
      const binding = JSON.parse(readFileSync(new URL('../../art/office-playable-v1/motion-quality-v8/manifest.json', import.meta.url))).roles[role];
      bindQualityStates(contract, JSON.parse(readFileSync(new URL(`../../art/office-playable-v1/motion-quality-v8/${binding.manifest}`, import.meta.url))));
      const inputPlugin = { setHitArea(sprite, hitArea, hitAreaCallback) { sprite.input = { hitArea, hitAreaCallback, customHitArea: true, enabled: true }; } };
      const body = { anims: { currentFrame: { textureFrame: 0 } }, frame: { name: 0 }, getData() { return true; }, setOrigin() { return this; }, setScale() { return this; }, setPosition() { return this; }, stop() { return this; }, setTexture() { return this; }, setFrame() { return this; }, play() { return this; }, once() {} };
      const clickListener = () => role;
      const sprite = { getByName() { return body; }, clickListener, setInteractive(hitArea, callback) { actualPhaserEnable.call(inputPlugin, this, hitArea, callback); return this; } };
      const person = { role, localAction: null, sprite };
      const scene = new OfficeScene(); scene.coworkerContracts = { [role]: contract }; scene.syncRoleDebug = () => {};
      scene.setPersonAction(person, 'idle', 'local', true, null, true);
      const input = sprite.input;
      if (role === 'steward') {
        const initialShape = input.hitArea;
        sprite.setInteractive(new NativeRectangle(-88, -194, 176, 208), NativeRectangle.Contains);
        assert.equal(input.hitArea, initialShape, 'the installed Phaser enable really ignores the replacement argument');
        assert.equal(NativeRectangle.Contains(input.hitArea, -64, 28), true, 'the stale 256 rectangle reproduces the reported blank-floor interception');
      }
      for (const action of role === 'steward' ? ['walk-empty-down', 'idle'] : ['working', 'sleeping', 'idle']) {
        scene.setPersonAction(person, action, 'local', true, null, true);
        assert.equal(sprite.input, input, `${role} retains its interactive object`);
        assert.equal(sprite.clickListener, clickListener);
        assert.deepEqual([input.hitArea.x, input.hitArea.y, input.hitArea.width, input.hitArea.height], person.hitArea, `${role}/${action} actual rectangle matches the current authored shape`);
        assert.equal(input.hitAreaCallback, NativeRectangle.Contains); assert.equal(input.enabled, true);
        if (role === 'steward' && action === 'walk-empty-down') {
          assert.deepEqual(person.hitArea, [-88, -194, 176, 208]);
          assert.equal(input.hitAreaCallback(input.hitArea, -64, 28), false, 'world [880,1088] beside a mole at [944,1060] is outside the walking hit area');
          assert.equal(input.hitAreaCallback(input.hitArea, 0, -70), true, 'the visible moving mole stays clickable');
        }
      }
    }
  } finally { Phaser.Geom.Rectangle = oldRectangle; }
});

test('同源前臂层只跟随身体当前帧并位于自己桌沿前，不启动第二个动画或改变点击容器', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'reviewer', V6_SEATED.reviewer, TRANSLATION_FIXTURE_ROOM);
  bindQualityStates(contract, { id: 'front-layer-test', frameSize: [256, 256], anchor: [128, 220], placement: { scale: 0.8, registrationPoint: [128, 180], worldPoint: [1200, 450] }, stationPatch: null, occlusionPatch: { file: 'tabletop.png', worldTopLeft: [1090, 435] }, states: { idle: { frameCount: 3, staticFrameIndex: 0, frontSpritesheet: 'arms.png' } } });
  const body = { visible: true, alpha: 0.9, frame: { name: 2 } };
  const front = { setVisible(value) { this.visible = value; return this; }, setTexture(value) { this.texture = value; return this; }, setFrame(value) { this.frame = value; return this; }, setOrigin(x, y) { this.origin = [x, y]; return this; }, setScale(value) { this.scale = value; return this; }, setPosition(x, y) { this.position = [x, y]; return this; }, setDepth(value) { this.depth = value; return this; }, setAlpha(value) { this.alpha = value; return this; } };
  const person = { role: 'reviewer', localAction: 'idle', frontSprite: front, sprite: { x: 1195, y: 1355, visible: true, alpha: 1, getByName() { return body; } } };
  const scene = new OfficeScene(); scene.coworkerContracts = { reviewer: contract };
  scene.syncCoworkerFrontLayer(person);
  assert.equal(front.texture, 'coworker-reviewer-v8-idle-front'); assert.equal(front.frame, 2);
  assert.equal(front.depth, 1403); assert.equal(front.alpha, 0.9);
  assert.deepEqual(front.position, [1200, 1292]);
  assert.deepEqual(contract.deskDock.occlusionPatch.worldPosition, [1090, 1245]);
  assert.equal(contract.deskDock.stationPatch, null);
  person.localAction = 'sleeping'; scene.syncCoworkerFrontLayer(person); assert.equal(front.visible, false);
  person.localAction = 'idle'; person.sprite.visible = false; scene.syncCoworkerFrontLayer(person); assert.equal(front.visible, false);
});

test('自然待机期限本帧触发入睡时，输入锁提前返回前手层已同步新身体帧', () => {
  const contract = seatedV6Contract(V6_INTEGRATION, 'reviewer', V6_SEATED.reviewer, EXTENDED_ROOM);
  const state = (loop = true) => ({ frameCount: 2, staticFrameIndex: 0, safeSwitchFrameIndices: [0, 1], loop, frontSpritesheet: 'front.png' });
  bindQualityStates(contract, { id: 'same-update-test', frameSize: [256, 256], anchor: [128, 220], placement: { scale: 1, registrationPoint: [137, 167], worldPoint: [1200, 450] }, states: { idle: state(), 'enter-sleeping': state(false), sleeping: state() } });
  const body = { visible: true, alpha: 1, frame: { name: 1 }, anims: { currentFrame: { textureFrame: 1 } }, getData() { return true; }, setOrigin() { return this; }, setScale() { return this; }, setPosition() { return this; }, once() {}, play() { this.frame.name = 0; this.anims.currentFrame.textureFrame = 0; return this; } };
  const front = { setVisible() { return this; }, setTexture(value) { this.texture = value; return this; }, setFrame(value) { this.frame = value; return this; }, setOrigin() { return this; }, setScale() { return this; }, setPosition() { return this; }, setDepth() { return this; }, setAlpha() { return this; } };
  const person = { role: 'reviewer', localAction: 'idle', nextLocalActionAt: 0, localActionIndex: 0, localEligible: true, active: false, frontSprite: front, sprite: { x: 1195, y: 1355, visible: true, alpha: 1, getByName() { return body; }, setInteractive() {} } };
  const scene = new OfficeScene(); scene.coworkerContracts = { reviewer: contract }; scene.people = new Map([['reviewer', person]]);
  scene.time = { now: 50000 }; scene.input = { keyboard: { resetKeys() {} } }; scene.cursors = { left: {}, right: {}, up: {}, down: {} }; scene.keys = { A: {}, D: {}, W: {}, S: {} };
  scene.updateStewardMotionPause = scene.updateStewardBurrowMotionPause = scene.updateStewardRoutine = scene.centerCameraOnPlayer = scene.syncRoleDebug = () => {};
  scene.inputLocked = () => true;
  scene.update(50000);
  assert.equal(person.localAction, 'idle-to-sleep');
  assert.equal(body.frame.name, 0); assert.equal(front.frame, 0);
  assert.equal(front.texture, 'coworker-reviewer-v8-enter-sleeping-front');
  assert.equal(person.nextLocalActionAt, Number.POSITIVE_INFINITY);
});

test('办公室保留五个角色身份并显示指定的职能名称', () => {
  assert.deepEqual(PEOPLE.map(({ role }) => role), ['researcher', 'writer', 'reviewer', 'steward', 'archivist']);
  assert.deepEqual(PEOPLE.slice(1).map(({ name }) => name), ['小鼠工具开发同事', '龙猫小游戏开发同事', '鼹鼠Agent开发同事', '花枝鼠档案记忆同事']);
  assert.match(APP_SOURCE, /utility:\s*\{ title: '小工具', action: '交代小工具需求'/);
  assert.match(APP_SOURCE, /game:\s*\{ title: '小游戏', action: '交代小游戏需求'/);
  assert.match(APP_SOURCE, /agent:\s*\{ title: 'Agent', action: '交代 Agent 需求'/);
});

test('职能分类只在提交原生表单时发送，取消会清空临时分类且目标内容经HTML转义', () => {
  assert.match(INDEX_SOURCE, /<input type="hidden" name="functionId" value="">/);
  assert.match(INDEX_SOURCE, /<button class="secondary-button" type="button" data-close-dialog>取消<\/button>/);
  assert.match(APP_SOURCE, /\$\('#task-dialog'\)\.addEventListener\('close', \(\) => \{\s*\$\('#task-form'\)\.reset\(\);\s*setTaskFunction\(''\);\s*\}\)/);
  assert.match(APP_SOURCE, /api\(state\.nativeProduct\.links\.createTask, \{ method: 'POST', body: JSON\.stringify\(input\) \}\)/);
  assert.match(APP_SOURCE, /delete body\.functionId/);
  assert.match(APP_SOURCE, /\$\{esc\(statusText\)\}/);
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
  scene.scale = { width: 1440, height: 810 };
  scene.cursors = { left: { isDown: false }, right: { isDown: false }, up: { isDown: false }, down: { isDown: false } };
  scene.keys = { A: { isDown: false }, D: { isDown: false }, W: { isDown: false }, S: { isDown: false } };
  scene.grid = { isWalkable: () => true };
  scene.player = player;
  scene.cameras = { main: { zoom: 1, centerOn(x, y) { this.center = [x, y]; } } };
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

function obstacleMovementScene(matrix, from, obstacle = { x: 700, y: 1400, visible: true }) {
  const runtime = movementScene(); const scene = runtime.scene;
  obstacle.getByName ||= () => ({ frame: { name: 0 } });
  scene.grid = new OfficeGrid(matrix); scene.playerCell = { ...from };
  runtime.player.setPosition(from.x * TILE + TILE / 2, (from.y + 1) * TILE);
  scene.people = new Map([['steward', { role: 'steward', sprite: obstacle }]]);
  scene.syncDebugState = scene.syncRoleDebug = scene.centerCameraOnPlayer = () => {};
  scene.destinationMarker.setPosition = scene.destinationMarker.setDepth = function () { return this; };
  return { ...runtime, scene, obstacle, get tween() { return runtime.tween; } };
}

test('正常点击原洞口阻塞路线按当前占位绕行，出洞后洞口也不会变成可走格', async () => {
  const source = new OfficeScene(); source.room = TRANSLATION_FIXTURE_ROOM;
  const runtime = obstacleMovementScene(source.makeCollisionMap(), { x: 28, y: 32 }, { x: 960, y: 1120, visible: false });
  const scene = runtime.scene; scene.stewardBurrow = { workbench: true, x: 944, y: 1060 };
  const destination = { x: 34, y: 32 };
  const staticPath = await scene.grid.findPath(scene.playerCell, destination);
  assert.ok(staticPath.some(({ x, y }) => x === 29 && y === 32), 'the original static-only plan crosses the permanently occupied hole');
  assert.equal(await scene.startPath(destination, { kind: 'floor', destination }), true);
  assert.ok(scene.path.length > 6, 'the route detours instead of waiting at the hole');
  assert.equal(scene.path.some(({ x, y }) => x === 29 && y === 32), false);
  let previous = scene.playerCell;
  for (const next of scene.path) {
    assert.equal(canStepWithoutCornerCutting((x, y) => scene.canOccupyCell(x, y), previous.x, previous.y, next.x - previous.x, next.y - previous.y), true);
    assert.equal(scene.canTraverseCells(previous, next), true); previous = next;
  }
  runtime.obstacle.visible = true;
  assert.equal(scene.canOccupyCell(29, 32), false, 'the open hole remains a floor obstacle while the mole is working');
});

test('路径检查包含脚底整段，鼹鼠站在两个合法网格点之间也不能斜穿', async () => {
  const runtime = obstacleMovementScene(Array.from({ length: 6 }, () => Array(6).fill(0)), { x: 2, y: 2 }, { x: 96, y: 112, visible: true });
  const scene = runtime.scene; const destination = { x: 3, y: 3 };
  assert.equal(scene.canOccupyCell(2, 2), true); assert.equal(scene.canOccupyCell(3, 3), true);
  assert.equal(scene.canStep(1, 1), false);
  assert.equal(await scene.startPath(destination, { kind: 'floor', destination }), true);
  assert.ok(scene.path.length > 1);
  let previous = scene.playerCell;
  for (const next of scene.path) { assert.equal(scene.canTraverseCells(previous, next), true); previous = next; }
});

test('途中鼹鼠占住下一段会重算替代路；仍无路最多三次后结束walking', async () => {
  const runtime = obstacleMovementScene([Array(3).fill(0)], { x: 0, y: 0 });
  const scene = runtime.scene; const destination = { x: 2, y: 0 };
  let searches = 0; const findPath = scene.grid.findPath.bind(scene.grid);
  scene.grid.findPath = (...args) => { searches++; return findPath(...args); };
  assert.equal(await scene.startPath(destination, { kind: 'floor', destination }), true);
  runtime.obstacle.x = 48; runtime.obstacle.y = 32;
  for (const time of [200, 550, 900, 1250]) { scene.update(time); await new Promise(setImmediate); }
  assert.equal(searches, 4, 'initial request plus three bounded replans');
  assert.equal(createOfficeBridge(scene).debugSnapshot().walking, false);
  assert.equal(scene.walkTarget, null); assert.equal(scene.pathPending, false);
  assert.match(runtime.body.anims.currentAnim.key, /-idle$/);
  assert.ok(dispatched.some(({ type }) => type === 'irixi:walk-cancelled'));
});

test('单格行进中鼹鼠进入剩余路线时先回到安全脚点，再按新占位绕开', async () => {
  const runtime = obstacleMovementScene(Array.from({ length: 4 }, () => Array(5).fill(0)), { x: 0, y: 0 });
  const scene = runtime.scene; const destination = { x: 2, y: 0 };
  assert.equal(await scene.startPath(destination, { kind: 'floor', destination }), true);
  scene.update(200); const interrupted = runtime.tween;
  runtime.obstacle.x = 48; runtime.obstacle.y = 32; runtime.player.x = 32;
  interrupted.onUpdate();
  assert.deepEqual(scene.playerCell, { x: 0, y: 0 }); assert.deepEqual([runtime.player.x, runtime.player.y], [16, 32]);
  assert.equal(scene.stepInProgress, false); assert.deepEqual(scene.path[0], { x: 1, y: 0 });
  scene.update(400); await new Promise(setImmediate);
  assert.equal(scene.pathPending, false); assert.ok(scene.path.length > 2);
  assert.notDeepEqual(scene.path[0], { x: 1, y: 0 });
});

test('角色新归位已与当前脚点重叠时仍能向外让开，不把玩家锁在原地', async () => {
  const runtime = obstacleMovementScene(Array.from({ length: 5 }, () => Array(5).fill(0)), { x: 2, y: 2 }, { x: 80, y: 96, visible: true });
  const scene = runtime.scene; const destination = { x: 3, y: 2 };
  assert.equal(scene.canOccupyCell(2, 2), false); assert.equal(scene.canStep(1, 0), true);
  assert.equal(await scene.startPath(destination, { kind: 'floor', destination }), true);
  scene.update(200); runtime.player.x = 96; runtime.tween.onUpdate();
  assert.equal(scene.stepInProgress, true, 'moving outward is not cancelled while leaving the prior overlap');
  runtime.player.x = 112; runtime.tween.onComplete();
  assert.deepEqual(scene.playerCell, destination); assert.equal(scene.canOccupyCell(3, 2), true);
});

test('鼹鼠在单格终点出现且onUpdate尚未运行时，直接取消、方向键和Esc均不把玩家吸到它脚下', () => {
  for (const trigger of ['direct', 'direction-key', 'escape']) {
    const runtime = obstacleMovementScene(Array.from({ length: 5 }, () => Array(5).fill(0)), { x: 0, y: 0 });
    const scene = runtime.scene; const callbacks = new Map();
    scene.input = { keyboard: { addKeys() { return {}; }, on(event, callback) { callbacks.set(event, callback); }, resetKeys() {} } };
    scene.registerKeyboardControls();
    scene.walkTarget = { kind: 'floor', destination: { x: 2, y: 0 } };
    scene.moveToCell(1, 0, { keepWalking: true }); const staleTween = runtime.tween;
    runtime.player.x = 20; runtime.obstacle.x = 48; runtime.obstacle.y = 32;
    assert.equal(feetOverlap(runtime.player.x, runtime.player.y, runtime.obstacle.x, runtime.obstacle.y), false);
    if (trigger === 'direct') scene.cancelWalk();
    else if (trigger === 'direction-key') callbacks.get('keydown')({ key: 'ArrowDown', preventDefault() {}, target: null });
    else callbacks.get('keydown-ESC')();
    assert.deepEqual([runtime.player.x, runtime.player.y], [16, 32], trigger);
    assert.deepEqual(scene.playerCell, { x: 0, y: 0 });
    assert.equal(feetOverlap(runtime.player.x, runtime.player.y, runtime.obstacle.x, runtime.obstacle.y), false);
    assert.equal(scene.stepInProgress, false); assert.equal(scene.currentStep, null); assert.equal(scene.walkTarget, null);
    assert.equal(scene.canStep(0, 1), true, 'the player can still move outward after cancelling');
    const beforeLateCallbacks = [runtime.player.x, runtime.player.y];
    staleTween.onUpdate(); staleTween.onComplete();
    assert.deepEqual([runtime.player.x, runtime.player.y], beforeLateCallbacks, 'late tween callbacks cannot revive the cancelled step');
    assert.equal(scene.stepInProgress, false);
  }
});

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

test('相机只留出水平步进余量并跟随玩家，点击仍通过 Phaser 世界坐标换算', async () => {
  const scene = new OfficeScene();
  const camera = {
    zoom: 1,
    setBounds(...bounds) { this.bounds = bounds; return this; },
    setZoom(value) { this.zoom = value; return this; },
    centerOn(x, y) { this.center = [x, y]; return this; },
    getWorldPoint(x, y) { this.pointerWorld = [x + 64, y]; return { x: x + 64, y }; },
  };
  scene.room = ROOM;
  scene.scale = { width: 1440, height: 810 };
  scene.cameras = { main: camera };
  scene.player = { x: 930, y: 500 };
  scene.fitCamera();
  assert.deepEqual(camera.bounds, [0, 0, 1440, 810]);
  assert.equal(camera.zoom, 1440 / (1440 - TILE * 4));
  assert.ok(Math.abs(camera.center[0] - 784) < 1e-9 && Math.abs(camera.center[1] - 441) < 1e-9);

  scene.scale = { width: 536, height: 520 };
  scene.fitCamera();
  assert.equal(camera.zoom, 520 / 810);
  assert.equal(520 / camera.zoom, 810);
  assert.ok(Math.abs(536 / camera.zoom - 536 * 810 / 520) < 1e-9);
  assert.deepEqual(camera.center, [930, 405]);

  scene.inputLocked = () => false;
  scene.grid = { isWalkable: () => false };
  scene.isFurniturePoint = () => false;
  await scene.walkToPointer({ x: 400, y: 320 });
  assert.deepEqual(camera.pointerWorld, [464, 320]);
  assert.equal(host.dataset.lastPointerCell, '14,10');

  scene.room = EXTENDED_ROOM;
  scene.scale = { width: 1440, height: 810 };
  const groundCenterY = EXTENDED_ROOM.groundFloorY + EXTENDED_ROOM.floorHeight / 2;
  scene.player = { x: 900, y: groundCenterY };
  scene.fitCamera();
  assert.deepEqual(camera.bounds, [0, 0, EXTENDED_ROOM.width, EXTENDED_ROOM.height]);
  assert.equal(camera.center[1], groundCenterY, 'camera follows the player vertically inside the expanded map');
  assert.ok(810 / camera.zoom < EXTENDED_ROOM.height, 'camera never zooms out to show both floors at once');
  assert.equal(camera.zoom, 1440 / (1440 - TILE * 4), 'camera scale is based on one floor, not the expanded world bounds');
  scene.player.y = 100;
  scene.centerCameraOnPlayer();
  assert.ok(Math.abs(camera.center[1] - 369) < 1e-9, 'camera clamps to the outer world edge');
  scene.player.x = 1550;
  scene.centerCameraOnPlayer();
  assert.equal(camera.center[0], EXTENDED_ROOM.backgroundLayers[0].x + EXTENDED_ROOM.backgroundLayers[0].width - 1440 / camera.zoom / 2, 'upper-floor camera stays inside its image coverage');
  scene.player.y = groundCenterY;
  scene.centerCameraOnPlayer();
  assert.equal(camera.center[0], 1440 - 1440 / camera.zoom / 2, 'ground-floor camera does not reveal the uncovered union margin');
});

test('当前母版的楼上、单直梯和一楼真实连通，旧竖桥不可通行', async () => {
  const [gx,gy] = FLOOR_EXTENSION.world.groundFloorOrigin;
  const [ux,uy] = FLOOR_EXTENSION.world.upperFloorOrigin;
  assert.deepEqual([EXTENDED_ROOM.width, EXTENDED_ROOM.height], FLOOR_EXTENSION.world.logicalSize);
  assert.deepEqual(EXTENDED_ROOM.workstations.reviewer.home, BASE_ROOM.workstations.reviewer.characterFootAnchor.map((v,i) => v + [gx,gy][i]));
  assert.deepEqual(EXTENDED_ROOM.backgroundLayers.map(({x,y}) => [x,y]), [[ux,uy],[gx,gy]]);
  assert.equal(FLOOR_EXTENSION.world.stairConnection.id, 'right-straight-stair-v12');
  assert.equal(FLOOR_EXTENSION.upperFloor.blockedPolygons.some(({id}) => id === 'upper-stair-railing-inner'), false, 'the old bridge barrier is retired with that bridge');

  const scene = new OfficeScene();
  scene.room = EXTENDED_ROOM;
  const map = scene.makeCollisionMap();
  const walkable = (x, y) => y >= 0 && y < map.length && x >= 0 && x < map[0].length && map[y][x] === 0;
  const spawn = footToCell(...EXTENDED_ROOM.spawn, TILE);
  scene.playerCell = spawn;
  scene.grid = { isWalkable: walkable };
  const upperGallery = footToCell(720, 480, TILE);
  const queue = [spawn];
  const reached = new Set([`${spawn.x},${spawn.y}`]);
  while (queue.length) {
    const cell = queue.shift();
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const x = cell.x + dx; const y = cell.y + dy;
      if (!walkable(x, y) || (dx && dy && (!walkable(cell.x + dx, cell.y) || !walkable(cell.x, cell.y + dy))) || reached.has(`${x},${y}`)) continue;
      reached.add(`${x},${y}`); queue.push({ x, y });
    }
  }
  assert.ok(reached.has(`${upperGallery.x},${upperGallery.y}`), 'main floor can be reached from the spawn through the existing staircase');
  assert.equal(walkable(...Object.values(footToCell(1040,672,TILE))), false, 'old vertical bridge now lies over the bookshelf wall and is not a floor');
  assert.equal(walkable(...Object.values(worldToCell(16, 400, TILE))), false, 'the outer image margin remains non-walkable');
  for (const point of FLOOR_EXTENSION.world.stairConnection.walkableCenterline) {
    const cell = footToCell(...point, TILE);
    assert.ok(walkable(cell.x, cell.y) && reached.has(`${cell.x},${cell.y}`), `stair foot point ${point.join(',')} is on the connected walk surface`);
  }
  const finder = new EasyStar.js();
  finder.setGrid(map);
  finder.setAcceptableTiles([0]);
  finder.enableDiagonals();
  finder.disableCornerCutting();
  finder.setIterationsPerCalculation(600);
  finder.enableSync();
  let easyStarPath = null;
  finder.findPath(spawn.x, spawn.y, upperGallery.x, upperGallery.y, (path) => { easyStarPath = path; });
  finder.calculate();
  assert.ok(easyStarPath?.length, 'the installed EasyStar returns an actual route between floors');
  for (let index = 1; index < easyStarPath.length; index += 1) {
    const previous = easyStarPath[index - 1]; const next = easyStarPath[index];
    const dx = next.x - previous.x; const dy = next.y - previous.y;
    assert.equal(canStepWithoutCornerCutting(walkable, previous.x, previous.y, dx, dy), true, `EasyStar step ${index} stays on the connected floor surface`);
  }
  const actualFeet = easyStarPath.map(({ x, y }) => [x * TILE + TILE / 2, (y + 1) * TILE]);
  host.dataset.easyStarDiagnosticFeet = JSON.stringify(actualFeet);
  for (const y of [544,576,608,640,672,704,736,768]) {
    assert.ok(actualFeet.some(([x,py]) => py === y && x >= 1150 && x <= 1334), `the route actually traverses measured stair level ${y}, not an old virtual bridge`);
  }
  assert.equal(walkable(...Object.values(worldToCell(1078,330,TILE))), false, 'upper reading-table ground footprint remains blocked');
  assert.equal(walkable(...Object.values(footToCell(1200,768,TILE))), false, 'near-side stair post/edge is outside the real tread');
  assert.equal(walkable(...Object.values(worldToCell(1080,700,TILE))), false, 'adjacent bookcase wall is not an alternative bridge');
  assert.equal(walkable(...Object.values(worldToCell(1000,720,TILE))), false, 'first-floor wall stays outside the stair opening');

  const steward = stewardV6Contract(V6_INTEGRATION, MOLE_MANIFEST, MOLE_ACTIONS, MOLE_ROUTE, EXTENDED_ROOM);
  assert.deepEqual(steward.deskDock.worldAnchor, V6_INTEGRATION.stewardMole.homeWorldFoot.map((v,i) => v + [gx,gy][i]));
  assert.deepEqual(steward.steward.routeContract.outboundWaypoints[1], MOLE_ROUTE.outboundWaypoints[1].map((v,i) => v + [gx,gy][i]));
  assert.deepEqual(steward.steward.integration.propVisibility.fixedDeskStackWorldBBox, V6_INTEGRATION.stewardMole.propVisibility.fixedDeskStackWorldBBox.map((v,i) => v + (i % 2 ? gy : gx)));
  const writer = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, EXTENDED_ROOM);
  assert.equal(writer.deskDock.stationPatch.worldPosition[1], V6_SEATED.writer.stationPatch.worldPosition[1] + gy);
  for (const [role, workstation] of Object.entries(EXTENDED_ROOM.workstations)) {
    const target = scene.nearestWalkable({ interactionPoint: workstation.interactionPoint });
    assert.ok(target && reached.has(`${target.x},${target.y}`), `${role} remains reachable after the shared world offset`);
  }
  scene.inputLocked = () => false;
  scene.cameras = { main: { getWorldPoint(x, y) { return { x, y }; } } };
  scene.startPath = async (destination, target) => { scene.lastTestPath = { destination, target }; return true; };
  await scene.walkToPointer({ x:720, y:479 });
  assert.equal(host.dataset.lastClickAccepted, 'true', 'clicking the upper gallery enters the same pathfinding world');
  assert.deepEqual(scene.lastTestPath.destination, upperGallery);
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

test('弹窗打开时忽略Phaser命中的同事；普通点击仍能打开对话', async () => {
  const runtime = movementScene();
  runtime.scene.playerCell = { x: 14, y: 12 };
  const writer = { role: 'writer', name: '小鼠写作员', interactionPoint: ROOM.workstations.writer.interactionPoint, statusText: { text: '待命' } };
  const originalQuerySelector = document.querySelector;
  const originalActiveElement = document.activeElement;
  let dialogOpen = true;
  document.querySelector = (selector) => selector === 'dialog[open]' && dialogOpen ? {} : null;
  runtime.scene.inputLocked = OfficeScene.prototype.inputLocked.bind(runtime.scene);
  try {
    await runtime.scene.talkTo(writer);
    assert.deepEqual(dispatched, [], 'a modal close press routed through Phaser must not open an occluded coworker');

    dialogOpen = false;
    document.activeElement = { matches: (selector) => selector.includes('textarea'), closest: () => null };
    assert.equal(runtime.scene.inputLocked(), true, 'the ordinary chat textarea still locks movement');
    await runtime.scene.talkTo(writer);
    runtime.scene.people = new Map([['writer', writer]]);
    createOfficeBridge(runtime.scene).talkToRole('writer');
    assert.deepEqual(dispatched.map(({ type }) => type), ['irixi:coworker', 'irixi:arrival', 'irixi:coworker', 'irixi:arrival'],
      'ordinary coworker clicks and the role entry remain available while chat text is focused');
  } finally {
    document.querySelector = originalQuerySelector;
    document.activeElement = originalActiveElement;
  }
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
  assert.equal(runtime.killed, 1, 'text input cancels the old pending walk without blocking keys');
  assert.equal(runtime.scene.pathPending, false);
  assert.equal(isEditableTarget(editable), true);
  assert.equal(isEditableTarget({ matches() { return false; }, closest(selector) { return selector.includes('contenteditable') ? {} : null; } }), true);
});

test('实际文本输入清除 Phaser 按键状态并停止旧自动走近', () => {
  const runtime = movementScene();
  let resets = 0;
  runtime.scene.inputLocked = () => true;
  runtime.scene.input = { keyboard: { resetKeys() { resets += 1; } } };
  runtime.scene.path = [{ x: 14, y: 13 }];
  runtime.scene.playerCell = { x: 15, y: 13 };
  const priorFocus = document.activeElement;
  document.activeElement = { matches: () => true };
  try { runtime.scene.update(200); } finally { document.activeElement = priorFocus; }
  assert.equal(resets, 1);
  assert.deepEqual(runtime.scene.cameras.main.center, [ROOM.width / 2, ROOM.height / 2]);
  assert.deepEqual(runtime.scene.playerCell, { x: 15, y: 13 });
  assert.deepEqual([runtime.player.x,runtime.player.y],[496,448]);
  assert.deepEqual(runtime.scene.path, []);
  assert.equal(runtime.scene.stepInProgress, false);
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
  const expectedRegistrationOffsets = { researcher: 0, writer: 10.92, reviewer: -4.4, archivist: -8.12 };
  for (const [role, binding] of Object.entries(V6_INTEGRATION.seatedRoles)) {
    const restManifest = REST_SEATED[role];
    const contract = seatedV6Contract(V6_INTEGRATION, role, V6_SEATED[role], ROOM, REST_INTEGRATION, restManifest);
    assert.deepEqual(contract.deskDock.worldAnchor, ROOM.workstations[role].home);
    assert.deepEqual(contract.deskDock.renderRegistrationPoint, [contract.anchor[0], restManifest.fixedContentBottom]);
    const [offsetX, offsetY] = seatedBodyRenderOffset(contract.anchor, contract.deskDock.renderRegistrationPoint, SEATED_ROLE_RENDER_SCALE[role]);
    assert.equal(offsetX, 0);
    assert.ok(Math.abs(offsetY - expectedRegistrationOffsets[role]) < 1e-9, `${role} 固定注册偏移不匹配`);
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
  assert.deepEqual(reviewer.deskDock.worldAnchor, ROOM.workstations.reviewer.home);
  assert.deepEqual(reviewer.deskDock.worldAnchor, [1195, 545]);
  assert.deepEqual(reviewer.deskDock.stationPatch.worldPosition, [1194, 443]);
  assert.equal(reviewer.deskDock.frontLayerDepthY, 592);
  const archivist = seatedV6Contract(V6_INTEGRATION, 'archivist', V6_SEATED.archivist, ROOM);
  assert.deepEqual(archivist.deskDock.worldAnchor, [1180, 739]);
  const researcher = seatedV6Contract(V6_INTEGRATION, 'researcher', V6_SEATED.researcher, ROOM);
  assert.deepEqual(researcher.deskDock.worldAnchor, [240, 645]);
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

test('reviewer 入睡与醒来经过同一组精确端点和反向中间帧', () => {
  const contract = seatedV6Contract(
    V6_INTEGRATION, 'reviewer', V6_SEATED.reviewer, ROOM,
    REST_INTEGRATION, REST_SEATED.reviewer,
    CONTINUITY_INTEGRATION, CONTINUITY_TRANSITIONS.reviewer,
    null, REVIEWER_SLEEP_TRANSITION,
  );
  const toSleep = coworkerAnimationSpec(contract, 'reviewer', 'idle-to-sleep');
  const toIdle = coworkerAnimationSpec(contract, 'reviewer', 'sleep-to-idle');
  const idle = coworkerAnimationSpec(contract, 'reviewer', 'idle');
  const sleeping = coworkerAnimationSpec(contract, 'reviewer', 'sleeping');

  assert.deepEqual(toSleep.frames, [0, 1, 2]);
  assert.deepEqual(toSleep.frameDurationsMs, [100, 180, 260]);
  assert.equal(toSleep.animation.returnTo, 'sleeping');
  assert.deepEqual(toIdle.frames, [...toSleep.frames].reverse());
  assert.deepEqual(toIdle.frameDurationsMs, [260, 180, 100]);
  assert.equal(toIdle.animation.returnTo, 'idle');
  assert.equal(toSleep.textureKey, 'coworker-reviewer-sleep-transition-v5');
  assert.deepEqual(REVIEWER_SLEEP_TRANSITION.sourceFrameIndices, [0, 1, 3]);
  assert.equal(REVIEWER_SLEEP_TRANSITION.excludedSourceFrame.index, 2);
  assert.match(REVIEWER_SLEEP_TRANSITION.excludedSourceFrame.reason, /^head dipped below the fixed sleep endpoint and rebounded upward at the endpoint/);
  assert.deepEqual(coworkerTransitionSafeFrames('idle', 'idle-to-sleep', idle), [0]);
  assert.deepEqual(coworkerTransitionSafeFrames('sleeping', 'sleep-to-idle', sleeping), [0]);
  assert.deepEqual(coworkerLocalActions(contract), ['sleeping', 'slack']);
  assert.equal(toSleep.animation.transition, true);
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

test('静态鼹鼠姿态只等待自己实际拥有的帧，不会卡在 idle→working 的第 3 帧', () => {
  const contract = stewardV6Contract(V6_INTEGRATION, MOLE_MANIFEST, MOLE_ACTIONS, MOLE_ROUTE, ROOM);
  const idle = coworkerAnimationSpec(contract, 'steward', 'idle');
  assert.equal(idle.isStatic, true);
  assert.deepEqual(coworkerTransitionSafeFrames('idle', 'working', idle), [idle.frames[0]]);

  const body = {
    anims: { currentFrame: { textureFrame: 0 } }, frame: { name: 0 }, texture: { key: idle.textureKey },
    getData() { return true; }, setOrigin() { return this; }, setInteractive() { return this; },
    stop() { return this; }, setTexture(key) { this.texture.key = key; return this; },
    setFrame(frame) { this.frame.name = frame; return this; },
  };
  const person = { role: 'steward', localAction: 'idle', pendingAction: null,
    sprite: { getByName() { return body; }, setInteractive() { return this; } } };
  const scene = new OfficeScene();
  scene.coworkerContracts = { steward: contract };
  scene.reducedMotion = false;
  scene.syncRoleDebug = () => {};
  assert.equal(scene.setPersonAction(person, 'working', 'task'), true);
  assert.equal(person.localAction, 'working');
  assert.equal(person.pendingAction, null);

  const writerContract = seatedV6Contract(V6_INTEGRATION, 'writer', V6_SEATED.writer, ROOM, REST_INTEGRATION, REST_SEATED.writer);
  const reducedBody = {
    anims: { currentFrame: { textureFrame: 0 } }, frame: { name: 0 }, texture: { key: 'coworker-writer-idle' },
    getData() { return true; }, setOrigin() { return this; }, setInteractive() { return this; },
    stop() { return this; }, setTexture(key) { this.texture.key = key; return this; }, setFrame(frame) { this.frame.name = frame; return this; },
  };
  const reducedPerson = { role: 'writer', localAction: 'idle', pendingAction: null,
    sprite: { getByName() { return reducedBody; }, setInteractive() { return this; } } };
  scene.coworkerContracts = { writer: writerContract };
  scene.reducedMotion = true;
  assert.equal(scene.setPersonAction(reducedPerson, 'working', 'task'), true);
  assert.equal(reducedPerson.pendingAction, null);
});

test('真实 Agent 工作中可跑完一次取书、归档路线，轮询不重置，完成后只呼吸等待', () => {
  const actions = [];
  const statusText = { text: '待命', setText(value) { this.text = value; } };
  const completions = new Map();
  const body = {
    on(_event, callback) { this.updateFrame = callback; },
    once(event, callback) { completions.set(event, callback); },
  };
  const person = {
    role: 'steward', home: [960, 310], active: true, localEligible: false, activitySource: 'task',
    localAction: 'working', pendingTaskAction: null, statusText,
    sprite: {
      x: 960, y: 310, getByName() { return body; }, setAlpha() { return this; },
      setPosition(x, y) { this.x = x; this.y = y; return this; }, setDepth(depth) { this.depth = depth; return this; },
    },
  };
  let deskVisible = true; let shelfVisible = false;
  const scene = new OfficeScene();
  scene.people = new Map([['steward', person]]);
  scene.coworkerContracts = { steward: stewardV6Contract(V6_INTEGRATION, MOLE_MANIFEST, MOLE_ACTIONS, MOLE_ROUTE, ROOM) };
  scene.stewardDeskStack = { setVisible(value) { deskVisible = value; } };
  scene.stewardShelfStack = { setVisible(value) { shelfVisible = value; } };
  scene.reducedMotion = false;
  scene.time = { now: 0 };
  scene.player = { x: 0, y: 0 };
  scene.tweens = { add(config) { return { ...config, pause() {}, resume() {} }; } };
  scene.setPersonAction = (_person, action, source) => { actions.push({ action, source }); person.localAction = action; };
  scene.syncRoleDebug = () => {};
  scene.initializeStewardRoutine();
  const routine = scene.stewardRoutine;

  const completeRoute = () => {
    while (routine.tween) {
      const tween = routine.tween;
      tween.onComplete();
    }
  };

  scene.updateStewardRoutine(3000);
  assert.equal(routine.phase, 'pickup');
  assert.equal(deskVisible, false);
  assert.deepEqual(actions.at(-1), { action: 'pickup-books', source: 'local' });

  body.updateFrame(null, { textureFrame: 4 });
  assert.equal(routine.bookOwner, 'mole');
  completions.get('animationcomplete-steward-pickup-books')();
  assert.equal(routine.phase, 'outbound');

  const carriedState = { phase: routine.phase, bookOwner: routine.bookOwner, legs: routine.legs, tween: routine.tween };
  scene.setTask({ nativeProduct: true, functionId: 'agent', status: 'running' });
  scene.setTask({ nativeProduct: true, functionId: 'agent', status: 'running' });
  assert.deepEqual({ phase: routine.phase, bookOwner: routine.bookOwner, legs: routine.legs, tween: routine.tween }, carriedState);
  assert.equal(person.pendingTaskAction.action, 'working');
  completeRoute();
  assert.equal(routine.phase, 'shelving');
  assert.deepEqual(actions.at(-1), { action: 'shelve-books', source: 'local' });

  body.updateFrame(null, { textureFrame: 5 });
  assert.equal(routine.bookOwner, 'shelf');
  assert.equal(shelfVisible, true);
  completions.get('animationcomplete-steward-shelve-books')();
  assert.equal(routine.phase, 'returning');
  completeRoute();
  assert.equal(routine.phase, 'completed');
  assert.equal(routine.bookOwner, 'shelf');
  assert.equal(deskVisible, false);
  assert.equal(shelfVisible, true);
  assert.equal(person.localAction, 'wait-empty');
  assert.equal(statusText.text, '正在工作');
  assert.deepEqual(person.sprite && [person.sprite.x, person.sprite.y], person.home);

  scene.updateStewardRoutine(100000);
  scene.setTask({ nativeProduct: true, functionId: 'agent', status: 'running' });
  assert.equal(routine.phase, 'completed');
  assert.equal(person.localAction, 'wait-empty');
  assert.equal(actions.filter(({ action }) => action === 'pickup-books').length, 1);
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

test('五个工位各有真实地面占位、互不重叠，建议交互点可安全落到入口连通区', () => {
  const footprints = ROOM.blockedRects.filter(({id}) => PEOPLE.some(({role})=>id.startsWith(`${role}-`)));
  assert.deepEqual(new Set(footprints.map(({id})=>id.split('-')[0])),new Set(PEOPLE.map(({role})=>role)));
  assert.ok(footprints.every(({rect})=>rect.length===4&&rect.every(Number.isFinite)&&rect[2]>0&&rect[3]>0));
  for (let i = 0; i < footprints.length; i += 1) for (let j = i + 1; j < footprints.length; j += 1) {
    const a = footprints[i]; const b = footprints[j];
    const [ax, ay, aw, ah] = a.rect; const [bx, by, bw, bh] = b.rect;
    const overlaps = ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
    assert.equal(overlaps, false, `${a.id} 与 ${b.id} 的地面占位重叠`);
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
  assert.match(OFFICE_SOURCE, /body\.setScale\(transform\.scale\)/);
  assert.match(OFFICE_SOURCE, /body\.setPosition\(\.\.\.transform\.offset\)/);
  assert.deepEqual(SEATED_ROLE_RENDER_SCALE, { researcher: 1, writer: 1.12, reviewer: 0.92, archivist: 0.86, steward: 1 });
  assert.deepEqual(SEATED_ROLE_POSITION_CORRECTION, { researcher: [0, 0], writer: [0, 0], reviewer: [0, 0], archivist: [18, 0], steward: [0, 0] });
  assert.deepEqual(scaledCoworkerHitArea([-50, -80, 100, 120], 0.8, [4, -8]), [-36, -72, 80, 96]);
  const writerRenderOffset = seatedBodyRenderOffset([88, 194], [88, 103], 1.12);
  assert.equal(writerRenderOffset[0], 0);
  assert.ok(Math.abs(writerRenderOffset[1] - 10.92) < 1e-9);
  assert.deepEqual(seatedRoleBodyRenderOffset('archivist', [96, 194], [96, 136], 0.86), [18, -8.120000000000001]);
  assert.deepEqual(scaledCoworkerHitArea([-50, -80, 100, 120], 0.86, [18, -8.120000000000001]), [-25, -76.92, 86, 103.2]);
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
        setPosition(x, y) { this.position = [x, y]; return this; },
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

  scene.coworkerContracts = { writer: { role: 'writer', frameSize: [176, 208], anchor: [88, 194], deskDock: { renderRegistrationPoint: [88, 103] }, animations: { idle: { frameSize: [176, 208], anchor: [88, 194], frames: [0], static: true } } } };
  scene.textures = { exists: () => true };
  const writer = scene.makeAnimal(9, 8, { role: 'writer' }, '小鼠', false);
  assert.equal(writer.getByName('body').scale, SEATED_ROLE_RENDER_SCALE.writer);
  assert.deepEqual(writer.getByName('body').origin, [0.5, 194 / 208]);
  assert.ok(Math.abs(writer.getByName('body').position[1] - 10.92) < 1e-9);
});

function n4MoleScene() {
  const scene = new OfficeScene(), actions = [];
  const body = { on(){}, getData(){return true;}, anims:{pause(){},resume(){}} };
  const person = { role:'steward',home:[960,310],active:false,localEligible:true,activitySource:'local',localAction:'idle',localActionIndex:0,
    statusText:{text:'',setText(v){this.text=v;}},sprite:{x:960,y:310,getByName(){return body;},setAlpha(){return this;},setPosition(x,y){this.x=x;this.y=y;return this;},setDepth(){return this;}} };
  scene.people=new Map([['steward',person]]);scene.coworkerContracts={steward:stewardV6Contract(V6_INTEGRATION,MOLE_MANIFEST,MOLE_ACTIONS,MOLE_ROUTE,ROOM)};
  scene.time={now:0};scene.player={x:0,y:0};scene.reducedMotion=false;scene.scale={height:800};scene.syncRoleDebug=()=>{};
  scene.tweens={add(config){return {...config,stop(){this.stopped=true;},pause(){},resume(){}};},killTweensOf(){}};
  scene.setPersonAction=(p,action,source)=>{actions.push({action,source});p.localAction=action;};
  scene.initializeStewardRoutine();scene.setTask({colleagues:[{id:'steward',works:[]}]});
  return {scene,person,actions};
}

test('N4 local scene: real work arriving during leisure returns along completed legs, without book props or teleport',()=>{
  const {scene,person,actions}=n4MoleScene();scene.time.now=90001;scene.updateStewardRoutine(scene.time.now);
  const routine=scene.stewardRoutine;assert.equal(routine.phase,'outbound');assert.equal(routine.leisure,true);assert.equal(actions.some(a=>a.action.includes('carry')||a.action.includes('books')),false);
  const first=routine.tween;scene.setTask({colleagues:[{id:'steward',works:[{status:'working'}]}]});
  assert.equal(routine.tween,first);assert.deepEqual([person.sprite.x,person.sprite.y],person.home);assert.equal(routine.returnRequested,true);
  first.onComplete();assert.equal(routine.phase,'returning');assert.notDeepEqual([person.sprite.x,person.sprite.y],person.home);
  while(routine.tween) routine.tween.onComplete();assert.deepEqual([person.sprite.x,person.sprite.y],person.home);assert.equal(person.localAction,'working');assert.equal(routine.phase,'waiting');
});

test('N4 local scene: waiting or disconnected blocks leisure; reduced motion stops movement while keeping state',()=>{
  const {scene,person}=n4MoleScene();scene.time.now=90001;
  scene.setTask({colleagues:[{id:'steward',works:[{status:'completed'},{status:'waiting'}]}]});scene.updateStewardRoutine(scene.time.now);assert.equal(scene.stewardRoutine.phase,'waiting');assert.equal(person.statusText.text,'等待其他工作');
  scene.setTask({colleagues:[{id:'steward',works:[]}],disconnected:true});scene.updateStewardRoutine(scene.time.now);assert.equal(scene.stewardRoutine.phase,'waiting');assert.equal(person.statusText.text,'状态待确认');
  scene.setTask({colleagues:[{id:'steward',works:[]}]});scene.updateStewardRoutine(scene.time.now);const tween=scene.stewardRoutine.tween;assert.ok(tween);
  scene.setTask({colleagues:[{id:'steward',works:[]}]},{reducedMotion:true});assert.equal(tween.stopped,true);assert.equal(scene.stewardRoutine.phase,'waiting');assert.deepEqual([person.sprite.x,person.sprite.y],person.home);assert.equal(person.active,false);
});

test('N4 asset contract: optional reviewed mole work/sleep sheets are retained and sleep never replaces work',()=>{
  const action={...MOLE_ACTIONS['wait-empty'],frameCount:4,frameDurationsMs:[250,250,250,250],loop:true};
  const contract=stewardV6Contract(V6_INTEGRATION,MOLE_MANIFEST,{...MOLE_ACTIONS,working:action,sleeping:action},MOLE_ROUTE,ROOM);
  assert.equal(contract.animations.working.static,undefined);assert.deepEqual(contract.localActions,['sleeping']);
  const {scene,person}=n4MoleScene();scene.coworkerContracts.steward=contract;scene.time.now=70000;scene.updateLocalCoworkers(scene.time.now);assert.equal(person.localAction,'sleeping');
  scene.setTask({colleagues:[{id:'steward',works:[{status:'working'}]}]});assert.equal(person.localAction,'working');scene.updateLocalCoworkers(200000);assert.equal(person.localAction,'working');
});

test('N4 reviewed mole sheets: real transition callbacks connect idle, sleep, work and rest at valid four-frame boundaries',()=>{
 const runtimeRoot=new URL('../../art/office-playable-v1/rest-states-v6/steward-n4/',import.meta.url);
 const root=existsSync(new URL('manifest.json',runtimeRoot))?runtimeRoot:new URL('../../asset-additions/art/office-playable-v1/rest-states-v6/steward-n4/',import.meta.url);
 const manifests=Object.fromEntries(['working','sleeping','enter-working','exit-working','enter-sleeping','exit-sleeping'].map(action=>[action,JSON.parse(readFileSync(new URL(`${action}/manifest.json`,root),'utf8'))]));
 const contract=bindStewardStates(stewardV6Contract(V6_INTEGRATION,MOLE_MANIFEST,MOLE_ACTIONS,MOLE_ROUTE,ROOM),manifests);
 assert.deepEqual(coworkerTransitionSafeFrames('working','work-to-rest',coworkerAnimationSpec(contract,'steward','working')),[0]);assert.deepEqual(contract.localActions,['sleeping']);
 const callbacks=new Map(),played=[];const body={anims:{currentFrame:{textureFrame:0}},frame:{name:0},texture:{key:''},getData(){return true;},setOrigin(){return this;},play(key){played.push(key);return this;},once(event,cb){callbacks.set(event,cb);},stop(){this.stopped=true;return this;},setTexture(key){this.texture.key=key;return this;},setFrame(){return this;}};
 const person={role:'steward',localAction:'idle',active:false,activitySource:'local',sprite:{getByName(){return body;},setInteractive(){return this;}}};const scene=new OfficeScene();scene.people=new Map([['steward',person]]);scene.coworkerContracts={steward:contract};scene.time={now:0};scene.syncRoleDebug=()=>{};scene.reducedMotion=false;
 scene.setPersonAction(person,'sleeping','local');assert.equal(person.localAction,'idle-to-sleep');callbacks.get('animationcomplete-steward-idle-to-sleep')();assert.equal(person.localAction,'sleeping');
 person.active=true;scene.setPersonAction(person,'working','task');assert.equal(person.localAction,'sleep-to-idle');callbacks.get('animationcomplete-steward-sleep-to-idle')();scene.updateCoworkerTransitions();assert.equal(person.localAction,'rest-to-work');callbacks.get('animationcomplete-steward-rest-to-work')();assert.equal(person.localAction,'working');
 person.active=false;scene.setPersonAction(person,'idle','local');assert.equal(person.localAction,'work-to-rest');callbacks.get('animationcomplete-steward-work-to-rest')();assert.equal(person.localAction,'idle');
 scene.setPersonAction(person,'working','task');callbacks.get('animationcomplete-steward-rest-to-work')();scene.reducedMotion=true;scene.setPersonAction(person,'working','task',true);assert.equal(body.stopped,true);assert.equal(body.texture.key,'coworker-steward-n4-working');assert(played.includes('steward-working'));assert(played.includes('steward-sleeping'));
});

test('历史V6搬书只使用完整保存的pre-scene-v10地图；当前侧椅另测实际新路线', async () => {
  const { walkableFoot } = await import('../public/office-game.js?movement-regression');
  const fixture = new URL('./fixtures/historical-office-before-scene-v10/', import.meta.url);
  const oldRoom = JSON.parse(readFileSync(new URL('room-manifest.json', fixture), 'utf8'));
  const oldFloor = JSON.parse(readFileSync(new URL('floor-extension-manifest.json', fixture), 'utf8'));
  assert.equal(oldRoom.revision, 'concept-runtime-v4-complete-2');
  assert.equal(oldRoom.blockedPolygons.some(({id})=>id==='steward-station'),true);
  const legacyRoom = normalizeRoomContract(oldRoom, oldFloor);
  const route = stewardV6Contract(V6_INTEGRATION, MOLE_MANIFEST, MOLE_ACTIONS, MOLE_ROUTE, legacyRoom).steward.routeContract;
  for (const direction of ['outbound', 'return']) for (const leg of stewardRouteLegs(route, direction)) {
    const count = Math.ceil(Math.hypot(leg.to[0]-leg.from[0], leg.to[1]-leg.from[1])/4);
    for (let i=0;i<=count;i++) assert.equal(walkableFoot(legacyRoom, leg.from[0]+(leg.to[0]-leg.from[0])*i/count, leg.from[1]+(leg.to[1]-leg.from[1])*i/count), true, JSON.stringify({direction,leg,i,count}));
  }
});

test('MQ sleeping has no timer wake and reduced motion preserves its authored stable frame', async () => {
  const { bindQualityStates, stableCoworkerFrame } = await import('../public/office-game.js?movement-regression');
  const contract = { role:'writer', revision:'base', animations:{} };
  bindQualityStates(contract, { id:'fixture-contract-only', frameSize:[176,208], anchor:[88,194], states:{ sleeping:{frameIndices:[2,3], staticFrameIndex:3, frameDurationsMs:[300,500], loop:true}, idle:{frameIndices:[0,1],staticFrameIndex:0,loop:true}, working:{frameIndices:[0,1],staticFrameIndex:1,loop:true} } });
  assert.equal(stableCoworkerFrame(coworkerAnimationSpec(contract,'writer','sleeping')),3);
  const {scene,person}=n4MoleScene(); person.role='writer'; person.localAction='idle'; person.nextLocalActionAt=0;
  scene.people=new Map([['writer',person]]);scene.coworkerContracts={writer:contract};
  scene.updateLocalCoworkers(1); assert.equal(person.localAction,'sleeping'); assert.equal(person.nextLocalActionAt,Infinity);
  scene.updateLocalCoworkers(100000); assert.equal(person.localAction,'sleeping');
  assert.throws(()=>bindQualityStates({role:'writer',revision:'base',animations:{}},{id:'bad',frameSize:[1,1],anchor:[0,0],states:{sleeping:{frameIndices:[1],staticFrameIndex:0}}}),/Invalid stable frame/);
});

test('MQ stationary or resting steward feet block overlap while the same scene keeps adjacent exits open', () => {
  const runtime=movementScene(); runtime.scene.playerCell={x:15,y:13};
  const steward={sprite:{x:496,y:448}};runtime.scene.people=new Map([['steward',steward]]);
  for(const phase of ['waiting','resting','outbound','returning','completed']) {runtime.scene.stewardRoutine={phase};assert.equal(runtime.scene.canOccupyCell(15,13),false,phase);assert.equal(runtime.scene.canOccupyCell(14,13),true,phase);}
});

test('MQ player depth follows its actual in-between position, with no destination-depth jump', () => {
  const runtime=movementScene();runtime.scene.playerCell={x:15,y:13};runtime.player.setDepth(448);
  runtime.scene.moveToCell(15,12);assert.equal(runtime.player.depth,448);
  runtime.player.y=432;runtime.tween.onUpdate();assert.equal(runtime.player.depth,432);
  runtime.player.y=416;runtime.tween.onComplete();assert.equal(runtime.player.depth,416);
});

test('MQ repeated target events leave one transition listener; latest intent defeats a stale callback', async () => {
  const {bindQualityStates}=await import('../public/office-game.js?movement-regression');
  const base={frameIndices:[0,1],frameDurationsMs:[120,120],staticFrameIndex:0,loop:true};
  const contract=bindQualityStates({role:'writer',revision:'base',animations:{}},{id:'fixture-contract-only',frameSize:[176,208],anchor:[88,194],states:{idle:{...base},working:{...base},sleeping:{...base},'enter-sleeping':{...base,loop:false},'exit-sleeping':{...base,loop:false}}});
  let plays=0, subscriptions=0; const callbacks=new Map();
  const body={anims:{currentFrame:{textureFrame:0}},frame:{name:0},texture:{key:''},getData(){return true;},setOrigin(){return this;},play(){plays++;return this;},once(event,callback){subscriptions++;callbacks.set(event,callback);},off(event){callbacks.delete(event);},stop(){return this;},setTexture(){return this;},setFrame(){return this;}};
  const person={role:'writer',localAction:'idle',active:false,activitySource:'local',sprite:{getByName(){return body;},setInteractive(){return this;}}};
  const scene=new OfficeScene();scene.people=new Map([['writer',person]]);scene.coworkerContracts={writer:contract};scene.syncRoleDebug=()=>{};scene.time={now:0};
  scene.setPersonAction(person,'sleeping','local');const obsolete=callbacks.get('animationcomplete-writer-idle-to-sleep');
  for(let i=0;i<10;i++)scene.setPersonAction(person,'sleeping','local');assert.equal(plays,1);assert.equal(subscriptions,1);
  scene.setPersonAction(person,'working','task');assert.equal(person.afterTransition,null);
  obsolete();assert.equal(person.localAction,'working');scene.updateCoworkerTransitions();
  assert.equal(person.localAction,'working'); assert.equal(person.desiredAction,'working'); const generation=person.actionGeneration;
  obsolete();assert.equal(person.localAction,'working');assert.equal(person.actionGeneration,generation);
});


test('MQ queued transition retains its final intent after completion and reduced-motion toggles', async () => {
  const {bindQualityStates}=await import('../public/office-game.js?movement-regression');
  const base={frameIndices:[0,1],frameDurationsMs:[120,120],staticFrameIndex:0,safeSwitchFrameIndices:[0],loop:true};
  const contract=bindQualityStates({role:'writer',revision:'base',animations:{}},{id:'fixture-contract-only',frameSize:[176,208],anchor:[88,194],states:{idle:{...base},working:{...base},sleeping:{...base},'enter-working':{...base,loop:false},'exit-working':{...base,loop:false}}});
  const callbacks=new Map();
  const body={anims:{currentFrame:{textureFrame:1}},frame:{name:1},texture:{key:''},getData(){return true;},setOrigin(){return this;},play(){return this;},once(event,callback){callbacks.set(event,callback);},off(event){callbacks.delete(event);},stop(){return this;},setTexture(key){this.texture.key=key;return this;},setFrame(frame){this.frame.name=frame;return this;}};
  const sprite={x:100,y:100,getByName(){return body;},setAlpha(){return this;},setInteractive(){return this;}};
  const person={role:'writer',localAction:'working',desiredAction:'working',active:true,activitySource:'task',home:[100,100],sprite,statusText:{setText(){}}};
  const scene=new OfficeScene();scene.people=new Map([['writer',person]]);scene.coworkerContracts={writer:contract};scene.syncRoleDebug=()=>{};scene.moveCoworker=()=>{};scene.time={now:0};scene.scale={height:800};scene.motionPreference={matches:false};scene.reducedMotion=false;
  const idleTask={colleagues:[{id:'writer',works:[]}]};
  scene.setTask(idleTask);
  assert.equal(person.pendingAction.action,'work-to-rest'); assert.equal(person.desiredAction,'sleeping');
  body.anims.currentFrame.textureFrame=0;
  scene.updateCoworkerTransitions();
  assert.equal(person.localAction,'work-to-rest'); assert.equal(person.desiredAction,'sleeping');
  callbacks.get('animationcomplete-writer-work-to-rest')();
  assert.equal(person.localAction,'idle'); assert.equal(person.desiredAction,'sleeping');
  scene.setTask(idleTask,{reducedMotion:true});
  assert.equal(person.localAction,'sleeping'); assert.equal(body.texture.key,'coworker-writer-v8-sleeping');
  scene.setTask(idleTask,{reducedMotion:false});
  assert.equal(person.localAction,'sleeping'); assert.equal(person.desiredAction,'sleeping');
});

test('MQ first steward stroll precedes sleep; later stroll deadlines never wake a sleeping colleague', () => {
  const {scene,person}=n4MoleScene();
  assert.ok(scene.stewardRoutine.nextAt < person.nextLocalActionAt, 'awake leisure must have an actual opportunity before the first sleep deadline');
  scene.time.now=scene.stewardRoutine.nextAt+1;scene.updateStewardRoutine(scene.time.now);
  assert.equal(scene.stewardRoutine.phase,'outbound');assert.equal(scene.stewardRoutine.leisure,true);
  scene.stewardRoutine.tween=null;scene.stewardRoutine.phase='waiting';scene.stewardRoutine.nextAt=0;
  person.localAction='sleeping';person.nextLocalActionAt=Infinity;
  scene.updateStewardRoutine(500000);assert.equal(scene.stewardRoutine.phase,'waiting');assert.equal(person.localAction,'sleeping');
});

test('MQ build binds every declared v8 role sheet and rejects a damaged pack, while absent pack preserves the old build', async (t) => {
  const fs=await import('node:fs/promises'),path=await import('node:path'),os=await import('node:os'),crypto=await import('node:crypto');
  const {conversationSourceBuild}=await import('../../omo-pilot/server.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'irixi-v8-build-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(path.join(root,'source.js'),'unchanged-code');
  const build=()=>conversationSourceBuild(['source.js'],root);
  assert.equal(await build(),crypto.createHash('sha256').update('unchanged-code').digest('hex'),'no pack must retain the exact legacy byte hash');
  const pack=path.join(root,'art/office-playable-v1/motion-quality-v8');await fs.mkdir(pack,{recursive:true});
  await assert.rejects(build,/动画 v8 资源包缺损.*manifest.json/);
  const top={id:'fixture',roles:{archivist:{manifest:'archive/manifest.json'},newRole:{manifest:'new-role/manifest.json'}}};
  const writeJson=(name,value)=>fs.writeFile(path.join(pack,name),JSON.stringify(value));
  await writeJson('manifest.json',top);
  for(const folder of ['archive','new-role']) {await fs.mkdir(path.join(pack,folder,'states/sleeping'),{recursive:true});await writeJson(`${folder}/manifest.json`,{states:{sleeping:{spritesheet:'states/sleeping/sheet.png'}}});await fs.writeFile(path.join(pack,folder,'states/sleeping/sheet.png'),`fixture-sheet-${folder}`);}
  const initial=await build();assert.equal(await build(),initial,'same declared bytes have stable order');
  for(const folder of ['archive','new-role']) {
    const file=path.join(pack,folder,'states/sleeping/sheet.png'),previous=await fs.readFile(file);await fs.appendFile(file,'changed');assert.notEqual(await build(),initial,`${folder} sheet bytes must affect actual sourceBuild`);await fs.writeFile(file,previous);
  }
  await fs.writeFile(path.join(pack,'unreferenced.png'),'unrelated-art');assert.equal(await build(),initial,'unreferenced art is not swept into the build');
  await fs.unlink(path.join(pack,'new-role/states/sleeping/sheet.png'));await assert.rejects(build,/动画 v8 资源包缺损.*sheet.png/);
  await fs.writeFile(path.join(pack,'new-role/states/sleeping/sheet.png'),'fixture-sheet-new-role');assert.equal(await build(),initial);
  await writeJson('new-role/manifest.json',{states:{sleeping:{spritesheet:'../../outside.png'}}});await assert.rejects(build,/非法相对路径/);
  await writeJson('new-role/manifest.json',{states:{sleeping:{spritesheet:'/outside.png'}}});await assert.rejects(build,/非法相对路径/);
  await writeJson('new-role/manifest.json',{states:{sleeping:{spritesheet:'states/sleeping/sheet.png'}}});
  await fs.writeFile(path.join(root,'outside.png'),'outside');await fs.unlink(path.join(pack,'new-role/states/sleeping/sheet.png'));await fs.symlink(path.join(root,'outside.png'),path.join(pack,'new-role/states/sleeping/sheet.png'));await assert.rejects(build,/越界|包内普通文件/);
  await fs.unlink(path.join(pack,'new-role/manifest.json'));await assert.rejects(build,/动画 v8 资源包缺损.*manifest.json/);
});


// Burrow v9: registered scene methods, animation callbacks, route interruption, and collision pause.
function sprite(x = 944, y = 1054) {
  const listeners = new Map();
  return {
    x, y, visible: true, plays: [], stops: 0, listeners,
    setVisible(value) { this.visible = value; return this; },
    setPosition(px, py) { this.x = px; this.y = py; return this; },
    setDepth(value) { this.depth = value; return this; },
    setOrigin() { return this; }, setInteractive() { return this; },
    setTexture(value) { this.texture = value; return this; },
    setFrame(value) { this.frame = value; return this; },
    play(value) { this.plays.push(value); return this; },
    stop() { this.stops++; return this; },
    on(event, callback) { listeners.set(event, callback); return this; },
    once(event, callback) { listeners.set(event, callback); return this; },
    off(event, callback) { if (listeners.get(event) === callback) listeners.delete(event); return this; },
    complete(action) { const event = `animationcomplete-steward-${action}`; const callback = listeners.get(event); assert.ok(callback, event); listeners.delete(event); callback(); },
  };
}

function fixture() {
  const scene = new OfficeScene();
  const actor = sprite(), base = sprite(), front = sprite(), body = sprite(960, 1120);
  const person = { role: 'steward', home: [960, 1120], renderDepth: 1120, sprite: body, active: false, statusText: { text: '休息中' } };
  scene.people = new Map([['steward', person]]);
  scene.stewardBurrow = { x: 944, y: 1054, manifest: { states: Object.fromEntries(['burrow-enter','burrow-sleep','burrow-emerge','burrow-peek','burrow-retreat','burrow-exit-work'].map((action) => [action, { staticFrameIndex: 0 }])) }, actor, base, front, action: null, generation: 0, listener: null, previewUntil: 0, workbench: false, tween: null, targetPoint: null, advance: null, pauseReasons: new Set() };
  const tweens = [];
  scene.tweens = { add(config) { config.pause = () => { config.paused = true; }; config.resume = () => { config.paused = false; }; tweens.push(config); return config; }, killTweensOf(target) { for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].targets === target) tweens.splice(i, 1); } };
  const finishTweens = () => { while (tweens.length) { const item = tweens.shift(); item.targets.setPosition(item.x, item.y); item.onComplete(); } };
  scene.reducedMotion = false;
  scene.time = { now: 100 };
  const workActions = [];
  scene.setPersonAction = (_person, action) => { workActions.push(action); };
  return { scene, actor, base, body, person, workActions, finishTweens, tweens };
}

test('旧包可在工位上方或下方往返，身体显示首帧就使用当前脚点深度', () => {
  // Both are synthetic compatibility cases; the new authored map owns its upper-hole coordinates.
  for (const y of [1054, 1210]) {
    const { scene, body, person, workActions, tweens, finishTweens } = fixture();
    Object.assign(scene.stewardBurrow, { x:944, y, workbench:true });
    const hole = [944,y];
    body.setVisible(false).setDepth(person.home[1]);
    scene.walkStewardBetweenBurrowAndWork(true);
    assert.equal(workActions.at(-1), y < person.home[1] ? 'walk-empty-down' : 'walk-empty-up');
    assert.deepEqual([body.x, body.y], hole);
    assert.equal(body.depth, y, 'depth is correct before any tween onUpdate');
    assert.equal(tweens[0].y, person.home[1]);
    finishTweens();
    assert.deepEqual([body.x, body.y], person.home);
    assert.equal(workActions.at(-1), 'working');
    scene.walkStewardBetweenBurrowAndWork(false);
    assert.equal(workActions.at(-1), 'walk-empty-left', 'first return leg follows its actual horizontal target');
    assert.equal(body.depth, person.home[1]);
    finishTweens();
    assert.deepEqual([body.x, body.y], hole);
    assert.equal(body.visible, false);
    assert.equal(scene.stewardBurrow.action, 'burrow-enter');
  }
});

test('inside, click to emerge, repeat click, close to retreat use one actual animation listener per transition', () => {
  const { scene, actor, body, person } = fixture();
  scene.syncStewardBurrow(person, false, 'idle', {});
  assert.equal(scene.stewardBurrow.action, 'burrow-sleep');
  assert.equal(body.visible, false);
  scene.syncStewardBurrow(person, false, 'idle', { engagedRole: 'steward' });
  assert.equal(scene.stewardBurrow.action, 'burrow-emerge');
  const plays = actor.plays.length;
  for (let i = 0; i < 10; i++) scene.syncStewardBurrow(person, false, 'idle', { engagedRole: 'steward' });
  assert.equal(actor.plays.length, plays);
  actor.complete('burrow-emerge');
  assert.equal(scene.stewardBurrow.action, 'burrow-peek');
  scene.syncStewardBurrow(person, false, 'idle', {});
  assert.equal(scene.stewardBurrow.action, 'burrow-retreat');
  actor.complete('burrow-retreat');
  assert.equal(scene.stewardBurrow.action, 'burrow-sleep');
});

test('real work interrupts emerge and reaches the existing working body; stale callback cannot return to peek', () => {
  const { scene, actor, body, person, workActions, finishTweens } = fixture();
  scene.syncStewardBurrow(person, false, 'idle', {});
  scene.syncStewardBurrow(person, false, 'idle', { engagedRole: 'steward' });
  const stale = actor.listeners.get('animationcomplete-steward-burrow-emerge');
  person.active = true;
  scene.syncStewardBurrow(person, true, 'working', {});
  assert.equal(scene.stewardBurrow.action, 'burrow-emerge');
  assert.equal(body.visible, false);
  stale();
  assert.equal(scene.stewardBurrow.action, 'burrow-emerge');
  actor.complete('burrow-emerge');
  assert.equal(scene.stewardBurrow.action, 'burrow-exit-work');
  actor.complete('burrow-exit-work');
  assert.equal(scene.stewardBurrow.action, 'walking-to-work');
  finishTweens();
  assert.equal(body.visible, true);
  assert.equal(scene.stewardBurrow.action, 'working');
  assert.equal(workActions.at(-1), 'working');
});

test('cancelled or stopping work during emerge retargets its real completion without replaying or walking to work', () => {
  for (const [active, status] of [[false, 'idle'], [true, 'stopping']]) {
    const { scene, actor, person, tweens } = fixture();
    scene.syncStewardBurrow(person, false, 'idle', {});
    scene.syncStewardBurrow(person, true, 'working', {});
    assert.equal(scene.stewardBurrow.action, 'burrow-emerge');
    const oldComplete = actor.listeners.get('animationcomplete-steward-burrow-emerge');
    const plays = actor.plays.length;
    scene.syncStewardBurrow(person, active, status, { engagedRole: 'steward' });
    assert.equal(actor.plays.length, plays, 'the current emerge frames keep playing');
    oldComplete();
    assert.equal(scene.stewardBurrow.action, 'burrow-emerge', 'old work continuation is stale');
    actor.complete('burrow-emerge');
    assert.equal(scene.stewardBurrow.action, 'burrow-peek');
    assert.equal(tweens.length, 0);
  }
});

test('reduced motion holds authored stable sleep/peek; old home is free and the hole remains occupied', () => {
  const { scene, body, person, actor } = fixture();
  scene.reducedMotion = true;
  scene.syncStewardBurrow(person, false, 'idle', {}, true);
  assert.equal(scene.stewardBurrow.action, 'burrow-sleep');
  assert.equal(actor.texture, 'coworker-steward-v8-burrow-sleep');
  scene.syncStewardBurrow(person, false, 'idle', { engagedRole: 'steward' }, true);
  assert.equal(scene.stewardBurrow.action, 'burrow-peek');
  assert.equal(actor.plays.length, 0);
  scene.grid = { isWalkable() { return true; } };
  assert.equal(body.visible, false);
  assert.equal(scene.canOccupyCell(29, 32), false, 'hole foot cell');
  assert.equal(scene.canOccupyCell(30, 34), true, 'old standing spot');
});

test('burrow contract reuses a single frame size and preserves legacy action bindings', () => {
  const make = (frameCount = 2) => ({ frameCount, frameIndices: Array.from({ length: frameCount }, (_, i) => i), staticFrameIndex: 0, loop: true });
  const states = Object.fromEntries(['working','idle','exit-working','enter-working','enter-sleeping','sleeping','exit-sleeping','burrow-ground','burrow-front','burrow-enter','burrow-sleep','burrow-emerge','burrow-peek','burrow-retreat','burrow-exit-work'].map((action) => [action, make()]));
  const contract = bindQualityStates({ role: 'steward', revision: 'v8', animations: {} }, { id: 'burrow-v9-test', frameSize: [256,256], anchor: [128,220], states });
  assert.equal(contract.animations.working.textureKey, 'coworker-steward-v8-working');
  assert.equal(contract.animations['burrow-peek'].textureKey, 'coworker-steward-v8-burrow-peek');
  assert.deepEqual(contract.animations.working.anchor, [128,220]);
});

test('hole click and keyboard entry open the original steward conversation immediately', async () => {
  const { scene, person } = fixture();
  dispatched.length = 0;
  const events = dispatched;
  scene.stewardBurrow.workbench = true;
  scene.syncStewardBurrow = () => {};
  scene.stewardRoutine = { phase: 'waiting' };
  scene.presence = {};
  scene.nearestWalkable = () => ({ x: 28, y: 34 });
  scene.playerCell = { x: 10, y: 10 };
  scene.startPath = async () => true;
  scene.people = new Map([['steward', person]]);
  const pending = scene.talkTo(person);
  assert.equal(events[0].type, 'irixi:coworker');
  assert.equal(events[0].detail.role, 'steward');
  assert.ok(scene.stewardBurrow.previewUntil > scene.time.now);
  await pending;
  createOfficeBridge(scene).talkToRole('steward');
  assert.equal(events.at(-1).detail.role, 'steward');
});

test('work ends by walking through the clear corridor to the hole; a new task reverses without teleport', () => {
  const { scene, actor, body, person, tweens, finishTweens, workActions } = fixture();
  scene.stewardBurrow.workbench = true;
  scene.stewardBurrow.action = 'working';
  scene.syncStewardBurrow(person, false, 'idle', {});
  assert.equal(scene.stewardBurrow.action, 'walking-to-hole');
  assert.equal(body.visible, true);
  assert.equal(tweens[0].x, 944);
  assert.equal(tweens[0].y, 1120);
  tweens[0].targets.setPosition(950, 1120); // a new task arrives between the two waypoints
  person.active = true;
  scene.syncStewardBurrow(person, true, 'working', {});
  assert.equal(scene.stewardBurrow.action, 'walking-to-work');
  finishTweens();
  assert.deepEqual([body.x, body.y], person.home);
  assert.equal(workActions.at(-1), 'working');
  person.active = false;
  scene.syncStewardBurrow(person, false, 'idle', {});
  finishTweens();
  assert.equal(body.visible, false);
  assert.equal(scene.stewardBurrow.action, 'burrow-enter');
  actor.complete('burrow-enter');
  assert.equal(scene.stewardBurrow.action, 'burrow-sleep');
});

test('leaving workbench cancels the burrow tween and stale completion before legacy routing resumes', () => {
  const { scene, body, person, tweens } = fixture();
  scene.stewardBurrow.workbench = true; scene.stewardBurrow.action = 'working';
  scene.walkStewardBetweenBurrowAndWork(false);
  const stale = tweens[0].onComplete;
  scene.scale = { height: 800 }; scene.task = { colleagues: [{ id: 'steward', works: [] }] };
  scene.stewardRoutine = { phase: 'waiting' }; scene.moveCoworker = () => {};
  person.statusText.setText = () => {}; body.setAlpha = () => body;
  scene.setTask({ status: 'idle', team: { agents: [] }, workItems: [] }, {});
  assert.equal(tweens.length, 0);
  assert.equal(scene.stewardBurrow.workbench, false);
  assert.equal(scene.stewardBurrow.advance, null);
  assert.equal(scene.stewardBurrow.base.visible, false);
  assert.equal(scene.stewardBurrow.front.visible, false);
  assert.equal(body.visible, true);
  stale();
  assert.equal(scene.stewardBurrow.action, null);
});

test('player on the burrow route blocks departure; collision and conversation pause then release the same tween', () => {
  const { scene, person, tweens } = fixture();
  scene.stewardBurrow.workbench = true; scene.stewardBurrow.action = 'working';
  scene.player = { x: 944, y: 1120 }; scene.presence = {};
  scene.walkStewardBetweenBurrowAndWork(false);
  assert.equal(tweens.length, 0, 'do not start through a player already on the segment');
  scene.player.x = 700; scene.player.y = 1400;
  scene.updateStewardBurrowMotionPause();
  assert.equal(tweens.length, 1);
  scene.player.x = 950; scene.player.y = 1120;
  tweens[0].onUpdate();
  assert.equal(tweens[0].paused, true);
  assert.equal(scene.stewardBurrow.pauseReasons.has('collision'), true);
  scene.player.x = 700; scene.player.y = 1400;
  scene.updateStewardBurrowMotionPause();
  assert.equal(tweens[0].paused, false);
  scene.pauseStewardBurrowMotion('conversation');
  scene.presence = { engagedRole: 'steward' };
  scene.updateStewardBurrowMotionPause();
  assert.equal(tweens[0].paused, true);
  scene.presence = {}; scene.stewardBurrow.previewUntil = 0;
  scene.updateStewardBurrowMotionPause();
  assert.equal(tweens[0].paused, false);
  scene.pauseStewardBurrowMotion('conversation');
  scene.player.x = 950; scene.player.y = 1120;
  scene.updateStewardBurrowMotionPause();
  assert.equal(tweens[0].paused, true, 'clearing conversation cannot resume into a player who arrived meanwhile');
  scene.player.x = 700; scene.player.y = 1400;
  scene.updateStewardBurrowMotionPause();
  assert.equal(tweens[0].paused, false);
  assert.equal(person.sprite.visible, true);
});

test('external status label follows the visible burrow, then returns to the work body', () => {
  const { scene, body } = fixture();
  let position;
  body.labels = { setPosition(x, y) { position = [x, y]; } };
  scene.stewardBurrow.workbench = true; body.visible = false;
  scene.syncCharacterLayers();
  assert.deepEqual(position, [944, 1054]);
  body.visible = true;
  scene.syncCharacterLayers();
  assert.deepEqual(position, [960, 1120]);
});

test('上移坐姿后的龙猫标签移到自身工位左侧，其他标签仍跟随实际角色或洞口', () => {
  const scene = new OfficeScene(); const positions = new Map();
  scene.people = new Map(PEOPLE.map(({ role }) => {
    const [x, y] = EXTENDED_ROOM.workstations[role].home;
    return [role, { role, sprite: { x, y, visible: true, labels: { setPosition(px, py) { positions.set(role, [px, py]); } } } }];
  }));
  scene.syncCharacterLayers();
  assert.deepEqual(positions.get('reviewer'), [EXTENDED_ROOM.workstations.reviewer.home[0]-180, EXTENDED_ROOM.workstations.reviewer.home[1]-15]);
  assert.ok(positions.get('reviewer')[0] + 70 < EXTENDED_ROOM.workstations.archivist.home[0] - 50, 'label rectangle clears the colleague below');
  for (const role of ['writer', 'researcher', 'archivist', 'steward']) assert.deepEqual(positions.get(role), EXTENDED_ROOM.workstations[role].home);
  const mole = scene.people.get('steward'); mole.sprite.x = 700; mole.sprite.y = 1250;
  scene.syncCharacterLayers(); assert.deepEqual(positions.get('steward'), [700, 1250]);
  mole.sprite.visible = false; scene.stewardBurrow = { workbench: true, x: 944, y: 1060 };
  scene.syncCharacterLayers(); assert.deepEqual(positions.get('steward'), [944, 1060]);
});

test('burrow approach stops beside the visible peek while its foot cell stays blocked for player movement', () => {
  const { scene, body, person } = fixture();
  scene.stewardBurrow.workbench = true;
  body.visible = false;
  person.active = false;
  scene.playerCell = { x: 29, y: 33 }; // real click observation: player at [944,1088]
  scene.grid = { isWalkable() { return true; } };
  const destination = scene.nearestWalkable(person);
  const footX = destination.x * 32 + 16;
  assert.ok(Math.abs(footX - scene.stewardBurrow.x) >= 116, 'visible bodies have horizontal clearance');
  assert.equal(scene.canOccupyCell(29, 32), false, 'the hole foot cannot be occupied');
  assert.equal(scene.canStep(0, -1), false, 'manual movement uses the same hole occupancy');
});

function seatingFixture() {
  const f = fixture();
  const body = sprite();
  f.body.getByName = () => body;
  f.scene.coworkerContracts = { steward: {
    seating: { approachPoint: [...f.person.home], routeFromBurrow: [[944, 1100], [960, 1100]], sitAction: 'sit-down', standAction: 'stand-up' },
    animations: { 'sit-down': { loop: false }, 'stand-up': { loop: false } },
  } };
  f.scene.stewardBurrow.workbench = true;
  f.scene.presence = {};
  return { ...f, seatBody: body };
}

test('动作座点只平移一次，坐姿与走路分别注册且非法坐点被拒绝', () => {
  const make = () => ({ role: 'steward', revision: 'fixture', animations: {}, deskDock: { roomOrigin: [0, 810], worldAnchor: [960, 1120] } });
  const state = { frameCount: 1, staticFrameIndex: 0, loop: true };
  const manifest = { id: 'seat-test', frameSize: [256,256], anchor: [128,220], seating: { approachPoint: [960,310] }, states: {
    idle: state, 'walk-empty-down': state,
    working: { ...state, placement: { scale: 1, registrationPoint: [100,160], worldPoint: [985,280] } },
  } };
  const contract = bindQualityStates(make(), manifest);
  assert.deepEqual(contract.seating.approachPoint, [960,1120]);
  assert.deepEqual(contract.animations.working.placement.worldPoint, [985,1090]);
  assert.deepEqual(manifest.states.working.placement.worldPoint, [985,280], 'binding never mutates author coordinates');
  const seated = coworkerRenderTransform(contract, [128,220], 'working');
  assert.deepEqual(seated.offset, [53,30]);
  assert.deepEqual(coworkerRenderTransform(contract, [128,220], 'walk-empty-down').offset, [0,0], 'walking returns to actual feet');
  assert.deepEqual(scaledCoworkerHitArea([-10,-20,20,30], seated.scale, seated.offset), [43,10,20,30]);
  const invalid = structuredClone(manifest); invalid.states.working.placement.scale = 0;
  assert.throws(() => bindQualityStates(make(), invalid), /Invalid placement/);
  const body = { visible: true, frame: { name: 0 }, anims: {}, getData() { return true; }, setOrigin() { return this; }, setScale(value) { this.scale = value; return this; }, setPosition(x,y) { this.position = [x,y]; return this; }, stop() { return this; }, setTexture() { return this; }, setFrame() { return this; }, play() { return this; } };
  const person = { role: 'steward', localAction: null, sprite: { getByName() { return body; }, setInteractive() { return this; } } };
  const scene = new OfficeScene(); scene.coworkerContracts = { steward: contract }; scene.syncRoleDebug = () => {};
  scene.setPersonAction(person, 'working', 'local', true, null, true);
  assert.deepEqual(body.position, [53,30]);
  scene.setPersonAction(person, 'walk-empty-down', 'local', true, null, true);
  assert.deepEqual(body.position, [0,0], 'actual state switch clears the seated render offset before walking');
  const looping = structuredClone(manifest); looping.states['sit-down'] = { ...state };
  assert.throws(() => bindQualityStates(make(), looping), /dedicated one-shot/);

});

test('上方洞沿作者拐点到椅旁后先下坐，工作结束先起身再原路回洞', () => {
  const { scene, body, person, seatBody, workActions, tweens, finishTweens } = seatingFixture();
  assert.ok(scene.stewardBurrow.y < person.home[1], 'synthetic upper-hole fixture, not the superseded below-chair target');
  body.visible = false;
  scene.walkStewardBetweenBurrowAndWork(true);
  assert.equal(workActions.at(-1), 'walk-empty-down');
  assert.deepEqual([tweens[0].x, tweens[0].y], [944,1100]);
  finishTweens();
  assert.equal(scene.stewardBurrow.action, 'sitting-down');
  assert.equal(workActions.at(-1), 'sit-down');
  assert.equal(workActions.includes('working'), false, 'arrival alone cannot start seated work');
  seatBody.complete('sit-down');
  assert.equal(scene.stewardBurrow.action, 'working');
  assert.equal(workActions.at(-1), 'working');
  scene.syncStewardBurrow(person, false, 'idle', {});
  assert.equal(scene.stewardBurrow.action, 'standing-up');
  assert.equal(tweens.length, 0, 'no route movement while chair supports the body');
  seatBody.complete('stand-up');
  assert.equal(scene.stewardBurrow.action, 'walking-to-hole');
  assert.deepEqual([tweens[0].x, tweens[0].y], [960,1100]);
  assert.equal(workActions.at(-1), 'walk-empty-up');
  finishTweens();
  assert.deepEqual([body.x,body.y], [944,1054]);
  assert.equal(scene.stewardBurrow.action, 'burrow-enter');
});

test('下坐中停止不复活工作，起身中接活只在脚重新承重后重新入座，旧回调失效', () => {
  const { scene, person, body, seatBody, workActions, tweens, finishTweens } = seatingFixture();
  body.visible = false; scene.walkStewardBetweenBurrowAndWork(true); finishTweens();
  const sitComplete = seatBody.listeners.get('animationcomplete-steward-sit-down');
  for (let i=0;i<5;i++) scene.syncStewardBurrow(person, true, 'working', {});
  assert.equal(workActions.filter((a) => a === 'sit-down').length, 1, 'duplicate work notifications do not restart descent');
  scene.syncStewardBurrow(person, true, 'stopping', {});
  seatBody.complete('sit-down');
  assert.equal(workActions.includes('working'), false);
  assert.equal(scene.stewardBurrow.action, 'standing-up');
  sitComplete();
  assert.equal(scene.stewardBurrow.action, 'standing-up');
  const standComplete = seatBody.listeners.get('animationcomplete-steward-stand-up');
  scene.syncStewardBurrow(person, true, 'working', {});
  assert.equal(tweens.length, 0);
  seatBody.complete('stand-up');
  assert.equal(scene.stewardBurrow.action, 'sitting-down');
  standComplete();
  assert.equal(scene.stewardBurrow.action, 'sitting-down');
  seatBody.complete('sit-down');
  assert.equal(workActions.at(-1), 'working');
});

test('下坐或起身切减少动态不等待动画回调，且撤销旧身体监听', () => {
  for (const active of [true,false]) {
    const { scene, person, body, seatBody, finishTweens } = seatingFixture();
    body.visible = false; scene.walkStewardBetweenBurrowAndWork(true); finishTweens();
    if (!active) { scene.syncStewardBurrow(person, false, 'idle', {}); seatBody.complete('sit-down'); }
    scene.reducedMotion = true;
    scene.syncStewardBurrow(person, active, active ? 'working' : 'stopped', {}, true);
    assert.equal(scene.stewardBurrow.action, active ? 'working' : 'burrow-sleep');
    assert.equal(seatBody.listeners.size, 0);
    assert.equal(scene.stewardBurrow.finishSeating, null);
  }
});

test('作者路线中途接活从实际所在段返回，不回洞口或穿过未完成拐角', () => {
  const { scene, body, person, tweens } = seatingFixture();
  body.setPosition(...person.home);
  scene.stewardBurrow.action = 'working';
  scene.walkStewardBetweenBurrowAndWork(false);
  body.setPosition(960,1110);
  scene.syncStewardBurrow(person, true, 'working', {});
  assert.equal(tweens.length, 1);
  assert.deepEqual([tweens[0].x,tweens[0].y], person.home);
  assert.deepEqual([body.x,body.y],[960,1110]);
});


test('单直梯边缘按完整既有脚底落在梯面，不能只让中心踩在栏杆旁', () => {
  const room = { walkablePolygons: [[[0,0],[32,0],[32,64],[0,64]]], blockedRects: [] };
  assert.equal(walkableFoot(room,16,32), true);
  assert.equal(walkableFoot(room,5,32), false, 'the left sole would leave the actual stair edge');
  assert.equal(walkableFoot(room,16,62), false, 'the front sole would step beyond the platform');
});

test('当前单直梯可经实际update移动步进上下往返，沿边拒绝越栏且途中取消保留安全脚点', async () => {
  const source = new OfficeScene(); source.room = EXTENDED_ROOM;
  const matrix = source.makeCollisionMap();
  for (const [from,to] of [[[720,1152],[720,480]],[[720,480],[720,1152]]]) {
    const runtime = obstacleMovementScene(matrix,footToCell(...from,TILE)); const scene=runtime.scene;
    scene.room=EXTENDED_ROOM;
    for (const method of ['updateCoworkerTransitions','updateStewardMotionPause','updateStewardBurrowMotionPause','updateStewardRoutine','syncCharacterLayers']) scene[method]=()=>{};
    const target=footToCell(...to,TILE);
    const path=await scene.grid.findPath(scene.playerCell,target);
    assert.ok(path?.length);
    let time=200;
    for (const next of path.slice(1)) {
      const dx=next.x-scene.playerCell.x,dy=next.y-scene.playerCell.y;
      scene.keys.A.isDown=dx<0; scene.keys.D.isDown=dx>0;
      scene.keys.W.isDown=dy<0; scene.keys.S.isDown=dy>0;
      scene.update(time);time+=200;
      assert.equal(scene.stepInProgress,true);
      const tween=runtime.tween;
      tween.targets.setPosition(tween.x,tween.y);tween.onUpdate();tween.onComplete();
      assert.deepEqual([scene.player.x,scene.player.y],[next.x*TILE+TILE/2,(next.y+1)*TILE]);
    }
    assert.deepEqual(scene.playerCell,target);
  }
  const runtime=obstacleMovementScene(matrix,footToCell(1232,704,TILE));
  runtime.scene.room=EXTENDED_ROOM;
  runtime.scene.moveToCell(...Object.values(footToCell(1232,736,TILE)),{keepWalking:true});
  runtime.player.setPosition(1232,716);runtime.scene.cancelWalk();
  assert.equal(runtime.scene.stepInProgress,false);
  assert.equal(walkableFoot(EXTENDED_ROOM,runtime.player.x,runtime.player.y),true, 'cancel settles on a legal stair foot, never beyond a rail');
  assert.ok(Math.abs(runtime.player.y-704)<=32, 'cancel remains within the current one-cell step');
  assert.equal(runtime.scene.canOccupyCell(...Object.values(footToCell(1200,768,TILE))),false);
});

test('当前母版正常指针入口规划完整上下楼，栏杆外无路会结束而不保留walking', async () => {
  const source=new OfficeScene();source.room=EXTENDED_ROOM;
  const runtime=obstacleMovementScene(source.makeCollisionMap(),footToCell(720,1152,TILE));
  const scene=runtime.scene;scene.room=EXTENDED_ROOM;
  scene.cameras={main:{getWorldPoint(x,y){return{x,y};}}};
  await scene.walkToPointer({x:720,y:479});
  assert.equal(host.dataset.lastClickAccepted,'true');
  assert.ok(scene.path.some(({x,y})=>x*TILE+16>1150&&(y+1)*TILE===640));
  scene.cancelWalk();
  assert.equal(await scene.startPath(footToCell(1040,672,TILE),{kind:'floor'}),false);
  assert.equal(scene.path.length,0);assert.equal(scene.pathPending,false);
});


test('洞内头部按每态source actorHitArea响应，探头与睡头换形不留旧框且不移用容器负坐标', async () => {
  const NativeRectangle=(await import('phaser/src/geom/rectangle/index.js')).default;
  const oldRectangle=Phaser.Geom.Rectangle;Phaser.Geom.Rectangle=NativeRectangle;
  try {
    const {scene,actor}=fixture();
    actor.setInteractive=function(rect,callback){this.input={hitArea:rect,hitAreaCallback:callback};return this;};
    scene.stewardBurrow.manifest.states['burrow-sleep'].actorHitArea=[85,170,92,49];
    scene.stewardBurrow.manifest.states['burrow-peek'].actorHitArea=[79,150,98,70];
    scene.setStewardBurrowAction('burrow-sleep');
    const input=actor.input;
    assert.equal(input.hitAreaCallback(input.hitArea,128,160),false);
    scene.setStewardBurrowAction('burrow-peek');
    assert.equal(actor.input,input);
    assert.equal(input.hitAreaCallback(input.hitArea,128,160),true,'visible upper head is clickable outside the old hole-base rectangle');
    assert.deepEqual([input.hitArea.x,input.hitArea.y,input.hitArea.width,input.hitArea.height],[79,150,98,70]);
    assert.equal(input.customHitArea,true);
  } finally {Phaser.Geom.Rectangle=oldRectangle;}
});


test('当前侧椅只阻挡真实腿脚和柜体，保留洞背窄口与椅侧实际往返路线', () => {
  const manifest=JSON.parse(readFileSync(new URL('../../art/office-playable-v1/motion-quality-v8/steward-seated-v12/manifest.json',import.meta.url),'utf8'));
  const origin=[EXTENDED_ROOM.groundFloorX,EXTENDED_ROOM.groundFloorY];
  const route=[manifest.worldFoot,...manifest.seating.routeFromBurrow,manifest.seating.approachPoint].map(p=>p.map((v,i)=>v+origin[i]));
  const expected={ 'steward-desk-near-leg-v3':[1059,357,15,20], 'steward-desk-drawers-floor-v3':[1111,347,96,36], 'steward-desk-far-leg-v3':[1031,277,15,17], 'steward-chair-rear-foot-v3':[960,346,9,12], 'steward-chair-near-foot-v3':[1008,350,10,13] };
  for(const [id,local] of Object.entries(expected)) {
    const r=EXTENDED_ROOM.blockedRects.find(r=>r.id===id); assert.ok(r,id);
    const rect=local.map((v,i)=>i<2?v+origin[i]:v); assert.deepEqual(r.rect,rect,'real source feet must not grow to satisfy a test');
    assert.equal(walkableFoot(EXTENDED_ROOM,rect[0]+rect[2]/2,rect[1]+rect[3]/2),false,id);
  }
  assert.equal(EXTENDED_ROOM.blockedRects.some(({id})=>['steward-station','steward-chair-floor-v12','steward-chair-floor-v3'].includes(id)),false,'open knee/ground is not covered by the old broad footprint');
  assert.equal(walkableFoot(EXTENDED_ROOM,...route.at(-1)),true,'current approach is open');
  assert.equal(walkableFoot(EXTENDED_ROOM,880,774),false,'shelf floor remains closed outside pocket');
  assert.equal(walkableFoot(EXTENDED_ROOM,950,774),false,'wood pocket does not extend into chair/right shelves');
  for (const points of [route,[...route].reverse()]) for (let j=1;j<points.length;j++) {
    const [a,b]=[points[j-1],points[j]], n=Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/4);
    for(let i=0;i<=n;i++) assert.equal(walkableFoot(EXTENDED_ROOM,a[0]+(b[0]-a[0])*i/n,a[1]+(b[1]-a[1])*i/n),true,JSON.stringify({a,b,i}));
  }
});

function supportFixture() {
  const f=seatingFixture(), c=f.scene.coworkerContracts.steward;
  c.seating.approachPoint=[965,900]; c.seating.logicalFootPoint=[994,860];
  c.animations['sit-down']={frameIndices:[0,1,2,3,4],seatContactFrame:3};
  c.animations['stand-up']={frameIndices:[0,1,2,3,4],groundContactFrame:2};
  f.person.renderDepth=860; f.body.setPosition(965,900); f.scene.stewardBurrow.wantsWork=true;
  return f;
}

test('support帧切换只改深度和地面占位，坐下/起身不移动已注册容器；陈旧update与complete无效',()=>{
 const {scene,person,body,seatBody}=supportFixture(),burrow=scene.stewardBurrow;
 scene.sitStewardAtWork();
 const oldUpdate=seatBody.listeners.get('animationupdate'),oldComplete=seatBody.listeners.get('animationcomplete-steward-sit-down');
 assert.equal(body.depth,900); assert.equal(scene.playerMovementObstacles().at(-1),body);
 oldUpdate(null,{textureFrame:2});assert.equal(body.depth,900);
 oldUpdate(null,{textureFrame:3});assert.equal(body.depth,860);
 assert.deepEqual(scene.playerMovementObstacles().at(-1),{x:994,y:860});
 assert.deepEqual([body.x,body.y],[965,900],'pelvis/render registration did not become the logical foot');
 seatBody.complete('sit-down'); assert.equal(burrow.action,'working');assert.equal(seatBody.listeners.size,0);
 burrow.wantsWork=false;scene.standStewardFromWork();
 const groundUpdate=seatBody.listeners.get('animationupdate');
 assert.equal(body.depth,860);assert.deepEqual(scene.playerMovementObstacles().slice(-2),[{x:994,y:860},{x:965,y:900}]);
 groundUpdate(null,{textureFrame:1});assert.equal(body.depth,860);
 groundUpdate(null,{textureFrame:2});assert.equal(body.depth,900);assert.equal(scene.playerMovementObstacles().at(-1),body);
 oldUpdate(null,{textureFrame:3});oldComplete();assert.equal(body.depth,900);assert.equal(burrow.action,'standing-up');
 assert.deepEqual([body.x,body.y],[965,900]);
 scene.clearStewardBurrowListener();assert.equal(seatBody.listeners.size,0);
});

test('坐稳释放椅侧；玩家占下座点时保持座承重，离开后起身；新工作取消等待且旧回调不复活',()=>{
 const {scene,body,person,seatBody}=supportFixture(),burrow=scene.stewardBurrow;
 scene.showStewardBurrowWork();assert.deepEqual(scene.playerMovementObstacles().at(-1),{x:994,y:860});
 scene.player={x:965,y:900};burrow.wantsWork=false;scene.standStewardFromWork();
 assert.equal(burrow.action,'waiting-to-stand');assert.equal(body.depth,860);assert.equal(seatBody.listeners.size,0);
 assert.deepEqual([body.x,body.y],[965,900]);
 scene.updateStewardBurrowMotionPause();assert.equal(burrow.action,'waiting-to-stand');
 scene.syncStewardBurrow(person,true,'working',{});assert.equal(burrow.action,'working');
 burrow.wantsWork=false;scene.standStewardFromWork();scene.player.x=700;scene.updateStewardBurrowMotionPause();
 assert.equal(burrow.action,'standing-up');assert.equal(body.depth,860);
 scene.reducedMotion=true;scene.syncStewardBurrow(person,false,'idle',{},true);
 assert.equal(seatBody.listeners.size,0);assert.equal(burrow.action,'burrow-sleep');assert.equal(burrow.seatSupported,false);
});

test('下座地脚被占时复用坐稳中性帧，真实动作注册与前臂层同步，容器不挪到碰撞点',()=>{
 const {scene,person,body,seatBody}=supportFixture();
 const state={frameCount:5,frameIndices:[0],staticFrameIndex:0,static:true,loop:true,frontSpritesheet:'same-working-front.png',placement:{scale:1,registrationPoint:[128,186],worldPoint:[985,291]}};
 scene.coworkerContracts.steward=bindQualityStates({role:'steward',revision:'fixture',animations:{},deskDock:{roomOrigin:[0,550],worldAnchor:[960,860],frontLayerDepthY:942}}, {id:'neutral-support-fixture',frameSize:[256,256],anchor:[128,220],seating:{approachPoint:[965,350],logicalFootPoint:[994,310]},states:{'seated-idle':state}});
 Object.assign(seatBody,{visible:true,frame:{name:4},anims:{},alpha:1,getData(){return true;},setScale(){return this;},setPosition(x,y){this.position=[x,y];return this;},setTexture(key){this.texture={key};return this;},setFrame(i){this.frame={name:i};return this;}});
 const front={setVisible(v){this.visible=v;return this;},setTexture(t){this.texture=t;return this;},setFrame(i){this.frame=i;return this;},setOrigin(){return this;},setScale(){return this;},setPosition(x,y){this.position=[x,y];return this;},setDepth(){return this;},setAlpha(){return this;}};
 person.frontSprite=front;body.alpha=1;scene.syncRoleDebug=()=>{};scene.setPersonAction=OfficeScene.prototype.setPersonAction;
 scene.stewardBurrow.seatSupported=true;scene.stewardBurrow.wantsWork=false;scene.player={x:965,y:900};
 scene.standStewardFromWork();scene.syncCoworkerFrontLayer(person);
 assert.equal(scene.stewardBurrow.action,'waiting-to-stand');assert.equal(person.localAction,'seated-idle');
 assert.deepEqual([body.x,body.y],[965,900]);assert.deepEqual(seatBody.position,[20,-25]);assert.equal(seatBody.frame.name,0);
 assert.deepEqual(front.position,[985,875]);assert.equal(front.frame,0);assert.equal(front.visible,true);assert.equal(front.texture,'coworker-steward-v8-seated-idle-front');
 assert.deepEqual(scene.playerMovementObstacles().at(-1),{x:994,y:860});
});

function neutralAggregateFixture() {
 const f=supportFixture(),{scene,person,body,seatBody}=f;
 const placement={scale:1,registrationPoint:[128,186],worldPoint:[985,291]};
 const neutral={frameCount:5,frameIndices:[0],staticFrameIndex:0,static:true,loop:true,frontSpritesheet:'same-working-front.png',placement};
 const transition={...neutral,static:false,loop:false,frameIndices:[0,1,2,3,4]};
 scene.coworkerContracts.steward=bindQualityStates({role:'steward',revision:'aggregate-fixture',animations:{},deskDock:{roomOrigin:[0,550],worldAnchor:[960,860],frontLayerDepthY:942}}, {id:'aggregate-support-fixture',frameSize:[256,256],anchor:[128,220],seating:{approachPoint:[965,350],logicalFootPoint:[994,310]},states:{'seated-idle':neutral,working:{...transition,loop:true},'sit-down':{...transition,seatContactFrame:3},'stand-up':{...transition,groundContactFrame:2}}});
 Object.assign(seatBody,{visible:true,frame:{name:0},anims:{},alpha:1,getData(){return true;},setScale(){return this;},setPosition(x,y){this.position=[x,y];return this;},setTexture(key){this.texture={key};return this;},setFrame(i){this.frame={name:i};return this;}});
 body.setAlpha=function(a){this.alpha=a;return this;};person.statusText.setText=function(t){this.text=t;return this;};
 const requests=[];scene.syncRoleDebug=()=>{};scene.setPersonAction=(...args)=>{requests.push(args[1]);return OfficeScene.prototype.setPersonAction.apply(scene,args);};
 scene.player={x:965,y:900};scene.stewardBurrow.action='working';scene.stewardBurrow.seatSupported=true;
 return {...f,requests};
}

test('正常聚合中仍有working则保持工作；仅stopping转坐稳等待且状态即时更新，连续轮询不重设姿态或监听',()=>{
 const {scene,person,body,seatBody,requests}=neutralAggregateFixture();
 const task=(...statuses)=>({colleagues:[{id:'steward',works:statuses.map(status=>({status}))}]});
 scene.setTask(task('stopping','working'));
 assert.equal(person.localAction,'working');assert.equal(person.statusText.text,'正在工作');assert.equal(scene.stewardBurrow.wantsWork,true);
 scene.setTask(task('stopping'));
 assert.equal(person.statusText.text,'正在停止');assert.equal(scene.stewardBurrow.wantsWork,false);
 assert.equal(scene.stewardBurrow.action,'waiting-to-stand');assert.equal(person.localAction,'seated-idle');
 const count=requests.length,generation=person.actionGeneration,stops=seatBody.stops;
 for(let i=0;i<20;i++){scene.setTask(task('stopping'));scene.updateStewardBurrowMotionPause();}
 assert.equal(requests.length,count);assert.equal(person.actionGeneration,generation);assert.equal(seatBody.stops,stops);assert.equal(seatBody.listeners.size,0);
 assert.deepEqual([body.x,body.y],[965,900]);assert.equal(body.depth,860);
 // A mismatched external action is corrected once; subsequent waits are stable again.
 person.localAction='working';scene.updateStewardBurrowMotionPause();assert.equal(requests.length,count+1);assert.equal(person.localAction,'seated-idle');
 scene.updateStewardBurrowMotionPause();assert.equal(requests.length,count+1);
 scene.player.x=700;scene.updateStewardBurrowMotionPause();assert.equal(scene.stewardBurrow.action,'standing-up');
 const completion=seatBody.listeners.get('animationcomplete-steward-stand-up'),support=seatBody.listeners.get('animationupdate');
 for(let i=0;i<10;i++){scene.setTask(task('stopping'));scene.updateStewardBurrowMotionPause();}
 assert.equal(seatBody.listeners.get('animationcomplete-steward-stand-up'),completion);assert.equal(seatBody.listeners.get('animationupdate'),support);
});

test('工作显示回调若读到最新stopping，优先坐稳中性帧；旧包缺此帧沿用idle兼容',()=>{
 const {scene,person,requests}=neutralAggregateFixture();
 scene.setTask({colleagues:[{id:'steward',works:[{status:'stopping'}]}]});
 scene.showStewardBurrowWork('working');
 assert.equal(person.localAction,'seated-idle');assert.equal(requests.at(-1),'seated-idle');assert.equal(person.statusText.text,'正在停止');
 delete scene.coworkerContracts.steward.animations['seated-idle'];
 scene.setPersonAction=(_person,action)=>requests.push(action);
 scene.showStewardBurrowWork('working');assert.equal(requests.at(-1),'idle');
});

test('真实candidate3坐姿点击框排除976889透明地面，头胸仍可点；转姿只用真实动作alpha union',async()=>{
 const measured=JSON.parse(readFileSync(new URL('./fixtures/mole-seat-candidate3-hitarea.json',import.meta.url),'utf8'));
 assert.equal(measured.sourceManifestSha256,'16256f03d6ec0d132c2494721980b8eb023af608c2e05523a9a5a5d449d5486a');
 const NativeRectangle=(await import('phaser/src/geom/rectangle/index.js')).default,oldRectangle=Phaser.Geom.Rectangle;Phaser.Geom.Rectangle=NativeRectangle;
 try {
  const {scene,person,body}=neutralAggregateFixture();
  body.setInteractive=function(shape,callback){this.input={hitArea:shape,hitAreaCallback:callback};return this;};
  const bind=m=>bindQualityStates({role:'steward',revision:'actual-candidate3',animations:{},deskDock:{roomOrigin:[0,550],worldAnchor:[960,860],frontLayerDepthY:942}},m);
  scene.coworkerContracts.steward=bind(measured.manifest);
  scene.setPersonAction(person,'working','task',true,null,true);
  assert.deepEqual(person.hitArea,[-108,-245,256,256],'reproduce unpatched actual canvas fallback');
  assert.equal(body.input.hitAreaCallback(body.input.hitArea,976-body.x,889-body.y),true);
  const patched=structuredClone(measured.manifest);
  for(const [name,patch]of Object.entries(measured.patch.states))Object.assign(patched.states[name],patch);
  scene.coworkerContracts.steward=bind(patched);const sameInput=body.input;
  for(const action of ['working','seated-idle','sit-down','stand-up']){
   scene.setPersonAction(person,action,'task',true,null,true);
   assert.equal(body.input,sameInput,'state update preserves input and existing event registration');
   const contains=(x,y)=>body.input.hitAreaCallback(body.input.hitArea,x-body.x,y-body.y);
   if(['working','seated-idle'].includes(action))assert.equal(contains(976,889),false,action+' releases empty chair-front ground');
   const contract=scene.coworkerContracts.steward,spec=coworkerAnimationSpec(contract,'steward',action),transform=coworkerRenderTransform(contract,spec.anchor,action);
   const world=([x,y])=>[body.x+transform.offset[0]+(x-spec.anchor[0])*transform.scale,body.y+transform.offset[1]+(y-spec.anchor[1])*transform.scale];
   for(const probe of measured.checks[action].opaqueInteriorProbes){assert.ok(probe.alpha>128);assert.equal(contains(...world(probe.canvas)),true,action+probe.part+probe.frame);}
   for(const [left,top,right,bottom]of measured.checks[action].frameBoxes){
    assert.equal(contains(...world([left,top])),true);assert.equal(contains(...world([right-1,bottom-1])),true,'every used transition frame silhouette stays inside action union');
   }
  }
  assert.deepEqual(patched.states['burrow-peek'].actorHitArea,measured.manifest.states['burrow-peek'].actorHitArea,'positive source-canvas burrow field is untouched');
 }finally{Phaser.Geom.Rectangle=oldRectangle;}
});

test('R04 正常状态映射的鼹鼠unknown与断连只清醒探头，原无工作则回洞睡',()=>{
  const {scene,person,body,actor}=fixture();scene.scale={height:800};body.setAlpha=()=>body;person.statusText.setText=function(v){this.text=v;};
  const task=(works=[])=>({colleagues:[{id:'steward',works}]});
  scene.setTask(task());assert.equal(scene.stewardBurrow.action,'burrow-sleep');
  for(const state of [{...task(),disconnected:true},task([{status:'unknown'}]),task([{status:'stopped'}])]) {
    scene.setTask(state);if(scene.stewardBurrow.action==='burrow-emerge')actor.complete('burrow-emerge');
    assert.equal(person.localEligible,false);assert.equal(scene.stewardBurrow.action,'burrow-peek');
  }
  scene.setTask(task());actor.complete('burrow-retreat');assert.equal(scene.stewardBurrow.action,'burrow-sleep');
});

test('R04 旧往返完成回调不能清空新方向正在运行的tween',()=>{
  const {scene,body,tweens}=fixture();scene.stewardBurrow.workbench=true;body.setVisible(false);scene.walkStewardBetweenBurrowAndWork(true);
  const old=tweens[0].onComplete;body.setPosition(944,1080);scene.walkStewardBetweenBurrowAndWork(false);
  const current=scene.stewardBurrow.tween;assert.ok(current);old();assert.equal(scene.stewardBurrow.tween,current);assert.equal(scene.stewardBurrow.action,'walking-to-hole');
});
