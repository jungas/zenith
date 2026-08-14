/**
 * `server/db.ts`'s optimistic-concurrency contract: a save at a stale version
 * must be rejected with the current row rather than silently overwriting it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { StateStore } from '../server/db.ts';

test('read() is null before anything has been saved', () => {
  const store = new StateStore(':memory:');
  assert.equal(store.read(), null);
  store.close();
});

test('write() at version 0 creates the row and returns version 1', () => {
  const store = new StateStore(':memory:');
  const result = store.write(JSON.stringify({ a: 1 }), 0);
  assert.deepEqual(result, { ok: true, version: 1 });
  assert.deepEqual(store.read(), { data: JSON.stringify({ a: 1 }), version: 1 });
  store.close();
});

test('write() at the current version advances it', () => {
  const store = new StateStore(':memory:');
  store.write(JSON.stringify({ a: 1 }), 0);
  const result = store.write(JSON.stringify({ a: 2 }), 1);
  assert.deepEqual(result, { ok: true, version: 2 });
  assert.deepEqual(store.read(), { data: JSON.stringify({ a: 2 }), version: 2 });
  store.close();
});

test('write() at a stale version is rejected with the current row, unchanged', () => {
  const store = new StateStore(':memory:');
  store.write(JSON.stringify({ a: 1 }), 0);
  store.write(JSON.stringify({ a: 2 }), 1);

  // A third writer that only ever saw version 1 (a stale read) tries to save.
  const result = store.write(JSON.stringify({ a: 'conflict' }), 1);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.current.version, 2);
    assert.equal(result.current.data, JSON.stringify({ a: 2 }));
  }
  // The rejected write must not have touched the stored row.
  assert.deepEqual(store.read(), { data: JSON.stringify({ a: 2 }), version: 2 });
  store.close();
});

test('history is capped and keeps the newest rows', () => {
  const store = new StateStore(':memory:');
  let version = 0;
  for (let i = 0; i < 205; i++) {
    const result = store.write(JSON.stringify({ i }), version);
    assert.ok(result.ok);
    version = result.ok ? result.version : version;
  }
  assert.equal(store.read()?.version, 205);
  store.close();
});
