// Tests for scripts/oci.mjs against an in-memory fake registry (no sockets, no network).
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { parseRef, tarLayer, buildImage, pushImage } from '../scripts/oci.mjs';

const sha256 = (buf) => 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex');

const OCI_INDEX = 'application/vnd.oci.image.index.v1+json';
const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json';
const OCI_LAYER = 'application/vnd.oci.image.layer.v1.tar+gzip';

// ---------- helpers ----------

function untar(buf) {
  const entries = [];
  for (let off = 0; off + 512 <= buf.length; ) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    let name = '';
    for (let i = 0; i < 100 && block[i] !== 0; i++) name += String.fromCharCode(block[i]);
    const size = parseInt(block.subarray(124, 136).toString('utf8').replace(/[^0-7]/g, '') || '0', 8);
    const mode = parseInt(block.subarray(100, 108).toString('utf8').replace(/[^0-7]/g, '') || '0', 8);
    const typeflag = String.fromCharCode(block[156]);
    const dataOff = off + 512;
    entries.push({ name, mode, typeflag, data: Buffer.from(buf.subarray(dataOff, dataOff + size)) });
    off = dataOff + size + ((size % 512) ? 512 - (size % 512) : 0);
  }
  return entries;
}

function gunzip(buf) {
  return zlib.gunzipSync(buf);
}

// ---------- parseRef ----------

test('parseRef normalizes docker.io and defaults', () => {
  assert.deepEqual(parseRef('docker.io/library/node:22-bookworm'), {
    registry: 'registry-1.docker.io',
    repository: 'library/node',
    tag: '22-bookworm',
  });
  assert.deepEqual(parseRef('node:22'), {
    registry: 'registry-1.docker.io',
    repository: 'library/node',
    tag: '22',
  });
  assert.deepEqual(parseRef('node'), {
    registry: 'registry-1.docker.io',
    repository: 'library/node',
    tag: 'latest',
  });
  assert.deepEqual(parseRef('registry.cloudflare.com/abc/converge-runner'), {
    registry: 'registry.cloudflare.com',
    repository: 'abc/converge-runner',
    tag: 'latest',
  });
  assert.deepEqual(parseRef('localhost:5000/foo/bar:baz'), {
    registry: 'localhost:5000',
    repository: 'foo/bar',
    tag: 'baz',
  });
  assert.deepEqual(parseRef('quay.io/org/img:1.2.3'), {
    registry: 'quay.io',
    repository: 'org/img',
    tag: '1.2.3',
  });
});

// ---------- tarLayer ----------

test('tarLayer is a valid deterministic ustar with parent dirs', () => {
  const buf = tarLayer([
    { path: 'runner/runner.mjs', data: Buffer.from('hi\n'), mode: 0o644 },
    { path: 'converge-jail', data: Buffer.from('x'), mode: 0o755 },
  ]);

  assert.equal(buf.length % 512, 0);
  // two trailing zero blocks
  assert.ok(buf.subarray(buf.length - 1024).every((b) => b === 0));

  // deterministic: same input -> same bytes
  const again = tarLayer([
    { path: 'runner/runner.mjs', data: Buffer.from('hi\n'), mode: 0o644 },
    { path: 'converge-jail', data: Buffer.from('x'), mode: 0o755 },
  ]);
  assert.ok(buf.equals(again));

  const entries = untar(buf);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes('runner/'), 'parent dir listed');
  assert.deepEqual(names.slice(0, 2), ['runner/', 'runner/runner.mjs']);
  assert.equal(entries[0].mode, 0o755);
  assert.equal(entries[0].typeflag, '5');
  const file = entries.find((e) => e.name === 'runner/runner.mjs');
  assert.equal(file.mode, 0o644);
  assert.equal(file.data.toString('utf8'), 'hi\n');
  const jail = entries.find((e) => e.name === 'converge-jail');
  assert.equal(jail.mode, 0o755);
  assert.equal(jail.data.toString('utf8'), 'x');

  // header checksum of every block is correct
  for (let off = 0; off < entries.length && off + 512 <= buf.length; ) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const stored = parseInt(block.subarray(148, 156).toString('utf8').replace(/[^0-7]/g, '') || '0', 8);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : block[i];
    assert.equal(stored, sum, 'checksum at ' + off);
    const size = parseInt(block.subarray(124, 136).toString('utf8').replace(/[^0-7]/g, '') || '0', 8);
    off += 512 + size + ((size % 512) ? 512 - (size % 512) : 0);
    if (String.fromCharCode(block[156]) === '5') off -= size;
  }
});

