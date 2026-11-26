// Where server code reads a thread from the published state (#623). The rule is tests/store-held-guard.test.mjs’s: a
// read whose result decides a write the turn or a sweep makes reads store.pending, which shows a thread held behind a
// commit too (a topic open_topic just opened, say); a read whose result leaves the process (the page, a read tool, a
// prompt, an HTTP answer), or a write the person aims at one item they can see, reads published. Threads’ pending reads
// are placed with the others in tests/store-held-pending-sites.mjs; every published read is placed here, by file and
// enclosing function, so a new one fails until its reason is written down.
// The published forms are thread-write-guard’s, less convOf(): Ledger.convOf reads store.pending since #623, so a call
// of it is a pending read, and the pattern no longer names it. A file’s sites are listed as the shared fixture finds
// them: a declaration it doesn’t read as one (threads.mjs’s lineage, whose default reader has a parenthesis) is placed
// under the function above it. The guard reads source text, so a published read it doesn’t match (a lineage() with no
// reader, say) passes, and review reads for it.
import { test } from 'node:test';
import { placed } from './server-sources-fixture.mjs';

/** A published read of a thread. */
const PUBLISHED_THREAD = /\.s\.threads\b|\bstate\.threads\b|\b(?:rt|this)\.thread\(|\bthreads\.get\(/;

const THREAD_READS = {
  'agent-files.mjs': ['agentFolders'], // the folders an agent may name a file in: a read tool’s answer
  'app-publish.mjs': ['readApp'], // read_app, a read tool
  // The archive pass walks conversations at startup, before any write is held; canWrite and once check the conversation
  // is still there, and the commit gathers again from the state it’s sequenced on (tests/store-held-guard.test.mjs).
  'archive-runtime.mjs': ['all', 'canWrite', 'once'],
  'assets.mjs': ['checkRoom'], // inside the commit, against the state it’s sequenced on
  'catch-up.mjs': ['catchUp', 'turnTail'], // a prompt for a later turn
  'host-tool.mjs': ['hostTool'], // assets.search and assets.list for an app: read tools
  'items-routes.mjs': ['itemsRoute'], // an HTTP answer
  'message-attachments.mjs': ['attachmentPath'], // a project file attached to the person’s message, read for the turn
  'newer-waiting.mjs': ['waitingFor'], // a prompt for a later turn: the title of the thread a message waits in
  'permission-cards.mjs': ['allowAlways', 'resolveDenial'], // the person’s action on an item they see
  'permissions-panel.mjs': ['panelTarget', 'latestProject', 'changePermissionFolder'], // an HTTP answer, and the person’s action in it
  // A host turn’s record and its continuation, checked against the threads at a resume: what reaches the host
  'remote/turns-origin.mjs': ['readOrigin', 'readWoke', 'continuing'],
  'remote/turns-start.mjs': ['prepare'], // the project folder a host turn runs in, sent to the host
  'room-files.mjs': ['assetFile', 'assetFile'], // an HTTP answer
  'runtime.mjs': ['thread'], // the facade’s thread(): its callers are placed here
  'search-conversation.mjs': ['searchConversation'], // a read tool
  'send-message.mjs': ['threadRefs'], // a prompt for a later turn: the threads the person’s message links to
  'sessions.mjs': ['in', 'roomOf'], // a thread’s sessions for a page or a prompt (pendingIn decides writes), and the guide’s room
  'share-back.mjs': ['shareToConversation', 'summarizeBack'], // the person’s action on an item they see
  'thread-catch-up.mjs': ['threadLines'], // a prompt for a later turn
  'thread-headers.mjs': ['of', 'all', 'trim', 'childIndex'], // each thread’s header facts, sent to the page
  'thread-summary.mjs': ['summarizeThread'], // a summary for a later turn, as the store-held guard places its items
  // get: the facade’s read, an HTTP answer’s; lineage’s default reader (under bringForward); and the threads
  // read_conversation and read_message may read, a read tool’s
  'threads.mjs': ['get', 'bringForward', 'conversationThreads'],
  'turn-context.mjs': ['whatTheTurnIs'], // a prompt: the turn’s thread for its guide
  'turn-run.mjs': ['deliver'], // the project folder the turn’s process runs in, set when the conversation is made
  'view-app/consent.mjs': ['settleDownloads'], // at startup, before any write is held
  'view-app/view-app.mjs': ['conversationOf', 'conversationOf'], // the picture of an app: it leaves the process
  'wake-cards.mjs': ['closeOrphanCards'], // at startup, before any write is held
  // gather’s threads, as the store-held guard places gather: the pass picks from published, and the commit gathers
  // again inside the commit, against the state it’s sequenced on
  'work-archive.mjs': ['threadsOf'],
  'work-view.mjs': ['workConversation'], // an HTTP answer
};

test('every published read of a thread in server/ is placed, by file and function', () => {
  placed(PUBLISHED_THREAD, THREAD_READS, 'the published thread reads');
});
