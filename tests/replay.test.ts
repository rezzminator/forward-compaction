// The replay gate (spec § Tests, replay gate 5-7; D19): every fixture under tests/fixtures/replay/*/ replayed
// through the real register, and the invariants I1-I13 run on its recorded outputs (the live system) and on the
// replayed outputs (current code). Each failure names the invariant, the hook, its invocation number and the party.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadFixture, invocations, replay, recordSynthetic, type Invocation } from './fakes/replay-engine.ts';
import { ENV_NAMES, PATHS, PART_CHARS, RECORDED, rowFiles, type Row } from '../scripts/replay/recorder.ts';
import { contextTokens } from '../plugins/forward-compaction/src/decide.ts';
import { engineAskPoint, modelWindow, partyWindow, ENGINE_DEFAULT_WINDOW } from '../plugins/forward-compaction/src/window.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'tests/fixtures/replay');
const SYNTHETIC = join(FIXTURES, 'synthetic/session.jsonl');
const SANITIZE = join(ROOT, 'scripts/replay/sanitize.mjs');
// U8 deletes this line once it commits tests/fixtures/replay/2.1.309/: until then the live pin is a named todo, after it a missing fixture fails.
const LIVE_FIXTURE_PENDING = true;

const ALL = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10', 'I11', 'I12', 'I13'] as const;
type Name = (typeof ALL)[number];
type Verdict = { subjects: number; failures: string[] };
type View = readonly Invocation[];

const party = (input: any): string => (typeof input?.agentId === 'string' && input.agentId !== '' ? `agent:${input.agentId}` : 'main');
const at = (inv: Invocation): string => `${inv.hook} #${inv.id} ${party(inv.input)}`;
const isForward = (tool: unknown): boolean => typeof tool === 'string' && tool.endsWith('__forward_compaction');
const wakeOf = (inv: Invocation): any[] | undefined => (inv.hook === 'session.compact' && Array.isArray(inv.end?.result?.messages) ? inv.end!.result.messages : undefined);
const texts = (messages: readonly any[]): string => messages.map((m) => [m.text ?? '', ...(m.toolResults ?? []).map((r: any) => r.text ?? '')].join('\n')).join('\n');
const nextWake = (view: View, key: string, after: number): Invocation | undefined => view.find((c) => c.seq > after && party(c.input) === key && wakeOf(c) !== undefined);
const handoffOf = (call: Invocation): string | undefined => call.input?.handoff ?? call.input?.input?.handoff;
const count = (hay: string, needle: string): number => (needle === '' ? 0 : hay.split(needle).length - 1);
const knownAgents = (view: View): Set<string> => new Set(view.filter((i) => i.hook === 'agent.spawn').map((i) => i.nextResult?.result?.agentId).filter((id): id is string => typeof id === 'string'));

/** The ask point of a party at a moment, from what session.start read and the party's last step model. */
function askPointAt(view: View, key: string, seq: number): number {
  const start = view.find((i) => i.hook === 'session.start');
  const w = Number(start?.calls.find((c) => c.path === 'env.get' && c.args[0] === 'CLAUDE_CODE_AUTO_COMPACT_WINDOW')?.result);
  const main = start?.calls.find((c) => c.path === 'session.usage')?.result?.context?.window ?? ENGINE_DEFAULT_WINDOW;
  const model = [...view].reverse().find((i) => i.hook === 'turn.step' && i.seq < seq && party(i.input) === key)?.input?.model;
  return engineAskPoint(partyWindow(modelWindow(model, main), Number.isInteger(w) && w > 0 ? w : undefined));
}
function readingAt(view: View, key: string, seq: number): number | undefined {
  const last = [...view].reverse().find((i) => i.hook === 'turn.step' && i.seq < seq && party(i.input) === key);
  return last ? contextTokens(last.end?.result?.usage) : undefined;
}

/** The I3 tail rule: the handoff verbatim in the last hook-built message, then only handle-carrying messages, a suffix of the ask's messages after the anchor's results. */
function tailAfterAnchor(messages: readonly any[], id: string): string[] | undefined {
  const anchor = messages.findIndex((m) => m.toolUses?.some((u: any) => u.tool_use_id === id));
  const results = messages.findIndex((m, i) => i > anchor && m.toolResults?.some((r: any) => r.tool_use_id === id));
  return anchor < 0 || results < 0 ? undefined : messages.slice(results + 1).map((m) => m.handle);
}

