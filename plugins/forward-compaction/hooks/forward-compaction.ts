import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';
import { bounded, unlessAborted } from '../src/bounded.ts';
import { FORWARD_INPUT_SCHEMA, FORWARD_TOOL, FORWARD_TOOL_DESCRIPTION } from '../src/handoff.ts';
import { LOOK_BACK_TOOL, LOOK_BACK_DESCRIPTION, LOOK_BACK_INPUT_SCHEMA, parseLookBack, boundaryArgv, boundaryLine, searchArgv, entryArgv, namesArgv, processOutput, parseEntries, toolNames, resultIds, searchResults, entryResult, manualTranscriptCall, lookBackNotice, findTranscriptArgv, firstFound, type LookBackResult } from '../src/look-back.ts';
import { sessionLogPath, runCwd, noticeOnScreen, decisionAppendArgv, retentionArgv, requeueRows, keptRowsText, endReport, SkipFold, pluginLogDir, levelRow, pluginLogEvent, PluginLogQueue, type PluginLogLevel, type PluginLogFields } from '../src/log.ts';
import { resolveOptions, type OptionEnvironment, type ResolvedOptions } from '../src/options.ts';
import { toolsToRegister, type ToolKind } from '../src/register.ts';

// Thin adapter: every decision lives in src/. Each hook catches its own
// failures, logs them with context and lets the compaction through.

/** Registering the tools holds a turn no longer than this: past it the turn goes on and the plugin stops waiting on registration. */
const ENSURE_TOOLS_TIMEOUT_MS = 5_000;
/** Of session.end's one bound, the share left for Claude Code's own end step after the log writes. */
const END_CORE_RESERVE_MS = 300;
/** Registering a tool is tried on this many hook calls before it is given up on. */
const REGISTER_TRIES = 3;
/** Rows held back while the environment layer is still being read; later ones are dropped. */
const PENDING_BEFORE_CONFIG = 500;

type Row = Record<string, unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type State = {
  config: ResolvedOptions;
  /** The names of the options handed to `register`: none is read, the environment is the only home of an option. */
  ignoredOptions: string[];
  pluginLog?: PluginLogQueue;
  pluginInitialized: boolean;
  pluginRows: Omit<PluginLogFields, 'plugin' | 'session'>[];
  pluginLogDir?: string;
  pluginWriting: Promise<void>;
  pluginFailing: boolean;
  started?: Promise<void>;
  /** True once `start` has applied the environment layer to `config`: before it, `config` holds the defaults alone. */
  configured?: boolean;
  /** The home directory, for the log directories. */
  home?: string;
  /** Each tool's full name once registered. */
  toolNames: Partial<Record<ToolKind, string>>;
  /** The Claude config directory, where transcripts are found. */
  configDir?: string;
  /** Cached session id for the transcript lookup; no process runs. */
  sessionId?: Promise<string>;
  /** How many times registering each tool was tried. */
  toolTries: Record<ToolKind, number>;
  /** The registration in progress: hooks that need a tool wait on it, so none registers twice. */
  registering?: Promise<void>;
  /** Registering the tools has not finished within ENSURE_TOOLS_TIMEOUT_MS: no hook waits on it until it settles, and a late finish still names the tools. */
  toolsAbandoned?: boolean;
  /** Every tool is registered or out of tries: no hook registers or sets a timer again. */
  toolsSettled?: boolean;
  warned: Set<string>;
  /** The log-write failures already shown: a log that cannot be written fails every flush the same way, and the person hears each failure once. */
  logFailures: Set<string>;
  pending: string[];
  /** Rows the decision append in flight carries; 0 when none is. */
  rowsWriting: number;
  /** Level-log rows queued or being written: what a cut end flush may lose from the level log. */
  levelRowsWriting: number;
  /** Routine skips fold into one `skips` row per streak. */
  skips: SkipFold;
  /** Old sessions' logs were cleaned up once this session (or tried). */
  retained?: boolean;
  /** Why the last decision append failed, while its rows wait in `pending`; cleared by the next append that succeeds. */
  writeError?: string;
  /** Rows the hold let go this session, and the failure that dropped the last of them: counted at session end. */
  rowsDropped?: { rows: number; error: string };
  logPath?: Promise<string | undefined>;
  /** Reading the session id failed: no row is written this session, so a routine line goes to the screen. */
  logOff?: boolean;
  writing: Promise<void>;
};

