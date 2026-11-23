import { afterEach, describe, expect, it } from 'vitest';
import { briefFiles, readBriefFiles } from '../plugins/forward-compaction/src/brief-files.ts';
import { A1, begin, cleanup, spawn, step, store, transcript } from './fakes/session.ts';

afterEach(cleanup);

type Work = { files?: { path: string; tag: 'R' | 'E' | 'W' }[]; commands?: string[]; asked?: string[]; home?: string };

describe('briefFiles: the documents a brief names that its party opened and did not write', () => {
  const pick = (brief: string, work: Work): string[] =>
    briefFiles({ brief, ...(work.home !== undefined ? { home: work.home } : {}), files: work.files ?? [], commands: (work.commands ?? []).map((command) => ({ command })), asked: work.asked ?? [] });

  it.each<[string, string, Work, string[]]>([
    ['a document read with the Read tool', 'Your whole brief is the file /lab/brief.md — read it first.', { files: [{ path: '/lab/brief.md', tag: 'R' }] }, ['/lab/brief.md']],
    ['a document a shell command read', 'Build per `/lab/spec.md`.', { commands: ['sed -n 1,80p /lab/spec.md'] }, ['/lab/spec.md']],
    ["several in the brief's order, each once", 'Read /lab/b.md, then /lab/a.txt (and /lab/b.md again).', { commands: ['cat /lab/a.txt /lab/b.md'] }, ['/lab/b.md', '/lab/a.txt']],
    ['a path under ~ once home is known, opened under either spelling', 'Spec: ~/flights/x/spec.md and ~/flights/x/req.md.', { home: '/u', commands: ['cat ~/flights/x/spec.md', 'cat "/u/flights/x/req.md"'] }, ['/u/flights/x/spec.md', '/u/flights/x/req.md']],
    ['a path closed by bold marks, a line number or a sentence end', 'See **/lab/a.md**, /lab/b.md:12 and /lab/c.md.', { commands: ['cat /lab/a.md /lab/b.md /lab/c.md'] }, ['/lab/a.md', '/lab/b.md', '/lab/c.md']],
    ['none it never opened', 'Brief: /lab/brief.md.', {}, []],
    ['none it wrote or edited', 'Report to /lab/report.md; spec /lab/spec.md.', { files: [{ path: '/lab/report.md', tag: 'W' }, { path: '/lab/spec.md', tag: 'E' }], commands: ['cat /lab/report.md /lab/spec.md'] }, []],
    ['none its frontier asks to carry itself', 'Brief: /lab/brief.md.', { files: [{ path: '/lab/brief.md', tag: 'R' }], asked: ['/lab/brief.md'] }, []],
    ['no source, data or log file', 'Fix /src/a.ts per /lab/rows.jsonl and /lab/run.log.', { commands: ['cat /src/a.ts /lab/rows.jsonl /lab/run.log'] }, []],
    ['no relative path, URL or longer file name', 'See docs/spec.md, https://x.test/a/readme.md and /lab/a.md.bak.', { commands: ['cat docs/spec.md /lab/a.md.bak; curl https://x.test/a/readme.md'] }, []],
    ['no path a command holds only as the end of a longer one', 'Every docs/**/spec.md.', { commands: ['cat /srv/flights/spec.md'] }, []],
    ['no path under ~ while home is unknown', 'Spec: ~/x/spec.md.', { commands: ['cat ~/x/spec.md'] }, []],
  ])('picks %s', (_name, brief, work, expected) => {
    expect(pick(brief, work)).toEqual(expected);
  });
});

