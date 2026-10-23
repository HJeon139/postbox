// First-run content. A fresh install gets three generic agents (a researcher, a developer and a critic) and nothing
// else; --demo gets the book-corpus agents, two projects and a few empty conversations, which the demo, the screenshots
// and the tests play. Both get the new-agent boilerplates. agents.json in the data folder, if present, seeds the agents
// instead, in either mode (see README).

import { readFileSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { newId } from './store.mjs';

// Read once, when the module loads: freshInstall() is synchronous, and the UAT's checks call it as well as seed().
const prompt = (name) => readFileSync(new URL(`./personas/${name}.md`, import.meta.url), 'utf8').trim();
const RESEARCHER = prompt('researcher');
const DEVELOPER = prompt('developer');
const CRITIC = prompt('critic');

/**
 * What a fresh install (no --demo) starts with: three generic agents, and no projects or conversations.
 * Read by the UAT's fresh-install-agents check.
 */
export function freshInstall() {
  return {
    personas: [
      {
        handle: 'researcher',
        description: 'Finds and reads sources, and explains what they show.',
        tools: ['web.fetch'],
        instructions: RESEARCHER,
        examples: [['What do the sources say about this?', 'A cited answer, and what is still open']],
      },
      {
        handle: 'developer',
        description: 'Changes code in your project, and verifies the change.',
        // Commands and the web, as in your terminal: with #5 an unticked tool is denied. The permission mode still
        // decides what it asks you about; agents outside Postbox stay off.
        tools: ['shell', 'web.fetch'],
        instructions: DEVELOPER,
        examples: [['Fix this bug, and show me it’s fixed', 'The smallest fix, with the checks it ran']],
      },
      {
        handle: 'critic',
        description: 'Reviews code and documents, and reports what’s wrong with evidence.',
        // Commands, to run the checks a review cites; the web, to verify its links.
        tools: ['shell', 'web.fetch'],
        instructions: CRITIC,
        examples: [['Review my change', 'Findings ranked by what fixing them is worth']],
      },
    ],
    /** @type {{ name: string, folder: string }[]} */
    projects: [],
  };
}

/** The demo's agents, which use the book corpus in server/corpus. */
export const DEMO_PERSONAS = [
  {
    handle: 'librarian',
    description: 'Explores your books and builds tools to search them.',
    tools: ['corpus.search', 'corpus.read', 'corpus.stats'],
    instructions: 'Help the person explore their corpus. Build apps when a tool would explain better than prose.',
    examples: [
      ['Build me an explorer for my corpus', 'An interactive search across every book'],
      ['Show me every kind of block you can send', 'One of each, all live'],
      ['Explain lexical and semantic search', 'With examples from your own books'],
    ],
  },
  {
    handle: 'indexer',
    description: 'Builds and maintains the search indexes.',
    tools: ['corpus.search', 'corpus.read', 'corpus.stats', 'shell'],
    instructions: 'Keep the indexes correct and fast. Report progress as you go.',
    examples: [
      ['Index the shelf', 'Progress, subagents and a compaction'],
      ['Clear the old index cache', 'Asks before it runs a command'],
      ['Show me a dashboard', 'Charts from the kit'],
      ['Rebuild without the prefaces', 'A reply that fails, with Retry'],
    ],
  },
  {
    handle: 'researcher',
    description: 'Reads papers and turns them into explainers with exercises.',
    tools: ['corpus.search', 'web.fetch', 'arxiv.search', 'narrate.speak'],
    instructions: 'Cite sources. Explain step by step, with diagrams, math and an exercise.',
    examples: [
      ['Explain ReAct with something I can try', 'Citations, a diagram, math and practice'],
      ['Walk me through ReAct, out loud', 'Slides that follow a local voice'],
      ['Which agent memory papers should I read?', 'A choice that needs you'],
    ],
  },
  {
    handle: 'critic',
    description: 'Reviews specs, code and layouts line by line.',
    tools: ['corpus.read'],
    instructions: 'Review carefully. Resolve what you fix, and explain what you leave open.',
    examples: [['Review my corpus schema line by line', 'Comment on the spec, then get a revision']],
  },
];

export const BOILERPLATES = [
  {
    id: 'bp-researcher',
    name: 'Researcher',
    description: 'Reads and cites sources',
    instructions: RESEARCHER,
    tools: ['web.fetch'],
  },
  {
    id: 'bp-critic',
    name: 'Critic',
    description: 'Reviews code and documents',
    instructions: CRITIC,
    tools: ['shell', 'web.fetch'],
  },
  {
    id: 'bp-developer',
    name: 'Developer',
    description: 'Changes code and verifies it',
    instructions: DEVELOPER,
    tools: ['shell', 'web.fetch'],
  },
  {
    id: 'bp-indexer',
    name: 'Indexer',
    description: 'Builds search indexes',
    instructions: 'Build and maintain search indexes. Report progress as you go.',
    tools: ['corpus.search', 'corpus.read', 'corpus.stats', 'shell'],
  },
  { id: 'bp-blank', name: 'Blank', description: 'Write it yourself', instructions: '', tools: [] },
];

export const KNOWN_TOOLS = [
  ['corpus.search', 'Search the corpus'],
  ['corpus.read', 'Read whole passages'],
  ['corpus.stats', 'Corpus statistics'],
  ['web.fetch', 'Fetch web pages'],
  ['arxiv.search', 'Search arXiv'],
  ['shell', 'Run commands in the project folder'],
  ['narrate.speak', 'Read text aloud with a local voice'],
];

/**
 * @param {any} rt
 * @param {{ dataDir: string, booksDir: string, backend?: string, demo?: boolean }} opts  backend: what the seeded agents run on
 */
export async function seed(rt, { dataDir, booksDir, backend = 'mock', demo = false }) {
  const s = rt.store.state;
  if (Object.keys(s.personas).length) return false;
  const fresh = freshInstall();
  let personas = demo ? DEMO_PERSONAS : fresh.personas;
  try {
    const custom = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8'));
    if (Array.isArray(custom) && custom.length) personas = custom;
  } catch {
    /* no agents.json: use the defaults */
  }
  // The seeded agents run on a real model when one is available here, and on the mock otherwise.
  for (const p of personas) rt.createPersona({ backend, ...p });
  for (const b of BOILERPLATES) rt.store.emit('boilerplate', b);
  if (!demo) {
    for (const pr of fresh.projects) rt.store.emit('project', { id: newId('pr'), ...pr });
    return true;
  }
  // The demo's conversations need the demo's agents; agents.json replaces them, and the conversations too.
  if (personas !== DEMO_PERSONAS) return true;

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
  rt.createThread({ projectId: research.id, title: 'Citation fixes', personaIds: [P('researcher')] });
  return true;
}
