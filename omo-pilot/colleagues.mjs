import crypto from 'node:crypto';

export const COLLEAGUES = Object.freeze([
  { id: 'researcher', name: '仓鼠学习同事', specialty: '学习、理解和练习', preference: '优先按 learning-dialogue 讲解和讨论。用户只要解释时不变成考试，理解成立时停止纠错。' },
  { id: 'writer', name: '小鼠工具开发同事', specialty: '实用工具和小项目', preference: '优先做可运行的小工具，读取已有项目，完成实际行为检查，提供可直接使用的成果。' },
  { id: 'reviewer', name: '龙猫小游戏开发同事', specialty: '小游戏设计和制作', preference: '优先复用已接入的 Noobi 制作、试玩和修改小游戏。没有真实调用记录时不得声称使用过 Noobi。' },
  { id: 'steward', name: '鼹鼠Agent开发同事', specialty: 'Agent与工作流程', preference: '优先检查真实工具、任务状态、停止和恢复。简化协作流程，保留清楚的任务责任。' },
  { id: 'archivist', name: '花枝鼠档案记忆同事', specialty: '资料、决定和长期记忆', preference: '优先核对来源与适用范围，区分讨论、已确认决定和临时要求，不把旧资料当作当前命令。' },
]);
export function colleague(value, { nullable = false } = {}) {
  if (nullable && value == null) return null;
  const found = COLLEAGUES.find((entry) => entry.id === value);
  if (!found) throw new Error('没有找到这位同事，当前工作未转交。');
  return found;
}
export const createWork = (ownerId = null) => ({ id: `work-${crypto.randomUUID()}`, ownerId: colleague(ownerId, { nullable: true })?.id || null, ownerRevision: 0, stopEpoch: 0, transfers: [], lifecycle: 'open', lifecycleRevision: 0, lifecycleEvents: [] });
export const pendingTransfer = (c) => c.work?.transfers.findLast((item) => ['requested', 'receiving'].includes(item.status));
const live = new Set(['queued', 'understanding', 'working', 'waiting', 'stopping', 'creating']);
const priority = ['stopping', 'working', 'understanding', 'creating', 'queued', 'waiting', 'awaiting_project', 'failed', 'interrupted', 'stopped', 'completed'];
export function classifiedWorkLifecycle(route, text) {
  if (!['open', 'completed'].includes(route.workLifecycle) || typeof route.workLifecycleEvidence !== 'string') return null;
  // The normal semantic classifier supplies a whole affirmative clause, not a
  // keyword trigger. Quoted examples, negation and partial excerpts cannot close work.
  const unquoted = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"[^"\n]*"|'[^'\n]*'/gu, '');
  const clause = route.workLifecycleEvidence.trim().replace(/[。！？.!?；;]+$/u, '').trim();
  const clauses = unquoted.split(/[\n，。！？,!?;；]/u).map((s) => s.trim());
  if (!clause || !clauses.includes(clause) || /不|没|未|别|[吗么呢]$|\b(?:not|never|don't|cannot|can't)\b/iu.test(clause)) return null;
  return { state: route.workLifecycle, evidence: clause };
}
export function workStatus(c) {
  if (pendingTransfer(c)) return 'handoff';
  const turns = [...c.turns, ...(c.artifactRuns || []), ...(c.handoffRuns || [])];
  const running = turns.filter((t) => live.has(t.status));
  if (running.length) return priority.find((status) => running.some((t) => t.status === status));
  if (turns.some((t) => t.status === 'awaiting_project')) return 'awaiting_project';
  return c.turns.at(-1)?.status || (c.artifactRuns || []).at(-1)?.status || (c.handoffRuns || []).at(-1)?.status || 'idle';
}
export function colleagueWorkView(conversations) {
  return COLLEAGUES.map((profile) => {
    const works = [];
    for (const c of conversations) {
      if (!c.work) continue;
      const children = [...c.turns.flatMap((parent) => (parent.children || []).map((child) => ({ child, parent }))), ...(c.handoffRuns || []).map((child) => ({ child, parent: null }))].filter(({ child }) => child.colleagueId === profile.id);
      if (c.work.ownerId !== profile.id && !children.length) continue;
      const responsible = c.work.ownerId === profile.id;
      // A verified parent can finish after failed delegation. Keep the child
      // failure in history without projecting it as a current work blocker.
      const helperStates = children.map(({ child, parent }) => child.status === 'failed' && parent?.status === 'completed' && parent.verification?.status === 'passed'
        && child.providerTermination?.status !== 'unconfirmed' && !child.unsaved ? 'completed' : child.status);
      const helperStatus = priority.find((status) => live.has(status) && helperStates.includes(status)) || helperStates.at(-1);
      const status = responsible ? workStatus(c) : helperStatus;
      const lifecycle = c.work.lifecycle || 'open';
      works.push({ workId: c.work.id, conversationId: c.id, projectId: c.projectId, title: c.title, responsibility: responsible ? 'owner' : 'helper', status, lifecycle,
        unfinished: lifecycle !== 'completed' || live.has(status) || status === 'handoff', archived: c.archived === true,
        ownerId: c.work.ownerId, ownerRevision: c.work.ownerRevision, lastProgressAt: c.turns.at(-1)?.lastProgressAt || null });
    }
    return { ...profile, works };
  });
}
