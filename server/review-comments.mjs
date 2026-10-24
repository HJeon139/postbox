// review_block (#133): an agent comments on another agent’s review block in its conversation, in the comment shape the
// person’s review uses (shared/review-comments.mjs). Each comment becomes an open thread on the draft, with the agent’s
// handle as its author, where the person’s comments go. The block’s agent hears them as an event, so it can revise and
// resolve them; the block still waits on the person, who decides. A revision that leaves one of those threads out keeps
// it, following its line or quote into the new text, so a reviewer’s comment never vanishes from the draft: the block’s
// agent resolves it instead.

import { validateBlock } from '../shared/catalog.mjs';
import { commentErrors, MAX_COMMENTS, quoteOf, VERDICTS } from '../shared/review-comments.mjs';
import { findQuote, splitLines } from '../shared/review-diff.mjs';

/**
 * review_block { blockId, comments, verdict? } for the session’s turn.
 * @param {any} rt @param {string} sessionId @param {any} args
 * @returns {{ ok: boolean, message: string }}
 */
export function reviewBlock(rt, sessionId, args) {
  const se = rt.session(sessionId);
  const { blockId, comments, verdict } = args && typeof args === 'object' ? args : {};
  if (typeof blockId !== 'string' || !blockId.trim()) return no('blockId names the review block: its id, or its item id.');
  if (verdict !== undefined && !VERDICTS.includes(verdict)) return no('verdict is “comment”, “approve” or “request_changes”, or left out.');
  if (!Array.isArray(comments) || !comments.length || comments.length > MAX_COMMENTS)
    return no(`comments is a list of 1 to ${MAX_COMMENTS} comments, such as [{ line: 12, text: "…" }].`);
  const found = find(rt, se, blockId.trim());
  if ('message' in found) return found;
  const { it, where } = found;
  if (it.sessionId === sessionId) return no(`${it.block.id} is your own review block: add or answer its threads with update_block.`);
  if (it.closed || it.answered)
    return no(
      `@${it.handle}’s ${it.block.id} is ${it.closed ? 'closed' : 'answered'} already, so it takes no more comments. Say what you’d change in a message instead.`,
    );
  const problems = comments.flatMap((c, i) => [...commentErrors(c, `comments[${i}]`), ...placeError(it.block, c, i)]);
  if (problems.length) return no(`Nothing was added: ${problems.slice(0, 5).join(' ')}`);

  const { threads, added } = withComments(it.block.threads ?? [], comments, se.handle);
  const block = { ...it.block, threads };
  // Built from checked parts, but checked again as a whole: a block on screen is always one the catalog takes.
  const v = validateBlock(block, { imageOrigins: rt.config.imageOrigins });
  if (!v.ok) return no(`Nothing was added: ${v.errors.join(' ')}`);
  const revision = it.revision ?? 1;
  const review = { handle: se.handle, ...(verdict ? { verdict } : {}), revision, threads: added.map((c) => c.threadId), at: Date.now() };
  rt.patchItem(where, it.id, { block: v.block, reviews: [...(it.reviews ?? []), review] });
  const event = { blockId: it.block.id, revision, action: 'review', values: { ...(verdict ? { verdict } : {}), comments: added }, from: se.handle };
  let heard = `@${it.handle} hears them now, and can revise.`;
  try {
    rt.deliver(it.sessionId, { kind: 'event', event }, { threadId: where });
  } catch (e) {
    heard = `@${it.handle} didn’t hear them: ${e.message}`;
  }
  const n = added.length;
  return {
    ok: true,
    message: `Added ${n} comment${n === 1 ? '' : 's'} to @${it.handle}’s ${it.block.id} (revision ${revision}). ${heard} The block still waits on the person.`,
  };
}

/**
 * A review update keeps the threads review_block added that it leaves out, each following its quote, or its line’s
 * text, into the new text. The block’s agent resolves a reviewer’s thread; it can’t drop one, or change what anyone
 * said in it: a thread a reviewer took part in that it sends back keeps its stored comments, takes its status, and
 * gains the update’s new comments after them, except any in another agent’s name. One a reviewer started keeps its
 * place too. So the caller validates the result: kept threads can take it past the catalog’s limit.
 * @param {any} existing  the block item as it was @param {any} block  the update, validated
 */
export function keepReviewThreads(existing, block) {
  const theirs = new Set((existing.reviews ?? []).flatMap((r) => r.threads));
  const stored = new Map((existing.block.threads ?? []).filter((t) => theirs.has(t.id)).map((t) => [t.id, t]));
  if (!stored.size) return block;
  const moves = typeof existing.block.content === 'string' && typeof block.content === 'string' && existing.block.content !== block.content;
  const was = moves ? splitLines(existing.block.content) : [];
  const now = moves ? splitLines(block.content) : [];
  const placed = (t) => (moves ? follow(t, block.content, was, now) : t);
  const agent = (c) => c.author.startsWith('@') && c.author !== `@${existing.handle}`;
  const key = (c) => JSON.stringify([c.author, c.text]);
  const sent = (block.threads ?? []).map((t) => {
    const before = stored.get(t.id);
    if (!before) return t;
    const said = new Map();
    for (const c of before.comments) said.set(key(c), (said.get(key(c)) ?? 0) + 1);
    const added = t.comments.filter((c) => {
      const n = said.get(key(c)) ?? 0;
      if (n) said.set(key(c), n - 1);
      return !n && !agent(c);
    });
    const { comments: _, status: __, ...place } = agent(before.comments[0]) ? placed(before) : t;
    return { ...place, id: t.id, status: t.status, comments: [...before.comments, ...added] };
  });
  const ids = new Set(sent.map((t) => t.id));
  const left = [...stored.values()].filter((t) => !ids.has(t.id)).map(placed);
  return { ...block, threads: [...sent, ...left] };
}

