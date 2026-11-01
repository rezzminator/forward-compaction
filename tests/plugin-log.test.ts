import { describe, expect, it } from 'vitest';
import { levelRow, onScreen, pluginLogDir, requeueRows } from '../plugins/forward-compaction/src/plugin-log.ts';

const NOW = Date.parse('2026-11-01T05:00:00.000Z');

describe('pluginLogDir', () => {
  it.each([
    ['/logs/', '/home/u', '/logs/p'],
    ['', '/home/u/', '/home/u/.local/state/p/logs'],
    [undefined, undefined, undefined],
  ])('override %j, home %j -> %j', (override, home, want) => {
    expect(pluginLogDir(override, home, 'p')).toBe(want);
  });
});

describe('onScreen', () => {
  it('shows error rows only', () => {
    expect((['error', 'warning', 'info', 'debug'] as const).filter(onScreen)).toEqual(['error']);
  });
});

describe('levelRow', () => {
  const fields = { plugin: 'p', level: 'info', event: 'e', msg: 'm', where: 'w' } as const;
  it('bounds an oversized row to its truncation marker', () => {
    expect(levelRow({ ...fields, detail: { body: 'x'.repeat(5000) } }, NOW)).toBe(
      '{"ts":"2026-11-01T05:00:00.000Z","plugin":"p","level":"info","event":"e","msg":"m","where":"w","detail":{"truncated":true,"bytes":5117}}\n');
  });
  it('refuses an unknown level', () => {
    expect(() => levelRow({ ...fields, level: 'loud' as never }, NOW)).toThrow('plugin log invalid level: loud');
  });
});

describe('requeueRows', () => {
  it('puts a failed batch back in front, dropping the oldest past the hold', () => {
    const pending = ['c', 'd'];
    expect(requeueRows(pending, ['a', 'b'], 3)).toBe(1);
    expect(pending).toEqual(['b', 'c', 'd']);
  });
});
