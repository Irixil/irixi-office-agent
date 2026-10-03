import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { PublicWebError, __test } from '../web-tools.mjs';

const PUBLIC_V4 = '93.184.216.34';
const NOW = '2026-09-30T08:00:00.000Z';

function body(chunks, onDestroy = () => {}) {
  return {
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield Buffer.from(chunk); },
    destroy: onDestroy,
  };
}

function response(statusCode, headers, chunks, onDestroy) {
  const stream = body(chunks, onDestroy);
  return { statusCode, headers, body: stream, destroy: stream.destroy };
}

function fixture(routes, resolver = async () => [{ address: PUBLIC_V4, family: 4 }], dependencies = {}) {
  const calls = [];
  const tools = __test.makeTools({
    resolver,
    now: () => NOW,
    async transport(request) {
      calls.push(request);
      const route = routes[request.url.toString()];
      if (route instanceof Error) throw route;
      if (!route) throw new Error(`unexpected request: ${request.url}`);
      return typeof route === 'function' ? route(request) : route;
    },
    ...dependencies,
  });
  return { ...tools, calls };
}

function codexEvents(query, results = [{ title: 'Node.js docs', url: 'https://nodejs.org/api/' }]) {
  return [
    { type: 'thread.started', thread_id: 'thread-test' },
    { type: 'turn.started' },
    { type: 'item.started', item: { id: 'search-1', type: 'web_search', query: '', action: { type: 'other' } } },
    { type: 'item.completed', item: { id: 'search-1', type: 'web_search', query, action: { type: 'search', query } } },
    { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: JSON.stringify({ status: results.length ? 'ok' : 'no_results', query, results, limitations: 'discovery only' }) } },
    { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } },
  ];
}

