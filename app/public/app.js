const state = {
  tasks: [],
  task: null,
  view: 'office',
  selectedArtifactId: null,
  connections: [],
  pollTimer: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const lines = (items, empty = '—') => Array.isArray(items) && items.length ? items.map((item) => `• ${item}`).join('\n') : empty;
const dateLabel = (value) => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';

const TASK_STATUS = {
  idle: '空闲', ready: '计划就绪', running: '正在工作', waiting_user: '等待你确认', partial: '部分完成',
  ready_to_export: '可以导出', failed: '运行失败', cancelled: '已取消', completed: '已完成',
};
const WORK_STATUS = {
  pending: '待排', ready: '就绪', running: '进行中', completed: '完成', waiting_user: '待确认',
  blocked: '受阻', failed: '失败', cancelled: '取消',
};
const SUGGESTION_LABEL = { support: '支持目标', replace: '替代目标', deviate: '偏离 / 以后', unclear: '暂不明确' };
const ROLE_LABEL = { coordinator: 'Irixi · 协调', archivist: '松鼠 · 档案', researcher: '狐狸 · 研究', writer: '獾 · 写作', reviewer: '猫 · 审阅', steward: '兔 · 事务' };

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

function latestArtifact(task = state.task) {
  return task?.artifacts?.at(-1) || null;
}

function selectedArtifact() {
  return state.task?.artifacts?.find((item) => item.id === state.selectedArtifactId) || latestArtifact();
}

function latestReview(artifact) {
  return state.task?.reviews?.filter((item) => item.artifactId === artifact?.id).at(-1) || null;
}

function nextAction(task) {
  if (!task) return '先建立一项工作。';
  if (task.status === 'running') return `${ROLE_LABEL[task.activeRole] || task.activeRole}正在推进，进度会自动刷新。`;
  if (task.status === 'waiting_user') return '到成果审阅台检查核对结果，决定是否确认这个版本。';
  if (task.status === 'ready_to_export') return '已确认指定版本；到成果审阅台下载一份新文件。';
  if (task.status === 'failed') return '查看活动记录中的失败原因，修正后可以安全重新运行。';
  if (task.status === 'partial') return '审阅发现阻塞项。修改候选稿或补充材料后重新核对。';
  if (task.status === 'cancelled') return '任务已取消。已有材料和候选稿仍保留，可重新形成计划。';
  if (!task.materials.length) return '先到任务书桌加入本次工作需要的材料。';
  if (!task.workItems.length) return '让 Irixi 根据当前目标形成工作计划。';
  return '工作计划已经准备好，可以开始生成候选成果。';
}

function officeState(task) {
  if (!task) return { kicker: 'OFFICE AT REST', title: '办公室正在等候第一项工作', detail: '建立任务后，角色状态会投影到这里。', tone: 'normal' };
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
  };
  const value = states[task.status] || states.idle;
  return { kicker: value[0], title: value[1], detail: value[2], tone: ['running'].includes(task.status) ? 'working' : ['failed', 'partial'].includes(task.status) ? 'attention' : 'normal' };
}

function roleState(role, task) {
  if (!task) return { state: 'idle', label: '待命' };
  if (role === 'coordinator') {
    if (task.activeRole === 'coordinator' && task.status === 'running') return { state: 'active', label: '协调中' };
    if (task.status === 'failed') return { state: 'failed', label: '已停下' };
    return { state: 'done', label: '守住目标' };
  }
  const item = task.workItems.find((work) => work.role === role);
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
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
    return `<div class="role-cell" data-state="${value.state}"><b>${esc(ROLE_LABEL[role])}</b><span>${esc(value.label)}</span></div>`;
  }).join('');

  const actions = $('#office-actions');
  if (!task) actions.innerHTML = '<button class="secondary-button wide-button" type="button" data-open-dialog="task-dialog">建立第一项工作</button>';
  else if (task.status === 'running') actions.innerHTML = '<button class="danger-button wide-button" type="button" data-action="cancel">取消本次运行</button><button class="secondary-button wide-button" type="button" data-view-target="desk">查看任务书桌</button>';
  else if (['waiting_user', 'partial', 'ready_to_export'].includes(task.status)) actions.innerHTML = '<button class="secondary-button wide-button" type="button" data-view-target="review">前往成果审阅</button><button class="secondary-button wide-button" type="button" data-view-target="desk">查看任务书桌</button>';
  else actions.innerHTML = '<button class="secondary-button wide-button" type="button" data-view-target="desk">继续这项工作</button><button class="secondary-button wide-button" type="button" data-open-dialog="suggestion-dialog">记录新建议</button>';
}

