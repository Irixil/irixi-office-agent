import { synchronizedUrl } from './navigation-state.js';
import { materialDecisionExpectation, planInputsChanged, projectWorkspaceAttachExpectation, shouldPollTask } from './task-input-state.js';

const initialQuery = new URLSearchParams(window.location.search);
let requestedTaskId = initialQuery.get('task');
const requestedView = initialQuery.get('view');
const state = {
  tasks: [],
  task: null,
  view: ['office', 'desk', 'review', 'connections'].includes(requestedView) ? requestedView : 'office',
  selectedArtifactId: null,
  connections: [],
  pollTimer: null,
  sceneReady: false,
  coworker: null,
  conversationMessages: [],
  conversationPending: false,
  conversationTaskId: null,
  conversationRole: null,
  pendingAction: null,
  pendingActionTaskId: null,
  projectCapabilities: null,
  projectFixtureSelections: {},
  projectScopeContexts: {},
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const lines = (items, empty = '—') => Array.isArray(items) && items.length ? items.map((item) => `• ${item}`).join('\n') : empty;
const dateLabel = (value) => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';

const TASK_STATUS = {
  idle: '空闲', ready: '计划就绪', running: '正在工作', waiting_user: '等待你确认', partial: '部分完成',
  ready_to_export: '可以导出', failed: '运行失败', cancelled: '已取消', cancellation_unknown: '正在确认取消', completed: '已完成',
};
const WORK_STATUS = {
  pending: '待排', ready: '就绪', running: '进行中', completed: '完成', waiting_user: '待确认',
  blocked: '受阻', failed: '失败', cancelled: '取消', stale: '历史失效',
};
const SUGGESTION_LABEL = { support: '支持目标', replace: '替代目标', deviate: '偏离 / 以后', unclear: '暂不明确' };
const ROLE_LABEL = { coordinator: 'Irixi · 协调', archivist: '花枝鼠 · 档案', researcher: '仓鼠 · 研究', writer: '小鼠 · 写作', reviewer: '龙猫 · 审阅', steward: '鼹鼠 · 事务' };

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(body?.error?.message || body || `请求失败 (${response.status})`);
    error.body = body;
    throw error;
  }
  return body;
}

function announce(message, tone = 'normal') {
  const toast = $('#toast');
  toast.textContent = message;
  toast.dataset.tone = tone;
  toast.classList.add('is-visible');
  $('#live-region').textContent = message;
  clearTimeout(announce.timer);
  announce.timer = setTimeout(() => toast.classList.remove('is-visible'), 3400);
}

function activeGoal(task = state.task) {
  return task?.goal?.versions?.find((item) => item.id === task.goal.activeVersionId);
}

function artifactInputIsCurrent(task, artifact) {
  const instructionIds = (task?.suggestions || []).filter((item) => (item.goalVersionId || activeGoal(task)?.id) === activeGoal(task)?.id
    && item.classification === 'support' && item.status === 'routed').map((item) => item.id).sort();
  if (JSON.stringify([...(artifact?.instructionIds || [])].sort()) !== JSON.stringify(instructionIds)) return false;
  if (task?.projectRootTaskId && (!artifact?.projectRootGoalVersionId || !artifact?.projectRootInputFingerprint)) return false;
  if (artifact?.projectRootGoalVersionId && task?.projectRootGoalVersionId && artifact.projectRootGoalVersionId !== task.projectRootGoalVersionId) return false;
  if (artifact?.projectRootInputFingerprint && task?.projectRootInputFingerprint && artifact.projectRootInputFingerprint !== task.projectRootInputFingerprint) return false;
  if ((artifact?.materialApplicabilityFingerprint ?? null) !== (task?.materialContext?.fingerprint ?? null)) return false;
  if (task?.type === 'project') {
    const workspace = task.projectWorkspace;
    const evidence = artifact?.projectCandidate;
    if (!workspace || workspace.status !== 'ready' || !evidence) return false;
    if (evidence.workspaceScopeFingerprint !== workspace.scopeFingerprint
      || evidence.sourceSnapshotSha256 !== workspace.sourceSnapshotSha256
      || evidence.candidateId !== workspace.candidate?.id
      || evidence.candidateSha256 !== workspace.candidate?.candidateSha256) return false;
  }
  return true;
}

function planningBusy(task = state.task) {
  return (state.pendingAction === 'planning' && state.pendingActionTaskId === task?.id) || task?.runtime?.activeJob?.kind === 'planning';
}

function latestArtifact(task = state.task) {
  const goalId = activeGoal(task)?.id;
  return task?.artifacts?.filter((item) => item.goalVersionId === goalId && ['candidate', 'confirmed'].includes(item.status) && artifactInputIsCurrent(task, item)).at(-1) || null;
}

function selectedArtifact() {
  const goalId = activeGoal()?.id;
  return state.task?.artifacts?.find((item) => item.id === state.selectedArtifactId && item.goalVersionId === goalId) || latestArtifact();
}

function latestReview(artifact) {
  return state.task?.reviews?.filter((item) => item.artifactId === artifact?.id).at(-1) || null;
}

function nextAction(task) {
  if (!task) return '先建立一项工作。';
  if (planningBusy(task)) return 'Irixi 正在按当前目标形成计划；可以等待完成或取消这次规划。';
  if (task.status === 'running') return `${ROLE_LABEL[task.activeRole] || task.activeRole}正在推进，进度会自动刷新。`;
  if (task.continuity?.progress?.nextStep) return task.continuity.progress.nextStep;
  if (task.status === 'ready_to_export') return '已确认指定版本；到成果审阅台下载一份新文件。';
  if (task.status === 'failed') return '查看活动记录中的失败原因，修正后可以安全重新运行。';
  if (task.status === 'cancellation_unknown') return '取消请求已发出，正在确认本地执行进程是否真的终止。';
  if (task.status === 'partial') return '审阅发现阻塞项。修改候选稿或补充材料后重新核对。';
  if (task.status === 'cancelled') return '任务已取消。已有材料和候选稿仍保留，可重新形成计划。';
  if (!task.materials.length) return '先到任务书桌加入本次工作需要的材料。';
  if (!task.workItems.length) return '让 Irixi 根据当前目标形成工作计划。';
  return '工作计划已经准备好，可以开始生成候选成果。';
}

function officeState(task) {
  if (!task) return { kicker: 'OFFICE AT REST', title: '办公室正在等候第一项工作', detail: '建立任务后，角色状态会投影到这里。', tone: 'normal' };
  if (planningBusy(task)) return { kicker: 'PLANNING THE COMMISSION', title: 'Irixi 正在形成工作计划', detail: '当前目标与材料正在编排；可以取消，不会改动已有记录。', tone: 'working' };
  const runningRole = {
    coordinator: ['COORDINATING THE COMMISSION', 'Irixi 正在校准目标与下一步'],
    archivist: ['READING AT THE ARCHIVE', '档案角色正在阅读与整理材料'],
    researcher: ['RESEARCH UNDERWAY', '研究角色正在核对来源与缺口'],
    writer: ['DRAFT IN PROGRESS', '写作角色正在起草候选成果'],
    reviewer: ['INDEPENDENT PROOFING', '审阅角色正在独立核对'],
    steward: ['PREPARING DELIVERY', '事务角色正在准备指定版本'],
  }[task.activeRole] || ['OFFICE IN MOTION', '办公室正在工作'];
  const states = {
    idle: ['BRIEF RECEIVED', 'Irixi 正在守住当前目标', '任务已归档，等待材料或计划。'],
    ready: ['DESKS PREPARED', '工作步骤已经排定', '所有角色将按照当前目标依次接手。'],
    running: [runningRole[0], runningRole[1], task.events.at(-1)?.message || '当前步骤正在执行。'],
    waiting_user: ['AWAITING THE PRINCIPAL', '候选成果等待你的判断', '办公室不会擅自把候选稿变成正式成果。'],
    ready_to_export: ['SEALED BY THE PRINCIPAL', '指定版本已被确认', '可以按需要导出一份新文件。'],
    partial: ['PROOF RETURNED', '审阅台发现阻塞项', '关键问题修正前不会标记完成。'],
    failed: ['WORK HALTED', '本次运行已经安全停止', task.events.at(-1)?.message || '请查看失败原因。'],
    cancelled: ['COMMISSION PAUSED', '任务已由你取消', '已有记录和候选版本仍然保留。'],
    cancellation_unknown: ['CANCELLATION PENDING', '正在确认取消结果', '本地执行进程终止前不会把取消请求写成已完成。'],
  };
  const value = states[task.status] || states.idle;
  return { kicker: value[0], title: value[1], detail: value[2], tone: ['running'].includes(task.status) ? 'working' : ['failed', 'partial'].includes(task.status) ? 'attention' : 'normal' };
}

function roleState(role, task) {
  if (!task) return { state: 'idle', label: '待命' };
  const conversation = conversationRuntime(task);
  if (conversation?.role === role && conversation.kind === 'conversation') return { state: 'active', label: '正在回复' };
  if (conversation?.role === role && conversation.kind === 'conversation-queued') return { state: 'pending', label: '等待回复' };
  if (role === 'coordinator') {
    if (planningBusy(task)) return { state: 'active', label: '规划中' };
    if (task.activeRole === 'coordinator' && task.status === 'running') return { state: 'active', label: '协调中' };
    if (task.status === 'failed') return { state: 'failed', label: '已停下' };
    return { state: 'done', label: '守住目标' };
  }
  const dynamicAgent = task.team?.agents?.find((agent) => agent.stationRole === role && task.workItems.some((work) => work.agentId === agent.id && work.status === 'running'))
    || task.team?.agents?.find((agent) => agent.stationRole === role);
  const matchingWork = task.workItems.filter((work) => dynamicAgent ? work.agentId === dynamicAgent.id : work.role === role);
  const item = matchingWork.find((work) => work.status === 'running') || matchingWork.at(-1);
  if (!item) return { state: 'idle', label: '本次不需要' };
  if (item.status === 'running') return { state: 'active', label: WORK_STATUS[item.status] };
  if (['completed', 'waiting_user'].includes(item.status)) return { state: 'done', label: WORK_STATUS[item.status] };
  if (['failed', 'blocked'].includes(item.status)) return { state: 'failed', label: WORK_STATUS[item.status] };
  return { state: 'idle', label: WORK_STATUS[item.status] || item.status };
}

