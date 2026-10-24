// The panel beside a conversation for a topic or side thread: its head (Summarize back, Copy link, Close), who is in
// it, the message a topic started from, and the thread’s own transcript and composer.

import { renderMarkdown } from '/shared/markdown.mjs';
import { handles } from './agent-markdown.mjs';
import { inThreadLine } from './agents.mjs';
import { enhanceMarkdown } from './apps.mjs';
import { api, client, itemsOf, S, threadLink } from './client.mjs';
import { h, icon, trusted } from './dom.mjs';
import { mountComposer, mountTranscript } from './thread.mjs';
import { navigate, say, toast } from './ui.mjs';

/**
 * The panel beside a conversation. It holds a topic thread (yours, forked from a message, with Summarize back)
 * or a side thread between agents (which you can join by typing).
 */
export function mountSidePanel(parentId, sideId) {
  const side = S().threads[sideId];
  if (!side) return null;
  const topic = side.kind === 'topic';
  const parent = S().threads[parentId];
  const tr = mountTranscript(sideId, { inPanel: true });
  const comp = mountComposer(sideId, { side: true });
  const root = topic ? itemsOf(parentId).find((x) => x.id === side.rootItemId) : null;
  const body = h('div.sp-body', topic ? threadRoot(root) : null, tr.el);
  // Who is in a topic thread, in a line: the conversation’s agents, from their one session there (#228).
  const who = topic ? inThreadLine(sideId) : null;
  // One summary at a time (#93): from the request until it’s posted or the turn ends, the button waits. The
  // server keeps the request on the thread, so a reload or a second tab waits too, and it refuses a second one.
  // From the click until the server’s own state shows the request: its agent at work on it.
  let asking = false;
  const pendingSummary = () => {
    const ask = S().threads[sideId]?.summaryPending;
    const se = ask && S().sessions[ask.sessionId];
    const working = !!(se && !se.archived && ['think', 'gen', 'tool', 'needs'].includes(se.state));
    if (working) asking = false;
    return asking || working;
  };
  const summarize = topic
    ? h(
        'button.btn.sm',
        {
          type: 'button',
          title: 'Ask the thread’s agent for a short summary, and post it in the conversation',
          onclick: () => {
            asking = true;
            paintSummarize();
            api(`/api/threads/${sideId}/summarize`, {})
              .then(() => toast({ title: 'Summary requested', text: `It will appear in ${parent?.title ?? 'the conversation'} when it’s written.` }))
              .catch((e) => {
                asking = false;
                toast({ title: 'Couldn’t ask for a summary', text: e.message, level: 'blocking' });
              })
              .finally(paintSummarize);
          },
        },
        'Summarize back',
      )
    : null;
  const paintSummarize = () => {
    if (!summarize) return;
    const waiting = pendingSummary();
    summarize.disabled = waiting || !(S().threads[sideId]?.lastSpeaker || S().threads[sideId]?.woke);
    const label = waiting ? 'Summary requested…' : 'Summarize back';
    if (summarize.textContent !== label) summarize.textContent = label;
  };
  paintSummarize();
  const off = client.on((ch) => {
    if (
      (ch.type === 'thread' && ch.data.id === sideId) ||
      (ch.type === 'session' && ch.data.id === S().threads[sideId]?.summaryPending?.sessionId) ||
      ch.type === 'load'
    )
      paintSummarize();
  });
  const el = h(
    'aside.sidepanel',
    { 'aria-labelledby': 'sp-title' },
    h(
      'div.sp-head',
      icon('thread', 'dim'),
      h(
        'div.grow',
        h('b', { id: 'sp-title' }, topic ? 'Thread' : side.title),
        h('div.small.dim', topic ? `in ${parent?.title ?? 'the conversation'}` : `Side thread from ${parent?.title ?? 'this conversation'}`),
      ),
      summarize,
      copyLink(sideId, topic),
      h(
        'button.btn.icon.sm.ghost',
        { type: 'button', 'aria-label': topic ? 'Close thread' : 'Close side thread', onclick: () => navigate(`#/t/${parentId}`) },
        icon('x'),
      ),
    ),
    who ? h('div.sp-agents', who.el) : null,
    body,
    h('div.sp-foot', comp.el),
  );
  // A file dropped anywhere on the panel attaches to the panel’s composer, not the conversation’s.
  comp.dropZone(el);
  requestAnimationFrame(() => tr.settle());
  return {
    el,
    destroy() {
      off();
      who?.destroy();
      tr.destroy();
      comp.destroy();
    },
  };
}

/**
 * Copy link (#121): the thread’s address, to paste in a message. An agent that gets it can read the thread with
 * read_conversation, and the composer’s # inserts the same link.
 */
function copyLink(threadId, topic) {
  const b = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(threadLink(threadId));
          say('Link copied. Paste it in a message, and the agent can read this thread.');
          b.textContent = 'Copied';
        } catch {
          toast({ title: 'Couldn’t copy the link', text: threadLink(threadId) });
        }
        setTimeout(() => {
          b.textContent = 'Copy link';
        }, 2000);
      },
      'aria-label': topic ? 'Copy link to this topic thread' : 'Copy link to this side thread',
    },
    'Copy link',
  );
  return b;
}

/** The message a topic thread branched from, at its top. */
function threadRoot(root) {
  if (!root) return null;
  const text = root.kind === 'block' ? `${root.block?.title ?? root.block?.type ?? 'A block'}${root.block?.type === 'app' ? ' (app)' : ''}` : (root.text ?? '');
  // A long message is clamped to a few lines here; it’s all in the conversation beside it.
  const md = h('div.md.clamped', { html: trusted(renderMarkdown(text, { mentions: handles() })) });
  queueMicrotask(() => enhanceMarkdown(md));
  const more = h(
    'button.btn.sm.ghost',
    {
      type: 'button',
      'aria-expanded': 'false',
      onclick: (e) => {
        const open = md.classList.toggle('clamped') === false;
        e.currentTarget.setAttribute('aria-expanded', String(open));
        e.currentTarget.textContent = open ? 'Show less' : 'Show all';
      },
    },
    'Show all',
  );
  return h(
    'div.thread-root',
    h('span.label', root.kind === 'user' ? 'You' : `@${root.handle ?? ''}`),
    md,
    text.length > 280 || /\n\s*\n/.test(text) ? more : null,
  );
}
