// Postgres storage for server-run games. One row per game; the whole engine
// state lives in `state` (JSONB). Every write is a compare-and-swap on
// `version`, so two tabs (or a retry racing the original) can never both
// land a move - the loser gets null back and routes.js answers 409.

export async function ensureGamesSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id                  UUID PRIMARY KEY,
      token_hash          BYTEA NOT NULL,
      mode                TEXT NOT NULL,
      lexicon             TEXT NOT NULL,
      opponent_id         TEXT NOT NULL,
      daily_date          DATE,
      engine_version      INTEGER NOT NULL,
      state               JSONB NOT NULL,
      version             INTEGER NOT NULL DEFAULT 0,
      status              TEXT NOT NULL DEFAULT 'active',
      last_client_move_id TEXT,
      last_response       JSONB,
      final_p1            INTEGER,
      final_p2            INTEGER,
      winner              TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
      ended_at            TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_games_updated_at ON games(updated_at);
    CREATE INDEX IF NOT EXISTS idx_games_daily ON games(daily_date) WHERE mode = 'daily';
  `);
}

export async function insertGame(pool, { id, tokenHash, mode, lexicon, opponentId, dailyDate, state }) {
  await pool.query(
    `INSERT INTO games (id, token_hash, mode, lexicon, opponent_id, daily_date, engine_version, state)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, tokenHash, mode, lexicon, opponentId, dailyDate, state.engineVersion, state],
  );
}

export async function loadGame(pool, id) {
  const { rows } = await pool.query(
    'SELECT id, token_hash, state, version, last_client_move_id, last_response FROM games WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

// Returns the new version, or null if someone else wrote first.
export async function saveGame(pool, id, expectedVersion, state) {
  const ended = state.ended;
  const { rows } = await pool.query(
    `UPDATE games SET
       state = $3,
       version = version + 1,
       status = $4,
       final_p1 = $5, final_p2 = $6, winner = $7,
       ended_at = CASE WHEN $4 = 'ended' THEN COALESCE(ended_at, now()) ELSE NULL END,
       updated_at = now()
     WHERE id = $1 AND version = $2
     RETURNING version`,
    [
      id, expectedVersion, state, ended ? 'ended' : 'active',
      ended ? state.final.player1Score : null,
      ended ? state.final.player2Score : null,
      ended ? state.final.winner : null,
    ],
  );
  return rows[0]?.version ?? null;
}

// The idempotency cache for a move: the response that was sent, keyed by
// the client's move id, written once the version for it is known.
export async function cacheResponse(pool, id, version, clientMoveId, response) {
  await pool.query(
    'UPDATE games SET last_client_move_id = $3, last_response = $4 WHERE id = $1 AND version = $2',
    [id, version, clientMoveId, response],
  );
}

// Finished games are kept a month, abandoned ones two weeks.
export async function cleanupGames(pool) {
  const { rowCount } = await pool.query(`
    DELETE FROM games
    WHERE (status = 'ended' AND updated_at < now() - interval '30 days')
       OR (status = 'active' AND updated_at < now() - interval '14 days')
  `);
  return rowCount;
}
