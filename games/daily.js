// Bags for new games. A Classic game gets a crypto-random shuffle; a Daily
// gets the same shuffle for everyone on that date, but one that can't be
// worked out in advance: it's keyed by DAILY_SECRET, which only this server
// knows. (The old client-side Daily seeded from the date alone, so anyone
// could compute the whole day's bag.)
//
// Days before DAILY_SERVER_SEED_FROM keep that old deal (rules/legacyDaily.js)
// so the calendar's past days still deal exactly what everyone played.

import crypto from 'crypto';
import { origPool } from '../rules/staticData.js';
import { legacyDailyDeal } from '../rules/legacyDaily.js';

const DAILY_SECRET = process.env.DAILY_SECRET || '';
// YYYY-MM-DD; unset means every date uses the new deal.
const DAILY_SERVER_SEED_FROM = process.env.DAILY_SERVER_SEED_FROM || '';

export const isDailyAvailable = () => DAILY_SECRET.length >= 16;

// Today in US Eastern time - copied from whiffers' getTodayDateKey so the
// server and the app roll over to a new Daily at the same moment.
export function getTodayDateKey() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const lookup = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

// A real YYYY-MM-DD day that isn't in the future (Eastern time).
export function isPlayableDailyDate(dateKey) {
  if (typeof dateKey !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return false;
  const [y, m, d] = dateKey.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  const isRealDay = check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
  return isRealDay && dateKey <= getTodayDateKey();
}

// Fisher-Yates where `randomBelow(n)` returns a uniform integer in [0, n).
function shuffleWith(randomBelow) {
  const bag = origPool.split('');
  for (let i = bag.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag;
}

export function classicDeal() {
  return { bag: shuffleWith(n => crypto.randomInt(n)), firstPlayer: crypto.randomInt(2) === 0 ? 1 : 2 };
}

// A deterministic stream of uniform integers from HMAC-SHA256 in counter
// mode - the whole 256-bit key space, not a 32-bit seed someone could brute
// force from the opening racks. Rejection sampling keeps it unbiased.
function hmacRandomBelow(key) {
  let counter = 0;
  return (n) => {
    const limit = Math.floor(0x100000000 / n) * n;
    for (;;) {
      const block = crypto.createHmac('sha256', key).update(`n:${counter++}`).digest();
      const value = block.readUInt32BE(0);
      if (value < limit) return value % n;
    }
  };
}

export function dailyDeal(dateKey) {
  if (DAILY_SERVER_SEED_FROM && dateKey < DAILY_SERVER_SEED_FROM) {
    return legacyDailyDeal(dateKey, origPool);
  }
  const bagKey = crypto.createHmac('sha256', DAILY_SECRET).update(`bag:${dateKey}`).digest();
  const toss = crypto.createHmac('sha256', DAILY_SECRET).update(`toss:${dateKey}`).digest();
  return { bag: shuffleWith(hmacRandomBelow(bagKey)), firstPlayer: (toss[0] & 1) === 0 ? 1 : 2 };
}
