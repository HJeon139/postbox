// Where server code reads items, work and apps, and which of the two reads it uses (#601, designs/508/601-held-view.md).
// The published reads (store.items(), item(), findItem(), and store.state directly) show only what was applied. The
// pending reads (store.pending, and the ledger's entries(), which uses it) show what is held behind a commit too. The
// rule: a reader whose result decides a write the turn or a sweep makes reads pending; a reader whose result leaves
// the process (the page, a read tool, a prompt, an HTTP answer), or a write the person aims at one item they can see,
// reads published. Every site is placed here by file and enclosing function, so a new reader of either kind fails until
// it is placed (the integrator's review of #611: a guard of pending sites alone let a new published reader through).
// Production commits are placed too: a commit in front of held emits that touches these lists makes a pending read
// inexact (§5). Lines the formatter split (`rt.store\n  .items(`) are joined before matching. Forms it can't follow
// fail outright: destructuring `pending`, `items`, `work` or `apps` out of the store or the state, reaching them by a
// string key, binding the store, its pending reads or the ledger to a local, and calling items(), item(), findItem()
// or work() on anything but the store or its pending reads (the integrator's second review of #611: `const st =
// rt.store; st.items(t)` passed), or through call, apply or bind. Optional chaining is read as a plain member. The guard
// reads source text, not the program, so a form it doesn't match passes: review still reads what it can't. It reads every .mjs, .js and .cjs file under server/ except the store's own and server/remote/host/,
// the host daemon, which has no store. Sessions, schedules and the rest have no pending read (§ Not in this change).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

/** store.items(), item() and findItem(): published reads. */
const PUBLISHED = {
  'apps.mjs': ['appEvent', 'resolveAppSend'], // the page’s app events and an app send it answers: what the person sees
  'blocks.mjs': ['act', 'answerDelivered'], // the person’s answer to a block they see
  'catch-up.mjs': ['catchUp', 'pointerIfSeen'], // the prompt for a later turn
  'permission-cards.mjs': ['resolvePermission', 'resolveDenial', 'resolveDenial'], // the person’s answer to a card they see
  'queue-batch.mjs': ['latestMessage'], // the person’s queued messages
  'reactions.mjs': ['toggleReaction', 'reactTool'], // a reaction aimed at an item the person or the agent sees
  'read-message.mjs': ['readMessage', 'readMessage'], // a read tool (T-31)
  'remote/turns-snapshot.mjs': ['readable'], // the snapshot sent to a host: it leaves the process
  'review-comments.mjs': ['find'], // review_block on a block shown in the room
  'runtime.mjs': ['retry', 'resolveProposal', 'startTopic', 'topicRootLine', 'describeItem', 'readConversation', 'diagramCheck', 'stopShellCommand'], // a person’s action on an item they see, or a read tool and a prompt
  'scheduled-wakes.mjs': ['prepareScheduledRetry'], // the person’s Retry of a wake line they see
  'share-back.mjs': ['shareToConversation', 'shareToConversation'], // the person’s Share of an item they see
  'store-outage.mjs': ['settleOrphanTurns'], // at a reload, when nothing is held
  'telemetry-record.mjs': ['collect'], // a run’s record, after it
  'thread-summary.mjs': ['lineOf', 'lineOf', 'threadCatchUp', 'threadLines', 'readUpTo', 'summarizeThread', 'summarizeThread', 'reactionLines'], // prompts and summaries for a later turn
  'tool-ask.mjs': ['resolveToolAsk'], // the person’s answer to an ask they see
  'turn-marks.mjs': ['askedAgain', 'askedAgain'], // the person’s Retry of a reply they see
  'wake-cards.mjs': ['resolveHop'], // the person’s answer to a hop card they see
  'write-intent.mjs': ['requestOf', 'stopRequested', 'stopRequested'], // the request the person made, and their Stop on a line they see
};

/** Direct reads of state.items, state.work or state.apps: published reads. */
const DIRECT = {
  'apps.mjs': ['appCheck', 'appEvent', 'appState', 'appQuery', 'appFile'], // HTTP answers to the page about an app
  'index.mjs': ['start', 'route'], // /api/state and startup
  'ledger-git.mjs': ['gitState'], // the Work view’s git state: an answer to the page
  'ledger-answers.mjs': ['published'], // the Work view’s diff and output, answers to the page
  'ledger.mjs': ['expireStale'], // at startup
  'permission-cards.mjs': ['expireStalePermissions'], // at startup
  'room-checks-agy.mjs': ['deniedSteps'], // facts from a recorded run, offline
  'room-checks-backends.mjs': ['BACKEND_CHECKS'], // the same
  'room-checks-asks.mjs': ['droppedAsks', 'needsMismatches'], // the same
  'room-checks-telemetry.mjs': ['fiveWordRuns', 'secretsOf', 'CHECKS'], // the same
  'room-checks-threads.mjs': ['missingThreadTasks'], // the same
  'room-checks.mjs': ['itemsOf', 'ledgerEntries', 'CHECKS', 'CHECKS', 'CHECKS', 'CHECKS', 'CHECKS'], // the same
  'room-delivery.mjs': ['itemsOf'], // the same
  'room-unverified.mjs': ['uncheckedThreads'], // the same
  'runtime.mjs': ['describeItem', 'describeItem', 'expireStaleCommands'], // a read tool’s app line; expireStaleCommands at startup
  'telemetry-record.mjs': ['blockRow', 'workOf'], // a run’s record, after it
  'telemetry-report.mjs': ['liveFacts', 'liveFacts'], // the same
  'tool-ask.mjs': ['settleToolAsks'], // only the thread ids; each thread is read through store.pending
  'waiting-on-you.mjs': ['waitingOnYou'], // shared with the page, which has only what was broadcast
};

