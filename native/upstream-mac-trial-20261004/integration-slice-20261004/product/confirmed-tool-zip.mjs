import crypto from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const SHA256 = /^[a-f0-9]{64}$/;
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object'
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value);
const MAX_FILE_BYTES = 512 * 1024;
const MAX_PROJECT_BYTES = 8 * 1024 * 1024;
const blockedArchivePath = (value) => value.split('/').some((part) => part === '.git' || part === 'logs')
  || /(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:secrets?|credentials?)(?:\/|$)|\.log(?:\.|$)/i.test(value);

async function readRegisteredFile(root, entry) {
  const parts = entry.path.split('/');
  let absolute = root;
  for (const part of parts) {
    absolute = path.join(absolute, part);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Registered source contains a symbolic link: ${entry.path}`);
    if (absolute !== path.join(root, ...parts) && !stat.isDirectory()) throw new Error(`Registered source parent is not a directory: ${entry.path}`);
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== entry.bytes || stat.size > MAX_FILE_BYTES) {
    throw new Error(`Registered source file is not bounded: ${entry.path}`);
  }
  const bytes = await fs.readFile(absolute);
  const after = await fs.lstat(absolute);
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256 || stat.dev !== after.dev || stat.ino !== after.ino
    || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
    throw new Error(`Registered source changed while packaging: ${entry.path}`);
  }
  return bytes;
}

export function confirmedToolBindingMatches(binding, projection) {
  const registry = projection?.productRegistry;
  const artifact = projection?.artifact;
  return projection?.current === true && projection.taskId === binding.taskId
    && projection.goalVersionId === binding.goalVersionId && projection.execution?.id === binding.executionId
    && projection.workspace?.current === true && projection.workspace.scopeFingerprint === binding.scopeFingerprint
    && projection.workspace.sourceSnapshotSha256 === binding.sourceSnapshotSha256
    && registry?.current === true && registry.projectId === binding.projectId
    && registry.registrySha256 === binding.registrySha256
    && artifact?.status === 'confirmed' && artifact.id === binding.artifactId
    && artifact.version === binding.artifactVersion && artifact.candidateSha256 === binding.candidateSha256
    && artifact.review?.id === binding.reviewId && artifact.review.passed === true
    && artifact.confirmation?.approvalId === binding.approvalId
    && artifact.confirmation.artifactVersion === binding.artifactVersion
    && artifact.confirmation.goalVersionId === binding.goalVersionId;
}

export async function buildConfirmedToolZip({ project, candidate, confirmedPatch, binding }) {
  if (!project || project.projectKind !== 'utility' || project.templateId !== 'tool-starter-v1'
    || !Array.isArray(project.baselinePaths) || !Array.isArray(project.allowedWritePaths)
    || !Array.isArray(project.sourceManifest) || !path.isAbsolute(project.root)
    || !project.baselinePaths.includes('IRIXI_PROJECT.json')
    || !project.baselinePaths.includes('index.html') || !project.baselinePaths.includes('app.js')) {
    throw new Error('A registered static utility project is required');
  }
  if (await fs.realpath(project.root) !== project.root) throw new Error('Registered project root is not canonical');
  if (!candidate || !binding || candidate.taskId !== binding.taskId || candidate.goalVersionId !== binding.goalVersionId
    || candidate.artifactId !== binding.artifactId || candidate.artifactVersion !== binding.artifactVersion
    || candidate.candidateSha256 !== binding.candidateSha256
    || candidate.confirmation?.approvalId !== binding.approvalId
    || candidate.confirmation?.artifactVersion !== binding.artifactVersion
    || candidate.confirmation?.goalVersionId !== binding.goalVersionId
    || candidate.review?.id !== binding.reviewId || candidate.review?.passed !== true || binding.status !== 'confirmed'
    || binding.projectId !== project.projectId || binding.scopeFingerprint !== project.scopeFingerprint
    || binding.sourceSnapshotSha256 !== project.sourceSnapshotSha256
    || !Array.isArray(candidate.files) || !candidate.files.length || !Buffer.isBuffer(confirmedPatch)) {
    throw new Error('Confirmed candidate or Authority binding is stale');
  }
  const patchDigest = sha256(confirmedPatch);
  if (patchDigest !== candidate.patchSha256 || candidate.patch !== confirmedPatch.toString('utf8')
    || sha256(Buffer.from(canonical(candidate.files))) !== candidate.candidateSha256) {
    throw new Error('Approved patch does not match the current candidate');
  }
  const baseline = new Map();
  for (const entry of project.sourceManifest) {
    if (!entry || typeof entry.path !== 'string' || !project.baselinePaths.includes(entry.path)
      || path.posix.normalize(entry.path) !== entry.path || entry.path.startsWith('/') || entry.path.includes('\\')
      || entry.path.split('/').some((part) => !part || part === '.' || part === '..') || blockedArchivePath(entry.path)
      || !Number.isInteger(entry.bytes) || !SHA256.test(entry.sha256 || '') || !Number.isInteger(entry.mode)
      || baseline.has(entry.path)) throw new Error('Registered project manifest is unsafe or incomplete');
    baseline.set(entry.path, entry);
  }
  if (baseline.size !== project.baselinePaths.length
    || project.baselinePaths.some((entry) => !baseline.has(entry))) throw new Error('Registered project manifest does not cover its exact baseline');
  const changes = new Map();
  for (const entry of candidate.files) {
    if (!entry || typeof entry.path !== 'string' || !project.allowedWritePaths.includes(entry.path)
      || !baseline.has(entry.path) || !Number.isInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES
      || !SHA256.test(entry.sha256 || '') || changes.has(entry.path)) throw new Error('Candidate manifest is outside the registered writable files');
    changes.set(entry.path, entry);
  }
  const sourceBytes = new Map();
  let sourceTotal = 0;
  for (const [relative, entry] of baseline) {
    const bytes = await readRegisteredFile(project.root, entry);
    sourceTotal += bytes.length;
    if (sourceTotal > MAX_PROJECT_BYTES) throw new Error('Registered project exceeds the ZIP source limit');
    sourceBytes.set(relative, bytes);
  }
  const registration = JSON.parse(sourceBytes.get('IRIXI_PROJECT.json').toString('utf8'));
  if (registration?.schemaVersion !== 1 || registration.projectId !== project.projectId
    || registration.projectKind !== 'utility' || registration.templateId !== 'tool-starter-v1') {
    throw new Error('Registered utility marker does not match the trusted project');
  }
  let root;
  try { root = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-tool-zip-')); }
  catch { throw new Error('A temporary directory for the confirmed tool ZIP is unavailable'); }
  try {
    const baselineRoot = path.join(root, 'baseline');
    const candidateRoot = path.join(root, 'tool');
    await fs.mkdir(baselineRoot, { mode: 0o700 });
    await fs.mkdir(candidateRoot, { mode: 0o700 });
    for (const [relative, bytes] of sourceBytes) {
      for (const destination of [baselineRoot, candidateRoot]) {
        const file = path.join(destination, relative);
        if (!file.startsWith(`${destination}${path.sep}`)) throw new Error('Registered project path escaped its package directory');
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await fs.writeFile(file, bytes, { mode: 0o600 });
        await fs.chmod(file, baseline.get(relative).mode & 0o777);
      }
    }
    const patchFile = path.join(root, 'candidate.patch');
    await fs.writeFile(patchFile, confirmedPatch, { mode: 0o600 });
    await execFile('git', ['init', '--quiet'], { cwd: candidateRoot, timeout: 5_000, maxBuffer: 128 * 1024 });
    await execFile('git', ['add', '--all'], { cwd: candidateRoot, timeout: 5_000, maxBuffer: 128 * 1024 });
    await execFile('git', ['-c', 'user.name=Irixi ZIP verifier', '-c', 'user.email=zip-verifier@localhost.invalid',
      'commit', '--quiet', '-m', 'Registered source baseline'], { cwd: candidateRoot, timeout: 5_000, maxBuffer: 128 * 1024 });
    await execFile('git', ['apply', '--check', '--whitespace=nowarn', patchFile], { cwd: candidateRoot, timeout: 5_000, maxBuffer: 256 * 1024 });
    await execFile('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: candidateRoot, timeout: 5_000, maxBuffer: 256 * 1024 });

    const listed = await execFile('git', ['ls-files', '--cached'], { cwd: candidateRoot, encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024 });
    const packagedPaths = listed.stdout.trim().split(/\r?\n/).filter(Boolean).sort();
    const expectedPaths = [...baseline.keys()].sort();
    if (JSON.stringify(packagedPaths) !== JSON.stringify(expectedPaths)) throw new Error('Candidate patch added, removed, or escaped the exact registered file set');
    const untracked = await execFile('git', ['ls-files', '--others', '--exclude-standard'], { cwd: candidateRoot, encoding: 'utf8', timeout: 5_000, maxBuffer: 128 * 1024 });
    if (untracked.stdout.trim()) throw new Error('Candidate patch added an unregistered file');
    let candidateTotal = 0;
    const candidateFiles = [];
    for (const relative of expectedPaths) {
      const file = path.join(candidateRoot, relative);
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== (baseline.get(relative).mode & 0o777)) {
        throw new Error(`Candidate file has an unsafe type or mode: ${relative}`);
      }
      const bytes = await fs.readFile(file);
      const after = await fs.lstat(file);
      const change = changes.get(relative);
      const expectedBytes = change?.bytes ?? baseline.get(relative).bytes;
      const expectedSha256 = change?.sha256 ?? baseline.get(relative).sha256;
      if (bytes.length !== expectedBytes || sha256(bytes) !== expectedSha256 || stat.ino !== after.ino
        || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) {
        throw new Error(`Candidate bytes do not match the confirmed manifest: ${relative}`);
      }
      candidateTotal += bytes.length;
      if (candidateTotal > MAX_PROJECT_BYTES) throw new Error('Confirmed candidate exceeds the ZIP file limit');
      candidateFiles.push({ path: relative, bytes: bytes.length, sha256: expectedSha256, mode: stat.mode & 0o777 });
    }
    const readme = Buffer.from(`已确认工具：${project.label}\n\n使用：打开 tool/index.html。\nbaseline/ 是登记基线，仅供备查；candidate.patch 是该确认版本的原始差异，仅供备查，不会自动应用到原工程。\n离线直接双击打开尚未验证，不能据此认定离线可用。\n`);
    const manifest = Buffer.from(`${JSON.stringify({ schemaVersion: 1, type: 'irixi-confirmed-tool-zip', binding,
      sourceSnapshotSha256: project.sourceSnapshotSha256, baselineFiles: [...baseline.values()], candidateFiles,
      patch: { path: 'candidate.patch', bytes: confirmedPatch.length, sha256: patchDigest } }, null, 2)}\n`);
    await fs.writeFile(path.join(root, 'README.txt'), readme, { mode: 0o600 });
    await fs.writeFile(path.join(root, 'MANIFEST.json'), manifest, { mode: 0o600 });
    const checksummed = [
      ...[...sourceBytes].map(([relative, bytes]) => [sha256(bytes), `baseline/${relative}`]),
      ...candidateFiles.map((entry) => [entry.sha256, `tool/${entry.path}`]),
      [patchDigest, 'candidate.patch'], [sha256(manifest), 'MANIFEST.json'], [sha256(readme), 'README.txt'],
    ].map(([digest, relative]) => `${digest}  ${relative}`).join('\n') + '\n';
    await fs.writeFile(path.join(root, 'MANIFEST.sha256'), checksummed, { mode: 0o600 });
    const archivePath = path.join(root, 'download.zip');
    const entries = ['README.txt', 'MANIFEST.json', 'MANIFEST.sha256', 'candidate.patch',
      ...expectedPaths.flatMap((relative) => [`baseline/${relative}`, `tool/${relative}`])];
    await execFile('/usr/bin/zip', ['-q', '-X', '-9', archivePath, ...entries], { cwd: root, timeout: 15_000, maxBuffer: 256 * 1024 });
    const bytes = await fs.readFile(archivePath);
    if (!bytes.length || bytes.length > 24 * 1024 * 1024) throw new Error('Confirmed tool ZIP exceeded the download limit');
    return { bytes, sha256: sha256(bytes), filename: `${project.projectId}-v${binding.artifactVersion}.zip` };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
