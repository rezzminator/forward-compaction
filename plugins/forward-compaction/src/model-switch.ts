// Main's model switch: the model a `forward_compaction` call names in `model`, given to each of main's requests by the
// adapter's `turn.step` hook in place of the one Claude Code names. Claude Code's own model and the user's saved default
// never change, so a switch holds only while Claude Code keeps naming the model it named when the switch was asked or
// began (`from`). A name is set only once Claude Code answered one trial request naming it (`SWITCH_TRIAL`); one that
// passes it and still answers as `from` (an alias of `from`) ends the switch. A switch never costs a prompt cache: it
// begins only at main's first request after a compaction of main the plugin knew of before that request left, and a
// fork of main spawned while it is active follows it, as the fork shares main's cached prefix. Pure: the adapter holds
// and writes what each function returns, writes its rows as debug rows and says its line.

import type { Bounded } from './bounded';

/** Main's switch as the plugin holds it and keeps it in `model-switch.json` (disk.ts). `pending`: asked, not begun, waiting for main's next compaction; `armed` once one was known before main's next request, which begins it. `active`: begun, each main request given `model` while Claude Code names `from`; `took` once one was answered by a model other than `from`. `forks`: each fork that follows a switch, by agent id, kept while the conversation lives (a finished fork can be resumed), past the switch's end too. */
export type ModelSwitch = { pending?: { model: string; from?: string; armed?: true }; active?: { model: string; from: string; took?: true }; forks?: Record<string, SwitchFollow> };

type Row = Record<string, unknown>;

/** What a function decided: the switch after it (`changed` when it moved), its debug rows, and the one screen line a switch's begin or end gets, with its row. */
export type SwitchOutcome = { modelSwitch?: ModelSwitch; changed: boolean; rows: Row[]; line?: { text: string; level: 'info' | 'warning'; row: Row } };

const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/** No part left is no switch: forks holding no follow are none. */
const tidy = (s: ModelSwitch): ModelSwitch | undefined => {
  const { forks, ...parts } = s, kept: ModelSwitch = forks !== undefined && Object.keys(forks).length > 0 ? { ...parts, forks } : parts;
  return kept.pending === undefined && kept.active === undefined && kept.forks === undefined ? undefined : kept;
};
/** A switch rebuilt from some of its parts: `held`'s forks carried unchanged. */
const keeping = (held: ModelSwitch | undefined, parts: Omit<ModelSwitch, 'forks'>): ModelSwitch | undefined => tidy({ ...parts, ...(held?.forks !== undefined ? { forks: held.forks } : {}) });
const row = (phase: string, detail: Row): Row => ({ event: 'model-switch', party: 'main', phase, ...detail });
const ended = (asked: string, from: string | undefined, given: string, reason: string): Row => row('ended', { reason, asked, from: from ?? null, given });

/** A model id as the API reports it: the `[1m]` context marker Claude Code's own id may carry and a `-YYYYMMDD` snapshot date dropped. shortcut: two id shapes, never an alias (`opus`); upgrade if an answering id differs from its request's in another way. */
const sameModel = (a: string, b: string): boolean => {
  const base = (id: string): string => id.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  return base(a) === base(b);
};

/** Main's trial request before a switch is set, sent by the adapter through `$.model.complete`: a one-word reply under a 4-token cap, so a trial costs about 20 tokens. */
export const SWITCH_TRIAL = {
  prompt: 'Reply with the single word OK.',
  maxTokens: 4,
  /** Live, a served name answered in under a second and an unknown one in 0.2 s; past 30 s main's call goes on unswitched rather than hold its tool call longer. */
  timeoutMs: 30_000,
} as const;

/** How long a request (main's, or a sub-agent's, whose follow main's switch holds) waits for the restore of what main kept (its switch among it) when the plugin was (re)started: a restore reads a few small files and `$.state` keys, so past 2 s it is stuck, and the request goes out as Claude Code named it. The adapter waits so at most once: after a request ran past the bound, later ones go out as named without waiting. */
export const SWITCH_RESTORE_WAIT_MS = 2_000;

