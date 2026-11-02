// HTTP API for server-run games (Classic + Daily). Mounted at /games by
// index.js. Ownership is a secret token handed out at creation - no
// accounts: whoever holds it can move in that game, nobody else can (a
// wrong token looks exactly like a missing game). Only a sha256 of the
// token is stored.
//
//   POST /games                     create; bot may owe the first move (botPending)
//   GET  /games/:id                 current snapshot (resume / resync)
//   POST /games/:id/play            human word play, then the bot replies
//   POST /games/:id/exchange        human exchange, then the bot replies
//   POST /games/:id/pass            human pass, then the bot replies
//   POST /games/:id/resign          human resigns
//   POST /games/:id/bot-turn        run a pending bot turn (bot first, or Go was down)
//
// A move response is { human, afterHuman, bot, state }: afterHuman is the
// snapshot right after the human's move, so the client can show it before
// staging the bot's reply; bot is null (game ended), { status: 'done', ... }
// or { status: 'pending' } (Go unreachable - retry with /bot-turn; never a pass).

import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import {
  createState, applyHumanPlay, applyExchange, applyPass, applyResign,
  assertTileConservation, MoveError,
} from './engine.js';
import { toClientSnapshot } from './view.js';
import { runBotTurn, summarizeBotMove, BotUnavailableError } from './bot.js';
import { classicDeal, dailyDeal, isDailyAvailable, isPlayableDailyDate } from './daily.js';
import { isValidWord, SUPPORTED_GAME_LEXICONS } from './dictionary.js';
import { insertGame, loadGame, saveGame, cacheResponse } from './repo.js';
import { OPPONENTS, DEFAULT_OPPONENT_ID } from '../rules/opponents.js';

const MODES = ['classic', 'daily'];
const OPPONENT_IDS = OPPONENTS.map(o => o.id);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MOVE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// The live site, Railway-hosted builds (staging) and local dev by default;
// ALLOWED_ORIGINS (comma-separated) adds more. CORS isn't the lock - the
// token is - it just keeps other sites from driving games in a visitor's tab.
const extraOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin, curl, server-to-server
  if (extraOrigins.includes(origin)) return true;
  return /^https:\/\/(www\.)?(whiffers230|tileturnover)\.com$/.test(origin)
    || /^https:\/\/[a-z0-9-]+\.up\.railway\.app$/.test(origin)
    || /^http:\/\/localhost:\d+$/.test(origin);
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest();

class HttpError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

function bad(reason) {
  return new HttpError(400, { error: 'invalid_request', reason });
}

function parseTiles(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 7) throw bad('tiles must be 1-7 tiles');
  return raw.map((t) => {
    if (!t || typeof t !== 'object') throw bad('bad tile');
    const { row, col, letter, isBlank } = t;
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row > 14 || col < 0 || col > 14) throw bad('tile off the board');
    if (typeof letter !== 'string' || !/^[A-Z]$/.test(letter)) throw bad('tile letter must be A-Z');
    if (isBlank !== undefined && typeof isBlank !== 'boolean') throw bad('isBlank must be true/false');
    return { row, col, letter, isBlank: !!isBlank };
  });
}

function parseExchangeLetters(raw) {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 7) throw bad('tiles must be 1-7 letters');
  return raw.map((t) => {
    if (typeof t !== 'string' || !/^[A-Z?]$/.test(t)) throw bad('exchange tiles must be A-Z or ?');
    return t;
  });
}

function parseMoveMeta(body) {
  const { clientMoveId, expectedVersion } = body ?? {};
  if (typeof clientMoveId !== 'string' || !MOVE_ID_RE.test(clientMoveId)) throw bad('clientMoveId required');
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) throw bad('expectedVersion required');
  return { clientMoveId, expectedVersion };
}

// Loads the game and checks the token in constant time. Missing game and
// wrong token are deliberately the same 404.
async function loadOwnedGame(pool, req) {
  const { id } = req.params;
  const token = req.get('X-Game-Token');
  if (!UUID_RE.test(id) || typeof token !== 'string' || token.length < 20 || token.length > 100) {
    throw new HttpError(404, { error: 'game_not_found' });
  }
  const row = await loadGame(pool, id);
  const given = hashToken(token);
  if (!row || row.token_hash.length !== given.length || !crypto.timingSafeEqual(row.token_hash, given)) {
    throw new HttpError(404, { error: 'game_not_found' });
  }
  return row;
}

