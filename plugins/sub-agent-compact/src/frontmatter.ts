/**
 * Reads the scalar keys of a markdown file's leading YAML frontmatter
 * (`---` ... `---`): `key: value` lines at column 0, and one level of nesting
 * under a key with no value of its own, read as `parent.child`. Lists and
 * block scalars are skipped. No frontmatter → {}.
 */
export function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const fields: Record<string, string> = {};
  let parent: string | undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '---') return fields;
    const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (top) {
      const value = scalar(top[2] ?? '');
      fields[top[1] as string] = value;
      parent = value === '' ? (top[1] as string) : undefined;
      continue;
    }
    const nested = /^\s+([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (nested && parent !== undefined) fields[`${parent}.${nested[1]}`] = scalar(nested[2] ?? '');
  }
  return {}; // unterminated: not frontmatter
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (/^(["']).*\1$/.test(value)) return value.slice(1, -1);
  return value.replace(/\s+#.*$/, '');
}

/**
 * A list key of the leading frontmatter, as Claude Code's agent definitions
 * write `tools` and `disallowedTools`: a comma scalar (`a, b`), a flow list
 * (`[a, b]`) or a block list (`- a` lines under the key). An absent key, an
 * empty value or no frontmatter → undefined.
 */
export function frontmatterList(text: string, key: string): string[] | undefined {
  const nested = nestedFrontmatterValue(text, key);
  if (key.includes('.')) return Array.isArray(nested) && nested.every((v) => typeof v === 'string') ? nested : undefined;
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return undefined;
  for (let i = 1; i < end; i++) {
    const top = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i] ?? '');
    if (!top || top[1] !== key) continue;
    const value = (top[2] ?? '').replace(/\s+#.*$/, '').trim();
    const items: string[] = [];
    if (value !== '') {
      const flow = /^\[(.*)\]$/.exec(value);
      items.push(...(flow ? (flow[1] ?? '') : value).split(','));
    } else {
      for (let j = i + 1; j < end; j++) {
        const item = /^\s*-\s+(.*)$/.exec(lines[j] ?? '');
        if (!item) break;
        items.push(item[1] ?? '');
      }
    }
    const list = items.map((item) => scalar(item)).filter((item) => item !== '');
    return list.length > 0 ? list : undefined;
  }
  return undefined;
}

/** A nested list's raw value, so policy validation can distinguish absent, empty and malformed. */
export function nestedFrontmatterValue(text: string, key: string): unknown {
  const [parent, child] = key.split('.');
  if (child === undefined) return undefined;
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end < 0) return undefined;
  let under = false;
  const valueOf = (raw: string): unknown => {
    const s = scalar(raw);
    if (/^\d+(?:\.\d+)?$/.test(raw.trim())) return Number(raw.trim());
    return /^(?:true|false|null)$/.test(raw.trim()) ? JSON.parse(raw.trim()) : s;
  };
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\S/.test(line)) under = line.replace(/\s+#.*$/, '').trim() === `${parent}:`;
    const match = /^\s+([\w-]+):\s*(.*)$/.exec(line);
    if (!under || match?.[1] !== child) continue;
    const raw = match[2]!.replace(/\s+#.*$/, '').trim();
    if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1).trim() === '' ? [] : raw.slice(1, -1).split(',').map(valueOf);
    if (raw !== '') return valueOf(raw);
    const items: unknown[] = [];
    for (let j = i + 1; j < end; j++) {
      if (lines[j]!.trim() === '' || lines[j]!.trimStart().startsWith('#')) continue;
      const item = /^\s+-\s+(.*)$/.exec(lines[j]!);
      if (!item) break;
      items.push(valueOf(item[1]!));
    }
    return items.length > 0 ? items : '';
  }
  return undefined;
}
