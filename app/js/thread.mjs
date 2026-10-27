// The conversation view: transcript, composer, and the panel beside it for topic threads (yours, forked from a
// message) and side threads (between agents).

import { INLINE_TYPES } from '/shared/files.mjs';
import { renderMarkdown } from '/shared/markdown.mjs';
import { resolveCommand } from '/shared/slash-line.mjs';
import { activityLabel, stepTree } from './activity-steps.mjs';
import { mockMarker } from './agent-facts.mjs';
import { agentMarkdown, handles, markTerms } from './agent-markdown.mjs';
import { subagentNow } from './agents.mjs';
import { enhanceMarkdown, renderAppItem, renderAppSendCard } from './apps.mjs';
import { renderBlock } from './blocks.mjs';
import { api, busy, client, hrefOf, itemsOf, sessionsAt, sessionsOf, sideSessionsOf, stopSession, threadLink, uploadFile } from './client.mjs';
import { fitTextarea } from './composer-fit.mjs';
import { describeStop, notOnHost, stopNoteEl } from './composer-host.mjs';
import { asWake, queuedRow } from './composer-queue.mjs';
import { addressLine, addressSig, commandHint } from './composer-to.mjs';
import { $, ago, dayOf, fill, h, icon, plural, syncList, timeOf, trusted } from './dom.mjs';
import { focusComposer, hopBlock } from './hop-card.mjs';
import { denialBlock, permissionBlock, toolAskBlock } from './permission-cards.mjs';
import { openPermissions, openRunChoice } from './permissions.mjs';
import { reactTo } from './reactions.mjs';
import { hostOf } from './remote.mjs';
import { jobRows, runningNote, stoppedTag } from './reply-stop.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { boilerplateDesc, openAttachSession, openFolderPicker, openNewAgent, openRename } from './sheets.mjs';
import { sideActive, sideLine, sideSig } from './side-line.mjs';
import { failedOnHost, hostChanged, hostEnd, hostTurnsList, kiroStep, ranHere, remoteSig } from './thread-host.mjs';
import { threadMenu } from './thread-menu.mjs';
import { announceStreaming, navigate, openMenu, say, toast } from './ui.mjs';
import { workList } from './work-list.mjs';

export { focusComposer } from './hop-card.mjs';

const S = () => client.state;
// A reply replaced by its replay (#120: a turn on a host attached again after a restart) shows nothing, so the replay
// after it names its speaker.
const speaker = (it) =>
  it.kind === 'user' ? 'you' : (it.kind === 'agent' && it.status !== 'replaced') || it.kind === 'block' || it.kind === 'proposal' ? `s:${it.sessionId}` : null;
// One turn’s items share a sender line; a later turn of the same agent gets its own, and so does a wake it sent from
// another turn (its fromTurnId) (#135). An item from before turns were kept, or no turn made, goes with the one before.
const turnOf = (it) => it.turnId ?? it.fromTurnId;
const sameTurn = (a, b) => !turnOf(a) || !turnOf(b) || turnOf(a) === turnOf(b);
// What woke the turn (#135): “woken by @critic”, “after @researcher replied in a side thread”, or its scheduled wake.
const wokeText = ({ by, reply, in: at, scheduled }) =>
  scheduled
    ? 'woken by a scheduled wake'
    : reply
      ? `after @${by} replied${{ side: ' in a side thread', topic: ' in a thread' }[S().threads[at]?.kind] ?? ''}`
      : `woken by @${by}`;

// ── Transcript ──────────────────────────────────────────────────────────────────────────

// Where a transcript was scrolled, kept while the view is rebuilt around it (opening or closing the panel), so a
// rebuild doesn’t move you. Cleared once that rebuild has run.
const kept = new Map();

