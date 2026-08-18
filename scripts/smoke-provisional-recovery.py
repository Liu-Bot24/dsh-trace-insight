"""Smoke: restart recovery rebuilds the live card for a long-open turn and the
provisional quiet policy fires a real fixture stage analysis, without touching
the primary watermarks."""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:3192"
REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE_HOME = REPO_ROOT / ".smoke-home"
OUTPUT_DIR = REPO_ROOT / "output" / "playwright"

results = []
console_errors = []
page_errors = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def open_turn_history():
    sessions = SMOKE_HOME / "trace-insight" / "sessions"
    for path in sessions.glob("*.json"):
        history = json.loads(path.read_text(encoding="utf-8"))
        if history.get("sessionId") == "session-smoke0002-0000-0000-0000-000000000002":
            return history, path
    return None, None


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda err: page_errors.append(str(err)))

    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector("[role='tree']", timeout=90000)
    page.wait_for_timeout(6000)

    # Startup recovery + provisional policy run in the background; poll the file.
    settled = False
    for _ in range(45):
        page.wait_for_timeout(2000)
        history, _ = open_turn_history()
        if not history:
            continue
        provisional = history.get("live", {}).get("provisional", {})
        through = provisional.get("throughSeq")
        if isinstance(through, int) and through >= 0:
            settled = True
            break
    history, path = open_turn_history()
    provisional = history.get("live", {}).get("provisional", {}) if history else {}
    check("restart recovery advanced the provisional waterline", settled, f"throughSeq={provisional.get('throughSeq')}")
    check("recovery rebuilt the live card as open", bool(history and history["live"]["items"] and history["live"]["items"][0].get("state") == "open"), "")
    check("recovery rebuilt the live report", bool(history and history["live"]["items"] and history["live"]["items"][0].get("report")), "")
    provisional_runs = [run for run in history.get("semantic", {}).get("runs", []) if run.get("coverageRole") == "provisional"] if history else []
    check("a real provisional stage run was recorded", len(provisional_runs) >= 1, f"{len(provisional_runs)} provisional run(s)")
    check("provisional did not advance the final programmatic watermark", bool(history and history["programmatic"]["coveredThroughSeq"] == -1), "")
    check("provisional did not advance the final semantic watermark", bool(history and history["semantic"]["coveredThroughSeq"] == -1), "")
    providers = {(run.get("route") or {}).get("provider") for run in provisional_runs}
    check("only fixture models were called", providers <= {None, "trace-insight-fixture"}, f"providers: {providers}")
    check("provisional run records trigger reason", all(run.get("trigger") for run in provisional_runs), "")

    # UI: open the session and see the live card + stage status.
    treeitems = page.query_selector_all("[role='tree'] [role='treeitem']")
    for item in reversed(treeitems):
        label = (item.get_attribute("aria-label") or item.inner_text() or "")
        if "session-smoke0002" in label or "持续检查" in label:
            item.click()
            break
    page.wait_for_timeout(5000)
    live = page.locator("[data-slot='inspector'] .tiLiveSection")
    live_text = live.first.inner_text() if live.count() else ""
    check("live card visible in the inspector", "实时程序化" in live_text, live_text[:120].replace("\n", " | "))
    check("live card shows the provisional stage status", "已解读到 Seq" in live_text or "已调用" in live_text, "")
    page.screenshot(path=str(OUTPUT_DIR / "smoke-provisional-recovery.png"), full_page=True)

    relevant_errors = [e for e in console_errors if "favicon" not in e]
    check("no page errors", len(page_errors) == 0, "; ".join(page_errors[:3]))
    check("no console errors", len(relevant_errors) == 0, "; ".join(relevant_errors[:3]))
    browser.close()

failed = [r for r in results if not r[1]]
print(json.dumps(results, ensure_ascii=False, indent=2))
sys.exit(1 if failed else 0)
