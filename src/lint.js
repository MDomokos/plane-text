// Plane Text: banned-character linter (spec 4.1).
//
// Trivial to write on day one, painful to retrofit. v1 barely needs it (the
// braille payload is safe by construction and the shim is ~200 bytes), but
// user-supplied ramps are an arbitrary-character surface, and the v2
// self-replicating wrapper would apply the same rule to ~5 KB of application.

import { BANNED_MARKDOWN, BANNED_HTML } from './constants.js';

function scan(text, banned, label) {
  const problems = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const ch of banned) {
      let at = lines[i].indexOf(ch);
      while (at !== -1) {
        problems.push({ line: i + 1, col: at + 1, char: ch, label });
        at = lines[i].indexOf(ch, at + 1);
      }
    }
  }
  return problems;
}

// The payload (the art itself) may contain neither WhatsApp markdown nor
// HTML-significant characters. The second group is banned because escaped
// entities inside a <pre> break the one-character-per-cell correspondence.
export function lintPayload(text) {
  const problems = scan(text, [...BANNED_MARKDOWN, ...BANNED_HTML], 'payload');

  // Spec 4.4 rule 2: no leading spaces on any line. If a client trims per-line
  // leading whitespace, rows with a bright left edge shift and the image
  // shears. Use U+2800 or U+00A0 as the transparent glyph, never U+0020.
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^[ \t]/.test(lines[i])) {
      problems.push({ line: i + 1, col: 1, char: 'leading whitespace', label: 'payload' });
    }
  }
  return problems;
}

// Wrapper source may contain < > & because it is markup. It may not contain
// WhatsApp markdown, which rules out multiplication, snake_case identifiers,
// template literals and /* */ comments.
export function lintWrapper(text) {
  return scan(text, BANNED_MARKDOWN, 'wrapper');
}

// The whole message, checked with the right rule per region.
export function lintMessage(message, payloadText) {
  const problems = [...lintWrapper(message)];
  if (payloadText) problems.push(...lintPayload(payloadText));
  return problems;
}

export function assertClean(problems) {
  if (problems.length) {
    const detail = problems
      .slice(0, 10)
      .map((p) => `  ${p.label} ${p.line}:${p.col} contains ${JSON.stringify(p.char)}`)
      .join('\n');
    const more = problems.length > 10 ? `\n  ...and ${problems.length - 10} more` : '';
    throw new Error(`banned characters found:\n${detail}${more}`);
  }
}
