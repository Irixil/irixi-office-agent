import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { executeConversationCommand } from './conversation-command.mjs';

// config is validated at the application descriptor boundary. These commands
// prepare one private project copy; their success is not behavioral acceptance.
export async function prepareApplication(root, { config, networkHosts = [], signal, registryPath, onUpdate } = {}) {
  root = await fs.realpath(root);
  const dataRoot = path.join(root, '.irixi-data'); await fs.mkdir(dataRoot, { recursive: true });
  if (!(await fs.lstat(dataRoot)).isDirectory() || await fs.realpath(dataRoot) !== dataRoot) throw new Error('项目数据目录已被替换，未准备环境。');
  const environment = Object.fromEntries(Object.entries(config.env || {}).map(([key, value]) => [key, value.replaceAll('${IRIXI_DATA_DIR}', dataRoot)]));
  environment.IRIXI_DATA_DIR = dataRoot;
  const steps = [];
  for (const kind of ['install', 'build']) {
    if (!config[kind]) continue;
    const startedAt = new Date().toISOString();
    const result = await executeConversationCommand({ command: config[kind], timeout: 600 }, { root, environment, networkHosts, signal, registryPath, onUpdate });
    steps.push({ kind, command: config[kind], startedAt, finishedAt: new Date().toISOString(), ...result.details });
    if (result.isError) return { status: 'failed', steps };
  }
  return { status: 'prepared', steps };
}

// Single-file consistent SQLite snapshot. The caller owns directory selection;
// source identity is rechecked because it can change after descriptor validation.
export async function copySQLiteData(source, target, { signal } = {}) {
  source = path.resolve(source); target = path.resolve(target);
  let before; try { before = await fs.lstat(source); } catch (error) { if (error.code === 'ENOENT') throw new Error(`SQLite 数据源不存在，未生成空库：${source}`); throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || await fs.realpath(source) !== source) throw new Error('SQLite 数据源含链接或不是普通文件，未复制。');
  await fs.mkdir(path.dirname(target), { recursive: true });
  if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) throw new Error('SQLite 数据目标目录含链接，未复制。');
  let existing; try { existing = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1) throw new Error('已有 SQLite 数据目标含链接或不是普通文件，未覆盖。');
    return { status: 'existing', source, target };
  }
  const temporary = await fs.mkdtemp(path.join(path.dirname(target), '.irixi-db-backup-'));
  const candidate = path.join(temporary, 'snapshot.sqlite');
  try {
    const script = `import sqlite3,sys,pathlib,json\nsource=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro',uri=True,timeout=10)\ntarget=sqlite3.connect(sys.argv[2])\ntry:\n source.backup(target)\n target.execute('PRAGMA journal_mode=DELETE')\n result=target.execute('PRAGMA integrity_check').fetchall()\n if result != [('ok',)]: raise RuntimeError('SQLite integrity_check failed: '+repr(result))\n print(json.dumps({'integrity':'ok','tables':[row[0] for row in target.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]}))\nfinally:\n target.close();source.close()\n`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/python3', ['-I', '-B', '-c', script, source, candidate], { signal, timeout: 30000, env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', PYTHONNOUSERSITE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (value) => { stdout += value; }); child.stderr.on('data', (value) => { stderr += value; });
      child.once('error', reject); child.once('close', (exitCode, exitSignal) => resolve({ exitCode, signal: exitSignal, stdout, stderr }));
    });
    if (result.exitCode !== 0) throw new Error(`SQLite 一致备份失败，原数据未改：${result.stderr.trim() || (result.signal ? `备份进程因 ${result.signal} 退出（30秒内未完成）` : '备份进程未正常完成')}`);
    const after = await fs.lstat(source);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.dev !== before.dev || after.ino !== before.ino || await fs.realpath(source) !== source) throw new Error('SQLite 数据源在备份期间被替换，未采用副本。');
    try { await fs.link(candidate, target); }
    catch (error) { if (error.code !== 'EEXIST') throw error; return { status: 'existing', source, target }; }
    return { status: 'copied', source, target, ...JSON.parse(result.stdout) };
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
