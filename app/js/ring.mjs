// <pb-ring>: an agent’s status ring. The center arc is the agent’s share of context in use; each subagent
// adds a thinner ring outside it with its own context and activity. Motion shows the state, and every
// motion eases in, eases out, then rests: generating turns the arc once; thinking runs a short bulge of
// thickness along it; calling tools sends a dot across the free part of the ring and back. Needs-you
// pulses amber. With reduced motion everything holds still (see workbench.css).
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

function ringSvg(c, r, sw, state, ctx) {
  const color = `var(${STATE_VAR[state] ?? '--st-idle'})`;
  const C = 2 * Math.PI * r;
  const L = ctx != null ? (C * ctx) / 100 : 0;
  let out = `<circle class="track" cx="${c}" cy="${c}" r="${r}" fill="none" stroke-width="${sw}"/>`;
  if (state === 'think' && L > 0) {
    const n = Math.max(6, Math.round(L / (sw * 1.1)));
    const seg = L / n;
    out += `<g transform="rotate(-90 ${c} ${c})" style="--sw:${sw}px">`;
    for (let i = 0; i < n; i++) {
      const delay = Math.round((1400 * Math.acos(1 - (2 * i) / (n - 1))) / Math.PI);
      out += `<circle class="arc seg" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${seg} ${C - seg}" stroke-dashoffset="${-i * seg}" style="--d:${delay}ms"/>`;
    }
    out += '</g>';
  } else {
    out += `<g transform="rotate(-90 ${c} ${c})"><circle class="arc" cx="${c}" cy="${c}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${L} ${C - L}"/></g>`;
  }
  if (state === 'tool') {
    const margin = ((sw * 1.6) / r) * (180 / Math.PI);
    const ctxNum = ctx ?? 0;
    const a1 = 3.6 * ctxNum + margin,
      a2 = 360 - margin;
    const rest = a1 < a2 ? a1 : 3.6 * ctxNum + (360 - 3.6 * ctxNum) / 2;
    out += `<circle class="dot${a1 >= a2 ? ' still' : ''}" cx="${c}" cy="${c - r}" r="${Math.max(1.3, sw * 0.8)}" fill="${color}" style="--a1:${a1}deg;--a2:${a2}deg;transform:rotate(${rest}deg)"/>`;
  }
  return out;
}

const parseSubs = (spec) =>
  (spec || '')
    .split(',')
    .filter(Boolean)
    .map((p) => {
      const [state, ctx, name] = p.split(':');
      return { state, ctx: Math.max(0, Math.min(100, +ctx || 0)), name: name || 'subagent' };
    });

/** Builds the subs attribute from a session’s subagents. */
export const subsAttr = (subagents = []) => subagents.map((s) => `${s.state}:${Math.round(s.ctx)}:${String(s.name).replace(/[,:]/g, ' ')}`).join(',');

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
    let inner = ringSvg(c, rb, sw, state, ctx);
    shown.forEach((s, i) => {
      inner += ringSvg(c, rb + (i + 1) * pitch, sw * 0.8, s.state, s.ctx);
    });
    if (state === 'needs') inner += `<circle class="pulse" cx="${c}" cy="${c}" r="${R + sw}" fill="none" stroke-width="1.4"/>`;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', S);
    svg.setAttribute('height', S);
    svg.setAttribute('viewBox', `0 0 ${S} ${S}`);
    svg.innerHTML = inner; // lint-allow dom: ringSvg() builds it from numbers and Postbox’s fixed state names.
    svg.setAttribute('role', 'img');
    const subText = subs.length
      ? `; ${subs.length} subagent${subs.length === 1 ? '' : 's'}: ` + subs.map((x) => `${x.name} ${stateWord(x.state).toLowerCase()}, ${x.ctx}%`).join('; ')
      : '';
    const where = this.getAttribute('where') || '';
    const ctxText = ctx != null ? `${ctx}% of context used` : 'context unknown';
    const label = `${name}: ${stateWord(state)}, ${ctxText}${where ? `; ${where}` : ''}${subText}`;
    svg.setAttribute('aria-label', label);
    const title = document.createElementNS(NS, 'title');
    title.textContent = label;
    svg.prepend(title);
    const parts = [svg];
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
