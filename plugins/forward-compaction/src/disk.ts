// The files that keep one party's frontier across restarts, under
// `$HOME/.local/state/forward-compaction/{project}/{session id}/` (a sub-agent's under `agents/{agent id}/`):
// the live lists and texts, the storage listing and files, the count of compactions installed (`rounds.json`), and the
// history every value that left is appended to.
// The plugin alone writes them, and deletes nothing. A file that cannot be written loses no change: it stays dirty
// in memory and the next call writes it again. Pure but for the file calls, which arrive as `Fs`.
import { emptyHeld, listApply, LISTS, TEXTS, type Held, type Left, type List, type ListName, type StorageEntry, type TextName } from './lists';

/** The file calls the adapter hands in: `$.fs.read`, `$.fs.write` (which creates directories) and `$.fs.exists`. The API has no append, move or delete. */
export type Fs = { read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void>; exists: (path: string) => Promise<boolean> };

/** Where every session's folder lives, under the home directory. */
export const STATE_DIR = '.local/state/forward-compaction';
export type FileKey = ListName | TextName | 'storage' | 'rounds';
/** Each live file, relative to the party's folder. */
export const LIVE_FILE: Record<FileKey, string> = {
  orders: 'orders.json',
  ...(Object.fromEntries([...LISTS.filter((l) => l !== 'orders'), ...TEXTS].map((k) => [k, `data/${k}.json`])) as Record<Exclude<FileKey, 'orders' | 'storage' | 'rounds'>, string>),
  storage: 'storage.json',
  rounds: 'rounds.json',
};
export const STORAGE_DIR = 'storage';
/** One history file per list and text, one JSON line appended per value that left. */
export const historyFile = (key: ListName | TextName): string => `history/${key}.jsonl`;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
/**
 * Whether a file call failed because the path is missing. The host's `$.fs` rejects a missing path with an Error whose
 * message ends in its errno (`{plugin}: $.fs.read({path}) failed: ENOENT`) and no `code`; a Node-style `code` counts too.
 */
export const absent = (error: unknown): boolean => {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === 'ENOENT' || (typeof e?.message === 'string' && /\bENOENT\b/.test(e.message));
};
/** A name safe as one path segment. */
const segment = (name: string): string => name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '') || 'unknown';

/** `{project}`: the last name of the session's directory, without a leading dot. */
export function projectName(dir: string): string {
  return segment(dir.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? '');
}

/** The party's folder: the session's, or a sub-agent's under its `agents/`. `party` is `main` or `agent:{id}`. */
export function partyRoot(home: string, dir: string, session: string, party: string): string {
  const base = `${home.replace(/\/+$/, '')}/${STATE_DIR}/${projectName(dir)}/${segment(session)}`;
  return party === 'main' ? base : `${base}/agents/${segment(party.replace(/^agent:/, ''))}`;
}

/** `name` as a file name free in `dir`: itself, else with a number before its extension (`survey.2.md`). */
async function freeName(fs: Fs, dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? name : `${stem}.${n}${ext}`;
    if (!(await fs.exists(`${dir}/${candidate}`))) return `${dir}/${candidate}`;
  }
}

const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0;

/** A live list file's value, or undefined when it is not one. `next_id` is raised past every live number, so none is reused. */
function asList(v: unknown): List | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const { next_id, items } = v as Record<string, unknown>;
  if (!isInt(next_id) || !Array.isArray(items) || !items.every((i) => typeof i === 'object' && i !== null && isInt(i.id) && typeof i.text === 'string')) return undefined;
  const kept = items.map(({ id, text, round }) => ({ id: id as number, text: text as string, ...(isInt(round) ? { round } : {}) }));
  return { next_id: Math.max(next_id, ...kept.map((i) => i.id + 1)), items: kept };
}
/** The highest number an unparsable live list's text still names: its items' ids and, less one, its next number. */
function rawMax(raw: string | undefined): number {
  let max = 0;
  for (const m of (raw ?? '').matchAll(/"(next_id|id)"\s*:\s*(\d+)/g)) max = Math.max(max, Number(m[2]) - (m[1] === 'next_id' ? 1 : 0));
  return max;
}
const asText = (v: unknown): string | undefined => (typeof v === 'object' && v !== null && typeof (v as Record<string, unknown>).text === 'string' ? ((v as Record<string, unknown>).text as string) : undefined);
const asStorage = (v: unknown): StorageEntry[] | undefined => (Array.isArray(v) && v.every((e) => typeof e === 'object' && e !== null && typeof e.name === 'string' && typeof e.description === 'string') ? v.map(({ name, description }) => ({ name, description })) : undefined);

/** A problem a file call met: the file, relative to the party's folder, and the error. */
export type FileProblem = { file: string; error: string };

type StorageOp = { kind: 'save'; name: string; text: string } | { kind: 'write'; name: string; text: string };

