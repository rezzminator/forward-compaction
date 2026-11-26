// Main's model switch (model-switch.ts): each decision as a table row, then the adapter's turn.step hook giving main's
// requests the asked model, never a sub-agent's, only once a trial request naming it was answered, across a plugin
// restart and the plugin's own compaction, and until Claude Code names another.
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { switchAnswered, switchAsk, switchCompacted, switchRead, switchStep, type ModelSwitch, type SwitchCall } from '../plugins/forward-compaction/src/model-switch.ts';
import { fakeEngine, type Script } from './fakes/engine.ts';
import { level, rows, transcript } from './fakes/session.ts';

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const row = (phase: string, detail: Record<string, unknown>) => ({ event: 'model-switch', party: 'main', phase, ...detail });
const active: ModelSwitch = { active: { model: 'opus', from: SONNET } };
/** What `$.model.complete` answered a trial request live (Claude Code 2.1.331): a name it serves; one it does not, with no model allowlist set; a reply with no text; the call cut at its time limit. With an allowlist set it rejected with REFUSED instead. */
const NONE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const ANSWERED = { isAnswered: true, text: 'OK', usage: { ...NONE, input_tokens: 18, output_tokens: 4 } } as const;
const NOT_FOUND = { isAnswered: false, reason: 'api-error', status: 404, error: 'model_not_found', usage: NONE } as const;
const EMPTY = { isAnswered: false, reason: 'empty-reply', usage: NONE } as const;
const TIMED_OUT = { isAnswered: false, reason: 'aborted', usage: NONE } as const;
const REFUSED = (model: string) => `forward-compaction: $.model.complete: model "${model}" is not in this organization's allowlist`;

