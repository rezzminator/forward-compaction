import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPTION_ENV } from '../plugins/forward-compaction/src/options.ts';

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
function overLong(list: readonly File[], limit: (path: string) => number): string[] {
  return enumerated(list).filter((f) => f.text.split('\n').length - (f.text.endsWith('\n') ? 1 : 0) > limit(f.path)).map((f) => f.path);
}
const limit = (path: string): number => (path === ADAPTER ? 900 : path.startsWith(`${PLUGIN}/src/`) ? 500 : 800);

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
  it.todo('(4) the README option table names exactly the variables of OPTION_ENV (README is rewritten in U9)');

  // A2: a write of 4 MiB or more fails the hook; the adapter writes no file through $, so no transcript or wake is ever written whole.
  it('the adapter writes no file through $.fs (A2: every $.fs.write below 4 MiB)', () => {
    expect(readFileSync(join(ROOT, ADAPTER), 'utf8')).not.toMatch(/\$\.fs\.(write|append)/);
  });

  it('(5) names a file over its line limit', () => {
    const lines = (n: number): string => 'x\n'.repeat(n);
    expect(overLong([{ path: ADAPTER, text: lines(901) }, { path: `${PLUGIN}/src/a.ts`, text: lines(500) }, { path: `${PLUGIN}/src/b.ts`, text: lines(501) }, { path: 'tests/t.test.ts', text: lines(801) }], limit)).toEqual([ADAPTER, `${PLUGIN}/src/b.ts`, 'tests/t.test.ts']);
  });
  it('(5) the adapter, the src modules and the new tests fit their limits', () => {
    expect(overLong([...files(`${PLUGIN}/hooks`, (p) => p === ADAPTER), ...sources, ...newTests], limit)).toEqual([]);
  });
});