function setView(view) {
  state.view = view;
  $$('.view').forEach((item) => item.classList.toggle('is-active', item.id === `view-${view}`));
  $$('.nav-tab').forEach((item) => item.classList.toggle('is-active', item.dataset.viewTarget === view));
  if (view === 'connections') loadConnections();
  syncLocation();
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function syncLocation() {
  const next = synchronizedUrl(window.location.href, { taskId: state.task?.id, view: state.view });
  window.history.replaceState(null, '', next);
}

function renderTaskList() {
  const root = $('#task-list');
  if (!state.tasks.length) {
    root.innerHTML = '<p class="empty-ledger">账本还是空的。先写下一个明确目标，Irixi 才知道应该守住什么。</p>';
    return;
  }
  root.innerHTML = state.tasks.map((task) => `
    <button class="task-row ${task.id === state.task?.id ? 'is-active' : ''}" type="button" data-task-id="${esc(task.id)}">
      <strong>${esc(task.title)}</strong><span><em>${esc(TASK_STATUS[task.status] || task.status)}</em><time>${esc(dateLabel(task.updatedAt))}</time></span>
    </button>`).join('');
}

function renderOffice() {
  const task = state.task;
  const goal = activeGoal(task);
  const display = officeState(task);
  $('#room-state-kicker').textContent = display.kicker;
  $('#room-state-title').textContent = display.title;
  $('#room-state-detail').textContent = display.detail;
  $('.office-state-plaque').dataset.tone = display.tone;
  $('#global-status').textContent = task ? `${task.title} · ${TASK_STATUS[task.status] || task.status}` : '本地待命';
  $('#global-status-dot').dataset.tone = display.tone;
  $('#goal-version').textContent = goal ? `v${goal.version}` : '—';
  $('#active-goal').textContent = goal?.statement || '尚未选择任务。';
  $('#success-criteria').textContent = lines(goal?.successCriteria, '尚未填写。');
  $('#goal-boundaries').textContent = lines(goal?.boundaries, '默认不发送、不发布、不覆盖来源。');
  $('#next-action').textContent = nextAction(task);

  const roles = ['coordinator', 'archivist', 'researcher', 'writer', 'reviewer', 'steward'];
  $('#role-strip').innerHTML = roles.map((role) => {
    const value = roleState(role, task);
    const content = `<b>${esc(ROLE_LABEL[role])}</b><span>${esc(value.label)}</span>`;
    return role === 'coordinator' ? `<div class="role-cell" data-state="${value.state}">${content}</div>` : `<button class="role-cell" type="button" data-talk-role="${esc(role)}" data-state="${value.state}" aria-label="与${esc(ROLE_LABEL[role])}交谈，当前${esc(value.label)}">${content}</button>`;
  }).join('');

  const actions = $('#office-actions');
  if (!task) actions.innerHTML = '<button class="secondary-button wide-button" type="button" data-open-dialog="task-dialog">建立第一项工作</button>';
  else if (task.status === 'running') actions.innerHTML = '<button class="danger-button wide-button" type="button" data-action="cancel">取消本次运行</button><button class="secondary-button wide-button" type="button" data-view-target="desk">查看任务书桌</button>';
  else if (task.status === 'cancellation_unknown') actions.innerHTML = '<button class="secondary-button wide-button" type="button" disabled>正在确认取消结果</button><button class="secondary-button wide-button" type="button" data-view-target="desk">查看任务书桌</button>';
  else if (['waiting_user', 'ready_to_export'].includes(task.status)) actions.innerHTML = '<button class="secondary-button wide-button" type="button" data-view-target="review">前往成果审阅</button><button class="secondary-button wide-button" type="button" data-view-target="desk">查看决定与续接状态</button>';
  else actions.innerHTML = '<button class="primary-button wide-button" type="button" data-action="continue">继续工作</button><button class="secondary-button wide-button" type="button" data-view-target="desk">查看续接状态</button><button class="secondary-button wide-button" type="button" data-open-dialog="suggestion-dialog">记录新建议</button>';
  syncSceneFrame();
}

function renderCoworkerConversation() {
  const root = $('#coworker-history');
  const actions = $('#coworker-actions');
  const task = state.task;
  if (!task) {
    root.innerHTML = '<div class="conversation-line is-system"><b>办公室回执</b><p>目前没有选中的任务。先建立目标后，这位同事才能接手材料与工作。</p></div>';
    actions.innerHTML = '<button class="primary-button" type="button" data-coworker-action="new-task">在这里建立第一项工作</button>';
    return;
  }
  const role = state.coworker?.role;
  const activeConversation = conversationRuntime(task);
  const conversationBusy = Boolean(activeConversation);
  const currentRolePending = activeConversation?.role === role;
  const agentId = state.coworker?.agentId;
  const agentWork = task.workItems.filter((item) => item.agentId === agentId);
  const roleWork = task.workItems.filter((item) => item.role === role);
  const work = agentWork.find((item) => item.status === 'running') || agentWork.at(-1)
    || roleWork.find((item) => item.status === 'running') || roleWork.at(-1);
  const goalId = activeGoal(task)?.id;
  const persisted = task.events.filter((item) => ['conversation.user', 'conversation.reply', 'conversation.failed', 'conversation.cancelled'].includes(item.type)
    && item.detail?.role === role
    && (item.detail?.goalVersionId === goalId || (!item.detail?.goalVersionId && task.goal.versions.length === 1))).slice(-6).map((item) => ({
    by: item.type === 'conversation.user' ? '你' : item.type === 'conversation.reply' ? `${ROLE_LABEL[role] || role} · ${item.detail?.provider === 'demo' ? '演示回执' : '模型回复'}` : item.type === 'conversation.cancelled' ? '已取消本次回复' : '回复失败',
    text: item.detail?.content || item.message,
    refs: item.detail?.sourceRefs || [],
  }));
  const current = { by: '任务状态回执', text: `${TASK_STATUS[task.status] || task.status}。${work ? `${work.title}：${WORK_STATUS[work.status] || work.status}。` : '本次计划尚未安排这一角色。'}${task.events.at(-1)?.message || ''}` };
  const pending = currentRolePending ? [{ by: activeConversation?.kind === 'conversation-queued' ? '已排队' : '模型回复中', text: activeConversation?.kind === 'conversation-queued' ? '消息已持久化；当前工作到安全切换点后，这位同事会实际调用模型回复。可单独取消本次回复。' : '同事正在结合当前任务、材料和最近对话回答。可取消本次回复，不会取消任务或删除已有成果。' }] : [];
  root.innerHTML = [current, ...persisted, ...state.conversationMessages, ...pending].slice(-7).map((item) => `<div class="conversation-line ${item.by === '你' ? 'is-user' : 'is-system'}"><b>${esc(item.by)}</b><p>${esc(item.text)}</p>${item.refs?.length ? `<small>来源：${item.refs.map(esc).join('；')}</small>` : ''}</div>`).join('');
  root.scrollTop = root.scrollHeight;
  root.scrollTop = root.scrollHeight;
  const buttons = [];
  if (planningBusy(task)) buttons.push('<button class="secondary-button" type="button" disabled>正在形成计划…</button><button class="danger-button" type="button" data-coworker-action="cancel-plan">取消规划</button>');
  else if (!task.workItems.length) buttons.push('<button class="primary-button" type="button" data-coworker-action="plan">形成工作计划</button>');
  else if (planInputsChanged(task) && !['running','cancellation_unknown'].includes(task.status)) buttons.push('<button class="primary-button" type="button" data-coworker-action="plan">按修改要求重新规划</button>');
  else if (!['running','cancellation_unknown','waiting_user','ready_to_export'].includes(task.status)) buttons.push(`<button class="primary-button" type="button" data-coworker-action="run">${task.provider === 'demo' ? '运行演示流程' : '开始真实模型工作'}</button>`);
  if (task.status === 'running') buttons.push('<button class="secondary-button" type="button" disabled>同事正在工作，进度会自动刷新</button>');
  buttons.push('<button class="secondary-button" type="button" data-coworker-action="material">加入材料</button>');
  if (latestArtifact(task)) buttons.push('<button class="secondary-button" type="button" data-coworker-action="review">打开当前成果</button>');
  actions.innerHTML = buttons.join('');
  const form = $('#coworker-form');
  form.querySelector('[type="submit"]').disabled = conversationBusy;
  $('#coworker-message').disabled = conversationBusy;
  $('#coworker-intent').disabled = conversationBusy;
  $('#cancel-conversation-button').hidden = !currentRolePending;
}

function conversationRuntime(task = state.task) {
  if (!task) return null;
  if (state.conversationPending && state.conversationTaskId === task.id) return { kind: 'conversation', role: state.conversationRole };
  if (task.runtime?.activeJob?.kind === 'conversation') return task.runtime.activeJob;
  const queued = task.conversationQueue?.find((item) => item.status === 'pending' || item.status === 'running');
  return queued ? { kind: queued.status === 'pending' ? 'conversation-queued' : 'conversation', role: queued.role, agentId: queued.agentId, queueId: queued.id } : null;
}

function syncSceneFrame() {
  const dialog = $('#coworker-dialog');
  const conversation = conversationRuntime();
  window.irixiOffice?.setTask(state.task, {
    activeConversationRole: conversation?.kind === 'conversation' ? conversation.role : null,
    engagedRole: dialog?.open ? state.coworker?.role || null : null,
  });
}

async function loadScene() {
  state.sceneReady = true;
  syncSceneFrame();
}

function renderMaterials(task) {
  if (!task.materials.length) return '<p class="empty-ledger">尚未加入材料。Irixi 可以使用粘贴文本、TXT/MD、DOCX、可搜索 PDF 和明确网址。</p>';
  const directory = new Map((task.materialContext?.directory || []).map((item) => [item.id, item]));
  return `<p class="field-note material-policy-note">材料原件和历史始终保留。这里决定哪些内容可用于当前目标；“事实参考”表示你允许沿用这份来源，不表示系统已验证整份文档。混合了事实、旧要求和约束的材料请先拆分后分别加入。</p><ol class="register-list">${task.materials.map((item, index) => {
    const context = directory.get(item.id) || {};
    const stateLabel = item.status !== 'ready' ? '读取失败' : context.eligible ? '当前可用' : context.eligibility === 'needs_decision' || context.eligibility === 'needs_reconfirmation' ? '需要决定' : '当前排除';
    const tone = item.status !== 'ready' ? 'bad' : context.eligible ? 'good' : context.eligibility?.startsWith('needs') ? 'warn' : 'muted';
    const form = item.status === 'ready' && !context.generatedEvidence ? `<form class="material-applicability-form" data-material-applicability="${esc(item.id)}" data-expected-fingerprint="${esc(JSON.stringify(task.materialContext?.fingerprint ?? null))}" data-expected-scope="${esc(JSON.stringify(task.materialContext?.scope || null))}" data-expected-content-sha256="${esc(JSON.stringify(context.contentSha256 || null))}">
      <label>当前用途<select name="category"><option value="unclassified" ${context.category === 'unclassified' ? 'selected' : ''}>仅限当前目标（未分类）</option><option value="reusable_fact" ${context.category === 'reusable_fact' ? 'selected' : ''}>我明确允许沿用的事实参考</option><option value="goal_specific" ${context.category === 'goal_specific' ? 'selected' : ''}>目标专属材料</option><option value="constraint" ${context.category === 'constraint' ? 'selected' : ''}>需要确认的约束</option></select></label>
      <label>处理<select name="disposition"><option value="use" ${context.disposition === 'use' ? 'selected' : ''}>用于当前目标</option><option value="pending" ${context.disposition === 'pending' ? 'selected' : ''}>待重新确认</option><option value="exclude" ${context.disposition === 'exclude' ? 'selected' : ''}>不影响交付，暂不使用</option></select></label>
      <label>影响<select name="impact"><option value="non_blocking" ${context.impact !== 'required_for_delivery' ? 'selected' : ''}>不影响交付</option><option value="required_for_delivery" ${context.impact === 'required_for_delivery' ? 'selected' : ''}>交付前必须决定</option></select></label>
      <label>用途<input name="purpose" maxlength="500" required value="${esc(context.purpose || '')}" placeholder="例如：核对试用范围"></label>
      <label>原因<input name="reason" maxlength="1000" value="${esc(context.reason || '')}" placeholder="为何使用、排除或重确认"></label>
      <button class="secondary-button" type="submit">保存用途决定</button>
    </form>` : '';
    return `<li class="register-row material-record"><span class="row-index">${String(index + 1).padStart(2, '0')}</span><div><strong>${esc(item.name)}</strong><p>${esc(item.status === 'ready' ? `${item.source} · ${item.bytes || 0} 字节` : item.error || '读取失败')}</p><small>${esc(context.reason || '')}</small>${form}</div><span class="record-status" data-tone="${tone}">${stateLabel}</span></li>`;
  }).join('')}</ol>`;
}

function renderSuggestions(task) {
  if (!task.suggestions.length) return '<p class="empty-ledger">还没有新建议。补充想法会先分类，不会悄悄改掉最终目标。</p>';
  const goal = activeGoal(task);
  return task.suggestions.slice().reverse().map((item) => `
    <div class="suggestion-row"><p>${esc(item.text)}</p><div class="suggestion-meta">
      <select aria-label="建议分类" data-suggestion-classification="${esc(item.id)}">
        ${Object.entries(SUGGESTION_LABEL).map(([key, label]) => `<option value="${key}" ${item.classification === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select><span class="record-status" data-tone="${item.classification === 'replace' ? 'bad' : item.classification === 'support' ? 'good' : 'active'}">${esc(item.status)}</span>
    </div>${item.classification === 'replace' && item.status === 'waiting_user' ? `<form class="goal-replacement" data-goal-replacement="${esc(item.id)}"><p>请逐项对照并完整填写新版。成功条件和边界不会从旧目标静默继承。</p><div class="compare-columns"><div><strong>当前 v${esc(goal.version)}</strong><p>${esc(goal.statement)}</p><small>成功条件<br>${esc(lines(goal.successCriteria, '未填写'))}</small><small>工作边界<br>${esc(lines(goal.boundaries, '未填写'))}</small></div><div><strong>拟定新版</strong><label>新目标<textarea name="statement" rows="3" maxlength="4000" required>${esc(item.text)}</textarea></label><label>新成功条件 <span class="field-note">每行一条</span><textarea name="successCriteria" rows="3" required></textarea></label><label>新工作边界 <span class="field-note">每行一条</span><textarea name="boundaries" rows="3" required></textarea></label></div></div><button class="danger-button" type="submit">确认完整新版目标</button></form>` : ''}</div>`).join('');
}

function renderContinuity(task) {
  const value = task.continuity;
  if (!value) return '<p class="empty-ledger">正在从任务记录整理续接状态。</p>';
  const list = (items, empty) => items.length ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : `<p class="field-note">${esc(empty)}</p>`;
  const activeJob = task.runtime?.activeJob;
  const busyText = activeJob?.kind === 'planning' ? '正在形成计划，等待本次规划结果。'
    : activeJob?.kind === 'conversation' ? '正在回复当前对话，完成后会写回同一任务。'
      : activeJob ? '正在处理当前工作，完成后会写回同一任务。' : null;
  const incomplete = busyText ? [busyText, ...value.progress.incomplete] : value.progress.incomplete;
  const stoppedBecause = busyText ? '当前正在工作，没有停下。' : value.progress.stoppedBecause || '没有停下，当前记录可以继续。';
  const nextStep = busyText || value.progress.nextStep;
  const readyForDownload = task.status === 'ready_to_export' && value.candidate?.confirmed;
  const requiresAttention = ['failed', 'partial', 'cancelled', 'cancellation_unknown'].includes(task.status)
    && ['budget_exhausted', 'permanent_error', 'same_error_exhausted', 'project_verification_failed', 'project_transaction_failed'].includes(task.execution?.stopReason);
  const badge = busyText ? '正在工作' : readyForDownload ? '可以下载' : value.progress.needsUserDecision ? '需要你的决定' : requiresAttention ? '需要先处理' : 'Irixi 可继续';
  const tone = busyText ? 'active' : value.progress.needsUserDecision || requiresAttention ? 'bad' : 'good';
  return `<div class="continuity-grid"><div><strong>已经做成</strong>${list(value.progress.done, '还没有完成且仍有效的步骤。')}</div><div><strong>尚未完成</strong>${list(incomplete, '当前没有未完成步骤。')}</div><div><strong>为什么停下</strong><p>${esc(stoppedBecause)}</p></div><div><strong>下一步</strong><p>${esc(nextStep)}</p><span class="record-status" data-tone="${tone}">${badge}</span></div></div>`;
}

function renderProject(task) {
  const rootId = task.projectContext?.rootTaskId || task.continuity?.project?.rootTaskId || task.id;
  const roots = state.tasks.filter((item) => !item.projectRootTaskId || item.id === rootId);
  const related = task.linkedTaskContext || [];
  const rootInstructions = task.projectContext?.acceptedInstructions || [];
  return `<label for="project-root-select">所属项目</label><select id="project-root-select" ${task.status === 'running' || planningBusy(task) ? 'disabled' : ''}><option value="${esc(task.id)}" ${rootId === task.id ? 'selected' : ''}>独立任务 / 以本任务为根</option>${roots.filter((item) => item.id !== task.id).map((item) => `<option value="${esc(item.id)}" ${rootId === item.id ? 'selected' : ''}>关联到：${esc(item.title)}</option>`).join('')}</select><p class="field-note">只有明确关联的任务会共享必要项目摘要。根目标或已接受交代更新会让关联任务的旧计划和迟到结果失效，但保留各任务自身目标与历史。</p>${rootInstructions.length ? `<p class="field-note"><strong>项目已接受交代</strong><br>${rootInstructions.map((item) => `• ${esc(item.text)}`).join('<br>')}</p>` : ''}${related.length ? `<div class="memory-register">${related.map((item) => `<div class="memory-row"><div><strong>${esc(item.title)}</strong><small>${esc(TASK_STATUS[item.status] || item.status)} · 下一步：${esc(item.nextStep)}</small>${item.acceptedInstructions?.length ? `<small>已接受交代：${item.acceptedInstructions.map((entry) => esc(entry.text)).join('；')}</small>` : ''}</div><span class="record-status">${esc(item.candidate?.confirmed ? '已确认成果' : item.candidate ? '候选未确认' : '无候选')}</span></div>`).join('')}</div>` : '<p class="field-note">当前没有其他关联任务。</p>'}`;
}

function renderWork(task) {
  if (!task.workItems.length) return '<p class="empty-ledger">还没有工作步骤。Irixi 会根据成果类型和材料按需安排角色。</p>';
  return task.workItems.map((item, index) => {
    const readyForDownload = task.status === 'ready_to_export' && task.continuity?.candidate?.confirmed && (item.kind === 'delivery' || item.role === 'steward');
    const result = item.result;
    const resultSummary = result?.summary || result?.title || (result?.artifactId ? `候选版本 v${result.version}` : result?.reviewId ? `审阅已保存 · ${result.passed ? '通过' : '有阻塞项'}` : '');
    const agent = task.team?.agents?.find((candidate) => candidate.id === item.agentId);
    const dependencies = (item.dependsOn || []).map((id) => task.workItems.find((candidate) => candidate.id === id)?.title).filter(Boolean);
    const title = readyForDownload ? '下载已确认的指定版本' : item.title;
    const expectedResult = readyForDownload ? '指定版本已确认，可按需下载' : item.expectedResult;
    const statusLabel = readyForDownload ? '可以下载' : WORK_STATUS[item.status] || item.status;
    const tone = readyForDownload || item.status === 'completed' ? 'good' : ['failed','blocked'].includes(item.status) ? 'bad' : item.status === 'running' ? 'active' : '';
    return `<div class="progress-line" data-state="${esc(readyForDownload ? 'ready_to_export' : item.status)}"><span class="progress-symbol">${String(index + 1).padStart(2, '0')}</span><div><strong>${esc(title)}</strong><small>${esc(agent?.name || ROLE_LABEL[item.role] || item.role)} · ${esc(expectedResult)}</small>${dependencies.length ? `<small>前置：${dependencies.map(esc).join('、')}</small>` : '<small>可立即开始</small>'}${resultSummary ? `<small>实际产物：${esc(resultSummary)}</small>` : ''}</div><span class="record-status" data-tone="${tone}">${esc(statusLabel)}</span></div>`;
  }).join('');
}

function renderTeam(task) {
  const agents = task.team?.agents || [];
  if (!agents.length) return '<p class="empty-ledger">当前是固定流程计划。选择真实模型并重新形成计划后，才会按目标组建动态团队。</p>';
  return `<div class="team-roster">${agents.map((agent) => {
    const works = task.workItems.filter((item) => item.agentId === agent.id);
    const active = works.find((item) => item.status === 'running');
    const station = agent.stationRole ? (ROLE_LABEL[agent.stationRole] || agent.stationRole) : '文字团队席位';
    return `<article class="team-member" data-state="${esc(agent.status)}"><div><strong>${esc(agent.name)}</strong><small>${esc(station)} · ${esc(agent.status === 'working' ? '正在工作' : '可交谈')}</small></div><p>${esc(agent.recruitmentReason || agent.mission)}</p><p class="team-capabilities">能力：${(agent.capabilities || []).map(esc).join('、') || '按当前工作项限定'}</p><p>${active ? `正在处理：${esc(active.title)}` : `负责：${works.map((item) => esc(item.title)).join('、')}`}</p><button class="text-button" type="button" data-talk-agent="${esc(agent.id)}">文字交谈</button></article>`;
  }).join('')}</div>`;
}

function renderMemory(task) {
  const entries = task.memoryEntries || [];
  return `<label for="memory-policy-select">可搜索范围</label><select id="memory-policy-select" ${task.status === 'running' || planningBusy(task) ? 'disabled' : ''}><option value="task-only" ${task.memoryPolicy !== 'workspace-confirmed' ? 'selected' : ''}>只限当前任务</option><option value="workspace-confirmed" ${task.memoryPolicy === 'workspace-confirmed' ? 'selected' : ''}>其他任务中我已确认的成果</option></select><p class="field-note">候选稿不会自动进入记忆。只有你确认的版本可被搜索，并保留任务、版本和来源。</p>${entries.length ? `<div class="memory-register">${entries.slice().reverse().map((entry) => `<div class="memory-row"><div><strong>${esc(entry.title)}</strong><small>${esc(entry.source)} · ${esc(entry.status === 'active' ? '可用' : entry.status === 'conflict' ? '有冲突，暂停使用' : entry.status === 'superseded' ? '已被新版替代' : '已撤回')}</small></div>${['active','conflict'].includes(entry.status) ? `<button class="text-button" type="button" data-retract-memory="${esc(entry.id)}">撤回</button>` : ''}</div>`).join('')}</div>` : ''}`;
}

function renderProjectWorkspace(task) {
  if (task.type !== 'project') return '';
  const capability = state.projectCapabilities;
  const workspace = task.projectWorkspace;
  const scopeContext = state.projectScopeContexts[task.id] || null;
  const scope = scopeContext?.projectScope || task.projectScope || null;
  const fixtures = capability?.fixtures || [];
  const selectedFixtureId = state.projectFixtureSelections[task.id] || workspace?.fixtureId || fixtures[0]?.id || 'node-single-file-v1';
  const registeredFixture = fixtures.find((item) => item.id === selectedFixtureId) || fixtures[0];
  const genericWorkspaceSelected = Boolean(workspace?.proposalId && workspace.fixtureId === selectedFixtureId);
  const fixture = genericWorkspaceSelected ? {
    id: workspace.fixtureId,
    label: workspace.label,
    publicContract: workspace.publicContract,
    readablePaths: workspace.readablePaths,
    editablePaths: workspace.editablePaths,
    checks: workspace.checks,
  } : registeredFixture;
  const workspaceMatchesSelection = workspace?.fixtureId === selectedFixtureId;
  const binding = {
    goalVersionId: activeGoal(task)?.id || null,
    projectRootGoalVersionId: task.projectRootGoalVersionId || activeGoal(task)?.id || null,
    projectRootInputFingerprint: task.projectRootInputFingerprint || null,
    materialApplicabilityFingerprint: task.materialContext?.fingerprint ?? null,
  };
  const capabilityText = !capability ? '正在读取本机隔离能力。'
    : capability.available ? 'macOS 固定 Node 合约隔离可用；授权时仍会对实际候选路径运行正负探针。'
      : capability.reason || '当前机器未通过固定隔离能力检查。';
  const checks = workspaceMatchesSelection ? workspace?.candidate?.checks || [] : [];
  const latestCheck = checks.at(-1);
  const snapshot = {
    expectedGoalVersionId: binding.goalVersionId,
    expectedProjectRootGoalVersionId: binding.projectRootGoalVersionId,
    expectedProjectRootInputFingerprint: binding.projectRootInputFingerprint,
    expectedMaterialApplicabilityFingerprint: binding.materialApplicabilityFingerprint,
    expectedPreviousScopeFingerprint: workspace?.scopeFingerprint || null,
    expectedCapabilityFingerprint: capability?.fingerprint || null,
  };
  const status = workspaceMatchesSelection && workspace?.status === 'ready' ? '已授权且探针通过'
    : workspaceMatchesSelection && workspace ? workspace.reason || workspace.status
      : workspace ? `当前另有已授权项目；“${fixture?.label || selectedFixtureId}”需明确重新授权` : '尚未授权';
  const genericAttachSnapshot = scope?.status === 'accepted' ? {
    ...snapshot,
    proposalId: scope.id,
    expectedProposalFingerprint: scope.fingerprint,
  } : null;
  const scopeCard = !scope
    ? `<form data-project-scope-propose data-expected-binding="${esc(JSON.stringify(scopeContext?.taskInputBinding || null))}" data-expected-tree="${esc(scopeContext?.repository?.treeSha256 || '')}"><p><strong>先整理有限需求卡</strong></p><p class="field-note">Irixi 会读取登记仓库的安全源码目录，只提出最多 8 个可读文件、2 个可改纯函数模块和 3 项固定检查；这一步不修改代码。</p><button class="primary-button" type="submit" ${!scopeContext?.repository || planningBusy(task) ? 'disabled' : ''}>整理目的、交付与验收范围</button></form>`
    : `<div class="project-scope-card"><p><strong>当前需求卡 · ${esc(scope.current === false ? '输入已变化，需重新整理' : scope.status === 'accepted' ? '已接受' : scope.status === 'proposed' ? '待确认' : '历史')}</strong><br>${esc(scope.goal?.statement || '')}</p><p class="field-note">交付：只生成可下载 patch<br>成功：${esc((scope.goal?.successCriteria || []).join('；'))}<br>边界：${esc((scope.goal?.boundaries || []).join('；'))}<br>可读：${esc((scope.readablePaths || []).join('、'))}<br>可改：${esc((scope.editablePaths || []).join('、'))}</p>${(scope.checks || []).map((check) => `<details><summary>${esc(check.id)}${check.namedExport ? ` · ${esc(check.namedExport)}` : ''}</summary>${(check.cases || []).map((item) => `<p class="field-note"><strong>${esc(item.id)}</strong><br>输入 ${esc(JSON.stringify(item.args))}<br>期望 ${esc(JSON.stringify(item.expected))}</p>`).join('')}</details>`).join('')}${scope.current === false ? `<form data-project-scope-propose data-expected-binding="${esc(JSON.stringify(scopeContext?.taskInputBinding || null))}" data-expected-tree="${esc(scopeContext?.repository?.treeSha256 || '')}"><button class="primary-button" type="submit">按当前输入重新整理范围</button></form>` : scope.status === 'proposed' ? `<form data-project-scope-accept data-proposal-id="${esc(scope.id)}" data-expected-fingerprint="${esc(scope.fingerprint)}"><button class="primary-button" type="submit">接受完整需求卡与逐条用例</button></form>` : ''}</div>`;
  const genericAttach = scope?.status === 'accepted' && scope.current !== false && workspace?.proposalId !== scope.id
    ? `<form class="project-workspace-form" data-project-workspace-attach data-generic-scope data-expected-snapshot="${esc(JSON.stringify(genericAttachSnapshot))}"><button class="primary-button" type="submit" ${!capability?.available || planningBusy(task) ? 'disabled' : ''}>授权当前有限范围的隔离副本</button></form>` : '';
  return `<section class="desk-sheet project-workspace-panel"><div class="sheet-heading"><h2>代码工作区</h2><span class="record-status" data-tone="${workspaceMatchesSelection && workspace?.status === 'ready' ? 'good' : 'warn'}">${esc(status)}</span></div><div class="sheet-body provider-line">
    <p class="field-note">原项目始终只读；Irixi 只在本任务目录的隔离副本中修改明确文件。交付物是可下载 patch，不会写回原目录、运行 Git、发布或执行模型自选命令。</p>
    ${scopeCard}${genericAttach}
    <p><strong>公开行为</strong><br>${esc(fixture?.publicContract?.entrypoint || fixture?.publicContract?.namedExport || 'greetName')}：${esc(fixture?.publicContract?.behavior || '去掉名称首尾空白并生成问候。')}</p>
    ${fixture?.publicContract?.writeScope ? `<p class="field-note">${esc(fixture.publicContract.writeScope)}</p>` : ''}
    <p class="field-note">可读：${esc((fixture?.readablePaths || workspace?.readablePaths || []).join('、') || '—')}<br>可改：${esc((fixture?.editablePaths || workspace?.editablePaths || []).join('、') || '—')}<br>固定检查：${esc(fixture?.checks?.[0]?.id || workspace?.checks?.[0]?.id || '—')}</p>
    <p class="${capability?.available ? 'field-note' : 'demo-warning'}">${esc(capabilityText)}</p>
    ${workspaceMatchesSelection && workspace ? `<p class="field-note">source ${esc(workspace.sourceSnapshotSha256 || '—')}<br>candidate ${esc(workspace.candidate?.candidateSha256 || '—')} · revision ${esc(workspace.candidate?.revision || '—')}${latestCheck ? `<br>检查 ${latestCheck.passed ? '通过' : '失败'}：${esc(latestCheck.casePassed)}/${esc(latestCheck.caseTotal)} cases · ${esc(latestCheck.resultDigest)}${(latestCheck.cases || []).some((entry) => entry.timedOut) ? ' · 含超时' : ''}${(latestCheck.cases || []).some((entry) => entry.truncated) ? ' · 输出超限' : ''}` : ''}</p>` : ''}
    <details><summary>已有固定示例工作区</summary><form class="project-workspace-form" data-project-workspace-attach data-expected-snapshot="${esc(JSON.stringify(snapshot))}">
      <label>固定项目<select name="fixtureId" data-project-fixture-select ${task.status === 'running' || planningBusy(task) ? 'disabled' : ''}>${fixtures.map((item) => `<option value="${esc(item.id)}" ${item.id === selectedFixtureId ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}</select></label>
      <button class="secondary-button" type="submit" ${!capability?.available || task.status === 'running' || planningBusy(task) ? 'disabled' : ''}>${workspaceMatchesSelection && workspace?.status === 'ready' ? '按当前目标重新授权隔离副本' : '授权所选固定隔离副本'}</button>
    </form></details>
  </div></section>`;
}

function renderDesk() {
  const root = $('#desk-content');
  const task = state.task;
  $('#desk-subtitle').textContent = task ? `当前任务：${task.title}` : '材料、建议与工作步骤都围绕当前目标排列。';
  if (!task) {
    root.innerHTML = '<div class="empty-desk"><span class="eyebrow">NO COMMISSION SELECTED</span><h2>先从一个明确目标开始</h2><p>建立任务后，这张书桌会呈现它的材料、建议分类、工作角色和可恢复状态。</p><button class="primary-button" type="button" data-open-dialog="task-dialog">建立第一项工作</button></div>';
    return;
  }
  const isRunning = task.status === 'running';
  const isPlanning = planningBusy(task);
  const needsReplan = planInputsChanged(task);
  const execution = task.execution;
  const budgetLine = execution ? `<p class="field-note">本次运行：${task.provider === 'demo' ? '演示流程，不调用模型' : `${execution.modelCalls.length}/${execution.limits.maxModelCalls} 次模型调用 · 用量 ${execution.modelCalls.some((item) => item.usage !== 'unknown') ? '见调用记录' : '未知'}`} · 最长 ${Math.round(execution.limits.maxDurationMs / 60000)} 分钟 · 阶段 ${esc(execution.phase)}</p>` : '';
  root.innerHTML = `<div class="desk-columns"><div class="desk-stack">
    ${renderProjectWorkspace(task)}
    <section class="desk-sheet"><div class="sheet-heading"><h2>材料账本</h2><button class="secondary-button" type="button" data-open-dialog="material-dialog">＋ 加入材料</button></div><div class="sheet-body">${renderMaterials(task)}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>新建议</h2><button class="secondary-button" type="button" data-open-dialog="suggestion-dialog">＋ 记录建议</button></div><div class="sheet-body">${renderSuggestions(task)}</div></section>
  </div><aside class="desk-stack">
    <section class="desk-sheet"><div class="sheet-heading"><h2>续接状态</h2><button class="primary-button" type="button" data-action="continue" ${isRunning || isPlanning ? 'disabled' : ''}>继续工作</button></div><div class="sheet-body">${renderContinuity(task)}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>项目关联</h2></div><div class="sheet-body provider-line">${renderProject(task)}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>执行方式</h2></div><div class="sheet-body provider-line"><label for="provider-select">模型提供者</label><select id="provider-select" ${isRunning || isPlanning || task.type === 'project' ? 'disabled' : ''}>${task.type === 'project' ? '<option value="codex-cli" selected>Codex CLI · 真实模型（代码项目固定）</option>' : `<option value="demo" ${task.provider === 'demo' ? 'selected' : ''}>演示提供者</option><option value="codex-cli" ${task.provider === 'codex-cli' ? 'selected' : ''}>Codex CLI · 真实模型</option>`}</select>${task.type === 'project' ? '<p class="field-note">Codex 只提出结构化 workspace 操作；宿主验证固定路径、版本、隔离检查和 diff。CLI shell 仍关闭。</p>' : task.provider === 'demo' ? '<p class="demo-warning">演示模式只验证流程，不代表真实智能产出。正式内容请切换 Codex。</p>' : '<p class="field-note">模型子进程关闭 shell、浏览器、应用与插件；材料、记忆和计算只由 Irixi 的授权工具提供。</p>'}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>记忆范围</h2></div><div class="sheet-body provider-line">${renderMemory(task)}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>本次团队</h2><span class="record-status">${esc(task.plan?.source === 'model' ? `计划 v${task.plan.revision}` : '固定流程')}</span></div><div class="sheet-body">${renderTeam(task)}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>工作步骤</h2><span class="record-status" data-tone="${isRunning || isPlanning ? 'active' : ''}">${esc(isPlanning ? '正在形成计划' : TASK_STATUS[task.status] || task.status)}</span></div><div class="sheet-body">${budgetLine}${needsReplan ? '<p class="demo-warning">材料或修改要求已变化。先按当前输入重新规划，原目标与旧版本都会保留。</p>' : ''}${renderWork(task)}<div class="inline-actions" style="margin-top:16px">${isPlanning ? '<button class="secondary-button" type="button" disabled>正在形成计划…</button><button class="danger-button" type="button" data-action="cancel">取消规划</button>' : !task.workItems.length ? '<button class="primary-button" type="button" data-action="plan">形成计划</button>' : isRunning ? '<button class="danger-button" type="button" data-action="cancel">取消运行</button>' : task.status === 'cancellation_unknown' ? '<button class="secondary-button" type="button" disabled>正在确认取消</button>' : needsReplan ? '<button class="primary-button" type="button" data-action="plan">按修改要求重新规划</button>' : '<button class="primary-button" type="button" data-action="run">生成候选成果</button>'}<button class="secondary-button" type="button" data-view-target="review">查看成果</button></div></div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>活动记录</h2></div><div class="sheet-body"><ol class="register-list">${task.events.slice(-8).reverse().map((item, index) => `<li class="register-row"><span class="row-index">${String(task.events.length - index).padStart(2,'0')}</span><div><strong>${esc(item.message)}</strong><p>${esc(dateLabel(item.at))}</p></div></li>`).join('')}</ol></div></section>
  </aside></div>`;
}

function reviewPanel(review, artifact) {
  if (!review) return '<div class="review-panel"><h3>独立核对</h3><p class="field-note">这个版本还没有审阅记录。</p></div>';
  if (artifact?.reviewStatus === 'pending') return `<div class="review-panel"><span class="record-status" data-tone="active">待重新核对</span><h3>独立核对</h3><p class="field-note">本地文件已在上次核对后重新生成。旧核对记录仍保留为历史，但不能用于确认；请检查预览后重新独立核对。</p></div>`;
  return `<div class="review-panel"><span class="record-status" data-tone="${review.passed ? 'good' : 'bad'}">${review.passed ? '通过' : '有阻塞项'}</span><h3>独立核对</h3><p class="field-note">${esc(review.summary)}</p>${review.checks.map((check) => `<div class="check-row" data-passed="${check.passed}"><span class="check-mark">${check.passed ? '✓' : '×'}</span><div><strong>${esc(check.name)}${check.blocking ? '' : '（非阻塞）'}</strong><p>${esc(check.evidence)}</p></div></div>`).join('')}</div>`;
}

function exportLinks(task, artifact) {
  if (artifact.status !== 'confirmed') return '';
  const approval = task.approvals.filter((item) => item.artifactId === artifact.id && item.status === 'confirmed').at(-1);
  if (!approval) return '';
  const base = `/api/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.id)}/export?approval=${encodeURIComponent(approval.id)}`;
  const links = task.type === 'project'
    ? [`<a class="export-link" href="${base}&format=patch">下载已确认 patch</a>`]
    : [`<a class="export-link" href="${base}&format=md">下载 Markdown 新文件</a>`, `<a class="export-link" href="${base}&format=html">下载 HTML（可打印 PDF）</a>`];
  for (const file of artifact.nativeFiles || []) if (file.status === 'ready') {
    const label = { docx: 'Word 文档', xlsx: 'Excel 工作簿', pptx: 'PowerPoint 演示文稿' }[file.format] || file.format.toUpperCase();
    links.unshift(`<a class="export-link" href="${base}&format=${encodeURIComponent(file.format)}">下载 ${label}</a>`);
  }
  if (task.type === 'email') links.push(`<a class="export-link" href="${base}&format=eml">下载 EML 邮件草稿</a>`);
  if (task.type === 'calendar') links.push(`<a class="export-link" href="${base}&format=ics">下载 ICS 日历草稿</a>`);
  return `<div class="review-panel"><h3>正式交付</h3><p class="field-note">${task.type === 'project' ? '下载的是经指定版本确认的候选 patch；不会自动应用、写回原项目、运行 Git 或发布。' : '每次点击只下载一份新文件，不发送、不发布、不覆盖来源。'}</p><div class="export-list">${links.join('')}</div></div>`;
}

function renderReview() {
  const root = $('#review-content');
  const task = state.task;
  const currentArtifacts = task?.artifacts?.filter((item) => item.goalVersionId === activeGoal(task)?.id
    && ['candidate', 'confirmed'].includes(item.status) && artifactInputIsCurrent(task, item)) || [];
  if (!task || !currentArtifacts.length) {
    root.innerHTML = `<div class="empty-desk"><span class="eyebrow">NO PROOF YET</span><h2>${task ? '还没有候选成果' : '尚未选择任务'}</h2><p>${task ? '先在任务书桌形成计划并运行，候选版本才会出现在审阅台。' : '选择或建立一项任务后再来审阅。'}</p><button class="secondary-button" type="button" data-view-target="desk">前往任务书桌</button></div>`;
    return;
  }
  const artifact = selectedArtifact();
  state.selectedArtifactId = artifact.id;
  const review = latestReview(artifact);
  const previous = artifact.previousId ? task.artifacts.find((item) => item.id === artifact.previousId) : null;
  const deliverables = artifact.deliverables || [];
  const hasMultipleDeliverables = deliverables.length > 1;
  const onlyDeliverable = deliverables.length === 1 ? deliverables[0] : null;
  const structuredPayload = ['spreadsheet', 'presentation'].includes(onlyDeliverable?.kind);
  const summaryDiffersFromPayload = Boolean(onlyDeliverable && onlyDeliverable.kind !== 'document' && onlyDeliverable.content !== artifact.content);
  const canEdit = task.type !== 'project' && artifact.status === 'candidate' && artifactInputIsCurrent(task, artifact)
    && !hasMultipleDeliverables && !structuredPayload && !summaryDiffersFromPayload;
  const editorContent = onlyDeliverable?.kind === 'document' ? onlyDeliverable.content : artifact.content;
  const nativeFiles = artifact.nativeFiles || [];
  const artifactBusy = (['artifact-review', 'native-refresh'].includes(state.pendingAction) && state.pendingActionTaskId === task.id)
    || ['review', 'native-refresh'].includes(task.runtime?.activeJob?.kind)
    || task.status === 'running';
  let nativePreviewIndex = 0;
  const nativeRows = nativeFiles.map((file) => {
    const previews = (file.previewPaths || []).map((_, index) => `<figure class="native-preview"><img src="/api/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.id)}/previews/${nativePreviewIndex++}" alt="${esc(file.filename || file.kind)} 预览第 ${index + 1} 页" loading="lazy"><figcaption>${esc(file.filename || file.kind)} · 第 ${index + 1} 页</figcaption></figure>`).join('');
    return `<div class="check-row" data-passed="${file.status === 'ready'}"><span class="check-mark">${file.status === 'ready' ? '✓' : '×'}</span><div><strong>${esc(file.filename || file.kind)}</strong><p>${file.status === 'ready' ? `已生成并渲染 ${file.previewPaths?.length || 0} 页，请在确认前人工检查下方预览。` : esc(file.error || '生成失败')}</p></div></div>${previews}`;
  }).join('');
  const nativePanel = artifact.deliverables?.some((entry) => ['document','spreadsheet','presentation'].includes(entry.kind))
    ? `<div class="review-panel"><h3>原生文件</h3>${nativeRows || '<p class="field-note">尚未生成原生候选文件，不能通过审阅。</p>'}</div>` : '';
  const projectEvidence = artifact.projectCandidate;
  const projectPanel = task.type === 'project' && projectEvidence ? `<div class="review-panel project-candidate-evidence"><h3>宿主代码证据</h3><p class="field-note">source ${esc(projectEvidence.sourceSnapshotSha256)}<br>candidate ${esc(projectEvidence.candidateSha256)}<br>diff ${esc(projectEvidence.diffSha256)}</p>${(projectEvidence.checks || []).map((check) => `<div class="check-row" data-passed="${check.passed}"><span class="check-mark">${check.passed ? '✓' : '×'}</span><div><strong>${esc(check.checkId)}</strong><p>${esc(check.casePassed)}/${esc(check.caseTotal)} cases · ${esc(check.resultDigest)} · ${check.timedOut ? '超时' : '未超时'}</p></div></div>`).join('')}<details class="compare-block" open><summary>候选 patch</summary><pre class="project-patch">${esc(projectEvidence.patch || '')}</pre></details></div>` : '';
  root.innerHTML = `<div class="version-bar" role="tablist" aria-label="候选版本">${currentArtifacts.map((item) => `<button class="version-tab ${item.id === artifact.id ? 'is-active' : ''}" type="button" data-artifact-id="${esc(item.id)}" data-confirmed="${item.status === 'confirmed'}">v${item.version} · ${esc(item.status === 'rejected' ? '已拒绝应用' : item.reviewStatus === 'passed' ? '已核对' : item.reviewStatus === 'failed' ? '有问题' : '待核对')}</button>`).join('')}</div>
    <div class="proof-grid"><article class="artifact-paper"><header class="artifact-header"><span class="eyebrow">${artifact.status === 'confirmed' ? 'CONFIRMED EDITION' : 'CANDIDATE EDITION'}</span><h2>${esc(artifact.title)}</h2><div class="artifact-meta"><span>版本 v${artifact.version}</span><span>目标 ${esc(activeGoal(task)?.id === artifact.goalVersionId ? `v${activeGoal(task).version}（当前）` : '历史版本')}</span><span>生成角色 ${esc(artifact.createdByRole === 'user' ? '用户' : '写作角色')}</span><span>提供者 ${esc(artifact.provider)}</span><span>${esc(dateLabel(artifact.createdAt))}</span></div></header>
      <textarea id="artifact-editor" class="artifact-content" aria-label="${canEdit ? '成果正文' : '成果概要（只读）'}" ${canEdit ? '' : 'readonly'}>${esc(editorContent)}</textarea>
      ${previous ? `<details class="compare-block"><summary>与 v${previous.version} 并排比较</summary><div class="compare-columns"><pre>${esc(previous.content)}</pre><pre>${esc(artifact.content)}</pre></div></details>` : ''}
    </article><aside class="review-sidebar">
      <div class="review-panel"><h3>版本操作</h3><p class="field-note">${task.type === 'project' ? '代码正文不能在审阅台直接覆盖；修改要求会产生新的隔离候选，并重新固定检查、审阅和确认。' : '任何修改都会保存为新候选版本，不会覆盖这一版，也不会继承正式确认。重新生成本地文件不会改正文，但已有核对会失效。'}</p><div class="button-stack">${artifactBusy ? '<button class="secondary-button" type="button" disabled>正在处理当前版本…</button>' : ''}${!artifactBusy && artifact.status === 'candidate' && nativeFiles.length ? '<button class="secondary-button" type="button" data-action="refresh-native">重新生成本地文件</button>' : ''}${!artifactBusy && canEdit ? '<button class="secondary-button" type="button" data-action="save-revision">保存为新版本</button>' : ''}${!artifactBusy && artifact.status === 'candidate' ? '<button class="secondary-button" type="button" data-action="review-artifact">重新独立核对</button>' : ''}${!artifactBusy && artifact.reviewStatus === 'passed' && review?.passed && artifact.status === 'candidate' ? '<button class="primary-button" type="button" data-action="confirm-artifact">确认这个指定版本</button><button class="danger-button" type="button" data-action="reject-artifact">拒绝应用这个版本</button>' : ''}</div></div>
      ${(hasMultipleDeliverables || structuredPayload || summaryDiffersFromPayload) && artifact.status !== 'confirmed' ? `<div class="review-panel"><h3>通过同事修改真正成果</h3><p class="field-note">上方是只读概要，不会用普通文本覆盖${hasMultipleDeliverables ? '多份交付物' : structuredPayload ? '结构化电子表格或演示文稿' : '与概要不同的真正交付内容'}。请在同事对话中提交修改要求并重新运行，以产生结构完整的新版本。</p><button class="secondary-button" type="button" data-view-target="desk">回到任务书桌</button></div>` : ''}
      ${reviewPanel(review, artifact)}
      ${projectPanel}
      ${nativePanel}
      <div class="review-panel"><h3>来源账目</h3><p class="field-note">${artifact.sources.length ? artifact.sources.map((source) => `• ${esc(source)}`).join('<br>') : '没有记录外部来源。'}</p>${review?.sourceEvidence?.length ? review.sourceEvidence.map((source) => `<div class="check-row" data-passed="true"><span class="check-mark">↳</span><div><strong>${esc(source.sourceName)} · ${esc(source.locator)}</strong><p>${esc(source.quote)}</p></div></div>`).join('') : ''}</div>
      ${exportLinks(task, artifact)}
    </aside></div>`;
}

function renderConnections() {
  const root = $('#connection-list');
  if (!state.connections.length) { root.innerHTML = '<p class="empty-ledger">正在检查本机能力…</p>'; return; }
  root.innerHTML = state.connections.map((item, index) => {
    const status = !item.available ? '未连接'
      : item.id === 'codex-cli' ? item.verified ? '真实生成已验证' : item.runtimeVerified ? '程序可启动 · 生成未验证' : '已发现 · 未验证'
        : item.id === 'demo' ? '演示流程可用' : item.verified ? '可用 · 已核对' : '已发现 · 未验证';
    return `<section class="connection-row"><span class="connection-number">${String(index + 1).padStart(2,'0')}</span><h2>${esc(item.label)}</h2><p>${esc(item.boundary)}</p><div class="connection-state"><b>${status}</b><small>${esc(item.id)}</small>${item.id === 'codex-cli' && item.available ? '<button class="text-button" type="button" data-action="verify-codex">检查程序</button>' : ''}</div></section>`;
  }).join('');
}

function renderAll() {
  renderTaskList();
  renderOffice();
  renderDesk();
  renderReview();
  if ($('#coworker-dialog').open) renderCoworkerConversation();
  if (state.view === 'connections') renderConnections();
  managePolling();
}

async function loadTasks({ preserve = true } = {}) {
  if (!state.projectCapabilities) {
    try { state.projectCapabilities = (await api('/api/project-capabilities')).project; }
    catch { state.projectCapabilities = { available: false, reason: '无法核对本机固定代码隔离能力。', fixtures: [] }; }
  }
  const result = await api('/api/tasks');
  state.tasks = result.tasks;
  const remembered = preserve ? requestedTaskId || state.task?.id || localStorage.getItem('irixi.activeTask') : null;
  requestedTaskId = null;
  state.task = state.tasks.find((task) => task.id === remembered) || state.tasks[0] || null;
  if (state.task) localStorage.setItem('irixi.activeTask', state.task.id);
  if (state.task?.type === 'project') {
    try { state.projectScopeContexts[state.task.id] = await api(`/api/tasks/${encodeURIComponent(state.task.id)}/project-scope`); }
    catch { state.projectScopeContexts[state.task.id] = null; }
  }
  renderAll();
  setView(state.view);
}

async function refreshTask(id = state.task?.id, { silent = false } = {}) {
  if (!id) return;
  try {
    const previous = state.tasks.find((task) => task.id === id);
    const previousArtifactCount = previous?.artifacts?.length || 0;
    const result = await api(`/api/tasks/${encodeURIComponent(id)}`);
    const stillSelected = state.task?.id === id;
    if (stillSelected) state.task = result.task;
    if (stillSelected && result.task.type === 'project') {
      try { state.projectScopeContexts[id] = await api(`/api/tasks/${encodeURIComponent(id)}/project-scope`); }
      catch { state.projectScopeContexts[id] = null; }
    }
    if (stillSelected && state.view !== 'review' && result.task.artifacts.length > previousArtifactCount) {
      state.selectedArtifactId = latestArtifact(result.task)?.id || null;
    }
    state.tasks = state.tasks.map((task) => task.id === result.task.id ? result.task : task);
    if (!state.tasks.some((task) => task.id === result.task.id)) state.tasks.unshift(result.task);
    renderAll();
  } catch (error) { if (!silent) announce(error.message, 'error'); }
}

function managePolling() {
  const shouldPoll = shouldPollTask(state.task, {
    pendingAction: state.pendingAction,
    pendingActionTaskId: state.pendingActionTaskId,
    planning: planningBusy(state.task),
    conversation: Boolean(conversationRuntime(state.task)),
  });
  if (shouldPoll && !state.pollTimer) state.pollTimer = setInterval(() => refreshTask(state.task?.id, { silent: true }), 1700);
  if (!shouldPoll && state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

async function loadConnections() {
  try { state.connections = (await api('/api/connections')).connections; renderConnections(); }
  catch (error) { announce(error.message, 'error'); }
}

function openDialog(id) {
  const dialog = document.getElementById(id);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(button) {
  button.closest('dialog')?.close();
}

async function postTaskAction(action, body = {}) {
  if (!state.task) throw new Error('请先选择任务。');
  const taskId = state.task.id;
  const result = await api(`/api/tasks/${encodeURIComponent(taskId)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
  if (result.task) {
    if (state.task?.id === taskId) state.task = result.task;
    state.tasks = state.tasks.map((task) => task.id === result.task.id ? result.task : task);
  }
  renderAll();
  return result;
}

async function requestPlan() {
  const taskId = state.task?.id;
  state.pendingAction = 'planning';
  state.pendingActionTaskId = taskId;
  renderAll();
  managePolling();
  announce('Irixi 正在按当前目标形成计划。');
  try { return await postTaskAction('plan'); }
  finally {
    state.pendingAction = null;
    state.pendingActionTaskId = null;
    await refreshTask(taskId, { silent: true });
  }
}

document.addEventListener('click', async (event) => {
  const talkAgent = event.target.closest('[data-talk-agent]')?.dataset.talkAgent;
  if (talkAgent) {
    const agent = state.task?.team?.agents?.find((item) => item.id === talkAgent);
    if (agent) openCoworkerConversation({ agentId: agent.id, role: agent.roleKey, stationRole: agent.stationRole, name: agent.name, status: agent.status === 'working' ? '正在工作' : '可交谈', dynamic: true });
    return;
  }
  const talkRole = event.target.closest('[data-talk-role]')?.dataset.talkRole;
  if (talkRole) { window.irixiOffice?.talkToRole(talkRole); return; }
  const viewButton = event.target.closest('[data-view-target]');
  if (viewButton) { setView(viewButton.dataset.viewTarget); return; }
  const openButton = event.target.closest('[data-open-dialog]');
  if (openButton) { openDialog(openButton.dataset.openDialog); return; }
  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) { closeDialog(closeButton); return; }
  const taskButton = event.target.closest('[data-task-id]');
  if (taskButton) {
    const id = taskButton.dataset.taskId;
    state.task = state.tasks.find((task) => task.id === id);
    state.selectedArtifactId = null;
    localStorage.setItem('irixi.activeTask', id);
    if (state.task?.type === 'project') {
      try { state.projectScopeContexts[id] = await api(`/api/tasks/${encodeURIComponent(id)}/project-scope`); }
      catch { state.projectScopeContexts[id] = null; }
    }
    renderAll();
    setView(state.view);
    return;
  }
  const versionButton = event.target.closest('[data-artifact-id]');
  if (versionButton) { state.selectedArtifactId = versionButton.dataset.artifactId; renderReview(); return; }
  const retractMemory = event.target.closest('[data-retract-memory]')?.dataset.retractMemory;
  if (retractMemory) {
    try { await postTaskAction(`memory/${retractMemory}/retract`); announce('这条记忆已撤回，后续不会再检索。'); }
    catch (error) { announce(error.message, 'error'); }
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  try {
    if (action === 'plan') { await requestPlan(); announce('工作步骤已经按当前目标排定。'); }
    if (action === 'continue') {
      const result = await postTaskAction('continue');
      announce(result.action === 'running' ? 'Irixi 已从当前有效记录继续工作。' : result.message || '当前需要你的决定。', result.action === 'blocked' ? 'error' : 'normal');
    }
    if (action === 'run') { await postTaskAction('run'); announce('办公室已经开始工作。'); }
    if (action === 'cancel') { const result = await postTaskAction('cancel'); announce(result.task.status === 'cancellation_unknown' ? '已请求取消，正在确认本地进程。' : '本次运行已取消，记录仍然保留。'); }
    if (action === 'save-revision') {
      const artifact = selectedArtifact();
      const content = $('#artifact-editor').value.trim();
      if (!content) throw new Error('成果正文不能为空。');
      const result = await postTaskAction(`artifacts/${artifact.id}/revise`, { content, summary: `由用户基于 v${artifact.version} 修改` });
      state.selectedArtifactId = result.artifact.id;
      renderAll();
      announce(`已保存为候选版本 v${result.artifact.version}。`);
    }
    if (action === 'review-artifact') {
      const artifact = selectedArtifact();
      const taskId = state.task.id;
      state.pendingAction = 'artifact-review';
      state.pendingActionTaskId = taskId;
      artifact.reviewStatus = 'pending';
      renderAll();
      try {
        await postTaskAction(`artifacts/${artifact.id}/review`);
        announce('独立核对已经完成。');
      } finally {
        state.pendingAction = null;
        state.pendingActionTaskId = null;
        await refreshTask(taskId, { silent: true });
      }
    }
    if (action === 'refresh-native') {
      const artifact = selectedArtifact();
      if (!window.confirm(`重新生成候选版本 v${artifact.version} 的本地办公文件吗？\n\n正文不会改变；已有核对会保留为历史，生成后必须重新独立核对。`)) return;
      const taskId = state.task.id;
      state.pendingAction = 'native-refresh';
      state.pendingActionTaskId = taskId;
      artifact.reviewStatus = 'pending';
      renderAll();
      try {
        await postTaskAction(`artifacts/${artifact.id}/refresh-native`);
        announce('本地文件已重新生成，请检查预览并重新独立核对。');
      } finally {
        state.pendingAction = null;
        state.pendingActionTaskId = null;
        await refreshTask(taskId, { silent: true });
      }
    }
    if (action === 'confirm-artifact') {
      const artifact = selectedArtifact();
      if (!window.confirm(`只确认候选版本 v${artifact.version} 为当前正式成果吗？\n\n之后仍只会在你点击时下载新文件，不会自动发送或覆盖。`)) return;
      await postTaskAction(`artifacts/${artifact.id}/confirm`);
      announce(`版本 v${artifact.version} 已被明确确认。`);
    }
    if (action === 'reject-artifact') {
      const artifact = selectedArtifact();
      if (!window.confirm(`拒绝应用候选版本 v${artifact.version} 吗？它会保留在记录中，但不会成为正式成果。`)) return;
      await postTaskAction(`artifacts/${artifact.id}/reject`, { reason: '用户在成果审阅台拒绝应用此版本。' });
      announce(`版本 v${artifact.version} 已记录为拒绝应用。`);
    }
    if (action === 'verify-codex') {
      const result = await api('/api/connections/codex/verify', { method: 'POST', body: '{}' });
      state.connections = state.connections.map((item) => item.id === 'codex-cli' ? { ...item, runtimeVerified: result.runtimeVerified, verified: result.generationVerified } : item);
      renderConnections();
      announce(result.message, result.ok ? 'normal' : 'error');
    }
  } catch (error) { announce(error.message, 'error'); }
});

document.addEventListener('change', async (event) => {
  if (event.target.matches('[name="materialMode"]')) {
    $$('[data-material-panel]').forEach((panel) => { panel.hidden = panel.dataset.materialPanel !== event.target.value; });
    return;
  }
  if (event.target.matches('#task-form [name="type"]')) {
    const project = event.target.value === 'project';
    const provider = $('#task-form [name="provider"]');
    if (project) provider.value = 'codex-cli';
    provider.disabled = project;
    return;
  }
  if (event.target.matches('[data-project-fixture-select]')) {
    if (!state.task || state.task.type !== 'project') return;
    const fixture = state.projectCapabilities?.fixtures?.find((item) => item.id === event.target.value);
    if (!fixture) { renderDesk(); return; }
    state.projectFixtureSelections[state.task.id] = fixture.id;
    renderDesk();
    return;
  }
  if (event.target.matches('[data-suggestion-classification]')) {
    try { await postTaskAction(`suggestions/${event.target.dataset.suggestionClassification}/classification`, { classification: event.target.value }); announce('建议分类已更正，计划需要重新核对。'); }
    catch (error) { announce(error.message, 'error'); }
    return;
  }
  if (event.target.id === 'provider-select') {
    const provider = event.target.value;
    if (provider === 'codex-cli' && !window.confirm('切换到 Codex 后，运行时会把当前目标和选定材料发送给 Codex 服务。继续吗？')) { renderDesk(); return; }
    try { await postTaskAction('provider', { provider }); announce(provider === 'demo' ? '已切换到演示提供者。' : '已选择 Codex 真实模型。'); }
    catch (error) { announce(error.message, 'error'); }
  }
  if (event.target.id === 'memory-policy-select') {
    try { await postTaskAction('memory-policy', { policy: event.target.value }); announce(event.target.value === 'workspace-confirmed' ? '已允许搜索其他任务中由你确认的成果。' : '记忆范围已收回当前任务。'); }
    catch (error) { announce(error.message, 'error'); }
  }
  if (event.target.id === 'project-root-select') {
    try {
      const result = await postTaskAction('project-link', { rootTaskId: event.target.value });
      state.task = result.task;
      await loadTasks({ preserve: true });
      announce(result.task.projectRootTaskId ? '任务已关联到项目；后续只共享关联任务的必要摘要。' : '任务已恢复为独立任务。');
    } catch (error) { announce(error.message, 'error'); }
  }
});

document.addEventListener('submit', async (event) => {
  const scopeProposeForm = event.target.closest('[data-project-scope-propose]');
  if (scopeProposeForm) {
    event.preventDefault();
    try {
      await postTaskAction('project-scope/propose', {
        expectedTaskInputBinding: JSON.parse(scopeProposeForm.dataset.expectedBinding || 'null'),
        expectedRepositoryTreeSha256: scopeProposeForm.dataset.expectedTree || null,
      });
      announce('有限需求卡与检查建议已整理；请逐项核对后明确接受。');
      await loadTasks({ preserve: true });
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  const scopeAcceptForm = event.target.closest('[data-project-scope-accept]');
  if (scopeAcceptForm) {
    event.preventDefault();
    try {
      await postTaskAction('project-scope/accept', {
        proposalId: scopeAcceptForm.dataset.proposalId,
        expectedFingerprint: scopeAcceptForm.dataset.expectedFingerprint,
      });
      announce('需求卡、有限文件与逐条用例已接受；还需要单独授权隔离副本。');
      await loadTasks({ preserve: true });
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  const projectForm = event.target.closest('[data-project-workspace-attach]');
  if (projectForm) {
    event.preventDefault();
    const snapshot = projectWorkspaceAttachExpectation(projectForm);
    const fixtureId = new FormData(projectForm).get('fixtureId');
    try {
      await postTaskAction('project-workspace/attach', projectForm.matches('[data-generic-scope]') ? snapshot : { fixtureId, ...snapshot });
      delete state.projectFixtureSelections[state.task.id];
      announce('固定代码工作区已复制并完成实际路径隔离探针；原项目保持只读。');
      await loadTasks({ preserve: true });
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  const materialForm = event.target.closest('[data-material-applicability]');
  if (materialForm) {
    event.preventDefault();
    const data = new FormData(materialForm);
    const materialId = materialForm.dataset.materialApplicability;
    const body = {
      category: data.get('category'), disposition: data.get('disposition'), impact: data.get('impact'),
      purpose: String(data.get('purpose') || '').trim(), reason: String(data.get('reason') || '').trim(),
      // These values are the render-time snapshot. Never upgrade an old form to
      // the newest live task scope while the user is still editing it.
      ...materialDecisionExpectation(materialForm),
    };
    try {
      await postTaskAction(`materials/${materialId}/applicability`, body);
      announce('材料用途决定已保存；旧计划与旧候选不会冒充当前结果。');
      await loadTasks({ preserve: true });
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  const form = event.target.closest('[data-goal-replacement]');
  if (!form) return;
  event.preventDefault();
  const data = new FormData(form);
  const body = {
    statement: String(data.get('statement') || '').trim(),
    successCriteria: String(data.get('successCriteria') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    boundaries: String(data.get('boundaries') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
  };
  try {
    const result = await postTaskAction(`suggestions/${form.dataset.goalReplacement}/accept-goal`, body);
    announce(`新目标版本已生效；${result.syncedTaskIds?.length || 0} 个关联任务已停止旧运行并等待重规划。`);
    await loadTasks({ preserve: true });
  } catch (error) { announce(error.message, 'error'); }
});

$('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const element = event.currentTarget;
  const form = new FormData(element);
  const body = Object.fromEntries(form);
  if (body.type === 'project') body.provider = 'codex-cli';
  body.successCriteria = String(body.successCriteria || '').split(/\r?\n/).filter(Boolean);
  body.boundaries = String(body.boundaries || '').split(/\r?\n/).filter(Boolean);
  try {
    const result = await api('/api/tasks', { method: 'POST', body: JSON.stringify(body) });
    state.task = result.task;
    state.tasks.unshift(result.task);
    localStorage.setItem('irixi.activeTask', result.task.id);
    element.reset();
    element.closest('dialog').close();
    renderAll();
    setView('desk');
    announce('任务已经进入账本，目标版本 v1 生效。');
  } catch (error) { announce(error.message, 'error'); }
});

$('#suggestion-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const element = event.currentTarget;
  const body = Object.fromEntries(new FormData(element));
  if (!body.classification) delete body.classification;
  try {
    const result = await postTaskAction('suggestions', body);
    element.reset();
    element.closest('dialog').close();
    announce(result.suggestion.classification === 'replace' ? '这条建议可能替代目标，相关工作已暂停等待你确认。' : `建议已归入“${SUGGESTION_LABEL[result.suggestion.classification]}”。`);
  } catch (error) { announce(error.message, 'error'); }
});

$('#coworker-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.task) { $('#coworker-dialog').close(); openDialog('task-dialog'); announce('先建立目标，再把工作交给同事。'); return; }
  const element = event.currentTarget;
  const data = Object.fromEntries(new FormData(element));
  const role = ROLE_LABEL[data.role] || data.role;
  try {
    if (state.task.status === 'running' || state.task.status === 'cancellation_unknown') {
      const work = state.task.workItems.find((item) => item.agentId === state.coworker?.agentId && item.status === 'running') || state.task.workItems.find((item) => item.agentId === state.coworker?.agentId) || state.task.workItems.find((item) => item.role === data.role && item.status === 'running') || state.task.workItems.find((item) => item.role === data.role);
      let routed = null;
      if (data.intent !== 'progress') routed = await postTaskAction('suggestions', { text: `${role}：${data.intent === 'revise' ? '修改要求' : '工作交代'}：${data.text}` });
      if (routed?.suggestion?.classification === 'replace' || routed?.suggestion?.classification === 'unclear') {
        const guard = routed.suggestion.classification === 'replace' ? '这句话可能替代目标，已暂停当前运行等待你明确确认。' : '这句话作用不明确，已保存但不会作为已接受指令进入模型。';
        state.conversationMessages.push({ by: '你', text: data.text }, { by: '目标守卫', text: `${work ? `${work.title}目前为“${WORK_STATUS[work.status] || work.status}”。` : ''}${guard}` });
      } else {
        state.conversationPending = true; state.conversationTaskId = state.task.id; state.conversationRole = data.role;
        await postTaskAction('conversation', { role: data.role, agentId: state.coworker?.agentId || null, message: data.text });
      }
    } else {
      const prefix = data.intent === 'revise' ? '修改要求' : '工作交代';
      if (data.intent !== 'progress') {
        const routed = await postTaskAction('suggestions', { text: `${role}：${prefix}：${data.text}` });
        if (routed.suggestion?.classification === 'replace') {
          state.conversationMessages.push({ by: '目标守卫', text: '这句话可能替代当前目标，已暂停受影响工作并等待你明确确认；它不会作为普通工作交代进入模型。' });
          $('#coworker-message').value = '';
          renderCoworkerConversation();
          return;
        }
        if (routed.suggestion?.classification === 'unclear') {
          state.conversationMessages.push({ by: '目标守卫', text: '这句话的作用尚不明确，已保存但不会作为已接受工作交代进入模型。请先更正分类。' });
          $('#coworker-message').value = '';
          renderCoworkerConversation();
          return;
        }
      }
      state.conversationPending = true;
      state.conversationTaskId = state.task.id;
      state.conversationRole = data.role;
      const submit = element.querySelector('[type="submit"]');
      submit.disabled = true;
      $('#cancel-conversation-button').hidden = false;
      $('#coworker-message').disabled = true;
      $('#coworker-intent').disabled = true;
      renderCoworkerConversation();
      renderOffice();
      const result = await postTaskAction('conversation', { role: data.role, agentId: state.coworker?.agentId || null, message: data.text });
      if (result.reply?.kind === 'cannot_answer') announce('同事需要更多材料或澄清才能回答。', 'error');
    }
    $('#coworker-message').value = '';
    renderCoworkerConversation();
    $('#coworker-message').focus();
  } catch (error) { announce(error.message, 'error'); }
  finally {
    state.conversationPending = false;
    state.conversationTaskId = null;
    state.conversationRole = null;
    element.querySelector('[type="submit"]').disabled = false;
    $('#cancel-conversation-button').hidden = true;
    $('#coworker-message').disabled = false;
    $('#coworker-intent').disabled = false;
    renderCoworkerConversation();
    renderOffice();
  }
});

$('#cancel-conversation-button').addEventListener('click', async () => {
  if (!conversationRuntime()) return;
  try {
    await postTaskAction('conversation/cancel');
    announce('已请求取消这次模型回复；任务与已有成果保持不变。');
  } catch (error) { announce(error.message, 'error'); }
});

$('#material-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const element = event.currentTarget;
  const form = new FormData(element);
  const mode = form.get('materialMode');
  try {
    let result;
    if (mode === 'text') result = await postTaskAction('materials/text', { name: form.get('name'), text: form.get('text') });
    if (mode === 'url') result = await postTaskAction('materials/url', { name: form.get('name'), url: form.get('url') });
    if (mode === 'file') {
      const file = form.get('file');
      if (!(file instanceof File) || !file.size) throw new Error('请先选择一个文件。');
      if (file.size > 1_500_000) throw new Error('文件不能超过 1.5 MB。');
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取选中的文件。'));
        reader.readAsDataURL(file);
      });
      result = await postTaskAction('materials/file', { name: form.get('name') || file.name, base64 });
    }
    element.reset();
    $$('[data-material-panel]').forEach((panel) => { panel.hidden = panel.dataset.materialPanel !== 'text'; });
    element.closest('dialog').close();
    announce(`${result.material.name} 已进入材料账本。`);
  } catch (error) {
    if (error.body?.task) {
      state.task = error.body.task;
      state.tasks = state.tasks.map((task) => task.id === state.task.id ? state.task : task);
      renderAll();
    }
    announce(error.message, 'error');
  }
});

$$('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
  if (event.target === dialog) dialog.close();
}));

$('#coworker-dialog').addEventListener('close', () => { window.irixiOffice?.cancelWalk(); syncSceneFrame(); });
$('#coworker-dialog').addEventListener('cancel', () => { window.irixiOffice?.cancelWalk(); syncSceneFrame(); });

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('#coworker-dialog').open) {
    event.preventDefault();
    $('#coworker-dialog').close();
    window.irixiOffice?.cancelWalk();
    announce('已结束交谈并取消自动走近。');
    return;
  }
  if (event.key.toLowerCase() === 'n' && (event.metaKey || event.ctrlKey) && !event.target.matches('input, textarea, select')) {
    event.preventDefault(); openDialog('task-dialog');
  }
});

window.addEventListener('irixi:office-ready', () => { state.sceneReady = true; syncSceneFrame(); });
function openCoworkerConversation(detail) {
  const dialog = $('#coworker-dialog');
  const assigned = !detail.dynamic ? state.task?.team?.agents?.find((agent) => agent.stationRole === detail.role && agent.goalVersionId === activeGoal()?.id) : null;
  if (assigned) detail = { ...detail, agentId: assigned.id, role: assigned.roleKey, stationRole: assigned.stationRole, name: `${assigned.name}（${detail.name}工位）`, dynamic: true };
  state.coworker = detail;
  state.conversationMessages = [];
  $('#coworker-role').textContent = ROLE_LABEL[detail.role] || detail.role;
  $('#coworker-name').textContent = `与${detail.name}交谈`;
  $('#coworker-status').textContent = `当前状态：${detail.status}。Irixi 正在自动走近；现在就可以输入。`;
  dialog.querySelector('[name="role"]').value = detail.role;
  renderCoworkerConversation();
  if (!dialog.open) dialog.showModal();
  syncSceneFrame();
  requestAnimationFrame(() => {
    const history = $('#coworker-history');
    history.scrollTop = history.scrollHeight;
    $('#coworker-message').focus();
  });
}

window.addEventListener('irixi:coworker', (event) => openCoworkerConversation(event.detail));
window.addEventListener('irixi:arrival', () => { $('#coworker-status').textContent = 'Irixi 已经走到同事身边。输入期间移动键保持锁定。'; });
window.addEventListener('irixi:unreachable', (event) => { $('#coworker-status').textContent = `${event.detail.name}附近没有可到达的位置。对话仍可记录，或按 Esc 取消。`; announce('目标位置暂时无法到达，对话仍然可用。', 'error'); });
window.addEventListener('irixi:walk-cancelled', (event) => announce(event.detail.message));

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-coworker-action]')?.dataset.coworkerAction;
  if (!action) return;
  try {
    if (action === 'new-task') { $('#coworker-dialog').close(); openDialog('task-dialog'); return; }
    if (action === 'material') { $('#coworker-dialog').close(); openDialog('material-dialog'); return; }
    if (action === 'review') { $('#coworker-dialog').close(); setView('review'); return; }
    if (action === 'plan') { await requestPlan(); state.conversationMessages.push({ by: '办公室回执', text: '工作计划已经按当前目标形成。' }); }
    if (action === 'cancel-plan') { await postTaskAction('cancel'); state.conversationMessages.push({ by: '办公室回执', text: '这次形成计划已取消，原目标和材料保持不变。' }); }
    if (action === 'run') { await postTaskAction('run'); state.conversationMessages.push({ by: '办公室回执', text: state.task.provider === 'demo' ? '演示流程已经开始；它不会调用模型。' : '真实模型工作已经开始；结果将回到同一个任务记录。' }); }
    renderCoworkerConversation();
  } catch (error) { announce(error.message, 'error'); }
});

loadTasks()
  .then(() => loadScene())
  .catch((error) => announce(`Irixi 无法读取本地任务：${error.message}`, 'error'));
