// Demotion / Unusual: tiles that change letter after the holder's turn
// (drawbacks.js changeLetters, applyOpeningDeal). No database or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { origPool } from '../rules/staticData.js';
import { createState, applyHumanPlay, applyExchange, applyPass, assertTileConservation } from '../games/engine.js';
import { createDrawbackState, changeLetters, applyOpeningDeal } from '../games/drawbacks.js';

function bagStartingWith(rack1, rack2) {
  const rest = origPool.split('');
  for (const t of [...rack1, ...rack2]) rest.splice(rest.indexOf(t), 1);
  return [...rack1, ...rack2, ...rest];
}

function drawbacksGame(rack1, rack2, picks) {
  const state = createState({
    mode: 'drawbacks', lexicon: 'NWL23', opponentId: 'wally',
    bag: bagStartingWith(rack1.split(''), rack2.split('')), firstPlayer: 1,
  });
  return { ...state, drawbacks: createDrawbackState(picks) };
}

const anyWord = () => true;
const sorted = (letters) => [...letters].sort().join('');

test('Demotion: kept tiles drop a step, an exchange restores, a played changed tile stays changed', () => {
  let s = drawbacksGame('CATSDOG', 'EEIRSTN', { player: 53, wally: 1 });
  const bagFront = s.bag.slice(0, 3);

  // Play CAT: S D O G stay and drop to R C U W; the 3 new tiles don't.
  let next = changeLetters(s, applyHumanPlay(s, [
    { row: 7, col: 6, letter: 'C' }, { row: 7, col: 7, letter: 'A' }, { row: 7, col: 8, letter: 'T' },
  ], anyWord));
  assert.equal(sorted(next.racks[1]), sorted(['R', 'C', 'U', 'W', ...bagFront]));
  assert.deepEqual(next.drawbacks.changed[1].map(c => `${c.was}>${c.now}`).sort(), ['D>C', 'G>W', 'O>U', 'S>R']);
  assertTileConservation(next);

  // Wally passes (his drawback doesn't change letters).
  s = next;
  next = changeLetters(s, applyPass(s, 2));
  assert.deepEqual(next.racks[1], s.racks[1]);

  // Exchange the U (was an O): an O goes back to the bag, the rest drop again.
  s = next;
  next = changeLetters(s, applyExchange(s, 1, ['U']));
  assert.equal(next.bag[next.bag.length - 1], 'O');
  assert.ok(!next.drawbacks.changed[1].some(c => c.was === 'O'));
  const r = next.drawbacks.changed[1].find(c => c.was === 'S');
  assert.equal(r.now, 'N'); // S > R > N
  assertTileConservation(next);

  // Play the N (was an S) next to CAT: it stays an N on the board.
  s = changeLetters(next, applyPass(next, 2));
  next = changeLetters(s, applyHumanPlay(s, [{ row: 7, col: 9, letter: 'N' }], anyWord));
  assert.ok(next.drawbacks.playedChanged.some(c => c.now === 'N' && c.was === 'S'));
  assert.ok(!next.drawbacks.changed[1].some(c => c.was === 'S' && c.now === 'N'));
  assertTileConservation(next);
});

test('Demotion: a blank drops to S, and exchanging it gives the blank back', () => {
  const s = drawbacksGame('?ABCDEF', 'EEIRSTN', { player: 53, wally: 1 });
  let next = changeLetters(s, applyPass(s, 1));
  assert.ok(next.racks[1].includes('S') && !next.racks[1].includes('?'));
  assertTileConservation(next);
  next = changeLetters(next, applyPass(next, 2));
  // Exchange the S that was the blank.
  const blank = next.drawbacks.changed[1].find(c => c.was === '?');
  const after = changeLetters(next, applyExchange(next, 1, [blank.now]));
  assert.equal(after.bag[after.bag.length - 1], '?');
  assertTileConservation(after);
});

test('Unusual: drawn vowels sometimes become U, on the opening deal too; exchanging restores', () => {
  let seen = 0;
  for (let i = 0; i < 30; i++) {
    const s = applyOpeningDeal(drawbacksGame('AEIOAEI', 'EEIRSTN', { player: 63, wally: 1 }));
    const changed = s.drawbacks.changed?.[1] ?? [];
    assert.equal(s.racks[1].length, 7);
    assert.ok(changed.every(c => c.now === 'U' && 'AEIO'.includes(c.was)));
    assert.equal(s.racks[1].filter(l => l === 'U').length, changed.length);
    assertTileConservation(s);
    if (changed.length) {
      seen++;
      const after = changeLetters(s, applyExchange(s, 1, ['U']));
      assert.equal(after.bag[after.bag.length - 1], changed[0].was);
      assertTileConservation(after);
    }
  }
  assert.ok(seen > 0);
});
