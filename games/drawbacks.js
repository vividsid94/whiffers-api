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
//   changed: { 1: [{ now, was }], 2: [...] }  Demotion / Unusual: rack tiles that
//                                  aren't their original letter any more
//   playedChanged: [{ now, was }]  such tiles that went onto the board (for good)
//   values: { 1: { rack: [{ letter, value }], board: { "r,c": value } }, 2: ... }
//                                  Regicide / Decay / Goose Egg: what tiles are worth
//                                  to that player, where it isn't the normal value
//                                  (rack: one entry per affected copy)
//   regicideBag: [{ holder, letter, fromEnd }]  Regicide tiles exchanged back into
//                                  the bag (still 0 if their holder draws them again)
//   valueTurn                      the turn the start-of-turn zeroing last ran on
// }

import crypto from 'crypto';
import { buildBoardForRequest, GO_SERVICE_URL } from '../rules/boardRequest.js';
import { alphabetizeRack, removeTilesByCount } from '../rules/rack.js';
import { letterScores } from '../rules/scoreFunctions.js';
import {
  applyBotMove, applyExchange, applyPass, applyHumanPlay, finalizeDrawbackLoss, finalizeNow, MoveError,
} from './engine.js';

// Every drawback the Go registry has: the original #1-#40, plus the new ones
// as they're built (his list, #41-#64). Add an id here when its rule lands
// in drawbacks.go.
export const DRAWBACK_IDS = [
  ...Array.from({ length: 40 }, (_, i) => i + 1),
  43, 45, 46, 47, 49, 58, 61, // batch 1
  42, 44, 50, 54, 55, 56, 62, 100, 101, 102, // batch 2 (100-102: Peer Pressure variants)
  48, 57, // batch 3
  41, 60, // batch 4
  53, 63, // batch 5
  51, 52, 64, // batch 6
];
const QUOTA = 14;
const SHIFTING_SANDS = 7;
const SHIFTING_SANDS_SQUARES = 60;
const MINEFIELD = 38;
const DROP_ZONE = 44;
const GHOSTLY_PRESENCE = 55;
const GHOST_CHANCE = 0.2;
const FLAVOR_OF_THE_DAY = 62;
const DEVIL = 57;
const SHORT_HANDED = 41;
const SHORT_HANDED_RACK = 6;
const RESTLESSNESS = 60;
const DEMOTION = 53;
const UNUSUAL = 63;
const UNUSUAL_CHANCE = 0.25;
const REGICIDE = 51;
const DECAY = 52;
const GOOSE_EGG = 64;
const GOOSE_EGGS = 2;
const VALUED = new Set([REGICIDE, DECAY, GOOSE_EGG]);
// Drawbacks whose score cut would give Wally's drawback away - his board
// shows normal scores until the game ends.
const HIDDEN_SCORE_CUTS = new Set([17, 48, 55, REGICIDE, DECAY, GOOSE_EGG]);
// Demotion: each letter drops to the next in its chain (the last stays put),
// a blank drops to S. Same as drawbacks.go demotionChains - keep in step.
const DEMOTES_TO = { '?': 'S' };
for (const chain of ['EAIOU', 'ZXJKQ', 'SRNTL', 'HMDCYPBFGWV']) {
  for (let i = 0; i + 1 < chain.length; i++) DEMOTES_TO[chain[i]] = chain[i + 1];
}
const DEVIL_CYCLE = 4;
const BONUS_KINDS = ['DLS', 'DWS', 'TLS', 'TWS'];
// Peer Pressure variants: how many rack tiles get highlighted each turn.
const PEER_PRESSURE_HIGHLIGHT = { 100: 4, 101: 3, 102: 5 };
const ROLLED = new Set([QUOTA, SHIFTING_SANDS, DROP_ZONE, FLAVOR_OF_THE_DAY, ...Object.keys(PEER_PRESSURE_HIGHLIGHT).map(Number)]);

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

// The opening deal under the drawbacks, run once right after they're dealt:
// Short-handed's smaller rack, and Unusual's vowels.
export function applyOpeningDeal(state) {
  let next = applyRackSizes(state);
  for (const p of [1, 2]) {
    if (next.drawbacks.ids[p] !== UNUSUAL) continue;
    const { rack, changed } = unusualDraws(next.racks[p], [], []);
    next = { ...next, racks: { ...next.racks, [p]: alphabetizeRack(rack) }, drawbacks: { ...next.drawbacks, changed: { ...next.drawbacks.changed, [p]: changed } } };
  }
  return startTurnValues(next);
}

