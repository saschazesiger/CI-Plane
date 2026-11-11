/*! Z-Dash 3.0.1 | MIT License | https://github.com/saschazesiger/Z-Dash */
/**
 * Syntax highlighter (D13): small tokenizers of the system's own for json,
 * js/ts, sh, html/xml, css, sql, yaml, go, py and diff, and a hook for an
 * external highlighter.
 *
 *   DS.highlight.tokenize('const a = 1;', 'js');   [{ kind: 'keyword', text: 'const' }, { kind: null, text: ' a ' }, ...]
 *   DS.highlight.highlight(code, 'json');           escaped markup: <span class="ds-highlight__property">"id"</span>...
 *   DS.highlight.lines(code, 'py');                 the same markup, one string per line (every span closed on its line)
 *   DS.highlight.language('yml');                   'yaml' (an alias), null for a language it does not know
 *   DS.highlight.languages();                       ['css', 'diff', 'go', ...]
 *   DS.highlight.register('ini', [['comment', /;[^\n]*'/], ...], ['conf']);
 *   DS.highlight.use((code, language) => hljs.highlight(code, { language }).value);   the page's own highlighter
 *   <code data-ds-highlight="json">{ "id": 42 }</code>                               highlighted by DS.init()
 *   const view = DS.highlight.create(el, { language: 'sql' }); view.set(nextCode);
 *
 * A tokenizer is a list of rules [kind, RegExp]; one combined expression
 * finds the next token, the text between tokens is plain, and a kind may be
 * a function of the match (an identifier becomes a keyword, a function, a
 * type or a property by what stands around it; a tag splits into its
 * parts; a regular expression literal is told from a division). One pass,
 * no backtracking across tokens, linear in the code (long single lines
 * too): 2,000 lines take tens of milliseconds.
 *
 * Kinds, each a class .ds-highlight__<kind> coloured by a --ds-code-* role
 * (highlight.css): keyword, string, number, comment, function, type,
 * property, tag, attribute, variable, constant, regex, operator,
 * punctuation, meta, inserted, deleted.
 *
 * Safety: the markup escapes every character of the code (&, <, >, ");
 * only the external highlighter's markup is taken as it comes, since the
 * page chose it. lines() splits that markup at its line breaks, closing and
 * reopening the spans open there.
 *
 * The attribute path: data-ds-highlight="<language>" (empty: the element's
 * class language-<x>, else plain) highlights the element's text in place
 * through DS.dom.morphHtml; its controller get()s and set()s the code, and
 * destroy() puts the plain text back.
 *
 * ES2022. Progressive: none (lookbehind in the rules is at the floor).
 */
import { define, emit, runtime } from './core.js';
import { morphHtml } from './dom.js';

/** The page-wide state: languages registered by name, aliases, and the page's own highlighter. */
const shared = runtime.state('highlight', () => ({ languages: new Map(), aliases: new Map(), external: null }));

/** The token kinds: one class and one colour role each. */
export const KINDS = Object.freeze(['keyword', 'string', 'number', 'comment', 'function', 'type', 'property', 'tag', 'attribute', 'variable', 'constant', 'regex', 'operator', 'punctuation', 'meta', 'inserted', 'deleted']);

const words = (text) => new Set(text.split(/\s+/).filter(Boolean));

/* ── The engine ─────────────────────────────────────── */

/**
 * Compiles a rule list into one expression: each rule a capture group, so
 * the group that matched names the rule.
 */
function compile(rules) {
  let groups = 1;
  const entries = rules.map(([kind, pattern]) => {
    const entry = { kind, group: groups };
    groups += 1 + new RegExp(`${pattern.source}|`).exec('').length - 1;
    return entry;
  });
  const flags = new Set(['g', 'm']);
  for (const [, pattern] of rules) if (pattern.flags.includes('i')) flags.add('i');
  return { entries, regex: new RegExp(rules.map(([, pattern]) => `(${pattern.source})`).join('|'), [...flags].join('')) };
}

/** The language a name or alias stands for, or null. */
function find(name) {
  const key = String(name ?? '').trim().toLowerCase().replace(/^language-/, '');
  const id = shared.aliases.get(key) ?? key;
  return shared.languages.get(id) ?? null;
}

/**
 * Runs a language over `code`: a list of [kind, text] covering every
 * character, adjacent tokens of one kind merged.
 */
