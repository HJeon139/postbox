// Mermaid’s own parser, run off the main thread (#731; designs/architecture/diagram-legibility.md, “Syntax, checked
// on the server”). It loads the Mermaid Postbox bundles for the sandbox, and the sandbox page’s own label rewrite
// (app/kit/diagram.js, asWritten), into a context with a stand-in page: parsing needs no layout, only a document for
// DOMPurify to start with, whose fast path passes text with no markup. Each message is one diagram; the answer is
// { ok }, { error: { message, line } } for a syntax error, or { unknown } for anything the stand-in page can’t do,
// such as a label with HTML in it, which the drawn diagram still reports.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parentPort } from 'node:worker_threads';

const KIT = new URL('../app/kit/', import.meta.url);

/** A context like the sandbox page, as far as parsing needs one. */
function page() {
  const nothing = () => {};
  class Stub {}
  const document = {
    nodeType: 9,
    implementation: { createHTMLDocument: () => ({ body: {}, documentElement: {} }) },
    createElement: () => ({}),
    createNodeIterator: () => null,
    importNode: () => null,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: nothing,
    currentScript: null,
  };
  // Mermaid’s grammar library logs its own warnings while it builds; they mean nothing here.
  const quiet = { log: nothing, info: nothing, warn: nothing, error: nothing, debug: nothing };
  /** @type {Record<string, any>} */
  const ctx = {
    console: quiet,
    ...{ setTimeout, clearTimeout, queueMicrotask, structuredClone, URL, TextEncoder, TextDecoder, document },
    ...{ Element: Stub, DocumentFragment: Stub, Node: Stub, NamedNodeMap: Stub, HTMLFormElement: Stub, DOMParser: Stub, NodeFilter: {} },
    addEventListener: nothing,
    removeEventListener: nothing,
    parent: { postMessage: nothing },
  };
  Object.assign(ctx, { window: ctx, self: ctx, globalThis: ctx });
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('vendor/mermaid/mermaid.min.js', KIT), 'utf8'), ctx);
  vm.runInContext(readFileSync(new URL('diagram.js', KIT), 'utf8'), ctx);
  ctx.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
  // The page’s label rewrite (#684), so the parser reads what the page draws; the source as it is before it landed.
  const asWritten = vm.runInContext("typeof asWritten === 'function' ? asWritten : (s) => s", ctx);
  return { mermaid: ctx.mermaid, asWritten };
}

/** Whether Mermaid refused the diagram’s text, rather than the stand-in page failing it. @param {any} e */
const syntax = (e) => !!e?.hash || e?.name === 'UnknownDiagramError' || /^(Parse error|Lexical error|Parsing failed|Syntax error)/.test(String(e?.message));

const { mermaid, asWritten } = page();
parentPort?.on('message', async ({ id, src }) => {
  try {
    await mermaid.parse(asWritten(String(src)));
    parentPort?.postMessage({ id, ok: true });
  } catch (e) {
    if (!syntax(e)) return parentPort?.postMessage({ id, unknown: true });
    // As the sandbox page reports it: Mermaid’s message, and its line when it gives one.
    const message = String(e?.message ?? e).slice(0, 1000);
    const line = e?.hash?.loc?.first_line ?? Number(/line (\d+)/i.exec(message)?.[1] ?? 0);
    parentPort?.postMessage({ id, error: { message, line: line || null } });
  }
});