/** A live transcript for one thread. Returns { el, settle, scrollToEnd, setJump, destroy }. */
export function mountTranscript(threadId, { inPanel = false } = {}) {
  const el = h('div.transcript', { id: inPanel ? null : 'main', tabindex: '-1', 'aria-label': 'Conversation', dataset: { thread: threadId } });
  const nodes = new Map();
  const pending = new Set();
  let raf = 0;
  const was = kept.get(`${inPanel}:${threadId}`);
  let unseen = was?.unseen ?? 0;
  // Stuck: the view is on the newest message, and stays there through anything that changes the transcript’s
  // size (streaming, patches, apps growing, the panel, the window) until you scroll up yourself (#88). Otherwise
  // it stays on what you were reading: the anchor, a message and how far down the view it starts.
  let stuck = !was;
  let anchor = was?.anchor ?? null;
  let dead = false;
  // At the end of the transcript, one row per agent that’s thinking or calling tools: what it’s on right now,
  // and a glimpse of its thinking. It goes while the agent writes, since the reply itself shows then. It sits in
  // the message column, like the messages (#83).
  const working = h('div.working.col', { 'aria-hidden': 'true' });
  const paintWorking = () => {
    // The agents whose turn is here: a conversation’s, unless its turn is in a side thread, and in a side thread, any
    // session answering in it (#110).
    const busy = sessionsAt(threadId).filter(
      (se) => !se.archived && (se.state === 'think' || se.state === 'tool') && (!se.sideTurn || se.sideTurn.threadId === threadId),
    );
    syncList(
      working,
      busy,
      (se) => se.id,
      (se) => {
        const row = h('div.work-row', ringFor(se, 'xs'), h('div.work-text'));
        fillWorkRow(row, se);
        return row;
      },
      (row, se) => fillWorkRow(row, se),
    );
    el.append(hostTurns.el, working); // keep them last
  };
  // Above them, a turn on a host Postbox asked to stop and the host hasn’t confirmed it stopped (#120).
  const hostTurns = hostTurnsList(threadId);

  const appSig = (app) => JSON.stringify([app.current, app.versions?.length, app.check?.status, app.check?.problems?.length ?? 0, app.retired?.at ?? null]);
  const render = (it, prev) => {
    const ctx = { threadId, kind: S().threads[threadId]?.kind, rerender: () => rerender(it.id) };
    const node = renderItem(it, prev, ctx);
    messageActions(node, it, ctx);
    node.dataset.key = it.id;
    if (it.kind === 'block' && it.valid && it.block.type === 'app' && S().apps[it.block.id]) node.dataset.appSig = appSig(S().apps[it.block.id]);
    if (it.kind === 'agent') node.dataset.remoteSig = remoteSig(it);
    node.classList.add('item');
    if (!node.hasAttribute('tabindex')) node.tabIndex = -1;
    return node;
  };
  const rerender = (id) => {
    const list = itemsOf(threadId);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) return;
    const old = nodes.get(id);
    // Keep focus inside a block that’s being edited.
    const hadFocus = old?.contains(document.activeElement) ? document.activeElement : null;
    const n = render(list[i], list[i - 1]);
    old?.replaceWith(n);
    nodes.set(id, n);
    if (hadFocus?.id) document.getElementById(hadFocus.id)?.focus();
  };
  const all = () => {
    el.replaceChildren();
    nodes.clear();
    const list = itemsOf(threadId);
    if (!list.length && !inPanel) {
      el.append(welcome(threadId));
      return;
    }
    list.forEach((it, i) => {
      const n = render(it, list[i - 1]);
      nodes.set(it.id, n);
      el.append(n);
    });
    hostTurns.paint();
    paintWorking();
  };
  all();

  const box = () => (inPanel ? el.parentElement : document.scrollingElement);
  const viewTop = (s) => (inPanel ? s.getBoundingClientRect().top : 0);
  const gapOf = (s) => s.scrollHeight - s.scrollTop - s.clientHeight;
  // At the bottom, give or take a pixel of rounding.
  const atEnd = (s) => gapOf(s) <= 2;
  // The pill floats just above the composer. It shows only while the end is further below than that, so what it
  // floats over is never the working rows or the end of the last message (#91).
  const PILL_ROOM = 48;
  let shown = -1;
  const showJump = (s) => {
    const n = s && gapOf(s) > PILL_ROOM ? unseen : 0;
    if (n !== shown) jump?.((shown = n));
  };
  // The anchor is the message across the middle of the view, where you read, not the first one in view: that one
  // usually starts above the view, and when a narrower column (the panel, a smaller window) rewraps it, everything
  // under it moves. A wide font rewraps it where macOS’s doesn’t (#88, seen on Linux in #162).
  const findAnchor = () => {
    const s = box();
    if (!s) return null;
    const top = viewTop(s);
    const mid = top + s.clientHeight / 2;
    let last = null;
    for (const n of el.children) {
      if (!(n instanceof HTMLElement && n.dataset.key)) continue;
      const r = n.getBoundingClientRect();
      if (r.bottom <= top) continue;
      last = { key: n.dataset.key, at: r.top - top };
      if (r.bottom > mid) return last;
    }
    return last;
  };
  const holdAnchor = () => {
    const s = box();
    const n = anchor && nodes.get(anchor.key);
    if (!s || !n?.isConnected) return;
    const d = n.getBoundingClientRect().top - viewTop(s) - anchor.at;
    if (Math.abs(d) < 1) return;
    s.scrollTop += d;
    lastTop = s.scrollTop;
  };
  const seen = () => {
    unseen = 0;
    showJump(null);
  };
  const scrollToEnd = (smooth = false) => {
    stuck = true;
    const s = box();
    if (s && smooth && !inPanel && !matchMedia('(prefers-reduced-motion: reduce)').matches)
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
    else if (s) s.scrollTop = s.scrollHeight;
    seen();
  };
  // While stuck, what comes after the newest message shrinking (a working row going, a card getting shorter once
  // answered, the composer) would shorten the page and pull everything down, under your pointer, just as a card
  // that needs you arrives. Instead the transcript keeps its height, until the next message or a new width.
  let held = { end: 0, last: 0, width: 0 };
  const lastItem = () => {
    for (let n = el.lastElementChild; n; n = n.previousElementSibling) if (n instanceof HTMLElement && n.dataset.key) return n;
    return null;
  };
  const measure = (s) => ({
    end: s.scrollHeight,
    last: (lastItem()?.getBoundingClientRect().top ?? 0) - viewTop(s) + s.scrollTop,
    width: el.clientWidth,
  });
  const release = () => {
    if (el.style.minHeight) el.style.minHeight = '';
  };
  // After anything changes size: back to the bottom while stuck, else keep what you were reading in place.
  const follow = () => {
    const s = box();
    if (!s || dead) return;
    // You scrolled up in this frame, before its scroll event: that counts, so don’t pull you back.
    if (stuck && s.scrollTop < lastTop - 1 && !atEnd(s)) {
      stuck = false;
      anchor = findAnchor();
    }
    if (stuck) {
      const now = measure(s);
      if (now.width !== held.width) release();
      else if (now.end < held.end && Math.abs(now.last - held.last) < 1 && held.end > s.clientHeight)
        el.style.minHeight = `${el.getBoundingClientRect().height + held.end - now.end}px`;
      if (!atEnd(s)) s.scrollTop = s.scrollHeight;
      held = measure(s);
    } else holdAnchor();
    showJump(s);
  };
  // Only your own scrolling unsticks the view: content growing never scrolls, and the browser doesn’t anchor
  // (overflow-anchor is off), so the view moving up means you moved it, by wheel, keys or a drag, even over an app.
  let lastTop = 0;
  const onScroll = () => {
    const s = box();
    if (!s) return;
    // The event for a scroll the transcript made itself, holding what you read in place, comes in a later frame, maybe
    // after what’s above has moved again: hold it in place again before taking the anchor there, or you lose your place (#297).
    const moved = s.scrollTop !== lastTop;
    if (atEnd(s)) {
      if (!stuck) held = measure(s);
      stuck = true;
    } else if (s.scrollTop < lastTop) stuck = false;
    // However you got near the end, there’s nothing unread below any more (#91).
    if (gapOf(s) <= PILL_ROOM) seen();
    lastTop = s.scrollTop;
    if (stuck) return;
    if (!moved) holdAnchor();
    anchor = findAnchor();
  };
  const sizes = new ResizeObserver(follow);
  // A change that makes the transcript shorter while stuck (a held height released, an app’s check giving way to its
  // frame) pulls the view up to the page’s new end. That isn’t you, but its scroll event can come after the page grew
  // back, and read as you scrolling up (#297). So note where the view is, if it’s at the new end: a wheel turn moves it
  // before its scroll event too, and only that one leaves it above the end.
  const changes = new MutationObserver(() => {
    const s = box();
    if (stuck && s && !dead && atEnd(s)) lastTop = Math.min(lastTop, s.scrollTop);
  });
  changes.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  let bound = null;
  const bind = () => {
    const s = box();
    if (bound || !s || !el.isConnected) return;
    bound = inPanel ? s : window;
    bound.addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', follow);
    sizes.observe(el);
    // What’s around it changing moves the end too: the composer, the panel’s height, the thread’s root above.
    if (el.parentElement) for (const n of [el.parentElement, ...el.parentElement.children]) if (n !== el) sizes.observe(n);
  };
  /** Once the transcript is on the page: to the newest message, or back where you were before a rebuild. */
  const settle = () => {
    // A rebuild can replace this transcript before the frame it was to settle in.
    if (dead) return;
    bind();
    const s = box();
    if (stuck) scrollToEnd();
    else holdAnchor();
    if (s) {
      showJump(s);
      held = measure(s);
    }
    lastTop = s?.scrollTop ?? 0;
  };
  let jump = null;
  const grew = () => {
    if (stuck) follow();
    else {
      unseen++;
      showJump(box());
    }
  };

  const off = client.on((ch) => {
    if (ch.type === 'load') {
      all();
      return;
    }
    const d = ch.data;
    if (ch.type === 'item.add' && d.threadId === threadId) {
      if (nodes.size === 0) el.replaceChildren();
      // A new message takes the place of any height held below the last one.
      release();
      const list = itemsOf(threadId);
      const n = render(d.item, list[list.length - 2]);
      nodes.set(d.item.id, n);
      el.append(n);
      paintWorking();
      grew();
    } else if (ch.type === 'item.move' && d.threadId === threadId) {
      // An update brought an app or a block to the newest point (#49, #92). Its stub takes its old place, the same
      // height a line takes, and what you were reading stays put: if that was the item, the stub holds its place.
      const list = itemsOf(threadId);
      const at = list.findIndex((x) => x.id === d.stub.id);
      const stub = render(d.stub, list[at - 1]);
      nodes.get(d.id)?.replaceWith(stub);
      nodes.set(d.stub.id, stub);
      if (anchor?.key === d.id) anchor = { key: d.stub.id, at: Math.max(0, anchor.at) };
      // The message after it now follows the stub, so whether it names its speaker can change.
      if (list[at + 1] && list[at + 1].id !== d.id) rerender(list[at + 1].id);
      release();
      const n = render(list[list.length - 1], list[list.length - 2]);
      nodes.set(d.id, n);
      el.append(n);
      paintWorking();
      grew();
    } else if (ch.type === 'item.patch' && d.threadId === threadId) {
      if (!d.reaction) rerender(d.id);
    } else if (ch.type === 'item.text' && d.threadId === threadId) {
      pending.add(d.id);
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          for (const id of pending) updateText(id);
          pending.clear();
        });
    } else if (ch.type === 'glossary' && d.threadId === threadId) {
      for (const it of itemsOf(threadId)) if (it.kind === 'agent') updateText(it.id, true);
    } else if (ch.type === 'session') {
      el.querySelectorAll(`pb-ring[data-session="${CSS.escape(d.id)}"]`).forEach((r) => {
        ringFor(d, r.getAttribute('size'), r);
      });
      // An agent at work here may not be one of this thread’s own (#110): its turn is in it.
      paintWorking();
      for (const it of itemsOf(threadId))
        if (it.kind === 'sidelink' && nodes.get(it.id)?.dataset.sideSig !== sideSig(sideActive(it.sideThreadId))) rerender(it.id);
    } else if (ch.type === 'app') {
      for (const it of itemsOf(threadId))
        if (it.kind === 'block' && it.valid && (it.block.id === d.id || it.block.appId === d.id)) {
          if (it.block.type === 'app') {
            // Only what changes the frame re-renders it: a new version, a version picked, the check’s result, or retiring (#193).
            // Saved state never does; the running app already has it, and reloading would make it save again.
            const sig = appSig(d);
            const node = nodes.get(it.id);
            if (node?.dataset.appSig !== sig) {
              rerender(it.id);
              const fresh = nodes.get(it.id);
              if (fresh) fresh.dataset.appSig = sig;
            }
          } else if (it.block.type === 'review' && it.block.format === 'app') {
            // The review frame keeps its draft; only re-render when the app’s version changed.
            const prev = nodes.get(it.id)?.dataset.appVersion;
            if (prev !== String(d.current)) rerender(it.id);
          }
        }
    }
    hostChanged(ch, threadId, nodes, rerender, hostTurns);
  });

  const updateText = (id, force = false) => {
    const it = itemsOf(threadId).find((x) => x.id === id);
    const node = nodes.get(id);
    if (!it || !node) return;
    const box = node.querySelector(':scope > .md');
    if (!box) {
      rerender(id);
      return;
    }
    box.innerHTML = agentMarkdown(it, threadId); // lint-allow dom: renderMarkdown() output, escaped.
    markTerms(box, threadId);
    if (it.status === 'streaming') box.append(h('span.caret', { 'aria-hidden': 'true' }));
    else enhanceMarkdown(box);
    if (!force) announceStreaming(it.id, it.text, it.status !== 'streaming', `@${it.handle}`);
  };

  return {
    el,
    settle,
    scrollToEnd,
    setJump(fn) {
      jump = fn;
    },
    destroy() {
      off();
      dead = true;
      if (!stuck && el.isConnected) {
        const key = `${inPanel}:${threadId}`;
        kept.set(key, { anchor: findAnchor() ?? anchor, unseen });
        queueMicrotask(() => kept.delete(key));
      }
      sizes.disconnect();
      changes.disconnect();
      bound?.removeEventListener('scroll', onScroll);
      removeEventListener('resize', follow);
    },
  };
}

function fillWorkRow(row, se) {
  ringFor(se, 'xs', row.querySelector('pb-ring'));
  const step = se.state === 'tool' && se.currentStep ? `: ${se.currentStep}` : '';
  fill(
    row.querySelector('.work-text'),
    h('div.work-line', h('b', `@${se.handle}`), h('span.dim', ` · ${stateWord(se.state).toLowerCase()}${step}`)),
    se.glimpse ? h('div.glimpse', se.glimpse) : null,
    // Each subagent at work, in its own words when it has said something (#73): “reader: Now I’ll read paper 3…”.
    (se.subagents ?? []).map((x) => h('div.work-line.work-sub', h('span', `${x.name}: `), h('span.dim', subagentNow(x)))),
  );
}

