import { describe, expect, it } from 'vitest';
import { TtlCache } from '../../src/util/ttl-cache.js';

describe('TtlCache', () => {
  it('expires entries after the ttl', () => {
    let now = 0;
    const cache = new TtlCache<number>(1000, () => now);
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    now = 1000;
    expect(cache.get('a')).toBeUndefined();
  });

  it('caches the factory result in getOrCreate', async () => {
    const cache = new TtlCache<number>(1000);
    let calls = 0;
    const factory = async () => ++calls;
    expect(await cache.getOrCreate('k', factory)).toBe(1);
    expect(await cache.getOrCreate('k', factory)).toBe(1);
    expect(calls).toBe(1);
  });

  it('does not cache failures', async () => {
    const cache = new TtlCache<number>(1000);
    await expect(cache.getOrCreate('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await cache.getOrCreate('k', async () => 7)).toBe(7);
  });
});