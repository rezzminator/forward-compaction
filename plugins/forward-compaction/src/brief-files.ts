// The documents a sub-agent's brief names. Its kept start holds the brief word for word (kept.ts `keptStart`), but a
// brief that hands its rules to a file ("build per /flight/spec.md") leaves that file's text to the party's context,
// which a compaction drops. Every wake reads them in again: `briefFiles` picks them, `readBriefFiles` reads them at
// install within one budget. Pure but for the `read` the adapter hands in.
import { LOAD_FILE_MAX_CHARS, sliceFile } from './frontier';
import type { WakeFile } from './wake';
import type { FileTag } from './work';

/** What a brief's instructions come as: a text document. Source, data and logs a brief names are material the party reads again, never carried here. */
export const BRIEF_FILE_EXTENSIONS = ['md', 'markdown', 'txt', 'rst', 'adoc'] as const;
/** All the documents a brief names, together: what one carried file may hold (LOAD_FILE_MAX_CHARS), so a brief that points at files costs a wake no more than one. A design budget in characters, never a measured size. */
export const BRIEF_FILES_MAX_CHARS = LOAD_FILE_MAX_CHARS;

/** A character a path cannot continue across: where a path named in prose or a command starts. */
const BEFORE = String.raw`\s"'\x60(\[{<>=:,;|&*`;
/** An absolute path, or one under `~`, that ends in a document extension and at the path's end: `/a/spec.md.bak` and `/a/spec.md/x` are other paths. */
const NAMED = new RegExp(String.raw`(?<![^${BEFORE}])(~?/(?!/)[^\s"'\x60()\[\]{}<>|;,*?!]*?\.(?:${BRIEF_FILE_EXTENSIONS.join('|')}))(?![\w/-]|\.\w)`, 'gi');

/** Whether `text` holds `path` as a whole path, never as the end or the start of a longer one. */
function mentions(text: string, path: string): boolean {
  for (let at = text.indexOf(path); at >= 0; at = text.indexOf(path, at + 1)) {
    const before = at === 0 ? '' : text[at - 1]!;
    const after = text.slice(at + path.length, at + path.length + 2);
    if ((before === '' || new RegExp(`[${BEFORE}]`).test(before)) && !/^(?:[\w/-]|\.\w)/.test(after)) return true;
  }
  return false;
}

/**
 * The documents a wake reads in for a sub-agent, absolute, in the brief's order, each once: every path its brief names
 * (absolute, or under `~` once `home` is known) that ends in a BRIEF_FILE_EXTENSIONS extension, that one of the party's
 * calls opened (a Read of it, or a shell command naming it), so its text was in the context the compaction drops, that
 * the party did not write or edit (that file is its work, and its frontier's to carry), and that its frontier does not
 * ask to carry itself (`asked`, the load files).
 */
export function briefFiles(input: { brief: string; home?: string; files: readonly { path: string; tag: FileTag }[]; commands: readonly { command: string }[]; asked: readonly string[] }): string[] {
  const picked: string[] = [];
  for (const match of input.brief.matchAll(NAMED)) {
    const named = match[1]!;
    const under = named.startsWith('~');
    if (under && input.home === undefined) continue;
    const path = under ? `${input.home}${named.slice(1)}` : named;
    if (picked.includes(path) || input.asked.includes(path)) continue;
    const touched = input.files.filter((f) => f.path === path);
    if (touched.some((f) => f.tag !== 'R')) continue;
    if (touched.length > 0 || input.commands.some((c) => mentions(c.command, path) || (under && mentions(c.command, named)))) picked.push(path);
  }
  return picked;
}

/** How many of `lines` fit `chars` from the first on, joined by newlines. */
function linesWithin(lines: readonly string[], chars: number): number {
  let used = 0;
  let fit = 0;
  for (const line of lines) {
    used += line.length + (fit === 0 ? 0 : 1);
    if (used > chars) break;
    fit++;
  }
  return fit;
}

/**
 * Each document read now through `read` (`$.fs.read`), in order, all within BRIEF_FILES_MAX_CHARS: one that fits what
 * is left is carried whole; the one that crosses it is cut at its last line that fits, its body's last line naming where
 * to Read on (frontier.ts `sliceFile`); one with no room for its first line, and one that cannot be read, is carried as
 * its problem and takes nothing from the budget.
 */
export async function readBriefFiles(read: (path: string) => Promise<string>, paths: readonly string[]): Promise<WakeFile[]> {
  const out: WakeFile[] = [];
  let left = BRIEF_FILES_MAX_CHARS;
  for (const path of paths) {
    let text: string;
    try {
      text = await read(path);
    } catch (error) {
      out.push({ path, problem: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const whole = sliceFile(path, text, undefined, undefined, Number.MAX_SAFE_INTEGER);
    const fit = 'body' in whole && whole.body.length > left ? linesWithin(text.split('\n'), left) : undefined;
    if (fit === 0) {
      out.push({ path, problem: `the ${BRIEF_FILES_MAX_CHARS} characters the documents your brief names share are used up: Read it again before you act on what it says` });
      continue;
    }
    const sliced = fit === undefined ? whole : sliceFile(path, text, undefined, undefined, fit);
    if (!('body' in sliced)) {
      out.push({ path, problem: sliced.problem });
      continue;
    }
    out.push({ path, ...(sliced.shown ? { lines: sliced.shown } : {}), content: sliced.body });
    left -= sliced.body.length;
  }
  return out;
}
