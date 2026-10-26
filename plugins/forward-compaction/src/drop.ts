// Dropping a skill or command from the wake: the model names it in drop_skills on two handoffs in a row, and the second
// one's wake leaves it out. A file whose frontmatter sets FRONTMATTER_KEEP, or a name FORWARD_COMPACTION_KEEP_SKILLS lists, is never dropped.

import type { Ledger, PartyKey, SkillEntry } from './ledger.ts';

/** The frontmatter key that pins a skill or command in every wake: `forward-compaction-keep: true`. */
export const FRONTMATTER_KEEP = 'forward-compaction-keep';
/** Names per call: more than a party loads in a long session, few enough that each is chosen. */
export const DROP_MAX = 32;

/** Whether a skill's frontmatter pins it: the key set to true (YAML `true`, or the string a quoted value gives). */
export function pinnedBy(frontmatter: unknown): boolean {
  if (frontmatter === null || typeof frontmatter !== 'object') return false;
  const value = (frontmatter as Record<string, unknown>)[FRONTMATTER_KEEP];
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/** What one call's drop_skills did: each name asked, sorted by what became of it. */
export type DropOutcome = { dropped: string[]; pending: string[]; pinned: string[]; unknown: string[] };

/**
 * Applies one stored handoff's drop_skills for a party. A name the party has loaded, not pinned, and named by its previous
 * stored handoff too is dropped: every skill entry of that name is taken out of the ledger, so neither this wake nor a later
 * one carries it until the party loads it again. A loaded, unpinned name asked once is pending: the next handoff must name it
 * again. A pinned name, or one the party never loaded, is answered and never counted.
 */
export function applyDrops(ledger: Ledger, party: PartyKey, asked: readonly string[], previous: readonly string[]): { ledger: Ledger; outcome: DropOutcome } {
  const loaded = new Map<string, boolean>();
  for (const e of ledger.entries) if (e.kind === 'skill' && e.party === party) loaded.set(e.skill, e.keep === true); // the latest entry decides
  const outcome: DropOutcome = { dropped: [], pending: [], pinned: [], unknown: [] };
  for (const name of new Set(asked)) {
    const keep = loaded.get(name);
    if (keep === undefined) outcome.unknown.push(name);
    else if (keep) outcome.pinned.push(name);
    else (previous.includes(name) ? outcome.dropped : outcome.pending).push(name);
  }
  if (outcome.dropped.length === 0) return { ledger, outcome };
  const gone = new Set(outcome.dropped);
  return { ledger: { ...ledger, entries: ledger.entries.filter((e) => !(e.kind === 'skill' && e.party === party && gone.has((e as SkillEntry).skill))) }, outcome };
}

/** The receipt's lines for drop_skills, empty when none were asked. */
export function dropNote(outcome: DropOutcome): string {
  const list = (names: string[]) => names.join(', ');
  return [
    outcome.dropped.length > 0 ? `Dropped from your wake: ${list(outcome.dropped)}. Load one again with the Skill tool if you need it.` : '',
    outcome.pending.length > 0 ? `Not dropped yet: ${list(outcome.pending)}. Name it in drop_skills on your next handoff too, and that wake leaves it out.` : '',
    outcome.pinned.length > 0 ? `Never dropped: ${list(outcome.pinned)}. It is pinned: its file's frontmatter sets ${FRONTMATTER_KEEP}, or FORWARD_COMPACTION_KEEP_SKILLS names it.` : '',
    outcome.unknown.length > 0 ? `Not in your context, nothing to drop: ${list(outcome.unknown)}. Use the name the skill or command was loaded under.` : '',
  ].filter(Boolean).join(' ');
}
