// What the run’s own Postbox printed (tools/uat/postbox.mjs), line by line, and whether it exited by itself, kept
// apart from the run’s log so a check can read it (tools/uat/checks-postbox.mjs). A run saves it in its folder for
// --recheck; a run from before that has only its run.log, where the runner copied the same lines.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {{ stream: 'stdout' | 'stderr', text: string, step: number | null }} OutputLine
 * @typedef {{ code: number | null, signal: string | null, step: number | null }} OutputExit
 * @typedef {{ lines: OutputLine[], exits: OutputExit[] }} PostboxOutput
 */

/** The file a run keeps it in. */
export const OUTPUT_FILE = 'postbox-output.json';

/**
 * Records a server’s output as whole lines: a pipe can split one line across two chunks, or join several in one.
 * step says which step of the run is going on, for each line as it ends.
 * @param {() => number | null} step
 */
export function outputRecorder(step) {
  /** @type {PostboxOutput} */
  const output = { lines: [], exits: [] };
  const rest = { stdout: '', stderr: '' };
  /** @param {'stdout' | 'stderr'} stream @param {string} text */
  const add = (stream, text) => {
    output.lines.push({ stream, text, step: step() });
  };
  return {
    output,
    /** @param {'stdout' | 'stderr'} stream @param {string} chunk */
    feed(stream, chunk) {
      const parts = (rest[stream] + chunk).split('\n');
      rest[stream] = parts.pop() ?? '';
      for (const p of parts) add(stream, p.replace(/\r$/, ''));
    },
    /** The end of its output: a last line without a newline still counts. */
    flush() {
      for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
        if (rest[stream]) add(stream, rest[stream]);
        rest[stream] = '';
      }
    },
    /** It exited when nothing asked it to: a crash, as a check reads it. @param {number | null} code @param {string | null} signal */
    exited(code, signal) {
      output.exits.push({ code, signal, step: step() });
    },
  };
}

/** Keeps it in the run’s folder, for --recheck. @param {string} dir @param {PostboxOutput} output */
export function writePostboxOutput(dir, output) {
  writeFileSync(join(dir, OUTPUT_FILE), `${JSON.stringify(output)}\n`);
}

/**
 * What a finished run’s Postbox printed: the file the run kept, or, for a run from before it, the lines its run.log
 * copied. The log says nothing of exits, and gives each line the step its last “step N ·” line named.
 * @param {string} dir @returns {PostboxOutput}
 */
export function readPostboxOutput(dir) {
  const kept = join(dir, OUTPUT_FILE);
  if (existsSync(kept)) return JSON.parse(readFileSync(kept, 'utf8'));
  const log = join(dir, 'run.log');
  return { lines: existsSync(log) ? outputInLog(readFileSync(log, 'utf8')) : [], exits: [] };
}

/**
 * The output lines in a run.log. The runner logs each chunk as one timestamped line, “postbox: …” or
 * “postbox (stderr): …”, and the chunk’s other lines follow it without a timestamp.
 * @param {string} text @returns {OutputLine[]}
 */
export function outputInLog(text) {
  /** @type {OutputLine[]} */
  const out = [];
  /** @type {'stdout' | 'stderr' | null} */
  let open = null;
  let step = 0;
  for (const line of text.split('\n')) {
    const stamped = /^\[\d\d:\d\d:\d\d\] (.*)$/.exec(line);
    if (!stamped) {
      if (open && line) out.push({ stream: open, text: line, step });
      continue;
    }
    const stepLine = /^step (\d+) · /.exec(stamped[1]);
    if (stepLine) step = Number(stepLine[1]);
    const said = /^postbox( \(stderr\))?: (.*)$/.exec(stamped[1]);
    open = null;
    if (!said) continue;
    open = said[1] ? 'stderr' : 'stdout';
    out.push({ stream: open, text: said[2], step });
  }
  return out;
}
