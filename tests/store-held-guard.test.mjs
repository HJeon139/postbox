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
// (#796's class); schedules and the rest have none (§ Not in this change).
// Threads follow the same rule for their writes (#796): tests/thread-write-guard.test.mjs places them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalized, placed, sources } from './server-sources-fixture.mjs';

/** store.items() and item(): published reads. */
const PUBLISHED = {
  'apps.mjs': ['appEvent', 'resolveAppSend'], // the page’s app events and an app send it answers: what the person sees
  'blocks.mjs': ['act', 'answerDelivered'], // the person’s answer to a block they see
  'card-needs.mjs': ['dismissFailed'], // the person’s Dismiss on a failed reply they see (#883)
  'item-lines.mjs': ['topicRootLine', 'describeItem'], // a read tool and a prompt
  'catch-up.mjs': ['catchUp', 'pointerIfSeen'], // the prompt for a later turn
  'permission-cards.mjs': ['resolvePermission', 'resolveDenial'], // the person’s answer to a card they see
  'permission-expiry.mjs': ['dismissPermission'], // the person’s Dismiss on a card they see (#721)
  'queue-batch.mjs': ['latestMessage'], // the person’s queued messages
  'reactions.mjs': ['toggleReaction', 'reactTool'], // a reaction aimed at an item the person or the agent sees
  'read-message.mjs': ['readMessage', 'readMessage'], // a read tool (T-31)
  'remote/turns-snapshot.mjs': ['readable'], // the snapshot sent to a host: it leaves the process
  'review-comments.mjs': ['find'], // review_block on a block shown in the room
  'review-files.mjs': ['findReviewFile'], // a review’s image, as an HTTP answer to the page (#780)
  'runtime.mjs': ['retry', 'resolveProposal', 'readConversation', 'diagramCheck', 'stopShellCommand'], // a person’s action on an item they see, or a read tool
  'scheduled-wakes.mjs': ['prepareScheduledRetry'], // the person’s Retry of a wake line they see
  'share-back.mjs': ['shareToConversation', 'shareToConversation'], // the person’s Share of an item they see
  'store-outage.mjs': ['settleOrphanTurns'], // at a reload, when nothing is held
  'telemetry-record.mjs': ['collect'], // a run’s record, after it
  'thread-summary.mjs': ['lineOf', 'lineOf', 'threadCatchUp', 'threadLines', 'readUpTo', 'summarizeThread', 'summarizeThread', 'reactionLines'], // prompts and summaries for a later turn
  'tool-ask.mjs': ['resolveToolAsk'], // the person’s answer to an ask they see
  'view-app/consent.mjs': ['resolveViewAsk', 'settleDownloads'], // the person’s answer to the download card they see, and at startup a card a stop cut short, before any write is held (#95)
  'view-app/view-app.mjs': ['viewApp'], // the app’s item, to render as the person sees it: the picture leaves the process
  'turn-marks.mjs': ['askedAgain', 'askedAgain'], // the person’s Retry of a reply they see
  'wake-cards.mjs': ['resolveHop', 'heldFor'], // the person’s answer to a hop card they see; the catch-up’s held lines, what the person sees (#693)
  'write-intent.mjs': ['requestOf', 'stopRequested', 'stopRequested'], // the request the person made, and their Stop on a line they see
};

