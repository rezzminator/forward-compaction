// Main's model switch (model-switch.ts): each decision as a table row, then the adapter's turn.step hook giving main's
// requests the asked model, never a sub-agent's but a fork of main's switch, only once a trial request naming it was
// answered, only from the first request after a compaction of main known before it, across a plugin restart, and until
// Claude Code names another.
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { switchAnswered, switchAsk, switchCompacted, switchFollow, switchFollowed, switchForkModel, switchMissed, switchPassed, switchRead, switchStep, switchUnrestored, type ModelSwitch, type SwitchCall, type SwitchFollow } from '../plugins/forward-compaction/src/model-switch.ts';
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
    ['below its notice point a name its trial answered waits for main\'s next compaction', undefined, { party: 'main', asked: ' opus ', compacts: false, given: SONNET, tried: answered }, { pending: { model: 'opus', from: SONNET } }, true, `model opus: taken; you continue on it from the first request after your next compaction, and stay on ${SONNET} until then.`, [row('tried', { asked: 'opus', outcome: 'answered', ms: 640 }), row('pending', { asked: 'opus', from: SONNET })], undefined],
    ['a call that compacts begins after the compaction', undefined, { party: 'main', asked: 'opus', compacts: true, given: SONNET, tried: answered }, { pending: { model: 'opus', from: SONNET } }, true, 'model opus: you continue on it from the first request after this compaction.', [row('tried', { asked: 'opus', outcome: 'answered', ms: 640 }), row('pending', { asked: 'opus', from: SONNET })], undefined],
    ['before any request is read, from is left to the begin', undefined, { party: 'main', asked: 'opus', compacts: false, tried: answered }, { pending: { model: 'opus' } }, true, 'model opus: taken; you continue on it from the first request after your next compaction, and stay on your model until then.', [row('tried', { asked: 'opus', outcome: 'answered', ms: 640 }), row('pending', { asked: 'opus', from: null })], undefined],
    ['the model main is on is a no-op', undefined, { party: 'main', asked: SONNET, compacts: true, given: SONNET }, undefined, false, `model ${SONNET}: you are already on it; nothing changes.`, [row('already-on', { asked: SONNET, dropped: null })], undefined],
    ['the switched-to model is a no-op that drops a later ask still pending', { ...active, pending: { model: 'haiku', from: SONNET } }, { party: 'main', asked: 'opus', compacts: false, given: SONNET }, active, true, 'model opus: you are already on it; nothing changes.', [row('already-on', { asked: 'opus', dropped: 'haiku' })], undefined],
    ['the model main is on drops a pending switch, the forks that follow kept', { pending: { model: 'haiku', from: SONNET }, forks: { f1: { model: 'opus', from: SONNET } } }, { party: 'main', asked: SONNET, compacts: false, given: SONNET }, { forks: { f1: { model: 'opus', from: SONNET } } }, true, `model ${SONNET}: you are already on it; nothing changes.`, [row('already-on', { asked: SONNET, dropped: 'haiku' })], undefined],
    ['the model Claude Code names while switched asks main back, untried, from the first request after the next compaction', active, { party: 'main', asked: SONNET, compacts: false, given: SONNET }, { ...active, pending: { model: SONNET, from: SONNET } }, true, `model ${SONNET}: taken; you continue on it from the first request after your next compaction, and stay on opus until then.`, [row('pending', { asked: SONNET, from: SONNET })], undefined],
    ['a name its trial got an API error for switches nothing', undefined, { party: 'main', asked: 'no-such-model-zz', compacts: false, given: SONNET, tried: { ms: 190, result: NOT_FOUND } }, undefined, false, `model no-such-model-zz: not taken (model_not_found, status 404); you stay on ${SONNET}.`, [], { text: `main stays on ${SONNET}: a trial request naming no-such-model-zz was not answered (model_not_found, status 404).`, level: 'warning', row: row('tried', { asked: 'no-such-model-zz', outcome: 'api-error', why: 'model_not_found, status 404', ms: 190 }) }],
    ['a name Claude Code refused to try leaves a pending switch as it was', { pending: { model: 'haiku', from: SONNET } }, { party: 'main', asked: 'no-such-model-zz', compacts: true, given: SONNET, tried: { ms: 2, rejected: REFUSED('no-such-model-zz') } }, { pending: { model: 'haiku', from: SONNET } }, false, `model no-such-model-zz: not taken (model "no-such-model-zz" is not in this organization's allowlist); you stay on ${SONNET}.`, [], { text: `main stays on ${SONNET}: a trial request naming no-such-model-zz was not answered (model "no-such-model-zz" is not in this organization's allowlist).`, level: 'warning', row: row('tried', { asked: 'no-such-model-zz', outcome: 'rejected', why: 'model "no-such-model-zz" is not in this organization\'s allowlist', ms: 2 }) }],
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

