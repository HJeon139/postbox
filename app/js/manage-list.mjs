// The one pattern for managing things (#1735, decided 23 November 2026): a list you pick a row in, each row with its
// name and its facts, with one bar of controls, + to add and − to remove what’s picked, and one thing made or edited at
// a time in a form in the same sheet, whose actions are pinned under it. A list that fills its tab has its bar pinned
// under the sheet; one inside a form has it in the row of its heading, so what the controls act on reads beside them. Personas,
// projects, rooms and their members, people and hosts are all managed this way, from the main menu (openSettings in
// app/js/sheets.mjs), and nowhere else: a ⋯ menu or a rail button only opens it.

import { h, icon } from './dom.mjs';

/**
 * @typedef {{ key: string, name: string, marks?: any[], facts?: (string | Node | null | undefined | false)[], className?: string }} Row
 */

/**
 * A list you pick a row in, and the bar of controls that act on the pick. A click or the arrow keys pick; a double
 * click or Enter opens the pick, as `open` says. The pick is kept in `at[name]`, so a repaint keeps it, and with none
 * kept the first row is picked, so the bar’s controls always have something to act on.
 * @param {{ label: string, rows: Row[], empty: string, at: Record<string, any>, name: string,
 *           controls: (picked: Row | null) => any[], open?: (picked: Row) => void, onPick?: (picked: Row) => void }} list
 *   onPick: when the pick moves to another row, for a list that shows its pick’s details under it
 * @returns {{ list: HTMLElement, bar: HTMLElement }}  the bar goes in the sheet’s foot, or beside the list’s heading (sectionHead)
 */
export function pickList({ label, rows, empty, at, name, controls, open, onPick }) {
  const bar = h('div.list-bar', { role: 'toolbar', 'aria-label': `${label}: actions` });
  const picked = () => rows.find((r) => r.key === at[name]) ?? rows[0] ?? null;
  const list = h('ul.list-rows.pick-list', { role: 'listbox', 'aria-label': label });
  const draw = () => {
    const cur = picked();
    for (const li of /** @type {HTMLElement[]} */ ([...list.children])) {
      const on = li.dataset.key === cur?.key;
      li.setAttribute('aria-selected', String(on));
      li.tabIndex = on ? 0 : -1;
    }
    bar.replaceChildren(...controls(cur).filter(Boolean));
  };
  const pick = (/** @type {Row} */ r, focus = false) => {
    const moved = at[name] !== r.key;
    at[name] = r.key;
    draw();
    if (moved) onPick?.(r);
    if (focus) /** @type {HTMLElement | null} */ (list.querySelector('[aria-selected="true"]'))?.focus();
  };
  const onKey = (/** @type {KeyboardEvent} */ e, /** @type {number} */ i) => {
    const to = { ArrowDown: rows[i + 1], ArrowUp: rows[i - 1], Home: rows[0], End: rows.at(-1) }[e.key];
    if (to) {
      e.preventDefault();
      pick(to, true);
    } else if (e.key === 'Enter' && open) open(rows[i]);
  };
  for (const [i, r] of rows.entries())
    list.append(
      h(
        `li.manage-row${r.className ? `.${r.className}` : ''}`,
        {
          role: 'option',
          dataset: { key: r.key },
          onclick: () => pick(r),
          ondblclick: () => open?.(r),
          onkeydown: (/** @type {KeyboardEvent} */ e) => onKey(e, i),
        },
        h('b', r.name),
        ...(r.marks ?? []),
        ...(r.facts ?? []).filter(Boolean).map((f) => h('span.small.dim.fact', f)), // a fact is its words, or a node that keeps itself current
      ),
    );
  draw();
  return { list: rows.length ? list : h('p.empty-note', empty), bar };
}

/**
 * The bar’s + and −, as a macOS list has them: `label` says what each does to what, for a screen reader and the
 * pointer. `off` is why it can’t be used now: it stays in view and in the tab order, dimmed, and says so.
 * @param {'+' | '−'} sign @param {string} label @param {() => void} run @param {{ off?: string, id?: string }} [opts]
 */
export function barSign(sign, label, run, { off = '', id = undefined } = {}) {
  return h(
    'button.btn.sm.sign',
    {
      type: 'button',
      id,
      'aria-label': label,
      title: off || label,
      'aria-disabled': String(Boolean(off)),
      'aria-description': off || null,
      onclick: () => off || run(),
    },
    sign,
  );
}

/** Another control of the bar, named for what it acts on. @param {string} label @param {string} on @param {() => void} run @param {{ off?: string, id?: string }} [opts] */
export function barAction(label, on, run, { off = '', id = undefined } = {}) {
  return h(
    'button.btn.sm',
    {
      type: 'button',
      id,
      'aria-label': `${label} ${on}`,
      title: off || null,
      'aria-disabled': String(Boolean(off)),
      'aria-description': off || null,
      onclick: () => off || run(),
    },
    label,
  );
}

/** A form’s top: the way back to its list, and what is being edited. @param {string} all  “All projects” @param {() => void} back @param {string} title */
export const formHead = (all, back, title) => [
  h('button.btn.sm.ghost', { type: 'button', onclick: back, style: { alignSelf: 'flex-start' } }, icon('back', 'i-sm'), all),
  h('b', title),
];

/**
 * A section’s heading inside a form, and in its row the bar of the list it heads, when it heads one.
 * @param {string} text @param {HTMLElement} [bar]
 */
export const sectionHead = (text, bar) => h('div.section-head', h('h3.label', text), bar);

/**
 * A sheet’s foot that its tabs fill: each hands its actions to setFoot, and with none the foot is hidden.
 * @returns {{ foot: HTMLElement, setFoot: (...actions: any[]) => null }}
 */
export function pinnedFoot() {
  const foot = h('div.settings-foot');
  const setFoot = (/** @type {any[]} */ ...actions) => {
    foot.replaceChildren(...actions.filter(Boolean));
    if (foot.parentElement) foot.parentElement.hidden = !foot.children.length;
    return null;
  };
  return { foot, setFoot };
}
