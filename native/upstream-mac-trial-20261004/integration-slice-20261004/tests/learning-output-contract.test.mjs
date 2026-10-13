import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertOutputSchemaCoversContract } from '../project-intake-20261004/projects/article-learning-12/tools/learning-output-contract.mjs';

const ROOT = path.resolve(import.meta.dirname, '../project-intake-20261004/projects/article-learning-12');
const prompt = (kind, required) => ['ARTICLE_LEARNING_INFERENCE_12', `IRIXI_INFERENCE_KIND: ${kind}`, JSON.stringify({ sessionId: 'fixture', payload: { responseContract: { required } } })].join('\n');

test('registered learning schemas cover the current explain and assess required fields', async () => {
  const explain = JSON.parse(await fs.readFile(path.join(ROOT, 'config/inference-output-schemas/explain.json')));
  const assess = JSON.parse(await fs.readFile(path.join(ROOT, 'config/inference-output-schemas/assess.json')));
  assert.equal(assertOutputSchemaCoversContract(prompt('explain', { concepts: 'array', coverage: 'array', plan: 'object' }), explain), true);
  assert.equal(assertOutputSchemaCoversContract(prompt('assess', { verdict: 'enum', correct: 'array', errors: 'array', omissions: 'array', evidence: 'array', remediation: 'object', retest: 'object', conceptResults: 'array', activityQualification: 'object' }), assess), true);
});

test('schema compatibility fails before reservation when a request adds an unsupported required field', async () => {
  const explain = JSON.parse(await fs.readFile(path.join(ROOT, 'config/inference-output-schemas/explain.json')));
  assert.throws(() => assertOutputSchemaCoversContract(prompt('explain', { concepts: 'array', coverage: 'array', plan: 'object', futureRequired: 'object' }), explain), /futureRequired/);
  assert.throws(() => assertOutputSchemaCoversContract('not-a-bound-request', explain), /parseable registered request/);
});
