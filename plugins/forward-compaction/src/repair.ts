// Reads a tool argument that arrived as text because the JSON the model wrote for it did not parse: its brackets are
// balanced and it is read again. Hand-written: the plugin's sandbox loads no dependency, and the slips are few and known.

const CLOSER: Record<string, string> = { '{': '}', '[': ']' };
const BARE_OP = /^(add|remove|edit)\s*:/;
/** An operation named by the tool-call tag a model leaks when it writes a list's object as nested parameters: `<parameter name="add">[…]</parameter>`. */
const TAG_OP = /^<(?:\w+:)?parameter name="(add|remove|edit)">/;
const TAG_END = /^<\/(?:\w+:)?parameter>/;

/** `text` with its brackets balanced: a closer that skips open brackets gets theirs first, one with nothing open is dropped, and the end closes an open string and every open bracket. Strings pass whole. */
function balanced(text: string): string {
  const open: string[] = [];
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (CLOSER[ch] !== undefined) open.push(CLOSER[ch]!);
    else if (ch === '}' || ch === ']') {
      const at = open.lastIndexOf(ch);
      if (at < 0) continue;
      while (open.length > at + 1) out += open.pop();
      open.pop();
    }
    out += ch;
  }
  return out + (inString ? '"' : '') + open.reverse().join('');
}

/** `add: [...], remove: [...]` as an object: each bare operation name at the top level quoted, the whole braced. An operation named by a leaked tag reads the same, its closing tag dropped and the comma the tags stand for put back. */
function braced(text: string): string {
  let out = '{';
  let depth = 0;
  let inString = false;
  let keyPlace = true;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (ch === '\\') out += text[++i] ?? '';
      else if (ch === '"') inString = false;
      continue;
    }
    const tag = ch === '<' && depth === 0 ? TAG_OP.exec(text.slice(i)) : null;
    const op = tag ?? (keyPlace && depth === 0 ? BARE_OP.exec(text.slice(i)) : null);
    if (op !== null) {
      out += `${tag !== null && /[\]}"\d]\s*$/.test(out) ? ',' : ''}"${op[1]}":`;
      i += op[0].length - 1;
      keyPlace = false;
      continue;
    }
    const end = ch === '<' && depth === 0 ? TAG_END.exec(text.slice(i)) : null;
    if (end !== null) {
      i += end[0].length - 1;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (ch.trim() !== '') keyPlace = ch === ',' && depth === 0;
    out += ch;
  }
  return `${out}}`;
}

/**
 * What the broken text of the argument `key` was meant as, or undefined when no reading parses. Read as it stands with
 * its brackets balanced (a closer missing or misplaced), with bare `add:`, `remove:`, `edit:` names, or the leaked tags that name them, quoted and braced,
 * then as the value of `key` inside the call's object, for a value closed early with the call's other arguments written
 * after it: those come back in `beside`, by name.
 */
export function repairJson(key: string, text: string): { own: unknown; beside: Record<string, unknown> } | undefined {
  const body = text.trim();
  const read = (candidate: string): unknown => {
    try {
      return JSON.parse(balanced(candidate));
    } catch {
      return undefined; // not this reading
    }
  };
  const own = read(BARE_OP.test(body) || TAG_OP.test(body) ? braced(body) : body);
  if (own !== undefined) return { own, beside: {} };
  const whole = read(`{${JSON.stringify(key)}:${body}`);
  if (typeof whole !== 'object' || whole === null || Array.isArray(whole)) return undefined;
  const { [key]: mine, ...beside } = whole as Record<string, unknown>;
  return { own: mine, beside };
}
