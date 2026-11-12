// The authoritative game engine for server-run games (Classic, Daily and
// Drawbacks - drawbacks.js adds that mode's rules around these functions).
// Pure functions over a plain state object: no database, no network, no
// clock. routes.js loads a state, calls one of these, saves the result.
//
// Every function returns a NEW state (the input is never mutated) and throws
// MoveError for anything the rules don't allow - the caller turns that into
// a 422/409, never a partial write.
//
// Player 1 is always the human, player 2 the bot, matching the frontend's
// gameStore. Rules mirror the frontend exactly (rules/ holds the copies):
// draws come off the front of the bag, exchanged tiles go to the back, a
// play resets the scoreless run, a pass or 0-point exchange adds to it, six
// in a row ends the game, and going out (rack + bag empty) ends it too.

import { validatePlacement } from '../rules/boardPlacement.js';
import { calculateScore } from '../rules/scoreFunctions.js';
import { origPool, PREMIUM_GRID, freshBoard } from '../rules/staticData.js';
import { alphabetizeRack, drawTiles, removeTilesByCount, rackHasTiles } from '../rules/rack.js';
import { computeFinalScores, determineWinner } from '../rules/gameEnd.js';

export const ENGINE_VERSION = 1;
const SCORELESS_TURNS_TO_END = 6;

export class MoveError extends Error {
  // code: 'not_your_turn' | 'game_over' | 'invalid_move'
  constructor(code, reason, extra = {}) {
    super(reason);
    this.code = code;
    this.reason = reason;
    Object.assign(this, extra);
  }
}

const isLetter = (cell) => typeof cell === 'string';
const clone = (value) => structuredClone(value);
const other = (player) => (player === 1 ? 2 : 1);

// bag: the full, already-shuffled 100 tiles. The first 7 go to the human and
// the next 7 to the bot - the same order gameStore.initializeGame deals, so
// a Daily's legacy deal reproduces exactly.
export function createState({ mode, lexicon, opponentId, dailyDate = null, bag, firstPlayer }) {
  const remaining = [...bag];
  const rack1 = alphabetizeRack(remaining.splice(0, 7));
  const rack2 = alphabetizeRack(remaining.splice(0, 7));
  return {
    engineVersion: ENGINE_VERSION,
    mode,
    lexicon,
    opponentId,
    dailyDate,
    bag: remaining,
    racks: { 1: rack1, 2: rack2 },
    board: freshBoard(),
    blankTiles: [],
    scores: { 1: 0, 2: 0 },
    currentPlayer: firstPlayer,
    firstPlayer,
    scorelessRun: 0,
    history: [],
    ended: false,
    endReason: null,
    final: null,
    opponentMood: null,
  };
}

function assertTurn(state, player) {
  if (state.ended) throw new MoveError('game_over', 'The game is over');
  if (state.currentPlayer !== player) throw new MoveError('not_your_turn', 'Not your turn');
}

// Places `tiles` ({row, col, letter, isBlank}) for `player` and commits the
// play: score, refill, history, then end-or-switch. Shared by the human path
// (after dictionary checks) and the bot path (Go's move, already legal).
// opts (Drawbacks only): score - what the play scores under the player's
// drawback (Nerf War); extra - more fields for the history entry.
function commitPlay(state, player, tiles, words, opts = {}) {
  const next = clone(state);
  const afterBoard = clone(state.board);
  const newBlanks = [];
  for (const t of tiles) {
    afterBoard[t.row][t.col] = t.letter;
    if (t.isBlank) newBlanks.push({ row: t.row, col: t.col });
  }
  const score = opts.score ?? calculateScore(state.board, afterBoard, PREMIUM_GRID, [...state.blankTiles, ...newBlanks]);
  const rackBefore = state.racks[player];
  const rack = removeTilesByCount(rackBefore, tiles.map(t => (t.isBlank ? '?' : t.letter)));
  // rackSizes (Drawbacks - Short-handed): a player whose rack holds fewer.
  drawTiles(rack, next.bag, (state.rackSizes?.[player] ?? 7) - rack.length);

  next.board = afterBoard;
  next.blankTiles = [...state.blankTiles, ...newBlanks];
  next.racks[player] = alphabetizeRack(rack);
  next.scores[player] = state.scores[player] + score;
  next.scorelessRun = 0;
  next.history.push({
    player,
    type: 'play',
    placed: tiles.map(({ row, col, letter, isBlank }) => ({ row, col, letter, isBlank: !!isBlank })),
    words,
    score,
    total: next.scores[player],
    rack: rackBefore.join(''),
    isBingo: tiles.length === 7,
    ...opts.extra,
  });

  if (next.racks[player].length === 0 && next.bag.length === 0) return finalize(next, 'wentOut');
  next.currentPlayer = other(player);
  return next;
}