describe('switchCompacted: a compaction of main arms a waiting switch only when known before main\'s next request', () => {
  const waiting: ModelSwitch = { pending: { model: 'opus', from: SONNET } }, armed: ModelSwitch = { pending: { model: 'opus', from: SONNET, armed: true } };
  it.each<[string, ModelSwitch | undefined, 'before' | 'late', ModelSwitch | undefined, boolean, unknown[]]>([
    ['known before the request, a waiting switch is armed', waiting, 'before', armed, true, [row('armed', { asked: 'opus' })]],
    ['an armed one stays armed', armed, 'before', armed, false, []],
    ['seen late, by its fall, it starts nothing and says why', waiting, 'late', waiting, false, [row('passed', { asked: 'opus', why: 'seen-late' })]],
    ['an active switch alone is left as it is', active, 'before', active, false, []],
    ['no switch, nothing moves', undefined, 'late', undefined, false, []],
  ])('%s', (_, held, seen, modelSwitch, changed, rows) => {
    expect(switchCompacted(held, seen)).toEqual({ modelSwitch, changed, rows });
  });
});

describe("switchMissed: each party whose request went out unswitched past the restore's bound stays on that model", () => {
  const follow: SwitchFollow = { model: 'opus', from: SONNET };
  const suspended = (asked: string) => ({ text: `the switch to ${asked} waits for main's next compaction: a request went out on ${SONNET} while restoring what main kept ran past 2 s.`, level: 'warning', row: row('suspended', { asked, from: SONNET, why: 'unrestored' }) });
  const unfollow = (id: string) => ({ event: 'model-switch', party: `agent:${id}`, phase: 'unfollow', asked: 'opus', from: SONNET, why: 'unrestored' });
  it.each<[string, ModelSwitch | undefined, string[], ModelSwitch | undefined, unknown[], unknown]>([
    ["main's armed switch waits for the next compaction again", { pending: { model: 'haiku', from: SONNET, armed: true } }, ['main'], { pending: { model: 'haiku', from: SONNET } }, [row('passed', { asked: 'haiku', why: 'unrestored' })], undefined],
    ["main's active switch waits again for main's next compaction, took dropped, said once", { active: { model: 'opus', from: SONNET, took: true } }, ['main'], { pending: { model: 'opus', from: SONNET } }, [], suspended('opus')],
    ['a newer ask still waiting takes the suspended switch\'s place, its arm spent', { ...active, pending: { model: 'haiku', from: SONNET, armed: true } }, ['main'], { pending: { model: 'haiku', from: SONNET } }, [row('passed', { asked: 'haiku', why: 'unrestored' })], suspended('haiku')],
    ['a waiting one stays waiting', { pending: { model: 'opus' } }, ['main'], { pending: { model: 'opus' } }, [], undefined],
    ['a followed fork stops following for good; main\'s other forks keep theirs', { ...active, forks: { f1: follow, f2: follow } }, ['agent:f1'], { ...active, forks: { f2: follow } }, [unfollow('f1')], undefined],
    ['an agent that follows nothing changes nothing', { ...active, forks: { f1: follow } }, ['agent:f9'], { ...active, forks: { f1: follow } }, [], undefined],
    ['several parties at once: main suspended, its last follow dropped', { ...active, forks: { f1: follow } }, ['agent:f1', 'main', 'agent:f9'], { pending: { model: 'opus', from: SONNET } }, [unfollow('f1')], suspended('opus')],
    ['no switch, nothing moves', undefined, ['main', 'agent:f1'], undefined, [], undefined],
  ])('%s', (_, held, parties, modelSwitch, rows, line) => {
    expect(switchMissed(held, parties)).toEqual({ modelSwitch, changed: rows.length > 0 || line !== undefined, rows, ...(line !== undefined ? { line } : {}) });
  });
});

describe("switchPassed: Claude Code's own summary arms a waiting switch only once it replaced main's context", () => {
  const waiting: ModelSwitch = { pending: { model: 'opus', from: SONNET } };
  it.each<[string, ModelSwitch | undefined, { messages?: unknown; skip?: string }, boolean, ModelSwitch | undefined, boolean, unknown[]]>([
    ['a summary that stands arms it', waiting, { messages: [] }, false, { pending: { model: 'opus', from: SONNET, armed: true } }, true, [row('armed', { asked: 'opus' })]],
    ['a skipped summary compacted nothing', waiting, { skip: 'cancelled' }, false, waiting, false, [row('passed', { asked: 'opus', why: 'skipped' })]],
    ['an aborted one is no proof', waiting, { messages: [] }, true, waiting, false, [row('passed', { asked: 'opus', why: 'aborted' })]],
    ['no switch waiting, nothing to say', active, { skip: 'cancelled' }, false, active, false, []],
  ])('%s', (_, held, result, aborted, modelSwitch, changed, rows) => {
    expect(switchPassed(held, result, aborted)).toEqual({ modelSwitch, changed, rows });
  });
});

