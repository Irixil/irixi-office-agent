import { synchronizedUrl } from './navigation-state.js';
import { materialDecisionExpectation, planInputsChanged, projectWorkspaceAttachExpectation, shouldPollTask } from './task-input-state.js';
import { canCreateNativeTask, canReviewNativeCandidate, createBoundTextareaDraft, escapeHtml, filterNativeTaskHistory, gameWorkspaceBindingMatches, gameWorkspaceFileResponseMatches, nativeActionPayload, nativeCoworkerPresence, nativeExecutionRoleFallback, nativeFunctionChatContext, nativeOfficeWaitingPresentation, nativeProductAsOfficeTask, nativeReviewBinding, normalizeNativeCandidate, normalizeNativeProductState, normalizeNativeTaskDraft, officeFunctionForCoworker, renderNativeMarkup, renderTaskListMarkup } from './native-product-state.js';

const initialQuery = new URLSearchParams(window.location.search);
let requestedTaskId = initialQuery.get('task');
const requestedView = initialQuery.get('view');
const requestedBackend = initialQuery.get('backend') || (initialQuery.has('irixiTask') ? 'openoffice' : null) || document.querySelector('meta[name="irixi-backend"]')?.content || 'legacy';
const state = {
  tasks: [],
  nativeTaskHistory: { tasks: [], activeTaskId: null, activeTaskRevision: null, loading: false, selecting: false, error: null },
  nativeTaskFilter: { query: '', projectId: '' },
  nativeTaskHistoryLoadedAt: 0,
  task: null,
  view: ['office', 'desk', 'review', 'connections'].includes(requestedView) ? requestedView : 'office',
  selectedArtifactId: null,
  connections: [],
  pollTimer: null,
  nativeRefreshGeneration: 0,
  nativeRefreshesInFlight: 0,
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
  backendMode: requestedBackend === 'openoffice' ? 'openoffice-loading' : 'legacy',
  nativeProduct: null,
  nativeError: null,
  nativeCandidate: null,
  nativeCandidateLoading: false,
  nativeCandidateError: null,
  nativeReviewPending: null,
  nativeReviewRoundPending: null,
  nativeMemoryDraft: null,
  nativeReviewEvidenceDraft: null,
  nativeReviewAdjudicationDraft: null,
  learningEntryPending: false,
  gameWorkshopTaskId: null,
  gameWorkspaceLoading: false,
  gameWorkspaceError: null,
  gameWorkspaceData: null,
  gameWorkspaceFile: null,
  gameWorkspaceFilePath: null,
  gameWorkspaceFileView: 'source',
  gameWorkspaceRequestSeq: 0,
};
const nativeReviseDraft = createBoundTextareaDraft('form[data-native-revise] textarea[name="reason"]');

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = escapeHtml;
const lines = (items, empty = '—') => Array.isArray(items) && items.length ? items.map((item) => `• ${item}`).join('\n') : empty;
const dateLabel = (value) => value ? new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';

const TASK_STATUS = {
  idle: '空闲', waiting_start: '等待启动', ready: '计划就绪', running: '正在工作', waiting_user: '等待你确认', partial: '部分完成',
  ready_to_export: '可以导出', failed: '运行失败', cancelled: '已取消', cancellation_unknown: '正在确认取消', completed: '已完成',
};
const WORK_STATUS = {
  pending: '待排', ready: '就绪', running: '进行中', completed: '完成', waiting_user: '待确认',
  blocked: '受阻', failed: '失败', cancelled: '取消', stale: '历史失效',
};
const SUGGESTION_LABEL = { support: '支持目标', replace: '替代目标', deviate: '偏离 / 以后', unclear: '暂不明确' };
const ROLE_LABEL = { coordinator: 'Irixi · 协调', archivist: '花枝鼠 · 档案记忆', researcher: '仓鼠·学习', writer: '小鼠·小工具开发', reviewer: '龙猫·小游戏开发', steward: '鼹鼠·Agent开发' };
const UTILITY_TASK_DRAFT_KEY = 'irixi.native.utility-task-draft.v1';
const COMMISSION_FUNCTIONS = {
  utility: { title: '小工具', action: '交代小工具需求', titlePlaceholder: '例如：整理 CSV 的桌面小工具', goalPlaceholder: '说明这个工具要解决什么问题、输入和输出是什么；成功条件与边界可留空。' },
  game: { title: '小游戏', action: '交代小游戏需求', titlePlaceholder: '例如：办公室里的记忆配对小游戏', goalPlaceholder: '描述玩法、目标平台和你希望玩家完成的体验；成功条件与边界可留空。' },
  agent: { title: 'Agent', action: '交代 Agent 需求', titlePlaceholder: '例如：帮助整理项目材料的 Agent', goalPlaceholder: '说明 Agent 要帮助谁、处理什么任务以及预期结果；成功条件与边界可留空。' },
};
const GAME_PROJECT_ID = 'noobi-owl-book-sorter-v1';

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json', ...(options.headers || {}) } : options.headers,
  });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(body?.error?.message || body?.error || (typeof body === 'string' && body) || `请求失败 (${response.status})`);
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

function nativeMode() {
  return state.backendMode === 'openoffice';
}

function nativeBlocked() {
  return state.backendMode === 'openoffice-blocked';
}

function setBackendUi() {
  document.body.dataset.backend = state.backendMode;
  const canCreateTask = canCreateNativeTask(state.nativeProduct, state.backendMode);
  const unavailableDialogs = nativeBlocked()
    ? new Set(['task-dialog', 'material-dialog', 'suggestion-dialog'])
    : nativeMode() && !canCreateTask ? new Set(['task-dialog']) : new Set();
  $$('[data-open-dialog]').forEach((button) => {
    button.hidden = unavailableDialogs.has(button.dataset.openDialog);
  });
  const materialForm = $('#material-form');
  materialForm.querySelectorAll('[name="materialMode"]').forEach((input) => {
    const unsupported = nativeMode() && input.value !== 'text';
    input.disabled = unsupported;
    input.closest('label').style.display = unsupported ? 'none' : '';
  });
  const materialMode = materialForm.querySelector('[name="materialMode"][value="text"]');
  if (nativeMode()) materialMode.checked = true;
  $$('[data-material-panel]').forEach((panel) => { panel.hidden = panel.dataset.materialPanel !== 'text'; });
  const classification = $('#suggestion-form [name="classification"]');
  classification.disabled = nativeMode();
  classification.closest('label').style.display = nativeMode() ? 'none' : '';
  $('#suggestion-dialog h2').textContent = nativeMode() ? '补充工作要求' : '加入一条建议';
  $('#suggestion-form [name="text"]').placeholder = nativeMode() ? '写下支持当前目标的工作交代或修改要求' : '这条想法是支持当前目标，还是可能替代目标？';
  const taskForm = $('#task-form');
  taskForm.querySelector('.two-fields').style.display = nativeMode() ? 'none' : '';
  if (nativeMode()) taskForm.querySelector('.checkbox-line').style.setProperty('display', 'none', 'important');
  else taskForm.querySelector('.checkbox-line').style.removeProperty('display');
  taskForm.querySelector('.form-disclosure').textContent = nativeMode()
    ? '这里只建立目标记录，不会立即启动模型、修改文件、确认成果或发布。'
    : '选择 Codex 后，运行时会把当前任务目标和你加入的材料发送给 Codex 服务；演示提供者不调用模型。';
  $('#task-dialog h2').textContent = nativeMode() ? '建立原生任务' : '建立新任务';
}

function checkLabel(check) {
  if (typeof check === 'string') return check;
  return check?.id || check?.name || JSON.stringify(check);
}

function capabilityLines(capabilities) {
  if (!capabilities) return [];
  const yesNo = (value) => value === true ? '支持' : value === false ? '不支持' : '未提供';
  return [
    `team：${yesNo(capabilities.team)}`,
    `worktree：${yesNo(capabilities.worktree)}`,
    `静态预览：${capabilities.staticPreviewEntries.length ? capabilities.staticPreviewEntries.join('、') : '无登记入口'}`,
    `自动合并：${yesNo(capabilities.autoMerge)}`,
    `手动合并：${yesNo(capabilities.manualMerge)}`,
    `命令预览：${yesNo(capabilities.commandPreview)}`,
  ];
}

function nativePatchHref(product = state.nativeProduct) {
  const artifact = product?.artifact;
  const approvalId = artifact?.confirmation?.approvalId;
  if (!product?.links.patch || !artifact?.id || !approvalId) return null;
  const separator = product.links.patch.includes('?') ? '&' : '?';
  return `${product.links.patch}${separator}artifactId=${encodeURIComponent(artifact.id)}&approvalId=${encodeURIComponent(approvalId)}`;
}

function nativeZipHref(product = state.nativeProduct) {
  const artifact = product?.artifact;
  const approvalId = artifact?.confirmation?.approvalId;
  if (!product?.links.zip || !artifact?.id || !approvalId) return null;
  const separator = product.links.zip.includes('?') ? '&' : '?';
  return `${product.links.zip}${separator}artifactId=${encodeURIComponent(artifact.id)}&approvalId=${encodeURIComponent(approvalId)}`;
}

function nativeActionBound(product = state.nativeProduct) {
  return Boolean(product?.current && product.links.actions && product.execution?.id && product.product?.registrySha256);
}

function nativeSetupBound(product = state.nativeProduct) {
  return Boolean(product?.authorityCurrent && product.links.actions && product.goalVersionId);
}

function canRestoreCurrentResult(product = state.nativeProduct) {
  const recovery = product?.currentResultRecovery;
  const scope = product?.setup?.selectedScope;
  return Boolean(product?.setupPending && product.canPrepareRun && product.taskLifecycle?.inFlight === false
    && scope?.current && recovery?.taskId === product.taskId && recovery.goalVersionId === product.goalVersionId
    && recovery.projectId === scope.projectId && recovery.scopeFingerprint === scope.scopeFingerprint
    && recovery.reuseInput?.expectedExecutionId === product.execution?.id
    && recovery.reuseInput?.expectedRegistrySha256 === product.registry?.registrySha256
    && recovery.reuseInput?.mode === 'reuse_current_result' && nativeSetupBound(product));
}

function nativeChatContext(product = state.nativeProduct) {
  if (!product || !state.task || !state.coworker?.role) return { member: null, canSend: false };
  const functionId = officeFunctionForCoworker(state.coworker);
  const functionChat = nativeFunctionChatContext(product, functionId, nativeActionBound(product));
  if (functionChat) return functionChat;
  const presence = nativeCoworkerPresence(product, state.task, state.coworker.role);
  const member = presence.member || null;
  return {
    member,
    canSend: Boolean(member?.id && product.native?.aiEnabled === true && product.native?.actions.canChat && nativeActionBound(product)),
  };
}

function learningCoworkerActions() {
  if (state.backendMode === 'legacy' || officeFunctionForCoworker(state.coworker) !== 'learning') return '';
  return '<div class="conversation-line is-system"><b>仓鼠学习同事</b><p>我是学习同事，可直接带你继续原来的文章学习。已有记录会在学习页恢复，进入后可在“报告”步骤查看历史。</p></div><button class="primary-button" type="button" data-coworker-action="learning-open" data-learning-entry>开始 / 继续学习</button>';
}

function commissionCoworkerActions() {
  const functionId = officeFunctionForCoworker(state.coworker);
  const definition = COMMISSION_FUNCTIONS[functionId];
  if (!definition) return '';
  if (!nativeMode()) return `<p class="field-note">${definition.title}需求必须通过 OpenOffice 原生任务入口保存；当前模式不会伪装成已登记任务。</p>`;
  const canCreate = canCreateNativeTask(state.nativeProduct, state.backendMode);
  return `<button class="primary-button" type="button" data-coworker-action="new-task" data-function-id="${functionId}" ${canCreate ? '' : 'disabled'}>${definition.action}</button>${canCreate ? '' : '<p class="field-note">当前原生执行尚未结束或创建入口未开放；不会替换当前任务。</p>'}`;
}

function taskFunctionCopy(functionId) { return COMMISSION_FUNCTIONS[functionId] || null; }

function utilityTaskDraft() {
  try {
    const value = JSON.parse(localStorage.getItem(UTILITY_TASK_DRAFT_KEY) || 'null');
    return value && typeof value === 'object' && value.schemaVersion === 1 ? value : {};
  } catch { return {}; }
}

function saveUtilityTaskDraft() {
  const form = $('#task-form');
  if (form.elements.functionId.value !== 'utility') return true;
  const value = Object.fromEntries(new FormData(form));
  value.schemaVersion = 1;
  try { localStorage.setItem(UTILITY_TASK_DRAFT_KEY, JSON.stringify(value)); return true; }
  catch { return false; }
}

function fillUtilityProjectList(selectedId = '') {
  const select = $('#task-form').elements.existingProjectId;
  const projects = state.nativeProduct?.setup?.projects || [];
  select.replaceChildren(new Option('选择已登记工程…', ''));
  for (const project of projects.filter((item) => item.current)) {
    const suffix = project.location ? ` · ${project.location}` : '';
    const option = new Option(`${project.label}${suffix}`, project.projectId);
    option.dataset.scopeFingerprint = project.scopeFingerprint;
    select.add(option);
  }
  select.value = selectedId;
  const hasProjects = select.options.length > 1;
  const existingRadio = $('#task-form [name="projectMode"][value="existing"]');
  existingRadio.disabled = !hasProjects;
  if (!hasProjects) $('#task-form [name="projectMode"][value="new"]').checked = true;
}

function updateUtilityProjectMode() {
  const form = $('#task-form');
  const isNew = form.elements.projectMode.value === 'new';
  $('#utility-existing-project-row').hidden = isNew;
  $('#utility-new-project-row').hidden = !isNew;
  form.elements.existingProjectId.disabled = isNew;
  form.elements.projectName.disabled = !isNew;
  form.elements.projectName.required = isNew;
  $('#utility-project-state').textContent = isNew
    ? '新建只登记通用空白工程。保存任务后仍需单独核对并授权写入范围。'
    : '工程选择仅确定任务归属；创建后仍需单独核对并授权写入范围。';
}

function restoreUtilityTaskDraft() {
  const form = $('#task-form');
  const draft = utilityTaskDraft();
  for (const name of ['title', 'goal', 'successCriteria', 'boundaries', 'projectName', 'projectRequestId', 'taskCreationRequestId']) {
    if (typeof draft[name] === 'string') form.elements[name].value = draft[name];
  }
  fillUtilityProjectList(typeof draft.existingProjectId === 'string' ? draft.existingProjectId : '');
  if (draft.projectMode === 'new' || !form.elements.existingProjectId.value) {
    form.querySelector('[name="projectMode"][value="new"]').checked = true;
  }
  updateUtilityProjectMode();
}

function setTaskFunction(functionId = '') {
  const definition = taskFunctionCopy(functionId);
  const form = $('#task-form');
  const note = $('#task-function-note');
  form.elements.functionId.value = definition ? functionId : '';
  note.hidden = !definition;
  note.textContent = definition
    ? `此任务将归属“${definition.title}”职能，但仍由 OpenOffice 当前登记的执行团队处理。请手动选择匹配的已登记项目；没有匹配项目时先登记，不会自动使用文章学习项目或任意本地路径。`
    : '';
  form.elements.title.placeholder = definition?.titlePlaceholder || '例如：整理本周项目进展';
  form.elements.goal.placeholder = definition?.goalPlaceholder || '完成后，什么结果才算真正解决了这件事？';
  const picker = $('#utility-project-picker');
  const showUtility = nativeMode() && functionId === 'utility';
  picker.hidden = !showUtility;
  picker.disabled = !showUtility;
  if (showUtility) {
    note.hidden = true;
    restoreUtilityTaskDraft();
  }
}

async function openLearningProduct() {
  if (state.learningEntryPending) return;
  state.learningEntryPending = true;
  const trigger = $('#coworker-actions [data-learning-entry]');
  if (trigger) { trigger.disabled = true; trigger.textContent = '正在接回原学习成果…'; }
  const popup = window.open('about:blank', '_blank');
  try {
    let result = await api('/api/product/learning-entry/open', {
      method: 'POST', body: JSON.stringify({ view: 'learn' }),
    });
    if (!result.url && result.status === 'preview_pending') {
      const learningTaskId = result.taskId;
      const deadline = Date.now() + 12_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        result = await api(`/api/product/learning-entry?taskId=${encodeURIComponent(learningTaskId || '')}`);
        if (result.status === 'ready' && result.url) break;
      }
    }
    if (!result.url) throw new Error('原学习成果已保留，但预览尚未就绪。请稍后再试；没有启动新的学习批次。');
    if (popup && !popup.closed) popup.location.replace(result.url);
    else {
      const link = document.createElement('a');
      link.className = 'export-link'; link.href = result.url; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = '打开文章学习';
      $('#coworker-actions').append(link);
    }
    announce('已接回原文章学习成果；学习页会恢复已有记录。');
  } catch (error) {
    if (popup && !popup.closed) popup.close();
    const recoveryUrl = error.body?.reason?.recoveryUrl;
    const message = error.body?.reason?.message || error.message;
    $('#coworker-actions').insertAdjacentHTML('beforeend', `<p class="field-note">${esc(message)}${recoveryUrl ? ` <a href="${esc(recoveryUrl)}" target="_blank" rel="noopener">返回当前工作</a>` : ''}</p>`);
    announce(message, 'error');
  } finally {
    state.learningEntryPending = false;
    if (trigger?.isConnected) { trigger.disabled = false; trigger.textContent = '开始 / 继续学习'; }
  }
}

async function postNativeAction(action, input = {}) {
  const product = state.nativeProduct;
  if (!product?.links.actions) throw new Error('当前原生任务动作接口不可用。');
  const result = await api(product.links.actions, { method: 'POST', body: JSON.stringify(nativeActionPayload(product, action, input)) });
  await refreshNativeProduct({ silent: false });
  return result;
}

