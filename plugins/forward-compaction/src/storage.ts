// The storage: markdown files the model keeps for a later step, each listed in the wake by name and description. The
// model reads and edits a file itself, by the absolute path the wake gives; the plugin writes a value an `add` sends,
// lists and unlists entries, and copies every value that leaves (overwritten or removed) to `history/storage/`. The
// file API has no move or delete, so a removed entry's file stays in `storage/`, unlisted.
import { absent, STORAGE_DIR, type Fs, type PartyFiles } from './disk';
import { kind, num, type StorageEntry } from './lists';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The longest name before `.md`: a longer one is cut, so the file's name stays under every file system's 255-byte limit. */
const NAME_MAX = 100;

/** A storage name: lower-case letters, digits and dashes, ending `.md`; `.md` is added when missing, and any other name is rewritten to that form, cut to NAME_MAX. Undefined when nothing of it is left. */
export function storageName(sent: string): string | undefined {
  const base = sent.trim().replace(/\.md$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, NAME_MAX).replace(/-+$/, '');
  return base === '' ? undefined : `${base}.md`;
}

/** The storage section of the facts: the folder once, then one line per entry. */
export function storageSection(dir: string, entries: readonly StorageEntry[]): string | undefined {
  if (entries.length === 0) return undefined;
  return [`## Storage — files in ${dir}/`, ...entries.map((e) => (e.description === '' ? e.name : `${e.name} — ${e.description}`))].join('\n');
}

/** The party's storage folder, absolute. */
export const storageDir = (files: PartyFiles): string => `${files.root}/${STORAGE_DIR}`;

export type StorageOutcome = { entries: StorageEntry[]; lines: string[]; notes: string[]; count: { added: number; removed: number } };

/**
 * One call's `storage` change `{ add, remove }`: an add with a value writes the file and lists the entry (a file
 * already in the folder, listed or not, is overwritten after its old value is copied to the history), an add without one changes a listed
 * entry's description or lists a file already in the folder (one the model wrote there under another spelling of the
 * name is copied to its storage name), a remove unlists the entry and copies its value to the
 * history. Each entry that cannot be read is one note naming its place. Never throws: a file it cannot read is a note.
 */
