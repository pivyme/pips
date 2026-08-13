// The event allowlist, and the backend is the source of truth for it. `web/src/lib/track.ts` keeps a typed
// twin so a typo fails typecheck, and `cd web && bun run check:admin` fails the gate if the two drift (A2).
// See bigdev/plans/cont/03-ADMIN-DASHBOARD.md §4.1.
//
// Unknown names are rejected with 400 and never inserted. This is the single most important anti-abuse
// control in the whole system: without it a client generates 10M distinct names and every GROUP BY in the
// dashboard is destroyed. Cardinality is bounded by this file, not by client behaviour.
//
// Adding an event is one line here plus one line in the web twin. Never a dynamic name, ever.

export const EVENT_NAMES = [
  // app: process-level, fires once per launch
  'app.open', // { cold }
  'app.pwa_launch',
  'app.install_prompt', // { accepted }

  // door: the pre-auth funnel plus onboarding. The 7 pre-auth names below are the anonymous sub-allowlist.
  'door.landing_view',
  'door.gate_pass',
  'door.gate_fail',
  'door.start_tap',
  'door.auth_start', // { method }
  'door.auth_ok', // carries anonId, which is what stitches the pre-auth session to the user
  'door.auth_fail', // { reason }
  'door.onboard_view',
  'door.onboard_username_set',
  'door.onboard_done',

  // hub: the games home screen
  'hub.view',
  'hub.game_tile_tap', // { game }
  'hub.inplay_resume', // { game }

  // game: one play, start to finish
  'game.open', // { game }
  'game.knob_change', // { game, tier }
  'game.stake_change', // { game, stake }
  'game.play_tap', // { game, stake, tier }
  'game.play_open', // { game, latencyMs }
  'game.play_error', // { game, code }
  'game.cashout_tap', // { game }
  'game.cashout_done', // { game, pnl }
  'game.settled', // { game, result, pnl }
  'game.restore', // { game }

  // menu: one event with a prop covers all 14 routes, which is what keeps cardinality bounded
  'menu.open',
  'menu.section', // { section }
  'menu.setting_toggle', // { key, on }

  // money: deposits, withdrawals, chips
  'money.deposit_open',
  'money.deposit_quote', // { chain, token }
  'money.deposit_execute',
  'money.deposit_done', // { chain }, server-observed
  'money.deposit_fail', // { chain, reason }
  'money.withdraw_open',
  'money.withdraw_done',
  'money.withdraw_fail', // { reason }
  'money.faucet_tap',
  'money.grant_received', // { amount }

  // arcade: the score-only minigames
  'arcade.start', // { game }
  'arcade.end', // { game, score }

  // social
  'social.share_open',
  'social.share_card',
  'social.referral_open',
  'social.referral_claim',

  // custom: we built a whole Customize studio and have no idea if anyone opens it
  'custom.studio_open',
  'custom.skin_preview', // { skin }
  'custom.skin_apply', // { skin }

  // friction: the moments a user hits a wall. Highest-signal namespace in the catalog.
  'friction.chain_unavailable',
  'friction.sponsor_paused',
  'friction.session_heal',
  'friction.error_screen', // { code }

  // admin: server-emitted audit trail, never sent from a client
  'admin.role_change', // { target, role, granted }
  'admin.setting_change', // { key, from, to }
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const NAME_SET: ReadonlySet<string> = new Set(EVENT_NAMES);

export function isEventName(name: string): name is EventName {
  return NAME_SET.has(name);
}

// The 7 names an anonymous client may send (§4.3). The most valuable funnel happens before a JWT exists,
// so requiring auth would blind us exactly where we most want to see. Everything else is 401.
// Deliberately hardcoded and short: the anonymous blast radius is 7 names at 10 req/min per IP.
export const PRE_AUTH_EVENTS: readonly EventName[] = [
  'app.open',
  'door.landing_view',
  'door.gate_pass',
  'door.gate_fail',
  'door.start_tap',
  'door.auth_start',
  'door.auth_fail',
];

const PRE_AUTH_SET: ReadonlySet<string> = new Set(PRE_AUTH_EVENTS);

export function isPreAuthEvent(name: string): boolean {
  return PRE_AUTH_SET.has(name);
}

export const MAX_EVENTS_PER_REQUEST = 20;

// UA cannot tell an iOS standalone PWA from iOS Safari, so the client sends a `standalone` boolean hint and
// we map ios + standalone -> pwa. A hint is not identity, so trusting it is fine; missing it only loses the
// PWA split. Everything else about platform stays server-derived (§13 rule 2).
export function platformFrom(ua: string | undefined, standalone: boolean): string {
  const s = (ua ?? '').toLowerCase();
  if (/iphone|ipad|ipod/.test(s)) return standalone ? 'pwa' : 'ios';
  if (/android/.test(s)) return standalone ? 'pwa' : 'android';
  return standalone ? 'pwa' : 'desktop';
}
