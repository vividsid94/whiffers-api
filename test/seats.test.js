// Multiplayer seats (MULTIPLAYER_PLAN.md phase 1): either seat can be a
// person, and each seat sees the game from its own side.
import test from 'node:test';
import assert from 'node:assert/strict';
import { origPool } from '../rules/staticData.js';
import { createState, applyHumanPlay, applyExchange, applyResign, assertTileConservation, MoveError } from '../games/engine.js';
import { toClientSnapshot } from '../games/view.js';
import { isValidWord } from '../games/dictionary.js';

const nwl = (w) => isValidWord('NWL23', w);

function bagStartingWith(rack1, rack2) {
  const rest = origPool.split('');
  for (const t of [...rack1, ...rack2]) rest.splice(rest.indexOf(t), 1);
  return [...rack1, ...rack2, ...rest];
}

function mpGame(rack1 = 'CATSDOG', rack2 = 'EEIRSTN', firstPlayer = 2) {
  return {
    ...createState({ mode: 'classic', lexicon: 'NWL23', opponentId: 'friend', bag: bagStartingWith(rack1.split(''), rack2.split('')), firstPlayer }),
    multiplayer: true,
  };
}

const across = (word, row, col) => word.split('').map((letter, i) => ({ row, col: col + i, letter, isBlank: false }));

test('seat 2 plays as a person; seat 1 can\'t move out of turn', () => {
  let s = mpGame();
  assert.throws(() => applyHumanPlay(s, across('CAT', 7, 6), nwl), (e) => e instanceof MoveError && e.code === 'not_your_turn');
  s = applyHumanPlay(s, across('TIRES', 7, 5), nwl, { player: 2 });
  assert.equal(s.history[0].player, 2);
  assert.equal(s.scores[2] > 0, true);
  assert.equal(s.racks[2].length, 7);
  assert.equal(s.currentPlayer, 1);
  assertTileConservation(s);
  // and seat 2 can't play twice in a row
  assert.throws(() => applyHumanPlay(s, across('NE', 8, 5), nwl, { player: 2 }), (e) => e.code === 'not_your_turn');
});

test('seat 2 can\'t play tiles that are only on seat 1\'s rack', () => {
  const s = mpGame();
  assert.throws(() => applyHumanPlay(s, across('COG', 7, 6), nwl, { player: 2 }), (e) => e.code === 'invalid_move');
});

test('either seat can resign; the other wins', () => {
  const s = mpGame();
  assert.equal(applyResign(s, 2).final.winner, 'player'); // seat 1
  assert.equal(applyResign(s, 1).final.winner, 'bot'); // seat 2
  assert.equal(applyResign(s, 2).history.at(-1).player, 2);
});

test('each seat sees its own rack, its own side, and nothing of the opponent\'s rack', () => {
  let s = mpGame();
  s = applyHumanPlay(s, across('TIRES', 7, 5), nwl, { player: 2 });
  s = applyExchange(s, 1, ['C', 'D']);
  const v1 = toClientSnapshot('g', 3, s, { seat: 1 });
  const v2 = toClientSnapshot('g', 3, s, { seat: 2 });

  assert.deepEqual(v1.myRack, s.racks[1]);
  assert.deepEqual(v2.myRack, s.racks[2]);
  assert.equal(v1.seat, 1);
  assert.equal(v2.seat, 2);
  assert.equal(v1.multiplayer, true);
  assert.equal(v1.botPending, false);

  // Scores and turn are from each viewer's side.
  assert.equal(v2.scores.player1, s.scores[2]);
  assert.equal(v2.scores.player2, s.scores[1]);
  assert.equal(s.currentPlayer, 2);
  assert.equal(v2.currentPlayer, 1); // seat 2's turn = "your turn" for seat 2
  assert.equal(v1.currentPlayer, 2);

  // History: your own moves are player 1; the opponent's rack and exchanged
  // tiles stay hidden until the game ends; nobody is "the bot".
  assert.equal(v2.history[0].player, 1);
  assert.equal(v1.history[0].player, 2);
  assert.equal(v1.history[0].rack, undefined);
  assert.equal(v2.history[0].rack, 'EEINRST');
  assert.equal(v2.history[1].exchanged, undefined);
  assert.equal(v2.history[1].exchangedCount, 2);
  assert.deepEqual(v1.history[1].exchanged, ['C', 'D']);
  assert.equal(v1.history.some(h => h.isBot), false);

  // Unseen = bag + the opponent's rack, never your own.
  assert.deepEqual([...v2.unseen].sort(), [...s.bag, ...s.racks[1]].sort());
  assert.equal(v2.opponentRackCount, s.racks[1].length);

  // Nothing in either snapshot is the other seat's rack.
  assert.equal(JSON.stringify(v1).includes(`"myRack":${JSON.stringify(s.racks[2])}`), false);
});