/** A line on the person's screen: Claude Code already names the plugin in front of it, so the line never names it again. */
function show($: EngineInterface, line: string): void {
  $.ui.log(screenLine(line));
}

function screenLine(line: string): string {
  return line.replace(/^forward-compaction: /, '');
}

/**
 * Every line said lands in the decision log as a `said` row; a routine one reaches the screen too while there is no
 * log to hold it. A line said with its diagnostic row is one level-log entry: the row's, at the level said.
 */
function say(st: State, $: EngineInterface, line: string, level: PluginLogLevel = 'error', row?: Row): void {
  const shown = noticeOnScreen({ level, decisionLog: !!st.config.logFile, pluginLog: st.pluginLog !== undefined, logOff: st.logOff || st.writeError !== undefined || st.pluginFailing });
  const diagnostic = row === undefined ? undefined : pluginLogEvent({ line: screenLine(line), ...row });
  plog(st, $, diagnostic !== undefined ? { ...diagnostic, level } : { level, event: 'said', msg: screenLine(line), where: 'hooks/forward-compaction.ts#say' });
  if (shown) show($, line);
  record(st, $, { event: 'said', line: screenLine(line), shown });
  if (row !== undefined) record(st, $, row, diagnostic === undefined);
}

/** Level logging is off the work path; failures report through show, never recursively through say. */
function plog(st: State, $: EngineInterface, fields: Omit<PluginLogFields, 'plugin' | 'session'>): void {
  const queue = st.pluginLog;
  if (queue === undefined) { if (!st.pluginInitialized) st.pluginRows.push(fields); return; }
  let rows = 1;
  st.levelRowsWriting += rows;
  st.pluginWriting = st.pluginWriting.then(async () => {
    let session: string | undefined;
    let sessionError: string | undefined;
    try { session = await $.session.id(); }
    catch (error) { sessionError = `forward-compaction: reading the plugin log session id failed: ${message(error)}; row has no session`; }
    const now = await $.clock.now();
    if (sessionError !== undefined) {
      rows++;
      st.levelRowsWriting++;
      queue.add(levelRow({ plugin: 'forward-compaction', level: 'error', event: 'plugin-log-session-error', msg: screenLine(sessionError), where: 'hooks/forward-compaction.ts#plog' }, now));
      show($, sessionError);
    }
    queue.add(levelRow({ plugin: 'forward-compaction', ...fields, ...(session ? { session } : {}) }, now));
    const out = await queue.flush((argv) => $.process.run(argv, { ...runCwd(st.pluginLogDir ?? ''), timeoutMs: 15_000 }));
    if (out.error !== undefined && !st.pluginFailing) pluginLogFailed(st, $, out.error, out.dropped);
    st.pluginFailing = out.dropped !== 0;
  }).catch((error) => {
    if (!st.pluginFailing) pluginLogFailed(st, $, message(error), rows);
    st.pluginFailing = true;
  }).finally(() => { st.levelRowsWriting -= rows; });
}

/** Once per failing streak: on the screen and in the decision log, whose row maps to no level, so it never recurses into the failing log. */
function pluginLogFailed(st: State, $: EngineInterface, error: string, dropped: number): void {
  show($, `forward-compaction: plugin log ${st.pluginLogDir} failed: ${error}; dropped ${dropped} ${dropped === 1 ? 'row' : 'rows'}`);
  record(st, $, { event: 'plugin-log-failed', dir: st.pluginLogDir ?? null, error, dropped });
}

