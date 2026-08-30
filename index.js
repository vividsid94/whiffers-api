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

// Copied verbatim from whiffers/scripts/cross-tables-db/ingest.mjs's own
// decodeGamehistory - the gamehistory field is base64-encoded binary (a
// protobuf message), not base64 plain text. Real GCG text starts at
// '#player1'; the trailer's own leading tag byte varies by field number
// (not always one fixed marker byte), so this scans for the first
// non-printable byte rather than relying on a single specific marker.
function decodeGamehistory(base64) {
  const decoded = Buffer.from(base64, 'base64').toString('binary');
  const gcgStart = decoded.indexOf('#player1');
  if (gcgStart === -1) return null;
  let end = decoded.length;
  for (let i = gcgStart; i < decoded.length; i++) {
    const c = decoded.charCodeAt(i);
    const printable = (c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x0d || c === 0x09;
    if (!printable) { end = i; break; }
  }
  return decoded.slice(gcgStart, end);
}

// Live-fetches and caches one game's content on demand. Deliberately lean
// compared to the offline ingest.mjs batch tool: player1id/player2id/
// tourneyid are left NULL here rather than resolved, since both columns are
// foreign keys (players.playerid / tourneys.tourneyid) - populating them
// would require upserting those related rows first (extra API calls) just
// to satisfy the constraint, for data the Viewer doesn't actually need to
// render a game's board. lexicon/round/source_url have no such constraint
// and are populated directly from the one API call already being made.
async function fetchAndCacheGame(annotatedid) {
  const raw = await fetchJson(`${CROSSTABLES_API}/annotated.php?annotatedid=${annotatedid}`);
  const gcg_text = decodeGamehistory(raw.gamehistory);
  if (!gcg_text) return null;

  const upsertResult = await pool.query(
    `INSERT INTO annotated_games (annotatedid, lexicon, gcg_text, source_url, round)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (annotatedid) DO UPDATE SET gcg_text = EXCLUDED.gcg_text
     RETURNING *`,
    [annotatedid, raw.lexicon || null, gcg_text, raw.source || null, raw.round || null]
  );
  return upsertResult.rows[0];
}

// GET /game/:annotatedid - a single game's raw GCG content (DB-first, live-
// fetch-and-cache on miss, same pattern as /player/:id below). No
// staleness check here unlike players - a finished historical game's own
// move-by-move content never changes once played, only the small chance it
// wasn't in our database yet.
// GET /game/random - picks a random annotatedid straight out of the
// in-memory allanno.csv index (already loaded at startup for the player-
// games lookup, no DB query needed here) and hands it back for the
// frontend to navigate to via the normal /game/:annotatedid path. Placed
// BEFORE that route on purpose - Express matches routes in registration
// order, so a literal "/game/random" registered after "/game/:annotatedid"
// would never be reached (it'd match the param route first, with
// "random" as the (invalid) id). Doesn't guarantee the picked id is
// actually fetchable (cross-tables' own API is occasionally down for a
// specific game, as already seen once) - the normal Viewer error state
// already handles that if it happens, and a re-roll is one click away.
app.get('/game/random', (req, res) => {
  for (let i = 0; i < 10; i++) {
    const row = annoRows[Math.floor(Math.random() * annoRows.length)];
    const annotatedid = Number(row.ID);
    if (annotatedid) return res.json({ annotatedid });
  }
  res.status(500).json({ error: 'failed to pick a random game' });
});

app.get('/game/:annotatedid', async (req, res) => {
  const annotatedid = Number(req.params.annotatedid);
  if (!annotatedid || annotatedid < 1) {
    return res.status(400).json({ error: 'invalid annotatedid' });
  }

  try {
    let { rows } = await pool.query('SELECT * FROM annotated_games WHERE annotatedid = $1', [annotatedid]);
    let game = rows[0];

    if (!game || !game.gcg_text) {
      const fresh = await fetchAndCacheGame(annotatedid);
      if (fresh) game = fresh;
      else if (!game) return res.status(404).json({ error: 'game not found' });
    }

    res.json({ game });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

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

// GET /players/rankings?limit=100 - top N cached players by their best
// rating. NOT `currrating` alone - confirmed directly against cross-tables'
// own API (and every one of the 990 real rows in this database) that
// currrating IS twlrating, just under a more general-sounding name. Filtering/
// sorting by currrating alone silently excludes CSW-only players entirely
// (not just ranks them lower) - e.g. Wellington Jighere, a real 2327-CSW-
// rated player with zero TWL games, has currrating=NULL and was completely
// missing from this endpoint before this fix. GREATEST(twlrating, cswrating)
// ignores NULLs and only returns NULL if both are null (Postgres behavior),
// so this correctly ranks everyone by whichever rating they actually have.
app.get('/players/rankings', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const { rows } = await pool.query(
      `SELECT playerid, name, currrating, twlrating, cswrating, photourl
       FROM players WHERE twlrating IS NOT NULL OR cswrating IS NOT NULL
       ORDER BY GREATEST(twlrating, cswrating) DESC LIMIT $1`,
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
