#!/usr/bin/env node
// Minimal OCI/Docker image builder and pusher. No Docker, no npm: node builtins only.
//
//   node scripts/oci.mjs push --base node:22-bookworm --add ./runner/runner.mjs:/runner/runner.mjs \
//     --entrypoint '["node","/runner/runner.mjs"]' --env NODE_ENV=production --to registry.cloudflare.com/abc/img:latest
//
// Exports: parseRef, tarLayer, buildImage, pushImage.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const DOCKER_INDEX = 'application/vnd.docker.distribution.manifest.list.v2+json';
const DOCKER_MANIFEST = 'application/vnd.docker.distribution.manifest.v2+json';
const DOCKER_CONFIG = 'application/vnd.docker.container.image.v1+json';

const MANIFEST_TYPES = new Set([OCI_MANIFEST, DOCKER_MANIFEST]);
const INDEX_TYPES = new Set([OCI_INDEX, DOCKER_INDEX]);
const CONFIG_TYPES = new Set([OCI_CONFIG, DOCKER_CONFIG]);

const PLATFORM = { os: 'linux', architecture: 'amd64' };

// ---------- digests ----------

function sha256(buf) {
  return 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');
}

function hexOf(digest) {
  const i = digest.indexOf(':');
  return i === -1 ? digest : digest.slice(i + 1);
}

// ---------- references ----------

// parseRef('node:22') / parseRef('docker.io/library/node:22-bookworm') /
// parseRef('registry.cloudflare.com/abc/img') -> { registry, repository, tag }
// The registry returned for docker.io is registry-1.docker.io (the API host).
export function parseRef(ref) {
  if (typeof ref !== 'string' || ref.length === 0) throw new Error('parseRef: empty reference');
  let rest = ref;
  let registry = '';

  // A registry host is present when the first path component has a '.' or ':',
  // or is exactly 'localhost'.
  const slash = rest.indexOf('/');
  if (slash !== -1) {
    const first = rest.slice(0, slash);
    if (first === 'localhost' || first.includes('.') || first.includes(':')) {
      registry = first;
      rest = rest.slice(slash + 1);
    }
  }

  // tag: after the last ':' that is not part of a registry/port.
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon !== -1 && rest.indexOf('/') < colon) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }

  let repository = rest;
  if (!registry || registry === 'docker.io' || registry === 'index.docker.io') {
    registry = 'registry-1.docker.io';
    if (!repository.includes('/')) repository = 'library/' + repository;
  }

  if (!repository) throw new Error('parseRef: empty repository in ' + ref);
  return { registry, repository, tag };
}

// ---------- tar ----------

const BLOCK = 512;

function octal(value, len) {
  const s = value.toString(8);
  // len includes a trailing NUL for most fields; terminate with NUL.
  const digits = len - 1;
  if (s.length > digits) throw new Error('octal field overflow: ' + value);
  return '0'.repeat(digits - s.length) + s + '\0';
}

function writeString(buf, offset, str, len) {
  const b = Buffer.from(str, 'utf8');
  if (b.length > len) throw new Error('field too long: ' + str);
  b.copy(buf, offset);
}

function header({ name, mode, size, type }) {
  const buf = Buffer.alloc(BLOCK, 0);
  // ustar header layout (POSIX.1-1988)
  writeString(buf, 0, name, 100);
  writeString(buf, 100, octal(mode & 0o7777, 8), 8);
  writeString(buf, 108, octal(0, 8), 8); // uid
  writeString(buf, 116, octal(0, 8), 8); // gid
  writeString(buf, 124, octal(size, 12), 12); // size
  writeString(buf, 136, octal(0, 12), 12); // mtime 0 (deterministic)
  // checksum (148..155) is spaces while computing
  for (let i = 148; i < 156; i++) buf[i] = 0x20;
  buf[156] = type === 'dir' ? 0x35 /* '5' */ : 0x30 /* '0' */;
  // linkname 157..256 empty
  writeString(buf, 257, 'ustar\0', 8); // magic + NUL
  writeString(buf, 265, '00', 2); // version
  // uname/gname empty (297, 329), devmajor/minor (329, 337) left zero
  for (let i = 329; i < 337; i++) buf[i] = 0x30;
  for (let i = 337; i < 345; i++) buf[i] = 0x30;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  writeString(buf, 148, octal(sum, 7) + ' ', 8);
  return buf;
}

function padTo(n, block) {
  const rem = n % block;
  return rem === 0 ? 0 : block - rem;
}

