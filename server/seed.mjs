// First-run content. A fresh install gets three generic agents (a researcher, a developer and a critic) and nothing
// else; --demo gets the reading-notes agents, two projects and a few empty conversations, with a few text assets in the
// asset explorer’s and the indexer’s, which the demo, the screenshots and the tests play. Both get the new-agent boilerplates. agents.json in the data folder, if present, seeds the agents
// instead, in either mode (see README).

import { readFileSync } from 'node:fs';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_MODEL } from '../shared/agent-facts.mjs';
import { blobsOf } from './asset-tools.mjs';
import { writeAsset } from './assets.mjs';
import { agentFolderPath } from './folder-path.mjs';
import { httpError } from './helpers.mjs';
import { handleOf } from './persona-checks.mjs';
import { newId } from './store.mjs';

// Read once, when the module loads: freshInstall() is synchronous, and the UAT's checks call it as well as seed().
const prompt = (name) => readFileSync(new URL(`./personas/${name}.md`, import.meta.url), 'utf8').trim();
const RESEARCHER = prompt('researcher');
const DEVELOPER = prompt('developer');
const CRITIC = prompt('critic');
const GEMINI = prompt('gemini');

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

/** The demo's agents, which work on the reading notes kept as the asset explorer conversation's assets. */
export const DEMO_PERSONAS = [
  {
    handle: 'librarian',
    description: 'Explores your notes and builds tools to search them.',
    tools: [],
    instructions: 'Help the person explore the conversation’s assets. Build apps when a tool would explain better than prose.',
    examples: [
      ['Build me an explorer for these assets', 'An interactive search across every note'],
      ['Show me every kind of block you can send', 'One of each, all live'],
      ['Explain lexical and semantic search', 'With examples from your own books'],
    ],
  },
  {
    handle: 'indexer',
    description: 'Builds and maintains the search indexes.',
    tools: ['shell'],
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
    description: 'Reads papers and explains them with a picture you can change.',
    tools: ['web.fetch', 'arxiv.search', 'narrate.speak'],
    instructions:
      'Cite sources. When you explain visually, use one picture that carries the idea and one control that visibly changes it; a predict-first question is fine if the picture shows first. Add practice or a quiz only when the person asks for it.',
    examples: [
      ['Explain ReAct with something I can try', 'Citations, a diagram, math and practice'],
      ['Walk me through ReAct, out loud', 'Slides that follow a local voice'],
      ['Which agent memory papers should I read?', 'A choice that needs you'],
    ],
  },
  {
    handle: 'critic',
    description: 'Reviews specs, code and layouts line by line.',
    tools: [],
    instructions: 'Review carefully. Resolve what you fix, and explain what you leave open.',
    examples: [['Review my search schema line by line', 'Comment on the spec, then get a revision']],
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
    id: 'bp-gemini',
    name: 'Gemini',
    description: 'Collaborates, compares options and gives a second opinion on Gemini',
    instructions: GEMINI,
    tools: ['shell', 'web.fetch'],
    backend: 'antigravity-cli',
    model: GEMINI_MODEL,
  },
  {
    id: 'bp-gpt',
    name: 'GPT',
    description: 'Helps with questions, writing and code using Codex',
    backend: 'codex',
    model: '',
    instructions: prompt('gpt'),
    tools: ['shell', 'web.fetch'],
  },
  { id: 'bp-blank', name: 'Blank', description: 'Write it yourself', instructions: '', tools: [] },
];

export const toBoilerplate = (p) => ({
  id: newId('bp'),
  name: `@${p.handle}`,
  description: p.description,
  instructions: p.instructions,
  tools: p.tools,
  ...(p.backend && p.backend !== 'mock' ? { backend: p.backend, model: p.model } : {}),
});

export const KNOWN_TOOLS = [
  ['web.fetch', 'Fetch web pages'],
  ['arxiv.search', 'Search arXiv'],
  ['shell', 'Run commands in the project folder'],
  ['narrate.speak', 'Read text aloud with a local voice'],
];

/**
 * Refuses agents.json before any of its agents is made, with the reason naming the file and the agent (#990). It checks
 * only each one’s name, as createPersona reads it, that no two share one, and each one’s folder: an agents.json that fails
 * one of those seeds none of its agents. Its other fields (backend, permission mode, effort, setup, host) are checked
 * only by createPersona, agent by agent, so one of those refused can still stop seeding partway, with the agents before
 * it made. The built-in agents pass.
 * @param {unknown[]} personas
 */