/** Direct reads of state.items, state.work or state.apps: published reads. */
const DIRECT = {
  'apps.mjs': ['appCheck', 'appEvent', 'appState', 'appQuery', 'appFile', 'appOf'], // HTTP answers to the page about an app, and appOf for read_message and the host snapshot (#516's S1): a read tool and what it sends
  'index.mjs': ['start'], // /api/state and startup
  'item-lines.mjs': ['describeItem', 'describeItem'], // a read tool’s app line
  'ledger-git.mjs': ['gitState'], // the Work view’s git state: an answer to the page
  'ledger-answers.mjs': ['published'], // the Work view’s diff and output, answers to the page
  'ledger.mjs': ['expireStale'], // at startup
  'permission-expiry.mjs': ['expireStalePermissions'], // at startup
  'room-checks-agy.mjs': ['deniedSteps'], // facts from a recorded run, offline
  'room-checks-backends.mjs': ['BACKEND_CHECKS'], // the same
  'room-checks-asks.mjs': ['droppedAsks', 'needsMismatches'], // the same
  'room-checks-needs.mjs': ['declinedThenMentioned'], // the same
  'room-checks-telemetry.mjs': ['fiveWordRuns', 'secretsOf', 'CHECKS'], // the same
  'room-checks-threads.mjs': ['missingThreadTasks'], // the same
  'room-checks-work.mjs': ['ledgerEntries'], // the same
  'room-checks.mjs': ['itemsOf', 'CHECKS', 'CHECKS', 'CHECKS', 'CHECKS', 'CHECKS'], // the same
  'room-delivery.mjs': ['itemsOf'], // the same
  'room-unverified.mjs': ['uncheckedThreads'], // the same
  'runtime.mjs': ['expireStaleCommands'], // at startup
  'sandbox-routes.mjs': ['sandboxRoute'], // an app version’s sandbox page: an HTTP answer to the page
  'telemetry-record.mjs': ['blockRow', 'workOf'], // a run’s record, after it
  'telemetry-report.mjs': ['liveFacts', 'liveFacts'], // the same
  'tool-ask.mjs': ['settleToolAsks'], // only the thread ids; each thread is read through store.pending
  'view-app/view-app.mjs': ['viewApp'], // the app the agent named, to find its thread and version for the picture (#95)
  'waiting-on-you.mjs': ['waitingOnYou'], // shared with the page, which has only what was broadcast
};

