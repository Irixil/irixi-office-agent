// A successful CLI transport does not make a failed native task successful.
export function nativeDevelopmentOutcome(raw, role) {
  const statuses = [...String(raw).matchAll(/^\s*STATUS:\s*(done|failed)\b/gmi)].map(match => match[1].toLowerCase());
  if (statuses.includes('failed')) return { declaredStatus: 'failed', reasonCode: 'native_declared_failed' };
  if (role === 'developer' && (statuses.length !== 1 || statuses[0] !== 'done')) return { declaredStatus: 'failed', reasonCode: 'native_developer_report_invalid' };
  if (role === 'reviewer') {
    const verdicts = [...String(raw).matchAll(/^\s*(?:\*\*)?VERDICT:(?:\*\*)?\s*(PASS|FAIL)\b/gmi)].map(match => match[1].toUpperCase());
    if (verdicts.length !== 1 || verdicts[0] !== 'PASS') return { declaredStatus: 'failed', reasonCode: 'native_reviewer_not_passed' };
  }
  return { declaredStatus: 'done', reasonCode: null };
}
