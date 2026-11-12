// A local /games server for testing the frontend against this repo's code
// without Postgres: the real routes and engine, an in-memory database
// (test/fakePool.js), and the real Go move generator (GO_SERVICE_URL).
//
//   node scripts/dev-games-server.mjs        (listens on :4000)
//   then in the frontend: VITE_GAME_API_URL=http://localhost:4000 npm run dev
//
// Games live only as long as this process. Daily games use a throwaway secret.

import express from 'express';

process.env.DAILY_SECRET ||= 'local-dev-secret-0123456789abcdef';
const { createGamesRouter } = await import('../games/routes.js');
const { createFakePool } = await import('../test/fakePool.js');

const PORT = Number(process.env.PORT) || 4000;
const app = express();
app.use('/games', createGamesRouter(createFakePool()));
app.listen(PORT, () => console.log(`local games server on :${PORT}`));
