import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';
import { bounded } from '../src/bounded.ts';
import { LOOK_BACK_TOOL, LOOK_BACK_DESCRIPTION, LOOK_BACK_INPUT_SCHEMA, parseLookBack, boundaryArgv, boundaryLine, searchArgv, entryArgv, namesArgv, processOutput, parseEntries, toolNames, resultIds, searchResults, entryResult, manualTranscriptCall, lookBackNotice, type LookBackResult } from '../src/look-back.ts';
import { servedOptions, toolsToRegister } from '../src/register.ts';
import { FORWARD_INPUT_SCHEMA, FORWARD_TOOL, FORWARD_TOOL_DESCRIPTION, forwardNudgeText, forwardRefusal, forwardStoredText, parseForwardArgs, rereadNudge, type ForwardArgs } from '../src/forward-args.ts';
import { absPath, fileTrail, handoffInReply, findTranscriptArgv, firstFound, gitBlock, gitLine, GIT_REPOS, heldForward, outsideRepository, opensWithSummary, openingSummary, summaryKnowledge, outline, OUTLINE_FILE_MAX_BYTES, priorCalls, priorPrompts, mergeTrail, invocationPaths, invocations, parseLineRange, parsePorcelain, planAndTasks, runningWork, sliceLines, trailDirs, userMessages, type ApiMsg, type LiveWork, type TrailEntry } from '../src/forward-carry.ts';
import { buildRecord, carriedFrom, forwardDir, forwardRoots, forwardSessionDir, nextSeq, previousDir, recoverForward, withInstall } from '../src/forward-record.ts';
import { chainUsers, forwardInstalledLine, installCheck, renderForward, TRAIL_MAX, type BlockRecord, type RenderInput } from '../src/forward-text.ts';
import { BRIEF_MAX_TOKENS, reseatBrief, seatedBrief } from '../src/brief.ts';
import { engineAgentFs } from '../src/agent-fs.ts';
import { AgentPolicies, AgentTypes, hasTool } from '../src/agents.ts';
import { compactionEnd, contextTokens, currentTokens, decide, estimateTranscript, knownTrigger, personPrompt, type Trigger } from '../src/decide.ts';
import {
  CONTINUE_AFTER_HANDOFF,
  HANDOFF_INPUT_SCHEMA,
  HANDOFF_TOOL,
  HANDOFF_TOOL_DESCRIPTION,
  handoffDisarmedText,
  handoffInputOf,
  handoffMarkerRequest,
  handoffNotice,
  handoffNudgeText,
  handoffProblem,
  handoffRefusal,
  handoffStopRequest,
  handoffStoredText,
  installHandoff,
  installLine,
  parseHandoff,
  recoverHandoff,
  transcriptShapeProblem,
  type ArmedHandoff,
  type ForwardMeta,
} from '../src/handoff.ts';
import { resolveOptions, sizeTokens, type Policy, type ResolvedOptions } from '../src/limits.ts';
import { sessionLogPath, decisionAppendArgv, retentionArgv, SkipFold, pluginLogDir, levelRow, pluginLogEvent, PluginLogQueue, type PluginLogLevel, type PluginLogFields } from '../src/log.ts';
import { armedText, CONTINUE_AFTER_MARKER, disarmedText, earlyArm, markerRequest, nudgeText, stopRequest } from '../src/nudge.ts';
import { FRESH_MAX_MESSAGES, isFirstRequest, Parties } from '../src/parties.ts';
import { engineAskPoint, forcedPoint, isHaiku, modelWindow } from '../src/window.ts';
import { unseenCompaction } from '../src/unseen.ts';
import { invokedSkills, pluginPaths, renderWake, stripFrontmatter, wakeCandidates, wakeFileProblem, WAKE_FILE_MAX_BYTES, type WakeEntry, type WakeRoots } from '../src/wake.ts';

// Thin adapter: every decision lives in src/. Each hook catches its own
// failures, logs them with context and lets the compaction through.

const COMPACT_TOOL = 'compact';
/** The main chat's window when $.session.usage() cannot be read. */
const FALLBACK_WINDOW = 200_000;

/** A line on the person's screen: Claude Code already names the plugin in front of it, so the line never names it again. */
function show($: EngineInterface, line: string): void {
  $.ui.log(screenLine(line));
}

function screenLine(line: string): string {
  return line.replace(/^sub-agent-compact: /, '');
}

/**
 * Every line said lands in the decision log as a `said` row; a routine one reaches the screen too while there is no
 * log to hold it. A line said with its diagnostic row is one level-log entry: the row's, at the level said.
 */
function say(st: State, $: EngineInterface, line: string, level: PluginLogLevel = 'error', row?: Row): void {
  const shown = level !== 'info' || !st.config.logFile || st.logOff === true;
  if (shown) show($, line);
  record(st, $, { event: 'said', line: screenLine(line), shown });
  const diagnostic = row === undefined ? undefined : pluginLogEvent(row);
  plog(st, $, diagnostic !== undefined ? { ...diagnostic, level } : { level, event: 'said', msg: screenLine(line), where: 'hooks/sub-agent-compact.ts#say' });
  if (row !== undefined) record(st, $, row, diagnostic === undefined);
}
/** The model's tool-call lines of a transcript before line $2, the newest 400: sed cuts at the boundary, so no line's length matters. */
const CALLS_BEFORE = `sed -n "1,$(($2 - 1))p" "$1" | grep -a -n '"type":"assistant"' | grep -a '"tool_use"' | tail -n 400`;
/** Registering the tools holds a turn no longer than this: past it the turn goes on and the plugin stops waiting on registration. */
const ENSURE_TOOLS_TIMEOUT_MS = 5_000;
/** Of session.end's one bound, the share left for Claude Code's own end step after the log writes. */
const END_CORE_RESERVE_MS = 300;
/** Registering a tool is tried on this many hook calls before it is given up on. */
const REGISTER_TRIES = 3;

type Row = Record<string, unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type State = {
  config: ResolvedOptions;
  rawOptions: Record<string, unknown>;
  pluginLog?: PluginLogQueue;
  pluginInitialized: boolean;
  pluginRows: Omit<PluginLogFields, 'plugin' | 'session'>[];
  pluginLogDir?: string;
  pluginWriting: Promise<void>;
  pluginFailing: boolean;
  started?: Promise<void>;
  policies?: AgentPolicies;
  /** CLAUDE_CODE_AUTO_COMPACT_WINDOW: the window Claude Code compacts against, so it asks from that less its buffer. */
  compactWindow?: number;
  /** The main chat's model window, from $.session.usage(). */
  mainWindow?: number;
  /** The compact tool's full name once registered. */
  toolName?: string;
  /** The handoff tool's full name once registered. */
  handoffToolName?: string;
  /** The forward handoff tool's full name once registered. */
  forwardToolName?: string;
  /** Always-on recovery tool, independent of every compaction option. */
  lookBackToolName?: string;
  /** Cached transcript filename for manual main-party observation; no process runs. */
  sessionId?: Promise<string>;
  /** The last forward handoff number given out per session: two calls listing the directory together still get two numbers. */
  forwardSeq: Map<string, number>;
  /** A forward handoff installed and not yet checked against what the party holds at its next request, by party. */
  forwardInstalled: Map<string, { meta: ForwardMeta; text: string; tokensAfter: number; before: number | undefined; label: string }>;
  /** The parties a forward handoff was installed in: a second one is refused below their first nudge point. */
  forwardWoke: Set<string>;
  /** Parties already sent back once for a `next` that re-reads what the wake carries. */
  rereadNudged: Set<string>;
  /** The home directory, for `~/` in a path. */
  home?: string;
  /** The main chat's in-flight work as the last turn's end reported it, and the calls made since. */
  live?: { tasks: LiveWork['tasks']; crons: LiveWork['crons']; started: Set<string> };
  /** How many times registering each tool was tried. */
  toolTries: { handoff: number; compact: number; forward: number; look_back: number };
  /** The registration in progress: hooks that need a tool wait on it, so none registers twice. */
  registering?: Promise<void>;
  /** Registering the tools has not finished within ENSURE_TOOLS_TIMEOUT_MS: no hook waits on it until it settles, and a late finish still names the tools. */
  toolsAbandoned?: boolean;
  /** Every enabled tool is registered or out of tries: no hook registers or sets a timer again. */
  toolsSettled?: boolean;
  /** The session's cwd and Claude config directory, where skills and commands are read from. */
  cwd?: string;
  configDir?: string;
  /** `${party}:${tool_use_id}` of every handoff call this plugin installed, so one is never installed again from the transcript. */
  settled: Set<string>;
  /** Each sub-agent's type: announced by SubagentStart or SubagentStop, else from `$.agent.list()`. */
  types: AgentTypes;
  /** Per party ("main" or an agent id): its model, from its last response. */
  models: Map<string, string>;
  parties: Parties;
  asked: Set<string>;
  warned: Set<string>;
  /** The log-write failures already shown: a log that cannot be written fails every flush the same way, and the person hears each failure once. */
  logFailures: Set<string>;
  pending: string[];
  /** Rows the decision append in flight carries; 0 when none is. */
  rowsWriting: number;
  /** Level-log rows queued or being written: what a cut end flush may lose from the level log. */
  levelRowsWriting: number;
  /** The main chat's window per model, as read after a model change. */
  modelWindows: Map<string, number>;
  /** Routine skips fold into one `skips` row per streak. */
  skips: SkipFold;
  /** Old sessions' logs were cleaned up once this session (or tried). */
  retained?: boolean;
  logPath?: Promise<string | undefined>;
  /** Reading the session id failed: no row is written this session, so a routine line goes to the screen. */
  logOff?: boolean;
  writing: Promise<void>;
  mainCompactedThisTurn: boolean;
  mainCompacting: boolean;
  /** A session.compact of main was handled (or the plugin compacted main itself) since main's last reading. */
  mainCompactSeen: boolean;
  /** Where each sub-agent runs, learned at its spawn: its own relative paths land there, not where the main chat's shell is now. */
  agentCwd: Map<string, string>;
};

/** Level logging is off the work path; failures report through show, never recursively through say. */
function plog(st: State, $: EngineInterface, fields: Omit<PluginLogFields, 'plugin' | 'session'>): void {
  const queue = st.pluginLog;
  if (queue === undefined) { if (!st.pluginInitialized) st.pluginRows.push(fields); return; }
  st.levelRowsWriting += 1;
  st.pluginWriting = st.pluginWriting.then(async () => {
    let session: string | undefined;
    try { session = await $.session.id(); }
    catch (error) { show($, `sub-agent-compact: reading the plugin log session id failed: ${message(error)}; row has no session`); }
    const now = await $.clock.now();
    queue.add(levelRow({ plugin: 'sub-agent-compact', ...fields, ...(session ? { session } : {}) }, now));
    const out = await queue.flush((argv) => $.process.run(argv, { timeoutMs: 15_000 }));
    if (out.error !== undefined && !st.pluginFailing) pluginLogFailed(st, $, out.error, out.dropped);
    st.pluginFailing = out.dropped !== 0;
  }).catch((error) => {
    if (!st.pluginFailing) pluginLogFailed(st, $, message(error), 1);
    st.pluginFailing = true;
  }).finally(() => { st.levelRowsWriting -= 1; });
}

/** Once per failing streak: on the screen and in the decision log, whose row maps to no level, so it never recurses into the failing log. */
function pluginLogFailed(st: State, $: EngineInterface, error: string, dropped: number): void {
  show($, `sub-agent-compact: plugin log ${st.pluginLogDir} failed: ${error}; dropped ${dropped} ${dropped === 1 ? 'row' : 'rows'}`);
  record(st, $, { event: 'plugin-log-failed', dir: st.pluginLogDir ?? null, error, dropped });
}

// Rows queue in memory; each flush appends them to the session's file through the append script, under its
// lock, so a resumed session keeps its earlier rows, no row is rewritten and no other chat shares the file.
function record(st: State, $: EngineInterface, row: Row, levelRow = true): void {
  const diagnostic = levelRow ? pluginLogEvent(row) : undefined;
  if (diagnostic !== undefined) plog(st, $, diagnostic);
  if (!st.config.logFile) return;
  for (const out of st.skips.add({ ts: new Date().toISOString(), ...row })) st.pending.push(JSON.stringify(out));
  flushDecisions(st, $);
}

