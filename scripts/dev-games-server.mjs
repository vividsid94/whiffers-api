// A local server for testing the frontend against this repo's code without
// Postgres: the real /games routes and engine on an in-memory database
// (test/fakePool.js) and the real Go move generator (GO_SERVICE_URL), plus
// accounts (auth/) on PGlite - Postgres running inside this process, saved
// to .local/pglite so accounts survive restarts.
//
//   node scripts/dev-games-server.mjs        (listens on :4000)
//   then in the frontend: VITE_GAME_API_URL=http://localhost:4000 npm run dev
//
// Games live only as long as this process. Daily games use a throwaway
// secret. Without RESEND_API_KEY, sign-in links are printed here instead of
// emailed; Google sign-in only works with GOOGLE_CLIENT_ID/SECRET set.

import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { PGliteDialect } from 'kysely-pglite-dialect';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

process.env.DAILY_SECRET ||= 'local-dev-secret-0123456789abcdef';
process.env.BETTER_AUTH_SECRET ||= 'local-dev-auth-secret-0123456789abcdef';
const { createGamesRouter } = await import('../games/routes.js');
const { createFakePool } = await import('../test/fakePool.js');
const { createAuth } = await import('../auth/auth.js');
const { mountAuth, ensureAuthSchema } = await import('../auth/mount.js');

const dataDir = fileURLToPath(new URL('../.local/pglite', import.meta.url));
mkdirSync(dataDir, { recursive: true });
const pglite = new PGlite(dataDir);
export const auth = createAuth({ database: { dialect: new PGliteDialect(pglite), type: 'postgres' } });
await ensureAuthSchema(auth);

const PORT = Number(process.env.PORT) || 4000;
const app = express();
mountAuth(app, auth);
app.use('/games', createGamesRouter(createFakePool()));
app.listen(PORT, () => console.log(`local games + accounts server on :${PORT}`));