// Rows queue in memory; each flush appends them to the session's file through the append script, under its
// lock, so a resumed session keeps its earlier rows, no row is rewritten and no other chat shares the file.
function record(st: State, $: EngineInterface, row: Row, levelRow = true): void {
  const diagnostic = levelRow ? pluginLogEvent(row) : undefined;
  if (diagnostic !== undefined) plog(st, $, diagnostic);
  // The decision log's file may come from the environment, which `start` reads: a row before that waits, so the
  // session's one file is chosen from the full config. `settleConfig` writes what waited.
  if (!st.configured) {
    for (const out of st.skips.add({ ts: new Date().toISOString(), ...row })) if (st.pending.length < PENDING_BEFORE_CONFIG) st.pending.push(JSON.stringify(out));
    return;
  }
  if (!st.config.logFile) return;
  for (const out of st.skips.add({ ts: new Date().toISOString(), ...row })) st.pending.push(JSON.stringify(out));
  flushDecisions(st, $);
}

/** Marks the config as final and writes the rows that waited for it, or drops them when no decision log is on. */
function settleConfig(st: State, $: EngineInterface): void {
  if (st.configured) return;
  st.configured = true;
  if (!st.config.logFile) {
    st.pending.length = 0;
    st.skips.drain();
  } else {
    for (const out of st.skips.drain()) if (st.pending.length < PENDING_BEFORE_CONFIG) st.pending.push(JSON.stringify(out));
    if (st.pending.length > 0) flushDecisions(st, $);
  }
}

/** `last`: the session-end flush, after which no write comes, so a failure promises none. */
function flushDecisions(st: State, $: EngineInterface, last = false): void {
  const file = st.config.logFile;
  if (!file) return;
  st.logPath ??= $.session.id().then(
    (id) => sessionLogPath(file, id),
    (error) => {
      // The level log is independent of the decision log that is off.
      st.logOff = true;
      const line = `forward-compaction: reading the session id failed: ${message(error)}; the decision log is off for this session`;
      plog(st, $, { level: 'error', event: 'decision-log-session-error', msg: screenLine(line), where: 'hooks/forward-compaction.ts#record', detail: { error: message(error) } });
      show($, line);
      return undefined;
    },
  );
  // Taken now: rows queued before a /clear go to the ending session's file even when they are written after startOver.
  const logPath = st.logPath;
  const pending = st.pending;
  // The failure line names the session's own file: the configured logFile is only its template (`decisions/.jsonl`).
  let named: string = file;
  st.writing = st.writing
    .then(async () => {
      const path = await logPath;
      if (path) named = path;
      const rows = pending.splice(0);
      if (!path || rows.length === 0) return;
      st.rowsWriting = rows.length;
      try {
        const out = await $.process.run(decisionAppendArgv(path), { ...runCwd(path), stdin: rows.map((line) => `${line}\n`).join(''), timeoutMs: 15_000 });
        if (out.exitCode !== 0) throw new Error(out.stderr.split('\n')[0]?.trim() || `the append script exited ${out.exitCode}`);
        st.writeError = undefined;
      } catch (error) {
        // The `$` of an abandoned dispatch (an interrupt, a rejected tool) aborts its run: the batch goes back to
        // the front of the queue and the next flush, under a live dispatch, writes it. A run rejected after its
        // child appended them writes them twice: a duplicate row, never a lost one; a child killed mid-row leaves a torn
        // line, and the append script starts the retried rows on a line of their own.
        st.writeError = message(error);
        const dropped = requeueRows(pending, rows);
        if (dropped > 0) st.rowsDropped = { rows: (st.rowsDropped?.rows ?? 0) + dropped, error: message(error) };
        throw new DecisionWriteError(message(error), rows.length, dropped);
      }
      // Written: no longer in flight while the cleanup runs.
      st.rowsWriting = 0;
      // Once per session, after its first rows are written: they never wait behind the cleanup.
      if (!st.retained) {
        st.retained = true;
        await retainLogs(st, $, file, path);
      }
    })
    .finally(() => { st.rowsWriting = 0; })
    // Screen and level log only, once per distinct failure: never queue another decision write. The key drops
    // numbers, so one failure whose text carries a varying size or offset is still shown once.
    .catch((error) => {
      const kept = error instanceof DecisionWriteError ? keptRowsText(error.rows, error.dropped, last) : '';
      const failed = `forward-compaction: writing the decision log for ${named} failed: ${message(error)}`;
      const line = `${failed}${kept}`;
      // The first drop past the hold is told even when its failure already was; the session-end line counts them all.
      const key = `${failed}${error instanceof DecisionWriteError && error.dropped > 0 ? ' (hold)' : ''}`.replace(/\d+/g, '#');
      if (st.logFailures.has(key)) return;
      st.logFailures.add(key);
      plog(st, $, { level: 'error', event: 'decision-log-write-error', msg: screenLine(line), where: 'hooks/forward-compaction.ts#record', detail: { error: message(error) } });
      show($, line);
    });
}

