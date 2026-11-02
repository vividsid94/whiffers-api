// The bot's turn for a server-run game: ask the Go move generator, pick by
// the opponent's level, and apply it through the engine (which re-checks
// the move against the real rack and board). If Go can't be reached, this
// throws BotUnavailableError and the turn stays the bot's - it never turns
// a network problem into a pass (the original airplane-mode bug).

import { buildBoardForRequest, GO_SERVICE_URL } from '../rules/boardRequest.js';
import { getOpponent, pickCandidateAtRank } from '../rules/opponents.js';
import { applyBotMove, applyExchange, applyPass, MoveError } from './engine.js';

const GO_TIMEOUT_MS = 12000;
// Same "big play" bar the frontend's Ease the Blow uses.
const EASE_BIG_PLAY_SCORE_THRESHOLD = 40;

export class BotUnavailableError extends Error {}

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
    throw new BotUnavailableError(`Go ${path} unreachable: ${err.message}`);
  }
  if (!response.ok) throw new BotUnavailableError(`Go ${path} HTTP ${response.status}`);
  return response.json();
}

function goRequest(state) {
  return {
    board: buildBoardForRequest(state.board, state.blankTiles),
    rack: state.racks[2].join(''),
    poolSize: state.bag.length,
    lexicon: state.lexicon,
  };
}

// Tries `preferred` first, then the rest of the list, so one bad candidate
// (Go and the engine disagreeing about a square) can't stall the game.
function applyFirstLegal(state, preferred, candidates) {
  const order = [preferred, ...candidates.filter(c => c !== preferred)].filter(Boolean);
  for (const move of order) {
    try {
      return { state: applyBotMove(state, move), move };
    } catch (err) {
      if (!(err instanceof MoveError)) throw err;
      console.error('Bot candidate rejected by engine:', err.reason);
    }
  }
  return { state: applyPass(state, 2), move: null };
}

// Returns { state, mood } with the bot's move applied.
export async function runBotTurn(state) {
  const opponent = getOpponent(state.opponentId);
  let next;
  let mood = state.opponentMood;

  if (opponent?.persona) {
    const turn = await postGo('/bot-turn', {
      ...goRequest(state),
      persona: opponent.persona,
      myScore: state.scores[2],
      opponentScore: state.scores[1],
    });
    mood = turn.mood ?? mood;
    if (turn.action === 'pass' || !turn.move) {
      next = applyPass(state, 2);
    } else if (turn.action === 'exchange' || turn.move.isExchange) {
      try {
        next = applyExchange(state, 2, turn.move.tiles.map(t => t.letter));
      } catch (err) {
        if (!(err instanceof MoveError)) throw err;
        next = applyPass(state, 2);
      }
    } else {
      next = applyFirstLegal(state, turn.move, []).state;
    }
  } else {
    const rank = opponent?.rank ?? 1;
    const data = await postGo('/generate-moves', { ...goRequest(state), topN: Math.max(5, rank) });
    const candidates = (data.moves || []).filter(m => m.isExchange || m.tiles?.length > 0);
    next = candidates.length === 0
      ? applyPass(state, 2)
      : applyFirstLegal(state, pickCandidateAtRank(candidates, rank), candidates).state;
  }

  next.opponentMood = mood;
  return { state: next, mood };
}

// What the client needs to stage the bot's move (sound, pause, bingo) -
// public info only: the move itself is on the board already.
export function summarizeBotMove(beforeState, afterState) {
  const entry = afterState.history[afterState.history.length - 1];
  if (!entry || entry.player !== 2 || afterState.history.length === beforeState.history.length) return null;
  return {
    status: 'done',
    type: entry.type,
    words: entry.words,
    score: entry.score,
    total: entry.total,
    placed: entry.placed,
    isBingo: !!entry.isBingo,
    easeWorthy: entry.type === 'play' && (entry.isBingo || entry.score >= EASE_BIG_PLAY_SCORE_THRESHOLD),
    exchangedCount: entry.type === 'exchange' ? entry.exchanged.length : undefined,
    mood: afterState.opponentMood,
  };
}
