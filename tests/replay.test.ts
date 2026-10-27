// The replay gate (spec § Tests, replay gate 5-7; D19): every fixture under tests/fixtures/replay/*/ replayed
// through the real register, and the invariants I1-I13 run on its recorded outputs (the live system) and on the
// replayed outputs (current code). Each failure names the invariant, the hook, its invocation number and the party.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ANSWERS, loadFixture, invocations, replay, recordSynthetic, type Invocation } from './fakes/replay-engine.ts';
import { ENV_NAMES, PATHS, PART_CHARS, RECORDED, rowFiles, type Row } from '../scripts/replay/recorder.ts';
import { contextTokens } from '../plugins/forward-compaction/src/decide.ts';
import { parseFrontier } from '../plugins/forward-compaction/src/frontier.ts';
import { resolveOptions, subagentMaxContext } from '../plugins/forward-compaction/src/options.ts';
import { askPointOf, partyMarks } from '../plugins/forward-compaction/src/window.ts';

const ROOT = join(import.meta.dirname, '..');
const FIXTURES = join(ROOT, 'tests/fixtures/replay');
const SANITIZE = join(ROOT, 'scripts/replay/sanitize.mjs');

const ALL = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10', 'I11', 'I12', 'I13'] as const;
type Name = (typeof ALL)[number];
type Verdict = { subjects: number; failures: string[] };
type View = readonly Invocation[];

const party = (input: any): string => (typeof input?.agentId === 'string' && input.agentId !== '' ? `agent:${input.agentId}` : 'main');
const at = (inv: Invocation): string => `${inv.hook} #${inv.id} ${party(inv.input)}`;
const isForward = (tool: unknown): boolean => typeof tool === 'string' && tool.endsWith('__forward_compaction');
/** A wake this plugin built: the messages a session.compact returned without calling next (a native summary passed through next is Claude Code's, not an install). */
const wakeOf = (inv: Invocation): any[] | undefined => (inv.hook === 'session.compact' && inv.next === undefined && Array.isArray(inv.end?.result?.messages) ? inv.end!.result.messages : undefined);
const texts = (messages: readonly any[]): string => messages.map((m) => [m.text ?? '', ...(m.toolResults ?? []).map((r: any) => r.text ?? '')].join('\n')).join('\n');
const nextWake = (view: View, key: string, after: number): Invocation | undefined => view.find((c) => c.seq > after && party(c.input) === key && wakeOf(c) !== undefined);
/** The frontier the plugin assembled from the call's section arguments, or undefined when it refused them. */
const SECTION_KEYS = ['objective', 'done', 'remaining', 'next', 'blocked', 'findings'];
const frontierOf = (call: Invocation): string | undefined => {
  const args = call.input?.objective !== undefined ? call.input : call.input?.input ?? {};
  const out = parseFrontier(Object.fromEntries(SECTION_KEYS.filter((key) => key in args).map((key) => [key, args[key]])));
  return 'frontier' in out ? out.frontier : undefined;
};
const count = (hay: string, needle: string): number => (needle === '' ? 0 : hay.split(needle).length - 1);
const knownAgents = (view: View): Set<string> => new Set(view.filter((i) => i.hook === 'agent.spawn').map((i) => i.nextResult?.result?.agentId).filter((id): id is string => typeof id === 'string'));

