import { URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engine, text, TRANSCRIPT, FIELDS, type Env } from './forward-engine.ts';

// The shipped artifact is the TypeScript hook itself; boot it in Node, with the existing host double.
const [name, mode = 'central'] = process.argv.slice(2);
const donor = JSON.parse(readFileSync(new URL(`../fixtures/forward-handoff/${name}.json`, import.meta.url), 'utf8'));
const root = mkdtempSync(join(tmpdir(), 'forward-replay-'));
try {
  const transcript = join(root, 'transcript.jsonl');
  const rows: any[] = donor.users?.map((u: string) => ({ role: 'user', content: [text(u)] })) ?? [];
  const extraPrompt = 'Use the newer correction, not the earlier instruction.';
  const archived = mode === 'archived' ? JSON.parse(readFileSync(new URL('../fixtures/forward-handoff/native-compaction.json', import.meta.url), 'utf8')).oldWakes[0] : undefined;
  if (mode === 'cancelled') rows.push(...donor.previous.users.map((u: string) => ({ role: 'user', content: [text(u)] })), { role: 'user', content: [text(extraPrompt)] });
  if (mode === 'chronology') rows.push({ role: 'user', content: [text(extraPrompt)] });
  const disk = [...(donor.oldWakes ?? []).filter((w: string) => mode !== 'cancelled-native' || w !== donor.wake).map((w: string) => ({ type: 'user', message: { role: 'user', content: w } })),
    ...(mode === 'cancelled-native' ? [...donor.previous.users, extraPrompt].map((content: string) => ({ type: 'user', message: { content } })) : []),
    ...(donor.boundary ? [donor.boundary] : []), ...(donor.transcript ?? []),
    ...(mode === 'chronology' ? [{ type: 'user', message: { content: extraPrompt } }] : []),
    ...(archived ? [{ type: 'user', message: { content: archived } }] : [])];
  writeFileSync(transcript, disk.map((r) => JSON.stringify(r)).join('\n') + '\n');
  if (donor.summary) rows.push({ role: 'user', content: [text(donor.summary)] });
  else if (donor.wake && mode !== 'cancelled') rows.push({ role: 'user', content: [text(donor.wake)] });
  rows.push({ role: 'assistant', content: [] });
  if (archived) rows.push({ role: 'user', content: [text(archived)] });
  if (mode === 'pollution') for (const wake of donor.oldWakes.slice(0, -1)) rows.push({ role: 'user', content: [text(wake)] });
  const agentId = mode === 'agent' ? 'agent-1' : undefined;
  const files: Record<string, string> = {};
  for (const [skill, body] of Object.entries(donor.skillBodies ?? {})) files[`${root}/.claude/skills/${skill}/SKILL.md`] = body as string;
  if (agentId) files['/nowhere/.claude/agents/reader.md'] = '---\nname: reader\nautoCompact:\n  pinSkills:\n    - god-speed\n  dropSkills: [testing-manual]\n---\n';
  const policy = mode === 'overlap' ? { pinSkills: ['god-speed'], dropSkills: ['god-speed', 'testing-manual'] }
    : mode === 'drop' ? { dropSkills: ['god-speed', 'testing-manual'] }
    // Opposite central lists prove both agent fields override rather than inherit.
    : mode === 'agent' ? { pinSkills: ['testing-manual'], dropSkills: ['god-speed'] }
    : { pinSkills: ['god-speed'], dropSkills: ['testing-manual'] };
  const env: Env = {
    home: root, pluginLogDir: join(root, 'logs'), settings: { merged: { autoCompact: mode === 'invalid' ? { pinSkills: 'god-speed' } : policy } },
    ...(agentId ? { agents: [{ id: agentId, type: 'reader' }], agentRows: { [agentId]: rows } } : {}),
    run: (argv) => {
      if ((argv[0] !== 'grep' && argv[0] !== 'sh') || !argv.includes(TRANSCRIPT)) return undefined;
      const run = spawnSync(argv[0], argv.slice(1).map((a) => a === TRANSCRIPT ? transcript : a), { encoding: 'utf8', env: { PATH: process.env.PATH } });
      if (run.error) throw run.error;
      return { exitCode: run.status ?? 2, stdout: run.stdout, stderr: run.stderr };
    },
  };
  const cc = engine({ forwardHandoffTool: true, logFile: `${root}/decisions.jsonl` }, files, rows, true, [], env);
  const base = `${root}/.local/state/sub-agent-compact/forward-handoff/session-1${agentId ? `/agent-${agentId}` : ''}`;
  if (donor.previous) {
    cc.written[`${base}/${donor.previous.seq}/record.json`] = JSON.stringify(donor.previous);
    cc.written[`${base}/${donor.previous.seq}/wake.txt`] = donor.wake;
  }
  await cc.start();
  await cc.step(250_000, 'claude-opus-4-5[1m]', agentId);
  const fields = { ...FIELDS, ...(mode === 'drop' ? {} : donor.drop_skills ? { drop_skills: donor.drop_skills } : {}) };
  const reply = await cc.forward(fields, agentId);
  const seq = (donor.previous?.seq ?? 0) + 1;
  const dir = `${base}/${seq}`;
  const first = JSON.parse(cc.written[`${dir}/record.json`]!);
  const wake = cc.written[`${dir}/wake.txt`]!;
  const installed = await cc.ask('auto', undefined, agentId ? { agentId } : {});
  rows.splice(0, rows.length, { role: 'user', content: [text(installed.messages.find((m: any) => m.text === wake)?.text)] });
  await cc.step(250_000, 'claude-opus-4-5[1m]', agentId);
  const checked = JSON.parse(cc.written[`${dir}/record.json`]!);
  rows.push({ role: 'assistant', content: [] });
  if (mode === 'delayed' || mode === 'delayed-api') {
    const rendered = `<system-reminder>\nThe user sent a new message while you were working:\n${donor.prompt}\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.\n</system-reminder>`;
    appendFileSync(transcript, JSON.stringify({ type: 'attachment', attachment: { type: 'queued_command', prompt: donor.prompt, origin: { kind: 'human' } }, rendered: [{ content: rendered }] }) + '\n');
    if (mode === 'delayed-api') rows.push({ role: 'user', content: [text(rendered)] });
  }
  await cc.forward(FIELDS, agentId);
  const second = JSON.parse(cc.written[`${base}/${seq + 1}/record.json`]!);
  const decisions = await cc.decisions();
  await cc.end();
  const activity = join(root, 'logs/sub-agent-compact/errors.jsonl');
  const errors = existsSync(activity) ? readFileSync(activity, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line).msg) : [];
  process.stdout.write(JSON.stringify({ pid: process.pid, first, second, wake, installed: installed.messages.find((m: any) => m.text === wake)?.text, checked, reply: reply.result, decisions, errors, logs: cc.logs }));
} finally {
  rmSync(root, { recursive: true, force: true });
}