// tarLayer([{ path, data, mode }]) -> Buffer: deterministic ustar archive with the
// parent directories each entry needs (mode 0755), in the order given after their dirs.
export function tarLayer(entries) {
  const out = [];
  const added = new Set();
  let total = 0;
  const zero = Buffer.alloc(BLOCK, 0);

  function addDir(dir) {
    if (!dir || dir === '.' || dir === '/' || added.has(dir)) return;
    // Add ancestors first so they are always preceded by their parents.
    const slash = dir.lastIndexOf('/');
    if (slash > 0) addDir(dir.slice(0, slash));
    if (added.has(dir)) return;
    added.add(dir);
    out.push(header({ name: dir + '/', mode: 0o755, size: 0, type: 'dir' }));
    total += BLOCK;
  }

  for (const entry of entries) {
    const p = String(entry.path).replace(/^\.\//, '').replace(/^\//, '');
    if (!p) throw new Error('tarLayer: empty path');
    const idx = p.lastIndexOf('/');
    if (idx > 0) addDir(p.slice(0, idx));
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '');
    out.push(header({ name: p, mode: entry.mode ?? 0o644, size: data.length, type: 'file' }));
    out.push(data);
    const pad = padTo(data.length, BLOCK);
    if (pad) out.push(zero.slice(0, pad));
    total += BLOCK + data.length + pad;
  }

  out.push(zero); // first trailing zero block
  out.push(zero); // second trailing zero block
  total += BLOCK * 2;

  const buf = Buffer.alloc(total);
  let off = 0;
  for (const piece of out) {
    piece.copy(buf, off);
    off += piece.length;
  }
  return buf;
}

// ---------- registry HTTP ----------

function basicAuth(user, password) {
  return 'Basic ' + Buffer.from(user + ':' + password, 'utf8').toString('base64');
}

function parseChallenge(value) {
  // Bearer realm="...",service="...",scope="..."
  if (!value || !/^bearer/i.test(value.trim())) return null;
  const params = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(value))) params[m[1].toLowerCase()] = m[2];
  return params;
}

async function getToken(challenge, user, password, doFetch) {
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set('service', challenge.service);
  if (challenge.scope) url.searchParams.set('scope', challenge.scope);
  if (user != null || password != null) {
    url.searchParams.set('account', user ?? '');
  }
  const headers = {};
  if (user != null || password != null) headers.authorization = basicAuth(user ?? '', password ?? '');
  const res = await doFetch(url.toString(), { method: 'GET', headers });
  if (!res.ok) throw new Error('token request failed: HTTP ' + res.status);
  const body = await res.json();
  const token = body.token || body.access_token;
  if (!token) throw new Error('token response missing token');
  return token;
}

// fetchWithAuth: plain Basic when a challenge is not present, or the bearer token
// obtained from the WWW-Authenticate challenge after a 401.
async function fetchWithAuth(url, init, { user, password, fetch: doFetch }) {
  const headers = new Headers(init?.headers || {});
  const first = { ...init, headers };
  if (user != null || password != null) headers.set('authorization', basicAuth(user ?? '', password ?? ''));
  let res = await doFetch(url, { ...first, headers });
  if (res.status !== 401) return res;
  const challenge = parseChallenge(res.headers.get('www-authenticate'));
  if (!challenge) {
    // retry with Basic (in case the registry just wants credentials)
    if (user != null || password != null) {
      headers.set('authorization', basicAuth(user ?? '', password ?? ''));
      return await doFetch(url, { ...first, headers });
    }
    return res;
  }
  const token = await getToken(challenge, user, password, doFetch);
  headers.set('authorization', 'Bearer ' + token);
  return await doFetch(url, { ...first, headers });
}

function registryBase(registry) {
  return `https://${registry}`;
}

function manifestMediaType(info) {
  if (info.mediaType) return info.mediaType;
  if (info.schemaVersion === 2 && info.layers) return DOCKER_MANIFEST;
  return OCI_MANIFEST;
}

// ---------- build ----------

