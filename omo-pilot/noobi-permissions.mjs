import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';

// Native CLI tools receive a named filesystem profile. Instructions alone do
// not restrict their read access. Authentication remains inside the CLI host.
const inlineToml = (value) => typeof value === 'object' && value !== null
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${inlineToml(item)}`).join(', ')}}`
  : JSON.stringify(value);

export function noobiPermissionProfiles(codexHome, imageSkillDirectory, jobId) {
  if (!path.isAbsolute(codexHome) || !path.isAbsolute(imageSkillDirectory) || !imageSkillDirectory.startsWith(codexHome + path.sep)) throw new Error('Noobi 图像规则来源无效。');
  if (typeof jobId !== 'string' || !jobId) throw new Error('Noobi 作业身份缺失。');
  const filesystem = { ':root': 'deny', ':minimal': 'read', ':slash_tmp': 'deny', ':tmpdir': 'write', [codexHome]: 'deny', [imageSkillDirectory]: 'read' };
  const suffix = crypto.createHash('sha256').update(jobId).digest('hex').slice(0, 24);
  const workspaceId = `irixi_noobi_${suffix}_workspace`, readOnlyId = `irixi_noobi_${suffix}_readonly`;
  const profiles = {
    [workspaceId]: { extends: ':workspace', filesystem, network: { enabled: false } },
    [readOnlyId]: { extends: ':read-only', filesystem: { ...filesystem, ':workspace_roots': 'read' }, network: { enabled: false } },
  };
  return { workspaceId, readOnlyId, profiles, args: [
    ...Object.entries(profiles).flatMap(([id, profile]) => ['-c', `permissions.${id}=${inlineToml(profile)}`]),
    '-c', `default_permissions=${JSON.stringify(workspaceId)}`,
  ] };
}

// An approval must not silently remove the profile's filesystem boundary.
// Resolve the nearest existing ancestor so a symlink cannot expand a grant.
async function inside(candidate, roots) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  const absolute = path.resolve(candidate); let existing = absolute;
  while (true) {
    try {
      const real = await fs.realpath(existing);
      if (real !== existing) return false;
      return roots.some((root) => absolute === root || absolute.startsWith(root + path.sep));
    } catch (error) {
      if (error.code !== 'ENOENT' || existing === path.dirname(existing)) return false;
      existing = path.dirname(existing);
    }
  }
}
export async function noobiApprovalScopeError(request, { workspace, temporary, imageSkillDirectory }) {
  const params = request.params || {}, readRoots = [workspace, temporary, imageSkillDirectory], writeRoots = [workspace, temporary];
  if (request.method === 'item/fileChange/requestApproval') {
    return await inside(params.grantRoot, writeRoots) ? null : '额外写入范围不在本次项目内。';
  }
  if (!['item/permissions/requestApproval', 'item/commandExecution/requestApproval'].includes(request.method)) return null;
  const grants = request.method === 'item/permissions/requestApproval' ? params.permissions : params.additionalPermissions;
  if (request.method === 'item/commandExecution/requestApproval' && (!grants || !await inside(params.cwd, writeRoots))) return '不能取消本次项目的文件隔离；请在现有权限内执行。';
  if (!grants || typeof grants !== 'object' || Object.keys(grants).some((key) => !['network', 'fileSystem'].includes(key))) return '额外权限范围无法核对。';
  const files = grants.fileSystem;
  if (!files) return null;
  if (typeof files !== 'object' || Object.keys(files).some((key) => !['read', 'write', 'entries', 'globScanMaxDepth'].includes(key))) return '额外文件范围无法核对。';
  for (const [mode, roots] of [['read', readRoots], ['write', writeRoots]]) {
    if (files[mode] != null && !Array.isArray(files[mode])) return '额外文件范围无效。';
    for (const target of files[mode] || []) if (!await inside(target, roots)) return '额外文件范围超出本次项目。';
  }
  if (files.entries != null && !Array.isArray(files.entries)) return '额外文件规则无效。';
  for (const entry of files.entries || []) {
    if (!['read', 'write', 'deny'].includes(entry?.access) || entry.path?.type !== 'path') return '不能扩大到特殊目录或通配范围。';
    if (entry.access !== 'deny' && !await inside(entry.path.path, entry.access === 'write' ? writeRoots : readRoots)) return '额外文件规则超出本次项目。';
  }
  return null;
}
