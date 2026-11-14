// The Bus’s interface (designs/architecture/services.md, “Bus”): in-process signals between services. It calls each
// signal’s listeners synchronously, in the order they were registered, and a listener’s throw reaches the emitter, as a
// direct call’s did before the signal. Nothing is kept.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Bus } from '../server/bus.mjs';

test('emit calls a signal’s listeners in the order they were registered, with its data', () => {
  const bus = new Bus();
  const heard = [];
  bus.on('item.added', (d) => heard.push(['first', d]));
  bus.on('item.added', (d) => heard.push(['second', d]));
  const data = { threadId: 'th_1' };
  bus.emit('item.added', data);
  assert.deepEqual(heard, [
    ['first', data],
    ['second', data],
  ]);
});

test('emit has called every listener by the time it returns: none runs late', () => {
  const bus = new Bus();
  let ran = false;
  bus.on('item.moved', () => {
    ran = true;
  });
  bus.emit('item.moved', {});
  assert.equal(ran, true, 'the listener ran before emit returned');
});

test('a signal’s listeners hear only that signal, and a signal no one listens to does nothing', () => {
  const bus = new Bus();
  const heard = [];
  bus.on('item.added', () => heard.push('added'));
  bus.emit('item.moved', {});
  bus.emit('persona.updated', {});
  assert.deepEqual(heard, []);
});

test('a listener’s throw reaches the emitter, and the listeners after it don’t run', () => {
  const bus = new Bus();
  const heard = [];
  bus.on('item.added', () => {
    throw new Error('the listener failed');
  });
  bus.on('item.added', () => heard.push('after'));
  assert.throws(() => bus.emit('item.added', {}), /the listener failed/);
  assert.deepEqual(heard, []);
});

test('a listener registered while a signal is emitted hears the next one, not this one', () => {
  const bus = new Bus();
  const heard = [];
  bus.on('item.added', () => {
    heard.push('first');
    bus.on('item.added', () => heard.push('late'));
  });
  bus.emit('item.added', {});
  assert.deepEqual(heard, ['first']);
});
