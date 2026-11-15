// Driver for the markdown-render-speed-02 entry.
// Reads every case from <input>/cases.json (a JSON array of {id, markdown}),
// renders each one alone with parse() from parse.js, and writes
// <output>/html.json: a JSON array of the HTML strings, one per case, in order.
// Outside a container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output. Erasable TypeScript only (Node 22 strips types natively).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir: string = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir: string = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

interface Case {
  id: string;
  markdown: string;
}

const cases: Case[] = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html: string[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  html[i] = parse(cases[i].markdown);
}
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
