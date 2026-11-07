// How long a delete waits for Undo before it purges: a session, a conversation or a persona (#208). Its own module, so
// persona-delete.mjs and runtime.mjs both read it without importing each other (#312).

export const DELETE_UNDO_MS = 10000;
