// First-run content: two projects, four agents, the new-agent boilerplates and a few empty threads.
// agents.json in the data folder, if present, seeds personas instead (see README).

import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from './store.mjs';

export const DEFAULT_PERSONAS = [
  { handle: 'librarian', description: 'Explores your books and builds tools to search them.', tools: ['corpus.search', 'corpus.read', 'corpus.stats'],
    instructions: 'Help the person explore their corpus. Build apps when a tool would explain better than prose.',
    examples: [['Build me an explorer for my corpus', 'An interactive search across every book'], ['Show me every kind of block you can send', 'One of each, all live'], ['Explain lexical and semantic search', 'With examples from your own books']] },
  { handle: 'indexer', description: 'Builds and maintains the search indexes.', tools: ['corpus.search', 'corpus.read', 'corpus.stats', 'shell'],
    instructions: 'Keep the indexes correct and fast. Report progress as you go.',
    examples: [['Index the shelf', 'Progress, subagents and a compaction'], ['Show me a dashboard', 'Charts from the kit'], ['Rebuild without the prefaces', 'A reply that fails, with Retry']] },
  { handle: 'researcher', description: 'Reads papers and turns them into explainers with exercises.', tools: ['corpus.search', 'web.fetch', 'arxiv.search'],
    instructions: 'Cite sources. Explain step by step, with diagrams, math and an exercise.',
    examples: [['Explain ReAct with something I can try', 'Citations, a diagram, math and practice'], ['Which agent memory papers should I read?', 'A choice that needs you']] },
  { handle: 'critic', description: 'Reviews specs, code and layouts line by line.', tools: ['corpus.read'],
    instructions: 'Review carefully. Resolve what you fix, and explain what you leave open.',
    examples: [['Review my corpus schema line by line', 'Comment on the spec, then get a revision']] },
];

export const BOILERPLATES = [
  { id: 'bp-researcher', name: 'Researcher', description: 'Reads and cites sources', instructions: 'Find and read sources. Cite every claim. Explain step by step.', tools: ['corpus.search', 'web.fetch'] },
  { id: 'bp-critic', name: 'Critic', description: 'Reviews line by line', instructions: 'Review carefully, line by line. Resolve what you fix and explain what you leave open.', tools: ['corpus.read'] },
  { id: 'bp-indexer', name: 'Indexer', description: 'Builds search indexes', instructions: 'Build and maintain search indexes. Report progress as you go.', tools: ['corpus.search', 'corpus.read', 'corpus.stats', 'shell'] },
  { id: 'bp-blank', name: 'Blank', description: 'Write it yourself', instructions: '', tools: [] },
];

export const KNOWN_TOOLS = [
  ['corpus.search', 'Search the corpus'], ['corpus.read', 'Read whole passages'], ['corpus.stats', 'Corpus statistics'],
  ['web.fetch', 'Fetch web pages'], ['arxiv.search', 'Search arXiv'], ['shell', 'Run commands in the project folder'],
];

export async function seed(rt, { dataDir, booksDir }) {
  const s = rt.store.state;
  if (Object.keys(s.personas).length) return false;
  let personas = DEFAULT_PERSONAS;
  try {
    const custom = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8'));
    if (Array.isArray(custom) && custom.length) personas = custom;
  } catch { /* no agents.json: use the defaults */ }
  for (const p of personas) rt.createPersona({ backend: 'mock', model: 'mock', ...p });
  for (const b of BOILERPLATES) rt.store.emit('boilerplate', b);

  const researchDir = join(dataDir, 'research');
  await mkdir(researchDir, { recursive: true });
  const corpus = { id: newId('pr'), name: 'Book corpus', folder: booksDir };
  const research = { id: newId('pr'), name: 'Agent research', folder: researchDir };
  rt.store.emit('project', corpus);
  rt.store.emit('project', research);
  const P = (h) => rt.personaByHandle(h).id;
  rt.createThread({ projectId: corpus.id, title: 'Corpus explorer', personaIds: [P('librarian')] });
  rt.createThread({ projectId: corpus.id, title: 'Index the shelf', personaIds: [P('indexer')] });
  rt.createThread({ projectId: corpus.id, title: 'Corpus schema spec', personaIds: [P('critic')] });
  rt.createThread({ projectId: corpus.id, title: 'Catalog tour', personaIds: [P('librarian')] });
  rt.createThread({ projectId: corpus.id, title: 'Corpus planning', personaIds: [P('indexer'), P('researcher')] });
  rt.createThread({ projectId: research.id, title: 'ReAct, step by step', personaIds: [P('researcher')] });
  rt.createThread({ projectId: research.id, title: 'Agent memory papers', personaIds: [P('researcher')] });
  return true;
}
