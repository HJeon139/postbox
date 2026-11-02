// #671: a message’s attachments, as the agents it wasn’t sent to read it, in their history and catch-up, a topic
// thread’s opener, and read_message and read_conversation. Only the turn a message is sent to was given a path
// (server/adapters/guide.mjs’s formatBody); the rest had only the names.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';
import { setup } from './remote-runtime-helpers.mjs';

const SHA = 'ab'.repeat(32);

function room() {
  const { rt, store } = setup();
  rt.blobs = new Blobs(mkdtempSync(join(tmpdir(), 'pb-blobs-')));
  store.emit('file', { id: 'f1', name: 'Pasted text.txt', type: 'text/plain', size: 12, sha256: SHA });
  const h = rt.addHost({ name: 'host.example.com' });
  const near = rt.createPersona({ handle: 'near', backend: 'claude-code' });
  const far = rt.createPersona({ handle: 'far', backend: 'claude-code', remote: { hostId: h.id } });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [near.id, far.id] });
  const sessionOf = (p) => Object.values(store.state.sessions).find((x) => x.threadId === t.id && x.personaId === p.id);
  const attachments = [
    { kind: 'file', fileId: 'f1', name: 'Pasted text.txt', type: 'text/plain' },
    { kind: 'project-file', path: 'notes/plan.md' },
  ];
  const item = rt.addItem(t.id, { kind: 'user', text: 'Read these.', attachments });
  return { rt, t, item, near, far, sessionOf, upload: rt.blobs.pathOf(SHA) };
}

test('#671: a local agent the message wasn’t sent to gets each attachment’s path, in its history and the read tools', () => {
  const { rt, item, near, sessionOf, upload } = room();
  const se = sessionOf(near);
  const want = `[attached: Pasted text.txt at ${upload}, notes/plan.md at /work/project/notes/plan.md]`;
  assert.ok(rt.describeItem(item, se).includes(want), 'the catch-up line');
  const read = rt.readMessage(se, { id: item.id });
  assert.ok(read.ok && read.message.includes(want), read.message);
  assert.ok(rt.readConversation(se).includes(want), 'read_conversation');
});

test('#671: an agent on a remote host gets the names, and that its host can’t open them yet', () => {
  const { rt, item, far, sessionOf, upload } = room();
  const se = sessionOf(far);
  for (const line of [rt.describeItem(item, se), rt.readMessage(se, { id: item.id }).message, rt.readConversation(se)]) {
    assert.ok(line.includes('[attached: Pasted text.txt, notes/plan.md] Your host can’t open attachments from earlier messages yet'), line);
    assert.ok(!line.includes(upload) && !line.includes('/work/project'), 'no path on this computer');
  }
});

test('#671: a topic thread’s opener gives a local agent the paths too', () => {
  const { rt, t, item, near, sessionOf, upload } = room();
  const { threadId } = rt.startTopic(t.id, item.id);
  // A topic thread shares the agent’s session (#228).
  const line = rt.topicRootLine(sessionOf(near), rt.s.threads[threadId]);
  assert.match(line, /^This thread started from your message: Read these\./);
  assert.ok(line.includes(`Pasted text.txt at ${upload}`), line);
});

test('#671: with no reader, a line names the attachments alone', () => {
  const { rt, item } = room();
  assert.equal(rt.describeItem(item), 'You: Read these. [attached: Pasted text.txt, notes/plan.md]');
});