const who = (it, { you = false } = {}) => {
  const se = S().sessions[it.sessionId];
  const ts = h('span.ts', { title: `${dayOf(it.at)} ${timeOf(it.at)}` }, `${timeOf(it.at)}`);
  // A turn typed into Claude Code in a terminal, mirrored here, says so.
  const via = it.via === 'terminal' ? h('span.via', 'from terminal') : null;
  if (you) return h('div.who', ts, h('b', 'You'), via);
  const ring = se ? ringFor(se, 'xs') : h('pb-ring', { name: `@${it.handle}`, state: 'idle', ctx: '0', size: 'xs' });
  if (se) ring.dataset.session = se.id;
  const state = se ? h('span.who-state', { dataset: { session: se.id, item: it.id }, 'aria-live': 'off' }) : null;
  const woke = it.woke ? h('span.woke', wokeText(it.woke)) : null;
  return h('div.who', ring, h('b', `@${it.handle}`), mockMarker(se), state, it.deletedAgent ? h('span.deleted', '(deleted)') : null, via, woke, ts);
};

// Under a message in a conversation: “Reply in thread”, or once a thread exists, “3 replies”. Under a message in a
// topic or side thread (#128): “Send to conversation”. React, under every one (#251). They appear on hover and focus, and always on touch.
function messageActions(node, it, ctx) {
  if (!['user', 'agent', 'block', 'shared'].includes(it.kind) || it.status === 'streaming' || it.deletedAgent || (it.kind === 'block' && !it.valid)) return;
  if (it.status === 'replaced') return;
  const bar = h('div.msg-actions');
  if (ctx.kind === 'thread' || ctx.kind === 'room') {
    const topic = it.topicId && S().threads[it.topicId];
    if (topic) {
      const unread = topic.unread ?? 0;
      bar.append(
        h(
          'a.replies',
          { href: hrefOf(topic.id) },
          icon('thread', 'i-sm'),
          it.replies ? plural(it.replies, 'reply', 'replies') : 'Thread',
          it.lastReplyAt ? h('span.dim', ` · last reply ${ago(it.lastReplyAt)}`) : null,
          unread ? h('span.badge', { 'aria-label': `${unread} new` }, String(unread)) : null,
        ),
      );
    } else
      bar.append(
        h(
          'button.btn.sm.ghost.reveal',
          {
            type: 'button',
            onclick: () =>
              api(`/api/threads/${ctx.threadId}/items/${it.id}/topic`, {})
                .then((r) => {
                  navigate(`#/t/${ctx.threadId}/side/${r.threadId}`);
                  setTimeout(() => $('#side-input')?.focus(), 150);
                })
                .catch((e) => toast({ title: 'Couldn’t start a thread', text: e.message, level: 'blocking' })),
          },
          icon('thread', 'i-sm'),
          'Reply in thread',
        ),
      );
  } else if ((ctx.kind === 'topic' || ctx.kind === 'side') && (it.kind === 'agent' || it.kind === 'user') && it.text) {
    bar.append(
      it.sharedAt
        ? h('span.small.dim', icon('check', 'i-sm'), ' Sent to the conversation')
        : h(
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
          ),
    );
  }
  node.append(reactTo(bar, node, it, ctx));
}

function renderItem(it, prev, ctx) {
  const showWho = !(prev && speaker(prev) && speaker(prev) === speaker(it) && prev.kind !== 'voice' && sameTurn(prev, it));
  switch (it.kind) {
    case 'user': {
      return h(
        'div.col.turn.me',
        showWho ? who(it, { you: true }) : null,
        h(
          'div.me-card',
          h('div.md', { html: trusted(renderMarkdown(it.text, { mentions: handles() })) }),
          it.attachments?.length ? h('div.attachments', it.attachments.map(attChip)) : null,
        ),
      );
    }
    case 'agent': {
      // Replayed whole from the host after a restart (#120): the replay is the reply, so this part of it shows nothing.
      if (it.status === 'replaced') return h('div.col.replaced', { hidden: true });
      const [notice, steps] = kiroStep(it);
      const total = steps.reduce((a, s) => a + (s.ms ?? 0), 0);
      const node = h(
        'div.col.turn',
        showWho ? who(it) : null,
        notice,
        steps.length
          ? h(
              'details.activity',
              h(
                'summary',
                icon('right', 'i-sm'),
                activityLabel(steps),
                total ? ` · ${(total / 1000).toFixed(total < 10000 ? 1 : 0)} s in tools` : '',
                runningNote(it, steps),
              ),
              stepTree(steps),
            )
          : null,
        jobRows(it, steps),
        it.text || it.status === 'streaming' ? h('div.md') : null,
        // What the turn changed, ran and published, under its last reply (#132, #195), leading to Work.
        it.work ? workChip(it, ctx) : null,
        hostEnd(it),
        it.status === 'stopped' && !it.note ? stoppedTag(it) : null,
        it.status === 'failed' && !failedOnHost(it)
          ? h(
              'div.callout',
              { role: 'alert' },
              h('span.g.g-failed', { 'aria-hidden': 'true' }),
              h('div.grow', ...failureText(it.error)),
              h(
                'button.btn.sm',
                {
                  type: 'button',
                  onclick: () =>
                    api(`/api/threads/${ctx.threadId}/items/${it.id}/retry`, {}).catch((e) =>
                      toast({ title: 'Retry didn’t start', text: e.message, level: 'blocking' }),
                    ),
                },
                icon('retry', 'i-sm'),
                'Retry',
              ),
            )
          : null,
        it.status === 'retried' ? h('span.stopped-tag', 'Retried below') : null,
        it.sources?.length
          ? h(
              'details.sources',
              { open: true },
              h('summary', `Sources · ${it.sources.length}`),
              h(
                'ol',
                it.sources.map((s, i) =>
                  h(
                    'li',
                    { id: `src-${it.id}-${i + 1}` },
                    s.authors ? `${s.authors.split(',')[0]}${s.authors.includes(',') ? ' et al.' : ''} ` : '',
                    s.year ? `(${s.year}). ` : '',
                    h('i', s.title),
                    '. ',
                    s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url.replace(/^https?:\/\//, '')) : null,
                  ),
                ),
              ),
            )
          : null,
      );
      const box = node.querySelector(':scope > .md');
      if (box) {
        box.innerHTML = agentMarkdown(it, ctx.threadId); // lint-allow dom: renderMarkdown() output, escaped.
        markTerms(box, ctx.threadId);
        if (it.status === 'streaming') box.append(h('span.caret', { 'aria-hidden': 'true' }));
        else queueMicrotask(() => enhanceMarkdown(box));
      }
      return node;
    }
    case 'block': {
      if (it.valid && it.block.type === 'app') {
        // Named like any other block (#88). Only the agent that wrote an app can update it, so this is also who
        // made each version.
        return h('div.wide', showWho ? h('div.col', who(it)) : null, renderAppItem(it, ctx), it.work ? workChip(it, ctx) : null);
      }
      // revision: the one the person answered (#123); a card’s or table’s action doesn’t say.
      const act = async (action, values, revision) => {
        const r = await api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action, values, revision });
        focusComposer();
        return r;
      };
      const node = h('div.col.turn', showWho ? who(it) : null, renderBlock(it, { act, threadId: ctx.threadId }), it.work ? workChip(it, ctx) : null);
      if (it.valid && it.block.type === 'review' && it.block.format === 'app') node.dataset.appVersion = String(S().apps[it.block.appId]?.current ?? '');
      return node;
    }
    case 'voice':
      // An app’s summary is its own wording, so it shows beside your line as a quote from the app, never in your
      // voice (#51).
      return h(
        'div.col.turn.me',
        h('span.voice', icon('thread', 'i-sm'), it.text),
        it.quote ? h('span.app-says', 'The app’s summary: ', h('q', it.quote)) : null,
      );
    case 'shared': {
      // A reply or a summary sent back from a topic or side thread, by you or by an agent you asked (#128). Its agents
      // read it at the start of their next turn. It’s drawn as an agent’s reply is (#99), with the glossary of the
      // thread it was written in while that thread is there, and its terms look their cards up there too.
      const from = S().threads[it.fromThreadId] ? it.fromThreadId : ctx.threadId;
      const node = h(
        'div.col.turn',
        h(
          'div.shared-card',
          h(
            'div.shared-head',
            icon('thread', 'i-sm'),
            h(
              'span.grow',
              it.summary ? 'Summary of the thread ' : 'From the thread ',
              h('b', `“${it.fromTitle}”`),
              it.agent ? ` · shared by @${it.handle} in a turn you started` : it.handle ? ` · @${it.handle}` : ' · you',
            ),
            S().threads[it.fromThreadId] ? h('a.small', { href: hrefOf(it.fromThreadId) }, 'Open thread') : null,
          ),
          h('div.md', { html: trusted(agentMarkdown(it, from)), dataset: { thread: from } }),
        ),
      );
      const box = node.querySelector('.shared-card > .md');
      markTerms(box, from);
      queueMicrotask(() => enhanceMarkdown(box));
      return node;
    }
    case 'system':
      return systemLine(it, ctx);
    case 'sidelink':
      return sideLine(it, ctx);
    case 'hop':
      return hopBlock(it, ctx);
    case 'permission':
      return permissionBlock(it, ctx);
    case 'command':
      return commandBlock(it, ctx);
    case 'denial':
      return denialBlock(it, ctx);
    case 'toolask':
      return toolAskBlock(it, ctx);
    case 'appsend':
      return renderAppSendCard(it, ctx);
    case 'moved':
      return movedLine(it, ctx);
    case 'proposal':
      return proposalBlock(it, ctx, showWho);
    default:
      return h('div.col.small.dim', `Unknown item “${it.kind}”.`);
  }
}

