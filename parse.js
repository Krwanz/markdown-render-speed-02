// A fast, dependency-free CommonMark 0.31.2 + GFM 0.29 parser written from
// scratch. parse(markdown) returns exactly the HTML marked 18.1.3 renders
// with its default options (GFM on, breaks off, pedantic off, async off).
// The implementation follows the CommonMark spec's block and inline
// algorithms, tuned to marked's observable output (probed against the
// reference renderer): its escaping rules, autolink handling, table shape,
// strikethrough with one or two tildes, and HTML-block line endings.

const SP = 32, TAB = 9, LF = 10, CR = 13;

// ---------------------------------------------------------------- utilities

function isSpace(c) { return c === SP || c === TAB || c === LF || c === CR; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunct(c) {
  // ASCII punctuation, plus a Unicode-punctuation test for the rest.
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
      (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  return PUNCT_RE.test(String.fromCharCode(c));
}
// ASCII punctuation only (backslash escapes work before these, and only these).
function isAsciiPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
const PUNCT_RE = /[\p{P}\p{S}]/u;

// Escape text/attribute content the way marked does when it does not
// re-encode: < > " ' are always escaped; & is escaped unless it starts an
// entity-like sequence (&#123; &#x1f; or &word;).
const NEED_ESC_RE = /[&<>"']/;
const NEED_ESC_ALL_RE = /[&<>"']/;

function esc(s) {
  // Fast path: most text has no escapable character at all.
  if (!NEED_ESC_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) { // &
      if (!isEntityStart(s, i)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Escape with every & encoded (used for code content and code spans).
function escAll(s) {
  // Fast path: most code has no escapable character at all.
  if (!NEED_ESC_ALL_RE.test(s)) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Is s[i] ('&') the start of an entity-like sequence: &#digits; &#xhex;
// or &word; (word = one or more word characters)?
function isEntityStart(s, i) {
  let j = i + 1;
  if (j >= s.length) return false;
  if (s.charCodeAt(j) === 35) { // #
    j++;
    let hex = false;
    if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const st = j;
    if (hex) { while (j < s.length && isHex(s.charCodeAt(j))) j++; }
    else { while (j < s.length && isDigit(s.charCodeAt(j))) j++; }
    if (!(j > st && j < s.length && s.charCodeAt(j) === 59)) return false;
    // out-of-range numeric refs are not entities: the & is escaped
    const cp = parseInt(s.slice(st, j), hex ? 16 : 10);
    return cp <= 0x10FFFF;
  }
  const st = j;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 95) j++; else break;
  }
  return j > st && j < s.length && s.charCodeAt(j) === 59;
}

function isHex(c) {
  return (c >= 48 && c <= 57) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

// Decode a numeric character reference starting at s[i] ('&').
// Returns [decodedChar, endIndex] or null when not a valid numeric ref.
function decodeNumericRef(s, i) {
  let j = i + 2; // skip &#
  let hex = false;
  if (j < s.length && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
  const st = j;
  if (hex) { while (j < s.length && isHex(s.charCodeAt(j))) j++; }
  else { while (j < s.length && isDigit(s.charCodeAt(j))) j++; }
  if (j === st || j >= s.length || s.charCodeAt(j) !== 59) return null;
  let cp = 0;
  if (hex) {
    for (let k = st; k < j; k++) {
      const c = s.charCodeAt(k);
      cp = cp * 16 + (c <= 57 ? c - 48 : (c <= 70 ? c - 55 : c - 87));
      if (cp > 0x10ffff) break;
    }
  } else {
    for (let k = st; k < j; k++) {
      cp = cp * 10 + (s.charCodeAt(k) - 48);
      if (cp > 0x10ffff) break;
    }
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return [String.fromCodePoint(cp), j + 1];
}

// Process backslash escapes and numeric character references in a string
// (link destinations, titles, labels). Named entities are left as-is.
function unescapeStr(s) {
  if (s.indexOf('\\') < 0 && s.indexOf('&') < 0) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && isAsciiPunct(s.charCodeAt(i + 1))) {
      if (i > start) out += s.slice(start, i);
      out += s[i + 1];
      start = i + 2;
      i++;
    } else if (c === 38 && i + 1 < s.length && s.charCodeAt(i + 1) === 35) {
      const d = decodeNumericRef(s, i);
      if (d) {
        if (i > start) out += s.slice(start, i);
        out += d[0];
        start = d[1];
        i = d[1] - 1;
      }
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// marked's URL cleaning: encodeURI, or null when it throws (lone surrogate).
const URL_EXTRA_ENCODE = { '\\': '%5C', '{': '%7B', '}': '%7D', '|': '%7C', '^': '%5E', '[': '%5B', ']': '%5D' };
function cleanUrl(url) {
  try {
    // encodeURI, but % is left alone (existing escapes stay as-is), plus
    // the characters encodeURI leaves alone that marked encodes
    return encodeURI(url).replace(/%25/g, '%')
      .replace(/[\\{}|^[\]]/g, (ch) => URL_EXTRA_ENCODE[ch]);
  } catch {
    return null;
  }
}

// Normalize a link label: collapse whitespace runs to one space, trim,
// case-fold.
function normalizeLabel(s) {
  // Unicode case folding: sharp s folds to "ss" (ß and ẞ)
  const folded = s.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/\u00df/g, 'ss').replace(/\u1e9e/g, 'ss');
  // a label that is empty or only whitespace is invalid
  if (folded.trim() === '') return '';
  return folded;
}

// True when a label contains an unescaped '[' (labels may not contain one).
function labelHasBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92) { i++; continue; }
    if (s.charCodeAt(i) === 91) return true;
  }
  return false;
}

// ---------------------------------------------------------------- line cursor
// A cursor walks one source line, tracking the column so tabs expand to the
// next multiple of 4. `pad` holds virtual spaces left over when a tab is
// only partly consumed by an indentation request.

function cur(s) { return { s, i: 0, col: 0, pad: 0 }; }
function cch(L) {
  if (L.pad > 0) return SP;
  return L.i < L.s.length ? L.s.charCodeAt(L.i) : -1;
}
function cadv(L) {
  if (L.pad > 0) { L.pad--; L.col++; return; }
  const c = L.s.charCodeAt(L.i);
  L.i++;
  if (c === TAB) L.col += 4 - (L.col % 4); else L.col++;
}
// Columns of leading indentation available from here (without consuming).
// The pad holds virtual spaces from a partially consumed tab; the
// character at L.i sits at column L.col + L.pad.
function indentAvail(L) {
  let col = L.col + L.pad, i = L.i, n = L.pad;
  while (i < L.s.length) {
    const c = L.s.charCodeAt(i);
    if (c === SP) { n++; i++; col++; }
    else if (c === TAB) { const w = 4 - (col % 4); n += w; i++; col += w; }
    else break;
  }
  return n;
}
// Consume up to n columns of indentation; returns columns consumed.
function consumeIndent(L, n) {
  let used = 0;
  while (used < n) {
    const c = cch(L);
    if (c === SP) { cadv(L); used++; }
    else if (c === TAB) {
      const w = 4 - (L.col % 4);
      if (used + w <= n) { cadv(L); used += w; }
      else {
        // Tab straddles the boundary: keep the rest as virtual spaces.
        // Advance past the tab, but only by the consumed columns; the
        // remaining columns stay as pad before the next character.
        L.pad = used + w - n;
        L.i++;
        L.col += (n - used);
        used = n;
      }
    } else break;
  }
  return used;
}
// The rest of the line from the cursor (virtual spaces first).
function rest(L) {
  if (L.pad > 0) return ' '.repeat(L.pad) + L.s.slice(L.i);
  return L.s.slice(L.i);
}
// Expand a leading tab at the cursor into spaces (to the next multiple
// of 4 columns), so `rest()` returns spaces instead of a raw tab. Used
// for fenced-code content lines inside a container, where the tab sits
// at a non-zero column; at column 0 the tab is kept literally.
function expandLeadingTab(L, inContainer) {
  // A leading tab in fenced-code content expands to spaces only inside
  // a container (list/blockquote); at the top level — even when the fence
  // itself is indented — the tab is kept literally.
  if (inContainer && L.col > 0 && L.pad === 0 && L.i < L.s.length && L.s.charCodeAt(L.i) === TAB) {
    const w = 4 - (L.col % 4);
    L.pad = w;
    L.i++;
    L.col += w;
  }
}
// Is the rest of the line blank (only spaces/tabs)?
function isBlankRest(L) {
  if (L.pad > 0) return false;
  for (let i = L.i; i < L.s.length; i++) {
    const c = L.s.charCodeAt(i);
    if (c !== SP && c !== TAB) return false;
  }
  return true;
}
// Count trailing spaces/tabs of a string.
function trailingSpaces(s) {
  let n = 0;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s.charCodeAt(i);
    if (c === SP || c === TAB) n++; else break;
  }
  return n;
}
function trimRight(s) {
  let e = s.length;
  while (e > 0) {
    const c = s.charCodeAt(e - 1);
    if (c === SP || c === TAB) e--; else break;
  }
  return s.slice(0, e);
}
function trimLeft(s) {
  let b = 0;
  while (b < s.length) {
    const c = s.charCodeAt(b);
    if (c === SP || c === TAB) b++; else break;
  }
  return s.slice(b);
}

// ------------------------------------------------------------------ blocks

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

// Split a table row line into cells (handles \| and outer pipes).
function splitTableRow(line) {
  let s = line;
  // strip one leading and one trailing pipe (outer pipes)
  let start = 0, end = s.length;
  while (start < end && (s.charCodeAt(start) === SP || s.charCodeAt(start) === TAB)) start++;
  while (end > start && (s.charCodeAt(end - 1) === SP || s.charCodeAt(end - 1) === TAB)) end--;
  if (start < end && s.charCodeAt(start) === 124) start++;
  if (end > start && s.charCodeAt(end - 1) === 124) end--;
  const cells = [];
  let cur = '';
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < end) {
      const d = s.charCodeAt(i + 1);
      if (d === 124) { cur += '|'; i += 2; continue; } // \| is a literal pipe
      if (d === 92) { cur += '\\\\'; i += 2; continue; } // \\ stays escaped
    }
    if (c === 124) { cells.push(cur); cur = ''; i++; continue; }
    cur += s[i];
    i++;
  }
  cells.push(cur);
  return cells.map((c) => trimLeft(trimRight(c)));
}

// Parse a delimiter row; returns array of alignments ('left'|'right'|'center'|null)
// or null when the line is not a delimiter row (must contain a pipe, and its
// leading indent must be at most 3 columns).
function parseDelimiterRow(line) {
  if (line.indexOf('|') < 0) return null;
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === SP) col++;
    else if (c === TAB) col += 4 - (col % 4);
    else break;
    if (col >= 4) return null;
  }
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    let c = cell;
    let left = false, right = false;
    if (c.startsWith(':')) { left = true; c = c.slice(1); }
    if (c.endsWith(':')) { right = true; c = c.slice(0, -1); }
    if (c.length === 0) return null;
    for (let i = 0; i < c.length; i++) if (c.charCodeAt(i) !== 45) return null;
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// --- block-start detectors (operate on a cursor positioned after containers)

function atxHeading(L) {
  // returns level 1..6 or 0
  const save = { i: L.i, col: L.col, pad: L.pad };
  if (indentAvail(L) >= 4) return 0;
  consumeIndent(L, 3);
  let n = 0;
  while (cch(L) === 35 && n < 7) { cadv(L); n++; }
  if (n === 0 || n > 6) { L.i = save.i; L.col = save.col; L.pad = save.pad; return 0; }
  const c = cch(L);
  if (c !== -1 && c !== SP && c !== TAB) { L.i = save.i; L.col = save.col; L.pad = save.pad; return 0; }
  return n;
}

function fenceStart(L) {
  // returns {char, len, indent} or null; cursor left past the fence run
  const save = { i: L.i, col: L.col, pad: L.pad };
  if (indentAvail(L) >= 4) return null;
  const indent = consumeIndent(L, 3);
  const c = cch(L);
  if (c !== 96 && c !== 126) { L.i = save.i; L.col = save.col; L.pad = save.pad; return null; }
  let n = 0;
  while (cch(L) === c) { cadv(L); n++; }
  if (n < 3) { L.i = save.i; L.col = save.col; L.pad = save.pad; return null; }
  return { char: c, len: n, indent };
}

function isThematicBreak(L) {
  const save = { i: L.i, col: L.col, pad: L.pad };
  if (indentAvail(L) >= 4) return false;
  consumeIndent(L, 3);
  const c = cch(L);
  if (c !== 42 && c !== 45 && c !== 95) { L.i = save.i; L.col = save.col; L.pad = save.pad; return false; }
  let n = 0;
  while (true) {
    const d = cch(L);
    if (d === c) { cadv(L); n++; }
    else if (d === SP || d === TAB) { cadv(L); }
    else break;
  }
  const ok = n >= 3 && cch(L) === -1;
  L.i = save.i; L.col = save.col; L.pad = save.pad;
  return ok;
}

function setextLevel(L) {
  // returns 1 for ===, 2 for ---, 0 otherwise
  const save = { i: L.i, col: L.col, pad: L.pad };
  if (indentAvail(L) >= 4) return 0;
  consumeIndent(L, 3);
  const c = cch(L);
  if (c !== 61 && c !== 45) { L.i = save.i; L.col = save.col; L.pad = save.pad; return 0; }
  let n = 0;
  while (cch(L) === c) { cadv(L); n++; }
  // only trailing whitespace may follow (no spaces between markers)
  while (cch(L) === SP || cch(L) === TAB) cadv(L);
  const ok = n >= 1 && cch(L) === -1;
  L.i = save.i; L.col = save.col; L.pad = save.pad;
  return ok ? (c === 61 ? 1 : 2) : 0;
}

// List marker at cursor: returns {ordered, start, delim, markerKey,
// markerLen, contentIndent, empty} or null. Leaves the cursor at the
// start of the item's content. contentIndent is RELATIVE to the cursor's
// effective column (col + pad) on entry — i.e. to the position after the
// outer containers on the line where the item opens — so a continuation
// line whose blockquote markers sit at different columns still matches
// (cm-259, cm-260): the indent available after this line's own markers
// is compared against the same relative value.
function listMarker(L) {
  const save = { i: L.i, col: L.col, pad: L.pad };
  const baseCol = save.col + save.pad;
  if (indentAvail(L) >= 4) return null;
  consumeIndent(L, 3);
  const markerCol = L.col;
  const c = cch(L);
  let ordered = false, start = 0, delim = '', markerLen = 0, key = '';
  if (c === 45 || c === 43 || c === 42) {
    markerLen = 1;
    key = String.fromCharCode(c);
    cadv(L);
  } else if (isDigit(c)) {
    let n = 0, v = 0;
    while (isDigit(cch(L)) && n < 10) { v = v * 10 + (cch(L) - 48); cadv(L); n++; }
    if (n === 0 || n > 9) { L.i = save.i; L.col = save.col; L.pad = save.pad; return null; }
    const d = cch(L);
    if (d !== 46 && d !== 41) { L.i = save.i; L.col = save.col; L.pad = save.pad; return null; }
    delim = d === 46 ? '.' : ')';
    key = delim;
    cadv(L);
    ordered = true;
    start = v;
    markerLen = n + 1;
  } else {
    L.i = save.i; L.col = save.col; L.pad = save.pad;
    return null;
  }
  // Count the spaces after the marker without consuming them yet.
  let spaces = 0, j = L.i, col = L.col, pad = L.pad, blank = true;
  while (j < L.s.length) {
    const d = L.s.charCodeAt(j);
    if (d === SP) { spaces++; j++; col++; }
    else if (d === TAB) { const w = 4 - (col % 4); spaces += w; j++; col += w; }
    else { blank = false; break; }
  }
  const empty = blank;
  let contentIndent;
  if (empty) {
    contentIndent = markerCol + markerLen + 1;
  } else if (spaces === 0) {
    L.i = save.i; L.col = save.col; L.pad = save.pad;
    return null;
  } else if (spaces >= 5) {
    contentIndent = markerCol + markerLen + 1;
    consumeIndent(L, 1);
  } else {
    contentIndent = markerCol + markerLen + spaces;
    consumeIndent(L, spaces);
  }
  return { ordered, start, delim, markerKey: key, markerLen, contentIndent: contentIndent - baseCol, empty, markerCol };
}

// HTML block start: returns type 1..6 or 0. `line` is the remaining text.
function htmlBlockType(s) {
  // s starts at the (possibly indented) tag position; leading spaces <= 3
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB) && i < 3) i++;
  if (i >= s.length || s.charCodeAt(i) !== 60) return 0; // <
  const t = s.slice(i + 1);
  const low = t.toLowerCase();
  if (/^(script|pre|style|textarea)([\s>]|$)/.test(low)) return 1;
  if (t.startsWith('!--')) return 2;
  if (t.startsWith('?')) return 3;
  if (t.startsWith('!') && t.length > 1) {
    const c = t.charCodeAt(1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 4;
  }
  if (t.startsWith('![CDATA[')) return 5;
  if (t.startsWith('/') || /^[a-zA-Z]/.test(t)) {
    const m = /^\/ ?([a-zA-Z][a-zA-Z0-9-]*)/.test(t)
      ? t.match(/^\/ ?([a-zA-Z][a-zA-Z0-9-]*)/)
      : t.match(/^([a-zA-Z][a-zA-Z0-9-]*)/);
    if (m) {
      if (BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
      // a line that is exactly one (non-block) tag, nothing else, is
      // also an HTML block (type 7: it cannot interrupt a paragraph)
      const e = inlineHtmlEnd(s, i);
      if (e > 0 && s.slice(e).trim() === '') return 7;
    }
  }
  return 0;
}

// The type-1 tag name (script/pre/style/textarea) a line opens, or null.
function htmlOpenTag(s) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB) && i < 3) i++;
  if (i >= s.length || s.charCodeAt(i) !== 60) return null;
  const m = s.slice(i + 1).match(/^(script|pre|style|textarea)([\s>]|$)/i);
  return m ? m[1].toLowerCase() : null;
}

