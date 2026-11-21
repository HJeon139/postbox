// Where server code reads items, work and apps, and which of the two reads it uses (#601, designs/508/601-held-view.md).
// The published reads (store.items(), item(), and store.state directly) show only what was applied. The
// pending reads (store.pending, and the ledger's entries(), which uses it) show what is held behind a commit too. The
// rule: a reader whose result decides a write the turn or a sweep makes reads pending; a reader whose result leaves
// the process (the page, a read tool, a prompt, an HTTP answer), or a write the person aims at one item they can see,
// reads published. Every site is placed here by file and enclosing function, so a new reader of either kind fails until
// it is placed (the integrator's review of #611: a guard of pending sites alone let a new published reader through).
// Production commits are placed too: a commit in front of held emits that touches these lists makes a pending read
// inexact (§5). Lines the formatter split (`rt.store\n  .items(`) are joined before matching. Forms it can't follow
// fail outright: destructuring `pending`, `items`, `work` or `apps` out of the store or the state, reaching them by a
// string key, binding the store, its pending reads or the ledger to a local, and calling items(), item()
// or work() on anything but the store or its pending reads (the integrator's second review of #611: `const st =
// rt.store; st.items(t)` passed), or through call, apply or bind. Optional chaining is read as a plain member. The guard
// reads source text, not the program, so a form it doesn't match passes, and review reads for it: an optional call
// (`rt.store?.items?.(t)`), an optional bracket (`rt.store?.["items"](t)`) and `Reflect.apply(rt.store.items, …)` are three. It reads every .mjs, .js and .cjs file under server/ except the store's own and server/remote/host/,
// the host daemon, which has no store. Sessions have a pending read by id, for their writes and a delivery's wait
// (#796's class), and so do schedules (#623).
// Threads follow the same rule for their writes (#796): tests/thread-write-guard.test.mjs places them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalized, placed, sources } from './server-sources-fixture.mjs';
import { PENDING } from './store-held-pending-sites.mjs';

/** store.items() and item(): published reads. */
const PUBLISHED = {
  'app-notes.mjs': ['clickEvent'], // the app’s lines in your voice this last minute, for the page’s click event (#1488)
  'block-update.mjs': ['answerDelivered'], // the answer to a block the person saw, as its event starts a turn
  'blocks.mjs': ['act'], // the person’s answer to a block they see
  'card-needs.mjs': ['dismissFailed'], // the person’s Dismiss on a failed reply they see (#883)
  'copied-line.mjs': ['copiedLine'], // a line an agent copied (#1370): the item it was given, as read_conversation reads it
  'turn-run.mjs': ['retry'], // the person’s Retry of a failed reply they see
  'diagram-check.mjs': ['diagramCheck'], // the page’s report on a diagram the person sees
  'item-lines.mjs': ['topicRootLine', 'describeItem'], // a read tool and a prompt
  'catch-up.mjs': ['catchUp', 'turnTail'], // the prompt for a later turn
  'permission-cards.mjs': ['resolvePermission', 'resolveDenial'], // the person’s answer to a card they see
  'permission-expiry.mjs': ['dismissPermission'], // the person’s Dismiss on a card they see (#721)
  'reactions.mjs': ['toggleReaction', 'reactTool'], // a reaction aimed at an item the person or the agent sees
  'read-message.mjs': ['readMessage', 'readMessage', 'readConversation'], // read tools (T-31)
  'remote/turns-snapshot.mjs': ['readable'], // the snapshot sent to a host: it leaves the process
  'review-comments.mjs': ['find'], // review_block on a block shown in the room
  'review-files.mjs': ['findReviewFile'], // a review’s image, as an HTTP answer to the page (#780)
  'search-conversation.mjs': ['searchConversation'], // a read tool (#1340): the hit’s item, as read_conversation reads it
  'runtime.mjs': ['resolveProposal'], // a person’s action on an item they see
  'scheduled-wakes.mjs': ['prepareScheduledRetry'], // the person’s Retry of a wake line they see
  'share-back.mjs': ['shareToConversation', 'shareToConversation'], // the person’s Share of an item they see
  'shell-runs.mjs': ['stopShellCommand'], // the person’s Stop on a command they see
  'store-outage.mjs': ['settleOrphanTurns'], // at a reload, when nothing is held
  'thread-catch-up.mjs': ['threadTail', 'threadCatchUp', 'threadLines', 'readUpTo', 'reactionLines'], // prompts for a later turn
  'thread-summary.mjs': ['lineOf', 'lineOf', 'summarizeThread', 'summarizeThread'], // summaries for a later turn
  'tool-ask.mjs': ['resolveToolAsk'], // the person’s answer to an ask they see
  'view-app/consent.mjs': ['resolveViewAsk', 'settleDownloads'], // the person’s answer to the download card they see, and at startup a card a stop cut short, before any write is held (#95)
  'view-app/view-app.mjs': ['viewApp'], // the app’s item, to render as the person sees it: the picture leaves the process
  'turn-marks.mjs': ['askedAgain', 'askedAgain'], // the person’s Retry of a reply they see
  'wake-cards.mjs': ['resolveHop', 'heldFor'], // the person’s answer to a hop card they see; the catch-up’s held lines, what the person sees (#693)
  'write-intent.mjs': ['requestOf', 'stopRequested', 'stopRequested'], // the request the person made, and their Stop on a line they see
};

