import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { assertAuthorityProjection, fingerprint } from '../authority/authority-core.mjs';
import { isSafeRegisteredProjectPath, NOOBI_GAME_PROJECT_ID } from './noobi-game-contract.mjs';

export const NOOBI_HEAD = '21729721f342c273efd19206bba1922923312407';
export const NOOBI_ROOT = '/path/to/Noobi-rixi.ai';
export const NOOBI_PROJECT_STORE_FILE = path.join(os.homedir(), 'Library/Application Support/Noobi.ai/projects.json');
const execFile = promisify(execFileCallback);
const MAX_NOOBI_DIST_BYTES = 8 * 1024 * 1024;
const MAX_NOOBI_DIST_FILE_BYTES = 4 * 1024 * 1024;
const PINNED = {
  'src/main/workspaceTemplate.ts': 'd62b1e70432d3883c81a2237ed9b368deefef18c468666c75ba11734a79dad9a',
  'src/main/projectStore.ts': 'dc8c4e712a276eae08ae6266e814f026b19f6e50b5f3945409f9c3931d540fdf',
  'src/main/webProductionBuild.ts': 'f2d04999503f9dd8fb968936fda7848f844b4cd55f5459996de9efd1597bf81e',
  'src/main/previewServer.ts': 'dc459be78d905028f6d706fe6560af693905cc877a404dba26ce32d218987d07',
  'dist/main/workspaceTemplate.js': '04f7140f2d6280a3d0f4494ff9cf39d683a9e8a8ab17421c157ad13ba06e821b',
  'dist/main/projectStore.js': 'e12bc1c66bda675894dd8590e995ad9e769416ccabffd584914ddf97975cc4e8',
  'dist/main/webProductionBuild.js': 'fd6fc0705bd77123559adafba9714b4c2c465a5ea541db4d71c064977822dc59',
  'dist/main/previewServer.js': 'f8bb7dac04869aa8337876ad6269195ab1a6e40a7195ca365e9fe5d75f67672e',
  'node_modules/vite/bin/vite.js': '8498a58e0d311572c409038515df0e5d707bdc6ab5927153f487e36ef1c9052c',
  'node_modules/vite/package.json': 'a1d0149fd986fd34b6d35503d2c0d8d9f743c4dbaaf94fbc11812bc84b05884d',
};
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const workspaceChangedError = () => Object.assign(
  new Error('Project workspace changed; this file cannot be shown as the registered version'),
  { code: 'NOOBI_WORKSPACE_CHANGED' },
);

function filterRegisteredFiles(nodes, allowedPaths) {
  return (nodes || []).flatMap((entry) => {
    if (entry.type === 'directory') {
      const children = filterRegisteredFiles(entry.children, allowedPaths);
      return children.length ? [{ ...entry, children }] : [];
    }
    return entry.type === 'file' && allowedPaths.has(entry.relativePath) ? [entry] : [];
  });
}

async function readRegisteredFile(root, relativePath, expected, readProjectFile) {
  if (!expected || expected.path !== relativePath || !Number.isInteger(expected.bytes) || expected.bytes < 0
    || expected.bytes > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(expected.sha256 || '')) {
    throw new Error('Project file has no bounded registered content identity');
  }
  const rootPath = await fs.realpath(root);
  if (rootPath !== root) throw new Error('Registered project root is no longer canonical');
  const absolute = path.resolve(root, ...relativePath.split('/'));
  if (!absolute.startsWith(`${root}${path.sep}`) || await fs.realpath(absolute) !== absolute) {
    throw new Error('Registered project file path is no longer canonical');
  }
  const before = await fs.lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== expected.bytes) {
    throw workspaceChangedError();
  }
  const readerResult = await readProjectFile(root, relativePath, { maxBytes: Math.min(Math.max(expected.bytes, 1), 256 * 1024) });
  const handle = await fs.open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let bytes;
  try {
    const opened = await handle.stat();
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size !== expected.bytes
      || opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs
      || bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) {
      throw workspaceChangedError();
    }
  } finally { await handle.close(); }
  const afterRead = await fs.lstat(absolute);
  if (before.dev !== afterRead.dev || before.ino !== afterRead.ino || before.size !== afterRead.size
    || before.mtimeMs !== afterRead.mtimeMs || before.ctimeMs !== afterRead.ctimeMs) {
    throw Object.assign(workspaceChangedError(), { message: 'Project workspace changed while this file was being read' });
  }
  if (!readerResult.binary && !readerResult.truncated
    && !Buffer.from(readerResult.content, 'utf8').equals(bytes)) {
    throw workspaceChangedError();
  }
  return Object.freeze({ ...readerResult, bytes: expected.bytes, sha256: expected.sha256, verified: true });
}

