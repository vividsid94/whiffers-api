// Multiplayer end to end (MULTIPLAYER_PLAN.md phase 2): two players through
// the real /mp routes and the live socket, with the in-memory store and a
// clock the test controls. Full games pick moves with the REAL Go move
// generator (network needed - skipped with SKIP_GO_TESTS=1), like
// routes.test.js does for bot games.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'crypto';
import WebSocket from 'ws';

const { createMultiplayer } = await import('../mp/routes.js');
const { createMemoryStore } = await import('../mp/store.js');
const { buildBoardForRequest, GO_SERVICE_URL } = await import('../rules/boardRequest.js');
const { MINUTE } = await import('../mp/clock.js');

const skipGo = process.env.SKIP_GO_TESTS === '1';

async function startServer() {
  // A frozen clock: only advance() moves it, so clock maths is exact.
  let t = Date.now();
  const now = () => t;
  const store = createMemoryStore();
  const mp = createMultiplayer({ store, auth: null, isAllowedOrigin: () => true, now });
  const app = express();
  app.use('/mp', mp.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  mp.attachSockets(server);
  const port = server.address().port;
  return {
    store,
    base: `http://127.0.0.1:${port}/mp`,
    ws: `ws://127.0.0.1:${port}/mp/socket`,
    advance: (ms) => { t += ms; },
    close: () => { mp.close(); server.close(); },
  };
}

async function call(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Seat-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const moveId = () => crypto.randomUUID();

// Creator (seat 1) invites; friend (seat 2) joins. Returns both tokens and
// the friend's first view.
async function startGame(srv, settings = {}) {
  const created = await call(srv.base, 'POST', '/invites', {
    body: { settings: { mode: 'classic', minutes: 10, overtimeMinutes: 1, firstPlayer: 'creator', ...settings }, guestName: 'Alice' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const joined = await call(srv.base, 'POST', `/invites/${created.body.code}/join`, { body: { guestName: 'Bob' } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { id: created.body.gameId, code: created.body.code, tokens: { 1: created.body.token, 2: joined.body.token }, joined: joined.body.game };
}

// Go's best move for this seat's rack, as a /mp request body (or a pass).
async function bestMove(snap) {
  const res = await fetch(`${GO_SERVICE_URL}/generate-moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ board: buildBoardForRequest(snap.board, snap.blankTiles), rack: snap.myRack.join(''), topN: 1, poolSize: snap.bagCount, lexicon: snap.lexicon }),
  });
  const move = ((await res.json()).moves || []).find(m => m.isExchange || m.tiles?.length > 0);
  if (!move) return { path: 'pass', body: {} };
  if (move.isExchange) return { path: 'exchange', body: { tiles: move.tiles.map(t => (t.isBlank ? '?' : String(t.letter).toUpperCase())) } };
  return { path: 'play', body: { tiles: move.tiles.filter(t => t.isNew).map(t => ({ row: t.row, col: t.col, letter: String(t.letter).toUpperCase(), isBlank: !!t.isBlank })) } };
}

test('invite page, joining, and each seat seeing its own side', async () => {
  const srv = await startServer();
  try {
    const created = await call(srv.base, 'POST', '/invites', { body: { settings: { mode: 'classic', minutes: 15, overtimeMinutes: 2 }, guestName: 'Alice' } });
    assert.equal(created.status, 201);
    assert.match(created.body.code, /^[A-Z2-9]{8}$/);
    assert.equal(created.body.game.status, 'waiting');
    assert.equal(created.body.game.state, null);

    const invite = await call(srv.base, 'GET', `/invites/${created.body.code.toLowerCase()}`);
    assert.equal(invite.status, 200);
    assert.deepEqual(invite.body.invite.creator, { name: 'Alice', guest: true });
    assert.equal(invite.body.invite.settings.minutes, 15);
    assert.equal(JSON.stringify(invite.body).includes('tokenHash'), false);

    // The creator can't take the second seat with their own token.
    const own = await call(srv.base, 'POST', `/invites/${created.body.code}/join`, { token: created.body.token, body: { guestName: 'Alice2' } });
    assert.equal(own.status, 409);

    const joined = await call(srv.base, 'POST', `/invites/${created.body.code}/join`, { body: { guestName: 'Bob' } });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.game.status, 'active');
    assert.deepEqual(joined.body.game.you, { name: 'Bob', guest: true });
    assert.deepEqual(joined.body.game.opponent, { name: 'Alice', guest: true });
    assert.equal(joined.body.game.seat, 2);
    assert.equal(joined.body.game.state.multiplayer, true);
    assert.equal(joined.body.game.clock.player1Ms, 15 * MINUTE);

    // Third person: full. Unknown token: looks like no game at all.
    const third = await call(srv.base, 'POST', `/invites/${created.body.code}/join`, { body: { guestName: 'Carol' } });
    assert.equal(third.status, 404); // the code is retired once the game starts
    const stranger = await call(srv.base, 'GET', `/games/${created.body.gameId}`, { token: 'x'.repeat(43) });
    assert.equal(stranger.status, 404);

    const a = await call(srv.base, 'GET', `/games/${created.body.gameId}`, { token: created.body.token });
    const b = await call(srv.base, 'GET', `/games/${created.body.gameId}`, { token: joined.body.token });
    assert.notDeepEqual(a.body.game.state.myRack, undefined);
    assert.equal(a.body.game.state.currentPlayer + b.body.game.state.currentPlayer, 3); // one "your turn", one "theirs"
    assert.deepEqual([...a.body.game.state.unseen, ...a.body.game.state.myRack].sort(), [...b.body.game.state.unseen, ...b.body.game.state.myRack].sort());
  } finally { srv.close(); }
});

test('settings and names are checked', async () => {
  const srv = await startServer();
  try {
    const badClock = await call(srv.base, 'POST', '/invites', { body: { settings: { minutes: 0 }, guestName: 'A' } });
    assert.equal(badClock.status, 400);
    const badOvertime = await call(srv.base, 'POST', '/invites', { body: { settings: { overtimeMinutes: 5 }, guestName: 'A' } });
    assert.equal(badOvertime.status, 400);
    const badMode = await call(srv.base, 'POST', '/invites', { body: { settings: { mode: 'daily' }, guestName: 'A' } });
    assert.equal(badMode.status, 400);
    const noName = await call(srv.base, 'POST', '/invites', { body: { settings: {} } });
    assert.equal(noName.status, 400);
    const longName = await call(srv.base, 'POST', '/invites', { body: { settings: {}, guestName: 'x'.repeat(21) } });
    assert.equal(longName.status, 400);
  } finally { srv.close(); }
});

test('turns, retries, pass/exchange, resign and cancel', async () => {
  const srv = await startServer();
  try {
    const g = await startGame(srv); // creator (seat 1) moves first
    const notYours = await call(srv.base, 'POST', `/games/${g.id}/pass`, { token: g.tokens[2], body: { clientMoveId: moveId() } });
    assert.equal(notYours.status, 409);
    assert.equal(notYours.body.error, 'not_your_turn');

    const id = moveId();
    const pass = await call(srv.base, 'POST', `/games/${g.id}/pass`, { token: g.tokens[1], body: { clientMoveId: id } });
    assert.equal(pass.status, 200);
    assert.equal(pass.body.game.state.currentPlayer, 2);
    // The same move sent again doesn't count twice.
    const retry = await call(srv.base, 'POST', `/games/${g.id}/pass`, { token: g.tokens[1], body: { clientMoveId: id } });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.game.state.history.length, 1);

    const rack2 = (await call(srv.base, 'GET', `/games/${g.id}`, { token: g.tokens[2] })).body.game.state.myRack;
    const ex = await call(srv.base, 'POST', `/games/${g.id}/exchange`, { token: g.tokens[2], body: { tiles: rack2.slice(0, 2), clientMoveId: moveId() } });
    assert.equal(ex.status, 200);
    assert.equal(ex.body.game.state.history[1].player, 1); // seat 2's own move, from its side
    assert.deepEqual(ex.body.game.state.history[1].exchanged, rack2.slice(0, 2));
    const seenBy1 = (await call(srv.base, 'GET', `/games/${g.id}`, { token: g.tokens[1] })).body.game.state.history[1];
    assert.equal(seenBy1.exchanged, undefined);
    assert.equal(seenBy1.exchangedCount, 2);

    const badWord = await call(srv.base, 'POST', `/games/${g.id}/play`, {
      token: g.tokens[1], body: { tiles: [{ row: 7, col: 7, letter: 'Q' }, { row: 7, col: 8, letter: 'X' }], clientMoveId: moveId() },
    });
    assert.equal(badWord.status, 422);

    const resigned = await call(srv.base, 'POST', `/games/${g.id}/resign`, { token: g.tokens[2] });
    assert.equal(resigned.status, 200);
    assert.equal(resigned.body.game.status, 'ended');
    assert.equal(resigned.body.game.state.final.winner, 'bot'); // seat 2 resigned: "your opponent won"
    const winnerView = (await call(srv.base, 'GET', `/games/${g.id}`, { token: g.tokens[1] })).body.game;
    assert.equal(winnerView.state.final.winner, 'player');
    assert.equal(winnerView.clock.running, false);

    // Cancel: only the creator, only while waiting.
    const inv = await call(srv.base, 'POST', '/invites', { body: { settings: {}, guestName: 'Zed' } });
    const cancelled = await call(srv.base, 'POST', `/games/${inv.body.gameId}/cancel`, { token: inv.body.token });
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.game.status, 'cancelled');
    assert.equal((await call(srv.base, 'GET', `/invites/${inv.body.code}`)).status, 404);
  } finally { srv.close(); }
});

test('invites expire after 30 minutes', async () => {
  const srv = await startServer();
  try {
    const inv = await call(srv.base, 'POST', '/invites', { body: { settings: {}, guestName: 'Zed' } });
    srv.advance(31 * MINUTE);
    assert.equal((await call(srv.base, 'GET', `/invites/${inv.body.code}`)).body.invite.status, 'expired');
    const late = await call(srv.base, 'POST', `/invites/${inv.body.code}/join`, { body: { guestName: 'Late' } });
    assert.equal(late.status, 410);
  } finally { srv.close(); }
});

test('clocks: overtime costs 10 a minute; running past it loses on time', async () => {
  const srv = await startServer();
  try {
    const g = await startGame(srv, { minutes: 1, overtimeMinutes: 2 });
    // Seat 1 takes 2:30 on a pass: 1:30 into overtime (2 started minutes).
    srv.advance(150_000);
    const pass = await call(srv.base, 'POST', `/games/${g.id}/pass`, { token: g.tokens[1], body: { clientMoveId: moveId() } });
    assert.equal(pass.status, 200);
    assert.equal(pass.body.game.clock.player1Ms, -90_000);
    // Seat 2 then sits for 3 minutes: past their 1 + 2 minutes.
    srv.advance(3 * MINUTE + 1000);
    const late = await call(srv.base, 'POST', `/games/${g.id}/pass`, { token: g.tokens[2], body: { clientMoveId: moveId() } });
    assert.equal(late.status, 410);
    assert.equal(late.body.error, 'out_of_time');
    const final = late.body.game.state.final;
    assert.equal(late.body.game.state.endReason, 'timeout');
    assert.equal(final.winner, 'bot'); // seat 2 ran out: their opponent won
    assert.deepEqual(final.overtimePenalty, { 1: 20, 2: 30 });
    assert.equal(final.player2Score, -20); // seat 1's 0 points - 20, from seat 2's side as "opponent"
  } finally { srv.close(); }
});

test('no overtime: running out is an instant loss, even with nobody making a move', async () => {
  const srv = await startServer();
  try {
    const g = await startGame(srv, { minutes: 1, overtimeMinutes: 0 });
    srv.advance(MINUTE + 10);
    const view = await call(srv.base, 'GET', `/games/${g.id}`, { token: g.tokens[2] });
    assert.equal(view.body.game.status, 'ended');
    assert.equal(view.body.game.state.endReason, 'timeout');
    assert.equal(view.body.game.state.final.winner, 'player'); // seat 1 ran out; seat 2 wins
  } finally { srv.close(); }
});

test('rematch: both ask, same players, the other one goes first', async () => {
  const srv = await startServer();
  try {
    const g = await startGame(srv, { firstPlayer: 'creator' });
    await call(srv.base, 'POST', `/games/${g.id}/resign`, { token: g.tokens[1] });
    const one = await call(srv.base, 'POST', `/games/${g.id}/rematch`, { token: g.tokens[1] });
    assert.equal(one.body.rematchGameId, null);
    assert.deepEqual(one.body.game.rematch, { you: true, opponent: false, gameId: null });
    const two = await call(srv.base, 'POST', `/games/${g.id}/rematch`, { token: g.tokens[2] });
    const newId = two.body.rematchGameId;
    assert.match(newId, /^[0-9a-f-]{36}$/);
    // Same tokens carry over; seat 2 moves first this time.
    const a = await call(srv.base, 'GET', `/games/${newId}`, { token: g.tokens[1] });
    assert.equal(a.status, 200);
    assert.equal(a.body.game.status, 'active');
    assert.equal(a.body.game.previousGameId, g.id);
    assert.equal(a.body.game.state.currentPlayer, 2); // seat 2's turn
    // Asking again just points at the same rematch.
    const again = await call(srv.base, 'POST', `/games/${g.id}/rematch`, { token: g.tokens[1] });
    assert.equal(again.body.rematchGameId, newId);
  } finally { srv.close(); }
});

test('live socket: each player gets their own view pushed, plus presence', async () => {
  const srv = await startServer();
  const sockets = [];
  const connect = (token, gameId) => new Promise((resolve, reject) => {
    const ws = new WebSocket(srv.ws);
    sockets.push(ws);
    const inbox = [];
    const waiters = [];
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      const w = waiters.findIndex(x => x.match(msg));
      if (w >= 0) waiters.splice(w, 1)[0].resolve(msg); else inbox.push(msg);
    });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'watch', gameId, token })); resolve({
      next: (match) => new Promise((res) => {
        const i = inbox.findIndex(match);
        if (i >= 0) return res(inbox.splice(i, 1)[0]);
        waiters.push({ match, resolve: res });
      }),
    }); });
    ws.on('error', reject);
  });
  try {
    const g = await startGame(srv);
    const alice = await connect(g.tokens[1], g.id);
    const first = await alice.next(m => m.type === 'game');
    assert.equal(first.game.seat, 1);
    assert.equal(first.opponentOnline, false);

    const bob = await connect(g.tokens[2], g.id);
    await bob.next(m => m.type === 'game');
    assert.equal((await alice.next(m => m.type === 'presence' && m.opponentOnline)).opponentOnline, true);

    await call(srv.base, 'POST', `/games/${g.id}/pass`, { token: g.tokens[1], body: { clientMoveId: moveId() } });
    const pushedToBob = await bob.next(m => m.type === 'game' && m.game.state.history.length === 1);
    assert.equal(pushedToBob.game.seat, 2);
    assert.equal(pushedToBob.game.state.currentPlayer, 1); // now Bob's turn, from Bob's side

    // A wrong token is refused.
    const intruder = new WebSocket(srv.ws);
    sockets.push(intruder);
    const closed = await new Promise((resolve) => {
      intruder.on('open', () => intruder.send(JSON.stringify({ type: 'watch', gameId: g.id, token: 'nope'.repeat(10) })));
      intruder.on('close', (code) => resolve(code));
    });
    assert.equal(closed, 4004);

    sockets[1].close();
    assert.equal((await alice.next(m => m.type === 'presence' && !m.opponentOnline)).opponentOnline, false);
  } finally {
    sockets.forEach(s => s.terminate());
    srv.close();
  }
});

for (const mode of ['classic', 'drawbacks']) {
  test(`a full ${mode} game between two people, to the end`, { skip: skipGo && 'SKIP_GO_TESTS=1', timeout: 240_000 }, async () => {
    const srv = await startServer();
    try {
      const g = await startGame(srv, { mode, minutes: 25 });
      let views = {
        1: (await call(srv.base, 'GET', `/games/${g.id}`, { token: g.tokens[1] })).body.game,
        2: g.joined,
      };
      for (let turn = 0; turn < 80 && views[1].status === 'active'; turn++) {
        const seat = views[1].state.currentPlayer === 1 ? 1 : 2;
        const mine = (await call(srv.base, 'GET', `/games/${g.id}`, { token: g.tokens[seat] })).body.game;
        let move = await bestMove(mine.state);
        let res = await call(srv.base, 'POST', `/games/${g.id}/${move.path}`, { token: g.tokens[seat], body: { ...move.body, clientMoveId: moveId() } });
        // A drawback may refuse Go's plain best move: fall back to passing.
        if (res.status === 422) res = await call(srv.base, 'POST', `/games/${g.id}/pass`, { token: g.tokens[seat], body: { clientMoveId: moveId() } });
        assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
        views = {
          1: (await call(srv.base, 'GET', `/games/${g.id}`, { token: g.tokens[1] })).body.game,
          2: (await call(srv.base, 'GET', `/games/${g.id}`, { token: g.tokens[2] })).body.game,
        };
      }
      assert.equal(views[1].status, 'ended');
      const f1 = views[1].state.final;
      const f2 = views[2].state.final;
      // Both sides agree on the result, each from their own side.
      assert.equal(f1.player1Score, f2.player2Score);
      assert.equal(f1.player2Score, f2.player1Score);
      const swap = { player: 'bot', bot: 'player', draw: 'draw' };
      assert.equal(swap[f1.winner], f2.winner);
      if (mode === 'drawbacks') {
        assert.notEqual(views[1].state.drawbacks.wally, null); // the opponent's drawback is revealed at the end
      }
      console.log(`  ${mode}: ${f1.player1Score}-${f1.player2Score} (${views[1].state.endReason}, ${views[1].state.history.length} turns)`);
    } finally { srv.close(); }
  });
}
