# PIPS Haptics

Research + implementation plan for the `web-haptics` adoption, the low/mid/high level system, and the
bugs found along the way. Source of truth for anything haptics in `web/`.

Status, 2026-08-14: **most of this shipped.** Committed on the `haptics` branch: the `web-haptics` engine
swap behind the same `haptic()` facade, the three-class scheduler (press / detent / outcome) in
`src/lib/haptics.ts`, the low/mid/high re-grade across §6 and §6.4, the coalescing detent scheduler (§6.5),
the four outcome patterns (§6.6), every bug B1 through B14 including the two non-haptic ones (B3 referral,
B4 clipboard), the `DialTeleportSwitch` that gives both dials per-detent ticks on iPhone (`9f1d887`), the
`/dev/haptics` probe page at 12 sections (`166f1f0`), the dev dial readout removal (`676b0c7`), and, most
recently, the dial end-stop split (`c2b4877`: the knob keeps ticking past its end, the stake drum goes
silent at its stop). `src/lib/haptics.test.ts` and `src/lib/referral.test.ts` cover the scheduler and the
origin fix.

**Uncommitted, 17 paths in the working tree.** The iOS beat scheduler is **not** committed:
`src/lib/iosBeats.ts` and `src/lib/iosBeatsDebug.ts` are untracked and have never been committed. Nor are
`/dev/haptics` sections 13, 14 and 15 (the stationary-hold, long-hold and shipped-scheduler probes); the
committed page stops at 12. Neither is the whole win/lose/achievement delivery path: the fan-out in
`src/lib/haptics.ts`, its registration in `routes/_app.tsx`, and the call sites in `lucky.tsx`,
`moonshot.tsx`, `flappy-piper.tsx`, `line-rider.tsx`, `AchievementCelebration.tsx`,
`ChipGrantCelebration.tsx`, `DepositLanded.tsx`, `ActivePlayChip.tsx`, `HapticOverlay.tsx` and
`game/gamePanels.tsx`. Plus this file and the unrelated `web/src/admin/DESIGN.md`.

**Known gap in that uncommitted state:** the wiring that made the five console button overlays into iOS
beat surfaces (`attachBeatSurface` in `ConsoleCanvas.tsx`) was lost from the working tree during a git
operation on 2026-08-10 and is not present; a recovery copy sits at
`~/Documents/pips-recovery/ConsoleCanvas.with-beat-surfaces.tsx`. It matters because the PLAY button is the
main surface a resting thumb sits on, so without it an iOS outcome rhythm can only reach the user through
the two dials.

So read this document as two things at once: a research record, and the spec of what now runs. Where a
section is a plan that has since been executed, it says so inline. Where a section was **wrong**, §0 lists
it, because on-device testing and WebKit source reading overturned several of its central claims after it
was written.

---

## 0. What this document got wrong

Each line is a claim this file makes elsewhere, what is actually true, and the one piece of evidence that
settled it. Detail for the iOS half lives in §3.5.

1. **"Research done, nothing implemented yet."** Superseded by the Status block above. Almost all of it
   shipped.
2. **"The knob and number wheel are architecturally silent on iOS, full stop"** (§3 truth table, §3 prose).
   **False since `DialTeleportSwitch` shipped.** Both dials tick per detent on iPhone through a real
   teleported `<input switch>` under the finger. Evidence: `SwitchTrigger::PointerTracking` is deliberately
   ungated (WebKit commit `dfb3971bb0d9`, whose own message exempts it), confirmed on device as probe 9d,
   and running in `ConsoleCanvas.tsx`.
3. **"Outcome haptics are the one part of this project that lands on every device we ship to"** (§6.6).
   **False.** They fire automatically on **Android only**. On iOS they need a finger already on the glass.
   Evidence: `performSwitchVisuallyOnAnimation` returns early unless `processingUserGesture()` is true, and
   every PIPS outcome arrives with no gesture token (SSE settle, cash-out at +1100ms, achievement at
   +1400ms), all outside WebKit's 1s forwarding window.
4. **"A switch toggles once per gesture, at the tail, not per unit of travel," so the drag strip is
   probably dead** (§8, iOS on the wheel). **False.** `updateIsSwitchVisuallyOnFromAbsoluteLocation` fires
   a haptic on **every** flip-line crossing with no cap, no debounce and no minimum interval
   (`CheckboxInputType.cpp:471-498`). That is the mechanism the shipped dial ticks ride.
5. **Phase 0.5 results 1 and 2 called "an unresolved contradiction, irrelevant either way"** (§7).
   **Resolved.** `label.click()` laundered trust into the control pre-26.5 because
   `Element::dispatchSimulatedClick` set `SimulatedClickSource::UserAgent` unconditionally; `input.click()`
   never did, because `HTMLElement::click()` hardcodes `SimulatedClickSource::Bindings`. Both observations
   were correct and both are explained.
6. **"An iOS tick needs a moving finger, so hold-to-collect cannot work."** Not stated in this file, but it
   is the assumption behind every iOS conclusion in it, and it is **false**. A deliberately still finger
   delivers touchmoves at 5.9/sec at 2.8px of total displacement, enough to clock a full 4-beat rhythm.
   "Hold through the buzzer" is a real design, and it is why an outcome can reach an iPhone at all.
7. **"Duration maps to iOS click count, roughly one per 16ms, so one rule serves both platforms"** (§6.6's
   encoding rule). **Half wrong.** Full-intensity pulses are right on Android and the **worst** choice on
   iOS: 16ms spacing is below the vibrotactile gap-detection threshold and fuses into one felt buzz. iOS
   spacing floors at 80ms and wants 100-120ms. iOS rhythms are authored separately, in `iosBeatOffsets()`.
8. **§10 q1, which dial Kelvin meant by "the bet wheel."** **Answered on 2026-08-14: the small stake
   drum** (`kind: 'numberWheel'`), confirmed against `ConsoleCanvas.tsx:53`'s own comment, not by name
   alone. It is the dial that keeps its end stop; the knob was unclamped.

---

## 1. The one-paragraph verdict

**History. This is the call that was made, and it is what shipped.** Option A below was taken: the facade
stayed, the engine became `web-haptics`, every call is gated on `isSupported`, and the library never owns
the iOS path. Read §1 and §1.5 as the reasoning, not as pending work.

The repo already has a working haptics layer (`src/lib/haptics.ts`, `HapticOverlay`, and real
`<input switch>` overlays on the console buttons). It is not missing, it is **undifferentiated**: 71 of
the 154 call sites fire the same 8ms `selection` pulse, and the scroll wheel's detent is 4ms, below the
perceptible threshold on most Android motors. So we do not need to rip anything out. We should keep our
`haptic(preset)` facade and swap its **engine** to `web-haptics` to get real intensity control, then
re-grade every call site onto Kelvin's three levels and fix the wheel's sound/haptic desync. Adopting
`useWebHaptics()` per component would be a downgrade: it spawns one DOM element per instance and its iOS
path was patched dead by Apple in iOS 26.5, while our existing overlay technique still works.

**Three things to know before reading further.** The engine swap is **not** behaviour-neutral, because the
library PWM-expands at a default intensity of 0.5 (§7 Phase 1). The clock needs **three** priorities, not
two, or button presses get swallowed (§6.5). And this plan is **compatible with the repo's architecture
and design language**, but §6 and §6.6 are vocabulary we are authoring rather than doctrine we are
following, because the canonical design docs are absent from this checkout (§9.5).

---

## 1.5. We already tried this library and removed it

**`web-haptics` was in this repo and Kelvin took it out on 2026-07-13** (`57c27d2`). The current
hand-rolled table is its replacement. The old code:

```ts
// Presets come from web-haptics: selection (knob detents), medium/rigid
// (button press), success/buzz (a win), error/warning (a loss).
import { WebHaptics } from 'web-haptics'

let instance: WebHaptics | null = null
function get(): WebHaptics | null {
  if (typeof window === 'undefined') return null
  if (!instance) instance = new WebHaptics({ showSwitch: false })
  return instance
}
export function haptic(input: HapticInput = 'selection') {
  if (!enabled) return
  void get()?.trigger(input)
}
```

The singleton was right. The problem is `showSwitch: false`, which is the option that makes the library
set `display: none` on its switch and label. So on iOS that integration was almost certainly injecting a
dead DOM node and running rAF click loops for nothing, and on Android it was doing what raw `vibrate`
already does. It would have felt like the library did nothing, which is consistent with it being replaced
six days later by a 27-line table.

**One correction to why, since this file blamed the wrong thing.** The claim was "a non-rendered switch is
the one thing that reliably does not fire the tick." That is only true for a **touch**: `display: none`
leaves no renderer, so `handleTouchEvent` early-returns before it can arm anything. It is false for the
programmatic path the library actually used, which never reads the renderer at all, and Phase 0.5 result 1
duly ticked a `display: none` label on device. What made that integration useless on iOS is the trust and
gesture gating in §3.5, not the CSS. `appearance: none` is different again and is harmless: it kills the
visual switch animation, but `performSwitchAnimation` bails **before** the haptic block in its caller, so
the tick survives. That is why B6.5's on-device result came back "both ticked."

**Nobody diagnosed that at the time.** The commit message does not mention a reason, and the replacement
header talks only about the iOS 26.5 closure. So the removal was a reasonable reaction to a real symptom
with the wrong root cause attached.

Kelvin's ask now is to go back to it ("revamp balik pake si web-haptics itu nanti"). That is fine, but
**re-adding it unchanged reproduces the exact failure**. What the library genuinely buys us over today's
code is one thing: the PWM intensity axis, which is what makes low/mid/high possible on Android. Its iOS
path is worse than what this repo already invented. So either:

- **A. Re-adopt it, corrected.** Module singleton, gate every call on `WebHaptics.isSupported`, never let
  it own the iOS path. Matches Kelvin's request. Costs one dependency and the discipline of that gate.
- **B. Port the 10 lines that matter.** The PWM function (`duration` + `intensity` to a vibrate array) is
  trivial and self-contained. Keeps `haptics.ts` at zero deps and zero DOM.

**A is not just what Kelvin asked for, it is what the repo's own doctrine says.** `web/CLAUDE.md:19`:

> "Use `web-haptics` for tactile feedback."

That line is not stale. `git log -L 19,19` shows it was last rewritten on **2026-07-27** (`3ec9410`), two
weeks *after* the dependency was deleted on 2026-07-13. Someone rewrote the paragraph around it and kept
the mandate. So `main` is currently in violation of its own documentation, and re-adopting the library
fixes that rather than causing it.

Which means **B is not free**: porting the PWM function would leave the code contradicting
`web/CLAUDE.md:19`, so it requires editing that line in the same PR. Keep B as the escape hatch if the
probe shows the library fighting us, but pick it deliberately and with the doc edit, not casually.

**Do not pick A without the `isSupported` gate.**

One correction to the history above: the removal was **two** commits, not one. `57c27d2` (19:27) dropped
the import; `d7af310` (21:12, "feat: commint and fix audio issue") dropped the dependency from
`package.json`. Reverting by the first hash alone gives you an import with no package.

## 2. The library

**`web-haptics@0.0.6`** by Lochie Axon. MIT, zero deps. Demo: https://haptics.lochie.me,
source: https://github.com/lochie/web-haptics. Installed into `web/package.json`.

Verified by reading `node_modules/web-haptics/dist`, not just the docs.

### API

```ts
import { WebHaptics, defaultPatterns } from 'web-haptics'

const h = new WebHaptics({ debug: false, showSwitch: false })
h.trigger('medium')                          // preset name
h.trigger(25)                                // raw ms
h.trigger([{ duration: 12, intensity: 1 }])  // Vibration[]
h.trigger('heavy', { intensity: 0.6 })       // override
h.cancel()
h.destroy()
WebHaptics.isSupported                       // static: typeof navigator.vibrate === 'function'
```

`useWebHaptics(options)` from `web-haptics/react` returns `{ trigger, cancel, isSupported }` and
constructs one `WebHaptics` per mounted component in a `useEffect`.

### Built-in presets (exact, from source)

| name | pattern |
|---|---|
| `light` | 15ms @ 0.4 |
| `medium` | 25ms @ 0.7 |
| `heavy` | 35ms @ 1.0 |
| `soft` | 40ms @ 0.5 |
| `rigid` | 10ms @ 1.0 |
| `selection` | 8ms @ 0.3 |
| `success` | 30ms @ 0.5, +60ms gap, 40ms @ 1.0 |
| `warning` | 40ms @ 0.8, +100ms gap, 40ms @ 0.6 |
| `error` | 3x 40ms @ 0.9, 40ms gaps |
| `nudge` | 80ms @ 0.8, +80ms gap, 50ms @ 0.3 |
| `buzz` | 1000ms @ 1.0 |

### What "intensity" actually is

The Vibration API has no amplitude control. web-haptics fakes it with **PWM**: it chops a duration into
20ms frames with an on/off duty cycle equal to the intensity, then hands the array to
`navigator.vibrate`. `{duration: 18, intensity: 0.75}` becomes `vibrate([14, 4])`.

This is worth having (it is a real, tunable strength axis we do not have today), but be honest about it:
on a cheap ERM motor a chopped pulse mostly reads as a **shorter** pulse, not a softer one. On an LRA
(most modern phones) the difference is genuinely felt. Calibrate on the actual device, do not trust the
numbers.

### Two behaviours that decide how we integrate it

1. **It injects DOM and burns rAF when `isSupported` is false.** `trigger()` runs the vibrate path when
   supported, and *additionally* runs a `requestAnimationFrame` loop clicking a hidden `<label>` when
   `!isSupported || debug`. On iOS (never supported) every single `haptic()` call would append a label to
   `document.body` and spin a rAF pattern loop that, post iOS 26.5, does nothing at all. **We must gate
   every call on `WebHaptics.isSupported` ourselves.**
2. **One instance per app, not per component.** Each `new WebHaptics()` takes a new `instanceId` and can
   create its own label element. The React hook constructs one per component. With 154 call sites that is
   absurd. Module-level singleton in `lib/haptics.ts`.

---

## 3. Platform truth (this is the part that changes the plan)

**iOS Safari has never implemented `navigator.vibrate`, in any version through 26.5.** The only web access
to the Taptic engine is Apple's native switch control (`<input type="checkbox" switch>`, Safari 17.4+).

**Apple patched the programmatic path in iOS 26.5.** Calling `.click()` on a `<label for>` bound to a
switch no longer fires the Taptic engine. It worked from iOS 18 (when the switch haptic landed) to 26.4. That is exactly the mechanism
`web-haptics` uses for its iOS fallback, so **the library's iOS support is dead on current iOS**.

