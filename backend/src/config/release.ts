// The release string stamps itself. A hand-maintained sha is wrong within a week, and a wrong release
// string is worse than none because it blames the wrong deploy for a regression (L-022).
//
// The Dockerfile writes .release (a UTC build timestamp) in the final stage, so every Dokploy deploy
// gets a new value with no input from anyone. It sorts chronologically and maps 1:1 to a deploy in the
// panel. PIPS_RELEASE exists only so a one-off container can label itself.

import { readFileSync } from 'node:fs';

function readStamp(): string {
  try {
    return readFileSync('.release', 'utf8').trim();
  } catch {
    return '';
  }
}

export const RELEASE: string = process.env.PIPS_RELEASE || readStamp() || 'dev';
