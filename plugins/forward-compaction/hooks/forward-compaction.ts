import type { EngineInterface, On, PluginOptions, Register, SessionCompactInput, SessionCompactResult, ToolCallResult, TurnStepInput, TurnStepResult, TurnCompleteInput, PromptSubmitInput, SessionReceiveInput, SkillPromptInput, AgentSpawnInput, AgentSpawnResult } from 'claude-code';
import { bounded, unlessAborted } from '../src/bounded.ts';
import { FORWARD_INPUT_SCHEMA, FORWARD_TOOL, FORWARD_TOOL_DESCRIPTION, parseHandoff, loadFileRefusal, receipt, parseLineRanges, sliceFile, type FileCheck, type LoadFile } from '../src/handoff.ts';
import { newLedger, markStart, addEntry, resolveSpawn, attributeSkill, factsFor, isPersonOrigin, type Ledger, type PartyKey } from '../src/ledger.ts';
import { splitAtCall, buildWake, mechanicalWake, landedLine, mechanicalLine, type WakeFile, type AgentRow } from '../src/wake.ts';
import { decide, turnEndDoor, estimateTokens, currentTokens, contextTokens, knownTrigger } from '../src/decide.ts';
import { nudgeLevel, nudgeText } from '../src/nudge.ts';
import { Parties } from '../src/parties.ts';
import { engineAskPoint, partyWindow, modelWindow, ceilingTokens, ENGINE_DEFAULT_WINDOW } from '../src/window.ts';
import { sizeTokens } from '../src/options.ts';
import { unseenCompaction } from '../src/unseen.ts';
import { LOOK_BACK_TOOL, LOOK_BACK_DESCRIPTION, LOOK_BACK_INPUT_SCHEMA, parseLookBack, boundaryArgv, boundaryLine, searchArgv, entryArgv, namesArgv, processOutput, parseEntries, toolNames, resultIds, searchResults, entryResult, manualTranscriptCall, lookBackNotice, findTranscriptArgv, firstFound, type LookBackResult } from '../src/look-back.ts';
import { sessionLogPath, runCwd, noticeOnScreen, decisionAppendArgv, retentionArgv, requeueRows, keptRowsText, endReport, SkipFold, pluginLogDir, levelRow, pluginLogEvent, PluginLogQueue, type PluginLogLevel, type PluginLogFields } from '../src/log.ts';
import { resolveOptions, type OptionEnvironment, type ResolvedOptions } from '../src/options.ts';
import { toolsToRegister, type ToolKind } from '../src/register.ts';