What still works after the patch: a **genuine physical finger tap on a real switch element**. Confirmed
on-device by [project-fathom](https://github.com/m1ckc3s/project-fathom) against iOS 26.5.

This repo already does the surviving thing, and already knew about the patch. `ConsoleCanvas.tsx:135`
says it outright ("never script-triggered, closed in 26.5"), and `:3746-3777` renders a real
`<input type="checkbox" switch>` per physical button, positioned over its projected on-screen rect, as the
actual touch target. That code is correct and must not be replaced by the library.

### The dev phone is on iOS 26.3, and that is a trap

Our test iPhone is **26.3**, which is inside the 17.4-26.4 window where the programmatic trick still
works. Three consequences, in order of how much they can hurt:

1. **Do not tune the feel on it.** Anything that feels right on 26.3 through the programmatic path is
   **completely absent** for a user on 26.5+. Tuning there optimises for a shrinking population and hides
   the real result. Sign-off happens on Android, and ideally on one 26.5 device to confirm what survives.
2. **iOS has no strength axis at all.** The Taptic tick from a switch is a fixed system sound, so
   low/mid/high cannot exist there. web-haptics maps `intensity` to the *repeat rate* of the clicks
   (`16 + (1 - intensity) * 184` ms), not to strength. Working it through the source, every short preset
   collapses to **exactly one identical tick**: `selection`, `light`, `medium` and `rigid` are
   indistinguishable on iOS. **The three-level system is an Android feature.**
   ~~Only `heavy` (35ms at full intensity, so ~3 clicks) and the multi-pulse patterns feel different.~~
   **Corrected 2026-08-09: `heavy` is not different either.** At `intensity: 1` the repeat rate is 16ms,
   which is below the gap-detection threshold, so its ~3 clicks fuse into one buzz that feels the same as
   a single tick. The only usable axis on iOS is **spacing**, floored at 80ms (§3.5), which means a
   multi-pulse pattern authored for Android does not automatically read as one on iPhone.
3. **The console buttons would double-fire.** They already get a real tick from the genuine tap on their
   switch overlay (`onChange` at `:3764`). If `haptic()` also starts firing a programmatic click on iOS,
   those five buttons buzz twice. Whatever we enable has to exclude them.

~~Before any of this, run the probe (see Phase 0.5).~~ **Run, on iPhone iOS 26.3, results in Phase 0.5
below.** The `display: none` vs rendered split looked contradictory at the time and is now explained by
the two trust paths in §3.5, but it never mattered for the product either way: `lib/haptics.ts` never
constructs a `WebHaptics` instance when `WebHaptics.isSupported` is false, which is always true on iOS, so
neither code path runs in the shipped app. What was confirmed and does matter: a genuine physical tap on
the real console switches ticks, with or without `appearance: auto`, and a genuine **drag** ticks
repeatedly, which is what the dials now ride.

### Truth table

Corrected 2026-08-09 to 08-14. The last two rows are the ones that changed: `DialTeleportSwitch` shipped,
and outcome patterns turned out to be Android-automatic rather than universal.

| | Android Chrome (http LAN) | Android (https) | iOS Safari <= 26.4 | iOS Safari >= 26.5 |
|---|---|---|---|---|
| `navigator.vibrate` | works | works | never | never |
| Console buttons (real switch, real tap) | n/a, vibrate covers it | n/a | **confirmed on-device, 26.3** | works |
| Programmatic switch click (web-haptics iOS path) | n/a | n/a | works | **dead** |
| App-surface buttons (`HapticOverlay`, plain button) | works | works | one tick per real tap | one tick per real tap |
| Knob / stake drum, per detent | works | works | **works** via `DialTeleportSwitch` | **works**, same path |
| Outcome pattern with no finger on the glass | works | works | **silent** | **silent** |
| Outcome pattern with a thumb resting on an armed surface | works | works | **works**, quantised (§3.5) | **works**, same path |

**Consequence: strength QA must still happen on Android.** iOS has no intensity axis and no duration axis,
so low/mid/high cannot be judged there at all; only rhythm and spacing can. That part is Apple, and it is
not a bug we can fix.

**What the user reported as "the scroll wheel still has no effect" and "the placed bet scroll still
doesn't trigger" was correct at the time, and is now fixed on both platforms.** `hapticDetent()` was
already wired into both dials (§7 Phase 3, `ConsoleCanvas.tsx`), which covered Android. The iPhone was
silent because the dials are raycast-picked Three.js meshes with no DOM element under the finger, so there
was neither a `navigator.vibrate` to call nor a `switch` for WebKit to tick.

**That is no longer true.** Each dial now additionally mounts a real, invisible `<input type="checkbox"
switch>` in its pocket on iOS (`DialTeleportSwitch`), and the scheduler teleports that element
`translateX(±10000px)` on each detent crossing so WebKit recomputes its flip line and fires a native tick,
once per crossing. The tick, the roller sound and the value all read the same counter
(`numberWheelStepAt` / `knobStepAt`), so they cannot disagree. Both dials tick per detent on iPhone today,
including on 26.5+, because `PointerTracking` is the one path Apple left ungated.

**The one asymmetry to know about, shipped 2026-08-14 as `c2b4877`:** the knob's counter is unclamped and
keeps ticking past the end of the bound range, while the stake drum's is clamped and goes silent at its
stop. That is not an oversight. The drum is rubber-banded and saturates at ±0.28 step, so past its limit
it already looks stopped, and a stopped drum should not click forever; the knob's offset is visually
unbounded and keeps spinning, so it should. iOS has no intensity or duration axis, so a distinct "heavier
end-stop bump" is not expressible there anyway, which is why plain silence beats a special one.

---

## 3.5. The iOS mechanism, as read from WebKit and measured on the phone

Added 2026-08-09 to 08-14, after §3 was written. This is the part of the document that stands alone: the
sources are WebKit `@main` and `@safari-7624-branch` (the branch Safari 26.x ships from, diffed, and the
touch and haptic paths are byte-identical), plus measurements taken on the iPhone at Safari 26.3 through
`/dev/haptics`.

### The two gates, and why an outcome cannot buzz by itself

WebKit exposes exactly one haptic: `performSwitchHapticFeedback()`, a single
`UIImpactFeedbackGenerator(.light)`, reached only from `CheckboxInputType::performSwitchVisuallyOnAnimation`.
Two commits guard it.

- **`dfb3971bb0d9`, 2025-01-03.** Adds
  `if (trigger == SwitchTrigger::Click && !UserGestureIndicator::processingUserGesture()) return;`, with
  the commit message "It should not be possible to generate haptic feedback from script alone." Present on
  every device we will ever see, including the 26.3 dev phone.
- **`fc1ef83eae10`, 2026-05-20, ships in iOS 26.5.** Makes `Element::dispatchSimulatedClick` derive its
  source from the underlying event instead of hardcoding `UserAgent`, which kills the `label.click()` trust
  laundering `web-haptics` relies on. Trust is decided before the gesture check runs, so on 26.5+ no
  timing, delay or continuation matters at all.

**`SwitchTrigger::PointerTracking` is exempt from both**, deliberately, and the first commit says so in as
many words. That is the whole reason anything works on a current iPhone.

The gesture token does forward into async continuations, further than earlier drafts assumed, and it still
does not help: `setTimeout`, `requestAnimationFrame`, `postMessage` and the `fetch()` response promise all
carry it, but `maximumIntervalForUserGestureForwarding` is **1 second measured from the original tap and
never reset**, so every click of a pattern must land inside `[tap, tap + 1000ms)`. The fetch path gets 10s
to fire its own synchronous click, and anything it then schedules is back on the 1s clock. SSE, WebSocket,
MessagePort, service workers and Web Animations forward nothing at all.

Measure our own outcome sites against that and every one is outside the window: Lucky and Moonshot expiry
land on an SSE frame, cash-out is a network hop plus `setTimeout(1100)`, Range settles off the price
stream, achievement is `setTimeout(1400)`. **So enabling the library's iOS fallback would buzz in
`/dev/haptics` and stay dead on a real win, even on the 26.3 phone. Do not demo it as working.**

### A tap can never carry a rhythm. Hard ceiling: one tick

`switchHeldDelay = 200ms` is a function-local `constexpr` at `CheckboxInputType.cpp:202` with no Settings
key, no preference, no `RenderTheme` hook and no feature flag. It is a one-shot timer started at touchstart
and **stopped by touchend and touchcancel**, and any touchmove before it fires early-returns at
`if (!isSwitchPointerTracking()) return;`. Median smartphone tap dwell is ~80-120ms, so a normal tap never
reaches `PointerTracking`. A zero-flip gesture then fires exactly one `SwitchTrigger::Click` tick at lift.

**One tap = one tick, on every element, with no way to get two from one finger.** A strip of switches does
not help either: only the touchstart target receives subsequent touchmoves. Two corollaries worth keeping:
the tick fires once per **lift**, not per tap, so N fingers on the same switch lifted one at a time give N
ticks; and two *different* switches arm independently, because all switch state is per-element and the
touchstart guard reads `targetTouches`.

Consequence for Flappy Piper specifically: its crash **cannot** carry a rhythm under tap controls. The
death fall is 0.5-0.9s of no contact and PLAY AGAIN is another ~100ms tap, so the pended schedule expires
undelivered every time. Not fixable with better timing or a different element. The exits all change what
the finger does (hold to restart is the cheapest), or accept the free lift tick.

### A stationary resting finger DOES deliver touchmoves (measured 2026-08-09)

This is the finding that made outcome haptics reachable on iPhone at all. The teleport removes the need for
finger **travel**, but not for touchmove **events**: the flip is only evaluated inside
`updateIsSwitchVisuallyOnFromAbsoluteLocation`, called from the touchmove branch. Writing a transform from
JS calls nothing, it only changes what the next touchmove computes. Whether a still finger generates any
was unknowable from source, since iOS touch dispatch lives in closed `WebKitAdditions`.

`/dev/haptics` Section 13, "beat clock" mode, a deliberate hold-still:

| reading | value |
|---|---|
| elapsed | 1695ms |
| touchmoves | 10 |
| moves / sec | **5.9** |
| max displacement | **2.8px**, i.e. genuinely still |
| **beats fired** | **4 of 4** |

Natural fingertip tremor alone is enough. A prior prediction that ">= 10 moves/sec" would be needed was
wrong: what matters is only that moves keep arriving, because a late move still fires its beat.

Section 14 then held for 30 seconds with a schedule armed at t=25s, twice: 1756 and 1731 moves, flat at
~58/sec across all 15 buckets, **4 of 4 beats both times**. So there is no rate decay, no throttle and no
WebKit give-up over a full trading-round timescale. Read it honestly though: both runs had 109-176px of
displacement, so the finger was moving and 58/sec is just the 60Hz ceiling. Tremor-only sustained over 25s
is still unmeasured.

### The rhythm quantises to the touchmove rate, and 16ms fuses

Two spacing rules, and they bind everything authored for iOS.

- **Quantisation.** Beats fire on the first touchmove at or after their scheduled time, so at 5.9 moves/sec
  the granularity is ~170ms: an authored 0/110/220/330ms lands at roughly 0/170/340/510ms. Beats are never
  dropped, the pattern just plays slower and less precisely than written. **Do not author iOS spacing
  tighter than ~170ms and expect it to survive.** Treat authored onsets as a lower bound.
- **Fusion.** Each click is a fresh `UIImpactFeedbackGenerator`, no `prepare()`, deallocated immediately,
  delivered by async IPC, with no throttle, dedupe or coalescing anywhere in WebKit. Pulses **16ms** apart
  are below the ~15-20ms vibrotactile gap-detection threshold and inside a Light impact's own ring-down, so
  they fuse into one felt buzz. Minimum 80ms between felt pulses, target 100-120ms, 3 pulses and 4 at a
  push.

Which is why §6.6's "weight in duration, full intensity" rule is Android-only. Under it the shipped
`success` preset ends in a 40ms phase at intensity 1, three clicks 16ms apart, perceived as **two** events
and not four. iOS beats are authored separately, through `iosBeatOffsets()`.

### Two footguns in the shipped code

- **`preventDefault()` on any touch event kills the switch entirely, tick included.** `handleTouchEvent` is
  reached only as a default handler, and `EventDispatcher` skips the whole default-handler phase once
  anything upstream has prevented the event. Every touch listener on a beat surface is `{ passive: true }`
  for exactly this reason. One non-passive `preventDefault` anywhere in the path silently deletes every iOS
  haptic in the app.
- **A finished schedule must un-park its transform.** The teleport works by moving the element so the
  finger's side of the flip line changes. Left parked at ±10000px, the finger is permanently on one side,
  WebKit's flip evaluation pins the switch, and **no further ticks occur for the rest of that touch**,
  including the ordinary native flips from real travel. The dials self-heal because detent mode steps
  again on the next crossing; a plain button overlay does not. `iosBeats.ts` resets to a small same-signed
  offset (`PARK_RESET_PX`) rather than to 0, which cannot introduce a stray crossing on the way back.

### Native is not the escape hatch, for the case people picture

Costed and rejected 2026-08-10. **Even a native iOS binary cannot buzz while backgrounded or with the
screen locked.** Core Haptics fires with no touch only while the app is foreground-active:
`CHHapticEngine.StoppedReason` includes `.applicationSuspended`, and Apple states that
`UIFeedbackGenerator` "will not produce haptics when your app is not in the foreground active state", by
design, so a buzz is always attributable to the visible app. No entitlement, no background mode and no
silent push changes that. The "phone face-down on the table buzzes" image is impossible on iOS, on web and
native alike.

What native would genuinely fix is narrower: the player holding the phone, watching the chart, with **no
thumb on the glass**. Our web path needs the thumb resting on a button or a dial. That is the entire
delta. It is still a no, because the App Store gate is closed to PIPS for reasons unrelated to haptics
(guideline 3.1.5(iv) on crypto-futures and quasi-securities, 5.3.4 on real-money gaming, 3.1.5(i) org
enrollment for a wallet app), so the ceiling is TestFlight, invite-only, with builds expiring every 90
days, for 7-11 engineering days plus a permanent second build target.

---

## 4. What already exists

| File | Role |
|---|---|
| `src/lib/haptics.ts` | The facade. `haptic(preset)` + `setHapticsEnabled()`. 8 presets, raw ms map, `navigator.vibrate` only. |
| `src/components/HapticOverlay.tsx` | Invisible click layer over app-surface tap targets. Fires `haptic()` + `uiSfx()`. Deliberately a plain `<button>`, not a switch, because a switch toggles mid-scroll and mis-fires (see commits `273d9f0`, `59a02c2`). |
| `src/components/console/ConsoleCanvas.tsx:3746` | Five real `<input switch>` overlays over the physical buttons. The only iOS haptic path in the app. |
| `src/ui/Hardware3D.tsx` | `Hw3DButton` / `Hw3DIconButton` / `Hw3DToggle` / fader. Already call `haptic()` on every press. This is the file Kelvin named for the menu-drawer work. |
| `src/routes/_app/menu/settings.tsx` | The user-facing Haptics toggle, persisted through `/settings`, drives `setHapticsEnabled()`. |
| `src/lib/uiSfx.ts` | The app-surface sound bus that haptics should pair with. |

**Two rows in that table are now history, since this is a snapshot of the tree before any of the work
landed.** `haptics.ts` is no longer "8 presets and `navigator.vibrate` only": it is the `web-haptics`
engine behind a three-class scheduler, plus `iosBeatOffsets()` and the `registerPatternSink` seam. And the
five console overlays are no longer "the only iOS haptic path in the app": `iosBeats.ts` now clocks
outcome rhythms on any attached surface, `DialTeleportSwitch` ticks both dials per detent, and
`HapticOverlay` adds a `switch` attribute imperatively on a qualified tap so an app-surface target can
tick at all. Files added since: `src/lib/iosBeats.ts`, `src/lib/iosBeatsDebug.ts`,
`src/routes/dev/haptics.tsx`, `src/lib/haptics.test.ts`.

Current usage, and the reason Kelvin is asking for levels:

Counted as literal `haptic('x')` calls, which total exactly 154:

| preset | ms | calls | + declarative props |
|---|---|---|---|
| `selection` | 8 | 71 | 24 |
| `rigid` | 10 | 25 | 12 |
| `success` | [30,60,40] | 23 | 1 |
| `error` | 5x40 | 17 | 0 |
| `medium` | 25 | 9 | 12 |
| `tick` | 4 | 5 | 0 |
| `heavy` | 35 | 3 | 0 |
| `warning` | [40,100,40] | 1 | 0 |
| **total** | | **154** | **48** |

The second column is the `preset=` / `haptic=` props on `HapticOverlay` and `Hw3DButton`, which resolve to
the same presets at runtime. Keep the two columns separate: an earlier draft of this file mixed them and
produced a table that summed to 186 while claiming 154.

`selection` is 46% of all calls and, with props, 95 of 202 total invocations. There is no low/mid/high
here, just one weight doing most of the work plus a few outcome patterns.

---

## 5. Bugs found

**All of B1 through B14 are fixed and committed**, including the two that are not haptics at all (B3
referral, B4 clipboard). Every entry below describes the bug as it was found, plus the reasoning behind
the fix, because that reasoning is the part worth keeping. Where a fix later changed shape (B3's origin
helper, B6.5's appearance rule, B14's reach into the dials), the entry says so inline.

### B1. Scroll wheel: the haptic does not follow the tick sound (the headline bug)

`ConsoleCanvas.tsx:2854` (number wheel) and `:2902` (knob).

```ts
if (steps !== numberWheelLastStep) {
  haptic('tick')                       // once per pointermove event
  const direction = Math.sign(steps - numberWheelLastStep)
  for (let detent = ...; detent !== steps + direction; detent += direction) {
    audio.playSfx('roller', 'thumbwheel')   // once per detent crossed
    ...
  }
}
```

The sound is inside the loop, the haptic is outside it. Cross three detents in one frame and you get three
tick sounds and one pulse. Kelvin's ask is literally "tiap suara tick bakal haptic juga", so this is the
exact defect.

**Why the naive fix does not work:** `navigator.vibrate()` halts any in-flight pattern
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/vibrate)). Moving `haptic('tick')` inside
the loop fires N synchronous vibrates that cancel each other down to one, which is what we already have.

