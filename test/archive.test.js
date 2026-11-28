// Saved games (games/archive.js): finished games are kept whenever at least
// one player is signed in - games against bots and multiplayer games - and
// read back through /me/games. Sign-in is faked: an X-Test-User header
// stands for a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'crypto';

process.env.DAILY_SECRET = 'test-secret-0123456789abcdef';
const { createGamesRouter } = await import('../games/routes.js');
const { createFakePool } = await import('./fakePool.js');
const { createMemoryArchive } = await import('../games/archive.js');
const { createMultiplayer } = await import('../mp/routes.js');
const { createMemoryStore } = await import('../mp/store.js');
const { mountAuth } = await import('../auth/mount.js');

// Two "accounts": alice and bob. The header carries the user id.
const USERS = {
  'u-alice': { id: 'u-alice', name: 'Alice A', email: 'alice@example.com', username: 'alice', displayUsername: 'Alice', createdAt: new Date('2026-11-01T00:00:00Z') },
  'u-bob': { id: 'u-bob', name: 'Bob B', username: 'bob', displayUsername: 'Bob' },
};
// Alice's saved progress: two Heads Will Roll exhibits.
const USER_DATA = {
  'u-alice': { userId: 'u-alice', data: { v: 1, hwr: { best: 14, exhibits: { q001: { at: '2026-11-10T00:00:00.000Z', seen: true }, q003: { at: '2026-11-12T00:00:00.000Z', seen: false } } } } },
};
const fakeAuth = {
  api: { getSession: async ({ headers }) => { const u = USERS[headers.get('x-test-user')]; return u ? { user: u } : null; } },
  // Looking a player up by username (public profiles).
  $context: Promise.resolve({ adapter: { findOne: async ({ model, where }) => (model === 'user'
    ? Object.values(USERS).find((u) => u[where[0].field] === where[0].value) ?? null
    : model === 'userData' ? USER_DATA[where[0].value] ?? null : null) } }),
  handler: async () => new Response('not here', { status: 404 }),
};