// ---------- fake registry ----------

function makeFakeRegistry(baseImage) {
  // baseImage: { manifest, configBytes, layers: Map<digest, Buffer> }
  const blobs = new Map();
  blobs.set(baseImage.configDescriptor.digest, baseImage.configBytes);
  for (const [d, b] of baseImage.layers) blobs.set(d, b);

  const requests = [];
  const uploads = new Map();
  let uploadCounter = 0;
  const pushedBlobs = new Map();
  const pushedManifests = new Map();

  const doFetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const pathname = u.pathname;
    requests.push({ method, url, pathname, search: u.search });

    const json = (body, status = 200, headers = {}) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
      });

    // base registry host: registry-1.docker.io
    if (u.host === 'auth.docker.io') {
      return json({ token: 'fake-token' }, 200);
    }

    if (u.host === 'registry-1.docker.io') {
      if (pathname === '/v2/library/node/manifests/22-bookworm') {
        return json(baseImage.index, 200, { 'content-type': OCI_INDEX });
      }
      if (pathname === '/v2/library/node/manifests/' + baseImage.amd64Digest) {
        return json(baseImage.manifest, 200, { 'content-type': OCI_MANIFEST });
      }
      const m = pathname.match(/^\/v2\/library\/node\/blobs\/(sha256:[0-9a-f]+)$/);
      if (m && blobs.has(m[1])) {
        return new Response(blobs.get(m[1]), { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      }
      return new Response('not found', { status: 404 });
    }

    // push target: registry.cloudflare.com
    if (u.host === 'registry.cloudflare.com') {
      const repo = 'abc/converge-runner';
      const prefix = '/v2/' + repo;
      if (pathname === prefix + '/blobs/' + pathname.split('/').pop() && method === 'HEAD') {
        const digest = pathname.split('/').pop();
        if (pushedBlobs.has(digest)) return new Response(null, { status: 200 });
        return new Response(null, { status: 404 });
      }
      if (pathname === prefix + '/blobs/uploads/' && method === 'POST') {
        const id = 'upload-' + uploadCounter++;
        uploads.set(id, Buffer.alloc(0));
        return new Response(null, { status: 202, headers: { location: prefix + '/blobs/uploads/' + id } });
      }
      const up = pathname.match(new RegExp('^' + prefix + '/blobs/uploads/([^/]+)$'));
      if (up && method === 'PUT') {
        const digest = u.searchParams.get('digest');
        pushedBlobs.set(digest, Buffer.from(init.body));
        return new Response(null, { status: 201 });
      }
      const man = pathname.match(new RegExp('^' + prefix + '/manifests/(.+)$'));
      if (man && method === 'PUT') {
        pushedManifests.set(man[1], Buffer.from(init.body));
        return new Response(null, { status: 201 });
      }
      return new Response('unexpected', { status: 500 });
    }

    return new Response('unknown host ' + u.host, { status: 500 });
  };

  return { doFetch, requests, pushedBlobs, pushedManifests };
}

// ---------- buildImage + pushImage ----------

