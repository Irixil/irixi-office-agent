import fs from 'node:fs/promises';
import path from 'node:path';

export async function readTaskEventHistory(store, taskId, include = () => true) {
  if (typeof store?.taskDir !== 'function') return [];
  let text;
  try { text = await fs.readFile(path.join(store.taskDir(taskId), 'events.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); }
    catch { throw Object.assign(new Error('Saved task event history is damaged.'), { code: 'TASK_EVENT_HISTORY_DAMAGED' }); }
    if (include(event)) events.push(event);
  }
  return events;
}