function run(lang, code) {
  const out = [];
  const state = { prev: null, lang, code, data: {} };
  const push = (kind, text) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last[0] === kind) last[1] += text;
    else out.push([kind, text]);
    if (kind === 'comment') return;
    const trimmed = text.trim();
    if (!trimmed) return;
    // One record, rewritten in place: a token's object per token would be most of the garbage on 2,000 lines.
    if (state.prev) {
      state.prev.kind = kind;
      state.prev.text = trimmed;
    } else state.prev = { kind, text: trimmed };
  };
  if (typeof lang.tokenize === 'function') {
    for (const token of lang.tokenize(code, state)) push(token[0] ?? null, token[1]);
    return out;
  }
  const { regex, entries } = lang.compiled;
  let pos = 0;
  while (pos < code.length) {
    regex.lastIndex = pos;
    const match = regex.exec(code);
    if (!match) {
      push(null, code.slice(pos));
      break;
    }
    if (match.index > pos) push(null, code.slice(pos, match.index));
    if (!match[0]) {
      push(null, code[match.index]);
      pos = match.index + 1;
      continue;
    }
    const entry = entries.find((candidate) => match[candidate.group] !== undefined);
    const end = match.index + match[0].length;
    let result = entry.kind;
    if (typeof result === 'function') result = result(match[0], state, match.index, end);
    if (Array.isArray(result)) {
      // Sub-tokens: they may cover less than the match (a rejected literal) or more (embedded code).
      let length = 0;
      for (const [kind, text] of result) {
        push(kind ?? null, text);
        length += text.length;
      }
      pos = match.index + Math.max(1, length);
    } else {
      push(result ?? null, match[0]);
      pos = end;
    }
  }
  return out;
}

/** A sticky test at `index` (a lookahead that never moves the main expression). */
function at(pattern, code, index) {
  pattern.lastIndex = index;
  return pattern.test(code);
}

const NEXT_CALL = /[ \t]*(?:<[\w$<>, \t[\]]*>)?\(/y;
const NEXT_COLON = /[ \t]*:(?!:)/y;
const NEXT_WORD = /[ \t]+[A-Za-z_$]/y;

/**
 * Whether only blanks, or a `$ ` prompt, stand between the line's start and
 * `index` (sh: a word there is a command). The state of the line goes along
 * with the run, character by character, since a run asks in order: a long
 * line costs its length once, not once per word.
 */
function lineStart(state, index) {
  const data = state.data;
  if (data.lineAt === undefined || index < data.lineAt) {
    data.lineAt = state.code.lastIndexOf('\n', index - 1) + 1;
    data.line = 'start';
  }
  const code = state.code;
  // start: blanks only; dollar: a $ after them; prompt: blanks after the $; other: anything else.
  for (let at = data.lineAt; at < index; at += 1) {
    const char = code[at];
    const blank = char === ' ' || char === '\t';
    if (char === '\n') data.line = 'start';
    else if (data.line === 'start') data.line = blank ? 'start' : char === '$' ? 'dollar' : 'other';
    else if (data.line === 'dollar' || data.line === 'prompt') data.line = blank ? 'prompt' : 'other';
  }
  data.lineAt = index;
  return data.line === 'start' || data.line === 'prompt';
}

/* ── Languages ──────────────────────────────────────── */

const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$(?![\s\S]))/;
const LINE_COMMENT = /\/\/[^\n]*/;
const DOUBLE = /"(?:[^"\\\n]|\\[\s\S])*"?/;
const SINGLE = /'(?:[^'\\\n]|\\[\s\S])*'?/;
const C_NUMBER = /(?<![\w$.])(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)[nmuflUL]*(?![\w$])/;
const IDENT = /[A-Za-z_$][\w$]*/;

const JS_KEYWORDS = words(`break case catch class const continue debugger default delete do else export extends finally for
  function if import in instanceof let new return static switch throw try typeof var void while with yield async await
  of from as get set`);
const TS_KEYWORDS = words(`abstract declare enum implements interface keyof namespace private protected public readonly
  infer is satisfies module override asserts unique accessor`);
