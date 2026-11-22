// Multiplayer game logic (MULTIPLAYER_PLAN.md), separate from HTTP: invites,
// joining (which starts the game), moves with the server clock, overtime,
// timeouts and rematches. Built on the same engine as bot games - both seats
// are people (state.multiplayer), each seen from its own side (view.js).

import crypto from 'crypto';
import {
  createState, applyHumanPlay, applyExchange, applyPass, applyResign, assertTileConservation, MoveError,
} from '../games/engine.js';
import {
  createDrawbackState, applyOpeningDeal, prepareHumanTurn, applyHumanDrawbackPlay, applyHumanDrawbackExchange, afterDrawbackMove,
} from '../games/drawbacks.js';
import { classicDeal } from '../games/daily.js';
import { isValidWord, SUPPORTED_GAME_LEXICONS } from '../games/dictionary.js';
import { toClientSnapshot } from '../games/view.js';
import { determineWinner } from '../rules/gameEnd.js';
import { createClock, chargeMove, stopClock, isFlagged, overtimePenalty, clockView, timeLeft } from './clock.js';

export const INVITE_TTL_MS = 30 * 60 * 1000;
export const MODES = ['classic', 'drawbacks'];
export const CLOCK_MINUTES = { min: 1, max: 60 };
export const OVERTIME_CHOICES = [0, 1, 2, 3];
export const FIRST_PLAYER_CHOICES = ['random', 'creator', 'joiner'];
export const CHALLENGE_MODES = ['void']; // tournament challenges come later
export const GUEST_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,18}[A-Za-z0-9_]$|^[A-Za-z0-9_]$/;

export class GameRuleError extends Error {
  // status: HTTP status; code: machine-readable
  constructor(status, code, reason, extra = {}) {
    super(reason ?? code);
    this.status = status;
    this.code = code;
    this.reason = reason;
    Object.assign(this, extra);
  }
}

export const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
export const newToken = () => crypto.randomBytes(32).toString('base64url');
const other = (seat) => (seat === 1 ? 2 : 1);

