import argparse
from pathlib import Path
from time import monotonic, sleep

from playwright.sync_api import sync_playwright


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:3200")
    parser.add_argument("--action-x", type=float)
    parser.add_argument("--action-y", type=float)
    parser.add_argument("--candle-crash", action="store_true")
    parser.add_argument("--reflap-at", type=float)
    args = parser.parse_args()

    output = Path("e2e-screenshots/flows/desktop")
    output.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch()
        context = browser.new_context(viewport={"width": 1200, "height": 900})
        page = context.new_page()
        page.route("**/sw.js", lambda route: route.abort())
        page.goto(f"{args.base_url}/games/candle-hop", wait_until="networkidle")
        page.evaluate("window.print = () => {}")
        sleep(2)
        page.screenshot(path=output / "01-title.png")

        for index, canvas in enumerate(page.locator("canvas").all()):
            print(f"canvas[{index}]={canvas.bounding_box()}")

        if args.action_x is not None and args.action_y is not None:
            if args.candle_crash:
                page.evaluate("window.__pipsRandom = Math.random; Math.random = () => 0.5")
            page.mouse.click(args.action_x, args.action_y)
            started = monotonic()

            if args.candle_crash:
                sleep(0.05)
                page.evaluate("Math.random = window.__pipsRandom")
                next_flap = 0.25
                crashed = False

                while monotonic() - started < 10:
                    elapsed = monotonic() - started
                    if elapsed >= next_flap:
                        page.mouse.click(args.action_x, args.action_y)
                        next_flap += 0.65 if elapsed < 5 else 0.18

                    red_delta = page.locator("canvas").first.evaluate(
                        """canvas => {
                            const ctx = canvas.getContext('2d')
                            const points = [
                                [3, 3],
                                [canvas.width - 4, 3],
                                [3, canvas.height - 4],
                                [canvas.width - 4, canvas.height - 4],
                                [3, canvas.height / 2],
                                [canvas.width - 4, canvas.height / 2],
                            ]
                            let total = 0
                            for (const [x, y] of points) {
                                const pixel = ctx.getImageData(x, y, 1, 1).data
                                total += pixel[0] - pixel[1]
                            }
                            return total / points.length
                        }""",
                    )
                    if red_delta > 18:
                        crashed = True
                        break
                    sleep(0.02)

                if not crashed:
                    raise RuntimeError("Candle collision was not detected")

                page.screenshot(path=output / "02-candle-impact.png")
                for index, delay in enumerate((0.12, 0.32, 0.62, 1.25), start=3):
                    sleep(delay if index == 3 else delay - (0.12, 0.32, 0.62, 1.25)[index - 4])
                    page.screenshot(path=output / f"{index:02d}-candle-impact-{delay:.2f}s.png")
            else:
                if args.reflap_at is None:
                    events = [(delay, "capture") for delay in (0.15, 0.3, 0.55, 0.85, 1.2, 1.8)]
                else:
                    events = [
                        (args.reflap_at - 0.04, "capture"),
                        (args.reflap_at, "flap"),
                        (args.reflap_at + 0.03, "capture"),
                        (args.reflap_at + 0.1, "capture"),
                        (args.reflap_at + 0.2, "capture"),
                    ]

                capture_index = 2
                for delay, event in events:
                    sleep(max(0, started + delay - monotonic()))
                    if event == "flap":
                        page.mouse.click(args.action_x, args.action_y)
                    else:
                        page.screenshot(path=output / f"{capture_index:02d}-after-play-{delay:.2f}s.png")
                        capture_index += 1

        context.close()
        browser.close()


if __name__ == "__main__":
    main()
