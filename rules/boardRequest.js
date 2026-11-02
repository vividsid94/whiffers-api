// COPIED FROM whiffers/src/functions/play/botFunctions.js - keep in sync (see
// rules/README.md). The Go move generator's board format: '' for empty,
// letters uppercase, blanks lowercase.
export function buildBoardForRequest(boardCoords, blankTiles) {
  return boardCoords.map((row, r) => row.map((cell, c) => {
    if (typeof cell !== 'string') return '';
    const isBlank = blankTiles.some((b) => b.row === r && b.col === c);
    return isBlank ? cell.toLowerCase() : cell;
  }));
}

// One place for the Go service's URL - overridable for local testing.
export const GO_SERVICE_URL = process.env.GO_SERVICE_URL || 'https://scrabble-move-generator-production.up.railway.app';