// Does an HTML block of this type end on this line? For type 1, ends
// when the matching closing tag appears.
function htmlBlockEnds(type, s, tag) {
  switch (type) {
    case 1: return tag ? s.toLowerCase().indexOf('</' + tag) >= 0 : false;
    case 2: return s.indexOf('-->') >= 0;
    case 3: return s.indexOf('?>') >= 0;
    case 4: return s.indexOf('>') >= 0;
    case 5: return s.indexOf(']]>') >= 0;
    case 6: return false; // ends at blank line
    case 7: return false; // lone tag: ends at blank line
    default: return false;
  }
}

// ------------------------------------------------------------------ link definitions

// Parse a link reference definition from `text` (may span lines).
// Returns {label, dest, title, endPos} or null. endPos is the index just
// past the destination/title (before trailing whitespace).
function parseLinkDefText(text) {
  const n = text.length;
  let i = 0;
  // leading indent: at most 3 columns
  let col = 0;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === SP && col < 3) { i++; col++; }
    else if (c === TAB) { const w = 4 - (col % 4); if (col + w > 3) break; i++; col += w; }
    else break;
  }
  if (i >= n || text.charCodeAt(i) !== 91) return null; // [
  i++;
  // label: balanced brackets, backslash escapes (may span lines)
  const labelStart = i;
  let depth = 1;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 92 && i + 1 < n) { i += 2; continue; } // backslash escape
    if (c === 91) depth++;
    else if (c === 93) { depth--; if (depth === 0) break; }
    i++;
  }
  if (depth !== 0 || i >= n) return null;
  const label = text.slice(labelStart, i);
  i++; // past ]
  if (label.length === 0) return null;
  if (labelHasBracket(label)) return null;
  if (normalizeLabel(label) === '') return null;
  if (i >= n || text.charCodeAt(i) !== 58) return null; // :
  i++;
  // skip whitespace (spaces, tabs, newlines, any indent on continuation
  // lines; blank lines never reach here because the caller only joins
  // non-blank lines)
  const skipWS = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === SP || c === TAB || c === LF) i++;
      else break;
    }
  };
  skipWS();
  if (i >= n) return null; // no destination (caller may retry with more lines)
  // destination
  let dest = '';
  if (text.charCodeAt(i) === 60) { // <
    i++;
    const ds = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === LF) return null; // no line ending inside <...>
      if (c === 92 && i + 1 < n) { i += 2; continue; }
      if (c === 60) return null; // unescaped <
      if (c === 62) break;
      i++;
    }
    if (i >= n) return null; // unterminated (caller may retry)
    dest = text.slice(ds, i);
    i++; // past >
  } else {
    const ds = i;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === SP || c === TAB || c === LF) break;
      if (c < 32) return null; // control char
      if (c === 92 && i + 1 < n && isAsciiPunct(text.charCodeAt(i + 1))) { i += 2; continue; }
      i++;
    }
    if (i === ds) return null; // empty destination
    dest = text.slice(ds, i);
  }
  const afterDest = i;
  skipWS();
  let title = null;
  let endPos = i;
  if (i < n) {
    const c = text.charCodeAt(i);
    // a title must be separated from the destination by whitespace
    if ((c === 34 || c === 39 || c === 40) && i === afterDest) return null;
    if (c === 34 || c === 39) { // " or '
      const q = c;
      i++;
      const ts = i;
      let closed = false;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92 && i + 1 < n) { i += 2; continue; }
        if (d === q) { closed = true; break; }
        i++;
      }
      if (!closed) return null; // unterminated (caller may retry)
      title = text.slice(ts, i);
      i++; // past quote
      endPos = i;
    } else if (c === 40) { // (
      i++;
      const ts = i;
      let dep = 1, closed = false;
      while (i < n) {
        const d = text.charCodeAt(i);
        if (d === 92 && i + 1 < n) { i += 2; continue; }
        if (d === 40) dep++;
        else if (d === 41) { dep--; if (dep === 0) { closed = true; break; } }
        i++;
      }
      if (!closed) return null; // unterminated (caller may retry)
      title = text.slice(ts, i);
      i++; // past )
      endPos = i;
    } else if (c === LF || c === SP || c === TAB) {
      // trailing whitespace only; no title
    } else {
      return null; // trailing garbage
    }
  }
  return { label, dest, title, endPos };
}

// ------------------------------------------------------------------ parsing

