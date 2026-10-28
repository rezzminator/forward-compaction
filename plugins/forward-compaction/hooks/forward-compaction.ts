import type { EngineInterface, On, PluginOptions, Register, SessionCompactInput, SessionCompactResult, ToolCallResult, TurnStartInput, TurnStepInput, TurnStepResult, TurnCompleteInput, PromptSubmitInput, SessionReceiveInput, SkillPromptInput, AgentSpawnInput, AgentSpawnResult } from 'claude-code';
import { bounded, unlessAborted } from '../src/bounded.ts';
import { applyDrops, dropNote, changesNote, pinnedBy, experimental, parseFrontier, loadFileNote, receipt, parseLineRanges, sliceFile, toolInput, type FileCheck, type LoadFile } from '../src/frontier.ts';
import { answersOf, workOf, type CallAnswer } from '../src/work.ts';
import { newLedger, markStart, addEntry, resolveSpawn, attributeSkill, shellsOf, factsFor, promptsKept, restorePrompts, skillsKept, restoreSkills, liftSources, isPersonOrigin, keyOf, originKind, type Ledger, type PartyKey } from '../src/ledger.ts';
import { splitAtCall, buildWake, mechanicalWake, landedLine, type WakeFile, type AgentRow, type Landing } from '../src/wake.ts';
import { decide, turnEndDoor, readingTokens, knownTrigger } from '../src/decide.ts';
import { k, nudgeLevel, nudgeText } from '../src/nudge.ts';
import { Parties, type Judging } from '../src/parties.ts';
import { askPointOf, charsPerToken, partyMarks, startWarnings, apiChars, type AskPoint, type Marks, type UsageBreakdown } from '../src/window.ts';
import { unseenCompaction } from '../src/unseen.ts';
import { parseLookBack, boundaryArgv, boundaryLine, searchArgv, entryArgv, namesArgv, processOutput, parseEntries, toolNames, resultIds, searchResults, entryResult, manualTranscriptCall, lookBackNotice, findTranscriptArgv, firstFound, type LookBackResult } from '../src/look-back.ts';
import { DecisionWriteError, hookRow, sessionLogPath, runCwd, decisionAppendArgv, retentionArgv, DECISION_HOLD_ROWS, decisionFailure, endReport, SkipFold, pluginLogEvent, pluginLogDiagnostic } from '../src/log.ts';
import { levelRow, onScreen, pluginLogDir, PluginLogQueue, requeueRows, type PluginLogLevel, type PluginLogFields } from '../src/plugin-log.ts';
import { resolveOptions, subagentMaxContext, type OptionEnvironment, type ResolvedOptions } from '../src/options.ts';
import { TOOLS, toolsToRegister, ENSURE_TOOLS_TIMEOUT_MS, END_CORE_RESERVE_MS, REGISTER_TRIES, PENDING_BEFORE_CONFIG, type ToolKind } from '../src/register.ts';

// Thin adapter: every decision lives in src/. Each hook catches its own failures, logs them with context and lets the compaction through.

type Row = Record<string, unknown>;

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
  restored: Set<PartyKey>; // Parties whose kept prompts and skills were put back this process (restoreKept).
  toolTries: Record<ToolKind, number>; // How many times registering each tool was tried.
  registering?: Promise<void>; // The registration in progress: hooks that need a tool wait on it, so none registers twice.
  toolsAbandoned?: boolean; // Registering the tools has not finished within ENSURE_TOOLS_TIMEOUT_MS: no hook waits on it until it settles, and a late finish still names the tools.
  toolsSettled?: boolean; // Every tool is registered or out of tries: no hook registers or sets a timer again.
  warned: Set<string>; pending: string[];
  logFailures: Set<string>; // The log-write failures already shown: a log that cannot be written fails every flush the same way, and the person hears each failure once.
  rowsWriting: number; // Rows the decision append in flight carries; 0 when none is.
  levelRowsWriting: number; // Level-log rows queued or being written: what a cut end flush may lose from the level log.
  levelLinks: number; levelBatched: number; // Level-log rows whose write is chained, and rows queued for the burst's one append.
  skips: SkipFold; // Routine skips fold into one `skips` row per streak.
  levelSkips: SkipFold; // The same fold for the level log, which writes whether or not the decision log is on.
  retained?: boolean; // Old sessions' logs were cleaned up once this session (or tried).
  writeError?: string; // Why the last decision append failed, while its rows wait in `pending`; cleared by the next append that succeeds.
  rowsDropped?: { rows: number; error: string }; // Rows the hold let go this session, and the failure that dropped the last of them: counted at session end.
  logPath?: Promise<string | undefined>;
  writing: Promise<void>;
  parties: Parties; ledger: Ledger;
  inFlight: Map<string, { party: PartyKey; tool: string }>; // Skill and Agent calls running now, by tool_use_id: the party that made each, for skill attribution and a spawn's parent.
  pendingCommand?: string; // The command main typed, until its first step: a skill it expands is main's.
  pendingSpawns: Set<string>; // agent.spawn calls running now: a skill loaded meanwhile is a preload of the one spawn.
  knownAgents: Map<string, string>; // Sub-agents spawned here, id to type: an ask for any other agent id is the engine's own (C6).
  mainWindow?: number; // Main's window as `$.session.usage()` last reported it: main's max context unless FORWARD_COMPACTION_MAIN_MAX_CONTEXT is set.
  apiAsk?: AskPoint; breakdown?: UsageBreakdown; // Claude Code's ask point and the breakdown it was read from, at session start and each main-window read.
  installedSince: Set<string>; // Parties this plugin compacted since their last reading: a fall in that reading is no unseen compaction.
};

/** A line on the person's screen: Claude Code already names the plugin in front of it, so the line never names it again. */
function show($: EngineInterface, line: string): void {
  $.ui.log(screenLine(line));
}

const screenLine = (line: string): string => line.replace(/^forward-compaction: /, '');

/** Every line said lands in the decision log as a `said` row; only an error reaches the screen. A line said with its diagnostic row is one level-log entry: the row's, at the level said. */
function say(st: State, $: EngineInterface, line: string, level: PluginLogLevel = 'error', row?: Row): void {
  const shown = onScreen(level); // warning, info and debug rows go to their files, or nowhere when no log can hold them
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
  let held = false; // this row waits in the queue for a later row's append
  st.levelRowsWriting += rows;
  st.levelLinks++;
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
    queue.add(levelRow({ plugin: 'forward-compaction', ...fields, msg: pluginLogDiagnostic(fields.msg), ...(session ? { session } : {}) }, now));
    st.levelBatched += rows;
    if (st.levelLinks > 1) return void (held = true); // a burst of rows is one append process: the burst's last row writes them all
    [rows, st.levelBatched] = [st.levelBatched, 0];
    const out = await queue.flush((argv) => $.process.run(argv, { ...runCwd(st.pluginLogDir ?? ''), timeoutMs: 15_000 }));
    // The library says its own line once per failing streak, and writes the rows its hold let go as an error row.
    if (out.screen !== undefined) pluginLogFailed(st, $, out.screen, out.error ?? '', out.held);
    st.pluginFailing = out.held !== 0;
  }).catch((error) => {
    const cause = message(error);
    if (!st.pluginFailing) pluginLogFailed(st, $, `forward-compaction: plugin log ${st.pluginLogDir} failed: ${cause}; ${rows} ${rows === 1 ? 'row is' : 'rows are'} lost`, cause, 0);
    st.pluginFailing = true;
  }).finally(() => { st.levelLinks--; if (!held) st.levelRowsWriting -= rows; });
}

