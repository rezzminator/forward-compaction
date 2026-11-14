import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine, usage, type Script } from './fakes/engine.ts';
import { MODEL_WINDOW_TIMEOUT_MS, ModelWindows, askModelWindow, modelWindowRequest, parseModelWindow, type ModelWindowAnswer, type ModelWindowIo } from '../plugins/forward-compaction/src/model-window.ts';

/** The Models API's answers as recorded live on 2026-11-12, cut to the fields the plugin reads beside the ones that name the model. */
const listed = (id: string, window: number): string => JSON.stringify({ type: 'model', id, display_name: 'A model', max_input_tokens: window, max_tokens: 128_000, lifecycle: 'active' });
const NOT_LISTED = '{"type":"error","error":{"type":"not_found_error","message":"model: claude-no-such-model-9"},"request_id":"req_1"}';
const NO_KEY = '{"type":"error","error":{"type":"authentication_error","message":"x-api-key header is required"},"request_id":"req_2"}';

/** A timer that never fires: the lookup settles by its own answer. */
const never = () => ({ cancel: () => {} });
/** An io whose every fetch is answered by `answer`, each call noted. */
function io(answer: (url: string) => { status: number; text: string } | Promise<{ status: number; text: string }>, auth: { handle: string } | null = { handle: 'h-1' }) {
  const calls: { url: string; init: unknown }[] = [];
  const made: ModelWindowIo = { authorize: async () => auth, fetch: async (url, init) => (calls.push({ url, init }), answer(url)) };
  return { made, calls };
}

describe('modelWindowRequest', () => {
  it("asks the Models API for the model by its id, the id escaped so it stays one path segment", () => {
    expect(modelWindowRequest('claude-sonnet-5-5')).toEqual({ url: 'https://api.anthropic.com/v1/models/claude-sonnet-5-5', headers: { 'anthropic-version': '2023-06-01' } });
    expect(modelWindowRequest('vendor/model:0').url).toBe('https://api.anthropic.com/v1/models/vendor%2Fmodel%3A0');
  });
});

describe('parseModelWindow', () => {
  it.each<[string, number, string, ModelWindowAnswer]>([
    ['a listed 1M model', 200, listed('claude-sonnet-5-5', 1_000_000), { window: 1_000_000 }],
    ['a listed 200k model', 200, listed('claude-haiku-4-5-20251001', 200_000), { window: 200_000 }],
    ['a model the API does not list', 404, NOT_LISTED, { unknown: 'the Models API does not list this model (404 not_found_error)', final: true }],
    ['a listed model with no window', 200, '{"type":"model","id":"claude-x"}', { unknown: 'the Models API lists this model with no max_input_tokens', final: true }],
    ['a window that is no token count', 200, '{"type":"model","id":"claude-x","max_input_tokens":"1m"}', { unknown: 'the Models API lists this model with no max_input_tokens', final: true }],
    ['a refused credential', 401, NO_KEY, { unknown: 'the Models API answered 401 authentication_error', final: false }],
    ['an overloaded API with no body', 529, '', { unknown: 'the Models API answered 529', final: false }],
    ['a 200 that is not JSON', 200, '<html>proxy</html>', { unknown: 'the Models API answered 200 with a body that is not JSON', final: false }],
  ])('reads %s', (_name, status, text, want) => {
    expect(parseModelWindow(status, text)).toEqual(want);
  });
});