// Short, unambiguous invite codes (no 0/O/1/I/L).
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newInviteCode() {
  let code = '';
  for (let i = 0; i < 8; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

export function parseSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const mode = s.mode ?? 'classic';
  const lexicon = s.lexicon ?? 'NWL23';
  const minutes = Number(s.minutes ?? 25);
  const overtimeMinutes = Number(s.overtimeMinutes ?? 1);
  const firstPlayer = s.firstPlayer ?? 'random';
  const challenge = s.challenge ?? 'void';
  if (!MODES.includes(mode)) throw new GameRuleError(400, 'invalid_request', 'mode must be classic or drawbacks');
  if (!SUPPORTED_GAME_LEXICONS.includes(lexicon)) throw new GameRuleError(400, 'invalid_request', 'unsupported lexicon');
  if (!Number.isInteger(minutes) || minutes < CLOCK_MINUTES.min || minutes > CLOCK_MINUTES.max) {
    throw new GameRuleError(400, 'invalid_request', `minutes must be ${CLOCK_MINUTES.min}-${CLOCK_MINUTES.max}`);
  }
  if (!OVERTIME_CHOICES.includes(overtimeMinutes)) throw new GameRuleError(400, 'invalid_request', 'overtimeMinutes must be 0-3');
  if (!FIRST_PLAYER_CHOICES.includes(firstPlayer)) throw new GameRuleError(400, 'invalid_request', 'firstPlayer must be random, creator or joiner');
  if (!CHALLENGE_MODES.includes(challenge)) throw new GameRuleError(400, 'invalid_request', 'unsupported challenge mode');
  return { mode, lexicon, minutes, overtimeMinutes, firstPlayer, challenge };
}

// An invite: seat 1 is the creator; seat 2 fills when someone joins.
export function createInvite({ settings, creator, now }) {
  const token = newToken();
  const game = {
    id: crypto.randomUUID(),
    code: newInviteCode(),
    status: 'waiting',
    version: 0,
    settings,
    seats: { 1: { ...creator, tokenHash: hashToken(token) }, 2: null },
    state: null,
    clock: null,
    rematch: { 1: false, 2: false, gameId: null },
    lastMoves: {},
    previousGameId: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + INVITE_TTL_MS,
  };
  return { game, token };
}

// Deals and starts a game between the two seats.
async function startGame(game, firstPlayer, now) {
  const deal = classicDeal();
  let state = { ...createState({ mode: game.settings.mode, lexicon: game.settings.lexicon, opponentId: 'human', bag: deal.bag, firstPlayer }), multiplayer: true };
  if (state.mode === 'drawbacks') {
    state.drawbacks = createDrawbackState(); // random for both
    state = applyOpeningDeal(state);
    state = await prepareHumanTurn(state, firstPlayer);
  }
  assertTileConservation(state);
  return {
    ...game,
    status: 'active',
    state,
    clock: createClock(game.settings, now),
    expiresAt: null,
  };
}

const firstSeat = (settings) => (settings.firstPlayer === 'creator' ? 1
  : settings.firstPlayer === 'joiner' ? 2
    : (crypto.randomInt(2) === 0 ? 1 : 2));

export async function joinInvite(game, joiner, now) {
  if (game.status !== 'waiting') throw new GameRuleError(409, game.status === 'cancelled' ? 'invite_cancelled' : 'game_full', 'This game has already started or was cancelled');
  if (game.expiresAt <= now) throw new GameRuleError(410, 'invite_expired', 'This invite has expired');
  if (joiner.userId && joiner.userId === game.seats[1].userId) throw new GameRuleError(409, 'own_invite', "You can't join your own invite");
  const token = newToken();
  const seated = { ...game, code: null, seats: { ...game.seats, 2: { ...joiner, tokenHash: hashToken(token) } } };
  return { game: await startGame(seated, firstSeat(game.settings), now), token };
}

export function cancelInvite(game, seat) {
  if (seat !== 1) throw new GameRuleError(403, 'not_creator', 'Only the creator can cancel');
  if (game.status !== 'waiting') throw new GameRuleError(409, 'not_waiting', 'This game has already started');
  return { ...game, status: 'cancelled', code: null };
}

// Which seat a token (or a signed-in user) holds in this game, or null.
export function seatFor(game, { token, userId }) {
  const given = token ? hashToken(token) : null;
  for (const seat of [1, 2]) {
    const s = game.seats[seat];
    if (!s) continue;
    if (given && s.tokenHash.length === given.length && crypto.timingSafeEqual(Buffer.from(s.tokenHash), Buffer.from(given))) return seat;
  }
  if (userId) for (const seat of [1, 2]) if (game.seats[seat]?.userId === userId) return seat;
  return null;
}

// Final scores with overtime penalties, and the winner. A resignation,
// drawback loss or timeout already decided the winner; otherwise the
// penalties can change it.
function withPenalties(state, clock) {
  const pen = { 1: overtimePenalty(clock.remaining[1]), 2: overtimePenalty(clock.remaining[2]) };
  if (!pen[1] && !pen[2]) return state;
  const final = { ...state.final };
  final.player1Score -= pen[1];
  final.player2Score -= pen[2];
  if (!['resigned', 'drawbackLoss', 'timeout'].includes(state.endReason)) {
    final.winner = determineWinner({ finalPlayer1Score: final.player1Score, finalPlayer2Score: final.player2Score });
  }
  final.overtimePenalty = pen;
  return { ...state, final };
}

function endIfOver(game, now) {
  if (!game.state.ended) return game;
  const clock = stopClock(game.clock, game.state.currentPlayer, now);
  return { ...game, status: 'ended', clock, state: withPenalties(game.state, clock) };
}

// The player to move ran out (past any overtime): they lose on time.
export function endOnTime(game, now) {
  const loser = game.state.currentPlayer;
  const clock = stopClock(game.clock, loser, now);
  const state = {
    ...game.state,
    ended: true,
    endReason: 'timeout',
    stepInPending: false,
    final: { player1Score: game.state.scores[1], player2Score: game.state.scores[2], winner: loser === 1 ? 'bot' : 'player', timedOut: loser },
  };
  return { ...game, status: 'ended', clock, state: withPenalties(state, clock) };
}

// Returns the game ended on time if the player to move has run out, else null.
export function checkTimeout(game, now) {
  if (game.status !== 'active' || game.state.ended) return null;
  return isFlagged(game.clock, game.state.currentPlayer, game.state.currentPlayer, now) ? endOnTime(game, now) : null;
}

// One move by `seat`: kind 'play' (tiles) | 'exchange' (letters) | 'pass'.
// Charges the clock, runs the Drawbacks checks, readies the next player's
// Drawbacks turn, and ends the game (with penalties) if it's over.
export async function applyMove(game, seat, kind, payload, now) {
  if (game.status !== 'active') throw new GameRuleError(410, 'game_over', 'The game is over');
  const timedOut = checkTimeout(game, now);
  if (timedOut) return { game: timedOut, timedOut: true };
  const before = game.state;
  if (before.currentPlayer !== seat) throw new MoveError('not_your_turn', 'Not your turn');
  const isValid = (w) => isValidWord(before.lexicon, w);
  const drawbacks = before.mode === 'drawbacks';
  let after;
  if (kind === 'play') {
    after = drawbacks ? await applyHumanDrawbackPlay(before, payload, isValid, seat) : applyHumanPlay(before, payload, isValid, { player: seat });
  } else if (kind === 'exchange') {
    after = drawbacks ? await applyHumanDrawbackExchange(before, payload, seat) : applyExchange(before, seat, payload);
  } else {
    after = applyPass(before, seat);
  }
  after = await afterDrawbackMove(before, after);
  assertTileConservation(after);
  let next = { ...game, state: after, clock: chargeMove(game.clock, seat, now) };
  next = endIfOver(next, now);
  if (next.status === 'active') next = { ...next, state: await prepareHumanTurn(next.state, next.state.currentPlayer) };
  return { game: next, timedOut: false };
}

export function resign(game, seat, now) {
  if (game.status !== 'active') throw new GameRuleError(410, 'game_over', 'The game is over');
  return endIfOver({ ...game, state: applyResign(game.state, seat) }, now);
}

// Both players asking starts a rematch: same seats and settings, the other
// player first. Returns { game, rematch } - rematch is the new game or null.
export async function requestRematch(game, seat, now) {
  if (game.status !== 'ended') throw new GameRuleError(409, 'not_ended', 'The game is still going');
  if (game.rematch.gameId) return { game, rematch: null, existingId: game.rematch.gameId };
  const wants = { ...game.rematch, [seat]: true };
  if (!(wants[1] && wants[2])) return { game: { ...game, rematch: wants }, rematch: null };
  const base = {
    id: crypto.randomUUID(), code: null, status: 'waiting', version: 0, settings: game.settings,
    seats: game.seats, state: null, clock: null, rematch: { 1: false, 2: false, gameId: null }, lastMoves: {},
    previousGameId: game.id, createdAt: now, updatedAt: now, expiresAt: null,
  };
  const rematch = await startGame(base, other(game.state.firstPlayer), now);
  return { game: { ...game, rematch: { ...wants, gameId: rematch.id } }, rematch };
}

// --- What the browser sees -------------------------------------------------

const publicSeat = (s) => (s ? { name: s.name, guest: !!s.guest } : null);

// The join page: who invited you and the settings. No secrets.
export function inviteView(game, now) {
  return {
    gameId: game.id,
    status: game.status === 'waiting' && game.expiresAt <= now ? 'expired' : game.status,
    creator: publicSeat(game.seats[1]),
    settings: game.settings,
    expiresAt: game.expiresAt,
  };
}

// A seat's whole view: players (you first), clocks, rematch, and the board
// snapshot (null while waiting).
export function seatView(game, seat, now) {
  const opp = other(seat);
  return {
    gameId: game.id,
    code: game.status === 'waiting' ? game.code : null,
    status: game.status,
    seat,
    settings: game.settings,
    you: publicSeat(game.seats[seat]),
    opponent: publicSeat(game.seats[opp]),
    clock: game.clock ? clockView(game.clock, seat, game.state.currentPlayer, now) : null,
    rematch: { you: !!game.rematch[seat], opponent: !!game.rematch[opp], gameId: game.rematch.gameId },
    previousGameId: game.previousGameId,
    expiresAt: game.expiresAt,
    state: game.state ? toClientSnapshot(game.id, game.version, game.state, { seat }) : null,
  };
}

export { timeLeft };