const payload = (m: any): string => JSON.stringify({ text: m.text, toolUses: (m.toolUses ?? []).map((u: any) => [u.tool_use_id, u.tool, u.input]), toolResults: (m.toolResults ?? []).map((r: any) => [r.tool_use_id, r.text]) });
const toolIds = (m: any): string[] => [...(m.toolUses ?? []).map((u: any) => u.tool_use_id), ...(m.toolResults ?? []).map((r: any) => `r:${r.tool_use_id}`)];

export const INVARIANTS: Record<Name, (view: View, recorded: boolean) => Verdict> = {
  I1(view) {
    const subjects = view.filter((i) => i.hook === 'session.compact' && i.input?.trigger === 'manual');
    return { subjects: subjects.length, failures: subjects.filter((i) => JSON.stringify(i.next?.input) !== JSON.stringify(i.input) || JSON.stringify(i.end?.result) !== JSON.stringify(i.nextResult?.result)).map((i) => `I1 ${at(i)}: a manual compaction was not passed to next unchanged with its result returned`) };
  },
  I2(view) {
    const subjects = view.filter((i) => i.hook === 'session.compact' && i.input?.trigger === 'precompute');
    return { subjects: subjects.length, failures: subjects.filter((i) => typeof i.end?.result?.skip !== 'string').map((i) => `I2 ${at(i)}: a precompute was not skipped`) };
  },
  I3(view) {
    const failures: string[] = [];
    let subjects = 0;
    for (const c of view) {
      const wake = wakeOf(c);
      if (!wake || !wake.some((m) => typeof m.text === 'string' && m.text.includes('=== handoff ==='))) continue;
      subjects++;
      const ask: any[] = c.input?.messages ?? [];
      const call = [...view].reverse().find((t) => t.seq < c.seq && t.hook === 'tool.call' && isForward(t.input?.tool) && party(t.input) === party(c.input) && tailAfterAnchor(ask, t.input.tool_use_id) !== undefined);
      if (!call) { failures.push(`I3 ${at(c)}: no forward_compaction call of this party is in the ask's messages`); continue; }
      const h = wake.findLastIndex((m) => m.handle === undefined);
      if (h < 0 || !String(wake[h].text).includes(`=== handoff ===\n${handoffOf(call)}\n=== end of handoff ===`)) failures.push(`I3 ${at(c)}: the last hook-built message lacks the handoff of tool.call #${call.id} verbatim`);
      const tail = wake.slice(h + 1).map((m) => m.handle);
      const after = tailAfterAnchor(ask, call.input.tool_use_id)!;
      if (tail.some((x) => typeof x !== 'string')) failures.push(`I3 ${at(c)}: a tail message carries no handle`);
      else if (JSON.stringify(tail) !== JSON.stringify(after.slice(after.length - tail.length)) || (after.length > 0 && tail.length === 0)) failures.push(`I3 ${at(c)}: tail handles ${JSON.stringify(tail)} are not the ask's messages after the anchor's results ${JSON.stringify(after)}`);
    }
    return { subjects, failures };
  },
  I4(view) {
    const known = knownAgents(view);
    const subjects = view.filter((i) => i.hook === 'session.compact' && i.input?.trigger === 'auto' && (party(i.input) === 'main' || known.has(i.input.agentId)));
    return { subjects: subjects.length, failures: subjects.filter((i) => i.next !== undefined).map((i) => `I4 ${at(i)}: an automatic ask for a party of ours went to next`) };
  },
  I5(view) {
    const failures: string[] = [];
    let subjects = 0;
    for (const s of view.filter((i) => i.hook === 'skill.prompt')) {
      const around = view.filter((t) => t.hook === 'tool.call' && t.input?.tool === 'Skill' && t.seq < s.seq && s.seq < t.endSeq);
      if (around.length !== 1) continue;
      const key = party(around[0]!.input);
      const wake = nextWake(view, key, s.seq);
      if (!wake) continue;
      subjects++;
      if (!texts(wakeOf(wake)!).includes(s.input.text)) failures.push(`I5 ${at(wake)}: the wake lacks the text of skill.prompt #${s.id} (${s.input.skill}), loaded inside ${key}'s Skill call tool.call #${around[0]!.id}`);
    }
    return { subjects, failures };
  },
  I6(view) {
    const failures: string[] = [];
    let subjects = 0;
    for (const spawn of view.filter((i) => i.hook === 'agent.spawn' && typeof i.nextResult?.result?.agentId === 'string')) {
      for (const c of view.filter((i) => party(i.input) === `agent:${spawn.nextResult!.result.agentId}` && wakeOf(i) !== undefined)) {
        subjects++;
        if (!texts(wakeOf(c)!).includes(`## Your brief\n${spawn.input.prompt}`)) failures.push(`I6 ${at(c)}: "## Your brief" is not agent.spawn #${spawn.id}'s prompt`);
      }
    }
    return { subjects, failures };
  },
  I7(view) {
    const failures: string[] = [];
    let subjects = 0;
    for (const r of view.filter((i) => i.hook === 'session.receive' && party(i.input) !== 'main')) {
      const wake = nextWake(view, party(r.input), r.seq);
      if (!wake) continue;
      subjects++;
      if (!texts(wakeOf(wake)!).includes(r.input.text)) failures.push(`I7 ${at(wake)}: the wake lacks session.receive #${r.id}'s text`);
    }
    return { subjects, failures };
  },
  I8(view) {
    const failures: string[] = [];
    let subjects = 0;
    for (const c of view.filter((i) => wakeOf(i) !== undefined)) {
      const stop = [...view].reverse().find((i) => i.seq < c.seq && (i.hook === 'classic.Stop' || i.hook === 'classic.SubagentStop'));
      if (!stop) continue;
      subjects++;
      const wake = texts(wakeOf(c)!);
      for (const t of stop.input?.background_tasks ?? []) if (!wake.includes(String(t.id)) || (typeof t.command === 'string' && !wake.includes(t.command))) failures.push(`I8 ${at(c)}: shell ${t.id} of ${stop.hook} #${stop.id} is not in the wake`);
    }
    return { subjects, failures };
  },
  I9(view, recorded) {
    if (!recorded) return { subjects: 0, failures: [] };
    const failures: string[] = [];
    let subjects = 0;
    for (const c of view.filter((i) => wakeOf(i) !== undefined)) {
      const step = view.find((i) => i.hook === 'turn.step' && i.seq > c.seq && party(i.input) === party(c.input));
      const after = step ? contextTokens(step.end?.result?.usage) : undefined;
      if (!step || after === undefined) continue;
      subjects++;
      // shortcut: "the messages added since" are not recorded, so the step's count is held at or above the wake's length; tighten when the recorder writes them.
      if (step.input.messageCount < wakeOf(c)!.length) failures.push(`I9 ${at(c)}: turn.step #${step.id} has ${step.input.messageCount} messages, fewer than the wake's ${wakeOf(c)!.length}`);
      if (!(after < c.end!.result.tokensBefore)) failures.push(`I9 ${at(c)}: turn.step #${step.id} read ${after}, not below the ${c.end!.result.tokensBefore} before the install`);
    }
    return { subjects, failures };
  },
  I10(view) {
    const subjects = view.filter((i) => wakeOf(i) !== undefined);
    return { subjects: subjects.length, failures: subjects.filter((i) => !i.calls.some((c) => c.path === 'ui.log' && /handoff landed — |mechanical wake (was )?installed/.test(String(c.args[0])) && (c.args[1] as any)?.to !== 'debug')).map((i) => `I10 ${at(i)}: the install said nothing on screen`) };
  },
  I11(view) {
    const failures: string[] = [];
    let subjects = 0;
    const installs = view.filter((i) => wakeOf(i)?.some((m) => String(m.text).includes('=== handoff ===')));
    for (const [n, second] of installs.entries()) {
      const first = installs.slice(0, n).reverse().find((i) => party(i.input) === party(second.input));
      if (!first) continue;
      const tail = (inv: Invocation) => wakeOf(inv)!.filter((m) => m.handle !== undefined);
      const before = new Map(tail(first).flatMap((m) => toolIds(m).map((id) => [id, payload(m)] as const)));
      for (const m of tail(second)) for (const id of toolIds(m)) if (before.has(id)) {
        subjects++;
        if (before.get(id) !== payload(m)) failures.push(`I11 ${at(second)}: the message of ${id} kept since ${at(first)} changed its payload`);
      }
    }
    return { subjects, failures };
  },
  I12(view) {
    const failures: string[] = [];
    let subjects = 0;
    for (const n of view.filter((i) => (i.hook === 'prompt.submit' || i.hook === 'session.receive') && /task|notification/i.test(String(i.input?.origin?.kind)))) {
      const wake = nextWake(view, party(n.input), n.seq);
      if (!wake) continue;
      subjects++;
      const times = count(texts(wakeOf(wake)!), n.input.text);
      if (times !== 1) failures.push(`I12 ${at(wake)}: the notification of ${n.hook} #${n.id} appears ${times} times`);
    }
    return { subjects, failures };
  },
  I13(view) {
    const failures: string[] = [];
    let subjects = 0;
    for (const t of view.filter((i) => i.hook === 'tool.call' && isForward(i.input?.tool) && party(i.input) !== 'main')) {
      const reading = readingAt(view, party(t.input), t.seq);
      if (reading === undefined || reading >= askPointAt(view, party(t.input), t.seq) || !/Handoff stored/.test(String(t.end?.result?.result))) continue;
      subjects++;
      if (!String(t.end?.result?.result).includes('from about')) failures.push(`I13 ${at(t)}: a sub-agent's receipt below its ask point lacks "from about"`);
    }
    return { subjects, failures };
  },
};