describe("switchStep: the model main's request is given", () => {
  const changedLine = (asked: string) => ({ text: `the switch to ${asked} ended: Claude Code now gives main claude-haiku-5-5.`, level: 'info', row: row('ended', { reason: 'model-changed', asked, from: SONNET, given: 'claude-haiku-5-5' }) });
  it.each<[string, ModelSwitch | undefined, string, string, ModelSwitch | undefined, unknown[], unknown]>([
    ['no switch: the model Claude Code named', undefined, SONNET, SONNET, undefined, [], undefined],
    ['a switch armed by a compaction begins, from the model named', { pending: { model: 'opus', from: SONNET, armed: true } }, SONNET, 'opus', active, [row('begin', { asked: 'opus', from: SONNET })], undefined],
    ['one asked before any request was read begins the same', { pending: { model: 'opus', armed: true } }, SONNET, 'opus', active, [row('begin', { asked: 'opus', from: SONNET })], undefined],
    ['a switch still waiting for a compaction leaves the request as named', { pending: { model: 'opus', from: SONNET } }, SONNET, SONNET, { pending: { model: 'opus', from: SONNET } }, [], undefined],
    ['an active switch holds while Claude Code names its from', active, SONNET, 'opus', active, [], undefined],
    ['a switch waiting for a compaction leaves the active one in force', { ...active, pending: { model: 'haiku', from: SONNET } }, SONNET, 'opus', { ...active, pending: { model: 'haiku', from: SONNET } }, [], undefined],
    ['another model named (/model, a relaunch, a fallback) ends an active switch for good', active, 'claude-haiku-5-5', 'claude-haiku-5-5', undefined, [], changedLine('opus')],
    ['another model named ends a pending switch too, said once', { ...active, pending: { model: 'fable', from: SONNET } }, 'claude-haiku-5-5', 'claude-haiku-5-5', undefined, [row('ended', { reason: 'model-changed', asked: 'fable', from: SONNET, given: 'claude-haiku-5-5' })], changedLine('opus')],
    ['an armed switch naming the model named takes main back', { ...active, pending: { model: SONNET, from: SONNET, armed: true } }, SONNET, SONNET, undefined, [], { text: `main is back on ${SONNET}: the switch to opus ended.`, level: 'info', row: row('ended', { reason: 'asked-back', asked: 'opus', from: SONNET, given: SONNET }) }],
    ['an armed switch naming the model named, none active, is dropped', { pending: { model: SONNET, armed: true } }, SONNET, SONNET, undefined, [row('already-on', { asked: SONNET, given: SONNET })], undefined],
    ['the forks that follow outlive the switch\'s end', { ...active, forks: { f1: { model: 'opus', from: SONNET } } }, 'claude-haiku-5-5', 'claude-haiku-5-5', { forks: { f1: { model: 'opus', from: SONNET } } }, [], changedLine('opus')],
    ['a begin carries the forks that follow', { pending: { model: 'opus', armed: true }, forks: { f1: { model: 'fable', from: SONNET } } }, SONNET, 'opus', { ...active, forks: { f1: { model: 'fable', from: SONNET } } }, [row('begin', { asked: 'opus', from: SONNET })], undefined],
  ])('%s', (_, held, given, model, modelSwitch, rows, line) => {
    const out = switchStep(held, given);
    expect(out).toEqual({ modelSwitch, changed: rows.length > 0 || line !== undefined, rows, model, ...(line !== undefined ? { line } : {}) });
  });
});

describe("switchStep: a sub-agent's request is given its follow's model, read from main's switch", () => {
  const held: ModelSwitch = { pending: { model: 'haiku', from: SONNET }, forks: { f1: { model: 'opus', from: SONNET } } };
  it.each<[string, ModelSwitch | undefined, string, string, string]>([
    ['a followed fork named its from is given the switched model', held, 'f1', SONNET, 'opus'],
    ['a followed fork named another model keeps it', held, 'f1', 'claude-haiku-5-5', 'claude-haiku-5-5'],
    ['an agent that follows nothing keeps its model', held, 'f9', SONNET, SONNET],
    ['no switch: as named', undefined, 'f1', SONNET, SONNET],
  ])('%s', (_, h, agentId, given, model) => {
    expect(switchStep(h, given, agentId)).toEqual({ modelSwitch: h, changed: false, rows: [], model });
  });
});

describe("switchAnswered: the first answer settles whether the name was taken", () => {
  const step = (answered: string | null, given = SONNET) => row('step', { given, sent: 'opus', answered });
  it.each<[string, ModelSwitch | undefined, string | undefined, ModelSwitch | undefined, unknown[], unknown]>([
    ['answered by another model: it took, said once', active, OPUS, { active: { model: 'opus', from: SONNET, took: true } }, [step(OPUS)], { text: `main continues on ${OPUS} (asked opus); Claude Code's header and /model still show ${SONNET}.`, level: 'info', row: row('took', { asked: 'opus', from: SONNET, answered: OPUS }) }],
    ['answered by from: not taken, the switch ends with a warning', { ...active, pending: { model: 'haiku', from: SONNET } }, SONNET, { pending: { model: 'haiku', from: SONNET } }, [step(SONNET)], { text: `main stays on ${SONNET}: its request named opus and was answered by ${SONNET}; the switch ended.`, level: 'warning', row: row('ended', { reason: 'not-taken', asked: 'opus', from: SONNET, given: SONNET }) }],
    ['from with its [1m] marker and a dated answer are one model', { active: { model: 'opus', from: `${SONNET}[1m]` } }, `${SONNET}-20261001`, undefined, [step(`${SONNET}-20261001`, `${SONNET}[1m]`)], { text: `main stays on ${SONNET}-20261001: its request named opus and was answered by ${SONNET}-20261001; the switch ended.`, level: 'warning', row: row('ended', { reason: 'not-taken', asked: 'opus', from: `${SONNET}[1m]`, given: `${SONNET}[1m]` }) }],
    ['once taken, a later answer by from changes nothing', { active: { model: 'opus', from: SONNET, took: true } }, SONNET, { active: { model: 'opus', from: SONNET, took: true } }, [step(SONNET)], undefined],
    ['no usage settles nothing', active, undefined, active, [step(null)], undefined],
    ['no switch, no row', undefined, OPUS, undefined, [], undefined],
    ['not taken, the forks that follow are kept', { ...active, forks: { f1: { model: 'opus', from: SONNET } } }, SONNET, { forks: { f1: { model: 'opus', from: SONNET } } }, [step(SONNET)], { text: `main stays on ${SONNET}: its request named opus and was answered by ${SONNET}; the switch ended.`, level: 'warning', row: row('ended', { reason: 'not-taken', asked: 'opus', from: SONNET, given: SONNET }) }],
  ])('%s', (_, held, answered, modelSwitch, rows, line) => {
    const given = held?.active?.from ?? SONNET;
    expect(switchAnswered(held, given, answered)).toEqual({ modelSwitch, changed: line !== undefined, rows, ...(line !== undefined ? { line } : {}) });
  });
});