export function officeProjectIdentity({ taskId, projectId }) {
  const values = [taskId, projectId];
  if (values.some((value) => typeof value !== 'string' || !value.trim()) || new Set(values).size !== values.length) {
    throw new Error('Office task and project IDs must be distinct non-empty strings');
  }
  return Object.freeze({ taskId, projectId });
}

// Project creation has no run id; later binding consumes the real authority-core projection.
export function officeExecutionIdentity(taskRecord, projection) {
  assertAuthorityProjection(projection);
  const office = officeProjectIdentity({ taskId: taskRecord?.id, projectId: projection?.productRegistry?.projectId });
  const registry = projection?.productRegistry;
  const workspace = projection?.workspace;
  const projectWorkspace = taskRecord?.projectWorkspace;
  if (projection.current !== true || projection.taskId !== office.taskId || !projection.execution?.id
    || projection.execution.goalVersionId !== projection.goalVersionId || registry?.current !== true
    || !registry.registrySha256 || registry.workspace?.scopeFingerprint !== workspace?.scopeFingerprint
    || registry.workspace?.sourceSnapshotSha256 !== workspace?.sourceSnapshotSha256 || workspace?.current !== true
    || projectWorkspace?.scopeFingerprint !== workspace.scopeFingerprint
    || projectWorkspace?.sourceSnapshotSha256 !== workspace.sourceSnapshotSha256
    || fingerprint(projectWorkspace?.taskInputBinding) !== projection.taskInputBindingSha256) {
    throw new Error('TaskStore binding and current Authority projection do not match');
  }
  return Object.freeze({ taskId: office.taskId, projectId: office.projectId, runId: projection.execution.id,
    goalVersionId: projection.goalVersionId, registrySha256: registry.registrySha256,
    scopeFingerprint: workspace.scopeFingerprint });
}

export async function currentNativeCandidateRoot(taskRecord, projection) {
  officeExecutionIdentity(taskRecord, projection);
  const reviewed = projection.artifact;
  if (projection.native?.actions?.canPreview !== true || !reviewed || reviewed.nativeCandidate !== true) {
    throw new Error('Current Authority projection does not allow native-candidate preview');
  }
  const artifact = (taskRecord.artifacts || []).find((entry) => entry.id === reviewed.id);
  const candidate = artifact?.nativeProjectCandidate;
  if (!candidate || candidate.kind !== 'native_worktree_candidate_v1'
    || candidate.candidateSha256 !== reviewed.candidateSha256
    || candidate.workspaceScopeFingerprint !== projection.workspace.scopeFingerprint
    || candidate.sourceSnapshotSha256 !== projection.workspace.sourceSnapshotSha256
    || candidate.registrySha256 !== projection.productRegistry.registrySha256
    || fingerprint(candidate.taskInputBinding) !== projection.taskInputBindingSha256
    || typeof candidate.nativeWorkspace !== 'string' || !path.isAbsolute(candidate.nativeWorkspace)) {
    throw new Error('TaskStore candidate is not bound to the current Authority artifact');
  }
  const root = await fs.realpath(candidate.nativeWorkspace);
  const stat = await fs.lstat(root);
  if (root !== candidate.nativeWorkspace || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Confirmed candidate workspace root is not canonical');
  }
  return Object.freeze({ root, artifactId: reviewed.id, candidateSha256: reviewed.candidateSha256 });
}

