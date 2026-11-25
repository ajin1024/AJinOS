# Prevent task labels from becoming unreadable against their normal, hovered or focused backgrounds.
from pathlib import Path
from playwright.sync_api import sync_playwright


def luminance(color):
    channels = [float(value.strip()) / 255 for value in color[4:-1].split(",")]
    linear = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in channels]
    return sum(value * weight for value, weight in zip(linear, [0.2126, 0.7152, 0.0722]))


root = Path(__file__).resolve().parents[1]
with sync_playwright() as p:
    browser = p.chromium.launch(channel="msedge", headless=True)
    page = browser.new_page()
    page.set_content('''<html><body class="station-view">
      <svg width="400" height="100">
        <g class="fc-token" tabindex="0" role="button" aria-label="查看任务">
          <rect x="20" y="20" width="240" height="32" rx="9"/>
          <text x="30" y="41">#506 私聊有新消息，先核实…</text>
        </g>
      </svg>
    </body></html>''')
    for stylesheet in ["workbench.css", "flow-canvas.css", "theme.css"]:
        page.add_style_tag(content=(root / "src" / stylesheet).read_text(encoding="utf-8"))
    token = page.locator(".fc-token")
    for theme in ["light", "dark"]:
        page.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
        for state in ["normal", "hover", "focus"]:
            page.mouse.move(350, 90)
            token.evaluate("element => element.blur()")
            if state == "hover":
                token.hover()
            elif state == "focus":
                token.focus()
            colors = token.evaluate('''element => ({
              text: getComputedStyle(element.querySelector('text')).fill,
              background: getComputedStyle(element.querySelector('rect')).fill
            })''')
            light, dark = sorted([luminance(colors["text"]), luminance(colors["background"])], reverse=True)
            contrast = (light + 0.05) / (dark + 0.05)
            assert contrast >= 4.5, f"{theme}/{state}: contrast {contrast:.2f}, {colors}"
    browser.close()
print("PASS: task labels remain readable in both themes, including hover and keyboard focus")
