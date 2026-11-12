// The ONLY path from a stored game state to what the browser receives.
// Anything not copied here never leaves the server: the bag's order, the
// bot's rack, and - until the game ends - what the bot held or exchanged on
// each turn. Unseen tiles are sent as one sorted multiset (bag + bot rack
// together), which is public information in Scrabble anyway.

import { alphabetizeRack } from '../rules/rack.js';

// opts.peek (Drawbacks): reveal Wally's drawback mid-game.
export function toClientSnapshot(gameId, version, state, opts = {}) {
  const reveal = state.ended;
  // Drawbacks + Nerf War: until the game ends, Wally's board shows his
  // normal score; the real one is revealed at game over.
  const hidden = !reveal ? (state.drawbacks?.wallyHiddenPoints ?? 0) : 0;
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
    scores: { player1: state.scores[1], player2: state.scores[2] + hidden },
    currentPlayer: state.currentPlayer,
    botPending: !state.ended && state.currentPlayer === 2,
    scorelessRun: state.scorelessRun,
    bagCount: state.bag.length,
    opponentRackCount: state.racks[2].length,
    unseen: alphabetizeRack([...state.bag, ...state.racks[2]]),
    history: toClientHistory(state.history, reveal),
    drawbacks: state.drawbacks ? toClientDrawbacks(state, reveal || !!opts.peek) : undefined,
    ended: state.ended,
    endReason: state.endReason,
    final: state.ended ? { ...state.final, opponentRack: state.racks[2] } : null,
    opponentMood: state.opponentMood,
  };
}

// Drawbacks: your own drawback and rolls, the panel's turn info, your
// Minefield zone - and Wally's drawback and zone only once revealed.
function toClientDrawbacks(state, revealWally) {
  const d = state.drawbacks;
  const turnIndex = state.history.length;
  return {
    mine: d.ids[1],
    wally: revealWally ? d.ids[2] : null,
    zones: d.zones.filter(z => z.holder === 1 || revealWally),
    roll: state.currentPlayer === 1 && !state.ended ? (d.rolls[turnIndex] ?? null) : null,
    turnInfo: d.turnInfo?.turnIndex === turnIndex && state.currentPlayer === 1 && !state.ended ? d.turnInfo : null,
    loss: d.loss,
    wallyHiddenPoints: state.ended ? d.wallyHiddenPoints : 0,
    changed: d.changed?.[1] ?? [],
  };
}

// Nerf War: until the game ends, Wally's entries show his normal scores and
// running totals (hiddenAfter: the points hidden so far, set on each of his
// nerfed plays).
function toClientHistory(history, reveal) {
  let hiddenSoFar = 0;
  return history.map((h) => {
    if (h.player === 2 && h.hiddenAfter != null) hiddenSoFar = h.hiddenAfter;
    return toClientHistoryEntry(h, reveal, h.player === 2 ? hiddenSoFar : 0);
  });
}

function toClientHistoryEntry(h, reveal, hiddenSoFar = 0) {
  const nerfHidden = !reveal && h.player === 2 && h.fullScore != null && h.fullScore > h.score;
  const entry = {
    player: h.player,
    isBot: h.player === 2,
    type: h.type,
    placed: h.placed,
    words: h.words,
    score: nerfHidden ? h.fullScore : h.score,
    total: reveal ? h.total : h.total + hiddenSoFar,
    isBingo: !!h.isBingo,
  };
  if (h.stepIn) entry.stepIn = true;
  if (h.ghosted) entry.ghosted = true; // Ghostly Presence turned this play's score to 0
  if (h.player === 1 || reveal) {
    if (h.rack !== undefined) entry.rack = h.rack;
    if (h.exchanged) entry.exchanged = h.exchanged;
  }
  if (h.type === 'exchange') entry.exchangedCount = h.exchanged.length;
  return entry;
}
