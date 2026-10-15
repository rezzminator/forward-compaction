import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatSize, OPTION_ENV, resolveOptions } from '../plugins/sub-agent-compact/src/limits.ts';
import { servedOptions, toolsToRegister } from '../plugins/sub-agent-compact/src/register.ts';

describe('toolsToRegister', () => {
  it('includes look_back and shares the registered/exhausted retry decisions (R1)', () => {
    const none = { compact: false, handoff: false, forward: false, look_back: false };
    const enabled = { ...none, look_back: true };
    const tries = { compact: 0, handoff: 0, forward: 0, look_back: 0 };
    expect(toolsToRegister(enabled as never, none as never, tries as never, 3)).toEqual(['look_back']);
    expect(toolsToRegister(enabled as never, { ...none, look_back: true } as never, tries as never, 3)).toEqual([]);
    expect(toolsToRegister(enabled as never, none as never, { ...tries, look_back: 3 } as never, 3)).toEqual([]);
  });
  const both = { compact: true, handoff: true, forward: false, look_back: false };
  const none = { compact: false, handoff: false, forward: false, look_back: false };

  it('names each enabled tool that is not registered yet and has tries left', () => {
    expect(toolsToRegister(both, none, { compact: 0, handoff: 2, forward: 0, look_back: 0 }, 3)).toEqual(['compact', 'handoff']);
    expect(toolsToRegister({ compact: false, handoff: true, forward: false, look_back: false }, none, { compact: 0, handoff: 0, forward: 0, look_back: 0 }, 3)).toEqual(['handoff']);
  });

  it('leaves out a registered tool and one whose tries are spent, so nothing is left to wait on', () => {
    expect(toolsToRegister(both, { compact: true, handoff: false, forward: false, look_back: false }, { compact: 1, handoff: 3, forward: 0, look_back: 0 }, 3)).toEqual([]);
    expect(toolsToRegister(none, none, { compact: 0, handoff: 0, forward: 0, look_back: 0 }, 3)).toEqual([]);
  });

  it('names the forward handoff tool when it is on, and stops after its tries', () => {
    const on = { ...none, forward: true };
    expect(toolsToRegister(on, none, { compact: 0, handoff: 0, forward: 0, look_back: 0 }, 3)).toEqual(['forward']);
    expect(toolsToRegister(on, { ...none, forward: true }, { compact: 0, handoff: 0, forward: 1, look_back: 0 }, 3)).toEqual([]);
    expect(toolsToRegister(on, none, { compact: 0, handoff: 0, forward: 3, look_back: 0 }, 3)).toEqual([]);
  });
});

describe('servedOptions', () => {
  const base = { compactTool: true, handoffTool: false, forwardHandoffTool: false, other: 1 };
  it('hides the compact tool while the forward handoff is on, and keeps every other option', () => {
    expect(servedOptions({ ...base, forwardHandoffTool: true })).toEqual({ ...base, forwardHandoffTool: true, compactTool: false });
  });
  it('leaves the compact tool as set while the forward handoff is off', () => {
    expect(servedOptions(base)).toEqual(base);
    expect(servedOptions({ ...base, compactTool: false })).toEqual({ ...base, compactTool: false });
  });
});

describe('the environment reads in the hooks module', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const source = readFileSync(join(root, 'plugins/sub-agent-compact/hooks/sub-agent-compact.ts'), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');

  it('spells each variable of OPTION_ENV as its own string literal, once, the name Claude Code lists', () => {
    const names = Object.values(OPTION_ENV);
    expect(names).toHaveLength(14);
    const spelled = [...source.matchAll(/readOptionVar\('([A-Z_]+)', \(\) => \$\.env\.get\('([A-Z_]+)'\)\)/g)].map((match) => [match[1], match[2]]);
    expect(spelled).toEqual(names.map((name) => [name, name]));
  });

  it('documents exactly the variables of OPTION_ENV in the README options table, with the default the code holds', () => {
    const rows = [...readme.matchAll(/^\| `([A-Za-z]+)` \| `(SUB_AGENT_COMPACT_[A-Z_]+)` \| ([^|]+) \|/gm)].map((match) => [match[1], match[2], match[3]!.trim()]);
    expect(rows.map(([option, name]) => [option, name]).sort()).toEqual(Object.entries(OPTION_ENV).sort());
    const defaults = resolveOptions();
    const held: Record<string, string> = {
      mainAutoCompact: formatSize(defaults.main.autoCompact),
      mainAutoCompactNudgeStart: formatSize(defaults.main.nudgeStart),
      mainAutoCompactNudgeEvery: formatSize(defaults.main.nudgeEvery),
      mainAutoCompactEnabled: String(defaults.main.enabled),
      subagentAutoCompact: formatSize(defaults.subagent.autoCompact),
      subagentAutoCompactNudgeStart: formatSize(defaults.subagent.nudgeStart),
      subagentAutoCompactNudgeEvery: formatSize(defaults.subagent.nudgeEvery),
      subagentAutoCompactEnabled: String(defaults.subagent.enabled),
      subagentKeepBrief: String(defaults.keepBrief),
      forwardHandoffTool: String(defaults.forwardHandoffTool),
      handoffTool: String(defaults.handoffTool),
      compactTool: String(defaults.compactTool),
      agentDirs: 'empty',
      logFile: 'empty',
    };
    expect(Object.fromEntries(rows.map(([option, , shown]) => [option, shown!.replace(/`/g, '')]))).toEqual(held);
  });
});
