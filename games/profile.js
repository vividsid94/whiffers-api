// Profile stats: worked out from a player's saved games (games/archive.js
// lineFor), newest first. Pure, so it's easy to test and the same for
// Postgres and memory archives.

const DAY = 24 * 60 * 60 * 1000;
// Games that ended early (resigned, lost on time) would drag the average
// score down without saying anything about how well you play.
const countsForAverage = (g) => g.endReason !== 'resigned' && g.endReason !== 'timeout';

const avg = (nums) => (nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null);
const pct = (wins, games) => (games ? Math.round((wins / games) * 100) : null);
const tally = () => ({ games: 0, wins: 0, losses: 0, draws: 0 });
const add = (t, g) => { t.games++; t[g.result === 'win' ? 'wins' : g.result === 'loss' ? 'losses' : 'draws']++; return t; };

// Points to a single game (what the highlight cards link to).
const ref = (g) => ({ id: g.id, endedAt: g.endedAt, mode: g.mode, opponent: g.opponent, you: g.you.score, them: g.them.score, result: g.result });

const best = (lines, score) => {
  let top = null;
  for (const g of lines) { const v = score(g); if (v != null && v > 0 && (!top || v > top.v)) top = { v, g }; }
  return top;
};

export function profileStats(lines, now = Date.now()) {
  const games = lines.length;
  const overall = lines.reduce(add, tally());
  const scored = lines.filter(countsForAverage);
  const bingos = lines.reduce((n, g) => n + (g.bingos || 0), 0);

  // Streaks run oldest to newest; a loss or a draw ends one.
  let run = 0;
  let longest = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    run = lines[i].result === 'win' ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  let current = 0;
  for (const g of lines) { if (g.result !== 'win') break; current++; }

  const last30 = lines.filter((g) => g.endedAt > now - 30 * DAY);
  // Margins (your score minus theirs) over played-out games.
  const margin = (g) => g.you.score - g.them.score;
  const wins = scored.filter((g) => g.result === 'win');
  let biggestWin = null;
  let closestWin = null;
  for (const g of wins) {
    if (!biggestWin || margin(g) > margin(biggestWin)) biggestWin = g;
    if (!closestWin || margin(g) < margin(closestWin)) closestWin = g;
  }
  const bestGame = best(lines, (g) => g.you.score);
  const bestPlay = best(lines, (g) => g.bestPlay?.score);
  const mostBingos = best(lines, (g) => g.bingos);
  const comeback = best(lines, (g) => g.comeback);

  // Record against each bot, and against people (each person by username,
  // all guests together as "Guest").
  const bots = new Map();
  const people = new Map();
  const peopleAll = tally();
  for (const g of lines) {
    if (g.opponent.kind === 'bot') {
      const key = g.opponent.botId;
      if (!bots.has(key)) bots.set(key, { botId: key, name: g.opponent.name, ...tally() });
      add(bots.get(key), g);
    } else {
      add(peopleAll, g);
      // By account, so someone who changed their username is still one row.
      const key = g.opponent.kind === 'guest' ? 'Guest' : g.opponent.userId ?? g.opponent.name;
      if (!people.has(key)) people.set(key, { name: g.opponent.kind === 'guest' ? 'Guest' : g.opponent.name, kind: g.opponent.kind, userId: g.opponent.userId ?? null, ...tally() });
      add(people.get(key), g);
    }
  }
  const byGames = (a, b) => b.games - a.games;

  const modes = {};
  for (const g of lines) {
    const m = (modes[g.mode] ??= { ...tally(), scores: [] });
    add(m, g);
    if (countsForAverage(g)) m.scores.push(g.you.score);
  }
  for (const m of Object.values(modes)) { m.avgScore = avg(m.scores); delete m.scores; }

  return {
    games,
    ...overall,
    winRate: pct(overall.wins, games),
    avgScore: avg(scored.map((g) => g.you.score)),
    avgOpponentScore: avg(scored.map((g) => g.them.score)),
    avgMargin: avg(scored.map(margin)),
    scoring: {
      biggestWin: biggestWin && { margin: margin(biggestWin), game: ref(biggestWin) },
      closestWin: closestWin && { margin: margin(closestWin), game: ref(closestWin) },
    },
    bingos,
    bingosPerGame: games ? Math.round((bingos / games) * 100) / 100 : null,
    lastPlayedAt: lines[0]?.endedAt ?? null,
    recent: {
      gamesThisWeek: lines.filter((g) => g.endedAt > now - 7 * DAY).length,
      winRate30: pct(last30.filter((g) => g.result === 'win').length, last30.length),
      avgScore30: avg(last30.filter(countsForAverage).map((g) => g.you.score)),
    },
    streak: { current, longest },
    highlights: {
      bestGame: bestGame && ref(bestGame.g),
      bestPlay: bestPlay && { ...bestPlay.g.bestPlay, game: ref(bestPlay.g) },
      mostBingos: mostBingos && { bingos: mostBingos.v, game: ref(mostBingos.g) },
      biggestComeback: comeback && { deficit: comeback.v, game: ref(comeback.g) },
    },
    records: {
      bots: [...bots.values()].sort(byGames),
      people: { ...peopleAll, opponents: [...people.values()].sort(byGames).slice(0, 20) },
    },
    modes,
    // Oldest first, for the chart (played-out games only, like the average).
    trend: scored.slice(0, 30).reverse().map((g) => ({ you: g.you.score, them: g.them.score, result: g.result })),
    // When games ended over the last 16 weeks; the page buckets them into
    // days in the viewer's own time zone.
    activity: lines.filter((g) => g.endedAt > now - 16 * 7 * DAY).map((g) => g.endedAt),
    daily: lines.filter((g) => g.dailyDate).slice(0, 62).map((g) => ({ date: g.dailyDate, result: g.result, score: g.you.score, id: g.id })),
  };
}