/** Once per failing streak: the line on the screen, and a decision row that maps to no level, so it never recurses into the failing log. */
function pluginLogFailed(st: State, $: EngineInterface, line: string, error: string, held: number): void {
  show($, line);
  record(st, $, { event: 'plugin-log-failed', dir: st.pluginLogDir ?? null, error, held });
}

// Rows queue in memory; each flush appends them to the session's file through the append script, under its lock, so a resumed session keeps its earlier rows, no row is rewritten and no other chat shares the file.
function record(st: State, $: EngineInterface, row: Row, levelRow = true): void {
  dbg(st, $, `row:${String(row.event)}`, row); // every decision row, whole, before any fold
  const ts = new Date().toISOString(); // one stamp for both logs. Folded first: a held-ask streak reaches the level log as its first row and one `skips` row.
  if (levelRow) for (const diagnostic of st.levelSkips.add({ ts, ...row }).map(pluginLogEvent)) if (diagnostic !== undefined) plog(st, $, diagnostic);
  // The decision log's file may come from the environment, which `start` reads: a row before that waits, so the session's one file is chosen from the full config. `settleConfig` writes what waited.
  if (!st.configured) {
    for (const out of st.skips.add({ ts, ...row })) if (st.pending.length < PENDING_BEFORE_CONFIG) st.pending.push(JSON.stringify(out));
    return;
  }
  if (!st.config.logFile) return;
  for (const out of st.skips.add({ ts, ...row })) st.pending.push(JSON.stringify(out));
  flushDecisions(st, $);
}

/** What every party is judged by now: main's max context known, and the ignore list. */
const judging = (st: State): Judging => ({ mainKnown: st.config.main.maxContext !== undefined || st.mainWindow !== undefined, ignore: st.config.ignoreModels });

/** A party's ignore judgement, written as an `ignore` row when it is new or has changed, and kept with its model in `$.state`, so a plugin reload writes no row for a judgement that holds. */
async function judge(st: State, $: EngineInterface, key: PartyKey): Promise<void> {
  await restoreKept(st, $, key);
  const row = st.parties.judged(key, judging(st));
  if (row) (record(st, $, row), await $.state.set({ plugin: 'forward-compaction', key: 'judged', id: `${await (st.sessionId ??= $.session.id())}/${key}` }, { judged: row.judged, model: row.model }));
}

/** A debug row (`debug.jsonl`) while FORWARD_COMPACTION_DEBUG is on: numbers as the API gave them. */
function dbg(st: State, $: EngineInterface, event: string, detail: Row): void {
  if (st.config.debug) plog(st, $, { level: 'debug', event, msg: event, where: 'hooks/forward-compaction.ts', detail });
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
      const line = `forward-compaction: reading the session id failed: ${message(error)}; the decision log is off for this session`;
      plog(st, $, { level: 'error', event: 'decision-log-session-error', msg: screenLine(line), where: 'hooks/forward-compaction.ts#flushDecisions', detail: { error: message(error) } });
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
        const dropped = requeueRows(pending, rows, DECISION_HOLD_ROWS);
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
    // Screen and level log only, once per distinct failure (decisionFailure's key): never queue another decision write.
    .catch((error) => {
      const { line, key } = decisionFailure(named, error, last);
      if (st.logFailures.has(key)) return;
      st.logFailures.add(key);
      plog(st, $, { level: 'error', event: 'decision-log-write-error', msg: screenLine(line), where: 'hooks/forward-compaction.ts#flushDecisions', detail: { error: message(error) } });
      show($, line);
    });
}

/** Once per session, after its first append: old sessions' logs beside this one go; a failure is told once, in both logs, and the log goes on. */
async function retainLogs(st: State, $: EngineInterface, file: string, path: string): Promise<void> {
  try {
    const out = await $.process.run(retentionArgv(file, path), { ...runCwd(file, path), timeoutMs: 15_000 });
    if (out.exitCode !== 0) throw new Error(out.stderr.split('\n')[0]?.trim() || `the retention script exited ${out.exitCode}`);
  } catch (error) {
    const line = `forward-compaction: cleaning up old decision logs beside ${path} failed: ${message(error)}; they stay`;
    say(st, $, line, 'warning', { event: 'decision-retention-failed', where: 'retainLogs', file, error: message(error), line: screenLine(line) });
  }
}

/** After a /clear or a resume: main's conversation is a new one, under a new session id and its own decision log file. */
function startOver(st: State): void {
  Object.assign(st, { sessionId: undefined, logPath: undefined, pending: [], retained: false, writeError: undefined, rowsDropped: undefined });
}

/** Says `line` once per `key`; its row's event is the key's stem and its `where` the function that raised it. */
function warnOnce(st: State, $: EngineInterface, where: string, key: string, line: string, level: PluginLogLevel = 'warning'): void {
  if (st.warned.has(key)) return;
  st.warned.add(key);
  say(st, $, line, level, { event: key.split(':')[0]!, where, key, line });
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
    readOptionVar('FORWARD_COMPACTION_MAIN_MAX_CONTEXT', () => $.env.get('FORWARD_COMPACTION_MAIN_MAX_CONTEXT')),
    readOptionVar('FORWARD_COMPACTION_MAIN_CEILING', () => $.env.get('FORWARD_COMPACTION_MAIN_CEILING')),
    readOptionVar('FORWARD_COMPACTION_MAIN_NUDGE_START', () => $.env.get('FORWARD_COMPACTION_MAIN_NUDGE_START')),
    readOptionVar('FORWARD_COMPACTION_MAIN_NUDGE_EVERY', () => $.env.get('FORWARD_COMPACTION_MAIN_NUDGE_EVERY')),
    readOptionVar('FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT', () => $.env.get('FORWARD_COMPACTION_SUBAGENT_MAX_CONTEXT')),
    readOptionVar('FORWARD_COMPACTION_SUBAGENT_CEILING', () => $.env.get('FORWARD_COMPACTION_SUBAGENT_CEILING')),
    readOptionVar('FORWARD_COMPACTION_SUBAGENT_NUDGE_START', () => $.env.get('FORWARD_COMPACTION_SUBAGENT_NUDGE_START')),
    readOptionVar('FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY', () => $.env.get('FORWARD_COMPACTION_SUBAGENT_NUDGE_EVERY')),
    readOptionVar('FORWARD_COMPACTION_CEILING_NATIVE', () => $.env.get('FORWARD_COMPACTION_CEILING_NATIVE')),
    readOptionVar('FORWARD_COMPACTION_IGNORE_MODELS', () => $.env.get('FORWARD_COMPACTION_IGNORE_MODELS')),
    readOptionVar('FORWARD_COMPACTION_KEEP_SKILLS', () => $.env.get('FORWARD_COMPACTION_KEEP_SKILLS')),
    readOptionVar('FORWARD_COMPACTION_DEBUG', () => $.env.get('FORWARD_COMPACTION_DEBUG')),
  ]);
  return { vars, readErrors };
}