export async function storageApply(fs: Fs, files: PartyFiles, entries: readonly StorageEntry[], change: unknown): Promise<StorageOutcome> {
  const out: StorageOutcome = { entries: entries.map((e) => ({ ...e })), lines: [], notes: [], count: { added: 0, removed: 0 } };
  if (change === undefined) return out;
  if (!isObject(change)) return (out.notes.push(`storage must be {add, remove}; got ${kind(change)}: nothing changed.`), out);
  for (const key of Object.keys(change)) if (key !== 'add' && key !== 'remove') out.notes.push(`storage.${key} is not add or remove: ignored.`);
  const listOf = (key: 'add' | 'remove'): unknown[] => {
    const v = change[key];
    if (v === undefined) return [];
    if (Array.isArray(v)) return v;
    if ((key === 'add' && isObject(v)) || (key === 'remove' && typeof v === 'string')) return [v];
    return (out.notes.push(`storage.${key} must be an array; got ${kind(v)}: skipped.`), []);
  };
  const path = (name: string): string => `${files.root}/${STORAGE_DIR}/${name}`;
  /** The file's text now; undefined when there is none; a note and `false` when it cannot be read. */
  const current = async (name: string, at: string): Promise<string | undefined | false> => {
    try {
      return await fs.read(path(name));
    } catch (error) {
      if (absent(error)) return undefined;
      return (out.notes.push(`${at}: ${STORAGE_DIR}/${name} could not be read (${error instanceof Error ? error.message : String(error)}), so its value cannot be kept in the history: skipped.`), false);
    }
  };
  const nameAt = (sent: unknown, at: string): string | undefined => {
    if (typeof sent !== 'string' || sent.trim() === '') return void out.notes.push(`${at} must be a non-blank name; got ${typeof sent === 'string' ? 'a blank one' : kind(sent)}: skipped.`);
    const name = storageName(sent);
    if (name === undefined) return void out.notes.push(`${at} "${sent}" holds no letter or digit: skipped.`);
    if (name !== sent && name !== `${sent}.md`) out.notes.push(`${at} "${sent}" is stored as ${name}: a name is lower-case letters, digits and dashes, ending .md.`);
    return name;
  };
  /** The file name as the model sent it, `.md` added when missing, when it is one path segment of the folder other than `name`: the model wrote the file itself, before its name was rewritten. */
  const asWritten = (sent: string, name: string): string | undefined => {
    const file = /\.md$/i.test(sent.trim()) ? sent.trim() : `${sent.trim()}.md`;
    return file !== name && !file.startsWith('.') && !/[\\/]/.test(file) ? file : undefined;
  };
  for (const [i, entry] of listOf('add').entries()) {
    const at = `storage.add[${i}]`;
    if (!isObject(entry)) {
      out.notes.push(`${at} must be {name, description, value}; got ${kind(entry)}: skipped.`);
      continue;
    }
    const name = nameAt(entry.name, `${at}.name`);
    if (name === undefined) continue;
    const { value, description } = entry;
    if (value !== undefined && typeof value !== 'string') {
      out.notes.push(`${at}.value must be a text; got ${kind(value)}: skipped.`);
      continue;
    }
    if (description !== undefined && typeof description !== 'string') out.notes.push(`${at}.description must be a text; got ${kind(description)}: ignored.`);
    const listed = out.entries.find((e) => e.name === name);
    const said = typeof description === 'string' ? description.trim() : undefined;
    if (value === undefined) {
      if (listed !== undefined) {
        if (said !== undefined) (listed.description = said), out.lines.push(`Described ${name}`);
        else out.notes.push(`${at} has neither value nor description: ${name} unchanged.`);
        continue;
      }
      const there = await current(name, at);
      if (there === false) continue;
      if (there === undefined) {
        const file = asWritten(entry.name as string, name);
        const written = file === undefined ? undefined : await current(file, at);
        if (written === false) continue;
        if (file === undefined || written === undefined) {
          out.notes.push(`${at} has no value and ${STORAGE_DIR}/${name} does not exist: skipped.`);
          continue;
        }
        files.queueStorage(name, written, undefined);
        out.entries.push({ name, description: said ?? '' }), (out.count.added += 1), out.lines.push(`Stored ${name} (${num(written.length)} characters, copied from ${file} in the folder)`);
        continue;
      }
      out.entries.push({ name, description: said ?? '' }), (out.count.added += 1), out.lines.push(`Stored ${name} (${num(there.length)} characters, as it is in the folder)`);
      continue;
    }
    const old = files.queuedStorage(name) ?? (await current(name, at)); // listed or not: a file in the folder is never overwritten without its copy
    if (old === false) continue;
    files.queueStorage(name, value, old);
    if (listed !== undefined) listed.description = said ?? listed.description;
    else out.entries.push({ name, description: said ?? '' });
    if (listed === undefined && said === undefined) out.notes.push(`${at}.description is missing: ${name} is listed without one.`);
    (out.count.added += 1), out.lines.push(`Stored ${name} (${num(value.length)} characters)`);
  }
  for (const [i, sent] of listOf('remove').entries()) {
    const at = `storage.remove[${i}]`;
    const name = nameAt(sent, at);
    if (name === undefined) continue;
    const listed = out.entries.findIndex((e) => e.name === name);
    if (listed < 0) {
      out.notes.push(`${at}: ${name} is not listed: skipped.`);
      continue;
    }
    const old = files.queuedStorage(name) ?? (await current(name, at));
    if (old === false) continue;
    files.queueStorage(name, undefined, old);
    out.entries.splice(listed, 1), (out.count.removed += 1), out.lines.push(`Storage no longer lists ${name}`);
  }
  if (out.count.added + out.count.removed > 0 || out.lines.length > 0) files.changed('storage');
  return out;
}
