// parse.js — from-scratch CommonMark 0.31.2 + GFM 0.29 parser.
// Returns exactly the HTML marked 18.1.3 returns with default options
// (GFM on, async off). No dependencies, no network, deterministic.

export function parse(markdown) {
  const doc = parseBlocks(markdown);
  finalizeInline(doc, doc.links);
  return renderDocument(doc);
}

// ---------------------------------------------------------------------------
// Text escaping
// ---------------------------------------------------------------------------

// Plain text: escape &, <, > only (quotes stay literal in text).
function escapeText(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = entityLikeAt(s, i) ? null : '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Code spans / code blocks: escape all five, including every &.
function escapeCode(s) {
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
    if (rep) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// Attribute values (href, title, alt): escape all five, with the
// entity-like & left alone (the reference passes through raw).
function escapeAttr(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = entityLikeAt(s, i) ? null : '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep) {
      if (i > start) out += s.slice(start, i);
      out += rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// True when s[i] === '&' and an entity-like reference follows:
// &# up to 7 decimal digits, &#x up to 6 hex digits, or a word, then ';'.
// marked leaves such an & unescaped (the reference passes through raw).
function entityLikeAt(s, i) {
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    let hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const max = hex ? 6 : 7;
    let n = 0;
    while (j < s.length && n < max) {
      const c = s.charCodeAt(j);
      const ok = hex
        ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
        : c >= 48 && c <= 57;
      if (!ok) break;
      j++; n++;
    }
    if (n === 0) return false;
    return j < s.length && s[j] === ';';
  }
  let n = 0;
  while (j < s.length && n < 40) {
    const c = s.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) || c === 95)) break;
    j++; n++;
  }
  if (n === 0) return false;
  return j < s.length && s[j] === ';';
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}
function isAsciiPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}
function isAlnum(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
  );
}
function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}
function isBlankLine(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ' ' && s[i] !== '\t') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entities (HTML5 named character references, common + spec-tested subset)
// ---------------------------------------------------------------------------

// Try to decode a NUMERIC character reference at s[i] === '&'.
// marked decodes numeric references only; named ones pass through raw.
// Returns {text, len} or null. At most 7 decimal / 6 hex digits; a value
// of 0, a surrogate, or above U+10FFFF becomes U+FFFD.
function decodeEntityAt(s, i) {
  if (s[i] !== '&' || s[i + 1] !== '#') return null;
  let j = i + 2;
  let hex = false;
  if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
  const start = j;
  const max = hex ? 6 : 7;
  while (j < s.length && j - start < max) {
    const c = s.charCodeAt(j);
    const ok = hex
      ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
      : c >= 48 && c <= 57;
    if (!ok) break;
    j++;
  }
  if (j === start || j >= s.length || s[j] !== ';') return null;
  const num = parseInt(s.slice(start, j), hex ? 16 : 10);
  const cp = num === 0 || num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)
    ? 0xfffd : num;
  return { text: String.fromCodePoint(cp), len: j - i + 1 };
}

// Normalize a link label: case-fold, collapse whitespace, trim.
function normalizeLabel(label) {
  // Full case folding for the cases that matter: ß/ẞ fold to "ss"
  // (ẞ lowercases to ß first), so [ẞ] matches a [SS] definition.
  return label.replace(/\s+/g, ' ').trim().toLowerCase()
    .replace(/ß/g, 'ss');
}

// True when s contains an unescaped '[' (a backslash-escaped one does
// not count). Reference labels may not contain '[' at all.
function hasUnescapedBracket(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '[') {
      let bs = 0;
      for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) bs++;
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

// marked's cleanUrl: encodeURI, then un-escape %25 back to %.
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// Resolve backslash escapes in a link destination/title: \ + ASCII punct -> punct.
function unescapeBackslashes(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      if (i > start) out += s.slice(start, i);
      out += s[i + 1];
      i++;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}

// ---------------------------------------------------------------------------
// Line cursor: column-aware, with partial-tab support.
// A tab at column c spans to the next multiple of 4. When we consume only
// part of a tab (e.g. the one optional space after '>'), the tab stays in
// place with a reduced remaining width (tabRem).
// ---------------------------------------------------------------------------

function makeCursor(s) {
  return { s, pos: 0, col: 0, tabRem: 0 };
}
function curChar(c) {
  return c.pos < c.s.length ? c.s[c.pos] : '';
}
function curWidth(c) {
  const ch = curChar(c);
  if (ch === '\t') return c.tabRem || (4 - (c.col % 4));
  return ch ? 1 : 0;
}
// Advance by n columns (may partially consume a tab).
function curAdvance(c, n) {
  while (n > 0 && c.pos < c.s.length) {
    const ch = c.s[c.pos];
    if (ch === '\t') {
      const w = c.tabRem || (4 - (c.col % 4));
      if (n < w) { c.tabRem = w - n; c.col += n; return; }
      c.col += w; c.pos++; c.tabRem = 0; n -= w;
    } else {
      c.pos++; c.col++; n--;
    }
  }
}
// Advance past one whole character.
function curAdvanceChar(c) {
  const ch = curChar(c);
  if (ch === '\t') {
    c.col += c.tabRem || (4 - (c.col % 4));
    c.pos++; c.tabRem = 0;
  } else if (ch) {
    c.pos++; c.col++;
  }
}
// Columns of leading whitespace from the cursor (spaces/tabs), not consuming.
function curIndent(c) {
  let col = c.col;
  let p = c.pos;
  let tabRem = c.tabRem;
  while (p < c.s.length) {
    const ch = c.s[p];
    if (ch === ' ') { col++; p++; }
    else if (ch === '\t') {
      const w = tabRem || (4 - (col % 4));
      col += w; p++; tabRem = 0;
    } else break;
  }
  return col - c.col;
}
// Skip up to n columns of spaces/tabs. Returns columns actually skipped.
function curSkipSpaces(c, n) {
  const before = c.col;
  let skipped = 0;
  while (skipped < n && c.pos < c.s.length) {
    const ch = c.s[c.pos];
    if (ch === ' ') { c.pos++; c.col++; skipped++; }
    else if (ch === '\t') {
      const w = c.tabRem || (4 - (c.col % 4));
      if (skipped + w > n) { c.tabRem = w - (n - skipped); c.col += n - skipped; return n; }
      c.col += w; c.pos++; c.tabRem = 0; skipped += w;
    } else break;
  }
  return c.col - before;
}
// The remaining text of the line from the cursor (raw, tabs intact).
function curRest(c) {
  return c.s.slice(c.pos);
}
// The remaining text with a partially-consumed tab at the cursor expanded
// to its remaining width in spaces (what the content actually is).
function curText(c) {
  if (c.tabRem > 0) return ' '.repeat(c.tabRem) + c.s.slice(c.pos + 1);
  return c.s.slice(c.pos);
}
// A copy of the cursor advanced by n columns.
function curAfter(c, n) {
  const copy = { s: c.s, pos: c.pos, col: c.col, tabRem: c.tabRem };
  curAdvance(copy, n);
  return copy;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const BLOCK_TAGS_6 = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'section',
  'source', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]);

function isContainer(node) {
  return node.type === 'blockquote' || node.type === 'list' ||
    node.type === 'item' || node.type === 'document';
}

function parseBlocks(src) {
  src = src.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  // A trailing newline does not make an extra empty line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const root = { type: 'document', children: [] };
  const st = {
    lines, i: 0, stack: [root],
    links: Object.create(null),
    blankPending: false,
    pendingBlanks: [],
    endsWithNewline: src.endsWith('\n'),
  };
  while (st.i < lines.length) {
    processLine(st);
  }
  while (st.stack.length > 1) {
    closeBlock(st, st.stack.pop());
  }
  root.links = st.links;
  root.endsWithNewline = st.endsWithNewline;
  return root;
}

function tip(st) {
  return st.stack[st.stack.length - 1];
}

function addBlock(st, node) {
  node.blankBefore = st.blankPending;
  st.blankPending = false;
  tip(st).children.push(node);
  return node;
}

function openBlock(st, node) {
  addBlock(st, node);
  st.stack.push(node);
  return node;
}

// Finalize a block that is being closed. Inline content is parsed now,
// against the link definitions seen so far (single pass, like marked).
function closeBlock(st, node) {
  if (node.type === 'paragraph') {
    // Text only for now: inline parsing is deferred until the whole
    // document is read, so a link reference defined AFTER the paragraph
    // still resolves (marked collects all definitions first).
    // Trailing spaces are KEPT (marked keeps them: "aaa \nbbb \n" ->
    // "aaa<br>bbb ").
    node.text = node.lines.join('\n');
  } else if (node.type === 'heading') {
    node.text = node.lines.join('\n').replace(/[ \t]+$/, '');
  } else if (node.type === 'code' && !node.fenced) {
    while (node.lines.length > 0 &&
      node.lines[node.lines.length - 1] === '') {
      node.lines.pop();
    }
  } else if (node.type === 'list') {
    let loose = false;
    for (let k = 0; k < node.children.length; k++) {
      const item = node.children[k];
      if (k > 0 && item.blankBefore) loose = true;
      for (let j = 1; j < item.children.length; j++) {
        if (item.children[j].blankBefore) loose = true;
      }
    }
    node.tight = !loose;
  } else if (node.type === 'blockquote') {
    // A blank line inside a blockquote does not make an outer list
    // loose: drop any pending blank set while it was open.
    st.blankPending = false;
  }
}

