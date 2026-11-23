// Saved games: every finished game with at least one signed-in player is
// kept permanently, attached to each signed-in player's account - games
// against bots (games/routes.js) and multiplayer games (mp/routes.js).
// The player's game history (and their profile, later) reads from here.
//
// A record:
// {
//   id,                      the game's own id
//   source: 'bot' | 'mp',
//   mode, lexicon, dailyDate,
//   seats: { 1: Seat, 2: Seat }   Seat = { userId, name, guest, botId }
//                                 (a guest's name is always stored as "Guest")
//   settings,                 multiplayer clock settings, or null
//   state,                    the finished engine state (board, racks, every
//                             move, the final result, Drawbacks) - enough to
//                             replay the game from either side
//   endedAt                   epoch ms
// }
//
// Two implementations with the same interface: Postgres for the service,
// memory for tests and local dev.

import { toClientSnapshot } from './view.js';

export const GUEST_NAME = 'Guest';
const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

// Is this record worth keeping? (At least one signed-in player.)
export const hasAccount = (record) => !!(record.seats[1]?.userId || record.seats[2]?.userId);

export function createMemoryArchive() {
  const records = new Map();
  return {
    records,
    async save(record) {
      if (!hasAccount(record) || records.has(record.id)) return false;
      records.set(record.id, clone(record));
      return true;
    },
    async listForUser(userId, { limit = 20, before = null } = {}) {
      return [...records.values()]
        .filter(r => r.seats[1]?.userId === userId || r.seats[2]?.userId === userId)
        .filter(r => before == null || r.endedAt < before)
        .sort((a, b) => b.endedAt - a.endedAt)
        .slice(0, limit)
        .map(clone);
    },
    // Every saved game's one-line summary for a player, newest first (for
    // profile stats).
    async linesForUser(userId, { limit = 2000 } = {}) {
      return [...records.values()]
        .filter(r => r.seats[1]?.userId === userId || r.seats[2]?.userId === userId)
        .sort((a, b) => b.endedAt - a.endedAt)
        .slice(0, limit)
        .map(r => lineFor(r, userId));
    },
    async getForUser(userId, id) {
      const r = records.get(id);
      return r && (r.seats[1]?.userId === userId || r.seats[2]?.userId === userId) ? clone(r) : null;
    },
  };
}

export async function ensureArchiveSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS finished_games (
      id             UUID PRIMARY KEY,
      source         TEXT NOT NULL,
      mode           TEXT NOT NULL,
      seat1_user_id  TEXT,
      seat2_user_id  TEXT,
      ended_at       TIMESTAMPTZ NOT NULL,
      data           JSONB NOT NULL
    );
    ALTER TABLE finished_games ADD COLUMN IF NOT EXISTS seat1_line JSONB;
    ALTER TABLE finished_games ADD COLUMN IF NOT EXISTS seat2_line JSONB;
    CREATE INDEX IF NOT EXISTS idx_finished_seat1 ON finished_games(seat1_user_id, ended_at DESC) WHERE seat1_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_finished_seat2 ON finished_games(seat2_user_id, ended_at DESC) WHERE seat2_user_id IS NOT NULL;
  `);
}

const fromRow = (row) => (row ? { ...row.data, id: row.id } : null);

export function createPgArchive(pool) {
  return {
    async save(record) {
      if (!hasAccount(record)) return false;
      const { id, ...data } = record;
      const { rowCount } = await pool.query(
        `INSERT INTO finished_games (id, source, mode, seat1_user_id, seat2_user_id, ended_at, data, seat1_line, seat2_line)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [id, record.source, record.mode, record.seats[1]?.userId ?? null, record.seats[2]?.userId ?? null, record.endedAt, data,
          record.seats[1]?.userId ? lineForSeat(record, 1) : null, record.seats[2]?.userId ? lineForSeat(record, 2) : null],
      );
      return rowCount > 0;
    },
    async listForUser(userId, { limit = 20, before = null } = {}) {
      const { rows } = await pool.query(
        `SELECT id, data FROM finished_games
         WHERE (seat1_user_id = $1 OR seat2_user_id = $1)
           AND ($2::bigint IS NULL OR ended_at < to_timestamp($2 / 1000.0))
         ORDER BY ended_at DESC LIMIT $3`,
        [userId, before, limit],
      );
      return rows.map(fromRow);
    },
    // The stored one-line summaries (worked out when the game was saved), so
    // profile stats don't have to load every whole game.
    async linesForUser(userId, { limit = 2000 } = {}) {
      const { rows } = await pool.query(
        `SELECT id, CASE WHEN seat1_user_id = $1 THEN seat1_line ELSE seat2_line END AS line
         FROM finished_games WHERE seat1_user_id = $1 OR seat2_user_id = $1
         ORDER BY ended_at DESC LIMIT $2`,
        [userId, limit],
      );
      const lines = [];
      for (const row of rows) {
        if (row.line) { lines.push(row.line); continue; }
        const record = await this.getForUser(userId, row.id); // saved before lines existed
        if (record) lines.push(lineFor(record, userId));
      }
      return lines;
    },
    async getForUser(userId, id) {
      const { rows } = await pool.query(
        'SELECT id, data FROM finished_games WHERE id = $1 AND (seat1_user_id = $2 OR seat2_user_id = $2)',
        [id, userId],
      );
      return fromRow(rows[0]);
    },
  };
}