describe('switchRead: model-switch.json as kept', () => {
  it.each<[string, unknown, ReturnType<typeof switchRead>]>([
    ['a switch both pending and active', { pending: { model: 'haiku', from: SONNET }, active: { model: 'opus', from: SONNET, took: true } }, { modelSwitch: { pending: { model: 'haiku', from: SONNET }, active: { model: 'opus', from: SONNET, took: true } } }],
    ['an empty object is no switch', {}, {}],
    ['a pending one with no from', { pending: { model: 'opus' } }, { modelSwitch: { pending: { model: 'opus' } } }],
    ["an arm is kept: main's next request after a restart is still the first after that compaction", { pending: { model: 'opus', from: SONNET, armed: true } }, { modelSwitch: { pending: { model: 'opus', from: SONNET, armed: true } } }],
    ['an earlier file due at the next request waits for a compaction', { pending: { model: 'opus', at: 'request', from: SONNET } }, { modelSwitch: { pending: { model: 'opus', from: SONNET } } }],
    ['an earlier file waiting for a compaction still waits', { pending: { model: 'opus', at: 'compaction' } }, { modelSwitch: { pending: { model: 'opus' } } }],
    ['an unknown at holds no switch', { pending: { model: 'opus', at: 'later' } }, undefined],
    ['an arm that is not true holds no switch', { pending: { model: 'opus', armed: 'yes' } }, undefined],
    ['an active one with no from holds no switch', { active: { model: 'opus' } }, undefined],
    ['null holds no switch', null, undefined],
    ['the forks that follow, alone', { forks: { f1: { model: 'opus', from: SONNET } } }, { modelSwitch: { forks: { f1: { model: 'opus', from: SONNET } } } }],
    ['no fork follows in an empty forks', { forks: {} }, {}],
    ['a follow with no from holds no switch', { active: { model: 'opus', from: SONNET }, forks: { f1: { model: 'opus' } } }, undefined],
    ['forks that are a list hold no switch', { forks: [{ model: 'opus', from: SONNET }] }, undefined],
  ])('%s', (_, value, read) => {
    expect(switchRead(value)).toEqual(read);
  });
});

describe("switchUnrestored: main's request when the restore of main's kept switch did not settle in time", () => {
  it.each<[string, string, Parameters<typeof switchUnrestored>[2], ReturnType<typeof switchUnrestored>]>([
    ['settled, restored or failed: the request is switched as held', 'main', { timedOut: false, value: undefined }, undefined],
    ['past its bound: out as named, one warning', 'main', { timedOut: true }, { line: { text: `main's request goes out on ${SONNET}, unswitched: restoring what main kept did not finish within 2 s.`, level: 'warning', row: row('unrestored', { given: SONNET, why: 'timed-out', waitMs: 2_000 }) } }],
    ["a sub-agent's past its bound names it", 'agent:f1', { timedOut: true }, { line: { text: `agent f1's request goes out on ${SONNET}, unswitched: restoring what main kept did not finish within 2 s.`, level: 'warning', row: { ...row('unrestored', { given: SONNET, why: 'timed-out', waitMs: 2_000 }), party: 'agent:f1' } } }],
    ['aborted: out as named, nothing said', 'main', { timedOut: true, aborted: true }, {}],
  ])('%s', (_, party, waited, out) => {
    expect(switchUnrestored(party, SONNET, waited)).toEqual(out);
  });
});

