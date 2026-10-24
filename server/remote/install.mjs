// Installing Postbox’s host code on a remote host (#120, architecture.md “Remote hosts”, “The daemon” and “Security”),
// from the laptop, over Postbox’s own ssh (ssh.mjs’s options: BatchMode, no shared connection, no agent forwarding).
// lint-allow-file quotes: INSTALL_SCRIPT is a shell script, whose straight quotes are the shell’s.
//
// What ships: every file under server/remote/host/ and, transitively, every file they import (only node: modules and
// shared/, which tests/host-imports.test.mjs checks through hostFiles below), plus a package.json with this Postbox’s
// version. They keep the repo’s layout under ~/.postbox-remote/<version>/, so relative imports work unchanged, beside
// manifest.sha256, each file’s SHA-256 in sha256sum’s format.
//
// How, in two ssh runs, each with a fixed remote command built only from the validated version (as remoteCommand
// builds attach’s), never a shell string on the laptop:
// 1. installCommand: `/bin/sh -c '<script>' postbox-install <version>`. With umask 077, the script makes
//    ~/.postbox-remote (0700), unpacks the tar stream on its stdin into a temporary folder beside the version’s, checks
//    every file against the manifest (sha256sum, else shasum -a 256, else a few lines of node), and renames the folder
//    into place, which is atomic. The same version that’s there is left alone (apart from node-path) only when its
//    manifest is this one, byte for byte, and its files pass the same check; other code under that version is
//    replaced, renamed aside and removed, holding the version’s start lock, unless a daemon or turn of that version is
//    running or an attach is starting its daemon (so stale code doesn’t keep running under an unchanged version, as in
//    a build where every change is still 0.10.0). It prints `installed <version>` or `present <version>`.
// 2. tokenCommand: `<the version’s host> token`, the launcher (server/remote/host/host), which finds a Node 22 or later
//    and has the daemon’s code make ~/.postbox-remote/token (0600) if it’s missing and print it. So a host without a
//    usable node is found at install, with the launcher’s message saying where it looked.
// The script is one line in single quotes because sshd hands the command to the person’s login shell, which may not
// be a POSIX one: it has no single quote, no “\\” or “\'” (fish’s escapes inside single quotes), no “!” (csh’s history)
// and no new line, which tests check.
//
// node-path: the host’s nodePath setting, if it has one, goes in the tar as node-path, beside the manifest rather than
// in it, since it’s the host’s setting and not code: a reinstall of a present version replaces it (or removes it, once
// the setting is cleared), and the launcher checks what it names before using it.
//
// The tar is written here, a minimal ustar writer, rather than by the system’s tar: macOS’s bsdtar adds extended
// attributes and AppleDouble entries that GNU tar on the host warns about, and records the laptop’s user and group
// names. This one is the same bytes on any laptop, names no user, and sets each file’s mode (0700 for the launcher, else
// 0600). The host unpacks it with its own tar, which as an ordinary user doesn’t restore ownership.
//
// The laptop’s copy of the token lives in its own file under Postbox’s data folder, `<data>/remote-tokens/<host id>`
// (0600, in a 0700 folder), never in the store or the state the page reads; ssh.mjs sends it in hello, on stdin.
//
// The first install writes outside the repo on both machines, so the UI confirms it first (L6), worded from
// describeInstall.

import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostPaths, REMOTE_DIR } from '../../shared/remote-protocol.mjs';
import { checkHostPath } from '../../shared/remote-settings.mjs';
import { LOCK_OWNER } from './host/proc.mjs';
import { classifyExit, failure, remoteCommand, SshFailure, sshArgs } from './ssh.mjs';

/** The repo’s top folder, whose layout the host’s copy keeps. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** How long one install run may take before its ssh is stopped. */
export const INSTALL_TIMEOUT = 5 * 60 * 1000;
/** How long the token run may take. */
export const TOKEN_TIMEOUT = 2 * 60 * 1000;
/** The manifest’s name, at the top of the version’s folder. */
export const MANIFEST = 'manifest.sha256';
/** The node-path file’s name, at the top of the version’s folder (the launcher reads it). */
export const NODE_PATH_FILE = 'node-path';
/** The laptop’s folder of tokens, under Postbox’s data folder. */
export const TOKENS_DIR = 'remote-tokens';
/** The daemon’s token’s shape (shared/remote-protocol.mjs checks hello.token against the same). */
export const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;
/** A host ID, as store.mjs’s newId makes them; it names a file, so nothing else passes. */
const HOST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A shipped file’s path: plain ASCII parts, so it fits a ustar name and a manifest line, and no shell splits it. */
const SHIP_PATH_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
/**
 * The script’s exit codes (sysexits.h), each with what the person is told. 75 (a different build of the version is
 * running, or an attach is starting its daemon) is worded in installOutcome, which names the version.
 */
