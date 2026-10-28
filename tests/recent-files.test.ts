// The mechanical wake re-reads the newest files the party touched, as Claude Code's own compaction does; a frontier wake does not.
import { afterEach, describe, expect, it } from 'vitest';
import { begin, cleanup, step, store, transcript } from './fakes/session.ts';

afterEach(cleanup);

describe('the mechanical wake re-reads the newest files the party touched', () => {
  it('carries the 5 newest from disk at install, each up to 250 lines, names one gone, and a frontier wake carries none', async () => {
    const paths = Array.from({ length: 7 }, (_, i) => `/work/r${i}.ts`);
    const long = Array.from({ length: 300 }, (_, i) => `x${i + 1}`).join('\n');
    const files = Object.fromEntries(paths.filter((p) => p !== '/work/r5.ts').map((p) => [p, { content: p === '/work/r6.ts' ? long : `body of ${p}` }]));
    const f = await begin({ files });
    for (const p of paths) await f.dispatch('tool.call', { tool: 'Read', tool_use_id: `tu-${p}`, file_path: p }, async () => ({ result: 'read' }));
    await step(f, 125_000);
    const wake = (await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(wake).toContain('## Files you were working on, newest first, read at install\n### /work/r6.ts lines 1-250\nx1\n');
    expect(wake).toContain('x250\n[50 more lines not carried: Read /work/r6.ts from line 251]\n### /work/r5.ts\n(not carried: ');
    expect(wake).toContain('### /work/r2.ts\nbody of /work/r2.ts');
    expect(wake).not.toContain('### /work/r1.ts');
    await step(f, 64_000);
    await store(f);
    const frontierWake = (await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(frontierWake).not.toContain('## Files you were working on');
  });
});
