/*
 * Scene/input structure adapted from agent-office Game.ts and pathfinding
 * wrapper adapted from Grid.ts at b00de4e8615c02605be7b90694dccda55d5d8168.
 * See THIRD_PARTY_NOTICES.md and third_party/agent-office-MIT.txt.
 */
import { animationCycleDuration, canStepWithoutCornerCutting, coworkerRuntimeState, crispZoom, feetOverlap, feetSegmentOverlap, leavesFeetOverlap, footToCell, isMovementKey, isSafeSwitchFrame, isWalkInProgress, pointToSegmentDistance, worldToCell } from './office-geometry.js';

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
const STEWARD_STATES_ROOT = `${REST_ROOT}steward-n4/`;
const STEWARD_STATES_KEY = 'steward-n4-states';
const CONTINUITY_ROOT = `${REST_ROOT}continuity-repair-v3/`;
const CONTINUITY_INTEGRATION_KEY = 'office-rest-continuity-v3-integration';
const REVIEWER_SLEEP_TRANSITION_ROOT = `${REST_ROOT}continuity-repair-v4/reviewer-sleep-transition-v2/`;
const REVIEWER_SLEEP_TRANSITION_MANIFEST_KEY = 'office-reviewer-sleep-transition-v2';
const REVIEWER_SLEEP_TRANSITION_TEXTURE_KEY = 'coworker-reviewer-sleep-transition-v5';
const FLOOR_EXTENSION_KEY = 'office-floor-extension-v5';
const FLOOR_EXTENSION_ROOT = `${ASSET_ROOT}concept-runtime-v5/`;
const MOLE_ROUTE_SPEED = 140;
// Peek head spans about 100 px; Irixi's visible body spans about 113 px.
const BURROW_VIEW_CLEARANCE_X = 116;
const QUALITY_ROOT = `${ASSET_ROOT}motion-quality-v8/`;
const QUALITY_MANIFEST_KEY = 'office-motion-quality-v8';
// Enabled by the integrator only with the reviewed, version-bound pack.
const QUALITY_PACK_ENABLED = true;
// Crown landmarks read from the current four sleeping source canvases, not their transparent bounds.
const SLEEP_HEAD_ANCHOR = { researcher: [128, 82], writer: [88, 34], reviewer: [153, 101], archivist: [138, 82] };
// One role-wide correction for the existing authored sheets. Keep it constant
// across work/rest states so a state change never changes the character scale.
export const SEATED_ROLE_RENDER_SCALE = Object.freeze({
  researcher: 1,
  writer: 1.12,
  reviewer: 0.92,
  archivist: 0.86,
  steward: 1,
});
export const SEATED_ROLE_POSITION_CORRECTION = Object.freeze({
  researcher: Object.freeze([0, 0]),
  writer: Object.freeze([0, 0]),
  reviewer: Object.freeze([0, 0]),
  archivist: Object.freeze([18, 0]),
  steward: Object.freeze([0, 0]),
});
// The reviewer sits directly above the archivist; keep its labels beside its own desk.
export const COWORKER_LABEL_OFFSET = Object.freeze({ reviewer: Object.freeze([-180, -15]) });

export const PEOPLE = [
  { role: 'researcher', name: '仓鼠学习同事', species: 'hamster' },
  { role: 'writer', name: '小鼠工具开发同事', species: 'mouse' },
  { role: 'reviewer', name: '龙猫小游戏开发同事', species: 'chinchilla' },
  { role: 'steward', name: '鼹鼠Agent开发同事', species: 'mole' },
  { role: 'archivist', name: '花枝鼠档案记忆同事', species: 'fancy-rat' },
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

export function normalizeRoomContract(manifest, extension = null) {
  const [floorWidth, floorHeight] = manifest.world.logicalSize;
  const [width, height] = extension?.world?.logicalSize || [floorWidth, floorHeight];
  const [groundFloorX, groundFloorY] = extension?.world?.groundFloorOrigin || [0, 0];
  const [upperFloorX, upperFloorY] = extension?.world?.upperFloorOrigin || [0, 0];
  const shiftPoint = ([x, y]) => [x + groundFloorX, y + groundFloorY];
  const shiftRect = ([x, y, rectWidth, rectHeight]) => [x + groundFloorX, y + groundFloorY, rectWidth, rectHeight];
  const shiftUpperPoint = ([x, y]) => [x + upperFloorX, y + upperFloorY];
  const shiftUpperRect = ([x, y, rectWidth, rectHeight]) => [x + upperFloorX, y + upperFloorY, rectWidth, rectHeight];
  const stairConnection = extension?.world?.stairConnection;
  const blockedRects = manifest.blockedPolygons.flatMap((item) => {
    if (item.id === 'right-staircase' && stairConnection) return [];
    // ponytail: the walkable stair polygon is the narrow opening; retaining
    // the broad top-wall rectangle would cover its diagonal and needlessly
    // carve a vertical wall gap.
    if (item.id === 'top-wall-and-shelves' && stairConnection) return [];
    return [{ id: item.id, rect: shiftRect(item.rect) }];
  });
  for (const item of extension?.upperFloor?.blockedPolygons || []) blockedRects.push({ id: item.id, rect: shiftUpperRect(item.rect) });
  const walkablePolygons = manifest.walkablePolygons.map((points) => points.map(shiftPoint));
  if (stairConnection) {
    walkablePolygons.push(stairConnection.groundFlightLocal.map(shiftPoint));
    walkablePolygons.push(stairConnection.groundLandingLocal.map(shiftPoint));
    walkablePolygons.push(...extension.upperFloor.walkablePolygons.map((points) => points.map(shiftUpperPoint)));
  }
  const workstations = Object.fromEntries(Object.entries(manifest.workstations).map(([role, item]) => [role, {
    home: shiftPoint(item.characterFootAnchor), interactionPoint: shiftPoint(item.interactionPoint), frontLayerId: item.frontLayerId,
  }]));
  return {
    width, height, floorWidth, floorHeight, groundFloorX, groundFloorY,
    columns: Math.ceil(width / TILE), rows: Math.ceil(height / TILE),
    background: manifest.world.background,
    backgroundLayers: extension ? [
      { key: 'office-upper-gallery', x: upperFloorX, y: upperFloorY, width: floorWidth, height: floorHeight, depth: -100 },
      { key: 'office-room-base', x: groundFloorX, y: groundFloorY, width: floorWidth, height: floorHeight, depth: -99 },
    ] : [{ key: 'office-room-base', x: 0, y: 0, width: floorWidth, height: floorHeight, depth: -100 }],
    foregroundItems: [
      ...manifest.foregroundItems.map((item) => ({ ...item, x: item.x + groundFloorX, y: item.y + groundFloorY, depthY: item.depthY + groundFloorY, pivot: [...item.pivot], collisionRect: item.collision?.rect ? shiftRect(item.collision.rect) : null })),
      ...(extension?.upperFloor?.foregroundItems || []).map((item) => ({ ...item, x: item.x + upperFloorX, y: item.y + upperFloorY, depthY: item.depthY + upperFloorY, pivot: [...item.pivot], collisionRect: item.collision?.rect ? shiftUpperRect(item.collision.rect) : null })),
    ],
    walkablePolygons,
    blockedRects,
    workstations,
    spawn: shiftPoint(manifest.spawnPoints.irixi),
    revision: manifest.revision,
  };
}

function frontDepthForRole(room, role) {
  const frontLayerId = room.workstations[role]?.frontLayerId;
  return room.foregroundItems.find((item) => item.id === frontLayerId)?.depthY;
}

export function seatedV6Contract(integration, role, manifest, room, restIntegration = null, restManifest = null, continuityIntegration = null, transitionManifest = null, restOverride = null, roleRestTransitionManifest = null) {
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
  const roleRestTransitionAnimations = roleRestTransitionManifest ? Object.fromEntries(Object.entries(roleRestTransitionManifest.animations).map(([name, item]) => [name, {
    sheet: roleRestTransitionManifest.spritesheet,
    textureKey: REVIEWER_SLEEP_TRANSITION_TEXTURE_KEY,
    frameSize: [...roleRestTransitionManifest.frameSize],
    anchor: [...roleRestTransitionManifest.anchor],
    frameIndices: [...item.frameIndices],
    frameDurationsMs: [...item.frameDurationsMs],
    safeSwitchFrameIndices: [],
    hitArea: [...manifest.hitArea],
    loop: false,
    returnTo: item.returnTo,
    transition: true,
  }])) : {};
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
      ...roleRestTransitionAnimations,
    },
    localActions: restAnimations ? ['sleeping', 'slack'] : [],
    restIntegrationId: restAnimations ? restIntegration.id : null,
    continuityIntegrationId: transitionManifest ? continuityIntegration.id : null,
    deskDock: {
      roomOrigin: [room.groundFloorX || 0, room.groundFloorY || 0],
      worldAnchor: [...room.workstations[role].home],
      characterDepthY: room.workstations[role].home[1],
      frontLayerDepthY: frontDepthForRole(room, role),
      // fixedContentBottom is an authored visual registration datum, not a measured chair or hand contact.
      renderRegistrationPoint: Number.isFinite(restManifest?.fixedContentBottom) ? [manifest.anchor[0], restManifest.fixedContentBottom] : null,
      stationPatch: manifest.stationPatch ? {
        ...manifest.stationPatch,
        worldPosition: [manifest.stationPatch.worldPosition[0], manifest.stationPatch.worldPosition[1] + (room.groundFloorY || 0)],
      } : null,
    },
  };
}

export function stewardV6Contract(integration, manifest, actionManifests, routeContract, room) {
  const groundFloorY = room.groundFloorY || 0;
  const shiftPoint = ([x, y]) => [x, y + groundFloorY];
  const shiftBox = ([left, top, right, bottom]) => [left, top + groundFloorY, right, bottom + groundFloorY];
  const sourceMole = integration.stewardMole;
  const stewardIntegration = {
    ...sourceMole,
    homeWorldFoot: shiftPoint(sourceMole.homeWorldFoot),
    shelfWorldFoot: shiftPoint(sourceMole.shelfWorldFoot),
    outboundWaypoints: sourceMole.outboundWaypoints.map(shiftPoint),
    returnWaypoints: sourceMole.returnWaypoints.map(shiftPoint),
    propVisibility: {
      ...sourceMole.propVisibility,
      fixedDeskStackWorldBBox: shiftBox(sourceMole.propVisibility.fixedDeskStackWorldBBox),
      shelfPatchWorldBBox: shiftBox(sourceMole.propVisibility.shelfPatchWorldBBox),
    },
  };
  const shiftedRoute = {
    ...routeContract,
    outboundWaypoints: routeContract.outboundWaypoints.map(shiftPoint),
    returnWaypoints: routeContract.returnWaypoints.map(shiftPoint),
  };
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
  // Optional v6 working/sleeping sheets use the same action manifest loader.
  // Keep the existing idle pose until reviewed assets are integrated.
  animations.working ||= { ...wait, sharedArtWith: 'wait-empty', frameIndices: [0], frameDurationsMs: [1000], static: true };
  return {
    id: manifest.id,
    revision: manifest.id,
    role: 'steward',
    frameSize: [...manifest.frameSize],
    anchor: [...manifest.anchor],
    animations,
    localActions: animations.sleeping ? ['sleeping'] : [],
    deskDock: {
      roomOrigin: [room.groundFloorX || 0, room.groundFloorY || 0],
      worldAnchor: [...stewardIntegration.homeWorldFoot],
      characterDepthY: stewardIntegration.homeWorldFoot[1],
      frontLayerDepthY: frontDepthForRole(room, 'steward'),
    },
    steward: { manifest, routeContract: shiftedRoute, integration: stewardIntegration },
  };
}

export function bindStewardStates(contract, manifests) {
  for (const action of ['working', 'sleeping', 'enter-working', 'exit-working', 'enter-sleeping', 'exit-sleeping']) {
    const item = manifests[action]; if (!item) throw new Error(`鼹鼠动作资源未加载：${action}`);
    contract.animations[action] = { textureKey: `coworker-steward-n4-${action}`, frameSize: item.frameSize, anchor: item.anchor,
      frameIndices: Array.from({length:item.frameCount},(_,i)=>i), frameDurationsMs:item.frameDurationsMs,
      // idle is the existing exact wait-empty frame 0 endpoint.
      frameDurationMs:item.cycleDurationMs/item.frameCount, loop:item.loop, returnTo:item.returnTo === 'wait-empty' ? 'idle' : item.returnTo,
      safeSwitchFrameIndices:[0], continuityProfile:'steward-n4', transition:action.startsWith('enter-') || action.startsWith('exit-') };
  }
  for (const [alias, action] of Object.entries({'rest-to-work':'enter-working','work-to-rest':'exit-working','idle-to-sleep':'enter-sleeping','sleep-to-idle':'exit-sleeping'})) contract.animations[alias] = contract.animations[action];
  contract.localActions = ['sleeping']; contract.revision += '+n4-work-sleep'; return contract;
}

