import type { EngineInterface, On, PluginOptions, Register } from 'claude-code';
import { BRIEF_MAX_TOKENS, reseatBrief, seatedBrief } from '../src/brief.ts';
import { AgentPolicies, AgentTypes } from '../src/agents.ts';
import { compactionEnd, contextTokens, currentTokens, decide, estimateTranscript, personPrompt } from '../src/decide.ts';
import {
  CONTINUE_AFTER_HANDOFF,
  HANDOFF_INPUT_DESCRIPTION,
  HANDOFF_TOOL,
  HANDOFF_TOOL_DESCRIPTION,
  handoffDisarmedText,
  handoffMarkerRequest,
  handoffNudgeText,
  handoffProblem,
  handoffRefusal,
  handoffStopRequest,
  handoffStoredText,
  installHandoff,
  type ArmedHandoff,
} from '../src/handoff.ts';
import { resolveOptions, sizeTokens, type Policy, type ResolvedOptions } from '../src/limits.ts';
import { appendRows, sessionLogPath } from '../src/log.ts';
import { armedText, CONTINUE_AFTER_MARKER, disarmedText, earlyArm, markerRequest, nudgeText, stopRequest } from '../src/nudge.ts';
import { Parties } from '../src/parties.ts';
import { engineAskPoint, isHaiku, modelWindow } from '../src/window.ts';

// Thin adapter: every decision lives in src/. Each hook catches its own
// failures, logs them with context and lets the compaction through.

const COMPACT_TOOL = 'compact';
/** The main chat's window when $.session.usage() cannot be read. */
const FALLBACK_WINDOW = 200_000;

const LOG_CAP = 2000;

type Row = Record<string, unknown>;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type State = {
  config: ResolvedOptions;
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
  /** Each sub-agent's type: announced by SubagentStart or SubagentStop, else from `$.agent.list()`. */
  types: AgentTypes;
  /** Per party ("main" or an agent id): its model, from its last response. */
  models: Map<string, string>;
  parties: Parties;
  asked: Set<string>;
  warned: Set<string>;
  pending: string[];
  logPath?: Promise<string | undefined>;
  writing: Promise<void>;
  mainCompactedThisTurn: boolean;
  mainCompacting: boolean;
};

// Rows queue in memory; each flush reads the session's file and appends them,
// so a resumed session keeps its earlier rows and no other chat shares the file.
function record(st: State, $: EngineInterface, row: Row): void {
  const file = st.config.logFile;
  if (!file) return;
  st.pending.push(JSON.stringify({ ts: new Date().toISOString(), ...row }));
  st.logPath ??= $.session.id().then(
    (id) => sessionLogPath(file, id),
    (error) => {
      $.ui.log(`sub-agent-compact: reading the session id failed: ${message(error)}; the decision log is off for this session`);
      return undefined;
    },
  );
  st.writing = st.writing
    .then(async () => {
      const path = await st.logPath;
      const rows = st.pending.splice(0);
      if (!path || rows.length === 0) return;
      const existing = (await $.fs.exists(path)) ? await $.fs.read(path) : '';
      await $.fs.write(path, appendRows(existing, rows, LOG_CAP));
    })
    .catch((error) => $.ui.log(`sub-agent-compact: writing the decision log for ${file} failed: ${message(error)}`));
}

function warnOnce(st: State, $: EngineInterface, key: string, line: string): void {
  if (st.warned.has(key)) return;
  st.warned.add(key);
  $.ui.log(line);
  record(st, $, { event: 'warning', key, line });
}