/** store.pending reads. */
const PENDING = {
  'app-retire.mjs': ['retireApp', 'retireApp', 'retireApp', 'release'], // retire_app of an app the turn may have just shown, and its sweep of open sends
  'apps.mjs': ['showApp', 'updateApp'], // show_app and update_app of an app the turn may have just shown
  'block-show.mjs': ['showBlock', 'showBlock', 'showBlock', 'shownAgain'], // show_block of an app or a block id the turn may have just shown
  'blocks.mjs': ['shownBy'], // update_block of a block the turn just showed
  'ledger.mjs': ['entries', 'recordPublishes', 'recordPublishes'], // the ledger reads back its own entries; the turn’s blocks and apps
  'lint-delivery.mjs': ['sendLint'], // the apps the turn showed, still being checked
  'permission-cards.mjs': ['recordDenial'], // the same refused call, once
  'permission-prompt.mjs': ['permission'], // the card the call waits on
  'remote/turns-end.mjs': ['stoppedHung'], // the hung host turn’s own replies
  'remote/turns-prompts.mjs': ['cardOf', 'openCards'], // a host turn’s own cards, and the sweep its callers settle
  'remote/turns-resume.mjs': ['reattach'], // the replayed turn’s replies, replaced in a sweep
  'runtime.mjs': [
    'addItem',
    'bringForward',
    'endWork',
    'endTurn',
    'endTurn',
    'recordStopped',
    'runningProgress',
    'setJobStep',
    'settleJobs',
    'checkTurn',
    'checkTurn',
    'checkTurn',
    'stallSteps',
    'runShellCommand',
    'runShellCommand',
    'pollMirror',
    'purgeSession',
  ], // the turn’s own items and apps, a move after a pending read, and sweeps that write back
  'side-threads.mjs': ['agentWake', 'endChain', 'archiveForks', 'bumpSideLink', 'bumpSideLink'], // the reply with the mention, a side line right after its add, and sweeps of hop cards
  'thread-erase.mjs': ['eraseThreads'], // a thread’s apps, removed in a sweep
  'tool-ask.mjs': ['askForTool', 'settleToolAsks'], // a second ask for the same tool, and the sweep that settles open asks
  'wake-cards.mjs': ['openCard'], // another wake’s held hop card, so a second isn’t made
  'write-intent.mjs': ['stillOpen'], // the turn’s own lines, and the person’s held Stop on one
};

/** Ledger.entries() and entry(), which read store.pending.work. */
const LEDGER = {
  'ledger-commands.mjs': ['turnEnded', 'commandSeen', 'compare', 'newCommits', 'newCommits', 'leftBranch'], // commands and commits the turn is recording
  'ledger-remote.mjs': ['hostEdit'], // a host edit the turn is recording
  'ledger-answers.mjs': ['restore'], // restore reads back the entry it just patched
  'ledger.mjs': ['entry', 'commandEnded', 'commandEnded', 'taskEnded', 'jobUpdate', 'endTurn', 'endTurn', 'endTurn', 'recordChange'], // entries the ledger patches as the turn goes
  'runtime.mjs': ['endWork'], // endWork’s line for the turn
  'thread-summary.mjs': ['summarizeThread'], // the summary’s cost, patched on its entry
  'write-intent.mjs': ['madeBy', 'judged'], // the PRs this conversation made, and the judge’s cost
};

/** Production commits, with the lists each touches. None on main. */
const COMMITS = {};

