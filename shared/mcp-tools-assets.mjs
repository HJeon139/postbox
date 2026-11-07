// The asset tools’ definitions (#516 S3b; their handlers are server/asset-tools.mjs): files a conversation keeps, each
// a list of versions. shared/mcp-tools.mjs lists them with the others, which the shim on a remote host serves too, so
// this file imports only shared/, as host code must (#120).

import { ASSETS, limitText, READING } from './limits.mjs';

const count = (/** @type {number} */ k) => k.toLocaleString('en-US');
const bound = (/** @type {keyof typeof ASSETS} */ name) => limitText(/** @type {any} */ (name), /** @type {any} */ (ASSETS));

const id = { type: 'string', description: 'The asset’s id, from list_assets, such as as_4kQ2xY9a.' };
const base = { type: 'number', description: 'The version you read and are writing from: the newest, or the write is refused.' };
const op = { type: 'string', description: 'A name you choose for this write (letters, digits, - and _), so a retry makes no second version.' };
const write = (/** @type {Record<string, any>} */ properties, /** @type {string[]} */ required) => ({
  type: 'object',
  properties: { ...properties, op },
  required,
});

export const ASSET_TOOLS = [
  {
    name: 'list_assets',
    description: `List the files this conversation keeps, its assets, ${count(ASSETS.listPage)} a page: each one’s id, name, newest version, author, size and type. Deleted ones are listed too, so they can be restored.`,
    inputSchema: { type: 'object', properties: { page: { type: 'number' } } },
  },
  {
    name: 'read_asset',
    description: `Read one version of an asset: the newest, or version. Text comes in parts of ${count(READING.part)} characters, and each part says how to read on with that version, so the parts are one version even if someone writes meanwhile. A binary, deleted or pruned version gives what’s known of it.`,
    inputSchema: {
      type: 'object',
      properties: { id, version: { type: 'number' }, from: { type: 'number', description: 'The character of the content to start from.' } },
      required: ['id'],
    },
  },
  {
    name: 'write_asset',
    description: `Publish a file to this conversation as a new asset (name, no base) or a new version of one (id and base). Send its text, or path to a file in your folder (up to ${bound('assetBytes')}). Names are paths in the conversation, such as notes/plan.md, unique ignoring case. Every version is kept, except that large binaries keep their last ${count(ASSETS.binaryVersionsKept)}; the conversation keeps up to ${bound('roomBytes')} in all. On a remote host, text only.`,
    inputSchema: write(
      {
        name: { type: 'string' },
        id,
        base,
        text: { type: 'string' },
        path: { type: 'string', description: 'A file in your folder, in place of text.' },
        type: { type: 'string', description: 'Its media type, such as text/markdown. Without it, Postbox picks one from the name.' },
      },
      [],
    ),
  },
  {
    name: 'rename_asset',
    description:
      'Give a live asset a new name, as a new version with the same content. To rename a deleted one, bring it back first, with restore_asset or a write_asset to its id and base.',
    inputSchema: write({ id, base, name: { type: 'string' } }, ['id', 'base', 'name']),
  },
  {
    name: 'delete_asset',
    description: 'Delete an asset, as a new version with no content. Its earlier versions stay, so restore_asset can bring one back.',
    inputSchema: write({ id, base }, ['id', 'base']),
  },
  {
    name: 'restore_asset',
    description: 'Make an earlier version of an asset the newest again, as a new version with its content. A pruned version can’t be restored.',
    inputSchema: write({ id, base, version: { type: 'number', description: 'The version to bring back.' } }, ['id', 'version', 'base']),
  },
];