function nativeCandidateMatches(product = state.nativeProduct, candidate = state.nativeCandidate) {
  const artifact = product?.artifact;
  return Boolean(candidate && artifact && candidate.taskId === product.taskId && candidate.goalVersionId === product.goalVersionId
    && candidate.artifactId === artifact.id && candidate.artifactVersion === artifact.version
    && candidate.candidateSha256 === artifact.candidateSha256);
}

async function loadNativeCandidate() {
  const product = state.nativeProduct;
  if (!product?.current || !product.artifact || !product.native?.actions.canInspectDiff || !product.links.candidate) {
    throw new Error('后台没有开放当前候选的真实差异查看入口。');
  }
  state.nativeCandidateLoading = true;
  state.nativeCandidateError = null;
  renderReview();
  try {
    const raw = await api(product.links.candidate);
    state.nativeCandidate = normalizeNativeCandidate(raw, product);
  } catch (error) {
    state.nativeCandidate = null;
    state.nativeCandidateError = error.message;
    throw error;
  } finally {
    state.nativeCandidateLoading = false;
    renderReview();
  }
}

async function requestNativeRun() {
  const product = state.nativeProduct;
  const runAgentId = product?.native?.runAgentId;
  const lead = product?.native?.agents?.find((agent) => agent.id === runAgentId);
  if (!product?.native?.actions.canRun || !nativeActionBound(product) || !runAgentId || !lead?.isTeamLead) {
    throw new Error('后台没有提供当前可用的原生 Lead 与运行资格。');
  }
  if (!window.confirm(`由 OpenOffice 原生 Lead「${lead.name || lead.role || runAgentId}」按当前目标开始执行吗？\n\n这会启动真实模型工作；后台仍会再次核对目标、执行、产品登记与预算。`)) return false;
  await postNativeAction('run');
  announce('已把当前任务交给 OpenOffice 原生 Lead；办公室会按真实执行状态更新。');
  return true;
}

async function requestNativePrepareRun() {
  const product = state.nativeProduct;
  if (product?.memory?.stalePreparedPrompt && product.canPrepareRun && product.product?.workspaceScopeFingerprint
      && nativeSetupBound(product)) {
    await postNativeAction('prepare_run', { expectedScopeFingerprint: product.product.workspaceScopeFingerprint });
    announce('长期记忆已按当前 TaskStore 重新核对，并更新到同一未启动执行；没有启动模型工作。');
    return true;
  }
  const scope = product?.setup?.selectedScope;
  const reconnecting = product?.setupStatus === 'runtime_unavailable';
  if (!['ready_to_run', 'runtime_unavailable'].includes(product?.setupStatus) || !product.canPrepareRun || !scope?.current || !scope.scopeFingerprint || !nativeSetupBound(product)) {
    throw new Error('当前项目范围还不能准备原生后台。');
  }
  await postNativeAction('prepare_run', { expectedScopeFingerprint: scope.scopeFingerprint });
  announce(reconnecting ? '已按同一执行账恢复原生后台；没有启动模型工作。' : '原生后台已按当前目标与授权范围准备完成；这一步没有启动模型执行。');
  return true;
}

async function requestNativeRestoreCurrentResult() {
  const product = state.nativeProduct;
  const recovery = product?.currentResultRecovery;
  if (!canRestoreCurrentResult(product)) throw new Error('当前没有可安全复用的已确认成果绑定。');
  if (!window.confirm(`恢复“${recovery.title || product.title}”的已确认版本 v${recovery.artifactVersion} 吗？\n\n将沿用同一任务、目标、项目范围、执行和候选绑定；不会重新开发或调用模型。`)) return false;
  await postNativeAction('prepare_run', { mode: 'reuse_current_result' });
  announce(`已恢复已确认版本 v${recovery.artifactVersion}；没有启动模型工作。`);
  return true;
}

async function requestNativeCancel() {
  throw new Error('后台尚未提供可核对的取消目标，办公室不会从工作项 ID 猜测原生任务。');
}

async function requestNativeContinue() {
  if (!state.nativeProduct?.native?.actions.canContinue || !state.nativeProduct?.current) throw new Error('后台没有确认当前任务可以继续。');
  if (!window.confirm('按当前目标继续这项原生任务吗？\n\n后台仍会核对目标版本、产品绑定和预算。')) return false;
  await postNativeAction('continue');
  announce('继续请求已写入当前任务；可执行步骤会按真实状态出现。');
  return true;
}

async function readNativeProduct(taskId = null) {
  const url = taskId ? `/api/product-state?taskId=${encodeURIComponent(taskId)}` : '/api/product-state';
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 404) return null;
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(body?.error?.message || body?.error || (typeof body === 'string' && body) || `OpenOffice 状态读取失败 (${response.status})`);
  return normalizeNativeProductState(body);
}

async function loadNativeTaskHistory({ silent = true } = {}) {
  const history = state.nativeTaskHistory;
  history.loading = true;
  history.error = null;
  renderTaskList();
  try {
    const value = await api('/api/product/tasks');
    if (!Array.isArray(value.tasks) || !Number.isSafeInteger(value.activeTaskRevision)) throw new Error('任务目录返回的数据不完整。');
    history.tasks = value.tasks;
    history.activeTaskId = value.activeTaskId || null;
    history.activeTaskRevision = value.activeTaskRevision;
  } catch (error) {
    history.error = error.message;
    if (!silent) announce(`历史任务读取失败：${error.message}`, 'error');
  } finally {
    history.loading = false;
    state.nativeTaskHistoryLoadedAt = Date.now();
    renderTaskList();
  }
}

async function selectNativeTask(taskId) {
  const history = state.nativeTaskHistory;
  const task = history.tasks.find((item) => item.id === taskId);
  if (history.selecting || !task || task.inFlight && taskId !== history.activeTaskId) return;
  if (taskId === history.activeTaskId) return;
  history.selecting = true;
  const refreshGeneration = ++state.nativeRefreshGeneration;
  renderTaskList();
  try {
    await api(`/api/product/tasks/${encodeURIComponent(taskId)}/select`, {
      method: 'POST', body: JSON.stringify({
        expectedActiveTaskId: history.activeTaskId,
        expectedActiveTaskRevision: history.activeTaskRevision,
      }),
    });
    await loadNativeTaskHistory();
    const product = await readNativeProduct(taskId);
    if (refreshGeneration !== state.nativeRefreshGeneration) return;
    applyNativeProduct(product);
    state.selectedArtifactId = product.artifact?.id || null;
    renderAll();
    syncLocation();
    announce(`已打开“${task.title}”的历史任务状态；没有启动模型工作。`);
  } catch (error) {
    await loadNativeTaskHistory();
    announce(error.body?.error?.code === 'TASK_SWITCH_BUSY'
      ? '当前或目标任务仍有预留/运行中的工作，暂时不能切换。'
      : error.body?.error?.code === 'TASK_SELECTION_STALE'
        ? '任务列表已被另一处更新，已刷新；请再确认一次要打开的任务。'
        : `无法打开该任务：${error.message}`, 'error');
  } finally {
    history.selecting = false;
    renderTaskList();
  }
}

function applyNativeProduct(product) {
  const previous = state.nativeProduct;
  const bindingChanged = previous && JSON.stringify([
    previous.taskId, previous.goalVersionId, previous.execution?.id, previous.product?.projectId,
    previous.product?.registrySha256, previous.product?.workspaceScopeFingerprint,
    previous.artifact?.id, previous.artifact?.version, previous.artifact?.candidateSha256,
  ]) !== JSON.stringify([
    product.taskId, product.goalVersionId, product.execution?.id, product.product?.projectId,
    product.product?.registrySha256, product.product?.workspaceScopeFingerprint,
    product.artifact?.id, product.artifact?.version, product.artifact?.candidateSha256,
  ]);
  if (bindingChanged || (state.gameWorkshopTaskId !== null && state.gameWorkshopTaskId !== product.taskId)) {
    state.gameWorkspaceRequestSeq += 1;
    if (state.gameWorkshopTaskId !== null && state.gameWorkshopTaskId !== product.taskId) state.gameWorkshopTaskId = null;
    state.gameWorkspaceLoading = false;
    state.gameWorkspaceError = null;
    state.gameWorkspaceData = null;
    state.gameWorkspaceFile = null;
    state.gameWorkspaceFilePath = null;
    state.gameWorkspaceFileView = 'source';
  }
  const previousCandidate = state.nativeCandidate;
  const pendingReview = state.nativeReviewPending;
  const nextReviewBinding = nativeReviewBinding(product);
  const nextReview = product.artifact?.review;
  if (pendingReview && (pendingReview.binding !== nextReviewBinding
    || JSON.stringify([nextReview?.id || null, nextReview?.passed ?? null, nextReview?.nativeVerdict || null, nextReview?.scopeOutcome || null]) !== pendingReview.previousReview
    || (product.native?.preparationFailures || []).some((item) => item.candidateSha256 === product.artifact?.candidateSha256
      && !pendingReview.knownPreparationAttemptIds?.includes(item.attemptId)))) {
    state.nativeReviewPending = null;
  }
  if (state.nativeReviewRoundPending && state.nativeReviewRoundPending.binding !== nextReviewBinding) state.nativeReviewRoundPending = null;
  state.backendMode = 'openoffice';
  state.nativeProduct = product;
  state.nativeError = null;
  state.task = product.setupOnly ? null : nativeProductAsOfficeTask(product);
  state.tasks = state.task ? [state.task] : [];
  state.selectedArtifactId = product.artifact?.id || null;
  if (!nativeCandidateMatches(product, previousCandidate)) {
    state.nativeCandidate = null;
    state.nativeCandidateError = null;
  }
  setBackendUi();
}

function renderNativeBlocked() {
  const message = state.nativeError || 'OpenOffice 状态当前无法核对。';
  $('#task-list').innerHTML = `<p class="empty-ledger">${esc(message)}</p>`;
  $('#global-status').textContent = 'OpenOffice 状态不可核对';
  $('#global-status-dot').dataset.tone = 'attention';
  $('#room-state-kicker').textContent = 'NATIVE STATE UNAVAILABLE';
  $('#room-state-title').textContent = '办公室没有冒充旧任务继续工作';
  $('#room-state-detail').textContent = message;
  $('#goal-version').textContent = '—';
  $('#active-goal').textContent = '等待原生状态恢复后再显示。';
  $('#success-criteria').textContent = '—';
  $('#goal-boundaries').textContent = '不会静默回退到旧任务接口。';
  $('#next-action').textContent = '恢复 OpenOffice 统一入口后刷新。';
  $('#role-strip').innerHTML = Object.entries(ROLE_LABEL).map(([role, label]) => role === 'coordinator' ? `<div class="role-cell" data-state="idle"><b>${esc(label)}</b><span>状态未知</span></div>` : `<button class="role-cell" type="button" data-talk-role="${esc(role)}" data-state="idle"><b>${esc(label)}</b><span>状态未知</span></button>`).join('');
  $('#office-actions').innerHTML = '<button class="secondary-button wide-button" type="button" data-action="retry-native">重新读取原生状态</button>';
  $('#desk-subtitle').textContent = 'OpenOffice 原生状态未通过校验。';
  renderNativeMarkup($('#desk-content'), `<div class="empty-desk"><span class="eyebrow">SOURCE CHECK FAILED</span><h2>没有显示未经核对的旧数据</h2><p>${esc(message)}</p><button class="secondary-button" type="button" data-action="retry-native">重新读取</button></div>`, null);
  renderNativeMarkup($('#review-content'), '<div class="empty-desk"><span class="eyebrow">NO VERIFIED PROOF</span><h2>当前没有可核对的原生候选</h2><p>状态恢复前不会提供确认或下载入口。</p></div>', null);
  syncSceneFrame();
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
  if (nativeMode() && state.nativeProduct) {
    const native = state.nativeProduct;
    if (native.setupOnly) return { kicker: 'READY FOR A REAL GOAL', title: '办公室正在等候第一项原生任务', detail: native.nextStep, tone: 'normal' };
    if (native.setupPending) return { kicker: 'SETTING UP THE NATIVE TASK', title: native.statusLabel, detail: native.nextStep, tone: 'normal' };
    if (!native.current) return { kicker: 'NATIVE BINDING STALE', title: '原生任务或产品绑定已经失效', detail: native.nextStep, tone: 'attention' };
    const waitingPresentation = nativeOfficeWaitingPresentation(native, task);
    if (waitingPresentation) return waitingPresentation.office;
    if (!native.artifact && native.execution?.phase === 'planned') return native.native?.actions.canRun && native.native?.runAgentId
      ? { kicker: 'NATIVE LEAD READY', title: '原生后台已经准备好，等待你开始执行', detail: native.nextStep, tone: 'normal' }
      : { kicker: 'NATIVE RUNTIME READY', title: '原生后台已经准备好，当前不开放模型执行', detail: native.native?.aiEnabled === false ? '当前是零模型开发模式；没有发起模型调用。' : '后台尚未明确开放当前任务的模型启动资格。', tone: 'normal' };
    if (task.status === 'running') return { kicker: 'OPENOFFICE EXECUTION', title: 'OpenOffice 原生团队正在执行', detail: native.statusLabel || native.nextStep, tone: 'working' };
    if (task.status === 'waiting_user') {
      return { kicker: 'AWAITING THE PRINCIPAL', title: '原生任务等待你的决定', detail: native.nextStep, tone: 'normal' };
    }
    if (task.status === 'ready_to_export') return { kicker: 'NATIVE VERSION CONFIRMED', title: '指定版本已经确认', detail: native.nextStep, tone: 'normal' };
    if (task.status === 'failed') return { kicker: 'NATIVE EXECUTION STOPPED', title: 'OpenOffice 原生执行失败', detail: native.nextStep, tone: 'attention' };
    if (task.status === 'partial') return { kicker: 'NATIVE WORK PAUSED', title: '原生任务当前不能继续', detail: native.nextStep, tone: 'attention' };
    return { kicker: 'OPENOFFICE NATIVE STATE', title: native.statusLabel || `原生任务状态：${native.status}`, detail: native.nextStep, tone: 'normal' };
  }
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
  if (nativeMode() && task.nativeProduct) {
    if (role === 'coordinator') return { state: 'done', label: '守住目标' };
    const functionOwner = { writer: 'utility', reviewer: 'game', steward: 'agent' }[role];
    if (functionOwner && state.nativeProduct.functionId === functionOwner) {
      const status = state.nativeProduct.officeStatus;
      if (status === 'running') return { state: 'active', label: '推进当前任务' };
      if (['failed', 'partial', 'cancelled'].includes(status)) return { state: status === 'failed' ? 'failed' : 'idle', label: state.nativeProduct.statusLabel || '任务已暂停' };
      if (['waiting_user', 'ready_to_export'].includes(status)) return { state: 'done', label: state.nativeProduct.statusLabel || '等待后续处理' };
      return { state: 'idle', label: state.nativeProduct.statusLabel || '当前未执行' };
    }
    if (role === 'researcher') return { state: 'idle', label: '开始 / 继续学习' };
    return { state: 'idle', label: '本次未登记为负责人' };
  }
  if (role === 'coordinator') {
    if (planningBusy(task)) return { state: 'active', label: '规划中' };
    if (task.activeRole === 'coordinator' && task.status === 'running') return { state: 'active', label: '协调中' };
    if (task.status === 'failed') return { state: 'failed', label: '已停下' };
    return { state: 'done', label: '守住目标' };
  }
  if (nativeMode() && task.status === 'running' && task.activeRole === role) return { state: 'active', label: '进行中' };
  const dynamicAgent = task.team?.agents?.find((agent) => agent.stationRole === role && task.workItems.some((work) => work.agentId === agent.id && work.status === 'running'))
    || task.team?.agents?.find((agent) => agent.stationRole === role);
  const matchingWork = task.workItems.filter((work) => dynamicAgent ? work.agentId === dynamicAgent.id : work.role === role);
  const item = matchingWork.find((work) => work.status === 'running') || matchingWork.at(-1);
  if (!item) return nativeMode() && dynamicAgent ? { state: 'idle', label: '待命' } : { state: 'idle', label: '本次不需要' };
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
  const historyPanel = $('#native-task-filters');
  const nativeHistory = nativeMode() ? state.nativeTaskHistory : null;
  if (historyPanel) historyPanel.hidden = !nativeHistory;
  if (nativeHistory) {
    const projectSelect = $('#native-task-project');
    if (projectSelect) {
      const projects = [...new Map(nativeHistory.tasks.filter((task) => task.projectId)
        .map((task) => [task.projectId, task.projectLabel || task.projectId])).entries()];
      const options = ['<option value="">全部项目</option>', ...projects.map(([id, label]) => `<option value="${esc(id)}">${esc(label)}</option>`)];
      const markup = options.join('');
      if (projectSelect.innerHTML !== markup) projectSelect.innerHTML = markup;
      projectSelect.value = state.nativeTaskFilter.projectId;
    }
    const search = $('#native-task-search');
    if (search && search.value !== state.nativeTaskFilter.query) search.value = state.nativeTaskFilter.query;
    const filtered = filterNativeTaskHistory(nativeHistory.tasks, state.nativeTaskFilter.query, state.nativeTaskFilter.projectId);
    const status = $('#native-task-history-status');
    if (status) status.textContent = nativeHistory.loading ? '正在读取历史任务…'
      : nativeHistory.error || `${filtered.length} 项 · 只读历史，不会启动工作`;
    if (!filtered.length) {
      renderTaskListMarkup(root, `<p class="empty-ledger">${nativeHistory.loading ? '正在读取历史任务…' : nativeHistory.error ? '历史任务暂不可用。' : state.nativeTaskFilter.query || state.nativeTaskFilter.projectId ? '没有符合条件的任务。' : '还没有已登记的任务。'}</p>`);
      return;
    }
    renderTaskListMarkup(root, filtered.map((task) => {
      const active = task.id === nativeHistory.activeTaskId;
      const disabled = nativeHistory.selecting || task.inFlight && !active;
      const functionLabel = { learning: '学习', utility: '小工具', game: '小游戏', agent: 'Agent' }[task.functionId];
      return `<button class="task-row ${active ? 'is-active' : ''}" type="button" data-native-task-id="${esc(task.id)}" ${disabled ? 'disabled aria-disabled="true"' : ''} aria-current="${active ? 'page' : 'false'}">
        <strong>${esc(task.title)}</strong><span><em>${esc(TASK_STATUS[task.status] || task.status)}${disabled ? ' · 执行中，暂不可切换' : ''}</em><time>${esc(dateLabel(task.updatedAt))}</time></span>
        <small>${esc(task.projectLabel || functionLabel || '原生任务')}${active ? ' · 当前查看' : ''}</small>
      </button>`;
    }).join(''));
    return;
  }
  if (!state.tasks.length) {
    renderTaskListMarkup(root, '<p class="empty-ledger">账本还是空的。先写下一个明确目标，Irixi 才知道应该守住什么。</p>');
    return;
  }
  renderTaskListMarkup(root, state.tasks.map((task) => `
    <button class="task-row ${task.id === state.task?.id ? 'is-active' : ''}" type="button" data-task-id="${esc(task.id)}">
      <strong>${esc(task.title)}</strong><span><em>${esc(TASK_STATUS[task.status] || task.status)}</em><time>${esc(dateLabel(task.updatedAt))}</time></span>
    </button>`).join(''));
}

