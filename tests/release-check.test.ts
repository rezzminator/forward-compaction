import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const planted: string[] = [];
afterEach(() => {
  for (const dir of planted.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A tree release-check.sh can run in: every version place at 1.2.3, a dated CHANGELOG section, and three real tests. */
function plant(opts: { badge: string; testBody?: string }): string {
  const root = mkdtempSync(join(tmpdir(), 'fc-release-check-'));
  planted.push(root);
  for (const dir of ['scripts', 'plugins/forward-compaction/.claude-plugin', 'tests']) mkdirSync(join(root, dir), { recursive: true });
  copyFileSync(join(REPO, 'scripts/release-check.sh'), join(root, 'scripts/release-check.sh'));
  writeFileSync(join(root, 'plugins/forward-compaction/.claude-plugin/plugin.json'), '{"name":"forward-compaction","version":"1.2.3"}');
  writeFileSync(join(root, 'package.json'), '{"name":"forward-compaction","version":"1.2.3"}');
  writeFileSync(join(root, 'README.md'), `[![Version](https://img.shields.io/badge/version-1.2.3-blue)](./CHANGELOG.md)\n${opts.badge}\n`);
  writeFileSync(join(root, 'CHANGELOG.md'), '## [1.2.3] — 2026-01-02\n');
  writeFileSync(
    join(root, 'tests/planted.test.ts'),
    opts.testBody ?? "import { expect, it } from 'vitest';\nit.each([1, 2, 3])('planted %i', (n) => { expect(n).toBeGreaterThan(0); });\n",
  );
  symlinkSync(join(REPO, 'node_modules'), join(root, 'node_modules'));
  return root;
}

function run(root: string): { status: number | null; out: string } {
  const result = spawnSync('bash', [join(root, 'scripts/release-check.sh')], { cwd: root, encoding: 'utf8', env: { ...process.env, VITEST: '', NODE_ENV: '' } });
  return { status: result.status, out: `${result.stdout}${result.stderr}`.trim() };
}

describe('release-check.sh README tests badge', () => {
  it('passes when the badge states the count of tests the run passes', () => {
    const { status, out } = run(plant({ badge: '[![Tests](https://img.shields.io/badge/tests-3%20passing-brightgreen)](#development)' }));
    expect(out).toBe('PASS release 1.2.3: versions agree, CHANGELOG dated, README badge counts 3 passing tests');
    expect(status).toBe(0);
  });

  it('fails naming both numbers when the badge is stale', () => {
    const { status, out } = run(plant({ badge: '[![Tests](https://img.shields.io/badge/tests-402%20passing-brightgreen)](#development)' }));
    expect(out).toBe('FAIL README tests badge says 402, the run passes 3');
    expect(status).toBe(1);
  });

  it('fails when the README has no tests badge', () => {
    const { status, out } = run(plant({ badge: 'no badge here' }));
    expect(out).toBe('FAIL README has no tests badge (tests-N%20passing)');
    expect(status).toBe(1);
  });

  it('fails when a test fails, whatever the badge says', () => {
    const failing = "import { expect, it } from 'vitest';\nit('ok', () => { expect(1).toBe(1); });\nit('broken', () => { expect(1).toBe(2); });\n";
    const { status, out } = run(plant({ badge: '[![Tests](https://img.shields.io/badge/tests-1%20passing-brightgreen)](#development)', testBody: failing }));
    expect(out).toBe('FAIL the run has 1 failing test, so the README tests badge cannot be checked');
    expect(status).toBe(1);
  });

  it('fails when a test file cannot even be collected, whatever the badge says', () => {
    const root = plant({ badge: '[![Tests](https://img.shields.io/badge/tests-3%20passing-brightgreen)](#development)' });
    writeFileSync(join(root, 'tests/broken.test.ts'), "import './no-such-module.ts';\n");
    const { status, out } = run(root);
    expect(out).toBe('FAIL the run has 1 test file that failed to run, so the README tests badge cannot be checked');
    expect(status).toBe(1);
  });

  it('exits 2 naming the runner failure, not npm ci, when vitest is installed but gives no report', () => {
    const root = plant({ badge: '[![Tests](https://img.shields.io/badge/tests-3%20passing-brightgreen)](#development)' });
    writeFileSync(join(root, 'vitest.config.ts'), "throw new Error('planted config failure');\n");
    const { status, out } = run(root);
    expect(out).toMatch(/^ERROR cannot read the test count: vitest gave no JSON report \(exit \d+\): .*planted config failure/);
    expect(status).toBe(2);
  });

  it('exits 2 and says why when the test runner cannot run', () => {
    const root = plant({ badge: '[![Tests](https://img.shields.io/badge/tests-3%20passing-brightgreen)](#development)' });
    rmSync(join(root, 'node_modules'));
    const { status, out } = run(root);
    expect(out).toBe('ERROR cannot read the test count: run npm ci');
    expect(status).toBe(2);
  });
});
