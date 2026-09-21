import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { start } from '../server.mjs';

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function post(url, pathname, body, origin) {
  const response = await fetch(`${url}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  return { response, value };
}

async function waitForTask(url, id) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const task = (await (await fetch(`${url}/api/tasks/${id}`)).json()).task;
    if (task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('任务没有在测试时间内结束');
}

test('本地 API 完成目标到确认与导出的闭环，并在重启后恢复', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let running = await start({ port: 0, root });
  t.after(() => running.server.close());

  const created = await post(running.url, '/api/tasks', {
    title: '周报', goal: '形成可审阅的本周项目周报', type: 'document',
    successCriteria: ['包含进展与下一步'], boundaries: ['不编造数字'], provider: 'demo',
  });
  assert.equal(created.response.status, 201);
  const id = created.value.task.id;

  const material = await post(running.url, `/api/tasks/${id}/materials/text`, { name: '本周记录', text: '项目完成了需求核对，下一步准备用户试用。' });
  assert.equal(material.response.status, 201);
  const planned = await post(running.url, `/api/tasks/${id}/plan`, {});
  assert.ok(planned.value.task.workItems.length >= 4);
  const accepted = await post(running.url, `/api/tasks/${id}/run`, {});
  assert.equal(accepted.response.status, 202);

  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.artifacts.length, 1);
  assert.equal(finished.artifacts[0].provider, 'demo');
  assert.equal(finished.reviews[0].passed, true);

  const artifact = finished.artifacts[0];
  const confirmed = await post(running.url, `/api/tasks/${id}/artifacts/${artifact.id}/confirm`, {});
  assert.equal(confirmed.value.task.status, 'ready_to_export');
  const deniedExport = await fetch(`${running.url}/api/tasks/${id}/artifacts/${artifact.id}/export?format=md`);
  assert.equal(deniedExport.status, 400);
  const exported = await fetch(`${running.url}/api/tasks/${id}/artifacts/${artifact.id}/export?approval=${confirmed.value.approval.id}&format=md`);
  assert.equal(exported.status, 200);
  assert.match(await exported.text(), /形成可审阅的本周项目周报/);

  await new Promise((resolve) => running.server.close(resolve));
  running = await start({ port: 0, root });
  const restored = await (await fetch(`${running.url}/api/tasks/${id}`)).json();
  assert.equal(restored.task.status, 'ready_to_export');
  assert.equal(restored.task.artifacts[0].status, 'confirmed');
});

test('修改接口拒绝非本机网页来源，网址导入拒绝本机地址', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-policy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());

  const rejected = await post(running.url, '/api/tasks', { goal: '不应建立' }, 'https://hostile.example');
  assert.equal(rejected.response.status, 403);

  const created = await post(running.url, '/api/tasks', { goal: '测试网址策略' });
  const id = created.value.task.id;
  const local = await post(running.url, `/api/tasks/${id}/materials/url`, { url: 'http://127.0.0.1/private' });
  assert.equal(local.response.status, 422);
  assert.match(local.value.error.message, /不能读取/);
  assert.equal(local.value.task.materials[0].status, 'failed');
});

test('TXT、Markdown、DOCX 和可检索 PDF 均可读取，损坏 PDF 明确失败', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-files-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '核对多格式材料导入' });
  const id = created.value.task.id;

  for (const name of ['sample.txt', 'sample.md', 'irixi-sample.docx', 'irixi-sample.pdf']) {
    const content = await fs.readFile(path.join(fixtureRoot, name));
    const uploaded = await post(running.url, `/api/tasks/${id}/materials/file`, { name, base64: content.toString('base64') });
    assert.equal(uploaded.response.status, 201, `${name}: ${uploaded.value?.error?.message || ''}`);
    assert.equal(uploaded.value.material.status, 'ready');
    assert.match(uploaded.value.material.text, /Irixi|材料/);
  }

  const damaged = await post(running.url, `/api/tasks/${id}/materials/file`, { name: 'damaged.pdf', base64: Buffer.from('not a pdf').toString('base64') });
  assert.equal(damaged.response.status, 422);
  assert.equal(damaged.value.task.materials.at(-1).status, 'failed');
  assert.match(damaged.value.error.message, /无法可靠提取/);
});

test('取消会持久化，随后可安全重新运行且不会产生导出副作用', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-cancel-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const running = await start({ port: 0, root });
  t.after(() => running.server.close());
  const created = await post(running.url, '/api/tasks', { goal: '验证取消与继续', provider: 'demo' });
  const id = created.value.task.id;
  await post(running.url, `/api/tasks/${id}/plan`, {});
  const cancelled = await post(running.url, `/api/tasks/${id}/cancel`, {});
  assert.equal(cancelled.value.task.status, 'cancelled');
  assert.equal(cancelled.value.task.approvals.length, 0);

  const resumed = await post(running.url, `/api/tasks/${id}/run`, {});
  assert.equal(resumed.response.status, 202);
  const finished = await waitForTask(running.url, id);
  assert.equal(finished.status, 'waiting_user');
  assert.equal(finished.approvals.length, 0);
});
