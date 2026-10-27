import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { escapeHtml, normalizeNativeProductState } from '../public/native-product-state.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('正式项目聊天只按后台资格显示新执行，并提交明确任务级策略', () => {
  const actionsStart = source.indexOf('function renderProjectChatActions(');
  const actionsEnd = source.indexOf('\n\nfunction newRequestId', actionsStart);
  const actions = source.slice(actionsStart, actionsEnd);
  assert.match(actions, /actions\.canStartTaskScopedExecution === true && canBind/u);
  assert.doesNotMatch(actions, /renderSharedBudgetCheckbox|nativeSharedBudgetDraft/u);
  const prepare = source.slice(source.indexOf('async function requestNativePrepareRun()'), source.indexOf('async function requestNativeRestoreCurrentResult()'));
  assert.match(prepare, /startTaskScopedExecution: true/u);
  assert.match(prepare, /continuationBudgetPolicy: 'task_scoped_no_aggregate_v1', acknowledgeNoAggregateLimit: true/u);
  assert.match(prepare, /newExecutionRequestId: requestId/u);
  assert.doesNotMatch(prepare, /startFreshSharedBudget|nativeSharedBudgetDraft/u);
});

test('原生NPC点击立即打开共享聊天，不静默选择旧任务或发起模型对话', () => {
  const start = source.indexOf('function openCoworkerConversation(detail)');
  const end = source.indexOf("window.addEventListener('irixi:coworker'", start);
  const route = source.slice(start, end);
  assert.match(route, /if \(nativeMode\(\)\) \{ void openCoworkerProjectConversation\(detail\); return; \}/);
  const coworkerRoute = route.slice(route.indexOf('async function openCoworkerProjectConversation'));
  assert.match(coworkerRoute, /project-dialogue-panel'\)\.hidden = false/);
  assert.match(coworkerRoute, /renderProjectChat\(\);[\s\S]*void loadProjectChatData\(\)/);
  assert.doesNotMatch(coworkerRoute, /nativeCoworkerTask|openProjectChatTask\(/);
  assert.doesNotMatch(route, /postNativeAction\('chat'/);
});

test('新聊天首句创建无工程范围的任务；后续消息保存为工作交代且不会调用聊天模型', () => {
  const createStart = source.indexOf('async function createNativeChatTask()');
  const createEnd = source.indexOf('function bindProjectOverlay()', createStart);
  const creation = source.slice(createStart, createEnd);
  assert.match(creation, /normalizeNativeTaskDraft\(\{ title: text\.slice\(0, 36\), statement: text/);
  assert.match(creation, /input\.taskCreationRequestId = requestId/);
  assert.doesNotMatch(creation, /projectId:|projectScopeFingerprint|prepare_run|postNativeAction\(['"](?:chat|run)['"]\)/);
  const save = source.slice(source.indexOf('async function saveProjectInstruction('), createStart);
  assert.match(save, /if \(!state\.projectChatTaskId\) \{ await createNativeChatTask\(\); return; \}/);
  assert.match(save, /nativeActionPayload\(product, 'instructions'/);
  assert.match(save, /尚未执行/);
});

test('原生旧任务书桌和审阅入口回到同一办公室聊天', () => {
  const view = source.slice(source.indexOf('function setView('), source.indexOf('async function loadProjectChatData('));
  assert.match(view, /nativeMode\(\) && \['desk', 'review'\]\.includes\(view\)/);
  assert.match(view, /state\.view = 'office'/);
  assert.match(view, /project-dialogue-panel'\)\.hidden = false/);
  assert.match(view, /project-records'\)\.open = view === 'review'/);
});

test('原生地址栏跟随当前聊天；新对话清除旧任务编号', () => {
  const sync = source.slice(source.indexOf('function syncLocation()'), source.indexOf('function renderTaskList()'));
  assert.match(sync, /nativeMode\(\) \? state\.projectChatTaskId : state\.task\?\.id/);
  assert.match(source.slice(source.indexOf('async function openProjectChatTask('), source.indexOf('async function selectNativeTask(')), /renderProjectChat\(\);\s*syncLocation\(\)/);
  assert.match(source.slice(source.indexOf('async function openCoworkerProjectConversation('), source.indexOf("window.addEventListener\('irixi:coworker'")), /syncLocation\(\)/);
});

test('聊天动作只按后台资格显示，状态未变化时不重建控件', () => {
  const start = source.indexOf('function renderProjectChatActions(');
  const end = source.indexOf('function newRequestId(', start);
  const render = source.slice(start, end);
  assert.match(render, /actions\.canRun && native\.runAgentId && canBind/);
  assert.match(render, /canReviewNativeCandidate\(product\)/);
  assert.match(render, /actions\.canConfirm && review\?\.passed/);
  assert.match(render, /root\.dataset\.chatActionsMarkup !== markup/);
  assert.match(render, /nativeActionBound\(product\)/);
  assert.match(render, /canMaterials/);
  assert.match(render, /actions\.canStartTaskScopedExecution === true && canBind/u);
  assert.match(render, /开启新一轮，保留上轮记录/u);
  assert.match(render, /button\.disabled = button\.dataset\.chatBaseDisabled === 'true'[\s\S]*actionPending/u);
});

test('当前绑定的停止动作可越过普通聊天pending锁，独立防重并保留长动作锁', async () => {
  const renderStart = source.indexOf('function renderProjectChatActions(');
  const renderEnd = source.indexOf('\n\nfunction newRequestId', renderStart);
  const render = source.slice(renderStart, renderEnd);
  assert.match(render, /actions\.canCancel && product\.execution\?\.id && canBind/u);
  assert.match(render, /data-native-task-binding="\$\{esc\(projectTaskBinding\(product\)\)\}"/u);
  assert.match(render, /button\.dataset\.action === 'native-cancel' \? cancelPending : actionPending \|\| cancelPending/u,
    'ordinary actions stay locked while the authorized stop action has its own pending lock');

  const clickStart = source.indexOf("document.addEventListener('click', async (event) => {");
  const clickEnd = source.indexOf("$('#native-task-search')", clickStart);
  const click = source.slice(clickStart, clickEnd);
  assert.match(click, /!isNativeCancel && state\.projectChatPendingAction\?\.binding === chatActionBinding/u,
    'a pending run or plan does not swallow the stop click');
  assert.match(click, /state\.nativeCancelPendingAction\?\.binding === cancelTaskBinding/u,
    'duplicate stop clicks for the same binding are ignored');
  assert.match(click, /chatAction && !isNativeCancel \? \{ binding: chatActionBinding/u,
    'stop does not replace the long action pending lock');
  assert.match(click, /state\.projectChatPendingAction === chatPendingAction/u,
    'the long action clears only its own lock');
  assert.match(click, /state\.nativeCancelPendingAction === cancelPendingAction/u,
    'the stop action clears only its own lock');
  assert.match(click, /renderNativeCancelSurfaces\(\)/u,
    'busy state is reflected in the visible office, desk or review stop control');
  assert.match(click, /requestNativeCancel\(control\?\.dataset\.nativeReviewBinding \|\| null, control\?\.dataset\.nativeTaskBinding \|\| null\)/u);

  const cancelStart = source.indexOf('async function requestNativeCancel(');
  const cancelEnd = source.indexOf('\n\nasync function requestNativeContinue', cancelStart);
  const cancel = source.slice(cancelStart, cancelEnd);
  assert.match(cancel, /product\.native\?\.actions\?\.canCancel !== true/u);
  assert.match(cancel, /projectTaskBinding\(product\) !== expectedTaskBinding/u,
    'an old rendered task binding is refused before sending');
  assert.match(cancel, /expectedBinding && \(!\['open', 'running'\]\.includes\(round\?\.status\) \|\| nativeReviewBinding\(product\) !== expectedBinding\)/u,
    'a stale review-round binding is refused before the execution-cancel fallback');
  assert.match(cancel, /product\?\.execution\?\.taskScopedContinuation === true && product\.native\?\.actions\?\.canCancel === true/u,
    'execution cancellation keeps its existing task-scoped eligibility contract');
  assert.match(cancel, /postNativeAction\('cancel', \{ requestId: state\.nativeExecutionCancelRequest\.requestId \}\)/u,
    'the existing native payload helper continues to supply the bound CAS fields');
  assert.match(cancel, /state\.nativeExecutionCancelRequest\?\.binding !== requestBinding/u,
    'request ID remains stable for an unchanged execution and scope binding');

  const state = { nativeProduct: {
    current: true, taskId: 'task-current', goalVersionId: 'goal-current',
    native: { actions: { canCancel: true }, reviewRound: { id: 'round-old', status: 'completed' } },
    execution: { id: 'execution-current', taskScopedContinuation: true, continuationRequestId: 'continuation-current' },
  } };
  const sent = [];
  const requestCancel = new Function('state', 'nativeActionBound', 'nativeReviewBinding', 'projectTaskBinding',
    'window', 'postNativeAction', 'announce', `${cancel}\nreturn requestNativeCancel;`)(
    state, () => true, () => 'review-binding-current', () => 'task-binding-current',
    { confirm: () => true }, async (...args) => sent.push(args), () => {});
  await assert.rejects(requestCancel('review-binding-stale', 'task-binding-current'), /审阅轮已变化/u,
    'a stale review button cannot fall through and cancel the still-active execution');
  assert.equal(sent.length, 0);
  await requestCancel(null, 'task-binding-current');
  assert.equal(sent[0]?.[0], 'cancel', 'the current task-scoped execution can still be stopped');
  assert.match(sent[0]?.[1]?.requestId || '', /^[A-Za-z0-9_-]{1,128}$/u);
});

test('项目聊天提供按当前绑定打开的完整换目标表单', () => {
  const actionStart = source.indexOf('function renderProjectChatActions(');
  const actionEnd = source.indexOf('\n\nfunction newRequestId', actionStart);
  const actions = source.slice(actionStart, actionEnd);
  assert.match(actions, /const canChangeGoal = actions\.canGoal === true && nativeSetupBound\(product\)/u);
  assert.match(actions, /data-open-native-goal>更换完整工作目标/u);
  assert.match(actions, /const goalFormMarkup = canChangeGoal \? renderNativeGoalForm\(product\) : ''/u);
  assert.match(source, /function renderNativeGoalForm\(context\)[\s\S]*name="statement"[\s\S]*name="successCriteria"[\s\S]*name="boundaries"/u);
  const clickStart = source.indexOf("panel.addEventListener('click'");
  const clickEnd = source.indexOf("panel.addEventListener('submit'", clickStart);
  const click = source.slice(clickStart, clickEnd);
  assert.match(click, /product\?\.native\?\.actions\?\.canGoal \|\| !nativeSetupBound\(product\)/u);
  assert.match(click, /projectChatSelectionPending/u);
  assert.match(click, /project-workspace-tools'\)\.open = true/u);
  assert.match(click, /const currentForm = \$\('#project-workspace-tool-content \[data-native-goal\]'\)/u);
  assert.match(click, /currentForm\.dataset\.boundTaskId !== product\.taskId[\s\S]*currentForm\.elements\.statement\.focus/u,
    'the focus target is re-read after rendering and checked against the same task/goal binding');
  assert.match(actions, /renderNativeMarkup\(setupRoot, workspaceMarkup, goalBinding, document\.activeElement\)/u,
    'the native renderer restores the focused goal field and selection for the same task binding');
  assert.match(actions, /goalEntryButton\.disabled = !canChangeGoal/u,
    'the goal form remains available during unrelated in-flight chat actions when the backend still permits it');
  assert.doesNotMatch(actions, /querySelectorAll\('button\[data-action\], button\[data-chat-create-project\], button\[data-open-native-goal\]/u,
    'goal replacement is not disabled by the generic pending-action lock');
  const formStart = source.indexOf('function renderNativeGoalForm(');
  const formEnd = source.indexOf('\n\nfunction renderProjectChatActions', formStart);
  const renderGoal = new Function('state', 'restoreNativeGoalDraft', 'nativeGoalDraftStorage', 'newRequestId',
    'persistNativeGoalDraft', 'esc', 'nativeSetupBound', `${source.slice(formStart, formEnd)}\nreturn renderNativeGoalForm;`)(
    { nativeGoalRequest: null }, () => ({ binding: 'task-goal:goal-v1', requestId: 'request-1', values: {
      statement: 'New goal', successCriteria: 'Done', boundaries: 'Only local files',
    } }), () => null, () => 'request-1', () => {}, (value) => String(value), () => true);
  const product = { taskId: 'task-goal', goalVersionId: 'goal-v1', goalStatement: 'Old goal',
    native: { actions: { canGoal: true } } };
  const formMarkup = renderGoal(product);
  assert.match(formMarkup, /data-bound-task-id="task-goal" data-bound-goal-version-id="goal-v1"/u);
  assert.match(formMarkup, /name="statement"[^>]*>New goal/u);
  assert.match(formMarkup, /name="successCriteria"[^>]*>Done/u);
  assert.match(formMarkup, /name="boundaries"[^>]*>Only local files/u);
});

test('新一轮确认沿用稳定请求编号并明确任务级策略，只准备不启动模型', () => {
  const start = source.indexOf('async function requestNativeFreshExecution()');
  const end = source.indexOf('\n\nasync function requestNativeRestoreCurrentResult()', start);
  const handler = source.slice(start, end);
  assert.match(handler, /window\.confirm\([\s\S]*不设累计调用次数或总时长上限/u);
  assert.match(handler, /mode: 'new_execution', startTaskScopedExecution: true, newExecutionRequestId: requestId/u);
  assert.match(handler, /continuationBudgetPolicy: 'task_scoped_no_aggregate_v1', acknowledgeNoAggregateLimit: true/u);
  assert.match(handler, /localStorage\.setItem\(storageKey/u);
  assert.match(handler, /await postNativeAction\('prepare_run'/u);
  assert.doesNotMatch(handler, /postNativeAction\('run'|approve_plan/u);
});

test('新建独立项目只由明确点击触发，不选择范围或启动任务', () => {
  const start = source.indexOf('async function createProjectForCurrentChat()');
  const end = source.indexOf('function projectRecordStatus(', start);
  const create = source.slice(start, end);
  assert.match(create, /setupStatus !== 'waiting_scope'/);
  assert.match(create, /api\(product\.links\.projects, \{ method: 'POST'/);
  assert.match(create, /body: JSON\.stringify\(\{ name, requestId, kind: product\.functionId === 'document' \? 'document' : 'utility' \}\)/);
  assert.doesNotMatch(create, /authorize_scope|prepare_run|postNativeAction\(['"]run['"]\)/);
  assert.match(source.slice(source.indexOf("panel.addEventListener('click'"), source.indexOf("if (event.target.closest('[data-project-dialogue-list]')")), /createProjectForCurrentChat\(\)/);
});

test('无项目 document 聊天直接显示新建和范围设置；返回登记项目后显示手动选择', () => {
  const task = { id: 'task-document-setup', title: '写文档', goalVersionId: 'goal-document-setup',
    statement: '根据材料形成文档', successCriteria: [], boundaries: [], functionId: 'document' };
  const waiting = normalizeNativeProductState({ task, status: 'waiting_scope', execution: null, registry: null,
    setup: { projects: [], selectedProject: null, selectedScope: null },
    materials: [
      { id: 'qa-material-a', name: 'discussion-a.txt', bytes: 63 },
      { id: 'qa-material-b', name: 'discussion-b.md', bytes: 190 },
      { id: 'qa-material-c', name: 'notes.txt', bytes: 121 },
    ],
    native: { actions: { canScope: true } }, links: { projects: '/api/product/projects' } });
  assert.equal(waiting.functionId, 'document');
  assert.equal(waiting.setupStatus, 'waiting_scope');
  assert.equal(waiting.native.actions.canScope, true);
  assert.equal(waiting.links.projects, '/api/product/projects');
  assert.deepEqual(waiting.materials.map((item) => item.name), ['discussion-a.txt', 'discussion-b.md', 'notes.txt']);

  const materialRendererStart = source.indexOf('function renderDocumentMaterialSummary(');
  const materialRendererEnd = source.indexOf('\n\nfunction renderProjectChatSetupControls', materialRendererStart);
  const renderMaterials = new Function('esc', `${source.slice(materialRendererStart, materialRendererEnd)}\nreturn renderDocumentMaterialSummary;`)(escapeHtml);
  assert.match(renderMaterials({ functionId: 'document', materials: waiting.materials }), /已加入资料 3 份/u);
  assert.match(renderMaterials({ functionId: 'document', materials: waiting.materials }), /discussion-a\.txt[\s\S]*discussion-b\.md[\s\S]*notes\.txt/u);

  const helperStart = source.indexOf('function renderProjectChatSetupControls(');
  const helperEnd = source.indexOf('\n\nfunction renderProjectChatActions', helperStart);
  const renderSetup = new Function('esc', 'state', `${source.slice(helperStart, helperEnd)}\nreturn renderProjectChatSetupControls;`)(
    (value) => String(value), { projectChatProjectCreatePending: false });
  const emptyMarkup = renderSetup(waiting);
  assert.match(emptyMarkup, /新建文档项目/u);
  assert.match(emptyMarkup, /可以先新建空白项目/u);
  assert.doesNotMatch(emptyMarkup, /data-native-scope/u, 'no project option is invented');

  waiting.setup.projects.push({ projectId: 'registered-doc-project', label: '文档项目', scopeFingerprint: 'scope-doc', current: true });
  const selectedMarkup = renderSetup(waiting);
  assert.match(selectedMarkup, /data-native-scope/u);
  assert.match(selectedMarkup, /registered-doc-project/u);
  assert.match(selectedMarkup, /选择范围/u);
  const actionRenderer = source.slice(source.indexOf('function renderProjectChatActions('), source.indexOf('\n\nfunction newRequestId', source.indexOf('function renderProjectChatActions(')));
  assert.match(actionRenderer, /<div class="chat-setup-controls">\$\{setupMarkup\}<\/div>/u,
    'scope controls render in the visible chat action area, not only the collapsed workspace details');
  assert.match(actionRenderer, /workspaceSetupMarkup/);

  const establishedUtility = { ...waiting, functionId: 'utility', setupStatus: 'ready_to_run',
    setup: { projects: [], selectedProject: { projectId: 'internal-project-id', label: '旧工具项目' },
      selectedScope: { projectId: 'internal-project-id', scopeFingerprint: 'f'.repeat(64), authorized: true } },
    registry: { projectId: 'internal-project-id', scopeFingerprint: 'f'.repeat(64) },
    product: { projectId: 'internal-project-id', workspaceScopeFingerprint: 'f'.repeat(64) } };
  assert.equal(renderSetup(establishedUtility), '', 'an already configured utility does not get a new setup block in chat');
  const completedUtility = { ...establishedUtility, setupStatus: 'completed' };
  assert.equal(renderSetup(completedUtility), '', 'a completed utility does not get setup controls in chat');
  assert.doesNotMatch(`${renderSetup(establishedUtility)}${renderSetup(completedUtility)}`, /internal-project-id|f{64}/u,
    'established/completed utility chat output does not expose internal IDs or scope fingerprints');
});

test('文档聊天只展示当前任务的已加入资料名称并转义文本', () => {
  const start = source.indexOf('function renderDocumentMaterialSummary(');
  const end = source.indexOf('\n\nfunction renderProjectChatSetupControls', start);
  const renderMaterials = new Function('esc', `${source.slice(start, end)}\nreturn renderDocumentMaterialSummary;`)(escapeHtml);
  assert.match(renderMaterials({ functionId: 'document', materials: [] }), /尚未加入资料/u);
  const firstTask = renderMaterials({ functionId: 'document', materials: [
    { id: 'internal-a', name: '报价.md', sha256: 'a'.repeat(64), text: '正文不显示' },
    { id: 'internal-b', name: '<交付>.txt', sha256: 'b'.repeat(64), text: '正文也不显示' },
    { id: 'internal-c', name: '说明.md', sha256: 'c'.repeat(64) },
  ] });
  assert.match(firstTask, /已加入资料 3 份/u);
  assert.match(firstTask, /报价\.md/u);
  assert.match(firstTask, /&lt;交付&gt;\.txt/u);
  assert.match(firstTask, /说明\.md/u);
  assert.doesNotMatch(firstTask, /internal-[abc]|[abc]{64}|正文不显示/u);
  const nextTask = renderMaterials({ functionId: 'document', materials: [{ id: 'other-id', name: '新任务资料.txt' }] });
  assert.match(nextTask, /新任务资料\.txt/u);
  assert.doesNotMatch(nextTask, /报价\.md|internal-a/u, 'the view derives only from the currently rendered task');
});

test('材料提交失败在弹窗内显示错误且保留输入；成功时才清空并关闭', () => {
  const markup = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(markup, /<p class="field-note" data-material-error role="alert" hidden><\/p>/u);
  const open = source.slice(source.indexOf('function openDialog('), source.indexOf('function closeDialog('));
  const submit = source.slice(source.indexOf("$('#material-form').addEventListener('submit'"), source.indexOf("$$('dialog').forEach", source.indexOf("$('#material-form').addEventListener('submit'")));
  const bindingStart = source.indexOf('function materialErrorBelongsToBinding(');
  const bindingEnd = source.indexOf('\n\nasync function postTaskAction', bindingStart);
  const materialErrorBelongsToBinding = new Function('nativeMaterialBindingMatches', `${source.slice(bindingStart, bindingEnd)}\nreturn materialErrorBelongsToBinding;`)(
    (submitted, current) => typeof submitted === 'string' && submitted.length > 0 && submitted === current);
  assert.equal(materialErrorBelongsToBinding('task-A-binding', 'task-A-binding', 'task-A-binding'), true);
  assert.equal(materialErrorBelongsToBinding('task-A-binding', 'task-B-binding', 'task-B-binding'), false,
    'a late task A failure cannot appear in task B\'s newly opened material dialog');
  assert.match(open, /data-material-error[\s\S]*error\.hidden = true; error\.textContent = ''/);
  assert.match(submit, /materialError\.textContent = error\.message; materialError\.hidden = false/);
  assert.equal((submit.match(/announce\(error\.message, 'error'\)/g) || []).length, 2);
  assert.match(submit, /element\.reset\(\);[\s\S]*element\.closest\('dialog'\)\.close\(\)/);
});

test('旧补充要求表单按原任务绑定保存，使用稳定requestId提交且失败保留草稿', () => {
  const openDialog = source.slice(source.indexOf('function openDialog('), source.indexOf('function closeDialog('));
  const form = source.slice(source.indexOf("$('#suggestion-form').addEventListener('input'"), source.indexOf("$('#coworker-form').addEventListener('submit'"));
  assert.match(openDialog, /form\.dataset\.nativeInstructionBinding = binding/);
  assert.match(form, /nativeInstructionDraftKeyForBinding\(binding\)/);
  assert.match(form, /draft\?\.text === text && typeof draft\.requestId === 'string'/);
  assert.match(form, /postNativeAction\('instructions', \{ text, requestId \}\)/);
  assert.match(form, /失败|未确认保存/);
  assert.match(form, /draft\?\.text === text && draft\?\.requestId === requestId/);
  assert.match(form, /formBinding !== binding/);
});

test('切换任务时锁住提交，并按新任务绑定强制恢复草稿；同绑定聚焦时保留输入', () => {
  const render = source.slice(source.indexOf('function renderProjectChat()'), source.indexOf('async function saveProjectInstruction('));
  const open = source.slice(source.indexOf('async function openProjectChatTask('), source.indexOf('async function selectNativeTask('));
  assert.match(open, /projectChatSelectionPending = true/);
  assert.match(open, /project-instructions-text'\)\.disabled = true/);
  assert.match(open, /projectChatSelectionPending = false;[\s\S]*renderProjectChat\(\)/);
  assert.match(render, /bindingChanged \|\| document\.activeElement !== text/);
  assert.match(render, /projectInstructionDraftKey\(product\)/);
});

test('原生轮询只在续改来源绑定变化时重建按钮，并保留正常确认与准备路径', () => {
  const start = source.indexOf("const sourceControl = \$('#project-continuation-control')");
  const end = source.indexOf('const binding = projectTaskBinding(product);', start);
  const render = source.slice(start, end);
  assert.match(render, /if \(sourceControl\.dataset\.signature !== continuationSignature\) \{[\s\S]*?sourceControl\.innerHTML = canContinueSource/);
  assert.match(render, /sourceControl\.dataset\.binding = continuationBinding/);
  assert.equal((render.match(/sourceControl\.innerHTML\s*=/g) || []).length, 1);

  const clickStart = source.indexOf("panel.addEventListener('click'");
  const clickEnd = source.indexOf("if (event.target.closest('[data-project-dialogue-list]'))", clickStart);
  const handler = source.slice(clickStart, clickEnd);
  assert.match(handler, /window\.confirm\(/);
  assert.match(handler, /api\(product\.links\.actions,[\s\S]*instructionPayload/);
  assert.match(handler, /api\(currentProduct\.links\.actions,[\s\S]*preparePayload/);

  const nativeShell = readFileSync(new URL('../../omo-pilot/macos-app/IrixiMacApp.swift', import.meta.url), 'utf8');
  assert.match(nativeShell, /webView\.uiDelegate = self/);
  assert.match(nativeShell, /runJavaScriptConfirmPanelWithMessage/);
});

test('NPC聊天回归覆盖旧任务隔离、过期门禁、异步代际、原子保存、记录保真与真实回复呈现', () => {
  const continuation = source.slice(source.indexOf("panel.addEventListener('click'"), source.indexOf("if (event.target.closest('[data-project-dialogue-list]')"));
  assert.equal((continuation.match(/sameSourceBinding\(\)/g) || []).length >= 4, true, '续改确认前及每次写入前都重核聊天和来源绑定');

  const actions = source.slice(source.indexOf('function renderProjectChatActions('), source.indexOf('function newRequestId('));
  assert.match(actions, /!executionExpired && actions\.canApprovePlan/);
  assert.match(actions, /!executionExpired && actions\.canRun/);
  assert.match(actions, /仍有在途工作待核实/);

  const open = source.slice(source.indexOf('async function openProjectChatTask('), source.indexOf('async function selectNativeTask('));
  const select = source.slice(source.indexOf('async function selectNativeTask('), source.indexOf('async function loadProjectChatData('));
  assert.match(open, /const generation = \+\+state\.projectChatGeneration/);
  assert.match(open, /if \(generation !== state\.projectChatGeneration\) return;/);
  assert.match(select, /projectChatGeneration !== null && projectChatGeneration !== state\.projectChatGeneration/);
  assert.match(source, /if \(generation === state\.projectChatGeneration && !state\.projectChatTaskId\)/);

  const save = source.slice(source.indexOf('async function saveProjectInstruction('), source.indexOf('async function createNativeChatTask('));
  assert.match(save, /projectInstructionSavePending\.has\(submittedBinding\)/);
  assert.match(save, /projectInstructionSavePending\.set\(submittedBinding/);
  assert.match(save, /projectInstructionSavePending\.delete\(submittedBinding\)/);
  assert.match(source.slice(source.indexOf('function renderProjectChat()'), source.indexOf('async function saveProjectInstruction(')), /!canSave \|\| saving/);

  const record = source.slice(source.indexOf('const candidateDetails ='), source.indexOf('const sourceControl ='));
  assert.match(record, /dataset\.recordSignature !== recordSignature/);
  assert.match(record, /product\.artifact\?\.diffSha256/);
  assert.match(record, /recordContent\.scrollTop = scrollTop/);
  assert.match(record, /item\.open = true/);

  assert.match(source.slice(source.indexOf('function nativeCandidateMatches('), source.indexOf('async function loadNativeCandidate(')), /candidate\.diffSha256 === artifact\.diffSha256/);
  const messages = source.slice(source.indexOf('function showProjectChatMessages('), source.indexOf('function renderProjectChatActions('));
  assert.match(messages, /presentation\.initialized && item\.isReply/);
  assert.match(messages, /canPresentReceivedTail/);
  assert.match(messages, /item\.text\.startsWith\(shown\)/);
  assert.match(messages, /presentation\.queue = presentation\.queue\.filter\(\(queued\) => queued\.id !== item\.id\)/);
  assert.match(messages, /bubble\.textContent \+= current\.text\.slice/);
  assert.match(messages, /prefers-reduced-motion/);
  assert.match(messages, /node\.replaceChildren\(\)/);
  assert.match(messages, /state\.projectChatPresentation !== presentation/);
});
