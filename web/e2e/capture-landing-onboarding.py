#!/usr/bin/env python3
# Visual QA + animation-smoothness probe for the Pips landing -> onboarding -> welcome arc.
# Runs fully offline via demo mode (no backend, no chain). Walks the whole phase machine, captures
# stills at each beat across three viewports, and samples rAF frame cadence during every transition
# so we have objective evidence of smoothness (long frames = stutter), not just screenshots.
#
# Usage: /opt/homebrew/opt/python@3.14/bin/python3.14 web/e2e/capture-landing-onboarding.py
import json
import os
import time

from playwright.sync_api import sync_playwright

BASE = "http://localhost:3200"
OUT = os.path.join(os.path.dirname(__file__), "..", "e2e-screenshots", "flow")

VIEWPORTS = {
    "mobile": {"w": 390, "h": 844, "touch": True},   # the real target: device fills the screen
    "desktop": {"w": 1280, "h": 800, "touch": False},  # the floating product-shot framing
    "small": {"w": 360, "h": 740, "touch": True},     # tight-width stress (must survive ~360px)
}

# Headed + anti-throttling so rAF runs at the real display rate. Headless Chromium throttles rAF to a
# few fps with no compositor, which both falsifies the frame probe and stalls the dt-clamped camera
# tweens mid-animation. A real window driving frames at 60fps is the only way to judge smoothness.
LAUNCH_ARGS = [
    "--use-angle=metal",  # force hardware GL (Apple Metal); Playwright defaults to SwiftShader (software)
    "--enable-gpu",
    "--ignore-gpu-blocklist",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
]

# rAF frame-cadence probe + offline flags + service-worker block, installed before any page script.
INIT = r"""
try {
  localStorage.setItem('pips_demo', '1');     // force demo mode (fully offline)
  localStorage.setItem('pips_welcomed', '1'); // suppress the games-home welcome toast
} catch (e) {}

window.__pf = { t: [] };
(function rec(ts){ var a = window.__pf.t; a.push(ts); if (a.length > 2000) a.shift(); requestAnimationFrame(rec); })();
window.__pfReset = function(){ window.__pf.t = []; };
window.__pfStats = function(){
  var a = window.__pf.t, d = [];
  for (var i = 1; i < a.length; i++) d.push(a[i] - a[i-1]);
  if (d.length < 2) return null;
  d.sort(function(x,y){ return x - y; });
  var sum = d.reduce(function(s,x){ return s + x; }, 0);
  function pct(p){ return d[Math.min(d.length - 1, Math.floor(p/100 * d.length))]; }
  var r2 = function(n){ return Math.round(n * 100) / 100; };
  return {
    frames: d.length,
    fps: r2(1000 / (sum / d.length)),
    avgMs: r2(sum / d.length),
    p50: r2(pct(50)),
    p95: r2(pct(95)),
    maxMs: r2(d[d.length - 1]),
    over32: d.filter(function(x){ return x > 32; }).length,  // dropped vs 60fps
    over50: d.filter(function(x){ return x > 50; }).length,  // visible jank
  };
};
"""


def shot(page, vp, name):
    d = os.path.join(OUT, vp)
    os.makedirs(d, exist_ok=True)
    page.screenshot(path=os.path.join(d, name + ".png"))


def sample(page, ms):
    """Reset the frame probe, let the scene run `ms`, return cadence stats."""
    page.evaluate("window.__pfReset && window.__pfReset()")
    page.wait_for_timeout(ms)
    return page.evaluate("window.__pfStats && window.__pfStats()")


