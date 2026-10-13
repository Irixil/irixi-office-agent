/*
 * Scene/input structure adapted from agent-office Game.ts and pathfinding
 * wrapper adapted from Grid.ts at b00de4e8615c02605be7b90694dccda55d5d8168.
 * See THIRD_PARTY_NOTICES.md and third_party/agent-office-MIT.txt.
 */
import { animationCycleDuration, canStepWithoutCornerCutting, coworkerRuntimeState, crispZoom, feetOverlap, footToCell, isMovementKey, isSafeSwitchFrame, isWalkInProgress, pointToSegmentDistance, worldToCell } from './office-geometry.js';

export const TILE = 32;
const WALK_CYCLE_MS = 480;
const WORLD_W = 1440;
const WORLD_H = 810;
const ASSET_ROOT = '/assets/office-playable-v1/';
const ROOM_ROOT = `${ASSET_ROOT}concept-runtime-v4/`;
const MOTION_ROOT = `${ASSET_ROOT}motion-repair-v6/`;
const MOTION_INTEGRATION_KEY = 'office-motion-v6-integration';
const REST_ROOT = `${ASSET_ROOT}rest-states-v6/`;
const REST_INTEGRATION_KEY = 'office-rest-v6-integration';
const CONTINUITY_ROOT = `${REST_ROOT}continuity-repair-v3/`;
const CONTINUITY_INTEGRATION_KEY = 'office-rest-continuity-v3-integration';
const MOLE_ROUTE_SPEED = 140;

export const PEOPLE = [
  { role: 'researcher', name: '仓鼠研究员', species: 'hamster' },
  { role: 'writer', name: '小鼠写作员', species: 'mouse' },
  { role: 'reviewer', name: '龙猫审阅员', species: 'chinchilla' },
  { role: 'steward', name: '鼹鼠事务员', species: 'mole' },
  { role: 'archivist', name: '花枝鼠档案员', species: 'fancy-rat' },
];
const FALLBACK_SPECIES = { researcher: 'hamster', writer: 'mole', reviewer: 'hamster', steward: 'mole', archivist: 'hamster' };

export function pointInPolygon(px, py, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i]; const [xj, yj] = points[j];
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function normalizeRoomContract(manifest) {
  const [width, height] = manifest.world.logicalSize;
  const workstations = Object.fromEntries(Object.entries(manifest.workstations).map(([role, item]) => [role, {
    home: [...item.characterFootAnchor], interactionPoint: [...item.interactionPoint], frontLayerId: item.frontLayerId,
  }]));
  return {
    width, height,
    columns: Math.ceil(width / TILE), rows: Math.ceil(height / TILE),
    background: manifest.world.background,
    foregroundItems: manifest.foregroundItems.map((item) => ({ ...item, pivot: [...item.pivot], collisionRect: [...item.collision.rect] })),
    walkablePolygons: manifest.walkablePolygons.map((points) => points.map((point) => [...point])),
    blockedRects: manifest.blockedPolygons.map((item) => ({ id: item.id, rect: [...item.rect] })),
    workstations,
    spawn: [...manifest.spawnPoints.irixi],
    revision: manifest.revision,
  };
}

function frontDepthForRole(room, role) {
  const frontLayerId = room.workstations[role]?.frontLayerId;
  return room.foregroundItems.find((item) => item.id === frontLayerId)?.depthY;
}

export function seatedV6Contract(integration, role, manifest, room, restIntegration = null, restManifest = null, continuityIntegration = null, transitionManifest = null, restOverride = null) {
  const binding = integration.seatedRoles[role];
  const action = binding.action;
  const animation = {
    sheet: manifest.spritesheet,
    frameSize: [...manifest.frameSize],
    anchor: [...manifest.anchor],
    frameIndices: [...manifest.frameIndices],
    frameDurationsMs: [...binding.frameDurationsMs],
    fallbackFrameDurationMs: manifest.fallbackFrameDurationMs,
    safeSwitchFrameIndices: [...binding.safeSwitchFrameIndices],
    hitArea: [...manifest.hitArea],
    loop: true,
  };
  const restBinding = restIntegration?.roles?.[role];
  const restAnimations = restManifest && restBinding ? Object.fromEntries(Object.entries(restManifest.states).map(([state, item]) => [state, {
    sheet: restOverride?.states?.[state]?.spritesheet || restBinding.runtimeStates[state],
    textureKey: restOverride?.states?.[state] ? `coworker-${role}-${state}-continuity-v3` : undefined,
    frameSize: [...restManifest.frameSize],
    anchor: [...restManifest.anchor],
    frameIndices: [...item.keyframeIndices],
    frameDurationsMs: [...(restOverride?.states?.[state]?.frameDurationsMs || item.frameDurationsMs)],
    fallbackFrameDurationMs: item.cycleDurationMs / item.frameCount,
    safeEntryFrameIndices: [...item.safeEntryFrameIndices],
    safeSwitchFrameIndices: [...item.safeExitFrameIndices],
    hitArea: [...manifest.hitArea],
    loop: item.loop,
    returnTo: item.returnTo,
  }])) : null;
  const transitionBinding = continuityIntegration?.transitions?.[role];
  const transitionAnimations = transitionManifest && transitionBinding ? {
    'work-to-rest': {
      sheet: transitionManifest.spritesheet,
      textureKey: `coworker-${role}-work-rest-transition`,
      frameSize: [...transitionManifest.frameSize],
      anchor: [...transitionManifest.anchor],
      frameIndices: transitionBinding.workToRestOrder.slice(1, -1),
      frameDurationsMs: transitionManifest.forwardDurationsMs.slice(1, -1),
      safeSwitchFrameIndices: [],
      hitArea: [...manifest.hitArea],
      loop: false,
      returnTo: 'idle',
      transition: true,
    },
    'rest-to-work': {
      sheet: transitionManifest.spritesheet,
      textureKey: `coworker-${role}-work-rest-transition`,
      frameSize: [...transitionManifest.frameSize],
      anchor: [...transitionManifest.anchor],
      frameIndices: transitionBinding.restToWorkOrder.slice(1, -1),
      frameDurationsMs: transitionManifest.reverseDurationsMs.slice(1, -1),
      safeSwitchFrameIndices: [],
      hitArea: [...manifest.hitArea],
      loop: false,
      returnTo: 'working',
      transition: true,
    },
  } : {};
  const restingFrame = restAnimations?.idle || { ...animation, sharedArtWith: action, frameIndices: [0], frameDurationsMs: [1000], static: true };
  return {
    id: manifest.id,
    revision: manifest.revision,
    role,
    frameSize: [...manifest.frameSize],
    anchor: [...manifest.anchor],
    animations: {
      idle: restingFrame,
      reading: { ...restingFrame, sharedArtWith: restAnimations ? 'idle' : action, frameIndices: [0], frameDurationsMs: [1000], static: true },
      sleeping: restAnimations?.sleeping || { ...restingFrame },
      slack: restAnimations?.slack || { ...restingFrame },
      [action]: animation,
      working: { ...animation, sharedArtWith: action, startFrameIndex: transitionManifest ? 13 : undefined },
      ...transitionAnimations,
    },
    localActions: restAnimations ? ['sleeping', 'slack'] : [],
    restIntegrationId: restAnimations ? restIntegration.id : null,
    continuityIntegrationId: transitionManifest ? continuityIntegration.id : null,
    deskDock: {
      worldAnchor: [...manifest.worldAnchor],
      characterDepthY: manifest.worldAnchor[1],
      frontLayerDepthY: frontDepthForRole(room, role),
      stationPatch: manifest.stationPatch,
    },
  };
}

