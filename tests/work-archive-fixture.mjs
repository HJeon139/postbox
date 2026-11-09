// A conversation with an archived turn, made the way the archive pass makes one (#305; designs/305-archive-turns.md,
// “Records”): the turn’s archive file is put in the blob store first, then a turn.archive event names it by its
// SHA-256 through a commit. The pass itself isn’t needed: these tests read what it leaves.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const snap = (b, size) => ({ exists: true, size, sha256: b.sha256, binary: false });

/** The turn.archive event’s payload for a turn whose moved entries are `work`, named by `sha256`. */
export function archiveEvent(convId, turnId, sha256, work, items = []) {
  const commands = work.filter((e) => e.kind === 'command');
  const changes = work.filter((e) => e.kind === 'change');
  const turn = work.find((e) => e.kind === 'turn');
  const summary = {
    id: `wa_${turnId}`,
    kind: 'turn-archive',
    turnId,
    at: work[0]?.at ?? 0,
    sha256,
    entryIds: work.map((e) => e.id),
    counts: {
      files: new Set(changes.map((c) => c.fileId)).size,
      lines: { added: changes.reduce((n, c) => n + (c.added ?? 0), 0), removed: changes.reduce((n, c) => n + (c.deleted ?? 0), 0) },
      edits: work.filter((e) => e.kind === 'edit').length,
      commands: commands.length,
      failed: commands.filter((c) => c.state === 'failed').length,
      reads: work.filter((e) => e.kind === 'read').length,
      publishes: work.filter((e) => e.kind === 'publish').length,
      steps: 1,
    },
    effort: { turns: turn ? 1 : 0, ms: turn?.ms ?? 0, toolCalls: turn?.toolCalls ?? 0, costUsd: turn?.costUsd ?? 0, tokens: 0 },
    handles: turn ? [turn.handle] : [],
  };
  return { convId, turnId, sha256, summary, items };
}

/** Puts a turn’s archive file and commits the turn.archive event that names it. @returns {Promise<string>} its SHA-256 */
export async function archiveTurn(store, blobs, { convId, turnId, work, activity = {}, fileConvId = convId, items = [] }) {
  const body = JSON.stringify({ v: 1, convId: fileConvId, turnId, work, activity });
  const { sha256 } = await blobs.put(Buffer.from(body));
  await store.commit([{ type: 'turn.archive', data: archiveEvent(convId, turnId, sha256, work, items) }]);
  return sha256;
}

/**
 * A conversation and its topic thread in a started Postbox, with three turns of agent alpha. t1 ran a command, changed
 * a.txt and edited a file on a host; it is archived, with its topic reply’s steps. t2 is hot. t3 and t4 are archived
 * too, and then their files go: t3’s is overwritten (damaged), and t4’s names a file that was never put (missing). t5’s
 * file says it is another conversation’s. a.txt’s file entry stays hot, as a file entry has no turn.
 * @param {{ rt: any, store: any }} app @param {string} dir  a folder for a.txt
 */
export async function seedArchived({ rt, store }, dir) {
  const blobs = rt.ledger.blobs;
  store.emit('project', { id: 'p1', name: 'P', folder: dir });
  const conv = rt.createThread({ projectId: 'p1', title: 'Archived work', personaIds: [] });
  const topic = rt.createThread({ projectId: 'p1', title: 'A topic', kind: 'topic', parentId: conv.id });
  const out = await blobs.put(Buffer.from('the command’s output\n'));
  const one = await blobs.put(Buffer.from('one\n'));
  const two = await blobs.put(Buffer.from('one\ntwo\n'));
  const path = join(dir, 'a.txt');
  await writeFile(path, 'one\ntwo\n');
  const turn = (id, at) => ({ id, kind: 'turn', turnId: id, handle: 'alpha', status: 'done', ms: 1000, toolCalls: 2, costUsd: 0.25, startedAt: at, at });
  const t1 = [
    turn('t1', 10),
    { id: 'c1', kind: 'command', turnId: 't1', handle: 'alpha', state: 'done', exit: 0, command: 'ls', output: { sha256: out.sha256 }, at: 11 },
    { id: 'd1', kind: 'change', turnId: 't1', handle: 'alpha', fileId: 'wf_1', before: snap(one, 4), after: snap(two, 8), added: 1, deleted: 0, at: 12 },
    { id: 'e1', kind: 'edit', turnId: 't1', handle: 'alpha', rel: 'b.txt', host: { id: 'h1', name: 'devbox' }, at: 13 },
  ];
  const file = {
    id: 'wf_1',
    kind: 'file',
    path,
    rel: 'a.txt',
    existed: true,
    before: snap(one, 4),
    after: snap(two, 8),
    added: 1,
    deleted: 0,
    handles: ['alpha'],
    turns: ['t1'],
  };
  const t2 = [turn('t2', 20), { id: 'c2', kind: 'command', turnId: 't2', handle: 'alpha', state: 'done', exit: 0, command: 'pwd', at: 21 }];
  const t3 = [turn('t3', 30)];
  const t4 = [turn('t4', 40)];
  const t5 = [turn('t5', 50)];
  for (const entry of [...t1, file, ...t2, ...t3, ...t4, ...t5]) store.emit('work.add', { convId: conv.id, entry });
  const steps = { steps: [{ id: 's1', label: 'Read', detail: 't1 read a.txt' }] };
  store.emit('item.add', { threadId: topic.id, item: { id: 'r1', kind: 'agent', turnId: 't1', text: 'done', at: 14, activity: steps } });
  await store.flush();
  const t1Sha = await archiveTurn(store, blobs, {
    convId: conv.id,
    turnId: 't1',
    work: t1,
    activity: { [topic.id]: { r1: steps } },
    items: [{ threadId: topic.id, id: 'r1' }],
  });
  const t3Sha = await archiveTurn(store, blobs, { convId: conv.id, turnId: 't3', work: t3 });
  await writeFile(blobs.pathOf(t3Sha), '{"v":1,"damaged":true}');
  // t4’s summary names a file the blob store never had: the event is committed by hand, as a lost file would leave it.
  const missing = 'f'.repeat(64);
  await store.commit([{ type: 'turn.archive', data: archiveEvent(conv.id, 't4', missing, t4) }]);
  await archiveTurn(store, blobs, { convId: conv.id, turnId: 't5', work: t5, fileConvId: 'th_another' });
  await store.flush();
  return { conv, topic, t1Sha, path };
}