// First hook call: report option errors, learn the native window, build the resolver.
function start(st: State, $: EngineInterface): Promise<void> {
  st.started ??= (async () => {
    for (const line of st.config.errors) {
      $.ui.log(line);
      record(st, $, { event: 'option-error', line });
    }
    let cwd = '.';
    let home: string | undefined;
    try {
      cwd = await $.session.cwd();
    } catch (error) {
      $.ui.log(`sub-agent-compact: reading the session cwd failed: ${message(error)}; using relative paths`);
    }
    try {
      home = await $.env.get('HOME');
    } catch (error) {
      $.ui.log(`sub-agent-compact: reading HOME failed: ${message(error)}; skipping ~/.claude/agents`);
    }
    try {
      st.mainWindow = (await $.session.usage()).context.window;
    } catch (error) {
      $.ui.log(`sub-agent-compact: reading the main chat's window failed: ${message(error)}; percentages use ${FALLBACK_WINDOW}`);
    }
    try {
      const raw = await $.env.get('CLAUDE_CODE_AUTO_COMPACT_WINDOW');
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed) && parsed > 0) st.compactWindow = parsed;
    } catch (error) {
      $.ui.log(`sub-agent-compact: reading CLAUDE_CODE_AUTO_COMPACT_WINDOW failed: ${message(error)}`);
    }
    const dirs = [`${cwd}/.claude/agents`, ...(home ? [`${home}/.claude/agents`] : []), ...st.config.agentDirs];
    st.policies = new AgentPolicies(
      dirs,
      st.config.subagent,
      {
        exists: (path) => $.fs.exists(path),
        read: (path) => $.fs.read(path),
        listMarkdown: async (dir) =>
          (await $.fs.list(dir)).filter((entry) => entry.kind === 'file' && entry.name.endsWith('.md')).map((entry) => entry.name),
      },
      (line) => {
        $.ui.log(line);
        record(st, $, { event: 'resolve-error', line });
      },
    );
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
  /** Haiku runs on Claude Code's own compaction point: no nudges, no self-compaction. */
  haiku: boolean;
  /** An engine loop missing from `$.agent.list()`: no policy governs it, so it is never nudged, armed or held. */
  unlisted: boolean;
};

async function partyOf(st: State, $: EngineInterface, agentId: string | undefined): Promise<Party> {
  await start(st, $);
  const key = agentId ?? 'main';
  const model = st.models.get(key);
  const window = modelWindow(model, st.mainWindow ?? FALLBACK_WINDOW);
  if (!agentId) return { key, label: 'main', main: true, policy: st.config.main, source: 'mainAutoCompact', window, haiku: isHaiku(model), unlisted: false };
  const label = await agentType(st, $, agentId);
  if (label === undefined) return { key, label: 'unlisted', main: false, policy: st.config.subagent, source: 'unlisted', window, haiku: isHaiku(model), unlisted: true };
  const resolved = await st.policies!.resolve(label);
  const source = resolved.source === 'default' ? 'subagentAutoCompact' : resolved.source;
  return { key, label, main: false, policy: resolved.policy, source, window, haiku: isHaiku(model), unlisted: false };
}

/** The forced point in tokens; Haiku's is Claude Code's own ask point for its window. */
function limitOf(party: Party): number {
  return party.haiku ? engineAskPoint(party.window) : sizeTokens(party.policy.autoCompact, party.window);
}

function askPointOf(st: State): number | undefined {
  return st.compactWindow === undefined ? undefined : engineAskPoint(st.compactWindow);
}

/** Stores the party's handoff; returns why it was refused (Haiku, unlisted, below its first nudge point), or undefined once stored. */
function storeHandoff(st: State, $: EngineInterface, party: Party, handoff: ArmedHandoff, via: 'tool' | 'marker' | 'stop'): string | undefined {
  const tokens = st.parties.reading(party.key);
  const refused = handoffRefusal({ haiku: party.haiku, unlisted: party.unlisted, tokens, nudgeStart: sizeTokens(party.policy.nudgeStart, party.window) });
  if (refused !== undefined) {
    record(st, $, { event: 'handoff-refused', via, party: party.key, type: party.label, why: party.haiku ? 'haiku' : party.unlisted ? 'unlisted' : 'early', tokens: tokens ?? null });
    return refused;
  }
  st.parties.armHandoff(party.key, handoff);
  record(st, $, { event: 'handoff-stored', via, party: party.key, type: party.label, tokens: tokens ?? null, chars: handoff.text.length });
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
  if (!st.config.handoffTool && !st.config.compactTool) return undefined;
  const nudgeStart = sizeTokens(party.policy.nudgeStart, party.window);
  const nudgeEvery = sizeTokens(party.policy.nudgeEvery, party.window);
  const level = st.parties.nudgeDue(party.key, nudgeStart, nudgeEvery);
  const tokens = st.parties.reading(party.key);
  if (level === undefined || tokens === undefined) return undefined;
  const autoCompact = limitOf(party);
  record(st, $, { event: 'nudge', party: party.key, type: party.label, tokens, level, nudgeStart, nudgeEvery, autoCompact, window: party.window, tool: st.config.handoffTool ? 'handoff' : 'compact' });
  if (st.config.handoffTool) {
    return handoffNudgeText({ tokens, level, autoCompact, main: party.main, toolName: st.handoffToolName ?? `mcp__sub-agent-compact__${HANDOFF_TOOL}`, firstReading: st.parties.firstReading(party.key) });
  }
  return nudgeText({ tokens, window: party.window, level, autoCompact, main: party.main, toolName: st.toolName ?? `mcp__sub-agent-compact__${COMPACT_TOOL}` });
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
    $.ui.log(`sub-agent-compact: registering the ${COMPACT_TOOL} tool failed: ${message(error)}; models can still ask with <compact-now>`);
    record(st, $, { event: 'tool-register-failed', error: message(error) });
  }
}

