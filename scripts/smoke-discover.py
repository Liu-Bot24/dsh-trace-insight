import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.on("console", lambda msg: print(f"console.{msg.type}: {msg.text[:200]}") if msg.type == "error" else None)
    page.on("pageerror", lambda err: print(f"pageerror: {err}"))
    page.goto("http://127.0.0.1:3192/", wait_until="domcontentloaded")
    page.wait_for_timeout(8000)
    buttons = [b.inner_text().strip() for b in page.query_selector_all("button") if b.is_visible() and b.inner_text().strip()]
    print("BUTTONS:", buttons[:30])
    inputs = page.query_selector_all("textarea, input")
    print("TEXTAREAS:", [(t.get_attribute("placeholder") or t.get_attribute("aria-label") or "") for t in inputs if t.is_visible()][:10])
    body = page.inner_text("body")
    print("BODY-HEAD:", body[:800].replace("\n", " | "))
    output_path = Path(__file__).resolve().parents[1] / "output" / "playwright" / "smoke-hero.png"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(output_path))
    browser.close()