/** Main's trial request as the adapter got it back, with its milliseconds: `$.model.complete`'s result (read here by the fields that say why it was not answered), or the message it rejected with. */
export type SwitchTrial = { ms: number } & ({ result: { isAnswered: boolean; reason?: string; status?: number | null; error?: string } } | { rejected: string });

/** A `forward_compaction` call's `model` as `switchAsk` reads it. */
export type SwitchCall = { party: 'main' | 'subagent'; asked: unknown; compacts: boolean; given?: string; tried?: SwitchTrial };

/** A trial's rejection as said: a format cap, so the call's reply and the screen line stay one short line. */
const TRIAL_WHY_MAX_CHARS = 160;

/** Why a trial request was not answered, in Claude Code's words (a rejection's message from its `$.model.complete:` on, on one line); undefined when it was. */
const unanswered = (t: SwitchTrial): string | undefined => {
  if ('rejected' in t) return t.rejected.replace(/^.*\$\.model\.complete: /s, '').replace(/\s+/g, ' ').trim().slice(0, TRIAL_WHY_MAX_CHARS) || 'no message given';
  const r = t.result;
  if (r.isAnswered) return undefined;
  if (r.reason === 'aborted') return `no answer within ${SWITCH_TRIAL.timeoutMs / 1000} s`;
  return r.reason === 'api-error' ? `${r.error ?? 'api-error'}${typeof r.status === 'number' ? `, status ${r.status}` : ''}` : r.reason ?? 'no reason given';
};

/**
 * A call's `model` (`asked`, as sent): the result's one line and the switch after it. `given`: the model Claude Code
 * named main's last request, unknown before main's first in this process; `compacts`: the call leads to a compaction
 * (a fork's always does). Either way the switch waits for main's next compaction: a request before it would miss the
 * cache its context holds on the model main is on. A sub-agent's, or one that is no name, changes nothing; one
 * naming the model main is on drops any switch still pending. A name main's requests would newly carry is decided only
 * with its trial's outcome (`tried`): without one it comes back as `trial`, nothing changed; a trial not answered
 * changes nothing and says why. Claude Code's own model, asked back during a switch, needs no trial.
 */
export function switchAsk(held: ModelSwitch | undefined, call: SwitchCall & { tried: SwitchTrial }): SwitchOutcome & { result: string };
export function switchAsk(held: ModelSwitch | undefined, call: SwitchCall): (SwitchOutcome & { result: string }) | { trial: string };
export function switchAsk(held: ModelSwitch | undefined, call: SwitchCall): (SwitchOutcome & { result: string }) | { trial: string } {
  const same = { modelSwitch: held, changed: false };
  if (call.party === 'subagent') return { ...same, rows: [row('ignored', { why: 'subagent', asked: typeof call.asked === 'string' ? call.asked : kind(call.asked) })], result: "model is the main chat's alone: ignored." };
  if (typeof call.asked !== 'string' || call.asked.trim() === '') return { ...same, rows: [row('ignored', { why: 'no-name', sent: kind(call.asked) })], result: `model must be a model name; got ${typeof call.asked === 'string' ? 'a blank text' : kind(call.asked)}: ignored.` };
  const asked = call.asked.trim(), on = held?.active?.model ?? call.given;
  if (asked === on) {
    const modelSwitch = keeping(held, held?.active === undefined ? {} : { active: held.active });
    return { modelSwitch, changed: held?.pending !== undefined, rows: [row('already-on', { asked, dropped: held?.pending?.model ?? null })], result: `model ${asked}: you are already on it; nothing changes.` };
  }
  if (call.tried === undefined && asked !== call.given) return { trial: asked };
  const why = call.tried === undefined ? undefined : unanswered(call.tried);
  if (why !== undefined) {
    const tried = row('tried', { asked, outcome: 'rejected' in call.tried! ? 'rejected' : call.tried!.result.reason ?? null, why, ms: call.tried!.ms });
    return { ...same, rows: [], result: `model ${asked}: not taken (${why}); you stay on ${on ?? 'your model'}.`, line: { text: `main stays on ${on ?? 'its model'}: a trial request naming ${asked} was not answered (${why}).`, level: 'warning', row: tried } };
  }
  const pending = { model: asked, ...(call.given !== undefined ? { from: call.given } : {}) };
  const result = call.compacts ? `model ${asked}: you continue on it from the first request after this compaction.` : `model ${asked}: taken; you continue on it from the first request after your next compaction, and stay on ${on ?? 'your model'} until then.`;
  return { modelSwitch: { ...held, pending }, changed: true, rows: [...(call.tried !== undefined ? [row('tried', { asked, outcome: 'answered', ms: call.tried.ms })] : []), row('pending', { asked, from: call.given ?? null })], result };
}

