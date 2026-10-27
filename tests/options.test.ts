import { describe, expect, it } from 'vitest';
import { formatSize, OPTION_ENV, parseEnvFlag, parseSize, resolveOptions, sizeTokens, subagentMaxContext } from '../plugins/forward-compaction/src/options.ts';
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

describe('subagentMaxContext (L5, S1, S5)', () => {
  it("measures a sub-agent whose model id carries [1m] against 1m, every other against 200k, and a set variable wins for all", () => {
    expect(subagentMaxContext(undefined, 'claude-opus-5-5[1m]')).toBe(1_000_000);
    expect(subagentMaxContext(undefined, 'claude-sonnet-5-5')).toBe(200_000);
    expect(subagentMaxContext(undefined, 'claude-haiku-4-5-20251001')).toBe(200_000);
    expect(subagentMaxContext(undefined, undefined)).toBe(200_000);
    expect(subagentMaxContext(400_000, 'claude-opus-5-5[1m]')).toBe(400_000);
    expect(subagentMaxContext(400_000, 'claude-sonnet-5-5')).toBe(400_000);
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
    expect(resolveOptions()).toEqual({
      main: { ceiling: { percent: 60 }, nudgeStart: { percent: 15 }, nudgeEvery: { percent: 5 } },
      subagent: { ceiling: { percent: 80 }, nudgeStart: { percent: 40 }, nudgeEvery: { percent: 10 } },
      ceilingNative: false, ignoreModels: ['haiku'], keepSkills: [], debug: true, errors: [],
    });
  });

  it('keeps the variable name of each option, all under FORWARD_COMPACTION_', () => {
    expect(OPTION_ENV).toEqual({
      mainMaxContext: 'FORWARD_COMPACTION_MAIN_MAX_CONTEXT',
      mainCeiling: 'FORWARD_COMPACTION_MAIN_CEILING',
      mainNudgeStart: 'FORWARD_COMPACTION_MAIN_NUDGE_START',
      mainNudgeEvery: 'FORWARD_COMPACTION_MAIN_NUDGE_EVERY',
      subagentMaxContext: 'FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT',
      subagentCeiling: 'FORWARD_COMPACTION_SUBAGENT_CEILING',
      subagentNudgeStart: 'FORWARD_COMPACTION_SUBAGENT_NUDGE_START',
      subagentNudgeEvery: 'FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY',
      ceilingNative: 'FORWARD_COMPACTION_CEILING_NATIVE',
      logFile: 'FORWARD_COMPACTION_LOG_FILE',
      ignoreModels: 'FORWARD_COMPACTION_IGNORE_MODELS',
      keepSkills: 'FORWARD_COMPACTION_KEEP_SKILLS',
      debug: 'FORWARD_COMPACTION_DEBUG',
    });
  });

  it('reads the ignore list as comma-separated entries, lower-cased; unset is haiku, empty ignores no model (Ignored models)', () => {
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_IGNORE_MODELS: ' Haiku, gpt-6 ,,' } }).ignoreModels).toEqual(['haiku', 'gpt-6']);
    expect(resolveOptions({ vars: {} }).ignoreModels).toEqual(['haiku']);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_IGNORE_MODELS: '' } }).ignoreModels).toEqual([]);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_IGNORE_MODELS: ' , ' } }).ignoreModels).toEqual([]);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_KEEP_SKILLS: ' god-speed, pfm:Release ,,' } }).keepSkills).toEqual(['god-speed', 'pfm:Release']);
  });

  it('reads the debug flag, on by default, and names a bad value by its variable', () => {
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_DEBUG: '0' } }).debug).toBe(false);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_DEBUG: '  ' } }).debug).toBe(true);
    const bad = resolveOptions({ vars: { FORWARD_COMPACTION_DEBUG: 'loud' } });
    expect(bad.debug).toBe(true);
    expect(bad.errors).toEqual(['forward-compaction: env FORWARD_COMPACTION_DEBUG is invalid (not 1, 0, true or false: "loud"); using the default true']);
  });

  it('names a bad size by its variable and falls back to the default (R3)', () => {
    const resolved = resolveOptions({ vars: { FORWARD_COMPACTION_MAIN_CEILING: 'abc', FORWARD_COMPACTION_SUBAGENT_CEILING: '0' } });
    expect(resolved.errors).toEqual([
      'forward-compaction: env FORWARD_COMPACTION_MAIN_CEILING is invalid (not an integer, a k/m value or a percentage: "abc"); using the default 60%',
      'forward-compaction: env FORWARD_COMPACTION_SUBAGENT_CEILING is invalid (not positive: "0"); using the default 80%',
    ]);
    expect(resolved.main.ceiling).toEqual({ percent: 60 });
    expect(resolved.subagent.ceiling).toEqual({ percent: 80 });
  });

  it('reads each max context as a token count, refusing a percentage, and leaves main\'s unset to the reported window', () => {
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_MAIN_MAX_CONTEXT: '400k', FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: '1m' } })).toMatchObject({ main: { maxContext: 400_000 }, subagent: { maxContext: 1_000_000 }, errors: [] });
    expect(resolveOptions().main.maxContext).toBeUndefined();
    const bad = resolveOptions({ vars: { FORWARD_COMPACTION_MAIN_MAX_CONTEXT: '50%', FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: 'big' } });
    expect(bad.main.maxContext).toBeUndefined();
    expect(bad.subagent.maxContext).toBeUndefined();
    expect(bad.errors).toEqual([
      'forward-compaction: env FORWARD_COMPACTION_MAIN_MAX_CONTEXT is invalid (a max context is a token count, not a percentage: "50%"); using the default main\'s window',
      'forward-compaction: env FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT is invalid (not an integer, a k/m value or a percentage: "big"); using the default each sub-agent\'s model\'s max context',
    ]);
  });

  it('reads the native flag, and treats a blank value as unset with no error (R4)', () => {
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_CEILING_NATIVE: '1' } }).ceilingNative).toBe(true);
    const blank = resolveOptions({ vars: { FORWARD_COMPACTION_CEILING_NATIVE: '  ' } });
    expect(blank.ceilingNative).toBe(false);
    expect(blank.errors).toEqual([]);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_CEILING_NATIVE: 'maybe' } }).errors).toEqual(['forward-compaction: env FORWARD_COMPACTION_CEILING_NATIVE is invalid (not 1, 0, true or false: "maybe"); using the default false']);
  });

  it('reads every size option through the test helper', () => {
    const resolved = resolveOptions({ vars: optionVars({ mainCeiling: '80k', mainNudgeStart: '30k', mainNudgeEvery: '5k', subagentCeiling: '50%', subagentNudgeStart: '20k', subagentNudgeEvery: '2%', ceilingNative: true }) });
    expect(resolved).toMatchObject({
      main: { ceiling: { tokens: 80_000 }, nudgeStart: { tokens: 30_000 }, nudgeEvery: { tokens: 5_000 } },
      subagent: { ceiling: { percent: 50 }, nudgeStart: { tokens: 20_000 }, nudgeEvery: { percent: 2 } },
      ceilingNative: true, errors: [],
    });
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
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_MAIN_CEILING: '40k', FORWARD_COMPACTION_MAIN_NUDGE_START: '50k' } }).errors).toEqual(['forward-compaction: env FORWARD_COMPACTION_MAIN_NUDGE_START 50000 is not below FORWARD_COMPACTION_MAIN_CEILING 40000; no nudge goes out before the ceiling']);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_SUBAGENT_CEILING: '40%' } }).errors).toEqual(['forward-compaction: env FORWARD_COMPACTION_SUBAGENT_NUDGE_START 40% is not below FORWARD_COMPACTION_SUBAGENT_CEILING 40%; no nudge goes out before the ceiling']);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_MAIN_CEILING: '40k', FORWARD_COMPACTION_MAIN_NUDGE_START: '20k' } }).errors).toEqual([]);
    expect(resolveOptions({ vars: { FORWARD_COMPACTION_MAIN_CEILING: '30%' } }).errors).toEqual([]);
  });

  it('carries the lines for variables the adapter could not read', () => {
    expect(resolveOptions({ readErrors: ['forward-compaction: reading X failed: boom; using the default'] }).errors).toEqual(['forward-compaction: reading X failed: boom; using the default']);
  });
});