function parseBlocks(src) {
  src = src.replace(/\r\n?/g, '\n');
  const endsNL = src.length > 0 && src.charCodeAt(src.length - 1) === LF;
  const lines = src.split('\n');
  if (endsNL) lines.pop();

  const S = {
    lines, endsNL,
    doc: { t: 'doc', children: [] },
    stack: null, // filled below
    leaf: null,
    blankPending: false,
    blankBq: null, // innermost blockquote when the blank line was seen
    li: 0,
    pendingHtml: null, // html node whose trailing newline is not yet decided
    refs: new Map(), // normalized label -> {dest, title}
  };
  S.stack = [S.doc];

  // Does the pending blank line mark a new node? Yes, except when the
  // blank line was inside a blockquote that has since closed: a blank
  // line inside a blockquote does not loosen the outer list. A blank
  // line inside a nested list does propagate out to the outer item.
  function takeBlank() {
    if (!S.blankPending) return false;
    const bq = S.blankBq;
    S.blankPending = false;
    S.blankBq = null;
    if (bq && S.stack.indexOf(bq) < 0) return false;
    return true;
  }

  function addChild(node) {
    const parent = S.stack[S.stack.length - 1];
    if (takeBlank()) node.blankBefore = true;
    parent.children.push(node);
    return node;
  }
  function closeLeaf() {
    if (S.leaf) {
      if (S.leaf.t === 'html' && (S.leaf.htmlType === 6 || S.leaf.htmlType === 7) &&
          S.leaf.endedByBlank === undefined) {
        // types 6/7 end at a blank line or a container boundary: no
        // trailing newline (the top-level EOF case sets it to false first)
        S.leaf.endedByBlank = true;
      }
      if (S.leaf.t === 'code') {
        if (!S.leaf.fenced) {
          let trimmed = 0;
          while (S.leaf.lines.length > 0 && trimRight(S.leaf.lines[S.leaf.lines.length - 1]) === '') { S.leaf.lines.pop(); trimmed++; }
          if (S.leaf.lines.length === 0) S.leaf.trailingNL = false;
          else if (trimmed > 0) S.leaf.trailingNL = true;
          else S.leaf.trailingNL = (S.leaf.endLine < S.lines.length - 1 || S.endsNL);
        } else if (!S.leaf.closedByFence) {
          // unclosed fence running to EOF
          if (S.leaf.lines.length === 0) S.leaf.trailingNL = false;
          else S.leaf.trailingNL = (S.leaf.endLine < S.lines.length - 1 || S.endsNL);
        }
      }
      S.leaf = null;
    }
  }
  function closeTo(depth) {
    while (S.stack.length > depth + 1) {
      const node = S.stack.pop();
      if (node.t === 'list') {
        let loose = false;
        for (let i = 0; i < node.children.length; i++) {
          const item = node.children[i];
          if (!item.children) continue; // non-item child (should not happen)
          if (i > 0 && item.blankBefore) { loose = true; break; }
          for (let j = 1; j < item.children.length; j++) {
            if (item.children[j].blankBefore) { loose = true; break; }
          }
          if (loose) break;
        }
        node.tight = !loose;
      }
    }
    closeLeaf();
  }

  // Match open containers against the cursor. Returns {depth, failedAt}.
  // A blank line matches every container.
  // The match is cached per line: leaf paths (fenced/indented code, HTML)
  // call this on the main cursor and then fall through to the main match
  // on the same, already-advanced cursor — a second run would re-read
  // consumed markers and fail, so a successful match is reused when the
  // line, stack length and exact cursor position are unchanged.
  function matchContainers(L, lineIdx = S.li) {
    if (S.matchLine === lineIdx && S.matchStackLen === S.stack.length &&
        S.matchI === L.i && S.matchCol === L.col && S.matchPad === L.pad &&
        S.matchDepth >= 0) {
      return { depth: S.matchDepth, failedAt: -1 };
    }
    if (isBlankRest(L)) {
      S.matchLine = lineIdx; S.matchStackLen = S.stack.length;
      S.matchI = L.i; S.matchCol = L.col; S.matchPad = L.pad;
      S.matchDepth = S.stack.length - 1;
      return { depth: S.stack.length - 1, failedAt: -1 };
    }
    let depth = 0, failedAt = -1;
    for (let d = 1; d < S.stack.length; d++) {
      const node = S.stack[d];
      if (node.t === 'bq') {
        const save = { i: L.i, col: L.col, pad: L.pad };
        consumeIndent(L, 3);
        if (cch(L) === 62) {
          cadv(L);
          // one optional space after '>'; a tab counts as one column
          if (cch(L) === SP || cch(L) === TAB) consumeIndent(L, 1);
          depth = d;
        } else {
          L.i = save.i; L.col = save.col; L.pad = save.pad;
          failedAt = d;
          break;
        }
      } else if (node.t === 'item') {
        // contentIndent is relative to the position after the outer
        // containers on the line where the item opened; indentAvail
        // counts the indent available from the cursor after this line's
        // own containers, so the two compare directly.
        if (isBlankRest(L)) {
          depth = d;
          continue;
        }
        // an empty item cannot take content after a blank line
        if (node.children.length === 0 && S.blankPending) {
          failedAt = d;
          break;
        }
        if (indentAvail(L) >= node.contentIndent) {
          consumeIndent(L, node.contentIndent);
          depth = d;
        } else {
          failedAt = d;
          break;
        }
      } else {
        depth = d; // list (and table, which is handled separately) matches
      }
    }
    if (failedAt < 0) {
      S.matchLine = lineIdx; S.matchStackLen = S.stack.length;
      S.matchI = L.i; S.matchCol = L.col; S.matchPad = L.pad;
      S.matchDepth = depth;
    }
    return { depth, failedAt };
  }

  // Rest of line `idx` after matching the current containers, or null
  // when it does not match or is blank.
  function lineRestAt(idx) {
    if (idx >= S.lines.length) return null;
    const nl = cur(S.lines[idx]);
    if (isBlankRest(nl)) return null;
    const m = matchContainers(nl, idx);
    if (m.failedAt >= 0) return null;
    return rest(nl);
  }

  // Try to parse a link reference definition starting at cursor L.
  // Returns {linesConsumed} or null. Records the ref (first wins).
  function tryLinkDef(L) {
    if (indentAvail(L) >= 4) return null;
    let text = rest(L);
    let linesUsed = 1;
    // keep the longest valid parse: a longer attempt may fail (e.g. an
    // invalid title line), in which case the shorter one stands
    let best = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      const res = parseLinkDefText(text);
      if (res) {
        const afterEnd = text.slice(res.endPos);
        const nlIdx = afterEnd.indexOf('\n');
        const tail = nlIdx >= 0 ? afterEnd.slice(0, nlIdx) : afterEnd;
        if (/^[ \t]*$/.test(tail)) {
          const linesConsumed = (text.slice(0, res.endPos).match(/\n/g) || []).length + 1;
          best = { linesConsumed, label: normalizeLabel(res.label), dest: res.dest, title: res.title };
          // greedy title: if there is no title yet but the next line
          // starts one, keep going so the title is included
          if (res.title === null && S.li + linesUsed < S.lines.length) {
            const nxt = lineRestAt(S.li + linesUsed);
            if (nxt !== null) {
              const t = nxt.trimStart();
              if (t.length > 0 && (t.charCodeAt(0) === 34 || t.charCodeAt(0) === 39 || t.charCodeAt(0) === 40)) {
                text += '\n' + nxt;
                linesUsed++;
                continue;
              }
            }
          }
          break; // no title to chase: this is the parse
        }
        break; // trailing garbage on the def's last line: keep best
      }
      if (S.li + linesUsed >= S.lines.length) break;
      const nxt = lineRestAt(S.li + linesUsed);
      if (nxt === null) break;
      text += '\n' + nxt;
      linesUsed++;
    }
    if (best) {
      if (best.label && !S.refs.has(best.label)) {
        S.refs.set(best.label, { dest: best.dest, title: best.title });
      }
      return { linesConsumed: best.linesConsumed };
    }
    return null;
  }

  // Smallest stack depth (>=1) holding a blockquote, or -1.
  function outermostBqDepth() {
    for (let d = 1; d < S.stack.length; d++) if (S.stack[d].t === 'bq') return d;
    return -1;
  }

  // Run `pred` on the next line after matching the current containers.
  // False when there is no next line or it does not match the containers.
  function nextLineMatches(pred) {
    if (S.li + 1 >= S.lines.length) return false;
    const nl = cur(S.lines[S.li + 1]);
    const m = matchContainers(nl, S.li + 1);
    if (m.failedAt >= 0) return false;
    return pred(nl);
  }
  function nextLineIsDelimiter() {
    return nextLineMatches((nl) => parseDelimiterRow(rest(nl)) !== null);
  }
  function nextLineIsSetext() {
    return nextLineMatches((nl) => setextLevel(nl) !== 0);
  }
  // Alignments of the next line when it is a delimiter row in context.
  function nextLineDelimiterAligns() {
    if (S.li + 1 >= S.lines.length) return null;
    const nl = cur(S.lines[S.li + 1]);
    const m = matchContainers(nl, S.li + 1);
    if (m.failedAt >= 0) return null;
    return parseDelimiterRow(rest(nl));
  }

  // Push the line at cursor L onto the open paragraph (S.leaf must be a
  // paragraph). Applies the leading-indent strip rules:
  //  - in a list item, a line indented >=4 is stripped (unless the next
  //    line is a setext underline, in which case it is kept whole);
  //  - a lazy line in a blockquote is stripped when the strip state is on
  //    or the previous line was not lazy;
  //  - a blockquote line is stripped only while the strip state is on,
  //    otherwise (top level included) an indented line is stripped only
  //    when the next line is a delimiter row, and then the paragraph ends.
  // Returns 'ended' when the paragraph must end after this line, else 'ok'.
  function paraPushLine(L, isLazy) {
    const para = S.leaf;
    const parent = S.stack[S.stack.length - 1];
    const parentIsItem = parent.t === 'item';
    const remIndent = indentAvail(L);
    let stripped = false;
    let endPara = false;
    if (remIndent >= 4) {
      if (parentIsItem) {
        if (!nextLineIsSetext()) { consumeIndent(L, 4); stripped = true; }
      } else if (isLazy) {
        if (para.stripState || !para.prevLazy) { consumeIndent(L, 4); stripped = true; }
      } else if (para.stripState) {
        consumeIndent(L, 4); stripped = true;
      } else if (nextLineIsDelimiter()) {
        consumeIndent(L, 4); stripped = true; endPara = true;
      }
    }
    if (para.prevStripped && !stripped) para.lines.push('');
    // A lazy `===` line inside a blockquote, following another lazy line,
    // is not a setext underline: it stays in the paragraph, indented by
    // four spaces (the lazy line's missing container markers). A `---`
    // line never reaches here (it is a thematic break and interrupts).
    let line = rest(L);
    if (isLazy && para.prevLazy && setextLevel(L) === 1) {
      let inBq = false;
      for (let d = 1; d < S.stack.length; d++) if (S.stack[d].t === 'bq') { inBq = true; break; }
      // exactly four spaces: the line's own leading indent is discarded
      if (inBq) line = '    ' + line.replace(/^\s+/, '');
    }
    para.lines.push(line);
    if (stripped) para.stripState = true;
    else if (isLazy && remIndent < 4) para.stripState = false;
    para.prevStripped = stripped;
    // lastStripState: last line stripped by the state model (lazy or list
    // item), not by the delimiter trigger (which ends the paragraph).
    para.lastStripState = stripped && !endPara;
    para.prevLazy = isLazy;
    return endPara ? 'ended' : 'ok';
  }

  // Does the line at cursor start a block that can interrupt a paragraph
  // from outside its container (a lazy line)? Any ATX heading, fenced
  // code, HTML block, thematic break, blockquote, or list marker counts;
  // a setext underline, table delimiter, or indented code does not.
  // Restores the cursor.
  // Is the current block inside a list item? Inside one, any non-empty
  // list can interrupt a paragraph (it nests); outside, an ordered list
  // must start at 1.
  function inListItem() {
    for (let d = 1; d < S.stack.length; d++) if (S.stack[d].t === 'item') return true;
    return false;
  }

  function canInterruptPara(L) {
    const save = { i: L.i, col: L.col, pad: L.pad };
    let r = false;
    if (atxHeading(L)) r = true;
    else {
      const fs = fenceStart(L);
      if (fs) {
        // a backtick fence whose info string contains a backtick is not a fence
        r = !(fs.char === 96 && rest(L).indexOf('`') >= 0);
      } else if (htmlBlockType(rest(L))) r = true;
      else if (isThematicBreak(L)) r = true;
      else {
        const s2 = { i: L.i, col: L.col, pad: L.pad };
        consumeIndent(L, 3);
        if (cch(L) === 62) r = true;
        else {
          L.i = s2.i; L.col = s2.col; L.pad = s2.pad;
          const lm = listMarker(L);
          if (lm) r = !lm.empty && (!lm.ordered || lm.start === 1 || inListItem());
        }
      }
    }
    L.i = save.i; L.col = save.col; L.pad = save.pad;
    return r;
  }

  // Does the line at cursor start a block that would end a table?
  function startsBlock(L) {
    const save = { i: L.i, col: L.col, pad: L.pad };
    let r = false;
    if (indentAvail(L) >= 4) r = true;
    else if (atxHeading(L)) r = true;
    else if (fenceStart(L)) r = true;
    else if (htmlBlockType(rest(L))) r = true;
    else if (isThematicBreak(L)) r = true;
    else if (listMarker(L)) r = true;
    else if (cch(L) === 62) r = true;
    L.i = save.i; L.col = save.col; L.pad = save.pad;
    return r;
  }

  // Start a block at the cursor (used for normal lines and for the content
  // of a list item's marker line). Returns true when a block was started.
  // May recurse for blockquotes and nested lists.
  function startBlock(L) {
    const li = S.li;
    // A list can only contain items: if the top of the stack is a list,
    // close it unless this line is a list item (and not a higher
    // precedence block such as a thematic break, ATX heading, fence,
    // HTML block or blockquote).
    if (S.stack[S.stack.length - 1].t === 'list') {
      const save = { i: L.i, col: L.col, pad: L.pad };
      let keep = false;
      if (!atxHeading(L) && !fenceStart(L) && !htmlBlockType(rest(L)) &&
          !isThematicBreak(L)) {
        // blockquote?
        const s2 = { i: L.i, col: L.col, pad: L.pad };
        consumeIndent(L, 3);
        const isBq = cch(L) === 62;
        L.i = s2.i; L.col = s2.col; L.pad = s2.pad;
        if (!isBq) keep = !!listMarker(L);
      }
      L.i = save.i; L.col = save.col; L.pad = save.pad;
      if (!keep) closeTo(S.stack.length - 2);
    }
    // ATX heading
    const hl = atxHeading(L);
    if (hl) {
      if (cch(L) === SP || cch(L) === TAB) cadv(L);
      let text = trimRight(rest(L));
      let e = text.length;
      while (e > 0 && text.charCodeAt(e - 1) === 35) e--;
      if (e < text.length && (e === 0 || text.charCodeAt(e - 1) === SP || text.charCodeAt(e - 1) === TAB)) {
        text = trimRight(text.slice(0, e));
      }
      text = trimLeft(text);
      closeLeaf();
      addChild({ t: 'h', level: hl, lines: [text] });
      return true;
    }
    // fenced code
    const fsSave = { i: L.i, col: L.col, pad: L.pad };
    const fs = fenceStart(L);
    if (fs) {
      const info = rest(L);
      if (!(fs.char === 96 && info.indexOf('`') >= 0)) {
        closeLeaf();
        S.leaf = addChild({ t: 'code', info: trimRight(trimLeft(info)), lines: [], fenced: true, fenceChar: fs.char, fenceLen: fs.len, fenceIndent: fs.indent, endLine: li, trailingNL: false });
        return true;
      }
      // not a fence (backtick in a backtick fence's info string): rewind
      // the cursor to before the fence and fall through.
      L.i = fsSave.i; L.col = fsSave.col; L.pad = fsSave.pad;
    }
    // HTML block (a lone inline tag, type 7, cannot interrupt a paragraph)
    const hb = htmlBlockType(rest(L));
    if (hb && !(hb === 7 && S.leaf && S.leaf.t === 'para')) {
      closeLeaf();
      const tag = hb === 1 ? htmlOpenTag(rest(L)) : null;
      S.leaf = addChild({ t: 'html', htmlType: hb, htmlTag: tag, lines: [rest(L)] });
      if (htmlBlockEnds(hb, rest(L), tag)) {
        S.leaf.endLine = li;
        const node = S.leaf;
        closeLeaf();
        S.pendingHtml = node; // decide the trailing newline on the next line
      }
      return true;
    }
    // thematic break
    if (isThematicBreak(L)) {
      closeLeaf();
      addChild({ t: 'hr' });
      return true;
    }
    // blockquote
    {
      const save = { i: L.i, col: L.col, pad: L.pad };
      consumeIndent(L, 3);
      if (cch(L) === 62) {
        cadv(L);
        // one optional space after '>'; a tab counts as one column
        if (cch(L) === SP || cch(L) === TAB) consumeIndent(L, 1);
        closeLeaf();
        const bq = addChild({ t: 'bq', children: [] });
        S.stack.push(bq);
        if (isBlankRest(L)) return true;
        startBlock(L); // content of the quote line
        return true;
      }
      L.i = save.i; L.col = save.col; L.pad = save.pad;
    }
    // list item
    const lmSave = { i: L.i, col: L.col, pad: L.pad };
    const lm = listMarker(L);
    if (lm) {
      // A list can interrupt a paragraph only when it is non-empty and,
      // for ordered lists, starts at 1 — unless the paragraph is inside
      // a list item, where any list nests. An empty item never interrupts.
      const canInterrupt = !S.leaf || S.leaf.t !== 'para' ||
        (!lm.empty && (!lm.ordered || lm.start === 1 || inListItem()));
      if (canInterrupt) {
        closeLeaf();
        const top = S.stack[S.stack.length - 1];
        let list = null;
        if (top.t === 'list' && top.ordered === lm.ordered && top.markerKey === lm.markerKey) list = top;
        if (!list) {
          // a different marker starts a new list: close the old one so
          // the new list is its sibling, not its child
          if (top.t === 'list') closeTo(S.stack.length - 2);
          list = addChild({ t: 'list', ordered: lm.ordered, start: lm.start, delim: lm.delim, markerKey: lm.markerKey, tight: true, children: [] });
        }
        const item = { t: 'item', contentIndent: lm.contentIndent, children: [] };
        if (takeBlank()) item.blankBefore = true;
        list.children.push(item);
        // only push the list when it is new; a reused list is already
        // on the stack (pushing it again would duplicate it)
        if (top.t === 'list' && top === list) S.stack.push(item);
        else S.stack.push(list, item);
        if (!lm.empty && !isBlankRest(L)) startBlock(L);
        return true;
      }
      // cannot interrupt a paragraph: restore the cursor to before the
      // marker and fall through to paragraph handling below.
      L.i = lmSave.i; L.col = lmSave.col; L.pad = lmSave.pad;
    }
    // indented code
    if ((!S.leaf || S.leaf.t !== 'para') && indentAvail(L) >= 4) {
      closeLeaf();
      consumeIndent(L, 4);
      S.leaf = addChild({ t: 'code', info: '', lines: [rest(L)], fenced: false, endLine: li, trailingNL: false });
      return true;
    }
    // table (block start: current line is the header, next is the delimiter)
    const al0 = nextLineDelimiterAligns();
    if (al0) {
      const head = splitTableRow(rest(L));
      if (head.length === al0.length) {
        closeLeaf();
        const tbl = addChild({ t: 'table', align: al0, head, rows: [] });
        S.stack.push(tbl);
        S.li++; // consume the delimiter line
        return true;
      }
    }
    // link reference definition (only at a true block start)
    if (!S.leaf || S.leaf.t !== 'para') {
      const def = tryLinkDef(L);
      if (def) {
        S.li += def.linesConsumed - 1;
        return true;
      }
    }
    // paragraph
    if (S.leaf && S.leaf.t === 'para') {
      if (paraPushLine(L, false) === 'ended') closeLeaf();
    } else {
      closeLeaf();
      S.leaf = addChild({ t: 'para', lines: [rest(L)], stripState: false, prevStripped: false, prevLazy: false, lastStripState: false });
    }
    return true;
  }

  // Resolve a pending HTML block's trailing newline from the current
  // line's post-container blankness: no trailing newline when the next
  // line is blank, a trailing newline otherwise.
  function resolvePendingHtml(blank) {
    if (S.pendingHtml) {
      S.pendingHtml.endedByBlank = blank;
      S.pendingHtml = null;
    }
  }

  for (S.li = 0; S.li < S.lines.length; S.li++) {
    const raw = S.lines[S.li];
    const L = cur(raw);

    // --- a raw blank line closes every open blockquote (and everything
    // inside it) but leaves lists open
    if (isBlankRest(L)) {
      const bd = outermostBqDepth();
      if (bd >= 0) closeTo(bd - 1);
    }

    // --- open leaf that consumes its own lines: fenced code
    // A fenced code block's content lines are consumed even when they
    // drop below a list item's indent (the fence protects them); but
    // a missing blockquote `>` ends the block (the line is outside it).
    if (S.leaf && S.leaf.t === 'code' && S.leaf.fenced) {
      const m = matchContainers(L);
      let bqFailed = false;
      if (m.failedAt >= 0 && S.stack[m.failedAt].t === 'bq') {
        closeTo(m.failedAt - 1);
        bqFailed = true; // fall through to normal processing below
      }
      if (!bqFailed && m.failedAt >= 0) {
        // list-item indent failure: the line is still code content
        // unless it is a closing fence at the raw line level
        const rawL = cur(raw);
        if (isBlankRest(rawL)) {
          consumeIndent(rawL, S.leaf.fenceIndent);
          expandLeadingTab(rawL, S.stack.length > 1);
          S.leaf.lines.push(rest(rawL));
          S.leaf.endLine = S.li;
          continue;
        }
        let closing = false;
        if (indentAvail(rawL) < 4) {
          const save = { i: rawL.i, col: rawL.col, pad: rawL.pad };
          consumeIndent(rawL, 3);
          const c = cch(rawL);
          if (c === S.leaf.fenceChar) {
            let n = 0;
            while (cch(rawL) === c) { cadv(rawL); n++; }
            if (n >= S.leaf.fenceLen) {
              let ok = true;
              while (cch(rawL) !== -1) { const d = cch(rawL); if (d !== SP && d !== TAB) { ok = false; break; } cadv(rawL); }
              if (ok) closing = true;
            }
          }
          if (!closing) { rawL.i = save.i; rawL.col = save.col; rawL.pad = save.pad; }
        }
        if (closing) {
          if (S.leaf.lines.length > 0 && S.leaf.lines[S.leaf.lines.length - 1] !== '') S.leaf.trailingNL = true;
          S.leaf.closedByFence = true;
          // the fence closes the block and its containers
          closeTo(m.failedAt - 1);
          closeLeaf();
          continue;
        }
        consumeIndent(rawL, S.leaf.fenceIndent);
        expandLeadingTab(rawL, S.stack.length > 1);
        S.leaf.lines.push(rest(rawL));
        S.leaf.endLine = S.li;
        continue;
      }
      if (!bqFailed) {
        // containers matched: check for a closing fence or content
        if (isBlankRest(L)) {
          // a blank line keeps its whitespace beyond the fence indent
          consumeIndent(L, S.leaf.fenceIndent);
          expandLeadingTab(L, S.stack.length > 1);
          S.leaf.lines.push(rest(L));
          S.leaf.endLine = S.li;
          continue;
        }
        let closing = false;
        if (indentAvail(L) < 4) {
          const save = { i: L.i, col: L.col, pad: L.pad };
          consumeIndent(L, 3);
          const c = cch(L);
          if (c === S.leaf.fenceChar) {
            let n = 0;
            while (cch(L) === c) { cadv(L); n++; }
            if (n >= S.leaf.fenceLen) {
              let ok = true;
              while (cch(L) !== -1) { const d = cch(L); if (d !== SP && d !== TAB) { ok = false; break; } cadv(L); }
              if (ok) closing = true;
            }
          }
          if (!closing) { L.i = save.i; L.col = save.col; L.pad = save.pad; }
        }
        if (closing) { if (S.leaf.lines.length > 0 && S.leaf.lines[S.leaf.lines.length - 1] !== '') S.leaf.trailingNL = true; S.leaf.closedByFence = true; closeLeaf(); continue; }
        consumeIndent(L, S.leaf.fenceIndent);
        expandLeadingTab(L, S.stack.length > 1);
        S.leaf.lines.push(rest(L));
        S.leaf.endLine = S.li;
        continue;
      }
      // bqFailed: the blockquote ended; fall through to normal processing
    }
    // --- indented code
    if (S.leaf && S.leaf.t === 'code' && !S.leaf.fenced) {
      const m = matchContainers(L);
      if (m.failedAt >= 0) {
        closeTo(m.failedAt - 1);
      } else {
        if (isBlankRest(L)) {
          // a blank line keeps its whitespace beyond the 4-column indent
          consumeIndent(L, 4);
          S.leaf.lines.push(rest(L));
          S.leaf.endLine = S.li;
          continue;
        }
        if (indentAvail(L) >= 4) {
          consumeIndent(L, 4);
          S.leaf.lines.push(rest(L));
          S.leaf.endLine = S.li;
          continue;
        }
        closeLeaf();
        // fall through
      }
    }
    // --- HTML block
    if (S.leaf && S.leaf.t === 'html') {
      const m = matchContainers(L);
      if (m.failedAt >= 0) {
        closeTo(m.failedAt - 1);
      } else {
        // types 6 and 7 end at a blank line; type 1 runs to its closing tag
        if ((S.leaf.htmlType === 6 || S.leaf.htmlType === 7) && isBlankRest(L)) {
          S.leaf.endedByBlank = true;
          closeLeaf();
          S.blankPending = true;
          S.blankBq = null; for (let d = S.stack.length - 1; d >= 1; d--) if (S.stack[d].t === 'bq') { S.blankBq = S.stack[d]; break; }
          continue;
        }
        const text = rest(L);
        S.leaf.lines.push(text);
        if (htmlBlockEnds(S.leaf.htmlType, text, S.leaf.htmlTag)) {
          S.leaf.endLine = S.li;
          const node = S.leaf;
          closeLeaf();
          S.pendingHtml = node; // decide the trailing newline on the next line
        }
        continue;
      }
    }

    // --- blank line
    if (isBlankRest(L)) {
      // marked keeps an HTML block's trailing newline unless the next
      // line is truly empty: a whitespace-only line (e.g. a tab) is
      // not empty for this purpose
      resolvePendingHtml(rest(L) === '');
      // a blank line ends a table
      while (S.stack.length > 1 && S.stack[S.stack.length - 1].t === 'table') S.stack.pop();
      closeLeaf();
      S.blankPending = true;
      S.blankBq = null; for (let d = S.stack.length - 1; d >= 1; d--) if (S.stack[d].t === 'bq') { S.blankBq = S.stack[d]; break; }
      continue;
    }

    // --- match containers
    const m = matchContainers(L);
    if (m.failedAt >= 0) {
      // a lazy line with no content after the matched containers is a
      // blank line, not a paragraph continuation
      // a line starting a list marker is never a lazy continuation:
      // the item closes and the marker starts a new list outside it
      let isListMarker = false;
      if (S.leaf && S.leaf.t === 'para' && !canInterruptPara(L) && !isBlankRest(L)) {
        const save = { i: L.i, col: L.col, pad: L.pad };
        isListMarker = listMarker(L) !== null;
        L.i = save.i; L.col = save.col; L.pad = save.pad;
      }
      if (S.leaf && S.leaf.t === 'para' && !canInterruptPara(L) && !isBlankRest(L) && !isListMarker) {
        resolvePendingHtml(false);
        paraPushLine(L, true); // lazy continuation
        continue;
      }
      closeTo(m.failedAt - 1);
    }
    // a line is blank here when nothing is left after the containers,
    // or when only whitespace is left and no paragraph is open: a
    // blockquote line like ">  " leaves a space that continues an open
    // paragraph, but does not start one
    if (rest(L) === '' || (isBlankRest(L) && !(S.leaf && S.leaf.t === 'para'))) {
      // see above: only a truly empty line drops the HTML block's
      // trailing newline
      resolvePendingHtml(rest(L) === '');
      closeLeaf();
      S.blankPending = true;
      S.blankBq = null; for (let d = S.stack.length - 1; d >= 1; d--) if (S.stack[d].t === 'bq') { S.blankBq = S.stack[d]; break; }
      continue;
    }
    resolvePendingHtml(false);

    // --- paragraph checks: setext, table
    if (S.leaf && S.leaf.t === 'para') {
      const sl = setextLevel(L);
      if (sl) {
        const parent = S.stack[S.stack.length - 1];
        const idx = parent.children.length - 1;
        const lines = S.leaf.lines;
        // find the last blank boundary (inserted after a stripped line)
        let bidx = -1;
        for (let i = lines.length - 1; i >= 0; i--) { if (lines[i] === '') { bidx = i; break; } }
        if (bidx >= 0 && !S.leaf.prevStripped) {
          // Setext applies to the last segment only; the earlier part
          // becomes its own paragraph (its last line was stripped).
          const first = lines.slice(0, bidx);
          const second = lines.slice(bidx + 1);
          parent.children[idx] = { t: 'para', lines: first, stripState: true, prevStripped: true, prevLazy: S.leaf.prevLazy, lastStripState: true };
          addChild({ t: 'h', level: sl, lines: second });
          S.leaf = null;
          continue;
        }
        if (!S.leaf.prevStripped) {
          parent.children[idx] = { t: 'h', level: sl, lines };
          S.leaf = null;
          continue;
        }
        // last line was stripped: setext does not apply; fall through
        // (--- becomes an hr, === becomes a paragraph continuation).
      }
      if (S.leaf.lines.length === 1) {
        const al = parseDelimiterRow(rest(L));
        if (al) {
          const head = splitTableRow(S.leaf.lines[0]);
          if (head.length === al.length) {
            const parent = S.stack[S.stack.length - 1];
            parent.children[parent.children.length - 1] = { t: 'table', align: al, head, rows: [] };
            S.stack.push(parent.children[parent.children.length - 1]);
            S.leaf = null;
            continue;
          }
        }
      }
      // (b) current line is a table header, next line the delimiter.
      // Only when the current line does not start another block.
      if (!startsBlock(L)) {
        const al = nextLineDelimiterAligns();
        if (al) {
          const head = splitTableRow(rest(L));
          if (head.length === al.length) {
            closeLeaf();
            const tbl = addChild({ t: 'table', align: al, head, rows: [] });
            S.stack.push(tbl);
            S.li++;
            continue;
          }
        }
      }
    }

    // --- table body rows
    if (S.stack.length > 0 && S.stack[S.stack.length - 1].t === 'table') {
      if (!startsBlock(L)) {
        S.stack[S.stack.length - 1].rows.push(splitTableRow(rest(L)));
        continue;
      }
      S.stack.pop();
    }

    // --- new block starts (paragraph continuation handled inside)
    startBlock(L);
  }

  // an HTML block that ended on the last line: trailing newline iff the
  // source ends with a newline
  if (S.pendingHtml) S.pendingHtml.endedByBlank = !S.endsNL;
  // a type 6/7 HTML block running to EOF gets a trailing newline only at
  // the top level when the source ends with one
  if (S.leaf && S.leaf.t === 'html' && (S.leaf.htmlType === 6 || S.leaf.htmlType === 7) &&
      S.leaf.endedByBlank === undefined && S.stack.length === 1 && S.endsNL) {
    S.leaf.endedByBlank = false;
  }
  closeTo(0);
  return { doc: S.doc, endsNL, refs: S.refs };
}

