import { attachProjectMapHotspot } from './native-project-hotspot.js';
import { escapeHtml as esc, renderMarkdown, icon } from './conversation-format.js';

const $ = (s) => document.querySelector(s);
const active = new Set(['queued', 'understanding', 'waiting', 'working', 'stopping']);
const labels = { queued: '消息已保存，准备开始', understanding: '正在理解你的要求', waiting: '等待同项目的工作结束', working: '正在处理', stopping: '正在停止，等待工具退出', stopped: '已停止', interrupted: '工作中断，记录已保留', failed: '本轮未完成', completed: '本轮已结束', superseded: '已按新消息接续', awaiting_project: '等待选择项目文件夹' };
const toolLabels = { read: '读取文件', grep: '查找内容', find: '查找文件', ls: '查看文件夹', write: '写入文件', edit: '修改文件', bash: '运行命令', delegate_readonly: '安排只读助手', verify_behavior: '实际检查功能', check: '检查功能' };
const uuid = () => crypto.randomUUID();
const query = new URLSearchParams(location.search);
// A distinct URL identity also separates native new windows; sessionStorage alone
// can be cloned when a browser duplicates a tab.
let windowId = query.get('window') || sessionStorage.getItem('irixi.workbench.window') || uuid();
sessionStorage.setItem('irixi.workbench.window', windowId);
let currentId = query.get('conversation');
let data = { projects: [], conversations: [], sections: [], preferences: {}, catalogue: { models: [], providers: [] } };
let expanded = localStorage.getItem('irixi.p0.expanded') !== 'false';
let references = []; let editTarget = null; let selection = null;
let sending = false; let offline = false; let focusedMessage = query.get('message');
let modelUpdating = false; let observedModel = '';
let draftTimer; let refreshBusy = false; let draftQueue = Promise.resolve();
const drafts = new Map(); const artifactInputs = new Map(); const rendered = new Map(); const nativeRequests = new Map();
const current = () => data.conversations.find((c) => c.id === currentId);
const projectFor = (c) => data.projects.find((p) => p.id === c?.projectId);
const activeTurn = (c) => c?.turns.findLast((t) => active.has(t.status) || t.status === 'awaiting_project');
const button = (action, title, glyph, extra = '') => `<button type="button" class="wb-icon" data-action="${action}" title="${esc(title)}" aria-label="${esc(title)}" ${extra}>${icon(glyph)}</button>`;
const linkFor = (cid, mid, native = false) => {
  const url = native ? new URL('irixi://conversation') : new URL('/', location.href);
  if (native) url.searchParams.set('id', cid); else { url.searchParams.set('backend', 'openoffice'); url.searchParams.set('view', 'office'); url.searchParams.set('conversation', cid); }
  if (mid) url.searchParams.set('message', mid); return url.href;
};
function html(selector, content) { const node = $(selector); if (node && rendered.get(selector) !== content) { node.innerHTML = content; rendered.set(selector, content); } }
function notice(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
async function api(url, body) {
  let response;
  try { response = await fetch(url, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
  catch { throw new Error('连接中断。草稿保留在这个窗口；恢复连接后可以重试。'); }
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.message || '操作未完成。原内容与草稿已保留。');
  return value;
}
const actionApi = (cid, name, body) => api(`/api/conversation/${encodeURIComponent(cid)}/${name}`, body);
function locationForCurrent() {
  const url = new URL(location.href); url.searchParams.set('window', windowId); url.searchParams.set('view', 'office'); url.searchParams.delete('task');
  currentId ? url.searchParams.set('conversation', currentId) : url.searchParams.delete('conversation');
  focusedMessage ? url.searchParams.set('message', focusedMessage) : url.searchParams.delete('message'); history.replaceState(null, '', url);
}
function showView(name) { document.querySelectorAll('.view').forEach((n) => n.classList.toggle('is-active', n.id === `view-${name}`)); document.body.dataset.openofficeView = name; }
function open() { showView('office'); panel.hidden = false; panel.classList.toggle('is-expanded', expanded); $('[data-project-dialogue-expand]').textContent = expanded ? '收起' : '展开'; }
function sidebar(visible) { $('#project-sidebar').hidden = !visible; $('.office-shell').classList.toggle('has-sidebar', visible); $('.office-map-project-button')?.setAttribute('aria-expanded', String(visible)); }
function localKey(cid) { return `irixi.workbench.draft.${windowId}.${cid || 'new'}`; }
function getDraft(cid) {
  if (drafts.has(cid)) return drafts.get(cid);
  let saved; try { saved = JSON.parse(localStorage.getItem(localKey(cid))); } catch {}
  const remote = data.drafts?.[`${cid}:${windowId}`];
  const legacyKey = `irixi.p0.draft.${cid || 'new'}`;
  const legacy = !saved && !remote && !localStorage.getItem(`irixi.workbench.migrated.${cid || 'new'}`) ? localStorage.getItem(legacyKey) : null;
  const value = saved || remote || { text: legacy || '', references: [], editTarget: null, revision: remote?.revision || 0, dirty: Boolean(legacy) };
  if (remote && (remote.revision || 0) > (value.revision || 0) && !saved?.dirty) Object.assign(value, remote);
  if (legacy) { localStorage.setItem(localKey(cid), JSON.stringify(value)); localStorage.setItem(`irixi.workbench.migrated.${cid || 'new'}`, windowId); }
  drafts.set(cid, value); return value;
}
function snapshotDraft(cid = currentId) {
  const d = getDraft(cid); Object.assign(d, { text: input.value, references: structuredClone(references), editTarget, dirty: true });
  localStorage.setItem(localKey(cid), JSON.stringify(d)); return d;
}
function saveDraft(cid, snapshot) {
  if (!cid) return Promise.resolve();
  const captured = structuredClone(snapshot);
  draftQueue = draftQueue.catch(() => {}).then(async () => {
    const currentDraft = getDraft(cid);
    const result = await actionApi(cid, 'draft', { ...captured, windowId, expectedRevision: currentDraft.revision || 0 });
    currentDraft.revision = result.result.revision;
    if (currentDraft.text === captured.text && JSON.stringify(currentDraft.references) === JSON.stringify(captured.references) && JSON.stringify(currentDraft.editTarget) === JSON.stringify(captured.editTarget)) currentDraft.dirty = false;
    localStorage.setItem(localKey(cid), JSON.stringify(currentDraft));
  }).catch((error) => { if (currentId === cid) notice(`草稿已保存在这个窗口。${error.message}`, true); });
  return draftQueue;
}
function captureDraft() { const cid = currentId; const d = snapshotDraft(cid); clearTimeout(draftTimer); draftTimer = setTimeout(() => saveDraft(cid, d), 400); }
async function select(cid, mid = null) {
  clearTimeout(draftTimer); const oldId = currentId; const oldDraft = snapshotDraft(oldId); void saveDraft(oldId, oldDraft);
  currentId = cid; focusedMessage = mid; locationForCurrent();
  const d = getDraft(cid); input.value = d.text; references = structuredClone(d.references || []); editTarget = d.editTarget || null;
  selection = structuredClone(current()?.modelSelection || data.catalogue?.defaultSelection || { provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' });
  $('#wb-history').replaceChildren(); rendered.delete('#wb-history'); render(); renderComposer(); open();
  if (innerWidth < 800) sidebar(false); input.focus();
  if (current()?.unread) { await actionApi(cid, 'update', { unread: false }); await refresh(); }
}
async function create(projectId = null) { const response = await api('/api/conversation/new', { projectId, requestId: uuid() }); await refresh(); await select(response.conversationId); return response.conversationId; }
async function update(cid, patch) { await actionApi(cid, 'update', patch); await refresh(); }
function native(action, payload = {}) {
  if (!window.webkit?.messageHandlers?.irixiHost) return null;
  const requestId = uuid(); return new Promise((resolve, reject) => {
    // A person may spend minutes choosing/creating a folder. The native panel
    // returns both selection and cancellation; do not discard its late result.
    const timer = action === 'choose-directory' ? null : setTimeout(() => { nativeRequests.delete(requestId); reject(new Error('系统操作尚未返回。原内容保留，请重试。')); }, 30000);
    nativeRequests.set(requestId, { resolve, reject, timer }); window.webkit.messageHandlers.irixiHost.postMessage({ action, requestId, ...payload });
  });
}
window.irixiHostReceive = (value) => { const pending = nativeRequests.get(value.requestId); if (!pending) return; clearTimeout(pending.timer); nativeRequests.delete(value.requestId); value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result); };
async function copy(text) {
  const result = native('copy', { text });
  if (result) await result; else await navigator.clipboard.writeText(text);
  notice('已复制。');
}
function dialog({ title, note = '', value = '', options, submit = '确定' }) {
  return new Promise((resolve) => {
    const node = document.createElement('dialog'); node.className = 'wb-dialog';
    node.innerHTML = `<form method="dialog"><h2>${esc(title)}</h2>${note ? `<p class="wb-inline-note">${esc(note)}</p>` : ''}<label>${esc(title)}${options ? `<select name="value">${options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('')}</select>` : `<input name="value" value="${esc(value)}" autocomplete="off">`}</label><footer><button value="cancel">取消</button><button value="ok">${esc(submit)}</button></footer></form>`;
    document.body.append(node); if (options) node.querySelector('select').value = value;
    node.addEventListener('close', () => { const value = node.returnValue === 'ok' ? node.querySelector('[name=value]').value : null; node.remove(); resolve(value); }, { once: true }); node.showModal(); node.querySelector('[name=value]').focus();
  });
}
async function chooseDirectory(cid = currentId) {
  if (!cid) cid = await create();
  const original = data.conversations.find((c) => c.id === cid);
  const waiting = original.turns.findLast((t) => t.status === 'awaiting_project')?.id || null;
  const chosen = native('choose-directory');
  const path = chosen ? (await chosen)?.path : await dialog({ title: '项目文件夹位置', note: '本机应用会打开系统文件夹选择器。浏览器中可填写一个已有文件夹的完整路径。选好后沿用已说过的要求。', value: projectFor(original)?.root || '' });
  if (!path) { notice('已取消选择。原请求和草稿保留。'); return; }
  await actionApi(cid, 'bind-project', { path, pendingTurnId: waiting, requestId: uuid() }); await refresh();
  notice(waiting ? '文件夹已选定，正在接着做。' : '项目文件夹已选定。');
}
function row(c, standalone = false) {
  return `<div class="wb-row${standalone ? ' standalone' : ''}${c.id === currentId ? ' selected' : ''}"><button type="button" data-select="${esc(c.id)}" title="${esc(c.title)}">${esc(c.title)}</button>${activeTurn(c) ? '<span class="wb-running" aria-label="正在运行"></span>' : c.unread ? '<span class="wb-dot" aria-label="未读"></span>' : ''}${button('conversation-menu', '对话操作', 'more', `data-cid="${esc(c.id)}"`)}</div>`;
}
function renderTree() {
  const visible = data.conversations.filter((c) => !c.archived); const collapsed = data.preferences.collapsedProjects || [];
  const byRecent = (list) => [...list].sort((a, b) => (b.messages.at(-1)?.at || b.createdAt).localeCompare(a.messages.at(-1)?.at || a.createdAt));
  const pinned = byRecent(visible.filter((c) => c.pinned));
  const sections = data.sections.map((s) => `<h3>${esc(s.name)}</h3>${byRecent(visible.filter((c) => c.sectionId === s.id)).map((c) => row(c, true)).join('')}`);
  const tree = `${pinned.length ? `<h3>置顶</h3>${pinned.map((c) => row(c, true)).join('')}` : ''}<h3>项目</h3>${data.projects.map((p) => `<section><div class="wb-folder${collapsed.includes(p.id) ? ' is-collapsed' : ''}"><button type="button" data-collapse="${esc(p.id)}" title="${esc(p.root)}" aria-expanded="${!collapsed.includes(p.id)}"><span class="chevron">${icon('chevron')}</span>${icon('folder')}<span>${esc(p.name)}</span></button>${button('new-project-chat', '在此项目新建对话', 'plus', `data-project="${esc(p.id)}"`)}</div>${collapsed.includes(p.id) ? '' : byRecent(visible.filter((c) => c.projectId === p.id)).map((c) => row(c)).join('')}</section>`).join('')}${sections.join('')}<h3>无项目对话</h3>${byRecent(visible.filter((c) => !c.projectId && !c.sectionId)).map((c) => row(c, true)).join('') || '<p class="wb-inline-note">可以直接开始讨论。</p>'}`;
  html('#wb-tree', tree);
}
function messageNode(message, c) {
  const node = document.createElement('article'); node.className = `wb-message ${message.role}`; node.dataset.message = message.id; node.id = message.id;
  const ongoing = c.turns.some((t) => t.id === message.turnId && (active.has(t.status) || t.status === 'awaiting_project'));
  node.innerHTML = `<div class="wb-author">${message.role === 'user' ? '你' : 'IRiXI'}${message.inherited ? ' · 分支继承' : ''}</div><div class="wb-body">${renderMarkdown(message.text)}</div>${message.references?.length ? `<p class="wb-inline-note">已引用：${message.references.map((r) => `<a href="${esc(linkFor(r.conversationId, r.messageId))}" data-reference-link>${esc(r.title)}</a>`).join('、')}</p>` : ''}<div class="wb-message-actions">${button('copy-message', '复制消息', 'copy')}${button('quote-message', '引用消息或选中片段', 'quote')}${message.role === 'user' ? button('edit-message', '编辑并重新发送', 'edit', ongoing ? 'disabled' : '') : ''}${button('fork-message', '从这里创建分支聊天', 'branch', ongoing ? 'disabled' : '')}${button('message-menu', '更多消息操作', 'more')}<time datetime="${esc(message.at)}">${esc(new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</time></div>`;
  node.dataset.version = JSON.stringify([message.text, ongoing]); return node;
}
function renderMessages(c) {
  const history = $('#wb-history'); const scroll = $('.wb-scroll'); const nearEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 130;
  if (!c?.messages.length) { html('#wb-history', '<div class="wb-welcome"><h2>我们要做什么？</h2><p>先聊想法。你说开始做，我再动手。</p><p>可以随时选一个项目文件夹，接着已有工作继续。</p></div>'); return; }
  if (!history.querySelector('[data-message]')) history.replaceChildren();
  const keep = new Set(c.messages.map((m) => m.id)); for (const node of history.children) if (!keep.has(node.dataset.message)) node.remove();
  for (const message of c.messages) {
    const existing = document.getElementById(message.id);
    const ongoing = c.turns.some((t) => t.id === message.turnId && (active.has(t.status) || t.status === 'awaiting_project'));
    if (!existing) history.append(messageNode(message, c));
    else if (existing.dataset.version !== JSON.stringify([message.text, ongoing])) {
      // Only update action availability when a turn ends. Do not replace selected message text.
      existing.querySelectorAll('[data-action="edit-message"],[data-action="fork-message"]').forEach((b) => { b.disabled = ongoing; });
      existing.dataset.version = JSON.stringify([message.text, ongoing]);
    }
  }
  if (focusedMessage) { const target = document.getElementById(focusedMessage); if (target) { target.classList.add('is-linked'); target.scrollIntoView({ block: 'center' }); focusedMessage = null; } }
  else if (nearEnd) scroll.scrollTop = scroll.scrollHeight;
}
function duration(start, end) { const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : Date.now()) - Date.parse(start)) / 1000)); return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`; }
function eventText(r) {
  let args; try { args = JSON.parse(r.args?.text || '{}'); } catch { args = {}; }
  const target = args.path || args.command || args.pattern || args.task || '';
  return `${toolLabels[r.toolName] || r.toolName}${target ? `：${String(target).slice(0, 180)}` : ''}`;
}
function activity(turn, historical = false) {
  if (!turn) return '';
  const receipts = turn.receipts || []; const pendingTool = receipts.findLast((r) => r.eventType === 'start' && !receipts.some((end) => end.toolCallId === r.toolCallId && end.eventType === 'end'));
  const latest = turn.lastProgressAt || receipts.at(-1)?.occurredAt || turn.startedAt || turn.createdAt;
  const running = active.has(turn.status);
  const quiet = running && Date.now() - Date.parse(latest) > 60000;
  const state = running && pendingTool ? eventText(pendingTool) : running && turn.calls?.some((c) => ['running', 'reserved'].includes(c.status)) ? '等待模型回复' : labels[turn.status] || '状态待确认';
  const entries = receipts.filter((r) => r.eventType === 'start').map((r) => { const end = receipts.find((e) => e.toolCallId === r.toolCallId && e.eventType === 'end'); return `<div class="wb-event">${esc(eventText(r))}<small>${end ? end.isError ? '未成功，原因见记录' : '工具已返回' : running ? '等待工具返回' : '没有结束回执'}</small></div>`; });
  const children = (turn.children || []).map((child) => `<details class="wb-event" id="child-${esc(child.id)}"><summary>只读助手 · ${esc(labels[child.status] || child.status)} · ${esc(child.task)}</summary><p>读取范围：${esc(child.paths?.join('、'))}</p>${child.result ? renderMarkdown(child.result) : '<p>尚无结果。</p>'}<small>${esc(child.id)}</small></details>`);
  return `<details class="wb-activity" id="wb-activity-${esc(turn.id)}"><summary>${historical ? `${esc(new Date(turn.createdAt).toLocaleString('zh-CN'))} · ` : ''}${running ? '<span class="wb-running"></span>' : ''}${esc(state)} · ${duration(turn.createdAt, turn.finishedAt)}${quiet ? ' · 等待新进展' : ''}</summary><p>最近进展：${esc(new Date(latest).toLocaleTimeString('zh-CN'))}。${quiet ? '尚未收到新结果，不能仅凭动画判断工作正常。' : ''}</p><p>本轮：${esc(turn.modelSelection?.model || '历史配置')} / ${esc(turn.modelSelection?.effort || '')}</p>${entries.join('') || '<p>尚无工具记录。</p>'}${children.join('')}</details>`;
}
function activities(c, currentTurn) {
  const past = (c?.turns || []).filter((turn) => turn.id !== currentTurn?.id);
  return activity(currentTurn) + (past.length ? `<details id="wb-past-activity" class="wb-activity"><summary>以前各轮工作过程 · ${past.length} 轮</summary>${[...past].reverse().map((turn) => activity(turn, true)).join('')}</details>` : '');
}
function artifactControls(c, turn) {
  const samples = [...new Map((turn.functionalChecks || []).filter((check) => check.kind === 'cli' && check.status === 'passed').sort((a, b) => Number((b.specification.expected?.exitCode ?? 0) !== 0) - Number((a.specification.expected?.exitCode ?? 0) !== 0)).map((check) => [check.specification.target, check.specification])).values()];
  return samples.map((sample) => {
    const key = `${turn.id}:${sample.target}`; const value = artifactInputs.get(key) || { args: (sample.arguments || []).join('\n'), stdin: sample.stdin || '' };
    const run = c.artifactRuns?.findLast((item) => item.sourceTurnId === turn.id && item.target === sample.target);
    return `<details class="wb-artifact" id="artifact-${esc(turn.id)}-${esc(sample.target)}"><summary>运行工具 · ${esc(sample.target)}</summary><p class="wb-inline-note">${esc(sample.requirement)}。以下是已检查过的示例输入，可修改后运行。运行使用成果副本。</p><label>输入参数（每项一行）<textarea data-run-args data-run-key="${esc(key)}">${esc(value.args)}</textarea></label><label>要处理的文本（如适用）<textarea data-run-stdin data-run-key="${esc(key)}">${esc(value.stdin)}</textarea></label><button type="button" data-action="run-artifact" data-turn="${esc(turn.id)}" data-target="${esc(sample.target)}"${run && active.has(run.status) ? ' disabled' : ''}>${run && active.has(run.status) ? '正在运行…' : '运行并查看结果'}</button>${run ? `<p>${esc(labels[run.status] || run.status)}</p>${run.error ? `<p class="wb-inline-note">${esc(run.error)}</p>` : ''}<pre>${esc(run.output || run.errorOutput || '')}</pre>` : ''}</details>`;
  }).join('');
}
function projectProgress(c) {
  const project = projectFor(c); if (!project) return '';
  const root = c.workspaceRoot || project.root;
  const conversations = data.conversations.filter((other) => other.projectId === project.id && (other.workspaceRoot || project.root) === root);
  const work = (turn) => turn.intent === 'execute' || turn.workspace || turn.status === 'awaiting_project';
  const latest = conversations.map((conversation) => ({ conversation, turn: conversation.turns.findLast((turn) => work(turn) && turn.projectId === project.id && (!turn.commit?.root || turn.commit.root === root)) })).filter((item) => item.turn);
  // Moving a conversation only changes its future context. Saved files still
  // belong to the project and exact directory recorded by that execution.
  const saved = data.conversations.flatMap((conversation) => conversation.turns.filter((turn) => turn.adoptedAt && turn.projectId === project.id && turn.commit?.root === root).map((turn) => ({ conversation, turn }))).sort((a, b) => b.turn.adoptedAt.localeCompare(a.turn.adoptedAt))[0];
  const ongoing = latest.filter(({ turn }) => active.has(turn.status) || turn.status === 'awaiting_project');
  const unfinished = latest.filter(({ turn }) => ['failed', 'stopped', 'interrupted'].includes(turn.status));
  const checked = saved?.turn.verification?.status === 'passed';
  const cases = checked ? [...new Map((saved.turn.functionalChecks || []).map((item) => [item.caseId, item])).values()] : [];
  const useful = cases.filter((item) => item.status === 'passed').slice(0, 2).map((item) => item.requirement).join('；');
  const repaired = cases.filter((item) => item.status === 'passed' && saved.turn.functionalChecks.some((old) => old.caseId === item.caseId && old.status === 'failed')).slice(0, 2).map((item) => item.requirement).join('；');
  const waiting = ongoing.some(({ turn }) => turn.status === 'awaiting_project');
  const completed = saved ? `最近已保存“${saved.conversation.title}”的成果。${checked ? `已检查：${useful || '本轮记录的功能'}。` : '该版本的功能检查尚未确认。'}` : '目前还没有保存到项目的成果。';
  const missing = [...ongoing.map(({ conversation }) => `正在处理：${conversation.title}`), ...unfinished.map(({ conversation }) => `尚未完成：${conversation.title}`)].join('；') || '没有正在处理的项目任务。项目的全部目标是否达成，仍按你的要求判断。';
  const blocker = waiting ? '需要选择文件夹，待办暂不能开始制作。' : unfinished.length ? `有 ${unfinished.length} 段对话需要接续处理。${saved ? '已保存的成果保留。' : '目前不能按全部完成使用。'}` : ongoing.length ? '工作仍在进行，不能把当前结果当作最终交付。' : '没有记录到当前阻塞。';
  const next = waiting ? '你选择文件夹后，Agent 接着原请求做。' : ongoing.length ? 'Agent 继续处理并检查结果。你可随时补充或停止。' : unfinished.length ? '在对应对话中说“继续”，由 Agent 接着处理未完成项。' : saved ? '打开最近成果体验；直接提出下一项修改。' : '在对话里说出目标，明确开始后由 Agent 制作。';
  return `<section class="wb-project-progress"><h3>项目当前情况 · ${esc(project.name)}${c.workspaceRoot ? ' · 独立工作目录' : ''}</h3><p class="wb-inline-note">汇总同一工作目录的相关对话。下面的本轮记录单独保留。</p><dl><dt>已完成</dt><dd>${esc(completed)}</dd><dt>还缺什么</dt><dd>${esc(missing)}</dd><dt>发现与修复</dt><dd>${esc(repaired ? `最近已复测：${repaired}。` : unfinished.length ? '未完成项及具体原因保留在对应对话中。' : '最近成果未记录修补事项。')}</dd><dt>当前卡点</dt><dd>${esc(blocker)}</dd><dt>下一步</dt><dd>${esc(next)}</dd></dl>${saved ? `<a href="${esc(linkFor(saved.conversation.id))}">查看最近成果所在对话</a>` : ''}${unfinished.map(({ conversation }) => `<p><a href="${esc(linkFor(conversation.id))}">接续：${esc(conversation.title)}</a></p>`).join('')}</section>`;
}
function workIssue(turn) {
  if (turn.status === 'stopped') return '这轮工作已停止，已有内容保留';
  if (turn.status === 'interrupted') return '运行中断，尚未完成的工作需要继续处理';
  const error = String(turn.error || '');
  if (/检查|check|verif/i.test(error)) return '成果检查尚未通过，当前不能按完成使用';
  if (/文件.*变化|project.*changed|scope.*changed/i.test(error)) return '项目文件或范围已变化，为避免覆盖已有工作，暂停保存';
  if (/额度|quota|rate.?limit/i.test(error)) return '模型暂时无法继续，消息和已有内容已保留';
  return '本次操作未成功，原始原因保存在技术记录中';
}
function results(c) {
  const turns = c?.turns.filter((t) => t.workspace || ['failed', 'stopped', 'interrupted'].includes(t.status)) || [];
  const project = c ? projectProgress(c) : '';
  if (!turns.length && !project) return '';
  return `<details class="wb-result" id="wb-results"><summary>进度与成果</summary>${project}${turns.length ? '<h3>本对话的工作记录</h3>' : '<p>本对话尚未制作成果。</p>'}${[...turns].reverse().map((t) => {
    const saved = Boolean(t.adoptedAt); const checks = t.functionalChecks || [];
    const passed = t.verification?.status === 'passed';
    const changes = [...(t.changes?.changed || []), ...(t.changes?.deleted || [])]; const completed = !changes.length && passed ? '原有成果已检查，本轮没有修改文件。' : saved ? `本轮成果已保存。${changes.length ? `共变更 ${changes.length} 项文件。` : ''}` : t.workspace ? '工作副本已保留，尚未保存到项目。' : '消息已保存。';
    const latestChecks = [...new Map(checks.map((item) => [item.caseId, item])).values()];
    const verified = latestChecks.filter((item) => item.status === 'passed').map((item) => item.requirement);
    const unresolved = latestChecks.filter((item) => item.status !== 'passed').map((item) => item.requirement);
    const repaired = latestChecks.filter((item) => item.status === 'passed' && checks.some((old) => old.caseId === item.caseId && old.status === 'failed')).map((item) => item.requirement);
    const filenames = Object.keys(t.resultIndex || {});
    return `<section><p><b>${esc(labels[t.status] || t.status)}</b> · ${esc(new Date(t.createdAt).toLocaleString('zh-CN'))}</p><dl><dt>已完成</dt><dd>${esc(completed)}${passed && verified.length ? ` 已实际检查：${esc(verified.join('；'))}。` : ''}</dd><dt>还缺什么</dt><dd>${passed ? '本轮记录的功能检查已通过。' : unresolved.length ? `还需完成：${esc(unresolved.join('；'))}。` : '功能检查尚未确认通过。保存文件不等于可以正常使用。'}</dd><dt>发现与修复</dt><dd>${repaired.length ? `已复测通过：${esc(repaired.join('；'))}。` : t.error ? `本轮停在：${esc(workIssue(t))}。` : '没有记录到需要修补的故障。'}</dd><dt>当前卡点</dt><dd>${active.has(t.status) ? '工作尚未结束，结果仍可能变化。' : t.error ? '本轮尚不能按完成使用。已有内容已保留。' : saved || passed ? '没有记录到阻塞。' : '尚未采用工作副本。'}</dd><dt>下一步</dt><dd>${active.has(t.status) ? 'Agent 继续处理；你可补充要求或停止。' : t.error ? '可在对话中说“继续”，由 Agent 接着处理。' : saved || passed ? '打开成果体验；可直接提出修改要求。' : '在对话中继续说明下一步。'}</dd></dl>${saved && filenames.includes('index.html') ? `<a class="wb-result-link" href="/conversation-preview/${encodeURIComponent(t.projectId)}/index.html?turn=${encodeURIComponent(t.id)}" target="_blank" rel="noopener">打开运行成果</a>` : ''}${saved ? artifactControls(c, t) : ''}${saved ? `<details><summary>成果文件</summary>${filenames.slice(0, 80).map((name) => `<p><a target="_blank" rel="noopener" href="/conversation-preview/${encodeURIComponent(t.projectId)}/${name.split('/').map(encodeURIComponent).join('/')}?turn=${encodeURIComponent(t.id)}">${esc(name)}</a></p>`).join('')}</details>` : ''}<details><summary>技术与检查记录</summary><pre>${esc(JSON.stringify({ changes: t.changes, functionalChecks: checks, error: t.error, tools: t.receipts, children: t.children, calls: t.calls }, null, 2))}</pre></details></section>`;
  }).join('')}</details>`;
}
function keepDetails(selector, content) { const node = $(selector); const open = [...node.querySelectorAll('details[open]')].map((n) => n.id).filter(Boolean); html(selector, content); for (const id of open) document.getElementById(id)?.setAttribute('open', ''); }
function renderModels() {
  const models = data.catalogue?.models || []; if (!selection) selection = structuredClone(current()?.modelSelection || { provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' });
  html('#wb-model', `${models.some((m) => m.id === selection.model) ? '' : `<option value="${esc(selection.model)}">${esc(selection.model)} · 暂不可用</option>`}${models.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('')}`);
  $('#wb-model').value = selection.model;
  const model = models.find((m) => m.id === selection.model); const efforts = model?.efforts || [];
  html('#wb-effort', `${efforts.includes(selection.effort) ? '' : `<option value="${esc(selection.effort)}">${esc(selection.effort)} · 暂不可用</option>`}${efforts.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('')}`); $('#wb-effort').value = selection.effort;
}
function renderComposer() {
  html('#wb-materials', (current()?.materials || []).map((m) => `<div class="wb-chip"><span>材料 · ${esc(m.name)}</span>${button('remove-material', '移除这份材料', 'close', `data-material="${esc(m.id)}"`)}</div>`).join(''));
  html('#wb-chips', references.map((r, i) => `<div class="wb-chip"><span title="${esc(r.text || '')}">引用 · ${esc(r.title)}</span>${button('remove-reference', '移除引用', 'close', `data-index="${i}"`)}</div>`).join(''));
  html('#wb-editing', editTarget ? `<div class="wb-editing">编辑并重新发送会创建修订分支，原对话保留。<button type="button" data-action="cancel-edit">取消编辑</button></div>` : '');
  const p = projectFor(current()); $('#wb-directory').innerHTML = `${icon('folder')} ${esc(p?.name || '选择项目文件夹')}`; $('#wb-directory').title = current()?.workspaceRoot || p?.root || '选择已有文件夹，或在系统选择器中新建文件夹';
  $('#wb-send').disabled = sending || !input.value.trim(); $('#wb-send').title = editTarget ? '编辑并重新发送' : '发送';
  $('#wb-stop').hidden = !activeTurn(current()) && !current()?.artifactRuns?.some((r) => active.has(r.status)) && current()?.turns.at(-1)?.status !== 'awaiting_project'; renderModels();
}
function renderSettings() {
  html('#connection-list', `<div class="wb-settings"><section><h2>阅读</h2><label>工作台字号<select id="wb-font-size">${[14,16,18,20,22].map((n) => `<option value="${n}"${n === data.preferences.fontSize ? ' selected' : ''}>${n} px</option>`).join('')}</select></label><p>只调整对话、项目列表和设置。办公室地图保持原样。</p></section><section><h2>模型连接</h2>${(data.catalogue?.providers || []).map((p) => `<div class="wb-provider"><b>${esc(p.name || p.id)}</b><span>${p.status === 'connected' ? '已连接本机 CLI' : '尚未接入'}</span></div>`).join('')}<p>模型和思考强度在输入框选择。下次发送生效；正在运行的工作沿用原配置。</p><button type="button" data-action="refresh-models">刷新可用模型</button></section><section><h2>保存与版本</h2><p>消息和成果保存在本机。关闭窗口不会停止后台工作。每个窗口分别保存草稿。</p><code>${esc(data.storagePath || '')}</code><p>当前版本：<code>${esc(data.build || '')}</code></p></section></div>`);
}
function hydrateDraft() {
  const d = getDraft(currentId); const remote = data.drafts?.[`${currentId}:${windowId}`];
  if (remote && !d.dirty && remote.revision > (d.revision || 0)) { Object.assign(d, structuredClone(remote)); input.value = d.text; references = d.references || []; editTarget = d.editTarget || null; localStorage.setItem(localKey(currentId), JSON.stringify(d)); }
}
function render() {
  document.body.style.setProperty('--wb-size', `${data.preferences.fontSize || 16}px`);
  const c = current(); const turn = activeTurn(c) || c?.turns.at(-1);
  const model = JSON.stringify(c?.modelSelection); if (model !== observedModel && !modelUpdating) { observedModel = model; if (c?.modelSelection) selection = structuredClone(c.modelSelection); }
  $('#project-dialogue-title').textContent = c?.title || (currentId ? '未找到这段对话' : '新对话');
  $('#project-dialogue-status').textContent = offline ? '连接暂时中断；草稿已保留' : turn ? labels[turn.status] || '状态待确认' : '先讨论。你说开始做，我再动手。';
  const running = data.conversations.some((item) => activeTurn(item)); $('#global-status').textContent = running ? 'Agent 正在工作' : '可以对话'; $('#room-state-title').textContent = $('#global-status').textContent;
  $('#room-state-detail').textContent = turn ? labels[turn.status] : '点同事或地图，直接开始对话。';
  window.irixiOffice?.setTask({ status: running ? 'running' : 'idle', activeRole: running ? 'writer' : null, workItems: [{ role: 'writer', status: running ? 'running' : 'idle' }] }, {});
  renderTree(); renderMessages(c); keepDetails('#wb-activity-slot', activities(c, turn)); keepDetails('#wb-results-slot', results(c));
  html('#wb-errors', `${c?.archived ? '<p class="wb-inline-note">这段对话已归档。恢复后可继续发送。<button type="button" data-action="restore-current">恢复</button></p>' : ''}${turn?.status === 'awaiting_project' ? '<p class="wb-inline-note">开工要求已保存。<button type="button" data-action="directory">选择文件夹并继续</button></p>' : ''}${turn?.error ? '<p class="wb-error">本轮未完成。消息和已有文件已保留。可在下方继续说明要求；原因记录在“进度与成果”中。</p>' : ''}`);
  renderComposer(); renderSettings();
}
async function refresh() { if (refreshBusy) return; refreshBusy = true; try { data = await api('/api/conversation/state'); offline = false; hydrateDraft(); render(); } finally { refreshBusy = false; } }
async function send(event) {
  event?.preventDefault(); if (sending || !input.value.trim()) return;
  if (current()?.archived) { notice('请先恢复这段对话，再发送。', true); return; }
  sending = true; renderComposer(); notice('正在保存消息…');
  const text = input.value; const refs = structuredClone(references); const edit = editTarget && { ...editTarget }; const model = { ...selection }; let cid = currentId;
  try {
    if (!cid) { const d = getDraft(null); d.creationRequestId ||= uuid(); localStorage.setItem(localKey(null), JSON.stringify(d)); const r = await api('/api/conversation/new', { requestId: d.creationRequestId }); cid = r.conversationId; currentId = cid; locationForCurrent(); drafts.set(cid, d); }
    const d = getDraft(cid); const payload = { text, references: refs, modelSelection: model }; const key = JSON.stringify([payload, edit]);
    if (d.pending?.key !== key) d.pending = { key, requestId: uuid() }; localStorage.setItem(localKey(cid), JSON.stringify(d));
    const response = edit ? await actionApi(edit.conversationId, 'fork', { ...payload, messageId: edit.messageId, requestId: d.pending.requestId }) : await actionApi(cid, 'send', { ...payload, requestId: d.pending.requestId });
    delete d.pending;
    const sourceUnchanged = d.text === text && JSON.stringify(d.references || []) === JSON.stringify(refs) && d.editTarget?.messageId === edit?.messageId;
    if (currentId !== cid && sourceUnchanged) { Object.assign(d, { text: '', references: [], editTarget: null, dirty: true }); localStorage.setItem(localKey(cid), JSON.stringify(d)); await saveDraft(cid, d); }
    if (currentId === cid && input.value === text && JSON.stringify(references) === JSON.stringify(refs) && editTarget?.messageId === edit?.messageId) {
      input.value = ''; references = []; editTarget = null; await saveDraft(cid, snapshotDraft(cid)); localStorage.removeItem(localKey(null));
    }
    await refresh(); if (edit) await select(response.result.id);
    notice('消息已保存。');
  } catch (error) { notice(error.message, true); }
  finally { sending = false; renderComposer(); }
}
function showMenu(anchor, entries) {
  $('#wb-menu')?.remove(); const menu = document.createElement('div'); menu.id = 'wb-menu'; menu.className = 'wb-menu'; menu.setAttribute('popover', 'auto');
  for (const entry of entries) {
    if (!entry) { menu.append(document.createElement('hr')); continue; }
    const b = document.createElement('button'); b.type = 'button'; b.textContent = entry.label; b.disabled = entry.disabled || false;
    b.addEventListener('click', async () => { menu.hidePopover(); menu.remove(); try { await entry.run(); } catch (error) { notice(error.message, true); } }); menu.append(b);
  }
  document.body.append(menu); menu.showPopover(); const rect = anchor.getBoundingClientRect(); menu.style.left = `${Math.min(rect.left, innerWidth - menu.offsetWidth - 12)}px`; menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 12))}px`; menu.querySelector('button')?.focus();
}
async function fork(c, message, mode = 'same') {
  const body = { requestId: uuid(), messageId: message.id, workspaceMode: mode };
  if (mode === 'isolated') { body.worktreePath = await dialog({ title: '独立工作目录', note: '仅适用于 Git 项目。请输入一个尚未存在的新目录位置。以当前已提交版本开始；不会回退或复制未提交改动。' }); if (!body.worktreePath) return; }
  const r = await actionApi(c.id, 'fork', body); await refresh(); await select(r.result.id); notice('已创建分支。发送新消息后才开始工作。');
}
async function addReference(descriptor, destinationId = currentId) {
  const response = await api('/api/conversation/reference', { references: [descriptor] });
  if (currentId === destinationId) { references.push(response.references[0]); renderComposer(); captureDraft(); input.focus(); }
  else { const d = getDraft(destinationId); d.references = [...(d.references || []), response.references[0]]; d.dirty = true; localStorage.setItem(localKey(destinationId), JSON.stringify(d)); await saveDraft(destinationId, d); }
}
async function referencePicker() {
  const destinationId = currentId;
  const choices = data.conversations.filter((c) => c.id !== currentId && c.messages.length);
  const cid = await dialog({ title: '引用其他对话', note: '引用内容随下一条消息发送给模型。不会获得修改来源项目的权限。', options: choices.map((c) => ({ value: c.id, label: `${projectFor(c)?.name || '无项目'} / ${c.title}${c.archived ? '（已归档）' : ''}` })), value: choices[0]?.id || '' });
  if (cid) await addReference({ conversationId: cid }, destinationId);
}
function conversationMenu(anchor, cid) {
  const c = data.conversations.find((v) => v.id === cid); if (!c) return; const last = c.messages.at(-1);
  showMenu(anchor, [
    { label: '重命名', run: async () => { const title = await dialog({ title: '对话标题', value: c.title }); if (title !== null) await update(cid, { title }); } },
    { label: c.pinned ? '取消置顶' : '置顶', run: () => update(cid, { pinned: !c.pinned }) },
    { label: c.unread ? '标记为已读' : '标记为未读', run: () => update(cid, { unread: !c.unread }) },
    { label: '移动到项目…', run: async () => { const projectId = await dialog({ title: '所属项目', note: '移动对话不会搬动已经生成的文件。', options: [{ value: '', label: '无项目' }, ...data.projects.map((p) => ({ value: p.id, label: p.name + ' · ' + p.root }))], value: c.projectId || '' }); if (projectId !== null) await update(cid, { projectId }); } },
    { label: '移动到分区…', run: async () => { const sectionId = await dialog({ title: '对话分区', options: [{ value: '', label: '不设分区' }, ...data.sections.map((s) => ({ value: s.id, label: s.name })), { value: '__new', label: '新建分区…' }], value: c.sectionId || '' }); if (sectionId === '__new') { const name = await dialog({ title: '新分区名称' }); if (name) { const s = await api('/api/conversation/sections', { name }); await update(cid, { sectionId: s.id }); } } else if (sectionId !== null) await update(cid, { sectionId }); } }, null,
    { label: '继续这段对话', run: () => select(cid) },
    { label: '创建分支聊天', disabled: !last || Boolean(activeTurn(c)), run: () => fork(c, last) },
    { label: '在独立工作目录分支…', disabled: !last || !c.projectId || Boolean(activeTurn(c)), run: () => fork(c, last, 'isolated') }, null,
    { label: '复制对话内容', run: () => copy(c.messages.map((m) => `${m.role === 'user' ? '你' : 'IRiXI'}\n${m.text}`).join('\n\n')) },
    { label: '复制深度链接', run: () => copy(linkFor(cid, null, Boolean(window.webkit?.messageHandlers?.irixiHost))) },
    ...(projectFor(c) ? [{ label: '复制项目位置', run: () => copy(c.workspaceRoot || projectFor(c).root) }] : []),
    { label: '在当前草稿中引用', disabled: cid === currentId || !c.messages.length, run: () => addReference({ conversationId: cid }) },
    { label: '在新窗口中打开', run: () => { const url = new URL(linkFor(cid)); url.searchParams.set('window', uuid()); window.open(url.href, '_blank'); } }, null,
    { label: c.archived ? '恢复对话' : c.turns.some((t) => active.has(t.status)) ? '归档（工作继续）' : '归档', run: () => update(cid, { archived: !c.archived }) },
  ]);
}

