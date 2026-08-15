// Cartridge glyph for each real-money game: single-color silhouettes, 500x500. Shared by the DOM
// GameIcon (masked to currentColor) and the canvas PnL card (tinted via loadTintedIcon), so there's
// one place mapping a play's `game` field to its art.
export const GAME_ICON_SRC: Record<string, string> = {
  lucky: '/assets/games/icon-lucky.svg',
  range: '/assets/games/icon-range.svg',
  moonshot: '/assets/games/icon-moonshot.svg',
  pin: '/assets/games/icon-pin.svg',
  snipe: '/assets/games/icon-snipe.svg',
  press: '/assets/games/icon-press.svg',
  rush: '/assets/games/icon-rush.svg',
  breakout: '/assets/games/icon-breakout.svg',
}
