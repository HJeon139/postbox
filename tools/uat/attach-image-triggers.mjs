// The attach-image scenarios’ triggers (#1307, tests/uat/e2e/scenarios/attachimage.md and attachimage-compat.md;
// tools/uat/triggers.mjs has what a trigger is): the person attached the test picture (tests/uat/e2e/attachments/
// picture.png, an orange triangle with the word KIWI in it) and an agent’s reply to it names both, so it read the image
// itself. Its file name says neither, so an agent that couldn’t open it can’t name them from the message. A reply
// answers the newest picture sent before it in its thread, so one naming the first picture never counts for a second.

import { clip, itemsOf } from './trigger-facts.mjs';

/** What the test picture shows: a reply must name all of these. */
const SHOWN = [/\bkiwi\b/i, /triang/i];

const sentPicture = (it) => it.kind === 'user' && (it.attachments ?? []).some((a) => a?.kind === 'file' && /\.png$/i.test(String(a.name ?? '')));

/**
 * The agents’ replies that name the picture sent at items[i], before the next picture in its thread.
 * @param {any[]} items @param {number} i
 */
function namings(items, i) {
  const sent = items[i];
  const later = items.slice(i + 1).filter((x) => x.threadId === sent.threadId);
  const next = later.findIndex(sentPicture);
  return (next < 0 ? later : later.slice(0, next)).filter((x) => x.kind === 'agent' && SHOWN.every((re) => re.test(String(x.text ?? ''))));
}

/** Each picture the person sent, with the replies naming it. @param {any} f */
const pictures = (f) => {
  const items = itemsOf(f);
  return items.flatMap((it, i) => (sentPicture(it) ? [{ sent: it, replies: namings(items, i) }] : []));
};

const at = (/** @type {any} */ x) => (Number.isFinite(x?.at) ? x.at : null);
const said = (/** @type {any} */ reply) => `@${reply.handle} said: “${clip(String(reply.text).trim(), 120)}”`;

/** @type {Record<string, { issue: number, says: string, recorded: (f: any) => boolean, run: (f: any) => { at: number|null, evidence: string }[] }>} */
export const ATTACH_IMAGE_TRIGGERS = {
  'attached-image-read': {
    issue: 1307,
    says: 'the person attached a PNG, and an agent’s reply after it named what the picture shows (a triangle with the word KIWI)',
    recorded: (f) => !!f.state,
    run: (f) =>
      pictures(f)
        .filter((p) => p.replies.length)
        .map((p) => ({ at: at(p.replies[0]), evidence: said(p.replies[0]) })),
  },
  // A later turn’s attachment is a new upload at a new path, so it must be readable as the first one was.
  'attached-image-read-again': {
    issue: 1307,
    says: 'the person attached the PNG again in a later message, and a reply to that one named what it shows too',
    recorded: (f) => !!f.state,
    run: (f) => {
      const named = pictures(f).filter((p) => p.replies.length);
      return named.slice(1).map((p) => ({ at: at(p.replies[0]), evidence: `Picture ${named.indexOf(p) + 1}: ${said(p.replies[0])}` }));
    },
  },
  // The compatibility run’s: each backend opens images its own way.
  'attached-image-read-by-each': {
    issue: 1307,
    says: 'the person attached a PNG, and every agent in the conversation replied after it naming what the picture shows',
    recorded: (f) => !!f.state,
    run: (f) =>
      pictures(f).flatMap(({ sent, replies }) => {
        const handles = Object.values(f.state.sessions ?? {})
          .filter((se) => se?.threadId === sent.threadId && !se.archived)
          .map((se) => se.handle);
        const each = handles.map((h) => replies.find((r) => r.handle === h));
        if (!handles.length || each.some((r) => !r)) return [];
        return [
          { at: Math.max(...each.map((r) => at(r) ?? 0)) || null, evidence: `${handles.map((h) => `@${h}`).join(', ')} each named the triangle and KIWI.` },
        ];
      }),
  },
};
