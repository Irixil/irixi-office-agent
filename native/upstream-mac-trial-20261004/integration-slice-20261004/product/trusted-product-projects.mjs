import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  MAX_NOOBI_REGISTERED_PNG_BYTES, NOOBI_GAME_BASELINE_PATHS, NOOBI_GAME_PROJECT_ID,
  NOOBI_GAME_WRITE_PATHS, inspectPngHeader, isNoobiReadonlyPngPath, isSafeRegisteredProjectPath,
} from './noobi-game-contract.mjs';

const exec = promisify(execFile);
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const SAFE_CREATION_KEY = /^[A-Za-z0-9_-]{16,128}$/;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_AUTHORITY_URL = 'http://127.0.0.1:3869/';

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function git(root, args) {
  return (await exec('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}

async function readSnapshotFile(root, relative, projectId, allowedWritePaths = []) {
  if (!isSafeRegisteredProjectPath(projectId, relative) || path.posix.normalize(relative) !== relative) throw new Error(`Trusted project path is invalid: ${relative}`);
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Trusted project path escaped its repository');
  const before = await fs.lstat(file);
  const registeredPng = isNoobiReadonlyPngPath(projectId, relative) && !allowedWritePaths.includes(relative);
  if (relative.toLowerCase().endsWith('.png') && !registeredPng) {
    throw new Error(`Trusted project PNG is not in the fixed read-only art set: ${relative}`);
  }
  const maxBytes = registeredPng ? MAX_NOOBI_REGISTERED_PNG_BYTES : MAX_FILE_BYTES;
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) {
    throw new Error(`Trusted project file is not a bounded regular file: ${relative}`);
  }
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
    throw new Error(`Trusted project file changed during snapshot: ${relative}`);
  }
  if (registeredPng) inspectPngHeader(bytes);
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes), mode: before.mode & 0o777 };
}

function validateDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trusted project definition must be an object');
  const keys = Object.keys(value).sort();
  const required = ['allowedWritePaths', 'baselinePaths', 'checks', 'label', 'native', 'projectId', 'root'].sort();
  const optional = ['creationKey', 'location', 'projectKind', 'staticPreviewEntries', 'staticPreviewFiles', 'templateId'];
  const expected = keys.filter((key) => required.includes(key) || optional.includes(key)).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected) || required.some((key) => !keys.includes(key)) || !SAFE_ID.test(value.projectId || '')
    || typeof value.label !== 'string' || !value.label.trim() || Buffer.byteLength(value.label) > 160
    || typeof value.root !== 'string' || !path.isAbsolute(value.root)
    || !Array.isArray(value.baselinePaths) || !value.baselinePaths.length
    || !Array.isArray(value.allowedWritePaths) || !value.allowedWritePaths.length
    || !Array.isArray(value.checks) || !value.checks.length) throw new Error('Trusted project definition is malformed');
  value.staticPreviewEntries ??= [];
  value.staticPreviewFiles ??= [];
  const toolRegistrationFields = ['creationKey', 'location', 'projectKind', 'templateId'];
  if (toolRegistrationFields.some((key) => Object.hasOwn(value, key))) {
    if (value.projectKind !== 'utility' || value.templateId !== 'tool-starter-v1'
      || !SAFE_CREATION_KEY.test(value.creationKey || '') || value.location !== `projects/${value.projectId}`) {
      throw new Error('Trusted tool project registration metadata is malformed');
    }
  }
  for (const list of [value.baselinePaths, value.allowedWritePaths]) {
    if (new Set(list).size !== list.length || list.some((entry) => typeof entry !== 'string' || !isSafeRegisteredProjectPath(value.projectId, entry))) {
      throw new Error('Trusted project paths must be unique normalized relative paths');
    }
  }
  if (value.projectId === NOOBI_GAME_PROJECT_ID) {
    const baseline = [...value.baselinePaths].sort();
    const writable = [...value.allowedWritePaths].sort();
    if (JSON.stringify(baseline) !== JSON.stringify(NOOBI_GAME_BASELINE_PATHS)
      || JSON.stringify(writable) !== JSON.stringify(NOOBI_GAME_WRITE_PATHS)) {
      throw new Error('Registered Noobi game baseline and writable paths must match the fixed asset-input contract');
    }
  }
  if (value.allowedWritePaths.some((entry) => !value.baselinePaths.includes(entry))) throw new Error('Every writable file must be part of the registered source snapshot');
  if (value.allowedWritePaths.some((entry) => isNoobiReadonlyPngPath(value.projectId, entry))) {
    throw new Error('Registered Noobi artwork is read-only and cannot be editable');
  }
  for (const [name, entries] of [['static preview files', value.staticPreviewFiles], ['static preview entries', value.staticPreviewEntries]]) {
    if (!Array.isArray(entries) || new Set(entries).size !== entries.length
      || entries.some((entry) => typeof entry !== 'string' || !isSafeRegisteredProjectPath(value.projectId, entry) || !value.baselinePaths.includes(entry))) {
      throw new Error(`Trusted project ${name} must be unique registered source paths`);
    }
  }
  if (value.staticPreviewEntries.some((entry) => !/\.html?$/i.test(entry) || !value.staticPreviewFiles.includes(entry))) {
    throw new Error('Trusted project preview entries must be registered HTML files in the preview file allowlist');
  }
  if (value.checks.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !SAFE_ID.test(entry.id || '')) return true;
    if (entry.id === 'article-learning-core-v1') {
      const checkKeys = ['checkerPath', 'checkerSha256', 'id', 'materialFile', 'materialSha256'].sort();
      return JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(checkKeys)
        || !SAFE_PATH.test(entry.checkerPath || '') || !value.baselinePaths.includes(entry.checkerPath)
        || !/^[a-f0-9]{64}$/.test(entry.checkerSha256 || '')
        || typeof entry.materialFile !== 'string' || !path.isAbsolute(entry.materialFile)
        || !/^[a-f0-9]{64}$/.test(entry.materialSha256 || '');
    }
    return JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(['id'].sort());
  })) {
    throw new Error('Trusted project checks are malformed');
  }
  const nativeKeys = Object.keys(value.native || {}).sort();
  if (JSON.stringify(nativeKeys) !== JSON.stringify(['allowedRoles', 'backend', 'maxAgents', 'maxDurationMs', 'maxModelCalls', 'model'].sort())
    || value.native.backend !== 'codex' || typeof value.native.model !== 'string'
    || !Array.isArray(value.native.allowedRoles) || !value.native.allowedRoles.length
    || !Number.isInteger(value.native.maxAgents) || value.native.maxAgents < 1 || value.native.maxAgents > 8
    || !Number.isInteger(value.native.maxModelCalls) || value.native.maxModelCalls < 1 || value.native.maxModelCalls > 24
    || !Number.isInteger(value.native.maxDurationMs) || value.native.maxDurationMs < 300_000 || value.native.maxDurationMs > 3_600_000) {
    throw new Error('Trusted project native limits are malformed');
  }
  if (value.native.allowedRoles.length > value.native.maxAgents || new Set(value.native.allowedRoles.map((entry) => String(entry).trim().toLowerCase())).size !== value.native.allowedRoles.length) {
    throw new Error('Trusted project native roles exceed maxAgents or are duplicated');
  }
}

function checkedAuthorityUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Trusted Authority URL is invalid'); }
  const port = Number(url.port);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !Number.isInteger(port) || port < 1024 || port > 65535
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Trusted Authority URL must be a plain HTTP 127.0.0.1 origin on a non-privileged port');
  }
  return `http://127.0.0.1:${port}/`;
}