**The fix:** coalesce. Emit one `vibrate([on, gap, on, gap, ...])` per frame with one on/off pair per
detent crossed, and do not issue a new call until the previous pattern's duration has elapsed (bank any
detents crossed meanwhile). Sensitivity is 28px per detent on the number wheel and 40px on the knob
(`snapInterval: 20` / `dragSensitivity: 0.5`), so a fast flick is 1-3 detents per frame. The pattern stays
short and the bank rarely fills.

**What we are syncing to:** `consoleAudio.playSfx()` has **no throttle at all**, no min-gap, no `lastAt`
map, no dedupe. Every detent allocates a fresh `BufferSource` and calls `src.start()` with no offset, so
it plays immediately from sample 0. (This is deliberate and differs from `uiSfx.ts`, which does have a
40ms min-gap and an onset skip.) So the audio is a faithful one-sample-per-detent stream with no rate
limit, and the haptic is the side that has to be capped. Perfect 1:1 is not reachable at flick speed, see
the physical limits below.

**Physical limits, which decide the cap.** An LRA (most modern phones) starts and stops in about 5ms; an
ERM has a rise time of **80-100ms**. A crisp click is 10-20ms of drive, and the actuator then rings for
another 20-50ms after the drive ends. Latency under 40ms reads as instantaneous, over 70ms reads as lag.
So per-detent ticks are effectively an **LRA-only** feature, and the felt ceiling is about **28 pulses per
second**. Past that, queueing one pulse per detent walks the haptic further behind the finger every frame.
Cap and drop, never bank.

See section 6.5 for the design that falls out of this.

### B2. The detent pulse is below the perceptible threshold

`tick: 4` ms in `lib/haptics.ts:6`. Android's own haptics guidance puts a crisp impulse at roughly
10-20ms, and a 4ms command barely spins an ERM motor up. This is very likely why the wheel feels dead
rather than satisfying, and why the previous revamp attempt failed. Kelvin wants the wheel at HIGH.

### B3. Referral link ships as `http://localhost:3200`

`src/lib/referral.ts:43`:

```ts
const base = env.VITE_APP_URL ?? window.location.origin
```

`VITE_APP_URL` is a `import.meta.env` value, so Vite **inlines it at build time**. `.env.example:11`
(committed) ships `VITE_APP_URL="http://localhost:3200"`, and whoever provisioned Vercel by pasting the
example froze localhost into the production bundle for every user. `env.ts:45` validates it as
`z.string().url()`, and a loopback URL is perfectly valid, so nothing complains.

The `??` ordering is also backwards for a share link: a stale build constant should never beat the origin
the user is actually on.

Corroborating tell: `menu/referrals.tsx:264,271` hardcodes `playpips.fun/r/CODE` in the "Link format"
modal, so that screen contradicts its own copy pill.

**Fix:** reject loopback, keep env first (a Vercel preview deploy is the one legitimate reason the var
exists), guard `window` for SSR, fall back to the `SITE_URL` const that `__root.tsx:23` already owns.

```ts
const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i

function publicOrigin(): string {
  const configured = env.VITE_APP_URL?.replace(/\/+$/, '')
  if (configured && !LOOPBACK.test(configured)) return configured
  if (typeof window !== 'undefined' && !LOOPBACK.test(window.location.origin)) return window.location.origin
  return SITE_URL
}
```

**One behaviour change to state up front:** because loopback is rejected in *both* branches, a developer
running on `localhost` now gets referral links pointing at `https://playpips.fun` rather than at their dev
server. That is right for a link you share and wrong for testing the `/r/$code` route locally. If local
testing matters more, drop the second loopback check and guard only `typeof window`. Decide it
deliberately, or the first person to test a referral link locally files a bug.

Plus: export `SITE_URL` from `__root.tsx` (or lift it to `config.ts`) so the domain is stated once, and fix
`.env.example:11` so the next person does not re-import the bug. **Operational step:** correct or delete
`VITE_APP_URL` in the Vercel dashboard and redeploy. Because the value is inlined at build time, a
redeploy of the existing build still serves localhost.

This is the only place in `web/` that builds an absolute URL this way. `og:url`, `canonical`, and the PWA
manifest were all checked and are correct.

**What shipped is the inverse ordering of the proposal above, deliberately.** `referral.ts` now exports
`shareOrigin()` (plus `shareHost()` for the compact hints), and the **browser's own origin wins**, with
`env.VITE_APP_URL` then `SITE_URL` covering only SSR, where there is no window to ask. A `www.` prefix is
normalized off. That kills the localhost-in-production bug at the root, since a stale build constant can
no longer beat the origin the user is actually on, and it drops the awkward behaviour change flagged
above: a developer on `localhost` gets localhost links again, which is what you want when testing
`/r/$code`. Covered by `src/lib/referral.test.ts`.

### B4. Copy-to-clipboard fails silently, and still buzzes success

`src/routes/_app/menu/transactions.tsx:195-201`:

```ts
void navigator.clipboard
  ?.writeText(value)
  .then(() => toast.success(`${label} copied`))
  .catch(() => {})
```

On an insecure origin `navigator.clipboard` is `undefined`, so the optional chain short-circuits the whole
expression: no promise, no `.catch`, no toast, nothing. The line above it fires `haptic('success')`
regardless, so the phone confirms a copy that never happened. The other six copy sites do surface an error
toast. This bites on any LAN-IP test session and on any non-HTTPS context.

### B5. Customize fires haptics where Kelvin says it should not

Kelvin: preset cards and Done only. Today `CustomizeStudio.tsx` also fires on colour swatches (`:124`),
the tab strip (`:491`), and the Share button (`:243`).

Related mismatch on the card itself: `ThemeRail` only plays `uiSfx('swipe')` when the tapped id actually
changes (`:346`), but `pickPreset` fires `haptic()` on every tap including a re-tap of the already active
card. Sound and haptic disagree. Match the sound's condition.

**Superseded 2026-08-08.** The user tested on-device and reversed this: every interactive control in the
studio (preset cards, tab strip, colour swatches, Done, the X/close button, Share) now gets a tap haptic,
uniformly graded `mid` (Done keeps `success`, its own distinct completion signal). The narrower rule above
and the table in §6 are history, not the live spec. All six are routed through `HapticOverlay` in
`CustomizeStudio.tsx`, silent wherever the handler already calls `haptic()` itself (preset cards, Done).

### B6. Two shared primitives have sound but no haptic

`src/ui/Button.tsx:30-37` and `src/ui/Switch.tsx:22-25` both call `uiSfx()` and neither calls `haptic()`.
Every other primitive pairs them. Small blast radius today (`ui/Button` backs the `ScreenError` retry in
`components/menu/shared.tsx:137`, `ui/Switch` has only a `/dev` consumer), but it is the kind of gap that
silently spreads, and Kelvin's rule is "all drawer action buttons and toggles".

### B6.5. The console switch overlays set `appearance: none`, which may disable the tick

`ConsoleCanvas.tsx:3765-3775` styles each switch overlay with `appearance: 'none'` alongside
`opacity: 0`. Every working implementation does the opposite:

- `web-haptics` explicitly forces `style.appearance = 'auto'` on its input.
- `ios-haptics` leaves the appearance native and hides with `opacity: 0` + `clip-path`.
- project-fathom lists it as a hard requirement: removing the native appearance disables haptics.

The switch's tick is tied to WebKit rendering the native control, per every community source above.
**On-device result (iPhone iOS 26.3, Phase 0.5 question 5): this did not hold.** `appearance: none` and
`appearance: auto`, both otherwise identical, ticked equally on a direct tap. So the five console buttons
were **not** silently dead on iOS, and the comment at `:3746` claiming they work was correct all along.

**The repo independently reached half of this conclusion and then lost it.** The original `HapticOverlay`
header (`57c27d2`, since deleted) said:

> "never display:none (needs to stay in the render tree), never controlled (let the browser freely flip
> its own checked state so the native toggle, and the haptic tied to it, completes undisturbed)"

So the render-tree requirement was already known here. It was applied to `display`, and never to
`appearance`, and the surviving console overlays still carry `appearance: 'none'`.

The rest of the element is already correct: `projectButtonOverlay()` (`:2407-2433`) gives it a real
projected width and height, so it is a properly sized, rendered, invisible target, exactly the
project-fathom shape. The one-word `appearance: 'auto'` change shipped anyway (§7 Phase 2, `console-wiring`)
since it is the documented best practice and costs nothing when both settings already tick, but it was not
fixing a live bug on this device. Whether it matters on a different iOS version or a different WebKit
build is untested; keep it as the safer default regardless.

**Amended: "safer default regardless" is now too broad, and the tree deliberately does both.** The five
button overlays carry `appearance: 'auto'` per the change above, while the two dial teleport switches
carry `appearance: 'none'` with a comment reading "the working configuration (probe 9d); do not change to
'auto'". That asymmetry is intentional and the source explains it: `performSwitchAnimation` bails on
`!hasUsedAppearance()`, but that check sits **before** the haptic block in its caller, so `appearance:
none` kills the visual switch animation and never the tick. For the dials, killing the animation is the
point, since the element is an invisible drag surface. `display: none` is the one that is genuinely fatal:
no renderer, so `handleTouchEvent` early-returns before it arms anything.

### B7. The console buttons have no haptic on the keyboard path

`ConsoleCanvas.tsx:2981-2995` (`keyTap`) plays the press sound but never calls `haptic()`. Desktop-only in
practice, so low priority, but note it before someone "fixes" it in the wrong place.

**Do not confuse this with two paths that are correct by design** (note the second concerns
`ConsoleShell`, which is dead code, so it is background rather than work):

- The raycast branch for the three big buttons (`:2804-2818`) deliberately has no `haptic()` because the
  DOM switch overlay above it owns that. Adding one there double-fires.
- `ConsoleShell.tsx:158,173` calls `haptic('selection')` in a `Link onClick` that also has a
  `HapticOverlay` over it. The `Link` is `pointer-events-none`, so that handler is the **keyboard** path
  only. Not a double fire.

---

### B8. Range fires the outcome haptic above its own debounce

`range.tsx:400-407`:

```ts
const ping = useCallback((won: boolean) => {
  haptic(won ? 'success' : 'error')
  const t = Date.now()
  if (t - lastPingRef.current < 200) return // debounce a buzzer wave into one sting, not a cacophony
  lastPingRef.current = t
  if (won) rangeWin()
  else rangeLose()
}, [])
```

The comment says "not a cacophony" and the guard delivers that for audio only, because `haptic()` sits
above the early return. With `MAX_POSITIONS = 4`, one buzzer wave settling four bands fires one sting and
up to four vibrations. Moving the `haptic()` call below the guard is a one-line fix and is required before
the patterns get longer.

### B9. Flappy double-buzzes a crash as a success

`flappy-piper.tsx:78` fires `haptic('error')` at impact, then `:59` fires `haptic('success')` when
`submit()` resolves, separated by a 0.5-0.9s death fall plus network latency. So a new personal best feels
like a failure followed, a second later, by an unexplained success. It is also the only place using the
generic `sound('win')` ding instead of a game sting.

### B10. The mid-round crossing haptic is debounced in Range but not in Lucky or Moonshot

