// First-run setup: the very first account may be created without signing in, and it is an admin. After that, never.

/** Create the first account when there are no users. Returns {ok: true, user} or {ok: false, status: 409}. */
export async function createFirstAccount({ countUsers, createUser }, { name, email, password }) {
  if ((await countUsers()) !== 0) return { ok: false, status: 409 };
  const user = await createUser({ name, email, password, role: 'admin' });
  return { ok: true, user };
}