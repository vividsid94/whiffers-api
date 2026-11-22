import test from 'node:test';
import assert from 'node:assert/strict';
import { createClock, timeLeft, chargeMove, stopClock, isFlagged, flagTime, overtimePenalty, clockView, MINUTE } from '../mp/clock.js';

test('charges only the player to move', () => {
  let c = createClock({ minutes: 10, overtimeMinutes: 1 }, 0);
  assert.equal(timeLeft(c, 1, 1, 30_000), 10 * MINUTE - 30_000);
  assert.equal(timeLeft(c, 2, 1, 30_000), 10 * MINUTE);
  c = chargeMove(c, 1, 30_000);
  assert.equal(c.remaining[1], 10 * MINUTE - 30_000);
  assert.equal(c.turnStartedAt, 30_000);
  assert.equal(timeLeft(c, 2, 2, 50_000), 10 * MINUTE - 20_000);
});

test('no overtime: zero is a loss', () => {
  const c = createClock({ minutes: 1, overtimeMinutes: 0 }, 0);
  assert.equal(isFlagged(c, 1, 1, MINUTE - 1), false);
  assert.equal(isFlagged(c, 1, 1, MINUTE), true);
  assert.equal(flagTime(c, 1), MINUTE);
});

test('overtime: may run 2 minutes over, then loses', () => {
  const c = createClock({ minutes: 1, overtimeMinutes: 2 }, 0);
  assert.equal(isFlagged(c, 1, 1, 2 * MINUTE), false);
  assert.equal(isFlagged(c, 1, 1, 3 * MINUTE - 1), false);
  assert.equal(isFlagged(c, 1, 1, 3 * MINUTE), true);
  assert.equal(flagTime(c, 1), 3 * MINUTE);
});

test('penalty: 10 per started minute over', () => {
  assert.equal(overtimePenalty(5000), 0);
  assert.equal(overtimePenalty(0), 0);
  assert.equal(overtimePenalty(-1), 10);
  assert.equal(overtimePenalty(-MINUTE), 10);
  assert.equal(overtimePenalty(-MINUTE - 1), 20);
  assert.equal(overtimePenalty(-3 * MINUTE + 5), 30);
});

test('stopping the clock charges the mover and freezes both', () => {
  let c = createClock({ minutes: 5, overtimeMinutes: 0 }, 0);
  c = stopClock(c, 2, 10_000);
  assert.equal(c.remaining[2], 5 * MINUTE - 10_000);
  assert.equal(c.turnStartedAt, null);
  assert.equal(timeLeft(c, 2, 2, 999_999), 5 * MINUTE - 10_000);
  assert.equal(stopClock(c, 2, 20_000), c);
});

test('the view is from the viewer\'s side', () => {
  const c = chargeMove(createClock({ minutes: 5, overtimeMinutes: 1 }, 0), 1, 10_000);
  const v = clockView(c, 2, 2, 15_000);
  assert.equal(v.player1Ms, 5 * MINUTE - 5_000); // seat 2, to move
  assert.equal(v.player2Ms, 5 * MINUTE - 10_000); // seat 1
  assert.equal(v.running, true);
  assert.equal(v.overtimeMs, MINUTE);
});
