import { cached, forget } from '../cache.mjs';
import { readAll, write } from '../store.mjs';

export async function listItems() {
  const items = await cached('items', readAll);
  return { status: 200, body: items };
}

export async function addItem(req) {
  const item = await readJson(req);
  const problem = validate(item);
  if (problem) return { status: 400, body: { error: problem } };
  const saved = await write((items) => [...items, { ...item, id: crypto.randomUUID(), added: new Date().toISOString() }]);
  forget('items');
  return { status: 201, body: saved.at(-1) };
}

function validate(item) {
  if (typeof item?.name !== 'string' || !item.name.trim()) return 'An item needs a name.';
  if (!(item.qty > 0)) return 'An item needs a quantity above zero.';
  if (!['g', 'kg', 'ml', 'l', 'pcs'].includes(item.unit)) return 'The unit is one of g, kg, ml, l or pcs.';
  return null;
}

async function readJson(req) {
  let text = '';
  for await (const chunk of req) text += chunk;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