// Walk the finished tree and parse inline content, now that every link
// reference definition in the document is known.
function finalizeInline(node, links) {
  if (node.type === 'paragraph' || node.type === 'heading') {
    node.html = parseInline(node.text, links);
  } else if (node.type === 'table') {
    node.headerHtml = node.header.map((c) => parseInline(c, links));
    node.rowsHtml = node.rows.map((r) => r.map((c) => parseInline(c, links)));
  }
  if (node.children) {
    for (const child of node.children) finalizeInline(child, links);
  }
}

// Phase 1: match the open containers against the current line.
// Advances cur past matched container prefixes. Returns the stack index of
// the first unmatched container, or -1 when all matched.
function matchContainers(st, cur) {
  for (let k = 1; k < st.stack.length; k++) {
    const node = st.stack[k];
    if (!isContainer(node)) break;
    if (node.type === 'blockquote') {
      const savePos = cur.pos, saveCol = cur.col, saveTab = cur.tabRem;
      const ind = curIndent(cur);
      if (ind > 3) return k;
      curSkipSpaces(cur, ind);
      if (curChar(cur) !== '>') {
        cur.pos = savePos; cur.col = saveCol; cur.tabRem = saveTab;
        return k;
      }
      curAdvanceChar(cur); // consume '>'
      curSkipSpaces(cur, 1); // one optional space (never eats a non-space)
    } else if (node.type === 'list') {
      // a list itself always matches; its items do the work
    } else if (node.type === 'item') {
      // A line that is blank after the already-matched container
      // prefixes (e.g. a lone ">>" inside blockquotes) is a blank line
      // inside this item, not a failure to match it: the item stays
      // open and the next line decides whether it continues.
      if (isBlankLine(curText(cur))) continue;
      // A fenced code block's content lines do not have to meet the
      // item's content indent: they belong to the code block even at
      // column 0, until a closing fence ends it. Advance past the item
      // indent only as far as the line actually has, so the fence
      // indent stripping in phase 2 still lines up.
      const tipNode = st.stack[st.stack.length - 1];
      if (tipNode && tipNode.type === 'code' && tipNode.fenced) {
        const relTarget = node.contentIndentRel !== undefined
          ? node.contentIndentRel : node.contentIndent;
        const adv = Math.min(relTarget, curIndent(cur));
        if (adv > 0) curAdvance(cur, adv);
        continue;
      }
      // An item ended by a blank line takes no further lines.
      if (node.blankEnded) return k;
      // The continuation's indent, in columns after this line's own
      // container prefixes, against the item's relative content indent.
      // (Absolute columns fail when blockquote prefixes differ in
      // width between lines.)
      const relIndent = curIndent(cur);
      const relTarget = node.contentIndentRel !== undefined
        ? node.contentIndentRel : node.contentIndent;
      if (relIndent < relTarget) return k;
      curAdvance(cur, relTarget);
    }
  }
  return -1;
}

// Strip containers from line st.lines[idx] against the current stack.
// Returns {text, blank} or null when a container fails to match.
function stripLine(st, idx) {
  if (idx < 0 || idx >= st.lines.length) return null;
  const raw = st.lines[idx];
  if (isBlankLine(raw)) return { text: '', blank: true };
  const cur = makeCursor(raw);
  const unmatched = matchContainers(st, cur);
  if (unmatched >= 0) return null;
  return { text: curText(cur), blank: false };
}

function processLine(st) {
  const raw = st.lines[st.i];
  const cur = makeCursor(raw);
  // Match the open containers first. A line is blank when nothing but
  // whitespace remains after the container prefixes -- so a line that
  // is only a blockquote marker (">") counts as blank and closes the
  // open paragraph, exactly like a truly empty line.
  const unmatched = matchContainers(st, cur);
  const blank = isBlankLine(curText(cur));
  if (blank) {
    // A blank line closes any container it fails to match (notably a
    // blockquote: a blank line without ">" ends it); list items and
    // lists always match. The cursor is positioned after the matched
    // prefixes (used for a blank line's content in a code block).
    if (unmatched >= 0) {
      while (st.stack.length > unmatched) {
        closeBlock(st, st.stack.pop());
      }
    }
  } else if (unmatched >= 0) {
    const t = tip(st);
    if (t.type === 'paragraph' && !isInterruptingBlock(st, cur)) {
      // Lazy continuation: the line joins the open paragraph.
      // Marked strips a 4-column "code indent" from a lazy line whose
      // indent is >= 4, reduced by the paragraph's container: a list
      // item strips its contentIndent, a blockquote strips 4 (2 when
      // the blockquote sits directly inside a list item), a top-level
      // paragraph strips nothing. The strip only applies when the
      // previous paragraph line was not a lazy line with indent < 4.
      const ind = curIndent(cur);
      const prevLazyInd = (t.lazyIndent === undefined) ? -1 : t.lazyIndent;
      if (ind >= 4 && (prevLazyInd === -1 || prevLazyInd >= 4)) {
        const parent = st.stack[st.stack.length - 2];
        let strip = 0;
        if (parent && parent.type === 'item') {
          strip = parent.contentIndent;
        } else if (parent && parent.type === 'blockquote') {
          const gp = st.stack[st.stack.length - 3];
          strip = (gp && gp.type === 'item') ? 2 : 4;
        }
        if (strip > 0) curSkipSpaces(cur, strip);
      }
      let line = curText(cur);
      // A lazy setext "=" line in a blockquote, following another lazy
      // line, is re-indented by 4 spaces (marked's quirk: it stays
      // paragraph text instead of becoming a heading).
      const parent = st.stack[st.stack.length - 2];
      if (t.lazyPrev && parent && parent.type === 'blockquote' &&
        /^ {0,3}=+[ \t]*$/.test(line)) {
        line = '    ' + line.replace(/^ +/, '');
      }
      t.lines.push(line);
      t.lazyPrev = true;
      t.lazyIndent = ind;
      st.i++;
      return;
    }
    while (st.stack.length > unmatched) {
      closeBlock(st, st.stack.pop());
    }
  }
  phase2(st, cur, blank);
}

