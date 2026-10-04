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

test('项目范围 schema 使用 Codex strict 可表达的封闭 JSON 字符串 transport', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(schemaRoot, 'project-scope.json'), 'utf8'));
  const visit = (node, trail = '$') => {
    if (!node || typeof node !== 'object') return;
    assert.notDeepEqual(node, {}, `${trail} 不得使用开放任意值 schema`);
    if (Object.hasOwn(node, 'const')) assert.ok(node.type, `${trail} 的 const 必须显式声明 type`);
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes('array')) assert.ok(node.items, `${trail} 的 array 必须声明 items`);
    for (const [key, value] of Object.entries(node)) {
      if (Array.isArray(value)) value.forEach((entry, index) => visit(entry, `${trail}.${key}[${index}]`));
      else if (value && typeof value === 'object') visit(value, `${trail}.${key}`);
    }
  };
  visit(schema);
  assert.equal(schema.properties.editablePaths.maxItems, 2);
  const caseProperties = schema.properties.checks.items.properties.cases.items.properties;
  assert.deepEqual(Object.keys(caseProperties).sort(), ['argsJson', 'expectedJson', 'id']);
  assert.equal(caseProperties.argsJson.type, 'string');
  assert.equal(caseProperties.expectedJson.type, 'string');
});

test('通用项目的 scope、work schema 和工作提示共用两文件上限', async () => {
  const scopeSchema = JSON.parse(await fs.readFile(path.join(schemaRoot, 'project-scope.json'), 'utf8'));
  const workSchema = JSON.parse(await fs.readFile(path.join(schemaRoot, 'work.json'), 'utf8'));
  const providersSource = await fs.readFile(path.resolve(schemaRoot, '..', 'providers.mjs'), 'utf8');
  const workspaceBatch = workSchema.properties.toolRequests.items.properties.args.anyOf.find(
    (entry) => entry.properties?.changes,
  );
  assert.equal(scopeSchema.properties.editablePaths.maxItems, 2);
  assert.equal(workspaceBatch.properties.changes.maxItems, 2);
  assert.match(providersSource, /changes 只包含确需修改的授权文件，最多 2 个/);
  assert.doesNotMatch(providersSource, /changes 只包含确需修改的授权文件，最多 3 个/);
});

test('项目规划 schema 只提供四个封闭可填 stage slot', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(schemaRoot, 'project-plan.json'), 'utf8'));
  assert.deepEqual(Object.keys(schema.properties).sort(), ['projectAlignment', 'stages', 'summary']);
  assert.deepEqual(Object.keys(schema.properties.stages.properties), ['tool', 'synthesis', 'review', 'delivery']);
  assert.equal(schema.properties.steps, undefined);
  for (const stage of Object.values(schema.properties.stages.properties)) {
    assert.equal(stage.additionalProperties, false);
    assert.equal(stage.properties.tools, undefined);
    assert.equal(stage.properties.path, undefined);
    assert.equal(stage.properties.role, undefined);
  }
});