export async function assertExplicitProjectRoot(parentRoot, projectRoot) {
  if (typeof parentRoot !== 'string' || !path.isAbsolute(parentRoot)
    || typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) {
    throw new Error('An explicit absolute project root and parent root are required');
  }
  const parent = await fs.realpath(parentRoot);
  const requestedRoot = path.resolve(projectRoot);
  if (path.dirname(requestedRoot) === requestedRoot || await fs.realpath(path.dirname(requestedRoot)) !== parent
    || path.basename(requestedRoot) === '.' || path.basename(requestedRoot) === '..') {
    throw new Error('Project root must be an explicit direct child of its selected parent');
  }
  const root = path.join(parent, path.basename(requestedRoot));
  return { parentRoot: parent, projectRoot: root };
}

export async function createNoobiProjectAdapter({ noobiRoot = NOOBI_ROOT, storageFile, authorityReader, previewServer = null } = {}) {
  if (typeof storageFile !== 'string' || !path.isAbsolute(storageFile)) throw new Error('An explicit local Noobi ProjectStore file is required');
  if (typeof authorityReader?.read !== 'function') throw new Error('The existing read-only Authority reader is required');
  const root = await fs.realpath(noobiRoot);
  if (root !== NOOBI_ROOT) throw new Error('Noobi source root differs from the approved fixed checkout');
  const storagePath = path.resolve(storageFile);
  if (storagePath.startsWith(`${root}${path.sep}`)) throw new Error('Noobi ProjectStore must not write inside the Noobi source checkout');
  const head = (await import('node:child_process')).execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (head !== NOOBI_HEAD) throw new Error(`Noobi HEAD mismatch: expected ${NOOBI_HEAD}`);
  for (const [relative, expected] of Object.entries(PINNED)) {
    const actual = sha256(await fs.readFile(path.join(root, relative)));
    if (actual !== expected) throw new Error(`Pinned Noobi module changed: ${relative}`);
  }
  const load = (name) => import(pathToFileURL(path.join(root, `dist/main/${name}.js`)).href);
  const [template, storeModule, buildModule, previewModule] = await Promise.all([
    load('workspaceTemplate'), load('projectStore'), load('webProductionBuild'), load('previewServer'),
  ]);
  if (typeof template.createWorkspaceTemplate !== 'function' || typeof storeModule.ProjectStore !== 'function'
    || typeof buildModule.verifyWebProductionBuild !== 'function' || typeof previewModule.PreviewServer !== 'function') {
    throw new Error('Pinned Noobi build is missing a required exported module');
  }
  const store = new storeModule.ProjectStore({ storageFile, defaultWorkspace: path.dirname(storageFile) });
  const preview = previewServer ?? new previewModule.PreviewServer();
  async function readCurrentAuthority() {
    const snapshot = await authorityReader.read();
    const task = snapshot?.taskRecord ?? snapshot?.task;
    const projection = snapshot?.authorityProjection ?? snapshot?.projection;
    officeExecutionIdentity(task, projection);
    return { task, projection };
  }
  async function assertRegisteredProject(project, projection) {
    const registeredRoot = projection?.productRegistry?.workspace?.path;
    const projectRoot = await fs.realpath(project.root);
    if (projectRoot !== project.root || projectRoot !== registeredRoot) {
      throw new Error('Noobi ProjectStore root does not match the current registered native workspace');
    }
    const metadataPath = path.join(projectRoot, '.noobi/project.json');
    const metadataStat = await fs.lstat(metadataPath);
    if (!metadataStat.isFile() || metadataStat.isSymbolicLink() || metadataStat.nlink !== 1 || metadataStat.size > 64 * 1024) {
      throw new Error('Noobi project metadata is not a bounded regular file');
    }
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    if (metadata.id !== project.id) {
      throw new Error('Noobi project metadata identity does not match ProjectStore');
    }
  }
  async function projectBinding(noobiProjectId, office) {
    officeProjectIdentity(office);
    const project = await store.get(noobiProjectId);
    const { projection } = await readCurrentAuthority();
    if (projection.productRegistry.projectId !== office.projectId) throw new Error('Noobi binding does not match the registered Office project');
    await assertRegisteredProject(project, projection);
    return Object.freeze({ office: officeProjectIdentity(office), noobi: Object.freeze({
      projectId: project.id, root: project.root, status: project.status, stage: project.stage,
    }) });
  }
  async function checkedProject(binding) {
    requireNoobiBinding(binding);
    const project = await store.get(binding.noobi.projectId);
    const { projection } = await readCurrentAuthority();
    if (project.root !== binding.noobi.root) throw new Error('Noobi ProjectStore root does not match this binding');
    await assertRegisteredProject(project, projection);
    return project;
  }
  async function checkedExecution(binding) {
    const project = await checkedProject(binding);
    const { task, projection } = await readCurrentAuthority();
    const current = officeExecutionIdentity(task, projection);
    if (['taskId', 'projectId', 'runId', 'goalVersionId', 'registrySha256', 'scopeFingerprint']
      .some((key) => binding.office[key] !== current[key])) {
      throw new Error('Office execution binding is not the current TaskStore/Authority run');
    }
    return { project, task, projection };
  }
  async function currentGameProject({ taskId, projectId }) {
    const { task, projection } = await readCurrentAuthority();
    const office = officeExecutionIdentity(task, projection);
    if (office.taskId !== taskId || office.projectId !== projectId || projectId !== NOOBI_GAME_PROJECT_ID) {
      throw new Error('Current game workspace is not bound to this Office task and registered Noobi project');
    }
    const registeredRoot = projection.productRegistry.workspace.path;
    const matches = [];
    for (const entry of await store.list()) {
      if (await fs.realpath(entry.root).catch(() => null) === registeredRoot) matches.push(entry);
    }
    if (matches.length !== 1) throw new Error('Current registered workspace must match exactly one Noobi ProjectStore project');
    await assertRegisteredProject(matches[0], projection);
    return { task, projection, office, project: matches[0] };
  }
  async function gameWorkspaceView(input) {
    const { task, projection, office, project } = await currentGameProject(input);
    const allowedSourcePaths = new Set((projection.productRegistry.workspace.sourceManifest || [])
      .map((entry) => entry?.path).filter((entry) => isSafeRegisteredProjectPath(office.projectId, entry)));
    const sourceFiles = filterRegisteredFiles(await store.listProjectFiles(project.id, { maxEntries: 500, maxDepth: 10 }), allowedSourcePaths);
    const artifact = projection.artifact;
    const taskArtifact = artifact ? (task.artifacts || []).find((entry) => entry.id === artifact.id) : null;
    let candidateFiles = [];
    let candidateAvailable = false;
    let candidate = null;
    if (artifact?.nativeCandidate === true && projection.native?.actions?.canPreview === true) {
      candidate = await currentNativeCandidateRoot(task, projection);
      const allowedCandidatePaths = new Set([...allowedSourcePaths,
        ...(taskArtifact?.nativeProjectCandidate?.manifest || []).map((entry) => entry?.path)
          .filter((entry) => isSafeRegisteredProjectPath(office.projectId, entry))]);
      candidateFiles = filterRegisteredFiles(await storeModule.listProjectFiles(candidate.root, { maxEntries: 500, maxDepth: 10 }), allowedCandidatePaths);
      candidateAvailable = true;
    }
    return Object.freeze({
      binding: Object.freeze({ taskId: office.taskId, projectId: office.projectId, runId: office.runId,
        goalVersionId: office.goalVersionId, registrySha256: office.registrySha256,
        scopeFingerprint: office.scopeFingerprint, artifactId: artifact?.id || null,
        artifactVersion: artifact?.version ?? null, candidateSha256: artifact?.candidateSha256 || null }),
      project: Object.freeze({ id: project.id, name: project.name, status: project.status, stage: project.stage }),
      sourceFiles,
      candidate: artifact ? Object.freeze({ id: artifact.id, version: artifact.version,
        candidateSha256: artifact.candidateSha256, status: artifact.confirmation ? 'confirmed'
          : artifact.review?.passed ? 'review_passed' : artifact.review ? 'review_failed'
            : 'candidate', review: artifact.review ? { id: artifact.review.id, passed: artifact.review.passed,
              verdict: artifact.review.nativeVerdict || null } : null,
        confirmed: Boolean(artifact.confirmation) }) : null,
      candidateAvailable,
      candidateFiles,
    });
  }
  async function readGameWorkspaceFile(input) {
    const view = input?.view;
    const relativePath = input?.relativePath;
    if (!['source', 'candidate'].includes(view) || typeof relativePath !== 'string' || !relativePath || relativePath.length > 1024) {
      throw new Error('A bounded project-relative path and source or candidate view are required');
    }
    const { task, projection, office, project } = await currentGameProject(input);
    const taskArtifact = projection.artifact ? (task.artifacts || []).find((entry) => entry.id === projection.artifact.id) : null;
    const visibleInTree = (nodes) => nodes.some((entry) => entry.relativePath === relativePath
      ? entry.type === 'file' : entry.type === 'directory' && relativePath.startsWith(`${entry.relativePath}/`)
        && visibleInTree(entry.children || []));
    const allowedSourcePaths = new Set((projection.productRegistry.workspace.sourceManifest || [])
      .map((entry) => entry?.path).filter((entry) => isSafeRegisteredProjectPath(office.projectId, entry)));
    let binding = Object.freeze({ taskId: office.taskId, projectId: office.projectId, runId: office.runId,
      goalVersionId: office.goalVersionId, registrySha256: office.registrySha256,
      scopeFingerprint: office.scopeFingerprint, artifactId: projection.artifact?.id || null,
      artifactVersion: projection.artifact?.version ?? null, candidateSha256: projection.artifact?.candidateSha256 || null });
    if (view === 'source') {
      const expected = (projection.productRegistry.workspace.sourceManifest || []).find((entry) => entry.path === relativePath);
      if (!allowedSourcePaths.has(relativePath) || !visibleInTree(filterRegisteredFiles(
        await store.listProjectFiles(project.id, { maxEntries: 500, maxDepth: 10 }), allowedSourcePaths))) {
        throw new Error('Requested source file is not in the bounded ProjectStore listing');
      }
      const file = await readRegisteredFile(project.root, relativePath, expected,
        (root, target, options) => storeModule.readProjectFile(root, target, options));
      return Object.freeze({ binding, view, relativePath, file });
    }
    if (projection.artifact?.nativeCandidate !== true || projection.native?.actions?.canPreview !== true) {
      throw new Error('A current Authority-bound game candidate is not available');
    }
    const candidate = await currentNativeCandidateRoot(task, projection);
    const changedManifest = taskArtifact?.nativeProjectCandidate?.manifest || [];
    const allowedCandidatePaths = new Set([...allowedSourcePaths,
      ...changedManifest.map((entry) => entry?.path)
        .filter((entry) => isSafeRegisteredProjectPath(office.projectId, entry))]);
    if (!allowedCandidatePaths.has(relativePath) || !visibleInTree(filterRegisteredFiles(
      await storeModule.listProjectFiles(candidate.root, { maxEntries: 500, maxDepth: 10 }), allowedCandidatePaths))) {
      throw new Error('Requested candidate file is not in the bounded ProjectStore listing');
    }
    const expected = changedManifest.find((entry) => entry.path === relativePath)
      || (projection.productRegistry.workspace.sourceManifest || []).find((entry) => entry.path === relativePath);
    const file = await readRegisteredFile(candidate.root, relativePath, expected,
      (root, target, options) => storeModule.readProjectFile(root, target, options));
    return Object.freeze({ binding, view, relativePath, file });
  }
  return Object.freeze({
    gameWorkspaceView,
    readGameWorkspaceFile,
    async createProject({ parentRoot, projectRoot, office, name, idea }) {
      const scope = await assertExplicitProjectRoot(parentRoot, projectRoot);
      const officeIds = officeProjectIdentity(office);
      const project = await store.create({ name, idea, projectDirectory: scope.projectRoot, engine: 'web', model: null });
      return Object.freeze({ office: officeIds, noobi: Object.freeze({
        projectId: project.id, root: project.root, status: project.status, stage: project.stage,
      }) });
    },
    async bindExecution(projectBinding) {
      await checkedProject(projectBinding);
      const { task, projection } = await readCurrentAuthority();
      const office = officeExecutionIdentity(task, projection);
      if (office.taskId !== projectBinding.office.taskId || office.projectId !== projectBinding.office.projectId) {
        throw new Error('Current Authority task/project differs from the Noobi project binding');
      }
      const binding = Object.freeze({ office, noobi: Object.freeze({ ...projectBinding.noobi }) });
      return binding;
    },
    async restoreProjectBinding(noobiProjectId) {
      const { task, projection } = await readCurrentAuthority();
      const office = officeExecutionIdentity(task, projection);
      const binding = await projectBinding(noobiProjectId, { taskId: office.taskId, projectId: office.projectId });
      return Object.freeze({ office, noobi: binding.noobi });
    },
    async verifyRegisteredCandidateBuild({ nativeWorkspace, registeredRoot, sourceManifest, expectedSourceHead, candidateSha256, projectId }) {
      const { task, projection } = await readCurrentAuthority();
      const current = officeExecutionIdentity(task, projection);
      if (current.projectId !== projectId || projection.productRegistry.workspace.sourceHead !== expectedSourceHead
        || !/^[a-f0-9]{64}$/.test(candidateSha256 || '')
        || projection.productRegistry.workspace.path !== registeredRoot) {
        throw new Error('Noobi build request is not bound to the current registered project');
      }
      const projects = await store.list();
      const matches = [];
      for (const project of projects) {
        const resolved = await fs.realpath(project.root).catch(() => null);
        if (resolved === registeredRoot) matches.push(project);
      }
      if (matches.length !== 1) throw new Error('Current registered workspace must match exactly one Noobi ProjectStore record');
      await assertRegisteredProject(matches[0], projection);
      const candidateMetadataPath = path.join(await checkedCandidateRoot(nativeWorkspace), '.noobi/project.json');
      const candidateMetadataStat = await fs.lstat(candidateMetadataPath);
      if (!candidateMetadataStat.isFile() || candidateMetadataStat.isSymbolicLink() || candidateMetadataStat.nlink !== 1
        || candidateMetadataStat.size > 64 * 1024) throw new Error('Candidate Noobi metadata is not a bounded regular file');
      const candidateMetadata = JSON.parse(await fs.readFile(candidateMetadataPath, 'utf8'));
      if (candidateMetadata.id !== matches[0].id) throw new Error('Candidate worktree Noobi project identity differs from the registered ProjectStore project');
      return runFixedNoobiWebBuild({ root, buildModule, nativeWorkspace, sourceManifest,
        registeredProjectId: projectId, noobiProjectId: matches[0].id,
        candidateSha256,
        sourceHead: expectedSourceHead, registrySha256: projection.productRegistry.registrySha256,
        goalVersionId: projection.goalVersionId, executionId: projection.execution.id });
    },
    // Call at captureNativeCandidate after verifiedNativeGitWorkspace; never discover or scan for a workspace here.
    async verifyBuild(binding, verifiedNativeWorkspace) {
      const { projection } = await checkedExecution(binding);
      if (verifiedNativeWorkspace?.sourceHead !== projection.productRegistry.workspace.sourceHead) {
        throw new Error('Candidate worktree does not match the current registered source HEAD');
      }
      const root = await checkedCandidateRoot(verifiedNativeWorkspace?.native);
      const build = await buildModule.verifyWebProductionBuild(root);
      return Object.freeze({ office: binding.office, noobiProjectId: binding.noobi.projectId, candidateRoot: root,
        artifactId: projection.artifact?.id || null, candidateSha256: projection.artifact?.candidateSha256 || null, build });
    },
    async openPreview(binding, verifiedBuild, candidateRoot) {
      const { task, projection } = await checkedExecution(binding);
      const candidate = await currentNativeCandidateRoot(task, projection);
      const previewRoot = await checkedCandidateRoot(candidateRoot);
      if (!verifiedBuild?.office || ['taskId', 'projectId', 'runId', 'goalVersionId', 'registrySha256', 'scopeFingerprint']
        .some((key) => verifiedBuild.office[key] !== binding.office[key])) {
        throw new Error('Build result belongs to a different Office task, project, or run');
      }
      if (verifiedBuild?.noobiProjectId !== binding.noobi.projectId || verifiedBuild.candidateRoot !== candidate.root
        || previewRoot !== candidate.root || verifiedBuild.artifactId !== candidate.artifactId || verifiedBuild.candidateSha256 !== candidate.candidateSha256
        || verifiedBuild.build?.ok !== true || verifiedBuild.build?.stale !== false || !verifiedBuild.build?.buildIdentity) {
        throw new Error('A current Authority-enabled candidate build is required before preview');
      }
      const currentBuild = await buildModule.verifyWebProductionBuild(candidate.root);
      if (!currentBuild.ok || currentBuild.stale || currentBuild.buildIdentity !== verifiedBuild.build.buildIdentity) {
        throw new Error('Authority-enabled candidate output changed or became stale before preview');
      }
      const url = await preview.start(binding.noobi.projectId, candidate.root, {
        directory: 'dist', sourceFallback: false, sourceAssetOverlay: false,
      });
      return Object.freeze({ ...verifiedBuild, build: currentBuild, previewUrl: url });
    },
    async closePreview(binding) {
      await checkedProject(binding);
      await preview.stop(binding.noobi.projectId);
    },
    async stopAllPreviews() { await preview.stopAll(); },
  });
}

