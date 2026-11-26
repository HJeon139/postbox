// The actions under a message: its thread, sending it to the conversation, and React. Moved from app/js/thread.mjs.

import { api, client, hrefOf } from './client.mjs';
import { $, ago, h, plural } from './dom.mjs';
import { itemLink } from './item-address.mjs';
import { focusUntouched } from './pane-focus.mjs';
import { reactTo } from './reactions.mjs';
import { navigate, say, toast } from './ui.mjs';

const S = () => client.state;

/** “3 replies” when the message has a topic thread, or “Reply in thread” to start one. @param {any} it @param {any} ctx */
function threadAction(it, ctx) {
  const topic = it.topicId && S().threads[it.topicId];
  if (topic) {
    const unread = topic.unread ?? 0;
    return h(
      'a.replies.i-thread',
      { href: hrefOf(topic.id), dataset: { glyph: '' } },
      it.replies ? plural(it.replies, 'reply', 'replies') : 'Thread',
      it.lastReplyAt ? h('span.dim', ` · last reply ${ago(it.lastReplyAt)}`) : null,
      unread ? h('span.badge', { 'aria-label': `${unread} new` }, String(unread)) : null,
    );
  }
  return h(
    'button.btn.sm.ghost.reveal.i-thread',
    {
      type: 'button',
      // Each action’s icon is drawn by the action (workbench.css, .msg-actions [data-glyph]): one element, not two (#168).
      dataset: { glyph: '' },
      onclick: () =>
        api(`/api/threads/${ctx.threadId}/items/${it.id}/topic`, {})
          .then((r) => {
            navigate(`#/t/${ctx.threadId}/side/${r.threadId}`);
            // Focus goes to the thread’s composer only if the person hasn’t moved it meanwhile (#887).
            setTimeout(() => {
              if (focusUntouched(it.id)) $('#side-input')?.focus();
            }, 150);
          })
          .catch((e) => toast({ title: 'Couldn’t start a thread', text: e.message, level: 'blocking' })),
    },
    'Reply in thread',
  );
}

/** “Send to conversation” under a message in a topic or side thread (#128), or that it was sent. @param {any} it @param {any} ctx */
function sendAction(it, ctx) {
  if (it.sharedAt) return h('span.small.dim.i-check', { dataset: { glyph: '' } }, ' Sent to the conversation');
  return h(
    'button.btn.sm.ghost.reveal.i-right',
    {
      type: 'button',
      dataset: { glyph: '' },
      // Once: the button waits for its answer, and the reply then shows it was sent (#93).
      onclick: (e) => {
        const b = e.currentTarget;
        b.disabled = true;
        api(`/api/threads/${ctx.threadId}/items/${it.id}/share`, {})
          .then(() => toast({ title: 'Sent to the conversation', text: 'Its agents read it at the start of their next turn.' }))
          .catch((err) => {
            b.disabled = false;
            toast({ title: 'Couldn’t send it', text: err.message, level: 'blocking' });
          });
      },
    },
    'Send to conversation',
  );
}

/**
 * Copy link (#168): the message’s address, to keep, or to paste in a message for an agent. Opened, a reload, Back or a
 * new tab included, it lands on the message. @param {any} it @param {any} ctx
 */
function copyAction(it, ctx) {
  let reset = 0;
  // An icon, drawn by the button itself, so it fits the row at 375 px and costs one element (#1155). Its name says what
  // it does, and what it did once pressed.
  const b = h('button.btn.sm.ghost.reveal.i-copy', {
    type: 'button',
    title: 'Copy link',
    'aria-label': 'Copy link',
    dataset: { copyLink: '', glyph: '' },
    onclick: async () => {
      clearTimeout(reset);
      const link = itemLink(ctx.threadId, it.id);
      try {
        await navigator.clipboard.writeText(link);
        say('Link to the message copied.');
        b.setAttribute('aria-label', 'Link copied');
        b.setAttribute('title', 'Link copied');
        b.classList.replace('i-copy', 'i-check');
      } catch {
        toast({ title: 'Couldn’t copy the link', text: link });
      }
      reset = window.setTimeout(() => {
        b.setAttribute('aria-label', 'Copy link');
        b.setAttribute('title', 'Copy link');
        b.classList.replace('i-check', 'i-copy');
      }, 2000);
    },
  });
  return b;
}

// Under a message in a conversation: “Reply in thread”, or once a thread exists, “3 replies”. Under a message in a
// topic or side thread (#128): “Send to conversation”. Copy link (#168) and React, under every one (#251), on the left (#378). They appear on hover and focus, and always on touch.
export function messageActions(node, it, ctx) {
  if (!['user', 'agent', 'block', 'shared'].includes(it.kind) || it.status === 'streaming' || it.deletedAgent || (it.kind === 'block' && !it.valid)) return;
  if (it.status === 'replaced') return;
  const bar = h('div.msg-actions');
  if (ctx.kind === 'thread' || ctx.kind === 'room') bar.append(threadAction(it, ctx));
  else if ((ctx.kind === 'topic' || ctx.kind === 'side') && (it.kind === 'agent' || it.kind === 'user') && it.text) bar.append(sendAction(it, ctx));
  // Last in the row, after the message’s other actions: the reactions keep the column’s left edge (#378).
  bar.append(copyAction(it, ctx));
  node.append(reactTo(bar, node, it, ctx));
}
