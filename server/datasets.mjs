// Datasets an agent loads into the corpus (#47): JSON Lines files from the project’s own Postbox folder,
// .postbox/datasets/. Each is a Runtime method’s body, with the instance first, as in server/apps.mjs; moved from
// server/runtime.mjs, which keeps a one-line method that calls each.

import { realpath, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { LIMITS, limitText } from '../shared/limits.mjs';
import { parseDataset } from './corpus.mjs';
import { clip } from './helpers.mjs';
import { readCapped } from './read-capped.mjs';

const DATASET_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Where a project’s datasets live: Postbox’s own folder in the project (#47). @param {string} folder */
const datasetDir = (folder) => join(folder, '.postbox', 'datasets');

/**
 * add_dataset: loads a JSON Lines file from the project’s own Postbox folder, .postbox/datasets/, into the corpus,
 * without a restart, which would end every agent’s session. Its records are searched only when a search names the
 * dataset, so they don’t mix into other agents’ results. An event keeps it, so it’s loaded again after a restart,
 * and a line in the conversation says it was loaded. Loading the same id again replaces it.
 * @param {any} rt  the Runtime @param {string} sessionId @param {{ id?: unknown, path?: unknown, title?: unknown }} args
 */
export async function addDataset(rt, sessionId, { id, path, title } = {}) {
  const se = rt.session(sessionId);
  const project = rt.s.projects[rt.s.threads[se.threadId]?.projectId];
  const name = String(id ?? '');
  if (!DATASET_ID.test(name)) return { ok: false, message: 'A dataset id is letters, digits, - and _ (up to 64), such as “scifact-abstracts”.' };
  const taken = rt.corpus.stats().books.find((b) => b.id === name);
  if (taken && !taken.dataset) return { ok: false, message: `“${name}” is a book in the corpus. Pick another id.` };
  if (!project?.folder)
    return {
      ok: false,
      message: 'This conversation’s project has no folder, so there’s no .postbox/datasets/ to load from. Ask the person to give the project a folder.',
    };
  let raw;
  try {
    raw = await datasetFile(project.folder, path);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  let records;
  try {
    records = parseDataset(raw.text);
  } catch (e) {
    return { ok: false, message: e.message };
  }
  const meta = { title: clip(String(title ?? '') || name, 200), author: `@${se.handle}` };
  rt.corpus.addRecords(name, records, meta);
  rt.corpus.reindex();
  rt.store.emit('dataset', { id: name, projectId: project.id, path: raw.path, ...meta, records: records.length, by: se.handle, at: Date.now() });
  rt.addItem(se.threadId, { kind: 'system', variant: 'dataset', handle: se.handle, dataset: name, records: records.length });
  return {
    ok: true,
    message: `Loaded ${records.length.toLocaleString('en-US')} records as the dataset “${name}”. It’s searched only when a search names it: corpus.search with books: ["${name}"]. corpus.read with id "${name}:<record id>" reads one record.`,
  };
}

/**
 * Reads a dataset file: a path in the project’s .postbox/datasets/ (relative to it), followed through links, so a
 * link can’t lead outside it, and up to datasetBytes. The folder itself is followed too, and must be in the project’s:
 * a .postbox or datasets that links elsewhere would load any file there (#351).
 * @param {string} folder  the project’s folder @param {unknown} path
 */
export async function datasetFile(folder, path) {
  const dir = datasetDir(folder);
  if (typeof path !== 'string' || !path.trim()) throw new Error(`add_dataset needs the path of a .jsonl file in ${dir}.`);
  const [project, root] = await Promise.all([realpath(folder), realpath(dir)].map((p) => p.catch(() => null)));
  if (!root) throw new Error(`There’s no folder ${dir} yet. Write the dataset there, then load it.`);
  if (!project || !root.startsWith(project + sep)) throw new Error(`${dir} links outside the project’s folder, so Postbox doesn’t load datasets from it.`);
  const real = await realpath(resolve(root, path)).catch(() => null);
  if (!real) throw new Error(`There’s no file at ${path} in ${dir}.`);
  if (!real.startsWith(root + sep)) throw new Error(`${path} is outside ${dir}. Datasets load only from there.`);
  const st = await stat(real);
  if (!st.isFile()) throw new Error(`${path} isn’t a file.`);
  const over = () => new Error(`${path} is over ${limitText('datasetBytes')}, the limit for a dataset.`);
  if (st.size > LIMITS.datasetBytes) throw over();
  const buf = await readCapped(real, LIMITS.datasetBytes);
  if (!buf) throw over();
  return { path: relative(root, real), text: buf.toString('utf8') };
}

/** At startup: loads the datasets agents added before the restart, from where they were. Returns how many loaded. @param {any} rt */
export async function reloadDatasets(rt) {
  let n = 0;
  for (const ds of Object.values(rt.s.datasets ?? {})) {
    const folder = rt.s.projects[ds.projectId]?.folder;
    try {
      if (!folder) throw new Error('its project has no folder now');
      const { text } = await datasetFile(folder, ds.path);
      rt.corpus.addRecords(ds.id, parseDataset(text), { title: ds.title, author: ds.author });
      n++;
    } catch (e) {
      console.warn(`Couldn’t load the dataset “${ds.id}” again: ${e.message}`);
    }
  }
  if (n) rt.corpus.reindex();
  return n;
}
