import { describe, expect, it } from 'vitest';
import { formatSize, OPTION_ENV, parseEnvFlag, parseSize, resolveOptions, sizeTokens } from '../plugins/forward-compaction/src/options.ts';
import { optionVars } from './option-env.ts';

describe('parseSize and sizeTokens', () => {
  it('reads a percentage against the window and a k value as tokens (R1)', () => {
    const ceiling = parseSize('60%');
    expect(ceiling).toEqual({ ok: true, value: { percent: 60 } });
    expect(sizeTokens((ceiling as { value: { percent: number } }).value, 200_000)).toBe(120_000);
    expect(parseSize('100k')).toEqual({ ok: true, value: { tokens: 100_000 } });
    expect(parseSize(' 0.6m ')).toEqual({ ok: true, value: { tokens: 600_000 } });
    expect(parseSize(70_000)).toEqual({ ok: true, value: { tokens: 70_000 } });
  });

  it('names a value it cannot read', () => {
    for (const bad of ['abc', '0', '0%', '101%', '-5', '', null, {}]) expect(parseSize(bad).ok, String(bad)).toBe(false);
    expect(parseSize('abc')).toEqual({ ok: false, error: 'not an integer, a k/m value or a percentage: "abc"' });
  });

  it('writes a size the way a person does', () => {
    expect(formatSize({ percent: 60 })).toBe('60%');
    expect(formatSize({ tokens: 50_000 })).toBe('50000');
  });
});

describe('parseEnvFlag', () => {
  it('reads 1, 0, true and false in any case', () => {
    for (const [raw, value] of [['1', true], ['TRUE', true], [' true ', true], ['0', false], ['False', false]] as const) expect(parseEnvFlag(raw)).toEqual({ ok: true, value });
    expect(parseEnvFlag('yes')).toEqual({ ok: false, error: 'not 1, 0, true or false: "yes"' });
  });
});

describe('resolveOptions', () => {
  it('holds the defaults with nothing set', () => {
    expect(resolveOptions()).toEqual({ ceiling: { percent: 60 }, ceilingNative: false, nudgeStart: { tokens: 50_000 }, nudgeEvery: { tokens: 10_000 }, errors: [] });
  });

  it('keeps the variable name of each option, all under FORWARD_COMPACTION_', () => {
    expect(OPTION_ENV).toEqual({
      ceiling: 'FORWARD_COMPACTION_CEILING',
      ceilingNative: 'FORWARD_COMPACTION_CEILING_NATIVE',
      nudgeStart: 'FORWARD_COMPACTION_NUDGE_START',
      nudgeEvery: 'FORWARD_COMPACTION_NUDGE_EVERY',
      logFile: 'FORWARD_COMPACTION_LOG_FILE',
    });
  });

  it('names a bad size by its variable and falls back to the default (R3)', () => {
    const resolved = resolveOptions({ vars: { FORWARD_COMPACTION_CEILING: 'abc' } });
    expect(resolved.errors[0]).toBe('forward-compaction: env FORWARD_COMPACTION_CEILING is invalid (not an integer, a k/m value or a percentage: "abc"); using the default 60%');
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.ceiling).toEqual({ percent: 60 });
  });

  it('reads the native flag, and treats a blank value as unset with no error (R4)', () => {
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_CEILING_NATIVE: '1' } }).ceilingNative).toBe(true);
    const blank = resolveOptions({ vars: { FORWARD_COMPACTION_CEILING_NATIVE: '  ' } });
    expect(blank.ceilingNative).toBe(false);
    expect(blank.errors).toEqual([]);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_CEILING_NATIVE: 'maybe' } }).errors).toEqual(['forward-compaction: env FORWARD_COMPACTION_CEILING_NATIVE is invalid (not 1, 0, true or false: "maybe"); using the default false']);
  });

  it('reads every size option through the test helper', () => {
    const resolved = resolveOptions({ vars: optionVars({ ceiling: '80k', nudgeStart: '30k', nudgeEvery: '5k', ceilingNative: true }) });
    expect(resolved).toMatchObject({ ceiling: { tokens: 80_000 }, nudgeStart: { tokens: 30_000 }, nudgeEvery: { tokens: 5_000 }, ceilingNative: true, errors: [] });
  });

  it('refuses a relative log file and keeps the default under PLUGIN_LOG_DIR', () => {
    const resolved = resolveOptions({ pluginLogDir: '/state', vars: { FORWARD_COMPACTION_LOG_FILE: 'rel.jsonl' } });
    expect(resolved.logFile).toBe('/state/forward-compaction/decisions/.jsonl');
    expect(resolved.errors).toEqual(['forward-compaction: env FORWARD_COMPACTION_LOG_FILE is invalid (not an absolute path: "rel.jsonl"); using the default /state/forward-compaction/decisions/.jsonl']);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_LOG_FILE: '/logs/d.jsonl' } }).logFile).toBe('/logs/d.jsonl');
    expect(resolveOptions().logFile).toBeUndefined();
    // State on disk: with no PLUGIN_LOG_DIR the decision log sits beside the level logs under HOME.
    expect(resolveOptions({ home: '/h' }).logFile).toBe('/h/.local/state/forward-compaction/logs/decisions/.jsonl');
  });

  it('names a nudge start that is not below the ceiling in the same unit, and passes across units', () => {
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_CEILING: '40k', FORWARD_COMPACTION_NUDGE_START: '50k' } }).errors).toEqual(['forward-compaction: env FORWARD_COMPACTION_NUDGE_START 50000 is not below FORWARD_COMPACTION_CEILING 40000; no nudge goes out before the ceiling']);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_CEILING: '40k', FORWARD_COMPACTION_NUDGE_START: '20k' } }).errors).toEqual([]);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_CEILING: '30%' } }).errors).toEqual([]);
  });

  it('carries the lines for variables the adapter could not read', () => {
    expect(resolveOptions({ readErrors: ['forward-compaction: reading X failed: boom; using the default'] }).errors).toEqual(['forward-compaction: reading X failed: boom; using the default']);
  });
});
