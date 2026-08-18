"""E2E check: trace-insight as a right-side inspector in the DSH shell.

Drives a headless Chromium against the live GUI (http://127.0.0.1:3080):
 1. collects console/page errors,
 2. opens a real session,
 3. asserts the 解读 tab is gone while 对话/轨迹 remain,
 4. asserts the inspector rail renders beside the conversation column,
 5. free-drags the rail boundary (no width clamping),
 6. checks the expandable menus (advanced filter, ops disclosures) for
    horizontal overflow inside the rail,
 7. asserts the 设置 tab hosts the four ops disclosures,
 8. toggles the rail closed/open via the header capsule,
 9. saves screenshots into output/playwright.
"""
import json
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:3080"
OUTPUT_DIR = Path(__file__).resolve().parents[1] / "output" / "playwright"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

results = []
console_errors = []
page_errors = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  — {detail}" if detail else ""))


def no_h_overflow(page, selector):
    """True when the element's content does not overflow horizontally."""
    value = page.evaluate(
        """(selector) => {
          const el = document.querySelector(selector);
          if (!el) return null;
          return { scroll: el.scrollWidth, client: el.clientWidth };
        }""",
        selector,
    )
    if value is None:
        return (False, "element missing")
    return (value["scroll"] <= value["client"] + 2, f"scroll {value['scroll']} ≤ client {value['client']}")