// buildImage({ base, files, entrypoint, cmd, env, workdir }, { fetch }) ->
//   { manifest, manifestMediaType, config, blobs }
// blobs: Map digest -> Buffer holding every base layer, the new layer and the new config.
export async function buildImage(opts, { fetch: doFetch } = {}) {
  const doFetchFn = doFetch || globalThis.fetch;
  if (!doFetchFn) throw new Error('buildImage: no fetch available');
  const auth = { fetch: doFetchFn };
  const ref = parseRef(opts.base);
  const base = registryBase(ref.registry);

  const readJson = async (url, init) => {
    const res = await fetchWithAuth(url, init, auth);
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    return await res.json();
  };
  const readBlob = async (digest) => {
    const url = `${base}/v2/${ref.repository}/blobs/${digest}`;
    const res = await fetchWithAuth(url, {}, auth);
    if (!res.ok) throw new Error(`GET blob ${digest} -> HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  };

  // 1. manifest (following an index/manifest list for linux/amd64)
  let doc = await readJson(`${base}/v2/${ref.repository}/manifests/${ref.tag}`, {
    headers: { accept: [OCI_INDEX, DOCKER_INDEX, OCI_MANIFEST, DOCKER_MANIFEST].join(', ') },
  });

  if (INDEX_TYPES.has(manifestMediaType(doc)) || Array.isArray(doc.manifests)) {
    const desc = (doc.manifests || []).find((m) => {
      const p = m.platform || {};
      const arch = p.architecture === 'amd64' || p.architecture === 'x86_64';
      const os = !p.os || p.os === 'linux';
      return arch && os;
    }) || (doc.manifests || []).find((m) => (m.platform || {}).architecture === 'amd64');
    if (!desc) throw new Error('base index has no linux/amd64 manifest');
    doc = await readJson(`${base}/v2/${ref.repository}/manifests/${desc.digest}`, {
      headers: { accept: [OCI_MANIFEST, DOCKER_MANIFEST].join(', ') },
    });
  }

  const baseManifestType = manifestMediaType(doc);
  if (!MANIFEST_TYPES.has(baseManifestType) && !doc.layers) {
    throw new Error('unexpected base manifest media type: ' + baseManifestType);
  }
  const configDesc = doc.config;
  if (!configDesc || !configDesc.digest) throw new Error('base manifest missing config');

  // 2. config
  const configBytes = await readBlob(configDesc.digest);
  const config = JSON.parse(configBytes.toString('utf8'));

  // 3. layers
  const blobs = new Map();
  const layers = doc.layers || [];
  for (const layer of layers) {
    if (!blobs.has(layer.digest)) blobs.set(layer.digest, await readBlob(layer.digest));
  }
  if (configDesc.digest && !blobs.has(configDesc.digest)) blobs.set(configDesc.digest, configBytes);

  // 4. new layer: uncompressed tar, gzipped
  const tar = tarLayer(opts.files || []);
  const diffId = sha256(tar);
  const gz = zlib.gzipSync(tar, { level: 9 });
  // deterministic gzip (mtime 0)
  gz.writeUInt32LE(0, 4);
  const layerDigest = sha256(gz);

  // media type: keep the base's family
  const isOci = baseManifestType === OCI_MANIFEST;
  const layerMediaType = isOci
    ? 'application/vnd.oci.image.layer.v1.tar+gzip'
    : 'application/vnd.docker.image.rootfs.diff.tar.gzip';
  const configMediaType = isOci ? OCI_CONFIG : DOCKER_CONFIG;

  blobs.set(layerDigest, gz);

  // 5. new config
  const newConfig = { ...config };
  newConfig.rootfs = {
    type: 'layers',
    diff_ids: [...((config.rootfs && config.rootfs.diff_ids) || []), diffId],
  };
  const baseCfg = config.config || {};
  const mergedCfg = { ...baseCfg };

  const history = [...(config.history || [])];
  history.push({
    created: '1970-01-01T00:00:00Z',
    created_by: 'converge oci build',
    comment: 'added layer ' + layerDigest,
  });
  newConfig.history = history;

  if (opts.entrypoint !== undefined) mergedCfg.Entrypoint = opts.entrypoint;
  if (opts.cmd !== undefined) mergedCfg.Cmd = opts.cmd;
  if (opts.workdir !== undefined) mergedCfg.WorkingDir = opts.workdir;
  if (opts.env !== undefined) {
    const env = Array.isArray(baseCfg.Env) ? [...baseCfg.Env] : [];
    const overrides = Array.isArray(opts.env) ? opts.env : [opts.env];
    for (const kv of overrides) {
      const key = String(kv).split('=')[0];
      const at = env.findIndex((e) => String(e).split('=')[0] === key);
      if (at === -1) env.push(kv);
      else env[at] = kv;
    }
    mergedCfg.Env = env;
  }
  newConfig.config = mergedCfg;
  // deterministic timestamps
  newConfig.created = newConfig.created || '1970-01-01T00:00:00Z';

  const newConfigBytes = Buffer.from(JSON.stringify(newConfig));
  const configDigest = sha256(newConfigBytes);
  blobs.set(configDigest, newConfigBytes);

  // 6. new manifest
  const manifest = {
    schemaVersion: 2,
    mediaType: baseManifestType,
    config: { mediaType: configMediaType, size: newConfigBytes.length, digest: configDigest },
    layers: [
      ...layers.map((l) => ({ ...l })),
      { mediaType: layerMediaType, size: gz.length, digest: layerDigest },
    ],
  };
  if (doc.annotations) manifest.annotations = doc.annotations;

  return {
    manifest,
    manifestMediaType: baseManifestType,
    config: newConfig,
    blobs,
  };
}

// ---------- push ----------

function joinLocation(loc, digest) {
  const sep = loc.includes('?') ? '&' : '?';
  return loc + sep + 'digest=' + encodeURIComponent(digest);
}

// pushImage(image, ref, { user, password, fetch }) -> { digest, mediaType }
export async function pushImage(image, ref, opts = {}) {
  const doFetch = opts.fetch || globalThis.fetch;
  if (!doFetch) throw new Error('pushImage: no fetch available');
  const auth = { user: opts.user, password: opts.password, fetch: doFetch };
  const target = parseRef(ref);
  const base = registryBase(target.registry);
  const repo = target.repository;

  // blobs: HEAD, then POST + PUT when absent
  for (const [digest, bytes] of image.blobs) {
    const headUrl = `${base}/v2/${repo}/blobs/${digest}`;
    let res = await fetchWithAuth(headUrl, { method: 'HEAD' }, auth);
    if (res.status === 200) continue;
    if (res.status !== 404 && res.status !== 401) {
      // fall through: try upload anyway
    }
    const postUrl = `${base}/v2/${repo}/blobs/uploads/`;
    res = await fetchWithAuth(postUrl, { method: 'POST', headers: { 'content-length': '0' } }, auth);
    if (res.status !== 202 && res.status !== 201) {
      throw new Error(`POST upload -> HTTP ${res.status}`);
    }
    let location = res.headers.get('location');
    if (!location) throw new Error('upload response missing Location');
    if (!/^https?:/i.test(location)) location = base + location;
    const putUrl = joinLocation(location, digest);
    const putRes = await fetchWithAuth(
      putUrl,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
        body: bytes,
      },
      auth,
    );
    if (putRes.status !== 201 && putRes.status !== 202 && putRes.status !== 200) {
      throw new Error(`PUT blob ${digest} -> HTTP ${putRes.status}`);
    }
  }

  // manifest
  const manifestBytes = Buffer.from(JSON.stringify(image.manifest));
  const digest = sha256(manifestBytes);
  const putUrl = `${base}/v2/${repo}/manifests/${target.tag}`;
  const res = await fetchWithAuth(
    putUrl,
    {
      method: 'PUT',
      headers: { 'content-type': image.manifestMediaType || OCI_MANIFEST, 'content-length': String(manifestBytes.length) },
      body: manifestBytes,
    },
    auth,
  );
  if (!res.ok) throw new Error(`PUT manifest -> HTTP ${res.status}`);
  return { digest, mediaType: image.manifestMediaType };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const out = { add: [], env: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--base': out.base = next(); break;
      case '--to': out.to = next(); break;
      case '--add': out.add.push(next()); break;
      case '--entrypoint': out.entrypoint = JSON.parse(next()); break;
      case '--cmd': out.cmd = JSON.parse(next()); break;
      case '--env': out.env.push(next()); break;
      case '--workdir': out.workdir = next(); break;
      default: throw new Error('unknown argument: ' + a);
    }
  }
  return out;
}

function walkFiles(dir, prefix, acc) {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    const st = fs.statSync(full);
    if (st.isDirectory()) walkFiles(full, rel, acc);
    else acc.push({ path: rel, local: full, mode: st.mode & 0o777 });
  }
}

function collectAdd(specs) {
  // --add <localPath>:<pathInImage>
  const files = [];
  for (const spec of specs) {
    const idx = spec.indexOf(':');
    if (idx === -1) throw new Error('--add expects <localPath>:<pathInImage>: ' + spec);
    const local = spec.slice(0, idx);
    const target = spec.slice(idx + 1).replace(/^\//, '');
    const st = fs.statSync(local);
    if (st.isDirectory()) {
      const acc = [];
      walkFiles(local, '', acc);
      for (const f of acc) {
        files.push({ path: target + '/' + f.path, data: fs.readFileSync(f.local), mode: f.mode });
      }
    } else {
      files.push({ path: target, data: fs.readFileSync(local), mode: st.mode & 0o777 });
    }
  }
  return files;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (cmd !== 'push') {
    console.error('usage: oci.mjs push --base <ref> --add <local>:<path> --to <ref> [...]');
    process.exit(1);
  }
  const args = parseArgs(argv.slice(1));
  if (!args.base || !args.to) throw new Error('--base and --to are required');
  const files = collectAdd(args.add);
  const image = await buildImage(
    {
      base: args.base,
      files,
      entrypoint: args.entrypoint,
      cmd: args.cmd,
      env: args.env.length ? args.env : undefined,
      workdir: args.workdir,
    },
    { fetch: globalThis.fetch },
  );
  const { digest } = await pushImage(image, args.to, {
    user: process.env.OCI_USER,
    password: process.env.OCI_PASSWORD,
    fetch: globalThis.fetch,
  });
  console.log(digest);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
  });
}
