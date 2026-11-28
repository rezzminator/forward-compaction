// The files that keep one party's frontier across restarts, under
// `$HOME/.local/state/forward-compaction/{project}/{session id}/` (a sub-agent's under `agents/{agent id}/`):
// the live lists and texts, the storage listing and files, the count of compactions installed (`rounds.json`), the party's floor (`floor.json`), main's model switch (`model-switch.json`, model-switch.ts), the
// history every value that left is appended to, and `done-earlier.md`, the done items a wake names instead of showing, with
// `done-earlier.json`, the highest number that file holds.
// The plugin alone writes them, and deletes nothing. A file that cannot be written loses no change: it stays dirty
// in memory and the next call writes it again. Pure but for the file calls, which arrive as `Fs`.
import { doneFiled, doneSplit, emptyHeld, listApply, LISTS, TEXTS, type DoneWake, type Held, type Item, type Left, type List, type ListName, type StorageEntry, type TextName } from './lists';
import { switchRead } from './model-switch';

/** The file calls the adapter hands in: `$.fs.read`, `$.fs.write` (which creates directories) and `$.fs.exists`. The API has no append, move or delete. */
export type Fs = { read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<void>; exists: (path: string) => Promise<boolean> };

/** Where every session's folder lives, under the home directory. */
export const STATE_DIR = '.local/state/forward-compaction';
export type FileKey = ListName | TextName | 'storage' | 'rounds' | 'floor' | 'modelSwitch';
/** Each live file, relative to the party's folder. */
export const LIVE_FILE: Record<FileKey, string> = {
  orders: 'orders.json',
  ...(Object.fromEntries([...LISTS.filter((l) => l !== 'orders'), ...TEXTS].map((k) => [k, `data/${k}.json`])) as Record<Exclude<FileKey, 'orders' | 'storage' | 'rounds' | 'floor' | 'modelSwitch'>, string>),
  storage: 'storage.json',
  rounds: 'rounds.json',
  floor: 'floor.json',
  modelSwitch: 'model-switch.json',
};
/** A live file with a history, a list's or a text's: each value that left it is appended to `history/`; the others are written over. */
const hasHistory = (key: FileKey): key is ListName | TextName => key !== 'storage' && key !== 'rounds' && key !== 'floor' && key !== 'modelSwitch';
export const STORAGE_DIR = 'storage';
/** The done items a wake names instead of showing (lists.ts `doneSplit`), relative to the party's folder: beside storage.json, not in storage/ and no storage entry. */
export const DONE_EARLIER_FILE = 'done-earlier.md';
/** What done-earlier.md is recorded to hold, relative to the party's folder: `{through}`, the highest done number in it. Kept as data and never read back out of the file's text, so a restarted party's rewrite drops no item the file held. */
export const DONE_EARLIER_RECORD = 'done-earlier.json';
/** The two files of the done items a wake names: a failed write of either loses nothing, the wake then showing the whole done list. */
export const DONE_EARLIER_FILES: readonly string[] = [DONE_EARLIER_FILE, DONE_EARLIER_RECORD];
/** What a file that could not be read at load means for the party, as the line naming it ends. */
export const unreadMeans = (file: string): string => (file === DONE_EARLIER_RECORD ? `what ${DONE_EARLIER_FILE} held is unknown, so it holds every live done item until the party has read a wake that shows them` : 'it is shown empty and left as it is until a call changes it');
/** What done-earlier.md holds: each of its items whole as `[n] text`, oldest first, with no rounds tag and no date; with none, one line saying so. */
export const doneEarlierText = (earlier: readonly Item[]): string => (earlier.length === 0 ? 'No earlier done items: every live done item is in the wake.\n' : `${earlier.map((item) => `[${item.id}] ${item.text}`).join('\n')}\n`);
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
/** An item's `added` as the plugin writes it, an ISO 8601 UTC time; anything else is dropped at load. */
const isAdded = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));