// First hook call: report option errors, find the log directories, and resolve the options.
function start(st: State, $: EngineInterface): Promise<void> {
  st.started ??= (async () => {
    const early: { line: string; level: PluginLogLevel; event: string }[] = [];
    let home: string | undefined;
    try {
      home = await $.env.get('HOME');
      st.home = home;
    } catch (error) {
      early.push({ line: `forward-compaction: reading HOME failed: ${message(error)}; the logs have no home directory`, level: 'error', event: 'home-read-failed' });
    }
    let override: string | undefined;
    try {
      override = await $.env.get('PLUGIN_LOG_DIR');
    } catch (error) {
      early.push({ line: `forward-compaction: reading PLUGIN_LOG_DIR failed: ${message(error)}; using HOME fallback`, level: 'warning', event: 'plugin-log-dir-read-failed' });
    }
    st.pluginInitialized = true;
    st.pluginLogDir = pluginLogDir(override, home, 'forward-compaction');
    st.pluginLog = new PluginLogQueue(st.pluginLogDir, 'forward-compaction'); // with no directory its first flush says the log is off
    const env = await readOptionEnv($);
    st.config = resolveOptions({ pluginLogDir: override, home, ...env });
    const earlyRows = st.pluginRows.splice(0); // rows held before the level log had a home: debug ones only while the debug log is on
    for (const fields of earlyRows) if (fields.level !== 'debug' || st.config.debug) plog(st, $, fields);
    dbg(st, $, 'env', { HOME: home ?? null, PLUGIN_LOG_DIR: override ?? null, ...env.vars, readErrors: env.readErrors });
    const { errors: _, ...options } = st.config;
    dbg(st, $, 'options', options);
    settleConfig(st, $);
    for (const { line, level, event } of early) say(st, $, line, level, { event, where: 'start', line });
    for (const line of st.config.errors) {
      say(st, $, line, 'error', { event: 'option-error', where: 'start', line });
    }
    if (st.ignoredOptions.length > 0) {
      const line = `forward-compaction: options ${st.ignoredOptions.join(', ')} are not read; set FORWARD_COMPACTION_* environment variables instead (README, Options); their values are not applied`;
      warnOnce(st, $, 'start', 'options-ignored', line, 'error');
    }
    try {
      st.configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : undefined);
    } catch (error) {
      say(st, $, `forward-compaction: reading CLAUDE_CONFIG_DIR failed: ${message(error)}; look_back reads ~/.claude only`, 'warning', { event: 'config-dir-read-failed', where: 'start', error: message(error) });
      st.configDir = home ? `${home}/.claude` : undefined;
    }
    record(st, $, { event: 'start', main: st.config.main, subagent: st.config.subagent, ceilingNative: st.config.ceilingNative, ignoreModels: st.config.ignoreModels });
  })().finally(() => settleConfig(st, $));
  return st.started;
}

async function registerTool(st: State, $: EngineInterface, kind: ToolKind): Promise<void> {
  const { lost, ...spec } = TOOLS[kind];
  try {
    const { tool } = await $.tool.register(spec);
    st.toolNames[kind] = tool;
    record(st, $, { event: 'tool-registered', tool });
  } catch (error) {
    const row = { event: 'tool-register-failed', where: 'registerTool', tool: spec.name, error: message(error), tries: st.toolTries[kind] };
    if (st.warned.has(`register-failed:${kind}`)) return record(st, $, row); // a retry's failure: its row, the person told once
    st.warned.add(`register-failed:${kind}`);
    say(st, $, `forward-compaction: registering the ${spec.name} tool failed: ${message(error)}; ${lost}`, 'error', row);
  }
}

async function answerLookBackTool(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined;
  const party = keyOf(agentId);
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
  const row = { event: 'look-back', where: 'answerLookBackTool', party, ...(args.query !== undefined ? { query: args.query } : {}), ...(args.entry !== undefined ? { entry: args.entry } : {}), ...(result.hits !== undefined ? { hits: result.hits } : {}), boundary, ...(result.error !== undefined ? { error: result.error } : {}) };
  // A failure the caller's input caused is a warning; only the plugin's own fault is an error.
  say(st, $, lookBackNotice(label, args, result), result.error === undefined ? 'info' : result.input ? 'warning' : 'error', row);
  return result.text;
}

