export const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function safeLink(url) {
  try { const parsed = new URL(url, 'http://127.0.0.1'); return ['http:', 'https:', 'mailto:'].includes(parsed.protocol) ? escapeHtml(url) : '#'; }
  catch { return '#'; }
}
// Only a host-adopted turn can turn a file citation into a versioned preview.
// The preview server still verifies the actual bytes and its existing path rules.
export function artifactFileLink(target, turn) {
  if (!turn?.adoptedAt || !turn.id || !turn.projectId || !turn.resultIndex) return null;
  let name = String(target);
  if (name.startsWith('file:///')) name = name.slice('file://'.length);
  else if (/^[a-z][a-z0-9+.-]*:|^\/\//iu.test(name)) return null;
  try { name = decodeURIComponent(name); } catch { return null; }
  if (/[\\\x00-\x1f\x7f?#]/u.test(name) || name.split('/').includes('..')) return null;
  if (name.startsWith('/')) {
    const roots = [turn.workspace, turn.projectIdentity?.path, turn.projectIdentity?.canonical]
      .filter((root) => typeof root === 'string' && root.startsWith('/') && root.length > 1)
      .map((root) => root.replace(/\/+$/u, '')).sort((a, b) => b.length - a.length);
    const root = roots.find((root) => name.startsWith(root + '/'));
    if (!root) return null;
    name = name.slice(root.length + 1);
  } else if (name.startsWith('./')) name = name.slice(2);
  if (!name || name.split('/').some((part) => !part || part.startsWith('.') || /^(?:credentials?|secrets?)(?:\.|$)/iu.test(part)) || /\.(?:pem|key|p12|pfx)$/iu.test(name)) return null;
  if (!Object.hasOwn(turn.resultIndex, name) || typeof turn.resultIndex[name] !== 'string' || !turn.resultIndex[name]) return null;
  const route = name === turn.artifactEntrypoint && name === 'dist/index.html' ? '__run__/index.html' : name;
  return `/conversation-preview/${encodeURIComponent(turn.projectId)}/${route.split('/').map(encodeURIComponent).join('/')}?turn=${encodeURIComponent(turn.id)}`;
}
const isFileReference = (url) => /^(?:file:|[A-Za-z]:[\\/])/iu.test(url) || !/^(?:[a-z][a-z0-9+.-]*:|\/\/|[?#]|\/(?:$|\?|api(?:\/|$)|conversation-preview(?:\/|$)))/iu.test(url);
function inline(text, artifactTurn) {
  const parts = [];
  let value = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => { parts.push(`<code>${code}</code>`); return `\u0000${parts.length - 1}\u0000`; });
  value = value.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, target) => {
    const url = target.replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[entity]));
    if (isFileReference(url)) {
      const href = artifactFileLink(url, artifactTurn);
      return href ? `<a target="_blank" rel="noopener noreferrer" href="${escapeHtml(href)}">${label}</a>` : `<code title="${escapeHtml(url)}">${label}</code>`;
    }
    return `<a target="_blank" rel="noopener noreferrer" href="${safeLink(url)}">${label}</a>`;
  })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return value.replace(/\u0000(\d+)\u0000/g, (_, n) => parts[Number(n)] || '');
}
// Escape first; never admit raw HTML from model/user messages into the office origin.
export function renderMarkdown(text, { artifactTurn } = {}) {
  const renderInline = (value) => inline(value, artifactTurn);
  const lines = String(text).split('\n'); const blocks = []; let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*```/.test(line)) {
      const language = line.replace(/^\s*```/, '').trim(); const code = []; index++;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      index++; blocks.push(`<div class="wb-code"><div><span>${escapeHtml(language || '代码')}</span><button type="button" data-action="copy-code">复制代码</button></div><pre><code>${escapeHtml(code.join('\n'))}</code></pre></div>`); continue;
    }
    if (!line.trim()) { index++; continue; }
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((s) => s.trim());
      const headers = cells(line); index += 2; const rows = [];
      while (index < lines.length && lines[index].includes('|')) rows.push(cells(lines[index++]));
      blocks.push(`<div class="wb-table"><table><thead><tr>${headers.map((cell) => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`); continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/); if (heading) { blocks.push(`<h${heading[1].length + 1}>${renderInline(heading[2])}</h${heading[1].length + 1}>`); index++; continue; }
    if (/^\s*(?:[-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line); const rows = [];
      while (index < lines.length && /^\s*(?:[-*]|\d+\.)\s+/.test(lines[index])) rows.push(lines[index++].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
      const tag = ordered ? 'ol' : 'ul'; blocks.push(`<${tag}>${rows.map((row) => `<li>${renderInline(row)}</li>`).join('')}</${tag}>`); continue;
    }
    if (/^>\s?/.test(line)) { blocks.push(`<blockquote>${renderInline(line.replace(/^>\s?/, ''))}</blockquote>`); index++; continue; }
    const paragraph = [line]; index++;
    while (index < lines.length && lines[index].trim() && !/^(?:\s*```|#{1,4}\s|>\s|\s*[-*]\s|\s*\d+\.\s)/.test(lines[index])) paragraph.push(lines[index++]);
    blocks.push(`<p>${paragraph.map(renderInline).join('<br>')}</p>`);
  }
  return blocks.join('');
}

const icons = {
  folder: '<path d="M3 7V5a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v12H3z"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>', plus: '<path d="M12 5v14M5 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
  quote: '<path d="M4 5h6v7H4zM14 5h6v7h-6zM10 12c0 5-4 7-6 7M20 12c0 5-4 7-6 7"/>',
  edit: '<path d="m14 4 6 6-10 10H4v-6zM12 6l6 6"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10M6 15c8 0 12-3 12-8"/>',
  link: '<path d="m10 14 4-4M8 16l-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(1 0) scale(.9)"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>', pin: '<path d="M8 3h8l-1 6 4 4H5l4-4zM12 13v8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>', send: '<path d="m5 12 7-7 7 7M12 5v15"/>',
  attachment: '<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2"/>',
};
export const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.more}</svg>`;

export function visibleMessageText(text) {
  return renderMarkdown(text).replace(/<button[^>]*>[\s\S]*?<\/button>/g, '').replace(/<\/?(?:p|div|pre|blockquote|h[1-6]|li|ul|ol|table|tr|td|th)\b[^>]*>|<br\s*\/?\s*>/g, ' ').replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
}
