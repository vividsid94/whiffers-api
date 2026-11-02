// The ONLY path from a stored game state to what the browser receives.
// Anything not copied here never leaves the server: the bag's order, the
// bot's rack, and - until the game ends - what the bot held or exchanged on
// each turn. Unseen tiles are sent as one sorted multiset (bag + bot rack
// together), which is public information in Scrabble anyway.

import { alphabetizeRack } from '../rules/rack.js';

export function toClientSnapshot(gameId, version, state) {
  const reveal = state.ended;
  return {
    gameId,
    version,
    mode: state.mode,
    dailyDate: state.dailyDate,
    lexicon: state.lexicon,
    opponentId: state.opponentId,
    board: state.board,
    blankTiles: state.blankTiles,
    myRack: state.racks[1],
    scores: { player1: state.scores[1], player2: state.scores[2] },
    currentPlayer: state.currentPlayer,
    botPending: !state.ended && state.currentPlayer === 2,
    scorelessRun: state.scorelessRun,
    bagCount: state.bag.length,
    opponentRackCount: state.racks[2].length,
    unseen: alphabetizeRack([...state.bag, ...state.racks[2]]),
    history: state.history.map(h => toClientHistoryEntry(h, reveal)),
    ended: state.ended,
    endReason: state.endReason,
    final: state.ended ? { ...state.final, opponentRack: state.racks[2] } : null,
    opponentMood: state.opponentMood,
  };
}

function toClientHistoryEntry(h, reveal) {
  const entry = {
    player: h.player,
    isBot: h.player === 2,
    type: h.type,
    placed: h.placed,
    words: h.words,
    score: h.score,
    total: h.total,
    isBingo: !!h.isBingo,
  };
  if (h.player === 1 || reveal) {
    if (h.rack !== undefined) entry.rack = h.rack;
    if (h.exchanged) entry.exchanged = h.exchanged;
  }
  if (h.type === 'exchange') entry.exchangedCount = h.exchanged.length;
  return entry;
}
