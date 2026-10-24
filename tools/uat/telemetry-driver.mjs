// What the UAT does with telemetry on the page (designs/telemetry-persona.md, U1, U2, U4): Record this room and the
// rest from the conversation’s ⋯ menu, a reaction on an item, and the Telemetry view’s Make report, Leave out, Save and
// File issue, each through the page’s own controls, as a person would. The probes record what the view showed and
// what File issue asked the browser to do: the text it copied and the page it opened. The runner keeps the page from
// opening a real tab, so nothing is ever submitted.

import { sleep } from '../cdp.mjs';

const J = JSON.stringify;

/** The page’s helpers: evaluate, click what an expression finds, find by text, and wait for an expression. */
function helpers(page) {
  const ev = (expr) => page.evaluate(expr);
  /** Clicks the first visible element the expression finds, or says what it couldn’t find. */
  const click = async (findExpr, what) => {
    const ok = await ev(`(() => { const el = ${findExpr}; if (!el) return false; el.scrollIntoView({ block: 'center' }); el.click(); return true; })()`);
    if (!ok) throw new Error(`Couldn’t find ${what} on screen.`);
    await sleep(300);
  };
  const byText = (scope, sel, text) =>
    `[...document.querySelectorAll(${J(`${scope} ${sel}`)})].find((e) => e.offsetParent !== null && (e.textContent + ' ' + (e.getAttribute('aria-label') ?? '')).includes(${J(text)}))`;
  const until = async (expr, what, seconds = 30) => {
    for (let i = 0; i < seconds * 4; i++) {
      if (await ev(expr)) return;
      await sleep(250);
    }
    throw new Error(`${what} didn’t appear within ${seconds} s.`);
  };

  return { ev, click, byText, until };
}

/** The ⋯ menu, the header, reactions, and File issue’s probes. */
function roomActions({ ev, click, byText }) {
  return {
    /** Records what File issue asks the browser to do: each text it copies and each page it opens, which isn’t opened. */
    async probe() {
      await ev(`(() => {
        if (window.__telemetryProbe) return;
        window.__telemetryProbe = { copied: [], opened: [] };
        const write = navigator.clipboard?.writeText?.bind(navigator.clipboard);
        if (navigator.clipboard) navigator.clipboard.writeText = (t) => { window.__telemetryProbe.copied.push({ text: String(t), at: Date.now() }); return (write ? write(t) : Promise.resolve()).catch(() => {}); };
        window.open = (url) => { window.__telemetryProbe.opened.push({ url: String(url), at: Date.now() }); return null; };
      })()`);
    },
    probes: () => ev(`window.__telemetryProbe ?? { copied: [], opened: [] }`),
    /** A ⋯ menu item: Record this room, Stop recording, Telemetry report… or Delete recordings…. */
    async menu(label) {
      await click(`document.querySelector('#conversation-actions')`, 'the conversation’s ⋯ menu');
      await click(byText('', '[role=menuitem]', label), `“${label}” in the ⋯ menu`);
    },
    header: () => ev(`document.querySelector('#recording-badge')?.textContent ?? ''`),
    /** Reacts to an item, by its id, from its React menu. */
    async react(key, emoji) {
      await click(`document.querySelector(${J(`[data-key="${key}"] button[aria-label="React to this message"]`)})`, `the React button on ${key}`);
      await click(
        `[...document.querySelectorAll('[role=menuitemcheckbox],[role=menuitem]')].find((b) => b.textContent.trim().startsWith(${J(emoji)}))`,
        `${emoji} in the React menu`,
      );
    },
  };
}

/** The Telemetry view: Make report, what it shows, Leave out, Save and File issue. */
function viewActions({ ev, click, byText, until }) {
  return {
    /** Opens the Telemetry view, and makes a report: with the room’s history when asked. Returns what it shows. */
    async report({ history = true } = {}) {
      if (!(await ev(`!!document.querySelector('.telemetry-view')`))) await this.menu('Telemetry report');
      await until(`!!document.querySelector('.telemetry-view .tv-body button')`, 'The Telemetry view');
      if (!(await ev(`!!document.querySelector('.tv-lines')`))) {
        await ev(`(() => { const c = document.querySelector('#tv-history'); if (c) c.checked = ${J(history)}; })()`);
        await click(byText('.telemetry-view', 'button', 'Make report'), 'Make report');
        await until(`!!document.querySelector('.tv-lines')`, 'The report', 180);
      }
      return this.shown();
    },
    /** What the view shows of the report: each line, whether it’s left out or fixed, and the hash. */
    shown: () =>
      ev(`({
        lines: [...document.querySelectorAll('.tv-lines li')].map((li, i) => ({ n: i + 1, line: li.querySelector('.tv-text')?.textContent ?? '', out: li.classList.contains('out'), toggle: !!li.querySelector('button') })),
        hash: (/sha256 ([0-9a-f]{64})/.exec(document.querySelector('.tv-hash')?.textContent ?? '') ?? [])[1] ?? null,
      })`),
    async leaveOut(n) {
      const before = (await this.shown()).hash;
      await click(
        `document.querySelector(${J(`.tv-lines button[aria-label="Leave out line ${n}"], .tv-lines button[aria-label="Put back line ${n}"]`)})`,
        `Leave out on line ${n}`,
      );
      await until(`(/sha256 ([0-9a-f]{64})/.exec(document.querySelector('.tv-hash')?.textContent ?? '') ?? [])[1] !== ${J(before)}`, 'The new hash', 15);
      return this.shown();
    },
    async save() {
      const n = await ev(`document.querySelectorAll('.tv-saved').length`);
      await click(byText('.telemetry-view', 'button', 'Save report'), 'Save report');
      await until(`document.querySelectorAll('.tv-saved').length > ${n}`, 'The saved report', 15);
    },
    /** File issue on a saved report’s finding (the newest report’s first, unless named): what it showed, then Send. */
    async fileIssue({ finding = 0 } = {}) {
      await this.probe();
      const buttons = `[...document.querySelectorAll('.tv-saved')][0]?.querySelectorAll('.tv-findings button')`;
      const ok = await ev(`(() => { const b = (${buttons} ?? [])[${Number(finding)}]; if (!b) return false; b.click(); return true; })()`);
      if (!ok) throw new Error('There’s no finding to file in the newest saved report.');
      await until(`!!document.querySelector('pre.tv-issue')`, 'The issue’s text');
      const shown = await ev(
        `({ text: document.querySelector('pre.tv-issue').textContent, hash: (/sha256 ([0-9a-f]{64})/.exec(document.querySelector('pre.tv-issue').parentElement.textContent) ?? [])[1] ?? null })`,
      );
      await click(byText('.dialog .d-foot', 'button', 'Send'), 'Send in the File issue dialog');
      await sleep(1000);
      return shown;
    },
  };
}

/** @param {any} page  from tools/cdp.mjs launch() */
export function telemetryDriver(page) {
  const h = helpers(page);
  const d = { ...roomActions(h), ...viewActions(h) };
  return d;
}
