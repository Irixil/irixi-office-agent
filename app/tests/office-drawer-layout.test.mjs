import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('左右办公室抽屉共享固定视口内的滚动面板，不受网格相对定位覆盖', () => {
  assert.match(html, /class="task-ledger office-drawer-panel"/);
  assert.match(html, /class="goal-rail office-drawer-panel"/);
  assert.match(css, /\.office-drawer-panel\s*\{[^}]*position:\s*absolute;[^}]*inset:\s*0;[^}]*max-height:\s*100%;[^}]*overflow:\s*auto;/s);
  assert.match(css, /\.task-ledger:not\(\.office-drawer-panel\),\s*\.goal-rail:not\(\.office-drawer-panel\)\s*\{[^}]*position:\s*relative;/s);
});

test('目标版本印章限制长文本，避免 UUID 溢出覆盖目标正文', () => {
  assert.match(css, /\.goal-seal b\s*\{[^}]*max-width:\s*100%;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
});