function checkAgents(personas) {
  const seen = new Set();
  personas.forEach((p, i) => {
    let handle;
    try {
      handle = handleOf(/** @type {any} */ (p)?.handle);
    } catch (e) {
      throw httpError(e.status, `agents.json: agent ${i + 1}: ${e.message}`);
    }
    if (seen.has(handle.toLowerCase())) throw httpError(409, `agents.json: agent ${i + 1}: @${handle} is there twice. Give each agent a name of its own.`);
    seen.add(handle.toLowerCase());
    try {
      agentFolderPath(/** @type {any} */ (p).folder);
    } catch (e) {
      throw httpError(e.status, `agents.json: @${handle}’s folder: ${e.message}`);
    }
  });
}

/**
 * @param {any} rt
 * @param {{ dataDir: string, backend?: string, demo?: boolean }} opts  backend: what the seeded agents run on
 */
export async function seed(rt, { dataDir, backend = 'mock', demo = false }) {
  const s = rt.store.state;
  if (Object.keys(s.personas).length) {
    if (!BOILERPLATES.every((b) => s.boilerplates[b.id])) {
      const custom = Object.values(s.boilerplates).filter((b) => !BOILERPLATES.some((x) => x.id === b.id));
      for (const b of [...BOILERPLATES, ...custom]) rt.store.emit('boilerplate', b);
    }
    return false;
  }
  const fresh = freshInstall();
  let personas = demo ? DEMO_PERSONAS : fresh.personas;
  try {
    const custom = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8'));
    if (Array.isArray(custom) && custom.length) personas = custom;
  } catch {
    /* no agents.json: use the defaults */
  }
  checkAgents(personas);
  // The seeded agents run on a real model when one is available here, and on the mock otherwise.
  for (const p of personas) rt.createPersona({ backend, ...p });
  for (const b of BOILERPLATES) rt.store.emit('boilerplate', b);
  if (!demo) {
    for (const pr of fresh.projects) rt.store.emit('project', { id: newId('pr'), ...pr });
    return true;
  }
  // The demo's conversations need the demo's agents; agents.json replaces them, and the conversations too.
  if (personas !== DEMO_PERSONAS) return true;

  const notesDir = join(dataDir, 'notes');
  const researchDir = join(dataDir, 'research');
  // The notes are the project folder’s files too, as a person’s own would be, for the folder picker and path writes.
  await cp(DEMO_ASSETS, notesDir, { recursive: true, force: false });
  await mkdir(researchDir, { recursive: true });
  const notes = { id: newId('pr'), name: 'Reading notes', folder: notesDir };
  const research = { id: newId('pr'), name: 'Agent research', folder: researchDir };
  rt.store.emit('project', notes);
  rt.store.emit('project', research);
  const P = (h) => rt.personaByHandle(h).id;
  const explorer = rt.createThread({ projectId: notes.id, title: 'Asset explorer', personaIds: [P('librarian')] });
  await seedAssets(rt, explorer.id);
  const shelf = rt.createThread({ projectId: notes.id, title: 'Index the shelf', personaIds: [P('indexer')] });
  await seedAssets(rt, shelf.id);
  rt.createThread({ projectId: notes.id, title: 'Search schema spec', personaIds: [P('critic')] });
  rt.createThread({ projectId: notes.id, title: 'Catalog tour', personaIds: [P('librarian')] });
  rt.createThread({ projectId: notes.id, title: 'Index planning', personaIds: [P('indexer'), P('researcher')] });
  rt.createThread({ projectId: research.id, title: 'ReAct, step by step', personaIds: [P('researcher')] });
  rt.createThread({ projectId: research.id, title: 'Agent memory papers', personaIds: [P('researcher')] });
  rt.createThread({ projectId: research.id, title: 'Citation fixes', personaIds: [P('researcher')] });
  return true;
}

/** The demo’s text assets (server/demo-assets/), published to the asset explorer’s and the shelf’s rooms as @librarian’s. */
const DEMO_ASSETS = fileURLToPath(new URL('./demo-assets/', import.meta.url));

/**
 * Publishes the demo’s text assets to a room, each under its path in server/demo-assets/, so the explorer has notes to
 * search. A Postbox with no data folder keeps no assets, and gets none.
 * @param {any} rt @param {string} room
 */
async function seedAssets(rt, room) {
  const blobs = blobsOf(rt);
  if (!blobs) return;
  const files = (await readdir(DEMO_ASSETS, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  for (const path of files.map((e) => join(e.parentPath, e.name)).sort()) {
    const req = { kind: 'write', room, name: relative(DEMO_ASSETS, path), bytes: await readFile(path), type: 'text/markdown', author: 'librarian' };
    const r = await writeAsset(rt.store, blobs, req);
    if (!r.ok) throw new Error(`Couldn’t seed the demo asset ${req.name}: ${r.message}`);
  }
}