/** One party's files: what it loaded, what waits to be written, and the history lines not yet appended. */
export class PartyFiles {
  /** Live files changed since they were last written. */
  readonly dirty = new Set<FileKey>();
  /** Live files that could not be read at load: shown empty, and not written until a call changes them. */
  readonly unreadable = new Set<FileKey>();
  /** History lines not yet appended, by history file. */
  readonly history = new Map<string, string[]>();
  /** Storage file writes not yet done, in order: a `save` copies a value that leaves to `history/storage/`, a `write` sets `storage/{name}`. */
  readonly storage: StorageOp[] = [];
  /** No `orders.json` was found at load: the previous build's remembered orders may become the first numbered ones. */
  ordersAbsent = false;

  constructor(readonly root: string) {}

  /** The party's held frontier from its files. A missing file is empty; one that cannot be read or parsed is empty, named in `problems` and left as it is on disk. Every list's next number is past every number its history holds, and past those an unparsable live file's own text names, so none is reused. */
  async load(fs: Fs): Promise<{ held: Held; problems: FileProblem[] }> {
    const held = emptyHeld();
    const problems: FileProblem[] = [];
    const unread = (key: FileKey, error: unknown): void => void (problems.push({ file: LIVE_FILE[key], error: message(error) }), this.unreadable.add(key));
    const readJson = async (key: FileKey): Promise<{ value?: unknown; missing?: true; raw?: string }> => {
      let raw: string;
      try {
        raw = await fs.read(`${this.root}/${LIVE_FILE[key]}`);
      } catch (error) {
        if (absent(error)) return { missing: true };
        return (unread(key, error), {});
      }
      try {
        return { value: JSON.parse(raw), raw };
      } catch (error) {
        return (unread(key, error), { raw });
      }
    };
    const bad = (key: FileKey, what: string): void => void (problems.push({ file: LIVE_FILE[key], error: `not ${what}` }), this.unreadable.add(key));
    for (const name of LISTS) {
      const read = await readJson(name);
      if (read.missing && name === 'orders') this.ordersAbsent = true;
      const list = read.value === undefined ? undefined : asList(read.value);
      if (list === undefined && read.value !== undefined) bad(name, 'a list of {next_id, items}');
      const past = Math.max(await this.historyMax(fs, name), list === undefined ? rawMax(read.raw) : 0) + 1;
      held.lists[name] = list === undefined ? { next_id: past, items: [] } : { ...list, next_id: Math.max(list.next_id, past) };
    }
    for (const name of TEXTS) {
      const read = await readJson(name);
      if (read.value === undefined) continue;
      const text = asText(read.value);
      if (text !== undefined) held[name] = text;
      else bad(name, 'a {text}');
    }
    const read = await readJson('storage');
    if (read.value !== undefined) {
      const entries = asStorage(read.value);
      if (entries !== undefined) held.storage = entries;
      else bad('storage', 'a list of {name, description}');
    }
    const counted = await readJson('rounds'), sent = typeof counted.value === 'object' && counted.value !== null ? (counted.value as Record<string, unknown>).rounds : undefined;
    if (counted.value !== undefined && !isInt(sent) && sent !== 0) bad('rounds', 'a {rounds}');
    const rounds = Math.max(isInt(sent) ? sent : 0, ...LISTS.flatMap((name) => held.lists[name].items.map((item) => item.round ?? 0))); // never behind an item's own round
    if (rounds > 0) held.rounds = rounds;
    return { held, problems };
  }

  /** The highest number a list's history holds, 0 when it holds none or cannot be read: a list whose live file is missing, stale or unreadable never reuses a number that left. */
  private async historyMax(fs: Fs, name: ListName): Promise<number> {
    const text = await fs.read(`${this.root}/${historyFile(name)}`).catch(() => '');
    return text.split('\n').reduce((max, line) => {
      try {
        const id = (JSON.parse(line) as { id?: unknown }).id;
        return isInt(id) ? Math.max(max, id) : max;
      } catch {
        return max;
      }
    }, 0);
  }

  /** A list or text a call changed: its live file is due, and each value that left is due in its history. */
  changed(key: FileKey, left: readonly Left[] | readonly string[] = []): void {
    this.dirty.add(key);
    if (key === 'storage' || key === 'rounds' || left.length === 0) return;
    const lines = left.map((l) => JSON.stringify(typeof l === 'string' ? { text: l } : l));
    const file = historyFile(key);
    this.history.set(file, [...(this.history.get(file) ?? []), ...lines]);
  }

  /** Whether anything still waits to be written. */
  get due(): boolean {
    return this.dirty.size + this.history.size + this.storage.length > 0;
  }

  /** The newest value still queued for `name` (written by this call, or held by a failed write): what the folder will hold. */
  queuedStorage(name: string): string | undefined {
    return this.storage.findLast((op) => op.kind === 'write' && op.name === name)?.text;
  }