/**
 * Main compacted. Known `before` its next request leaves (the plugin's wake, or Claude Code's own summary once it
 * stands), a waiting switch is armed and begins at that request. Seen `late`, by the fall of the request after it
 * (`unseen-compaction`), it starts nothing: that request already went out on the model main is on and cached the new
 * context there, and a rewind falls the same with its old cache alive. The switch waits for a later compaction.
 */
export function switchCompacted(held: ModelSwitch | undefined, seen: 'before' | 'late'): SwitchOutcome {
  const pending = held?.pending, same = { modelSwitch: held, changed: false };
  if (pending === undefined) return { ...same, rows: [] };
  if (seen === 'late') return { ...same, rows: [row('passed', { asked: pending.model, why: 'seen-late' })] };
  if (pending.armed) return { ...same, rows: [] };
  return { modelSwitch: { ...held, pending: { ...pending, armed: true } }, changed: true, rows: [row('armed', { asked: pending.model })] };
}

/** A compaction as `session.compact` hands it back, Claude Code's own summary (`next(e)`'s answer) or the plugin's wake: only one that stands (its `messages`), its hook not aborted, replaced main's context, as an aborted dispatch went on without the hook's result; a skip or an abort compacted nothing, said in a row when a switch waits. */
export function switchPassed(held: ModelSwitch | undefined, result: { messages?: unknown }, aborted: boolean): SwitchOutcome {
  if (result.messages !== undefined && !aborted) return switchCompacted(held, 'before');
  const pending = held?.pending;
  return { modelSwitch: held, changed: false, rows: pending === undefined ? [] : [row('passed', { asked: pending.model, why: aborted ? 'aborted' : 'skipped' })] };
}

/** A party's request (`party`: `main` or `agent:{id}`) after waiting for the restore of what main kept (`waited`, bounded by SWITCH_RESTORE_WAIT_MS): undefined once the restore settled, so the held switch applies, after a failed restore too, which still loaded main's files, so this request and every later one are given the same model; else the restore is still running and the request goes out as Claude Code named it (`given`), with one warning unless its hook was aborted. */
export function switchUnrestored(party: string, given: string, waited: Bounded<unknown>): { line?: { text: string; level: 'warning'; row: Row } } | undefined {
  if (!waited.timedOut) return undefined;
  if (waited.aborted) return {};
  const whose = party === 'main' ? "main's request" : `agent ${party.replace(/^agent:/, '')}'s request`;
  return { line: { text: `${whose} goes out on ${given}, unswitched: restoring what main kept did not finish within ${SWITCH_RESTORE_WAIT_MS / 1000} s.`, level: 'warning', row: { ...row('unrestored', { given, why: 'timed-out', waitMs: SWITCH_RESTORE_WAIT_MS }), party } } };
}

/** Undefined, or `pending` no longer armed. */
const disarmed = (pending: ModelSwitch['pending']): ModelSwitch['pending'] => (pending === undefined ? undefined : { model: pending.model, ...(pending.from !== undefined ? { from: pending.from } : {}) });

/**
 * Each party (`main` or `agent:{id}`) whose request went out as Claude Code named it past the restore's bound
 * (`switchUnrestored`), once the restore landed: that request wrote the party's context to that model's cache, so the
 * party stays on it. Main's arm is spent (that request was the first after the compaction); main's active switch waits
 * again for main's next compaction, said once (a newer ask still waiting takes its place); a fork's follow ends for good.
 * Any other party changes nothing.
 */