function moveErrorToHttp(err, snapshot) {
  if (err.code === 'invalid_move') {
    return new HttpError(422, {
      error: 'invalid_move',
      reason: err.reason,
      invalidWords: err.invalidWords ?? [],
      invalidWordCoords: err.invalidWordCoords ?? [],
    });
  }
  if (err.code === 'game_over') return new HttpError(410, { error: 'game_over', state: snapshot });
  return new HttpError(409, { error: err.code, state: snapshot });
}

function humanSummary(state) {
  const entry = [...state.history].reverse().find(h => h.player === 1);
  return {
    type: entry.type,
    words: entry.words,
    score: entry.score,
    total: entry.total,
    placed: entry.placed,
    isBingo: !!entry.isBingo,
  };
}

export function createGamesRouter(pool) {
  const router = express.Router();

  router.use(cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    allowedHeaders: ['Content-Type', 'X-Game-Token'],
    methods: ['GET', 'POST'],
  }));
  router.use(express.json({ limit: '16kb' }));

  const createLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
  const moveLimiter = rateLimit({ windowMs: 60 * 1000, limit: 90, standardHeaders: 'draft-7', legacyHeaders: false });

  router.post('/', createLimiter, async (req, res, next) => {
    try {
      const { mode, lexicon = 'NWL23', opponentId = DEFAULT_OPPONENT_ID, dailyDate } = req.body ?? {};
      if (!MODES.includes(mode)) throw bad('mode must be classic or daily');
      if (!SUPPORTED_GAME_LEXICONS.includes(lexicon)) throw bad('unsupported lexicon');
      if (!OPPONENT_IDS.includes(opponentId)) throw bad('unknown opponent');

      let deal;
      let date = null;
      let opponent = opponentId;
      if (mode === 'daily') {
        if (!isDailyAvailable()) throw new HttpError(503, { error: 'daily_unavailable' });
        if (!isPlayableDailyDate(dailyDate)) throw bad('dailyDate must be a real day, not in the future');
        date = dailyDate;
        opponent = DEFAULT_OPPONENT_ID; // the Daily is always full-strength Wally
        deal = dailyDeal(date);
      } else {
        deal = classicDeal();
      }

      const state = createState({ mode, lexicon, opponentId: opponent, dailyDate: date, ...deal });
      assertTileConservation(state);
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString('base64url');
      await insertGame(pool, { id, tokenHash: hashToken(token), mode, lexicon, opponentId: opponent, dailyDate: date, state });
      res.status(201).json({ gameId: id, token, state: toClientSnapshot(id, 0, state) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', moveLimiter, async (req, res, next) => {
    try {
      const row = await loadOwnedGame(pool, req);
      res.json({ state: toClientSnapshot(row.id, row.version, row.state) });
    } catch (err) {
      next(err);
    }
  });

  // Shared body of play / exchange / pass: apply the human move, let the
  // bot reply (if Go answers in time), save once, answer.
  async function humanMove(req, res, applyHuman) {
    const meta = parseMoveMeta(req.body);
    const row = await loadOwnedGame(pool, req);

    // A retry of a move that already landed (response lost on the way back):
    // answer with what was sent, refreshed to the current state.
    if (row.last_client_move_id === meta.clientMoveId && row.last_response) {
      return res.json({ ...row.last_response, state: toClientSnapshot(row.id, row.version, row.state) });
    }
    const current = toClientSnapshot(row.id, row.version, row.state);
    if (meta.expectedVersion !== row.version) {
      throw new HttpError(409, { error: 'version_conflict', state: current });
    }

    let afterHuman;
    try {
      afterHuman = applyHuman(row.state);
    } catch (err) {
      if (err instanceof MoveError) throw moveErrorToHttp(err, current);
      throw err;
    }
    assertTileConservation(afterHuman);

    let final = afterHuman;
    let bot = null;
    if (!afterHuman.ended && afterHuman.currentPlayer === 2) {
      try {
        final = (await runBotTurn(afterHuman)).state;
        assertTileConservation(final);
        bot = summarizeBotMove(afterHuman, final);
      } catch (err) {
        if (!(err instanceof BotUnavailableError)) throw err;
        console.error(`Game ${row.id}: bot pending -`, err.message);
        final = afterHuman;
        bot = { status: 'pending' };
      }
    }

    const newVersion = await saveGame(pool, row.id, row.version, final);
    if (newVersion === null) {
      const fresh = await loadGame(pool, row.id);
      throw new HttpError(409, { error: 'version_conflict', state: toClientSnapshot(fresh.id, fresh.version, fresh.state) });
    }
    // afterHuman's version is the one just saved when the bot didn't move,
    // otherwise the client only needs it to draw the in-between board.
    const body = {
      human: humanSummary(afterHuman),
      afterHuman: toClientSnapshot(row.id, newVersion, afterHuman),
      bot,
      state: toClientSnapshot(row.id, newVersion, final),
    };
    await cacheResponse(pool, row.id, newVersion, meta.clientMoveId, body);
    res.json(body);
  }

  router.post('/:id/play', moveLimiter, async (req, res, next) => {
    try {
      const tiles = parseTiles(req.body?.tiles);
      await humanMove(req, res, (state) => applyHumanPlay(state, tiles, (w) => isValidWord(state.lexicon, w)));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/exchange', moveLimiter, async (req, res, next) => {
    try {
      const letters = parseExchangeLetters(req.body?.tiles);
      await humanMove(req, res, (state) => applyExchange(state, 1, letters));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/pass', moveLimiter, async (req, res, next) => {
    try {
      await humanMove(req, res, (state) => applyPass(state, 1));
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/resign', moveLimiter, async (req, res, next) => {
    try {
      const row = await loadOwnedGame(pool, req);
      let ended;
      try {
        ended = applyResign(row.state);
      } catch (err) {
        if (err instanceof MoveError) throw moveErrorToHttp(err, toClientSnapshot(row.id, row.version, row.state));
        throw err;
      }
      const newVersion = await saveGame(pool, row.id, row.version, ended);
      if (newVersion === null) throw new HttpError(409, { error: 'version_conflict' });
      res.json({ state: toClientSnapshot(row.id, newVersion, ended) });
    } catch (err) {
      next(err);
    }
  });

  // The bot's turn on its own: its opening move when it won the coin toss,
  // or a retry after Go was unreachable. 409 if it isn't the bot's turn.
  router.post('/:id/bot-turn', moveLimiter, async (req, res, next) => {
    try {
      const row = await loadOwnedGame(pool, req);
      const current = toClientSnapshot(row.id, row.version, row.state);
      if (row.state.ended) throw new HttpError(410, { error: 'game_over', state: current });
      if (row.state.currentPlayer !== 2) throw new HttpError(409, { error: 'not_bots_turn', state: current });

      let final;
      try {
        final = (await runBotTurn(row.state)).state;
      } catch (err) {
        if (err instanceof BotUnavailableError) {
          console.error(`Game ${row.id}: bot pending -`, err.message);
          throw new HttpError(503, { error: 'bot_unavailable', state: current });
        }
        throw err;
      }
      assertTileConservation(final);
      const newVersion = await saveGame(pool, row.id, row.version, final);
      if (newVersion === null) {
        const fresh = await loadGame(pool, row.id);
        throw new HttpError(409, { error: 'version_conflict', state: toClientSnapshot(fresh.id, fresh.version, fresh.state) });
      }
      res.json({ bot: summarizeBotMove(row.state, final), state: toClientSnapshot(row.id, newVersion, final) });
    } catch (err) {
      next(err);
    }
  });

  // Errors: known ones carry their own status/body; anything else is logged
  // here and answered with a request id only - no internals leak.
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof HttpError) return res.status(err.status).json(err.body);
    if (err.type === 'entity.too.large' || err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const requestId = crypto.randomUUID();
    console.error(`[games ${requestId}]`, err);
    res.status(500).json({ error: 'internal_error', requestId });
  });

  return router;
}
