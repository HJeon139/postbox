import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Blobs } from '../server/blobs.mjs';
import { Narrator } from '../server/narration/narrator.mjs';

/** A stand-in for the Kokoro worker: answers each request with a tiny WAV-shaped clip. */
function fakeFork({ fail = false } = {}) {
  const runs = [];
  const forkImpl = (file, _args, opts) => {
    const child = new EventEmitter();
    child.sent = [];
    child.send = (m) => {
      child.sent.push(m);
      setImmediate(() =>
        child.emit(
          'message',
          fail
            ? { type: 'error', id: m.id, message: 'model missing' }
            : { type: 'done', id: m.id, wav: Buffer.from(`RIFF${m.voice}${m.text}`).toString('base64'), ms: 1200 },
        ),
      );
    };
    child.kill = () => child.emit('exit', 0);
    runs.push({ file, opts, child });
    return child;
  };
  return { forkImpl, runs };
}

const setup = async (opts) => {
  const { forkImpl, runs } = fakeFork(opts);
  const blobs = new Blobs(await mkdtemp(join(tmpdir(), 'pb-narr-')));
  return { n: new Narrator({ modelsDir: '/tmp/models', blobs, forkImpl }), runs };
};

test('narration speaks in a separate process, stores the clip, and reuses it for the same text', async () => {
  const { n, runs } = await setup();
  const a = await n.speak({ text: 'Hello there.' });
  assert.equal(Buffer.from(a.wav, 'base64').toString(), 'RIFFaf_heartHello there.');
  assert.equal(a.ms, 1200);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].opts.env.POSTBOX_MODELS_DIR, '/tmp/models');
  const b = await n.speak({ text: 'Hello there.' });
  assert.equal(b.sha256, a.sha256);
  assert.equal(runs[0].child.sent.length, 1, 'the second request came from the store');
  await n.speak({ text: 'Hello there.', voice: 'bm_george' });
  assert.equal(runs[0].child.sent.length, 2, 'another voice is another clip');
  n.stop();
});

test('narration checks its input and passes on failures as sentences', async () => {
  const { n } = await setup();
  await assert.rejects(n.speak({ text: '   ' }), /no text to read/);
  await assert.rejects(n.speak({ text: 'x'.repeat(1201) }), /up to 1200 characters/);
  const unknown = await n.speak({ text: 'Hi', voice: 'not-a-voice', speed: 9 });
  assert.ok(unknown.wav);
  const bad = await setup({ fail: true });
  await assert.rejects(bad.n.speak({ text: 'Hi' }), /Narration failed: model missing/);
  n.stop();
});