async function checkedCandidateRoot(candidateRoot) {
  if (typeof candidateRoot !== 'string' || !path.isAbsolute(candidateRoot)) throw new Error('Explicit Authority-verified candidate root is required');
  const root = await fs.realpath(candidateRoot);
  const stat = await fs.lstat(root);
  if (root !== candidateRoot || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Candidate root is not canonical');
  return root;
}

async function runFixedNoobiWebBuild({ root, buildModule, nativeWorkspace, sourceManifest, registeredProjectId, noobiProjectId,
  candidateSha256, sourceHead, registrySha256, goalVersionId, executionId }) {
  if (!Array.isArray(sourceManifest) || !sourceManifest.length) throw new Error('Registered Noobi source manifest is required for build verification');
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'irixi-noobi-host-build-'));
  try {
    for (const entry of sourceManifest) {
      const baseName = typeof entry?.path === 'string' ? path.basename(entry.path) : '';
      if (typeof entry?.path !== 'string' || !isSafeRegisteredProjectPath(registeredProjectId, entry.path)
        || path.isAbsolute(entry.path) || entry.path.split(/[\\/]/).includes('..')
        || /^(?:vite|postcss)\.config\./i.test(baseName)) {
        throw new Error('Registered Noobi source manifest contains an unsafe or executable build configuration path');
      }
      const sourcePath = path.join(nativeWorkspace, entry.path);
      const sourceStat = await fs.lstat(sourcePath);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1 || sourceStat.size > 2 * 1024 * 1024) {
        throw new Error(`Registered Noobi build input is not a bounded regular file: ${entry.path}`);
      }
      const bytes = await fs.readFile(sourcePath);
      const target = path.join(tempRoot, entry.path);
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: sourceStat.mode & 0o777 });
    }
    const packageInfo = JSON.parse(await fs.readFile(path.join(root, 'node_modules/vite/package.json'), 'utf8'));
    if (packageInfo.version !== '6.4.3') throw new Error('Pinned local Vite version changed');
    const viteCli = path.join(root, 'node_modules/vite/bin/vite.js');
    await execFile(process.execPath, [viteCli, 'build', '--base=./', '--outDir', 'dist', '--emptyOutDir'], {
      cwd: tempRoot, timeout: 60_000, maxBuffer: 2 * 1024 * 1024,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    });
    const build = await buildModule.verifyWebProductionBuild(tempRoot);
    if (build.ok !== true || build.stale !== false || !build.buildIdentity) {
      throw new Error(`Fixed Noobi web build check failed: ${build.reason}: ${build.detail}`);
    }
    const distPath = path.join(nativeWorkspace, 'dist');
    const existingDist = await fs.lstat(distPath).catch((error) => error?.code === 'ENOENT' ? null : Promise.reject(error));
    if (existingDist && (!existingDist.isDirectory() || existingDist.isSymbolicLink())) throw new Error('Candidate dist path is not a regular generated-output directory');
    const ignored = await execFile('/usr/bin/git', ['-C', nativeWorkspace, 'check-ignore', '--no-index', '--', 'dist/'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 32 * 1024,
    }).then(() => true, () => false);
    if (!ignored) throw new Error('Candidate dist output must be ignored by the registered project Git baseline');
    const backup = path.join(tempRoot, '.previous-dist');
    if (existingDist) await fs.rename(distPath, backup);
    try {
      await fs.cp(path.join(tempRoot, 'dist'), distPath, { recursive: true, errorOnExist: true, force: false, dereference: false });
      const candidateBuild = await buildModule.verifyWebProductionBuild(nativeWorkspace);
      if (candidateBuild.ok !== true || candidateBuild.stale !== false || !candidateBuild.buildIdentity) {
        throw new Error(`Candidate production output verification failed: ${candidateBuild.reason}: ${candidateBuild.detail}`);
      }
      const outputManifest = await captureNoobiDistManifest(nativeWorkspace);
      const outputRecheck = await buildModule.verifyWebProductionBuild(nativeWorkspace);
      if (outputRecheck.ok !== true || outputRecheck.stale !== false || outputRecheck.buildIdentity !== candidateBuild.buildIdentity) {
        throw new Error('Noobi production output changed while its build receipt was being captured');
      }
      if (existingDist) await fs.rm(backup, { recursive: true, force: false });
      return Object.freeze({ noobiProjectId, viteVersion: packageInfo.version, buildIdentity: candidateBuild.buildIdentity,
        candidateSha256, sourceHead, registrySha256, goalVersionId, executionId,
        inputsChecked: candidateBuild.inputsChecked, productionFilesChecked: candidateBuild.productionFilesChecked,
        outputPath: 'dist', outputManifest,
        outputManifestSha256: fingerprint(outputManifest), });
    } catch (error) {
      await fs.rm(distPath, { recursive: true, force: true }).catch(() => {});
      if (existingDist) await fs.rename(backup, distPath).catch(() => {});
      throw error;
    }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