/** A failed append whose rows went back to the queue: how many, and how many old ones the hold let go. */
class DecisionWriteError extends Error {
  constructor(cause: string, readonly rows: number, readonly dropped: number) {
    super(cause);
  }
}

/** Once per session, after its first append: old sessions' logs beside this one go; a failure is told once, in both logs, and the log goes on. */
async function retainLogs(st: State, $: EngineInterface, file: string, path: string): Promise<void> {
  try {
    const out = await $.process.run(retentionArgv(file, path), { ...runCwd(file, path), timeoutMs: 15_000 });
    if (out.exitCode !== 0) throw new Error(out.stderr.split('\n')[0]?.trim() || `the retention script exited ${out.exitCode}`);
  } catch (error) {
    const line = `forward-compaction: cleaning up old decision logs beside ${path} failed: ${message(error)}; they stay`;
    say(st, $, line, 'warning', { event: 'decision-retention-failed', file, error: message(error), line: screenLine(line) });
  }
}

/** After a /clear or a resume: main's conversation is a new one, under a new session id and its own decision log file. */
function startOver(st: State): void {
  st.sessionId = undefined;
  st.logPath = undefined;
  st.pending = [];
  st.retained = false;
  st.writeError = undefined;
  st.rowsDropped = undefined;
}


function warnOnce(st: State, $: EngineInterface, key: string, line: string, level: PluginLogLevel = 'warning'): void {
  if (st.warned.has(key)) return;
  st.warned.add(key);
  say(st, $, line, level, { event: level === 'error' ? 'error' : 'warning', key, line });
}


/**
 * The environment variable of each option, by name. Claude Code reads only a name spelled as a string
 * literal, so each is written out twice here (the key and the call); a test holds them to `OPTION_ENV`.
 */
async function readOptionEnv($: EngineInterface): Promise<Pick<OptionEnvironment, 'vars' | 'readErrors'>> {
  const vars: Record<string, string> = {};
  const readErrors: string[] = [];
  const readOptionVar = async (name: string, get: () => Promise<string | undefined>): Promise<void> => {
    try {
      const value = await get();
      if (value !== undefined) vars[name] = value;
    } catch (error) {
      readErrors.push(`forward-compaction: reading ${name} failed: ${message(error)}; using the default`);
    }
  };
  await Promise.all([
    readOptionVar('FORWARD_COMPACTION_CEILING', () => $.env.get('FORWARD_COMPACTION_CEILING')),
    readOptionVar('FORWARD_COMPACTION_CEILING_NATIVE', () => $.env.get('FORWARD_COMPACTION_CEILING_NATIVE')),
    readOptionVar('FORWARD_COMPACTION_NUDGE_START', () => $.env.get('FORWARD_COMPACTION_NUDGE_START')),
    readOptionVar('FORWARD_COMPACTION_NUDGE_EVERY', () => $.env.get('FORWARD_COMPACTION_NUDGE_EVERY')),
    readOptionVar('FORWARD_COMPACTION_LOG_FILE', () => $.env.get('FORWARD_COMPACTION_LOG_FILE')),
  ]);
  return { vars, readErrors };
}