test('game over: the winner and final scores turn round for seat 2', () => {
  const s = applyResign(mpGame(), 1); // seat 1 resigns, seat 2 wins
  const v1 = toClientSnapshot('g', 1, s, { seat: 1 });
  const v2 = toClientSnapshot('g', 1, s, { seat: 2 });
  assert.equal(v1.final.winner, 'bot'); // "your opponent won"
  assert.equal(v2.final.winner, 'player'); // "you won"
  assert.equal(v2.final.player1Score, s.final.player2Score);
  assert.deepEqual(v2.final.opponentRack, s.racks[1]);
});

test('bot games look exactly as before: seat 1 by default', () => {
  const s = createState({ mode: 'classic', lexicon: 'NWL23', opponentId: 'wally', bag: bagStartingWith('CATSDOG'.split(''), 'EEIRSTN'.split('')), firstPlayer: 1 });
  const v = toClientSnapshot('g', 0, s);
  assert.deepEqual(v.myRack, s.racks[1]);
  assert.equal(v.botPending, false);
  assert.equal(v.multiplayer, false);
  const s2 = { ...s, currentPlayer: 2 };
  assert.equal(toClientSnapshot('g', 0, s2).botPending, true);
});

test('Drawbacks: a hidden score cut stays hidden from the opponent only', () => {
  // A multiplayer Drawbacks state where seat 1 played a cut (Nerf War-style)
  // move: 6 points scored, 14 shown at full value, 8 hidden.
  let s = mpGame('CATSDOG', 'EEIRSTN', 1);
  s = applyHumanPlay(s, across('CAT', 7, 6), nwl, { score: 6 });
  s = {
    ...s,
    mode: 'drawbacks',
    drawbacks: {
      ids: { 1: 17, 2: 3 }, zones: [], rolls: {}, loss: null, wallyHiddenPoints: 0,
      hiddenPoints: { 1: 8, 2: 0 }, boardBeforeLastPlay: null, turnInfo: null,
    },
    history: [{ ...s.history[0], fullScore: 14, hiddenAfter: 8 }],
  };
  const mine = toClientSnapshot('g', 1, s, { seat: 1 });
  const theirs = toClientSnapshot('g', 1, s, { seat: 2 });
  assert.equal(mine.scores.player1, 6);
  assert.equal(mine.history[0].score, 6);
  assert.equal(theirs.scores.player2, 14); // the opponent sees the full value
  assert.equal(theirs.history[0].score, 14);
  assert.equal(theirs.history[0].total, 14);
  // Drawbacks stay private until the end.
  assert.equal(mine.drawbacks.mine, 17);
  assert.equal(mine.drawbacks.wally, null);
  assert.equal(theirs.drawbacks.mine, 3);
  assert.equal(theirs.drawbacks.wally, null);
  // At game over everything is revealed.
  const over = applyResign(s, 2);
  const end = toClientSnapshot('g', 2, over, { seat: 2 });
  assert.equal(end.drawbacks.wally, 17);
  assert.equal(end.drawbacks.wallyHiddenPoints, 8);
  assert.equal(end.history[0].score, 6);
});

test('hideScoreCut: tallies per seat in multiplayer, keeps Wally\'s old tally in bot games', async () => {
  const { hideScoreCut } = await import('../games/drawbacks.js');
  const base = (multiplayer) => ({
    multiplayer,
    history: [{ player: 1, type: 'play', score: 6 }],
    drawbacks: { ids: { 1: 17, 2: 17 }, wallyHiddenPoints: 0, hiddenPoints: { 1: 0, 2: 0 } },
  });
  const move = { score: 14, fullScore: 14 };
  const mp = hideScoreCut(base(true), 1, move, { score: 6 });
  assert.equal(mp.drawbacks.hiddenPoints[1], 8);
  assert.equal(mp.drawbacks.wallyHiddenPoints, 0);
  assert.equal(mp.history[0].hiddenAfter, 8);
  const bot = hideScoreCut({ ...base(false), history: [{ player: 2, type: 'play', score: 6 }] }, 2, move, { score: 6 });
  assert.equal(bot.drawbacks.wallyHiddenPoints, 8);
  assert.equal(bot.history[0].hiddenAfter, 8);
  // A drawback that isn't a giveaway hides nothing.
  const plain = hideScoreCut({ ...base(true), drawbacks: { ...base(true).drawbacks, ids: { 1: 3, 2: 3 } } }, 1, move, { score: 6 });
  assert.equal(plain.history[0].hiddenAfter, undefined);
});