function flushDecisions(st: State, $: EngineInterface): void {
  const file = st.config.logFile;
  if (!file) return;
  st.logPath ??= $.session.id().then(
    (id) => sessionLogPath(file, id),
    (error) => {
      // Screen only: the log this line would land in is the one that is off.
      st.logOff = true;
      show($, `sub-agent-compact: reading the session id failed: ${message(error)}; the decision log is off for this session`);
      return undefined;
    },
  );
  // Taken now: rows queued before a /clear go to the ending session's file even when they are written after startOver.
  const logPath = st.logPath;
  const pending = st.pending;
  st.writing = st.writing
    .then(async () => {
      const path = await logPath;
      const rows = pending.splice(0);
      if (!path || rows.length === 0) return;
      st.rowsWriting = rows.length;
      if (!st.retained) {
        st.retained = true;
        await retainLogs(st, $, file, path);
      }
      const out = await $.process.run(decisionAppendArgv(path), { stdin: rows.map((line) => `${line}\n`).join(''), timeoutMs: 15_000 });
      if (out.exitCode !== 0) throw new Error(out.stderr.split('\n')[0]?.trim() || `the append script exited ${out.exitCode}`);
    })
    .finally(() => { st.rowsWriting = 0; })
    // Screen only, once per distinct failure: logging a failed log write would queue another write. The key drops
    // numbers, so one failure whose text carries a varying size or offset is still shown once.
    .catch((error) => {
      const line = `sub-agent-compact: writing the decision log for ${file} failed: ${message(error)}`;
      const key = line.replace(/\d+/g, '#');
      if (st.logFailures.has(key)) return;
      st.logFailures.add(key);
      show($, line);
      plog(st, $, { level: 'error', event: 'decision-log-failed', msg: line, where: 'hooks/sub-agent-compact.ts#flushDecisions', detail: { file, error: message(error) } });
    });
}

/** Once per session, before its first append: old sessions' logs beside this one go; a failure is told once and the log goes on. */
async function retainLogs(st: State, $: EngineInterface, file: string, path: string): Promise<void> {
  try {
    const out = await $.process.run(retentionArgv(file, path), { timeoutMs: 15_000 });
    if (out.exitCode !== 0) throw new Error(out.stderr.split('\n')[0]?.trim() || `the retention script exited ${out.exitCode}`);
  } catch (error) {
    const line = `sub-agent-compact: cleaning up old decision logs beside ${file} failed: ${message(error)}; they stay`;
    show($, line);
    plog(st, $, { level: 'warning', event: 'decision-retention-failed', msg: line, where: 'hooks/sub-agent-compact.ts#retainLogs', detail: { file, error: message(error) } });
  }
}

/** Main's context was compacted and this plugin knows it: the next reading's drop is no unseen compaction, and turn.complete does not compact again. */
function mainCompacted(st: State): void {
  st.mainCompactSeen = true;
  st.mainCompactedThisTurn = true;
}

/** After a /clear or a resume: main's conversation is a new one, under a new session id and its own decision log file. */
function startOver(st: State): void {
  st.parties.forget('main');
  st.forwardWoke.delete('main');
  st.forwardInstalled.delete('main');
  st.rereadNudged.delete('main');
  st.asked.delete('main');
  st.mainCompactSeen = false;
  st.mainCompactedThisTurn = false;
  st.live = undefined;
  st.sessionId = undefined;
  st.logPath = undefined;
  st.pending = [];
  st.retained = false;
}

function warnOnce(st: State, $: EngineInterface, key: string, line: string): void {
  if (st.warned.has(key)) return;
  st.warned.add(key);
  say(st, $, line, 'warning', { event: 'warning', key, line });
}

// First hook call: report option errors, learn the native window, build the resolver.
function start(st: State, $: EngineInterface): Promise<void> {
  st.started ??= (async () => {
    let cwd = '.';
    let home: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch (error) {
      say(st, $, `sub-agent-compact: reading the session cwd failed: ${message(error)}; using relative paths`, 'warning');
    }
    st.cwd = cwd;
    try {
      home = await $.env.get('HOME');
      st.home = home;
    } catch (error) {
      say(st, $, `sub-agent-compact: reading HOME failed: ${message(error)}; skipping ~/.claude/agents`, 'warning');
    }
    let override: string | undefined;
    try {
      override = await $.env.get('PLUGIN_LOG_DIR');
    } catch (error) {
      say(st, $, `sub-agent-compact: reading PLUGIN_LOG_DIR failed: ${message(error)}; using HOME fallback`, 'warning');
    }
    st.pluginInitialized = true;
    st.pluginLogDir = pluginLogDir(override, home, 'sub-agent-compact');
    if (st.pluginLogDir !== undefined) st.pluginLog = new PluginLogQueue(st.pluginLogDir, 'sub-agent-compact');
    else show($, 'plugin log off: no PLUGIN_LOG_DIR and no HOME');
    const earlyRows = st.pluginRows.splice(0);
    if (st.pluginLog !== undefined) for (const fields of earlyRows) plog(st, $, fields);
    st.config = servedOptions(resolveOptions(st.rawOptions, { pluginLogDir: override }));
    plog(st, $, { level: 'info', event: 'logger-ready', msg: 'plugin logger ready', where: 'hooks/sub-agent-compact.ts#start', detail: { version: '0.7.0-dev.23', dir_source: override ? 'PLUGIN_LOG_DIR' : 'fallback' } });
    for (const line of st.config.errors) {
      say(st, $, line, 'warning', { event: 'option-error', line });
    }
    try {
      st.configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) || (home ? `${home}/.claude` : undefined);
    } catch (error) {
      say(st, $, `sub-agent-compact: reading CLAUDE_CONFIG_DIR failed: ${message(error)}; load_on_wake reads ~/.claude only`, 'warning');
      st.configDir = home ? `${home}/.claude` : undefined;
    }
    try {
      st.mainWindow = (await $.session.usage()).context.window;
    } catch (error) {
      say(st, $, `sub-agent-compact: reading the main chat's window failed: ${message(error)}; percentages use ${FALLBACK_WINDOW}`, 'warning');
    }
    try {
      const raw = await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) st.compactWindow = parsed;
    } catch (error) {
      say(st, $, `sub-agent-compact: reading CLAUDE_CODE_AUTO_COMPACT_WINDOW failed: ${message(error)}`, 'warning');
    }
    const dirs = [`${cwd}/.claude/agents`, ...(home ? [`${home}/.claude/agents`] : []), ...st.config.agentDirs];
    const resolveLog = (line: string) => {
      say(st, $, line, 'warning', { event: 'resolve-error', line });
    };
    st.policies = new AgentPolicies(
      dirs,
      st.config.subagent,
      engineAgentFs({ exists: (path) => $.fs.exists(path), read: (path) => $.fs.read(path), list: (dir) => $.fs.list(dir), stat: (path) => $.fs.stat(path) }, resolveLog),
      resolveLog,
      // A plugin's agent type (`plugin:agent`) is defined in that plugin's install, as installed_plugins.json names it.
      { pluginDirs: async (plugin) => { const path = (await wakeRoots(st, $)).plugins[plugin]; return path ? [`${path}/agents`] : []; } },
    );
    if (!st.config.handoffTool && !st.config.compactTool && !st.config.forwardHandoffTool) {
      warnOnce(st, $, 'no-tools', 'sub-agent-compact: no self-compaction tool is on (handoffTool, compactTool and forwardHandoffTool are all off); parties are nudged by nobody and only compacted at their limits');
    }
    record(st, $, { event: 'start', main: st.config.main, subagent: st.config.subagent, agentDirs: dirs, mainWindow: st.mainWindow ?? null, compactWindow: st.compactWindow ?? null });
  })();
  return st.started;
}

/** The agent's type; undefined for an engine loop (a fork of its own) that no hook announced and `$.agent.list()` does not list. */
async function agentType(st: State, $: EngineInterface, agentId: string): Promise<string | undefined> {
  return st.types.of(agentId, () => $.agent.list());
}

type Party = {
  /** "main" or the agent id: the key of every per-party map. */
  key: string;
  /** "main" or the sub-agent's type. */
  label: string;
  main: boolean;
  policy: Policy;
  /** Where the policy came from: mainAutoCompact*, subagentAutoCompact*, or a definition file. */
  source: string;
  window: number;
  /** Haiku is left to Claude Code: no nudge, no hold, no forced point, no handoff, no brief seated back. */
  haiku: boolean;
  /** An engine loop missing from `$.agent.list()`: no policy governs it, so it is never nudged, armed or held. */
  unlisted: boolean;
  /** Whether its definition's `tools` and `disallowedTools` leave it a tool; the main chat and a party without lists have every tool. */
  canUse: (tool: string) => boolean;
};

const everyTool = (): boolean => true;

async function partyOf(st: State, $: EngineInterface, agentId: string | undefined): Promise<Party> {
  await start(st, $);
  const key = agentId ?? 'main';
  const model = st.models.get(key);
  const window = modelWindow(model, st.mainWindow ?? FALLBACK_WINDOW);
  if (!agentId) return { key, label: 'main', main: true, policy: st.config.main, source: 'mainAutoCompact', window, haiku: isHaiku(model), unlisted: false, canUse: everyTool };
  const label = await agentType(st, $, agentId);
  if (label === undefined) return { key, label: 'unlisted', main: false, policy: st.config.subagent, source: 'unlisted', window, haiku: isHaiku(model), unlisted: true, canUse: everyTool };
  const resolved = await st.policies!.resolve(label);
  const source = resolved.source === 'default' ? 'subagentAutoCompact' : resolved.source;
  const canUse = (tool: string) => hasTool(resolved.tools, resolved.disallowedTools, tool);
  return { key, label, main: false, policy: resolved.policy, source, window, haiku: isHaiku(model), unlisted: false, canUse };
}

/** The forced point in tokens, clamped to Claude Code's ask point for the party's window; Haiku's is that ask point. */
function forcedOf(party: Party): { limit: number; set: number; clamped: boolean } {
  if (!party.haiku) return forcedPoint(party.policy.autoCompact, party.window);
  const ask = engineAskPoint(party.window);
  return { limit: ask, set: ask, clamped: false };
}

/** The forced point, a clamp said once per party type; `limitSet` beside `limit` in a row whenever it was clamped. */
function limitOf(st: State, $: EngineInterface, party: Party): { limit: number; row: Row } {
  const forced = forcedOf(party);
  if (!forced.clamped) return { limit: forced.limit, row: { limit: forced.limit } };
  warnOnce(st, $, `clamped:${party.label}`, `sub-agent-compact: ${party.label} limit ${forced.set} is past Claude Code's ask point ${forced.limit} for its ${party.window}-token window; it is forced at ${forced.limit}`);
  return { limit: forced.limit, row: { limit: forced.limit, limitSet: forced.set } };
}

function askPointOf(st: State): number | undefined {
  return st.compactWindow === undefined ? undefined : engineAskPoint(st.compactWindow);
}

/** The main chat's window, read again after its model changed; a failed read keeps the one known. */
async function rereadWindow(st: State, $: EngineInterface, model: string): Promise<void> {
  try {
    // A router that switches models per request asks once per model, never once per request.
    const window = st.modelWindows.get(model) ?? (await $.session.usage()).context.window;
    if (typeof window !== 'number' || !(window > 0)) return;
    st.modelWindows.set(model, window);
    if (window === st.mainWindow) return;
    record(st, $, { event: 'window-changed', party: 'main', model, from: st.mainWindow ?? null, to: window });
    st.mainWindow = window;
  } catch (error) {
    say(st, $, `sub-agent-compact: re-reading the main chat's window after its model changed to ${model} failed: ${message(error)}; keeping ${st.mainWindow ?? FALLBACK_WINDOW}`, 'warning');
  }
}

type Stored = { why: 'refused' | 'invalid'; text: string } | undefined;