// ------------------------------------------------------------------ inline

// Inline node kinds: text, delim, code, link, image, html, entity, br,
// em, strong, del, autolink.

function isWSCode(c) {
  return c === SP || c === TAB || c === LF || c === CR || c === 11 || c === 12 || c === 160;
}
function isPunctCode(c) {
  if (c < 128) return isPunct(c);
  return PUNCT_RE.test(String.fromCharCode(c));
}
// Flanking info for a delimiter run in `s` spanning [a, b).
function flankInfo(s, a, b) {
  const before = a > 0 ? s.charCodeAt(a - 1) : -1;
  const after = b < s.length ? s.charCodeAt(b) : -1;
  // the beginning and the end of the line count as whitespace
  const beforeWS = before < 0 ? true : isWSCode(before);
  const afterWS = after < 0 ? true : isWSCode(after);
  const beforePunct = before < 0 ? false : isPunctCode(before);
  const afterPunct = after < 0 ? false : isPunctCode(after);
  const leftFlank = !afterWS && (!afterPunct || beforeWS || beforePunct);
  const rightFlank = !beforeWS && (!beforePunct || afterWS || afterPunct);
  return { before, after, leftFlank, rightFlank };
}

// Try to match an inline HTML tag / comment / PI / declaration / CDATA at
// `s[i]` ('<'). Returns the end index (exclusive) or -1.
function inlineHtmlEnd(s, i) {
  const n = s.length;
  if (i + 1 >= n) return -1;
  let j = i + 1;
  if (s.charCodeAt(j) === 33) { // !
    if (s.startsWith('!--', j)) {
      // <!--> and <!---> are valid (empty) comments ending at the '>'
      // (j points at '!', so the patterns omit the '<')
      if (s.startsWith('!-->', j)) return j + 4;
      if (s.startsWith('!--->', j)) return j + 5;
      const k = s.indexOf('-->', j + 3);
      return k >= 0 ? k + 3 : -1;
    }
    if (s.startsWith('![CDATA[', j)) {
      const k = s.indexOf(']]>', j + 8);
      return k >= 0 ? k + 3 : -1;
    }
    // declaration <!A...>
    j++;
    if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === 62) return j + 1; // >
      if (c === 60) return -1;
      j++;
    }
    return -1;
  }
  if (s.charCodeAt(j) === 63) { // ?
    const k = s.indexOf('?>', j + 1);
    return k >= 0 ? k + 2 : -1;
  }
  if (s.charCodeAt(j) === 47) { // /
    j++;
    if (j >= n || !isAlpha(s.charCodeAt(j))) return -1;
  } else if (!isAlpha(s.charCodeAt(j))) {
    return -1;
  }
  // tag name
  while (j < n) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === 45) j++;
    else break;
  }
  // after the tag name must come whitespace, '/', or '>'
  // (a newline is whitespace inside a tag)
  if (j < n) {
    const c = s.charCodeAt(j);
    if (c !== SP && c !== TAB && c !== LF && c !== CR && c !== 47 && c !== 62) return -1;
  }
  // attributes / self-closing, until > (CommonMark open-tag grammar)
  // An attribute is: whitespace+ name (whitespace* '=' whitespace* value)?.
  // A name starts with a letter, '_' or ':' and continues with letters,
  // digits, '_', '.', ':' or '-'. A closing tag takes no attributes.
  const isClose = s.charCodeAt(i + 1) === 47;
  if (isClose) {
    // closing tag: only whitespace then '>' may follow the name
    while (j < n && isWSCode(s.charCodeAt(j))) j++;
    return (j < n && s.charCodeAt(j) === 62) ? j + 1 : -1;
  }
  while (j < n) {
    // optional whitespace before an attribute or the end
    let k = j;
    while (k < n && isWSCode(s.charCodeAt(k))) k++;
    if (k >= n) return -1;
    const c = s.charCodeAt(k);
    if (c === 62) return k + 1; // >
    if (c === 47) { // / must be directly before >
      if (k + 1 < n && s.charCodeAt(k + 1) === 62) return k + 2;
      return -1;
    }
    // an attribute must start after whitespace
    if (k === j) return -1;
    j = k;
    // attribute name
    const nc = s.charCodeAt(j);
    if (!(isAlpha(nc) || nc === 95 || nc === 58)) return -1;
    j++;
    while (j < n) {
      const d = s.charCodeAt(j);
      if (isAlnum(d) || d === 95 || d === 46 || d === 58 || d === 45) j++;
      else break;
    }
    // optional whitespace, optional = value (do not consume the
    // separator whitespace when there is no '=')
    const wsSave = j;
    while (j < n && isWSCode(s.charCodeAt(j))) j++;
    if (j < n && s.charCodeAt(j) === 61) { // =
      j++;
      while (j < n && isWSCode(s.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = s.charCodeAt(j);
      if (q === 34 || q === 39) { // quoted value
        j++;
        while (j < n && s.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++; // closing quote
      } else { // unquoted value: no whitespace, ", ', =, <, >, `
        if (j < n) {
          const v = s.charCodeAt(j);
          if (isWSCode(v) || v === 34 || v === 39 || v === 61 || v === 60 || v === 62 || v === 96) return -1;
        }
        while (j < n) {
          const v = s.charCodeAt(j);
          if (isWSCode(v) || v === 34 || v === 39 || v === 61 || v === 60 || v === 62 || v === 96) break;
          j++;
        }
      }
    } else {
      j = wsSave; // no '=': leave the separator whitespace in place
    }
    // loop: next attribute (needs whitespace) or '>' or '/>'
  }
  return -1;
}

// Try to match an autolink <...> at `s[i]`. Returns {href, text, end} or null.
function tryAngleAutolink(s, i) {
  const n = s.length;
  let j = i + 1;
  // scheme: 2-32 chars, first alpha, rest alnum + - .
  let k = j;
  if (k < n && isAlpha(s.charCodeAt(k))) {
    k++;
    while (k < n && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === 45 || s.charCodeAt(k) === 46)) k++;
    if (k - j >= 2 && k - j <= 32 && k < n && s.charCodeAt(k) === 58) {
      // scheme found; rest until > with no space/control
      // (a backslash is allowed in a scheme autolink URL)
      let m = k + 1;
      while (m < n) {
        const c = s.charCodeAt(m);
        if (c === 62) {
          const inner = s.slice(j, m);
          return { href: inner, text: inner, end: m + 1 };
        }
        if (c === SP || c === LF || c < 32 || c === 60) return null;
        m++;
      }
      return null;
    }
  }
  // email: ...@... with no space/control/backslash, at least one dot
  // in domain
  let m = j;
  let at = -1, dotAfterAt = false;
  while (m < n) {
    const c = s.charCodeAt(m);
    if (c === 62) break;
    if (c === SP || c === LF || c < 32 || c === 60 || c === 92) return null;
    if (c === 64) at = m;
    else if (c === 46 && at >= 0) dotAfterAt = true;
    m++;
  }
  if (m < n && s.charCodeAt(m) === 62 && at > j && dotAfterAt) {
    const inner = s.slice(j, m);
    // email local part must be valid-ish: no leading/trailing dot issues
    // (marked is lenient here; require a dot after @ and text before @)
    return { href: 'mailto:' + inner, text: inner, end: m + 1 };
  }
  return null;
}

// Is `c` a character that may precede a GFM autolink?
function gfmBoundary(c) {
  if (c < 0) return true;
  if (isWSCode(c)) return true;
  // punctuation allows it; alphanumerics do not
  return isPunctCode(c);
}

// True when an `_` delimiter that can open emphasis is still waiting
// for a closer in this inline span: the most recent can-open `_`
// delim with no can-close `_` delim after it.
function hasOpenUnderscore(nodes) {
  let openIdx = -1;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    if (nd.t === 'delim' && nd.ch === 95 && nd.len > 0 && nd.canOpen) { openIdx = i; break; }
  }
  if (openIdx < 0) return false;
  for (let i = openIdx + 1; i < nodes.length; i++) {
    const nd = nodes[i];
    if (nd.t === 'delim' && nd.ch === 95 && nd.len > 0 && nd.canClose) return false;
  }
  return true;
}

