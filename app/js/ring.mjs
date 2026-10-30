// <pb-ring>: an agent’s status ring. The center arc is the agent’s share of context in use; each subagent
// adds a thinner ring outside it with its own context and activity. Motion shows the state, and every
// motion eases in, eases out, then rests: generating turns the arc once; thinking runs a short bulge of
// thickness along it; calling tools sends a dot across the free part of the ring and back. Needs-you
// pulses amber. With reduced motion everything holds still (see workbench.css). What moves is drawn in an
// overlay of its own that turns and fades as one, so the page isn’t painted again each frame (#463).
//
//   <pb-ring name="@indexer" state="tool" ctx="62" subs="gen:22:chunker,tool:31:embedder" size="sm">
//
// An agent on a host (#120) also says where it runs in its label: where="on host.example.com, connected, last heard
// from 2 min ago" (app/js/remote.mjs), in words, since the ring’s color says only what the agent is doing.

import { ringWhere } from './remote.mjs';

// stopping: Stop was pressed, and its process hasn’t exited yet (#126). It holds still, in the idle color.
const STATE_WORD = { idle: 'Idle', think: 'Thinking', gen: 'Generating', tool: 'Calling tools', needs: 'Needs you', failed: 'Failed', stopping: 'Stopping' };
const STATE_VAR = { idle: '--st-idle', think: '--st-think', gen: '--st-gen', tool: '--st-tool', needs: '--accent', failed: '--alert' };
const RING_SIZES = { xs: [4.5, 1.75, 3, 2], sm: [6, 2, 3.5, 2], lg: [10, 3, 5, 3] };
const NS = 'http://www.w3.org/2000/svg';
export const stateWord = (s) => STATE_WORD[s] ?? 'Idle';

/**
 * Status words beside agent names: a <span class="who-state" data-session> gets “· thinking” and so on. In the
 * transcript (data-item set) it shows only on the agent’s latest message, and only while it’s busy or needs
 * you; elsewhere it always shows.
 */
export function paintStateWords(root, sessions, latestItemOf) {
  for (const el of root.querySelectorAll('.who-state[data-session]')) {
    const se = sessions[el.dataset.session];
    if (!se) continue;
    const live = se.state !== 'idle';
    const show = el.dataset.item ? live && latestItemOf(se) === el.dataset.item : true;
    const text = show ? `· ${stateWord(se.state).toLowerCase()}` : '';
    if (el.textContent !== text) el.textContent = text;
  }
}

/**
 * One ring of a <pb-ring>: what holds still, drawn in the ring’s own SVG, and what moves, if anything, drawn in an SVG
 * of its own laid over it (#463). Only that overlay animates, by transform and opacity, one animation a ring: Safari
 * repainted a ring’s SVG every frame while any shape inside it animated, and a thinking ring had about 12 (one swell
 * per segment), so the compositor moves the overlay instead and the page isn’t painted again.
 * @returns {{ still: string, moving: { kind: 'turn'|'cross'|'sweep', style: string, inner: string } | null }}
 */
function ringSvg(c, r, sw, state, ctx) {
  const color = `var(${STATE_VAR[state] ?? '--st-idle'})`;
  const C = 2 * Math.PI * r;
  // With no measured context (#189) there’s no arc, since any length would read as an amount used; thinking and
  // generating show as the dot that crosses the ring, as calling tools does, so the activity still shows. The label
  // says the context is unknown.
  const L = ctx != null ? (C * ctx) / 100 : 0;
  const arc = (len, width = sw) =>
    `<g transform="rotate(-90 ${c} ${c})"><circle class="arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" stroke-dasharray="${len} ${C - len}"/></g>`;
  const track = `<circle class="track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${sw}"/>`;
  // Generating: the arc turns once, then rests.
  if (state === 'gen' && L > 0) return { still: track, moving: { kind: 'turn', style: '', inner: arc(L) } };
  // Thinking: a short swell of the arc’s thickness travels along it, fading in and out.
  if (state === 'think' && L > 0) {
    const seg = Math.min(L, Math.max(sw * 1.1, L / 6));
    const sweep = ((L - seg) / C) * 360;
    return { still: track + arc(L), moving: { kind: 'sweep', style: `--a2:${sweep}deg`, inner: arc(seg, sw * 2) } };
  }
  const moving = state === 'tool' || (ctx == null && (state === 'think' || state === 'gen'));
  if (!moving) return { still: track + arc(L), moving: null };
  // Calling tools: a dot crosses the free part of the ring and back.
  const margin = ((sw * 1.6) / r) * (180 / Math.PI);
  const ctxNum = ctx ?? 0;
  const a1 = 3.6 * ctxNum + margin,
    a2 = 360 - margin;
  const rest = a1 < a2 ? a1 : 3.6 * ctxNum + (360 - 3.6 * ctxNum) / 2;
  const dot = (style) => `<circle class="dot" cx="${c}" cy="${c - r}" r="${Math.max(1.3, sw * 0.8)}" fill="${color}"${style ? ` style="${style}"` : ''}/>`;
  // No room to cross: the dot holds still where it rests.
  if (a1 >= a2) return { still: track + arc(L) + dot(`transform:rotate(${rest}deg)`), moving: null };
  return { still: track + arc(L), moving: { kind: 'cross', style: `--a1:${a1}deg;--a2:${a2}deg;transform:rotate(${rest}deg)`, inner: dot('') } };
}

