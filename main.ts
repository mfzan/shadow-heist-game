// Shadow Heist — hand-in program (Node 22, standard library only).
//
// The game is plain static files under game/: index.html plus a few ES
// modules, no libraries and no network requests, so any static server can
// serve it and desktop Chrome plays it offline. This program is what
// hands the game to make.fun: it copies game/ and screenshots/ next to
// this file into the output directory and writes the dossier.json the
// judge reads, using the vendored make.fun library.
//
// Local run (the grader reads /output instead):
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
// Play it locally with `node serve.ts`, then open http://localhost:8080.

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-game.ts';

// Where this file lives is the repository root.
const root = fileURLToPath(new URL('.', import.meta.url));

// The grader hands us /output; locally MAKEFUN_OUTPUT_DIR points at a
// scratch folder instead.
const out = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// The scorer's own limits, so we refuse an entry it would refuse instead
// of shipping one: at most 4 screenshots of 256 KiB each, game/ at most
// 993 files and 48 MiB with no path over 1000 bytes, and the dossier
// text capped at 160 KiB. The game stays small on purpose, so game/ plus
// screenshots/ plus dossier.json fit /output's own 1000-entry cap too.
const caps = {
  text_max_bytes: 163840,
  screenshots: { max: 4, max_bytes: 262144 },
  game_max_files: 993,
  game_max_bytes: 50331648,
  game_path_max_bytes: 1000,
};

function mustHaveGame(): void {
  // No page, no game: fail loudly rather than handing in an empty folder.
  if (!existsSync(join(root, 'game', 'index.html'))) {
    throw new Error('game/index.html is missing: nothing to hand in');
  }
}

function copyGame(): void {
  mkdirSync(out, { recursive: true });
  cpSync(join(root, 'game'), join(out, 'game'), { recursive: true });
}

function copyShots(): string[] {
  // The judge ranks on screenshots of the game itself, so refuse to hand
  // in a game with none rather than shipping a dossier nobody can see.
  const shotsDir = join(out, 'screenshots');
  mkdirSync(shotsDir, { recursive: true });
  if (existsSync(join(root, 'screenshots'))) {
    cpSync(join(root, 'screenshots'), shotsDir, { recursive: true });
  }
  const shots = readdirSync(shotsDir).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (shots.length === 0) {
    throw new Error('screenshots/ is empty: the judge needs real renders of the game');
  }
  return shots;
}

mustHaveGame();
copyGame();
copyShots();
writeFileSync(join(out, 'dossier.json'), buildDossier(out, caps));
