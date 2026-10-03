import crypto from 'node:crypto';

import { addMaterial } from './core.mjs';
import { assertMaterialEligible, bindGeneratedEvidence, materialContext } from './material-applicability.mjs';
import { readPublicPage, searchPublicWeb } from './web-tools.mjs';

const asciiFold = (value) => String(value || '').replaceAll(/[A-Z]/g, (character) => character.toLowerCase());
const normalize = (value) => asciiFold(value).replaceAll(/\s+/g, ' ').trim();
const wordSegmenter = new Intl.Segmenter('und', { granularity: 'word' });
const MATERIAL_RESULT_LIMIT = 30;
const MEMORY_RESULT_LIMIT = 12;
const SEARCH_ITEM_CHARS = 1_000;
const MATERIAL_RESULTS_CHARS = 24_000;
const MEMORY_RESULTS_CHARS = 18_000;
const MATERIAL_READ_LINE_LIMIT = 120_000;

function uniqueTerms(values) {
  const terms = [];
  const seen = new Set();
  for (const value of values) {
    const term = normalize(value);
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  const hasLongerTerm = terms.some((term) => [...term].length > 1);
  return terms.filter((term) => !hasLongerTerm || !/^\p{Script=Han}$/u.test(term)).slice(0, 24);
}

function queryTerms(task, item, query = '') {
  const text = query || `${item.title || ''} ${item.expectedResult || ''} ${task.goal?.versions?.find((goal) => goal.id === task.goal.activeVersionId)?.statement || ''}`;
  const segmented = [...wordSegmenter.segment(text)].filter((entry) => entry.isWordLike).map((entry) => entry.segment);
  const explicit = text.match(/[\p{Script=Han}]+|[\p{Letter}\p{Number}][\p{Letter}\p{Number}_-]*/gu) || [];
  return uniqueTerms([...segmented, ...explicit]);
}

function occurrences(text, term) {
  let count = 0;
  let offset = 0;
  while (count < 3) {
    const found = text.indexOf(term, offset);
    if (found < 0) break;
    count += 1;
    offset = found + Math.max(1, term.length);
  }
  return count;
}

function relevance(text, title, query, terms) {
  const haystack = normalize(text);
  const normalizedTitle = normalize(title);
  const matched = terms.filter((term) => haystack.includes(term) || normalizedTitle.includes(term));
  if (!matched.length) return null;
  const phrase = normalize(query);
  const coverage = matched.length / Math.max(1, terms.length);
  let score = coverage * 100;
  for (const term of matched) {
    score += Math.min(6, [...term].length) + occurrences(haystack, term) * 0.25;
    if (normalizedTitle.includes(term)) score += 8;
  }
  if (phrase && haystack.includes(phrase)) score += 40;
  if (phrase && normalizedTitle.includes(phrase)) score += 50;
  return { score, matched };
}

function excerptWindow(text, needles, maxChars = SEARCH_ITEM_CHARS) {
  const original = String(text || '');
  const lowered = asciiFold(original);
  const normalizedNeedles = [...new Set(needles.map(asciiFold).filter(Boolean))];
  const anchors = [0];
  for (const needle of normalizedNeedles) {
    const first = lowered.indexOf(needle);
    const last = lowered.lastIndexOf(needle);
    if (first >= 0) anchors.push(first);
    if (last >= 0) anchors.push(last);
    for (let part = 1; part <= 8; part += 1) {
      const position = lowered.indexOf(needle, Math.floor((lowered.length * part) / 9));
      if (position >= 0) anchors.push(position);
    }
  }
  let best = null;
  for (const anchor of [...new Set(anchors)]) {
    const anchorNeedle = normalizedNeedles.find((needle) => lowered.startsWith(needle, anchor)) || '';
    const width = Math.max(maxChars, anchorNeedle.length);
    let start = Math.max(0, anchor - Math.floor((width - anchorNeedle.length) / 2));
    let end = Math.min(original.length, start + width);
    start = Math.max(0, end - width);
    const sample = lowered.slice(start, end);
    const covered = normalizedNeedles.filter((needle) => sample.includes(needle));
    const score = covered.length * 10_000 + covered.reduce((sum, needle) => sum + needle.length, 0);
    if (!best || score > best.score || (score === best.score && start < best.start)) best = { start, end, score };
  }
  const { start, end } = best;
  const startLine = original.slice(0, start).split('\n').length;
  const endLine = original.slice(0, end).split('\n').length;
  return {
    excerpt: original.slice(start, end),
    start,
    end,
    startLine,
    endLine,
    truncated: start > 0 || end < original.length,
  };
}

function capRankedResults(ranked, limit, maxChars) {
  const selected = [];
  let used = 2;
  for (const entry of ranked) {
    if (selected.length >= limit) break;
    const size = JSON.stringify(entry).length + (selected.length ? 1 : 0);
    if (selected.length && used + size > maxChars - 400) break;
    selected.push(entry);
    used += size;
  }
  const omitted = ranked.length - selected.length;
  if (omitted > 0 && selected.length) {
    selected.at(-1).resultSetTruncated = true;
    selected.at(-1).omittedMatches = omitted;
    selected.at(-1).nextSearch = '使用更具体的 query 缩小范围后再次搜索；结果已按相关性排序。';
  }
  return selected;
}

function boundedConflictSources(values, maxChars = 2_000) {
  const selected = [];
  let used = 0;
  for (const value of [...new Set(values.filter(Boolean).map(String))]) {
    if (selected.length >= 20 || used + value.length > maxChars) break;
    selected.push(value);
    used += value.length;
  }
  return selected;
}

function searchMaterials(task, item, query) {
  const terms = queryTerms(task, item, query);
  if (!terms.length) return [];
  const matches = [];
  const readyMaterials = materialContext(task).effectiveMaterials;
  for (let materialIndex = 0; materialIndex < readyMaterials.length; materialIndex += 1) {
    const material = readyMaterials[materialIndex];
    const lines = String(material.text || '').split(/\r?\n/);
    let bodyMatched = false;
    for (let index = 0; index < lines.length; index += 1) {
      const ranked = relevance(lines[index], '', query, terms);
      if (!ranked) continue;
      bodyMatched = true;
      const window = excerptWindow(lines[index], ranked.matched);
      const singleLineTooLong = `${index + 1}| ${lines[index]}`.length + 1 > MATERIAL_READ_LINE_LIMIT;
      matches.push({
        materialId: material.id,
        sourceName: material.name,
        source: material.source,
        locator: `L${index + 1}-L${index + 1}`,
        quote: window.excerpt,
        quoteCharRange: `C${window.start + 1}-C${window.end}`,
        truncated: window.truncated,
        matchedIn: 'content',
        readNext: window.truncated ? (singleLineTooLong
          ? { available: false, instruction: `L${index + 1} 超过材料读取的单行安全上限；如需完整行，请先拆分材料后重试。` }
          : { tool: 'materials.read', args: { materialIds: [material.id], startLine: index + 1, maxLines: 1 }, instruction: `读取 ${material.name} 的 L${index + 1} 全行。` }) : null,
        matched: ranked.matched,
        relevanceScore: Number(ranked.score.toFixed(3)),
        _order: materialIndex * 1_000_000 + index,
      });
    }
    const titleRanked = bodyMatched ? null : relevance('', material.name, query, terms);
    if (titleRanked) {
      const content = String(material.text || '');
      const window = excerptWindow(content, []);
      const firstLine = lines[0] || '';
      const firstLineTooLong = `1| ${firstLine}`.length + 1 > MATERIAL_READ_LINE_LIMIT;
      matches.push({
        materialId: material.id,
        sourceName: material.name,
        source: material.source,
        locator: `L${window.startLine}-L${window.endLine}`,
        quote: window.excerpt,
        contentCharRange: `C${window.start + 1}-C${window.end}`,
        truncated: window.truncated,
        matchedIn: 'title',
        readNext: window.truncated ? (firstLineTooLong
          ? { available: false, instruction: '材料首行超过读取的单行安全上限；如需完整行，请先拆分材料后重试。' }
          : { tool: 'materials.read', args: { materialIds: [material.id], startLine: 1, maxLines: Math.max(1, window.endLine) }, instruction: `从 ${material.name} 的 L1 开始读取。` }) : null,
        matched: titleRanked.matched,
        relevanceScore: Number(titleRanked.score.toFixed(3)),
        _order: materialIndex * 1_000_000 - 1,
      });
    }
  }
  matches.sort((left, right) => right.relevanceScore - left.relevanceScore || right.matched.length - left.matched.length || left._order - right._order);
  return capRankedResults(matches.map(({ _order, ...entry }) => entry), MATERIAL_RESULT_LIMIT, MATERIAL_RESULTS_CHARS);
}

function readMaterialPackets(task, args = {}, maxChars = 120_000) {
  const requestedIds = Array.isArray(args.materialIds) ? [...new Set(args.materialIds.map(String))] : [];
  if (!requestedIds.length) throw new Error('材料读取必须提供至少一个 materialId。');
  if (requestedIds.length > 12) throw new Error('一次最多读取 12 份材料。');
  const materials = requestedIds.map((materialId) => {
    return assertMaterialEligible(task, materialId);
  });
  const startLine = Number.isInteger(args.startLine) ? args.startLine : 1;
  const maxLines = Number.isInteger(args.maxLines) ? args.maxLines : 2_000;
  if (startLine < 1 || maxLines < 1 || maxLines > 5_000) throw new Error('材料读取行号无效；maxLines 必须为 1–5000。');
  const perMaterialBudget = Math.max(2_000, Math.floor(maxChars / materials.length));
  return materials.map((material) => {
    const lines = String(material.text || '').split(/\r?\n/);
    if (startLine > lines.length) throw new Error(`材料 ${material.id} 只有 ${lines.length} 行，无法从 L${startLine} 读取。`);
    const selected = [];
    let used = 0;
    const upper = Math.min(lines.length, startLine - 1 + maxLines);
    for (let index = startLine - 1; index < upper; index += 1) {
      const rendered = `${index + 1}| ${lines[index]}`;
      if (!selected.length && rendered.length + 1 > perMaterialBudget) {
        throw new Error(`材料 ${material.id} 的 L${index + 1} 单行超过可读上限，请先将该行拆分后重试。`);
      }
      if (selected.length && used + rendered.length + 1 > perMaterialBudget) break;
      selected.push(rendered);
      used += rendered.length + 1;
      if (used >= perMaterialBudget) break;
    }
    const endLine = startLine + selected.length - 1;
    const truncated = endLine < lines.length;
    const excerpt = selected.join('\n');
    return {
      materialId: material.id,
      sourceName: material.name,
      source: material.source,
      metadata: material.generatedEvidence === true ? {
        evidenceType: 'web-read',
        finalUrl: material.source,
        fetchedAt: material.fetchedAt || null,
        httpStatus: material.evidenceMetadata?.httpStatus ?? null,
        contentType: material.evidenceMetadata?.contentType || null,
        resolutionMode: material.evidenceMetadata?.resolutionMode || null,
        contentSha256: material.evidenceSha256 || null,
        sourceLocator: material.locator || null,
      } : null,
      locator: `L${startLine}-L${endLine}`,
      excerpt,
      excerptSha256: crypto.createHash('sha256').update(excerpt).digest('hex'),
      truncated,
      nextStartLine: truncated ? endLine + 1 : null,
      totalLines: lines.length,
    };
  });
}

function tokenizeExpression(expression) {
  const compact = String(expression || '').replaceAll(/\s+/g, '');
  if (!compact || compact.length > 120 || !/^[0-9.+\-*/()%]+$/.test(compact)) throw new Error('计算器只接受数字、括号和 + - * / %。');
  const tokens = compact.match(/\d+(?:\.\d+)?|[()+\-*/%]/g) || [];
  if (tokens.join('') !== compact) throw new Error('计算表达式包含不支持的内容。');
  return tokens;
}

export function safeCalculate(expression) {
  const tokens = tokenizeExpression(expression);
  let position = 0;
  const factor = () => {
    const token = tokens[position];
    if (token === '+' || token === '-') { position += 1; const value = factor(); return token === '-' ? -value : value; }
    if (token === '(') { position += 1; const value = sum(); if (tokens[position] !== ')') throw new Error('计算表达式括号不匹配。'); position += 1; return value; }
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error('计算表达式缺少数字。');
    position += 1;
    return value;
  };
  const product = () => {
    let value = factor();
    while (['*', '/', '%'].includes(tokens[position])) {
      const operator = tokens[position++];
      const right = factor();
      if ((operator === '/' || operator === '%') && right === 0) throw new Error('不能除以零。');
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right;
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (['+', '-'].includes(tokens[position])) {
      const operator = tokens[position++];
      const right = product();
      value = operator === '+' ? value + right : value - right;
    }
    return value;
  };
  const result = sum();
  if (position !== tokens.length || !Number.isFinite(result)) throw new Error('计算表达式无效或结果超出范围。');
  return result;
}

function sourceValue(task, sourceRef, value) {
  const match = /^material:([^#]+)#L(\d+)-L(\d+)$/.exec(String(sourceRef || ''));
  if (!match) throw new Error('计算输入必须引用 material:<id>#Lx-Ly。');
  const material = assertMaterialEligible(task, match[1]);
  const start = Number(match[2]);
  const end = Number(match[3]);
  const lines = String(material.text || '').split(/\r?\n/);
  if (start < 1 || end < start || end > lines.length) throw new Error('计算输入引用的材料行号无效。');
  const excerpt = lines.slice(start - 1, end).join('\n');
  const numericTokens = (excerpt.match(/(?<![\d.])[-+]?\d[\d,]*(?:\.\d+)?(?![\d.])/g) || []).map((token) => Number(token.replaceAll(',', '')));
  if (!numericTokens.some((candidate) => Number.isFinite(candidate) && candidate === Number(value))) throw new Error(`计算输入值 ${value} 未作为完整数值出现在所引用原文。`);
  return { materialId: material.id, sourceName: material.name, locator: `L${start}-L${end}`, quote: excerpt };
}

function calculateRequest(task, args = {}) {
  const inputs = (Array.isArray(args.inputs) ? args.inputs : []).map((input) => ({
    name: String(input.name || '').trim(), value: Number(input.value), sourceRef: String(input.sourceRef || '').trim(),
  }));
  if (!inputs.length || inputs.length > 20) throw new Error('计算请求必须提供 1–20 个带来源输入。');
  if (new Set(inputs.map((input) => input.name)).size !== inputs.length || inputs.some((input) => !/^[A-Za-z][A-Za-z0-9_]{0,30}$/.test(input.name) || !Number.isFinite(input.value))) {
    throw new Error('计算输入名称或数值无效。');
  }
  const evidence = inputs.map((input) => sourceValue(task, input.sourceRef, input.value));
  let expression = String(args.expression || '').trim();
  const identifiers = [...new Set(expression.match(/[A-Za-z][A-Za-z0-9_]*/g) || [])];
  if (identifiers.some((name) => !inputs.some((input) => input.name === name))) throw new Error('计算表达式引用了未声明输入。');
  for (const input of inputs) expression = expression.replaceAll(new RegExp(`\\b${input.name}\\b`, 'g'), String(input.value));
  const result = safeCalculate(expression);
  return { expression: String(args.expression), normalizedExpression: expression, inputs: inputs.map((input, index) => ({ ...input, evidence: evidence[index] })), result };
}

export async function searchMemory(store, task, item, query, requestedScope = 'task') {
  if (requestedScope === 'workspace-confirmed' && task.memoryPolicy !== 'workspace-confirmed') throw new Error('当前任务未授权跨任务记忆。');
  const terms = queryTerms(task, item, query);
  if (!terms.length) return [];
  const documents = [];
  const candidates = requestedScope === 'workspace-confirmed' ? await store.list() : [task];
  for (let taskIndex = 0; taskIndex < candidates.length; taskIndex += 1) {
    const candidate = candidates[taskIndex];
    for (const artifact of candidate.artifacts || []) {
      if (artifact.status !== 'confirmed') continue;
      if (candidate.memoryEntries?.some((entry) => entry.artifactId === artifact.id)) continue;
      documents.push({
        scope: candidate.id === task.id ? 'task' : 'workspace-confirmed', taskId: candidate.id,
        artifactId: artifact.id, artifactVersion: artifact.version, title: artifact.title,
        source: `task:${candidate.id}/artifact:${artifact.id}/v${artifact.version}`,
        confirmedAt: artifact.confirmedAt || null,
        status: 'confirmed',
        goalVersionId: artifact.goalVersionId || null,
        content: String(artifact.content || ''),
        searchable: `${artifact.title || ''} ${artifact.summary || ''} ${artifact.content || ''}`,
        _order: taskIndex,
      });
    }
    for (const entry of candidate.memoryEntries || []) {
      if (!['active', 'conflict'].includes(entry.status) || entry.confirmed !== true) continue;
      const sourceMatch = /^task:([^/]+)\/artifact:([^/]+)\/v(\d+)$/.exec(entry.source || '');
      const sourceVersion = Number(sourceMatch?.[3]) || null;
      const sourceMatchesEntry = sourceMatch?.[1] === candidate.id && sourceMatch?.[2] === entry.artifactId && sourceVersion !== null
        && (entry.artifactVersion == null || Number(entry.artifactVersion) === sourceVersion);
      const backingArtifact = (candidate.artifacts || []).find((artifact) => artifact.id === entry.artifactId
        && sourceMatchesEntry && artifact.version === sourceVersion && ['confirmed', 'superseded_formal'].includes(artifact.status)) || null;
      const content = String(backingArtifact?.content ?? entry.content ?? '');
      documents.push({
        scope: candidate.id === task.id ? 'task' : 'workspace-confirmed', taskId: candidate.id,
        memoryId: entry.id, artifactId: entry.artifactId || null,
        artifactVersion: entry.artifactVersion || sourceVersion || backingArtifact?.version || null,
        title: entry.title, source: entry.source, status: entry.status,
        content,
        searchable: `${entry.title || ''} ${backingArtifact?.summary || ''} ${content}`,
        confirmedAt: backingArtifact?.confirmedAt || null,
        goalVersionId: entry.goalVersionId || backingArtifact?.goalVersionId || null,
        _order: taskIndex,
      });
    }
  }

  const titleGroups = new Map();
  for (const document of documents) {
    const key = normalize(document.title);
    if (!key) continue;
    titleGroups.set(key, [...(titleGroups.get(key) || []), document]);
  }
  const results = [];
  for (const document of documents) {
    const ranked = relevance(document.searchable, document.title, query, terms);
    if (!ranked) continue;
    const normalizedContent = normalize(document.content);
    const contentTerms = ranked.matched.filter((term) => normalizedContent.includes(term));
    const window = excerptWindow(document.content, contentTerms);
    const peers = (titleGroups.get(normalize(document.title)) || []).filter((peer) => peer !== document && normalize(peer.content) !== normalize(document.content));
    const allPeerSources = [...new Set(peers.map((peer) => peer.source).filter(Boolean))];
    const peerSources = boundedConflictSources(allPeerSources);
    results.push({
      use: 'reference-only',
      scope: document.scope,
      taskId: document.taskId,
      goalVersionId: document.goalVersionId,
      ...(document.memoryId ? { memoryId: document.memoryId } : {}),
      ...(document.artifactId ? { artifactId: document.artifactId } : {}),
      artifactVersion: document.artifactVersion,
      title: document.title,
      excerpt: window.excerpt,
      locator: `L${window.startLine}-L${window.endLine}`,
      contentCharRange: `C${window.start + 1}-C${window.end}`,
      truncated: window.truncated,
      matchedIn: contentTerms.length ? 'content' : 'metadata',
      readNext: window.truncated ? {
        available: false,
        source: document.source,
        instruction: '当前工具没有已授权的记忆全文读取入口；请用更具体的 query 定位其他片段，或由用户打开该已确认来源。',
      } : null,
      matched: ranked.matched,
      source: document.source,
      ...(document.confirmedAt ? { confirmedAt: document.confirmedAt } : {}),
      status: peers.length ? 'conflict' : document.status,
      ...(peers.length ? {
        conflictsWith: peerSources,
        conflictCount: allPeerSources.length,
        ...(peerSources.length < allPeerSources.length ? { conflictsTruncated: true, conflictNextStep: '缩小任务范围或按同名来源逐项核对剩余冲突版本。' } : {}),
      } : {}),
      relevanceScore: Number(ranked.score.toFixed(3)),
      _order: document._order,
    });
  }
  results.sort((left, right) => right.relevanceScore - left.relevanceScore || right.matched.length - left.matched.length || left._order - right._order || String(left.source).localeCompare(String(right.source)));
  return capRankedResults(results.map(({ _order, ...entry }) => entry), MEMORY_RESULT_LIMIT, MEMORY_RESULTS_CHARS);
}

const normalizeScopeValue = (value) => String(value || '').trim().replaceAll(/\s+/g, ' ').toLowerCase();

function discoveredWebUrls(task, item) {
  const urls = [];
  for (const session of task.agentSessions || []) if (session.workItemId === item.id) {
    for (const call of session.toolCalls || []) if (call.tool === 'web.search' && call.ok) {
      for (const source of call.result?.sources || []) if (source.url) urls.push(source.url);
    }
  }
  return new Set(urls.map((url) => normalizeScopeValue(url)));
}

export async function runAuthorizedTools(store, task, item, requests = [], { signal, web = { searchPublicWeb, readPublicPage }, onHostedSearchStart, projectWorkspaceHost } = {}) {
  const results = [];
  const seen = new Set();
  for (const request of requests.slice(0, 6)) {
    const id = String(request.id || '').slice(0, 80);
    const name = String(request.tool || '');
    if (!id || seen.has(id)) { results.push({ requestId: id, tool: name, ok: false, error: '工具请求 ID 缺失或重复。', sources: [] }); continue; }
    seen.add(id);
    if (!(item.tools || []).includes(name)) { results.push({ requestId: id, tool: name, ok: false, error: '计划未授权这个工具。', sources: [] }); continue; }
    try {
      if (name === 'materials.read') {
        const packets = readMaterialPackets(task, request.args);
        results.push({ requestId: id, tool: name, ok: true, result: packets, sources: packets.map((entry) => `material:${entry.materialId}#${entry.locator}`) });
      } else if (name === 'materials.search') {
        const query = String(request.args?.query || '').trim().slice(0, 300);
        if (!query) throw new Error('材料搜索必须提供 query。');
        const matches = searchMaterials(task, item, query);
        results.push({ requestId: id, tool: name, ok: true, result: matches, sources: matches.map((entry) => `material:${entry.materialId}#${entry.locator}`) });
      } else if (name === 'memory.search') {
        const query = String(request.args?.query || '').trim().slice(0, 300);
        if (!query) throw new Error('记忆搜索必须提供 query。');
        const memory = await searchMemory(store, task, item, query, request.args?.scope === 'workspace-confirmed' ? 'workspace-confirmed' : 'task');
        results.push({ requestId: id, tool: name, ok: true, result: memory, sources: memory.map((entry) => entry.source) });
      } else if (name === 'calculate') {
        const calculation = calculateRequest(task, request.args);
        results.push({ requestId: id, tool: name, ok: true, result: calculation, sources: calculation.inputs.map((entry) => entry.sourceRef) });
      } else if (name === 'web.search') {
        const query = String(request.args?.query || '').trim().slice(0, 500);
        const allowed = new Set((item.webScope?.queries || []).map(normalizeScopeValue));
        if (!query || !allowed.has(normalizeScopeValue(query))) throw new Error('这个搜索词没有在当前工作项的公开研究范围中预先声明。');
        const found = await web.searchPublicWeb(query, { signal, onHostedSearchStart });
        results.push({
          requestId: id, tool: name, ok: true, evidenceType: 'discovery', result: found,
          sources: (found.sources || []).map((source, index) => `discovery:${found.responseLocator || found.responseUrl || 'web-search'}#${source.locator || `result-${index + 1}`}`),
        });
      } else if (name === 'web.read') {
        const url = String(request.args?.url || '').trim().slice(0, 1_000);
        const allowed = new Set([...(item.webScope?.urls || []).map(normalizeScopeValue), ...discoveredWebUrls(task, item)]);
        if (!url || !allowed.has(normalizeScopeValue(url))) throw new Error('这个网址既未在当前工作项预先声明，也不是本会话受控搜索发现的结果。');
        const page = await web.readPublicPage(url, { signal });
        const stored = await store.mutate(task.id, (draft) => {
          let material = draft.materials.find((entry) => entry.generatedEvidence === true && entry.evidenceSha256 === page.sha256 && entry.source === page.finalUrl);
          if (!material) {
            material = addMaterial(draft, { name: page.title || new URL(page.finalUrl).hostname, kind: 'url', source: page.finalUrl, text: page.text, bytes: page.bytes, generatedEvidence: true });
            material.evidenceSha256 = page.sha256;
            material.fetchedAt = page.fetchedAt;
            material.locator = page.locator;
            material.evidenceMetadata = {
              httpStatus: page.httpStatus,
              contentType: page.contentType,
              resolutionMode: page.resolutionMode || null,
            };
          }
          bindGeneratedEvidence(draft, material, item);
          return structuredClone(material);
        });
        const material = stored.result;
        const packet = readMaterialPackets(stored.task, { materialIds: [material.id] })[0];
        const { text: _rawText, ...pageMetadata } = page;
        results.push({ requestId: id, tool: name, ok: true, evidenceType: 'material', result: { ...pageMetadata, ...packet, materialLocator: packet.locator }, sources: [`material:${material.id}#${packet.locator}`] });
      } else if (name.startsWith('workspace.')) {
        if (!projectWorkspaceHost) throw new Error('项目工作区宿主不可用。');
        const projectResult = await projectWorkspaceHost.runTool(store, task.id, item.id, request, { signal });
        results.push({ requestId: id, tool: name, ok: true, result: projectResult, sources: [] });
      } else results.push({ requestId: id, tool: name, ok: false, error: '未授权工具，未执行。', sources: [] });
    } catch (error) {
      results.push({ requestId: id, tool: name, ok: false, error: error.message, sources: [] });
    }
  }
  return results;
}

export const __test = { queryTerms, searchMaterials, readMaterialPackets, calculateRequest, tokenizeExpression, sourceValue, discoveredWebUrls };
