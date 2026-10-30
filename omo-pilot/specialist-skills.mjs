import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const LEARNING_SOURCES = Object.freeze({
  skill: path.join(os.homedir(), '.codex/skills/learning-dialogue/SKILL.md'),
  rules: path.join(os.homedir(), '.codex/AGENTS.md'),
});
const rulesHeading = '讨论、解释与纠错的约束';

async function sourceText(filename) {
  const resolved = path.resolve(filename);
  if (await fs.realpath(resolved) !== resolved) throw new Error('指定学习规则含链接，尚未装载。');
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024) throw new Error('指定学习规则不是允许大小的普通文件。');
    const text = await handle.readFile('utf8');
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || Buffer.byteLength(text) > 128 * 1024) throw new Error('学习规则读取期间已变化，请在下一轮重试。');
    if (!text.trim()) throw new Error('指定学习规则为空，尚未装载。');
    return text;
  } finally { await handle.close(); }
}

function headingSection(text, title) {
  const lines = text.split(/\r?\n/u);
  let start = -1, end = lines.length, level;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(lines[i]);
    if (!heading) continue;
    if (start < 0 && heading[2] === title) { start = i; level = heading[1].length; }
    else if (start >= 0 && heading[1].length <= level) { end = i; break; }
  }
  if (start < 0) throw new Error('学习 Skill 依赖的讨论规则标题不存在，尚未装载。');
  return lines.slice(start, end).join('\n').trim();
}

function validateSnapshot(snapshot) {
  if (snapshot.id !== 'learning-dialogue' || snapshot.sources?.length !== 2 ||
      snapshot.sources.some((s) => typeof s.text !== 'string' || hash(s.text) !== s.sha256) ||
      hash(JSON.stringify(snapshot.sources.map(({ text, ...s }) => s))) !== snapshot.version) {
    throw new Error('本轮学习规则快照不完整，未改用其他版本。');
  }
  return snapshot;
}

// Only the selected skill and one named dependency section are supplied. Links
// inside them do not recursively grant access to any other skill or file.
export async function captureLearningSkill(directory, sources = LEARNING_SOURCES) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'learning-dialogue.json');
  let snapshot;
  try { snapshot = validateSnapshot(JSON.parse(await fs.readFile(filename, 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const skill = await sourceText(sources.skill);
    const rules = headingSection(await sourceText(sources.rules), rulesHeading);
    const fragments = [
      { path: sources.skill, section: 'full', text: skill },
      { path: sources.rules, section: rulesHeading, text: rules },
    ].map((s) => ({ ...s, sha256: hash(s.text) }));
    snapshot = { id: 'learning-dialogue', capturedAt: new Date().toISOString(), sources: fragments,
      version: hash(JSON.stringify(fragments.map(({ text, ...s }) => s))) };
    const temporary = path.join(directory, `${crypto.randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(snapshot, null, 2), { flag: 'wx', mode: 0o600 });
      // Publish complete bytes without replacing a concurrent sibling's version.
      try { await fs.link(temporary, filename); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        snapshot = validateSnapshot(JSON.parse(await fs.readFile(filename, 'utf8')));
      }
    } finally { await fs.unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { ...snapshot, snapshotPath: filename };
}

export async function readLearningSnapshot(record) {
  const snapshot = validateSnapshot(JSON.parse(await fs.readFile(record.snapshotPath, 'utf8')));
  if (snapshot.version !== record.version) throw new Error('本轮学习规则快照版本变化，未继续执行。');
  return snapshot;
}

export function learningSkillPrompt(snapshot) {
  return `本轮已受控装载 learning-dialogue（版本 ${snapshot.version}）。以下是指定 Skill 及其所需讨论规则的完整快照，无需再读取原文件。其他链接仅为来源，不授予读取其他文件、Skill或外部服务的权限。按当前任务适用这些规则；普通执行不转为教学。当前任务的讨论/执行权限和返回格式继续有效。\n<learning_skill_snapshot>\n${snapshot.sources.map((s) => s.text).join('\n\n')}\n</learning_skill_snapshot>\n`;
}