const DECL =
  /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:async\s+)?(?!if\b|for\b|while\b|switch\b|catch\b)(\w+)\s*\([^)]*\)\s*\{\s*$|^(?:export\s+)?const\s+(\w+)\s*=/;
/** The function a line is in: the nearest declaration above it. @param {string[]} lines @param {number} i */
function enclosing(lines, i) {
  for (let j = i; j >= 0; j--) {
    const m = lines[j].match(DECL);
    if (m) return m[1] ?? m[2] ?? m[3];
  }
  return '(top)';
}
/** Optional chaining read as a plain member, so `rt.store?.items(` is placed as `rt.store.items(` is. @param {string} t */
const normalized = (t) => t.replace(/\?\.(?=[A-Za-z_$])/g, '.');
/** Each server file's source, with the lines the formatter split joined. @returns {[string, string][]} */
function sources(dir = new URL('../server', import.meta.url).pathname, rel = '', out = /** @type {[string, string][]} */ ([])) {
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (path !== 'remote/host') sources(dir, path, out);
      continue;
    }
    if (!/\.(mjs|js|cjs)$/.test(e.name) || ['store.mjs', 'store-held.mjs'].includes(path)) continue;
    const text = normalized(readFileSync(join(dir, path), 'utf8'))
      .replace(/\s*\n\s*(?=\.[A-Za-z_(])/g, '')
      .replace(/\(\s*\n\s*/g, '(')
      .replace(/\s*\n\s*(?=\()/g, '');
    out.push([path, text]);
  }
  return out;
}
/** file → the enclosing function of each line matching `re`, in order. @param {RegExp} re */
function sites(re) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [path, text] of sources()) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (re.test(line) && !/^\s*(\/\/|\*)/.test(line)) (out[path] ??= []).push(enclosing(lines, i));
    });
  }
  return out;
}
const placed = (re, table, what) =>
  assert.deepEqual(
    sites(re),
    table,
    `${what} changed: place each site, with its reason, by the rule at the top of this file. Found: ${JSON.stringify(sites(re))}`,
  );

test('every published read of items, work and apps in server/ is placed, by file and function', () => {
  placed(/\bstore\.(items|item|findItem)\(/, PUBLISHED, 'the published reads');
  placed(/\.s\.(items|work|apps)\b|state\.(items|work|apps)\b|\.(items|work|apps)\[/, DIRECT, 'the direct reads of state');
});

test('every pending read in server/ is placed, by file and function, the ledger’s entries() and entry() included', () => {
  placed(/\bstore\.pending\b/, PENDING, 'the pending reads');
  placed(/\bledger\.(entries|entry)\(|\bthis\.(entries|entry)\(/, LEDGER, 'the ledger’s pending reads');
});

test('every production commit in server/ is placed, with the lists it touches', () => {
  placed(/\.commit\s*\(/, COMMITS, 'the production commits');
});

test('no server file reaches the store’s reads through a form the guard can’t follow', () => {
  const ALIAS = /\{[^}]*\b(pending|items|work|apps)\b[^}]*\}\s*=\s*[\w.]*\b(store|s|state)\b\s*[;,)]|[\w$\])]\s*\[\s*['"`](pending|items|work|apps)['"`]\s*\]/;
  const found = sources().flatMap(([path, text]) =>
    text
      .split('\n')
      .filter((l) => ALIAS.test(l) && !/^\s*(\/\/|\*)/.test(l))
      .map((l) => `${path}: ${l.trim()}`),
  );
  assert.deepEqual(found, [], 'read through store.pending.items(), store.items() or state.<list> by name, so the guard can place it');
});

/** Lines of server code that reach a list read through a local the guard can't follow. @param {string[]} [extra] */
export function unfollowed(extra = []) {
  const BOUND = /\b(?:const|let|var)\s+[\w$]+\s*=\s*[\w$.]*\b(?:store(?:\.pending)?|ledger)\s*[;,)]/;
  const CALL = /([\w$\])]+)\s*\.\s*(?:items|item|findItem|work)\s*\(/g;
  const INDIRECT = /\.\s*(?:items|item|findItem|work)\s*\.\s*(?:call|apply|bind)\b/;
  return [...sources(), ...extra.map((text, i) => [`extra-${i}.mjs`, normalized(text)])].flatMap(([path, text]) =>
    text
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .filter((l) => BOUND.test(l) || INDIRECT.test(l) || [...l.matchAll(CALL)].some((m) => !/^(store|pending)$/.test(m[1])))
      .map((l) => `${path}: ${l.trim()}`),
  );
}

test('no server file binds the store or the ledger to a local, or calls a list read on anything but the store', () => {
  assert.deepEqual(
    unfollowed(),
    [],
    'call store.items(), store.pending.items() or ledger.entries() where the store or ledger is named, so the guard can place it',
  );
  // The integrator's probe, and the same through the pending reads and the ledger: each is found.
  const probes = [
    'export function zz6(rt, t) { const st = rt.store; return st.items(t).find((x) => x); }',
    'export function zz7(rt, t) { const p = rt.store.pending; return p.items(t); }',
    'export function zz8(rt, c) { const l = rt.ledger; return l.entries(c); }',
    // critic's read of the rule: the read called through call, apply or bind.
    'export function zz10(rt, t) { return rt.store.items.call(rt.store, t); }',
    'export function zz11(rt, t) { return rt.store.pending.items.apply(rt.store.pending, [t]); }',
    'export function zz12(rt, t) { const read = rt.store.item.bind(rt.store); return read(t, "x"); }',
  ];
  assert.deepEqual(
    unfollowed(probes).map((l) => l.split(':')[0]),
    ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs', 'extra-3.mjs', 'extra-4.mjs', 'extra-5.mjs'],
  );
  // Optional chaining is a store call like any other, so the tables above place it: read as a plain member, it matches.
  assert.match(normalized('return rt.store?.items(t);'), /\bstore\.(items|item|findItem)\(/);
  assert.match(normalized('return rt.store?.pending?.items(t);'), /\bstore\.pending\b/);
});