// Try a GFM autolink (www. / scheme:// / email) at `s[i]`.
// `prev` is the char code before i (-1 at start). `nodes` is the flat
// node list scanned so far in this inline span (for the email/
// underscore-closer rule). Returns {href, text, end} or null.
function tryGfmAutolink(s, i, prev, nodes) {
  const n = s.length;
  if (!gfmBoundary(prev)) return null;
  // www. (lowercase only)
  if (s.startsWith('www.', i)) {
    const end = gfmUrlEnd(s, i);
    if (end > i + 4 && gfmHasDomain(s, i, end, i)) {
      const text = s.slice(i, end);
      return { href: 'http://' + text, text, end };
    }
    return null;
  }
  // Fast bail: a scheme or email autolink needs a ':' or '@' before the
  // next whitespace (within 40 chars). Ordinary words have neither, and
  // the full check below would scan them several times over.
  {
    let k = i;
    const lim = Math.min(n, i + 40);
    let hasTrigger = false;
    while (k < lim) {
      const cc = s.charCodeAt(k);
      if (cc === 58 || cc === 64) { hasTrigger = true; break; }
      if (isWSCode(cc) || cc === 60) break;
      k++;
    }
    if (!hasTrigger) return null;
  }
  // scheme:// (case-insensitive scheme, 1+ chars)
  if (isAlpha(s.charCodeAt(i))) {
    let k = i;
    while (k < n && (isAlnum(s.charCodeAt(k)) || s.charCodeAt(k) === 43 || s.charCodeAt(k) === 45 || s.charCodeAt(k) === 46)) k++;
    if (k > i && s.startsWith('://', k)) {
      const end = gfmUrlEnd(s, i);
      if (end > k + 3 && gfmHasDomain(s, i, end, k + 3)) {
        const text = s.slice(i, end);
        return { href: text, text, end };
      }
      return null;
    }
    // scheme: (mailto:, xmpp:, ...) — scheme + ':' + local@domain
    // optionally followed by a single /segment (e.g. a JID resource)
    if (k - i >= 2 && k - i <= 32 && k < n && s.charCodeAt(k) === 58) {
      const uriStart = k + 1;
      // a URI ending in '_' or '-' is not a valid scheme autolink
      let rawEnd = uriStart;
      while (rawEnd < n && !isWSCode(s.charCodeAt(rawEnd)) && s.charCodeAt(rawEnd) !== 60) rawEnd++;
      if (rawEnd > uriStart) {
        const lastC = s.charCodeAt(rawEnd - 1);
        if (lastC === 95 || lastC === 45) return null;
      }
      const end = gfmUrlEnd(s, uriStart);
      if (end > uriStart) {
        // find '@' in the URI (before any '/')
        let atPos = -1;
        for (let q = uriStart; q < end; q++) {
          if (s.charCodeAt(q) === 47) break;
          if (s.charCodeAt(q) === 64) { atPos = q; break; }
        }
        if (atPos > uriStart) {
          // domain runs from atPos+1 to the first '/' or end
          let domEnd = end;
          for (let q = atPos + 1; q < end; q++) {
            if (s.charCodeAt(q) === 47) { domEnd = q; break; }
          }
          if (gfmHasDomain(s, i, domEnd, atPos + 1, 1)) {
            // include at most one /segment after the domain
            let linkEnd = domEnd;
            if (domEnd < end && s.charCodeAt(domEnd) === 47) {
              let segEnd = domEnd + 1;
              while (segEnd < end && s.charCodeAt(segEnd) !== 47) segEnd++;
              // a segment must be non-empty; strip trailing punctuation
              if (segEnd > domEnd + 1) linkEnd = segEnd;
            }
            const text = s.slice(i, linkEnd);
            return { href: text, text, end: linkEnd };
          }
        }
      }
      return null;
    }
  }
  // email: local@domain.tld — local [A-Za-z0-9._+-]+ (marked 18),
  // then a domain per emailDomainEnd above
  {
    let k = i;
    // local part: alnum and . _ + - (must not be empty)
    let localLen = 0;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (isAlnum(c) || c === 46 || c === 95 || c === 43 || c === 45) { k++; localLen++; }
      else break;
    }
    if (localLen > 0 && k < n && s.charCodeAt(k) === 64) {
      const atPos = k;
      // domain run: alnum . - _
      let dEnd = atPos + 1;
      while (dEnd < n) {
        const c = s.charCodeAt(dEnd);
        if (isAlnum(c) || c === 46 || c === 45 || c === 95) dEnd++;
        else break;
      }
      // trailing underscores are the emphasis closer when an `_`
      // opener is waiting in this span (see hasOpenUnderscore);
      // marked's emphasis pass consumes them before the URL rule
      // sees the email, so trim them off the candidate first
      let runEnd = dEnd;
      if (runEnd > atPos + 1 && s.charCodeAt(runEnd - 1) === 95 && hasOpenUnderscore(nodes)) {
        while (runEnd > atPos + 1 && s.charCodeAt(runEnd - 1) === 95) runEnd--;
      }
      const end = emailDomainEnd(s, atPos, runEnd);
      if (end > 0) {
        const text = s.slice(i, end);
        return { href: 'mailto:' + text, text, end };
      }
    }
  }
  return null;
}

