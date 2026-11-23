// Where server code reads store.pending, by file and function, with the reason each read decides a write: the pending
// sites tests/store-held-guard.test.mjs places. Moved out of that file, which had reached its length limit.

/** store.pending reads. */
export const PENDING = {
  'net-fetch-line.mjs': ['lastReply'], // the agent’s last reply, which the fetch line patches: a write, so a held reply counts (#1482)
  // The agent's next need when a card is answered, the released card whose turn it may read, and the card it notifies:
  // each decides a write, so a card held behind a commit counts (#366). An offered card and the current need's card
  // (takesNeed): their times, and whether the current one still waits, decide whether the offer takes the need (#711).
  // keptBlock: the block a turn kept, in any of the agent's threads, which decides the need its end writes (#647).
  'card-needs.mjs': ['keptBlock', 'keptTurns', 'nextNeed', 'takesNeed', 'takesNeed', 'releaseNeed'],
  // The mirrored reply a terminal line adds to, maybe held behind a commit; and the session attachClaudeSession just
  // made, whose transcript mirror starts following.
  'claude-mirror.mjs': ['mirror', 'pollMirror'],
  'turn-run.mjs': ['deliver', 'deliver', 'turnMessage'], // the session it starts a turn in, and the thread it answers in, maybe made or held behind a commit (#796)
  'restart-sweep.mjs': ['settleRetiredNeeds', 'cardOf'], // the need's card: whether it still waits, and its time on a tie, decide the need kept (#366); a session whose need is of a retired kind, settled
  'app-retire.mjs': ['retireApp', 'retireApp', 'retireApp'], // retire_app of an app the turn may have just shown
  'ask-question.mjs': ['handOver'], // a host question’s blocks this turn answered, whose answers go on when the host ends its call (#1059)
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
  // A wake's schedule, maybe just scheduled, changed or removed behind a held commit: arming its timer, firing it,
  // recording its tools, settling or canceling it, and the per-agent limit each decide a write (#623); and a Retry's
  // wake line, whose recovery note may be held with its cancel.
  'schedule-tools.mjs': ['cancelWake', 'scheduleWakeTool'],
  'scheduled-wakes.mjs': [
    'armWake',
    'fireScheduledWake',
    'fireScheduledWake',
    'prepareScheduledRetry',
    'prepareScheduledRetry',
    'addTool',
    'settleScheduledWake',
    'settleScheduledWake',
    'cancelWakeSchedule',
    'noteScheduledTurn',
    'dropScheduledWake',
  ],
  // the item a repeated send's first try posted, and its conversation, either maybe behind a held commit (#1138, #1292)
  'send-message.mjs': ['repeatOf', 'repeatOf'],
  'persona-create.mjs': ['createPersonaFor'], // the conversation a new agent joins, maybe started behind a held commit (#1292)
  'mention-entries.mjs': ['mentionEntries'], // the session whose final reply makes entries, maybe made behind a held commit
  'held-session.mjs': ['heldSession'], // a delivery to a session just made behind a held commit waits until it's published (#796's class in sessions)
  // A job's end: the list it leaves, whether a kept job still runs to hold the steps, and the steps to stall (#957).
  'job-records.mjs': ['endJob', 'endJob', 'endJob', 'runningProgress', 'setJobStep', 'settleJobs'],
  'ledger.mjs': ['entries', 'recordPublishes', 'recordPublishes'], // the ledger reads back its own entries; the turn’s blocks and apps
  'diagram-check.mjs': ['syntaxCheck'], // the turn’s replies, maybe held behind a commit: their diagrams decide its lint turn and the session’s diagramsLinted (#731)
  'lint-delivery.mjs': ['sendLint'], // the apps the turn showed, still being checked
  'live-buffer.mjs': ['liveSession', 'closeLive', 'liveUpdate', 'liveFields'], // a live field sent only when it differs from the stored one, put back to it at the turn’s end, a running turn’s state stored only when it changed, and its calls and step from what was stored as it began, held writes included
  'permission-cards.mjs': ['recordDenial'], // the same refused call, once
  'permission-expiry.mjs': ['tellExpired'], // the card a turn’s end just expired, told about once (#721)
  'permission-prompt.mjs': ['permission'], // the card the call waits on
  'read-folders.mjs': ['inReadFolder'], // whether a read is allowed with no card: a removal held behind a commit counts at once (#1074)
  'remote/turns-end.mjs': ['stoppedHung'], // the hung host turn’s own replies
  'remote/turns-prompt-cards.mjs': ['permissionCards'], // a host turn’s own cards, and a question’s blocks (#1059): the sweep its callers settle, and the calls an attach after a restart holds (#353)
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
  // With run clocks on (#1526): every decision on a run clock (its route, its timer, a turn’s line, Delivery’s hold),
  // on the clock as held writes will leave it; the session its route names, which a held delete may have removed; and
  // the host stops its pause or expiry waits on, which the stop itself just wrote; and, as Postbox starts or Retry
  // reloads, the session whose agent’s host the restored line names, read as clockNote reads it.
  'run-clock-install.mjs': ['installRunClock'],
  'run-clock.mjs': ['clockOf', 'unconfirmedStops', 'clockAction', 'rearmClocks'],
  // Whether a turn is kept for the resume: its clock may have expired behind a held commit, and then it can never run.
  // The refusal’s words: the agent’s handle, and whether its clock is paused, maybe written behind a held commit.
  'run-clock-held.mjs': ['holdForClock', 'refuseWhileHeld', 'refuseWhileHeld'],
  // The session a clock line names, maybe just made, says which conversation the line goes to; and that
  // conversation’s newest clock line, maybe just added, whether a holding clock still needs one.
  'run-clock-notes.mjs': ['clockNote', 'repairClockNote', 'repairClockNote'],
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
  // The turn’s last reply, which goes back to whom woke it (#1518), maybe settled behind a held commit; and the replies
  // that woke it, whose reactions decide whether it goes back at all (#1553), a reaction maybe behind a held commit too.
  'reply-back.mjs': ['replyBack', 'endedByReaction'],
  'sessions.mjs': ['pendingIn', 'pendingIn', 'ensure', 'update', 'needAt', 'remove', 'forgetReported', 'stampNeeds', 'unarchive'],
  // A command’s item, maybe deleted behind a held commit, before its output or its end is written; and the agent and
  // project whose folder it runs in, maybe made or changed behind one (#1292).
  'shell-runs.mjs': ['commandFolder', 'commandFolder', 'commandOutput', 'endCommand'],
  'subagent-end.mjs': ['withUrgent'],
  // Stop's stopped entries name the message each sender sent, maybe settled behind a held commit. A topic's conversation,
  // which its session joins, and who answers in it, read as a topic opened behind a held commit leaves them (#1292).
  // conversationOf and deletedFrom: whether an agent left the conversation, which decides who answers or writes a
  // summary (#283), maybe behind a held commit.
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
    'conversationOf',
    'deletedFrom',
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
