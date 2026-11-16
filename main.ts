// Driver for the markdown-render-speed-02 entry.
// Reads every case from $MAKEFUN_INPUT_DIR/cases.json (a JSON array of
// {id, markdown}), renders each one alone with parse() from parse.js,
// and writes $MAKEFUN_OUTPUT_DIR/html.json: a JSON array of the HTML
// strings, one per case and in the cases' order.
// Defaults are /input and /output (the harness paths inside a container).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as Array<{ id: string; markdown: string }>;

// Render each case alone: nothing is carried from one case to the next,
// so a long README cannot warm a cache for the next one.
const html: string[] = cases.map((c) => parse(typeof c.markdown === 'string' ? c.markdown : ''));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
