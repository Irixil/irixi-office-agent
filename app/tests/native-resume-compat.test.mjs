import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { nativeActionPayload, normalizeNativeProductState } from '../public/native-product-state.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function nativeActionBound(');
const boundEnd = source.indexOf('\nfunction nativeSetupBound(', start);
const continueStart = source.indexOf('async function requestNativeContinue(', boundEnd);
const end = source.indexOf('\nasync function readNativeProduct(', continueStart);
assert.notEqual(start, -1);
assert.notEqual(boundEnd, -1);
assert.notEqual(continueStart, -1);
assert.notEqual(end, -1);
const actionsSource = `${source.slice(start, boundEnd)}\n${source.slice(continueStart, end)}`;

function makeProduct(actions, artifact = null) {
  return normalizeNativeProductState({
    taskId: 'task-legacy', goalVersionId: 'goal-legacy', current: true, authorityCurrent: true,
    status: 'in_progress', execution: { id: 'execution-legacy', phase: 'partial' }, artifact,
    product: { projectId: 'project-legacy', registrySha256: 'registry-legacy', workspaceScopeFingerprint: 'scope-legacy', bindingCurrent: true },
    native: { source: 'openoffice-native', bindingCurrent: true, registrySha256: 'registry-legacy', actions },
    links: { actions: '/api/product/tasks/task-legacy/actions' },
  });
}

async function invoke(product) {
  const calls = [];
  const context = {
    state: { nativeProduct: product },
    window: { confirm: () => true },
    nativeActionBound: (value) => Boolean(value?.current && value.links?.actions && value.execution?.id && value.product?.registrySha256),
    postNativeAction: async (action, payload) => calls.push({ action, payload: nativeActionPayload(product, action, payload) }),
    announce: () => {},
  };
  vm.createContext(context);
  const pending = vm.runInContext(`${actionsSource}\nrequestNativeContinue();`, context);
  await pending;
  return calls;
}

test('legacy OpenOffice canResume 在没有候选 revision ID 时仍发送原 continue 绑定', async () => {
  const product = makeProduct({ canResume: true });
  const calls = await invoke(product);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'continue');
  assert.deepEqual(calls[0].payload, {
    action: 'continue', expectedGoalVersionId: 'goal-legacy',
    expectedExecutionId: 'execution-legacy', expectedRegistrySha256: 'registry-legacy',
  });
});

test('Pilot canContinue 仍要求正式 revision 和同一候选绑定', async () => {
  const candidate = { id: 'artifact-pilot', version: 3, candidateSha256: 'a'.repeat(64) };
  const blocked = makeProduct({ canContinue: true }, candidate);
  await assert.rejects(invoke(blocked), /后台没有确认当前退回候选可以继续/u);

  const allowed = makeProduct({ canContinue: true, revisionId: 'revision-pilot' }, candidate);
  const calls = await invoke(allowed);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].payload, {
    action: 'continue', expectedGoalVersionId: 'goal-legacy', revisionId: 'revision-pilot',
    expectedExecutionId: 'execution-legacy', expectedRegistrySha256: 'registry-legacy',
    expectedScopeFingerprint: 'scope-legacy', expectedArtifactId: 'artifact-pilot',
    expectedArtifactVersion: 3, expectedCandidateSha256: 'a'.repeat(64),
  });
});