/** Observation never rejects, rewrites or starts a process for an ordinary tool call. */
async function observeManualLookBack(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<void> {
  const tool = typeof e.tool === 'string' ? e.tool : '';
  if (!['Read', 'Grep', 'Bash'].includes(tool)) return;
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined;
  const party = keyOf(agentId);
  try {
    const session = agentId === undefined ? await (st.sessionId ??= $.session.id()) : '';
    if (!manualTranscriptCall(tool, toolInput(e), session, agentId)) return;
    record(st, $, { event: 'look-back-manual', party, tool });
    say(st, $, `look back by hand (${party}): ${tool} on the transcript`, 'info');
  } catch (error) {
    say(st, $, `forward-compaction: observing manual transcript lookup of ${party} via ${tool} failed: ${message(error)}`, 'error', { event: 'look-back-manual-error', where: 'observeManualLookBack', party, tool, error: message(error) });
  }
}

/** `$.clock.after`, or, where the engine has none, a timer that never fires and a warning once: the wait is then unbounded, as it was. A call a hook refuses without throwing never fires either and is not reported: that wait is unbounded too. */
function afterOrNever(st: State, $: EngineInterface, ms: number, fn: () => void, what: string): { cancel: () => void } {
  try {
    return $.clock.after(ms, fn);
  } catch (error) {
    warnOnce(st, $, 'afterOrNever', `no-clock:${what}`, `forward-compaction: $.clock.after is unavailable (${message(error)}); ${what} is not time-bounded`, 'error');
    return { cancel: () => {} };
  }
}

/** Registers each tool that is not registered yet, up to REGISTER_TRIES hook calls each: `session.start` may not fire (a plugin loaded mid-session) or may run before the session can take a tool. Hooks that need a tool wait on it. */
async function ensureTools(st: State, $: EngineInterface, signal?: AbortSignal): Promise<void> {
  if (st.toolsAbandoned || st.toolsSettled) return;
  const left = () => toolsToRegister({ forward_compaction: true, look_back: true }, { forward_compaction: st.toolNames.forward_compaction !== undefined, look_back: st.toolNames.look_back !== undefined }, st.toolTries, REGISTER_TRIES);
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
      .catch((error) => say(st, $, `forward-compaction: registering the tools failed: ${message(error)}`, 'error', { event: 'tools-register-failed', where: 'ensureTools', error: message(error) }));
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
  warnOnce(st, $, 'ensureTools', 'tools-timeout', `forward-compaction: registering the tools did not finish within ${ENSURE_TOOLS_TIMEOUT_MS / 1000}s; it goes on, turns do not wait for it, and the tools come into use once it finishes`);
}

/** D9: a hook's own work never throws out of the plugin; a failure is said with the hook it came from, and the event goes on. */
async function guard(st: State, $: EngineInterface, where: string, work: () => unknown, e?: unknown): Promise<void> {
  dbg(st, $, 'hook', hookRow(where, e));
  try {
    await work();
  } catch (error) {
    say(st, $, `forward-compaction: ${where} failed: ${message(error)}`, 'error', { event: 'hook-error', where, error: message(error) });
  }
}

/** A party's token marks against its max context (main's option or reported window, a sub-agent's option or its model's; `agent:` alone, no model, is the 200k one); undefined while main's is not known. */
function marks(st: State, key: string): Marks | undefined {
  return key === 'main' ? partyMarks(st.config.main, st.config.main.maxContext ?? st.mainWindow, st.apiAsk?.tokens) : partyMarks(st.config.subagent, subagentMaxContext(st.config.subagent.maxContext, key === 'agent:' ? undefined : st.parties.get(key).model), st.apiAsk?.tokens);
}

/** After a /clear or a resume: no party, fact or call of the old conversation carries into the new one. */
async function conversationStartsOver(st: State, $: EngineInterface, reason: string): Promise<void> {
  st.parties = new Parties();
  st.ledger = markStart(newLedger(), await $.clock.now(), reason);
  st.inFlight.clear();
  st.pendingSpawns.clear();
  st.installedSince.clear();
  st.restored.clear();
  st.pendingCommand = undefined;
}

/** session.start: the ledger starts, main's window and Claude Code's ask point are read, and a compaction window that holds a frontier back is named once (R33). */
async function sessionBegins(st: State, $: EngineInterface): Promise<void> {
  st.ledger = markStart(st.ledger, await $.clock.now(), 'startup');
  await readMainWindow(st, $);
  await judge(st, $, 'main');
  for (const w of startWarnings(st.breakdown, st.apiAsk, marks(st, 'main'), marks(st, 'agent:')!)) if (!st.warned.has(w.key)) (st.warned.add(w.key), say(st, $, w.line, 'warning', { ...w.row, where: 'sessionBegins' }));
}

/** ENOENT is a missing file; any other failure to stat is said as the error it is. */
async function statFile(st: State, $: EngineInterface, path: string): Promise<FileCheck> {
  const check: FileCheck = await Promise.resolve().then(() => $.fs.stat(path)).then((stat) => ({ kind: stat.kind, size: stat.size }), (error: unknown) => ((error as { code?: unknown } | null)?.code === 'ENOENT' ? { absent: true } : { error: message(error) }));
  dbg(st, $, 'fs.stat', { path, ...check });
  return check;
}

/** The forward_compaction tool (R31): the frontier is checked, stored for the party, and answered with the receipt of its door. */
async function answerForward(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const key = keyOf(e.agentId);
  try {
    await start(st, $);
    await restoreKept(st, $, key); // a skill and the orders kept across a plugin reload are back before the drop check and any drop
    const parsed = parseFrontier(toolInput(e), { remembered: st.parties.get(key).orders ?? [], said: liftSources(st.ledger, key), party: key === 'main' ? 'main' : 'subagent' });
    const m = marks(st, key);
    const notes = [...parsed.notes];
    const carried: typeof parsed.loadFiles = [];
    for (const [i, file] of parsed.loadFiles.entries()) {
      const note = loadFileNote(parsed.loadAt[i]!, file.path, await statFile(st, $, file.path));
      if (note === undefined) carried.push(file);
      else notes.push(note);
    }
    parsed.loadFiles = carried;
    const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : '';
    if (toolUseId === '') notes.push('the call has no tool_use_id, so the wake cannot place it: at the install this frontier is dropped and you get the mechanical wake.');
    const tokens = st.parties.get(key).reading; // the last reading: the call's own context is measured only by the next request
    await $.state.set({ plugin: 'forward-compaction', key: 'orders', id: `${await (st.sessionId ??= $.session.id())}/${key}` }, parsed.standingOrders); // kept before the store: a failed write stores nothing
    const replaced = st.parties.store(key, { text: parsed.frontier, loadFiles: parsed.loadFiles, toolUseId, storedAtTokens: tokens, since: st.ledger.nextSeq, standingOrders: parsed.standingOrders, lifted: parsed.lifted });
    const drop = applyDrops(st.ledger, key, parsed.dropSkills, st.parties.get(key).dropAsked); (st.ledger = drop.ledger), (st.parties.get(key).dropAsked = drop.outcome.pending); // a frontier naming nothing resets the count
    if (parsed.dropSkills.length > 0) (record(st, $, { event: 'drop', party: key, ...drop.outcome }), await keepKept(st, $, key));
    const files = parsed.loadFiles.length;
    record(st, $, { event: 'stored', party: key, chars: parsed.frontier.length, files, orders: parsed.standingOrders.length, lifted: parsed.lifted.length, notes: notes.length, tokens: tokens ?? null, ...(replaced !== undefined ? { replaced: replaced.storedAtTokens ?? null } : {}) });
    return [key === 'main' ? receipt({ party: 'main', chars: parsed.frontier.length, files, tokens, askPoint: m?.askPoint, replaced: replaced !== undefined }) : receipt({ party: 'subagent', chars: parsed.frontier.length, files, tokens, askPoint: m!.askPoint, replaced: replaced !== undefined }), dropNote(drop.outcome), changesNote(notes)].filter(Boolean).join(' ');
  } catch (error) {
    say(st, $, `forward-compaction: storing ${key}'s frontier failed: ${message(error)}`, 'error', { event: 'store-error', where: 'answerForward', party: key, error: message(error) });
    return `forward_compaction failed, nothing stored: ${message(error)}`;
  }
}

/** Past a nudge point with nothing stored, the tool result carries the nudge once per level (R37). */
async function nudged(st: State, $: EngineInterface, key: PartyKey, result: ToolCallResult): Promise<ToolCallResult> {
  if (result.deny !== undefined) return result;
  try {
    await start(st, $);
    await judge(st, $, key); const party = st.parties.get(key);
    const tokens = party.reading; // measured only: a step late at worst, never an estimate
    const m = marks(st, key);
    const level = tokens === undefined || m === undefined ? 0 : nudgeLevel(tokens, m.start, m.every);
    const withheld = tokens === undefined ? 'no-reading' : m === undefined ? 'window-unknown' : level === 0 ? 'below-start' : st.parties.ignored(key, st.config.ignoreModels) !== undefined ? 'ignored-model' : !st.parties.nudgeDue(key, level, tokens!, m!.every) ? 'not-due' : undefined;
    if (withheld !== undefined) return (dbg(st, $, 'nudge-withheld', { party: key, why: withheld, tokens: tokens ?? null, level, start: m?.start ?? null, every: m?.every ?? null }), result);
    record(st, $, { event: 'nudge', party: key, level, tokens, start: m!.start, every: m!.every });
    return { ...result, context: [...(result.context ?? []), nudgeText({ tokens: tokens!, window: m!.maxContext, ceiling: m!.ceiling, tool: st.toolNames.forward_compaction })] };
  } catch (error) {
    say(st, $, `forward-compaction: nudging ${key} failed: ${message(error)}`, 'error', { event: 'nudge-error', where: 'nudged', party: key, error: message(error) });
    return result;
  }
}

/** A sub-agent spawned here is ours; any other agent id the engine's own run, unless `$.agent.list` knows it. */
async function partyKind(st: State, $: EngineInterface, agentId: string): Promise<'subagent' | 'foreign'> {
  if (st.knownAgents.has(agentId)) return 'subagent';
  try {
    const agents = await $.agent.list();
    const agent = agents.find((a) => a.id === agentId);
    dbg(st, $, 'agent.list', { count: agents.length, agentId, found: agent !== undefined });
    if (agent === undefined) return 'foreign';
    st.knownAgents.set(agentId, agent.type);
    st.parties.describe(`agent:${agentId}`, { label: `${agent.type} ${agentId.slice(0, 6)}` });
    return 'subagent';
  } catch (error) {
    warnOnce(st, $, 'partyKind', 'agent-list-failed', `forward-compaction: listing agents failed: ${message(error)}; agent ${agentId} is handled as a sub-agent`);
    return 'subagent';
  }
}

/** A rejected list is the wake's own agents error; a list that is no list throws, and the ask falls to C11. */
async function agentRows($: EngineInterface): Promise<AgentRow[] | { error: string }> {
  const list = await $.agent.list().then((agents) => agents, (error: unknown) => ({ error: message(error) }));
  return 'error' in list ? list : list.map((a) => ({ id: a.id, type: a.type, status: a.status, description: a.description, ...(a.parentId !== undefined ? { parentId: a.parentId } : {}) }));
}

/** Each load file read now, whole or by its lines; one that cannot be read is carried as its problem. */
async function readLoadFiles($: EngineInterface, files: readonly LoadFile[]): Promise<WakeFile[]> {
  return Promise.all(files.map(async (file): Promise<WakeFile> => {
    try {
      const sliced = sliceFile(file.path, await $.fs.read(file.path), file.lines === undefined ? undefined : parseLineRanges(file.lines));
      return 'body' in sliced ? { ...file, ...(sliced.shown ? { lines: sliced.shown } : {}), content: sliced.body } : { ...file, problem: sliced.problem };
    } catch (error) {
      return { ...file, problem: message(error) };
    }
  }));
}

/** A wake the engine took: no reading stands until the next request's, its next fall is no unseen compaction, and a landing still waiting from an earlier install is said now. */
function installed(st: State, $: EngineInterface, key: string, landing: Landing | undefined, signal?: AbortSignal): void {
  if (signal?.aborted) return;
  land(st, $, key, st.parties.installed(key, landing));
  st.installedSince.add(key);
}

/** M2: an installed wake's landed line and `landed` row, at the party's first reading after it (`after`), or at its end with `after` unknown. A chosen frontier's line is a routine info row in the logs; a mechanical wake lost the model's frontier, so the person sees it. */
function land(st: State, $: EngineInterface, key: string, landing: Landing | undefined, after?: number): void {
  if (landing !== undefined) { const line = landedLine(landing, after), row = { event: 'landed', party: key, kind: landing.kind, before: landing.before ?? null, after: after ?? null, line: screenLine(line) }; say(st, $, line, 'info', row); }
}

/** One session.compact ask, rows C1-C10: decide, then pass, hold, or install the frontier or a mechanical wake. */
async function compactAsk(st: State, $: EngineInterface, e: SessionCompactInput, key: PartyKey, pass: () => Promise<SessionCompactResult>, signal?: AbortSignal): Promise<SessionCompactResult> {
  await start(st, $);
  for (const who of [key, 'unknown' as const]) await guard(st, $, 'kept restore', () => restoreKept(st, $, who));
  let trigger = knownTrigger(e.trigger);
  if (trigger === undefined) {
    warnOnce(st, $, 'compactAsk', `unknown-trigger:${String(e.trigger)}`, `forward-compaction: session.compact trigger ${String(e.trigger)} is unknown; it is handled as an automatic ask`);
    trigger = 'auto';
  }
  const kind = key === 'main' ? 'main' : await partyKind(st, $, e.agentId!);
  await judge(st, $, key); const party = st.parties.get(key);
  const { label, stored: held } = party;
  const found = held !== undefined && splitAtCall(e.messages, held.toolUseId) !== undefined;
  const tokens = party.reading; // measured only; none since an install, or yet, is unknown
  const m = marks(st, key);
  const matched = st.parties.ignored(key, st.config.ignoreModels);
  const action = decide({ trigger, party: kind, stored: found, storedMissing: held !== undefined && !found, tokens, ceiling: m?.ceiling, reactive: st.parties.reactive(key), ceilingNative: st.config.ceilingNative, label, ignored: matched !== undefined, windowUnknown: st.parties.windowUnknown(key, judging(st).mainKnown) });
  const row: Row = { event: 'compact', party: key, trigger, decision: action.decision, why: action.why, tokens: tokens ?? null, ceiling: m?.ceiling ?? null, askPoint: m?.askPoint ?? null, ...(matched !== undefined ? { matched } : {}) };
  if ('dropStored' in action && action.dropStored && held !== undefined) {
    st.parties.takeStored(key);
    say(st, $, action.why === 'manual' ? `forward-compaction: /compact ran Claude Code's own summary; ${label}'s stored frontier was dropped.` : `forward-compaction: ${label}'s stored frontier is no longer in its transcript (compacted by something else); it was dropped.`, 'error', { event: 'dropped', where: 'compactAsk', party: key, why: action.why });
  }
  if (action.action === 'next') {
    if (kind === 'foreign') st.parties.forget(key);
    else (st.parties.asked(key, action.decision), st.installedSince.add(key)); // Claude Code's own summary: its fall is seen
    record(st, $, row);
    if (action.decision === 'native' && action.why !== 'manual') say(st, $, `forward-compaction: ${label} ${action.why === 'ceiling' ? `reached its ceiling ${k(m!.ceiling)}` : 'was too long for its request'} with no frontier; Claude Code's own summary ran (FORWARD_COMPACTION_CEILING_NATIVE=1).`, 'info', { event: 'native', where: 'compactAsk', party: key, why: action.why });
    return pass();
  }
  if (action.action === 'skip') {
    // A precompute is no ask for a frontier: only a held one makes the next ask reactive (D8).
    if (action.why !== 'precompute') st.parties.asked(key, 'skip');
    record(st, $, { ...row, reason: action.reason });
    return { skip: action.reason };
  }
  const shared = { messages: e.messages, party: kind === 'main' ? ('main' as const) : ('subagent' as const), tokens, askPoint: m?.askPoint ?? 0, charsPerToken: ratioOf(st, $, key, 'compact', await partyChars(st, $, key, e.agentId), m), now: await $.clock.now(), facts: (kept: readonly string[]) => factsFor(st.ledger, key, { keptTexts: kept, ...(action.action === 'install' ? { since: held!.since } : {}) }), agents: await agentRows($), logDir: st.pluginLogDir, orders: action.action === 'install' ? { standing: held!.standingOrders ?? [], lifted: held!.lifted ?? [] } : { standing: party.orders ?? [] }, ...(e.agentId !== undefined ? { self: e.agentId } : {}) };
  const wake = action.action === 'install'
    ? buildWake({ ...shared, toolUseId: held!.toolUseId, frontier: held!.text, tool: st.toolNames.forward_compaction, files: await readLoadFiles($, held!.loadFiles) })
    : mechanicalWake({ ...shared, tool: st.toolNames.forward_compaction, reason: action.why === 'ceiling' ? { kind: 'ceiling', ceiling: m!.ceiling } : { kind: 'reactive' } });
  dbg(st, $, 'wake', { party: key, kind: action.action, ratio: shared.charsPerToken ?? null, askPoint: shared.askPoint, sizes: wake.sizes, headChars: wake.headChars, carried: wake.carried, notCarried: wake.notCarried, kept: wake.kept, dropped: wake.dropped });
  installed(st, $, key, action.action === 'install' ? { kind: 'frontier', label, before: tokens, chars: held!.text.length, facts: wake.facts, kept: wake.kept, dropped: wake.dropped } : { kind: 'mechanical', label, before: tokens, tokens, ceiling: m?.ceiling ?? 0 }, signal);
  record(st, $, { ...row, facts: wake.facts, kept: wake.kept, dropped: wake.dropped });
  return { messages: wake.messages, ...(tokens !== undefined ? { tokensBefore: tokens } : {}) }; // tokensAfter: the next reading measures it (M2)
}

/** A party's live-window characters through `$.session.messages({ as: 'api' })` (main: no agentId), what its reading counts; a denied or failed read is said in its row and is no count. */
async function partyChars(st: State, $: EngineInterface, key: string, agentId: unknown): Promise<number | undefined> {
  return Promise.resolve().then(() => (typeof agentId !== 'string' ? $.session.messages({ as: 'api' }) : $.session.messages({ as: 'api', agentId }))).then((found) => ('deny' in found ? (dbg(st, $, 'session.messages-denied', { party: key, deny: found.deny }), undefined) : apiChars(found)), (error: unknown) => (dbg(st, $, 'session.messages-failed', { party: key, error: message(error) }), undefined));
}

/** A party's measured characters per token on its growth since its base, every count the live window `$.session.messages({ as: 'api' })` answers; unmeasured, or with no marks, nothing is converted, and its row says why. */
function ratioOf(st: State, $: EngineInterface, key: string, at: 'compact' | 'tool-call', chars: number | undefined, m: Marks | undefined): number | undefined {
  const { reading, base } = st.parties.get(key);
  const r: { ratio?: number; why?: string; delta?: number } = m === undefined ? { why: 'no-marks' } : charsPerToken(base, chars, reading);
  dbg(st, $, r.ratio === undefined ? 'ratio-unmeasured' : 'ratio', { party: key, at, baseChars: base?.chars ?? null, baseTokens: base?.tokens ?? null, chars: chars ?? null, reading: reading ?? null, ...r });
  return r.ratio;
}

/** C11 (R35): an ask whose handling threw gets a mechanical wake, never the engine's summarizer by accident (A2); only when that throws too does Claude Code's own summary run. */
async function compactFailed(st: State, $: EngineInterface, e: SessionCompactInput, key: PartyKey, error: unknown, pass: () => Promise<SessionCompactResult>, signal?: AbortSignal): Promise<SessionCompactResult> {
  const party = st.parties.get(key);
  const said = `forward-compaction: error in session.compact for ${party.label}: ${message(error)}`;
  try {
    const tokens = party.reading;
    const m = marks(st, key);
    const wake = mechanicalWake({ messages: e.messages, party: key === 'main' ? 'main' : 'subagent', tokens, askPoint: m?.askPoint ?? 0, charsPerToken: ratioOf(st, $, key, 'compact', await partyChars(st, $, key, e.agentId), m), now: Date.now(), facts: (kept) => factsFor(st.ledger, key, { keptTexts: kept }), orders: { standing: party.orders ?? [] }, tool: st.toolNames.forward_compaction, logDir: st.pluginLogDir, reason: m === undefined ? { kind: 'reactive' } : { kind: 'ceiling', ceiling: m.ceiling } });
    installed(st, $, key, undefined, signal); // the error line below is said now; no landing waits
    say(st, $, `${said}; a mechanical wake was installed.`, 'error', { event: 'compact', where: 'compactFailed', party: key, decision: 'error', error: message(error), kept: wake.kept, dropped: wake.dropped });
    return { messages: wake.messages, ...(tokens !== undefined ? { tokensBefore: tokens } : {}) };
  } catch (again) {
    say(st, $, `${said}; Claude Code's own summary ran.`, 'error', { event: 'compact', where: 'compactFailed', party: key, decision: 'error', error: message(error), fallback: message(again) });
    return pass();
  }
}

/** Main's window and Claude Code's ask point, at session start, at main's first step when not read yet, and after its model changed (/model, `model`); a failed read keeps what is known. */
async function readMainWindow(st: State, $: EngineInterface, model?: string): Promise<void> {
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' });
    const b = context.breakdown;
    dbg(st, $, 'session.usage', { model: model ?? null, window: context.window ?? null, tokens: context.tokens ?? null, autoCompactThreshold: b?.autoCompactThreshold ?? null, rawMaxTokens: b?.rawMaxTokens ?? null, autocompactSource: b?.autocompactSource ?? null, isAutoCompactEnabled: b?.isAutoCompactEnabled ?? null, breakdownModel: b?.model ?? null });
    const window = typeof context.window === 'number' && context.window > 0 ? context.window : st.mainWindow;
    if (model !== undefined && st.mainWindow !== undefined && window !== st.mainWindow) record(st, $, { event: 'window-changed', party: 'main', model, from: st.mainWindow, to: window });
    Object.assign(st, { mainWindow: window, breakdown: b, apiAsk: askPointOf(b, window) });
    const missing = st.apiAsk?.missing;
    if (missing !== undefined) warnOnce(st, $, 'readMainWindow', `ask-point-missing:${missing}`, `forward-compaction: $.session.usage reported no ${missing === 'breakdown' ? 'context breakdown' : 'autoCompactThreshold (auto-compaction is off)'}; Claude Code's ask point is taken as its ${st.apiAsk!.source} ${k(st.apiAsk!.tokens)}`);
  } catch (error) {
    warnOnce(st, $, 'readMainWindow', 'usage-read-failed', `forward-compaction: reading main's context window${model === undefined ? '' : ` after its model changed to ${model}`} failed: ${message(error)}; ${st.mainWindow === undefined ? "main's window stays unknown" : `keeping ${k(st.mainWindow)}`}`);
  }
}

