import { describe, expect, it } from 'vitest';
import { toolsToRegister } from '../plugins/sub-agent-compact/src/register.ts';

describe('toolsToRegister', () => {
  const both = { compact: true, handoff: true };
  const none = { compact: false, handoff: false };

  it('names each enabled tool that is not registered yet and has tries left', () => {
    expect(toolsToRegister(both, none, { compact: 0, handoff: 2 }, 3)).toEqual(['compact', 'handoff']);
    expect(toolsToRegister({ compact: false, handoff: true }, none, { compact: 0, handoff: 0 }, 3)).toEqual(['handoff']);
  });

  it('leaves out a registered tool and one whose tries are spent, so nothing is left to wait on', () => {
    expect(toolsToRegister(both, { compact: true, handoff: false }, { compact: 1, handoff: 3 }, 3)).toEqual([]);
    expect(toolsToRegister(none, none, { compact: 0, handoff: 0 }, 3)).toEqual([]);
  });
});
