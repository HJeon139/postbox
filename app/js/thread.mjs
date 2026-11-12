// The conversation view: transcript, composer, and the panel beside it for topic threads (yours, forked from a
// message) and side threads (between agents).

import { renderMarkdown } from '/shared/markdown.mjs';
import { resolveCommand } from '/shared/slash-line.mjs';
import { laterParts, liveStale } from './activity-live.mjs';
import { activityParts, paintActivity, stepsOnly } from './activity-paint.mjs';
import { activityLabel } from './activity-steps.mjs';
import { mockMarker } from './agent-facts.mjs';
import { agentMarkdown, handles, markTerms, paintAgentMarkdown, usesTerm } from './agent-markdown.mjs';
import { paintOfflineQueue, paintWaitingLine } from './agent-queue.mjs';
import { subagentNow } from './agents.mjs';
import { allowedCallLine } from './allowed-call.mjs';
import { enhanceMarkdown, releaseApps, renderAppItem, renderAppSendCard } from './apps.mjs';
import { attChip, fileSize } from './attachment-chip.mjs';
import { renderBlock } from './blocks.mjs';
import { api, busy, client, hrefOf, itemsOf, placeIn, sessionsAt, sessionsOf, sideSessionsOf, stopSession, threadLink, uploadFile } from './client.mjs';
import { describeStop, notOnHost, stopNoteEl } from './composer-host.mjs';
import { fitDraft } from './composer-size.mjs';
import { addressLine, addressSig, commandHint, placeholderFor } from './composer-to.mjs';
import { $, ago, dayOf, fill, h, icon, plural, syncList, timeOf, trusted } from './dom.mjs';
import { draftAttachments } from './draft-attachments.mjs';
import { failedCallout } from './failed-actions.mjs';
import { goToItem } from './go-to-item.mjs';
import { focusComposer, hopBlock } from './hop-card.mjs';
import { beyondItem } from './item-ranges.mjs';
import { closeThread, grow, loaded, more, openThread, refresh, toFirst, toLast } from './open-threads.mjs';
import { focusUntouched } from './pane-focus.mjs';
import { denialBlock, permissionBlock, toolAskBlock } from './permission-cards.mjs';
import { openPermissions } from './permissions.mjs';
import { reactTo } from './reactions.mjs';
import { hostOf } from './remote.mjs';
import { replyLine } from './reply-rings.mjs';
import { stoppedSaid, stoppedTag } from './reply-stop.mjs';
import { holdFocus, replaceTranscriptItem } from './rerender-state.mjs';
import { ringFor, stateWord } from './ring.mjs';
import { boilerplateDesc, confirmDelete, openAttachSession, openFolderPicker, openNewAgent, openRename, openSettings } from './sheets.mjs';
import { sideActive, sideLine, sideSig } from './side-line.mjs';
import { namesSpeaker } from './speaker-line.mjs';
import { systemLine } from './system-line.mjs';
import { failedOnHost, hostChanged, hostEnd, hostTurnsList, ranHere, remoteSig } from './thread-host.mjs';
import { threadMenu } from './thread-menu.mjs';
import { announceStreaming, navigate, openMenu, say, toast } from './ui.mjs';
import { viewAskBlock } from './view-ask-card.mjs';
import { mountView } from './view-state.mjs';
import { welcome } from './welcome.mjs';
import { createWindow } from './window.mjs';
import { windowOn } from './window-flag.mjs';
import { focusedItem, keepFocused } from './window-keep.mjs';
import { replaced as replacedNode } from './window-shrink.mjs';
import { workList } from './work-list.mjs';

export { focusComposer } from './hop-card.mjs';

const S = () => client.state;
// What woke the turn (#135): “woken by @critic”, “after @researcher replied in a side thread”, or its scheduled wake.
/** Where a shell line runs when the conversation has no folder: the agent’s own workspace, unless it’s a mock. */
const workspaceLine = (se, here) =>
  se ? ['Runs in ', h('b', se.handle), '’s own workspace', here ?? ',', ' as you, with Enter. '] : 'This conversation has no folder to run commands in. ';

