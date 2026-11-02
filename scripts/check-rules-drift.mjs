// Compares the rule copies in rules/ against their originals in the whiffers
// frontend (expects ../whiffers next to this repo) and lists any function
// whose body differs. Run after changing game rules in either repo:
//
//   node scripts/check-rules-drift.mjs
//
// Comments and whitespace are ignored; only code is compared.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const api = path.resolve(here, '..');
const front = path.resolve(api, '../whiffers/src');

// [copy in rules/, original in whiffers/src, names to compare]
const PAIRS = [
  ['boardPlacement.js', 'utils/boardPlacement.js', ['findNewWords', 'validatePlacement']],
  ['scoreFunctions.js', 'functions/scoreFunctions.js', ['letterScores', 'getWordScore', 'findWord', 'calculateScore']],
  ['rack.js', 'functions/play/rackFunctions.js', ['alphabetizeRack', 'drawTiles', 'removeTilesByCount']],
  ['gameEnd.js', 'functions/play/gameEndFunctions.js', ['computeFinalScores']],
  ['opponents.js', 'functions/play/opponents.js', ['pickCandidateAtRank']],
  ['boardRequest.js', 'functions/play/botFunctions.js', ['buildBoardForRequest']],
  ['staticData.js', 'data/staticData.js', ['origPool', 'origBoard']],
];

// The text of a top-level declaration: from its `function NAME` / `const NAME`
// line to the next line that closes at column 0.
function extract(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex(l => new RegExp(`^(export )?(async )?(function ${name}\\b|const ${name}\\b)`).test(l));
  if (start === -1) return null;
  let end = start;
  if (!/[;`]\s*$/.test(lines[start]) || /[{([]\s*$/.test(lines[start])) {
    end = lines.findIndex((l, i) => i > start && /^(\}|\];|\};|\);|.*`;\s*$)/.test(l));
  }
  return lines.slice(start, end + 1).join('\n');
}

const normalize = (code) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')
  .replace(/^export /gm, '')
  .replace(/\s+/g, '')
  .replace(/\((\w+)\)=>/g, '$1=>'); // (b) => and b => are the same code

let drift = 0;
for (const [copyFile, originalFile, names] of PAIRS) {
  const copyPath = path.join(api, 'rules', copyFile);
  const originalPath = path.join(front, originalFile);
  if (!fs.existsSync(originalPath)) {
    console.error(`Can't find ${originalPath} - is the whiffers repo next to this one?`);
    process.exit(2);
  }
  const copy = fs.readFileSync(copyPath, 'utf8');
  const original = fs.readFileSync(originalPath, 'utf8');
  for (const name of names) {
    const a = extract(copy, name);
    const b = extract(original, name);
    if (!a || !b) {
      console.log(`?  ${copyFile} ${name}: not found in ${a ? originalFile : copyFile}`);
      drift++;
    } else if (normalize(a) !== normalize(b)) {
      console.log(`✗  ${copyFile} ${name} differs from whiffers/src/${originalFile}`);
      drift++;
    }
  }
}
console.log(drift ? `\n${drift} difference(s) - update rules/ (or the frontend) so they match.` : 'All rule copies match the frontend.');
process.exit(drift ? 1 : 0);
