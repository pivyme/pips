// The game roster, in one place. Spec: bigdev/plans/cont/04-GAMES-LAB.md §2.
//
// A lab game is a real game in every respect (real console, real controls, real DUSDC, real settlement).
// The only difference is who can see it: for anyone but an ADMIN it answers 404, the same as a name that
// was never registered, so an unreleased game's existence is never leaked. Promoting one is a single line
// out of LAB.

import { isAdmin } from './roles.ts';
import type { Game } from '../types/api.ts';

export const GAMES: Game[] = ['lucky', 'range', 'moonshot', 'pin', 'snipe', 'press', 'rush', 'breakout'];

const LAB = new Set<Game>(['pin', 'snipe', 'press', 'rush', 'breakout']);

/** The games a normal player can reach. Promoting a lab game moves it here by leaving LAB. */
export const PUBLIC_GAMES: Game[] = GAMES.filter((g) => !LAB.has(g));

export function isGame(value: string): value is Game {
  return (GAMES as string[]).includes(value);
}

export function isLabGame(game: Game): boolean {
  return LAB.has(game);
}

/** The one question every game-keyed route asks: does this name exist for this caller at all? */
export function canSeeGame(value: string, roles: string[] | undefined | null): value is Game {
  return isGame(value) && (!isLabGame(value) || isAdmin(roles));
}
