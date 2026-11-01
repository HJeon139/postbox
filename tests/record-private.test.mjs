import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PRIVATE_COLLECTIONS, PRIVATE_EVENT_TYPES, PUBLIC_EVENT_TYPES, PUBLIC_STATE_KEYS } from '../shared/record-private.mjs';
import { emptyState } from '../shared/state.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sorted = (list) => [...new Set(list)].sort();

function sources(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith('.mjs') ? [path] : [];
  });
}

test('every state key has one privacy classification and private collections really exist', () => {
  const keys = Object.keys(emptyState());
  assert.deepEqual(sorted([...PUBLIC_STATE_KEYS, ...PRIVATE_COLLECTIONS]), sorted(keys));
  assert.equal(
    PUBLIC_STATE_KEYS.some((key) => PRIVATE_COLLECTIONS.includes(key)),
    false,
  );
  assert.equal(
    PRIVATE_COLLECTIONS.every((key) => Object.hasOwn(emptyState(), key)),
    true,
  );
});

test('every literal reducer event has one public or private classification', () => {
  const state = readFileSync(join(root, 'shared/state.mjs'), 'utf8');
  const hosts = readFileSync(join(root, 'shared/state-hosts.mjs'), 'utf8');
  const accepted = [...state.matchAll(/case '([^']+)'/g), ...hosts.matchAll(/type === '([^']+)'/g)].map((m) => m[1]);
  accepted.push('session.patch'); // normalized to session before the switch
  assert.deepEqual(sorted([...PUBLIC_EVENT_TYPES, ...PRIVATE_EVENT_TYPES]), sorted(accepted));
  assert.equal(
    PUBLIC_EVENT_TYPES.some((type) => PRIVATE_EVENT_TYPES.includes(type)),
    false,
  );
});

test('private event producers stay inside the record modules and the disabled command entry', () => {
  const violations = [];
  for (const file of [...sources(join(root, 'shared')), ...sources(join(root, 'server')), ...sources(join(root, 'app/js'))]) {
    const name = relative(root, file);
    if (/^shared\/record-[^/]+\.mjs$/.test(name) || name === 'server/record-commands.mjs') continue;
    const text = readFileSync(file, 'utf8');
    if (/(?:\btype\s*:\s*|\.emit\s*\(\s*)(['"`])record(?:\.close)?\1/.test(text)) violations.push(name);
  }
  assert.deepEqual(violations, [], 'a production record producer bypassed the lifecycle entry');
});
