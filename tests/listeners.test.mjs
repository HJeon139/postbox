// The “no TCP listener” check’s detector (tests/integration/listeners.mjs, #120 G2), on recorded output through a fake
// reader, so nothing here runs lsof or reads /proc. The integration test (tests/integration/remote-lifecycle.test.mjs)
// runs it on a turn’s real processes and asserts it finds nothing; these say it finds a listener when there is one.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lsofListeners, procListeners, socketInodes, tcpListeners } from './integration/listeners.mjs';

// The header recorded from `lsof -nP -iTCP -sTCP:LISTEN` on macOS; the row laid out as it prints one, with the
// command, PID, user and device made up.
const LSOF_HEADER = 'COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME';
const LSOF_ROW = 'node       4321    user   21u  IPv4 0x0123456789abcdef      0t0  TCP 127.0.0.1:4950 (LISTEN)';

// The headers recorded from /proc/net/tcp and tcp6 in node:22 under finch (Linux); the rows laid out as the kernel prints
// them (sl, local, remote, st, tx:rx, tr:when, retrnsmt, uid, timeout, inode, …), with made-up ports and inodes.
const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const tcpRow = (sl, local, st, inode) =>
  `   ${sl}: ${local} 00000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;
const TCP6_HEADER =
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const tcp6Row = (sl, local, st, inode) =>
  `   ${sl}: ${local} 00000000000000000000000000000000:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

/** PID 100 holds sockets 12345 (listening, tcp), 12346 (established) and 23456 (listening, tcp6); PID 200 holds 99999 (listening). */
const LINKS = new Map([
  [100, ['/dev/null', 'pipe:[245682]', 'socket:[12345]', 'socket:[12346]', 'socket:[23456]', 'anon_inode:[eventpoll]']],
  [200, ['socket:[99999]']],
]);
const NET = {
  '/proc/net/tcp': [
    TCP_HEADER,
    tcpRow(0, '0100007F:1356', '0A', 12345),
    tcpRow(1, '0100007F:9C40', '01', 12346),
    tcpRow(2, '00000000:1F90', '0A', 99999),
    '',
  ].join('\n'),
  '/proc/net/tcp6': [TCP6_HEADER, tcp6Row(0, '00000000000000000000000001000000:1357', '0A', 23456), ''].join('\n'),
};

/** A reader over the fixtures, recording lsof’s arguments. */
function fakeReader({ lsof = { status: 0, stdout: '', stderr: '' }, net = NET } = {}) {
  /** @type {string[][]} */
  const lsofRuns = [];
  return {
    lsofRuns,
    reader: {
      lsof: (/** @type {string[]} */ args) => {
        lsofRuns.push(args);
        return lsof;
      },
      links: (/** @type {number} */ pid) => LINKS.get(pid) ?? [],
      read: (/** @type {string} */ file) => net[file] ?? null,
    },
  };
}

test('lsof output: the LISTEN row is found, the header isn’t one, and a header alone is none', () => {
  assert.deepEqual(lsofListeners(`${LSOF_HEADER}\n${LSOF_ROW}\n`), [LSOF_ROW]);
  assert.deepEqual(lsofListeners(`${LSOF_HEADER}\n`), []);
  assert.deepEqual(lsofListeners(''), []);
});

test('macOS: tcpListeners asks lsof for these PIDs’ TCP listeners and returns its rows; exit 1 with none is none, and other failures throw', () => {
  const one = fakeReader({ lsof: { status: 0, stdout: `${LSOF_HEADER}\n${LSOF_ROW}\n`, stderr: '' } });
  assert.deepEqual(tcpListeners([4321, 77], { reader: one.reader, platform: 'darwin' }), [LSOF_ROW]);
  assert.deepEqual(one.lsofRuns, [['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', '4321,77']]);

  const none = fakeReader({ lsof: { status: 1, stdout: '', stderr: '' } });
  assert.deepEqual(tcpListeners([4321], { reader: none.reader, platform: 'darwin' }), []);

  const bad = fakeReader({ lsof: { status: 2, stdout: '', stderr: 'lsof: bad option' } });
  assert.throws(() => tcpListeners([4321], { reader: bad.reader, platform: 'darwin' }), /lsof exited 2: lsof: bad option/);
  const missing = fakeReader({ lsof: { status: null, stdout: '', stderr: '', error: new Error('spawnSync ENOENT') } });
  assert.throws(() => tcpListeners([4321], { reader: missing.reader, platform: 'darwin' }), /ENOENT/);
});

test('Linux: socketInodes maps each socket:[inode] link to its PID and ignores pipes, files and other inodes', () => {
  assert.deepEqual(
    [...socketInodes(LINKS)],
    [
      ['12345', 100],
      ['12346', 100],
      ['23456', 100],
      ['99999', 200],
    ],
  );
  assert.deepEqual([...socketInodes(new Map([[100, ['pipe:[1]', '/dev/null', 'socket:[x]']]]))], []);
});

test('Linux: a /proc/net/tcp row counts only in state 0A with an inode of these PIDs’, and the header never does', () => {
  const tcp = NET['/proc/net/tcp'];
  assert.deepEqual(procListeners(tcp, '/proc/net/tcp', new Map([['12345', 100]])), ['pid 100 listens on 0100007F:1356 (/proc/net/tcp)']);
  // 12346 is ESTABLISHED (01); 99999 listens but isn’t one of these PIDs’.
  assert.deepEqual(procListeners(tcp, '/proc/net/tcp', new Map([['12346', 100]])), []);
  assert.deepEqual(procListeners(tcp, '/proc/net/tcp', new Map()), []);
  assert.deepEqual(procListeners(TCP_HEADER, '/proc/net/tcp', new Map([['inode', 100]])), []);
});

test('Linux: tcpListeners reads both tables and finds PID 100’s two listeners, not its established socket or PID 200’s listener', () => {
  const { reader, lsofRuns } = fakeReader();
  assert.deepEqual(tcpListeners([100], { reader, platform: 'linux' }), [
    'pid 100 listens on 0100007F:1356 (/proc/net/tcp)',
    'pid 100 listens on 00000000000000000000000001000000:1357 (/proc/net/tcp6)',
  ]);
  assert.deepEqual(tcpListeners([200], { reader, platform: 'linux' }), ['pid 200 listens on 00000000:1F90 (/proc/net/tcp)']);
  assert.deepEqual(tcpListeners([300], { reader, platform: 'linux' }), [], 'a PID with no sockets, or gone, holds none');
  assert.deepEqual(lsofRuns, [], 'no lsof on Linux');

  // No tcp6 table (IPv6 off): tcp alone.
  const v4 = fakeReader({ net: { '/proc/net/tcp': NET['/proc/net/tcp'] } });
  assert.deepEqual(tcpListeners([100], { reader: v4.reader, platform: 'linux' }), ['pid 100 listens on 0100007F:1356 (/proc/net/tcp)']);
});