export function stewardV6Contract(integration, manifest, actionManifests, routeContract, room) {
  const animations = Object.fromEntries(Object.entries(actionManifests).map(([action, item]) => [action, {
    sheet: item.spritesheet,
    frameSize: [...item.frameSize],
    anchor: [...item.anchor],
    frameIndices: Array.from({ length: item.frameCount }, (_, index) => index),
    frameDurationsMs: [...item.frameDurationsMs],
    fallbackFrameDurationMs: item.cycleDurationMs / item.frameCount,
    loop: item.loop,
    returnTo: item.returnTo,
    propOwnershipBeginsFrame: item.propOwnershipBeginsFrame,
    propReleaseAfterFrame: item.propReleaseAfterFrame,
  }]));
  const wait = animations['wait-empty'];
  animations.idle = { ...wait, sharedArtWith: 'wait-empty', frameIndices: [0], frameDurationsMs: [1000], static: true };
  animations.working = { ...wait, sharedArtWith: 'wait-empty', frameIndices: [0], frameDurationsMs: [1000], static: true };
  return {
    id: manifest.id,
    revision: manifest.id,
    role: 'steward',
    frameSize: [...manifest.frameSize],
    anchor: [...manifest.anchor],
    animations,
    localActions: [],
    deskDock: {
      worldAnchor: [...integration.stewardMole.homeWorldFoot],
      characterDepthY: integration.stewardMole.homeWorldFoot[1],
      frontLayerDepthY: frontDepthForRole(room, 'steward'),
    },
    steward: { manifest, routeContract, integration: integration.stewardMole },
  };
}

export function phaserAnimationFrames(spec) {
  return spec.frames.map((frame, index) => ({
    key: spec.textureKey,
    frame,
    duration: spec.frameDurationsMs?.[index] || spec.frameDurationMs,
  }));
}

export function stewardBookOwner(action, frameIndex, currentOwner, propContract) {
  if (action === 'pickup-books' && frameIndex >= propContract.moleOwnsStackFromPickupFrame) return 'mole';
  const shelfTransferFrame = propContract.shelfOwnsStackAfterShelveFrame ?? propContract.shelveFrameCount - 3;
  if (action === 'shelve-books' && frameIndex > shelfTransferFrame) return 'shelf';
  return currentOwner;
}

export function stewardRouteLegs(routeContract, direction) {
  const waypoints = direction === 'outbound' ? routeContract.outboundWaypoints : routeContract.returnWaypoints;
  const directions = direction === 'outbound' ? routeContract.outboundDirections : routeContract.returnDirections;
  const carrying = direction === 'outbound' ? 'carry' : 'empty';
  return directions.map((facing, index) => ({ from: [...waypoints[index]], to: [...waypoints[index + 1]], action: `walk-${carrying}-${facing}` }));
}

export function coworkerAnimationSpec(contract, role, action) {
  let animation = contract?.animations?.[action];
  let isStatic = Boolean(animation?.static);
  if (!animation && action === 'idle' && contract?.baseline?.runtime) {
    const referenceAction = contract.localActions?.[0] || contract.taskDrivenActions?.[0] || Object.keys(contract.animations || {})[0];
    const reference = contract.animations?.[referenceAction];
    if (!reference) return null;
    animation = { frameSize: reference.frameSize, anchor: reference.anchor, hitArea: reference.hitArea, loop: true, returnTo: null };
    isStatic = true;
  }
  if (!animation) return null;
  const frameSize = animation.frameSize || contract.frameSize;
  const anchor = animation.anchor || contract.anchor;
  const ownSheet = Boolean(animation.sheet && animation.sheet !== contract.sheet);
  const textureAction = animation.sharedArtWith || action;
  const textureKey = animation.textureKey || (isStatic && contract?.baseline?.runtime ? `coworker-${role}-baseline` : ownSheet ? `coworker-${role}-${textureAction}` : `coworker-${role}`);
  let frames = isStatic ? [0] : animation.frameIndices || (Array.isArray(animation.frames) ? animation.frames : null);
  if (!frames) {
    if (ownSheet) {
      const count = animation.frameCount || Number(animation.frames) || 1;
      frames = Array.from({ length: count }, (_, index) => index);
    } else {
      const row = Number.isInteger(animation.row) ? animation.row : contract.sheetLayout.rowOrder.indexOf(action);
      const columns = animation.columns || contract.sheetLayout.columnOrder.map((_, index) => index);
      frames = columns.map((column) => row * contract.sheetLayout.columns + column);
    }
  }
  const frameDurationMs = animation.fallbackFrameDurationMs || animation.frameDurationMs || (animation.fps ? 1000 / animation.fps : 160);
  const frameDurationsMs = animation.frameDurationsMs?.length === frames.length ? [...animation.frameDurationsMs] : frames.map(() => frameDurationMs);
  return { animation, frameSize, anchor, textureKey, frames, frameDurationMs, frameDurationsMs, frameRate: 1000 / frameDurationMs, isStatic };
}

export function coworkerHitArea(contract, action = 'idle') {
  const spec = coworkerAnimationSpec(contract, contract?.role || 'role', action);
  const explicit = spec?.animation?.hitArea || contract?.hitArea || contract?.interaction?.hitArea;
  if (explicit) return [...explicit];
  const frameSize = spec?.frameSize || contract?.frameSize || [64, 72];
  const anchor = spec?.anchor || contract?.anchor || [frameSize[0] / 2, frameSize[1]];
  const bounds = contract?.validation?.frames?.map((frame) => frame.visibleBBox).filter(Boolean) || [];
  if (!bounds.length) return [-anchor[0], -anchor[1], frameSize[0], frameSize[1]];
  const left = Math.min(...bounds.map((box) => box[0]));
  const top = Math.min(...bounds.map((box) => box[1]));
  const right = Math.max(...bounds.map((box) => box[2]));
  const bottom = Math.max(...bounds.map((box) => box[3]));
  const padding = 6;
  return [left - anchor[0] - padding, top - anchor[1] - padding, right - left + padding * 2, bottom - top + padding * 2];
}

export function coworkerLocalActions(contract) {
  const configured = contract?.localActions || contract?.behavior?.localActions || [];
  return configured
    .map((item) => typeof item === 'string' ? item : item?.action)
    .filter((action) => action && !['idle', 'working'].includes(action) && contract?.animations?.[action]);
}

export function coworkerTransitionSafeFrames(fromAction, toAction, currentSpec) {
  if (fromAction === 'working' && toAction === 'work-to-rest') return [13];
  if (fromAction === 'idle' && toAction === 'rest-to-work') return [0];
  if (fromAction === 'idle' && toAction === 'working') return [3];
  if (fromAction === 'idle' && ['sleeping', 'slack'].includes(toAction)) return [0, 3];
  if (['sleeping', 'slack'].includes(fromAction) && toAction === 'idle') return [3];
  return currentSpec?.animation?.safeSwitchFrameIndices || [];
}

function localRestDelay(role, initial = false) {
  const roleIndex = Math.max(0, PEOPLE.findIndex((item) => item.role === role));
  return (initial ? 8000 : 10000) + roleIndex * (initial ? 2200 : 1800);
}

export function alignedLocalActionEnd(startTime, contract, role, action) {
  const animation = contract?.animations?.[action];
  if (!animation) return startTime;
  if (!animation.loop) {
    const frameCount = animation.frameIndices?.length || animation.frameCount || Number(animation.frames) || 1;
    const duration = Number(animation.displayDurationMs || animation.cycleDurationMs || (animation.frameDurationMs || animation.fallbackFrameDurationMs || 0) * frameCount);
    return startTime + duration;
  }
  const spec = coworkerAnimationSpec(contract, role, action);
  if (!spec) return startTime;
  const cycleMs = animationCycleDuration(spec.frameDurationsMs, spec.frameDurationMs, spec.frames.length);
  const requested = Number(animation?.displayDurationMs || cycleMs);
  if (spec.isStatic) return startTime + requested;
  return startTime + Math.ceil(requested / cycleMs) * cycleMs;
}

export function isEditableTarget(target) {
  return Boolean(target?.matches?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])')
    || target?.closest?.('[contenteditable]:not([contenteditable="false"])'));
}

const stateLabel = {
  idle: '待命', reading: '整理档案', researching: '核对材料', drafting: '起草成果', reviewing: '独立核对',
  waiting_user: '等待主人确认', completed: '交付完成', failed: '工作受阻', active: '正在工作', replying: '正在回复', done: '已完成',
};