const JS_CONSTANTS = words('true false null undefined NaN Infinity this super');
const TS_TYPES = words('string number boolean any unknown never object symbol bigint');
/** Where a slash starts a regular expression literal rather than a division. */
const REGEX_AFTER = /^(?:[(,=:[!&|?{};+\-*%<>~^]|=>|&&|\|\||\?\?|return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function jsLike(typescript) {
  const keywords = typescript ? new Set([...JS_KEYWORDS, ...TS_KEYWORDS]) : JS_KEYWORDS;
  const identifier = (word, state, index, end) => {
    const prev = state.prev?.text;
    const code = state.code;
    if (prev === '.' || prev === '?.') return at(NEXT_CALL, code, end) ? 'function' : 'property';
    if (word === 'type' && typescript) return at(NEXT_WORD, code, end) ? 'keyword' : null;
    if (keywords.has(word)) return ['get', 'set', 'of', 'from', 'as', 'async'].includes(word) && at(NEXT_COLON, code, end) ? 'property' : 'keyword';
    if (JS_CONSTANTS.has(word)) return 'constant';
    if (at(NEXT_CALL, code, end)) return prev === 'new' ? 'type' : 'function';
    if (prev === 'function') return 'function';
    if (prev === 'class' || prev === 'extends' || prev === 'implements' || prev === 'interface' || prev === 'enum' || prev === 'new') return 'type';
    if (typescript && TS_TYPES.has(word)) return 'type';
    if (/^[A-Z][A-Z\d_]+$/.test(word)) return 'constant';
    if (/^[A-Z]/.test(word)) return 'type';
    if ((prev === '{' || prev === ',') && at(NEXT_COLON, code, end)) return 'property';
    return null;
  };
  const regexLiteral = (text, state) => {
    const prev = state.prev;
    if (!prev || REGEX_AFTER.test(prev.text) || (prev.kind === 'keyword' && prev.text !== 'this')) return 'regex';
    return [['operator', '/']];
  };
  return [
    ['comment', BLOCK_COMMENT],
    ['comment', LINE_COMMENT],
    ['string', /`(?:[^`\\]|\\[\s\S])*`?/],
    ['string', DOUBLE],
    ['string', SINGLE],
    [regexLiteral, /\/(?![*/])(?:[^/\\[\n]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\/[dgimsuyv]*/],
    ['meta', /@[A-Za-z_$][\w$.]*/],
    ['number', C_NUMBER],
    [identifier, IDENT],
    ['operator', /=>|\?\.|\?\?=?|\.\.\.|[-+*%&|^!<>=~?]+=?|\//],
    ['punctuation', /[{}[\]();,.:]/],
  ];
}

const JSON_RULES = [
  ['comment', BLOCK_COMMENT],
  ['comment', LINE_COMMENT],
  ['property', /"(?:[^"\\\n]|\\.)*"(?=\s*:)/],
  ['string', DOUBLE],
  ['number', /-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![\w.])/],
  ['constant', /\b(?:true|false|null)\b/],
  ['punctuation', /[{}[\],:]/],
];

const SH_KEYWORDS = words(`if then else elif fi for while until do done case esac in function return select time export
  local readonly declare typeset unset shift break continue exit source alias unalias set trap eval exec`);
/** What may stand before a command: the start of a line, a pipe, a list or a subshell. */
const SH_COMMAND_AFTER = /^(?:\||\|\||&&|;|&|\$\(|\(|`|then|do|else|elif|if|while|until|!|sudo|exec|time|xargs)$/;

const SH_RULES = [
  ['comment', /(?<=^|[\s;|&(])#[^\n]*/],
  ['meta', /^[ \t]*\$(?=[ \t])/],
  ['string', /\$?'[^']*'?/],
  ['string', DOUBLE],
  ['variable', /\$(?:\{[^}\n]*\}?|[A-Za-z_]\w*|[0-9@#?$!*-])/],
  ['operator', /\$\(\(?|\)\)?|&&|\|\||[|&;]|[<>]{1,2}&?\d?|=/],
  ['variable', /[A-Za-z_]\w*(?==)/],
  ['attribute', /(?<=[\s=])--?[A-Za-z][\w-]*/],
  ['number', /(?<![\w./:-])\d+(?:\.\d+)?(?![\w./:-])/],
  [(word, state, index) => {
    const command = lineStart(state, index) || SH_COMMAND_AFTER.test(state.prev?.text ?? '');
    if (SH_KEYWORDS.has(word) && command) return 'keyword';
    if (command) return 'function';
    return null;
  }, /[A-Za-z_.\/~][\w./~+-]*/],
  ['punctuation', /[(){}[\]]/],
];

const HTML_TAG = /<\/?[A-Za-z][\w:.-]*(?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>?/;
const TAG_PART = /(<\/?)([\w:.-]+)|(\s+)|([^\s"'>/=]+)(?:(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+))?|(\/?>)/gy;

function markupTag(embed) {
  return (text, state, index, end) => {
    const tokens = [];
    TAG_PART.lastIndex = 0;
    let name = '';
    for (let part = TAG_PART.exec(text); part && part[0]; part = TAG_PART.exec(text)) {
      if (part[1]) {
        tokens.push(['punctuation', part[1]], ['tag', part[2]]);
        name = part[1] === '<' ? part[2].toLowerCase() : '';
      } else if (part[3]) tokens.push([null, part[3]]);
      else if (part[4]) {
        tokens.push(['attribute', part[4]]);
        if (part[5]) tokens.push(['punctuation', part[5]], ['string', part[6]]);
      } else tokens.push(['punctuation', part[7]]);
    }
    const consumed = tokens.reduce((sum, token) => sum + token[1].length, 0);
    if (consumed < text.length) tokens.push([null, text.slice(consumed)]);
    // A script or a style element: its content in its own language, up to the closing tag.
    const inner = embed && !text.endsWith('/>') ? { script: 'js', style: 'css' }[name] : null;
    if (inner) {
      const close = state.code.toLowerCase().indexOf(`</${name}`, end);
      const body = state.code.slice(end, close < 0 ? state.code.length : close);
      if (body) tokens.push(...run(find(inner), body));
    }
    return tokens;
  };
}

function markupRules(embed) {
  return [
    ['comment', /<!--[\s\S]*?(?:-->|$(?![\s\S]))/],
    ['string', /<!\[CDATA\[[\s\S]*?(?:\]\]>|$(?![\s\S]))/],
    ['meta', /<![A-Za-z][^>]*>?|<\?[\s\S]*?(?:\?>|$(?![\s\S]))/],
    [markupTag(embed), HTML_TAG],
    ['constant', /&(?:#\d+|#[xX][\da-fA-F]+|[A-Za-z][\w]*);/],
  ];
}

/** The at-rules whose block holds rules rather than declarations. */
const RULE_BLOCKS = /^(?:media|supports|layer|container|document|scope|starting-style)$/;

/** CSS: a small state machine for selectors, declarations and values. */
function cssTokens(code) {
  const tokens = [];
  const stack = [];
  let value = false;
  const RULE = /(\/\*[\s\S]*?(?:\*\/|$(?![\s\S])))|("(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)|(@[\w-]+)|(!important\b)|(#[\w-]+)|(--[\w-]+)|((?:\d+\.?\d*|\.\d+)(?:%|[A-Za-z]+)?)|(::?[\w-]+)|([A-Za-z_-][\w-]*)|([{}();,:>+~*=[\]]|\.(?=[A-Za-z_-]))|(\s+)/gy;
  /** Inside a declaration block, before its value: a name followed by a colon is a property, unless a `{` comes first (a nested selector). */
  const declaring = () => stack.length && stack[stack.length - 1] === 'block' && !value;
  const isProperty = (end) => {
    const rest = /^[ \t]*:([^;{}]*)([;{}]|$)/.exec(code.slice(end, end + 400));
    return Boolean(rest) && rest[2] !== '{';
  };
  let pos = 0;
  let classNext = false;
  let atRule = '';
  while (pos < code.length) {
    RULE.lastIndex = pos;
    const m = RULE.exec(code);
    if (!m) {
      tokens.push([null, code[pos]]);
      pos += 1;
      continue;
    }
    const text = m[0];
    const end = pos + text.length;
    if (m[1]) tokens.push(['comment', text]);
    else if (m[2]) tokens.push(['string', text]);
    else if (m[3]) {
      tokens.push(['keyword', text]);
      stack.push('at');
      atRule = text.slice(1).toLowerCase();
    } else if (m[4]) tokens.push(['keyword', text]);
    else if (m[5]) tokens.push([value ? 'number' : 'type', text]);
    else if (m[6]) tokens.push([declaring() && isProperty(end) ? 'property' : 'variable', text]);
    else if (m[7]) tokens.push(['number', text]);
    else if (m[8]) {
      // In a declaration a colon ends the property name: only it is punctuation, the value follows.
      if (declaring() || value) {
        tokens.push(['punctuation', ':']);
        if (declaring()) value = true;
        classNext = false;
        pos += 1;
        continue;
      }
      tokens.push(['keyword', text]);
    }
    else if (m[9]) {
      let kind;
      if (classNext) kind = 'type';
      else if (code[end] === '(') kind = 'function';
      else if (value) kind = 'constant';
      else if (declaring() && isProperty(end)) kind = 'property';
      else if (stack[stack.length - 1] === 'at') kind = code[end] === ':' ? 'property' : null;
      else kind = 'tag';
      tokens.push([kind, text]);
    } else if (m[10]) {
      if (text === '{') {
        // A block after an at-rule that takes rules (@media, @supports, @layer, @container) holds rules; others hold declarations.
        const nested = stack[stack.length - 1] === 'at' && RULE_BLOCKS.test(atRule);
        if (stack[stack.length - 1] === 'at') stack.pop();
        stack.push(nested ? 'rules' : 'block');
        atRule = '';
        value = false;
      } else if (text === '}') {
        stack.pop();
        value = false;
      } else if (text === ';') {
        if (stack[stack.length - 1] === 'at') stack.pop();
        atRule = '';
        value = false;
      } else if (text === ':' && declaring()) value = true;
      tokens.push(['punctuation', text]);
      classNext = text === '.' && !value;
      pos = end;
      continue;
    } else tokens.push([null, text]);
    classNext = false;
    pos = end;
  }
  return tokens;
}

const SQL_KEYWORDS = words(`select from where and or not in is like ilike between exists as on join inner left right full outer
  cross natural using group by order having limit offset fetch first next rows only union all intersect except distinct
  insert into values update set delete create table view index unique primary key foreign references constraint default
  check drop alter add column rename to if replace temporary temp with recursive returning case when then else end
  begin commit rollback transaction grant revoke cascade asc desc nulls over partition window lateral do nothing conflict
  truncate explain analyze materialized trigger function procedure returns language declare schema database sequence
  collate filter within`);
const SQL_TYPES = words(`int integer bigint smallint tinyint decimal numeric real float double precision char varchar
  nvarchar text date time timestamp timestamptz interval boolean bool uuid json jsonb blob bytea serial bigserial money
  inet cidr array`);
const SQL_CONSTANTS = words('true false null unknown current_date current_time current_timestamp');

const SQL_RULES = [
  ['comment', /--[^\n]*/],
  ['comment', BLOCK_COMMENT],
  ['string', /[eEnN]?'(?:[^']|'')*'?/],
  ['property', /"(?:[^"]|"")*"?|`[^`\n]*`?|\[[^\]\n]*\]/],
  ['variable', /[@:$][A-Za-z_]\w*|\$\d+|\?/],
  ['number', /(?<![\w.])(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![\w])/],
  [(word, state, index, end) => {
    const lower = word.toLowerCase();
    if (state.prev?.text === '.') return 'property';
    if (at(NEXT_CALL, state.code, end) && !SQL_KEYWORDS.has(lower)) return 'function';
    if (SQL_KEYWORDS.has(lower)) return 'keyword';
    if (SQL_TYPES.has(lower)) return 'type';
    if (SQL_CONSTANTS.has(lower)) return 'constant';
    return null;
  }, /[A-Za-z_][\w$]*/],
  ['operator', /<>|!=|<=|>=|\|\||::|[-+*/%<>=~!|&^]/],
  ['punctuation', /[(),;.[\]]/],
];

/** Where a plain scalar starts: after a key's colon, a list item's dash, a flow bracket or comma, or a line's indent. */
const YAML_SCALAR_START = '(?<=(?:^[ \\t]*(?:-[ \\t]+)*|(?:^|[ \\t])-[ \\t]+|:[ \\t]+|[[,{][ \\t]*))';
const YAML_SCALAR_END = '(?=[ \\t]*(?:#|$|,[ \\t]|\\]|\\}))';
/** The dashes of the list items that open a line, each punctuation, in one token: the rules after them look back over a run once. */
const yamlItems = (text) => text.split(/(-)/).filter(Boolean).map((part) => [part === '-' ? 'punctuation' : null, part]);

const YAML_RULES = [
  ['comment', /(?<=^|[ \t])#[^\n]*/],
  ['meta', /^(?:---|\.\.\.)(?=[ \t]|$)/],
  [yamlItems, /^[ \t]*-(?:[ \t]+-)*(?=[ \t]|$)/],
  ['property', /(?<=^[ \t]*(?:-[ \t]+)*)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'|[^\s#'"{}[\],:&*!|>%@`-](?:[^\n:#]|:(?=\S)|(?<=\S)#)*?|-[^\s#:][^\n:#]*?)(?=[ \t]*:(?:[ \t]|$))/],
  // A key in a flow collection ends at the next , [ ] { or }: the search for its colon stops there too.
  ['property', /(?<=[{,][ \t]*)(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\n]|'')*'|[^\s#'"{}[\],:&*!|>%@`-](?:[^\n:#,[\]{}]|:(?=[^\s,[\]{}])|(?<=\S)#)*?|-[^\s#:,[\]{}][^\n:#,[\]{}]*?)(?=[ \t]*:(?:[ \t]|$))/],
  ['string', /"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\n]|'')*'?/],
  ['meta', /[&*][\w-]+/],
  ['type', /!!?[\w-]*/],
  ['punctuation', /(?<=^[ \t]*(?:-[ \t]+)*)-(?=[ \t]|$)|(?<=:[ \t]+)[|>][+-]?\d*(?=[ \t]*(?:#|$))|[{}[\],]|:(?=[ \t]|$)/],
  ['constant', new RegExp(`${YAML_SCALAR_START}(?:true|false|null|yes|no|on|off|~)${YAML_SCALAR_END}`, 'i')],
  ['number', new RegExp(`${YAML_SCALAR_START}[-+]?(?:0x[\\da-fA-F]+|0o[0-7]+|\\d[\\d_]*(?:\\.\\d*)?(?:[eE][+-]?\\d+)?|\\.inf|\\.nan)${YAML_SCALAR_END}`, 'i')],
  // Blanks (and dashes between them) as one plain token, last: no rule starts inside a run, so the lookbehinds above
  // scan a long run once rather than at every position in it.
  [null, /[ \t]+(?:-[ \t]+)*/],
];

const GO_KEYWORDS = words(`break case chan const continue default defer else fallthrough for func go goto if import interface
  map package range return select struct switch type var`);
const GO_TYPES = words(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint
  uint8 uint16 uint32 uint64 uintptr any comparable`);
const GO_CONSTANTS = words('true false nil iota');

const GO_RULES = [
  ['comment', BLOCK_COMMENT],
  ['comment', LINE_COMMENT],
  ['string', /`[^`]*`?/],
  ['string', DOUBLE],
  ['string', /'(?:[^'\\\n]|\\.[^'\n]*)'?/],
  ['number', /(?<![\w.])(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO]?[0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)i?(?![\w])/],
  [(word, state, index, end) => {
    const prev = state.prev?.text;
    if (GO_KEYWORDS.has(word)) return 'keyword';
    if (GO_CONSTANTS.has(word)) return 'constant';
    if (GO_TYPES.has(word)) return 'type';
    if (at(NEXT_CALL, state.code, end)) return 'function';
    if (prev === 'func') return 'function';
    if (prev === 'type' || prev === 'struct') return 'type';
    if (prev === '.') return /^[A-Z]/.test(word) ? 'type' : 'property';
    return null;
  }, /[A-Za-z_]\w*/],
  ['operator', /:=|<-|&\^=?|\.\.\.|[-+*/%&|^!<>=]+/],
  ['punctuation', /[{}[\]();,.:]/],
];

const PY_KEYWORDS = words(`and as assert async await break class continue def del elif else except finally for from global
  if import in is lambda nonlocal not or pass raise return try while with yield match case`);
const PY_CONSTANTS = words('__name__ __file__ True False None NotImplemented Ellipsis');
const PY_BUILTINS = words(`int str float bool list dict set tuple bytes object type range len print open enumerate zip map
  filter sorted sum min max abs any all super isinstance issubclass getattr setattr hasattr iter next repr round`);

const PY_RULES = [
  ['comment', /#[^\n]*/],
  ['string', /(?<![\w])[rRbBuUfF]{0,2}(?:"""[\s\S]*?(?:"""|$(?![\s\S]))|'''[\s\S]*?(?:'''|$(?![\s\S]))|"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?)/],
  ['meta', /(?<=^[ \t]*)@[\w.]+/],
  ['number', /(?<![\w.])(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)(?![\w])/],
  [(word, state, index, end) => {
    const prev = state.prev?.text;
    if (prev === '.') return at(NEXT_CALL, state.code, end) ? 'function' : 'property';
    if (PY_KEYWORDS.has(word)) return 'keyword';
    if (PY_CONSTANTS.has(word)) return 'constant';
    if (word === 'self' || word === 'cls') return 'variable';
    if (prev === 'def') return 'function';
    if (prev === 'class') return 'type';
    if (at(NEXT_CALL, state.code, end)) return /^[A-Z]/.test(word) ? 'type' : 'function';
    if (PY_BUILTINS.has(word)) return 'type';
    if (/^[A-Z][A-Z\d_]+$/.test(word)) return 'constant';
    if (/^[A-Z]/.test(word)) return 'type';
    return null;
  }, /[A-Za-z_]\w*/],
  ['operator', /->|:=|\*\*=?|\/\/=?|[-+*/%@&|^~<>=!]=?/],
  ['punctuation', /[{}[\]();,.:]/],
];

const DIFF_RULES = [
  ['meta', /^(?:diff|index|similarity|dissimilarity|rename|copy|new file|deleted file|old mode|new mode|Binary files)\b[^\n]*/],
  ['meta', /^(?:\+\+\+|---)(?:[ \t][^\n]*)?$/],
  ['meta', /^@@[^\n]*/],
  ['inserted', /^[+>][^\n]*/],
  ['deleted', /^[-<][^\n]*/],
  ['comment', /^\\[^\n]*/],
];

/**
 * Adds a language: `rules` is a list of [kind, RegExp] (the kind a name of
 * KINDS, null for plain, or a function (text, state, index, end) that
 * returns one, or a list of [kind, text] sub-tokens), or a function
 * (code) => [kind, text][] of its own. `aliases` are further names.
 * A later registration of a name replaces the earlier one.
 * @param {string} name
 * @param {Array<[any, RegExp]>|((code: string) => Array<[string|null, string]>)} rules
 * @param {string[]} [aliases]
 */
export function register(name, rules, aliases = []) {
  const id = String(name).toLowerCase();
  const lang = typeof rules === 'function' ? { id, tokenize: rules } : { id, compiled: compile(rules) };
  shared.languages.set(id, lang);
  for (const alias of aliases) shared.aliases.set(String(alias).toLowerCase(), id);
}

function builtIn() {
  if (shared.languages.has('json')) return;
  register('json', JSON_RULES, ['jsonc', 'json5', 'webmanifest']);
  register('js', jsLike(false), ['javascript', 'mjs', 'cjs', 'jsx', 'node']);
  register('ts', jsLike(true), ['typescript', 'tsx', 'mts', 'cts']);
  register('sh', SH_RULES, ['bash', 'shell', 'zsh', 'console', 'shellsession', 'sh-session']);
  register('html', markupRules(true), ['htm', 'xhtml', 'vue', 'svelte']);
  register('xml', markupRules(false), ['svg', 'xsl', 'xslt', 'plist', 'rss', 'atom', 'xaml']);
  register('css', (code) => cssTokens(code), ['scss', 'less']);
  register('sql', SQL_RULES, ['psql', 'pgsql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'plsql', 'tsql']);
  register('yaml', YAML_RULES, ['yml']);
  register('go', GO_RULES, ['golang']);
  register('py', PY_RULES, ['python', 'python3', 'py3', 'pyi']);
  register('diff', DIFF_RULES, ['patch', 'udiff']);
}
builtIn();

/* ── Public API ─────────────────────────────────────── */

/**
 * The canonical name of a language or alias ('yml' → 'yaml', also
 * 'language-yml'), or null when no tokenizer knows it.
 * @param {string|null|undefined} name
 * @returns {string|null}
 */
export function language(name) {
  return find(name)?.id ?? null;
}

/**
 * The names of every registered language, sorted.
 * @returns {string[]}
 */
export function languages() {
  return [...shared.languages.keys()].sort();
}

/**
 * The tokens of `code` in `lang`: every character in order, a kind (one of
 * KINDS) or null for plain text. An unknown language is one plain token.
 * @param {string} code
 * @param {string} lang
 * @returns {Array<{ kind: string|null, text: string }>}
 */
export function tokenize(code, lang) {
  const text = String(code ?? '');
  const found = find(lang);
  if (!found || !text) return text ? [{ kind: null, text }] : [];
  return run(found, text).map(([kind, part]) => ({ kind, text: part }));
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const SPECIAL = /[&<>"]/;
const escape = (text) => (SPECIAL.test(text) ? text.replace(/[&<>"]/g, (char) => ESCAPES[char]) : text);

/** A token as markup: escaped text, in its span when it has a kind. */
const span = (kind, text) => (kind ? `<span class="ds-highlight__${kind}">${escape(text)}</span>` : escape(text));

/**
 * The page's own highlighter, or null to go back to the system's: a
 * function (code, language) that returns markup (taken as it comes) or
 * null/undefined for a language it leaves to the system.
 * @param {((code: string, language: string) => string|null|undefined)|null} highlighter
 */
export function use(highlighter) {
  shared.external = typeof highlighter === 'function' ? highlighter : null;
}

/** The external highlighter's markup, or null. */
function external(code, lang) {
  if (!shared.external || !lang) return null;
  const html = shared.external(code, String(lang));
  return typeof html === 'string' ? html : null;
}

/**
 * `code` as highlighted markup: every character escaped, tokens in
 * `<span class="ds-highlight__<kind>">`. The external highlighter (use())
 * goes first.
 * @param {string} code
 * @param {string} lang
 * @returns {string}
 */
export function highlight(code, lang) {
  const text = String(code ?? '');
  const outside = external(text, lang);
  if (outside !== null) return outside;
  return tokenize(text, lang).map((token) => span(token.kind, token.text)).join('');
}

/** Markup split at its line breaks: the spans open at a break close there and open again on the next line. */
function splitMarkup(html) {
  const result = [];
  const open = [];
  let line = '';
  for (const [part] of html.matchAll(/<\/?[A-Za-z][^>]*>|<!--[\s\S]*?-->|[^<]+|</g)) {
    if (part[0] === '<' && part.length > 1 && part[1] !== '!') {
      if (part[1] === '/') open.pop();
      else if (!part.endsWith('/>') && !/^<(?:br|img|wbr|hr|input)\b/i.test(part)) open.push(part);
      line += part;
      continue;
    }
    const pieces = part.split('\n');
    line += pieces[0];
    for (const piece of pieces.slice(1)) {
      result.push(line + open.map((tag) => `</${/^<([A-Za-z][\w-]*)/.exec(tag)[1]}>`).reverse().join(''));
      line = open.join('') + piece;
    }
  }
  result.push(line);
  return result;
}

/**
 * `code` as highlighted markup, one string per line (split at \n; a \r
 * before it is dropped): each line's spans close on that line, so a page
 * can wrap every line in an element of its own.
 * @param {string} code
 * @param {string} lang
 * @returns {string[]}
 */
export function lines(code, lang) {
  const text = String(code ?? '').replace(/\r\n?/g, '\n');
  const outside = external(text, lang);
  if (outside !== null) return splitMarkup(outside);
  const found = find(lang);
  if (!found || !text) return text.split('\n').map(escape);
  const result = [];
  let line = '';
  for (const [kind, part] of run(found, text)) {
    if (!part.includes('\n')) {
      line += span(kind, part);
      continue;
    }
    const pieces = part.split('\n');
    for (let index = 0; index < pieces.length; index += 1) {
      if (index) {
        result.push(line);
        line = '';
      }
      if (pieces[index]) line += span(kind, pieces[index]);
    }
  }
  result.push(line);
  return result;
}

/** The language an element names: its data-ds-highlight, else a class language-<x>, else the fallback. */
function languageOf(el, fallback) {
  const named = el.getAttribute?.('data-ds-highlight');
  if (named) return named;
  const cls = /(?:^|\s)lang(?:uage)?-([\w+#.-]+)/.exec(el.className && typeof el.className === 'string' ? el.className : '');
  return cls ? cls[1] : fallback ?? '';
}

function controller(el, options, signal) {
  let code = options.code ?? el.textContent ?? '';
  let lang = options.language ?? languageOf(el);
  const listeners = new Set();
  const write = () => {
    if (lang && (find(lang) || shared.external)) morphHtml(el, highlight(code, lang));
    else if (el.childElementCount || el.textContent !== code) el.textContent = code;
  };
  write();
  return {
    get() { return code; },
    set(next) {
      const text = String(next ?? '');
      if (text === code) return;
      code = text;
      write();
      if (signal?.aborted) return;
      const detail = { code, language: language(lang) ?? lang };
      emit(el, 'change', detail);
      listeners.forEach((fn) => fn(detail));
    },
    on(type, fn) {
      if (type !== 'change') return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update() {
      lang = languageOf(el, lang);
      write();
    },
    destroy() {
      listeners.clear();
      if (el.isConnected !== false && el.textContent === code) el.textContent = code;
    },
  };
}

define('highlight', {
  attribute: 'data-ds-highlight',
  init(el, ctx) {
    return controller(el, {}, ctx.signal);
  },
});

/**
 * Highlights an element's text in place; the same controller the attribute
 * path makes. `code` replaces the element's text, `language` its
 * data-ds-highlight or class language-<x>.
 * @param {Element} el
 * @param {{ code?: string, language?: string }} [options]
 */
export function create(el, options = {}) {
  return controller(el, options);
}