export function switchMissed(held: ModelSwitch | undefined, parties: readonly string[]): SwitchOutcome {
  const rows: Row[] = [], out: ModelSwitch = { ...held, ...(held?.forks !== undefined ? { forks: { ...held.forks } } : {}) };
  let line: SwitchOutcome['line'];
  for (const party of parties) {
    const id = party.replace(/^agent:/, '');
    if (party !== 'main') {
      if (out.forks?.[id] === undefined) continue;
      rows.push({ event: 'model-switch', party, phase: 'unfollow', asked: out.forks[id].model, from: out.forks[id].from, why: 'unrestored' }), delete out.forks[id];
      continue;
    }
    const { pending, active } = out;
    if (pending?.armed === true) (out.pending = disarmed(pending)), rows.push(row('passed', { asked: pending.model, why: 'unrestored' }));
    if (active === undefined) continue;
    delete out.active, (out.pending ??= { model: active.model, from: active.from });
    const suspended = row('suspended', { asked: out.pending.model, from: active.from, why: 'unrestored' });
    line = { text: `the switch to ${out.pending.model} waits for main's next compaction: a request went out on ${active.from} while restoring what main kept ran past ${SWITCH_RESTORE_WAIT_MS / 1000} s.`, level: 'warning', row: suspended };
  }
  const changed = rows.length > 0 || line !== undefined;
  return { modelSwitch: changed ? tidy(out) : held, changed, rows, ...(line !== undefined ? { line } : {}) };
}

/** A fork that follows main's switch: each of its requests Claude Code names `from` is given `model`. */
export type SwitchFollow = { model: string; from: string };

/**
 * An agent about to start (`agent.spawn`): the switch it follows for its whole life, if any. Only a fork shares its
 * parent's cached context: one of main's spawned while main's switch is active follows it; one of a fork that follows
 * (its `parentAgentId` in `held.forks`) follows the same. A fork spawned while the switch only waits, or with none, had
 * its context cached on the model main is on and follows nothing, also once main switches later; so does any agent that
 * is no fork. A resumed one starts no follow: one it had is still in `held.forks`.
 */
export function switchFollow(held: ModelSwitch | undefined, spawn: { fork: boolean; parentAgentId?: string; resume?: unknown }): SwitchFollow | undefined {
  if (!spawn.fork || spawn.resume !== undefined) return undefined;
  if (spawn.parentAgentId !== undefined) return held?.forks?.[spawn.parentAgentId];
  return held?.active === undefined ? undefined : { model: held.active.model, from: held.active.from };
}

/** A spawned fork (`agentId`) follows `follow` (`switchFollow`): kept in the switch's `forks`, with its row. */
export function switchFollowed(held: ModelSwitch | undefined, agentId: string, follow: SwitchFollow, parentAgentId: string | undefined): SwitchOutcome {
  return { modelSwitch: { ...held, forks: { ...held?.forks, [agentId]: follow } }, changed: true, rows: [{ event: 'model-switch', party: `agent:${agentId}`, phase: 'follow', asked: follow.model, from: follow.from, parent: parentAgentId ?? 'main' }] };
}

/** A sub-agent's request named `given`: the model it is given, the followed switch's while `given` is its `from`. */
export const switchForkModel = (follow: SwitchFollow | undefined, given: string): string => (follow !== undefined && given === follow.from ? follow.model : given);

/**
 * A request, about to go out with the model Claude Code named (`given`): the model it is given (`model`). A sub-agent's
 * (`agentId`) gets its follow's (`switchForkModel`), nothing moved. Main's: a part whose `from` is not `given` ends for
 * good (/model, a relaunch, or Claude Code's own fallback); a pending one armed by a compaction begins, recording `given`
 * as its `from`, or, naming `given` itself, ends the active one (asked back).
 */
