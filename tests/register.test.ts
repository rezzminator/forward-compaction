import { describe, expect, it } from 'vitest';
import { toolsToRegister } from '../plugins/sub-agent-compact/src/register.ts';

describe('toolsToRegister', () => {
  const both = { compact: true, handoff: true, forward: false };
  const none = { compact: false, handoff: false, forward: false };

  it('names each enabled tool that is not registered yet and has tries left', () => {
    expect(toolsToRegister(both, none, { compact: 0, handoff: 2, forward: 0 }, 3)).toEqual(['compact', 'handoff']);
    expect(toolsToRegister({ compact: false, handoff: true, forward: false }, none, { compact: 0, handoff: 0, forward: 0 }, 3)).toEqual(['handoff']);
  });

  it('leaves out a registered tool and one whose tries are spent, so nothing is left to wait on', () => {
    expect(toolsToRegister(both, { compact: true, handoff: false, forward: false }, { compact: 1, handoff: 3, forward: 0 }, 3)).toEqual([]);
    expect(toolsToRegister(none, none, { compact: 0, handoff: 0, forward: 0 }, 3)).toEqual([]);
  });

  it('names the forward handoff tool when it is on, and stops after its tries', () => {
    const on = { ...none, forward: true };
    expect(toolsToRegister(on, none, { compact: 0, handoff: 0, forward: 0 }, 3)).toEqual(['forward']);
    expect(toolsToRegister(on, { ...none, forward: true }, { compact: 0, handoff: 0, forward: 1 }, 3)).toEqual([]);
    expect(toolsToRegister(on, none, { compact: 0, handoff: 0, forward: 3 }, 3)).toEqual([]);
  });
});