describe('readBriefFiles: each document as it reads at install, all within one budget of 40000 characters', () => {
  const reader = (files: Record<string, string>) => async (path: string): Promise<string> => {
    if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    return files[path]!;
  };
  const line = 'x'.repeat(99);
  const big = Array.from({ length: 300 }, () => line).join('\n'); // 29,999 characters

  it('carries each whole while the budget holds, cuts the one that crosses it at a line and says where to read on, and names the next as not carried', async () => {
    const out = await readBriefFiles(reader({ '/a.md': 'rule one\nrule two\n', '/big.md': big, '/big2.md': big, '/c.md': 'y'.repeat(80) }), ['/a.md', '/big.md', '/big2.md', '/c.md']);
    expect(out).toEqual([
      { path: '/a.md', content: 'rule one\nrule two\n' },
      { path: '/big.md', content: big },
      { path: '/big2.md', lines: '1-99', content: `${Array.from({ length: 99 }, () => line).join('\n')}\n[201 more lines not carried: Read /big2.md from line 100]` },
      { path: '/c.md', problem: 'the 40000 characters the documents your brief names share are used up: Read it again before you act on what it says' },
    ]);
  });

  it('names a document it cannot read, an empty one and a binary one by its problem, and they take none of the budget', async () => {
    const out = await readBriefFiles(reader({ '/empty.md': '', '/bin.md': 'a\u0000b', '/big.md': big, '/last.md': 'kept' }), ['/gone.md', '/empty.md', '/bin.md', '/big.md', '/last.md']);
    expect(out).toEqual([
      { path: '/gone.md', problem: 'ENOENT: /gone.md' },
      { path: '/empty.md', problem: 'the file is empty' },
      { path: '/bin.md', problem: 'not a text file' },
      { path: '/big.md', content: big },
      { path: '/last.md', content: 'kept' },
    ]);
  });
});

describe("a sub-agent's wake reads in the documents its brief names", () => {
  it("carries the documents a sub-agent's brief names and its calls opened read at install: a frontier wake, and a mechanical one, which lists such a document once", async () => {
    const pointer = 'Your whole brief is the file /lab/brief.md: read it first. Report to /lab/report.md.';
    const f = await begin({ files: { '/lab/brief.md': { content: 'Watch each test fail first.\n' }, '/lab/report.md': { content: 'old report\n' }, '/src/a.ts': { content: 'code\n' } } });
    const docs = '## The documents your brief names, read at install\nThey are part of your brief: where your frontier words one of their rules differently, their words hold.\n### /lab/brief.md\nWatch each test fail first.\n';
    const opening = (id: string) => [{ role: 'user', text: pointer, toolUses: [], handle: 'h0' }, ...transcript(id).slice(1)];
    await spawn(f, A1, pointer);
    await f.dispatch('tool.call', { tool: 'Bash', tool_use_id: 'tu-cat', agentId: A1, command: 'cat /lab/brief.md /lab/report.md' }, async () => ({ result: 'Watch each test fail first.' }));
    await f.dispatch('tool.call', { tool: 'Write', tool_use_id: 'tu-w', agentId: A1, file_path: '/lab/report.md', content: 'new' }, async () => ({ result: 'written' }));
    await step(f, 64_000, A1);
    await store(f, A1);
    const stored = await f.dispatch('session.compact', { trigger: 'auto', agentId: A1, messages: opening('tu-h') }, async () => ({ skip: 'native ran' }));
    expect(stored.messages[2].text.split('\n\n')[1]).toBe(docs.trimEnd());
    expect(stored.messages[2].text).not.toContain('old report'); // the report is the party's own work: its frontier carries it

    const A2 = 'f6e7d8c9b0';
    await f.dispatch('agent.spawn', { tool_use_id: 'tu-spawn-2', prompt: pointer, description: 'two', subagentType: 'general-purpose', provider: { kind: 'local' } }, async () => ({ model: 'sonnet', agentId: A2 }));
    await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-r1', agentId: A2, file_path: '/lab/brief.md' }, async () => ({ result: 'Watch each test fail first.' }));
    await f.dispatch('tool.call', { tool: 'Read', tool_use_id: 'tu-r2', agentId: A2, file_path: '/src/a.ts' }, async () => ({ result: 'code' }));
    await step(f, 125_000, A2);
    const mechanical = await f.dispatch('session.compact', { trigger: 'auto', agentId: A2, messages: opening('tu-none') }, async () => ({ skip: 'native ran' }));
    const text: string = mechanical.messages[2].text;
    expect(text.split('\n\n')[1]).toBe(docs.trimEnd());
    expect(text).toContain('## Files you were working on, newest first, read at install\n### /src/a.ts\ncode\n');
    expect(text.split('### /lab/brief.md')).toHaveLength(2);
  });
});
