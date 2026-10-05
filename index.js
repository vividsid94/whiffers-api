import express from 'express';
import cors from 'cors';
import pg from 'pg';
import fs from 'fs';
import crypto from 'crypto';
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
// One shared secret gating POST /registry (see below) - a "temp password"
// as asked for, not a per-user account system. Required at startup same as
// DATABASE_URL so a misconfigured deploy fails loudly instead of silently
// accepting every upload (or every upload failing confusingly at request
// time instead of at boot).
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD;

if (!DATABASE_URL) {
  console.error('DATABASE_URL env var is required');
  process.exit(1);
}
if (!UPLOAD_PASSWORD) {
  console.error('UPLOAD_PASSWORD env var is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
// pg.Pool emits 'error' on an idle client's unexpected termination (e.g. a
// dropped connection from Railway's proxy) - without a handler, Node treats
// that as an uncaught exception and crashes the whole process even though
// the pool itself would otherwise just reconnect on the next query. This is
// a well-known pg gotcha, not optional defensive code.
pool.on('error', (err) => console.error('Unexpected idle client error on pool:', err.message));

// Self-healing schema check, run once at boot - this repo otherwise only
// does schema changes via one-off scripts in whiffers/scripts/cross-tables-db
// run by hand against DATABASE_URL (see add-players-location-column.mjs
// there), which requires DB tooling/credentials on whoever's deploying.
// ADD COLUMN IF NOT EXISTS is idempotent and cheap, so running it
// unconditionally on every boot is harmless once the column already exists -
// this means a plain push-and-redeploy of this service is enough on its
// own, no separate manual migration step required.
async function ensureSchema() {
  try {
    await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS location TEXT');
  } catch (err) {
    console.error('Schema check failed (location column):', err.message);
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS game_equity (
        playerid          INTEGER NOT NULL,
        annotatedid       INTEGER NOT NULL,
        total_equity_loss REAL NOT NULL,
        turns_analyzed    INTEGER NOT NULL,
        turns_skipped     INTEGER NOT NULL DEFAULT 0,
        turns             JSONB NOT NULL,
        lexicon_used      TEXT,
        computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (playerid, annotatedid)
      );
      CREATE INDEX IF NOT EXISTS idx_game_equity_playerid ON game_equity(playerid);
    `);
  } catch (err) {
    console.error('Schema check failed (game_equity table):', err.message);
  }
}

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
// Only POST /registry has a body - a 1MB cap is generous headroom for a
// GCG transcript (plain text, real games top out well under 100KB) while
// still bounding request size.
app.use(express.json({ limit: '1mb' }));

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
    `INSERT INTO players (playerid, name, currrating, twlrating, cswrating, peakrating, photourl, location)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (playerid) DO UPDATE SET
       name=$2, currrating=$3, twlrating=$4, cswrating=$5, peakrating=$6, photourl=$7, location=$8, updated_at=now()
     RETURNING *`,
    [playerid, p.name, Number(p.currrating) || null, Number(p.twlrating) || null,
     Number(p.cswrating) || null, Number(p.peakrating) || null, p.photourl || null, p.location || null]
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
  // player1id/player2id tacked onto the return value only - never written
  // to the DB row itself (still NULL there, see this function's own header
  // comment on why). computeGameEquity (equity-loss section) needs these
  // as a reliable, numeric way to tell which GCG side is "us" - the GCG's
  // own header names are NOT reliable for that (confirmed directly: real
  // games exist where the header is just "Kevin"/"Josh", nothing close to
  // either player's actual full display name).
  return { ...upsertResult.rows[0], player1id: Number(raw.player1id) || null, player2id: Number(raw.player2id) || null };
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

// GET /game/:annotatedid/ratings - resolves both players' ratings for one
// specific annotated game: their REAL rating AT THE TIME of that game, if
// it was part of a tracked tournament, falling back to their CURRENT
// rating (in the game's own lexicon) for untagged/casual games. Player/
// tourney identity comes straight from the already-in-memory allanno.csv
// index (player1ID/player2ID/tourneyID/lexicon columns), not a fresh
// annotated.php call - cheaper, and sidesteps that endpoint's own real
// flakiness (already seen 500 on a specific game this session) entirely
// for this feature.
//
// The tournament case uses cross-tables' own results.php - a player's
// per-tourney result includes a games[] array, one entry per round, each
// carrying that exact round's own annotatedid plus `rating`/
// `opponentrating` for both sides of that specific game (confirmed
// directly: game 36909's own entry shows Jackson Smylie's rating as 2007
// there, matching oldrating for that whole tourney - ratings don't drift
// mid-tournament, they're fixed going in). One call (as player1) is
// enough for both sides' numbers, no need to also query as player2.
//
// A third case exists too: some games are between fully anonymous/
// unlinked players (playerid 0 in allanno.csv - never had a real cross-
// tables account) - nothing to look up for those, historical or current.
app.get('/game/:annotatedid/ratings', async (req, res) => {
  const annotatedid = Number(req.params.annotatedid);
  if (!annotatedid || annotatedid < 1) {
    return res.status(400).json({ error: 'invalid annotatedid' });
  }

  const row = annoRows.find((r) => Number(r.ID) === annotatedid);
  if (!row) return res.status(404).json({ error: 'game not found' });

  const player1id = Number(row.player1ID) || 0;
  const player2id = Number(row.player2ID) || 0;
  const tourneyid = Number(row.tourneyID) || 0;
  const lexicon = row.lexicon || null;

  if (!player1id || !player2id) {
    return res.json({ source: 'unknown', player1Rating: null, player2Rating: null, lexicon });
  }

  try {
    if (tourneyid) {
      const data = await fetchJson(`${CROSSTABLES_API}/results.php?tourney=${tourneyid}&player=${player1id}`);
      for (const result of data.results || []) {
        const game = (result.games || []).find((g) => Number(g.annotatedid) === annotatedid);
        if (game) {
          return res.json({
            source: 'tournament',
            tourneyname: result.tourneyname || null,
            player1Rating: Number(game.rating) || null,
            player2Rating: Number(game.opponentrating) || null,
            lexicon,
          });
        }
      }
      // This specific game wasn't in that tourney's own results (a real
      // data quirk, not expected but not fatal either) - fall through to
      // current rating rather than erroring out.
    }

    const ratingField = (lexicon || '').toUpperCase().startsWith('CSW') ? 'cswrating' : 'twlrating';
    const [p1, p2] = await Promise.all([
      fetchJson(`${CROSSTABLES_API}/player.php?player=${player1id}`),
      fetchJson(`${CROSSTABLES_API}/player.php?player=${player2id}`),
    ]);
    res.json({
      source: 'current',
      player1Rating: Number(p1.player?.[ratingField]) || null,
      player2Rating: Number(p2.player?.[ratingField]) || null,
      lexicon,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// --- Internal registry -----------------------------------------------------
// User-uploaded games, gated by UPLOAD_PASSWORD - a second game source
// alongside cross-tables' own annotated_games, for GCGs that never came
// from cross-tables at all (schema.sql's registry_games table). Viewing is
// open to anyone; only POST (uploading) checks the password.

// Same #player1/#player2/#lexicon header scan whiffers' own gcgParser.js
// runs client-side (kept in exact sync deliberately - both read the same
// GCG convention) - used here purely so GET /registry's list view has a
// name/lexicon to show without re-parsing the full GCG on every request.
function extractGcgMeta(gcgText) {
  let player1Name = null;
  let player2Name = null;
  let lexicon = null;
  for (const line of gcgText.split('\n')) {
    let m;
    if ((m = line.match(/^#player1\s+\S+\s+(.+)$/))) player1Name = m[1].trim();
    else if ((m = line.match(/^#player2\s+\S+\s+(.+)$/))) player2Name = m[1].trim();
    else if ((m = line.match(/^#lexicon\s+(\S+)/))) lexicon = m[1];
  }
  return { player1Name, player2Name, lexicon };
}

// Constant-time compare so a wrong guess can't be timed character-by-
// character - low-stakes for a shared "temp password," but free to do
// correctly with crypto.timingSafeEqual, so no reason not to. Both buffers
// have to be equal LENGTH before timingSafeEqual will even compare them
// (it throws otherwise), hence the length check up front.
function checkUploadPassword(candidate) {
  const a = Buffer.from(String(candidate ?? ''));
  const b = Buffer.from(UPLOAD_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// POST /registry - password-gated upload. id is a short random slug
// prefixed with a letter (never purely digits), deliberately NOT in the
// same id space as cross-tables' own numeric annotatedid - Viewer.jsx's
// route param tells the two apart with a plain "is this all digits?"
// check and hits this table instead of /game/:annotatedid when it isn't.
app.post('/registry', async (req, res) => {
  const { password, gcgText, label, uploadedBy } = req.body || {};
  if (!checkUploadPassword(password)) {
    return res.status(401).json({ error: 'incorrect password' });
  }
  if (typeof gcgText !== 'string' || !gcgText.includes('#player1')) {
    return res.status(400).json({ error: 'gcgText must be a GCG transcript (missing #player1 header)' });
  }

  const id = 'w' + crypto.randomBytes(6).toString('hex');
  const { player1Name, player2Name, lexicon } = extractGcgMeta(gcgText);

  try {
    const { rows } = await pool.query(
      `INSERT INTO registry_games (id, label, player1_name, player2_name, lexicon, gcg_text, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, label || null, player1Name, player2Name, lexicon, gcgText, uploadedBy || null]
    );
    res.status(201).json({ game: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /registry - browse list, newest first. No gcg_text in the response -
// this is a picker list, not the game itself (GET /registry/:id below).
// Registered before /registry/:id on purpose, same reasoning as /game/random
// vs /game/:annotatedid above, even though "registry" itself could never
// collide with a generated 'w'+hex id - consistent ordering either way.
app.get('/registry', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, player1_name, player2_name, lexicon, uploaded_by, created_at
       FROM registry_games ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ results: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /registry/:id - one registry game's raw GCG, same { game: { gcg_text,
// lexicon, ... } } shape GET /game/:annotatedid already returns, so
// Viewer.jsx runs it through the exact same parseGCGToMoveHistory call
// either way - only the fetch URL differs.
app.get('/registry/:id', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM registry_games WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'game not found' });
    res.json({ game: rows[0] });
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

    // Equity-loss results (see "--- Equity Loss ---" below) - a left join
    // in JS rather than SQL since `games` itself comes from the in-memory
    // allanno.csv index, not a table. Games not yet computed just keep
    // these fields null/undefined - PlayerProfile.jsx treats that as "no
    // dropdown to show" rather than a loading/error state.
    const { rows: equityRows } = await pool.query(
      'SELECT annotatedid, total_equity_loss, turns_analyzed, turns_skipped, turns FROM game_equity WHERE playerid = $1',
      [playerid],
    );
    const equityByGame = new Map(equityRows.map((r) => [r.annotatedid, r]));
    for (const g of games) {
      const e = equityByGame.get(g.annotatedid);
      if (e) {
        g.equityLoss = e.total_equity_loss;
        g.turnsAnalyzed = e.turns_analyzed;
        g.turnsSkipped = e.turns_skipped;
        g.turns = e.turns;
      }
    }

    res.json({ player, games });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /players/rankings?limit=2000 - every cached player with a rating
// (978 as of writing - small enough to just send the whole set and let the
// frontend search/sort it client-side, rather than reissuing a differently-
// sorted/filtered query per interaction). The default limit is set well
// above that count on purpose - an earlier version of this endpoint used a
// real LIMIT 100 to only return the top players, and that silently broke
// once the frontend started re-sorting client-side: a player who's null in
// whatever column the SQL itself ordered by (e.g. Wellington Jighere, a
// real 2327-CSW-rated player with zero TWL games) never made it into the
// top 100 AT ALL once 100+ other players had a real TWL rating, so no
// amount of client-side re-sorting could ever surface him - the row simply
// wasn't there to sort. Sending everyone sidesteps that class of bug
// entirely: nobody can be excluded by a LIMIT that ran before the sort the
// user actually asked for.
//
// The WHERE clause still can't be `currrating` alone - confirmed directly
// against cross-tables' own API (and every one of the 990 real rows in this
// database) that currrating IS twlrating, just under a more general-
// sounding name, and filtering by it alone silently excludes CSW-only
// players entirely. GREATEST(twlrating, cswrating) ignores NULLs and only
// returns NULL if both are, so this still includes anyone with either.
app.get('/players/rankings', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 2000, 5000);
  try {
    const { rows } = await pool.query(
      `SELECT p.playerid, p.name, p.currrating, p.twlrating, p.cswrating, p.photourl, p.location,
              ge.avg_equity_loss AS "avgEquityLoss", ge.games_analyzed AS "gamesAnalyzed"
       FROM players p
       LEFT JOIN (
         SELECT playerid, AVG(total_equity_loss) AS avg_equity_loss, COUNT(*) AS games_analyzed
         FROM game_equity GROUP BY playerid
       ) ge ON ge.playerid = p.playerid
       WHERE p.twlrating IS NOT NULL OR p.cswrating IS NOT NULL
       ORDER BY p.twlrating DESC NULLS LAST LIMIT $1`,
      [limit]
    );
    res.json({ results: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// One-time backfill for players cached before the `location` column
// existed - fetchAndCachePlayer only ever refreshes ONE player's row (the
// one just viewed on their profile page), and /players/rankings never
// writes anything at all, so without this, most of the ~978 existing rows
// would just sit at location=NULL indefinitely, only filling in one at a
// time as people happen to get looked up individually. This walks every
// row missing a location and re-fetches just that field from cross-tables.
//
// Password-gated (same UPLOAD_PASSWORD temp-password convention /registry
// uses) since this is an admin action, not something any visitor should be
// able to trigger - a few hundred outbound calls to cross-tables on demand.
// Responds immediately and does the actual work after responding (plain
// fire-and-forget, not a job queue - this runs once, ever, by hand) so the
// request doesn't sit open for the minutes the full pass takes; progress
// goes to this service's own console log. 200ms between calls is just being
// a reasonable guest of cross-tables' free API, not a documented rate limit.
app.post('/admin/backfill-locations', async (req, res) => {
  const { password } = req.body || {};
  if (!checkUploadPassword(password)) {
    return res.status(401).json({ error: 'incorrect password' });
  }

  const { rows } = await pool.query('SELECT playerid FROM players WHERE location IS NULL');
  res.json({ status: 'started', playersToCheck: rows.length });

  let updated = 0;
  let failed = 0;
  for (const { playerid } of rows) {
    try {
      const { player: p } = await fetchJson(`${CROSSTABLES_API}/player.php?player=${playerid}`);
      if (p?.location) {
        await pool.query('UPDATE players SET location=$1, updated_at=now() WHERE playerid=$2', [p.location, playerid]);
        updated++;
      }
    } catch (err) {
      failed++;
      console.error(`backfill-locations: player ${playerid} failed:`, err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.log(`backfill-locations done: ${updated} updated, ${failed} failed, out of ${rows.length} checked`);
});

// --- Equity Loss ------------------------------------------------------------
// Per-player, per-game aggregate: how much equity (score + leave value) a
// player's actual plays left on the table versus the move generator's own
// best answer for that exact position, from turn 1 until the position
// reaches 14 unseen tiles from their own point of view (bag + opponent's
// rack combined) - the standard pre-endgame cutoff. See
// whiffers/src/pages/Players.jsx and PlayerProfile.jsx for where this
// surfaces, and the plan this was built from for the full design.
//
// Every helper below is a verbatim-with-attribution copy of an existing,
// already-proven pure function living in the whiffers frontend repo - same
// cross-repo duplication precedent decodeGamehistory above already
// established (no shared package; these are small and rarely change).

// Copied from whiffers/src/data/staticData.js.
const letterLookup = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, I: 9, J: 10, K: 11, L: 12, M: 13, N: 14, O: 15 };
const origPool = 'AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ??';
const origBoard = `[    [4,0,0,1,0,0,0,4,0,0,0,1,0,0,4],
    [0,3,0,0,0,2,0,0,0,2,0,0,0,3,0],
    [0,0,3,0,0,0,1,0,1,0,0,0,3,0,0],
    [1,0,0,3,0,0,0,1,0,0,0,3,0,0,1],
    [0,0,0,0,3,0,0,0,0,0,3,0,0,0,0],
    [0,2,0,0,0,2,0,0,0,2,0,0,0,2,0],
    [0,0,1,0,0,0,1,0,1,0,0,0,1,0,0],
    [4,0,0,1,0,0,0,5,0,0,0,1,0,0,4],
    [0,0,1,0,0,0,1,0,1,0,0,0,1,0,0],
    [0,2,0,0,0,2,0,0,0,2,0,0,0,2,0],
    [0,0,0,0,3,0,0,0,0,0,3,0,0,0,0],
    [1,0,0,3,0,0,0,1,0,0,0,3,0,0,1],
    [0,0,3,0,0,0,1,0,1,0,0,0,3,0,0],
    [0,3,0,0,0,2,0,0,0,2,0,0,0,3,0],
    [4,0,0,1,0,0,0,4,0,0,0,1,0,0,4]]`;

// Copied from whiffers/src/functions/gcgParser.js's own parseGCGToMoveHistory
// and its private helpers - see that file for the full rationale on every
// format quirk handled below (verified directly against real cross-tables
// games, not guessed). Only the imports changed (origBoard/letterLookup are
// module-level consts here instead of a staticData.js import).
function freshBoard() {
  return JSON.parse(origBoard).map((row) => row.map(Number));
}
function cloneBoard(board) {
  return board.map((row) => [...row]);
}
// NOTE: this diverges from gcgParser.js's own parseHeader in one way -
// that function only keeps the full display name and discards the short
// username token (\S+) that precedes it, since whiffers' own moveHistory
// already re-labels every entry with the display name (see
// parseGCGToMoveHistory below, which does the same here). But a GCG move
// line itself (">username: ...") is keyed by that SHORT username, not the
// display name - computeGameEquity needs the username to know which
// entries are its own turns, so both are captured here.
function parseGcgHeader(lines) {
  let player1Name = null;
  let player2Name = null;
  let player1Username = null;
  let player2Username = null;
  let lexicon = null;
  for (const line of lines) {
    let m;
    if ((m = line.match(/^#player1\s+(\S+)\s+(.+)$/))) { player1Username = m[1]; player1Name = m[2].trim(); }
    else if ((m = line.match(/^#player2\s+(\S+)\s+(.+)$/))) { player2Username = m[1]; player2Name = m[2].trim(); }
    else if ((m = line.match(/^#lexicon\s+(\S+)/))) lexicon = m[1];
  }
  return { player1Name, player2Name, player1Username, player2Username, lexicon };
}
function decodePosition(field) {
  let m = field.match(/^(\d+)([A-O])$/);
  if (m) return { row: Number(m[1]) - 1, col: letterLookup[m[2]] - 1, isHorizontal: true };
  m = field.match(/^([A-O])(\d+)$/);
  if (m) return { row: Number(m[2]) - 1, col: letterLookup[m[1]] - 1, isHorizontal: false };
  return null;
}
function parseLeadingInt(token) {
  const m = (token || '').match(/^\+?(\d+)/);
  return m ? Number(m[1]) : NaN;
}
function classifyAndParseTokens(rest) {
  const trimmed = rest.trim();
  if (trimmed.includes('(')) {
    const m = trimmed.match(/^(\S*)\s*\(([^)]*)\)\s*\+?(-?\d+)\s+(\d+)/);
    if (m) {
      return { type: 'endgameBonus', rack: m[1], tiles: m[2], score: Number(m[3]), total: Number(m[4]) };
    }
  }
  const tokens = trimmed.split(/\s+/);
  const rack = tokens[0];
  const second = tokens[1] || '';
  if (second === '--') {
    return { type: 'challenge', rack };
  }
  if (second.startsWith('-')) {
    const tiles = second.slice(1);
    const score = parseLeadingInt(tokens[2]);
    const total = parseLeadingInt(tokens[3]);
    return tiles === ''
      ? { type: 'pass', rack, score, total }
      : { type: 'exchange', rack, tilesExchanged: tiles, score, total };
  }
  return {
    type: 'play', rack, position: second, word: tokens[2],
    score: parseLeadingInt(tokens[3]), total: parseLeadingInt(tokens[4]),
  };
}
function parseMoveLine(line) {
  const m = line.match(/^>(\S+):\s*(.*)$/);
  if (!m) return null;
  const parsed = classifyAndParseTokens(m[2]);
  return parsed ? { ...parsed, player: m[1] } : null;
}

// Returns { moveHistory, blankTiles, player1Name, player2Name,
// player1Username, player2Username, lexicon } - see gcgParser.js's own
// JSDoc for the exact moveHistory entry shape (note: every entry's own
// `player` field is the short USERNAME, same as a raw GCG move line's own
// ">username:" token - the two added Username fields here are what let a
// caller map that back to a display name/identity).
function parseGCGToMoveHistory(gcgText) {
  const lines = (gcgText || '').replace(/\r\n?/g, '\n').split('\n');
  const { player1Name, player2Name, player1Username, player2Username, lexicon } = parseGcgHeader(lines);

  let board = freshBoard();
  const blankTiles = [];
  const moveHistory = [];

  for (const line of lines) {
    if (line.startsWith('#note') || !line.startsWith('>')) continue;
    const parsed = parseMoveLine(line);
    if (!parsed) continue;

    if (parsed.type === 'pass') {
      moveHistory.push({
        beforeBoard: cloneBoard(board), afterBoard: cloneBoard(board),
        player: parsed.player, score: 0, rack: parsed.rack, total: parsed.total, word: 'Pass',
      });
      continue;
    }
    if (parsed.type === 'exchange') {
      moveHistory.push({
        beforeBoard: cloneBoard(board), afterBoard: cloneBoard(board),
        player: parsed.player, score: 0, rack: parsed.rack, total: parsed.total,
        word: 'Exchange', tilesExchanged: parsed.tilesExchanged,
      });
      continue;
    }
    if (parsed.type === 'challenge') {
      const last = moveHistory[moveHistory.length - 1];
      if (last && last.player === parsed.player) {
        board = cloneBoard(last.beforeBoard);
        moveHistory.push({
          beforeBoard: cloneBoard(last.afterBoard), afterBoard: cloneBoard(board),
          player: parsed.player, score: -last.score, rack: parsed.rack,
          total: last.total - last.score, word: 'Lost challenge',
        });
      }
      continue;
    }
    if (parsed.type === 'endgameBonus') {
      const wentOut = parsed.rack === '';
      moveHistory.push({
        beforeBoard: cloneBoard(board), afterBoard: cloneBoard(board),
        player: parsed.player, score: parsed.score, total: parsed.total,
        rack: parsed.rack,
        word: wentOut ? 'Endgame bonus' : 'Rack penalty',
        revealedOpponentRack: wentOut ? parsed.tiles : undefined,
      });
      continue;
    }

    const pos = decodePosition(parsed.position);
    if (!pos) continue;
    const beforeBoard = cloneBoard(board);
    const afterBoard = cloneBoard(board);
    let { row, col } = pos;
    for (let i = 0; i < parsed.word.length; i++) {
      const ch = parsed.word[i];
      if (ch !== '.') {
        const isBlank = ch >= 'a' && ch <= 'z';
        afterBoard[row][col] = ch.toUpperCase();
        if (isBlank) blankTiles.push({ row, col });
      }
      if (pos.isHorizontal) col++; else row++;
    }
    board = afterBoard;
    moveHistory.push({
      beforeBoard, afterBoard,
      player: parsed.player, score: parsed.score, rack: parsed.rack, total: parsed.total,
      word: parsed.word.replace(/\./g, '').toUpperCase(),
    });
  }

  return { moveHistory, blankTiles, player1Name, player2Name, player1Username, player2Username, lexicon };
}

// Copied from whiffers/src/functions/play/moveHistoryFunctions.js.
function findPlacedTiles(beforeBoard, afterBoard) {
  if (!beforeBoard || !afterBoard) return [];
  const placed = [];
  for (let row = 0; row < afterBoard.length; row++) {
    for (let col = 0; col < afterBoard[row].length; col++) {
      const before = beforeBoard[row]?.[col];
      const after = afterBoard[row]?.[col];
      if (typeof after === 'string' && typeof before !== 'string') {
        placed.push({ row, col });
      }
    }
  }
  return placed;
}
function placedTilesSignature(cells) {
  return cells.map((t) => `${t.row},${t.col},${t.letter}`).sort().join('|');
}

// Copied from whiffers/src/functions/viewer/computeRetroactivePool.js - the
// full 100-tile set minus every tile on the board minus one rack. Its
// length is "bag + the other player's unseen hand" from whichever rack was
// passed in - exactly the "14 unseen" cutoff quantity, with no separate
// true-bag-count needed (same blended number Viewer's own Ask Wally already
// sends the move generator as poolSize - see resolveAnalysisLexicon's own
// comment for why this app treats the two as one quantity).
function computeRetroactivePool(board, blankTiles, rack) {
  const remaining = origPool.split('');
  function removeOne(ch) {
    const idx = remaining.indexOf(ch);
    if (idx !== -1) remaining.splice(idx, 1);
  }
  for (let row = 0; row < board.length; row++) {
    for (let col = 0; col < board[row].length; col++) {
      const cell = board[row][col];
      if (typeof cell !== 'string') continue;
      const isBlank = blankTiles.some((b) => b.row === row && b.col === col);
      removeOne(isBlank ? '?' : cell);
    }
  }
  for (const ch of rack) removeOne(ch);
  return remaining;
}

// Copied from whiffers/src/functions/play/botFunctions.js.
function buildBoardForRequest(boardCoords, blankTiles) {
  return boardCoords.map((row, r) => row.map((cell, c) => {
    if (typeof cell !== 'string') return '';
    const isBlank = blankTiles.some((b) => b.row === r && b.col === c);
    return isBlank ? cell.toLowerCase() : cell;
  }));
}

// Copied from whiffers/src/functions/viewer/resolveAnalysisLexicon.js - see
// that file for the full rationale (exact-match against every lexicon
// main-for-scrabble.go now loads, approximate NASPA/Collins-family fallback
// otherwise).
const SUPPORTED_LEXICONS = ['NWL23', 'CSW24', 'TWL06', 'TWL14', 'OTCWL2016', 'NWL18', 'NWL20', 'WOW24'];
function resolveAnalysisLexicon(rawLexicon) {
  const normalized = (rawLexicon || '').toUpperCase();
  if (SUPPORTED_LEXICONS.includes(normalized)) {
    return { lexicon: normalized, isApproximate: false };
  }
  const isCollinsFamily = normalized.startsWith('CSW') || normalized.startsWith('SOWPODS') || normalized.startsWith('COLLINS');
  return { lexicon: isCollinsFamily ? 'CSW24' : 'NWL23', isApproximate: true };
}

const GO_SERVICE_URL = 'https://scrabble-move-generator-production.up.railway.app';

// Word labels gcgParser.js uses for bookkeeping entries that aren't a real
// rack decision (challenge reversal, end-of-game rack bonus/penalty) - never
// scored, same reasoning Viewer's own drawback-evaluation code excludes them
// for (see whiffers' evaluate.js NON_PLAY_WORDS).
const NON_DECISION_WORDS = new Set(['Lost challenge', 'Endgame bonus', 'Rack penalty']);

function exchangeLetterSignature(letters) {
  return [...letters].sort().join('');
}

// Computes and upserts one (playerid, annotatedid) pair's equity-loss row.
// Returns { tag, turnsAnalyzed, turnsSkipped } for the caller's own run
// counters - tag is 'scored' | 'skipped-name-mismatch' | 'error'. Never
// throws - every failure mode is caught and reported back as a tag
// instead, so one bad game can't take down the whole batch loop.
async function computeGameEquity(playerid, annotatedid, opponentName) {
  try {
    // Always a fresh fetch (not the DB-cache-first pattern /game/:annotatedid
    // uses) specifically to get player1id/player2id - annotated.php's own
    // response carries these as real cross-tables ids, which is a far more
    // reliable way to tell "which GCG side is us" than matching display
    // names (confirmed directly: real GCGs exist whose header is just
    // "Kevin"/"Josh", nothing close to either player's actual full name).
    // gcg_text itself still gets cached by this same call as always - only
    // the "skip re-fetching if already cached" optimization is skipped here.
    const game = await fetchAndCacheGame(annotatedid);
    if (!game || !game.gcg_text) return { tag: 'error', turnsAnalyzed: 0, turnsSkipped: 0 };

    const {
      moveHistory, blankTiles, player1Name, player2Name,
      player1Username, player2Username, lexicon: gcgLexicon,
    } = parseGCGToMoveHistory(game.gcg_text);

    let ourUsername = null;
    if (game.player1id === playerid && game.player2id !== playerid) ourUsername = player1Username;
    else if (game.player2id === playerid && game.player1id !== playerid) ourUsername = player2Username;

    // Fallback only for the rare case cross-tables' own response didn't
    // carry a usable player1id/player2id (e.g. an anonymous/unlinked
    // opponent) - the same display-name elimination as before, strictly
    // worse than the id check above but better than nothing.
    if (!ourUsername) {
      const norm = (s) => (s || '').trim().toLowerCase();
      const p1IsOpponent = norm(player1Name) === norm(opponentName);
      const p2IsOpponent = norm(player2Name) === norm(opponentName);
      if (p1IsOpponent && !p2IsOpponent) ourUsername = player2Username;
      else if (p2IsOpponent && !p1IsOpponent) ourUsername = player1Username;
    }
    if (!ourUsername) return { tag: 'skipped-name-mismatch', turnsAnalyzed: 0, turnsSkipped: 0 };

    // Same fallback chain Viewer.jsx itself already uses (parsed.lexicon ||
    // game.lexicon) - a lot of real GCGs carry no #lexicon header line at
    // all (confirmed directly on this exact game), so the GCG text's own
    // tag alone isn't reliable; annotated.php's separate top-level lexicon
    // field (already stored on this same `game` row) is the real fallback,
    // not just "give up and approximate to NWL23."
    const { lexicon: resolvedLexicon } = resolveAnalysisLexicon(gcgLexicon || game.lexicon);

    const turns = [];
    let totalEquityLoss = 0;
    let turnsAnalyzed = 0;
    let turnsSkipped = 0;

    for (const entry of moveHistory) {
      // blankTiles (from the parse) is the FULL list of every blank this
      // game ever places, at fixed, never-reused board cells - filtering it
      // down to ones already sitting on THIS entry's own beforeBoard is
      // exactly "blanks placed strictly before this turn," with no separate
      // turn-by-turn bookkeeping needed.
      const blanksBeforeThisEntry = blankTiles.filter(
        (b) => typeof entry.beforeBoard[b.row]?.[b.col] === 'string',
      );

      if (entry.player !== ourUsername) continue;
      if (NON_DECISION_WORDS.has(entry.word)) continue;

      const unseen = computeRetroactivePool(entry.beforeBoard, blanksBeforeThisEntry, entry.rack);
      if (unseen.length <= 14) break; // pre-endgame cutoff reached - stop this game entirely

      if (entry.word === 'Pass') {
        turns.push({ turnIndex: turns.length, type: 'pass', skipped: true });
        turnsSkipped++;
        continue;
      }

      // tilesExchanged (not word text) is the real signal an entry is an
      // exchange - word is always the literal string 'Exchange' for one,
      // but matching on the data field rather than display text avoids any
      // chance of confusion with a genuine (if vanishingly unlikely) real
      // word play that happened to spell "EXCHANGE".
      const isExchangeEntry = entry.tilesExchanged != null;
      const turnType = isExchangeEntry ? 'exchange' : 'play';

      try {
        const res = await fetch(`${GO_SERVICE_URL}/generate-moves`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            board: buildBoardForRequest(entry.beforeBoard, blanksBeforeThisEntry),
            rack: entry.rack, topN: 1000, poolSize: unseen.length, lexicon: resolvedLexicon,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const candidates = data.moves || [];
        if (candidates.length === 0) throw new Error('no candidates returned');
        const best = candidates[0];

        let matched;
        if (isExchangeEntry) {
          const sig = exchangeLetterSignature(entry.tilesExchanged);
          matched = candidates.find((c) => c.isExchange && exchangeLetterSignature(c.word.replace(/^Exchange\s*/, '')) === sig);
        } else {
          const placed = findPlacedTiles(entry.beforeBoard, entry.afterBoard).map(({ row, col }) => ({
            row, col, letter: entry.afterBoard[row][col],
          }));
          const sig = placedTilesSignature(placed);
          matched = candidates.find((c) => !c.isExchange && placedTilesSignature((c.tiles || []).filter((t) => t.isNew)) === sig);
        }

        if (!matched) {
          turns.push({ turnIndex: turns.length, type: turnType, word: entry.word, score: entry.score, skipped: true, reason: 'not-found-in-candidates' });
          turnsSkipped++;
          continue;
        }

        const equityLoss = Math.max(0, best.totalValue - matched.totalValue);
        totalEquityLoss += equityLoss;
        turnsAnalyzed++;
        turns.push({
          turnIndex: turns.length, type: turnType,
          word: entry.word, score: entry.score, actualEquity: matched.totalValue,
          bestWord: best.word, bestEquity: best.totalValue, equityLoss,
        });
      } catch (err) {
        turns.push({ turnIndex: turns.length, type: turnType, word: entry.word, score: entry.score, skipped: true, reason: err.message });
        turnsSkipped++;
      }
    }

    await pool.query(
      `INSERT INTO game_equity (playerid, annotatedid, total_equity_loss, turns_analyzed, turns_skipped, turns, lexicon_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (playerid, annotatedid) DO UPDATE SET
         total_equity_loss=$3, turns_analyzed=$4, turns_skipped=$5, turns=$6, lexicon_used=$7, computed_at=now()`,
      [playerid, annotatedid, totalEquityLoss, turnsAnalyzed, turnsSkipped, JSON.stringify(turns), resolvedLexicon],
    );
    return { tag: 'scored', turnsAnalyzed, turnsSkipped };
  } catch (err) {
    console.error(`computeGameEquity(${playerid}, ${annotatedid}) failed:`, err.message);
    return { tag: 'error', turnsAnalyzed: 0, turnsSkipped: 0 };
  }
}

// Job control - module-level state for the one background job this service
// runs at a time. Deliberately in-memory, not persisted: a Railway restart
// mid-run just stops it (nothing lost - every completed game is already
// committed to game_equity), and /admin/equity-loss/start simply needs
// triggering again to resume, same as after a deliberate /stop.
const equityJob = {
  running: false,
  shouldStop: false,
  startedAt: null,
  queueRemaining: 0,
  gamesCompletedThisRun: 0,
  turnsScoredThisRun: 0,
  turnsSkippedThisRun: 0,
  gamesSkippedThisRun: 0,
};
const EQUITY_JOB_CONCURRENCY = 7;

app.post('/admin/equity-loss/start', async (req, res) => {
  const { password, reset } = req.body || {};
  if (!checkUploadPassword(password)) {
    return res.status(401).json({ error: 'incorrect password' });
  }
  if (equityJob.running) {
    return res.status(409).json({ error: 'already running', ...equityJob });
  }

  // reset: true wipes every existing game_equity row first - for recomputing
  // everything from scratch after a fix to computeGameEquity itself (the
  // normal skip-already-done resumability is specifically wrong in that
  // case, since "already done" rows may hold results from the OLD, buggy
  // logic). Not exposed as a separate endpoint - this is still the same
  // password-gated admin action, just with an extra explicit flag.
  if (reset === true) {
    await pool.query('DELETE FROM game_equity');
  }

  // Fresh queue every /start - highest-rated player first (GREATEST ignores
  // NULLs, same convention /players/rankings' own WHERE clause already
  // uses), every (playerid, annotatedid) pair that player's own games list
  // carries, minus whatever's already in game_equity. Rebuilding from
  // scratch each run (rather than persisting a queue) is what makes this
  // automatically pick up newly-cached players/games with zero bookkeeping.
  const { rows: ranked } = await pool.query(
    `SELECT playerid FROM players
     WHERE twlrating IS NOT NULL OR cswrating IS NOT NULL
     ORDER BY GREATEST(twlrating, cswrating) DESC NULLS LAST`,
  );
  const { rows: doneRows } = await pool.query('SELECT playerid, annotatedid FROM game_equity');
  const done = new Set(doneRows.map((r) => `${r.playerid}:${r.annotatedid}`));

  const queue = [];
  for (const { playerid } of ranked) {
    for (const g of gamesByPlayer.get(playerid) || []) {
      if (!g.opponentName) continue; // can't tell our name from theirs without it
      if (done.has(`${playerid}:${g.annotatedid}`)) continue;
      queue.push({ playerid, annotatedid: g.annotatedid, opponentName: g.opponentName });
    }
  }

  equityJob.running = true;
  equityJob.shouldStop = false;
  equityJob.startedAt = new Date().toISOString();
  equityJob.queueRemaining = queue.length;
  equityJob.gamesCompletedThisRun = 0;
  equityJob.turnsScoredThisRun = 0;
  equityJob.turnsSkippedThisRun = 0;
  equityJob.gamesSkippedThisRun = 0;

  res.json({ status: 'started', queued: queue.length });

  // Fire-and-forget worker pool - EQUITY_JOB_CONCURRENCY workers each pull
  // the next queue item until it's empty or shouldStop is set. Not awaited
  // by the response above on purpose (same pattern as /admin/backfill-locations).
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length && !equityJob.shouldStop) {
      const item = queue[cursor++];
      equityJob.queueRemaining = queue.length - cursor;
      const result = await computeGameEquity(item.playerid, item.annotatedid, item.opponentName);
      equityJob.turnsScoredThisRun += result.turnsAnalyzed;
      equityJob.turnsSkippedThisRun += result.turnsSkipped;
      if (result.tag === 'scored') {
        equityJob.gamesCompletedThisRun++;
      } else {
        equityJob.gamesSkippedThisRun++;
      }
    }
  }
  const workers = Array.from({ length: EQUITY_JOB_CONCURRENCY }, () => worker());
  Promise.all(workers).then(() => {
    equityJob.running = false;
    console.log(`equity-loss run finished/stopped: ${equityJob.gamesCompletedThisRun} scored, ${equityJob.gamesSkippedThisRun} skipped`);
  });
});

app.post('/admin/equity-loss/stop', (req, res) => {
  const { password } = req.body || {};
  if (!checkUploadPassword(password)) {
    return res.status(401).json({ error: 'incorrect password' });
  }
  equityJob.shouldStop = true;
  res.json({ status: 'stopping', ...equityJob });
});

app.get('/admin/equity-loss/status', (req, res) => {
  res.json(equityJob);
});

// --- Monster Puzzle -------------------------------------------------------
// Precomputed puzzle positions - whiffers/scripts/generateMonsterPuzzles.mjs
// writes rows directly into this table (see that script's own header for
// how a position qualifies). category/margin/word_length are real indexed
// columns specifically for this filtering; board/move history/candidates/
// pool are JSONB, returned to the client as-is - pg already parses JSONB
// columns back into real objects/arrays on SELECT, no manual JSON.parse
// needed here.
function mapMonsterPuzzleRow(row) {
  return {
    id: row.id,
    sourceWord: row.source_word,
    sourceGame: row.source_game,
    category: row.category,
    margin: Number(row.margin),
    rack: row.rack,
    opponentRack: row.opponent_rack,
    currentPlayer: row.current_player,
    player1Name: row.player1_name,
    player2Name: row.player2_name,
    player1Points: row.player1_points,
    player2Points: row.player2_points,
    board: row.board,
    pausedMove: row.paused_move,
    pausedCandidates: row.paused_candidates,
    moveHistory: row.move_history,
    blankTiles: row.blank_tiles,
    pool: row.pool,
  };
}

// GET /monster-puzzle/random?category=monster|overlap&minMargin=&minWordLength=&excludeGame=
// Picks one random matching row - ORDER BY RANDOM() is fine at this table's
// current size (hundreds to low thousands of rows), would need a different
// approach (TABLESAMPLE, or a precomputed random-order key column) well
// before that stops being true. Registered BEFORE /monster-puzzle/:id for
// the same reason /game/random precedes /game/:annotatedid above - Express
// matches route registration order, so the literal path has to come first
// or ":id" would swallow "random" as an (invalid) id.
app.get('/monster-puzzle/random', async (req, res) => {
  const { category, minMargin, minWordLength, excludeGame } = req.query;
  const conditions = [];
  const params = [];

  if (category) { params.push(category); conditions.push(`category = $${params.length}`); }
  if (minMargin) { params.push(Number(minMargin)); conditions.push(`margin >= $${params.length}`); }
  if (minWordLength) { params.push(Number(minWordLength)); conditions.push(`word_length >= $${params.length}`); }
  if (excludeGame) { params.push(excludeGame); conditions.push(`source_game != $${params.length}`); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const { rows } = await pool.query(`SELECT * FROM monster_puzzles ${where} ORDER BY RANDOM() LIMIT 1`, params);
    if (rows.length === 0) return res.status(404).json({ error: 'no matching puzzle found' });
    res.json({ entry: mapMonsterPuzzleRow(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// GET /monster-puzzle/:id - one specific puzzle by id, for resolving a
// shared link (whiffers' own shareLinkFunctions.js {type:'monster', id} payload).
app.get('/monster-puzzle/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id || id < 1) return res.status(400).json({ error: 'invalid id' });

  try {
    const { rows } = await pool.query('SELECT * FROM monster_puzzles WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'puzzle not found' });
    res.json({ entry: mapMonsterPuzzleRow(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

await ensureSchema();
app.listen(PORT, () => console.log(`cross-tables-api listening on :${PORT}`));
