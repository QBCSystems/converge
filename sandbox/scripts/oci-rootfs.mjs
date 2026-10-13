#!/usr/bin/env node
// The sandbox image, built exactly as sandbox-image.sh pushes it (scripts/oci.mjs buildImage: the base's layers plus
// ours), written out as a root filesystem instead of pushed, so it can be run here with no Docker and no root
// (bubblewrap with the directory as /). Layers are applied in order, whiteouts (.wh.*) honoured.
//
//   node sandbox/scripts/oci-rootfs.mjs --base docker.io/library/node:22-bookworm --add <local>:<path> ... \
//     [--env K=V ...] --out <dir>        prints the image's config (entrypoint, env) as JSON to <dir>.config.json
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { buildImage } from '../../scripts/oci.mjs';

const args = { add: [], env: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => argv[++i];
  if (a === '--base') args.base = next();
  else if (a === '--add') args.add.push(next());
  else if (a === '--env') args.env.push(next());
  else if (a === '--entrypoint') args.entrypoint = JSON.parse(next());
  else if (a === '--out') args.out = path.resolve(next());
  else throw new Error(`unknown argument: ${a}`);
}
if (!args.base || !args.out) throw new Error('--base and --out are required');

function walk(dir, prefix, acc) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, `${prefix}/${name}`, acc);
    else acc.push({ path: `${prefix}/${name}`.replace(/^\//, ''), data: fs.readFileSync(full), mode: st.mode & 0o777 });
  }
}
const files = [];
for (const spec of args.add) {
  const at = spec.indexOf(':');
  const local = spec.slice(0, at), target = spec.slice(at + 1).replace(/^\//, '');
  if (fs.statSync(local).isDirectory()) walk(local, target, files);
  else files.push({ path: target, data: fs.readFileSync(local), mode: fs.statSync(local).mode & 0o777 });
}

const image = await buildImage({ base: args.base, files, entrypoint: args.entrypoint, env: args.env.length ? args.env : undefined }, { fetch: globalThis.fetch });
fs.rmSync(args.out, { recursive: true, force: true });
fs.mkdirSync(args.out, { recursive: true });
let total = 0;
for (const layer of image.manifest.layers) {
  const blob = image.blobs.get(layer.digest);
  total += blob.length;
  const tar = zlib.gunzipSync(blob);
  const list = spawnSync('tar', ['-tf', '-'], { input: tar, maxBuffer: 1 << 30, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  for (const entry of list) {
    const base = path.basename(entry), dir = path.dirname(entry);
    if (base === '.wh..wh..opq') { const d = path.join(args.out, dir); if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) fs.rmSync(path.join(d, f), { recursive: true, force: true }); }
    else if (base.startsWith('.wh.')) fs.rmSync(path.join(args.out, dir, base.slice(4)), { recursive: true, force: true });
  }
  // Device nodes cannot be made without root (a base image has none worth having); everything else is extracted.
  const x = spawnSync('tar', ['-xf', '-', '-C', args.out, '--no-same-owner', '--no-same-permissions', '--delay-directory-restore', '--exclude=.wh.*', '--exclude=dev/*'], { input: tar, maxBuffer: 1 << 30, encoding: 'utf8' });
  if (x.status !== 0) process.stderr.write(`layer ${layer.digest.slice(7, 19)}: ${x.stderr.split('\n').slice(0, 3).join(' | ')}\n`);
}
// Directories the platform provides at run time.
for (const d of ['dev', 'proc', 'tmp', 'work', 'root']) fs.mkdirSync(path.join(args.out, d), { recursive: true });
fs.chmodSync(path.join(args.out, 'tmp'), 0o1777);
fs.writeFileSync(`${args.out}.config.json`, JSON.stringify({ ...image.config.config, layers: image.manifest.layers.map((l) => ({ digest: l.digest, size: l.size })), compressed_bytes: total }, null, 1));
console.log(`rootfs at ${args.out}: ${image.manifest.layers.length} layers, ${(total / 1e6).toFixed(1)} MB compressed (ours: ${(image.manifest.layers.at(-1).size / 1e6).toFixed(1)} MB)`);