// The integrator enables the v8 pack only after its real assets pass visual review.
function updateInteractiveHitArea(sprite, hitArea) {
  const rectangle = new Phaser.Geom.Rectangle(...hitArea);
  if (sprite.input) Object.assign(sprite.input, { hitArea: rectangle, hitAreaCallback: Phaser.Geom.Rectangle.Contains, customHitArea: true, enabled: true });
  else sprite.setInteractive(rectangle, Phaser.Geom.Rectangle.Contains);
}

function qualityPlacement(placement, origin, role) {
  const { scale, registrationPoint, worldPoint } = placement;
  if (!(Number.isFinite(scale) && scale > 0) || ![registrationPoint, worldPoint].every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) throw new Error(`Invalid placement: ${role}`);
  return { ...placement, registrationPoint: [...registrationPoint], worldPoint: worldPoint.map((value, axis) => value + origin[axis]) };
}

function stewardSeatingRoute(contract, foot, home) {
  const approach = contract?.seating?.approachPoint || home;
  return [foot, ...(contract?.seating?.routeFromBurrow || [[foot[0], approach[1]]]), approach];
}

export function bindQualityStates(contract, manifest) {
  const origin = contract.deskDock?.roomOrigin || [0, 0];
  if (manifest.placement) contract.placement = qualityPlacement(manifest.placement, origin, contract.role);
  if (manifest.seating) {
    const seating = manifest.seating;
    const points = [seating.approachPoint, ...(seating.logicalFootPoint ? [seating.logicalFootPoint] : []), ...(seating.routeFromBurrow || [])];
    if (!points.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) throw new Error(`Invalid seating route: ${contract.role}`);
    contract.seating = { ...seating, approachPoint: seating.approachPoint.map((value, axis) => value + origin[axis]),
      ...(seating.logicalFootPoint ? { logicalFootPoint: seating.logicalFootPoint.map((value, axis) => value + origin[axis]) } : {}),
      ...(seating.routeFromBurrow ? { routeFromBurrow: seating.routeFromBurrow.map((point) => point.map((value, axis) => value + origin[axis])) } : {}) };
  }
  if (manifest.stationPatch === null) contract.deskDock.stationPatch = null;
  if (manifest.occlusionPatch) {
    const origin = contract.deskDock?.roomOrigin || [0, 0];
    contract.deskDock.occlusionPatch = { ...manifest.occlusionPatch, worldPosition: manifest.occlusionPatch.worldTopLeft.map((value, axis) => value + origin[axis]) };
  }
  const aliases = { work: 'working', awakeIdle: 'idle', fallAsleep: 'enter-sleeping', sleepLoop: 'sleeping', wakeUp: 'exit-sleeping' };
  const transitions = { 'enter-sleeping': ['idle-to-sleep', 'sleeping'], 'exit-sleeping': ['sleep-to-idle', 'idle'], 'enter-working': ['rest-to-work', 'working'], 'exit-working': ['work-to-rest', 'idle'] };
  for (const action of ['rest-to-work', 'work-to-rest', 'idle-to-sleep', 'sleep-to-idle']) delete contract.animations[action];
  for (const [name, item] of Object.entries(manifest.states)) {
    const action = aliases[name] || name;
    const frames = item.frameIndices || Array.from({ length: item.frameCount }, (_, i) => i);
    if (!frames.length || !frames.includes(item.staticFrameIndex)) throw new Error(`Invalid stable frame: ${contract.role}/${action}`);
    const transition = transitions[action];
    const animation = { ...item, textureKey: `coworker-${contract.role}-v8-${name}`, frontTextureKey: item.frontSpritesheet ? `coworker-${contract.role}-v8-${name}-front` : null, frameSize: [...manifest.frameSize], anchor: [...(item.anchor || manifest.anchor)], frameIndices: [...frames],
      safeSwitchFrameIndices: item.safeSwitchFrameIndices || [], continuityProfile: 'quality-v8', transition: Boolean(transition), returnTo: item.returnTo || transition?.[1] };
    if (item.placement) {
      animation.placement = qualityPlacement(item.placement, origin, `${contract.role}/${action}`);
      contract.hasStatePlacement = true;
    }
    contract.animations[action] = animation;
    if (transition) contract.animations[transition[0]] = animation;
  }
  if (contract.seating) {
    for (const action of [contract.seating.sitAction || 'sit-down', contract.seating.standAction || 'stand-up']) {
      const animation = contract.animations[action];
      if (animation && (animation.loop || animation.transition)) throw new Error(`Seating action must be a dedicated one-shot: ${contract.role}/${action}`);
      const marker = animation?.[action === (contract.seating.sitAction || 'sit-down') ? 'seatContactFrame' : 'groundContactFrame'];
      if (marker !== undefined && (!Number.isInteger(marker) || marker < 0 || marker >= animation.frameIndices.length)) throw new Error(`Invalid seating support frame: ${contract.role}/${action}`);
    }
  }
  for (const [action, animation] of Object.entries(contract.animations)) {
    const mapping = animation.startFrameByAction;
    if (mapping === undefined) continue;
    if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error(`Invalid start-frame mapping: ${contract.role}/${action}`);
    for (const [source, starts] of Object.entries(mapping)) {
      const sourceFrames = contract.animations[source]?.frameIndices;
      if (!Array.isArray(starts) || starts.length !== sourceFrames?.length || !starts.every((index) => Number.isInteger(index) && index >= 0 && index < animation.frameIndices.length)) throw new Error(`Invalid start-frame mapping: ${contract.role}/${action}/${source}`);
    }
  }
  contract.localActions = manifest.localActions ?? ['sleeping'];
  contract.qualityRevision = manifest.id;
  contract.revision += `+${manifest.id}`;
  return contract;
}

export function stableCoworkerFrame(spec) {
  return spec.frames.includes(spec.animation.staticFrameIndex) ? spec.animation.staticFrameIndex : spec.frames[0];
}

// Small feet are independent of artwork, tails, and upper-body desk occlusion.
const FOOT_PROBES = [[0, 0], [-9, -5], [9, -5], [-9, 5], [9, 5]];
export function walkableFoot(room, x, y) {
  return FOOT_PROBES.every(([dx, dy]) => {
    const px = x + dx; const py = y + dy;
    if (!room.walkablePolygons.some((points) => pointInPolygon(px, py, points))) return false;
    return !room.blockedRects.some(({ rect: [left, top, width, height] }) => px >= left && px <= left + width && py >= top && py <= top + height);
  });
}

function footSegmentWalkable(room, ax, ay, bx, by) {
  // Exact clipping prevents even a short corner crossing between sampled foot positions.
  for (const [dx, dy] of FOOT_PROBES) for (const { rect } of room.blockedRects) {
    let enter = 0, leave = 1;
    for (let axis = 0; axis < 2; axis++) {
      const start = axis ? ay + dy : ax + dx;
      const delta = axis ? by - ay : bx - ax;
      if (!delta) { if (start < rect[axis] || start > rect[axis] + rect[axis + 2]) { enter = 2; break; } }
      else {
        const a = (rect[axis] - start) / delta, b = (rect[axis] + rect[axis + 2] - start) / delta;
        enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
      }
    }
    if (enter <= leave) return false;
  }
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
  for (let i = 0; i <= steps; i++) if (!walkableFoot(room, ax + (bx - ax) * i / steps, ay + (by - ay) * i / steps)) return false;
  return true;
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
  let frames = isStatic ? [animation.staticFrameIndex ?? animation.frameIndices?.[0] ?? 0] : animation.frameIndices || (Array.isArray(animation.frames) ? animation.frames : null);
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

export function scaledCoworkerHitArea(hitArea, scale = 1, [offsetX, offsetY] = [0, 0]) {
  return [hitArea[0] * scale + offsetX, hitArea[1] * scale + offsetY, hitArea[2] * scale, hitArea[3] * scale];
}

export function seatedBodyRenderOffset(anchor, registrationPoint, scale = 1) {
  if (!Array.isArray(registrationPoint) || registrationPoint.length !== 2) return [0, 0];
  return [(1 - scale) * (registrationPoint[0] - anchor[0]) || 0, (1 - scale) * (registrationPoint[1] - anchor[1]) || 0];
}

export function seatedRoleBodyRenderOffset(role, anchor, registrationPoint, scale = 1) {
  const base = seatedBodyRenderOffset(anchor, registrationPoint, scale);
  const correction = SEATED_ROLE_POSITION_CORRECTION[role] || [0, 0];
  return [base[0] + correction[0], base[1] + correction[1]];
}

export function coworkerRenderTransform(contract, anchor, action = 'idle') {
  const placement = contract?.animations?.[action]?.placement || contract?.placement;
  const base = contract?.animations?.[action]?.placement ? contract.seating?.approachPoint || contract.deskDock.worldAnchor : contract?.deskDock?.worldAnchor;
  const scale = placement?.scale || SEATED_ROLE_RENDER_SCALE[contract?.role] || 1;
  const offset = placement ? placement.worldPoint.map((value, axis) => value - base[axis] - (placement.registrationPoint[axis] - anchor[axis]) * scale)
    : seatedRoleBodyRenderOffset(contract?.role, anchor, contract?.deskDock?.renderRegistrationPoint, scale);
  return { scale, offset };
}


export function coworkerLocalActions(contract) {
  const configured = contract?.localActions || contract?.behavior?.localActions || [];
  return configured
    .map((item) => typeof item === 'string' ? item : item?.action)
    .filter((action) => action && !['idle', 'working'].includes(action) && contract?.animations?.[action]);
}

export function coworkerTransitionSafeFrames(fromAction, toAction, currentSpec) {
  if (currentSpec?.animation?.continuityProfile === 'quality-v8') return currentSpec.animation.safeSwitchFrameIndices || [];
  if (currentSpec?.isStatic) return currentSpec.frames?.length ? [currentSpec.frames[0]] : [];
  if (currentSpec?.animation?.continuityProfile === 'steward-n4') return currentSpec.animation.safeSwitchFrameIndices;
  if (fromAction === 'working' && toAction === 'work-to-rest') return [13];
  if (fromAction === 'idle' && toAction === 'rest-to-work') return [0];
  if (fromAction === 'idle' && toAction === 'idle-to-sleep') return [0];
  if (fromAction === 'sleeping' && toAction === 'sleep-to-idle') return [0];
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
  learning_available: '可继续学习', cancelled: '本次已取消',
  working: '正在工作', understanding: '正在理解', creating: '正在准备', queued: '准备开始',
  handoff: '正在交接', waiting: '等待其他工作', awaiting_project: '等待文件夹',
  stopping: '正在停止', stopped: '已停止', interrupted: '工作中断', unknown: '状态待确认',
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
      roles: [...scene.people.entries()].map(([role, person]) => ({ role, action: person.localAction, pendingAction: person.pendingAction?.action || person.pendingTaskAction?.action || null, pendingThen: person.pendingAction?.then?.action || null, afterTransition: person.afterTransition?.action || null, source: person.actionSource, active: person.active, depth: person.sprite.depth, alpha: person.sprite.alpha, desiredAction: person.desiredAction, frame: person.sprite.getByName('body').frame?.name ?? 0, position: [Math.round(person.sprite.x), Math.round(person.sprite.y)] })),
      steward: scene.stewardRoutine ? { phase: scene.stewardRoutine.phase, completed: scene.stewardRoutine.completed, bookOwner: scene.stewardRoutine.bookOwner, paused: [...scene.stewardRoutine.pauseReasons] } : null,
      burrow: scene.stewardBurrow ? { action: scene.stewardBurrow.action, worldFoot: [scene.stewardBurrow.x, scene.stewardBurrow.y], workbench: scene.stewardBurrow.workbench } : null,
    }),
    scene,
  };
}

export class OfficeGrid {
  constructor(matrix) {
    this.matrix = matrix;
  }

  isWalkable(x, y) {
    return y >= 0 && y < this.matrix.length && x >= 0 && x < this.matrix[0].length && this.matrix[y][x] === 0;
  }