function wokeText({ by, reply, in: at, scheduled }) {
  if (scheduled) return 'woken by a scheduled wake';
  if (!reply) return `woken by ${by}`;
  return `after ${by} replied${{ side: ' in a side thread', topic: ' in a thread' }[S().threads[at]?.kind] ?? ''}`;
}

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
    // A running turn’s steps fit its share of the screen, which changes as agents start and finish (activity-live.mjs).
    for (const it of shown()) if (liveStale(nodes.get(it.id), it, threadId)) rerender(it.id);
  };
  // Above them, a turn on a host Postbox asked to stop and the host hasn’t confirmed it stopped (#120).
  const hostTurns = hostTurnsList(threadId);

  const appSig = (app) => JSON.stringify([app.current, app.versions?.length, app.check?.status, app.check?.problems?.length ?? 0, app.retired?.at ?? null]);
  /** The id of the app a block draws: an app’s own, or an app review’s (#857). */
  const drawnApp = (it) => {
    if (it.kind !== 'block' || !it.valid) return null;
    if (it.block.type === 'app') return it.block.id;
    if (it.block.type === 'review' && it.block.format === 'app') return it.block.appId;
    return null;
  };
  const render = (it, prev) => {
    const ctx = { threadId, kind: S().threads[threadId]?.kind, rerender: () => rerender(it.id) };
    const node = renderItem(it, prev, ctx);
    messageActions(node, it, ctx);
    node.dataset.key = it.id;
    const drawn = S().apps[drawnApp(it)];
    if (drawn) node.dataset.appSig = appSig(drawn);
    if (it.kind === 'agent') node.dataset.remoteSig = remoteSig(it);
    node.classList.add('item');
    if (!node.hasAttribute('tabindex')) node.tabIndex = -1;
    return node;
  };
  const rerender = (id) => {
    const list = itemsOf(threadId);
    const i = placeIn(threadId, id);
    // An item outside the window isn’t on the page; it draws from the state when it’s mounted.
    if (i < 0 || (win && !nodes.has(id))) return;
    const old = nodes.get(id);
    // Keep focus, and the caret, inside a block that’s being edited.
    const back = holdFocus();
    const n = render(list[i], list[i - 1]);
    replaceTranscriptItem(old, n, view);
    nodes.set(id, n);
    if (old && win) replacedNode(win, old, n);
    back();
  };
  const mountAt = (/** @type {any[]} */ list, /** @type {number} */ i) => {
    const n = render(list[i], list[i - 1]);
    nodes.set(list[i].id, n);
    return n;
  };
  const appendNew = (/** @type {any[]} */ list, /** @type {number} */ i) => {
    const n = el.appendChild(mountAt(list, i));
    win?.observe(n);
  };
  /** @type {ReturnType<typeof createWindow>} */
  let win = null;
  /** The items on the page: with a window, only the mounted ones; the rest draw from the state when they mount. */
  const shown = () => {
    const list = itemsOf(threadId);
    if (!win) return list;
    return [...nodes.keys()].map((id) => list[placeIn(threadId, id)]).filter(Boolean);
  };
  const all = (/** @type {string | null} */ anchorKey = was?.anchor?.key ?? null, /** @type {any} */ kept = null) => {
    el.replaceChildren();
    nodes.clear();
    win?.destroy();
    const list = itemsOf(threadId);
    // Until its items are loaded (open-threads.mjs, #1155), a conversation shows nothing rather than its welcome.
    if (!list.length && !inPanel && loaded(threadId)) {
      el.append(welcome(threadId, sendMessage));
      return;
    }
    // A long conversation mounts only what’s around you, behind its flag (window.mjs, #866); else every item. One with
    // more on the server than is loaded has a window too, which loads the next range at its edges.
    const edges = {
      more: (/** @type {'before' | 'after'} */ side) => more(threadId, side),
      grow: (/** @type {'before' | 'after'} */ side) => grow(threadId, side),
      edge: (/** @type {'before' | 'after'} */ side) => (side === 'before' ? toFirst(threadId) : toLast(threadId)),
    };
    win = createWindow({ el, key: `${inPanel}:${threadId}`, list, anchorKey, inPanel, nodes, edges, mount: (i) => mountAt(list, i) });
    // The item that had focus goes back in, in its range or as an island (window-keep.mjs).
    if (win) {
      win.build();
      keepFocused(win, kept);
    } else for (let i = 0; i < list.length; i++) el.append(mountAt(list, i));
    hostTurns.paint();
    paintWorking();
  };
  openThread(threadId);
  all();
  const view = mountView({ el, inPanel, nodes, was });

  const off = client.on((ch) => {
    // A resync that couldn’t load this conversation’s items loads them now, and with the window turned off, all of them.
    const partial = more(threadId, 'before') || more(threadId, 'after');
    if (ch.type === 'load' && (!loaded(threadId) || (!windowOn() && partial))) void refresh(threadId);
    if (ch.type === 'load' || (ch.type === 'range' && ch.data.threadId === threadId)) {
      const back = holdFocus();
      // Rebuilt around where you are now, or the item the range was loaded to go to (Home), with the item that has focus.
      all(ch.data?.anchor ?? view.keep()?.anchor?.key ?? null, focusedItem(el));
      // Placed short of the newest item to go to one, the view holds it rather than following the end.
      view.rebuilt(more(threadId, 'after') ? (ch.data?.anchor ?? null) : null);
      back();
      return;
    }
    const d = ch.data;
    if (ch.type === 'item.add' && d.threadId === threadId) {
      if (nodes.size === 0) el.replaceChildren();
      // A new message takes the place of any height held below the last one.
      view.release();
      const list = itemsOf(threadId);
      if (!win || win.added(d.item)) appendNew(list, list.length - 1);
      paintWorking();
      view.grew();
    } else if (ch.type === 'item.beyond' && d.threadId === threadId) {
      // Added past what’s loaded, while you read higher up (item-ranges.mjs): it counts on the pill.
      view.grew();
    } else if (ch.type === 'item.move' && d.threadId === threadId) {
      // An update brought an app or a block to the newest point (#49, #92). Its stub takes its old place, the same
      // height a line takes, and what you were reading stays put: if that was the item, the stub holds its place.
      const list = itemsOf(threadId);
      const at = placeIn(threadId, d.stub.id);
      const back = holdFocus();
      if (!win || nodes.has(d.id)) {
        const stub = render(d.stub, list[at - 1]);
        nodes.get(d.id)?.replaceWith(stub);
        nodes.set(d.stub.id, stub);
      }
      nodes.delete(d.id);
      view.moved(d.id, d.stub.id);
      // The message after it now follows the stub, so whether it names its speaker can change.
      if (list[at + 1] && list[at + 1].id !== d.id) rerender(list[at + 1].id);
      view.release();
      // Moved past what's loaded, while you read higher up (item-ranges.mjs): its stub alone; it counts on the pill.
      if (d.past) win?.restub(d.stub, d.id);
      else if (!win || win.moved(d.stub, list[list.length - 1])) appendNew(list, list.length - 1);
      back();
      paintWorking();
      view.grew();
    } else if (ch.type === 'item.patch' && d.threadId === threadId) {
      // A step changes only the reply’s activity list (#573); anything else draws the reply again.
      const it = stepsOnly(d) ? itemsOf(threadId)[placeIn(threadId, d.id)] : null;
      if (!d.reaction && !(it && paintActivity(nodes.get(d.id), it, threadId))) rerender(d.id);
      for (const id of laterParts(d, threadId, shown())) rerender(id);
    } else if (ch.type === 'item.text' && d.threadId === threadId) {
      pending.add(d.id);
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          for (const id of pending) updateText(id);
          pending.clear();
        });
    } else if (ch.type === 'glossary' && (d.threadId === threadId || d.threadId === S().threads[threadId]?.parentId)) {
      for (const it of shown()) if (it.kind === 'agent' && usesTerm(it, d.entry, nodes.get(it.id))) updateText(it.id, true);
    } else if (ch.type === 'session') {
      // An agent at work here may not be one of this thread’s own (#110): its turn is in it.
      paintWorking();
      for (const it of shown()) if (it.kind === 'sidelink' && nodes.get(it.id)?.dataset.sideSig !== sideSig(sideActive(it.sideThreadId))) rerender(it.id);
    } else if (ch.type === 'app') {
      // Only what changes the frame re-renders it, for an app and an app review alike: a new version, a version picked,
      // the check’s result, or retiring (#193). A review shown while its app was being checked draws the result (#857),
      // and keeps its draft, which lives outside the node. Saved state never re-renders: the running app already has it,
      // and reloading would make it save again.
      const sig = appSig(d);
      // Over the mounted items only (#866, W3): an item off the page draws from the state when it mounts.
      for (const it of shown()) {
        if (drawnApp(it) !== d.id || nodes.get(it.id)?.dataset.appSig === sig) continue;
        rerender(it.id);
        const fresh = nodes.get(it.id);
        if (fresh) fresh.dataset.appSig = sig;
      }
    }
    hostChanged(ch, threadId, nodes, rerender, hostTurns);
  });

  const updateText = (id, force = false) => {
    // undefined when it's gone, as find() gave; one past what's loaded is kept apart (item-ranges.mjs, keepBeyond)
    const it = itemsOf(threadId)[placeIn(threadId, id)] ?? beyondItem(client.ranges.get(threadId), threadId, id);
    const node = nodes.get(id);
    if (!it) return;
    // A reply the window hasn’t mounted, while you read higher up, is still heard as it streams (#866).
    if (!node) {
      if (!force) announceStreaming(it.id, it.text, it.status !== 'streaming', it.handle);
      return;
    }
    const box = node.querySelector(':scope > .md');
    if (!box) {
      rerender(id);
      return;
    }
    paintAgentMarkdown(box, it, threadId);
    if (it.status !== 'streaming') enhanceMarkdown(box);
    if (!force) announceStreaming(it.id, it.text, it.status !== 'streaming', it.handle);
  };

  return {
    el,
    settle: view.settle,
    /**
     * To the end. If the window has moved away from the newest item (#866), it’s mounted first, and the view goes there
     * at once: a smooth scroll would cross a blank spacer. @param {boolean} [smooth]
     */
    scrollToEnd: (smooth) => {
      // Holding an older range than the newest (a jump far up), the latest goes in first (kept since Home, or loaded).
      if (more(threadId, 'after')) return void toLast(threadId).then(() => view.scrollToEnd(false));
      const last = itemsOf(threadId).at(-1);
      const away = !!win && !!last && win.to < win.total;
      if (away) win?.reach(last.id);
      return view.scrollToEnd(smooth && !away);
    },
    setJump: view.setJump,
    destroy() {
      off();
      closeThread(threadId);
      win?.destroy();
      const where = view.keep();
      view.destroy();
      // Once its elements have left the page, its apps are let go (#930). Every view with apps, the side panel’s and
      // the pane’s too, destroys its transcript, so this one call covers them all.
      queueMicrotask(releaseApps);
      if (where) {
        const key = `${inPanel}:${threadId}`;
        kept.set(key, where);
        queueMicrotask(() => kept.delete(key));
      }
    },
  };
}

