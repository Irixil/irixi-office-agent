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

export function feetSegmentOverlap(ax, ay, bx, by, obstacleX, obstacleY, radiusX = 26, radiusY = 18) {
  return pointToSegmentDistance(obstacleX / radiusX, obstacleY / radiusY, ax / radiusX, ay / radiusY, bx / radiusX, by / radiusY) < 1;
}

export function leavesFeetOverlap(ax, ay, bx, by, obstacleX, obstacleY, radiusX = 26, radiusY = 18) {
  return feetOverlap(ax, ay, obstacleX, obstacleY, radiusX, radiusY) && (ax - obstacleX) * (bx - ax) / radiusX ** 2 + (ay - obstacleY) * (by - ay) / radiusY ** 2 >= 0;
}

export function coworkerRuntimeState(task, role, { activeConversationRole = null, engagedRole = null, learningAvailable = false } = {}) {
  if (Array.isArray(task?.colleagues)) {
    if (task.disconnected) return { active: false, status: 'unknown', localEligible: false, activitySource: 'status' };
    const works = task.colleagues.find((person) => person.id === role)?.works || [];
    // One stopping conversation must not hide another conversation still doing work.
    const order = ['working', 'understanding', 'creating', 'handoff', 'stopping', 'queued', 'waiting_user', 'waiting', 'awaiting_project', 'failed', 'interrupted', 'stopped'];
    const status = order.find((state) => works.some((work) => work.status === state)) || (works.some((work) => work.status !== 'completed') ? 'unknown' : works.length ? 'completed' : 'idle');
    const active = ['working', 'understanding', 'creating', 'handoff', 'stopping'].includes(status);
    const localEligible = ['idle', 'completed'].includes(status) && engagedRole !== role;
    return { active, status, localEligible, activitySource: active ? 'task' : localEligible ? 'local' : 'status' };
  }
  if (task?.nativeProduct) {
    const functionOwner = { utility: 'writer', game: 'reviewer', agent: 'steward' }[task.functionId] || null;
    const replying = activeConversationRole === role;
    const learningReady = role === 'researcher' && learningAvailable;
    const owned = functionOwner === role;
    const overall = task.status;
    const status = replying ? 'replying' : learningReady ? 'learning_available' : owned
      ? ['running', 'in_progress', 'executing'].includes(overall) ? 'active'
        : ['ready_to_export', 'completed'].includes(overall) ? 'done'
          : ['failed', 'partial', 'blocked', 'runtime_unavailable'].includes(overall) ? 'failed'
            : ['waiting_user', 'ready', 'planned', 'pending', 'waiting_scope', 'waiting_scope_authorization', 'ready_to_run', 'runtime_starting', 'paused'].includes(overall) ? 'waiting_user' : overall === 'cancelled' ? 'cancelled' : 'idle'
      : 'idle';
    const active = replying || status === 'active';
    const localEligible = !active && engagedRole !== role && !['failed', 'waiting_user', 'cancelled'].includes(status);
    return { active, status, localEligible, activitySource: replying ? 'conversation' : active ? 'task' : localEligible ? 'local' : 'status' };
  }
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
