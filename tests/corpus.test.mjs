// Datasets an agent loads into the corpus without a restart (#47): from the project’s .postbox/datasets/, searched
// only when a search names them, and loaded again after a restart.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AdapterRegistry } from '../server/adapters/adapter.mjs';
import { Corpus, parseDataset } from '../server/corpus.mjs';
import { hostTool, Runtime } from '../server/runtime.mjs';
import { Store } from '../server/store.mjs';

const BOOK = `CHAPTER I\n\n${'The whale swam past the ship in the morning light, and the crew watched it go. '.repeat(8)}\n\nCHAPTER II\n\n${'Another day at sea, with no whale. '.repeat(12)}\n\nCHAPTER III\n\n${'The end of the voyage came at last, and the whale was not seen again. '.repeat(8)}`;
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n');

test('#47: a dataset file is JSON Lines of { id?, text, title? }, and its problems name their lines', () => {
  assert.deepEqual(parseDataset(jsonl([{ id: 'c1', text: 'Aspirin lowers fever.', title: 'Claim 1' }, { text: 'No id here.' }])), [
    { id: 'c1', text: 'Aspirin lowers fever.', title: 'Claim 1' },
    { id: '2', text: 'No id here.' },
  ]);
  assert.throws(() => parseDataset('{"text":"ok"}\nnot json\n{"id":1}'), /line 2 isn’t JSON; line 3 has no text/);
  assert.throws(
    () =>
      parseDataset(
        jsonl([
          { id: 'a', text: 'x' },
          { id: 'a', text: 'y' },
        ]),
      ),
    /line 2 repeats the id “a”/,
  );
  assert.throws(() => parseDataset('\n\n'), /no records/);
});

test('#47: a dataset is searched only when a search names it, and reads by record id', () => {
  const c = new Corpus();
  c.addBook('moby', BOOK, { title: 'Moby', author: 'H', year: 1851 });
  c.addRecords('claims', parseDataset(jsonl([{ id: 'c1', text: 'The whale protein binds to the receptor.' }])), { title: 'Claims', author: '@researcher' });
  c.reindex();
  assert.ok(c.search('whale').length > 0);
  assert.ok(!c.search('whale').some((h) => h.book === 'claims'), 'not in a search that doesn’t name it');
  assert.ok(!c.search('whale', { mode: 'semantic' }).some((h) => h.book === 'claims'));
  assert.deepEqual(
    c.search('whale protein', { books: ['claims'] }).map((h) => h.id),
    ['claims:c1'],
  );
  assert.equal(c.read('claims:c1').text, 'The whale protein binds to the receptor.');
  assert.deepEqual(
    c.stats().books.map((b) => [b.id, b.dataset ?? false, b.passages]),
    [
      ['moby', false, c.stats().books[0].passages],
      ['claims', true, 1],
    ],
  );
  // Loading the same id again replaces it.
  c.addRecords('claims', parseDataset(jsonl([{ id: 'c2', text: 'A second claim.' }])), { title: 'Claims', author: '@researcher' });
  c.reindex();
  assert.equal(c.read('claims:c1'), null);
  assert.equal(c.search('claim', { books: ['claims'] }).length, 1);
});

/** A runtime whose project lives in a temp folder, with a real corpus. */
async function setup(dir) {
  const root = dir ?? (await mkdtemp(join(tmpdir(), 'pb-datasets-')));
  const store = new Store(null);
  const corpus = new Corpus();
  corpus.addBook('moby', BOOK, { title: 'Moby', author: 'H', year: 1851 });
  corpus.reindex();
  const rt = new Runtime({
    store,
    adapters: new AdapterRegistry().register({ name: 'mock', deliver: async () => {} }),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [], lintSettleMs: 0 },
  });
  store.emit('project', { id: 'p1', name: 'P', folder: root });
  const a = rt.createPersona({ handle: 'researcher' });
  const t = rt.createThread({ projectId: 'p1', title: 'T', personaIds: [a.id] });
  const se = rt.sessionsIn(t.id)[0];
  const dsDir = join(root, '.postbox', 'datasets');
  await mkdir(dsDir, { recursive: true });
  return { root, dsDir, store, corpus, rt, t, se, tools: rt.toolsFor(se.id) };
}

test('#47: add_dataset loads a file from the project’s .postbox/datasets/ at once, with a line in the conversation', async () => {
  const { dsDir, store, rt, t, tools } = await setup();
  await writeFile(
    join(dsDir, 'scifact-claims.jsonl'),
    jsonl([
      { id: 'c1', text: 'Vitamin D reduces fractures.' },
      { id: 'c2', text: 'Coffee and sleep.' },
    ]),
  );
  const r = await tools.add_dataset({ id: 'scifact-claims', path: 'scifact-claims.jsonl', title: 'SciFact claims' });
  assert.equal(r.ok, true, r.message);
  assert.match(r.message, /Loaded 2 records as the dataset “scifact-claims”.*books: \["scifact-claims"\]/);
  // An app reads it through the bridge’s tools the same way, with no restart.
  assert.equal(hostTool(rt, 'corpus.read', { id: 'scifact-claims:c1' }).text, 'Vitamin D reduces fractures.');
  assert.equal(hostTool(rt, 'corpus.search', { query: 'vitamin', books: ['scifact-claims'] }).length, 1);
  assert.equal(hostTool(rt, 'corpus.search', { query: 'vitamin' }).length, 0, 'other agents’ searches don’t get it');
  assert.deepEqual(store.state.datasets['scifact-claims'], {
    ...store.state.datasets['scifact-claims'],
    projectId: 'p1',
    path: 'scifact-claims.jsonl',
    records: 2,
    by: 'researcher',
  });
  const line = store.items(t.id).at(-1);
  assert.deepEqual([line.kind, line.variant, line.dataset, line.records], ['system', 'dataset', 'scifact-claims', 2]);
  assert.match(rt.describeItem(line), /@researcher loaded the dataset “scifact-claims” \(2 records\)/);
});