export async function createTrustedProductProjects({ file, authorityUrl = DEFAULT_AUTHORITY_URL, projectsRoot = null }) {
  if (!file || !path.isAbsolute(file)) throw new Error('A trusted product project catalogue file is required');
  const runtimeAuthorityUrl = checkedAuthorityUrl(authorityUrl);
  const realFile = await fs.realpath(file);
  if (realFile !== file) throw new Error('Trusted project catalogue path must be canonical');
  const readDocument = async () => {
    const stat = await fs.lstat(realFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('Trusted project catalogue file is invalid');
    const value = JSON.parse(await fs.readFile(realFile, 'utf8'));
    if (value?.schemaVersion !== 1 || !Array.isArray(value.projects) || !value.projects.length
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(['projects', 'schemaVersion'].sort())) {
      throw new Error('Trusted project catalogue is malformed');
    }
    value.projects.forEach(validateDefinition);
    if (new Set(value.projects.map((entry) => entry.projectId)).size !== value.projects.length) throw new Error('Trusted project IDs must be unique');
    return value;
  };
  let document = await readDocument();
  let canonicalProjectsRoot = null;
  if (projectsRoot !== null) {
    if (typeof projectsRoot !== 'string' || !path.isAbsolute(projectsRoot)) throw new Error('Tool project root must be absolute');
    canonicalProjectsRoot = await fs.realpath(projectsRoot);
    const stat = await fs.lstat(canonicalProjectsRoot);
    if (canonicalProjectsRoot !== projectsRoot || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Tool project root must be a canonical directory');
  }
  let registrationQueue = Promise.resolve();

  async function resolveOne(definition) {
    const root = await fs.realpath(definition.root);
    if (root !== definition.root || await git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error(`Trusted project root is not canonical Git: ${definition.projectId}`);
    const sourceHead = await git(root, ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('Trusted project HEAD is invalid');
    const sourceManifest = [];
    let totalBytes = 0;
    for (const relative of definition.baselinePaths) {
      const entry = await readSnapshotFile(root, relative, definition.projectId, definition.allowedWritePaths);
      totalBytes += entry.bytes;
      if (totalBytes > MAX_SNAPSHOT_BYTES) throw new Error('Trusted project source snapshot is too large');
      sourceManifest.push(entry);
    }
    sourceManifest.sort((left, right) => left.path.localeCompare(right.path));
    for (const check of definition.checks) if (check.id === 'article-learning-core-v1') {
      const checker = sourceManifest.find((entry) => entry.path === check.checkerPath);
      const material = await fs.realpath(check.materialFile);
      const materialStat = await fs.lstat(material);
      const materialBytes = await fs.readFile(material);
      if (material !== check.materialFile || !materialStat.isFile() || materialStat.isSymbolicLink()
        || materialStat.nlink !== 1 || materialStat.size > MAX_FILE_BYTES || materialBytes.length !== materialStat.size
        || !checker || checker.sha256 !== check.checkerSha256 || sha256(materialBytes) !== check.materialSha256) {
        throw new Error('Article-learning fixed check or synthetic material changed from its registered hashes');
      }
    }
    const sourceSnapshotSha256 = sha256(canonical({ sourceHead, sourceManifest }));
    const scopeFingerprint = sha256(canonical({ schemaVersion: 1, projectId: definition.projectId, sourceSnapshotSha256,
      allowedWritePaths: [...definition.allowedWritePaths].sort(), checks: definition.checks, native: definition.native }));
    return { ...structuredClone(definition), root, sourceHead, sourceManifest, sourceSnapshotSha256, scopeFingerprint };
  }

  async function current(projectId) {
    document = await readDocument();
    const definition = document.projects.find((entry) => entry.projectId === projectId);
    if (!definition) throw Object.assign(new Error('Registered product project is unknown'), { status: 404 });
    return resolveOne(definition);
  }
  async function listPublic() {
    document = await readDocument();
    return Promise.all(document.projects.map(async (entry) => {
      const value = await resolveOne(entry);
      return { projectId: value.projectId, label: value.label, scopeFingerprint: value.scopeFingerprint,
        allowedWritePaths: value.allowedWritePaths, checkIds: value.checks.map((check) => check.id),
        staticPreviewEntries: value.staticPreviewEntries, staticPreviewFiles: value.staticPreviewFiles, current: true,
        ...(value.projectKind ? { projectKind: value.projectKind, location: value.location } : {}) };
    }));
  }

  async function registerToolProject(input) {
    if (!canonicalProjectsRoot) throw Object.assign(new Error('Tool project creation is unavailable.'), { status: 503, code: 'PROJECT_CREATION_UNAVAILABLE' });
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || JSON.stringify(Object.keys(input).sort()) !== JSON.stringify(['name', 'requestId'])
      || typeof input.name !== 'string' || input.name !== input.name.trim() || !input.name || input.name.length > 80
      || Buffer.byteLength(input.name, 'utf8') > 160
      || /[\u0000-\u001f\u007f]/.test(input.name) || !SAFE_CREATION_KEY.test(input.requestId || '')) {
      throw Object.assign(new Error('项目名称或创建请求编号无效。'), { status: 400, code: 'PROJECT_INPUT_INVALID' });
    }
    const operation = registrationQueue.then(async () => {
      document = await readDocument();
      const registered = document.projects.find((entry) => entry.creationKey === input.requestId);
      if (registered) {
        if (registered.label !== input.name || registered.projectKind !== 'utility') {
          throw Object.assign(new Error('这条创建请求已绑定其他项目名称。'), { status: 409, code: 'PROJECT_REQUEST_CONFLICT' });
        }
        await fs.unlink(path.join(canonicalProjectsRoot, `.irixi-create-${sha256(input.requestId).slice(0, 16)}.json`)).catch(() => {});
        return { project: (await listPublic()).find((entry) => entry.projectId === registered.projectId), created: false };
      }
      const slug = input.name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'workspace';
      const suffix = sha256(input.requestId).slice(0, 12);
      const projectId = `tool-${slug}-${suffix}`;
      if (document.projects.some((entry) => entry.projectId === projectId)) {
        throw Object.assign(new Error('项目编号冲突；原登记未修改。请重新提交保存的创建请求。'), { status: 409, code: 'PROJECT_ID_CONFLICT' });
      }
      const projectDirectory = path.join(canonicalProjectsRoot, projectId);
      const registrationFile = 'IRIXI_PROJECT.json';
      const pendingFile = path.join(canonicalProjectsRoot, `.irixi-create-${sha256(input.requestId).slice(0, 16)}.json`);
      const pendingContents = `${JSON.stringify({ schemaVersion: 1, projectId, requestId: input.requestId, name: input.name, templateId: 'tool-starter-v1' })}\n`;
      let resumedReservation = false;
      try {
        if (await fs.readFile(pendingFile, 'utf8') !== pendingContents) {
          throw Object.assign(new Error('该创建请求已被其他工程占用；没有覆盖现有内容。'), { status: 409, code: 'PROJECT_REQUEST_CONFLICT' });
        }
        resumedReservation = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        let targetExists = false;
        try { await fs.lstat(projectDirectory); targetExists = true; }
        catch (statError) { if (statError?.code !== 'ENOENT') throw statError; }
        if (targetExists) throw Object.assign(new Error('目标目录已存在；没有覆盖现有工程。'), { status: 409, code: 'PROJECT_DIRECTORY_CONFLICT' });
        try { await fs.writeFile(pendingFile, pendingContents, { flag: 'wx', mode: 0o600 }); }
        catch (reserveError) {
          if (reserveError?.code !== 'EEXIST' || await fs.readFile(pendingFile, 'utf8') !== pendingContents) {
            throw Object.assign(new Error('该创建请求已被其他工程占用；没有覆盖现有内容。'), { status: 409, code: 'PROJECT_REQUEST_CONFLICT' });
          }
          resumedReservation = true;
        }
      }
      const files = {
        [registrationFile]: `${JSON.stringify({ schemaVersion: 1, projectId, creationKey: input.requestId, projectKind: 'utility', templateId: 'tool-starter-v1' }, null, 2)}\n`,
        'README.md': '# 新工具工程\n\n这是一个通用空白工程。具体需求以关联的 Irixi 任务为准。\n',
        'PRODUCT.md': '# 产品目标\n\n本模板不预设业务功能、答案或数据。由关联任务的原生 Lead 根据用户目标规划，再由 Developer 实现并经独立 Reviewer 审阅。\n',
        'package.json': JSON.stringify({ name: projectId, version: '0.1.0', private: true, type: 'module', scripts: { check: 'node --check app.js && node --check core.js' } }, null, 2) + '\n',
        'index.html': '<!doctype html>\n<html lang="zh-CN">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>新工具工程</title>\n  <link rel="stylesheet" href="styles.css">\n</head>\n<body>\n  <main id="app"><h1>新工具工程</h1><p>等待当前任务明确具体功能。</p></main>\n  <script type="module" src="app.js"></script>\n</body>\n</html>\n',
        'styles.css': ':root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; }\nbody { margin: 0; padding: 2rem; background: #f5f1e8; color: #25231f; }\nmain { max-width: 48rem; margin: 10vh auto; padding: 2rem; background: white; border-radius: 1rem; }\n',
        'app.js': '// 空白入口；具体交互由关联任务规划后实现。\n',
        'core.js': '// 空白逻辑模块；本模板不预设业务规则。\n',
      };
      let createdDirectory = false;
      try { await fs.mkdir(projectDirectory, { mode: 0o755 }); createdDirectory = true; }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const stat = await fs.lstat(projectDirectory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(projectDirectory) !== projectDirectory) {
          throw Object.assign(new Error('目标目录已存在且不是本请求创建的安全工程。'), { status: 409, code: 'PROJECT_DIRECTORY_CONFLICT' });
        }
        let entries = await fs.readdir(projectDirectory);
        if (entries.length) {
          let marker;
          try { marker = JSON.parse(await fs.readFile(path.join(projectDirectory, registrationFile), 'utf8')); }
          catch { throw Object.assign(new Error('目标目录已存在但缺少匹配的创建记录；未覆盖任何内容。'), { status: 409, code: 'PROJECT_DIRECTORY_CONFLICT' }); }
          if (marker.projectId !== projectId || marker.creationKey !== input.requestId || marker.projectKind !== 'utility' || marker.templateId !== 'tool-starter-v1') {
            throw Object.assign(new Error('目标目录的创建记录与本次请求不匹配；未覆盖任何内容。'), { status: 409, code: 'PROJECT_DIRECTORY_CONFLICT' });
          }
        } else if (!resumedReservation) {
          await fs.unlink(pendingFile).catch(() => {});
          throw Object.assign(new Error('目标目录已存在；没有覆盖现有工程。'), { status: 409, code: 'PROJECT_DIRECTORY_CONFLICT' });
        }
      }
      try {
        for (const [relative, content] of Object.entries(files)) {
          const target = path.join(projectDirectory, relative);
          try {
            const stat = await fs.lstat(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.readFile(target, 'utf8') !== content) {
              throw Object.assign(new Error(`现有工程文件与空白模板不一致：${relative}；未覆盖。`), { status: 409, code: 'PROJECT_TEMPLATE_CONFLICT' });
            }
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            await fs.writeFile(target, content, { flag: 'wx', mode: relative === registrationFile ? 0o600 : 0o644 });
          }
        }
        const entries = await fs.readdir(projectDirectory);
        if (entries.some((entry) => !Object.hasOwn(files, entry) && entry !== '.git')) {
          throw Object.assign(new Error('工程目录含有未登记文件；未登记或删除任何内容。'), { status: 409, code: 'PROJECT_TEMPLATE_CONFLICT' });
        }
        try { await fs.mkdir(path.join(projectDirectory, '.git')); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
        const gitDirectory = await fs.lstat(path.join(projectDirectory, '.git'));
        if (!gitDirectory.isDirectory() || gitDirectory.isSymbolicLink()) throw new Error('New tool project Git metadata is invalid');
        const git = (args) => exec('git', ['-C', projectDirectory, ...args], { encoding: 'utf8', timeout: 10_000, maxBuffer: 256 * 1024,
          env: { ...process.env, GIT_AUTHOR_NAME: 'Irixi Project Bootstrap', GIT_AUTHOR_EMAIL: 'bootstrap@localhost.invalid',
            GIT_COMMITTER_NAME: 'Irixi Project Bootstrap', GIT_COMMITTER_EMAIL: 'bootstrap@localhost.invalid' } });
        const gitRoot = (await git(['rev-parse', '--show-toplevel']).catch(async () => {
          await git(['init', '--quiet']); return git(['rev-parse', '--show-toplevel']);
        })).stdout.trim();
        if (await fs.realpath(gitRoot) !== projectDirectory) throw new Error('New tool project Git root escaped its directory');
        await git(['add', '--', ...Object.keys(files)]);
        const status = (await git(['status', '--porcelain'])).stdout.trim();
        if (status) await git(['commit', '--quiet', '-m', 'Initialize generic tool project']);
        if (!/^[a-f0-9]{40}$/.test((await git(['rev-parse', 'HEAD'])).stdout.trim())) throw new Error('New tool project baseline commit is missing');
      } catch (error) {
        if (createdDirectory && error?.code === 'EEXIST') throw Object.assign(new Error('项目正在创建，请用同一请求重试。'), { status: 409, code: 'PROJECT_CREATION_INCOMPLETE' });
        throw error;
      }
      const definition = {
        projectId, label: input.name, root: projectDirectory, projectKind: 'utility', templateId: 'tool-starter-v1',
        creationKey: input.requestId, location: `projects/${projectId}`,
        baselinePaths: [...Object.keys(files)],
        allowedWritePaths: ['README.md', 'PRODUCT.md', 'package.json', 'index.html', 'styles.css', 'app.js', 'core.js'],
        checks: [{ id: 'node-syntax-v1' }], staticPreviewEntries: ['index.html'],
        staticPreviewFiles: ['index.html', 'styles.css', 'app.js', 'core.js'],
        native: { backend: 'codex', model: 'gpt-6-luna', allowedRoles: ['Lead', 'Senior Developer', 'Reviewer'],
          maxAgents: 3, maxModelCalls: 8, maxDurationMs: 1_200_000 },
      };
      validateDefinition(definition);
      const updated = await readDocument();
      if (updated.projects.some((entry) => entry.projectId === projectId || entry.creationKey === input.requestId)) {
        throw Object.assign(new Error('项目登记状态已被其他请求改变；请刷新列表后续办。'), { status: 409, code: 'PROJECT_REGISTRATION_CONFLICT' });
      }
      updated.projects.push(definition);
      const serialized = `${JSON.stringify(updated, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > 64 * 1024) {
        throw Object.assign(new Error('可信项目目录已达到安全容量上限；空白工程已保留，可稍后续办。'), { status: 413, code: 'PROJECT_CATALOG_FULL' });
      }
      const temporary = `${realFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, serialized, { flag: 'wx', mode: 0o600 });
      try { await fs.rename(temporary, realFile); }
      catch (error) { await fs.unlink(temporary).catch(() => {}); throw error; }
      document = await readDocument();
      const project = (await listPublic()).find((entry) => entry.projectId === projectId);
      if (!project) throw new Error('New tool project was not visible after registration');
      await fs.unlink(pendingFile).catch(() => {});
      return { project, created: true };
    });
    registrationQueue = operation.catch(() => {});
    return operation;
  }
  async function runtimePolicy(projectId) {
    const value = await current(projectId);
    return {
      schemaVersion: 1,
      projectId: value.projectId,
      authorityUrl: runtimeAuthorityUrl,
      workspace: {
        path: value.root,
        scopeFingerprint: value.scopeFingerprint,
        sourceSnapshotSha256: value.sourceSnapshotSha256,
        sourceHead: value.sourceHead,
        sourceManifest: value.sourceManifest,
        allowedWritePaths: value.allowedWritePaths,
        checks: value.checks.map((entry) => entry.id),
      },
      native: {
        backend: value.native.backend,
        model: value.native.model,
        allowedRoles: value.native.allowedRoles,
        maxModelCalls: value.native.maxModelCalls,
        maxDurationMs: value.native.maxDurationMs,
      },
      capabilities: {
        team: value.native.allowedRoles.length > 1
          || value.native.allowedRoles.some((role) => /lead|coordinator/i.test(role)),
        worktree: true,
        staticPreviewEntries: value.staticPreviewEntries,
        staticPreviewFiles: value.staticPreviewFiles,
        autoMerge: false,
        manualMerge: false,
        commandPreview: false,
      },
    };
  }
  return { listPublic, current, runtimePolicy, registerToolProject, file: realFile, catalogueSha256: sha256(await fs.readFile(realFile)) };
}

export const __test = { readSnapshotFile, validateDefinition };

