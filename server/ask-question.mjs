// Claude Code’s AskUserQuestion (#521). The CLI sends it to its permission prompt tool and the Agent SDK to canUseTool,
// in Auto and Ask me alike (Bypass passes no prompt tool, and the CLI then doesn’t offer it), and both reach
// rt.requestPermission. So the question is asked there as Postbox’s own choice blocks, one per question and one at a
// time, and the person’s answers are the tool’s result:
// { behavior: 'allow', updatedInput: { questions, answers } }, keyed by each question’s text, several labels joined
// with “, ” (tests/fixtures/claude-code/ask-user-question-prompts.json). A question the catalog can’t show keeps the
// permission card it had before.
//
// On a host (#1059), each block also carries the host prompt it answers as `remote`, with its part, the question’s
// index in the call. The host’s permissionWaitMax ends the wait there, not CARD_WAIT_MS, and after a restart the
// daemon’s resend of the prompt carries on from the blocks already shown (server/remote/turns-prompts.mjs).
//
// Each block waits as a permission card does, in rt.permissionWaits under its item’s id, marked `question`. The
// person’s answer (blocks.mjs, act) settles the wait and isn’t sent as an event, since the tool’s result carries it. A
// wait that ends first (the turn ends or stops, CARD_WAIT_MS, the CLI’s prompt closing, found by the block’s
// toolUseId) leaves the block asking: its answer then reaches the agent as an event, as any block’s does, and the call
// is refused with STILL_OPEN, so the agent doesn’t ask it again. A restart drops the wait the same way, since the call
// died with the process. The block holds its call’s toolUseId, so the CLI’s refusal of a dismissed or ended question
// (permission_denials) raises no refusal card either.

import { validateBlock } from '../shared/catalog.mjs';
import { HOST_LIMIT, nobodyAnsweredWithin, STILL_OPEN } from '../shared/question-words.mjs';
import { offerNeed } from './card-needs.mjs';
import { newId } from './ids.mjs';
import { CARD_WAIT_MS } from './permission-cards.mjs';
import { gated } from './store-outage.mjs';

export const DISMISSED = 'The person dismissed the question.';
const WAITED = nobodyAnsweredWithin(`${Math.round(CARD_WAIT_MS / 3600000)} hours`);
const DELIVERED = 'The person answered this question while Postbox restarted, and their answer already reached you as a message.';

/**
 * The choice blocks for an AskUserQuestion input, one per question, or null if any can’t be shown as one: the call
 * then keeps its permission card. @param {any} input @returns {any[] | null}
 */
export function questionBlocks(input) {
  const questions = input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;
  const blocks = [];
  for (const q of questions) {
    const block = choiceOf(q);
    const v = block ? validateBlock(block) : null;
    if (!v?.ok) return null;
    blocks.push(v.block);
  }
  return blocks;
}

/** One question as a choice block, or null when its shape isn’t AskUserQuestion’s. @param {any} q */
function choiceOf(q) {
  if (!q || typeof q.question !== 'string' || !Array.isArray(q.options)) return null;
  const options = q.options.map((o, i) => ({
    id: `o${i + 1}`,
    label: o?.label,
    ...(typeof o?.description === 'string' && o.description.trim() ? { description: o.description } : {}),
  }));
  const labels = options.map((o) => `- ${o.label}`).join('\n');
  return {
    id: newId('ask'),
    type: 'choice',
    version: 1,
    ...(typeof q.header === 'string' && q.header.trim() ? { title: q.header } : {}),
    prompt: q.question,
    options,
    multiple: q.multiSelect === true,
    other: { label: 'Other' },
    fallback: `${q.question}\n${labels}`.slice(0, 4000),
  };
}

/**
 * Asks each question in turn and answers the call. shown: on a host, after a restart, the blocks already shown for the
 * call by part (#1059): an answered one counts as asked, and an open one is waited on again rather than shown twice.
 * @param {any} rt @param {string} sessionId
 * @param {{ input: any, toolUseId?: string | null, hostPrompt?: HostPrompt | null }} req
 * @param {any[]} blocks  questionBlocks(req.input) @param {{ threadId: string, it: any }[]} [shown]
 * @returns {Promise<{ allow: boolean, message?: string, updatedInput?: Record<string, any> }>}
 */
