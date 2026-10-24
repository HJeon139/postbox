// The panel beside a conversation for a topic or side thread: its head (Summarize back, Copy link, Close), who is in
// it, the message a topic started from, and the thread’s own transcript and composer.

import { renderMarkdown } from '/shared/markdown.mjs';
import { handles } from './agent-markdown.mjs';
import { inThreadLine } from './agents.mjs';
import { enhanceMarkdown } from './apps.mjs';
import { api, client, itemsOf, S, threadLink } from './client.mjs';
import { h, icon, trusted } from './dom.mjs';
import { mountComposer, mountTranscript } from './thread.mjs';
import { navigate, openMenu, say, toast } from './ui.mjs';

/**
 * The panel beside a conversation. It holds a topic thread (yours, from a message) or a side thread between agents
 * (which you can join by typing), each with Summarize back.
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
  const summarize = summarizeButton(sideId, parent);
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
      summarize.el,
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
      summarize.destroy();
      who?.destroy();
      tr.destroy();
      comp.destroy();
    },
  };
}

/**
 * Summarize back (#93, #225): asks an agent of the thread for a short summary, posted in the conversation. In a side
 * thread a menu picks which of its two agents writes it, the one that started it first. One summary at a time: from the
 * request until it’s posted, fails or is stopped, the button waits, also while it waits for its agent. The server keeps
 * the request on the thread until then (summaryPending), so a reload or a second tab waits too, and it refuses a second
 * one. Between the click and the server’s state reaching the page, the click itself.
 */
function summarizeButton(sideId, parent) {
  let asking = false;
  const pending = () => {
    const ask = !!S().threads[sideId]?.summaryPending;
    if (ask) asking = false;
    return asking || ask;
  };
  const ask = (handle) => {
    asking = true;
    paint();
    api(`/api/threads/${sideId}/summarize`, handle ? { handle } : {})
      .then(() => toast({ title: 'Summary requested', text: `It will appear in ${parent?.title ?? 'the conversation'} when it’s written.` }))
      .catch((e) => {
        asking = false;
        toast({ title: 'Couldn’t ask for a summary', text: e.message, level: 'blocking' });
      })
      .finally(paint);
  };
  const t = S().threads[sideId];
  const two = t?.kind === 'side' ? String(t.pair ?? '').split('|') : null;
  const pair = two && [...two.filter((x) => x !== t.woke), ...two.filter((x) => x === t.woke)];
  const choose = () =>
    openMenu(
      el,
      // A side thread from before Postbox kept whom it woke can’t say who started it.
      pair.map((x, i) => ({ label: `@${x} writes it`, desc: i || !t.woke ? '' : 'started this thread', run: () => ask(x) })),
      { label: 'Who writes the summary' },
    );
  const el = h(
    'button.btn.sm',
    {
      type: 'button',
      title: `Ask ${pair ? 'one of its agents' : 'the thread’s agent'} for a short summary, and post it in the conversation`,
      ...(pair ? { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } : {}),
      onclick: () => (pair ? choose() : ask(null)),
    },
    'Summarize back',
  );
  const paint = () => {
    const waiting = pending();
    // Disabled, it can’t keep focus: the thread’s composer takes it.
    if (waiting && document.activeElement === el) document.getElementById('side-input')?.focus();
    el.disabled = waiting || !(S().threads[sideId]?.lastSpeaker || S().threads[sideId]?.woke);
    const label = waiting ? 'Summary requested…' : 'Summarize back';
    if (el.textContent !== label) el.textContent = label;
  };
  paint();
  return { el, destroy: client.on((ch) => ((ch.type === 'thread' && ch.data.id === sideId) || ch.type === 'load') && paint()) };
}

/**
 * Copy link (#121): the thread’s address, to paste in a message. An agent that gets it can read the thread with
 * read_conversation, and the composer’s # inserts the same link.
 */
function copyLink(threadId, topic) {
  const b = h(
    'button.btn.sm',
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
