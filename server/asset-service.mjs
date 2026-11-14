// Assets (designs/architecture/services.md, “Assets”): the files of a conversation and its agents. The room’s assets
// and their blobs (server/assets.mjs, asset-tools.mjs, asset-search.mjs), a message’s attachments
// (message-attachments.mjs), the files an agent reads from its folders and the ones Postbox stores for it, an app’s
// (agent-files.mjs) and a review’s images (review-files.mjs). Assets is a service: Runtime’s constructor builds it with
// the store, Sessions, Personas, Placement and the blobs, and its modules take it, never the runtime.

import { agentFile, agentFolders, appFiles } from './agent-files.mjs';
import { listTextAssets, searchAssets } from './asset-search.mjs';
import { assetTools, blobsOf } from './asset-tools.mjs';
import { attachmentPath, sentAttachments } from './message-attachments.mjs';
import { blockFiles, servedReviewFile, storeReviewFiles } from './review-files.mjs';

export class Assets {
  /**
   * @param {{ store: import('./store.mjs').Store, sessions: { get: (id: string) => any },
   *           personas: { forSession: (se: any) => any }, placement: { requestAdapter: (handle: string, persona: any) => any },
   *           blobs: import('./blobs.mjs').Blobs | null }} deps
   *   blobs: where Postbox stores files by their hash, or null for a Postbox that can’t
   */
  constructor({ store, sessions, personas, placement, blobs }) {
    this.store = store;
    this.sessions = sessions;
    this.personas = personas;
    this.placement = placement;
    this.blobs = blobs;
  }

  // ── Files an agent names (#54, #780) ───────────────────────────────────────────────

  /** The folders an agent works in: its own (where it starts), the project’s, and any added. @param {string} sessionId */
  agentFolders(sessionId) {
    return agentFolders(this, sessionId);
  }

  /**
   * A file an agent named, read from its folders under a limit (agent-files.mjs).
   * @param {string} sessionId @param {unknown} path @param {number} max @param {string} what
   * @param {{ afterCheck?: () => unknown, afterOpen?: () => unknown, beforeRead?: () => unknown }} [hooks]
   */
  agentFile(sessionId, path, max, what, hooks) {
    return agentFile(this, sessionId, path, max, what, hooks);
  }

  /** show_app’s and update_app’s code and data files, read and stored. @param {string} sessionId @param {any} args */
  appFiles(sessionId, args) {
    return appFiles(this, sessionId, args);
  }

  // ── A message’s attachments (#991) ─────────────────────────────────────────────────

  /** The attachments to store and deliver, each with only what Postbox knows of it. @param {unknown} list */
  sentAttachments(list) {
    return sentAttachments(this, list);
  }

  /** Where an attachment can be read on disk: a stored upload, or a file in the project’s folder. @param {string} threadId @param {any} a */
  attachmentPath(threadId, a) {
    return attachmentPath(this, threadId, a);
  }

  // ── A review’s images (#780) ───────────────────────────────────────────────────────

  /**
   * The files a show_block or update_block of a review carries, read from the agent’s folders, or by `read`.
   * @param {string} sessionId @param {string} name  the tool @param {any} args @param {(f: any, max: number, what: string) => Promise<Buffer>} [read]
   */
  blockFiles(sessionId, name, args, read) {
    return blockFiles(this, sessionId, name, args, read);
  }

  /** Checks and stores the files a review names. @param {unknown} wanted @param {(f: any, max: number, what: string) => Promise<Buffer>} read */
  storeReviewFiles(wanted, read) {
    return storeReviewFiles(this, wanted, read);
  }

  /** A review’s image as its route answers it, or null. @param {string} threadId @param {string} itemId @param {string} name @param {string} sha256 */
  servedReviewFile(threadId, itemId, name, sha256) {
    return servedReviewFile(this, threadId, itemId, name, sha256);
  }

  // ── The room’s assets (#516) ───────────────────────────────────────────────────────

  /** The asset blob folder, assets/ beside the store’s log, or null for a store kept in memory. */
  roomBlobs() {
    return blobsOf(this);
  }

  /** The asset tools an agent calls in its room. @param {string} sessionId @param {any} turn @param {{ onHost?: boolean }} [opts] */
  tools(sessionId, turn, opts) {
    return assetTools(this, sessionId, turn, opts);
  }

  /** The room’s text assets searched, best first; [] without an asset folder. @param {string} room @param {any} args */
  async search(room, args) {
    const blobs = this.roomBlobs();
    return blobs ? searchAssets(this, blobs, room, args) : [];
  }

  /** The room’s text assets, as search reads them; [] without an asset folder. @param {string} room */
  async listText(room) {
    const blobs = this.roomBlobs();
    return blobs ? listTextAssets(this, blobs, room) : [];
  }
}
