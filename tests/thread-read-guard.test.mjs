// Where server code reads a thread from the published state (#623). The rule is tests/store-held-guard.test.mjs’s: a
// read whose result decides a write the turn or a sweep makes reads store.pending, which shows a thread held behind a
// commit too (a topic open_topic just opened, say); a read whose result leaves the process (the page, a read tool, a
// prompt, an HTTP answer), or a write the person aims at one item they can see, reads published. Threads’ pending reads
// are placed with the others in tests/store-held-pending-sites.mjs; every published read is placed here, by file and
// enclosing function, so a new one fails until its reason is written down. Each read counts, two on a line as two.
// The published forms are thread-write-guard’s, less convOf(): Ledger.convOf reads store.pending since #623, so a call
// of it is a pending read, and the pattern no longer names it. `s.threads` is matched through any `s`, a parameter’s
// too (setupFor’s). A lineage() or glossaryFor() with no reader reads published by default, so each such call is placed
// in a second table. Forms it can’t place fail outright: destructuring `threads` out of the state or the store, and
// reaching it by a string key. A file’s sites are listed as the shared fixture finds them: a declaration it doesn’t read
// as one (threads.mjs’s lineage, whose default reader has a parenthesis) is placed under the function above it. The
// guard reads source text, so a published read through a local bound from the state (`const st = rt.s`) passes, and
// review reads for it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enclosing, placed, sites, withProbes } from './server-sources-fixture.mjs';

/** A published read of a thread. */
const PUBLISHED_THREAD = /\bs\.threads\b|\bstate\.threads\b|\b(?:rt|this)\.thread\(|\bthreads\.get\(/;

const THREAD_READS = {
  'agent-files.mjs': ['agentFolders'], // the folders an agent may name a file in: a read tool’s answer
  'app-publish.mjs': ['readApp', 'readApp'], // read_app, a read tool: the app’s conversation and the caller’s
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
  'setup-context.mjs': ['setupFor', 'setupFor'], // the persona sheet’s project and folder: an HTTP answer
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

/** lineage() and glossaryFor() called with no reader: published reads by default. */
const NO_READER = {
  // The person’s Remove or edit of a queued message they see: the session that holds it
  'entry-queue.mjs': ['holderOf'],
  'remote/turns-snapshot.mjs': ['inConversation'], // which host turns a change marks dirty: the snapshot leaves the process
  'runtime.mjs': ['resolveProposal'], // the person’s Create on a proposal card they see: the agent joins its conversation
  'send-message.mjs': ['threadRefs'], // a prompt for a later turn: the threads the person’s message links to
  'threads.mjs': ['conversationThreads', 'conversationThreads'], // the threads read_conversation and read_message may read: a read tool’s
  // The archive pass for a turn with no work’s convId: the pass picks from published, and its commit gathers again
  'turn-end-work.mjs': ['endWork'],
  'ui-tools.mjs': ['defineTerm'], // define_term’s answer: whether the term overrides the conversation’s
  'wake-cards.mjs': ['heldFor'], // the catch-up’s held lines, what the person sees (#693)
};

/** file → the enclosing function of each `.lineage(` or `.glossaryFor(` call given one argument. @param {string[]} [extra] */
function noReader(extra = []) {
  /** @type {Record<string, string[]>} */
  const out = {};
  for (const [path, text] of withProbes(extra)) {
    const lines = text.split('\n');
    for (const call of text.matchAll(/\.(?:lineage|glossaryFor)\(/g)) {
      const line = text.slice(0, call.index).split('\n').length - 1;
      if (/^\s*(\/\/|\*)/.test(lines[line])) continue;
      if (topLevelCommas(text, /** @type {number} */ (call.index) + call[0].length) === 0) (out[path] ??= []).push(enclosing(lines, line));
    }
  }
  return out;
}

/** The commas between the arguments of the call whose `(` is just before `from`. @param {string} text @param {number} from */
function topLevelCommas(text, from) {
  let depth = 0;
  let commas = 0;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c) && depth-- === 0) break;
    else if (c === ',' && depth === 0) commas++;
  }
  return commas;
}

/** Lines that reach the published threads through a form the guard can’t place. @param {string[]} [extra] */
function unplaceable(extra = []) {
  const FORM = /\{[^}]*\bthreads\b[^}]*\}\s*=\s*[\w$.]*\b(?:s|state|store)\b\s*[;,)]|\[\s*['"`]threads['"`]\s*\]/;
  return withProbes(extra).flatMap(([path, text]) =>
    text
      .split('\n')
      .filter((l) => FORM.test(l) && !/^\s*(\/\/|\*)/.test(l))
      .map((l) => `${path}: ${l.trim()}`),
  );
}

test('every published read of a thread in server/ is placed, by file and function', () => {
  placed(PUBLISHED_THREAD, THREAD_READS, 'the published thread reads', { each: true });
  // A parameter’s s.threads, and a second read on a line already listed: each is found.
  const probes = [
    'export function zz1(s, id) { return s.threads[id]?.title; }',
    'export function zz2(rt, a, b) { return rt.s.threads[a].parentId === rt.s.threads[b].parentId; }',
  ];
  const found = Object.entries(sites(PUBLISHED_THREAD, probes, { each: true })).filter(([k]) => k.startsWith('extra-'));
  assert.deepEqual(found, [
    ['extra-0.mjs', ['zz1']],
    ['extra-1.mjs', ['zz2', 'zz2']],
  ]);
});

test('every lineage() and glossaryFor() in server/ with no reader is placed, by file and function', () => {
  assert.deepEqual(noReader(), NO_READER, `the published lineage reads changed: place each. Found: ${JSON.stringify(noReader())}`);
  const probes = [
    'export function zz3(rt, id) { return rt.threads.lineage(id).at(-1); }',
    'export function zz4(rt, id) {\n  return rt.threads\n    .glossaryFor(id);\n}',
    // A reader given, even one whose own call has commas, is no published read: not found.
    'export function zz5(rt, id) { return rt.threads.lineage(f(id, 1), (x) => rt.store.pending.thread(x)); }',
  ];
  const found = Object.entries(noReader(probes)).filter(([k]) => k.startsWith('extra-'));
  assert.deepEqual(found, [
    ['extra-0.mjs', ['zz3']],
    ['extra-1.mjs', ['zz4']],
  ]);
});

test('no server file reaches the published threads through a form the guard can’t place', () => {
  assert.deepEqual(unplaceable(), [], 'read rt.s.threads[id] or state.threads[id] by name, so the guard can place it');
  const probes = [
    'export function zz6(rt, id) { const { threads } = rt.s; return threads[id]; }',
    'export function zz7(state, id) { const { threads: all } = state; return all[id]; }',
    "export function zz8(rt, id) { return rt.s['threads'][id]; }",
    // A local named threads from anything else, as review-comments.mjs makes one: not found.
    'export function zz9(it) { const { threads, added } = withComments(it.block.threads); return threads; }',
  ];
  assert.deepEqual(
    unplaceable(probes).map((l) => l.split(':')[0]),
    ['extra-0.mjs', 'extra-1.mjs', 'extra-2.mjs'],
  );
});
