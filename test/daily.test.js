import test from 'node:test';
import assert from 'node:assert/strict';
import { origPool } from '../rules/staticData.js';
import { legacyDailyDeal } from '../rules/legacyDaily.js';

// daily.js reads its env at import time, so set it first.
process.env.DAILY_SECRET = 'test-secret-0123456789abcdef';
process.env.DAILY_SERVER_SEED_FROM = '2026-11-03';
const { dailyDeal, isPlayableDailyDate, classicDeal } = await import('../games/daily.js');

const sorted = (bag) => [...bag].sort().join('');

test('server daily deal: same for everyone on a date, a full fair bag', () => {
  const a = dailyDeal('2026-11-10');
  assert.deepEqual(a, dailyDeal('2026-11-10'));
  assert.equal(sorted(a.bag), sorted(origPool));
  assert.notDeepEqual(a.bag, dailyDeal('2026-11-11').bag);
  assert.ok(a.firstPlayer === 1 || a.firstPlayer === 2);
});

test('server daily deal differs from the old date-only deal', () => {
  assert.notDeepEqual(dailyDeal('2026-11-10').bag, legacyDailyDeal('2026-11-10', origPool).bag);
});

test('days before the cutover keep the old deal', () => {
  assert.deepEqual(dailyDeal('2026-10-01'), legacyDailyDeal('2026-10-01', origPool));
});

test('playable dates: real, not in the future', () => {
  assert.equal(isPlayableDailyDate('2026-02-30'), false);
  assert.equal(isPlayableDailyDate('2999-01-01'), false);
  assert.equal(isPlayableDailyDate('nope'), false);
  assert.equal(isPlayableDailyDate('2025-01-01'), true);
});

test('classic deal is a full bag', () => {
  assert.equal(sorted(classicDeal().bag), sorted(origPool));
});
