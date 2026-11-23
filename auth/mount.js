// Wires accounts into an Express app: Better Auth's own routes under
// /api/auth, plus /me, with CORS that allows signed-in (credentialed)
// requests from the Whiffers sites only. Used by index.js and the local dev
// server (scripts/dev-games-server.mjs).

import cors from 'cors';
import express from 'express';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import { isAuthOrigin, CLIENT_IP_HEADER, USERNAME_PATTERN } from './auth.js';
import { readUserData, writeUserData, MAX_DATA_BYTES } from './userData.js';
import { summaryFor, detailFor } from '../games/archive.js';
import { profileStats } from '../games/profile.js';

// Paths that need credentialed CORS instead of the app's open CORS.
export const isAuthPath = (path) => path.startsWith('/api/auth') || path === '/me' || path.startsWith('/me/');

export function authCors(env = process.env) {
  return cors({ origin: (origin, cb) => cb(null, !origin || isAuthOrigin(origin, env)), credentials: true });
}

// Creates or updates Better Auth's tables (user, session, account,
// verification). Idempotent, so it runs on every boot like ensureSchema.
export async function ensureAuthSchema(auth) {
  const { runMigrations, toBeCreated, toBeAdded } = await getMigrations(auth.options);
  if (toBeCreated.length || toBeAdded.length) {
    console.log(`[auth] migrating: ${toBeCreated.map((t) => t.table).join(', ') || 'no new tables'}${toBeAdded.length ? ` (+ columns on ${toBeAdded.map((t) => t.table).join(', ')})` : ''}`);
  }
  await runMigrations();
}

// The signed-in user for a request, or null.
export async function getRequestUser(auth, req) {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  return session?.user ?? null;
}

// Middleware: req.user is the signed-in user or null...
export const optionalUser = (auth) => async (req, _res, next) => {
  try { req.user = await getRequestUser(auth, req); } catch { req.user = null; }
  next();
};

// ...or a 401 when nobody's signed in.
export const requireUser = (auth) => async (req, res, next) => {
  try { req.user = await getRequestUser(auth, req); } catch { req.user = null; }
  if (!req.user) return res.status(401).json({ error: 'Sign in required' });
  next();
};

// What the frontend gets to know about you.
export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    // The as-typed casing (displayUsername) only when it's the same name as
    // the unique, lowercased username - so nobody can show up as "Wally"
    // while owning a different username.
    username: user.username
      ? (user.displayUsername?.toLowerCase() === user.username ? user.displayUsername : user.username)
      : null,
    role: user.role || 'player',
    needsUsername: !user.username,
  };
}

// Saved games remember a signed-in opponent by account id. Before anything
// goes out, every opponent ({ kind, userId }) anywhere in `value` gets their
// username as it is today - `name` to show, `username` for the link to their
// profile - and loses the id. Someone whose account is gone keeps the name
// saved with the game, with no link. Changes `value` in place.
export async function withCurrentNames(auth, value) {
  const nodes = [];
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (!v || typeof v !== 'object') return;
    if ('userId' in v && 'kind' in v) nodes.push(v);
    Object.values(v).forEach(walk);
  };
  walk(value);
  const ids = [...new Set(nodes.map((n) => n.userId).filter(Boolean))];
  const found = new Map();
  if (ids.length) {
    const ctx = await auth.$context;
    await Promise.all(ids.map(async (id) => {
      const user = await ctx.adapter.findOne({ model: 'user', where: [{ field: 'id', value: id }] });
      if (user?.username) found.set(id, publicUser(user).username);
    }));
  }
  for (const n of nodes) {
    const current = n.userId ? found.get(n.userId) : null;
    if (current) n.name = current;
    if (n.kind === 'player') n.username = current ? current.toLowerCase() : null;
    delete n.userId;
  }
  return value;
}

