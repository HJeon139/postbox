// The host’s tools that apps (through the bridge) and agents can use, if granted: the corpus and narration.

import { httpError } from './helpers.mjs';

/** Host tools that apps (through the bridge) and agents can use, if granted. */
export function hostTool(rt, tool, args = {}) {
  switch (tool) {
    case 'corpus.search': {
      const q = String(args.query ?? '').slice(0, 200);
      const mode = ['both', 'lexical', 'semantic'].includes(args.mode) ? args.mode : 'both';
      // k and books come from an agent or an app: 1 to 50 results, and the first 50 book ids (#351).
      const k = Math.max(1, Math.min(50, Math.floor(+args.k || 12)));
      return rt.corpus.search(q, { mode, k, books: Array.isArray(args.books) ? args.books.slice(0, 50) : undefined });
    }
    case 'corpus.read':
      return rt.corpus.read(String(args.id ?? ''));
    case 'corpus.stats':
      return rt.corpus.stats();
    case 'narrate.speak':
      if (!rt.narrator) throw httpError(503, 'Narration isn’t installed here. Run npm install to add Kokoro, then restart Postbox.');
      return rt.narrator.speak(args);
    default:
      throw httpError(404, `There’s no host tool called “${tool}”.`);
  }
}
