// The document-query probe (#564-b1): how many lookups over the whole document the page ran while it handled session
// events, since it loaded. tools/uat/observe.mjs installs it and samples it each step, before any screenshot;
// tools/uat/view-triggers.mjs reads it. A session event used to run three queries over the whole document, so its
// cost grew with the room; #564-b1 looks only at what each listener kept.

import { js } from '../browser.mjs';

/**
 * The lookups that walk the document: the query pair, and the collections a scan could switch to. getElementById is
 * counted apart, since the browser answers it from an index of ids, not by walking the document.
 */
export const SCANS = ['querySelector', 'querySelectorAll', 'getElementsByClassName', 'getElementsByTagName'];

/**
 * Installs the counters once per page load, and samples them. sessionEvents: the `session` events the page’s client
 * has emitted since it loaded. scans: each lookup on the document itself during those emits, by name and selector, up
 * to the first 20, and scanCount, all of them. byId: getElementById calls during them. items: how many items the open
 * conversation has, from its header, since the page holds only a range of them (#1155). Installing wraps the Document methods and client.emit, which every listener hears through
 * (app/js/client.mjs); a lookup inside an element, as the listeners now make, isn’t counted.
 * @param {(expr: string) => Promise<any>} ev  the driver’s page.evaluate
 * @returns {Promise<{ origin: number, sessionEvents: number, scanCount: number, scans: string[], byId: number, items: number }>}
 */
export const sampleDocQueries = (ev) =>
  ev(`import('/app/js/client.mjs').then(({ client }) => {
    const w = window;
    if (!w.__pbDocQueries) {
      const p = (w.__pbDocQueries = { sessionEvents: 0, scanCount: 0, scans: [], byId: 0, depth: 0 });
      for (const name of ${js(SCANS)}) {
        const real = Document.prototype[name];
        Document.prototype[name] = function (arg) {
          if (this === document && p.depth > 0) {
            p.scanCount++;
            if (p.scans.length < 20) p.scans.push(name + ' ' + String(arg).slice(0, 80));
          }
          return real.call(this, arg);
        };
      }
      const realById = Document.prototype.getElementById;
      Document.prototype.getElementById = function (id) {
        if (this === document && p.depth > 0) p.byId++;
        return realById.call(this, id);
      };
      const realEmit = client.emit;
      client.emit = function (change) {
        if (change?.type !== 'session') return realEmit.call(this, change);
        p.sessionEvents++;
        p.depth++;
        try {
          return realEmit.call(this, change);
        } finally {
          p.depth--;
        }
      };
    }
    const p = w.__pbDocQueries;
    const thread = document.querySelector('#main.transcript')?.dataset.thread;
    const items = (thread && client.headers?.[thread]?.count) || 0;
    return { origin: Math.round(performance.timeOrigin), sessionEvents: p.sessionEvents, scanCount: p.scanCount, scans: [...p.scans], byId: p.byId, items };
  })`);

/**
 * Samples into facts.probes.docQueries. The first sample of a page load installs the counters, so it reads zeros.
 * @param {(expr: string) => Promise<any>} ev  @param {{ probes: { docQueries?: any[] } }} facts  @param {number} step
 */
export async function recordDocQueries(ev, facts, step) {
  const s = await sampleDocQueries(ev).catch(() => null);
  if (!s) return;
  facts.probes.docQueries ??= [];
  facts.probes.docQueries.push({ step, at: Date.now(), ...s });
}
