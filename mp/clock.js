// Multiplayer game clocks (MULTIPLAYER_PLAN.md). The server owns them: each
// seat has milliseconds left, and the seat to move is charged from
// `turnStartedAt`. Pure functions - `now` is always passed in.
//
// Overtime (a game setting, 0-3 minutes): a clock may go below zero by up to
// that much. Every started minute over costs 10 points at the end; going past
// the overtime (or reaching zero with no overtime) loses the game on time.
//
// clock = { initialMs, overtimeMs, remaining: { 1, 2 }, turnStartedAt }
// (turnStartedAt is null once the game has ended - clocks stop.)

export const MINUTE = 60 * 1000;
export const OVERTIME_PENALTY_PER_MINUTE = 10;

export function createClock({ minutes, overtimeMinutes }, now) {
  const initialMs = Math.round(minutes * MINUTE);
  return {
    initialMs,
    overtimeMs: overtimeMinutes * MINUTE,
    remaining: { 1: initialMs, 2: initialMs },
    turnStartedAt: now,
  };
}

// Time left for `player` right now (negative = in overtime).
export function timeLeft(clock, player, currentPlayer, now) {
  const charged = clock.turnStartedAt != null && player === currentPlayer ? now - clock.turnStartedAt : 0;
  return clock.remaining[player] - charged;
}

// The mover's turn ends now: charge them, start the next turn's timer.
export function chargeMove(clock, mover, now) {
  const remaining = { ...clock.remaining, [mover]: clock.remaining[mover] - (now - clock.turnStartedAt) };
  return { ...clock, remaining, turnStartedAt: now };
}

// Stops the clocks (game over), charging whoever was to move.
export function stopClock(clock, currentPlayer, now) {
  if (clock.turnStartedAt == null) return clock;
  return { ...chargeMove(clock, currentPlayer, now), turnStartedAt: null };
}

// Has `player` run out completely (past any overtime)?
export function isFlagged(clock, player, currentPlayer, now) {
  return timeLeft(clock, player, currentPlayer, now) <= -clock.overtimeMs;
}

// When the player to move will run out, as an epoch ms (for the server's
// timeout timer).
export function flagTime(clock, currentPlayer) {
  return clock.turnStartedAt + clock.remaining[currentPlayer] + clock.overtimeMs;
}

// Points lost to overtime: 10 per started minute below zero.
export function overtimePenalty(remainingMs) {
  if (remainingMs >= 0) return 0;
  return Math.ceil(-remainingMs / MINUTE) * OVERTIME_PENALTY_PER_MINUTE;
}

// What the browser gets: both clocks as of `now`, from the viewer's side
// (player1 = you), plus when that was, so it can count down smoothly.
export function clockView(clock, seat, currentPlayer, now) {
  const me = seat;
  const opp = seat === 1 ? 2 : 1;
  return {
    player1Ms: timeLeft(clock, me, currentPlayer, now),
    player2Ms: timeLeft(clock, opp, currentPlayer, now),
    overtimeMs: clock.overtimeMs,
    running: clock.turnStartedAt != null,
    serverNow: now,
  };
}