/** The ask point of a party, from what the plugin read through the API: session.start's `$.session.usage` breakdown, held at the party's max context from the recorded options. */
function askPointAt(view: View, key: string): number {
  const usage = view.find((i) => i.hook === 'session.start')?.calls.find((c) => c.path === 'session.usage')?.result?.context;
  const vars = Object.fromEntries(view.flatMap((i) => i.calls).filter((c) => c.path === 'env.get' && typeof c.result === 'string').map((c) => [c.args[0] as string, c.result as string]));
  const config = resolveOptions({ vars });
  const api = askPointOf(usage?.breakdown, usage?.window)?.tokens;
  const m = key === 'main' ? partyMarks(config.main, config.main.maxContext ?? usage?.window, api) : partyMarks(config.subagent, subagentMaxContext(config.subagent.maxContext, view.find((i) => i.hook === 'turn.step' && party(i.input) === key)?.input?.model), api);
  return m?.askPoint ?? Number.POSITIVE_INFINITY;
}
/** The party's reading the plugin held at `seq`: the last of its steps that had ended by then (a step still open, its tools running, is not read yet). */
function readingAt(view: View, key: string, seq: number): number | undefined {
  const last = [...view].reverse().find((i) => i.hook === 'turn.step' && i.endSeq < seq && party(i.input) === key);
  return last ? contextTokens(last.end?.result?.usage) : undefined;
}

