// Browser page addresses. API filters remain query parameters on /api routes.
export function routePath(screen, id) {
  if (screen === 'draft' || screen === 'paper') {
    if (!id) throw new Error('打开草稿或成卷需要 ID。');
    return `/${screen === 'draft' ? 'drafts' : 'papers'}/${encodeURIComponent(id)}`;
  }
  return ({ requirements: '/', 'question-bank': '/question-bank', 'question-import': '/question-import', saved: '/drafts', papers: '/papers' })[screen] ?? '/';
}

export function readRoute(location) {
  const url = new URL(location.href);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const screens = { '/': 'requirements', '/question-bank': 'question-bank', '/question-import': 'question-import', '/drafts': 'saved', '/papers': 'papers' };
  let route = { screen: screens[pathname] ?? 'not-found' };
  const document = pathname.match(/^\/(drafts|papers)\/([^/]+)$/);
  if (document) {
    try {
      const id = decodeURIComponent(document[2]);
      if (id && !/[\/\\\u0000]/.test(id)) route = { screen: document[1] === 'drafts' ? 'draft' : 'paper', id };
    } catch { /* Malformed encoded paths render the not-found screen. */ }
  }
  // Only the former root URL accepts legacy page parameters.
  if (pathname === '/') {
    const paper = url.searchParams.get('paper');
    const draft = url.searchParams.get('draft');
    const view = url.searchParams.get('view');
    if (paper) route = { screen: 'paper', id: paper };
    else if (draft) route = { screen: 'draft', id: draft };
    else if (['question-bank', 'question-import'].includes(view)) route = { screen: view };
  }
  return { ...route, path: route.screen === 'not-found' ? pathname : routePath(route.screen, route.id) };
}

export function normalizeRoute(browser = window) {
  const route = readRoute(browser.location);
  const target = route.path + browser.location.hash;
  if (browser.location.pathname + browser.location.search + browser.location.hash !== target) {
    browser.history.replaceState({}, '', target);
  }
  return route;
}

export function navigateRoute(screen, id, replace = false, browser = window) {
  const path = routePath(screen, id);
  // Reopening the same page should not add duplicate Back entries.
  browser.history[replace || browser.location.pathname === path ? 'replaceState' : 'pushState']({}, '', path);
}