describe('switchAsk: what a call carrying model does', () => {
  const answered = { ms: 640, result: ANSWERED };
  it.each<[string, ModelSwitch | undefined, SwitchCall, ModelSwitch | undefined, boolean, string, unknown[], unknown]>([
    ['a sub-agent\'s call changes nothing', undefined, { party: 'subagent', asked: 'opus', compacts: false, given: SONNET }, undefined, false, "model is the main chat's alone: ignored.", [row('ignored', { why: 'subagent', asked: 'opus' })], undefined],
    ['a number is no name', undefined, { party: 'main', asked: 4, compacts: false, given: SONNET }, undefined, false, 'model must be a model name; got number: ignored.', [row('ignored', { why: 'no-name', sent: 'number' })], undefined],
    ['a blank text is no name', active, { party: 'main', asked: '  ', compacts: true, given: SONNET }, active, false, 'model must be a model name; got a blank text: ignored.', [row('ignored', { why: 'no-name', sent: 'string' })], undefined],
    ['below its notice point a name its trial answered begins at the next request', undefined, { party: 'main', asked: ' opus ', compacts: false, given: SONNET, tried: answered }, { pending: { model: 'opus', at: 'request', from: SONNET } }, true, 'model opus: you continue on it from your next request.', [row('tried', { asked: 'opus', outcome: 'answered', ms: 640 }), row('pending', { asked: 'opus', at: 'request', from: SONNET })], undefined],
    ['a call that compacts begins after the compaction', undefined, { party: 'main', asked: 'opus', compacts: true, given: SONNET, tried: answered }, { pending: { model: 'opus', at: 'compaction', from: SONNET } }, true, 'model opus: you continue on it from the first request after this compaction.', [row('tried', { asked: 'opus', outcome: 'answered', ms: 640 }), row('pending', { asked: 'opus', at: 'compaction', from: SONNET })], undefined],
    ['before any request is read, from is left to the begin', undefined, { party: 'main', asked: 'opus', compacts: false, tried: answered }, { pending: { model: 'opus', at: 'request' } }, true, 'model opus: you continue on it from your next request.', [row('tried', { asked: 'opus', outcome: 'answered', ms: 640 }), row('pending', { asked: 'opus', at: 'request', from: null })], undefined],
    ['the model main is on is a no-op', undefined, { party: 'main', asked: SONNET, compacts: true, given: SONNET }, undefined, false, `model ${SONNET}: you are already on it; nothing changes.`, [row('already-on', { asked: SONNET, dropped: null })], undefined],
    ['the switched-to model is a no-op that drops a later ask still pending', { ...active, pending: { model: 'haiku', at: 'compaction', from: SONNET } }, { party: 'main', asked: 'opus', compacts: false, given: SONNET }, active, true, 'model opus: you are already on it; nothing changes.', [row('already-on', { asked: 'opus', dropped: 'haiku' })], undefined],
    ['the model Claude Code names while switched asks main back, untried', active, { party: 'main', asked: SONNET, compacts: false, given: SONNET }, { ...active, pending: { model: SONNET, at: 'request', from: SONNET } }, true, `model ${SONNET}: you continue on it from your next request.`, [row('pending', { asked: SONNET, at: 'request', from: SONNET })], undefined],
    ['a name its trial got an API error for switches nothing', undefined, { party: 'main', asked: 'no-such-model-zz', compacts: false, given: SONNET, tried: { ms: 190, result: NOT_FOUND } }, undefined, false, `model no-such-model-zz: not taken (model_not_found, status 404); you stay on ${SONNET}.`, [], { text: `main stays on ${SONNET}: a trial request naming no-such-model-zz was not answered (model_not_found, status 404).`, level: 'warning', row: row('tried', { asked: 'no-such-model-zz', outcome: 'api-error', why: 'model_not_found, status 404', ms: 190 }) }],
    ['a name Claude Code refused to try leaves a pending switch as it was', { pending: { model: 'haiku', at: 'compaction', from: SONNET } }, { party: 'main', asked: 'no-such-model-zz', compacts: true, given: SONNET, tried: { ms: 2, rejected: REFUSED('no-such-model-zz') } }, { pending: { model: 'haiku', at: 'compaction', from: SONNET } }, false, `model no-such-model-zz: not taken (model "no-such-model-zz" is not in this organization's allowlist); you stay on ${SONNET}.`, [], { text: `main stays on ${SONNET}: a trial request naming no-such-model-zz was not answered (model "no-such-model-zz" is not in this organization's allowlist).`, level: 'warning', row: row('tried', { asked: 'no-such-model-zz', outcome: 'rejected', why: 'model "no-such-model-zz" is not in this organization\'s allowlist', ms: 2 }) }],
    ['a trial with no answer within its limit leaves main on its switch', active, { party: 'main', asked: 'haiku', compacts: false, given: SONNET, tried: { ms: 30_000, result: TIMED_OUT } }, active, false, 'model haiku: not taken (no answer within 30 s); you stay on opus.', [], { text: 'main stays on opus: a trial request naming haiku was not answered (no answer within 30 s).', level: 'warning', row: row('tried', { asked: 'haiku', outcome: 'aborted', why: 'no answer within 30 s', ms: 30_000 }) }],
    ['a rejection over several lines is said on one', undefined, { party: 'main', asked: 'opus', compacts: false, given: SONNET, tried: { ms: 3, rejected: 'forward-compaction: $.model.complete: model "opus"\n  is refused ' } }, undefined, false, `model opus: not taken (model "opus" is refused); you stay on ${SONNET}.`, [], { text: `main stays on ${SONNET}: a trial request naming opus was not answered (model "opus" is refused).`, level: 'warning', row: row('tried', { asked: 'opus', outcome: 'rejected', why: 'model "opus" is refused', ms: 3 }) }],
    ['a rejection with no message says so', undefined, { party: 'main', asked: 'opus', compacts: false, given: SONNET, tried: { ms: 3, rejected: ' ' } }, undefined, false, `model opus: not taken (no message given); you stay on ${SONNET}.`, [], { text: `main stays on ${SONNET}: a trial request naming opus was not answered (no message given).`, level: 'warning', row: row('tried', { asked: 'opus', outcome: 'rejected', why: 'no message given', ms: 3 }) }],
    ['a reply with no text before any request is read is no answer either', undefined, { party: 'main', asked: 'opus', compacts: false, tried: { ms: 700, result: EMPTY } }, undefined, false, 'model opus: not taken (empty-reply); you stay on your model.', [], { text: 'main stays on its model: a trial request naming opus was not answered (empty-reply).', level: 'warning', row: row('tried', { asked: 'opus', outcome: 'empty-reply', why: 'empty-reply', ms: 700 }) }],
  ])('%s', (_, held, call, modelSwitch, changed, result, logged, line) => {
    expect(switchAsk(held, call)).toEqual({ modelSwitch, changed, rows: logged, result, ...(line !== undefined ? { line } : {}) });
  });

  it('hands back a name main is not on, trimmed, to be tried before anything changes', () => {
    expect([switchAsk(undefined, { party: 'main', asked: ' opus ', compacts: true, given: SONNET }), switchAsk(active, { party: 'main', asked: 'haiku', compacts: false })]).toEqual([{ trial: 'opus' }, { trial: 'haiku' }]);
  });
});

