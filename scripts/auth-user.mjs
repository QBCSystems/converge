#!/usr/bin/env node
// Create or update a converge login in ASQL. The password is read from the terminal (or stdin), never from an argument.
//   node scripts/auth-user.mjs <email> [--name "Display Name"] [--role owner|admin|maintainer|member|viewer] [--project <name|*>]
//   node scripts/auth-user.mjs <email> --delete      remove the user, its sessions, tokens and memberships
// `--project '*'` makes the role apply to the whole platform (an owner or admin there may administer it). Default: owner on '*'
// for the first user, member of --project otherwise.
import readline from 'node:readline';
import { getAsql } from './lib/asql.mjs';
import { applyMigrations } from './lib/auth/schema.mjs';
import { createUser, findUserByName, addMembership, listMemberships, deleteUser } from './lib/auth/store.mjs';
import { hashPassword } from './lib/auth/core.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? '' : String(args.splice(i, 2)[1] || ''); };
const name = flag('name'), role = flag('role'), project = flag('project');
const remove = args.includes('--delete') && args.splice(args.indexOf('--delete'), 1).length > 0;
const email = args[0];
if (!email || email.startsWith('--')) { console.error('usage: node scripts/auth-user.mjs <email> [--name N] [--role R] [--project P|*] | <email> --delete'); process.exit(2); }

function ask(prompt) {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) { let d = ''; process.stdin.on('data', (c) => { d += c; }).on('end', () => resolve(d.split('\n')[0])); return; }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    rl._writeToOutput = (t) => { if (t.includes(prompt)) process.stderr.write(t); }; // no echo
    rl.question(prompt, (a) => { rl.close(); process.stderr.write('\n'); resolve(a); });
  });
}

const asql = getAsql();
try {
  await applyMigrations(asql);
  if (remove) {
    const removed = await deleteUser(asql, email, { actor: 'auth-user (command line)' });
    if (!removed) throw new Error(`no user ${email}`);
    console.error(`deleted ${removed.email}`);
    process.exit(0);
  }
  const password = await ask('password: ');
  if (password.length < 4) throw new Error('a password is at least 4 characters');
  let user = await findUserByName(asql, email);
  if (user) {
    await asql.run('UPDATE converge_credentials SET hash = ?, updated_at = ? WHERE user_id = ? AND kind = ?', [await hashPassword(password), new Date().toISOString(), user.id, 'password']);
    console.error(`updated the password of ${user.email}`);
  } else {
    user = await createUser(asql, { email, name: name || null, password });
    console.error(`created ${user.email}`);
  }
  const first = (await listMemberships(asql)).length === 0;
  const scope = project || (first ? '*' : '');
  if (scope) { const m = await addMembership(asql, user.id, scope, role || (scope === '*' ? 'owner' : 'member')); console.error(`${m.role} of ${m.project}`); }
} catch (e) {
  console.error(`auth-user: ${e.message}`);
  process.exitCode = 1;
}
process.exit(process.exitCode || 0);