/** A step's usage is the party's reading; a sharp fall nobody here caused is an unseen compaction (R39). */
async function readStep(st: State, $: EngineInterface, e: TurnStepInput, r: TurnStepResult): Promise<void> {
  const key = keyOf(e.agentId);
  const u = r?.usage;
  dbg(st, $, 'turn.step', { party: key, model: e.model ?? null, input_tokens: u?.input_tokens ?? null, cache_read_input_tokens: u?.cache_read_input_tokens ?? null, cache_creation_input_tokens: u?.cache_creation_input_tokens ?? null, output_tokens: u?.output_tokens ?? null, usageModel: u?.model ?? null });
  if (key === 'main' && e.model !== undefined && (st.mainWindow === undefined || (st.parties.get(key).model ?? e.model) !== e.model)) await readMainWindow(st, $, e.model); // not read yet, or after /model
  st.parties.describe(key, { model: e.model }); await judge(st, $, key);
  if (key === 'main') st.pendingCommand = undefined;
  const tokens = readingTokens(u);
  if (tokens === undefined) return st.parties.answered(key);
  const party = st.parties.get(key);
  if (unseenCompaction(party.reading, tokens, st.installedSince.has(key))) {
    say(st, $, `forward-compaction: ${party.label}'s context fell from ${k(party.reading!)} to ${k(tokens)} with no compaction this plugin handled (another plugin or Claude Code compacted it).`, 'warning', { event: 'unseen-compaction', where: 'readStep', party: key, before: party.reading, after: tokens });
    st.parties.rebase(key, undefined);
  }
  const m = marks(st, key);
  const level = m === undefined ? 0 : nudgeLevel(tokens, m.start, m.every);
  dbg(st, $, 'reading', { party: key, tokens, level, from: party.reading ?? null, absorb: party.absorbNext });
  land(st, $, key, st.parties.read(key, tokens, level), tokens);
  st.installedSince.delete(key);
  if (party.base !== undefined || party.requests < (party.baseRetryAt ?? 0)) return; // the first reading in its live window takes the ratio's base (window.ts `charsPerToken`); a failed read backs off (`baseMissed`)
  const chars = await partyChars(st, $, key, e.agentId);
  dbg(st, $, 'ratio-base', { party: key, chars: chars ?? null, tokens });
  if (chars !== undefined) st.parties.rebase(key, { chars, tokens }); else st.parties.baseMissed(key);
}