/**
 * A thread moved from one text to the next in one pass, as a server can afford on a long draft (the person’s page
 * diffs line by line instead, review-diff.mjs): on a selection, to its quote nearest where it was; on a line, to that
 * line’s text nearest where it was. One whose text is gone stays on its line, as a line comment.
 * @param {any} t @param {string} to  the new text @param {string[]} was  the old text’s lines @param {string[]} now  the new
 */
function follow(t, to, was, now) {
  if (typeof t.line !== 'number') return t;
  if (typeof t.quote === 'string') {
    const at = findQuote(to, t.quote, t.line);
    if (at) return { ...t, ...at };
    const { col: _c, endLine: _l, endCol: _e, quote: _q, ...rest } = t;
    return { ...rest, line: Math.min(t.line, now.length) };
  }
  const text = was[t.line - 1];
  let best = -1;
  for (let i = 0; i < now.length; i++) if (now[i] === text && (best < 0 || Math.abs(i + 1 - t.line) < Math.abs(best + 1 - t.line))) best = i;
  return { ...t, line: best > -1 ? best + 1 : Math.min(t.line, now.length) };
}

const no = (message) => ({ ok: false, message });

/**
 * A block’s threads with an agent’s comments added: each a thread of its own, named for the agent, or a reply in the
 * thread it names. added is each comment with the thread it’s in, as the block’s agent hears it.
 * @param {any[]} before @param {any[]} comments  checked by commentErrors and placeError @param {string} handle
 */
function withComments(before, comments, handle) {
  const author = `@${handle}`;
  const threads = [...before];
  const added = [];
  const ids = new Set(threads.map((t) => t.id));
  for (const { text, threadId, ...anchor } of comments) {
    if (threadId !== undefined) {
      const k = threads.findIndex((t) => t.id === threadId);
      threads[k] = { ...threads[k], comments: [...threads[k].comments, { author, text }] };
      added.push({ threadId, text });
      continue;
    }
    let n = threads.length + 1;
    while (ids.has(`${handle}-${n}`)) n++;
    const id = `${handle}-${n}`;
    ids.add(id);
    threads.push({ id, status: 'open', ...anchor, comments: [{ author, text }] });
    added.push({ ...anchor, text, threadId: id });
  }
  return { threads, added };
}

/**
 * The review block blockId names in the session’s conversation: by its id, or its item’s.
 * @param {any} rt @param {any} se @param {string} key
 */
function find(rt, se, key) {
  const all = rt
    .conversationThreads(se.threadId)
    .flatMap((where) => rt.store.items(where).map((it) => ({ it, where })))
    .filter(({ it }) => it.kind === 'block' && it.valid && it.block.type === 'review' && (it.id === key || it.block.id === key));
  if (!all.length) return no(`There’s no review block “${key.slice(0, 80)}” in this conversation. read_conversation shows each block with its id.`);
  if (all.length > 1)
    return no(`More than one review block is called “${key}”: ${all.map(({ it }) => `@${it.handle}’s is ${it.id}`).join(', ')}. Name one by that id.`);
  return all[0];
}

/**
 * Why a comment doesn’t fit this block: a line it doesn’t have, a quote that isn’t the text there, an app review
 * without an anchor, or a thread it doesn’t have.
 * @param {any} b @param {any} c @param {number} i
 */
function placeError(b, c, i) {
  if (!c || typeof c !== 'object') return [];
  if (c.threadId !== undefined) return (b.threads ?? []).some((t) => t.id === c.threadId) ? [] : [`comments[${i}]: there’s no thread ${c.threadId} on it.`];
  if (b.format === 'app') return c.anchor === undefined ? [`comments[${i}]: an app review’s comment names a part of the app as anchor.`] : [];
  const lines = splitLines(b.content);
  if (c.line === undefined) return [`comments[${i}]: a ${b.format} review’s comment is on a line.`];
  if (c.line > lines.length || (c.endLine ?? c.line) > lines.length) return [`comments[${i}]: the draft has ${lines.length} lines.`];
  if (c.quote === undefined) return [];
  const long = (n) => (lines[n - 1] ?? '').length;
  if (c.col > long(c.line) || c.endCol > long(c.endLine))
    return [`comments[${i}]: line ${c.col > long(c.line) ? c.line : c.endLine} has ${long(c.col > long(c.line) ? c.line : c.endLine)} characters.`];
  const there = quoteOf(lines, c);
  return there === c.quote
    ? []
    : [`comments[${i}]: its quote isn’t the text at those columns, which is “${there.slice(0, 120)}”. Send the text as it is there.`];
}