// Phase 2: handle the line once containers have matched (cur is positioned
// after the matched container prefixes).
function phase2(st, cur, blank) {
  const t = tip(st);
  if (blank) {
    if (t.type === 'code') {
      // A blank line is only code content if the next line stays in the
      // block; hold it until then. An indented code blank keeps the
      // spaces beyond the 4-column indent; a fenced one keeps the line.
      if (!t.fenced) curSkipSpaces(cur, 4);
      st.pendingBlanks.push(curText(cur));
      st.i++;
      return;
    }
    st.pendingBlanks.length = 0;
    // A blank line after an empty list item ends the item: no later
    // line belongs to it. (The list itself stays open; a following
    // list item continues it, anything else closes it.)
    if (t.type === 'item' && t.children.length === 0) {
      t.blankEnded = true;
    }
    if (t.type === 'html' && t.htmlType <= 5) {
      t.lines.push('');
      st.i++;
      return;
    }
    if (t.type === 'html') {
      // HTML block types 6-7 end at a blank line.
      closeBlock(st, st.stack.pop());
      st.blankPending = true;
      st.i++;
      return;
    }
    if (t.type === 'paragraph') {
      closeBlock(st, st.stack.pop());
    }
    st.blankPending = true;
    st.i++;
    return;
  }

  // A blank line held for a code block only counts if this line
  // stays in the block; otherwise it is dropped.
  if (t.type === 'code') {
    if (st.pendingBlanks.length > 0) {
      t.lines.push(...st.pendingBlanks);
      st.pendingBlanks.length = 0;
    }
  } else {
    st.pendingBlanks.length = 0;
  }

  // Fenced code block: closing fence or content.
  if (t.type === 'code' && t.fenced) {
    const ind = curIndent(cur);
    if (ind <= 3) {
      const rest = curText(curAfter(cur, ind));
      const m = /^(```+|~~~+) *$/.exec(rest);
      if (m && m[1][0] === t.fenceChar && m[1].length >= t.fenceLen) {
        // A truly empty line immediately before the closing fence is
        // not part of the code block's content (marked drops exactly
        // one); a line holding only spaces IS kept.
        if (t.lines.length > 0 && t.lines[t.lines.length - 1] === '') {
          t.lines.pop();
        }
        closeBlock(st, st.stack.pop());
        st.i++;
        return;
      }
    }
    curSkipSpaces(cur, t.fenceIndent);
    let line = curText(cur);
    // A leading tab in a nested fenced code block expands to spaces up
    // to the next tab stop (the tab sits at cur.col after the fence
    // indent). At the top level a leading tab is kept literally.
    if (line.startsWith('\t') && st.stack.length > 2) {
      let col = cur.col;
      while (line.startsWith('\t')) {
        const w = 4 - (col % 4);
        line = ' '.repeat(w) + line.slice(1);
        col += w;
      }
    }
    t.lines.push(line);
    st.i++;
    return;
  }

  // Indented code block: needs 4+ columns of indent, else it closes.
  if (t.type === 'code' && !t.fenced) {
    if (curIndent(cur) >= 4) {
      curSkipSpaces(cur, 4);
      t.lines.push(curText(cur));
      st.i++;
      return;
    }
    closeBlock(st, st.stack.pop());
    // fall through to start a new block with this line
  }

  // HTML block: append; types 1-5 close when the end marker appears.
  if (t.type === 'html') {
    const line = curText(cur);
    t.lines.push(line);
    if (t.htmlType <= 5 && htmlEndReached(t, line)) {
      closeBlock(st, st.stack.pop());
    }
    st.i++;
    return;
  }

  // Open paragraph: setext underline, interrupting blocks, or append.
  if (t.type === 'paragraph') {
    const ind = curIndent(cur);
    if (ind <= 3) {
      const rest = curText(curAfter(cur, ind)).replace(/[ \t]+$/, '');
      if (/^=+$/.test(rest)) {
        const p = st.stack.pop();
        p.type = 'heading';
        p.level = 1;
        p.lines[0] = p.lines[0].replace(/^[ \t]+/, '');
        closeBlock(st, p);
        st.i++;
        return;
      }
      if (/^-+$/.test(rest)) {
        const p = st.stack.pop();
        p.type = 'heading';
        p.level = 2;
        p.lines[0] = p.lines[0].replace(/^[ \t]+/, '');
        closeBlock(st, p);
        st.i++;
        return;
      }
    }
    if (isInterruptingBlock(st, cur)) {
      closeBlock(st, st.stack.pop());
      // fall through to start a new block with this line
    } else {
      t.lines.push(curText(cur));
      t.lazyPrev = false;
      t.lazyIndent = -1;
      st.i++;
      return;
    }
  }

  // No open leaf: start a new block (possibly a container, then re-try).
  // A list with no open item ends here unless this line starts a new
  // item in it.
  {
    const t2 = tip(st);
    if (t2.type === 'list') {
      const ind2 = curIndent(cur);
      const rest2 = ind2 <= 3 ? curText(curAfter(cur, ind2)) : '';
      const lm2 = ind2 <= 3 ? listMarker(rest2) : null;
      if (!lm2 || !listMarkerMatchesList(lm2, t2)) {
        closeBlock(st, st.stack.pop());
      }
    }
  }
  startBlock(st, cur);
}

// Does this line start a block that can interrupt a paragraph?
function isInterruptingBlock(st, cur) {
  const ind = curIndent(cur);
  if (ind > 3) return false;
  const rest = curText(curAfter(cur, ind));
  if (rest.startsWith('#')) return /^#{1,6}(?:[ \t]+|$)/.test(rest);
  if (rest.startsWith('```') || rest.startsWith('~~~')) {
    return fenceStart(rest) !== null;
  }
  if (rest.startsWith('<')) {
    const ht = htmlBlockType(rest);
    return ht >= 1 && ht <= 6;
  }
  if (rest.startsWith('>')) return true;
  if (isThematicBreak(rest)) return true;
  const lm = listMarker(rest);
  if (lm !== null) {
    // A marker that matches the innermost open list starts a new item
    // in that list even when empty; otherwise a list can interrupt a
    // paragraph only when its first item is non-empty (and, for an
    // ordered list, starts at 1). But when the paragraph is already
    // inside a list, a non-matching marker ends that list and starts a
    // new one (it need not start at 1).
    let hasOpenList = false;
    for (let k = st.stack.length - 2; k >= 0; k--) {
      const node = st.stack[k];
      if (node.type === 'list') {
        hasOpenList = true;
        if (listMarkerMatchesList(lm, node)) return true;
        break;
      }
    }
    if (hasOpenList) return true;
    if (lm.ordered && lm.start !== 1) return false;
    return !isBlankLine(rest.slice(lm.markerLen));
  }
  return false;
}

// Parse a fence start at the beginning of rest (already indent-checked).
// Returns {char, len, info} or null.
function fenceStart(rest) {
  const m = /^(```+|~~~+)(.*)$/.exec(rest);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].indexOf('`') !== -1) return null;
  return { char: m[1][0], len: m[1].length, info: m[2].trim() };
}

function isThematicBreak(rest) {
  const s = rest.replace(/[ \t]+/g, '');
  if (s.length < 3) return false;
  const c = s[0];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  for (let i = 1; i < s.length; i++) {
    if (s[i] !== c) return false;
  }
  return true;
}

// Match a list marker at the start of rest (indent already <= 3).
// Returns {bullet} or {ordered, start, delim} plus markerLen, or null.
function listMarker(rest) {
  let m = /^([-+*])(?:[ \t]+|$)/.exec(rest);
  if (m) return { bullet: m[1], markerLen: 1 };
  m = /^(\d{1,9})([.)])(?:[ \t]+|$)/.exec(rest);
  if (m) {
    return {
      ordered: true, start: parseInt(m[1], 10), delim: m[2],
      markerLen: m[1].length + 1,
    };
  }
  return null;
}

// HTML block type (1-7) for a line starting with '<', or 0.
function htmlBlockType(rest) {
  if (!rest.startsWith('<')) return 0;
  const s = rest.slice(1);
  if (/^script(?=[ \t>]|$)/i.test(s)) return 1;
  if (/^pre(?=[ \t>]|$)/i.test(s)) return 1;
  if (/^style(?=[ \t>]|$)/i.test(s)) return 1;
  if (/^textarea(?=[ \t>]|$)/i.test(s)) return 1;
  if (s.startsWith('!--')) return 2;
  if (s.startsWith('?')) return 3;
  if (/^![a-zA-Z]/.test(s)) return 4;
  if (s.startsWith('![CDATA[')) return 5;
  const m = /^\/?([a-zA-Z][a-zA-Z0-9-]*)(?=[ \t/>]|$)/.exec(s);
  if (m) {
    if (BLOCK_TAGS_6.has(m[1].toLowerCase())) return 6;
    // Type 7 needs a complete tag alone on the line (only whitespace
    // may follow it).
    const end = matchHtmlTag(rest, 0);
    if (end >= 0 && /^[ \t]*$/.test(rest.slice(end))) return 7;
  }
  return 0;
}

// For HTML block types 1-5, does this line contain the end marker?
function htmlEndReached(node, line) {
  switch (node.htmlType) {
    case 1: return new RegExp(`</${node.endTag}>`, 'i').test(line);
    case 2: return line.indexOf('-->') !== -1;
    case 3: return line.indexOf('?>') !== -1;
    case 4: return line.indexOf('>') !== -1;
    case 5: return line.indexOf(']]>') !== -1;
    default: return false;
  }
}

// Start a new block from the current line (no leaf block is open).
// May consume the line, start a container and re-try, or consume several
// lines (link definition, table). Always advances st.i by at least 1.
function startBlock(st, cur) {
  for (;;) {
    const rest0 = curRest(cur);
    if (isBlankLine(rest0)) {
      st.i++;
      return;
    }
    // A list at the tip only survives when this line starts one of its
    // items (marker indented at most 3). Otherwise the list closes.
    const t0 = tip(st);
    if (t0.type === 'list') {
      const ind0 = curIndent(cur);
      let continues = false;
      if (ind0 <= 3) {
        const rest0b = curText(curAfter(cur, ind0));
        const lm0 = listMarker(rest0b);
        // A thematic break line (e.g. "* * *") is a break, not an item,
        // even though it starts with a list marker.
        continues = !!lm0 && listMarkerMatchesList(lm0, t0) &&
          !isThematicBreak(rest0b);
      }
      if (!continues) {
        closeBlock(st, st.stack.pop());
        continue;
      }
    }
    const ind = curIndent(cur);
    if (ind > 3) {
      // Indented code block.
      curSkipSpaces(cur, 4);
      openBlock(st, {
        type: 'code', fenced: false, info: '', lines: [curText(cur)],
      });
      st.i++;
      return;
    }
    const rest = curText(curAfter(cur, ind));
    // 1. Link reference definition (only when the line starts with '[').
    let def = null;
    if (rest.charCodeAt(0) === 91) {
      def = tryDef(st, cur, ind);
    }
    if (def) {
      st.i = def.nextLine;
      return;
    }
    // 2. ATX heading (only when the line starts with '#').
    const hm = rest.charCodeAt(0) === 35
      ? /^(#{1,6})(?:[ \t]+(.*))?$/.exec(rest) : null;
    if (hm && (hm[2] !== undefined || rest.length === hm[1].length)) {
      let text = (hm[2] || '').replace(/[ \t]+$/, '');
      if (/^#+$/.test(text)) {
        text = '';
      } else {
        const cm = /^(.*?) +#+$/.exec(text);
        if (cm) text = cm[1].replace(/[ \t]+$/, '');
      }
      const h = {
        type: 'heading', level: hm[1].length, lines: [text],
      };
      addBlock(st, h);
      closeBlock(st, h);
      st.i++;
      return;
    }
    // 3. Fenced code block (only when the line starts with ` or ~).
    const fs = (rest.charCodeAt(0) === 96 || rest.charCodeAt(0) === 126)
      ? fenceStart(rest) : null;
    if (fs) {
      openBlock(st, {
        type: 'code', fenced: true, info: fs.info, lines: [],
        fenceChar: fs.char, fenceLen: fs.len, fenceIndent: ind,
      });
      st.i++;
      return;
    }
    // 4. HTML block.
    const ht = htmlBlockType(rest);
    if (ht >= 1) {
      const node = {
        type: 'html', lines: [curText(cur)], htmlType: ht, endTag: null,
      };
      if (ht === 1) {
        const m = /^<(script|pre|style|textarea)/i.exec(rest);
        node.endTag = m ? m[1].toLowerCase() : null;
      }
      openBlock(st, node);
      if (ht <= 5 && htmlEndReached(node, rest)) {
        closeBlock(st, st.stack.pop());
      }
      st.i++;
      return;
    }
    // 5. Thematic break.
    if (isThematicBreak(rest)) {
      addBlock(st, { type: 'hr' });
      st.i++;
      return;
    }
    // 6. Blockquote.
    if (rest.startsWith('>')) {
      curSkipSpaces(cur, ind);
      curAdvanceChar(cur); // '>'
      curSkipSpaces(cur, 1); // one optional space (never eats a non-space)
      openBlock(st, { type: 'blockquote', children: [] });
      continue;
    }
    // 7. List.
    const lm = listMarker(rest);
    if (lm) {
      startListItem(st, cur, ind, lm);
      continue;
    }
    // 8. Table (header line + delimiter on the next line).
    if (tryTable(st, cur, ind)) return;
    // 9. Paragraph: the line's leading spaces are content.
    openBlock(st, { type: 'paragraph', lines: [curText(cur)] });
    st.i++;
    return;
  }
}

function listMarkerMatchesList(lm, list) {
  if (!!lm.ordered !== list.ordered) return false;
  if (lm.ordered) return lm.delim === list.delim;
  return lm.bullet === list.bullet;
}

// Start (or continue) a list with the marker at the current cursor.
function startListItem(st, cur, ind, lm) {
  // baseCol is the absolute column where this line's container content
  // starts (after the blockquote/list prefixes). The content indent is
  // stored both absolutely (for the lazy-paragraph strip) and relative
  // to baseCol: blockquote prefixes vary in width between lines, so a
  // continuation line must be judged by its indent relative to its own
  // line's container content, not by an absolute column.
  const baseCol = cur.col;
  const markerCol = cur.col + ind;
  const markerLen = lm.markerLen;
  // Position the cursor just after the marker.
  curSkipSpaces(cur, ind);
  curAdvance(cur, markerLen);
  // Spaces after the marker: 1-4 consumed as separator; 5+ means the
  // content indent is marker width + 1.
  const after = curIndent(cur);
  let contentIndent;
  if (isBlankLine(curText(cur))) {
    contentIndent = markerCol + markerLen + 1;
  } else if (after >= 1 && after <= 4) {
    contentIndent = markerCol + markerLen + after;
  } else if (after >= 5) {
    contentIndent = markerCol + markerLen + 1;
  } else {
    contentIndent = markerCol + markerLen + 1;
  }
  const contentIndentRel = contentIndent - baseCol;
  curAdvance(cur, contentIndent - cur.col);
  let list = tip(st);
  if (list.type !== 'list' || !listMarkerMatchesList(lm, list)) {
    list = {
      type: 'list',
      ordered: !!lm.ordered,
      start: lm.ordered ? lm.start : 1,
      delim: lm.ordered ? lm.delim : null,
      bullet: lm.ordered ? null : lm.bullet,
      children: [],
    };
    openBlock(st, list);
  }
  openBlock(st, { type: 'item', children: [], contentIndent, contentIndentRel });
}

// Split a table row on unescaped pipes, respecting code spans.
function splitCells(row) {
  const cells = [];
  let cur = '';
  let i = 0;
  while (i < row.length) {
    const ch = row[i];
    if (ch === '\\' && i + 1 < row.length && row[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < row.length && row[j] === '`') j++;
      const run = j - i;
      let k = j;
      let closed = -1;
      while (k < row.length) {
        if (row[k] === '`') {
          let m = k;
          while (m < row.length && row[m] === '`') m++;
          if (m - k === run) { closed = k; break; }
          k = m;
        } else k++;
      }
      if (closed === -1) {
        // No closing run: the backticks are literal text, not a code
        // span — keep scanning so a later '|' still splits the cell.
        cur += row.slice(i, j);
        i = j;
      } else {
        cur += row.slice(i, closed + run).replace(/(?<!\\)\\\|/g, '|');
        i = closed + run;
      }
      continue;
    }
    if (ch === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur);
  return cells;
}

function parseDelimCell(cell) {
  const c = cell.trim();
  if (c === '') return undefined; // empty cell: invalid
  const inner = c.replace(/:/g, '');
  if (!/^-+$/.test(inner)) return undefined; // not only - and : : invalid
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (left) return 'left';
  if (right) return 'right';
  return null; // valid, no alignment
}

// Try to parse a table starting at the current line.
// Returns true when a table was consumed (st.i advanced past it).
function tryTable(st, cur, ind) {
  const headerLine = curText(curAfter(cur, ind));
  const delimPeek = stripLine(st, st.i + 1);
  if (!delimPeek || delimPeek.blank) return false;
  const delimLine = delimPeek.text;
  const delimInd = (() => {
    let n = 0;
    while (n < delimLine.length && delimLine[n] === ' ') n++;
    return n;
  })();
  if (delimInd > 3) return false;
  const delimRest = delimLine.slice(delimInd);
  // Pipe table: header and delimiter both start with '|'.
  const pipeTable = headerLine.startsWith('|') && delimRest.startsWith('|');
  if (!pipeTable && delimRest.indexOf('|') === -1) return false;
  let delimCells = splitCells(delimRest);
  // Trim empty cells from leading/trailing pipes.
  if (delimCells.length > 0 && delimCells[0].trim() === '') delimCells.shift();
  if (delimCells.length > 0 &&
    delimCells[delimCells.length - 1].trim() === '') delimCells.pop();
  if (delimCells.length === 0) return false;
  const aligns = [];
  for (const cell of delimCells) {
    const a = parseDelimCell(cell);
    if (a === undefined) return false;
    aligns.push(a);
  }
  const ncol = aligns.length;
  let headerCells = splitCells(headerLine);
  if (headerCells.length > 0 && headerCells[0].trim() === '') headerCells.shift();
  if (headerCells.length > 0 &&
    headerCells[headerCells.length - 1].trim() === '') headerCells.pop();
  // The delimiter column count must equal the header column count.
  if (headerCells.length !== ncol) return false;
  headerCells = headerCells.map((c) => c.trim());
  while (headerCells.length < ncol) headerCells.push('');
  headerCells = headerCells.slice(0, ncol);
  const rows = [];
  let j = st.i + 2;
  for (;;) {
    const peek = stripLine(st, j);
    if (!peek || peek.blank) break;
    if (pipeTable) {
      // A pipe-table row need not start with '|'; a bare line is a
      // single-cell row. But a line that opens another block (quote,
      // heading, fence, list) ends the table.
      let p = 0;
      while (p < peek.text.length && peek.text[p] === ' ') p++;
      if (p > 3) break;
      const c0 = peek.text[p];
      if (c0 === '>' || c0 === '#' || c0 === '`' || c0 === '~') break;
      if ((c0 === '-' || c0 === '+' || c0 === '*') &&
        (p + 1 >= peek.text.length || peek.text[p + 1] === ' ')) break;
    }
    let cells = splitCells(peek.text);
    if (cells.length > 0 && cells[0].trim() === '') cells.shift();
    if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
    cells = cells.map((c) => c.trim());
    while (cells.length < ncol) cells.push('');
    cells = cells.slice(0, ncol);
    rows.push(cells);
    j++;
  }
  const table = { type: 'table', header: headerCells, aligns, rows };
  addBlock(st, table);
  closeBlock(st, table);
  st.i = j;
  return true;
}

// ---------------------------------------------------------------------------
// Link label / destination / title parsing (shared by block defs and inline)
// ---------------------------------------------------------------------------

// Parse a link label starting at s[i] === '['.
// Returns {label, end} (end = index just past ']') or null.
function parseLinkLabel(s, i) {
  let depth = 0;
  let j = i;
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) {
      j += 2;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        const label = s.slice(i + 1, j);
        if (label.length > 999) return null;
        return { label, end: j + 1 };
      }
    }
    j++;
  }
  return null;
}

// Skip spaces, tabs and newlines.
function skipInlineWs(s, i) {
  while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n')) i++;
  return i;
}

// Parse a link destination at s[i]. Returns {dest, end} or null.
// dest is the raw destination with backslash escapes resolved.
function parseLinkDestination(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    let dest = '';
    while (j < s.length) {
      const ch = s[j];
      if (ch === '\n' || ch === '<') return null;
      if (ch === '>') {
        return { dest, end: j + 1 };
      }
      if (ch === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) {
        dest += s[j + 1];
        j += 2;
        continue;
      }
      dest += ch;
      j++;
    }
    return null;
  }
  let j = i;
  let dest = '';
  let depth = 0;
  while (j < s.length) {
    const ch = s[j];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') break;
    const code = ch.charCodeAt(0);
    if (code < 32 || code === 127) break;
    if (ch === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) {
      dest += s[j + 1];
      j += 2;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    dest += ch;
    j++;
  }
  if (dest === '' || depth !== 0) return null;
  return { dest, end: j };
}

// Parse a link title at s[i] ('"' or '\'' or '(').
// Returns {title, end} or null. Title has backslash escapes resolved.
function parseLinkTitle(s, i) {
  const open = s[i];
  const close = open === '(' ? ')' : open;
  let j = i + 1;
  let title = '';
  while (j < s.length) {
    const ch = s[j];
    if (ch === '\\' && j + 1 < s.length && isAsciiPunct(s[j + 1])) {
      title += s[j + 1];
      j += 2;
      continue;
    }
    if (ch === close) return { title, end: j + 1 };
    if (open === '(' && (ch === '(' || ch === ')')) return null;
    title += ch;
    j++;
  }
  return null;
}

// Try to parse a link reference definition starting at the current line.
// Returns {nextLine} on success, null when the line is not a definition.
// Try to parse a link reference definition starting at the cursor.
// Returns { nextLine } (the first line after the definition) or null.
// A definition is: [label]: destination [title], where the title may be
// on the same line (after whitespace) or on the next line (alone on it).
// If a title on the next line is followed by other text, the definition
// still stands without the title and that line is not consumed.
function tryDef(st, cur, ind) {
  const parts = [curText(curAfter(cur, ind))];
  const peeked = [];
  for (let k = 1; k <= 4; k++) {
    const p = stripLine(st, st.i + k);
    if (!p || p.blank) break;
    peeked.push(p.text);
  }
  const text = parts[0] + (peeked.length ? '\n' + peeked.join('\n') : '');
  const countNl = (upto) => {
    let n = 0;
    for (let q = 0; q < upto; q++) if (text[q] === '\n') n++;
    return n;
  };
  let i = 0;
  if (text[i] !== '[') return null;
  const label = parseLinkLabel(text, i);
  if (!label) return null;
  // A reference label may not contain an unescaped '[' ([a[b]] is not
  // a definition).
  if (hasUnescapedBracket(label.label)) return null;
  i = label.end;
  if (text[i] !== ':') return null;
  i++;
  i = skipInlineWs(text, i);
  const dest = parseLinkDestination(text, i);
  if (!dest) return null;
  i = dest.end;
  // After the destination: spaces/tabs on this line only.
  let j = i;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++;
  let title = null;
  let endPos = i;
  if (j > i && j < text.length &&
    (text[j] === '"' || text[j] === "'" || text[j] === '(')) {
    // Title on the same line as the destination.
    const t = parseLinkTitle(text, j);
    if (!t) return null;
    title = t.title;
    let k = t.end;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
    if (k < text.length && text[k] !== '\n') return null;
    endPos = t.end;
  } else if (j < text.length && text[j] === '\n') {
    // Rest of this line is blank; a title may follow on the next line.
    let k = j + 1;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t')) k++;
    if (k < text.length &&
      (text[k] === '"' || text[k] === "'" || text[k] === '(')) {
      const t = parseLinkTitle(text, k);
      if (t) {
        let m = t.end;
        while (m < text.length && (text[m] === ' ' || text[m] === '\t')) m++;
        if (m >= text.length || text[m] === '\n') {
          title = t.title;
          endPos = t.end;
        }
        // Otherwise the title is rejected; the definition stands
        // without it and the next line is not consumed.
      }
    }
  } else if (j < text.length) {
    // Non-blank text after the destination on this line: invalid.
    return null;
  }
  const norm = normalizeLabel(label.label);
  if (norm === '') return null;
  if (!(norm in st.links)) {
    st.links[norm] = { dest: dest.dest, title };
  }
  return { nextLine: st.i + 1 + countNl(endPos) };
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

// Characters that stop a plain text run.
function isTextStop(ch, next) {
  return ch === '\\' || ch === '`' || ch === '<' || ch === '[' ||
    ch === '!' || ch === '*' || ch === '_' || ch === '&' || ch === '\n' ||
    (ch === '~' && next === '~');
}

function parseInline(src, links, noAuto) {
  const tokens = tokenizeInline(src, links, noAuto);
  const head = resolveEmphasis(tokens);
  return renderInlineTokens(head);
}

function isUnicodeWs(ch) {
  return ch === '' || /\s/.test(ch);
}
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isUnicodePunct(ch) {
  return ch !== '' && (isAsciiPunct(ch) || UNICODE_PUNCT_RE.test(ch));
}

// Tokenize inline text into a flat token list.
// Kinds: text, code, html, link, image, br, delim, del (children tokens).
// When noAuto is set, GFM autolinks are not recognized (used for link
// label text, where a bare URL stays plain text).
function tokenizeInline(src, links, noAuto) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  let textBuf = '';
  const flush = () => {
    if (textBuf) {
      tokens.push({ kind: 'text', text: textBuf });
      textBuf = '';
    }
  };
  while (i < n) {
    const ch = src[i];
    const nx = i + 1 < n ? src[i + 1] : '';
    if (ch === '\\') {
      if (nx === '\n') {
        flush();
        tokens.push({ kind: 'br' });
        i += 2;
        // A hard break eats the next line's leading spaces/tabs.
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      }
      if (nx && isAsciiPunct(nx)) {
        flush();
        tokens.push({ kind: 'text', text: nx });
        i += 2;
        continue;
      }
      textBuf += '\\';
      i++;
      continue;
    }
    if (ch === '`') {
      const r = tryCodeSpan(src, i);
      if (r) {
        flush();
        tokens.push({ kind: 'code', html: r.html });
        i = r.end;
        continue;
      }
      // No closing run: the whole backtick run is literal text (a code
      // span never starts in the middle of a run).
      let j = i;
      while (j < n && src[j] === '`') j++;
      textBuf += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '<') {
      const r = tryTagOrAutolink(src, i);
      if (r) {
        flush();
        tokens.push({ kind: 'html', html: r.html });
        i = r.end;
        continue;
      }
      textBuf += '<';
      i++;
      continue;
    }
    if (ch === '[' || (ch === '!' && nx === '[')) {
      const r = tryLink(src, i, links);
      if (r) {
        flush();
        tokens.push({ kind: r.isImage ? 'image' : 'link', html: r.html });
        i = r.end;
        continue;
      }
      if (ch === '!') { textBuf += '!'; i++; continue; }
      textBuf += '[';
      i++;
      continue;
    }
    if (ch === '*' || ch === '_') {
      let j = i;
      while (j < n && src[j] === ch) j++;
      flush();
      tokens.push(makeDelimToken(src, i, j, ch));
      i = j;
      continue;
    }
    if (ch === '~') {
      const r = tryDel(src, i, links);
      if (r) {
        flush();
        tokens.push({ kind: 'del', head: r.head });
        i = r.end;
        continue;
      }
      let j = i;
      while (j < n && src[j] === '~') j++;
      textBuf += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '&') {
      const d = decodeEntityAt(src, i);
      if (d) { textBuf += d.text; i += d.len; continue; }
      textBuf += '&';
      i++;
      continue;
    }
    if (ch === '\n') {
      let trailing = 0;
      while (trailing < textBuf.length &&
        textBuf[textBuf.length - 1 - trailing] === ' ') trailing++;
      if (trailing >= 2) {
        textBuf = textBuf.slice(0, textBuf.length - trailing);
        flush();
        tokens.push({ kind: 'br' });
        // A hard break eats the next line's leading spaces/tabs.
        i++;
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        continue;
      } else {
        textBuf += '\n';
      }
      i++;
      continue;
    }
    if (!noAuto && (ch === 'h' || ch === 'w')) {
      const r = tryGfmAutolink(src, i);
      if (r) {
        flush();
        tokens.push({ kind: 'html', html: r.html });
        i = r.end;
        continue;
      }
    }
    if (!noAuto && isEmailStart(src, i)) {
      const r = tryGfmAutolink(src, i);
      if (r) {
        flush();
        tokens.push({ kind: 'html', html: r.html });
        i = r.end;
        continue;
      }
    }
    textBuf += ch;
    i++;
  }
  flush();
  return tokens;
}

// Build an emphasis delimiter token for the run src[i..j) of ch.
function makeDelimToken(src, i, j, ch) {
  const before = i === 0 ? '\n' : src[i - 1];
  const after = j >= src.length ? '\n' : src[j];
  const beforeWs = isUnicodeWs(before);
  const afterWs = isUnicodeWs(after);
  const beforePunct = isUnicodePunct(before);
  const afterPunct = isUnicodePunct(after);
  const leftFlanking = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const rightFlanking = !beforeWs && (!beforePunct || afterWs || afterPunct);
  let canOpen, canClose;
  if (ch === '*') {
    canOpen = leftFlanking;
    canClose = rightFlanking;
  } else {
    canOpen = leftFlanking && (!rightFlanking || beforePunct);
    canClose = rightFlanking && (!leftFlanking || afterPunct);
  }
  return {
    kind: 'delim', char: ch, length: j - i,
    canOpen, canClose,
  };
}

// Resolve emphasis in a token list (CommonMark delimiter-stack algorithm).
// Returns the head of the (possibly restructured) linked token list.
function resolveEmphasis(tokens) {
  if (tokens.length === 0) return null;
  let head = tokens[0];
  for (let k = 0; k < tokens.length; k++) {
    tokens[k].prev = k > 0 ? tokens[k - 1] : null;
    tokens[k].next = k < tokens.length - 1 ? tokens[k + 1] : null;
  }
  const openers = []; // stack of delim nodes that can open
  let cur = head;
  while (cur) {
    const next = cur.next;
    if (cur.kind === 'delim') {
      if (cur.canClose) {
        while (cur.length > 0) {
          const opener = findOpener(openers, cur);
          if (!opener) break;
          const use = (opener.length >= 2 && cur.length >= 2) ? 2 : 1;
          const emNode = {
            kind: use === 2 ? 'strong' : 'em', children: [],
          };
          // Collect the nodes between opener and cur as children.
          let c = opener.next;
          const inner = [];
          while (c !== cur) {
            const nx = c.next;
            inner.push(c);
            c = nx;
          }
          emNode.children = inner;
          // Openers strictly between opener and cur are now inside the
          // emphasis node and can no longer match outside it.
          for (const innerNode of inner) {
            if (innerNode.kind === 'delim') {
              const oi = openers.indexOf(innerNode);
              if (oi !== -1) openers.splice(oi, 1);
            }
          }
          opener.length -= use;
          cur.length -= use;
          // Splice: [opener leftover?] emNode [cur leftover?] into the list.
          const opPrev = opener.prev;
          const curNext = cur.next;
          let first = null;
          let last = null;
          const link = (nd) => {
            if (!first) first = nd;
            if (last) { last.next = nd; nd.prev = last; }
            last = nd;
            nd.next = null;
          };
          if (opener.length > 0) link(opener);
          link(emNode);
          if (cur.length > 0) link(cur);
          if (opPrev) { opPrev.next = first; first.prev = opPrev; }
          else { head = first; first.prev = null; }
          if (curNext) { curNext.prev = last; last.next = curNext; }
          if (opener.length === 0) {
            const oi = openers.indexOf(opener);
            if (oi !== -1) openers.splice(oi, 1);
          }
          if (cur.length === 0) break;
        }
      }
      if (cur.canOpen && cur.length > 0 && openers.indexOf(cur) === -1) {
        openers.push(cur);
      }
    }
    cur = next;
  }
  return head;
}

// Find the closest opener in the stack matching closer `cur`.
// Skips openers blocked by the rule of 3.
function findOpener(openers, cur) {
  for (let s = openers.length - 1; s >= 0; s--) {
    const o = openers[s];
    if (o.char !== cur.char) continue;
    if (o.length === 0) continue;
    const oddMatch = (o.length + cur.length) % 3 === 0 &&
      (o.length % 3 !== 0 || cur.length % 3 !== 0);
    const eitherBoth = (o.canOpen && o.canClose) ||
      (cur.canOpen && cur.canClose);
    if (oddMatch && eitherBoth) continue;
    return o;
  }
  return null;
}

function renderInlineTokens(head) {
  let out = '';
  let node = head;
  while (node) {
    switch (node.kind) {
      case 'text':
        out += escapeText(node.text);
        break;
      case 'code':
      case 'html':
      case 'link':
      case 'image':
        out += node.html;
        break;
      case 'br':
        out += '<br>';
        break;
      case 'delim':
        out += node.char.repeat(node.length);
        break;
      case 'em':
        out += '<em>' + renderChildList(node.children) + '</em>';
        break;
      case 'strong':
        out += '<strong>' + renderChildList(node.children) + '</strong>';
        break;
      case 'del':
        out += '<del>' + renderInlineTokens(node.head) + '</del>';
        break;
      default:
        break;
    }
    node = node.next;
  }
  return out;
}

// Render a child token array (used for em/strong/del children).
function renderChildList(children) {
  if (!children || children.length === 0) return '';
  for (let k = 0; k < children.length; k++) {
    children[k].prev = k > 0 ? children[k - 1] : null;
    children[k].next = k < children.length - 1 ? children[k + 1] : null;
  }
  return renderInlineTokens(children[0]);
}

// Code span: a run of backticks, content up to a matching run.
// Newlines become spaces; one leading/trailing space is stripped when the
// content has both and is not all spaces.
function tryCodeSpan(src, i) {
  let j = i;
  while (j < src.length && src[j] === '`') j++;
  const run = j - i;
  let k = j;
  while (k < src.length) {
    if (src[k] === '`') {
      let m = k;
      while (m < src.length && src[m] === '`') m++;
      if (m - k === run) {
        let content = src.slice(j, k);
        content = content.replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' &&
          content[content.length - 1] === ' ' && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        return { html: '<code>' + escapeCode(content) + '</code>', end: m };
      }
      k = m;
    } else {
      k++;
    }
  }
  return null;
}

// Try an HTML tag, comment, processing instruction, declaration, CDATA,
// or a <...> autolink at src[i] === '<'. Returns {html, end} or null.
function tryTagOrAutolink(src, i) {
  // Autolink: <scheme:...> (scheme 2-32 chars, first a letter) or
  // <email>. A scheme makes it a URL (no mailto: prefix); otherwise an
  // '@' makes it an email. The email character class excludes '\', so
  // <foo\+@bar.example.com> is not an autolink.
  const am = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^ <>]*)>/.exec(src.slice(i, i + 2000));
  if (am) {
    const inner = am[1];
    const clean = cleanUrl(inner);
    if (clean !== null) {
      return {
        html: '<a href="' + escapeAttr(clean) + '">' +
          escapeText(inner) + '</a>',
        end: i + am[0].length,
      };
    }
  }
  const em = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(src.slice(i, i + 2000));
  if (em) {
    const inner = em[1];
    const clean = cleanUrl('mailto:' + inner);
    if (clean !== null) {
      return {
        html: '<a href="' + escapeAttr(clean) + '">' +
          escapeText(inner) + '</a>',
        end: i + em[0].length,
      };
    }
  }
  // HTML comment. <!--> and <!---> are complete (abrupt) comments.
  if (src.startsWith('<!--', i)) {
    if (src[i + 4] === '>') {
      return { html: '<!-->', end: i + 5 };
    }
    if (src[i + 4] === '-' && src[i + 5] === '>') {
      return { html: '<!--->', end: i + 6 };
    }
    const end = src.indexOf('-->', i + 4);
    if (end !== -1) {
      return { html: src.slice(i, end + 3), end: end + 3 };
    }
    return null;
  }
  // Processing instruction.
  if (src.startsWith('<?', i)) {
    const end = src.indexOf('?>', i + 2);
    if (end !== -1) {
      return { html: src.slice(i, end + 2), end: end + 2 };
    }
    return null;
  }
  // Declaration <!A ...> or CDATA <![CDATA[ ... ]]>
  if (src.startsWith('<![CDATA[', i)) {
    const end = src.indexOf(']]>', i + 9);
    if (end !== -1) {
      return { html: src.slice(i, end + 3), end: end + 3 };
    }
    return null;
  }
  if (src.startsWith('<!', i) && /[a-zA-Z]/.test(src[i + 2] || '')) {
    const end = src.indexOf('>', i + 2);
    if (end !== -1) {
      return { html: src.slice(i, end + 1), end: end + 1 };
    }
    return null;
  }
  // Open or close tag, parsed per the CommonMark tag grammar (a quoted
  // attribute value may contain '>'). A closing tag takes no attributes.
  const tagEnd = matchHtmlTag(src, i);
  if (tagEnd !== -1) {
    return { html: src.slice(i, tagEnd), end: tagEnd };
  }
  return null;
}