/**
 * Stores the party's handoff. Undefined once stored; otherwise why it was not
 * and the text the party reads: refused (Haiku, unlisted, below its first
 * nudge point) or invalid (a marker's text outside the length rules; the
 * tool's text was checked when it was parsed).
 */
function storeHandoff(st: State, $: EngineInterface, party: Party, handoff: ArmedHandoff, via: 'tool' | 'marker' | 'stop'): Stored {
  const tokens = st.parties.reading(party.key);
  const refused = handoffRefusal({ haiku: party.haiku, unlisted: party.unlisted, tokens, nudgeStart: sizeTokens(party.policy.nudgeStart, party.window) });
  if (refused !== undefined) {
    record(st, $, { event: 'handoff-refused', via, party: party.key, type: party.label, why: party.haiku ? 'haiku' : party.unlisted ? 'unlisted' : 'early', tokens: tokens ?? null });
    return { why: 'refused', text: refused };
  }
  if (via !== 'tool') {
    const problem = handoffProblem(handoff.text);
    if (problem !== undefined) {
      record(st, $, { event: 'handoff-invalid', via, party: party.key, type: party.label, chars: handoff.text.length });
      return { why: 'invalid', text: problem };
    }
  }
  st.parties.armHandoff(party.key, handoff);
  record(st, $, { event: 'handoff-stored', via, party: party.key, type: party.label, tokens: tokens ?? null, chars: handoff.text.length, loads: handoff.loads?.length ?? 0 });
  return undefined;
}

/** Records the party's own request to compact; returns why it was refused (Haiku, unlisted, below its first nudge point), or undefined once armed. */
function arm(st: State, $: EngineInterface, party: Party, focus: string, via: 'tool' | 'marker' | 'stop'): string | undefined {
  const tokens = st.parties.reading(party.key);
  if (party.haiku || party.unlisted) {
    record(st, $, { event: 'arm-refused', via, party: party.key, type: party.label, why: party.haiku ? 'haiku' : 'unlisted' });
    return 'Not armed: self-compaction is off for Haiku agents; Claude Code compacts them at its own point.';
  }
  const early = earlyArm({ tokens, nudgeStart: sizeTokens(party.policy.nudgeStart, party.window) });
  if (early !== undefined) {
    record(st, $, { event: 'arm-refused', via, party: party.key, type: party.label, why: 'early', tokens: tokens ?? null });
    return early;
  }
  st.parties.arm(party.key, focus);
  record(st, $, { event: 'armed', via, party: party.key, type: party.label, tokens: tokens ?? null, focus });
  return undefined;
}

/** The nudge line owed after this tool call, once the party's context passed a nudge point it was not yet told about. */
async function nudgeFor(st: State, $: EngineInterface, agentId: string | undefined): Promise<string | undefined> {
  const party = await partyOf(st, $, agentId);
  if (party.haiku || party.unlisted || !party.policy.enabled) return undefined;
  if (!st.config.handoffTool && !st.config.compactTool && !st.config.forwardHandoffTool) return undefined;
  // Every party whose definition leaves it the forward handoff tool is steered to it once it is registered; one without it is never pointed at it.
  const forward = st.forwardToolName !== undefined && party.canUse(st.forwardToolName);
  // Without the forward tool this party has only the handoff and compact tools: with both off there is nothing to nudge toward.
  if (!forward && !st.config.handoffTool && !st.config.compactTool) return undefined;
  if (!forward && st.config.handoffTool && party.main && st.handoffToolName === undefined) {
    // The main chat has no marker to fall back on: nudging it to a tool that is not there only wastes its turn.
    warnOnce(st, $, 'main-no-handoff', 'sub-agent-compact: the main chat cannot hand off: the handoff tool is not registered, so it is not nudged');
    return undefined;
  }
  // A party whose definition leaves it no compact tool is never pointed at it.
  const compactTool = st.toolName ?? `mcp__sub-agent-compact__${COMPACT_TOOL}`;
  if (!forward && !st.config.handoffTool && !party.canUse(compactTool)) return undefined;
  const nudgeStart = sizeTokens(party.policy.nudgeStart, party.window);
  const nudgeEvery = sizeTokens(party.policy.nudgeEvery, party.window);
  const level = st.parties.nudgeDue(party.key, nudgeStart, nudgeEvery);
  const tokens = st.parties.reading(party.key);
  if (level === undefined || tokens === undefined) return undefined;
  const autoCompact = limitOf(st, $, party).limit;
  record(st, $, { event: 'nudge', party: party.key, type: party.label, tokens, level, nudgeStart, nudgeEvery, autoCompact, window: party.window, tool: forward ? FORWARD_TOOL : st.config.handoffTool ? 'handoff' : 'compact' });
  if (forward) return forwardNudgeText({ tokens, level, autoCompact, toolName: st.forwardToolName! });
  if (st.config.handoffTool) {
    const toolName = st.handoffToolName !== undefined && party.canUse(st.handoffToolName) ? st.handoffToolName : undefined;
    return handoffNudgeText({ tokens, level, autoCompact, main: party.main, toolName, firstReading: st.parties.firstReading(party.key) });
  }
  return nudgeText({ tokens, window: party.window, level, autoCompact, main: party.main, toolName: compactTool });
}

async function registerCompactTool(st: State, $: EngineInterface): Promise<void> {
  try {
    const { tool } = await $.tool.register({
      name: COMPACT_TOOL,
      description:
        'Compact your own context now, at a milestone you choose. The summary keeps what `focus` names, so name the plan or its file, what is done, what is left and the next step. Write anything you must not lose to a file first. Use it only once sub-agent-compact has nudged you; below that point it is refused.',
      inputSchema: {
        type: 'object',
        properties: { focus: { type: 'string', description: 'What the summary must keep: the plan or its file, what is done, what is left, the next step.' } },
        required: ['focus'],
      },
    });
    st.toolName = tool;
    record(st, $, { event: 'tool-registered', tool });
  } catch (error) {
    warnOnce(st, $, 'register-failed:compact', `sub-agent-compact: registering the ${COMPACT_TOOL} tool failed: ${message(error)}; models can still ask with <compact-now>`);
    record(st, $, { event: 'tool-register-failed', tool: COMPACT_TOOL, error: message(error) });
  }
}

async function registerLookBackTool(st: State, $: EngineInterface): Promise<void> {
  try {
    const { tool } = await $.tool.register({ name: LOOK_BACK_TOOL, description: LOOK_BACK_DESCRIPTION, inputSchema: LOOK_BACK_INPUT_SCHEMA });
    st.lookBackToolName = tool;
    record(st, $, { event: 'tool-registered', tool });
  } catch (error) {
    warnOnce(st, $, 'register-failed:look_back', `sub-agent-compact: registering the ${LOOK_BACK_TOOL} tool failed: ${message(error)}; transcript recovery is unavailable`);
    record(st, $, { event: 'tool-register-failed', tool: LOOK_BACK_TOOL, error: message(error), tries: st.toolTries.look_back });
  }
}

async function answerLookBackTool(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined;
  const party = agentId ?? 'main';
  const args = parseLookBack(handoffInputOf(e));
  let label = agentId === undefined ? 'main' : 'unlisted';
  let boundary: number | null = null;
  let result: LookBackResult;
  try {
    await start(st, $);
    if (agentId !== undefined) label = (await agentType(st, $, agentId)) ?? 'unlisted';
    if (st.configDir === undefined) throw new Error('no Claude config directory');
    const session = await (st.sessionId ??= $.session.id());
    const found = processOutput(await $.process.run(findTranscriptArgv({ configDir: st.configDir, session, ...(agentId !== undefined ? { agentId } : {}) }), { timeoutMs: 15_000 }), 'transcript lookup');
    const file = firstFound(found);
    if (file === undefined) throw new Error(`no transcript file for ${agentId === undefined ? `session ${session}` : `agent ${agentId}`}`);
    const bounds = processOutput(await $.process.run(boundaryArgv(file), { timeoutMs: 15_000 }), 'compaction boundary', true);
    boundary = boundaryLine(bounds) ?? null;
    // Before any argument check: with nothing compacted there is no earlier transcript, whatever was asked.
    if (boundary === null) result = { text: 'Nothing has been compacted yet, so everything is still in context.', hits: 0 };
    else if (args.error) throw new Error(args.error);
    else if (args.entry !== undefined && args.entry >= boundary) result = entryResult([], args.entry, boundary);
    else {
      const argv = args.entry !== undefined ? entryArgv(file, args.entry) : searchArgv(file, boundary, args.terms);
      const raw = boundary === 1 ? '' : processOutput(await $.process.run(argv, { timeoutMs: 30_000 }), args.entry !== undefined ? 'entry fetch' : 'transcript search', true);
      const entries = parseEntries(raw).filter((entry) => entry.line < boundary!);
      let names = toolNames(entries);
      const ids = resultIds(entries).filter((id) => !Object.hasOwn(names, id));
      if (ids.length > 0) {
        const uses = processOutput(await $.process.run(namesArgv(file, boundary, ids), { timeoutMs: 30_000 }), 'tool name lookup', true);
        names = { ...names, ...toolNames(parseEntries(uses).filter((entry) => entry.line < boundary!)) };
      }
      result = args.entry !== undefined ? entryResult(entries, args.entry, boundary, names) : searchResults(entries, args.terms, boundary, names, st.forwardToolName);
    }
  } catch (error) {
    const reason = message(error);
    result = { text: `Look back failed: ${reason}`, error: reason };
  }
  record(st, $, { event: 'look-back', party, why: args.why, ...(args.query !== undefined ? { query: args.query } : {}), ...(args.entry !== undefined ? { entry: args.entry } : {}), ...(result.hits !== undefined ? { hits: result.hits } : {}), boundary, ...(result.error !== undefined ? { error: result.error } : {}) });
  say(st, $, lookBackNotice(label, args, result), result.error === undefined ? 'info' : 'error');
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
    if (!manualTranscriptCall(tool, handoffInputOf(e), session, agentId)) return;
    const label = agentId === undefined ? 'main' : (await agentType(st, $, agentId)) ?? 'unlisted';
    record(st, $, { event: 'look-back-manual', party, tool });
    say(st, $, `look back by hand (${label}): ${tool} on the transcript`, 'info');
  } catch (error) {
    say(st, $, `sub-agent-compact: observing manual transcript lookup of ${party} via ${tool} failed: ${message(error)}`, 'error', { event: 'look-back-manual-error', party, tool, error: message(error) });
  }
}

async function registerForwardTool(st: State, $: EngineInterface): Promise<void> {
  try {
    const { tool } = await $.tool.register({ name: FORWARD_TOOL, description: FORWARD_TOOL_DESCRIPTION, inputSchema: FORWARD_INPUT_SCHEMA });
    st.forwardToolName = tool;
    record(st, $, { event: 'tool-registered', tool });
  } catch (error) {
    warnOnce(st, $, 'register-failed:forward', `sub-agent-compact: registering the ${FORWARD_TOOL} tool failed: ${message(error)}; no party can forward-hand-off`);
    record(st, $, { event: 'tool-register-failed', tool: FORWARD_TOOL, error: message(error), tries: st.toolTries.forward });
  }
}

async function registerHandoffTool(st: State, $: EngineInterface): Promise<void> {
  try {
    const { tool } = await $.tool.register({
      name: HANDOFF_TOOL,
      description: HANDOFF_TOOL_DESCRIPTION,
      inputSchema: HANDOFF_INPUT_SCHEMA,
    });
    st.handoffToolName = tool;
    record(st, $, { event: 'tool-registered', tool });
  } catch (error) {
    warnOnce(st, $, 'register-failed:handoff', `sub-agent-compact: registering the ${HANDOFF_TOOL} tool failed: ${message(error)}; the main chat cannot hand off (sub-agents can still use <handoff>)`);
    record(st, $, { event: 'tool-register-failed', tool: HANDOFF_TOOL, error: message(error), tries: st.toolTries.handoff });
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
    warnOnce(st, $, `no-clock:${what}`, `sub-agent-compact: $.clock.after is unavailable (${message(error)}); ${what} is not time-bounded`);
    return { cancel: () => {} };
  }
}

