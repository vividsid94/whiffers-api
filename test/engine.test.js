// node --test   (run from the repo root; no database or network needed)
import test from 'node:test';
import assert from 'node:assert/strict';
import { origPool } from '../rules/staticData.js';
import {
  createState, applyHumanPlay, applyExchange, applyPass, applyBotMove, applyResign,
  assertTileConservation, MoveError,
} from '../games/engine.js';
import { toClientSnapshot } from '../games/view.js';
import { isValidWord } from '../games/dictionary.js';
import { legacyDailyDeal } from '../rules/legacyDaily.js';

const nwl = (w) => isValidWord('NWL23', w);

// A bag whose first 14 tiles are a known human rack + bot rack, followed by
// the rest of the 100 tiles in pool order.
function bagStartingWith(rack1, rack2) {
  const rest = origPool.split('');
  for (const t of [...rack1, ...rack2]) rest.splice(rest.indexOf(t), 1);
  return [...rack1, ...rack2, ...rest];
}

function newGame(rack1 = 'CATSDOG', rack2 = 'EEIRSTN', firstPlayer = 1) {
  return createState({
    mode: 'classic', lexicon: 'NWL23', opponentId: 'wally',
    bag: bagStartingWith(rack1.split(''), rack2.split('')), firstPlayer,
  });
}

const across = (word, row, col, blanks = []) => word.split('').map((letter, i) => ({
  row, col: col + i, letter, isBlank: blanks.includes(i),
}));

test('deal: 7 each, 86 in the bag, every tile accounted for', () => {
  const s = newGame();
  assert.equal(s.racks[1].length, 7);
  assert.equal(s.racks[2].length, 7);
  assert.equal(s.bag.length, 86);
  assertTileConservation(s);
});

test('opening play scores like the frontend (CAT on the star = DWS)', () => {
  const s = applyHumanPlay(newGame(), across('CAT', 7, 6), nwl);
  // C3 + A1 + T1 = 5, doubled by the centre star
  assert.equal(s.history[0].score, 10);
  assert.equal(s.scores[1], 10);
  assert.equal(s.racks[1].length, 7, 'refilled to 7');
  assert.equal(s.currentPlayer, 2);
  assert.equal(s.scorelessRun, 0);
  assertTileConservation(s);
});

test('a blank scores 0 and is remembered as a blank', () => {
  const s = applyHumanPlay(newGame('CA?SDOG'), across('CAT', 7, 6, [2]), nwl);
  // CAT with the T a blank: C3 + A1 + 0 = 4, doubled
  assert.equal(s.history[0].score, 8);
  assert.deepEqual(s.blankTiles, [{ row: 7, col: 8 }]);
  assertTileConservation(s);
});

test('rejects tiles not on the rack, phonies, gaps and a missed star', () => {
  const s = newGame();
  assert.throws(() => applyHumanPlay(s, across('ZAP', 7, 6), nwl), (e) => e instanceof MoveError && e.code === 'invalid_move');
  assert.throws(() => applyHumanPlay(s, across('TCA', 7, 6), nwl), /Invalid word/);
  assert.throws(() => applyHumanPlay(s, [{ row: 7, col: 6, letter: 'C' }, { row: 7, col: 8, letter: 'T' }], nwl), /Gaps/);
  assert.throws(() => applyHumanPlay(s, across('CAT', 0, 0), nwl), /center star/);
});

test('rejects playing out of turn and onto taken squares', () => {
  const s = applyHumanPlay(newGame(), across('CAT', 7, 6), nwl);
  assert.throws(() => applyHumanPlay(s, across('DOG', 8, 6), nwl), (e) => e.code === 'not_your_turn');
  const back = applyPass(s, 2);
  assert.throws(() => applyHumanPlay(back, [{ row: 7, col: 7, letter: 'D' }], nwl), /taken/);
});

test('invalid words come back with their board coordinates', () => {
  try {
    applyHumanPlay(newGame(), across('TCA', 7, 6), nwl);
    assert.fail('should throw');
  } catch (e) {
    assert.deepEqual(e.invalidWords, ['TCA']);
    assert.equal(e.invalidWordCoords.length, 3);
  }
});