/** store.pending reads. */
const PENDING = {
  // The agent's next need when a card is answered, the released card whose turn it may read, and the card it notifies:
  // each decides a write, so a card held behind a commit counts (#366). An offered card and the current need's card
  // (takesNeed): their times, and whether the current one still waits, decide whether the offer takes the need (#711).
  'card-needs.mjs': ['keptTurns', 'nextNeed', 'takesNeed', 'takesNeed', 'releaseNeed', 'notifyOnce'],
  'restart-sweep.mjs': ['cardOf'], // the need's card: whether it still waits, and its time on a tie, decide the need kept (#366)
  'app-retire.mjs': ['retireApp', 'retireApp', 'retireApp', 'release'], // retire_app of an app the turn may have just shown, and its sweep of open sends
  'apps.mjs': ['showApp', 'updateApp'], // show_app and update_app of an app the turn may have just shown
  'block-show.mjs': ['showBlock', 'showBlock', 'showBlock', 'shownAgain'], // show_block of an app or a block id the turn may have just shown
  'blocks.mjs': ['shownBy'], // update_block of a block the turn just showed
  'catch-up.mjs': ['moveMarkers'], // the conversation of a topic an item moved in, maybe opened behind a held commit, whose sessions' markers move (#1041)
  'held-session.mjs': ['heldSession'], // a delivery to a session just made behind a held commit waits until it's published (#796's class in sessions)
  'ledger.mjs': ['entries', 'recordPublishes', 'recordPublishes'], // the ledger reads back its own entries; the turn’s blocks and apps
  'lint-delivery.mjs': ['sendLint'], // the apps the turn showed, still being checked
  // The queue a drain takes from and the queued messages a deleted session's release posts: a wake or a message
  // queued behind a held commit is in them (#796). Send now aims at an entry the person sees, but a turn ending behind
  // a held commit may have drained it already, and sending it again would deliver it twice (#1007).
  'message-queue.mjs': ['sendQueuedNow', 'releaseQueued', 'drainQueue', 'takePending'],
  'permission-cards.mjs': ['recordDenial'], // the same refused call, once
  'permission-expiry.mjs': ['tellExpired'], // the card a turn’s end just expired, told about once (#721)
  'permission-prompt.mjs': ['permission'], // the card the call waits on
  'read-folders.mjs': ['inReadFolder'], // whether a read is allowed with no card: a removal held behind a commit counts at once (#1074)
  'remote/turns-end.mjs': ['stoppedHung'], // the hung host turn’s own replies
  'remote/turns-prompts.mjs': ['cardOf', 'permissionCards'], // a host turn’s own cards: the sweep its callers settle, and the calls an attach after a restart holds (#353)
  'remote/turns-resume.mjs': ['reattach'], // the replayed turn’s replies, replaced in a sweep
  'reply-segment.mjs': ['wordsSegment'], // whether the turn’s open part is still its thread’s last decides where its next words go
  'runtime.mjs': [
    'addItem',
    'addItem',
    'bringForward',
    'sendMessage',
    'deliver',
    'deliver',
    'deliver',
    'text',
    'compaction',
    'endWork',
    'endTurn',
    'endTurn',
    'endTurn',
    // Stop's session as its own write of heldSteps left it, so Keep running's steps run on behind a held commit (#1042).
    'stop',
    'recordStopped',
    'turnExited',
    // A job's end: the list it leaves, whether a kept job still runs to hold the steps, and the steps to stall (#957).
    'endJob',
    'endJob',
    'endJob',
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
    'purgeSession',
    'purgeSession',
  ], // the turn’s own items and apps, a move after a pending read, sweeps that write back, the thread a message, a delivery or a topic reply count goes to, maybe opened or deleting behind a held commit, and the members a purge keeps its room for, maybe joined behind one, and the session a stopped turn's exit settles, its “stopping” maybe held (#796)
  // The reply with the mention, a side line right after its add, and sweeps of hop cards; the conversation's hop count,
  // the topic the wake answers in, and endChain's hops and queued wakes, each maybe held behind a commit (#796).
  // A session's change and notice diff against the session a held change left (#796's class in sessions).
  // A streamed chunk's state check, a compaction's number and a tool result's urgent notes read the session a held write
  // left, so a stream holds one patch, not one per chunk, a held compaction counts, and a held note is given. A delivery reads its session pending too (runtime.mjs
  // deliver, twice): the last summary's givenMentions and seenItem, and a notice, held, are seen, not given again or lost (#506). Whether a thread has a persona's session already
  // reads its pending members and sessions, so a second mention behind a held commit finds the session the first made.
  // The room’s chain limit, which decides whether a wake waits, maybe set behind a held commit (#1035).
  'room-chain-limit.mjs': ['roomChainLimit'],
  'session-write.mjs': ['updateSession', 'pendingSessionsIn', 'pendingSessionsIn'],
  'subagent-end.mjs': ['withUrgent'],
  'side-threads.mjs': ['agentWake', 'agentWake', 'agentWake', 'endChain', 'endChain', 'archiveForks', 'bumpSideLink', 'bumpSideLink'],
  // A thread’s apps, removed in a sweep; and whether a delivery's conversation is being deleted, as sendMessage reads it (#796).
  'thread-erase.mjs': ['conversationDeleting', 'eraseThreads'],
  // The thread a turn answers in, as deliver chose it from pending, and the topic a turn's end settles: a topic
  // open_topic just opened, held (#796).
  'thread-summary.mjs': ['threadHeader', 'threadCatchUp', 'settleThread'],
  'thread-write.mjs': ['updateThread', 'pendingThreads'], // every write of a thread that exists starts from it (#796)
  'tool-ask.mjs': ['askForTool', 'settleToolAsks'], // a second ask for the same tool, and the sweep that settles open asks
  'view-app/consent.mjs': ['askToSee'], // an open download card, which decides whether to add another (#95)
  'topic-open.mjs': ['startTopic', 'startTopic', 'conversationOf', 'conversationOf', 'repeatOf'], // one topic per message, the item's thread and I6's check, each maybe held behind a commit (#637)
  'wake-cards.mjs': ['lastAddAnswer', 'openCard'], // a declined add, so a mention asks no more (#693), and its lift by the person’s add (#789); another wake’s held hop card, so a second isn’t made
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

/** Production commits, with the lists each touches. */
const COMMITS = {
  'asset-orphans.mjs': ['sweepAssets'], // the released hashes a load deleted: assetReleases only (#516 S3)
  'assets.mjs': ['writeAsset'], // an asset version: assets, assetRooms and assetReleases only, none of items, work or apps (#516 S3)
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
