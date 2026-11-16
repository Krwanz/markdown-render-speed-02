# markdown-render-speed-02

[![make.fun](https://make.fun/badge.svg)](https://make.fun/bounty/markdown-render-speed-02)

A fast from-scratch CommonMark 0.31.2 + GFM 0.29 Markdown parser in plain
JavaScript, written to return byte-for-byte the HTML that marked 18.1.3
produces with default options — only faster.

## How it works

- `parse.js` — dependency-free module exporting `parse(markdown)`. A
  single-pass block parser (ATX/setext headings, fenced/indented code,
  blockquotes, nested/task lists, tables, thematic breaks, HTML blocks,
  link reference definitions, paragraphs) plus an inline scanner
  (emphasis/strong with a delimiter stack, code spans, links incl.
  reference/autolinks/GFM autolinks, images, strikethrough, hard/soft
  breaks, entities, raw HTML inline, backslash escapes). Hot paths use
  char-code loops instead of regexes, and nothing is cached from one case
  to the next.
- `main.ts` — the driver: reads `cases.json` from `$MAKEFUN_INPUT_DIR`
  (default `/input`), renders each case alone with `parse()`, and writes
  `html.json` to `$MAKEFUN_OUTPUT_DIR` (default `/output`) as a JSON array
  of HTML strings in case order.

## Practice results

On the 720 practice cases (CommonMark + GFM spec examples and 40 long
generated READMEs), this parser matches marked 18.1.3 byte-for-byte on
717 cases. The remaining 3 are long README docs with remaining
HTML-block, fence-indent and loose/tight-list quirks.

Local timing (best of 5 runs, this machine): all 720 cases in ~400 ms
vs marked's ~660 ms (~1.6× faster); the 40 long READMEs alone in
~390 ms vs marked's ~645 ms (~1.65× faster). Two runs of the driver
produce byte-identical output.

## Referral

Made with [make.fun](https://make.fun) — referral code `a15ed58m`.