export async function askQuestions(rt, sessionId, req, blocks, shown = []) {
  /** @type {Record<string, string>} */
  const answers = {};
  /** @type {{ threadId: string, id: string }[]} the blocks whose answers this call took */
  const taken = [];
  for (const [i, fresh] of blocks.entries()) {
    const prior = shown.find((c) => c.it.remote?.part === i);
    const block = prior?.it.block ?? fresh;
    const got = prior ? await again(rt, sessionId, prior) : await askOne(rt, sessionId, block, req.toolUseId ?? null, req.hostPrompt, i);
    const at = prior ? { threadId: prior.threadId, id: prior.it.id } : got.shown;
    const unasked = blocks.slice(i + 1);
    // Dismissed, or already delivered as a message (#1059): the question is over, so nothing says it stays open.
    const over = endedBy(got);
    if (over) return { allow: false, message: [over, answeredText(answers), unaskedText(unasked)].filter(Boolean).join(' ') };
    if (!got.values) {
      // On a host the call hears the shim’s own words, not these, so “it stays open” is made true here (#1059). Only
      // when the host’s limit ended it: a harness that canceled the call has stopped asking, and a turn that ended or
      // was stopped asks nothing more.
      if (req.hostPrompt && at && got.status === HOST_LIMIT)
        handOver(rt, sessionId, { ...req, hostPrompt: req.hostPrompt }, taken, at.threadId, unasked, i + 1);
      return { allow: false, message: stillOpen(got.message, answers, unasked) };
    }
    if (at) taken.push(at);
    answers[block.prompt] = answerText(block, got.values);
  }
  return { allow: true, updatedInput: { ...req.input, answers } };
}

/** @typedef {{ hostId: string, turn: string, id: string, entry?: string | null }} HostPrompt */

/**
 * A block answered while nothing waited on it, after a restart: its answer went to the agent’s inbox as a message.
 * The call takes it once (#1059): the message is withdrawn while it still waits, and the call hears it was already
 * delivered once the agent has had it. @param {any} rt @param {string} sessionId @param {any} it
 */
function answeredMeanwhile(rt, sessionId, it) {
  const sent = rt.delivery.entriesFrom(it.id).filter((/** @type {any} */ e) => e.source === 'answer' && e.state !== 'stopped');
  if (sent.some((/** @type {any} */ e) => e.state !== 'waiting')) return { delivered: true };
  for (const e of sent) rt.delivery.cancel(sessionId, e.id);
  return it.answer?.action === 'dismiss' ? { dismissed: true } : { values: it.answer?.values ?? {} };
}

/**
 * A block shown before a restart: its answer if it has one, else its answer once it comes, waited on again as askOne
 * waits. @param {any} rt @param {string} sessionId @param {{ threadId: string, it: any }} shown
 */
function again(rt, sessionId, { threadId, it }) {
  if (it.answered) return Promise.resolve(answeredMeanwhile(rt, sessionId, it));
  const se = rt.s.sessions[sessionId];
  if (se) offerNeed(rt, se, { kind: 'block', itemId: it.id, text: it.block.title ?? it.block.prompt, ...rt.sessions.awayFrom(se, threadId) }, 'needs');
  return new Promise((resolve) => rt.permissionWaits.set(it.id, { resolve, threadId, sessionId, timer: null, question: true }));
}

/** Why a question is over without an answer for its call, or null. @param {{ dismissed?: boolean, delivered?: boolean }} got */
function endedBy(got) {
  if (got.dismissed) return DISMISSED;
  if (got.delivered) return DELIVERED;
  return null;
}

/** The chosen labels in the options’ order, then the Other text, joined with “, ” as Claude Code joins several. */
export function answerText(block, { selected = [], other }) {
  const chosen = block.options.filter((o) => selected.includes(o.id)).map((o) => o.label);
  return [...chosen, ...(other ? [other] : [])].join(', ');
}

/** Why the call ends unanswered, what was answered before it, and that the question stays open. */
function stillOpen(why, answers, unasked) {
  return [why ?? 'The turn ended before the person answered.', answeredText(answers), STILL_OPEN, unaskedText(unasked)].filter(Boolean).join(' ');
}

/** What the person answered before the call ended, or ''. @param {Record<string, string>} answers */
function answeredText(answers) {
  const before = Object.entries(answers).map(([q, a]) => `“${q}”: ${a}`);
  return before.length ? `They had answered ${before.join('; ')}.` : '';
}

/** The call’s questions the person never saw, or ''. @param {any[]} unasked  their blocks */
function unaskedText(unasked) {
  return unasked.length ? `Not shown to them: ${unasked.map((b) => `“${b.prompt}”`).join(', ')}.` : '';
}

/**
 * What a late answer to a question block says to the agent (#521): the question and the labels, since Postbox made
 * the block’s and the options’ ids and the agent never saw them. @param {any} block @param {any} values
 * @param {boolean} dismissed
 */
export function lateAnswer(block, values, dismissed) {
  return { text: block.prompt, answer: dismissed ? null : answerText(block, values) };
}

