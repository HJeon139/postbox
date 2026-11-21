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

/** store.pending reads. */
const PENDING = {
  'net-fetch-line.mjs': ['lastReply'], // the agent’s last reply, which the fetch line patches: a write, so a held reply counts (#1482)
  // The agent's next need when a card is answered, the released card whose turn it may read, and the card it notifies:
  // each decides a write, so a card held behind a commit counts (#366). An offered card and the current need's card
  // (takesNeed): their times, and whether the current one still waits, decide whether the offer takes the need (#711).
  'card-needs.mjs': ['keptTurns', 'nextNeed', 'takesNeed', 'takesNeed', 'releaseNeed'],
  // The mirrored reply a terminal line adds to, maybe held behind a commit; and the session attachClaudeSession just
  // made, whose transcript mirror starts following.
  'claude-mirror.mjs': ['mirror', 'pollMirror'],
  'turn-run.mjs': ['deliver', 'deliver', 'turnMessage'], // the session it starts a turn in, and the thread it answers in, maybe made or held behind a commit (#796)
  'restart-sweep.mjs': ['settleRetiredNeeds', 'cardOf'], // the need's card: whether it still waits, and its time on a tie, decide the need kept (#366); a session whose need is of a retired kind, settled
  'app-retire.mjs': ['retireApp', 'retireApp', 'retireApp'], // retire_app of an app the turn may have just shown
  'apps.mjs': ['showApp', 'updateApp'], // show_app and update_app of an app the turn may have just shown
  'app-entries.mjs': ['lostEvent'], // the voice line an app’s event posted, maybe behind a held commit, read when its turn starts (#1425)
  'block-show.mjs': ['showBlock', 'showBlock', 'showBlock', 'shownAgain'], // show_block of an app or a block id the turn may have just shown
  'block-update.mjs': ['shownBy'], // update_block of a block the turn just showed
  'catch-up.mjs': ['moveMarkers'], // the conversation of a topic an item moved in, maybe opened behind a held commit, whose sessions' markers move (#1041)
  'delivery.mjs': ['send', 'sessionIds', 'inbox', 'ready', 'take', 'postedSince'], // the sessions with inboxes, an inbox's entries, its session and an entry's item, maybe just made, decide each entry's next state and the wake (#796's class)
  // the handle of the agent that already has a message the person edits, its recipients, and the agents an edit leaves
  // out, maybe written behind a held commit; the text of the message the person removed, for its sender; and whom the
  // person’s own was removed for
  'entry-queue.mjs': ['editEntry', 'editEntry', 'leaveOut', 'cancelEntry', 'removedUnread'],
  // the item an entry gives the turn whole, maybe settled in the same held write; the person’s message, posted at send
  // and the thread a summary request summarizes, maybe opened behind a held commit, for where its reply posts (#1425)
  // and an input’s entries’ items, their files and its thread, maybe written in the same held write (#1427)
  'turns.mjs': ['inputOf', 'inputOf', 'readItem', 'summaryOf', 'messageOf', 'personMessage'],
  'turn-service.mjs': ['retryEntries'], // whether the session a Retry wakes is still failed, maybe written behind a held commit (#1429)
  'queue-convert.mjs': ['convertOne', 'convertOne', 'notDelivered'], // the agents a stored queue's row waited for or came from, and the item an earlier conversion posted for it, read as the start's writes leave them (#1423)
  // the item a repeated send's first try posted, and its conversation, either maybe behind a held commit (#1138, #1292)
  'send-message.mjs': ['repeatOf', 'repeatOf'],
  'persona-create.mjs': ['createPersonaFor'], // the conversation a new agent joins, maybe started behind a held commit (#1292)
  'mention-entries.mjs': ['mentionEntries'], // the session whose final reply makes entries, maybe made behind a held commit
  'held-session.mjs': ['heldSession'], // a delivery to a session just made behind a held commit waits until it's published (#796's class in sessions)
  // A job's end: the list it leaves, whether a kept job still runs to hold the steps, and the steps to stall (#957).
  'job-records.mjs': ['endJob', 'endJob', 'endJob', 'runningProgress', 'setJobStep', 'settleJobs'],
  'ledger.mjs': ['entries', 'recordPublishes', 'recordPublishes'], // the ledger reads back its own entries; the turn’s blocks and apps
  'lint-delivery.mjs': ['sendLint'], // the apps the turn showed, still being checked
  'live-buffer.mjs': ['liveSession', 'closeLive', 'liveUpdate', 'liveFields'], // a live field sent only when it differs from the stored one, put back to it at the turn’s end, a running turn’s state stored only when it changed, and its calls and step from what was stored as it began, held writes included
  'permission-cards.mjs': ['recordDenial'], // the same refused call, once
  'permission-expiry.mjs': ['tellExpired'], // the card a turn’s end just expired, told about once (#721)
  'permission-prompt.mjs': ['permission'], // the card the call waits on
  'read-folders.mjs': ['inReadFolder'], // whether a read is allowed with no card: a removal held behind a commit counts at once (#1074)
  'remote/turns-end.mjs': ['stoppedHung'], // the hung host turn’s own replies
  'remote/turns-prompts.mjs': ['cardOf', 'permissionCards'], // a host turn’s own cards: the sweep its callers settle, and the calls an attach after a restart holds (#353)
  'remote/turns-resume.mjs': ['reattach'], // the replayed turn’s replies, replaced in a sweep
  'remote/turns.mjs': ['noteAttach', 'noteAttach'], // the session and the persona: whether it awaits attach, which decides a delivery’s wait, with the persona as written (#1135)
  'reply-segment.mjs': ['wordsSegment', 'placeStep'], // whether the turn’s open part is still its thread’s last decides where its next words and steps go
  // The conversation createThread just wrote, with the agents it joined: its route’s answer is its own write, which a
  // held commit keeps out of the published state (#1247’s class). And the agent deletePersona deletes, with its sessions,
  // any of them maybe made behind a held commit. The constructor binds Delivery's sizeOf, which reads the item an entry
  // points at as take decides what a turn holds, maybe added in the same held write; and Checks' send, which reads the
  // session a lint turn's entry goes to when it names no thread.
  'runtime.mjs': ['constructor', 'constructor', 'createThread', 'deletePersona', 'deletePersona', 'deletePersona'],
  // The reply with the mention, a side line right after its add, and sweeps of hop cards; the conversation's hop count,
  // the topic the wake answers in, and endChain's hops and queued wakes, each maybe held behind a commit (#796).
  // A session's change and notice diff against the session a held change left (#796's class in sessions).
  // A streamed chunk's state check, a compaction's number and a tool result's urgent notes read the session a held write
  // left, so a stream holds one patch, not one per chunk, a held compaction counts, and a held note is given. A delivery reads its session pending too (runtime.mjs
  // deliver, twice): the last summary's givenMentions and seenItem, and a notice, held, are seen, not given again or lost (#506). Whether a thread has a persona's session already
  // reads its pending members and sessions, so a second mention behind a held commit finds the session the first made.
  // The room’s chain limit, which decides whether a wake waits, maybe set behind a held commit (#1035); and the room a
  // PATCH sets it on, maybe started there.
  'room-chain-limit.mjs': ['roomChainLimit', 'patchThread'],
  // The members a delete keeps its room for, maybe joined behind a held commit (#796); the session it deletes, and the
  // threads a conversation’s delete covers, any of them maybe made there too. Every lookup comes before any change.
  'session-lifecycle.mjs': ['conversationScope', 'conversationScope', 'deleteSession', 'deleteSession', 'deleteSession', 'deleteSession'],
  // An agent changed or deleted, and a deleted agent’s sessions, any of them maybe made behind a held commit.
  'personas.mjs': ['update', 'remove'],
  // pendingIn: a thread's sessions, for a read that decides whether to make one; ensure: the agent it joins, which the
  // same request may have just made; update and remove: the session they write; needAt: the need's item's time, maybe
  // added behind a held commit (#1155); forgetReported: an agent’s sessions whose last report a backend switch drops
  // (#1315); stampNeeds: the session it stamps; unarchive: what an older Postbox archived, the threads and sessions it
  // rewrites as the store loads.
  // The turn’s last reply, which goes back to whom woke it (#1518), maybe settled behind a held commit.
  'reply-back.mjs': ['replyBack'],
  'sessions.mjs': ['pendingIn', 'pendingIn', 'ensure', 'update', 'needAt', 'remove', 'forgetReported', 'stampNeeds', 'unarchive'],
  // A command’s item, maybe deleted behind a held commit, before its output or its end is written; and the agent and
  // project whose folder it runs in, maybe made or changed behind one (#1292).
  'shell-runs.mjs': ['commandFolder', 'commandFolder', 'commandOutput', 'endCommand'],
  'subagent-end.mjs': ['withUrgent'],
  // Stop's stopped entries name the message each sender sent, maybe settled behind a held commit. A topic's conversation,
  // which its session joins, and who answers in it, read as a topic opened behind a held commit leaves them (#1292).
  'side-threads.mjs': [
    'agentWake',
    'agentWake',
    'agentWake',
    'endChain',
    'endChain',
    'dropWakes',
    'sideSession',
    'threadPersona',
    'threadPersona',
    'bumpSideLink',
    'bumpSideLink',
  ],
  // A thread’s apps, removed in a sweep; and the threads’ members and sessions it erases, maybe made behind a held commit.
  'thread-erase.mjs': ['eraseThreads', 'eraseThreads', 'eraseThreads', 'eraseThreads'],
  // The thread a turn answers in, as deliver chose it from pending, and the topic a turn's end settles: a topic
  // open_topic just opened, held (#796).
  'thread-catch-up.mjs': ['threadHeader', 'threadTail', 'threadCatchUp'],
  'thread-summary.mjs': ['settleThread'],
  // Every write of a thread that exists starts from it (#796), and toWrite refuses one that doesn’t exist there. Then
  // the turn’s own items, a move after a pending read, and the thread a topic reply count goes to, maybe opened or
  // deleting behind a held commit (#796). A reply a patch settles, streaming as the patch before it left it, and that
  // reply and its thread as item.final carries them, both maybe held (#1367).
  'threads.mjs': ['patch', 'toWrite', 'pending', 'addItem', 'addItem', 'patchItem', 'patchItem', 'patchItem', 'bringForward'],
  // A finished turn’s checks: its own block and the terms and apps it introduced, and the progress steps it stalls.
  'turn-checks.mjs': ['checkTurn', 'checkTurn', 'checkTurn', 'stallSteps'],
  'turn-context.mjs': ['text', 'compaction'], // a streamed chunk's state check and a compaction's number, from the session a held write left
  'turn-end-work.mjs': ['workLine'], // the turn’s own reply or block, to carry its line, maybe held behind a commit
  'turn-end-listeners.mjs': ['listenTurnEnd'], // an app-check turn’s apps at its end, a sweep that writes back, maybe held behind a commit (#796)
  'turn-finish.mjs': ['endTurn'], // a turn’s end: its own items, maybe held behind a commit (#796)
  'turn-needs.mjs': ['needsAfter'], // the thread a turn’s reply count goes to, maybe held behind a commit (#796)
  // The quota marks that decide a mark or its clearing, and the persona that says whose quota it is, each maybe held
  // behind a commit (#442).
  'turn-quota.mjs': ['quotaKey', 'sessionsOn', 'quotaName', 'quotaMoved'],
  // Stop's session as its own write of heldSteps left it, so Keep running's steps run on behind a held commit (#1042).
  'turn-stop.mjs': ['stop', 'turnExited'],
  'stop-record.mjs': ['recordStopped'], // the stopped turn’s segments still streaming, maybe held behind a commit (#602)
  'tool-ask.mjs': ['askForTool', 'settleToolAsks'], // a second ask for the same tool, and the sweep that settles open asks
  'view-app/consent.mjs': ['askToSee'], // an open download card, which decides whether to add another (#95)
  // one topic per message, the item's thread and I6's check, each maybe held behind a commit (#637); and who answers in
  // a new topic, read as the conversation was written (#1292)
  'topic-open.mjs': ['startTopic', 'startTopic', 'startTopic', 'conversationOf', 'conversationOf', 'repeatOf'],
  'wake-cards.mjs': ['lastAddAnswer', 'openCard'], // a declined add, so a mention asks no more (#693), and its lift by the person’s add (#789); another wake’s held hop card, so a second isn’t made
  'write-intent.mjs': ['stillOpen'], // the turn’s own lines, and the person’s held Stop on one
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
