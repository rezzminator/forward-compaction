#!/usr/bin/env node
// The benchmark scenario: a ledger-reconciliation job, identical in every arm for one seed and blind (it never names
// compaction or any plugin). Writes the workspace's records, the planted truth and the turns the driver types.
// Usage: node scenario.mjs <run-dir> <seed> [reading-turns=9]
//   -> <run-dir>/ws/records/batch-NN.txt, <run-dir>/ws/out/, <run-dir>/truth.json, <run-dir>/turns.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { filler, generator } from '../replay/filler.mjs';

/** Characters per batch file: about 20k tokens of filler, below the Read tool's 25k-token refusal. */
export const BATCH_CHARS = 28_000;
export const BATCHES_PER_TURN = 2;
export const NOTES_PER_BATCH = 2;

const ITEMS = ['cobalt washers', 'linen spools', 'brass hinges', 'cedar dowels', 'glass floats', 'copper rivets', 'felt pads', 'tin lanterns', 'rope coils', 'slate tiles', 'wax candles', 'iron hooks', 'cork stoppers', 'zinc brackets', 'clay pots', 'wool bales', 'bamboo poles', 'steel springs', 'jute sacks', 'pewter cups', 'silk ribbons', 'nylon nets', 'granite blocks', 'pine pallets', 'oak barrels', 'paper reams', 'ceramic tiles', 'leather straps', 'rubber seals', 'acrylic sheets', 'velvet rolls', 'marble slabs', 'hemp twine', 'chrome bolts', 'birch planks', 'quartz lamps'];
const COLORS = ['blue', 'red', 'green', 'yellow', 'grey', 'orange', 'white', 'black'];
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NAMES = ['Varga', 'Okafor', 'Lindqvist', 'Moreau', 'Tanaka', 'Ferreira', 'Novak', 'Haddad'];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const pick = (next, list) => list[Math.floor(next() * list.length)];
const pad2 = (n) => String(n).padStart(2, '0');

/** The whole scenario for one seed: batches with their planted notes, the client's note, the turns. */
export function scenario(seed, readingTurns = 9) {
  const most = Math.floor(ITEMS.length / (BATCHES_PER_TURN * NOTES_PER_BATCH)); // each planted note takes an item of its own
  if (readingTurns > most) throw new Error(`scenario: ${readingTurns} reading turns plant more notes than the ${ITEMS.length} items; at most ${most}`);
  const next = generator(seed * 104_729 + 17);
  const items = [...ITEMS].sort(() => next() - 0.5);
  const crates = new Set();
  const batches = [];
  for (let b = 1; b <= readingTurns * BATCHES_PER_TURN; b++) {
    const notes = [];
    for (let k = 0; k < NOTES_PER_BATCH; k++) {
      let crate;
      do crate = `${pick(next, LETTERS)}${pick(next, LETTERS)}-${100 + Math.floor(next() * 900)}`; while (crates.has(crate));
      crates.add(crate);
      const tenths = 50 + Math.floor(next() * 950);
      notes.push({ crate, item: items.pop(), kg: (tenths / 10).toFixed(1), grams: tenths * 100, shelf: `${pick(next, LETTERS)}-${10 + Math.floor(next() * 90)}` });
    }
    batches.push({ code: `B${pad2(b)}`, file: `records/batch-${pad2(b)}.txt`, turn: Math.ceil(b / BATCHES_PER_TURN), notes });
  }
  const quote = `The ${pick(next, COLORS)} gantry stays shut on ${pick(next, DAYS)}s until inspector ${pick(next, NAMES)} signs form ${1 + Math.floor(next() * 9)}-${pick(next, LETTERS)}.`;
  const changeTurn = Math.floor(readingTurns / 2) + 1;
  const turns = [];
  for (let t = 1; t <= readingTurns; t++) {
    const [a, b] = batches.filter((x) => x.turn === t);
    const read = `read ${a.file} and ${b.file} whole, and write out/summary-${pad2(t)}.md with one line per LEDGER NOTE those two files hold (batch code, crate code, item, weight) and nothing else.`;
    let prompt;
    if (t === 1) prompt = `I am reconciling a warehouse ledger kept in records/. Rules for this whole job: (1) every file you write goes under out/; (2) never run shell commands, use only the file tools; (3) in every summary, each line starts with its batch code in square brackets, like [B01]; (4) write every weight in kilograms with one decimal, like 41.5 kg. First, ${read}`;
    else if (t === 2 && t !== changeTurn) prompt = `A note from the client, keep it word for word: "${quote}" Next, ${read}`;
    else if (t === changeTurn) prompt = `${t === 2 ? `A note from the client, keep it word for word: "${quote}" ` : ''}Change of rule: from now on write every weight in grams as a whole number, like 41500 g. This replaces rule (4); the other rules stand. Next, ${read}`;
    else prompt = `Next, ${read}`;
    turns.push({ id: `T${t}`, prompt, batches: [a.code, b.code], summary: `out/summary-${pad2(t)}.md`, unit: t >= changeTurn ? 'g' : 'kg' });
  }
  const all = batches.flatMap((x) => x.notes);
  const order = all.map((n) => n.crate).sort(() => next() - 0.5);
  turns.push({ id: `T${readingTurns + 1}`, final: true, prompt: `Last step. Do not open any file: answer from what you know of this job. Write out/answers.json holding one JSON object: "client_note", the client's note word for word; "crates", an object keyed by crate code with {"item": ..., "shelf": ...} for each of these crates: ${order.join(', ')}; "total_grams", the total weight of all these crates in grams, a whole number. Where you do not know a value, write null.` });
  return { seed, readingTurns, changeTurn, quote, total_grams: all.reduce((s, n) => s + n.grams, 0), batches, turns };
}

/** One batch file: a header, the filler's numbered lines, each planted note at a seeded line. */
export function batchText(seed, batch) {
  const next = generator(seed * 7_177 + Number(batch.code.slice(1)));
  // The filler's own first line names the replay recording, so the blind scenario drops it, and its last line, cut mid-word.
  const lines = filler(seed * 1_000 + Number(batch.code.slice(1)), BATCH_CHARS).trimEnd().split('\n').slice(1, -1);
  for (const note of batch.notes) {
    const at = 5 + Math.floor(next() * (lines.length - 10));
    lines.splice(at, 0, `LEDGER NOTE: crate ${note.crate} holds ${note.item}, weighing ${note.kg} kg, stored on shelf ${note.shelf}.`);
  }
  return `ledger extract, batch ${batch.code} (synthetic test data)\n${lines.join('\n')}\n`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, seedArg, turnsArg = '9'] = process.argv.slice(2);
  if (!dir || !/^\d+$/.test(seedArg ?? '') || !/^([2-9]|[1-9]\d+)$/.test(turnsArg)) {
    console.error('usage: node scenario.mjs <run-dir> <seed> [reading-turns=9]');
    process.exit(2);
  }
  const s = scenario(Number(seedArg), Number(turnsArg));
  mkdirSync(join(dir, 'ws', 'records'), { recursive: true });
  mkdirSync(join(dir, 'ws', 'out'), { recursive: true });
  for (const b of s.batches) writeFileSync(join(dir, 'ws', b.file), batchText(s.seed, b));
  const { turns, ...truth } = s;
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth, null, 2) + '\n');
  writeFileSync(join(dir, 'turns.json'), JSON.stringify(turns, null, 2) + '\n');
  console.log(`scenario: seed ${s.seed}, ${s.batches.length} batches, ${turns.length} turns in ${dir}`);
}
