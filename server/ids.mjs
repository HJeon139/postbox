// The ids Postbox makes for what it stores: conversations, items, sessions, the store’s epoch and the rest.

import { randomBytes } from 'node:crypto';

export const newId = (prefix) => `${prefix}_${randomBytes(6).toString('base64url').replace(/[-_]/g, '').slice(0, 8) || Date.now().toString(36)}`;
