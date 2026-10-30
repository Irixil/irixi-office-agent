import { mkdir, writeFile, chmod, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { userInfo } from 'node:os';
import path from 'node:path';

const defaultDirectory = path.join(userInfo().homedir, 'Library/Application Support/IRiXi/Credentials');

function credentialPath(provider, directory = defaultDirectory) {
  if (!['openai', 'deepseek'].includes(provider)) throw new Error('未知模型连接。');
  return path.resolve(directory, `${provider}-api-key.txt`);
}

export async function prepareProviderCredentialFile(provider, { directory } = {}) {
  const file = credentialPath(provider, directory);
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(file), 0o700);
    await writeFile(file, '', { flag: 'a', mode: 0o600 });
    await chmod(file, 0o600);
  } catch {
    throw new Error('无法准备 API Key 文本文件。请检查本机文件访问权限。');
  }
  return file;
}

async function credential(provider, includeKey, directory) {
  const file = credentialPath(provider, directory);
  let key = '';
  try {
    key = (await readFile(file, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取 API Key 文本文件。请检查文件是否可读。');
  }
  if (!key) {
    if (includeKey) throw new Error('尚未配置本产品 API Key。请在密钥文本文件中填写并保存。');
    return { configured: false, revision: null };
  }
  if (/\s/u.test(key)) throw new Error('API Key 文件格式无效。请只保留一行 Key，不要添加说明或空格。');
  const revision = createHash('sha256').update(key).digest('hex');
  return includeKey ? { key, revision } : { configured: true, revision };
}

export function readProviderCredential(provider, { directory } = {}) {
  return credential(provider, true, directory);
}

export function providerCredentialStatus(provider, { directory } = {}) {
  return credential(provider, false, directory);
}
