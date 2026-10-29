import { afterEach, describe, expect, it } from 'vitest';
import { planFrom, planRead } from '../plugins/forward-compaction/src/plan.ts';
import { begin, cleanup, spawn, step, transcript, A1, type Fake } from './fakes/session.ts';

afterEach(cleanup);

describe("planFrom reads plan mode and the plan file off Claude Code's plan-mode attachments", () => {
  it('turns plan mode on at a reminder or a re-entry, off at the exit note, the path from each', () => {
    const on = planFrom(undefined, 'plan_mode', { reminder: 'sparse', planFilePath: '/p.md', hasPlan: false });
    expect(on).toEqual({ mode: true, path: '/p.md' });
    expect(planFrom(on, 'plan_mode_exit', { planFilePath: '/p.md', hasPlan: true })).toEqual({ mode: false, path: '/p.md' });
    expect(planFrom({ mode: false, path: '/p.md' }, 'plan_mode_reentry', { planFilePath: '/q.md' })).toEqual({ mode: true, path: '/q.md' });
  });

  it('keeps what it knew for any other attachment, and the known path when a plan row holds no detail', () => {
    const known = { mode: true, path: '/p.md' };
    expect(planFrom(known, 'todo_reminder', undefined)).toBe(known);
    expect(planFrom(undefined, 'file', { planFilePath: '/x' })).toBeUndefined();
    expect(planFrom(known, 'plan_mode_exit', undefined)).toEqual({ mode: false, path: '/p.md' });
    expect(planFrom(undefined, 'plan_mode', { planFilePath: 7 })).toEqual({ mode: true });
  });
});

describe('planRead takes the plan file as read at install', () => {
  const seen = { mode: true, path: '/p.md' };
  it('carries its content, and a file never written or empty as no plan file', () => {
    expect(planRead(seen, { text: '# Plan' })).toEqual({ ...seen, content: '# Plan' });
    expect(planRead(seen, { text: ' \n' })).toBe(seen);
    expect(planRead(seen, { error: Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }) })).toBe(seen);
  });
  it('names any other failure', () => {
    expect(planRead(seen, { error: Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }) })).toEqual({ ...seen, problem: 'EACCES: permission denied' });
    expect(planRead(seen, { error: 'odd' })).toEqual({ ...seen, problem: 'odd' });
  });
});

describe("plan mode and the plan file, from Claude Code's plan-mode attachments", () => {
  const attach = (f: Fake, type: string, detail?: Record<string, unknown>, agentId?: string) =>
    f.dispatch('prompt.attachment', { type, text: 'plan-mode reminder', origin: { kind: 'engine' }, ...(detail ? { detail } : {}), ...(agentId ? { agentId } : {}) }, async () => ({ text: 'plan-mode reminder' }));

  it('passes the attachment on untouched, and carries plan mode and the plan file into the party wake, the file read at install', async () => {
    const f = await begin({ files: { '/plans/p.md': { content: '# Plan\n1. ship' } } });
    expect(await attach(f, 'plan_mode', { reminder: 'full', planFilePath: '/plans/p.md', hasPlan: true })).toEqual({ text: 'plan-mode reminder' });
    await step(f, 125_000);
    const wake = (await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(wake).toContain('## Plan mode\nThe session is in plan mode');
    expect(wake).toContain('## Plan file\n/plans/p.md\n# Plan\n1. ship');
  });

  it("keeps the plan file once plan mode ended, and a sub-agent's plan stays its own", async () => {
    const f = await begin({ files: { '/plans/p.md': { content: '# Plan' } } });
    await attach(f, 'plan_mode', { reminder: 'full', planFilePath: '/plans/p.md', hasPlan: false });
    await attach(f, 'plan_mode_exit', { planFilePath: '/plans/p.md', hasPlan: true });
    await spawn(f);
    await step(f, 125_000, A1);
    const agentWake = (await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: transcript() }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(agentWake).not.toMatch(/## Plan/);
    await step(f, 125_000);
    const wake = (await f.dispatch('session.compact', { trigger: 'auto', messages: transcript() }, async () => ({ skip: 'native ran' }))).messages[0].text;
    expect(wake).toContain('## Plan file\n/plans/p.md\n# Plan');
    expect(wake).not.toContain('## Plan mode');
  });
});
