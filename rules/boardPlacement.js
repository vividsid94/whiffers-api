// COPIED FROM whiffers/src/utils/boardPlacement.js - keep in sync (see rules/README.md).

/**
 * Find all new words formed by placed tiles, with their coordinates
 */
export function findNewWords(beforeBoard, afterBoard, placedTiles) {
  const newWords = new Set();
  const wordCoords = new Map(); // Map word -> array of {row, col} coordinates

  function getWordAt(board, row, col, direction) {
    let word = '';
    let r = row;
    let c = col;
    const coords = [];

    if (direction === 'horizontal') {
      while (c >= 0 && typeof board[r][c] === 'string' && board[r][c].match(/[A-Z]/)) {
        c--;
      }
      c++;
      while (c < 15 && typeof board[r][c] === 'string' && board[r][c].match(/[A-Z]/)) {
        word += board[r][c];
        coords.push({ row: r, col: c });
        c++;
      }
    } else if (direction === 'vertical') {
      while (r >= 0 && typeof board[r][c] === 'string' && board[r][c].match(/[A-Z]/)) {
        r--;
      }
      r++;
      while (r < 15 && typeof board[r][c] === 'string' && board[r][c].match(/[A-Z]/)) {
        word += board[r][c];
        coords.push({ row: r, col: c });
        r++;
      }
    }
    return word.length > 1 ? { word, coords } : null;
  }

  for (const tile of placedTiles) {
    const { row, col } = tile;

    const horizontalResult = getWordAt(afterBoard, row, col, 'horizontal');
    if (horizontalResult) {
      newWords.add(horizontalResult.word);
      wordCoords.set(horizontalResult.word, horizontalResult.coords);
    }

    const verticalResult = getWordAt(afterBoard, row, col, 'vertical');
    if (verticalResult) {
      newWords.add(verticalResult.word);
      wordCoords.set(verticalResult.word, verticalResult.coords);
    }
  }

  return { words: Array.from(newWords), wordCoords };
}

/**
 * Validate placement rules client-side (fast, no API call)
 */
export function validatePlacement(beforeBoard, afterBoard) {
  const placedTiles = [];
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (typeof afterBoard[r][c] === 'string' && afterBoard[r][c].match(/[A-Z]/) &&
        (typeof beforeBoard[r][c] !== 'string' || !beforeBoard[r][c].match(/[A-Z]/))) {
        placedTiles.push({ row: r, col: c, letter: afterBoard[r][c] });
      }
    }
  }

  const numPlaced = placedTiles.length;
  if (numPlaced === 0) {
    return { isValid: false, reason: 'No tiles placed', words: [] };
  }

  if (numPlaced > 1) {
    const firstRow = placedTiles[0].row;
    const firstCol = placedTiles[0].col;
    const allSameRow = placedTiles.every(tile => tile.row === firstRow);
    const allSameCol = placedTiles.every(tile => tile.col === firstCol);

    if (!allSameRow && !allSameCol) {
      return { isValid: false, reason: 'Tiles must be placed in a straight line', words: [] };
    }

    if (allSameRow) {
      const cols = placedTiles.map(tile => tile.col).sort((a, b) => a - b);
      for (let i = 0; i < cols.length - 1; i++) {
        if (cols[i + 1] - cols[i] > 1) {
          for (let c = cols[i] + 1; c < cols[i + 1]; c++) {
            if (typeof beforeBoard[firstRow][c] !== 'string' || !beforeBoard[firstRow][c].match(/[A-Z]/)) {
              return { isValid: false, reason: 'Gaps between tiles are not allowed', words: [] };
            }
          }
        }
      }
    } else if (allSameCol) {
      const rows = placedTiles.map(tile => tile.row).sort((a, b) => a - b);
      for (let i = 0; i < rows.length - 1; i++) {
        if (rows[i + 1] - rows[i] > 1) {
          for (let r = rows[i] + 1; r < rows[i + 1]; r++) {
            if (typeof beforeBoard[r][firstCol] !== 'string' || !beforeBoard[r][firstCol].match(/[A-Z]/)) {
              return { isValid: false, reason: 'Gaps between tiles are not allowed', words: [] };
            }
          }
        }
      }
    }
  }

  let isAdjacent = false;
  let isOnStar = false;

  for (const tile of placedTiles) {
    const { row, col } = tile;
    const adjacentSquares = [
      { dr: 0, dc: 1 }, { dr: 0, dc: -1 }, { dr: 1, dc: 0 }, { dr: -1, dc: 0 }
    ];

    for (const { dr, dc } of adjacentSquares) {
      const newRow = row + dr;
      const newCol = col + dc;
      if (newRow >= 0 && newRow < 15 && newCol >= 0 && newCol < 15) {
        if (typeof beforeBoard[newRow][newCol] === 'string' && beforeBoard[newRow][newCol].match(/[A-Z]/)) {
          isAdjacent = true;
          break;
        }
      }
    }

    if (row === 7 && col === 7) {
      isOnStar = true;
    }
  }

  if (!isAdjacent && !isOnStar) {
    return { isValid: false, reason: 'First move must cover center star or connect to existing tiles', words: [] };
  }

  const { words: newWords, wordCoords } = findNewWords(beforeBoard, afterBoard, placedTiles);
  if (newWords.length === 0) {
    return { isValid: false, reason: 'No valid words formed', words: [], invalidWordCoords: [] };
  }

  return { isValid: true, words: newWords, placedTiles, wordCoords };
}
