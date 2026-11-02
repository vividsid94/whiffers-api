// Word lists for checking human plays - the same files the frontend
// validates against (rules/lexicons/, copied from whiffers/public/files).
// Loaded once into a Set per lexicon; preload() runs at boot so the first
// move doesn't pay the ~1s read.

import fs from 'fs';
import { fileURLToPath } from 'url';

const FILES = {
  NWL23: 'nwl2023.txt',
  CSW24: 'csw24.txt',
};

export const SUPPORTED_GAME_LEXICONS = Object.keys(FILES);

const sets = new Map();

function load(lexicon) {
  const file = fileURLToPath(new URL(`../rules/lexicons/${FILES[lexicon]}`, import.meta.url));
  const words = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const word = line.trim().split(/\s/)[0];
    if (word) words.add(word.toUpperCase());
  }
  sets.set(lexicon, words);
  return words;
}

export function isValidWord(lexicon, word) {
  const words = sets.get(lexicon) ?? load(lexicon);
  return words.has(word);
}

export function preloadDictionaries() {
  for (const lexicon of SUPPORTED_GAME_LEXICONS) {
    if (!sets.has(lexicon)) load(lexicon);
  }
}