test('#47: add_dataset reads only from .postbox/datasets/, by path or link, and refuses a bad id or file', async () => {
  const { root, dsDir, rt, store, tools } = await setup();
  await writeFile(join(root, 'secret.jsonl'), jsonl([{ text: 'not a dataset' }]));
  await symlink(join(root, 'secret.jsonl'), join(dsDir, 'link.jsonl'));
  for (const path of ['../../secret.jsonl', join(root, 'secret.jsonl'), 'link.jsonl'])
    assert.match((await tools.add_dataset({ id: 'x', path })).message, /outside .*\.postbox\/datasets/, path);
  assert.match((await tools.add_dataset({ id: 'x', path: 'missing.jsonl' })).message, /no file at missing\.jsonl/);
  assert.match((await tools.add_dataset({ id: 'bad id!', path: 'x.jsonl' })).message, /letters, digits/);
  assert.match((await tools.add_dataset({ id: 'moby', path: 'x.jsonl' })).message, /is a book in the corpus/);
  await writeFile(join(dsDir, 'broken.jsonl'), '{"text":"ok"}\n{oops');
  assert.match((await tools.add_dataset({ id: 'x', path: 'broken.jsonl' })).message, /line 2 isn’t JSON/);
  assert.deepEqual(store.state.datasets, {});
  assert.equal(rt.corpus.stats().books.length, 1);
});

test('#351: add_dataset refuses a .postbox or datasets folder that links out of the project', async () => {
  for (const linked of ['.postbox', join('.postbox', 'datasets')]) {
    const root = await mkdtemp(join(tmpdir(), 'pb-datasets-'));
    const outside = await mkdtemp(join(tmpdir(), 'pb-outside-'));
    await mkdir(join(outside, 'datasets'));
    await writeFile(join(outside, 'datasets', 'x.jsonl'), jsonl([{ text: 'not the project’s' }]));
    await writeFile(join(outside, 'x.jsonl'), jsonl([{ text: 'not the project’s' }]));
    await mkdir(join(root, '.postbox'), { recursive: true });
    if (linked === '.postbox') await rm(join(root, '.postbox'), { recursive: true });
    await symlink(outside, join(root, linked));
    const { rt, store, tools } = await setup(root);
    assert.match((await tools.add_dataset({ id: 'x', path: 'x.jsonl' })).message, /outside the project’s folder/, linked);
    assert.deepEqual(store.state.datasets, {});
    assert.equal(rt.corpus.stats().books.length, 1);
  }
});

test('#47: a project with no folder has nowhere to load from, and says so', async () => {
  const { rt, store, tools } = await setup();
  store.emit('project', { ...store.state.projects.p1, folder: null });
  assert.match((await tools.add_dataset({ id: 'x', path: 'x.jsonl' })).message, /no folder/);
  assert.equal(rt.corpus.stats().books.length, 1);
});

test('#47: datasets are loaded again after a restart, from where they were', async () => {
  const first = await setup();
  await writeFile(join(first.dsDir, 'claims.jsonl'), jsonl([{ id: 'c1', text: 'Vitamin D reduces fractures.' }]));
  assert.equal((await first.tools.add_dataset({ id: 'claims', path: 'claims.jsonl' })).ok, true);
  // A new server: the same state, a fresh corpus with only the books.
  const corpus = new Corpus();
  corpus.addBook('moby', BOOK, { title: 'Moby', author: 'H', year: 1851 });
  corpus.reindex();
  const rt = new Runtime({
    store: first.store,
    adapters: new AdapterRegistry().register({ name: 'mock', deliver: async () => {} }),
    corpus,
    config: { origin: 'http://127.0.0.1:1', imageOrigins: [] },
  });
  assert.equal(await rt.reloadDatasets(), 1);
  assert.equal(corpus.read('claims:c1').text, 'Vitamin D reduces fractures.');
  assert.equal(corpus.search('vitamin', { books: ['claims'] }).length, 1);
});

test('#351: corpus_search returns 1 to 50 results whatever k says, and reads at most 50 book ids', async () => {
  const { rt, corpus, tools } = await setup();
  corpus.addRecords('many', parseDataset(jsonl(Array.from({ length: 120 }, (_, i) => ({ id: `r${i}`, text: `Whale sighting number ${i}.` })))), {
    title: 'Many',
    author: '@researcher',
  });
  corpus.reindex();
  const found = (args) => tools.corpus_search({ query: 'whale sighting', books: ['many'], ...args }).results.length;
  assert.deepEqual(
    [-1, -200, 0.5, 2.9, 1000, 'x'].map((k) => found({ k })),
    [1, 1, 1, 2, 50, 12],
  );
  // A list of ids past 50 is read only to its 50th, as an app’s query through the bridge is.
  assert.equal(found({ books: [...Array.from({ length: 50 }, (_, i) => `b${i}`), 'many'] }), 0);
  assert.equal(hostTool(rt, 'corpus.search', { query: 'whale sighting', books: ['many'], k: -1 }).length, 1);
});