// opts.archive: saved games (games/archive.js) for /me/games.
export function mountAuth(app, auth, env = process.env, { archive = null } = {}) {
  const corsMiddleware = authCors(env);
  // Better Auth reads the request body itself, so its routes go in before
  // any express.json(). Its rate limits need the visitor's IP: hand it
  // Express's req.ip (which honours 'trust proxy') in our own header,
  // overwriting anything a client sent, rather than trusting a raw
  // X-Forwarded-For that anyone can fake.
  const withClientIp = (req, _res, next) => { req.headers[CLIENT_IP_HEADER] = req.ip || ''; next(); };
  app.all('/api/auth/*splat', corsMiddleware, withClientIp, toNodeHandler(auth));

  const me = express.Router();
  me.use(corsMiddleware);
  me.get('/', optionalUser(auth), (req, res) => res.json({ user: publicUser(req.user) }));

  // Saved progress (userData.js). PUT merges with what's stored, so two
  // devices can't wipe each other's progress; both return the result.
  me.get('/data', requireUser(auth), async (req, res) => {
    try { res.json(await readUserData(auth, req.user.id)); } catch (err) {
      console.error('GET /me/data failed:', err.message);
      res.status(500).json({ error: 'Could not load saved progress' });
    }
  });
  me.put('/data', requireUser(auth), express.json({ limit: MAX_DATA_BYTES }), async (req, res) => {
    try { res.json(await writeUserData(auth, req.user.id, req.body?.data)); } catch (err) {
      console.error('PUT /me/data failed:', err.message);
      res.status(500).json({ error: 'Could not save progress' });
    }
  });
  // Your finished games (saved whenever you were signed in), newest first,
  // from your side. ?before=<endedAt> pages back; ?limit= up to 50.
  me.get('/games', requireUser(auth), async (req, res) => {
    if (!archive) return res.json({ games: [], next: null });
    try {
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const before = req.query.before != null && /^\d+$/.test(String(req.query.before)) ? Number(req.query.before) : null;
      const records = await archive.listForUser(req.user.id, { limit, before });
      const games = records.map((r) => summaryFor(r, req.user.id));
      res.json({ games: await withCurrentNames(auth, games), next: games.length === limit ? games[games.length - 1].endedAt : null });
    } catch (err) {
      console.error('GET /me/games failed:', err.message);
      res.status(500).json({ error: 'Could not load your games' });
    }
  });
  // One game in full, for replay.
  me.get('/games/:id', requireUser(auth), async (req, res) => {
    if (!archive || !/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'game_not_found' });
    try {
      const record = await archive.getForUser(req.user.id, req.params.id);
      if (!record) return res.status(404).json({ error: 'game_not_found' });
      res.json({ game: await withCurrentNames(auth, detailFor(record, req.user.id)) });
    } catch (err) {
      console.error('GET /me/games/:id failed:', err.message);
      res.status(500).json({ error: 'Could not load that game' });
    }
  });
  app.use('/me', me);

  // Public profiles: anyone (signed in or not) can see a player's stats and
  // finished games at /profiles/<username>. Only the username and join date
  // are shown about the person - never their email or Google name. Open
  // CORS: nothing here depends on who's asking.
  const profiles = express.Router();
  profiles.use(cors());
  profiles.param('username', async (req, res, next, name) => {
    if (!USERNAME_PATTERN.test(name)) return res.status(404).json({ error: 'player_not_found' });
    try {
      const ctx = await auth.$context;
      const user = await ctx.adapter.findOne({ model: 'user', where: [{ field: 'username', value: name.toLowerCase() }] });
      if (!user) return res.status(404).json({ error: 'player_not_found' });
      req.profileUser = user;
      next();
    } catch (err) {
      console.error('profile lookup failed:', err.message);
      res.status(500).json({ error: 'Could not load that profile' });
    }
  });
  profiles.get('/:username', async (req, res) => {
    try {
      const user = req.profileUser;
      const lines = archive ? await archive.linesForUser(user.id) : [];
      const joined = user.createdAt ? new Date(user.createdAt).getTime() : null;
      res.json({ profile: { username: publicUser(user).username, joinedAt: joined }, stats: await withCurrentNames(auth, profileStats(lines)) });
    } catch (err) {
      console.error('GET /profiles/:username failed:', err.message);
      res.status(500).json({ error: 'Could not load that profile' });
    }
  });
  // Their games, newest first, from their side. Same paging as /me/games.
  profiles.get('/:username/games', async (req, res) => {
    if (!archive) return res.json({ games: [], next: null });
    try {
      const id = req.profileUser.id;
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const before = req.query.before != null && /^\d+$/.test(String(req.query.before)) ? Number(req.query.before) : null;
      const games = (await archive.listForUser(id, { limit, before })).map((r) => summaryFor(r, id));
      res.json({ games: await withCurrentNames(auth, games), next: games.length === limit ? games[games.length - 1].endedAt : null });
    } catch (err) {
      console.error('GET /profiles/:username/games failed:', err.message);
      res.status(500).json({ error: 'Could not load those games' });
    }
  });
  // One game in full, for replay. The game is over, so everything (both
  // racks, any drawbacks) is shown, as on the game-over screen.
  profiles.get('/:username/games/:id', async (req, res) => {
    if (!archive || !/^[0-9a-f-]{36}$/.test(req.params.id)) return res.status(404).json({ error: 'game_not_found' });
    try {
      const record = await archive.getForUser(req.profileUser.id, req.params.id);
      if (!record) return res.status(404).json({ error: 'game_not_found' });
      res.json({ game: await withCurrentNames(auth, detailFor(record, req.profileUser.id)) });
    } catch (err) {
      console.error('GET /profiles/:username/games/:id failed:', err.message);
      res.status(500).json({ error: 'Could not load that game' });
    }
  });
  app.use('/profiles', profiles);
}
