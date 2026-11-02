// End-to-end through the real HTTP routes, with an in-memory database
// (fakePool.js) and the REAL Go move generator (network needed - skipped
// with SKIP_GO_TESTS=1). The human side plays Go's own top move each turn,
// so a whole game runs to the end.
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
  const base = `http://127.0.0.1:${server.address().port}/games`;
  return { pool, server, base };
}

async function call(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Game-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const moveId = () => crypto.randomUUID();

// What the human plays: Go's best move for the human's own rack.
async function bestHumanMove(snap) {
  const res = await fetch(`${GO_SERVICE_URL}/generate-moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      board: buildBoardForRequest(snap.board, snap.blankTiles),
      rack: snap.myRack.join(''), topN: 1, poolSize: snap.bagCount, lexicon: snap.lexicon,
    }),
  });
  const data = await res.json();
  return (data.moves || []).find(m => m.isExchange || m.tiles?.length > 0) ?? null;
}

test('auth: wrong token and unknown game look the same', async () => {
  const { base, server } = await startServer();
  try {
    const created = await call(base, 'POST', '', { body: { mode: 'classic', opponentId: 'wally' } });
    assert.equal(created.status, 201);
    const wrong = await call(base, 'GET', `/${created.body.gameId}`, { token: 'x'.repeat(43) });
    const missing = await call(base, 'GET', `/${crypto.randomUUID()}`, { token: created.body.token });
    assert.equal(wrong.status, 404);
    assert.deepEqual(wrong.body, missing.body);
  } finally {
    server.close();
  }
});

test('validation: bad mode, bad tiles, future daily', async () => {
  const { base, server } = await startServer();
  try {
    assert.equal((await call(base, 'POST', '', { body: { mode: 'chess' } })).status, 400);
    assert.equal((await call(base, 'POST', '', { body: { mode: 'daily', dailyDate: '2999-01-01' } })).status, 400);
    const { body: { gameId, token, state } } = await call(base, 'POST', '', { body: { mode: 'classic' } });
    const r = await call(base, 'POST', `/${gameId}/play`, {
      token, body: { clientMoveId: moveId(), expectedVersion: state.version, tiles: [{ row: 99, col: 0, letter: 'A' }] },
    });
    assert.equal(r.status, 400);
  } finally {
    server.close();
  }
});

test('stale version gets 409 with the fresh state', async () => {
  const { base, server } = await startServer();
  try {
    const { body: { gameId, token } } = await call(base, 'POST', '', { body: { mode: 'classic' } });
    const r = await call(base, 'POST', `/${gameId}/pass`, { token, body: { clientMoveId: moveId(), expectedVersion: 7 } });
    assert.equal(r.status, 409);
    assert.equal(r.body.state.gameId, gameId);
  } finally {
    server.close();
  }
});

test('full game vs every level and the daily, through the real routes', { skip: skipGo, timeout: 600000 }, async () => {
  const { base, server, pool } = await startServer();
  try {
    for (const opts of [
      { mode: 'classic', opponentId: 'wally' },
      { mode: 'classic', opponentId: 'novice' },
      { mode: 'classic', opponentId: 'diana' },
      { mode: 'daily', dailyDate: '2026-10-15' },
    ]) {
      const created = await call(base, 'POST', '', { body: opts });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const { gameId, token } = created.body;
      let snap = created.body.state;
      let turns = 0;
      let retriedOnce = false;

      while (!snap.ended && turns < 80) {
        turns++;
        if (snap.botPending) {
          const r = await call(base, 'POST', `/${gameId}/bot-turn`, { token, body: {} });
          assert.equal(r.status, 200, JSON.stringify(r.body));
          snap = r.body.state;
          continue;
        }
        const move = await bestHumanMove(snap);
        let path; let body;
        const meta = { clientMoveId: moveId(), expectedVersion: snap.version };
        if (!move) { path = 'pass'; body = meta; }
        else if (move.isExchange) { path = 'exchange'; body = { ...meta, tiles: move.tiles.map(t => t.letter) }; }
        else {
          path = 'play';
          body = { ...meta, tiles: move.tiles.filter(t => t.isNew).map(t => ({ row: t.row, col: t.col, letter: t.letter.toUpperCase(), isBlank: !!t.isBlank })) };
        }
        const r = await call(base, 'POST', `/${gameId}/${path}`, { token, body });
        assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
        if (path === 'play') assert.equal(r.body.human.score, move.score, 'server score matches Go');

        // Replaying the same clientMoveId returns the same move, not a second one.
        if (!retriedOnce) {
          retriedOnce = true;
          const again = await call(base, 'POST', `/${gameId}/${path}`, { token, body });
          assert.equal(again.status, 200);
          assert.deepEqual(again.body.human, r.body.human);
          assert.equal(again.body.state.version, r.body.state.version);
        }

        // Nothing secret mid-game.
        const raw = JSON.stringify(r.body);
        assert.ok(!raw.includes('"bag"') && !raw.includes('"racks"'));
        for (const h of r.body.state.history.filter(x => x.isBot)) {
          if (!r.body.state.ended) assert.equal(h.rack, undefined);
        }
        snap = r.body.state;
      }

      assert.ok(snap.ended, `${opts.opponentId ?? 'daily'} game finished (${turns} turns)`);
      assert.ok(snap.final && Array.isArray(snap.final.opponentRack));
      assert.equal(pool.rows.get(gameId).status, 'ended');
      console.log(`  ${opts.mode}/${opts.opponentId ?? 'wally'}: ${snap.final.player1Score}-${snap.final.player2Score} (${snap.endReason}, ${turns} turns)`);
    }
  } finally {
    server.close();
  }
});