function renderMaterials(task) {
  if (!task.materials.length) return '<p class="empty-ledger">尚未加入材料。Irixi 可以使用粘贴文本、TXT/MD、DOCX、可搜索 PDF 和明确网址。</p>';
  return `<ol class="register-list">${task.materials.map((item, index) => `<li class="register-row"><span class="row-index">${String(index + 1).padStart(2, '0')}</span><div><strong>${esc(item.name)}</strong><p>${esc(item.status === 'ready' ? `${item.source} · ${item.bytes || 0} 字节` : item.error || '读取失败')}</p></div><span class="record-status" data-tone="${item.status === 'ready' ? 'good' : 'bad'}">${item.status === 'ready' ? '可读' : '失败'}</span></li>`).join('')}</ol>`;
}

function renderSuggestions(task) {
  if (!task.suggestions.length) return '<p class="empty-ledger">还没有新建议。补充想法会先分类，不会悄悄改掉最终目标。</p>';
  return task.suggestions.slice().reverse().map((item) => `
    <div class="suggestion-row"><p>${esc(item.text)}</p><div class="suggestion-meta">
      <select aria-label="建议分类" data-suggestion-classification="${esc(item.id)}">
        ${Object.entries(SUGGESTION_LABEL).map(([key, label]) => `<option value="${key}" ${item.classification === key ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select><span class="record-status" data-tone="${item.classification === 'replace' ? 'bad' : item.classification === 'support' ? 'good' : 'active'}">${esc(item.status)}</span>
    </div>${item.classification === 'replace' && item.status === 'waiting_user' ? `<div class="goal-replacement"><p>这会结束当前目标版本、作废旧计划并建立新目标版本。候选成果不会自动继承确认。</p><button class="danger-button" type="button" data-accept-goal="${esc(item.id)}">明确接受为新目标</button></div>` : ''}</div>`).join('');
}

function renderWork(task) {
  if (!task.workItems.length) return '<p class="empty-ledger">还没有工作步骤。Irixi 会根据成果类型和材料按需安排角色。</p>';
  return task.workItems.map((item, index) => `<div class="progress-line" data-state="${esc(item.status)}"><span class="progress-symbol">${String(index + 1).padStart(2, '0')}</span><div><strong>${esc(item.title)}</strong><small>${esc(ROLE_LABEL[item.role] || item.role)} · ${esc(item.expectedResult)}</small></div><span class="record-status" data-tone="${item.status === 'completed' ? 'good' : ['failed','blocked'].includes(item.status) ? 'bad' : item.status === 'running' ? 'active' : ''}">${esc(WORK_STATUS[item.status] || item.status)}</span></div>`).join('');
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
  root.innerHTML = `<div class="desk-columns"><div class="desk-stack">
    <section class="desk-sheet"><div class="sheet-heading"><h2>材料账本</h2><button class="secondary-button" type="button" data-open-dialog="material-dialog">＋ 加入材料</button></div><div class="sheet-body">${renderMaterials(task)}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>新建议</h2><button class="secondary-button" type="button" data-open-dialog="suggestion-dialog">＋ 记录建议</button></div><div class="sheet-body">${renderSuggestions(task)}</div></section>
  </div><aside class="desk-stack">
    <section class="desk-sheet"><div class="sheet-heading"><h2>执行方式</h2></div><div class="sheet-body provider-line"><label for="provider-select">模型提供者</label><select id="provider-select" ${isRunning ? 'disabled' : ''}><option value="demo" ${task.provider === 'demo' ? 'selected' : ''}>演示提供者</option><option value="codex-cli" ${task.provider === 'codex-cli' ? 'selected' : ''}>Codex CLI · 真实模型</option></select>${task.provider === 'demo' ? '<p class="demo-warning">演示模式只验证流程，不代表真实智能产出。正式内容请切换 Codex。</p>' : '<p class="field-note">运行时会把当前目标与选定材料发送给 Codex；在隔离只读目录中执行。</p>'}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>工作步骤</h2><span class="record-status" data-tone="${isRunning ? 'active' : ''}">${esc(TASK_STATUS[task.status] || task.status)}</span></div><div class="sheet-body">${renderWork(task)}<div class="inline-actions" style="margin-top:16px">${!task.workItems.length ? '<button class="primary-button" type="button" data-action="plan">形成计划</button>' : isRunning ? '<button class="danger-button" type="button" data-action="cancel">取消运行</button>' : '<button class="primary-button" type="button" data-action="run">生成候选成果</button>'}<button class="secondary-button" type="button" data-view-target="review">查看成果</button></div></div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>活动记录</h2></div><div class="sheet-body"><ol class="register-list">${task.events.slice(-8).reverse().map((item, index) => `<li class="register-row"><span class="row-index">${String(task.events.length - index).padStart(2,'0')}</span><div><strong>${esc(item.message)}</strong><p>${esc(dateLabel(item.at))}</p></div></li>`).join('')}</ol></div></section>
  </aside></div>`;
}

function reviewPanel(review) {
  if (!review) return '<div class="review-panel"><h3>独立核对</h3><p class="field-note">这个版本还没有审阅记录。</p></div>';
  return `<div class="review-panel"><span class="record-status" data-tone="${review.passed ? 'good' : 'bad'}">${review.passed ? '通过' : '有阻塞项'}</span><h3>独立核对</h3><p class="field-note">${esc(review.summary)}</p>${review.checks.map((check) => `<div class="check-row" data-passed="${check.passed}"><span class="check-mark">${check.passed ? '✓' : '×'}</span><div><strong>${esc(check.name)}${check.blocking ? '' : '（非阻塞）'}</strong><p>${esc(check.evidence)}</p></div></div>`).join('')}</div>`;
}

function exportLinks(task, artifact) {
  if (artifact.status !== 'confirmed') return '';
  const approval = task.approvals.filter((item) => item.artifactId === artifact.id && item.status === 'confirmed').at(-1);
  if (!approval) return '';
  const base = `/api/tasks/${encodeURIComponent(task.id)}/artifacts/${encodeURIComponent(artifact.id)}/export?approval=${encodeURIComponent(approval.id)}`;
  const links = [`<a class="export-link" href="${base}&format=md">下载 Markdown 新文件</a>`, `<a class="export-link" href="${base}&format=html">下载 HTML（可打印 PDF）</a>`];
  if (task.type === 'email') links.push(`<a class="export-link" href="${base}&format=eml">下载 EML 邮件草稿</a>`);
  if (task.type === 'calendar') links.push(`<a class="export-link" href="${base}&format=ics">下载 ICS 日历草稿</a>`);
  return `<div class="review-panel"><h3>正式交付</h3><p class="field-note">每次点击只下载一份新文件，不发送、不发布、不覆盖来源。</p><div class="export-list">${links.join('')}</div></div>`;
}

function renderReview() {
  const root = $('#review-content');
  const task = state.task;
  if (!task || !task.artifacts.length) {
    root.innerHTML = `<div class="empty-desk"><span class="eyebrow">NO PROOF YET</span><h2>${task ? '还没有候选成果' : '尚未选择任务'}</h2><p>${task ? '先在任务书桌形成计划并运行，候选版本才会出现在审阅台。' : '选择或建立一项任务后再来审阅。'}</p><button class="secondary-button" type="button" data-view-target="desk">前往任务书桌</button></div>`;
    return;
  }
  const artifact = selectedArtifact();
  state.selectedArtifactId = artifact.id;
  const review = latestReview(artifact);
  const previous = artifact.previousId ? task.artifacts.find((item) => item.id === artifact.previousId) : null;
  const canEdit = artifact.status !== 'confirmed';
  root.innerHTML = `<div class="version-bar" role="tablist" aria-label="候选版本">${task.artifacts.map((item) => `<button class="version-tab ${item.id === artifact.id ? 'is-active' : ''}" type="button" data-artifact-id="${esc(item.id)}" data-confirmed="${item.status === 'confirmed'}">v${item.version} · ${esc(item.reviewStatus === 'passed' ? '已核对' : item.reviewStatus === 'failed' ? '有问题' : '待核对')}</button>`).join('')}</div>
    <div class="proof-grid"><article class="artifact-paper"><header class="artifact-header"><span class="eyebrow">${artifact.status === 'confirmed' ? 'CONFIRMED EDITION' : 'CANDIDATE EDITION'}</span><h2>${esc(artifact.title)}</h2><div class="artifact-meta"><span>版本 v${artifact.version}</span><span>目标 ${esc(activeGoal(task)?.id === artifact.goalVersionId ? `v${activeGoal(task).version}（当前）` : '历史版本')}</span><span>生成角色 ${esc(artifact.createdByRole === 'user' ? '用户' : '写作角色')}</span><span>提供者 ${esc(artifact.provider)}</span><span>${esc(dateLabel(artifact.createdAt))}</span></div></header>
      <textarea id="artifact-editor" class="artifact-content" aria-label="成果正文" ${canEdit ? '' : 'readonly'}>${esc(artifact.content)}</textarea>
      ${previous ? `<details class="compare-block"><summary>与 v${previous.version} 并排比较</summary><div class="compare-columns"><pre>${esc(previous.content)}</pre><pre>${esc(artifact.content)}</pre></div></details>` : ''}
    </article><aside class="review-sidebar">
      <div class="review-panel"><h3>版本操作</h3><p class="field-note">任何修改都会保存为新候选版本，不会覆盖这一版，也不会继承正式确认。</p><div class="button-stack">${canEdit ? '<button class="secondary-button" type="button" data-action="save-revision">保存为新版本</button><button class="secondary-button" type="button" data-action="review-artifact">重新独立核对</button>' : ''}${review?.passed && artifact.status !== 'confirmed' ? '<button class="primary-button" type="button" data-action="confirm-artifact">确认这个指定版本</button>' : ''}</div></div>
      ${reviewPanel(review)}
      <div class="review-panel"><h3>来源账目</h3><p class="field-note">${artifact.sources.length ? artifact.sources.map((source) => `• ${esc(source)}`).join('<br>') : '没有记录外部来源。'}</p></div>
      ${exportLinks(task, artifact)}
    </aside></div>`;
}

function renderConnections() {
  const root = $('#connection-list');
  if (!state.connections.length) { root.innerHTML = '<p class="empty-ledger">正在检查本机能力…</p>'; return; }
  root.innerHTML = state.connections.map((item, index) => `<section class="connection-row"><span class="connection-number">${String(index + 1).padStart(2,'0')}</span><h2>${esc(item.label)}</h2><p>${esc(item.boundary)}</p><div class="connection-state"><b>${item.available ? item.verified ? '可用 · 已核对' : '已发现 · 未验证' : '未连接'}</b><small>${esc(item.id)}</small>${item.id === 'codex-cli' && item.available ? '<button class="text-button" type="button" data-action="verify-codex">验证运行</button>' : ''}</div></section>`).join('');
}

function renderAll() {
  renderTaskList();
  renderOffice();
  renderDesk();
  renderReview();
  if (state.view === 'connections') renderConnections();
  managePolling();
}

async function loadTasks({ preserve = true } = {}) {
  const result = await api('/api/tasks');
  state.tasks = result.tasks;
  const remembered = preserve ? state.task?.id || localStorage.getItem('irixi.activeTask') : null;
  state.task = state.tasks.find((task) => task.id === remembered) || state.tasks[0] || null;
  if (state.task) localStorage.setItem('irixi.activeTask', state.task.id);
  renderAll();
}

async function refreshTask(id = state.task?.id, { silent = false } = {}) {
  if (!id) return;
  try {
    const previousArtifactCount = state.task?.artifacts?.length || 0;
    const result = await api(`/api/tasks/${encodeURIComponent(id)}`);
    state.task = result.task;
    if (state.view !== 'review' && result.task.artifacts.length > previousArtifactCount) {
      state.selectedArtifactId = result.task.artifacts.at(-1)?.id || null;
    }
    state.tasks = state.tasks.map((task) => task.id === result.task.id ? result.task : task);
    if (!state.tasks.some((task) => task.id === result.task.id)) state.tasks.unshift(result.task);
    renderAll();
  } catch (error) { if (!silent) announce(error.message, 'error'); }
}

function managePolling() {
  const shouldPoll = state.task?.status === 'running';
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
  const result = await api(`/api/tasks/${encodeURIComponent(state.task.id)}/${action}`, { method: 'POST', body: JSON.stringify(body) });
  if (result.task) {
    state.task = result.task;
    state.tasks = state.tasks.map((task) => task.id === result.task.id ? result.task : task);
  }
  renderAll();
  return result;
}

document.addEventListener('click', async (event) => {
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
    renderAll();
    return;
  }
  const versionButton = event.target.closest('[data-artifact-id]');
  if (versionButton) { state.selectedArtifactId = versionButton.dataset.artifactId; renderReview(); return; }
  const acceptGoal = event.target.closest('[data-accept-goal]');
  if (acceptGoal) {
    const suggestion = state.task.suggestions.find((item) => item.id === acceptGoal.dataset.acceptGoal);
    if (!window.confirm(`确定把当前目标替换为：\n\n${suggestion.text}\n\n旧计划会作废，已有成果不会自动成为新目标的正式成果。`)) return;
    try { await postTaskAction(`suggestions/${suggestion.id}/accept-goal`, { statement: suggestion.text }); announce('新目标版本已生效，旧计划已作废。'); }
    catch (error) { announce(error.message, 'error'); }
    return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action) return;
  try {
    if (action === 'plan') { await postTaskAction('plan'); announce('工作步骤已经按当前目标排定。'); }
    if (action === 'run') { await postTaskAction('run'); announce('办公室已经开始工作。'); }
    if (action === 'cancel') { await postTaskAction('cancel'); announce('本次运行已取消，记录仍然保留。'); }
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
      await postTaskAction(`artifacts/${artifact.id}/review`);
      announce('独立核对已经完成。');
    }
    if (action === 'confirm-artifact') {
      const artifact = selectedArtifact();
      if (!window.confirm(`只确认候选版本 v${artifact.version} 为当前正式成果吗？\n\n之后仍只会在你点击时下载新文件，不会自动发送或覆盖。`)) return;
      await postTaskAction(`artifacts/${artifact.id}/confirm`);
      announce(`版本 v${artifact.version} 已被明确确认。`);
    }
    if (action === 'verify-codex') {
      const result = await api('/api/connections/codex/verify', { method: 'POST', body: '{}' });
      state.connections = state.connections.map((item) => item.id === 'codex-cli' ? { ...item, verified: result.ok } : item);
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
});

$('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const element = event.currentTarget;
  const form = new FormData(element);
  const body = Object.fromEntries(form);
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

window.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 'n' && (event.metaKey || event.ctrlKey) && !event.target.matches('input, textarea, select')) {
    event.preventDefault(); openDialog('task-dialog');
  }
});

loadTasks().catch((error) => announce(`Irixi 无法读取本地任务：${error.message}`, 'error'));
