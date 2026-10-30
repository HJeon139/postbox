// Downloading Postbox’s Redis 8 build for this platform (designs/508/design.md, “Storage: a Redis 8 server that Postbox
// bundles and runs”, decision 2): the file is kept only once its SHA-256 matches the pinned one, and an unsupported
// platform or a build with no pinned checksum is refused before any request. The server is an HTTP fixture behind an
// injected fetch, which answers with real Response objects whose bodies stream in chunks, so nothing touches the network.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fetchRedisBuild } from '../server/redis-download.mjs';

let tmp;
before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'pb-redis-download-'));
});
after(() => rm(tmp, { recursive: true, force: true }));

const BASE = 'http://127.0.0.1:9/releases/download/redis-v8.10.3';
const GOOD = Buffer.from('a stand-in for redis-8.10.3-linux-x64.tar.gz, '.repeat(4000));
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** A manifest shaped like server/redis-build.mjs’s, pointing at the fixture. */
const build = (sha = sha256(GOOD)) => ({
  version: '8.10.3',
  release: { url: BASE },
  targets: {
    'linux-x64': { asset: 'redis-8.10.3-linux-x64.tar.gz', sha256: sha },
    'darwin-arm64': { asset: 'redis-8.10.3-darwin-arm64.tar.gz', sha256: null },
  },
});

/**
 * An HTTP fixture: URL to status and bytes, served in 4 KiB chunks. Records every request.
 * @param {Record<string, { status?: number, body: Buffer }>} routes
 */
function server(routes) {
  const requests = [];
  /** @param {string} url */
  const fetch = async (url) => {
    requests.push(String(url));
    const route = routes[String(url)];
    if (!route) return new Response('Not Found', { status: 404 });
    let at = 0;
    const body = new ReadableStream({
      pull(c) {
        if (at >= route.body.length) return c.close();
        c.enqueue(new Uint8Array(route.body.subarray(at, at + 4096)));
        at += 4096;
      },
    });
    return new Response(body, { status: route.status ?? 200 });
  };
  return { fetch, requests };
}

const linux = { platform: 'linux', arch: 'x64' };
const asset = (dataDir) => join(dataDir, 'redis', '8.10.3', 'redis-8.10.3-linux-x64.tar.gz');

test('a download whose SHA-256 matches the pin is kept under the data folder, and no temporary file is left', async () => {
  const dataDir = join(tmp, 'good');
  const s = server({ [`${BASE}/redis-8.10.3-linux-x64.tar.gz`]: { body: GOOD } });
  const got = await fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: s.fetch });
  assert.deepEqual(got, { path: asset(dataDir), sha256: sha256(GOOD), downloaded: true });
  assert.deepEqual(await readFile(asset(dataDir)), GOOD);
  assert.deepEqual(await readdir(join(dataDir, 'redis', '8.10.3')), ['redis-8.10.3-linux-x64.tar.gz']);
  // Kept as data, not as a program: nothing in it is executable until it’s unpacked.
  assert.equal(statSync(asset(dataDir)).mode & 0o111, 0);
  assert.deepEqual(s.requests, [`${BASE}/redis-8.10.3-linux-x64.tar.gz`]);
});

test('a download whose SHA-256 doesn’t match is refused with both hashes and the URL, and nothing is kept', async () => {
  const dataDir = join(tmp, 'bad');
  const bad = Buffer.concat([GOOD, Buffer.from('tampered')]);
  const s = server({ [`${BASE}/redis-8.10.3-linux-x64.tar.gz`]: { body: bad } });
  await assert.rejects(fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: s.fetch }), (e) => {
    assert.equal(e.code, 'ECHECKSUM');
    assert.ok(e.message.includes(sha256(GOOD)), e.message);
    assert.ok(e.message.includes(sha256(bad)), e.message);
    assert.ok(e.message.includes(`${BASE}/redis-8.10.3-linux-x64.tar.gz`), e.message);
    return true;
  });
  assert.equal(existsSync(asset(dataDir)), false);
  assert.deepEqual(await readdir(join(dataDir, 'redis', '8.10.3')), []);
});

test('a kept build is checked again at the next start, and a damaged one is downloaded again', async () => {
  const dataDir = join(tmp, 'again');
  const s = server({ [`${BASE}/redis-8.10.3-linux-x64.tar.gz`]: { body: GOOD } });
  await fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: s.fetch });
  const second = await fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: s.fetch });
  assert.equal(second.downloaded, false);
  assert.equal(s.requests.length, 1);
  await writeFile(asset(dataDir), 'damaged');
  const third = await fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: s.fetch });
  assert.equal(third.downloaded, true);
  assert.equal(s.requests.length, 2);
  assert.deepEqual(await readFile(asset(dataDir)), GOOD);
});