async function startServer() {
  const archive = createMemoryArchive();
  const app = express();
  mountAuth(app, fakeAuth, process.env, { archive });
  app.use('/games', createGamesRouter(createFakePool(), { auth: fakeAuth, archive }));
  const mp = createMultiplayer({ store: createMemoryStore(), auth: fakeAuth, isAllowedOrigin: () => true, archive });
  app.use('/mp', mp.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { archive, base, close: () => { mp.close(); server.close(); } };
}

async function call(base, method, path, { user, token, seatToken, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(user ? { 'X-Test-User': user } : {}),
      ...(token ? { 'X-Game-Token': token } : {}),
      ...(seatToken ? { 'X-Seat-Token': seatToken } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

// Saving happens just after the answer goes out: give it a moment.
const settle = () => new Promise((r) => setTimeout(r, 30));

test('a signed-in player\'s game against Wally is saved when it ends; a guest\'s isn\'t', async () => {
  const srv = await startServer();
  try {
    const mine = await call(srv.base, 'POST', '/games', { user: 'u-alice', body: { mode: 'classic', opponentId: 'wally' } });
    const anon = await call(srv.base, 'POST', '/games', { body: { mode: 'classic', opponentId: 'wally' } });
    await call(srv.base, 'POST', `/games/${mine.body.gameId}/resign`, { token: mine.body.token, body: {} });
    await call(srv.base, 'POST', `/games/${anon.body.gameId}/resign`, { token: anon.body.token, body: {} });
    await settle();
    assert.equal(srv.archive.records.size, 1);

    const list = await call(srv.base, 'GET', '/me/games', { user: 'u-alice' });
    assert.equal(list.status, 200);
    assert.equal(list.body.games.length, 1);
    const g = list.body.games[0];
    assert.equal(g.id, mine.body.gameId);
    assert.equal(g.source, 'bot');
    assert.equal(g.mode, 'classic');
    assert.deepEqual(g.opponent, { name: 'Wally', kind: 'bot', botId: 'wally' });
    assert.equal(g.result, 'loss');
    assert.equal(g.endReason, 'resigned');

    // Someone else can't see it.
    assert.equal((await call(srv.base, 'GET', '/me/games', { user: 'u-bob' })).body.games.length, 0);
    assert.equal((await call(srv.base, 'GET', `/me/games/${mine.body.gameId}`, { user: 'u-bob' })).status, 404);
    // Signed out: no list at all.
    assert.equal((await call(srv.base, 'GET', '/me/games')).status, 401);

    // The full game, for replay, from Alice's side.
    const detail = await call(srv.base, 'GET', `/me/games/${mine.body.gameId}`, { user: 'u-alice' });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.game.you.name, 'Alice');
    assert.equal(detail.body.game.state.ended, true);
    assert.equal(detail.body.game.state.final.winner, 'bot');
  } finally { srv.close(); }
});

test('a bot game lost on time is saved as a timeout', async () => {
  const srv = await startServer();
  try {
    const g = await call(srv.base, 'POST', '/games', { user: 'u-alice', body: { mode: 'classic', opponentId: 'diana' } });
    await call(srv.base, 'POST', `/games/${g.body.gameId}/resign`, { token: g.body.token, body: { reason: 'timeout' } });
    await settle();
    const [saved] = (await call(srv.base, 'GET', '/me/games', { user: 'u-alice' })).body.games;
    assert.equal(saved.endReason, 'timeout');
    assert.equal(saved.result, 'loss');
    assert.equal(saved.opponent.name, 'Diana');
  } finally { srv.close(); }
});

async function mpGame(srv, { creator, joiner }) {
  const created = await call(srv.base, 'POST', '/mp/invites', {
    user: creator, body: { settings: { mode: 'classic', minutes: 10, overtimeMinutes: 1, firstPlayer: 'creator' }, guestName: creator ? undefined : 'Gary' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const joined = await call(srv.base, 'POST', `/mp/invites/${created.body.code}/join`, { user: joiner, body: { guestName: joiner ? undefined : 'Gina' } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { id: created.body.gameId, tokens: { 1: created.body.token, 2: joined.body.token } };
}

test('multiplayer: one signed-in player - saved for them, against "Guest"', async () => {
  const srv = await startServer();
  try {
    const g = await mpGame(srv, { creator: 'u-alice', joiner: null });
    await call(srv.base, 'POST', `/mp/games/${g.id}/resign`, { seatToken: g.tokens[2] }); // the guest resigns
    await settle();
    const [saved] = (await call(srv.base, 'GET', '/me/games', { user: 'u-alice' })).body.games;
    assert.equal(saved.source, 'mp');
    assert.deepEqual(saved.opponent, { name: 'Guest', kind: 'guest', botId: null }); // never "Gina"
    assert.equal(saved.result, 'win');
    assert.equal(saved.settings.minutes, 10);
    const record = srv.archive.records.get(g.id);
    assert.equal(JSON.stringify(record).includes('Gina'), false);
  } finally { srv.close(); }
});

test('multiplayer: both signed in - saved for both, each from their own side', async () => {
  const srv = await startServer();
  try {
    const g = await mpGame(srv, { creator: 'u-alice', joiner: 'u-bob' });
    await call(srv.base, 'POST', `/mp/games/${g.id}/resign`, { seatToken: g.tokens[1] }); // Alice resigns
    await settle();
    const [a] = (await call(srv.base, 'GET', '/me/games', { user: 'u-alice' })).body.games;
    const [b] = (await call(srv.base, 'GET', '/me/games', { user: 'u-bob' })).body.games;
    assert.equal(a.id, g.id);
    assert.equal(b.id, g.id);
    assert.equal(a.opponent.name, 'Bob');
    assert.equal(b.opponent.name, 'Alice');
    assert.equal(a.result, 'loss');
    assert.equal(b.result, 'win');
    // A rematch request re-saves the ended game: still only one record.
    await call(srv.base, 'POST', `/mp/games/${g.id}/rematch`, { seatToken: g.tokens[1] });
    await settle();
    assert.equal(srv.archive.records.size, 1);
  } finally { srv.close(); }
});

test('multiplayer: two guests - nothing saved', async () => {
  const srv = await startServer();
  try {
    const g = await mpGame(srv, { creator: null, joiner: null });
    await call(srv.base, 'POST', `/mp/games/${g.id}/resign`, { seatToken: g.tokens[1] });
    await settle();
    assert.equal(srv.archive.records.size, 0);
  } finally { srv.close(); }
});

test('paging back through your games', async () => {
  const srv = await startServer();
  try {
    for (let i = 0; i < 3; i++) {
      const g = await call(srv.base, 'POST', '/games', { user: 'u-alice', body: { mode: 'classic', opponentId: 'wally' } });
      await call(srv.base, 'POST', `/games/${g.body.gameId}/resign`, { token: g.body.token, body: {} });
      await new Promise((r) => setTimeout(r, 15));
    }
    await settle();
    const page1 = (await call(srv.base, 'GET', '/me/games?limit=2', { user: 'u-alice' })).body;
    assert.equal(page1.games.length, 2);
    assert.ok(page1.next);
    const page2 = (await call(srv.base, 'GET', `/me/games?limit=2&before=${page1.next}`, { user: 'u-alice' })).body;
    assert.equal(page2.games.length, 1);
    assert.equal(page2.next, null);
    const ids = new Set([...page1.games, ...page2.games].map(g => g.id));
    assert.equal(ids.size, 3);
  } finally { srv.close(); }
});

test('public profile: stats and games for anyone, nothing private', async () => {
  const srv = await startServer();
  try {
    // Alice: a resigned game against Wally, and a multiplayer win over a guest.
    const bot = await call(srv.base, 'POST', '/games', { user: 'u-alice', body: { mode: 'classic', opponentId: 'wally' } });
    await call(srv.base, 'POST', `/games/${bot.body.gameId}/resign`, { token: bot.body.token, body: {} });
    await new Promise((r) => setTimeout(r, 15));
    const mp = await mpGame(srv, { creator: 'u-alice', joiner: null });
    await call(srv.base, 'POST', `/mp/games/${mp.id}/resign`, { seatToken: mp.tokens[2] }); // the guest resigns
    await settle();

    // Signed out, with any capitalisation of the name.
    const res = await call(srv.base, 'GET', '/profiles/ALICE');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.profile, { username: 'Alice', joinedAt: Date.parse('2026-11-01T00:00:00Z') });
    const st = res.body.stats;
    assert.equal(st.games, 2);
    assert.equal(st.wins, 1);
    assert.equal(st.losses, 1);
    assert.equal(st.winRate, 50);
    assert.equal(st.streak.current, 1);
    assert.deepEqual(st.records.bots.map((b) => [b.name, b.wins, b.losses]), [['Wally', 0, 1]]);
    assert.equal(st.records.people.games, 1);
    assert.deepEqual(st.records.people.opponents.map((o) => o.name), ['Guest']);
    assert.equal(st.modes.classic.games, 2);
    assert.equal(st.trend.length, 0); // both games ended in a resignation
    // Heads Will Roll museum: best score and collected exhibits, newest first.
    assert.deepEqual(res.body.museum, { best: 14, exhibits: [{ id: 'q003', at: '2026-11-12T00:00:00.000Z' }, { id: 'q001', at: '2026-11-10T00:00:00.000Z' }] });
    assert.deepEqual((await call(srv.base, 'GET', '/profiles/bob')).body.museum, { best: 0, exhibits: [] });
    // Never the email or the Google name.
    const raw = JSON.stringify(res.body);
    assert.equal(raw.includes('alice@example.com'), false);
    assert.equal(raw.includes('Alice A'), false);

    const list = await call(srv.base, 'GET', '/profiles/alice/games');
    assert.equal(list.body.games.length, 2);
    assert.equal(list.body.games[0].opponent.name, 'Guest');
    const one = await call(srv.base, 'GET', `/profiles/alice/games/${bot.body.gameId}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.game.state.ended, true);

    // Unknown players and other people's games.
    assert.equal((await call(srv.base, 'GET', '/profiles/nobody')).status, 404);
    assert.equal((await call(srv.base, 'GET', '/profiles/no%20spaces')).status, 404);
    assert.equal((await call(srv.base, 'GET', `/profiles/bob/games/${bot.body.gameId}`)).status, 404);
    assert.equal((await call(srv.base, 'GET', '/profiles/bob')).body.stats.games, 0);
  } finally { srv.close(); }
});

test('opponents link to their profile by their current username, even after a rename', async () => {
  const srv = await startServer();
  const bob = USERS['u-bob'];
  const before = { username: bob.username, displayUsername: bob.displayUsername };
  try {
    const g = await mpGame(srv, { creator: 'u-alice', joiner: 'u-bob' });
    await call(srv.base, 'POST', `/mp/games/${g.id}/resign`, { seatToken: g.tokens[2] }); // Bob resigns
    await settle();

    const [game] = (await call(srv.base, 'GET', '/profiles/alice/games')).body.games;
    assert.deepEqual(game.opponent, { name: 'Bob', kind: 'player', botId: null, username: 'bob' });

    // Bob renames himself: Alice's history follows, everywhere.
    bob.username = 'robert';
    bob.displayUsername = 'Robert';
    const [renamed] = (await call(srv.base, 'GET', '/profiles/alice/games')).body.games;
    assert.equal(renamed.opponent.name, 'Robert');
    assert.equal(renamed.opponent.username, 'robert');
    const stats = (await call(srv.base, 'GET', '/profiles/alice')).body.stats;
    assert.deepEqual(stats.records.people.opponents.map((o) => [o.name, o.username]), [['Robert', 'robert']]);
    const detail = (await call(srv.base, 'GET', `/profiles/alice/games/${g.id}`)).body.game;
    assert.equal(detail.opponent.username, 'robert');
    const mine = (await call(srv.base, 'GET', '/me/games', { user: 'u-alice' })).body.games[0];
    assert.equal(mine.opponent.username, 'robert');
    // Account ids never go out.
    assert.equal(JSON.stringify(stats).includes('u-bob'), false);
    assert.equal(JSON.stringify(detail).includes('u-bob'), false);
  } finally {
    Object.assign(bob, before);
    srv.close();
  }
});

void crypto;