describe('switchCompacted: a compaction of main lets a waiting switch begin', () => {
  it.each<[string, ModelSwitch | undefined, ModelSwitch | undefined, boolean]>([
    ['waiting for the compaction, it begins at the next request', { pending: { model: 'opus', at: 'compaction', from: SONNET } }, { pending: { model: 'opus', at: 'request', from: SONNET } }, true],
    ['already due at the next request, nothing moves', { pending: { model: 'opus', at: 'request', from: SONNET } }, { pending: { model: 'opus', at: 'request', from: SONNET } }, false],
    ['no switch, nothing moves', undefined, undefined, false],
  ])('%s', (_, held, modelSwitch, changed) => {
    expect(switchCompacted(held)).toEqual({ modelSwitch, changed, rows: changed ? [row('armed', { asked: 'opus' })] : [] });
  });
});

describe("switchStep: the model main's request is given", () => {
  const changedLine = (asked: string) => ({ text: `the switch to ${asked} ended: Claude Code now gives main claude-haiku-5-5.`, level: 'info', row: row('ended', { reason: 'model-changed', asked, from: SONNET, given: 'claude-haiku-5-5' }) });
  it.each<[string, ModelSwitch | undefined, string, string, ModelSwitch | undefined, unknown[], unknown]>([
    ['no switch: the model Claude Code named', undefined, SONNET, SONNET, undefined, [], undefined],
    ['a switch due now begins, from the model named', { pending: { model: 'opus', at: 'request', from: SONNET } }, SONNET, 'opus', active, [row('begin', { asked: 'opus', from: SONNET })], undefined],
    ['one asked before any request was read begins the same', { pending: { model: 'opus', at: 'request' } }, SONNET, 'opus', active, [row('begin', { asked: 'opus', from: SONNET })], undefined],
    ['an active switch holds while Claude Code names its from', active, SONNET, 'opus', active, [], undefined],
    ['a switch waiting for a compaction leaves the active one in force', { ...active, pending: { model: 'haiku', at: 'compaction', from: SONNET } }, SONNET, 'opus', { ...active, pending: { model: 'haiku', at: 'compaction', from: SONNET } }, [], undefined],
    ['another model named (/model, a relaunch, a fallback) ends an active switch for good', active, 'claude-haiku-5-5', 'claude-haiku-5-5', undefined, [], changedLine('opus')],
    ['another model named ends a pending switch too, said once', { ...active, pending: { model: 'fable', at: 'compaction', from: SONNET } }, 'claude-haiku-5-5', 'claude-haiku-5-5', undefined, [row('ended', { reason: 'model-changed', asked: 'fable', from: SONNET, given: 'claude-haiku-5-5' })], changedLine('opus')],
    ['a pending switch naming the model named takes main back', { ...active, pending: { model: SONNET, at: 'request', from: SONNET } }, SONNET, SONNET, undefined, [], { text: `main is back on ${SONNET}: the switch to opus ended.`, level: 'info', row: row('ended', { reason: 'asked-back', asked: 'opus', from: SONNET, given: SONNET }) }],
    ['a pending switch naming the model named, none active, is dropped', { pending: { model: SONNET, at: 'request' } }, SONNET, SONNET, undefined, [row('already-on', { asked: SONNET, given: SONNET })], undefined],
  ])('%s', (_, held, given, model, modelSwitch, rows, line) => {
    const out = switchStep(held, given);
    expect(out).toEqual({ modelSwitch, changed: rows.length > 0 || line !== undefined, rows, model, ...(line !== undefined ? { line } : {}) });
  });
});