function jsonl(events) {
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`;
}

function inertChild(pid = 424_242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('拒绝私网、共享、基准、测试网和 IPv4-mapped IPv6', () => {
  for (const address of [
    '127.0.0.1', '10.0.0.1', '100.64.0.1', '169.254.1.2', '172.16.0.1', '192.168.1.1',
    '192.0.2.1', '198.18.0.1', '198.51.100.2', '203.0.113.9', '224.0.0.1',
    '::', '::1', '::2', '4000::1', 'fec0::1', 'fc00::1', 'fe80::1', '2001:db8::1', '2620:4f:8000::1', '::ffff:172.16.0.1', '::ffff:a00:1',
  ]) assert.equal(__test.isPublicIp(address), false, address);
  assert.equal(__test.isPublicIp(PUBLIC_V4), true);
  assert.equal(__test.isPublicIp('2606:2800:220:1:248:1893:25c8:1946'), true);
});

test('固定 lookup 兼容 Node 标量与 all:true 回调并保留地址族', async () => {
  const lookup = __test.pinnedLookup('2606:4700:4700::1111', 6);
  const scalar = await new Promise((resolve, reject) => lookup('ignored', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  const all = await new Promise((resolve, reject) => lookup('ignored', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(scalar, { address: '2606:4700:4700::1111', family: 6 });
  assert.deepEqual(all, [{ address: '2606:4700:4700::1111', family: 6 }]);
});

test('语法边界在 DNS 或传输前拒绝本机名、保留名、账号和非标准端口', async () => {
  let resolves = 0;
  let requests = 0;
  const tools = __test.makeTools({
    resolver: async () => { resolves += 1; return [{ address: PUBLIC_V4, family: 4 }]; },
    transport: async () => { requests += 1; throw new Error('must not run'); },
  });
  for (const url of ['http://localhost/', 'http://a.test/', 'https://user:pass@example.org/', 'https://example.org:444/']) {
    await assert.rejects(tools.readPublicPage(url), (error) => error instanceof PublicWebError && ['forbidden_target', 'invalid_url'].includes(error.code));
  }
  assert.equal(resolves, 0);
  assert.equal(requests, 0);
});

test('DNS 解析到任何非公网地址时不启动传输', async () => {
  let requests = 0;
  const tools = __test.makeTools({
    resolver: async () => [{ address: PUBLIC_V4, family: 4 }, { address: '100.64.0.1', family: 4 }],
    transport: async () => { requests += 1; throw new Error('must not run'); },
  });
  await assert.rejects(tools.readPublicPage('https://public.example.org/'), (error) => error.code === 'forbidden_target');
  assert.equal(requests, 0);
});

test('仅在系统 DNS 全为 198.18/15 假地址时用固定公网 DoH 查询域名 A 记录', async () => {
  const { readPublicPage, calls } = fixture({
    'https://1.1.1.1/dns-query?name=public.example.org&type=A': response(200, { 'content-type': 'application/dns-json' }, [JSON.stringify({
      Status: 0, TC: false, Answer: [
        { name: 'public.example.org.', type: 5, data: 'edge.example.net.' },
        { name: 'edge.example.net.', type: 1, data: PUBLIC_V4 },
      ],
    })]),
    'https://public.example.org/page': response(200, { 'content-type': 'text/plain' }, ['via doh']),
  }, async () => [{ address: '198.18.0.17', family: 4 }]);
  const result = await readPublicPage('https://public.example.org/page');
  assert.equal(result.resolutionMode, 'doh-fallback');
  assert.equal(result.text, 'via doh');
  assert.deepEqual(calls.map((call) => ({ url: call.url.toString(), address: call.address })), [
    { url: 'https://1.1.1.1/dns-query?name=public.example.org&type=A', address: '1.1.1.1' },
    { url: 'https://public.example.org/page', address: PUBLIC_V4 },
  ]);
  assert.equal(calls[0].headers.Accept, 'application/dns-json');
});

test('DoH 返回私网或没有 A 记录时不请求目标网页', async () => {
  for (const payload of [
    { Status: 0, TC: false, Answer: [{ type: 1, data: '10.0.0.4' }] },
    { Status: 0, TC: false, Answer: [{ type: 5, data: 'elsewhere.example.' }] },
  ]) {
    const { readPublicPage, calls } = fixture({
      'https://1.1.1.1/dns-query?name=public.example.org&type=A': response(200, { 'content-type': 'application/dns-json' }, [JSON.stringify(payload)]),
    }, async () => [{ address: '198.19.255.254', family: 4 }]);
    await assert.rejects(readPublicPage('https://public.example.org/page'), (error) => ['forbidden_target', 'dns_failed'].includes(error.code));
    assert.equal(calls.length, 1);
  }
});

test('正常公网系统 DNS 不增加 DoH 请求并标明解析模式', async () => {
  const { readPublicPage, calls } = fixture({
    'https://public.example.org/page': response(200, { 'content-type': 'text/plain' }, ['system dns']),
  });
  const result = await readPublicPage('https://public.example.org/page');
  assert.equal(result.resolutionMode, 'system-dns');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.hostname, 'public.example.org');
});

test('DoH fallback 与原请求共享 abort，不在取消后请求目标', async () => {
  const controller = new AbortController();
  const calls = [];
  const tools = __test.makeTools({
    resolver: async () => [{ address: '198.18.0.1', family: 4 }],
    transport: async (request) => { calls.push(request); return new Promise(() => {}); },
  });
  const pending = tools.readPublicPage('https://public.example.org/page', { signal: controller.signal, timeoutMs: 1_000 });
  while (!calls.length) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'aborted');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.hostname, '1.1.1.1');
});

test('将传输绑定到解析出的公网 IP 并返回可核验页面证据', async () => {
  const html = '<html><head><title>Example &amp; Proof</title><style>x{}</style></head><body><h1>Hello</h1><script>bad()</script><p>World</p></body></html>';
  const { readPublicPage, calls } = fixture({
    'https://public.example.org/page': response(200, { 'content-type': 'text/html; charset=utf-8' }, [html]),
  });
  const result = await readPublicPage('https://public.example.org/page');
  assert.equal(calls[0].address, PUBLIC_V4);
  assert.equal(calls[0].family, 4);
  assert.equal(calls[0].headers['Accept-Encoding'], 'identity');
  assert.equal(result.resolutionMode, 'system-dns');
  assert.deepEqual({ status: result.status, title: result.title, text: result.text, fetchedAt: result.fetchedAt }, {
    status: 'ok', title: 'Example & Proof', text: 'Example & Proof Hello\nWorld', fetchedAt: NOW,
  });
  assert.match(result.sha256, /^[a-f0-9]{64}$/);
  assert.equal(result.locator, `${result.finalUrl}#sha256=${result.sha256}`);
});