describe('askModelWindow', () => {
  it("spends the session's credential handle on one request and answers the window", async () => {
    const { made, calls } = io(() => ({ status: 200, text: listed('claude-opus-5-5', 1_000_000) }));
    expect(await askModelWindow('claude-opus-5-5', made)).toEqual({ window: 1_000_000 });
    expect(calls).toEqual([{ url: 'https://api.anthropic.com/v1/models/claude-opus-5-5', init: { headers: { 'anthropic-version': '2023-06-01' }, auth: 'h-1' } }]);
  });

  it('answers why, never a rejection, with no credential or a failed request, and makes no request without a credential', async () => {
    const none = io(() => ({ status: 200, text: listed('claude-opus-5-5', 1_000_000) }), null);
    expect(await askModelWindow('claude-opus-5-5', none.made)).toEqual({ unknown: 'the session holds no Anthropic credential the Models API takes', final: false });
    expect(none.calls).toEqual([]);
    const refused = io(() => Promise.reject(new Error('nonessential traffic is disabled')));
    expect(await askModelWindow('claude-opus-5-5', refused.made)).toEqual({ unknown: 'the Models API lookup failed: nonessential traffic is disabled', final: false });
    const noAuth: ModelWindowIo = { authorize: () => Promise.reject(new Error('authorize denied')), fetch: refused.made.fetch };
    expect(await askModelWindow('claude-opus-5-5', noAuth)).toEqual({ unknown: 'the Models API lookup failed: authorize denied', final: false });
  });
});