/**
 * Shows one question block and waits for its answer: { values } chosen, { dismissed }, or { message } when the wait
 * ended first. @param {any} rt @param {string} sessionId @param {any} block @param {string | null} toolUseId  its call’s
 * @param {HostPrompt | null} [hostPrompt]  on a host, the prompt it answers @param {number} [part]  its question’s index
 */
function askOne(rt, sessionId, block, toolUseId, hostPrompt = null, part = 0) {
  const se = rt.s.sessions[sessionId];
  const turn = rt.turns.get(sessionId);
  if (!se || !turn) return Promise.resolve({ message: 'The turn has ended.' });
  const it = rt.threads.addItem(turn.threadId, {
    kind: 'block',
    sessionId,
    handle: se.handle,
    turnId: turn.id,
    valid: true,
    block,
    answered: false,
    question: true,
    toolUseId: toolUseId ? String(toolUseId) : null,
    ...(hostPrompt ? { remote: { hostId: hostPrompt.hostId, turn: hostPrompt.turn, prompt: hostPrompt.id, entry: hostPrompt.entry ?? null, part } } : {}),
  });
  // The text so far is finished; Turns closes it, and the reply continues below the question.
  rt.bus.emit('card.opened', { turn });
  offerNeed(rt, se, { kind: 'block', itemId: it.id, text: block.title ?? block.prompt, ...rt.sessions.awayFrom(se, turn.threadId) }, 'needs');
  rt.threads.notify('blocking', se, `@${se.handle} asks you`, block.prompt, turn.threadId);
  const shown = { threadId: turn.threadId, id: it.id };
  return new Promise((resolve) => {
    // As a card’s (permission-cards.mjs, expireWait), but without its “ask again”: the question stays open. On a host,
    // the host’s permissionWaitMax ends it instead, as it does a host prompt’s card.
    const timer = hostPrompt ? null : setTimeout(() => gated(rt, () => rt.settlePermission(it.id, 'expired', WAITED)), CARD_WAIT_MS);
    timer?.unref?.();
    const done = (/** @type {any} */ got) => resolve({ ...got, shown });
    rt.permissionWaits.set(it.id, { resolve: done, threadId: turn.threadId, sessionId, timer, question: true });
  });
}

/**
 * A host question’s call that ended unanswered (#1059): its shim tells the agent the question stays open, and its
 * answer comes as a message. So what the call took goes to the agent as late answers do, and each question it never
 * showed is shown now, with nothing waiting on it: its answer comes as a message too.
 * @param {any} rt @param {string} sessionId @param {{ toolUseId?: string | null, hostPrompt: HostPrompt }} req
 * @param {{ threadId: string, id: string }[]} taken @param {string} threadId @param {any[]} unasked @param {number} from
 */
function handOver(rt, sessionId, req, taken, threadId, unasked, from) {
  for (const { threadId: at, id } of taken) {
    const it = rt.store.pending.items(at).find((/** @type {any} */ x) => x.id === id);
    if (!it?.answered) continue;
    const values = it.answer?.values ?? {};
    const event = { blockId: it.block.id, revision: it.answer.revision, action: it.answer.action, values, question: lateAnswer(it.block, values, false) };
    rt.delivery.send({ sessionId, threadId: at, source: 'answer', itemId: id, from: 'you', message: { kind: 'event', event, blockItemId: id } });
  }
  const se = rt.s.sessions[sessionId];
  if (!se) return;
  const hp = req.hostPrompt;
  for (const [k, block] of unasked.entries()) {
    const remote = { hostId: hp.hostId, turn: hp.turn, prompt: hp.id, entry: hp.entry ?? null, part: from + k, ended: Date.now() };
    const it = rt.threads.addItem(threadId, {
      kind: 'block',
      sessionId,
      handle: se.handle,
      turnId: rt.turns.get(sessionId)?.id ?? null,
      valid: true,
      block,
      answered: false,
      question: true,
      toolUseId: req.toolUseId ? String(req.toolUseId) : null,
      remote,
    });
    offerNeed(rt, se, { kind: 'block', itemId: it.id, text: block.title ?? block.prompt, ...rt.sessions.awayFrom(se, threadId) }, 'needs');
  }
}

/** Whether a block’s item is an AskUserQuestion whose call still waits for it. @param {any} rt @param {string} itemId */
export const waitingQuestion = (rt, itemId) => rt.permissionWaits.get(itemId)?.question === true;

/**
 * The person answered a waiting question’s block: its call gets the values, or null when they dismissed it.
 * @param {any} rt @param {string} itemId @param {any} values
 */
export function answerQuestion(rt, itemId, values) {
  const w = rt.permissionWaits.get(itemId);
  clearTimeout(w.timer);
  rt.permissionWaits.delete(itemId);
  w.resolve(values ? { values } : { dismissed: true });
}
