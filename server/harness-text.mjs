// A turn’s words, as the harness-event contract reports them (server/harness-events.mjs): the reply’s text, a
// paragraph break between its blocks, thoughts and a subagent’s narration as steps, and the glimpse of what the agent
// is thinking or writing now. Moved from server/adapters/claude-stream.mjs and claude-reply.mjs, which built these for
// Claude Code alone, while each other adapter built its own.

import { STEP_TEXT } from '../shared/limits.mjs';
import { appendGlimpseSource, glimpseOf } from '../shared/text.mjs';
import { byOf, firstSentence } from './harness-tools.mjs';

// The least time between two showings of a thought still being written, in milliseconds.
const THOUGHT_EVERY = 1000;

/**
 * Text without Markdown’s emphasis and code marks, its runs of whitespace as one space, to compare streamed text with a
 * result’s, which may be plain. @param {string} s
 */
const squash = (s) =>
  s
    .replace(/[*_`~]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');

export class HarnessText {
  /** @param {any} ctx @param {(patch: any) => void} status @param {() => number} now */
  constructor(ctx, status, now) {
    this.ctx = ctx;
    this.status = status;
    this.now = now;
    this.wrote = false;
    this.written = ''; // the reply’s text so far, its last 200,000 characters
    /** @type {unknown} */
    this.block = undefined;
    this.said = ''; // the reply’s text, for the glimpse
    this.shown = ''; // the glimpse shown now
    this.at = 0;
    this.pending = '';
    this.thoughts = 0;
    this.narrations = 0;
    this.calls = 0; // the turn’s own tool calls so far: text without a block starts a paragraph after one
    /** @type {Map<unknown, { text: string, id: string | null, at: number }>} a thought still streaming, by its block */
    this.thinking = new Map();
  }

  /** The latest whole sentences of what the agent is thinking or writing, at most a few times a second. @param {string} text */
  glimpse(text, { force = false } = {}) {
    if (!force && this.now() - this.at < 400) {
      this.pending = text;
      return;
    }
    const t = glimpseOf(text);
    this.pending = '';
    if (!t || t === this.shown) return;
    this.at = this.now();
    this.shown = t;
    this.ctx.status({ glimpse: t });
  }

  flush() {
    if (this.pending) this.glimpse(this.pending, { force: true });
  }

  /** Words of the reply. A new block starts a paragraph, and the ring’s “writing”. @param {string} text @param {unknown} [block] */
  write(text, block = `after-call-${this.calls}`) {
    if (block !== this.block) {
      this.block = block;
      if (this.wrote) this.ctx.text('\n\n');
      this.status({ state: 'gen', currentStep: 'Writing a reply' });
    }
    if (!text) return;
    this.ctx.text(text);
    this.written = (this.written + text).slice(-200_000);
    this.wrote = true;
    this.said = appendGlimpseSource(this.said, text);
    this.glimpse(this.said);
  }

  /**
   * A thought, as a step in the list: finished, or running with its text so far. Returns its id, made for a new one.
   * @param {string} text @param {any} [by] @param {{ id?: string | null, state?: string }} [as]
   */
  thoughtStep(text, by = null, { id = null, state = 'done' } = {}) {
    const t = String(text ?? '').trim();
    if (!t) return id;
    const step = id ?? `thought-${++this.thoughts}`;
    this.ctx.activity({ id: step, label: firstSentence(t, 120), state, kind: 'thought', detail: t.slice(0, STEP_TEXT.thought), ...byOf(by) });
    return step;
  }

  /**
   * A piece of a thought; a whole one is a step at once. A streamed one shows as it’s written: its text so far a second
   * after it began, and then at most once a second (THOUGHT_EVERY), so a long thought isn’t an event per piece. @param {string} text @param {unknown} block
   * @param {boolean} [whole]
   */
  think(text, block, whole = false) {
    if (whole) return this.thoughtStep(text);
    let t = this.thinking.get(block);
    if (!t) {
      t = { text: '', id: null, at: this.now() }; // a thought shorter than THOUGHT_EVERY shows once, whole
      this.thinking.set(block, t);
      this.status({ state: 'think', currentStep: 'Thinking' });
    }
    if (!text) return;
    t.text += text;
    this.glimpse(t.text);
    if (this.now() - t.at < THOUGHT_EVERY) return;
    t.at = this.now();
    t.id = this.thoughtStep(t.text, null, { id: t.id, state: 'running' });
  }

  /** A streamed thought ended: its step is whole. @param {unknown} block */
  thought(block) {
    const t = this.thinking.get(block);
    if (!t) return;
    this.flush();
    this.thoughtStep(t.text, null, { id: t.id });
    this.thinking.delete(block);
  }

  /** A subagent’s own words: a step in its voice, never the reply (#73). @param {string} text @param {any} by */
  narrate(text, by) {
    const t = String(text ?? '').trim();
    if (!t) return;
    this.narrations += 1;
    this.ctx.activity({
      id: `said-${this.narrations}`,
      label: firstSentence(t, 200),
      state: 'done',
      kind: 'said',
      detail: t.slice(0, STEP_TEXT.thought),
      ...byOf(by),
    });
  }

  /** After a compaction, the reply’s next words start fresh. */
  compacted() {
    this.wrote = false;
  }

  /**
   * A reply only the turn’s end carried (#485), posted when it isn’t what was written. Its first words are enough to
   * know it: a reply posted twice is worse than one missed here, which the runtime’s empty-reply guard still catches.
   * @param {{ isError?: boolean, text?: string }} e
   */
  fromResult(e) {
    const said = !e.isError && typeof e.text === 'string' ? e.text.trim() : '';
    if (said && !squash(this.written).includes(squash(said).slice(0, 60))) this.write(said, Symbol('result'));
  }
}
