// COPIED FROM whiffers/src/functions/scoreFunctions.js (letterScores +
// calculateScore and its helpers) - keep in sync (see rules/README.md).

// Letter scores for each tile
export const letterScores = {
  'A': 1, 'B': 3, 'C': 3, 'D': 2, 'E': 1, 'F': 4, 'G': 2, 'H': 4, 'I': 1,
  'J': 8, 'K': 5, 'L': 1, 'M': 3, 'N': 1, 'O': 1, 'P': 3, 'Q': 10, 'R': 1,
  'S': 1, 'T': 1, 'U': 1, 'V': 4, 'W': 4, 'X': 8, 'Y': 4, 'Z': 10, '?': 0,
};

function getWordScore(wordTiles, placedTiles, boardMultipliers, blankSet) {
  let wordScore = 0;
  let wordMultiplier = 1;
  const usedPremiumSquares = new Set();

  for (const tile of wordTiles) {
    const letter = tile.letter;
    const row = tile.row;
    const col = tile.col;
    // A blank tile is always worth 0, regardless of which letter it's
    // displaying - whether it was placed on the board this move or on a
    // previous one. The board array only stores the displayed letter, so
    // blank-ness has to come from blankSet (the store's blankTiles list).
    const letterScore = blankSet && blankSet.has(`${row},${col}`) ? 0 : letterScores[letter];
    let letterMultiplier = 1;

    const isNewTile = placedTiles.some(pt => pt.row === row && pt.col === col);
    if (isNewTile) {
      const premiumType = boardMultipliers[row][col];
      if (premiumType === 3) { // Double word
        if (!usedPremiumSquares.has(`DW-${row}-${col}`)) {
          wordMultiplier *= 2;
          usedPremiumSquares.add(`DW-${row}-${col}`);
        }
      } else if (premiumType === 1) { // Double letter
        letterMultiplier = 2;
      } else if (premiumType === 2) { // Triple letter
        letterMultiplier = 3;
      } else if (premiumType === 4) { // Triple word
        if (!usedPremiumSquares.has(`TW-${row}-${col}`)) {
          wordMultiplier *= 3;
          usedPremiumSquares.add(`TW-${row}-${col}`);
        }
      }
    }

    wordScore += letterScore * letterMultiplier;
  }

  return wordScore * wordMultiplier;
}

function findWord(board, startRow, startCol, direction) {
  const wordTiles = [];
  let currentRow = startRow;
  let currentCol = startCol;

  if (direction === 'horizontal') {
    while (currentCol >= 0 && typeof board[currentRow][currentCol] === 'string' &&
      board[currentRow][currentCol].match(/[A-Z]/)) {
      currentCol--;
    }
    currentCol++;
    while (currentCol < 15 && typeof board[currentRow][currentCol] === 'string' &&
      board[currentRow][currentCol].match(/[A-Z]/)) {
      wordTiles.push({ letter: board[currentRow][currentCol], row: currentRow, col: currentCol });
      currentCol++;
    }
  } else if (direction === 'vertical') {
    while (currentRow >= 0 && typeof board[currentRow][currentCol] === 'string' &&
      board[currentRow][currentCol].match(/[A-Z]/)) {
      currentRow--;
    }
    currentRow++;
    while (currentRow < 15 && typeof board[currentRow][currentCol] === 'string' &&
      board[currentRow][currentCol].match(/[A-Z]/)) {
      wordTiles.push({ letter: board[currentRow][currentCol], row: currentRow, col: currentCol });
      currentRow++;
    }
  }

  return wordTiles.length > 1 ? wordTiles : [];
}

export function calculateScore(beforeBoard, afterBoard, boardMultipliers, blankTiles = []) {
  let totalScore = 0;
  const formedWords = new Set();
  const placedTiles = [];
  const blankSet = new Set((blankTiles || []).map(t => `${t.row},${t.col}`));

  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (typeof afterBoard[r][c] === 'string' && afterBoard[r][c].match(/[A-Z]/) &&
        (typeof beforeBoard[r][c] !== 'string' || !beforeBoard[r][c].match(/[A-Z]/))) {
        placedTiles.push({ row: r, col: c, letter: afterBoard[r][c] });
      }
    }
  }

  if (placedTiles.length === 0) return 0;

  for (const placedTile of placedTiles) {
    const r = placedTile.row;
    const c = placedTile.col;

    // Keyed by position (direction + anchor cell), not the word's letters -
    // two different on-board words that happen to spell the same thing in
    // one turn are still two separate words to score. findWord always
    // returns the same anchor cell regardless of which placed tile within
    // the word triggered the lookup, so this still correctly dedupes a
    // single word found from multiple of its own placed tiles.
    const horizontalWord = findWord(afterBoard, r, c, 'horizontal');
    if (horizontalWord.length > 0) {
      const wordKey = `h:${horizontalWord[0].row},${horizontalWord[0].col}`;
      if (!formedWords.has(wordKey)) {
        totalScore += getWordScore(horizontalWord, placedTiles, boardMultipliers, blankSet);
        formedWords.add(wordKey);
      }
    }

    const verticalWord = findWord(afterBoard, r, c, 'vertical');
    if (verticalWord.length > 0) {
      const wordKey = `v:${verticalWord[0].row},${verticalWord[0].col}`;
      if (!formedWords.has(wordKey)) {
        totalScore += getWordScore(verticalWord, placedTiles, boardMultipliers, blankSet);
        formedWords.add(wordKey);
      }
    }
  }

  // Add 50-point bonus for using all 7 tiles
  if (placedTiles.length === 7) {
    totalScore += 50;
  }

  return totalScore;
}