/**
 * Registers each enabled tool that is not registered yet, up to REGISTER_TRIES
 * hook calls each: `session.start` may not fire (a plugin loaded mid-session)
 * or may run before the session can take a tool. Hooks that need a tool wait on it.
 */
async function ensureTools(st: State, $: EngineInterface): Promise<void> {
  if (st.toolsAbandoned || st.toolsSettled) return;
  const left = () =>
    toolsToRegister(
      { compact: st.config.compactTool, handoff: st.config.handoffTool, forward: st.config.forwardHandoffTool, look_back: true },
      { compact: st.toolName !== undefined, handoff: st.handoffToolName !== undefined, forward: st.forwardToolName !== undefined, look_back: st.lookBackToolName !== undefined },
      st.toolTries,
      REGISTER_TRIES,
    );
  const registered = (async () => {
    await start(st, $);
    st.registering = (st.registering ?? Promise.resolve())
      .then(async () => {
        const todo = left();
        if (todo.includes('compact')) {
          st.toolTries.compact++;
          await registerCompactTool(st, $);
        }
        if (todo.includes('handoff')) {
          st.toolTries.handoff++;
          await registerHandoffTool(st, $);
        }
        if (todo.includes('forward')) {
          st.toolTries.forward++;
          await registerForwardTool(st, $);
        }
        if (todo.includes('look_back')) {
          st.toolTries.look_back++;
          await registerLookBackTool(st, $);
        }
      })
      .catch((error) => say(st, $, `sub-agent-compact: registering the tools failed: ${message(error)}`));
    await st.registering;
    if (left().length === 0) st.toolsSettled = true;
  })();
  // A hang here would hold every turn of every chat: past the limit the turn goes on, and the person is told.
  const outcome = await bounded(registered, ENSURE_TOOLS_TIMEOUT_MS, (ms, fn) => afterOrNever(st, $, ms, fn, 'registering the tools'));
  if (!outcome.timedOut) return;
  st.toolsAbandoned = true;
  // Once the slow registration settles, a later hook spends the tries left.
  const resume = () => void (st.toolsAbandoned = false);
  void registered.then(resume, resume);
  warnOnce(st, $, 'tools-timeout', `sub-agent-compact: registering the tools did not finish within ${ENSURE_TOOLS_TIMEOUT_MS / 1000}s; turns go on without waiting for it`);
}

/** How many prompts the person has sent this session, or undefined (and a warning once) when it cannot be read. */
async function promptCount(st: State, $: EngineInterface): Promise<number | undefined> {
  try {
    const turns = await $.session.turns();
    if (typeof turns === 'number' && Number.isFinite(turns)) return turns;
    warnOnce(st, $, 'turns', `sub-agent-compact: could not read how many prompts this session has (got ${JSON.stringify(turns)}); the size of the cut is left out of the nudge`);
  } catch (error) {
    warnOnce(st, $, 'turns', `sub-agent-compact: could not read how many prompts this session has: ${message(error)}; the size of the cut is left out of the nudge`);
  }
  return undefined;
}

/** Where skills and commands are read from, with the install path of each plugin `installed_plugins.json` lists. */
async function wakeRoots(st: State, $: EngineInterface): Promise<WakeRoots> {
  const projectRoot = `${st.cwd ?? '.'}/.claude`;
  const userRoot = st.configDir ?? projectRoot;
  let plugins: Record<string, string> = {};
  const file = `${userRoot}/plugins/installed_plugins.json`;
  try {
    if (await $.fs.exists(file)) {
      const parsed = pluginPaths(await $.fs.read(file));
      if ('problem' in parsed) warnOnce(st, $, 'installed-plugins', `sub-agent-compact: ${parsed.problem}; load_on_wake finds no plugin skill`);
      else plugins = parsed.paths;
    }
  } catch (error) {
    warnOnce(st, $, 'installed-plugins', `sub-agent-compact: reading ${file} failed: ${message(error)}; load_on_wake finds no plugin skill`);
  }
  return { projectRoot, userRoot, plugins };
}

/** One `load_on_wake` name read from the first file it resolves to, or why it does not. */
async function resolveWakeEntry(st: State, $: EngineInterface, roots: WakeRoots, name: string): Promise<WakeEntry> {
  const found = wakeCandidates(name, roots);
  if ('problem' in found) return { name, problem: found.problem };
  for (const path of found.paths) {
    try {
      if (!(await $.fs.exists(path))) continue;
      // Only a regular file within the cap is read: `$.fs.read` takes a pipe or a device as it takes a file.
      let stat;
      try {
        stat = await $.fs.stat(path);
      } catch (error) {
        return { name, path, problem: `could not stat ${path}: ${message(error)}` };
      }
      const refused = wakeFileProblem(stat);
      if (refused !== undefined) return { name, path, problem: `${path} ${refused}` };
      return { name, path, content: stripFrontmatter(await $.fs.read(path)) };
    } catch (error) {
      return { name, path, problem: `reading ${path} failed: ${message(error)}` };
    }
  }
  return { name, problem: `no file at any of: ${found.paths.join(', ')}` };
}

async function answerHandoffTool(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined;
  const parsed = parseHandoff(handoffInputOf(e));
  if ('problem' in parsed) {
    record(st, $, { event: 'handoff-invalid', via: 'tool', party: agentId ?? 'main', problem: parsed.problem.slice(0, 300) });
    return parsed.problem;
  }
  const party = await partyOf(st, $, agentId);
  const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : '';
  if (toolUseId === '') {
    say(st, $, `sub-agent-compact: the ${HANDOFF_TOOL} call of ${party.label} carries no tool_use_id; its install falls back to a summary that keeps the handoff`, 'warning');
  }
  // A name that resolves nowhere is refused now, while the agent can still correct it.
  if (parsed.loads.length > 0) {
    const roots = await wakeRoots(st, $);
    const failed: string[] = [];
    for (const name of parsed.loads) {
      const entry = await resolveWakeEntry(st, $, roots, name);
      if (entry.problem !== undefined) failed.push(`${name}: ${entry.problem}`);
    }
    if (failed.length > 0) {
      record(st, $, { event: 'handoff-invalid', via: 'tool', party: party.key, type: party.label, problem: 'load_on_wake', names: parsed.loads });
      return `Not stored: \`load_on_wake\` cannot be loaded: ${failed.join('; ')}. Correct or drop those entries and call the tool again.`;
    }
  }
  const stored = storeHandoff(st, $, party, { text: parsed.text, anchor: { toolUseId }, loads: parsed.loads }, 'tool');
  if (stored !== undefined) return stored.text;
  return handoffStoredText({ chars: parsed.text.length, main: party.main, askPoint: askPointOf(st) });
}

type Read = { content: string } | { problem: string };

/** One file read whole, or why not: missing, not a regular file, over the byte cap, unreadable. */
async function readOne(st: State, $: EngineInterface, path: string, maxBytes: number): Promise<Read> {
  try {
    if (!(await $.fs.exists(path))) return { problem: 'not found' };
    const stat = await $.fs.stat(path);
    if (stat.kind !== 'file') return { problem: `not a regular file (${stat.kind})` };
    if (stat.size > maxBytes) return { problem: `${stat.size} bytes, over the ${maxBytes} byte limit` };
    return { content: await $.fs.read(path) };
  } catch (error) {
    return { problem: `unreadable: ${message(error)}` };
  }
}

/** The first line of a process failure, or its exit code. */
const failure = (out: { exitCode: number; stderr: string }): string => out.stderr.split('\n')[0]?.trim() || `exit ${out.exitCode}`;

/** The records of this party's earlier forward handoffs on disk, newest first; a record that cannot be read is named in `unreadable`. */
async function earlierRecords(st: State, $: EngineInterface, at: { session: string; agentId?: string }, unreadable: string[]): Promise<unknown[]> {
  // Every root, the HOME one first: a call numbered in both is read once, from the first.
  const found = new Map<number, string>();
  for (const root of forwardRoots({ home: st.home, configDir: st.configDir })) {
    const dir = forwardSessionDir(root, at.session, at.agentId);
    try {
      if (!(await $.fs.exists(dir))) continue;
      for (const entry of await $.fs.list(dir)) if (/^\d+$/.test(entry.name) && !found.has(Number(entry.name))) found.set(Number(entry.name), `${dir}/${entry.name}`);
    } catch (error) {
      unreadable.push(`listing ${dir} failed (${message(error)})`);
    }
  }
  const records: unknown[] = [];
  for (const [seq, dir] of [...found.entries()].sort((a, b) => b[0] - a[0])) {
    try {
      records.push(JSON.parse(await $.fs.read(`${dir}/record.json`)));
    } catch (error) {
      unreadable.push(`record ${seq} unreadable (${message(error)})`);
    }
  }
  return records;
}

/**
 * What code carries into a forward handoff, read at handoff time from the transcript, the disk, git and the
 * live environment. A read that fails is a line in `problems`, never an absence. Every path is absolute.
 */
