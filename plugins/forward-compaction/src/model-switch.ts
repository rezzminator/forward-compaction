// Main's model switch: the model a `forward_compaction` call names in `model`, given to each of main's requests by the
// adapter's `turn.step` hook in place of the one Claude Code names. Claude Code's own model and the user's saved default
// never change, so a switch holds only while Claude Code keeps naming the model it named when the switch was asked or
// began (`from`). A name is set only once Claude Code answered one trial request naming it (`SWITCH_TRIAL`); one that
// passes it and still answers as `from` (an alias of `from`) ends the switch. Pure: the adapter holds and writes what
// each function returns, writes its rows as debug rows and says its line.

/** Main's switch as the plugin holds it and keeps it in `model-switch.json` (disk.ts). `pending`: asked, not begun, from main's next request (`at` `request`) or from the first after main's next compaction (`at` `compaction`). `active`: begun, each main request given `model` while Claude Code names `from`; `took` once one was answered by a model other than `from`. */
export type ModelSwitch = { pending?: { model: string; at: 'request' | 'compaction'; from?: string }; active?: { model: string; from: string; took?: true } };

type Row = Record<string, unknown>;

/** What a function decided: the switch after it (`changed` when it moved), its debug rows, and the one screen line a switch's begin or end gets, with its row. */
export type SwitchOutcome = { modelSwitch?: ModelSwitch; changed: boolean; rows: Row[]; line?: { text: string; level: 'info' | 'warning'; row: Row } };

const kind = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
/** No part left is no switch. */
const tidy = (s: ModelSwitch): ModelSwitch | undefined => (s.pending === undefined && s.active === undefined ? undefined : s);
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
 * (a fork's always does), so the switch begins after it. A sub-agent's, or one that is no name, changes nothing; one
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
    const modelSwitch = held?.active === undefined ? undefined : { active: held.active };
    return { modelSwitch, changed: held?.pending !== undefined, rows: [row('already-on', { asked, dropped: held?.pending?.model ?? null })], result: `model ${asked}: you are already on it; nothing changes.` };
  }
  if (call.tried === undefined && asked !== call.given) return { trial: asked };
  const why = call.tried === undefined ? undefined : unanswered(call.tried);
  if (why !== undefined) {
    const tried = row('tried', { asked, outcome: 'rejected' in call.tried! ? 'rejected' : call.tried!.result.reason ?? null, why, ms: call.tried!.ms });
    return { ...same, rows: [], result: `model ${asked}: not taken (${why}); you stay on ${on ?? 'your model'}.`, line: { text: `main stays on ${on ?? 'its model'}: a trial request naming ${asked} was not answered (${why}).`, level: 'warning', row: tried } };
  }
  const at = call.compacts ? 'compaction' : 'request';
  const pending = { model: asked, at, ...(call.given !== undefined ? { from: call.given } : {}) } as const;
  return { modelSwitch: { ...held, pending }, changed: true, rows: [...(call.tried !== undefined ? [row('tried', { asked, outcome: 'answered', ms: call.tried.ms })] : []), row('pending', { asked, at, from: call.given ?? null })], result: `model ${asked}: you continue on it from ${at === 'request' ? 'your next request' : 'the first request after this compaction'}.` };
}

/** Main compacted, by any door: a switch waiting for the compaction begins from main's next request. */
export function switchCompacted(held: ModelSwitch | undefined): SwitchOutcome {
  if (held?.pending?.at !== 'compaction') return { modelSwitch: held, changed: false, rows: [] };
  return { modelSwitch: { ...held, pending: { ...held.pending, at: 'request' } }, changed: true, rows: [row('armed', { asked: held.pending.model })] };
}

/**
 * Main's request, about to go out with the model Claude Code named (`given`): the model it is given (`model`). A part
 * whose `from` is not `given` ends for good (/model, a relaunch, or Claude Code's own fallback); a pending one due
 * now begins, recording `given` as its `from`, or, naming `given` itself, ends the active one (asked back).
 */
export function switchStep(held: ModelSwitch | undefined, given: string): SwitchOutcome & { model: string } {
  const rows: Row[] = [], out: ModelSwitch = {};
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
    if (pending.at === 'compaction') out.pending = pending;
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
    return { modelSwitch: held?.pending === undefined ? undefined : { pending: held.pending }, changed: true, rows: [step], line: { text: `main stays on ${answered}: its request named ${active.model} and was answered by ${answered}; the switch ended.`, level: 'warning', row: ended(active.model, active.from, given, 'not-taken') } };
  }
  return { modelSwitch: { ...held, active: { ...active, took: true } }, changed: true, rows: [step], line: { text: `main continues on ${answered} (asked ${active.model}); Claude Code's header and /model still show ${active.from}.`, level: 'info', row: row('took', { asked: active.model, from: active.from, answered }) } };
}

/** `model-switch.json` as read: the switch it holds (none for `{}`), or undefined when it holds no switch. */
export function switchRead(value: unknown): { modelSwitch?: ModelSwitch } | undefined {
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const name = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
  if (!isObject(value)) return undefined;
  const { pending, active } = value, out: ModelSwitch = {};
  if (pending !== undefined) {
    if (!isObject(pending) || !name(pending.model) || (pending.at !== 'request' && pending.at !== 'compaction') || (pending.from !== undefined && !name(pending.from))) return undefined;
    out.pending = { model: pending.model, at: pending.at, ...(pending.from !== undefined ? { from: pending.from as string } : {}) };
  }
  if (active !== undefined) {
    if (!isObject(active) || !name(active.model) || !name(active.from) || (active.took !== undefined && active.took !== true)) return undefined;
    out.active = { model: active.model, from: active.from, ...(active.took === true ? { took: true as const } : {}) };
  }
  const modelSwitch = tidy(out);
  return modelSwitch === undefined ? {} : { modelSwitch };
}
