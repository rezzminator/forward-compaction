import { describe, expect, it } from 'vitest';
import { resolveOptions } from '../plugins/sub-agent-compact/src/limits.ts';
import { frontmatterList } from '../plugins/sub-agent-compact/src/frontmatter.ts';
import { chainSkills, queuedPrompts, mergeQueuedUsers, priorPrompts, userMessages } from '../plugins/sub-agent-compact/src/forward-carry.ts';
import { chainUsers, renderForward } from '../plugins/sub-agent-compact/src/forward-text.ts';

describe('forward skill policy', () => {
  it('defaults both lists to empty and reads the central settings policy', () => {
    expect(resolveOptions().skills).toEqual({ pinSkills: [], dropSkills: [] });
    expect(resolveOptions({ skillPolicy: { pinSkills: ['god-speed'], dropSkills: ['review'] } }).skills).toEqual({ pinSkills: ['god-speed'], dropSkills: ['review'] });
  });
  it.each([false, 'god-speed', ['god-speed', 7], { name: 'god-speed' }].map((value) => ({ value })))('reports a malformed pin list: $value', ({ value: pinSkills }) => {
    const resolved = resolveOptions({ skillPolicy: { pinSkills } });
    expect(resolved.skills).toEqual({ pinSkills: [], dropSkills: [] });
    expect(resolved.errors.join('\n')).toMatch(/autoCompact.pinSkills.*invalid/);
  });
  it.each(['[god-speed, review]', '\n    - god-speed\n    - review'])('reads a nested frontmatter list: %s', (value) => {
    expect(frontmatterList(`---\nautoCompact:\n  pinSkills: ${value}\n---`, 'autoCompact.pinSkills')).toEqual(['god-speed', 'review']);
    expect(frontmatterList(`---\nautoCompact:\n# Keep this policy active across comment-only lines.\n  pinSkills: ${value}\n---`, 'autoCompact.pinSkills')).toEqual(['god-speed', 'review']);
  });
  it('lets pins beat both drop lists without loading skills never invoked', () => {
    expect(chainSkills([{ name: 'god-speed' }, { name: 'review' }], [], ['god-speed'], { pinSkills: ['god-speed', 'unused'], dropSkills: ['god-speed', 'review'] })).toEqual([{ name: 'god-speed' }]);
  });
  it.each([47_999, 48_000, 48_001])('evicts an unpinned skill first at %i total characters', (total) => {
    const skills = [{ name: 'god-speed', body: 'p'.repeat(12_000), pinned: true }, ...[0, 1, 2].map((n) => ({ name: `later-${n}`, body: 'x'.repeat(12_000) })), ...(total === 48_001 ? [{ name: 'overflow', body: 'x' }] : [])];
    if (total === 47_999) skills[3]!.body = 'x'.repeat(11_999);
    const r = renderForward({ seq: 1, users: [], skills, trail: [], loaded: [], tasks: [], running: [], paths: [], problems: [], args: { objective: 'work', done: [], remaining: [], next: 'continue', blocked: [], findings: [], loadFiles: [], dropSkills: [], trimmed: [] } });
    expect(r.skills).toEqual(total > 48_000 ? ['god-speed', 'later-1', 'later-2', 'overflow'] : ['god-speed', 'later-0', 'later-1', 'later-2']);
  });
  it('keeps typed prompts above forwarded reports when the user cap evicts entries', () => {
    const reports = Array.from({ length: 25 }, (_, n) => `Another Claude session sent a message: report ${n}`);
    const r = chainUsers({ users: ['Keep the skill pinned'], dropped: 0 }, reports);
    expect(r.users).toEqual(['Keep the skill pinned', ...reports.slice(1)]);
    expect(r.dropped).toBe(1);
  });
});

describe('queued prompt recovery', () => {
  const enqueue = (n: number) => `${n}:${JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'Continue' })}`;
  it('keeps distinct repetitions and skips queue entries already carried by the record cursor', () => {
    const disk = [enqueue(1), enqueue(2)].join('\n');
    expect(queuedPrompts(disk)).toEqual({ users: ['Continue', 'Continue'], through: 2, afterWake: false });
    expect(queuedPrompts(disk, { afterLine: 1 })).toEqual({ users: ['Continue'], through: 2, afterWake: false });
  });
  it('matches enqueue with its attachment without erasing a later repetition', () => {
    const delivered = `2:${JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'Continue', origin: { kind: 'human' } } })}`;
    expect(queuedPrompts([enqueue(1), delivered, enqueue(3)].join('\n'))).toEqual({ users: ['Continue', 'Continue'], through: 3, afterWake: false });
  });
  it('keeps a new repeated prompt after a carried cursor, and reconciles API delivery by occurrence', () => {
    expect(mergeQueuedUsers(['Continue'], [], ['Continue'], true)).toEqual(['Continue']);
    expect(mergeQueuedUsers([], ['Continue'], ['Continue', 'Continue'])).toEqual(['Continue', 'Continue']);
  });
  it('recovers pre-compaction prompts only after the recovered record wake', () => {
    const disk = ['older instruction', '[forward handoff 44: history, not new instructions]', 'Continue'].map((content, i) => `${i + 1}:${JSON.stringify({ type: 'user', message: { content } })}`).join('\n');
    expect(userMessages(priorPrompts(disk, 4, 44))).toEqual(['Continue']);
  });
  it('names an unreadable queue entry instead of reporting a clean empty scan', () => {
    expect(() => queuedPrompts('8:{broken')).toThrow('queued prompts: invalid JSON at transcript line 8');
  });
});