describe('ModelWindows', () => {
  it('looks a model up once: none while one runs, none once its window is known, and each model on its own', async () => {
    const windows = new ModelWindows();
    const { made, calls } = io((url) => ({ status: 200, text: listed('m', url.endsWith('claude-haiku-4-5') ? 200_000 : 1_000_000) }));
    expect(windows.get('claude-sonnet-5-5')).toBeUndefined();
    const first = windows.look('claude-sonnet-5-5', made, never);
    expect(windows.look('claude-sonnet-5-5', made, never)).toBeUndefined();
    expect(windows.settled('claude-sonnet-5-5')).toBe(first);
    expect(await first).toEqual({ window: 1_000_000 });
    expect(windows.get('claude-sonnet-5-5')).toEqual({ window: 1_000_000 });
    expect(windows.settled('claude-sonnet-5-5')).toBeUndefined();
    expect(windows.look('claude-sonnet-5-5', made, never)).toBeUndefined();
    expect(await windows.look('claude-haiku-4-5', made, never)).toEqual({ window: 200_000 });
    expect(windows.get('claude-haiku-4-5')).toEqual({ window: 200_000 });
    expect(calls.map((c) => c.url)).toEqual(['https://api.anthropic.com/v1/models/claude-sonnet-5-5', 'https://api.anthropic.com/v1/models/claude-haiku-4-5']);
    expect(windows.get(undefined)).toBeUndefined();
    expect(windows.settled(undefined)).toBeUndefined();
  });

  it('never asks again for a model the API does not list', async () => {
    const windows = new ModelWindows();
    const { made, calls } = io(() => ({ status: 404, text: NOT_LISTED }));
    expect(await windows.look('claude-no-such-model-9', made, never)).toEqual({ unknown: 'the Models API does not list this model (404 not_found_error)', final: true });
    expect(windows.get('claude-no-such-model-9')).toEqual({ unknown: 'the Models API does not list this model (404 not_found_error)' });
    for (let step = 0; step < 200; step++) expect(windows.look('claude-no-such-model-9', made, never)).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('asks again after a failed lookup, waiting 1, 2, 4 … steps up to 64, keeps the failure known meanwhile, and stops once the window is known', async () => {
    const windows = new ModelWindows();
    let up = false;
    const { made } = io(() => (up ? { status: 200, text: listed('claude-sonnet-5-5', 1_000_000) } : { status: 529, text: '' }));
    const asked: number[] = [];
    for (let step = 1; step <= 400; step++) {
      const running = windows.look('claude-sonnet-5-5', made, never);
      if (running === undefined) continue;
      asked.push(step);
      expect(windows.get('claude-sonnet-5-5')).toEqual(step === 1 ? undefined : { unknown: 'the Models API answered 529' });
      await running;
    }
    // each lookup, then its wait: 1+1, +1+2, +1+4, +1+8, +1+16, +1+32, +1+64, +1+64 …
    expect(asked).toEqual([1, 3, 6, 11, 20, 37, 70, 135, 200, 265, 330, 395]);
    up = true;
    for (let step = 0; step < 64; step++) await windows.look('claude-sonnet-5-5', made, never);
    expect(windows.get('claude-sonnet-5-5')).toEqual({ window: 1_000_000 });
  });

  it(`counts a lookup with no answer within ${MODEL_WINDOW_TIMEOUT_MS} ms as failed`, async () => {
    const windows = new ModelWindows();
    const waits: number[] = [];
    const fires = (ms: number, fn: () => void) => (waits.push(ms), queueMicrotask(fn), { cancel: () => {} });
    const { made } = io(() => new Promise(() => {}));
    expect(await windows.look('claude-sonnet-5-5', made, fires)).toEqual({ unknown: 'the Models API lookup failed: no answer within 5000 ms', final: false });
    expect(waits).toEqual([5_000]);
    expect(windows.get('claude-sonnet-5-5')).toEqual({ unknown: 'the Models API lookup failed: no answer within 5000 ms' });
  });
});

// The adapter: a sub-agent's steps, asks and rows with FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT unset, the Models API scripted by the fake.

const A1 = 'a1b2c3d4e5';
const PARTY = `agent:${A1}`;
const LABEL = 'general-purpose a1b2c3';
type Fake = ReturnType<typeof fakeEngine>;
const fakes: Fake[] = [];
afterEach(() => {
  for (const f of fakes.splice(0)) {
    expect(f.unscripted, 'every $ call the plugin made was scripted').toEqual([]);
    f.cleanup();
  }
});

/** A session whose main chat reports a 200k window and Claude Code asks at 63k, no sub-agent max context set, one sub-agent spawned. */
async function begin(script: Script = {}): Promise<Fake> {
  const f = fakeEngine({ window: 200_000, ...script, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '100000', ...script.env } });
  fakes.push(f);
  await f.dispatch('session.start', { reason: 'startup' }, async () => ({}));
  await f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn', prompt: 'Brief for agent one', description: 'one', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A1 }));
  return f;
}
/** One step; `during` runs while its model request is out, before its answer. */
const step = (f: Fake, tokens: number, model: string, agentId?: string, during: () => Promise<void> = async () => {}, signal?: AbortSignal) =>
  f.dispatch('turn.step', { turnId: 't1', index: 0, model, messageCount: 4, ...(agentId ? { agentId } : {}) }, async () => (await during(), { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'tool_use', ...usage(tokens) }), signal);
const ask = (f: Fake) => f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: [{ role: 'user', text: 'Brief for agent one', toolUses: [], handle: 'h0' }, { role: 'assistant', text: 'working', toolUses: [], handle: 'h1' }] }, async () => ({ skip: 'native ran' }));
/** The decision rows written this session, read once session.end has flushed them. */
async function rows(f: Fake): Promise<Record<string, unknown>[]> {
  await f.dispatch('session.end', { reason: 'other' }, async () => ({}));
  const dir = join(f.home, '.local/state/forward-compaction/logs/decisions');
  return readdirSync(dir).filter((n) => n.endsWith('.jsonl')).flatMap((n) => readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
}
const windowRows = (all: Record<string, unknown>[]) => all.filter((r) => r.event === 'window').map(({ ts: _, ...row }) => row);
const compactRows = (all: Record<string, unknown>[]) => all.filter((r) => r.event === 'compact').map((r) => [r.decision, r.tokens, r.ceiling]);
const request = (model: string) => ({ url: `https://api.anthropic.com/v1/models/${model}`, init: { headers: { 'anthropic-version': '2023-06-01' }, auth: 'handle-1' } });

describe("a sub-agent measured against its own model's window, no max context set (adapter)", () => {
  it.each([
    ['claude-fable-5-2', 'claude-sonnet-5-5'],
    ['claude-opus-5-5', 'claude-fable-5-2'],
    ['claude-sonnet-5-5', 'claude-fable-5-2'],
    ['claude-haiku-5-5', 'claude-opus-5-5'],
  ])("holds a %s sub-agent's ask at 700k and gives it the mechanical wake at its 800k ceiling, under a %s main chat reporting 200k", async (model, mainModel) => {
    const f = await begin();
    await step(f, 20_000, mainModel);
    let asked = -1;
    await step(f, 700_000, model, A1, async () => {
      for (let turn = 0; turn < 50 && f.fetches.length === 0; turn++) await new Promise((resolve) => setImmediate(resolve));
      asked = f.fetches.length;
    });
    expect(asked, 'requests made while the step that names the model is still out: the lookup runs beside it, never after it').toBe(1);
    expect(await ask(f)).toHaveProperty('skip');
    await step(f, 800_000, model, A1);
    expect((await ask(f)).messages[1].text).toMatch(/^\[forward-compaction: no frontier written by the model\] Your context reached 800k tokens, past the 800k ceiling/);
    const all = await rows(f);
    expect(windowRows(all)).toEqual([{ event: 'window', party: PARTY, label: LABEL, model, maxContext: 1_000_000, source: 'models-api', ceiling: 800_000 }]);
    expect(compactRows(all)).toEqual([['skip', 700_000, 800_000], ['mechanical', 800_000, 800_000]]);
    expect(f.fetches).toEqual([request(model)]);
  });

  it("measures a 200k model against 200k under a 1M main chat, and a sub-agent on main's own model id against main's reported window with no lookup", async () => {
    const f = await begin({ window: 1_000_000 });
    await step(f, 20_000, 'claude-fable-5-2');
    await step(f, 160_000, 'claude-haiku-4-5-20251001', A1);
    expect((await ask(f)).messages[1].text).toMatch(/Your context reached 160k tokens, past the 160k ceiling/);
    await step(f, 30_000, 'claude-fable-5-2', A1); // the same party, now on main's model
    const all = await rows(f);
    expect(windowRows(all)).toEqual([
      { event: 'window', party: PARTY, label: LABEL, model: 'claude-haiku-4-5-20251001', maxContext: 200_000, source: 'models-api', ceiling: 160_000 },
      { event: 'window', party: PARTY, label: LABEL, model: 'claude-fable-5-2', maxContext: 1_000_000, source: 'main', ceiling: 800_000 },
    ]);
    expect(f.fetches).toEqual([request('claude-haiku-4-5-20251001')]);
  });

  it('measures a sub-agent on a model the Models API does not list against the 200k fallback, says so in its window row and in warnings.jsonl, and never asks again', async () => {
    const f = await begin({ window: 1_000_000 });
    const why = 'the Models API does not list this model (404 not_found_error)';
    await step(f, 20_000, 'claude-fable-5-2');
    for (const tokens of [40_000, 80_000, 120_000, 160_000]) await step(f, tokens, 'claude-no-such-model-9', A1);
    expect((await ask(f)).messages[1].text).toMatch(/Your context reached 160k tokens, past the 160k ceiling/);
    const all = await rows(f);
    expect(windowRows(all)).toEqual([{ event: 'window', party: PARTY, label: LABEL, model: 'claude-no-such-model-9', maxContext: 200_000, source: 'fallback', unknown: why, ceiling: 160_000 }]);
    expect(f.fetches).toEqual([request('claude-no-such-model-9')]);
    const path = join(f.home, '.local/state/forward-compaction/logs/warnings.jsonl');
    for (let i = 0; i < 50 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    const warned = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.event === 'window-unknown');
    expect(warned.map((r) => [r.level, r.msg, r.detail])).toEqual([['warning', why, { party: PARTY, label: LABEL, model: 'claude-no-such-model-9', maxContext: 200_000, source: 'fallback', ceiling: 160_000, unknown: why }]]);
  });

  it('takes the fallback while the Models API fails, asks again a step later, and measures against the real window once it answers', async () => {
    const models: NonNullable<Script['models']> = { 'claude-sonnet-5-5': { status: 529, text: '' } };
    const f = await begin({ models });
    await step(f, 30_000, 'claude-sonnet-5-5', A1); // asks, fails
    models['claude-sonnet-5-5'] = 1_000_000;
    await step(f, 40_000, 'claude-sonnet-5-5', A1); // the wait after the first failure: one step
    expect(f.fetches).toEqual([request('claude-sonnet-5-5')]);
    await step(f, 50_000, 'claude-sonnet-5-5', A1); // asks again
    await step(f, 60_000, 'claude-sonnet-5-5', A1);
    expect(windowRows(await rows(f))).toEqual([
      { event: 'window', party: PARTY, label: LABEL, model: 'claude-sonnet-5-5', maxContext: 200_000, source: 'fallback', unknown: 'the Models API answered 529', ceiling: 160_000 },
      { event: 'window', party: PARTY, label: LABEL, model: 'claude-sonnet-5-5', maxContext: 1_000_000, source: 'models-api', ceiling: 800_000 },
    ]);
    expect(f.fetches).toEqual([request('claude-sonnet-5-5'), request('claude-sonnet-5-5')]);
  });

  it("stops waiting for the lookup at the step's abort, measures against the fallback meanwhile, and reads the answer at a later step", async () => {
    let answer: (reply: { status: number; text: string }) => void = () => {};
    const f = await begin({ models: { 'claude-sonnet-5-5': new Promise((resolve) => (answer = resolve)) } });
    const interrupted = new AbortController();
    interrupted.abort();
    await step(f, 30_000, 'claude-sonnet-5-5', A1, async () => {}, interrupted.signal);
    answer({ status: 200, text: listed('claude-sonnet-5-5', 1_000_000) });
    await step(f, 40_000, 'claude-sonnet-5-5', A1);
    expect(windowRows(await rows(f))).toEqual([
      { event: 'window', party: PARTY, label: LABEL, model: 'claude-sonnet-5-5', maxContext: 200_000, source: 'fallback', unknown: 'its model was not looked up yet', ceiling: 160_000 },
      { event: 'window', party: PARTY, label: LABEL, model: 'claude-sonnet-5-5', maxContext: 1_000_000, source: 'models-api', ceiling: 800_000 },
    ]);
    expect(f.fetches).toEqual([request('claude-sonnet-5-5')]);
  });

  it.each<[string, Script, string]>([
    ['a session with no first-party credential', { credential: null }, 'the session holds no Anthropic credential the Models API takes'],
    ['a refused request', { models: { 'claude-sonnet-5-5': new Error('nonessential traffic is disabled') } }, 'the Models API lookup failed: nonessential traffic is disabled'],
  ])('takes the fallback in %s and names why', async (_name, script, why) => {
    const f = await begin(script);
    await step(f, 30_000, 'claude-sonnet-5-5', A1);
    expect(windowRows(await rows(f))).toEqual([{ event: 'window', party: PARTY, label: LABEL, model: 'claude-sonnet-5-5', maxContext: 200_000, source: 'fallback', unknown: why, ceiling: 160_000 }]);
    expect(f.fetches).toEqual(script.credential === null ? [] : [request('claude-sonnet-5-5')]);
  });

  it('makes no lookup while FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT is set: that is every sub-agent\'s max context', async () => {
    const f = await begin({ env: { FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT: '400k' } });
    await step(f, 320_000, 'claude-sonnet-5-5', A1);
    expect((await ask(f)).messages[1].text).toMatch(/Your context reached 320k tokens, past the 320k ceiling/);
    expect(windowRows(await rows(f))).toEqual([{ event: 'window', party: PARTY, label: LABEL, model: 'claude-sonnet-5-5', maxContext: 400_000, source: 'option', ceiling: 320_000 }]);
    expect(f.fetches).toEqual([]);
  });
});