async function gatherForward(st: State, $: EngineInterface, args: ForwardArgs, at: { seq: number; dir?: string; session: string; agentId?: string }): Promise<RenderInput> {
  const cwd = (at.agentId !== undefined ? st.agentCwd.get(at.agentId) : undefined) ?? st.cwd ?? '.';
  const abs = (path: string): string => absPath(path, cwd, st.home ?? '');
  const problems: string[] = [...(args.problems ?? [])];
  let api: ApiMsg[] = [];
  try {
    const got = await $.session.messages({ as: 'api', ...(at.agentId !== undefined ? { agentId: at.agentId } : {}) });
    if (Array.isArray(got)) api = got as ApiMsg[];
    else problems.push(`transcript: unreadable (${JSON.stringify(got).slice(0, 120)})`);
  } catch (error) {
    problems.push(`transcript: unreadable (${message(error)})`);
  }

  const dropped = new Set(args.dropSkills);
  const invoked = invocations(api);
  for (const name of args.dropSkills) if (!invoked.some((x) => x.name === name)) problems.push(`drop_skills ${name}: not invoked`);
  const roots = await wakeRoots(st, $);
  const skills: RenderInput['skills'] = [];
  for (const inv of invoked.filter((x) => !dropped.has(x.name))) {
    const paths = invocationPaths(inv, roots);
    let found: RenderInput['skills'][number] = { name: inv.name, problem: paths.length === 0 ? 'not a skill or command name' : `no file (tried ${paths.length} paths)` };
    for (const path of paths) {
      const read = await readOne(st, $, path, WAKE_FILE_MAX_BYTES);
      if ('content' in read) {
        found = { name: inv.name, body: stripFrontmatter(read.content) };
        break;
      }
      if (read.problem !== 'not found') found = { name: inv.name, problem: `${path} ${read.problem}` };
    }
    skills.push(found);
  }

  const loaded: RenderInput['loaded'] = [];
  for (const file of args.loadFiles) {
    const target = abs(file.path);
    const range = file.lines !== undefined ? parseLineRange(file.lines) : undefined;
    const label = `${target}${range ? `:${range.from}-${range.to}` : ''}`;
    if (file.lines !== undefined && range === undefined) {
      loaded.push({ label: target, problem: `invalid lines ${JSON.stringify(file.lines)}` });
      continue;
    }
    // The model asked for these bytes: they come in only where its Read tool would be let in without asking.
    let allowed: { decision: string; reason?: string };
    try {
      allowed = await $.tool.check({ tool: 'Read', input: { file_path: target } });
    } catch (error) {
      allowed = { decision: 'unchecked', reason: `the permission check failed: ${message(error)}` };
    }
    if (allowed.decision !== 'allow') {
      loaded.push({ label, problem: `Read ${allowed.decision}${allowed.reason ? `: ${allowed.reason}` : ''}` });
      continue;
    }
    const read = await readOne(st, $, target, 4 * 1024 * 1024);
    loaded.push('content' in read ? { label, body: range ? sliceLines(read.content, range) : read.content } : { label, problem: read.problem });
  }

  const paths: string[] = [];
  const nested: string[] = [];
  let transcript: string | undefined;
  if (st.configDir === undefined) problems.push('transcript: no Claude config directory');
  else {
    try {
      // Found by its session id: Claude Code names a long project directory by hashing it, so the name is never rebuilt here.
      const search = await $.process.run(findTranscriptArgv({ configDir: st.configDir, session: at.session, ...(at.agentId !== undefined ? { agentId: at.agentId } : {}) }), { timeoutMs: 15_000 });
      const file = firstFound(search.stdout);
      transcript = file;
      if (file === undefined) problems.push(search.exitCode === 0 ? `transcript: no file for session ${at.session}` : `transcript: lookup failed (${failure(search)})`);
      else {
        const count = await $.process.run(['grep', '-c', '', file], { timeoutMs: 15_000 });
        if (count.exitCode === 0) paths.push(`transcript ${file}:${count.stdout.trim()}`);
        else problems.push(`transcript: counting lines failed (${failure(count)})`);
        const memory = await $.process.run(['grep', '-a', '-o', '"type":"nested_memory","path":"[^"]*"', file], { timeoutMs: 15_000 });
        if (memory.exitCode === 0) {
          for (const line of memory.stdout.split('\n')) {
            const path = /"path":"([^"]*)"/.exec(line)?.[1];
            if (path === undefined) continue;
            const full = abs(path);
            // The newest pickup of a file counts: an earlier one moves to the end.
            const seen = nested.indexOf(full);
            if (seen >= 0) nested.splice(seen, 1);
            nested.push(full);
          }
        } else if (memory.exitCode !== 1) problems.push(`nested memory: scanning the transcript failed (${failure(memory)})`);
      }
    } catch (error) {
      problems.push(`transcript: ${message(error)}`);
    }
  }
  // The previous call's folder where it is, the HOME root first: one saved under the config directory alone is named there.
  for (const root of forwardRoots({ home: st.home, configDir: st.configDir })) {
    const previous = previousDir(root, at.session, at.seq, at.agentId);
    if (previous === undefined) break;
    if (await $.fs.exists(previous).catch(() => false)) { paths.push(`previous ${previous}`); break; }
  }
  if (at.dir !== undefined) paths.push(`saved ${at.dir}`);

  const work = planAndTasks(api);
  let plan = work.planText;
  if (plan === undefined && work.planPath !== undefined) {
    const planFile = abs(work.planPath);
    const read = await readOne(st, $, planFile, 256 * 1024);
    if ('content' in read) plan = read.content;
    else problems.push(`plan ${planFile}: ${read.problem}`);
  }

  // The prompts: those an earlier handoff carried (from its record, never its text), then those written since it.
  // The held handoff is the newest text a record of this party holds, else the one an install put at the start; a paste elsewhere is a person's words.
  const unreadable: string[] = [];
  const records = heldForward(api, () => true) !== undefined ? await earlierRecords(st, $, at, unreadable) : [];
  const held = heldForward(api, (t) => carriedFrom(records, t) !== undefined);
  const before = held?.recorded ? carriedFrom(records, held.text) : undefined;
  if (held !== undefined && !held.recorded) problems.push(`earlier handoff: its record is missing, so the prompts before it are not carried${unreadable.length > 0 ? ` (${unreadable.join('; ')})` : ''}`);
  // After Claude Code's own compaction the context opens with its summary: the prompts before it come from the transcript file.
  let prior: { users: string[]; dropped: number } | undefined;
  let priorTrail: TrailEntry[] | undefined;
  if (held === undefined && transcript !== undefined && opensWithSummary(api)) {
    try {
      const bounds = await $.process.run(['grep', '-a', '-n', '"subtype":"compact_boundary"', transcript], { timeoutMs: 15_000 });
      const last = Number(bounds.stdout.trim().split('\n').pop()?.split(':')[0]);
      if (bounds.exitCode !== 0 || !Number.isFinite(last) || last <= 0) problems.push(`prompts before the summary: no compaction found in the transcript (${failure(bounds)})`);
      else {
        // Tool results are user entries too: only the entries without one hold prompts.
        const users = await $.process.run(['sh', '-c', 'grep -a -n \'"type":"user"\' "$1" | grep -v \'"tool_use_id"\'', 'sh', transcript], { timeoutMs: 30_000 });
        if (users.exitCode !== 0 && users.exitCode !== 1) problems.push(`prompts before the summary: reading the transcript failed (${failure(users)})`);
        else prior = { users: userMessages(priorPrompts(users.stdout, last)), dropped: 0 };
        // The files touched before it: the calls' lines up to the boundary, the newest kept.
        const calls = await $.process.run(['sh', '-c', CALLS_BEFORE, 'sh', transcript, String(last)], { timeoutMs: 30_000 });
        if (calls.exitCode !== 0 || calls.stderr.trim() !== '') problems.push(`files before the summary: reading the transcript failed (${failure(calls)})`);
        else priorTrail = fileTrail(priorCalls(calls.stdout, last), { cwd, home: st.home ?? '', max: TRAIL_MAX });
      }
    } catch (error) {
      problems.push(`prompts before the summary: ${message(error)}`);
    }
  }
  const since = held !== undefined ? api.slice(held.index + 1) : api;
  const chain = chainUsers(before ?? prior, userMessages(since), handoffInReply(since));
  // What Claude Code's own summary knew: from the one the context opens with, else from the earlier handoff's record.
  let summary = before?.summary;
  const opening = held === undefined ? openingSummary(api) : undefined;
  if (opening !== undefined) {
    summary = summaryKnowledge(opening);
    if (summary === undefined) problems.push("earlier summary: none of its sections found (concepts, files, errors, problem solving), so it is not carried");
  }
  // The files: those touched since, then those the earlier handoff or the transcript before the summary carried.
  const older = before !== undefined ? before.trail : priorTrail;
  const fresh = fileTrail(since, { cwd, home: st.home ?? '', max: TRAIL_MAX });
  const kept = nested.filter((p) => !mergeTrail(older, fresh, TRAIL_MAX).some((t) => t.path === p)).slice(-5);
  const trail = [...mergeTrail(older, fresh, TRAIL_MAX - kept.length), ...kept.map((path) => ({ tag: 'R' as const, path }))];
  // What each made or edited file holds now: read at handoff time, so a file changed since its edit shows as it stands.
  const outlines: Record<string, string> = {};
  for (const entry of trail.slice(0, TRAIL_MAX)) {
    if (entry.tag === 'R') continue;
    const read = await readOne(st, $, entry.path, OUTLINE_FILE_MAX_BYTES);
    if ('content' in read) outlines[entry.path] = outline(entry.path, read.content);
    else problems.push(`outline ${entry.path}: ${read.problem}`);
  }
  // The repositories the work touched: those of the files made or edited, else of the files read, newest first,
  // a linked worktree or submodule as its own. The session directory's only when the files name none.
  let here = cwd;
  try {
    // Read now, not at start: a shell `cd` moves it.
    here = await $.session.cwd();
  } catch (error) {
    problems.push(`git: reading the session cwd failed (${message(error)}); using ${cwd}`);
  }
  const topOf = async (dir: string): Promise<{ top: string } | { none: string } | { problem: string }> => {
    try {
      const out = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: 15_000 });
      if (out.exitCode === 0) return { top: out.stdout.trim() };
      return outsideRepository(out) ? { none: failure(out) } : { problem: failure(out) };
    } catch (error) {
      return { problem: message(error) };
    }
  };
  const tops: string[] = [];
  const touched = trailDirs(trail);
  for (const tier of [touched.made, touched.read]) {
    for (const dir of tier) {
      const found = await topOf(dir);
      if ('top' in found) {
        if (!tops.includes(found.top)) tops.push(found.top);
      } else if ('problem' in found) problems.push(`git ${dir}: ${found.problem}`);
    }
    if (tops.length > 0) break;
  }
  const own = await topOf(here);
  if (tops.length === 0) {
    if ('top' in own) tops.push(own.top);
    else problems.push(`git: ${'none' in own ? own.none : own.problem}`);
  }
  const repos: { root: string; line: string }[] = [];
  for (const root of tops.slice(0, GIT_REPOS)) {
    const named = 'top' in own && own.top === root && tops.length === 1 ? 'git' : `git ${root}`;
    try {
      const run = (argv: string[]) => $.process.run(argv, { cwd: root, timeoutMs: 15_000 });
      const branch = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD']);
      const head = await run(['git', 'rev-parse', '--short', 'HEAD']);
      // A cloned repo's fsmonitor hook is a program of its own: the status runs without it.
      const status = await run(['git', '-c', 'core.fsmonitor=false', 'status', '--porcelain']);
      const failed = [branch, head, status].find((out) => out.exitCode !== 0);
      if (failed !== undefined) problems.push(`${named}: ${failure(failed)}`);
      else repos.push({ root, line: gitLine({ branch: branch.stdout.trim(), head: head.stdout.trim(), dirty: parsePorcelain(status.stdout, root) }) });
    } catch (error) {
      problems.push(`${named}: ${message(error)}`);
    }
  }
  const git = gitBlock(repos, { ...('top' in own ? { own: own.top } : {}), more: tops.slice(GIT_REPOS) });
  const live = at.agentId === undefined && st.live !== undefined ? { tasks: st.live.tasks, crons: st.live.crons, started: st.live.started, now: Date.now() } : undefined;

  return { seq: at.seq, users: chain.users, usersDropped: chain.dropped, ...(chain.inReply ? { handoffInReply: true } : {}), ...(summary !== undefined ? { summary } : {}), skills, trail, outlines, loaded, ...(plan !== undefined ? { plan } : {}), tasks: work.tasks, running: runningWork(api, live), ...(git !== undefined ? { git } : {}), paths: paths.length > 0 ? [paths.join(' · ')] : [], problems, args };
}