def run_arc(browser, vp_name, vp):
    ctx = browser.new_context(
        viewport={"width": vp["w"], "height": vp["h"]},
        device_scale_factor=2,
        has_touch=vp["touch"],
        color_scheme="dark",
    )
    ctx.add_init_script(INIT)
    page = ctx.new_page()
    page.route("**/sw.js", lambda r: r.abort())
    fps = {}

    # --- Landing door (demo) ---
    page.goto(BASE + "/games", wait_until="domcontentloaded")
    page.bring_to_front()  # foreground the window so rAF isn't background-throttled
    page.evaluate("window.focus && window.focus()")
    page.wait_for_selector("button:has-text('START')", timeout=20000)
    page.wait_for_timeout(1500)  # hydration + first paint
    page.evaluate("window.print = function(){}")
    fps["landing_idle"] = sample(page, 2600)  # 3D float + (desktop) drifting field at rest
    shot(page, vp_name, "01-landing-door")

    # Force first-run onboarding: null the demo username (fresh state seeds it to 'pips'), reload.
    patched = page.evaluate(
        """() => {
            const raw = localStorage.getItem('pips_demo_state');
            if (!raw) return 'no-state';
            const s = JSON.parse(raw); s.username = null;
            localStorage.setItem('pips_demo_state', JSON.stringify(s));
            return 'ok:v' + s.v;
        }"""
    )
    print(f"    [{vp_name}] username patch -> {patched}")
    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("button:has-text('START')", timeout=20000)
    page.wait_for_timeout(800)
    page.evaluate("window.print = function(){}")

    # --- Enter: the device settles hero -> app (heroT 1->0, ~900ms) ---
    page.evaluate("window.__pfReset && window.__pfReset()")
    page.click("button:has-text('START')")
    page.wait_for_timeout(1100)
    fps["enter_settle"] = page.evaluate("window.__pfStats && window.__pfStats()")

    # --- Onboarding step 1: username ---
    page.wait_for_selector("text=Pick your handle", timeout=10000)
    page.wait_for_selector("input[aria-label='Username']", timeout=10000)
    shot(page, vp_name, "02-username-empty")
    # Exercise the real fix: blur, then TAP the screen (which hits the canvas on top) to focus the
    # field, then type. This is the path that was impossible before, so the arc doubles as a regression.
    page.evaluate("() => { const i = document.querySelector('input[aria-label=\"Username\"]'); if (i) i.blur(); }")
    rect = page.evaluate(
        "() => { const r = document.querySelector('.console-screen-content').getBoundingClientRect();"
        " return { x: r.left + r.width / 2, y: r.top + r.height * 0.42 }; }"
    )
    page.mouse.click(rect["x"], rect["y"])
    page.wait_for_timeout(120)
    focused = page.evaluate("() => document.activeElement && document.activeElement.tagName")
    page.keyboard.type("satoshi")
    page.wait_for_timeout(300)
    typed = page.evaluate(
        "() => { const i = document.querySelector('input[aria-label=\"Username\"]'); return i ? i.value : null; }"
    )
    print(f"    [{vp_name}] screen-tap focus -> {focused}, typed -> {typed!r}")
    shot(page, vp_name, "03-username-filled")  # shows 'Looks good' + the lit CONTINUE button

    # --- Onboarding step 2: theme picker (motion slide-up ~500ms) ---
    page.evaluate("window.__pfReset && window.__pfReset()")
    page.locator("input[aria-label='Username']").press("Enter")
    page.wait_for_selector("text=Make it yours", timeout=10000)
    page.wait_for_timeout(700)
    fps["themepicker_slide"] = page.evaluate("window.__pfStats && window.__pfStats()")
    page.wait_for_selector("button:has-text('Continue')", timeout=10000)
    shot(page, vp_name, "04-theme-picker")

    # Repaint the live device by selecting another skin (best-effort; rail markup may vary).
    try:
        rail = page.locator("button:has-text('Continue')").locator("xpath=../preceding-sibling::*[1]")
        swatches = rail.locator("button")
        n = swatches.count()
        if n >= 2:
            page.evaluate("window.__pfReset && window.__pfReset()")
            swatches.nth(n - 1).click()
            page.wait_for_timeout(500)
            fps["theme_repaint"] = page.evaluate("window.__pfStats && window.__pfStats()")
            shot(page, vp_name, "05-theme-picker-alt")
    except Exception as e:
        print(f"    [{vp_name}] theme repaint skipped: {e}")

    # --- Onboarding step 3: welcome (camera push-in 700ms, hold 1100ms, out 700ms) ---
    page.evaluate("window.__pfReset && window.__pfReset()")
    page.click("button:has-text('Continue')")
    page.wait_for_selector("text=Have fun", timeout=10000)
    page.wait_for_timeout(1000)  # in-phase done (700ms), mid-hold: camera fully pushed in, logo popped
    fps["welcome_zoom"] = page.evaluate("window.__pfStats && window.__pfStats()")
    shot(page, vp_name, "06-welcome")

    # --- Auto-advance to the app (out phase -> onWelcomeComplete -> refresh -> games home) ---
    try:
        page.wait_for_selector("text=Have fun", state="detached", timeout=6000)
        page.wait_for_timeout(1200)
        shot(page, vp_name, "07-app-home")
    except Exception as e:
        print(f"    [{vp_name}] app-home capture skipped: {e}")

    ctx.close()
    return fps


def verdict(stats):
    """Flag a transition as smooth/jank from frame cadence."""
    if not stats:
        return "no-data"
    if stats["over50"] == 0 and stats["p95"] <= 24:
        return "SMOOTH"
    if stats["over50"] <= 1 and stats["p95"] <= 34:
        return "ok"
    return "JANK"


def main():
    os.makedirs(OUT, exist_ok=True)
    results = {}
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False, args=LAUNCH_ARGS)
        for name, vp in VIEWPORTS.items():
            print(f"==> {name} ({vp['w']}x{vp['h']})")
            try:
                results[name] = run_arc(browser, name, vp)
            except Exception as e:
                print(f"    [{name}] FAILED: {e}")
                results[name] = {"error": str(e)}
        browser.close()

    print("\n===== FRAME-CADENCE SUMMARY (rAF deltas; over50 = visible jank) =====")
    for name, fps in results.items():
        print(f"\n[{name}]")
        if "error" in fps:
            print(f"  ERROR: {fps['error']}")
            continue
        for stage, s in fps.items():
            if not s:
                print(f"  {stage:18s} no-data")
                continue
            print(
                f"  {stage:18s} {verdict(s):7s} fps~{s['fps']:5.1f} "
                f"avg {s['avgMs']:5.2f}ms p95 {s['p95']:5.2f}ms max {s['maxMs']:6.2f}ms "
                f"over32 {s['over32']:2d} over50 {s['over50']:2d}"
            )
    print(f"\nScreenshots: {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
