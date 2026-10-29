// A small Redis client: RESP2 over one TCP connection to the store’s Redis on 127.0.0.1 (designs/508/design.md,
// “Storage: a Redis 8 server that Postbox bundles and runs”). Postbox keeps zero npm dependencies, and it needs only
// commands, pipelining and errors with a code: call() sends at once, and replies come back in the order sent, so
// several calls in flight are a pipeline. When the connection drops, every call waiting on it fails with ESTOREDOWN.

import net from 'node:net';

/**
 * An error with a code to branch on.
 * @param {string} code @param {string} message @param {unknown} [cause]
 */
export const storeError = (code, message, cause) => Object.assign(new Error(message, cause === undefined ? {} : { cause }), { code });

/** One command as RESP: an array of bulk strings. @param {(string|number|Buffer)[]} args */
export function encode(args) {
  /** @type {Buffer[]} */
  const parts = [Buffer.from(`*${args.length}\r\n`)];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
    parts.push(Buffer.from(`$${b.length}\r\n`), b, Buffer.from('\r\n'));
  }
  return Buffer.concat(parts);
}

/**
 * Reads one reply from buf at pos. Returns null when it isn’t all there yet.
 * @param {Buffer} buf @param {number} pos
 * @returns {{ value: any, end: number } | null}
 */
export function decode(buf, pos) {
  const eol = buf.indexOf('\r\n', pos);
  if (eol < 0) return null;
  const head = buf.toString('utf8', pos + 1, eol);
  switch (buf[pos]) {
    case 43: // +
      return { value: head, end: eol + 2 };
    case 45: {
      // -
      const code = head.split(' ')[0];
      return { value: storeError(code, head), end: eol + 2 };
    }
    case 58: // :
      return { value: Number(head), end: eol + 2 };
    case 36: {
      // $
      const len = Number(head);
      if (len < 0) return { value: null, end: eol + 2 };
      if (buf.length < eol + 2 + len + 2) return null;
      return { value: buf.toString('utf8', eol + 2, eol + 2 + len), end: eol + 2 + len + 2 };
    }
    case 42: {
      // *
      const n = Number(head);
      if (n < 0) return { value: null, end: eol + 2 };
      const out = [];
      let at = eol + 2;
      for (let i = 0; i < n; i++) {
        const r = decode(buf, at);
        if (!r) return null;
        out.push(r.value);
        at = r.end;
      }
      return { value: out, end: at };
    }
    default:
      throw storeError('EPROTO', `Redis sent a reply Postbox can’t read (it starts with byte ${buf[pos]}).`);
  }
}

export class RedisClient {
  /** @param {{ port: number, password?: string, host?: string }} o */
  constructor({ port, password, host = '127.0.0.1' }) {
    this.port = port;
    this.host = host;
    this.password = password;
    /** @type {{ ok: (v: any) => void, fail: (e: Error) => void }[]} */
    this.pending = [];
    /** @type {Buffer} */
    this.buf = Buffer.alloc(0);
    this.socket = null;
    this.closed = false;
    /** @type {(() => void) | null} told when the connection drops */
    this.ondrop = null;
  }

  /** Connects, and authenticates when there’s a password. */
  async connect() {
    const socket = net.createConnection({ port: this.port, host: this.host });
    socket.setNoDelay(true);
    await new Promise((ok, fail) => {
      socket.once('connect', ok);
      socket.once('error', (e) => fail(storeError('ESTOREDOWN', `Couldn’t reach the store’s Redis on port ${this.port}: ${e.message}`, e)));
    });
    this.socket = socket;
    // An idle connection doesn’t keep Postbox running; one waiting on a reply does.
    socket.unref();
    socket.on('data', (chunk) => this.read(/** @type {Buffer} */ (chunk)));
    socket.on('error', () => {}); // close follows, and fails what’s pending
    socket.on('close', () => this.drop());
    if (this.password) await this.call('AUTH', this.password);
    return this;
  }

  /** @param {Buffer} chunk */
  read(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let pos = 0;
    for (;;) {
      if (pos >= this.buf.length) break;
      const r = decode(this.buf, pos);
      if (!r) break;
      pos = r.end;
      const waiter = this.pending.shift();
      if (!this.pending.length) this.socket?.unref();
      if (r.value instanceof Error) waiter?.fail(r.value);
      else waiter?.ok(r.value);
    }
    this.buf = this.buf.subarray(pos);
  }

  drop() {
    this.socket = null;
    const waiting = this.pending.splice(0);
    for (const w of waiting) w.fail(storeError('ESTOREDOWN', 'The connection to the store’s Redis closed before it answered.'));
    this.ondrop?.();
  }

  get connected() {
    return !!this.socket && !this.closed;
  }

  /**
   * Sends one command. Replies arrive in order, so calls made without awaiting form a pipeline.
   * @param {...(string|number|Buffer)} args
   */
  call(...args) {
    if (!this.socket || this.closed) return Promise.reject(storeError('ESTOREDOWN', 'The store’s Redis isn’t connected.'));
    return new Promise((ok, fail) => {
      if (!this.pending.length) this.socket?.ref();
      this.pending.push({ ok, fail });
      /** @type {net.Socket} */ (this.socket).write(encode(args));
    });
  }

  close() {
    this.closed = true;
    this.socket?.end();
    this.socket?.destroy();
  }
}