test('HTML 正文保留标题、段落和列表的可分页换行', async () => {
  const text = __test.htmlText('<h1>Title</h1><p>First <b>paragraph</b></p><ul><li>One</li><li>Two</li></ul>');
  assert.deepEqual(text.split('\n'), ['Title', 'First paragraph', '• One', '• Two']);
  assert.ok(__test.htmlText(`<p>${'x'.repeat(9_000)}</p>`).split('\n').every((line) => line.length <= 4_000));
});

test('每次重定向重新解析并把下一连接绑定到新的已验证地址', async () => {
  const addresses = new Map([['one.example.org', '93.184.216.34'], ['two.example.org', '1.1.1.1']]);
  const { readPublicPage, calls } = fixture({
    'https://one.example.org/start': response(302, { location: 'https://two.example.org/final' }, []),
    'https://two.example.org/final': response(200, { 'content-type': 'text/plain' }, ['redirected']),
  }, async (hostname) => [{ address: addresses.get(hostname), family: 4 }]);
  const result = await readPublicPage('https://one.example.org/start');
  assert.deepEqual(calls.map((call) => call.address), ['93.184.216.34', '1.1.1.1']);
  assert.equal(result.finalUrl, 'https://two.example.org/final');
  assert.equal(result.text, 'redirected');
});

test('重定向到私网字面地址时不发出第二次请求', async () => {
  const { readPublicPage, calls } = fixture({
    'https://public.example.org/start': response(302, { location: 'http://10.0.0.8/secret' }, []),
  });
  await assert.rejects(readPublicPage('https://public.example.org/start'), (error) => error.code === 'forbidden_target');
  assert.equal(calls.length, 1);
});

test('响应体超过预算会停止读取并销毁连接', async () => {
  let destroyed = false;
  const { readPublicPage } = fixture({
    'https://public.example.org/large': response(200, { 'content-type': 'text/plain' }, ['1234', '5678'], () => { destroyed = true; }),
  });
  await assert.rejects(readPublicPage('https://public.example.org/large', { maxBytes: 6 }), (error) => error.code === 'too_large');
  assert.equal(destroyed, true);
});

test('调用方 abort 会中止忽略信号的挂起传输', async () => {
  const controller = new AbortController();
  const tools = __test.makeTools({
    resolver: async () => [{ address: PUBLIC_V4, family: 4 }],
    transport: async () => new Promise(() => {}),
  });
  const pending = tools.readPublicPage('https://public.example.org/hang', { signal: controller.signal, timeoutMs: 1_000 });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'aborted');
});

test('总超时会中止挂起传输', async () => {
  const tools = __test.makeTools({
    resolver: async () => [{ address: PUBLIC_V4, family: 4 }],
    transport: async () => new Promise(() => {}),
  });
  await assert.rejects(tools.readPublicPage('https://public.example.org/hang', { timeoutMs: 10 }), (error) => error.code === 'timeout');
});

test('DuckDuckGo Instant Answer 适配为带 locator/hash 的结构化来源', async () => {
  const payload = JSON.stringify({
    Heading: 'Ada Lovelace', AbstractText: 'Ada Lovelace was an English mathematician.', AbstractURL: 'https://en.wikipedia.org/wiki/Ada_Lovelace',
    RelatedTopics: [{ Text: 'Analytical Engine - mechanical computer', FirstURL: 'https://example.org/engine' }],
  });
  const { searchPublicWeb } = fixture({
    'https://html.duckduckgo.com/html/?q=Ada+Lovelace': response(200, { 'content-type': 'text/html' }, ['<html><body>No results.</body></html>']),
    'https://api.duckduckgo.com/?q=Ada+Lovelace&format=json&no_html=1&no_redirect=1&skip_disambig=1': response(200, { 'content-type': 'application/x-javascript' }, [payload]),
  });
  const result = await searchPublicWeb('Ada Lovelace', { maxResults: 2 });
  assert.equal(result.status, 'ok');
  assert.equal(result.provider, 'duckduckgo-instant-answer');
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.sources.map((source) => source.locator), ['Abstract', 'RelatedTopics[0]']);
  assert.ok(result.sources.every((source) => source.evidenceSha256 === result.responseSha256 && source.evidenceUrl === result.responseUrl && source.fetchedAt === NOW));
  assert.match(result.limitations[0], /目标网页正文尚未读取/);
});

