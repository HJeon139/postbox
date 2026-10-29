// Packaging Postbox’s Redis 8 build for macOS (tools/redis-bundle-libs.mjs, .github/workflows/redis.yml;
// designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and runs”, decision 2). The search module
// links Homebrew’s OpenSSL and LLVM’s libunwind, which a person’s Mac needn’t have, so the workflow copies each such
// library into the package’s lib/ and points every reference at it relative to the file that loads it. The workflow
// then keeps its check that nothing links a Homebrew library. These specs read the workflow and the planner; the
// rewrite itself was run on a copy of a local build (the commit says how).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bundlePlan, linkedLibraries } from '../tools/redis-bundle-libs.mjs';

const YML = readFileSync(new URL('../.github/workflows/redis.yml', import.meta.url), 'utf8');

/** The `run:` text of the step with this name. */
const step = (name) => {
  const at = YML.indexOf(`- name: ${name}`);
  assert.ok(at >= 0, `no step named “${name}”`);
  const next = YML.indexOf('\n      - ', at + 1);
  return YML.slice(at, next < 0 ? undefined : next);
};

test('the macOS toolchain leaves GNU libtool off PATH, since the search module’s CMake needs Apple’s libtool -static', () => {
  const mac = step('Install the toolchain (macOS)');
  assert.doesNotMatch(mac, /libtool\/libexec\/gnubin/);
});

test('on macOS the package step bundles Homebrew libraries into lib/ with tools/redis-bundle-libs.mjs', () => {
  const pkg = step('Package the build');
  assert.match(pkg, /node tools\/redis-bundle-libs\.mjs "dist\/\$out"/);
  assert.match(pkg, /RUNNER_OS" = macOS/);
});

test('the library check still refuses a Homebrew link, and covers the bundled lib/ too', () => {
  const check = step('It needs only the system’s libraries');
  assert.match(check, /\/opt\/homebrew\|\/usr\/local/);
  assert.match(check, /lib\/\*\.dylib/);
});

const SEARCH = `modules/redisearch.so:
\t@rpath/redisearch.so (compatibility version 0.0.0, current version 0.0.0)
\t/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib (compatibility version 3.0.0, current version 3.0.0)
\t/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib (compatibility version 3.0.0, current version 3.0.0)
\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)
\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 2000.67.0)
\t/opt/homebrew/opt/llvm@18/lib/libunwind.1.dylib (compatibility version 1.0.0, current version 1.0.0)
`;

test('otool -L output reads as the libraries a file links, without the file’s own name line', () => {
  assert.deepEqual(linkedLibraries(SEARCH), [
    '@rpath/redisearch.so',
    '/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib',
    '/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib',
    '/usr/lib/libSystem.B.dylib',
    '/usr/lib/libc++.1.dylib',
    '/opt/homebrew/opt/llvm@18/lib/libunwind.1.dylib',
  ]);
});

test('each Homebrew library is copied once into lib/ and referenced relative to the file that loads it', () => {
  const plan = bundlePlan('modules/redisearch.so', linkedLibraries(SEARCH));
  assert.deepEqual(plan, [
    { from: '/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib', copy: 'lib/libssl.3.dylib', to: '@loader_path/../lib/libssl.3.dylib' },
    { from: '/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib', copy: 'lib/libcrypto.3.dylib', to: '@loader_path/../lib/libcrypto.3.dylib' },
    { from: '/opt/homebrew/opt/llvm@18/lib/libunwind.1.dylib', copy: 'lib/libunwind.1.dylib', to: '@loader_path/../lib/libunwind.1.dylib' },
  ]);
  // A bundled library that links another (libssl links libcrypto through the Cellar path) points beside itself.
  const ssl = bundlePlan('lib/libssl.3.dylib', ['/opt/homebrew/Cellar/openssl@3/3.6.0/lib/libcrypto.3.dylib', '/usr/lib/libSystem.B.dylib']);
  assert.deepEqual(ssl, [
    { from: '/opt/homebrew/Cellar/openssl@3/3.6.0/lib/libcrypto.3.dylib', copy: 'lib/libcrypto.3.dylib', to: '@loader_path/libcrypto.3.dylib' },
  ]);
  // The system’s libraries and @rpath references stay as they are.
  assert.deepEqual(bundlePlan('bin/redis-server', ['/usr/lib/libSystem.B.dylib']), []);
});
