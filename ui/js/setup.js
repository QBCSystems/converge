// First-run setup helpers for the dashboard. Pure functions: no DOM access at import time.

/** Which screen to show: the projects page for a signed-in user, else setup on a fresh install, else sign-in. */
export function screenFor({ needsSetup, user } = {}) {
  if (user) return 'projects';
  return needsSetup === true ? 'setup' : 'signin';
}

/** The trimmed setup request body, or null when any field is empty. */
export function setupBody({ name, email, password } = {}) {
  const body = {
    name: String(name ?? '').trim(),
    email: String(email ?? '').trim(),
    password: String(password ?? '').trim(),
  };
  return body.name && body.email && body.password ? body : null;
}