// Thin adapter: every decision lives in src/. Each hook catches its own failures, logs them with context and lets the compaction through.

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
  ignoredOptions: string[]; // The names of the options handed to `register`: none is read, the environment is the only home of an option.
  pluginLog?: PluginLogQueue;
  pluginInitialized: boolean;
  pluginRows: Omit<PluginLogFields, 'plugin' | 'session'>[];
  pluginLogDir?: string;
  pluginWriting: Promise<void>;
  pluginFailing: boolean;
  started?: Promise<void>;
  configured?: boolean; // True once `start` has applied the environment layer to `config`: before it, `config` holds the defaults alone.
  home?: string; // The home directory, for the log directories.
  toolNames: Partial<Record<ToolKind, string>>; // Each tool's full name once registered.
  configDir?: string; // The Claude config directory, where transcripts are found.
  sessionId?: Promise<string>; // Cached session id for the transcript lookup; no process runs.
  toolTries: Record<ToolKind, number>; // How many times registering each tool was tried.
  registering?: Promise<void>; // The registration in progress: hooks that need a tool wait on it, so none registers twice.
  toolsAbandoned?: boolean; // Registering the tools has not finished within ENSURE_TOOLS_TIMEOUT_MS: no hook waits on it until it settles, and a late finish still names the tools.
  toolsSettled?: boolean; // Every tool is registered or out of tries: no hook registers or sets a timer again.
  warned: Set<string>;
  logFailures: Set<string>; // The log-write failures already shown: a log that cannot be written fails every flush the same way, and the person hears each failure once.
  pending: string[];
  rowsWriting: number; // Rows the decision append in flight carries; 0 when none is.
  levelRowsWriting: number; // Level-log rows queued or being written: what a cut end flush may lose from the level log.
  skips: SkipFold; // Routine skips fold into one `skips` row per streak.
  retained?: boolean; // Old sessions' logs were cleaned up once this session (or tried).
  writeError?: string; // Why the last decision append failed, while its rows wait in `pending`; cleared by the next append that succeeds.
  rowsDropped?: { rows: number; error: string }; // Rows the hold let go this session, and the failure that dropped the last of them: counted at session end.
  logPath?: Promise<string | undefined>;
  logOff?: boolean; // Reading the session id failed: no row is written this session, so a routine line goes to the screen.
  writing: Promise<void>;
  parties: Parties;
  ledger: Ledger;
  inFlight: Map<string, { party: PartyKey; tool: string }>; // Skill and Agent calls running now, by tool_use_id: the party that made each, for skill attribution and a spawn's parent.
  pendingCommand?: string; // The command main typed, until its first step: a skill it expands is main's.
  pendingSpawns: Set<string>; // agent.spawn calls running now: a skill loaded meanwhile is a preload of the one spawn.
  knownAgents: Map<string, string>; // Sub-agents spawned here, id to type: an ask for any other agent id is the engine's own (C6).
  compactWindow?: number; // CLAUDE_CODE_AUTO_COMPACT_WINDOW, when set to a whole number.
  mainWindow: number; // Main's window, from `$.session.usage()`.
  installedSince: Set<string>; // Parties this plugin compacted since their last reading: a fall in that reading is no unseen compaction.
};

/** A line on the person's screen: Claude Code already names the plugin in front of it, so the line never names it again. */
function show($: EngineInterface, line: string): void {
  $.ui.log(screenLine(line));
}

function screenLine(line: string): string {
  return line.replace(/^forward-compaction: /, '');
}

/** Every line said lands in the decision log as a `said` row; a routine one reaches the screen too while there is no log to hold it. A line said with its diagnostic row is one level-log entry: the row's, at the level said. */
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

