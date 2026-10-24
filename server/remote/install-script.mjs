// The two remote commands an install runs over ssh (install.mjs, whose header is the design): the install script,
// one line in single quotes, with the version as its $1, and the launcher’s `token`.
// lint-allow-file quotes: INSTALL_SCRIPT is a shell script, whose straight quotes are the shell’s.

import { REMOTE_DIR } from '../../shared/remote-protocol.mjs';
import { LOCK_OWNER } from './host/proc.mjs';
import { checkVersion, MANIFEST, NODE_PATH_FILE } from './install-bundle.mjs';
import { remoteCommand, sshArgs } from './ssh.mjs';

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
 * The install script, joined into one line (the top of install.mjs says why). $1 is the version, which installCommand
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
