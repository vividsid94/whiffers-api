import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanData, mergeData } from '../auth/userData.js';

test('cleanData keeps only known fields and types', () => {
  const out = cleanData({
    settings: { theme: 'purple', soundMuted: 'yes', extra: 1 },
    streak: { win: -3 },
    hwr: { best: 12.7, exhibits: { a: { at: 'nonsense', seen: 1 }, b: 'x' } },
    junk: { big: true },
  });
  assert.deepEqual(Object.keys(out).sort(), ['hwr', 'settings', 'streak', 'v']);
  assert.deepEqual(out.settings, {});
  assert.equal(out.streak.win, 0);
  assert.equal(out.hwr.best, 12);
  assert.deepEqual(Object.keys(out.hwr.exhibits), ['a']);
  assert.equal(out.hwr.exhibits.a.seen, false);
});

test('mergeData: settings and streak take the newest; Heads Will Roll never loses anything', () => {
  const stored = {
    settings: { theme: 'dark', soundMuted: true },
    streak: { win: 5 },
    hwr: { best: 20, exhibits: { q1: { at: '2026-11-01T00:00:00.000Z', seen: true }, q2: { at: '2026-11-02T00:00:00.000Z', seen: false } } },
  };
  const incoming = {
    settings: { theme: 'light' },
    streak: { win: 0 },
    hwr: { best: 14, exhibits: { q2: { at: '2026-11-05T00:00:00.000Z', seen: true }, q3: { at: '2026-11-06T00:00:00.000Z', seen: false } } },
  };
  const out = mergeData(stored, incoming);
  assert.deepEqual(out.settings, { theme: 'light', soundMuted: true });
  assert.equal(out.streak.win, 0);
  assert.equal(out.hwr.best, 20);
  assert.deepEqual(Object.keys(out.hwr.exhibits).sort(), ['q1', 'q2', 'q3']);
  assert.deepEqual(out.hwr.exhibits.q2, { at: '2026-11-02T00:00:00.000Z', seen: true });
});

test('mergeData with nothing stored is just the cleaned input', () => {
  assert.deepEqual(mergeData(null, { streak: { win: 2 } }), { v: 1, streak: { win: 2 } });
});