// Rows queue in memory; each flush appends them to the session's file through the append script, under its lock, so a resumed session keeps its earlier rows, no row is rewritten and no other chat shares the file.
function record(st: State, $: EngineInterface, row: Row, levelRow = true): void {
  const diagnostic = levelRow ? pluginLogEvent(row) : undefined;
  if (diagnostic !== undefined) plog(st, $, diagnostic);
  // The decision log's file may come from the environment, which `start` reads: a row before that waits, so the session's one file is chosen from the full config. `settleConfig` writes what waited.
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
        // The `$` of an abandoned dispatch (an interrupt, a rejected tool) aborts its run: the batch goes back to the front of the queue and the next flush, under a live dispatch, writes it. A run rejected after its child appended them writes them twice: a duplicate row, never a lost one; a child killed mid-row leaves a torn line, and the append script starts the retried rows on a line of their own.
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
    // Screen and level log only, once per distinct failure: never queue another decision write. The key drops numbers, so one failure whose text carries a varying size or offset is still shown once.
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


/** The environment variable of each option, by name. Claude Code reads only a name spelled as a string literal, so each is written out twice here (the key and the call); a test holds them to `OPTION_ENV`. */
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


/** `$.clock.after`, or, where the engine has none, a timer that never fires and a warning once: the wait is then unbounded, as it was. A call a hook refuses without throwing never fires either and is not reported: that wait is unbounded too. */
function afterOrNever(st: State, $: EngineInterface, ms: number, fn: () => void, what: string): { cancel: () => void } {
  try {
    return $.clock.after(ms, fn);
  } catch (error) {
    warnOnce(st, $, `no-clock:${what}`, `forward-compaction: $.clock.after is unavailable (${message(error)}); ${what} is not time-bounded`, 'error');
    return { cancel: () => {} };
  }
}

/** Registers each tool that is not registered yet, up to REGISTER_TRIES hook calls each: `session.start` may not fire (a plugin loaded mid-session) or may run before the session can take a tool. Hooks that need a tool wait on it. */
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
  // A hang here would hold every turn of every chat: past the limit the turn goes on, and the person is told. The dispatch's abort ends the wait too: its timer may never fire, and a hook that waits on past its abort starves the hooks worker.
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

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;
const keyOf = (agentId: unknown): PartyKey => (typeof agentId === 'string' && agentId !== '' ? `agent:${agentId}` : 'main');
const originKind = (origin: unknown): string => (origin !== null && typeof origin === 'object' && typeof (origin as { kind?: unknown }).kind === 'string' ? (origin as { kind: string }).kind : 'unknown');

/** A line the person always sees (a landed compaction, a dropped handoff, a fault the plugin worked around), and its row. */
function tell(st: State, $: EngineInterface, line: string, row: Row): void {
  show($, line);
  record(st, $, { ...row, line: screenLine(line) });
}

/** D9: a hook's own work never throws out of the plugin; a failure is said with the hook it came from, and the event goes on. */
async function guard(st: State, $: EngineInterface, where: string, work: () => unknown): Promise<void> {
  try {
    await work();
  } catch (error) {
    say(st, $, `forward-compaction: ${where} failed: ${message(error)}`, 'error', { event: 'hook-error', where, error: message(error) });
  }
}

/** A party's token marks, from its model's window: Claude Code's ask point, the ceiling, the nudge start and step. */
function marks(st: State, key: string): { askPoint: number; ceiling: number; start: number; every: number } {
  const win = st.parties.get(key).modelWin;
  return { askPoint: engineAskPoint(partyWindow(win, st.compactWindow)), ceiling: ceilingTokens(st.config.ceiling, win), start: sizeTokens(st.config.nudgeStart, win), every: sizeTokens(st.config.nudgeEvery, win) };
}

/** After a /clear or a resume: no party, fact or call of the old conversation carries into the new one. */
async function conversationStartsOver(st: State, $: EngineInterface, reason: string): Promise<void> {
  st.parties = new Parties(ENGINE_DEFAULT_WINDOW);
  st.parties.describe('main', { label: 'main', modelWin: st.mainWindow });
  st.ledger = markStart(newLedger(), await $.clock.now(), reason);
  st.inFlight.clear();
  st.pendingSpawns.clear();
  st.installedSince.clear();
  st.pendingCommand = undefined;
}

/** session.start: the ledger starts, main's window is read, and a compaction window that holds a sub-agent's handoff back is named once (R33). */
async function sessionBegins(st: State, $: EngineInterface): Promise<void> {
  st.ledger = markStart(st.ledger, await $.clock.now(), 'startup');
  try {
    const window = (await $.session.usage()).context.window;
    if (typeof window === 'number' && window > 0) st.mainWindow = window;
  } catch (error) {
    warnOnce(st, $, 'usage', `forward-compaction: reading main's context window failed: ${message(error)}; using ${k(st.mainWindow)}`);
  }
  st.parties.describe('main', { label: 'main', modelWin: st.mainWindow });
  const raw = (await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW'))?.trim() || undefined;
  const parsed = raw === undefined ? NaN : Number(raw);
  st.compactWindow = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
  const subagentAsk = engineAskPoint(partyWindow(ENGINE_DEFAULT_WINDOW, st.compactWindow));
  if ((st.compactWindow === undefined || st.compactWindow > 100_000) && !st.warned.has('compact-window')) {
    st.warned.add('compact-window');
    tell(st, $, `forward-compaction: CLAUDE_CODE_AUTO_COMPACT_WINDOW is ${raw ?? 'unset'}; Claude Code asks to compact a sub-agent only from about ${k(subagentAsk)}, so a sub-agent's handoff installs no earlier. Set it to 100000 in your settings env.`, { event: 'warning', key: 'compact-window' });
  }
  const { askPoint, ceiling } = marks(st, 'main');
  if (ceiling < askPoint && !st.warned.has('ceiling-below-ask')) {
    st.warned.add('ceiling-below-ask');
    tell(st, $, `forward-compaction: the ceiling ${k(ceiling)} is below Claude Code's ask point ${k(askPoint)}; a party with no handoff is compacted mechanically at its first ask.`, { event: 'warning', key: 'ceiling-below-ask' });
  }
}

/** ENOENT is a missing file; any other failure to stat is said as the error it is. */
async function statFile($: EngineInterface, path: string): Promise<FileCheck> {
  try {
    const stat = await $.fs.stat(path);
    return { kind: stat.kind, size: stat.size };
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'ENOENT' ? { absent: true } : { error: message(error) };
  }
}

/** The forward_compaction tool (R31): the handoff is checked, stored for the party, and answered with the receipt of its door. */
async function answerForward(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const key = keyOf(e.agentId);
  try {
    await start(st, $);
    const parsed = parseHandoff(toolInput(e));
    let refusal = 'refusal' in parsed ? parsed.refusal : undefined;
    if (!('refusal' in parsed)) for (const [index, file] of parsed.loadFiles.entries()) refusal ??= loadFileRefusal(index, file.path, await statFile($, file.path));
    if (refusal === undefined && typeof e.tool_use_id !== 'string') refusal = 'forward_compaction refused, nothing stored: the call has no tool_use_id, so the wake cannot find it.';
    if (refusal !== undefined || 'refusal' in parsed) {
      record(st, $, { event: 'refused', party: key, refusal });
      return refusal!;
    }
    const party = st.parties.get(key);
    const tokens = party.reading ?? 0;
    const replaced = st.parties.store(key, { text: parsed.handoff, loadFiles: parsed.loadFiles, toolUseId: e.tool_use_id as string, storedAtTokens: tokens })?.storedAtTokens;
    const files = parsed.loadFiles.length;
    record(st, $, { event: 'stored', party: key, chars: parsed.handoff.length, files, tokens, ...(replaced !== undefined ? { replaced } : {}) });
    return receipt({ party: key === 'main' ? 'main' : 'subagent', chars: parsed.handoff.length, files, tokens, askPoint: marks(st, key).askPoint, ...(replaced !== undefined ? { replaced } : {}) });
  } catch (error) {
    say(st, $, `forward-compaction: storing ${key}'s handoff failed: ${message(error)}`, 'error', { event: 'store-error', party: key, error: message(error) });
    return `forward_compaction failed, nothing stored: ${message(error)}`;
  }
}

/** Past a nudge point with nothing stored, the tool result carries the nudge once per level, and once more after a held ask (R37). */
async function nudged(st: State, $: EngineInterface, key: string, result: ToolCallResult): Promise<ToolCallResult> {
  if (result.deny !== undefined) return result;
  try {
    await start(st, $);
    const party = st.parties.get(key);
    if (party.reading === undefined) return result;
    const m = marks(st, key);
    const level = nudgeLevel(party.reading, m.start, m.every);
    if (level === 0 || !st.parties.nudgeDue(key, level)) return result;
    const now = party.askHeld || party.reading >= m.askPoint;
    record(st, $, { event: 'nudge', party: key, level, tokens: party.reading, wording: now ? 'now' : 'soon' });
    return { ...result, context: [...(result.context ?? []), nudgeText({ tokens: party.reading, askPoint: m.askPoint, ceiling: m.ceiling, asked: party.askHeld })] };
  } catch (error) {
    say(st, $, `forward-compaction: nudging ${key} failed: ${message(error)}`, 'error', { event: 'nudge-error', party: key, error: message(error) });
    return result;
  }
}

/** A sub-agent spawned here is ours; any other agent id the engine's own run, unless `$.agent.list` knows it. */
async function partyKind(st: State, $: EngineInterface, agentId: string): Promise<'subagent' | 'foreign'> {
  if (st.knownAgents.has(agentId)) return 'subagent';
  try {
    const agent = (await $.agent.list()).find((a) => a.id === agentId);
    if (agent === undefined) return 'foreign';
    st.knownAgents.set(agentId, agent.type);
    st.parties.describe(`agent:${agentId}`, { label: `${agent.type} ${agentId.slice(0, 6)}` });
    return 'subagent';
  } catch (error) {
    warnOnce(st, $, 'agent-list', `forward-compaction: listing agents failed: ${message(error)}; agent ${agentId} is handled as a sub-agent`);
    return 'subagent';
  }
}

/** A rejected list is the wake's own agents error; a list that is no list throws, and the ask falls to C11. */
async function agentRows($: EngineInterface): Promise<AgentRow[] | { error: string }> {
  const list = await $.agent.list().then((agents) => agents, (error: unknown) => ({ error: message(error) }));
  return 'error' in list ? list : list.map((a) => ({ id: a.id, type: a.type, status: a.status, description: a.description }));
}

/** Each load file read now, whole or by its lines; one that cannot be read is carried as its problem. */
async function readLoadFiles($: EngineInterface, files: readonly LoadFile[]): Promise<WakeFile[]> {
  return Promise.all(files.map(async (file): Promise<WakeFile> => {
    try {
      const sliced = sliceFile(await $.fs.read(file.path), file.lines === undefined ? undefined : parseLineRanges(file.lines));
      return 'body' in sliced ? { ...file, ...(sliced.shown ? { lines: sliced.shown } : {}), content: sliced.body } : { ...file, problem: sliced.problem };
    } catch (error) {
      return { ...file, problem: message(error) };
    }
  }));
}

/** A wake the engine took: the party's reading is the size after it, and its next fall is no unseen compaction. */
function installed(st: State, key: string, after: number, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  st.parties.installed(key, after);
  st.installedSince.add(key);
}

/** One session.compact ask, rows C1-C10: decide, then pass, hold, or install the handoff or a mechanical wake. */
async function compactAsk(st: State, $: EngineInterface, e: SessionCompactInput, key: PartyKey, pass: () => Promise<SessionCompactResult>, signal?: AbortSignal): Promise<SessionCompactResult> {
  await start(st, $);
  let trigger = knownTrigger(e.trigger);
  if (trigger === undefined) {
    warnOnce(st, $, `trigger:${String(e.trigger)}`, `forward-compaction: session.compact trigger ${String(e.trigger)} is unknown; it is handled as an automatic ask`);
    trigger = 'auto';
  }
  const kind = key === 'main' ? 'main' : await partyKind(st, $, e.agentId!);
  const party = st.parties.get(key);
  const { label, stored: held } = party;
  const found = held !== undefined && splitAtCall(e.messages, held.toolUseId) !== undefined;
  const tokens = currentTokens(party.reading, e.messages) ?? 0;
  const m = marks(st, key);
  const action = decide({ trigger, party: kind, stored: found, storedMissing: held !== undefined && !found, tokens, ceiling: m.ceiling, reactive: st.parties.reactive(key), ceilingNative: st.config.ceilingNative, label });
  const row: Row = { event: 'compact', party: key, trigger, decision: action.decision, why: action.why, tokens };
  if ('dropStored' in action && action.dropStored && held !== undefined) {
    st.parties.takeStored(key);
    tell(st, $, action.why === 'manual' ? `forward-compaction: /compact ran Claude Code's own summary; ${label}'s stored handoff was dropped.` : `forward-compaction: ${label}'s stored handoff is no longer in its transcript (compacted by something else); it was dropped.`, { event: 'dropped', party: key, why: action.why });
  }
  if (action.action === 'next') {
    if (kind === 'foreign') st.parties.forget(key);
    else st.parties.asked(key, action.decision);
    record(st, $, row);
    if (action.decision === 'native' && action.why !== 'manual') tell(st, $, `forward-compaction: ${label} ${action.why === 'ceiling' ? `reached its ceiling ${k(m.ceiling)}` : 'was too long for its request'} with no handoff; Claude Code's own summary ran (FORWARD_COMPACTION_CEILING_NATIVE=1).`, { event: 'native', party: key, why: action.why });
    return pass();
  }
  if (action.action === 'skip') {
    // A precompute is no ask for a handoff: only a held one turns the nudge to "now".
    if (action.why === 'waiting') st.parties.asked(key, 'skip');
    record(st, $, { ...row, reason: action.reason });
    return { skip: action.reason };
  }
  const shared = { messages: e.messages, party: kind === 'main' ? ('main' as const) : ('subagent' as const), tokens, askPoint: m.askPoint, now: await $.clock.now(), facts: (kept: readonly string[]) => factsFor(st.ledger, key, { keptTexts: kept }), agents: await agentRows($) };
  const wake = action.action === 'install'
    ? buildWake({ ...shared, toolUseId: held!.toolUseId, handoff: held!.text, files: await readLoadFiles($, held!.loadFiles) })
    : mechanicalWake({ ...shared, reason: action.why === 'ceiling' ? { kind: 'ceiling', ceiling: m.ceiling } : { kind: 'reactive' } });
  const after = estimateTokens(wake.messages);
  installed(st, key, after, signal);
  const line = action.action === 'install'
    ? landedLine({ label, before: tokens, after, chars: held!.text.length, facts: wake.facts, kept: wake.kept, dropped: wake.dropped })
    : mechanicalLine({ label, tokens, ceiling: m.ceiling, before: tokens, after });
  tell(st, $, line, { ...row, after, facts: wake.facts, kept: wake.kept, dropped: wake.dropped });
  return { messages: wake.messages, tokensBefore: tokens, tokensAfter: after };
}

/** C11 (R35): an ask whose handling threw gets a mechanical wake, never the engine's summarizer by accident (A2); only when that throws too does Claude Code's own summary run. */
async function compactFailed(st: State, $: EngineInterface, e: SessionCompactInput, key: PartyKey, error: unknown, pass: () => Promise<SessionCompactResult>, signal?: AbortSignal): Promise<SessionCompactResult> {
  const party = st.parties.get(key);
  const said = `forward-compaction: error in session.compact for ${party.label}: ${message(error)}`;
  try {
    const tokens = party.reading ?? 0;
    const { askPoint, ceiling } = marks(st, key);
    const wake = mechanicalWake({ messages: e.messages, party: key === 'main' ? 'main' : 'subagent', tokens, askPoint, now: Date.now(), facts: (kept) => factsFor(st.ledger, key, { keptTexts: kept }), reason: { kind: 'ceiling', ceiling } });
    const after = estimateTokens(wake.messages);
    installed(st, key, after, signal);
    tell(st, $, `${said}; a mechanical wake was installed.`, { event: 'compact', party: key, decision: 'error', error: message(error), after });
    return { messages: wake.messages, tokensBefore: tokens, tokensAfter: after };
  } catch (again) {
    tell(st, $, `${said}; Claude Code's own summary ran.`, { event: 'compact', party: key, decision: 'error', error: message(error), fallback: message(again) });
    return pass();
  }
}

/** A step's usage is the party's reading; a sharp fall nobody here caused is an unseen compaction (R39). */
function readStep(st: State, $: EngineInterface, e: TurnStepInput, r: TurnStepResult): void {
  const key = keyOf(e.agentId);
  st.parties.describe(key, { model: e.model, modelWin: modelWindow(e.model, st.mainWindow) });
  if (key === 'main') st.pendingCommand = undefined;
  const tokens = contextTokens(r?.usage);
  if (tokens === undefined) return st.parties.answered(key);
  const party = st.parties.get(key);
  if (unseenCompaction(party.reading, tokens, st.installedSince.has(key))) {
    tell(st, $, `forward-compaction: ${party.label}'s context fell from ${k(party.reading!)} to ${k(tokens)} with no compaction this plugin handled (another plugin or Claude Code compacted it).`, { event: 'unseen-compaction', party: key, before: party.reading, after: tokens });
  }
  st.parties.read(key, tokens);
  st.installedSince.delete(key);
}

/** P1 (R32): main's answered turn with a handoff stored compacts once; a sub-agent's turn end is its finish, and its party goes. */
async function turnEnds(st: State, $: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const key = keyOf(e.agentId);
  if (key !== 'main') {
    if (st.parties.takeStored(key) !== undefined) record(st, $, { event: 'dropped', party: key, why: 'agent finished' });
    st.parties.forget(key);
    st.installedSince.delete(key);
    return;
  }
  const party = st.parties.get('main');
  const door = turnEndDoor({ main: true, reason: e.reason, stored: party.stored !== undefined, installedThisTurn: party.installedThisTurn });
  st.parties.turnEnded('main');
  if (!door.compact) return;
  try {
    const out = await $.session.compact();
    if (out.skip !== undefined) tell(st, $, `forward-compaction: main's handoff did not install at turn end: ${out.skip}. It stays stored for the next turn end or ask.`, { event: 'turn-end-skipped', party: 'main', skip: out.skip });
  } catch (error) {
    record(st, $, { event: 'turn-end-rejected', party: 'main', error: message(error) });
  }
}

/** What the person typed is a fact of main's; a message from anywhere else is a notice. */
async function noteSubmit(st: State, $: EngineInterface, e: PromptSubmitInput): Promise<void> {
  if (e.isMeta) return;
  const at = await $.clock.now();
  const origin = originKind(e.origin);
  st.pendingCommand = e.command?.name;
  st.ledger = isPersonOrigin(origin)
    ? addEntry(st.ledger, { kind: 'person', party: 'main', at, text: e.text, ...(e.command ? { command: e.command.name } : {}) })
    : addEntry(st.ledger, { kind: 'notice', party: 'main', at, origin, text: e.text });
}

async function noteReceived(st: State, $: EngineInterface, e: SessionReceiveInput): Promise<void> {
  st.ledger = addEntry(st.ledger, { kind: 'received', party: keyOf(e.agentId), at: await $.clock.now(), origin: originKind(e.origin), text: e.text });
}

/** D5: the party a skill belongs to, from the calls in flight around it (the event names none). */
async function noteSkill(st: State, $: EngineInterface, e: SkillPromptInput): Promise<void> {
  const inFlightSkills = [...st.inFlight].filter(([, call]) => call.tool === 'Skill').map(([tool_use_id, call]) => ({ party: call.party, tool_use_id }));
  const { party, how } = attributeSkill({ inFlightSkills, pendingCommand: st.pendingCommand, pendingSpawns: st.pendingSpawns, skill: e.skill });
  st.ledger = addEntry(st.ledger, { kind: 'skill', party, at: await $.clock.now(), skill: e.skill, text: e.text, how, ...(e.source !== undefined ? { source: e.source } : {}), ...(e.path !== undefined ? { path: e.path } : {}) });
  record(st, $, { event: 'skill', party, skill: e.skill, how });
}

/** A spawned agent's brief is its first fact, and the skills it preloaded become its own. */
async function noteSpawn(st: State, $: EngineInterface, e: AgentSpawnInput, r: AgentSpawnResult): Promise<void> {
  const id = r?.agentId;
  if (typeof id !== 'string' || id === '') return;
  const key: PartyKey = `agent:${id}`;
  st.ledger = resolveSpawn(addEntry(st.ledger, { kind: 'brief', party: key, at: await $.clock.now(), text: e.prompt, description: e.description, subagentType: e.subagentType, spawnedBy: st.inFlight.get(e.tool_use_id)?.party ?? 'unknown' }), e.tool_use_id, id);
  st.knownAgents.set(id, e.subagentType);
  st.parties.describe(key, { label: `${e.subagentType} ${id.slice(0, 6)}` });
}

/** The shells and crons running at a stop: the latest snapshot is a fact of every wake. */
async function noteShells(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<void> {
  const list = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value : []);
  const tasks = list(e.background_tasks).map((t) => ({ id: String(t.id), type: String(t.type), status: String(t.status), description: String(t.description ?? ''), ...(typeof t.command === 'string' ? { command: t.command } : {}) }));
  const crons = list(e.session_crons).map((c) => ({ id: String(c.id), schedule: String(c.schedule), recurring: c.recurring === true, prompt: String(c.prompt ?? '') }));
  st.ledger = addEntry(st.ledger, { kind: 'shells', at: await $.clock.now(), tasks, crons });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const st: State = {
    config: resolveOptions(),
    ignoredOptions: options !== null && typeof options === 'object' ? Object.keys(options) : [],
    pluginRows: [], pluginInitialized: false, pluginWriting: Promise.resolve(), pluginFailing: false,
    toolNames: {}, toolTries: { forward_compaction: 0, look_back: 0 },
    warned: new Set(), logFailures: new Set(),
    pending: [], rowsWriting: 0, levelRowsWriting: 0, skips: new SkipFold(), writing: Promise.resolve(),
    parties: new Parties(ENGINE_DEFAULT_WINDOW), ledger: newLedger(), mainWindow: ENGINE_DEFAULT_WINDOW,
    inFlight: new Map(), pendingSpawns: new Set(), knownAgents: new Map(), installedSince: new Set(),
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await ensureTools(st, $, next.signal);
    await guard(st, $, 'session.start', () => sessionBegins(st, $));
    return result;
  });

  on('tool.call', async ($, e, next) => {
    if (st.toolNames.look_back !== undefined && e.tool === st.toolNames.look_back) return { result: await answerLookBackTool(st, $, e as Record<string, unknown>) };
    if (st.toolNames.forward_compaction !== undefined && e.tool === st.toolNames.forward_compaction) return { result: await answerForward(st, $, e as Record<string, unknown>) };
    await unlessAborted(observeManualLookBack(st, $, e as Record<string, unknown>), next.signal);
    const key = keyOf(e.agentId);
    const id = e.tool_use_id;
    const tracked = typeof id === 'string' && (e.tool === 'Skill' || e.tool === 'Agent');
    if (tracked) st.inFlight.set(id, { party: key, tool: e.tool });
    let result: ToolCallResult;
    try {
      result = await next(e);
    } finally {
      if (tracked) st.inFlight.delete(id);
    }
    return nudged(st, $, key, result);
  });

  on('session.compact', async ($, e, next) => {
    const key = keyOf(e.agentId);
    try {
      return await compactAsk(st, $, e, key, () => next(e), next.signal);
    } catch (error) {
      return compactFailed(st, $, e, key, error, () => next(e), next.signal);
    }
  });

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e);
    await guard(st, $, 'turn.step', () => readStep(st, $, e, r));
    return r;
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    await guard(st, $, 'turn.complete', () => turnEnds(st, $, e));
    return r;
  });

  on('prompt.submit', async ($, e, next) => {
    await guard(st, $, 'prompt.submit', () => noteSubmit(st, $, e));
    return next(e);
  });

  on('session.receive', async ($, e, next) => {
    await guard(st, $, 'session.receive', () => noteReceived(st, $, e));
    return next(e);
  });

  on('skill.prompt', async ($, e, next) => {
    await guard(st, $, 'skill.prompt', () => noteSkill(st, $, e));
    return next(e);
  });

  on('agent.spawn', async ($, e, next) => {
    st.pendingSpawns.add(e.tool_use_id);
    let r: AgentSpawnResult;
    try {
      r = await next(e);
    } finally {
      st.pendingSpawns.delete(e.tool_use_id);
    }
    await guard(st, $, 'agent.spawn', () => noteSpawn(st, $, e, r));
    return r;
  });

  on('classic.Stop', async ($, e, next) => {
    await guard(st, $, 'classic.Stop', () => noteShells(st, $, e as Record<string, unknown>));
    return next(e);
  });

  on('classic.SubagentStop', async ($, e, next) => {
    await guard(st, $, 'classic.SubagentStop', () => noteShells(st, $, e as Record<string, unknown>));
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
    // The whole end chain shares one short bound: the writes get what it leaves less core's share, and the conversation starts over either way. A write queued while the end waits (a cleanup failure said) is waited for too.
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
    if (goesOn) {
      startOver(st);
      await guard(st, $, 'session.end', () => conversationStartsOver(st, $, e.reason));
    }
    return next(e);
  });
};