// First hook call: report option errors, find the log directories, and resolve the options.
function start(st: State, $: EngineInterface): Promise<void> {
  st.started ??= (async () => {
    const early: { line: string; level: PluginLogLevel }[] = [];
    let home: string | undefined;
    try {
      home = await $.env.get('HOME');
      st.home = home;
    } catch (error) {
      early.push({ line: `forward-compaction: reading HOME failed: ${message(error)}; the logs have no home directory`, level: 'error' });
    }
    let override: string | undefined;
    try {
      override = await $.env.get('PLUGIN_LOG_DIR');
    } catch (error) {
      early.push({ line: `forward-compaction: reading PLUGIN_LOG_DIR failed: ${message(error)}; using HOME fallback`, level: 'warning' });
    }
    st.pluginInitialized = true;
    st.pluginLogDir = pluginLogDir(override, home, 'forward-compaction');
    if (st.pluginLogDir !== undefined) st.pluginLog = new PluginLogQueue(st.pluginLogDir, 'forward-compaction');
    else show($, 'plugin log off: no PLUGIN_LOG_DIR and no HOME');
    const earlyRows = st.pluginRows.splice(0);
    if (st.pluginLog !== undefined) for (const fields of earlyRows) plog(st, $, fields);
    st.config = resolveOptions({ pluginLogDir: override, home, ...(await readOptionEnv($)) });
    settleConfig(st, $);
    for (const { line, level } of early) say(st, $, line, level);
    for (const line of st.config.errors) {
      say(st, $, line, 'error', { event: 'option-error', line });
    }
    if (st.ignoredOptions.length > 0) {
      const line = `forward-compaction: options ${st.ignoredOptions.join(', ')} are not read; set FORWARD_COMPACTION_* environment variables instead (README, Options); their values are not applied`;
      warnOnce(st, $, 'options-ignored', line, 'error');
    }
    try {
      st.configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : undefined);
    } catch (error) {
      say(st, $, `forward-compaction: reading CLAUDE_CONFIG_DIR failed: ${message(error)}; look_back reads ~/.claude only`, 'warning');
      st.configDir = home ? `${home}/.claude` : undefined;
    }
    record(st, $, { event: 'start', ceiling: st.config.ceiling, ceilingNative: st.config.ceilingNative, nudgeStart: st.config.nudgeStart, nudgeEvery: st.config.nudgeEvery });
  })().finally(() => settleConfig(st, $));
  return st.started;
}

/** Keys the tool.call event carries beside the tool's arguments. */
const EVENT_KEYS = new Set(['tool', 'tool_use_id', 'agentId']);

/** The arguments of a tool call: every key of the event but its own (a key that is not a field included, so the check names it) or, when none is there, the event's `input`. */
function toolInput(e: Record<string, unknown>): Record<string, unknown> {
  const top: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(e)) if (!EVENT_KEYS.has(key) && key !== 'input' && value !== undefined) top[key] = value;
  if (Object.keys(top).length > 0) return top;
  const nested = e.input;
  return nested !== null && typeof nested === 'object' && !Array.isArray(nested) ? (nested as Record<string, unknown>) : {};
}

const TOOLS = {
  forward_compaction: { name: FORWARD_TOOL, description: FORWARD_TOOL_DESCRIPTION, inputSchema: FORWARD_INPUT_SCHEMA, isDeferred: false, lost: 'no party can hand off' },
  look_back: { name: LOOK_BACK_TOOL, description: LOOK_BACK_DESCRIPTION, inputSchema: LOOK_BACK_INPUT_SCHEMA, lost: 'transcript recovery is unavailable' },
} as const;