  /** A storage value to write; `old`, the value it replaces or that leaves, is copied to `history/storage/` first. */
  queueStorage(name: string, text: string | undefined, old: string | undefined): void {
    if (old !== undefined) this.storage.push({ kind: 'save', name, text: old });
    if (text !== undefined) this.storage.push({ kind: 'write', name, text });
  }

  /**
   * Writes everything due: storage values (a write held back while the save before it for the same name fails), the
   * history lines, then the live files changed (an unreadable one's old text first copied to `history/unreadable/`,
   * once): what left is in its history before the live file that no longer holds it is written, which waits while that
   * append fails.
   * What fails stays due for the next flush; each failure is returned, never thrown.
   */
  async flush(fs: Fs, held: Held): Promise<FileProblem[]> {
    const problems: FileProblem[] = [];
    const blocked = new Set<string>(), unsaved = new Set<string>();
    for (const op of [...this.storage]) {
      const file = op.kind === 'save' ? `history/${STORAGE_DIR}/${op.name}` : `${STORAGE_DIR}/${op.name}`;
      if (blocked.has(op.name)) continue;
      try {
        await fs.write(op.kind === 'save' ? await freeName(fs, `${this.root}/history/${STORAGE_DIR}`, op.name) : `${this.root}/${file}`, op.text);
        this.storage.splice(this.storage.indexOf(op), 1);
      } catch (error) {
        problems.push({ file, error: message(error) });
        blocked.add(op.name);
      }
    }
    for (const [file, lines] of [...this.history]) {
      try {
        const old = await fs.read(`${this.root}/${file}`).catch((error: unknown) => {
          if (absent(error)) return '';
          throw error;
        });
        await fs.write(`${this.root}/${file}`, `${old}${old === '' || old.endsWith('\n') ? '' : '\n'}${lines.join('\n')}\n`);
        this.history.delete(file);
      } catch (error) {
        problems.push({ file, error: message(error) });
        unsaved.add(file);
      }
    }
    for (const key of [...this.dirty]) {
      const file = LIVE_FILE[key];
      if (key !== 'storage' && key !== 'rounds' && unsaved.has(historyFile(key))) continue; // its live file waits for its history: what left is never only in memory and gone from disk
      try {
        if (this.unreadable.has(key)) {
          const old = await fs.read(`${this.root}/${file}`).catch(() => undefined);
          if (old !== undefined) (await fs.write(await freeName(fs, `${this.root}/history/unreadable`, file.split('/').at(-1)!), old), this.unreadable.delete(key)); // copied once, whatever the write below does
        }
        const value = key === 'storage' ? held.storage : key === 'rounds' ? { rounds: held.rounds ?? 0 } : (TEXTS as readonly string[]).includes(key) ? { text: held[key as TextName] ?? '' } : held.lists[key as ListName];
        await fs.write(`${this.root}/${file}`, `${JSON.stringify(value, null, 2)}\n`);
        this.dirty.delete(key), this.unreadable.delete(key);
      } catch (error) {
        problems.push({ file, error: message(error) });
      }
    }
    return problems;
  }
}

/** A party's files and its held frontier from them; with no orders file yet, the previous build's remembered orders (`kept`, read only then; orders.ts `keptOrders`) become its first numbered orders, due to be written. */
export async function loadParty(fs: Fs, root: string, kept: () => Promise<readonly string[]>): Promise<{ files: PartyFiles; held: Held; problems: FileProblem[] }> {
  const files = new PartyFiles(root);
  const { held, problems } = await files.load(fs);
  const orders = files.ordersAbsent ? await kept() : [];
  if (orders.length > 0) (held.lists.orders = listApply('orders', held.lists.orders, { add: [...orders] }, held.rounds).list), files.changed('orders');
  return { files, held, problems };
}

/** The result's line for a party with no files (HOME unknown, or its folder could not be named): nothing it sends reaches the disk. */
export const NO_FOLDER = 'Not saved to disk: this run has no folder for your frontier; it is held in memory only, and a restart begins it again.';

/** The result's line for a file not written: the list, text or storage entry it keeps, and the error with the whole path of a list's, text's or history file taken out (the model is not shown where they live); a storage file's path keeps its place in the party's folder. */
export function notSaved(problem: FileProblem, root: string): string {
  const name = problem.file.replace(/^(data|history)\//, '').replace(/\.jsonl?$/, '');
  const what = problem.file.startsWith('history/storage/') ? `the earlier value of ${name.replace(/^storage\//, '')}` : problem.file.startsWith('history/') ? `what left ${name}` : name;
  const inFolder = problem.error.split(root);
  const error = problem.file.startsWith(`${STORAGE_DIR}/`) ? inFolder.join('…') : inFolder.map((part, i) => (i === 0 ? part : part.replace(/^[^\s'"`:,;)]*/, ''))).join('…');
  return `Not saved to disk yet: ${what} (${error}); it is held and saved again at your next call.`;
}