/** Stores a forward handoff: the text code carried and the model's frontier, and the call's files on disk. Main chat and sub-agent alike. */
async function answerForwardTool(st: State, $: EngineInterface, e: Record<string, unknown>): Promise<string> {
  const agentId = typeof e.agentId === 'string' ? e.agentId : undefined;
  const key = agentId ?? 'main';
  const raw = handoffInputOf(e);
  const parsed = parseForwardArgs(raw);
  if ('nudge' in parsed) {
    record(st, $, { event: 'forward-invalid', party: key, problem: parsed.nudge.slice(0, 300) });
    return parsed.nudge;
  }
  const party = await partyOf(st, $, agentId);
  // Haiku is left to Claude Code's own compaction: nothing is stored, so nothing waits to install.
  if (party.haiku) {
    record(st, $, { event: 'forward-refused', party: key, why: 'haiku' });
    return handoffRefusal({ haiku: true, unlisted: false, tokens: undefined, nudgeStart: 0 })!;
  }
  // A loop no policy governs is never installed at its compaction: storing would tell it a handoff is coming that never lands.
  if (party.unlisted) {
    record(st, $, { event: 'forward-refused', party: key, why: 'unlisted' });
    return handoffRefusal({ haiku: false, unlisted: true, tokens: undefined, nudgeStart: 0 })!;
  }
  const now = st.parties.reading(key);
  const early = forwardRefusal({ woke: st.forwardWoke.has(key), tokens: now, nudgeStart: sizeTokens(party.policy.nudgeStart, party.window) });
  if (early !== undefined) {
    record(st, $, { event: 'forward-refused', party: key, why: 'woke-early', tokens: now ?? null });
    return early;
  }
  // Once per party: a second identical call is stored, so a model that insists never loops.
  const reread = st.rereadNudged.has(key) ? undefined : rereadNudge(parsed.args.next, parsed.args.loadFiles);
  if (reread !== undefined) {
    st.rereadNudged.add(key);
    record(st, $, { event: 'forward-reread', party: key, next: parsed.args.next.slice(0, 300) });
    return reread;
  }
  const toolUseId = typeof e.tool_use_id === 'string' ? e.tool_use_id : '';
  if (toolUseId === '') say(st, $, `sub-agent-compact: the ${FORWARD_TOOL} call carries no tool_use_id; its install falls back to a summary that keeps the handoff`, 'warning');
  const session = await $.session.id();
  let saved = '';
  let existing: string[] = [];
  const roots = forwardRoots({ home: st.home, configDir: st.configDir });
  if (roots.length === 0) saved = ' Not saved to disk: neither HOME nor CLAUDE_CONFIG_DIR is set.';
  // Numbered past every root's calls, so a record an earlier version kept under the config directory is never shadowed.
  for (const root of saved === '' ? roots : []) {
    const sessionDir = forwardSessionDir(root, session, agentId);
    try {
      if (await $.fs.exists(sessionDir)) existing.push(...(await $.fs.list(sessionDir)).map((entry) => entry.name));
    } catch (error) {
      // Unlisted, the next number is a guess: saving could overwrite an earlier call's files.
      saved = ` Not saved to disk: listing ${sessionDir} failed: ${message(error)}.`;
      say(st, $, `sub-agent-compact: listing ${sessionDir} failed: ${message(error)}; the forward handoff is not saved, so no earlier call's files are overwritten`);
      break;
    }
  }
  // Numbered from the directory and this process's own count, with no wait between the two reads and the claim.
  const seqKey = `${session}:${key}`;
  const seq = Math.max(nextSeq(existing), (st.forwardSeq.get(seqKey) ?? 0) + 1);
  st.forwardSeq.set(seqKey, seq);
  let dir = roots[0] !== undefined && saved === '' ? forwardDir(roots[0], session, seq, agentId) : undefined;
  const input = await gatherForward(st, $, parsed.args, { seq, ...(dir !== undefined ? { dir } : {}), session, ...(agentId !== undefined ? { agentId } : {}) });
  for (const problem of input.problems ?? []) record(st, $, { event: 'forward-invalid', party: key, seq, problem });
  const { text, blocks } = renderForward(input);
  const reading = st.parties.reading(key);
  const base = buildRecord({ seq, session, ...(agentId !== undefined ? { agentId } : {}), dir: dir ?? '', text, blocks, users: input.users, usersDropped: input.usersDropped ?? 0, ...(input.handoffInReply === true ? { handoffInReply: true } : {}), trail: input.trail, ...(input.summary !== undefined ? { summary: input.summary } : {}), ...(reading !== undefined ? { tokensBefore: reading } : {}), trimmed: parsed.args.trimmed, at: new Date().toISOString() });
  if (dir !== undefined) {
    try {
      await $.fs.write(`${dir}/args.json`, JSON.stringify(raw, null, 2));
      await $.fs.write(`${dir}/wake.txt`, text);
      await $.fs.write(`${dir}/record.json`, JSON.stringify(base, null, 2));
    } catch (error) {
      saved = ` Not saved to disk: ${message(error)}.`;
      say(st, $, `sub-agent-compact: saving forward handoff ${seq} to ${dir} failed: ${message(error)}`);
      dir = undefined;
    }
  }
  st.parties.armHandoff(key, { text, anchor: { toolUseId }, forward: { seq, ...(dir !== undefined ? { dir } : {}), blocks, record: base } });
  const tokens = Math.ceil(text.length / 4);
  record(st, $, { event: 'forward-stored', party: key, seq, dir, chars: text.length, tokens, blocks: blocks.map((b) => ({ name: b.name, chars: b.chars, items: b.items })) });
  return forwardStoredText({ tokens, ...(dir !== undefined ? { dir } : {}), blocks }) + saved;
}

/** At the first request of a party after its forward handoff installed: confirm each block is in what it holds, write the record with the check, and tell it of any that is not. */
async function finishForward(st: State, $: EngineInterface, { meta, text, tokensAfter, before, label }: NonNullable<State['forwardInstalled']> extends Map<string, infer V> ? V : never, agentId?: string): Promise<void> {
  const key = agentId ?? 'main';
  let held: string;
  try {
    const got = await $.session.messages({ as: 'api', ...(agentId !== undefined ? { agentId } : {}) });
    if (!Array.isArray(got)) throw new Error(`messages: ${JSON.stringify(got).slice(0, 120)}`);
    held = heldForward(got as ApiMsg[])?.text ?? '';
  } catch (error) {
    say(st, $, `sub-agent-compact: reading ${key} to check forward handoff ${meta.seq} failed: ${message(error)}; its install is unchecked`, 'warning', { event: 'forward-unchecked', seq: meta.seq, error: message(error) });
    return;
  }
  const check = installCheck(meta.blocks, held, text);
  if (meta.dir !== undefined) {
    try {
      await $.fs.write(`${meta.dir}/record.json`, JSON.stringify(withInstall(meta.record, { tokensAfter, check }), null, 2));
    } catch (error) {
      say(st, $, `sub-agent-compact: writing the install check of forward handoff ${meta.seq} to ${meta.dir} failed: ${message(error)}`, 'warning');
    }
  }
  record(st, $, { event: 'forward-installed', party: key, seq: meta.seq, tokensAfter, landed: check.landed, missing: check.missing, hash: check.hash });
  say(st, $, forwardInstalledLine({ seq: meta.seq, label, before, after: tokensAfter, landed: check.landed, missing: check.missing, ...(meta.dir !== undefined ? { dir: meta.dir } : {}) }), check.ok ? 'info' : 'warning');
  if (check.ok) return;
  st.parties.notify(key, `sub-agent-compact: forward handoff blocks did not land: ${check.missing.join(', ')}; ${meta.dir !== undefined ? `the full text is in ${meta.dir}/wake.txt` : 'the text was not saved to disk'}.`);
}

async function answerCompactTool(st: State, $: EngineInterface, agentId: string | undefined, focus: unknown): Promise<string> {
  if (typeof focus !== 'string' || focus.trim() === '') return 'Not armed: `focus` must name what the summary keeps (the plan or its file, what is done, what is left, the next step).';
  const party = await partyOf(st, $, agentId);
  const refused = arm(st, $, party, focus.trim(), 'tool');
  if (refused !== undefined) return refused;
  return armedText({ main: party.main, tokens: st.parties.reading(party.key), askPoint: askPointOf(st) });
}

