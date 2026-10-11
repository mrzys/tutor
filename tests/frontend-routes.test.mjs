import test from 'node:test';
import assert from 'node:assert/strict';
import { readRoute, normalizeRoute, navigateRoute } from '../web/routes.js';

function browser(href) {
  const calls = [];
  const state = { location: new URL(href), calls, history: {} };
  for (const method of ['pushState', 'replaceState']) state.history[method] = (_, __, path) => {
    calls.push({ method, path }); state.location = new URL(path, state.location);
  };
  return state;
}

test('page routes resolve direct links, document IDs, and lists without query parameters', () => {
  for (const [path, screen, id] of [
    ['/', 'requirements'], ['/question-bank', 'question-bank'], ['/question-import', 'question-import'],
    ['/drafts', 'saved'], ['/papers', 'papers'], ['/drafts/a1004be2-df46', 'draft', 'a1004be2-df46'],
    ['/papers/成卷%201', 'paper', '成卷 1'],
  ]) {
    const route = readRoute(new URL(`https://tutor.test${path}`));
    assert.equal(route.screen, screen); assert.equal(route.id, id);
    assert.equal(route.path.includes('?'), false);
  }
  for (const path of ['/missing', '/drafts/a/b', '/drafts/%ZZ', '/drafts/%2F']) {
    assert.equal(readRoute(new URL(`https://tutor.test${path}`)).screen, 'not-found');
  }
});

test('old bookmarks canonicalize before login, preserve question anchors, and respect path precedence', () => {
  for (const [from, to] of [
    ['/?view=question-bank', '/question-bank'], ['/?view=question-import', '/question-import'],
    ['/?draft=draft-1#question-3', '/drafts/draft-1#question-3'], ['/?paper=paper-1', '/papers/paper-1'],
    ['/?paper=p&draft=d', '/papers/p'], ['/question-bank/?draft=d', '/question-bank'],
  ]) {
    const state = browser(`https://tutor.test${from}`);
    normalizeRoute(state);
    assert.deepEqual(state.calls, [{ method: 'replaceState', path: to }]);
    normalizeRoute(state); assert.equal(state.calls.length, 1, 'canonical URLs are stable');
  }
});

test('navigation creates clean history entries and clears stale query/hash state', () => {
  const state = browser('https://tutor.test/drafts/old#question-1');
  navigateRoute('question-bank', undefined, false, state);
  navigateRoute('question-bank', undefined, false, state);
  navigateRoute('draft', 'draft-2', false, state);
  navigateRoute('paper', 'paper-2', true, state);
  navigateRoute('requirements', undefined, false, state);
  assert.deepEqual(state.calls, [
    { method: 'pushState', path: '/question-bank' }, { method: 'replaceState', path: '/question-bank' },
    { method: 'pushState', path: '/drafts/draft-2' }, { method: 'replaceState', path: '/papers/paper-2' },
    { method: 'pushState', path: '/' },
  ]);
});