// Unusual: each drawn vowel (A E I O) becomes a U with UNUSUAL_CHANCE.
function unusualDraws(drawn, kept, changed) {
  const out = [...changed];
  const now = drawn.map((l) => {
    if (!'AEIO'.includes(l) || randomInt(1000) >= UNUSUAL_CHANCE * 1000) return l;
    out.push({ now: 'U', was: l });
    return 'U';
  });
  return { rack: [...kept, ...now], changed: out };
}

// Demotion: every kept tile drops a step; a tile that already changed keeps
// its original letter on record.
function demoteKept(kept, drawn, changed) {
  const pending = [...changed];
  const out = [];
  const now = kept.map((l) => {
    const next = DEMOTES_TO[l] ?? l;
    const i = pending.findIndex(c => c.now === l);
    const was = i === -1 ? l : pending.splice(i, 1)[0].was;
    if (next !== was) out.push({ now: next, was });
    return next;
  });
  return { rack: [...now, ...drawn], changed: out };
}

// Demotion / Unusual, after the holder's turn: the tiles they used leave
// the rack (a changed copy of a letter goes first - an exchanged one goes
// back to the bag as its original letter, a played one stays changed on the
// board), then Demotion drops the kept tiles and Unusual turns new vowels.
export function changeLetters(before, after) {
  const entry = after.history[after.history.length - 1];
  if (!entry || entry.stepIn || !['play', 'exchange', 'pass'].includes(entry.type)) return after;
  const p = entry.player;
  const id = after.drawbacks.ids[p];
  if (id !== DEMOTION && id !== UNUSUAL) return after;

  const used = entry.type === 'play' ? entry.placed.map(t => (t.isBlank ? '?' : t.letter)) : (entry.exchanged ?? []);
  const changed = [...(after.drawbacks.changed?.[p] ?? [])];
  const taken = [];
  for (const l of used) {
    const i = changed.findIndex(c => c.now === l);
    if (i !== -1) taken.push(changed.splice(i, 1)[0]);
  }
  let bag = after.bag;
  let playedChanged = after.drawbacks.playedChanged ?? [];
  if (entry.type === 'exchange' && taken.length) {
    bag = [...bag];
    for (const t of taken) bag[bag.lastIndexOf(t.now)] = t.was;
  }
  if (entry.type === 'play') playedChanged = [...playedChanged, ...taken];

  const kept = removeTilesByCount(before.racks[p], used);
  const drawn = removeTilesByCount(after.racks[p], kept);
  let result = { rack: after.racks[p], changed };
  if (id === DEMOTION && !after.ended) result = demoteKept(kept, drawn, changed);
  if (id === UNUSUAL) result = unusualDraws(drawn, kept, changed);
  return {
    ...after,
    bag,
    racks: { ...after.racks, [p]: alphabetizeRack(result.rack) },
    drawbacks: { ...after.drawbacks, changed: { ...after.drawbacks.changed, [p]: result.changed }, playedChanged },
  };
}

// --- Tile values (Regicide, Decay, Goose Egg) --------------------------------

const normalValue = (letter) => letterScores[letter] ?? 0;
const valuesOf = (d, p) => d.values?.[p] ?? { rack: [], board: {} };

// Each rack copy with its value for its holder.
function rackTiles(rack, overrides) {
  const pending = [...overrides];
  return rack.map((letter) => {
    const i = pending.findIndex(o => o.letter === letter);
    return { letter, value: i === -1 ? normalValue(letter) : pending.splice(i, 1)[0].value };
  });
}
const overridesOf = (tiles) => tiles.filter(t => t.value !== normalValue(t.letter)).map(t => ({ letter: t.letter, value: t.value }));

// The used letters leave the rack: a play uses each letter's highest-valued
// copy, an exchange sends the lowest.
function takeTiles(tiles, letters, highest) {
  const left = [...tiles];
  const taken = [];
  for (const letter of letters) {
    let best = -1;
    left.forEach((t, i) => {
      if (t.letter === letter && (best === -1 || (highest ? t.value > left[best].value : t.value < left[best].value))) best = i;
    });
    if (best !== -1) taken.push(left.splice(best, 1)[0]);
  }
  return { left, taken };
}

function withValues(state, p, patch) {
  const d = state.drawbacks;
  return { ...state, drawbacks: { ...d, values: { ...d.values, [p]: { ...valuesOf(d, p), ...patch } } } };
}