`range.tsx:366` gates its band-crossing haptic to one per 400ms. `lucky.tsx:375` and `moonshot.tsx:376`
fire `haptic('selection')` on every crossing flip from inside a rAF loop with no gate at all. Near the
strike, price chatter can machine-gun it. Port Range's gate.

### B11. Line Rider's new best has no feedback at all

`line-rider.tsx:180` renders a `★ New best` banner visually, with no sound and no haptic, while Flappy
does fire something for the same event. This is a straight gap rather than a regression.

Two smaller notes worth fixing while in there: Line Rider fires its haptic **before** stopping the bed
while every other game stops the bed first, and `rangeLock()` exists in `sound.ts:994` but is only ever
called from `/dev/sounds`, so Range has no "locked in" beat in the product.

**Caveat on both bed arguments:** `sound.ts:49` sets `GAME_BEDS_ENABLED = false`, so every `start*Bgm()`
and `stop*Bgm()` is a no-op today and background music comes from the mp3 player in `lib/audio.ts`. The
ordering inconsistency is therefore currently harmless, and anywhere this document reasons about "the bed
stops, then the sting plays" it is describing the intended design rather than what runs.

### B12. The console button's buzz lands on release, its click sound on touch-down

`ConsoleCanvas.tsx:3763-3764`:

```tsx
onPointerDown={() => overlayPressRef.current?.(i)}
onChange={() => haptic(preset)}
```

`overlayPress()` (`:3000-3019`) does the press visual, `playSfx`, and `dispatch` on **pointerdown**.
`onChange` on a checkbox fires as part of activation, i.e. at **click**, which is pointerup. So on Android
the sound lands when the finger touches down and the vibration lands when it lifts. A press that ends with
the finger sliding off the button dispatches but never buzzes at all.

Re-grading `BTN_HAPTIC` to `high` makes a late pulse stronger and therefore more obviously late, so this
must be fixed in the same phase.

The fix is **not** to add a haptic to the raycast branch, which would double-fire. Fire the Android pulse
from inside `overlayPress()` and leave `onChange` as the pure iOS switch-toggle path, which is what its
own comment at `:3762` already claims it is. That also makes the iOS path genuinely iOS-only, which §3
needs anyway to avoid double-buzzing on 26.4 and below.

### B13.5. B13 is not just PLAY. `main`/`action1`/`action2` are relabeled, not re-bound

Found during implementation, not during any research pass, which is worth noting: B13 as originally
written only covered the initial tap. The real shape is bigger. In all three trading games,
`useConsoleControls` rebinds the SAME physical button to a new `onPress` as the game state changes: `main`
is SPIN, then CASH OUT, then SETTLING, then TOP UP, then CONFIRM, then CONTINUE, all the same button 0,
all buzzing `BTN_HAPTIC[0]` on every press regardless of which label is showing. `action1`/`action2` do the
same (HOW TO/CANCEL, RANKS/blank-pulse-on-result). So **every handler reachable only through
`useConsoleControls` double-fires**, not just the tap that starts a round: `doCashOut`, `goTopUp`,
`dismissResult`, `toggleHowto`/`toggleBoard`/`rotateInfo`/`cycleAsset`'s success path, and
`tradeConfirm.ts`'s `press`/`cancel` (shared by all three games) all called their own `haptic()`
synchronously, on top of the console's own buzz for the same press.

The fix is the same principle as B13, applied to every one of those sites: strip the haptic call, let
`BTN_HAPTIC` be the only source for a physical button press. **What must NOT be stripped**, and the line
that matters here: a handler that fires an **async rejection** after the press already happened (Range's
`nudge`, the place-timeout catch, the asset-locked catch) carries genuinely new information, "your press
was rejected, and here is why", which the console's generic press ack never said. Those stay. So does
anything not reachable through the three buttons at all: the mid-round crossing gates, the lock-in reveal
timer, and Moonshot's aim flip, which fires from the knob, a separate control entirely.

The practical rule for reviewing any future haptic call in a game screen: trace whether it is reachable
through `useConsoleControls`' `main`/`action1`/`action2`. If yes, and it fires synchronously as a direct
consequence of the press, it is redundant. If it fires later, asynchronously, carrying new information, it
is not.

### B13.6. The same shape exists everywhere a primitive carries an explicit `haptic=` prop

B13.5's rule generalizes past the console entirely, and applying it app-wide during implementation review
turned up nine more instances of the identical bug, none of them related to the physical buttons:

- `menu/settings.tsx`'s `toggle()` called `haptic('selection')` even though `Hw3DToggle` already buzzes
  on its own `onClick`, before `onChange` (which is what calls `toggle`) ever runs.
- `Onboarding.tsx`'s `commit()` and `LandingOverlay.tsx`'s `onCta()` (the door's own CTA, the very first
  interaction in the product) both called `haptic('rigid')` synchronously, duplicating the
  `Hw3DButton`'s own explicit `haptic="rigid"` prop sitting right next to them in the JSX.
