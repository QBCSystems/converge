// Settings: project name plus the two keys the dashboard can use.
//
// Keys are credentials. They live in sessionStorage by default (gone when the tab closes) and only
// move to localStorage if the user ticks "remember on this device". Keys arriving via the URL are
// moved into storage and stripped from the address bar so they don't end up in history or referrers.

export const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function store(kind) {
  try {
    return window[kind];
  } catch {
    return null; // blocked storage (private mode, sandboxed iframe)
  }
}
const read = (kind, k) => {
  try { return store(kind)?.getItem(k) ?? null; } catch { return null; }
};
const write = (kind, k, v) => {
  try {
    if (v) store(kind)?.setItem(k, v);
    else store(kind)?.removeItem(k);
  } catch { /* storage full or blocked: settings simply won't persist */ }
};

const KEYS = { base: 'converge.base', project: 'converge.project', view: 'converge.viewKey', reviewer: 'converge.reviewerKey', admin: 'converge.adminKey', remember: 'converge.remember', session: 'converge.sessionToken', user: 'converge.user' };

export function loadSettings(location = window.location) {
  const q = new URLSearchParams(location.search);
  const remember = read('localStorage', KEYS.remember) === '1';
  const pick = (param, key) => q.get(param) || read('sessionStorage', key) || (remember ? read('localStorage', key) : '') || '';

  const settings = {
    // No project named anywhere: '' (the sign-in card or the projects page asks), never a made-up one.
    project: q.get('project') || read('localStorage', KEYS.project) || '',
    // '/cloud': the project is on the deployed Worker, reached through this platform (the local dashboard only)
    base: q.get('project') ? '' : read('localStorage', KEYS.base) === '/cloud' ? '/cloud' : '',
    viewKey: pick('key', KEYS.view),
    reviewerKey: pick('reviewer_key', KEYS.reviewer),
    adminKey: pick('admin_key', KEYS.admin),
    sessionToken: pick('token', KEYS.session),
    user: (() => { try { return JSON.parse(read('sessionStorage', KEYS.user) || (remember ? read('localStorage', KEYS.user) : '') || 'null'); } catch { return null; } })(),
    // ?watch=1: a public demo project, watched read-only with no key (the platform decides which)
    watch: q.get('watch') === '1' || read('sessionStorage', 'converge.watch') === '1',
    remember,
  };
  // The admin key opens every view the view key does.
  if (settings.adminKey && !settings.viewKey) settings.viewKey = settings.adminKey;
  if (settings.project && !PROJECT_RE.test(settings.project)) settings.project = '';
  if (settings.watch) write('sessionStorage', 'converge.watch', '1');

  if (q.has('key') || q.has('reviewer_key') || q.has('admin_key')) {
    saveSettings(settings);
    q.delete('key');
    q.delete('reviewer_key');
    q.delete('admin_key');
    const qs = q.toString();
    history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
  }
  return settings;
}

export function saveSettings({ project, base, viewKey, reviewerKey, adminKey, sessionToken, user, remember, watch }) {
  write('sessionStorage', 'converge.watch', watch ? '1' : '');
  write('localStorage', KEYS.project, project);
  write('localStorage', KEYS.base, base || '');
  write('localStorage', KEYS.remember, remember ? '1' : '');
  const userJson = user ? JSON.stringify(user) : '';
  for (const [key, value] of [
    [KEYS.view, viewKey || ''],
    [KEYS.reviewer, reviewerKey || ''],
    [KEYS.admin, adminKey || ''],
    [KEYS.session, sessionToken || ''],
    [KEYS.user, userJson],
  ]) {
    write('sessionStorage', key, value);
    write('localStorage', key, remember ? value : ''); // clears any previously remembered copy
  }
}

/** localStorage for the dashboard's own preferences, never throwing (storage blocked, full or private mode). */
export const local = {
  get: (k) => read('localStorage', k),
  set: (k, v) => write('localStorage', k, v), // '' or null removes it
  getJson: (k, fallback) => { try { return JSON.parse(read('localStorage', k)) ?? fallback; } catch { return fallback; } },
  setJson: (k, v) => write('localStorage', k, JSON.stringify(v)),
};