// The human's word play. `isValidWord(word)` is the lexicon check (games/
// dictionary.js), passed in so this stays pure and testable.
export function applyHumanPlay(state, tiles, isValidWord, opts = {}) {
  assertTurn(state, 1);
  if (!Array.isArray(tiles) || tiles.length < 1 || tiles.length > 7) {
    throw new MoveError('invalid_move', 'Place between 1 and 7 tiles');
  }
  const seen = new Set();
  for (const t of tiles) {
    const key = `${t.row},${t.col}`;
    if (seen.has(key)) throw new MoveError('invalid_move', 'Two tiles on one square');
    seen.add(key);
    if (isLetter(state.board[t.row][t.col])) throw new MoveError('invalid_move', 'That square is taken');
  }
  if (!rackHasTiles(state.racks[1], tiles.map(t => (t.isBlank ? '?' : t.letter)))) {
    throw new MoveError('invalid_move', "Those tiles aren't on your rack");
  }

  const afterBoard = clone(state.board);
  for (const t of tiles) afterBoard[t.row][t.col] = t.letter;
  const placement = validatePlacement(state.board, afterBoard);
  if (!placement.isValid) throw new MoveError('invalid_move', placement.reason);

  const invalidWords = placement.words.filter(w => !isValidWord(w));
  if (invalidWords.length > 0) {
    const invalidWordCoords = invalidWords.flatMap(w => placement.wordCoords.get(w) ?? []);
    throw new MoveError(
      'invalid_move',
      `Invalid word${invalidWords.length > 1 ? 's' : ''}: ${invalidWords.join(', ')}`,
      { invalidWords, invalidWordCoords },
    );
  }

  return commitPlay(state, 1, tiles, placement.words, opts);
}

// letters: the tiles to swap ('?' for a blank). Needs 7+ in the bag.
export function applyExchange(state, player, letters) {
  assertTurn(state, player);
  if (!Array.isArray(letters) || letters.length < 1 || letters.length > 7) {
    throw new MoveError('invalid_move', 'Exchange between 1 and 7 tiles');
  }
  if (state.bag.length < 7) throw new MoveError('invalid_move', 'Not enough tiles left in the bag to exchange');
  if (!rackHasTiles(state.racks[player], letters)) {
    throw new MoveError('invalid_move', "Those tiles aren't on your rack");
  }

  const next = clone(state);
  const rackBefore = state.racks[player];
  const rack = removeTilesByCount(rackBefore, letters);
  drawTiles(rack, next.bag, letters.length);
  next.bag.push(...letters);
  next.racks[player] = alphabetizeRack(rack);
  next.history.push({
    player,
    type: 'exchange',
    placed: [],
    words: [],
    score: 0,
    total: next.scores[player],
    rack: rackBefore.join(''),
    exchanged: [...letters],
  });
  return afterScorelessTurn(next, player);
}

export function applyPass(state, player) {
  assertTurn(state, player);
  const next = clone(state);
  next.history.push({
    player,
    type: 'pass',
    placed: [],
    words: [],
    score: 0,
    total: next.scores[player],
    rack: state.racks[player].join(''),
  });
  return afterScorelessTurn(next, player);
}

function afterScorelessTurn(next, player) {
  next.scorelessRun += 1;
  if (next.scorelessRun >= SCORELESS_TURNS_TO_END) {
    // Drawbacks: six scoreless turns on an empty board means neither
    // drawback can open - Wally steps in with an opener instead of the game
    // ending (drawbacks.js stepIn).
    if (next.mode === 'drawbacks' && isBoardEmpty(next.board)) {
      next.stepInPending = true;
      next.currentPlayer = other(player);
      return next;
    }
    return finalize(next, 'sixScoreless');
  }
  next.currentPlayer = other(player);
  return next;
}

