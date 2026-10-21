// Narration for agent apps: postbox.narrate() in the kit reaches here through the narrate.speak host tool.
// Speech runs in a child process (worker.mjs) that starts on first use and stays up while it’s needed.
// Each clip is kept in the blob store under its SHA-256, and a request for the same text and voice
// reuses it, so an app that reloads doesn’t synthesize again.

import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));
export const VOICES = ['af_heart', 'af_bella', 'af_nicole', 'am_michael', 'am_fenrir', 'bf_emma', 'bm_george'];
const MAX_CHARS = 1200;
const IDLE_MS = 5 * 60 * 1000;

/** Whether Kokoro is installed (it’s an optional dependency). */
export function narrationInstalled() {
  try {
    createRequire(import.meta.url).resolve('kokoro-js');
    return true;
  } catch {
    return false;
  }
}

export class Narrator {
  /** @param {{ modelsDir: string, blobs: any, forkImpl?: typeof fork }} opts */
  constructor({ modelsDir, blobs, forkImpl = fork }) {
    this.modelsDir = modelsDir;
    this.blobs = blobs;
    this.fork = forkImpl;
    /** @type {import('node:child_process').ChildProcess|null} */
    this.child = null;
    this.waiting = new Map(); // request id → { resolve, reject }
    this.clips = new Map(); // text+voice key → { sha256, ms }
    this.seq = 0;
    /** @type {NodeJS.Timeout|null} */
    this.idle = null;
    this.progress = null; // { loaded, total } while the model downloads
  }

  start() {
    if (this.child) return this.child;
    const child = this.fork(WORKER, [], { env: { ...process.env, POSTBOX_MODELS_DIR: this.modelsDir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    child.on('message', (/** @type {any} */ m) => {
      if (m.type === 'progress') this.progress = { loaded: m.loaded, total: m.total };
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.type === 'done') w.resolve(m);
      else w.reject(new Error(`Narration failed: ${m.message}`));
    });
    child.on('exit', () => {
      this.child = null;
      for (const w of this.waiting.values()) w.reject(new Error('The narration process stopped. Try again.'));
      this.waiting.clear();
    });
    child.stderr?.on('data', () => {}); // its warnings aren’t Postbox’s
    this.child = child;
    return child;
  }

  /** Stops the worker after a while without requests, to give its memory back. */
  touch() {
    clearTimeout(this.idle ?? undefined);
    this.idle = setTimeout(() => this.stop(), IDLE_MS);
    this.idle.unref?.();
  }

  stop() {
    clearTimeout(this.idle ?? undefined);
    this.child?.kill();
    this.child = null;
  }

  /**
   * Speaks one passage. Returns { wav (base64), ms, sha256 }.
   * @param {{ text: string, voice?: string, speed?: number }} req
   */
  async speak({ text, voice = 'af_heart', speed = 1 }) {
    const t = String(text ?? '').trim();
    if (!t) throw Object.assign(new Error('There’s no text to read.'), { status: 400 });
    if (t.length > MAX_CHARS)
      throw Object.assign(new Error(`Narration takes up to ${MAX_CHARS} characters at a time. Split the text into passages.`), { status: 413 });
    const v = VOICES.includes(voice) ? voice : 'af_heart';
    const s = Math.min(2, Math.max(0.5, Number(speed) || 1));
    const key = createHash('sha256').update(`${v}|${s}|${t}`).digest('hex');
    const known = this.clips.get(key);
    if (known) {
      const wav = await this.blobs.get(known.sha256).catch(() => null);
      if (wav) return { wav: wav.toString('base64'), ms: known.ms, sha256: known.sha256 };
    }
    this.touch();
    const id = ++this.seq;
    const done = new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    this.start().send({ type: 'speak', id, text: t, voice: v, speed: s });
    const r = await done;
    const { sha256 } = await this.blobs.put(Buffer.from(r.wav, 'base64'));
    this.clips.set(key, { sha256, ms: r.ms });
    return { wav: r.wav, ms: r.ms, sha256 };
  }
}
