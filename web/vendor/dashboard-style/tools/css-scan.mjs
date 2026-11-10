/**
 * A small CSS scanner for the tools (no dependency, not a full parser): it
 * reads the stylesheets that themes and projects write, keeping line
 * numbers. Comments are blanked (newlines kept), strings and parentheses
 * are respected when declarations are split, and every style rule knows the
 * at-rules around it.
 *
 *   scan(css) -> { rules, atRules, statements }
 *     rules       [{ selector, line, context: ['@media (...)', ...], declarations }]
 *     declarations [{ property, value, important, line }]
 *     atRules     [{ prelude, line }]  every block at-rule (@media, @layer, @font-face ...)
 *     statements  [{ text, line }]     at-rule statements without a block (@import, @layer a, b;)
 *
 * Copied to dist/tools/ by scripts/build.mjs; plain ES2022.
 */

/** The source with comments replaced by spaces (newlines kept, so offsets and lines stay). */
export function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** 1-based line of an offset. */
export function lineAt(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) if (text[i] === '\n') line += 1;
  return line;
}

/** Splits `text` at `separator` outside quotes and parentheses. */
export function splitOutside(text, separator) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push({ text: text.slice(start, i), offset: start });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), offset: start });
  return parts;
}

/** The declarations of a rule body that starts at `offset` of `source`. */
function declarationsOf(body, offset, source) {
  const result = [];
  for (const part of splitOutside(body, ';')) {
    const colon = part.text.indexOf(':');
    if (colon < 0) continue;
    const property = part.text.slice(0, colon).trim();
    if (!/^(--[\w-]+|-?[a-zA-Z][\w-]*)$/.test(property)) continue;
    let value = part.text.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(value);
    if (important) value = value.replace(/!\s*important\s*$/i, '').trim();
    const lead = part.text.length - part.text.trimStart().length;
    result.push({ property, value: value.replace(/\s+/g, ' '), important, line: lineAt(source, offset + part.offset + lead) });
  }
  return result;
}

/** Scans a stylesheet (see the file comment). */
export function scan(css) {
  const source = blankComments(String(css).replace(/\r\n/g, '\n'));
  const rules = [];
  const atRules = [];
  const statements = [];
  const stack = [];
  let start = 0;
  let quote = null;
  let depth = 0;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '(') { depth += 1; continue; }
    if (char === ')') { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    if (char === ';') {
      const text = source.slice(start, i).trim();
      if (text.startsWith('@')) statements.push({ text: text.replace(/\s+/g, ' '), line: lineAt(source, start + source.slice(start).search(/\S/)) });
      start = i + 1;
    } else if (char === '{') {
      const prelude = source.slice(start, i).trim().replace(/\s+/g, ' ');
      const at = start + Math.max(0, source.slice(start, i).search(/\S/));
      if (prelude.startsWith('@')) {
        atRules.push({ prelude, line: lineAt(source, at) });
        // Descriptor blocks (@font-face, @property, @page) hold declarations, not rules: skip their body.
        if (/^@(font-face|property|page|counter-style|font-feature-values|view-transition)\b/.test(prelude)) {
          const end = matching(source, i);
          i = end;
          start = end + 1;
          continue;
        }
        stack.push(prelude);
        start = i + 1;
      } else {
        const end = matching(source, i);
        const body = source.slice(i + 1, end);
        rules.push({ selector: prelude, line: lineAt(source, at), context: [...stack], declarations: declarationsOf(body, i + 1, source) });
        i = end;
        start = end + 1;
      }
    } else if (char === '}') {
      stack.pop();
      start = i + 1;
    }
  }
  return { rules, atRules, statements };
}

/** The offset of the `}` that closes the block opened at `open` (quotes skipped). */
function matching(source, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return source.length;
}

/** The selectors of a selector list (commas outside parentheses). */
export function selectorList(selector) {
  return splitOutside(selector, ',').map((part) => part.text.trim()).filter(Boolean);
}
