// Drawbacks mode for server-run games: each side plays under a handicap
// ("drawback"). The rules themselves live in ONE place - the Go move
// generator's drawbacks.go - and this module asks it about each turn:
//
//   /drawback-moves  which moves a player's drawback allows (judging the
//                    human's move, picking the bot's), plus the panel info
//   /drawback-loss   whose lose condition broke after a turn / at game end
//
// What lives here is the game around those rules: dealing the drawbacks,
// per-game and per-turn rolls (Minefield zones, Shifting Sands squares,
// Quota numbers - rolled and kept on the server so they can't be peeked or
// rerolled), turning the engine's history into Go's turn format, ending the
// game on a broken lose condition, Nerf War's hidden score, and Wally
// stepping in when neither side can open.
//
// state.drawbacks = {
//   ids: { 1, 2 },                 each side's drawback id
//   zones: [{ row, col, holder }], Minefield's 3x3 zones
//   rolls: { [turnIndex]: { quota?, blocked? } }   rolled for whoever moves then
//   loss: null | { player, reason } | { both: true, reason }
//   wallyHiddenPoints,             Nerf War points Wally's board hides until the end
//   boardBeforeLastPlay,           for I'll Take That
//   turnInfo: { turnIndex, playableCount, canExchange, forced, opened } (the human's turn)
// }

import crypto from 'crypto';
import { buildBoardForRequest, GO_SERVICE_URL } from '../rules/boardRequest.js';
import {
  applyBotMove, applyExchange, applyPass, applyHumanPlay, finalizeDrawbackLoss, finalizeNow, MoveError,
} from './engine.js';

// Every drawback the Go registry has: the original #1-#40, plus the new ones
// as they're built (his list, #41-#64). Add an id here when its rule lands
// in drawbacks.go.
export const DRAWBACK_IDS = [
  ...Array.from({ length: 40 }, (_, i) => i + 1),
  43, 45, 46, 47, 49, 58, 61, // batch 1
];
const QUOTA = 14;
const SHIFTING_SANDS = 7;
const SHIFTING_SANDS_SQUARES = 60;
const MINEFIELD = 38;
const NERF_WAR = 17;

const GO_TIMEOUT_MS = 15000;
const STEP_IN_DRAWS = 5;

export class DrawbacksUnavailableError extends Error {}