/** P1 (R32): main's answered turn with a frontier stored compacts once. A sub-agent's turn end is one run, never its finish (a child's notification resumes it): its party stays, only a waiting landing is said. */
async function turnEnds(st: State, $: EngineInterface, e: TurnCompleteInput): Promise<void> {
  const key = keyOf(e.agentId);
  if (key !== 'main') return land(st, $, key, st.parties.takeLanding(key));
  const party = st.parties.get('main');
  const door = turnEndDoor({ main: true, reason: e.reason, stored: party.stored !== undefined, installedThisTurn: party.installedThisTurn });
  st.parties.turnEnded('main');
  if (!door.compact) return;
  try {
    const out = await $.session.compact();
    if (out.skip !== undefined) say(st, $, `forward-compaction: main's frontier did not install at turn end: ${out.skip}. It stays stored for the next turn end or ask.`, 'warning', { event: 'turn-end-skipped', where: 'turnEnds', party: 'main', skip: out.skip });
  } catch (error) {
    say(st, $, `forward-compaction: main's frontier did not install at turn end: ${message(error)}. It stays stored for the next turn end or ask.`, 'error', { event: 'turn-end-rejected', where: 'turnEnds', party: 'main', error: message(error) });
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
  if (isPersonOrigin(origin)) await keepKept(st, $, 'main');
}

/** The files a finished call touched and the task list it set, as the party's work (src/work.ts); main's answered AskUserQuestion, as the person's words. */
async function noteWork(st: State, $: EngineInterface, party: PartyKey, e: Record<string, unknown>, answer: ToolCallResult): Promise<void> {
  for (const fact of workOf(String(e.tool), toolInput(e), answer as CallAnswer)) st.ledger = addEntry(st.ledger, { kind: 'work', party, at: await $.clock.now(), fact });
  const answered = party === 'main' ? answersOf(String(e.tool), toolInput(e), answer as CallAnswer) : undefined;
  if (answered === undefined) return;
  st.ledger = addEntry(st.ledger, { kind: 'person', party: 'main', at: await $.clock.now(), text: answered.text, answer: answered.said });
  await keepKept(st, $, 'main');
}

/** A party's newest prompts and its loaded skills, held by the host for the session (contract.d.ts), so a plugin reload does not lose them; its standing orders are kept as its frontier is stored. */
async function keepKept(st: State, $: EngineInterface, party: PartyKey): Promise<void> {
  await restoreKept(st, $, party);
  const id = `${await (st.sessionId ??= $.session.id())}/${party}`;
  await $.state.set({ plugin: 'forward-compaction', key: 'prompts', id }, promptsKept(st.ledger, party));
  await $.state.set({ plugin: 'forward-compaction', key: 'skills', id }, skillsKept(st.ledger, party));
}

/** What a party kept before a plugin reload, its standing orders included, put back once per process: before its first write, so a write never drops it, before its drop check, and before its wake. */
async function restoreKept(st: State, $: EngineInterface, party: PartyKey): Promise<void> {
  if (st.restored.has(party)) return;
  st.restored.add(party);
  const id = `${await (st.sessionId ??= $.session.id())}/${party}`;
  st.ledger = restorePrompts(st.ledger, party, (await $.state.get({ plugin: 'forward-compaction', key: 'prompts', id })).value);
  st.ledger = restoreSkills(st.ledger, party, (await $.state.get({ plugin: 'forward-compaction', key: 'skills', id })).value);
  st.parties.restoreOrders(party, (await $.state.get({ plugin: 'forward-compaction', key: 'orders', id })).value);
  st.parties.restoreJudged(party, (await $.state.get({ plugin: 'forward-compaction', key: 'judged', id })).value);
}

/** A turn starts. A sub-agent's later run begins with what woke it (a background child's notification): recorded like a coordinator's message, once. */
async function noteRun(st: State, $: EngineInterface, e: TurnStartInput): Promise<void> {
  const key = keyOf(e.agentId);
  const first = key !== 'main' && st.parties.get(key).requests === 0; // the first run begins with the brief, recorded at agent.spawn
  st.parties.newTurn(key);
  if (key === 'main' || first || e.text === '') return;
  const last = [...st.ledger.entries].reverse().find((x) => (x.kind === 'brief' || x.kind === 'received') && x.party === key);
  if (last !== undefined && 'text' in last && last.text === e.text) return; // session.receive recorded it already
  st.ledger = addEntry(st.ledger, { kind: 'received', party: key, at: await $.clock.now(), origin: 'run-start', text: e.text });
  await keepKept(st, $, key);
}

async function noteReceived(st: State, $: EngineInterface, e: SessionReceiveInput): Promise<void> {
  if (e.agentId === undefined) return;
  st.ledger = addEntry(st.ledger, { kind: 'received', party: keyOf(e.agentId), at: await $.clock.now(), origin: originKind(e.origin), text: e.text });
  await keepKept(st, $, keyOf(e.agentId));
}

/** D5: the party a skill belongs to, from the calls in flight around it (the event names none). */
async function noteSkill(st: State, $: EngineInterface, e: SkillPromptInput): Promise<void> {
  const inFlightSkills = [...st.inFlight].filter(([, call]) => call.tool === 'Skill').map(([tool_use_id, call]) => ({ party: call.party, tool_use_id }));
  const { party, how } = attributeSkill({ inFlightSkills, pendingCommand: st.pendingCommand, pendingSpawns: st.pendingSpawns, skill: e.skill });
  st.ledger = addEntry(st.ledger, { kind: 'skill', party, at: await $.clock.now(), skill: e.skill, text: e.text, how, ...(pinnedBy(e.frontmatter) || st.config.keepSkills.includes(e.skill) ? { keep: true as const } : {}), ...(e.source !== undefined ? { source: e.source } : {}), ...(e.path !== undefined ? { path: e.path } : {}) });
  record(st, $, { event: 'skill', party, skill: e.skill, how });
  await keepKept(st, $, party);
}

/** A spawned agent's brief is its first fact, and the skills it preloaded become its own; a resume's prompt is a message delivered to it, never its brief. */
async function noteSpawn(st: State, $: EngineInterface, e: AgentSpawnInput, r: AgentSpawnResult): Promise<void> {
  const id = r?.agentId;
  if (typeof id !== 'string' || id === '') return;
  const key: PartyKey = `agent:${id}`;
  const fact = e.resume !== undefined ? (e.prompt === '' ? undefined : { kind: 'received' as const, party: key, at: await $.clock.now(), origin: 'resume', text: e.prompt }) : { kind: 'brief' as const, party: key, at: await $.clock.now(), text: e.prompt, description: e.description, subagentType: e.subagentType, spawnedBy: st.inFlight.get(e.tool_use_id)?.party ?? 'unknown' };
  st.ledger = resolveSpawn(fact === undefined ? st.ledger : addEntry(st.ledger, fact), e.tool_use_id, id);
  st.knownAgents.set(id, e.subagentType);
  st.parties.describe(key, { label: `${e.subagentType} ${id.slice(0, 6)}` }); await judge(st, $, key);
  await keepKept(st, $, key); // its brief, and its preloaded skills filed under the spawn until now
}

/** The shells and crons running at a stop: the latest snapshot is a fact of every wake. */
async function noteShells(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<void> {
  st.ledger = addEntry(st.ledger, { kind: 'shells', at: await $.clock.now(), ...shellsOf(e) });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const st: State = {
    config: resolveOptions(),
    ignoredOptions: options !== null && typeof options === 'object' ? Object.keys(options) : [],
    pluginRows: [], pluginInitialized: false, pluginWriting: Promise.resolve(), pluginFailing: false,
    toolNames: {}, toolTries: { forward_compaction: 0, look_back: 0 },
    warned: new Set(), logFailures: new Set(),
    pending: [], rowsWriting: 0, levelRowsWriting: 0, levelLinks: 0, levelBatched: 0, skips: new SkipFold(), levelSkips: new SkipFold(), writing: Promise.resolve(),
    parties: new Parties(), ledger: newLedger(), restored: new Set(),
    inFlight: new Map(), pendingSpawns: new Set(), knownAgents: new Map(), installedSince: new Set(),
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await ensureTools(st, $, next.signal);
    await guard(st, $, 'session.start', () => sessionBegins(st, $), e);
    return result;
  });

  on('tool.call', async ($, e, next) => {
    dbg(st, $, 'hook', hookRow('tool.call', e));
    if (st.toolNames.look_back !== undefined && e.tool === st.toolNames.look_back) return { result: await answerLookBackTool(st, $, e as Record<string, unknown>) };
    if (st.toolNames.forward_compaction !== undefined && e.tool === st.toolNames.forward_compaction) return { result: experimental(await answerForward(st, $, e as Record<string, unknown>), st.pluginLogDir) };
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
    await guard(st, $, 'tool.call work', () => noteWork(st, $, key, e, result));
    return (await unlessAborted(nudged(st, $, key, result), next.signal))?.value ?? result; // judging may read $.state and the session id: never past the abort
  });

  on('session.compact', async ($, e, next) => {
    const key = keyOf(e.agentId);
    dbg(st, $, 'hook', hookRow('session.compact', e));
    try {
      return await compactAsk(st, $, e, key, () => next(e), next.signal);
    } catch (error) {
      return compactFailed(st, $, e, key, error, () => next(e), next.signal);
    }
  });

  on('turn.step', async function* ($, e, next) {
    const r = yield* next(e);
    await guard(st, $, 'turn.step', () => readStep(st, $, e, r), e);
    return r;
  });

  on('turn.start', async ($, e, next) => {
    await guard(st, $, 'turn.start', () => noteRun(st, $, e), e);
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const r = await next(e);
    await guard(st, $, 'turn.complete', () => turnEnds(st, $, e), e);
    return r;
  });

  on('prompt.submit', async ($, e, next) => {
    await guard(st, $, 'prompt.submit', () => noteSubmit(st, $, e), e);
    return next(e);
  });

  on('session.receive', async ($, e, next) => {
    await guard(st, $, 'session.receive', () => noteReceived(st, $, e), e);
    return next(e);
  });

  on('skill.prompt', async ($, e, next) => {
    await guard(st, $, 'skill.prompt', () => noteSkill(st, $, e), e);
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
    await guard(st, $, 'agent.spawn', () => noteSpawn(st, $, e, r), e);
    return r;
  });

  on('classic.Stop', async ($, e, next) => {
    await guard(st, $, 'classic.Stop', () => noteShells(st, $, e as Record<string, unknown>), e);
    return next(e);
  });

  on('classic.SubagentStop', async ($, e, next) => {
    await guard(st, $, 'classic.SubagentStop', () => (land(st, $, keyOf(e.agent_id), st.parties.takeLanding(keyOf(e.agent_id))), noteShells(st, $, e as Record<string, unknown>)), e);
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    // A /clear or a resume ends the conversation, and the process goes on under a new session id with no session.start.
    const goesOn = e.reason === 'clear' || e.reason === 'resume';
    dbg(st, $, 'hook', { ...hookRow('session.end', e), reason: e.reason });
    if (goesOn) record(st, $, { event: 'cleared', party: 'main', reason: e.reason });
    for (const [key, landing] of st.parties.takeLandings()) land(st, $, key, landing); // ended with no reading after its install
    // The open skip streaks close now, and the session ends only once every queued row is written.
    for (const diagnostic of st.levelSkips.drain().map(pluginLogEvent)) if (diagnostic !== undefined) plog(st, $, diagnostic);
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
