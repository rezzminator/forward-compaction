import { describe, expect, it } from 'vitest';
import { buildRecord, forwardDir, nextSeq, previousDir, withInstall } from '../plugins/sub-agent-compact/src/forward-record.ts';
import { installCheck, renderForward } from '../plugins/sub-agent-compact/src/forward-text.ts';

const rendered = renderForward({ seq: 2, users: ['hi'], skills: [], trail: [{ tag: 'R', path: 'a' }], loaded: [], tasks: [], running: [], paths: [], problems: [], args: { objective: 'o', done: ['d'], remaining: [], next: 'n', blocked: [], findings: [], loadFiles: [], dropSkills: [], trimmed: ['done'] } });

describe('per-call files', () => {
  it('lives under the config directory, one directory per session and call', () => {
    expect(forwardDir('/c', 's1', 3)).toBe('/c/sub-agent-compact/forward-handoff/s1/3');
    expect(forwardDir('/c', 'a/b c', 1)).toBe('/c/sub-agent-compact/forward-handoff/a_b_c/1');
  });

  it('numbers the next call after the highest existing one', () => {
    expect(nextSeq([])).toBe(1);
    expect(nextSeq(['1', '2', 'x', '10', '3.txt'])).toBe(11);
  });

  it('names the previous call directory', () => {
    expect(previousDir('/c', 's1', 1)).toBeUndefined();
    expect(previousDir('/c', 's1', 4)).toBe('/c/sub-agent-compact/forward-handoff/s1/3');
  });
});

describe('measurement record', () => {
  const record = buildRecord({ seq: 2, session: 's1', dir: '/c/x/2', text: rendered.text, blocks: rendered.blocks, tokensBefore: 90_000, trimmed: ['done'] });

  it('logs the chars and estimated tokens of every block and of the total', () => {
    expect(record).toMatchObject({ seq: 2, session: 's1', dir: '/c/x/2', tokensBefore: 90_000, trimmed: ['done'], total: { chars: rendered.text.length, tokens: Math.ceil(rendered.text.length / 4) } });
    const blocks = record.blocks as { name: string; chars: number; tokens: number; items: number; hash: string }[];
    expect(blocks.map((b) => b.name)).toEqual(rendered.blocks.map((b) => b.name));
    for (const b of blocks) expect(b).toMatchObject({ chars: expect.any(Number), tokens: expect.any(Number), items: expect.any(Number), hash: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect(blocks.find((b) => b.name === 'User')).toMatchObject({ items: 1 });
  });

  it('adds tokens after and the install check once installed', () => {
    const done = withInstall(record, { tokensAfter: 4_000, check: installCheck(rendered.blocks, rendered.text, rendered.text) });
    expect(done).toMatchObject({ tokensAfter: 4_000, install: { ok: true, missing: [], landed: rendered.blocks.length } });
    expect(record.tokensAfter).toBeUndefined();
  });
});
