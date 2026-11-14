import { afterEach, describe, expect, it } from 'vitest';
import { fakeEngine } from './fakes/engine.ts';
import { wakeRow, type RowNode, type RowProps } from '../plugins/forward-compaction/src/wake-row.ts';

const FACTS = '[forward-compaction: facts] Your context was compacted by forward-compaction 2.2.5.\n\n## Files you touched\n/work/a.ts';
const FRONTIER = '[forward-compaction: frontier] Below is the frontier you wrote with forward_compaction: continue from its ## Next.\n\n=== frontier ===\n## Next\nship\n=== end of frontier ===';
const MECHANICAL = '[forward-compaction: no frontier written by the model] Your context reached 120k tokens, past the 100k ceiling, and you had not called forward_compaction';

const line = (text: string): RowNode => ({ type: 'Box', props: { marginTop: 1 }, children: [{ type: 'Text', props: { dimColor: true }, children: [text] }] });
const FRONTIER_LINE = line('forward-compaction installed the frontier: the transcript view (ctrl+o) shows it and the recorded facts in full');
const MECHANICAL_LINE = line('forward-compaction compacted mechanically, no frontier was written: the transcript view (ctrl+o) shows its note and the recorded facts in full');
const NOTHING: RowNode = { type: 'Box', props: { display: 'none' } };

const row = (text: string, over: Partial<RowProps> = {}): RowProps => ({ text, origin: { kind: 'unclassified' }, isExpanded: false, ...over });

describe('wakeRow: what a user-role transcript row draws', () => {
  it.each<[string, RowProps, RowNode | undefined]>([
    ['the facts draw nothing', row(FACTS), NOTHING],
    ['the frontier draws one dim line', row(FRONTIER), FRONTIER_LINE],
    ['the note of a mechanical wake draws one dim line', row(MECHANICAL), MECHANICAL_LINE],
    ['the expanded view keeps the facts whole', row(FACTS, { isExpanded: true }), undefined],
    ['the expanded view keeps the frontier whole', row(FRONTIER, { isExpanded: true }), undefined],
    ['the expanded view keeps the mechanical note whole', row(MECHANICAL, { isExpanded: true }), undefined],
    ['the same text typed by the person stays whole', row(FRONTIER, { origin: { kind: 'composer' } }), undefined],
    ['the same text from a task notification stays whole', row(FACTS, { origin: { kind: 'task-notification' } }), undefined],
    ['an opening that is not at the start is no wake message', row(`see ${FRONTIER}`), undefined],
    ['any other message the engine left unclassified stays whole', row('[forward-compaction: nudge] context 173k and increasing.'), undefined],
    ['an empty row stays whole', row(''), undefined],
  ])('%s', (_name, props, drawn) => {
    expect(wakeRow(props)).toEqual(drawn);
  });
});

describe('the adapter draws a wake message folded', () => {
  let f: ReturnType<typeof fakeEngine> | undefined;
  afterEach(() => { f?.cleanup(); f = undefined; });

  const ENGINE = { type: 'engine', ref: 0 };
  const draw = (component: string, props: RowProps): Promise<unknown> => f!.dispatch('ui.render', { surface: 'terminal', component, requestId: 'm1', props }, async () => ENGINE);

  it('folds a user-role row of the wake and leaves the expanded view, and every other component, to the engine', async () => {
    f = fakeEngine({ window: 200_000 });
    expect(await draw('UserMessage', row(FACTS))).toEqual(NOTHING);
    expect(await draw('UserMessage', row(FRONTIER))).toEqual(FRONTIER_LINE);
    expect(await draw('UserMessage', row(FRONTIER, { isExpanded: true }))).toBe(ENGINE);
    expect(await draw('UserMessage', row('hello'))).toBe(ENGINE);
    expect(await draw('AssistantMessage', row(FRONTIER))).toBe(ENGINE);
    expect(f.unscripted).toEqual([]);
  });
});
