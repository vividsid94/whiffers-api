# rules/

Pure Scrabble rule modules copied from the whiffers frontend, so the game
server (`games/`) checks and scores moves exactly the way the app always has.
Each file names its source at the top. When a rule changes in the frontend,
change the copy here too, then run:

    node scripts/check-rules-drift.mjs

It diffs each copy against `../whiffers/src` (expects both repos side by side)
and lists anything that has drifted.

`lexicons/` holds the same word lists the frontend validates against
(`whiffers/public/files/nwl2023.txt`, `csw24.txt`).
