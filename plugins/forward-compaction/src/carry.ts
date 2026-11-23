// Which skills a wake carries whole and which it only lists. A skill or command is listed by name, description and
// source unless its file's frontmatter sets FRONTMATTER_KEEP or FORWARD_COMPACTION_KEEP_SKILLS names it (KEEP_ALL names
// every one). A skill carried whole fits Claude Code's own post-compaction limits (fitSkills).

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

/**
 * The skills a wake carries whole (pinned), as Claude Code carries them after its
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
