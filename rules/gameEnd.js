// COPIED FROM whiffers/src/functions/play/gameEndFunctions.js - keep in sync
// (see rules/README.md). determineWinner is fixed to the Classic/Daily win
// condition (higher score wins) - the frontend reads it from modeConfig.js.
import { letterScores } from './scoreFunctions.js';

// Sum of a rack's own tile point values - blanks ('?') are worth 0.
export function rackValue(rack) {
  return rack.reduce((sum, letter) => sum + (letterScores[letter] ?? 0), 0);
}

// Whoever emptied their rack gets DOUBLE the opponent's remaining rack value;
// if neither rack is empty (six scoreless turns), each side subtracts its own.
export function computeFinalScores({ player1points, player2points, player1Rack, player2Rack }) {
  const p1RackValue = rackValue(player1Rack);
  const p2RackValue = rackValue(player2Rack);

  if (player1Rack.length === 0) {
    return { finalPlayer1Score: player1points + 2 * p2RackValue, finalPlayer2Score: player2points };
  }
  if (player2Rack.length === 0) {
    return { finalPlayer1Score: player1points, finalPlayer2Score: player2points + 2 * p1RackValue };
  }
  return {
    finalPlayer1Score: player1points - p1RackValue,
    finalPlayer2Score: player2points - p2RackValue,
  };
}

// 'player' | 'bot' | 'draw'
export function determineWinner({ finalPlayer1Score, finalPlayer2Score }) {
  if (finalPlayer1Score === finalPlayer2Score) return 'draw';
  return finalPlayer1Score > finalPlayer2Score ? 'player' : 'bot';
}