// Longest valid email-domain match in s[atPos+1..runEnd), per marked's
// email regex: first label [a-zA-Z0-9-_]+, then one or more dot-labels
// '.' [a-zA-Z0-9-_]* [a-zA-Z0-9]; the character after the match must
// not be a word character or '-'. Returns the end index, or -1.
function emailDomainEnd(s, atPos, runEnd) {
  let j = atPos + 1;
  while (j < runEnd && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 95 || s.charCodeAt(j) === 45)) j++;
  if (j === atPos + 1) return -1;
  let best = -1;
  while (j < runEnd && s.charCodeAt(j) === 46) {
    // dot-label: '.' [a-zA-Z0-9-_]* [a-zA-Z0-9]
    let m = j + 1;
    while (m < runEnd && (isAlnum(s.charCodeAt(m)) || s.charCodeAt(m) === 95 || s.charCodeAt(m) === 45)) m++;
    if (m === j + 1) break; // empty label
    // the label must end in an alphanumeric; backtrack over trailing _/-
    let e = m;
    while (e > j + 1 && !isAlnum(s.charCodeAt(e - 1))) e--;
    if (e === j + 1) break; // label has no alphanumeric at all
    const nx = e < runEnd ? s.charCodeAt(e) : -1;
    if (nx >= 0 && (isAlnum(nx) || nx === 95 || nx === 45)) break; // word char follows: no match here
    best = e;
    j = e; // a longer match with more labels may follow
  }
  return best;
}
function gfmUrlEnd(s, i) {
  const n = s.length;
  let k = i;
  while (k < n) {
    const c = s.charCodeAt(k);
    if (isWSCode(c) || c === 60) break;
    k++;
  }
  return gfmTrimEnd(s, i, k);
}

// Trim trailing punctuation from s[i..end): strip a trailing &...; entity
// whole, then ; : ? ! , . ~ * _ and unbalanced ')'.
function gfmTrimEnd(s, i, end) {
  while (end > i) {
    const c = s.charCodeAt(end - 1);
    if (c === 59) {
      // trailing &...; entity? strip the whole entity
      let j = end - 2;
      while (j >= i && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 35)) j--;
      if (j >= i && s.charCodeAt(j) === 38) { end = j; continue; }
      end--; continue;
    }
    if (c === 58 || c === 63 || c === 33 || c === 44 || c === 46 || c === 126 || c === 42 || c === 95) { end--; continue; }
    if (c === 41) {
      // keep ')' only when balanced within s[i..end)
      let depth = 0;
      for (let j = i; j < end; j++) {
        const d = s.charCodeAt(j);
        if (d === 40) depth++;
        else if (d === 41) depth--;
      }
      if (depth < 0) { end--; continue; }
      break;
    }
    break;
  }
  return end;
}

// Does s[i..end) contain a domain with a dot followed by 2+ letters?
function gfmHasDomain(s, i, end, hostStart, minTld) {
  // find the last dot in the host part (before any / ? #), starting
  // the search at hostStart (past any scheme:// or local@)
  let hostEnd = end;
  for (let j = hostStart; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 47 || c === 63 || c === 35) { hostEnd = j; break; }
  }
  // TLD dot: the last dot followed by at least one letter (a trailing
  // dot, as in `img.shields.io.\`, is not a TLD dot)
  let lastDot = -1, tldLen = 0;
  for (let j = hostEnd - 1; j >= hostStart; j--) {
    if (s.charCodeAt(j) !== 46) continue;
    let len = 0;
    for (let k = j + 1; k < hostEnd; k++) {
      if (isAlpha(s.charCodeAt(k))) len++;
      else break;
    }
    if (len > 0) { lastDot = j; tldLen = len; break; }
  }
  if (lastDot < 0) return false;
  // TLD: minTld+ letters right after the TLD dot; a non-letter ends
  // the TLD (it starts the path/query, e.g. `www.foo.com\` or
  // `www.foo.com:8080`) — it does not invalidate the domain
  return tldLen >= (minTld || 2);
}

