// COPIED FROM whiffers/src/data/staticData.js (origPool, origBoard) - keep in
// sync (see rules/README.md). PREMIUM_GRID is the parsed board the same way
// gameStore.initializeGame parses it.

export const origPool = "AAAAAAAAABBCCDDDDEEEEEEEEEEEEFFGGGHHIIIIIIIIIJKLLLLMMNNNNNNOOOOOOOOPPQRRRRRRSSSSTTTTTTUUUUVVWWXYYZ??";

export const origBoard = `[    [4,0,0,1,0,0,0,4,0,0,0,1,0,0,4],
                                [0,3,0,0,0,2,0,0,0,2,0,0,0,3,0],
                                [0,0,3,0,0,0,1,0,1,0,0,0,3,0,0],
                                [1,0,0,3,0,0,0,1,0,0,0,3,0,0,1],
                                [0,0,0,0,3,0,0,0,0,0,3,0,0,0,0],
                                [0,2,0,0,0,2,0,0,0,2,0,0,0,2,0],
                                [0,0,1,0,0,0,1,0,1,0,0,0,1,0,0],
                                [4,0,0,1,0,0,0,3,0,0,0,1,0,0,4],
                                [0,0,1,0,0,0,1,0,1,0,0,0,1,0,0],
                                [0,2,0,0,0,2,0,0,0,2,0,0,0,2,0],
                                [0,0,0,0,3,0,0,0,0,0,3,0,0,0,0],
                                [1,0,0,3,0,0,0,1,0,0,0,3,0,0,1],
                                [0,0,3,0,0,0,1,0,1,0,0,0,3,0,0],
                                [0,3,0,0,0,2,0,0,0,2,0,0,0,3,0],
                                [4,0,0,1,0,0,0,4,0,0,0,1,0,0,4]]`;

// 0=normal, 1=DLS, 2=TLS, 3=DWS, 4=TWS - calculateScore's boardMultipliers.
export const PREMIUM_GRID = JSON.parse(origBoard).map(row => row.map(Number));

// A fresh board: premium codes everywhere, letters get written over them.
export function freshBoard() {
  return PREMIUM_GRID.map(row => [...row]);
}
