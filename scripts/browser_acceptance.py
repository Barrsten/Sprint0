"""Run on the user's local/reference workstation; never infers reference hardware.
Requires: pip install playwright && python -m playwright install chromium.
Server must already be running. Use --headed to visually inspect during the run.
"""

import argparse, json
from pathlib import Path
from playwright.sync_api import sync_playwright


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--base", default="http://127.0.0.1:8080")
    p.add_argument("--headed", action="store_true")
    p.add_argument("--model", default="/models/km/model.glb")
    p.add_argument("--output", type=Path, default=Path("reports/browser"))
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    errors = []
    checks = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not a.headed)
        page = browser.new_page(viewport={"width": 1600, "height": 1000})
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(a.base + "/?model=/models/small/model.glb&test=1")
        page.wait_for_function(
            "document.querySelector('#status').textContent.startsWith('Готово')",
            timeout=60000,
        )
        page.screenshot(path=str(a.output / "small-model.png"))
        targets = page.evaluate("window.__ifcTest.targets()")
        assert len({t["guid"] for t in targets}) >= 2, "two distinct visible instances"
        first = targets[0]
        second = next(t for t in targets if t["guid"] != first["guid"])
        for t in [first, second]:
            page.mouse.click(t["x"], t["y"])
            page.wait_for_function(
                '(guid)=>JSON.parse(document.querySelector("#properties").textContent).guid===guid',
                arg=t["guid"],
            )
            state = page.evaluate("window.__ifcTest.state()")
            assert state["selectedGuid"] == t["guid"]
            assert state["highlightedElements"] == 1
            checks.append(
                {"test": "pointer-click", "guid": t["guid"], "status": "PASS"}
            )
        page.screenshot(path=str(a.output / "single-instance-selection.png"))
        page.get_by_role("button", name="Isolate selected", exact=True).click()
        assert page.evaluate("window.__ifcTest.state().isolated")
        page.screenshot(path=str(a.output / "isolate.png"))
        page.get_by_role("button", name="Show all", exact=True).click()
        assert not page.evaluate("window.__ifcTest.state().isolated")
        page.get_by_role("button", name="Hide selected", exact=True).click()
        assert page.evaluate("window.__ifcTest.state().hiddenCount") == 1
        page.get_by_role("button", name="Show all", exact=True).click()
        assert page.evaluate("window.__ifcTest.state().hiddenCount") == 0
        before = page.evaluate("window.__ifcTest.state().camera")
        page.mouse.move(400, 400)
        page.mouse.wheel(0, -200)
        page.wait_for_timeout(300)
        assert page.evaluate("window.__ifcTest.state().camera") != before
        page.mouse.move(400, 400)
        page.mouse.down()
        page.mouse.move(500, 450, steps=10)
        page.mouse.up()
        page.wait_for_timeout(300)
        assert page.evaluate("window.__ifcTest.state().camera") != before
        page.goto(a.base + "/?model=" + a.model + "&benchmark=1&cold=1")
        page.wait_for_function(
            "document.querySelector('#benchmark-report').textContent.length>0",
            timeout=300000,
        )
        report = json.loads(page.locator("#benchmark-report").inner_text())
        assert report["navigation"]["durationMs"] >= 10000
        assert report["navigation"]["nonemptyScene"]
        assert report["guidSelection"]["status"] == "PASS"
        assert not errors, errors
        (a.output / "benchmark-report.json").write_text(
            json.dumps(report, ensure_ascii=False, indent=2)
        )
        (a.output / "browser-acceptance.json").write_text(
            json.dumps(
                {"status": "PASS", "checks": checks, "consoleErrors": errors},
                ensure_ascii=False,
                indent=2,
            )
        )
        page.screenshot(path=str(a.output / "km-model.png"))
        browser.close()


if __name__ == "__main__":
    main()
