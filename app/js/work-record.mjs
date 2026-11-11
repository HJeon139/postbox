// A finished turn’s one-line work record, at the top of its post (designs/rooms-at-scale.md, “Live state”): what it
// changed, ran and published, as Work’s line for the turn says it (shared/work.mjs, turnLine), its counts green and
// red. It opens to the turn’s steps, with a link to the turn in Work.

import { turnLine } from '/shared/work.mjs';
import { ledgerIndex } from '/shared/work-index.mjs';
import { client } from './client.mjs';
import { fill, h } from './dom.mjs';
import { openWork, paneHref } from './ui.mjs';

/** The conversation whose Work a thread’s turns are in: a side thread’s or a topic’s is its parent’s. @param {string} threadId */
export function convOf(threadId) {
  const t = client.state.threads[threadId];
  return (t?.kind === 'side' || t?.kind === 'topic') && t.parentId ? t.parentId : threadId;
}

const COUNTS = /(\+[\d,]+) (−[\d,]+)/;
/** A record’s words, “+35 −0” in green and red. @param {string} line */
function words(line) {
  const m = COUNTS.exec(line);
  if (!m) return [line];
  return [line.slice(0, m.index), h('span.work-n', h('span.add', m[1]), ' ', h('span.del', m[2])), line.slice(m.index + m[0].length)];
}

/**
 * The turn’s record, kept current while the ledger finishes it (it reads the files the turn changed once it ends);
 * `fallback` until the ledger has a line for the turn.
 * @param {any} it  the agent item @param {string} threadId @param {any[]} fallback
 */
export function recordWords(it, threadId, fallback) {
  const conv = convOf(threadId);
  const el = h('span.work-record');
  const paint = () => {
    const line = it.turnId ? turnLine(client.state.work?.[conv] ?? [], it.turnId) : null;
    fill(el, ...(line ? words(line) : fallback));
  };
  paint();
  // Once it was on the page and isn’t any more, it stops listening, at the next event of any kind.
  let shownOnce = false;
  const off = client.on((ch) => {
    shownOnce ||= el.isConnected;
    if (shownOnce && !el.isConnected) return off();
    if ((ch.type !== 'work.add' && ch.type !== 'work.patch') || ch.data.convId !== conv) return;
    if ((ch.data.entry ?? ledgerIndex(client.state.work?.[conv] ?? []).byId.get(ch.data.id))?.turnId === it.turnId) paint();
  });
  return el;
}

/** The link to the turn in Work. @param {any} it @param {string} threadId */
export function workLink(it, threadId) {
  const conv = convOf(threadId);
  return h(
    'a.work-record-link',
    {
      href: paneHref(conv, { work: true, turn: it.turnId }),
      onclick: (/** @type {MouseEvent} */ e) => {
        e.preventDefault();
        openWork(conv, { turn: it.turnId });
      },
    },
    'Open this turn in Work',
  );
}
