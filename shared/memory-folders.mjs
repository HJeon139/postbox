// A persona’s memory folder, named the same on this computer and on a host (#208, #491): `<root>/<persona id>`, the
// id with anything but letters, digits, _ and - replaced, so it’s always one folder under root. Postbox’s ids
// (server/ids.mjs) have nothing to replace. A host’s daemon removes the folder by this name when Postbox asks it to
// forget a deleted persona (server/remote/host/daemon-forget.mjs).

/** @param {string} id  a persona’s id */
export const memoryFolderName = (id) => String(id).replace(/[^\w-]/g, '_');