function fillWorkRow(row, se) {
  ringFor(se, 'xs', row.querySelector('pb-ring'));
  const step = se.state === 'tool' && se.currentStep ? `: ${se.currentStep}` : '';
  fill(
    row.querySelector('.work-text'),
    h('div.work-line', h('b', se.handle), h('span.dim', ` · ${stateWord(se.state).toLowerCase()}${step}`)),
    se.glimpse ? h('div.glimpse', se.glimpse) : null,
    // Each subagent at work, in its own words when it has said something (#73): “reader: Now I’ll read paper 3…”.
    (se.subagents ?? []).map((x) => h('div.work-line.work-sub', h('span', `${x.name}: `), h('span.dim', subagentNow(x)))),
  );
}

const who = (it, { you = false, threadId = '' } = {}) => {
  const se = S().sessions[it.sessionId];
  const ts = h('span.ts', { title: `${dayOf(it.at)} ${timeOf(it.at)}` }, timeOf(it.at));
  // A turn typed into Claude Code in a terminal, mirrored here, says so.
  const via = it.via === 'terminal' ? h('span.via', 'from terminal') : null;
  if (you) return h('div.who', ts, h('b', 'You'), via);
  const { ring, word } = se ? replyLine(it, se, threadId) : { ring: h('pb-ring', { name: it.handle, state: 'idle', ctx: '0', size: 'xs' }), word: null };
  const woke = it.woke ? h('span.woke', wokeText(it.woke)) : null;
  return h('div.who', ring, h('b', it.handle), mockMarker(se), word, it.deletedAgent ? h('span.deleted', '(deleted)') : null, via, woke, ts);
};