/** Both views through every invariant; `exercised` must each have run on at least one subject in both. */
async function gate(rows: readonly Row[], exercised: readonly Name[]): Promise<string[]> {
  const { replayed, unrecorded } = await replay(rows);
  const views = { recorded: invocations(rows), replayed } as const;
  const out = [...unrecorded];
  for (const [label, view] of Object.entries(views)) {
    for (const name of ALL) {
      const v = INVARIANTS[name](view, label === 'recorded');
      out.push(...v.failures.map((f) => `${label}: ${f}`));
      if (exercised.includes(name) && v.subjects === 0 && !(name === 'I9' && label === 'replayed')) out.push(`${label}: ${name} not exercised: no subject in this fixture`);
    }
  }
  return out;
}

const VERSION = /^\/\/ Written by Claude Code ([0-9][0-9.]*)\.$/.exec(readFileSync(join(ROOT, 'types/claude-code.d.ts'), 'utf8').split('\n')[0]!)?.[1];
/** The version pin (gate 7): the fixture directory of the version the types are written by must exist. */
function pinned(version: string | undefined, dirs: readonly string[]): void {
  if (version === undefined) throw new Error('types/claude-code.d.ts line 1 names no Claude Code version');
  if (!dirs.includes(version)) throw new Error(`no replay fixture for Claude Code ${version}: run npm run replay:record`);
}
const fixtureDirs = (): string[] => (existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((d) => existsSync(join(FIXTURES, d, 'session.jsonl.gz')) || existsSync(join(FIXTURES, d, 'session.jsonl'))) : []);
const fixtureOf = (dir: string): string => (existsSync(join(FIXTURES, dir, 'session.jsonl.gz')) ? join(FIXTURES, dir, 'session.jsonl.gz') : join(FIXTURES, dir, 'session.jsonl'));