test('普通 HTML 搜索返回发现网址且不冒充已读取目标正文', async () => {
  const html = `<html><body>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fdocs%2Flatest%2Fapi%2F">Node.js documentation</a>
    <a class="result__snippet">Official Node.js API documentation.</a></div>
    <div class="result"><a class="result__a" href="https://docs.deno.com/runtime/">Deno documentation</a>
    <div class="result__snippet">Official Deno runtime documentation.</div></div>
  </body></html>`;
  const { searchPublicWeb, calls } = fixture({
    'https://html.duckduckgo.com/html/?q=Node.js+and+Deno+official+documentation': response(200, { 'content-type': 'text/html; charset=UTF-8' }, [html]),
  });
  const result = await searchPublicWeb('Node.js and Deno official documentation');
  assert.equal(result.mode, 'web_results');
  assert.equal(result.provider, 'duckduckgo-html');
  assert.equal(calls.length, 1);
  assert.deepEqual(result.sources.map(({ status, url }) => ({ status, url })), [
    { status: 'discovered', url: 'https://nodejs.org/docs/latest/api/' },
    { status: 'discovered', url: 'https://docs.deno.com/runtime/' },
  ]);
  assert.ok(result.sources.every((source) => source.evidenceUrl === result.responseUrl && source.evidenceSha256 === result.responseSha256));
  assert.match(result.limitations[0], /引用前应再调用 readPublicPage/);
});

test('HTML 搜索遇访问验证时只进入受控托管搜索 fallback', async () => {
  const fallback = {
    status: 'ok', mode: 'web_results', query: 'challenge', provider: 'codex-hosted-web-search',
    sources: [{ status: 'discovered', title: 'Source', url: 'https://example.org/', text: '' }],
  };
  const codexCalls = [];
  const { searchPublicWeb, calls } = fixture({
    'https://html.duckduckgo.com/html/?q=challenge': response(200, { 'content-type': 'text/html' }, ['<form class="challenge-form">captcha</form>']),
  }, undefined, { codexSearchRunner: async (...args) => { codexCalls.push(args); return fallback; } });
  const result = await searchPublicWeb('challenge', { maxResults: 8 });
  assert.equal(result, fallback);
  assert.equal(calls.length, 1);
  assert.equal(codexCalls.length, 1);
  assert.equal(codexCalls[0][0], 'challenge');
  assert.equal(codexCalls[0][1].maxResults, 5);
});

test('托管搜索预算 hook 仅预留并成功结算一次', async () => {
  const calls = { start: 0, runner: 0, finish: [] };
  const hosted = {
    status: 'ok', provider: 'codex-hosted-web-search', usage: { input_tokens: 12, output_tokens: 3 }, sources: [],
  };
  const { searchPublicWeb } = fixture({
    'https://html.duckduckgo.com/html/?q=budgeted': response(200, { 'content-type': 'text/html' }, ['<form class="challenge-form">captcha</form>']),
  }, undefined, {
    codexSearchRunner: async () => { calls.runner += 1; return hosted; },
  });
  const result = await searchPublicWeb('budgeted', {
    async onHostedSearchStart() {
      calls.start += 1;
      return { async onFinish(outcome) { calls.finish.push(outcome); } };
    },
  });
  assert.equal(result, hosted);
  assert.equal(calls.start, 1);
  assert.equal(calls.runner, 1);
  assert.deepEqual(calls.finish, [{ status: 'succeeded', usage: hosted.usage, error: null }]);
});