/** A live list file's value, or undefined when it is not one. `next_id` is raised past every live number, so none is reused. */
function asList(v: unknown): List | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const { next_id, items } = v as Record<string, unknown>;
  if (!isInt(next_id) || !Array.isArray(items) || !items.every((i) => typeof i === 'object' && i !== null && isInt(i.id) && typeof i.text === 'string')) return undefined;
  const kept = items.map(({ id, text, round, added }) => ({ id: id as number, text: text as string, ...(isInt(round) ? { round } : {}), ...(isAdded(added) ? { added } : {}) }));
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
  /** What done-earlier.md is known to hold: the text last written, '' when it is known absent; undefined until it is written or checked, and after a write failed. */
  private doneEarlier?: string;
  /** `data/done.json` could not be read at load: done-earlier.md, written from the list it held, is copied to `history/unreadable/` before the first write over it. */
  private doneEarlierUnread = false;
  /** The highest done number done-earlier.md holds, 0 with none: a rewrite keeps every live item up to it (lists.ts `doneFiled`). Infinity while its record could not be read: the file then holds every live done item. */
  private doneThrough = 0;
  /** What `DONE_EARLIER_RECORD` says on disk, 0 with no such file; undefined when it could not be read, and after a write of it failed. */
  private doneRecorded: number | undefined = 0;
  /** `DONE_EARLIER_RECORD` could not be read at load: its text is copied to `history/unreadable/` before the first write over it. */
  private doneRecordUnread = false;
  /** The wake last rendered: its frontier, and the highest done number it left to the file, 0 when it showed the whole list. */
  private doneRendered?: { frontier: string; through: number };
  /** The write of done-earlier.md and its record now running, which the next one waits for: two flushes at once (a call's, a reading's) never write the pair in mixed order. */
  private doneWriting: Promise<FileProblem | undefined> = Promise.resolve(undefined);

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
    this.doneEarlierUnread = this.unreadable.has('done');
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
    const floored = await readJson('floor'), kept = typeof floored.value === 'object' && floored.value !== null ? (floored.value as Record<string, unknown>) : undefined;
    if (!isInt(kept?.floor)) { if (floored.value !== undefined) bad('floor', 'a {floor}'); }
    else if (kept?.settled === true) held.floor = kept.floor; // one not settled (an install's first reading alone, as an earlier version kept every floor) is below the party's context: its next reading is its floor
    const switching = await readJson('modelSwitch'), switched = switching.value === undefined ? {} : switchRead(switching.value); // main's alone: no other party's folder holds one
    if (switched === undefined) bad('modelSwitch', 'a model switch');
    else if (switched.modelSwitch !== undefined) held.modelSwitch = switched.modelSwitch;
    const record = await this.doneRecordLoad(fs);
    if (record !== undefined) problems.push(record);
    return { held, problems };
  }

  /** What done-earlier.md is recorded to hold (`DONE_EARLIER_RECORD`). With no such file nothing was ever written: none held. One that cannot be read, or is no `{through}`, is never read as none: the file then holds every live done item, and the problem is returned. */
  private async doneRecordLoad(fs: Fs): Promise<FileProblem | undefined> {
    try {
      const through = (JSON.parse(await fs.read(`${this.root}/${DONE_EARLIER_RECORD}`)) as { through?: unknown } | null)?.through;
      if (!isInt(through) && through !== 0) throw new Error('not a {through}');
      this.doneThrough = this.doneRecorded = through;
    } catch (error) {
      if (absent(error)) return undefined;
      (this.doneThrough = Infinity), (this.doneRecorded = undefined), (this.doneRecordUnread = true);
      return { file: DONE_EARLIER_RECORD, error: message(error) };
    }
    return undefined;
  }

  /** A file's text copied to `history/unreadable/` under a free name, before the first write over it; false when it cannot be read, so there is nothing to keep. */
  private async keepUnreadable(fs: Fs, file: string): Promise<boolean> {
    const old = await fs.read(`${this.root}/${file}`).catch(() => undefined);
    if (old !== undefined) await fs.write(await freeName(fs, `${this.root}/history/unreadable`, file.split('/').at(-1)!), old);
    return old !== undefined;
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
    if (!hasHistory(key) || left.length === 0) return;
    const lines = left.map((l) => JSON.stringify(typeof l === 'string' ? { text: l } : l));
    const file = historyFile(key);
    this.history.set(file, [...(this.history.get(file) ?? []), ...lines]);
  }

  /** A wake's done list at `maxChars` (lists.ts `doneSplit`) with the file named, when done-earlier.md holds its earlier items (lists.ts `doneFiled`: it may hold later ones too); undefined, the whole list shown, when none is earlier or the file is not known to hold what it should (not yet written, or its write failed): nothing is lost. */
  doneWake(held: Held, maxChars: number): DoneWake | undefined {
    const done = held.lists.done.items, split = doneSplit(done, maxChars);
    return split.earlier.length > 0 && this.doneEarlier === doneEarlierText(doneFiled(done, maxChars, this.doneThrough)) ? { ...split, path: `${this.root}/${DONE_EARLIER_FILE}` } : undefined;
  }

  /** A wake rendered with `frontier`, its done list as `done` split it (undefined: the whole list shown). Noted only: rendered is not yet read by the party (`doneReached`). */
  wakeRendered(frontier: string, done: DoneWake | undefined): void {
    this.doneRendered = { frontier, through: done?.earlier.at(-1)?.id ?? 0 };
  }

  /**
   * The party's transcript holds the wake last rendered (`held` answers for its frontier): it has read every done item that
   * wake showed, so done-earlier.md gives those up at the next flush and is the earlier items alone again. A render alone
   * drops nothing: the wake is handed to Claude Code, whose ask can be abandoned, and whose handling can fail after it.
   */
  doneReached(held: (frontier: string) => boolean): void {
    const wake = this.doneRendered;
    if (wake === undefined || !held(wake.frontier)) return;
    (this.doneThrough = Math.min(this.doneThrough, wake.through)), (this.doneRendered = undefined);
  }

  /**
   * done-earlier.md brought to what it holds at `maxChars` (lists.ts `doneFiled`): written when its text changed; with no
   * item, a file that exists rewritten to say so. Its record is written first when the file gains an item and last when it
   * gives one up, so the record never names less than the file holds. While the done list is unreadable both are left as
   * they are, like `data/done.json`, and the file's old text is copied to `history/unreadable/` before the first write over
   * it. A failure is returned, never thrown, and what failed is written again at the next flush.
   */
  private async doneEarlierWrite(fs: Fs, held: Held, maxChars: number): Promise<FileProblem | undefined> {
    if (this.unreadable.has('done')) return undefined; // the list shown empty is not the list the file was written from: no call changed done yet
    const filed = doneFiled(held.lists.done.items, maxChars, this.doneThrough), text = doneEarlierText(filed), through = filed.at(-1)?.id ?? 0, path = `${this.root}/${DONE_EARLIER_FILE}`;
    const written = this.doneEarlier === text || (filed.length === 0 && this.doneEarlier === '');
    if (written && this.doneRecorded === through) return undefined;
    let file = DONE_EARLIER_RECORD;
    try {
      if (this.doneRecorded === undefined || this.doneRecorded < through) await this.doneRecordWrite(fs, through);
      file = DONE_EARLIER_FILE;
      if (!written && filed.length === 0 && !(await fs.exists(path))) this.doneEarlier = '';
      else if (!written) {
        if (this.doneEarlierUnread) (await this.keepUnreadable(fs, DONE_EARLIER_FILE), (this.doneEarlierUnread = false)); // copied once, whatever the write below does
        await fs.write(path, text);
        this.doneEarlier = text;
      }
      (this.doneThrough = through), (file = DONE_EARLIER_RECORD);
      if (this.doneRecorded !== through) await this.doneRecordWrite(fs, through);
    } catch (error) {
      if (file === DONE_EARLIER_FILE) this.doneEarlier = undefined;
      return { file, error: message(error) };
    }
    return undefined;
  }

  /** `DONE_EARLIER_RECORD` set to `through`; what it says is unknown from the first write call until one lands. One that could not be read at load is copied to `history/unreadable/` first, once. */
  private async doneRecordWrite(fs: Fs, through: number): Promise<void> {
    this.doneRecorded = undefined;
    if (this.doneRecordUnread) (await this.keepUnreadable(fs, DONE_EARLIER_RECORD), (this.doneRecordUnread = false));
    await fs.write(`${this.root}/${DONE_EARLIER_RECORD}`, `${JSON.stringify({ through }, null, 2)}\n`);
    this.doneRecorded = through;
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
   * append fails. With `doneMaxChars`, done-earlier.md and its record last (`doneEarlierWrite`).
   * What fails stays due for the next flush; each failure is returned, never thrown.
   */
  async flush(fs: Fs, held: Held, doneMaxChars?: number): Promise<FileProblem[]> {
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
      if (hasHistory(key) && unsaved.has(historyFile(key))) continue; // its live file waits for its history: what left is never only in memory and gone from disk
      try {
        if (this.unreadable.has(key) && (await this.keepUnreadable(fs, file))) this.unreadable.delete(key); // copied once, whatever the write below does
        const value = key === 'storage' ? held.storage : key === 'rounds' ? { rounds: held.rounds ?? 0 } : key === 'floor' ? { floor: held.floor ?? null, settled: held.settling !== true } : key === 'modelSwitch' ? held.modelSwitch ?? {} : (TEXTS as readonly string[]).includes(key) ? { text: held[key as TextName] ?? '' } : held.lists[key as ListName];
        await fs.write(`${this.root}/${file}`, `${JSON.stringify(value, null, 2)}\n`);
        this.dirty.delete(key), this.unreadable.delete(key);
      } catch (error) {
        problems.push({ file, error: message(error) });
      }
    }
    if (doneMaxChars === undefined) return problems;
    const write = (): Promise<FileProblem | undefined> => this.doneEarlierWrite(fs, held, doneMaxChars), earlier = await (this.doneWriting = this.doneWriting.then(write, write));
    return earlier === undefined ? problems : [...problems, earlier];
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
