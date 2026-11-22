// Wires accounts into an Express app: Better Auth's own routes under
// /api/auth, plus /me, with CORS that allows signed-in (credentialed)
// requests from the Whiffers sites only. Used by index.js and the local dev
// server (scripts/dev-games-server.mjs).

import cors from 'cors';
import express from 'express';
import { toNodeHandler, fromNodeHeaders } from 'better-auth/node';
import { getMigrations } from 'better-auth/db/migration';
import { isAuthOrigin, CLIENT_IP_HEADER } from './auth.js';
import { readUserData, writeUserData, MAX_DATA_BYTES } from './userData.js';

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

export function mountAuth(app, auth, env = process.env) {
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
  app.use('/me', me);
}