export function createOfficeBridge(scene) {
  return {
    setTask: (task, presence) => scene.setTask(task, presence),
    cancelWalk: () => scene.cancelWalk(),
    talkToRole: (role) => {
      const person = scene.people.get(role);
      if (person) scene.talkTo(person);
    },
    debugSnapshot: () => ({
      player: { ...scene.playerCell },
      walking: isWalkInProgress({ pathPending: scene.pathPending, pathLength: scene.path.length, stepInProgress: scene.stepInProgress, manualMoving: scene.manualMoving }),
      target: scene.walkTarget,
      taskId: scene.task?.id || null,
      motionIntegration: scene.motionIntegration?.id || null,
      restIntegration: scene.restIntegration?.id || null,
      continuityIntegration: scene.continuityIntegration?.id || null,
      roles: [...scene.people.entries()].map(([role, person]) => ({ role, action: person.localAction, pendingAction: person.pendingAction?.action || person.pendingTaskAction?.action || null, pendingThen: person.pendingAction?.then?.action || null, afterTransition: person.afterTransition?.action || null, source: person.actionSource, active: person.active, frame: person.sprite.getByName('body').frame?.name ?? 0, position: [Math.round(person.sprite.x), Math.round(person.sprite.y)] })),
      steward: scene.stewardRoutine ? { phase: scene.stewardRoutine.phase, completed: scene.stewardRoutine.completed, bookOwner: scene.stewardRoutine.bookOwner, paused: [...scene.stewardRoutine.pauseReasons] } : null,
    }),
    scene,
  };
}

class OfficeGrid {
  constructor(matrix) {
    this.matrix = matrix;
    this.finder = new EasyStar.js();
    this.finder.setGrid(matrix);
    this.finder.setAcceptableTiles([0]);
    this.finder.enableDiagonals();
    this.finder.disableCornerCutting();
    this.finder.setIterationsPerCalculation(600);
  }

  isWalkable(x, y) {
    return y >= 0 && y < this.matrix.length && x >= 0 && x < this.matrix[0].length && this.matrix[y][x] === 0;
  }

  findPath(from, to) {
    return new Promise((resolve) => {
      this.finder.findPath(from.x, from.y, to.x, to.y, (path) => resolve(path || null));
      this.finder.calculate();
    });
  }
}

export class OfficeScene extends Phaser.Scene {
  constructor() {
    super('office');
    this.playerCell = { x: 22, y: 17 };
    this.path = [];
    this.walkTarget = null;
    this.people = new Map();
    this.task = null;
    this.lastMoveAt = 0;
    this.manualMoving = false;
    this.playerDirection = 'down';
    this.pathRequestId = 0;
    this.pathPending = false;
    this.stepInProgress = false;
    this.lastRoleDebugAt = 0;
  }

  preload() {
    this.load.json('office-room-manifest', `${ROOM_ROOT}manifest.json`);
    this.load.json('irixi-v4-manifest', `${ROOM_ROOT}characters/irixi/manifest.json`);
    this.load.json(MOTION_INTEGRATION_KEY, `${MOTION_ROOT}integration-manifest.json`);
    this.load.json(REST_INTEGRATION_KEY, `${REST_ROOT}integration-manifest.json`);
    this.load.json(CONTINUITY_INTEGRATION_KEY, `${CONTINUITY_ROOT}integration-manifest.json`);
    this.load.once('filecomplete-json-irixi-v4-manifest', (_key, _type, manifest) => {
      const version = manifest?.revision ? `?v=${encodeURIComponent(manifest.revision)}` : '';
      for (const [direction, file] of Object.entries(manifest?.directions?.runtime || {})) this.load.image(`irixi-${direction}-idle`, `${ROOM_ROOT}characters/irixi/${file}${version}`);
      for (const [name, animation] of Object.entries(manifest?.animations || {})) {
        const direction = name.replace(/^walk/, '').toLowerCase();
        this.load.spritesheet(`irixi-${direction}-walk-sheet`, `${ROOM_ROOT}characters/irixi/${animation.spritesheet}${version}`, { frameWidth: manifest.frameSize[0], frameHeight: manifest.frameSize[1] });
      }
    });
    this.load.once(`filecomplete-json-${MOTION_INTEGRATION_KEY}`, (_key, _type, integration) => {
      const version = `?v=${encodeURIComponent(integration.id)}`;
      for (const [role, binding] of Object.entries(integration.seatedRoles)) {
        const manifestKey = `coworker-${role}-motion-manifest`;
        const directory = binding.manifest.slice(0, binding.manifest.lastIndexOf('/') + 1);
        this.load.json(manifestKey, `${MOTION_ROOT}${binding.manifest}${version}`);
        this.load.once(`filecomplete-json-${manifestKey}`, (_manifestKey, _manifestType, manifest) => {
          this.load.spritesheet(`coworker-${role}-${binding.action}`, `${MOTION_ROOT}${directory}${manifest.spritesheet}${version}`, { frameWidth: manifest.frameSize[0], frameHeight: manifest.frameSize[1] });
          if (manifest.stationPatch?.file) this.load.image(`coworker-${role}-station-patch`, `${MOTION_ROOT}${directory}${manifest.stationPatch.file}${version}`);
        });
      }
      const stewardDirectory = integration.stewardMole.manifest.slice(0, integration.stewardMole.manifest.lastIndexOf('/') + 1);
      this.load.json('coworker-steward-motion-manifest', `${MOTION_ROOT}${integration.stewardMole.manifest}${version}`);
      this.load.json('coworker-steward-route-contract', `${MOTION_ROOT}${integration.stewardMole.routeContract}${version}`);
      this.load.once('filecomplete-json-coworker-steward-motion-manifest', (_manifestKey, _manifestType, manifest) => {
        for (const action of manifest.actions) {
          const actionManifestKey = `coworker-steward-${action.action}-manifest`;
          const actionDirectory = `${stewardDirectory}${action.manifest.slice(0, action.manifest.lastIndexOf('/') + 1)}`;
          this.load.json(actionManifestKey, `${MOTION_ROOT}${stewardDirectory}${action.manifest}${version}`);
          this.load.once(`filecomplete-json-${actionManifestKey}`, (_actionKey, _actionType, actionManifest) => {
            this.load.spritesheet(`coworker-steward-${action.action}`, `${MOTION_ROOT}${actionDirectory}${actionManifest.spritesheet}${version}`, { frameWidth: actionManifest.frameSize[0], frameHeight: actionManifest.frameSize[1] });
          });
        }
        this.load.image('steward-book-stack-desk', `${MOTION_ROOT}${stewardDirectory}${manifest.props.desk}${version}`);
        this.load.image('steward-book-stack-shelf', `${MOTION_ROOT}${integration.stewardMole.propVisibility.shelfPatch}${version}`);
      });
    });
    this.load.once(`filecomplete-json-${REST_INTEGRATION_KEY}`, (_key, _type, integration) => {
      const version = `?v=${encodeURIComponent(integration.id)}`;
      for (const [role, binding] of Object.entries(integration.roles)) {
        const manifestKey = `coworker-${role}-rest-manifest`;
        this.load.json(manifestKey, `${REST_ROOT}${binding.manifest}${version}`);
        this.load.once(`filecomplete-json-${manifestKey}`, (_manifestKey, _manifestType, manifest) => {
          for (const [state, spritesheet] of Object.entries(binding.runtimeStates)) this.load.spritesheet(`coworker-${role}-${state}`, `${REST_ROOT}${spritesheet}${version}`, { frameWidth: manifest.frameSize[0], frameHeight: manifest.frameSize[1] });
        });
      }
    });
    this.load.once(`filecomplete-json-${CONTINUITY_INTEGRATION_KEY}`, (_key, _type, integration) => {
      const version = `?v=${encodeURIComponent(integration.id)}`;
      for (const [role, binding] of Object.entries(integration.transitions)) {
        const manifestKey = `coworker-${role}-continuity-manifest`;
        const directory = binding.manifest.slice(0, binding.manifest.lastIndexOf('/') + 1);
        this.load.json(manifestKey, `${CONTINUITY_ROOT}${binding.manifest}${version}`);
        this.load.once(`filecomplete-json-${manifestKey}`, (_manifestKey, _manifestType, manifest) => {
          this.load.spritesheet(`coworker-${role}-work-rest-transition`, `${CONTINUITY_ROOT}${directory}${manifest.spritesheet}${version}`, { frameWidth: manifest.frameSize[0], frameHeight: manifest.frameSize[1] });
        });
      }
      const overrideKey = 'coworker-archivist-rest-continuity-manifest';
      const overrideDirectory = integration.archivistRestOverride.manifest.slice(0, integration.archivistRestOverride.manifest.lastIndexOf('/') + 1);
      this.load.json(overrideKey, `${CONTINUITY_ROOT}${integration.archivistRestOverride.manifest}${version}`);
      this.load.once(`filecomplete-json-${overrideKey}`, (_manifestKey, _manifestType, manifest) => {
        for (const [state, item] of Object.entries(manifest.states)) this.load.spritesheet(`coworker-archivist-${state}-continuity-v3`, `${CONTINUITY_ROOT}${overrideDirectory}${item.spritesheet}${version}`, { frameWidth: manifest.frameSize[0], frameHeight: manifest.frameSize[1] });
      });
    });
    this.load.once('filecomplete-json-office-room-manifest', (_key, _type, manifest) => {
      const assetVersion = manifest?.revision ? `?v=${encodeURIComponent(manifest.revision)}` : '';
      this.load.image('office-room-base', `${ROOM_ROOT}${manifest.world.background}${assetVersion}`);
      for (const item of manifest.foregroundItems || []) this.load.image(`room-foreground-${item.id}`, `${ROOM_ROOT}${item.file}${assetVersion}`);
    });
    this.load.spritesheet('hamster-sheet', `${ASSET_ROOT}characters/hamster/states.png`, { frameWidth: 64, frameHeight: 72 });
    this.load.spritesheet('mole-sheet', `${ASSET_ROOT}characters/mole/states.png`, { frameWidth: 64, frameHeight: 72 });
  }

