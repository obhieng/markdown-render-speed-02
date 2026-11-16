// parse.js — a from-scratch CommonMark 0.31.2 + GFM 0.29 renderer that returns
// exactly the HTML marked 18.1.3 renders with its default options (gfm on,
// breaks off, pedantic off, async off). Written for the make.fun
// markdown-render-speed-02 competition. No dependencies, no I/O, no caching
// across calls: parse() computes its output from its argument alone.

// ============================== small helpers ==============================

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESC_ENCODE = /[&<>"']/g;
const RE_ESC_NOENCODE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_HAS_ESC = /[&<>"']/;
const RE_HAS_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const RE_NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUMREF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

// Escape HTML text. encode=true escapes & always; false leaves valid entities alone.
function esc(s, encode) {
  if (encode) {
    if (!RE_HAS_ESC.test(s)) return s;
    return s.replace(RE_ESC_ENCODE, (c) => ESC_MAP[c]);
  }
  if (!RE_HAS_NOENC.test(s)) return s;
  return s.replace(RE_ESC_NOENCODE, (c) => (c === '&' ? '&amp;' : ESC_MAP[c]));
}

// Decode numeric character references (&#169; &#xA9;); a bare & becomes &amp;.
// Named entities are NOT decoded here: they pass through esc() untouched.
function decodeNumeric(s) {
  if (!RE_NUMREF.test(s)) return s;
  return s.replace(RE_NUMREF_OR_AMP, (m, d, h) => {
    if (d === undefined && h === undefined) return '&amp;';
    const code = d === undefined ? parseInt(h, 16) : parseInt(d, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}

// encodeURI with %25 unescaped again; null when encodeURI throws.
function encodeHref(s) {
  try { return encodeURI(s).replace(/%25/g, '%'); } catch { return null; }
}

// Link label normalization: trim, collapse inner whitespace, case-fold.
function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Parenthesis/bracket balance: -1 balanced, -2 too many opens, else index of the
// closing char that went negative. Backslash escapes are skipped.
function parenBalance(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1]) { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Strip trailing copies of ch (marked's L with no third arg).
function stripTrail(s, ch) {
  let n = s.length;
  while (n > 0 && s[n - 1] === ch) n--;
  return s.slice(0, n);
}

// Expand tabs to spaces on 4-column stops, counting code points like marked.
function expandTabs(s, col) {
  let out = '', c = col;
  for (const ch of s) {
    if (ch === '\t') { const r = 4 - (c % 4); out += '    '.slice(0, r); c += r; }
    else { out += ch; c++; }
  }
  return out;
}

// Remove trailing blank lines, keeping at most the shape marked keeps:
// if the source ends with more than two lines past the last non-blank one,
// cut it there; otherwise leave it alone.
function stripTrailingBlanks(a) {
  const lines = a.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? a : lines.slice(0, t + 1).join('\n');
}

// Split a GFM table row on unescaped pipes, honouring a column count.
function splitTableRow(s, count) {
  const t = s.replace(/\|/g, (m, off, str) => {
    let escaped = false, p = off;
    while (--p >= 0 && str[p] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = t.split(' |');
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// ============================== character classes ==============================

// ASCII punctuation (the set a backslash can escape).
function isAsciiPunct(ch) {
  return (
    (ch >= '!' && ch <= '/') || (ch >= ':' && ch <= '@') ||
    (ch >= '[' && ch <= '`') || (ch >= '{' && ch <= '~')
  );
}

const RE_UNICODE_PUNCT = /[\p{P}\p{S}]/u; // any unicode punctuation/symbol
const RE_UNICODE_PUNCT_NOTILDE = /(?!~)[\p{P}\p{S}]/u; // same, except ~
const RE_UNICODE_ALNUM = /[\p{L}\p{N}]/u;
// marked's "punctuation" (punctSpace): whitespace, punctuation or symbol,
// but not * or _ as the first char. Used for emphasis/del flanking checks.
const RE_PUNCT_SPACE = /^((?![*_])[\s\p{P}\p{S}])/u;

// Email local-part characters (GFM extended autolink).
function isEmailLocal(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
    ch === '.' || ch === '!' || ch === '#' || ch === '$' || ch === '%' || ch === '&' ||
    ch === "'" || ch === '*' || ch === '+' || ch === '/' || ch === '=' || ch === '?' ||
    ch === '_' || ch === '`' || ch === '{' || ch === '|' || ch === '}' || ch === '~' ||
    ch === '-'
  );
}
function isAlnumAscii(ch) {
  const c = ch.charCodeAt(0);
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

// Sticky (lastIndex-anchored) helpers for the text-run scanner: an email
// local part followed by '@', and a hard-break run of spaces + newline.
const RE_EMAIL_AT = /[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@/y;
const RE_HARD_BREAK = / {2,}\n/y;
// Next text-run stop, searched with one native regex exec: a special char,
// a protocol, www., mailto:/xmpp:, an email start, or a hard-break run.
// Groups: 1 special, 2 protocol, 3 www., 4 mailto/xmpp, 5 email, 6 hard break.
const RE_TEXT_STOP = /([\\<!\[`*~_])|([hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/)|(www\.)|(mailto:|xmpp:)|([a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)|( {2,}\n)/g;

// Does src starting at j begin with an email local part followed by '@'?
// (Sticky regex, no allocation.)
function emailStartsAt(src, j) {
  RE_EMAIL_AT.lastIndex = j;
  return RE_EMAIL_AT.test(src);
}
// Does src starting at j begin with mailto: or xmpp: ?
function emailProtoAt(src, j) {
  return src.startsWith('mailto:', j) || src.startsWith('xmpp:', j);
}
// Does src starting at j begin with http:// https:// ftp:// (any case)?
// Direct char-code comparison, no allocation.
function urlProtoAt(src, j) {
  const a = src.charCodeAt(j) | 32, b = src.charCodeAt(j + 1) | 32,
    c = src.charCodeAt(j + 2) | 32, d = src.charCodeAt(j + 3) | 32;
  if (a === 104 && b === 116 && c === 116 && d === 112) { // http
    if (src.charCodeAt(j + 4) === 58 && src.charCodeAt(j + 5) === 47 && src.charCodeAt(j + 6) === 47) return true; // ://
    if ((src.charCodeAt(j + 4) | 32) === 115 && src.charCodeAt(j + 5) === 58 && src.charCodeAt(j + 6) === 47 && src.charCodeAt(j + 7) === 47) return true; // s://
    return false;
  }
  if (a === 102 && b === 116 && c === 112 && src.charCodeAt(j + 3) === 58 && src.charCodeAt(j + 4) === 47 && src.charCodeAt(j + 5) === 47) return true; // ftp://
  return false;
}
// Does src starting at j begin with www. preceded (in the text run) by start,
// whitespace, *, _, ~ or ( ?
function wwwStartsAt(src, j, prev) {
  if (src[j] !== 'w' || src[j + 1] !== 'w' || src[j + 2] !== 'w' || src[j + 3] !== '.') return false;
  return prev === '' || prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(';
}

// ============================== inline regexes (gfm) ==============================

// A link label's content: nested [...] groups, backslash escapes, code spans,
// or any character except [ ] \ and backtick. (CommonMark link label grammar.)
const RE_LABEL = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
// The same, in the looser form used when scanning for reference links.
const RE_LABEL_LOOSE = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
// A reference label: not "]" (after spaces), then escaped chars / non-bracket chars.
const RE_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const RE_REF_SEARCH = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;

// Inline link: ![label](href "title") — href may be <...> or bare, title optional.
const RE_LINK = new RegExp(
  '^!?\\[(' + RE_LABEL.source + ')\\]\\([ \\t\\n]*' +
  '(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))' +
  '(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)' +
  '("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\\\n]|\\n(?!\\n))*\'|\\((?:\\\\[\\s\\S]|[^\\)\\\\])*\\)))?[ \\t\\n]*\\)'
);
// Reference link: [label][ref]
const RE_REFLINK = new RegExp('^!?\\[(' + RE_LABEL.source + ')\\]\\[(' + RE_REF.source + ')\\]');
// Shortcut reference link: [ref] or [ref][]
const RE_NOLINK = new RegExp('^!?\\[(' + RE_REF.source + ')\\](?:\\[\\])?');
// Global scan for reference links (used by the emphasis mask).
const RE_REFLINK_SEARCH = new RegExp(
  '!?\\[(' + RE_LABEL_LOOSE.source + ')\\]\\[(' + RE_REF_SEARCH.source + ')\\]|' +
  '!?\\[(' + RE_REF_SEARCH.source + ')\\](?:\\[\\])?(?!\\()', 'g'
);

// Backslash + ASCII punctuation.
const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
// Code span: `...` with matching backtick runs, newlines become spaces.
const RE_CODESPAN = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
// Hard break: two or more spaces (or a backslash) before a newline.
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
// Autolink: <scheme:...> or <email>.
const RE_AUTOLINK = new RegExp(
  '^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|' +
  "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>"
);
// Raw HTML tag (inline).
const RE_TAG = new RegExp(
  '^<!--(?:-?>|[\\s\\S]*?-->)|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*"[^"]*"|\\s*=\\s*\'[^\']*\'|\\s*=\\s*[^\\s"\'=<>`]+)?)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>'
);
// GFM extended autolink: www., scheme://, or bare email. Also mailto:/xmpp:.
const RE_URL = new RegExp(
  '^(?:(?:mailto:[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[a-zA-Z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)' +
  '|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*' +
  '|[a-zA-Z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-]))'
);
// Trims trailing punctuation / unbalanced parens off an extended autolink.
const RE_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// Emphasis left-delimiter: a run of * or _ plus the following character.
const RE_EM_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
// Strikethrough left-delimiter: ~~ or ~ plus the following character.
const RE_DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;

// Right-delimiter scanners for * (ast), _ (und) and ~ (del). Each match is either
// a skip chunk (no captured group) or a delimiter run in one of the groups,
// whose position tells whether the run can open, close, or both.
function rdelimAst() {
  const punct = '(?!~)[\\p{P}\\p{S}]';
  const punctSpace = '(?!~)[\\s\\p{P}\\p{S}]';
  const notPunctSpace = '(?:[^\\s\\p{P}\\p{S}]|~)';
  return new RegExp(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])' +
    '|(?!\\*)' + punct + '(\\*+)(?=[\\s]|$)' +
    '|' + notPunctSpace + '(\\*+)(?!\\*)(?=' + punctSpace + '|$)' +
    '|(?!\\*)' + punctSpace + '(\\*+)(?=' + notPunctSpace + ')' +
    '|[\\s](\\*+)(?!\\*)(?=' + punct + ')' +
    '|(?!\\*)' + punct + '(\\*+)(?!\\*)(?=' + punct + ')' +
    '|' + notPunctSpace + '(\\*+)(?=' + notPunctSpace + ')', 'gu'
  );
}
function rdelimUnd() {
  const punct = '[\\p{P}\\p{S}]';
  const punctSpace = '[\\s\\p{P}\\p{S}]';
  const notPunctSpace = '[^\\s\\p{P}\\p{S}]';
  return new RegExp(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])' +
    '|(?!_)' + punct + '(_+)(?=[\\s]|$)' +
    '|' + notPunctSpace + '(_+)(?!_)(?=' + punctSpace + '|$)' +
    '|(?!_)' + punctSpace + '(_+)(?=' + notPunctSpace + ')' +
    '|[\\s](_+)(?!_)(?=' + punct + ')' +
    '|(?!_)' + punct + '(_+)(?!_)(?=' + punct + ')', 'gu'
  );
}
function rdelimDel() {
  const punct = '[\\p{P}\\p{S}]';
  const punctSpace = '[\\s\\p{P}\\p{S}]';
  const notPunctSpace = '[^\\s\\p{P}\\p{S}]';
  return new RegExp(
    '^[^~]+(?=[^~])' +
    '|(?!~)' + punct + '(~~?)(?=[\\s]|$)' +
    '|' + notPunctSpace + '(~~?)(?!~)(?=' + punctSpace + '|$)' +
    '|(?!~)' + punctSpace + '(~~?)(?=' + notPunctSpace + ')' +
    '|[\\s](~~?)(?!~)(?=' + punct + ')' +
    '|(?!~)' + punct + '(~~?)(?!~)(?=' + punct + ')' +
    '|' + notPunctSpace + '(~~?)(?=' + notPunctSpace + ')', 'gu'
  );
}
const RE_RDELIM_AST = rdelimAst();
const RE_RDELIM_UND = rdelimUnd();
const RE_RDELIM_DEL = rdelimDel();

// Inline link / code span / raw HTML, used to mask emphasis scanning.
const RE_BLOCK_SKIP = new RegExp(
  '\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\()]|\\((?:\\\\[\\s\\S]|[^\\\\()])*\\))*\\)' +
  '|(?<!`)(?<b>`+)[^`]+\\k<b>(?!`)' +
  '|<(?! )[^<>]*?>', 'g'
);
// Code spans and backslash-escaped punctuation, for the emphasis mask.
const RE_PUNCT_OUTSIDE_CODE = new RegExp(
  '(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])', 'gu'
);
// HTML comment, for the inline tag / block html checks.
const RE_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const RE_START_A = /^<a /i;
const RE_END_A = /^<\/a>/i;
const RE_START_PRE = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_END_PRE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// ============================== inline: emphasis mask ==============================

// Does this text contain a link (inline or reference) that marked would resolve?
function linkInText(src, links) {
  if (!src.includes('[')) return false;
  RE_BLOCK_SKIP.lastIndex = 0;
  let m;
  while ((m = RE_BLOCK_SKIP.exec(src)) !== null) {
    if (RE_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
  }
  RE_REFLINK_SEARCH.lastIndex = 0;
  while ((m = RE_REFLINK_SEARCH.exec(src)) !== null) {
    const s = m[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !Object.hasOwn(links, normLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && linkInText(s.slice(1, r - 1), links))) return true;
  }
  return false;
}

// The mask marked builds before emphasis scanning: reference links, code spans,
// inline links and raw HTML are replaced by same-length filler so the emphasis
// scanner never sees a delimiter that lives inside one of them.
function maskForEmphasis(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const maskRef = (r) => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) {
          return '[' + inner.replace(RE_REFLINK_SEARCH, maskRef) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(RE_REFLINK_SEARCH, maskRef);
  }
  t = t.replace(RE_PUNCT_OUTSIDE_CODE, (n, s, r) =>
    r ? '+'.repeat(n.length)
      : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s
      : n);
  t = t.replace(RE_BLOCK_SKIP, (n) => '[' + 'a'.repeat(n.length - 2) + ']');
  return t;
}

// Last index at which a run of each delimiter could close emphasis, in the
// masked source: the start of the last run whose preceding char is not
// whitespace. Mirrors marked's fe().
function closerInfo(masked) {
  const res = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let i = s + 1;
    while (i < n && masked[i] === r) i++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') res[r] = s;
    s = i - 1;
  }
  return res;
}

// The full code point ending at index i (for astral characters).
function codePointBefore(s, i) {
  if (i <= 0) return '';
  const slice = s.slice(Math.max(0, i - 2), i);
  const pts = [...slice];
  return pts.length ? pts[pts.length - 1] : '';
}

// Try to parse *...* / _..._ / **...** / __...__ starting at src[i].
// Returns {html, len} or null. `st` is the shared inline state.
function tryEmStrong(src, i, masked, closer, links, st, prevChar, plain) {
  const rest = src.slice(i);
  const s = RE_EM_LDELIM.exec(rest);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const delim = s[0][0];
  const openIsUnd = delim === '_';
  let n = prevChar;
  const sameAsPrev = n === delim;
  let l = i;
  while (l > 0 && masked[l - 1] === delim) l--;
  const p = codePointBefore(masked, l);
  const beforeIsPunct = p === '*' || p === '_' || RE_PUNCT_SPACE.test(p);
  if (l < i) n = p;
  const u = l < i ? beforeIsPunct : (n !== '' && RE_PUNCT_SPACE.test(n));
  if (s[4] && n !== '' && RE_UNICODE_ALNUM.test(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1; // opener run length
    let m = k;
    let f = 0;
    const y = i - l + k;
    const R = p.trim() !== '' && (d !== '' || (delim === '*' && !beforeIsPunct));
    const v = closer[delim];
    const Q = i + k;
    if (v < Q) return null;
    const scan = masked.slice(Q);
    const ee = v - Q;
    const rdelim = delim === '*' ? RE_RDELIM_AST : RE_RDELIM_UND;
    rdelim.lastIndex = 0;
    let match;
    while ((match = rdelim.exec(scan)) !== null && !(match.index > ee)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6] || '';
      if (!g) continue;
      const b = [...g].length;
      if (match[3] || match[4]) { m += b; continue; }
      if (match[5] || match[6] || R) {
        if (sameAsPrev && (match[5] || match[6])) break;
        if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      const use = Math.min(b, b + m + f);
      const te = [...match[0]][0].length;
      const rawLen = k + match.index + te + use;
      const raw = src.slice(i, i + rawLen);
      if (Math.min(k, use) % 2 === 1) {
        const inner = raw.slice(1, -1);
        return { html: plain ? inlinePlain(inner, links, st) : '<em>' + inlineHtml(inner, links, st) + '</em>', len: rawLen };
      }
      const inner2 = raw.slice(2, -2);
      return { html: plain ? inlinePlain(inner2, links, st) : '<strong>' + inlineHtml(inner2, links, st) + '</strong>', len: rawLen };
    }
  }
  return null;
}

// Try to parse ~~...~~ (or ~...~) starting at src[i]. Returns {html, len} or null.
function tryDel(src, i, masked, closer, links, st, prevChar, plain) {
  const rest = src.slice(i);
  const s = RE_DEL_LDELIM.exec(rest);
  if (!s) return null;
  if (!(s[1] || '') || !prevChar || RE_PUNCT_SPACE.test(prevChar)) {
    const o = [...s[0]].length - 1; // number of tildes in the opener
    let p = o;
    const u = closer['~'];
    const d = i + o;
    if (u < d) return null;
    const scan = masked.slice(d);
    const k = u - d;
    RE_RDELIM_DEL.lastIndex = 0;
    let m;
    while ((m = RE_RDELIM_DEL.exec(scan)) !== null && !(m.index > k)) {
      const g = m[1] || m[2] || m[3] || m[4] || m[5] || m[6] || '';
      if (!g) continue;
      const l = [...g].length;
      if (l !== o) continue;
      if (m[3] || m[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      const use = Math.min(l, l + p);
      const te = [...m[0]][0].length;
      const rawLen = o + m.index + te + use;
      const raw = src.slice(i, i + rawLen);
      const inner = raw.slice(o, -o);
      return { html: plain ? inlinePlain(inner, links, st) : '<del>' + inlineHtml(inner, links, st) + '</del>', len: rawLen };
    }
  }
  return null;
}

// Does the link text contain a raw tag/autolink that reaches past the text?
// If so the link is not parsed (marked's Be).
function linkTextHasTag(full, text, offset) {
  if (!text.includes('<')) return false;
  for (let s = 0; s < text.length; s++) {
    if (text[s] === '\\') { s++; continue; }
    if (text[s] === '`') {
      const m = RE_CODESPAN.exec(text.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (text[s] !== '<') continue;
    const r = full.slice(offset + s);
    const o = RE_TAG.exec(r) || RE_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > text.length - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// Build a link/image from a matched link (inline or reference). `plain` says the
// current parse renders to plain text (image alt text). Returns the HTML/plain
// string, or null when the link must not be created (a link inside link text).
function makeLink(isImage, text, href, title, links, st, plain) {
  const savedInLink = st.inLink, savedEmitted = st.linkEmitted, savedRaw = st.inRawBlock;
  st.inLink = true; st.linkEmitted = false;
  const inner = isImage || plain ? inlinePlain(text, links, st) : inlineHtml(text, links, st);
  const nestedLink = st.linkEmitted;
  st.linkEmitted = savedEmitted; st.inLink = savedInLink;
  if (!isImage) {
    if (nestedLink) { st.inRawBlock = savedRaw; return null; }
    st.linkEmitted = true;
    if (plain) return inner;
  } else if (plain) {
    return inner;
  }
  const enc = encodeHref(href);
  if (isImage) {
    if (enc === null) return esc(inner, false);
    let out = '<img src="' + esc(enc, false) + '" alt="' + esc(inner, false) + '"';
    if (title) out += ' title="' + esc(title, false) + '"';
    return out + '>';
  }
  if (enc === null) return inner;
  let out = '<a href="' + esc(enc, false) + '"';
  if (title) out += ' title="' + esc(title, false) + '"';
  return out + '>' + inner + '</a>';
}

// ============================== inline: text runs ==============================

// End index of the text run starting at src[i], mirroring marked's text rule:
// consume until a character that can start another inline token, a protocol
// or www. autolink start, an email start, or a hard-break run of spaces.
function textEnd(src, i) {
  const n = src.length;
  let j = i;
  const c0 = src[j];
  // A non-alphanumeric character followed by mailto:/xmpp: is a token alone
  // (marked's text rule's first alternative).
  if (!isAlnumAscii(c0) && emailProtoAt(src, i + 1)) return i + 1;
  if (c0 === '`' || c0 === '~') {
    while (j < n && src[j] === c0) j++;
    if (j < n && (src[j] === '`' || src[j] === '~')) return j;
  } else {
    j = i + 1;
  }
  // Immediate stops right after the first character.
  if (j >= n) return j;
  if (src[j] === '`' || src[j] === '~') return j;
  if (src[j] === ' ') { RE_HARD_BREAK.lastIndex = j; if (RE_HARD_BREAK.test(src)) return j; }
  if (emailStartsAt(src, j)) return j;
  // Scan for the next stop with one native regex exec per stop candidate.
  // www. and mailto:/xmpp: need a valid preceding char; an invalid one is
  // skipped and the search resumes after it.
  RE_TEXT_STOP.lastIndex = j;
  let m;
  while ((m = RE_TEXT_STOP.exec(src)) !== null) {
    const idx = m.index;
    if (m[3] !== undefined) { // www.
      if (wwwStartsAt(src, idx, src[idx - 1] ?? '')) return idx;
      RE_TEXT_STOP.lastIndex = idx + 4;
      continue;
    }
    if (m[4] !== undefined) { // mailto:/xmpp: — preceding char must be non-alnum
      if (!isAlnumAscii(src[idx - 1])) return idx;
      RE_TEXT_STOP.lastIndex = idx + m[4].length;
      continue;
    }
    return idx;
  }
  return n;
}

// ============================== inline: main loop ==============================

// Any character/pattern that can start an inline token. If an inline source
// contains none of these, it is a single plain text run. (Protocol matching
// is case-insensitive, like RE_URL; www./mailto:/xmpp: are lowercase-only.)
const RE_INLINE_TRIGGER = /[\\<!\[`*~_]|[hH][tT][tT][pP][sS]?:\/\/|[fF][tT][pP]:\/\/|www\.|mailto:|xmpp:|[a-zA-Z0-9._+-]+@| {2,}\n/;

function inlineParse(src, links, st, plain) {
  // Fast path: plain prose with no inline markup at all.
  if (!RE_INLINE_TRIGGER.test(src)) return renderText(src, st.inRawBlock, plain);
  const linkParenPossible = src.includes(')');
  let masked = null, closer = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    // The mask only hides delimiters inside code spans, links, and HTML;
    // with no ` [ < \ present it is the identity, so skip the three replaces.
    masked = (src.includes('`') || src.includes('[') || src.includes('<') || src.includes('\\'))
      ? maskForEmphasis(src, links) : src;
    closer = closerInfo(masked);
  }
  let out = '';
  let i = 0;
  const n = src.length;
  let prevChar = '';
  let prevWasText = false;
  while (i < n) {
    if (!prevWasText) prevChar = '';
    prevWasText = false;
    const ch = src[i];
    let rest = null; // sliced remainder, computed lazily (text runs never need it)
    let done = false;

    // Backslash escape.
    if (ch === '\\') {
      const m = RE_ESCAPE.exec((rest ?? (rest = src.slice(i))));
      if (m) { out += plain ? m[1] : esc(m[1], false); i += 2; done = true; }
    }
    // Raw HTML tag / comment / processing instruction.
    if (!done && ch === '<') {
      const m = RE_TAG.exec((rest ?? (rest = src.slice(i))));
      if (m) {
        const tag = m[0];
        if (!st.inLink && RE_START_A.test(tag)) st.inLink = true;
        else if (st.inLink && RE_END_A.test(tag)) st.inLink = false;
        if (!st.inRawBlock && RE_START_PRE.test(tag)) st.inRawBlock = true;
        else if (st.inRawBlock && RE_END_PRE.test(tag)) st.inRawBlock = false;
        out += tag;
        i += tag.length; done = true;
      }
    }
    // Inline link / image: [text](href "title").
    if (!done && (ch === '[' || ch === '!') && linkParenPossible) {
      const m = RE_LINK.exec((rest ?? (rest = src.slice(i))));
      if (m) {
        const isImage = m[0][0] === '!';
        const off = isImage ? 2 : 1;
        let ok = !linkTextHasTag((rest ?? (rest = src.slice(i))), m[1], off);
        let href = '', title = '';
        if (ok) {
          const s = m[2].trim();
          if (s[0] === '<') {
            if (s[s.length - 1] !== '>') ok = false;
            else {
              const inner = stripTrail(s.slice(0, -1), '\\');
              if ((s.length - inner.length) % 2 === 0) ok = false;
            }
          } else {
            const bal = parenBalance(m[2], '()');
            if (bal === -2) ok = false;
            else if (bal > -1) {
              const cut = (isImage ? 5 : 4) + m[1].length + bal;
              m[2] = m[2].substring(0, bal);
              m[0] = m[0].substring(0, cut).trim();
              m[3] = '';
            }
          }
        }
        if (ok) {
          const r = stripTrail(m[0].slice(0, -1), '\\');
          if ((m[0].length - r.length) % 2 === 0) ok = false;
        }
        if (ok) {
          href = m[2].trim();
          title = m[3] ? m[3].slice(1, -1) : '';
          if (href[0] === '<') href = href.slice(1, -1);
          href = href.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
          title = title.replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1');
          const text = m[1].replace(/\\([\[\]])/g, '$1');
          const made = makeLink(isImage, text, href, title, links, st, plain);
          if (made !== null) { out += made; i += m[0].length; done = true; }
        }
      }
    }
    // Reference / shortcut link: [text][ref], [text][], [ref].
    if (!done && (ch === '[' || ch === '!')) {
      const m = RE_REFLINK.exec((rest ?? (rest = src.slice(i)))) || RE_NOLINK.exec((rest ?? (rest = src.slice(i))));
      if (m) {
        const isImage = m[0][0] === '!';
        const off = isImage ? 2 : 1;
        if (!linkTextHasTag((rest ?? (rest = src.slice(i))), m[1], off)) {
          const def = links[normLabel(m[2] || m[1])];
          if (!def) {
            // No such reference: the [ or ! is literal text.
            out += renderText(ch, st.inRawBlock, plain);
            if (ch !== '_') prevChar = ch;
            prevWasText = true;
            i += 1; done = true;
          } else {
            const text = m[1].replace(/\\([\[\]])/g, '$1');
            const made = makeLink(isImage, text, def.href, def.title, links, st, plain);
            if (made !== null) { out += made; i += m[0].length; done = true; }
          }
        }
      }
    }
    // Emphasis / strong emphasis.
    if (!done && (ch === '*' || ch === '_') && masked !== null) {
      const r = tryEmStrong(src, i, masked, closer, links, st, prevChar, plain);
      if (r) { out += r.html; i += r.len; done = true; }
    }
    // Code span.
    if (!done && ch === '`') {
      const m = RE_CODESPAN.exec((rest ?? (rest = src.slice(i))));
      if (m) {
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && text[0] === ' ' && text[text.length - 1] === ' ') {
          text = text.substring(1, text.length - 1);
        }
        out += plain ? text : '<code>' + esc(text, true) + '</code>';
        i += m[0].length; done = true;
      }
    }
    // Hard break: two spaces or a backslash before a newline.
    if (!done && (ch === ' ' || ch === '\\')) {
      const m = RE_BR.exec((rest ?? (rest = src.slice(i))));
      if (m) { if (!plain) out += '<br>'; i += m[0].length; done = true; }
    }
    // Strikethrough.
    if (!done && ch === '~' && masked !== null) {
      const r = tryDel(src, i, masked, closer, links, st, prevChar, plain);
      if (r) { out += r.html; i += r.len; done = true; }
    }
    // Autolink: <scheme:...> or <email>.
    if (!done && ch === '<') {
      const m = RE_AUTOLINK.exec((rest ?? (rest = src.slice(i))));
      if (m) {
        const text = m[1];
        const href = m[2] === '@' ? 'mailto:' + text : text;
        if (plain) out += text;
        else {
          const enc = encodeHref(href);
          out += enc === null ? esc(text, true) : '<a href="' + esc(enc, true) + '">' + esc(text, true) + '</a>';
        }
        i += m[0].length; done = true;
      }
    }
    // GFM extended autolink: www., scheme://, bare email. Cheap pre-checks
    // (no slice, no regex) so the full pattern only runs on plausible starts.
    if (!done && !st.inLink && (isAlnumAscii(ch) || ch === '.' || ch === '_' || ch === '+' || ch === '-')) {
      const maybeUrl = emailProtoAt(src, i) || urlProtoAt(src, i) ||
        src.startsWith('www.', i) || emailStartsAt(src, i);
      const m = maybeUrl ? RE_URL.exec((rest ?? (rest = src.slice(i)))) : null;
      if (m) {
        let text, href;
        if (m[2] === '@') { text = m[0]; href = 'mailto:' + m[0]; }
        else {
          let t0 = m[0], prev;
          do {
            prev = t0;
            const bp = RE_BACKPEDAL.exec(t0);
            t0 = bp ? bp[0] : '';
          } while (prev !== t0);
          text = t0;
          href = m[1] === 'www.' ? 'http://' + t0 : t0;
        }
        if (plain) out += text;
        else {
          const enc = encodeHref(href);
          out += enc === null ? esc(text, true) : '<a href="' + esc(enc, true) + '">' + esc(text, true) + '</a>';
        }
        if (text.length > 0) { i += text.length; done = true; }
      }
    }
    // Plain text run.
    if (!done) {
      const end = textEnd(src, i);
      const raw = src.slice(i, end);
      out += renderText(raw, st.inRawBlock, plain);
      if (raw.charCodeAt(raw.length - 1) !== 95) prevChar = raw.slice(-1);
      prevWasText = true;
      i = end;
    }
  }
  return out;
}

function renderText(raw, inRawBlock, plain) {
  if (inRawBlock) return raw;
  const d = decodeNumeric(raw);
  return plain ? d : esc(d, false);
}

function inlineHtml(src, links, st) {
  return inlineParse(src, links, st, false);
}
function inlinePlain(src, links, st) {
  return inlineParse(src, links, st, true);
}

// ============================== block regexes (gfm) ==============================

// Compose a regex from a template by substituting sub-patterns, dropping a
// leading ^ from each substituted pattern (as marked's builder does).
function compose(pattern, flags) {
  let src = typeof pattern === 'string' ? pattern : pattern.source;
  const api = {
    replace(search, repl) {
      let r = typeof repl === 'string' ? repl : repl.source;
      r = r.replace(/(^|[^\[])\^/g, '$1');
      src = src.replace(search, () => r);
      return api;
    },
    getRegex() { return new RegExp(src, flags || ''); },
  };
  return api;
}

const TAG_LIST = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// The building blocks substituted into the paragraph / heading / table rules.
const P_BULL = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const P_HR_SRC = '^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const P_HEADING_LOOK = ' {0,3}#{1,6}(?:\\s|$)';
const P_FENCES_LOOK = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const P_HTML_LOOK = ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
const P_TABLE_DELIM = ' {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n';
const P_LIST_PARA = ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]';
// The list test used inside a blockquote's paragraph (marked's Ke): a bare
// bullet at end-of-line also starts a list, so it blocks the continuation.
const P_LIST_BQ = ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)';

const RE_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const RE_INDENTED_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const RE_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const RE_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const RE_HR = new RegExp(P_HR_SRC);
const RE_CODE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const RE_FENCE_INDENT = /^(\s+)(?:```)/;
const RE_LEADING_SPACE = /^[ \t]+/;

const P_HR_NC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';

// Setext heading (gfm, with tables): the text may not start a list, code,
// fence, blockquote, heading, html or table line, and its continuation lines
// may not be blank, list, fence, blockquote, heading, hr, html or table.
const RE_LHEADING = compose(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .replace(/bull/g, P_BULL)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, P_HEADING_LOOK)
  .replace(/hr/g, P_HR_NC)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, P_TABLE_DELIM)
  .getRegex();

// GFM table: header line, delimiter line, body rows.
const RE_TABLE = compose('^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
  .replace('hr', P_HR_SRC)
  .replace('heading', P_HEADING_LOOK)
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', P_FENCES_LOOK)
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', P_HTML_LOOK)
  .replace('tag', TAG_LIST)
  .getRegex();

// Paragraph (gfm): a run of lines, stopping before a line that starts another
// block (heading, hr, blockquote, fence, list, html, table) or a blank line.
const RE_PARAGRAPH = compose(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
  .replace('hr', P_HR_SRC)
  .replace('heading', P_HEADING_LOOK)
  .replace('|lheading', '')
  .replace('table', RE_TABLE)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', P_FENCES_LOOK)
  .replace('list', P_LIST_PARA)
  .replace('html', P_HTML_LOOK)
  .replace('tag', TAG_LIST)
  .getRegex();

// The paragraph variant used inside a blockquote (marked's Ke): the list
// test also matches a bare bullet at end-of-line, and there is no table or
// setext alternative, so a lazy line starting a list (even a bare "-") ends
// the paragraph and the blockquote.
const RE_PARAGRAPH_BQ = compose(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
  .replace('hr', P_HR_SRC)
  .replace('heading', P_HEADING_LOOK)
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', P_FENCES_LOOK)
  .replace('list', P_LIST_BQ)
  .replace('html', P_HTML_LOOK)
  .replace('tag', TAG_LIST)
  .getRegex();

// Block quote: a run of lines each starting with > (a paragraph may span
// several lines, including lazy continuation lines without >).
const RE_BLOCKQUOTE = compose(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/ )
  .replace('paragraph', RE_PARAGRAPH_BQ)
  .getRegex();

// Link reference definition.
const RE_DEF = compose(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();

// Raw HTML block (types 1-7).
const RE_HTML_BLOCK = compose('^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))', 'i')
  .replace('comment', /<!--(?:-?>|[\s\S]*?(?:-->|$))/)
  .replace('tag', TAG_LIST)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();

// First line of a list item.
const RE_LIST_START = compose(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, P_BULL)
  .getRegex();

const RE_BLANK_LINE = /^[ \t]*$/;
const RE_DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const RE_ANY_LINE = /\n.*\n/;
const RE_NON_SPACE = /[^ ]/;
const RE_BQ_START = /^ {0,3}>/;
const RE_BQ_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const RE_BQ_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const RE_BQ_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const RE_LIST_TASK = /^\[[ xX]\][ \t]+\S/;
const RE_LIST_TASK_STRIP = /^\[[ xX]\][ \t]+/;
const RE_LIST_TASK_BOX = /\[[ xX]\]/;
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+) *$/;

// Indent-parameterized start tests, memoized per indent (0-3).
function memoIndent(fn) {
  const cache = [];
  return (n) => {
    const k = Math.max(0, Math.min(3, n - 1));
    return cache[k] || (cache[k] = fn(k));
  };
}
const listItemRegex = (marker) => new RegExp(`^( {0,3}${marker})((?:[ \\t][^\\n]*)?(?:\\n|$))`);
const nextBulletRegex = memoIndent((a) => new RegExp(`^ {0,${a}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegexAt = memoIndent((a) => new RegExp(`^ {0,${a}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = memoIndent((a) => new RegExp(`^ {0,${a}}(?:\`\`\`|~~~)`));
const headingBeginRegex = memoIndent((a) => new RegExp(`^ {0,${a}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = memoIndent((a) => new RegExp(`^ {0,${a}}(?:</?(?:${TAG_LIST})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = memoIndent((a) => new RegExp(`^ {0,${a}}>`));

// ============================== block parsing ==============================
// Node shapes (arrays): ['p', text, prefix?] ['t', text, prefix?]
// ['h', depth, text] ['code', lang|null, text] ['hr'] ['html', text]
// ['bq', children, raw, text] ['list', ordered, start, loose, items, raw]
// ['item', task, checked, children, text, raw] ['cb', checked]
// ['table', align, header, rows] ['def'] ['space', raw]

// A block-parsing context: the link definitions, the "top" flag (paragraphs
// are only tokenized at the top level, not inside list items), and the queue
// of inline-parse sites, in creation order. The queue mirrors marked's
// Lexer.inlineQueue: each entry is a {node, idx} pair pointing at the text
// field of a block node (or table cell) whose inline content is rendered
// from that field. The list task handler strips the marker from the LAST
// queue entry matching the task pattern, which may belong to a later item.
function newCtx() {
  return { links: Object.create(null), top: true, inlineQueue: [] };
}

// Record an inline-parse site: the text field node[idx] is this node's
// inline source. The queue entry keeps a live reference to the node, so
// merges that extend the text are visible through it.
function queueInline(ctx, node, idx) {
  ctx.inlineQueue.push({ node, idx });
}

// Fenced code: returns {node, rawLen} or null.
function tryFences(rest) {
  const m = RE_FENCES.exec(rest);
  if (!m) return null;
  let text = m[3] || '';
  const indentMatch = m[0].match(RE_FENCE_INDENT);
  if (indentMatch) {
    const w = indentMatch[1].length;
    text = text.split('\n').map((line) => {
      const lead = line.match(RE_LEADING_SPACE);
      if (!lead) return line;
      return line.slice(Math.min(lead[0].length, w));
    }).join('\n');
  }
  const lang = m[2] ? m[2].trim().replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : m[2];
  return { node: ['code', lang, text], rawLen: m[0].length };
}

// ATX heading.
function tryHeading(rest, ctx) {
  const m = RE_HEADING.exec(rest);
  if (!m) return null;
  let text = m[2].trim();
  if (/#$/.test(text)) {
    const stripped = stripTrail(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  const node = ['h', m[1].length, text];
  queueInline(ctx, node, 2);
  return { node, rawLen: stripTrail(m[0], '\n').length };
}

// Setext heading.
function tryLheading(rest, ctx) {
  const m = RE_LHEADING.exec(rest);
  if (!m) return null;
  const node = ['h', m[2].charAt(0) === '=' ? 1 : 2, m[1].trim()];
  queueInline(ctx, node, 2);
  return { node, rawLen: stripTrail(m[0], '\n').length };
}

// GFM table.
function tryTable(rest, ctx) {
  const m = RE_TABLE.exec(rest);
  if (!m || !/[:|]/.test(m[2])) return null;
  const headerCells = splitTableRow(m[1]);
  const delimCells = m[2].replace(/^\||\| *$/g, '').split('|');
  if (headerCells.length !== delimCells.length) return null;
  const align = [];
  for (const d of delimCells) {
    if (/^ *-+: *$/.test(d)) align.push('right');
    else if (/^ *:-+: *$/.test(d)) align.push('center');
    else if (/^ *:-+ *$/.test(d)) align.push('left');
    else align.push(null);
  }
  const header = headerCells.map((c, i) => { const cell = [c, align[i]]; queueInline(ctx, cell, 0); return cell; });
  const rows = [];
  if (m[3] && m[3].trim()) {
    for (const line of m[3].replace(/\n[ \t]*$/, '').split('\n')) {
      rows.push(splitTableRow(line, header.length).map((c, i) => { const cell = [c, align[i]]; queueInline(ctx, cell, 0); return cell; }));
    }
  }
  return { node: ['table', align, header, rows], rawLen: stripTrail(m[0], '\n').length };
}

// Block quote. Returns {node, rawLen} where rawLen is the consumed source length.
function tryBlockquote(rest, ctx) {
  const m = RE_BLOCKQUOTE.exec(rest);
  if (!m) return null;
  let lines = stripTrail(m[0], '\n').split('\n');
  let s = '', r = '';
  const children = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const group = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (RE_BQ_START.test(lines[p])) { group.push(lines[p]); hasMarker = true; }
      else if (!hasMarker) group.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = group.join('\n');
    const u = h
      .replace(RE_BQ_MARKER_WS, (g, b, m2) => b + expandTabs(m2, b.length))
      .replace(RE_BQ_SETEXT, '\n    $1')
      .replace(RE_BQ_SETEXT2, '');
    s = s ? s + '\n' + h : h;
    r = r ? r + '\n' + u : u;
    const savedTop = ctx.top;
    ctx.top = true;
    blockTokens(u, ctx, true, children);
    ctx.top = savedTop;
    if (lines.length === 0) break;
    const k = children[children.length - 1];
    if (k && (k[0] === 'code' || k[0] === 'h' || k[0] === 'hr' || k[0] === 'html' || k[0] === 'table')) break;
    if (k && k[0] === 'bq') {
      const g = k;
      const b = lines.join('\n');
      const m2 = g[2] + '\n' + b.replace(RE_BQ_SETEXT2, '');
      const f = tryBlockquote(m2, ctx);
      if (!f) break;
      children[children.length - 1] = f.node;
      const y = m2.substring(f.rawLen).replace(/^\n/, '');
      const R = y ? y.split('\n').length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + '\n' + A.join('\n');
      r = r.substring(0, r.length - g[3].length) + f.node[3];
      lines = lines.slice(A.length);
      if (lines.length > 0 && RE_BQ_START.test(lines[0])) continue;
      break;
    } else if (k && k[0] === 'list') {
      const g = k;
      const b = g[5] + '\n' + lines.join('\n');
      const m2 = tryList(b, ctx);
      if (!m2) break;
      children[children.length - 1] = m2.node;
      const f = m2.rawLen > g[5].length ? b.slice(g[5].length + 1, m2.rawLen).split('\n').length : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join('\n');
        s = s + '\n' + y;
        r = r + '\n' + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { node: ['bq', children, s, r], rawLen: s.length };
}

// List. Returns {node, rawLen} or null.
// List continuation "begin" tests, dispatched on the first non-space char:
// a line can only begin a fence/heading/html/blockquote/bullet/hr when its
// first marker char (within the allowed indent) is one of those markers.
// Plain prose lines skip all six regexes.
function listBeginHit(f, R, eeRe, teRe, mRe, neRe, vRe, qRe) {
  let p = 0;
  while (p < R && f.charCodeAt(p) === 32) p++;
  const fc = f[p];
  if (fc === '`' || fc === '~') return eeRe.test(f);
  if (fc === '#') return teRe.test(f);
  if (fc === '<') return mRe.test(f);
  if (fc === '>') return neRe ? neRe.test(f) : false;
  if (fc === '*' || fc === '+' || fc === '-' || (fc >= '0' && fc <= '9')) return vRe ? (vRe.test(f) || qRe.test(f)) : qRe.test(f);
  return false;
}

function tryList(rest, ctx) {
  const t = RE_LIST_START.exec(rest);
  if (!t) return null;
  const src = rest;
  let e = rest;
  const consumed = () => src.length - e.length;
  const marker = t[1].trim();
  const ordered = marker.length > 1;
  const start = ordered ? +marker.slice(0, -1) : '';
  let loose = false;
  const items = [];
  const markerPat = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRe = listItemRegex(markerPat);
  let p = false;
  while (e) {
    let u = false, d = '';
    const it = itemRe.exec(e);
    if (!it || RE_HR.test(e)) break;
    const k = consumed();
    e = e.substring(it[0].length);
    const g = it[2].split('\n', 1)[0];
    const b = it[1].length;
    let m = g.replace(RE_LEADING_SPACE, (v) => expandTabs(v, b));
    let f = e.split('\n', 1)[0];
    let y = !m.trim();
    let R = 0;
    if (y) R = b + 1;
    else {
      R = m.search(RE_NON_SPACE);
      if (R > 4) R = 1;
      d = m.slice(R);
      R += b;
    }
    if (y && RE_BLANK_LINE.test(f)) { e = e.substring(f.length + 1); u = true; }
    if (!u) {
      const vRe = nextBulletRegex(R), qRe = hrRegexAt(R), eeRe = fencesBeginRegex(R),
        teRe = headingBeginRegex(R), mRe = htmlBeginRegex(R), neRe = blockquoteBeginRegex(R);
      while (e) {
        const U = e.split('\n', 1)[0];
        f = U;
        const Z = f.replace(RE_LEADING_SPACE, (me) => expandTabs(me, 0));
        if (listBeginHit(f, R, eeRe, teRe, mRe, neRe, vRe, qRe)) break;
        if (Z.search(RE_NON_SPACE) >= R || !f.trim()) d += '\n' + Z.slice(R);
        else {
          if (y || m.replace(/\t/g, '    ').search(RE_NON_SPACE) >= 4 || listBeginHit(m, R, eeRe, teRe, mRe, null, null, qRe)) break;
          const qe = RE_SETEXT_LINE.test(f) && RE_LHEADING.test(m + '\n' + f) ? '    ' + Z.replace(/^ {0,3}/, '') : f;
          d += '\n' + qe;
        }
        y = !f.trim();
        e = e.substring(U.length + 1);
        m = Z.slice(R);
      }
    }
    const A = src.slice(k, consumed());
    if (!loose) {
      if (p) loose = true;
      else if (RE_DOUBLE_BLANK.test(A)) p = true;
    }
    items.push(['item', false, false, [], d, A]);
  }
  const last = items[items.length - 1];
  if (!last) return null;
  last[5] = last[5].trimEnd();
  last[4] = last[4].trimEnd();
  const listRaw = src.slice(0, consumed()).trimEnd();
  // Tokenize each item's content (paragraphs become plain text when tight).
  for (const item of items) {
    ctx.top = false;
    item[3] = blockTokens(item[4], ctx, false, []);
    if (!loose) {
      const spaces = item[3].filter((c) => c[0] === 'space');
      if (spaces.length > 0 && spaces.some((c) => RE_ANY_LINE.test(c[1]))) loose = true;
    }
  }
  ctx.top = true;
  // Task lists: strip the [ ]/[x] marker and insert a checkbox token.
  // The marker is stripped from the item text and, per marked, from the LAST
  // queued inline source matching the task pattern — which may belong to a
  // later item (its inline tokens are parsed from the queued source, so the
  // strip lands there even though the checkbox lands here). The first
  // token's own text is left alone: it IS the queued source.
  for (const item of items) {
    const d0 = item[3][0];
    item[1] = !!RE_LIST_TASK.test(item[4]);
    if (item[1] && d0 && (d0[0] === 't' || d0[0] === 'p')) {
      item[4] = item[4].replace(RE_LIST_TASK_STRIP, '');
      for (let g = ctx.inlineQueue.length - 1; g >= 0; g--) {
        const e = ctx.inlineQueue[g];
        if (RE_LIST_TASK.test(e.node[e.idx])) {
          e.node[e.idx] = e.node[e.idx].replace(RE_LIST_TASK_STRIP, '');
          break;
        }
      }
      const k = RE_LIST_TASK_BOX.exec(item[5]);
      if (k) {
        const box = ['cb', k[0] !== '[ ]'];
        item[2] = box[1];
        if (loose) {
          if (d0 && (d0[0] === 'p' || d0[0] === 't')) {
            d0[2] = (d0[2] || '') + checkboxHtml(box[1]);
          } else {
            item[3].unshift(['p', '', checkboxHtml(box[1])]);
          }
        } else {
          item[3].unshift(box);
        }
      }
    } else if (item[1]) {
      item[1] = false;
    }
  }
  if (loose) {
    for (const item of items) {
      for (const c of item[3]) if (c[0] === 't') c[0] = 'p';
    }
  }
  return { node: ['list', ordered, start, loose, items, listRaw], rawLen: listRaw.length };
}

function checkboxHtml(checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

// The main block loop. Appends nodes to `nodes` (default a fresh array) and
// returns it. `inBq` marks a blockquote's inner call, where a paragraph that
// follows a paragraph merges into it.
function blockTokens(src, ctx, inBq, nodes) {
  const out = nodes || [];
  let rest = src;
  let guard = Infinity;
  let n = !!inBq;
  while (rest) {
    if (rest.length >= guard) throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
    guard = rest.length;
    const prev = out.length ? out[out.length - 1] : null;
    let m;

    // Blank lines.
    if ((m = RE_NEWLINE.exec(rest))) {
      if (!(m[0].length === 1 && prev)) out.push(['space', m[0]]);
      rest = rest.slice(m[0].length);
      continue;
    }
    // Indented code.
    if ((m = RE_INDENTED_CODE.exec(rest))) {
      const raw = stripTrailingBlanks(m[0]);
      const text = raw.replace(RE_CODE_INDENT, '');
      if (prev && (prev[0] === 'p' || prev[0] === 't')) prev[1] += '\n' + text;
      else out.push(['code', null, text]);
      rest = rest.slice(raw.length);
      continue;
    }
    // Fenced code.
    {
      const f = tryFences(rest);
      if (f) { out.push(f.node); rest = rest.slice(f.rawLen); continue; }
    }
    // ATX heading.
    {
      const h = tryHeading(rest, ctx);
      if (h) { out.push(h.node); rest = rest.slice(h.rawLen); continue; }
    }
    // Thematic break.
    if ((m = RE_HR.exec(rest))) {
      out.push(['hr']);
      rest = rest.slice(stripTrail(m[0], '\n').length);
      continue;
    }
    // Block quote.
    {
      const b = tryBlockquote(rest, ctx);
      if (b) { out.push(b.node); rest = rest.slice(b.rawLen); continue; }
    }
    // List.
    {
      const l = tryList(rest, ctx);
      if (l) { out.push(l.node); rest = rest.slice(l.rawLen); continue; }
    }
    // Raw HTML block.
    if ((m = RE_HTML_BLOCK.exec(rest))) {
      const raw = stripTrailingBlanks(m[0]);
      out.push(['html', raw]);
      rest = rest.slice(raw.length);
      continue;
    }
    // Link reference definition.
    if ((m = RE_DEF.exec(rest))) {
      if (!(m[2][0] !== '<' && parenBalance(m[2], '()') !== -1)) {
        const tag = normLabel(m[1]);
        const href = m[2] ? m[2].replace(/^<(.*)>$/, '$1').replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : '';
        const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(/\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/g, '$1') : m[3];
        const raw = stripTrail(m[0], '\n');
        if (prev && (prev[0] === 'p' || prev[0] === 't')) prev[1] += '\n' + raw;
        else {
          if (!Object.hasOwn(ctx.links, tag)) ctx.links[tag] = { href, title };
          out.push(['def']);
        }
        rest = rest.slice(raw.length);
        continue;
      }
    }
    // Table.
    {
      const tb = tryTable(rest, ctx);
      if (tb) { out.push(tb.node); rest = rest.slice(tb.rawLen); continue; }
    }
    // Setext heading.
    {
      const lh = tryLheading(rest, ctx);
      if (lh) { out.push(lh.node); rest = rest.slice(lh.rawLen); continue; }
    }
    // Paragraph (top level only).
    if (ctx.top && (m = RE_PARAGRAPH.exec(rest))) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      if (n && prev && prev[0] === 'p') prev[1] += '\n' + text;
      else { const node = ['p', text]; queueInline(ctx, node, 1); out.push(node); }
      n = false;
      rest = rest.slice(m[0].length);
      continue;
    }
    // Plain text line (inside list items, where paragraphs are off).
    if ((m = /^[^\n]+/.exec(rest))) {
      if (prev && prev[0] === 't') prev[1] += '\n' + m[0];
      else { const node = ['t', m[0]]; queueInline(ctx, node, 1); out.push(node); }
      rest = rest.slice(m[0].length);
      continue;
    }
    throw new Error('Infinite loop on byte: ' + rest.charCodeAt(0));
  }
  ctx.top = true;
  return out;
}

// ============================== rendering ==============================

// Parse inline content with a shared state (inLink persists across the whole
// document; inRawBlock is reset before each top-level inline run, as marked
// does in its lex loop).
function inlineOf(text, links, st) {
  st.inRawBlock = false;
  return inlineHtml(text, links, st);
}

function renderBlocks(nodes, links, st) {
  let out = '';
  for (const node of nodes) {
    switch (node[0]) {
      case 'p': {
        out += '<p>' + (node[2] || '') + inlineOf(node[1], links, st) + '</p>\n';
        break;
      }
      case 't': {
        out += (node[2] || '') + inlineOf(node[1], links, st);
        break;
      }
      case 'h': {
        out += '<h' + node[1] + '>' + inlineOf(node[2], links, st) + '</h' + node[1] + '>\n';
        break;
      }
      case 'code': {
        const lang = (node[1] || '').match(/^\S*/)?.[0] || '';
        const body = node[2] ? node[2].replace(/\n$/, '') + '\n' : '';
        out += lang
          ? '<pre><code class="language-' + esc(lang, false) + '">' + esc(body, true) + '</code></pre>\n'
          : '<pre><code>' + esc(body, true) + '</code></pre>\n';
        break;
      }
      case 'hr': {
        out += '<hr>\n';
        break;
      }
      case 'html': {
        out += node[1];
        break;
      }
      case 'bq': {
        out += '<blockquote>\n' + renderBlocks(node[1], links, st) + '</blockquote>\n';
        break;
      }
      case 'list': {
        const tag = node[1] ? 'ol' : 'ul';
        const start = node[1] && node[2] !== 1 ? ' start="' + node[2] + '"' : '';
        let items = '';
        for (const item of node[4]) {
          items += '<li>' + renderBlocks(item[3], links, st) + '</li>\n';
        }
        out += '<' + tag + start + '>\n' + items + '</' + tag + '>\n';
        break;
      }
      case 'cb': {
        out += checkboxHtml(node[1]);
        break;
      }
      case 'table': {
        let head = '';
        for (const cell of node[2]) {
          head += (cell[1] ? '<th align="' + cell[1] + '">' : '<th>') + inlineOf(cell[0], links, st) + '</th>\n';
        }
        let body = '';
        for (const row of node[3]) {
          let cells = '';
          for (const cell of row) {
            cells += (cell[1] ? '<td align="' + cell[1] + '">' : '<td>') + inlineOf(cell[0], links, st) + '</td>\n';
          }
          body += '<tr>\n' + cells + '</tr>\n';
        }
        out += '<table>\n<thead>\n<tr>\n' + head + '</tr>\n</thead>\n' +
          (body ? '<tbody>' + body + '</tbody>' : '') + '</table>\n';
        break;
      }
      // 'def' and 'space' render nothing.
    }
  }
  return out;
}

// ============================== entry point ==============================

export function parse(markdown) {
  const src = markdown.includes('\r') ? markdown.replace(/\r\n|\r/g, '\n') : markdown;
  const ctx = newCtx();
  const nodes = blockTokens(src, ctx, false, []);
  const st = { inLink: false, inRawBlock: false, linkEmitted: false };
  return renderBlocks(nodes, ctx.links, st);
}