test('buildImage appends a layer and pushImage pushes all blobs', async () => {
  const baseLayer = Buffer.from('base-layer-bytes');
  const baseLayerDigest = sha256(baseLayer);
  const baseDiffId = sha256(Buffer.from('base-tar'));
  const configBytes = Buffer.from(
    JSON.stringify({
      architecture: 'amd64',
      os: 'linux',
      config: { Env: ['PATH=/usr/bin', 'HOME=/root'], Cmd: ['/bin/sh'] },
      rootfs: { type: 'layers', diff_ids: [baseDiffId] },
      history: [{ created: '1970-01-01T00:00:00Z', created_by: 'base' }],
    }),
  );
  const configDigest = sha256(configBytes);
  const layerDescriptor = {
    mediaType: OCI_LAYER,
    size: baseLayer.length,
    digest: baseLayerDigest,
  };
  const manifest = {
    schemaVersion: 2,
    mediaType: OCI_MANIFEST,
    config: { mediaType: OCI_CONFIG, size: configBytes.length, digest: configDigest },
    layers: [layerDescriptor],
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestDigest = sha256(manifestBytes);
  const index = {
    schemaVersion: 2,
    mediaType: OCI_INDEX,
    manifests: [
      {
        mediaType: OCI_MANIFEST,
        size: manifestBytes.length,
        digest: manifestDigest,
        platform: { os: 'linux', architecture: 'amd64' },
      },
    ],
  };

  const reg = makeFakeRegistry({
    index,
    manifest,
    amd64Digest: manifestDigest,
    configDescriptor: manifest.config,
    configBytes,
    layers: new Map([[baseLayerDigest, baseLayer]]),
  });

  const files = [
    { path: 'runner/runner.mjs', data: Buffer.from('hi\n'), mode: 0o644 },
    { path: 'converge-jail', data: Buffer.from('x'), mode: 0o755 },
  ];
  const image = await buildImage(
    {
      base: 'node:22-bookworm',
      files,
      entrypoint: ['node', '/runner/runner.mjs'],
      cmd: ['--serve'],
      env: ['NODE_ENV=production', 'HOME=/app'],
      workdir: '/app',
    },
    { fetch: reg.doFetch },
  );

  // manifest references config and both layers, base first
  assert.equal(image.manifest.layers.length, 2);
  assert.equal(image.manifest.layers[0].digest, baseLayerDigest);
  assert.equal(image.manifest.manifestMediaType, undefined);
  assert.equal(image.manifestMediaType, OCI_MANIFEST);
  assert.equal(image.manifest.config.digest, sha256(Buffer.from(JSON.stringify(image.config))));

  // config carries merged env, entrypoint, cmd, workdir, appended diff_id and history
  const cfg = image.config;
  assert.deepEqual(cfg.config.Entrypoint, ['node', '/runner/runner.mjs']);
  assert.deepEqual(cfg.config.Cmd, ['--serve']);
  assert.equal(cfg.config.WorkingDir, '/app');
  assert.deepEqual(cfg.config.Env, ['PATH=/usr/bin', 'HOME=/app', 'NODE_ENV=production']);
  assert.equal(cfg.rootfs.diff_ids.length, 2);
  assert.equal(cfg.history.length, 2);

  // new layer: diff_id == sha256 of uncompressed tar; blob digest == sha256 of gz
  const newDesc = image.manifest.layers[1];
  const newBlob = image.blobs.get(newDesc.digest);
  assert.ok(newBlob, 'new layer blob present');
  assert.equal(sha256(newBlob), newDesc.digest);
  const uncompressed = gunzip(newBlob);
  assert.equal(cfg.rootfs.diff_ids[1], sha256(uncompressed));
  const newEntries = untar(uncompressed).map((e) => e.name);
  assert.ok(newEntries.includes('runner/runner.mjs'));
  assert.ok(newEntries.includes('converge-jail'));

  // blobs map holds base layer, new layer, new config, each digest matching its bytes
  assert.ok(image.blobs.has(baseLayerDigest));
  assert.ok(image.blobs.has(image.manifest.config.digest));
  for (const [digest, bytes] of image.blobs) {
    assert.equal(sha256(bytes), digest);
  }

  // push
  const { digest: pushedDigest, mediaType } = await pushImage(image, 'registry.cloudflare.com/abc/converge-runner:latest', {
    user: 'u',
    password: 'p',
    fetch: reg.doFetch,
  });
  assert.equal(mediaType, OCI_MANIFEST);
  const pushedManifestBytes = reg.pushedManifests.get('latest');
  assert.ok(pushedManifestBytes, 'manifest pushed');
  assert.equal(sha256(pushedManifestBytes), pushedDigest);
  const pushed = JSON.parse(pushedManifestBytes.toString('utf8'));
  assert.equal(pushed.config.digest, image.manifest.config.digest);
  assert.deepEqual(
    pushed.layers.map((l) => l.digest),
    image.manifest.layers.map((l) => l.digest),
  );
  // every pushed blob digest matches its bytes
  for (const [digest, bytes] of reg.pushedBlobs) {
    assert.equal(sha256(bytes), digest);
  }
  // all blobs referenced by the manifest were uploaded
  for (const desc of [pushed.config, ...pushed.layers]) {
    assert.ok(reg.pushedBlobs.has(desc.digest), 'uploaded ' + desc.digest);
  }
});
