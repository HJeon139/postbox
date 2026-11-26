// The actions under a message: its thread, sending it to the conversation, and React. Moved from app/js/thread.mjs.

import { api, client, hrefOf } from './client.mjs';
import { $, ago, h, icon, plural } from './dom.mjs';
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
      'a.replies',
      { href: hrefOf(topic.id) },
      icon('thread', 'i-sm'),
      it.replies ? plural(it.replies, 'reply', 'replies') : 'Thread',
      it.lastReplyAt ? h('span.dim', ` · last reply ${ago(it.lastReplyAt)}`) : null,
      unread ? h('span.badge', { 'aria-label': `${unread} new` }, String(unread)) : null,
    );
  }
  return h(
    'button.btn.sm.ghost.reveal',
    {
      type: 'button',
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
    icon('thread', 'i-sm'),
    'Reply in thread',
  );
}

/** “Send to conversation” under a message in a topic or side thread (#128), or that it was sent. @param {any} it @param {any} ctx */
function sendAction(it, ctx) {
  if (it.sharedAt) return h('span.small.dim', icon('check', 'i-sm'), ' Sent to the conversation');
  return h(
    'button.btn.sm.ghost.reveal',
    {
      type: 'button',
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
    icon('right', 'i-sm'),
    'Send to conversation',
  );
}

/**
 * Copy link (#168): the message’s address, to keep, or to paste in a message for an agent. Opened, a reload, Back or a
 * new tab included, it lands on the message. @param {any} it @param {any} ctx
 */
function copyAction(it, ctx) {
  let reset = 0;
  const b = h(
    'button.btn.sm.ghost.reveal',
    {
      type: 'button',
      dataset: { copyLink: '' },
      onclick: async () => {
        clearTimeout(reset);
        const link = itemLink(ctx.threadId, it.id);
        try {
          await navigator.clipboard.writeText(link);
          say('Link to the message copied.');
          b.textContent = 'Copied';
        } catch {
          toast({ title: 'Couldn’t copy the link', text: link });
        }
        reset = window.setTimeout(() => {
          b.textContent = 'Copy link';
        }, 2000);
      },
    },
    'Copy link',
  );
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
  // Made when the pointer or focus first comes to the message: one more element under every message cost a room of
  // tables its element budget (#1155). First in the row, so the message’s last control stays its last, where Shift+Tab
  // from the composer lands (#232), and Shift+Tab from the row’s first control reaches it.
  const copy = () => {
    if (!bar.querySelector('[data-copy-link]')) bar.prepend(copyAction(it, ctx));
  };
  node.addEventListener('pointerenter', copy, { once: true });
  node.addEventListener('focusin', copy, { once: true });
  node.append(reactTo(bar, node, it, ctx));
}
