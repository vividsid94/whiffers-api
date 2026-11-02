// COPIED FROM whiffers/src/functions/dailyChallengeFunctions.js (mulberry32,
// hashSeed) and whiffers/src/stores/gameStore.js (shuffle + initializeGame's
// deal order) - keep in sync (see rules/README.md).
//
// The pre-server Daily deal, computed from the date alone. Kept so past
// calendar days (before DAILY_SERVER_SEED_FROM, see games/daily.js) deal
// exactly what everyone already played on them.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

// Same draw order as initializeGame with daily: true - shuffle the whole
// pool, then the coin toss from the same seeded stream. Returns the shuffled
// bag (racks not yet dealt) and who moves first.
export function legacyDailyDeal(dateKey, origPool) {
  const rng = mulberry32(hashSeed(`${dateKey}:bag`));
  const bag = origPool.split('');
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  const firstPlayer = rng() < 0.5 ? 1 : 2;
  return { bag, firstPlayer };
}