- Four async handlers (`share.tsx` and `history.tsx`'s `doShare`, `username.tsx`'s `save`,
  `withdraw.tsx`'s `submit`) all fired a synchronous press-time haptic matching their button's explicit
  preset, THEN correctly fired a distinct `haptic('success')` after the real work resolved. Only the
  premature synchronous half was the bug; the completion haptic was always legitimate and stays.
- `referrals.tsx`'s Claim button had `haptic="success"` as its OWN press-time preset, meaning it buzzed
  "success" the instant you touched it, before the claim had even been attempted. Re-graded to `high`
  (money-received, matches cash-out/top-up), and the real `haptic('success')` after the await is the only
  success signal now.
- `BridgeExecute.tsx`'s `confirm()` fired `haptic('success')` twice: once at the very top before the
  bridge call had even started (both premature and redundant with the button's default press haptic),
  and again, correctly, after `executeBridge` genuinely finished. Its `connect()` had the same redundant
  synchronous call with no completion haptic to protect. Both fixed the same way: strip the premature
  half, keep the true completion signal.

**The general form, worth stating once:** any primitive that fires its own haptic on press (all five of
the wired ones, see the `web/CLAUDE.md` rule this section motivated) makes a plain synchronous
`haptic()` inside its bound handler redundant by construction, whether that handler is reached through
`useConsoleControls` (B13.5) or through a direct `onPress`/`onChange`/`onClick` prop (this section). The
one shape that is never redundant is a haptic fired **after an await resolves**, because it is answering
a question ("did it work?") the press-time buzz could not have answered yet.

### B13. PLAY already fires two haptics, and this plan would make both of them audible

The one defect in this document that the plan **creates** rather than fixes. Verified by tracing the
dispatch chain:

1. The overlay's `onChange` fires `haptic(BTN_HAPTIC[0])` (`ConsoleCanvas.tsx:3764`).
2. `overlayPress()` calls `dispatch(0)` (`:3018`), which calls `handlers.main()` (`:1676`).
3. For every trading game, `main.onPress` is the play function, and it fires its own haptic:
   `lucky.tsx:403` (`rigid`), `range.tsx:529` (`heavy`), `moonshot.tsx:403` (`heavy`).

So every PLAY press already fires twice. It is invisible today only because `navigator.vibrate` aborts the
first pulse, which is the very bug B1 exists to eliminate. **The moment the serializer stops aborting
(Phase 3) and B12 moves the pulse into `overlayPress()`, every PLAY becomes two audible 20ms `high`
pulses.** The same applies to TOP UP and every action-button binding.

Fix: the console shell owns the button's haptic, the game's handler does not. Strip the `haptic()` call
from the play/cash-out/top-up handlers that are bound to a physical button, and let `BTN_HAPTIC` be the
single source. Do this in the same phase as B12, before the serializer lands, or the first thing anyone
feels after "we fixed the haptics" is a stutter on the most important button in the product.

Note this is distinct from the tap-then-server-ack double in §6.4: that one is two different moments, this
one is two handlers for the same press.

### B14. The Settings > Haptics toggle could never actually turn off the console buttons on iOS

Found on-device, by the user, after everything else in this document had shipped: turning Haptics off in
Settings left the physical console buttons still buzzing on iPhone. Root cause: `setHapticsEnabled(false)`
only ever gates `navigator.vibrate()` calls, which is an Android-only API. On iOS, the console buttons'
tick comes from WebKit's own native response to the `switch` HTML attribute on a real
`<input type="checkbox" switch>` (`ConsoleCanvas.tsx:3752-3781`), a completely separate mechanism our JS
state has no power over. The attribute was applied unconditionally, so the physical tick fired regardless
of the app's internal `enabled` flag, no matter what the user chose in Settings.

**The fix, and the trap in the obvious first attempt.** The natural fix is to make the `switch` attribute
itself conditional on the haptics setting: `{...(hapticsOn ? { switch: '' } : {})}`. Getting `hapticsOn`
into `ConsoleCanvas.tsx` is where it gets interesting. The obvious move, `useAuth()` and read
`user?.settings.haptics`, **crashes**: `useAuth()` throws when there is no `<AuthProvider>` above it, and
`src/lib/consoleShot.tsx` mounts `ConsoleCanvas` in a completely detached `createRoot()` tree (an
off-screen div appended to `document.body`, no providers at all) to render the PnL share-card image. That
path would have broken the moment this shipped.

The actual fix lives in `lib/haptics.ts`: a plain module-level pub-sub (`enabledListeners`, notified from
`setHapticsEnabled`), exposed as `isHapticsEnabled()` and `subscribeHapticsEnabled()`, no React import in
that file. `ConsoleCanvas.tsx` reads it via `useSyncExternalStore(subscribeHapticsEnabled, isHapticsEnabled, isHapticsEnabled)`,
which works identically whether or not an `AuthProvider` is anywhere in the tree, and updates live while
the console stays mounted under the Settings drawer, so the fix takes effect without a reload.

Two things this is **not**: at the time it did not touch the knob or number wheel, which were raycast-only
Three.js interactions with no DOM element and therefore no `switch` attribute to gate. And it does not
affect Android at all, where the existing `enabled` gate on `navigator.vibrate()` already correctly
silenced everything.

**The first half no longer holds, and the fix was extended to match.** `DialTeleportSwitch` gave both
dials a real switch, so the same gap would have reopened there. Its `switch` attribute is conditional on
`hapticsOn` through the same `useSyncExternalStore` subscription. Note the asymmetry deliberately kept in
the code: `iosDialStrip` mounts the element regardless of the Haptics setting and only the **attribute** is
conditional, because the element is also what carries the drag, so gating the mount would stop the dial
working rather than just stop it buzzing.

## 6. The level system

Kelvin's model is three strengths: low, mid, high. Map them onto our facade and keep the semantic presets
for outcomes.

| our preset | level | proposed pattern | used for |
|---|---|---|---|
| `tick` | high (crisp) | `{ duration: 10, intensity: 1 }` | the knob's detents, one per detent |
| `tickSmall` (new) | mid | `{ duration: 7, intensity: 1 }` | the small amount wheel's detents |
| `low` (= `selection`) | low | `{ duration: 10, intensity: 1 }` | incidental, passive acknowledgement |
| `mid` (= `medium`) | mid | `{ duration: 15, intensity: 1 }` | menu drawer buttons + toggles, small console buttons |
| `high` (= `heavy`) | high | `{ duration: 20, intensity: 1 }` | the three big square console buttons |
| `success` | - | keep | applied skin, completed deposit, generic confirmations |
| `warning` / `error` | - | keep | rejections, failures |
| `win` / `lose` / `cashOut` / `achievement` | - | see 6.6 | game outcomes, the custom patterns Kelvin asked for |

Keep the existing names as aliases so 154 call sites do not have to be edited in one commit. Every number
here is a **starting point to calibrate on device**, not a measured value.

**The aliasing IS the re-grade, not a deferral of it.** The moment `selection` points at `low`, all 71
calls and 24 props change from 8ms to 10ms; `medium` to `mid` moves 25ms to 15ms; `heavy` to `high` moves
35ms to 20ms. Nothing is postponed except the *editing*. In particular the 19 first-run door calls this
document elsewhere says to hold at `low` are re-graded automatically unless they are given an explicit
preset in the same commit. Anyone reviewing Phase 2 as "mostly one-line edits" needs to understand that
those one-line edits move every haptic in the app.

**Why every level is full intensity, and why `high` is 20ms and not 28ms.** Two reasons, and both are
corrections to an earlier draft of this file.

First, the encoding rule from §6.6 applies here too: at `intensity: 1` a pulse is one array entry, and at
`intensity < 1` web-haptics PWM-expands it into roughly `duration/10` entries that mostly read as a
*shorter* pulse anyway. Weight belongs in duration.

Second, the design system defines what a press is supposed to feel like. From the hardware kit section of
the design doc (recovered from `d3baadc^:web/src/admin/DESIGN.md`, since `docs/DESIGN-SYSTEM.md` is
absent):

> "press inverts the plane. It does not dim, it does not shrink. It stops being raised and becomes sunken,
> which is what a real key does. Total travel is 2.5px between hover and press, and that small distance
> over 120ms is what reads as a **firm, well-damped switch**."

Android's own guidance puts a single impulse over ~20ms into buzzy territory, and a buzz is not a
well-damped switch. So 20ms is the ceiling for a *press*, not a starting point to push past. 20 vs 28 is a
probe question, not an assertion.

## 6.4. In-round vocabulary (the layer you feel most)

§6 grades the console and the drawer, §6.6 grades outcomes. Between them sit **42** call sites inside the
games themselves, and they are what a player feels continuously during a round. Kelvin's brief was
"overall paling handle haptics di playpips.fun", so leaving these at whatever they happen to be today
would miss the most-felt layer.

Two money-committing sites live outside the game screens and belong in this grade too:
`components/game/tradeConfirm.tsx:52` (`rigid`, the arm press) and `routes/_app/games/index.tsx:107`
(`rigid`). Both go to **high** under the rule below.

**Correction, caught during implementation review:** an earlier draft of this table also put
`tradeConfirm.tsx:37` in the money-committing group. That line is the explicit **CANCEL** press, whose own
code comment already says "a light tick, then disarm." Cancelling is backing out of a commitment, not
making one, so it stays **low**, matching every other dismiss/back action in this table. Only the arm
press (line 52, the one that actually starts the confirm window) is money-committing.

| moment | file:line | today | becomes | why |
|---|---|---|---|---|
| Lucky SPIN tap | `lucky.tsx:403` | `rigid` | **high** | it commits money |
| Lucky deal returned | `lucky.tsx:435` | `heavy` | **remove** | see the double-buzz note |
| Lucky wheel 1 lands | `LuckyWheels.tsx:124` | `rigid` | **mid** | a reel landing is an event, not a commit |
| Lucky wheel 2 lands | `LuckyWheels.tsx:124` | `rigid` | **high** | the last reel resolves the tier, so it lands heavier |
| Lucky lock-in reveal | `lucky.tsx:347` | **none** | **low** | it has a sound and no touch; a light beat completes it |
| Range place tap | `range.tsx:529` | `heavy` | **high** | commits money |
| Range play opened | `range.tsx:557` | `selection` | **remove** | double-buzz |
| Range rejected / timeout / asset locked | `:487`, `:563`, `:580` | `error` | keep `error` | a real rejection |
| Moonshot fire tap | `moonshot.tsx:403` | `heavy` | **high** | commits money |
| Moonshot round opened | `moonshot.tsx:421` | `selection` | **remove** | double-buzz |
| Moonshot aim flip | `moonshot.tsx:494` | `rigid` | **mid** | fires from inside the knob drag, so it must not outweigh a detent burst |
| Cash-out tap (Lucky, Moonshot) | `lucky.tsx:459`, `moonshot.tsx:450` | `rigid` | **high** | commits money |
| Mid-round crossing (all three) | `lucky.tsx:375`, `moonshot.tsx:376`, `range.tsx:366` | `selection` / `rigid` | **low**, gated (B10) | ambient, not an action |
| Dismiss result, info, how-to, asset cycle | various | `selection` | **low** | incidental |
| TOP UP | `lucky.tsx:495`, `moonshot.tsx:483`, `range.tsx:575` | `rigid` | **high** | commits money |
| Line Rider run start | `line-rider.tsx:91` | `rigid` | **high** | |
| Line Rider combo milestone | `line-rider.tsx:66` | `rigid` | **mid** | fires mid-drag, every combo |
| Line Rider line regained | `line-rider.tsx:67` | `selection` | **low** | |
| Flappy run start | `flappy-piper.tsx:98` | `rigid` | **high** | |
| Flappy flap | `flappy-piper.tsx:103` | `medium` | **low** | see below |
| Flappy score | `flappy-piper.tsx:74` | `selection` | **low** | |

**The organising rule, taken from the design system, not invented here:** the hardware kit "is for the
handful of controls that **commit** something", and "restraint reads as machined, excess reads as a 2008
web app". So `high` is reserved for actions that spend or resolve money, `mid` is for state changes the
player caused, and `low` is for acknowledgements. That rule is what produced every row above, and it is
the same rule behind Kelvin's "Customize: preset cards and Done only, sisanya gausah".

**Round start currently double-buzzes in all three games.** Lucky fires `rigid` on tap then `heavy` on the
server ack (and then `rigid` twice more as the reels land, so four buzzes for one spin). Range and
Moonshot fire twice each. The tap is the player's action and deserves the haptic; the server ack is not
something they did. Drop the ack buzz rather than re-weighting it. The visual and audio already cover the
transition.

**Flappy's per-flap `medium` is the highest-frequency haptic in the app** and, at several presses per
second, it is the single most likely source of haptic fatigue we ship. `low` is the right weight, and it
is worth asking on device whether it should fire at all.

## 6.5. The detent scheduler (designed, verified against the spec and AOSP)

### Corrections to what I assumed earlier

- Max pattern length is **10 entries in the W3C spec**, 99 in Chromium. Write to the spec number.
- The 10000ms cap is **per entry**, not per pattern.
- Chromium **strips a trailing pause**, so always emit an odd-length pattern.
- Every `vibrate()` issues a mojo `Cancel()` IPC and then one IPC **per pattern entry**, driven off the
  renderer main thread. Calling it per detent inside a drag loop is a perf cost as well as a correctness
  bug.
- Even indices vibrate, odd indices pause. A pattern that flips them silently produces nothing.
- On Android, Chromium **skips vibration entirely in silent ringer mode**. Nothing we can do, but it is
  the first thing to check when someone reports dead haptics.

### The numbers

| constant | value | why |
|---|---|---|
| `DETENT_MS` | **10** | Exactly AOSP's `config_clockTickVibePattern`, the platform's own picker detent, and the bottom of the documented 10-20ms keyclick drive range. The knob. |
| `DETENT_SMALL_MS` | **7** | The amount wheel, graded `mid`. See the caveat below. |
| `DETENT_GAP_MS` | **25** | Derived, not documented. Must clear the actuator's 20-50ms ring-down or two pulses fuse into one. **This is the knob to tune by feel.** |
| `SLOT_MS` | 35 | Sum of the two. Ceiling of 28.5 pulses/sec. |
| `MAX_BURST` | **3** | Bounds how far the buzz can trail the finger: `(3-1)*35 + 10` = 80ms. Also keeps the pattern at 5 entries, inside the spec's 10, and odd. |

Note `tick` moves from 4ms to **10ms**. AOSP's own tick is 10, and 4ms barely starts an actuator moving.
A sub-threshold pulse is a strong candidate for why the wheel already feels dead.

**The two-weight caveat, and it is a real design problem.** Kelvin wants the knob at high and the amount
wheel at mid, but a single actuator has one axis at this scale, and 10ms is already the floor of the
perceptible range. 7ms may well be indistinguishable from 10ms on a good LRA and *invisible* on anything
else, which would mean the amount wheel simply feels weaker or absent rather than lighter. So:

- `hapticDetent(n, ms = DETENT_MS)` takes the pulse width, and the two call sites pass their own constant.
  That keeps one scheduler and one clock.
- **Probe 10 vs 7 side by side before committing to two weights.** If they are indistinguishable, use one
  weight for both dials and tell Kelvin the difference is not reachable, rather than shipping a
  distinction only the code knows about.
- The pattern-shape test must then accept even indices in `{DETENT_MS, DETENT_SMALL_MS}`, not just
  `DETENT_MS`.

### The part that makes this worth doing

Saturation velocity is **1140 px/s** for the knob (40px/detent) and **800 px/s** for the number wheel
(28px/detent). A deliberate value scrub runs 200-600 px/s. So **1:1 sound-to-haptic holds for every case
where the user is actually choosing a number**, which is the case Kelvin cares about. A hard flick
saturates into a ~28Hz texture, which is in the Pacinian band and reads as *spinning*, which is also what
a real detented knob does when you spin it: the detents merge mechanically too.

### Cap and drop, do not bank

Firing all N is wrong. Ten pulses is 325ms, so the last one lands a third of a second after the finger
crossed that detent, and it is unbounded: the next frame adds ten more while half a pulse has drained.
Lag grows monotonically through the flick and you finish with a buzz playing after the finger has lifted.
You cannot cancel out of it either, because cancelling is the original bug.

Dropping the excess makes worst-case lag a constant by construction. This is exactly what Android's own
`HapticScrollFeedbackProvider` does: `if (abs(total) >= tick) { total %= tick; perform(SCROLL_TICK) }`, an
`if` and a modulo, not a loop. And `SEGMENT_TICK`'s own javadoc sanctions "lighter or suppressed" at high
density.

### Algorithm

State is `pending`, `busyUntil`, `flushTimer`.

1. Intake `hapticDetent(n)`: `pending = min(pending + n, MAX_BURST)`. Overflow dies on that line.
2. If idle, flush **synchronously in the same task as the pointermove**, so the first detent of a drag has
   zero added latency and lands with the audio.
3. If busy, arm one timer for `busyUntil`. Never call `vibrate()` while a pattern is in flight.
4. Flush emits `[10, 25, 10, 25, 10]` for three pulses and sets `busyUntil = now + k * SLOT_MS`.
   **Reserving the trailing gap is load-bearing**: without it, consecutive flushes butt pulse against
   pulse and the seam merges.

Edge cases: direction reversal needs nothing (a crossing is a crossing, pass `Math.abs`). On drag end, let
the pattern ring out, at most 105ms; do **not** call `vibrate(0)`, because a real knob keeps clicking as it
settles and cutting the tail is the same abort bug wearing a different hat. The one sanctioned interrupt
is the user switching haptics off mid-drag, which must clear `pending`, kill the timer, and `vibrate(0)`,
or a queued burst outlives the toggle.

### Three traffic classes, one clock

An earlier draft designed the clock for detents and outcome patterns and left the ~150 plain
`haptic(preset)` button presses undefined against it. Both defaults are bugs:

- **Bypass the clock** and a press calls `navigator.vibrate()`, which aborts whatever is playing. That is
  B1, the bug this whole section exists to fix, reintroduced at 150 call sites.
- **Respect the clock** and a genuine button press is silently swallowed for up to 290ms after a win
  pattern, so the device feels dead exactly when the player is pressing fastest.

So the clock needs a priority model, stated in the module header:

| class | entry point | when busy |
|---|---|---|
| outcome | `hapticPattern(name)` | queue one deep, drop the third |
| press | `haptic(preset)` | **preempt** a detent burst (clear pending, fire now); defer at most one slot behind an outcome; never queue |
| detent | `hapticDetent(n)` | cap at 3 and drop; yield to both above |

A press is the direct answer to a finger already on the glass, so it outranks a detent. That is the same
hierarchy `uiSfx` encodes implicitly by giving toggles and the reject sound zero drift and full gain while
`tap` is the quietest family.

**Preemption is a deliberate exception to "cancelling is the bug", and it needs saying out loud.** This
section argues that aborting a running pattern is the original defect, then gives presses the right to do
exactly that to a detent burst. Both are correct, for different reasons: aborting is wrong when it
destroys information the user asked for (their detent train), and right when a newer, higher-value event
supersedes it (their finger, now, on a button). The rule is that a press may cut a **detent burst** and
nothing else. It never cuts an outcome pattern, and an outcome pattern never cuts a press.

### Two module-level obligations

**Wrap the body in try/catch.** Every neighbouring bus does (`uiSfx.ts`, `track.ts`). `haptic()` is called
from rAF loops (`lucky.tsx:375`, `moonshot.tsx:376`, `range.tsx:366`) and from inside the Three.js
pointermove. Today it is three lines and cannot throw; once it contains array math and a timer, a throw
kills a frame loop rather than dropping a buzz.

**Export one `cancelHaptics()`** that clears `pending`, kills the timer and calls `vibrate(0)`. Use it for
the haptics-off toggle and reuse it as the test reset rather than inventing a second path. Do **not** call
it on route change: cutting a detent tail is the abort bug wearing a different hat.

### Call sites

Two lines, and the step math stays untouched:

```ts
hapticDetent(Math.abs(steps - numberWheelLastStep))   // ConsoleCanvas.tsx ~2855
hapticDetent(Math.abs(steps - knobLastStep))          // ConsoleCanvas.tsx ~2903
```

Both replace `haptic('tick')` exactly where it sits today, outside the loop, with both step values already
in scope.

### Optional follow-up, judged separately on device

`consoleAudio.playSfx` has no anti-flam while `uiSfx` has a 40ms one. On a hard flick it spawns dozens of
overlapping `BufferSource`s per second, which will mush. Coalescing the audio the same way would lock the
two layers together and clean up the sound. Keep it a separate, reversible change: it is adjacent to the
step math we agreed not to touch.

### Surface assignments (Kelvin's list, translated to file:line)

**Console** (`ConsoleCanvas.tsx:39` `BTN_HAPTIC`, currently `['rigid','medium','medium','selection','selection']`)

| control | index | now | target |
|---|---|---|---|
| PLAY (big square) | 0 | `rigid` (10ms) | **high** |
| Action 1 (big square) | 1 | `medium` | **high** |
| Action 2 (big square) | 2 | `medium` | **high** |
| MENU pill (small, top) | 3 | `selection` | **mid** |
| HOME pill (small, top) | 4 | `selection` | **mid** |
| Audio/music pill | `:2800` | `selection` | **mid** |
| Volume fader grab | `:2790` | `selection` | mid |
| Knob detent | `:2903` | `tick` 4ms, desynced | **high `tick`, one per detent (B1)** |
| Number/amount wheel detent | `:2855` | `tick` 4ms, desynced | **mid `tickSmall`, one per detent (B1)** |

**Do not touch `ConsoleShell.tsx` or `Knob.tsx`.** Both are dead code in the current tree: nothing imports
`ConsoleShell` (only comments mention it), `Knob` is imported only by `ConsoleShell`, and `_app.tsx`
mounts `ConsoleCanvas` unconditionally. An earlier draft of this file assigned them work. `Knob.tsx:32-37`
also has no per-detent loop and no step delta in scope, so it is not even the same change. Note the drift:
`web/CLAUDE.md` still describes `ConsoleShell` as the live fallback.

**Menu drawer** (`src/ui/Hardware3D.tsx`, the file Kelvin named)

| component | line | now | target |
|---|---|---|---|
| `Hw3DButton` | `:68` | `selection` default | **mid** default |
| `Hw3DIconButton` | `:122` | `selection` | **mid** |
| `Hw3DToggle` | `:314` | `selection` | **mid** |
| `Hw3DFader` grab | `:213` | `selection` | mid |
| `Hw3DFader` keyboard step | `:219,222` | `tick` | **give it its own preset**, see below |
| `HapticOverlay` default | `HapticOverlay.tsx:17` | `selection` | **mid** (it backs the same menu buttons) |
| `ui/Button` | `Button.tsx:30` | **none** | **mid** (B6) |
| `ui/Switch` | `Switch.tsx:22` | **none** | **mid** (B6) |

Changing those four defaults covers the overwhelming majority of the drawer without touching a single page
file. Only the explicit `haptic('selection')` literals scattered through `routes/_app/menu/*` then need
individual review, and most of them are already correct as low-level acknowledgements.

**The blast radius is wider than the drawer. Four carve-outs to decide deliberately:**

- **The door.** `LandingOverlay`, `Onboarding` and `tour` carry 19 haptic calls between them, and they run
  in the first thirty seconds before the user has opted into anything. Tripling the tactile budget there
  is the most likely way to make the product read as "the phone is buzzing at me". Consider holding the
  first-run path at `low`.
- **`/admin`.** `SettingsDrawer.tsx` imports `Hw3DToggle`, so the dashboard inherits the re-grade. Accept
  it (admin uses the hardware kit deliberately) rather than banning `@/lib/haptics`, which would break the
  admin's own keys.
- **`Hw3DIconButton` and `Hw3DToggle` hardcode `'selection'` with no prop**, unlike `Hw3DButton`. Add a
  `haptic?` prop to both while re-grading, or the audio-cluster button and every toggle in the app are
  permanently locked to the same weight.
- **`Hw3DFader`'s keyboard step** currently uses `tick`, which is about to become the detent scheduler's
  currency. A held arrow key would start feeding the burst cap. Either route it through `hapticDetent(1)`
  on purpose or give it its own preset, but do not leave it aliased to a scheduler input by accident.

**Split the type.** `HapticPreset` is a public prop type (`HapticOverlay`, `Hw3DButton`, and the element
type of `BTN_HAPTIC`). If §6.6's outcome names join that union, `<HapticOverlay preset="achievement">`
typechecks and nothing catches it. Keep two types, the way `UiSfxName` stays narrow:

```ts
type HapticPreset  = 'tick' | 'tickSmall' | 'low' | 'mid' | 'high' | ...aliases  // primitives take this
type HapticPattern = 'win' | 'lose' | 'cashOut' | 'achievement'                  // hapticPattern() only
```

**Customize** (`CustomizeStudio.tsx`)

| site | line | action |
|---|---|---|
| Preset card tap | `:111` | keep, set to **mid** |
| Done | `:133`, `:237` | keep `success` |
| Colour swatch | `:124` | **remove** |
| Tab strip | `:491` | **remove** |
| Share | `:243` | **remove** |

---

## 6.6. Outcome haptics: win, lose, achievement

Kelvin, on the playground's Custom Haptic builder: "jgn kyk 'tek' doang gitu, pake custom haptics aja yg
bgini" (don't make it just a single tick, use a custom pattern like this) for **every game's win and
lose**, and **unlocking an achievement**. The reference he sent is the `success` preset:

```js
trigger([
  { duration: 30 },
  { delay: 60, duration: 40, intensity: 1 },
])
```

This is the most valuable item on the whole list, for a reason nobody has said out loud yet: **a
multi-pulse pattern is the only haptic that differentiates on iOS.** Per section 3, every short
single-pulse preset collapses to one identical Taptic tick, so low/mid/high is Android-only. But rhythm
survives, because the pattern's pulses and gaps are reproduced as separate clicks.

~~Outcome haptics are therefore the one part of this project that lands on every device we ship to.~~
**Corrected 2026-08-09, and this one matters.** They land automatically on **Android only**. On iOS a
rhythm survives solely inside a live touch, through `PointerTracking`, and every real outcome arrives with
no touch: the expiry settle is an SSE frame, cash-out is a network hop plus 1100ms, achievement is 1400ms
of `setTimeout`, all far outside WebKit's 1s gesture-forwarding window (§3.5). What makes them reachable
on iPhone at all is that a thumb already resting on an armed surface keeps clocking beats, which is what
`iosBeats.ts` exists to exploit. Design the patterns as an Android feature with an iOS path that fires
**when the player happens to be holding the device**, never as a universal one.

### The encoding rule: full-intensity pulses, weight in duration

web-haptics expands each `{duration, intensity}` into PWM frames before calling `navigator.vibrate`.
Working through the source:

- At `intensity < 1`, one pulse costs about `duration / 10` array entries. `{duration: 40, intensity: 0.9}`
  becomes `[18, 2, 18, 2]`, four entries for one felt pulse.
- The built-in `error` preset (3 x 40ms at 0.9) expands to **12 entries**, past the W3C max of 10. It only
  works because Chromium allows 99. It is not portable.
- At `intensity: 1`, a pulse is exactly **one** entry.

So a three-pulse pattern written at full intensity is `[on, gap, on, gap, on]`: five entries, odd length
(so Chromium has no trailing pause to strip), inside the spec, and the same shape the detent scheduler
already emits.

**Encode weight as duration, never as intensity.** On Android, PWM at `intensity < 1` mostly reads as a
shorter pulse anyway on anything but a well-damped LRA, so duration is the honest control.

~~On iOS, duration maps to the number of Taptic clicks (roughly one per 16ms at full intensity), so a 20ms
pulse is one tick and a 70ms pulse is a burst. One rule, both platforms.~~ **Corrected 2026-08-09: the
rule does not carry.** Those clicks land 16ms apart, which is below the gap-detection threshold and inside
a Light impact's ring-down, so a "burst" is felt as one buzz, not as weight (§3.5). iOS has no intensity
axis and no duration axis; **spacing is its only expressive dimension**, floored at 80ms and quantised to
the touchmove rate. So this is one rule for Android and a separate onset table for iOS, which is exactly
what `iosBeatOffsets()` in `lib/haptics.ts` is: the same four names, re-authored as onsets `iosBeats.ts`
can clock against a finger.

Keep `success` / `warning` / `error` as they are for their existing generic uses. These outcome patterns
are a new, named vocabulary.

### The grammar

Users should learn the language, so the skeleton is shared and only the rhythm varies. Every pattern below
is full intensity, and the entry count is in brackets.

| name | pattern (ms) | entries | reads as |
|---|---|---|---|
| `win` | `20 · 50 · 30 · 50 · 70` | 5 | escalating, ends heavy. Two taps and a landing. |
| `lose` | `70 · 40 · 25` | 3 | the inverse. Starts heavy, falls away, no resolution. |
| `cashOut` | `25 · 45 · 25` | 3 | two equal, deliberate taps. A decision, not an outcome. |
| `achievement` | `20 · 40 · 20 · 40 · 20 · 60 · 90` | 7 | three quick, then a hold. The only one bigger than a win. |

Rationale for the shapes. A win escalates and resolves; a loss decays and does not. That contrast is
legible without being taught, and it is the same asymmetry the game audio already uses. `cashOut` is
deliberately neutral and symmetric, because taking money early is a choice the player made, not something
that happened to them. `achievement` is the only pattern allowed to exceed ~250ms, so it stays rare and
special, which is exactly what the game-haptics literature warns you to protect.

### Per-game identity

`web/CLAUDE.md` is emphatic for audio: "Every game gets its own identity, do NOT reuse a bed." Mirroring
that in haptics is tempting and mostly wrong. Sound has enormous expressive bandwidth; a vibration motor
has pulses and gaps. Five distinct win rhythms would not read as five identities, they would read as
inconsistency, and they would break the one thing that makes a haptic language work, which is that the
same event always feels the same.

**Recommendation: one shared grammar, with a single optional accent per game.** Keep the win skeleton
identical everywhere, and if a game wants a signature, vary only the *final* pulse (Lucky's landing a
little brighter and shorter, Range's a little longer and heavier). Decide that on device, after the shared
grammar is in and someone has actually felt it. Do not design five vocabularies on paper.

### Scale the win to the size of the win, carefully

The obvious extension is a bigger payout getting a bigger buzz. The mobile-games literature does exactly
this, and it works. It is also the mechanic most associated with slot machines, which is a product
decision and not mine to make: PIPS is a trading game and this is real money.

If we do it, the cheap and tasteful version is two tiers, not a continuum: the standard `win`, and a
`winBig` that appends one extra heavy pulse above some multiple. Anything more granular is not felt, it is
only imagined. Flagging it as an open question rather than building it.

### Where they go

Today **every win in the app is `success` and every loss is `error`**, with zero per-game differentiation,
while the audio side is fully bespoke. That is the gap Kelvin is pointing at.

| moment | file:line | today | becomes |
|---|---|---|---|
| Lucky resolve | `lucky.tsx:224` | `success` / `error` | `win` / `lose` / `cashOut` |
| Moonshot resolve | `moonshot.tsx:262` | `success` / `error` | `win` / `lose` / `cashOut` |
| Range settle | `range.tsx:401` (`ping`) | `success` / `error` | `win` / `lose` |
| Line Rider crash | `line-rider.tsx:44` | `error` | `lose` |
| Line Rider new best | none | **nothing at all** | `achievement` (see B11) |
| Flappy crash | `flappy-piper.tsx:78` | `error` | `lose` |
| Flappy new best | `flappy-piper.tsx:59` | `success` | fold into the crash, see B9 |
| Achievement unlock | `AchievementCelebration.tsx:88` | `success` | `achievement` |
| Off-route settle | `ActivePlayChip.tsx:46` | `success` / `error` | `win` / `lose` |
| Chip grant | `ChipGrantCelebration.tsx:67` | `success` | keep `success` |
| Deposit landed | `DepositLanded.tsx:45` | `success` | keep `success` |

`ActivePlayChip` is the same outcome fired when you have navigated away from the game, guarded by
`onOwnRoute` so it never doubles. It must move with the games or the feel forks by route.

Chip grant and deposit keep `success` deliberately. Three overlays currently share it and only the audio
distinguishes them, which `sound.ts` says is intentional. Promoting only the achievement to its own
pattern is what makes it feel rarer than money arriving.

### The collisions force a serializer

This is the finding that changes the design. Today's patterns are 130-200ms and simply stomp each other
invisibly. At 95-290ms (the §6.6 patterns), every one of these becomes audible truncation:

- **Range fires up to four haptics per buzzer wave.** `ping()` calls `haptic()` **above** its own 200ms
  debounce, and `MAX_POSITIONS = 4`. The sound collapses to one sting, the haptic does not. See B8.
- **Line Rider's knob is the game.** The crash pattern is guaranteed to be sliced by the next detent
  within ~40px of wheel travel.
- **Lucky, Range and Moonshot bind the knob and wheel in every phase**, with no idle gate, so a settle
  regularly lands while the player is already scrubbing the next stake.
- **A win can chain three patterns**: the resolve, then the achievement 1400ms later, then possibly an
  auto chip grant, none of which know about each other.

So `haptic()` needs a small serializer in front of it, and the detent scheduler's `busyUntil` is already
most of it:

1. An outcome pattern **claims the actuator for its full duration**. Detents arriving during it are
   dropped, exactly as the burst cap already drops them.
2. An outcome pattern arriving while another is playing is **queued, not dropped**. These are meaningful
   and rare, unlike detents. One deep queue is enough; the third one in a chain can be discarded.
3. **Identical patterns inside a short window collapse to one.** That alone fixes Range's four-in-a-wave
   without touching its wave logic.

### Constraints these patterns must respect

- **A remount must not replay an outcome.** `ActivePlayChip.tsx:46` and `AchievementCelebration.tsx:88`
  both fire from an effect guarded only per-mount. A crash boundary, an HMR reload or a fast route bounce
  replays them, and at up to 290ms queued one deep that is far more noticeable than today's 130ms stomp.
  This is what the "collapse identical patterns inside a short window" rule is really protecting, so make
  the window about a second, long enough to swallow a remount.
- **Never fire two outcome patterns at once.** A win that also unlocks an achievement must play one, then
  the other, or they will interleave into noise. `navigator.vibrate` aborts whatever is playing, so the
  second one truncates the first. The scheduler's `busyUntil` already models this, and outcome patterns
  should claim it for their full duration.
- **The detent scheduler must yield.** If the knob is being dragged when a round resolves, the outcome
  pattern wins and any pending detents are dropped, not queued behind it.
- **Fire on the visual beat, not on the state change.** The games stage their reveals (the bed stops, then
  the sting plays). The haptic belongs with the sting, not with the network response.
- **One per outcome.** If a screen already fires `haptic('success')` on reveal and the celebration modal
  fires again on mount, the pattern will double-buzz. That needs auditing per surface.

## 7. Implementation plan

**History as of 2026-08-14: every phase below ran.** Phases 0 through 5 are all committed, and Phase 0.5's
probe page grew from 5 questions to 15 sections as the iOS work went deeper (§3.5 is what came out of it).
Read this as the record of the order things happened in and the traps found on the way, not as a to-do
list. Ordered so each step was independently shippable and verifiable.

**Phase 0. Get a device in the loop.** Nothing below can be judged on a desktop. See section 9.

**Phase 0.5. Probe the iOS 26.3 phone (30 minutes, decides the iOS architecture).** Create
`src/routes/dev/haptics.tsx` **and add a `PAGES` card in `routes/dev/index.tsx`** with its own icon and
tint. That file's header comment requires it and `web/CLAUDE.md:389` mandates it; existing tags are
`device | ui | tooling | audio`. Follow `dev/sounds.tsx`'s shape: the library owns every pattern, the page
is the index and audition bench, no pattern arrays declared in the route file. The switch experiments
below are the one exception, so keep those in the route file and delete them once the answers are recorded
here. Being outside `_app` matters: no `ConsoleCanvas` mounts, so nothing calls `setPointerCapture` and
steals the gesture.

**Amended: the page stays.** It grew past these five questions into 15 sections (async gate, swipe to
collect, the stationary-hold and long-hold measurements in §3.5, and Section 15, which instruments the
**shipped** scheduler rather than a probe), and it is the only way to measure any of this. Do not delete
it. Its experiments are the source for §3.5, so it is the instrument, not scaffolding.

Open it on the iPhone and answer by feel:

1. A `new WebHaptics()` with default options (`showSwitch: false`, so `display: none`). Does it tick at
   all? If no, the library's iOS path is unusable for us and question 2 is the real answer.
2. A hand-rolled `<input type="checkbox" switch>` hidden with `opacity: 0` + `clip-path`, rendered,
   clicked programmatically. Does it tick? This is the `ios-haptics` shape.
3. The same element, toggled by dragging a finger across it rather than tapping. This is the one that
   matters for the wheel, and the one that survives 26.5.
4. `heavy` vs `medium` vs `selection` back to back. Confirm they are indistinguishable, as predicted.
5. The same element with `appearance: none` vs `appearance: auto`, both at `opacity: 0` (B6.5). This one
   is about existing shipped code, not new code: press a physical console button on the device and note
   whether you feel anything at all today.

Answers 1 and 2 decide whether iOS gets app-wide haptics at all. Answer 3 decides whether the scroll wheel
can ever feel right on an iPhone. Answer 5 tells us whether the console buttons have been silently dead on
iOS this whole time. Write the results into this file before writing any real code.

Note on versions while probing: the switch haptic itself landed in **iOS 18**, not 17.4. Safari 17.4
shipped the switch control, Safari on iOS 18 added the tick. The programmatic exploit window is therefore
iOS 18 to 26.4.

### Phase 0.5 results, run for real, on iPhone iOS 26.3

Reported directly, not inferred:

1. **Ticked.** `new WebHaptics().trigger('success')` with library defaults (`showSwitch: false`,
   `display: none`) produced a felt tick.
2. **Split.** A direct physical tap on the rendered (`opacity: 0` + `clip-path`) switch ticked. The
   "click it programmatically" button, calling `.click()` on that same rendered switch, produced nothing.
3. **Fired, and repeatedly.** Sliding a finger across the wide drag element produced a felt buzz, and the
   on-page "toggle events fired this session" counter visibly incremented during the slide, not just once
   at release. Exact count not yet pinned down.
4. **Nothing, on all three.** Low/Mid/High raw `navigator.vibrate()` calls (10/15/20ms) produced no
   sensation at all.
5. **Both ticked.** `appearance: none` and `appearance: auto`, otherwise identical, both produced a felt
   tick on a direct tap.

**What this settles, and what it does not.**

Result 5 is the load-bearing one: **the console's physical buttons were never silently dead on iOS.**
`appearance` made no observable difference on this device, so B6.5's fear (that `appearance: none` might
be the reason a real tap doesn't tick) does not hold here. The `appearance: auto` change made in that
section is not "the fix for a broken button," it is just the safer documented default, kept because it
costs nothing when both settings already work.

~~Results 1 and 2 look contradictory... Treat the contradiction as unresolved and irrelevant.~~
**Resolved 2026-08-09, in WebKit source, and they were never contradictory.** A `display: none` label
ticking programmatically while a *rendered* switch's own `.click()` did nothing is exactly what the
pre-26.5 source predicts. `label.click()` went through `HTMLLabelElement::defaultEventHandler`, which
forwards to `control->dispatchSimulatedClick()`, and that function set `SimulatedClickSource::UserAgent`
unconditionally, so an untrusted click on the label became a **trusted** click on the checkbox.
`input.click()` never had that laundering available, because `HTMLElement::click()` hardcodes
`SimulatedClickSource::Bindings`. One path laundered trust, the other never did. `display: none` was never
the variable: the haptic block runs after `performSwitchAnimation` and checks nothing about appearance.
The practical conclusion still stands, for a different reason: neither path runs in the shipped app, and
the trust laundering is dead on 26.5+ regardless (§3.5).

Result 4 needed no interpretation: iOS Safari has never implemented `navigator.vibrate`, so silence was
the only possible outcome, and it confirms nothing new.

~~Result 3 is the one genuinely open thread.~~ **Characterised, and then shipped.** The counter really was
incrementing more than once per slide, and the source says why: the flip fires on **every** crossing of
the switch's flip line, with no cap, no debounce and no minimum interval, from the touchmove branch of
`handleTouchEvent`. That killed the "one toggle per gesture" reasoning §8 rested on and turned per-detent
iOS haptics from a dead idea into the shipped `DialTeleportSwitch`. The mechanism does not need finger
travel at all, only touchmove **events**, since teleporting the element is what moves the flip line under
a roughly stationary finger.

**Phase 1. Swap the engine, keep the facade. This is NOT a no-op, do not treat it as one.**

In `lib/haptics.ts`, build one **lazy** singleton (`if (typeof window === 'undefined') return null`, the
guard the old code already had and that `audioContext.ts` and `track.ts` both use, since `haptics.ts` is
imported by 49 files and would otherwise allocate on every SSR render). Gate every call on
`WebHaptics.isSupported` (see §2, "Two behaviours that decide how we integrate it", or iOS pays a rAF loop for nothing). Keep the `enabled` early return:
it is server state on `UserDTO['settings'].haptics`, pushed in by an effect at `src/lib/auth.tsx:243-245`,
and dropping it silently kills the Settings toggle. Keep the `haptic(preset)` signature.

**The trap.** `trigger()` defaults `intensity` to `0.5` and PWM-expands, so handing it today's raw arrays
silently changes every preset's shape. Verified by hand against the bundle: `haptic('success')` is a clean
`vibrate([30, 60, 40])` today and becomes

```
[10, 10, 5, 65, 10, 10, 10, 10]
```

eight entries instead of three, with the first pulse chopped. `error` expands past the W3C 10-entry max.

So the preset table must be **rewritten as explicit `{ duration, intensity: 1 }` objects in the same
commit as the swap**, and the test file must assert the exact array passed to `navigator.vibrate` for
every preset. Otherwise this phase ships a silent regression across 154 call sites under a commit message
saying nothing changed.

**Phase 2. Re-grade the levels.** Add the level presets from section 6, retune the numbers on device,
then apply the surface assignments (§6) **and the in-round vocabulary (§6.4)**. §6 is mostly four primitive
defaults plus one array; §6.4 is about thirty individual call sites across the five games, including three
`remove` rows that kill the round-start double-buzz. Do §6 first and feel it before touching §6.4.

**Phase 3. Fix the wheel (B1 + B2).** The coalescing detent scheduler, then calibrate `tick` against the
`roller` and `knob` samples with the phone in hand. This is the one Kelvin cares about most, so budget
real time for feel, not just correctness.

Two guardrails. The "previous revamp that made it worse" left **no trace in git**: `git log -S` shows
`NUMBER_WHEEL_PX_PER_STEP` and `dragSensitivity: 0.5` each set once and never touched, so that attempt was
either uncommitted or elsewhere, and we cannot learn from it. And because those constants have never
moved, changing them is a genuinely new regression risk. **Fix the haptic first and leave the drag
sensitivity alone**, so if the feel changes we know which change did it.

**Phase 3.5. Outcome haptics (section 6.6).** Order matters here:

1. Fix B8 first (one line, moves Range's `haptic()` below its debounce) **and B13** (strip the duplicate
   haptic from handlers bound to a physical button). Longer patterns are unsafe until both land.
2. Extend the scheduler into a serializer: outcome patterns claim the actuator, queue one deep against
   each other, drop detents, and collapse identical patterns inside a short window.
3. Add the four patterns and wire the eleven call sites in the table.
4. Then B9, B10, B11 as cleanup.

This is the phase that pays off on iOS, so it is worth doing properly even though it looks smaller than
the wheel.

**Phase 4. The non-haptic bugs.** B3 referral (plus the Vercel env correction, plus the `.env.example`
fix, plus the vitest regression case), B4 clipboard, B5 customize cleanup.

**Phase 5. Gate.** `bunx tsc --noEmit`, `bun run check:admin`, `bun run test`. Note `bun run lint` on
`web/` is pre-existing red and is not a gate.

**The backend gates apply too**, because the analytics event edits `backend/src/config/analytics-catalog.ts`:
`cd backend && bun run typecheck && bun run lint && bun test`. Backend lint **is** a gate (L-017), unlike
web's, and `bun test` there needs `db:generate` plus `DATABASE_URL`, `JWT_SECRET` and a throwaway
`TESTING_WALLET_PK` (L-019). See section 8, and paste the exit codes into the PR, because nothing in CI
will check any of this.

---

## 8. Ship checklist

All three gates were run at baseline and are green: `bunx tsc --noEmit` (0), `bun run check:admin` (0),
`bun run test` (6 files, 48 tests). So anything red afterwards is ours.

### Blockers

- **There is no CI for `web/` at all.** `.github/workflows/` contains one file, `backend-ci.yml`, filtered
  to `paths: ['backend/**']`. A web-only PR runs zero checks. Every gate here is honour-system.
- ~~Backend gates unverified.~~ **Done, all three green.** `menu.setting_toggle` touches
  `analytics-catalog.ts`, so the three backend gates from §7 Phase 5 were actually run, not assumed: `bun
  run typecheck` (0 errors, after `bun run db:generate`, which is required on a bare checkout per root
  L-019 and is not the same thing as the forbidden destructive commands), `bun run lint` (0 errors, 3
  pre-existing warnings in untouched files), `bun test` (290 pass, 2 skip, 0 fail). `git status backend/`
  confirms only the one line in `analytics-catalog.ts` changed.
- ~~Full `HapticOverlay` sweep for the B13.6 pattern.~~ **Done, clean.** Every non-`silent` usage app-wide
  was traced: `SocialFooter`, `InstallGate`, `leaderboard.tsx`, `about.tsx`, `history.tsx`'s external-link
  rows call nothing extra. `ReceivePanel.tsx` and `LandingOverlay.tsx`'s Telegram links have a decorative
  `pointer-events-none` `<a href>` with its own `onClick` sitting under a non-silent `HapticOverlay`; this
  looks identical to B13.6 but is not the same bug, it is the same legitimate split B7 already documents
  for `ConsoleShell`: `pointer-events-none` blocks the mouse hit-test but not keyboard activation, so the
  real `<a>`'s `onClick` is the keyboard path and `HapticOverlay`'s `tabIndex={-1}` button is the pointer
  path. Two different input modalities firing once each, not one modality firing twice.
- ~~Doc edits belong in the same PR.~~ **Done.** `web/CLAUDE.md:109` now states the haptics twin of the
  uiSfx primitives rule (call `haptic()` directly only for a control that goes through none of the five
  wired primitives; the only legitimate second call is a genuinely later, distinct async signal). The
  deleted `src/admin/DESIGN.md` was restored byte-for-byte via `git show d3baadc^:web/src/admin/DESIGN.md`
  (it is not gitignored, only `docs/DESIGN-SYSTEM.md`, the file it was folded into, is), so that reference
  is true again. `ConsoleShell` is now correctly described as dead code, not the live fallback.
- ~~**`web-haptics` is currently uncommitted.**~~ **Done.** `package.json` (`"web-haptics": "^0.0.6"`) and
  `bun.lock` went in with the engine swap, so a fresh checkout builds.
- **A user-facing intensity setting cannot ship in this PR.** Settings are discrete Prisma boolean columns
  (`schema.prisma:42-44`), so a level needs a new column, and the repo forbids us running `db:push`. It
  would also touch nine files across all three pillars. **Cut it.** Ship low/mid/high as internal grading,
  keep the existing on/off toggle, revisit once someone has felt the levels on Android.

### Traps specific to this work

- **`WebHaptics.isSupported` is a static field evaluated at import**, not a getter. Today's check happens
  at call time. That is a real behavioural change, and in tests it means stubbing `navigator.vibrate` in
  `beforeEach` will not flip it. Use `vi.stubGlobal` hoisted above the imports, or `vi.resetModules()` +
  dynamic `import()`.
- **In jsdom, `isSupported` is always false**, so any ungated `haptic()` call in a component test appends
  a `<label>` to `document.body` and starts a rAF loop that `cleanup()` does not remove. The
  `isSupported` gate is what keeps the suite clean, not just iOS.
- **Never ship `debug: true`.** It constructs a second `AudioContext`, which violates the one-context
  invariant in `lib/audioContext.ts` (iOS caps how many a page can hold, each needs its own gesture
  unlock).
- **`Hw3DButton`'s default is also the admin dashboard's feel.** `src/admin/` uses the `Hw3D*` primitives,
  and `@/lib/haptics` is not in `check-admin.ts`'s banned-import list. Re-grading the default to mid
  changes `/admin` too. Probably fine, but nobody had written it down.
- **Do not `track()` from the detent scheduler.** It is continuous data by definition, which is exactly
  what L-024 exists to prevent.
- **`check:admin` is only one level deep.** It walks `src/admin/**` and reads direct import specifiers,
  never the transitive graph. So if `lib/haptics.ts` ever imported `@/components/console/consoleAudio` (a
  banned prefix), the console module would land in the admin chunk and **the gate would stay green**. This
  is why §6.5's audio-coalescing follow-up must live in `ConsoleCanvas.tsx` next to the `playSfx` loop and
  never in `lib/haptics.ts`. Worth a separate look at the gate's shallowness (L-020).
- ~~Verify a disabled `ui/Switch` still reaches its handler before adding a haptic to it.~~ **Verified,
  from the installed library's own source, not inference.** `node_modules/react-aria/dist/private/toggle/useToggle.mjs:75`
  sets `disabled: isDisabled` directly on the `inputProps` that `Switch.mjs` spreads onto the real native
  `<input>`. A disabled native input blocks click/change/keyboard at the browser level before React's
  synthetic events ever see it, so `onChange` (where B6's `haptic('mid')` lives) provably never fires when
  `isDisabled` is true. It rides the exact same guarantee the pre-existing `uiSfx()` call already relied
  on. Not B6's `aria-disabled` pattern (that one is deliberately native-`disabled`-avoiding, for the
  opposite reason: so the reject sound CAN fire); this is a genuine native-disabled control, and here that
  is correct.
- **`ui/Switch`'s `onChange` also fires on keyboard activation**, unlike the other four primitives which
  gate haptics behind a pointer path. Minor, but it is new behaviour.
- **HMR leaves a stale timer.** In dev, editing `haptics.ts` lets the old module's pending `setTimeout`
  fire against the new instance, and `enabled` resets to `true` until the auth effect re-runs. Self-
  correcting within ~105ms. Document it in the module header; do **not** add `import.meta.hot`, which
  would be the repo's first use and buys almost nothing.
- **The scheduler is not a perf win, do not claim one.** Today a fast drag fires ~60 `vibrate([4])` per
  second. The scheduler caps at ~28 flushes/sec but each carries up to 5 entries, and Chromium issues a
  `Cancel()` IPC plus one IPC per entry, so at flick speed it is *more* IPC, not less. It is bounded and
  correct, which is the actual argument.

### Analytics

One event, not four. This overhaul re-grades an already-instrumented surface, and the only genuinely
unanswerable question is whether users turn haptics off.

```ts
'menu.setting_toggle', // { key, on }
```

Reuses the existing `menu.` namespace and the one-name-plus-prop convention the catalog already documents,
covering `sound`, `haptics`, `reducedMotion` and `confirmTrades` in one bounded name. Fire it from the
existing handler in `menu/settings.tsx:38`.

Mechanics: add it to **both** `backend/src/config/analytics-catalog.ts` and `web/src/lib/track.ts`, or
ingest 400s. One unknown name rejects **the entire batch** of up to 20 events, not just the bad one. And
`check-admin.ts` extracts the array with a regex, so **the trailing comment must contain no apostrophe and
no `]`** or the gate fails with a confusing message. `// { key, on }` is safe.

**Done, and verified at the calibrated level, not just written.** `menu.setting_toggle` is live in both
files, `settings.tsx:38`'s handler calls `track('menu.setting_toggle', { key, on: value })`, and
`bun run check:admin` (which diffs the two arrays) passes. The name's acceptance was proven directly
against the real validator, not inferred:

```
$ bun -e "import { isEventName } from './src/config/analytics-catalog.ts'; console.log(isEventName('menu.setting_toggle'))"
true
```

What was **not** re-proven, deliberately: a full POST through `/a/e` needs the sealed AES-GCM envelope
handshake (`/a/hello` session issuance, then a sealed payload), which is disproportionate effort for what
this change actually touches. This change adds one allowlist entry; it does not touch the envelope or
ingest pipeline, which is pre-existing and already covered by the 290 passing backend tests. `track()` is
still disabled in demo mode, so the event genuinely cannot be observed firing on the phone during Phase
0.5; that one still needs a live desktop session against a real backend if anyone wants to watch the row
land, per L-023's spirit, though the allowlist half (the part unique to this change) is proven.

### Tests

There is no test for `lib/haptics.ts`, none for `lib/referral.ts`, and none for the console. The detent
scheduler, the riskiest change here, has zero coverage. There is also no vitest config and no setup file:
jsdom is opted into per file with a `// @vitest-environment jsdom` docblock on line 1.

`navigator.vibrate` does not exist in jsdom, and `navigator` is a getter with no setter, so
`globalThis.navigator = {...}` fails. `navigator.vibrate = vi.fn()` in `beforeEach` plus
`delete navigator.vibrate` in `afterEach` works.

For the scheduler, use `vi.useFakeTimers()` (vitest fakes `Date` and timers together, which is why the
module should read `Date.now()`), and reset state with `vi.resetModules()` + a dynamic import, mirroring
`uiSfx.test.ts`. The cases that actually catch the bug:

1. **3 detents in one move emit 3 pulses**, one `vibrate` call with `[10,25,10,25,10]`. Today's code emits
   `[4]`. This is the regression test.
2. **A move during a playing pattern does not interrupt it.** Naive per-move code kills the first pulse
   mid-flight and fails here.
3. **The first detent is synchronous**, asserted with zero timer advancement, so nobody "cleans up" the
   sync path into a `setTimeout(0)` and adds a frame of lag.
4. **Cap and drop:** `hapticDetent(50)` emits 3 pulses, and advancing 1000ms produces no further calls.
5. **Sustained rate does not accumulate:** 350ms of drag at 200 detents/sec emits ~10 pulses and the last
   call lands within one slot of the last input.
6. Toggle off mid-burst ends with `vibrate(0)` and nothing after.
7. Disabled is inert, unsupported platform does not throw.
8. **Pattern shape:** every emitted pattern is odd-length and no longer than 9, even indices are in
   `{DETENT_MS, DETENT_SMALL_MS}`, odd are `DETENT_GAP_MS`. This is the one that catches a refactor
   emitting `[gap, on, gap, on]`, which silently produces nothing.
9. **A press during a detent burst still fires.** This is the case that catches the swallowed-button
   regression from the three-class priority model, and it is the one most likely to be broken by a
   well-meaning simplification.
10. **Every preset's exact emitted array**, asserted literally. This is what would have caught Phase 1's
    PWM reshaping.
11. **jsdom stays clean:** after 40 `haptic()` calls, `document.body.querySelector('label')` is still
    null, proving the `isSupported` gate holds and the library never injected its DOM.

For the referral fix, do not introduce `vi.mock` (the repo has none). `env.VITE_APP_URL` is snapshotted at
module load from `.env`, so it cannot be stubbed. Instead extract a pure
`publicOrigin(configured, origin)` and test it directly, which is the same seam idiom `useGameRound.ts`
and `track.ts` already use. `SITE_URL` needs lifting out of `__root.tsx:23` first, since importing that
file from a test drags in the whole router.

### Accessibility

Do **not** couple haptics to `prefers-reduced-motion`. It is a visual and vestibular preference, tactile
feedback is not screen motion, and the app already ships the correct dedicated control. Mechanically it
would also be awkward: `useReducedMotion` is a hook calling `useAuth()`, while `haptic()` is a plain
module function called from raycast handlers and game engines.

The one real accessibility note is that any new haptic-bearing control must use `aria-disabled`, never the
`disabled` attribute, or the click never arrives and neither the reject sound nor the haptic fires.

Worth a moment of thought, and it is copy rather than code: nothing in the app tells a user the Haptics
toggle exists. It is one unexplained row in Settings.

### iOS on the wheel: the drag-strip idea, now history. It was wrong, and the correct mechanism shipped

**Settled. This section's core claim is false, and everything below the rule is kept only as a record of
how the wrong conclusion was reached.** The argument rested on "a switch toggles once per gesture, at the
tail, not per unit of travel." The probe contradicted it on device, and WebKit then explained why:
`updateIsSwitchVisuallyOnFromAbsoluteLocation` fires a haptic on **every** flip-line crossing, with no cap,
no debounce and no minimum interval, called from the touchmove branch of `handleTouchEvent`. There is no
"once per gesture" anywhere in the mechanism.

Two of the three blockers listed below were real and are the reason a **strip** of switches was still the
wrong shape. Only the touchstart target receives subsequent touchmoves, so switches 2..N would never see
the gesture; and the dials call `setPointerCapture()` on pointerdown. The shipped answer is one switch per
dial, not a strip, and it moves the **element** instead of asking the finger to travel:
`DialTeleportSwitch` sets `translateX(±10000px)` on each detent crossing, which relocates the flip line
under the finger and produces exactly one tick per detent. It works on 26.5+ too, because
`PointerTracking` is ungated.

The one thing this section got right, and it is load-bearing: **do not build architecture around a strip
of switches.** Everything below is superseded.

---

I had proposed laying a strip of switch elements over the knob so that dragging across them would fire a
tick per detent. The git history argues against it, and it is better to kill it now than to spend a day on
it.

When the switch overlay misfired on scroll, the team's own comments describe the behaviour precisely:

> "A native iOS switch toggles at the tail of a swipe too, and its own gesture handling can eat the
> element's own move events before React sees them" (`59a02c2`)

> "panning is reset by the next press and stays set through the toggle that ends the same gesture"

That is **one toggle per gesture, delivered at the end**, not one per unit of travel. Which makes sense:
a switch is a binary control, so a drag flips it once and then it has nowhere left to go. If it fired per
N pixels, the original bug would have been a burst of mis-navigations rather than one.

Two more blockers, both inferred but well grounded. iOS captures post-`touchstart` moves to the element
that received the `touchstart`, so switches 2..N in a strip would likely never see the gesture at all,
which is independently what "its own gesture handling can eat the element's own move events" describes.
And the dials already call `canvas.setPointerCapture()` on pointerdown, so any DOM switch over them fights
the existing raycast drag.

**What the conclusion actually turned out to be, replacing both bullets this section used to end on:**

- Per-detent iOS haptics are achievable on **every** iOS from 18 up, including 26.5+, through a genuine
  touch on a rendered switch. Not through a drag strip, and not through the programmatic `.click()` path,
  which is dead on 26.5+.
- The finger does not even need to travel. The teleport moves the flip line instead, and a resting finger's
  own tremor delivers enough touchmoves to clock it (§3.5).
- It does not fight `setPointerCapture`, because the switch is a real DOM element sitting above the canvas
  and it owns the touch, rather than competing with the raycast for the same one.

Shipped as `DialTeleportSwitch` in `ConsoleCanvas.tsx`, sharing the dials' one detent counter so the tick,
the roller sound and the value can never disagree.

---

## 9. Running `web/` on your phone

Your Mac's LAN IP was `192.168.1.3` at the time of writing and it changes, so always re-check with `ipconfig getifaddr en0`. The phone must be on the
same WiFi, and the network must not have AP/client isolation.

**The fastest path, zero file edits, no backend, no wallet:**

```bash
cd /Users/macbookair/Documents/pips/pips/web
VITE_DEMO_MODE=true bun run dev --host
```

Then open `http://<that-ip>:3200` on the phone. Allow the macOS incoming-connections prompt if it
appears.

Why this works: `vite.config.ts` has no `server` block and `package.json`'s dev script has no `--host`, so
today the server binds to localhost only. `--host` is the whole fix. Vite allows bare IP hosts by default,
so no `allowedHosts` entry is needed (a tunnel hostname would need one). Demo mode mocks the entire API
(`lib/demo.ts`) and bypasses Privy (`lib/privy.tsx:16`), so the console and games are fully playable with
nothing else running.

Optional, to make it stick, in `vite.config.ts`:

```ts
server: { host: true },
```

**On the phone, before you judge anything:**

1. The **Install PIPS** overlay shows first on any mobile browser. Tap **Continue in browser**.
2. Take the phone **off Silent and off Do Not Disturb**. `navigator.vibrate` is a no-op in either, and
   that is indistinguishable from broken code.
3. Tap once (the landing START) before expecting any buzz. Chrome requires sticky user activation and
   ignores every `vibrate()` before the page's first tap.
4. Check **Menu > Settings > Haptics** is on.
5. Hold the phone in your palm, not flat on a desk. At these durations a desk swallows the pulse.

**What breaks over plain LAN http** (all pre-existing, none of it blocks haptics work): clipboard copy in
referral/deposit/transactions (insecure origin), the analytics envelope falls back to plaintext (already
handled and tested), the PWA install prompt, and Privy Google login. If you need any of those on device,
use a Vercel preview deploy rather than a self-signed cert. HTTPS on a LAN IP forces the backend onto TLS
too or every API call is blocked as mixed content.

The backend needs no changes: it already listens on `0.0.0.0` and dev CORS is `*`.

---

## 9.5. What we could not verify

Two categories, and both matter when reading this file.

**Documentation that does not exist in this checkout.** `/docs/` and `/bigdev/` are gitignored
"local-only workspaces" and were never committed, so they live only on whoever's machine wrote them:

- `docs/DESIGN.md`, the canonical visual system, referenced from root `CLAUDE.md:9`, `web/CLAUDE.md:11`
  and about ten source comments.
- `docs/SCREEN.md`, `docs/FLOW.md`, `docs/DESIGN-SYSTEM.md`.
- `docs/CURRENT_PRODUCT_OVERVIEW.md`, which root `CLAUDE.md` says enumerates "every route, game, drawer
  page, **control binding**, API group, and known seam". That is the most painful loss for this work.
- All of `bigdev/plans/`, notably `06-GAMES.md` ("the games, **console bindings**, the 60fps chart").
- `.claude/progress.md`.
- ~~`web/src/admin/DESIGN.md`, deleted in `d3baadc`, recoverable~~ **Restored.** It was folded into the
  absent `docs/DESIGN-SYSTEM.md` and is not itself gitignored, so `git show d3baadc^:web/src/admin/DESIGN.md`
  put the real 1426 lines back on disk verbatim. It is the source of the press-physics and restraint
  quotes used in §6, and `web/CLAUDE.md:195`'s reference to it is true again.

Nothing in the surviving corpus prescribes haptic strength, pattern vocabulary, or per-control assignment.
The only haptics directive anywhere is `web/CLAUDE.md:19`, "Use `web-haptics` for tactile feedback".
**So §6 and §6.6 are vocabulary this document is authoring, not doctrine it is following.** If
`docs/DESIGN.md` turns up and contradicts them, it wins.

~~Two related drifts worth fixing in the same PR: `web/CLAUDE.md:194`... `ConsoleShell` described as the
live fallback.~~ **Both fixed.** The `DESIGN.md` line is true again per the restoration above.
`web/CLAUDE.md`'s structure tree now says `ConsoleShell.tsx` is "written as a fallback but currently
dead: nothing mounts it... verify before building on it."

~~One rule that should be written down... Add that sentence to `web/CLAUDE.md` in this PR.~~ **Done.**
`web/CLAUDE.md:109`'s paragraph now states the haptics twin of the uiSfx primitives rule directly: call
`haptic()` only for a control through none of the five wired primitives, and the one legitimate second
call is a later async signal, never a synchronous duplicate (the exact shape B13.6 catalogs).

**Claims that were tested and how they landed.** Phase 0.5 ran on iPhone iOS 26.3 (§7 Phase 0.5 results).
Of the five: `appearance: none` **did not** kill the iOS tick (B6.5 resolved, the console buttons were
never dead); whether `display: none` kills it came back genuinely ambiguous but turned out moot, since
production never exercises that code path (§3); the levels being indistinguishable on iOS was never
directly tested (no preset-comparison question was in the probe, only raw-duration comparison, which
iOS's total lack of `navigator.vibrate` made moot on its own) but the reasoning behind it stands
independent of any test.

~~Two remain genuinely unverified.~~ **Updated 2026-08-14.** The drag-strip question is answered and
answered against this document: the flip fires per crossing, not once per gesture, and the corrected
mechanism shipped (§3.5, §8). What is still genuinely unmeasured is smaller and worth stating plainly:

- **`DETENT_GAP_MS = 25` clearing the actuator ring-down** is derived, not measured. No probe tested it.
- **Whether tremor alone sustains touchmoves over a full 25s hold.** Section 13 measured 5.9/sec at 2.8px
  over 1.7s, and Section 14's two 30s runs both fired 4 of 4 beats at t=25s but with 109-176px of
  displacement, so they prove no decay for a *moving* finger and say nothing about a still one. Redo
  Section 14 with max displacement under ~5px to close it.
- **Second-finger tremor.** Two switches arm independently in WebKit, so a resting anchor finger could
  clock a rhythm while another finger taps elsewhere. That is verified in source and unverified on glass.

## 10. Open questions

1. ~~**"scroll wheel amount yang kecil, mid"**, is that the small amount wheel or small increments?~~
   **Answered 2026-08-14: the small stake drum.** The same dial came up again when he asked for the end
   stop back on "the bet wheel", and it was confirmed against code rather than by name: `kind:
   'numberWheel'`, `SMALL_ROLLER.MP3`, `amountAnchorRef`, and `ConsoleCanvas.tsx:53`'s own comment says
   "the user wanted **the bet wheel** slower and smoother" about that dial's constant. The big game roller
   is `kind: 'knob'` / `KNOB_RUBBER.mp3`. Two dials, and this document mixed them up once already, so
   confirm by pointing at the part, never by name.
2. ~~Which phone is QA running on?~~ **Answered: iPhone on iOS 26.3.** So the programmatic path is
   available on the dev device but not on 26.5+ users, which is exactly the trap described in section 3.
   An Android device is still required to sign off the levels and the wheel, because iOS has no strength
   axis and because the dev phone's behaviour is not the shipped behaviour.
3. ~~Is a haptics intensity setting wanted?~~ **Still deferred, for a reason that outlives the
   permission question.** The user has since cleared the `db:push` restriction, so the mechanical blocker
   is gone. The substantive one is not: nobody has felt whether 3 distinguishable levels even survive
   contact with a real motor (§6.5's own `DETENT_MS` vs `DETENT_SMALL_MS` caveat is the same open question
   in miniature), and iOS has no strength axis to put a setting in front of at all. Adding a schema column
   for an axis that might turn out to be one indistinguishable blur, before Phase 0.5 and an Android
   session have run, is the kind of unforced complexity worth avoiding. Ship the levels as internal
   grading, run the device passes, then decide.
4. **Should a bigger payout get a bigger buzz?** The mobile-games literature says scaling the haptic to
   the win size works, and it does. It is also the mechanic most associated with slot machines, and PIPS
   is a trading game with real money, so it is a product call rather than an engineering one. If yes, do
   two tiers (`win` and `winBig`, one extra heavy pulse above some multiple), never a continuum, because
   anything more granular is imagined rather than felt.
5. **Does each game want its own win rhythm?** Section 6.6 argues for one shared grammar with at most a
   varied final pulse. Confirm, because the audio side does the opposite and the inconsistency is
   deliberate.
6. **Kelvin's original message cuts off mid-sentence.** The Menu Drawer bullet reads "Semua Button2
   action... mid. termasuk toggle juga" followed by a bare, unexplained "- me" on its own line. Every
   grading decision for the drawer in this document (§6) proceeds as if that bullet ended at "termasuk
   toggle juga", i.e. as if nothing more was meant. Flagged the first time this doc was researched and
   never actually resolved since; ask Kelvin what the dropped line was before treating §6's drawer
   coverage as complete.
