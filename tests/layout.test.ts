import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CEILING_NATIVE, DEFAULT_DEBUG, DEFAULT_IGNORE_MODELS, DEFAULT_MAIN, DEFAULT_SUBAGENT, DEFAULT_SUBAGENT_MAX_CONTEXT, OPTION_ENV, parseEnvFlag, parseSize, resolveOptions, type OptionName } from '../plugins/forward-compaction/src/options.ts';

const ROOT = join(import.meta.dirname, '..');
const PLUGIN = 'plugins/forward-compaction';
const ADAPTER = `${PLUGIN}/hooks/forward-compaction.ts`;
type File = { path: string; text: string };

function files(dir: string, keep: (path: string) => boolean = () => true): File[] {
  return (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .map((name) => relative(ROOT, join(ROOT, dir, name)))
    .filter((path) => keep(path) && !readdirSafe(path))
    .map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
}
function readdirSafe(path: string): boolean {
  try {
    readdirSync(join(ROOT, path));
    return true;
  } catch {
    return false;
  }
}
function enumerated<T>(list: readonly T[]): readonly T[] {
  if (list.length === 0) throw new Error('enumerated 0 files');
  return list;
}

// Each gate is a pure check over the files it is handed: the planted cases prove it reports, the real cases run it on the tree.
function engineOutsideAdapter(list: readonly File[]): string[] {
  const stripped = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  return enumerated(list).filter((f) => f.path !== ADAPTER && /\$\./.test(stripped(f.text))).map((f) => f.path);
}
function untestedSources(sources: readonly string[], tests: readonly string[]): string[] {
  return enumerated(sources)
    .map((path) => /([^/]+)\.ts$/.exec(path)![1])
    .filter((stem) => !tests.includes(`tests/${stem}.test.ts`))
    .map((stem) => `${PLUGIN}/src/${stem}.ts`);
}
// Built from parts, so this file does not match itself. D2: the GitHub slug keeps the old name in this flight.
const OLD_NAME = new RegExp(['sub-agent' + '-compact', 'SUB_AGENT' + '_COMPACT', 'forward' + '_handoff'].join('|'));
const SLUG = new RegExp(['github\\.com/rezzminator/sub-agent' + '-compact'].join(''), 'g');
function oldNames(list: readonly File[]): string[] {
  return enumerated(list).filter((f) => !f.path.endsWith('CHANGELOG.md') && OLD_NAME.test(f.text.replace(SLUG, ''))).map((f) => f.path);
}
function optionLiterals(text: string): Set<string> {
  return new Set(text.match(/FORWARD_COMPACTION_[A-Z_]*[A-Z]/g) ?? []);
}
function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  return [...[...a].filter((x) => !b.has(x)).map((x) => `+${x}`), ...[...b].filter((x) => !a.has(x)).map((x) => `-${x}`)];
}
// Gate 4, README half: each `| `FORWARD_COMPACTION_X` | type | default | meaning |` row against OPTION_ENV and the code's default.
// Main's max context defaults to the window Claude Code reports: its cell says `window`.
const CODE_DEFAULT: Record<OptionName, unknown> = {
  mainMaxContext: 'window', mainCeiling: DEFAULT_MAIN.ceiling, mainNudgeStart: DEFAULT_MAIN.nudgeStart, mainNudgeEvery: DEFAULT_MAIN.nudgeEvery,
  subagentMaxContext: { tokens: DEFAULT_SUBAGENT_MAX_CONTEXT }, subagentCeiling: DEFAULT_SUBAGENT.ceiling, subagentNudgeStart: DEFAULT_SUBAGENT.nudgeStart, subagentNudgeEvery: DEFAULT_SUBAGENT.nudgeEvery,
  ceilingNative: DEFAULT_CEILING_NATIVE, logFile: resolveOptions({ home: '~' }).logFile, ignoreModels: DEFAULT_IGNORE_MODELS.join(','), debug: DEFAULT_DEBUG,
};
function optionTableFaults(readme: string): string[] {
  const rows = [...readme.matchAll(/^\|\s*`(FORWARD_COMPACTION_[A-Z_]+)`\s*\|[^|\n]*\|\s*`([^`\n]*)`[^|\n]*\|/gm)].map((m) => ({ name: m[1]!, cell: m[2]! }));
  const faults = sameSet(new Set(rows.map((r) => r.name)), new Set(Object.values(OPTION_ENV)));
  for (const { name, cell } of rows) {
    const option = (Object.keys(OPTION_ENV) as OptionName[]).find((o) => OPTION_ENV[o] === name);
    if (option === undefined) continue;
    const want = CODE_DEFAULT[option];
    const got = typeof want === 'boolean' ? parseEnvFlag(cell) : typeof want === 'object' ? parseSize(cell) : { ok: true, value: cell };
    if (!got.ok || JSON.stringify(got.value) !== JSON.stringify(want)) faults.push(`${name} default ${cell}`);
  }
  return faults;
}
function overLong(list: readonly File[], limit: (path: string) => number): string[] {
  return enumerated(list).filter((f) => f.text.split('\n').length - (f.text.endsWith('\n') ? 1 : 0) > limit(f.path)).map((f) => f.path);
}
const limit = (path: string): number => (path === ADAPTER ? 920 : path.startsWith(`${PLUGIN}/src/`) ? 500 : 800);

const pluginTs = files(PLUGIN, (p) => p.endsWith('.ts'));
const sources = files(`${PLUGIN}/src`, (p) => p.endsWith('.ts'));
const testNames = readdirSync(join(ROOT, 'tests')).map((name) => `tests/${name}`);
// The new tree of § Layout: the old plugin and its tests leave in U7, so only the new suite is held to it.
const NEW_TESTS = ['adapter', 'replay', 'layout', 'release-check', ...sources.map((f) => /([^/]+)\.ts$/.exec(f.path)![1])]
  .map((stem) => `tests/${stem}.test.ts`)
  .concat(['tests/option-env.ts', 'tests/fakes/engine.ts', 'tests/fakes/replay-engine.ts'])
  .filter((path) => existsSync(join(ROOT, path)));
const newTests = NEW_TESTS.map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));

describe('layout gates (D22)', () => {
  it('every gate errors on an empty file list rather than passing', () => {
    expect(() => engineOutsideAdapter([])).toThrow('enumerated 0 files');
    expect(() => untestedSources([], testNames)).toThrow('enumerated 0 files');
    expect(() => oldNames([])).toThrow('enumerated 0 files');
    expect(() => overLong([], limit)).toThrow('enumerated 0 files');
  });

  it('(1) names a file outside the adapter that reaches $, and ignores one in a comment', () => {
    expect(engineOutsideAdapter([{ path: ADAPTER, text: 'await $.fs.read(p)' }, { path: `${PLUGIN}/src/x.ts`, text: 'await $.fs.write(p)' }, { path: `${PLUGIN}/src/y.ts`, text: '// never $.fs here' }])).toEqual([`${PLUGIN}/src/x.ts`]);
  });
  it('(1) $ is reached only from the adapter', () => {
    expect(pluginTs.some((f) => f.path === ADAPTER)).toBe(true);
    expect(engineOutsideAdapter(pluginTs)).toEqual([]);
  });

  it('(2) names a source with no test of its stem', () => {
    expect(untestedSources([`${PLUGIN}/src/wake.ts`, `${PLUGIN}/src/ghost.ts`], ['tests/wake.test.ts'])).toEqual([`${PLUGIN}/src/ghost.ts`]);
  });
  it('(2) every src module has its test', () => {
    expect(untestedSources(sources.map((f) => f.path), testNames)).toEqual([]);
  });

  it('(3) names a file carrying the old name, outside CHANGELOG.md and the GitHub slug', () => {
    const old = 'SUB_AGENT' + '_COMPACT_CEILING';
    expect(oldNames([{ path: 'a.ts', text: old }, { path: 'CHANGELOG.md', text: old }, { path: 'p.json', text: 'https://github.com/rezzminator/sub-agent' + '-compact' }])).toEqual(['a.ts']);
  });
  it('(3) the new plugin and its new tests carry no old name', () => {
    const own = ['tests/adapter.test.ts', 'tests/layout.test.ts', 'tests/fakes/engine.ts'].map((path) => ({ path, text: readFileSync(join(ROOT, path), 'utf8') }));
    expect(oldNames([...files(PLUGIN), ...own])).toEqual([]);
  });

  it('(4) names an option literal missing on either side', () => {
    expect(sameSet(optionLiterals("$.env.get('FORWARD_COMPACTION_CEILING') FORWARD_COMPACTION_* FORWARD_COMPACTION_EXTRA"), new Set(['FORWARD_COMPACTION_CEILING', 'FORWARD_COMPACTION_LOG_FILE']))).toEqual(['+FORWARD_COMPACTION_EXTRA', '-FORWARD_COMPACTION_LOG_FILE']);
  });
  it('(4) the adapter reads exactly the variables of OPTION_ENV', () => {
    expect(sameSet(optionLiterals(readFileSync(join(ROOT, ADAPTER), 'utf8')), new Set(Object.values(OPTION_ENV)))).toEqual([]);
  });
  it('(4) names a README option row missing, extra or with a default the code does not have', () => {
    const row = (name: string, def: string): string => `| \`${name}\` | size | \`${def}\` | x |`;
    const cells: [string, string][] = [
      ['MAIN_MAX_CONTEXT', 'window'], ['MAIN_CEILING', '70%'], ['MAIN_NUDGE_START', '15%'],
      ['SUBAGENT_MAX_CONTEXT', '200k'], ['SUBAGENT_CEILING', '80%'], ['SUBAGENT_NUDGE_START', '40%'], ['SUBAGENT_NUDGE_EVERY', '20%'],
      ['CEILING_NATIVE', '0'], ['LOG_FILE', '~/.local/state/forward-compaction/logs/decisions/.jsonl'], ['IGNORE_MODELS', 'haiku'], ['DEBUG', '1'], ['EXTRA', '1'],
    ];
    const table = cells.map(([name, def]) => row(`FORWARD_COMPACTION_${name}`, def)).join('\n');
    expect(optionTableFaults(table)).toEqual(['+FORWARD_COMPACTION_EXTRA', '-FORWARD_COMPACTION_MAIN_NUDGE_EVERY', 'FORWARD_COMPACTION_MAIN_CEILING default 70%', 'FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY default 20%']);
  });
  it('(4) the README option table names exactly the variables of OPTION_ENV, each with the code\'s default', () => {
    expect(optionTableFaults(readFileSync(join(ROOT, 'README.md'), 'utf8'))).toEqual([]);
  });

  // A2: a write of 4 MiB or more fails the hook; the adapter writes no file through $, so no transcript or wake is ever written whole.
  it('the adapter writes no file through $.fs (A2: every $.fs.write below 4 MiB)', () => {
    expect(readFileSync(join(ROOT, ADAPTER), 'utf8')).not.toMatch(/\$\.fs\.(write|append)/);
  });

  it('(5) names a file over its line limit', () => {
    const lines = (n: number): string => 'x\n'.repeat(n);
    expect(overLong([{ path: ADAPTER, text: lines(921) }, { path: `${PLUGIN}/src/a.ts`, text: lines(500) }, { path: `${PLUGIN}/src/b.ts`, text: lines(501) }, { path: 'tests/t.test.ts', text: lines(801) }], limit)).toEqual([ADAPTER, `${PLUGIN}/src/b.ts`, 'tests/t.test.ts']);
  });
  it('(5) the adapter, the src modules and the new tests fit their limits', () => {
    expect(overLong([...files(`${PLUGIN}/hooks`, (p) => p === ADAPTER), ...sources, ...newTests], limit)).toEqual([]);
  });
});