/** An SVG of a ring’s size, S by S, holding what ringSvg() drew. */
function ringBox(S, html) {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('width', S);
  el.setAttribute('height', S);
  el.setAttribute('viewBox', `0 0 ${S} ${S}`);
  el.innerHTML = html; // lint-allow dom: ringSvg() builds it from numbers and Postbox’s fixed state names.
  return el;
}

/** What moves in one ring, laid over it and hidden from assistive tech: the ring’s label says the state. */
function moverBox(S, m) {
  const el = ringBox(S, m.inner);
  el.setAttribute('class', `mover ${m.kind}`);
  el.setAttribute('aria-hidden', 'true');
  if (m.style) el.setAttribute('style', m.style);
  return el;
}

const parseSubs = (spec) =>
  (spec || '')
    .split(',')
    .filter(Boolean)
    .map((p) => {
      const [state, ctx, name] = p.split(':');
      // An empty ctx is unknown (#189): the subagent sent no usage, so it isn’t shown as 0%.
      return { state, ctx: ctx === '' || ctx === undefined || Number.isNaN(+ctx) ? null : Math.max(0, Math.min(100, +ctx)), name: name || 'subagent' };
    });

/** Builds the subs attribute from a session’s subagents. */
export const subsAttr = (subagents = []) =>
  subagents.map((s) => `${s.state}:${Number.isFinite(s.ctx) ? Math.round(s.ctx) : ''}:${String(s.name).replace(/[,:]/g, ' ')}`).join(',');

class PbRing extends HTMLElement {
  static observedAttributes = ['state', 'ctx', 'subs', 'size', 'name', 'where'];
  connectedCallback() {
    this.render();
  }
  attributeChangedCallback(_, a, b) {
    if (this.isConnected && a !== b) this.render();
  }
  render() {
    const state = this.getAttribute('state') || 'idle';
    const rawCtx = this.getAttribute('ctx');
    const hasCtx = rawCtx !== null && rawCtx !== '' && rawCtx !== 'unknown' && !Number.isNaN(+rawCtx);
    const ctx = hasCtx ? Math.max(0, Math.min(100, +rawCtx)) : null;
    const subs = parseSubs(this.getAttribute('subs'));
    const size = this.getAttribute('size') || 'sm';
    const name = this.getAttribute('name') || 'Agent';
    const [rb, sw, pitch, cap] = RING_SIZES[size] ?? RING_SIZES.sm;
    const shown = subs.slice(0, cap);
    const R = rb + shown.length * pitch;
    const S = Math.ceil(2 * (R + sw / 2 + 1));
    const c = S / 2;
    const rings = [ringSvg(c, rb, sw, state, ctx), ...shown.map((s, i) => ringSvg(c, rb + (i + 1) * pitch, sw * 0.8, s.state, s.ctx))];
    let inner = rings.map((x) => x.still).join('');
    if (state === 'needs') inner += `<circle class="pulse" cx="${c}" cy="${c}" r="${R + sw}" fill="none" stroke-width="1.4"/>`;
    const svg = ringBox(S, inner);
    svg.setAttribute('role', 'img');
    const movers = rings.map((x) => x.moving && moverBox(S, x.moving)).filter((m) => m !== null);
    const subText = subs.length
      ? `; ${subs.length} subagent${subs.length === 1 ? '' : 's'}: ` +
        subs.map((x) => `${x.name} ${stateWord(x.state).toLowerCase()}, ${x.ctx == null ? 'context unknown' : `${x.ctx}%`}`).join('; ')
      : '';
    const where = this.getAttribute('where') || '';
    const ctxText = ctx != null ? `${ctx}% of context used` : 'context unknown';
    const label = `${name}: ${stateWord(state)}, ${ctxText}${where ? `; ${where}` : ''}${subText}`;
    svg.setAttribute('aria-label', label);
    const title = document.createElementNS(NS, 'title');
    title.textContent = label;
    svg.prepend(title);
    const parts = [svg, ...movers];
    if (subs.length > cap) {
      const more = document.createElement('span');
      more.className = 'ring-more';
      more.textContent = `+${subs.length - cap}`;
      more.setAttribute('aria-hidden', 'true');
      parts.push(more);
    }
    this.replaceChildren(...parts);
    // While its agent needs you, a ring outside any link or button is a button of its own, to what it needs (#285,
    // needs-nav.mjs). In a link or a button, that control goes there instead.
    if (this.dataset.session && (state === 'needs' || state === 'failed') && !this.parentElement?.closest('a, button')) {
      this.setAttribute('role', 'button');
      this.setAttribute('tabindex', '0');
      this.setAttribute('aria-label', `${label}. Go to what ${name} needs`);
    } else if (this.getAttribute('role') === 'button') {
      for (const a of ['role', 'tabindex', 'aria-label']) this.removeAttribute(a);
    }
  }
}
if (!customElements.get('pb-ring')) customElements.define('pb-ring', PbRing);

/** A ring element for a session, or updates an existing one in place (keeps its animation running). */
export function ringFor(se, size = 'sm', el = null) {
  el ??= document.createElement('pb-ring');
  const set = (k, v) => {
    if (el.getAttribute(k) !== v) el.setAttribute(k, v); // lint-allow dom: k is one of the literal names below.
  };
  set('name', `@${se.handle}`);
  set('state', se.deleting ? 'idle' : (se.state ?? 'idle'));
  set('ctx', se.ctx != null ? String(se.ctx) : 'unknown');
  set('subs', subsAttr(se.subagents));
  set('size', size);
  set('where', ringWhere(se));
  return el;
}
