const STOPPED_REASON = '本轮澄清已停止；不会自动重试。关闭权限不会重置账本或返还额度。';
const RUNNING_REASON = '本轮只读澄清正在运行或等待权威状态落盘；不能并行发送另一条消息。';
const FAILED_REASON = '上次模型调用失败或未完整结束；本批已停止，不能使用表面剩余额度继续发送。';

export function articleDiscussionBlock({ calls, pendingRun, intakeStatus }) {
  if (!Array.isArray(calls)) throw new Error('Article discussion calls must be an array');
  if (intakeStatus === 'stopped') return { code: 'intake_stopped', reason: STOPPED_REASON };

  const failed = calls.some((call) => {
    if (!call || typeof call !== 'object') return true;
    if (call.status === 'reserved' || call.status === 'running') return call.signal !== null && call.signal !== undefined;
    return call.status !== 'completed' || call.exitCode !== 0 || call.signal !== null;
  });
  if (failed) return { code: 'model_call_failed', reason: FAILED_REASON };

  if (pendingRun || calls.some((call) => call?.status === 'reserved' || call?.status === 'running')) {
    return { code: 'model_call_running', reason: RUNNING_REASON };
  }
  return null;
}

export function describeArticleDiscussion(value, now = Date.now()) {
  if (value.available) return `只读澄清可用，剩余 ${value.remaining} 次${value.deadlineAt ? `，本轮截止 ${value.deadlineAt}` : '，首次发送后开启 20 分钟窗口'}`;
  if (value.sealed) return '只读澄清不可用：批次已封存';
  if (value.remaining === 0) return '只读澄清不可用：额度已用完';
  if (value.deadlineAt && Date.parse(value.deadlineAt) <= now) return '只读澄清不可用：20 分钟窗口已结束';
  if (value.blockedBy) return `只读澄清不可用：${value.reason}`;
  if (!value.enabled) return `只读澄清未开启：${value.reason}`;
  return `只读澄清不可用：${value.reason}`;
}

export const ARTICLE_DISCUSSION_REASONS = Object.freeze({
  stopped: STOPPED_REASON,
  running: RUNNING_REASON,
  failed: FAILED_REASON,
});