  create() {
    this.cameras.main.setBackgroundColor('#120d0a');
    this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const roomManifest = this.cache.json.get('office-room-manifest');
    this.room = normalizeRoomContract(roomManifest);
    this.irixiContract = this.cache.json.get('irixi-v4-manifest');
    this.motionIntegration = this.cache.json.get(MOTION_INTEGRATION_KEY);
    this.restIntegration = this.cache.json.get(REST_INTEGRATION_KEY);
    this.continuityIntegration = this.cache.json.get(CONTINUITY_INTEGRATION_KEY);
    this.coworkerContracts = Object.fromEntries(Object.keys(this.motionIntegration.seatedRoles).map((role) => [role, seatedV6Contract(this.motionIntegration, role, this.cache.json.get(`coworker-${role}-motion-manifest`), this.room, this.restIntegration, this.cache.json.get(`coworker-${role}-rest-manifest`), this.continuityIntegration, this.cache.json.get(`coworker-${role}-continuity-manifest`), role === 'archivist' ? this.cache.json.get('coworker-archivist-rest-continuity-manifest') : null)]));
    const stewardManifest = this.cache.json.get('coworker-steward-motion-manifest');
    const stewardActions = Object.fromEntries(stewardManifest.actions.map(({ action }) => [action, this.cache.json.get(`coworker-steward-${action}-manifest`)]));
    this.coworkerContracts.steward = stewardV6Contract(this.motionIntegration, stewardManifest, stewardActions, this.cache.json.get('coworker-steward-route-contract'), this.room);
    for (const [role, contract] of Object.entries(this.coworkerContracts)) this.room.workstations[role].home = [...contract.deskDock.worldAnchor];
    const coworkerTextures = Object.entries(this.coworkerContracts).flatMap(([role, contract]) => [coworkerAnimationSpec(contract, role, 'idle')?.textureKey, ...Object.keys(contract.animations).map((action) => coworkerAnimationSpec(contract, role, action)?.textureKey), contract.deskDock?.stationPatch?.file ? `coworker-${role}-station-patch` : null]);
    ['office-room-base', ...this.irixiContract.directions.order.map((direction) => `irixi-${direction}-idle`), ...this.irixiContract.directions.order.map((direction) => `irixi-${direction}-walk-sheet`), ...coworkerTextures, 'steward-book-stack-desk', 'steward-book-stack-shelf', ...this.room.foregroundItems.map((item) => `room-foreground-${item.id}`)]
      .filter((key) => this.textures.exists(key))
      .forEach((key) => this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR));
    this.createCoworkerAnimations();
    this.add.image(this.room.width / 2, this.room.height / 2, 'office-room-base').setDepth(-100);
    this.drawStationPatches();
    this.drawStewardProps();
    for (const name of this.irixiContract.directions.order) {
      this.anims.create({ key: `irixi-${name}-idle`, frames: [{ key: `irixi-${name}-idle` }], frameRate: 1, repeat: -1 });
      const animation = this.irixiContract.animations[`walk${name[0].toUpperCase()}${name.slice(1)}`];
      this.anims.create({ key: `irixi-${name}-walk`, frames: this.anims.generateFrameNumbers(`irixi-${name}-walk-sheet`, { start: 0, end: animation.frameCount - 1 }), frameRate: animation.frameCount * 1000 / WALK_CYCLE_MS, repeat: -1 });
    }
    this.drawRoom();
    this.grid = new OfficeGrid(this.makeCollisionMap());
    this.destinationMarker = this.add.circle(0, 0, 6, 0xd6b870, .35).setStrokeStyle(2, 0xffe2a0, .95).setVisible(false);
    this.playerCell = footToCell(this.room.spawn[0], this.room.spawn[1], TILE);
    this.player = this.makeAnimal(this.playerCell.x, this.playerCell.y, 'irixi', 'Irixi', true);
    for (const person of PEOPLE) {
      const contract = this.coworkerContracts[person.role];
      const home = contract.deskDock.worldAnchor;
      const start = footToCell(home[0], home[1], TILE);
      const sprite = this.makeAnimal(start.x, start.y, person, person.name, false);
      const frontDepth = contract.deskDock.frontLayerDepthY;
      const renderDepth = contract.deskDock.characterDepthY ?? (Number.isFinite(frontDepth) ? Math.min(home[1], frontDepth - 1) : home[1]);
      sprite.setPosition(...home).setDepth(renderDepth);
      const hitArea = coworkerHitArea(contract);
      sprite.setInteractive(new Phaser.Geom.Rectangle(...hitArea), Phaser.Geom.Rectangle.Contains);
      const hasLocalActions = coworkerLocalActions(contract).length > 0;
      const officePerson = { ...person, home: [...home], renderDepth, hitArea, interactionPoint: [...this.room.workstations[person.role].interactionPoint], sprite, statusText: sprite.getByName('status'), active: false, activitySource: 'local', actionSource: 'local', localEligible: true, localAction: null, localActionIndex: 0, nextLocalActionAt: this.time.now + (hasLocalActions ? localRestDelay(person.role, true) : Number.POSITIVE_INFINITY), pendingAction: null };
      sprite.on('pointerdown', () => this.talkTo(officePerson));
      this.people.set(person.role, officePerson);
      this.setPersonAction(officePerson, 'idle', 'local', true);
    }
    this.initializeStewardRoutine();
    this.registerKeyboardControls();
    this.input.on('pointerdown', (pointer, gameObjects) => {
      if (!gameObjects.length) this.walkToPointer(pointer);
    });
    this.scale.on('resize', () => this.fitCamera());
    this.fitCamera();
    window.irixiOffice = createOfficeBridge(this);
    this.syncDebugState();
    window.dispatchEvent(new CustomEvent('irixi:office-ready'));
  }

  fitCamera() {
    const width = this.scale.width;
    const height = this.scale.height;
    const zoom = crispZoom(width, height, this.room.width, this.room.height);
    this.cameras.main.setZoom(zoom);
    this.cameras.main.centerOn(this.room.width / 2, this.room.height / 2);
  }

  makeCollisionMap() {
    const blocked = (px, py) => this.room.blockedRects.some(({ rect: [x, y, width, height] }) => px >= x && px <= x + width && py >= y && py <= y + height);
    return Array.from({ length: this.room.rows }, (_, y) => Array.from({ length: this.room.columns }, (_, x) => {
      const px = x * TILE + TILE / 2; const py = (y + 1) * TILE;
      return this.room.walkablePolygons.some((points) => pointInPolygon(px, py, points)) && !blocked(px, py) ? 0 : 1;
    }));
  }

  drawRoom() {
    for (const item of this.room.foregroundItems) {
      const key = `room-foreground-${item.id}`;
      const image = this.textures.get(key).getSourceImage();
      this.add.image(item.x, item.y, key).setOrigin(item.pivot[0] / image.width, item.pivot[1] / image.height).setDepth(item.depthY);
    }
  }

  drawStationPatches() {
    for (const [role, contract] of Object.entries(this.coworkerContracts)) {
      const patch = contract.deskDock?.stationPatch;
      const key = `coworker-${role}-station-patch`;
      if (!patch?.file || !this.textures.exists(key)) continue;
      const [x, y] = patch.worldPosition;
      this.add.image(x, y, key).setOrigin(0, 0).setDepth((contract.deskDock.characterDepthY ?? contract.deskDock.worldAnchor[1]) - 1);
    }
  }

  drawStewardProps() {
    const props = this.motionIntegration.stewardMole.propVisibility;
    const [deskX, deskY, deskRight, deskBottom] = props.fixedDeskStackWorldBBox;
    const [shelfX, shelfY, shelfRight, shelfBottom] = props.shelfPatchWorldBBox;
    this.stewardDeskStack = this.add.image(deskX, deskY, 'steward-book-stack-desk').setOrigin(0, 0).setDisplaySize(deskRight - deskX, deskBottom - deskY).setDepth(deskBottom - 1);
    this.stewardShelfStack = this.add.image(shelfX, shelfY, 'steward-book-stack-shelf').setOrigin(0, 0).setDisplaySize(shelfRight - shelfX, shelfBottom - shelfY).setDepth(this.motionIntegration.stewardMole.shelfWorldFoot[1] - 1).setVisible(false);
  }

  createCoworkerAnimations() {
    for (const [role, contract] of Object.entries(this.coworkerContracts)) {
      for (const action of Object.keys(contract.animations)) {
        const spec = coworkerAnimationSpec(contract, role, action);
        if (!spec || !this.textures.exists(spec.textureKey)) continue;
        this.anims.create({
          key: `${role}-${action}`,
          frames: phaserAnimationFrames(spec),
          duration: animationCycleDuration(spec.frameDurationsMs, spec.frameDurationMs, spec.frames.length),
          repeat: spec.animation.loop ? -1 : 0,
        });
      }
    }
  }

  makeWindow(x, y) {
    const g = this.add.graphics().setDepth((y + 2) * TILE);
    g.fillStyle(0x101b1f).fillRect(x * TILE, y * TILE + 6, TILE * 4, TILE * 1.5);
    g.lineStyle(3, 0xc8a85d).strokeRect(x * TILE, y * TILE + 6, TILE * 4, TILE * 1.5);
    g.lineBetween((x + 2) * TILE, y * TILE + 6, (x + 2) * TILE, y * TILE + 54);
  }

  makeRug(x, y, w, h) {
    const g = this.add.graphics().setDepth(y * TILE - 10);
    g.fillStyle(0x6d2b2d).fillRect(x * TILE, y * TILE, w * TILE, h * TILE);
    g.lineStyle(4, 0xd0ac62).strokeRect(x * TILE + 5, y * TILE + 5, w * TILE - 10, h * TILE - 10);
  }

  makeDesk(x, y, w, h, label) {
    const g = this.add.graphics().setDepth((y + h) * TILE);
    g.fillStyle(0x3a2419).fillRect(x * TILE, y * TILE, w * TILE, h * TILE);
    g.fillStyle(0x6d4024).fillRect(x * TILE + 5, y * TILE + 5, w * TILE - 10, h * TILE - 12);
    g.lineStyle(3, 0xc49a52).strokeRect(x * TILE + 5, y * TILE + 5, w * TILE - 10, h * TILE - 12);
    this.add.text((x + w / 2) * TILE, (y + h - .35) * TILE, label, { fontFamily: 'Georgia', fontSize: '9px', color: '#ead69c', letterSpacing: 2 }).setOrigin(.5).setDepth((y + h) * TILE + 1);
  }

  makePlant(x, y) {
    const c = this.add.container(x * TILE + 16, y * TILE + 25).setDepth((y + 1) * TILE);
    const g = this.add.graphics();
    g.fillStyle(0x59402a).fillRect(-10, 4, 20, 18);
    g.fillStyle(0x2d5a3e).fillCircle(-7, 0, 10).fillCircle(7, -4, 11).fillCircle(0, -14, 12);
    c.add(g);
  }

  makeAnimal(cx, cy, character, label, owl) {
    const c = this.add.container(cx * TILE + TILE / 2, cy * TILE + TILE).setDepth(cy * TILE + TILE);
    const shadow = this.add.ellipse(0, 1, owl ? 70 : 58, owl ? 18 : 15, 0x1b100b, .3);
    const contract = owl ? this.irixiContract : this.coworkerContracts[character.role];
    const idleSpec = !owl && coworkerAnimationSpec(contract, character.role, 'idle');
    const texture = owl ? 'irixi-down-idle' : idleSpec && this.textures.exists(idleSpec.textureKey) ? idleSpec.textureKey : `${FALLBACK_SPECIES[character.role]}-sheet`;
    const frameSize = idleSpec?.frameSize || contract?.frameSize || [64, 72];
    const anchor = idleSpec?.anchor || contract?.anchor || [32, 68];
    const body = this.add.sprite(0, 0, texture, idleSpec?.frames?.[0] || 0).setOrigin(anchor[0] / frameSize[0], anchor[1] / frameSize[1]).setName('body');
    body.setData('runtime', !owl && Boolean(idleSpec && this.textures.exists(idleSpec.textureKey)));
    if (owl) body.play('irixi-down-idle');
    const name = this.add.text(0, 9, label, { fontFamily: 'system-ui', fontSize: '10px', color: '#fff3cf', backgroundColor: '#183b32', padding: { x: 4, y: 2 } }).setOrigin(.5, 0);
    const status = this.add.text(0, 24, '待命', { name: 'status', fontFamily: 'system-ui', fontSize: '8px', color: '#d9c79e', backgroundColor: '#1a120ee8', padding: { x: 3, y: 2 } }).setOrigin(.5, 0).setName('status');
    c.add([shadow, body, name, status]);
    if (owl) status.setVisible(false);
    return c;
  }

  inputLocked() {
    const active = document.activeElement;
    return Boolean(document.querySelector('dialog[open]')) || isEditableTarget(active);
  }

  registerKeyboardControls() {
    const keyCodes = Phaser.Input.Keyboard.KeyCodes;
    this.cursors = this.input.keyboard.addKeys({ up: keyCodes.UP, down: keyCodes.DOWN, left: keyCodes.LEFT, right: keyCodes.RIGHT }, false);
    this.keys = this.input.keyboard.addKeys('W,A,S,D,ESC', false);
    this.input.keyboard.on('keydown-ESC', () => this.cancelWalk('已取消自动走近。'));
    this.registerMovementCancellation();
  }

  registerMovementCancellation() {
    this.input.keyboard.on('keydown', (event) => {
      const locked = this.inputLocked() || isEditableTarget(event.target);
      if (!locked && isMovementKey(event.key)) event.preventDefault();
      const automaticWalking = this.pathPending || this.path.length > 0 || (this.stepInProgress && !this.manualMoving);
      if (automaticWalking && !locked && isMovementKey(event.key)) this.cancelWalk();
    });
  }

  update(time) {
    this.updateCoworkerTransitions();
    this.updateStewardMotionPause();
    this.updateStewardRoutine(time);
    this.updateLocalCoworkers(time);
    if (time - this.lastRoleDebugAt >= 240) {
      this.syncRoleDebug();
      this.lastRoleDebugAt = time;
    }
    const locked = this.inputLocked();
    if (locked) this.input.keyboard.resetKeys();
    const dx = (this.cursors.left.isDown || this.keys.A.isDown ? -1 : 0) + (this.cursors.right.isDown || this.keys.D.isDown ? 1 : 0);
    const dy = (this.cursors.up.isDown || this.keys.W.isDown ? -1 : 0) + (this.cursors.down.isDown || this.keys.S.isDown ? 1 : 0);
    if ((this.path.length || (this.stepInProgress && !this.manualMoving)) && !locked && (dx || dy)) this.cancelWalk();
    if (this.path.length && !this.stepInProgress && time - this.lastMoveAt > 100) {
      const next = this.path[0];
      if (!this.canOccupyCell(next.x, next.y)) { this.lastMoveAt = time; return; }
      this.path.shift();
      this.moveToCell(next.x, next.y, { keepWalking: this.path.length > 0 });
      this.lastMoveAt = time;
      return;
    }
    if (locked) { this.stopManualWalk(); return; }
    if (time - this.lastMoveAt < 110) return;
    if (!dx && !dy) { this.stopManualWalk(); return; }
    this.path = []; this.walkTarget = null;
    const next = { x: this.playerCell.x + Math.sign(dx), y: this.playerCell.y + Math.sign(dy) };
    if (this.canStep(Math.sign(dx), Math.sign(dy))) {
      this.manualMoving = true;
      this.moveToCell(next.x, next.y, { keepWalking: true });
    } else this.stopManualWalk();
    this.lastMoveAt = time;
  }

  canStep(dx, dy) {
    const x = this.playerCell.x; const y = this.playerCell.y;
    return canStepWithoutCornerCutting((cx, cy) => this.canOccupyCell(cx, cy), x, y, dx, dy);
  }

  canOccupyCell(x, y) {
    if (!this.grid.isWalkable(x, y)) return false;
    const steward = this.people?.get('steward');
    const routine = this.stewardRoutine;
    if (!steward || !routine || !['outbound', 'returning'].includes(routine.phase)) return true;
    return !feetOverlap(x * TILE + TILE / 2, (y + 1) * TILE, steward.sprite.x, steward.sprite.y);
  }

  stopManualWalk() {
    if (!this.manualMoving) return;
    this.manualMoving = false;
    this.player.getByName('body').play(`irixi-${this.playerDirection}-idle`, true);
    this.syncDebugState();
  }

  moveToCell(x, y, { keepWalking = false } = {}) {
    const dx = x - this.playerCell.x; const dy = y - this.playerCell.y;
    const direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'up' : 'down';
    this.playerDirection = direction;
    this.playerCell = { x, y };
    const body = this.player.getByName('body');
    body.play(`irixi-${direction}-walk`, true);
    this.stepInProgress = true;
    this.tweens.add({
      targets: this.player,
      x: x * TILE + TILE / 2,
      y: y * TILE + TILE,
      duration: 90,
      ease: 'Linear',
      onComplete: () => {
        this.stepInProgress = false;
        if (!keepWalking && !this.path.length && !this.manualMoving) {
          body.play(`irixi-${direction}-idle`, true);
          const arrived = this.walkTarget;
          this.walkTarget = null;
          this.destinationMarker.setVisible(false);
          this.syncDebugState();
          if (arrived?.kind === 'coworker') window.dispatchEvent(new CustomEvent('irixi:arrival', { detail: arrived }));
          return;
        }
        this.syncDebugState();
      },
    });
    this.player.setDepth(y * TILE + TILE);
    this.syncDebugState();
  }

  nearestWalkable(person) {
    const movingSteward = person.role === 'steward' && this.stewardRoutine && !['waiting', 'completed'].includes(this.stewardRoutine.phase);
    const preferred = movingSteward ? footToCell(person.sprite.x, person.sprite.y, TILE) : worldToCell(person.interactionPoint[0], person.interactionPoint[1], TILE);
    const activeLeg = movingSteward ? this.stewardRoutine.legs?.[this.stewardRoutine.legIndex] : null;
    for (let radius = 0; radius <= 8; radius += 1) {
      const options = [];
      for (let dy = -radius; dy <= radius; dy += 1) for (let dx = -radius; dx <= radius; dx += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const cell = { x: preferred.x + dx, y: preferred.y + dy };
        const footX = cell.x * TILE + TILE / 2;
        const footY = (cell.y + 1) * TILE;
        const occupiedBySteward = movingSteward && feetOverlap(footX, footY, person.sprite.x, person.sprite.y, 28, 22);
        const clearsRoute = !activeLeg || pointToSegmentDistance(footX, footY, ...activeLeg.from, ...activeLeg.to) >= 40;
        if (this.grid.isWalkable(cell.x, cell.y) && !occupiedBySteward && clearsRoute) options.push(cell);
      }
      if (options.length) return options.sort((a, b) => (Math.abs(a.x - this.playerCell.x) + Math.abs(a.y - this.playerCell.y)) - (Math.abs(b.x - this.playerCell.x) + Math.abs(b.y - this.playerCell.y)))[0];
    }
    return null;
  }

  async talkTo(person) {
    if (person.role === 'steward' && this.stewardRoutine && !['waiting', 'completed'].includes(this.stewardRoutine.phase)) this.pauseStewardMotion('conversation');
    window.dispatchEvent(new CustomEvent('irixi:coworker', { detail: { role: person.role, name: person.name, status: person.statusText.text } }));
    const destination = this.nearestWalkable(person);
    if (!destination) return window.dispatchEvent(new CustomEvent('irixi:unreachable', { detail: person }));
    const target = { kind: 'coworker', role: person.role, name: person.name, destination };
    if (!this.stepInProgress && destination.x === this.playerCell.x && destination.y === this.playerCell.y) return window.dispatchEvent(new CustomEvent('irixi:arrival', { detail: target }));
    const reached = await this.startPath(destination, target);
    if (!reached) window.dispatchEvent(new CustomEvent('irixi:unreachable', { detail: person }));
  }

  async walkToPointer(pointer) {
    if (this.inputLocked()) return;
    const world = this.cameras.main.getWorldPoint(pointer.x, pointer.y);
    const destination = worldToCell(world.x, world.y, TILE);
    const host = document.getElementById('office-game');
    host.dataset.lastPointerCell = `${destination.x},${destination.y}`;
    const accepted = this.grid.isWalkable(destination.x, destination.y) && !this.isFurniturePoint(world.x, world.y);
    host.dataset.lastClickAccepted = String(accepted);
    if (!accepted) return;
    await this.startPath(destination, { kind: 'floor', destination });
  }

  isFurniturePoint(x, y) {
    return this.room.blockedRects.some(({ rect: [left, top, width, height] }) => x >= left && x <= left + width && y >= top && y <= top + height);
  }

  async startPath(destination, target) {
    const requestId = ++this.pathRequestId;
    this.pathPending = true;
    const path = await this.grid.findPath(this.playerCell, destination);
    if (requestId !== this.pathRequestId) return false;
    this.pathPending = false;
    if (!path?.length) return false;
    this.manualMoving = false;
    this.path = path.slice(1);
    this.walkTarget = target;
    this.destinationMarker.setPosition(destination.x * TILE + TILE / 2, destination.y * TILE + TILE).setDepth(destination.y * TILE + TILE + 1).setVisible(this.path.length > 0);
    if (!this.path.length) this.walkTarget = null;
    this.syncDebugState();
    return true;
  }

  cancelWalk(message = '') {
    this.pathRequestId += 1;
    this.pathPending = false;
    this.path = [];
    this.walkTarget = null;
    this.destinationMarker.setVisible(false);
    this.tweens.killTweensOf(this.player);
    this.stepInProgress = false;
    this.player.setPosition(this.playerCell.x * TILE + TILE / 2, this.playerCell.y * TILE + TILE).setDepth(this.playerCell.y * TILE + TILE);
    this.manualMoving = false;
    this.player.getByName('body').play(`irixi-${this.playerDirection}-idle`, true);
    this.syncDebugState();
    if (message) window.dispatchEvent(new CustomEvent('irixi:walk-cancelled', { detail: { message } }));
  }

  syncDebugState() {
    const host = document.getElementById('office-game');
    host.dataset.roomRevision = this.room.revision;
    host.dataset.characterRevision = this.irixiContract?.revision || '';
    host.dataset.motionIntegration = this.motionIntegration?.id || '';
    host.dataset.restIntegration = this.restIntegration?.id || '';
    host.dataset.continuityIntegration = this.continuityIntegration?.id || '';
    const contracts = this.coworkerContracts || {};
    host.dataset.coworkerRevisions = JSON.stringify(Object.fromEntries(Object.entries(contracts).map(([role, contract]) => [role, contract.revision || contract.id])));
    host.dataset.stationPatches = JSON.stringify(Object.entries(contracts).filter(([, contract]) => contract.deskDock?.stationPatch?.file).map(([role, contract]) => ({ role, file: contract.deskDock.stationPatch.file, position: contract.deskDock.stationPatch.worldPosition })));
    host.dataset.worldSize = `${this.room.width}x${this.room.height}`;
    host.dataset.playerCell = `${this.playerCell.x},${this.playerCell.y}`;
    host.dataset.walking = String(isWalkInProgress({ pathPending: this.pathPending, pathLength: this.path.length, stepInProgress: this.stepInProgress, manualMoving: this.manualMoving }));
    host.dataset.walkTarget = this.walkTarget ? `${this.walkTarget.kind}:${this.walkTarget.destination.x},${this.walkTarget.destination.y}` : '';
    host.dataset.cameraZoom = String(this.cameras.main.zoom);
    host.dataset.playerPixel = `${Math.round(this.player.x)},${Math.round(this.player.y)}`;
    host.dataset.playerAnimation = this.player.getByName('body').anims.currentAnim?.key || '';
  }

  setTask(task, presence = {}) {
    this.task = task;
    for (const [role, person] of this.people) {
      const { active, status, localEligible, activitySource } = coworkerRuntimeState(task, role, presence);
      person.statusText.setText(stateLabel[status] || status);
      person.sprite.setAlpha(status === 'idle' ? .9 : 1);
      person.active = active;
      person.localEligible = localEligible;
      person.activitySource = activitySource;
      const stewardBusy = role === 'steward' && this.stewardRoutine && !['waiting', 'completed'].includes(this.stewardRoutine.phase);
      if (stewardBusy) {
        person.pendingTaskAction = active ? { action: 'working', source: activitySource } : null;
        continue;
      }
      if (active) {
        const [x, y] = person.home;
        this.moveCoworker(person, x, y);
        this.setPersonAction(person, 'working', activitySource);
      } else {
        this.moveCoworker(person, ...person.home);
        const workTransitionPending = person.pendingAction?.action === 'working' || person.pendingAction?.then?.action === 'working' || person.afterTransition?.action === 'working';
        if (!person.localEligible || person.localAction === 'working' || workTransitionPending) this.setPersonAction(person, 'idle', activitySource);
      }
    }
  }

  setPersonAction(person, action, source = person.activitySource || 'local', force = false, then = null, direct = false) {
    const body = person.sprite.getByName('body');
    const contract = this.coworkerContracts[person.role];
    const transitionActions = ['work-to-rest', 'rest-to-work'];
    const continuityEnabled = Boolean(contract.animations['work-to-rest'] && contract.animations['rest-to-work'] && !this.reducedMotion);
    if (!direct && transitionActions.includes(person.localAction) && !transitionActions.includes(action)) {
      person.afterTransition = { action, source };
      person.actionSource = source;
      this.syncRoleDebug();
      return false;
    }
    if (!direct && action === 'working' && ['sleeping', 'slack'].includes(person.localAction)) {
      then = { action: 'working', source };
      action = 'idle';
    } else if (!direct && continuityEnabled && person.localAction === 'working' && action !== 'working' && !transitionActions.includes(action)) {
      then = { action, source };
      action = 'work-to-rest';
    } else if (!direct && continuityEnabled && person.localAction === 'idle' && action === 'working') {
      then = { action: 'working', source };
      action = 'rest-to-work';
    }
    const requested = coworkerAnimationSpec(contract, person.role, action);
    const resolvedAction = requested ? action : 'idle';
    const spec = requested || coworkerAnimationSpec(contract, person.role, 'idle');
    action = resolvedAction;
    if (person.localAction === action) {
      person.pendingAction = null;
      person.actionSource = source;
      this.syncRoleDebug();
      return true;
    }
    const currentSpec = coworkerAnimationSpec(contract, person.role, person.localAction);
    const currentFrame = Number(body.anims?.currentFrame?.textureFrame ?? body.frame?.name ?? body.frame?.index ?? 0);
    const safeFrames = coworkerTransitionSafeFrames(person.localAction, action, currentSpec);
    if (!force && safeFrames.length && !isSafeSwitchFrame(currentFrame, safeFrames)) {
      person.pendingAction = { action, source, then };
      this.syncRoleDebug();
      return false;
    }
    person.pendingAction = null;
    person.afterTransition = null;
    person.localAction = action;
    person.actionSource = source;
    if (!body.getData('runtime')) {
      body.setFrame(action === 'working' ? 1 : action === 'sleeping' ? 2 : 0);
      if (then) this.setPersonAction(person, then.action, then.source, true, null, true);
      this.syncRoleDebug();
      return true;
    }
    body.setOrigin(spec.anchor[0] / spec.frameSize[0], spec.anchor[1] / spec.frameSize[1]);
    const hitArea = spec.animation.hitArea || coworkerHitArea(contract, action);
    person.hitArea = hitArea;
    person.sprite.setInteractive(new Phaser.Geom.Rectangle(...hitArea), Phaser.Geom.Rectangle.Contains);
    const key = `${person.role}-${action}`;
    if (spec.isStatic || this.reducedMotion) body.stop().setTexture(spec.textureKey).setFrame(spec.frames[0]);
    else {
      body.play(Number.isInteger(spec.animation.startFrameIndex) ? { key, startFrame: spec.animation.startFrameIndex } : key, true);
      if (person.role !== 'steward' && !spec.animation.loop && spec.animation.returnTo) body.once(`animationcomplete-${key}`, () => {
        if (person.localAction !== action) return;
        if (spec.animation.transition) {
          const queued = person.afterTransition || then || { action: spec.animation.returnTo, source: person.activitySource };
          person.afterTransition = null;
          this.setPersonAction(person, spec.animation.returnTo, queued.source, true, null, true);
          if (queued.action !== spec.animation.returnTo) {
            if (spec.animation.returnTo === 'idle' && queued.action === 'working') person.pendingAction = { action: 'rest-to-work', source: queued.source, then: queued };
            else if (spec.animation.returnTo === 'working') person.pendingAction = { action: 'work-to-rest', source: queued.source, then: queued };
            else person.pendingAction = queued;
          }
          this.syncRoleDebug();
          return;
        }
        const pendingReturn = person.pendingAction?.action === spec.animation.returnTo ? person.pendingAction : null;
        if (person.active && !pendingReturn) return;
        this.setPersonAction(person, spec.animation.returnTo, pendingReturn?.source || person.activitySource, true, pendingReturn?.then || null);
        person.nextLocalActionAt = this.time.now + localRestDelay(person.role);
      });
    }
    if (then && spec.animation.transition) person.afterTransition = then;
    else if (then?.action === 'working' && action === 'idle' && continuityEnabled) person.pendingAction = { action: 'rest-to-work', source: then.source, then };
    else if (then) person.pendingAction = then;
    this.syncRoleDebug();
    return true;
  }

  updateCoworkerTransitions() {
    for (const person of this.people.values()) {
      if (!person.pendingAction) continue;
      const body = person.sprite.getByName('body');
      const spec = coworkerAnimationSpec(this.coworkerContracts[person.role], person.role, person.localAction);
      const frame = Number(body.anims?.currentFrame?.textureFrame ?? body.frame?.name ?? body.frame?.index ?? 0);
      const pending = person.pendingAction;
      if (!isSafeSwitchFrame(frame, coworkerTransitionSafeFrames(person.localAction, pending.action, spec))) continue;
      this.setPersonAction(person, pending.action, pending.source, true, pending.then || null);
    }
  }

  moveCoworker(person, x, y) {
    if (person.sprite.x === x && person.sprite.y === y) return;
    this.tweens.killTweensOf(person.sprite);
    if (this.reducedMotion) person.sprite.setPosition(x, y).setDepth(person.renderDepth ?? y);
    else this.tweens.add({ targets: person.sprite, x, y, duration: 180, ease: 'Cubic.easeOut', onComplete: () => person.sprite.setDepth(person.renderDepth ?? y) });
  }

  updateLocalCoworkers(time) {
    for (const person of this.people.values()) {
      if (person.role === 'steward' || person.pendingAction || person.active || !person.localEligible || !person.sprite.getByName('body').getData('runtime') || this.reducedMotion || time < person.nextLocalActionAt) continue;
      if (person.localAction === 'idle') {
        const localActions = coworkerLocalActions(this.coworkerContracts[person.role]);
        if (localActions.length) {
          const action = localActions[person.localActionIndex % localActions.length];
          person.localActionIndex += 1;
          this.setPersonAction(person, action, 'local');
          person.nextLocalActionAt = alignedLocalActionEnd(time, this.coworkerContracts[person.role], person.role, action);
        } else person.nextLocalActionAt = Number.POSITIVE_INFINITY;
      } else {
        this.setPersonAction(person, 'idle', person.activitySource || 'local');
        const hasLocalActions = coworkerLocalActions(this.coworkerContracts[person.role]).length > 0;
        person.nextLocalActionAt = time + (hasLocalActions ? localRestDelay(person.role) : Number.POSITIVE_INFINITY);
      }
    }
  }

  initializeStewardRoutine() {
    const person = this.people.get('steward');
    this.stewardRoutine = {
      phase: 'waiting',
      completed: false,
      bookOwner: 'desk',
      nextAt: this.time.now + 2500,
      legs: [],
      legIndex: 0,
      retryPending: false,
      pauseReasons: new Set(),
      tween: null,
      conversationResumeAction: null,
    };
    const body = person.sprite.getByName('body');
    body.on('animationupdate', (_animation, frame) => {
      const owner = stewardBookOwner(person.localAction, Number(frame.textureFrame), this.stewardRoutine.bookOwner, this.motionIntegration.stewardMole.propVisibility);
      if (owner === this.stewardRoutine.bookOwner) return;
      this.stewardRoutine.bookOwner = owner;
      if (owner === 'shelf') this.stewardShelfStack.setVisible(true);
      this.syncRoleDebug();
    });
  }

  pauseStewardMotion(reason) {
    const routine = this.stewardRoutine;
    const person = this.people?.get('steward');
    if (!routine || !person || routine.completed) return;
    routine.pauseReasons.add(reason);
    if (reason === 'conversation' && ['outbound', 'returning'].includes(routine.phase) && !routine.conversationResumeAction) {
      routine.conversationResumeAction = person.localAction;
      const dx = this.player.x - person.sprite.x;
      const dy = this.player.y - person.sprite.y;
      const direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'up' : 'down';
      const facingAction = `walk-${routine.bookOwner === 'mole' ? 'carry' : 'empty'}-${direction}`;
      if (this.coworkerContracts?.steward?.animations?.[facingAction]) this.setPersonAction(person, facingAction, 'conversation', true);
    }
    routine.tween?.pause?.();
    person.sprite.getByName('body').anims?.pause?.();
    this.syncRoleDebug();
  }

  resumeStewardMotion(reason) {
    const routine = this.stewardRoutine;
    const person = this.people?.get('steward');
    if (!routine || !person) return;
    routine.pauseReasons.delete(reason);
    if (reason === 'conversation' && routine.conversationResumeAction) {
      const resumeAction = routine.conversationResumeAction;
      routine.conversationResumeAction = null;
      this.setPersonAction(person, resumeAction, 'local', true);
      if (routine.pauseReasons.size) person.sprite.getByName('body').anims?.pause?.();
    }
    if (routine.pauseReasons.size) return;
    person.sprite.getByName('body').anims?.resume?.();
    routine.tween?.resume?.();
    this.syncRoleDebug();
  }

  updateStewardMotionPause() {
    const routine = this.stewardRoutine;
    const person = this.people?.get('steward');
    if (!routine || !person || !routine.pauseReasons.size) return;
    if (routine.pauseReasons.has('conversation') && !document.querySelector('#coworker-dialog[open]')) this.resumeStewardMotion('conversation');
    if (routine.pauseReasons.has('collision') && !feetOverlap(this.player.x, this.player.y, person.sprite.x, person.sprite.y, 36, 24)) this.resumeStewardMotion('collision');
  }

  updateStewardRoutine(time) {
    const routine = this.stewardRoutine;
    const person = this.people?.get('steward');
    if (!routine || !person || routine.completed || routine.phase !== 'waiting' || time < routine.nextAt) return;
    if (person.active || !person.localEligible || this.reducedMotion) { routine.nextAt = time + 1000; return; }
    routine.phase = 'pickup';
    routine.bookOwner = 'transition';
    this.stewardDeskStack.setVisible(false);
    this.setPersonAction(person, 'pickup-books', 'local', true);
    const body = person.sprite.getByName('body');
    body.once('animationcomplete-steward-pickup-books', () => {
      routine.bookOwner = 'mole';
      this.startStewardRoute('outbound');
    });
  }

  startStewardRoute(direction) {
    const routine = this.stewardRoutine;
    routine.phase = direction === 'outbound' ? 'outbound' : 'returning';
    routine.legs = stewardRouteLegs(this.coworkerContracts.steward.steward.routeContract, direction);
    routine.legIndex = 0;
    this.advanceStewardRoute();
  }

  advanceStewardRoute() {
    const person = this.people.get('steward');
    const routine = this.stewardRoutine;
    const leg = routine.legs[routine.legIndex];
    if (!leg) {
      if (routine.phase === 'outbound') this.startStewardShelving();
      else this.finishStewardRoutine();
      return;
    }
    const playerX = this.player?.x ?? Number.POSITIVE_INFINITY;
    const playerY = this.player?.y ?? Number.POSITIVE_INFINITY;
    if (pointToSegmentDistance(playerX, playerY, ...leg.from, ...leg.to) < 38) {
      if (!routine.retryPending) {
        routine.retryPending = true;
        this.time.delayedCall(220, () => { routine.retryPending = false; this.advanceStewardRoute(); });
      }
      return;
    }
    this.setPersonAction(person, leg.action, 'local', true);
    const distance = Math.hypot(leg.to[0] - leg.from[0], leg.to[1] - leg.from[1]);
    routine.tween = this.tweens.add({
      targets: person.sprite,
      x: leg.to[0],
      y: leg.to[1],
      duration: distance / MOLE_ROUTE_SPEED * 1000,
      ease: 'Linear',
      onUpdate: () => {
        person.sprite.setDepth(person.sprite.y);
        if (feetOverlap(this.player.x, this.player.y, person.sprite.x, person.sprite.y, 36, 24)) this.pauseStewardMotion('collision');
      },
      onComplete: () => {
        routine.tween = null;
        person.sprite.setPosition(...leg.to).setDepth(leg.to[1]);
        routine.legIndex += 1;
        this.advanceStewardRoute();
      },
    });
  }

  startStewardShelving() {
    const person = this.people.get('steward');
    const routine = this.stewardRoutine;
    routine.phase = 'shelving';
    this.setPersonAction(person, 'shelve-books', 'local', true);
    const body = person.sprite.getByName('body');
    body.once('animationcomplete-steward-shelve-books', () => {
      routine.bookOwner = 'shelf';
      this.stewardShelfStack.setVisible(true);
      this.startStewardRoute('return');
    });
  }

  finishStewardRoutine() {
    const person = this.people.get('steward');
    const routine = this.stewardRoutine;
    routine.phase = 'completed';
    routine.completed = true;
    routine.bookOwner = 'shelf';
    routine.tween = null;
    routine.pauseReasons.clear();
    person.renderDepth = person.home[1];
    person.pendingTaskAction = null;
    this.setPersonAction(person, person.active ? 'working' : 'wait-empty', person.active ? person.activitySource : 'local', true);
    this.syncRoleDebug();
  }

  syncRoleDebug() {
    const host = document.getElementById('office-game');
    if (!host) return;
    host.dataset.roleActions = JSON.stringify([...this.people.entries()].map(([role, person]) => {
      const body = person.sprite.getByName('body');
      return { role, action: person.localAction, pendingAction: person.pendingAction?.action || person.pendingTaskAction?.action || null, pendingThen: person.pendingAction?.then?.action || null, afterTransition: person.afterTransition?.action || null, activitySource: person.activitySource, actionSource: person.actionSource, active: person.active, runtime: Boolean(body.getData('runtime')), texture: body.texture.key, frame: body.frame?.name ?? body.frame?.index ?? 0, position: [Math.round(person.sprite.x), Math.round(person.sprite.y)], hitArea: person.hitArea };
    }));
    if (this.stewardRoutine) host.dataset.stewardRoutine = JSON.stringify({ phase: this.stewardRoutine.phase, completed: this.stewardRoutine.completed, bookOwner: this.stewardRoutine.bookOwner, paused: [...this.stewardRoutine.pauseReasons] });
  }
}

const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'office-game',
  width: WORLD_W,
  height: WORLD_H,
  backgroundColor: '#120d0a',
  pixelArt: false,
  roundPixels: false,
  scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH },
  scene: OfficeScene,
  render: { antialias: true, pixelArt: false },
});

document.addEventListener('visibilitychange', () => document.hidden ? game.scene.pause('office') : game.scene.resume('office'));