async function registerTool(st: State, $: EngineInterface, kind: ToolKind): Promise<void> {
  const { lost, ...spec } = TOOLS[kind];
  try {
    const { tool } = await $.tool.register(spec);
    st.toolNames[kind] = tool;
    record(st, $, { event: 'tool-registered', tool });
  } catch (error) {
    warnOnce(st, $, `register-failed:${kind}`, `forward-compaction: registering the ${spec.name} tool failed: ${message(error)}; ${lost}`, 'error');
    record(st, $, { event: 'tool-register-failed', tool: spec.name, error: message(error), tries: st.toolTries[kind] });
  }
}

async function answerLookBackTool(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined;
  const party = agentId ?? 'main';
  const args = parseLookBack(toolInput(e));
  const label = agentId ?? 'main';
  let boundary: number | null = null;
  let result: LookBackResult;
  try {
    await start(st, $);
    if (st.configDir === undefined) throw new Error('no Claude config directory');
    const session = await (st.sessionId ??= $.session.id());
    const found = processOutput(await $.process.run(findTranscriptArgv({ configDir: st.configDir, session, ...(agentId !== undefined ? { agentId } : {}) }), { ...runCwd(st.configDir), timeoutMs: 15_000 }), 'transcript lookup');
    const file = firstFound(found);
    if (file === undefined) throw new Error(`no transcript file for ${agentId === undefined ? `session ${session}` : `agent ${agentId}`}`);
    const bounds = processOutput(await $.process.run(boundaryArgv(file), { ...runCwd(file), timeoutMs: 15_000 }), 'compaction boundary', true);
    boundary = boundaryLine(bounds) ?? null;
    // Before any argument check: with nothing compacted there is no earlier transcript, whatever was asked.
    if (boundary === null) result = { text: 'Nothing has been compacted yet, so everything is still in context.', hits: 0 };
    else if (args.error) result = { text: `Look back failed: ${args.error}`, error: args.error, input: true };
    else if (args.entry !== undefined && args.entry >= boundary) result = entryResult([], args.entry, boundary);
    else {
      const argv = args.entry !== undefined ? entryArgv(file, args.entry) : searchArgv(file, boundary, args.terms);
      const raw = boundary === 1 ? '' : processOutput(await $.process.run(argv, { ...runCwd(file), timeoutMs: 30_000 }), args.entry !== undefined ? 'entry fetch' : 'transcript search', true);
      const entries = parseEntries(raw).filter((entry) => entry.line < boundary!);
      let names = toolNames(entries);
      const ids = resultIds(entries).filter((id) => !Object.hasOwn(names, id));
      if (ids.length > 0) {
        const uses = processOutput(await $.process.run(namesArgv(file, boundary, ids), { ...runCwd(file), timeoutMs: 30_000 }), 'tool name lookup', true);
        names = { ...names, ...toolNames(parseEntries(uses).filter((entry) => entry.line < boundary!)) };
      }
      result = args.entry !== undefined ? entryResult(entries, args.entry, boundary, names) : searchResults(entries, args.terms, boundary, names, st.toolNames.forward_compaction);
    }
  } catch (error) {
    const reason = message(error);
    result = { text: `Look back failed: ${reason}`, error: reason };
  }
  record(st, $, { event: 'look-back', party, ...(args.query !== undefined ? { query: args.query } : {}), ...(args.entry !== undefined ? { entry: args.entry } : {}), ...(result.hits !== undefined ? { hits: result.hits } : {}), boundary, ...(result.error !== undefined ? { error: result.error } : {}) });
  // A failure the caller's input caused is a warning; only the plugin's own fault is an error.
  say(st, $, lookBackNotice(label, args, result), result.error === undefined ? 'info' : result.input ? 'warning' : 'error');
  return result.text;
}

