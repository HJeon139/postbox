// The checks Postbox runs on what an agent sends, and the lint message that takes their problems back to it.
//
// Every check returns problems, { code, message, scope }. The runtime gathers the problems one agent turn caused,
// from the server’s own checks and from what the browser measured, into one lint turn (Runtime.lint). scope says
// what a problem is about, so the message can group them:
//   { kind: 'term', term, key }          a coined term the reply used without defining it
//   { kind: 'diagram', index, excerpt }  a Mermaid diagram in the reply; index is null when it can’t be told apart
//   { kind: 'reply' }                    the reply as a whole
//   { kind: 'app', id, title }           an app the agent showed
//   { kind: 'block', id, title }         a block the agent showed

import { lintTerms, numberedTerms } from './lint.mjs';

/** @typedef {{ kind: string, [k: string]: any }} Scope */
/** @typedef {{ code: string, message: string, scope: Scope }} Problem */

const MAX_PROBLEMS = 30;

/**
 * The problems from the diagram linter (shared/diagram-lint.mjs), one per problem per diagram.
 * @param {{ index: number|null, excerpt: string, problems: { code: string, message: string }[] }[]} diagrams
 * @returns {Problem[]}
 */
export function diagramProblems(diagrams) {
  return diagrams.flatMap((d) =>
    d.problems.map((p) => ({ code: p.code, message: p.message, scope: { kind: 'diagram', index: d.index ?? null, excerpt: d.excerpt } })),
  );
}

/**
 * The message for a lint turn. It carries the problems, and for the scripted mock backend the same problems as
 * the lists it reads: undefinedTerms [{ term, key }] and diagrams [{ index, excerpt, problems }].
 * @param {Problem[]} problems
 */
export function lintMessage(problems) {
  const seen = new Set();
  const list = problems
    .filter((p) => {
      const k = `${p.code}\n${p.message}\n${JSON.stringify(p.scope)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_PROBLEMS);
  const undefinedTerms = list.filter((p) => p.scope.kind === 'term').map((p) => ({ term: p.scope.term, key: p.scope.key }));
  /** @type {Map<string, { index: number|null, excerpt: string, problems: { code: string, message: string }[] }>} */
  const diagrams = new Map();
  for (const p of list.filter((x) => x.scope.kind === 'diagram')) {
    const k = `${p.scope.index}\n${p.scope.excerpt}`;
    if (!diagrams.has(k)) diagrams.set(k, { index: p.scope.index, excerpt: p.scope.excerpt, problems: [] });
    diagrams.get(k)?.problems.push({ code: p.code, message: p.message });
  }
  return { kind: 'lint', problems: list, undefinedTerms, diagrams: [...diagrams.values()] };
}

/**
 * Writes a lint message as the text of the agent’s turn: what was found, grouped by what it’s about, then what
 * to do. A lint turn that only needs tool calls needs no reply, so the agent is told it can end its turn.
 * @param {{ problems?: Problem[] }} message
 */
export function formatLint(message) {
  const problems = message.problems ?? [];
  const of = (kind) => problems.filter((p) => p.scope.kind === kind);
  const groups = (kind) => {
    /** @type {Map<string, Problem[]>} */
    const by = new Map();
    for (const p of of(kind)) {
      const k = JSON.stringify(p.scope);
      by.set(k, [...(by.get(k) ?? []), p]);
    }
    return [...by.values()];
  };
  const lines = (ps) => ps.map((p) => `- ${p.message}`).join('\n');
  const parts = [];
  const todo = [];
  const terms = of('term');
  if (terms.length) {
    parts.push(`Your reply used terms you haven’t defined. Define each with define_term:\n${terms.map((p) => `- ${p.scope.term}`).join('\n')}`);
  }
  const diagrams = groups('diagram');
  for (const ps of diagrams) {
    const { index, excerpt } = ps[0].scope;
    const which = index === null || index === undefined ? 'A diagram' : `Diagram ${index + 1}`;
    parts.push(`${which} in your reply can’t be read (it starts “${String(excerpt ?? '').split('\n')[0]}”):\n${lines(ps)}`);
  }
  if (diagrams.length) todo.push('Reply with a corrected version of each diagram, briefly, so the person can read it.');
  const reply = of('reply');
  if (reply.length) parts.push(`In your reply:\n${lines(reply)}`);
  const apps = groups('app');
  for (const ps of apps) parts.push(`Your app “${ps[0].scope.title ?? ps[0].scope.id}” (id ${ps[0].scope.id}) is shown, with these warnings:\n${lines(ps)}`);
  if (apps.length) todo.push('Fix each app with update_app.');
  const blocks = groups('block');
  for (const ps of blocks) parts.push(`Your block “${ps[0].scope.title ?? ps[0].scope.id}” (id ${ps[0].scope.id}):\n${lines(ps)}`);
  if (!diagrams.length && !reply.length) todo.push('No reply is needed: once you’ve made the changes, end your turn without writing anything.');
  return `[Postbox] ${[...parts, ...todo].join('\n\n')}`;
}

/**
 * The coined terms a reply used without defining them (server/lint.mjs).
 * @param {string} text  @param {Record<string, { term: string }>} glossary  @param {Set<string>} [introduced]  see introducedTerms
 * @returns {Problem[]}
 */
export function termProblems(text, glossary, introduced) {
  return lintTerms(text, glossary, introduced).map(({ term, key }) => ({
    code: 'undefined-term',
    message: `“${term}” isn’t defined.`,
    scope: { kind: 'term', term, key },
  }));
}

const headings = (md) => [...String(md).matchAll(/^ {0,3}#{1,6}\s+(.+)$/gm)].map((m) => m[1]);
const tagText = (html, tags) => [...String(html).matchAll(new RegExp(`<(${tags})\\b[^>]*>([\\s\\S]*?)</\\1>`, 'gi'))].map((m) => m[2].replace(/<[^>]*>/g, ' '));

/**
 * Numbered references that need no definition: the person brought them up (“I think step 2 should show a
 * highlight”), or they label something on screen, as the title or a heading of a block or app in the conversation.
 * @param {any[]} items  the conversation’s items
 * @param {any[]} apps   its apps
 */
export function introducedTerms(items, apps) {
  const texts = [];
  for (const it of items) {
    if (it.kind === 'user') texts.push(it.text ?? '');
    if (it.kind !== 'block' || !it.valid || it.block.type === 'app') continue;
    const b = it.block;
    texts.push(b.title ?? '');
    for (const v of Object.values(b)) if (typeof v === 'string') texts.push(...headings(v));
    if (b.type === 'progress') texts.push(...b.steps.map((s) => s.label));
  }
  for (const app of apps) {
    texts.push(app.title ?? '');
    texts.push(...tagText(app.versions?.[app.current - 1]?.code ?? '', 'h[1-6]|title'));
  }
  return numberedTerms(texts.join('\n'));
}
