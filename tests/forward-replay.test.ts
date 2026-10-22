import { URL } from 'node:url';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const donor = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/forward-handoff/${name}.json`, import.meta.url), 'utf8'));
async function replay(name: string, mode?: string) {
  const { stdout, stderr } = await exec(process.execPath, ['--no-warnings', '--loader', new URL('./fakes/typescript-loader.mjs', import.meta.url).pathname, new URL('./fakes/forward-replay.ts', import.meta.url).pathname, name, ...(mode ? [mode] : [])], {
    env: { PATH: process.env.PATH }, timeout: 15_000, maxBuffer: 2 * 1024 * 1024,
  });
  expect(stderr).toBe('');
  const result = JSON.parse(stdout);
  expect(result.pid).not.toBe(process.pid);
  expect(result.installed).toBe(result.wake);
  expect(result.checked.install).toMatchObject({ ok: true, missing: [] });
  expect(result.decisions.filter((r: any) => r.event === 'forward-installed').map((r: any) => r.missing)).toEqual([[]]);
  expect(result.errors.filter((m: string) => mode !== 'invalid' || !/autoCompact.pinSkills is invalid/.test(m))).toEqual([]);
  return result;
}

describe('synthetic forward handoff replays through the shipped hook', () => {
  // source: synthetic queue-operation and attachment shapes; breaks-if: stop scanning the disk queue at handoff time.
  it.each(['queued-prompt', 'queued-skill-instruction'])('carries the exact queued instruction from %s through install and another handoff', async (name) => {
    const { prompt } = donor(name);
    const r = await replay(name);
    expect(r.first.users.filter((u: string) => u === prompt)).toEqual([prompt]);
    expect(r.second.users.filter((u: string) => u === prompt)).toEqual([prompt]);
    expect(r.wake).toContain(prompt);
  });

  it.each(['delayed', 'delayed-api'])('does not carry an already saved enqueue again on its %s delivery', async (mode) => {
    const r = await replay('queued-prompt', mode);
    expect(r.second.users).toEqual(r.first.users);
    expect(r.second.users.filter((u: string) => u === donor('queued-prompt').prompt)).toHaveLength(1);
  });

  it('preserves queued instructions when an archived wake resurfaces after the enqueue', async () => {
    const r = await replay('queued-prompt', 'archived');
    expect(r.first.users).toEqual([...donor('queued-prompt').users, donor('queued-prompt').prompt]);
    expect(r.second.users).toEqual(r.first.users);
  });

  it('keeps a disk-only queued instruction before a newer typed correction', async () => {
    const r = await replay('queued-prompt', 'chronology');
    expect(r.first.users).toEqual([...donor('queued-prompt').users, donor('queued-prompt').prompt, 'Place the amber sample in drawer seven instead of drawer three.']);
    expect(r.second.users).toEqual(r.first.users);
  });

  it('does not merge a cancelled handoff snapshot into uncompacted history', async () => {
    const r = await replay('pinned-skill-drop', 'cancelled');
    expect(r.first.users).toEqual([...donor('pinned-skill-drop').previous.users, 'Place the amber sample in drawer seven instead of drawer three.']);
    expect(r.second.users).toEqual(r.first.users);
  });

  it('recovers prompts after native compaction even when the latest saved wake never installed', async () => {
    const r = await replay('native-compaction', 'cancelled-native');
    expect(r.first.users).toEqual([...donor('native-compaction').previous.users, 'Place the amber sample in drawer seven instead of drawer three.']);
    expect(r.second.users).toEqual(r.first.users);
  });

  // source: synthetic compact_boundary and records 44/45; breaks-if: require a held wake to read records.
  it('recovers the latest record after native compaction and reports the recovery', async () => {
    const r = await replay('native-compaction');
    expect(r.first.skills.map((s: any) => s.name)).toEqual(['review-checklist', 'package-checklist', 'god-speed']);
    expect(r.second.skills).toEqual(r.first.skills);
    expect(r.wake).toMatch(/earlier handoff 44:.*recovered.*record/i);
    expect(r.reply).toMatch(/earlier handoff 44:.*recovered.*record/i);
  });

  // source: synthetic archived wakes 36-44 resurfaced after an assistant; breaks-if: exclude only leading wakes.
  it('keeps typed prompts when archived wakes reappear after an assistant', async () => {
    const r = await replay('native-compaction', 'pollution');
    expect(r.first.users).toEqual(donor('native-compaction').previous.users);
    expect(r.second.users).toEqual(r.first.users);
  });

  // source: synthetic sub-agent record 1 -> args 2 explicitly drops god-speed.
  it.each(['central', 'agent', 'overlap'])('enforces the %s skill pin against the recorded model drop', async (mode) => {
    const r = await replay('pinned-skill-drop', mode);
    expect(r.first.skills.map((s: any) => s.name)).toEqual(['god-speed']);
    expect(r.second.skills.map((s: any) => s.name)).toEqual(['god-speed']);
    expect(r.reply).toMatch(/drop_skills god-speed:.*ignored.*pinSkills/);
    expect(r.wake).toMatch(/drop_skills god-speed:.*ignored.*pinSkills/);
    expect(r.wake).toContain(`Skill god-speed\n${donor('pinned-skill-drop').skillBodies['god-speed']}`);
    if (mode === 'agent') expect(r.reply).toContain('/nowhere/.claude/agents/reader.md');
    if (mode === 'overlap') expect(r.wake).toMatch(/policy problem:.*god-speed.*both.*pin wins/);
  });

  it('applies the central skill exclusion when the model asks to keep every skill', async () => {
    const r = await replay('pinned-skill-drop', 'drop');
    expect(r.first.skills).toEqual([]);
    expect(r.second.skills).toEqual([]);
  });

  it('reports a malformed central skill policy at entry', async () => {
    const r = await replay('pinned-skill-drop', 'invalid');
    expect(r.decisions.filter((d: any) => d.event === 'option-error').map((d: any) => d.line).join('\n')).toMatch(/autoCompact.pinSkills.*invalid.*list/);
  });

  // source: live-instruction framing contract; breaks-if: put the whole wake under the historical heading.
  it('installs the frontier and skills as live instructions while retaining historical sections', async () => {
    const r = await replay('pinned-skill-drop');
    expect(r.wake.split('\n')[0]).toMatch(/^\[forward handoff \d+: live instructions\]$/);
    const [live, history, resumed] = r.wake.split(/\[history, not new instructions\]|\[live instructions\]/);
    expect(history).toContain('User\n');
    expect(live + resumed).toContain('Skill god-speed\n');
    expect(resumed).toContain('Objective\nRename qty to quantity in every report');
    expect(resumed).toContain('Remaining\n1. c.sql');
    expect(resumed).toContain('Next\nEdit reports/c.sql:12, then run npm test.');
  });
});