// After every move: the mover's rack values follow their tiles (played ones
// keep their value on the board, Decay's for everyone; exchanged ones get
// their normal value back, except Regicide's), Regicide tiles in the bag are
// followed, and Decay takes a point off every tile its holder kept.
export function changeValues(before, after) {
  const entry = after.history[after.history.length - 1];
  if (!entry || entry.stepIn || !['play', 'exchange', 'pass'].includes(entry.type)) return after;
  const m = entry.player;
  const used = entry.type === 'play' ? entry.placed.map(t => (t.isBlank ? '?' : t.letter)) : (entry.exchanged ?? []);
  const keptLetters = removeTilesByCount(before.racks[m], used);
  const drawnLetters = removeTilesByCount(after.racks[m], keptLetters);
  const pushed = entry.type === 'exchange' ? used.length : 0;

  // Regicide tiles in the bag: drawn by this move (front of the bag), or
  // pushed further from the end by the tiles exchanged behind them.
  let next = after;
  const regicideBag = [];
  const zeroDraws = [];
  for (const mark of after.drawbacks.regicideBag ?? []) {
    if (before.bag.length - 1 - mark.fromEnd < drawnLetters.length) {
      // Drawn: still 0 for its holder; anyone else just has a normal tile.
      if (mark.holder === m) zeroDraws.push(mark.letter);
    } else {
      regicideBag.push({ ...mark, fromEnd: mark.fromEnd + pushed });
    }
  }

  const id = after.drawbacks.ids[m];
  if (VALUED.has(id)) {
    const { left: kept, taken } = takeTiles(rackTiles(before.racks[m], valuesOf(after.drawbacks, m).rack), used, entry.type === 'play');
    if (entry.type === 'play') {
      const pending = [...taken];
      for (const t of entry.placed) {
        const i = pending.findIndex(x => x.letter === (t.isBlank ? '?' : t.letter));
        if (i === -1) continue;
        const { letter, value } = pending.splice(i, 1)[0];
        if (value === normalValue(letter) || t.isBlank) continue;
        for (const p of id === DECAY ? [1, 2] : [m]) {
          next = withValues(next, p, { board: { ...valuesOf(next.drawbacks, p).board, [`${t.row},${t.col}`]: value } });
        }
      }
    }
    if (entry.type === 'exchange' && id === REGICIDE) {
      const slots = [...used];
      for (const t of taken) {
        if (t.value === normalValue(t.letter)) continue;
        const i = slots.lastIndexOf(t.letter);
        slots[i] = null;
        regicideBag.push({ holder: m, letter: t.letter, fromEnd: pushed - 1 - i });
      }
    }
    const keptNow = id === DECAY && !after.ended ? kept.map(t => ({ ...t, value: Math.max(0, t.value - 1) })) : kept;
    const drawn = drawnLetters.map((letter) => {
      const i = zeroDraws.indexOf(letter);
      if (i === -1) return { letter, value: normalValue(letter) };
      zeroDraws.splice(i, 1);
      return { letter, value: 0 };
    });
    next = withValues(next, m, { rack: overridesOf([...keptNow, ...drawn]) });
  }
  return { ...next, drawbacks: { ...next.drawbacks, regicideBag } };
}

// At the start of a turn: Regicide zeroes the holder's highest-valued tile,
// Goose Egg 2 more random ones. Runs once per turn.
export function startTurnValues(state) {
  const d = state.drawbacks;
  const p = state.currentPlayer;
  const id = d.ids[p];
  if (state.ended || (id !== REGICIDE && id !== GOOSE_EGG) || d.valueTurn === state.history.length) return state;
  const tiles = rackTiles(state.racks[p], valuesOf(d, p).rack);
  const live = tiles.map((t, i) => i).filter(i => tiles[i].value > 0);
  let zero = [];
  if (id === REGICIDE && live.length) {
    zero = [live.reduce((best, i) => (tiles[i].value > tiles[best].value ? i : best), live[0])];
  }
  if (id === GOOSE_EGG) {
    for (let i = live.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [live[i], live[j]] = [live[j], live[i]];
    }
    zero = live.slice(0, GOOSE_EGGS);
  }
  for (const i of zero) tiles[i] = { ...tiles[i], value: 0 };
  const next = withValues(state, p, { rack: overridesOf(tiles) });
  return { ...next, drawbacks: { ...next.drawbacks, valueTurn: state.history.length } };
}

// What the player's tiles are worth, for Go to rescore every play with.
function valuesRequest(state, player) {
  const v = valuesOf(state.drawbacks, player);
  const board = Object.entries(v.board).map(([key, value]) => [...key.split(',').map(Number), value]);
  if (!VALUED.has(state.drawbacks.ids[player]) && board.length === 0) return {};
  return {
    rackValues: rackTiles(state.racks[player], v.rack),
    boardValues: board.length ? board : undefined,
  };
}

