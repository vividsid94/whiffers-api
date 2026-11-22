// Live updates for multiplayer games over WebSocket (MULTIPLAYER_PLAN.md).
// Moves still go through HTTP (retry-safe); the socket only tells each
// player "here is the game now" and whether their opponent is connected.
//
// Protocol (JSON messages):
//   client -> { type: 'watch', gameId, token }      (token optional if signed in)
//   server -> { type: 'game', game, opponentOnline } (the seat's whole view)
//   server -> { type: 'presence', opponentOnline }
//   server -> { type: 'error', error }               then closes
//
// One API instance, so who's watching what is kept in memory.

import { WebSocketServer } from 'ws';
import { fromNodeHeaders } from 'better-auth/node';
import { seatFor, seatView } from './game.js';

export const SOCKET_PATH = '/mp/socket';
const HELLO_TIMEOUT_MS = 10_000;
const PING_MS = 25_000;

export function createHub({ store, auth, isAllowedOrigin, now = Date.now }) {
  const watchers = new Map(); // gameId -> Set<{ ws, seat }>
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });

  const isOnline = (gameId, seat) => [...(watchers.get(gameId) ?? [])].some(w => w.seat === seat && w.ws.readyState === 1);
  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };

  function presence(gameId) {
    for (const w of watchers.get(gameId) ?? []) send(w.ws, { type: 'presence', opponentOnline: isOnline(gameId, w.seat === 1 ? 2 : 1) });
  }

  // Pushes each watching seat its own view of `game`.
  function broadcast(game) {
    for (const w of watchers.get(game.id) ?? []) {
      send(w.ws, { type: 'game', game: seatView(game, w.seat, now()), opponentOnline: isOnline(game.id, w.seat === 1 ? 2 : 1) });
    }
  }

  async function userIdFrom(req) {
    if (!auth) return null;
    try {
      const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
      return session?.user?.id ?? null;
    } catch {
      return null;
    }
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let watching = null;
    const hello = setTimeout(() => { if (!watching) ws.close(4000, 'no watch'); }, HELLO_TIMEOUT_MS);

    ws.on('message', async (raw) => {
      if (watching) return; // one game per socket
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return ws.close(4001, 'bad message'); }
      if (msg?.type !== 'watch' || typeof msg.gameId !== 'string') return ws.close(4001, 'bad message');
      try {
        const game = await store.get(msg.gameId);
        const seat = game && seatFor(game, { token: typeof msg.token === 'string' ? msg.token : null, userId: await userIdFrom(req) });
        if (!seat) {
          send(ws, { type: 'error', error: 'game_not_found' });
          return ws.close(4004, 'not found');
        }
        clearTimeout(hello);
        watching = { ws, seat, gameId: game.id };
        if (!watchers.has(game.id)) watchers.set(game.id, new Set());
        watchers.get(game.id).add(watching);
        send(ws, { type: 'game', game: seatView(game, seat, now()), opponentOnline: isOnline(game.id, seat === 1 ? 2 : 1) });
        presence(game.id);
      } catch (err) {
        console.error('[mp socket] watch failed:', err.message);
        ws.close(1011, 'error');
      }
    });

    ws.on('close', () => {
      clearTimeout(hello);
      if (!watching) return;
      const set = watchers.get(watching.gameId);
      set?.delete(watching);
      if (set && set.size === 0) watchers.delete(watching.gameId);
      else presence(watching.gameId);
    });
  });

  // Dead connections (phone asleep, network gone) are dropped, which shows
  // the opponent as disconnected.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, PING_MS);
  pinger.unref();

  function attach(server) {
    server.on('upgrade', (req, socket, head) => {
      const { pathname } = new URL(req.url, 'http://x');
      if (pathname !== SOCKET_PATH) return; // not ours
      if (!isAllowedOrigin(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        return socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  function close() {
    clearInterval(pinger);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  }

  return { attach, broadcast, isOnline, close };
}
