import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const SAFE_ID = /^[a-z0-9][a-z0-9-]{2,79}$/;
const SAFE_PATH = /^(?!\.)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$/;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;

const canonical = (value) => Array.isArray(value)
  ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function git(root, args) {
  return (await exec('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 5_000, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}

async function readSnapshotFile(root, relative) {
  if (!SAFE_PATH.test(relative) || path.posix.normalize(relative) !== relative) throw new Error(`Trusted project path is invalid: ${relative}`);
  const file = path.resolve(root, relative);
  if (!file.startsWith(`${root}${path.sep}`)) throw new Error('Trusted project path escaped its repository');
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_FILE_BYTES) {
    throw new Error(`Trusted project file is not a bounded regular file: ${relative}`);
  }
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes.length !== after.size) {
    throw new Error(`Trusted project file changed during snapshot: ${relative}`);
  }
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes), mode: before.mode & 0o777 };
}

function validateDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Trusted project definition must be an object');
  const keys = Object.keys(value).sort();
  const required = ['allowedWritePaths', 'baselinePaths', 'checks', 'label', 'native', 'projectId', 'root'].sort();
  const expected = [...required, 'staticPreviewEntries', 'staticPreviewFiles'].sort();
  if ((JSON.stringify(keys) !== JSON.stringify(required) && JSON.stringify(keys) !== JSON.stringify(expected)) || !SAFE_ID.test(value.projectId || '')
    || typeof value.label !== 'string' || !value.label.trim() || Buffer.byteLength(value.label) > 160
    || typeof value.root !== 'string' || !path.isAbsolute(value.root)
    || !Array.isArray(value.baselinePaths) || !value.baselinePaths.length
    || !Array.isArray(value.allowedWritePaths) || !value.allowedWritePaths.length
    || !Array.isArray(value.checks) || !value.checks.length) throw new Error('Trusted project definition is malformed');
  value.staticPreviewEntries ??= [];
  value.staticPreviewFiles ??= [];
  for (const list of [value.baselinePaths, value.allowedWritePaths]) {
    if (new Set(list).size !== list.length || list.some((entry) => typeof entry !== 'string' || !SAFE_PATH.test(entry))) {
      throw new Error('Trusted project paths must be unique normalized relative paths');
    }
  }
  if (value.allowedWritePaths.some((entry) => !value.baselinePaths.includes(entry))) throw new Error('Every writable file must be part of the registered source snapshot');
  for (const [name, entries] of [['static preview files', value.staticPreviewFiles], ['static preview entries', value.staticPreviewEntries]]) {
    if (!Array.isArray(entries) || new Set(entries).size !== entries.length
      || entries.some((entry) => typeof entry !== 'string' || !SAFE_PATH.test(entry) || !value.baselinePaths.includes(entry))) {
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

export async function createTrustedProductProjects({ file }) {
  if (!file || !path.isAbsolute(file)) throw new Error('A trusted product project catalogue file is required');
  const realFile = await fs.realpath(file);
  if (realFile !== file) throw new Error('Trusted project catalogue path must be canonical');
  const stat = await fs.lstat(realFile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024) throw new Error('Trusted project catalogue file is invalid');
  const document = JSON.parse(await fs.readFile(realFile, 'utf8'));
  if (document?.schemaVersion !== 1 || !Array.isArray(document.projects) || !document.projects.length
    || JSON.stringify(Object.keys(document).sort()) !== JSON.stringify(['projects', 'schemaVersion'].sort())) {
    throw new Error('Trusted project catalogue is malformed');
  }
  document.projects.forEach(validateDefinition);
  if (new Set(document.projects.map((entry) => entry.projectId)).size !== document.projects.length) throw new Error('Trusted project IDs must be unique');

  async function resolveOne(definition) {
    const root = await fs.realpath(definition.root);
    if (root !== definition.root || await git(root, ['rev-parse', '--show-toplevel']) !== root) throw new Error(`Trusted project root is not canonical Git: ${definition.projectId}`);
    const sourceHead = await git(root, ['rev-parse', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('Trusted project HEAD is invalid');
    const sourceManifest = [];
    let totalBytes = 0;
    for (const relative of definition.baselinePaths) {
      const entry = await readSnapshotFile(root, relative);
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
    const definition = document.projects.find((entry) => entry.projectId === projectId);
    if (!definition) throw Object.assign(new Error('Registered product project is unknown'), { status: 404 });
    return resolveOne(definition);
  }
  async function listPublic() {
    return Promise.all(document.projects.map(async (entry) => {
      const value = await resolveOne(entry);
      return { projectId: value.projectId, label: value.label, scopeFingerprint: value.scopeFingerprint,
        allowedWritePaths: value.allowedWritePaths, checkIds: value.checks.map((check) => check.id),
        staticPreviewEntries: value.staticPreviewEntries, staticPreviewFiles: value.staticPreviewFiles, current: true };
    }));
  }
  async function runtimePolicy(projectId) {
    const value = await current(projectId);
    return {
      schemaVersion: 1,
      projectId: value.projectId,
      authorityUrl: 'http://127.0.0.1:3869/',
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
        team: value.native.allowedRoles.length > 1,
        worktree: true,
        staticPreviewEntries: value.staticPreviewEntries,
        staticPreviewFiles: value.staticPreviewFiles,
        autoMerge: false,
        manualMerge: false,
        commandPreview: false,
      },
    };
  }
  return { listPublic, current, runtimePolicy, file: realFile, catalogueSha256: sha256(await fs.readFile(realFile)) };
}

