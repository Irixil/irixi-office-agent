import { attachProjectMapHotspot } from './native-project-hotspot.js';
import { escapeHtml as esc, renderMarkdown, icon } from './conversation-format.js';
import { coworkerRuntimeState } from './office-geometry.js';

const $ = (s) => document.querySelector(s);
const active = new Set(['queued', 'understanding', 'waiting', 'working', 'stopping']);
const labels = { queued: '消息已保存，准备开始', understanding: '正在理解你的要求', waiting: '等待同项目的工作结束', working: '正在处理', stopping: '正在停止，等待工具退出', stopped: '已停止', interrupted: '工作中断，记录已保留', failed: '本轮未完成', completed: '本轮已结束', superseded: '已按新消息接续', awaiting_project: '等待选择项目文件夹' };
const toolLabels = { read: '读取文件', grep: '查找内容', find: '查找文件', ls: '查看文件夹', write: '写入文件', edit: '修改文件', bash: '运行命令', delegate_readonly: '安排只读助手', delegate_parallel: '安排并行写入助手', noobi_run: '制作与试玩小游戏', verify_behavior: '实际检查功能', check: '检查功能' };
const uuid = () => crypto.randomUUID();
const query = new URLSearchParams(location.search);
// A distinct URL identity also separates native new windows; sessionStorage alone
// can be cloned when a browser duplicates a tab.
let windowId = query.get('window') || sessionStorage.getItem('irixi.workbench.window') || uuid();
sessionStorage.setItem('irixi.workbench.window', windowId);
let currentId = query.get('conversation');
let data = { projects: [], conversations: [], sections: [], preferences: {}, catalogue: { models: [], providers: [] } };
let expanded = localStorage.getItem(`irixi.workbench.expanded.${windowId}`) === 'true';
let selectedRole = query.get('colleague'); let roleListing = false;
let roleDrafts = {}; try { roleDrafts = JSON.parse(localStorage.getItem(`irixi.workbench.role-drafts.${windowId}`)) || {}; } catch {}
let reducedMotion = localStorage.getItem('irixi.workbench.reduced-motion') === 'true';
const species = { researcher: 'hamster', writer: 'mouse', reviewer: 'chinchilla', steward: 'mole', archivist: 'fancy-rat' };
const roleNames = { researcher: '仓鼠学习同事', writer: '小鼠工具开发同事', reviewer: '龙猫小游戏开发同事', steward: '鼹鼠Agent开发同事', archivist: '花枝鼠档案记忆同事' };
const roleProfile = (id) => data.colleagues?.find((r) => r.id === id);
const roleName = (id) => roleProfile(id)?.name || roleNames[id] || '尚未分配同事';
const sceneLabels = { idle: '休息中', completed: '本轮已结束', working: '正在工作', understanding: '正在理解', creating: '正在准备', queued: '准备开始', waiting: '等待其他工作', waiting_user: '等待你的答复', awaiting_project: '等待文件夹', handoff: '正在交接', stopping: '正在停止', stopped: '已停止', failed: '工作受阻', interrupted: '工作中断', unknown: '状态待确认' };
let references = []; let editTarget = null; let selection = null;
let sending = false; let offline = false; let focusedMessage = query.get('message');
let modelUpdating = false; let observedModel = '';
let deepseekConnection = null; let deepseekBusy = false;
let openaiConnection = null; let openaiBusy = false;
let draftTimer; let refreshBusy = false; let draftQueue = Promise.resolve();
let memoryState = null, memoryContext = null, memoryTarget = null, memoryEditor = null, memoryBusy = false, memoryError = '', memoryNotice = '', memoryRequest = 0, memoryMutation = null;
const memoryLimits = {title:160, text:4000};
try { memoryEditor = JSON.parse(localStorage.getItem(`irixi.memory.editor.${windowId}`)) || null; } catch {}
const drafts = new Map(); const artifactInputs = new Map(); const rendered = new Map(); const nativeRequests = new Map();
const current = () => data.conversations.find((c) => c.id === currentId);
const projectFor = (c) => data.projects.find((p) => p.id === c?.projectId);
const activeTurn = (c) => c?.turns.findLast((t) => active.has(t.status) || t.status === 'awaiting_project');
const pendingHandoff = (c) => c?.work?.transfers?.findLast((t) => ['requested', 'receiving'].includes(t.status));
const workRunning = (c) => pendingHandoff(c) || activeTurn(c) || c?.handoffRuns?.findLast((t) => active.has(t.status)) || c?.artifactRuns?.findLast((t) => active.has(t.status));
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
  if (!response.ok) { const error = new Error(value?.error?.message || '操作未完成。原内容与草稿已保留。'); error.status = response.status; throw error; }
  return value;
}
const actionApi = (cid, name, body) => api(`/api/conversation/${encodeURIComponent(cid)}/${name}`, body);
function locationForCurrent() {
  const url = new URL(location.href); url.searchParams.set('window', windowId); url.searchParams.set('view', 'office'); url.searchParams.delete('task');
  currentId ? url.searchParams.set('conversation', currentId) : url.searchParams.delete('conversation');
  selectedRole ? url.searchParams.set('colleague', selectedRole) : url.searchParams.delete('colleague');
  focusedMessage ? url.searchParams.set('message', focusedMessage) : url.searchParams.delete('message'); history.replaceState(null, '', url);
}
function showView(name) { document.querySelectorAll('.view').forEach((n) => n.classList.toggle('is-active', n.id === `view-${name}`)); document.body.dataset.openofficeView = name; syncOffice(); }
function open() { showView('office'); panel.hidden = false; panel.classList.toggle('is-expanded', expanded); $('[data-project-dialogue-expand]').textContent = expanded ? '收起' : '展开'; $('[data-project-dialogue-expand]').setAttribute('aria-expanded', String(expanded)); syncOffice(); }
function sidebar(visible) { $('#project-sidebar').hidden = !visible; $('.office-shell').classList.toggle('has-sidebar', visible); $('.office-map-project-button')?.setAttribute('aria-expanded', String(visible)); }
function draftKey(cid) { return cid || (selectedRole ? `new-role-${selectedRole}` : 'new'); }
function localKey(cid) { return `irixi.workbench.draft.${windowId}.${draftKey(cid)}`; }
function getDraft(cid) {
  const key = draftKey(cid);
  if (drafts.has(key)) return drafts.get(key);
  let saved; try { saved = JSON.parse(localStorage.getItem(localKey(cid))); } catch {}
  const remote = data.drafts?.[`${cid}:${windowId}`];
  const legacyKey = `irixi.p0.draft.${cid || 'new'}`;
  const legacy = (cid || !selectedRole) && !saved && !remote && !localStorage.getItem(`irixi.workbench.migrated.${cid || 'new'}`) ? localStorage.getItem(legacyKey) : null;
  const value = saved || remote || { text: legacy || '', references: [], editTarget: null, revision: remote?.revision || 0, dirty: Boolean(legacy) };
  if (remote && (remote.revision || 0) > (value.revision || 0) && !saved?.dirty) Object.assign(value, remote);
  if (legacy) { localStorage.setItem(localKey(cid), JSON.stringify(value)); localStorage.setItem(`irixi.workbench.migrated.${cid || 'new'}`, windowId); }
  drafts.set(key, value); return value;
}
function snapshotDraft(cid = currentId) {
  const d = getDraft(cid); Object.assign(d, { text: input.value, references: structuredClone(references), editTarget, dirty: true });
  if (!cid && selection) d.modelSelection = structuredClone(selection);
  localStorage.setItem(localKey(cid), JSON.stringify(d)); return d;
}
function saveDraft(cid, snapshot) {
  if (!cid || cid === 'new' || cid.startsWith('new-role-')) return Promise.resolve();
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
async function select(cid, mid = null, { role = null, list = false } = {}) {
  if (memoryTarget === 'office') memoryTarget = null;
  clearTimeout(draftTimer); const oldId = currentId; const oldDraft = snapshotDraft(oldId); void saveDraft(oldId, oldDraft);
  currentId = cid; selectedRole = role || current()?.work?.ownerId || null; roleListing = list; focusedMessage = mid; locationForCurrent();
  if (current()?.work?.ownerId && !current().turns.length) { roleDrafts[current().work.ownerId] = cid; localStorage.setItem(`irixi.workbench.role-drafts.${windowId}`, JSON.stringify(roleDrafts)); }
  const d = getDraft(cid); input.value = d.text; references = structuredClone(d.references || []); editTarget = d.editTarget || null;
  selection = structuredClone(current()?.modelSelection || d.modelSelection || selection || data.catalogue?.defaultSelection || { provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' });
  $('#wb-history').replaceChildren(); rendered.delete('#wb-history'); render(); renderComposer(); open();
  if (innerWidth < 800) sidebar(false); input.focus();
  if (current()?.unread) { await actionApi(cid, 'update', { unread: false }); await refresh(); }
}
async function create(projectId = null, colleagueId = selectedRole, { carryDraft = false } = {}) {
  const origin = draftKey(currentId); const draft = carryDraft ? snapshotDraft() : null;
  const response = await api('/api/conversation/new', { projectId, colleagueId, requestId: uuid() });
  await refresh();
  if (draft) {
    const moved = structuredClone(draft); moved.revision = 0; drafts.set(response.conversationId, moved); localStorage.setItem(localKey(response.conversationId), JSON.stringify(moved));
    if (colleagueId) { roleDrafts[colleagueId] = response.conversationId; localStorage.setItem(`irixi.workbench.role-drafts.${windowId}`, JSON.stringify(roleDrafts)); }
  }
  if (draftKey(currentId) === origin) await select(response.conversationId);
  if (draft && origin.startsWith('new')) { drafts.delete(origin); localStorage.removeItem(localKey(origin)); }
  return response.conversationId;
}
async function openRole(role) {
  if (!species[role]) return;
  if (!data.colleagues) await refresh();
  if (!data.colleagues) { notice('正在读取这位同事的工作，请稍后再点一次。'); return; }
  const works = (roleProfile(role)?.works || []).filter((w) => w.unfinished);
  const saved = data.conversations.find((c) => c.id === roleDrafts[role] && c.work?.ownerId === role && !c.archived && !c.turns.length);
  const draft = saved && getDraft(saved.id);
  const draftId = saved && (draft.text || draft.references?.length || saved.materials?.length) ? saved.id : null;
  await select(works.length === 1 ? works[0].conversationId : !works.length ? draftId : null, null, { role, list: works.length > 1 });
}
function officeTask() {
  return { disconnected: offline || !data.colleagues, colleagues: (data.colleagues || []).map((person) => ({ ...person, works: person.works.map((work) => {
    const c = data.conversations.find((item) => item.id === work.conversationId);
    const approval = c?.turns.some((t) => active.has(t.status) && t.noobiJobs?.some((j) => j.approvals?.some((a) => ['pending', 'submitting'].includes(a.status))));
    return approval && ['working', 'waiting'].includes(work.status) ? { ...work, status: 'waiting_user' } : work;
  }) })) };
}
function syncOffice() {
  const panelOpen = typeof panel !== 'undefined' && !panel.hidden && document.body.dataset.openofficeView === 'office';
  window.irixiOffice?.setTask(officeTask(), { engagedRole: panelOpen ? current()?.work?.ownerId || selectedRole : null, reducedMotion,
    bottomInset: panelOpen && !expanded ? Math.max(0, innerHeight - panel.getBoundingClientRect().top) : 0 });
  document.body.classList.toggle('wb-reduced-motion', reducedMotion);
}
function renderRoles() {
  const task = officeTask();
  const focusedRole = document.activeElement?.closest?.('#wb-role-access [data-role]')?.dataset.role;
  html('#wb-role-access', task.colleagues.map((person) => { const state = coworkerRuntimeState(task, person.id); const count = person.works.filter((w) => w.unfinished).length;
    const label = !count && person.works.length && person.works.every((w) => w.lifecycle === 'completed') ? '工作已结束' : sceneLabels[state.status] || state.status;
    return `<button type="button" data-role="${esc(person.id)}" aria-pressed="${selectedRole === person.id}" title="${esc(person.specialty)}"><span class="coworker-portrait species-${species[person.id]}" aria-hidden="true"></span><span><b>${esc(person.name.replace('同事', ''))}</b><small>${esc(label)}${count > 1 ? ` · ${count} 项` : ''}</small></span></button>`;
  }).join(''));
  if (focusedRole) document.querySelector(`#wb-role-access [data-role="${focusedRole}"]`)?.focus({ preventScroll: true });
  const person = task.colleagues.find((p) => p.id === selectedRole);
  const workRow = (work) => `<button type="button" class="wb-role-work" data-role-work="${esc(work.conversationId)}"><span><b>${esc(work.title)}</b><small>${esc(data.projects.find((p) => p.id === work.projectId)?.name || '无项目')} · ${work.responsibility === 'helper' ? '协助' : '负责'}${work.archived ? ' · 已归档' : ''}</small></span><span>${esc(!work.unfinished && work.lifecycle === 'completed' ? '工作已结束' : work.status === 'completed' ? '本轮结束，可继续' : sceneLabels[work.status] || labels[work.status] || work.status)}</span></button>`;
  html('#wb-role-work-list', !currentId && person ? `<section class="wb-role-works"><h2>${roleListing ? '要接着哪项工作？' : '最近的工作'}</h2>${person.works.filter((w) => w.unfinished).map(workRow).join('')}<details${!roleListing ? ' open' : ''}><summary>最近与已完成记录</summary>${person.works.filter((w) => !w.unfinished).slice(-8).reverse().map(workRow).join('') || '<p>还没有历史记录，可以直接开始交流。</p>'}</details>${roleListing ? `<button type="button" data-action="new-role-chat">与${esc(person.name)}开始新对话</button>` : ''}</section>` : '');
  form.hidden = roleListing;
  $('#wb-history').hidden = roleListing;
  html('#wb-memory-entry', selectedRole === 'archivist' || current()?.work?.ownerId === 'archivist' ? '<button type="button" class="wb-label-button" data-action="memory-open">查看与管理记忆</button>' : '');
}
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
  if (!cid) cid = await create(null, selectedRole, { carryDraft: true });
  const original = data.conversations.find((c) => c.id === cid);
  const waiting = original.turns.findLast((t) => t.status === 'awaiting_project')?.id || null;
  const chosen = native('choose-directory');
  const path = chosen ? (await chosen)?.path : await dialog({ title: '项目文件夹位置', note: '本机应用会打开系统文件夹选择器。浏览器中可填写一个已有文件夹的完整路径。选好后沿用已说过的要求。', value: projectFor(original)?.root || '' });
  if (!path) { notice('已取消选择。原请求和草稿保留。'); return; }
  await actionApi(cid, 'bind-project', { path, pendingTurnId: waiting, requestId: uuid() }); await refresh();
  notice(waiting ? '文件夹已选定，正在接着做。' : '项目文件夹已选定。');
}
function row(c, standalone = false) {
  return `<div class="wb-row${standalone ? ' standalone' : ''}${c.id === currentId ? ' selected' : ''}"><button type="button" data-select="${esc(c.id)}" title="${esc(c.title)}">${esc(c.title)}</button>${workRunning(c) ? '<span class="wb-running" aria-label="正在运行"></span>' : c.unread ? '<span class="wb-dot" aria-label="未读"></span>' : ''}${button('conversation-menu', '对话操作', 'more', `data-cid="${esc(c.id)}"`)}</div>`;
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
  const artifactTurn = c.turns.find((t) => t.id === message.turnId);
  const node = document.createElement('article'); node.className = `wb-message ${message.role}`; node.dataset.message = message.id; node.id = message.id;
  const ongoing = c.turns.some((t) => t.id === message.turnId && (active.has(t.status) || t.status === 'awaiting_project'));
  node.innerHTML = `<div class="wb-author">${message.role === 'user' ? '你' : esc(message.colleagueId ? roleName(message.colleagueId) : 'IRiXI · 历史记录')}${message.inherited ? ' · 分支继承' : ''}</div><div class="wb-body">${renderMarkdown(message.text, { artifactTurn })}</div>${message.references?.length ? `<p class="wb-inline-note">已引用：${message.references.map((r) => `<a href="${esc(linkFor(r.conversationId, r.messageId))}" data-reference-link>${esc(r.title)}</a>`).join('、')}</p>` : ''}<div class="wb-message-actions">${button('copy-message', '复制消息', 'copy')}${button('quote-message', '引用消息或选中片段', 'quote')}${message.role === 'user' ? button('edit-message', '编辑并重新发送', 'edit', ongoing ? 'disabled' : '') : ''}${button('fork-message', '从这里创建分支聊天', 'branch', ongoing ? 'disabled' : '')}${button('message-menu', '更多消息操作', 'more')}<time datetime="${esc(message.at)}">${esc(new Date(message.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</time></div>`;
  node.dataset.version = JSON.stringify([message.text, ongoing]); node.dataset.artifactVersion = artifactTurn?.adoptedAt || ''; return node;
}
function renderMessages(c) {
  const history = $('#wb-history'); const scroll = $('.wb-scroll'); const nearEnd = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 130;
  if (!c?.messages.length) { html('#wb-history', `<div class="wb-welcome"><h2>${selectedRole ? `和${esc(roleName(selectedRole))}聊聊` : '我们要做什么？'}</h2><p>先聊想法。你说开始做，我再动手。</p><p>${esc(roleProfile(selectedRole)?.specialty || '可以选择同事，或从项目列表接着已有工作继续。')}</p></div>`); return; }
  if (!history.querySelector('[data-message]')) history.replaceChildren();
  const keep = new Set(c.messages.map((m) => m.id)); for (const node of history.children) if (!keep.has(node.dataset.message)) node.remove();
  for (const message of c.messages) {
    const existing = document.getElementById(message.id);
    const ongoing = c.turns.some((t) => t.id === message.turnId && (active.has(t.status) || t.status === 'awaiting_project'));
    if (!existing) history.append(messageNode(message, c));
    else {
      if (existing.dataset.version !== JSON.stringify([message.text, ongoing])) {
        // A status refresh does not replace selected message text.
        existing.querySelectorAll('[data-action="edit-message"],[data-action="fork-message"]').forEach((b) => { b.disabled = ongoing; });
        existing.dataset.version = JSON.stringify([message.text, ongoing]);
      }
      const artifactTurn = c.turns.find((t) => t.id === message.turnId);
      const artifactVersion = artifactTurn?.adoptedAt || '';
      if (existing.dataset.artifactVersion !== artifactVersion) {
        existing.querySelector('.wb-body').innerHTML = renderMarkdown(message.text, { artifactTurn });
        existing.dataset.artifactVersion = artifactVersion;
      }
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
function progressTime(turn) {
  const times = [turn.lastProgressAt, turn.startedAt, turn.createdAt, turn.finishedAt,
    ...(turn.receipts || []).map((r) => r.occurredAt), ...(turn.events || []).map((e) => e.at),
    ...(turn.calls || []).flatMap((call) => [call.startedAt, call.finishedAt]),
    ...(turn.children || []).map(progressTime), ...(turn.noobiJobs || []).flatMap((job) => [job.createdAt, job.finishedAt, ...(job.events || []).map((e) => e.at)])];
  return times.filter((value) => Number.isFinite(Date.parse(value))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}
function handoffsFor(c, turnId) {
  return (c?.work?.transfers || []).filter((transfer) => transfer.sourceTurnId === turnId).map((transfer) => ({ transfer,
    run: c.handoffRuns?.find((run) => run.id === transfer.receiverId && run.workId === c.work.id) })).filter(({ run }) => run);
}
const noobiReasoningEvent = (event) => /reasoning/i.test(event.method || '') || /^(?:(?:Planner|Implementer|Reviewer|Tester)\s*[·:—-]\s*)?reasoning(?:\s|:|$)/i.test(event.title || '');
const noobiProgressEvent = (event) => !['noobi_heartbeat','noobi_process'].includes(event.type) && !/agentMessage\/delta|userMessage/i.test(event.method || '') && !noobiReasoningEvent(event);
function noobiEventLabel(event) {
  if (noobiReasoningEvent(event)) return '内部思考记录';
  const fixed = {noobi_thread:'制作会话已建立',noobi_role:'制作同事开始参与',noobi_waiting_approval:'等待你的答复',noobi_approval_resolved:'答复已送达',noobi_approval_expired:'答复已过期',noobi_permission_denied:'这次操作未获许可',noobi_request_error:'工具请求未执行',noobi_asset_saved:'游戏素材已保存',noobi_assets:'素材记录已更新'};
  if (fixed[event.type]) return fixed[event.type];
  const phase = String(event.phase || '').toLowerCase(), method = String(event.method || '').toLowerCase();
  const title = String(event.title || '').replace(/^(Planner|Implementer|Reviewer|Tester)\s*[·:—-]\s*/i,'').toLowerCase();
  if (/^(implementation|planning|review|playtest) (ready|completed)$/.test(title)) return '这一步已返回结果';
  const stageLabel = (stage) => /playtest|gameplay|experience|试玩/.test(stage) ? '正在试玩' : /repair|fix|修补/.test(stage) ? '修补问题' : /verif|review|check|evaluat|validation/.test(stage) ? '检查成果' : /implement|build|develop|^code$/.test(stage) ? '制作小游戏' : /plan|analy|workspace|inspect/.test(stage) ? '检查项目' : /^brief$/.test(stage) ? '梳理游戏要求' : null;
  const titleLabel = stageLabel(title); if (titleLabel) return titleLabel;
  if (/imagegeneration|image_gen|media/.test(method)) return '处理游戏素材';
  if (/commandexecution|filechange/.test(method)) return '执行制作步骤';
  const phaseLabel = stageLabel(phase); if (phaseLabel) return phaseLabel;
  if (event.type === 'noobi_heartbeat' || event.type === 'noobi_process') return '执行端仍有响应';
  return '收到制作回执';
}
function noobiProgress(job) {
  if (job.status === 'completed') return '制作与试玩已通过';
  if (job.status === 'failed') return '小游戏制作未完成';
  if (job.status === 'stopped' || job.status === 'interrupted') return labels[job.status];
  if (job.approvals?.some((a)=>['pending','submitting'].includes(a.status))) return '等待你的答复';
  const event = [...(job.events || [])].reverse().find(noobiProgressEvent);
  return event ? noobiEventLabel(event) : '制作请求已保存，等待执行回执';
}
function noobiStatus(c) {
  const liveJobs = (c?.turns || []).flatMap((t)=>t.noobiJobs || []).filter((j)=>['running','waiting','stopping'].includes(j.status));
  const jobs = liveJobs.length ? liveJobs : c?.turns.at(-1)?.noobiJobs || [];
  return jobs.map((job)=>{
    const event = [...(job.events || [])].reverse().find(noobiProgressEvent);
    const at = event?.at || job.createdAt; const quiet = ['running','waiting'].includes(job.status) && at && Date.now()-Date.parse(at)>60000;
    return `<section class="wb-noobi-status" aria-live="polite"><b>${esc(noobiProgress(job))}</b><p class="wb-inline-note">${at ? `最近制作回执：${esc(new Date(at).toLocaleTimeString('zh-CN'))}。` : ''}${quiet ? '尚未收到新的制作结果，运行尚未结束。' : ['running','waiting'].includes(job.status) ? '运行尚未结束，可补充要求或停止。' : ''} 详细步骤保留在本轮工作过程中。</p></section>`;
  }).join('');
}

function turnStateLabel(turn) { return turn?.providerTermination?.status === 'unconfirmed' ? '停止处理中：模型调用收尾未确认' : labels[turn?.status] || '状态待确认'; }
function activity(turn, historical = false, handoffs = []) {
  if (!turn) return '';
  const receipts = turn.receipts || []; const pendingTool = receipts.findLast((r) => r.eventType === 'start' && !receipts.some((end) => end.toolCallId === r.toolCallId && end.eventType === 'end'));
  const latest = [progressTime(turn), ...handoffs.map(({ run }) => progressTime(run))].filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  const handing = handoffs.findLast(({ transfer, run }) => ['requested', 'receiving'].includes(transfer.status) || active.has(run.status));
  const running = active.has(turn.status) || Boolean(handing);
  const quiet = running && Date.now() - Date.parse(latest) > 60000;
  const liveJob = turn.noobiJobs?.findLast((j) => ['running','waiting','stopping'].includes(j.status));
  const state = liveJob ? noobiProgress(liveJob) : handing ? `正在交给${roleName(handing.transfer.to)}` : running && pendingTool ? eventText(pendingTool) : running && turn.calls?.some((c) => ['running', 'reserved'].includes(c.status)) ? '等待模型回复' : turnStateLabel(turn);
  const entries = receipts.filter((r) => r.eventType === 'start').map((r) => { const end = receipts.find((e) => e.toolCallId === r.toolCallId && e.eventType === 'end'); return `<div class="wb-event">${esc(eventText(r))}<small>${end ? end.isError ? '未成功，原因见记录' : '工具已返回' : running ? '等待工具返回' : '没有结束回执'}</small></div>`; });
  const children = (turn.children || []).map((child) => `<details class="wb-event" id="child-${esc(child.id)}"><summary>${child.mode === 'write' ? '写入助手' : '只读助手'} · ${esc(turnStateLabel(child))} · ${esc(child.task)}</summary><p>${child.mode === 'write' ? '允许修改' : '读取范围'}：${esc((child.mode === 'write' ? child.writePaths : child.paths)?.join('、') || '见执行记录')}</p>${child.startedAt ? `<p>开始于 ${esc(new Date(child.startedAt).toLocaleTimeString('zh-CN'))}${child.providerTermination?.status === 'unconfirmed' ? '，模型调用收尾未确认' : child.finishedAt ? `，已结束，用时 ${duration(child.startedAt,child.finishedAt)}` : '，尚未结束'}</p>` : ''}${child.changedPaths?.length ? `<p>实际修改：${esc(child.changedPaths.join('、'))}</p>` : ''}${child.result ? renderMarkdown(child.result) : '<p>尚无结果。</p>'}<small>${esc(child.id)}</small></details>`);
  const specialists = (turn.noobiJobs || []).map((job) => `<details class="wb-event" id="noobi-${esc(job.id)}"><summary>小游戏制作 · ${esc(job.name)} · ${esc(noobiProgress(job))}</summary>${(job.events || []).filter(noobiProgressEvent).slice(-16).map((e) => `<p>${esc(noobiEventLabel(e))} <small>${esc(new Date(e.at).toLocaleTimeString('zh-CN'))}</small></p>`).join('')}${job.error ? '<p class="wb-error">这次制作尚未完成，原始原因保留在下方记录。</p>' : ''}<details><summary>原始制作回执</summary><pre>${esc(JSON.stringify({events:(job.events || []).slice(-16),error:job.error},null,2))}</pre></details></details>`).join('');
  const skills = (turn.skills || []).map((s) => `<p>已装载：${esc(s.id)} · 版本 ${esc(s.version.slice(0, 10))}</p>`).join('');
  const transfers = handoffs.map(({ transfer, run }) => `<section class="wb-handoff-record"><p>${esc(roleName(transfer.from))} → ${esc(roleName(transfer.to))} · ${esc(({ requested:'等待接手', receiving:'正在核对交接', accepted:'已确认接手', cancelled:'交接已取消，原负责人保留', failed:'交接未完成，原负责人保留', interrupted:'交接中断' })[transfer.status] || transfer.status)}</p>${transfer.reason ? `<p>${esc(transfer.reason)}</p>` : ''}${run.result ? renderMarkdown(run.result) : ''}${transfer.error ? `<p>${esc(transfer.error)}</p>` : ''}${activity(run)}</section>`).join('');
  const finish = running ? null : [turn.finishedAt, ...handoffs.map(({ run }) => run.finishedAt)].filter(Boolean).sort().at(-1);
  return `<details class="wb-activity" id="wb-activity-${esc(turn.id)}"><summary>${historical ? `${esc(new Date(turn.createdAt).toLocaleString('zh-CN'))} · ` : ''}${running ? '<span class="wb-running"></span>' : ''}${esc(state)} · ${duration(turn.createdAt, finish)}${quiet ? ' · 等待新进展' : ''}</summary><p>最近进展：${esc(new Date(latest || turn.createdAt).toLocaleTimeString('zh-CN'))}。${quiet ? '尚未收到新结果，不能仅凭动画判断工作正常。' : ''}</p><p>${turn.colleagueId ? `${esc(roleName(turn.colleagueId))} · ` : ''}本轮：${esc(turn.modelSelection?.model || '历史配置')} / ${esc(turn.modelSelection?.effort || '')}</p>${skills}${entries.join('') || '<p>尚无工具记录。</p>'}${children.join('')}${specialists}${transfers}</details>`;
}
function noobiApprovals(c) {
  return (c?.turns || []).flatMap((turn) => (turn.noobiJobs || []).flatMap((job) => job.approvals.filter((a) => ['pending', 'submitting'].includes(a.status)).map((a) => {
    const isQuestion = a.method === 'item/tool/requestUserInput';
    const key = `irixi.noobi.answer.${windowId}.${c.id}.${a.token}`;
    let draft = {}; try { draft = JSON.parse(localStorage.getItem(key)) || {}; } catch {}
    const questions = isQuestion ? (a.details?.questions || []).map((q) => {
      const v = draft[q.id] || {}, options = q.options || [];
      return `<fieldset data-noobi-question="${esc(q.id)}"><legend>${esc(q.question)}</legend>${options.length ? `<label>选择回答<select data-answer-option><option value="">请选择</option>${options.map((o) => `<option value="${esc(o.label)}"${v.option === o.label ? ' selected' : ''}>${esc(o.label)}${o.description ? ` — ${esc(o.description)}` : ''}</option>`).join('')}${q.isOther ? `<option value="__irixi_other__"${v.option === '__irixi_other__' ? ' selected' : ''}>其他回答</option>` : ''}</select></label>` : ''}<label data-answer-free${options.length && v.option !== '__irixi_other__' ? ' hidden' : ''}>你的回答<textarea data-answer-text rows="2" maxlength="10000">${esc(v.text || '')}</textarea></label></fieldset>`;
    }).join('') : `<p>${esc(a.summary || '')}</p><details><summary>查看这次请求的范围</summary><pre>${esc(JSON.stringify(a.details || {}, null, 2))}</pre></details>`;
    return `<section class="wb-noobi-approval" data-noobi-token="${esc(a.token)}" data-noobi-cid="${esc(c.id)}" data-noobi-draft="${esc(key)}"><h3>${isQuestion ? '小游戏制作需要补充一项信息' : esc(a.title || '小游戏制作需要你的确认')}</h3>${questions}<p class="wb-inline-note">${a.status === 'submitting' ? '答复正在送达，尚未收到执行端确认。' : `请在 ${esc(new Date(a.expiresAt).toLocaleTimeString('zh-CN'))} 前处理。其他操作仍可使用。`}</p><div class="wb-approval-actions"><button type="button" data-action="noobi-accept"${a.status !== 'pending' ? ' disabled' : ''}>${isQuestion ? '提交回答' : '允许这次操作'}</button><button type="button" data-action="noobi-decline"${a.status !== 'pending' ? ' disabled' : ''}>${isQuestion ? '暂不回答' : '不允许'}</button></div></section>`;
  }))).join('');
}
function renderNoobiApprovals(c) {
  const slot = $('#wb-noobi-approvals');
  const revision = JSON.stringify([c?.id, (c?.turns || []).flatMap((t) => (t.noobiJobs || []).flatMap((j) => j.approvals.map((a) => [a.token, a.status])))]);
  if (slot.dataset.revision === revision) return;
  const focused = document.activeElement, box = focused?.closest('.wb-noobi-approval'), field = focused?.closest('[data-noobi-question]');
  const focus = box && field ? { token: box.dataset.noobiToken, question: field.dataset.noobiQuestion, tag: focused.tagName.toLowerCase(), start: focused.selectionStart, end: focused.selectionEnd } : null;
  html('#wb-noobi-approvals', noobiApprovals(c)); slot.dataset.revision = revision;
  if (focus) {
    const next = slot.querySelector(`[data-noobi-token="${CSS.escape(focus.token)}"] [data-noobi-question="${CSS.escape(focus.question)}"] ${focus.tag}`);
    next?.focus(); if (next?.tagName === 'TEXTAREA') next.setSelectionRange(focus.start, focus.end);
  }
}
function activities(c, currentTurn) {
  const past = (c?.turns || []).filter((turn) => turn.id !== currentTurn?.id);
  const direct = handoffsFor(c, null);
  return activity(currentTurn, false, handoffsFor(c, currentTurn?.id)) + (direct.length ? `<details class="wb-activity" id="wb-direct-handoffs"><summary>这项工作的直接交接记录</summary>${direct.map(({ transfer, run }) => `<p>交给${esc(roleName(transfer.to))} · ${esc(transfer.receipt?.summary || transfer.error || '接手回执尚未返回')}</p>${activity(run)}`).join('')}</details>` : '') + (past.length ? `<details id="wb-past-activity" class="wb-activity"><summary>以前各轮工作过程 · ${past.length} 轮</summary>${[...past].reverse().map((turn) => activity(turn, true, handoffsFor(c, turn.id))).join('')}</details>` : '');
}
function checkPurpose(check) {
  if (check.caseId === 'noobi-production-game' || check.specification?.kind === 'noobi') return '小游戏制作与实际试玩';
  const sentence = String(check.requirement || '').trim().split(/[。！？!?\n]/u)[0].trim();
  // Keep a complete short purpose; never cut an internal brief halfway through.
  if (sentence && sentence.length <= 64 && !/(?:[a-f\d]{32,}|sha-?256|\/(?:private|Users|tmp|home)\/)/iu.test(sentence)) return sentence;
  return ({ cli: '工具功能与示例输入', web: '页面功能与交互', document: '文档内容要求' })[check.kind] || '本轮记录的功能';
}
function savedResultUse(turn) {
  if (!turn.adoptedAt) return '';
  const files = Object.keys(turn.resultIndex || {});
  if (files.includes(turn.artifactEntrypoint || 'index.html')) return '可打开运行。';
  if ((turn.functionalChecks || []).some((check) => check.kind === 'cli' && check.status === 'passed' && files.includes(check.specification?.target))) return '可运行工具。';
  return files.length ? '可查看成果文件。' : '';
}
function repairedPurposes(turn, latestChecks) {
  const repaired = latestChecks.filter((item) => item.status === 'passed' && (turn.functionalChecks || []).some((old) => old.caseId === item.caseId && old.status === 'failed')).map(checkPurpose);
  const noobiRepaired = (turn.noobiJobs || []).some((job) => job.status === 'completed' && job.summary?.review?.verdict === 'pass' && (job.events || []).some((event) => event.method === 'harness/repair/attempt-completed') && (job.events || []).some((event) => event.method === 'harness/reviewer/post-repair-pass'));
  if (noobiRepaired && latestChecks.some((check) => check.status === 'passed' && (check.caseId === 'noobi-production-game' || check.specification?.kind === 'noobi'))) repaired.push('小游戏制作与实际试玩');
  return [...new Set(repaired)];
}
function artifactControls(c, turn) {
  const samples = [...new Map((turn.functionalChecks || []).filter((check) => check.kind === 'cli' && check.status === 'passed').sort((a, b) => Number((b.specification.expected?.exitCode ?? 0) !== 0) - Number((a.specification.expected?.exitCode ?? 0) !== 0)).map((check) => [check.specification.target, check.specification])).values()];
  return samples.map((sample) => {
    const key = `${turn.id}:${sample.target}`; const value = artifactInputs.get(key) || { args: (sample.arguments || []).join('\n'), stdin: sample.stdin || '' };
    const run = c.artifactRuns?.findLast((item) => item.sourceTurnId === turn.id && item.target === sample.target);
    return `<details class="wb-artifact" id="artifact-${esc(turn.id)}-${esc(sample.target)}"><summary>运行工具 · ${esc(sample.target)}</summary><p class="wb-inline-note">${esc(checkPurpose({ ...sample, kind: 'cli' }))}。以下是已检查过的示例输入，可修改后运行。运行使用成果副本。</p><label>输入参数（每项一行）<textarea data-run-args data-run-key="${esc(key)}">${esc(value.args)}</textarea></label><label>要处理的文本（如适用）<textarea data-run-stdin data-run-key="${esc(key)}">${esc(value.stdin)}</textarea></label><button type="button" data-action="run-artifact" data-turn="${esc(turn.id)}" data-target="${esc(sample.target)}"${run && active.has(run.status) ? ' disabled' : ''}>${run && active.has(run.status) ? '正在运行…' : '运行并查看结果'}</button>${run ? `<p>${esc(labels[run.status] || run.status)}</p>${run.error ? `<p class="wb-inline-note">${esc(run.error)}</p>` : ''}<pre>${esc(run.output || run.errorOutput || '')}</pre>` : ''}</details>`;
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
  const credential = unfinished.map(({ turn }) => credentialIssue(turn)).find(Boolean);
  const checked = saved?.turn.verification?.status === 'passed';
  const cases = checked ? [...new Map((saved.turn.functionalChecks || []).map((item) => [item.caseId, item])).values()] : [];
  const useful = [...new Set(cases.filter((item) => item.status === 'passed').map(checkPurpose))].slice(0, 2).join('；');
  const repaired = saved ? repairedPurposes(saved.turn, cases).slice(0, 2).join('；') : '';
  const waiting = ongoing.some(({ turn }) => turn.status === 'awaiting_project');
  const completed = saved ? `最近已保存“${saved.conversation.title}”的成果。${savedResultUse(saved.turn)}${checked ? `已检查：${useful || '本轮记录的功能'}。` : '该版本的功能检查尚未确认。'}` : '目前还没有保存到项目的成果。';
  const missing = [...ongoing.map(({ conversation }) => `正在处理：${conversation.title}`), ...unfinished.map(({ conversation }) => `尚未完成：${conversation.title}`)].join('；') || '没有正在处理的项目任务。项目的全部目标是否达成，仍按你的要求判断。';
  const blocker = waiting ? '需要选择文件夹，待办暂不能开始制作。' : credential ? `有对话停在模型连接：${credential.reason}` : unfinished.length ? `有 ${unfinished.length} 段对话需要接续处理。${saved ? '已保存的成果保留。' : '目前不能按全部完成使用。'}` : ongoing.length ? '工作仍在进行，不能把当前结果当作最终交付。' : '没有记录到当前阻塞。';
  const next = waiting ? '你选择文件夹后，Agent 接着原请求做。' : credential ? '打开下方未完成的对话，按其连接提示处理，再继续。' : ongoing.length ? 'Agent 继续处理并检查结果。你可随时补充或停止。' : unfinished.length ? '在对应对话中说“继续”，由 Agent 接着处理未完成项。' : saved ? '打开最近成果体验；直接提出下一项修改。' : '在对话里说出目标，明确开始后由 Agent 制作。';
  return `<section class="wb-project-progress"><h3>项目当前情况 · ${esc(project.name)}${c.workspaceRoot ? ' · 独立工作目录' : ''}</h3><p class="wb-inline-note">汇总同一工作目录的相关对话。下面的本轮记录单独保留。</p><dl><dt>已完成</dt><dd>${esc(completed)}</dd><dt>还缺什么</dt><dd>${esc(missing)}</dd><dt>发现与修复</dt><dd>${esc(repaired ? `最近成果有修补并复测记录：${repaired}。` : unfinished.length ? '未完成项及具体原因保留在对应对话中。' : '最近成果没有已确认的修补复测记录。')}</dd><dt>当前卡点</dt><dd>${esc(blocker)}</dd><dt>下一步</dt><dd>${esc(next)}</dd></dl>${saved ? `<a href="${esc(linkFor(saved.conversation.id))}">查看最近成果所在对话</a>` : ''}${unfinished.map(({ conversation }) => `<p><a href="${esc(linkFor(conversation.id))}">接续：${esc(conversation.title)}</a></p>`).join('')}</section>`;
}
function credentialIssue(turn) {
  if (turn.status !== 'failed' || turn.providerTermination?.status === 'unconfirmed') return null;
  const error = String(turn.error || '');
  if (['尚未配置本产品 API Key。请在设置中填写。', '请先通过安全入口保存 OpenAI API Key，未回退原登录。', '尚未配置本产品 API Key。请在密钥文本文件中填写并保存。', '请先打开密钥文件填写并保存 OpenAI API Key，未回退原登录。'].includes(error)) {
    return { reason: '尚未保存本产品的 OpenAI 密钥，模型不能开始回答。消息和已有成果保留。', next: '打开连接设置，点“打开密钥文件”。只粘贴一行 Key，按 Cmd+S 保存。刷新状态，重新连接当前密钥，再发送“继续”。' };
  }
  if (error === 'API Key 文件格式无效。请只保留一行 Key，不要添加说明或空格。') {
    return { reason: '密钥文件格式不对，模型不能开始回答。消息和已有成果保留。', next: '打开密钥文件，只保留一行 Key。删除说明和空格，按 Cmd+S 保存。刷新状态并重新连接当前密钥，再发送“继续”。' };
  }
  if (['无法读取本产品钥匙串。请检查系统访问许可，或重新打开密钥设置。', '系统钥匙串暂不可访问。请处理本机访问许可后重试。', 'OpenAI API Key 不可读取，未调用模型，也未回退原登录。', '无法读取 API Key 文本文件。请检查文件是否可读。'].includes(error)) {
    return { reason: '系统未能读取本产品的密钥，模型暂时不能继续。消息和已有成果保留。', next: '打开连接设置，点“打开密钥文件”。确认文件可打开，内容只有一行 Key，按 Cmd+S 保存。刷新状态并重新连接当前密钥，再发送“继续”验证。保存不等于调用通过。' };
  }
  if (error === 'OpenAI API Key 已更换或失效，请重新选择连接；未回退原登录。') {
    return { reason: '当前对话仍引用旧密钥，模型不能继续。消息和已有成果保留。', next: '打开连接设置核对当前密钥，再点“重新连接当前密钥”。连接更新后发送“继续”。' };
  }
  return null;
}
function workIssue(turn) {
  if (turn.providerTermination?.status === 'unconfirmed') return '模型调用收尾未确认，迟到结果不会采用';
  if (turn.status === 'stopped') return '这轮工作已停止，已有内容保留';
  if (turn.status === 'interrupted') return '运行中断，尚未完成的工作需要继续处理';
  const credential = credentialIssue(turn); if (credential) return credential.reason;
  const error = String(turn.error || '');
  if (/Run one tool at a time/i.test(error)) return '多项操作的提交被系统拦截，本轮尚未完成';
  if ((turn.workspace || turn.functionalChecks?.length) && /检查|check|verif/i.test(error)) return '成果检查尚未通过，当前不能按完成使用';
  if (/文件.*变化|project.*changed|scope.*changed/i.test(error)) return '项目文件或范围已变化，为避免覆盖已有工作，暂停保存';
  if (/额度|quota|rate.?limit/i.test(error)) return '模型暂时无法继续，消息和已有内容已保留';
  return '本次操作未成功，原始原因保存在技术记录中';
}
function results(c) {
  const latest = c?.turns.at(-1);
  const turns = c?.turns.filter((t) => t === latest || t.workspace || ['failed', 'stopped', 'interrupted'].includes(t.status)) || [];
  const project = c ? projectProgress(c) : '';
  const owner = c?.workspaceRoot ? data.applicationProjects?.find((p) => p.root === c.workspaceRoot) : projectFor(c);
  const app = owner?.application;
  const appLabels = { starting: '正在启动', running: '运行中', stopped: '已停止', stopping: '正在停止', interrupted: '已中断', failed: '启动失败' };
  const controls = owner ? `<section class="wb-application"><h3>项目应用</h3>${app ? `<p>${esc(appLabels[app.status] || '状态待核对')}。应用运行不调用模型。</p>${app.status === 'running' ? `<a href="${esc(app.url)}" target="_blank" rel="noopener">打开应用</a> ` : ''}<button type="button" data-action="application" data-operation="open">启动 / 打开</button> <button type="button" data-action="application" data-operation="restart">重启应用</button> <button type="button" data-action="application" data-operation="stop">停止应用</button>${app.error ? `<p class="wb-error">${esc(app.error)}</p><details><summary>启动记录</summary><pre>${esc(app.logTail || '')}</pre></details>` : ''}<p class="wb-inline-note">停止应用会关闭成果服务，保留数据。停止对话工作不会关闭已经交付的应用。</p>` : '<p>尚未交付后台应用。</p>'}<details id="wb-dependency-permission"><summary>公开依赖：${owner.dependencyPermission?.allowed ? '本项目已允许' : '尚未允许'}</summary><p>允许从 npm、PyPI 下载公开依赖，并在隔离项目内运行安装和构建脚本。不会读取原凭证。相同项目重复使用此许可。</p><button type="button" data-action="dependencies" data-allowed="${!owner.dependencyPermission?.allowed}"${activeTurn(c) ? ' disabled' : ''}>${owner.dependencyPermission?.allowed ? '关闭后续下载权限' : '允许本项目安装公开依赖'}</button></details></section>` : '';
  if (!turns.length && !project && !controls) return '';
  return `<details class="wb-result" id="wb-results"><summary>进度与成果</summary>${project}${controls}${turns.length ? '<h3>本对话的进展记录</h3>' : '<p>本对话尚未制作成果。</p>'}${[...turns].reverse().map((t) => {
    const saved = Boolean(t.adoptedAt); const checks = t.functionalChecks || [];
    const discussion = t.classifiedMode === 'discuss' && !t.workspace;
    const discussionDone = discussion && t.status === 'completed'; const historical = t !== latest;
    const passed = t.verification?.status === 'passed';
    const changes = [...(t.changes?.changed || []), ...(t.changes?.deleted || [])]; const completed = discussionDone ? '本轮回答已完成，内容保存在对话中。' : saved ? `本轮成果已保存。${savedResultUse(t)}` : !changes.length && passed ? '原有成果已检查，本轮没有修改文件。' : t.workspace ? '工作副本已保留，尚未保存到项目。' : '消息已保存。';
    const latestChecks = [...new Map(checks.map((item) => [item.caseId, item])).values()];
    const verified = [...new Set(latestChecks.filter((item) => item.status === 'passed').map(checkPurpose))];
    const unresolved = [...new Set(latestChecks.filter((item) => item.status !== 'passed').map(checkPurpose))];
    const repaired = repairedPurposes(t, latestChecks); const credential = credentialIssue(t);
    const filenames = Object.keys(t.resultIndex || {});
    return `<section><p><b>${historical ? '历史记录 · ' : '最新一轮 · '}${esc(turnStateLabel(t))}</b> · ${esc(new Date(t.createdAt).toLocaleString('zh-CN'))}</p>${historical ? '<p class="wb-inline-note">以下保留当时情况，不代表当前状态。</p>' : ''}<dl><dt>已完成</dt><dd>${esc(completed)}${passed && verified.length ? ` 已实际检查：${esc(verified.join('；'))}。` : ''}</dd><dt>还缺什么</dt><dd>${credential ? '本轮回答或工作尚未完成。需先处理模型连接。' : discussionDone ? '本轮回复已完成；不计为项目功能验收。' : discussion ? '本次讨论或资料核对尚未完成。' : passed ? '本轮记录的功能检查已通过。' : unresolved.length ? `还需完成：${esc(unresolved.join('；'))}。` : '功能检查尚未确认通过。保存文件不等于可以正常使用。'}</dd><dt>发现与修复</dt><dd>${credential ? esc(credential.reason) : repaired.length ? `本轮有修补并复测记录：${esc(repaired.join('；'))}。` : t.error ? `本轮停在：${esc(workIssue(t))}。` : '本轮没有已确认的修补复测记录。'}</dd><dt>${historical ? '当时卡点' : '当前卡点'}</dt><dd>${active.has(t.status) ? '工作尚未结束，结果仍可能变化。' : credential ? esc(credential.reason) : t.error ? discussion ? '这次提问尚未答完，消息和资料已保留。' : '本轮尚不能按完成使用。已有内容已保留。' : discussionDone || saved || passed ? '没有记录到阻塞。' : '尚未采用工作副本。'}</dd><dt>${historical ? '当时下一步' : '下一步'}</dt><dd>${active.has(t.status) ? 'Agent 继续处理；你可补充要求或停止。' : credential ? esc(credential.next) : t.error ? '可在对话中说“继续”，由 Agent 接着处理。' : discussionDone ? '查看上方回复，或继续提出要求。' : saved || passed ? '打开成果体验；可直接提出修改要求。' : '在对话中继续说明下一步。'}</dd></dl>${credential && !historical ? '<p><button type="button" data-view-target="connections">打开连接设置</button> <button type="button" data-action="reconnect-openai">重新连接当前密钥</button></p>' : ''}${saved && filenames.includes(t.artifactEntrypoint || 'index.html') ? `<a class="wb-result-link" href="/conversation-preview/${encodeURIComponent(t.projectId)}/${t.artifactEntrypoint ? '__run__/index.html' : 'index.html'}?turn=${encodeURIComponent(t.id)}" target="_blank" rel="noopener">打开运行成果</a>` : ''}${saved ? artifactControls(c, t) : ''}${saved ? `<details><summary>成果文件</summary>${filenames.slice(0, 80).map((name) => `<p><a target="_blank" rel="noopener" href="/conversation-preview/${encodeURIComponent(t.projectId)}/${name.split('/').map(encodeURIComponent).join('/')}?turn=${encodeURIComponent(t.id)}">${esc(name)}</a></p>`).join('')}</details>` : ''}<details><summary>技术与检查记录</summary><pre>${esc(JSON.stringify({ changes: t.changes, functionalChecks: checks, error: t.error, providerTermination: t.providerTermination, tools: t.receipts, children: t.children, calls: t.calls }, null, 2))}</pre></details></section>`;
  }).join('')}</details>`;
}
function keepDetails(selector, content) { const node = $(selector); const open = [...node.querySelectorAll('details[open]')].map((n) => n.id).filter(Boolean); html(selector, content); for (const id of open) document.getElementById(id)?.setAttribute('open', ''); }
function renderModels() {
  const models = data.catalogue?.models || []; if (!selection) selection = structuredClone(current()?.modelSelection || { provider: 'desktop-codex', model: 'gpt-6-luna', effort: 'medium' });
  html('#wb-model', `${models.some((m) => m.id === selection.model) ? '' : `<option value="${esc(selection.model)}">${esc(selection.model)} · 暂不可用</option>`}${models.map((m) => `<option value="${esc(m.id)}">${esc(m.name || m.id)}</option>`).join('')}`);
  $('#wb-model').value = selection.model;
  html('#wb-connection', '<option value="desktop-login">原 Desktop 登录</option><option value="openai-api-key">当前 OpenAI API Key</option>');
  $('#wb-connection').value = selection.connectionId || 'desktop-login';
  const model = models.find((m) => m.id === selection.model); const efforts = model?.efforts || [];
  html('#wb-effort', `${efforts.includes(selection.effort) ? '' : `<option value="${esc(selection.effort)}">${esc(selection.effort)} · 暂不可用</option>`}${efforts.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('')}`); $('#wb-effort').value = selection.effort;
}
function renderComposer() {
  html('#wb-materials', (current()?.materials || []).map((m) => `<div class="wb-chip"><span>材料 · ${esc(m.name)}</span>${button('remove-material', '移除这份材料', 'close', `data-material="${esc(m.id)}"`)}</div>`).join(''));
  html('#wb-chips', references.map((r, i) => `<div class="wb-chip"><span title="${esc(r.text || '')}">引用 · ${esc(r.title)}</span>${button('remove-reference', '移除引用', 'close', `data-index="${i}"`)}</div>`).join(''));
  html('#wb-editing', editTarget ? `<div class="wb-editing">编辑并重新发送会创建修订分支，原对话保留。<button type="button" data-action="cancel-edit">取消编辑</button></div>` : '');
  const p = projectFor(current()); $('#wb-directory').innerHTML = `${icon('folder')} ${esc(p?.name || '选择项目文件夹')}`; $('#wb-directory').title = current()?.workspaceRoot || p?.root || '选择已有文件夹，或在系统选择器中新建文件夹';
  $('#wb-send').disabled = sending || !input.value.trim(); $('#wb-send').title = editTarget ? '编辑并重新发送' : '发送';
  $('#wb-stop').hidden = !workRunning(current()); renderModels();
}
function memoryDraftKey() { return `irixi.memory.editor.${windowId}`; }
function saveMemoryEditor() { memoryEditor ? localStorage.setItem(memoryDraftKey(), JSON.stringify(memoryEditor)) : localStorage.removeItem(memoryDraftKey()); }
function captureMemoryEditor(event) {
  if (!memoryEditor || !event.target.closest('[data-memory-editor]') || !['title','text'].includes(event.target.name)) return;
  memoryEditor[event.target.name] = event.target.value; memoryEditor.requestId = uuid(); saveMemoryEditor();
}
async function loadMemory(context = memoryContext, target = memoryTarget) {
  if (memoryBusy) { notice('正在处理记忆记录，请稍后再打开。'); return; }
  if (context !== memoryContext) memoryState = null;
  const request = ++memoryRequest; memoryContext = context; memoryTarget = target; memoryBusy = true; memoryError = ''; memoryNotice = ''; renderMemory();
  try {
    const value = await api(`/api/office/memory${context ? `?conversationId=${encodeURIComponent(context)}` : ''}`);
    if (request !== memoryRequest) return;
    memoryState = value; memoryNotice = value.notice || '';
    if (memoryEditor?.conflict && memoryEditor.context === context) {
      const entry = value.entries.find((e)=>e.id === memoryEditor.id);
      if (entry) { Object.assign(memoryEditor,{expectedRevision:value.revision,expectedVersion:entry.currentVersion ?? entry.version,requestId:uuid(),conflict:false}); memoryNotice='已读取最新版本。你的修改保留，请对照下方记录后再保存。'; saveMemoryEditor(); }
      else memoryNotice='这条记忆已不可用。编辑文字保留，不能用旧稿重新建立已删除的记忆。';
    }
  } catch (error) { if (request === memoryRequest) memoryError = error.message; }
  finally { if (request === memoryRequest) { memoryBusy = false; renderMemory(); } }
}
function memoryMarkup() {
  const scope = memoryContext ? `本对话适用的记忆 · ${data.conversations.find((c) => c.id === memoryContext)?.title || '所选对话'}` : '全部记忆管理';
  const kinds = { preference:'个人偏好', decision:'已确认决定', temporary:'本段对话要求', candidate:'候选，尚未采用' };
  const editor = memoryEditor ? `<form class="wb-memory-editor" data-memory-editor><h3>编辑这条记忆</h3><p>${esc(memoryEditor.scopeLabel || '')}。只修改内容，适用范围保持原样。</p><label>名称（最多 160 字符）<input name="title"${memoryBusy ? ' disabled' : ''} maxlength="${memoryLimits.title}" value="${esc(memoryEditor.title)}" required></label><label>记忆内容（最多 4000 字符）<textarea name="text"${memoryBusy ? ' disabled' : ''} rows="4" maxlength="${memoryLimits.text}" required>${esc(memoryEditor.text)}</textarea></label><div class="wb-memory-actions"><button type="submit"${memoryBusy || memoryEditor.conflict ? ' disabled' : ''}>保存修改</button>${memoryEditor.conflict ? '<button type="button" data-action="memory-editor-refresh">读取最新版本再核对</button>' : ''}<button type="button" data-action="memory-cancel"${memoryBusy ? ' disabled' : ''}>取消编辑</button></div></form>` : '';
  const entries = (memoryState?.entries || []).map((entry) => {
    const label = entry.scopeLabel || ({personal:'所有项目',project:'指定项目',conversation:'本段对话'})[entry.scopeType] || '范围待确认';
    const source = entry.source || {}; const href = source.type === 'user_message' && source.conversationId ? linkFor(source.conversationId,source.messageId) : null;
    const disabled = memoryBusy || Boolean(memoryEditor) || entry.status === 'deleted';
    return `<article class="wb-memory-item"><h3>${esc(entry.title)}</h3><p class="wb-inline-note">${esc(label)} · ${esc(kinds[entry.kind] || entry.kind)} · ${entry.status === 'disabled' ? '已停用' : entry.status === 'candidate' ? '候选，未采用' : '已保存'} · 版本 ${esc(entry.version)}${entry.historical ? ' · 此对话适用的历史版本' : ''}</p><p class="wb-memory-text">${esc(entry.text || '')}</p>${href ? `<a href="${esc(href)}" data-reference-link>查看原对话来源</a>` : '<p class="wb-inline-note">来源：在记忆管理中明确保存</p>'}<div class="wb-memory-actions"><button type="button" data-action="memory-edit" data-memory-id="${esc(entry.id)}"${disabled ? ' disabled' : ''}>编辑</button><button type="button" data-action="memory-${entry.status === 'disabled' ? 'restore' : 'deactivate'}" data-memory-id="${esc(entry.id)}"${disabled ? ' disabled' : ''}>${entry.status === 'disabled' ? '恢复使用' : '停用'}</button><button type="button" data-action="memory-delete" data-memory-id="${esc(entry.id)}"${disabled ? ' disabled' : ''}>删除记忆</button></div></article>`;
  }).join('');
  const defaults = (memoryState?.defaults || []).map((entry)=>`<p><b>${esc(entry.name)}</b>：${esc(entry.preference)} <small>角色默认能力</small></p>`).join('');
  return `<section class="wb-memory-manager"><header><h2>${esc(scope)}</h2><div class="wb-memory-actions">${memoryContext ? '<button type="button" data-action="memory-all">查看全部记忆</button>' : ''}<button type="button" data-action="memory-refresh"${memoryBusy ? ' disabled' : ''}>刷新记录</button>${memoryTarget === 'office' ? '<button type="button" data-action="memory-close">收起记忆</button>' : ''}</div></header><p class="wb-inline-note">个人偏好可以跨项目使用，项目决定只用于其适用范围。候选不会自动采用。删除记忆不删除原聊天和成果。</p>${memoryContext ? '' : '<p class="wb-inline-note">这里可管理全部记录，不代表所有规则都会用于每个项目。</p>'}${memoryError ? `<p class="wb-error" role="alert">${esc(memoryError)}${memoryEditor ? ' 编辑文字已保留。版本冲突时请先查看最新记录，再决定修改。' : ''}</p>` : ''}${memoryNotice ? `<p class="wb-inline-note" role="status">${esc(memoryNotice)}</p>` : ''}${memoryBusy && !memoryState ? '<p>正在读取记忆…</p>' : ''}${editor}${entries || (!memoryBusy ? '<p>还没有这类记忆。可以在对话里明确说“记住这个习惯”或确认项目决定。</p>' : '')}${defaults ? `<details><summary>五位同事的默认能力</summary>${defaults}</details>` : ''}<p class="wb-inline-note">修改用于后续新轮。正在运行的模型可能已经看过旧内容；需要立即停用时，可在对话中明确要求停止受影响工作。</p></section>`;
}
function renderMemory() {
  for (const [target, selector] of [['office','#wb-memory-slot'],['settings','#wb-memory-settings']]) {
    const slot = $(selector); if (!slot) continue;
    if (memoryTarget !== target) { if (slot.childElementCount) slot.replaceChildren(); continue; }
    // Polling the conversation must not replace a memory editor or move its caret.
    if (memoryEditor && slot.querySelector('[data-memory-editor]') && slot.dataset.editorId === memoryEditor.id && slot.dataset.busy === String(memoryBusy) && slot.dataset.error === memoryError && slot.dataset.notice === memoryNotice) continue;
    const content = memoryMarkup(); if (slot.memoryHTML === content && slot.childElementCount) continue;
    slot.innerHTML = content; slot.memoryHTML = content; slot.dataset.editorId = memoryEditor?.id || ''; slot.dataset.busy = String(memoryBusy); slot.dataset.error = memoryError; slot.dataset.notice = memoryNotice;
  }
}
function beginMemoryEdit(id) {
  const entry = memoryState?.entries.find((e)=>e.id === id); if (!entry) return;
  memoryEditor = { id, title:entry.title, text:entry.text, scopeLabel:entry.scopeLabel, expectedRevision:memoryState.revision, expectedVersion:entry.currentVersion ?? entry.version, context:memoryContext, requestId:uuid() };
  memoryError = ''; saveMemoryEditor(); renderMemory();
}
async function changeMemory(operation, id = memoryEditor?.id) {
  if (memoryBusy || operation === 'edit' && memoryEditor?.conflict) return;
  if (operation === 'edit' && (!memoryEditor?.title?.trim() || !memoryEditor?.text?.trim() || memoryEditor.title.length > memoryLimits.title || memoryEditor.text.length > memoryLimits.text)) {
    memoryError = '名称不能为空且最多 160 字符，记忆内容不能为空且最多 4000 字符。编辑文字已保留。'; renderMemory(); return;
  }
  const entry = memoryState?.entries.find((e)=>e.id === id); if (!entry && operation !== 'edit') return;
  const edit = operation === 'edit' ? structuredClone(memoryEditor) : null;
  const body = edit ? { requestId:edit.requestId, expectedRevision:edit.expectedRevision, expectedVersion:edit.expectedVersion, memoryId:id, operation, title:edit.title, text:edit.text, ...(edit.context ? {conversationId:edit.context} : {}) }
    : {requestId:uuid(), expectedRevision:memoryState.revision, expectedVersion:entry.currentVersion ?? entry.version, memoryId:id, operation, ...(memoryContext ? {conversationId:memoryContext} : {})};
  const identity = JSON.stringify({...body,requestId:undefined});
  if (memoryMutation?.identity === identity) body.requestId = memoryMutation.requestId;
  else memoryMutation = {identity,requestId:body.requestId};
  memoryBusy = true; memoryError = ''; renderMemory();
  try {
    const value = await api('/api/office/memory',body); memoryState = value; memoryNotice = value.notice || (operation === 'delete' ? '已删除记忆。原聊天和成果保留。' : '记忆已保存，后续新轮按更新后的记录处理。');
    memoryMutation = null;
    if (edit && memoryEditor?.id === edit.id && memoryEditor.text === edit.text && memoryEditor.title === edit.title) { memoryEditor = null; saveMemoryEditor(); }
  } catch (error) { memoryError = error.message; if (edit && error.status === 409) { memoryEditor.conflict = true; saveMemoryEditor(); } }
  finally { memoryBusy = false; renderMemory(); }
}

function renderSettings() {
  const memorySlot = $('#wb-memory-settings');
  const focused = memorySlot?.contains(document.activeElement) ? document.activeElement : null;
  const caret = focused && typeof focused.selectionStart === 'number' ? [focused.selectionStart, focused.selectionEnd] : null;
  html('#connection-list', `<div class="wb-settings"><section><h2>记忆</h2><p>查看已保存的个人偏好、项目决定和来源。</p><button type="button" data-action="memory-settings">查看与管理全部记忆</button><div id="wb-memory-settings"></div></section><section><h2>阅读与动态</h2><label>减少场景动态<input id="wb-reduced-motion" type="checkbox"${reducedMotion ? ' checked' : ''}></label><p>系统的减少动态设置也会生效。工作状态和所有操作保留。</p><label>工作台字号<select id="wb-font-size">${[14,16,18,20,22].map((n) => `<option value="${n}"${n === data.preferences.fontSize ? ' selected' : ''}>${n} px</option>`).join('')}</select></label><p>只调整对话、项目列表和设置。办公室地图保持原样。</p></section><section><h2>模型连接</h2>${(data.catalogue?.providers || []).filter((p) => p.id !== 'deepseek').map((p) => `<div class="wb-provider"><b>${esc(p.name || p.id)}</b><span>${p.status === 'connected' ? '已连接本机 CLI' : '尚未接入'}</span></div>`).join('')}<p>模型和思考强度在输入框选择。下次发送生效；正在运行的工作沿用原配置。</p><button type="button" data-action="refresh-models">刷新可用模型</button></section><section><h2>OpenAI 官方 API Key</h2><p role="status">${esc(openaiBusy ? '正在打开密钥文件…' : openaiConnection?.message || '尚未读取凭据状态。')}</p><button type="button" data-action="openai-configure"${openaiBusy ? ' disabled' : ''}>打开密钥文件</button><button type="button" data-action="openai-status"${openaiBusy ? ' disabled' : ''}>刷新状态</button><p>在本机文本文件中只粘贴一行 Key，按 Cmd+S 保存。保存本身不联网，也不等于调用通过。请在输入框模型旁明确选择“当前 OpenAI API Key”；旧对话不会自动改连接或型号。</p></section><section><h2>DeepSeek 官方接口</h2><p role="status">${esc(deepseekBusy ? '正在处理连接设置…' : deepseekConnection?.message || '尚未读取连接状态。')}</p><p>仅验证连接，不用于任务、助手或恢复。固定 Flash 模型，关闭思考，最多 256 输出 token。</p><button type="button" data-action="deepseek-configure"${deepseekBusy ? ' disabled' : ''}>打开密钥文件</button><button type="button" data-action="deepseek-verify"${deepseekBusy || !deepseekConnection?.configured || deepseekConnection?.status === 'verified' ? ' disabled' : ''}>验证连接</button><button type="button" data-action="deepseek-status"${deepseekBusy ? ' disabled' : ''}>刷新状态</button><p>打开本机密钥文件，只粘贴一行 Key，按 Cmd+S 保存。保存本身不联网。验证只发固定短句；不会发送项目资料。</p>${deepseekConnection?.verification ? `<p>实际模型：${esc(deepseekConnection.verification.model)} · 验证时间：${esc(deepseekConnection.verification.verifiedAt)}</p>` : ''}</section><section><h2>保存与版本</h2><p>消息和成果保存在本机。关闭窗口不会停止后台工作。每个窗口分别保存草稿。</p><code>${esc(data.storagePath || '')}</code><p>当前版本：<code>${esc(data.build || '')}</code></p></section></div>`);
  const replacement = $('#wb-memory-settings');
  if (memorySlot && replacement && memorySlot !== replacement) {
    replacement.replaceWith(memorySlot);
    if (focused) { focused.focus({preventScroll:true}); if (caret) focused.setSelectionRange(...caret); }
  }
}
function hydrateDraft() {
  const d = getDraft(currentId); const remote = data.drafts?.[`${currentId}:${windowId}`];
  if (remote && !d.dirty && remote.revision > (d.revision || 0)) { Object.assign(d, structuredClone(remote)); input.value = d.text; references = d.references || []; editTarget = d.editTarget || null; localStorage.setItem(localKey(currentId), JSON.stringify(d)); }
}
function render() {
  document.body.style.setProperty('--wb-size', `${data.preferences.fontSize || 16}px`);
  const c = current(); const turn = activeTurn(c) || c?.turns.at(-1);
  const model = JSON.stringify(c?.modelSelection); if (model !== observedModel && !modelUpdating) { observedModel = model; if (c?.modelSelection) selection = structuredClone(c.modelSelection); }
  $('#project-dialogue-title').textContent = c?.title || (roleListing ? '选择要继续的工作' : currentId ? '未找到这段对话' : '新对话');
  const recipient = c?.work?.ownerId || (!c ? selectedRole : null);
  $('#project-dialogue-portrait').className = `coworker-portrait${species[recipient] ? ` species-${species[recipient]}` : ''}`;
  $('#project-dialogue-portrait').hidden = !species[recipient];
  $('#wb-recipient').textContent = `${roleName(recipient)} · ${projectFor(c)?.name || '无项目讨论'}${c?.workspaceRoot ? ' · 独立目录' : ''}`;
  $('#wb-recipient').disabled = !recipient;
  const transfer = pendingHandoff(c);
  const liveNoobi = c?.turns.flatMap((t)=>t.noobiJobs || []).findLast((j)=>['running','waiting','stopping'].includes(j.status));
  const noobiAt = liveNoobi && ([...(liveNoobi.events || [])].reverse().find(noobiProgressEvent)?.at || liveNoobi.createdAt);
  const noobiSummary = liveNoobi ? `${noobiProgress(liveNoobi)}${noobiAt && Date.now()-Date.parse(noobiAt)>60000 ? ' · 等待新结果' : ''}` : null;
  $('#wb-recipient').title = transfer ? `正在交给${roleName(transfer.to)}；确认前仍由${roleName(recipient)}负责。新消息保存在同一工作中。` : `消息发送给${roleName(recipient)}，查看协助记录不会改变负责人。`;
  html('#wb-handoff', transfer ? `<p class="wb-inline-note">正在交给${esc(roleName(transfer.to))}。${esc(roleName(recipient))}仍负责，补充内容会随同一工作交接。</p>` : '');
  $('#project-dialogue-status').textContent = offline ? '连接暂时中断；草稿已保留' : noobiSummary || (transfer ? '正在交接，新消息仍属于这项工作' : c?.work?.lifecycle === 'completed' && !workRunning(c) ? '工作已结束，原记录保留；可以明确说继续' : turn?.status === 'completed' && c?.work?.lifecycle === 'open' ? '本轮结束，工作仍保留' : turn ? turnStateLabel(turn) : '先讨论。你说开始做，我再动手。');
  const running = data.conversations.some((item) => workRunning(item)); $('#global-status').textContent = running ? 'Agent 正在工作' : '可以对话'; $('#room-state-title').textContent = $('#global-status').textContent;
  $('#room-state-detail').textContent = turn ? turnStateLabel(turn) : '点同事或地图，直接开始对话。';
  renderRoles(); syncOffice();
  renderTree(); renderMessages(c); keepDetails('#wb-activity-slot', activities(c, turn)); keepDetails('#wb-results-slot', results(c));
  html('#wb-noobi-status', noobiStatus(c)); renderNoobiApprovals(c);
  html('#wb-errors', `${c?.archived ? '<p class="wb-inline-note">这段对话已归档。恢复后可继续发送。<button type="button" data-action="restore-current">恢复</button></p>' : ''}${turn?.status === 'awaiting_project' ? '<p class="wb-inline-note">开工要求已保存。<button type="button" data-action="directory">选择文件夹并继续</button></p>' : ''}${turn?.error ? '<p class="wb-error">本轮未完成。消息和已有文件已保留。可在下方继续说明要求；原因记录在“进度与成果”中。</p>' : ''}`);
  renderComposer(); renderSettings(); renderMemory();
}
async function refresh() { if (refreshBusy) return; refreshBusy = true; try { data = await api('/api/conversation/state'); offline = false; hydrateDraft(); render(); } finally { refreshBusy = false; } }
async function send(event) {
  event?.preventDefault(); if (sending || !input.value.trim()) return;
  if (current()?.archived) { notice('请先恢复这段对话，再发送。', true); return; }
  sending = true; renderComposer(); notice('正在保存消息…');
  const text = input.value; const refs = structuredClone(references); const edit = editTarget && { ...editTarget }; const model = { ...selection }; let cid = currentId;
  const origin = draftKey(cid), owner = selectedRole, work = current()?.work && { ...current().work }; const d = getDraft(origin);
  try {
    if (!cid) {
      d.creationRequestId ||= uuid(); localStorage.setItem(localKey(origin), JSON.stringify(d));
      const r = await api('/api/conversation/new', { requestId: d.creationRequestId, colleagueId: owner }); cid = r.conversationId;
      drafts.set(cid, d); localStorage.setItem(localKey(cid), JSON.stringify(d));
      if (draftKey(currentId) === origin) { currentId = cid; locationForCurrent(); }
      drafts.delete(origin); localStorage.removeItem(localKey(origin));
      if (owner) { roleDrafts[owner] = cid; localStorage.setItem(`irixi.workbench.role-drafts.${windowId}`, JSON.stringify(roleDrafts)); }
    }
    const payload = { text, references: refs, modelSelection: model, ...(work ? { workId: work.id, expectedOwnerRevision: work.ownerRevision } : {}) }; const key = JSON.stringify([payload, edit]);
    if (d.pending?.key !== key) d.pending = { key, requestId: uuid() }; localStorage.setItem(localKey(cid), JSON.stringify(d));
    const response = edit ? await actionApi(edit.conversationId, 'fork', { ...payload, messageId: edit.messageId, requestId: d.pending.requestId }) : await actionApi(cid, 'send', { ...payload, requestId: d.pending.requestId });
    delete d.pending;
    const sourceUnchanged = d.text === text && JSON.stringify(d.references || []) === JSON.stringify(refs) && d.editTarget?.messageId === edit?.messageId;
    if (currentId !== cid && sourceUnchanged) { Object.assign(d, { text: '', references: [], editTarget: null, dirty: true }); localStorage.setItem(localKey(cid), JSON.stringify(d)); await saveDraft(cid, d); }
    if (currentId === cid && input.value === text && JSON.stringify(references) === JSON.stringify(refs) && editTarget?.messageId === edit?.messageId) {
      input.value = ''; references = []; editTarget = null; await saveDraft(cid, snapshotDraft(cid));
    }
    if (origin.startsWith('new') && sourceUnchanged) { localStorage.removeItem(localKey(origin)); drafts.delete(origin); }
    await refresh(); if (edit && currentId === cid) await select(response.result.id);
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
async function addReference(descriptor, destinationId = draftKey(currentId)) {
  const response = await api('/api/conversation/reference', { references: [descriptor] });
  if (draftKey(currentId) === destinationId) { references.push(response.references[0]); renderComposer(); captureDraft(); input.focus(); }
  else { const d = getDraft(destinationId); d.references = [...(d.references || []), response.references[0]]; d.dirty = true; localStorage.setItem(localKey(destinationId), JSON.stringify(d)); await saveDraft(destinationId, d); }
}
async function referencePicker() {
  const destinationId = draftKey(currentId);
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
    { label: '创建分支聊天', disabled: !last || Boolean(workRunning(c)), run: () => fork(c, last) },
    { label: '在独立工作目录分支…', disabled: !last || !c.projectId || Boolean(workRunning(c)), run: () => fork(c, last, 'isolated') }, null,
    { label: '复制对话内容', run: () => copy(c.messages.map((m) => `${m.role === 'user' ? '你' : 'IRiXI'}\n${m.text}`).join('\n\n')) },
    { label: '复制深度链接', run: () => copy(linkFor(cid, null, Boolean(window.webkit?.messageHandlers?.irixiHost))) },
    ...(projectFor(c) ? [{ label: '复制项目位置', run: () => copy(c.workspaceRoot || projectFor(c).root) }] : []),
    { label: '在当前草稿中引用', disabled: cid === currentId || !c.messages.length, run: () => addReference({ conversationId: cid }) },
    { label: '在新窗口中打开', run: () => { const url = new URL(linkFor(cid)); url.searchParams.set('window', uuid()); window.open(url.href, '_blank'); } }, null,
    { label: c.archived ? '恢复对话' : workRunning(c) ? '归档（工作继续）' : '归档', run: () => update(cid, { archived: !c.archived }) },
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
const roleAccess = document.createElement('nav'); roleAccess.id = 'wb-role-access'; roleAccess.setAttribute('aria-label', '键盘访问同事，离座时仍可交谈'); $('.office-shell').append(roleAccess);
roleAccess.addEventListener('focusin', (event) => {
  const node = event.target.closest('[data-role]');
  const scene = window.irixiOffice?.scene; const person = scene?.people.get(node?.dataset.role);
  if (!node || !person) return;
  const camera = scene.cameras.main;
  const width = scene.scale.width, height = scene.scale.height;
  const x = (person.sprite.x - camera.worldView.x) * camera.zoom;
  const y = (person.sprite.y - camera.worldView.y) * camera.zoom + 35;
  node.style.left = `${Math.max(12, Math.min(width - 248, x - 118))}px`;
  node.style.top = `${Math.max(12, Math.min(height - 100, y))}px`;
});
const recipient = document.createElement('button'); recipient.id = 'wb-recipient'; recipient.type = 'button'; recipient.dataset.action = 'role-works'; $('.coworker-heading').prepend(recipient);
$('.conversation-column').innerHTML = `<div class="wb-scroll"><div id="wb-memory-entry"></div><div id="wb-memory-slot"></div><div id="wb-role-work-list"></div><div id="wb-handoff"></div><div id="wb-history" aria-live="polite" aria-relevant="additions"></div><div id="wb-activity-slot"></div><div id="wb-noobi-status"></div><div id="wb-noobi-approvals"></div><div id="wb-errors"></div><div id="wb-results-slot"></div></div><form id="project-instructions-form" class="message-form"><div id="wb-editing"></div><div class="wb-compose-box"><div id="wb-materials" class="wb-chips"></div><div id="wb-chips" class="wb-chips"></div><label class="visually-hidden" for="project-instructions-text">发送消息</label><textarea id="project-instructions-text" rows="2" maxlength="20000" placeholder="说说你的想法，或交代下一步…"></textarea><div class="wb-tools">${button('composer-menu', '添加材料或引用', 'plus')}<button id="wb-directory" type="button" class="wb-label-button wb-directory" data-action="directory"></button><div class="wb-models"><select id="wb-connection" aria-label="模型连接"></select><select id="wb-model" aria-label="模型"></select><select id="wb-effort" aria-label="思考强度"></select></div>${button('stop', '停止当前工作', 'stop', 'id="wb-stop" hidden')}<button id="wb-send" type="submit" class="wb-icon wb-send" aria-label="发送">${icon('send')}</button></div></div><div id="project-instructions-status" class="wb-compose-note" role="status">Enter 发送 · Shift+Enter 换行</div></form>`;
const input = $('#project-instructions-text'); const form = $('#project-instructions-form'); const status = $('#project-instructions-status');
attachProjectMapHotspot({ shell: $('.office-shell'), sceneProvider: () => window.irixiOffice?.scene, onActivate: () => { sidebar($('#project-sidebar').hidden); if (!$('#project-sidebar').hidden && currentId) open(); } });
const materialInput = document.createElement('input'); materialInput.type = 'file'; materialInput.multiple = true; materialInput.hidden = true; document.body.append(materialInput);
materialInput.addEventListener('change', async () => {
  const cid = materialInput.dataset.cid;
  try { for (const file of materialInput.files) { if (file.size > 1000000) throw new Error('单个材料最多 1 MB。可将较大资料放到文件夹，在对话中说明位置。'); const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192)); await actionApi(cid, 'material', { requestId: uuid(), name: file.name, base64: btoa(binary) }); } await refresh(); notice('材料已加入。发送消息后按你的要求读取。'); } catch (error) { notice(error.message, true); } finally { materialInput.value = ''; }
});
document.addEventListener('input', (event) => { const key = event.target.dataset.runKey; if (!key) return; const box = event.target.closest('.wb-artifact'); artifactInputs.set(key, { args: box.querySelector('[data-run-args]').value, stdin: box.querySelector('[data-run-stdin]').value }); });
function captureNoobiAnswer(event) {
  const box = event.target.closest('.wb-noobi-approval'); if (!box) return;
  const values = {};
  for (const field of box.querySelectorAll('[data-noobi-question]')) {
    const option = field.querySelector('[data-answer-option]')?.value || '';
    values[field.dataset.noobiQuestion] = { option, text: field.querySelector('[data-answer-text]').value };
    field.querySelector('[data-answer-free]').hidden = Boolean(field.querySelector('[data-answer-option]') && option !== '__irixi_other__');
  }
  localStorage.setItem(box.dataset.noobiDraft, JSON.stringify(values));
}
document.addEventListener('input', captureNoobiAnswer); document.addEventListener('change', captureNoobiAnswer);
document.addEventListener('input', captureMemoryEditor);
document.addEventListener('submit', (event) => { if (event.target.matches('[data-memory-editor]')) { event.preventDefault(); void changeMemory('edit'); } });
form.addEventListener('submit', send);
input.addEventListener('input', () => { captureDraft(); renderComposer(); });
input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); } });
document.addEventListener('change', async (event) => {
  try {
    if (event.target.id === 'wb-reduced-motion') { reducedMotion = event.target.checked; localStorage.setItem('irixi.workbench.reduced-motion', String(reducedMotion)); syncOffice(); }
    if (event.target.id === 'wb-font-size') { await api('/api/conversation/preferences', { fontSize: Number(event.target.value) }); await refresh(); }
    if (['wb-model', 'wb-effort', 'wb-connection'].includes(event.target.id)) {
      const model = data.catalogue.models.find((m) => m.id === $('#wb-model').value);
      selection = { ...selection, provider: 'desktop-codex', model: $('#wb-model').value, effort: event.target.id === 'wb-model' ? model.defaultEffort : $('#wb-effort').value };
      if (event.target.id === 'wb-connection') { selection.connectionId = $('#wb-connection').value === 'openai-api-key' ? 'openai-api-key' : null; delete selection.connectionRevision; }
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
    if (node.dataset.role) { if (window.irixiOffice) window.irixiOffice.talkToRole(node.dataset.role); else await openRole(node.dataset.role); return; }
    if (node.dataset.roleWork) return await select(node.dataset.roleWork, null, { role: selectedRole });
    if (node.dataset.select) return await select(node.dataset.select);
    if (node.dataset.collapse) { const set = new Set(data.preferences.collapsedProjects); set.has(node.dataset.collapse) ? set.delete(node.dataset.collapse) : set.add(node.dataset.collapse); await api('/api/conversation/preferences', { collapsedProjects: [...set] }); return await refresh(); }
    if (node.matches('[data-view-target="connections"]')) { showView('connections'); [openaiConnection, deepseekConnection] = await Promise.all([api('/api/conversation/connections/openai'), api('/api/conversation/connections/deepseek')]); renderSettings(); return; }
    if (node.matches('[data-view-target="office"]')) return showView('office');
    if (node.matches('[data-project-dialogue-expand]')) { expanded = !expanded; localStorage.setItem(`irixi.workbench.expanded.${windowId}`, String(expanded)); return open(); }
    if (node.matches('[data-project-dialogue-close]')) { snapshotDraft(); panel.hidden = true; syncOffice(); return; }
    if (node.matches('[data-project-dialogue-list]')) return sidebar($('#project-sidebar').hidden);
    const c = current(); const message = c?.messages.find((m) => m.id === node.closest('[data-message]')?.dataset.message);
    switch (node.dataset.action) {
      case 'memory-open': await loadMemory(currentId, 'office'); break;
      case 'memory-all': await loadMemory(null, memoryTarget); break;
      case 'memory-editor-refresh': await loadMemory(memoryEditor.context, memoryTarget); break;
      case 'memory-settings': await loadMemory(null, 'settings'); break;
      case 'memory-close': memoryTarget = null; renderMemory(); break;
      case 'memory-refresh': await loadMemory(); break;
      case 'memory-edit': beginMemoryEdit(node.dataset.memoryId); break;
      case 'memory-cancel': memoryEditor = null; memoryError = ''; saveMemoryEditor(); renderMemory(); break;
      case 'memory-deactivate': await changeMemory('deactivate', node.dataset.memoryId); break;
      case 'memory-restore': await changeMemory('restore', node.dataset.memoryId); break;
      case 'memory-delete': await changeMemory('delete', node.dataset.memoryId); break;

      case 'noobi-accept': case 'noobi-decline': {
        const box = node.closest('.wb-noobi-approval'), answers = {};
        for (const field of box.querySelectorAll('[data-noobi-question]')) {
          const option = field.querySelector('[data-answer-option]');
          answers[field.dataset.noobiQuestion] = [option && option.value !== '__irixi_other__' ? option.value : field.querySelector('[data-answer-text]').value];
        }
        await actionApi(box.dataset.noobiCid, 'noobi-approval', { token: box.dataset.noobiToken, decision: node.dataset.action === 'noobi-accept' ? 'accept' : 'decline', answers });
        localStorage.removeItem(box.dataset.noobiDraft); notice('答复正在送达，收到执行端确认后继续。'); await refresh(); break;
      }
      case 'remove-material': await actionApi(currentId, 'material', { removeId: node.dataset.material }); await refresh(); break;
      case 'application': { const operation = node.dataset.operation; await actionApi(currentId, 'application', { action: operation }); await refresh(); break; }
      case 'dependencies': { await actionApi(currentId, 'application', { action: 'dependencies', allowed: node.dataset.allowed === 'true' }); await refresh(); break; }
      case 'run-artifact': { const box = node.closest('.wb-artifact'); const args = box.querySelector('[data-run-args]').value; const stdin = box.querySelector('[data-run-stdin]').value; await actionApi(currentId, 'run-artifact', { requestId: uuid(), turnId: node.dataset.turn, target: node.dataset.target, arguments: args ? args.split('\n') : [], stdin }); await refresh(); break; }
      case 'role-works': await select(null, null, { role: current()?.work?.ownerId || selectedRole, list: true }); break;
      case 'new-role-chat': await select(null, null, { role: selectedRole }); break;
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
      case 'composer-menu': showMenu(node, [{ label: '添加文件材料…', run: async () => { const cid = currentId || await create(null, selectedRole, { carryDraft: true }); materialInput.dataset.cid = cid; materialInput.click(); } }, { label: '引用其他对话…', run: referencePicker }, { label: '粘贴对话链接并引用…', run: async () => { const raw = await dialog({ title: '对话深度链接' }); if (!raw) return; const u = new URL(raw); if (!(u.protocol === 'irixi:' || u.origin === location.origin)) throw new Error('请使用本机产品中的对话链接。'); await addReference({ conversationId: u.searchParams.get('conversation') || u.searchParams.get('id'), messageId: u.searchParams.get('message') }); } }]); break;
      case 'archives': { const archived = data.conversations.filter((v) => v.archived); if (!archived.length) { notice('没有已归档的对话。'); break; } const cid = await dialog({ title: '已归档对话', options: archived.map((v) => ({ value: v.id, label: v.title })), value: archived[0].id, submit: '打开' }); if (cid) await select(cid); break; }
      case 'restore-current': await update(currentId, { archived: false }); break;
      case 'reconnect-openai': {
        const modelSelection = { ...selection, connectionId: 'openai-api-key' }; delete modelSelection.connectionRevision;
        await update(currentId, { modelSelection });
        notice('已重新连接当前密钥。尚未调用模型；现在可发送“继续”。'); break;
      }
      case 'openai-configure': case 'openai-status': {
        if (openaiBusy) break;
        openaiBusy = true; renderSettings();
        try {
          if (node.dataset.action === 'openai-configure') { const result = await api('/api/conversation/connections/openai/configure', {}); notice(result.message); }
          openaiConnection = await api('/api/conversation/connections/openai');
        } finally { openaiBusy = false; renderSettings(); }
        break;
      }
      case 'deepseek-configure': case 'deepseek-verify': case 'deepseek-status': {
        if (deepseekBusy) break;
        deepseekBusy = true; renderSettings();
        try {
          const operation = node.dataset.action.slice('deepseek-'.length);
          if (operation === 'configure') { const result = await api('/api/conversation/connections/deepseek/configure', {}); notice(result.message); }
          deepseekConnection = operation === 'verify'
            ? await api('/api/conversation/connections/deepseek/verify', {})
            : await api('/api/conversation/connections/deepseek');
        } finally { deepseekBusy = false; renderSettings(); }
        break;
      }
      case 'refresh-models': await api('/api/conversation/models'); await refresh(); notice('可用模型已刷新。'); break;
      default: if (node.matches('[data-project-chat-new], [data-open-dialog]')) await create();
    }
  } catch (error) { notice(error.message, true); }
});
window.addEventListener('irixi:coworker', (event) => { void openRole(event.detail?.role).catch((error) => notice(error.message, true)); });
// Arrival only finishes the walk; the click already selected the work and draft.
window.addEventListener('irixi:office-ready', syncOffice);
window.addEventListener('resize', syncOffice);
new ResizeObserver(syncOffice).observe(panel);
window.addEventListener('popstate', () => { const q = new URLSearchParams(location.search); void select(q.get('conversation'), q.get('message'), { role: q.get('colleague') }); });
window.addEventListener('pagehide', () => { snapshotDraft(); });
const initial = getDraft(currentId); input.value = initial.text; references = initial.references || []; editTarget = initial.editTarget || null;
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('irixi-workbench-windows') : null;
const instanceId = uuid(); let settledIdentity = false;
if (channel) { channel.onmessage = (event) => {
  const m = event.data; if (m.windowId !== windowId || m.instanceId === instanceId) return;
  if (m.type === 'probe' && settledIdentity) channel.postMessage({ type: 'owned', windowId, instanceId });
  if (m.type === 'owned' && !settledIdentity) { const old = snapshotDraft(); windowId = uuid(); sessionStorage.setItem('irixi.workbench.window', windowId); old.revision = 0; localStorage.setItem(localKey(currentId), JSON.stringify(old)); locationForCurrent(); }
}; channel.postMessage({ type: 'probe', windowId, instanceId }); setTimeout(() => { settledIdentity = true; }, 250); }
locationForCurrent(); open(); sidebar(localStorage.getItem('irixi.workbench.sidebar') === 'true');
refresh().catch((error) => notice(error.message, true));
setInterval(() => refresh().catch((error) => { offline = true; render(); notice(error.message, true); }), 1800);