  findPath(from, to, { canOccupy = () => true, canTraverse = () => true } = {}) {
    if (!this.isWalkable(from.x, from.y) || !this.isWalkable(to.x, to.y) || !canOccupy(to.x, to.y)) return Promise.resolve(null);
    if (from.x === to.x && from.y === to.y) return Promise.resolve([{ ...from }]);
    // Each request owns its occupancy snapshot; a later request cannot mutate an older search.
    const matrix = this.matrix.map((row, y) => row.map((tile, x) => tile || (canOccupy(x, y) ? 0 : 1)));
    const finder = new EasyStar.js();
    finder.setGrid(matrix); finder.setAcceptableTiles([0]); finder.enableDiagonals(); finder.disableCornerCutting(); finder.enableSync();
    const directions = [[0,-1,EasyStar.TOP],[1,-1,EasyStar.TOP_RIGHT],[1,0,EasyStar.RIGHT],[1,1,EasyStar.BOTTOM_RIGHT],[0,1,EasyStar.BOTTOM],[-1,1,EasyStar.BOTTOM_LEFT],[-1,0,EasyStar.LEFT],[-1,-1,EasyStar.TOP_LEFT]];
    matrix.forEach((row, y) => row.forEach((tile, x) => {
      if (tile) return;
      const allowed = directions.filter(([dx, dy]) => canTraverse({ x: x + dx, y: y + dy }, { x, y })).map(([, , direction]) => direction);
      if (allowed.length !== 8) finder.setDirectionalCondition(x, y, allowed);
    }));
    let result = null;
    finder.findPath(from.x, from.y, to.x, to.y, (path) => { result = path; });
    finder.calculate();
    return Promise.resolve(result);
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
    if (QUALITY_PACK_ENABLED) {
      this.load.json(QUALITY_MANIFEST_KEY, `${QUALITY_ROOT}manifest.json`);
      this.load.once(`filecomplete-json-${QUALITY_MANIFEST_KEY}`, (_key, _type, manifest) => {
        for (const [role, binding] of Object.entries(manifest.roles || {})) {
          const key = `quality-v8-${role}`;
          const directory = binding.manifest.slice(0, binding.manifest.lastIndexOf('/') + 1);
          this.load.json(key, `${QUALITY_ROOT}${binding.manifest}`);
          this.load.once(`filecomplete-json-${key}`, (_k, _t, item) => {
            const version = `?v=${encodeURIComponent(item.id || manifest.id)}`;
            for (const [action, state] of Object.entries(item.states)) {
              this.load.spritesheet(`coworker-${role}-v8-${action}`, `${QUALITY_ROOT}${directory}${state.spritesheet}${version}`, { frameWidth: item.frameSize[0], frameHeight: item.frameSize[1] });
              if (state.frontSpritesheet) this.load.spritesheet(`coworker-${role}-v8-${action}-front`, `${QUALITY_ROOT}${directory}${state.frontSpritesheet}${version}`, { frameWidth: item.frameSize[0], frameHeight: item.frameSize[1] });
            }
            if (item.occlusionPatch?.file) this.load.image(`coworker-${role}-v8-occlusion`, `${QUALITY_ROOT}${directory}${item.occlusionPatch.file}${version}`);
          });
        }
      });
    }
    this.load.json('office-room-manifest', `${ROOM_ROOT}manifest.json`);
    this.load.json(FLOOR_EXTENSION_KEY, `${FLOOR_EXTENSION_ROOT}manifest.json`);
    this.load.once(`filecomplete-json-${FLOOR_EXTENSION_KEY}`, (_key, _type, extension) => {
      const version = extension?.revision ? `?v=${encodeURIComponent(extension.revision)}` : '';
      this.load.image('office-upper-gallery', `${FLOOR_EXTENSION_ROOT}${extension.upperFloor.visual.runtimeImage}${version}`);
      for (const item of extension.upperFloor.foregroundItems || []) this.load.image(`room-foreground-${item.id}`, `${FLOOR_EXTENSION_ROOT}${item.file}${version}`);
    });
    this.load.json('irixi-v4-manifest', `${ROOM_ROOT}characters/irixi/manifest.json`);
    this.load.json(MOTION_INTEGRATION_KEY, `${MOTION_ROOT}integration-manifest.json`);
    this.load.json(REST_INTEGRATION_KEY, `${REST_ROOT}integration-manifest.json`);
    this.load.json(STEWARD_STATES_KEY, `${STEWARD_STATES_ROOT}manifest.json`);
    this.load.once(`filecomplete-json-${STEWARD_STATES_KEY}`, (_key, _type, manifest) => {
      const version = `?v=${encodeURIComponent(manifest.version)}`;
      for (const entry of manifest.actions) {
        const key = `steward-n4-${entry.action}`; const directory = entry.manifest.slice(0, entry.manifest.lastIndexOf('/') + 1);
        this.load.json(key, `${STEWARD_STATES_ROOT}${entry.manifest}${version}`);
        this.load.once(`filecomplete-json-${key}`, (_actionKey, _actionType, item) => this.load.spritesheet(`coworker-steward-n4-${entry.action}`, `${STEWARD_STATES_ROOT}${directory}${item.spritesheet}${version}`, {frameWidth:item.frameSize[0],frameHeight:item.frameSize[1]}));
      }
    });
    this.load.json(CONTINUITY_INTEGRATION_KEY, `${CONTINUITY_ROOT}integration-manifest.json`);
    this.load.json(REVIEWER_SLEEP_TRANSITION_MANIFEST_KEY, `${REVIEWER_SLEEP_TRANSITION_ROOT}manifest.json`);
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
    this.load.once(`filecomplete-json-${REVIEWER_SLEEP_TRANSITION_MANIFEST_KEY}`, (_key, _type, manifest) => {
      const version = `?v=${encodeURIComponent(manifest.id)}`;
      this.load.spritesheet(REVIEWER_SLEEP_TRANSITION_TEXTURE_KEY, `${REVIEWER_SLEEP_TRANSITION_ROOT}${manifest.spritesheet}${version}`, {
        frameWidth: manifest.frameSize[0], frameHeight: manifest.frameSize[1],
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
    this.motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.motionPreference.matches;
    this.onMotionPreference = () => this.setTask(this.task, this.presence || {});
    this.motionPreference.addEventListener('change', this.onMotionPreference);
    this.events.once('shutdown', () => this.motionPreference.removeEventListener('change', this.onMotionPreference));
    const roomManifest = this.cache.json.get('office-room-manifest');
    const floorExtension = this.cache.json.get(FLOOR_EXTENSION_KEY);
    this.room = normalizeRoomContract(roomManifest, floorExtension);
    this.irixiContract = this.cache.json.get('irixi-v4-manifest');
    this.motionIntegration = this.cache.json.get(MOTION_INTEGRATION_KEY);
    this.restIntegration = this.cache.json.get(REST_INTEGRATION_KEY);
    this.continuityIntegration = this.cache.json.get(CONTINUITY_INTEGRATION_KEY);
    this.coworkerContracts = Object.fromEntries(Object.keys(this.motionIntegration.seatedRoles).map((role) => [role, seatedV6Contract(this.motionIntegration, role, this.cache.json.get(`coworker-${role}-motion-manifest`), this.room, this.restIntegration, this.cache.json.get(`coworker-${role}-rest-manifest`), this.continuityIntegration, this.cache.json.get(`coworker-${role}-continuity-manifest`), role === 'archivist' ? this.cache.json.get('coworker-archivist-rest-continuity-manifest') : null, role === 'reviewer' ? this.cache.json.get(REVIEWER_SLEEP_TRANSITION_MANIFEST_KEY) : null)]));
    const stewardManifest = this.cache.json.get('coworker-steward-motion-manifest');
    const stewardActions = Object.fromEntries(stewardManifest.actions.map(({ action }) => [action, this.cache.json.get(`coworker-steward-${action}-manifest`)]));
    this.coworkerContracts.steward = stewardV6Contract(this.motionIntegration, stewardManifest, stewardActions, this.cache.json.get('coworker-steward-route-contract'), this.room);
    bindStewardStates(this.coworkerContracts.steward, Object.fromEntries(['working','sleeping','enter-working','exit-working','enter-sleeping','exit-sleeping'].map((action)=>[action,this.cache.json.get(`steward-n4-${action}`)])));
    for (const [role, contract] of Object.entries(this.coworkerContracts)) {
      const manifest = this.cache.json.get(`quality-v8-${role}`);
      if (manifest && Object.entries(manifest.states).every(([action, state]) => this.textures.exists(`coworker-${role}-v8-${action}`) && (!state.frontSpritesheet || this.textures.exists(`coworker-${role}-v8-${action}-front`))) && (!manifest.occlusionPatch?.file || this.textures.exists(`coworker-${role}-v8-occlusion`))) bindQualityStates(contract, manifest);
    }
    const coworkerTextures = Object.entries(this.coworkerContracts).flatMap(([role, contract]) => [coworkerAnimationSpec(contract, role, 'idle')?.textureKey, ...Object.keys(contract.animations).flatMap((action) => { const spec = coworkerAnimationSpec(contract, role, action); return [spec?.textureKey, spec?.animation.frontTextureKey]; }), contract.deskDock?.stationPatch?.file ? `coworker-${role}-station-patch` : null, contract.deskDock?.occlusionPatch?.file ? `coworker-${role}-v8-occlusion` : null]);
    ['office-room-base', ...this.irixiContract.directions.order.map((direction) => `irixi-${direction}-idle`), ...this.irixiContract.directions.order.map((direction) => `irixi-${direction}-walk-sheet`), ...coworkerTextures, 'steward-book-stack-desk', 'steward-book-stack-shelf', ...this.room.foregroundItems.map((item) => `room-foreground-${item.id}`)]
      .filter((key) => this.textures.exists(key))
      .forEach((key) => this.textures.get(key).setFilter(Phaser.Textures.FilterMode.LINEAR));
    this.createCoworkerAnimations();
    for (const layer of this.room.backgroundLayers) {
      this.add.image(layer.x + layer.width / 2, layer.y + layer.height / 2, layer.key)
        .setDisplaySize(layer.width, layer.height).setDepth(layer.depth);
    }
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
      const { scale: renderScale, offset: renderOffset } = coworkerRenderTransform(contract, coworkerAnimationSpec(contract, person.role, 'idle')?.anchor || contract.anchor);
      const scaledHitArea = scaledCoworkerHitArea(hitArea, renderScale, renderOffset);
      sprite.setInteractive(new Phaser.Geom.Rectangle(...scaledHitArea), Phaser.Geom.Rectangle.Contains);
      const hasLocalActions = coworkerLocalActions(contract).length > 0;
      const officePerson = { ...person, home: [...home], renderDepth, renderScale, renderOffset, hitArea: scaledHitArea, interactionPoint: [...this.room.workstations[person.role].interactionPoint], sprite, statusText: sprite.labels.getByName('status'), active: false, activitySource: 'local', actionSource: 'local', localEligible: true, localAction: null, localActionIndex: 0, nextLocalActionAt: this.time.now + (hasLocalActions ? localRestDelay(person.role, true) : Number.POSITIVE_INFINITY), pendingAction: null };
      const frontTexture = Object.values(contract.animations).find((animation) => animation.frontTextureKey)?.frontTextureKey;
      if (frontTexture) officePerson.frontSprite = this.add.sprite(0, 0, frontTexture).setVisible(false);
      this.registerCoworkerPointer(sprite, officePerson);
      this.people.set(person.role, officePerson);
      this.setPersonAction(officePerson, 'idle', 'local', true);
    }
    this.setupStewardBurrow();
    this.initializeStewardRoutine();
    this.registerKeyboardControls();
    this.registerScenePointer();
    this.scale.on('resize', () => this.fitCamera());
    this.fitCamera();
    window.irixiOffice = createOfficeBridge(this);
    this.syncDebugState();
    window.dispatchEvent(new CustomEvent('irixi:office-ready'));
  }

  registerCanvasPointerDown(target, handler) {
    target.on('pointerdown', (pointer, ...args) => {
      if (pointer?.event?.target === this.game.canvas) handler(pointer, ...args);
    });
  }

  registerCoworkerPointer(sprite, person) {
    this.registerCanvasPointerDown(sprite, () => this.talkTo(person));
  }

  registerScenePointer() {
    this.registerCanvasPointerDown(this.input, (pointer, gameObjects) => {
      if (!gameObjects.length) this.walkToPointer(pointer);
    });
  }

  setupStewardBurrow() {
    const manifest = this.cache.json.get('quality-v8-steward');
    const actions = ['burrow-enter', 'burrow-sleep', 'burrow-emerge', 'burrow-peek', 'burrow-retreat', 'burrow-exit-work'];
    if (!manifest || this.coworkerContracts.steward.qualityRevision !== manifest.id || !['burrow-ground', 'burrow-front'].every((action) => manifest.states?.[action] && this.textures.exists(`coworker-steward-v8-${action}`)) || !actions.every((action) => manifest.states?.[action] && this.textures.exists(`coworker-steward-v8-${action}`))) return;
    const [x, y] = [manifest.worldFoot?.[0] ?? 944, (manifest.worldFoot?.[1] ?? 244) + (this.room.groundFloorY || 0)];
    if (!walkableFoot(this.room, x, y)) return;
    const home = this.people.get('steward').home;
    const route = stewardSeatingRoute(this.coworkerContracts.steward, [x, y], home);
    for (let leg = 0; leg < route.length - 1; leg++) {
      const [a, b] = [route[leg], route[leg + 1]];
      const count = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4));
      for (let i = 0; i <= count; i++) if (!walkableFoot(this.room, a[0] + (b[0] - a[0]) * i / count, a[1] + (b[1] - a[1]) * i / count)) return;
    }
    const [width, height] = manifest.frameSize;
    const [anchorX, anchorY] = manifest.anchor;
    const base = this.add.sprite(x, y, 'coworker-steward-v8-burrow-ground', 0).setOrigin(anchorX / width, anchorY / height).setDepth(y - 1).setVisible(false);
    const actor = this.add.sprite(x, y, 'coworker-steward-v8-burrow-sleep', 0).setOrigin(anchorX / width, anchorY / height).setDepth(y).setVisible(false);
    const front = this.add.sprite(x, y, 'coworker-steward-v8-burrow-front', 0).setOrigin(anchorX / width, anchorY / height).setDepth(y + 1).setVisible(false);
    base.setInteractive(new Phaser.Geom.Rectangle(...(manifest.hitArea || [82, 185, 92, 45])), Phaser.Geom.Rectangle.Contains);
    this.registerCanvasPointerDown(base, () => this.talkTo(this.people.get('steward')));
    this.registerCanvasPointerDown(actor, () => this.talkTo(this.people.get('steward')));
    this.stewardBurrow = { manifest, x, y, base, actor, front, action: null, generation: 0, listener: null, previewUntil: 0, workbench: false, tween: null, targetPoint: null, advance: null, pauseReasons: new Set() };
    if (document.body.dataset.workbench === 'true') {
      this.stewardBurrow.workbench = true;
      base.setVisible(true);
      front.setVisible(true);
      this.people.get('steward').sprite.setVisible(false);
      this.setStewardBurrowAction('burrow-sleep');
    }
  }

  setStewardBurrowAction(action, next = null, force = false, preservePlayback = false) {
    const burrow = this.stewardBurrow;
    if (!burrow) return;
    if (action === 'burrow-sleep' && this.people.get('steward')?.localEligible === false) action = 'burrow-peek';
    if (burrow.action === action && !force) return;
    next ||= { 'burrow-enter': 'burrow-sleep', 'burrow-emerge': 'burrow-peek', 'burrow-retreat': 'burrow-sleep' }[action] || null;
    this.clearStewardBurrowListener();
    burrow.listener = null;
    burrow.generation += 1;
    const generation = burrow.generation;
    burrow.action = action;
    const state = burrow.manifest.states[action];
    if (state.actorHitArea) updateInteractiveHitArea(burrow.actor, state.actorHitArea);
    const texture = `coworker-steward-v8-${action}`;
    const animation = `steward-${action}`;
    burrow.actor.setVisible(true);
    if (this.reducedMotion) {
      burrow.actor.stop().setTexture(texture).setFrame(state.staticFrameIndex ?? 0);
      if (next === 'working') this.showStewardBurrowWork();
      else if (next === 'burrow-exit-work') this.setStewardBurrowAction(next, 'working');
      else if (next) this.setStewardBurrowAction(next);
      return;
    }
    if (!preservePlayback) burrow.actor.play(animation, true);
    if (!next) return;
    const event = `animationcomplete-${animation}`;
    const callback = () => {
      if (burrow.generation !== generation) return;
      burrow.listener = null;
      if (next === 'working') this.walkStewardBetweenBurrowAndWork(true);
      else if (next === 'burrow-exit-work') this.setStewardBurrowAction(next, 'working');
      else this.setStewardBurrowAction(next);
    };
    burrow.listener = { event, callback };
    burrow.actor.once(event, callback);
  }

  clearStewardBurrowListener() {
    const burrow = this.stewardBurrow;
    if (burrow?.listener) (burrow.listener.emitter || burrow.actor).off(burrow.listener.event, burrow.listener.callback);
    if (burrow?.supportListener) burrow.supportListener.emitter.off(burrow.supportListener.event, burrow.supportListener.callback);
    if (burrow) { burrow.listener = null; burrow.supportListener = null; burrow.finishSeating = null; }
  }

  setStewardSeatSupport(seated) {
    const burrow = this.stewardBurrow;
    const person = this.people.get('steward');
    burrow.seatSupported = seated;
    const seating = this.coworkerContracts?.steward?.seating;
    if (seating?.logicalFootPoint) person.sprite.setDepth(seated ? person.renderDepth : seating.approachPoint[1]);
  }

  playStewardSeating(action, phase, complete) {
    const burrow = this.stewardBurrow;
    const person = this.people.get('steward');
    const animation = this.coworkerContracts?.steward?.animations?.[action];
    if (!animation) { complete(); return; }
    this.clearStewardBurrowListener();
    const generation = ++burrow.generation;
    burrow.action = phase;
    burrow.seatingAction = action;
    const sitting = phase === 'sitting-down';
    this.setStewardSeatSupport(!sitting);
    const body = person.sprite.getByName('body');
    this.setPersonAction(person, action, 'local', true, null, true);
    const event = `animationcomplete-steward-${action}`;
    const callback = () => {
      if (burrow.generation !== generation || burrow.action !== phase) return;
      this.setStewardSeatSupport(sitting);
      this.clearStewardBurrowListener();
      complete();
    };
    burrow.finishSeating = callback;
    if (this.reducedMotion || animation.static) callback();
    else {
      const marker = animation[sitting ? 'seatContactFrame' : 'groundContactFrame'];
      if (Number.isInteger(marker)) {
        const supportUpdate = (_animation, frame) => {
          if (burrow.generation !== generation || burrow.action !== phase) return;
          const index = animation.frameIndices.indexOf(Number(frame.textureFrame ?? frame.name));
          if (index >= marker) this.setStewardSeatSupport(sitting);
        };
        burrow.supportListener = { event: 'animationupdate', callback: supportUpdate, emitter: body };
        body.on('animationupdate', supportUpdate);
        if (marker === 0) this.setStewardSeatSupport(sitting);
      }
      burrow.listener = { event, callback, emitter: body };
      body.once(event, callback);
    }
  }

  sitStewardAtWork() {
    const burrow = this.stewardBurrow;
    const seating = this.coworkerContracts?.steward?.seating;
    if (!seating) { this.showStewardBurrowWork(); return; }
    this.playStewardSeating(seating.sitAction || 'sit-down', 'sitting-down', () => {
      if (burrow.wantsWork) this.showStewardBurrowWork();
      else this.standStewardFromWork();
    });
  }

  standStewardFromWork() {
    const burrow = this.stewardBurrow;
    const seating = this.coworkerContracts?.steward?.seating;
    if (seating?.logicalFootPoint && this.player && feetOverlap(this.player.x, this.player.y, ...seating.approachPoint)) {
      const person = this.people.get('steward');
      if (burrow.action !== 'waiting-to-stand' || (this.coworkerContracts.steward.animations['seated-idle'] && person.localAction !== 'seated-idle')) {
        if (this.coworkerContracts.steward.animations['seated-idle']) this.setPersonAction(person, 'seated-idle', 'local', true, null, true);
        else person.sprite.getByName('body').stop();
      }
      burrow.action = 'waiting-to-stand';
      return;
    }
    this.playStewardSeating(seating?.standAction || 'stand-up', 'standing-up', () => {
      if (burrow.wantsWork) this.sitStewardAtWork();
      else if (this.reducedMotion) {
        this.people.get('steward').sprite.setVisible(false);
        this.setStewardBurrowAction(this.presence?.engagedRole === 'steward' ? 'burrow-peek' : 'burrow-sleep', null, true);
      } else this.walkStewardBetweenBurrowAndWork(false);
    });
  }

  showStewardBurrowWork(status = 'working', force = true) {
    const burrow = this.stewardBurrow;
    const person = this.people.get('steward');
    burrow.action = 'working';
    this.setStewardSeatSupport(true);
    burrow.actor.setVisible(false);
    person.sprite.setVisible(true).setPosition(...(this.coworkerContracts?.steward?.seating?.approachPoint || person.home)).setDepth(person.renderDepth);
    const currentStatus = this.task ? coworkerRuntimeState(this.task, 'steward', this.presence).status : status;
    const stoppedAction = burrow.seatSupported && this.coworkerContracts?.steward?.animations['seated-idle'] ? 'seated-idle' : 'idle';
    this.setPersonAction(person, currentStatus === 'stopping' ? stoppedAction : 'working', 'task', force, null, true);
  }

  walkStewardBetweenBurrowAndWork(toWork) {
    const burrow = this.stewardBurrow;
    const person = this.people.get('steward');
    if (burrow.tween) this.tweens.killTweensOf(person.sprite);
    burrow.tween = null; burrow.targetPoint = null; burrow.advance = null; burrow.pauseReasons.delete('collision');
    burrow.generation += 1;
    const generation = burrow.generation;
    burrow.action = toWork ? 'walking-to-work' : 'walking-to-hole';
    this.setStewardSeatSupport(false);
    burrow.wantsWork = toWork;
    burrow.actor.setVisible(false);
    if (toWork && !person.sprite.visible) person.sprite.setPosition(burrow.x, burrow.y);
    person.sprite.setVisible(true).setDepth(person.sprite.y);
    const route = stewardSeatingRoute(this.coworkerContracts?.steward, [burrow.x, burrow.y], person.home);
    let nearestLeg = 0;
    for (let i = 1; i < route.length - 1; i++) {
      if (pointToSegmentDistance(person.sprite.x, person.sprite.y, ...route[i], ...route[i + 1]) < pointToSegmentDistance(person.sprite.x, person.sprite.y, ...route[nearestLeg], ...route[nearestLeg + 1])) nearestLeg = i;
    }
    const points = toWork ? route.slice(nearestLeg + 1) : route.slice(0, nearestLeg + 1).reverse();
    const advance = () => {
      if (generation !== burrow.generation) return;
      const point = points[0];
      if (!point) {
        burrow.tween = null; burrow.targetPoint = null; burrow.advance = null;
        if (toWork) this.sitStewardAtWork();
        else {
          person.sprite.setVisible(false);
          this.setStewardBurrowAction('burrow-enter');
        }
        return;
      }
      const distance = Math.hypot(point[0] - person.sprite.x, point[1] - person.sprite.y);
      if (distance < 1) { points.shift(); advance(); return; }
      burrow.targetPoint = point;
      const [dx, dy] = [point[0] - person.sprite.x, point[1] - person.sprite.y];
      const direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? 'left' : 'right' : dy < 0 ? 'up' : 'down';
      const action = `walk-empty-${direction}`;
      if (person.localAction !== action) this.setPersonAction(person, action, 'local', true, null, true);
      if (burrow.pauseReasons.size || this.stewardBurrowRouteBlocked(person.sprite.x, person.sprite.y, point)) return;
      points.shift();
      burrow.tween = this.tweens.add({ targets: person.sprite, x: point[0], y: point[1], duration: distance / MOLE_ROUTE_SPEED * 1000,
        ease: 'Linear', onUpdate: () => { person.sprite.setDepth(person.sprite.y); if (this.stewardBurrowRouteBlocked(person.sprite.x, person.sprite.y, point)) this.pauseStewardBurrowMotion('collision'); }, onComplete: () => { if (generation !== burrow.generation) return; burrow.tween = null; advance(); } });
    };
    burrow.advance = advance;
    advance();
  }

  stewardBurrowRouteBlocked(x, y, point) {
    const player = this.player;
    return Boolean(player && pointToSegmentDistance(player.x, player.y, x, y, ...point) < 38);
  }

  pauseStewardBurrowMotion(reason) {
    const burrow = this.stewardBurrow;
    if (!burrow || !['walking-to-hole', 'walking-to-work'].includes(burrow.action)) return;
    burrow.pauseReasons.add(reason);
    burrow.tween?.pause?.();
  }

  updateStewardBurrowMotionPause() {
    const burrow = this.stewardBurrow;
    if (burrow?.workbench && burrow.action === 'waiting-to-stand') {
      if (burrow.wantsWork) this.showStewardBurrowWork();
      else this.standStewardFromWork();
      return;
    }
    if (!burrow?.workbench || !['walking-to-hole', 'walking-to-work'].includes(burrow.action)) return;
    const person = this.people.get('steward');
    if (burrow.pauseReasons.has('conversation') && this.presence?.engagedRole !== 'steward' && this.time.now >= burrow.previewUntil) burrow.pauseReasons.delete('conversation');
    if (burrow.targetPoint && this.stewardBurrowRouteBlocked(person.sprite.x, person.sprite.y, burrow.targetPoint)) this.pauseStewardBurrowMotion('collision');
    else burrow.pauseReasons.delete('collision');
    if (!burrow.pauseReasons.size) {
      burrow.tween?.resume?.();
      if (!burrow.tween) burrow.advance?.();
    }
  }

  syncStewardBurrow(person, active, status, presence, motionChanged = false) {
    const burrow = this.stewardBurrow;
    if (presence.engagedRole === 'steward') burrow.previewUntil = 0;
    const engaged = presence.engagedRole === 'steward' || this.time.now < burrow.previewUntil;
    const enteringWorkbench = !burrow.workbench;
    burrow.wantsWork = active && status !== 'stopping';
    burrow.workbench = true;
    burrow.base.setVisible(true);
    burrow.front.setVisible(true);
    if (burrow.action === 'waiting-to-stand') {
      if (burrow.wantsWork) this.showStewardBurrowWork();
      return;
    }
    if (['sitting-down', 'standing-up'].includes(burrow.action)) {
      if (motionChanged && this.reducedMotion) {
        this.setPersonAction(person, burrow.seatingAction, 'local', true, null, true);
        burrow.finishSeating?.();
      }
      return;
    }
    if (active && status !== 'stopping') {
      burrow.previewUntil = 0;
      burrow.pauseReasons.delete('conversation');
      if (this.reducedMotion && ['walking-to-work', 'walking-to-hole'].includes(burrow.action)) {
        this.tweens.killTweensOf(person.sprite); burrow.tween = null;
        this.showStewardBurrowWork(status);
        return;
      }
      if (burrow.action === 'walking-to-work') return;
      if (burrow.action === 'walking-to-hole') { this.walkStewardBetweenBurrowAndWork(true); return; }
      if (burrow.action === 'burrow-emerge' && burrow.workRequested) return;
      if (status !== 'stopping' && !enteringWorkbench && ['burrow-sleep', 'burrow-enter', 'burrow-retreat', 'burrow-emerge'].includes(burrow.action) && !this.reducedMotion) {
        burrow.workRequested = true;
        this.setStewardBurrowAction('burrow-emerge', 'burrow-exit-work', burrow.action === 'burrow-emerge');
        return;
      }
      if (status !== 'stopping' && !enteringWorkbench && burrow.action && !['working', 'burrow-exit-work'].includes(burrow.action) && !this.reducedMotion) {
        person.sprite.setVisible(false);
        this.setStewardBurrowAction('burrow-exit-work', 'working');
        return;
      }
      if (burrow.action === 'burrow-exit-work' && !this.reducedMotion) return;
      this.clearStewardBurrowListener();
      burrow.listener = null; burrow.generation += 1;
      this.showStewardBurrowWork(status, motionChanged || burrow.action !== 'working' || !person.sprite.visible);
      return;
    }
    if (burrow.workRequested && burrow.action === 'burrow-emerge' && engaged) {
      // The old completion callback still points to work. Keep the current frame, but retarget its completion.
      this.setStewardBurrowAction('burrow-emerge', 'burrow-peek', true, true);
    }
    burrow.workRequested = false;
    if (this.reducedMotion && ['walking-to-work', 'walking-to-hole'].includes(burrow.action)) {
      this.tweens.killTweensOf(person.sprite); burrow.tween = null;
      person.sprite.setVisible(false).setPosition(...person.home);
      this.setStewardBurrowAction(engaged ? 'burrow-peek' : 'burrow-sleep', null, true);
      return;
    }
    if (burrow.action === 'walking-to-hole') return;
    if (burrow.action === 'walking-to-work') { this.walkStewardBetweenBurrowAndWork(false); return; }
    if (burrow.action === 'working' && !this.reducedMotion) { this.standStewardFromWork(); return; }
    if (person.sprite.visible) person.sprite.getByName?.('body')?.stop?.();
    person.sprite.setVisible(false);
    const desired = engaged || person.localEligible === false ? 'burrow-peek' : 'burrow-sleep';
    if (motionChanged) { this.setStewardBurrowAction(desired, null, true); return; }
    if (burrow.action === desired || (desired === 'burrow-peek' && burrow.action === 'burrow-emerge') || (desired === 'burrow-sleep' && ['burrow-enter', 'burrow-retreat'].includes(burrow.action))) return;
    if (this.reducedMotion || enteringWorkbench) this.setStewardBurrowAction(desired);
    else if (desired === 'burrow-peek') this.setStewardBurrowAction('burrow-emerge');
    else if (burrow.action === 'burrow-peek' || burrow.action === 'burrow-emerge') this.setStewardBurrowAction('burrow-retreat');
    else this.setStewardBurrowAction('burrow-enter');
  }

  fitCamera() {
    const width = this.scale.width;
    const height = this.scale.height;
    const camera = this.cameras.main;
    const floorWidth = this.room.floorWidth || this.room.width;
    const zoom = Math.max(crispZoom(width, height, floorWidth, this.room.floorHeight), height / this.room.floorHeight, width / (floorWidth - TILE * 4));
    camera.setBounds(0, 0, this.room.width, this.room.height);
    camera.setZoom(zoom);
    this.centerCameraOnPlayer();
  }

  centerCameraOnPlayer() {
    const camera = this.cameras.main;
    const viewWidth = this.scale.width / camera.zoom;
    const viewHeight = this.scale.height / camera.zoom;
    const playerX = this.player?.x ?? this.room.width / 2;
    const playerY = (this.player?.y ?? (this.room.groundFloorY + this.room.floorHeight / 2)) + (this.dialogueBottomInset || 0) / (2 * camera.zoom);
    const visibleLayers = this.room.backgroundLayers?.filter((layer) => playerY + viewHeight / 2 > layer.y && playerY - viewHeight / 2 < layer.y + layer.height);
    const minX = visibleLayers?.length ? Math.max(...visibleLayers.map((layer) => layer.x)) : 0;
    const maxX = visibleLayers?.length ? Math.min(...visibleLayers.map((layer) => layer.x + layer.width)) : this.room.width;
    const clampCenter = (value, min, max, view) => view >= max - min ? (min + max) / 2 : Math.max(min + view / 2, Math.min(max - view / 2, value));
    camera.centerOn(clampCenter(playerX, minX, maxX, viewWidth), clampCenter(playerY, 0, this.room.height, viewHeight));
  }

  makeCollisionMap() {
    return Array.from({ length: this.room.rows }, (_, y) => Array.from({ length: this.room.columns }, (_, x) => {
      const px = x * TILE + TILE / 2; const py = (y + 1) * TILE;
      return walkableFoot(this.room, px, py) ? 0 : 1;
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
      const occlusion = contract.deskDock?.occlusionPatch;
      if (occlusion?.file) this.add.image(...occlusion.worldPosition, `coworker-${role}-v8-occlusion`).setOrigin(0, 0).setDepth(contract.deskDock.frontLayerDepthY);
      const patch = contract.deskDock?.stationPatch;
      const key = `coworker-${role}-station-patch`;
      if (!patch?.file || !this.textures.exists(key)) continue;
      const [x, y] = patch.worldPosition;
      this.add.image(x, y, key).setOrigin(0, 0).setDepth((contract.deskDock.characterDepthY ?? contract.deskDock.worldAnchor[1]) - 1);
    }
  }

  drawStewardProps() {
    const props = this.coworkerContracts.steward.steward.integration.propVisibility;
    const [deskX, deskY, deskRight, deskBottom] = props.fixedDeskStackWorldBBox;
    const [shelfX, shelfY, shelfRight, shelfBottom] = props.shelfPatchWorldBBox;
    this.stewardDeskStack = this.add.image(deskX, deskY, 'steward-book-stack-desk').setOrigin(0, 0).setDisplaySize(deskRight - deskX, deskBottom - deskY).setDepth(deskBottom - 1).setVisible(false);
    this.stewardShelfStack = this.add.image(shelfX, shelfY, 'steward-book-stack-shelf').setOrigin(0, 0).setDisplaySize(shelfRight - shelfX, shelfBottom - shelfY).setDepth(this.coworkerContracts.steward.steward.integration.shelfWorldFoot[1] - 1).setVisible(false);
  }

  syncStewardProps() {
    const legacy = !Array.isArray(this.task?.colleagues) && !this.stewardBurrow?.workbench;
    const owner = this.stewardRoutine?.bookOwner || 'desk';
    this.stewardDeskStack?.setVisible(legacy && owner === 'desk');
    this.stewardShelfStack?.setVisible(legacy && owner === 'shelf');
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


  makeAnimal(cx, cy, character, label, owl) {
    const c = this.add.container(cx * TILE + TILE / 2, cy * TILE + TILE).setDepth(cy * TILE + TILE);
    const shadow = this.add.ellipse(0, 1, owl ? 70 : 58, owl ? 18 : 15, 0x1b100b, .3);
    const contract = owl ? this.irixiContract : this.coworkerContracts[character.role];
    const idleSpec = !owl && coworkerAnimationSpec(contract, character.role, 'idle');
    const texture = owl ? 'irixi-down-idle' : idleSpec && this.textures.exists(idleSpec.textureKey) ? idleSpec.textureKey : `${FALLBACK_SPECIES[character.role]}-sheet`;
    const frameSize = idleSpec?.frameSize || contract?.frameSize || [64, 72];
    const anchor = idleSpec?.anchor || contract?.anchor || [32, 68];
    const body = this.add.sprite(0, 0, texture, idleSpec?.frames?.[0] || 0).setOrigin(anchor[0] / frameSize[0], anchor[1] / frameSize[1]).setName('body');
    if (!owl) {
      const transform = coworkerRenderTransform(contract, anchor);
      body.setScale(transform.scale);
      body.setPosition(...transform.offset);
    }
    body.setData('runtime', !owl && Boolean(idleSpec && this.textures.exists(idleSpec.textureKey)));
    if (owl) body.play('irixi-down-idle');
    const name = this.add.text(0, 9, label, { fontFamily: 'system-ui', fontSize: '10px', color: '#fff3cf', backgroundColor: '#183b32', padding: { x: 4, y: 2 } }).setOrigin(.5, 0);
    const status = this.add.text(0, 24, '待命', { name: 'status', fontFamily: 'system-ui', fontSize: '8px', color: '#d9c79e', backgroundColor: '#1a120ee8', padding: { x: 3, y: 2 } }).setOrigin(.5, 0).setName('status');
    // Labels live above furniture; the body keeps its authored desk occlusion.
    const labels = this.add.container(c.x, c.y, [name, status]).setDepth(10000);
    c.labels = labels;
    c.add([shadow, body]);
    if (owl) status.setVisible(false);
    return c;
  }

  syncCharacterLayers() {
    const steward = this.people?.get('steward');
    const burrow = this.stewardBurrow?.workbench && steward && !steward.sprite.visible ? this.stewardBurrow : null;
    for (const [role, sprite] of [['irixi', this.player], ...[...(this.people?.entries() || [])].map(([role, person]) => [role, person.sprite])]) {
      const labels = sprite?.labels;
      const [dx, dy] = COWORKER_LABEL_OFFSET[role] || [0, 0];
      if (labels) labels.setPosition((sprite === steward?.sprite && burrow ? burrow.x : sprite.x) + dx, (sprite === steward?.sprite && burrow ? burrow.y : sprite.y) + dy);
    }
    for (const person of this.people?.values() || []) { this.syncCoworkerFrontLayer(person); this.syncSleepingIndicator(person); }
  }

  syncSleepingIndicator(person, time = this.time?.now || 0) {
    if (person.role === 'steward') return;
    const sleeping = person.localAction === 'sleeping' && person.desiredAction === 'sleeping' && person.localEligible && !person.active && this.presence?.engagedRole !== person.role;
    if (!sleeping) { person.sleepIndicator?.setVisible(false); return; }
    if (!person.sleepIndicator && this.add?.text) person.sleepIndicator = this.add.text(0, 0, 'Z', { fontFamily: 'sans-serif', fontSize: '13px', color: '#efe3ca', stroke: '#49392e', strokeThickness: 3 }).setOrigin(.5, 1);
    if (!person.sleepIndicator) return;
    const spec = coworkerAnimationSpec(this.coworkerContracts[person.role], person.role, 'sleeping');
    const { scale, offset } = coworkerRenderTransform(this.coworkerContracts[person.role], spec.anchor, 'sleeping');
    const [headX, headY] = spec.animation.sleepIndicatorAnchor || SLEEP_HEAD_ANCHOR[person.role];
    const phase = (time % 2400) / 2400;
    person.sleepIndicator.setVisible(true).setDepth(person.sprite.y + 120)
      .setPosition(person.sprite.x + offset[0] + (headX - spec.anchor[0]) * scale + 10, person.sprite.y + offset[1] + (headY - spec.anchor[1]) * scale - 4 - (this.reducedMotion ? 0 : Math.min(phase / .8, 1) * 6))
      .setAlpha(this.reducedMotion ? .75 : Math.max(0, Math.min(phase / .15, (.8 - phase) / .2, 1)) * .8);
  }

  syncCoworkerFrontLayer(person) {
    const front = person.frontSprite;
    if (!front) return;
    const contract = this.coworkerContracts[person.role];
    const spec = coworkerAnimationSpec(contract, person.role, person.localAction || 'idle');
    const body = person.sprite.getByName('body');
    if (!spec?.animation.frontTextureKey || !person.sprite.visible || !body.visible) { front.setVisible(false); return; }
    const { scale, offset } = coworkerRenderTransform(contract, spec.anchor, person.localAction || 'idle');
    front.setVisible(true).setTexture(spec.animation.frontTextureKey).setFrame(body.frame?.name ?? 0)
      .setOrigin(spec.anchor[0] / spec.frameSize[0], spec.anchor[1] / spec.frameSize[1])
      .setScale(scale).setPosition(person.sprite.x + offset[0], person.sprite.y + offset[1])
      .setDepth(contract.deskDock.frontLayerDepthY + 1).setAlpha(person.sprite.alpha * body.alpha);
  }

  inputLocked() {
    const active = document.activeElement;
    return Boolean(this.composing || document.querySelector('dialog[open]')) || isEditableTarget(active);
  }

  registerKeyboardControls() {
    const keyCodes = Phaser.Input.Keyboard.KeyCodes;
    this.cursors = this.input.keyboard.addKeys({ up: keyCodes.UP, down: keyCodes.DOWN, left: keyCodes.LEFT, right: keyCodes.RIGHT }, false);
    this.keys = this.input.keyboard.addKeys('W,A,S,D,ESC', false);
    this.input.keyboard.on('keydown-ESC', () => this.cancelWalk('已取消自动走近。'));
    const focusText = (event) => { if (isEditableTarget(event.target)) this.stopWalkForTextInput(); };
    const composeStart = () => { this.composing = true; this.stopWalkForTextInput(); this.input.keyboard.resetKeys(); };
    const composeEnd = () => { this.composing = false; this.input.keyboard.resetKeys(); };
    document.addEventListener('focusin', focusText);
    document.addEventListener('compositionstart', composeStart);
    document.addEventListener('compositionend', composeEnd);
    this.events?.once('shutdown', () => { document.removeEventListener('focusin', focusText); document.removeEventListener('compositionstart', composeStart); document.removeEventListener('compositionend', composeEnd); });
    this.registerMovementCancellation();
  }

  registerMovementCancellation() {
    this.input.keyboard.on('keydown', (event) => {
      const locked = event.isComposing || event.keyCode === 229 || this.inputLocked() || isEditableTarget(event.target);
      if (locked && (event.isComposing || event.keyCode === 229 || isEditableTarget(event.target))) this.stopWalkForTextInput();
      if (!locked && isMovementKey(event.key)) event.preventDefault();
      const automaticWalking = this.pathPending || this.path.length > 0 || (this.stepInProgress && !this.manualMoving);
      if (automaticWalking && !locked && isMovementKey(event.key)) this.cancelWalk();
    });
  }

  stopWalkForTextInput() {
    if (this.pathPending || this.path.length || this.stepInProgress || this.manualMoving) this.cancelWalk('', { preservePosition: true });
  }

  update(time) {
    this.updateCoworkerTransitions();
    this.updateStewardMotionPause();
    this.updateStewardBurrowMotionPause();
    this.updateStewardRoutine(time);
    this.updateLocalCoworkers(time);
    this.syncCharacterLayers();
    this.centerCameraOnPlayer();
    if (time - this.lastRoleDebugAt >= 240) {
      this.syncRoleDebug();
      this.lastRoleDebugAt = time;
    }
    if (this.composing || isEditableTarget(document.activeElement)) this.stopWalkForTextInput();
    const locked = this.inputLocked();
    if (locked) this.input.keyboard.resetKeys();
    const dx = (this.cursors.left.isDown || this.keys.A.isDown ? -1 : 0) + (this.cursors.right.isDown || this.keys.D.isDown ? 1 : 0);
    const dy = (this.cursors.up.isDown || this.keys.W.isDown ? -1 : 0) + (this.cursors.down.isDown || this.keys.S.isDown ? 1 : 0);
    if ((this.path.length || (this.stepInProgress && !this.manualMoving)) && !locked && (dx || dy)) this.cancelWalk();
    if (this.path.length && !this.pathPending && !this.stepInProgress && time - this.lastMoveAt > 100) {
      const next = this.path[0];
      if (!this.canStep(next.x - this.playerCell.x, next.y - this.playerCell.y)) { void this.retryBlockedPath(time); return; }
      this.path.shift();
      this.moveToCell(next.x, next.y, { keepWalking: this.path.length > 0 });
      this.lastMoveAt = time;
      return;
    }
    if (locked) { this.stopManualWalk(); return; }
    if (this.stepInProgress || time - this.lastMoveAt < 110) return;
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
    return canStepWithoutCornerCutting((cx, cy) => this.canOccupyCell(cx, cy), x, y, dx, dy) && this.canTraverseCells({ x, y }, { x: x + dx, y: y + dy });
  }

  playerMovementObstacles() {
    const steward = this.people?.get('steward');
    const obstacles = this.stewardBurrow?.workbench ? [this.stewardBurrow] : [];
    if (steward && (steward.sprite.visible !== false || !this.stewardBurrow?.workbench)) {
      const burrow = this.stewardBurrow;
      const seating = this.coworkerContracts?.steward?.seating;
      // Collision support is independent of the fixed render container/pose registration.
      if (burrow?.workbench && burrow.seatSupported && seating?.logicalFootPoint) obstacles.push({ x: seating.logicalFootPoint[0], y: seating.logicalFootPoint[1] });
      else obstacles.push(steward.sprite);
      // Reserve the step-down ground before its authored contact frame; do not move into a player.
      if (burrow?.action === 'standing-up' && burrow.seatSupported && seating?.logicalFootPoint) obstacles.push({ x: seating.approachPoint[0], y: seating.approachPoint[1] });
    }
    return obstacles;
  }

  canOccupyCell(x, y) {
    return this.grid.isWalkable(x, y) && !this.playerMovementObstacles().some((obstacle) => feetOverlap(x * TILE + TILE / 2, (y + 1) * TILE, obstacle.x, obstacle.y));
  }

  canTraverseCells(from, to, obstacles = this.playerMovementObstacles()) {
    let [ax, ay, bx, by] = [from.x * TILE + TILE / 2, (from.y + 1) * TILE, to.x * TILE + TILE / 2, (to.y + 1) * TILE];
    if (from.x === this.playerCell.x && from.y === this.playerCell.y && Number.isFinite(this.player?.x) && Number.isFinite(this.player?.y) && (this.player.x !== ax || this.player.y !== ay)) {
      ax = this.player.x; ay = this.player.y;
      if (!footSegmentWalkable(this.room, ax, ay, bx, by)) return false;
    }
    return !obstacles.some((obstacle) => feetSegmentOverlap(ax, ay, bx, by, obstacle.x, obstacle.y) && !leavesFeetOverlap(ax, ay, bx, by, obstacle.x, obstacle.y));
  }

  async retryBlockedPath(time) {
    this.lastMoveAt = time;
    this.player.getByName('body').play(`irixi-${this.playerDirection}-idle`, true);
    if (this.pathPending || time < (this.pathRetryAt || 0)) return;
    if (!this.walkTarget?.destination || (this.pathRetryCount || 0) >= 3) { this.cancelWalk('前方暂时无法通过，已停下；让开后可重新点击。'); return; }
    this.pathRetryCount = (this.pathRetryCount || 0) + 1;
    this.pathRetryAt = time + 350;
    await this.startPath(this.walkTarget.destination, this.walkTarget, { retry: true });
  }

  stopManualWalk() {
    if (!this.manualMoving) return;
    this.manualMoving = false;
    this.player.getByName('body').play(`irixi-${this.playerDirection}-idle`, true);
    this.syncDebugState();
  }

  moveToCell(x, y, { keepWalking = false } = {}) {
    const from = { ...this.playerCell };
    if (!this.canTraverseCells(from, { x, y })) return false;
    const step = { fromCell: from, fromPosition: { x: this.player.x, y: this.player.y }, lastSafePosition: { x: this.player.x, y: this.player.y } };
    this.currentStep = step;
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
      onUpdate: () => {
        if (this.currentStep !== step) return;
        this.player.setDepth(this.player.y);
        if (!this.playerMovementObstacles().some((obstacle) => feetSegmentOverlap(this.player.x, this.player.y, x * TILE + TILE / 2, (y + 1) * TILE, obstacle.x, obstacle.y) && !leavesFeetOverlap(step.fromPosition.x, step.fromPosition.y, x * TILE + TILE / 2, (y + 1) * TILE, obstacle.x, obstacle.y))) {
          step.lastSafePosition = { x: this.player.x, y: this.player.y }; return;
        }
        this.tweens.killTweensOf(this.player);
        this.currentStep = null;
        this.playerCell = from; this.stepInProgress = false;
        this.player.setPosition(step.fromPosition.x, step.fromPosition.y).setDepth(step.fromPosition.y);
        if (this.walkTarget) this.path.unshift({ x, y });
        this.manualMoving = false; body.play(`irixi-${direction}-idle`, true); this.syncDebugState();
      },
      onComplete: () => {
        if (this.currentStep !== step) return;
        this.currentStep = null;
        this.player.setDepth(this.player.y);
        this.stepInProgress = false;
        this.pathRetryCount = 0; this.pathRetryAt = 0;
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
    this.syncDebugState();
  }

  nearestWalkable(person) {
    const movingSteward = person.role === 'steward' && this.stewardRoutine && !['waiting', 'completed'].includes(this.stewardRoutine.phase);
    const burrow = person.role === 'steward' && this.stewardBurrow?.workbench && !person.active ? this.stewardBurrow : null;
    const preferred = burrow ? worldToCell(burrow.x, burrow.y + 12, TILE) : movingSteward ? footToCell(person.sprite.x, person.sprite.y, TILE) : worldToCell(person.interactionPoint[0], person.interactionPoint[1], TILE);
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
        const clearsBurrowView = !burrow || Math.abs(footX - burrow.x) >= BURROW_VIEW_CLEARANCE_X;
        if (this.canOccupyCell(cell.x, cell.y) && !occupiedBySteward && clearsRoute && clearsBurrowView) options.push(cell);
      }
      if (options.length) return options.sort((a, b) => (Math.abs(a.x - this.playerCell.x) + Math.abs(a.y - this.playerCell.y)) - (Math.abs(b.x - this.playerCell.x) + Math.abs(b.y - this.playerCell.y)) || (burrow ? b.x - a.x : 0))[0];
    }
    return null;
  }

  async talkTo(person) {
    if (document.querySelector('dialog[open]')) return;
    if (person.role === 'steward' && this.stewardBurrow?.workbench && !person.active) {
      this.stewardBurrow.previewUntil = this.time.now + 4000;
      this.pauseStewardBurrowMotion('conversation');
      this.syncStewardBurrow(person, false, 'idle', this.presence || {});
    }
    if (person.role === 'steward' && this.stewardRoutine && !['waiting', 'completed'].includes(this.stewardRoutine.phase)) this.pauseStewardMotion('conversation');
    window.dispatchEvent(new CustomEvent('irixi:coworker', { detail: { role: person.role, name: person.name, status: person.statusText.text } }));
    if (this.task) this.setTask(this.task, { ...this.presence, engagedRole: person.role });
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

  async startPath(destination, target, { retry = false } = {}) {
    const requestId = ++this.pathRequestId;
    if (!retry) { this.path = []; this.walkTarget = target; this.pathRetryCount = 0; this.pathRetryAt = 0; }
    this.pathPending = true;
    const obstacles = this.playerMovementObstacles().map(({ x, y }) => ({ x, y }));
    const path = await this.grid.findPath(this.playerCell, destination, {
      canOccupy: (x, y) => !obstacles.some((obstacle) => feetOverlap(x * TILE + TILE / 2, (y + 1) * TILE, obstacle.x, obstacle.y)),
      canTraverse: (from, to) => this.canTraverseCells(from, to, obstacles),
    });
    if (requestId !== this.pathRequestId) return false;
    this.pathPending = false;
    if (!path?.length) {
      if (!retry) { this.walkTarget = null; this.destinationMarker.setVisible(false); this.syncDebugState(); }
      return false;
    }
    this.manualMoving = false;
    this.path = path.slice(1);
    this.walkTarget = target;
    this.destinationMarker.setPosition(destination.x * TILE + TILE / 2, destination.y * TILE + TILE).setDepth(destination.y * TILE + TILE + 1).setVisible(this.path.length > 0);
    if (!this.path.length) this.walkTarget = null;
    this.syncDebugState();
    return true;
  }

  cancelWalk(message = '', { preservePosition = false } = {}) {
    const step = this.currentStep;
    const obstacles = this.playerMovementObstacles();
    const safePoint = (point) => !obstacles.some((obstacle) => feetOverlap(point.x, point.y, obstacle.x, obstacle.y) || (feetSegmentOverlap(this.player.x, this.player.y, point.x, point.y, obstacle.x, obstacle.y) && !leavesFeetOverlap(this.player.x, this.player.y, point.x, point.y, obstacle.x, obstacle.y)));
    let stopCell = { ...this.playerCell };
    let stopPoint = preservePosition ? { x: this.player.x, y: this.player.y } : { x: stopCell.x * TILE + TILE / 2, y: (stopCell.y + 1) * TILE };
    if (preservePosition) stopCell = footToCell(stopPoint.x, stopPoint.y, TILE);
    if (step && (!this.canOccupyCell(stopCell.x, stopCell.y) || !safePoint(stopPoint))) {
      stopCell = { ...step.fromCell };
      if (this.canOccupyCell(stopCell.x, stopCell.y) && safePoint(step.fromPosition)) stopPoint = step.fromPosition;
      else {
        // Do not create a fresh overlap by snapping to either newly occupied end.
        stopPoint = safePoint(step.lastSafePosition) ? step.lastSafePosition : { x: this.player.x, y: this.player.y };
        stopCell = footToCell(stopPoint.x, stopPoint.y, TILE);
      }
    }
    this.pathRequestId += 1;
    this.pathPending = false;
    this.pathRetryCount = 0; this.pathRetryAt = 0;
    this.path = [];
    this.walkTarget = null;
    this.destinationMarker.setVisible(false);
    this.tweens.killTweensOf(this.player);
    this.currentStep = null;
    this.stepInProgress = false;
    this.playerCell = stopCell;
    this.player.setPosition(stopPoint.x, stopPoint.y).setDepth(stopPoint.y);
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
    const workbench = Array.isArray(task?.colleagues);
    const enteredWorkbench = workbench && !Array.isArray(this.task?.colleagues);
    this.presence = presence;
    this.dialogueBottomInset = Math.min(presence.bottomInset || 0, (this.scale?.height || 800) * .65);
    const reduced = Boolean(this.motionPreference?.matches || presence.reducedMotion);
    const motionChanged = Boolean(this.motionPreference || workbench) && reduced !== Boolean(this.reducedMotion);
    if (this.motionPreference || workbench) this.reducedMotion = reduced;
    this.task = task;
    for (const [role, person] of this.people) {
      const { active, status, localEligible, activitySource } = coworkerRuntimeState(task, role, presence);
      person.statusText.setText(workbench && presence.engagedRole === role && !active ? '交谈中' : workbench && ['idle', 'completed'].includes(status) && localEligible ? '休息中' : workbench && status === 'completed' ? '本轮已结束' : stateLabel[status] || status);
      person.sprite.setAlpha(1);
      person.runtimeStatus = status;
      person.active = active;
      person.localEligible = localEligible;
      person.activitySource = activitySource;
      if (role === 'steward' && this.stewardBurrow) {
        if (workbench) { this.syncStewardBurrow(person, active, status, presence, motionChanged); continue; }
        this.stewardBurrow.workbench = false;
        if (this.stewardBurrow.tween) this.tweens.killTweensOf(person.sprite);
        this.stewardBurrow.tween = null; this.stewardBurrow.advance = null; this.stewardBurrow.targetPoint = null;
        this.stewardBurrow.pauseReasons.clear();
        this.clearStewardBurrowListener();
        this.stewardBurrow.listener = null; this.stewardBurrow.generation += 1; this.stewardBurrow.action = null;
        this.stewardBurrow.actor.stop();
        this.stewardBurrow.base.setVisible(false);
        this.stewardBurrow.front.setVisible(false);
        this.stewardBurrow.actor.setVisible(false);
        person.sprite.setVisible(true);
      }
      if (enteredWorkbench) {
        person.nextLocalActionAt = role === 'steward' ? this.time.now + 45000 + PEOPLE.findIndex((p) => p.role === role) * 8000 : Number.POSITIVE_INFINITY;
        if (role === 'steward' && this.stewardRoutine) this.stewardRoutine.nextAt = this.time.now + 25000;
      }
      const stewardBusy = role === 'steward' && this.stewardRoutine && !['waiting', 'completed'].includes(this.stewardRoutine.phase);
      if (stewardBusy) {
        person.pendingTaskAction = active ? { action: status === 'stopping' ? 'idle' : 'working', source: activitySource } : null;
        if (workbench && this.stewardRoutine.leisure) {
          if (active || !localEligible) this.stewardRoutine.returnRequested = true;
          else person.statusText.setText('离座休息');
          if (this.reducedMotion) {
            this.stewardRoutine.tween?.stop(); this.stewardRoutine.tween = null;
            person.sprite.setPosition(...person.home).setDepth(person.home[1]);
            this.finishStewardRoutine();
          }
        }
        continue;
      }
      if (active) {
        const [x, y] = person.home;
        this.moveCoworker(person, x, y);
        this.setPersonAction(person, status === 'stopping' ? 'idle' : role === 'steward' && this.stewardRoutine?.completed ? 'wait-empty' : 'working', activitySource, motionChanged);
      } else {
        this.moveCoworker(person, ...person.home);
        if (workbench && role !== 'steward') {
          const conversationWake = presence.engagedRole === role && person.desiredAction !== 'idle';
          this.setPersonAction(person, localEligible ? 'sleeping' : 'idle', activitySource, motionChanged || conversationWake);
          person.nextLocalActionAt = Number.POSITIVE_INFINITY;
          this.syncSleepingIndicator(person);
          continue;
        }
        const workTransitionPending = person.pendingAction?.action === 'working' || person.pendingAction?.then?.action === 'working' || person.afterTransition?.action === 'working';
        if (!person.localEligible || person.localAction === 'working' || workTransitionPending || motionChanged) this.setPersonAction(person, motionChanged && localEligible ? person.desiredAction || person.localAction || 'idle' : 'idle', activitySource, motionChanged);
      }
    }
    this.syncStewardProps();
  }

  setPersonAction(person, action, source = person.activitySource || 'local', force = false, then = null, direct = false) {
    const body = person.sprite.getByName('body');
    const contract = this.coworkerContracts[person.role];
    const transitionActions = ['work-to-rest', 'rest-to-work', 'idle-to-sleep', 'sleep-to-idle'];
    const currentSpec = coworkerAnimationSpec(contract, person.role, person.localAction);
    // A stopped sprite may retain an obsolete AnimationFrame; use its displayed stable frame.
    const stopped = body.anims?.isPlaying === false;
    const currentFrame = Number((stopped ? body.frame?.name : body.anims?.currentFrame?.textureFrame) ?? body.frame?.name ?? body.frame?.index ?? 0);
    const sequenceIndex = stopped ? currentSpec?.frames.indexOf(currentFrame) : body.anims?.currentFrame?.index - 1;
    const uniqueIndex = currentSpec?.frames.indexOf(currentFrame) ?? -1;
    const currentFrameIndex = Number.isInteger(sequenceIndex) && currentSpec?.frames[sequenceIndex] === currentFrame ? sequenceIndex
      : currentSpec?.frames.lastIndexOf(currentFrame) === uniqueIndex ? uniqueIndex : -1;
    let transitionStartFrame = null;
    // Only explicitly shared pose IDs can reverse in place; old packs retain their interruption behavior.
    if (!direct && !this.reducedMotion && person.desiredAction !== action && ((person.localAction === 'idle-to-sleep' && action !== 'sleeping') || (person.localAction === 'sleep-to-idle' && action === 'sleeping'))) {
      const reverseAction = person.localAction === 'idle-to-sleep' ? 'sleep-to-idle' : 'idle-to-sleep';
      const reverseSpec = coworkerAnimationSpec(contract, person.role, reverseAction);
      const mappedStarts = reverseSpec?.animation.startFrameByAction?.[person.localAction];
      if (mappedStarts && currentFrameIndex < 0) throw new Error(`Missing animation sequence index: ${person.role}/${person.localAction}`);
      const frameIndex = mappedStarts ? mappedStarts[currentFrameIndex] : reverseSpec?.frames.indexOf(currentFrame) ?? -1;
      force = true;
      if (reverseSpec?.animation.reverseOf === person.localAction && frameIndex >= 0) {
        then = { action, source }; action = reverseAction; transitionStartFrame = frameIndex;
      } else { direct = true; person.desiredAction = action; }
    }
    if (action !== 'sleeping') person.sleepIndicator?.setVisible(false);
    // Repeated workbench polls must not restart a transition or its completion listener.
    if (!force && !direct && person.desiredAction === action && (person.localAction || person.pendingAction)) return true;
    // Keep the final intent while an internal transition is queued or completed.
    // Otherwise a later motion-preference change can revive that finished transition.
    if (!direct) person.desiredAction = then?.action || (transitionActions.includes(action) ? contract.animations[action]?.returnTo : action) || 'idle';
    const continuityEnabled = Boolean(contract.animations['work-to-rest'] && contract.animations['rest-to-work'] && !this.reducedMotion);
    if (!direct && !this.reducedMotion && transitionActions.includes(person.localAction) && !transitionActions.includes(action)) {
      person.afterTransition = { action, source };
      person.actionSource = source;
      this.syncRoleDebug();
      return false;
    }
    if (!direct && !this.reducedMotion && action === 'working' && ['sleeping', 'slack'].includes(person.localAction)) {
      then = { action: 'working', source };
      action = 'idle';
    } else if (!direct && continuityEnabled && person.localAction === 'working' && action !== 'working' && !transitionActions.includes(action)) {
      then = { action, source };
      action = 'work-to-rest';
    } else if (!direct && continuityEnabled && person.localAction === 'idle' && action === 'working') {
      then = { action: 'working', source };
      action = 'rest-to-work';
    }
    if (!direct && !this.reducedMotion && person.localAction === 'idle' && action === 'sleeping' && contract.animations['idle-to-sleep']) {
      then ||= { action: 'sleeping', source };
      action = 'idle-to-sleep';
    } else if (!direct && !this.reducedMotion && person.localAction === 'sleeping' && action === 'idle' && contract.animations['sleep-to-idle']) {
      then ||= { action: 'idle', source };
      action = 'sleep-to-idle';
    }
    const requested = coworkerAnimationSpec(contract, person.role, action);
    const resolvedAction = requested ? action : 'idle';
    const spec = requested || coworkerAnimationSpec(contract, person.role, 'idle');
    action = resolvedAction;
    const mappedStarts = spec.animation.startFrameByAction?.[person.localAction];
    if (mappedStarts && currentFrameIndex < 0) throw new Error(`Missing animation sequence index: ${person.role}/${person.localAction}`);
    transitionStartFrame ??= mappedStarts?.[currentFrameIndex];
    if (person.localAction === action && !force) {
      person.pendingAction = null;
      person.actionSource = source;
      this.syncRoleDebug();
      return true;
    }
    const safeFrames = this.reducedMotion ? [currentFrame] : coworkerTransitionSafeFrames(person.localAction, action, currentSpec);
    if (!force && safeFrames.length && !isSafeSwitchFrame(currentFrame, safeFrames)) {
      person.pendingAction = { action, source, then };
      this.syncRoleDebug();
      return false;
    }
    person.pendingAction = null;
    person.afterTransition = null;
    if (person.transitionListener) { body.off?.(person.transitionListener.event, person.transitionListener.callback); person.transitionListener = null; }
    person.actionGeneration = (person.actionGeneration || 0) + 1;
    const generation = person.actionGeneration;
    person.localAction = action;
    person.actionSource = source;
    if (!body.getData('runtime')) {
      body.setFrame(action === 'working' ? 1 : action === 'sleeping' ? 2 : 0);
      if (then) this.setPersonAction(person, then.action, then.source, true, null, true);
      this.syncRoleDebug();
      return true;
    }
    body.setOrigin(spec.anchor[0] / spec.frameSize[0], spec.anchor[1] / spec.frameSize[1]);
    if (contract.placement || contract.hasStatePlacement) {
      const transform = coworkerRenderTransform(contract, spec.anchor, action);
      person.renderScale = transform.scale;
      person.renderOffset = transform.offset;
      body.setScale(transform.scale).setPosition(...transform.offset);
    }
    const hitArea = scaledCoworkerHitArea(
      spec.animation.hitArea || coworkerHitArea(contract, action),
      person.renderScale || SEATED_ROLE_RENDER_SCALE[person.role] || 1,
      person.renderOffset || [0, 0],
    );
    person.hitArea = hitArea;
    // Phaser setInteractive only re-enables an existing input; update the actual shape.
    updateInteractiveHitArea(person.sprite, hitArea);
    const key = `${person.role}-${action}`;
    if (spec.isStatic || this.reducedMotion) body.stop().setTexture(spec.textureKey).setFrame(stableCoworkerFrame(spec));
    else {
      const startFrame = transitionStartFrame ?? spec.animation.startFrameIndex;
      body.play(Number.isInteger(startFrame) ? { key, startFrame } : key, true);
      if ((person.role !== 'steward' || spec.animation.transition) && !spec.animation.loop && spec.animation.returnTo) {
        const event = `animationcomplete-${key}`;
        const callback = () => {
        if (person.localAction !== action || generation !== person.actionGeneration) return;
        person.transitionListener = null;
        if (spec.animation.transition) {
          const queued = person.afterTransition || then || { action: spec.animation.returnTo, source: person.activitySource };
          person.afterTransition = null;
          this.setPersonAction(person, spec.animation.returnTo, queued.source, true, null, true);
          if (queued.action !== spec.animation.returnTo) {
            if (spec.animation.returnTo === 'idle' && queued.action === 'working' && contract.animations['rest-to-work']) person.pendingAction = { action: 'rest-to-work', source: queued.source, then: queued };
            else if (spec.animation.returnTo === 'working' && contract.animations['work-to-rest']) person.pendingAction = { action: 'work-to-rest', source: queued.source, then: queued };
            else person.pendingAction = queued;
          }
          this.syncRoleDebug();
          return;
        }
        const pendingReturn = person.pendingAction?.action === spec.animation.returnTo ? person.pendingAction : null;
        if (person.active && !pendingReturn) return;
        this.setPersonAction(person, spec.animation.returnTo, pendingReturn?.source || person.activitySource, true, pendingReturn?.then || null);
        person.nextLocalActionAt = this.time.now + localRestDelay(person.role);
        };
        person.transitionListener = { event, callback }; body.once(event, callback);
      }
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
    else this.tweens.add({ targets: person.sprite, x, y, duration: 180, ease: 'Cubic.easeOut', onUpdate: () => person.sprite.setDepth(person.sprite.y), onComplete: () => person.sprite.setDepth(person.renderDepth ?? y) });
  }

  updateLocalCoworkers(time) {
    for (const person of this.people.values()) {
      if (person.role === 'steward' && this.stewardBurrow?.workbench) continue;
      if (person.role === 'steward' && (!Array.isArray(this.task?.colleagues) || this.stewardRoutine?.phase !== 'waiting') || person.pendingAction || person.active || !person.localEligible || !person.sprite.getByName('body').getData('runtime') || this.reducedMotion || time < person.nextLocalActionAt) continue;
      if (person.localAction === 'idle') {
        const localActions = coworkerLocalActions(this.coworkerContracts[person.role]);
        if (localActions.length) {
          const action = localActions[person.localActionIndex % localActions.length];
          person.localActionIndex += 1;
          this.setPersonAction(person, action, 'local');
          person.nextLocalActionAt = action === 'sleeping' ? Number.POSITIVE_INFINITY : alignedLocalActionEnd(time, this.coworkerContracts[person.role], person.role, action);
        } else person.nextLocalActionAt = Number.POSITIVE_INFINITY;
      } else if (person.localAction !== 'sleeping') {
        this.setPersonAction(person, 'idle', person.activitySource || 'local');
        const hasLocalActions = coworkerLocalActions(this.coworkerContracts[person.role]).length > 0;
        person.nextLocalActionAt = time + (hasLocalActions ? Array.isArray(this.task?.colleagues) ? 50000 : localRestDelay(person.role) : Number.POSITIVE_INFINITY);
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
      const owner = stewardBookOwner(person.localAction, Number(frame.textureFrame), this.stewardRoutine.bookOwner, this.coworkerContracts.steward.steward.integration.propVisibility);
      if (owner === this.stewardRoutine.bookOwner) return;
      this.stewardRoutine.bookOwner = owner;
      this.syncStewardProps();
      this.syncRoleDebug();
    });
    this.syncStewardProps();
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
    if (!routine.tween && ['outbound', 'returning'].includes(routine.phase)) this.advanceStewardRoute();
    this.syncRoleDebug();
  }

  updateStewardMotionPause() {
    const routine = this.stewardRoutine;
    const person = this.people?.get('steward');
    if (!routine || !person || !routine.pauseReasons.size) return;
    const talking = Array.isArray(this.task?.colleagues) ? this.presence?.engagedRole === 'steward' && !person.active : document.querySelector('#coworker-dialog[open]');
    if (routine.pauseReasons.has('conversation') && !talking) this.resumeStewardMotion('conversation');
    if (routine.pauseReasons.has('collision') && !feetOverlap(this.player.x, this.player.y, person.sprite.x, person.sprite.y, 36, 24)) this.resumeStewardMotion('collision');
  }

  updateStewardRoutine(time) {
    const routine = this.stewardRoutine;
    const person = this.people?.get('steward');
    if (Array.isArray(this.task?.colleagues)) {
      if (this.stewardBurrow?.workbench) return;
      if (!routine || !person || this.reducedMotion) return;
      if (routine.leisure && routine.phase === 'resting' && (routine.returnRequested || time >= routine.nextAt)) this.returnStewardFromStroll();
      if (routine.phase !== 'waiting' || !['idle','wait-empty'].includes(person.localAction) || person.active || !person.localEligible || time < routine.nextAt) return;
      routine.leisure = true; routine.completed = false; routine.returnRequested = false; routine.walkedLegs = [];
      routine.phase = 'outbound'; routine.legIndex = 0;
      routine.legs = stewardRouteLegs(this.coworkerContracts.steward.steward.routeContract, 'outbound').map((leg) => ({ ...leg, action: leg.action.replace('walk-carry-', 'walk-empty-') }));
      person.statusText.setText('离座休息'); this.advanceStewardRoute(); return;
    }
    if (!routine || !person || routine.completed || routine.phase !== 'waiting' || time < routine.nextAt) return;
    if ((!person.active && !person.localEligible) || (person.active && person.activitySource !== 'task') || this.reducedMotion) {
      routine.nextAt = time + 1000;
      return;
    }
    routine.phase = 'pickup';
    routine.bookOwner = 'transition';
    this.syncStewardProps();
    this.setPersonAction(person, 'pickup-books', 'local', true);
    const body = person.sprite.getByName('body');
    body.once('animationcomplete-steward-pickup-books', () => {
      routine.bookOwner = 'mole';
      this.syncStewardProps();
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
    if (routine.leisure && routine.phase === 'outbound' && routine.returnRequested) { this.returnStewardFromStroll(); return; }
    if (routine.pauseReasons.size) return;
    const leg = routine.legs[routine.legIndex];
    if (!leg) {
      if (routine.leisure && routine.phase === 'outbound') { routine.phase = 'resting'; routine.nextAt = this.time.now + 10000; this.setPersonAction(person, 'wait-empty', 'local', true); }
      else if (routine.phase === 'outbound') this.startStewardShelving();
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
    // Validate the whole small-foot route before starting, rather than only its endpoint.
    if (this.room) {
      const samples = Math.max(1, Math.ceil(Math.hypot(leg.to[0] - person.sprite.x, leg.to[1] - person.sprite.y) / 4));
      for (let i = 0; i <= samples; i += 1) if (!walkableFoot(this.room, person.sprite.x + (leg.to[0] - person.sprite.x) * i / samples, person.sprite.y + (leg.to[1] - person.sprite.y) * i / samples)) { routine.routeBlocked = true; this.syncRoleDebug(); return; }
    }
    routine.routeBlocked = false;
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
        if (routine.leisure && routine.phase === 'outbound') routine.walkedLegs.push(leg);
        routine.legIndex += 1;
        this.advanceStewardRoute();
      },
    });
  }

  returnStewardFromStroll() {
    const routine = this.stewardRoutine;
    const opposite = { up: 'down', down: 'up', left: 'right', right: 'left' };
    routine.phase = 'returning'; routine.returnRequested = false; routine.legIndex = 0;
    routine.legs = [...routine.walkedLegs].reverse().map((leg) => ({ from: [...leg.to], to: [...leg.from], action: `walk-empty-${opposite[leg.action.split('-').at(-1)]}` }));
    this.advanceStewardRoute();
  }

  startStewardShelving() {
    const person = this.people.get('steward');
    const routine = this.stewardRoutine;
    routine.phase = 'shelving';
    this.setPersonAction(person, 'shelve-books', 'local', true);
    const body = person.sprite.getByName('body');
    body.once('animationcomplete-steward-shelve-books', () => {
      routine.bookOwner = 'shelf';
      this.syncStewardProps();
      this.startStewardRoute('return');
    });
  }

  finishStewardRoutine() {
    const person = this.people.get('steward');
    const routine = this.stewardRoutine;
    if (routine.leisure) {
      routine.phase = 'waiting'; routine.completed = false; routine.leisure = false; routine.tween = null; routine.pauseReasons.clear();
      routine.nextAt = this.time.now + 90000; person.pendingTaskAction = null;
      this.setPersonAction(person, person.active && coworkerRuntimeState(this.task, 'steward', this.presence).status !== 'stopping' ? 'working' : 'idle', person.activitySource || 'local', true);
      const status = coworkerRuntimeState(this.task, 'steward', this.presence).status;
      person.statusText.setText(status === 'completed' ? '本轮已结束' : status === 'idle' ? '休息中' : stateLabel[status] || status);
      this.syncRoleDebug(); return;
    }
    routine.phase = 'completed';
    routine.completed = true;
    routine.bookOwner = 'shelf';
    this.syncStewardProps();
    routine.tween = null;
    routine.pauseReasons.clear();
    person.renderDepth = person.home[1];
    person.pendingTaskAction = null;
    this.setPersonAction(person, 'wait-empty', person.active ? person.activitySource : 'local', true);
    this.syncRoleDebug();
  }

  syncRoleDebug() {
    const host = document.getElementById('office-game');
    if (!host) return;
    host.dataset.roleActions = JSON.stringify([...this.people.entries()].map(([role, person]) => {
      const body = person.sprite.getByName('body');
      const front = person.frontSprite;
      return { role, status: person.runtimeStatus, localEligible: person.localEligible, engaged: this.presence?.engagedRole === role, nextLocalActionAt: Number.isFinite(person.nextLocalActionAt) ? person.nextLocalActionAt : 'infinity', bodyPosition: [body.x, body.y], bodyAlpha: body.alpha, front: front ? { visible: front.visible, position: [front.x, front.y], alpha: front.alpha, texture: front.texture?.key, frame: front.frame?.name } : null, sleepZ: person.sleepIndicator?.visible ? 1 : 0, sleepZObjects: person.sleepIndicator ? 1 : 0, actionGeneration: person.actionGeneration, transitionListener: Boolean(person.transitionListener), reducedMotion: this.reducedMotion, action: person.localAction, pendingAction: person.pendingAction?.action || person.pendingTaskAction?.action || null, pendingThen: person.pendingAction?.then?.action || null, afterTransition: person.afterTransition?.action || null, activitySource: person.activitySource, actionSource: person.actionSource, active: person.active, runtime: Boolean(body.getData('runtime')), texture: body.texture.key, frame: body.frame?.name ?? body.frame?.index ?? 0, position: [Math.round(person.sprite.x), Math.round(person.sprite.y)], depth: person.sprite.depth, alpha: person.sprite.alpha, desiredAction: person.desiredAction, hitArea: person.hitArea };
    }));
    if (this.stewardRoutine) host.dataset.stewardRoutine = JSON.stringify({ phase: this.stewardRoutine.phase, completed: this.stewardRoutine.completed, bookOwner: this.stewardRoutine.bookOwner, paused: [...this.stewardRoutine.pauseReasons] });
    if (this.stewardBurrow) host.dataset.stewardBurrow = JSON.stringify({ action: this.stewardBurrow.action, worldFoot: [this.stewardBurrow.x, this.stewardBurrow.y], workbench: this.stewardBurrow.workbench, generation: this.stewardBurrow.generation, wantsWork: this.stewardBurrow.wantsWork, listener: Boolean(this.stewardBurrow.listener), moving: Boolean(this.stewardBurrow.tween), targetPoint: this.stewardBurrow.targetPoint });
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