/** A turn’s line and its list from the work ledger (#132, #195), each leading to the conversation’s Work. */
function workChip(it, ctx) {
  const t = client.state.threads[ctx.threadId];
  const conv = (t?.kind === 'side' || t?.kind === 'topic') && t.parentId ? t.parentId : ctx.threadId;
  const s = client.state;
  return workList(it, conv, [s.projects?.[s.threads[conv]?.projectId]?.folder, s.personas?.[s.sessions?.[it.sessionId]?.personaId]?.folder]);
}

function failureText(msg = 'This reply didn’t finish.') {
  const m = msg.match(/^(.*?[.!?])\s+([\s\S]*)$/);
  return m ? [h('b', m[1]), ' ', m[2]] : [h('b', msg)];
}

const fileSize = (size) => (size > 1e6 ? `${(size / 1e6).toFixed(1)} MB` : `${Math.ceil(size / 1000)} KB`);

/**
 * An attachment on a sent message. Images the server shows inline (INLINE_TYPES) get a thumbnail that opens
 * the full image in a new tab; everything else, an SVG included, is a file chip that downloads.
 */
function attChip(a) {
  const label = a.kind === 'project-file' ? a.path : a.name;
  const href = a.fileId ? `/api/files/${encodeURIComponent(a.fileId)}` : null;
  if (href && INLINE_TYPES.has(a.type)) {
    // One link: the image’s alt text and the size are its name, so it reads as “photo.png · 318 KB”.
    return h(
      'a.att-image',
      { href, target: '_blank', rel: 'noopener' },
      h('img', { src: href, alt: a.name, width: '160', height: '120', loading: 'lazy', decoding: 'async' }),
      h('span.att-cap', h('span.att-name', { 'aria-hidden': 'true' }, a.name), a.size ? h('span.dim', ` · ${fileSize(a.size)}`) : null),
    );
  }
  return h(
    'span.att',
    h('span.thumb', icon(a.kind === 'project-file' ? 'folder' : /^image\//.test(a.type ?? '') ? 'image' : 'file', 'i-sm')),
    href ? h('a', { href, style: { color: 'inherit' } }, label) : label,
    a.size ? h('span.dim', ` · ${fileSize(a.size)}`) : null,
  );
}

function systemLine(it, _ctx) {
  switch (it.variant) {
    case 'attached':
      return h(
        'div.col.sys-line',
        icon('link', 'i-sm'),
        h('b', `@${it.handle}`),
        ' is a Claude Code session from ',
        h('span.mono', it.folder ?? 'a terminal'),
        '. What you type there shows up here too.',
      );
    case 'wake':
      if (it.scheduled) return h('div.col.sys-line', icon('clock', 'i-sm'), h('b', `@${it.to}`), ' woke itself, as scheduled');
      return h(
        'div.col.sys-line',
        icon('agent', 'i-sm'),
        it.from === 'you'
          ? ['You woke ', h('b', `@${it.to}`)]
          : [
              h('b', `@${it.from}`),
              ' woke ',
              h('b', `@${it.to}`),
              // It had no session here, so it joined the conversation to answer (#110).
              it.joined ? ' · joined the conversation' : '',
              it.n ? ` · agent wake ${it.n} of ${it.limit ?? 3}` : '',
            ],
      );
    case 'compaction': {
      const sum = h(
        'div.block',
        { hidden: true, style: { marginTop: '8px' } },
        h('div.block-head', h('span.title.grow', `What @${it.handle} kept`), h('span.kind', 'Compaction')),
        h('div.block-body', h('div.md', { html: trusted(renderMarkdown(it.summary || 'No summary was kept.')) })),
      );
      const btn = h(
        'button.btn.sm.ghost',
        {
          type: 'button',
          'aria-expanded': 'false',
          onclick: () => {
            sum.hidden = !sum.hidden;
            btn.textContent = sum.hidden ? 'Show summary' : 'Hide summary';
            btn.setAttribute('aria-expanded', String(!sum.hidden));
          },
        },
        'Show summary',
      );
      return h(
        'div.col',
        h(
          'div.sys',
          h(
            'span.pill',
            icon('archive', 'i-sm'),
            'Context compacted · ',
            h('b', `@${it.handle}`),
            ` #${it.n} · kept ${Math.round(it.kept / 1000)}k of ${Math.round(it.total / 1000)}k tokens`,
            btn,
          ),
        ),
        sum,
      );
    }
    case 'schedule':
      return h(
        'div.col.sys-line',
        icon('clock', 'i-sm'),
        h('b', `@${it.handle}`),
        it.status === 'pending'
          ? ` will wake itself at ${timeOf(it.at)}`
          : it.status === 'canceled'
            ? ' won’t wake itself (canceled)'
            : ` woke itself at ${timeOf(it.at)}`,
        it.note ? ` · “${it.note}”` : '',
        it.status === 'pending'
          ? [
              ' · ',
              h(
                'button.btn.sm.ghost',
                {
                  type: 'button',
                  onclick: () => api(`/api/schedules/${it.scheduleId}/cancel`, {}).catch((e) => toast({ title: 'Couldn’t cancel', text: e.message })),
                },
                'Cancel',
              ),
            ]
          : null,
      );
    case 'dataset':
      // An agent loaded a dataset into the corpus (#47): searched only when a search names it.
      return h(
        'div.col.sys-line',
        icon('books', 'i-sm'),
        h('b', `@${it.handle}`),
        ' loaded the dataset ',
        h('span.mono', it.dataset),
        ` · ${plural(it.records, 'record')}, searched only when named`,
      );
    case 'joined':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', `@${it.to}`), ' joined');
    case 'left':
      return h('div.col.sys-line', icon('agent', 'i-sm'), h('b', `@${it.to}`), ' left (its session was deleted)');
    default:
      return h('div.col.sys-line', it.text ?? '');
  }
}

/**
 * Where an app or a block was before an update brought it to the newest point (#49, #92): one line that leads to it.
 * There’s one live copy, below; this only says it moved.
 */
function movedLine(it, ctx) {
  const live = itemsOf(ctx.threadId).some((x) => x.id === it.itemId);
  const line = h(
    'div.col.sys-line.moved',
    icon('down', 'i-sm'),
    h('span', h('b', it.title), it.what === 'app' ? ` · updated to v${it.v} below` : ' · asked again below'),
    live
      ? h(
          'button.btn.sm.ghost',
          {
            type: 'button',
            // The name starts with the words on the button, so saying what you see presses it (WCAG 2.5.3).
            'aria-label': `Go to it: ${it.title}`,
            onclick: (e) => {
              const box = /** @type {HTMLElement} */ (e.currentTarget).closest('.transcript');
              const node = box?.querySelector(`:scope > [data-key="${CSS.escape(it.itemId)}"]`);
              if (!(node instanceof HTMLElement)) return;
              node.scrollIntoView({ block: 'center' });
              (node.querySelector('button:not([disabled]), input, textarea, select') ?? node).focus({ preventScroll: true });
            },
          },
          'Go to it',
        )
      : null,
  );
  // A turn’s list stays here when the item that carried it moved on (#195).
  return it.work ? h('div.col', line, workChip(it, ctx)) : line;
}

/**
 * A `!command` you ran (#67): the command line, where it ran, its output as it streams (the last 64 KB, saying when
 * earlier output was cut), Stop while it runs, then the exit code and how long it took. The agents read it on their
 * next turn.
 */
function commandBlock(it, ctx) {
  const running = it.status === 'running';
  const secs = it.ms != null ? `${(it.ms / 1000).toFixed(it.ms < 10000 ? 1 : 0)} s` : '';
  const ended =
    it.status === 'done'
      ? [icon('check', 'i-sm'), `Exit 0 · ${secs}`]
      : it.status === 'stopped'
        ? [icon('x', 'i-sm'), it.error ? `Stopped: ${it.error}` : `Stopped by you${secs ? ` · ${secs}` : ''}`]
        : it.error
          ? [icon('warn', 'i-sm'), `Couldn’t run: ${it.error}`]
          : [icon('warn', 'i-sm'), `Exit ${it.exitCode ?? it.signal ?? '?'} · ${secs}`];
  const titleId = `cmd-${it.id}`;
  const { where, text } = ranHere(it, running);
  const out = text ? h('pre.md-code.cmd-out', { tabindex: '0', 'aria-label': `Output of ${it.command}` }, h('code', text)) : null;
  // While it runs, the newest output is in view: the item is drawn again as output arrives.
  if (out && running) requestAnimationFrame(() => out.scrollTo({ top: out.scrollHeight }));
  return h(
    'div.col.block.cmd-block',
    { role: 'group', 'aria-labelledby': titleId, class: it.status === 'failed' ? 'cmd-failed' : '' },
    h('div.block-head', h('code.title.grow.cmd-line', { id: titleId }, `! ${it.command}`), h('span.kind', `Command · ${it.cwd}`)),
    h(
      'div.block-body',
      where,
      it.cut ? h('p.small.dim', 'Earlier output was cut: this is the last 64 KB.') : null,
      it.paused && running ? h('p.small.dim', 'It’s still printing. The end of its output shows here when it finishes.') : null,
      out ?? h('p.small.dim', running ? 'No output yet.' : 'No output.'),
    ),
    h(
      'div.block-foot',
      running
        ? [
            h('span.small', h('span.g.g-running', { 'aria-hidden': 'true' }), ' Running'),
            h(
              'button.btn.sm',
              {
                type: 'button',
                onclick: () => api(`/api/threads/${ctx.threadId}/shell/${it.id}/stop`, {}).catch((e) => toast({ title: 'Couldn’t stop it', text: e.message })),
              },
              'Stop',
            ),
          ]
        : h('span.answered-note.cmd-exit', { role: 'status' }, ...ended),
      h('span.small.dim.grow.cmd-note', 'The agents read this on their next turn.'),
    ),
  );
}

const BACKEND_NAMES = {
  'claude-code': 'Claude Code',
  'agent-sdk': 'Agent SDK',
  'kiro-cli': 'Kiro CLI',
  'antigravity-cli': 'Antigravity CLI',
  codex: 'Codex',
  mock: 'Mock agent',
};

function proposalBlock(it, ctx, showWho) {
  const p = it.proposal;
  const open = it.status === 'open';
  const act = (action) =>
    api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action })
      .then(focusComposer)
      .catch((e) => toast({ title: 'That didn’t go through', text: e.message, level: 'blocking' }));
  return h(
    'div.col.turn',
    showWho ? who(it) : null,
    h(
      'div.block',
      { role: 'group', class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
      h('div.block-head', icon('spark'), h('span.title.grow', `New teammate: @${p.handle}`), h('span.kind', `Proposed by @${it.handle}`)),
      h(
        'div.block-body',
        h('p', String(p.description ?? '')),
        h(
          'dl.facts',
          h('dt', 'Runs on'),
          h('dd', BACKEND_NAMES[S().personas[S().sessions[it.sessionId]?.personaId]?.backend] ?? 'Mock agent', ', asking before anything risky'),
          h('dt', 'Tools'),
          h(
            'dd',
            h(
              'div.chips',
              p.tools.map((t) => h('span.pill', { style: it.extraTools.includes(t) ? { borderColor: 'var(--accent)' } : {} }, h('b', { class: 'mono' }, t))),
            ),
            it.extraTools.length
              ? h(
                  'span.err',
                  { style: { color: 'var(--accent)' } },
                  icon('warn'),
                  `${it.extraTools.join(', ')} ${it.extraTools.length === 1 ? 'is' : 'are'} more than @${it.handle} has. Creating @${p.handle} grants ${it.extraTools.length === 1 ? 'it' : 'them'}.`,
                )
              : null,
          ),
          h('dt', 'Joins'),
          h('dd', `This ${ctx.kind === 'topic' ? 'topic thread' : ctx.kind === 'side' ? 'side thread' : 'conversation'}, with the recent messages as context`),
        ),
        !open ? h('span.answered-note', icon('check', 'i-sm'), it.status === 'created' ? `Created @${p.handle}` : 'Dismissed') : null,
      ),
      open
        ? h(
            'div.block-foot',
            h('button.btn', { type: 'button', onclick: () => act('create') }, `Create @${p.handle}`),
            h(
              'button.btn',
              { type: 'button', onclick: () => openNewAgent({ threadId: ctx.threadId, preset: p, onCreated: () => act('dismiss') }) },
              'Edit first',
            ),
            h('button.btn.ghost', { type: 'button', onclick: () => act('dismiss') }, 'Dismiss'),
          )
        : null,
    ),
  );
}

function welcome(threadId) {
  const se = sessionsOf(threadId)[0];
  const p = se && S().personas[se.personaId];
  if (!se || !p) return h('div.col', h('p.dim', 'No agent is in this conversation yet. @-mention one to bring it in.'));
  const ring = ringFor(se, 'lg');
  ring.dataset.session = se.id;
  return h(
    'section.col',
    { style: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '32px 0' } },
    h('div.row-flex', { style: { gap: '14px' } }, ring, h('div', h('h1.title', `@${p.handle} is ready`), h('p.dim', String(p.description ?? '')))),
    h(
      'div',
      { role: 'list', 'aria-label': 'Example prompts', style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '10px' } },
      (p.examples ?? []).map(([title, sub]) =>
        h(
          'button.prompt',
          {
            type: 'button',
            role: 'listitem',
            style: {
              all: 'unset',
              boxSizing: 'border-box',
              cursor: 'pointer',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
              padding: '12px',
              border: '1px solid var(--line-strong)',
              borderRadius: '8px',
              background: 'var(--panel)',
            },
            onclick: () => sendMessage(threadId, title),
          },
          h('b', title),
          h('span.small.dim', sub),
        ),
      ),
    ),
  );
}

