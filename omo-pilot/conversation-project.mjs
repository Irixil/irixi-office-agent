import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.irixi-data', '.DS_Store']);
export const forbidden = /(?:^|\/)(?:\.codex|\.ssh|\.aws|\.gnupg|\.npmrc|\.netrc|\.pypirc|\.env(?:\.[^/]*)?|credentials?|[^/]+\.(?:pem|key|p12|pfx))(?:\/|$)/iu;
// Bind writes to the actual directory that was selected, not merely a path
// string or matching file hashes. Recheck after every persistence boundary.
export async function directoryIdentity(root) {
  const absolute = path.resolve(root); const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('项目目录身份已变化，未读写替换目录。');
  const canonical = await fs.realpath(absolute); const check = await fs.lstat(absolute);
  if (stat.ino !== check.ino || stat.dev !== check.dev || check.isSymbolicLink()) throw new Error('项目目录身份已变化，未读写替换目录。');
  return { path: absolute, canonical, ino: stat.ino, dev: stat.dev };
}
export async function assertDirectoryIdentity(identity) {
  if (!identity) throw new Error('缺少原目录身份，保留副本，未采用或回滚。');
  const current = await directoryIdentity(identity.path);
  if (current.canonical !== identity.canonical || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('项目目录身份已变化，未读写替换目录。');
  return current;
}
async function prepareDirectory(root) {
  const absolute = path.resolve(root); let ancestor = absolute;
  for (;;) { try { await fs.lstat(ancestor); break; } catch (error) { if (error.code !== 'ENOENT') throw error; ancestor = path.dirname(ancestor); } }
  const anchor = await directoryIdentity(ancestor); let current = ancestor;
  for (const part of path.relative(ancestor, absolute).split(path.sep).filter(Boolean)) {
    await assertDirectoryIdentity(anchor); current = path.join(current, part);
    await fs.mkdir(current).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const identity = await directoryIdentity(current);
    if (identity.canonical !== path.join(anchor.canonical, path.relative(ancestor, current))) throw new Error('复制目标目录已变化，未继续写入。');
  }
  await assertDirectoryIdentity(anchor); return directoryIdentity(absolute);
}
export async function fileIndex(root, expectedIdentity, { dataFiles } = {}) {
  const identity = expectedIdentity || await directoryIdentity(root); await assertDirectoryIdentity(identity);
  const result = {};
  async function walk(dir, rel = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (ignored.has(entry.name) || forbidden.test(entry.name)) continue;
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = await fs.lstat(full);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) throw new Error(`项目含链接文件，尚未复制或覆盖：${key}`);
      if (stat.isDirectory()) await walk(full, key);
      else if (stat.isFile()) {
        const database = key.replace(/-(?:wal|shm)$/u, '');
        if (/\.(?:db|sqlite|sqlite3)$/iu.test(database)) {
          const dbStat = await fs.lstat(path.join(root, database)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (dbStat && (!dbStat.isFile() || dbStat.isSymbolicLink() || dbStat.nlink > 1)) throw new Error(`数据库路径含链接或不是普通文件：${database}`);
          const db = await fs.open(path.join(root, database)).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
          if (db) {
            let header;
            try { header = Buffer.alloc(16); await db.read(header, 0, 16, 0); } finally { await db.close(); }
            if (header.toString() === 'SQLite format 3\0') { if (database === key) dataFiles?.push(key); continue; }
          }
        }
        result[key] = hash(await fs.readFile(full));
      }
    }
  }
  await walk(root); await assertDirectoryIdentity(identity); return result;
}

export async function copyProject(source, target, index) {
  const sourceIdentity = await directoryIdentity(source); const targetIdentity = await prepareDirectory(target);
  for (const name of Object.keys(index)) {
    await assertDirectoryIdentity(sourceIdentity); await safeParents(source, name, sourceIdentity, false);
    await safeParents(target, name, targetIdentity);
    const sourceFile = path.join(source, name), dest = path.join(target, name);
    if (await fileHash(sourceFile) !== index[name]) throw new Error('复制期间源文件变化，未确认副本。');
    await fileHash(dest); // Reject an existing symlink or hardlink before copy.
    await assertDirectoryIdentity(sourceIdentity); await assertDirectoryIdentity(targetIdentity);
    await fs.copyFile(sourceFile, dest);
    await assertDirectoryIdentity(targetIdentity);
    if (await fileHash(dest) !== index[name]) throw new Error('复制期间文件变化，未确认副本。');
  }
  await assertDirectoryIdentity(sourceIdentity); await assertDirectoryIdentity(targetIdentity);
}

