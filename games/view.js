// The ONLY path from a stored game state to what the browser receives.
// Anything not copied here never leaves the server: the bag's order, the
// opponent's rack, and - until the game ends - what the opponent held or
// exchanged on each turn. Unseen tiles are sent as one sorted multiset (bag +
// opponent's rack together), which is public information in Scrabble anyway.
//
// Seats (MULTIPLAYER_PLAN.md): the snapshot is always from one seat's side
// (opts.seat, 1 by default - the human in a bot game). Everything is turned
// round so that "player 1" in the snapshot is the viewer and "player 2" their
// opponent - scores, turn, history, winner, Drawbacks - so the frontend's
// game screen (which always shows player 1 as "you") works for both people
// in a multiplayer game without knowing which seat it's in.

import { alphabetizeRack } from '../rules/rack.js';

// opts.seat: whose side to show (1 or 2). opts.peek (Drawbacks): reveal the
// opponent's drawback mid-game (bot games' Testing peek).
export function toClientSnapshot(gameId, version, state, opts = {}) {
  const me = opts.seat === 2 ? 2 : 1;
  const opp = me === 1 ? 2 : 1;
  const view = (p) => (p === me ? 1 : 2); // a stored seat -> the viewer's numbering
  const reveal = state.ended;
  // Drawbacks: until the game ends, a score cut that would give the
  // opponent's drawback away stays hidden (their board shows the normal
  // score); the real one is revealed at game over.
  const hidden = !reveal ? hiddenPointsOf(state, opp) : 0;
  return {
    gameId,
    version,
    seat: me,
    multiplayer: !!state.multiplayer,
    mode: state.mode,
    dailyDate: state.dailyDate,
    lexicon: state.lexicon,
    opponentId: state.opponentId,
    board: state.board,
    blankTiles: state.blankTiles,
    myRack: state.racks[me],
    scores: { player1: state.scores[me], player2: state.scores[opp] + hidden },
    currentPlayer: view(state.currentPlayer),
    botPending: !state.multiplayer && !state.ended && state.currentPlayer === 2,
    scorelessRun: state.scorelessRun,
    bagCount: state.bag.length,
    opponentRackCount: state.racks[opp].length,
    unseen: alphabetizeRack([...state.bag, ...state.racks[opp]]),
    history: toClientHistory(state, me, reveal),
    drawbacks: state.drawbacks ? toClientDrawbacks(state, me, reveal || !!opts.peek) : undefined,
    ended: state.ended,
    endReason: state.endReason,
    final: state.ended ? viewFinal(state.final, me, state.racks[opp]) : null,
    opponentMood: state.opponentMood,
  };
}

// Points hidden from `player`'s opponent so far: Wally's in a bot game, the
// player's own tally in multiplayer (drawbacks.js hideScoreCut).
function hiddenPointsOf(state, player) {
  const d = state.drawbacks;
  if (!d) return 0;
  if (!state.multiplayer) return player === 2 ? (d.wallyHiddenPoints ?? 0) : 0;
  return d.hiddenPoints?.[player] ?? 0;
}

// The final result from the viewer's side. Stored winner: 'player' = seat 1,
// 'bot' = seat 2 (names from before multiplayer); shown: 'player' = you.
function viewFinal(final, me, opponentRack) {
  if (me === 1) return { ...final, opponentRack };
  const swap = { player: 'bot', bot: 'player' };
  return {
    ...final,
    player1Score: final.player2Score,
    player2Score: final.player1Score,
    winner: swap[final.winner] ?? final.winner,
    opponentRack,
  };
}

// Drawbacks: your own drawback and rolls, the panel's turn info, your
// Minefield zone - and the opponent's drawback and zone only once revealed.
// (Field names `wally`/`wallyHiddenPoints` mean "the opponent".)
function toClientDrawbacks(state, me, revealOpponent) {
  const d = state.drawbacks;
  const opp = me === 1 ? 2 : 1;
  const view = (p) => (p === me ? 1 : 2);
  const turnIndex = state.history.length;
  const myTurn = state.currentPlayer === me && !state.ended;
  const turnInfoIsMine = d.turnInfo && (d.turnInfo.player ?? 1) === me;
  return {
    mine: d.ids[me],
    wally: revealOpponent ? d.ids[opp] : null,
    zones: d.zones.filter(z => z.holder === me || revealOpponent).map(z => ({ ...z, holder: view(z.holder) })),
    roll: myTurn ? (d.rolls[turnIndex] ?? null) : null,
    turnInfo: myTurn && turnInfoIsMine && d.turnInfo.turnIndex === turnIndex ? stripSeat(d.turnInfo) : null,
    loss: d.loss ? { ...d.loss, ...(d.loss.player ? { player: view(d.loss.player) } : {}) } : null,
    wallyHiddenPoints: state.ended ? hiddenPointsOf(state, opp) : 0,
    changed: d.changed?.[me] ?? [],
    // Regicide / Decay / Goose Egg: what your tiles are worth to you, where
    // that isn't the normal value.
    values: {
      rack: d.values?.[me]?.rack ?? [],
      board: Object.entries(d.values?.[me]?.board ?? {}).map(([key, value]) => [...key.split(',').map(Number), value]),
    },
  };
}

const stripSeat = ({ player: _seat, ...info }) => info;

// Until the game ends, the opponent's entries show their normal scores and
// running totals wherever a score cut is being hidden (hiddenAfter: the
// points hidden so far, set on each such play).
function toClientHistory(state, me, reveal) {
  let hiddenSoFar = 0;
  return state.history.map((h) => {
    const isOpp = h.player !== me;
    if (isOpp && h.hiddenAfter != null) hiddenSoFar = h.hiddenAfter;
    return toClientHistoryEntry(h, state, me, reveal, isOpp ? hiddenSoFar : 0);
  });
}

function toClientHistoryEntry(h, state, me, reveal, hiddenSoFar = 0) {
  const isOpp = h.player !== me;
  // Bot games hide every cut on Wally's plays (as before multiplayer);
  // multiplayer hides only the cuts drawbacks.js marked as hidden.
  const cutHidden = !reveal && isOpp && h.fullScore != null && h.fullScore > h.score
    && (state.multiplayer ? h.hiddenAfter != null : h.player === 2);
  const entry = {
    player: h.player === me ? 1 : 2,
    isBot: !state.multiplayer && h.player === 2,
    type: h.type,
    placed: h.placed,
    words: h.words,
    score: cutHidden ? h.fullScore : h.score,
    total: reveal ? h.total : h.total + hiddenSoFar,
    isBingo: !!h.isBingo,
  };
  if (h.stepIn) entry.stepIn = true;
  if (h.ghosted) entry.ghosted = true; // Ghostly Presence turned this play's score to 0
  if (!isOpp || reveal) {
    if (h.rack !== undefined) entry.rack = h.rack;
    if (h.exchanged) entry.exchanged = h.exchanged;
  }
  if (h.type === 'exchange') entry.exchangedCount = h.exchanged.length;
  return entry;
}