// The bot's move as the Go service returns it: { isExchange, tiles:
// [{row, col, letter, isNew, isBlank}], word }. Checked against the real
// board and rack before it lands - Go is trusted for word validity in its
// own lexicon, not for which tiles the bot actually holds. The score is
// recomputed here with the same calculateScore the human gets.
export function applyBotMove(state, move, opts = {}) {
  assertTurn(state, 2);
  if (move.isExchange) {
    return applyExchange(state, 2, move.tiles.map(t => t.letter));
  }
  const tiles = (move.tiles || []).filter(t => t.isNew).map(t => ({
    row: t.row, col: t.col, letter: String(t.letter).toUpperCase(), isBlank: !!t.isBlank,
  }));
  if (tiles.length === 0) throw new MoveError('invalid_move', 'Bot move places no tiles');
  for (const t of tiles) {
    if (isLetter(state.board[t.row]?.[t.col]) || state.board[t.row]?.[t.col] === undefined) {
      throw new MoveError('invalid_move', 'Bot move lands on a taken square');
    }
  }
  if (!rackHasTiles(state.racks[2], tiles.map(t => (t.isBlank ? '?' : t.letter)))) {
    throw new MoveError('invalid_move', "Bot move uses tiles it doesn't hold");
  }
  const afterBoard = clone(state.board);
  for (const t of tiles) afterBoard[t.row][t.col] = t.letter;
  const placement = validatePlacement(state.board, afterBoard);
  if (!placement.isValid) throw new MoveError('invalid_move', `Bot move: ${placement.reason}`);
  return commitPlay(state, 2, tiles, placement.words, opts);
}

// The human resigns: the game ends now and the bot wins.
export function applyResign(state) {
  if (state.ended) throw new MoveError('game_over', 'The game is over');
  const next = clone(state);
  next.history.push({ player: 1, type: 'resign', placed: [], words: [], score: 0, total: next.scores[1] });
  return finalize(next, 'resigned');
}

export const isBoardEmpty = (board) => board.every(row => row.every(cell => !isLetter(cell)));

// Drawbacks: a lose condition ended the game. `loserPlayer` scores 0 and the
// winner keeps their score as it stands (so the winner always has more).
export function finalizeDrawbackLoss(state, loserPlayer) {
  const next = clone(state);
  next.ended = true;
  next.endReason = 'drawbackLoss';
  next.stepInPending = false;
  next.final = {
    player1Score: loserPlayer === 1 ? 0 : next.scores[1],
    player2Score: loserPlayer === 2 ? 0 : next.scores[2],
    winner: loserPlayer === 1 ? 'bot' : 'player',
  };
  return next;
}

// Drawbacks: both players broke a lose condition at once mid-game - the
// losses cancel and the game ends here, scored normally.
export function finalizeNow(state, endReason) {
  return finalize(clone(state), endReason);
}

// Ends the game in place - only ever called on a state this module has
// already cloned for the current move.
function finalize(next, endReason) {
  next.ended = true;
  next.endReason = endReason;
  if (endReason === 'resigned') {
    next.final = { player1Score: next.scores[1], player2Score: next.scores[2], winner: 'bot' };
    return next;
  }
  const { finalPlayer1Score, finalPlayer2Score } = computeFinalScores({
    player1points: next.scores[1],
    player2points: next.scores[2],
    player1Rack: next.racks[1],
    player2Rack: next.racks[2],
  });
  next.final = {
    player1Score: finalPlayer1Score,
    player2Score: finalPlayer2Score,
    winner: determineWinner({ finalPlayer1Score, finalPlayer2Score }),
  };
  return next;
}

// Every tile accounted for exactly once: board (a blank counts as '?') +
// both racks + bag must be the 100-tile set. Cheap, so routes.js runs it
// before every save - a bug here should refuse to write, not corrupt a game.
export function assertTileConservation(state) {
  const counts = {};
  const add = (t) => { counts[t] = (counts[t] || 0) + 1; };
  const blanks = new Set(state.blankTiles.map(b => `${b.row},${b.col}`));
  state.board.forEach((row, r) => row.forEach((cell, c) => {
    if (isLetter(cell)) add(blanks.has(`${r},${c}`) ? '?' : cell);
  }));
  state.racks[1].forEach(add);
  state.racks[2].forEach(add);
  state.bag.forEach(add);
  // Drawbacks (Demotion / Unusual): tiles that changed letter, on a rack or
  // the board, count as the letter they started as.
  const d = state.drawbacks;
  for (const c of [...(d?.changed?.[1] ?? []), ...(d?.changed?.[2] ?? []), ...(d?.playedChanged ?? [])]) {
    counts[c.now] = (counts[c.now] || 0) - 1;
    add(c.was);
  }
  const expected = {};
  for (const t of origPool) expected[t] = (expected[t] || 0) + 1;
  const keys = new Set([...Object.keys(counts), ...Object.keys(expected)]);
  for (const k of keys) {
    if ((counts[k] || 0) !== (expected[k] || 0)) {
      throw new Error(`Tile conservation failed for ${k}: have ${counts[k] || 0}, expected ${expected[k] || 0}`);
    }
  }
}
