import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dispatchTarget } from '../project-intake-20261004/projects/article-learning-12/tools/codex-project-dispatch.mjs';

const sizedPrompt = (tag, bytes) => `${tag}\n${'a'.repeat(bytes - Buffer.byteLength(tag) - 1)}`;

test('article dispatcher applies the 144 KiB UTF-8 limit to both native development roles', () => {
  for (const tag of ['ARTICLE_LEARNING_DEVELOPER_12', 'ARTICLE_LEARNING_REVIEWER_12']) {
    assert.equal(Buffer.byteLength(sizedPrompt(tag, 144 * 1024)), 144 * 1024);
    assert.equal(dispatchTarget(sizedPrompt(tag, 144 * 1024)).wrapper, 'codex-development-budget.mjs');
    assert.throws(() => dispatchTarget(sizedPrompt(tag, 144 * 1024 + 1)), /144 KiB/);
  }
  const unicode = `ARTICLE_LEARNING_REVIEWER_12\n${'界'.repeat(43_680)}`;
  assert.ok(Buffer.byteLength(unicode) > 64 * 1024 && Buffer.byteLength(unicode) <= 144 * 1024);
  assert.equal(dispatchTarget(unicode).tag, 'ARTICLE_LEARNING_REVIEWER_12');
});

test('article dispatcher keeps inference at 64 KiB and rejects ambiguous roles', () => {
  assert.equal(dispatchTarget(sizedPrompt('ARTICLE_LEARNING_INFERENCE_12', 64 * 1024)).wrapper, 'codex-learning-budget.mjs');
  assert.throws(() => dispatchTarget(sizedPrompt('ARTICLE_LEARNING_INFERENCE_12', 64 * 1024 + 1)), /inference prompt/);
  assert.throws(() => dispatchTarget('ARTICLE_LEARNING_DEVELOPER_12\nARTICLE_LEARNING_REVIEWER_12'), /ambiguous/);
  assert.throws(() => dispatchTarget('unregistered'), /unregistered/);
});

test('development wrapper enforces the shared prompt limit before reserving a ledger call', () => {
  const source = fs.readFileSync(path.resolve(import.meta.dirname, '../project-intake-20261004/projects/article-learning-12/tools/codex-development-budget.mjs'), 'utf8');
  const parse = source.indexOf('const { prompt, model } = parseInvocation(requestedArgs);');
  const reserve = source.indexOf('await reserveModelCall(');
  assert.ok(parse >= 0 && reserve > parse);
  assert.match(source, /function parseInvocation[\s\S]*assertArticleNativePrompt\(prompt\)/);
});
