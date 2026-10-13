export function worldToCell(x, y, tileSize) {
  return { x: Math.floor(x / tileSize), y: Math.floor(y / tileSize) };
}

export function crispZoom(width, height, worldWidth, worldHeight) {
  const fit = Math.min(width / worldWidth, height / worldHeight);
  return fit >= 1 ? Math.max(1, Math.floor(fit)) : Math.max(0.5, fit);
}

export function footToCell(x, y, tileSize) {
  return { x: Math.floor(x / tileSize), y: Math.floor(y / tileSize) - 1 };
}

export function canStepWithoutCornerCutting(isWalkable, x, y, dx, dy) {
  if (!isWalkable(x + dx, y + dy)) return false;
  return !dx || !dy || (isWalkable(x + dx, y) && isWalkable(x, y + dy));
}

export function isMovementKey(key) {
  return ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(String(key).toLowerCase());
}

export function isWalkInProgress({ pathPending = false, pathLength = 0, stepInProgress = false, manualMoving = false } = {}) {
  return Boolean(pathPending || pathLength > 0 || stepInProgress || manualMoving);
}

export function animationCycleDuration(frameDurationsMs = [], fallbackFrameDurationMs = 0, frameCount = frameDurationsMs.length) {
  return frameDurationsMs.length
    ? frameDurationsMs.reduce((total, duration) => total + duration, 0)
    : fallbackFrameDurationMs * frameCount;
}

export function isSafeSwitchFrame(frameIndex, safeSwitchFrameIndices = []) {
  return !safeSwitchFrameIndices.length || safeSwitchFrameIndices.includes(Number(frameIndex));
}

export function feetOverlap(ax, ay, bx, by, radiusX = 26, radiusY = 18) {
  const dx = (ax - bx) / radiusX;
  const dy = (ay - by) / radiusY;
  return dx * dx + dy * dy < 1;
}

export function pointToSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (!lengthSquared) return Math.hypot(px - ax, py - ay);
  const ratio = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

export function coworkerRuntimeState(task, role, { activeConversationRole = null, engagedRole = null } = {}) {
  const stationAgents = task?.team?.agents?.filter((agent) => agent.stationRole === role) || [];
  const matchingWork = (task?.workItems || []).filter((item) => stationAgents.length
    ? stationAgents.some((agent) => agent.id === item.agentId)
    : item.role === role);
  const work = matchingWork.find((item) => item.status === 'running') || matchingWork.at(-1);
  const replyingAgent = stationAgents.find((agent) => agent.roleKey === activeConversationRole);
  const replying = activeConversationRole === role || Boolean(replyingAgent);
  const activeAgent = task?.team?.agents?.find((agent) => agent.id === task.activeAgentId);
  const active = replying || (task?.status === 'running' && (task.activeRole === role || activeAgent?.stationRole === role || work?.status === 'running'));
  const status = replying ? 'replying' : active ? 'active' : work?.status === 'completed' ? 'done' : ['failed', 'blocked'].includes(work?.status) ? 'failed' : work?.status === 'waiting_user' ? 'waiting_user' : 'idle';
  const localEligible = !active && engagedRole !== role && !['failed', 'waiting_user'].includes(status);
  const activitySource = replying ? 'conversation' : active ? 'task' : localEligible ? 'local' : 'status';
  return { active, status, localEligible, activitySource };
}