export function switchStep(held: ModelSwitch | undefined, given: string, agentId?: string): SwitchOutcome & { model: string } {
  if (agentId !== undefined) return { modelSwitch: held, changed: false, rows: [], model: switchForkModel(held?.forks?.[agentId], given) };
  const rows: Row[] = [], out: ModelSwitch = held?.forks !== undefined ? { forks: held.forks } : {};
  let line: SwitchOutcome['line'];
  const { pending, active } = held ?? {};
  const moved = (part: { model: string; from?: string } | undefined): boolean => {
    if (part === undefined || part.from === undefined || part.from === given) return false;
    const end = ended(part.model, part.from, given, 'model-changed');
    if (line === undefined) line = { text: `the switch to ${part.model} ended: Claude Code now gives main ${given}.`, level: 'info', row: end };
    else rows.push(end);
    return true;
  };
  if (!moved(active) && active !== undefined) out.active = active;
  if (pending !== undefined && !moved(pending)) {
    if (!pending.armed) out.pending = pending;
    else if (pending.model !== given) (out.active = { model: pending.model, from: given }), rows.push(row('begin', { asked: pending.model, from: given }));
    else if (out.active === undefined) rows.push(row('already-on', { asked: pending.model, given }));
    else (line = { text: `main is back on ${given}: the switch to ${out.active.model} ended.`, level: 'info', row: ended(out.active.model, out.active.from, given, 'asked-back') }), delete out.active;
  }
  const modelSwitch = tidy(out), changed = rows.length > 0 || line !== undefined; // every row here is a part begun or ended
  return { modelSwitch, changed, rows, ...(line !== undefined ? { line } : {}), model: modelSwitch?.active?.model ?? given };
}

/**
 * Main's rewritten request answered: its row, with the model Claude Code named (`given`), the one it was given and the
 * one that answered (`answered`, the response's `usage.model`; undefined with no usage). The first answer settles the
 * switch: by a model other than `from` it took; by `from` itself the name was not taken (or names `from` by an alias)
 * and the switch ends.
 */
export function switchAnswered(held: ModelSwitch | undefined, given: string, answered: string | undefined): SwitchOutcome {
  const active = held?.active;
  if (active === undefined) return { modelSwitch: held, changed: false, rows: [] };
  const step = row('step', { given, sent: active.model, answered: answered ?? null });
  if (active.took || answered === undefined) return { modelSwitch: held, changed: false, rows: [step] };
  if (sameModel(answered, active.from)) {
    return { modelSwitch: keeping(held, held?.pending === undefined ? {} : { pending: held.pending }), changed: true, rows: [step], line: { text: `main stays on ${answered}: its request named ${active.model} and was answered by ${answered}; the switch ended.`, level: 'warning', row: ended(active.model, active.from, given, 'not-taken') } };
  }
  return { modelSwitch: { ...held, active: { ...active, took: true } }, changed: true, rows: [step], line: { text: `main continues on ${answered} (asked ${active.model}); Claude Code's header and /model still show ${active.from}.`, level: 'info', row: row('took', { asked: active.model, from: active.from, answered }) } };
}

/** `model-switch.json` as read: the switch it holds (none for `{}`), or undefined when it holds no switch (a bad `pending`, `active` or `forks` entry). An arm is kept: main's next request, in this process or after a restart, is still the first after that compaction, as any request since would have begun the switch. An earlier file's `at` (`request`, `compaction`) says no such thing and reads as waiting for a compaction. */
export function switchRead(value: unknown): { modelSwitch?: ModelSwitch } | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const name = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (!isObject(value)) return undefined;
  const { pending, active, forks } = value, out: ModelSwitch = {};
  if (pending !== undefined) {
    if (!isObject(pending) || !name(pending.model) || (pending.at !== undefined && pending.at !== 'request' && pending.at !== 'compaction') || (pending.armed !== undefined && pending.armed !== true) || (pending.from !== undefined && !name(pending.from))) return undefined;
    out.pending = { model: pending.model, ...(pending.from !== undefined ? { from: pending.from as string } : {}), ...(pending.armed === true ? { armed: true as const } : {}) };
  }
  if (active !== undefined) {
    if (!isObject(active) || !name(active.model) || !name(active.from) || (active.took !== undefined && active.took !== true)) return undefined;
    out.active = { model: active.model, from: active.from, ...(active.took === true ? { took: true as const } : {}) };
  }
  if (forks !== undefined) {
    if (!isObject(forks) || !Object.values(forks).every((f) => isObject(f) && name(f.model) && name(f.from))) return undefined;
    out.forks = Object.fromEntries(Object.entries(forks).map(([id, f]) => [id, { model: (f as SwitchFollow).model, from: (f as SwitchFollow).from }]));
  }
  const modelSwitch = tidy(out);
  return modelSwitch === undefined ? {} : { modelSwitch };
}