test('exchange: tiles go to the back of the bag, needs 7+ in the bag', () => {
  const s = applyExchange(newGame(), 1, ['C', 'A']);
  assert.deepEqual(s.bag.slice(-2), ['C', 'A']);
  assert.equal(s.racks[1].length, 7);
  assert.equal(s.scorelessRun, 1);
  assertTileConservation(s);
  const lowBag = { ...newGame(), bag: newGame().bag.slice(0, 6) };
  assert.throws(() => applyExchange(lowBag, 1, ['C']), /Not enough tiles/);
  assert.throws(() => applyExchange(newGame(), 1, ['Z']), /aren't on your rack/);
});

test('six scoreless turns (passes and exchanges mixed) end the game with rack penalties', () => {
  let s = newGame();
  s = applyPass(s, 1);
  s = applyExchange(s, 2, ['E']);
  s = applyPass(s, 1);
  s = applyPass(s, 2);
  s = applyExchange(s, 1, ['C']);
  assert.equal(s.ended, false);
  s = applyPass(s, 2);
  assert.equal(s.ended, true);
  assert.equal(s.endReason, 'sixScoreless');
  assert.ok(s.final.player1Score < 0 && s.final.player2Score < 0, 'both lose their rack values');
});

test('a play resets the scoreless run', () => {
  let s = applyPass(newGame(), 1);
  s = applyPass(s, 2);
  s = applyHumanPlay(s, across('CAT', 7, 6), nwl);
  assert.equal(s.scorelessRun, 0);
});

test('going out ends the game and doubles the opponent rack', () => {
  // Rack CAT + 4 more, bag emptied: playing all of the rack goes out.
  let s = newGame('CATSDOG');
  s = { ...s, bag: [], racks: { 1: ['A', 'C', 'T'], 2: s.racks[2] } };
  // Keep conservation honest for this hand-built state: dump the rest on the bot.
  s = applyHumanPlay(s, across('CAT', 7, 6), nwl);
  assert.equal(s.ended, true);
  assert.equal(s.endReason, 'wentOut');
  const botRackValue = s.racks[2].reduce((sum, t) => sum + ({ E: 1, I: 1, R: 1, S: 1, T: 1, N: 1 }[t] ?? 0), 0);
  assert.equal(s.final.player1Score, 10 + 2 * botRackValue);
});

test('bot move: Go shape applies, score recomputed, rack checked', () => {
  let s = applyPass(newGame('CATSDOG', 'EEIRSTN', 1), 1);
  s = applyBotMove(s, {
    isExchange: false,
    tiles: across('TIRES', 7, 5).map(t => ({ ...t, isNew: true })),
    score: 999,
  });
  assert.equal(s.history[1].score, 10, 'TIRES on the star: 5 doubled, not the 999 claimed');
  assert.equal(s.currentPlayer, 1);
  assertTileConservation(s);
  const s2 = applyPass(newGame(), 1);
  assert.throws(() => applyBotMove(s2, { isExchange: false, tiles: across('QI', 7, 7).map(t => ({ ...t, isNew: true })) }), /doesn't hold/);
});

test('resign ends the game and the bot wins', () => {
  const s = applyResign(newGame());
  assert.equal(s.ended, true);
  assert.equal(s.final.winner, 'bot');
});

test('snapshot never leaks the bag order or the bot rack mid-game', () => {
  let s = applyExchange(applyPass(newGame(), 1), 2, ['E', 'E']);
  const snap = JSON.stringify(toClientSnapshot('g', 1, s));
  const parsed = JSON.parse(snap);
  assert.equal(parsed.bag, undefined);
  assert.equal(parsed.racks, undefined);
  const botEntry = parsed.history.find(h => h.isBot);
  assert.equal(botEntry.rack, undefined);
  assert.equal(botEntry.exchanged, undefined);
  assert.equal(botEntry.exchangedCount, 2);
  assert.equal(parsed.unseen.length, s.bag.length + s.racks[2].length);
  assert.equal(parsed.final, null);
});

test('snapshot reveals the bot racks once the game is over', () => {
  const s = applyResign(applyExchange(applyPass(newGame(), 1), 2, ['E']));
  const parsed = toClientSnapshot('g', 1, s);
  assert.deepEqual(parsed.history.find(h => h.isBot).exchanged, ['E']);
  assert.deepEqual(parsed.final.opponentRack, s.racks[2]);
});

test('legacy daily deal is deterministic per date', () => {
  const a = legacyDailyDeal('2026-10-01', origPool);
  assert.deepEqual(a, legacyDailyDeal('2026-10-01', origPool));
  assert.equal(a.bag.length, 100);
  assert.notDeepEqual(a.bag, legacyDailyDeal('2026-10-02', origPool).bag);
});

// Runs only when the whiffers repo sits next to this one (local dev): replays
// gameStore.initializeGame's daily deal with the frontend's own RNG and
// checks the server's copy deals the identical bag and coin toss.
test('legacy daily deal matches the frontend exactly', async (t) => {
  let frontend;
  try {
    frontend = await import('../../whiffers/src/functions/dailyChallengeFunctions.js');
  } catch {
    t.skip('whiffers repo not found next to whiffers-api');
    return;
  }
  for (const date of ['2026-10-01', '2026-11-01', '2025-12-25']) {
    const rng = frontend.getDailyRng('bag', date);
    const bag = origPool.split('');
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    const firstPlayer = rng() < 0.5 ? 1 : 2;
    assert.deepEqual(legacyDailyDeal(date, origPool), { bag, firstPlayer }, date);
  }
});
