// Drawbacks mode end to end: the real HTTP routes, an in-memory database
// (fakePool.js) and the REAL Go move generator, which judges the drawbacks
// (network needed - skipped with SKIP_GO_TESTS=1).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'crypto';

process.env.DAILY_SECRET = 'test-secret-0123456789abcdef';
const { createGamesRouter } = await import('../games/routes.js');
const { createFakePool } = await import('./fakePool.js');
const { buildBoardForRequest, GO_SERVICE_URL } = await import('../rules/boardRequest.js');

const skipGo = process.env.SKIP_GO_TESTS === '1';

async function startServer() {
  const pool = createFakePool();
  const app = express();
  app.use('/games', createGamesRouter(pool));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  return { pool, server, base: `http://127.0.0.1:${server.address().port}/games` };
}

async function call(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Game-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

async function move(base, game, snap, path, body = {}) {
  return call(base, 'POST', `/${game.gameId}/${path}`, {
    token: game.token, body: { ...body, clientMoveId: crypto.randomUUID(), expectedVersion: snap.version },
  });
}

async function bestMove(snap) {
  const res = await fetch(`${GO_SERVICE_URL}/generate-moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ board: buildBoardForRequest(snap.board, snap.blankTiles), rack: snap.myRack.join(''), topN: 1, poolSize: snap.bagCount, lexicon: snap.lexicon }),
  });
  const data = await res.json();
  return (data.moves || []).find(m => !m.isExchange && m.tiles?.length > 0) ?? null;
}

// A new Drawbacks game where the human moves first (the coin toss is random).
async function humanFirstGame(base, drawbackIds) {
  for (let i = 0; i < 20; i++) {
    const created = await call(base, 'POST', '', { body: { mode: 'drawbacks', drawbackIds } });
    assert.equal(created.status, 201);
    if (created.body.state.currentPlayer === 1) return created.body;
  }
  throw new Error('never got the first move');
}

const placedOf = (m) => m.tiles.filter(t => t.isNew).map(t => ({ row: t.row, col: t.col, letter: t.letter.toUpperCase(), isBlank: !!t.isBlank }));

test('drawbacks: you see your own drawback, not Wally\'s (until peek)', { skip: skipGo }, async () => {
  const { base, server } = await startServer();
  try {
    const game = await humanFirstGame(base, { player: 1, wally: 31 });
    assert.equal(game.state.drawbacks.mine, 1);
    assert.equal(game.state.drawbacks.wally, null);
    assert.ok(game.state.drawbacks.turnInfo, 'turn info for the human\'s first turn');
    const peeked = await call(base, 'GET', `/${game.gameId}?peek=1`, { token: game.token });
    assert.equal(peeked.body.state.drawbacks.wally, 31);
  } finally {
    server.close();
  }
});

test('drawbacks: Fear of Heights refuses a vertical opener, takes the horizontal one', { skip: skipGo }, async () => {
  const { base, server } = await startServer();
  try {
    // A deal whose rack has an opening play of 2+ tiles (some racks have none).
    let game;
    let across = [];
    for (let i = 0; i < 10 && across.length < 2; i++) {
      game = await humanFirstGame(base, { player: 1, wally: 15 });
      const best = await bestMove(game.state);
      across = best ? placedOf(best) : [];
    }
    if (across.length < 2) return;
    const down = across.map(t => ({ ...t, row: t.col, col: t.row }));
    const refused = await move(base, game, game.state, 'play', { tiles: down });
    assert.equal(refused.status, 422);
    assert.match(refused.body.reason, /Fear of Heights/);
    const ok = await move(base, game, game.state, 'play', { tiles: across });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.afterHuman.history[0].words[0].length, across.length);
  } finally {
    server.close();
  }
});

test('drawbacks: Oddball vs Oddball - Wally steps in after six scoreless turns', { skip: skipGo }, async () => {
  const { base, server } = await startServer();
  try {
    const game = await humanFirstGame(base, { player: 31, wally: 31 });
    let snap = game.state;
    for (let i = 0; i < 6 && !snap.history.some(h => h.stepIn); i++) {
      const res = await move(base, game, snap, 'pass');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      snap = res.body.state;
    }
    const stepIn = snap.history.find(h => h.stepIn);
    assert.ok(stepIn, 'Wally stepped in');
    assert.equal(stepIn.score, 0);
    assert.equal(snap.ended, false);
    assert.ok(snap.board.some(row => row.some(c => typeof c === 'string')));
  } finally {
    server.close();
  }
});

test('drawbacks: a whole game plays through (human plays its best move, or passes when refused)', { skip: skipGo }, async () => {
  const { base, server } = await startServer();
  try {
    const created = await call(base, 'POST', '', { body: { mode: 'drawbacks', drawbackIds: { player: 3, wally: 25 } } });
    const game = created.body;
    let snap = game.state;
    if (snap.botPending) {
      const res = await call(base, 'POST', `/${game.gameId}/bot-turn`, { token: game.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      snap = res.body.state;
    }
    for (let i = 0; i < 80 && !snap.ended; i++) {
      const best = await bestMove(snap);
      let res = best ? await move(base, game, snap, 'play', { tiles: placedOf(best) }) : null;
      if (!res || res.status === 422) res = await move(base, game, snap, 'pass');
      assert.equal(res.status, 200, JSON.stringify(res.body));
      snap = res.body.state;
    }
    assert.ok(snap.ended, 'game finished');
    assert.ok(snap.final);
  } finally {
    server.close();
  }
});

test('deferBot: the human move comes back before Wally moves, then /bot-turn plays him', { skip: skipGo }, async () => {
  const { base, server } = await startServer();
  try {
    let game;
    for (let i = 0; i < 20 && !game; i++) {
      const created = await call(base, 'POST', '', { body: { mode: 'classic', opponentId: 'wally' } });
      if (created.body.state.currentPlayer === 1) game = created.body;
    }
    const res = await move(base, game, game.state, 'pass', { deferBot: true });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.bot.status, 'deferred');
    assert.equal(res.body.state.currentPlayer, 2);
    assert.equal(res.body.state.botPending, true);
    const bot = await call(base, 'POST', `/${game.gameId}/bot-turn`, { token: game.token });
    assert.equal(bot.status, 200, JSON.stringify(bot.body));
    assert.equal(bot.body.state.history.length, 2);
  } finally {
    server.close();
  }
});

test('drawbacks: Short-handed racks hold 6 (deal and refill); Restlessness shows each tile\'s count', { skip: skipGo }, async () => {
  const { base, server } = await startServer();
  try {
    const game = await humanFirstGame(base, { player: 41, wally: 60 });
    assert.equal(game.state.myRack.length, 6);
    const best = await bestMove(game.state);
    if (best) {
      const ok = await move(base, game, game.state, 'play', { tiles: placedOf(best) });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.afterHuman.myRack.length, 6);
    }
    const restless = await humanFirstGame(base, { player: 60, wally: 41 });
    const timers = restless.state.drawbacks.turnInfo.timers;
    assert.equal(timers.length, 7);
    assert.ok(timers.every(t => t.timer === 2), JSON.stringify(timers));
  } finally {
    server.close();
  }
});