async function captureNoobiDistManifest(candidateRoot) {
  const distRoot = path.join(candidateRoot, 'dist');
  const rootStat = await fs.lstat(distRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await fs.realpath(distRoot) !== distRoot) {
    throw new Error('Noobi production output root is not a canonical directory');
  }
  const manifest = [];
  let totalBytes = 0;
  async function visit(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSafeRegisteredProjectPath('noobi-owl-book-sorter-v1', childRelative)) {
        throw new Error(`Noobi production output path is unsafe: ${childRelative}`);
      }
      const absolute = path.join(directory, entry.name);
      const before = await fs.lstat(absolute);
      if (before.isSymbolicLink() || await fs.realpath(absolute) !== absolute) {
        throw new Error(`Noobi production output contains a symbolic or non-canonical path: ${childRelative}`);
      }
      if (before.isDirectory()) { await visit(absolute, childRelative); continue; }
      if (!before.isFile() || before.nlink !== 1 || before.size > MAX_NOOBI_DIST_FILE_BYTES
        || !/\.(?:html?|js|mjs|css|png|svg|webp|avif|gif|ico|json|woff2?|ttf|otf|txt)$/i.test(childRelative)) {
        throw new Error(`Noobi production output is not an allowed bounded asset: ${childRelative}`);
      }
      const bytes = await fs.readFile(absolute);
      const after = await fs.lstat(absolute);
      totalBytes += bytes.length;
      if (manifest.length >= 256 || totalBytes > MAX_NOOBI_DIST_BYTES || bytes.length !== after.size
        || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs) {
        throw new Error(`Noobi production output changed or exceeded its bounded manifest: ${childRelative}`);
      }
      manifest.push({ path: childRelative, bytes: bytes.length, sha256: sha256(bytes) });
    }
  }
  await visit(distRoot);
  manifest.sort((a, b) => a.path.localeCompare(b.path));
  if (!manifest.some((entry) => entry.path === 'index.html')) throw new Error('Noobi production output manifest has no index.html');
  return manifest;
}

function requireNoobiBinding(binding) {
  officeProjectIdentity({ taskId: binding?.office?.taskId, projectId: binding?.office?.projectId });
  if (typeof binding?.noobi?.projectId !== 'string' || !binding.noobi.projectId
    || typeof binding.noobi?.root !== 'string' || !path.isAbsolute(binding.noobi.root)) {
    throw new Error('Office-to-Noobi project binding is invalid');
  }
}