def drag_rail(page, target_width):
    """Drag the details rail handle so the rail width lands on target_width."""
    handle = page.locator(".pI_x6G_handle[data-side='details']")
    box = handle.bounding_box()
    rail = page.locator(".pI_x6G_detailsCol").bounding_box()
    current = rail["width"] if rail else 0
    dx = current - target_width
    start_x = box["x"] + box["width"] / 2
    y = box["y"] + box["height"] / 2
    page.mouse.move(start_x, y)
    page.mouse.down()
    page.mouse.move(start_x + dx, y, steps=8)
    page.mouse.up()
    page.wait_for_timeout(500)


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda msg: console_errors.append(f"{msg.type}: {msg.text}") if msg.type == "error" else None)
    page.on("pageerror", lambda err: page_errors.append(str(err)))

    page.goto(URL, wait_until="domcontentloaded")
    page.wait_for_selector("[role='tree']", timeout=90000)
    page.wait_for_timeout(4000)

    treeitems = page.query_selector_all("[role='tree'] [role='treeitem']")
    check("session tree is visible", len(treeitems) > 0, f"{len(treeitems)} treeitems")

    opened = False
    for item in treeitems[1:4] if len(treeitems) > 1 else treeitems:
        item.click()
        try:
            page.wait_for_selector("[data-slot='conversation'] [role='tablist']", timeout=8000)
            opened = True
            break
        except Exception:
            continue
    check("a session opened (view ring present)", opened)

    dsh_tabs = [tab.inner_text() for tab in page.query_selector_all("[data-slot='conversation'] [role='tablist'] [role='tab']")]
    check("解读 tab is gone from the view ring", "解读" not in dsh_tabs, f"tabs={dsh_tabs}")
    check("对话/轨迹 tabs remain", any("对话" in t or "轨迹" in t for t in dsh_tabs), f"tabs={dsh_tabs}")

    page.wait_for_selector("[data-slot='inspector'] .tiRoot", state="visible", timeout=30000)
    heading = page.locator("[data-slot='inspector'] .tiTitle").first.inner_text()
    check("inspector rail renders the trace view", "开发轨迹复盘" in heading, heading)

    rail = page.locator(".pI_x6G_detailsCol")
    box_open = rail.bounding_box()
    check("rail is open by default", box_open is not None and box_open["width"] > 200, f"width={box_open['width'] if box_open else None}")

    # Free drag: no clamping. Enlarge to ~700, shrink to ~200, back to ~420.
    drag_rail(page, 700)
    w_wide = rail.bounding_box()["width"]
    check("rail drags wide (no 560 clamp)", abs(w_wide - 700) < 30, f"width={w_wide}")
    drag_rail(page, 200)
    w_narrow = rail.bounding_box()["width"]
    check("rail drags narrow (no 320 floor)", abs(w_narrow - 200) < 30, f"width={w_narrow}")
    drag_rail(page, 420)
    w_restore = rail.bounding_box()["width"]
    check("rail drags back to 420", abs(w_restore - 420) < 30, f"width={w_restore}")

    # The timeline keeps one ordinary advanced-filter disclosure.
    filter_disclosure = page.locator("[data-slot='inspector'] .tiToolDisclosure", has_text="高级筛选").first
    check("批注、书签和人工审计入口已移除",
          page.locator("[data-slot='inspector'] .tiAuditPanel").count() == 0
          and page.locator("[data-slot='inspector'] button", has_text="批注与书签").count() == 0,
          "")
    filter_disclosure.click()
    page.wait_for_timeout(400)
    ok, detail = no_h_overflow(page, "[data-slot='inspector'] .tiFilterPanel")
    check("高级筛选 panel has no horizontal overflow", ok, detail)
    panel_box = page.locator("[data-slot='inspector'] .tiFilterPanel").bounding_box()
    panels_box_1 = page.locator("[data-slot='inspector'] .tiToolPanels").bounding_box()
    check("高级筛选展开状态正确", filter_disclosure.get_attribute("aria-expanded") == "true", "")
    check("tool container follows the active filter panel height",
          bool(panels_box_1) and bool(panel_box) and abs(panels_box_1["height"] - panel_box["height"]) < 2,
          f"container height {panels_box_1['height']:.0f} vs filter height {panel_box['height']:.0f}")
    filter_disclosure.click()
    page.wait_for_timeout(300)
    check("再次点击高级筛选可正常收起", filter_disclosure.get_attribute("aria-expanded") == "false", "")

    ok, detail = no_h_overflow(page, "[data-slot='inspector'] .tiTimelineTools")
    check("timeline toolbar has no horizontal overflow", ok, detail)

    # Console band must fit.
    ok, detail = no_h_overflow(page, "[data-slot='inspector'] .tiConsole")
    check("console band has no horizontal overflow", ok, detail)

    # 设置 tab hosts the four ops disclosures.
    page.locator("[data-slot='inspector'] .tiModeTab", has_text="设置").first.click()
    page.wait_for_timeout(500)
    titles = [el.inner_text() for el in page.query_selector_all("[data-slot='inspector'] .tiOpsPanel .tiDisclosureTitle")]
    check("设置 tab shows the four ops disclosures", all(t in titles for t in ["资源与用量", "模型与自动策略", "受控分析", "研究导出"]), titles)
    ok, detail = no_h_overflow(page, "[data-slot='inspector'] .tiOpsPanel")
    check("设置 panel has no horizontal overflow", ok, detail)

    # Settings cards: single column, same width/left edge, INDEPENDENT toggles.
    cards = page.locator("[data-slot='inspector'] .tiOpsPanel .tiDisclosure")
    boxes = [cards.nth(i).bounding_box() for i in range(cards.count())]
    same_edge = bool(boxes[0]) and all(
        b and abs(b["x"] - boxes[0]["x"]) < 2 and abs(b["width"] - boxes[0]["width"]) < 2 for b in boxes
    )
    check("settings cards stack single-column full-width", same_edge, [f"{b['x']:.0f}+{b['width']:.0f}" for b in boxes if b])
    all_closed = all(cards.nth(i).get_attribute("open") is None for i in range(cards.count()))
    check("settings cards default fully collapsed", all_closed, "")
    cards.nth(0).locator("summary").first.click()
    page.wait_for_timeout(300)
    check("settings card opens on its own", cards.nth(0).get_attribute("open") is not None, "")
    cards.nth(1).locator("summary").first.click()
    page.wait_for_timeout(300)
    check("opening 模型与自动策略 keeps 资源与用量 open (independent toggles)",
          cards.nth(0).get_attribute("open") is not None and cards.nth(1).get_attribute("open") is not None, "")
    cards.nth(1).locator("summary").first.click()
    page.wait_for_timeout(300)
    check("clicking 模型与自动策略 again closes only it",
          cards.nth(0).get_attribute("open") is not None and cards.nth(1).get_attribute("open") is None, "")
    cards.nth(0).locator("summary").first.click()
    page.wait_for_timeout(300)
    check("all settings cards can be closed", all(cards.nth(i).get_attribute("open") is None for i in range(cards.count())), "")

    page.locator("[data-slot='inspector'] .tiOpsPanel summary", has_text="模型与自动策略").first.click()
    page.wait_for_timeout(400)
    ok, detail = no_h_overflow(page, "[data-slot='inspector'] .tiOpsPanel")
    check("展开的 模型与自动策略 has no horizontal overflow", ok, detail)
    page.locator("[data-slot='inspector'] .tiOpsPanel summary", has_text="模型与自动策略").first.click()
    page.wait_for_timeout(300)

    for title in ["受控分析", "研究导出", "资源与用量"]:
        page.locator("[data-slot='inspector'] .tiOpsPanel summary", has_text=title).first.click()
        page.wait_for_timeout(400)
        ok, detail = no_h_overflow(page, "[data-slot='inspector'] .tiOpsPanel")
        check(f"展开的 {title} has no horizontal overflow", ok, detail)
        page.locator("[data-slot='inspector'] .tiOpsPanel summary", has_text=title).first.click()
        page.wait_for_timeout(300)
    page.screenshot(path=str(OUTPUT_DIR / "dsh-trace-insight-v055-settings.png"), full_page=True)

    # Back to review and toggle the rail via the header capsule.
    page.locator("[data-slot='inspector'] .tiModeTab", has_text="复盘").first.click()
    page.wait_for_timeout(400)
    toggle = page.locator("button[aria-label='收起解读检查器'], button[aria-label='展开解读检查器']").first
    check("header toggle capsule exists", toggle.is_visible())
    toggle.click()
    page.wait_for_timeout(600)
    box_closed = rail.bounding_box()
    check("rail collapses via toggle", box_closed is None or box_closed["width"] < 10, f"width={box_closed['width'] if box_closed else None}")
    page.locator("button[aria-label='展开解读检查器']").first.click()
    page.wait_for_timeout(600)
    box_reopen = rail.bounding_box()
    check("rail reopens via toggle", box_reopen is not None and box_reopen["width"] > 200, f"width={box_reopen['width'] if box_reopen else None}")

    page.screenshot(path=str(OUTPUT_DIR / "dsh-trace-insight-v055-inspector.png"), full_page=True)

    relevant_errors = [e for e in console_errors if "favicon" not in e]
    check("no page errors", len(page_errors) == 0, "; ".join(page_errors[:3]))
    check("no console errors", len(relevant_errors) == 0, "; ".join(relevant_errors[:3]))

    browser.close()

failed = [r for r in results if not r[1]]
print(json.dumps(results, ensure_ascii=False, indent=2))
sys.exit(1 if failed else 0)
