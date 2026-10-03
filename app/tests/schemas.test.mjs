import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const schemaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

function checkStrictObjects(node, trail = '$') {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'object' || node.properties) {
    assert.equal(node.additionalProperties, false, `${trail} must set additionalProperties=false`);
    const properties = Object.keys(node.properties || {}).sort();
    const required = [...(node.required || [])].sort();
    assert.deepEqual(required, properties, `${trail} must require every declared property; optional values need explicit nullable types`);
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'properties') {
      for (const [name, property] of Object.entries(value)) checkStrictObjects(property, `${trail}.properties.${name}`);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => checkStrictObjects(entry, `${trail}.${key}[${index}]`));
    } else if (value && typeof value === 'object') checkStrictObjects(value, `${trail}.${key}`);
  }
}

test('全部模型输出 schema 递归满足 strict object 约束', async () => {
  const names = (await fs.readdir(schemaRoot)).filter((name) => name.endsWith('.json')).sort();
  assert.ok(names.length >= 6);
  for (const name of names) {
    const schema = JSON.parse(await fs.readFile(path.join(schemaRoot, name), 'utf8'));
    checkStrictObjects(schema, name);
  }
});

test('计划步骤始终包含显式 webScope，非网页步骤使用空数组', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(schemaRoot, 'plan.json'), 'utf8'));
  const step = schema.properties.steps.items;
  assert.ok(step.required.includes('webScope'));
  assert.deepEqual(step.properties.webScope.required.slice().sort(), ['queries', 'urls']);
});
