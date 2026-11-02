// Plays one full game against a running whiffers-api (local or deployed),
// with the human side using the Go service's own top move each turn, and
// checks the invariants on every response. Usage:
//
//   node scripts/smoke-game.mjs [baseUrl] [opponentId|daily]
//   node scripts/smoke-game.mjs https://whiffers-api-production.up.railway.app wally
//
// Creates a real game row (cleaned up automatically after 30 days).

import crypto from 'crypto';
import { buildBoardForRequest, GO_SERVICE_URL } from '../rules/boardRequest.js';

const base = (process.argv[2] || 'http://localhost:4000').replace(/\/$/, '');
const who = process.argv[3] || 'wally';

function fail(message, detail) {
  console.error(`FAIL: ${message}`, detail ?? '');
  process.exit(1);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}/games${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Game-Token': token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function bestMove(snap) {
  const res = await fetch(`${GO_SERVICE_URL}/generate-moves`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      board: buildBoardForRequest(snap.board, snap.blankTiles),
      rack: snap.myRack.join(''), topN: 1, poolSize: snap.bagCount, lexicon: snap.lexicon,
    }),
  });
  return ((await res.json()).moves || []).find(m => m.isExchange || m.tiles?.length > 0) ?? null;
}

const createBody = who === 'daily'
  ? { mode: 'daily', dailyDate: new Date().toISOString().slice(0, 10) }
  : { mode: 'classic', opponentId: who };
const created = await call('POST', '', { body: createBody });
if (created.status !== 201) fail(`create returned ${created.status}`, created.body);
const { gameId, token } = created.body;
let snap = created.body.state;
console.log(`game ${gameId} (${who}), ${snap.currentPlayer === 1 ? 'you' : 'bot'} first`);

const wrong = await call('GET', `/${gameId}`, { token: 'x'.repeat(43) });
if (wrong.status !== 404) fail('wrong token was not rejected', wrong.status);

let turns = 0;
while (!snap.ended && turns++ < 80) {
  if (snap.botPending) {
    const r = await call('POST', `/${gameId}/bot-turn`, { token, body: {} });
    if (r.status !== 200) fail(`bot-turn ${r.status}`, r.body);
    snap = r.body.state;
    continue;
  }
  const move = await bestMove(snap);
  const meta = { clientMoveId: crypto.randomUUID(), expectedVersion: snap.version };
  let path = 'pass';
  let body = meta;
  if (move?.isExchange) { path = 'exchange'; body = { ...meta, tiles: move.tiles.map(t => t.letter) }; }
  else if (move) {
    path = 'play';
    body = { ...meta, tiles: move.tiles.filter(t => t.isNew).map(t => ({ row: t.row, col: t.col, letter: t.letter.toUpperCase(), isBlank: !!t.isBlank })) };
  }
  const r = await call('POST', `/${gameId}/${path}`, { token, body });
  if (r.status !== 200) fail(`${path} ${r.status}`, r.body);
  if (path === 'play' && r.body.human.score !== move.score) fail('score mismatch', { server: r.body.human.score, go: move.score });
  const raw = JSON.stringify(r.body);
  if (raw.includes('"bag"') || raw.includes('"racks"')) fail('response leaked hidden state');
  if (!r.body.state.ended && r.body.state.history.some(h => h.isBot && h.rack !== undefined)) fail('bot rack leaked mid-game');
  snap = r.body.state;
  process.stdout.write(`  ${path} ${r.body.human.score ?? 0}` + (r.body.bot?.status === 'done' ? ` / bot ${r.body.bot.type} ${r.body.bot.score}\n` : ` / bot ${r.body.bot?.status ?? '-'}\n`));
}

if (!snap.ended) fail('game did not finish');
console.log(`OK: ${snap.final.player1Score}-${snap.final.player2Score} (${snap.endReason}), winner ${snap.final.winner}`);