// Match an HTML open/close tag starting at src[i] === '<'.
// Returns the index just past '>' or -1.
function matchHtmlTag(src, i) {
  let j = i + 1;
  const closing = src[j] === '/';
  if (closing) j++;
  if (!/[a-zA-Z]/.test(src[j] || '')) return -1;
  while (j < src.length && /[a-zA-Z0-9-]/.test(src[j])) j++;
  // A closing tag takes no attributes: only whitespace then '>'.
  if (closing) {
    let k = j;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' ||
      src[k] === '\n')) k++;
    if (src[k] === '>') return k + 1;
    return -1;
  }
  for (;;) {
    // Skip whitespace.
    let k = j;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' ||
      src[k] === '\n')) k++;
    if (k >= src.length) return -1;
    if (src[k] === '>') return k + 1;
    if (src[k] === '/' && src[k + 1] === '>') return k + 2;
    if (k === j) return -1; // no whitespace before an attribute
    j = k;
    // Attribute name.
    if (!/[a-zA-Z_:]/.test(src[j] || '')) return -1;
    while (j < src.length && /[a-zA-Z0-9_.:-]/.test(src[j])) j++;
    k = j;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' ||
      src[k] === '\n')) k++;
    if (src[k] !== '=') {
      // Valueless attribute; leave j right after the name so the
      // outer loop skips the whitespace itself.
      continue;
    }
    j = k + 1;
    k = j;
    while (k < src.length && (src[k] === ' ' || src[k] === '\t' ||
      src[k] === '\n')) k++;
    j = k;
    if (src[j] === '"' || src[j] === "'") {
      const q = src[j];
      j++;
      while (j < src.length && src[j] !== q) j++;
      if (j >= src.length) return -1;
      j++;
    } else {
      if (j >= src.length || /[ \t\n"'=<>`]/.test(src[j])) return -1;
      while (j < src.length && !/[ \t\n"'=<>`]/.test(src[j])) j++;
    }
  }
}

// Is position i a plausible start of a bare email address?
function isEmailStart(src, i) {
  const ch = src[i];
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  const ok = (c >= 48 && c <= 57) || (c >= 65 && c <= 90) ||
    (c >= 97 && c <= 122) ||
    ".!#$%&'*+/=?^_`{|}~-".indexOf(ch) !== -1;
  if (!ok) return false;
  // Must be at a word boundary: previous char is not an email char.
  if (i > 0) {
    const p = src[i - 1];
    const pc = p.charCodeAt(0);
    const pok = (pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) ||
      (pc >= 97 && pc <= 122) ||
      ".!#$%&'*+/=?^_`{|}~-".indexOf(p) !== -1;
    if (pok) return false;
  }
  return true;
}

// GFM autolink at src[i]: http(s)://..., www...., or email.
// Returns {html, end} or null. Uses sticky regexes on src directly so
// no substring of the remaining text is ever copied.
const EMAIL_RE = /([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)/y;
const DOMAIN_RE = /[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/y;
const SCHEME_RE = /([a-zA-Z][a-zA-Z0-9+.-]{1,31}):/y;
const SLASH_URL_RE = /\/\/[^\s<]+/y;
const PATH_SEG_RE = /\/[^/\s<]+/y;
const WWW_RE = /(www\.[^\s<]+)/y;

function tryGfmAutolink(src, i) {
  // 1. Scheme autolink: scheme: (2-32 chars) + URL. With '//' the URL
  // runs to whitespace; otherwise it is an email or a domain plus an
  // optional single path segment.
  SCHEME_RE.lastIndex = i;
  let m = SCHEME_RE.exec(src);
  if (m) {
    const afterPos = i + m[0].length;
    let urlPart = null;
    if (src.startsWith('//', afterPos)) {
      SLASH_URL_RE.lastIndex = afterPos;
      const u = SLASH_URL_RE.exec(src);
      if (u) urlPart = u[0];
    } else {
      EMAIL_RE.lastIndex = afterPos;
      const em = EMAIL_RE.exec(src);
      if (em) {
        urlPart = em[1];
        PATH_SEG_RE.lastIndex = afterPos + em[1].length;
        const p = PATH_SEG_RE.exec(src);
        if (p) urlPart += p[0];
      } else {
        DOMAIN_RE.lastIndex = afterPos;
        const dom = DOMAIN_RE.exec(src);
        if (dom) {
          urlPart = dom[0];
          PATH_SEG_RE.lastIndex = afterPos + dom[0].length;
          const p = PATH_SEG_RE.exec(src);
          if (p) urlPart += p[0];
        }
      }
    }
    if (urlPart !== null) {
      let url = backpedalUrl(m[0] + urlPart);
      if (url !== '') {
        const clean = cleanUrl(url);
        if (clean !== null) {
          return {
            html: '<a href="' + escapeAttr(clean) + '">' + escapeText(url) + '</a>',
            end: i + url.length,
          };
        }
      }
    }
  }
  // 2. www. autolink: the href gains an http:// prefix.
  WWW_RE.lastIndex = i;
  m = WWW_RE.exec(src);
  if (m) {
    const url = backpedalUrl(m[1]);
    if (url !== '') {
      const clean = cleanUrl('http://' + url);
      if (clean !== null) {
        return {
          html: '<a href="' + escapeAttr(clean) + '">' + escapeText(url) + '</a>',
          end: i + url.length,
        };
      }
    }
    return null;
  }
  // 3. Bare email autolink. Reject when the character right after the
  // match would continue the address (e.g. '+' in hello@mail+xyz, or
  // '-'/'_' after the domain); a trailing '.' is sentence punctuation.
  EMAIL_RE.lastIndex = i;
  m = EMAIL_RE.exec(src);
  if (m) {
    let url = m[1];
    const next = src[i + url.length];
    if (next !== undefined && /[a-zA-Z0-9!#$%&'*+\/=?^_`{|}~@-]/.test(next)) return null;
    url = backpedalUrl(url);
    if (url === '') return null;
    const clean = cleanUrl('mailto:' + url);
    if (clean === null) return null;
    return {
      html: '<a href="' + escapeAttr(clean) + '">' + escapeText(url) + '</a>',
      end: i + url.length,
    };
  }
  return null;
}

// Trim a GFM autolink candidate the way marked does: trailing punctuation
// (? ! . , : ; * _ ~), a ')' that leaves parens unbalanced, and a ';'
// that would complete an entity reference.
function backpedalUrl(url) {
  for (;;) {
    if (url === '') return '';
    const last = url[url.length - 1];
    if ('?!.,:*_~'.indexOf(last) !== -1) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === ')') {
      let depth = 0;
      for (let k = 0; k < url.length; k++) {
        if (url[k] === '(') depth++;
        else if (url[k] === ')') depth--;
      }
      if (depth < 0) {
        url = url.slice(0, -1);
        continue;
      }
      return url;
    }
    if (last === ';') {
      const amp = url.lastIndexOf('&');
      if (amp !== -1 && /^[a-zA-Z0-9#]+$/.test(url.slice(amp + 1, -1))) {
        // The whole '&entity;' is not part of the URL.
        url = url.slice(0, amp);
        continue;
      }
      // Not an entity: trim just the ';' as punctuation.
      url = url.slice(0, -1);
      continue;
    }
    return url;
  }
}

// Find the ']' matching the '[' at src[i]. Skips escapes, nested brackets
// and code spans. Returns the index or -1.
function findClosingBracket(src, i) {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\' && j + 1 < src.length && isAsciiPunct(src[j + 1])) {
      j += 2;
      continue;
    }
    if (ch === '<') {
      // A ']' inside an autolink or HTML tag is not a bracket: skip
      // the whole <...> so [foo<https://...=](uri)> never forms a link
      // and [foo <bar attr="](baz)"> stays literal.
      const am = /^<([^ >]+(@|:\/)[^ >]+)>/.exec(src.slice(j, j + 2000));
      if (am) { j += am[0].length; continue; }
      const te = matchHtmlTag(src, j);
      if (te !== -1) { j = te; continue; }
    }
    if (ch === '`') {
      let k = j;
      while (k < src.length && src[k] === '`') k++;
      const run = k - j;
      let m = k;
      let closed = -1;
      while (m < src.length) {
        if (src[m] === '`') {
          let p = m;
          while (p < src.length && src[p] === '`') p++;
          if (p - m === run) { closed = m; break; }
          m = p;
        } else m++;
      }
      if (closed === -1) { j = k; continue; }
      j = closed + run;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return j;
    }
    j++;
  }
  return -1;
}

function stripTags(html) {
  // An <img> contributes its alt text; other tags are removed.
  return html.replace(/<img\b[^>]*>/g, (m) => {
    const a = /alt="([^"]*)"/.exec(m);
    if (!a) return '';
    return a[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }).replace(/<[^>]*>/g, '');
}

// Try a link or image at src[i] ('[' or '![').
// Returns {html, end, isImage} or null.
function tryLink(src, i, links) {
  const isImage = src[i] === '!';
  const open = isImage ? i + 1 : i;
  if (src[open] !== '[') return null;
  const close = findClosingBracket(src, open);
  if (close === -1) return null;
  const labelRaw = src.slice(open + 1, close);
  let j = close + 1;
  let dest = null;
  let title = null;
  let inlineOk = false;
  if (src[j] === '(') {
    let k = skipInlineWs(src, j + 1);
    if (src[k] === ')') {
      // Empty destination: [link]().
      dest = '';
      inlineOk = true;
      j = k + 1;
    } else {
      const d = parseLinkDestination(src, k);
      if (d) {
        dest = d.dest;
        k = d.end;
        k = skipInlineWs(src, k);
        let titleOk = true;
        if (src[k] === '"' || src[k] === "'" || src[k] === '(') {
          const t = parseLinkTitle(src, k);
          if (!t) titleOk = false;
          else {
            title = t.title;
            k = t.end;
            k = skipInlineWs(src, k);
          }
        }
        if (titleOk && src[k] === ')') {
          inlineOk = true;
          j = k + 1;
        }
      }
    }
  }
  if (!inlineOk) {
    // Not an inline link (or the inline form failed, e.g. an invalid
    // destination): fall back to a full or shortcut reference link.
    // A reference label may not contain an unescaped '['.
    let ref = null;
    if (src[j] === '[') {
      const rl = parseLinkLabel(src, j);
      if (!rl) return null;
      if (hasUnescapedBracket(rl.label)) return null;
      ref = rl.label;
      j = rl.end;
      if (ref === '') ref = labelRaw;
    } else {
      ref = labelRaw;
    }
    const norm = normalizeLabel(ref);
    if (norm === '') return null;
    const def = links[norm];
    if (!def) return null;
    dest = def.dest;
    title = def.title;
  }
  const href = cleanUrl(dest);
  if (href === null) return null;
  const titleAttr = title !== null && title !== undefined
    ? ' title="' + escapeAttr(title) + '"' : '';
  if (isImage) {
    const alt = stripTags(parseInline(labelRaw, links));
    return {
      html: '<img src="' + escapeAttr(href) + '" alt="' +
        escapeAttr(alt) + '"' + titleAttr + '>',
      end: j, isImage: true,
    };
  }
  // A link may not contain another link: if the label's inline parse
  // already produced a link, the outer one does not form (its brackets
  // stay literal and the inner link is parsed on its own). GFM
  // autolinks are suppressed inside the label, so a bare URL there
  // stays plain text instead of nesting an <a>.
  const labelTokens = tokenizeInline(labelRaw, links, true);
  for (const t of labelTokens) {
    if (t.kind === 'link') return null;
  }
  const labelHtml = renderInlineTokens(resolveEmphasis(labelTokens));
  return {
    html: '<a href="' + escapeAttr(href) + '"' + titleAttr + '>' +
      labelHtml + '</a>',
    end: j, isImage: false,
  };
}

// Try strikethrough ~~...~~ at src[i]. Returns {head, end} or null.
function tryDel(src, i, links) {
  // A tilde run of 1 or 2 is a strikethrough delimiter; a run of 3+
  // is literal text (and a single '~' does delimit in marked).
  let run = 0;
  while (i + run < src.length && src[i + run] === '~') run++;
  if (run > 2) return null;
  const j = i + run;
  if (j >= src.length || isSpace(src[j])) return null;
  // Find a closing tilde run of length 1 or 2 whose content ends
  // with a non-space char.
  let k = j;
  while (k < src.length) {
    if (src[k] === '~') {
      let krun = 0;
      while (k + krun < src.length && src[k + krun] === '~') krun++;
      if (krun <= 2) {
        const content = src.slice(j, k);
        if (content !== '' && !isSpace(content[content.length - 1])) {
          return {
            head: resolveEmphasis(tokenizeInline(content, links)),
            end: k + krun,
          };
        }
      }
      k += krun;
      continue;
    }
    k++;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderDocument(root) {
  return renderBlocks(root.children, true, root.endsWithNewline);
}

function renderBlocks(nodes, top, endsWithNewline) {
  let out = '';
  for (let k = 0; k < nodes.length; k++) {
    const node = nodes[k];
    if (node.type === 'html') {
      // An HTML block keeps its trailing newline when the next block in
      // the same parent follows without a blank line, or when it is the
      // last top-level block and the source ends with a newline.
      const next = nodes[k + 1];
      const trailing = next ? !next.blankBefore
        : (top && endsWithNewline);
      out += node.lines.join('\n') + (trailing ? '\n' : '');
    } else {
      out += renderBlock(node, endsWithNewline);
    }
  }
  return out;
}

function renderBlock(node, endsWithNewline) {
  switch (node.type) {
    case 'paragraph':
      return '<p>' + node.html + '</p>\n';
    case 'heading':
      return '<h' + node.level + '>' + node.html + '</h' + node.level + '>\n';
    case 'code': {
      const content = node.lines.length > 0
        ? node.lines.join('\n') + '\n' : '';
      let cls = '';
      if (node.fenced && node.info) {
        const lang = node.info.split(/\s+/)[0];
        cls = ' class="language-' + escapeAttr(unescapeBackslashes(lang)) + '"';
      }
      return '<pre><code' + cls + '>' + escapeCode(content) +
        '</code></pre>\n';
    }
    case 'html':
      // Handled in renderBlocks (the trailing newline depends on the
      // next block); this case is only reached for nested children.
      return node.lines.join('\n') + '\n';
    case 'hr':
      return '<hr>\n';
    case 'blockquote':
      return '<blockquote>\n' + renderBlocks(node.children, false, endsWithNewline) +
        '</blockquote>\n';
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start !== 1
        ? ' start="' + node.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (const item of node.children) {
        out += renderItem(item, node.tight);
      }
      return out + '</' + tag + '>\n';
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let k = 0; k < node.header.length; k++) {
        const a = node.aligns[k];
        out += '<th' + (a ? ' align="' + a + '"' : '') + '>' +
          node.headerHtml[k] + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (node.rowsHtml.length > 0) {
        out += '<tbody>';
        for (const row of node.rowsHtml) {
          out += '<tr>\n';
          for (let k = 0; k < row.length; k++) {
            const a = node.aligns[k];
            out += '<td' + (a ? ' align="' + a + '"' : '') + '>' +
              row[k] + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody>';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

function taskParaHtml(para) {
  const m = /^\[([ xX])\] /.exec(para.text);
  if (!m) return null;
  const box = m[1] === ' '
    ? '<input disabled="" type="checkbox">'
    : '<input checked="" disabled="" type="checkbox">';
  let rest = para.html;
  if (rest.startsWith(m[0])) rest = rest.slice(m[0].length);
  return box + ' ' + rest;
}

function renderItem(item, tight) {
  let body = '';
  const kids = item.children;
  let firstPara = true;
  for (let k = 0; k < kids.length; k++) {
    const child = kids[k];
    if (child.type === 'paragraph' && firstPara) {
      firstPara = false;
      const task = taskParaHtml(child);
      if (task !== null) {
        body += tight ? task : '<p>' + task + '</p>\n';
        continue;
      }
      if (tight) {
        body += child.html;
        continue;
      }
    }
    if (tight && child.type === 'paragraph') {
      body += child.html;
    } else if (child.type === 'html') {
      // Same trailing-newline rule as renderBlocks, with top=false:
      // a trailing newline only when the next child in this item
      // follows without a blank line; never as the item's last child.
      const next = kids[k + 1];
      const trailing = next ? !next.blankBefore : false;
      body += child.lines.join('\n') + (trailing ? '\n' : '');
    } else {
      body += renderBlock(child);
    }
  }
  return '<li>' + body + '</li>\n';
}

export default parse;
