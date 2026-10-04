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
      `SELECT playerid, name, currrating, twlrating, cswrating, photourl, location
       FROM players WHERE twlrating IS NOT NULL OR cswrating IS NOT NULL
       ORDER BY twlrating DESC NULLS LAST LIMIT $1`,
      [limit]
    );
    res.json({ results: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
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