async function postGo(path, body) {
  let response;
  try {
    response = await fetch(`${GO_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(GO_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DrawbacksUnavailableError(`Go ${path} unreachable: ${err.message}`);
  }
  if (!response.ok) throw new DrawbacksUnavailableError(`Go ${path} HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

const randomInt = (n) => crypto.randomInt(n);
const isLetter = (cell) => typeof cell === 'string';

// --- Setting up -------------------------------------------------------------

// A random 3x3 zone touching the board's edge (drawbacks.go rollClaustroZone).
function rollZone(holder) {
  const options = [];
  for (let r = 0; r <= 12; r++) for (let c = 0; c <= 12; c++) {
    if (r === 0 || r === 12 || c === 0 || c === 12) options.push({ row: r, col: c });
  }
  return { ...options[randomInt(options.length)], holder };
}

// picks: { player, wally } - a forced drawback id for either side (the
// start screen's Testing picker), else random. Both sides draw
// independently, so they can get the same one.
export function createDrawbackState(picks = {}) {
  const pick = (id) => (DRAWBACK_IDS.includes(id) ? id : DRAWBACK_IDS[randomInt(DRAWBACK_IDS.length)]);
  const ids = { 1: pick(picks.player), 2: pick(picks.wally) };
  return {
    ids,
    zones: [1, 2].filter(p => ids[p] === MINEFIELD).map(rollZone),
    rolls: {},
    loss: null,
    wallyHiddenPoints: 0,
    boardBeforeLastPlay: null,
    turnInfo: null,
  };
}

// This turn's rolls for whoever is to move (made once, then kept).
function ensureRolls(state) {
  const turnIndex = state.history.length;
  const id = state.drawbacks.ids[state.currentPlayer];
  if (state.drawbacks.rolls[turnIndex] || (id !== QUOTA && id !== SHIFTING_SANDS)) return state;
  const roll = {};
  if (id === QUOTA) roll.quota = [1 + randomInt(7), 1 + randomInt(7)];
  if (id === SHIFTING_SANDS) {
    const squares = [];
    for (let r = 0; r < 15; r++) for (let c = 0; c < 15; c++) if (!(r === 7 && c === 7)) squares.push([r, c]);
    for (let i = squares.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [squares[i], squares[j]] = [squares[j], squares[i]];
    }
    roll.blocked = squares.slice(0, SHIFTING_SANDS_SQUARES);
  }
  return { ...state, drawbacks: { ...state.drawbacks, rolls: { ...state.drawbacks.rolls, [turnIndex]: roll } } };
}

// --- Talking to Go ----------------------------------------------------------

// The engine's history in Go's SimTurn shape. Wally's step-in opener is
// nobody's turn, so it goes as player 0 (every per-player rule skips it;
// "the last word on the board" rules still see it).
export function toSimTurns(history) {
  return history.filter(h => h.type !== 'resign').map((h) => ({
    player: h.stepIn ? 0 : h.player,
    type: h.type,
    word: h.words?.[0] ?? '',
    score: h.score,
    direction: h.direction ?? '',
    tiles: h.simTiles ?? h.placed.map(t => ({ ...t, isNew: true })),
    rackBefore: h.rack ?? '',
    tilesExchanged: (h.exchanged ?? []).join(''),
    runningTotal: h.total,
    wordStarts: h.wordStarts ?? [],
  }));
}

function movesRequest(state, player, extra = {}) {
  const d = state.drawbacks;
  const roll = d.rolls[state.history.length] ?? {};
  return {
    board: buildBoardForRequest(state.board, state.blankTiles),
    rack: state.racks[player].join(''),
    lexicon: state.lexicon,
    poolSize: state.bag.length,
    drawbackId: d.ids[player],
    player,
    turns: toSimTurns(state.history),
    boardBeforeLastPlay: d.boardBeforeLastPlay ?? undefined,
    blockedSquares: roll.blocked,
    quota: roll.quota,
    ...extra,
  };
}

// The history fields every drawback play carries, from Go's judged move.
function playExtra(move) {
  return { simTiles: move.tiles, direction: move.direction, wordStarts: move.wordStarts ?? [], fullScore: move.fullScore };
}

// --- The human's turn -------------------------------------------------------

// Before the human moves: this turn's rolls, and what the panel shows (how
// many plays fit, whether exchanging is allowed, whether a "must" bites,
// I'll Take That's opened squares). Never throws - a Go hiccup just leaves
// the panel without it.
export async function prepareHumanTurn(state) {
  if (state.mode !== 'drawbacks' || state.ended || state.currentPlayer !== 1) return state;
  const next = ensureRolls(state);
  try {
    const info = await postGo('/drawback-moves', movesRequest(next, 1, { limit: 0 }));
    return {
      ...next,
      drawbacks: {
        ...next.drawbacks,
        turnInfo: {
          turnIndex: next.history.length,
          playableCount: info.playableCount,
          canExchange: info.canExchange,
          forced: info.forced ?? null,
          opened: info.opened ?? [],
        },
      },
    };
  } catch (err) {
    console.error('Drawback turn info failed:', err.message);
    return next;
  }
}

// The human's word play: the engine's own checks first (rack, placement,
// dictionary), then the drawback. Throws MoveError when either refuses.
export async function applyHumanDrawbackPlay(state, tiles, isValidWord) {
  applyHumanPlay(state, tiles, isValidWord); // throws on an illegal play
  const ready = ensureRolls(state);
  const judged = await postGo('/drawback-moves', movesRequest(ready, 1, {
    proposed: tiles.map(t => ({ row: t.row, col: t.col, letter: t.letter, isBlank: !!t.isBlank })),
  }));
  if (!judged.proposedAllowed || !judged.proposed) {
    throw new MoveError('invalid_move', judged.proposedReason || "Your drawback doesn't allow that move");
  }
  const move = judged.proposed;
  return applyHumanPlay(ready, tiles, isValidWord, { score: move.score, extra: playExtra(move) });
}

export async function applyHumanDrawbackExchange(state, letters) {
  const ready = ensureRolls(state);
  if (ready.bag.length >= 7) {
    const judged = await postGo('/drawback-moves', movesRequest(ready, 1, { proposedExchange: letters.join('') }));
    if (!judged.proposedAllowed) {
      throw new MoveError('invalid_move', judged.proposedReason || "Your drawback doesn't allow that exchange");
    }
  }
  return applyExchange(ready, 1, letters);
}

// --- The bot's turn ---------------------------------------------------------

// Wally plays the best move his drawback allows (avoiding his own lose rule
// and Minefield zone when he can), or passes when nothing fits.
export async function runDrawbackBotTurn(state) {
  const ready = ensureRolls(state);
  const d = ready.drawbacks;
  const data = await postGo('/drawback-moves', movesRequest(ready, 2, {
    forBot: true, limit: 5, zones: d.zones.filter(z => z.holder === 2),
  }));
  for (const move of data.moves ?? []) {
    try {
      if (move.isExchange) return applyExchange(ready, 2, move.exchangeTiles.split(''));
      let next = applyBotMove(ready, move, { score: move.score, extra: playExtra(move) });
      // Nerf War: his board shows the normal score until the game ends.
      const hidden = (move.fullScore ?? move.score) - move.score;
      if (d.ids[2] === NERF_WAR && hidden > 0) {
        const wallyHiddenPoints = d.wallyHiddenPoints + hidden;
        const history = [...next.history];
        history[history.length - 1] = { ...history[history.length - 1], hiddenAfter: wallyHiddenPoints };
        next = { ...next, history, drawbacks: { ...next.drawbacks, wallyHiddenPoints } };
      }
      return next;
    } catch (err) {
      if (!(err instanceof MoveError)) throw err;
      console.error('Drawback bot candidate rejected by engine:', err.reason);
    }
  }
  return applyPass(ready, 2);
}

// --- After every move -------------------------------------------------------

const lossFrom = (losses) => {
  if (losses.length === 0) return null;
  if (losses.length === 1) return losses[0];
  return { both: true, reason: losses.map(l => l.reason).join('; ') };
};

// Runs after each move (`before` -> `after`): remembers the board for I'll
// Take That, checks both players' lose conditions (and the end-of-game ones
// when the game just ended), and lets Wally step in after an empty-board
// six-pass. One breaker loses (scored 0); two at once cancel out.
export async function afterDrawbackMove(before, after) {
  if (after.mode !== 'drawbacks') return after;
  let next = after;
  const entry = next.history[next.history.length - 1];
  if (entry?.type === 'play' && !entry.stepIn) {
    next = { ...next, drawbacks: { ...next.drawbacks, boardBeforeLastPlay: buildBoardForRequest(before.board, before.blankTiles) } };
  }
  const d = next.drawbacks;
  const ids = [d.ids[1], d.ids[2]];

  if (entry && entry.type !== 'resign' && !entry.stepIn && !d.loss) {
    let loss = null;
    // Minefield: whoever places a tile in a zone loses, holder or not.
    if (entry.type === 'play' && entry.placed.some(t => d.zones.some(z => t.row >= z.row && t.row < z.row + 3 && t.col >= z.col && t.col < z.col + 3))) {
      loss = { player: entry.player, reason: 'Minefield: played inside the zone' };
    }
    if (!loss) {
      const result = await postGo('/drawback-loss', {
        drawbackIds: ids,
        turns: toSimTurns(next.history),
        poolSizeBefore: before.bag.length,
        gameEnding: next.ended,
      });
      loss = lossFrom(result.losses ?? []);
    }
    if (!loss && next.ended && next.endReason !== 'resigned') {
      const result = await postGo('/drawback-loss', { drawbackIds: ids, turns: toSimTurns(next.history), atGameEnd: true });
      loss = lossFrom(result.losses ?? []);
    }
    if (loss) {
      if (loss.both) {
        next = { ...(next.ended ? next : finalizeNow(next, 'bothDrawbackLoss')) };
      } else {
        next = finalizeDrawbackLoss(next, loss.player);
      }
      next = { ...next, drawbacks: { ...next.drawbacks, loss } };
    }
  }

  if (next.stepInPending && !next.ended) next = await stepIn(next);
  return next;
}

// Wally steps in: neither drawback could open, and six scoreless turns
// passed on an empty board. He draws 7 random tiles from the bag, puts the
// best word they make on the centre for nobody's points, and play carries on
// with the next player (already set by the engine).
async function stepIn(state) {
  for (let i = 0; i < STEP_IN_DRAWS; i++) {
    const bag = state.bag.map((letter, index) => ({ letter, index })).filter(t => t.letter !== '?');
    const drawn = [];
    while (drawn.length < 7 && bag.length) drawn.push(bag.splice(randomInt(bag.length), 1)[0]);
    let data;
    try {
      data = await postGo('/generate-moves', {
        board: buildBoardForRequest(state.board, state.blankTiles),
        rack: drawn.map(t => t.letter).join(''), topN: 1, poolSize: state.bag.length, lexicon: state.lexicon,
      });
    } catch (err) {
      console.error('Step-in failed:', err.message);
      break;
    }
    const play = (data.moves ?? []).find(m => !m.isExchange && m.tiles?.length > 0);
    if (!play) continue;
    const placed = play.tiles.filter(t => t.isNew).map(t => ({ row: t.row, col: t.col, letter: String(t.letter).toUpperCase(), isBlank: false }));
    const board = structuredClone(state.board);
    const bagLeft = [...state.bag];
    for (const t of placed) {
      board[t.row][t.col] = t.letter;
      bagLeft.splice(bagLeft.indexOf(t.letter), 1);
    }
    const word = placed.map(t => t.letter).join('');
    return {
      ...state,
      board,
      bag: bagLeft,
      scorelessRun: 0,
      stepInPending: false,
      history: [...state.history, {
        player: 2, type: 'play', stepIn: true, placed, words: [word], score: 0, total: state.scores[2], rack: '',
        simTiles: play.tiles.map(t => ({ ...t, letter: String(t.letter).toUpperCase(), isBlank: false })),
        direction: play.direction ?? (placed.length > 1 && placed[0].row === placed[1].row ? 'right' : 'down'),
      }],
    };
  }
  return finalizeNow({ ...state, stepInPending: false }, 'sixScoreless');
}