// Preserve the office scene and its map/settings controls. Replace only the work area.
document.body.dataset.backend = 'openoffice'; document.body.dataset.workbench = 'true'; document.body.dataset.openofficeView = 'office';
const style = document.createElement('link'); style.rel = 'stylesheet'; style.href = '/conversation-workbench.css'; document.head.append(style);
document.querySelectorAll('dialog, #view-desk, #view-review, .office-float, .room-stage .role-strip').forEach((n) => n.remove());
document.querySelectorAll('.main-nav button:not([data-view-target="office"])').forEach((n) => n.remove());
$('#connections-title').textContent = '设置'; $('#view-connections .eyebrow').textContent = 'PERSONAL SETTINGS'; $('#view-connections .page-heading p').textContent = '调整阅读方式，查看模型连接。';
$('#project-sidebar').innerHTML = `<header class="sidebar-header"><h2>项目与对话</h2>${button('close-sidebar', '收起项目列表', 'close')}</header><div class="wb-sidebar-actions"><button class="wb-label-button" type="button" data-action="new">${icon('plus')}新对话</button><button class="wb-label-button" type="button" data-action="new-project">${icon('folder')}添加项目</button></div><div id="wb-tree" class="wb-tree"></div><button class="wb-label-button" type="button" data-action="archives">已归档的对话</button>`;
const panel = $('#project-dialogue-panel');
$('.conversation-column').innerHTML = `<div class="wb-scroll"><div id="wb-history" aria-live="polite" aria-relevant="additions"></div><div id="wb-activity-slot"></div><div id="wb-errors"></div><div id="wb-results-slot"></div></div><form id="project-instructions-form" class="message-form"><div id="wb-editing"></div><div class="wb-compose-box"><div id="wb-materials" class="wb-chips"></div><div id="wb-chips" class="wb-chips"></div><label class="visually-hidden" for="project-instructions-text">发送消息</label><textarea id="project-instructions-text" rows="2" maxlength="20000" placeholder="说说你的想法，或交代下一步…"></textarea><div class="wb-tools">${button('composer-menu', '添加材料或引用', 'plus')}<button id="wb-directory" type="button" class="wb-label-button wb-directory" data-action="directory"></button><div class="wb-models"><select id="wb-model" aria-label="模型"></select><select id="wb-effort" aria-label="思考强度"></select></div>${button('stop', '停止当前工作', 'stop', 'id="wb-stop" hidden')}<button id="wb-send" type="submit" class="wb-icon wb-send" aria-label="发送">${icon('send')}</button></div></div><div id="project-instructions-status" class="wb-compose-note" role="status">Enter 发送 · Shift+Enter 换行</div></form>`;
const input = $('#project-instructions-text'); const form = $('#project-instructions-form'); const status = $('#project-instructions-status');
attachProjectMapHotspot({ shell: $('.office-shell'), sceneProvider: () => window.irixiOffice?.scene, onActivate: () => { sidebar($('#project-sidebar').hidden); if (!$('#project-sidebar').hidden && currentId) open(); } });
const materialInput = document.createElement('input'); materialInput.type = 'file'; materialInput.multiple = true; materialInput.hidden = true; document.body.append(materialInput);
materialInput.addEventListener('change', async () => {
  const cid = materialInput.dataset.cid;
  try { for (const file of materialInput.files) { if (file.size > 1000000) throw new Error('单个材料最多 1 MB。可将较大资料放到文件夹，在对话中说明位置。'); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await actionApi(cid, 'material', { requestId: uuid(), name: file.name, base64: btoa(binary) }); } await refresh(); notice('材料已加入。发送消息后按你的要求读取。'); } catch (error) { notice(error.message, true); } finally { materialInput.value = ''; }
});
document.addEventListener('input', (event) => { const key = event.target.dataset.runKey; if (!key) return; const box = event.target.closest('.wb-artifact'); artifactInputs.set(key, { args: box.querySelector('[data-run-args]').value, stdin: box.querySelector('[data-run-stdin]').value }); });
form.addEventListener('submit', send);
input.addEventListener('input', () => { captureDraft(); renderComposer(); });
input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } });
document.addEventListener('change', async (event) => {
  try {
    if (event.target.id === 'wb-font-size') { await api('/api/conversation/preferences', { fontSize: Number(event.target.value) }); await refresh(); }
    if (['wb-model', 'wb-effort'].includes(event.target.id)) {
      const model = data.catalogue.models.find((m) => m.id === $('#wb-model').value);
      selection = { provider: 'desktop-codex', model: $('#wb-model').value, effort: event.target.id === 'wb-model' ? model.defaultEffort : $('#wb-effort').value };
      renderModels(); modelUpdating = true; try { if (currentId) await update(currentId, { modelSelection: selection }); } finally { modelUpdating = false; } notice('下次发送使用此配置。当前运行不变。');
    }
  } catch (error) { notice(error.message, true); }
});
let quoteSelection = null;
document.addEventListener('pointerdown', (event) => {
  quoteSelection = null;
  if (!event.target.closest('[data-action="quote-message"]')) return;
  const selected = window.getSelection(); const node = selected?.anchorNode?.parentElement?.closest('.wb-body');
  if (selected && !selected.isCollapsed && node && node === selected.focusNode?.parentElement?.closest('.wb-body')) quoteSelection = { messageId: node.closest('[data-message]').dataset.message, text: selected.toString() };
});
document.addEventListener('click', async (event) => {
  const referenceLink = event.target.closest('[data-reference-link]'); if (referenceLink) { event.preventDefault(); const u = new URL(referenceLink.href); await select(u.searchParams.get('conversation'), u.searchParams.get('message')); return; }
  const node = event.target.closest('button'); if (!node) return;
  try {
    if (node.dataset.select) return await select(node.dataset.select);
    if (node.dataset.collapse) { const set = new Set(data.preferences.collapsedProjects); set.has(node.dataset.collapse) ? set.delete(node.dataset.collapse) : set.add(node.dataset.collapse); await api('/api/conversation/preferences', { collapsedProjects: [...set] }); return await refresh(); }
    if (node.matches('[data-view-target="connections"]')) { renderSettings(); return showView('connections'); }
    if (node.matches('[data-view-target="office"]')) return showView('office');
    if (node.matches('[data-project-dialogue-expand]')) { expanded = !expanded; localStorage.setItem('irixi.p0.expanded', String(expanded)); return open(); }
    if (node.matches('[data-project-dialogue-close]')) { panel.hidden = true; return; }
    if (node.matches('[data-project-dialogue-list]')) return sidebar($('#project-sidebar').hidden);
    const c = current(); const message = c?.messages.find((m) => m.id === node.closest('[data-message]')?.dataset.message);
    switch (node.dataset.action) {
      case 'remove-material': await actionApi(currentId, 'material', { removeId: node.dataset.material }); await refresh(); break;
      case 'run-artifact': { const box = node.closest('.wb-artifact'); const args = box.querySelector('[data-run-args]').value; const stdin = box.querySelector('[data-run-stdin]').value; await actionApi(currentId, 'run-artifact', { requestId: uuid(), turnId: node.dataset.turn, target: node.dataset.target, arguments: args ? args.split('\n') : [], stdin }); await refresh(); break; }
      case 'new': await create(); break;
      case 'new-project': { const cid = await create(); await chooseDirectory(cid); break; }
      case 'new-project-chat': await create(node.dataset.project); break;
      case 'close-sidebar': sidebar(false); break;
      case 'directory': await chooseDirectory(); break;
      case 'stop': await actionApi(currentId, 'stop', {}); await refresh(); break;
      case 'conversation-menu': conversationMenu(node, node.dataset.cid); break;
      case 'copy-code': await copy(node.closest('.wb-code').querySelector('code').textContent); break;
      case 'copy-message': await copy(message.text); break;
      case 'quote-message': await addReference({ conversationId: c.id, messageId: message.id, ...(quoteSelection?.messageId === message.id ? { selection: quoteSelection.text } : {}) }); quoteSelection = null; break;
      case 'edit-message': editTarget = { conversationId: c.id, messageId: message.id, previousDraft: editTarget?.previousDraft || { text: input.value, references: structuredClone(references) } }; input.value = message.text; references = structuredClone(message.references || []); captureDraft(); renderComposer(); input.focus(); break;
      case 'cancel-edit': input.value = editTarget?.previousDraft?.text || ''; references = structuredClone(editTarget?.previousDraft?.references || []); editTarget = null; captureDraft(); renderComposer(); notice('已取消编辑，恢复此前的草稿。'); break;
      case 'fork-message': await fork(c, message); break;
      case 'message-menu': showMenu(node, [{ label: '复制消息深度链接', run: () => copy(linkFor(c.id, message.id, Boolean(window.webkit?.messageHandlers?.irixiHost))) }, { label: '从这里创建分支聊天', run: () => fork(c, message) }, { label: '在独立工作目录分支…', run: () => fork(c, message, 'isolated'), disabled: !c.projectId }]); break;
      case 'remove-reference': references.splice(Number(node.dataset.index), 1); captureDraft(); renderComposer(); break;
      case 'composer-menu': showMenu(node, [{ label: '添加文件材料…', run: async () => { if (!currentId) await create(); materialInput.dataset.cid = currentId; materialInput.click(); } }, { label: '引用其他对话…', run: referencePicker }, { label: '粘贴对话链接并引用…', run: async () => { const raw = await dialog({ title: '对话深度链接' }); if (!raw) return; const u = new URL(raw); if (!(u.protocol === 'irixi:' || u.origin === location.origin)) throw new Error('请使用本机产品中的对话链接。'); await addReference({ conversationId: u.searchParams.get('conversation') || u.searchParams.get('id'), messageId: u.searchParams.get('message') }); } }]); break;
      case 'archives': { const archived = data.conversations.filter((v) => v.archived); if (!archived.length) { notice('没有已归档的对话。'); break; } const cid = await dialog({ title: '已归档对话', options: archived.map((v) => ({ value: v.id, label: v.title })), value: archived[0].id, submit: '打开' }); if (cid) await select(cid); break; }
      case 'restore-current': await update(currentId, { archived: false }); break;
      case 'refresh-models': await api('/api/conversation/models'); await refresh(); notice('可用模型已刷新。'); break;
      default: if (node.matches('[data-project-chat-new], [data-open-dialog]')) await create();
    }
  } catch (error) { notice(error.message, true); }
});
window.addEventListener('irixi:coworker', open); window.addEventListener('irixi:arrival', open);
window.addEventListener('popstate', () => { const q = new URLSearchParams(location.search); void select(q.get('conversation'), q.get('message')); });
window.addEventListener('pagehide', () => { snapshotDraft(); });
const initial = getDraft(currentId); input.value = initial.text; references = initial.references || []; editTarget = initial.editTarget || null;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('irixi-workbench-windows') : null;
const instanceId = uuid(); let settledIdentity = false;
if (channel) { channel.onmessage = (event) => {
  const m = event.data; if (m.windowId !== windowId || m.instanceId === instanceId) return;
  if (m.type === 'probe' && settledIdentity) channel.postMessage({ type: 'owned', windowId, instanceId });
  if (m.type === 'owned' && !settledIdentity) { const old = snapshotDraft(); windowId = uuid(); sessionStorage.setItem('irixi.workbench.window', windowId); old.revision = 0; localStorage.setItem(localKey(currentId), JSON.stringify(old)); locationForCurrent(); }
}; channel.postMessage({ type: 'probe', windowId, instanceId }); setTimeout(() => { settledIdentity = true; }, 250); }
locationForCurrent(); open(); sidebar(localStorage.getItem('irixi.workbench.sidebar') !== 'false');
refresh().catch((error) => notice(error.message, true));
setInterval(() => refresh().catch((error) => { offline = true; notice(error.message, true); }), 1800);
