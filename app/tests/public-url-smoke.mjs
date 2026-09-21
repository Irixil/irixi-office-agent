import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { start } from '../server.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-public-url-'));
const running = await start({ port: 0, root });

try {
  const createdResponse = await fetch(`${running.url}/api/tasks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: '验证明确公开网址读取' }),
  });
  const created = await createdResponse.json();
  const materialResponse = await fetch(`${running.url}/api/tasks/${created.task.id}/materials/url`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Example Domain', url: 'https://example.com/' }),
  });
  const material = await materialResponse.json();
  assert.equal(materialResponse.status, 201, material?.error?.message);
  assert.equal(material.material.status, 'ready');
  assert.match(material.material.text, /Example Domain/i);
  process.stdout.write(`${JSON.stringify({ ok: true, source: material.material.source, bytes: material.material.bytes, containsExpectedText: true }, null, 2)}\n`);
} finally {
  await new Promise((resolve) => running.server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