export const register: Register = (on: On, options: PluginOptions) => {
  const st: State = {
    config: servedOptions(resolveOptions(options as Record<string, unknown>)),
    rawOptions: options as Record<string, unknown>,
    pluginRows: [],
    pluginInitialized: false,
    pluginWriting: Promise.resolve(),
    pluginFailing: false,
    types: new AgentTypes(),
    agentCwd: new Map(),
    models: new Map(),
    parties: new Parties(),
    asked: new Set(),
    warned: new Set(),
    logFailures: new Set(),
    pending: [],
    rowsWriting: 0,
    levelRowsWriting: 0,
    modelWindows: new Map(),
    skips: new SkipFold(),
    writing: Promise.resolve(),
    mainCompactedThisTurn: false,
    mainCompacting: false,
    mainCompactSeen: false,
    toolTries: { handoff: 0, compact: 0, forward: 0, look_back: 0 },
    forwardSeq: new Map(),
    forwardInstalled: new Map(),
    forwardWoke: new Set(),
    rereadNudged: new Set(),
    settled: new Set(),
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    await ensureTools(st, $);
    return result;
  });

  // The person's own message cancels a self-compaction the main chat's model armed; the model is told so.
  on('prompt.submit', async ($, e, next) => {
    try {
      const handoff = st.parties.handoff('main') !== undefined;
      // What became of the main chat's handoff since its last turn (a skipped install, a fallback) is read with the next prompt.
      const notices = st.parties.takeNotices('main');
      if (personPrompt(e.origin) && st.parties.disarm('main')) {
        record(st, $, { event: 'disarmed', party: 'main', via: 'prompt', origin: e.origin.kind, what: handoff ? 'handoff' : 'compact' });
        return next({ ...e, context: [...(e.context ?? []), ...notices, handoff ? handoffDisarmedText() : disarmedText()] });
      }
      if (notices.length > 0) return next({ ...e, context: [...(e.context ?? []), ...notices] });
    } catch (error) {
      say(st, $, `sub-agent-compact: reading the prompt's origin failed: ${message(error)}`);
    }
    return next(e);
  });

  // Track each loop's context and model from its responses, and read a sub-agent's <compact-now> request in its text.
  on('turn.step', async function* ($, e, next) {
    await ensureTools(st, $);
    const result = yield* next(e);
    const key = e.agentId ?? 'main';
    try {
      const previous = st.models.get(key);
      st.models.set(key, e.model);
      const tokens = contextTokens(result.usage);
      const main = e.agentId === undefined;
      // /model moves the main chat to another window: its forced point and nudges follow the new one.
      if (main && previous !== undefined && previous !== e.model) await rereadWindow(st, $, e.model);
      // Only a reading of the session's first request is the base a handoff cuts back to; a plugin reloaded mid-session reads its first at a late one.
      // The main chat's prompt count is asked only when this could be that request.
      const mayBeFirst = e.index === 0 && typeof e.messageCount === 'number' && e.messageCount <= FRESH_MAX_MESSAGES && st.parties.firstReading(key) === undefined;
      const turns = main && tokens !== undefined && mayBeFirst ? await promptCount(st, $) : undefined;
      // A sharp fall with no session.compact handled since is a compaction Claude Code never dispatched to the plugin.
      if (main && tokens !== undefined) {
        const before = st.parties.reading('main');
        // What that compaction summarized away is gone: a stored handoff would install stale, and the nudges start over.
        if (unseenCompaction(before, tokens, st.mainCompactSeen)) {
          const handoffDropped = st.parties.handoff('main') !== undefined;
          st.parties.compacted('main', tokens);
          st.forwardWoke.delete('main');
          record(st, $, { event: 'compact-unseen', party: 'main', before: before ?? null, after: tokens, handoffDropped });
        }
        st.mainCompactSeen = false;
      }
      if (tokens !== undefined) st.parties.read(key, tokens, isFirstRequest({ index: e.index, messageCount: e.messageCount, main, turns }));
      // A step asking for tools got a response, from the API or a hook; a failed request (a prompt too long) asks for none, so its recovery ask stays unanswered.
      else if (result.toolUses.length > 0) st.parties.answered(key);
      const installed = st.forwardInstalled.get(key);
      if (installed !== undefined) {
        st.forwardInstalled.delete(key);
        await finishForward(st, $, installed, e.agentId);
      }
      // A Haiku party's markers are not read: it is left to Claude Code, so a marker it writes is neither stored nor refused.
      const haiku = isHaiku(e.model);
      const handoff = st.config.handoffTool && !haiku ? handoffMarkerRequest({ answer: result.answer, toolCalls: result.toolUses.length, main }) : undefined;
      const focus = st.config.compactTool && !haiku && handoff === undefined ? markerRequest({ answer: result.answer, toolCalls: result.toolUses.length, main }) : undefined;
      if (handoff !== undefined) {
        const stored = storeHandoff(st, $, await partyOf(st, $, e.agentId), { text: handoff, anchor: { marker: true } }, 'marker');
        // The marker has no tool result to answer it: the agent reads the outcome on its next tool result.
        st.parties.notify(key, stored === undefined ? handoffNotice('marker-stored', `${handoff.length} characters`) : handoffNotice('marker-refused', stored.text));
      } else if (focus !== undefined) arm(st, $, await partyOf(st, $, e.agentId), focus, 'marker');
    } catch (error) {
      say(st, $, `sub-agent-compact: reading turn.step for ${key} failed: ${message(error)}`);
    }
    return result;
  });

  // Serve the handoff and compact tools; after any other tool, carry a nudge the party is owed.
  on('tool.call', async ($, e, next) => {
    if (st.lookBackToolName !== undefined && e.tool === st.lookBackToolName) return { result: await answerLookBackTool(st, $, e as Record<string, unknown>) };
    await observeManualLookBack(st, $, e as Record<string, unknown>);
    // What the engine's in-flight list (taken at the last turn's end) cannot yet know of.
    if (e.agentId === undefined && st.live !== undefined && typeof e.tool_use_id === 'string') st.live.started.add(e.tool_use_id);
    if (st.handoffToolName !== undefined && e.tool === st.handoffToolName) {
      try {
        return { result: await answerHandoffTool(st, $, e as Record<string, unknown>) };
      } catch (error) {
        say(st, $, `sub-agent-compact: storing the handoff of ${e.agentId ?? 'main'} failed: ${message(error)}`);
        return { result: `Not stored: ${message(error)}` };
      }
    }
    if (st.forwardToolName !== undefined && e.tool === st.forwardToolName) {
      try {
        return { result: await answerForwardTool(st, $, e as Record<string, unknown>) };
      } catch (error) {
        say(st, $, `sub-agent-compact: storing the forward handoff failed: ${message(error)}`);
        return { result: `Not stored: ${message(error)}` };
      }
    }
    if (st.toolName !== undefined && e.tool === st.toolName) {
      try {
        return { result: await answerCompactTool(st, $, e.agentId, (e as Record<string, unknown>).focus) };
      } catch (error) {
        say(st, $, `sub-agent-compact: arming ${e.agentId ?? 'main'} failed: ${message(error)}`);
        return { result: `Not armed: ${message(error)}` };
      }
    }
    const result = await next(e);
    if (result.deny !== undefined) return result;
    // What became of this party's handoff since its last tool result comes first, then any nudge it is owed; a failed nudge never drops the notices taken.
    const notices = st.parties.takeNotices(e.agentId ?? 'main');
    let line: string | undefined;
    try {
      line = await nudgeFor(st, $, e.agentId);
    } catch (error) {
      say(st, $, `sub-agent-compact: nudging ${e.agentId ?? 'main'} failed: ${message(error)}`);
    }
    if (notices.length > 0 || line !== undefined) return { ...result, context: [...(result.context ?? []), ...notices, ...(line !== undefined ? [line] : [])] };
    return result;
  });

  // The engine's own list of what is in flight, at the end of each main turn: the truth for running work that a forward handoff cannot read from the transcript.
  on('classic.Stop', async ($, e, next) => {
    st.live = { tasks: (e.background_tasks ?? []).map((t) => ({ id: t.id, type: t.type, description: t.description, ...(t.command !== undefined ? { command: t.command } : {}) })), crons: (e.session_crons ?? []).map((c) => ({ id: c.id, schedule: c.schedule, recurring: c.recurring, prompt: c.prompt })), started: new Set() };
    return next(e);
  });

  // Every sub-agent's start names its type; a Workflow run's agents are never in $.agent.list(), so this is their only source.
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e);
    try {
      // A spawn without its own directory runs in the parent's as it is now; the main chat's shell may move after.
      if (started.agentId !== undefined) st.agentCwd.set(started.agentId, e.cwd ?? (await $.session.cwd()));
    } catch (error) {
      say(st, $, `sub-agent-compact: reading where sub-agent ${started.agentId} runs failed: ${message(error)}; its relative paths resolve under ${st.cwd ?? '.'}`, 'warning');
    }
    return started;
  });

  on('classic.SubagentStart', async ($, e, next) => {
    st.types.learn(e.agent_id, e.agent_type);
    return next(e);
  });

  // A sub-agent that sent its marker alone ended its run: arm it and refuse the stop once, so it compacts and carries on.
  on('classic.SubagentStop', async ($, e, next) => {
    st.types.learn(e.agent_id, e.agent_type);
    // A Haiku sub-agent's stop is its own: its last message is not read for a marker.
    if (isHaiku(st.models.get(e.agent_id))) return next(e);
    try {
      const continued = st.parties.continued(e.agent_id);
      const handoff = st.config.handoffTool ? handoffStopRequest({ lastMessage: e.last_assistant_message, continued }) : undefined;
      if (handoff !== undefined) {
        const party = await partyOf(st, $, e.agent_id);
        const stored = storeHandoff(st, $, party, { text: handoff, anchor: { marker: true } }, 'stop');
        if (stored === undefined) {
          st.parties.markContinued(e.agent_id);
          record(st, $, { event: 'stop-refused', party: e.agent_id, type: party.label, what: 'handoff' });
          return { block: CONTINUE_AFTER_HANDOFF };
        }
        if (stored.why === 'invalid') {
          // The agent ends its run on a marker it believes was stored: stop it once with the reason, so it can write the handoff out.
          st.parties.markContinued(e.agent_id);
          record(st, $, { event: 'stop-refused', party: e.agent_id, type: party.label, what: 'handoff-invalid' });
          return { block: stored.text };
        }
      }
      const focus = st.config.compactTool && handoff === undefined ? stopRequest({ lastMessage: e.last_assistant_message, continued }) : undefined;
      if (focus !== undefined) {
        const party = await partyOf(st, $, e.agent_id);
        if (arm(st, $, party, focus, 'stop') === undefined) {
          st.parties.markContinued(e.agent_id);
          record(st, $, { event: 'stop-refused', party: e.agent_id, type: party.label });
          return { block: CONTINUE_AFTER_MARKER };
        }
      }
    } catch (error) {
      say(st, $, `sub-agent-compact: reading ${e.agent_id}'s stop failed: ${message(error)}; letting it stop`, 'warning');
    }
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    const agentId = e.agentId;
    const key = agentId ?? 'main';
    // A trigger a newer Claude Code may add is handled as an automatic ask, and said once.
    const known = knownTrigger(e.trigger);
    const kind: Trigger = known ?? 'auto';
    if (known === undefined) {
      warnOnce(st, $, `trigger:${String(e.trigger)}`, `sub-agent-compact: unknown trigger ${JSON.stringify(e.trigger)} in session.compact (Claude Code newer than this plugin?); treating it as "auto"`);
    }
    const messages = Array.isArray(e.messages) ? e.messages : [];
    const base: Row = { event: 'session.compact', trigger: e.trigger, party: agentId ? 'sub' : 'main', agentId: agentId ?? null };
    let party: Party;
    let tokens: number | undefined;
    try {
      party = await partyOf(st, $, agentId);
      tokens = currentTokens(agentId ? st.parties.reading(agentId) : (await $.session.usage()).context.tokens, messages, st.asked.has(key));
    } catch (error) {
      const line = `sub-agent-compact: deciding ${agentId ? `sub-agent ${agentId}` : 'main'} ${kind} compaction failed: ${message(error)}; letting it through`;
      say(st, $, line, 'error', { ...base, decision: 'pass', why: 'error', error: message(error) });
      if (st.parties.handoff(key) !== undefined) st.parties.notify(key, handoffNotice('fallback', `deciding failed: ${message(error)}`));
      const passed = await next(e);
      if (!agentId && kind !== 'precompute' && passed.skip === undefined) mainCompacted(st);
      return passed;
    }
    const { limit, row: limitRow } = limitOf(st, $, party);
    const askPoint = askPointOf(st);
    const tracked = !party.haiku && !party.unlisted;
    const shape = transcriptShapeProblem(e.messages);
    if (shape !== undefined && tracked) {
      warnOnce(st, $, `shape:${key}`, `sub-agent-compact: the transcript of ${party.label} has an unexpected shape (${shape}); handoffs cannot be installed verbatim`);
    }
    let handoff: ArmedHandoff | undefined = tracked ? st.parties.handoff(key) : undefined;
    let recovered = false;
    // A handoff the plugin lost (a reload, a resume) still stands in the transcript as a stored call: take it back.
    if (handoff === undefined && tracked && kind !== 'manual' && shape === undefined && st.handoffToolName !== undefined) {
      const found = recoverHandoff(e.messages, st.handoffToolName);
      if (found !== undefined && 'toolUseId' in found.anchor && !st.settled.has(`${key}:${found.anchor.toolUseId}`)) {
        handoff = found;
        recovered = true;
      }
    }
    // The same for a forward handoff: its text and record are read back from the files its call saved.
    if (handoff === undefined && tracked && kind !== 'manual' && shape === undefined && st.forwardToolName !== undefined) {
      const found = recoverForward(e.messages, st.forwardToolName, forwardRoots({ home: st.home, configDir: st.configDir }));
      if (found !== undefined && !st.settled.has(`${key}:${found.toolUseId}`)) {
        try {
          const text = await $.fs.read(`${found.dir}/wake.txt`);
          const record = JSON.parse(await $.fs.read(`${found.dir}/record.json`)) as Record<string, unknown>;
          const blocks = Array.isArray(record.blocks) ? (record.blocks as BlockRecord[]) : [];
          const seq = typeof record.seq === 'number' ? record.seq : 0;
          if (text.trim() === '') throw new Error(`${found.dir}/wake.txt is empty`);
          handoff = { text, anchor: { toolUseId: found.toolUseId }, forward: { seq, dir: found.dir, blocks, record } };
          recovered = true;
        } catch (error) {
          say(st, $, `sub-agent-compact: recovering the forward handoff of ${party.label} from ${found.dir} failed: ${message(error)}; this compaction runs as it would without it`, 'warning');
        }
      }
    }
    // Set when the handoff cannot be installed verbatim: the summarizer is told it for this call only, and the stored handoff is left as it is.
    let fallback: string | undefined;
    // Set when the person's /compact runs over a stored handoff: its outcome decides whether the handoff went with the summary.
    let manualOver: ArmedHandoff | undefined;
    if (handoff !== undefined) {
      // A precompute installs nothing and would keep a stale tail: the compaction it prepares installs the handoff instead.
      if (kind === 'precompute') {
        record(st, $, { ...base, type: party.label, decision: 'skip', why: 'handoff-waits' });
        return { skip: 'handoff waits for the compaction' };
      }
      if (kind === 'manual') {
        // The person's own /compact runs as they asked; once its summary ran the stored handoff is gone with it, and both are told after the outcome.
        manualOver = handoff;
      } else {
        let reason: { kind: 'shape' | 'fallback'; detail: string } | undefined;
        if (shape !== undefined) reason = { kind: 'shape', detail: shape };
        else {
          try {
            const brief = agentId && st.config.keepBrief ? seatedBrief(e.messages, BRIEF_MAX_TOKENS) : undefined;
            const roots = handoff.loads !== undefined && handoff.loads.length > 0 ? await wakeRoots(st, $) : undefined;
            const invoked = invokedSkills(e.messages);
            const entries: WakeEntry[] = [];
            for (const name of handoff.loads ?? []) entries.push(invoked.has(name) || roots === undefined ? { name, invoked: invoked.has(name) } : await resolveWakeEntry(st, $, roots, name));
            const wake = renderWake(entries);
            const text = wake.text === '' ? handoff.text : `${handoff.text}\n\n**Loaded on wake**\n${wake.text}`;
            const installed = installHandoff(e.messages, { text, anchor: handoff.anchor, ...(brief !== undefined ? { brief } : {}), ...(handoff.forward ? { frame: (verbatim: string) => verbatim } : {}) });
            if (installed !== undefined) {
              const tokensAfter = estimateTranscript(installed.messages);
              if (kind === 'auto') st.asked.add(key);
              if (!agentId) mainCompacted(st);
              if ('toolUseId' in handoff.anchor) st.settled.add(`${key}:${handoff.anchor.toolUseId}`);
              st.parties.compacted(key, tokensAfter);
              const line = installLine({ label: party.label, before: tokens, after: tokensAfter, tail: installed.tail, recovered });
              // A forward handoff's line waits for its install check, which tells all of it in one line.
              if (handoff.forward === undefined || line.warn) say(st, $, line.line, line.warn ? 'warning' : 'info');
              if (recovered) {
                say(st, $, `sub-agent-compact: recovered the handoff of ${party.label} from its transcript`, 'info');
                st.parties.notify(key, handoffNotice('recovered'));
              }
              for (const name of wake.failed) {
                const entry = entries.find((x) => x.name === name);
                say(st, $, `sub-agent-compact: could not load ${name}: ${entry?.problem ?? 'the total size was reached'}`, 'warning');
              }
              for (const name of wake.cut) say(st, $, `sub-agent-compact: load_on_wake entry ${name} was cut at the per-entry cap`, 'warning');
              if (wake.failed.length > 0) {
                st.parties.notify(key, `sub-agent-compact: load_on_wake entries not loaded: ${wake.failed.join(', ')} — the installed handoff names them as NOT LOADED; load them yourself.`);
              }
              record(st, $, { ...base, type: party.label, ...limitRow, tokens: tokens ?? null, messages: messages.length, decision: 'handoff', tail: installed.tail, siblings: installed.siblings, brief: brief !== undefined, chars: text.length, tokensAfter, recovered, loads: entries.length, loadsFailed: wake.failed.length, warn: line.warn });
              // What the session holds is readable only once the compaction is done: the next main request checks it.
              if (handoff.forward) {
                st.forwardInstalled.set(key, { meta: handoff.forward, text, tokensAfter, before: tokens, label: party.label });
                st.forwardWoke.add(key);
              }
              return { messages: installed.messages, ...(tokens !== undefined ? { tokensBefore: tokens } : {}), tokensAfter };
            }
            reason = { kind: 'fallback', detail: 'its tool call is not in the transcript' };
          } catch (error) {
            reason = { kind: 'fallback', detail: `installing failed: ${message(error)}` };
          }
        }
        say(st, $, `sub-agent-compact: the handoff of ${party.label} could not be installed verbatim (${reason.detail}); a summary that keeps it runs instead`, 'warning', { event: 'handoff-fallback', party: key, type: party.label, why: reason.kind, detail: reason.detail });
        st.parties.notify(key, handoffNotice(reason.kind, reason.detail));
        // Never hold a compaction: the summarizer runs with the handoff as what it keeps. Nothing is dropped: if the summary is skipped, the handoff stays stored.
        fallback = handoff.text;
      }
    }
    if (!party.main && !party.haiku && !party.unlisted && askPoint !== undefined && limit < askPoint) {
      warnOnce(st, $, `below-window:${party.label}`, `sub-agent-compact: ${party.label} limit ${limit} is below Claude Code's ask point ${askPoint} (CLAUDE_CODE_AUTO_COMPACT_WINDOW ${st.compactWindow}); it compacts at ${askPoint} — lower the window to hold this limit`);
    }
    const heldArm = tracked ? st.parties.armed(key) : undefined;
    const armed = fallback ?? heldArm;
    const unanswered = kind === 'auto' && st.parties.unanswered(key);
    const decision = decide({ trigger: kind, label: party.label, limit, tokens, enabled: party.haiku || party.policy.enabled, armed, unlisted: party.unlisted, haiku: party.haiku, unanswered });
    record(st, $, { ...base, type: party.label, ...limitRow, source: party.haiku ? 'haiku' : party.source, tokens: tokens ?? null, lastResponseTokens: st.parties.reading(key) ?? null, messages: messages.length, decision: decision.action, ...(decision.action === 'pass' ? { why: decision.why } : {}) });
    if (decision.action === 'skip') {
      if (kind === 'auto') {
        st.asked.add(key);
        st.parties.heldAsk(key);
      }
      return { skip: decision.reason };
    }
    if (decision.why === 'no-reading') say(st, $, `sub-agent-compact: no token reading for ${party.label} and no transcript estimate to trust; letting the ${kind} compaction through`, 'warning');
    const firstAsk = !st.asked.has(key);
    if (kind === 'auto') st.asked.add(key);
    // With the window known, a first ask past the limit is one step's growth, not a window set too high.
    if (kind === 'auto' && firstAsk && tracked && st.compactWindow === undefined && tokens !== undefined && tokens > limit * 1.1) {
      warnOnce(st, $, `late:${party.label}`, `sub-agent-compact: ${party.label} was first asked to compact at ${tokens}, past its limit ${limit}; CLAUDE_CODE_AUTO_COMPACT_WINDOW is unset, so Claude Code's native window is likely above this limit — set it to your smallest sub-agent limit`);
    }
    // A self-compaction's focus becomes what the summarizer is told; a person's or plugin's instructions come first.
    const input = (decision.why === 'self' || fallback !== undefined) && armed !== undefined ? { ...e, instructions: e.instructions ? `${e.instructions}\n\n${armed}` : armed } : e;
    // A compaction armed by the model that does not finish drops its focus: the person's interrupt, a skip beneath or a failure never leaves it to fire on the next request.
    // A handoff held for a fallback is not an arm: disarming it would drop the handoff the next compaction can still install.
    const dropArm = (why: string): void => {
      if (fallback === undefined && heldArm !== undefined && st.parties.disarm(key)) record(st, $, { event: 'disarmed', party: key, via: why, trigger: e.trigger });
    };
    // A person's /compact that did not finish summarized nothing: the stored handoff stays, and both are told once.
    let manualTold = false;
    const manualUnfinished = (why: string): void => {
      if (manualTold) return;
      manualTold = true;
      say(st, $, `sub-agent-compact: the person's /compact over the stored handoff of ${party.label} was skipped (${why}); the handoff stays stored`, 'warning');
      st.parties.notify(key, handoffNotice('skipped', why));
    };
    const onAbort = (): void => {
      if (compactionEnd({ trigger: kind, skipped: false, aborted: true }) === 'unfinished') dropArm('interrupt');
      if (manualOver !== undefined) manualUnfinished('interrupted');
    };
    next.signal.addEventListener('abort', onAbort, { once: true });
    // An interrupt that landed before this hook reached the compaction fires no event; read it now.
    if (next.signal.aborted) onAbort();
    let outcome: Awaited<ReturnType<typeof next>>;
    try {
      outcome = await next(input);
    } catch (error) {
      if (compactionEnd({ trigger: kind, skipped: false, aborted: true }) === 'unfinished') dropArm('error');
      if (manualOver !== undefined) manualUnfinished(`the compaction failed: ${message(error)}`);
      record(st, $, { event: 'hook-threw', error: message(error), party: key });
      throw error;
    } finally {
      next.signal.removeEventListener('abort', onAbort);
    }
    // An outcome that came back is judged by its skip alone: a compaction that returned its messages ran.
    const end = compactionEnd({ trigger: kind, skipped: outcome.skip !== undefined, aborted: false });
    if (end === 'compacted' && outcome.skip === undefined) {
      st.parties.compacted(key, outcome.tokensAfter);
      if (!agentId) mainCompacted(st);
      if (fallback !== undefined && handoff !== undefined && 'toolUseId' in handoff.anchor) st.settled.add(`${key}:${handoff.anchor.toolUseId}`);
      if (manualOver !== undefined) {
        record(st, $, { event: 'disarmed', party: key, via: 'manual', what: 'handoff' });
        say(st, $, `sub-agent-compact: the person's /compact ran over the stored handoff of ${party.label}: the handoff was dropped and a summary ran`, 'warning');
        st.parties.notify(key, handoffNotice('manual'));
      }
    } else if (end === 'unfinished') {
      dropArm('skipped');
      if (manualOver !== undefined) manualUnfinished(outcome.skip ?? 'unfinished');
      if (fallback !== undefined) {
        say(st, $, `sub-agent-compact: the summary that was to keep the handoff of ${party.label} was skipped (${outcome.skip ?? 'unfinished'}); the handoff stays stored`, 'warning');
        st.parties.notify(key, handoffNotice('skipped', outcome.skip ?? 'unfinished'));
      }
    }
    // A sub-agent's brief is its first message, which the summary replaces: seat it back right after the summary.
    if (agentId && st.config.keepBrief && !party.haiku && outcome.skip === undefined) {
      try {
        const reseated = reseatBrief(e.messages, outcome.messages, BRIEF_MAX_TOKENS);
        if (reseated !== outcome.messages) {
          record(st, $, { event: 'brief-seated', party: key, type: party.label, messages: reseated.length, chars: reseated[1]?.text.length ?? null });
          return { ...outcome, messages: reseated };
        }
      } catch (error) {
        say(st, $, `sub-agent-compact: seating the brief of sub-agent ${agentId} failed: ${message(error)}; leaving the compaction as Claude Code made it`, 'warning', { event: 'brief-error', party: key, error: message(error) });
      }
    }
    return outcome;
  });

  // Main between turns: the compaction its model armed below Claude Code's ask point, or its forced point.
  on('turn.complete', async ($, e, next) => {
    // A prompt too long is asked again inside its turn; once the turn ends (an Esc, an API error, or a failure under
    // this hook), the held ask is answered, so the next turn's ask is held again.
    let result: Awaited<ReturnType<typeof next>>;
    try { result = await next(e); } finally { st.parties.turnEnded(e.agentId ?? 'main'); }
    if (e.agentId) return result;
    if (st.mainCompactedThisTurn) {
      st.mainCompactedThisTurn = false;
      return result;
    }
    if (st.mainCompacting) return result;
    try {
      const party = await partyOf(st, $, undefined);
      // A Haiku main chat is left to Claude Code: no armed compaction, no handoff, no forced point.
      if (party.haiku) return result;
      const focus = st.parties.armed('main');
      const handoff = st.parties.handoff('main');
      const tokens = (await $.session.usage()).context.tokens;
      const limit = limitOf(st, $, party).limit;
      const forced = party.policy.enabled && tokens !== undefined && tokens >= limit;
      if (focus === undefined && handoff === undefined && !forced) return result;
      st.mainCompacting = true;
      record(st, $, { event: 'turn.complete', party: 'main', tokens: tokens ?? null, limit, action: 'compact', why: handoff !== undefined ? 'handoff' : focus !== undefined ? 'self' : 'at-limit' });
      const outcome = await $.session.compact(focus !== undefined ? { instructions: focus } : {});
      const skipped = 'skip' in outcome && outcome.skip ? outcome.skip : null;
      // The plugin's own compaction ran even when its session.compact passed this hook by: main starts over from it.
      if (skipped === null) {
        st.parties.compacted('main', 'tokensAfter' in outcome ? outcome.tokensAfter : undefined);
        st.mainCompactSeen = true;
      }
      record(st, $, { event: 'turn.complete.compacted', party: 'main', skipped });
      if (skipped !== null) {
        // A skip beneath (a tool is running, another hook's veto) leaves the handoff stored: say so where the person and the model read it.
        say(st, $, `sub-agent-compact: the compaction between turns was skipped: ${skipped}${handoff !== undefined ? '; the stored handoff stays and installs at the next compaction' : ''}`, 'warning');
        if (handoff !== undefined) st.parties.notify('main', handoffNotice('skipped', skipped));
      }
    } catch (error) {
      say(st, $, `sub-agent-compact: compacting main between turns failed: ${message(error)}`, 'error', { event: 'turn.complete', party: 'main', error: message(error) });
      if (st.parties.handoff('main') !== undefined) st.parties.notify('main', handoffNotice('skipped', `the compaction failed: ${message(error)}`));
    } finally {
      st.mainCompacting = false;
      st.mainCompactedThisTurn = false;
    }
    return result;
  });
  on('session.end', async ($, e, next) => {
    // A /clear or a resume ends the conversation, and the process goes on under a new session id with no session.start.
    const goesOn = e.reason === 'clear' || e.reason === 'resume';
    if (goesOn) record(st, $, { event: 'cleared', party: 'main', reason: e.reason, handoffDropped: st.parties.handoff('main') !== undefined });
    // The open skip streaks close now, and the session ends only once every queued row is written.
    if (st.config.logFile) {
      for (const out of st.skips.drain()) st.pending.push(JSON.stringify(out));
      flushDecisions(st, $);
    }
    // The whole end chain shares one short bound: the writes get what it leaves less core's share, and the conversation starts over either way.
    const writes = Promise.all([st.writing, st.pluginWriting]);
    const left = next.budget?.remainingMs ?? Infinity;
    const outcome = Number.isFinite(left) ? await bounded(writes, Math.max(0, left - END_CORE_RESERVE_MS), (ms, fn) => afterOrNever(st, $, ms, fn, 'the session-end log flush')) : (await writes, { timedOut: false as const });
    if (outcome.timedOut) {
      const count = (n: number, log: string) => (n > 0 ? [`${n} ${log} ${n === 1 ? 'row' : 'rows'}`] : []);
      const cut = [...count(st.pending.length + st.rowsWriting, 'decision'), ...count(st.levelRowsWriting, 'level')];
      show($, `sub-agent-compact: the session-end bound (${next.budget?.ms ?? left} ms) ran out before the logs were written; ${cut.length > 0 ? cut.join(' and ') : 'the rows in flight'} may be lost`);
    }
    if (goesOn) startOver(st);
    return next(e);
  });
};
