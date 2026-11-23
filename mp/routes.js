// HTTP API for multiplayer games (MULTIPLAYER_PLAN.md), mounted at /mp.
//
//   POST /mp/invites                 create an invite        { settings, guestName? }
//   GET  /mp/invites/:code           the join page's info (public)
//   POST /mp/invites/:code/join      take the free seat      { guestName? }
//   GET  /mp/games/:id               your seat's view (resume / resync)
//   POST /mp/games/:id/cancel        creator cancels a waiting invite
//   POST /mp/games/:id/play          { tiles, clientMoveId }
//   POST /mp/games/:id/exchange      { tiles: letters, clientMoveId }
//   POST /mp/games/:id/pass          { clientMoveId }
//   POST /mp/games/:id/resign
//   POST /mp/games/:id/rematch       ask for a rematch; both asking starts it
//
// Who you are: the seat token you got when creating/joining (X-Seat-Token
// header), or - for signed-in players - your session, so you can pick a game
// back up on another device. Signed-in players play as their username;
// guests type a name, which can't be someone's username.
//
// Every change is pushed to both players over the socket (hub.js), and the
// server ends a game the moment the player to move runs out of time.

import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { MoveError } from '../games/engine.js';
import { DrawbacksUnavailableError } from '../games/drawbacks.js';
import { getRequestUser, publicUser } from '../auth/mount.js';
import { isAuthOrigin } from '../auth/auth.js';
import {
  GameRuleError, GUEST_NAME_PATTERN, parseSettings, createInvite, joinInvite, cancelInvite, seatFor, applyMove, resign,
  requestRematch, checkTimeout, inviteView, seatView,
} from './game.js';
import { flagTime } from './clock.js';
import { createHub } from './hub.js';
import { saveFinished, GUEST_NAME } from '../games/archive.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE_RE = /^[A-Z0-9]{8}$/;
const MOVE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const MAX_TIMER_MS = 2 ** 31 - 1;

class HttpError extends Error {
  constructor(status, body) { super(body.error); this.status = status; this.body = body; }
}
const bad = (reason) => new HttpError(400, { error: 'invalid_request', reason });

function parseTiles(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 7) throw bad('tiles must be 1-7 tiles');
  return raw.map((t) => {
    if (!t || typeof t !== 'object') throw bad('bad tile');
    const { row, col, letter, isBlank } = t;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 14 || col < 0 || col > 14) throw bad('tile off the board');
    if (typeof letter !== 'string' || !/^[A-Z]$/.test(letter)) throw bad('tile letter must be A-Z');
    return { row, col, letter, isBlank: !!isBlank };
  });
}

function parseLetters(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 7) throw bad('tiles must be 1-7 letters');
  return raw.map((t) => {
    if (typeof t !== 'string' || !/^[A-Z?]$/.test(t)) throw bad('exchange tiles must be A-Z or ?');
    return t;
  });
}

function moveIdOf(body) {
  const id = body?.clientMoveId;
  if (typeof id !== 'string' || !MOVE_ID_RE.test(id)) throw bad('clientMoveId required');
  return id;
}

/**
 * @param {object} opts
 * @param {object} opts.store            mp/store.js store
 * @param {object|null} opts.auth        Better Auth instance, or null (guests only)
 * @param {(origin) => boolean} opts.isAllowedOrigin  which sites may use this API
 * @param {object|null} [opts.archive]  where finished games with a signed-in player are saved (games/archive.js)
 * @param {() => number} [opts.now]
 */
