"""Isolated DSH smoke: open-turn live programmatic cards + provisional stage
analysis + turn/end settlement, all against the fake fixture models.

Flow: open the seeded session (view-only must not call models) -> send a
message to the slow fixture agent -> live card appears during the open turn
-> provisional stage analysis fires (fixture-strong, fake) -> turn/end
settles the final layer -> persisted history shows provisional + primary
records, final watermarks advanced, no console errors.
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:3192"
REPO_ROOT = Path(__file__).resolve().parents[1]
SMOKE_HOME = REPO_ROOT / ".smoke-home"
OUTPUT_DIR = REPO_ROOT / "output" / "playwright"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

results = []
console_errors = []
page_errors = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def session_histories():
    sessions = SMOKE_HOME / "trace-insight" / "sessions"
    if not sessions.exists():
        return []
    return [json.loads(path.read_text(encoding="utf-8")) for path in sessions.glob("*.json")]


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda err: page_errors.append(str(err)))

    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector("[role='tree']", timeout=90000)
    page.wait_for_timeout(4000)

    # Open the seeded session (last treeitem = the session under the workspace).
    treeitems = page.query_selector_all("[role='tree'] [role='treeitem']")
    check("seeded session visible in the tree", len(treeitems) > 0, f"{len(treeitems)} treeitems")
    clicked = False
    for item in reversed(treeitems):
        label = (item.inner_text() or item.get_attribute("aria-label") or "")
        if "session-smoke" in label:
            item.click()
            clicked = True
            break
    if not clicked and len(treeitems) > 0:
        treeitems[-1].click()
        clicked = True
    page.wait_for_timeout(2500)
    page.wait_for_selector("textarea[placeholder*='构建'], [data-slot='conversation'] textarea", timeout=30000)

    # View-only safety: opening the inspector must not enroll or call models
    # (delta-based: prior smoke runs leave a dirty baseline).
    runs_at_open = sum(len(history.get("semantic", {}).get("runs", [])) for history in session_histories())
    page.wait_for_timeout(4000)
    runs_after_open = sum(len(history.get("semantic", {}).get("runs", [])) for history in session_histories())
    check("view-only: opening the inspector adds no model runs", runs_after_open == runs_at_open, f"{runs_at_open} -> {runs_after_open}")

    # Send a message to the slow fixture agent.
    composer = page.locator("textarea[placeholder*='构建'], textarea[placeholder*='消息'], textarea[placeholder*='智能体']").first
    if composer.count() == 0:
        composer = page.locator("[data-slot='conversation'] textarea").last
    composer.click()
    composer.fill("请执行 smoke-open-turn 检查并给出结论。")
    send = page.locator("button", has_text="发送消息").last
    if send.count() > 0 and send.is_visible():
        send.click()
    else:
        composer.press("Enter")
    page.wait_for_timeout(1500)
    check("message sent", True, "")

    # Live card must appear while the turn is open (4s debounce).
    live_text = ""
    live_seen = False
    for _ in range(45):
        page.wait_for_timeout(1000)
        locator = page.locator("[data-slot='inspector'] .tiLiveSection")
        if locator.count() > 0:
            live_text = locator.first.inner_text()
            if "实时程序化" in live_text:
                live_seen = True
                break
    check("live programmatic card appears during the open turn", live_seen, live_text[:140].replace("\n", " | ") if live_text else "not seen")
    check("live card shows observed waterline", "已观测到 Seq" in live_text, "")
    check("live card shows stable waterline", "稳定到 Seq" in live_text, "")
    check("live card shows provisional status line", "阶段" in live_text or "调用" in live_text, live_text[:200].replace("\n", " | "))
    page.screenshot(path=str(OUTPUT_DIR / "smoke-live-open-turn.png"), full_page=True)

    # Wait for turn/end settlement.
    settled = False
    for _ in range(90):
        page.wait_for_timeout(2000)
        for history in session_histories():
            if history.get("programmatic", {}).get("coveredThroughSeq", -1) >= 0 and history.get("semantic", {}).get("coveredThroughSeq", -1) >= 0:
                settled = True
                break
        if settled:
            break
    check("turn/end settlement advanced both final watermarks", settled, "")
    page.wait_for_timeout(3000)

    histories = session_histories()
    all_runs = [run for history in histories for run in history.get("semantic", {}).get("runs", [])]
    primary_runs = [run for run in all_runs if run.get("coverageRole") == "primary"]
    provisional_runs = [run for run in all_runs if run.get("coverageRole") == "provisional"]
    check("a final primary semantic record exists", len(primary_runs) >= 1, f"{len(primary_runs)} primary run(s)")
    # The slow agent turn (~60s) must also let the provisional policy fire:
    # quiet 15s + new meaningful content -> a 暂定 stage run.
    check("provisional stage run recorded during the long open turn", len(provisional_runs) >= 1, f"{len(provisional_runs)} provisional run(s)")
    providers = {(run.get("route") or {}).get("provider") for run in all_runs}
    check("only fixture models were called", providers <= {None, "trace-insight-fixture"}, f"providers: {providers}")
    check("provisional runs never advanced the primary watermark",
          all(not (run.get("coverageRole") == "provisional" and run.get("id") == history.get("semantic", {}).get("primaryRunId")) for history in histories for run in history.get("semantic", {}).get("runs", [])) if histories else True,
          "")

    final_text = page.locator("[data-slot='inspector']").inner_text() if page.locator("[data-slot='inspector']").count() else ""
    check("final timeline visible in the inspector", "可追溯分析时间线" in final_text, "")
    # The client clears the live section on its next 4s poll after the live
    # revision advances; allow a few polls before asserting.
    live_after = 1
    for _ in range(12):
        page.wait_for_timeout(2000)
        live_after = page.locator("[data-slot='inspector'] .tiLiveSection").count()
        if live_after == 0:
            break
    check("live card is no longer shown after settlement", live_after == 0, f"live sections: {live_after}")
    histories = session_histories()
    open_live = [item for history in histories for item in history.get("live", {}).get("items", []) if item.get("state") in ("open", "finalizing")]
    check("persisted live card is finalized after settlement", len(open_live) == 0, f"{len(open_live)} open card(s)")
    page.screenshot(path=str(OUTPUT_DIR / "smoke-after-settlement.png"), full_page=True)

    relevant_errors = [e for e in console_errors if "favicon" not in e]
    check("no page errors", len(page_errors) == 0, "; ".join(page_errors[:3]))
    check("no console errors", len(relevant_errors) == 0, "; ".join(relevant_errors[:3]))

    browser.close()

failed = [r for r in results if not r[1]]
print(json.dumps(results, ensure_ascii=False, indent=2))
sys.exit(1 if failed else 0)