const SCRIPT_EXITS = Object.freeze({
  65: 'the files didn’t arrive whole (the host’s tar couldn’t unpack them)',
  66: 'a file’s SHA-256 on the host didn’t match the manifest',
  69: 'the host has no sha256sum, shasum or node to check the files with',
  77: `~/${REMOTE_DIR}, or the version’s folder or locks folder there, is a symbolic link, and Postbox installs only into real folders`,
  78: 'the home folder (HOME) on the host isn’t an absolute path',
});

// ── What ships ──────────────────────────────────────────────────────────────────────

// A static import or re-export at the start of a line: import '…', import … from '…', export * from '…' or
// export { … } from '…'. The names between may span lines. Comments start with // or *, so one isn’t matched.
const SPECIFIERS = /^\s*(?:import\s*(?:[\w$*{}\s,]+?\s*from\s*)?|export\s*(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s*from\s*)['"]([^'"]+)['"]/gm;

/**
 * The host code’s files: every regular file under server/remote/host/, whatever its name (the `host` launcher has no
 * extension), and everything they import, transitively, starting also from the tool list the shim serves
 * (shared/mcp-tools.mjs) and the protocol (shared/remote-protocol.mjs). Each file is read and scanned for imports;
 * shared/catalog.mjs imports ./urls.mjs, so the first level isn’t enough. `problems` lists anything that mustn’t ship:
 * a file outside shared/ or server/remote/host/, a bare package import, something under the folder that isn’t a
 * regular file or a folder (a symlink could lead anywhere), or a name a ustar header or a manifest line can’t carry.
 * @param {string} [root]  the repo’s top folder
 * @returns {{ files: string[], problems: string[] }} files: relative to root, with /, sorted
 */
export function hostFiles(root = ROOT) {
  const host = join(root, 'server', 'remote', 'host');
  const allowed = [join(root, 'shared') + sep, host + sep];
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const start = [join(root, 'shared', 'mcp-tools.mjs'), join(root, 'shared', 'remote-protocol.mjs')];
  if (existsSync(host))
    for (const f of readdirSync(host, { recursive: true, encoding: 'utf8' })) {
      const path = join(host, f);
      const st = lstatSync(path);
      if (st.isFile()) start.push(path);
      else if (!st.isDirectory()) problems.push(`${relative(root, path)} isn’t a regular file or a folder`);
    }
  const checked = new Set();
  const queue = [...start];
  while (queue.length) {
    const file = /** @type {string} */ (queue.shift());
    if (checked.has(file)) continue;
    checked.add(file);
    const rel = relative(root, file);
    if (!allowed.some((dir) => file.startsWith(dir))) {
      problems.push(`${rel} is outside shared/ and server/remote/host/`);
      continue;
    }
    if (!existsSync(file)) {
      problems.push(`${rel} doesn’t exist`);
      continue;
    }
    for (const [, spec] of readFileSync(file, 'utf8').matchAll(SPECIFIERS)) {
      if (spec.startsWith('node:')) continue;
      if (spec.startsWith('./') || spec.startsWith('../')) queue.push(resolve(dirname(file), spec));
      else problems.push(`${rel} imports the package “${spec}”`);
    }
  }
  const files = [...checked]
    .filter((f) => allowed.some((dir) => f.startsWith(dir)) && existsSync(f))
    .map((f) => relative(root, f).split(sep).join('/'))
    .sort();
  for (const f of files) if (!SHIP_PATH_RE.test(f) || f.length > 100) problems.push(`${f} isn’t a name the install can carry`);
  return { files, problems };
}

/**
 * The files that ship, read, with the manifest and the tar.
 * @param {{ version: string, nodePath?: string | null, root?: string, mtime?: number }} o
 *   nodePath: the host’s nodePath setting, which goes in as node-path. mtime: seconds since the epoch, for each entry.
 * @returns {{ files: { path: string, data: Buffer, mode: number }[], manifest: string, tar: Buffer }}
 */
export function bundle({ version, nodePath = null, root = ROOT, mtime = Math.floor(Date.now() / 1000) }) {
  checkVersion(version);
  const { files: paths, problems } = hostFiles(root);
  if (problems.length) throw new Error(`Postbox’s host code can’t ship as it is: ${problems.join('; ')}.`);
  if (!paths.length) throw new Error('Postbox found none of its host code to install.');
  const files = paths.map((path) => {
    const full = join(root, ...path.split('/'));
    // The launcher is the one program run by name; everything else is read by node.
    return { path, data: readFileSync(full), mode: statSync(full).mode & 0o100 ? 0o700 : 0o600 };
  });
  const pkg = `${JSON.stringify({ name: 'postbox', version, private: true, type: 'module' }, null, 2)}\n`;
  files.push({ path: 'package.json', data: Buffer.from(pkg), mode: 0o600 });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = files.map((f) => `${sha256(f.data)}  ${f.path}\n`).join('');
  const entries = [...files, { path: MANIFEST, data: Buffer.from(manifest), mode: 0o600 }];
  if (nodePath !== null && nodePath !== undefined) {
    const c = checkHostPath(nodePath, 'nodePath');
    if (!c.ok) throw new TypeError(c.error);
    entries.push({ path: NODE_PATH_FILE, data: Buffer.from(`${c.value}\n`), mode: 0o600 });
  }
  return { files, manifest, tar: ustar(entries, mtime) };
}

/** @param {Buffer} data */
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/**
 * A ustar archive of regular files (POSIX.1-1988’s format, as pax(1) describes it): a 512-byte header per file, its
 * data padded to 512 bytes, then two zero blocks. Names are ASCII and at most 100 bytes (hostFiles checks), owners
 * are 0 with no names, and parent folders aren’t entries: tar makes them, under the host’s umask.
 * @param {{ path: string, data: Buffer, mode: number }[]} entries @param {number} mtime
 */
export function ustar(entries, mtime) {
  const blocks = [];
  for (const e of entries) {
    if (!SHIP_PATH_RE.test(e.path) || e.path.length > 100) throw new TypeError(`${e.path} can’t be a ustar name.`);
    const h = Buffer.alloc(512);
    /** @param {string} s @param {number} at @param {number} len */
    const put = (s, at, len) => h.write(s, at, len, 'ascii');
    /** An octal field: digits, zero-padded, then NUL. @param {number} n @param {number} len */
    const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
    put(e.path, 0, 100);
    put(oct(e.mode, 8), 100, 8);
    put(oct(0, 8), 108, 8); // uid
    put(oct(0, 8), 116, 8); // gid
    put(oct(e.data.length, 12), 124, 12);
    put(oct(mtime, 12), 136, 12);
    h.fill(0x20, 148, 156); // the checksum counts its own field as spaces
    put('0', 156, 1); // a regular file
    put('ustar\0', 257, 6);
    put('00', 263, 2);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
    blocks.push(h, e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ── The remote commands ─────────────────────────────────────────────────────────────

/** A version the host’s paths and a shell can both take, else a TypeError. @param {string} version */
function checkVersion(version) {
  hostPaths('/', version);
  // hostPaths allows letters, digits, . + and -; checked again here, since a shell reads it.
  if (!/^[A-Za-z0-9.+-]+$/.test(version)) throw new TypeError(`“${version}” isn’t a version Postbox installs.`);
  return version;
}

// The node check, for a host with neither sha256sum nor shasum: each manifest line’s hash against its file’s. It sits
// in the script’s double quotes, so its strings are template literals with escaped backquotes, and it has no $ or !.
const NODE_CHECK = [
  'const c=require(`node:crypto`),f=require(`node:fs`);let bad=0;',
  `for(const l of f.readFileSync(\`${MANIFEST}\`,\`utf8\`).split(String.fromCharCode(10))){`,
  'if(l.length==0)continue;const h=l.slice(0,64),p=l.slice(66);let s=``;',
  'try{s=c.createHash(`sha256`).update(f.readFileSync(p)).digest(`hex`)}catch{}',
  'if(s==h)continue;bad=1;console.log(p+`: FAILED`)}process.exit(bad)',
]
  .join('')
  .replaceAll('`', '\\`');

/**
 * The install script, joined into one line (the top of this file says why). $1 is the version, which installCommand
 * checks. Every path starts with $HOME, which must be absolute, so none can be read as an option, and neither
 * ~/.postbox-remote nor the version’s folder may be a symbolic link, so nothing outside ~/.postbox-remote changes.
 * Exit codes are SCRIPT_EXITS’; any other failure (a folder it can’t make, say) exits as set -e does, with the
 * command’s own message on stderr.
 *
 * A version that’s there is present only when its manifest is the incoming one, byte for byte (`same`; the x keeps
 * trailing new lines, which $(…) drops), and its files pass the same check (`check`, run in its folder). Anything
 * else at that path (other code under the same version, a changed file, a folder that isn’t a complete install) is
 * replaced: the old folder renamed aside, the new one renamed in, the old one removed. All of that happens holding the
 * version’s start lock, ~/.postbox-remote/locks/<version>.lock (hostPaths().lock, a folder made with mkdir), which an
 * attach holds while it starts `host serve`, before there’s a daemon.pid (daemon.mjs’s takeLock). It’s outside the
 * version’s folder, so renaming that folder doesn’t move it, and an attach makes nothing in the folder without it.
 * Once made, it gets this shell’s owner record, `me` (proc.mjs, “The start lock’s owner”: $$, and where there’s /proc
 * the boot ID and start time, as `live` reads them; the PID alone without), written beside it and renamed in. A lock
 * this can’t take stops it with 75 (an attach is starting the daemon; install again in a moment), unless it’s `dead`:
 * its owner record names a process that isn’t `live`, or it has had no record for more than a minute (daemon.mjs’s
 * LOCK_STALE_MS is shorter). That one is removed, as takeLock does: under `<lock>.break`, judged once more there, set
 * aside and removed. The break lock holds `me` too, from the moment it’s there (`takeb`: made beside it with the
 * record in it, then moved in; one that’s there already makes mv put it inside instead, so it isn’t `mine`, and it
 * goes). One this can’t take stops it with 75, unless it’s `dead` by the same rules, its breaker gone (`unb`: moved
 * aside, judged once more there, and put back if it’s live after all), and then this tries once more. The age tests
 * are find’s -mmin +1, which GNU, BSD and BusyBox find have (POSIX find has only -mtime); a find without it finds
 * nothing, so the lock counts as held. Age alone never breaks a lock or a break lock whose owner is live, so one
 * suspended while it removes a stale lock keeps its break lock, and nobody else removes a lock meanwhile. Each is
 * dropped when the script exits, whichever way (the EXIT trap), only while it’s still `mine`: its record is `me` (or
 * still the temporary one this shell was writing), so a lock another broke and took is left to them. With it held, a daemon.pid or a turn’s runner.json of that version naming a live process stops it with 75
 * too; no daemon can start meanwhile, and no turn without a daemon. A record sed can’t read counts as live, so a
 * missing tool refuses rather than replaces. `live` is proc.mjs’s sameProcess in sh: the PID is alive and, where
 * there’s /proc, the boot ID and start time (stat’s field 22, counted after the command name’s last paren) are the
 * record’s; without /proc (macOS), an alive PID is enough. If something without the lock made the version’s folder
 * meanwhile, mv puts this one inside it: that’s removed, and it stops with 75.
 *
 * Tests only: with POSTBOX_INSTALL_TEST_WAIT set to a path, the script stops just before it takes the lock, makes
 * `<path>.paused`, and waits until the path exists; with POSTBOX_INSTALL_TEST_HOLD, it does the same just after it
 * has taken the lock, making `<path>.held`; with POSTBOX_INSTALL_TEST_BREAK, holding the break lock, between finding
 * the lock stale and removing it, making `<path>.breaking` (tests/integration/remote-install.test.mjs). sshd passes them only if the
 * host’s own configuration says to, and they can only delay this install.
 */
export const INSTALL_SCRIPT = `
  set -eu;
  umask 077;
  v=$1;
  say() { printf "postbox install: %s\\n" "$1" >&2; };
  case $HOME in /*) ;; *) say "HOME is not an absolute path"; exit 78;; esac;
  r=$HOME/${REMOTE_DIR};
  d=$r/$v;
  b=.install-$v-$$;
  t=$r/$b;
  o=$r/.old-$v-$$;
  lk=$r/locks/$v.lock;
  h="";
  hb="";
  if [ -L "$r" ] || [ -L "$d" ] || [ -L "$r/locks" ]; then say "$r, $d or $r/locks is a symbolic link; Postbox installs only into real folders"; exit 77; fi;
  busy() { say "Postbox $v is running on this host with different code; stop its turns, then install again"; exit 75; };
  starting() { say "Postbox $v is starting on this host; install again in a moment"; exit 75; };
  field() { sed -n "s/.*.$1.:[^0-9A-Za-z]*\\([0-9A-Za-z.+-]*\\).*/\\1/p" "$2"; };
  live() {
  [ -f "$1" ] || return 1;
  j=$1;
  p=$(field pid "$j") || return 0;
  case $p in ""|0*|*[A-Za-z.+-]*) return 1;; esac;
  kill -0 "$p" 2>/dev/null || [ -d "/proc/$p" ] || return 1;
  if [ -r /proc/sys/kernel/random/boot_id ] && [ -r "/proc/$p/stat" ]; then :; else return 0; fi;
  [ "$(field bootId "$j")" = "$(cat /proc/sys/kernel/random/boot_id)" ] || return 1;
  s=$(cat "/proc/$p/stat") || return 0;
  s=\${s##*)};
  set -- $s;
  [ $# -ge 20 ] || return 0;
  shift 19;
  [ "$1" = "$(field startTime "$j")" ]; };
  me="{\\"pid\\":$$}";
  self() {
  [ -r /proc/sys/kernel/random/boot_id ] && [ -r "/proc/$$/stat" ] || return 0;
  s=$(cat "/proc/$$/stat") || return 0;
  s=\${s##*)};
  set -- $s;
  [ $# -ge 20 ] || return 0;
  shift 19;
  me="{\\"pid\\":$$,\\"bootId\\":\\"$(cat /proc/sys/kernel/random/boot_id)\\",\\"startTime\\":$1}"; };
  self;
  dead() { if [ -f "$1/${LOCK_OWNER}" ]; then if live "$1/${LOCK_OWNER}"; then return 1; fi; return 0; fi; [ -n "$(find "$1" -prune -mmin +1 2>/dev/null)" ]; };
  mine() { [ "$(cat "$1/${LOCK_OWNER}" 2>/dev/null)" = "$me" ] || [ -e "$1/.${LOCK_OWNER}.$$" ]; };
  drop() { if mine "$1"; then rm -rf "$1.free.$$"; mv "$1" "$1.free.$$" && rm -rf "$1.free.$$" || true; fi; };
  takeb() { q=$lk.break.new.$$; rm -rf "$q"; mkdir "$q" && printf "%s\\n" "$me" > "$q/${LOCK_OWNER}" && mv "$q" "$lk.break" 2>/dev/null && mine "$lk.break" && return 0; rm -rf "$q" "$lk.break/\${q##*/}"; return 1; };
  unb() { g=$lk.break.gone.$$; dead "$lk.break" || return 0; rm -rf "$g"; mv "$lk.break" "$g" 2>/dev/null || return 0; if dead "$g" || [ -e "$lk.break" ]; then rm -rf "$g"; else mv "$g" "$lk.break" 2>/dev/null || rm -rf "$g"; fi; };
  clean() { cd /; rm -rf "$t"; if [ -n "$h" ]; then drop "$lk"; fi; if [ -n "$hb" ]; then drop "$lk.break"; fi; };
  trap clean EXIT;
  mkdir -p "$r";
  chmod 700 "$r";
  rm -rf "$t";
  mkdir "$t";
  tar -x -f - -C "$t" || { say "tar could not unpack the files"; exit 65; };
  cd "$t";
  n="";
  if [ -f ${NODE_PATH_FILE} ]; then n=$(cat ${NODE_PATH_FILE}); fi;
  if [ -z "$n" ]; then n=$(command -v node 2>/dev/null || true); fi;
  if command -v sha256sum >/dev/null 2>&1; then k=sha256sum;
  elif command -v shasum >/dev/null 2>&1; then k=shasum;
  elif [ -n "$n" ] && [ -x "$n" ]; then k=node;
  else say "found no sha256sum, shasum or node to check the files with"; exit 69; fi;
  out="";
  check() { case $k in
  sha256sum) out=$(sha256sum -c ${MANIFEST} 2>&1);;
  shasum) out=$(shasum -a 256 -c ${MANIFEST} 2>&1);;
  *) out=$("$n" -e "${NODE_CHECK}" 2>&1);; esac; };
  same() { [ -f "$2" ] && [ "$(cat "$1"; echo x)" = "$(cat "$2"; echo x)" ]; };
  if check; then :; else printf "%s\\n" "$out" | grep -v -e ": OK" >&2 || true; say "checksums did not match"; exit 66; fi;
  if [ -d "$d" ] && same ${MANIFEST} "$d/${MANIFEST}" && (cd "$d" && check); then
  if [ -f ${NODE_PATH_FILE} ]; then mv -f ${NODE_PATH_FILE} "$d/${NODE_PATH_FILE}"; else rm -f "$d/${NODE_PATH_FILE}"; fi;
  echo "present $v"; exit 0; fi;
  cd /;
  if [ -n "\${POSTBOX_INSTALL_TEST_WAIT:-}" ]; then : > "$POSTBOX_INSTALL_TEST_WAIT.paused"; until [ -e "$POSTBOX_INSTALL_TEST_WAIT" ]; do sleep 1; done; fi;
  mkdir -p "$r/locks";
  chmod 700 "$r/locks";
  if mkdir "$lk" 2>/dev/null; then :;
  elif dead "$lk" && { takeb || { unb; takeb; }; }; then
  hb=1;
  if dead "$lk"; then if [ -n "\${POSTBOX_INSTALL_TEST_BREAK:-}" ]; then : > "$POSTBOX_INSTALL_TEST_BREAK.breaking"; until [ -e "$POSTBOX_INSTALL_TEST_BREAK" ]; do sleep 1; done; fi; mv "$lk" "$lk.stale.$$" 2>/dev/null || true; rm -rf "$lk.stale.$$"; fi;
  drop "$lk.break";
  hb="";
  mkdir "$lk" 2>/dev/null || starting;
  else starting; fi;
  h=1;
  printf "%s\\n" "$me" > "$lk/.${LOCK_OWNER}.$$";
  mv -f "$lk/.${LOCK_OWNER}.$$" "$lk/${LOCK_OWNER}";
  if [ -n "\${POSTBOX_INSTALL_TEST_HOLD:-}" ]; then : > "$POSTBOX_INSTALL_TEST_HOLD.held"; until [ -e "$POSTBOX_INSTALL_TEST_HOLD" ]; do sleep 1; done; fi;
  if [ -e "$d" ]; then
  if live "$d/daemon.pid"; then busy; fi;
  for f in "$r"/turns/*/runner.json; do if [ -f "$f" ]; then w=$(field version "$f") || busy; if [ "$w" = "$v" ] && live "$f"; then busy; fi; fi; done;
  say "replacing $d, whose files are not these";
  mv "$d" "$o"; fi;
  mv "$t" "$d";
  rm -rf "$o";
  if [ -e "$d/$b" ]; then rm -rf "$d/$b"; say "something made $d again while this installed"; starting; fi;
  echo "installed $v"
`
  .trim()
  .split('\n')
  .map((l) => l.trim())
  .join(' ');

/**
 * The command sshd runs to install one version, through the login shell. The script never changes; only the
 * version, checked, follows it as $1.
 * @param {string} version
 */
export function installCommand(version) {
  return `/bin/sh -c '${INSTALL_SCRIPT}' postbox-install ${checkVersion(version)}`;
}

/**
 * The command sshd runs to make and print the token: the version’s launcher, as remoteCommand names it, with `token`.
 * @param {string} version
 */
export function tokenCommand(version) {
  checkVersion(version);
  return remoteCommand(version).replace(/ attach$/, ' token');
}

/**
 * ssh’s arguments for a remote command: sshArgs’ fixed options and destination, with `command` in place of attach’s.
 * @param {{ name: string, settings: import('../../shared/remote-settings.mjs').HostSettings }} host
 * @param {string} version @param {string} command
 */
export function installArgs(host, version, command) {
  const args = sshArgs({ destination: host.name, settings: host.settings, version });
  if (args.at(-1) !== remoteCommand(version)) throw new Error('ssh’s arguments don’t end with the remote command.');
  return [...args.slice(0, -1), command];
}

// ── Installing ──────────────────────────────────────────────────────────────────────

/**
 * Runs ssh once: `input` on its stdin, then stdout and stderr when it exits.
 * @param {{ spawn: import('./ssh.mjs').SpawnLike, program: string, args: string[], input: Buffer | null, timeout: number,
 *   destination: string, setTimer: (fn: () => void, ms: number) => any, clearTimer: (t: any) => void }} o
 * @returns {Promise<{ code: number | null, signal: string | null, stdout: string, stderr: string }>}
 */
function run({ spawn, program, args, input, timeout, destination, setTimer, clearTimer }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(failure('failed', destination, { why: `Postbox couldn’t start ssh: ${e.message}` }));
      return;
    }
    const out = [];
    const err = [];
    let done = false;
    let timedOut = false;
    const timer = setTimer(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    const finish = (/** @type {() => void} */ settle) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      settle();
    };
    child.stdout.on('data', (b) => out.push(Buffer.from(b)));
    child.stderr.on('data', (b) => err.push(Buffer.from(b)));
    child.stdin.on('error', () => {}); // ssh exited before reading it all; its exit says why
    child.on('error', (e) =>
      finish(() =>
        reject(
          failure('failed', destination, {
            why: e.code === 'ENOENT' ? `ssh isn’t installed or isn’t on PATH (${program}).` : `Postbox couldn’t start ssh: ${e.message}`,
          }),
        ),
      ),
    );
    child.on('close', (code, signal) =>
      finish(() => {
        if (timedOut) reject(failure('unreachable', destination, { why: `The host didn’t finish within ${Math.round(timeout / 1000)} seconds.` }));
        else resolve({ code, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
      }),
    );
    child.stdin.end(input ?? undefined);
  });
}

/** The last line of a text that says something. @param {string} text */
const lastLine = (text) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1) ?? '';

/**
 * A protocol `error` line on stdout (the launcher’s, or the daemon’s main), if there is one.
 * @param {string} stdout @returns {{ code: string, message: string } | null}
 */
function errorLine(stdout) {
  for (const line of stdout.split('\n')) {
    try {
      const m = JSON.parse(line);
      if (m?.type === 'error' && typeof m.message === 'string') return { code: String(m.code), message: m.message };
    } catch {}
  }
  return null;
}

/**
 * The install run’s outcome: whether it installed, or found the version there, else an SshFailure.
 * @param {string} d  the destination @param {string} version @param {{ code: number | null, signal: string | null, stdout: string, stderr: string }} r
 * @returns {boolean} installed
 */
export function installOutcome(d, version, r) {
  if (r.code === 255) throw classifyExit({ destination: d, code: r.code, signal: r.signal, stderr: r.stderr });
  const said = lastLine(r.stdout);
  if (r.code === 0 && said === `installed ${version}`) return true;
  if (r.code === 0 && said === `present ${version}`) return false;
  const known = r.code !== null ? SCRIPT_EXITS[/** @type {keyof typeof SCRIPT_EXITS} */ (r.code)] : undefined;
  const stderr = r.stderr.replace(/\r\n?/g, '\n');
  const quote = lastLine(stderr.replace(/^postbox install: .*$/gm, '')) || lastLine(stderr);
  // 75 from starting(), not busy(): an attach holds the version’s start lock, so it’s worth trying again soon.
  const starting = r.code === 75 && /^postbox install: Postbox \S+ is starting on this host/m.test(stderr);
  const why =
    r.code === 75
      ? `Postbox ${version} is ${starting ? 'starting' : 'running'} on ${d} with different code`
      : known
        ? `${known}${r.code === 66 && quote ? ` (${quote})` : ''}`
        : r.code === 0
          ? `the host answered “${said.slice(0, 200)}” instead of saying it installed`
          : `the install ended with ${r.signal ?? `exit status ${r.code}`}${quote ? `: “${quote.slice(0, 300)}”` : ''}`;
  const where = `~/${REMOTE_DIR}/${version}`;
  const next = starting
    ? `Install again in a moment. If Postbox then says it’s running on ${d}, stop its turns there first.`
    : r.code === 75
      ? `Stop its turns on ${d}, then install again. Its daemon exits on its own once no turn runs and Postbox isn’t attached for the host’s idle time.`
      : r.code === 77
        ? `On ${d}, replace the symbolic link at ~/${REMOTE_DIR}, ${where} or ~/${REMOTE_DIR}/locks with a folder of your own, then install again.`
        : r.code === 69
          ? `Install coreutils (for sha256sum) or Node 22 or later on ${d}, then install again.`
          : `Install again. If it fails the same way, run \`ssh ${d}\` in a terminal and check that ~/${REMOTE_DIR} can be written and the disk isn’t full.`;
  throw new SshFailure('failed', `Postbox couldn’t install its host program on ${d}: ${why}.`, next, {
    code: r.code,
    signal: r.signal,
    stderr,
  });
}

/**
 * The token run’s outcome: the token, else an SshFailure.
 * @param {string} d @param {{ code: number | null, signal: string | null, stdout: string, stderr: string }} r
 * @returns {string}
 */
export function tokenOutcome(d, r) {
  if (r.code === 255) throw classifyExit({ destination: d, code: r.code, signal: r.signal, stderr: r.stderr });
  const detail = { code: r.code, signal: r.signal, stderr: r.stderr };
  const refused = errorLine(r.stdout);
  if (refused)
    throw new SshFailure(
      refused.code === 'no-node' ? 'no-node' : 'failed',
      `Postbox installed its files on ${d}, but its host program couldn’t start there. It said: “${refused.message}”`,
      refused.code === 'no-node'
        ? `Install Node 22 or later on ${d}, or set its Node path in Postbox’s host settings, then install again.`
        : 'Fix that on the host, then install again.',
      detail,
    );
  if (r.code === 127 || r.code === 126) throw classifyExit({ destination: d, code: r.code, signal: r.signal, stderr: r.stderr });
  const token = lastLine(r.stdout);
  if (r.code === 0 && TOKEN_RE.test(token)) return token;
  throw new SshFailure(
    'failed',
    `Postbox installed its files on ${d}, but didn’t get the daemon’s token back${r.code ? ` (exit status ${r.code})` : ''}.${lastLine(r.stderr) ? ` The host said: “${lastLine(r.stderr).slice(0, 300)}”` : ''}`,
    `Install again. If it fails the same way, check ~/${REMOTE_DIR}/token on ${d}: it should be a file of yours, holding one line.`,
    detail,
  );
}

/**
 * Installs this Postbox’s host code on a host and gets its daemon’s token, which it keeps on the laptop.
 * @param {{ host: { id: string, name: string, settings: import('../../shared/remote-settings.mjs').HostSettings },
 *   version: string, dataDir: string, spawn?: import('./ssh.mjs').SpawnLike, program?: string, root?: string,
 *   setTimer?: (fn: () => void, ms: number) => any, clearTimer?: (t: any) => void, installTimeout?: number,
 *   tokenTimeout?: number, mtime?: number }} o
 *   host: as the runtime keeps it (its name is the ssh destination). version: Postbox’s package version. dataDir: the
 *   data folder server/index.mjs uses (`data/` by default). spawn and program run ssh; the rest are for tests.
 * @returns {Promise<{ token: string, installed: boolean, version: string }>} installed: false when the version was there
 * @throws {SshFailure} with a message and the next step, or a TypeError for an invalid host, version or nodePath
 */
export async function installHost({
  host,
  version,
  dataDir,
  spawn = /** @type {import('./ssh.mjs').SpawnLike} */ (/** @type {unknown} */ (nodeSpawn)),
  program = 'ssh',
  root = ROOT,
  setTimer = (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer = (t) => clearTimeout(t),
  installTimeout = INSTALL_TIMEOUT,
  tokenTimeout = TOKEN_TIMEOUT,
  mtime,
}) {
  const file = tokenFile(dataDir, host?.id);
  const install = installArgs(host, version, installCommand(version));
  const token = installArgs(host, version, tokenCommand(version));
  const { tar } = bundle({ version, nodePath: host.settings?.nodePath ?? null, root, mtime });
  const d = host.name;
  const common = { spawn, program, destination: d, setTimer, clearTimer };
  const installed = installOutcome(d, version, await run({ ...common, args: install, input: tar, timeout: installTimeout }));
  const got = tokenOutcome(d, await run({ ...common, args: token, input: null, timeout: tokenTimeout }));
  await storeToken(file, got);
  return { token: got, installed, version };
}

// ── The laptop’s copy of the token ──────────────────────────────────────────────────

/** The token’s file on the laptop. @param {string} dataDir @param {unknown} hostId */
export function tokenFile(dataDir, hostId) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('Postbox’s data folder is needed to keep a host’s token.');
  if (typeof hostId !== 'string' || !HOST_ID_RE.test(hostId)) throw new TypeError(`“${String(hostId).slice(0, 80)}” isn’t a host ID.`);
  return join(dataDir, TOKENS_DIR, hostId);
}

/** Writes the token, 0600, in a 0700 folder: a temporary file beside it, then rename. @param {string} file @param {string} token */
async function storeToken(file, token) {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * A host’s token as the laptop keeps it, or null when there’s none (not installed from this Postbox, or forgotten).
 * A file that isn’t a regular file, or doesn’t hold a token, is no token.
 * @param {{ dataDir: string, hostId: string }} o
 * @returns {Promise<string | null>}
 */
export async function readToken({ dataDir, hostId }) {
  const file = tokenFile(dataDir, hostId);
  try {
    if (!(await lstat(file)).isFile()) return null;
    const token = (await readFile(file, 'utf8')).trim();
    return TOKEN_RE.test(token) ? token : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Forgets a host’s token on the laptop, as when the host is removed. Resolves with whether there was one.
 * @param {{ dataDir: string, hostId: string }} o
 */
export async function forgetToken({ dataDir, hostId }) {
  const file = tokenFile(dataDir, hostId);
  try {
    await lstat(file);
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
  await rm(file, { force: true });
  return true;
}

// ── The confirm ─────────────────────────────────────────────────────────────────────

/**
 * What an install does, for the confirm the UI shows before the first one (L6): the paths it writes on each machine
 * and the steps, in words, and the command lines ssh runs.
 * @param {{ id: string, name: string, settings: import('../../shared/remote-settings.mjs').HostSettings }} host
 * @param {{ version: string, dataDir: string, root?: string }} o
 */
export function describeInstall(host, { version, dataDir, root = ROOT }) {
  checkVersion(version);
  const d = host.name;
  const code = `~/${REMOTE_DIR}/${version}`;
  const tokenOnHost = `~/${REMOTE_DIR}/token`;
  const tokenHere = tokenFile(dataDir, host.id);
  const nodePath = host.settings?.nodePath ?? null;
  const { files } = hostFiles(root);
  const count = files.length + 1; // and package.json
  const steps = [
    `Connect to ${d} with your ssh, as your user there, without asking for a password or a new host key.`,
    `Copy ${count} files of Postbox’s host program to ${code}/ on ${d}, readable only by you (folders 0700, files 0600), and check each one’s SHA-256. A copy of ${version} that’s already there is left as it is if its files are these; if they differ, it’s replaced, unless it’s running.`,
    nodePath
      ? `Write ${code}/node-path on ${d}, naming the Node it runs with: ${nodePath}.`
      : `Find Node 22 or later on ${d}: on PATH, else under ~/.nvm, ~/.local/share/mise, ~/.volta, /usr/local/bin or /usr/bin.`,
    `Make the daemon’s token at ${tokenOnHost} on ${d} (0600) if it isn’t there, and keep a copy on this computer at ${tokenHere} (0600), outside what the page reads.`,
  ];
  return {
    destination: d,
    version,
    host: { root: `~/${REMOTE_DIR}`, code, token: tokenOnHost, nodePath: nodePath ? `${code}/node-path` : null },
    laptop: { token: tokenHere },
    steps,
    commands: [installCommand(version), tokenCommand(version)],
    text: `Install Postbox’s host program on ${d}? This writes outside Postbox’s folder on both computers:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nNothing runs as root, and nothing outside ~/${REMOTE_DIR} changes on ${d}.`,
  };
}