const SYNTHETIC_EXERCISES: readonly Name[] = ['I3', 'I4', 'I5', 'I6', 'I10', 'I13'];

describe('replay gate (D19)', () => {
  if (process.env.REPLAY_WRITE_SYNTHETIC === '1') {
    it('writes the synthetic fixture from the scripted session', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fc-synthetic-'));
      try {
        const rows = await recordSynthetic(dir);
        execFileSync(process.execPath, [SANITIZE, rows, '--out', SYNTHETIC]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it.each(fixtureDirs())('fixture %s passes every invariant on its recorded and replayed outputs', async (dir) => {
    expect(await gate(loadFixture(fixtureOf(dir)), dir === 'synthetic' ? SYNTHETIC_EXERCISES : ALL)).toEqual([]);
  });

  it('the synthetic fixture holds the R40 scenario: session.start, a Skill call with skill.prompt nested, forward_compaction, an automatic ask (I3, I5)', async () => {
    const view = invocations(loadFixture(SYNTHETIC));
    const skill = view.find((i) => i.hook === 'skill.prompt')!;
    expect(view.map((i) => i.hook)).toEqual(['session.start', 'prompt.submit', 'tool.call', 'agent.spawn', 'turn.step', 'tool.call', 'skill.prompt', 'turn.step', 'tool.call', 'turn.step', 'session.compact']);
    expect(view.find((i) => i.id === skill.parent)?.input.tool).toBe('Skill');
    expect(INVARIANTS.I3(view, true).subjects).toBe(1);
    expect(INVARIANTS.I5(view, true).subjects).toBe(1);
  });

  it('removing the nested skill.prompt fails the run naming I5', async () => {
    const rows = loadFixture(SYNTHETIC);
    const skill = invocations(rows).find((i) => i.hook === 'skill.prompt')!;
    const failures = await gate(rows.filter((r) => r.id !== skill.id), SYNTHETIC_EXERCISES);
    expect(failures).toContain('recorded: I5 not exercised: no subject in this fixture');
    expect(failures).toContain('replayed: I5 not exercised: no subject in this fixture');
  });

  it('a recorded wake without the skill text fails I5 naming the hook, its number and the party', async () => {
    const rows = loadFixture(SYNTHETIC);
    const view = invocations(rows);
    const skill = view.find((i) => i.hook === 'skill.prompt')!;
    const compact = view.find((i) => i.hook === 'session.compact')!;
    const edited = rows.map((r) => (r.id === compact.id && r.phase === 'end' ? JSON.parse(JSON.stringify(r).split(JSON.stringify(skill.input.text).slice(1, -1)).join('(gone)')) : r));
    expect(await gate(edited, SYNTHETIC_EXERCISES)).toContain(`recorded: I5 session.compact #${compact.id} agent:a1b2c3d4e5: the wake lacks the text of skill.prompt #${skill.id} (replay-rules), loaded inside agent:a1b2c3d4e5's Skill call tool.call #${skill.parent}`);
  });

  it('a $ call the recording lacks fails as unrecorded (R41)', async () => {
    const rows = loadFixture(SYNTHETIC);
    const compact = invocations(rows).find((i) => i.hook === 'session.compact')!;
    const failures = await gate(rows.filter((r) => !(r.id === compact.id && r.phase === 'call' && r.path === 'agent.list')), SYNTHETIC_EXERCISES);
    expect(failures).toContain('unrecorded $ call agent.list in session.compact #11');
  });

  it('zero invocations fails "replayed 0 invocations", never passes (R42)', async () => {
    await expect(replay([])).rejects.toThrow('replayed 0 invocations');
    await expect(replay([{ seq: 1, id: 0, phase: 'version', result: { version: '2.1.309' } }])).rejects.toThrow('replayed 0 invocations');
  });

  it('a fixture directory missing for the types version fails naming it (R42)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-pin-'));
    try {
      mkdirSync(join(dir, 'synthetic'));
      expect(() => pinned('2.1.309', readdirSync(dir))).toThrow('no replay fixture for Claude Code 2.1.309: run npm run replay:record');
      mkdirSync(join(dir, '2.1.309'));
      expect(() => pinned('2.1.309', readdirSync(dir))).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  if (LIVE_FIXTURE_PENDING) it.todo(`the live fixture for Claude Code ${VERSION} (U8 records it; until then: no replay fixture for Claude Code ${VERSION}: run npm run replay:record)`);
  else it('a fixture exists for the Claude Code version the types are written by (gate 7)', () => pinned(VERSION, fixtureDirs()));
});

describe('the recorder', () => {
  it('records the synthetic session as rows with no gap, under the 4 MiB write limit', async () => {
    vi.resetModules();
    const dir = mkdtempSync(join(tmpdir(), 'fc-record-'));
    try {
      const rows = await recordSynthetic(dir);
      const names = readdirSync(rows);
      const seqs = names.map((n) => Number(n.slice(0, 6))).sort((a, b) => a - b);
      expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      expect(names.every((n) => readFileSync(join(rows, n)).length < 4_194_304 / 2)).toBe(true);
      const recorded = invocations(names.sort().map((n) => JSON.parse(readFileSync(join(rows, n), 'utf8'))));
      expect(recorded.find((i) => i.hook === 'skill.prompt')?.parent).toBe(recorded.find((i) => i.input?.tool === 'Skill')?.id);
      expect(recorded.find((i) => i.hook === 'session.compact')?.calls.map((c) => c.path)).toContain('agent.list');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('splits a row longer than its part size into parts, each far below 4 MiB', () => {
    const parts = rowFiles({ seq: 7, id: 1, phase: 'start', hook: 'session.compact', input: { text: 'é'.repeat(PART_CHARS * 2 + 5) } });
    expect(parts.map((p) => p.name)).toEqual(['000007.json.1of3', '000007.json.2of3', '000007.json.3of3']);
    expect(parts.every((p) => Buffer.byteLength(p.text) <= 1.5 * 1024 * 1024)).toBe(true);
    expect(JSON.parse(parts.map((p) => p.text).join('')).input.text.length).toBe(PART_CHARS * 2 + 5);
  });

  it('wraps every event and $ path the adapter uses, and every variable it reads, spelled as Claude Code requires', () => {
    const adapter = readFileSync(join(ROOT, 'plugins/forward-compaction/hooks/forward-compaction.ts'), 'utf8');
    expect(new Set(adapter.match(/(?<=\bon\(')[^']+/g))).toEqual(new Set(RECORDED));
    expect(new Set(adapter.match(/(?<=\$\.)[a-z]+\.[a-zA-Z]+/g))).toEqual(new Set(PATHS));
    expect(new Set(adapter.match(/(?<=\$\.env\.get\(')[^']+/g))).toEqual(new Set(ENV_NAMES));
  });
});

describe('sanitize.mjs (R43)', () => {
  const run = (rows: readonly (object | string)[], home: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-sanitize-'));
    for (const row of rows) writeFileSync(join(dir, `${String((typeof row === 'string' ? JSON.parse(row) : row).seq).padStart(6, '0')}.json`), typeof row === 'string' ? row : JSON.stringify(row));
    const out = join(dir, 'out.jsonl');
    const r = spawnSync(process.execPath, [SANITIZE, dir, '--out', out, '--home', home], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } });
    const text = existsSync(out) ? readFileSync(out, 'utf8') : '';
    rmSync(dir, { recursive: true, force: true });
    return { code: r.status, stderr: r.stderr, text };
  };
  // An invented account: the repo is public, so no real name is written here.
  const home = '/srv/casey';
  const base = [
    { seq: 1, id: 0, phase: 'version', result: { version: '2.1.309' } },
    { seq: 2, id: 1, phase: 'call', path: 'env.get', args: ['HOME'], result: home },
    { seq: 3, id: 1, phase: 'call', path: 'session.id', args: [], result: '6f1c2d3e-0000-4000-8000-123456789abc' },
  ];

  it('replaces the home, the account name, the session id and an email, and exits 0', () => {
    const r = run([...base, { seq: 4, id: 1, phase: 'start', hook: 'tool.call', input: { path: `${home}/x`, who: 'casey', mail: 'casey.k@corp.example', session: '6f1c2d3e-0000-4000-8000-123456789abc' } }], home);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.text).toContain('/HOME/x');
    expect(r.text).toContain('"who":"user"');
    expect(r.text).toContain('"mail":"user@example.invalid"');
    expect(r.text).toContain('"session":"00000000-0000-0000-0000-000000000000"');
    expect(r.text).not.toMatch(/casey|corp\.example|6f1c2d3e/);
  });

  it('exits 1 naming the row when an email the replacer missed survives', () => {
    const r = run([...base, { seq: 4, id: 1, phase: 'start', hook: 'prompt.submit', input: { text: 'write to zoë@corp.example' } }], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('sanitize: row 4: an email address survives sanitizing');
    expect(r.text).toBe('');
  });

  it('exits 1 naming a missing row', () => {
    const r = run([base[0]!, { seq: 3, id: 1, phase: 'start', hook: 'x' }], home);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('sanitize: row 2 missing');
  });
});
