// A remote turn’s stdin, by its kind (process.mjs’s header): kept for start’s message file, sent line by line to a
// held stdin, or dropped with a note.

import { Writable } from 'node:stream';

/** @typedef {import('./process.mjs').RemoteProcess} RemoteProcess */

/** @param {RemoteProcess} p */
export function makeStdin(p) {
  if (p.kind === 'file') {
    /** @type {Buffer[]} */
    const chunks = [];
    return new Writable({
      write: (chunk, _enc, cb) => {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final: (cb) => {
        cb();
        if (!p.startSent && p.startBody) p.sendStart(p.startFiles(Buffer.concat(chunks).toString('utf8')));
      },
    });
  }
  if (p.kind === 'held') {
    let partial = '';
    const decoder = new TextDecoder();
    const take = (/** @type {string} */ text) => {
      const parts = (partial + text).split('\n');
      partial = /** @type {string} */ (parts.pop());
      p.queue.push(...parts);
      p.pump();
    };
    return new Writable({
      write: (chunk, _enc, cb) => {
        take(decoder.decode(chunk, { stream: true }));
        cb();
      },
      final: (cb) => {
        take(decoder.decode());
        if (partial) p.queue.push(partial);
        partial = '';
        p.pump();
        cb();
      },
    });
  }
  let told = false;
  return new Writable({
    write: (_chunk, _enc, cb) => {
      if (!told) p.note('This turn’s agent takes no stdin, so what was written to it was dropped.');
      told = true;
      cb();
    },
  });
}
