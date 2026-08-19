import assert from 'node:assert/strict';
import { test, describe, before, after } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FOREVER, createCache } from '../core/cache.mjs';

let dir;
before(() => {
  dir = mkdtempSync(join(tmpdir(), 'wf-cache-test-'));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('cache', () => {
  test('survives a round trip through disk', () => {
    const a = createCache('roundtrip', { dir });
    assert.equal(a.get('k'), undefined, 'cold read is a miss');
    a.set('k', { price: 1234.5 }, FOREVER);
    a.flush();

    const b = createCache('roundtrip', { dir });
    assert.deepEqual(b.get('k'), { price: 1234.5 });
    assert.equal(b.stats().hits, 1);
  });

  test('a FOREVER entry does not expire', () => {
    let clock = 1_000;
    const c = createCache('forever', { dir, now: () => clock });
    c.set('k', 'v', FOREVER);
    clock += 10 ** 12; // decades later
    assert.equal(c.get('k'), 'v');
  });

  test('a TTL entry expires and stops being returned', () => {
    let clock = 1_000;
    const c = createCache('ttl', { dir, now: () => clock });
    c.set('k', 'v', 5_000);

    clock += 4_999;
    assert.equal(c.get('k'), 'v', 'still fresh');

    clock += 2;
    assert.equal(c.get('k'), undefined, 'expired');
    assert.equal(c.get('k'), undefined, 'stays expired');
  });

  test('null is a cacheable value, distinct from a miss', () => {
    // Recording a known absence matters: re-asking CoinGecko for a day it has
    // no data on costs a full request and returns nothing again.
    const c = createCache('nulls', { dir });
    c.set('absent', null, FOREVER);
    assert.equal(c.get('absent'), null, 'null round-trips');
    assert.equal(c.get('never-set'), undefined, 'a miss is undefined');
  });

  test('undefined is never stored', () => {
    const c = createCache('undef', { dir });
    c.set('k', undefined, FOREVER);
    assert.equal(c.stats().size, 0);
  });

  test('disabled cache reads and writes nothing', () => {
    const c = createCache('off', { dir, disabled: true });
    c.set('k', 'v', FOREVER);
    c.flush();
    assert.equal(c.get('k'), undefined);
    assert.equal(existsSync(join(dir, 'off.json')), false, 'no file written');
  });

  test('a corrupt cache file degrades to empty rather than throwing', () => {
    // A half-written file from an interrupted run must cost time, not the run.
    writeFileSync(join(dir, 'corrupt.json'), '{"entries": {"a": ');
    const c = createCache('corrupt', { dir });
    assert.doesNotThrow(() => c.get('a'));
    assert.equal(c.get('a'), undefined);

    c.set('a', 1, FOREVER);
    c.flush();
    assert.equal(createCache('corrupt', { dir }).get('a'), 1, 'recovers on next write');
  });

  test('flush with nothing dirty writes no file', () => {
    const c = createCache('clean', { dir });
    c.get('nothing');
    c.flush();
    assert.equal(existsSync(join(dir, 'clean.json')), false);
  });

  test('hit and miss counts reflect what was actually served', () => {
    const c = createCache('stats', { dir });
    c.get('a'); // miss
    c.set('a', 1, FOREVER);
    c.get('a'); // hit
    c.get('a'); // hit
    c.get('b'); // miss
    const s = c.stats();
    assert.equal(s.hits, 2);
    assert.equal(s.misses, 2);
    assert.equal(s.size, 1);
  });
});
