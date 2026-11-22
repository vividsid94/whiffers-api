// Storage for multiplayer games: one row per game (an invite becomes the
// game once someone joins). Two implementations with the same interface:
// Postgres for the real service, memory for tests and local dev.
//
// A game:
// {
//   id, code, status: 'waiting' | 'active' | 'ended' | 'cancelled',
//   version,                       bumped by every save (compare-and-swap)
//   settings: { mode, lexicon, minutes, overtimeMinutes, firstPlayer, challenge },
//   seats: { 1: Seat, 2: Seat | null }   Seat = { tokenHash, userId, name, guest }
//   state: engine state | null     (null while waiting)
//   clock: mp/clock.js clock | null
//   rematch: { 1: bool, 2: bool, gameId: null | id }
//   lastMoves: { [seat]: { clientMoveId, response } }   retry cache per seat
//   previousGameId, createdAt, updatedAt, expiresAt (epoch ms)
// }

const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function createMemoryStore() {
  const games = new Map();
  return {
    games,
    async insert(game) {
      if ([...games.values()].some(g => g.code && g.code === game.code)) throw Object.assign(new Error('duplicate code'), { code: '23505' });
      games.set(game.id, clone({ ...game, version: 0 }));
    },
    async get(id) { return clone(games.get(id) ?? null); },
    async getByCode(code) { return clone([...games.values()].find(g => g.code === code) ?? null); },
    async save(game, expectedVersion) {
      const row = games.get(game.id);
      if (!row || row.version !== expectedVersion) return null;
      const saved = clone({ ...game, version: expectedVersion + 1, updatedAt: Date.now() });
      games.set(game.id, saved);
      return saved.version;
    },
    async listActive() { return [...games.values()].filter(g => g.status === 'active').map(clone); },
    async cleanup(now) {
      let n = 0;
      for (const [id, g] of games) if (isStale(g, now)) { games.delete(id); n += 1; }
      return n;
    },
  };
}

// Waiting/cancelled invites go after a day; finished games after 30 days
// (they'll move to game history once that exists).
const DAY = 24 * 60 * 60 * 1000;
function isStale(g, now) {
  if (g.status === 'waiting' || g.status === 'cancelled') return now - g.createdAt > DAY;
  if (g.status === 'ended') return now - g.updatedAt > 30 * DAY;
  return false;
}

export async function ensureMultiplayerSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS mp_games (
      id             UUID PRIMARY KEY,
      code           TEXT UNIQUE,
      status         TEXT NOT NULL,
      version        INTEGER NOT NULL DEFAULT 0,
      seat1_user_id  TEXT,
      seat2_user_id  TEXT,
      data           JSONB NOT NULL,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_mp_games_status ON mp_games(status);
    CREATE INDEX IF NOT EXISTS idx_mp_games_seat1_user ON mp_games(seat1_user_id) WHERE seat1_user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_mp_games_seat2_user ON mp_games(seat2_user_id) WHERE seat2_user_id IS NOT NULL;
  `);
}

const toData = ({ id, code, status, version, ...rest }) => rest;
const fromRow = (row) => (row ? { ...row.data, id: row.id, code: row.code, status: row.status, version: row.version } : null);

export function createPgStore(pool) {
  return {
    async insert(game) {
      await pool.query(
        `INSERT INTO mp_games (id, code, status, version, seat1_user_id, seat2_user_id, data)
         VALUES ($1, $2, $3, 0, $4, $5, $6)`,
        [game.id, game.code, game.status, game.seats[1]?.userId ?? null, game.seats[2]?.userId ?? null, toData(game)],
      );
    },
    async get(id) {
      const { rows } = await pool.query('SELECT * FROM mp_games WHERE id = $1', [id]);
      return fromRow(rows[0]);
    },
    async getByCode(code) {
      const { rows } = await pool.query('SELECT * FROM mp_games WHERE code = $1', [code]);
      return fromRow(rows[0]);
    },
    async save(game, expectedVersion) {
      const { rows } = await pool.query(
        `UPDATE mp_games SET status = $3, version = version + 1, seat1_user_id = $4, seat2_user_id = $5, data = $6, updated_at = now()
         WHERE id = $1 AND version = $2 RETURNING version`,
        [game.id, expectedVersion, game.status, game.seats[1]?.userId ?? null, game.seats[2]?.userId ?? null, toData({ ...game, updatedAt: Date.now() })],
      );
      return rows[0]?.version ?? null;
    },
    async listActive() {
      const { rows } = await pool.query("SELECT * FROM mp_games WHERE status = 'active'");
      return rows.map(fromRow);
    },
    async cleanup() {
      const { rowCount } = await pool.query(
        `DELETE FROM mp_games WHERE (status IN ('waiting', 'cancelled') AND created_at < now() - interval '1 day')
           OR (status = 'ended' AND updated_at < now() - interval '30 days')`,
      );
      return rowCount;
    },
  };
}
