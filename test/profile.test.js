// Profile stats (games/profile.js) from saved-game lines, newest first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { profileStats } from '../games/profile.js';

const DAY = 86400000;
const NOW = Date.parse('2026-11-22T12:00:00Z');
let n = 0;
const line = (o) => ({
  id: `g${++n}`, source: 'bot', mode: 'classic', lexicon: 'NWL23', dailyDate: null, endReason: 'wentOut',
  opponent: { name: 'Wally', kind: 'bot', botId: 'wally' }, you: { score: 400 }, them: { score: 350 },
  result: 'win', moves: 24, bingos: 1, bestPlay: { score: 80, word: 'QUARTZY', isBingo: true }, comeback: 0, ...o,
});

test('totals, win rate, and averages that skip resigned games', () => {
  const lines = [
    line({ endedAt: NOW - 1 * DAY, you: { score: 420 }, result: 'win' }),
    line({ endedAt: NOW - 2 * DAY, you: { score: 30 }, them: { score: 90 }, result: 'loss', endReason: 'resigned', bingos: 0 }),
    line({ endedAt: NOW - 40 * DAY, you: { score: 380 }, result: 'win', bingos: 3 }),
  ];
  const s = profileStats(lines, NOW);
  assert.equal(s.games, 3);
  assert.equal(s.winRate, 67);
  assert.equal(s.avgScore, 400); // the 30 from the resigned game is left out
  assert.equal(s.bingos, 4);
  assert.equal(s.bingosPerGame, 1.33);
  assert.equal(s.recent.gamesThisWeek, 2);
  assert.equal(s.recent.winRate30, 50);
  assert.equal(s.recent.avgScore30, 420);
  assert.equal(s.highlights.bestGame.you, 420);
  assert.equal(s.highlights.mostBingos.bingos, 3);
  assert.equal(s.activity.length, 3);
});

test('streaks: current from the newest game, longest anywhere', () => {
  const results = ['win', 'win', 'loss', 'win', 'win', 'win', 'draw', 'win']; // newest first
  const s = profileStats(results.map((result, i) => line({ result, endedAt: NOW - i * DAY })), NOW);
  assert.deepEqual(s.streak, { current: 2, longest: 3 });
});

test('records by bot and by person, guests together; highlights point at their games', () => {
  const guest = { name: 'Guest', kind: 'guest', botId: null };
  const lines = [
    line({ endedAt: NOW - 1, opponent: guest, source: 'mp' }),
    line({ endedAt: NOW - 2, opponent: guest, source: 'mp', result: 'loss' }),
    line({ endedAt: NOW - 3, opponent: { name: 'Bob', kind: 'player', botId: null }, source: 'mp', comeback: 118 }),
    line({ endedAt: NOW - 4, opponent: { name: 'Diana', kind: 'bot', botId: 'diana' }, bestPlay: { score: 164, word: 'QUARTZY', isBingo: true } }),
    line({ endedAt: NOW - 5, mode: 'daily', dailyDate: '2026-11-21', result: 'loss' }),
  ];
  const s = profileStats(lines, NOW);
  assert.deepEqual(s.records.bots.map((b) => [b.name, b.games, b.wins, b.losses]).sort(), [['Diana', 1, 1, 0], ['Wally', 1, 0, 1]]);
  assert.deepEqual(s.records.people.opponents.map((o) => [o.name, o.wins, o.losses]), [['Guest', 1, 1], ['Bob', 1, 0]]);
  assert.equal(s.records.people.games, 3);
  assert.equal(s.highlights.bestPlay.score, 164);
  assert.equal(s.highlights.bestPlay.game.opponent.name, 'Diana');
  assert.equal(s.highlights.biggestComeback.deficit, 118);
  assert.deepEqual(s.daily, [{ date: '2026-11-21', result: 'loss', score: 400, id: lines[4].id }]);
  assert.equal(s.modes.daily.games, 1);
});

test('no games: zeros and nulls, nothing breaks', () => {
  const s = profileStats([], NOW);
  assert.equal(s.games, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.highlights.bestPlay, null);
  assert.deepEqual(s.streak, { current: 0, longest: 0 });
});
