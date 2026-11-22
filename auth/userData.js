// Saved progress (ACCOUNTS_PLAN.md section 4): one JSON blob per signed-in
// player, so settings, streaks and Heads Will Roll follow you between
// devices.
//
// The table is declared as a Better Auth plugin schema, so the same
// migrations create it in Postgres and in the local PGlite database, and the
// same adapter reads and writes it in both.
//
// Shape (version 1):
//   settings: { theme: 'light'|'dark', soundMuted: boolean }
//   streak:   { win: number }
//   hwr:      { best: number, exhibits: { [id]: { at: ISO, seen: boolean } } }

export const userDataPlugin = () => ({
  id: 'whiffers-user-data',
  schema: {
    userData: {
      fields: {
        userId: { type: 'string', required: true, unique: true, references: { model: 'user', field: 'id', onDelete: 'cascade' } },
        data: { type: 'json', required: true },
        updatedAt: { type: 'date', required: true },
      },
    },
  },
});

export const MAX_DATA_BYTES = 64 * 1024;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

// Keeps only the fields we know, in the types we expect, so nothing else
// can be stored here.
export function cleanData(input) {
  const out = { v: 1 };
  if (!isObj(input)) return out;
  if (isObj(input.settings)) {
    const s = {};
    if (input.settings.theme === 'light' || input.settings.theme === 'dark') s.theme = input.settings.theme;
    if (typeof input.settings.soundMuted === 'boolean') s.soundMuted = input.settings.soundMuted;
    out.settings = s;
  }
  if (isObj(input.streak)) out.streak = { win: num(input.streak.win) };
  if (isObj(input.hwr)) {
    const exhibits = {};
    if (isObj(input.hwr.exhibits)) {
      for (const [id, e] of Object.entries(input.hwr.exhibits).slice(0, 2000)) {
        if (typeof id !== 'string' || id.length > 80 || !isObj(e)) continue;
        const at = typeof e.at === 'string' && !Number.isNaN(Date.parse(e.at)) ? e.at : new Date().toISOString();
        exhibits[id] = { at, seen: e.seen === true };
      }
    }
    out.hwr = { best: num(input.hwr.best), exhibits };
  }
  return out;
}

// Combining what's stored with what a device sends. Settings and the streak
// take the device's latest value; Heads Will Roll never loses anything (the
// higher best score, every exhibit from both, earliest unlock time, "seen" if
// either has seen it) - so two devices can't wipe each other's progress.
export function mergeData(stored, incoming) {
  const a = cleanData(stored);
  const b = cleanData(incoming);
  const out = { v: 1 };
  if (a.settings || b.settings) out.settings = { ...a.settings, ...b.settings };
  if (b.streak || a.streak) out.streak = b.streak ?? a.streak;
  if (a.hwr || b.hwr) {
    const exhibits = { ...(a.hwr?.exhibits ?? {}) };
    for (const [id, e] of Object.entries(b.hwr?.exhibits ?? {})) {
      const prev = exhibits[id];
      exhibits[id] = prev
        ? { at: prev.at < e.at ? prev.at : e.at, seen: prev.seen || e.seen }
        : e;
    }
    out.hwr = { best: Math.max(a.hwr?.best ?? 0, b.hwr?.best ?? 0), exhibits };
  }
  return out;
}

export async function readUserData(auth, userId) {
  const ctx = await auth.$context;
  const row = await ctx.adapter.findOne({ model: 'userData', where: [{ field: 'userId', value: userId }] });
  if (!row) return { data: { v: 1 }, updatedAt: null };
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  return { data: cleanData(data), updatedAt: row.updatedAt };
}

export async function writeUserData(auth, userId, incoming) {
  const ctx = await auth.$context;
  const row = await ctx.adapter.findOne({ model: 'userData', where: [{ field: 'userId', value: userId }] });
  const stored = row ? (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) : {};
  const data = mergeData(stored, incoming);
  const updatedAt = new Date();
  if (row) {
    await ctx.adapter.update({ model: 'userData', where: [{ field: 'userId', value: userId }], update: { data, updatedAt } });
  } else {
    await ctx.adapter.create({ model: 'userData', data: { userId, data, updatedAt } });
  }
  return { data, updatedAt };
}
