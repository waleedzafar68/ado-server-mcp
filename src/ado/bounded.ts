export const DEFAULT_MAX_CHARS = 8000;
export const HARD_MAX_CHARS = 100_000;

export interface TextWindowOptions {
  startLine?: number;
  endLine?: number;
  tailLines?: number;
  maxChars?: number;
}

export interface TextWindow {
  text: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  totalChars: number;
  truncated: boolean;
}

function splitLines(full: string): string[] {
  if (full.length === 0) return [];
  let normalized = full;
  if (normalized.endsWith('\r\n')) normalized = normalized.slice(0, -2);
  else if (normalized.endsWith('\n')) normalized = normalized.slice(0, -1);
  return normalized.split(/\r?\n/);
}

function windowForward(
  lines: string[],
  start: number,
  end: number,
  maxChars: number,
  totalLines: number,
  totalChars: number,
): TextWindow {
  const picked: string[] = [];
  let used = 0;
  let lastLine = start - 1;
  let cut = false;
  for (let lineNumber = start; lineNumber <= end; lineNumber++) {
    const line = lines[lineNumber - 1] ?? '';
    const cost = line.length + (picked.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      if (picked.length === 0) {
        picked.push(line.slice(0, maxChars));
        lastLine = lineNumber;
      }
      cut = true;
      break;
    }
    picked.push(line);
    used += cost;
    lastLine = lineNumber;
  }

  return {
    text: picked.join('\n'),
    startLine: start,
    endLine: lastLine,
    totalLines,
    totalChars,
    truncated: cut || lastLine < end,
  };
}

function windowBackward(
  lines: string[],
  minStart: number,
  end: number,
  maxChars: number,
  totalLines: number,
  totalChars: number,
): TextWindow {
  if (totalLines === 0) {
    return { text: '', startLine: 1, endLine: 0, totalLines: 0, totalChars, truncated: false };
  }

  const picked: string[] = [];
  let used = 0;
  let startLine = end + 1;

  for (let lineNumber = end; lineNumber >= minStart; lineNumber--) {
    const line = lines[lineNumber - 1] ?? '';
    const cost = line.length + (picked.length > 0 ? 1 : 0);
    if (used + cost > maxChars) {
      if (picked.length === 0) {
        picked.unshift(line.slice(-maxChars));
        startLine = lineNumber;
        return {
          text: picked.join('\n'),
          startLine,
          endLine: end,
          totalLines,
          totalChars,
          truncated: true,
        };
      }
      break;
    }
    picked.unshift(line);
    used += cost;
    startLine = lineNumber;
  }

  return {
    text: picked.join('\n'),
    startLine,
    endLine: end,
    totalLines,
    totalChars,
    truncated: startLine > minStart,
  };
}

export function windowText(full: string, options: TextWindowOptions = {}): TextWindow {
  const lines = splitLines(full);
  const totalLines = lines.length;
  const maxChars = Math.min(Math.max(options.maxChars ?? DEFAULT_MAX_CHARS, 1), HARD_MAX_CHARS);
  const totalChars = full.length;

  if (options.tailLines !== undefined) {
    const end = totalLines;
    const minStart = Math.max(1, totalLines - (options.tailLines ?? 0) + 1);
    return windowBackward(lines, minStart, end, maxChars, totalLines, totalChars);
  }

  const start = Math.max(1, options.startLine ?? 1);
  const end = Math.min(totalLines, options.endLine ?? totalLines);
  return windowForward(lines, start, end, maxChars, totalLines, totalChars);
}

export function isProbablyBinary(text: string): boolean {
  const sample = text.slice(0, 8000);
  if (sample.includes('\u0000')) return true;
  if (sample.length === 0) return false;
  let replacements = 0;
  for (const character of sample) if (character === '\uFFFD') replacements++;
  return replacements * 10 >= sample.length;
}

const NAMED_ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntity(match: string, entity: string): string {
  const lower = entity.toLowerCase();
  if (!lower.startsWith('#')) return NAMED_ENTITIES[lower] ?? match;

  const radix = lower.startsWith('#x') ? 16 : 10;
  const digits = lower.startsWith('#x') ? lower.slice(2) : lower.slice(1);
  const codePoint = Number.parseInt(digits, radix);
  if (
    !Number.isFinite(codePoint) ||
    codePoint === 0 ||
    codePoint > 0x10_ff_ff ||
    (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff)
  ) {
    return match;
  }
  return String.fromCodePoint(codePoint);
}

export function htmlToText(html: string): string {
  // Advance past each candidate once. An unterminated tag keeps the remainder as
  // text rather than restarting an unbounded search at every subsequent '<'.
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) { parts.push(html.slice(cursor)); break; }
    parts.push(html.slice(cursor, start));
    const end = html.indexOf('>', start + 1);
    if (end < 0) { parts.push(html.slice(start)); break; }
    const tag = html.slice(start + 1, end);
    if (/^\s*br\s*\/?$/i.test(tag) || /^\/(p|div|li|tr|h[1-6])\s*$/i.test(tag)) parts.push('\n');
    else if (/^li/i.test(tag)) parts.push('- ');
    else if (!tag) parts.push('<>');
    cursor = end + 1;
  }
  return parts.join('')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, decodeEntity)
    // Consume every space run, including those without a newline, without backtracking.
    .replace(/[ \t]+/g, (spaces, offset: number, text: string) => text[offset + spaces.length] === '\n' ? '' : spaces)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [truncated ${text.length - max} chars]`;
}

export function limitList<T>(items: readonly T[], top: number): { items: T[]; count: number; truncated: boolean } {
  const limited = items.slice(0, top);
  return { items: limited, count: limited.length, truncated: items.length > top };
}
