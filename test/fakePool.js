// A stand-in for pg.Pool that understands exactly the queries games/repo.js
// sends, keeping rows in memory - lets the route tests run the real HTTP
// stack without a database. JSON is round-tripped like JSONB would be.

const jsonClone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

export function createFakePool() {
  const rows = new Map();
  return {
    rows,
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO games')) {
        const [id, tokenHash, mode, lexicon, opponentId, dailyDate, engineVersion, state] = params;
        rows.set(id, {
          id, token_hash: tokenHash, mode, lexicon, opponent_id: opponentId, daily_date: dailyDate,
          engine_version: engineVersion, state: jsonClone(state), version: 0, status: 'active',
          last_client_move_id: null, last_response: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith('SELECT id, token_hash, state, version')) {
        const row = rows.get(params[0]);
        return { rows: row ? [{ ...row, state: jsonClone(row.state), last_response: jsonClone(row.last_response) }] : [] };
      }
      if (s.startsWith('UPDATE games SET state = $3')) {
        const [id, expected, state, status] = params;
        const row = rows.get(id);
        if (!row || row.version !== expected) return { rows: [], rowCount: 0 };
        row.state = jsonClone(state);
        row.version += 1;
        row.status = status;
        return { rows: [{ version: row.version }], rowCount: 1 };
      }
      if (s.startsWith('UPDATE games SET last_client_move_id')) {
        const [id, version, clientMoveId, response] = params;
        const row = rows.get(id);
        if (row && row.version === version) {
          row.last_client_move_id = clientMoveId;
          row.last_response = jsonClone(response);
        }
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fakePool: unexpected query: ${s.slice(0, 60)}`);
    },
  };
}