// ── Composer ────────────────────────────────────────────────────────────────────────────

// Messages typed while offline. Kept in localStorage so a reload doesn’t lose them, and sent whenever the
// connection returns, whether or not a composer is open.
const OUTBOX_KEY = 'pb-outbox';
const outbox = (() => {
  try {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]');
  } catch {
    return [];
  }
})();
const saveOutbox = () => {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox));
  } catch {}
};
client.on((ch) => {
  if (ch.type === 'connection' && client.connection === 'open') flushOutbox();
});

export async function sendMessage(threadId, text, attachments = [], { sendNow = false } = {}) {
  try {
    const r = await api(`/api/threads/${threadId}/messages`, { text, attachments, sendNow });
    if (r.queued) say('Queued. It sends when the agent finishes.');
    return true;
  } catch (e) {
    if (e.offline) {
      outbox.push({ threadId, text, attachments });
      saveOutbox();
      client.emit({ type: 'outbox' });
      return true;
    }
    toast({ title: 'Your message didn’t send', text: e.message, level: 'blocking' });
    return false;
  }
}

export function flushOutbox() {
  const items = outbox.splice(0);
  saveOutbox();
  for (const m of items) sendMessage(m.threadId, m.text, m.attachments);
  if (items.length) client.emit({ type: 'outbox' });
}