function renderOffice() {
  const task = state.task;
  const goal = activeGoal(task);
  const display = officeState(task);
  $('#room-state-kicker').textContent = display.kicker;
  $('#room-state-title').textContent = display.title;
  $('#room-state-detail').textContent = display.detail;
  $('.office-state-plaque').dataset.tone = display.tone;
  const nativeWaiting = nativeOfficeWaitingPresentation(state.nativeProduct, task);
  $('#global-status').textContent = task ? `${task.title} · ${nativeWaiting?.statusLabel || TASK_STATUS[task.status] || task.status}` : '本地待命';
  $('#global-status-dot').dataset.tone = display.tone;
  $('#goal-version').textContent = nativeMode() ? state.nativeProduct.goalVersionId || '尚未建立' : goal ? `v${goal.version}` : '—';
  $('#active-goal').textContent = goal?.statement || '尚未选择任务。';
  $('#success-criteria').textContent = lines(goal?.successCriteria, '尚未填写。');
  $('#goal-boundaries').textContent = lines(goal?.boundaries, '默认不发送、不发布、不覆盖来源。');
  if (nativeMode()) {
    $('#success-criteria').textContent = state.nativeProduct.setupOnly ? '尚未建立任务。填写时可留空，不会由前端补写。' : '原生产品状态尚未提供已接受的成功条件。';
    $('#goal-boundaries').textContent = state.nativeProduct.setupOnly ? '尚未建立任务。填写时可留空，不会由前端补写。' : '原生产品状态尚未提供已接受的目标边界；此处不自行补写。';
    if (state.nativeProduct.setupPending) {
      $('#success-criteria').textContent = lines(state.nativeProduct.successCriteria, '用户尚未填写成功条件。');
      $('#goal-boundaries').textContent = lines(state.nativeProduct.boundaries, '用户尚未填写工作边界。');
    }
  }
  $('#next-action').textContent = nativeMode() ? state.nativeProduct.nextStep : nextAction(task);

  const roles = ['coordinator', 'archivist', 'researcher', 'writer', 'reviewer', 'steward'];
  $('#role-strip').innerHTML = roles.map((role) => {
    const value = roleState(role, task);
    const content = `<b>${esc(ROLE_LABEL[role])}</b><span>${esc(value.label)}</span>`;
    return role === 'coordinator' ? `<div class="role-cell" data-state="${value.state}">${content}</div>` : `<button class="role-cell" type="button" data-talk-role="${esc(role)}" data-state="${value.state}" aria-label="与${esc(ROLE_LABEL[role])}交谈，当前${esc(value.label)}">${content}</button>`;
  }).join('');

  const actions = $('#office-actions');
  if (nativeMode()) {
    if (state.nativeProduct.setupOnly) {
      actions.innerHTML = '<button class="primary-button wide-button" type="button" data-open-dialog="task-dialog">建立第一项原生任务</button><button class="secondary-button wide-button" type="button" data-view-target="desk">查看设置状态</button>';
      syncSceneFrame();
      return;
    }
    if (state.nativeProduct.setupPending) {
      const canPrepare = state.nativeProduct.setupStatus === 'ready_to_run' && state.nativeProduct.canPrepareRun
        && state.nativeProduct.setup?.selectedScope?.current && nativeSetupBound();
      const restore = canRestoreCurrentResult() ? '<button class="primary-button wide-button" type="button" data-action="native-restore-confirmed">恢复已确认成果（不重新开发）</button>' : '';
      const prepareLabel = state.nativeProduct.currentResultRecovery ? '准备新一轮' : '准备原生后台';
      actions.innerHTML = `${restore}${canPrepare ? `<button class="${restore ? 'secondary' : 'primary'}-button wide-button" type="button" data-action="native-prepare-run">${prepareLabel}</button>` : ''}<button class="secondary-button wide-button" type="button" data-view-target="desk">查看设置状态与边界</button>`;
      syncSceneFrame();
      return;
    }
    const nativeTask = state.nativeProduct.links.nativeTask;
    const nativeActions = state.nativeProduct.native?.actions;
    const primary = nativeActions?.canRun && state.nativeProduct.native?.runAgentId && nativeActionBound()
          ? '<button class="primary-button wide-button" type="button" data-action="native-run">由原生 Lead 开始执行</button>'
          : nativeActions?.canContinue && nativeActionBound()
            ? '<button class="primary-button wide-button" type="button" data-action="native-resume">按当前目标继续</button>'
          : nativeTask ? `<a class="primary-button wide-button" href="${esc(nativeTask)}">打开 OpenOffice 原生任务</a>` : '<button class="secondary-button wide-button" type="button" disabled>原生任务链接未提供</button>';
    actions.innerHTML = `${primary}<button class="secondary-button wide-button" type="button" data-view-target="desk">查看真实状态与边界</button>${state.nativeProduct.artifact ? '<button class="secondary-button wide-button" type="button" data-view-target="review">查看候选与审阅</button>' : ''}`;
  } else if (!task) actions.innerHTML = '<button class="secondary-button wide-button" type="button" data-open-dialog="task-dialog">建立第一项工作</button>';
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
  if (nativeBlocked()) {
    root.innerHTML = `<div class="conversation-line is-system"><b>OpenOffice 状态不可核对</b><p>${esc(state.nativeError || '等待原生状态恢复。')}</p></div>`;
    actions.innerHTML = `<button class="secondary-button" type="button" data-action="retry-native">重新读取原生状态</button>${learningCoworkerActions()}`;
    $('#coworker-form').querySelector('[type="submit"]').disabled = true;
    $('#coworker-message').disabled = true;
    $('#coworker-intent').disabled = true;
    $('#cancel-conversation-button').hidden = true;
    return;
  }
  if (!task) {
    const functionId = officeFunctionForCoworker(state.coworker);
    const functionCopy = taskFunctionCopy(functionId);
    root.innerHTML = functionId === 'learning'
      ? '<div class="conversation-line is-system"><b>仓鼠学习同事</b><p>这里直接接入已交付的学习助手，不需要新建任务或开发学习软件。点击下方即可继续原学习并恢复已有记录。</p></div>'
      : functionCopy
        ? `<div class="conversation-line is-system"><b>${functionCopy.action}</b><p>这里会建立带有“${functionCopy.title}”职能标记的 OpenOffice 原生任务。请写下你的具体目标；不会替你填目标、选择项目范围或启动模型。</p></div>`
        : '<div class="conversation-line is-system"><b>办公室回执</b><p>目前没有选中的任务。档案与协调是共享能力，不会被误标成小工具、小游戏或 Agent 开发任务。</p></div>';
    actions.innerHTML = `${learningCoworkerActions()}${commissionCoworkerActions()}`;
    $('#coworker-form').querySelector('[type="submit"]').disabled = true;
    $('#coworker-message').disabled = true;
    $('#coworker-intent').disabled = true;
    return;
  }
  if (nativeMode()) {
    const product = state.nativeProduct;
    const role = state.coworker?.role;
    const functionId = officeFunctionForCoworker(state.coworker);
    const isLearningOwner = functionId === 'learning';
    const functionCopy = taskFunctionCopy(functionId);
    const taskFunction = taskFunctionCopy(product.functionId);
    const functionOwnsTask = Boolean(functionCopy && product.functionId === functionId);
    const presence = nativeCoworkerPresence(product, task, role);
    const chat = nativeChatContext(product);
    const displayMember = functionOwnsTask ? chat.member : presence.member;
    const memberName = displayMember?.name || product.actor || ROLE_LABEL[role] || role;
    const memberStatus = isLearningOwner ? '学习入口' : functionCopy
      ? functionOwnsTask ? (TASK_STATUS[task.status] || product.statusLabel || product.status) : '未关联当前任务'
      : displayMember?.status === 'idle' ? '待命' : displayMember?.status || '状态未提供';
    const statusText = isLearningOwner
      ? '我是学习同事，负责带你使用已交付的文章学习助手；已有学习记录会沿原产品恢复，不受本次原生团队有没有 researcher 成员影响。'
      : functionCopy
      ? `${functionCopy.title}需求入口。${taskFunction ? `当前任务归属“${taskFunction.title}”职能` : '当前任务没有可核实的职能归属，保持未分类'}；不会从 Developer、Reviewer 等执行阶段推断。整体状态：${product.statusLabel || product.status}${functionOwnsTask && product.goalStatement ? `。当前目标：${product.goalStatement}` : ''}`
      : presence.active
      ? `${memberName} 正在处理 ${presence.workItem?.title || product.execution?.phase || product.status}。`
      : presence.member
        ? `${memberName} 已由 OpenOffice 登记，当前${memberStatus}。任务状态为 ${product.statusLabel || product.status}。`
        : `这个工位未在本次已核对的原生团队中登记。任务状态为 ${product.statusLabel || product.status}。`;
    const canFunctionChat = functionOwnsTask && chat.canSend;
    const conversationStatus = {
      saved: '已保存', pending: '等待回复', running: '回复中', completed: '已完成', failed: '失败',
      cancelled: '已取消', saved_no_native_runtime: '只保存记录，未启动模型',
    };
    const history = (product.conversations || []).filter((item) => chat.member?.id && item.agentId === chat.member.id).slice(-8).map((item) => {
      const isUser = item.actor === 'user';
      const failed = item.status === 'failed';
      const by = isUser ? '你' : failed ? `${memberName} · 回复失败` : memberName;
      const text = item.text || (failed ? '本次原生讨论调用失败，未形成模型回复。' : '本条讨论没有返回正文。');
      return `<div class="conversation-line ${isUser ? 'is-user' : 'is-system'}"><b>${esc(by)}</b><p>${esc(text)}</p><small>${esc(conversationStatus[item.status] || item.status)}${item.at ? ` · ${esc(item.at)}` : ''}</small></div>`;
    }).join('');
    const boundary = isLearningOwner
      ? '学习入口直接复用已确认的文章学习成果，不会创建开发任务或启动新模型轮次；当前 OpenOffice 任务的同事讨论仍保持只读。'
      : functionCopy
        ? !functionOwnsTask
          ? `当前原生任务${taskFunction ? `归属“${taskFunction.title}”职能` : '未分类'}，不把它路由给${functionCopy.title}同事。可查看书桌中的实际执行团队；需要新需求时单独交代。`
          : canFunctionChat
            ? `当前任务属于${functionCopy.title}；只读讨论将发送给 OpenOffice 实际登记的 ${chat.member?.name || '执行成员'}，不会改成额外的小游戏/Agent执行器。新工作要求仍通过任务书桌提交。`
            : `当前任务属于${functionCopy.title}，但后台没有同时开放该任务的实际登记成员、模型能力和讨论资格；不会伪造或改路由。`
      : chat.canSend
      ? '这里发送的是当前任务、当前目标下的只读讨论，不会自动变成已接受交代、修改要求或成果退回。工作要求请到任务书桌补充；成果退回请到审阅台操作。'
      : product.native?.aiEnabled === false
        ? '当前为零模型开发模式：真实历史可读，但不会启动模型回复。工作要求请到任务书桌补充；成果退回请到审阅台操作。'
        : '后台尚未同时开放当前成员、模型能力和讨论资格，因此只显示真实历史，不会伪造回复。';
    root.innerHTML = `<div class="conversation-line is-system"><b>OpenOffice 真实状态</b><p>${esc(statusText)}</p></div>${history}<div class="conversation-line is-system"><b>当前接线边界</b><p>${esc(boundary)}</p></div>`;
    root.scrollTop = root.scrollHeight;
    const canRunHere = false;
    const canCancelHere = false;
    const supplementCurrent = functionOwnsTask && product.native?.actions?.canInstructions
      ? `<button class="secondary-button" type="button" data-open-dialog="suggestion-dialog">补充当前${functionCopy.title}要求</button>` : '';
    actions.innerHTML = `${learningCoworkerActions()}${functionCopy ? commissionCoworkerActions() : ''}${functionOwnsTask && functionId === 'game' ? '<button class="primary-button" type="button" data-coworker-action="game-workbench">打开 iRIXI 游戏工坊</button>' : ''}${supplementCurrent}${canRunHere ? '<button class="primary-button" type="button" data-coworker-action="native-run">启动当前原生执行</button>' : ''}${canCancelHere ? '<button class="danger-button" type="button" data-coworker-action="native-cancel">取消当前原生执行</button>' : ''}${product.links.nativeTask ? `<a class="secondary-button" href="${esc(product.links.nativeTask)}">打开原生任务</a>` : ''}${product.artifact ? '<button class="secondary-button" type="button" data-coworker-action="review">查看当前候选</button>' : ''}`;
    const form = $('#coworker-form');
    const intent = $('#coworker-intent');
    intent.value = 'progress';
    intent.querySelectorAll('option').forEach((option) => { option.disabled = option.value !== 'progress'; });
    const chatEnabled = functionCopy ? canFunctionChat : chat.canSend;
    form.querySelector('[type="submit"]').disabled = !chatEnabled;
    $('#coworker-message').disabled = !chatEnabled;
    intent.disabled = !chatEnabled;
    $('#coworker-message').placeholder = chatEnabled ? '询问当前任务进度，或补充此任务要求' : functionCopy ? `${functionCopy.action}按钮会打开原生任务表单` : '当前只显示真实讨论历史';
    $('#coworker-status').textContent = isLearningOwner
      ? '学习入口：开始 / 继续学习。进入后沿原产品恢复已有记录。'
      : chatEnabled
        ? `当前状态：${memberStatus}。对话已打开；靠近情况以办公室画面为准，可就当前任务进行只读讨论。`
        : `当前状态：${memberStatus}。对话已打开；靠近情况以办公室画面为准，本轮不会启动模型讨论。`;
    $('#cancel-conversation-button').hidden = true;
    return;
  }
  const officeFunction = officeFunctionForCoworker(state.coworker);
  const functionCopy = taskFunctionCopy(officeFunction);
  if (functionCopy) {
    root.innerHTML = `<div class="conversation-line is-system"><b>${functionCopy.title}需求入口暂不可用</b><p>当前不是 OpenOffice 原生任务视图，无法核验或保存此任务的职能归属。旧任务保持未分类，不会把它路由给${functionCopy.title}开发同事。</p></div>`;
    actions.innerHTML = '<a class="primary-button" href="/?backend=openoffice&view=office">打开 OpenOffice 功能入口</a>';
    $('#coworker-form').querySelector('[type="submit"]').disabled = true;
    $('#coworker-message').disabled = true;
    $('#coworker-intent').disabled = true;
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
  actions.innerHTML = `${learningCoworkerActions()}${buttons.join('')}`;
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
    learningAvailable: Boolean(state.nativeProduct?.artifact?.confirmation && state.nativeProduct?.links?.preview),
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

function renderNativeMemoryPanel(native) {
  if (!native?.taskId) return '<p class="field-note">建立一项原生任务后，可在这里明确保存全局偏好或当前项目约定。</p>';
  const memory = native.memory || { entries: [], projectScopeCurrent: false, indexAvailable: false };
  const binding = `${native.taskId}:${native.goalVersionId}`;
  const draft = state.nativeMemoryDraft?.binding === binding ? state.nativeMemoryDraft : null;
  const entry = memory.entries.find((item) => item.id === draft?.memoryId) || null;
  const scopeType = draft?.scopeType || 'global';
  const kind = draft?.kind || (scopeType === 'project' ? 'convention' : 'preference');
  const statusLine = memory.indexAvailable
    ? '<p class="field-note">XERJ 本地检索可用。记忆正文和来源仍以任务记录为准。</p>'
    : '<p class="field-note">XERJ 索引当前不可用；保存仍写入任务记录，涉及已有记忆的执行会明确显示检索降级。</p>';
  const entries = memory.entries.length ? `<div class="memory-register">${memory.entries.slice().reverse().map((item) => `<div class="memory-row"><div><strong>${esc(item.title)}</strong><small>v${item.revision} · ${item.scopeType === 'global' ? '全局偏好' : '项目约定'} · ${item.status === 'active' ? '生效中' : item.status === 'deleted' ? '已删除' : '已停用'}</small><small>来源：${esc(item.source?.type || '来源未知')} · task ${esc(item.source?.taskId || item.ownerTaskId || '—')} / event ${esc(item.source?.eventId || '—')}</small><small>${esc(item.text)}</small></div><div class="button-stack">${item.status !== 'deleted' ? `<button class="text-button" type="button" data-memory-edit="${esc(item.id)}">修正</button>${item.status === 'active' ? `<button class="text-button" type="button" data-memory-deactivate="${esc(item.id)}">停用</button>` : ''}<button class="text-button" type="button" data-memory-delete="${esc(item.id)}">删除</button>` : ''}</div></div>`).join('')}</div>` : '<p class="empty-ledger">还没有明确保存的长期记忆。对话不会自动写入。</p>';
  return `${statusLine}<form data-native-memory data-memory-binding="${esc(binding)}"><label>记忆范围<select name="scopeType" data-native-focus-key="memory-scope" ${entry ? 'disabled' : ''}><option value="global" ${scopeType === 'global' ? 'selected' : ''}>全局偏好（所有任务）</option>${memory.projectScopeCurrent ? `<option value="project" ${scopeType === 'project' ? 'selected' : ''}>当前已授权项目约定</option>` : ''}</select></label><label>类别<select name="kind" data-native-focus-key="memory-kind">${scopeType === 'project' ? '<option value="convention" selected>项目约定</option>' : '<option value="preference" selected>个人偏好</option>'}</select></label><label>标题<input name="title" maxlength="120" required value="${esc(draft?.title || '')}" data-native-focus-key="memory-title"></label><label>内容<textarea name="text" rows="3" maxlength="4000" required data-native-focus-key="memory-text">${esc(draft?.text || '')}</textarea></label><button class="primary-button" type="submit">${entry ? '保存修正' : '明确保存记忆'}</button>${entry ? '<button class="secondary-button" type="button" data-memory-cancel>取消修正</button>' : ''}<p class="field-note">只保存你在此处明确提交的内容。当前目标、边界和授权始终优先；记忆不会授予权限。</p></form>${entries}`;
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

function renderGameFileTree(nodes, view, selectedPath = null) {
  if (!nodes?.length) return '<p class="field-note">当前视图没有可列出的项目文件。</p>';
  return `<ul class="game-file-tree">${nodes.map((node) => node.type === 'directory'
    ? `<li><span class="game-file-directory">▸ ${esc(node.name)}</span>${renderGameFileTree(node.children || [], view, selectedPath)}</li>`
    : `<li><button class="game-file-button ${selectedPath === node.relativePath ? 'is-selected' : ''}" type="button" data-game-file="${esc(node.relativePath)}" data-game-view="${view}"><span>${esc(node.name)}</span><small>${Number.isFinite(node.size) ? `${node.size.toLocaleString('zh-CN')} B` : '文件'}</small></button></li>`).join('')}</ul>`;
}

async function loadGameWorkspace() {
  const native = state.nativeProduct;
  const taskId = native?.taskId;
  const requestSeq = ++state.gameWorkspaceRequestSeq;
  state.gameWorkspaceLoading = true;
  state.gameWorkspaceError = null;
  state.gameWorkspaceData = null;
  state.gameWorkspaceFile = null;
  state.gameWorkspaceFilePath = null;
  renderAll();
  try {
    if (!taskId || native.functionId !== 'game' || !native.current || !native.product?.bindingCurrent) {
      throw new Error('当前任务尚未提供有效的小游戏项目与 OpenOffice 执行绑定。');
    }
    if (native.product.projectId !== GAME_PROJECT_ID) {
      throw new Error('当前登记项目不是已接入 Noobi 游戏工程；不会把其他项目或空白模板显示成游戏候选。');
    }
    const params = new URLSearchParams({ projectId: native.product.projectId, view: 'source' });
    const data = await api(`/api/product/game-workspace?${params}`);
    if (requestSeq !== state.gameWorkspaceRequestSeq || state.gameWorkshopTaskId !== taskId
      || state.nativeProduct?.taskId !== taskId || !gameWorkspaceBindingMatches(data, state.nativeProduct)) return;
    state.gameWorkspaceData = data;
  } catch (error) {
    if (requestSeq === state.gameWorkspaceRequestSeq && state.gameWorkshopTaskId === taskId
      && state.nativeProduct?.taskId === taskId) state.gameWorkspaceError = error.message;
  } finally {
    if (requestSeq === state.gameWorkspaceRequestSeq && state.gameWorkshopTaskId === taskId
      && state.nativeProduct?.taskId === taskId) {
      state.gameWorkspaceLoading = false;
      renderAll();
    }
  }
}

async function openGameWorkspaceFile(relativePath, view) {
  const native = state.nativeProduct;
  const data = state.gameWorkspaceData;
  if (!data || !gameWorkspaceBindingMatches(data, native) || !['source', 'candidate'].includes(view)) {
    throw new Error('项目文件绑定已变化；请刷新工坊后再打开。');
  }
  if (view === 'candidate' && !data.candidateAvailable) throw new Error('当前没有可读取的 Authority 绑定候选。');
  state.gameWorkspaceFileView = view;
  state.gameWorkspaceFilePath = relativePath;
  state.gameWorkspaceFile = null;
  state.gameWorkspaceError = null;
  state.gameWorkspaceRequestSeq += 1;
  const requestSeq = state.gameWorkspaceRequestSeq;
  renderAll();
  const params = new URLSearchParams({ projectId: data.binding.projectId, view, path: relativePath });
  let result;
  try { result = await api(`/api/product/game-workspace?${params}`); }
  catch (error) {
    if (requestSeq === state.gameWorkspaceRequestSeq && state.gameWorkspaceFilePath === relativePath
      && state.gameWorkspaceFileView === view && state.nativeProduct?.taskId === data.binding.taskId) {
      state.gameWorkspaceError = error.message;
      renderAll();
    }
    return;
  }
  if (requestSeq !== state.gameWorkspaceRequestSeq || state.gameWorkspaceFilePath !== relativePath
    || state.gameWorkspaceFileView !== view || state.nativeProduct?.taskId !== data.binding.taskId) return;
  if (!gameWorkspaceFileResponseMatches(result, { native: state.nativeProduct, expectedBinding: data.binding,
    view, relativePath, requestId: requestSeq, currentRequestId: state.gameWorkspaceRequestSeq })) {
    state.gameWorkspaceData = null;
    state.gameWorkspaceError = '目标、执行、候选或登记在读取期间变化；旧文件已丢弃，请刷新当前工坊状态。';
    state.gameWorkspaceFile = null;
    renderAll();
    return;
  }
  state.gameWorkspaceFile = result.file;
  renderAll();
}

function renderGameWorkshop(root) {
  const native = state.nativeProduct;
  const binding = JSON.stringify([native?.taskId, native?.goalVersionId, native?.execution?.id,
    native?.product?.projectId, native?.product?.registrySha256, native?.artifact?.candidateSha256]);
  const render = (markup) => renderNativeMarkup(root, markup, binding, document.activeElement);
  const isGameTask = native?.functionId === 'game';
  const setupProject = native?.setup?.selectedProject;
  if (!isGameTask) {
    render('<section class="desk-sheet"><div class="sheet-heading"><h2>iRIXI 游戏工坊</h2></div><div class="sheet-body"><p>当前任务没有后台核实的小游戏职能归属；工坊不会借用其他任务项目。</p><button class="secondary-button" type="button" data-action="game-workbench-back">返回任务书桌</button></div></section>');
    return;
  }
  if (native.setupOnly || native.setupPending || !native.current || !native.product?.bindingCurrent) {
    const projects = native.setup?.projects || [];
    render(`<section class="desk-sheet"><div class="sheet-heading"><h2>iRIXI 游戏工坊</h2><span class="record-status">${esc(native.statusLabel || '等待原生绑定')}</span></div><div class="sheet-body"><p>${esc(native.nextStep || '尚无当前小游戏执行绑定。')}</p><p class="field-note">${setupProject ? `已选择登记项目：${esc(setupProject.label)} · ${esc(setupProject.projectId)}。选择不等于授权。` : projects.length ? `后台登记项目：${esc(projects.map((item) => item.label).join('、'))}` : '当前没有后台返回的已登记项目。'}</p><p class="field-note">文件读取、候选预览与下载仅在同一任务、已授权范围和当前执行绑定全部有效时开放。</p><button class="secondary-button" type="button" data-action="game-workbench-back">返回原生任务书桌处理设置</button></div></section>`);
    return;
  }
  const data = gameWorkspaceBindingMatches(state.gameWorkspaceData, native) ? state.gameWorkspaceData : null;
  const artifact = native.artifact;
  const review = artifact?.review;
  const candidateStatus = !artifact ? '尚无候选'
    : artifact.confirmation ? '已确认指定版本'
      : review?.passed ? '独立审阅通过，待确认'
        : review ? '独立审阅未通过'
          : '候选待独立审阅';
  const candidateTone = artifact?.confirmation || review?.passed ? 'good' : review ? 'bad' : '';
  const preview = native.preview?.status === 'ready' && native.links.preview
    ? `<a class="secondary-button" href="${esc(native.links.preview)}" target="_blank" rel="noopener">打开同一绑定候选试玩</a>`
    : native.native?.actions?.canPreview && artifact?.candidateSha256
      ? '<button class="secondary-button" type="button" data-view-target="review">在成果审阅台打开同一候选预览</button>'
      : '<span class="field-note">当前没有同一绑定且可用的候选试玩链接。</span>';
  const patchHref = nativePatchHref(native);
  const candidateActions = `${preview}${patchHref ? `<a class="primary-button" href="${esc(patchHref)}">下载已确认交付</a>` : '<span class="field-note">仅当前候选经审阅并由你确认后，才会显示绑定交付下载。</span>'}<button class="secondary-button" type="button" data-view-target="review">查看成果审阅与版本操作</button>`;
  const versionDetails = `<details class="game-version-details"><summary>版本详情</summary><p class="field-note">task ${esc(native.taskId)} · goal ${esc(native.goalVersionId)} · execution ${esc(native.execution?.id || '—')}<br>project ${esc(data?.project?.id || native.product?.projectId || '未登记')}<br>registry ${esc(native.product?.registrySha256 || '—')}<br>artifact ${esc(artifact?.id || '—')} · 候选 SHA ${esc(artifact?.candidateSha256 || '—')}</p></details>`;
  const filePane = state.gameWorkspaceLoading ? '<p class="field-note">正在读取当前已登记项目…</p>'
    : state.gameWorkspaceError ? `<p class="demo-warning">${esc(state.gameWorkspaceError)}</p>`
      : !data ? '<p class="field-note">尚无通过当前 Authority 绑定的文件清单；没有显示其他任务或空白模板内容。</p>'
        : `<div class="game-workspace-columns"><section class="game-file-list"><h3>已登记源项目</h3>${renderGameFileTree(data.sourceFiles, 'source', state.gameWorkspaceFileView === 'source' ? state.gameWorkspaceFilePath : null)}<h3>当前候选工作树</h3>${data.candidateAvailable ? renderGameFileTree(data.candidateFiles, 'candidate', state.gameWorkspaceFileView === 'candidate' ? state.gameWorkspaceFilePath : null) : '<p class="field-note">没有当前 Authority 绑定候选；源项目文件不会被当作候选。</p>'}</section><section class="game-file-preview"><h3>${state.gameWorkspaceFilePath ? esc(state.gameWorkspaceFilePath) : '选择文件查看内容 / 素材来源清单'}</h3>${state.gameWorkspaceFilePath ? !state.gameWorkspaceFile ? '<p class="field-note">正在读取已选文件…</p>' : state.gameWorkspaceFile.binary ? '<p class="field-note">这是二进制素材。文件名和大小来自 ProjectStore；此处不把图片/音频伪装成文字内容。</p>' : `<pre>${esc(state.gameWorkspaceFile.content)}${state.gameWorkspaceFile.truncated ? '\n\n…文件超过预览上限，后续内容未读取。' : ''}</pre>` : '<p class="field-note">文件路径由 ProjectStore 返回；点击素材清单可核对真实来源说明。</p>'}</section></div>`;
  render(`<div class="game-workshop"><section class="desk-sheet"><div class="sheet-heading"><div><span class="eyebrow">IRIXI GAME WORKSHOP</span><h2>iRIXI 游戏工坊</h2></div><div class="inline-actions"><button class="secondary-button" type="button" data-action="game-workspace-refresh" ${state.gameWorkspaceLoading ? 'disabled' : ''}>${state.gameWorkspaceLoading ? '正在读取…' : '刷新真实状态'}</button><button class="text-button" type="button" data-action="game-workbench-back">返回任务书桌</button></div></div><div class="sheet-body"><p><strong>${esc(native.title)}</strong> · ${esc(data?.project?.name || '尚无已登记游戏项目')}</p><p>当前进度：${esc(native.statusLabel || native.status || '状态未提供')} · 模型调用 ${native.execution?.modelCalls?.length ?? '—'}${native.product?.maxModelCalls ? `/${native.product.maxModelCalls}` : ''}</p><p class="field-note">源项目状态：${esc(data?.project?.status || '未读取')} · 阶段：${esc(data?.project?.stage || '未读取')}。文件清单和正文仅来自已登记项目与当前受权候选工作树。</p>${versionDetails}</div></section><section class="desk-sheet"><div class="sheet-heading"><h2>构建、审阅与交付</h2><span class="record-status" data-tone="${candidateTone}">${esc(candidateStatus)}</span></div><div class="sheet-body"><p class="field-note">当前版本 ${artifact ? `v${esc(artifact.version)}` : '尚未生成'}<br>Noobi Web 构建检查：${artifact?.hostCheck ? artifact.hostCheck.passed ? 'PASS' : 'FAIL' : '尚无候选检查记录'}<br>独立审阅：${review ? `${review.passed ? 'PASS' : 'FAIL'} · ${esc(review.id || '审阅记录已保存')}` : '尚无审阅记录'}<br>确认：${artifact?.confirmation ? '已确认指定版本' : '未确认'}</p><div class="inline-actions">${candidateActions}</div></div></section><section class="desk-sheet"><div class="sheet-heading"><h2>项目文件与素材来源</h2><span class="record-status">${data ? `${data.sourceFiles.length} 项顶层记录` : '等待绑定'}</span></div><div class="sheet-body">${filePane}</div></section></div>`);
}

function renderNativeDesk(root) {
  const native = state.nativeProduct;
  if (state.gameWorkshopTaskId && state.gameWorkshopTaskId === native?.taskId) {
    $('#desk-subtitle').textContent = '只读显示当前 OpenOffice 游戏任务绑定的 Noobi 项目、素材来源与候选状态。';
    renderGameWorkshop(root);
    return;
  }
  const binding = JSON.stringify([
    native.taskId || null,
    native.goalVersionId || null,
    native.setup?.projects?.filter((project) => project.current).map((project) => [project.projectId, project.scopeFingerprint]) || [],
    native.setup?.selectedScope?.current ? [native.setup.selectedScope.projectId, native.setup.selectedScope.scopeFingerprint] : null,
    native.execution?.id || null,
    native.registry?.registrySha256 || native.product?.registrySha256 || null,
    native.artifact ? [native.artifact.id, native.artifact.version, native.artifact.candidateSha256] : null,
  ]);
  const render = (markup) => renderNativeMarkup(root, markup, binding, document.activeElement);
  if (native.setupOnly) {
    render(`<div class="desk-columns"><div class="desk-stack"><section class="desk-sheet"><div class="sheet-heading"><h2>建立第一项原生任务</h2><span class="record-status">正常设置态</span></div><div class="sheet-body"><p>${esc(native.nextStep)}</p><button class="primary-button" type="button" data-open-dialog="task-dialog">写下目标</button></div></section></div><aside class="desk-stack"><section class="desk-sheet"><div class="sheet-heading"><h2>已登记项目</h2></div><div class="sheet-body"><p class="field-note">${native.setup.projects.length ? esc(native.setup.projects.map((item) => item.label || item.projectId).join('、')) : '当前状态尚未提供可选登记项目；不会由前端虚构项目或工作区。'}</p></div></section><section class="desk-sheet"><div class="sheet-heading"><h2>尚未发生</h2></div><div class="sheet-body"><p class="field-note">还没有执行记录、产品登记、模型调用、候选成果、审阅或确认。这是新任务开始前的正常状态，不是失败。</p></div></section></aside></div>`);
    return;
  }
  if (native.setupPending) {
    const projects = native.setup.projects.filter((project) => project.current);
    const projectFacts = projects.map((project) => `<div class="project-scope-card"><p><strong>${esc(project.label)}</strong></p><p class="field-note">project ${esc(project.projectId)}<br>保存位置：${esc(project.location || '后台未提供')}<br>scope ${esc(project.scopeFingerprint)}<br>可写：${esc(project.allowedWritePaths.join('、') || '无')}<br>检查：${esc(project.checkIds.join('、') || '无')}</p></div>`).join('');
    const selected = native.setup.selectedProject;
    let scopeStep;
    if (native.setupStatus === 'waiting_scope') {
      scopeStep = projects.length ? `<form data-native-scope><label>选择后台登记项目<select name="projectId" data-native-focus-key="scope-project" required><option value="" selected disabled>请选择与当前目标匹配的项目</option>${projects.map((project) => `<option value="${esc(project.projectId)}" data-scope-fingerprint="${esc(project.scopeFingerprint)}" data-scope-current="true">${esc(project.label)}</option>`).join('')}</select></label><button class="primary-button" type="submit" data-native-focus-key="scope-select" ${native.native.actions.canScope ? '' : 'disabled'}>选择这个项目范围</button><p class="field-note">请按本次目标手动选匹配的已登记项目；没有匹配项时先登记。不会自动套用文章学习范围。</p>${native.native.actions.canScope ? '' : '<p class="field-note">HTTP 入口尚未明确开放 scope 动作；当前只能核对列表。</p>'}</form>${projectFacts}`
        : '<p class="demo-warning">后台当前没有返回可选且有效的登记项目。不能手工填写路径，也不会使用证据夹具冒充真实项目。</p>';
    } else {
      const selectedScope = `<div class="project-scope-card"><p><strong>${esc(selected?.label || '已选择项目')}</strong></p><p class="field-note">project ${esc(selected?.projectId || '—')}<br>保存位置：${esc(selected?.location || '后台未提供')}<br>scope ${esc(native.setup.selectedScope?.scopeFingerprint || selected?.scopeFingerprint || '—')}<br>可写：${esc(selected?.allowedWritePaths?.join('、') || '无')}<br>检查：${esc(selected?.checkIds?.join('、') || '无')}</p></div>`;
      scopeStep = native.setupStatus === 'waiting_scope_authorization'
        ? `${selectedScope}<form data-native-authorize-scope><button class="primary-button" type="submit" data-native-focus-key="scope-authorize" ${native.native.actions.canAuthorizeScope ? '' : 'disabled'}>授权这个有限范围</button><p class="field-note">${native.native.actions.canAuthorizeScope ? '授权后后台仍需创建当前 registry 与执行绑定；不会立即确认、合并或发布。' : 'authorize_scope 尚未由在线入口明确开放；当前不把“已选择”写成“已授权”。'}</p></form>`
        : native.setupStatus === 'ready_to_run'
          ? `${selectedScope}${canRestoreCurrentResult(native) ? `<p class="field-note">原执行与已确认成果已保留，恢复只会沿用该版本，不会重新开发。</p><div class="review-panel"><strong>已确认版本 v${native.currentResultRecovery.artifactVersion} 可安全恢复</strong><p class="field-note">候选、执行、目标和项目范围均与当前任务绑定。</p><button class="primary-button" type="button" data-action="native-restore-confirmed">恢复已确认成果（不重新开发）</button></div>` : '<p class="field-note">范围授权已经保存。原生执行、registry 与模型调用尚未开始。</p>'}${native.canPrepareRun && nativeSetupBound(native) ? `<button class="${canRestoreCurrentResult(native) ? 'secondary' : 'primary'}-button" type="button" data-action="native-prepare-run">${canRestoreCurrentResult(native) ? '准备新一轮' : '准备原生后台'}</button><p class="field-note">${canRestoreCurrentResult(native) ? '这会创建新执行轮次；若要保留已确认成果，请使用上方恢复入口。' : '这一步只初始化受控组件、登记当前执行与产品绑定；不会启动模型工作。'}</p>` : '<button class="secondary-button" type="button" disabled>等待后台开放运行准备</button>'}`
          : native.setupStatus === 'runtime_starting'
            ? `${selectedScope}<p class="field-note">当前执行与 registry 已经登记；正在等待原生后台就绪，模型调用仍为 0。</p><button class="secondary-button" type="button" disabled>原生后台正在启动</button>`
            : `${selectedScope}<p class="demo-warning">当前执行与 registry 已经保留，但原生后台不可用。页面不会回退到旧执行器，也不会把未连接状态写成完成。</p>${native.canPrepareRun && nativeSetupBound(native) ? '<button class="primary-button" type="button" data-action="native-prepare-run">恢复原生后台</button><p class="field-note">恢复沿用同一执行账与当前授权，不会启动模型工作。</p>' : '<button class="secondary-button" type="button" disabled>等待原生后台恢复</button>'}`;
    }
    const setupHeading = native.setupStatus === 'waiting_scope' ? '选择项目范围'
      : native.setupStatus === 'waiting_scope_authorization' ? '核对并授权范围'
        : native.setupStatus === 'runtime_unavailable' ? '已保留的原生运行绑定' : '已授权的项目范围';
    const inputActions = `${native.native.actions.canInstructions ? '<button class="secondary-button wide-button" type="button" data-open-dialog="suggestion-dialog">补充工作要求</button>' : ''}${native.native.actions.canMaterials ? '<button class="secondary-button wide-button" type="button" data-open-dialog="material-dialog">加入文本材料</button>' : ''}`;
    render(`<div class="desk-columns"><div class="desk-stack"><section class="desk-sheet"><div class="sheet-heading"><h2>当前目标</h2><span class="record-status" data-tone="good">设置中</span></div><div class="sheet-body"><p><strong>${esc(native.title)}</strong></p><p>${esc(native.goalStatement)}</p><p class="field-note">成功条件：${esc(native.successCriteria.join('；') || '未填写')}<br>工作边界：${esc(native.boundaries.join('；') || '未填写')}<br>goal ${esc(native.goalVersionId)}</p>${inputActions ? `<div class="button-stack">${inputActions}</div><p class="field-note">这两类输入会进入当前任务并使旧设置绑定失效；不会静默替换目标，也不会启动模型。</p>` : ''}</div></section><section class="desk-sheet"><div class="sheet-heading"><h2>${setupHeading}</h2><span class="record-status">${esc(native.statusLabel)}</span></div><div class="sheet-body">${scopeStep}</div></section></div><aside class="desk-stack"><section class="desk-sheet"><div class="sheet-heading"><h2>当前阶段</h2></div><div class="sheet-body"><p>${esc(native.nextStep)}</p><p class="field-note">execution：${esc(native.execution?.id || '尚未创建')}<br>registry：${esc(native.registry?.status || '尚未创建')}<br>模型调用：0（本设置态）</p></div></section><section class="desk-sheet"><div class="sheet-heading"><h2>长期记忆</h2></div><div class="sheet-body">${renderNativeMemoryPanel(native)}</div></section></aside></div>`);
    return;
  }
  const product = native.product;
  const execution = native.execution;
  const actions = native.native?.actions;
  const runLead = native.native?.agents?.find((agent) => agent.id === native.native?.runAgentId);
  const runningMember = native.team.find((agent) => agent.status === 'running');
  const roleFallback = nativeExecutionRoleFallback(native);
  const actualRole = !native.current ? '任务或产品绑定已经失效，原生团队保持待命'
    : native.actor ? `${native.actor}${native.stationRole ? ` · OpenOffice 工位 ${native.stationRole}` : '（没有对应办公室工位）'}`
      : runningMember ? `${runningMember.name || runningMember.role} 正在执行当前授权任务`
        : roleFallback ? roleFallback
          : native.native?.plan ? actions?.canApprovePlan ? `${runLead?.name || runLead?.role || 'Lead'} 已提交真实计划，等待明确批准`
            : native.native?.planApprovalStatus === 'not_persisted' ? `${runLead?.name || runLead?.role || 'Lead'} 的计划尚未保存成功，当前不可批准；原文仍可查看`
              : native.native?.planApprovalStatus === 'unavailable' ? `${runLead?.name || runLead?.role || 'Lead'} 的计划保存状态暂不可读取，当前不可批准；原文仍可查看`
                : native.native?.planApprovalStatus === 'mismatch' ? '保留的计划与当前任务绑定不匹配，当前不可批准；原文仍可查看'
              : execution?.stopReason ? `执行已停止，原计划保留但当前不可批准`
                : `当前计划不可批准（状态尚未确认）`
            : runLead ? `${runLead.name || runLead.role || runLead.id} 已登记为启动 Lead，尚无在途执行` : '原生状态未提供活动角色，所有同事保持待命';
  const nativeRoster = native.team.length ? native.team.map((agent) => `${agent.name} · ${agent.role || agent.stationRole || '原生成员'} · ${agent.status === 'idle' ? '待命' : agent.status}`) : [];
  const nativeTaskLink = native.links.nativeTask ? `<a class="primary-button" href="${esc(native.links.nativeTask)}">打开 OpenOffice 原生任务</a>` : '<button class="secondary-button" type="button" disabled>原生任务链接未提供</button>';
  const actionButtons = `${actions?.canApprovePlan && native.native?.bindingCurrent && native.native?.plan?.sha256 && nativeActionBound(native) ? '<button class="primary-button" type="button" data-action="native-approve-plan" data-native-focus-key="approve-plan">批准当前 Lead 计划</button>' : ''}${actions?.canRun && native.native?.runAgentId && nativeActionBound(native) ? '<button class="primary-button" type="button" data-action="native-run" data-native-focus-key="run">由原生 Lead 开始执行</button>' : ''}${actions?.canContinue && nativeActionBound(native) ? '<button class="primary-button" type="button" data-action="native-resume" data-native-focus-key="resume">按当前目标继续</button>' : ''}`;
  render(`<div class="desk-columns"><div class="desk-stack">
    <section class="desk-sheet"><div class="sheet-heading"><h2>当前目标</h2><span class="record-status" data-tone="${native.current ? 'good' : 'bad'}">${native.current ? '当前有效' : '已经失效'}</span></div><div class="sheet-body provider-line"><p><strong>${esc(native.title)}</strong></p><p>${esc(native.goalStatement)}</p><p class="field-note">task ${esc(native.taskId)}<br>goal ${esc(native.goalVersionId)}<br>authority ${native.authorityCurrent ? 'current' : 'stale'} · product binding ${product?.bindingCurrent ? 'current' : 'stale'}</p>${product?.bindingError ? `<p class="demo-warning">${esc(product.bindingError)}</p>` : ''}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>OpenOffice 原生执行</h2><span class="record-status" data-tone="${native.officeStatus === 'running' ? 'active' : native.officeStatus === 'failed' ? 'bad' : ''}">${esc(native.statusLabel || native.status)}</span></div><div class="sheet-body provider-line"><p><strong>实际执行角色</strong><br>${esc(actualRole)}</p><p><strong>执行记录</strong><br>${execution ? `ID ${esc(execution.id || '未提供')} · 阶段 ${esc(execution.phase || native.status)}${execution.stopReason ? `<br>停止原因 ${esc(execution.stopReason)}` : ''}` : '尚未提供活动执行记录'}</p><p><strong>已登记执行</strong><br>${native.registeredExecution ? `目标 ${esc(native.registeredExecution.goalVersionId || '—')} · prompt ${esc(native.registeredExecution.promptSha256 || '—')}` : '未登记'}</p>${native.native?.plan ? `<div class="review-panel"><span class="record-status" data-tone="${actions?.canApprovePlan ? 'active' : native.native?.planApprovalStatus === 'not_persisted' || native.native?.planApprovalStatus === 'mismatch' || execution?.stopReason ? 'bad' : ''}">${actions?.canApprovePlan ? '等待批准' : native.native?.planApprovalStatus === 'not_persisted' ? '计划未保存成功 · 当前不可批准' : native.native?.planApprovalStatus === 'unavailable' ? '保存状态不可读取 · 当前不可批准' : native.native?.planApprovalStatus === 'mismatch' ? '计划与当前绑定不符 · 当前不可批准' : execution?.stopReason ? '执行已停止 · 当前不可批准' : '当前不可批准'}</span><h3>Lead 提交的计划原文</h3><p class="field-note">SHA-256 ${esc(native.native.plan.sha256)}</p><pre class="native-plan-view">${esc(native.native.plan.text)}</pre></div>` : ''}<p><strong>下一步</strong><br>${esc(native.nextStep)}</p>${nativeTaskLink}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>原生任务操作</h2></div><div class="sheet-body provider-line"><div class="inline-actions">${actionButtons || '<button class="secondary-button" type="button" disabled>当前没有可执行动作</button>'}${actions?.canInstructions ? '<button class="secondary-button" type="button" data-open-dialog="suggestion-dialog">补充工作要求</button>' : ''}${actions?.canMaterials ? '<button class="secondary-button" type="button" data-open-dialog="material-dialog">加入文本材料</button>' : ''}</div><p class="field-note">每个动作都提交到同一 OpenOffice 产品动作入口；后台会再次核对当前任务、目标、执行与产品绑定。</p></div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>接受完整新版目标</h2></div><div class="sheet-body"><form data-native-goal><p class="field-note">这是目标替换，不是普通补充。请完整填写新版目标、成功条件和工作边界；不会从旧版静默继承。</p><label>新版目标<textarea name="statement" data-native-focus-key="goal-statement" rows="4" maxlength="4000" required>${esc(native.goalStatement)}</textarea></label><label>新版成功条件 <span class="field-note">每行一条</span><textarea name="successCriteria" data-native-focus-key="goal-success" rows="3" required></textarea></label><label>新版工作边界 <span class="field-note">每行一条</span><textarea name="boundaries" data-native-focus-key="goal-boundaries" rows="3" required></textarea></label><button class="danger-button" type="submit" ${actions?.canGoal && nativeSetupBound(native) ? '' : 'disabled'}>接受完整新版目标</button></form></div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>当前接线边界</h2></div><div class="sheet-body"><p class="field-note">真实状态、范围准备与 Lead 启动只按后台明确资格开放；缺字段时按钮保持不可用。</p><ul class="boundary-list"><li>首个任务、登记项目、范围选择与授权已按实际设置合同接入</li><li>原生后台准备是零模型步骤；只有 canRun 与真实 runAgentId 同时存在才显示模型启动</li><li>同事双向讨论已接源码；只有模型能力、当前绑定、动作资格和真实成员同时有效时才允许发送</li><li>目标、工作要求、材料、继续、暂停、取消、计划批准、候选读取、审阅、预览和退回均按当前在线动作合同开放</li></ul></div></section>
  </div><aside class="desk-stack">
    <section class="desk-sheet"><div class="sheet-heading"><h2>产品登记</h2><span class="record-status">${product ? '已读取' : '未提供'}</span></div><div class="sheet-body provider-line">${product ? `<p><strong>项目</strong><br>${esc(product.projectId || '—')}</p><p><strong>登记指纹</strong><br>${esc(product.registrySha256 || '—')}</p><p><strong>工作区范围</strong><br>${esc(product.workspaceScopeFingerprint || '—')}</p><p><strong>允许写入</strong><br>${esc(lines(product.allowedWritePaths))}</p><p><strong>固定检查</strong><br>${esc(lines(product.checks.map(checkLabel)))}</p><p><strong>已登记能力</strong><br>${esc(lines(capabilityLines(product.capabilities)))}</p>` : '<p class="demo-warning">原生状态未提供产品登记信息。</p>'}</div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>原生运行边界</h2></div><div class="sheet-body provider-line"><p><strong>实际登记团队</strong><br>${esc(lines(nativeRoster, '未提供'))}</p><p><strong>允许角色</strong><br>${esc(lines(product?.allowedRoles, '未提供'))}</p><p class="field-note">团队成员当前均可处于待命；只有真实运行或工作项会点亮工位。</p><p><strong>运行预算</strong><br>${product?.maxModelCalls ?? '—'} 次模型调用 · ${product?.maxDurationMs ? `${Math.round(product.maxDurationMs / 60000)} 分钟` : '时限未提供'}</p></div></section>
    <section class="desk-sheet"><div class="sheet-heading"><h2>长期记忆</h2></div><div class="sheet-body">${native.memory?.stalePreparedPrompt ? `<p class="demo-warning">准备后记忆内容或版本发生变化。Lead 暂不可启动；重新准备会更新同一未启动执行的提示词，不会新建批次或调用模型。</p>${native.canPrepareRun && native.product?.workspaceScopeFingerprint && nativeSetupBound(native) ? '<button class="primary-button" type="button" data-action="native-prepare-run">按当前记忆重新准备</button>' : '<p class="field-note">当前后台未提供重新准备资格。</p>'}` : ''}${renderNativeMemoryPanel(native)}${native.memory?.references?.length ? `<h3>本次准备引用的记忆来源</h3><ul>${native.memory.references.map((item) => `<li>${esc(item.title)} · v${item.revision} · ${esc(item.ownerTaskId || 'task')} / ${esc(item.sourceEventId || 'event')}</li>`).join('')}</ul>` : ''}${native.memory?.indexDegraded ? `<p class="demo-warning">本次记忆索引降级：${esc(native.memory.indexDegraded)}；未引用旧索引内容。</p>` : ''}</div></section>
  </aside></div>`);
}

function renderDesk() {
  const root = $('#desk-content');
  const task = state.task;
  $('#desk-subtitle').textContent = task ? `当前任务：${task.title}` : '材料、建议与工作步骤都围绕当前目标排列。';
  if (nativeMode()) {
    $('#desk-subtitle').textContent = '来自同一 OpenOffice 原生任务的只读状态与能力边界。';
    renderNativeDesk(root);
    return;
  }
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

function renderNativeReview(root) {
  const native = state.nativeProduct;
  const binding = nativeReviewBinding(native);
  nativeReviseDraft.capture(root, binding, document.activeElement);
  const render = (html) => {
    if (renderNativeMarkup(root, html, binding, document.activeElement)) nativeReviseDraft.restore(root, binding);
  };
  if (native.setupOnly) {
    render('<div class="empty-desk"><span class="eyebrow">NO TASK YET</span><h2>还没有可审阅的原生任务</h2><p>先建立一个真实目标；建立任务不会自动运行模型或产生候选。</p><button class="primary-button" type="button" data-open-dialog="task-dialog">建立第一项原生任务</button></div>');
    return;
  }
  const artifact = native.artifact;
  if (!artifact) {
    render(`<div class="empty-desk"><span class="eyebrow">NO NATIVE CANDIDATE</span><h2>OpenOffice 还没有提供候选成果</h2><p>${esc(native.nextStep)}</p>${native.links.nativeTask ? `<a class="secondary-button" href="${esc(native.links.nativeTask)}">打开原生任务</a>` : ''}</div>`);
    return;
  }
  const review = artifact.review;
  const confirmed = artifact.confirmation;
  const patchHref = nativePatchHref(native);
  const zipHref = nativeZipHref(native);
  const candidate = nativeCandidateMatches(native) ? state.nativeCandidate : null;
  const reviewBinding = nativeReviewBinding(native);
  const candidateReviewMatches = Boolean(candidate?.review && review && candidate.review.id === review.id && candidate.review.passed === false
    && candidate.review.nativeVerdict === 'FAIL' && candidate.review.fullOutputSha256 === review.fullOutputSha256
    && typeof candidate.review.text === 'string' && candidate.review.text.trim());
  const reviewPending = state.nativeReviewPending?.binding === reviewBinding;
  const reviewRound = native.native?.reviewRound;
  const reviewRoundId = reviewRound?.id || null;
  const reviewEvidenceDraft = state.nativeReviewEvidenceDraft?.binding === reviewBinding
    && state.nativeReviewEvidenceDraft?.roundId === reviewRoundId ? state.nativeReviewEvidenceDraft.text : '';
  const reviewEvidence = reviewRound?.status === 'open' && review && !review.passed
    ? `<label class="field-label" for="native-review-evidence">补充审阅证据（可选，最多 512 UTF-8 字节）</label><textarea id="native-review-evidence" rows="4" data-native-review-evidence data-review-binding="${esc(reviewBinding)}" data-review-round-id="${esc(reviewRoundId)}" placeholder="指出应核验的代码路径与条件；不要要求 Reviewer 给出特定结论。">${esc(reviewEvidenceDraft)}</textarea><p class="field-note">这段内容会作为不可信线索交给 Reviewer 独立核验，不改变目标、候选或旧审阅结论；当前完整请求若超出模型容量，会在调用前拒绝。</p>` : '';
  const preparationFailure = (native.native?.preparationFailures || []).find((item) =>
    item.candidateSha256 === artifact.candidateSha256 && item.modelCallCreated === false && item.status === 'failed');
  const reviewRoundPending = state.nativeReviewRoundPending?.binding === reviewBinding;
  const reviewCandidateBound = Boolean(nativeActionBound(native) && reviewBinding && artifact.id && artifact.candidateSha256 && !confirmed);
  const reviewAction = reviewCandidateBound && reviewPending
    ? '<button class="secondary-button" type="button" disabled>独立审阅已提交，等待新结果</button><p class="field-note" role="status" aria-live="polite">旧审阅记录仍保留；收到当前候选的新审阅结果前不会重复提交。</p>'
    : canReviewNativeCandidate(native)
      ? `<button class="secondary-button" type="button" data-action="native-review" data-native-review-binding="${esc(reviewBinding)}">${reviewRound?.status === 'open' ? '开始本轮独立审阅（1 次）' : review ? '重新独立审阅这个候选' : '请求独立审阅'}</button>`
      : reviewCandidateBound && review && !review.passed
        ? '<p class="field-note">后台当前未开放重新审阅。</p>' : '';
  const reviewRoundAction = reviewCandidateBound && native.native?.actions?.canOpenReviewRound === true
    ? reviewRoundPending ? '<button class="secondary-button" type="button" disabled>正在开启后续审阅轮…</button>'
      : `<button class="secondary-button" type="button" data-action="native-open-review-round" data-native-review-binding="${esc(reviewBinding)}">开启后续只读审阅轮（1 次 / 20 分钟）</button>`
    : '';
  const reconnectReviewAction = reviewCandidateBound && native.native?.actions?.canReconnectReview === true
    ? `<button class="secondary-button" type="button" data-action="native-reconnect-review-runtime" data-native-review-binding="${esc(reviewBinding)}">接回原审阅运行环境（不启动模型）</button>`
    : '';
  const reviewRoundStatus = reviewRound ? `<p class="field-note" role="status">后续审阅轮：${esc(({ open: '已开启，尚未调用', running: '审阅正在进行', expired: '时间已结束', stale: '绑定已过期', completed: '已完成', failed: '调用失败' })[reviewRound.status] || '状态未知')} · ${reviewRound.modelCalls}/${reviewRound.maxModelCalls} 次${reviewRound.deadlineAt ? ` · 截止 ${esc(reviewRound.deadlineAt)}` : ''}。不会自动续开。</p>` : '';
  const preparationFailureStatus = preparationFailure ? `<p class="field-note" role="status">Reviewer 未启动，模型调用 0 次：${esc(preparationFailure.error)}</p>` : '';
  const canConfirm = native.current && native.native?.actions.canConfirm && artifact.id && review?.passed && !confirmed && native.links.confirm && candidate;
  const canAdjudicateConfirm = native.current && native.native?.actions.canAdjudicateConfirm && artifact.id
    && review?.passed === false && review.nativeVerdict === 'FAIL' && review.id && review.fullOutputSha256
    && !confirmed && native.links.confirm && candidate && candidateReviewMatches;
  const adjudicationDraftMatches = state.nativeReviewAdjudicationDraft?.binding === reviewBinding
    && state.nativeReviewAdjudicationDraft?.reviewId === review?.id
    && state.nativeReviewAdjudicationDraft?.reviewFullOutputSha256 === review?.fullOutputSha256;
  const adjudicationDraft = adjudicationDraftMatches ? state.nativeReviewAdjudicationDraft.reason : '';
  const authorizationThreadDraft = adjudicationDraftMatches ? state.nativeReviewAdjudicationDraft.authorizationSourceThreadId : '';
  const authorizationTextDraft = adjudicationDraftMatches ? state.nativeReviewAdjudicationDraft.authorizationText : '';
  const adjudicationForm = canAdjudicateConfirm
    ? `<div class="review-panel" data-native-adjudication data-review-binding="${esc(reviewBinding)}"><h4>真人裁决（原始 FAIL 保留）</h4><p class="field-note">Reviewer 的 FAIL 不会改成 PASS。只有你阅读原报告并写明裁决理由后，才能对这个精确候选作单独确认；理由、审阅摘要、裁决授权出处和候选绑定会写入审计记录。</p><label class="field-label" for="native-review-adjudication-reason">裁决理由（最多 1000 UTF-8 字节）</label><textarea id="native-review-adjudication-reason" rows="4" data-native-adjudication-reason data-review-binding="${esc(reviewBinding)}" placeholder="说明你为何对当前 FAIL 作出人工裁决，以及仍保留的风险。">${esc(adjudicationDraft)}</textarea><label class="field-label">授权来源聊天 ID<input class="text-input" data-native-adjudication-source-thread maxlength="160" data-review-binding="${esc(reviewBinding)}" placeholder="填写授权来源聊天 ID" value="${esc(authorizationThreadDraft)}"></label><label class="field-label">本轮授权原文<textarea rows="2" maxlength="1000" data-native-adjudication-source-text data-review-binding="${esc(reviewBinding)}" placeholder="粘贴本轮授权原文">${esc(authorizationTextDraft)}</textarea></label><button class="danger-button" type="button" data-action="native-adjudicate-confirm" data-review-binding="${esc(reviewBinding)}">保留 FAIL 并人工裁决确认</button></div>` : '';
  const previewEntries = native.product?.capabilities?.staticPreviewEntries || [];
  const previewReady = native.current && native.preview?.status === 'ready'
    && native.preview.taskId === native.taskId && native.preview.goalVersionId === native.goalVersionId
    && native.preview.executionId === native.execution?.id && native.preview.registrySha256 === native.product?.registrySha256
    && native.preview.artifactId === artifact.id && native.preview.artifactVersion === artifact.version
    && native.preview.candidateSha256 === artifact.candidateSha256
    && previewEntries.includes(native.preview.entry) && (native.product?.capabilities?.staticPreviewFiles || []).includes(native.preview.entry)
    && native.links.preview;
  const previewPanel = previewEntries.length ? `<div class="review-panel"><h3>当前候选预览</h3><p class="field-note">预览按当前目标、执行、登记、候选版本与文件摘要绑定。异步请求被接受不代表预览已就绪。</p>${native.preview?.status === 'pending' ? '<p class="record-status" data-tone="active">预览正在准备</p>' : native.preview?.status === 'failed' ? `<p class="field-note">${esc(native.preview.error || '预览准备失败，请重新请求。')}</p>` : ''}${previewReady ? `<a class="export-link" href="${esc(native.links.preview)}" target="_blank" rel="noopener">打开当前候选预览（${esc(native.preview.entry || '入口')}）</a>` : `<label class="field-label" for="native-preview-entry">登记入口</label><select class="text-input" id="native-preview-entry" data-native-focus-key="preview-entry" ${native.native?.actions.canPreview && native.current && artifact.candidateSha256 ? '' : 'disabled'}>${previewEntries.map((entry) => `<option value="${esc(entry)}" ${native.preview?.entry === entry ? 'selected' : ''}>${esc(entry)}</option>`).join('')}</select><button class="secondary-button" type="button" data-action="native-preview" ${native.native?.actions.canPreview && native.current && artifact.candidateSha256 ? '' : 'disabled'}>${native.preview?.status === 'pending' ? '重新请求当前候选预览' : '生成当前候选预览'}</button>`}</div>` : '';
  const candidateDetail = candidate ? `<section class="native-candidate-detail"><h3>真实候选文件</h3><p class="field-note">diff ${esc(candidate.diffSha256)} · patch ${esc(candidate.patchSha256)}</p><ul class="boundary-list">${candidate.files.map((file) => `<li>${esc(file.path)}${file.sha256 ? ` · ${esc(file.sha256)}` : ''}${file.bytes !== null ? ` · ${esc(file.bytes)} bytes` : ''}</li>`).join('') || '<li>没有变更文件</li>'}</ul><h3>固定检查</h3><ul class="boundary-list">${candidate.checks.map((check) => `<li>${esc(check.id)} · ${check.passed ? 'PASS' : 'FAIL'}${check.detail ? ` · ${esc(check.detail)}` : ''}</li>`).join('') || '<li>没有检查记录</li>'}</ul><h3>完整差异</h3><pre class="native-patch-view">${esc(candidate.patch || '（空差异）')}</pre></section>` : `<section class="native-candidate-detail"><h3>确认前先核对真实差异</h3><p class="field-note">${esc(state.nativeCandidateError || '文件清单、固定检查和完整 patch 尚未读取；在读取并核对当前版本前，确认按钮保持不可用。')}</p>${native.native?.actions.canInspectDiff && native.links.candidate ? `<button class="secondary-button" type="button" data-action="native-inspect-candidate" ${state.nativeCandidateLoading ? 'disabled' : ''}>${state.nativeCandidateLoading ? '正在读取真实候选…' : '查看真实差异与文件'}</button>` : '<button class="secondary-button" type="button" disabled>后台尚未开放当前候选查看</button>'}</section>`;
  render(`<div class="proof-grid"><article class="artifact-paper"><header class="artifact-header"><span class="eyebrow">OPENOFFICE NATIVE CANDIDATE</span><h2>${esc(native.title)}</h2><div class="artifact-meta"><span>版本 ${esc(artifact.version ?? '—')}</span><span>目标 ${esc(native.goalVersionId)}</span><span>${confirmed ? '指定版本已确认' : '尚未确认'}</span></div></header><div class="artifact-content native-artifact-facts"><p><strong>候选 ID</strong><br>${esc(artifact.id || '未提供')}</p><p><strong>候选 SHA-256</strong><br>${esc(artifact.candidateSha256 || '未提供')}</p><p><strong>宿主固定检查</strong><br>${artifact.hostCheck ? artifact.hostCheck.passed ? '通过' : '未通过' : '未提供'}</p>${candidateDetail}</div></article><aside class="review-sidebar">
    <div class="review-panel"><span class="record-status" data-tone="${review?.passed ? 'good' : review ? 'bad' : ''}">${review ? review.passed ? '审阅通过' : '审阅未通过' : '尚无审阅'}</span><h3>OpenOffice 原生审阅</h3><p class="field-note">review ${esc(review?.id || '—')}<br>verdict ${esc(review?.nativeVerdict || '—')}<br>scope ${esc(review?.scopeOutcome || '—')}<br>report SHA-256 ${esc(review?.fullOutputSha256 || '—')}</p>${candidateReviewMatches ? `<details class="review-panel"><summary>查看完整 Reviewer 原文</summary><pre class="native-patch-view">${esc(candidate.review.text)}</pre></details>` : ''}${confirmed?.reviewAdjudication ? `<p class="field-note"><strong>人工裁决；原始 FAIL 保留</strong><br>${esc(confirmed.reviewAdjudication.reason)}<br>${esc(confirmed.reviewAdjudication.decidedBy)} · ${esc(confirmed.reviewAdjudication.decidedAt)}<br>授权来源：${esc(confirmed.reviewAdjudication.authorizationSourceThreadId || '—')}<br>${esc(confirmed.reviewAdjudication.authorizationText || '')}</p>` : ''}</div>
    <div class="review-panel"><h3>指定版本操作</h3><p class="field-note">确认只针对当前任务、当前目标与这个候选版本；办公室不会自动应用、提交或合并。</p>${preparationFailureStatus}${reviewRoundStatus}${reviewEvidence}<div class="button-stack">${reconnectReviewAction}${reviewRoundAction}${reviewAction}${canConfirm ? '<button class="primary-button" type="button" data-action="native-confirm">确认这个指定版本</button>' : !confirmed && !canAdjudicateConfirm ? '<button class="secondary-button" type="button" disabled>审阅通过且确认接口可用后才能确认</button>' : ''}${patchHref ? `<a class="export-link" href="${esc(patchHref)}">下载已确认 patch</a>` : ''}${zipHref ? `<a class="export-link" href="${esc(zipHref)}">下载完整工具 ZIP</a>` : ''}${native.links.nativeTask ? `<a class="secondary-button" href="${esc(native.links.nativeTask)}">打开原生任务</a>` : ''}</div>${confirmed ? `<p class="field-note">approval ${esc(confirmed.approvalId || '—')}<br>artifact version ${esc(confirmed.artifactVersion ?? '—')}<br>goal ${esc(confirmed.goalVersionId || '—')}</p>` : ''}</div>${adjudicationForm}${previewPanel}
    <div class="review-panel"><h3>继续修改</h3><p class="field-note">普通补充与正式退回分开保存。正式退回会绑定当前候选 ID/版本，并使旧执行绑定失效；不会用聊天输入冒充。</p>${native.native?.actions.canRevise && candidate ? `<form data-native-revise data-revise-binding="${esc(binding || '')}"><label>退回修改原因（最多 2000 UTF-8 字节）<textarea name="reason" rows="5" maxlength="2000" required placeholder="准确写出这个版本需要修改什么"></textarea></label><button class="danger-button" type="submit">退回这个指定版本</button></form>` : native.native?.actions.canRevise ? '<p class="field-note">先读取并核对当前版本的真实差异，才能正式退回。</p>' : ''}<div class="button-stack">${native.native?.actions.canInstructions ? '<button class="secondary-button" type="button" data-open-dialog="suggestion-dialog">补充普通工作要求</button>' : ''}${native.native?.actions.canMaterials ? '<button class="secondary-button" type="button" data-open-dialog="material-dialog">加入文本材料</button>' : ''}<button class="secondary-button" type="button" data-view-target="desk">查看任务状态</button></div></div>
  </aside></div>`);
}

function renderReview() {
  const root = $('#review-content');
  const task = state.task;
  if (nativeMode()) {
    renderNativeReview(root);
    return;
  }
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
  if (nativeBlocked()) {
    root.innerHTML = `<p class="empty-ledger">${esc(state.nativeError || 'OpenOffice 状态无法核对。')}</p>`;
    return;
  }
  if (nativeMode()) {
    if (state.nativeProduct.setupOnly) {
      const projects = state.nativeProduct.setup?.projects || [];
      const projectSummary = projects.length
        ? projects.map((project) => `${esc(project.label)} · ${esc(project.projectId)}`).join('<br>')
        : '当前没有可选项';
      root.innerHTML = `<section class="connection-row"><span class="connection-number">01</span><h2>OpenOffice 统一入口</h2><p>初始化状态已读取；当前尚未建立任务，因此没有执行、产品登记或候选成果。</p><div class="connection-state"><b>等待建立任务</b><small>waiting_task</small></div></section><section class="connection-row"><span class="connection-number">02</span><h2>已登记项目</h2><p>项目范围必须来自后台登记，不允许前端自行填写路径。</p><div class="connection-state"><b>${projectSummary}</b><small>${projects.length ? `后台返回 ${projects.length} 项` : '不会虚构项目'}</small></div></section>`;
      return;
    }
    const product = state.nativeProduct.product;
    const labels = { canRun: '启动', canApprovePlan: '批准计划', canReview: '审阅', canOpenReviewRound: '开启后续审阅轮', canInspectDiff: '查看差异', canRevise: '退回修订', canConfirm: '确认', canPreview: '预览', canGoal: '替换目标', canScope: '选择项目范围', canAuthorizeScope: '授权项目范围', canPause: '暂停', canCancel: '取消', canContinue: '继续', canChat: '同事对话', canInstructions: '工作要求', canMaterials: '文本材料' };
    const enabled = Object.entries(state.nativeProduct.native?.actions || {}).filter(([, value]) => value === true).map(([key]) => labels[key]).filter(Boolean);
    root.innerHTML = `<section class="connection-row"><span class="connection-number">01</span><h2>OpenOffice 原生执行</h2><p>办公室正在读取同一任务的原生状态、真实团队、工作项、候选、审阅和确认信息。</p><div class="connection-state"><b>状态投影已接通</b><small>${esc(product?.projectId || state.nativeProduct.taskId)}</small></div></section><section class="connection-row"><span class="connection-number">02</span><h2>当前可用动作</h2><p>动作资格由后台按当前目标、执行、产品登记与预算逐项给出；缺字段时保持不可用。</p><div class="connection-state"><b>${enabled.length ? esc(enabled.join('、')) : '当前没有开放动作'}</b><small>不会回退到旧接口</small></div></section>`;
    return;
  }
  if (!state.connections.length) { root.innerHTML = '<p class="empty-ledger">正在检查本机能力…</p>'; return; }
  root.innerHTML = state.connections.map((item, index) => {
    const status = !item.available ? '未连接'
      : item.id === 'codex-cli' ? item.verified ? '真实生成已验证' : item.runtimeVerified ? '程序可启动 · 生成未验证' : '已发现 · 未验证'
        : item.id === 'demo' ? '演示流程可用' : item.verified ? '可用 · 已核对' : '已发现 · 未验证';
    return `<section class="connection-row"><span class="connection-number">${String(index + 1).padStart(2,'0')}</span><h2>${esc(item.label)}</h2><p>${esc(item.boundary)}</p><div class="connection-state"><b>${status}</b><small>${esc(item.id)}</small>${item.id === 'codex-cli' && item.available ? '<button class="text-button" type="button" data-action="verify-codex">检查程序</button>' : ''}</div></section>`;
  }).join('');
}

function renderAll() {
  setBackendUi();
  if (nativeBlocked()) {
    renderNativeBlocked();
    if (state.view === 'connections') $('#connection-list').innerHTML = `<p class="empty-ledger">${esc(state.nativeError || 'OpenOffice 状态无法核对。')}</p>`;
    managePolling();
    return;
  }
  renderTaskList();
  renderOffice();
  renderDesk();
  renderReview();
  if ($('#coworker-dialog').open) renderCoworkerConversation();
  if (state.view === 'connections') renderConnections();
  managePolling();
}

async function loadTasks({ preserve = true } = {}) {
  if (state.backendMode === 'openoffice-loading') {
    try {
      await loadNativeTaskHistory();
      const native = await readNativeProduct();
      if (!native) throw new Error('统一入口没有提供 OpenOffice 产品状态；不会回退到旧任务接口。');
      applyNativeProduct(native);
      renderAll();
      setView(state.view);
      return;
    } catch (error) {
      state.backendMode = 'openoffice-blocked';
      state.nativeError = error.message;
      state.task = null;
      state.tasks = [];
      setBackendUi();
      renderAll();
      setView(state.view);
      return;
    }
  }
  if (nativeMode()) {
    await loadNativeTaskHistory();
    await refreshNativeProduct({ silent: false });
    setView(state.view);
    return;
  }
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

async function refreshNativeProduct({ silent = true, poll = false } = {}) {
  if (state.nativeTaskHistory?.selecting) return;
  if (poll && state.nativeRefreshesInFlight > 0) return;
  const generation = ++state.nativeRefreshGeneration;
  state.nativeRefreshesInFlight += 1;
  try {
    if (nativeMode() && state.nativeTaskHistory && Date.now() - state.nativeTaskHistoryLoadedAt > 15_000) await loadNativeTaskHistory();
    const native = await readNativeProduct();
    if (generation !== state.nativeRefreshGeneration) return;
    if (!native) throw new Error('统一入口不再提供 OpenOffice 产品状态。');
    applyNativeProduct(native);
    renderAll();
  } catch (error) {
    if (generation !== state.nativeRefreshGeneration) return;
    state.backendMode = 'openoffice-blocked';
    state.nativeError = error.message;
    state.nativeProduct = null;
    state.task = null;
    state.tasks = [];
    setBackendUi();
    renderAll();
    if (!silent) announce(error.message, 'error');
  } finally {
    state.nativeRefreshesInFlight -= 1;
  }
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
  if (nativeMode() || nativeBlocked()) {
    if (!state.pollTimer) state.pollTimer = setInterval(() => refreshNativeProduct({ silent: true, poll: true }), 1700);
    return;
  }
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
  if (nativeMode() || nativeBlocked()) { renderConnections(); return; }
  try { state.connections = (await api('/api/connections')).connections; renderConnections(); }
  catch (error) { announce(error.message, 'error'); }
}

function openDialog(id, functionId = '') {
  const canCreateTask = canCreateNativeTask(state.nativeProduct, state.backendMode);
  const unavailable = nativeBlocked() && ['task-dialog', 'material-dialog', 'suggestion-dialog'].includes(id)
    || nativeMode() && id === 'task-dialog' && !canCreateTask;
  if (unavailable) {
    announce('这个动作尚未接到 OpenOffice 统一入口；没有调用旧任务接口。', 'error');
    return;
  }
  const dialog = document.getElementById(id);
  if (id === 'task-dialog') setTaskFunction(functionId);
  if (dialog && !dialog.open) dialog.showModal();
}

function closeDialog(button) {
  button.closest('dialog')?.close();
}

async function postTaskAction(action, body = {}) {
  if (nativeMode() || nativeBlocked()) throw new Error('这个动作尚未接到 OpenOffice 统一入口；没有调用旧任务接口。');
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
  const gameFile = event.target.closest('[data-game-file]');
  if (gameFile) {
    try { await openGameWorkspaceFile(gameFile.dataset.gameFile, gameFile.dataset.gameView); }
    catch (error) { announce(error.message, 'error'); }
    return;
  }
  const gameAction = event.target.closest('[data-action]')?.dataset.action;
  if (gameAction === 'game-workbench-back') {
    state.gameWorkspaceRequestSeq += 1;
    state.gameWorkshopTaskId = null;
    state.gameWorkspaceLoading = false;
    state.gameWorkspaceError = null;
    state.gameWorkspaceData = null;
    state.gameWorkspaceFile = null;
    state.gameWorkspaceFilePath = null;
    renderAll();
    return;
  }
  if (gameAction === 'game-workspace-refresh') {
    try { await loadGameWorkspace(); }
    catch (error) { announce(error.message, 'error'); }
    return;
  }
  const memoryCancel = event.target.closest('[data-memory-cancel]');
  if (memoryCancel) { state.nativeMemoryDraft = null; renderAll(); return; }
  const memoryEditId = event.target.closest('[data-memory-edit]')?.dataset.memoryEdit;
  if (memoryEditId) {
    const native = state.nativeProduct;
    const entry = native?.memory?.entries.find((item) => item.id === memoryEditId);
    if (!entry) { announce('这条记忆已变化，请刷新后再修正。', 'error'); return; }
    state.nativeMemoryDraft = { binding: `${native.taskId}:${native.goalVersionId}`, memoryId: entry.id, expectedRevision: entry.revision,
      scopeType: entry.scopeType, kind: entry.kind, title: entry.title, text: entry.text };
    renderAll(); return;
  }
  const memoryDeactivate = event.target.closest('[data-memory-deactivate]')?.dataset.memoryDeactivate;
  const memoryDelete = event.target.closest('[data-memory-delete]')?.dataset.memoryDelete;
  if (memoryDeactivate || memoryDelete) {
    const id = memoryDeactivate || memoryDelete;
    const entry = state.nativeProduct?.memory?.entries.find((item) => item.id === id);
    if (!entry) { announce('这条记忆已变化，请刷新后再操作。', 'error'); return; }
    if (memoryDelete && !window.confirm(`删除“${entry.title}”？这会保留审计历史，但之后不会再被检索。`)) return;
    try {
      const result = await postNativeAction('memory_change', { memoryId: entry.id, operation: memoryDelete ? 'delete' : 'deactivate', expectedRevision: entry.revision });
      state.nativeMemoryDraft = null;
    announce(result.index?.indexed ? (memoryDelete ? '记忆已删除并从索引移除。' : '记忆已停用并从索引移除。') : '记忆状态已保存；索引当前未同步，旧命中仍会被任务记录过滤。', result.index?.indexed ? 'normal' : 'error');
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
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
  if (openButton) { openDialog(openButton.dataset.openDialog, openButton.dataset.functionId || ''); return; }
  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) { closeDialog(closeButton); return; }
  const nativeTaskButton = event.target.closest('[data-native-task-id]');
  if (nativeTaskButton) {
    await selectNativeTask(nativeTaskButton.dataset.nativeTaskId);
    return;
  }
  const taskButton = event.target.closest('[data-task-id]');
  if (taskButton) {
    if (nativeMode()) return;
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
    if (action === 'retry-native') {
      state.backendMode = 'openoffice';
      await refreshNativeProduct({ silent: false });
      return;
    }
    if (action === 'native-confirm') {
      const native = state.nativeProduct;
      const artifact = native?.artifact;
      if (!native?.current || !native.native?.actions.canConfirm || !artifact?.id || !artifact.review?.passed || artifact.confirmation || !native.links.confirm || !nativeCandidateMatches(native)) throw new Error('请先读取并核对当前版本的真实差异与文件，再确认候选。');
      if (!window.confirm(`只确认 OpenOffice 候选版本 ${artifact.version ?? '—'} 吗？\n\n这不会自动应用、提交、合并或发布。`)) return;
      await api(native.links.confirm, { method: 'POST', body: JSON.stringify({ artifactId: artifact.id, version: artifact.version }) });
      await refreshNativeProduct({ silent: false });
      announce('OpenOffice 指定版本已确认；现在可以下载同一份已确认 patch。');
      return;
    }
    if (action === 'native-adjudicate-confirm') {
      const native = state.nativeProduct;
      const artifact = native?.artifact;
      const review = artifact?.review;
      const currentCandidate = state.nativeCandidate;
      const binding = nativeReviewBinding(native);
      const control = event.target.closest('[data-action="native-adjudicate-confirm"]');
      const reason = $('#native-review-adjudication-reason')?.value?.trim() || '';
      const authorizationSourceThreadId = $('[data-native-adjudication-source-thread]')?.value?.trim() || '';
      const authorizationText = $('[data-native-adjudication-source-text]')?.value?.trim() || '';
      const byteLength = new TextEncoder().encode(reason).length;
      if (!native?.current || native.native?.actions.canAdjudicateConfirm !== true || control?.dataset.reviewBinding !== binding
        || !artifact?.id || review?.passed !== false || review.nativeVerdict !== 'FAIL' || !review.id
        || !/^[a-f0-9]{64}$/.test(review.fullOutputSha256 || '') || artifact.confirmation || !native.links.confirm
        || !nativeCandidateMatches(native) || currentCandidate?.review?.id !== review.id
        || currentCandidate.review.passed !== false || currentCandidate.review.nativeVerdict !== 'FAIL'
        || currentCandidate.review.fullOutputSha256 !== review.fullOutputSha256 || !currentCandidate.review.text?.trim()
        || !reason || byteLength > 1000
        || !authorizationSourceThreadId || new TextEncoder().encode(authorizationSourceThreadId).length > 160
        || !authorizationText || new TextEncoder().encode(authorizationText).length > 1000) {
        throw new Error('当前 FAIL 裁决表单已过期，或理由为空/超过 1000 UTF-8 字节；请刷新并重新核对。');
      }
      if (!window.confirm(`Reviewer 的 FAIL 会原样保留。你将仅对候选 v${artifact.version} 记录人工裁决并确认，不会把审阅改为 PASS。继续吗？\n\n裁决理由：${reason}`)) return;
      await api(native.links.confirm, { method: 'POST', body: JSON.stringify({ artifactId: artifact.id, version: artifact.version,
        expectedTaskId: native.taskId, expectedExecutionId: native.execution?.id,
        expectedReviewId: review.id, expectedReviewFullOutputSha256: review.fullOutputSha256,
        expectedCandidateSha256: artifact.candidateSha256, adjudicationReason: reason,
        authorizationSourceThreadId, authorizationText }) });
      await refreshNativeProduct({ silent: false });
      announce('人工裁决和确认已记录；原始 Reviewer FAIL 仍保留。');
      return;
    }
    if (action === 'native-review') {
      const native = state.nativeProduct;
      const artifact = native?.artifact;
      const binding = nativeReviewBinding(native);
      const control = event.target.closest('[data-action="native-review"]');
      if (!canReviewNativeCandidate(native) || !binding || control?.dataset.nativeReviewBinding !== binding
        || state.nativeReviewPending?.binding === binding) throw new Error('当前候选已变化，或后台尚未开放这个版本的独立审阅。');
      const review = artifact.review;
      state.nativeReviewPending = {
        binding,
        previousReview: JSON.stringify([review?.id || null, review?.passed ?? null, review?.nativeVerdict || null, review?.scopeOutcome || null]),
        knownPreparationAttemptIds: (native.native?.preparationFailures || []).map((item) => item.attemptId),
      };
      renderReview();
      try {
        const evidenceDraft = state.nativeReviewEvidenceDraft;
        const currentRoundId = native.native?.reviewRound?.id || null;
        const evidence = evidenceDraft?.binding === binding && evidenceDraft?.roundId === currentRoundId
          ? evidenceDraft.text.trim() : '';
        if (new TextEncoder().encode(evidence).length > 512) throw new Error('补充审阅证据不能超过 512 UTF-8 字节。');
        if (evidence && native.native?.reviewRound?.status !== 'open') throw new Error('补充审阅证据仅能用于已开启的同候选审阅轮。');
        await postNativeAction('review', evidence ? { reviewEvidence: evidence } : {});
        if (state.nativeReviewEvidenceDraft?.binding === binding && state.nativeReviewEvidenceDraft?.roundId === currentRoundId) {
          state.nativeReviewEvidenceDraft = null;
        }
        announce(`已将候选 v${artifact.version} 提交给 OpenOffice 独立 Reviewer；原审阅记录保留，待新结果返回。`);
      } catch (error) {
        if (state.nativeReviewPending?.binding === binding) state.nativeReviewPending = null;
        throw error;
      } finally {
        renderReview();
      }
      return;
    }
    if (action === 'native-open-review-round') {
      const native = state.nativeProduct;
      const artifact = native?.artifact;
      const binding = nativeReviewBinding(native);
      const control = event.target.closest('[data-action="native-open-review-round"]');
      if (!native?.current || native.native?.actions?.canOpenReviewRound !== true || !artifact?.id || !binding
        || control?.dataset.nativeReviewBinding !== binding
        || state.nativeReviewRoundPending?.binding === binding) {
        throw new Error('当前候选绑定已变化，后台没有开放新一轮。');
      }
      state.nativeReviewRoundPending = { binding };
      renderReview();
      try {
        const result = await postNativeAction('open_review_round');
        announce(`已为同一候选开启一次只读后续审阅轮，截止 ${result.deadlineAt || '20 分钟内'}；尚未调用模型。`);
      } catch (error) {
        if (state.nativeReviewRoundPending?.binding === binding) state.nativeReviewRoundPending = null;
        throw error;
      } finally {
        state.nativeReviewRoundPending = null;
        renderReview();
      }
      return;
    }
    if (action === 'native-reconnect-review-runtime') {
      const native = state.nativeProduct;
      const artifact = native?.artifact;
      const binding = nativeReviewBinding(native);
      const control = event.target.closest('[data-action="native-reconnect-review-runtime"]');
      if (!native?.current || native.native?.actions?.canReconnectReview !== true || !artifact?.id
        || artifact.review?.passed === true || artifact.confirmation || !binding
        || control?.dataset.nativeReviewBinding !== binding) {
        throw new Error('当前候选绑定已变化，后台没有开放原运行环境重连。');
      }
      await postNativeAction('reconnect_review_runtime');
      announce('已按同一目标、范围、执行与候选接回原生审阅环境；没有新建执行或启动模型。');
      return;
    }
    if (action === 'native-inspect-candidate') {
      await loadNativeCandidate();
      announce('已读取当前版本的真实文件清单、固定检查和完整差异。');
      return;
    }
    if (action === 'native-preview') {
      const native = state.nativeProduct;
      const entry = document.querySelector('#native-preview-entry')?.value;
      if (!entry || !native?.native?.actions.canPreview || !native.current || !native.artifact?.candidateSha256) throw new Error('当前目标或候选不允许生成预览。');
      await postNativeAction('preview', { entry });
      announce('预览请求已接受；就绪后才会显示可打开的链接。');
      return;
    }
    if (action === 'native-approve-plan') {
      const native = state.nativeProduct;
      const expectedPlanSha256 = native?.native?.bindingCurrent === true ? native.native?.plan?.sha256 : null;
      if (!native?.native?.actions.canApprovePlan || !expectedPlanSha256 || !nativeActionBound(native)) throw new Error('当前没有等待明确批准且绑定有效的 Lead 计划。');
      if (!window.confirm('批准当前 OpenOffice Lead 的计划并进入下一阶段吗？\n\n后台会再次核对当前目标、执行与登记绑定。')) return;
      await postNativeAction('approve_plan', { expectedPlanSha256 });
      announce('已批准当前 Lead 计划；办公室会按真实执行状态继续更新。');
      return;
    }
    if (action === 'native-run') {
      await requestNativeRun();
      return;
    }
    if (action === 'native-prepare-run') {
      await requestNativePrepareRun();
      return;
    }
    if (action === 'native-restore-confirmed') {
      await requestNativeRestoreCurrentResult();
      return;
    }
    if (action === 'native-cancel') {
      await requestNativeCancel();
      return;
    }
    if (action === 'native-resume') {
      await requestNativeContinue();
      return;
    }
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

$('#native-task-search')?.addEventListener('input', (event) => {
  state.nativeTaskFilter.query = event.target.value;
  renderTaskList();
});
$('#native-task-project')?.addEventListener('change', (event) => {
  state.nativeTaskFilter.projectId = event.target.value;
  renderTaskList();
});

function captureNativeMemoryDraft(form) {
  const native = state.nativeProduct;
  const binding = form?.dataset.memoryBinding;
  if (!native?.taskId || binding !== `${native.taskId}:${native.goalVersionId}`) return;
  const data = new FormData(form);
  state.nativeMemoryDraft = { ...(state.nativeMemoryDraft?.binding === binding ? state.nativeMemoryDraft : {}), binding,
    scopeType: String(data.get('scopeType') || 'global'), kind: String(data.get('kind') || 'preference'),
    title: String(data.get('title') || ''), text: String(data.get('text') || '') };
}

document.addEventListener('input', (event) => {
  if (event.target.matches('[data-native-review-evidence]')) {
    state.nativeReviewEvidenceDraft = { binding: event.target.dataset.reviewBinding,
      roundId: event.target.dataset.reviewRoundId || null, text: event.target.value };
    return;
  }
  if (event.target.matches('[data-native-adjudication-reason], [data-native-adjudication-source-thread], [data-native-adjudication-source-text]')) {
    const native = state.nativeProduct;
    const review = native?.artifact?.review;
    const binding = nativeReviewBinding(native);
    if (binding !== event.target.dataset.reviewBinding || !review?.id || !review.fullOutputSha256) return;
    const prior = state.nativeReviewAdjudicationDraft?.binding === binding
      && state.nativeReviewAdjudicationDraft?.reviewId === review.id
      && state.nativeReviewAdjudicationDraft?.reviewFullOutputSha256 === review.fullOutputSha256
      ? state.nativeReviewAdjudicationDraft : {};
    state.nativeReviewAdjudicationDraft = { ...prior, binding, reviewId: review.id,
      reviewFullOutputSha256: review.fullOutputSha256,
      reason: event.target.matches('[data-native-adjudication-reason]') ? event.target.value : prior.reason || '',
      authorizationSourceThreadId: event.target.matches('[data-native-adjudication-source-thread]') ? event.target.value : prior.authorizationSourceThreadId || '',
      authorizationText: event.target.matches('[data-native-adjudication-source-text]') ? event.target.value : prior.authorizationText || '' };
    return;
  }
  const form = event.target.closest('form[data-native-memory]');
  if (form) captureNativeMemoryDraft(form);
});

document.addEventListener('change', (event) => {
  const form = event.target.closest('form[data-native-memory]');
  if (form) {
    if (event.target.name === 'scopeType' && !state.nativeMemoryDraft?.memoryId && form.elements.kind) {
      form.elements.kind.value = event.target.value === 'project' ? 'convention' : 'preference';
    }
    captureNativeMemoryDraft(form);
  }
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
  const memoryForm = event.target.closest('form[data-native-memory]');
  if (memoryForm) {
    event.preventDefault();
    const native = state.nativeProduct;
    const draft = state.nativeMemoryDraft;
    const data = new FormData(memoryForm);
    const title = String(data.get('title') || '').trim();
    const text = String(data.get('text') || '').trim();
    const kind = String(data.get('kind') || 'preference');
    const scopeType = String(data.get('scopeType') || 'global');
    if (!native?.taskId || !native.authorityCurrent || !title || !text || text.length > 4000) { announce('请填写记忆标题和内容；当前任务目标绑定必须有效。', 'error'); return; }
    try {
      let result;
      if (draft?.memoryId) {
        if (draft.binding !== `${native.taskId}:${native.goalVersionId}` || !Number.isInteger(draft.expectedRevision)) throw new Error('修正草稿已绑定旧任务版本，请重新打开记忆。');
        result = await postNativeAction('memory_change', { memoryId: draft.memoryId, operation: 'correct', expectedRevision: draft.expectedRevision, kind, title, text });
      } else {
        result = await postNativeAction('memory_save', { scopeType, kind, title, text });
      }
      state.nativeMemoryDraft = null;
      announce(result.index?.indexed ? (draft?.memoryId ? '已保存这条记忆的新版本。' : '已明确保存长期记忆。') : '任务记录已保存；XERJ 索引未同步，后续会按当前记录过滤旧命中。', result.index?.indexed ? 'normal' : 'error');
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  const nativeReviseForm = event.target.closest('[data-native-revise]');
  if (nativeReviseForm) {
    event.preventDefault();
    const native = state.nativeProduct;
    const artifact = native?.artifact;
    const reason = String(new FormData(nativeReviseForm).get('reason') || '').trim();
    if (!native?.current || !native.native?.actions.canRevise || !artifact?.id || artifact.confirmation || !nativeActionBound(native) || !nativeCandidateMatches(native)) {
      announce('当前候选没有可核对的正式退回资格。', 'error'); return;
    }
    if (!reason || new TextEncoder().encode(reason).length > 2000) { announce('退回原因需为 1–2000 个 UTF-8 字节；请精简后重试，当前输入已保留。', 'error'); return; }
    if (!window.confirm(`退回 OpenOffice 候选版本 ${artifact.version ?? '—'} 并要求按这条原因修改吗？\n\n旧候选和审阅会保留为历史，当前执行绑定需要重新准备。`)) return;
    try {
      await postNativeAction('revise', { expectedArtifactId: artifact.id, expectedArtifactVersion: artifact.version, reason });
      state.nativeCandidate = null;
      state.nativeCandidateError = null;
      announce('已正式退回当前指定版本；原因已保存，下一轮必须按更新后的输入重新准备。');
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  const nativeScopeForm = event.target.closest('[data-native-scope]');
  if (nativeScopeForm) {
    event.preventDefault();
    const projectId = String(new FormData(nativeScopeForm).get('projectId') || '');
    const project = state.nativeProduct?.setup?.projects.find((item) => item.projectId === projectId && item.current);
    if (!state.nativeProduct?.native?.actions.canScope || !project) { announce('当前没有可选择的有效登记范围。', 'error'); return; }
    try {
      await postNativeAction('scope', { projectId: project.projectId, expectedScopeFingerprint: project.scopeFingerprint });
      announce('项目范围已选择；这还不是授权，也没有启动执行。');
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  const nativeAuthorizeForm = event.target.closest('[data-native-authorize-scope]');
  if (nativeAuthorizeForm) {
    event.preventDefault();
    const native = state.nativeProduct;
    const project = native?.setup?.selectedProject;
    const scope = native?.setup?.selectedScope;
    if (!native?.native?.actions.canAuthorizeScope || !project?.projectId || !scope?.scopeFingerprint || !scope.current) { announce('后台尚未开放当前范围的授权动作。', 'error'); return; }
    if (!window.confirm('授权这个后台登记的有限项目范围吗？\n\n授权不会自动确认、合并或发布成果。')) return;
    try {
      await postNativeAction('authorize_scope', { projectId: project.projectId, expectedScopeFingerprint: scope.scopeFingerprint });
      announce('有限项目范围已提交授权；办公室会读取后台返回的实际 registry 与执行绑定。');
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  const nativeGoalForm = event.target.closest('[data-native-goal]');
  if (nativeGoalForm) {
    event.preventDefault();
    const data = new FormData(nativeGoalForm);
    const body = {
      statement: String(data.get('statement') || '').trim(),
      successCriteria: String(data.get('successCriteria') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
      boundaries: String(data.get('boundaries') || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean),
    };
    if (!body.statement || !body.successCriteria.length || !body.boundaries.length) { announce('请完整填写新版目标、成功条件和工作边界。', 'error'); return; }
    if (!window.confirm('接受这份完整新版目标吗？\n\n当前执行、候选与确认资格会按新版重新核对，旧记录仍保留为历史。')) return;
    try {
      if (!state.nativeProduct?.native?.actions.canGoal) throw new Error('后台没有确认当前任务可以替换目标。');
      await postNativeAction('goal', body);
      announce('完整新版目标已交给当前任务；旧执行与旧候选不会冒充新版结果。');
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
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

let utilityTaskSubmissionPending = false;

$('#task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const element = event.currentTarget;
  const isUtilitySubmission = nativeMode() && element.elements.functionId.value === 'utility';
  if (isUtilitySubmission && utilityTaskSubmissionPending) return;
  const submitButton = isUtilitySubmission ? element.querySelector('[type="submit"]') : null;
  if (isUtilitySubmission) { utilityTaskSubmissionPending = true; submitButton.disabled = true; }
  try {
  const form = new FormData(element);
  const body = Object.fromEntries(form);
  if (nativeBlocked()) { announce('OpenOffice 初始化状态不可核对，不能建立任务。', 'error'); return; }
  if (nativeMode()) {
    if (!canCreateNativeTask(state.nativeProduct, state.backendMode)) { announce('当前执行尚未结束，或后台没有提供原生任务创建入口。', 'error'); return; }
    let projectId = '';
    let projectScopeFingerprint = '';
    if (body.functionId === 'utility') {
      if (!saveUtilityTaskDraft()) { announce('浏览器暂时无法保存这份任务草稿；为避免重复创建工程，请先释放本地存储空间后重试。', 'error'); return; }
      try {
        if (body.projectMode === 'new') {
          const requestId = body.projectRequestId || crypto.randomUUID();
          element.elements.projectRequestId.value = requestId;
          if (!saveUtilityTaskDraft()) throw new Error('本地草稿保存失败；没有提交工程创建请求。');
          const created = await api('/api/product/projects', { method: 'POST', body: JSON.stringify({ name: body.projectName, requestId }) });
          projectId = created.project?.projectId || '';
          projectScopeFingerprint = created.project?.scopeFingerprint || '';
          if (!projectId || !/^[a-f0-9]{64}$/.test(projectScopeFingerprint)) throw new Error('工程已登记，但后台没有返回可核对的当前范围；草稿已保留，请刷新项目列表后继续。');
          let option = [...element.elements.existingProjectId.options].find((item) => item.value === projectId);
          if (!option) {
            option = new Option(`${created.project.label} · ${created.project.location}`, projectId);
            option.dataset.scopeFingerprint = projectScopeFingerprint;
            element.elements.existingProjectId.add(option);
          }
          option.dataset.scopeFingerprint = projectScopeFingerprint;
          option.textContent = `${created.project.label} · ${created.project.location}`;
          element.elements.existingProjectId.value = projectId;
          element.querySelector('[name="projectMode"][value="existing"]').checked = true;
          updateUtilityProjectMode();
          element.elements.projectRequestId.value = requestId;
          element.elements.projectName.value = body.projectName;
          if (!saveUtilityTaskDraft()) throw new Error('工程已登记；本地草稿无法保存，请不要重新新建，刷新登记工程后再接着建立任务。');
        } else {
          projectId = body.existingProjectId || '';
          const selected = [...element.elements.existingProjectId.options].find((option) => option.value === projectId);
          projectScopeFingerprint = selected?.dataset.scopeFingerprint || '';
          if (!projectId || !/^[a-f0-9]{64}$/.test(projectScopeFingerprint)) throw new Error('请选择一个当前可用的登记工程；项目选择不会代替范围授权。');
        }
      } catch (error) { announce(error.message, 'error'); return; }
    }
    if (body.functionId === 'utility') {
      const requestId = body.taskCreationRequestId || crypto.randomUUID();
      element.elements.taskCreationRequestId.value = requestId;
      if (!saveUtilityTaskDraft()) { announce('任务草稿无法保存在本地；没有提交任务，请释放本地存储空间后重试。', 'error'); return; }
    }
    const input = normalizeNativeTaskDraft({ ...body, statement: body.goal,
      ...(body.functionId === 'utility' ? { projectId, projectScopeFingerprint } : {}) });
    if (body.functionId === 'utility') input.taskCreationRequestId = element.elements.taskCreationRequestId.value;
    if (!input.statement) { announce('请先写下最终目标。', 'error'); return; }
    try {
      await api(state.nativeProduct.links.createTask, { method: 'POST', body: JSON.stringify(input) });
      if (body.functionId === 'utility') localStorage.removeItem(UTILITY_TASK_DRAFT_KEY);
      element.reset();
      element.closest('dialog').close();
      await refreshNativeProduct({ silent: false });
      setView('desk');
      announce(body.functionId === 'utility'
        ? '工具任务已建立并选定工程；当前只完成范围选择，尚未授权写入，也没有启动执行。'
        : '原生任务已建立；尚未填写的成功条件和边界保持为空。');
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
  if (body.type === 'project') body.provider = 'codex-cli';
  delete body.functionId;
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
  } finally {
    if (isUtilitySubmission) { utilityTaskSubmissionPending = false; submitButton.disabled = false; }
  }
});

$('#suggestion-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const element = event.currentTarget;
  const body = Object.fromEntries(new FormData(element));
  if (nativeBlocked()) { announce('OpenOffice 状态不可核对，不能提交工作要求。', 'error'); return; }
  if (nativeMode()) {
    if (!state.nativeProduct?.native?.actions.canInstructions) { announce('后台没有确认当前任务可以补充工作要求。', 'error'); return; }
    try {
      await postNativeAction('instructions', { text: String(body.text || '').trim() });
      element.reset();
      element.closest('dialog').close();
      announce('工作要求已写入当前原生任务；它不会静默替换目标。');
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
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
  if (nativeBlocked()) { announce('OpenOffice 状态不可核对，不能发送讨论。', 'error'); return; }
  if (!state.task) { $('#coworker-dialog').close(); openDialog('task-dialog'); announce('先建立目标，再把工作交给同事。'); return; }
  const element = event.currentTarget;
  const data = Object.fromEntries(new FormData(element));
  if (nativeMode()) {
    if (data.intent !== 'progress') {
      announce('原生同事对话只用于只读讨论；工作要求请到任务书桌补充，成果退回请到审阅台操作。', 'error');
      return;
    }
    const chat = nativeChatContext();
    const text = String(data.text || '').trim();
    if (!chat.canSend || !chat.member?.id) { announce('后台尚未开放当前真实成员的模型讨论资格。', 'error'); return; }
    if (!text) { announce('请先填写讨论内容。', 'error'); return; }
    try {
      element.querySelector('[type="submit"]').disabled = true;
      $('#coworker-message').disabled = true;
      $('#coworker-intent').disabled = true;
      await postNativeAction('chat', { text, agentId: chat.member.id });
      $('#coworker-message').value = '';
      renderCoworkerConversation();
      announce('讨论已绑定当前任务、目标与真实同事；它不会自动变成工作交代。');
    } catch (error) { announce(error.message, 'error'); }
    finally { renderCoworkerConversation(); }
    return;
  }
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
  if (nativeMode() || nativeBlocked()) { announce('原生对话与取消接口尚未接通。', 'error'); return; }
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
  if (nativeBlocked()) { announce('OpenOffice 状态不可核对，不能补充材料。', 'error'); return; }
  if (nativeMode()) {
    if (!state.nativeProduct?.native?.actions.canMaterials) { announce('后台没有确认当前任务可以补充材料。', 'error'); return; }
    const name = String(form.get('name') || '').trim();
    const text = String(form.get('text') || '').trim();
    if (!name || !text) { announce('请填写材料名称和正文。', 'error'); return; }
    try {
      await postNativeAction('materials', { name, kind: 'text', text });
      element.reset();
      element.closest('dialog').close();
      announce(`${name} 已进入当前原生任务的材料记录。`);
    } catch (error) { announce(error.message, 'error'); }
    return;
  }
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

$('#task-dialog').addEventListener('close', () => {
  $('#task-form').reset();
  setTaskFunction('');
});

function invalidateUtilityCreationRequestsOnEdit(event) {
  const draft = utilityTaskDraft();
  if (event.target.name === 'projectName' && event.target.value !== utilityTaskDraft().projectName) {
    $('#task-form').elements.projectRequestId.value = '';
    $('#task-form').elements.taskCreationRequestId.value = '';
  } else if (['title', 'goal', 'successCriteria', 'boundaries', 'existingProjectId', 'projectMode'].includes(event.target.name)
    && event.target.value !== draft[event.target.name]) {
    $('#task-form').elements.taskCreationRequestId.value = '';
  }
}

$('#task-form').addEventListener('input', (event) => {
  invalidateUtilityCreationRequestsOnEdit(event);
  saveUtilityTaskDraft();
});
$('#task-form').addEventListener('change', (event) => {
  invalidateUtilityCreationRequestsOnEdit(event);
  if (event.target.name === 'projectMode') updateUtilityProjectMode();
  saveUtilityTaskDraft();
});

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
  const officeRole = detail.stationRole || detail.officeRole || detail.role;
  const assigned = !detail.dynamic ? state.task?.team?.agents?.find((agent) => agent.stationRole === detail.role && agent.goalVersionId === activeGoal()?.id) : null;
  if (assigned) detail = { ...detail, officeRole, agentId: assigned.id, role: assigned.roleKey, stationRole: assigned.stationRole, name: `${assigned.name}（${detail.name}工位）`, dynamic: true };
  else detail = { ...detail, officeRole };
  state.coworker = detail;
  state.conversationMessages = [];
  $('#coworker-role').textContent = ROLE_LABEL[officeRole] || ROLE_LABEL[detail.role] || detail.role;
  $('#coworker-name').textContent = `与${detail.name}交谈`;
  $('#coworker-status').textContent = `当前状态：${detail.status}。对话已打开；靠近情况以办公室画面为准，现在就可以输入。`;
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
window.addEventListener('irixi:arrival', () => {
  const canTalk = officeFunctionForCoworker(state.coworker) === 'learning' || !nativeMode() || nativeChatContext().canSend;
  $('#coworker-status').textContent = canTalk ? 'Irixi 已经走到同事身边。输入期间移动键保持锁定。' : 'Irixi 已经走到同事身边；当前只显示真实历史，不会启动模型回复。';
});
window.addEventListener('irixi:unreachable', (event) => {
  const canTalk = officeFunctionForCoworker(state.coworker) === 'learning' || !nativeMode() || nativeChatContext().canSend;
  $('#coworker-status').textContent = canTalk ? `${event.detail.name}附近没有可到达的位置。对话仍可记录，或按 Esc 取消。` : `${event.detail.name}附近没有可到达的位置。真实历史仍可查看，或按 Esc 取消。`;
  announce(canTalk ? '目标位置暂时无法到达，对话仍然可用。' : '目标位置暂时无法到达，但真实历史仍可查看。', 'error');
});
window.addEventListener('irixi:walk-cancelled', (event) => announce(event.detail.message));

document.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-coworker-action]')?.dataset.coworkerAction;
  if (!action) return;
  try {
    if (action === 'learning-open') { await openLearningProduct(); return; }
    if (action === 'game-workbench') {
      if (state.nativeProduct?.functionId !== 'game' || !state.task?.id) throw new Error('当前任务没有经后台核实的小游戏职能归属。');
      state.gameWorkshopTaskId = state.task.id;
      state.gameWorkspaceError = null;
      state.gameWorkspaceData = null;
      state.gameWorkspaceFile = null;
      state.gameWorkspaceFilePath = null;
      $('#coworker-dialog').close();
      setView('desk');
      await loadGameWorkspace();
      return;
    }
    if (action === 'native-run') { await requestNativeRun(); renderCoworkerConversation(); return; }
    if (action === 'native-cancel') { await requestNativeCancel(); renderCoworkerConversation(); return; }
    if (action === 'new-task') {
      const functionId = event.target.closest('[data-coworker-action]')?.dataset.functionId;
      if (!COMMISSION_FUNCTIONS[functionId]) return;
      $('#coworker-dialog').close();
      openDialog('task-dialog', functionId);
      return;
    }
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
  .catch((error) => announce(`Irixi 无法读取当前产品状态：${error.message}`, 'error'));