async function registerHandoffTool(st: State, $: EngineInterface): Promise<void> {
  try {
    const { tool } = await $.tool.register({
      name: HANDOFF_TOOL,
      description: HANDOFF_TOOL_DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: { handoff: { type: 'string', description: HANDOFF_INPUT_DESCRIPTION } },
        required: ['handoff'],
      },
    });
    st.handoffToolName = tool;
    record(st, $, { event: 'tool-registered', tool });
  } catch (error) {
    $.ui.log(`sub-agent-compact: registering the ${HANDOFF_TOOL} tool failed: ${message(error)}; sub-agents can still hand off with <handoff>`);
    record(st, $, { event: 'tool-register-failed', tool: HANDOFF_TOOL, error: message(error) });
  }
}

async function answerHandoffTool(st: State, $: EngineInterface, agentId: string | undefined, text: unknown, toolUseId: unknown): Promise<string> {
  const problem = handoffProblem(text);
  if (problem !== undefined) return problem;
  const party = await partyOf(st, $, agentId);
  const handoff = (text as string).trim();
  if (typeof toolUseId !== 'string' || toolUseId === '') {
    $.ui.log(`sub-agent-compact: the ${HANDOFF_TOOL} call of ${party.label} carries no tool_use_id; its install falls back to a summary that keeps the handoff`);
  }
  const refused = storeHandoff(st, $, party, { text: handoff, anchor: { toolUseId: typeof toolUseId === 'string' ? toolUseId : '' } }, 'tool');
  if (refused !== undefined) return refused;
  return handoffStoredText({ chars: handoff.length });
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
    config: resolveOptions(options as Record<string, unknown>),
    types: new AgentTypes(),
    models: new Map(),
    parties: new Parties(),
    asked: new Set(),
    warned: new Set(),
    pending: [],
    writing: Promise.resolve(),
    mainCompactedThisTurn: false,
    mainCompacting: false,
  };

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    if (st.config.compactTool) await registerCompactTool(st, $);
    if (st.config.handoffTool) await registerHandoffTool(st, $);
    return result;
  });

  // The person's own message cancels a self-compaction the main chat's model armed; the model is told so.
  on('prompt.submit', async ($, e, next) => {
    try {
      const handoff = st.parties.handoff('main') !== undefined;
      if (personPrompt(e.origin) && st.parties.disarm('main')) {
        record(st, $, { event: 'disarmed', party: 'main', via: 'prompt', origin: e.origin.kind, what: handoff ? 'handoff' : 'compact' });
        return next({ ...e, context: [...(e.context ?? []), handoff ? handoffDisarmedText() : disarmedText()] });
      }
    } catch (error) {
      $.ui.log(`sub-agent-compact: reading the prompt's origin failed: ${message(error)}`);
    }
    return next(e);
  });

  // Track each loop's context and model from its responses, and read a sub-agent's <compact-now> request in its text.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e);
    const key = e.agentId ?? 'main';
    try {
      st.models.set(key, e.model);
      const tokens = contextTokens(result.usage);
      if (tokens !== undefined) st.parties.read(key, tokens);
      const main = e.agentId === undefined;
      const handoff = st.config.handoffTool ? handoffMarkerRequest({ answer: result.answer, toolCalls: result.toolUses.length, main }) : undefined;
      const focus = st.config.compactTool && handoff === undefined ? markerRequest({ answer: result.answer, toolCalls: result.toolUses.length, main }) : undefined;
      if (handoff !== undefined) storeHandoff(st, $, await partyOf(st, $, e.agentId), { text: handoff, anchor: { marker: true } }, 'marker');
      else if (focus !== undefined) arm(st, $, await partyOf(st, $, e.agentId), focus, 'marker');
    } catch (error) {
      $.ui.log(`sub-agent-compact: reading turn.step for ${key} failed: ${message(error)}`);
    }
    return result;
  });

  // Serve the handoff and compact tools; after any other tool, carry a nudge the party is owed.
  on('tool.call', async ($, e, next) => {
    if (st.handoffToolName !== undefined && e.tool === st.handoffToolName) {
      try {
        const input = e as Record<string, unknown>;
        return { result: await answerHandoffTool(st, $, e.agentId, input.handoff, input.tool_use_id) };
      } catch (error) {
        $.ui.log(`sub-agent-compact: storing the handoff of ${e.agentId ?? 'main'} failed: ${message(error)}`);
        return { result: `Not stored: ${message(error)}` };
      }
    }
    if (st.toolName !== undefined && e.tool === st.toolName) {
      try {
        return { result: await answerCompactTool(st, $, e.agentId, (e as Record<string, unknown>).focus) };
      } catch (error) {
        $.ui.log(`sub-agent-compact: arming ${e.agentId ?? 'main'} failed: ${message(error)}`);
        return { result: `Not armed: ${message(error)}` };
      }
    }
    const result = await next(e);
    if (result.deny !== undefined) return result;
    try {
      const line = await nudgeFor(st, $, e.agentId);
      if (line !== undefined) return { ...result, context: [...(result.context ?? []), line] };
    } catch (error) {
      $.ui.log(`sub-agent-compact: nudging ${e.agentId ?? 'main'} failed: ${message(error)}`);
    }
    return result;
  });

  // Every sub-agent's start names its type; a Workflow run's agents are never in $.agent.list(), so this is their only source.
  on('classic.SubagentStart', async ($, e, next) => {
    st.types.learn(e.agent_id, e.agent_type);
    return next(e);
  });

  // A sub-agent that sent its marker alone ended its run: arm it and refuse the stop once, so it compacts and carries on.
  on('classic.SubagentStop', async ($, e, next) => {
    st.types.learn(e.agent_id, e.agent_type);
    try {
      const continued = st.parties.continued(e.agent_id);
      const handoff = st.config.handoffTool ? handoffStopRequest({ lastMessage: e.last_assistant_message, continued }) : undefined;
      if (handoff !== undefined) {
        const party = await partyOf(st, $, e.agent_id);
        if (storeHandoff(st, $, party, { text: handoff, anchor: { marker: true } }, 'stop') === undefined) {
          st.parties.markContinued(e.agent_id);
          record(st, $, { event: 'stop-refused', party: e.agent_id, type: party.label, what: 'handoff' });
          return { block: CONTINUE_AFTER_HANDOFF };
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
      $.ui.log(`sub-agent-compact: reading ${e.agent_id}'s stop failed: ${message(error)}; letting it stop`);
    }
    return next(e);
  });

  on('session.compact', async ($, e, next) => {
    const agentId = e.agentId;
    const key = agentId ?? 'main';
    const base: Row = { event: 'session.compact', trigger: e.trigger, party: agentId ? 'sub' : 'main', agentId: agentId ?? null };
    let party: Party;
    let tokens: number | undefined;
    try {
      party = await partyOf(st, $, agentId);
      tokens = currentTokens(agentId ? st.parties.reading(agentId) : (await $.session.usage()).context.tokens, e.messages, st.asked.has(key));
    } catch (error) {
      const line = `sub-agent-compact: deciding ${agentId ? `sub-agent ${agentId}` : 'main'} ${e.trigger} compaction failed: ${message(error)}; letting it through`;
      $.ui.log(line);
      record(st, $, { ...base, decision: 'pass', why: 'error', error: message(error) });
      return next(e);
    }
    const limit = limitOf(party);
    const askPoint = askPointOf(st);
    const handoff = party.haiku || party.unlisted ? undefined : st.parties.handoff(key);
    if (handoff !== undefined) {
      // A precompute installs nothing and would keep a stale tail: the compaction it prepares installs the handoff instead.
      if (e.trigger === 'precompute') {
        record(st, $, { ...base, type: party.label, decision: 'skip', why: 'handoff-waits' });
        return { skip: 'handoff waits for the compaction' };
      }
      if (e.trigger === 'manual') {
        // The person's own /compact runs as they asked; the stored handoff is dropped.
        st.parties.disarm(key);
        record(st, $, { event: 'disarmed', party: key, via: 'manual', what: 'handoff' });
      } else {
        try {
          const brief = agentId && st.config.keepBrief ? seatedBrief(e.messages, BRIEF_MAX_TOKENS) : undefined;
          const installed = installHandoff(e.messages, { text: handoff.text, anchor: handoff.anchor, ...(brief !== undefined ? { brief } : {}) });
          if (installed !== undefined) {
            const tokensAfter = estimateTranscript(installed.messages);
            if (e.trigger === 'auto') st.asked.add(key);
            if (!agentId) st.mainCompactedThisTurn = true;
            st.parties.compacted(key, tokensAfter);
            record(st, $, { ...base, type: party.label, limit, tokens: tokens ?? null, messages: e.messages.length, decision: 'handoff', tail: installed.tail, siblings: installed.siblings, brief: brief !== undefined, chars: handoff.text.length, tokensAfter });
            return { messages: installed.messages, ...(tokens !== undefined ? { tokensBefore: tokens } : {}), tokensAfter };
          }
          $.ui.log(`sub-agent-compact: the handoff of ${party.label} is not anchored in its transcript; a summary keeps it instead`);
          record(st, $, { event: 'handoff-unanchored', party: key, type: party.label, anchor: 'toolUseId' in handoff.anchor ? 'tool' : 'marker' });
        } catch (error) {
          $.ui.log(`sub-agent-compact: installing the handoff of ${party.label} failed: ${message(error)}; a summary keeps it instead`);
          record(st, $, { event: 'handoff-error', party: key, error: message(error) });
        }
        // Never hold a compaction: the summarizer runs with the handoff as what it keeps.
        st.parties.arm(key, handoff.text);
      }
    }
    if (!party.main && !party.haiku && !party.unlisted && askPoint !== undefined && limit < askPoint) {
      warnOnce(st, $, `below-window:${party.label}`, `sub-agent-compact: ${party.label} limit ${limit} is below Claude Code's ask point ${askPoint} (CLAUDE_CODE_AUTO_COMPACT_WINDOW ${st.compactWindow}); it compacts at ${askPoint} — lower the window to hold this limit`);
    }
    const armed = party.haiku || party.unlisted ? undefined : st.parties.armed(key);
    const decision = decide({ trigger: e.trigger, label: party.label, limit, tokens, enabled: party.haiku || party.policy.enabled, armed, unlisted: party.unlisted });
    record(st, $, { ...base, type: party.label, limit, source: party.haiku ? 'haiku' : party.source, tokens: tokens ?? null, lastResponseTokens: st.parties.reading(key) ?? null, messages: e.messages.length, decision: decision.action, ...(decision.action === 'pass' ? { why: decision.why } : {}) });
    if (decision.action === 'skip') {
      if (e.trigger === 'auto') st.asked.add(key);
      return { skip: decision.reason };
    }
    if (decision.why === 'no-reading') $.ui.log(`sub-agent-compact: no token reading for ${party.label} and no transcript estimate to trust; letting the ${e.trigger} compaction through`);
    const firstAsk = !st.asked.has(key);
    if (e.trigger === 'auto') st.asked.add(key);
    // With the window known, a first ask past the limit is one step's growth, not a window set too high.
    if (e.trigger === 'auto' && firstAsk && !party.unlisted && st.compactWindow === undefined && tokens !== undefined && tokens > limit * 1.1) {
      warnOnce(st, $, `late:${party.label}`, `sub-agent-compact: ${party.label} was first asked to compact at ${tokens}, past its limit ${limit}; CLAUDE_CODE_AUTO_COMPACT_WINDOW is unset, so Claude Code's native window is likely above this limit — set it to your smallest sub-agent limit`);
    }
    if (!agentId) st.mainCompactedThisTurn = true;
    // A self-compaction's focus becomes what the summarizer is told; a person's or plugin's instructions come first.
    const input = decision.why === 'self' && armed !== undefined ? { ...e, instructions: e.instructions ? `${e.instructions}\n\n${armed}` : armed } : e;
    // A compaction armed by the model that does not finish drops its focus: the person's interrupt, a skip beneath or a failure never leaves it to fire on the next request.
    const dropArm = (why: string): void => {
      if (armed !== undefined && st.parties.disarm(key)) record(st, $, { event: 'disarmed', party: key, via: why, trigger: e.trigger });
    };
    const onAbort = (): void => {
      if (compactionEnd({ trigger: e.trigger, skipped: false, aborted: true }) === 'unfinished') dropArm('interrupt');
    };
    next.signal.addEventListener('abort', onAbort, { once: true });
    // An interrupt that landed before this hook reached the compaction fires no event; read it now.
    if (next.signal.aborted) onAbort();
    let outcome: Awaited<ReturnType<typeof next>>;
    try {
      outcome = await next(input);
    } catch (error) {
      if (compactionEnd({ trigger: e.trigger, skipped: false, aborted: true }) === 'unfinished') dropArm('error');
      throw error;
    } finally {
      next.signal.removeEventListener('abort', onAbort);
    }
    // An outcome that came back is judged by its skip alone: a compaction that returned its messages ran.
    const end = compactionEnd({ trigger: e.trigger, skipped: outcome.skip !== undefined, aborted: false });
    if (end === 'compacted' && outcome.skip === undefined) st.parties.compacted(key, outcome.tokensAfter);
    else if (end === 'unfinished') dropArm('skipped');
    // A sub-agent's brief is its first message, which the summary replaces: seat it back right after the summary.
    if (agentId && st.config.keepBrief && outcome.skip === undefined) {
      try {
        const messages = reseatBrief(e.messages, outcome.messages, BRIEF_MAX_TOKENS);
        if (messages !== outcome.messages) {
          record(st, $, { event: 'brief-seated', party: key, type: party.label, messages: messages.length, chars: messages[1]?.text.length ?? null });
          return { ...outcome, messages };
        }
      } catch (error) {
        $.ui.log(`sub-agent-compact: seating the brief of sub-agent ${agentId} failed: ${message(error)}; leaving the compaction as Claude Code made it`);
        record(st, $, { event: 'brief-error', party: key, error: message(error) });
      }
    }
    return outcome;
  });

  // Main between turns: the compaction its model armed below Claude Code's ask point, or its forced point.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) return result;
    if (st.mainCompactedThisTurn) {
      st.mainCompactedThisTurn = false;
      return result;
    }
    if (st.mainCompacting) return result;
    try {
      const party = await partyOf(st, $, undefined);
      const focus = party.haiku ? undefined : st.parties.armed('main');
      const handoff = party.haiku ? undefined : st.parties.handoff('main');
      const tokens = (await $.session.usage()).context.tokens;
      const limit = limitOf(party);
      const forced = party.policy.enabled && tokens !== undefined && tokens >= limit;
      if (focus === undefined && handoff === undefined && !forced) return result;
      st.mainCompacting = true;
      record(st, $, { event: 'turn.complete', party: 'main', tokens: tokens ?? null, limit, action: 'compact', why: handoff !== undefined ? 'handoff' : focus !== undefined ? 'self' : 'at-limit' });
      const outcome = await $.session.compact(focus !== undefined ? { instructions: focus } : {});
      record(st, $, { event: 'turn.complete.compacted', party: 'main', skipped: 'skip' in outcome && outcome.skip ? outcome.skip : null });
    } catch (error) {
      $.ui.log(`sub-agent-compact: compacting main between turns failed: ${message(error)}`);
      record(st, $, { event: 'turn.complete', party: 'main', error: message(error) });
    } finally {
      st.mainCompacting = false;
      st.mainCompactedThisTurn = false;
    }
    return result;
  });
};
