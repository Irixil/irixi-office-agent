import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, visibleMessageText } from '../public/conversation-format.js';

test('local file citations remain readable without becoming nonexistent web routes', () => {
  for (const target of ['/private/tmp/workspace/budget.mjs', '/Users/example/project/预算.mjs', '/tmp/file.txt', '/home/user/file.txt', 'file:///Users/example/file.txt', 'C:\\work\\file.txt']) {
    const markdown = `[budget.mjs](${target})`;
    const rendered = renderMarkdown(markdown);
    assert.ok(!rendered.includes('<a '), target);
    assert.ok(rendered.includes('budget.mjs'), target);
    assert.equal(visibleMessageText(markdown), 'budget.mjs');
  }
});

test('web URLs, product routes and message anchors still produce links', () => {
  for (const target of ['https://example.com/path?q=a&b=c', 'http://127.0.0.1:58313/?conversation=c&message=m', 'mailto:help@example.com', '/api/conversation/example/preview', '#message']) {
    assert.ok(renderMarkdown(`[open](${target})`).includes('<a '), target);
  }
});

test('file reference formatting cannot inject markup or executable links', () => {
  assert.ok(!renderMarkdown('[fake](/private/tmp/"><img-src=x>)').includes('<img'));
  assert.ok(!renderMarkdown('[bad](javascript:alert)').includes('href="javascript:'));
});