// Find the link text starting at s[i] === '['. Returns {text, end}
// (end just past the matching ']') or null.
function parseLinkText(s, i) {
  const n = s.length;
  let depth = 0;
  let j = i;
  while (j < n) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < n) { j += 2; continue; }
    if (c === 96) {
      let run = 0;
      while (j + run < n && s.charCodeAt(j + run) === 96) run++;
      let k = j + run, found = -1;
      while (k < n) {
        if (s.charCodeAt(k) === 96) {
          let r2 = 0;
          while (k + r2 < n && s.charCodeAt(k + r2) === 96) r2++;
          if (r2 === run) { found = k; break; }
          k += r2;
        } else k++;
      }
      if (found < 0) return null;
      j = found + run;
      continue;
    }
    if (c === 60) { // < — skip an inline HTML tag or an autolink
      // (a `]` inside a quoted attribute value or an autolink URL
      // must not end the link text)
      const tagEnd = inlineHtmlEnd(s, j);
      if (tagEnd > 0) { j = tagEnd; continue; }
      // autolink <scheme:...> or <email>: ends at the first '>' with
      // no '<' or whitespace before it
      let k = j + 1, ok = false, hasMark = false;
      while (k < n) {
        const d = s.charCodeAt(k);
        if (d === 62) { ok = hasMark; break; }
        if (d === 60 || isWSCode(d)) break;
        if (d === 58 || d === 64) hasMark = true;
        k++;
      }
      if (ok) { j = k + 1; continue; }
    }
    if (c === 91) depth++;
    else if (c === 93) {
      depth--;
      if (depth === 0) return { text: s.slice(i + 1, j), end: j + 1 };
    }
    j++;
  }
  return null;
}

// Parse (dest "title") starting at s[i] === '('. Returns {dest, title, end}
// (end just past ')') or null.
function parseInlineLink(s, i) {
  const n = s.length;
  let j = i + 1;
  while (j < n && (s.charCodeAt(j) === SP || s.charCodeAt(j) === TAB || s.charCodeAt(j) === LF)) j++;
  if (j >= n) return null;
  let dest = '';
  if (s.charCodeAt(j) === 60) {
    j++;
    const ds = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === LF) return null;
      if (c === 92 && j + 1 < n) { j += 2; continue; }
      if (c === 60) return null;
      if (c === 62) break;
      j++;
    }
    if (j >= n) return null;
    dest = s.slice(ds, j);
    j++;
  } else {
    const ds = j;
    let depth = 0;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (c === SP || c === TAB || c === LF) break;
      if (c < 32) return null;
      if (c === 92 && j + 1 < n && isAsciiPunct(s.charCodeAt(j + 1))) { j += 2; continue; }
      if (c === 40) depth++;
      else if (c === 41) {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    dest = s.slice(ds, j); // may be empty: [link]() is a valid empty link
  }
  let k = j;
  while (k < n && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB || s.charCodeAt(k) === LF)) k++;
  let title = null;
  if (k < n) {
    const c = s.charCodeAt(k);
    if (c === 34 || c === 39) {
      const q = c;
      k++;
      const ts = k;
      let closed = false;
      while (k < n) {
        const d = s.charCodeAt(k);
        if (d === 92 && k + 1 < n) { k += 2; continue; }
        if (d === q) { closed = true; break; }
        k++;
      }
      if (!closed) return null;
      title = s.slice(ts, k);
      k++;
    } else if (c === 40) {
      k++;
      const ts = k;
      let dep = 1, closed = false;
      while (k < n) {
        const d = s.charCodeAt(k);
        if (d === 92 && k + 1 < n) { k += 2; continue; }
        if (d === 40) dep++;
        else if (d === 41) { dep--; if (dep === 0) { closed = true; break; } }
        k++;
      }
      if (!closed) return null;
      title = s.slice(ts, k);
      k++;
    }
    while (k < n && (s.charCodeAt(k) === SP || s.charCodeAt(k) === TAB || s.charCodeAt(k) === LF)) k++;
  }
  if (k >= n || s.charCodeAt(k) !== 41) return null;
  return { dest, title, end: k + 1 };
}

// Try to match an entity at s[i] === '&'. Returns {node, end} or null.
function tryEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  if (s.charCodeAt(i + 1) === 35) {
    let j = i + 2;
    let hex = false;
    if (j < n && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const ds = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? isHex(c) : isDigit(c)) j++;
      else break;
    }
    if (j > ds && j < n && s.charCodeAt(j) === 59) {
      let cp = hex ? parseInt(s.slice(ds, j), 16) : parseInt(s.slice(ds, j), 10);
      if (cp > 0x10FFFF) return null; // out of range: not an entity at all
      if (!cp || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
      return { node: { t: 'text', s: String.fromCodePoint(cp) }, end: j + 1 };
    }
    return null;
  }
  let j = i + 1;
  while (j < n && (isAlnum(s.charCodeAt(j)) || s.charCodeAt(j) === 95)) j++;
  if (j > i + 1 && j < n && s.charCodeAt(j) === 59) {
    return { node: { t: 'entity', s: s.slice(i, j + 1) }, end: j + 1 };
  }
  return null;
}

// Document-level inline-lexer state, reset per parse() call. Mirrors
// marked: an inline `<a ...>` tag sets inLink (cleared by `</a>`), and
// while inLink is set, bare GFM autolinks (www. / scheme:// / email)
// are not created — so one unclosed multi-line `<a>` tag suppresses
// every later bare autolink in the document (doc-03). HTML blocks never
// reach scanInline, so tags inside them do not toggle this.
let inlineState = { inLink: false, inRawBlock: false };

// Scan link/image text the way marked does: inLink is forced on while
// scanning (bare autolinks inside link text never form) and the
// document-level flags are restored afterwards, so a tag inside link
// text does not leak into the rest of the document.
function scanLinkText(text, refs) {
  const savedLink = inlineState.inLink, savedRaw = inlineState.inRawBlock;
  inlineState.inLink = true;
  const nodes = scanInline(text, refs);
  inlineState.inLink = savedLink;
  inlineState.inRawBlock = savedRaw;
  return nodes;
}

// Scan inline text into a flat node list.
function scanInline(s, refs) {
  const nodes = [];
  let textBuf = '';
  const flushText = () => { if (textBuf) { nodes.push({ t: 'text', s: textBuf }); textBuf = ''; } };
  const pushText = (str) => { textBuf += str; };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === LF) {
      let sp = 0;
      for (let k = textBuf.length - 1; k >= 0; k--) {
        const d = textBuf.charCodeAt(k);
        if (d === SP || d === TAB) sp++;
        else break;
      }
      if (sp >= 2) {
        textBuf = textBuf.slice(0, textBuf.length - sp);
        flushText();
        nodes.push({ t: 'br' });
        // a hard break swallows the next line's leading spaces
        i++;
        while (i < n && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB)) i++;
        continue;
      } else {
        pushText('\n');
      }
      i++;
      continue;
    }
    if (c === 92) {
      if (i + 1 < n) {
        const d = s.charCodeAt(i + 1);
        if (d === LF) {
          flushText();
          nodes.push({ t: 'br' });
          i += 2;
          // a hard break swallows the next line's leading spaces
          while (i < n && (s.charCodeAt(i) === SP || s.charCodeAt(i) === TAB)) i++;
          continue;
        }
        if (isAsciiPunct(d)) {
          // an escaped & must not merge with following text into an
          // entity: push it already escaped
          pushText(d === 38 ? '&amp;' : String.fromCharCode(d));
          i += 2; continue;
        }
      }
      pushText('\\');
      i++;
      continue;
    }
    if (c === 96) {
      let run = 0;
      while (i + run < n && s.charCodeAt(i + run) === 96) run++;
      let j = i + run, found = -1;
      while (j < n) {
        if (s.charCodeAt(j) === 96) {
          let r2 = 0;
          while (j + r2 < n && s.charCodeAt(j + r2) === 96) r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else j++;
      }
      if (found >= 0) {
        let content = s.slice(i + run, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === SP && content.charCodeAt(content.length - 1) === SP && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        flushText();
        nodes.push({ t: 'code', s: content });
        i = found + run;
        continue;
      }
      pushText(s.slice(i, i + run));
      i += run;
      continue;
    }
    if (c === 42 || c === 95 || c === 126) {
      let run = 0;
      while (i + run < n && s.charCodeAt(i + run) === c) run++;
      // strikethrough needs exactly 1 or 2 tildes; a run of 3+ is
      // literal text, never a delimiter
      if (c === 126 && run >= 3) {
        pushText(s.slice(i, i + run));
        i += run;
        continue;
      }
      const fi = flankInfo(s, i, i + run);
      let canOpen, canClose;
      if (c === 95) {
        canOpen = fi.leftFlank && (!fi.rightFlank || (fi.before >= 0 && isPunctCode(fi.before)));
        canClose = fi.rightFlank && (!fi.leftFlank || (fi.after >= 0 && isPunctCode(fi.after)));
      } else {
        canOpen = fi.leftFlank;
        canClose = fi.rightFlank;
      }
      flushText();
      nodes.push({ t: 'delim', ch: c, len: run, canOpen, canClose });
      i += run;
      continue;
    }
    if (c === 60) {
      const al = tryAngleAutolink(s, i);
      if (al) {
        flushText();
        // explicit <...> autolink: may nest inside a link's text
        nodes.push({ t: 'autolink', href: al.href, text: al.text, explicit: true });
        i = al.end;
        continue;
      }
      const he = inlineHtmlEnd(s, i);
      if (he > 0) {
        flushText();
        // marked's tag rule toggles the document-level inLink flag:
        // `<a ` (with a space) opens it, `</a>` closes it
        const tagText = s.slice(i, he);
        if (/^<a /i.test(tagText)) inlineState.inLink = true;
        else if (/^<\/a>/i.test(tagText)) inlineState.inLink = false;
        nodes.push({ t: 'html', s: tagText });
        i = he;
        continue;
      }
      pushText('<');
      i++;
      continue;
    }
    if (c === 38) {
      const ent = tryEntity(s, i);
      if (ent) {
        flushText();
        nodes.push(ent.node);
        i = ent.end;
        continue;
      }
      pushText('&');
      i++;
      continue;
    }
    if (c === 91 || (c === 33 && i + 1 < n && s.charCodeAt(i + 1) === 91)) {
      const isImage = c === 33;
      const bracketPos = isImage ? i + 1 : i;
      const lt = parseLinkText(s, bracketPos);
      if (lt) {
        let j = lt.end;
        let done = false;
        if (j < n && s.charCodeAt(j) === 40) {
          const il = parseInlineLink(s, j);
          if (il) {
            flushText();
            const children = scanLinkText(lt.text, refs);
            resolveEmphasis(children);
            if (isImage) {
              nodes.push({ t: 'image', src: il.dest, title: il.title, alt: plainText(children) });
            } else if (!containsLink(children)) {
              downgradeGfmAutolinks(children);
              nodes.push({ t: 'link', href: il.dest, title: il.title, children });
            } else {
              // a link cannot contain another link: treat '[' as literal
              pushText('[');
              i = bracketPos + 1;
              continue;
            }
            i = il.end;
            done = true;
          }
          // on failure the inline link is not formed; fall through to
          // try a reference (shortcut) link with the same text
        }
        if (!done) {
          let refLabel = null;
          let refEnd = j;
          if (j < n && s.charCodeAt(j) === 91) {
            const lt2 = parseLinkText(s, j);
            if (lt2) {
              refLabel = lt2.text === '' ? lt.text : lt2.text;
              refEnd = lt2.end;
            }
          } else {
            // shortcut: the text itself is the label (this also covers
            // a '(' that followed ']' but failed as an inline link)
            refLabel = lt.text;
          }
          // a label may not contain an unescaped '['
          if (refLabel !== null && labelHasBracket(refLabel)) refLabel = null;
          if (refLabel !== null) {
            const norm = normalizeLabel(refLabel);
            const ref = norm ? refs.get(norm) : undefined;
            if (ref) {
              flushText();
              const children = scanLinkText(lt.text, refs);
              resolveEmphasis(children);
              if (isImage) {
                nodes.push({ t: 'image', src: ref.dest, title: ref.title, alt: plainText(children) });
              } else if (!containsLink(children)) {
                downgradeGfmAutolinks(children);
                nodes.push({ t: 'link', href: ref.dest, title: ref.title, children });
              } else {
                pushText('[');
                i = bracketPos + 1;
                continue;
              }
              i = refEnd;
              done = true;
            }
          }
        }
        if (done) continue;
      }
      if (isImage) { pushText('!'); i++; continue; }
      pushText('[');
      i++;
      continue;
    }
    // GFM autolink (www. / scheme:// / email); an email local part may
    // start with a digit, '.', '_', '%', '+' or '-'. Suppressed while
    // the document-level inLink flag is set (see inlineState above).
    if (isAlnum(c) || c === 46 || c === 95 || c === 37 || c === 43 || c === 45) {
      const prev = i > 0 ? s.charCodeAt(i - 1) : -1;
      const g = inlineState.inLink ? null : tryGfmAutolink(s, i, prev, nodes);
      if (g) {
        flushText();
        nodes.push({ t: 'autolink', href: g.href, text: g.text });
        i = g.end;
        continue;
      }
      // Not an autolink: bulk-slice the rest of this word in one go
      // instead of stepping through it one char at a time. Only plain
      // word characters are consumed (alphanumeric plus '.', '%', '+',
      // '-'); anything else — whitespace, punctuation, '_' (emphasis),
      // or a character that can start an inline construct — stops the
      // slice, so the next word start still gets its autolink check.
      let j = i + 1;
      while (j < n) {
        const cc = s.charCodeAt(j);
        if (!(isAlnum(cc) || cc === 46 || cc === 37 || cc === 43 || cc === 45)) break;
        j++;
      }
      pushText(s.slice(i, j));
      i = j;
      continue;
    }
    pushText(s[i]);
    i++;
  }
  flushText();
  return nodes;
}

