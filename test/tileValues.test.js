// Regicide / Decay / Goose Egg: what tiles are worth to whom (drawbacks.js
// changeValues, startTurnValues). No database or network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { origPool } from '../rules/staticData.js';
import { createState, applyHumanPlay, applyExchange, applyPass, assertTileConservation } from '../games/engine.js';
import { createDrawbackState, changeValues, startTurnValues, applyOpeningDeal } from '../games/drawbacks.js';

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
// One move, then what the server does around it (minus the Go calls).
const step = (before, after) => startTurnValues(changeValues(before, after));
const rackOf = (s, p) => [...(s.drawbacks.values?.[p]?.rack ?? [])].map(t => `${t.letter}${t.value}`).sort();
const boardOf = (s, p) => s.drawbacks.values?.[p]?.board ?? {};

test('Regicide: the highest tile goes to 0 at the start of each turn, stays 0 for you on the board, and is followed into the bag', () => {
  let s = applyOpeningDeal(drawbacksGame('QABCDEF', 'EEIRSTN', { player: 51, wally: 1 }));
  assert.deepEqual(rackOf(s, 1), ['Q0']);
  assert.deepEqual(startTurnValues(s), s); // once per turn

  // Play QA: the Q square is 0 for you, normal for Wally.
  let next = step(s, applyHumanPlay(s, [{ row: 7, col: 7, letter: 'Q' }, { row: 7, col: 8, letter: 'A' }], anyWord));
  assert.equal(boardOf(next, 1)['7,7'], 0);
  assert.equal(boardOf(next, 2)['7,7'], undefined);
  assertTileConservation(next);

  // Wally passes; your next turn zeroes your highest tile again.
  next = step(next, applyPass(next, 2));
  assert.equal(next.drawbacks.values[1].rack.length, 1);
  const zeroed = next.drawbacks.values[1].rack[0];
  assert.equal(zeroed.value, 0);

  // Exchange it: it goes to the bag as a Regicide tile (last in the bag).
  s = next;
  next = changeValues(s, applyExchange(s, 1, [zeroed.letter]));
  assert.deepEqual(next.drawbacks.regicideBag, [{ holder: 1, letter: zeroed.letter, fromEnd: 0 }]);
  assert.equal(next.bag[next.bag.length - 1], zeroed.letter);
  assert.deepEqual(next.drawbacks.values[1].rack, []);
  // Wally's exchange of 2 pushes it 2 further from the end.
  const w = changeValues(next, applyExchange(next, 2, next.racks[2].slice(0, 2)));
  assert.equal(w.drawbacks.regicideBag[0].fromEnd, 2);
});

test('Regicide: drawing your own zeroed tile back keeps it 0', () => {
  const s = drawbacksGame('QABCDEF', 'EEIRSTN', { player: 51, wally: 1 });
  // Pretend the bag's front tile is a Q you exchanged earlier.
  const bag = [...s.bag];
  const qi = bag.indexOf('Q');
  if (qi === -1) return; // the only Q is on the rack - nothing to draw back
  [bag[0], bag[qi]] = [bag[qi], bag[0]];
  const st = { ...s, bag, drawbacks: { ...s.drawbacks, regicideBag: [{ holder: 1, letter: 'Q', fromEnd: bag.length - 1 }] } };
  const next = changeValues(st, applyHumanPlay(st, [{ row: 7, col: 7, letter: 'A' }, { row: 7, col: 8, letter: 'B' }], anyWord));
  assert.ok(rackOf(next, 1).includes('Q0'));
  assert.deepEqual(next.drawbacks.regicideBag, []);
});

test('Decay: kept tiles lose a point each turn; played ones keep it for everyone; exchanging restores', () => {
  let s = drawbacksGame('CATSDOG', 'EEIRSTN', { player: 52, wally: 1 });
  let next = step(s, applyPass(s, 1));
  assert.deepEqual(rackOf(next, 1), ['A0', 'C2', 'D1', 'G1', 'O0', 'S0', 'T0']);
  next = step(next, applyPass(next, 2));

  s = next;
  next = step(s, applyHumanPlay(s, [
    { row: 7, col: 6, letter: 'C' }, { row: 7, col: 7, letter: 'A' }, { row: 7, col: 8, letter: 'T' },
  ], anyWord));
  for (const p of [1, 2]) assert.deepEqual(boardOf(next, p), { '7,6': 2, '7,7': 0, '7,8': 0 });
  // S D O G kept again: D and G drop to 0; S and O stay at 0 (never below).
  assert.deepEqual(rackOf(next, 1).filter(t => 'SDOG'.includes(t[0])), ['D0', 'G0', 'O0', 'S0']);
  assertTileConservation(next);

  s = step(next, applyPass(next, 2));
  next = step(s, applyExchange(s, 1, ['G']));
  assert.ok(!rackOf(next, 1).includes('G0') || next.racks[1].filter(l => l === 'G').length > 1);
  assert.equal(next.drawbacks.regicideBag.length, 0);
});

test('Goose Egg: 2 more random tiles go to 0 each turn, until exchanged', () => {
  let s = applyOpeningDeal(drawbacksGame('CATSDOG', 'EEIRSTN', { player: 64, wally: 1 }));
  assert.equal(rackOf(s, 1).length, 2);
  assert.ok(rackOf(s, 1).every(t => t.endsWith('0')));

  let next = step(s, applyPass(s, 1));
  next = step(next, applyPass(next, 2));
  assert.equal(rackOf(next, 1).length, 4);

  const egg = next.drawbacks.values[1].rack[0].letter;
  const after = changeValues(next, applyExchange(next, 1, [egg]));
  assert.equal(rackOf(after, 1).length, 3);
});