/** The I3 tail rule: the frontier verbatim in the last hook-built message, then only handle-carrying messages, a suffix of the ask's messages after the anchor's results. */
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
      if (!wake || !wake.some((m) => typeof m.text === 'string' && m.text.includes('=== frontier ==='))) continue;
      subjects++;
      const ask: any[] = c.input?.messages ?? [];
      const call = [...view].reverse().find((t) => t.seq < c.seq && t.hook === 'tool.call' && isForward(t.input?.tool) && party(t.input) === party(c.input) && tailAfterAnchor(ask, t.input.tool_use_id) !== undefined);
      if (!call) { failures.push(`I3 ${at(c)}: no forward_compaction call of this party is in the ask's messages`); continue; }
      const h = wake.findLastIndex((m) => m.handle === undefined);
      if (h < 0 || !String(wake[h].text).includes(`=== frontier ===\n${frontierOf(call)}\n=== end of frontier ===`)) failures.push(`I3 ${at(c)}: the last hook-built message lacks the frontier of tool.call #${call.id} verbatim`);
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
      // the woken sub-agent is not its own background task: its wake leaves it out (CHANGELOG 1.0.0-dev.2)
      for (const t of stop.input?.background_tasks ?? []) if (t.id !== c.input?.agentId && (!wake.includes(String(t.id)) || (typeof t.command === 'string' && !wake.includes(t.command)))) failures.push(`I8 ${at(c)}: shell ${t.id} of ${stop.hook} #${stop.id} is not in the wake`);
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
    // The landed line is measured: written at the party's first reading after the install (its next turn.step), or at its end.
    const subjects = view.filter((i) => wakeOf(i) !== undefined);
    const said = (wake: Invocation): boolean => {
      const label = party(wake.input) === 'main' ? 'main' : String(wake.input.agentId).slice(0, 6);
      const step = view.find((i) => i.hook === 'turn.step' && i.seq > wake.seq && party(i.input) === party(wake.input));
      // Logged in a row the plugin writes through process.run, or said on screen in recordings of older builds (a mechanical wake; a frontier too before 1.0.0-dev.3).
      const landed = /frontier landed — |mechanical wake (was )?installed/;
      const told = (c: { path: string; args: unknown[] }): boolean => c.path === 'ui.log' ? landed.test(String(c.args[0])) && String(c.args[0]).includes(label) && (c.args[1] as any)?.to !== 'debug' : c.path === 'process.run' && landed.test(JSON.stringify(c.args)) && JSON.stringify(c.args).includes(label);
      return view.some((i) => i.seq >= wake.seq && i.seq <= (step?.endSeq ?? Infinity) && i.calls.some(told));
    };
    return { subjects: subjects.length, failures: subjects.filter((i) => !said(i)).map((i) => `I10 ${at(i)}: the install's landed line was neither logged nor said by the party's first reading after it`) };
  },
  I11(view) {
    const failures: string[] = [];
    let subjects = 0;
    const installs = view.filter((i) => wakeOf(i)?.some((m) => String(m.text).includes('=== frontier ===')));
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
      if (reading === undefined || reading >= askPointAt(view, party(t.input)) || !/Frontier stored/.test(String(t.end?.result?.result))) continue;
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

/** What the live recording on 2.1.309 cannot give a subject, and why; every other invariant must run on one. */
export const LIVE_NOT_EXERCISED: Partial<Record<Name, string>> = {
  I2: 'Claude Code 2.1.309 sent no precompute ask in the recorded session (O3: its frequency is unproven)',
  I11: "a chained install's anchor is a new forward_compaction call made after every message the install before it kept, so the two tails share no message",
};
const LIVE_EXERCISES: readonly Name[] = ALL.filter((name) => LIVE_NOT_EXERCISED[name] === undefined);
const LIVE = (): Row[] => loadFixture(fixtureOf('2.1.309'));
/** A skill.prompt loaded inside a Skill call, with the next wake of the party that made the call: an I5 subject. */
function skillSubject(view: View): { skill: Invocation; call: Invocation; wake: Invocation } {
  for (const skill of view.filter((i) => i.hook === 'skill.prompt')) {
    const call = view.find((t) => t.id === skill.parent && t.input?.tool === 'Skill');
    const wake = call && nextWake(view, party(call.input), skill.seq);
    if (call && wake) return { skill, call, wake };
  }
  throw new Error('no skill.prompt inside a Skill call is followed by a wake of its party');
}

// Each replay really runs the plugin's log appends, so a fixture replay takes seconds.
describe('replay gate (D19)', { timeout: 60_000 }, () => {
  it.each(fixtureDirs())('fixture %s passes every invariant on its recorded and replayed outputs', async (dir) => {
    expect(await gate(loadFixture(fixtureOf(dir)), LIVE_EXERCISES)).toEqual([]);
  });

  it('the live fixture holds the R40 scenario: session.start, a Skill call with skill.prompt nested, forward_compaction with a load file carried, an automatic ask (I3, I5)', () => {
    const view = invocations(LIVE());
    expect(view[0]?.hook).toBe('session.start');
    expect(skillSubject(view).call.input.tool).toBe('Skill');
    expect(view.some((i) => i.hook === 'tool.call' && isForward(i.input?.tool))).toBe(true);
    // the six-argument tool: a call with load_files, its file read, and its lines carried in a wake
    const loads = (i: Invocation): unknown => i.input?.load_files ?? i.input?.input?.load_files;
    expect(view.some((i) => i.hook === 'tool.call' && isForward(i.input?.tool) && Array.isArray(loads(i)) && (loads(i) as unknown[]).length > 0)).toBe(true);
    expect(view.some((i) => i.calls.some((c) => c.path === 'fs.read'))).toBe(true);
    expect(view.some((i) => wakeOf(i) !== undefined && texts(wakeOf(i)!).includes('filler file 1: synthetic text'))).toBe(true);
    expect(view.some((i) => i.hook === 'session.compact' && i.input?.trigger === 'auto')).toBe(true);
    expect(INVARIANTS.I3(view, true).subjects).toBeGreaterThan(0);
    expect(INVARIANTS.I5(view, true).subjects).toBeGreaterThan(0);
  });

  it('removing every skill.prompt fails the run naming I5', async () => {
    const rows = LIVE();
    const skills = new Set(invocations(rows).filter((i) => i.hook === 'skill.prompt').map((i) => i.id));
    const failures = await gate(rows.filter((r) => !skills.has(r.id)), LIVE_EXERCISES);
    expect(failures).toContain('recorded: I5 not exercised: no subject in this fixture');
    expect(failures).toContain('replayed: I5 not exercised: no subject in this fixture');
  });

  it('a recorded wake without the skill text fails I5 naming the hook, its number and the party', async () => {
    const rows = LIVE();
    const { skill, call, wake } = skillSubject(invocations(rows));
    const key = party(call.input);
    const edited = rows.map((r) => (r.id === wake.id && r.phase === 'end' ? JSON.parse(JSON.stringify(r).split(JSON.stringify(skill.input.text).slice(1, -1)).join('(gone)')) : r));
    expect(await gate(edited, LIVE_EXERCISES)).toContain(`recorded: I5 session.compact #${wake.id} ${key}: the wake lacks the text of skill.prompt #${skill.id} (${skill.input.skill}), loaded inside ${key}'s Skill call tool.call #${call.id}`);
  });

  it('a format-bearing $ path the recording never holds fails as unrecorded (R41)', async () => {
    const rows = LIVE();
    const install = invocations(rows).find((i) => wakeOf(i) !== undefined && i.calls.some((c) => c.path === 'agent.list'))!;
    const failures = await gate(rows.filter((r) => !(r.phase === 'call' && r.path === 'agent.list')), LIVE_EXERCISES);
    expect(failures).toContain(`unrecorded $ call agent.list in session.compact #${install.id}`);
  });

  it('an env.get of a variable the recording never read fails as unrecorded, never answered by another variable', async () => {
    const rows = LIVE();
    const env = rows.find((r) => r.phase === 'call' && r.path === 'env.get' && (r.args as unknown[] | undefined)?.[0] === 'FORWARD_COMPACTION_MAIN_CEILING')!;
    const failures = await gate(rows.map((r) => (r === env ? { ...r, args: ['SOME_OTHER_VARIABLE'] } : r)), LIVE_EXERCISES);
    expect(failures).toContain(`unrecorded $ call env.get in session.start #${env.id}`);
  });

  it('a recorded query whose arguments no longer match is answered by the latest recorded answer of its path, the world state then', async () => {
    const rows = LIVE();
    const list = rows.filter((r) => r.phase === 'call' && r.path === 'agent.list');
    expect(list.length).toBeGreaterThan(0);
    const changed = new Set(list);
    expect(await gate(rows.map((r) => (changed.has(r) ? { ...r, args: ['an argument the plugin never passes'] } : r)), LIVE_EXERCISES)).toEqual([]);
  });

  it("the plugin's own utility and effect calls are not pinned: the fixture passes with every recorded process.run and all but one clock.now gone", async () => {
    const rows = LIVE();
    const firstNow = rows.find((r) => r.phase === 'call' && r.path === 'clock.now');
    const stripped = rows.filter((r) => !(r.phase === 'call' && (r.path === 'process.run' || (r.path === 'clock.now' && r !== firstNow))));
    expect(await gate(stripped, LIVE_EXERCISES)).toEqual([]);
  });

  it('process.run really runs the log appends in the sandbox, under the recorded home', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fc-sandbox-'));
    try {
      const rows = LIVE();
      const { replayed, unrecorded } = await replay(rows, dir);
      expect(unrecorded).toEqual([]);
      const runs = replayed.flatMap((i) => i.calls.filter((c) => c.path === 'process.run' && (c.args[0] as string[])[3] === 'plugin-log'));
      expect(runs.length).toBeGreaterThan(0);
      // the plugin's log dir as it built the argv, which the recorded home maps under the sandbox
      const info = join(dir, (runs[0]!.args[0] as string[])[4]!, 'info.jsonl');
      expect(existsSync(info)).toBe(true);
      expect(readFileSync(info, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).length).toBeGreaterThan(0);
      expect(runs.every((c) => c.result?.exitCode === 0)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a process.run path outside the recorded home is refused as a failure', async () => {
    const rows = LIVE();
    const failures = await gate(rows.map((r) => (r.phase === 'call' && r.path === 'env.get' && (r.args as unknown[])[0] === 'PLUGIN_LOG_DIR' ? { ...r, result: '/elsewhere/logs' } : r)), LIVE_EXERCISES);
    expect(failures.some((f) => f.startsWith('process.run outside the replay sandbox: /elsewhere/logs'))).toBe(true);
  });

  it('a hook event whose next the recording never answers fails, never passes silently', async () => {
    const rows = LIVE();
    const step = invocations(rows).find((i) => i.hook === 'turn.step' && i.nextResult !== undefined)!;
    const failures = await gate(rows.filter((r) => !(r.id === step.id && (r.phase === 'nextResult' || r.phase === 'end'))), LIVE_EXERCISES);
    expect(failures).toContain(`unrecorded next in turn.step #${step.id}`);
  });

  it('classifies every $ path the adapter calls, and the utility paths are the harness\'s', () => {
    expect(new Set(Object.keys(ANSWERS))).toEqual(new Set(PATHS));
    expect(Object.entries(ANSWERS).filter(([, how]) => how.from === 'harness').map(([path]) => path).sort()).toEqual(['clock.after', 'clock.now', 'process.run', 'session.id', 'state.get', 'state.set', 'tool.register', 'ui.log']);
  });

  it('replays concurrent parties on the recorded timeline: a step that starts inside another party\'s open step runs after the steps recorded before it', async () => {
    // Party X's step 1 (30k) is open while party Y's step runs; X's step 2 (200k) starts inside Y's window, after X's step 1 ended.
    const live = LIVE();
    const start = live.filter((r) => r.id === invocations(live).find((i) => i.hook === 'session.start')!.id || r.phase === 'version');
    const base = Math.max(...start.map((r) => r.seq));
    const usage = (tokens: number) => ({ input_tokens: 2, output_tokens: 10, cache_read_input_tokens: tokens - 2, cache_creation_input_tokens: 0 });
    const step = (id: number, agentId: string, index: number, at: [number, number, number, number], tokens: number): Row[] => {
      const input = { turnId: `t-${agentId}`, index, model: 'claude-sonnet-4-5', messageCount: 10 + index, agentId };
      const result = { turnId: input.turnId, index, answer: '', toolUses: [], stopReason: 'tool_use', usage: usage(tokens) };
      return [
        { seq: base + at[0], id, phase: 'start', hook: 'turn.step', input },
        { seq: base + at[1], id, phase: 'next', input },
        { seq: base + at[2], id, phase: 'nextResult', result },
        { seq: base + at[2] + 0.5, id, phase: 'call', path: 'session.messages', args: [{ as: 'api', agentId }], result: [] }, // the party's ratio base, taken at its first reading
        { seq: base + at[3], id, phase: 'end', result },
      ];
    };
    const rows = [...start, ...step(901, 'xxxxxxxxxx', 0, [1, 2, 9, 10], 30_000), ...step(902, 'yyyyyyyyyy', 0, [3, 4, 12, 13], 30_000), ...step(903, 'xxxxxxxxxx', 1, [11, 14, 15, 16], 200_000)].sort((a, b) => a.seq - b.seq);
    const { replayed, unrecorded } = await replay(rows);
    expect(unrecorded).toEqual([]);
    expect(replayed.find((i) => i.id === 901)?.calls.filter((c) => c.path === 'ui.log')).toEqual([]);
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

  it('a fixture exists for the Claude Code version the types are written by (gate 7)', () => pinned(VERSION, fixtureDirs()));
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
    const r = run([...base, { seq: 4, id: 1, phase: 'start', hook: 'tool.call', input: { path: `${home}/x`, who: 'casey', by: 'Casey', mail: 'casey.k@corp.example', session: '6f1c2d3e-0000-4000-8000-123456789abc' } }], home);
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.text).toContain('/HOME/x');
    expect(r.text).toContain('"who":"user"');
    expect(r.text).toContain('"by":"user"'); // the account name in any case
    expect(r.text).toContain('"mail":"user@example.invalid"');
    expect(r.text).toContain('"session":"00000000-0000-0000-0000-000000000000"');
    expect(r.text).not.toMatch(/casey|corp\.example|6f1c2d3e/i);
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

describe('the replay sanitizer\'s leak check', () => {
  it('names a home under any common prefix, not only /home and /Users', async () => {
    // @ts-expect-error sanitize.mjs is an untyped dev script
    const { leaks } = await import('../scripts/replay/sanitize.mjs');
    for (const path of ['/root/x', '/var/home/someone/x', '/home/someone/x', '/Users/someone/x']) expect(leaks({ v: path }, { names: [] }), path).not.toEqual([]);
  });
});