// Resolve emphasis / strong / strikethrough in a flat node list.
// Mutates `nodes` in place.
function resolveEmphasis(nodes) {
  let delims = [];
  const rebuild = () => {
    delims = [];
    for (let i = 0; i < nodes.length; i++) {
      if (nodes[i].t === 'delim') delims.push({ idx: i, node: nodes[i] });
    }
  };
  rebuild();
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    const cnode = closer.node;
    if (!cnode.canClose || cnode.len <= 0) { ci++; continue; }
    let oi = ci - 1;
    let found = -1;
    while (oi >= 0) {
      const opener = delims[oi];
      const onode = opener.node;
      if (onode.ch === cnode.ch && onode.canOpen && onode.len > 0) {
        const eitherBoth = onode.canClose || cnode.canOpen;
        const oddMatch = eitherBoth &&
          ((onode.len + cnode.len) % 3 === 0) &&
          (onode.len % 3 !== 0 || cnode.len % 3 !== 0);
        if (!oddMatch) { found = oi; break; }
      }
      oi--;
    }
    if (found < 0) { ci++; continue; }
    const opener = delims[found];
    const onode = opener.node;
    const use = (onode.len >= 2 && cnode.len >= 2) ? 2 : 1;
    const type = cnode.ch === 126 ? 'del' : (use === 2 ? 'strong' : 'em');
    const children = nodes.slice(opener.idx + 1, closer.idx);
    const newNode = { t: type, children };
    onode.len -= use;
    cnode.len -= use;
    const before = nodes.slice(0, opener.idx);
    const after = nodes.slice(closer.idx + 1);
    const mid = [];
    if (onode.len > 0) mid.push(onode);
    mid.push(newNode);
    if (cnode.len > 0) mid.push(cnode);
    nodes.length = 0;
    nodes.push(...before, ...mid, ...after);
    rebuild();
    // A match can unblock earlier pairs (lengths changed), so rescan.
    ci = 0;
  }
}

// Plain text content of inline nodes (for image alt text).
function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'entity' || nd.t === 'code') out += nd.s;
    else if (nd.t === 'delim') out += String.fromCharCode(nd.ch).repeat(nd.len);
    else if (nd.t === 'br') out += '\n';
    else if (nd.t === 'image') out += nd.alt;
    else if (nd.children) out += plainText(nd.children);
    else if (nd.t === 'autolink') out += nd.text;
    else if (nd.t === 'html') out += nd.s;
  }
  return out;
}

// Does any node in `nodes` (recursively) contain a link? A link's text
// cannot itself contain a link. Autolinks do not block: an explicit
// <...> autolink nests inside a link, and a bare GFM autolink inside
// link text is downgraded to plain text (see downgradeGfmAutolinks).
function containsLink(nodes) {
  for (const nd of nodes) {
    if (nd.t === 'link') return true;
    if (nd.children && containsLink(nd.children)) return true;
  }
  return false;
}

// A bare GFM autolink inside a link's text is not a link at all: turn
// such nodes (recursively) into plain text. Explicit <...> autolinks
// keep their link.
function downgradeGfmAutolinks(nodes) {
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t === 'autolink' && !nd.explicit) nodes[k] = { t: 'text', s: nd.text };
    else if (nd.children) downgradeGfmAutolinks(nd.children);
  }
}

// Render inline nodes to HTML.
function renderInline(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += esc(nd.s); break;
      case 'entity': out += nd.s; break;
      case 'delim': out += String.fromCharCode(nd.ch).repeat(nd.len); break;
      case 'code': out += '<code>' + escAll(nd.s) + '</code>'; break;
      case 'br': out += '<br>'; break;
      case 'html': out += nd.s; break;
      case 'em': out += '<em>' + renderInline(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInline(nd.children) + '</strong>'; break;
      case 'del': out += '<del>' + renderInline(nd.children) + '</del>'; break;
      case 'autolink': out += '<a href="' + esc(cleanUrl(nd.href)) + '">' + esc(nd.text) + '</a>'; break;
      case 'link': {
        out += '<a href="' + esc(cleanUrl(unescapeStr(nd.href)));
        if (nd.title !== null && nd.title !== undefined && nd.title !== '') out += '" title="' + esc(unescapeStr(nd.title));
        out += '">' + renderInline(nd.children) + '</a>';
        break;
      }
      case 'image': {
        out += '<img src="' + esc(cleanUrl(unescapeStr(nd.src))) + '" alt="' + esc(nd.alt);
        if (nd.title !== null && nd.title !== undefined && nd.title !== '') out += '" title="' + esc(unescapeStr(nd.title));
        out += '">';
        break;
      }
    }
  }
  return out;
}

// Parse inline text to HTML.
function inlineToHtml(text, refs) {
  const nodes = scanInline(text, refs);
  resolveEmphasis(nodes);
  return renderInline(nodes);
}

// ------------------------------------------------------------------ block rendering

function renderChildren(children, refs, inContainer) {
  let out = '';
  for (let i = 0; i < children.length; i++) {
    const nd = children[i];
    const next = i + 1 < children.length ? children[i + 1] : null;
    out += renderBlock(nd, refs, inContainer, next);
  }
  return out;
}

function renderBlock(nd, refs, inContainer, next) {
  switch (nd.t) {
    case 'doc': return renderChildren(nd.children, refs, false);
    case 'para': {
      let text = nd.lines.join('\n');
      // trailing newline after a stripped line when followed by a block
      // inside the same container (not after a blank line, not at the end)
      if (inContainer && nd.lastStripState && next && !next.blankBefore) text += '\n';
      return '<p>' + inlineToHtml(text, refs) + '</p>\n';
    }
    case 'h': {
      const text = inlineToHtml(nd.lines.join('\n').trim(), refs);
      return '<h' + nd.level + '>' + text + '</h' + nd.level + '>\n';
    }
    case 'hr': return '<hr>\n';
    case 'code': {
      const info = nd.info ? ' class="language-' + esc(unescapeStr(nd.info.split(/\s+/)[0])) + '"' : '';
      let content = nd.lines.join('\n');
      if (nd.trailingNL) content += '\n';
      return '<pre><code' + info + '>' + escAll(content) + '</code></pre>\n';
    }
    case 'html': {
      let text = nd.lines.join('\n');
      if (!nd.endedByBlank) text += '\n';
      return text;
    }
    case 'bq': {
      return '<blockquote>\n' + renderChildren(nd.children, refs, true) + '</blockquote>\n';
    }
    case 'list': {
      const tag = nd.ordered ? 'ol' : 'ul';
      let attrs = '';
      if (nd.ordered && nd.start !== 1) attrs = ' start="' + nd.start + '"';
      let out = '<' + tag + attrs + '>\n';
      for (const item of nd.children) {
        out += '<li>';
        out += renderItem(item, refs, nd.tight);
        out += '</li>\n';
      }
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < nd.head.length; c++) {
        const al = nd.align[c];
        out += '<th' + (al ? ' align="' + al + '"' : '') + '>' + inlineToHtml(nd.head[c], refs) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (nd.rows.length > 0) {
        out += '<tbody>';
        for (const row of nd.rows) {
          out += '<tr>\n';
          for (let c = 0; c < nd.head.length; c++) {
            const al = nd.align[c];
            const cell = c < row.length ? row[c] : '';
            out += '<td' + (al ? ' align="' + al + '"' : '') + '>' + inlineToHtml(cell, refs) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default: return '';
  }
}

// Render a list item's children. In a tight list the first paragraph (if
// it is the first child) renders without <p> tags.
// Detect a GFM task-list marker at the start of a paragraph. Returns
// {checked, skip} where `skip` is the number of chars to drop from the
// paragraph's joined text, or null.
function taskInfo(nd) {
  if (nd.t !== 'para' || !nd.lines.length) return null;
  const first = nd.lines[0];
  let p = 0;
  while (p < first.length && (first.charCodeAt(p) === SP || first.charCodeAt(p) === TAB)) p++;
  if (first.charCodeAt(p) !== 91) return null; // [
  const c1 = first.charCodeAt(p + 1);
  if (c1 !== SP && c1 !== 120 && c1 !== 88) return null; // ' ', 'x', 'X'
  if (first.charCodeAt(p + 2) !== 93) return null; // ]
  if (p + 3 >= first.length || (first.charCodeAt(p + 3) !== SP && first.charCodeAt(p + 3) !== TAB)) return null;
  // skip only the 3 marker chars; the space after `]` stays as the
  // paragraph's leading space (it separates the checkbox from the text)
  let skip = p + 3;
  const checked = c1 === 120 || c1 === 88;
  return { checked, skip };
}

function renderItem(item, refs, tight) {
  let out = '';
  const kids = item.children;
  for (let i = 0; i < kids.length; i++) {
    const nd = kids[i];
    const next = i + 1 < kids.length ? kids[i + 1] : null;
    if (i === 0) {
      const task = taskInfo(nd);
      if (task) {
        const box = task.checked
          ? '<input checked="" disabled="" type="checkbox">'
          : '<input disabled="" type="checkbox">';
        let text = nd.lines.join('\n');
        // drop the marker (first line only): rebuild from the first
        // line with `skip` chars removed
        text = nd.lines[0].slice(task.skip) + (nd.lines.length > 1 ? '\n' + nd.lines.slice(1).join('\n') : '');
        if (nd.lastStripState && next && !next.blankBefore) text += '\n';
        if (tight) {
          out += box + inlineToHtml(text, refs);
        } else {
          out += '<p>' + box + inlineToHtml(text, refs) + '</p>\n';
        }
        continue;
      }
    }
    // In a tight list every paragraph renders bare (no <p> tags), not
    // just the first one: a paragraph after a heading is bare too.
    if (tight && nd.t === 'para') {
      let text = nd.lines.join('\n');
      if (nd.lastStripState && next && !next.blankBefore) text += '\n';
      out += inlineToHtml(text, refs);
    } else {
      out += renderBlock(nd, refs, true, next);
    }
  }
  return out;
}

// ------------------------------------------------------------------ entry point

export function parse(markdown) {
  // fresh document-level inline state (inLink / inRawBlock)
  inlineState = { inLink: false, inRawBlock: false };
  const { doc, refs } = parseBlocks(markdown);
  return renderBlock(doc, refs, false, null);
}