test('托管搜索预算预留拒绝或结算器无效时绝不启动子进程', async () => {
  for (const start of [async () => { throw new Error('budget exhausted'); }, async () => ({})]) {
    let runnerCalls = 0;
    const { searchPublicWeb } = fixture({
      'https://html.duckduckgo.com/html/?q=blocked': response(200, { 'content-type': 'text/html' }, ['<form class="challenge-form">captcha</form>']),
    }, undefined, { codexSearchRunner: async () => { runnerCalls += 1; return {}; } });
    await assert.rejects(searchPublicWeb('blocked', { onHostedSearchStart: start }));
    assert.equal(runnerCalls, 0);
  }
});

test('托管搜索失败、超时和用户取消均恰好结算一次', async () => {
  for (const code of ['search_unavailable', 'timeout', 'aborted']) {
    const finishes = [];
    const { searchPublicWeb } = fixture({
      [`https://html.duckduckgo.com/html/?q=${code}`]: response(200, { 'content-type': 'text/html' }, ['<form class="challenge-form">captcha</form>']),
    }, undefined, { codexSearchRunner: async () => { throw new PublicWebError(code, `failure ${code}`); } });
    await assert.rejects(searchPublicWeb(code, {
      onHostedSearchStart: async () => ({ onFinish: async (outcome) => { finishes.push(outcome); } }),
    }), (error) => error.code === code);
    assert.deepEqual(finishes, [{
      status: code === 'aborted' ? 'aborted' : 'failed',
      usage: null,
      error: { code, message: `failure ${code}` },
    }]);
  }
});

test('托管搜索结算失败不会被静默吞掉', async () => {
  const { searchPublicWeb } = fixture({
    'https://html.duckduckgo.com/html/?q=settlement': response(200, { 'content-type': 'text/html' }, ['<form class="challenge-form">captcha</form>']),
  }, undefined, { codexSearchRunner: async () => { throw new PublicWebError('timeout', 'search timed out'); } });
  await assert.rejects(searchPublicWeb('settlement', {
    onHostedSearchStart: async () => ({ onFinish: async () => { throw new Error('ledger unavailable'); } }),
  }), (error) => error.code === 'search_accounting_failed' && error.searchError?.code === 'timeout');
});

test('托管搜索 JSONL 只产出无正文的 HTTPS discovery 候选和用量证据', () => {
  const query = 'Node.js official documentation';
  const result = __test.parseCodexSearchEvents(jsonl(codexEvents(query)), { query, maxResults: 5, fetchedAt: NOW });
  assert.equal(result.provider, 'codex-hosted-web-search');
  assert.equal(result.engine, 'codex-cli:gpt-5.6-sol:web_search-live');
  assert.deepEqual(result.usage, { input_tokens: 100, output_tokens: 20 });
  assert.match(result.responseSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.sources.map(({ status, url, text }) => ({ status, url, text })), [
    { status: 'discovered', url: 'https://nodejs.org/api/', text: '' },
  ]);
  assert.match(result.sources[0].evidenceLocator, /^codex-jsonl:search-1:/);
  assert.match(result.limitations.join(' '), /不能直接作为引用.*readPublicPage/);
});

test('托管搜索拒绝未知工具、额外查询和缺失网页搜索事件', () => {
  const query = 'public docs';
  const cases = [
    {
      code: 'search_unexpected_tool',
      events: codexEvents(query).toSpliced(3, 0, { type: 'item.completed', item: { type: 'command_execution', command: 'whoami' } }),
    },
    {
      code: 'search_extra_call',
      events: codexEvents(query).toSpliced(4, 0, { type: 'item.completed', item: { id: 'search-2', type: 'web_search', query, action: { type: 'search', query } } }),
    },
    {
      code: 'search_missing_call',
      events: codexEvents(query).filter((event) => event.item?.type !== 'web_search'),
    },
  ];
  for (const { code, events } of cases) {
    assert.throws(() => __test.parseCodexSearchEvents(jsonl(events), { query, maxResults: 5, fetchedAt: NOW }), (error) => error.code === code);
  }
});

