#!/usr/bin/env node
// Deterministic synthetic filler for the replay recording: the same seed gives the same files on every host.
// Usage: node filler.mjs <dir> [count=10] [chars=35000]   (35,000 characters of this filler tokenize to about 25k tokens)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WORDS = ['amber', 'basalt', 'cedar', 'delta', 'ember', 'fjord', 'granite', 'harbor', 'indigo', 'juniper', 'kestrel', 'lagoon', 'meadow', 'nickel', 'onyx', 'prairie', 'quartz', 'raven', 'sierra', 'tundra', 'umber', 'valley', 'willow', 'xenon', 'yarrow', 'zephyr'];

/** mulberry32: a small seeded generator, so the filler never depends on Math.random. */
export function generator(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function filler(n, chars) {
  const next = generator(n * 7919);
  const lines = [`filler file ${n}: synthetic text for the forward-compaction replay recording.`];
  let size = lines[0].length + 1;
  for (let line = 1; size < chars; line++) {
    const words = Array.from({ length: 12 }, () => WORDS[Math.floor(next() * WORDS.length)]);
    const text = `${String(line).padStart(4, '0')} ${words.join(' ')}`;
    lines.push(text);
    size += text.length + 1;
  }
  return lines.join('\n').slice(0, chars) + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, count = '10', chars = '35000'] = process.argv.slice(2);
  if (!dir || !/^\d+$/.test(count) || !/^\d+$/.test(chars)) {
    console.error('usage: node filler.mjs <dir> [count=10] [chars=35000]');
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= Number(count); n++) writeFileSync(join(dir, `filler-${n}.txt`), filler(n, Number(chars)));
  console.log(`filler: ${count} files of ${chars} characters in ${dir}`);
}
