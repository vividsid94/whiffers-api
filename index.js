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

// Cross-tables is the only source of truth for ratings - this database
// never computes or derives anything itself, it's purely a cache of
// cross-tables' own answer. STALE_MS is how long a cached row is trusted
// before treating it like a miss and asking cross-tables again, rather than
// repeating a possibly-outdated answer forever. 24h is a starting default,
// not a tuned value - cheap to change.
const STALE_MS = 24 * 60 * 60 * 1000;

// Live-fetches one player from cross-tables and upserts the result -
// shared by both the "never seen this player" and "seen them, but the
// cached row is stale" paths below, so there's one implementation instead
// of two copies that could drift.
async function fetchAndCachePlayer(playerid) {
  const playerResp = await fetchJson(`${CROSSTABLES_API}/player.php?player=${playerid}`);
  const p = playerResp.player;
  if (!p) return null;

  const upsertResult = await pool.query(
    `INSERT INTO players (playerid, name, currrating, twlrating, cswrating, peakrating, photourl)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (playerid) DO UPDATE SET
       name=$2, currrating=$3, twlrating=$4, cswrating=$5, peakrating=$6, photourl=$7, updated_at=now()
     RETURNING *`,
    [playerid, p.name, Number(p.currrating) || null, Number(p.twlrating) || null,
     Number(p.cswrating) || null, Number(p.peakrating) || null, p.photourl || null]
  );
  return upsertResult.rows[0];
}

// GET /player/:id - player info (DB-first, live-fetch-and-cache on miss OR
// on a stale cached row, so this works for ANY cross-tables player, not
// just the pre-populated active-players set, and doesn't repeat an
// outdated rating forever) + their annotated games list (from the
// in-memory allanno.csv index, not DB-dependent).
app.get('/player/:id', async (req, res) => {
  const playerid = Number(req.params.id);
  if (!playerid || playerid < 1) {
    return res.status(400).json({ error: 'invalid player id' });
  }

  try {
    let { rows } = await pool.query('SELECT * FROM players WHERE playerid = $1', [playerid]);
    let player = rows[0];
    const isStale = player && (Date.now() - new Date(player.updated_at).getTime()) > STALE_MS;

    if (!player || isStale) {
      const fresh = await fetchAndCachePlayer(playerid);
      if (fresh) {
        player = fresh;
      } else if (!player) {
        // Never seen before AND cross-tables has nothing for this ID.
        return res.status(404).json({ error: 'player not found' });
      }
      // else: cross-tables fetch failed to return a player but we still
      // have a stale row - serve the stale data rather than a hard error,
      // same "graceful degrade" reasoning as elsewhere in this app.
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

// GET /players/search?q=name - simple name search over players already
// cached in this database. No live cross-tables fallback here (unlike
// /player/:id) - search only makes sense over players we already know
// about, not the full ~29,000-player universe.
app.get('/players/search', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  try {
    const { rows } = await pool.query(
      `SELECT playerid, name, currrating, twlrating, cswrating, photourl
       FROM players WHERE name ILIKE $1
       ORDER BY currrating DESC NULLS LAST LIMIT 25`,
      [`%${q}%`]
    );
    res.json({ results: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /players/rankings?limit=100 - top N cached players by current rating.
app.get('/players/rankings', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const { rows } = await pool.query(
      `SELECT playerid, name, currrating, twlrating, cswrating, photourl
       FROM players WHERE currrating IS NOT NULL
       ORDER BY currrating DESC LIMIT $1`,
      [limit]
    );
    res.json({ results: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`cross-tables-api listening on :${PORT}`));