/** Direct reads of state.items, state.work or state.apps: published reads. */
const DIRECT = {
  'app-entries.mjs': ['sendAppMessage'], // the title of an app whose check the page reported, for its entry’s line (#1425)
  'app-links.mjs': ['openLink'], // that the app exists, for the page’s request to open its link (#1480)
  'app-notes.mjs': ['noteApp', 'clickEvent'], // the page’s note and event, HTTP answers (#1488)
  'app-publish.mjs': ['publishApp', 'readApp'], // the page’s publish, an HTTP answer, and read_app, a read tool (#1478)
  'apps.mjs': ['appCheck', 'appEvent', 'appState', 'appQuery', 'appFile', 'appOf'], // HTTP answers to the page about an app, and appOf for read_message and the host snapshot (#516's S1): a read tool and what it sends
  'item-lines.mjs': ['describeItem', 'describeItem'], // a read tool’s app line
  'ledger-git.mjs': ['gitState'], // the Work view’s git state: an answer to the page
  'ledger-answers.mjs': ['published'], // the Work view’s diff and output, answers to the page
  'ledger.mjs': ['expireStale'], // at startup
  'old-app-sends.mjs': ['closeOldSendCards'], // at startup: app-send cards from before #1488 close
  'permission-expiry.mjs': ['expireStalePermissions'], // at startup
  'public-state.mjs': ['publicItems'], // a conversation’s items by range, an HTTP answer to the page (#1155)
  'restart-sweep.mjs': ['foldCutOff', 'stopStreaming'], // at startup: the steps of turns a restart cut off, and their replies marked stopped
  'sandbox-routes.mjs': ['sandboxRoute'], // an app version’s sandbox page: an HTTP answer to the page
  'shell-runs.mjs': ['expireStaleCommands'], // at startup
  'thread-headers.mjs': ['itemsOf'], // each thread's header facts, sent to the page (#1155)
  'thread-search.mjs': ['threadSearch'], // a conversation’s search, an HTTP answer to the page (#1155)
  'tool-ask.mjs': ['settleToolAsks'], // only the thread ids; each thread is read through store.pending
  'view-app/view-app.mjs': ['viewApp'], // the app the agent named, to find its thread and version for the picture (#95)
  // The archive pass (#305) picks a turn from the published state; its commit function gathers it again from the state
  // the commit is sequenced on, so any change since stops the commit (I5, I8), and a patch held behind it is dropped.
  'work-archive.mjs': ['gather', 'gather'],
};

/** Ledger.entries() and entry(), which read store.pending.work. */
const LEDGER = {
  'ledger-commands.mjs': ['turnEnded', 'commandSeen', 'compare', 'newCommits', 'newCommits', 'leftBranch'], // commands and commits the turn is recording
  'ledger-remote.mjs': ['hostEdit'], // a host edit the turn is recording
  'ledger-answers.mjs': ['restore'], // restore reads back the entry it just patched
  'ledger.mjs': ['entry', 'commandEnded', 'commandEnded', 'taskEnded', 'jobUpdate', 'recordChange'], // entries the ledger patches as the turn goes
  'ledger-end.mjs': ['writeEnd', 'writeEnd', 'writeEnd'], // the turn’s entry and its commands’, patched at its end
  'turn-end-work.mjs': ['workLine'], // the turn’s line of its work
  'thread-summary.mjs': ['summarizeThread'], // the summary’s cost, patched on its entry
  'write-intent.mjs': ['madeBy', 'judged'], // the PRs this conversation made, and the judge’s cost
};

/** Production commits, with the lists each touches. */
const COMMITS = {
  'asset-orphans.mjs': ['sweepAssets'], // the released hashes a load deleted: assetReleases only (#516 S3)
  'assets.mjs': ['writeAsset'], // an asset version: assets, assetRooms and assetReleases only, none of items, work or apps (#516 S3)
  // turn.archive (#305): touches work and items. During it a pending read still shows the moved turn; what the pending
  // readers decide on, the kept entries and the newest turns, isn’t moved (server/store-held.mjs, T-16).
  'work-archive.mjs': ['commitTurn'],
};

test('every published read of items, work and apps in server/ is placed, by file and function', () => {
  placed(/\bstore\.(items|item)\(/, PUBLISHED, 'the published reads');
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
  const CALL = /([\w$\])]+)\s*\.\s*(?:items|item|work)\s*\(/g;
  const INDIRECT = /\.\s*(?:items|item|work)\s*\.\s*(?:call|apply|bind)\b/;
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
  assert.match(normalized('return rt.store?.items(t);'), /\bstore\.(items|item)\(/);
  assert.match(normalized('return rt.store?.pending?.items(t);'), /\bstore\.pending\b/);
});