test('a failed request is refused with its status and URL, and nothing is kept', async () => {
  const dataDir = join(tmp, 'missing');
  const s = server({});
  await assert.rejects(fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: s.fetch }), (e) => {
    assert.equal(e.code, 'EDOWNLOAD');
    assert.match(e.message, /404/);
    assert.ok(e.message.includes(`${BASE}/redis-8.10.3-linux-x64.tar.gz`), e.message);
    return true;
  });
  assert.equal(existsSync(asset(dataDir)), false);
});

test('a network error is refused with its cause kept', async () => {
  const dataDir = join(tmp, 'offline');
  const cause = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' });
  const fetch = async () => {
    throw new TypeError('fetch failed', { cause });
  };
  await assert.rejects(fetchRedisBuild({ dataDir, ...linux, build: build(), fetch }), (e) => {
    assert.equal(e.code, 'EDOWNLOAD');
    assert.match(e.message, /ENOTFOUND/);
    assert.equal(e.cause.cause, cause);
    return true;
  });
});

test('a body cut off mid-download is refused with its cause kept, and no temporary file is left', async () => {
  const dataDir = join(tmp, 'cut');
  const fetch = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(GOOD.subarray(0, 4096)));
          c.error(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
        },
      }),
    );
  await assert.rejects(fetchRedisBuild({ dataDir, ...linux, build: build(), fetch }), (e) => {
    assert.equal(e.code, 'EDOWNLOAD');
    assert.match(e.message, /socket hang up/);
    assert.equal(e.cause.code, 'ECONNRESET');
    return true;
  });
  assert.deepEqual(await readdir(join(dataDir, 'redis', '8.10.3')), []);
});

test('a build larger than the cap is refused before it fills the disk', async () => {
  const dataDir = join(tmp, 'huge');
  const s = server({ [`${BASE}/redis-8.10.3-linux-x64.tar.gz`]: { body: GOOD } });
  await assert.rejects(fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: s.fetch, maxBytes: 10_000 }), (e) => {
    assert.equal(e.code, 'EDOWNLOAD');
    assert.match(e.message, /larger than/);
    return true;
  });
  assert.deepEqual(await readdir(join(dataDir, 'redis', '8.10.3')), []);
});

test('an unsupported platform is refused before any request, with the platform message, and writes nothing', async () => {
  const dataDir = join(tmp, 'intel');
  const s = server({});
  await assert.rejects(fetchRedisBuild({ dataDir, platform: 'darwin', arch: 'x64', build: build(), fetch: s.fetch }), (e) => {
    assert.equal(e.code, 'EPLATFORM');
    assert.match(e.message, /^Postbox doesn’t run on macOS on Intel/);
    return true;
  });
  assert.deepEqual(s.requests, []);
  assert.equal(existsSync(dataDir), false);
});

test('a build with no pinned SHA-256 is never downloaded', async () => {
  const dataDir = join(tmp, 'unpinned');
  const s = server({});
  await assert.rejects(fetchRedisBuild({ dataDir, platform: 'darwin', arch: 'arm64', build: build(), fetch: s.fetch }), (e) => {
    assert.equal(e.code, 'ENOPIN');
    assert.match(e.message, /redis-8\.10\.3-darwin-arm64\.tar\.gz/);
    return true;
  });
  assert.deepEqual(s.requests, []);
  assert.equal(existsSync(dataDir), false);
});

test('a kept file that isn’t a regular file is refused, not trusted or replaced', async () => {
  const dataDir = join(tmp, 'folder');
  await mkdir(asset(dataDir), { recursive: true });
  const s = server({ [`${BASE}/redis-8.10.3-linux-x64.tar.gz`]: { body: GOOD } });
  await assert.rejects(fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: s.fetch }), (e) => {
    assert.equal(e.code, 'EISDIR');
    return true;
  });
  assert.deepEqual(s.requests, []);
});

test('#553: a download that doesn’t finish in time is given up, whether the request or the body stalls, and nothing is kept', async () => {
  const dataDir = join(tmp, 'slow');
  // The request never answers: fetch rejects only when the signal aborts, as undici does.
  const hanging = (_url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
  await assert.rejects(fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: hanging, timeoutMs: 50 }), (e) => {
    assert.equal(e.code, 'EDOWNLOAD');
    assert.match(e.message, /didn’t finish in time/);
    return true;
  });
  // The request answers, and its body stalls after the first chunk.
  const stalling = async () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(GOOD.subarray(0, 4096)));
        },
      }),
    );
  await assert.rejects(fetchRedisBuild({ dataDir, ...linux, build: build(), fetch: stalling, timeoutMs: 50 }), (e) => {
    assert.equal(e.code, 'EDOWNLOAD');
    assert.match(e.message, /didn’t finish in time/);
    return true;
  });
  assert.equal(existsSync(asset(dataDir)), false);
  assert.deepEqual(
    (await readdir(join(dataDir, 'redis', '8.10.3'))).filter((n) => n.endsWith('.part')),
    [],
    'no temporary file is left',
  );
});
