// COPIED FROM whiffers/src/functions/play/rackFunctions.js (alphabetizeRack,
// drawTiles, removeTilesByCount) - keep in sync (see rules/README.md).

export const alphabetizeRack = (rack) => {
  return [...rack].sort((a, b) => {
    const tileA = typeof a === 'string' ? a : a.tile;
    const tileB = typeof b === 'string' ? b : b.tile;
    return tileA.localeCompare(tileB);
  });
};

// Draws up to `count` tiles from the FRONT of pool into rack, mutating both
// arrays in place. Front-to-back keeps the whole draw order fixed by the one
// opening shuffle (the Daily's "same bag for everyone"); exchanged tiles are
// pushed onto the END of the pool by the caller.
export function drawTiles(rack, pool, count) {
  for (let i = 0; i < count && pool.length > 0; i++) {
    rack.push(pool.shift());
  }
}

/**
 * Removes tiles from a rack by count (handles duplicates correctly)
 * @param {Array} rack - The rack to remove tiles from
 * @param {Array} tilesToRemove - Array of tiles to remove
 * @returns {Array} The updated rack with tiles removed
 */
export const removeTilesByCount = (rack, tilesToRemove) => {
  const rackCopy = [...rack];

  const tilesToRemoveCount = {};
  tilesToRemove.forEach(tile => {
    tilesToRemoveCount[tile] = (tilesToRemoveCount[tile] || 0) + 1;
  });

  Object.entries(tilesToRemoveCount).forEach(([tile, count]) => {
    let removed = 0;
    for (let i = 0; i < count && removed < count; i++) {
      const index = rackCopy.indexOf(tile);
      if (index !== -1) {
        rackCopy.splice(index, 1);
        removed++;
      }
    }
  });

  return rackCopy;
};

// Not in the frontend: whether `tiles` (letters, '?' for a blank) is a
// sub-multiset of `rack` - the server's "do you actually hold these" check.
export function rackHasTiles(rack, tiles) {
  const counts = {};
  for (const t of rack) counts[t] = (counts[t] || 0) + 1;
  for (const t of tiles) {
    if (!counts[t]) return false;
    counts[t]--;
  }
  return true;
}