// rateLimits: false turns the per-address limits off (tests that play whole
// games quickly from one address).
export function createMultiplayer({ store, auth, isAllowedOrigin, archive = null, now = Date.now, rateLimits = true }) {
  const router = express.Router();
  const hub = createHub({ store, auth, isAllowedOrigin, now });
  const timers = new Map();

  // One operation per game at a time (moves, timeouts, rematch), so the
  // compare-and-swap save only ever loses to another process, never to us.
  const locks = new Map();
  function locked(gameId, fn) {
    const prev = locks.get(gameId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    locks.set(gameId, tail);
    tail.then(() => { if (locks.get(gameId) === tail) locks.delete(gameId); });
    return run;
  }

  // The server's own timeout: fires when the player to move runs out.
  function schedule(game) {
    clearTimeout(timers.get(game.id));
    timers.delete(game.id);
    if (game.status !== 'active' || !game.clock?.turnStartedAt) return;
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, flagTime(game.clock, game.state.currentPlayer) - now() + 50));
    const timer = setTimeout(() => {
      locked(game.id, async () => {
        const fresh = await store.get(game.id);
        if (!fresh) return;
        const ended = checkTimeout(fresh, now());
        if (!ended) return schedule(fresh);
        await saveAndPush(ended, fresh.version);
      }).catch((err) => console.error(`[mp ${game.id}] timeout check failed:`, err.message));
    }, delay);
    timer.unref?.();
    timers.set(game.id, timer);
  }

  async function saveAndPush(game, expectedVersion) {
    const version = await store.save(game, expectedVersion);
    if (version === null) throw new HttpError(409, { error: 'version_conflict' });
    const saved = { ...game, version };
    schedule(saved);
    hub.broadcast(saved);
    if (saved.status === 'ended') archiveGame(saved);
    return saved;
  }

  // A finished game with at least one signed-in player is saved to each
  // signed-in player's account. Guests are always stored as "Guest", never
  // the name they typed. Saving the same game again (e.g. when a rematch is
  // asked for) is a no-op.
  function archiveGame(game) {
    const seat = (s) => (s ? { userId: s.userId ?? null, name: s.guest ? GUEST_NAME : s.name, guest: !!s.guest, botId: null } : null);
    saveFinished(archive, {
      id: game.id,
      source: 'mp',
      mode: game.settings.mode === 'drawbacks' ? 'drawbacks' : 'classic',
      lexicon: game.settings.lexicon,
      dailyDate: null,
      seats: { 1: seat(game.seats[1]), 2: seat(game.seats[2]) },
      settings: game.settings,
      state: game.state,
      endedAt: now(),
    });
  }

  // Re-arms timeouts after a restart (and ends any game that ran out while
  // the server was down).
  async function resumeTimers() {
    for (const game of await store.listActive()) schedule(game);
  }

  // --- Who's asking --------------------------------------------------------

  async function signedInUser(req) {
    if (!auth) return null;
    try { return await getRequestUser(auth, req); } catch { return null; }
  }

  // The name you'll play under: your username, or a guest name that isn't
  // anyone's username.
  async function playerFor(req) {
    const user = await signedInUser(req);
    if (user) {
      const pub = publicUser(user);
      if (!pub.username) throw new HttpError(409, { error: 'pick_username', reason: 'Pick a username first' });
      return { userId: user.id, name: pub.username, guest: false };
    }
    const name = typeof req.body?.guestName === 'string' ? req.body.guestName.trim().replace(/\s+/g, ' ') : '';
    if (!GUEST_NAME_PATTERN.test(name)) throw bad('Guest names are 1-20 letters, numbers, spaces, - or _');
    if (auth) {
      const ctx = await auth.$context;
      const taken = await ctx.adapter.findOne({ model: 'user', where: [{ field: 'username', value: name.toLowerCase() }] });
      if (taken) throw new HttpError(409, { error: 'name_taken', reason: "That's someone's username - pick another name" });
    }
    return { userId: null, name, guest: true };
  }

  async function loadSeat(req) {
    const { id } = req.params;
    if (!UUID_RE.test(id)) throw new HttpError(404, { error: 'game_not_found' });
    const game = await store.get(id);
    const token = req.get('X-Seat-Token');
    const user = game ? await signedInUser(req) : null;
    const seat = game && seatFor(game, { token: typeof token === 'string' && token.length <= 100 ? token : null, userId: user?.id });
    if (!seat) throw new HttpError(404, { error: 'game_not_found' });
    return { game, seat };
  }

  const view = (game, seat) => ({ ...seatView(game, seat, now()), opponentOnline: hub.isOnline(game.id, seat === 1 ? 2 : 1) });

  // --- Middleware ------------------------------------------------------------

  // Signed-in requests (cookies) only from the Whiffers sites; guest
  // requests from anywhere the games API already allows.
  router.use(cors((req, cb) => {
    const origin = req.get('Origin');
    const creds = isAuthOrigin(origin);
    cb(null, {
      origin: creds || isAllowedOrigin(origin) ? (origin || true) : false,
      credentials: creds,
      allowedHeaders: ['Content-Type', 'X-Seat-Token'],
      methods: ['GET', 'POST'],
    });
  }));
  router.use(express.json({ limit: '16kb' }));
  const limiter = (windowMs, limit) => (rateLimits ? rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false }) : (req, res, next) => next());
  const createLimiter = limiter(60 * 60 * 1000, 30);
  const joinLimiter = limiter(60 * 60 * 1000, 60);
  const moveLimiter = limiter(60 * 1000, 120);

  // --- Invites ----------------------------------------------------------------

  router.post('/invites', createLimiter, async (req, res, next) => {
    try {
      const settings = parseSettings(req.body?.settings);
      const creator = await playerFor(req);
      let created;
      for (let attempt = 0; ; attempt++) {
        created = createInvite({ settings, creator, now: now() });
        try { await store.insert(created.game); break; } catch (err) {
          if (err.code !== '23505' || attempt >= 4) throw err; // retry an (astronomically rare) code clash
        }
      }
      res.status(201).json({ gameId: created.game.id, code: created.game.code, token: created.token, game: view(created.game, 1) });
    } catch (err) { next(err); }
  });

  router.get('/invites/:code', joinLimiter, async (req, res, next) => {
    try {
      const code = String(req.params.code).toUpperCase();
      const game = CODE_RE.test(code) ? await store.getByCode(code) : null;
      if (!game) throw new HttpError(404, { error: 'invite_not_found' });
      res.json({ invite: inviteView(game, now()) });
    } catch (err) { next(err); }
  });

  router.post('/invites/:code/join', joinLimiter, async (req, res, next) => {
    try {
      const code = String(req.params.code).toUpperCase();
      const found = CODE_RE.test(code) ? await store.getByCode(code) : null;
      if (!found) throw new HttpError(404, { error: 'invite_not_found' });
      const token = req.get('X-Seat-Token');
      if (token && seatFor(found, { token }) === 1) throw new HttpError(409, { error: 'own_invite', reason: "You can't join your own invite" });
      const joiner = await playerFor(req);
      const result = await locked(found.id, async () => {
        const game = await store.get(found.id);
        const joined = await joinInvite(game, joiner, now());
        const saved = await saveAndPush(joined.game, game.version);
        return { saved, token: joined.token };
      });
      res.json({ gameId: result.saved.id, token: result.token, game: view(result.saved, 2) });
    } catch (err) { next(err); }
  });

  // --- Games --------------------------------------------------------------------

  router.get('/games/:id', moveLimiter, async (req, res, next) => {
    try {
      const { game: found, seat } = await loadSeat(req);
      // A clock that ran out without the timer firing (e.g. across a
      // restart) ends the game here too.
      const game = checkTimeout(found, now())
        ? await locked(found.id, async () => {
          const fresh = await store.get(found.id);
          const ended = checkTimeout(fresh, now());
          return ended ? saveAndPush(ended, fresh.version) : fresh;
        })
        : found;
      res.json({ game: view(game, seat) });
    } catch (err) { next(err); }
  });

  router.post('/games/:id/cancel', moveLimiter, async (req, res, next) => {
    try {
      const { game: found, seat } = await loadSeat(req);
      const saved = await locked(found.id, async () => {
        const game = await store.get(found.id);
        return saveAndPush(cancelInvite(game, seat), game.version);
      });
      res.json({ game: view(saved, seat) });
    } catch (err) { next(err); }
  });

  // play / exchange / pass: one move by your seat. A retry of a move that
  // already landed (same clientMoveId) just gets the current game back.
  function moveRoute(kind, parse) {
    return async (req, res, next) => {
      try {
        const payload = parse(req.body);
        const clientMoveId = moveIdOf(req.body);
        const { game: found, seat } = await loadSeat(req);
        const saved = await locked(found.id, async () => {
          const game = await store.get(found.id);
          if (game.lastMoves?.[seat] === clientMoveId) return game;
          let result;
          try {
            result = await applyMove(game, seat, kind, payload, now());
          } catch (err) {
            if (err instanceof MoveError) {
              if (err.code === 'invalid_move') {
                throw new HttpError(422, { error: 'invalid_move', reason: err.reason, invalidWords: err.invalidWords ?? [], invalidWordCoords: err.invalidWordCoords ?? [] });
              }
              throw new HttpError(409, { error: err.code, game: view(game, seat) });
            }
            if (err instanceof DrawbacksUnavailableError) {
              console.error(`[mp ${game.id}] drawbacks unavailable -`, err.message);
              throw new HttpError(503, { error: 'drawbacks_unavailable', game: view(game, seat) });
            }
            throw err;
          }
          const next = result.timedOut ? result.game : { ...result.game, lastMoves: { ...game.lastMoves, [seat]: clientMoveId } };
          const pushed = await saveAndPush(next, game.version);
          if (result.timedOut) throw new HttpError(410, { error: 'out_of_time', game: view(pushed, seat) });
          return pushed;
        });
        res.json({ game: view(saved, seat) });
      } catch (err) { next(err); }
    };
  }

  router.post('/games/:id/play', moveLimiter, moveRoute('play', (b) => parseTiles(b?.tiles)));
  router.post('/games/:id/exchange', moveLimiter, moveRoute('exchange', (b) => parseLetters(b?.tiles)));
  router.post('/games/:id/pass', moveLimiter, moveRoute('pass', () => null));

  router.post('/games/:id/resign', moveLimiter, async (req, res, next) => {
    try {
      const { game: found, seat } = await loadSeat(req);
      const saved = await locked(found.id, async () => {
        const game = await store.get(found.id);
        return saveAndPush(resign(game, seat, now()), game.version);
      });
      res.json({ game: view(saved, seat) });
    } catch (err) { next(err); }
  });

  router.post('/games/:id/rematch', moveLimiter, async (req, res, next) => {
    try {
      const { game: found, seat } = await loadSeat(req);
      const result = await locked(found.id, async () => {
        const game = await store.get(found.id);
        const { game: updated, rematch, existingId } = await requestRematch(game, seat, now());
        if (existingId) return { saved: game, rematchId: existingId };
        if (rematch) {
          await store.insert(rematch);
          schedule({ ...rematch, version: 0 });
        }
        const saved = await saveAndPush(updated, game.version);
        return { saved, rematchId: rematch?.id ?? null };
      });
      res.json({ game: view(result.saved, seat), rematchGameId: result.rematchId });
    } catch (err) { next(err); }
  });

  // Errors: known ones carry their own status/body; anything else is logged
  // with a request id - no internals leak.
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    if (err instanceof GameRuleError) return res.status(err.status).json({ error: err.code, reason: err.reason });
    if (err.type === 'entity.too.large' || err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_request' });
    const requestId = crypto.randomUUID();
    console.error(`[mp ${requestId}]`, err);
    res.status(500).json({ error: 'internal_error', requestId });
  });

  function close() {
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    hub.close();
  }

  return { router, attachSockets: hub.attach, resumeTimers, close, hub };
}