// Short-handed: that player's rack holds 6 - one tile of the opening deal
// goes back into the bag, and the engine refills to 6 from then on
// (state.rackSizes).
function applyRackSizes(state) {
  const sizes = {};
  const racks = { ...state.racks };
  const bag = [...state.bag];
  for (const p of [1, 2]) {
    if (state.drawbacks.ids[p] !== SHORT_HANDED) continue;
    sizes[p] = SHORT_HANDED_RACK;
    const rack = [...racks[p]];
    while (rack.length > SHORT_HANDED_RACK) bag.push(rack.splice(randomInt(rack.length), 1)[0]);
    racks[p] = rack;
  }
  return Object.keys(sizes).length ? { ...state, racks, bag, rackSizes: sizes } : state;
}

// This turn's rolls for whoever is to move (made once, then kept).
function ensureRolls(state) {
  const turnIndex = state.history.length;
  const id = state.drawbacks.ids[state.currentPlayer];
  if (state.drawbacks.rolls[turnIndex] || !ROLLED.has(id)) return state;
  const roll = {};
  if (id === QUOTA) roll.quota = [1 + randomInt(7), 1 + randomInt(7)];
  if (id === DROP_ZONE) roll.quadrant = randomInt(4);
  if (id === FLAVOR_OF_THE_DAY) roll.flavor = BONUS_KINDS[randomInt(BONUS_KINDS.length)];
  if (PEER_PRESSURE_HIGHLIGHT[id]) {
    // Specific tiles from the rack as it stands at the start of the turn.
    const rack = [...state.racks[state.currentPlayer]];
    for (let i = rack.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [rack[i], rack[j]] = [rack[j], rack[i]];
    }
    roll.highlighted = rack.slice(0, PEER_PRESSURE_HIGHLIGHT[id]).join('');
  }
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
    quadrant: roll.quadrant,
    flavor: roll.flavor,
    highlighted: roll.highlighted,
    mustObeyDevil: d.ids[player] === DEVIL && devilTurnsLeft(state.history, player) === 0,
    ...valuesRequest(state, player),
    ...extra,
  };
}

// Devil On Your Shoulder: how many more of the player's turns until the
// devil must be obeyed - 0 means this one. Counts the player's turns since
// they last played the devil's move (entries flagged obeyedDevil).
export function devilTurnsLeft(history, player) {
  let since = 0;
  for (const h of history) {
    if (h.player !== player || h.stepIn) continue;
    since = h.obeyedDevil ? 0 : since + 1;
  }
  return Math.max(0, DEVIL_CYCLE - 1 - since);
}

// A play's new tiles as a comparable key (Devil: did they play its move?).
const placedKey = (tiles) => tiles.filter(t => t.isNew !== false)
  .map(t => `${t.row},${t.col},${String(t.letter).toUpperCase()},${!!t.isBlank}`).sort().join(';');

// The history fields every drawback play carries, from Go's judged move.
function playExtra(move) {
  return { simTiles: move.tiles, direction: move.direction, wordStarts: move.wordStarts ?? [], fullScore: move.fullScore };
}

// Ghostly Presence: once a play is chosen, a chance it scores 0 - rolled
// after the move, so nobody can plan around it. Returns the play's score
// and history extras.
function ghostly(state, player, move) {
  if (state.drawbacks.ids[player] !== GHOSTLY_PRESENCE || crypto.randomInt(1000) >= GHOST_CHANCE * 1000) {
    return { score: move.score, extra: playExtra(move) };
  }
  return { score: 0, extra: { ...playExtra(move), ghosted: true } };
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
          ...(next.drawbacks.ids[1] === RESTLESSNESS && info.timers ? { timers: info.timers } : {}),
          ...(next.drawbacks.ids[1] === DEVIL && info.devil ? {
            devil: { word: info.devil.word, startPosition: info.devil.startPosition, score: info.devil.score, tiles: info.devil.tiles.filter(t => t.isNew) },
            devilTurnsLeft: devilTurnsLeft(next.history, 1),
          } : {}),
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
  const scored = ghostly(ready, 1, judged.proposed);
  if (judged.devil && placedKey(judged.devil.tiles) === placedKey(judged.proposed.tiles)) scored.extra.obeyedDevil = true;
  return applyHumanPlay(ready, tiles, isValidWord, scored);
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
      const scored = ghostly(ready, 2, move);
      if (data.devil && placedKey(data.devil.tiles) === placedKey(move.tiles)) scored.extra.obeyedDevil = true;
      let next = applyBotMove(ready, move, scored);
      // A drawback that cuts his score (Nerf War, Can I Buy a Vowel, Ghostly
      // Presence) would give it away, so his board shows the normal score
      // until the game ends.
      const hidden = (move.fullScore ?? move.score) - scored.score;
      if (hidden > 0 && HIDDEN_SCORE_CUTS.has(d.ids[2])) {
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
  let next = changeValues(before, changeLetters(before, after));
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
  return startTurnValues(next);
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
