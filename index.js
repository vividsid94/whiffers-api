import express from 'express';
import cors from 'cors';
import pg from 'pg';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const PORT = process.env.PORT || 4000;
const DATABASE_URL = process.env.DATABASE_URL;
// Bundled directly in this repo (not a machine-specific path) so it exists
// on any deploy target, Railway included - ALLANNO_CSV can still override
// it for local testing against a different copy. fileURLToPath (not raw
// .pathname) handles Windows drive-letter URLs correctly.
const ALLANNO_CSV = process.env.ALLANNO_CSV || fileURLToPath(new URL('./allanno.csv', import.meta.url));
const CROSSTABLES_API = 'https://api.cross-tables.com';

if (!DATABASE_URL) {
  console.error('DATABASE_URL env var is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
// pg.Pool emits 'error' on an idle client's unexpected termination (e.g. a
// dropped connection from Railway's proxy) - without a handler, Node treats
// that as an uncaught exception and crashes the whole process even though
// the pool itself would otherwise just reconnect on the next query. This is
// a well-known pg gotcha, not optional defensive code.
pool.on('error', (err) => console.error('Unexpected idle client error on pool:', err.message));

// Log-and-continue rather than let an unhandled rejection silently kill the
// process (Node's default since v15) - added while diagnosing a mystery
// clean-exit-with-no-error-message during local testing, useful defensive
// visibility either way.
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

// allanno.csv is the source for "which annotated games is this player in" -
// covers all ~52,800 annotated games directly (opponent/tourney/lexicon/
// date), without needing every single one fully fetched+decoded into the
// annotated_games table first. Loaded once at startup and indexed by
// playerid; a production version would want to periodically refresh this
// from allanno.php rather than only reading a point-in-time local file, but
// that's a later concern, not needed for the first working version.
console.log('Loading allanno.csv...');
const rawCsv = fs.readFileSync(ALLANNO_CSV, 'utf8');
const annoRows = parse(rawCsv, { columns: true, skip_empty_lines: true, trim: true, escape: '\\', relax_quotes: true });
const gamesByPlayer = new Map(); // playerid -> array of games they appear in
for (const row of annoRows) {
  for (const [selfId, oppId, oppName] of [
    [row.player1ID, row.player2ID, row.player2Name],
    [row.player2ID, row.player1ID, row.player1Name],
  ]) {
    const pid = Number(selfId);
    if (!pid) continue; // anonymous/unlinked player, nothing to index under
    if (!gamesByPlayer.has(pid)) gamesByPlayer.set(pid, []);
    gamesByPlayer.get(pid).push({
      annotatedid: Number(row.ID),
      opponentName: oppName || null,
      opponentId: Number(oppId) || null,
      lexicon: row.lexicon || null,
      tourneyid: Number(row.tourneyID) || null,
      tourneydate: row.tourneydate && row.tourneydate !== '0' ? row.tourneydate : null,
      round: row.round || null,
    });
  }
}
console.log(`Indexed games for ${gamesByPlayer.size} distinct players`);

const app = express();
app.use(cors());

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// GET /player/:id - player info (DB-first, live-fetch-and-cache on miss so
// this works for ANY cross-tables player, not just the pre-populated
// active-players set) + their annotated games list (from the in-memory
// allanno.csv index, not DB-dependent).
app.get('/player/:id', async (req, res) => {
  const playerid = Number(req.params.id);
  if (!playerid || playerid < 1) {
    return res.status(400).json({ error: 'invalid player id' });
  }

  try {
    let { rows } = await pool.query('SELECT * FROM players WHERE playerid = $1', [playerid]);
    let player = rows[0];

    if (!player) {
      // Lazy fetch-and-cache: this player isn't pre-populated (not in the
      // active-players set, hasn't appeared in an ingested game) - fetch
      // live once, then it's cached for every future request.
      const playerResp = await fetchJson(`${CROSSTABLES_API}/player.php?player=${playerid}`);
      const p = playerResp.player;
      if (!p) return res.status(404).json({ error: 'player not found' });

      const upsertResult = await pool.query(
        `INSERT INTO players (playerid, name, currrating, twlrating, cswrating, peakrating, photourl)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (playerid) DO UPDATE SET
           name=$2, currrating=$3, twlrating=$4, cswrating=$5, peakrating=$6, photourl=$7, updated_at=now()
         RETURNING *`,
        [playerid, p.name, Number(p.currrating) || null, Number(p.twlrating) || null,
         Number(p.cswrating) || null, Number(p.peakrating) || null, p.photourl || null]
      );
      player = upsertResult.rows[0];
    }

    const games = (gamesByPlayer.get(playerid) || [])
      .slice()
      .sort((a, b) => (b.tourneydate || '').localeCompare(a.tourneydate || ''));

    res.json({ player, games });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`cross-tables-api listening on :${PORT}`));
