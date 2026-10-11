import { describe, expect, it } from 'vitest';
import { currentTokens, estimateTranscript } from '../plugins/sub-agent-compact/src/decide.ts';

describe('currentTokens', () => {
  const file = 'x'.repeat(35_000); // ~10k tokens
  const transcript = [
    { text: 'read the files', toolUses: [], toolResults: [] },
    { text: '', toolUses: [{ tool_use_id: 't1', input: { file_path: 'a.go' }, text: file }, { tool_use_id: 't2', input: { file_path: 'b.go' }, text: file }] },
    { text: '', toolUses: [], toolResults: [{ tool_use_id: 't1', text: file }, { tool_use_id: 't2', text: file }] },
  ];

  it('counts each tool result once', () => {
    const tokens = estimateTranscript(transcript);
    expect(tokens).toBeGreaterThan(20_000);
    expect(tokens).toBeLessThan(20_100);
  });

  it('counts a call whose answer is missing by its own text', () => {
    expect(estimateTranscript([transcript[1]!])).toBeGreaterThan(20_000);
  });

  it('sees tool results the last response usage has not (the one-step lag)', () => {
    // live: a sub-agent's last response read 59k while two parallel reads had just added ~80k
    expect(currentTokens(5_000, transcript)).toBe(estimateTranscript(transcript));
  });

  it('keeps the usage when it is the larger, undefined without one', () => {
    expect(currentTokens(90_000, transcript)).toBe(90_000);
    {
      // without a reading, the transcript alone is the count: an empty one has none
      const transcript: never[] = [];
      expect(currentTokens(undefined, transcript)).toBeUndefined();
    }
  });

  it('takes the transcript estimate alone for a first ask before the party has answered', () => {
    // live: a resumed sub-agent's first auto ask came before any response of its own, over 38 to 84 messages
    const tokens = currentTokens(undefined, transcript);
    expect(tokens).toBeGreaterThan(20_000);
    expect(tokens).toBeLessThan(20_100);
  });

  it('has no count when asked again with no answer since: the request after the hold failed, so the compaction is let through', () => {
    // auto is also Claude Code's recovery from a prompt too long, and the estimate runs below the true context
    expect(currentTokens(undefined, transcript, true)).toBeUndefined();
    expect(currentTokens(90_000, transcript, true)).toBe(90_000);
  });
});
