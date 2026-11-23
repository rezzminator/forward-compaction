// Messages in `session.compact`'s shape, each with the handle the engine gives its own, for the tests of what a wake keeps and builds.
import type { WakeMessage } from '../../plugins/forward-compaction/src/kept.ts';

export type Msg = WakeMessage & { handle: string };
export const user = (text: string, handle = `h-${text.slice(0, 12)}`): Msg => ({ role: 'user', text, toolUses: [], handle });
export const assistant = (text: string, uses: { id: string; tool: string; input?: Record<string, unknown> }[] = [], handle = `h-${text.slice(0, 12)}`): Msg => ({
  role: 'assistant', text, handle,
  toolUses: uses.map((u) => ({ tool_use_id: u.id, tool: u.tool, input: u.input ?? {} })),
});
export const results = (...answers: [string, string][]): Msg => ({ role: 'user', text: '', toolUses: [], toolResults: answers.map(([id, text]) => ({ tool_use_id: id, text })), handle: `h-res-${answers[0]![0]}` });
