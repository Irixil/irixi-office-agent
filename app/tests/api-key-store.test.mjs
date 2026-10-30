import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, chmod, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareProviderCredentialFile, readProviderCredential, providerCredentialStatus } from '../api-key-store.mjs';

test('real temporary credential files: create, read, replace, clear and reopen without truncation', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'irixi-file-key-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'Credentials');
  const options = { directory };
  assert.deepEqual(await providerCredentialStatus('openai', options), { configured: false, revision: null });
  await assert.rejects(readProviderCredential('openai', options), { message: '尚未配置本产品 API Key。请在密钥文本文件中填写并保存。' });

  const file = await prepareProviderCredentialFile('openai', options);
  assert.equal(file, path.join(directory, 'openai-api-key.txt'));
  assert.equal(await readFile(file, 'utf8'), '');
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await providerCredentialStatus('openai', options), { configured: false, revision: null });

  const syntheticKey = 'synthetic-file-key-only-A';
  await writeFile(file, `  ${syntheticKey}\n`);
  const first = await readProviderCredential('openai', options);
  assert.ok(first.key === syntheticKey);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  const status = await providerCredentialStatus('openai', options);
  assert.deepEqual(status, { configured: true, revision: first.revision });
  assert.ok(!JSON.stringify(status).includes(syntheticKey));

  await chmod(directory, 0o755);
  await chmod(file, 0o644);
  assert.equal(await prepareProviderCredentialFile('openai', options), file);
  assert.ok((await readFile(file, 'utf8')) === `  ${syntheticKey}\n`);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const reloaded = await import(`../api-key-store.mjs?reopen=${Date.now()}`);
  assert.equal((await reloaded.providerCredentialStatus('openai', options)).revision, first.revision);

  await writeFile(file, `${syntheticKey}\n`);
  assert.equal((await providerCredentialStatus('openai', options)).revision, first.revision);
  await writeFile(file, 'synthetic-file-key-only-B');
  const changed = await readProviderCredential('openai', options);
  assert.ok(changed.key === 'synthetic-file-key-only-B');
  assert.notEqual(changed.revision, first.revision);

  const deepseek = await prepareProviderCredentialFile('deepseek', options);
  assert.equal(deepseek, path.join(directory, 'deepseek-api-key.txt'));
  assert.deepEqual(await providerCredentialStatus('deepseek', options), { configured: false, revision: null });
  await writeFile(deepseek, 'synthetic-deepseek-only');
  assert.ok((await readProviderCredential('deepseek', options)).key === 'synthetic-deepseek-only');
  assert.equal((await providerCredentialStatus('openai', options)).revision, changed.revision);

  await writeFile(file, ' \r\n\t');
  assert.deepEqual(await providerCredentialStatus('openai', options), { configured: false, revision: null });
  await assert.rejects(readProviderCredential('openai', options), /尚未配置/);
});

test('unknown provider, invalid contents and file failures return fixed errors without credentials', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'irixi-file-key-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory };
  for (const operation of [prepareProviderCredentialFile, readProviderCredential, providerCredentialStatus]) {
    await assert.rejects(operation('../other', options), { message: '未知模型连接。' });
  }
  const file = await prepareProviderCredentialFile('openai', options);
  for (const invalid of ['synthetic-private-A\nsynthetic-private-B', 'synthetic-private with-space', 'synthetic-private\twith-tab']) {
    await writeFile(file, invalid);
    for (const operation of [readProviderCredential, providerCredentialStatus]) {
      await assert.rejects(operation('openai', options), error => {
        assert.equal(error.message, 'API Key 文件格式无效。请只保留一行 Key，不要添加说明或空格。');
        assert.ok(!error.stack.includes('synthetic-private') && !error.cause);
        return true;
      });
    }
  }
  await rm(file);
  await mkdir(file);
  for (const operation of [readProviderCredential, providerCredentialStatus]) {
    await assert.rejects(operation('openai', options), { message: '无法读取 API Key 文本文件。请检查文件是否可读。' });
  }
  await assert.rejects(prepareProviderCredentialFile('openai', options), { message: '无法准备 API Key 文本文件。请检查本机文件访问权限。' });
  const nonDirectory = path.join(directory, 'synthetic-private-path');
  await writeFile(nonDirectory, 'synthetic-only');
  await assert.rejects(prepareProviderCredentialFile('deepseek', { directory: nonDirectory }), error => {
    assert.equal(error.message, '无法准备 API Key 文本文件。请检查本机文件访问权限。');
    assert.ok(!error.stack.includes('synthetic-private-path') && !error.cause);
    return true;
  });
});
