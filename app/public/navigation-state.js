const VIEWS = new Set(['office', 'desk', 'review', 'connections']);

export function synchronizedUrl(href, { taskId, view } = {}) {
  const url = new URL(href);
  if (taskId) url.searchParams.set('task', taskId);
  else url.searchParams.delete('task');
  if (VIEWS.has(view)) url.searchParams.set('view', view);
  else url.searchParams.delete('view');
  return `${url.pathname}${url.search}${url.hash}`;
}
