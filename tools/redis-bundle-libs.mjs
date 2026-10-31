// Makes a macOS Redis package carry the Homebrew libraries it links (.github/workflows/redis.yml, “Package the
// build”; designs/508/design.md, “Storage: a Redis 8 server that Postbox bundles and runs”, decision 2). The search
// module links Homebrew’s OpenSSL and LLVM’s libunwind, which a person’s Mac needn’t have. Each such library is copied
// into the package’s lib/, every reference to it is rewritten relative to the file that loads it (@loader_path), and
// each changed file is signed again ad hoc, since a rewrite invalidates its signature and arm64 refuses unsigned code.
//
//   node tools/redis-bundle-libs.mjs <package dir>     the dir holds bin/redis-server and modules/*.so
//
// Spawns otool, install_name_tool and codesign with argument arrays; run it on macOS only.

import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where Homebrew keeps libraries, on Apple silicon and on Intel. */
const HOMEBREW = /^(\/opt\/homebrew|\/usr\/local)\//;

/**
 * The libraries `otool -L` says a file links: every indented line, without the file’s own name line.
 * @param {string} out  otool -L’s output for one file
 * @returns {string[]}
 */
export function linkedLibraries(out) {
  return out
    .split('\n')
    .filter((line) => /^\s+\S/.test(line))
    .map((line) => line.trim().replace(/ \(compatibility version .*\)$/, ''));
}

/**
 * What to do for one file of the package: each Homebrew library it links, copied once into lib/, and the reference
 * that replaces the old one, relative to the file.
 * @param {string} file  the file, relative to the package, such as modules/redisearch.so
 * @param {string[]} libs  what it links, without its own install name
 * @returns {{ from: string, copy: string, to: string }[]}
 */
export function bundlePlan(file, libs) {
  const fromDir = posix.dirname(file);
  return libs
    .filter((lib) => HOMEBREW.test(lib))
    .map((lib) => {
      const copy = posix.join('lib', posix.basename(lib));
      return { from: lib, copy, to: `@loader_path/${posix.relative(fromDir, copy)}` };
    });
}

/** @param {string} cmd @param {string[]} args */
const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });

/**
 * Bundles and rewrites in place. Returns the files it changed, relative to the package.
 * @param {string} dir
 */
export function bundle(dir) {
  const queue = [
    ...readdirSync(join(dir, 'bin')).map((n) => posix.join('bin', n)),
    ...readdirSync(join(dir, 'modules'))
      .filter((n) => n.endsWith('.so'))
      .map((n) => posix.join('modules', n)),
  ];
  const changed = new Set();
  while (queue.length) {
    const file = /** @type {string} */ (queue.shift());
    const path = join(dir, file);
    // A library names itself in its first line; that isn’t a link to follow.
    const self = run('otool', ['-D', path]).split('\n')[1]?.trim();
    const libs = linkedLibraries(run('otool', ['-L', path])).filter((lib) => lib !== self);
    for (const step of bundlePlan(file, libs)) {
      const target = join(dir, step.copy);
      if (!existsSync(target)) {
        mkdirSync(dirname(target), { recursive: true });
        copyFileSync(step.from, target);
        chmodSync(target, 0o755);
        run('install_name_tool', ['-id', `@rpath/${basename(target)}`, target]);
        changed.add(step.copy);
        queue.push(step.copy);
      }
      run('install_name_tool', ['-change', step.from, step.to, path]);
      changed.add(file);
    }
  }
  for (const file of changed) run('codesign', ['--force', '--sign', '-', join(dir, file)]);
  return [...changed].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('Usage: node tools/redis-bundle-libs.mjs <package dir>');
    process.exit(2);
  }
  for (const file of bundle(dir)) console.log(`bundled or rewrote ${file}`);
}