describe("switchFollow: a fork of main's switched context follows its model", () => {
  const follow: SwitchFollow = { model: 'opus', from: SONNET };
  const forks = { f1: follow };
  it.each<[string, ModelSwitch | undefined, { fork: boolean; parentAgentId?: string; resume?: string }, SwitchFollow | undefined]>([
    ["main's fork while its switch is active follows it", { ...active, pending: { model: 'haiku', from: SONNET } }, { fork: true }, follow],
    ["main's fork while its switch only waits keeps its model", { pending: { model: 'opus', from: SONNET, armed: true } }, { fork: true }, undefined],
    ["main's fork with no switch keeps its model", undefined, { fork: true }, undefined],
    ['an agent that is no fork keeps its model', active, { fork: false }, undefined],
    ['a fork of a followed fork follows its parent, past the switch\'s end', { forks }, { fork: true, parentAgentId: 'f1' }, follow],
    ['a fork of a fork that does not follow keeps its model', { ...active, forks }, { fork: true, parentAgentId: 'f9' }, undefined],
    ['a resumed fork starts no follow: one it had is still in forks', { ...active, forks }, { fork: true, resume: 'f2' }, undefined],
  ])('%s', (_, held, spawn, out) => {
    expect(switchFollow(held, spawn)).toEqual(out);
  });

  it.each<[string, ModelSwitch | undefined, string | undefined, ModelSwitch]>([
    ["main's fork is kept in the switch's forks", active, undefined, { ...active, forks: { f2: follow } }],
    ["a fork's fork joins the forks already kept", { forks }, 'f1', { forks: { f1: follow, f2: follow } }],
  ])('switchFollowed: %s', (_, held, parent, modelSwitch) => {
    expect(switchFollowed(held, 'f2', follow, parent)).toEqual({ modelSwitch, changed: true, rows: [{ event: 'model-switch', party: 'agent:f2', phase: 'follow', asked: 'opus', from: SONNET, parent: parent ?? 'main' }] });
  });

  it.each<[string, SwitchFollow | undefined, string, string]>([
    ['a followed fork named from is given the switched model', follow, SONNET, 'opus'],
    ['a followed fork named another model keeps it', follow, 'claude-haiku-5-5', 'claude-haiku-5-5'],
    ['an agent that follows nothing keeps its model', undefined, SONNET, SONNET],
  ])('%s', (_, f, given, model) => {
    expect(switchForkModel(f, given)).toBe(model);
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

  /** A /compact typed in main: Claude Code's own summary, answered by `answer`. */
  const typedCompact = (f: Fake, answer: unknown) => f.dispatch('session.compact', { trigger: 'manual', messages: transcript() }, async () => answer);
  /** An ask past main's ceiling whose wake and mechanical wake both throw: Claude Code's own summary, answered by `answer`. */
  const failedCompact = async (f: Fake, sent: string[], answer: unknown) => {
    await step(f, sent, SONNET, SONNET, undefined, 125_000);
    await f.dispatch('session.compact', { trigger: 'auto', messages: [{ role: 'user', get text(): string { throw new Error('unreadable message'); }, toolUses: [] }] }, async () => answer);
  };
  const switchRows = async (f: Fake) => (await level(f, 'debug')).filter((r) => r.event === 'model-switch').map((r) => r.detail as Record<string, unknown>);
  const spawnAgent = (f: Fake, agentId: string, fork: boolean, parentAgentId?: string) => f.dispatch('agent.spawn', { tool_use_id: `tu-${agentId}`, prompt: 'Brief', description: 'one', subagentType: fork ? 'fork' : 'general-purpose', provider: { kind: 'local' }, parentModel: SONNET, background: false, fork, ...(parentAgentId !== undefined ? { parentAgentId } : {}) }, async () => ({ model: SONNET, agentId }));

  it("waits for main's next compaction known before its request, gives a sub-agent its own, keeps the switch across a plugin reload, restored before main's first request, and ends it when Claude Code names another", async () => {
    const files: NonNullable<Script['files']> = {}, sent: string[] = [];
    const f = await begin({ files, complete: async () => ANSWERED });
    await step(f, sent, SONNET, SONNET);
    expect(await askOpus(f)).toEqual([`model opus: taken; you continue on it from the first request after your next compaction, and stay on ${SONNET} until then.`]);
    expect(f.completeCalls).toEqual([TRIAL]);
    await step(f, sent, SONNET, SONNET); // below its notice point the call compacts nothing: main stays on the model its cache holds
    expect(await typedCompact(f, { messages: transcript() })).toEqual({ messages: transcript() });
    await spawnAgent(f, A1, false);
    await step(f, sent, SONNET, OPUS);
    await step(f, sent, SONNET, SONNET, A1);
    expect(sent).toEqual([SONNET, SONNET, 'opus', SONNET]);
    expect(f.texts()).toEqual([`main continues on ${OPUS} (asked opus); Claude Code's header and /model still show ${SONNET}.`]);
    expect(JSON.parse(files[join(f.home, '.local/state/forward-compaction', basename(f.home), 'session-1', 'model-switch.json')]!.content)).toEqual({ active: { model: 'opus', from: SONNET, took: true } });
    const after = await begin({ files, home: f.home }, false), again: string[] = [];
    await step(after, again, SONNET, OPUS); // waits for the kept switch's restore: never the header's model in between
    await step(after, again, SONNET, OPUS);
    await step(after, again, 'claude-haiku-5-5', 'claude-haiku-5-5');
    await step(after, again, 'claude-haiku-5-5', 'claude-haiku-5-5');
    expect(again).toEqual(['opus', 'opus', 'claude-haiku-5-5', 'claude-haiku-5-5']);
    expect(after.texts()).toEqual(['the switch to opus ended: Claude Code now gives main claude-haiku-5-5.']);
  });

  it.each<[string, string, (f: Fake, sent: string[]) => Promise<unknown>, number, Record<string, unknown>]>([
    ['a /compact whose summary stands', 'opus', (f) => typedCompact(f, { messages: transcript() }), 20_000, { phase: 'armed', asked: 'opus', where: 'compactAsk' }],
    ['a /compact whose summary was skipped', SONNET, (f) => typedCompact(f, { skip: 'cancelled' }), 20_000, { phase: 'passed', asked: 'opus', why: 'skipped', where: 'compactAsk' }],
    ["Claude Code's summary after both wakes failed, standing", 'opus', (f, sent) => failedCompact(f, sent, { messages: transcript() }), 20_000, { phase: 'armed', asked: 'opus', where: 'compactFailed' }],
    ["Claude Code's summary after both wakes failed, skipped", SONNET, (f, sent) => failedCompact(f, sent, { skip: 'cancelled' }), 125_000, { phase: 'passed', asked: 'opus', why: 'skipped', where: 'compactFailed' }],
    ['a fall seen only at the request after it', SONNET, async (f, sent) => (await step(f, sent, SONNET, SONNET, undefined, 90_000), step(f, sent, SONNET, SONNET, undefined, 20_000)), 20_000, { phase: 'passed', asked: 'opus', why: 'seen-late', where: 'readStep' }],
  ])("a waiting switch at %s: main's next request goes out on %s", async (_, model, compaction, reading, logged) => {
    const sent: string[] = [];
    const f = await begin({ complete: async () => ANSWERED, env: { FORWARD_COMPACTION_DEBUG: '1' } });
    await step(f, sent, SONNET, SONNET);
    await askOpus(f);
    await compaction(f, sent);
    sent.length = 0;
    await step(f, sent, SONNET, model === 'opus' ? OPUS : SONNET, undefined, reading);
    expect(sent).toEqual([model]);
    expect((await switchRows(f)).filter((d) => d.phase === logged.phase).map(({ ts: _ts, event: _e, party: _p, ...d }) => d)).toEqual([logged]);
  });

  it.each<[string, Script['stateGet'], string[], string, string, string, Record<string, unknown>]>([
    ['fails goes out on the switch its files still restored, as every later one does, the failure said once', (ref) => (ref.key === 'prompts' ? Promise.reject(new Error('state store gone')) : undefined), ['opus', 'opus'], 'errors', 'restore-error', 'restoring what main kept failed: state store gone; its request goes on with what its files restored', { party: 'main', error: 'state store gone' }],
  ])("main's first request after a reload whose restore %s", async (_, stateGet, models, file, event, msg, detail) => {
    const files: NonNullable<Script['files']> = {}, after = await begin({ files, stateGet }, false), sent: string[] = [];
    files[join(after.home, '.local/state/forward-compaction', basename(after.home), 'session-1', 'model-switch.json')] = { content: JSON.stringify({ active: { model: 'opus', from: SONNET, took: true } }) };
    for (const model of models) await step(after, sent, SONNET, model === 'opus' ? OPUS : SONNET);
    expect(sent).toEqual(models);
    expect((await level(after, file)).filter((r) => r.event === event).map((r) => [r.msg, r.detail])).toEqual([[msg, detail]]);
  }, 10_000);

  it("spends a kept arm once main's first request after a reload went out unswitched past the restore's bound: the request after the restore lands stays on Claude Code's model", async () => {
    const files: NonNullable<Script['files']> = {}, sent: string[] = [];
    const after = await begin({ files, stateGet: (ref) => (ref.key === 'prompts' ? new Promise((resolve) => setTimeout(resolve, 2_500)) : undefined) }, false);
    const kept = join(after.home, '.local/state/forward-compaction', basename(after.home), 'session-1', 'model-switch.json');
    files[kept] = { content: JSON.stringify({ pending: { model: 'opus', from: SONNET, armed: true } }) };
    await step(after, sent, SONNET, SONNET);
    for (let i = 0; i < 100 && files[kept]!.content.includes('armed'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    await step(after, sent, SONNET, SONNET);
    expect(sent).toEqual([SONNET, SONNET]);
    expect(JSON.parse(files[kept]!.content), kept).toEqual({ pending: { model: 'opus', from: SONNET } });
  }, 10_000);

  /** The restore of what main kept, as a reloaded plugin reads it back: main's `$.state` prompts take `ms`; a sub-agent's own restore is not slowed. */
  const slowRestore = (ms: number): Script['stateGet'] => (ref) => (ref.key === 'prompts' && ref.id?.endsWith('/main') === true ? new Promise((resolve) => setTimeout(resolve, ms)) : undefined);
  const keptAt = (f: Fake) => join(f.home, '.local/state/forward-compaction', basename(f.home), 'session-1', 'model-switch.json');

  it("keeps main on Claude Code's model once its first request after a reload went out unswitched past the restore's bound: an active switch waits again for main's next compaction, said once", async () => {
    const files: NonNullable<Script['files']> = {}, sent: string[] = [];
    const after = await begin({ files, stateGet: slowRestore(2_500), complete: async () => ANSWERED }, false), kept = keptAt(after);
    files[kept] = { content: JSON.stringify({ active: { model: 'opus', from: SONNET, took: true } }) };
    await step(after, sent, SONNET, SONNET);
    for (let i = 0; i < 100 && files[kept]!.content.includes('active'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    await step(after, sent, SONNET, SONNET);
    expect(JSON.parse(files[kept]!.content), kept).toEqual({ pending: { model: 'opus', from: SONNET } });
    expect((await level(after, 'warnings')).filter((r) => r.event === 'model-switch').map((r) => r.msg)).toEqual([
      `main's request goes out on ${SONNET}, unswitched: restoring what main kept did not finish within 2 s.`,
      `the switch to opus waits for main's next compaction: a request went out on ${SONNET} while restoring what main kept ran past 2 s.`,
    ]);
    await typedCompact(after, { messages: transcript() });
    await step(after, sent, SONNET, OPUS);
    expect(sent).toEqual([SONNET, SONNET, 'opus']);
  }, 10_000);

  it("waits for a restore still running past its bound once: later requests, main's and a fork's, go out as named at once, said by the first alone, and the fork's follow ends once it lands", async () => {
    const files: NonNullable<Script['files']> = {}, sent: string[] = [];
    const after = await begin({ files, stateGet: slowRestore(4_000) }, false), kept = keptAt(after);
    files[kept] = { content: JSON.stringify({ active: { model: 'opus', from: SONNET, took: true }, forks: { f1: { model: 'opus', from: SONNET }, f2: { model: 'opus', from: SONNET } } }) };
    const until = async (n: number, ms: number): Promise<number> => { const t0 = Date.now(); while (sent.length < n && Date.now() - t0 < ms) await new Promise((resolve) => setTimeout(resolve, 10)); return sent.length; };
    const first = step(after, sent, SONNET, SONNET); // its hook awaits main's restore after the request too, so the next ones start while it runs
    expect(await until(1, 3_000)).toBe(1);
    const second = step(after, sent, SONNET, SONNET, 'f1');
    expect(await until(2, 1_000)).toBe(2);
    const third = step(after, sent, SONNET, SONNET);
    expect(await until(3, 1_000)).toBe(3);
    await Promise.all([first, second, third]);
    for (let i = 0; i < 100 && files[kept]!.content.includes('active'); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    await step(after, sent, SONNET, OPUS, 'f2');
    expect(sent).toEqual([SONNET, SONNET, SONNET, 'opus']);
    expect(JSON.parse(files[kept]!.content), kept).toEqual({ pending: { model: 'opus', from: SONNET }, forks: { f2: { model: 'opus', from: SONNET } } });
    expect((await level(after, 'warnings')).filter((r) => r.event === 'model-switch').map((r) => r.msg)).toEqual([
      `main's request goes out on ${SONNET}, unswitched: restoring what main kept did not finish within 2 s.`,
      `the switch to opus waits for main's next compaction: a request went out on ${SONNET} while restoring what main kept ran past 2 s.`,
    ]);
    expect((await switchRows(after)).filter((d) => d.phase === 'unfollow').map(({ ts: _ts, ...d }) => d)).toEqual([{ event: 'model-switch', party: 'agent:f1', phase: 'unfollow', asked: 'opus', from: SONNET, why: 'unrestored', where: 'turn.step' }]);
  }, 15_000);

  it("arms nothing at the plugin's own install whose hook was aborted before it handed the wake back: main's next request stays on Claude Code's model", async () => {
    const sent: string[] = [], stop = new AbortController(), written: string[] = [];
    const f = await begin({ complete: async () => ANSWERED, env: { FORWARD_COMPACTION_DEBUG: '1' }, writeError: (path) => void (written.push(path), path.endsWith('rounds.json') && stop.abort()) });
    await step(f, sent, SONNET, SONNET, undefined, 64_000);
    await f.dispatch('tool.call', { tool: FORWARD, tool_use_id: 'tu-m', objective: 'Ship it.', next: 'Run the gate.', remaining: { add: ['Tag it.'] }, model: 'opus' }, async () => ({ result: 'not ours' })); // a list item, so the install writes rounds.json, where the abort lands
    await f.dispatch('session.compact', { trigger: 'auto', messages: transcript('tu-m') }, async () => ({ skip: 'native ran' }), stop.signal);
    await step(f, sent, SONNET, SONNET);
    expect([stop.signal.aborted, written.filter((path) => path.endsWith('rounds.json')).length], written.join('\n')).toEqual([true, 1]);
    expect(sent).toEqual([SONNET, SONNET]);
    expect((await switchRows(f)).filter((d) => d.phase === 'armed' || d.phase === 'passed').map(({ ts: _ts, event: _e, party: _p, ...d }) => d)).toEqual([{ phase: 'passed', asked: 'opus', why: 'aborted', where: 'compactAsk' }]);
  });

  it("gives a fork of main spawned while its switch is active the switched model for its whole life, and its forks too; a fork spawned while the switch waits, and any other agent, keep theirs", async () => {
    const sent: string[] = [];
    const f = await begin({ complete: async () => ANSWERED, env: { FORWARD_COMPACTION_DEBUG: '1' } });
    await step(f, sent, SONNET, SONNET, undefined, 64_000);
    await askOpus(f);
    await spawnAgent(f, 'p1', true); // the switch only waits: its context is cached on Claude Code's model
    await f.dispatch('session.compact', { trigger: 'auto', messages: transcript('tu-m') }, async () => ({ skip: 'native ran' }));
    await step(f, sent, SONNET, OPUS);
    await spawnAgent(f, 'f1', true);
    await spawnAgent(f, A1, false);
    await step(f, sent, SONNET, SONNET, 'f1'); // a fork's answer by from never ends main's switch
    await spawnAgent(f, 'f2', true, 'f1');
    await step(f, sent, SONNET, OPUS, 'f2');
    await step(f, sent, SONNET, SONNET, A1);
    await step(f, sent, SONNET, SONNET, 'p1');
    await step(f, sent, SONNET, OPUS);
    expect(sent).toEqual([SONNET, 'opus', 'opus', 'opus', SONNET, SONNET, 'opus']);
    expect((await switchRows(f)).filter((d) => d.phase === 'follow' || d.phase === 'ended').map(({ ts: _ts, ...d }) => d)).toEqual([
      { event: 'model-switch', party: 'agent:f1', phase: 'follow', asked: 'opus', from: SONNET, parent: 'main', where: 'agent.spawn' },
      { event: 'model-switch', party: 'agent:f2', phase: 'follow', asked: 'opus', from: SONNET, parent: 'f1', where: 'agent.spawn' },
    ]);
  });

  it.each<[string, boolean]>([
    ['a plugin reload while it still runs', false],
    ['a restart, then a resume of the fork', true],
  ])("keeps a followed fork on the switched model across %s, read from main's kept switch once main's restore settled", async (_, restart) => {
    const files: NonNullable<Script['files']> = {}, sent: string[] = [];
    const f = await begin({ files, complete: async () => ANSWERED });
    await step(f, sent, SONNET, SONNET, undefined, 64_000);
    await askOpus(f);
    await f.dispatch('session.compact', { trigger: 'auto', messages: transcript('tu-m') }, async () => ({ skip: 'native ran' }));
    await step(f, sent, SONNET, OPUS);
    await spawnAgent(f, 'f1', true);
    await step(f, sent, SONNET, OPUS, 'f1');
    for (let i = 0; i < 100 && !files[keptAt(f)]?.content.includes('f1'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
    const after = await begin({ files, home: f.home }, false), again: string[] = [];
    if (restart) {
      await after.dispatch('session.start', { reason: 'resume' }, async () => ({}));
      await after.dispatch('agent.spawn', { tool_use_id: 'tu-r', prompt: 'Go on', description: 'one', subagentType: 'fork', provider: { kind: 'local' }, parentModel: SONNET, background: false, fork: true, resume: { agentId: 'f1' } }, async () => ({ model: SONNET, agentId: 'f1' }));
    }
    await step(after, again, SONNET, OPUS, 'f1');
    expect([sent, again]).toEqual([[SONNET, 'opus', 'opus'], ['opus']]);
  });

  const FOLLOWED: ModelSwitch = { active: { model: 'opus', from: SONNET, took: true }, forks: { f1: { model: 'opus', from: SONNET } } };
  it.each<[string, Script['stateGet'], boolean, string[], ModelSwitch]>([
    ['not begun', undefined, false, ['opus', 'opus'], FOLLOWED],
    ["still running at the fork's first request", slowRestore(300), false, ['opus', 'opus'], FOLLOWED],
    ["past its bound, main's own request gone out unswitched: the fork follows nothing", slowRestore(4_000), true, [SONNET, SONNET, SONNET], { pending: { model: 'opus', from: SONNET } }],
  ])("takes the follow of a fork spawned after a plugin reload as the restore of main's kept switch lands, that restore %s", async (_, stateGet, mainFirst, expected, keptAfter) => {
    const files: NonNullable<Script['files']> = {}, sent: string[] = [], pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const after = await begin({ files, ...(stateGet !== undefined ? { stateGet } : {}) }, false), kept = keptAt(after);
    files[kept] = { content: JSON.stringify({ active: { model: 'opus', from: SONNET, took: true } }) };
    const first = mainFirst ? step(after, sent, SONNET, SONNET) : undefined; // past the bound it goes out as named, its hook still awaiting main's restore
    for (let i = 0; mainFirst && i < 300 && sent.length < 1; i++) await pause(10);
    await spawnAgent(after, 'f1', true); // a spawn can be the first hook after a reload: main's kept switch is not restored yet
    await first;
    for (let i = 0; mainFirst && i < 100 && files[kept]!.content.includes('active'); i++) await pause(50);
    await step(after, sent, SONNET, mainFirst ? SONNET : OPUS, 'f1');
    await step(after, sent, SONNET, mainFirst ? SONNET : OPUS);
    for (let i = 0; !mainFirst && i < 100 && !files[kept]!.content.includes('f1'); i++) await pause(20);
    expect([sent, JSON.parse(files[kept]!.content)], kept).toEqual([expected, keptAfter]);
  }, 15_000);

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
    expect(phases).toEqual(['tried@applyForward', 'pending@applyForward', 'armed@compactAsk', 'begin@turn.step', 'step@turn.step', 'took@turn.step']);
  });
});
