const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;
// Some clients render the prompt as Markdown: no links, images, HTML or code spans. * and _ stay (branch names use them).
// GFM also auto-links bare scheme:// and www. text, so those get a look-alike colon (U+2236) or dot (U+2024).
const MARKDOWN: Record<string, string> = { '[': '(', ']': ')', '<': '‹', '>': '›', '`': "'" };
const AUTOLINK_SCHEME = /\b([a-z][a-z0-9+.-]*):\/\//gi;
const AUTOLINK_WWW = /\bwww\./gi;

// Names shown to the user or the model come from Azure DevOps users or git remotes; keep each one on one short, quoted line.
export function quoted(value: unknown, max = 80): string {
  const text = String(value ?? '')
    .replace(UNSAFE_TEXT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replaceAll('"', "'")
    .replace(/[[\]<>`]/g, (c) => MARKDOWN[c]!)
    .replace(AUTOLINK_SCHEME, '$1∶//')
    .replace(AUTOLINK_WWW, (m) => `${m.slice(0, -1)}․`);
  return `"${text.length > max ? `${text.slice(0, max - 1)}…` : text}"`;
}