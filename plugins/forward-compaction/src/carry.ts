// What a wake carries whole and what it only lists. A skill or command is listed by name, description and source unless
// its file's frontmatter sets FRONTMATTER_KEEP, FORWARD_COMPACTION_KEEP_SKILLS names it (KEEP_ALL names every one), or the
// frontier's keep_skills names it for that one wake. A load file marked `later` is listed by path and why, in every wake of
// the party, until a frontier names its path again, drops it in drop_files, or it is gone when a wake is built.
// A skill carried whole fits Claude Code's own post-compaction limits (fitSkills).

import type { FileCheck, LoadFile } from './frontier';

/** The frontmatter key that pins a skill or command whole in every wake: `forward-compaction-keep: true`. */
export const FRONTMATTER_KEEP = 'forward-compaction-keep';
/** The FORWARD_COMPACTION_KEEP_SKILLS name that pins every skill and command. */
export const KEEP_ALL = '*';

/** One skill's carried text: Claude Code's own 5,000 tokens a skill after compaction, at its 4 characters a token; a design budget in characters, never a measured token count. */
export const SKILL_MAX_CHARS = 20_000;
/** All carried skills together: Claude Code's own 25,000 tokens for skills after compaction, at its 4 characters a token; a design budget in characters, never a measured token count. */
export const SKILLS_MAX_CHARS = 100_000;
/** What ends a skill cut to SKILL_MAX_CHARS, Claude Code's own marker, verbatim. */
export const SKILL_TRUNCATED = '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]';

/** The sentence under `## Skills not carried`: a listed skill's text is gone, and the Skill tool loads it again. */
export const SKILLS_LISTED_NOTE = 'Their text is not in your context: load one again with the Skill tool before doing work it governs.';
/** The sentence under `## Files for later, not loaded`: the files were never read in, and are read at the step that needs them. */
export const LATER_NOTE = 'Their content is not in your context: read each with the Read tool (or the shell) at the step that needs it.';

/**
 * The skills a wake carries whole (pinned, or named in the frontier's keep_skills), as Claude Code carries them after its
 * own compaction: newest loaded first, each cut past SKILL_MAX_CHARS to its head and SKILL_TRUNCATED, and together within
 * SKILLS_MAX_CHARS; one that does not fit what is left is skipped and the next, smaller one may still fit.
 */
export function fitSkills<S extends { text: string }>(skills: readonly S[]): { carried: S[]; skipped: S[] } {
  const carried: S[] = [];
  const skipped: S[] = [];
  let left = SKILLS_MAX_CHARS;
  for (const s of skills) {
    const text = s.text.length > SKILL_MAX_CHARS ? s.text.slice(0, SKILL_MAX_CHARS - SKILL_TRUNCATED.length) + SKILL_TRUNCATED : s.text;
    if (text.length > left) skipped.push(s);
    else (left -= text.length), carried.push({ ...s, text });
  }
  return { carried, skipped };
}