describe("switchAnswered: the first answer settles whether the name was taken", () => {
  const step = (answered: string | null, given = SONNET) => row('step', { given, sent: 'opus', answered });
  it.each<[string, ModelSwitch | undefined, string | undefined, ModelSwitch | undefined, unknown[], unknown]>([
    ['answered by another model: it took, said once', active, OPUS, { active: { model: 'opus', from: SONNET, took: true } }, [step(OPUS)], { text: `main continues on ${OPUS} (asked opus); Claude Code's header and /model still show ${SONNET}.`, level: 'info', row: row('took', { asked: 'opus', from: SONNET, answered: OPUS }) }],
    ['answered by from: not taken, the switch ends with a warning', { ...active, pending: { model: 'haiku', at: 'compaction', from: SONNET } }, SONNET, { pending: { model: 'haiku', at: 'compaction', from: SONNET } }, [step(SONNET)], { text: `main stays on ${SONNET}: its request named opus and was answered by ${SONNET}; the switch ended.`, level: 'warning', row: row('ended', { reason: 'not-taken', asked: 'opus', from: SONNET, given: SONNET }) }],
    ['from with its [1m] marker and a dated answer are one model', { active: { model: 'opus', from: `${SONNET}[1m]` } }, `${SONNET}-20261001`, undefined, [step(`${SONNET}-20261001`, `${SONNET}[1m]`)], { text: `main stays on ${SONNET}-20261001: its request named opus and was answered by ${SONNET}-20261001; the switch ended.`, level: 'warning', row: row('ended', { reason: 'not-taken', asked: 'opus', from: `${SONNET}[1m]`, given: `${SONNET}[1m]` }) }],
    ['once taken, a later answer by from changes nothing', { active: { model: 'opus', from: SONNET, took: true } }, SONNET, { active: { model: 'opus', from: SONNET, took: true } }, [step(SONNET)], undefined],
    ['no usage settles nothing', active, undefined, active, [step(null)], undefined],
    ['no switch, no row', undefined, OPUS, undefined, [], undefined],
  ])('%s', (_, held, answered, modelSwitch, rows, line) => {
    const given = held?.active?.from ?? SONNET;
    expect(switchAnswered(held, given, answered)).toEqual({ modelSwitch, changed: line !== undefined, rows, ...(line !== undefined ? { line } : {}) });
  });
});

describe('switchRead: model-switch.json as kept', () => {
  it.each<[string, unknown, ReturnType<typeof switchRead>]>([
    ['a switch both pending and active', { pending: { model: 'haiku', at: 'compaction', from: SONNET }, active: { model: 'opus', from: SONNET, took: true } }, { modelSwitch: { pending: { model: 'haiku', at: 'compaction', from: SONNET }, active: { model: 'opus', from: SONNET, took: true } } }],
    ['an empty object is no switch', {}, {}],
    ['a pending one with no from', { pending: { model: 'opus', at: 'request' } }, { modelSwitch: { pending: { model: 'opus', at: 'request' } } }],
    ['an unknown at holds no switch', { pending: { model: 'opus', at: 'later' } }, undefined],
    ['an active one with no from holds no switch', { active: { model: 'opus' } }, undefined],
    ['null holds no switch', null, undefined],
  ])('%s', (_, value, read) => {
    expect(switchRead(value)).toEqual(read);
  });
});

type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