// Saving never gets in the way of a game: a failure is logged, not thrown.
export async function saveFinished(archive, record) {
  if (!archive || !hasAccount(record)) return;
  try {
    await archive.save(record);
  } catch (err) {
    console.error(`[archive] couldn't save game ${record.id}:`, err.message);
  }
}

// --- What the player sees ---------------------------------------------------

const seatOf = (record, userId) => (record.seats[1]?.userId === userId ? 1 : record.seats[2]?.userId === userId ? 2 : null);

// One line of your game history: from your side.
export const summaryFor = (record, userId) => summaryForSeat(record, seatOf(record, userId));

function summaryForSeat(record, me) {
  const opp = me === 1 ? 2 : 1;
  const final = record.state.final ?? {};
  const scores = { 1: final.player1Score, 2: final.player2Score };
  const winnerSeat = final.winner === 'player' ? 1 : final.winner === 'bot' ? 2 : null;
  const theirs = record.seats[opp] ?? {};
  return {
    id: record.id,
    source: record.source,
    mode: record.mode,
    lexicon: record.lexicon,
    dailyDate: record.dailyDate ?? null,
    endedAt: record.endedAt,
    endReason: record.state.endReason,
    opponent: {
      name: theirs.guest ? GUEST_NAME : theirs.name,
      kind: theirs.botId ? 'bot' : theirs.guest ? 'guest' : 'player',
      botId: theirs.botId ?? null,
      // A signed-in opponent's account id. Never sent to the browser:
      // withCurrentNames (auth/mount.js) swaps it for their username as it
      // is now, so a rename doesn't break links to their profile.
      userId: !theirs.botId && !theirs.guest ? theirs.userId ?? null : null,
    },
    you: { score: scores[me] },
    them: { score: scores[opp] },
    result: winnerSeat == null ? 'draw' : winnerSeat === me ? 'win' : 'loss',
    moves: record.state.history.length,
    bingos: record.state.history.filter(h => h.player === me && h.isBingo).length,
    settings: record.settings ?? null,
  };
}

// A summary plus what profile stats need: your best single play and the
// biggest deficit you came back from to win.
export const lineFor = (record, userId) => lineForSeat(record, seatOf(record, userId));

export function lineForSeat(record, me) {
  const summary = summaryForSeat(record, me);
  let bestPlay = null;
  let worst = 0;
  const totals = { 1: 0, 2: 0 };
  for (const h of record.state.history) {
    if (h.player === me && h.type === 'play' && !h.stepIn && (!bestPlay || h.score > bestPlay.score)) {
      bestPlay = { score: h.score, word: h.words?.[0] ?? '', isBingo: !!h.isBingo };
    }
    if (typeof h.total === 'number') totals[h.player] = h.total;
    worst = Math.max(worst, totals[me === 1 ? 2 : 1] - totals[me]);
  }
  return { ...summary, bestPlay, comeback: summary.result === 'win' ? worst : 0 };
}

// The whole game for replay, from your side (everything is revealed: the
// game is over).
export function detailFor(record, userId) {
  const me = seatOf(record, userId);
  return {
    ...summaryFor(record, userId),
    you: { ...summaryFor(record, userId).you, name: record.seats[me]?.name },
    // Which seat that player had: the snapshot's overtime/timeout fields
    // are by seat.
    seat: me,
    state: toClientSnapshot(record.id, 0, record.state, { seat: me }),
  };
}
