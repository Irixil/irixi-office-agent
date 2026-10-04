const VIEWS = new Set(['office', 'desk', 'review', 'connections']);
const SENSITIVE_PARAMS = new Set(['token', 'access_token', 'api_key', 'password']);

export function synchronizedUrl(href, { taskId, view } = {}) {
  const url = new URL(href);
  for (const name of [...url.searchParams.keys()]) {
    if (SENSITIVE_PARAMS.has(name.toLowerCase())) url.searchParams.delete(name);
  }
  if (taskId) url.searchParams.set('task', taskId);
  else url.searchParams.delete('task');
  if (VIEWS.has(view)) url.searchParams.set('view', view);
  else url.searchParams.delete('view');
  return `${url.pathname}${url.search}${url.hash}`;
}
