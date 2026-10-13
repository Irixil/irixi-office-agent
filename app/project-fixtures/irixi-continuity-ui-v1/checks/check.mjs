import crypto from 'node:crypto';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const esc = (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function task({ status = 'idle', stopReason = null, needsUserDecision = false, activeJob = null, confirmed = false } = {}) {
  return Object.freeze({
    status,
    execution: stopReason ? Object.freeze({ stopReason }) : null,
    runtime: activeJob ? Object.freeze({ activeJob: Object.freeze(activeJob) }) : null,
    continuity: Object.freeze({
      candidate: confirmed ? Object.freeze({ confirmed: true }) : null,
      progress: Object.freeze({
        done: Object.freeze(['<done&>']),
        incomplete: Object.freeze(['<incomplete&>']),
        stoppedBecause: '<stop&>',
        nextStep: '<next&>',
        needsUserDecision,
      }),
    }),
  });
}

function exactHtml(input, badge, tone) {
  const value = input.continuity;
  const list = (items, empty) => items.length ? `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>` : `<p class="field-note">${esc(empty)}</p>`;
  const activeJob = input.runtime?.activeJob;
  const busyText = activeJob?.kind === 'planning' ? '正在形成计划，等待本次规划结果。'
    : activeJob?.kind === 'conversation' ? '正在回复当前对话，完成后会写回同一任务。'
      : activeJob ? '正在处理当前工作，完成后会写回同一任务。' : null;
  const incomplete = busyText ? [busyText, ...value.progress.incomplete] : value.progress.incomplete;
  const stoppedBecause = busyText ? '当前正在工作，没有停下。' : value.progress.stoppedBecause || '没有停下，当前记录可以继续。';
  const nextStep = busyText || value.progress.nextStep;
  return `<div class="continuity-grid"><div><strong>已经做成</strong>${list(value.progress.done, '还没有完成且仍有效的步骤。')}</div><div><strong>尚未完成</strong>${list(incomplete, '当前没有未完成步骤。')}</div><div><strong>为什么停下</strong><p>${esc(stoppedBecause)}</p></div><div><strong>下一步</strong><p>${esc(nextStep)}</p><span class="record-status" data-tone="${tone}">${badge}</span></div></div>`;
}

function fixtureCase(id, input, badge, tone) {
  return Object.freeze({ id, input, expected: sha256(exactHtml(input, badge, tone)) });
}

const cases = [
  fixtureCase('idle-can-continue', task(), 'Irixi 可继续', 'good'),
  fixtureCase('recoverable-partial-can-continue', task({ status: 'partial', stopReason: 'retryable_error' }), 'Irixi 可继续', 'good'),
  fixtureCase('recoverable-cancelled-can-continue', task({ status: 'cancelled', stopReason: 'cancelled_by_user' }), 'Irixi 可继续', 'good'),
  fixtureCase('planning-busy-priority', task({ status: 'failed', stopReason: 'budget_exhausted', activeJob: { kind: 'planning' } }), '正在工作', 'active'),
  fixtureCase('confirmed-download-priority', task({ status: 'ready_to_export', stopReason: 'budget_exhausted', confirmed: true }), '可以下载', 'good'),
  fixtureCase('needs-user-decision-priority', task({ status: 'waiting_user', stopReason: 'permanent_error', needsUserDecision: true }), '需要你的决定', 'bad'),
];

for (const stopReason of ['budget_exhausted', 'permanent_error', 'same_error_exhausted']) {
  for (const status of ['failed', 'partial', 'cancelled', 'cancellation_unknown']) {
    cases.push(fixtureCase(`${stopReason}-${status}-blocked`, task({ status, stopReason }), '需要先处理', 'bad'));
  }
  cases.push(fixtureCase(`${stopReason}-idle-not-blocked`, task({ status: 'idle', stopReason }), 'Irixi 可继续', 'good'));
}

cases.push(fixtureCase('project_verification_failed-partial-blocked', task({ status: 'partial', stopReason: 'project_verification_failed' }), '需要先处理', 'bad'));
cases.push(fixtureCase('project_transaction_failed-partial-blocked', task({ status: 'partial', stopReason: 'project_transaction_failed' }), '需要先处理', 'bad'));

export const contract = Object.freeze({
  id: 'render-continuity-terminal-state-v1',
  exportName: 'renderContinuity',
  resultType: 'string',
  cases: Object.freeze(cases),
});