/** Observation never rejects, rewrites or starts a process for an ordinary tool call. */
async function observeManualLookBack(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<void> {
  const tool = typeof e.tool === 'string' ? e.tool : '';
  if (!['Read', 'Grep', 'Bash'].includes(tool)) return;
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined;
  const party = agentId ?? 'main';
  try {
    const session = agentId === undefined ? await (st.sessionId ??= $.session.id()) : '';
    if (!manualTranscriptCall(tool, toolInput(e), session, agentId)) return;
    record(st, $, { event: 'look-back-manual', party, tool });
    say(st, $, `look back by hand (${party}): ${tool} on the transcript`, 'info');
  } catch (error) {
    say(st, $, `forward-compaction: observing manual transcript lookup of ${party} via ${tool} failed: ${message(error)}`, 'error', { event: 'look-back-manual-error', party, tool, error: message(error) });
  }
}


/**
 * `$.clock.after`, or, where the engine has none, a timer that never fires and a warning once: the wait is then unbounded, as it was.
 * A call a hook refuses without throwing never fires either and is not reported: that wait is unbounded too.
 */
function afterOrNever(st: State, $: EngineInterface, ms: number, fn: () => void, what: string): { cancel: () => void } {
  try {
    return $.clock.after(ms, fn);
  } catch (error) {
    warnOnce(st, $, `no-clock:${what}`, `forward-compaction: $.clock.after is unavailable (${message(error)}); ${what} is not time-bounded`, 'error');
    return { cancel: () => {} };
  }
}

/**
 * Registers each tool that is not registered yet, up to REGISTER_TRIES
 * hook calls each: `session.start` may not fire (a plugin loaded mid-session)
 * or may run before the session can take a tool. Hooks that need a tool wait on it.
 */
async function ensureTools(st: State, $: EngineInterface, signal?: AbortSignal): Promise<void> {
  if (st.toolsAbandoned || st.toolsSettled) return;
  const left = () =>
    toolsToRegister(
      { forward_compaction: true, look_back: true },
      { forward_compaction: st.toolNames.forward_compaction !== undefined, look_back: st.toolNames.look_back !== undefined },
      st.toolTries,
      REGISTER_TRIES,
    );
  const began = Date.now();
  const names = () => Object.values(st.toolNames);
  const had = new Set(names());
  const registered = (async () => {
    await start(st, $);
    st.registering = (st.registering ?? Promise.resolve())
      .then(async () => {
        for (const kind of left()) {
          st.toolTries[kind]++;
          await registerTool(st, $, kind);
        }
      })
      .catch((error) => say(st, $, `forward-compaction: registering the tools failed: ${message(error)}`));
    await st.registering;
    if (left().length === 0) st.toolsSettled = true;
  })();
  // A hang here would hold every turn of every chat: past the limit the turn goes on, and the person is told.
  // The dispatch's abort ends the wait too: its timer may never fire, and a hook that waits on past its abort starves the hooks worker.
  const outcome = await bounded(registered, ENSURE_TOOLS_TIMEOUT_MS, (ms, fn) => afterOrNever(st, $, ms, fn, 'registering the tools'), signal);
  if (!outcome.timedOut) return;
  st.toolsAbandoned = true;
  // Once the slow registration settles, a later hook spends the tries left, and the late finish is told with the tools it named.
  const resume = () => void (st.toolsAbandoned = false);
  void registered.then(() => {
    resume();
    const ms = Date.now() - began;
    // The tools this attempt registered, never an earlier one's; none is said as such, with the tries left still to come.
    const tools = names().filter((name) => !had.has(name));
    say(st, $, `forward-compaction: registering the tools finished after ${Math.round(ms / 1000)}s: ${tools.length > 0 ? tools.join(', ') : 'it registered none'}`, 'info', { event: 'tools-late', ms, tools });
  }, resume);
  // An interrupted wait is no slow registration: nothing to tell.
  if (outcome.aborted) return;
  warnOnce(st, $, 'tools-timeout', `forward-compaction: registering the tools did not finish within ${ENSURE_TOOLS_TIMEOUT_MS / 1000}s; it goes on, turns do not wait for it, and the tools come into use once it finishes`);
}

export const register: Register = (on: On, options: PluginOptions) => {
  const st: State = {
    config: resolveOptions(),
    ignoredOptions: options !== null && typeof options === 'object' ? Object.keys(options) : [],
    pluginRows: [],
    pluginInitialized: false,
    pluginWriting: Promise.resolve(),
    pluginFailing: false,
    toolNames: {},
    toolTries: { forward_compaction: 0, look_back: 0 },
    warned: new Set(),
    logFailures: new Set(),
    pending: [],
    rowsWriting: 0,
    levelRowsWriting: 0,
    skips: new SkipFold(),
    writing: Promise.resolve(),
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await ensureTools(st, $, next.signal);
    return result;
  });

  on('tool.call', async ($, e, next) => {
    if (st.toolNames.look_back !== undefined && e.tool === st.toolNames.look_back) return { result: await answerLookBackTool(st, $, e as Record<string, unknown>) };
    await unlessAborted(observeManualLookBack(st, $, e as Record<string, unknown>), next.signal);
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    // A /clear or a resume ends the conversation, and the process goes on under a new session id with no session.start.
    const goesOn = e.reason === 'clear' || e.reason === 'resume';
    if (goesOn) record(st, $, { event: 'cleared', party: 'main', reason: e.reason });
    // The open skip streaks close now, and the session ends only once every queued row is written.
    if (st.config.logFile) {
      for (const out of st.skips.drain()) st.pending.push(JSON.stringify(out));
      flushDecisions(st, $, true);
    }
    // The whole end chain shares one short bound: the writes get what it leaves less core's share, and the conversation
    // starts over either way. A write queued while the end waits (a cleanup failure said) is waited for too.
    const settled = async (): Promise<void> => {
      for (;;) {
        const writing = st.writing, plugin = st.pluginWriting;
        await Promise.all([writing, plugin]);
        if (writing === st.writing && plugin === st.pluginWriting) return;
      }
    };
    const left = next.budget?.remainingMs ?? Infinity;
    const outcome = Number.isFinite(left) ? await bounded(settled(), Math.max(0, left - END_CORE_RESERVE_MS), (ms, fn) => afterOrNever(st, $, ms, fn, 'the session-end log flush'), next.signal) : (await settled(), { timedOut: false as const });
    const report = endReport({
      timedOut: outcome.timedOut, boundMs: next.budget?.ms ?? left, decisionRows: st.pending.length + st.rowsWriting, levelRows: st.levelRowsWriting,
      held: st.config.logFile && st.writeError !== undefined ? st.pending.length : 0, dropped: st.config.logFile ? st.rowsDropped?.rows ?? 0 : 0,
      error: st.writeError ?? st.rowsDropped?.error ?? 'unknown', // a cut chain may hold the path's own lookup: it is awaited only once settled, or once an append ran
      path: !st.config.logFile ? '' : !outcome.timedOut || st.rowsDropped !== undefined ? (await st.logPath) ?? st.config.logFile : st.config.logFile,
    });
    if (report.cut !== undefined) show($, report.cut);
    if (report.lost !== undefined) {
      // The rows a failing append kept have no later flush, and the hold's drops were told only once: they are lost, and said so, never silently.
      const { line, rows, dropped, error } = report.lost;
      plog(st, $, { level: 'error', event: 'decision-log-rows-lost', msg: screenLine(line), where: 'hooks/forward-compaction.ts#session.end', detail: { rows, dropped, error } });
      show($, line);
      // The level row is the record of the loss: the end waits for it, within what the bound leaves.
      const rest = next.budget?.remainingMs ?? Infinity;
      if (Number.isFinite(rest)) await bounded(st.pluginWriting, Math.max(0, rest - END_CORE_RESERVE_MS), (ms, fn) => afterOrNever(st, $, ms, fn, 'the session-end log flush'), next.signal);
      else await st.pluginWriting;
    }
    if (goesOn) startOver(st);
    return next(e);
  });
};