test('托管搜索拒绝恶意、非 HTTPS、重复或超量候选 URL', () => {
  const query = 'public docs';
  for (const results of [
    [{ title: 'Local', url: 'https://127.0.0.1/secret' }],
    [{ title: 'Plain', url: 'http://example.org/' }],
    [{ title: 'Credentials', url: 'https://user:pass@example.org/' }],
    [{ title: 'One', url: 'https://example.org/' }, { title: 'Again', url: 'https://example.org/' }],
    Array.from({ length: 6 }, (_, index) => ({ title: `R${index}`, url: `https://example.org/${index}` })),
  ]) {
    assert.throws(() => __test.parseCodexSearchEvents(jsonl(codexEvents(query, results)), { query, maxResults: 5, fetchedAt: NOW }), (error) => ['search_invalid_result', 'search_invalid_response'].includes(error.code));
  }
});

test('受控搜索子进程固定禁用能力，调用方取消会终止整个进程组', async () => {
  const child = inertChild();
  const spawned = [];
  const terminated = [];
  const runner = __test.createCodexSearchRunner({
    codexPath: '/fixed/codex', cwd: '/private/tmp',
    spawnProcess(command, args, options) { spawned.push({ command, args, options }); return child; },
    terminate(process) { terminated.push(process.pid); },
  });
  const controller = new AbortController();
  const pending = runner('public docs', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error.code === 'aborted');
  assert.deepEqual(terminated, [child.pid]);
  assert.equal(spawned[0].command, '/fixed/codex');
  assert.equal(spawned[0].options.shell, false);
  assert.equal(spawned[0].options.detached, process.platform !== 'win32');
  assert.deepEqual(spawned[0].args.slice(0, 2), ['exec', '-']);
  assert.ok(spawned[0].args.includes('code_mode_host'));
  for (const feature of __test.CODEX_SEARCH_DISABLED_FEATURES) {
    const index = spawned[0].args.indexOf(feature);
    assert.equal(spawned[0].args[index - 1], '--disable', feature);
  }
});

test('受控搜索子进程超时会终止整个进程组', async () => {
  const child = inertChild();
  const terminated = [];
  const runner = __test.createCodexSearchRunner({
    spawnProcess: () => child,
    terminate(process) { terminated.push(process.pid); },
  });
  await assert.rejects(runner('public docs', { timeoutMs: 10 }), (error) => error.code === 'timeout');
  assert.deepEqual(terminated, [child.pid]);
});

test('Instant Answer 零结果与无效响应被如实区分', async () => {
  const zero = fixture({
    'https://html.duckduckgo.com/html/?q=unlikely': response(200, { 'content-type': 'text/html' }, ['<p>No results.</p>']),
    'https://api.duckduckgo.com/?q=unlikely&format=json&no_html=1&no_redirect=1&skip_disambig=1': response(200, { 'content-type': 'application/json' }, ['{"RelatedTopics":[]}']),
  });
  const result = await zero.searchPublicWeb('unlikely');
  assert.equal(result.status, 'no_results');
  assert.deepEqual(result.sources, []);

  const invalid = fixture({
    'https://html.duckduckgo.com/html/?q=broken': response(200, { 'content-type': 'text/html' }, ['<p>No results.</p>']),
    'https://api.duckduckgo.com/?q=broken&format=json&no_html=1&no_redirect=1&skip_disambig=1': response(200, { 'content-type': 'application/json' }, ['not-json']),
  });
  await assert.rejects(invalid.searchPublicWeb('broken'), (error) => error.code === 'invalid_response');
});

test('搜索 API 对直接公开 URL 使用完整页面读取路径', async () => {
  const { searchPublicWeb } = fixture({
    'https://public.example.org/article': response(200, { 'content-type': 'text/plain' }, ['primary source']),
  });
  const result = await searchPublicWeb('https://public.example.org/article');
  assert.equal(result.mode, 'direct_url');
  assert.equal(result.sources[0].text, 'primary source');
  assert.match(result.sources[0].sha256, /^[a-f0-9]{64}$/);
});
