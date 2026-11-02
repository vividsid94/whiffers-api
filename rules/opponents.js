// COPIED FROM whiffers/src/functions/play/opponents.js (ids, ranks, personas
// and pickCandidateAtRank only - the faces and lines stay in the frontend) -
// keep in sync (see rules/README.md).

export const OPPONENTS = [
  { id: 'novice', name: 'Novice', rank: 30 },
  { id: 'beginner', name: 'Beginner', rank: 15 },
  { id: 'intermediate', name: 'Intermediate', rank: 5 },
  { id: 'diana', name: 'Diana', persona: 'diana' },
  { id: 'wally', name: 'Wally', rank: 1 },
];

export const DEFAULT_OPPONENT_ID = 'wally';

export function getOpponent(id) {
  return OPPONENTS.find(o => o.id === id) ?? null;
}

// candidates are best-first. When there are fewer than `rank` of them (late
// game), play the weakest one available rather than jumping to the best.
export function pickCandidateAtRank(candidates, rank) {
  return candidates[Math.min(rank, candidates.length) - 1];
}