// Under a message in a conversation: “Reply in thread”, or once a thread exists, “3 replies”. Under a message in a
// topic or side thread (#128): “Send to conversation”. React, under every one (#251), on the left (#378). They appear on hover and focus, and always on touch.
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
                  // Focus goes to the thread’s composer only if the person hasn’t moved it meanwhile (#887).
                  setTimeout(() => {
                    if (focusUntouched(it.id)) $('#side-input')?.focus();
                  }, 150);
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
  const showWho = namesSpeaker(it, prev);
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
      const node = h(
        'div.col.turn',
        showWho ? who(it, ctx) : null,
        ...activityParts(it, ctx.threadId),
        it.text || it.status === 'streaming' ? h('div.md') : null,
        // What the turn changed, ran and published, under its last reply (#132, #195), leading to Work.
        it.work ? workChip(it, ctx) : null,
        hostEnd(it),
        it.status === 'stopped' && !it.note ? stoppedTag(it) : null,
        it.status === 'failed' && !failedOnHost(it) ? failedCallout(ctx.threadId, it, failureText(it.error)) : null,
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
        paintAgentMarkdown(box, it, ctx.threadId);
        if (it.status !== 'streaming') queueMicrotask(() => enhanceMarkdown(box));
      }
      return node;
    }
    case 'block': {
      if (it.valid && it.block.type === 'app') {
        // Named like any other block (#88). Only the agent that wrote an app can update it, so this is also who
        // made each version.
        return h('div.wide', showWho ? h('div.col', who(it, ctx)) : null, renderAppItem(it, ctx), it.work ? workChip(it, ctx) : null);
      }
      // revision: the one the person answered (#123); a card’s or table’s action doesn’t say.
      const act = async (action, values, revision) => {
        const r = await api(`/api/threads/${ctx.threadId}/items/${it.id}/act`, { action, values, revision });
        focusComposer();
        return r;
      };
      return h('div.col.turn', showWho ? who(it, ctx) : null, renderBlock(it, { act, threadId: ctx.threadId }), it.work ? workChip(it, ctx) : null);
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
              ` · ${it.agent ? `shared by ${it.handle} in a turn you started` : it.handle || 'you'}`,
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
    case 'viewask':
      return viewAskBlock(it, ctx);
    case 'allowedcall':
      return allowedCallLine(it, ctx);
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

/**
 * Where an app or a block was before an update brought it to the newest point (#49, #92): one line that leads to it.
 * There’s one live copy, below; this only says it moved.
 */
function movedLine(it, ctx) {
  const live = placeIn(ctx.threadId, it.itemId) >= 0;
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
            onclick: (e) => goToItem(e, it.itemId),
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
    showWho ? who(it, ctx) : null,
    h(
      'div.block',
      { role: 'group', class: open ? '' : 'answered', style: open ? { borderColor: 'var(--accent)' } : {} },
      h('div.block-head', icon('spark'), h('span.title.grow', `New teammate: ${p.handle}`), h('span.kind', `Proposed by ${it.handle}`)),
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
                  `${it.extraTools.join(', ')} ${it.extraTools.length === 1 ? 'is' : 'are'} more than ${it.handle} has. Creating ${p.handle} grants ${it.extraTools.length === 1 ? 'it' : 'them'}.`,
                )
              : null,
          ),
          h('dt', 'Joins'),
          h('dd', `This ${ctx.kind === 'topic' ? 'topic thread' : ctx.kind === 'side' ? 'side thread' : 'conversation'}, with the recent messages as context`),
        ),
        !open ? h('span.answered-note', icon('check', 'i-sm'), it.status === 'created' ? `Created ${p.handle}` : 'Dismissed') : null,
      ),
      open
        ? h(
            'div.block-foot',
            h('button.btn', { type: 'button', onclick: () => act('create') }, `Create ${p.handle}`),
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
// A fresh connection is when a send is likeliest to work, so it starts the tries again from the quick ones.
client.on((ch) => {
  if (ch.type === 'connection' && client.connection === 'open') sendOutboxNow({ fresh: true });
});

// A send can fail while the stream stays open: Firefox doesn’t retry a POST on a keep-alive connection the server
// has closed, and no reconnect follows to send the outbox (#1126). So, while the stream is open and the browser
// online, it’s sent again: quickly a few times, then every 30 s, on its own, since sending it needs nothing from the
// person. Offline, it waits for the connection, which sends it when it’s back.
const RETRY_MS = [1000, 2000, 4000, 8000];
const SLOW_RETRY_MS = 30_000;
let retryTimer = 0;
let retries = 0;
function retrySoon() {
  if (retryTimer || client.connection !== 'open' || navigator.onLine === false) return;
  const delay = RETRY_MS[retries] ?? SLOW_RETRY_MS;
  retries++;
  retryTimer = window.setTimeout(() => {
    retryTimer = 0;
    flushOutbox();
  }, delay);
}

export async function sendMessage(threadId, text, attachments = [], { sendNow = false } = {}) {
  try {
    const r = await api(`/api/threads/${threadId}/messages`, { text, attachments, sendNow });
    if (r.queued) say('Queued. It sends when the agent finishes.');
    retries = 0;
    return true;
  } catch (e) {
    if (e.offline) {
      outbox.push({ threadId, text, attachments });
      saveOutbox();
      retrySoon(); // first, so the repaint knows which try comes next
      client.emit({ type: 'outbox' });
      return true;
    }
    toast({ title: 'Your message didn’t send', text: e.message, level: 'blocking' });
    return false;
  }
}

/** What the outbox waits on: the connection, a quick try, or the slow tries, past the quick ones. */
function outboxWait() {
  if (client.connection !== 'open' || navigator.onLine === false) return 'connection';
  return retries > RETRY_MS.length ? 'slow' : 'soon';
}
/**
 * Sends the outbox now, in place of the pending try: Send now, past the quick tries, or a connection that opened,
 * which also counts the tries from the first (`fresh`).
 */
function sendOutboxNow({ fresh = false } = {}) {
  window.clearTimeout(retryTimer);
  retryTimer = 0;
  if (fresh) retries = 0;
  flushOutbox();
}

export function flushOutbox() {
  const items = outbox.splice(0);
  saveOutbox();
  for (const m of items) void sendMessage(m.threadId, m.text, m.attachments);
  if (items.length) client.emit({ type: 'outbox' });
}

export function mountComposer(threadId, { side = false } = {}) {
  const topic = S().threads[threadId]?.kind === 'topic';
  // / and ! (#67) live in a conversation’s own composer, not in a thread panel’s.
  const commands = !side && !topic;
  const key = `pb-draft-${threadId}`;
  // The draft’s files are kept with its text (#849): the list is the thread’s, shared by each composer mounted for it.
  const draft = draftAttachments(threadId);
  const attachments = draft.list();
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
  const waiting = h('div.queue-waiting-box');
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
      void addFiles([...file.files]);
      file.value = '';
    },
  });

  const autosize = () => fitDraft(ta);
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
      draft.add(chip);
      try {
        // The name the upload kept (#991): a character that would hide or reorder it is “_” there.
        const { id, name, size, type } = await uploadFile(f);
        draft.update(chip, { fileId: id, name, size, type, uploading: false });
      } catch (e) {
        draft.remove(chip);
        toast({ title: `Couldn’t attach ${f.name}`, text: e.message, level: 'blocking' });
      }
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
              onclick: () => draft.remove(a),
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
              draft.add({ kind: 'project-file', path });
              focusComposer();
            }),
        },
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
                desc: `${last.handle} drafts a teammate for this conversation`,
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
    // Its settings are edited in one place, its sheet.
    ['mode', 'Its permission mode, in its persona’s settings', (se = target()) => se && openSettings('personas', se.personaId)],
    ['model', 'Its model, in its persona’s settings', (se = target()) => se && openSettings('personas', se.personaId)],
    ['effort', 'Its effort, in its persona’s settings', (se = target()) => se && openSettings('personas', se.personaId)],
    ['add-dir', 'Let it work in another folder', (se) => addDir(se)],
    ['mcp', 'Its MCP servers: status, on or off', (se = target()) => openPermissions({ threadId, sessionId: se?.id, focus: 'mcp' })],
    ['compact', 'Summarize its context to make room', (se) => compact(se)],
    ['stop', 'Stop the agents that are working', (_se, named) => stopAll(named)],
    ['delete', 'Delete its session in this conversation', (se = target()) => se && confirmDelete(se)],
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
          .then((r) => toast({ title: `${se.handle} may work in ${r.path}`, text: 'From its next turn.' }))
          .catch((e) => toast({ title: 'Couldn’t add the folder', text: e.message, level: 'blocking' })),
      { folders: true },
    );
  }
  function compact(se = target()) {
    if (!se) return;
    if (isMock(se)) return toast({ title: 'Nothing to compact', text: `${se.handle} is a mock agent.` });
    void runAgentCommand(se, '/compact');
  }
  function stopAll(only = null) {
    // In a conversation, Stop reaches its side threads too (#121), but not a turn in a topic thread: it has its own (#228).
    // only: the agent `@handle /stop` names (#405).
    const t = thread();
    const go = (se) => (!only || se.id === only.id) && busy(se) && !(t?.kind !== 'topic' && S().threads[se.sideTurn?.threadId]?.kind === 'topic');
    const working = (t?.kind === 'side' || t?.kind === 'topic' ? sessionsAt(threadId) : [...sessionsOf(threadId), ...sideSessionsOf(threadId)]).filter(go);
    if (!working.length) return say(only ? `${only.handle} isn’t working.` : 'Nothing is running here.');
    for (const se of working)
      stopSession(se).then(
        (r) => (r?.ask ? askStop(se, r.ask) : say(`Stopped ${se.handle}.`)),
        (e) => toast({ title: `Couldn’t stop ${se.handle}`, text: e.message, level: 'blocking' }),
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
      if (options.length) groups.push({ label: `${se.handle}’s skills and commands${earlier ? ' · from an earlier session' : ''}`, options });
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
      toast({ title: `${se.handle} couldn’t run ${line.split(/\s/)[0]}`, text: e.message, level: 'blocking' });
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
      draft.clear();
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
      .filter((x) => x.parentId === conv && (x.kind === 'side' || x.kind === 'topic') && x.id !== threadId)
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
              const ring = se ? ringFor(se, 'sm') : h('pb-ring', { name: p.handle, state: 'idle', ctx: '0', size: 'sm' });
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
                  p.handle,
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
      void submit();
    }
  });
  ta.addEventListener('paste', async (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (files.length) {
      e.preventDefault();
      void addFiles(files.map((f, i) => (f.name ? f : new File([f], `Pasted image ${i + 1}.png`, { type: f.type }))));
    } else if (text.length > 2000) {
      e.preventDefault();
      void addFiles([new File([text], 'Pasted text.txt', { type: 'text/plain' })]);
      say('Long pasted text was attached as a file.');
    }
  });

  const el = h('div.composer', h('div.col', status, asks, waiting, queue, menuBox, att, h('div.composer-box', plus, commandsButton, ta, action), hint, file));

  // Drop files: the main composer takes drops anywhere in the window. A side or topic composer takes drops on
  // its own panel (see dropZone below), and stops them there so the main composer doesn’t take them too.
  const onDrop = (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    if (side) e.stopPropagation();
    void addFiles([...e.dataTransfer.files]);
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
            .then((r) => (r?.ask ? askStop(b, r.ask) : say(`Stopped ${b.handle}.`)))
            .catch((e) => toast({ title: 'Couldn’t stop', text: e.message }))
      : () => submit();
    action.setAttribute('aria-label', b ? `Stop ${b.handle}’s reply` : 'Send');
    const note = describeStop(action, b, threadId);
    const last = S().sessions[t.lastSpeaker];
    const members = sessionsOf(threadId).filter((x) => !x.archived);
    // Every agent here is archived: the conversation is read-only until you restore one.
    const archived = !topic && !side && !members.length ? sessionsOf(threadId) : [];
    ta.disabled = archived.length > 0;
    action.disabled = archived.length > 0;
    ta.placeholder = placeholderFor({ topic, side, members, last });
    paintWaitingLine(waiting, threadId);
    paintOfflineQueue(
      queue,
      outbox.filter((x) => x.threadId === threadId),
      { wait: outboxWait(), sendNow: sendOutboxNow },
    );
    // An ask about a turn that has since ended goes with it.
    for (const id of [...asked.keys()]) if (!busy(S().sessions[id])) asked.delete(id);
    syncList(
      asks,
      sessionsOf(threadId).filter((se) => busy(se) && (se.stopAsk || asked.has(se.id))),
      (se) => se.id,
      (se) => stopAskRow(se),
    );
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
    const own = isMock(target()) ? null : target();
    // A repaint while you’re on “Did you mean” keeps you there (#134).
    const onFix = !!document.activeElement?.closest('.did-you-mean') && hint.contains(document.activeElement);
    fill(
      hint,
      mode === 'shell'
        ? h(
            'span',
            folder ? ['Runs in ', h('span.mono', folder), here, ' as you, with Enter. '] : workspaceLine(own, here),
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
    // An agent on a host works in a folder there, so ! runs in the project’s folder here (server/shell-runs.mjs, commandFolder).
    if (hostOf(se)) return S().projects[thread()?.projectId]?.folder || null;
    return p?.folder || S().projects[thread()?.projectId]?.folder || null;
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
        .then((r) => say(stoppedSaid(se, r, jobs, one)))
        .catch((e) => toast({ title: `Couldn’t stop ${se.handle}`, text: e.message, level: 'blocking' }))
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
        'aria-label': `Stop ${se.handle}`,
        onkeydown: (e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          dismiss();
        },
      },
      h('span.q-text', ask?.text ?? `${se.handle} has background jobs running. Stop them too?`),
      h('button.btn.sm.send', { type: 'button', onclick: () => choose('stop') }, one ? 'Stop it too' : 'Stop them too'),
      h('button.btn.sm', { type: 'button', onclick: () => choose('keep') }, 'Keep running'),
      h('button.btn.sm.ghost', { type: 'button', 'aria-label': `Don’t stop ${se.handle}`, onclick: dismiss }, icon('x', 'i-sm')),
    );
  }
  paint();
  paintAtt();
  autosize();
  const off = client.on((ch) => {
    if (['thread', 'session', 'connection', 'outbox', 'load', 'persona', 'host'].includes(ch.type)) paint();
  });
  const unwatch = draft.watch(paintAtt);
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
      unwatch();
      unlisten();
    },
  };
}

export const _test = { renderItem, activityLabel };
