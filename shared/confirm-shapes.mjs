// #852 slice 1a r3: the only commands a confirm’s `commands` field may hold, read the same way when the confirm is
// shown (the catalog refuses anything else) and when the call comes (Postbox runs exactly these words). Packet:
// sprint4/852-s1a-confirm-packet-r3.md. One line, one command: a lone git push, which Postbox makes itself
// (push-on-request.mjs), or one of six gh shapes, which Postbox runs with no shell (server/confirm-run.mjs).

/**
 * The words of one command, or null. Spaces split them; '…' and "…" quote a word, taken exactly, with nothing expanded
 * and no escapes (no shell ever reads them: Postbox runs the words itself). A word outside quotes holds only letters,
 * digits and ./:@#%+,=-, and no word holds a tab, a line break or a control character.
 * @param {string} text @returns {string[] | null}
 */
export function shapeWords(text) {
  if (/[\p{Cc}]/u.test(text)) return null;
  const out = [];
  const re = /"([^"]*)"(?= |$)|'([^']*)'(?= |$)|([\w./:@#%+,=-]+)(?= |$)/uy;
  let i = 0;
  while (i < text.length) {
    if (text[i] === ' ') {
      i++;
      continue;
    }
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) return null;
    out.push(m[1] ?? m[2] ?? m[3]);
    i = re.lastIndex;
  }
  return out;
}

const REPO = /^[\w.-]+\/[\w.-]+$/;
const BRANCH = /^[\w./-]+$/;
const NUMBER = /^\d+$/;
/** Flags that may repeat; every other one is allowed once. */
const REPEATS = new Set(['--label', '--add-label', '--remove-label']);
/** Flags that take no value. */
const BARE = new Set(['--draft']);
/**
 * gh’s six shapes: [noun, verb, takes a number, flags allowed besides --repo, flags required besides --repo].
 * @type {[string, string, boolean, string[], string[]][]}
 */
const GH = [
  ['pr', 'create', false, ['--head', '--title', '--body-file', '--base', '--draft', '--label'], ['--head']],
  ['pr', 'edit', true, ['--title', '--body-file', '--add-label', '--remove-label', '--base'], []],
  ['pr', 'comment', true, ['--body-file'], ['--body-file']],
  ['issue', 'create', false, ['--title', '--body-file', '--label'], []],
  ['issue', 'edit', true, ['--title', '--body-file', '--add-label', '--remove-label'], []],
  ['issue', 'comment', true, ['--body-file'], ['--body-file']],
];
// As push-on-request.mjs’s pushOf reads a push: its flags and branch names, so a confirm shows only pushes it makes.
const GIT_PUSH_FLAGS = new Set(['-u', '--set-upstream', '-q', '--quiet', '-v', '--verbose']);
const PUSH_BRANCH = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?!.*\/\.)[A-Za-z0-9_][A-Za-z0-9._/-]*(?<![./])(?<!\.lock)$/;

/**
 * What a confirm’s command is: a push Postbox makes, a gh call Postbox runs, or why it’s neither.
 * @param {string} text
 * @returns {{ kind: 'push' } | { kind: 'gh', argv: string[], repo: string, bodyFile: string | null } | { kind: 'none', why: string }}
 */
export function confirmShape(text) {
  const w = shapeWords(String(text ?? ''));
  if (!w?.length) return { kind: 'none', why: 'isn’t one plain command: outside quotes, only letters, digits, spaces and ./:@#%+,=- may appear' };
  if (w[0] === 'git') return gitPush(w);
  if (w[0] !== 'gh') return { kind: 'none', why: 'isn’t a git push or one of the gh commands a confirm may run' };
  const [, noun, verb, ...rest] = w;
  const shape = GH.find(([n, v]) => n === noun && v === verb);
  if (!shape) return { kind: 'none', why: `runs gh ${noun ?? ''} ${verb ?? ''}, which a confirm can’t: only gh pr or issue create, edit and comment` };
  const [, , numbered, allowed, required] = shape;
  if (numbered && !NUMBER.test(rest.shift() ?? '')) return { kind: 'none', why: `needs the ${noun}’s number right after gh ${noun} ${verb}` };
  /** @type {Map<string, string | true>} */
  const seen = new Map();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag !== '--repo' && !allowed.includes(flag)) return { kind: 'none', why: `has ${flag}, which gh ${noun} ${verb} here doesn’t take` };
    if (seen.has(flag) && !REPEATS.has(flag)) return { kind: 'none', why: `has ${flag} twice` };
    const value = BARE.has(flag) ? true : rest[++i];
    if (value !== true && (value === undefined || value.startsWith('-'))) return { kind: 'none', why: `has ${flag} with no value, or one that starts with -` };
    seen.set(flag, value);
  }
  const repo = seen.get('--repo');
  if (typeof repo !== 'string' || !REPO.test(repo)) return { kind: 'none', why: 'needs --repo owner/name, once' };
  for (const flag of required) if (!seen.has(flag)) return { kind: 'none', why: `needs ${flag}` };
  for (const flag of ['--head', '--base']) {
    const branch = seen.get(flag);
    if (typeof branch === 'string' && (!BRANCH.test(branch) || branch.includes('..')))
      return { kind: 'none', why: `has ${flag} ${branch}, which isn’t a plain branch name` };
  }
  const given = seen.get('--body-file');
  const bodyFile = typeof given === 'string' ? given : null;
  if (bodyFile !== null && !bodyFile.startsWith('/')) return { kind: 'none', why: 'has a --body-file that isn’t an absolute path' };
  return { kind: 'gh', argv: w.slice(1), repo, bodyFile };
}

/** A lone `git push [origin] [<branch>]`, which push-on-request.mjs’s pushOf reads the same way. */
/** @param {string[]} w @returns {{ kind: 'push' } | { kind: 'none', why: string }} */
function gitPush(w) {
  const [, sub, ...rest] = w;
  const plain = rest.filter((x) => !GIT_PUSH_FLAGS.has(x));
  const [remote, branch, ...more] = plain;
  const ok = sub === 'push' && !plain.some((x) => x.startsWith('-')) && !more.length && (remote === undefined || remote === 'origin');
  if (!ok || (branch !== undefined && branch !== 'HEAD' && !PUSH_BRANCH.test(branch))) return { kind: 'none', why: 'isn’t a lone git push [origin] [branch]' };
  return { kind: /** @type {const} */ ('push') };
}