/** Whether a skill's frontmatter pins it: the key set to true (YAML `true`, or the string a quoted value gives). */
export function pinnedBy(frontmatter: unknown): boolean {
  if (frontmatter === null || typeof frontmatter !== 'object') return false;
  const value = (frontmatter as Record<string, unknown>)[FRONTMATTER_KEEP];
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

/** Whether a loaded skill is carried whole in every wake: its frontmatter pinned it when it loaded (`keep`, pinnedBy), or `keepSkills` (FORWARD_COMPACTION_KEEP_SKILLS) names it or KEEP_ALL, read at each wake, so a pin set after the skill loaded, a reload's included, holds. */
export function pinned(skill: { skill: string; keep?: true }, keepSkills: readonly string[]): boolean {
  return skill.keep === true || keepSkills.includes(KEEP_ALL) || keepSkills.includes(skill.skill);
}

/** A skill's frontmatter `description`, trimmed; undefined when it has none, or one that is no string or blank. */
export function descriptionOf(frontmatter: unknown): string | undefined {
  if (frontmatter === null || typeof frontmatter !== 'object') return undefined;
  const value = (frontmatter as Record<string, unknown>).description;
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** What one call's keep_skills did: each name asked, by what became of it. */
export type KeepOutcome = { kept: string[]; pinned: string[]; unknown: string[] };

/** Sorts one call's keep_skills against the party's loaded skills (the latest entry of each name decides) and `keepSkills` (`pinned`): carried whole in the next wake, pinned already, or never loaded. */
export function keepOutcome(loaded: readonly { skill: string; keep?: true }[], asked: readonly string[], keepSkills: readonly string[]): KeepOutcome {
  const keep = new Map(loaded.map((s) => [s.skill, pinned(s, keepSkills)]));
  const outcome: KeepOutcome = { kept: [], pinned: [], unknown: [] };
  for (const name of new Set(asked)) {
    const pin = keep.get(name);
    (pin === undefined ? outcome.unknown : pin ? outcome.pinned : outcome.kept).push(name);
  }
  return outcome;
}

/** The receipt's lines for keep_skills, empty when none were asked. */
export function keepNote(outcome: KeepOutcome): string {
  const list = (names: string[]) => names.join(', ');
  return [
    outcome.kept.length > 0 ? `Carried whole in your next wake: ${list(outcome.kept)}. Name it in keep_skills again to keep it in the wake after.` : '',
    outcome.pinned.length > 0 ? `Carried whole in every wake already: ${list(outcome.pinned)}. It is pinned: its file's frontmatter sets ${FRONTMATTER_KEEP}, or FORWARD_COMPACTION_KEEP_SKILLS names it.` : '',
    outcome.unknown.length > 0 ? `Not in your context, nothing to keep: ${list(outcome.unknown)}. Use the name the skill or command was loaded under.` : '',
  ].filter(Boolean).join(' ');
}

/** A party's files for later, after one call: `listed` the list, `dropped` the paths drop_files took out of it, `unknown` the drop_files paths it did not hold. */
export type LaterOutcome = { listed: LoadFile[]; dropped: string[]; unknown: string[] };

/**
 * One stored frontier applied to the party's files for later: a path its drop_files names leaves the list, a path its
 * load_files names leaves it too (the new entry replaces it), and each load file marked `later` joins it, a path named
 * twice at its last entry; drop_files wins over a `later` entry of the same call. No cap: the list is one line a file, and the model ends each entry.
 */
export function laterApply(list: readonly LoadFile[], loadFiles: readonly LoadFile[], dropFiles: readonly string[]): LaterOutcome {
  const drop = new Set(dropFiles);
  const named = new Set(loadFiles.map((f) => f.path));
  const held = new Set(list.map((f) => f.path));
  const fresh = new Map<string, LoadFile>();
  for (const f of loadFiles) if (f.later && !drop.has(f.path)) (fresh.delete(f.path), fresh.set(f.path, f));
  return {
    listed: [...list.filter((f) => !drop.has(f.path) && !named.has(f.path)), ...fresh.values()],
    dropped: [...drop].filter((path) => held.has(path)),
    unknown: [...drop].filter((path) => !held.has(path)),
  };
}

/** The receipt's lines for the files for later: the list after this call when it holds any, and each drop_files path. */
export function laterNote(outcome: LaterOutcome): string {
  const list = (paths: readonly string[]) => paths.join(', ');
  return [
    outcome.listed.length > 0 ? `Listed for later in every wake, not loaded: ${list(outcome.listed.map((f) => f.path))}. Read one at the step that needs it; name it in drop_files once no step does.` : '',
    outcome.dropped.length > 0 ? `Dropped from the files for later: ${list(outcome.dropped)}.` : '',
    outcome.unknown.length > 0 ? `Not listed for later, nothing to drop: ${list(outcome.unknown)}.` : '',
  ].filter(Boolean).join(' ');
}

/** Why a file for later cannot stay listed, from `$.fs.stat` at a wake (the adapter's `statFile`); undefined when it is a regular file. */
export function laterProblem(check: FileCheck): string | undefined {
  if ('error' in check) return `could not be checked: ${check.error}`;
  if ('absent' in check) return 'no such file';
  return check.kind === 'file' ? undefined : 'not a regular file';
}

/** A party's files for later at a wake, each checked by `check` (`$.fs.stat`, the adapter's `statFile`): one missing or unreadable is named in this wake as not carried and leaves `party.later`, which `keep` then persists, so it is said once. */
export async function laterChecked(party: { later?: LoadFile[] }, check: (path: string) => Promise<FileCheck>, keep: () => Promise<void>): Promise<{ listed: LoadFile[]; gone: { path: string; problem: string }[] }> {
  const listed: LoadFile[] = [], gone: { path: string; problem: string }[] = [];
  for (const file of party.later ?? []) {
    const problem = laterProblem(await check(file.path));
    if (problem === undefined) listed.push(file);
    else gone.push({ path: file.path, problem });
  }
  if (gone.length > 0) (party.later = listed), await keep();
  return { listed, gone };
}

/** The files for later `$.state` kept for a party, each entry with a non-blank path (`lines` and `why` kept when strings); undefined when nothing usable was kept. */
export function keptLater(kept: unknown): LoadFile[] | undefined {
  if (!Array.isArray(kept)) return undefined;
  return kept.flatMap((f): LoadFile[] => {
    if (f === null || typeof f !== 'object' || typeof f.path !== 'string' || f.path.trim() === '') return [];
    return [{ path: f.path, ...(typeof f.lines === 'string' ? { lines: f.lines } : {}), ...(typeof f.why === 'string' ? { why: f.why } : {}), later: true }];
  });
}