export function mountComposer(threadId, { side = false } = {}) {
  const topic = S().threads[threadId]?.kind === 'topic';
  // / and ! (#67) live in a conversation’s own composer, not in a thread panel’s.
  const commands = !side && !topic;
  const key = `pb-draft-${threadId}`;
  let attachments = [];
  let mention = null; // { start, query, index }
  const ta = h('textarea', {
    id: side ? 'side-input' : 'composer-input',
    rows: '1',
    'aria-label': topic ? 'Reply in thread' : side ? 'Message the side thread' : 'Message',
    autocomplete: 'off',
  });
  try {
    ta.value = localStorage.getItem(key) ?? '';
  } catch {}
  const plus = h('button.btn.icon.ghost', {
    type: 'button',
    'aria-label': 'Add a file or a new agent',
    'aria-haspopup': 'menu',
    onclick: () => plusMenu(plus),
  });
  plus.append(icon('plus'));
  // The / menu (#67): Postbox’s commands and the agents’ skills, by typing / or with this button. Only in a
  // conversation’s own composer, where ! runs commands too.
  let slash = null; // { query, index }
  let slashTarget = null; // the agent skill or command picked: { sessionId, handle, name, argumentHint }
  const commandsButton = !commands
    ? null
    : h(
        'button.btn.icon.ghost.cmd-button',
        {
          type: 'button',
          'aria-label': 'Commands',
          title: 'Commands (/)',
          'aria-haspopup': 'listbox',
          onclick: () => {
            if (!ta.value.startsWith('/')) ta.value = `/${ta.value.trimStart()}`;
            ta.focus();
            ta.setSelectionRange(1, 1);
            updateSlash();
            autosize();
          },
        },
        h('span.cmd-glyph', { 'aria-hidden': 'true' }, '/'),
      );
  const action = h('button.btn', { type: 'button' });
  const att = h('div.attachments', { role: 'group', 'aria-label': 'Attachments' });
  const queue = h('div.outbox');
  // Stop’s ask about background jobs (#129), one row per agent, until you answer it.
  const asks = h('div.outbox');
  /** @type {Map<string, { jobs: number, text: string, turnId?: string }>} asks the server returned before its session event arrives */
  const asked = new Map();
  const status = h('div');
  const hint = h('div.hint');
  const menuBox = h('div', { style: { position: 'relative' } });
  const file = h('input', {
    type: 'file',
    multiple: true,
    hidden: true,
    onchange: () => {
      addFiles([...file.files]);
      file.value = '';
    },
  });
  const corpusFile = h('input', {
    type: 'file',
    accept: '.txt,.md,text/plain,text/markdown',
    hidden: true,
    onchange: async () => {
      for (const f of corpusFile.files) {
        try {
          const up = await uploadFile(f);
          await api('/api/corpus', { fileId: up.id });
          toast({ title: `Added ${f.name} to the corpus`, text: 'It’s searchable now.' });
        } catch (e) {
          toast({ title: `Couldn’t add ${f.name}`, text: e.message, level: 'blocking' });
        }
      }
      corpusFile.value = '';
    },
  });

  const autosize = () => fitTextarea(ta);
  const save = () => {
    try {
      localStorage.setItem(key, ta.value);
    } catch {}
  };
  const thread = () => S().threads[threadId];
  // The composer’s Stop: an agent whose turn is here, the last speaker first.
  const busyOne = () =>
    sessionsAt(threadId)
      .filter((se) => busy(se) && (!se.sideTurn || se.sideTurn.threadId === threadId))
      .sort((a, _b) => (a.id === thread()?.lastSpeaker ? -1 : 1))[0];

  async function addFiles(files) {
    for (const f of files) {
      const chip = { kind: 'file', name: f.name, size: f.size, type: f.type, uploading: true };
      attachments.push(chip);
      paintAtt();
      try {
        Object.assign(chip, { fileId: (await uploadFile(f)).id, uploading: false });
      } catch (e) {
        attachments = attachments.filter((x) => x !== chip);
        toast({ title: `Couldn’t attach ${f.name}`, text: e.message, level: 'blocking' });
      }
      paintAtt();
    }
  }
  function paintAtt() {
    att.replaceChildren(
      ...attachments.map((a) =>
        h(
          'span.att',
          h('span.thumb', icon(a.kind === 'project-file' ? 'folder' : /^image\//.test(a.type ?? '') ? 'image' : 'file', 'i-sm')),
          a.kind === 'project-file' ? a.path : a.name,
          h('span.dim', a.uploading ? ' · uploading…' : a.kind === 'project-file' ? ' · from the project folder' : a.size ? ` · ${fileSize(a.size)}` : ''),
          h(
            'button.btn.icon.sm.ghost',
            {
              type: 'button',
              'aria-label': `Remove ${a.name ?? a.path}`,
              onclick: () => {
                attachments = attachments.filter((x) => x !== a);
                paintAtt();
              },
            },
            icon('x', 'i-sm'),
          ),
        ),
      ),
    );
  }

  function plusMenu(anchor) {
    const t = thread();
    const last = S().sessions[t?.lastSpeaker] ?? sessionsOf(threadId)[0];
    openMenu(
      anchor,
      [
        { heading: 'Add a file' },
        {
          label: 'Upload from computer',
          desc: side ? 'Or drop files on this thread' : 'Or drop files anywhere in the conversation',
          icon: 'upload',
          run: () => file.click(),
        },
        {
          label: 'From the project folder',
          desc: S().projects[t?.projectId]?.folder ?? '',
          icon: 'folder',
          run: () =>
            openFolderPicker(t.projectId, (path) => {
              attachments.push({ kind: 'project-file', path });
              paintAtt();
              focusComposer();
            }),
        },
        { label: 'Add to the corpus', desc: 'Index a text file for search', icon: 'books', run: () => corpusFile.click() },
        'hr',
        { heading: 'New agent' },
        { label: 'From a boilerplate', desc: boilerplateDesc(), icon: 'agent', run: () => openNewAgent({ threadId }) },
        ...((client.config.adapters ?? []).includes('claude-code')
          ? [{ label: 'Attach a Claude Code session', desc: 'One you started in a terminal', icon: 'link', run: () => openAttachSession(t?.projectId) }]
          : []),
        ...(last
          ? [
              {
                label: 'Recommend one',
                desc: `@${last.handle} drafts a teammate for this conversation`,
                icon: 'spark',
                run: () => sendMessage(threadId, `@${last.handle} please recommend a teammate for this conversation.`),
              },
            ]
          : []),
      ],
      { placement: 'above', label: 'Add' },
    );
  }

  const clear = () => {
    ta.value = '';
    slashTarget = null;
    save();
    autosize();
    paint();
  };

  // ── / and ! (#67) ──
  /** The agent / and ! act for by default: the one the composer replies to. */
  const target = () => {
    const members = sessionsOf(threadId).filter((x) => !x.archived);
    return members.find((x) => x.id === thread()?.lastSpeaker) ?? members[0] ?? null;
  };
  const isMock = (se) => S().personas[se?.personaId]?.backend === 'mock';
  /** Postbox’s own commands, which act on Postbox without a turn, for se: the agent named (#405), else target(). */
  const POSTBOX = [
    ['permissions', 'Its mode, rules, folders and MCP servers', (se = target()) => openPermissions({ threadId, sessionId: se?.id })],
    ['mode', 'Ask me, Auto, Accept edits or Run everything', (se = target()) => openRunChoice('mode', { threadId, sessionId: se?.id })],
    ['model', 'The model for this conversation', (se = target()) => openRunChoice('model', { threadId, sessionId: se?.id })],
    ['effort', 'How much it thinks, for this conversation', (se = target()) => openRunChoice('effort', { threadId, sessionId: se?.id })],
    ['add-dir', 'Let it work in another folder', (se) => addDir(se)],
    ['mcp', 'Its MCP servers: status, on or off', (se = target()) => openPermissions({ threadId, sessionId: se?.id, focus: 'mcp' })],
    ['compact', 'Summarize its context to make room', (se) => compact(se)],
    ['stop', 'Stop the agents that are working', (_se, named) => stopAll(named)],
    ['rename', 'Rename this conversation', () => openRename(threadId)],
  ];
  const POSTBOX_NAMES = new Set(POSTBOX.map(([n]) => n));
  function addDir(se = target()) {
    const projectId = thread()?.projectId;
    if (!se || !projectId) return;
    openFolderPicker(
      projectId,
      (path) =>
        api('/api/permissions/folders', { sessionId: se.id, path })
          .then((r) => toast({ title: `@${se.handle} may work in ${r.path}`, text: 'From its next turn.' }))
          .catch((e) => toast({ title: 'Couldn’t add the folder', text: e.message, level: 'blocking' })),
      { folders: true },
    );
  }
  function compact(se = target()) {
    if (!se) return;
    if (isMock(se)) return toast({ title: 'Nothing to compact', text: `@${se.handle} is a mock agent.` });
    runAgentCommand(se, '/compact');
  }
  function stopAll(only = null) {
    // In a conversation, Stop reaches its side threads too (#121), but not a turn in a topic thread: it has its own (#228).
    // only: the agent `@handle /stop` names (#405).
    const t = thread();
    const go = (se) => (!only || se.id === only.id) && busy(se) && !(t?.kind !== 'topic' && S().threads[se.sideTurn?.threadId]?.kind === 'topic');
    const working = (t?.kind === 'side' || t?.kind === 'topic' ? sessionsAt(threadId) : [...sessionsOf(threadId), ...sideSessionsOf(threadId)]).filter(go);
    if (!working.length) return say(only ? `@${only.handle} isn’t working.` : 'Nothing is running here.');
    for (const se of working)
      stopSession(se).then(
        (r) => (r?.ask ? askStop(se, r.ask) : say(`Stopped @${se.handle}.`)),
        (e) => toast({ title: `Couldn’t stop @${se.handle}`, text: e.message, level: 'blocking' }),
      );
  }
  /** An agent’s skills and commands: its session’s, else the latest from another session of its persona. */
  function agentCommands(se) {
    if (se.commands?.list?.length) return { list: se.commands.list, earlier: false };
    const other = Object.values(S().sessions)
      .filter((x) => x.personaId === se.personaId && x.id !== se.id && x.commands?.list?.length)
      .sort((a, b) => b.commands.at - a.commands.at)[0];
    return other ? { list: other.commands.list, earlier: true } : { list: [], earlier: false };
  }
  /** Everything the / menu offers for the query, in groups: Postbox’s, then each agent’s. */
  function slashOptions() {
    const q = slash?.query ?? '';
    const match = (name) => name.toLowerCase().includes(q);
    const groups = [{ label: 'Postbox', options: POSTBOX.filter(([n]) => match(n)).map(([name, desc, run]) => ({ name, desc, run })) }];
    for (const se of sessionsOf(threadId).filter((x) => !x.archived)) {
      const { list, earlier } = agentCommands(se);
      const options = list
        .filter((c) => !POSTBOX_NAMES.has(c.name) && match(c.name))
        .slice(0, 40)
        .map((c) => ({ name: c.name, desc: c.description ?? (c.skill ? 'Skill' : 'Command'), hint: c.argumentHint ?? '', se }));
      if (options.length) groups.push({ label: `@${se.handle}’s skills and commands${earlier ? ' · from an earlier session' : ''}`, options });
    }
    return groups.filter((g) => g.options.length);
  }
  const flatOptions = () => slashOptions().flatMap((g) => g.options);
  function updateSlash() {
    const upto = ta.value.slice(0, ta.selectionStart);
    if (!commands || !/^\/[^\s]*$/.test(upto)) {
      if (slash) {
        slash = null;
        paintSlash();
      }
      return;
    }
    const query = upto.slice(1).toLowerCase();
    slash = { query, index: slash?.query === query ? slash.index : 0 };
    paintSlash();
  }
  function paintSlash() {
    if (mention) return;
    menuBox.replaceChildren();
    ta.removeAttribute('aria-activedescendant');
    if (!slash) {
      ta.removeAttribute('aria-controls');
      return;
    }
    const groups = slashOptions();
    const n = groups.reduce((a, g) => a + g.options.length, 0);
    if (!n) {
      menuBox.append(h('div.menu.mention-menu.slash-menu', h('div.label', 'No command by that name'), h('p.small.dim', 'Enter sends it as a message.')));
      return;
    }
    slash.index = Math.min(slash.index, n - 1);
    let i = 0;
    const box = h(
      'div.menu.mention-menu.slash-menu',
      { role: 'listbox', id: 'slash-list', 'aria-label': 'Commands' },
      groups.map((g, gi) =>
        h(
          'div',
          { role: 'group', 'aria-labelledby': `slash-g-${gi}` },
          h('div.label', { id: `slash-g-${gi}` }, g.label),
          g.options.map((o) => {
            const k = i++;
            return h(
              'div.mi',
              {
                role: 'option',
                id: `slash-${k}`,
                'aria-selected': String(k === slash.index),
                class: k === slash.index ? 'active' : '',
                onmousedown: (e) => {
                  e.preventDefault();
                  pickSlash(o);
                },
              },
              h('span.grow', h('span.mono', `/${o.name}`), o.hint ? h('span.dim.mono', ` ${o.hint}`) : null, h('span.d', o.desc)),
              k === slash.index ? h('span.k', 'Enter') : null,
            );
          }),
        ),
      ),
    );
    menuBox.append(box);
    ta.setAttribute('aria-controls', 'slash-list');
    ta.setAttribute('aria-activedescendant', `slash-${slash.index}`);
    document.getElementById(`slash-${slash.index}`)?.scrollIntoView({ block: 'nearest' });
  }
  function pickSlash(o) {
    slash = null;
    paintSlash();
    if (o.run) {
      clear();
      ta.focus();
      o.run();
      return;
    }
    // An agent’s skill or command: fill /name, show its hint, and send it as that agent’s turn.
    slashTarget = { sessionId: o.se.id, handle: o.se.handle, name: o.name, argumentHint: o.hint };
    ta.value = `/${o.name} `;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    save();
    autosize();
    paint();
  }
  /** Runs a skill or command as an agent’s turn: the line is the whole prompt. */
  async function runAgentCommand(se, line) {
    try {
      await api(`/api/threads/${threadId}/agent-command`, { sessionId: se.id, text: line });
      return true;
    } catch (e) {
      toast({ title: `@${se.handle} couldn’t run ${line.split(/\s/)[0]}`, text: e.message, level: 'blocking' });
      return false;
    }
  }
  /** What a line starting with / or ! does when sent, or null to send it as a message. */
  function commandFor(text) {
    if (!commands) return null;
    if (text.startsWith('!'))
      return async () => {
        try {
          await api(`/api/threads/${threadId}/shell`, { command: text.slice(1).trim() });
          return true;
        } catch (e) {
          toast({ title: 'The command didn’t run', text: e.message, level: 'blocking' });
          return false;
        }
      };
    const r = resolved(text);
    if (!r || r.missing) return null;
    if (r.own)
      return async () => {
        POSTBOX.find(([n]) => n === r.name)?.[2](r.se ?? undefined, r.named);
        return true;
      };
    return () => runAgentCommand(r.se, r.line);
  }
  /** Which command a line runs and for whom, with `@handle /name` aimed at that agent (#405). */
  const resolved = (text) =>
    resolveCommand(text, {
      members: sessionsOf(threadId),
      reply: target(),
      pick: (name) => (slashTarget?.name === name ? sessionsOf(threadId).find((x) => x.id === slashTarget?.sessionId) : null),
      own: [...POSTBOX_NAMES],
      has: (se, name) => agentCommands(se).list.some((c) => c.name === name),
    });

  async function submit(sendNow = false) {
    const text = ta.value.trim();
    if (attachments.some((a) => a.uploading)) {
      toast({ title: 'Still uploading', text: 'Send once the files finish uploading.' });
      return;
    }
    if (!text && !attachments.length) return;
    const command = !attachments.length ? commandFor(text) : null;
    if (command) {
      if (await command()) clear();
      return;
    }
    const ok = await sendMessage(
      threadId,
      text,
      attachments.map(({ uploading, ...a }) => a),
      { sendNow },
    );
    if (ok) {
      ta.value = '';
      attachments = [];
      paintAtt();
      save();
      autosize();
    }
  }

  // @-mention autocomplete, and # for a side or topic thread of this conversation (#121)
  function updateMention() {
    const upto = ta.value.slice(0, ta.selectionStart);
    const m = upto.match(/(^|[\s(])([@#])([^\s@#()]*)$/);
    if (!m || (m[2] === '@' && !/^[A-Za-z0-9_-]*$/.test(m[3])) || (m[2] === '#' && !threadsHere().length)) {
      mention = null;
      paintMention();
      return;
    }
    const query = m[3].toLowerCase();
    mention = { kind: m[2], start: upto.length - m[3].length - 1, query, index: mention?.query === query && mention.kind === m[2] ? mention.index : 0 };
    paintMention();
  }
  /** The conversation’s side and topic threads, newest first, other than this one. */
  function threadsHere() {
    const t = thread();
    const conv = t?.kind === 'side' || t?.kind === 'topic' ? t.parentId : threadId;
    return Object.values(S().threads)
      .filter((x) => x.parentId === conv && (x.kind === 'side' || x.kind === 'topic') && x.id !== threadId && !x.deleting)
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }
  function candidates() {
    if (mention.kind === '#')
      return threadsHere()
        .filter((x) => x.title.toLowerCase().includes(mention.query))
        .slice(0, 6)
        .map((x) => ({ thread: x }));
    const members = new Set(sessionsOf(threadId).map((x) => x.personaId));
    return Object.values(S().personas)
      .filter((p) => !p.retired && p.handle.toLowerCase().startsWith(mention.query))
      .sort((a, b) => members.has(b.id) - members.has(a.id) || a.handle.localeCompare(b.handle))
      .slice(0, 6)
      .map((p) => ({ p, se: sessionsOf(threadId).find((x) => x.personaId === p.id) }));
  }
  function paintMention() {
    menuBox.replaceChildren();
    ta.removeAttribute('aria-activedescendant');
    if (!mention) {
      ta.removeAttribute('aria-controls');
      return;
    }
    const list = candidates();
    if (!list.length) return;
    mention.index = Math.min(mention.index, list.length - 1);
    const box =
      mention.kind === '#'
        ? threadMenu(list, mention, pick)
        : h(
            'div.menu.mention-menu',
            { role: 'listbox', id: 'mention-list', 'aria-label': 'Agents' },
            h('div.label', 'Wake an agent'),
            list.map(({ p, se }, i) => {
              const ring = se ? ringFor(se, 'sm') : h('pb-ring', { name: `@${p.handle}`, state: 'idle', ctx: '0', size: 'sm' });
              return h(
                'div.mi',
                {
                  role: 'option',
                  id: `mention-${i}`,
                  'aria-selected': String(i === mention.index),
                  class: i === mention.index ? 'active' : '',
                  onmousedown: (e) => {
                    e.preventDefault();
                    pick({ p });
                  },
                },
                ring,
                h(
                  'span.grow',
                  `@${p.handle}`,
                  mockMarker(se ?? p),
                  h(
                    'span.d',
                    se?.archived ? 'Archived · restore it to wake it' : se ? `Here · ${stateWord(se.state).toLowerCase()}` : 'Not here · joins when woken',
                  ),
                ),
                i === mention.index ? h('span.k', 'Enter') : null,
              );
            }),
          );
    menuBox.append(box);
    // A textarea can’t be a combobox; the active option is announced through aria-activedescendant.
    ta.setAttribute('aria-controls', 'mention-list');
    ta.setAttribute('aria-activedescendant', `mention-${mention.index}`);
  }
  function pick(c) {
    if (c.thread) insertText(`[${c.thread.title.replace(/[[\]]/g, '')}](${threadLink(c.thread.id)})`);
    else insertText(`@${c.p.handle}`);
  }
  // “Did you mean @critic?” (#134): the @ goes before the name the draft opens with, and the caret stays where it was.
  function addAt() {
    const at = ta.selectionStart + (ta.selectionStart >= /^\s*/.exec(ta.value)[0].length ? 1 : 0);
    ta.value = ta.value.replace(/^(\s*)/, '$1@');
    ta.focus();
    ta.setSelectionRange(at, at);
    save();
    paint();
  }
  function insertText(text) {
    const before = ta.value.slice(0, mention.start);
    const after = ta.value.slice(ta.selectionStart);
    ta.value = `${before}${text} ${after}`;
    const pos = before.length + text.length + 1;
    ta.setSelectionRange(pos, pos);
    mention = null;
    paintMention();
    save();
    ta.focus();
  }

  ta.addEventListener('input', () => {
    autosize();
    save();
    updateMention();
    updateSlash();
    // The hint line follows what the line will do: a picked skill, a ! command, or a message, and whom it reaches.
    if (slashTarget && !ta.value.startsWith(`/${slashTarget.name}`)) slashTarget = null;
    const to = hint.dataset.to !== addressSig(threadId, ta.value);
    if (to || ta.value.startsWith('!') || hint.dataset.mode || (commands && /^(@\S+\s+)?\//.test(ta.value))) paint();
    // Said once, when it appears, since the hint isn’t read as you type.
    if (to && hint.querySelector('.did-you-mean')) say(`${hint.querySelector('.did-you-mean').textContent} Its button follows the message box.`);
  });
  ta.addEventListener('click', () => {
    updateMention();
    updateSlash();
  });
  ta.addEventListener('blur', () =>
    setTimeout(() => {
      // The menus stay when focus came straight back (the window lost it and got it back).
      if (document.activeElement === ta) return;
      mention = null;
      paintMention();
      if (slash) {
        slash = null;
        paintSlash();
      }
    }, 120),
  );
  ta.addEventListener('keydown', (e) => {
    if (slash && !mention) {
      const n = flatOptions().length;
      if (n && e.key === 'ArrowDown') {
        e.preventDefault();
        slash.index = (slash.index + 1) % n;
        paintSlash();
        return;
      }
      if (n && e.key === 'ArrowUp') {
        e.preventDefault();
        slash.index = (slash.index - 1 + n) % n;
        paintSlash();
        return;
      }
      if (n && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
        e.preventDefault();
        pickSlash(flatOptions()[slash.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        slash = null;
        paintSlash();
        return;
      }
    }
    if (mention && candidates().length) {
      const n = candidates().length;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        mention.index = (mention.index + 1) % n;
        paintMention();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        mention.index = (mention.index - 1 + n) % n;
        paintMention();
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(candidates()[mention.index]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        mention = null;
        paintMention();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  ta.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (files.length) {
      e.preventDefault();
      addFiles(files.map((f, i) => (f.name ? f : new File([f], `Pasted image ${i + 1}.png`, { type: f.type }))));
    } else if (text.length > 2000) {
      e.preventDefault();
      addFiles([new File([text], 'Pasted text.txt', { type: 'text/plain' })]);
      say('Long pasted text was attached as a file.');
    }
  });

  const el = h(
    'div.composer',
    h('div.col', status, asks, queue, menuBox, att, h('div.composer-box', plus, commandsButton, ta, action), hint, file, corpusFile),
  );

  // Drop files: the main composer takes drops anywhere in the window. A side or topic composer takes drops on
  // its own panel (see dropZone below), and stops them there so the main composer doesn’t take them too.
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    if (side) e.stopPropagation();
    addFiles([...e.dataTransfer.files]);
  };
  const onDragOver = (e) => {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    if (side) e.stopPropagation();
  };
  /** @type {EventTarget} */
  let zone = side ? el : window;
  const listen = () => {
    zone.addEventListener('drop', onDrop);
    zone.addEventListener('dragover', onDragOver);
  };
  const unlisten = () => {
    zone.removeEventListener('drop', onDrop);
    zone.removeEventListener('dragover', onDragOver);
  };
  listen();

  function paint() {
    const t = thread();
    if (!t) return;
    const b = busyOne();
    action.replaceChildren();
    action.className = b ? 'btn stop' : 'btn send';
    action.textContent = b ? 'Stop' : 'Send';
    action.onclick = b
      ? () =>
          stopSession(b)
            .then((r) => (r?.ask ? askStop(b, r.ask) : say(`Stopped @${b.handle}.`)))
            .catch((e) => toast({ title: 'Couldn’t stop', text: e.message }))
      : () => submit();
    action.setAttribute('aria-label', b ? `Stop @${b.handle}’s reply` : 'Send');
    const note = describeStop(action, b, threadId);
    const last = S().sessions[t.lastSpeaker];
    const members = sessionsOf(threadId).filter((x) => !x.archived);
    // Every agent here is archived: the conversation is read-only until you restore one.
    const archived = !topic && !side && !members.length ? sessionsOf(threadId) : [];
    ta.disabled = archived.length > 0;
    action.disabled = archived.length > 0;
    ta.placeholder = topic
      ? 'Reply in thread'
      : side
        ? 'Join this side thread…'
        : `${members.length > 1 ? 'Reply to' : 'Message'} @${(last ?? members[0])?.handle ?? 'an agent'}`;
    syncList(
      queue,
      t.queue ?? [],
      (q) => q.id,
      (q) => asWake(queuedRow(q, threadId, paint), q),
      (node, q) => {
        if (node.dataset.editing) return; // keep an inline edit open while the agent works
        const fresh = asWake(queuedRow(q, threadId, paint), q);
        node.replaceChildren(...fresh.childNodes);
      },
    );
    // An ask about a turn that has since ended goes with it.
    for (const id of [...asked.keys()]) if (!busy(S().sessions[id])) asked.delete(id);
    syncList(
      asks,
      sessionsOf(threadId).filter((se) => busy(se) && (se.stopAsk || asked.has(se.id))),
      (se) => se.id,
      (se) => stopAskRow(se),
    );
    for (const m of outbox.filter((x) => x.threadId === threadId))
      queue.append(h('div.queued', icon('clock', 'dim'), h('span.q-text', h('span.small.dim', 'Waiting for the connection'), h('br'), m.text)));
    const offline = client.connection !== 'open';
    fill(
      status,
      archived.length
        ? h(
            'div.sys',
            { style: { marginBottom: '6px' } },
            h(
              'span.pill',
              { role: 'status' },
              `Archived: read-only. `,
              // Its agents are archived with it, and come back with it (#320).
              h(
                'button.btn.sm',
                {
                  type: 'button',
                  onclick: () => api(`/api/threads/${threadId}/restore`, {}).catch((e) => toast({ title: 'Couldn’t restore', text: e.message })),
                },
                'Restore conversation',
              ),
            ),
          )
        : offline
          ? h(
              'div.sys',
              { style: { marginBottom: '6px' } },
              h(
                'span.pill',
                { role: 'status', style: { borderColor: 'var(--accent)' } },
                h('span.g.g-running', { 'aria-hidden': 'true' }),
                h('b', 'Reconnecting…'),
                ` attempt ${client.attempts} · nothing is lost; replies pick up where they stopped`,
              ),
            )
          : stopNoteEl(note, threadId),
    );
    // What Enter will do with a / or ! line (#67).
    const line = ta.value.trimStart();
    // ! outside a conversation’s own composer would go to the agent as plain text: say so before it’s sent (#104).
    const mode = offline
      ? ''
      : !commands
        ? line.startsWith('!')
          ? 'no-shell'
          : ''
        : line.startsWith('!')
          ? 'shell'
          : slashTarget && line.startsWith(`/${slashTarget.name}`)
            ? 'skill'
            : resolved(line)?.named || resolved(line)?.missing
              ? 'command'
              : '';
    if (mode) hint.dataset.mode = mode;
    else delete hint.dataset.mode;
    hint.dataset.to = addressSig(threadId, ta.value);
    const folder = mode === 'shell' ? commandFolder() : null;
    const here = mode === 'shell' ? notOnHost(target()) : null;
    // A repaint while you’re on “Did you mean” keeps you there (#134).
    const onFix = !!document.activeElement?.closest('.did-you-mean') && hint.contains(document.activeElement);
    fill(
      hint,
      mode === 'shell'
        ? h(
            'span',
            folder
              ? ['Runs in ', h('span.mono', folder), here, ' as you, with Enter. ']
              : target() && !isMock(target())
                ? ['Runs in ', h('b', `@${target().handle}`), '’s own workspace', here ?? ',', ' as you, with Enter. ']
                : 'This conversation has no folder to run commands in. ',
            'The agents read it and its output on their next turn.',
          )
        : mode === 'no-shell'
          ? h(
              'span',
              h('b', '! runs commands only in the conversation’s own composer.'),
              ` Here, this goes to ${topic ? 'the agent' : 'the agents'} as a message. To run it, send it from the conversation.`,
            )
          : mode === 'command' || mode === 'skill'
            ? commandHint(mode === 'skill' ? { name: slashTarget.name, hint: slashTarget.argumentHint, named: slashTarget } : resolved(line), threadId)
            : offline
              ? h('span', 'You’re offline. Messages you send now go out when the connection is back.')
              : [
                  // Who it reaches, in a room and in a topic or side thread too, and the @ a name may lack (#134).
                  addressLine(threadId, ta.value, { room: topic || side || members.length > 1, addAt }),
                  topic
                    ? h('span', 'Replies stay here · @ brings in another agent')
                    : side
                      ? h('span', 'Sending adds you to this side thread')
                      : [
                          h('span', 'Enter to send · Shift+Enter for a new line'),
                          h('span.hide-sm', '@ to wake an agent · / for commands · ! to run a command · + to add a file or an agent'),
                        ],
                ],
    );
    if (onFix) hint.querySelector('.did-you-mean')?.focus();
  }
  /**
   * Where `!` runs, as far as the page knows: the folder of the agent that replies here, else the project’s. A Claude
   * Code or Agent SDK agent with neither works in a workspace of its own, which the server finds (its adapter’s folderFor).
   */
  function commandFolder() {
    const se = target();
    const p = se ? S().personas[se.personaId] : null;
    // An agent on a host works in a folder there, so ! runs in the project’s folder here (runtime.mjs, commandFolder).
    if (hostOf(se)) return S().projects[thread()?.projectId]?.folder || null;
    return se?.personaSnapshot?.folder || p?.folder || S().projects[thread()?.projectId]?.folder || null;
  }
  /** Stop found background jobs running: the ask shows above the composer, and its first choice takes focus. */
  function askStop(se, ask) {
    asked.set(se.id, ask);
    paint();
    asks.querySelector(`[data-key="${se.id}"] button`)?.focus();
  }
  /**
   * “@developer has 1 background job running. Stop it too?” A choice you make there and then, so it’s a quiet row, not
   * a card: Stop it too, Keep running (the agent stops, its jobs run on), or Escape and the agent carries on.
   */
  function stopAskRow(se) {
    const ask = se.stopAsk ?? asked.get(se.id);
    const one = (ask?.jobs ?? 1) === 1;
    const done = () => {
      asked.delete(se.id);
      paint();
      (action.isConnected ? action : ta).focus();
    };
    const choose = (jobs) => {
      asked.delete(se.id);
      stopSession(se, jobs, ask?.turnId ?? null)
        .then((r) =>
          say(
            r?.ended
              ? `@${se.handle}’s reply had already ended.`
              : jobs === 'keep'
                ? `Stopped @${se.handle}. ${one ? 'Its background job keeps' : 'Its background jobs keep'} running.`
                : `Stopped @${se.handle} and ${one ? 'its background job' : 'its background jobs'}.`,
          ),
        )
        .catch((e) => toast({ title: `Couldn’t stop @${se.handle}`, text: e.message, level: 'blocking' }))
        .finally(done);
    };
    const dismiss = () => {
      api(`/api/sessions/${se.id}/stop-ask`, undefined, 'DELETE').catch(() => {});
      done();
    };
    return h(
      'div.queued.stop-ask',
      {
        role: 'group',
        'aria-label': `Stop @${se.handle}`,
        onkeydown: (e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        },
      },
      h('span.q-text', ask?.text ?? `@${se.handle} has background jobs running. Stop them too?`),
      h('button.btn.sm.send', { type: 'button', onclick: () => choose('stop') }, one ? 'Stop it too' : 'Stop them too'),
      h('button.btn.sm', { type: 'button', onclick: () => choose('keep') }, 'Keep running'),
      h('button.btn.sm.ghost', { type: 'button', 'aria-label': `Don’t stop @${se.handle}`, onclick: dismiss }, icon('x', 'i-sm')),
    );
  }
  paint();
  autosize();
  const off = client.on((ch) => {
    if (['thread', 'session', 'connection', 'outbox', 'load', 'persona', 'host'].includes(ch.type)) paint();
  });
  return {
    el,
    focus: () => ta.focus(),
    /** A side or topic composer: take drops on this element (its whole panel) instead of on the composer alone. */
    dropZone(target) {
      if (!side) return;
      unlisten();
      zone = target;
      listen();
    },
    destroy() {
      off();
      unlisten();
    },
  };
}

export const _test = { renderItem, activityLabel };