describe("the turn.step hook gives main's requests the asked model", () => {
  const FORWARD = 'mcp__forward-compaction__forward_compaction';
  const A1 = 'a1b2c3d4e5';
  /** The one trial request the switch makes, as `$.model.complete` received it. */
  const TRIAL = { model: 'opus', prompt: 'Reply with the single word OK.', maxTokens: 4, timeoutMs: 30_000 };
  /** A plugin started with the session, or (`started` false) reloaded within it, so main's next request is the first hook it sees. */
  async function begin(script: Script = {}, started = true): Promise<Fake> {
    const env = { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: '1m', FORWARD_COMPACTION_MAIN_CEILING: '120000', FORWARD_COMPACTION_MAIN_NUDGE_START: '30000', FORWARD_COMPACTION_MAIN_NUDGE_EVERY: '10000' };
    const f = fakeEngine({ window: 1_000_000, ...script, env: { ...env, ...script.env } });
    fakes.push(f);
    if (started) await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
    return f;
  }
  /** One request of main's, or of agent `agentId`, named `given` by Claude Code, read at `tokens` and answered by `answered`: what the hook handed beneath it joins `sent`. */
  const step = (f: Fake, sent: string[], given: string, answered: string, agentId?: string, tokens = 20_000) =>
    f.dispatch('turn.step', { turnId: 't1', index: 0, model: given, messageCount: 4, ...(agentId ? { agentId } : {}) }, async (x: { model: string }) => (sent.push(x.model), { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', usage: { input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: answered } }));
  /** Main's forward_compaction call asking for opus: the lines of its result about the model. */
  const askOpus = async (f: Fake): Promise<string[]> => String((await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-m', objective: 'Ship it.', next: 'Run the gate.', model: 'opus' }, async () => ({ result: 'not ours' }))).result).split('\n').filter((line) => line.startsWith('model opus:'));

  it('gives main the asked model from its next request and a sub-agent its own, keeps it across a plugin reload, and ends it when Claude Code names another', async () => {
    const files: NonNullable<Script['files']> = {}, sent: string[] = [];
    const f = await begin({ files, complete: async () => ANSWERED });
    await step(f, sent, SONNET, SONNET);
    expect(await askOpus(f)).toEqual(['model opus: you continue on it from your next request.']);
    expect(f.completeCalls).toEqual([TRIAL]);
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A1 }));
    await step(f, sent, SONNET, OPUS);
    await step(f, sent, SONNET, SONNET, A1);
    expect(sent).toEqual([SONNET, 'opus', SONNET]);
    expect(f.texts()).toEqual([`main continues on ${OPUS} (asked opus); Claude Code's header and /model still show ${SONNET}.`]);
    expect(JSON.parse(files[join(f.home, '.local/state/forward-compaction', basename(f.home), 'session-1', 'model-switch.json')]!.content)).toEqual({ active: { model: 'opus', from: SONNET, took: true } });
    const after = await begin({ files, home: f.home }, false), again: string[] = [];
    await step(after, again, SONNET, SONNET); // goes out as named while the kept switch is read beside it: no request waits on a restore
    await step(after, again, SONNET, OPUS);
    await step(after, again, 'claude-haiku-5-5', 'claude-haiku-5-5');
    await step(after, again, 'claude-haiku-5-5', 'claude-haiku-5-5');
    expect(again).toEqual([SONNET, 'opus', 'claude-haiku-5-5', 'claude-haiku-5-5']);
    expect(after.texts()).toEqual(['the switch to opus ended: Claude Code now gives main claude-haiku-5-5.']);
  });

  it.each<[string, () => Promise<unknown>, string, string]>([
    ['an API error', async () => NOT_FOUND, 'model_not_found, status 404', 'api-error'],
    ['a refusal', async () => { throw new Error(REFUSED('opus')); }, 'model "opus" is not in this organization\'s allowlist', 'rejected'],
    ['no answer within its limit', async () => TIMED_OUT, 'no answer within 30 s', 'aborted'],
  ])("a name whose trial got %s switches nothing: main's next request goes out as Claude Code named it", async (_, answer, why, outcome) => {
    const sent: string[] = [];
    const f: Fake = await begin({ complete: async () => (f.advance(190), answer()) });
    await step(f, sent, SONNET, SONNET);
    expect(await askOpus(f)).toEqual([`model opus: not taken (${why}); you stay on ${SONNET}.`]);
    await step(f, sent, SONNET, SONNET);
    expect([sent, f.completeCalls, f.texts()]).toEqual([[SONNET, SONNET], [TRIAL], [`main stays on ${SONNET}: a trial request naming opus was not answered (${why}).`]]);
    expect((await rows(f)).filter((r) => r.event === 'model-switch').map(({ ts: _ts, ...r }) => r)).toEqual([{ ...row('tried', { asked: 'opus', outcome, why, ms: 190 }), where: 'applyForward' }]);
  });

  it("gives main the asked model from its first request after the plugin's own install when the call compacts, and not before", async () => {
    const sent: string[] = [];
    const f = await begin({ complete: async () => ANSWERED, env: { FORWARD_COMPACTION_DEBUG: '1' } });
    await step(f, sent, SONNET, SONNET, undefined, 64_000);
    expect(await askOpus(f)).toEqual(['model opus: you continue on it from the first request after this compaction.']);
    await step(f, sent, SONNET, SONNET, undefined, 66_000);
    await f.dispatch('session.compact', { trigger: 'auto', messages: transcript('tu-m') }, async () => ({ skip: 'native ran' }));
    await step(f, sent, SONNET, OPUS);
    expect(sent).toEqual([SONNET, SONNET, 'opus']);
    const phases = (await level(f, 'debug')).filter((r) => r.event === 'model-switch').map((r) => r.detail as Record<string, unknown>).map((d) => `${String(d.phase)}@${String(d.where)}`);
    expect(phases).toEqual(['tried@applyForward', 'pending@applyForward', 'armed@installed', 'begin@turn.step', 'step@turn.step', 'took@turn.step']);
  });
});