export async function rollbackAdoption(turn) {
  const commit = turn.commit;
  if (!commit || commit.status !== 'applying') return;
  if (commit.scheme === 'preserve-displaced-v1') return restoreDisplaced(turn);
  const conflicts = [];
  const owned = new Set(commit.applied);
  if (commit.pending) {
    const pending = commit.pending;
    if (pending.removed) { try { await fs.access(pending.removed); owned.add(pending.name); } catch {} }
    else {
      try { const stat = await fs.stat(path.join(commit.root, pending.name)); if (stat.ino === pending.ino && stat.dev === pending.dev) owned.add(pending.name); } catch {}
    }
  }
  for (const name of owned) {
    const target = path.join(commit.root, name);
    let digest = null;
    try { digest = hash(await fs.readFile(target)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (digest === (turn.before[name] || null)) continue;
    if (digest !== (commit.after[name] || null)) { conflicts.push(name); continue; }
    if (turn.before[name]) {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(path.join(commit.backup, name), target);
    } else await fs.unlink(target).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
  commit.status = conflicts.length ? 'recovery_conflict' : 'rolled_back'; commit.conflicts = conflicts;
}

export const sameIndex = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((name) => a[name] === b[name]);
export async function fileHash(filename) {
  try { const stat = await fs.lstat(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('文件类型已变化，未覆盖。'); return hash(await fs.readFile(filename)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function safeParents(root, name, identity, create = true) {
  await assertDirectoryIdentity(identity);
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/u).includes('..') || forbidden.test(name)) throw new Error('项目修改路径无效。');
  let current = root;
  for (const part of name.split('/').slice(0, -1)) {
    current = path.join(current, part);
    try { const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('项目目录被替换，未覆盖。'); }
    catch (error) { if (error.code !== 'ENOENT' || !create) throw error; await assertDirectoryIdentity(identity); await fs.mkdir(current); }
  }
  await assertDirectoryIdentity(identity);
}
async function exists(filename) { try { await fs.lstat(filename); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

// Restore only files still owned by this transaction. A concurrent human file
// wins; displaced bytes remain beside the journal for explicit reconciliation.
async function restoreDisplaced(record) {
  const c = record.commit;
  try { return await restoreInOriginalDirectory(record); }
  catch (error) { c.status = 'recovery_conflict'; c.conflicts = [...new Set([...(c.conflicts || []), '.'])]; c.recoveryError = error.message; }
}
async function restoreInOriginalDirectory(record) {
  const c = record.commit; await assertDirectoryIdentity(c.rootIdentity); const conflicts = [];
  const entries = [...(c.entries || [])];
  for (const entry of entries.reverse()) {
    if (!entry.started) continue;
    await assertDirectoryIdentity(c.rootIdentity);
    const target = path.join(c.root, entry.name);
    // A crash can occur after link(temp,target), before unlink(temp). Break
    // only that owned extra link before the normal no-hardlinks inspection.
    if (entry.temp) {
      const [tempStat, targetStat] = await Promise.all([fs.lstat(entry.temp).catch(() => null), fs.lstat(target).catch(() => null)]);
      if (tempStat && targetStat && tempStat.ino === targetStat.ino && tempStat.dev === targetStat.dev && !tempStat.isSymbolicLink()) { await assertDirectoryIdentity(c.rootIdentity); await fs.unlink(entry.temp); entry.temp = null; }
    }
    await assertDirectoryIdentity(c.rootIdentity);
    const current = await fileHash(target);
    const displacedExists = entry.displaced && await exists(entry.displaced);
    if (!displacedExists && current === (record.before[entry.name] || null)) continue;
    if (current !== null && current !== (c.after[entry.name] || null)) { conflicts.push(entry.name); continue; }
    if (current !== null) {
      const currentStat = await fs.lstat(target);
      if (entry.tempIno && (currentStat.ino !== entry.tempIno || currentStat.dev !== entry.tempDev)) { conflicts.push(entry.name); continue; }
      await safeParents(c.root, entry.name, c.rootIdentity);
      const reclaimed = path.join(c.backup, `rollback-displaced-${crypto.randomUUID()}`);
      await fs.rename(target, reclaimed);
      const reclaimedStat = await fs.lstat(reclaimed);
      if (await fileHash(reclaimed) !== current || entry.tempIno && (reclaimedStat.ino !== entry.tempIno || reclaimedStat.dev !== entry.tempDev)) {
        // A user replaced the path after the check. Keep those exact bytes and
        // publish only if the user has not already created another newer file.
        const rescue = path.join(c.backup, `rescue-${crypto.randomUUID()}`);
        await fs.copyFile(reclaimed, rescue);
        await assertDirectoryIdentity(c.rootIdentity);
        try { await fs.link(rescue, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        finally { await fs.unlink(rescue); }
        conflicts.push(entry.name); continue;
      }
    }
    if (displacedExists) {
      await safeParents(c.root, entry.name, c.rootIdentity);
      // link is an atomic no-overwrite publication. Never rename over a file
      // created by the user during an asynchronous save or recovery.
      const restore = path.join(c.backup, `restore-${crypto.randomUUID()}`);
      await fs.copyFile(entry.displaced, restore);
      await assertDirectoryIdentity(c.rootIdentity);
      try { await fs.link(restore, target); }
      catch (error) { if (error.code === 'EEXIST') conflicts.push(entry.name); else throw error; }
      finally { await fs.unlink(restore); }
    }
  }
  for (const entry of entries) if (entry.temp) {
    await assertDirectoryIdentity(c.rootIdentity);
    const stat = await fs.lstat(entry.temp).catch(() => null);
    if (stat && stat.ino === entry.tempIno && stat.dev === entry.tempDev && !stat.isSymbolicLink()) { await assertDirectoryIdentity(c.rootIdentity); await fs.unlink(entry.temp); }
  }
  c.status = conflicts.length ? 'recovery_conflict' : 'rolled_back'; c.conflicts = conflicts;
}

export async function applyProjectDelta(record, { root, candidate, before, directory, save, signal, rootIdentity: expectedIdentity }) {
  if (record.commit?.status === 'committed') return record.commit;
  const rootIdentity = expectedIdentity || await directoryIdentity(root); await assertDirectoryIdentity(rootIdentity);
  const after = await fileIndex(candidate);
  if (!sameIndex(await fileIndex(root, rootIdentity), before)) throw new Error('采用前发现项目变化，原文件未覆盖。');
  const changed = Object.keys(after).filter((n) => before[n] !== after[n]);
  const deleted = Object.keys(before).filter((n) => !Object.hasOwn(after, n));
  const backup = path.join(directory, 'before-adoption'); await copyProject(root, backup, before);
  if (!sameIndex(await fileIndex(backup), before)) throw new Error('原项目在保存采用备份时变化，未覆盖。');
  record.before = before;
  record.commit = { scheme: 'preserve-displaced-v1', status: 'applying', root, rootIdentity, backup, changed, deleted, after, applied: [], entries: [] };
  await save();
  try {
    for (const name of [...changed, ...deleted]) {
      if (signal?.aborted || record.stopRequestedAt) throw new Error('已停止采用，工作副本保留。');
      await safeParents(root, name, rootIdentity);
      const target = path.join(root, name);
      const displaced = path.join(directory, 'displaced', name); await fs.mkdir(path.dirname(displaced), { recursive: true });
      const temp = path.join(path.dirname(target), `.irixi-${crypto.randomUUID()}.tmp`);
      const entry = { name, temp: after[name] ? temp : null, displaced: before[name] ? displaced : null, started: false };
      record.commit.entries.push(entry);
      if (after[name]) {
        await fs.copyFile(path.join(candidate, name), temp, 1);
        if (await fileHash(temp) !== after[name]) throw new Error('候选文件在采用期间变化。');
        const tempStat = await fs.stat(temp); entry.tempIno = tempStat.ino; entry.tempDev = tempStat.dev;
      }
      entry.started = true; record.commit.pending = { name }; await save();
      if (signal?.aborted || record.stopRequestedAt) throw new Error('已停止采用。');
      await safeParents(root, name, rootIdentity);
      if (await fileHash(target) !== (before[name] || null)) throw new Error(`采用前发现文件已被修改：${name}。`);
      await assertDirectoryIdentity(rootIdentity);
      if (before[name]) {
        await fs.rename(target, displaced);
        if (await fileHash(displaced) !== before[name]) throw new Error(`采用期间发现新内容：${name}。`);
      }
      await assertDirectoryIdentity(rootIdentity);
      if (after[name]) { await fs.link(temp, target); await fs.unlink(temp); entry.temp = null; }
      record.commit.applied.push(name); record.commit.pending = null; await save();
    }
    if (signal?.aborted || record.stopRequestedAt) throw new Error('已停止采用。');
    if (!sameIndex(await fileIndex(root, rootIdentity), after)) throw new Error('采用期间项目发生新变化，未确认旧检查结果。');
    record.commit.status = 'committed'; await save(); return record.commit;
  } catch (error) {
    record.commit.status = 'applying'; await restoreDisplaced(record);
    try { await save(); } catch {} throw error;
  }
}

// git merge-file is a plain three-file merge and never creates or alters a Git
// repository. The same path therefore works for ordinary folders and Git trees.
export async function mergeProjectTrees({ base, ours, theirs, target }) {
  const [b, o, t] = await Promise.all([fileIndex(base), fileIndex(ours), fileIndex(theirs)]);
  await fs.mkdir(target, { recursive: true });
  const conflicts = [];
  for (const name of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
    let source;
    if (o[name] === t[name] || t[name] === b[name]) source = o[name] ? path.join(ours, name) : null;
    else if (o[name] === b[name]) source = t[name] ? path.join(theirs, name) : null;
    else {
      const values = await Promise.all([ours, base, theirs].map(async (dir) => { try { return await fs.readFile(path.join(dir, name)); } catch (e) { if (e.code === 'ENOENT') return Buffer.alloc(0); throw e; } }));
      if (!o[name] || !t[name] || values.some((v) => v.includes(0))) {
        conflicts.push({ path: name, kind: 'delete-or-binary', conflictHash: o[name] || t[name] || hash(Buffer.alloc(0)), base: path.join(base, name), ours: path.join(ours, name), theirs: path.join(theirs, name) });
        source = o[name] ? path.join(ours, name) : t[name] ? path.join(theirs, name) : null;
      } else {
        const temp = await fs.mkdtemp(path.join(path.dirname(target), 'merge-input-'));
        try {
          const files = ['ours', 'base', 'theirs'].map((x) => path.join(temp, x));
          await Promise.all(files.map((f, i) => fs.writeFile(f, values[i])));
          const result = spawnSync('/usr/bin/git', ['merge-file', '-p', '-L', 'candidate', '-L', 'common-baseline', '-L', 'incoming', ...files], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
          if (result.error || result.status === null || result.status < 0 || result.status > 127) throw new Error('三方组合未成功；全部副本保留，原项目未修改。');
          await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true });
          await fs.writeFile(path.join(target, name), result.stdout);
          if (result.status > 0) conflicts.push({ path: name, kind: 'text', base: path.join(base, name), ours: path.join(ours, name), theirs: path.join(theirs, name), conflictHash: hash(result.stdout) });
        } finally { await fs.rm(temp, { recursive: true, force: true }); }
        continue;
      }
    }
    if (source) { await fs.mkdir(path.dirname(path.join(target, name)), { recursive: true }); await fs.copyFile(source, path.join(target, name)); }
  }
  return { index: await fileIndex(target), conflicts };
}
